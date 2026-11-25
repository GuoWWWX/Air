mod adapter;
mod install;
mod policy;

use crate::{mihomo::{ConnectionsSnapshot, Kernel}, network::NetworkSettings, AirResult};
use super::Mode;
use install::wide;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    io,
    os::windows::io::AsRawHandle,
    path::Path,
    ptr::{null, null_mut},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::windows::named_pipe::{NamedPipeClient, ServerOptions},
    sync::{watch, Mutex},
    time::{sleep, timeout},
};
use windows_service::{
    define_windows_service,
    service::{Service, ServiceAccess, ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType},
    service_control_handler::{self, ServiceControlHandlerResult},
    service_dispatcher,
    service_manager::{ServiceManager, ServiceManagerAccess},
};
use windows_sys::Win32::{
    Foundation::{GlobalFree, INVALID_HANDLE_VALUE},
    Security::{Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1}, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES},
    Storage::FileSystem::{CreateFileW, FILE_FLAG_OVERLAPPED, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_WRITE_DATA, OPEN_EXISTING, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT, SYNCHRONIZE},
    System::Pipes::GetNamedPipeServerProcessId,
};

pub use install::request_install;

const SERVICE_NAME: &str = "AirTunService";
const PIPE: &str = r"\\.\pipe\AirTunService-v2";
const MAX_FRAME: usize = 16 * 1024 * 1024;
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

define_windows_service!(service_main, run_service);

pub fn handle_command() -> Option<AirResult<()>> {
    let argument = std::env::args_os().nth(1)?;
    match argument.to_str()? {
        install::RUN => Some(service_dispatcher::start(SERVICE_NAME, service_main).map_err(|error| error.to_string())),
        install::INSTALL => Some(install::install(&std::env::args().nth(2).unwrap_or_default())),
        install::REMOVE => Some(install::remove()),
        install::REQUEST_REMOVE => Some(install::request_remove()),
        _ => None,
    }
}

pub(super) fn service_available(require_current: bool) -> bool {
    service_status(require_current).is_some()
}

pub(super) fn persistent_service_available() -> bool {
    service_status(false).is_some_and(|(_, version)| version.has_persistent_adapter())
}

pub(super) fn standby_service_available() -> bool {
    service_status(false).is_some_and(|(_, version)| version.supports_standby())
}

pub(super) fn current_service_pid() -> Option<u32> {
    let (status, _) = service_status(true)?;
    status.process_id.filter(|_| status.current_state == ServiceState::Running)
}

fn service_status(require_current: bool) -> Option<(ServiceStatus, ServiceVersion)> {
    let (service, version) = owned_service()?;
    if matches!(version, ServiceVersion::Legacy) || (require_current && !matches!(version, ServiceVersion::Current)) {
        return None;
    }
    let status = service.query_status().ok()?;
    matches!(status.current_state, ServiceState::Running | ServiceState::StartPending)
        .then_some((status, version))
}

#[derive(Clone, Copy)]
enum ServiceVersion { Current, V11, V10, V9, PreviousCore, V8, Compatible, Legacy }

impl ServiceVersion {
    fn has_persistent_adapter(self) -> bool {
        self.supports_standby() || matches!(self, Self::V8)
    }

    fn supports_standby(self) -> bool {
        matches!(self, Self::Current | Self::V11 | Self::V10 | Self::V9 | Self::PreviousCore)
    }
}

fn owned_service() -> Option<(Service, ServiceVersion)> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT).ok()?;
    let service = manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS | ServiceAccess::QUERY_CONFIG).ok()?;
    let config = service.query_config().ok()?;
    let command = config.executable_path.to_string_lossy();
    let owner = install::user_sid()?;
    let mut arguments = command.split_whitespace().rev().map(|part| part.trim_matches('"'));
    let engine = arguments.next()?;
    if arguments.next()? != owner { return None; }
    let version = arguments.next()?;
    let version = match version {
        install::RUN if engine == install::CORE_SHA256 => ServiceVersion::Current,
        install::RUN if engine == install::PREVIOUS_CORE_SHA256 => ServiceVersion::PreviousCore,
        install::V11_RUN if engine == install::CORE_SHA256 || engine == install::PREVIOUS_CORE_SHA256 => ServiceVersion::V11,
        install::V10_RUN if engine == install::CORE_SHA256 || engine == install::PREVIOUS_CORE_SHA256 => ServiceVersion::V10,
        install::V9_RUN if engine == install::CORE_SHA256 || engine == install::PREVIOUS_CORE_SHA256 => ServiceVersion::V9,
        install::V8_RUN if engine == install::PREVIOUS_CORE_SHA256 => ServiceVersion::V8,
        install::OLDER_COMPATIBLE_RUN if engine == install::LEGACY_CORE_SHA256 => ServiceVersion::Compatible,
        install::RUN
        | install::V11_RUN
        | install::V10_RUN
        | install::V9_RUN
        | install::V8_RUN
        | install::V7_RUN
        | install::V6_RUN
        | install::COMPATIBLE_RUN
        | install::OLDER_COMPATIBLE_RUN
        | install::PREVIOUS_RUN
        | install::LEGACY_V2_RUN
        | install::LEGACY_RUN => ServiceVersion::Legacy,
        _ => return None,
    };
    Some((service, version))
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Start { config: Value, port: Option<u16>, allow_lan: bool },
    Prepare { config: Value },
    Activate { settings: Box<NetworkSettings>, port: Option<u16> },
    Park,
    Reload { config: Value },
    Mode { mode: Mode },
    Tun { settings: Box<NetworkSettings>, enabled: bool },
    TunState,
    Global { name: String },
    CloseConnections { ids: Vec<String> },
    CloseAllConnections,
    Alive,
    Stop,
    Connections,
}

#[derive(Deserialize, Serialize)]
struct Response {
    result: AirResult<Value>,
}

fn compat_config(mut config: Value, current_version: bool) -> Value {
    if current_version {
        return config;
    }
    if let Some(root) = config.as_object_mut() {
        for key in [
            "unified-delay",
            "keep-alive-idle",
            "keep-alive-interval",
            "disable-keep-alive",
            "sniffer",
        ] {
            root.remove(key);
        }
        if let Some(tun) = root.get_mut("tun").and_then(Value::as_object_mut) {
            tun.remove("endpoint-independent-nat");
        }
    }
    config
}

fn compat_network_settings(settings: &NetworkSettings) -> AirResult<Value> {
    let mut value = serde_json::to_value(settings).map_err(|_| "无法传递虚拟网卡配置")?;
    if let Some(obj) = value.as_object_mut() {
        obj.remove("bypassLan");
        obj.insert(
            "routeExcludeAddress".into(),
            json!(settings.effective_route_exclude_address(settings.tun_ipv6())),
        );
    }
    Ok(value)
}

#[derive(Clone)]
pub(super) struct Session {
    pipe: Arc<Mutex<Option<NamedPipeClient>>>,
    version: ServiceVersion,
}

impl Session {
    pub async fn start(config: serde_yaml::Value, port: Option<u16>, allow_lan: bool) -> AirResult<(Self, u16)> {
        let session = Self::connect(false).await?;
        let config = compat_config(json_config(config)?, session.version.has_persistent_adapter());
        let port = session.call(&Request::Start { config, port, allow_lan }).await?;
        Ok((session, port))
    }

    pub async fn prepare(config: &serde_yaml::Value) -> AirResult<Self> {
        let session = Self::connect(true).await?;
        session.call::<()>(&Request::Prepare { config: json_config(config)? }).await?;
        Ok(session)
    }

    pub async fn activate(&self, settings: &NetworkSettings) -> AirResult<u16> {
        use super::loopback::PREFERRED_PORT;
        let activate = |port| async move {
            if matches!(self.version, ServiceVersion::Current | ServiceVersion::V11 | ServiceVersion::V10) {
                self.call(&Request::Activate { settings: Box::new(settings.clone()), port }).await
            } else {
                let compat = compat_network_settings(settings)?;
                self.call(&json!({ "op": "activate", "settings": compat, "port": port })).await
            }
        };
        match activate(settings.mixed_port.or(Some(PREFERRED_PORT))).await {
            Err(error) if settings.mixed_port.is_none() && error == crate::mihomo::mixed_port_unavailable(PREFERRED_PORT) => activate(None).await,
            result => result,
        }
    }

    pub async fn park(&self) -> AirResult<()> {
        if !self.version.supports_standby() {
            return Err("虚拟网卡服务尚未支持内核待机".into());
        }
        self.call(&Request::Park).await
    }

    async fn connect(require_standby: bool) -> AirResult<Self> {
        let (pid, version) = timeout(STARTUP_TIMEOUT, async {
            loop {
                match service_status(false).filter(|(_, version)| !require_standby || version.supports_standby()) {
                    Some((status, _)) if status.current_state == ServiceState::StartPending => {
                        sleep(Duration::from_millis(100)).await;
                    }
                    Some((status, version)) => {
                        break status.process_id.map(|pid| (pid, version))
                            .ok_or("无法连接虚拟网卡服务，请重试");
                    }
                    None => break Err("请先安装虚拟网卡服务"),
                }
            }
        }).await.map_err(|_| "虚拟网卡服务响应超时")??;
        let pipe = timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(pipe) = open_pipe(PIPE, pid) {
                    break pipe;
                }
                sleep(Duration::from_millis(60)).await;
            }
        }).await.map_err(|_| "无法连接虚拟网卡服务，请重试")?;
        Ok(Self {
            pipe: Arc::new(Mutex::new(Some(pipe))),
            version,
        })
    }

    async fn call<T: DeserializeOwned>(&self, request: &impl Serialize) -> AirResult<T> {
        let mut slot = self.pipe.lock().await;
        let mut pipe = slot.take().ok_or("虚拟网卡服务连接已关闭")?;
        let result = timeout(Duration::from_secs(15), async {
            send(&mut pipe, request).await?;
            read::<Response>(&mut pipe).await
        }).await
            .map_err(|_| "虚拟网卡服务响应超时")?
            .map_err(|_| "虚拟网卡服务连接已关闭")?;
        *slot = Some(pipe);
        serde_json::from_value(result.result?).map_err(|_| "虚拟网卡服务响应无效".into())
    }

    pub async fn running(&self) -> bool {
        self.call(&Request::Alive).await.unwrap_or(false)
    }

    pub async fn connections(&self) -> AirResult<ConnectionsSnapshot> {
        self.call(&Request::Connections).await
    }

    pub async fn set_mode(&self, mode: Mode) -> AirResult<()> {
        self.call(&Request::Mode { mode }).await
    }

    pub async fn set_tun(&self, settings: &NetworkSettings, enabled: bool) -> AirResult<()> {
        if matches!(self.version, ServiceVersion::Current | ServiceVersion::V11 | ServiceVersion::V10) {
            self.call(&Request::Tun { settings: Box::new(settings.clone()), enabled }).await
        } else {
            let compat = compat_network_settings(settings)?;
            self.call(&json!({ "op": "tun", "settings": compat, "enabled": enabled })).await
        }
    }

    pub async fn tun_state(&self) -> AirResult<bool> {
        self.call(&Request::TunState).await
    }

    pub async fn select_global(&self, name: &str) -> AirResult<()> {
        self.call(&Request::Global { name: name.into() }).await
    }

    pub async fn close_connections(&self, ids: &[String]) -> AirResult<()> {
        if !self.version.has_persistent_adapter() || ids.is_empty() {
            return Ok(());
        }
        self.call(&Request::CloseConnections { ids: ids.to_vec() }).await
    }

    pub async fn close_all_connections(&self) -> AirResult<()> {
        if !self.version.has_persistent_adapter() {
            return Ok(());
        }
        self.call(&Request::CloseAllConnections).await
    }

    pub async fn reload(&self, config: &serde_yaml::Value) -> AirResult<()> {
        let config = compat_config(json_config(config)?, self.version.has_persistent_adapter());
        self.call(&Request::Reload { config }).await
    }

    pub async fn stop(&self) -> AirResult<()> {
        self.call::<()>(&Request::Stop).await?;
        self.pipe.lock().await.take();
        Ok(())
    }
}

fn json_config(config: impl Serialize) -> AirResult<Value> {
    serde_json::to_value(config).map_err(|_| "无法传递虚拟网卡配置".into())
}

pub(super) fn validate(config: &serde_yaml::Value) -> AirResult<()> {
    policy::runtime_config(json_config(config)?).map(|_| ())
}

fn open_pipe(path: &str, pid: u32) -> io::Result<NamedPipeClient> {
    let name = wide(path);
    let pipe = unsafe {
        CreateFileW(
            name.as_ptr(),
            FILE_READ_DATA | FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
            0,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
            null_mut(),
        )
    };
    if pipe == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let client = unsafe { NamedPipeClient::from_raw_handle(pipe) }?;
    let mut actual = 0;
    if unsafe { GetNamedPipeServerProcessId(client.as_raw_handle(), &mut actual) } == 0 || actual != pid {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "unexpected pipe owner"));
    }
    Ok(client)
}

struct SecurityDescriptor(PSECURITY_DESCRIPTOR);

impl SecurityDescriptor {
    fn new(sddl: &str) -> AirResult<Self> {
        let text = wide(sddl);
        let mut descriptor = null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(text.as_ptr(), SDDL_REVISION_1, &mut descriptor, null_mut())
        } == 0 {
            return Err("无法创建虚拟网卡服务访问权限".into());
        }
        Ok(Self(descriptor))
    }

    fn attributes(&mut self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.0,
            bInheritHandle: 0,
        }
    }
}

impl Drop for SecurityDescriptor {
    fn drop(&mut self) {
        unsafe { GlobalFree(self.0) };
    }
}

fn run_service(_arguments: Vec<OsString>) {
    let (shutdown, stop) = watch::channel(false);
    let Ok(handle) = service_control_handler::register(SERVICE_NAME, move |control| {
        match control {
            ServiceControl::Stop | ServiceControl::Shutdown => {
                shutdown.send_replace(true);
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    }) else { return };
    let status = |state, controls, exit_code| ServiceStatus {
        service_type: ServiceType::OWN_PROCESS,
        current_state: state,
        controls_accepted: controls,
        exit_code: ServiceExitCode::Win32(exit_code),
        checkpoint: u32::from(state == ServiceState::StartPending),
        wait_hint: if state == ServiceState::StartPending { STARTUP_TIMEOUT } else { Duration::ZERO },
        process_id: None,
    };
    let _ = handle.set_service_status(status(ServiceState::StartPending, ServiceControlAccept::empty(), 0));
    let result = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| error.to_string())
        .and_then(|runtime| runtime.block_on(async {
            let core = std::env::current_exe().map_err(|error| error.to_string())?.with_file_name(install::CORE_EXE);
            let directory = core.parent().ok_or("虚拟网卡服务目录无效")?;
            let owner = std::env::args().nth(2).filter(|owner| install::valid_sid(owner))
                .ok_or("虚拟网卡服务缺少有效的 Windows 用户")?;
            let server = create_pipe(PIPE, &owner, true)?;
            // The previous service may still be releasing its adapter during an upgrade.
            let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
            while adapter::name_in_use()? && tokio::time::Instant::now() < deadline {
                sleep(Duration::from_millis(100)).await;
            }
            let adapter = adapter::Adapter::create(directory)?;
            adapter.clear_network()?;
            handle.set_service_status(status(ServiceState::Running, ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN, 0))
                .map_err(|error| error.to_string())?;
            serve(server, &owner, &core, directory, &adapter, stop).await
        }));
    let _ = handle.set_service_status(status(ServiceState::Stopped, ServiceControlAccept::empty(), if result.is_ok() { 0 } else { 1 }));
}

fn create_pipe(name: &str, owner: &str, first: bool) -> AirResult<tokio::net::windows::named_pipe::NamedPipeServer> {
    // The installing user can exchange messages but cannot create a pipe instance.
    let mut security = SecurityDescriptor::new(&format!("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x00100083;;;{owner})"))?;
    let mut attributes = security.attributes();
    unsafe {
        ServerOptions::new().first_pipe_instance(first).reject_remote_clients(true)
            .create_with_security_attributes_raw(name, (&mut attributes as *mut SECURITY_ATTRIBUTES).cast())
    }.map_err(|error| error.to_string())
}

async fn serve(
    mut pipe: tokio::net::windows::named_pipe::NamedPipeServer,
    owner: &str,
    binary: &Path,
    directory: &Path,
    adapter: &adapter::Adapter,
    mut stop: watch::Receiver<bool>,
) -> AirResult<()> {
    loop {
        tokio::select! {
            _ = stop.changed() => return Ok(()),
            result = pipe.connect() => result.map_err(|error| error.to_string())?,
        }
        let mut kernel = None;
        loop {
            let request = tokio::select! {
                _ = stop.changed() => break,
                _ = wait_for_kernel_exit(&mut kernel) => break,
                request = read(&mut pipe) => match request { Ok(request) => request, Err(_) => break },
            };
            let starting = matches!(request, Request::Start { .. });
            let stopping = matches!(request, Request::Stop);
            let checks_adapter = starting || matches!(request, Request::Activate { .. } | Request::TunState | Request::Tun { enabled: true, .. });
            let disabling = match &request {
                Request::Park => true,
                Request::Tun { enabled, .. } => !enabled,
                Request::Reload { config } => config["tun"]["enable"].as_bool() == Some(false),
                _ => false,
            };
            let result = if checks_adapter {
                match adapter.check_name() {
                    Ok(()) => dispatch(request, binary, directory, &mut kernel).await,
                    Err(error) => Err(error),
                }
            } else {
                dispatch(request, binary, directory, &mut kernel).await
            };
            // A failed startup can also leave part of the TUN configuration in place.
            let cleanup = match &result {
                Ok(_) if stopping || disabling => adapter.clear_network(),
                Err(error) if stopping => Err(error.clone()),
                Err(_) if starting && kernel.is_none() => adapter.clear_network(),
                _ => Ok(()),
            };
            if let Err(error) = cleanup {
                let _ = stop_kernel(&mut kernel).await;
                let _ = send(&mut pipe, &Response { result: Err(error.clone()) }).await;
                // Releasing the adapter also removes its network settings.
                return Err(error);
            }
            if send(&mut pipe, &Response { result }).await.is_err() {
                break;
            }
        }
        if kernel.is_some() {
            stop_kernel(&mut kernel).await?;
            adapter.clear_network()?;
        }
        if *stop.borrow() {
            return Ok(());
        }
        // Keep an owned listener while discarding the disconnected client's buffered I/O.
        let next = create_pipe(PIPE, owner, false)?;
        let _ = pipe.disconnect();
        pipe = next;
    }
}

async fn wait_for_kernel_exit(active: &mut Option<Kernel>) {
    match active {
        Some(kernel) => kernel.wait_for_exit().await,
        None => std::future::pending().await,
    }
}

async fn stop_kernel(active: &mut Option<Kernel>) -> AirResult<()> {
    if let Some(mut kernel) = active.take() {
        if kernel.running() {
            kernel.stop().await?;
        }
    }
    Ok(())
}

async fn dispatch(request: Request, binary: &Path, directory: &Path, active: &mut Option<Kernel>) -> AirResult<Value> {
    if let Request::Start { config, port, allow_lan } = request {
        if active.is_some() {
            return Err("虚拟网卡服务已有运行会话".into());
        }
        let config = policy::runtime_config(config)?;
        let (kernel, port) = Kernel::start_proxy(binary, directory, config, port, allow_lan).await?;
        *active = Some(kernel);
        return Ok(json!(port));
    }
    if matches!(request, Request::Stop) {
        stop_kernel(active).await?;
        return Ok(Value::Null);
    }
    if let Request::Prepare { config } = request {
        if active.is_some() {
            return Err("虚拟网卡服务已有运行会话".into());
        }
        let config = policy::runtime_config(config)?;
        *active = Some(Kernel::prepare_tun(binary, directory, config).await?);
        return Ok(Value::Null);
    }
    let kernel = active.as_mut().ok_or("虚拟网卡服务尚未启动内核")?;
    match request {
        Request::Start { .. } | Request::Prepare { .. } | Request::Stop => unreachable!(),
        Request::Activate { settings, port } => {
            settings.validate()?;
            return Ok(json!(kernel.activate_tun(&settings, port).await?));
        }
        Request::Park => kernel.park_tun().await?,
        Request::Alive => return Ok(json!(kernel.running())),
        Request::Connections => return json_config(Kernel::connections(kernel.connections_request()).await?),
        Request::TunState => return Ok(json!(kernel.tun_enabled().await?)),
        Request::Mode { mode } => kernel.patch_config(&json!({ "mode": mode })).await?,
        Request::Tun { settings, enabled } => {
            settings.validate()?;
            kernel.patch_config(&json!({ "tun": settings.tun(enabled) })).await?;
        }
        Request::Global { name } => kernel.select_global(&name).await?,
        Request::CloseConnections { ids } => {
            for id in ids {
                let _ = kernel.close_connection(&id).await;
            }
        }
        Request::CloseAllConnections => {
            let _ = kernel.close_all_connections().await;
        }
        Request::Reload { config } => kernel.reload_config(&policy::runtime_config(config)?).await?,
    }
    Ok(Value::Null)
}

async fn send(writer: &mut (impl AsyncWrite + Unpin), value: &impl Serialize) -> io::Result<()> {
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    if bytes.len() > MAX_FRAME {
        return Err(io::Error::other("invalid service message length"));
    }
    writer.write_u32_le(bytes.len() as u32).await?;
    writer.write_all(&bytes).await
}

async fn read<T: DeserializeOwned>(reader: &mut (impl AsyncRead + Unpin)) -> io::Result<T> {
    let size = reader.read_u32_le().await? as usize;
    if size == 0 || size > MAX_FRAME {
        return Err(io::Error::other("invalid service message length"));
    }
    let mut bytes = vec![0; size];
    reader.read_exact(&mut bytes).await?;
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires the current Air TUN service with no active Air session"]
    async fn installed_service_reuses_adapter_without_default_routes() {
        use crate::proxy::windows::adapter_luid;
        assert!(current_service_pid().is_some());
        let luid = adapter_luid(adapter::NAME).expect("the service should keep Air-TUN while idle");
        let mut config = serde_yaml::to_value(json!({
            "mode": "direct",
            "proxies": [], "proxy-groups": [], "profile": {},
            "rules": ["MATCH,DIRECT"],
            "dns": {"enable": false, "fake-ip-range": "198.19.240.1/24"},
            "tun": {"enable": true, "device": "Air-TUN", "stack": "gvisor", "auto-route": false},
        })).unwrap();
        config["ipv6"] = false.into();
        for _ in 0..2 {
            let (session, _) = Session::start(config.clone(), None, false).await.unwrap();
            let mut kernel = super::super::RuntimeKernel::Service(session);
            let ready = super::super::verify_tun(&kernel, true).await;
            let tunnel_luid = adapter_luid(adapter::NAME);
            let binding = std::net::UdpSocket::bind((std::net::Ipv4Addr::new(198, 19, 240, 1), 0));
            kernel.stop().await.unwrap();
            ready.unwrap();
            binding.unwrap();
            assert_eq!(tunnel_luid, Some(luid));
            assert_eq!(adapter_luid(adapter::NAME), Some(luid));
            assert!(adapter::manual_addresses(luid).unwrap().is_empty());
            assert!(adapter::managed_routes(luid).unwrap().is_empty());
        }
    }

    #[tokio::test]
    #[ignore = "requires the current Air TUN service on an isolated Windows machine (takes the default route)"]
    async fn installed_service_keeps_one_adapter_across_sessions() {
        use crate::proxy::windows::{adapter_active, adapter_luid};
        assert!(current_service_pid().is_some());
        assert!(adapter::name_in_use().unwrap());
        let luid = adapter_luid(adapter::NAME).expect("the service should create Air-TUN while idle");
        let idle = || async {
            timeout(Duration::from_secs(5), async {
                loop {
                    assert_eq!(adapter_luid(adapter::NAME), Some(luid));
                    if !adapter_active(adapter::NAME)
                        && adapter::managed_routes(luid).unwrap().is_empty()
                        && adapter::manual_addresses(luid).unwrap().is_empty()
                    {
                        break;
                    }
                    sleep(Duration::from_millis(50)).await;
                }
            }).await.expect("Air-TUN should be disconnected without proxy routes or addresses");
        };
        idle().await;

        let network = NetworkSettings::default();
        let mut config = serde_yaml::to_value(json!({
            "mode": "direct", "profile": {}, "rules": ["MATCH,DIRECT"], "proxies": [], "proxy-groups": []
        })).unwrap();
        network.apply_proxy(&mut config, true, None).unwrap();
        let pool = config["dns"]["fake-ip-range"].as_str().unwrap();
        let (host, _) = pool.split_once('/').unwrap();
        let address = host.parse::<std::net::Ipv4Addr>().unwrap();
        assert_eq!(&address.octets()[..2], &[198, 19]);
        let session = Session::prepare(&config).await.unwrap();
        let kernel = super::super::RuntimeKernel::Service(session.clone());
        idle().await;
        for _ in 0..2 {
            assert!(session.running().await);
            session.activate(&network).await.unwrap();
            super::super::verify_tun(&kernel, true).await.unwrap();
            assert!(!adapter::managed_routes(luid).unwrap().is_empty());
            session.park().await.unwrap();
            idle().await;
        }
        session.stop().await.unwrap();

        for disconnect in [false, true] {
            let (session, _) = Session::start(config.clone(), None, false).await.unwrap();
            let mut kernel = super::super::RuntimeKernel::Service(session);
            super::super::verify_tun(&kernel, true).await.unwrap();
            assert_eq!(adapter_luid(adapter::NAME), Some(luid));
            assert!(!adapter::managed_routes(luid).unwrap().is_empty());
            std::net::UdpSocket::bind((address, 0)).unwrap();
            if !disconnect {
                kernel.set_tun(&network, false).await.unwrap();
                idle().await;
                kernel.set_tun(&network, true).await.unwrap();
                super::super::verify_tun(&kernel, true).await.unwrap();
                kernel.stop().await.unwrap();
            }
            drop(kernel);
            idle().await;
        }
    }

    #[tokio::test]
    async fn service_messages_use_the_owned_pipe() {
        let name = format!(r"\\.\pipe\AirTunService-test-{}", uuid::Uuid::new_v4());
        let mut security = SecurityDescriptor::new(&format!(
            "D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x00100083;;;{})",
            install::user_sid().unwrap()
        )).unwrap();
        let mut attributes = security.attributes();
        let mut server = unsafe {
            ServerOptions::new().first_pipe_instance(true).reject_remote_clients(true)
                .create_with_security_attributes_raw(&name, (&mut attributes as *mut SECURITY_ATTRIBUTES).cast())
        }.unwrap();
        let mut client = open_pipe(&name, std::process::id()).unwrap();
        server.connect().await.unwrap();
        send(&mut client, &Request::Alive).await.unwrap();
        assert!(matches!(read(&mut server).await.unwrap(), Request::Alive));
        send(&mut server, &Response { result: Ok(json!(true)) }).await.unwrap();
        assert_eq!(read::<Response>(&mut client).await.unwrap().result.unwrap(), true);
    }

    #[test]
    fn compat_config_preserves_v6_fields_and_strips_for_older_service() {
        let raw = json!({
            "unified-delay": true,
            "keep-alive-idle": 600,
            "keep-alive-interval": 15,
            "disable-keep-alive": false,
            "sniffer": { "enable": true },
            "tun": { "device": "Air-TUN", "endpoint-independent-nat": true },
            "proxies": [], "proxy-groups": [], "profile": {}, "dns": {}
        });
        let current = compat_config(raw.clone(), true);
        assert_eq!(current["unified-delay"], json!(true));
        assert_eq!(current["tun"]["endpoint-independent-nat"], json!(true));
        assert!(policy::runtime_config(current).is_ok());

        let legacy = compat_config(raw, false);
        assert!(legacy.get("unified-delay").is_none());
        assert!(legacy.get("sniffer").is_none());
        assert!(legacy["tun"].get("endpoint-independent-nat").is_none());
    }

    #[test]
    fn compat_network_settings_strips_bypass_lan_and_preserves_effective_exclusions() {
        let settings = NetworkSettings {
            ipv6: false,
            bypass_lan: true,
            route_exclude_address: vec!["203.0.113.0/24".into()],
            ..NetworkSettings::default()
        };
        let compat = compat_network_settings(&settings).unwrap();
        assert!(compat.get("bypassLan").is_none());
        assert_eq!(
            compat["routeExcludeAddress"],
            json!([
                "10.0.0.0/8",
                "172.16.0.0/12",
                "192.168.0.0/16",
                "169.254.0.0/16",
                "203.0.113.0/24"
            ])
        );

        let custom_only = NetworkSettings {
            bypass_lan: false,
            ..settings
        };
        let compat_custom = compat_network_settings(&custom_only).unwrap();
        assert!(compat_custom.get("bypassLan").is_none());
        assert_eq!(compat_custom["routeExcludeAddress"], json!(["203.0.113.0/24"]));
    }
}
