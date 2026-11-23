use crate::AirResult;
use serde_json::{Map, Value};

const CORE_FIELDS: &str = "mode find-process-mode profile log-level rules proxies proxy-groups rule-providers
    dns hosts ipv6 tcp-concurrent unified-delay keep-alive-idle keep-alive-interval disable-keep-alive sniffer
    tun mixed-port allow-lan bind-address lan-allowed-ips";
const PROXY_FIELDS: &str = "name type server port mport ports udp udp-over-tcp udp-over-tcp-version
    ip-version dialer-proxy tfo mux smux network uuid alterId alter-id cipher security flow packet-encoding
    xudp packet-addr global-padding authenticated-length tls servername sni skip-cert-verify
    fingerprint client-fingerprint alpn ech-opts reality-opts ws-opts grpc-opts h2-opts http-opts
    username password obfs obfs-password auth auth-str protocol protocol-param obfs-param
    up down up-speed down-speed initial-stream-receive-window max-stream-receive-window
    initial-connection-receive-window max-connection-receive-window disable-mtu-discovery hop-interval
    congestion-controller udp-relay-mode heartbeat request-timeout reduce-rtt fast-open max-open-streams
    idle-session-check-interval idle-session-timeout min-idle-session version plugin plugin-opts headers";
const GROUP_FIELDS: &str = "name type proxies url expected-status interval timeout lazy tolerance
    strategy disable-udp filter exclude-filter exclude-type include-all include-all-proxies
    max-failed-times hidden icon empty-fallback";
const DNS_FIELDS: &str = "enable ipv6 use-system-hosts use-hosts respect-rules nameserver default-nameserver
    direct-nameserver proxy-server-nameserver fallback fallback-filter fake-ip-filter fake-ip-range enhanced-mode
    nameserver-policy direct-nameserver-follow-policy cache-algorithm";
const TUN_FIELDS: &str = "enable device stack auto-route auto-detect-interface strict-route
    endpoint-independent-nat route-exclude-address dns-hijack inet6-address mtu";

fn fields<'a>(value: &'a Value, allowed: &str, label: &str) -> AirResult<&'a Map<String, Value>> {
    let values = value.as_object().ok_or_else(|| format!("虚拟网卡服务中的{label}格式无效"))?;
    if values.keys().any(|key| !allowed.split_ascii_whitespace().any(|item| item == key.as_str())) {
        return Err(format!("虚拟网卡服务中的{label}包含不受支持的字段"));
    }
    Ok(values)
}

fn proxy(value: &Value) -> AirResult<()> {
    let node = fields(value, PROXY_FIELDS, "节点")?;
    if !matches!(value["type"].as_str(),
        Some("vless" | "vmess" | "trojan" | "ss" | "ssr" | "hysteria" | "hysteria2"
            | "anytls" | "http" | "socks5" | "tuic" | "snell")
    ) {
        return Err("虚拟网卡服务不支持该节点协议".into());
    }
    if let Some(plugin) = node.get("plugin") {
        if !matches!(plugin.as_str(), Some("obfs" | "v2ray-plugin")) {
            return Err("虚拟网卡服务不支持该 Shadowsocks 插件".into());
        }
    }
    for (key, allowed) in [
        ("reality-opts", "public-key short-id support-x25519mlkem768"),
        ("ech-opts", "enable config query-server-name"),
        ("ws-opts", "path headers max-early-data early-data-header-name v2ray-http-upgrade v2ray-http-upgrade-fast-open"),
        ("grpc-opts", "grpc-service-name grpc-user-agent ping-interval"),
        ("h2-opts", "host path"),
        ("http-opts", "method path headers"),
        ("smux", "enabled protocol max-connections min-streams max-streams padding statistic only-tcp"),
        ("plugin-opts", "mode host path tls mux headers skip-cert-verify v2ray-http-upgrade v2ray-http-upgrade-fast-open"),
    ] {
        if let Some(options) = node.get(key) {
            fields(options, allowed, key)?;
        }
    }
    Ok(())
}

pub(super) fn runtime_config(mut value: Value) -> AirResult<serde_yaml::Value> {
    fields(&value, CORE_FIELDS, "内核")?;
    for node in value["proxies"].as_array().ok_or("虚拟网卡服务中的节点列表无效")? {
        proxy(node)?;
    }
    for group in value["proxy-groups"].as_array().ok_or("虚拟网卡服务中的分组列表无效")? {
        fields(group, GROUP_FIELDS, "分组")?;
    }
    fields(&value["profile"], "store-selected store-fake-ip", "缓存")?;
    fields(&value["dns"], DNS_FIELDS, "DNS")?;
    if let Some(filter) = value["dns"].get("fallback-filter") {
        fields(filter, "geoip domain", "备用 DNS")?;
    }
    fields(&value["tun"], TUN_FIELDS, "虚拟网卡")?;
    if value["tun"]["device"].as_str() != Some("Air-TUN") {
        return Err("虚拟网卡服务中的网卡名称无效".into());
    }
    if let Some(sniffer) = value.get("sniffer") {
        fields(
            sniffer,
            "enable force-dns-mapping parse-pure-ip override-destination sniff skip-domain force-domain",
            "域名嗅探",
        )?;
        if let Some(protocols) = sniffer.get("sniff") {
            let map = fields(protocols, "HTTP TLS QUIC", "嗅探协议")?;
            for (proto, opts) in map {
                fields(opts, "ports override-destination", proto)?;
            }
        }
    }
    if let Some(entries) = value.get_mut("rule-providers") {
        let providers = entries.as_object_mut().ok_or("虚拟网卡服务中的规则集无效")?;
        for (name, provider) in providers.iter_mut() {
            fields(provider, "type behavior format interval url path payload proxy size-limit", "规则集")?;
            match provider["type"].as_str() {
                Some("inline") => {
                    provider.as_object_mut().expect("rule provider was validated").remove("path");
                }
                Some("http")
                    if provider["url"].as_str().is_some_and(|url| {
                        reqwest::Url::parse(url).is_ok_and(|url| {
                            matches!(url.scheme(), "http" | "https") && url.has_host()
                        })
                    }) =>
                {
                    let key = crate::subscriptions::digest(format!(
                        "{name}\0{}\0{}\0{}",
                        provider["url"], provider["behavior"], provider["format"]
                    ));
                    provider["path"] = format!("rules/{key}.cache").into();
                }
                _ => return Err("虚拟网卡服务仅支持内联和远程规则集".into()),
            }
        }
    }
    serde_yaml::to_value(value).map_err(|_| "虚拟网卡服务无法读取内核配置".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config() -> Value {
        json!({
            "proxies": [{
                "name": "example", "type": "vless", "server": "example.com", "port": 443,
                "uuid": "b9df41f6-de8f-44d8-87d6-1c26110b360a",
                "tls": true, "reality-opts": { "public-key": "example", "short-id": "abcd" }
            }],
            "proxy-groups": [], "profile": {}, "dns": {}, "tun": { "device": "Air-TUN" },
        })
    }

    #[test]
    fn only_accepts_the_compiled_runtime_fields() {
        let mut normal = config();
        assert!(runtime_config(normal.clone()).is_ok());
        normal["external-controller"] = json!("0.0.0.0:9090");
        assert!(runtime_config(normal).is_err());
        let mut node_file = config();
        node_file["proxies"][0]["private-key"] = json!("example-path");
        assert!(runtime_config(node_file).is_err());
    }

    #[test]
    fn accepts_runtime_keepalive_sniffer_and_nat_fields_and_rejects_unknown_sniffer_keys() {
        let mut valid = config();
        valid["unified-delay"] = json!(true);
        valid["keep-alive-idle"] = json!(600);
        valid["keep-alive-interval"] = json!(15);
        valid["disable-keep-alive"] = json!(false);
        valid["tun"]["endpoint-independent-nat"] = json!(true);
        valid["sniffer"] = json!({
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
        });
        assert!(runtime_config(valid.clone()).is_ok());

        valid["sniffer"]["unexpected"] = json!(true);
        assert!(runtime_config(valid).is_err());
    }

    #[test]
    fn remote_rule_files_stay_in_the_service_workspace() {
        let mut source = config();
        source["rule-providers"] = json!({
            "test": { "type": "http", "behavior": "domain", "url": "https://example.com/rules", "path": "example-path" },
        });
        let path = runtime_config(source.clone()).unwrap()["rule-providers"]["test"]["path"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(path.starts_with("rules/") && path.ends_with(".cache"));
        source["rule-providers"]["test"]["url"] = "https://example.org/other".into();
        assert_ne!(
            runtime_config(source).unwrap()["rule-providers"]["test"]["path"],
            path.as_str()
        );
    }
}
