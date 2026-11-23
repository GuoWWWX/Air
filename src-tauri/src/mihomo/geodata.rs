use crate::AirResult;
use serde_yaml::Value;
use std::path::Path;

const DATABASES: [(&str, &str, &[u8]); 2] = [
    (
        "GEOSITE",
        "GeoSite.dat",
        include_bytes!(concat!(env!("OUT_DIR"), "/geosite.dat")),
    ),
    (
        "GEOIP",
        "geoip.metadb",
        include_bytes!(concat!(env!("OUT_DIR"), "/geoip.metadb")),
    ),
];

pub(super) fn stage(config: &Value, directory: &Path) -> AirResult<bool> {
    let providers = || {
        config["rule-providers"]
            .as_mapping()
            .into_iter()
            .flat_map(|map| map.values())
    };
    let remote_classical = providers().any(|provider| {
        provider["type"].as_str() == Some("http")
            && provider["behavior"].as_str() == Some("classical")
    });
    let mut missing = false;
    for (kind, name, bytes) in DATABASES {
        let policy_keys = config["dns"]["nameserver-policy"]
            .as_mapping()
            .into_iter()
            .flat_map(|map| map.keys())
            .filter_map(Value::as_str);
        let fake_ip_filters = config["dns"]["fake-ip-filter"]
            .as_sequence()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str);
        let fallback_geoip = kind == "GEOIP"
            && config["dns"]["fallback-filter"]["geoip"].as_bool() == Some(true);
        let required = fallback_geoip || config["rules"]
            .as_sequence()
            .into_iter()
            .flatten()
            .chain(
                providers()
                    .flat_map(|provider| provider["payload"].as_sequence().into_iter().flatten()),
            )
            .filter_map(Value::as_str)
            .chain(policy_keys)
            .chain(fake_ip_filters)
            .any(|rule| {
                rule.split([':', ',', '(', ')'])
                    .any(|part| part.trim().eq_ignore_ascii_case(kind))
            });
        if !required && !remote_classical {
            continue;
        }
        let file = directory.join(name);
        if file.is_file() {
            continue;
        }
        if bytes.is_empty() {
            missing |= required;
        } else {
            std::fs::write(file, bytes).map_err(|_| format!("无法准备 Mihomo 的 {name} 数据库"))?;
        }
    }
    Ok(missing)
}

#[cfg(test)]
mod stage_tests {
    use super::stage;

    #[test]
    fn dns_policy_geosite_requires_geosite_staging() {
        let dir = tempfile::tempdir().unwrap();
        let config = serde_yaml::to_value(serde_json::json!({
            "dns": {
                "nameserver-policy": {
                    "geosite:cn,private": ["223.5.5.5"]
                }
            },
            "rules": ["MATCH,DIRECT"]
        }))
        .unwrap();
        let _ = stage(&config, dir.path());
        if !super::DATABASES[0].2.is_empty() {
            assert!(dir.path().join("GeoSite.dat").is_file());
        }
    }

    #[test]
    fn fallback_filter_geoip_requires_geoip_staging() {
        let dir = tempfile::tempdir().unwrap();
        let config = serde_yaml::to_value(serde_json::json!({
            "dns": {
                "fallback": ["https://1.1.1.1/dns-query"],
                "fallback-filter": {
                    "geoip": true,
                    "domain": []
                }
            },
            "rules": ["MATCH,DIRECT"]
        }))
        .unwrap();
        let _ = stage(&config, dir.path());
        if !super::DATABASES[1].2.is_empty() {
            assert!(dir.path().join("geoip.metadb").is_file());
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::super::Kernel;
    use std::{net::Ipv4Addr, path::PathBuf, time::Duration};
    use tokio::{net::TcpListener, time::timeout};

    #[tokio::test]
    #[ignore = "requires the bundled Windows Mihomo executable and staged geodata"]
    async fn cold_start_loads_geo_rules_without_downloading() {
        let download_listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let blocked_url = format!("http://{}/geo", download_listener.local_addr().unwrap());
        let config = serde_yaml::to_value(serde_json::json!({
            "mode": "rule",
            "geox-url": {"geosite": blocked_url, "mmdb": blocked_url},
            "rules": ["GEOSITE,cn,DIRECT", "GEOIP,CN,DIRECT,no-resolve", "MATCH,REJECT"],
        }))
        .unwrap();
        let core =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.cache/air/windows-x64/mihomo.exe");
        let directory = tempfile::tempdir().unwrap();
        let (mut kernel, _) = Kernel::start_proxy(&core, directory.path(), config, None, false)
            .await
            .unwrap();
        assert!(kernel.running());
        assert!(
            timeout(Duration::from_millis(250), download_listener.accept())
                .await
                .is_err()
        );
        kernel.stop().await.unwrap();
    }
}
