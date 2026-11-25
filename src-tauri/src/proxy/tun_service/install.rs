use super::{current_service_pid, SecurityDescriptor, SERVICE_NAME, STARTUP_TIMEOUT};
use crate::{subscriptions::digest, AirResult};
use std::{
    ffi::{OsStr, OsString},
    fs,
    io::Write,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    ptr::null_mut,
    thread::sleep,
    time::{Duration, Instant},
};
use windows_service::{
    service::{ServiceAccess, ServiceErrorControl, ServiceInfo, ServiceStartType, ServiceState, ServiceType},
    service_manager::{ServiceManager, ServiceManagerAccess},
};
use windows_sys::Win32::{
    Foundation::{ERROR_CANCELLED, ERROR_SERVICE_DOES_NOT_EXIST, GlobalFree, WAIT_OBJECT_0},
    Security::{
        Authorization::ConvertSidToStringSidW, GetTokenInformation, SetFileSecurityW, TokenUser,
        TOKEN_QUERY, TOKEN_USER, DACL_SECURITY_INFORMATION, GROUP_SECURITY_INFORMATION,
        OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    },
    Storage::FileSystem::CreateDirectoryW,
    System::{Com::CoTaskMemFree, Threading::{GetCurrentProcess, GetExitCodeProcess, OpenProcessToken, WaitForSingleObject, INFINITE}},
    UI::{Shell::{SHGetKnownFolderPath, ShellExecuteExW, FOLDERID_ProgramFiles, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW}, WindowsAndMessaging::SW_HIDE},
};

pub(super) const RUN: &str = "--air-tun-service-v12";
pub(super) const V11_RUN: &str = "--air-tun-service-v11";
pub(super) const V10_RUN: &str = "--air-tun-service-v10";
pub(super) const V9_RUN: &str = "--air-tun-service-v9";
pub(super) const V8_RUN: &str = "--air-tun-service-v8";
pub(super) const V7_RUN: &str = "--air-tun-service-v7";
pub(super) const V6_RUN: &str = "--air-tun-service-v6";
pub(super) const COMPATIBLE_RUN: &str = "--air-tun-service-v5";
pub(super) const OLDER_COMPATIBLE_RUN: &str = "--air-tun-service-v4";
pub(super) const PREVIOUS_RUN: &str = "--air-tun-service-v3";
pub(super) const LEGACY_V2_RUN: &str = "--air-tun-service-v2";
pub(super) const LEGACY_RUN: &str = "--air-tun-service";
pub(super) const INSTALL: &str = "--air-install-tun-service";
pub(super) const REMOVE: &str = "--air-remove-tun-service";
pub(super) const REQUEST_REMOVE: &str = "--air-request-remove-tun-service";
const SERVICE_EXE: &str = "air-tun-service.exe";
pub(super) const CORE_EXE: &str = "mihomo.exe";
pub(super) const WINTUN_DLL: &str = "wintun.dll";
const WINTUN_LICENSE: &str = "Wintun-LICENSE.txt";
const LOADER: &str = "WebView2Loader.dll";
// These are the Windows release assets copied into the protected service directory.
pub(super) const CORE_SHA256: &str = "b0c4d88cc0ba42dde818dc769d2efc5711e40a558ea76dbf815ed68ef587507e";
pub(super) const AIR2_CORE_SHA256: &str = "e0e3823e739c622297d6862bbe72c14eb9e355c32cfda511357be857a8488261";
pub(super) const PREVIOUS_CORE_SHA256: &str = "25c44987589bd4cea3aec040cb4071225b3cd90219171f98c98b7ff47e0631fc";
pub(super) const LEGACY_CORE_SHA256: &str = "3c107d54ef1b895e4980b53f517d52f3c1137101fa2637347c9ce343fc50d7b2";
const LOADER_SHA256: &str = "8427b1fc58ec707813e5c0a51eb5d69397bb333250a7b891be4d3b123f1e0f1c";
const WINTUN_SHA256: &str = "e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce";
const WINTUN_BYTES: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/wintun.dll"));
const WINTUN_LICENSE_BYTES: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/Wintun-LICENSE.txt"));
const SERVICE_BYTES: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/air-tun-service.exe"));

pub(super) fn wide(value: impl AsRef<OsStr>) -> Vec<u16> {
    value.as_ref().encode_wide().chain([0]).collect()
}

fn installation_directory() -> AirResult<PathBuf> {
    let mut raw = null_mut();
    if unsafe { SHGetKnownFolderPath(&FOLDERID_ProgramFiles, 0, null_mut(), &mut raw) } < 0 {
        return Err("无法定位 Windows 程序目录".into());
    }
    let path = unsafe {
        let length = (0..).take_while(|offset| *raw.add(*offset) != 0).count();
        let path = OsString::from_wide(std::slice::from_raw_parts(raw, length));
        CoTaskMemFree(raw.cast());
        PathBuf::from(path).join("Air TUN Service")
    };
    Ok(path)
}

fn bundled_asset(exe: &Path, name: &str, expected: &str) -> AirResult<Vec<u8>> {
    let bytes = fs::read(exe.with_file_name(name)).map_err(|_| format!("缺少 {name}，请使用完整的 Air Proxy 安装包"))?;
    if digest(&bytes) != expected {
        return Err(format!("{name} 校验失败，请使用匹配版本的 Air Proxy 安装包"));
    }
    Ok(bytes)
}

fn check_wintun() -> AirResult<()> {
    if WINTUN_LICENSE_BYTES.is_empty() || digest(WINTUN_BYTES) != WINTUN_SHA256 {
        return Err("Wintun 驱动文件缺失或校验失败，请使用完整的 Air Proxy 安装包".into());
    }
    Ok(())
}

pub(super) fn valid_sid(sid: &str) -> bool {
    sid.strip_prefix("S-1-").is_some_and(|parts| {
        parts.len() <= 180 && parts.split('-').count() >= 2
            && parts.split('-').all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit()))
    })
}

pub(super) fn user_sid() -> Option<String> {
    let mut raw_token = null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_token) } == 0 {
        return None;
    }
    let token = unsafe { OwnedHandle::from_raw_handle(raw_token) };
    let mut size = 0;
    unsafe { GetTokenInformation(token.as_raw_handle(), TokenUser, null_mut(), 0, &mut size) };
    if size < std::mem::size_of::<TOKEN_USER>() as u32 {
        return None;
    }
    let mut storage = vec![0_u64; (size as usize).div_ceil(std::mem::size_of::<u64>())];
    let mut raw_sid = null_mut();
    let ok = unsafe {
        GetTokenInformation(token.as_raw_handle(), TokenUser, storage.as_mut_ptr().cast(), size, &mut size) != 0
            && ConvertSidToStringSidW((*storage.as_ptr().cast::<TOKEN_USER>()).User.Sid, &mut raw_sid) != 0
    };
    if !ok {
        return None;
    }
    unsafe {
        let length = (0..).take_while(|offset| *raw_sid.add(*offset) != 0).count();
        let sid = String::from_utf16(std::slice::from_raw_parts(raw_sid, length)).ok();
        GlobalFree(raw_sid.cast());
        sid.filter(|sid| valid_sid(sid))
    }
}

pub fn request_install() -> AirResult<()> {
    if current_service_pid().is_some() {
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|_| "无法定位 Air Proxy 程序")?;
    check_wintun()?;
    bundled_asset(&exe, CORE_EXE, CORE_SHA256)?;
    if SERVICE_BYTES.is_empty() {
        bundled_asset(&exe, LOADER, LOADER_SHA256)?;
    }
    let owner = user_sid().ok_or("无法识别当前 Windows 用户")?;
    elevate(&exe, &format!("{INSTALL} {owner}"))?;
    if current_service_pid().is_none() {
        return Err("虚拟网卡服务安装失败，请重试".into());
    }
    Ok(())
}

pub(super) fn request_remove() -> AirResult<()> {
    if super::owned_service().is_none() {
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|_| "无法定位 Air Proxy 程序")?;
    elevate(&exe, REMOVE)
}

fn elevate(exe: &Path, arguments: &str) -> AirResult<()> {
    let file = wide(exe);
    let verb = wide("runas");
    let arguments = wide(arguments);
    let mut command: SHELLEXECUTEINFOW = unsafe { std::mem::zeroed() };
    command.cbSize = std::mem::size_of_val(&command) as u32;
    command.fMask = SEE_MASK_NOCLOSEPROCESS;
    command.lpVerb = verb.as_ptr();
    command.lpFile = file.as_ptr();
    command.lpParameters = arguments.as_ptr();
    command.nShow = SW_HIDE;
    if unsafe { ShellExecuteExW(&mut command) } == 0 {
        if std::io::Error::last_os_error().raw_os_error() == Some(ERROR_CANCELLED as i32) {
            return Err("已取消 Windows 授权".into());
        }
        return Err("Windows 无法启动虚拟网卡服务配置程序".into());
    }
    if command.hProcess.is_null() {
        return Err("无法读取虚拟网卡服务配置结果".into());
    }
    let process = unsafe { OwnedHandle::from_raw_handle(command.hProcess) };
    let mut code = 1;
    let completed = unsafe {
        WaitForSingleObject(process.as_raw_handle(), INFINITE) == WAIT_OBJECT_0
            && GetExitCodeProcess(process.as_raw_handle(), &mut code) != 0
            && code == 0
    };
    if !completed {
        return Err("虚拟网卡服务配置失败，请重试".into());
    }
    Ok(())
}

pub(super) fn install(owner: &str) -> AirResult<()> {
    if !valid_sid(owner) {
        return Err("虚拟网卡服务缺少有效的 Windows 用户".into());
    }
    let source = std::env::current_exe().map_err(|_| "无法定位 Air Proxy 程序")?;
    check_wintun()?;
    let core = bundled_asset(&source, CORE_EXE, CORE_SHA256)?;
    let standalone = !SERVICE_BYTES.is_empty();
    let loader = (!standalone)
        .then(|| bundled_asset(&source, LOADER, LOADER_SHA256))
        .transpose()?;
    let executable = if standalone {
        SERVICE_BYTES.to_vec()
    } else {
        fs::read(&source).map_err(|_| "无法读取 Air Proxy 服务程序")?
    };
    let directory = installation_directory()?;
    let path = wide(&directory);
    let mut security = SecurityDescriptor::new("O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")?;
    if unsafe { CreateDirectoryW(path.as_ptr(), &mut security.attributes()) } == 0 {
        let metadata = fs::symlink_metadata(&directory).map_err(service_error)?;
        use std::os::windows::fs::MetadataExt;
        if !metadata.is_dir() || metadata.file_attributes() & 0x400 != 0 {
            return Err("虚拟网卡服务目录无效".into());
        }
        assign_security(&path, &security)?;
    }

    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )
    .map_err(service_error)?;
    let access = ServiceAccess::START | ServiceAccess::STOP | ServiceAccess::QUERY_STATUS | ServiceAccess::CHANGE_CONFIG;
    let existing = match manager.open_service(SERVICE_NAME, access) {
        Ok(service) => {
            stop(&service)?;
            Some(service)
        }
        Err(error) if not_installed(&error) => None,
        Err(error) => return Err(service_error(error)),
    };
    write_asset(&directory, CORE_EXE, &core)?;
    if let Some(loader) = loader {
        write_asset(&directory, LOADER, &loader)?;
    } else {
        let _ = fs::remove_file(directory.join(LOADER));
    }
    if !crate::mihomo::geodata::GEOSITE_BYTES.is_empty() {
        write_asset(
            &directory,
            crate::mihomo::geodata::GEOSITE_NAME,
            crate::mihomo::geodata::GEOSITE_BYTES,
        )?;
    }
    if !crate::mihomo::geodata::GEOIP_BYTES.is_empty() {
        write_asset(
            &directory,
            crate::mihomo::geodata::GEOIP_NAME,
            crate::mihomo::geodata::GEOIP_BYTES,
        )?;
    }
    write_asset(&directory, WINTUN_DLL, WINTUN_BYTES)?;
    write_asset(&directory, WINTUN_LICENSE, WINTUN_LICENSE_BYTES)?;
    write_asset(&directory, SERVICE_EXE, &executable)?;
    let info = ServiceInfo {
        name: SERVICE_NAME.into(),
        display_name: "Air Proxy 虚拟网卡服务".into(),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: directory.join(SERVICE_EXE),
        launch_arguments: vec![RUN.into(), owner.into(), CORE_SHA256.into()],
        dependencies: vec![],
        account_name: None,
        account_password: None,
    };
    let service = if let Some(service) = existing {
        service.change_config(&info).map_err(service_error)?;
        service
    } else {
        manager.create_service(&info, access).map_err(service_error)?
    };
    service.start::<&str>(&[]).map_err(service_error)?;
    wait_for(&service, ServiceState::Running)
}

pub(super) fn remove() -> AirResult<()> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .map_err(service_error)?;
    let service = match manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE) {
        Ok(service) => service,
        Err(error) if not_installed(&error) => return Ok(()),
        Err(error) => return Err(service_error(error)),
    };
    stop(&service)?;
    service.delete().map_err(service_error)?;
    drop(service);
    let directory = installation_directory()?;
    for name in [
        SERVICE_EXE,
        CORE_EXE,
        LOADER,
        WINTUN_DLL,
        WINTUN_LICENSE,
        crate::mihomo::geodata::GEOSITE_NAME,
        crate::mihomo::geodata::GEOIP_NAME,
    ] {
        let _ = fs::remove_file(directory.join(name));
    }
    let _ = fs::remove_dir(directory);
    Ok(())
}

fn not_installed(error: &windows_service::Error) -> bool {
    matches!(error, windows_service::Error::Winapi(error)
        if error.raw_os_error() == Some(ERROR_SERVICE_DOES_NOT_EXIST as i32))
}

fn stop(service: &windows_service::service::Service) -> AirResult<()> {
    let state = service.query_status().map_err(service_error)?.current_state;
    if state != ServiceState::Stopped && state != ServiceState::StopPending {
        service.stop().map_err(service_error)?;
    }
    wait_for(service, ServiceState::Stopped)
}

fn wait_for(service: &windows_service::service::Service, expected: ServiceState) -> AirResult<()> {
    let timeout = if expected == ServiceState::Running { STARTUP_TIMEOUT } else { Duration::from_secs(12) };
    let deadline = Instant::now() + timeout;
    loop {
        let state = service.query_status().map_err(service_error)?.current_state;
        if state == expected {
            return Ok(());
        }
        if state == ServiceState::Stopped || Instant::now() >= deadline {
            return Err("虚拟网卡服务未进入预期状态".into());
        }
        sleep(Duration::from_millis(100));
    }
}

fn write_asset(directory: &Path, name: &str, bytes: &[u8]) -> AirResult<()> {
    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(service_error)?;
    file.write_all(bytes).map_err(service_error)?;
    file.as_file().sync_all().map_err(service_error)?;
    let security = SecurityDescriptor::new("O:BAG:BAD:P(A;;FA;;;SY)(A;;FA;;;BA)")?;
    assign_security(&wide(file.path()), &security)?;
    file.persist(directory.join(name)).map_err(service_error)?;
    Ok(())
}

fn assign_security(path: &[u16], security: &SecurityDescriptor) -> AirResult<()> {
    let flags = OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION
        | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;
    if unsafe { SetFileSecurityW(path.as_ptr(), flags, security.0) } == 0 {
        return Err(service_error(std::io::Error::last_os_error()));
    }
    Ok(())
}

fn service_error(error: impl std::fmt::Display) -> String {
    format!("无法配置虚拟网卡服务 · {error}")
}
