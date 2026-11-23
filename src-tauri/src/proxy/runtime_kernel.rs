use super::Mode;
use crate::{mihomo::{ConnectionsSnapshot, Kernel}, AirResult};
use serde_yaml::Value;
use std::{future::Future, path::Path};

pub(super) enum RuntimeKernel {
    Local(Kernel),
    #[cfg(windows)]
    Service(super::tun_service::Session),
}

impl RuntimeKernel {
    pub async fn start(
        binary: &Path,
        directory: &Path,
        config: Value,
        port: Option<u16>,
        allow_lan: bool,
        use_service: bool,
    ) -> AirResult<(Self, u16)> {
        use super::loopback::PREFERRED_PORT;
        if let Some(port) = port {
            return Self::start_on_port(binary, directory, config, Some(port), allow_lan, use_service).await;
        }
        if super::loopback::bind_loopback(PREFERRED_PORT).is_err() {
            return Self::start_on_port(binary, directory, config, None, allow_lan, use_service).await;
        }
        // Desktop clients can retain this loopback endpoint across a switch of proxy apps.
        // Retry only a bind conflict. Installed TUN services return the same port error over IPC.
        match Self::start_on_port(binary, directory, config.clone(), Some(PREFERRED_PORT), allow_lan, use_service).await {
            Err(error) if error == crate::mihomo::mixed_port_unavailable(PREFERRED_PORT) => {
                Self::start_on_port(binary, directory, config, None, allow_lan, use_service).await
            }
            result => result,
        }
    }

    async fn start_on_port(
        binary: &Path,
        directory: &Path,
        config: Value,
        port: Option<u16>,
        allow_lan: bool,
        use_service: bool,
    ) -> AirResult<(Self, u16)> {
        #[cfg(windows)]
        if use_service {
            let (session, port) = super::tun_service::Session::start(config, port, allow_lan).await?;
            return Ok((Self::Service(session), port));
        }
        let _ = use_service;
        let (kernel, port) = Kernel::start_proxy(binary, directory, config, port, allow_lan).await?;
        Ok((Self::Local(kernel), port))
    }

    pub async fn running(&mut self) -> bool {
        match self {
            Self::Local(kernel) => kernel.running(),
            #[cfg(windows)]
            Self::Service(session) => session.running().await,
        }
    }

    pub async fn stop(&mut self) -> AirResult<()> {
        match self {
            Self::Local(kernel) => kernel.stop().await,
            #[cfg(windows)]
            Self::Service(session) => session.stop().await,
        }
    }

    pub async fn select_global(&self, name: &str) -> AirResult<()> {
        match self {
            Self::Local(kernel) => kernel.select_global(name).await,
            #[cfg(windows)]
            Self::Service(session) => session.select_global(name).await,
        }
    }

    pub async fn reload(&self, config: &Value) -> AirResult<()> {
        match self {
            Self::Local(kernel) => kernel.reload_config(config).await,
            #[cfg(windows)]
            Self::Service(session) => session.reload(config).await,
        }
    }

    pub async fn set_mode(&self, mode: Mode) -> AirResult<()> {
        match self {
            Self::Local(kernel) => kernel.patch_config(&serde_json::json!({ "mode": mode })).await,
            #[cfg(windows)]
            Self::Service(session) => session.set_mode(mode).await,
        }
    }

    pub async fn close_connections(&self, ids: &[String]) -> AirResult<()> {
        match self {
            Self::Local(kernel) => {
                for id in ids {
                    let _ = kernel.close_connection(id).await;
                }
                Ok(())
            }
            #[cfg(windows)]
            Self::Service(session) => session.close_connections(ids).await,
        }
    }

    pub async fn close_all_connections(&self) -> AirResult<()> {
        match self {
            Self::Local(kernel) => kernel.close_all_connections().await,
            #[cfg(windows)]
            Self::Service(session) => session.close_all_connections().await,
        }
    }

    #[cfg(windows)]
    pub async fn set_tun(&self, settings: &crate::network::NetworkSettings, enabled: bool) -> AirResult<()> {
        match self {
            Self::Local(kernel) => kernel.patch_config(&serde_json::json!({ "tun": settings.tun(enabled) })).await,
            Self::Service(session) => session.set_tun(settings, enabled).await,
        }
    }

    #[cfg(windows)]
    pub async fn tun_enabled(&self) -> AirResult<bool> {
        match self {
            Self::Local(kernel) => kernel.tun_enabled().await,
            Self::Service(session) => session.tun_state().await,
        }
    }

    pub fn connections(&self) -> impl Future<Output = AirResult<ConnectionsSnapshot>> + Send + 'static {
        enum Query {
            Local(reqwest::RequestBuilder),
            #[cfg(windows)]
            Service(super::tun_service::Session),
        }
        let request = match self {
            Self::Local(kernel) => Query::Local(kernel.connections_request()),
            #[cfg(windows)]
            Self::Service(session) => Query::Service(session.clone()),
        };
        async move {
            match request {
                Query::Local(request) => Kernel::connections(request).await,
                #[cfg(windows)]
                Query::Service(session) => session.connections().await,
            }
        }
    }

    pub fn memory_bytes(&self) -> Option<u64> {
        #[cfg(windows)]
        if let Self::Local(kernel) = self {
            return kernel.process_handle().and_then(super::windows::memory_bytes);
        }
        None
    }
}
