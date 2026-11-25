use super::install::{wide, WINTUN_DLL};
use crate::AirResult;
use std::{
    ffi::{c_void, CStr, OsString},
    io,
    os::windows::{ffi::OsStringExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    ptr::{addr_of, null_mut, NonNull},
    slice,
};
use uuid::Uuid;
use windows_sys::{
    core::GUID,
    Win32::{
        Devices::DeviceAndDriverInstallation::{
            CM_Locate_DevNodeW, CM_LOCATE_DEVNODE_NORMAL, CR_NO_SUCH_DEVNODE, CR_SUCCESS,
        },
        Foundation::{ERROR_NOT_FOUND, ERROR_NOT_SUPPORTED},
        NetworkManagement::{
            IpHelper::{
                ConvertInterfaceLuidToGuid, ConvertInterfaceLuidToIndex, DeleteIpForwardEntry2,
                DeleteUnicastIpAddressEntry, FreeMibTable, GetIpForwardTable2, GetIpInterfaceEntry,
                GetUnicastIpAddressTable, DNS_INTERFACE_SETTINGS, DNS_INTERFACE_SETTINGS_VERSION1,
                DNS_SETTING_IPV6, DNS_SETTING_NAMESERVER, DNS_SETTING_SEARCHLIST,
                MIB_IPFORWARD_ROW2, MIB_IPINTERFACE_ROW, MIB_UNICASTIPADDRESS_ROW,
            },
            Ndis::NET_LUID_LH,
        },
        Networking::WinSock::{
            IpPrefixOriginManual, AF_INET, AF_INET6, AF_UNSPEC, MIB_IPPROTO_NETMGMT,
        },
        System::{
            LibraryLoader::{
                GetModuleHandleW, GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32,
            },
            SystemInformation::GetSystemDirectoryW,
        },
    },
};

pub(super) const NAME: &str = "Air-TUN";
// sing-tun v0.4.27 derives the instance ID from MD5("wintun" + the adapter name).
// Holding the creation handle for that ID makes Mihomo open the existing adapter.
const INSTANCE_ID: Uuid = Uuid::from_u128(0x4897b39a_28d8_e62e_709d_d8c410ba597e);

pub(super) fn name_in_use() -> AirResult<bool> {
    if let Some(value) = crate::proxy::windows::adapter_luid(NAME) {
        let mut guid = GUID::default();
        let luid = NET_LUID_LH { Value: value };
        win_result(
            unsafe { ConvertInterfaceLuidToGuid(&luid, &mut guid) },
            "读取虚拟网卡标识",
        )?;
        if Uuid::from_fields(guid.data1, guid.data2, guid.data3, &guid.data4) != INSTANCE_ID {
            return Ok(true);
        }
    }

    // IP Helper still resolves the alias after Wintun's software device is removed.
    // Query PnP presence for Air's own instance, including when the device is idle.
    let device = wide(format!(r"SWD\Wintun\{{{INSTANCE_ID}}}"));
    let mut node = 0;
    match unsafe { CM_Locate_DevNodeW(&mut node, device.as_ptr(), CM_LOCATE_DEVNODE_NORMAL) } {
        CR_SUCCESS => Ok(true),
        CR_NO_SUCH_DEVNODE => Ok(false),
        code => Err(format!("无法检查 Air-TUN 网卡 · CONFIGRET {code:#x}")),
    }
}

type CreateAdapter = unsafe extern "system" fn(*const u16, *const u16, *const GUID) -> *mut c_void;
type CloseAdapter = unsafe extern "system" fn(*mut c_void);
type GetAdapterLuid = unsafe extern "system" fn(*mut c_void, *mut NET_LUID_LH);
type SetDns = unsafe extern "system" fn(GUID, *const DNS_INTERFACE_SETTINGS) -> u32;

#[link(name = "dnsapi")]
extern "system" {
    fn DnsFlushResolverCache() -> i32;
}

pub(super) struct Adapter {
    handle: NonNull<c_void>,
    close: CloseAdapter,
    luid: NET_LUID_LH,
}

impl Adapter {
    pub(super) fn create(directory: &Path) -> AirResult<Self> {
        if name_in_use()? {
            return Err(format!("Windows 已有名为 {NAME} 的网卡"));
        }
        let path = wide(directory.join(WINTUN_DLL));
        let module =
            unsafe { LoadLibraryExW(path.as_ptr(), null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32) };
        if module.is_null() {
            return Err(format!(
                "无法加载 Wintun 驱动：{}",
                io::Error::last_os_error()
            ));
        }
        // The DLL queues cleanup callbacks. Keep it loaded until the service exits.
        let export = |name: &CStr| {
            unsafe { GetProcAddress(module, name.as_ptr().cast()) }
                .ok_or_else(|| format!("Wintun 缺少 {}", name.to_string_lossy()))
        };
        // These signatures match the corresponding exports in the pinned Wintun DLL.
        let (create, close, get_luid): (CreateAdapter, CloseAdapter, GetAdapterLuid) = unsafe {
            (
                std::mem::transmute(export(c"WintunCreateAdapter")?),
                std::mem::transmute(export(c"WintunCloseAdapter")?),
                std::mem::transmute(export(c"WintunGetAdapterLUID")?),
            )
        };
        let handle = NonNull::new(unsafe {
            create(
                wide(NAME).as_ptr(),
                wide("Air Tun").as_ptr(),
                &GUID::from_u128(INSTANCE_ID.as_u128()),
            )
        })
        .ok_or_else(|| format!("无法创建 {NAME}：{}", io::Error::last_os_error()))?;
        let mut luid = NET_LUID_LH::default();
        unsafe { get_luid(handle.as_ptr(), &mut luid) };
        let adapter = Self {
            handle,
            close,
            luid,
        };
        adapter.check_name()?;
        Ok(adapter)
    }

    pub(super) fn check_name(&self) -> AirResult<()> {
        if crate::proxy::windows::adapter_luid(NAME) == Some(unsafe { self.luid.Value }) {
            Ok(())
        } else {
            Err("Windows 找不到服务持有的 Air-TUN 网卡".into())
        }
    }

    pub(super) fn clear_network(&self) -> AirResult<()> {
        // sing-tun usually relies on adapter removal to discard these settings.
        // Remove only the entries on this adapter; Windows manages the on-link routes.
        let luid = unsafe { self.luid.Value };
        for row in managed_routes(luid)? {
            removed(unsafe { DeleteIpForwardEntry2(&row) }, "清理虚拟网卡路由")?;
        }
        for row in manual_addresses(luid)? {
            removed(
                unsafe { DeleteUnicastIpAddressEntry(&row) },
                "清理虚拟网卡地址",
            )?;
        }
        clear_dns(self.luid)?;
        unsafe { DnsFlushResolverCache() };
        Ok(())
    }
}

impl Drop for Adapter {
    fn drop(&mut self) {
        unsafe { (self.close)(self.handle.as_ptr()) };
    }
}

pub(super) fn managed_routes(luid: u64) -> AirResult<Vec<MIB_IPFORWARD_ROW2>> {
    let mut table = null_mut();
    win_result(
        unsafe { GetIpForwardTable2(AF_UNSPEC, &mut table) },
        "读取 Windows 路由",
    )?;
    let rows = unsafe {
        let rows = slice::from_raw_parts(
            addr_of!((*table).Table).cast::<MIB_IPFORWARD_ROW2>(),
            (*table).NumEntries as usize,
        );
        let result = rows
            .iter()
            .filter(|row| row.InterfaceLuid.Value == luid && row.Protocol == MIB_IPPROTO_NETMGMT)
            .copied()
            .collect();
        FreeMibTable(table.cast());
        result
    };
    Ok(rows)
}

pub(super) fn manual_addresses(luid: u64) -> AirResult<Vec<MIB_UNICASTIPADDRESS_ROW>> {
    let mut table = null_mut();
    win_result(
        unsafe { GetUnicastIpAddressTable(AF_UNSPEC, &mut table) },
        "读取 Windows 网卡地址",
    )?;
    let rows = unsafe {
        let rows = slice::from_raw_parts(
            addr_of!((*table).Table).cast::<MIB_UNICASTIPADDRESS_ROW>(),
            (*table).NumEntries as usize,
        );
        let result = rows
            .iter()
            .filter(|row| {
                row.InterfaceLuid.Value == luid && row.PrefixOrigin == IpPrefixOriginManual
            })
            .copied()
            .collect();
        FreeMibTable(table.cast());
        result
    };
    Ok(rows)
}

fn clear_dns(luid: NET_LUID_LH) -> AirResult<()> {
    let mut guid = GUID::default();
    win_result(
        unsafe { ConvertInterfaceLuidToGuid(&luid, &mut guid) },
        "读取虚拟网卡标识",
    )?;
    let ip_helper = unsafe { GetModuleHandleW(wide("iphlpapi.dll").as_ptr()) };
    let set_dns = unsafe { GetProcAddress(ip_helper, c"SetInterfaceDnsSettings".as_ptr().cast()) };
    for family in [AF_INET, AF_INET6] {
        let mut entry = MIB_IPINTERFACE_ROW {
            Family: family,
            InterfaceLuid: luid,
            ..Default::default()
        };
        let status = unsafe { GetIpInterfaceEntry(&mut entry) };
        if family == AF_INET6 && matches!(status, ERROR_NOT_FOUND | ERROR_NOT_SUPPORTED) {
            continue;
        }
        win_result(status, "读取虚拟网卡 IP 设置")?;
        if let Some(set_dns) = set_dns {
            let set_dns: SetDns = unsafe { std::mem::transmute(set_dns) };
            let flags = DNS_SETTING_NAMESERVER | DNS_SETTING_SEARCHLIST;
            let mut empty = [0u16];
            let settings = DNS_INTERFACE_SETTINGS {
                Version: DNS_INTERFACE_SETTINGS_VERSION1,
                Flags: u64::from(if family == AF_INET6 {
                    flags | DNS_SETTING_IPV6
                } else {
                    flags
                }),
                NameServer: empty.as_mut_ptr(),
                SearchList: empty.as_mut_ptr(),
                ..Default::default()
            };
            win_result(unsafe { set_dns(guid, &settings) }, "清理虚拟网卡 DNS")?;
        } else {
            clear_legacy_dns(&luid, if family == AF_INET6 { "ipv6" } else { "ipv4" })?;
        }
    }
    Ok(())
}

fn clear_legacy_dns(luid: &NET_LUID_LH, family: &str) -> AirResult<()> {
    let mut index = 0;
    win_result(
        unsafe { ConvertInterfaceLuidToIndex(luid, &mut index) },
        "读取虚拟网卡索引",
    )?;
    let mut directory = [0u16; 260];
    let length =
        unsafe { GetSystemDirectoryW(directory.as_mut_ptr(), directory.len() as u32) } as usize;
    if length == 0 || length >= directory.len() {
        return Err("找不到 Windows 系统目录".into());
    }
    let netsh = PathBuf::from(OsString::from_wide(&directory[..length])).join("netsh.exe");
    let status = Command::new(netsh)
        .args([
            "interface",
            family,
            "set",
            "dnsservers",
            &format!("name={index}"),
            "source=dhcp",
        ])
        .creation_flags(0x08000000)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| format!("无法清理虚拟网卡 DNS：{error}"))?;
    if !status.success() {
        return Err(format!("无法清理虚拟网卡 DNS：{status}"));
    }
    Ok(())
}

fn removed(status: u32, action: &str) -> AirResult<()> {
    if status == ERROR_NOT_FOUND {
        return Ok(());
    }
    win_result(status, action)
}

fn win_result(status: u32, action: &str) -> AirResult<()> {
    if status != 0 {
        return Err(format!(
            "{action}失败：{}",
            io::Error::from_raw_os_error(status as i32)
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "read-only test requiring a stale Air-TUN alias from an earlier installation"]
    fn stale_air_tun_alias_does_not_block_service_install() {
        assert!(crate::proxy::windows::adapter_luid(NAME).is_some());
        assert!(!name_in_use().unwrap());
    }
}
