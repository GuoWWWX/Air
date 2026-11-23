use crate::AirResult;
use serde::{Deserialize, Serialize};
use std::{
    ffi::c_void,
    fs,
    io::{self, Write},
    mem::size_of,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle},
    path::Path,
    ptr::{null, null_mut},
};
use windows_sys::Win32::Foundation::GlobalFree;
use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};

const JOURNAL: &str = "system-proxy-restore.json";
const PER_CONNECTION: u32 = 75;
const FLAGS: u32 = 1;
const PROXY_SERVER: u32 = 2;
const PROXY_BYPASS: u32 = 3;
const PROXY_TYPE_DIRECT: u32 = 1;
const PROXY_TYPE_PROXY: u32 = 2;

pub(super) fn memory_bytes(process: RawHandle) -> Option<u64> {
    let size = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    let mut counters = PROCESS_MEMORY_COUNTERS {
        cb: size,
        ..Default::default()
    };
    // The child retains the process handle while the runtime lock is held.
    let read = unsafe { K32GetProcessMemoryInfo(process, &mut counters, size) };
    (read != 0).then_some(counters.WorkingSetSize as u64)
}

#[link(name = "wininet")]
extern "system" {
    fn InternetQueryOptionW(
        handle: *const c_void,
        option: u32,
        data: *mut c_void,
        size: *mut u32,
    ) -> i32;
    fn InternetSetOptionW(
        handle: *const c_void,
        option: u32,
        data: *const c_void,
        size: u32,
    ) -> i32;
}

#[link(name = "shell32")]
extern "system" {
    fn IsUserAnAdmin() -> i32;
}

#[link(name = "iphlpapi")]
extern "system" {
    fn ConvertInterfaceAliasToLuid(alias: *const u16, luid: *mut u64) -> u32;
}

#[link(name = "dnsapi")]
extern "system" {
    fn DnsFlushResolverCache() -> i32;
}

pub(super) fn flush_dns_cache() {
    unsafe {
        DnsFlushResolverCache();
    }
}

#[link(name = "kernel32")]
extern "system" {
    fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> RawHandle;
    fn SetInformationJobObject(job: RawHandle, class: i32, info: *const c_void, size: u32) -> i32;
    fn AssignProcessToJobObject(job: RawHandle, process: RawHandle) -> i32;
}

#[repr(C)]
#[derive(Default)]
struct BasicLimits {
    process_time: i64,
    job_time: i64,
    flags: u32,
    min_working_set: usize,
    max_working_set: usize,
    process_limit: u32,
    affinity: usize,
    priority: u32,
    scheduling_class: u32,
}

#[repr(C)]
#[derive(Default)]
struct ExtendedLimits {
    basic: BasicLimits,
    io_counters: [u64; 6],
    process_memory: usize,
    job_memory: usize,
    peak_process_memory: usize,
    peak_job_memory: usize,
}

pub(crate) fn own_process(process: RawHandle) -> AirResult<OwnedHandle> {
    let handle = unsafe { CreateJobObjectW(null(), null()) };
    if handle.is_null() {
        return Err("无法创建 Mihomo 进程管理对象".into());
    }
    // The job owns Mihomo even when Air exits unexpectedly.
    let job = unsafe { OwnedHandle::from_raw_handle(handle) };
    let limits = ExtendedLimits {
        basic: BasicLimits {
            flags: 0x2000,
            ..Default::default()
        },
        ..Default::default()
    };
    if unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            9,
            (&limits as *const ExtendedLimits).cast(),
            size_of::<ExtendedLimits>() as u32,
        ) == 0
            || AssignProcessToJobObject(job.as_raw_handle(), process) == 0
    } {
        return Err("无法把 Mihomo 加入 Air 的进程管理对象".into());
    }
    Ok(job)
}

pub(crate) fn is_admin() -> bool {
    unsafe { IsUserAnAdmin() != 0 }
}

pub(super) fn adapter_luid(name: &str) -> Option<u64> {
    let alias = name.encode_utf16().chain([0]).collect::<Vec<_>>();
    let mut luid = 0;
    (unsafe { ConvertInterfaceAliasToLuid(alias.as_ptr(), &mut luid) } == 0).then_some(luid)
}

pub(super) fn adapter_active(name: &str) -> bool {
    use windows_sys::Win32::NetworkManagement::{
        IpHelper::{GetIfEntry2, MIB_IF_ROW2},
        Ndis::MediaConnectStateConnected,
    };
    let Some(luid) = adapter_luid(name) else {
        return false;
    };
    let mut row = MIB_IF_ROW2::default();
    row.InterfaceLuid.Value = luid;
    (unsafe { GetIfEntry2(&mut row) } == 0) && row.MediaConnectState == MediaConnectStateConnected
}

pub(crate) fn probe_interface() -> Option<String> {
    physical_default_interfaces().into_iter().flatten().next().map(|(_, name)| name)
}

// Best hardware uplink for each address family, IPv4 first for node probes.
pub(super) fn physical_default_interfaces() -> [Option<(u64, String)>; 2] {
    use windows_sys::Win32::{
        NetworkManagement::{
            IpHelper::{FreeMibTable, GetIfEntry2, GetIpForwardTable2, GetIpInterfaceEntry,
                MIB_IF_ROW2, MIB_IPFORWARD_ROW2, MIB_IPINTERFACE_ROW},
            Ndis::IfOperStatusUp,
        },
        Networking::WinSock::{AF_INET, AF_UNSPEC},
    };
    let mut table = null_mut();
    if unsafe { GetIpForwardTable2(AF_UNSPEC, &mut table) } != 0 {
        return [None, None];
    }
    // Only read the OS-owned rows until FreeMibTable. Ignore virtual default routes
    // so the diagnostic kernel cannot count the active TUN as a second proxy hop.
    let routes = unsafe {
        std::slice::from_raw_parts(std::ptr::addr_of!((*table).Table).cast::<MIB_IPFORWARD_ROW2>(), (*table).NumEntries as usize)
    };
    let mut best = [None, None];
    for r in routes.iter().filter(|r| r.DestinationPrefix.PrefixLength == 0 && !r.Loopback && r.ValidLifetime > 0) {
        let mut adapter = MIB_IF_ROW2 { InterfaceIndex: r.InterfaceIndex, ..Default::default() };
        if unsafe { GetIfEntry2(&mut adapter) } != 0 || adapter.OperStatus != IfOperStatusUp
            || adapter.InterfaceAndOperStatusFlags._bitfield & 1 == 0 {
            continue;
        }
        let family = unsafe { r.DestinationPrefix.Prefix.si_family };
        let mut ip = MIB_IPINTERFACE_ROW { Family: family, InterfaceIndex: r.InterfaceIndex, ..Default::default() };
        if unsafe { GetIpInterfaceEntry(&mut ip) } != 0 || !ip.Connected {
            continue;
        }
        let priority = (r.Metric.saturating_add(ip.Metric), r.InterfaceIndex);
        let slot = &mut best[usize::from(family != AF_INET)];
        if slot.as_ref().is_none_or(|(current, _, _)| priority < *current) {
            let end = adapter.Alias.iter().position(|&ch| ch == 0).unwrap_or(adapter.Alias.len());
            if let Ok(name) = String::from_utf16(&adapter.Alias[..end]) {
                *slot = Some((priority, unsafe { r.InterfaceLuid.Value }, name));
            }
        }
    }
    unsafe { FreeMibTable(table.cast()) };
    best.map(|entry| entry.map(|(_, luid, name)| (luid, name)))
}

pub(crate) fn free_tun_pool() -> AirResult<String> {
    use windows_sys::Win32::{
        NetworkManagement::IpHelper::{FreeMibTable, GetIpForwardTable2, MIB_IPFORWARD_ROW2},
        Networking::WinSock::AF_INET,
    };
    let mut table = null_mut();
    let status = unsafe { GetIpForwardTable2(AF_INET, &mut table) };
    if status != 0 {
        return Err(format!("无法读取 Windows IPv4 路由表：{}", io::Error::from_raw_os_error(status as i32)));
    }
    // The API returns only IPv4 entries and owns the variable-length array until FreeMibTable.
    let routes: Vec<_> = unsafe {
        let rows = std::slice::from_raw_parts(
            std::ptr::addr_of!((*table).Table).cast::<MIB_IPFORWARD_ROW2>(), (*table).NumEntries as usize,
        );
        let routes = rows.iter().map(|row| {
            let prefix = &row.DestinationPrefix;
            (u32::from_be(prefix.Prefix.Ipv4.sin_addr.S_un.S_addr), prefix.PrefixLength)
        }).collect();
        FreeMibTable(table.cast());
        routes
    };
    choose_tun_pool(&routes)
}

pub(crate) const PREFERRED_TUN_IP: std::net::Ipv4Addr = std::net::Ipv4Addr::new(198, 19, 64, 1);

fn choose_tun_pool(routes: &[(u32, u8)]) -> AirResult<String> {
    // Reserve the entire 198.18 half for clients using Mihomo's default fake-IP range.
    let first = u32::from(PREFERRED_TUN_IP) & 0xffff_0000;
    let preferred_offset = u32::from(PREFERRED_TUN_IP) & 0x0000_ff00;
    for prefix in [20u8, 24] {
        let step = 1u32 << (32 - prefix);
        for offset in (0..65536u32).step_by(step as usize) {
            let subnet = first + ((preferred_offset + offset) % 65536);
            let occupied = routes.iter().any(|&(address, length)| {
                // Default and split-default routes steer traffic without claiming a local subnet.
                if length <= 1 { return false; }
                let mask = u32::MAX << (32 - prefix.min(length));
                subnet & mask == address & mask
            });
            if !occupied {
                return Ok(format!("{}/{prefix}", std::net::Ipv4Addr::from(subnet + 1)));
            }
        }
    }
    Err("198.19.0.0/16 内没有可用的虚拟网卡网段，请检查其他 VPN 或虚拟网卡的路由".into())
}

pub(crate) fn tun_ipv6_available() -> bool {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD};
    let path: Vec<_> = r"SYSTEM\CurrentControlSet\Services\Tcpip6\Parameters".encode_utf16().chain([0]).collect();
    let name: Vec<_> = "DisabledComponents".encode_utf16().chain([0]).collect();
    let mut flags = 0u32;
    let mut size = size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(HKEY_LOCAL_MACHINE, path.as_ptr(), name.as_ptr(), RRF_RT_REG_DWORD,
            std::ptr::null_mut(), (&mut flags as *mut u32).cast(), &mut size)
    };
    // Windows can leave IPv6 loopback available when both native and tunnel interfaces are disabled.
    status != 0 || flags & 0x11 != 0x11
}

#[repr(C)]
union OptionValue {
    flags: u32,
    server: *const u16,
    filetime: [u32; 2],
}

#[repr(C)]
struct ConnectionOption {
    option: u32,
    value: OptionValue,
}

#[repr(C)]
struct ConnectionOptions {
    size: u32,
    connection: *mut u16,
    count: u32,
    failed_option: u32,
    options: *mut ConnectionOption,
}

impl ConnectionOptions {
    fn new(options: &mut [ConnectionOption]) -> Self {
        Self {
            size: size_of::<Self>() as u32,
            connection: null_mut(),
            count: options.len() as u32,
            failed_option: 0,
            options: options.as_mut_ptr(),
        }
    }
}

#[derive(Deserialize, PartialEq, Serialize)]
struct Settings {
    flags: u32,
    server: String,
    // Older restore journals only contain flags and server.
    #[serde(default)]
    bypass: Option<String>,
}

impl Settings {
    fn read() -> AirResult<Self> {
        let mut options = [
            ConnectionOption {
                option: FLAGS,
                value: OptionValue { flags: 0 },
            },
            ConnectionOption {
                option: PROXY_SERVER,
                value: OptionValue { server: null() },
            },
            ConnectionOption {
                option: PROXY_BYPASS,
                value: OptionValue { server: null() },
            },
        ];
        let mut list = ConnectionOptions::new(&mut options);
        let mut size = list.size;
        let ok = unsafe {
            InternetQueryOptionW(
                null(),
                PER_CONNECTION,
                (&mut list as *mut ConnectionOptions).cast(),
                &mut size,
            ) != 0
        };
        let read_string = |index: usize| unsafe {
            let value = options[index].value.server;
            if value.is_null() {
                String::new()
            } else {
                let length = (0..)
                    .find(|&index| *value.add(index) == 0)
                    .unwrap_or_default();
                let result = String::from_utf16_lossy(std::slice::from_raw_parts(value, length));
                GlobalFree(value.cast_mut().cast());
                result
            }
        };
        let server = read_string(1);
        let bypass = Some(read_string(2));
        if !ok {
            return Err("无法读取 Windows 系统代理设置".into());
        }
        Ok(Self {
            flags: unsafe { options[0].value.flags },
            server,
            bypass,
        })
    }

    fn apply(&self) -> AirResult<()> {
        let server = self.server.encode_utf16().chain([0]).collect::<Vec<_>>();
        let bypass = self.bypass.as_deref().unwrap_or("").encode_utf16().chain([0]).collect::<Vec<_>>();
        let mut options = [
            ConnectionOption {
                option: FLAGS,
                value: OptionValue { flags: self.flags },
            },
            ConnectionOption {
                option: PROXY_SERVER,
                value: OptionValue {
                    server: server.as_ptr(),
                },
            },
            ConnectionOption {
                option: PROXY_BYPASS,
                value: OptionValue { server: bypass.as_ptr() },
            },
        ];
        let count = if self.bypass.is_some() { 3 } else { 2 };
        let list = ConnectionOptions::new(&mut options[..count]);
        if unsafe {
            InternetSetOptionW(
                null(),
                PER_CONNECTION,
                (&list as *const ConnectionOptions).cast(),
                list.size,
            ) == 0
        } {
            return Err("无法写入 Windows 系统代理设置".into());
        }
        unsafe {
            InternetSetOptionW(null(), 95, null(), 0);
            InternetSetOptionW(null(), 37, null(), 0);
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
struct Restore {
    previous: Settings,
    installed: Settings,
}

pub(super) fn has_restore(directory: &Path) -> bool {
    directory.join(JOURNAL).is_file()
}

const DEFAULT_SYSTEM_PROXY_BYPASS: [&str; 21] = [
    "localhost",
    "127.*",
    "192.168.*",
    "10.*",
    "172.16.*",
    "172.17.*",
    "172.18.*",
    "172.19.*",
    "172.20.*",
    "172.21.*",
    "172.22.*",
    "172.23.*",
    "172.24.*",
    "172.25.*",
    "172.26.*",
    "172.27.*",
    "172.28.*",
    "172.29.*",
    "172.30.*",
    "172.31.*",
    "<local>",
];

fn effective_bypass(custom: &[String]) -> String {
    let mut entries = Vec::with_capacity(DEFAULT_SYSTEM_PROXY_BYPASS.len() + custom.len());
    for entry in DEFAULT_SYSTEM_PROXY_BYPASS {
        if entry != "<local>" {
            entries.push(entry.to_owned());
        }
    }
    for entry in custom {
        let trimmed = entry.trim();
        if trimmed.is_empty()
            || trimmed.eq_ignore_ascii_case("<local>")
            || entries.iter().any(|existing| existing.eq_ignore_ascii_case(trimmed))
        {
            continue;
        }
        entries.push(trimmed.to_owned());
    }
    entries.push("<local>".to_owned());
    entries.join(";")
}

pub(super) fn enable(directory: &Path, port: u16, bypass: &[String]) -> AirResult<()> {
    let path = directory.join(JOURNAL);
    let change = Restore {
        installed: Settings {
            flags: PROXY_TYPE_DIRECT | PROXY_TYPE_PROXY,
            server: format!("127.0.0.1:{port}"),
            bypass: Some(effective_bypass(bypass)),
        },
        previous: Settings::read()?,
    };
    let saved = (|| -> io::Result<()> {
        let mut file = tempfile::NamedTempFile::new_in(directory)?;
        serde_json::to_writer(&mut file, &change)?;
        file.flush()?;
        file.as_file().sync_all()?;
        file.persist_noclobber(&path)?;
        Ok(())
    })();
    saved.map_err(|_| "无法保存原来的系统代理设置")?;
    if let Err(error) = change.installed.apply() {
        if change.previous.apply().is_ok() {
            let _ = fs::remove_file(&path);
        }
        return Err(error);
    }
    Ok(())
}

pub(super) fn is_active(port: u16) -> AirResult<bool> {
    let actual = Settings::read()?;
    Ok(actual.flags & PROXY_TYPE_PROXY != 0 && actual.server == format!("127.0.0.1:{port}"))
}

pub(super) fn restore(directory: &Path) -> AirResult<()> {
    let path = directory.join(JOURNAL);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("无法读取系统代理恢复记录".into()),
    };
    let mut change: Restore = serde_json::from_slice(&bytes).map_err(|_| "系统代理恢复记录无效")?;
    let current = Settings::read()?;
    if current.flags == change.installed.flags && current.server == change.installed.server {
        if change.installed.bypass.is_none() || change.installed.bypass != current.bypass {
            change.previous.bypass = None;
        }
        change.previous.apply()?;
    }
    fs::remove_file(path).map_err(|_| "无法清除系统代理恢复记录".into())
}

#[cfg(test)]
mod tests {
    use super::choose_tun_pool;
    use std::net::Ipv4Addr;

    fn route(address: [u8; 4], prefix: u8) -> (u32, u8) {
        (u32::from(Ipv4Addr::from(address)), prefix)
    }

    #[test]
    fn default_routes_and_the_other_mihomo_pool_leave_the_preferred_pool_free() {
        let routes = [route([0, 0, 0, 0], 0), route([128, 0, 0, 0], 1), route([198, 18, 0, 0], 16)];
        assert_eq!(choose_tun_pool(&routes).unwrap(), "198.19.64.1/20");
    }

    #[test]
    fn routes_within_or_around_a_candidate_exclude_the_entire_block() {
        assert_eq!(choose_tun_pool(&[route([198, 19, 79, 250], 32)]).unwrap(), "198.19.80.1/20");
        assert_eq!(choose_tun_pool(&[route([198, 19, 0, 0], 17)]).unwrap(), "198.19.128.1/20");
        assert!(choose_tun_pool(&[route([198, 19, 0, 0], 16)]).is_err());
    }

    #[test]
    fn fragmented_routes_can_still_leave_a_smaller_pool() {
        let routes: Vec<_> = (0..=255).step_by(16).map(|n| route([198, 19, n, 1], 32)).collect();
        assert_eq!(choose_tun_pool(&routes).unwrap(), "198.19.65.1/24");
    }

    #[test]
    fn default_system_proxy_bypass_covers_local_and_merges_custom_entries() {
        let default_list = super::effective_bypass(&[]);
        assert!(default_list.starts_with("localhost;127.*;192.168.*;10.*;"));
        assert!(default_list.contains(";172.16.*;"));
        assert!(default_list.contains(";172.31.*;"));
        assert!(default_list.ends_with(";<local>"));

        let custom = super::effective_bypass(&[
            "*.corp.internal".into(),
            "LOCALHOST".into(),
            " <local> ".into(),
            "  ".into(),
        ]);
        assert_eq!(custom.matches("<local>").count(), 1);
        assert!(custom.contains(";*.corp.internal;<local>"));
        assert_eq!(custom.to_ascii_lowercase().matches("localhost").count(), 1);
    }
}
