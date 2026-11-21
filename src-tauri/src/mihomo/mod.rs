mod geodata;

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
}

struct MixedPortReservation {
    port: u16,
    _tcp: TcpListener,
    _udp: UdpSocket,
}

impl Kernel {
    pub async fn start(
        binary: &Path,
        app_dir: &Path,
        nodes: Vec<Value>,
        hosts: &Mapping,
        exit: Option<&str>,
    ) -> AirResult<Self> {
        let network = crate::routing::RoutingFile::new(app_dir).network()?.settings;
        if exit.is_none() && !nodes.is_empty() {
            return Self::start_probes(binary, app_dir, nodes, hosts, &network, Self::probe_interface().as_deref()).await;
        }
        Self::start_diagnostic(binary, app_dir, nodes, hosts, exit, &network).await
    }

    pub async fn start_diagnostic(binary: &Path, app_dir: &Path, nodes: Vec<Value>, hosts: &Mapping, exit: Option<&str>, network: &NetworkSettings) -> AirResult<Self> {
        Self::launch_diagnostic(binary, app_dir, nodes, hosts, exit, network, None).await
    }

    pub fn probe_interface() -> Option<String> {
        #[cfg(windows)]
        { crate::proxy::windows::probe_interface() }
        #[cfg(not(windows))]
        { None }
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
        config["allow-lan"] = false.into();
        config["bind-address"] = "127.0.0.1".into();
        if let Some(reservation) = &mixed {
            config["mixed-port"] = reservation.port.into();
            config["authentication"] = Value::Sequence(vec![format!("air:{password}").into()]);
        }
        let mixed_info = mixed.as_ref().map(|reservation| (reservation.port, password));
        let mut kernel = Self::launch(binary, app_dir, config, mixed, mixed_info, "probe-").await?;
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
        let mut kernel = Self::launch(
            binary,
            app_dir,
            config,
            Some(reservation),
            None,
            "runtime-",
        )
        .await?;
        // The control API can start responding before the mixed listener is ready.
        let ready = tokio::time::timeout(Duration::from_secs(3), async {
            while kernel.running() {
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
        Ok((kernel, port))
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
        let (child, tun_error) = {
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
        let job = crate::proxy::windows::own_process(child.raw_handle().ok_or("无法读取 Mihomo 进程")?)?;
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
        .map_err(|_| {
            if missing_geodata {
                "等待 Mihomo 地理规则库下载超时，请使用包含离线规则库的 Air 安装包"
            } else {
                "Mihomo 的本地控制接口未在启动时限内就绪"
            }
        })?;
        ready?;
        Ok(kernel)
    }

    pub(crate) fn running(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    #[cfg(windows)]
    pub(crate) fn process_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        self.child.raw_handle()
    }

    pub async fn stop(&mut self) -> AirResult<()> {
        self.child
            .kill()
            .await
            .map_err(|_| "无法停止 Mihomo 内核".into())
    }

    pub(crate) async fn patch_config(&self, value: &serde_json::Value) -> AirResult<()> {
        #[cfg(windows)]
        if value.get("tun").is_some() { self.tun_error.lock().unwrap().take(); }
        self.control(reqwest::Method::PATCH, "configs", value).await
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
        .await
    }

    pub(crate) async fn select_global(&self, name: &str) -> AirResult<()> {
        self.control(
            reqwest::Method::PUT,
            "proxies/GLOBAL",
            &serde_json::json!({ "name": name }),
        )
        .await
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
        let enabled = self.config().await?["tun"]["enable"]
            .as_bool()
            .ok_or("当前 Mihomo 版本无法报告虚拟网卡状态")?;
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
        use futures_util::{stream::FuturesUnordered, StreamExt};
        let mut attempts = FuturesUnordered::new();
        for (url, wait) in [(target, Duration::ZERO), (alternate, Duration::from_secs(2))] {
            attempts.push(async move {
                tokio::time::sleep(wait).await;
                self.delay_at(name, url, "204", PROBE_TIMEOUT - wait).await
            });
        }
        let mut failure = Probe::Unreachable;
        while let Some(result) = attempts.next().await {
            match result {
                Probe::Available(_) => return result,
                Probe::Timeout => failure = Probe::Timeout,
                Probe::Unreachable => {}
            }
        }
        failure
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
            .timeout(TIMEOUT)
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
    #[cfg(all(windows, feature = "desktop"))]
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
