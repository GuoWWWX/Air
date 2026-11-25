use crate::AirResult;
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, error::Error, time::Duration};

const MAX_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct Node {
    pub id: String,
    pub source_id: String,
    pub name: String,
    pub display_name: String,
    pub protocol: String,
    pub server: String,
    pub port: u16,
    pub config: Mapping,
    pub probe_target: Option<ProbeTarget>,
}

impl Node {
    pub fn kernel_name(&self) -> String {
        format!("air-{}", self.id)
    }

    pub fn is_subscription_notice(&self) -> bool {
        let name = self.name.trim_start_matches(|ch: char| !ch.is_alphanumeric());
        self.source_id != "custom"
            && ["剩余流量", "套餐到期"].into_iter().any(|label| {
                name.strip_prefix(label).is_some_and(|suffix| {
                    suffix
                        .chars()
                        .next()
                        .is_none_or(|ch| ch == ':' || ch == '：' || ch.is_whitespace())
                })
            })
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub source_id: String,
    pub name: String,
    pub members: Vec<String>,
    pub strategy: String,
}

pub struct Source {
    pub id: String,
    pub name: String,
    pub nodes: Vec<Node>,
    pub groups: Vec<Group>,
    pub group_configs: Vec<Value>,
    pub rule_providers: Mapping,
    pub rules: Vec<String>,
    pub hosts: Mapping,
}

/// A runtime can contain several explicit chain hops and one routing subscription.
pub fn combined_hosts(sources: &[Source], used: &HashSet<String>) -> AirResult<Mapping> {
    let mut hosts = Mapping::new();
    for source in sources.iter().filter(|source| used.contains(&source.id)) {
        for (domain, value) in &source.hosts {
            if hosts.get(domain).is_some_and(|existing| existing != value) {
                return Err(format!("当前链路或分流订阅对 hosts 域名 {} 指定了不同地址", domain.as_str().unwrap_or("?")));
            }
            hosts.insert(domain.clone(), value.clone());
        }
    }
    Ok(hosts)
}

#[derive(Clone)]
pub struct ProbeTarget {
    pub url: String,
    pub expected: String,
}

fn probe_target(config: &Value) -> Option<ProbeTarget> {
    config["proxy-groups"].as_sequence()?.iter().find_map(|group| {
        if !matches!(group["type"].as_str(), Some("url-test" | "fallback" | "load-balance")) {
            return None;
        }
        let url = reqwest::Url::parse(group["url"].as_str()?).ok()?;
        if url.scheme() != "https" || !url.has_host() || !url.username().is_empty() || url.password().is_some() {
            return None;
        }
        let configured = &group["expected-status"];
        let expected = configured.as_u64()
            .or_else(|| configured.as_str()?.parse().ok())
            .filter(|status| (100..=599).contains(status));
        Some(ProbeTarget {
            expected: expected.map_or_else(
                || if url.path().ends_with("/generate_204") { "204".into() } else { "200-299".into() },
                |status| status.to_string(),
            ),
            url: url.into(),
        })
    })
}

pub fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn parse(id: String, name: String, yaml: &str) -> AirResult<Source> {
    if yaml.len() > MAX_BYTES {
        return Err("订阅文件超过 8 MB".into());
    }
    let config: Value = serde_yaml::from_str(yaml).map_err(|error| {
        error.location().map_or_else(
            || "无法解析 YAML".into(),
            |at| format!("YAML 格式错误，第 {} 行第 {} 列", at.line(), at.column()),
        )
    })?;
    let entries = config
        .as_sequence()
        .or_else(|| config["proxies"].as_sequence())
        .ok_or("订阅中找不到 proxies 节点列表")?;
    let mut names = HashSet::new();
    let mut nodes = Vec::with_capacity(entries.len());
    let hosts = match &config["hosts"] {
        Value::Null => Mapping::new(),
        Value::Mapping(records) => records.clone(),
        _ => return Err("订阅 hosts 必须是域名到地址的映射".into()),
    };
    let target = probe_target(&config);
    let prefer_ipv4 = config["ipv6"].as_bool() == Some(false);
    for (index, entry) in entries.iter().enumerate() {
        let invalid = || format!("第 {} 个节点缺少有效的名称、协议、地址或端口", index + 1);
        let mapping = entry.as_mapping().ok_or_else(invalid)?;
        let field = |key| entry[key].as_str().filter(|value| !value.trim().is_empty());
        let name = field("name").ok_or_else(invalid)?;
        let port = entry["port"]
            .as_u64()
            .and_then(|n| u16::try_from(n).ok())
            .or_else(|| entry["port"].as_str()?.parse().ok())
            .filter(|n| *n > 0)
            .ok_or_else(invalid)?;
        if !names.insert(name) {
            return Err(format!("第 {} 个节点名称在同一订阅中重复", index + 1));
        }
        let mut mapping = mapping.clone();
        if prefer_ipv4 {
            mapping.entry("ip-version".into()).or_insert_with(|| "ipv4".into());
        }
        nodes.push(Node {
            id: digest(format!("{id}\0{name}")),
            source_id: id.clone(),
            name: name.into(),
            display_name: name.into(),
            protocol: field("type").ok_or_else(invalid)?.into(),
            server: field("server").ok_or_else(invalid)?.into(),
            port,
            config: mapping,
            probe_target: target.clone(),
        });
    }
    if nodes.is_empty() {
        return Err("订阅没有可用的节点".into());
    }
    let groups = config["proxy-groups"]
        .as_sequence()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let name = item["name"].as_str()?.to_owned();
            let members = item["proxies"]
                .as_sequence()
                .into_iter()
                .flatten()
                .filter_map(|value| value.as_str().map(str::to_owned))
                .collect();
            Some(Group {
                source_id: id.clone(),
                name,
                members,
                strategy: item["type"].as_str().unwrap_or("select").into(),
            })
        })
        .collect();
    Ok(Source {
        id,
        name,
        nodes,
        groups,
        group_configs: config["proxy-groups"].as_sequence().cloned().unwrap_or_default(),
        rule_providers: config["rule-providers"].as_mapping().cloned().unwrap_or_default(),
        hosts,
        rules: config["rules"]
            .as_sequence()
            .into_iter()
            .flatten()
            .filter_map(|rule| rule.as_str().map(str::to_owned))
            .collect(),
    })
}

pub fn change_item(
    yaml: &str,
    name: &str,
    group: bool,
    edit: Option<(String, String, Vec<String>)>,
) -> AirResult<String> {
    let mut config: Value = serde_yaml::from_str(yaml).map_err(|_| "无法解析订阅")?;
    let key = if group { "proxy-groups" } else { "proxies" };
    let entries = if config.is_sequence() && !group {
        config.as_sequence_mut()
    } else {
        config[key].as_sequence_mut()
    }
    .ok_or("订阅条目已不存在")?;
    let index = entries
        .iter()
        .position(|entry| entry["name"].as_str() == Some(name))
        .ok_or("订阅条目已不存在")?;
    let next_name = edit
        .as_ref()
        .map(|(name, _, _)| name.trim())
        .filter(|name| !name.is_empty());
    if let Some((new_name, strategy, members)) = &edit {
        let new_name = new_name.trim();
        if !group
            || new_name.is_empty()
            || new_name.contains(',')
            || members.iter().any(|member| member == new_name)
        {
            return Err("分组名称无效，或成员包含分组自身".into());
        }
        entries[index]["name"] = new_name.into();
        entries[index]["type"] = strategy.as_str().into();
        entries[index]["proxies"] = Value::Sequence(
            members
                .iter()
                .map(|member| member.as_str().into())
                .collect(),
        );
        if matches!(strategy.as_str(), "url-test" | "fallback" | "load-balance") {
            let entry = entries[index].as_mapping_mut().ok_or("分组配置无效")?;
            entry
                .entry("url".into())
                .or_insert_with(|| "https://www.gstatic.com/generate_204".into());
            entry
                .entry("interval".into())
                .or_insert_with(|| Value::from(300));
        }
    } else {
        entries.remove(index);
    }
    if next_name != Some(name) && config.is_mapping() {
        if let Some(groups) = config["proxy-groups"].as_sequence_mut() {
            for group in groups {
                if let Some(members) = group["proxies"].as_sequence_mut() {
                    members.retain_mut(|member| {
                        if member.as_str() != Some(name) {
                            return true;
                        }
                        if let Some(next) = next_name {
                            *member = next.into();
                            return true;
                        }
                        false
                    });
                }
            }
        }
        if let Some(next) = next_name {
            if let Some(rules) = config["rules"].as_sequence_mut() {
                for rule in rules {
                    let Some(text) = rule.as_str() else { continue };
                    let mut fields: Vec<_> = text.split(',').collect();
                    if let Some(target) = fields
                        .iter_mut()
                        .rev()
                        .find(|part| !matches!(part.trim(), "no-resolve" | "src"))
                    {
                        if target.trim() == name {
                            *target = next;
                            *rule = fields.join(",").into();
                        }
                    }
                }
            }
        }
    }
    serde_yaml::to_string(&config).map_err(|_| "无法保存订阅修改".into())
}

#[derive(Deserialize, Serialize)]
pub struct Usage {
    pub upload: u64,
    pub download: u64,
    pub total: u64,
    pub expire: Option<u64>,
}

impl Usage {
    fn from_header(header: &str) -> Option<Self> {
        let get = |field: &str| {
            header.split(';').find_map(|part| {
                let (key, value) = part.trim().split_once('=')?;
                (key.trim() == field)
                    .then(|| value.trim().parse::<u64>().ok())
                    .flatten()
            })
        };
        Some(Self {
            upload: get("upload")?,
            download: get("download")?,
            total: get("total")?,
            expire: get("expire").filter(|value| *value > 0),
        })
    }
}

pub mod extension;

pub struct Download {
    pub profile_title: Option<String>,
    pub interval_hours: Option<u16>,
    pub yaml: String,
    pub usage: Option<Usage>,
}

fn download_url(raw_url: &str) -> AirResult<reqwest::Url> {
    let url = reqwest::Url::parse(raw_url.trim()).map_err(|_| "请输入有效的订阅链接")?;
    if !matches!(url.scheme(), "https" | "http") || url.host().is_none() {
        return Err("订阅链接必须使用 HTTP 或 HTTPS".into());
    }
    Ok(url)
}

fn download_client() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("too many subscription redirects")
            } else if attempt.url().scheme() != "https"
                && attempt.previous().iter().any(|url| url.scheme() == "https")
            {
                attempt.error("subscription redirect downgraded HTTPS")
            } else {
                attempt.follow()
            }
        }))
        .user_agent("Clash.Meta")
}

async fn download_from(url: &reqwest::Url, options: reqwest::ClientBuilder) -> AirResult<Download> {
    let client = options.build().map_err(|_| "无法初始化订阅下载")?;
    let response = client.get(url.clone()).send().await.map_err(|error| connection_error(&error))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status().as_u16()));
    }
    read_download(response).await
}

pub async fn fetch(raw_url: &str, active_proxy: Option<u16>) -> AirResult<Download> {
    let url = download_url(raw_url)?;
    let mut routes = Vec::with_capacity(3);
    routes.push(("直连", download_client().no_proxy()));
    if let Some(port) = active_proxy {
        let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
            .map_err(|_| "无法配置 Air Proxy 下载代理")?;
        routes.push(("Air Proxy 代理", download_client().no_proxy().proxy(proxy)));
    }
    routes.push(("系统代理", download_client()));
    let mut failures = Vec::new();
    for (route, options) in routes {
        match download_from(&url, options).await {
            Ok(download) => return Ok(download),
            Err(error) => failures.push(format!("{route} {error}")),
        }
    }
    Err(format!("订阅下载失败 · {}", failures.join(" · ")))
}

pub async fn fetch_with_saved_nodes(
    url: &reqwest::Url, binary: &std::path::Path, config: &std::path::Path, directory: &std::path::Path, nodes: &[Node], hosts: &Mapping,
) -> AirResult<Download> {
    if url.scheme() != "https" || nodes.is_empty() {
        return Err("没有可用于 HTTPS 更新的订阅节点".into());
    }
    let settings = crate::routing::RoutingFile::new(config).network()?.settings;
    let kernel = crate::mihomo::Kernel::start_subscription(binary, directory, crate::chains::node_configs(nodes)?, hosts, &settings).await?;
    let proxy = kernel.diagnostic_proxy()?;
    let mut last_error = "没有可用的订阅节点".to_owned();
    for node in nodes.iter().filter(|node| !node.is_subscription_notice()) {
        kernel.select_global(&node.kernel_name()).await?;
        let client = download_client().no_proxy().proxy(proxy.clone()).connect_timeout(Duration::from_secs(3));
        match download_from(url, client.timeout(Duration::from_secs(6))).await {
            Ok(download) => return Ok(download),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

fn connection_error(error: &reqwest::Error) -> &'static str {
    if error.is_timeout() {
        return "连接超时";
    }
    if error.is_redirect() {
        return "重定向无效";
    }
    let mut cause = error.source();
    while let Some(next) = cause {
        let detail = next.to_string().to_ascii_lowercase();
        if ["certificate", "cert_", "证书", "0x800b01"].iter().any(|part| detail.contains(part)) {
            return "HTTPS 证书验证失败";
        }
        if ["handshake", "tls", "schannel", "安全程序包"].iter().any(|part| detail.contains(part)) {
            return "HTTPS 握手失败";
        }
        cause = next.source();
    }
    "无法连接服务器"
}

fn valid_title(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.chars().count() <= 256 && !value.chars().any(char::is_control))
        .then(|| value.to_owned())
}

fn profile_title(bytes: &[u8]) -> Option<String> {
    use base64::{engine::general_purpose::{STANDARD, STANDARD_NO_PAD}, Engine};
    let value = std::str::from_utf8(bytes).ok()?.trim();
    let title = if value.get(..7).is_some_and(|p| p.eq_ignore_ascii_case("base64:")) {
        let encoded = value[7..].trim();
        String::from_utf8(STANDARD.decode(encoded).or_else(|_| STANDARD_NO_PAD.decode(encoded)).ok()?).ok()?
    } else {
        value.to_owned()
    };
    valid_title(&title)
}

fn disposition_parameter(value: &str) -> Option<String> {
    let value = value.trim();
    let Some(quoted) = value.strip_prefix('"') else { return Some(value.to_owned()) };
    let mut chars = quoted.strip_suffix('"')?.chars();
    let mut filename = String::with_capacity(quoted.len());
    while let Some(ch) = chars.next() {
        filename.push(if ch == '\\' { chars.next()? } else { ch });
    }
    Some(filename)
}

fn extended_filename(value: &str) -> Option<String> {
    let (charset, rest) = value.split_once('\'')?;
    let (_, encoded) = rest.split_once('\'')?;
    let mut bytes = encoded.bytes();
    let mut decoded = Vec::with_capacity(encoded.len());
    while let Some(byte) = bytes.next() {
        let byte = if byte == b'%' {
            let high = char::from(bytes.next()?).to_digit(16)?;
            let low = char::from(bytes.next()?).to_digit(16)?;
            (high * 16 + low) as u8
        } else {
            byte
        };
        decoded.push(byte);
    }
    if charset.eq_ignore_ascii_case("utf-8") {
        String::from_utf8(decoded).ok()
    } else if charset.eq_ignore_ascii_case("iso-8859-1") {
        Some(decoded.into_iter().map(char::from).collect())
    } else {
        None
    }
}

fn disposition_title(bytes: &[u8]) -> Option<String> {
    use std::borrow::Cow;
    let header = match std::str::from_utf8(bytes) {
        Ok(header) => Cow::Borrowed(header),
        Err(_) => Cow::Owned(bytes.iter().copied().map(char::from).collect::<String>()),
    };
    let mut quoted = false;
    let mut escaped = false;
    let mut parts = header.split(|ch| {
        if escaped {
            escaped = false;
            return false;
        }
        if ch == '"' { quoted = !quoted; }
        escaped = quoted && ch == '\\';
        ch == ';' && !quoted
    });
    if parts.next()?.trim().is_empty() { return None; }
    let mut filename = None;
    for part in parts {
        let Some((key, value)) = part.split_once('=') else { continue };
        let key = key.trim();
        if key.eq_ignore_ascii_case("filename*") {
            if let Some(decoded) = disposition_parameter(value).and_then(|value| extended_filename(&value)) {
                filename = Some(decoded);
                break;
            }
        } else if key.eq_ignore_ascii_case("filename") && filename.is_none() {
            filename = disposition_parameter(value);
        }
    }
    let filename = filename.as_deref()?.rsplit(['/', '\\']).next()?.trim();
    let title = match filename.rsplit_once('.') {
        Some((stem, ext)) if ext.eq_ignore_ascii_case("yaml") || ext.eq_ignore_ascii_case("yml") => stem,
        _ => filename,
    };
    if matches!(title.trim(), "." | "..") { return None; }
    valid_title(title)
}

async fn read_download(mut response: reqwest::Response) -> AirResult<Download> {
    let headers = response.headers();
    let profile_title = headers.get("profile-title").and_then(|h| profile_title(h.as_bytes()))
        .or_else(|| headers.get(reqwest::header::CONTENT_DISPOSITION).and_then(|h| disposition_title(h.as_bytes())));
    let usage = response
        .headers()
        .get("subscription-userinfo")
        .and_then(|value| value.to_str().ok())
        .and_then(Usage::from_header);
    let interval_hours = response.headers().get("profile-update-interval")
        .and_then(|v| v.to_str().ok()?.trim().parse::<u16>().ok()).filter(|v| (1..=720).contains(v));
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取订阅中断或超时")? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err("订阅文件超过 8 MB".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let yaml = String::from_utf8(bytes).map_err(|_| "订阅文件必须使用 UTF-8 编码")?;
    // Captive portals and regional gateways sometimes return an HTML page with HTTP 200.
    parse(String::new(), String::new(), &yaml)?;
    Ok(Download { yaml, usage, interval_hours, profile_title })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{io::{AsyncReadExt, AsyncWriteExt}, net::TcpListener};

    #[test]
    fn uses_the_subscription_health_check_and_ipv4_preference() {
        let source = parse("test".into(), "Test".into(), r#"
ipv6: false
proxies:
  - {name: jp, type: vless, server: example.com, port: 443}
  - {name: dual, type: vless, server: example.com, port: 443, ip-version: dual}
proxy-groups:
  - {name: auto, type: url-test, proxies: [jp], url: 'https://cp.cloudflare.com/generate_204'}
"#).unwrap();
        let target = source.nodes[0].probe_target.as_ref().unwrap();
        assert_eq!(target.url, "https://cp.cloudflare.com/generate_204");
        assert_eq!(target.expected, "204");
        assert_eq!(source.nodes[0].config["ip-version"], "ipv4");
        assert_eq!(source.nodes[1].config["ip-version"], "dual");
    }

    async fn reply(response: String) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut connection, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                request.push(connection.read_u8().await.unwrap());
            }
            connection.write_all(response.as_bytes()).await.unwrap();
        });
        port
    }

    const YAML: &str = "proxies: [{name: test, type: http, server: 127.0.0.1, port: 10001}]";

    #[test]
    fn profile_titles_accept_plain_and_base64_utf8() {
        assert_eq!(profile_title(" 东京 ".as_bytes()).as_deref(), Some("东京"));
        assert_eq!(profile_title(b"BASE64:5LiA").as_deref(), Some("一"));
        assert_eq!(profile_title(b"base64:Rg").as_deref(), Some("F"));
        for raw in [b"   ".as_slice(), b"base64:!!!!", b"base64:/w==", b"base64:QQpC"] {
            assert!(profile_title(raw).is_none());
        }
    }

    #[test]
    fn disposition_titles_support_encoded_and_quoted_filenames() {
        for (header, title) in [
            (r#"attachment; filename="Fallback.yaml"; filename*=UTF-8'ja'%E6%97%A5%E6%9C%AC%20+%20%E9%A6%99%E6%B8%AF.YML"#, Some("日本 + 香港")),
            (r#"attachment; filename="Team; A.yaml""#, Some("Team; A")),
            (r#"INLINE; filename="Tokyo.yaml"; filename*=UTF-8''%E6%9D%B1%E4%BA%AC.yml"#, Some("東京")),
            (r#"inline; filename="SakuraCat.yaml""#, Some("SakuraCat")),
            (r#"attachment; filename="SakuraCat.yaml"; filename*=UTF-8''%ZZ"#, Some("SakuraCat")),
            (r#"attachment; filename="folder/test.yaml""#, Some("test")),
            (r#"attachment; filename=".yaml""#, None),
        ] {
            assert_eq!(disposition_title(header.as_bytes()).as_deref(), title);
        }
    }

    #[tokio::test]
    async fn filename_updates_an_automatic_name_without_overwriting_a_manual_name() {
        let origin = reply(format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Disposition: attachment; filename=\"SakuraCat\"; filename*=UTF-8''SakuraCat\r\n\r\n{YAML}",
            YAML.len()
        )).await;
        let url = format!("http://127.0.0.1:{origin}/sub");
        let mut download = fetch(&url, None).await.unwrap();
        assert_eq!(download.profile_title.as_deref(), Some("SakuraCat"));

        let directory = tempfile::tempdir().unwrap();
        let store = crate::storage::Store::open(&directory.path().join("subscriptions.db")).unwrap();
        let title = download.profile_title.take();
        assert_eq!(store.save_source("example", "", &download, "url", Some(&url)).unwrap(), "127.0.0.1");
        download.profile_title = title;
        assert_eq!(store.preview_source_name("example", "", &url, download.profile_title.as_deref()).unwrap(), "SakuraCat");
        assert_eq!(store.save_source("example", "", &download, "url", Some(&url)).unwrap(), "SakuraCat");
        store.rename_source("example", "My subscription").unwrap();
        assert_eq!(store.save_source("example", "", &download, "url", Some(&url)).unwrap(), "My subscription");
        assert_eq!(store.sources().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn downloads_directly_even_with_an_active_proxy() {
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let yaml = YAML;
        let origin = reply(format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\npRoFiLe-TiTle: Family\r\nContent-Disposition: attachment; filename=Fallback.yaml\r\nSubscription-Userinfo: upload=1; download=2; total=3\r\n\r\n{yaml}",
            yaml.len()
        )).await;
        let download = fetch(&format!("http://127.0.0.1:{origin}/sub"), Some(proxy.local_addr().unwrap().port())).await.unwrap();
        assert_eq!(download.yaml, yaml);
        assert_eq!(download.profile_title.as_deref(), Some("Family"));
        assert_eq!(download.usage.unwrap().total, 3);
        assert!(tokio::time::timeout(Duration::from_millis(30), proxy.accept()).await.is_err());
    }

    #[tokio::test]
    async fn retries_a_block_page_or_region_error_using_the_available_proxy() {
        for response in [
            "HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\n<html/>",
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n",
        ] {
            let origin = reply(response.into()).await;
            let proxy = reply(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{YAML}", YAML.len())).await;
            let download = fetch(&format!("http://127.0.0.1:{origin}/sub"), Some(proxy)).await.unwrap();
            assert_eq!(download.yaml, YAML);
        }
    }
}
