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
    pub(crate) target: StartTarget,
    pub(crate) yaml: Value,
    pub(crate) source_ids: HashSet<String>,
    pub(crate) rule_source_id: Option<String>,
    pub(crate) global: Option<String>,
    pub(crate) outbound: Outbound,
    pub(crate) node_names: HashMap<String, String>,
    pub(crate) dialers: HashMap<String, String>,
    pub(crate) custom_rules_end: usize,
}

// Reuse only single-node exits that already loaded successfully. A new rule,
// DNS mapping, dependency, or subscription group keeps the full reload path.
pub(super) fn prepare_node_switch(previous: &Value, next: &mut Value) -> bool {
    const MAX_NODES: usize = 8;
    let Some(current) = previous["proxies"].as_sequence() else { return false };
    let Some(proposed) = next["proxies"].as_sequence() else { return false };
    let Some(candidate) = proposed.first().filter(|_| proposed.len() == 1) else { return false };
    let Some(name) = candidate["name"].as_str() else { return false };
    if !candidate["dialer-proxy"].is_null()
        || current.iter().any(|proxy| !proxy["dialer-proxy"].is_null())
        || previous["proxy-groups"].as_sequence().map(Vec::len) != Some(1)
        || next["proxy-groups"].as_sequence().map(Vec::len) != Some(1)
        || previous["proxy-groups"][0]["name"] != "GLOBAL"
        || next["proxy-groups"][0]["name"] != "GLOBAL"
        || previous["proxy-groups"][0]["proxies"].as_sequence().map(Vec::len) != Some(current.len())
        || !previous.as_mapping().zip(next.as_mapping()).is_some_and(|(old, new)| {
            old.len() == new.len() && old.iter().all(|(key, value)| {
                matches!(key.as_str(), Some("proxies" | "proxy-groups")) || new.get(key) == Some(value)
            })
        }) {
        return false;
    }
    let loaded = current.contains(candidate)
        && previous["proxy-groups"][0]["proxies"].as_sequence()
            .is_some_and(|members| members.iter().any(|member| member.as_str() == Some(name)));
    let mut retained = vec![candidate.clone()];
    retained.extend(current.iter().filter(|proxy| proxy["name"].as_str() != Some(name)).take(MAX_NODES - 1).cloned());
    let choices = retained.iter().map(|proxy| proxy["name"].clone()).collect::<Vec<_>>();
    next["proxies"] = Value::Sequence(retained);
    next["proxy-groups"][0]["proxies"] = Value::Sequence(choices);
    loaded
}

impl ProxyConfig {
    pub(crate) fn apply_network(
        &mut self,
        network: &crate::network::NetworkSettings,
        tun: bool,
        current_pool: Option<&str>,
    ) -> AirResult<()> {
        network.apply_proxy(&mut self.yaml, tun, current_pool)?;
        if network.block_quic {
            if let Some(rules) = self.yaml["rules"].as_sequence_mut() {
                let quic = Value::String(crate::network::QUIC_BLOCK_RULE.to_owned());
                if !rules.iter().any(|entry| entry == &quic) {
                    let pos = self.custom_rules_end.min(rules.len());
                    rules.insert(pos, quic);
                }
            }
        }
        Ok(())
    }

    pub fn preview_rules(mut self, network: &crate::network::NetworkSettings) -> AirResult<Vec<String>> {
        self.apply_network(network, false, None)?;
        serde_yaml::from_value(self.yaml["rules"].clone()).map_err(|_| "无法读取运行规则".into())
    }

    pub fn preview_yaml(mut self, network: &crate::network::NetworkSettings, mode: Mode, tun: bool) -> AirResult<String> {
        self.apply_network(network, tun, None)?;
        self.yaml["mode"] = serde_yaml::to_value(mode).map_err(|_| "出站模式无效")?;
        serde_yaml::to_string(&self.yaml).map_err(|_| "无法生成运行时配置".into())
    }
}

pub(super) const SUPPORTED_UNBOUND_RULES: [&str; 20] = [
    "DOMAIN",
    "DOMAIN-SUFFIX",
    "DOMAIN-KEYWORD",
    "DOMAIN-WILDCARD",
    "DOMAIN-REGEX",
    "IP-CIDR",
    "IP-CIDR6",
    "IP-ASN",
    "SRC-IP-CIDR",
    "GEOIP",
    "GEOSITE",
    "DST-PORT",
    "SRC-PORT",
    "IN-TYPE",
    "IN-PORT",
    "NETWORK",
    "PROCESS-NAME",
    "PROCESS-NAME-REGEX",
    "PROCESS-PATH",
    "PROCESS-PATH-REGEX",
];

pub(super) fn parse_composite_subscription_rule(line: &str) -> Option<(String, &str, &str)> {
    let trimmed = line.trim();
    let (head, rest) = trimmed.split_once(',')?;
    let kind = head.trim().to_ascii_uppercase();
    if !matches!(kind.as_str(), "AND" | "OR" | "NOT") {
        return None;
    }
    let rest = rest.trim_start();
    if !rest.starts_with('(') {
        return None;
    }
    let (expr, policy) = rest.rsplit_once(',')?;
    let expr = expr.trim();
    let policy = policy.trim();
    if !expr.ends_with(')') || policy.is_empty() {
        return None;
    }
    Some((kind, expr, policy))
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
    let has_chain = matches!(target, StartTarget::Chain { .. });
    let automatic = has_node || has_chain;
    let mut custom = routing.clone();
    if automatic {
        custom.subscription_id = None;
        custom.inherit_rules = false;
        custom.fallback = Target::Direct;
    }
    let mut rules = custom.compile(sources)?;
    let mut proxies = Vec::new();
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

    let mut existing_proxy_names: HashSet<String> = proxies
        .iter()
        .filter_map(|proxy| proxy["name"].as_str().map(str::to_owned))
        .collect();
    let mut rule_source_ids = HashSet::new();
    let mut uses_selected = false;
    let mut rule_outbounds = super::subscription_rules::RuleOutbounds::default();
    for target_ref in std::iter::once(&custom.fallback).chain(
        routing
            .rules
            .iter()
            .filter(|rule| rule.enabled)
            .map(|rule| &rule.target),
    ) {
        if matches!(target_ref, Target::Selected) {
            uses_selected = true;
        }
        if let Target::Group { source_id, name } = target_ref {
            if custom.subscription_id.as_ref() != Some(source_id) {
                let source = sources.iter().find(|s| &s.id == source_id).ok_or("所选订阅已不存在")?;
                rule_outbounds.group(source, name)?;
                rule_source_ids.insert(source_id.clone());
            }
        }
        if let Target::Node { id } = target_ref {
            let trimmed = id.trim();
            let configs = selected_node_configs(&nodes, trimmed).map_err(|_| "规则指向的代理节点已不存在")?;
            if let Some(node) = nodes.iter().find(|n| n.id == trimmed) {
                rule_source_ids.insert(node.source_id.clone());
            }
            for entry in configs {
                if let Some(proxy_name) = entry["name"].as_str() {
                    if let Some(dep_id) = proxy_name.strip_prefix("air-") {
                        if let Some(dep) = nodes.iter().find(|n| n.id == dep_id) {
                            rule_source_ids.insert(dep.source_id.clone());
                        }
                    }
                    if existing_proxy_names.insert(proxy_name.to_owned()) {
                        proxies.push(entry);
                    }
                }
            }
        }
    }

    if !has_chain
        && ((!has_node && matches!(routing.fallback, Target::Residential))
            || routing
                .rules
                .iter()
                .any(|rule| rule.enabled && matches!(rule.target, Target::Residential)))
    {
        return Err("分流规则引用了链式出口，请先在节点库配置至少 2 跳的链路".into());
    }

    let mut providers = Mapping::new();
    let custom_rules_end;
    let rule_source = if let Some(exit) = ids.last() {
        sources.iter().find(|source| source.nodes.iter().any(|node| node.id == exit.trim()))
    } else {
        sources.iter().find(|source| Some(&source.id) == custom.subscription_id.as_ref())
    };

    if automatic {
        rules.pop().ok_or("默认出口不存在")?;
        rules.extend(["GEOIP,private,DIRECT,no-resolve".into(), "GEOSITE,private,DIRECT".into()]);
        custom_rules_end = rules.len();
        let terminal = match rule_source {
            Some(s) => rule_outbounds.inherit(s, &mut rules, &mut providers)?,
            None => None,
        };
        if terminal.is_none() && rules.len() == custom_rules_end {
            rules.extend(["GEOSITE,cn,DIRECT".into(), "GEOIP,CN,DIRECT,no-resolve".into()]);
        }
        let selected = if has_chain { EXIT_NAME } else { "GLOBAL" };
        let fallback = terminal.as_deref().unwrap_or(selected);
        rules.push(format!("MATCH,{fallback}"));
        if !matches!(fallback, "DIRECT" | "REJECT" | "REJECT-DROP") {
            rules.push("MATCH,REJECT".into());
        }
    } else if routing.subscription_id.is_none() && routing.rules.is_empty() && matches!(routing.fallback, Target::Direct) {
        if mode != Mode::Direct { return Err("请在节点库设为当前节点，或先配置至少 2 跳的链路".into()); }
        custom_rules_end = 0;
    } else {
        let mut custom_only = routing.clone();
        custom_only.inherit_rules = false;
        custom_only.fallback = Target::Direct;
        custom_rules_end = custom_only
            .compile(sources)
            .map(|compiled| compiled.len().saturating_sub(1))
            .unwrap_or(0);
    }

    for entry in rule_outbounds.proxies {
        if existing_proxy_names.insert(entry["name"].as_str().ok_or("节点缺少名称")?.to_owned()) { proxies.push(entry); }
    }
    let mut groups = rule_outbounds.groups;
    if let Some(source) = sources
        .iter()
        .find(|source| Some(&source.id) == custom.subscription_id.as_ref())
    {
        let raw: Value = serde_yaml::from_str(source_yaml.ok_or("无法读取分流订阅的配置")?)
            .map_err(|_| "无法解析分流订阅的配置")?;
        proxies.extend(source.nodes.iter().map(|node| {
            let mut config = node.config.clone();
            config.insert("server".into(), node.server.as_str().into());
            config.insert("port".into(), node.port.into());
            Value::Mapping(config)
        }));
        groups.extend(raw["proxy-groups"].as_sequence().into_iter().flatten().cloned());
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

    let dialers = proxies
        .iter()
        .filter_map(|proxy| {
            let name = proxy["name"].as_str()?;
            let dialer = proxy["dialer-proxy"].as_str()?;
            Some((name.to_owned(), dialer.to_owned()))
        })
        .collect();

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

    let mut source_ids: HashSet<String> = custom.subscription_id.iter().cloned().collect();
    source_ids.extend(rule_source_ids);
    source_ids.extend(nodes.iter().filter(|node| ids.contains(&node.id)).map(|node| node.source_id.clone()));
    let mut global = active.or_else(|| match &routing.fallback {
        Target::Group { .. } | Target::Subscription => {
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
            for entry in configs {
                if let Some(proxy_name) = entry["name"].as_str() {
                    if existing_proxy_names.insert(proxy_name.to_owned()) {
                        proxies.push(entry);
                    }
                }
            }
            global = Some(node.kernel_name());
            source_ids.insert(node.source_id.clone());
        }
    }
    if mode == Mode::Global && global.is_none() {
        return Err("全局模式需要一个可用的代理节点、分组或链式出口".into());
    }
    if uses_selected && mode != Mode::Direct && global.is_none() {
        return Err("分流规则引用了当前代理出口，请先选择可用代理节点".into());
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
        "unified-delay": true,
        "keep-alive-idle": 600,
        "keep-alive-interval": 15,
        "disable-keep-alive": false,
        "profile": {"store-selected": false, "store-fake-ip": false},
        "sniffer": {
            "enable": true,
            "force-dns-mapping": true,
            "parse-pure-ip": false,
            "override-destination": false,
            "sniff": {
                "HTTP": { "ports": [80, "8080-8880"], "override-destination": false },
                "TLS": { "ports": [443, 8443] },
                "QUIC": { "ports": [443, 8443] }
            },
            "skip-domain": ["Mijia Cloud", "+.push.apple.com", "+.lan", "+.local", "+.localdomain"]
        },
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
        target: target.clone(),
        yaml,
        source_ids,
        rule_source_id: rule_source.map(|source| source.id.clone()),
        global,
        outbound,
        node_names,
        dialers,
        custom_rules_end,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{routing::{Matcher, Rule}, subscriptions::parse};

    #[test]
    fn only_reuses_loaded_nodes_with_the_same_rules_and_hosts() {
        let config = |name: &str| serde_yaml::from_str::<Value>(&format!(
            "proxies: [{{name: {name}, type: http, server: 127.0.0.1, port: 8080}}]\nproxy-groups: [{{name: GLOBAL, type: select, proxies: [{name}]}}]\nrules: ['MATCH,GLOBAL']"
        )).unwrap();
        let first = config("A");
        let mut second = config("B");
        assert!(!prepare_node_switch(&first, &mut second));
        assert_eq!(second["proxy-groups"][0]["proxies"][1], "A");
        let mut returning = config("A");
        assert!(prepare_node_switch(&second, &mut returning));
        assert_eq!(returning["proxy-groups"][0]["proxies"][0], "A");
        returning = config("A");
        returning["hosts"]["example.test"] = "127.0.0.1".into();
        assert!(!prepare_node_switch(&second, &mut returning));
        assert_eq!(returning["proxies"].as_sequence().unwrap().len(), 1);
    }

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
        let target = StartTarget::Node { id: source.nodes[0].id.clone() };
        let routing = RoutingConfig { fallback: Target::Reject, ..RoutingConfig::default() };
        let compile_rules = |source: &Source| {
            let config = compile(Mode::Rule, &routing, std::slice::from_ref(source), None, &target).unwrap();
            serde_yaml::from_value::<Vec<String>>(config.yaml["rules"].clone()).unwrap()
        };
        let expected = ["GEOIP,private,DIRECT,no-resolve", "GEOSITE,private,DIRECT", "GEOSITE,cn,DIRECT", "GEOIP,CN,DIRECT,no-resolve", "MATCH,GLOBAL", "MATCH,REJECT"];
        assert_eq!(compile_rules(&source), expected);
        source.rules.insert(0, "RULE-SET,private-provider,Group".into());
        assert_eq!(compile_rules(&source), expected);
    }

    #[test]
    fn selected_source_and_chain_exit_override_old_binding_without_losing_global_group_rules() {
        use crate::routing::{Matcher, Rule};
        let profile = |domain: &str, terminal: &str| format!(
            "proxies: [{{name: Node, type: http, server: 127.0.0.1, port: 8080}}]\nproxy-groups: [{{name: Group, type: select, proxies: [Node]}}]\nrules: ['DOMAIN,{domain},DIRECT', 'MATCH,{terminal}', 'DOMAIN,ignored.test,REJECT']"
        );
        let a = parse("a".into(), "A".into(), &profile("a.test", "DIRECT")).unwrap();
        let b = parse("b".into(), "B".into(), &profile("b.test", "REJECT")).unwrap();
        let front = a.nodes[0].id.clone();
        let exit = b.nodes[0].id.clone();
        let sources = [a, b];
        let routing = RoutingConfig { subscription_id: Some("a".into()), inherit_rules: false,
            fallback: Target::Reject, rules: vec![Rule { enabled: true, matcher: Matcher::Domain,
                value: "b.test".into(), host_matcher: None, host_value: None,
                target: Target::Group { source_id: "a".into(), name: "Group".into() } }] };
        for target in [StartTarget::Node { id: exit.clone() }, StartTarget::Chain { name: "Via A".into(), hops: vec![front.clone(), exit] }] {
            let compiled = compile(Mode::Rule, &routing, &sources, None, &target).unwrap();
            assert_eq!(compiled.rule_source_id.as_deref(), Some("b"));
            let rules = serde_yaml::from_value::<Vec<String>>(compiled.yaml["rules"].clone()).unwrap();
            let alias = Target::group_alias("a", "Group");
            assert_eq!(rules[0], format!("DOMAIN,b.test,{alias}"));
            assert!(rules.contains(&"DOMAIN,b.test,DIRECT".into()));
            assert_eq!(rules.last().unwrap(), "MATCH,REJECT");
            assert!(!rules.iter().any(|s| s.contains("a.test") || s.contains("ignored.test")));
            let group = compiled.yaml["proxy-groups"].as_sequence().unwrap().iter().find(|g| g["name"] == alias.as_str()).unwrap();
            assert_eq!(group["proxies"][0], sources[0].nodes[0].kernel_name());
        }
        let first = compile(Mode::Rule, &routing, &sources, None, &StartTarget::Node { id: front }).unwrap();
        assert_eq!(first.yaml["rules"].as_sequence().unwrap().last().unwrap(), "MATCH,DIRECT");
        assert_eq!(first.rule_source_id.as_deref(), Some("a"));
        let manual = RoutingConfig {
            fallback: Target::Group { source_id: "b".into(), name: "Group".into() },
            ..RoutingConfig::default()
        };
        let standalone = compile(Mode::Rule, &manual, &sources, None, &StartTarget::Routing).unwrap();
        assert_eq!(standalone.global.as_deref(), Some(Target::group_alias("b", "Group").as_str()));
        assert_eq!(standalone.rule_source_id, None);
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
                host_matcher: None,
                host_value: None,
                target: Target::Direct,
            }],
            ..RoutingConfig::default()
        };
        let config = compile(Mode::Rule, &routing, &[source], None, &target).unwrap();
        assert_eq!(config.yaml["rules"][0].as_str(), Some("DOMAIN-SUFFIX,example.test,DIRECT"));
        let rules = config.yaml["rules"].as_sequence().unwrap();
        assert_eq!(rules[rules.len()-2], "MATCH,GLOBAL");
        assert_eq!(rules.last().unwrap(), "MATCH,REJECT");
        assert_eq!(config.yaml["proxy-groups"][0]["proxies"][0].as_str(), Some(name.as_str()));
    }

    #[test]
    fn custom_global_rules_precede_subscription_bypass_and_support_node_target() {
        let source = parse(
            "test".into(),
            "Test".into(),
            "proxies:\n  - { name: HK, type: http, server: 127.0.0.1, port: 8080 }\n  - { name: US, type: http, server: 127.0.0.1, port: 8081 }\nrules:\n  - 'DOMAIN-SUFFIX,cn.example,DIRECT'\n  - 'MATCH,Proxy'\n",
        ).unwrap();
        let hk_id = source.nodes[0].id.clone();
        let us_id = source.nodes[1].id.clone();
        let routing = RoutingConfig {
            rules: vec![
                Rule {
                    enabled: true,
                    matcher: Matcher::ProcessName,
                    value: "app.exe".into(),
                    host_matcher: Some(crate::routing::HostMatcher::DomainSuffix),
                    host_value: Some("cn.example".into()),
                    target: Target::Node { id: us_id.clone() },
                },
                Rule {
                    enabled: true,
                    matcher: Matcher::ProcessName,
                    value: "app.exe".into(),
                    host_matcher: None,
                    host_value: None,
                    target: Target::Direct,
                },
            ],
            ..RoutingConfig::default()
        };
        let config = compile(Mode::Rule, &routing, &[source], None, &StartTarget::Node { id: hk_id }).unwrap();
        let rules = serde_yaml::from_value::<Vec<String>>(config.yaml["rules"].clone()).unwrap();
        assert_eq!(
            rules,
            [
                format!("AND,((PROCESS-NAME,app.exe),(DOMAIN-SUFFIX,cn.example)),air-{us_id}"),
                "PROCESS-NAME,app.exe,DIRECT".into(),
                "GEOIP,private,DIRECT,no-resolve".into(),
                "GEOSITE,private,DIRECT".into(),
                "DOMAIN-SUFFIX,cn.example,DIRECT".into(),
                "MATCH,GLOBAL".into(),
                "MATCH,REJECT".into(),
            ]
        );
        let proxies = config.yaml["proxies"].as_sequence().unwrap();
        assert!(proxies.iter().any(|p| p["name"].as_str() == Some(&format!("air-{us_id}"))));
    }

    #[test]
    fn unbound_node_with_source_yaml_inherits_groups_composites_and_providers() {
        let profile = concat!(
            "proxies:\n",
            "  - { name: HK, type: http, server: 127.0.0.1, port: 8080 }\n",
            "  - { name: US, type: http, server: 127.0.0.1, port: 8081 }\n",
            "proxy-groups:\n",
            "  - { name: '🚀 节点选择', type: select, proxies: ['HK', 'US'] }\n",
            "  - { name: '🎯 全球直连', type: select, proxies: ['DIRECT', '🚀 节点选择'] }\n",
            "  - { name: '🛑 全球拦截', type: select, proxies: ['REJECT', 'DIRECT'] }\n",
            "rule-providers:\n",
            "  cn_list: { type: http, behavior: domain, url: 'https://example.com/cn.txt', proxy: '🎯 全球直连' }\n",
            "rules:\n",
            "  - 'AND,((NETWORK,TCP),(DST-PORT,80)),🎯 全球直连'\n",
            "  - 'RULE-SET,cn_list,🎯 全球直连'\n",
            "  - 'DOMAIN-SUFFIX,qq.com,🎯 全球直连'\n",
            "  - 'DOMAIN,ad.example,🛑 全球拦截'\n",
            "  - 'DOMAIN-SUFFIX,blocked.example,🚀 节点选择'\n",
            "  - 'GEOIP,CN,🎯 全球直连,no-resolve'\n",
            "  - 'MATCH,🚀 节点选择'\n",
        );
        let source = parse("sub".into(), "Airport".into(), profile).unwrap();
        let hk_id = source.nodes[0].id.clone();
        let us_id = source.nodes[1].id.clone();
        let routing = RoutingConfig {
            rules: vec![Rule {
                enabled: true,
                matcher: Matcher::ProcessName,
                value: "sgame.exe".into(),
                host_matcher: None,
                host_value: None,
                target: Target::Direct,
            }],
            ..RoutingConfig::default()
        };
        let mut hk_cfg = compile(Mode::Rule, &routing, std::slice::from_ref(&source), Some(profile), &StartTarget::Node { id: hk_id.clone() }).unwrap();
        let mut us_cfg = compile(Mode::Rule, &routing, std::slice::from_ref(&source), Some(profile), &StartTarget::Node { id: us_id }).unwrap();
        let mut hk_again = compile(Mode::Rule, &routing, &[source], Some(profile), &StartTarget::Node { id: hk_id }).unwrap();
        let rules = serde_yaml::from_value::<Vec<String>>(hk_cfg.yaml["rules"].clone()).unwrap();
        assert_eq!(
            rules,
            [
                "PROCESS-NAME,sgame.exe,DIRECT",
                "GEOIP,private,DIRECT,no-resolve",
                "GEOSITE,private,DIRECT",
                "AND,((NETWORK,TCP),(DST-PORT,80)),DIRECT",
                "RULE-SET,cn_list,DIRECT",
                "DOMAIN-SUFFIX,qq.com,DIRECT",
                "DOMAIN,ad.example,REJECT",
                "DOMAIN-SUFFIX,blocked.example,GLOBAL",
                "GEOIP,CN,DIRECT,no-resolve",
                "MATCH,GLOBAL",
                "MATCH,REJECT",
            ]
        );
        assert_eq!(hk_cfg.yaml["rule-providers"]["cn_list"]["path"].as_str(), Some(format!("rules/{}.cache", crate::subscriptions::digest("sub\0cn_list\0https://example.com/cn.txt")).as_str()));
        assert_eq!(hk_cfg.yaml["rule-providers"]["cn_list"]["proxy"].as_str(), Some("DIRECT"));
        assert!(!prepare_node_switch(&hk_cfg.yaml, &mut us_cfg.yaml));
        assert!(prepare_node_switch(&us_cfg.yaml, &mut hk_again.yaml));
        assert!(!rules.contains(&crate::network::QUIC_BLOCK_RULE.to_owned()));

        let mut quic_net = crate::network::NetworkSettings::default();
        quic_net.block_quic = true;
        hk_cfg.apply_network(&quic_net, false, None).unwrap();
        let with_quic = serde_yaml::from_value::<Vec<String>>(hk_cfg.yaml["rules"].clone()).unwrap();
        assert_eq!(with_quic[3], crate::network::QUIC_BLOCK_RULE);
    }

    #[test]
    fn chain_and_custom_node_defaults_bypass_private_lan_and_emit_runtime_tuning() {
        let a = parse("a".into(), "A".into(), "proxies:\n  - { name: Front, type: http, server: 127.0.0.1, port: 8080 }\n").unwrap();
        let c = parse("custom".into(), "自定义".into(), "proxies:\n  - { name: Exit, type: http, server: 127.0.0.1, port: 8081 }\n").unwrap();
        let hops = vec![a.nodes[0].id.clone(), c.nodes[0].id.clone()];
        let custom_id = c.nodes[0].id.clone();
        let sources = [a, c];
        let routing = RoutingConfig::default();

        let chain_cfg = compile(
            Mode::Rule,
            &routing,
            &sources,
            None,
            &StartTarget::Chain { name: "Home".into(), hops },
        )
        .unwrap();
        let chain_rules = serde_yaml::from_value::<Vec<String>>(chain_cfg.yaml["rules"].clone()).unwrap();
        assert_eq!(
            chain_rules,
            [
                "GEOIP,private,DIRECT,no-resolve",
                "GEOSITE,private,DIRECT",
                "GEOSITE,cn,DIRECT",
                "GEOIP,CN,DIRECT,no-resolve",
                "MATCH,air-residential-exit",
                "MATCH,REJECT",
            ]
        );
        assert_eq!(chain_cfg.yaml["unified-delay"].as_bool(), Some(true));
        assert_eq!(chain_cfg.yaml["keep-alive-idle"].as_u64(), Some(600));
        assert_eq!(chain_cfg.yaml["keep-alive-interval"].as_u64(), Some(15));
        assert_eq!(chain_cfg.yaml["disable-keep-alive"].as_bool(), Some(false));
        assert_eq!(chain_cfg.yaml["sniffer"]["enable"].as_bool(), Some(true));
        assert_eq!(chain_cfg.yaml["sniffer"]["parse-pure-ip"].as_bool(), Some(false));
        assert_eq!(chain_cfg.yaml["sniffer"]["override-destination"].as_bool(), Some(false));

        let custom_cfg = compile(
            Mode::Rule,
            &routing,
            &sources,
            None,
            &StartTarget::Node { id: custom_id },
        )
        .unwrap();
        let custom_rules = serde_yaml::from_value::<Vec<String>>(custom_cfg.yaml["rules"].clone()).unwrap();
        assert_eq!(
            custom_rules,
            [
                "GEOIP,private,DIRECT,no-resolve",
                "GEOSITE,private,DIRECT",
                "GEOSITE,cn,DIRECT",
                "GEOIP,CN,DIRECT,no-resolve",
                "MATCH,GLOBAL",
                "MATCH,REJECT",
            ]
        );
    }
}
