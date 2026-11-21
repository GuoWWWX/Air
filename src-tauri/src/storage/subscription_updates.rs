use super::*;
use crate::subscriptions::extension::Extension;

impl Store {
    pub fn initialize_updates(&self, sources: &[crate::subscriptions::Source]) -> AirResult<()> {
        let modified: std::collections::HashSet<_> =
            self.node_overrides()?.into_iter().map(|n| n.id).collect();
        let mut db = self.connection()?;
        let tx = db.transaction().map_err(|_| "无法迁移订阅更新计划")?;
        for s in sources {
            let clean = !s.nodes.iter().any(|n| modified.contains(&n.id));
            tx.execute("INSERT OR IGNORE INTO subscription_updates(source_id,enabled)
                SELECT s.id, (?2 AND s.encrypted_local_yaml IS NULL) FROM sources s JOIN source_details d ON s.id=d.source_id
                WHERE s.id=?1 AND d.encrypted_url IS NOT NULL", params![s.id,clean]).map_err(|_| "无法迁移订阅更新计划")?;
        }
        tx.commit().map_err(|_| "无法迁移订阅更新计划".into())
    }

    pub fn set_subscription_update(
        &self,
        id: &str,
        enabled: bool,
        hours: Option<u16>,
    ) -> AirResult<()> {
        if hours.is_some_and(|n| !(1..=720).contains(&n)) {
            return Err("间隔应为 1 到 720 小时".into());
        }
        let rows = self
            .connection()?
            .execute(
                "UPDATE subscription_updates SET enabled=?2,custom_hours=?3 WHERE source_id=?1",
                params![id, enabled, hours],
            )
            .map_err(|_| "无法修改订阅自动更新")?;
        if rows == 0 {
            return Err("此来源没有可更新的链接".into());
        }
        Ok(())
    }

    pub fn due_subscriptions(&self) -> AirResult<Vec<String>> {
        let db = self.connection()?;
        let mut q = db.prepare("SELECT d.source_id FROM source_details d JOIN subscription_updates u USING(source_id)
            WHERE u.enabled AND d.encrypted_url IS NOT NULL AND d.updated_at+COALESCE(u.custom_hours,u.hours)*3600000<=?1 AND u.attempted+900000<=?1
            ORDER BY d.updated_at").map_err(|_| "无法读取更新计划")?;
        let rows = q
            .query_map([now_ms()], |r| r.get(0))
            .map_err(|_| "无法读取更新计划")?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|_| "无法读取更新计划".into())
    }

    pub fn record_subscription_attempt(&self, id: &str) -> AirResult<()> {
        self.connection()?
            .execute(
                "UPDATE subscription_updates SET attempted=?2 WHERE source_id=?1",
                params![id, now_ms()],
            )
            .map(|_| ())
            .map_err(|_| "无法保存刷新时间".into())
    }

    fn extension_in(db: &Connection, id: &str) -> AirResult<Extension> {
        let bytes: Option<Vec<u8>> = db
            .query_row(
                "SELECT definition FROM subscription_extensions WHERE source_id=?1",
                [id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|_| "无法读取扩展")?;
        match bytes {
            Some(bytes) => {
                serde_json::from_str(&decode(&bytes)?).map_err(|_| "订阅扩展格式无效".into())
            }
            None => Ok(Extension::default()),
        }
    }

    pub fn extension(&self, id: &str) -> AirResult<Extension> {
        let db = self.connection()?;
        Self::extension_in(&db, id)
    }

    pub(super) fn render_extension(db: &Connection, id: &str, yaml: &str) -> AirResult<()> {
        let ext = Self::extension_in(db, id)?;
        if !ext.empty() {
            let bytes = protect(ext.render(yaml)?.as_bytes(), true)?;
            db.execute(
                "UPDATE subscription_extensions SET rendered=?2 WHERE source_id=?1",
                params![id, bytes],
            )
            .map_err(|_| "无法更新扩展结果")?;
        }
        Ok(())
    }

    pub fn save_extension(&self, id: &str, ext: &Extension) -> AirResult<()> {
        let doc = self.source_document(id)?;
        if *ext == self.extension(id)? {
            return Ok(());
        }
        let mut db = self.connection()?;
        let tx = db.transaction().map_err(|_| "无法保存扩展")?;
        if ext.empty() {
            tx.execute(
                "DELETE FROM subscription_extensions WHERE source_id=?1",
                [id],
            )
            .map_err(|_| "无法清除扩展")?;
        } else {
            let rendered = protect(
                ext.render(doc.local.as_deref().unwrap_or(&doc.original))?
                    .as_bytes(),
                true,
            )?;
            let def = protect(&serde_json::to_vec(ext).map_err(|_| "扩展格式无效")?, true)?;
            tx.execute(
                "INSERT OR REPLACE INTO subscription_extensions VALUES(?1,?2,?3)",
                params![id, def, rendered],
            )
            .map_err(|_| "无法保存扩展")?;
        }
        tx.execute(
            "UPDATE subscription_updates SET enabled=0 WHERE source_id=?1",
            [id],
        )
        .map_err(|_| "无法暂停自动更新")?;
        tx.commit().map_err(|_| "无法保存扩展".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn download(server: &str) -> Download {
        Download {
            profile_title: None,
            yaml: format!("proxies:\n  - {{ name: One, type: http, server: {server}, port: 80 }}\nrules: ['MATCH,DIRECT']"),
            usage: None, interval_hours: Some(8),
        }
    }

    #[test]
    fn reimport_uses_the_current_link_after_editing_the_url() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("db")).unwrap();
        let old = "https://one.test/sub";
        let new = "https://two.test/sub";
        let data = download("node.test");
        let id = store.import_id_for_url(old).unwrap();
        store.save_source(&id, "", &data, "url", Some(old)).unwrap();
        store.save_source(&id, "", &data, "url", Some(new)).unwrap();
        assert_eq!(store.import_id_for_url(new).unwrap(), id);
        let second = store.import_id_for_url(old).unwrap();
        assert_ne!(second, id);
        store.save_source(&second, "", &data, "url", Some(old)).unwrap();
        assert_eq!(store.import_id_for_url(old).unwrap(), second);
    }

    #[test]
    fn remote_names_survive_preview_save_refresh_and_manual_renames() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let store = Store::open(&path).unwrap();
        let mut data = download("node.test");
        let urls = [("v4", "https://192.0.2.1/sub", "192.0.2.1"), ("v6", "https://[2001:db8::1]/sub", "[2001:db8::1]")];
        for (id, url, host) in urls {
            store.save_source(id, host, &data, "url", Some(url)).unwrap();
        }
        // Simulate a database from before name provenance was recorded.
        store.connection().unwrap().execute("DELETE FROM source_naming", []).unwrap();
        data.profile_title = Some("Family".into());
        for (id, url, _) in urls {
            assert_eq!(store.preview_source_name(id, "", url, Some("Family")).unwrap(), if id == "v4" { "Family" } else { "Family (1)" });
            store.save_source(id, "", &data, "url", Some(url)).unwrap();
        }
        let sources = store.sources().unwrap();
        assert_eq!(sources.len(), 2);
        assert!(sources.iter().any(|s| s.name == "Family"));
        assert!(sources.iter().any(|s| s.name == "Family (1)"));
        store.rename_source("v4", "192.0.2.1").unwrap();
        drop(store);
        let store = Store::open(&path).unwrap();
        data.profile_title = None;
        assert_eq!(store.preview_source_name("v6", "", urls[1].1, None).unwrap(), "Family (1)");
        data.profile_title = Some("New Family".into());
        for (id, url, _) in urls { store.save_source(id, "", &data, "url", Some(url)).unwrap(); }
        let sources = store.sources().unwrap();
        assert_eq!(sources.iter().find(|s| s.id == "v4").unwrap().name, "192.0.2.1");
        assert_eq!(sources.iter().find(|s| s.id == "v6").unwrap().name, "New Family");
        assert_eq!(store.preview_source_name("new", " My Family ", urls[0].1, Some("Family")).unwrap(), "My Family");
    }

    #[test]
    fn existing_duplicates_keep_their_ids_and_reserve_literal_suffixes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db");
        let store = Store::open(&path).unwrap();
        let data = download("node.test");
        for (id, name) in [("one","Family"),("two","Family"),("literal","Family (1)"),("three","Family")] {
            store.save_source(id, name, &data, "file", None).unwrap();
            // Recreate pre-upgrade rows where names were stored verbatim.
            let db = store.connection().unwrap();
            db.execute("UPDATE sources SET name=?2 WHERE id=?1", params![id,name]).unwrap();
            db.execute("DELETE FROM source_name_aliases WHERE source_id=?1", [id]).unwrap();
        }
        drop(store);
        let store = Store::open(&path).unwrap();
        let names: HashMap<_,_> = store.sources().unwrap().into_iter().map(|s| (s.id,s.name)).collect();
        assert_eq!(names["one"], "Family");
        assert_eq!(names["literal"], "Family (1)");
        assert_eq!(names["two"], "Family (2)");
        assert_eq!(names["three"], "Family (3)");
        store.delete_source("one").unwrap();
        assert_eq!(store.preview_file_name("two","Family").unwrap(), "Family (2)");
        assert_eq!(store.preview_file_name("new","Family").unwrap(), "Family");
    }

    #[test]
    fn subscription_sync_respects_legacy_edits_and_user_schedule() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("db")).unwrap();
        for id in ["clean", "edited", "file"] {
            let url = (id != "file").then_some("https://example.test/sub");
            store
                .save_source(
                    id,
                    id,
                    &download("old.example"),
                    if url.is_some() { "url" } else { "file" },
                    url,
                )
                .unwrap();
        }
        store
            .save_local_yaml("edited", &download("local.example").yaml)
            .unwrap();
        store
            .connection()
            .unwrap()
            .execute("DELETE FROM subscription_updates", [])
            .unwrap();
        let sources: Vec<_> = store
            .sources()
            .unwrap()
            .into_iter()
            .map(|s| crate::subscriptions::parse(s.id, s.name, &s.yaml).unwrap())
            .collect();
        store.initialize_updates(&sources).unwrap();
        let d = store.source_details().unwrap();
        assert_eq!(d["clean"].auto_update, Some(true));
        assert_eq!(d["edited"].auto_update, Some(false));
        assert_eq!(d["file"].auto_update, None);
        store
            .set_subscription_update("edited", true, Some(2))
            .unwrap();
        store
            .save_source(
                "edited",
                "edited",
                &download("fresh.example"),
                "url",
                Some("https://example.test/sub"),
            )
            .unwrap();
        let doc = store.source_document("edited").unwrap();
        assert!(doc.original.contains("fresh.example"));
        assert!(doc.local.unwrap().contains("local.example"));
        let d = store.source_details().unwrap();
        assert_eq!(d["edited"].custom_hours, Some(2));
        assert_eq!(d["edited"].interval_hours, Some(8));
        assert_eq!(d["edited"].auto_update, Some(true));
        assert!(store.set_subscription_update("file", true, None).is_err());
        store
            .connection()
            .unwrap()
            .execute("UPDATE source_details SET updated_at=0", [])
            .unwrap();
        assert_eq!(store.due_subscriptions().unwrap().len(), 2);
        store.record_subscription_attempt("edited").unwrap();
        assert_eq!(store.due_subscriptions().unwrap(), ["clean"]);
    }

    #[test]
    fn subscription_extension_reapplies_without_overwriting_original() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("db")).unwrap();
        let url = Some("https://example.test/sub");
        store
            .save_source("one", "One", &download("old.example"), "url", url)
            .unwrap();
        let ext = Extension {
            script: "function main(c) { if(c.proxies[0].server === 'bad.example') throw Error(); c.proxies[0].port=8443; return c }".into(),
            rules: vec!["DOMAIN,example.com,DIRECT".into()],
        };
        store.save_extension("one", &ext).unwrap();
        assert_eq!(
            store.source_details().unwrap()["one"].auto_update,
            Some(false)
        );
        store.set_subscription_update("one", true, None).unwrap();
        store
            .save_source("one", "One", &download("new.example"), "url", url)
            .unwrap();
        assert!(store
            .save_source("one", "One", &download("bad.example"), "url", url)
            .is_err());
        let yaml = store.sources().unwrap().remove(0).yaml;
        let config: serde_yaml::Value = serde_yaml::from_str(&yaml).unwrap();
        assert_eq!(
            config["rules"][0].as_str(),
            Some("DOMAIN,example.com,DIRECT")
        );
        assert_eq!(config["proxies"][0]["port"].as_u64(), Some(8443));
        assert_eq!(config["proxies"][0]["server"].as_str(), Some("new.example"));
        assert!(store
            .source_document("one")
            .unwrap()
            .original
            .contains("port: 80"));
        assert!(Extension {
            script: "function main() { while(true){} }".into(),
            rules: vec![]
        }
        .render(&yaml)
        .is_err());
        store.delete_source("one").unwrap();
        assert!(store.due_subscriptions().unwrap().is_empty());
    }
}
