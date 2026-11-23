use rusqlite::{Connection, OpenFlags};
use std::{
    fs, io,
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;

// The marker is written last. An interrupted migration can fill in missing files
// without replacing settings the user has already brought into the directory.
pub fn prepare(
    install: Option<&Path>,
    legacy: &Path,
    shipped_languages: &Path,
) -> io::Result<PathBuf> {
    let fallback = legacy.join(if install.is_some() {
        "config"
    } else {
        "dev-config"
    });
    let directory = match install.map(|p| p.join("config")) {
        Some(dir) if dir.join(".air-profile-v1").is_file() => dir,
        Some(dir) if !fallback.join(".air-profile-v1").is_file() => {
            match fs::create_dir_all(&dir).and_then(|_| NamedTempFile::new_in(&dir)) {
                Ok(_) => dir,
                Err(e) if e.kind() == io::ErrorKind::PermissionDenied => fallback,
                Err(e) => return Err(e),
            }
        }
        _ => fallback,
    };
    fs::create_dir_all(&directory)?;
    if directory.join(".air-profile-v1").is_file() {
        return Ok(directory);
    }

    let target_languages = directory.join("languages");
    fs::create_dir_all(&target_languages)?;
    if shipped_languages.is_dir() {
        for entry in fs::read_dir(shipped_languages)? {
            let entry = entry?;
            if entry.file_type()?.is_file() && entry.path().extension().is_some_and(|e| e == "json")
            {
                copy_missing(&entry.path(), &target_languages.join(entry.file_name()))?;
            }
        }
    }
    for entry in fs::read_dir(legacy)? {
        let entry = entry?;
        let name = entry.file_name();
        let label = name.to_string_lossy();
        if entry.file_type()?.is_file()
            && (matches!(
                label.as_ref(),
                "custom-groups.json" | "language.txt" | "language-seeds.json"
            ) || label.starts_with("air-config") && label.ends_with(".yaml"))
        {
            copy_missing(&entry.path(), &directory.join(&name))?;
        }
    }
    let database = directory.join("air.sqlite3");
    if legacy.join("air.sqlite3").is_file() && !database.try_exists()? {
        let db = Connection::open_with_flags(
            legacy.join("air.sqlite3"),
            OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(io::Error::other)?;
        let snapshot = NamedTempFile::new_in(&directory)?.into_temp_path();
        // SQLite includes committed WAL data and takes a consistent snapshot.
        db.execute(
            "VACUUM INTO ?1",
            [snapshot
                .to_str()
                .ok_or_else(|| io::Error::other("Invalid database path"))?],
        )
        .map_err(io::Error::other)?;
        snapshot.persist_noclobber(database).map_err(|e| e.error)?;
    }
    NamedTempFile::new_in(&directory)?.persist(directory.join(".air-profile-v1"))?;
    Ok(directory)
}

fn copy_missing(from: &Path, to: &Path) -> io::Result<()> {
    if to.try_exists()? {
        return Ok(());
    }
    let mut file = NamedTempFile::new_in(to.parent().unwrap())?;
    io::copy(&mut fs::File::open(from)?, &mut file)?;
    file.persist_noclobber(to)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_committed_wal_and_keeps_existing_user_changes() {
        let install = tempfile::tempdir().unwrap();
        let legacy = tempfile::tempdir().unwrap();
        let old = Connection::open(legacy.path().join("air.sqlite3")).unwrap();
        old.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE settings(value); INSERT INTO settings VALUES ('chosen')").unwrap();
        fs::write(legacy.path().join("air-config.yaml"), "rules").unwrap();
        let languages = install.path().join("languages");
        fs::create_dir(&languages).unwrap();
        fs::write(languages.join("fr.json"), "legacy pack").unwrap();
        let dest = prepare(Some(install.path()), legacy.path(), &languages).unwrap();
        assert_eq!(dest, install.path().join("config"));
        let db = Connection::open(dest.join("air.sqlite3")).unwrap();
        assert_eq!(
            db.query_row("SELECT value FROM settings", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "chosen"
        );
        assert_eq!(
            fs::read(dest.join("languages/fr.json")).unwrap(),
            b"legacy pack"
        );
        fs::write(dest.join("air-config.yaml"), "edited").unwrap();
        prepare(Some(install.path()), legacy.path(), &languages).unwrap();
        assert_eq!(fs::read(dest.join("air-config.yaml")).unwrap(), b"edited");
    }
}
