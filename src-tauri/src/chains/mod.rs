use crate::{
    subscriptions::{digest, Node, Source},
    AirResult,
};
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use std::collections::{HashMap, HashSet};

pub const EXIT_NAME: &str = "air-residential-exit";

pub(crate) fn chain_hop_name(index: usize, length: usize) -> String {
    if index + 1 == length {
        EXIT_NAME.to_owned()
    } else {
        format!("air-chain-hop-{index}")
    }
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomNodeInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub protocol: String,
    pub server: String,
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

fn validate_server_host(raw: &str) -> AirResult<&str> {
    let host = raw.trim();
    let invalid = host.is_empty()
        || reqwest::Url::parse(&format!(
            "http://{}",
            if host.parse::<std::net::Ipv6Addr>().is_ok() {
                format!("[{host}]")
            } else {
                host.into()
            }
        ))
        .ok()
        .is_none_or(|url| {
            url.host().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.port().is_some()
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
                || host
                    .chars()
                    .any(|c| c.is_whitespace() || matches!(c, '/' | '\\' | '@' | '?' | '#'))
        });
    if invalid {
        return Err("请输入有效的服务器地址和端口".into());
    }
    Ok(host)
}

pub fn custom_node_mapping(input: &CustomNodeInput) -> AirResult<Mapping> {
    let name = input.name.trim();
    if name.is_empty() || name.chars().any(char::is_control) {
        return Err("请输入有效的节点名称".into());
    }
    let (protocol, tls) = match input.protocol.as_str() {
        "http" => ("http", false),
        "https" => ("http", true),
        "socks5" => ("socks5", false),
        _ => return Err("自定义节点仅支持 HTTP、HTTPS 和 SOCKS5".into()),
    };
    if input.port == 0 {
        return Err("请输入有效的服务器地址和端口".into());
    }
    let host = validate_server_host(&input.server)?;
    let mut config = Mapping::new();
    for (key, value) in [
        ("name", name.into()),
        ("type", protocol.into()),
        ("server", host.into()),
        ("port", input.port.into()),
    ] {
        config.insert(key.into(), value);
    }
    if tls {
        config.insert("tls".into(), true.into());
    }
    if !input.username.is_empty() {
        config.insert("username".into(), input.username.as_str().into());
    }
    if !input.password.is_empty() {
        config.insert("password".into(), input.password.as_str().into());
    }
    Ok(config)
}

pub fn node_configs(nodes: &[Node]) -> AirResult<Vec<Value>> {
    let names: HashMap<_, _> = nodes
        .iter()
        .map(|node| {
            (
                (node.source_id.as_str(), node.name.as_str()),
                node.kernel_name(),
            )
        })
        .collect();
    nodes
        .iter()
        .map(|node| {
            let mut value = probe_mapping(node);
            if let Some(dialer) = value.get("dialer-proxy") {
                let dialer = dialer.as_str().ok_or("前置节点引用格式错误")?;
                let name = names
                    .get(&(node.source_id.as_str(), dialer))
                    .ok_or("订阅节点的前置引用必须是同一来源中的固定节点")?;
                value.insert("dialer-proxy".into(), name.as_str().into());
            }
            Ok(Value::Mapping(value))
        })
        .collect()
}

fn probe_mapping(node: &Node) -> Mapping {
    let mut value = node.config.clone();
    value.insert("name".into(), node.kernel_name().into());
    value.insert("server".into(), node.server.as_str().into());
    value.insert("port".into(), node.port.into());
    value
}

pub fn probe_revisions(source: &Source) -> AirResult<HashMap<String, String>> {
    let nodes = &source.nodes;
    let hosts_revision = if source.hosts.is_empty() {
        String::new()
    } else {
        digest(serde_yaml::to_string(&source.hosts).map_err(|_| "无法计算订阅 hosts 版本")?)
    };
    let by_name: HashMap<_, _> = nodes
        .iter()
        .map(|node| ((node.source_id.as_str(), node.name.as_str()), node))
        .collect();
    let mut revisions: HashMap<String, String> = HashMap::with_capacity(nodes.len());
    for node in nodes {
        let mut chain = Vec::new();
        let mut seen = HashSet::new();
        let mut current = Some(node);
        let mut upstream = String::new();
        while let Some(node) = current {
            if let Some(revision) = revisions.get(&node.id) {
                upstream = revision.clone();
                break;
            }
            if !seen.insert(&node.id) {
                upstream = "circular".into();
                break;
            }
            chain.push(node);
            current = node
                .config
                .get("dialer-proxy")
                .and_then(Value::as_str)
                .and_then(|name| by_name.get(&(node.source_id.as_str(), name)).copied());
        }
        for node in chain.into_iter().rev() {
            let config =
                serde_yaml::to_string(&probe_mapping(node)).map_err(|_| "无法计算节点探测版本")?;
            let config = if hosts_revision.is_empty() {
                config
            } else {
                format!("{config}\0hosts:{hosts_revision}")
            };
            upstream = match &node.probe_target {
                Some(target) => digest(format!(
                    "node-probe-v3\0{upstream}\0{config}\0{}\0{}",
                    target.url, target.expected
                )),
                None => digest(format!("node-probe-v2\0{upstream}\0{config}")),
            };
            revisions.insert(node.id.clone(), upstream.clone());
        }
    }
    Ok(revisions)
}

pub fn selected_node_configs(nodes: &[Node], selected: &str) -> AirResult<Vec<Value>> {
    let node = nodes
        .iter()
        .find(|node| node.id == selected)
        .ok_or("所选前置节点已不存在")?;
    let mut dependencies = vec![node.clone()];
    while let Some(dialer) = dependencies
        .last()
        .and_then(|n| n.config.get("dialer-proxy"))
    {
        let name = dialer.as_str().ok_or("前置节点引用格式错误")?;
        let dependency = nodes
            .iter()
            .find(|n| n.source_id == node.source_id && n.name == name)
            .ok_or("订阅节点的前置引用必须是同一来源中的固定节点")?;
        if dependencies.iter().any(|n| n.id == dependency.id) {
            return Err("前置节点包含循环引用".into());
        }
        dependencies.push(dependency.clone());
    }
    node_configs(&dependencies)
}

pub fn chain_hops(nodes: &[Node], hops: &[String]) -> AirResult<Vec<Value>> {
    if hops.len() < 2 {
        return Err("链路至少需要包含 2 跳节点".into());
    }
    let mut seen = HashSet::with_capacity(hops.len());
    for hop in hops {
        let id = hop.trim();
        if id.is_empty() {
            return Err("请为每一跳选择节点".into());
        }
        if !seen.insert(id) {
            return Err("同一条链路中不能重复使用相同节点".into());
        }
    }

    let mut proxies = selected_node_configs(nodes, hops[0].trim())?;
    let used_kernel_names: HashSet<String> = proxies
        .iter()
        .filter_map(|entry| entry["name"].as_str().map(str::to_owned))
        .collect();
    let mut prev_name = proxies[0]["name"]
        .as_str()
        .ok_or("前置节点名称无效")?
        .to_owned();

    for (offset, hop_id) in hops[1..].iter().enumerate() {
        let index = offset + 1;
        let node = nodes
            .iter()
            .find(|node| node.id == hop_id.trim())
            .ok_or_else(|| format!("第 {} 跳所选节点已不存在", index + 1))?;
        if used_kernel_names.contains(&node.kernel_name()) {
            return Err("链路中存在循环前置依赖".into());
        }
        let hop_name = chain_hop_name(index, hops.len());
        let mut mapping = node.config.clone();
        mapping.insert("name".into(), hop_name.as_str().into());
        mapping.insert("server".into(), node.server.as_str().into());
        mapping.insert("port".into(), node.port.into());
        mapping.insert("dialer-proxy".into(), prev_name.as_str().into());
        proxies.push(Value::Mapping(mapping));
        prev_name = hop_name;
    }

    Ok(proxies)
}
