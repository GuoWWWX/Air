use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    time::Duration,
};
use tokio::sync::watch;
use windows_sys::Win32::{
    Foundation::ERROR_NOT_FOUND,
    NetworkManagement::IpHelper::{
        CreateIpForwardEntry2, DeleteIpForwardEntry2, GetIpForwardEntry2, InitializeIpForwardEntry,
        SetIpForwardEntry2, MIB_IPFORWARD_ROW2,
    },
    Networking::WinSock::{AF_INET, AF_INET6, MIB_IPPROTO_NETMGMT, SOCKADDR_INET},
};

// The Wintun adapter has its own on-link multicast routes at interface metric zero.
// Pin only the link-local discovery groups, so unbound applications can discover
// peers without changing the DNS interface, unicast routing, or the outbound mode.
const GROUPS: [IpAddr; 6] = [
    IpAddr::V4(Ipv4Addr::new(224, 0, 0, 251)), // mDNS
    IpAddr::V6(Ipv6Addr::new(0xff02, 0, 0, 0, 0, 0, 0, 0xfb)),
    IpAddr::V4(Ipv4Addr::new(239, 255, 255, 250)), // SSDP
    IpAddr::V6(Ipv6Addr::new(0xff02, 0, 0, 0, 0, 0, 0, 0xc)),
    IpAddr::V4(Ipv4Addr::new(224, 0, 0, 252)), // LLMNR
    IpAddr::V6(Ipv6Addr::new(0xff02, 0, 0, 0, 0, 0, 1, 3)),
];
const LEASE_SECONDS: u32 = 45;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct DiscoveryRoute {
    destination: IpAddr,
    interface: u64,
}

fn desired_routes(interfaces: [Option<u64>; 2]) -> Vec<DiscoveryRoute> {
    GROUPS
        .into_iter()
        .filter_map(|destination| {
            let family = usize::from(destination.is_ipv6());
            let interface = interfaces[family].or(interfaces[1 - family])?;
            Some(DiscoveryRoute {
                destination,
                interface,
            })
        })
        .collect()
}

impl DiscoveryRoute {
    fn row(self) -> MIB_IPFORWARD_ROW2 {
        let mut row = MIB_IPFORWARD_ROW2::default();
        unsafe { InitializeIpForwardEntry(&mut row) };
        row.InterfaceLuid.Value = self.interface;
        row.Metric = 0;
        row.SitePrefixLength = 0;
        row.Protocol = MIB_IPPROTO_NETMGMT;
        row.Publish = false;
        row.Loopback = false;
        row.AutoconfigureAddress = false;
        // Expire even if the privileged service is terminated without running Drop.
        row.Immortal = false;
        row.ValidLifetime = LEASE_SECONDS;
        row.PreferredLifetime = LEASE_SECONDS;
        let prefix = &mut row.DestinationPrefix;
        match self.destination {
            IpAddr::V4(ip) => {
                let mut addr = windows_sys::Win32::Networking::WinSock::SOCKADDR_IN::default();
                addr.sin_family = AF_INET;
                addr.sin_addr.S_un.S_addr = u32::from_ne_bytes(ip.octets());
                prefix.Prefix = SOCKADDR_INET { Ipv4: addr };
                prefix.PrefixLength = 32;
                row.NextHop.si_family = AF_INET;
            }
            IpAddr::V6(ip) => {
                let mut addr = windows_sys::Win32::Networking::WinSock::SOCKADDR_IN6::default();
                addr.sin6_family = AF_INET6;
                addr.sin6_addr.u.Byte = ip.octets();
                prefix.Prefix = SOCKADDR_INET { Ipv6: addr };
                prefix.PrefixLength = 128;
                row.NextHop.si_family = AF_INET6;
            }
        }
        row
    }
}

#[derive(Default)]
struct OwnedRoutes(Vec<DiscoveryRoute>);

#[derive(Clone, Copy, Debug, PartialEq)]
enum RouteChange {
    Create,
    Renew,
    Remove,
}

// Return whether Air still owns the row after this operation. Never adopt a
// pre-existing route or renew/delete one that an administrator has replaced.
fn update_route(route: DiscoveryRoute, change: RouteChange) -> bool {
    let row = route.row();
    if change == RouteChange::Create {
        return unsafe { CreateIpForwardEntry2(&row) == 0 };
    }
    let mut current = row;
    match unsafe { GetIpForwardEntry2(&mut current) } {
        ERROR_NOT_FOUND => return false,
        0 if current.Protocol != row.Protocol
            || current.Metric != row.Metric
            || current.Immortal
            || current.Publish
            || current.ValidLifetime > LEASE_SECONDS =>
        {
            return false
        }
        0 => {}
        _ => return true,
    }
    if change == RouteChange::Renew {
        return unsafe { SetIpForwardEntry2(&row) != ERROR_NOT_FOUND };
    }
    let status = unsafe { DeleteIpForwardEntry2(&row) };
    status != 0 && status != ERROR_NOT_FOUND
}

impl OwnedRoutes {
    fn reconcile(&mut self, desired: &[DiscoveryRoute]) {
        self.reconcile_with(desired, update_route);
    }

    fn reconcile_with(
        &mut self,
        desired: &[DiscoveryRoute],
        mut update: impl FnMut(DiscoveryRoute, RouteChange) -> bool,
    ) {
        self.0.retain(|route| {
            let change = if desired.contains(route) {
                RouteChange::Renew
            } else {
                RouteChange::Remove
            };
            update(*route, change)
        });
        for &route in desired {
            if !self.0.contains(&route) && update(route, RouteChange::Create) {
                self.0.push(route);
            }
        }
    }
}

impl Drop for OwnedRoutes {
    fn drop(&mut self) {
        self.reconcile(&[]);
    }
}

pub(crate) fn monitor(enabled: bool) -> watch::Sender<bool> {
    let (state, mut updates) = watch::channel(enabled);
    tokio::spawn(async move {
        let mut owned = OwnedRoutes::default();
        loop {
            if *updates.borrow_and_update() {
                let present = super::windows::adapter_active("Air-TUN");
                if present {
                    let interfaces = super::windows::physical_default_interfaces()
                        .map(|entry| entry.map(|(luid, _)| luid));
                    owned.reconcile(&desired_routes(interfaces));
                } else {
                    owned.reconcile(&[]);
                }
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(if present { 15 } else { 1 })) => continue,
                    changed = updates.changed() => if changed.is_err() { break; },
                }
            } else {
                owned.reconcile(&[]);
                if updates.changed().await.is_err() {
                    break;
                }
            }
        }
    });
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_only_targets_exact_multicast_groups_on_the_physical_uplink() {
        assert!(desired_routes([None, None]).is_empty());
        let dual = desired_routes([Some(12), Some(17)]);
        assert_eq!(dual.len(), 6);
        for route in dual {
            let v6 = route.destination.is_ipv6();
            let row = route.row();
            assert!(route.destination.is_multicast());
            assert_eq!(route.interface, if v6 { 17 } else { 12 });
            assert_eq!(
                row.DestinationPrefix.PrefixLength,
                if v6 { 128 } else { 32 }
            );
            assert_eq!(row.SitePrefixLength, 0);
            assert!(!row.Publish && !row.Loopback && !row.AutoconfigureAddress);
            assert_eq!(
                unsafe { row.NextHop.si_family },
                if v6 { AF_INET6 } else { AF_INET }
            );
            assert!(!row.Immortal && row.ValidLifetime > 15 && row.ValidLifetime < 60);
        }
        // Link-local discovery still works on a LAN without an IPv6 default gateway.
        assert!(desired_routes([Some(12), None])
            .iter()
            .all(|route| route.interface == 12));
    }

    #[test]
    #[ignore = "requires an elevated, isolated Windows machine with Air-TUN and a physical uplink"]
    fn windows_selects_physical_sources_for_discovery_and_cleans_up() {
        use std::net::{SocketAddr, UdpSocket};
        use windows_sys::Win32::NetworkManagement::IpHelper::{
            GetUnicastIpAddressEntry, MIB_UNICASTIPADDRESS_ROW,
        };
        assert!(super::super::windows::is_admin());
        assert!(super::super::windows::adapter_active("Air-TUN"));
        let interfaces = super::super::windows::physical_default_interfaces();
        let desired = desired_routes(interfaces.map(|entry| entry.map(|(luid, _)| luid)));
        assert!(!desired.is_empty());
        let mut owned = OwnedRoutes::default();
        owned.reconcile(&desired);
        assert_eq!(owned.0, desired, "expected a clean dual-stack test network");
        for route in &desired {
            let any = if route.destination.is_ipv4() {
                "0.0.0.0:0"
            } else {
                "[::]:0"
            };
            let socket = UdpSocket::bind(any).unwrap();
            socket
                .connect(SocketAddr::new(route.destination, 5353))
                .unwrap();
            let source = socket.local_addr().unwrap().ip();
            let mut address = MIB_UNICASTIPADDRESS_ROW::default();
            address.InterfaceLuid.Value = route.interface;
            address.Address = DiscoveryRoute {
                destination: source,
                ..*route
            }
            .row()
            .DestinationPrefix
            .Prefix;
            assert_eq!(
                unsafe { GetUnicastIpAddressEntry(&mut address) },
                0,
                "{source} on {route:?}"
            );
        }
        drop(owned);
        for route in desired {
            assert_eq!(
                unsafe { GetIpForwardEntry2(&mut route.row()) },
                ERROR_NOT_FOUND
            );
        }
    }
    #[test]
    fn switching_uplinks_and_stopping_only_remove_routes_created_by_air() {
        let first = desired_routes([Some(12), None]);
        let second = desired_routes([Some(23), None]);
        let existing = first[0];
        let mut owned = OwnedRoutes::default();
        let mut table = vec![existing];
        let mut apply = |route, change| match change {
            RouteChange::Create if table.contains(&route) => false,
            RouteChange::Create => {
                table.push(route);
                true
            }
            RouteChange::Renew => {
                assert_ne!(route, existing);
                table.contains(&route)
            }
            RouteChange::Remove => {
                assert_ne!(route, existing);
                table.retain(|item| *item != route);
                false
            }
        };
        owned.reconcile_with(&first, &mut apply);
        owned.reconcile_with(&first, &mut apply);
        assert_eq!(owned.0.len(), first.len() - 1);
        owned.reconcile_with(&second, &mut apply);
        assert_eq!(owned.0, second);
        owned.reconcile_with(&[], &mut apply);
        assert!(owned.0.is_empty());
        assert_eq!(table, [existing]);
    }
}
