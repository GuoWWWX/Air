use crate::{
    proxy::StartTarget,
    subscriptions::{Group, Source},
    AirResult,
};
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct RuleLibrary {
    pub sets: Vec<UserRuleSet>,
    pub bindings: BTreeMap<String, String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UserRuleSet {
    pub id: String,
    pub name: String,
    pub profile: RuleProfile,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case", deny_unknown_fields)]
pub struct RuleProfile {
    pub rules: Vec<String>,
    #[serde(default, skip_serializing_if = "Mapping::is_empty")]
    pub rule_providers: Mapping,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub proxy_groups: Vec<Value>,
}

impl UserRuleSet {
    pub fn source(&self) -> Source {
        let id = format!("user:{}", self.id);
        let groups = self
            .profile
            .proxy_groups
            .iter()
            .filter_map(|group| {
                Some(Group {
                    source_id: id.clone(),
                    name: group["name"].as_str()?.into(),
                    strategy: group["type"].as_str()?.into(),
                    members: group["proxies"]
                        .as_sequence()
                        .into_iter()
                        .flatten()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect(),
                })
            })
            .collect();
        Source {
            id,
            name: self.name.clone(),
            nodes: vec![],
            groups,
            group_configs: vec![],
            rules: self.profile.rules.clone(),
            rule_providers: self.profile.rule_providers.clone(),
            hosts: Mapping::new(),
        }
    }
}

impl RuleLibrary {
    pub fn validate(&self) -> AirResult<()> {
        let mut ids = HashSet::new();
        for set in &self.sets {
            if set.id.is_empty()
                || !ids.insert(set.id.as_str())
                || set.name.trim().is_empty()
                || set.profile.rules.iter().any(|r| !r.contains(','))
            {
                return Err("规则集格式无效".into());
            }
        }
        for (owner, binding) in &self.bindings {
            if !owner.split_once(':').is_some_and(|(kind, id)| {
                !id.is_empty() && matches!(kind, "node" | "subscription" | "chain" | "group")
            }) || !(binding == "none"
                || binding
                    .strip_prefix("subscription:")
                    .is_some_and(|s| !s.is_empty())
                || binding
                    .strip_prefix("user:")
                    .is_some_and(|id| ids.contains(id)))
            {
                return Err("分流规则绑定无效".into());
            }
        }
        Ok(())
    }

    pub fn resolve(&self, target: &StartTarget, owner: Option<&str>) -> Option<String> {
        let mut keys = Vec::new();
        match target {
            StartTarget::Node { id, group_id } => {
                keys.push(format!("node:{id}"));
                if let Some(group) = group_id {
                    keys.push(format!("group:{group}"));
                }
            }
            StartTarget::Group { id, .. } => keys.push(format!("group:{id}")),
            StartTarget::Chain { id: Some(id), .. } => keys.push(format!("chain:{id}")),
            _ => (),
        }
        if let Some(source) = owner {
            keys.push(format!("subscription:{source}"));
        }
        keys.iter()
            .find_map(|key| self.bindings.get(key).cloned())
            .or_else(|| owner.map(|id| format!("subscription:{id}")))
    }
}
