use super::config::{parse_composite_subscription_rule, SUPPORTED_UNBOUND_RULES};
use crate::{
    chains::selected_node_configs,
    routing::Target,
    subscriptions::{digest, Source},
    AirResult,
};
use serde_yaml::{Mapping, Value};
use std::collections::HashSet;

/// Materialize only the nodes and groups referenced by rules. Their kernel names include
/// the source identity, so a global rule can still use group A after switching to source B.
#[derive(Default)]
pub(super) struct RuleOutbounds {
    pub proxies: Vec<Value>,
    pub groups: Vec<Value>,
    loaded: HashSet<String>,
    template_outbound: Option<String>,
}

impl RuleOutbounds {
    pub fn new(template_outbound: Option<String>) -> Self {
        Self {
            template_outbound,
            ..Self::default()
        }
    }

    pub fn group(&mut self, source: &Source, name: &str) -> AirResult<String> {
        self.member(source, name, &mut HashSet::new())
    }

    fn member(
        &mut self,
        source: &Source,
        name: &str,
        visiting: &mut HashSet<String>,
    ) -> AirResult<String> {
        if matches!(
            name,
            "DIRECT" | "REJECT" | "REJECT-DROP" | "PASS" | "GLOBAL"
        ) {
            return Ok(name.into());
        }
        if let Some(node) = source.nodes.iter().find(|n| n.name == name) {
            let alias = node.kernel_name();
            if !self.loaded.contains(&alias) {
                for entry in selected_node_configs(&source.nodes, &node.id)? {
                    if self
                        .loaded
                        .insert(entry["name"].as_str().ok_or("节点缺少名称")?.into())
                    {
                        self.proxies.push(entry);
                    }
                }
            }
            return Ok(alias);
        }
        if source.id.starts_with("user:") && !source.groups.iter().any(|g| g.name == name) {
            return Ok(self
                .template_outbound
                .clone()
                .unwrap_or_else(|| "GLOBAL".into()));
        }
        let alias = Target::group_alias(&source.id, name);
        if self.loaded.contains(&alias) {
            return Ok(alias);
        }
        if !visiting.insert(alias.clone()) {
            return Err("订阅分组包含循环引用".into());
        }
        let mut group = source
            .group_configs
            .iter()
            .find(|g| g["name"].as_str() == Some(name))
            .cloned()
            .ok_or("规则引用的节点或分组不存在")?;
        if !group["use"].is_null() {
            return Err("此订阅的分组引用了外部节点集合，请选择固定节点或链路".into());
        }
        let mut members = Vec::new();
        for item in group["proxies"].as_sequence().ok_or("订阅分组缺少节点")? {
            members.push(Value::String(self.member(
                source,
                item.as_str().ok_or("订阅分组的节点名称无效")?,
                visiting,
            )?));
        }
        if source.id.starts_with("user:") {
            let mut seen = HashSet::new();
            members.retain(|item| seen.insert(item.as_str().unwrap_or_default().to_owned()));
        }
        group["name"] = alias.clone().into();
        group["proxies"] = members.into();
        visiting.remove(&alias);
        self.loaded.insert(alias.clone());
        self.groups.push(group);
        Ok(alias)
    }

    fn policy(&mut self, source: &Source, name: &str) -> AirResult<Option<String>> {
        // Select groups whose default is a proxy follow the explicitly chosen outbound.
        // A direct/reject group keeps that decision. Fixed nodes and automatic groups retain their own target.
        let mut current = name;
        let mut seen = HashSet::new();
        while let Some(group) = source
            .groups
            .iter()
            .find(|g| g.name == current && g.strategy == "select")
        {
            if !seen.insert(current) {
                return Err("订阅分组包含循环引用".into());
            }
            if let Some(first) = group.members.first() {
                if matches!(first.as_str(), "DIRECT" | "REJECT" | "REJECT-DROP") {
                    return Ok(Some(first.clone()));
                }
                current = first;
            } else {
                break;
            }
        }
        if source.id.starts_with("user:")
            && !source.groups.iter().any(|group| group.name == name)
            && !matches!(name, "DIRECT" | "REJECT" | "REJECT-DROP" | "PASS")
        {
            return Ok(Some("GLOBAL".into()));
        }
        if source
            .groups
            .iter()
            .any(|g| g.name == name && g.strategy == "select")
        {
            return Ok(Some("GLOBAL".into()));
        }
        if matches!(
            name,
            "DIRECT" | "REJECT" | "REJECT-DROP" | "PASS" | "GLOBAL"
        ) || source.groups.iter().any(|g| g.name == name)
            || source.nodes.iter().any(|n| n.name == name)
        {
            return self.member(source, name, &mut HashSet::new()).map(Some);
        }
        Ok(None)
    }

    pub fn inherit(
        &mut self,
        source: &Source,
        rules: &mut Vec<String>,
        providers: &mut Mapping,
    ) -> AirResult<Option<String>> {
        for line in &source.rules {
            if let Some((kind, expr, policy)) = parse_composite_subscription_rule(line) {
                if let Some(out) = self.policy(source, policy)? {
                    rules.push(format!("{kind},{expr},{out}"));
                }
                continue;
            }
            let mut fields = line.split(',').map(str::trim);
            let Some((kind, key)) = fields.next().zip(fields.next()) else {
                continue;
            };
            let kind = kind.to_ascii_uppercase();
            if kind == "MATCH" {
                return self.policy(source, key);
            }
            let Some(policy) = fields.next() else {
                continue;
            };
            if key.is_empty()
                || !(kind == "RULE-SET" || SUPPORTED_UNBOUND_RULES.contains(&kind.as_str()))
            {
                continue;
            }
            let Some(out) = self.policy(source, policy)? else {
                continue;
            };
            if kind == "RULE-SET" && !providers.contains_key(key) {
                let Some(mut provider) = source.rule_providers.get(key).cloned() else {
                    continue;
                };
                if !matches!(
                    provider["behavior"].as_str(),
                    Some("domain" | "ipcidr" | "classical")
                ) || (provider["behavior"] == "classical" && provider["format"] == "mrs")
                {
                    continue;
                }
                match provider["type"].as_str() {
                    Some("inline") if provider["payload"].is_sequence() => {}
                    Some("http") => {
                        let Some(url) = provider["url"]
                            .as_str()
                            .and_then(|s| reqwest::Url::parse(s).ok())
                        else {
                            continue;
                        };
                        if !matches!(url.scheme(), "http" | "https")
                            || !url.has_host()
                            || !url.username().is_empty()
                            || url.password().is_some()
                        {
                            continue;
                        }
                        provider["path"] = format!(
                            "rules/{}.cache",
                            digest(format!("{}\0{key}\0{url}", source.id))
                        )
                        .into();
                    }
                    _ => continue,
                }
                if let Some(proxy) = provider["proxy"].as_str() {
                    let Some(target) = self.policy(source, proxy)? else {
                        continue;
                    };
                    provider["proxy"] = target.into();
                }
                providers.insert(key.into(), provider);
            }
            let mut entry = format!("{kind},{key},{out}");
            for hint in fields.filter(|s| matches!(*s, "no-resolve" | "src")) {
                entry.push(',');
                entry.push_str(hint);
            }
            rules.push(entry);
        }
        Ok(None)
    }
}
