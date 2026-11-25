use crate::AirResult;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use serde_yaml::Value;
use std::net::{IpAddr, SocketAddr};

pub const QUIC_BLOCK_RULE: &str =
    "AND,((NETWORK,UDP),(DST-PORT,443),(NOT,((GEOSITE,cn))),(NOT,((GEOIP,CN,no-resolve)))),REJECT";

const DEFAULT_BOOTSTRAP_DNS: [&str; 3] = ["223.5.5.5", "119.29.29.29", "1.1.1.1"];

const DEFAULT_FAKE_IP_FILTER: [&str; 26] = [
    "+.lan",
    "+.local",
    "+.localdomain",
    "geosite:private",
    "geosite:cn",
    "geosite:connectivity-check",
    "+.msftconnecttest.com",
    "+.msftncsi.com",
    "localhost.ptlogin2.qq.com",
    "localhost.sec.qq.com",
    "localhost.work.weixin.qq.com",
    "time.*.com",
    "ntp.*.com",
    "+.ntp.org.cn",
    "stun.*.*",
    "stun.*.*.*",
    "+.stun.*.*",
    "+.stun.*.*.*",
    "+.srv.nintendo.net",
    "+.stun.playstation.net",
    "xbox.*.microsoft.com",
    "xnotify.xboxlive.com",
    "+.battlenet.com.cn",
    "+.wotgame.cn",
    "+.wggames.cn",
    "+.wowsgame.cn",
];

fn resolver_uses_hostname(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || trimmed == "system"
        || trimmed.parse::<IpAddr>().is_ok()
        || trimmed.parse::<SocketAddr>().is_ok()
    {
        return false;
    }
    Url::parse(trimmed)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .is_some_and(|host| host.trim_matches(['[', ']']).parse::<IpAddr>().is_err())
}

fn default_true() -> bool {
    true
}

const PRIVATE_IPV4_CIDRS: [&str; 4] = [
    "10.0.0.0/8",
    "172.16.0.0/12",
    "192.168.0.0/16",
    "169.254.0.0/16",
];

const PRIVATE_IPV6_CIDRS: [&str; 2] = ["fc00::/7", "fe80::/10"];

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub struct NetworkSettings {
    pub nameserver: Vec<String>,
    pub default_nameserver: Vec<String>,
    pub direct_nameserver: Vec<String>,
    pub proxy_server_nameserver: Vec<String>,
    pub fallback: Vec<String>,
    pub fallback_domains: Vec<String>,
    pub domain_dns: Vec<DomainDns>,
    pub enhanced_mode: String,
    pub fake_ip_filter: Vec<String>,
    pub respect_rules: bool,
    pub ipv6: bool,
    pub dns_ipv6: bool,
    pub use_system_hosts: bool,
    pub hosts: Vec<String>,
    pub direct_follow_policy: bool,
    pub dns_cache_algorithm: String,
    pub tun_stack: String,
    pub tun_mtu: Option<u16>,
    pub strict_route: bool,
    pub dns_hijack: bool,
    #[serde(default = "default_true")]
    pub bypass_lan: bool,
    pub route_exclude_address: Vec<String>,
    pub mixed_port: Option<u16>,
    pub allow_lan: bool,
    pub system_proxy_bypass: Vec<String>,
    pub tcp_concurrent: bool,
    #[serde(default = "default_true")]
    pub block_quic: bool,
    pub probe_url: String,
    pub probe_status: u16,
    pub probe_interval_minutes: u16,
}

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct DomainDns {
    pub domain: String,
    pub server: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DnsResult {
    pub addresses: Vec<IpAddr>,
    pub elapsed_ms: u64,
}

impl Default for NetworkSettings {
    fn default() -> Self {
        Self {
            nameserver: vec!["https://1.1.1.1/dns-query".into(), "https://8.8.8.8/dns-query".into()],
            default_nameserver: vec![],
            direct_nameserver: vec![],
            proxy_server_nameserver: vec!["https://223.5.5.5/dns-query".into(), "https://1.1.1.1/dns-query".into()],
            fallback: vec![],
            fallback_domains: vec![],
            domain_dns: vec![],
            enhanced_mode: "fake-ip".into(),
            fake_ip_filter: vec![],
            respect_rules: true,
            ipv6: false,
            dns_ipv6: false,
            use_system_hosts: true,
            hosts: vec![],
            direct_follow_policy: false,
            dns_cache_algorithm: "auto".into(),
            tun_stack: "mixed".into(),
            tun_mtu: None,
            strict_route: false,
            dns_hijack: true,
            bypass_lan: true,
            route_exclude_address: vec![],
            mixed_port: None,
            allow_lan: false,
            system_proxy_bypass: vec![],
            tcp_concurrent: true,
            block_quic: true,
            probe_url: "https://www.gstatic.com/generate_204".into(),
            probe_status: 204,
            probe_interval_minutes: 5,
        }
    }
}

impl NetworkSettings {
    fn host_records(&self) -> AirResult<std::collections::BTreeMap<String, String>> {
        let mut records = std::collections::BTreeMap::new();
        for (i, line) in self.hosts.iter().enumerate() {
            let mut fields = line.split_whitespace();
            let ip = fields
                .next()
                .and_then(|s| s.parse::<IpAddr>().ok())
                .ok_or_else(|| format!("本地 hosts 第 {} 行需以 IPv4 或 IPv6 地址开头", i + 1))?;
            let domains: Vec<_> = fields.collect();
            if domains.is_empty() {
                return Err(format!("本地 hosts 第 {} 行缺少域名", i + 1));
            }
            for domain in domains {
                if !valid_pattern(domain)
                    || records
                        .insert(domain.to_ascii_lowercase(), ip.to_string())
                        .is_some()
                {
                    return Err(format!(
                        "本地 hosts 第 {} 行域名无效或重复：{domain}",
                        i + 1
                    ));
                }
            }
        }
        Ok(records)
    }

    pub fn validate(&self) -> AirResult<()> {
        self.host_records()?;
        if !matches!(self.dns_cache_algorithm.as_str(), "auto" | "lru" | "arc") {
            return Err("DNS 缓存算法可选 auto、lru 或 arc".into());
        }
        if !(1..=1440).contains(&self.probe_interval_minutes) {
            return Err("后台测速间隔请填写 1 到 1440 分钟".into());
        }
        if self.nameserver.is_empty() {
            return Err("主 DNS 至少需要一个地址，也可以填写 system".into());
        }
        for (label, list, bootstrap) in [
            ("主 DNS", &self.nameserver, false),
            ("引导 DNS", &self.default_nameserver, true),
            ("直连 DNS", &self.direct_nameserver, false),
            ("节点 DNS", &self.proxy_server_nameserver, false),
            ("备用 DNS", &self.fallback, false),
        ] {
            for (i, server) in list.iter().enumerate() {
                if !valid_resolver(server, bootstrap) {
                    return Err(format!(
                        "{label} 第 {} 行地址无效{}",
                        i + 1,
                        if bootstrap {
                            "，引导地址须使用 IP"
                        } else {
                            ""
                        }
                    ));
                }
            }
        }
        let mut domains = std::collections::HashSet::new();
        for (i, entry) in self.domain_dns.iter().enumerate() {
            if !valid_pattern(&entry.domain)
                || !valid_resolver(&entry.server, false)
                || !domains.insert(entry.domain.to_ascii_lowercase())
            {
                return Err(format!(
                    "分域 DNS 第 {} 行域名重复、格式错误或 DNS 地址无效",
                    i + 1
                ));
            }
        }
        if self
            .fake_ip_filter
            .iter()
            .chain(&self.fallback_domains)
            .any(|s| !valid_pattern(s))
        {
            return Err("DNS 域名列表请每行填写一个域名，子域名可用 +.example.com".into());
        }
        if self.fallback.is_empty() && !self.fallback_domains.is_empty() {
            return Err("指定备用解析域名时，请同时填写备用 DNS".into());
        }
        if self.respect_rules && self.proxy_server_nameserver.is_empty() {
            return Err("启用 DNS 遵循分流规则时，请先填写节点 DNS".into());
        }
        if !matches!(
            self.enhanced_mode.as_str(),
            "auto" | "fake-ip" | "redir-host"
        ) || !matches!(self.tun_stack.as_str(), "gvisor" | "mixed" | "system")
        {
            return Err("DNS 模式或 TUN 协议栈无效".into());
        }
        if self.tun_mtu.is_some_and(|v| !(1280..=9000).contains(&v)) {
            return Err("TUN MTU 请填写 1280 到 9000，或留空使用内核默认值".into());
        }
        for (i, cidr) in self.route_exclude_address.iter().enumerate() {
            let ok = cidr
                .split_once('/')
                .and_then(|(ip, bits)| Some((ip.parse::<IpAddr>().ok()?, bits.parse::<u8>().ok()?)))
                .is_some_and(|(ip, bits)| bits <= if ip.is_ipv4() { 32 } else { 128 });
            if !ok {
                return Err(format!("绕过网段第 {} 行须使用 IPv4 或 IPv6 CIDR", i + 1));
            }
        }
        if self.mixed_port == Some(0) {
            return Err("本地代理端口请填写 1 到 65535，或留空自动分配".into());
        }
        if self.system_proxy_bypass.iter().any(|s| {
            s.is_empty()
                || s.contains([';', '/'])
                || s.chars().any(|c| c.is_whitespace() || c.is_control())
        }) {
            return Err("系统代理绕过列表请每行填写一个域名、地址或通配符".into());
        }
        if !Url::parse(&self.probe_url).is_ok_and(|u| {
            matches!(u.scheme(), "http" | "https")
                && u.has_host()
                && u.username().is_empty()
                && u.password().is_none()
        }) || !(100..=599).contains(&self.probe_status)
        {
            return Err("测速目标需要有效的 HTTP(S) 地址和 100 到 599 的预期状态码".into());
        }
        Ok(())
    }

    pub(crate) fn apply_dns(&self, config: &mut Value) -> AirResult<()> {
        config["ipv6"] = self.ipv6.into();
        config["tcp-concurrent"] = self.tcp_concurrent.into();
        let domestic_dns = [
            "https://223.5.5.5/dns-query",
            "https://120.53.53.53/dns-query",
            "223.5.5.5",
            "119.29.29.29",
        ];
        let effective_direct = if !self.direct_nameserver.is_empty() {
            Some(self.direct_nameserver.clone())
        } else if self.respect_rules {
            Some(domestic_dns.into_iter().map(str::to_owned).collect())
        } else {
            None
        };
        let mut dns = json!({
            "enable": true, "nameserver": self.nameserver, "ipv6": self.ipv6 && self.dns_ipv6,
            "use-system-hosts": self.use_system_hosts, "respect-rules": self.respect_rules,
        });
        for (domain, ip) in self.host_records()? {
            config["hosts"][domain.as_str()] = ip.into();
        }
        if config["hosts"].as_mapping().is_some_and(|hosts| !hosts.is_empty()) {
            dns["use-hosts"] = true.into();
        }
        if effective_direct.is_some() {
            dns["direct-nameserver-follow-policy"] = self.direct_follow_policy.into();
        }
        if self.dns_cache_algorithm != "auto" {
            dns["cache-algorithm"] = json!(self.dns_cache_algorithm);
        }
        for (key, list) in [
            ("default-nameserver", &self.default_nameserver),
            ("proxy-server-nameserver", &self.proxy_server_nameserver),
            ("fallback", &self.fallback),
            ("fake-ip-filter", &self.fake_ip_filter),
        ] {
            if !list.is_empty() {
                dns[key] = json!(list);
            }
        }
        if let Some(direct) = &effective_direct {
            dns["direct-nameserver"] = json!(direct);
        }
        if self.default_nameserver.is_empty()
            && self
                .nameserver
                .iter()
                .chain(&self.direct_nameserver)
                .chain(&self.proxy_server_nameserver)
                .chain(&self.fallback)
                .chain(self.domain_dns.iter().map(|entry| &entry.server))
                .any(|server| resolver_uses_hostname(server))
        {
            dns["default-nameserver"] = json!(DEFAULT_BOOTSTRAP_DNS);
        }
        if self.enhanced_mode == "fake-ip" && self.fake_ip_filter.is_empty() {
            dns["fake-ip-filter"] = json!(DEFAULT_FAKE_IP_FILTER);
        }
        if self.enhanced_mode != "auto" {
            dns["enhanced-mode"] = json!(self.enhanced_mode);
        }
        if !self.fallback.is_empty() {
            dns["fallback-filter"] = json!({ "geoip": self.fallback_domains.is_empty(), "domain": self.fallback_domains });
        }
        config["dns"] = serde_yaml::to_value(dns).expect("DNS fields serialize to YAML");
        if (self.respect_rules && effective_direct.is_some()) || !self.domain_dns.is_empty() {
            let mut policy = serde_yaml::Mapping::new();
            if self.respect_rules {
                if let Some(direct) = effective_direct {
                    let list = serde_yaml::to_value(direct)
                        .expect("domestic DNS list serializes to YAML");
                    policy.insert("geosite:cn,private".into(), list);
                }
            }
            for entry in &self.domain_dns {
                policy.insert(entry.domain.clone().into(), entry.server.clone().into());
            }
            config["dns"]["nameserver-policy"] = Value::Mapping(policy);
        }
        Ok(())
    }

    pub(crate) fn tun_ipv6_supported() -> bool {
        #[cfg(windows)]
        {
            crate::proxy::windows::tun_ipv6_available()
        }
        #[cfg(not(windows))]
        {
            true
        }
    }

    pub(crate) fn effective_route_exclude_address(&self, ipv6: bool) -> Vec<String> {
        let mut cidrs = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut push = |cidr: &str| {
            let trimmed = cidr.trim();
            if !trimmed.is_empty() && seen.insert(trimmed.to_ascii_lowercase()) {
                cidrs.push(trimmed.to_owned());
            }
        };
        if self.bypass_lan {
            for cidr in PRIVATE_IPV4_CIDRS {
                push(cidr);
            }
            if ipv6 {
                for cidr in PRIVATE_IPV6_CIDRS {
                    push(cidr);
                }
            }
        }
        for cidr in &self.route_exclude_address {
            push(cidr);
        }
        cidrs
    }

    pub fn tun_settings_changed(&self, other: &Self) -> bool {
        self.tun_stack != other.tun_stack
            || self.tun_mtu != other.tun_mtu
            || self.strict_route != other.strict_route
            || self.dns_hijack != other.dns_hijack
            || self.bypass_lan != other.bypass_lan
            || self.route_exclude_address != other.route_exclude_address
            || self.ipv6 != other.ipv6
    }

    pub fn port_or_bind_changed(&self, other: &Self) -> bool {
        self.mixed_port != other.mixed_port || self.allow_lan != other.allow_lan
    }

    fn comparable_core(&self) -> Self {
        Self {
            system_proxy_bypass: vec![],
            probe_url: String::new(),
            probe_status: 0,
            probe_interval_minutes: 0,
            ..self.clone()
        }
    }

    pub fn core_settings_changed(&self, other: &Self) -> bool {
        self.comparable_core() != other.comparable_core()
    }

    pub fn proxy_settings_changed(&self, other: &Self) -> bool {
        self.core_settings_changed(other) || self.system_proxy_bypass != other.system_proxy_bypass
    }

    pub(crate) fn tun(&self, enabled: bool) -> Json {
        // Always assign a TUN IPv6 interface/route when the host supports IPv6 so dual-stack
        // traffic cannot bypass Air-TUN when `ipv6` is off. `dns.ipv6` / `config.ipv6` remain gated.
        let capture_ipv6 = Self::tun_ipv6_supported();
        let mut tun = json!({
            "enable": enabled, "device": "Air-TUN", "stack": self.tun_stack, "auto-route": true,
            "auto-detect-interface": true, "strict-route": self.strict_route,
            "endpoint-independent-nat": true,
            "route-exclude-address": self.effective_route_exclude_address(capture_ipv6),
            "dns-hijack": if self.dns_hijack { vec!["any:53", "tcp://any:53"] } else { vec![] },
            "inet6-address": if capture_ipv6 { vec!["fdfe:dcba:9876::1/126"] } else { vec![] },
        });
        if let Some(mtu) = self.tun_mtu {
            tun["mtu"] = json!(mtu);
        }
        tun
    }

    pub(crate) fn apply_proxy(&self, yaml: &mut Value, tun: bool, current_pool: Option<&str>) -> AirResult<()> {
        self.apply_dns(yaml)?;
        // Mihomo derives the adapter's IPv4 address from the DNS pool, even in redir-host mode.
        #[cfg(windows)]
        {
            let pool = match current_pool {
                Some(active) => active.to_owned(),
                None if tun => crate::proxy::windows::free_tun_pool()?,
                None => format!("{}/20", crate::proxy::windows::PREFERRED_TUN_IP),
            };
            yaml["dns"]["fake-ip-range"] = pool.into();
        }
        #[cfg(not(windows))]
        let _ = current_pool;
        yaml["tun"] = serde_yaml::to_value(self.tun(tun)).expect("TUN fields serialize to YAML");
        yaml["allow-lan"] = self.allow_lan.into();
        yaml["bind-address"] = if self.allow_lan {
            "0.0.0.0"
        } else {
            "127.0.0.1"
        }
        .into();
        if self.allow_lan {
            yaml["lan-allowed-ips"] = serde_yaml::to_value([
                "127.0.0.0/8",
                "10.0.0.0/8",
                "172.16.0.0/12",
                "192.168.0.0/16",
            ])
            .unwrap();
        }
        Ok(())
    }
}

fn valid_resolver(value: &str, bootstrap: bool) -> bool {
    if value.is_empty() || value.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return false;
    }
    if value == "system" {
        return true;
    }
    if value.parse::<IpAddr>().is_ok() || value.parse::<SocketAddr>().is_ok_and(|a| a.port() > 0) {
        return true;
    }
    let Ok(url) = Url::parse(value) else {
        return false;
    };
    let Some(host) = url.host_str() else {
        return false;
    };
    matches!(url.scheme(), "https" | "tls" | "udp" | "tcp" | "quic")
        && url.port() != Some(0)
        && url.username().is_empty()
        && url.password().is_none()
        && (url.scheme() == "https" || matches!(url.path(), "" | "/"))
        && (!bootstrap || host.trim_matches(['[', ']']).parse::<IpAddr>().is_ok())
}

/// Copy only the resolver lists which the effective subscription actually specifies.
pub fn subscription_resolvers(
    text: &str,
) -> AirResult<std::collections::BTreeMap<String, Vec<String>>> {
    let yaml: Value = serde_yaml::from_str(text).map_err(|_| "订阅 YAML 无法解析")?;
    let mut copied = std::collections::BTreeMap::new();
    for (field, key) in [
        ("nameserver", "nameserver"),
        ("defaultNameserver", "default-nameserver"),
        ("directNameserver", "direct-nameserver"),
        ("proxyServerNameserver", "proxy-server-nameserver"),
    ] {
        let Some(value) = yaml["dns"].get(key) else {
            continue;
        };
        let list: Vec<String> = serde_yaml::from_value(value.clone())
            .map_err(|_| format!("订阅 dns.{key} 应为 DNS 地址列表"))?;
        if list.is_empty() && key == "nameserver" {
            return Err("订阅的主 DNS 列表为空".into());
        }
        if list
            .iter()
            .any(|v| !valid_resolver(v, key == "default-nameserver"))
        {
            return Err(format!("订阅 dns.{key} 含 Air Proxy 当前不支持的 DNS 地址"));
        }
        copied.insert(field.into(), list);
    }
    if copied.is_empty() {
        return Err("此订阅没有提供主 DNS、引导 DNS、直连 DNS 或节点 DNS 列表".into());
    }
    Ok(copied)
}

fn valid_pattern(value: &str) -> bool {
    let host = value
        .strip_prefix("+.")
        .or_else(|| value.strip_prefix("*."))
        .unwrap_or(value);
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|part| {
            !part.is_empty()
                && part.len() <= 63
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dns_override_only_replaces_selected_fields_and_tun_uses_same_profile() {
        let settings = NetworkSettings {
            nameserver: vec![
                "https://223.5.5.5/dns-query".into(),
                "https://doh.pub/dns-query".into(),
            ],
            dns_hijack: false,
            ipv6: false,
            strict_route: true,
            tun_stack: "mixed".into(),
            tun_mtu: Some(1400),
            route_exclude_address: vec!["10.0.0.0/8".into()],
            allow_lan: true,
            ..NetworkSettings::default()
        };
        settings.validate().unwrap();
        let mut yaml = Value::Mapping(Default::default());
        settings.apply_proxy(&mut yaml, true, Some("198.19.80.1/20")).unwrap();
        #[cfg(windows)]
        assert_eq!(yaml["dns"]["fake-ip-range"].as_str(), Some("198.19.80.1/20"));
        assert_eq!(
            yaml["dns"]["default-nameserver"].as_sequence().unwrap(),
            &vec![Value::from("223.5.5.5"), Value::from("119.29.29.29"), Value::from("1.1.1.1")]
        );
        assert_eq!(
            yaml["dns"]["direct-nameserver"].as_sequence().unwrap()[0],
            "https://223.5.5.5/dns-query"
        );
        assert_eq!(
            yaml["dns"]["nameserver-policy"]["geosite:cn,private"].as_sequence().unwrap()[0],
            "https://223.5.5.5/dns-query"
        );
        assert_eq!(yaml["dns"]["nameserver"].as_sequence().unwrap().len(), 2);
        assert_eq!(yaml["dns"]["ipv6"].as_bool(), Some(false));
        let mut no_rules = settings.clone();
        no_rules.respect_rules = false;
        let mut plain_yaml = Value::Mapping(Default::default());
        no_rules.apply_dns(&mut plain_yaml).unwrap();
        assert!(plain_yaml["dns"]["direct-nameserver"].is_null());
        assert!(plain_yaml["dns"]["nameserver-policy"].is_null());
        assert_eq!(yaml["tun"]["dns-hijack"].as_sequence().unwrap().len(), 0);
        assert_eq!(yaml["tun"]["stack"], "mixed");
        assert_eq!(yaml["tun"]["endpoint-independent-nat"].as_bool(), Some(true));
        assert_eq!(yaml["tun"]["route-exclude-address"][0], "10.0.0.0/8");
        let excludes: Vec<&str> = yaml["tun"]["route-exclude-address"]
            .as_sequence()
            .unwrap()
            .iter()
            .filter_map(|value| value.as_str())
            .collect();
        let mut expected = vec!["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16"];
        if NetworkSettings::tun_ipv6_supported() {
            expected.extend(["fc00::/7", "fe80::/10"]);
        }
        assert_eq!(excludes, expected);
        assert_eq!(
            yaml["tun"]["inet6-address"].as_sequence().unwrap().is_empty(),
            !NetworkSettings::tun_ipv6_supported()
        );
        assert_eq!(yaml["tun"]["strict-route"].as_bool(), Some(true));
        assert_eq!(yaml["tun"]["mtu"].as_u64(), Some(1400));
        assert_eq!(yaml["bind-address"], "0.0.0.0");
        assert!(yaml["lan-allowed-ips"]
            .as_sequence()
            .unwrap()
            .iter()
            .all(|ip| ip != "0.0.0.0/0"));
    }

    #[test]
    fn bypass_lan_and_strict_route_defaults_work_as_expected() {
        let parsed: NetworkSettings = serde_json::from_str("{}").unwrap();
        assert!(!parsed.strict_route);
        assert!(parsed.bypass_lan);

        let default_settings = NetworkSettings::default();
        assert!(!default_settings.strict_route);
        assert!(default_settings.bypass_lan);

        let excluded_v6 = default_settings.effective_route_exclude_address(true);
        assert!(excluded_v6.contains(&"10.0.0.0/8".to_owned()));
        assert!(excluded_v6.contains(&"172.16.0.0/12".to_owned()));
        assert!(excluded_v6.contains(&"192.168.0.0/16".to_owned()));
        assert!(excluded_v6.contains(&"169.254.0.0/16".to_owned()));
        assert!(excluded_v6.contains(&"fc00::/7".to_owned()));
        assert!(excluded_v6.contains(&"fe80::/10".to_owned()));
        assert!(!excluded_v6.contains(&"198.18.0.0/15".to_owned()));
        assert!(!excluded_v6.contains(&"100.64.0.0/10".to_owned()));

        let custom_only = NetworkSettings {
            bypass_lan: false,
            route_exclude_address: vec!["203.0.113.0/24".into()],
            ..NetworkSettings::default()
        };
        assert_eq!(
            custom_only.effective_route_exclude_address(true),
            vec!["203.0.113.0/24"]
        );
    }

    #[test]
    fn ip_only_dns_keeps_default_nameserver_unset_and_fallback_enables_geoip_filter() {
        let settings = NetworkSettings {
            nameserver: vec!["https://223.5.5.5/dns-query".into()],
            proxy_server_nameserver: vec!["223.5.5.5".into()],
            fallback: vec!["https://1.1.1.1/dns-query".into()],
            fallback_domains: vec![],
            ..NetworkSettings::default()
        };
        settings.validate().unwrap();
        let mut yaml = Value::Mapping(Default::default());
        settings.apply_dns(&mut yaml).unwrap();
        assert!(yaml["dns"]["default-nameserver"].is_null());
        assert_eq!(yaml["dns"]["fallback-filter"]["geoip"].as_bool(), Some(true));

        let domain_fallback = NetworkSettings {
            fallback_domains: vec!["+.google.com".into()],
            ..settings
        };
        let mut yaml2 = Value::Mapping(Default::default());
        domain_fallback.apply_dns(&mut yaml2).unwrap();
        assert_eq!(yaml2["dns"]["fallback-filter"]["geoip"].as_bool(), Some(false));
    }

    #[test]
    fn default_network_populates_domestic_dns_policy() {
        let settings = NetworkSettings::default();
        assert!(!settings.ipv6 && !settings.dns_ipv6);
        assert_eq!(settings.tun_stack, "mixed");
        let mut yaml = Value::Mapping(Default::default());
        settings.apply_dns(&mut yaml).unwrap();
        let direct = yaml["dns"]["direct-nameserver"].as_sequence().unwrap();
        assert!(!direct.is_empty());
        let policy = yaml["dns"]["nameserver-policy"]["geosite:cn,private"]
            .as_sequence()
            .unwrap();
        assert_eq!(policy, direct);
    }

    #[test]
    fn fake_ip_default_filter_and_block_quic_default() {
        let parsed: NetworkSettings = serde_json::from_str("{}").unwrap();
        assert!(parsed.block_quic);
        assert_eq!(parsed.enhanced_mode, "fake-ip");
        let mut yaml = Value::Mapping(Default::default());
        parsed.apply_dns(&mut yaml).unwrap();
        let filters = yaml["dns"]["fake-ip-filter"].as_sequence().unwrap();
        assert!(filters.iter().any(|item| item == "geosite:private"));
        assert!(filters.iter().any(|item| item == "geosite:cn"));
        assert!(filters.iter().any(|item| item == "stun.*.*"));
    }
}
