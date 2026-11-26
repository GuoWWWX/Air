use super::RoutingConfig;
use crate::{network::NetworkSettings, subscriptions::digest, AirResult};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_yaml::{Mapping, Value};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

const FILE_NAME: &str = "air-config.yaml";
const MAX_SIZE: u64 = 1024 * 1024;

fn legacy_node_dns() -> Vec<String> {
    vec!["https://223.5.5.5/dns-query".into(), "https://1.1.1.1/dns-query".into()]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub routing: RoutingConfig,
    pub revision: String,
    pub path: PathBuf,
}

pub struct RoutingFile(PathBuf);

#[derive(Serialize)]
pub struct ConfigSource {
    pub contents: String,
    pub revision: String,
}

#[derive(Serialize)]
pub struct NetworkDocument {
    pub settings: NetworkSettings,
    pub revision: String,
}

impl RoutingFile {
    pub fn new(directory: &Path) -> Self {
        Self(directory.join(FILE_NAME))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn load(&self) -> AirResult<Document> {
        let (mapping, contents) = self.read()?;
        let routing = section(&mapping, "routing")?;
        Ok(Document {
            routing,
            revision: digest(contents),
            path: self.0.clone(),
        })
    }

    pub fn save(&self, config: &RoutingConfig, expected_revision: &str) -> AirResult<Document> {
        self.save_section("routing", config, expected_revision)?;
        self.load()
    }

    pub fn network(&self) -> AirResult<NetworkDocument> {
        let (mapping, contents) = self.read()?;
        let settings = network_section(&mapping)?;
        Ok(NetworkDocument {
            settings,
            revision: digest(contents),
        })
    }

    pub fn validate_file(&self, sources: &[crate::subscriptions::Source]) -> AirResult<()> {
        Self::validate_text(&self.read_text()?, sources)
    }

    pub fn source(&self) -> AirResult<ConfigSource> {
        let contents = self.read_text()?;
        Ok(ConfigSource {
            revision: digest(&contents),
            contents,
        })
    }

    pub fn validate_text(
        contents: &str,
        sources: &[crate::subscriptions::Source],
    ) -> AirResult<()> {
        if contents.len() as u64 > MAX_SIZE {
            return Err("全局配置文件超过 1 MB".into());
        }
        let mapping = parse_mapping(contents)?;
        for key in [
            "dns",
            "nameserver",
            "proxies",
            "proxy-groups",
            "rules",
            "tun",
            "mixed-port",
        ] {
            if mapping.contains_key(key) {
                return Err(format!("顶层的 {key} 不是 Air Proxy 配置项。网络设置写在 network 下，分流设置写在 routing 下。"));
            }
        }
        network_section(&mapping)?.validate()?;
        section::<RoutingConfig>(&mapping, "routing")?.compile(sources)?;
        Ok(())
    }

    pub fn save_text(
        &self,
        contents: &str,
        revision: &str,
        sources: &[crate::subscriptions::Source],
    ) -> AirResult<String> {
        Self::validate_text(contents, sources)?;
        let previous = self.read_text()?;
        if digest(&previous) != revision {
            return Err("配置文件已更新，请重新读取后再保存".into());
        }
        self.replace(contents, &previous)?;
        Ok(digest(contents))
    }

    pub fn upgrade_factory_network(&self) -> AirResult<()> {
        let old_proxy_dns = legacy_node_dns();
        let old_v1_base = NetworkSettings {
            ipv6: true,
            dns_ipv6: true,
            tun_stack: "gvisor".into(),
            enhanced_mode: "redir-host".into(),
            block_quic: false,
            proxy_server_nameserver: old_proxy_dns.clone(),
            ..NetworkSettings::default()
        };
        let legacy = NetworkSettings {
            nameserver: vec!["system".into()],
            proxy_server_nameserver: vec![],
            enhanced_mode: "auto".into(),
            respect_rules: false,
            strict_route: false,
            tcp_concurrent: false,
            ..old_v1_base.clone()
        };
        let previous_windows = NetworkSettings {
            strict_route: true,
            ..old_v1_base.clone()
        };
        let v111_windows = NetworkSettings {
            enhanced_mode: "redir-host".into(),
            block_quic: false,
            proxy_server_nameserver: old_proxy_dns.clone(),
            ..NetworkSettings::default()
        };
        let v114_windows = NetworkSettings {
            proxy_server_nameserver: old_proxy_dns,
            ..NetworkSettings::default()
        };
        let mut templates = Vec::new();
        for candidate in [
            &legacy,
            &previous_windows,
            &old_v1_base,
            &v111_windows,
            &v114_windows,
        ] {
            let mut factory = serde_yaml::to_value(serde_json::json!({
                "routing": RoutingConfig::default(), "network": candidate,
            })).map_err(yaml_error)?;
            templates.push(serde_yaml::to_string(&factory).map_err(yaml_error)?);
            // Earlier automatic upgrades used save_section, which wrote network in struct order.
            factory["network"] = serde_yaml::to_value(candidate).map_err(yaml_error)?;
            templates.push(serde_yaml::to_string(&factory).map_err(yaml_error)?);
            let mut without_quic = serde_json::to_value(candidate)
                .map_err(|_| "无法序列化默认网络配置")?;
            if let Some(obj) = without_quic.as_object_mut() {
                obj.remove("blockQuic");
            }
            templates.push(
                serde_yaml::to_string(&serde_json::json!({
                    "routing": RoutingConfig::default(),
                    "network": without_quic,
                }))
                .map_err(yaml_error)?,
            );
            let mut network_val = serde_json::to_value(candidate)
                .map_err(|_| "无法序列化默认网络配置")?;
            if let Some(obj) = network_val.as_object_mut() {
                obj.remove("bypassLan");
                obj.remove("blockQuic");
            }
            templates.push(
                serde_yaml::to_string(&serde_json::json!({
                    "routing": RoutingConfig::default(),
                    "network": network_val,
                }))
                .map_err(yaml_error)?,
            );
        }
        let factory_text = |path: &Path| -> Option<String> {
            let size = fs::metadata(path).ok()?.len();
            if !templates.iter().any(|t| t.len() as u64 == size) { return None; }
            let contents = fs::read_to_string(path).ok()?;
            templates.contains(&contents).then_some(contents)
        };
        let Some(previous) = factory_text(self.path()) else { return Ok(()) };
        let backup = self.0.with_file_name("air-config.previous.yaml");
        if backup.try_exists().map_err(|_| "无法访问全局配置文件")? {
            if factory_text(&backup).is_none() { return Ok(()); }
        } else {
            Self::write(&backup, &previous, true).map_err(|_| "无法备份修改前的全局配置文件")?;
        }
        let contents = serde_yaml::to_string(&serde_json::json!({
            "routing": RoutingConfig::default(), "network": NetworkSettings::default(),
        })).map_err(yaml_error)?;
        Self::write(self.path(), &contents, false).map_err(|_| "无法保存全局配置文件")?;
        Ok(())
    }

    pub fn ensure_exists(&self) -> AirResult<()> {
        if self
            .path()
            .try_exists()
            .map_err(|_| "无法访问全局配置文件")?
        {
            return Ok(());
        }
        let defaults = serde_yaml::to_string(&serde_json::json!({
            "routing": RoutingConfig::default(),
            "network": NetworkSettings::default(),
        }))
        .map_err(yaml_error)?;
        match Self::write(self.path(), &defaults, true) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(()),
            Err(_) => Err("无法创建全局配置文件".into()),
        }
    }

    pub fn save_network(
        &self,
        settings: &NetworkSettings,
        revision: &str,
    ) -> AirResult<NetworkDocument> {
        settings.validate()?;
        self.save_section("network", settings, revision)?;
        self.network()
    }

    fn save_section(
        &self,
        key: &str,
        config: &impl Serialize,
        expected_revision: &str,
    ) -> AirResult<()> {
        let (mut mapping, previous) = self.read()?;
        if expected_revision != digest(&previous) {
            return Err("配置文件已更新，请重新读取后再保存".into());
        }
        mapping.insert(
            key.into(),
            serde_yaml::to_value(config).map_err(yaml_error)?,
        );
        let contents = serde_yaml::to_string(&mapping).map_err(yaml_error)?;
        if contents.len() as u64 > MAX_SIZE {
            return Err("全局配置文件超过 1 MB".into());
        }
        self.replace(&contents, &previous)
    }

    fn replace(&self, contents: &str, previous: &str) -> AirResult<()> {
        Self::write(
            &self.0.with_file_name("air-config.previous.yaml"),
            previous,
            false,
        )
        .map_err(|_| "无法备份修改前的全局配置文件")?;
        Self::write(self.path(), contents, false).map_err(|_| "无法保存全局配置文件")?;
        Ok(())
    }

    fn read(&self) -> AirResult<(Mapping, String)> {
        let contents = self.read_text()?;
        Ok((parse_mapping(&contents)?, contents))
    }

    fn read_text(&self) -> AirResult<String> {
        let file = match fs::File::open(&self.0) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.ensure_exists()?;
                fs::File::open(&self.0).map_err(|_| "无法读取全局配置文件")?
            }
            Err(_) => return Err("无法读取全局配置文件".into()),
        };
        let mut contents = String::new();
        file.take(MAX_SIZE + 1)
            .read_to_string(&mut contents)
            .map_err(|_| "无法读取全局配置文件，请检查 UTF-8 编码")?;
        if contents.len() as u64 > MAX_SIZE {
            return Err("全局配置文件超过 1 MB".into());
        }
        Ok(contents)
    }

    fn write(path: &Path, contents: &str, create: bool) -> io::Result<()> {
        let directory = path
            .parent()
            .ok_or_else(|| io::Error::other("missing configuration directory"))?;
        let mut temporary = tempfile::NamedTempFile::new_in(directory)?;
        temporary.write_all(contents.as_bytes())?;
        temporary.as_file().sync_all()?;
        if create {
            temporary.persist_noclobber(path)?;
        } else {
            temporary.persist(path)?;
        }
        Ok(())
    }
}

fn parse_mapping(contents: &str) -> AirResult<Mapping> {
    match serde_yaml::from_str(contents).map_err(yaml_error)? {
        Value::Mapping(mapping) => Ok(mapping),
        _ => Err("全局配置文件的根节点必须是 YAML 映射".into()),
    }
}

fn network_section(mapping: &Mapping) -> AirResult<NetworkSettings> {
    let Some(network) = mapping.get("network") else {
        return Ok(NetworkSettings::default());
    };
    let mut settings: NetworkSettings = section(mapping, "network")?;
    if network.get("proxyServerNameserver").is_none() {
        settings.proxy_server_nameserver = legacy_node_dns();
    }
    // New factory files write both choices explicitly. Older hand-edited files may omit them.
    if network.get("blockQuic").is_none() {
        settings.block_quic = false;
    }
    if network.get("enhancedMode").is_none() {
        settings.enhanced_mode = "redir-host".into();
    }
    if settings.proxy_server_nameserver.is_empty()
        && network.get("respectRules").is_none()
    {
        // Older partial configurations could leave node DNS empty and omit respectRules.
        settings.respect_rules = false;
    }
    Ok(settings)
}

fn section<T: DeserializeOwned + Default>(mapping: &Mapping, key: &str) -> AirResult<T> {
    mapping
        .get(key)
        .cloned()
        .map(serde_yaml::from_value)
        .transpose()
        .map_err(|e| format!("{key} 配置无效：{}", yaml_error(e)))
        .map(Option::unwrap_or_default)
}

fn yaml_error(error: serde_yaml::Error) -> String {
    let description = error.to_string();
    match error.location() {
        Some(location) => format!(
            "全局 YAML 第 {} 行第 {} 列：{description}",
            location.line(),
            location.column()
        ),
        None => format!("全局 YAML 配置无效：{description}"),
    }
}
