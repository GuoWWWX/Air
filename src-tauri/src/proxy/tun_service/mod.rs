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

pub(super) fn service_pid() -> Option<u32> {
    let (service, compatible) = owned_service()?;
    let status = service.query_status().ok()?;
    status.process_id.filter(|_| compatible && status.current_state == ServiceState::Running)
}

fn owned_service() -> Option<(Service, bool)> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT).ok()?;
    let service = manager.open_service(SERVICE_NAME, ServiceAccess::QUERY_STATUS | ServiceAccess::QUERY_CONFIG).ok()?;
    let config = service.query_config().ok()?;
    let command = config.executable_path.to_string_lossy();
    let owner = install::user_sid()?;
    let mut arguments = command.split_whitespace().rev().map(|part| part.trim_matches('"'));
    let engine = arguments.next()?;
    if arguments.next()? != owner { return None; }
    let version = arguments.next()?;
    matches!(version, install::RUN | install::PREVIOUS_RUN | install::LEGACY_RUN)
        .then_some((service, version == install::RUN && engine == install::CORE_SHA256))
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
enum Request {
    Start { config: Value, port: Option<u16>, allow_lan: bool },
    Reload { config: Value },
    Mode { mode: Mode },
    Tun { settings: Box<NetworkSettings>, enabled: bool },
    TunState,
    Global { name: String },
    Alive,
    Stop,
    Connections,
}

#[derive(Deserialize, Serialize)]
struct Response {
    result: AirResult<Value>,
}

#[derive(Clone)]
pub(super) struct Session(Arc<Mutex<Option<NamedPipeClient>>>);

impl Session {
    pub async fn start(config: serde_yaml::Value, port: Option<u16>, allow_lan: bool) -> AirResult<(Self, u16)> {
        let pid = service_pid().ok_or("请先安装虚拟网卡服务")?;
        let pipe = timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(pipe) = open_pipe(PIPE, pid) {
                    break pipe;
                }
                sleep(Duration::from_millis(60)).await;
            }
        }).await.map_err(|_| "无法连接虚拟网卡服务，请重试")?;
        let session = Self(Arc::new(Mutex::new(Some(pipe))));
        let port = session.call(Request::Start { config: json_config(config)?, port, allow_lan }).await?;
        Ok((session, port))
    }

    async fn call<T: DeserializeOwned>(&self, request: Request) -> AirResult<T> {
        let mut slot = self.0.lock().await;
        let mut pipe = slot.take().ok_or("虚拟网卡服务连接已关闭")?;
        let result = timeout(Duration::from_secs(15), async {
            send(&mut pipe, &request).await?;
            read::<Response>(&mut pipe).await
        }).await
            .map_err(|_| "虚拟网卡服务响应超时")?
            .map_err(|_| "虚拟网卡服务连接已关闭")?;
        *slot = Some(pipe);
        serde_json::from_value(result.result?).map_err(|_| "虚拟网卡服务响应无效".into())
    }

    pub async fn running(&self) -> bool {
        self.call(Request::Alive).await.unwrap_or(false)
    }

    pub async fn connections(&self) -> AirResult<ConnectionsSnapshot> {
        self.call(Request::Connections).await
    }

    pub async fn set_mode(&self, mode: Mode) -> AirResult<()> {
        self.call(Request::Mode { mode }).await
    }

    pub async fn set_tun(&self, settings: &NetworkSettings, enabled: bool) -> AirResult<()> {
        self.call(Request::Tun { settings: Box::new(settings.clone()), enabled }).await
    }

    pub async fn tun_state(&self) -> AirResult<bool> {
        self.call(Request::TunState).await
    }

    pub async fn select_global(&self, name: &str) -> AirResult<()> {
        self.call(Request::Global { name: name.into() }).await
    }

    pub async fn reload(&self, config: &serde_yaml::Value) -> AirResult<()> {
        self.call(Request::Reload { config: json_config(config)? }).await
    }

    pub async fn stop(&self) -> AirResult<()> {
        self.call::<()>(Request::Stop).await?;
        self.0.lock().await.take();
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
        wait_hint: if state == ServiceState::StartPending { Duration::from_secs(8) } else { Duration::ZERO },
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
            handle.set_service_status(status(ServiceState::Running, ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN, 0))
                .map_err(|error| error.to_string())?;
            serve(server, PIPE, &owner, &core, directory, stop).await
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
    name: &str,
    owner: &str,
    binary: &Path,
    directory: &Path,
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
                _ = stop.changed() => return Ok(()),
                request = read(&mut pipe) => match request { Ok(request) => request, Err(_) => break },
            };
            let result = dispatch(request, binary, directory, &mut kernel).await;
            if send(&mut pipe, &Response { result }).await.is_err() {
                break;
            }
        }
        // Keep an owned listener while discarding the disconnected client's buffered I/O.
        let next = create_pipe(name, owner, false)?;
        drop(kernel);
        let _ = pipe.disconnect();
        pipe = next;
    }
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
    let kernel = active.as_mut().ok_or("虚拟网卡服务尚未启动内核")?;
    match request {
        Request::Start { .. } => unreachable!(),
        Request::Alive => return Ok(json!(kernel.running())),
        Request::Stop => {
            if kernel.running() {
                let _ = kernel.patch_config(&json!({ "tun": { "enable": false } })).await;
                kernel.stop().await?;
            }
            *active = None;
        }
        Request::Connections => return json_config(Kernel::connections(kernel.connections_request()).await?),
        Request::TunState => return Ok(json!(kernel.tun_enabled().await?)),
        Request::Mode { mode } => kernel.patch_config(&json!({ "mode": mode })).await?,
        Request::Tun { settings, enabled } => {
            settings.validate()?;
            kernel.patch_config(&json!({ "tun": settings.tun(enabled) })).await?;
        }
        Request::Global { name } => kernel.select_global(&name).await?,
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
    #[ignore = "requires the installed Air TUN service on Windows"]
    async fn installed_service_reopens_a_real_adapter() {
        let network = NetworkSettings::default();
        let mut config = serde_yaml::to_value(json!({
            "mode": "direct", "profile": {}, "rules": ["MATCH,DIRECT"], "proxies": [], "proxy-groups": []
        })).unwrap();
        network.apply_proxy(&mut config, true, None).unwrap();
        let pool = config["dns"]["fake-ip-range"].as_str().unwrap();
        let (host, _) = pool.split_once('/').unwrap();
        let address = host.parse::<std::net::Ipv4Addr>().unwrap();
        assert_eq!(&address.octets()[..2], &[198, 19]);
        // Exercise the real driver without taking the machine's default route.
        config["tun"]["auto-route"] = false.into();
        for _ in 0..2 {
            let (session, _) = Session::start(config.clone(), None, false).await.unwrap();
            let mut kernel = super::super::RuntimeKernel::Service(session);
            let result = super::super::verify_tun(&kernel, true).await;
            let binding = std::net::UdpSocket::bind((address, 0));
            kernel.stop().await.unwrap();
            result.unwrap();
            binding.unwrap();
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
}
