use crate::{
    chains::{chain_hop_name, chain_hops, selected_node_configs, EXIT_NAME},
    routing::{RoutingConfig, Target},
    subscriptions::Source,
    AirResult,
};
use serde_yaml::{Mapping, Value};
use std::collections::{HashMap, HashSet};

use super::{Hop, Mode, Outbound, StartTarget};

pub struct ProxyConfig {
    pub(crate) yaml: Value,
    pub(crate) source_ids: HashSet<String>,
    pub(crate) global: Option<String>,
    pub(crate) outbound: Outbound,
    pub(crate) node_names: HashMap<String, String>,
    pub(crate) dialers: HashMap<String, String>,
}

impl ProxyConfig {
    pub fn preview_yaml(mut self, network: &crate::network::NetworkSettings, mode: Mode, tun: bool) -> AirResult<String> {
        network.apply_proxy(&mut self.yaml, tun, None)?;
        self.yaml["mode"] = serde_yaml::to_value(mode).map_err(|_| "出站模式无效")?;
        serde_yaml::to_string(&self.yaml).map_err(|_| "无法生成运行时配置".into())
    }
}

pub fn compile(
    mode: Mode,
    routing: &RoutingConfig,
    sources: &[Source],
    source_yaml: Option<&str>,
    target: &StartTarget,
) -> AirResult<ProxyConfig> {
    let nodes = sources
        .iter()
        .flat_map(|source| source.nodes.iter().cloned())
        .collect::<Vec<_>>();
    let has_node = matches!(target, StartTarget::Node { .. });
    let mut rules = if has_node {
        let mut routing = routing.clone();
        routing.fallback = Target::Direct;
        routing.compile(sources)?
    } else {
        routing.compile(sources)?
    };
    let mut proxies = Vec::new();
    let has_chain = matches!(target, StartTarget::Chain { .. });
    let (active, name, ids) = match target {
        StartTarget::Chain { name, hops } => {
            proxies = chain_hops(&nodes, hops)?;
            (
                Some(EXIT_NAME.to_owned()),
                name.trim().to_owned(),
                hops.as_slice(),
            )
        }
        StartTarget::Node { id } => {
            proxies = selected_node_configs(&nodes, id)?;
            (
                proxies[0]["name"].as_str().map(str::to_owned),
                String::new(),
                std::slice::from_ref(id),
            )
        }
        StartTarget::Routing => (None, "按分流规则".into(), &[][..]),
    };
    let mut node_names: HashMap<_, _> = nodes
        .iter()
        .map(|node| (node.kernel_name(), node.display_name.clone()))
        .collect();
    let mut hops = Vec::with_capacity(ids.len());
    for (index, id) in ids.iter().enumerate() {
        let node = nodes
            .iter()
            .find(|node| node.id == id.trim())
            .ok_or("所选节点已不存在")?;
        if node.is_subscription_notice() {
            return Err("所选条目是订阅提示，请选择可连接的代理节点".into());
        }
        if has_chain && index > 0 {
            node_names.insert(chain_hop_name(index, ids.len()), node.display_name.clone());
        }
        hops.push(Hop {
            id: node.id.clone(),
            name: node.display_name.clone(),
            protocol: node.protocol.clone(),
            source: sources
                .iter()
                .find(|source| source.id == node.source_id)
                .map(|source| source.name.clone())
                .unwrap_or_default(),
        });
    }
    let name = if name.is_empty() {
        hops.iter()
            .map(|hop| hop.name.as_str())
            .collect::<Vec<_>>()
            .join(" → ")
    } else {
        name
    };
    let outbound = Outbound { name, hops };
    let dialers = proxies
        .iter()
        .filter_map(|proxy| {
            let name = proxy["name"].as_str()?;
            let dialer = proxy["dialer-proxy"].as_str()?;
            Some((name.to_owned(), dialer.to_owned()))
        })
        .collect();

    if !has_chain
        && ((!has_node && matches!(routing.fallback, Target::Residential))
            || routing
                .rules
                .iter()
                .any(|rule| rule.enabled && matches!(rule.target, Target::Residential)))
    {
        return Err("分流规则引用了链式出口，请先在节点库配置至少 2 跳的链路".into());
    }

    // The built-in routing defaults should use the explicitly selected outbound.
    if has_node {
        let name = active.as_ref().ok_or("当前节点无效")?;
        rules.pop().ok_or("默认出口不存在")?;
        if routing.subscription_id.is_none() && routing.rules.is_empty() {
            // A fixed node can reuse a subscription's standalone bypass rules without
            // importing other nodes, named policies or external rule providers.
            let source = sources.iter().find(|source| source.nodes.iter().any(|node| node.id == ids[0]));
            if let Some(source) = source {
                let prefix = source.rules.iter().take_while(|line| {
                    !line.split(',').next().unwrap_or("").trim().eq_ignore_ascii_case("MATCH")
                });
                if prefix.clone().all(|line| {
                    let fields: Vec<_> = line.split(',').map(str::trim).collect();
                    matches!(fields.as_slice(), [
                        "GEOIP" | "GEOSITE" | "IP-CIDR" | "IP-CIDR6" | "DOMAIN" |
                        "DOMAIN-SUFFIX" | "DOMAIN-KEYWORD" | "PROCESS-NAME" | "PROCESS-PATH",
                        _, "DIRECT" | "REJECT" | "REJECT-DROP"
                    ] | ["GEOIP" | "IP-CIDR" | "IP-CIDR6", _, "DIRECT" | "REJECT" | "REJECT-DROP", "no-resolve"])
                }) {
                    rules.extend(prefix.cloned());
                }
            }
        }
        rules.push(format!("MATCH,{name}"));
        rules.push("MATCH,REJECT".into());
    } else if routing.subscription_id.is_none()
        && routing.rules.is_empty()
        && matches!(routing.fallback, Target::Direct)
    {
        if let Some(name) = &active {
            rules = vec![format!("MATCH,{name}")];
            if has_chain {
                rules.push("MATCH,REJECT".into());
            }
        } else if mode != Mode::Direct {
            return Err("请在节点库设为当前节点，或先配置至少 2 跳的链路".into());
        }
    }

    let mut groups = Vec::new();
    let mut providers = Mapping::new();
    if let Some(source) = sources
        .iter()
        .find(|source| Some(&source.id) == routing.subscription_id.as_ref())
    {
        let raw: Value = serde_yaml::from_str(source_yaml.ok_or("无法读取分流订阅的配置")?)
            .map_err(|_| "无法解析分流订阅的配置")?;
        proxies.extend(source.nodes.iter().map(|node| {
            let mut config = node.config.clone();
            config.insert("server".into(), node.server.as_str().into());
            config.insert("port".into(), node.port.into());
            Value::Mapping(config)
        }));
        groups = raw["proxy-groups"]
            .as_sequence()
            .cloned()
            .unwrap_or_default();
        if groups.iter().any(|group| !group["use"].is_null()) {
            return Err("此订阅的分组引用了外部节点集合，请选择固定节点或链路".into());
        }
        if routing.inherit_rules {
            if let Some(entries) = raw["rule-providers"].as_mapping() {
                for (index, (name, entry)) in entries.iter().enumerate() {
                    let mut provider = entry.clone();
                    match provider["type"].as_str() {
                        Some("http")
                            if provider["url"]
                                .as_str()
                                .and_then(|url| reqwest::Url::parse(url).ok())
                                .is_some_and(|url| matches!(url.scheme(), "http" | "https")) =>
                        {
                            provider["path"] = format!("rules/{index}.cache").into();
                        }
                        Some("inline") => {}
                        _ => return Err("订阅规则仅支持 HTTP、HTTPS 或内联规则集".into()),
                    }
                    providers.insert(name.clone(), provider);
                }
            }
        }
    }

    let reserved = [
        "GLOBAL",
        "DIRECT",
        "REJECT",
        "REJECT-DROP",
        "PASS",
        "COMPATIBLE",
    ];
    let mut names = HashSet::new();
    for entry in proxies.iter().chain(groups.iter()) {
        let name = entry["name"]
            .as_str()
            .ok_or("订阅包含无效的节点或分组名称")?;
        if reserved.contains(&name) || !names.insert(name) {
            return Err("订阅的节点或分组名称与其他出站冲突".into());
        }
    }

    let mut source_ids: HashSet<String> = routing.subscription_id.iter().cloned().collect();
    source_ids.extend(nodes.iter().filter(|node| ids.contains(&node.id)).map(|node| node.source_id.clone()));
    let mut global = active.or_else(|| match &routing.fallback {
        Target::Group { name, .. } => Some(name.clone()),
        Target::Subscription => {
            let (_, target) = rules.last()?.split_once(',')?;
            let target = target.trim();
            names.contains(target).then(|| target.to_owned())
        }
        _ => None,
    });
    if global.is_none() && matches!(target, StartTarget::Routing) {
        // A DIRECT or REJECT rule-mode fallback is independent of the global-mode selector.
        let eligible = |node: &&crate::subscriptions::Node| !node.is_subscription_notice();
        let preferred = nodes.iter().filter(eligible)
            .find(|node| Some(&node.source_id) == routing.subscription_id.as_ref());
        if let Some(node) = preferred {
            global = Some(node.name.clone());
        } else if let Some((node, configs)) = nodes.iter().filter(eligible).find_map(|node| {
            selected_node_configs(&nodes, &node.id).ok().map(|configs| (node, configs))
        }) {
            proxies.extend(configs);
            global = Some(node.kernel_name());
            source_ids.insert(node.source_id.clone());
        }
    }
    if mode == Mode::Global && global.is_none() {
        return Err("全局模式需要一个可用的代理节点、分组或链式出口".into());
    }

    if let Some(node) = &global {
        // Keep the selected global exit across mode changes and in-place config reloads.
        groups.push(
            serde_yaml::to_value(serde_json::json!({
                "name": "GLOBAL", "type": "select", "proxies": [node],
            }))
            .map_err(|_| "无法生成全局出口配置")?,
        );
    }

    let mut yaml: Value = serde_yaml::to_value(serde_json::json!({
        "mode": "rule",
        "find-process-mode": "always",
        "profile": {"store-selected": false, "store-fake-ip": false},
        "rules": rules,
    }))
    .map_err(|_| "无法生成代理配置")?;
    yaml["proxies"] = Value::Sequence(proxies);
    yaml["proxy-groups"] = Value::Sequence(groups);
    if !providers.is_empty() {
        yaml["rule-providers"] = Value::Mapping(providers);
    }
    let hosts = crate::subscriptions::combined_hosts(sources, &source_ids)?;
    if !hosts.is_empty() {
        yaml["hosts"] = Value::Mapping(hosts);
    }
    Ok(ProxyConfig {
        yaml,
        source_ids,
        global,
        outbound,
        node_names,
        dialers,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{routing::{Matcher, Rule}, subscriptions::parse};

    #[test]
    fn dual_stack_hosts_survive_selection_routing_and_dns_overrides() {
        let profile = "hosts: {node.home.arpa: ['2001:db8::1234', '192.0.2.5']}\nproxies: [{name: JP, type: http, server: node.home.arpa, port: 1080, ip-version: ipv6-prefer}]";
        let source = parse("s".into(), "S".into(), profile).unwrap();
        let other = parse("t".into(), "T".into(), &profile.replace("192.0.2.5", "192.0.2.9")).unwrap();
        let first = source.nodes[0].id.clone();
        let sources = [source, other];
        let mut network = crate::network::NetworkSettings::default();
        network.hosts = vec!["127.0.0.1 local.test".into()];
        for (routing, target) in [
            (RoutingConfig::default(), StartTarget::Node { id: first.clone() }),
            (RoutingConfig { subscription_id: Some("s".into()), ..RoutingConfig::default() }, StartTarget::Routing),
        ] {
            let mut yaml = compile(Mode::Global, &routing, &sources, Some(profile), &target).unwrap().yaml;
            network.apply_dns(&mut yaml).unwrap();
            assert_eq!(yaml["proxies"].as_sequence().unwrap().len(), 1);
            assert_eq!(yaml["proxies"][0]["server"], "node.home.arpa");
            assert_eq!(yaml["proxies"][0]["ip-version"], "ipv6-prefer");
            assert_eq!(yaml["hosts"]["node.home.arpa"], sources[0].hosts["node.home.arpa"]);
            assert_eq!(yaml["hosts"]["local.test"], "127.0.0.1");
            assert_eq!(yaml["dns"]["use-hosts"], true);
            let mut override_network = network.clone();
            override_network.hosts.push("192.0.2.7 node.home.arpa".into());
            override_network.apply_dns(&mut yaml).unwrap();
            assert_eq!(yaml["hosts"]["node.home.arpa"], "192.0.2.7");
        }
    }

    #[test]
    fn unbound_node_keeps_its_own_domestic_rules_before_the_selected_exit() {
        let profile = "proxies: [{name: JP, type: http, server: 127.0.0.1, port: 8080}]\nrules: [ 'GEOSITE,cn,DIRECT', 'GEOIP,CN,DIRECT,no-resolve', 'MATCH,Group', 'DOMAIN,ignored.test,DIRECT' ]";
        let mut source = parse("s".into(), "Test".into(), profile).unwrap();
        let name = source.nodes[0].kernel_name();
        let target = StartTarget::Node { id: source.nodes[0].id.clone() };
        let routing = RoutingConfig { fallback: Target::Reject, ..RoutingConfig::default() };
        let compile_rules = |source: &Source| {
            let config = compile(Mode::Rule, &routing, std::slice::from_ref(source), None, &target).unwrap();
            serde_yaml::from_value::<Vec<String>>(config.yaml["rules"].clone()).unwrap()
        };
        let terminal = format!("MATCH,{name}");
        assert_eq!(compile_rules(&source), ["GEOSITE,cn,DIRECT", "GEOIP,CN,DIRECT,no-resolve", &terminal, "MATCH,REJECT"]);
        source.rules.insert(0, "RULE-SET,private-provider,Group".into());
        assert_eq!(compile_rules(&source), [terminal.as_str(), "MATCH,REJECT"]);
    }

    #[test]
    fn subscription_notices_are_rejected_as_explicit_outbounds() {
        let source = parse(
            "subscription".into(),
            "Subscription".into(),
            "proxies:\n  - { name: '剩余流量：10 GB', type: http, server: 127.0.0.1, port: 1 }\n  - { name: 'Tokyo', type: http, server: 127.0.0.1, port: 8080 }\n",
        )
        .unwrap();
        let sources = [source];
        let target = |index: usize| StartTarget::Node {
            id: sources[0].nodes[index].id.clone(),
        };
        let routing = RoutingConfig::default();
        let invalid = compile(Mode::Rule, &routing, &sources, None, &target(0)).err();
        assert_eq!(invalid.as_deref(), Some("所选条目是订阅提示，请选择可连接的代理节点"));
        assert!(compile(Mode::Rule, &routing, &sources, None, &target(1)).is_ok());
    }

    #[test]
    fn choosing_a_node_sets_the_default_while_preserving_specific_rules() {
        let source = parse(
            "test".into(),
            "Test".into(),
            "proxies:\n  - { name: Test node, type: http, server: 127.0.0.1, port: 8080 }\n",
        ).unwrap();
        let name = source.nodes[0].kernel_name();
        let target = StartTarget::Node { id: source.nodes[0].id.clone() };
        let routing = RoutingConfig {
            fallback: Target::Residential,
            rules: vec![Rule {
                enabled: true,
                matcher: Matcher::DomainSuffix,
                value: "example.test".into(),
                target: Target::Direct,
            }],
            ..RoutingConfig::default()
        };
        let config = compile(Mode::Rule, &routing, &[source], None, &target).unwrap();
        assert_eq!(config.yaml["rules"][0].as_str(), Some("DOMAIN-SUFFIX,example.test,DIRECT"));
        assert_eq!(config.yaml["rules"][1].as_str(), Some(format!("MATCH,{name}").as_str()));
        assert_eq!(config.yaml["rules"][2].as_str(), Some("MATCH,REJECT"));
        assert_eq!(config.yaml["proxy-groups"][0]["proxies"][0].as_str(), Some(name.as_str()));
    }
}
