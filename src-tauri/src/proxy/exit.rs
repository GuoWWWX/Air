use crate::AirResult;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::{net::IpAddr, time::Duration};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Exit {
    ip: IpAddr,
    #[serde(skip_serializing_if = "Option::is_none")]
    country_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    city: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quality: Option<&'static str>,
}

#[derive(Deserialize)]
struct Metadata {
    ip: IpAddr,
    geo: Option<Location>,
    network: Option<Network>,
    risk: Option<Risk>,
}

#[derive(Default, Deserialize)]
struct Location {
    country: Option<String>,
    region: Option<String>,
    city: Option<String>,
}

#[derive(Deserialize)]
struct Network {
    usage_type: Option<String>,
}

#[derive(Deserialize)]
struct Risk {
    level: Option<String>,
}

impl Exit {
    fn new(ip: IpAddr) -> Self {
        Self {
            ip,
            country_code: None,
            region: None,
            city: None,
            kind: None,
            quality: None,
        }
    }

    fn with_metadata(mut self, data: Metadata) -> Self {
        if data.ip != self.ip {
            return self;
        }

        let location = data.geo.unwrap_or_default();
        self.country_code = location
            .country
            .filter(|code| code.len() == 2 && code.bytes().all(|byte| byte.is_ascii_uppercase()));
        self.region = location.region.filter(|value| !value.is_empty());
        self.city = location.city.filter(|value| !value.is_empty());
        self.kind = match data
            .network
            .and_then(|network| network.usage_type)
            .as_deref()
        {
            Some("IDC") => Some("datacenter"),
            Some("DYN") => Some("residential"),
            Some("MOB") => Some("mobile"),
            Some("GTW") => Some("gateway"),
            _ => None,
        };
        self.quality = match data.risk.and_then(|risk| risk.level).as_deref() {
            Some("none") => Some("noEvidence"),
            Some("low") => Some("lowRisk"),
            Some("medium") => Some("mediumRisk"),
            Some("high") => Some("highRisk"),
            _ => None,
        };
        self
    }
}

pub async fn lookup(port: u16) -> AirResult<Exit> {
    let proxy =
        reqwest::Proxy::all(format!("http://127.0.0.1:{port}")).map_err(|_| "无法配置出口检测")?;
    let client = Client::builder()
        .no_proxy()
        .proxy(proxy)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|_| "无法初始化出口检测")?;
    let ip = observed_ip(&client).await?;
    let exit = Exit::new(ip);
    Ok(match lookup_metadata(&client, ip).await {
        Ok(metadata) => exit.with_metadata(metadata),
        Err(_) => exit,
    })
}

pub(crate) async fn observed_ip(client: &Client) -> AirResult<IpAddr> {
    use futures_util::{stream::FuturesUnordered, StreamExt};
    let mut checks = FuturesUnordered::new();
    for (i, url) in [
        "https://api64.ipify.org?format=json",
        "https://www.cloudflare.com/cdn-cgi/trace",
        "https://api.ipapi.is/",
    ].into_iter().enumerate() {
        checks.push(async move {
            tokio::time::sleep(Duration::from_millis(i as u64 * 800)).await;
            if url.ends_with("/trace") {
                let text = client.get(url).send().await.ok()?.error_for_status().ok()?.text().await.ok()?;
                text.lines().find_map(|line| line.strip_prefix("ip=")?.trim().parse().ok())
            } else {
                lookup_address(client, url).await.ok()
            }
        });
    }
    while let Some(result) = checks.next().await {
        if let Some(ip) = result { return Ok(ip); }
    }
    Err("无法通过当前出站检测出口 IP".into())
}

async fn lookup_address(client: &Client, url: &str) -> Result<IpAddr, reqwest::Error> {
    #[derive(Deserialize)]
    struct Address {
        ip: IpAddr,
    }
    let Address { ip } = client
        .get(url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(ip)
}

async fn lookup_metadata(client: &Client, ip: IpAddr) -> Result<Metadata, reqwest::Error> {
    client
        .get(format!("https://ip99.com/v1/ip/{ip}"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn exit_network_type_and_reputation_are_independent() {
        let ip = "203.0.113.24".parse().unwrap();
        for (usage, risk, expected_kind, expected_quality) in [
            ("IDC", "none", "datacenter", "noEvidence"),
            ("DYN", "high", "residential", "highRisk"),
            ("MOB", "low", "mobile", "lowRisk"),
            ("GTW", "medium", "gateway", "mediumRisk"),
        ] {
            let metadata = serde_json::from_value(json!({
                "ip": ip,
                "geo": { "country": "JP", "city": "Tokyo", "region": "" },
                "network": { "usage_type": usage },
                "risk": { "level": risk },
            }))
            .unwrap();
            let exit = Exit::new(ip).with_metadata(metadata);
            assert_eq!(exit.country_code.as_deref(), Some("JP"));
            assert_eq!(exit.city.as_deref(), Some("Tokyo"));
            assert_eq!(exit.region, None);
            assert_eq!(exit.kind, Some(expected_kind));
            assert_eq!(exit.quality, Some(expected_quality));
        }
    }

    #[test]
    fn uses_only_metadata_for_the_observed_exit_address() {
        let ip = "203.0.113.24".parse().unwrap();
        let other = serde_json::from_value(json!({
            "ip": "203.0.113.25",
            "geo": { "country": "US" },
            "network": { "usage_type": "IDC" },
        }))
        .unwrap();
        let exit = Exit::new(ip).with_metadata(other);
        assert_eq!(exit.ip, ip);
        assert_eq!(exit.country_code, None);
        assert_eq!(exit.kind, None);
    }
}
