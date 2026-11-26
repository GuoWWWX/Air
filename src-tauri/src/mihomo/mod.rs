pub(crate) mod geodata;

use crate::{
    network::NetworkSettings,
    monitoring::{Probe, PROBE_TIMEOUT, TIMEOUT},
    subscriptions::ProbeTarget,
    AirResult,
};
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use std::{
    net::{IpAddr, Ipv4Addr, TcpListener, UdpSocket},
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};
use tempfile::TempDir;
use tokio::process::{Child, Command};
use uuid::Uuid;

pub struct Kernel {
    probe_url: String,
    probe_status: u16,
    child: Child,
    _workspace: TempDir,
    api: Url,
    secret: String,
    client: Client,
    mixed: Option<(u16, String)>,
    #[cfg(windows)]
    _job: std::os::windows::io::OwnedHandle,
    #[cfg(windows)]
    tun_error: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    #[cfg(windows)]
    lan_discovery: Option<tokio::sync::watch::Sender<bool>>,
}

struct MixedPortReservation {
    port: u16,
    _tcp: TcpListener,
    _udp: UdpSocket,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProbeRoute {
    pub interface: String,
    pub luid: u64,
    pub gateway: IpAddr,
    pub network_id: Uuid,
}

impl Kernel {
    pub async fn start(
        binary: &Path,
        config_dir: &Path,
        app_dir: &Path,
        nodes: Vec<Value>,
        hosts: &Mapping,
        exit: Option<&str>,
    ) -> AirResult<Self> {
        let network = crate::routing::RoutingFile::new(config_dir).network()?.settings;
        if exit.is_none() && !nodes.is_empty() {
            return Self::start_probes(binary, app_dir, nodes, hosts, &network, Self::probe_interface().as_deref()).await;
        }
        Self::start_diagnostic(binary, app_dir, nodes, hosts, exit, &network).await
    }

    pub async fn start_diagnostic(binary: &Path, app_dir: &Path, nodes: Vec<Value>, hosts: &Mapping, exit: Option<&str>, network: &NetworkSettings) -> AirResult<Self> {
        Self::launch_diagnostic(binary, app_dir, nodes, hosts, exit, network, None).await
    }

    pub fn probe_route() -> Option<ProbeRoute> {
        #[cfg(windows)]
        { crate::proxy::windows::probe_route() }
        #[cfg(not(windows))]
        { None }
    }

    pub fn probe_interface() -> Option<String> {
        Self::probe_route().map(|route| route.interface)
    }

    pub fn process_id(&self) -> Option<u32> {
        self.child.id()
    }

    pub async fn is_healthy(&self) -> bool {
        let Ok(url) = self.api.join("version") else {
            return false;
        };
        self.client
            .get(url)
            .bearer_auth(&self.secret)
            .timeout(Duration::from_millis(500))
            .send()
            .await
            .is_ok_and(|response| response.status().is_success())
    }

    pub async fn start_probes(binary: &Path, app_dir: &Path, nodes: Vec<Value>, hosts: &Mapping, network: &NetworkSettings, interface: Option<&str>) -> AirResult<Self> {
        Self::launch_diagnostic(binary, app_dir, nodes, hosts, None, network, interface).await
    }

    pub(crate) async fn start_subscription(binary: &Path, app_dir: &Path, nodes: Vec<Value>, hosts: &Mapping, network: &NetworkSettings) -> AirResult<Self> {
        Self::launch_diagnostic(binary, app_dir, nodes, hosts, Some("GLOBAL"), network, Self::probe_interface().as_deref()).await
    }

    async fn launch_diagnostic(binary: &Path, app_dir: &Path, nodes: Vec<Value>, hosts: &Mapping, exit: Option<&str>, network: &NetworkSettings, interface: Option<&str>) -> AirResult<Self> {
        network.validate()?;
        let mixed = exit.map(|_| reserve_mixed_port(None, false)).transpose()?;
        let password = Uuid::new_v4().simple().to_string();
        let mut config = serde_yaml::to_value(serde_json::json!({
            "mode": "rule", "tun": {"enable": false},
            "unified-delay": true,
            "rules": [format!("MATCH,{}", exit.unwrap_or("REJECT"))],
        }))
        .map_err(|_| "无法生成内核诊断配置")?;
        config["proxies"] = Value::Sequence(nodes);
        if !hosts.is_empty() {
            config["hosts"] = Value::Mapping(hosts.clone());
        }
        if let Some(interface) = interface {
            config["interface-name"] = interface.into();
        }
        network.apply_dns(&mut config)?;
        // An isolated probe has no copy of the user's traffic rules or outbound groups.
        config["dns"]["respect-rules"] = false.into();
        config["dns"]["enhanced-mode"] = "redir-host".into();
        if let Some(dns) = config["dns"].as_mapping_mut() {
            dns.remove("fake-ip-filter");
        }
        config["allow-lan"] = false.into();
        config["bind-address"] = "127.0.0.1".into();
        if let Some(reservation) = &mixed {
            config["mixed-port"] = reservation.port.into();
            config["authentication"] = Value::Sequence(vec![format!("air:{password}").into()]);
        }
        let mixed_info = mixed.as_ref().map(|reservation| (reservation.port, password));
        let mut kernel = Self::launch(binary, app_dir, config, mixed, mixed_info, "probe-").await?;
        // Diagnostic cores use their in-memory configuration after the controller is ready.
        let _ = std::fs::remove_file(kernel._workspace.path().join("config.yaml"));
        kernel.probe_url.clone_from(&network.probe_url);
        kernel.probe_status = network.probe_status;
        Ok(kernel)
    }

    pub(crate) async fn start_proxy(
        binary: &Path,
        app_dir: &Path,
        mut config: Value,
        requested_port: Option<u16>,
        allow_lan: bool,
    ) -> AirResult<(Self, u16)> {
        let reservation = reserve_mixed_port(requested_port, allow_lan)?;
        let port = reservation.port;
        config["mixed-port"] = port.into();
        #[cfg(windows)]
        let tun_enabled = config["tun"]["enable"].as_bool().unwrap_or(false);
        let mut kernel = Self::launch(
            binary,
            app_dir,
            config,
            Some(reservation),
            None,
            "runtime-",
        )
        .await?;
        if let Err(error) = kernel.wait_for_proxy_port(port).await {
            let _ = kernel.stop().await;
            return Err(error);
        }
        #[cfg(windows)]
        kernel.monitor_tun_lan_discovery(tun_enabled);
        Ok((kernel, port))
    }

    #[cfg(windows)]
    pub(crate) async fn prepare_tun(binary: &Path, app_dir: &Path, mut config: Value) -> AirResult<Self> {
        config["mixed-port"] = 0.into();
        config["allow-lan"] = false.into();
        config["bind-address"] = "127.0.0.1".into();
        config["tun"]["enable"] = false.into();
        Self::launch(binary, app_dir, config, None, None, "runtime-").await
    }

    #[cfg(windows)]
    pub(crate) async fn activate_tun(&mut self, settings: &NetworkSettings, requested_port: Option<u16>) -> AirResult<u16> {
        self.activate_listeners(requested_port, settings.allow_lan, settings.tun(true)).await
    }

    #[cfg(windows)]
    async fn activate_listeners(&mut self, requested_port: Option<u16>, allow_lan: bool, tun: serde_json::Value) -> AirResult<u16> {
        let reservation = reserve_mixed_port(requested_port, allow_lan)?;
        let port = reservation.port;
        drop(reservation);
        self.patch_config(&serde_json::json!({
            "mixed-port": port,
            "allow-lan": allow_lan,
            "bind-address": if allow_lan { "0.0.0.0" } else { "127.0.0.1" },
            "tun": tun,
        })).await?;
        if self.config().await?["mixed-port"].as_u64() != Some(u64::from(port)) {
            return Err(mixed_port_unavailable(port));
        }
        self.wait_for_proxy_port(port).await?;
        self.monitor_tun_lan_discovery(tun["enable"].as_bool() == Some(true));
        Ok(port)
    }

    #[cfg(windows)]
    pub(crate) async fn park_tun(&mut self) -> AirResult<()> {
        self.patch_config(&serde_json::json!({ "mixed-port": 0, "tun": { "enable": false } })).await?;
        let config = self.config().await?;
        if config["mixed-port"].as_u64() != Some(0) || config["tun"]["enable"].as_bool() != Some(false) {
            return Err("Mihomo 未关闭代理监听".into());
        }
        self.lan_discovery.take();
        self.close_all_connections().await
    }

    #[cfg(windows)]
    fn monitor_tun_lan_discovery(&mut self, enabled: bool) {
        if crate::proxy::windows::is_admin() {
            self.lan_discovery = Some(crate::proxy::lan_discovery::monitor(enabled));
        }
    }

    async fn wait_for_proxy_port(&mut self, port: u16) -> AirResult<()> {
        // The control API can start responding before the mixed listener is ready.
        let ready = tokio::time::timeout(Duration::from_secs(3), async {
            while self.running() {
                if tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port))
                    .await
                    .is_ok()
                {
                    return true;
                }
                tokio::time::sleep(Duration::from_millis(40)).await;
            }
            false
        })
        .await;
        if !matches!(ready, Ok(true)) {
            return Err("内核未能打开本地代理端口".into());
        }
        Ok(())
    }

    async fn launch(
        binary: &Path,
        app_dir: &Path,
        mut config: Value,
        mixed_reservation: Option<MixedPortReservation>,
        mixed: Option<(u16, String)>,
        prefix: &str,
    ) -> AirResult<Self> {
        if !binary.is_absolute() || !binary.is_file() {
            return Err("请选择本机 mihomo.exe 的绝对路径".into());
        }
        let workspace = tempfile::Builder::new()
            .prefix(prefix)
            .tempdir_in(app_dir)
            .map_err(|_| "无法创建内核工作目录")?;
        let missing_geodata = geodata::stage(&config, workspace.path())?;
        let (listener, port) = reserve_port()?;
        let secret = Uuid::new_v4().simple().to_string();
        let address = format!("127.0.0.1:{port}");
        if config["ipv6"].is_null() {
            config["ipv6"] = false.into();
        }
        config["external-controller"] = address.as_str().into();
        config["secret"] = secret.as_str().into();
        let runtime_log = cfg!(windows) && prefix == "runtime-";
        config["log-level"] = if runtime_log { "error" } else { "silent" }.into();
        let file = workspace.path().join("config.yaml");
        let contents = serde_yaml::to_string(&config).map_err(|_| "无法生成内核配置")?;
        std::fs::write(&file, contents).map_err(|_| "无法写入内核配置")?;
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| "无法初始化内核控制接口")?;
        let api = Url::parse(&format!("http://{address}/")).map_err(|_| "内核控制地址无效")?;
        drop(listener);
        drop(mixed_reservation);
        let mut command = Command::new(binary);
        command
            .current_dir(workspace.path())
            .env_remove("SAFE_PATHS")
            .env_remove("ALLOW_UNSAFE_PATH")
            .arg("-d")
            .arg(workspace.path())
            .arg("-f")
            .arg(file)
            .stdin(Stdio::null())
            .stdout(if runtime_log { Stdio::piped() } else { Stdio::null() })
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let child = command.spawn().map_err(|_| "无法启动 Mihomo 内核")?;
        #[cfg(windows)]
        let (mut child, tun_error) = {
            use tokio::io::{AsyncBufReadExt, BufReader};
            let mut child = child;
            let latest = std::sync::Arc::new(std::sync::Mutex::new(None));
            if let Some(stdout) = child.stdout.take() {
                let result = latest.clone();
                tokio::spawn(async move {
                    let mut lines = BufReader::new(stdout).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        if let Some((_, detail)) = line.split_once("Start TUN listening error: ") {
                            let detail = detail.trim().trim_end_matches('"').chars().take(512).collect();
                            *result.lock().unwrap() = Some(detail);
                        }
                    }
                });
            }
            (child, latest)
        };
        #[cfg(windows)]
        let job = match crate::proxy::windows::own_process(child.raw_handle().ok_or("无法读取 Mihomo 进程")?) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill().await;
                return Err(error);
            }
        };
        let mut kernel = Self {
            probe_url: NetworkSettings::default().probe_url,
            probe_status: 204,
            child,
            _workspace: workspace,
            api,
            secret,
            client,
            mixed,
            #[cfg(windows)]
            _job: job,
            #[cfg(windows)]
            tun_error,
            #[cfg(windows)]
            lan_discovery: None,
        };
        let version = kernel.api.join("version").map_err(|_| "内核控制地址无效")?;
        let ready = tokio::time::timeout(Duration::from_secs(6), async {
            loop {
                if matches!(kernel.child.try_wait(), Ok(Some(_)) | Err(_)) {
                    return Err(
                        "Mihomo 内核启动失败，请检查内核版本、节点协议和分流配置".to_owned()
                    );
                }
                if kernel
                    .client
                    .get(version.clone())
                    .bearer_auth(&kernel.secret)
                    .timeout(Duration::from_millis(250))
                    .send()
                    .await
                    .is_ok_and(|response| response.status().is_success())
                {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_millis(75)).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            Err(if missing_geodata {
                "等待 Mihomo 地理规则库下载超时，请使用包含离线规则库的 Air Proxy 安装包"
            } else {
                "Mihomo 的本地控制接口未在启动时限内就绪"
            }.into())
        });
        if let Err(error) = ready {
            let _ = kernel.stop().await;
            return Err(error);
        }
        Ok(kernel)
    }

    pub(crate) fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    #[cfg(windows)]
    pub(crate) fn process_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        self.child.raw_handle()
    }

    #[cfg(windows)]
    pub(crate) async fn wait_for_exit(&mut self) {
        let _ = self.child.wait().await;
    }

    pub async fn stop(&mut self) -> AirResult<()> {
        self.child
            .kill()
            .await
            .map_err(|_| "无法停止 Mihomo 内核".to_owned())?;
        #[cfg(windows)]
        self.lan_discovery.take();
        Ok(())
    }

    pub(crate) async fn patch_config(&self, value: &serde_json::Value) -> AirResult<()> {
        #[cfg(windows)]
        if value.get("tun").is_some() { self.tun_error.lock().unwrap().take(); }
        self.control(reqwest::Method::PATCH, "configs", value).await?;
        #[cfg(windows)]
        if let (Some(routes), Some(enabled)) = (&self.lan_discovery, value["tun"]["enable"].as_bool()) {
            routes.send_replace(enabled);
        }
        Ok(())
    }

    pub(crate) async fn reload_config(&self, config: &Value) -> AirResult<()> {
        geodata::stage(config, self._workspace.path())?;
        #[cfg(windows)]
        self.tun_error.lock().unwrap().take();
        let payload = serde_yaml::to_string(config).map_err(|_| "无法生成内核配置")?;
        self.control(
            reqwest::Method::PUT,
            "configs",
            &serde_json::json!({ "payload": payload }),
        )
        .await?;
        #[cfg(windows)]
        if let Some(routes) = &self.lan_discovery {
            routes.send_replace(config["tun"]["enable"].as_bool().unwrap_or(false));
        }
        Ok(())
    }

    pub(crate) async fn select_global(&self, name: &str) -> AirResult<()> {
        self.control(
            reqwest::Method::PUT,
            "proxies/GLOBAL",
            &serde_json::json!({ "name": name }),
        )
        .await
    }

    pub(crate) async fn close_connection(&self, id: &str) -> AirResult<()> {
        let mut url = self.api.join("connections").map_err(|_| "内核控制地址无效")?;
        url.path_segments_mut()
            .map_err(|_| "内核控制地址无效")?
            .push(id);
        let response = self
            .client
            .delete(url)
            .bearer_auth(&self.secret)
            .send()
            .await
            .map_err(|_| "Mihomo 控制接口无响应")?;
        if response.status().is_success() || response.status().as_u16() == 404 {
            Ok(())
        } else {
            Err(format!("关闭连接失败（HTTP {}）", response.status().as_u16()))
        }
    }

    pub(crate) async fn close_all_connections(&self) -> AirResult<()> {
        let url = self.api.join("connections").map_err(|_| "内核控制地址无效")?;
        let response = self
            .client
            .delete(url)
            .bearer_auth(&self.secret)
            .send()
            .await
            .map_err(|_| "Mihomo 控制接口无响应")?;
        if response.status().is_success() || response.status().as_u16() == 404 {
            Ok(())
        } else {
            Err(format!("关闭全部连接失败（HTTP {}）", response.status().as_u16()))
        }
    }

    pub(crate) async fn config(&self) -> AirResult<serde_json::Value> {
        self.client
            .get(self.api.join("configs").map_err(|_| "内核控制地址无效")?)
            .bearer_auth(&self.secret)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|_| "无法读取 Mihomo 运行状态")?
            .json()
            .await
            .map_err(|_| "Mihomo 返回了无效的运行状态".into())
    }

    async fn control(
        &self,
        method: reqwest::Method,
        path: &str,
        value: &serde_json::Value,
    ) -> AirResult<()> {
        let response = self
            .client
            .request(method, self.api.join(path).map_err(|_| "内核控制地址无效")?)
            .bearer_auth(&self.secret)
            .json(value)
            .send()
            .await
            .map_err(|_| "Mihomo 控制接口无响应")?;
        if response.status().is_success() {
            Ok(())
        } else {
            Err(format!(
                "Mihomo 拒绝修改配置（HTTP {}）",
                response.status().as_u16()
            ))
        }
    }

    #[cfg(windows)]
    pub(crate) async fn tun_enabled(&self) -> AirResult<bool> {
        let config = self.config().await?;
        let tun = &config["tun"];
        let enabled = tun["enable"]
            .as_bool()
            .ok_or("当前 Mihomo 版本无法报告虚拟网卡状态")?;
        if enabled && tun["device"] == "Air-TUN" && tun["auto-route"] == true
            && tun["inet6-address"].as_array().is_none_or(Vec::is_empty)
            && NetworkSettings::tun_ipv6_supported()
        {
            return Err("当前内核未接管 IPv6，请使用随附的 Mihomo 内核或更新虚拟网卡服务".into());
        }
        if !enabled {
            if let Some(error) = self.tun_error.lock().unwrap().as_ref() {
                return Err(format!("Mihomo 无法启动虚拟网卡：{error}"));
            }
        }
        Ok(enabled)
    }

    pub async fn delay(&self, name: &str) -> Probe {
        self.delay_for(name, None).await
    }

    pub async fn delay_for(&self, name: &str, source_target: Option<&ProbeTarget>) -> Probe {
        let default = NetworkSettings::default();
        let expected = self.probe_status.to_string();
        if self.probe_url != default.probe_url || self.probe_status != default.probe_status {
            return self.delay_at(name, &self.probe_url, &expected, PROBE_TIMEOUT).await;
        }
        let (target, status) = source_target.map_or((self.probe_url.as_str(), expected.as_str()), |target| {
            (target.url.as_str(), target.expected.as_str())
        });
        if status != "204" || !target.ends_with("/generate_204") {
            return self.delay_at(name, target, status, PROBE_TIMEOUT).await;
        }
        let cloudflare = "https://cp.cloudflare.com/generate_204";
        let alternate = if target == cloudflare { default.probe_url.as_str() } else { cloudflare };
        probe_with_fallback(self.delay_at(name, target, status, PROBE_TIMEOUT),
            |remaining| self.delay_at(name, alternate, "204", remaining)).await
    }

    async fn delay_at(&self, name: &str, target: &str, expected: &str, timeout: Duration) -> Probe {
        let Ok(mut url) = self.api.join(&format!("proxies/{name}/delay")) else {
            return Probe::Unreachable;
        };
        url.query_pairs_mut()
            .append_pair("url", target)
            .append_pair("timeout", &timeout.as_millis().to_string())
            .append_pair("expected", expected);
        let response = self
            .client
            .get(url)
            .bearer_auth(&self.secret)
            .timeout(timeout + Duration::from_secs(1))
            .send()
            .await;
        match response {
            Ok(response) if response.status().is_success() => {
                #[derive(Deserialize)]
                struct Delay {
                    delay: u64,
                }
                response
                    .json::<Delay>()
                    .await
                    .map_or(Probe::Unreachable, |r| Probe::Available(r.delay))
            }
            Ok(response) if matches!(response.status().as_u16(), 408 | 504) => Probe::Timeout,
            Err(error) if error.is_timeout() => Probe::Timeout,
            _ => Probe::Unreachable,
        }
    }

    pub async fn query_dns(&self, domain: &str) -> AirResult<crate::network::DnsResult> {
        let mut url = self.api.join("dns/query").map_err(|_| "内核控制地址无效")?;
        url.query_pairs_mut().append_pair("name", domain).append_pair("type", "A");
        let start = Instant::now();
        let response = self.client.get(url).bearer_auth(&self.secret).timeout(Duration::from_secs(12))
            .send().await.map_err(|err| if err.is_timeout() { "DNS 查询超时" } else { "无法连接诊断内核" })?;
        if !response.status().is_success() {
            let detail = response.json::<serde_json::Value>().await.unwrap_or_default();
            let msg = detail["message"].as_str().unwrap_or_default().to_ascii_lowercase();
            if msg.contains("deadline exceeded") || msg.contains("timeout") {
                return Err("上游 DNS 查询超时".into());
            }
            if msg.contains("refused") { return Err("上游 DNS 拒绝连接".into()); }
            if msg.contains("x509") || msg.contains("certificate") { return Err("上游 DNS 证书验证失败".into()); }
            return Err("上游 DNS 查询失败，请检查地址、证书或网络连通性".into());
        }
        let payload: serde_json::Value = response.json().await.map_err(|_| "无法读取 DNS 测试结果")?;
        match payload["Status"].as_u64() {
            Some(0) => (),
            Some(3) => return Err("域名不存在（NXDOMAIN）".into()),
            _ => return Err("DNS 服务器未能完成解析".into()),
        }
        let addresses: Vec<IpAddr> = payload["Answer"].as_array().into_iter().flatten()
            .filter(|rr| rr["type"].as_u64() == Some(1))
            .filter_map(|rr| rr["data"].as_str()?.trim().parse().ok()).collect();
        if addresses.is_empty() { return Err("DNS 已响应，该域名没有 IPv4 地址".into()); }
        Ok(crate::network::DnsResult { addresses, elapsed_ms: start.elapsed().as_millis() as u64 })
    }

    pub(crate) fn diagnostic_proxy(&self) -> AirResult<reqwest::Proxy> {
        let (port, password) = self.mixed.as_ref().ok_or("当前诊断内核没有整链入口")?;
        Ok(reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
            .map_err(|_| "无法配置整链探测入口")?
            .basic_auth("air", password))
    }

    pub async fn exit_ip(&self) -> AirResult<(IpAddr, u64)> {
        let client = Client::builder()
            .no_proxy()
            .proxy(self.diagnostic_proxy()?)
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| "无法初始化整链探测")?;
        let start = Instant::now();
        let ip = crate::proxy::exit::observed_ip(&client).await?;
        Ok((ip, start.elapsed().as_millis() as u64))
    }

    pub(crate) fn connections_request(&self) -> reqwest::RequestBuilder {
        self.client
            .get(self.api.as_str().to_owned() + "connections")
            .bearer_auth(&self.secret)
            .timeout(Duration::from_millis(600))
    }

    pub(crate) async fn connections(
        request: reqwest::RequestBuilder,
    ) -> AirResult<ConnectionsSnapshot> {
        request
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|_| "无法读取 Mihomo 连接状态")?
            .json()
            .await
            .map_err(|_| "Mihomo 返回了无效的连接状态".into())
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConnectionsSnapshot {
    pub upload_total: u64,
    pub download_total: u64,
    pub memory: Option<u64>,
    pub connections: Option<Vec<Connection>>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Connection {
    pub id: String,
    #[serde(default)]
    pub metadata: ConnectionMetadata,
    pub upload: u64,
    pub download: u64,
    pub chains: Option<Vec<String>>,
    #[serde(default)]
    pub start: String,
    #[serde(default)]
    pub rule: String,
    #[serde(default)]
    pub rule_payload: String,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ConnectionMetadata {
    #[serde(rename = "type")]
    inbound_type: String,
    network: String,
    #[cfg(all(windows, feature = "desktop"))]
    #[serde(rename = "sourceIP")]
    source_ip: String,
    #[cfg(all(windows, feature = "desktop"))]
    source_port: Option<serde_json::Value>,
    #[cfg(all(windows, feature = "desktop"))]
    inbound_port: Option<serde_json::Value>,
    host: String,
    #[serde(rename = "destinationIP")]
    destination_ip: Option<String>,
    destination_port: Option<serde_json::Value>,
    process: String,
    pub process_path: String,
}

impl ConnectionMetadata {
    pub fn internal(&self) -> bool {
        self.inbound_type.eq_ignore_ascii_case("inner")
    }

    pub fn app(&self) -> String {
        [&self.process, &self.process_path]
            .into_iter()
            .filter_map(|path| path.rsplit(['/', '\\']).next())
            .find(|name| !name.is_empty())
            .unwrap_or("未知应用")
            .to_owned()
    }

    pub fn host(&self) -> Option<String> {
        let host = self.host.trim();
        (!host.is_empty()).then(|| host.to_owned())
    }

    pub fn destination_ip(&self) -> Option<String> {
        self.destination_ip
            .as_deref()
            .map(str::trim)
            .filter(|ip| !ip.is_empty())
            .map(str::to_owned)
    }

    pub fn network(&self) -> Option<String> {
        let net = self.network.trim();
        (!net.is_empty()).then(|| net.to_owned())
    }

    pub fn process_name(&self) -> Option<String> {
        [&self.process, &self.process_path]
            .into_iter()
            .filter_map(|path| path.rsplit(['/', '\\']).next())
            .map(str::trim)
            .find(|name| !name.is_empty())
            .map(str::to_owned)
    }

    #[cfg(all(windows, feature = "desktop"))]
    pub fn reported_process_paths(&self) -> [&str; 2] {
        [&self.process_path, &self.process]
    }

    #[cfg(all(windows, feature = "desktop"))]
    pub fn local_proxy_peer(&self, mixed_port: u16) -> Option<std::net::SocketAddrV4> {
        if self.network != "tcp" || json_port(&self.inbound_port) != Some(mixed_port) {
            return None;
        }
        let ip = match self.source_ip.parse::<std::net::IpAddr>().ok()? {
            std::net::IpAddr::V4(ip) => ip,
            std::net::IpAddr::V6(ip) => ip.to_ipv4_mapped()?,
        };
        let port = json_port(&self.source_port)?;
        (ip.is_loopback() && port != 0).then_some(std::net::SocketAddrV4::new(ip, port))
    }

    pub fn target(&self) -> String {
        let host = if self.host.is_empty() {
            self.destination_ip
                .as_deref()
                .filter(|ip| !ip.is_empty())
                .unwrap_or("未知目标")
        } else {
            &self.host
        };
        let port = json_port(&self.destination_port);
        match port.filter(|port| *port != 0) {
            Some(port) if host.parse::<std::net::Ipv6Addr>().is_ok() => format!("[{host}]:{port}"),
            Some(port) => format!("{host}:{port}"),
            None => host.to_owned(),
        }
    }
}

fn json_port(port: &Option<serde_json::Value>) -> Option<u16> {
    match port {
        Some(serde_json::Value::Number(port)) => port.as_u64().and_then(|port| port.try_into().ok()),
        Some(serde_json::Value::String(port)) => port.parse().ok(),
        _ => None,
    }
}

impl Drop for Kernel {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

async fn probe_with_fallback<F: std::future::Future<Output = Probe>>(
    primary: impl std::future::Future<Output = Probe>,
    fallback: impl FnOnce(Duration) -> F,
) -> Probe {
    // Mihomo keeps a URL test running even if its controller client disconnects.
    let started = tokio::time::Instant::now();
    let primary = primary.await;
    if matches!(primary, Probe::Available(_)) { return primary; }
    let remaining = (TIMEOUT - Duration::from_secs(1)).saturating_sub(started.elapsed()).min(PROBE_TIMEOUT);
    if remaining.as_millis() == 0 { return Probe::Timeout; }
    match fallback(remaining).await {
        Probe::Unreachable if primary == Probe::Timeout => Probe::Timeout,
        result => result,
    }
}

#[cfg(test)]
mod probe_timing_tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn fallback_starts_on_failure_and_uses_only_remaining_time() {
        let ok = Probe::Available(40);
        let one = probe_with_fallback(async { ok.clone() }, |_| async { panic!("unnecessary fallback") }).await;
        assert_eq!(one, ok);
        for primary_time in [Duration::from_millis(20), PROBE_TIMEOUT] {
            let start = tokio::time::Instant::now();
            let result = probe_with_fallback(async {
                tokio::time::sleep(primary_time).await;
                Probe::Timeout
            }, |budget| async move {
                assert_eq!(start.elapsed(), primary_time);
                assert_eq!(budget, PROBE_TIMEOUT.min(TIMEOUT - Duration::from_secs(1) - primary_time));
                Probe::Unreachable
            }).await;
            assert_eq!(result, Probe::Timeout);
        }
    }
}

#[cfg(all(test, windows))]
mod standby_tests {
    use super::*;

    #[tokio::test]
    #[ignore = "requires the bundled Windows Mihomo executable"]
    async fn ipv6_capture_survives_cold_start_and_reload_while_literal_access_follows_the_switch() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let binary = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.cache/air/windows-x64/mihomo.exe");
        let workspace = tempfile::tempdir().unwrap();
        let upstream = tokio::net::TcpListener::bind((std::net::Ipv6Addr::LOCALHOST, 0)).await.unwrap();
        let target = format!("http://{}/", upstream.local_addr().unwrap());
        let echo = tokio::spawn(async move {
            while let Ok((mut stream, _)) = upstream.accept().await {
                let mut request = [0; 1024];
                if stream.read(&mut request).await.is_ok_and(|n| n > 0) {
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\nConnection: close\r\n\r\nv6-ack").await;
                }
            }
        });
        let capture = "fdfe:dcba:9876::1/126";
        let mut config = serde_yaml::to_value(serde_json::json!({
            "mode": "rule", "ipv6": false,
            "tun": { "device": "Air-TUN", "enable": false, "inet6-address": [capture] },
            "rules": ["MATCH,DIRECT"]
        })).unwrap();
        let (mut kernel, port) = Kernel::start_proxy(&binary, workspace.path(), config.clone(), None, false).await.unwrap();
        let client = Client::builder().proxy(reqwest::Proxy::http(format!("http://127.0.0.1:{port}")).unwrap())
            .timeout(Duration::from_secs(3)).pool_max_idle_per_host(0).build().unwrap();
        for enabled in [false, true, false] {
            if config["ipv6"].as_bool() != Some(enabled) {
                config["ipv6"] = enabled.into();
                config["mixed-port"] = port.into();
                kernel.reload_config(&config).await.unwrap();
            }
            let live = kernel.config().await.unwrap();
            assert_eq!(live["ipv6"], enabled);
            assert_eq!(live["tun"]["inet6-address"], serde_json::json!([capture]));
            let reached = match client.get(&target).send().await {
                Ok(response) => response.text().await.is_ok_and(|body| body == "v6-ack"),
                Err(_) => false,
            };
            assert_eq!(reached, enabled);
        }
        kernel.stop().await.unwrap();
        echo.abort();
    }

    #[tokio::test]
    #[ignore = "requires the bundled Windows Mihomo executable"]
    async fn disabled_ipv6_still_allows_sniffed_domains_over_ipv4_while_dropping_raw_ipv6() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let binary = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.cache/air/windows-x64/mihomo.exe");
        let workspace = tempfile::tempdir().unwrap();
        let upstream = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let ipv4_port = upstream.local_addr().unwrap().port();
        let echo = tokio::spawn(async move {
            while let Ok((mut stream, _)) = upstream.accept().await {
                let mut request = [0; 1024];
                if stream.read(&mut request).await.is_ok_and(|n| n > 0) {
                    let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\nv4-sniff-ok").await;
                }
            }
        });
        let config = serde_yaml::to_value(serde_json::json!({
            "mode": "rule", "ipv6": false,
            "hosts": { "sniff.test": "127.0.0.1" },
            "tun": { "device": "Air-TUN", "enable": false, "inet6-address": ["fdfe:dcba:9876::1/126"] },
            "sniffer": {
                "enable": true, "force-dns-mapping": true, "parse-pure-ip": true, "override-destination": true,
                "sniff": { "HTTP": { "ports": [ipv4_port], "override-destination": true } }
            },
            "rules": ["DOMAIN,sniff.test,DIRECT", "MATCH,DIRECT"]
        })).unwrap();
        let (mut kernel, port) = Kernel::start_proxy(&binary, workspace.path(), config, None, false).await.unwrap();
        async fn socks_v6_connect(socks_port: u16, target_port: u16, payload: &[u8]) -> String {
            let mut s = tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, socks_port)).await.unwrap();
            s.write_all(&[5, 1, 0]).await.unwrap();
            let mut r = [0u8; 16];
            s.read_exact(&mut r[..2]).await.unwrap();
            assert_eq!(&r[..2], &[5, 0]);
            let mut req = vec![5, 1, 0, 4];
            req.extend_from_slice(&"2001::1".parse::<std::net::Ipv6Addr>().unwrap().octets());
            req.extend_from_slice(&target_port.to_be_bytes());
            s.write_all(&req).await.unwrap();
            s.read_exact(&mut r[..10]).await.unwrap();
            s.write_all(payload).await.unwrap();
            let mut body = String::new();
            let _ = tokio::time::timeout(Duration::from_secs(2), s.read_to_string(&mut body)).await;
            body
        }
        let ok_body = socks_v6_connect(port, ipv4_port, b"GET / HTTP/1.1\r\nHost: sniff.test\r\nConnection: close\r\n\r\n").await;
        assert!(ok_body.ends_with("v4-sniff-ok"), "expected sniffed domain to resolve over IPv4, got: {ok_body:?}");
        let blocked_body = socks_v6_connect(port, ipv4_port, b"RAW-NO-HOST\r\n\r\n").await;
        assert!(blocked_body.is_empty(), "expected domainless IPv6 destination to be rejected, got: {blocked_body:?}");
        kernel.stop().await.unwrap();
        echo.abort();
    }

    #[tokio::test]
    #[ignore = "requires the bundled Windows Mihomo executable"]
    async fn standby_reuses_the_kernel_without_leaving_a_proxy_listener() {
        let binary = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.cache/air/windows-x64/mihomo.exe");
        let workspace = tempfile::tempdir().unwrap();
        let config = serde_yaml::from_str(
            "mode: direct\ntun: {enable: true, device: Air-TUN}\nallow-lan: true\nmixed-port: 7890\n",
        ).unwrap();
        let mut kernel = Kernel::prepare_tun(&binary, workspace.path(), config).await.unwrap();
        let pid = kernel.child.id();
        for _ in 0..2 {
            let idle = kernel.config().await.unwrap();
            assert_eq!(idle["mixed-port"], 0);
            assert_eq!(idle["tun"]["enable"], false);
            let port = kernel.activate_listeners(None, false, serde_json::json!({ "enable": false })).await.unwrap();
            assert!(tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.is_ok());
            kernel.park_tun().await.unwrap();
            assert!(tokio::net::TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await.is_err());
            assert_eq!(kernel.child.id(), pid);
        }
        kernel.stop().await.unwrap();
    }
}

fn reserve_port() -> AirResult<(TcpListener, u16)> {
    let listener =
        TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).map_err(|_| "无法保留本机诊断端口")?;
    let port = listener
        .local_addr()
        .map_err(|_| "无法读取本机诊断端口")?
        .port();
    Ok((listener, port))
}

pub(crate) fn mixed_port_unavailable(port: u16) -> String {
    format!("本地代理端口 {port} 已被占用或被系统保留，请在网络设置中更换端口")
}

fn reserve_mixed_port(requested: Option<u16>, allow_lan: bool) -> AirResult<MixedPortReservation> {
    const FIRST_PORT: u16 = 20_000;
    const PORT_COUNT: u16 = 49_152 - FIRST_PORT;
    let start = (Uuid::new_v4().as_u128() % u128::from(PORT_COUNT)) as u16;
    // Windows can assign TCP and UDP from different reserved ranges.
    for offset in 0..if requested.is_some() { 1 } else { 128 } {
        let port = requested.unwrap_or(FIRST_PORT + (start + offset) % PORT_COUNT);
        let address = (if allow_lan { Ipv4Addr::UNSPECIFIED } else { Ipv4Addr::LOCALHOST }, port);
        let Ok(tcp) = TcpListener::bind(address) else {
            continue;
        };
        if let Ok(udp) = UdpSocket::bind(address) {
            return Ok(MixedPortReservation {
                port,
                _tcp: tcp,
                _udp: udp,
            });
        }
    }
    Err(requested.map_or_else(|| "无法找到同时可用于 TCP 和 UDP 的本地代理端口".into(),
        mixed_port_unavailable))
}
