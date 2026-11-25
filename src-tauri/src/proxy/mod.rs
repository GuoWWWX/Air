mod config;
pub(crate) mod subscription_rules;
pub mod exit;
mod runtime_kernel;
#[cfg(test)]
mod telemetry_tests;
mod loopback;
#[cfg(windows)]
pub mod tun_service;
#[cfg(windows)]
pub(crate) mod windows;
#[cfg(windows)]
pub(crate) mod lan_discovery;
#[cfg(all(windows, feature = "desktop"))]
mod windows_apps;

pub use config::{compile, ProxyConfig};

use crate::{mihomo::ConnectionsSnapshot, AirResult};
use runtime_kernel::RuntimeKernel;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{File, OpenOptions},
    path::{Path, PathBuf},
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Rule,
    Global,
    Direct,
}

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Action {
    Start {
        kernel_path: PathBuf,
        target: StartTarget,
    },
    SelectGroup {
        id: String,
    },
    SelectNode {
        id: String,
        group_id: Option<String>,
    },
    Stop,
    Mode {
        mode: Mode,
    },
    SystemProxy {
        enabled: bool,
    },
    Tun {
        enabled: bool,
    },
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StartTarget {
    Routing,
    Group {
        id: String,
        #[serde(default)]
        name: String,
        #[serde(default)]
        members: Vec<String>,
    },
    Node {
        id: String,
        group_id: Option<String>,
    },
    Chain {
        id: Option<String>,
        inherit_exit_rules: Option<bool>,
        name: String,
        hops: Vec<String>,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outbound {
    name: String,
    hops: Vec<Hop>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Hop {
    id: String,
    name: String,
    protocol: String,
    source: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub running: bool,
    pub mode: Mode,
    port: Option<u16>,
    pub system_proxy: bool,
    pub tun: bool,
    pub tun_service_ready: Option<bool>,
    session_id: Option<String>,
    target: Option<StartTarget>,
    outbound: Option<Outbound>,
}

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct TrafficSnapshot {
    upload_rate: u64,
    download_rate: u64,
    upload_total: u64,
    download_total: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySnapshot {
    revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    log_order: Option<Vec<String>>,
    session_id: String,
    sampled_at: u64,
    stale: bool,
    #[serde(flatten)]
    traffic: TrafficSnapshot,
    memory_bytes: Option<u64>,
    connections: Vec<Arc<ConnectionView>>,
    connection_logs: Vec<Arc<ConnectionView>>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    app_icons: HashMap<String, Arc<str>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryCursor {
    pub session_id: String,
    pub revision: u64,
    pub known_icons: HashSet<String>,
}

impl TelemetrySnapshot {
    fn make_incremental(&mut self, cursor: &TelemetryCursor) {
        let same_session = self.session_id == cursor.session_id && cursor.revision <= self.revision;
        self.log_order = Some(
            self.connection_logs
                .iter()
                .map(|row| row.id.clone())
                .collect(),
        );
        self.connection_logs
            .retain(|row| row.closed && (!same_session || row.closed_revision > cursor.revision));
        if same_session {
            self.app_icons
                .retain(|key, _| !cursor.known_icons.contains(key));
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionView {
    #[serde(skip)]
    closed_revision: u64,
    id: String,
    app: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    app_executable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    app_icon_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    destination_ip: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    network: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    process_path: Option<String>,
    start: String,
    closed: bool,
    target: String,
    rule: String,
    path: Vec<String>,
    upload_bytes: u64,
    download_bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedApplication {
    pub executable: Option<String>,
    pub path: Option<String>,
    pub name: String,
    pub icon: Option<String>,
}

pub fn resolve_applications(queries: &[String]) -> Vec<ResolvedApplication> {
    #[cfg(all(windows, feature = "desktop"))]
    {
        return windows_apps::resolve_queries(queries);
    }
    #[cfg(not(all(windows, feature = "desktop")))]
    {
        let _ = queries;
        Vec::new()
    }
}

#[derive(Default)]
struct Applications {
    entries: HashMap<String, Application>,
    icons: HashMap<String, Arc<str>>,
}

struct Application {
    name: String,
    executable: Option<String>,
    process_name: Option<String>,
    process_path: Option<String>,
    icon_key: Option<String>,
}

pub struct Runtime {
    directory: PathBuf,
    config_directory: PathBuf,
    mode: Mode,
    system_proxy: bool,
    tun: bool,
    active: Option<Active>,
    #[cfg(windows)]
    standby: Option<StandbyTun>,
}

#[cfg(windows)]
struct StandbyTun {
    session: tun_service::Session,
    yaml: serde_yaml::Value,
    lease: File,
}

struct Active {
    target: StartTarget,
    source_ids: std::collections::HashSet<String>,
    rule_source_id: Option<String>,
    network: crate::network::NetworkSettings,
    kernel: RuntimeKernel,
    binary: PathBuf,
    yaml: serde_yaml::Value,
    port: u16,
    global: Option<String>,
    system_proxy: bool,
    tun: bool,
    last_traffic: Option<(Instant, u64, u64)>,
    traffic_baseline: (u64, u64),
    session_id: String,
    outbound: Outbound,
    node_names: HashMap<String, String>,
    dialers: HashMap<String, String>,
    telemetry: Option<TelemetrySnapshot>,

    _loopback: Option<loopback::Forwarder>,
    _lease: File,
}

impl Runtime {
    pub fn new(directory: PathBuf) -> Self {
        Self::with_preferences(directory, Mode::default(), false)
    }

    pub fn with_preferences(directory: PathBuf, mode: Mode, tun: bool) -> Self {
        Self::with_profile(directory.clone(), directory, mode, tun)
    }

    pub fn with_profile(directory: PathBuf, config_directory: PathBuf, mode: Mode, tun: bool) -> Self {
        Self {
            directory,
            config_directory,
            mode,
            system_proxy: false,
            tun: cfg!(windows) && tun,
            active: None,
            #[cfg(windows)]
            standby: None,
        }
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    pub async fn reap_exited(&mut self) -> AirResult<()> {
        if let Some(active) = self.active.as_mut() {
            if !active.kernel.running().await {
                self.stop().await?;
            }
        }
        Ok(())
    }

    pub async fn status(&mut self) -> AirResult<Status> {
        self.reap_exited().await?;
        #[cfg(windows)]
        if self.active.is_none() && windows::has_restore(&self.directory) {
            // A second Air window must not undo another window's proxy settings.
            if let Ok(_lease) = lease(&self.directory) {
                windows::restore(&self.directory)?;
            }
        }
        let active = self.active.as_ref();
        #[cfg(windows)]
        let system_proxy = match active {
            Some(active) if active.system_proxy => windows::is_active(active.port)?,
            Some(_) => false,
            None => self.system_proxy,
        };
        #[cfg(not(windows))]
        let system_proxy = self.system_proxy;
        Ok(Status {
            running: active.is_some(),
            mode: self.mode,
            port: active.map(|active| active.port),
            system_proxy,
            tun: active.map_or(self.tun, |active| active.tun),
            tun_service_ready: tun_service_ready(),
            session_id: active.map(|active| active.session_id.clone()),
            target: self.active_target(),
            outbound: active.map(|active| active.outbound.clone()),
        })
    }

    pub async fn start(&mut self, binary: &Path, config: config::ProxyConfig) -> AirResult<()> {
        self.reap_exited().await?;
        if self.active.is_some() {
            return Ok(());
        }
        self.start_kernel(binary, config).await?;
        let result = if self.system_proxy { self.set_system_proxy(true) } else { Ok(()) };
        if let Err(error) = result {
            self.stop()
                .await
                .map_err(|stop_error| format!("{error}。关闭本次启动的代理失败：{stop_error}"))?;
            return Err(error);
        }
        Ok(())
    }

    fn configure_start(&self, config: &mut config::ProxyConfig, network: &crate::network::NetworkSettings) -> AirResult<()> {
        network.validate()?;
        config.apply_network(network, self.tun, None)?;
        config.yaml["mode"] = serde_yaml::to_value(self.mode).map_err(|_| "出站模式无效")?;
        config.yaml["log-level"] = if cfg!(windows) { "error" } else { "silent" }.into();
        // The live port is chosen separately each time a proxy session starts.
        config.yaml["mixed-port"] = 0.into();
        Ok(())
    }

    #[cfg(windows)]
    pub fn can_prepare_tun(&self) -> bool {
        self.tun && self.active.is_none() && self.standby.is_none()
            && !windows::has_restore(&self.directory) && tun_service::standby_service_available()
    }

    #[cfg(windows)]
    pub async fn prepare_tun(&mut self, mut config: config::ProxyConfig) -> AirResult<()> {
        if !self.can_prepare_tun() {
            return Ok(());
        }
        let lease = lease(&self.directory)?;
        let network = crate::routing::RoutingFile::new(&self.config_directory).network()?.settings;
        self.configure_start(&mut config, &network)?;
        let session = tun_service::Session::prepare(&config.yaml).await?;
        self.standby = Some(StandbyTun { session, yaml: config.yaml, lease });
        Ok(())
    }

    async fn start_kernel(&mut self, binary: &Path, mut config: config::ProxyConfig) -> AirResult<()> {
        #[cfg(windows)]
        let (lease, standby) = match self.standby.take() {
            Some(standby) => (standby.lease, Some((standby.session, standby.yaml))),
            None => (lease(&self.directory)?, None),
        };
        #[cfg(not(windows))]
        let lease = lease(&self.directory)?;
        let network = crate::routing::RoutingFile::new(&self.config_directory).network()?.settings;
        self.configure_start(&mut config, &network)?;
        let use_service = tun_uses_service(self.tun)?;
        #[cfg(windows)]
        windows::restore(&self.directory)?;
        let mut reused = None;
        #[cfg(windows)]
        if let Some((session, yaml)) = standby {
            if use_service && yaml == config.yaml {
                let ready: AirResult<_> = async {
                    let counters = session.connections().await?;
                    let port = session.activate(&network).await?;
                    verify_tun(&RuntimeKernel::Service(session.clone()), true).await?;
                    Ok((port, (counters.upload_total, counters.download_total)))
                }.await;
                if let Ok((port, counters)) = ready {
                    reused = Some((RuntimeKernel::Service(session.clone()), port, counters));
                }
            }
            if reused.is_none() {
                let _ = session.stop().await;
            }
        }
        let (kernel, port, traffic_baseline) = match reused {
            Some(prepared) => prepared,
            None => {
                let (kernel, port) = RuntimeKernel::start(
                    binary, &self.directory, config.yaml.clone(), network.mixed_port, network.allow_lan, use_service,
                ).await?;
                #[cfg(windows)]
                let kernel = {
                    let mut kernel = kernel;
                    if self.tun {
                        if let Err(error) = verify_tun(&kernel, true).await {
                            let _ = kernel.stop().await;
                            return Err(error);
                        }
                    }
                    kernel
                };
                (kernel, port, (0, 0))
            }
        };
        // A newly started kernel defaults to the sole member of GLOBAL.
        config.yaml["mixed-port"] = port.into();
        let loopback = (network.mixed_port.is_none() && port != loopback::PREFERRED_PORT)
            .then(|| loopback::Forwarder::start(loopback::PREFERRED_PORT, port));
        self.active = Some(Active {
            target: config.target,
            source_ids: config.source_ids,
            rule_source_id: config.rule_source_id,
            network,
            kernel,
            binary: binary.to_owned(),
            yaml: config.yaml,
            port,
            global: config.global,
            system_proxy: false,
            tun: self.tun,
            last_traffic: None,
            traffic_baseline,
            session_id: uuid::Uuid::new_v4().simple().to_string(),
            outbound: config.outbound,
            node_names: config.node_names,
            dialers: config.dialers,
            telemetry: None,

            _loopback: loopback,
            _lease: lease,
        });
        Ok(())
    }

    pub fn telemetry(&self) -> Option<TelemetrySnapshot> {
        self.active.as_ref()?.telemetry.clone()
    }

    pub fn telemetry_update(&self, cursor: Option<&TelemetryCursor>) -> Option<TelemetrySnapshot> {
        let mut sample = self.telemetry()?;
        if let Some(cursor) = cursor {
            sample.make_incremental(cursor);
        }
        Some(sample)
    }

    pub fn active_network(&self) -> Option<&crate::network::NetworkSettings> {
        self.active.as_ref().map(|active| &active.network)
    }

    pub fn active_target(&self) -> Option<StartTarget> {
        self.active.as_ref().map(|active| active.target.clone())
    }

    pub fn clear_connection_logs(&mut self) {
        let Some(active) = self.active.as_mut() else { return };
        if let Some(snapshot) = &mut active.telemetry {
            snapshot.connection_logs.retain(|item| !item.closed);
            let used: HashSet<_> = snapshot
                .connections
                .iter()
                .filter_map(|row| row.app_icon_key.as_ref())
                .collect();
            snapshot.app_icons.retain(|key, _| used.contains(key));
            snapshot.revision += 1;
        }
    }

    pub async fn close_matching_connections(&self, process_name: Option<&str>, host: Option<&str>) {
        let Some(active) = self.active.as_ref() else { return };
        let proc_target = process_name.map(str::trim).filter(|s| !s.is_empty());
        let host_target = host.map(str::trim).filter(|s| !s.is_empty());
        if proc_target.is_none() && host_target.is_none() {
            return;
        }
        let host_suffix = host_target.map(|h| format!(".{}", h.to_ascii_lowercase()));
        let matches_host = |candidate_host: Option<&str>, candidate_ip: Option<&str>| {
            host_target.is_none_or(|h| {
                candidate_host.is_some_and(|ch| {
                    ch.eq_ignore_ascii_case(h)
                        || host_suffix
                            .as_deref()
                            .is_some_and(|suffix| ch.to_ascii_lowercase().ends_with(suffix))
                }) || candidate_ip.is_some_and(|ip| ip == h)
            })
        };
        let ids: Vec<String> = match active.kernel.connections().await {
            Ok(snapshot) => snapshot
                .connections
                .unwrap_or_default()
                .into_iter()
                .filter(|entry| {
                    if entry.metadata.internal() {
                        return false;
                    }
                    let proc_ok = proc_target.is_none_or(|p| {
                        entry
                            .metadata
                            .process_name()
                            .is_some_and(|n| n.eq_ignore_ascii_case(p))
                            || entry.metadata.app().eq_ignore_ascii_case(p)
                    });
                    let entry_host = entry.metadata.host();
                    let entry_ip = entry.metadata.destination_ip();
                    proc_ok && matches_host(entry_host.as_deref(), entry_ip.as_deref())
                })
                .map(|entry| entry.id)
                .collect(),
            Err(_) => active
                .telemetry
                .as_ref()
                .map(|snapshot| {
                    snapshot
                        .connections
                        .iter()
                        .filter(|conn| {
                            let proc_ok = proc_target.is_none_or(|p| {
                                conn.process_name
                                    .as_deref()
                                    .is_some_and(|n| n.eq_ignore_ascii_case(p))
                                    || conn.app.eq_ignore_ascii_case(p)
                            });
                            proc_ok
                                && matches_host(
                                    conn.host.as_deref(),
                                    conn.destination_ip.as_deref(),
                                )
                        })
                        .map(|conn| conn.id.clone())
                        .collect()
                })
                .unwrap_or_default(),
        };
        let _ = active.kernel.close_connections(&ids).await;
    }

    pub fn exit_port(&self, session_id: &str) -> AirResult<u16> {
        self.active
            .as_ref()
            .filter(|active| active.session_id == session_id)
            .map(|active| active.port)
            .ok_or_else(|| "代理会话已变更".into())
    }

    pub fn uses_subscription(&self, id: &str) -> bool {
        self.active.as_ref().is_some_and(|active| active.source_ids.contains(id))
    }

    pub fn subscription_snapshot(&self, id: &str) -> AirResult<Option<String>> {
        let Some(active) = self.active.as_ref().filter(|active| active.rule_source_id.as_deref() == Some(id)) else { return Ok(None) };
        let mut snapshot = active.yaml.clone();
        snapshot["mixed-port"] = active.port.into();
        serde_yaml::to_string(&snapshot).map(Some).map_err(|_| "无法读取运行时配置".into())
    }

    pub fn subscription_proxy_port(&self) -> Option<u16> {
        self.active.as_ref().map(|active| active.port)
    }

    pub async fn select_node(&mut self, mut config: config::ProxyConfig) -> AirResult<()> {
        let active = self.active.as_mut().ok_or("代理已停止，请重新启动")?;
        // Keep the existing inbound and TUN configuration while updating outbound rules.
        config.apply_network(&active.network, active.tun, active.yaml["dns"]["fake-ip-range"].as_str())?;
        config.yaml["mode"] = serde_yaml::to_value(self.mode).map_err(|_| "出站模式无效")?;
        config.yaml["mixed-port"] = active.port.into();
        config.yaml["log-level"] = if cfg!(windows) { "error" } else { "silent" }.into();
        let outbound_changed = config.global != active.global;

        let reuse = active.outbound.hops.len() == 1 && config.outbound.hops.len() == 1
            && active.source_ids == config.source_ids && config::prepare_node_switch(&active.yaml, &mut config.yaml);
        if reuse {
            if outbound_changed {
                let target = config.global.as_deref().ok_or("当前节点无效")?;
                active.kernel.select_global(target).await?;
            }
        } else {
            active.kernel.reload(&config.yaml).await?;
            if has_selectable_global(&config.yaml) {
                let target = config.global.as_deref().ok_or("当前节点无效")?;
                if let Err(error) = active.kernel.select_global(target).await {
                    active.restore_yaml_and_global().await?;
                    return Err(error);
                }
            }
        }
        active.global = config.global;
        active.outbound = config.outbound;
        active.target = config.target;
        active.node_names.extend(config.node_names);
        for name in config.yaml["proxies"]
            .as_sequence()
            .into_iter()
            .flatten()
            .filter_map(|node| node["name"].as_str())
        {
            active.dialers.remove(name);
        }
        active.dialers.extend(config.dialers);
        active.source_ids = config.source_ids;
        active.rule_source_id = config.rule_source_id;
        active.yaml = config.yaml;
        if outbound_changed {
            if let Ok(snapshot) = active.kernel.connections().await {
                let proxied_ids: Vec<String> = snapshot
                    .connections
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|entry| {
                        !entry.metadata.internal()
                            && !entry.chains.as_deref().is_some_and(|chains| {
                                chains
                                    .first()
                                    .is_some_and(|leaf| leaf.eq_ignore_ascii_case("DIRECT"))
                            })
                    })
                    .map(|entry| entry.id)
                    .collect();
                let _ = active.kernel.close_connections(&proxied_ids).await;
            }
        }
        Ok(())
    }

    pub async fn reload_routing(&mut self, config: config::ProxyConfig) -> AirResult<()> {
        self.select_node(config).await
    }

    pub async fn discard_standby(&mut self) {
        #[cfg(windows)]
        if let Some(standby) = self.standby.take() {
            let _ = standby.session.stop().await;
        }
    }

    pub async fn reload_network(
        &mut self,
        config: config::ProxyConfig,
        network: crate::network::NetworkSettings,
    ) -> AirResult<()> {
        #[cfg(windows)]
        let directory = self.directory.clone();
        self.reload_network_with(config, network, |port, bypass| {
            #[cfg(windows)]
            {
                windows::reapply(&directory, port, bypass)
            }
            #[cfg(not(windows))]
            {
                let _ = (port, bypass);
                Ok(())
            }
        })
        .await
    }

    async fn reload_network_with<F>(
        &mut self,
        mut config: config::ProxyConfig,
        network: crate::network::NetworkSettings,
        mut apply_system_proxy: F,
    ) -> AirResult<()>
    where
        F: FnMut(u16, &[String]) -> AirResult<()>,
    {
        self.reap_exited().await?;
        let Some(active) = self.active.as_mut() else {
            self.discard_standby().await;
            return Ok(());
        };
        network.validate()?;
        let previous_network = active.network.clone();
        let port_or_bind_changed = previous_network.port_or_bind_changed(&network);
        let tun_changed = active.tun && previous_network.tun_settings_changed(&network);
        let system_proxy_bypass_changed =
            previous_network.system_proxy_bypass != network.system_proxy_bypass;
        let group_probe_changed = matches!(active.target, StartTarget::Group { .. })
            && (previous_network.probe_url != network.probe_url
                || previous_network.probe_status != network.probe_status);
        let core_changed = previous_network.core_settings_changed(&network) || group_probe_changed;

        #[cfg(not(windows))]
        let _ = &mut apply_system_proxy;
        if !port_or_bind_changed && !tun_changed && !core_changed {
            #[cfg(windows)]
            if active.system_proxy && system_proxy_bypass_changed {
                if let Err(error) = apply_system_proxy(active.port, &network.system_proxy_bypass) {
                    let _ = apply_system_proxy(active.port, &previous_network.system_proxy_bypass);
                    return Err(error);
                }
            }
            active.network = network;
            return Ok(());
        }

        config.apply_network(
            &network,
            active.tun,
            active.yaml["dns"]["fake-ip-range"].as_str(),
        )?;
        config.yaml["mode"] = serde_yaml::to_value(self.mode).map_err(|_| "出站模式无效")?;
        config.yaml["log-level"] = if cfg!(windows) { "error" } else { "silent" }.into();

        if port_or_bind_changed || tun_changed {
            #[cfg(windows)]
            let service = matches!(active.kernel, RuntimeKernel::Service(_));
            #[cfg(not(windows))]
            let service = false;
            #[cfg(windows)]
            if service {
                tun_service::validate(&config.yaml)?;
            }
            config.yaml["mixed-port"] = 0.into();
            let old_port = active.port;
            let old_yaml = active.yaml.clone();
            let requested_port = if port_or_bind_changed {
                network.mixed_port
            } else {
                Some(old_port)
            };
            if port_or_bind_changed {
                active._loopback = None;
            }
            #[cfg(windows)]
            if active.tun && matches!(active.kernel, RuntimeKernel::Local(_)) {
                let _ = active.kernel.set_tun(&active.network, false).await;
            }
            active.kernel.stop().await?;
            let mut proxy_touched = false;
            let launched: AirResult<(RuntimeKernel, u16)> = async {
                let (mut next_kernel, new_port) = active
                    .relaunch_with(
                        &self.directory,
                        config.yaml.clone(),
                        requested_port,
                        network.allow_lan,
                        service,
                    )
                    .await?;
                #[cfg(windows)]
                if active.system_proxy && (new_port != old_port || system_proxy_bypass_changed) {
                    proxy_touched = true;
                    if let Err(error) = apply_system_proxy(new_port, &network.system_proxy_bypass) {
                        if matches!(next_kernel, RuntimeKernel::Local(_))
                            && config.yaml["tun"]["enable"].as_bool() == Some(true)
                        {
                            let _ = next_kernel.set_tun(&network, false).await;
                        }
                        if let Err(stop_error) = next_kernel.stop().await {
                            return Err(format!("{error}。关闭切换后的代理失败 · {stop_error}"));
                        }
                        return Err(error);
                    }
                }
                Ok((next_kernel, new_port))
            }
            .await;
            match launched {
                Ok((kernel, new_port)) => {
                    config.yaml["mixed-port"] = new_port.into();
                    active.kernel = kernel;
                    active.yaml = config.yaml;
                    active.port = new_port;
                    active.network = network;
                    if port_or_bind_changed {
                        active._loopback = (active.network.mixed_port.is_none()
                            && new_port != loopback::PREFERRED_PORT)
                            .then(|| {
                                loopback::Forwarder::start(loopback::PREFERRED_PORT, new_port)
                            });
                    }
                    active.reset_telemetry();
                    #[cfg(windows)]
                    if tun_changed {
                        windows::flush_dns_cache();
                    }
                }
                Err(error) => {
                    let (restored, restored_port) = active
                        .relaunch_with(
                            &self.directory,
                            old_yaml,
                            Some(old_port),
                            previous_network.allow_lan,
                            service,
                        )
                        .await
                        .map_err(|restore| format!("{error}。无法恢复原代理 · {restore}"))?;
                    active.kernel = restored;
                    active.port = restored_port;
                    if port_or_bind_changed {
                        active._loopback = (previous_network.mixed_port.is_none()
                            && restored_port != loopback::PREFERRED_PORT)
                            .then(|| {
                                loopback::Forwarder::start(loopback::PREFERRED_PORT, restored_port)
                            });
                    }
                    #[cfg(windows)]
                    if active.system_proxy && (proxy_touched || restored_port != old_port) {
                        let _ = apply_system_proxy(
                            restored_port,
                            &previous_network.system_proxy_bypass,
                        );
                    }
                    active.reset_telemetry();
                    return Err(error);
                }
            }
            #[cfg(not(windows))]
            let _ = proxy_touched;
            return Ok(());
        }

        config.yaml["mixed-port"] = active.port.into();
        active.kernel.reload(&config.yaml).await?;
        if has_selectable_global(&config.yaml) {
            let result: AirResult<()> = async {
                let target = active.global.as_deref().ok_or("当前节点无效")?;
                active.kernel.select_global(target).await
            }
            .await;
            if let Err(error) = result {
                active.restore_yaml_and_global().await?;
                return Err(error);
            }
        }
        #[cfg(windows)]
        if active.system_proxy && system_proxy_bypass_changed {
            if let Err(error) = apply_system_proxy(active.port, &network.system_proxy_bypass) {
                let _ = apply_system_proxy(active.port, &previous_network.system_proxy_bypass);
                active
                    .restore_yaml_and_global()
                    .await
                    .map_err(|restore| format!("{error}。无法恢复原核心配置 · {restore}"))?;
                return Err(error);
            }
        }
        active.yaml = config.yaml;
        active.network = network;
        Ok(())
    }

    pub async fn sample_telemetry(runtime: &Mutex<Self>) {
        Self::sample_telemetry_with_visibility(runtime, false).await;
    }

    pub async fn sample_telemetry_with_visibility(runtime: &Mutex<Self>, _hidden: bool) {
        let (session_id, request, memory, _port, _client_map, _known_apps) = {
            let mut runtime = runtime.lock().await;
            let _ = runtime.reap_exited().await;
            let Some(active) = runtime.active.as_ref() else {
                return;
            };
            #[cfg(all(windows, feature = "desktop"))]
            let clients = active._loopback.as_ref().map(|forwarder| forwarder.clients.clone());
            #[cfg(all(windows, feature = "desktop"))]
            let known_apps = active
                .telemetry
                .as_ref()
                .filter(|_| _hidden)
                .into_iter()
                .flat_map(|s| &s.connections)
                .filter(|row| row.app_icon_key.is_some())
                .map(|row| (row.id.clone(), row.clone()))
                .collect();
            #[cfg(not(all(windows, feature = "desktop")))]
            let (clients, known_apps) = ((), ());
            (
                active.session_id.clone(),
                active.kernel.connections(),
                active.kernel.memory_bytes(),
                active.port,
                clients,
                known_apps,
            )
        };
        // Keep the control lock available while the kernel responds.
        let result = request.await;
        #[cfg(all(windows, feature = "desktop"))]
        let (result, applications) = match result {
            Ok(snapshot) => tokio::task::spawn_blocking(move || {
                let apps = windows_apps::sample(&snapshot, _client_map, _port, _known_apps);
                (Ok(snapshot), apps)
            })
            .await
            .unwrap_or_else(|_| (Err("无法读取连接来源".into()), Applications::default())),
            Err(error) => (Err(error), Applications::default()),
        };
        #[cfg(not(all(windows, feature = "desktop")))]
        let applications = Applications::default();
        let mut runtime = runtime.lock().await;
        let Some(active) = runtime
            .active
            .as_mut()
            .filter(|active| active.session_id == session_id)
        else {
            return;
        };
        match result {
            Ok(snapshot) => active.record_telemetry(snapshot, memory, applications),
            Err(_) => {
                if let Some(snapshot) = &mut active.telemetry {
                    snapshot.stale = true;
                }
            }
        }
    }

    pub async fn stop(&mut self) -> AirResult<()> {
        #[cfg(windows)]
        if let Some(standby) = self.standby.take() {
            // Dropping the service connection also discards a prepared kernel.
            let _ = standby.session.stop().await;
        }
        self.stop_active(false).await
    }

    pub async fn pause(&mut self) -> AirResult<()> {
        self.stop_active(true).await
    }

    async fn stop_active(&mut self, park: bool) -> AirResult<()> {
        #[cfg(not(windows))]
        let _ = park;
        let Some(active) = self.active.as_mut() else {
            return Ok(());
        };
        #[cfg(windows)]
        windows::restore(&self.directory)?;
        active.system_proxy = false;
        if active.kernel.running().await {
            #[cfg(windows)]
            if park && active.tun {
                if let RuntimeKernel::Service(session) = &active.kernel {
                    if session.park().await.is_ok() {
                        let session = session.clone();
                        let mut stopped = self.active.take().expect("active session was parked");
                        stopped.yaml["mixed-port"] = 0.into();
                        self.standby = Some(StandbyTun {
                            session, yaml: stopped.yaml, lease: stopped._lease,
                        });
                        return Ok(());
                    }
                }
            }
            #[cfg(windows)]
            if active.tun && matches!(active.kernel, RuntimeKernel::Local(_)) {
                let _ = active.kernel.set_tun(&active.network, false).await;
                windows::flush_dns_cache();
            }
            active.kernel.stop().await?;
        }
        self.active = None;
        Ok(())
    }

    pub async fn set_mode(&mut self, mode: Mode) -> AirResult<()> {
        if let Some(active) = self.active.as_mut() {
            if mode == Mode::Global && active.global.is_none() {
                return Err("全局模式需要一个可用的代理节点、分组或家宽链路".into());
            }
            active.kernel.set_mode(mode).await?;
            active.yaml["mode"] = serde_yaml::to_value(mode).map_err(|_| "出站模式无效")?;
            if self.mode != mode {
                let _ = active.kernel.close_all_connections().await;
            }
        }
        self.mode = mode;
        Ok(())
    }

    pub fn set_system_proxy(&mut self, enabled: bool) -> AirResult<()> {
        #[cfg(windows)]
        {
            let Some(active) = self.active.as_mut() else {
                self.system_proxy = enabled;
                return Ok(());
            };
            if enabled {
                if !windows::is_active(active.port)? {
                    windows::reapply(&self.directory, active.port, &active.network.system_proxy_bypass)?;
                }
            } else {
                windows::restore(&self.directory)?;
            }
            active.system_proxy = enabled;
            self.system_proxy = enabled;
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = enabled;
            Err("当前平台尚未接入系统代理".into())
        }
    }

    pub async fn set_tun(&mut self, enabled: bool) -> AirResult<()> {
        #[cfg(windows)]
        {
            let Some(active) = self.active.as_mut() else {
                if !enabled {
                    self.stop().await?;
                }
                self.tun = enabled;
                return Ok(());
            };
            if enabled == active.tun {
                return Ok(());
            }
            let tun = serde_yaml::to_value(active.network.tun(enabled)).map_err(|_| "虚拟网卡配置无效")?;
            let service = tun_uses_service(enabled)?;
            let pool = enabled.then(windows::free_tun_pool).transpose()?;
            let promote = service && matches!(active.kernel, RuntimeKernel::Local(_));
            if let Some(pool) = pool.filter(|pool| promote || Some(pool.as_str()) != active.yaml["dns"]["fake-ip-range"].as_str()) {
                let mut config = active.yaml.clone();
                config["dns"]["fake-ip-range"] = pool.into();
                config["tun"] = tun.clone();
                active.restart_with_config(&self.directory, config, service).await?;
            } else {
                active.kernel.set_tun(&active.network, enabled).await?;
                if let Err(error) = verify_tun(&active.kernel, enabled).await {
                    let _ = active.kernel.set_tun(&active.network, active.tun).await;
                    return Err(error);
                }
                if !enabled && matches!(active.kernel, RuntimeKernel::Local(_)) {
                    windows::flush_dns_cache();
                }
            }
            active.yaml["tun"] = tun;
            active.tun = enabled;
            self.tun = enabled;
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = enabled;
            Err("当前平台尚未接入虚拟网卡".into())
        }
    }
}

fn tun_service_ready() -> Option<bool> {
    #[cfg(windows)]
    return Some(tun_service::service_available(true));
    #[cfg(not(windows))]
    None
}

fn tun_uses_service(enabled: bool) -> AirResult<bool> {
    if !enabled {
        return Ok(false);
    }
    #[cfg(windows)]
    {
        if tun_service::persistent_service_available() {
            return Ok(true);
        }
        if windows::is_admin() {
            return Ok(false);
        }
        if tun_service::service_available(false) {
            return Ok(true);
        }
        Err("请先安装或更新虚拟网卡服务".into())
    }
    #[cfg(not(windows))]
    Err("当前平台尚未接入虚拟网卡".into())
}

#[cfg(windows)]
async fn verify_tun(kernel: &RuntimeKernel, enabled: bool) -> AirResult<()> {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        let state = kernel.tun_enabled().await?;
        if state == enabled && (!enabled || windows::adapter_active("Air-TUN")) {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(match (enabled, state) {
                (true, true) => "Mihomo 已启用 TUN，但 Air-TUN 网卡未连接",
                (true, false) => "等待 Mihomo 启动 Air-TUN 网卡超时",
                _ => "等待 Mihomo 关闭 TUN 会话超时",
            }.into());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

impl Active {
    #[cfg(windows)]
    async fn restart_with_config(&mut self, directory: &Path, config: serde_yaml::Value, service: bool) -> AirResult<()> {
        if service {
            tun_service::validate(&config)?;
        }
        let was_service = matches!(self.kernel, RuntimeKernel::Service(_));
        self.kernel.stop().await?;
        match self.relaunch(directory, config.clone(), service).await {
            Ok(kernel) => {
                self.kernel = kernel;
                self.yaml = config;
            }
            Err(error) => {
                self.kernel = self.relaunch(directory, self.yaml.clone(), was_service).await
                    .map_err(|restore| format!("{error}。无法恢复原代理 · {restore}"))?;
                self.reset_telemetry();
                return Err(error);
            }
        }
        self.reset_telemetry();
        Ok(())
    }

    #[cfg(windows)]
    async fn relaunch(&self, directory: &Path, config: serde_yaml::Value, service: bool) -> AirResult<RuntimeKernel> {
        let (kernel, _) = self.relaunch_with(directory, config, Some(self.port), self.network.allow_lan, service).await?;
        Ok(kernel)
    }

    async fn relaunch_with(
        &self,
        directory: &Path,
        config: serde_yaml::Value,
        requested_port: Option<u16>,
        allow_lan: bool,
        service: bool,
    ) -> AirResult<(RuntimeKernel, u16)> {
        #[cfg(windows)]
        let tun = config["tun"]["enable"].as_bool() == Some(true);
        let (mut kernel, port) = RuntimeKernel::start(&self.binary, directory, config, requested_port, allow_lan, service).await?;
        let ready: AirResult<()> = async {
            #[cfg(windows)]
            if tun {
                verify_tun(&kernel, true).await?;
            }
            if let Some(name) = &self.global {
                kernel.select_global(name).await?;
            }
            Ok(())
        }.await;
        if let Err(error) = ready {
            kernel.stop().await?;
            return Err(error);
        }
        Ok((kernel, port))
    }

    async fn restore_yaml_and_global(&self) -> AirResult<()> {
        self.kernel.reload(&self.yaml).await?;
        if has_selectable_global(&self.yaml) {
            if let Some(target) = &self.global {
                self.kernel.select_global(target).await?;
            }
        }
        Ok(())
    }

    fn reset_telemetry(&mut self) {
        self.last_traffic = None;
        self.traffic_baseline = (0, 0);
        self.telemetry = None;
        self.session_id = uuid::Uuid::new_v4().simple().to_string();
    }

    fn connection_path(&self, reported: &[String]) -> Vec<String> {
        // Mihomo reports the outer connection separately from its internal dialers.
        let mut seen: HashSet<_> = reported.iter().map(String::as_str).collect();
        let label = |name: &String| self.node_names.get(name).unwrap_or(name).clone();
        let mut path = Vec::new();
        for name in reported.iter().rev() {
            let offset = path.len();
            let mut current = name;
            while let Some(dialer) = self
                .dialers
                .get(current)
                .filter(|dialer| seen.insert(dialer.as_str()))
            {
                path.push(label(dialer));
                current = dialer;
            }
            path[offset..].reverse();
            path.push(label(name));
        }
        path
    }

    fn record_telemetry(
        &mut self,
        snapshot: ConnectionsSnapshot,
        memory: Option<u64>,
        mut applications: Applications,
    ) {
        let now = Instant::now();
        let (upload_rate, download_rate) = self.last_traffic.map_or((0, 0), |(time, up, down)| {
            let seconds = now.duration_since(time).as_secs_f64().max(0.05);
            let rate =
                |total: u64, last| (total.saturating_sub(last) as f64 / seconds).round() as u64;
            (
                rate(snapshot.upload_total, up),
                rate(snapshot.download_total, down),
            )
        });
        self.last_traffic = Some((now, snapshot.upload_total, snapshot.download_total));
        let mut active_connections = snapshot.connections.unwrap_or_default();
        active_connections.retain(|entry| !entry.metadata.internal());
        active_connections.sort_unstable_by(|a, b| {
            b.start.cmp(&a.start).then_with(|| a.id.cmp(&b.id))
        });
        let connections: Vec<Arc<ConnectionView>> = active_connections
            .into_iter()
            .map(|entry| {
                let meta_host = entry.metadata.host();
                let meta_dest_ip = entry.metadata.destination_ip();
                let meta_network = entry.metadata.network();
                let meta_process_name = entry.metadata.process_name();
                let meta_process_path = {
                    let p = entry.metadata.process_path.trim();
                    (!p.is_empty()).then(|| p.to_owned())
                };
                let app = applications.entries.remove(&entry.id).unwrap_or_else(|| Application {
                    name: entry.metadata.app(),
                    executable: None,
                    process_name: meta_process_name.clone(),
                    process_path: meta_process_path.clone(),
                    icon_key: None,
                });
                let target = entry.metadata.target();
                let path = self.connection_path(entry.chains.as_deref().unwrap_or_default());
                let rule = if entry.rule_payload.is_empty() {
                    entry.rule
                } else {
                    format!("{} · {}", entry.rule, entry.rule_payload)
                };
                Arc::new(ConnectionView {
                    closed_revision: 0,
                    id: entry.id,
                    app: app.name,
                    app_executable: app.executable,
                    app_icon_key: app.icon_key,
                    host: meta_host,
                    destination_ip: meta_dest_ip,
                    network: meta_network,
                    process_name: app.process_name.or(meta_process_name),
                    process_path: app.process_path.or(meta_process_path),
                    start: entry.start,
                    closed: false,
                    target,
                    rule,
                    path,
                    upload_bytes: entry.upload,
                    download_bytes: entry.download,
                })
            })
            .collect();

        let prior = self.telemetry.take();
        let revision = prior.as_ref().map_or(1, |s| s.revision + 1);
        let (mut logs, mut app_icons) = prior
            .map(|s| (s.connection_logs, s.app_icons))
            .unwrap_or_default();
        let active_ids: HashSet<_> = connections.iter().map(|row| row.id.as_str()).collect();
        // History is newest first. Only retained closed rows count towards the spare slots.
        logs.retain(|row| !active_ids.contains(row.id.as_str()));
        logs.truncate(500usize.saturating_sub(connections.len()));
        for row in &mut logs {
            if !row.closed {
                let row = Arc::make_mut(row);
                row.closed = true;
                row.closed_revision = revision;
            }
        }
        if !connections.is_empty() {
            logs.extend(connections.iter().cloned());
            logs.sort_unstable_by(|a, b| b.start.cmp(&a.start).then_with(|| b.id.cmp(&a.id)));
        }
        app_icons.extend(applications.icons);
        let used: HashSet<_> = logs
            .iter()
            .filter_map(|row| row.app_icon_key.as_ref())
            .collect();
        app_icons.retain(|key, _| used.contains(key));

        self.telemetry = Some(TelemetrySnapshot {
            revision,
            log_order: None,
            session_id: self.session_id.clone(),
            sampled_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            stale: false,
            traffic: TrafficSnapshot {
                upload_rate,
                download_rate,
                upload_total: snapshot.upload_total.saturating_sub(self.traffic_baseline.0),
                download_total: snapshot.download_total.saturating_sub(self.traffic_baseline.1),
            },
            memory_bytes: memory.or(snapshot.memory.filter(|bytes| *bytes > 0)),
            connections,
            connection_logs: logs,
            app_icons,
        });
    }
}

#[cfg(windows)]
impl Drop for Runtime {
    fn drop(&mut self) {
        if self.active.is_some() {
            let _ = windows::restore(&self.directory);
        }
    }
}

fn has_selectable_global(yaml: &serde_yaml::Value) -> bool {
    yaml["proxy-groups"]
        .as_sequence()
        .into_iter()
        .flatten()
        .any(|group| {
            group["name"] == "GLOBAL"
                && group["proxies"]
                    .as_sequence()
                    .is_some_and(|members| members.len() > 1)
        })
}

fn lease(directory: &Path) -> AirResult<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(directory.join("proxy-runtime.lock"))
        .map_err(|_| "无法打开 Air Proxy 代理进程锁")?;
    file.try_lock().map_err(|_| "另一个 Air Proxy 窗口正在使用代理")?;
    Ok(file)
}

#[cfg(all(test, windows, feature = "desktop"))]
mod tests {
    use super::*;
    use crate::{
        network::NetworkSettings,
        routing::{RoutingConfig, RoutingFile},
    };
    use std::net::{Ipv4Addr, TcpListener, UdpSocket};
    use tokio::net::TcpStream;

    fn reserve_port(start: u16) -> (TcpListener, UdpSocket, u16) {
        (start..32000)
            .find_map(|port| {
                let address = (Ipv4Addr::LOCALHOST, port);
                let tcp = TcpListener::bind(address).ok()?;
                let udp = UdpSocket::bind(address).ok()?;
                Some((tcp, udp, port))
            })
            .expect("available local TCP and UDP port for test proxy")
    }

    #[tokio::test]
    #[ignore = "requires the bundled Windows Mihomo executable"]
    async fn reload_network_rolls_back_kernel_port_when_system_proxy_update_fails() {
        let core =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.cache/air/windows-x64/mihomo.exe");
        let temp = tempfile::tempdir().unwrap();
        let directory = temp.path();

        let (old_tcp, old_udp, old_port) = reserve_port(22000);
        let (new_tcp, new_udp, new_port) = reserve_port(old_port + 1);
        let old_network = NetworkSettings {
            mixed_port: Some(old_port),
            ..NetworkSettings::default()
        };
        let preferences = RoutingFile::new(directory);
        preferences.ensure_exists().unwrap();
        preferences
            .save_network(&old_network, &preferences.network().unwrap().revision)
            .unwrap();

        let initial_config =
            compile(Mode::Direct, &RoutingConfig::default(), &[], None, &StartTarget::Routing)
                .unwrap();
        let mut runtime = Runtime::new(directory.to_owned());
        runtime.set_mode(Mode::Direct).await.unwrap();
        drop((old_tcp, old_udp));
        runtime.start(&core, initial_config).await.unwrap();

        // Simulate active system proxy without modifying host Windows settings.
        runtime.system_proxy = true;
        runtime.active.as_mut().unwrap().system_proxy = true;
        assert_eq!(runtime.subscription_proxy_port(), Some(old_port));
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, old_port)).await.is_ok());

        let new_network = NetworkSettings {
            mixed_port: Some(new_port),
            system_proxy_bypass: vec!["<local>".to_owned(), "example.internal".to_owned()],
            ..NetworkSettings::default()
        };
        let new_config =
            compile(Mode::Direct, &RoutingConfig::default(), &[], None, &StartTarget::Routing)
                .unwrap();
        let mut applied_calls = Vec::new();
        drop((new_tcp, new_udp));
        let error = runtime
            .reload_network_with(new_config, new_network.clone(), |port, bypass| {
                applied_calls.push((port, bypass.to_vec()));
                if port == new_port {
                    Err("simulated system proxy failure".into())
                } else {
                    Ok(())
                }
            })
            .await
            .unwrap_err();

        assert!(error.contains("simulated system proxy failure"));
        assert_eq!(
            applied_calls,
            vec![
                (new_port, new_network.system_proxy_bypass.clone()),
                (old_port, old_network.system_proxy_bypass.clone()),
            ]
        );
        assert_eq!(runtime.subscription_proxy_port(), Some(old_port));
        assert_eq!(runtime.active_network(), Some(&old_network));
        assert_eq!(
            runtime.active.as_ref().unwrap().yaml["mixed-port"].as_u64(),
            Some(u64::from(old_port))
        );
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, old_port)).await.is_ok());
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, new_port)).await.is_err());

        runtime.stop().await.unwrap();
    }
}
