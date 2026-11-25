use crate::{
    monitoring::Probe,
    subscriptions::{Download, Usage},
    AirResult,
};
mod documents;
mod subscription_updates;
mod source_names;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::Path,
    sync::{Mutex, MutexGuard},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub struct Store {
    db: Mutex<Connection>,
    documents: documents::Documents,
}

#[derive(Default, serde::Deserialize, Serialize)]
pub struct StartupProxy {
    pub mode: crate::proxy::Mode,
    pub tun: bool,
    // Older databases contained a row only when the user requested autostart.
    #[serde(default = "legacy_autostart")]
    pub always_start: bool,
    #[serde(default)]
    pub running: bool,
    #[serde(default)]
    pub target: Option<crate::proxy::StartTarget>,
}

fn legacy_autostart() -> bool { true }

pub struct StoredSource {
    pub id: String,
    pub name: String,
    pub yaml: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDetails {
    pub auto_update: Option<bool>,
    pub interval_hours: Option<u16>,
    pub custom_hours: Option<u16>,
    pub kind: String,
    pub updated_at: i64,
    pub refresh_error: Option<String>,
    pub usage: Option<Usage>,
}

#[derive(Serialize)]
pub struct SourceDocument {
    pub original: String,
    pub local: Option<String>,
}

pub struct NodeOverride {
    pub id: String,
    pub name: String,
    pub server: String,
    pub port: u16,
}

#[derive(Default)]
pub struct Stats {
    pub status: Option<String>,
    pub latest_ms: Option<u64>,
    pub average_ms: Option<u64>,
    pub success: u64,
    pub total: u64,
    pub continuous_ms: Option<u64>,
}

impl Store {
    pub fn open(path: &Path) -> AirResult<Self> {
        let mut connection = Connection::open(path).map_err(|_| "无法打开 Air Proxy 本地数据库")?;
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .map_err(|_| "无法初始化订阅数据库")?;
        connection
            .execute_batch(include_str!("../../migrations/001_initial.sql"))
            .map_err(|_| "无法初始化 Air Proxy 本地数据库")?;
        source_names::repair_duplicates(&mut connection).map_err(|_| "无法整理同名订阅")?;
        let directory = path.parent().ok_or("无效的配置目录")?.join("subscriptions");
        let documents = documents::Documents::open(directory, &mut connection)?;
        Ok(Self { db: Mutex::new(connection), documents })
    }

    fn connection(&self) -> AirResult<MutexGuard<'_, Connection>> {
        self.db.lock().map_err(|_| "无法访问 Air Proxy 本地数据库".into())
    }

    pub fn system_proxy_preference(&self) -> AirResult<bool> {
        self.connection()?.query_row("SELECT system_proxy FROM proxy_preferences WHERE id=1", [], |row| row.get(0))
            .optional().map(|value| value.unwrap_or(cfg!(windows))).map_err(|_| "无法读取系统代理偏好".into())
    }

    pub fn save_system_proxy_preference(&self, enabled: bool) -> AirResult<()> {
        self.connection()?.execute("INSERT OR REPLACE INTO proxy_preferences (id,system_proxy) VALUES (1,?1)", [enabled])
            .map(|_| ()).map_err(|_| "无法保存系统代理偏好".into())
    }

    pub fn startup_proxy(&self) -> AirResult<StartupProxy> {
        let saved: Option<String> = self.connection()?.query_row("SELECT settings FROM startup_proxy WHERE id=1", [], |row| row.get(0))
            .optional().map_err(|_| "无法读取启动代理设置")?;
        saved.map(|text| serde_json::from_str(&text).map_err(|_| "启动代理设置格式无效".to_string()))
            .transpose().map(Option::unwrap_or_default)
    }

    pub fn save_startup_proxy(&self, settings: &StartupProxy) -> AirResult<()> {
        let json = serde_json::to_string(settings).map_err(|_| "启动代理设置格式无效")?;
        self.connection()?.execute("INSERT INTO startup_proxy (id,settings) VALUES (1,?1) ON CONFLICT(id) DO UPDATE SET settings=excluded.settings", [json])
            .map(|_| ()).map_err(|_| "无法保存启动代理设置".into())
    }

    // Older versions stored only the displayed name. An exact URL host was their default.
    fn resolve_remote_name(db: &Connection, id: &str, requested: &str, url: &str, title: Option<&str>) -> AirResult<(String, bool)> {
        if !requested.trim().is_empty() { return Ok((requested.trim().into(), false)); }
        let parsed = reqwest::Url::parse(url).map_err(|_| "请输入有效的订阅链接")?;
        let host = parsed.host_str().ok_or("订阅链接缺少主机名")?;
        let previous = db.query_row(
            "SELECT COALESCE(a.base_name,s.name),n.automatic,d.encrypted_url FROM sources s LEFT JOIN source_name_aliases a ON a.source_id=s.id LEFT JOIN source_naming n ON n.source_id=s.id LEFT JOIN source_details d ON d.source_id=s.id WHERE s.id=?1",
            [id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<bool>>(1)?, r.get::<_, Option<Vec<u8>>>(2)?)),
        ).optional().map_err(|_| "无法读取订阅名称")?;
        if let Some((name, automatic, bytes)) = previous {
            let old_url = bytes.as_deref().map(decode).transpose()?.and_then(|v| reqwest::Url::parse(&v).ok());
            let old_host = old_url.as_ref().and_then(|u| u.host_str());
            if !automatic.unwrap_or(old_host == Some(name.as_str())) { return Ok((name, false)); }
            if title.is_none() && old_host == Some(host) { return Ok((name, true)); }
        }
        Ok((title.unwrap_or(host).into(), true))
    }

    pub fn import_id_for_url(&self, url: &str) -> AirResult<String> {
        let target = reqwest::Url::parse(url).map_err(|_| "请输入有效的订阅链接")?;
        let db = self.connection()?;
        let mut query = db.prepare("SELECT s.id,d.encrypted_url FROM sources s LEFT JOIN source_details d ON s.id=d.source_id ORDER BY s.rowid")
            .map_err(|_| "无法读取订阅来源")?;
        let rows = query.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<Vec<u8>>>(1)?)))
            .map_err(|_| "无法读取订阅来源")?;
        let mut occupied = std::collections::HashSet::new();
        for row in rows {
            let (id, encrypted_url) = row.map_err(|_| "无法读取订阅来源")?;
            if let Some(bytes) = encrypted_url {
                if reqwest::Url::parse(&decode(&bytes)?).ok().as_ref() == Some(&target) { return Ok(id); }
            }
            occupied.insert(id);
        }
        let mut id = crate::subscriptions::digest(format!("url:{url}"));
        // Editing a link keeps its source ID so that node selections and rules remain valid.
        while occupied.contains(&id) { id = crate::subscriptions::digest(format!("url:{url}:{id}")); }
        Ok(id)
    }

    pub fn preview_source_name(&self, id: &str, requested: &str, url: &str, title: Option<&str>) -> AirResult<String> {
        let db = self.connection()?;
        let (base, _) = Self::resolve_remote_name(&db, id, requested, url, title)?;
        source_names::display_name(&db, id, &base).map_err(|_| "无法读取订阅名称".into())
    }

    pub fn preview_file_name(&self, id: &str, name: &str) -> AirResult<String> {
        let db = self.connection()?;
        source_names::display_name(&db, id, name).map_err(|_| "无法读取订阅名称".into())
    }

    pub fn save_source(
        &self,
        id: &str,
        name: &str,
        download: &Download,
        kind: &str,
        url: Option<&str>,
    ) -> AirResult<String> {
        let usage = download
            .usage
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(|_| "无法保存订阅流量信息")?;
        let encrypted_url = url
            .map(|value| protect(value.as_bytes(), true))
            .transpose()?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_| "订阅保存失败")?;
        let bytes = self.documents.write(&download.yaml)?;
        let (base, automatic) = match url {
            Some(url) => Self::resolve_remote_name(&transaction, id, name, url, download.profile_title.as_deref())?,
            None => (name.to_owned(), false),
        };
        let name = source_names::display_name(&transaction, id, &base).map_err(|_| "无法生成订阅名称")?;
        transaction.execute(
            "INSERT INTO sources (id,name,encrypted_yaml) VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET name=excluded.name, encrypted_yaml=excluded.encrypted_yaml",
            params![id, name, bytes],
        ).map_err(|_| "订阅保存失败")?;
        source_names::save_base(&transaction, id, &base, &name).map_err(|_| "订阅名称保存失败")?;
        transaction.execute(
            "INSERT INTO source_details VALUES (?1,?2,?3,?4,NULL,?5) ON CONFLICT(source_id) DO UPDATE SET kind=excluded.kind, encrypted_url=excluded.encrypted_url, updated_at=excluded.updated_at, refresh_error=NULL, usage=excluded.usage",
            params![id, kind, encrypted_url, now_ms(), usage],
        ).map_err(|_| "订阅保存失败")?;
        if url.is_some() {
            transaction.execute("INSERT OR REPLACE INTO source_naming(source_id,automatic) VALUES (?1,?2)", params![id,automatic]).map_err(|_| "订阅名称保存失败")?;
            let hours = download.interval_hours.filter(|n| (1..=720).contains(n)).unwrap_or(24);
            transaction.execute("INSERT INTO subscription_updates(source_id,enabled,hours) VALUES (?1,1,?2) ON CONFLICT(source_id) DO UPDATE SET hours=excluded.hours", params![id,hours]).map_err(|_| "更新计划保存失败")?;
        }
        let has_local: bool = transaction.query_row("SELECT encrypted_local_yaml IS NOT NULL FROM sources WHERE id=?1", [id], |r| r.get(0)).map_err(|_| "读取本地配置失败")?;
        if !has_local { self.render_extension(&transaction, id, &download.yaml)?; }
        transaction.commit().map_err(|_| "订阅保存失败")?;
        self.documents.after_commit(&mut connection);
        Ok(name)
    }

    pub fn source_details(&self) -> AirResult<HashMap<String, SourceDetails>> {
        let connection = self.connection()?;
        let mut query = connection
            .prepare("SELECT d.source_id,kind,updated_at,refresh_error,usage,u.enabled,u.hours,u.custom_hours FROM source_details d LEFT JOIN subscription_updates u ON d.source_id=u.source_id")
            .map_err(|_| "无法读取订阅信息")?;
        let rows = query
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    SourceDetails {
                        auto_update: row.get(5)?, interval_hours: row.get(6)?, custom_hours: row.get(7)?,
                        kind: row.get(1)?,
                        updated_at: row.get(2)?,
                        refresh_error: row.get(3)?,
                        usage: row
                            .get::<_, Option<String>>(4)?
                            .and_then(|text| serde_json::from_str(&text).ok()),
                    },
                ))
            })
            .map_err(|_| "无法读取订阅信息")?;
        rows.map(|row| row.map_err(|_| "无法读取订阅信息".into()))
            .collect()
    }

    pub fn source_url(&self, id: &str) -> AirResult<Option<String>> {
        let value: Option<Vec<u8>> = self
            .connection()?
            .query_row(
                "SELECT encrypted_url FROM source_details WHERE source_id=?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "无法读取订阅链接")?
            .flatten();
        value.map(|bytes| decode(&bytes)).transpose()
    }

    pub fn source_document(&self, id: &str) -> AirResult<SourceDocument> {
        let db = self.connection()?;
        let (original, local): (Vec<u8>, Option<Vec<u8>>) = db
            .query_row(
                "SELECT encrypted_yaml,encrypted_local_yaml FROM sources WHERE id=?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| "无法读取订阅 YAML")?;
        Ok(SourceDocument {
            original: self.documents.read(&original)?,
            local: local.map(|bytes| self.documents.read(&bytes)).transpose()?,
        })
    }

    pub fn set_refresh_error(&self, id: &str, error: &str) -> AirResult<()> {
        self.connection()?
            .execute(
                "UPDATE source_details SET refresh_error=?2 WHERE source_id=?1",
                params![id, error],
            )
            .map_err(|_| "无法保存刷新状态")?;
        Ok(())
    }

    pub fn rename_source(&self, id: &str, name: &str) -> AirResult<()> {
        let mut db = self.connection()?;
        let tx = db.transaction().map_err(|_| "订阅改名失败")?;
        let before: String = tx.query_row("SELECT name FROM sources WHERE id=?1", [id], |r| r.get(0))
            .map_err(|_| "订阅已不存在")?;
        if before != name {
            let display = source_names::display_name(&tx, id, name).map_err(|_| "订阅改名失败")?;
            tx.execute("UPDATE sources SET name=?2 WHERE id=?1", params![id,display]).map_err(|_| "订阅改名失败")?;
            source_names::save_base(&tx, id, name, &display).map_err(|_| "订阅改名失败")?;
            tx.execute("INSERT OR REPLACE INTO source_naming(source_id,automatic) VALUES (?1,0)", [id])
                .map_err(|_| "订阅改名失败")?;
        }
        tx.commit().map_err(|_| "订阅改名失败")?;
        Ok(())
    }

    pub fn delete_source(&self, id: &str) -> AirResult<()> {
        let mut db = self.connection()?;
        db.execute("DELETE FROM sources WHERE id=?1", [id])
            .map_err(|_| "删除订阅失败")?;
        self.documents.after_commit(&mut db);
        Ok(())
    }

    pub fn use_original_yaml(&self, id: &str) -> AirResult<()> {
        let original = self.source_document(id)?.original;
        let mut db = self.connection()?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_| "无法恢复订阅")?;
        self.render_extension(&tx, id, &original)?;
        let changed = tx.execute(
                "UPDATE sources SET encrypted_local_yaml=NULL WHERE id=?1",
                [id],
            )
            .map_err(|_| "恢复订阅原文失败")?;
        if changed == 0 {
            return Err("订阅已不存在".into());
        }
        tx.commit().map_err(|_| "无法恢复订阅")?;
        self.documents.after_commit(&mut db);
        Ok(())
    }

    pub fn effective_source_yaml(&self, id: &str) -> AirResult<Option<String>> {
        let connection = self.connection()?;
        let reference = connection.query_row(
            "SELECT coalesce(e.rendered,s.encrypted_local_yaml,s.encrypted_yaml) FROM sources s LEFT JOIN subscription_extensions e ON e.source_id=s.id WHERE s.id=?1",
            [id], |row| row.get::<_, Vec<u8>>(0),
        ).optional().map_err(|_| "无法读取订阅 YAML")?;
        reference.as_deref().map(|bytes| self.documents.read(bytes)).transpose()
    }

    pub fn sources(&self) -> AirResult<Vec<StoredSource>> {
        let connection = self.connection()?;
        let mut query = connection.prepare("SELECT s.id,s.name,coalesce(e.rendered,s.encrypted_local_yaml,s.encrypted_yaml) FROM sources s LEFT JOIN subscription_extensions e ON e.source_id=s.id ORDER BY s.rowid")
            .map_err(|_| "无法读取订阅列表")?;
        let rows = query
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            })
            .map_err(|_| "无法读取订阅列表")?;
        rows.map(|row| {
            let (id, name, bytes) = row.map_err(|_| "订阅读取失败")?;
            let yaml = self.documents.read(&bytes)?;
            Ok(StoredSource { id, name, yaml })
        })
        .collect()
    }

    pub fn save_local_yaml(&self, source_id: &str, yaml: &str) -> AirResult<()> {
        let mut db = self.connection()?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(|_| "无法保存 YAML")?;
        let bytes = self.documents.write(yaml)?;
        self.render_extension(&tx, source_id, yaml)?;
        let changed = tx.execute(
                "UPDATE sources SET encrypted_local_yaml=?2 WHERE id=?1",
                params![source_id, bytes],
            )
            .map_err(|_| "YAML 保存失败")?;
        if changed == 0 {
            return Err("订阅已不存在".into());
        }
        tx.commit().map_err(|_| "无法保存 YAML")?;
        self.documents.after_commit(&mut db);
        Ok(())
    }

    pub fn node_overrides(&self) -> AirResult<Vec<NodeOverride>> {
        let connection = self.connection()?;
        let mut query = connection
            .prepare("SELECT node_id,display_name,server,port FROM node_overrides ORDER BY node_id")
            .map_err(|_| "无法读取节点覆写")?;
        let rows = query
            .query_map([], |row| {
                Ok(NodeOverride {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    server: row.get(2)?,
                    port: row.get(3)?,
                })
            })
            .map_err(|_| "无法读取节点覆写")?;
        rows.map(|row| row.map_err(|_| "无法读取节点覆写".into()))
            .collect()
    }

    pub fn save_override(&self, source_id: &str, node: &NodeOverride) -> AirResult<()> {
        let mut db = self.connection()?;
        let tx = db.transaction().map_err(|_| "无法保存节点修改")?;
        tx.execute("UPDATE subscription_updates SET enabled=0 WHERE source_id=?1", [source_id]).map_err(|_| "无法暂停订阅更新")?;
        tx
            .execute(
                "INSERT OR REPLACE INTO node_overrides VALUES (?1,?2,?3,?4)",
                params![node.id, node.name, node.server, node.port],
            )
            .map_err(|_| "节点覆写保存失败")?;
        tx.commit().map_err(|_| "无法保存节点修改".into())
    }

    pub fn reset_override(&self, id: &str) -> AirResult<()> {
        self.connection()?
            .execute("DELETE FROM node_overrides WHERE node_id=?1", [id])
            .map_err(|_| "恢复订阅值失败")?;
        Ok(())
    }

    pub fn save_probe(&self, id: &str, revision: &str, probe: &Probe) -> AirResult<()> {
        self.connection()?
            .execute(
                "INSERT OR REPLACE INTO probe_samples VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    id,
                    revision,
                    now_ms(),
                    probe.status(),
                    probe.latency().map(|ms| ms.min(i64::MAX as u64) as i64)
                ],
            )
            .map_err(|_| "探测结果保存失败")?;
        Ok(())
    }

    pub fn probe_schedule(
        &self,
        revisions: &HashMap<String, String>,
        interval: Duration,
    ) -> AirResult<(Vec<String>, Duration)> {
        let connection = self.connection()?;
        let mut query = connection
            .prepare_cached(
                "SELECT captured_at FROM probe_samples WHERE node_id=?1 AND revision=?2 \
                 ORDER BY captured_at DESC LIMIT 1",
            )
            .map_err(|_| "无法读取最近测速时间")?;
        let current = now_ms();
        let mut due = Vec::new();
        let mut next = interval;
        for (id, revision) in revisions {
            let last = query
                .query_row(params![id, revision], |row| row.get::<_, i64>(0))
                .optional()
                .map_err(|_| "无法读取最近测速时间")?;
            let remaining = last.map_or(Duration::ZERO, |last| {
                let elapsed = Duration::from_millis(current.saturating_sub(last).max(0) as u64);
                interval.saturating_sub(elapsed)
            });
            if remaining.is_zero() {
                due.push(id.clone());
            } else {
                next = next.min(remaining);
            }
        }
        Ok((due, next))
    }

    pub fn migrate_probe_samples(
        &self,
        previous_revision: &str,
        revisions: &HashMap<String, String>,
    ) -> AirResult<()> {
        // Only the exact legacy library revision identifies the current node configurations.
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(|_| "无法迁移探测记录")?;
        {
            let mut copy = transaction.prepare(
                "INSERT OR IGNORE INTO probe_samples SELECT node_id, ?3, captured_at, status, latency_ms \
                 FROM probe_samples WHERE node_id=?1 AND revision=?2",
            ).map_err(|_| "无法迁移探测记录")?;
            for (id, revision) in revisions {
                copy.execute(params![id, previous_revision, revision])
                    .map_err(|_| "无法迁移探测记录")?;
            }
        }
        transaction.commit().map_err(|_| "无法迁移探测记录".into())
    }

    pub fn stats<'a>(
        &self,
        revisions: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> AirResult<HashMap<String, Stats>> {
        let connection = self.connection()?;
        let mut query = connection
            .prepare_cached(
                "SELECT captured_at, status, latency_ms FROM probe_samples \
             WHERE node_id=?1 AND revision=?2 AND captured_at>=?3 ORDER BY captured_at DESC",
            )
            .map_err(|_| "无法读取探测记录")?;
        let current = now_ms();
        let mut result = HashMap::new();
        for (id, revision) in revisions {
            let rows = query
                .query_map(
                    params![id, revision, current.saturating_sub(86_400_000)],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<i64>>(2)?,
                        ))
                    },
                )
                .map_err(|_| "无法读取探测记录")?;
            let mut item = Accumulator::default();
            for row in rows {
                let (time, status, latency) = row.map_err(|_| "无法读取探测记录")?;
                item.add(
                    current as u64,
                    time.max(0) as u64,
                    status,
                    latency.and_then(|value| u64::try_from(value).ok()),
                );
            }
            if item.stats.total > 0 {
                item.stats.average_ms = item.sum.checked_div(item.stats.success);
                result.insert(id.to_owned(), item.stats);
            }
        }
        Ok(result)
    }

    pub fn prune_samples(&self) -> AirResult<()> {
        self.connection()?
            .execute(
                "DELETE FROM probe_samples WHERE captured_at<?1",
                [now_ms().saturating_sub(86_400_000)],
            )
            .map_err(|_| "清理过期探测记录失败")?;
        Ok(())
    }
}

#[derive(Default)]
struct Accumulator {
    stats: Stats,
    sum: u64,
    run: Option<(u64, u64)>,
}

impl Accumulator {
    fn add(&mut self, now: u64, time: u64, status: String, latency: Option<u64>) {
        const MAX_GAP_MS: u64 = 600_000;
        if self.stats.total == 0 {
            self.stats.status = Some(status);
            self.stats.latest_ms = latency;
            if latency.is_some() && now.saturating_sub(time) <= MAX_GAP_MS {
                self.run = Some((time, time));
            }
        }
        self.stats.total += 1;
        if let Some(ms) = latency {
            self.stats.success += 1;
            self.sum += ms;
        }
        if let Some((last, previous)) = self.run {
            if latency.is_some() && previous.saturating_sub(time) <= MAX_GAP_MS {
                self.stats.continuous_ms = Some(last.saturating_sub(time));
                self.run = Some((last, time));
            } else {
                self.run = None;
            }
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn decode(bytes: &[u8]) -> AirResult<String> {
    String::from_utf8(protect(bytes, false)?).map_err(|_| "本地订阅编码无效".into())
}

#[cfg(windows)]
fn protect(input: &[u8], encrypt: bool) -> AirResult<Vec<u8>> {
    use std::{ptr, slice};
    use windows_sys::Win32::{
        Foundation::LocalFree,
        Security::Cryptography::{
            CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
        },
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: input.len() as u32,
        pbData: input.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    // DPAPI encrypts for the current Windows user and allocates its output with LocalAlloc.
    unsafe {
        let ok = if encrypt {
            CryptProtectData(
                &input,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 || output.pbData.is_null() {
            return Err("Windows 无法保护或解密本地订阅".into());
        }
        let bytes = slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData.cast());
        Ok(bytes)
    }
}

#[cfg(not(windows))]
fn protect(_: &[u8], _: bool) -> AirResult<Vec<u8>> {
    Err("订阅加密存储目前支持 Windows".into())
}
