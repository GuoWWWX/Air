mod file;

pub use file::{ConfigSource, Document, NetworkDocument, RoutingFile};

use crate::{chains::EXIT_NAME, subscriptions::Source, AirResult};
use serde::{Deserialize, Serialize};
use std::net::IpAddr;

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct RoutingConfig {
    pub subscription_id: Option<String>,
    pub inherit_rules: bool,
    pub fallback: Target,
    pub rules: Vec<Rule>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Rule {
    #[serde(default = "enabled")]
    pub enabled: bool,
    pub matcher: Matcher,
    pub value: String,
    pub target: Target,
}

fn enabled() -> bool {
    true
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Matcher {
    Domain,
    DomainSuffix,
    Ip,
    ProcessName,
    ProcessPath,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Target {
    #[default]
    Direct,
    Reject,
    Group {
        source_id: String,
        name: String,
    },
    Residential,
    Subscription,
}

impl RoutingConfig {
    pub fn detach_subscription(&mut self, id: &str) -> bool {
        let selected = self.subscription_id.as_deref() == Some(id);
        if selected {
            self.subscription_id = None;
            self.inherit_rules = false;
            if matches!(self.fallback, Target::Subscription) {
                self.fallback = Target::Reject;
            }
        }
        let mut changed = selected;
        for target in std::iter::once(&mut self.fallback)
            .chain(self.rules.iter_mut().map(|rule| &mut rule.target))
        {
            if matches!(target, Target::Group { source_id, .. } if source_id == id) {
                *target = Target::Reject;
                changed = true;
            }
        }
        changed
    }

    pub fn compile(&self, sources: &[Source]) -> AirResult<Vec<String>> {
        let source = self
            .subscription_id
            .as_ref()
            .map(|id| {
                sources
                    .iter()
                    .find(|source| &source.id == id)
                    .ok_or("所选订阅已不存在")
            })
            .transpose()?;

        let mut result = Vec::new();
        for (index, rule) in self
            .rules
            .iter()
            .enumerate()
            .filter(|(_, rule)| rule.enabled)
        {
            rule.append(source, &mut result)
                .map_err(|error| format!("第 {} 条规则：{error}", index + 1))?;
        }

        let inherited = source.map_or(&[][..], |source| source.rules.as_slice());
        let terminal = inherited.iter().position(|line| {
            line.split_once(',')
                .is_some_and(|(kind, _)| kind.trim().eq_ignore_ascii_case("MATCH"))
        });
        if self.inherit_rules {
            if source.is_none() {
                return Err("请先选择订阅规则来源".into());
            }
            result.extend(
                inherited[..terminal.unwrap_or(inherited.len())]
                    .iter()
                    .cloned(),
            );
        }

        match &self.fallback {
            Target::Subscription => {
                let line = terminal
                    .and_then(|index| inherited.get(index))
                    .ok_or("所选订阅没有默认 MATCH，请选择默认出口")?;
                result.push(line.clone());
            }
            target => {
                result.push(format!("MATCH,{}", target.outbound(source)?));
                if matches!(target, Target::Residential) {
                    result.push("MATCH,REJECT".into());
                }
            }
        }
        Ok(result)
    }
}

impl Rule {
    fn append(&self, source: Option<&Source>, result: &mut Vec<String>) -> AirResult<()> {
        let (kind, value) = self.matcher.compile(&self.value)?;
        let target = self.target.outbound(source)?;
        result.push(format!("{kind},{value},{target}"));
        // Mihomo can continue matching if the selected chain cannot carry UDP.
        if matches!(self.target, Target::Residential) {
            result.push(format!("{kind},{value},REJECT"));
        }
        Ok(())
    }
}

impl Target {
    fn outbound<'a>(&'a self, source: Option<&Source>) -> AirResult<&'a str> {
        match self {
            Self::Direct => Ok("DIRECT"),
            Self::Reject => Ok("REJECT"),
            Self::Residential => Ok(EXIT_NAME),
            Self::Subscription => Err("「沿用订阅默认出口」仅用于默认出口".into()),
            Self::Group { source_id, name } => source
                .filter(|source| {
                    &source.id == source_id && source.groups.iter().any(|group| &group.name == name)
                })
                .filter(|_| safe_field(name))
                .map(|_| name.as_str())
                .ok_or_else(|| "所选代理组在当前订阅中不存在或名称不受支持".into()),
        }
    }
}

impl Matcher {
    fn compile(self, raw: &str) -> AirResult<(&'static str, String)> {
        let value = raw.trim();
        if !safe_field(value) {
            return Err("请填写匹配值，匹配值不能包含逗号或控制字符".into());
        }
        match self {
            Self::Domain | Self::DomainSuffix => {
                let domain = value.trim_end_matches('.');
                if domain
                    .chars()
                    .any(|c| c.is_whitespace() || "/\\:@?#%*".contains(c))
                {
                    return Err("请输入域名，例如 example.com".into());
                }
                let parsed = reqwest::Url::parse(&format!("https://{domain}"))
                    .map_err(|_| "请输入有效域名")?;
                let host = parsed.host_str().ok_or("请输入有效域名")?;
                if host.parse::<IpAddr>().is_ok()
                    || host.split('.').any(|label| {
                        label.is_empty()
                            || label.len() > 63
                            || label.starts_with('-')
                            || label.ends_with('-')
                            || !label
                                .bytes()
                                .all(|ch| ch.is_ascii_alphanumeric() || ch == b'-')
                    })
                {
                    return Err("请输入有效域名".into());
                }
                Ok((
                    if matches!(self, Self::Domain) {
                        "DOMAIN"
                    } else {
                        "DOMAIN-SUFFIX"
                    },
                    host.into(),
                ))
            }
            Self::Ip => {
                let (address, prefix) = value
                    .split_once('/')
                    .map_or((value, None), |(ip, prefix)| (ip, Some(prefix)));
                let ip = address
                    .parse::<IpAddr>()
                    .map_err(|_| "请输入 IP 地址或 CIDR 网段")?;
                let (kind, max) = if ip.is_ipv4() {
                    ("IP-CIDR", 32)
                } else {
                    ("IP-CIDR6", 128)
                };
                let prefix = prefix
                    .map_or(Ok(max), str::parse::<u8>)
                    .map_err(|_| "CIDR 前缀长度无效")?;
                if prefix > max {
                    return Err("CIDR 前缀长度无效".into());
                }
                Ok((kind, format!("{ip}/{prefix}")))
            }
            Self::ProcessName => {
                if value.contains(['/', '\\', ':']) || !is_exe(value) {
                    return Err("请输入程序文件名，例如 chrome.exe".into());
                }
                Ok(("PROCESS-NAME", value.into()))
            }
            Self::ProcessPath => {
                let path = value.replace('/', "\\");
                let bytes = path.as_bytes();
                let drive =
                    bytes.len() > 3 && bytes[0].is_ascii_alphabetic() && bytes[1..3] == *b":\\";
                let unc = path.strip_prefix("\\\\").is_some_and(|value| {
                    value.split('\\').filter(|part| !part.is_empty()).count() >= 3
                });
                if !(drive || unc) || !is_exe(&path) {
                    return Err("请输入 Windows 程序的完整 .exe 路径".into());
                }
                Ok(("PROCESS-PATH", path))
            }
        }
    }
}

fn is_exe(value: &str) -> bool {
    value.len() > 4 && value.to_ascii_lowercase().ends_with(".exe")
}

fn safe_field(value: &str) -> bool {
    !value.is_empty() && !value.contains(',') && !value.chars().any(char::is_control)
}
