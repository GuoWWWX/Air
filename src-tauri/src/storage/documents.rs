use super::*;
use rusqlite::{Transaction, TransactionBehavior};
use std::{collections::HashSet, fs, io::Write, path::PathBuf};

/// SQLite commits the pointer only after the protected file is complete.
pub(super) struct Documents(PathBuf);

impl Documents {
    pub fn open(directory: PathBuf, db: &mut Connection) -> AirResult<Self> {
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let docs = Self(directory);
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        for (table, column, key) in [
            ("sources", "encrypted_yaml", "id"),
            ("sources", "encrypted_local_yaml", "id"),
            ("subscription_extensions", "rendered", "source_id"),
        ] {
            let sql = format!("SELECT {key} FROM {table} WHERE {column} IS NOT NULL AND substr({column}, 1, length(?1)) != ?1");
            let mut query = tx.prepare(&sql).map_err(|e| e.to_string())?;
            let ids = query
                .query_map([b"air-doc:".as_slice()], |r| r.get::<_, String>(0))
                .and_then(Iterator::collect::<rusqlite::Result<Vec<_>>>)
                .map_err(|e| e.to_string())?;
            for id in ids {
                let bytes: Vec<u8> = tx
                    .query_row(
                        &format!("SELECT {column} FROM {table} WHERE {key}=?1"),
                        [&id],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                // The local-edit trigger pauses updates. A storage migration must preserve the preference.
                let enabled: Option<bool> = tx
                    .query_row(
                        "SELECT enabled FROM subscription_updates WHERE source_id=?1",
                        [&id],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| e.to_string())?;
                let reference = docs.write_protected(&bytes)?;
                tx.execute(
                    &format!("UPDATE {table} SET {column}=?2 WHERE {key}=?1"),
                    params![id, reference],
                )
                .map_err(|e| e.to_string())?;
                if column == "encrypted_local_yaml" {
                    if let Some(enabled) = enabled {
                        tx.execute(
                            "UPDATE subscription_updates SET enabled=?2 WHERE source_id=?1",
                            params![id, enabled],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        docs.prune(db)?;
        Ok(docs)
    }

    fn name(reference: &[u8]) -> AirResult<String> {
        let id = reference
            .strip_prefix(b"air-doc:")
            .and_then(|s| std::str::from_utf8(s).ok())
            .and_then(|s| uuid::Uuid::parse_str(s).ok())
            .ok_or("订阅配置文件索引无效")?;
        Ok(format!("{id}.airsub"))
    }

    fn write_protected(&self, bytes: &[u8]) -> AirResult<Vec<u8>> {
        let reference = format!("air-doc:{}", uuid::Uuid::new_v4()).into_bytes();
        let target = self.0.join(Self::name(&reference)?);
        let mut tmp = tempfile::NamedTempFile::new_in(&self.0).map_err(|e| e.to_string())?;
        tmp.write_all(bytes)
            .and_then(|_| tmp.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        tmp.persist_noclobber(target).map_err(|e| e.to_string())?;
        Ok(reference)
    }

    pub fn write(&self, text: &str) -> AirResult<Vec<u8>> {
        self.write_protected(&protect(text.as_bytes(), true)?)
    }

    pub fn read(&self, reference: &[u8]) -> AirResult<String> {
        decode(
            &fs::read(self.0.join(Self::name(reference)?))
                .map_err(|e| format!("无法读取订阅配置文件：{e}"))?,
        )
    }

    pub fn after_commit(&self, db: &mut Connection) {
        if let Err(error) = self.prune(db) {
            eprintln!("Subscription file cleanup will be retried: {error}");
        }
    }

    fn prune(&self, db: &mut Connection) -> AirResult<()> {
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        self.prune_locked(&tx)?;
        tx.commit().map_err(|e| e.to_string())
    }

    fn prune_locked(&self, tx: &Transaction<'_>) -> AirResult<()> {
        let mut query = tx.prepare("SELECT encrypted_yaml FROM sources UNION ALL SELECT encrypted_local_yaml FROM sources WHERE encrypted_local_yaml IS NOT NULL UNION ALL SELECT rendered FROM subscription_extensions").map_err(|e| e.to_string())?;
        let mut live = HashSet::new();
        for row in query
            .query_map([], |r| r.get::<_, Vec<u8>>(0))
            .map_err(|e| e.to_string())?
        {
            live.insert(Self::name(&row.map_err(|e| e.to_string())?)?);
        }
        for entry in fs::read_dir(&self.0).map_err(|e| e.to_string())? {
            let path = entry.map_err(|e| e.to_string())?.path();
            if path.extension().is_some_and(|s| s == "airsub")
                && path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .and_then(|s| uuid::Uuid::parse_str(s).ok())
                    .is_some()
                && !live.contains(path.file_name().unwrap().to_string_lossy().as_ref())
            {
                fs::remove_file(path).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
}

#[cfg(all(windows, test))]
mod tests {
    use super::*;

    #[test]
    fn upgrades_inline_documents_and_removes_only_unreferenced_files() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("air.sqlite3");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(include_str!("../../migrations/001_initial.sql"))
            .unwrap();
        for id in ["one", "two"] {
            db.execute(
                "INSERT INTO sources VALUES(?1,'Family',?2,?3)",
                params![
                    id,
                    protect(b"remote", true).unwrap(),
                    protect(b"edited", true).unwrap()
                ],
            )
            .unwrap();
            db.execute(
                "INSERT INTO subscription_updates(source_id,enabled) VALUES(?1,1)",
                [id],
            )
            .unwrap();
        }
        drop(db);
        let store = Store::open(&path).unwrap();
        let dir = root.path().join("subscriptions");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 4);
        assert_eq!(store.source_document("one").unwrap().original, "remote");
        assert_eq!(store.sources().unwrap()[0].yaml, "edited");
        let enabled: bool = store
            .connection()
            .unwrap()
            .query_row(
                "SELECT enabled FROM subscription_updates WHERE source_id='one'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(enabled);
        store.save_local_yaml("one", "new").unwrap();
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 4);
        drop(store);
        let store = Store::open(&path).unwrap();
        assert_eq!(
            store.source_document("one").unwrap().local.as_deref(),
            Some("new")
        );
        store.delete_source("one").unwrap();
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 2);
        store.use_original_yaml("two").unwrap();
        assert_eq!(store.sources().unwrap()[0].yaml, "remote");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    }
}
