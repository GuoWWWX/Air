use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{self, Write};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{OnceLock, RwLock},
};
use tauri::AppHandle;

#[derive(Deserialize)]
struct Pack {
    code: String,
    name: String,
    messages: BTreeMap<String, String>,
}

#[derive(Clone, Serialize)]
pub struct OptionLabel {
    code: String,
    name: String,
}

#[derive(Clone, Serialize)]
pub struct Languages {
    code: String,
    preference: String,
    options: Vec<OptionLabel>,
    messages: BTreeMap<String, String>,
    directory: PathBuf,
}

struct Catalog {
    packs: BTreeMap<String, Pack>,
    current: RwLock<Languages>,
}
static CATALOG: OnceLock<Catalog> = OnceLock::new();
#[cfg(test)]
const EN: &str = include_str!("../../resources/languages/en.json");
const BUNDLED: &[(&str, &str)] = include!(concat!(env!("OUT_DIR"), "/language-files.rs"));

#[cfg(windows)]
fn system_language() -> String {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetUserDefaultUILanguage() -> u16;
        fn LCIDToLocaleName(locale: u32, buffer: *mut u16, count: i32, flags: u32) -> i32;
    }
    let mut buffer = [0u16; 85];
    let length = unsafe {
        LCIDToLocaleName(
            GetUserDefaultUILanguage().into(),
            buffer.as_mut_ptr(),
            85,
            0,
        )
    };
    String::from_utf16_lossy(&buffer[..length.saturating_sub(1).max(0) as usize])
}

#[cfg(not(windows))]
fn system_language() -> String {
    std::env::var("LANG").unwrap_or_default().replace('_', "-")
}

fn matched<'a>(requested: &str, codes: impl Iterator<Item = &'a String> + Clone) -> String {
    let mut tag = requested;
    loop {
        if let Some(found) = codes.clone().find(|s| s.eq_ignore_ascii_case(tag)) {
            return found.clone();
        }
        match tag.rsplit_once('-') {
            Some((parent, _)) => tag = parent,
            None => break,
        }
    }
    if tag.eq_ignore_ascii_case("zh") {
        return "zh-CN".into();
    }
    let mut variants = codes.filter(|s| {
        s.split('-')
            .next()
            .is_some_and(|base| base.eq_ignore_ascii_case(tag))
    });
    match (variants.next(), variants.next()) {
        (Some(only), None) => only.clone(),
        _ => "en".into(),
    }
}

fn discover(directory: &Path) -> BTreeMap<String, Pack> {
    let mut packs = BTreeMap::new();
    for &(_, json) in BUNDLED {
        let p: Pack = serde_json::from_str(json.trim_start_matches('\u{feff}'))
            .expect("bundled language pack");
        packs.insert(p.code.clone(), p);
    }
    for entry in fs::read_dir(directory).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.extension().and_then(|v| v.to_str()) != Some("json")
            || !entry
                .metadata()
                .is_ok_and(|m| m.is_file() && m.len() <= 2_097_152)
        {
            continue;
        }
        let Some(p) = fs::read(path.as_path()).ok().and_then(|v| {
            serde_json::from_slice::<Pack>(v.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&v)).ok()
        }) else {
            continue;
        };
        if p.name.trim().is_empty()
            || !valid_code(&p.code)
            || path.file_stem().and_then(|s| s.to_str()) != Some(&p.code)
        {
            continue;
        }
        if let Some(builtin) = packs.get_mut(&p.code) {
            builtin.messages.extend(p.messages);
            builtin.name = p.name;
        } else {
            packs.insert(p.code.clone(), p);
        }
    }
    packs
}

fn resolve(
    packs: &BTreeMap<String, Pack>,
    directory: &Path,
    preference: String,
    system: &str,
) -> Languages {
    let preference = if packs.contains_key(&preference) {
        preference
    } else {
        "system".into()
    };
    let code = matched(
        if preference == "system" {
            system
        } else {
            &preference
        },
        packs.keys(),
    );
    let options = packs
        .values()
        .map(|p| OptionLabel {
            code: p.code.clone(),
            name: p.name.clone(),
        })
        .collect();
    let mut messages = packs["en"].messages.clone();
    messages.extend(packs[&code].messages.clone());
    Languages {
        code,
        preference,
        options,
        messages,
        directory: directory.to_owned(),
    }
}

fn valid_code(code: &str) -> bool {
    let mut parts = code.split('-');
    code.len() <= 63
        && code != "system"
        && parts.next().is_some_and(|s| {
            (2..=8).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphabetic())
        })
        && parts.all(|p| (1..=8).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric()))
}

fn write_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file =
        tempfile::NamedTempFile::new_in(path.parent().expect("application file directory"))?;
    file.write_all(bytes)?;
    file.persist(path)?;
    Ok(())
}

fn seed_builtin_files(directory: &Path, record: &Path) {
    if fs::create_dir_all(directory).is_err() {
        return;
    }
    let mut hashes: BTreeMap<String, String> = fs::read(record)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let mut changed = false;
    for &(name, text) in BUNDLED {
        let path = directory.join(name);
        let current = format!("{:x}", Sha256::digest(text.as_bytes()));
        if path.exists() && hashes.get(name) == Some(&current) {
            continue;
        }
        let disk = fs::metadata(&path)
            .ok()
            .filter(|meta| meta.len() <= 2_097_152)
            .and_then(|_| fs::read(&path).ok())
            .map(|bytes| format!("{:x}", Sha256::digest(bytes)));
        // Refresh only an unchanged shipped pack. Other files belong to the user.
        if !path.exists() || disk.is_some() && disk.as_ref() == hashes.get(name) {
            if write_file(&path, text.as_bytes()).is_err() {
                continue;
            }
        }
        hashes.insert(name.to_owned(), current);
        changed = true;
    }
    if changed {
        if let Ok(bytes) = serde_json::to_vec(&hashes) {
            let _ = write_file(record, &bytes);
        }
    }
}

pub fn init(config: &Path) -> io::Result<()> {
    let dir = config.join("languages");
    fs::create_dir_all(&dir)?;
    seed_builtin_files(&dir, &config.join("language-seeds.json"));
    let preference = fs::read_to_string(config.join("language.txt")).unwrap_or_default();
    let packs = discover(&dir);
    let current = RwLock::new(resolve(&packs, &dir, preference, &system_language()));
    let _ = CATALOG.set(Catalog { packs, current });
    Ok(())
}

fn import_pack(dir: &Path, text: &str) -> Result<(), String> {
    if text.len() > 2_097_152 { return Err("语言包无效".into()); }
    let pack: Pack = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|_| "语言包无效")?;
    let filename = format!("{}.json", pack.code);
    if !valid_code(&pack.code) || pack.name.trim().is_empty()
        || ["con", "prn", "aux", "nul", "system"].iter().any(|s| pack.code.eq_ignore_ascii_case(s))
        || BUNDLED.iter().any(|(name, _)| name.eq_ignore_ascii_case(&filename)) {
        return Err("语言包无效".into());
    }
    write_file(&dir.join(filename), text.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn import_language(text: String) -> Result<(), String> {
    let state = catalog()?.current.read().map_err(|e| e.to_string())?;
    import_pack(&state.directory, &text)
}

fn catalog() -> Result<&'static Catalog, String> {
    CATALOG.get().ok_or_else(|| "Languages unavailable".into())
}

pub fn tr(key: &str) -> String {
    CATALOG
        .get()
        .and_then(|catalog| catalog.current.read().ok()?.messages.get(key).cloned())
        .unwrap_or_else(|| key.to_owned())
}

#[tauri::command]
pub fn list_languages() -> Result<Languages, String> {
    Ok(catalog()?
        .current
        .read()
        .map_err(|e| e.to_string())?
        .clone())
}

impl Catalog {
    fn choose(&self, path: &Path, code: String, system: &str) -> Result<Languages, String> {
        if code != "system" && !self.packs.contains_key(&code) {
            return Err("Unknown language".into());
        }
        let mut current = self.current.write().map_err(|e| e.to_string())?;
        write_file(path, code.as_bytes()).map_err(|e| e.to_string())?;
        *current = resolve(&self.packs, &current.directory, code, system);
        Ok(current.clone())
    }
}

#[tauri::command]
pub fn choose_language(app: AppHandle, code: String) -> Result<Languages, String> {
    let dir = list_languages()?.directory;
    let path = dir.parent().ok_or("无法保存语言设置")?.join("language.txt");
    let state = catalog()?.choose(&path, code, &system_language())?;
    if let Err(error) = crate::tray::refresh_language(&app) {
        eprintln!("Could not refresh tray language: {error}");
    }
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn imports_valid_custom_packs_and_protects_bundled_files() {
        let root = tempdir().unwrap();
        let json = |code: &str| serde_json::json!({"code":code,"name":"Français","messages":{"语言":"Langue"}}).to_string();
        import_pack(root.path(), &json("fr")).unwrap();
        assert_eq!(discover(root.path())["fr"].messages["语言"], "Langue");
        for code in ["../fr", "en", "EN", "zh-CN", "con", "system"] {
            assert!(import_pack(root.path(), &json(code)).is_err());
        }
        assert!(import_pack(root.path(), &" ".repeat(2_097_153)).is_err());
        assert!(import_pack(root.path(), "{}").is_err());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[test]
    fn seeds_delta_installs_and_preserves_user_edits() {
        let temp = tempdir().unwrap();
        let dir = temp.path().join("languages");
        let record = temp.path().join("seeds.json");
        seed_builtin_files(&dir, &record);
        assert_eq!(fs::read_to_string(dir.join("en.json")).unwrap(), EN);
        let original = b"old shipped pack";
        let hashes = BTreeMap::from([("en.json", format!("{:x}", Sha256::digest(original)))]);
        fs::write(&record, serde_json::to_vec(&hashes).unwrap()).unwrap();
        fs::write(dir.join("en.json"), original).unwrap();
        fs::write(dir.join("zh-CN.json"), b"edited by user").unwrap();
        seed_builtin_files(&dir, &record);
        assert_eq!(fs::read_to_string(dir.join("en.json")).unwrap(), EN);
        assert_eq!(fs::read(dir.join("zh-CN.json")).unwrap(), b"edited by user");
    }

    #[test]
    fn switching_changes_the_live_catalog_without_discovering_new_files() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("language.txt");
        let packs = discover(dir.path());
        let current = RwLock::new(resolve(&packs, dir.path(), "system".into(), "zh-CN"));
        let catalog = Catalog { packs, current };
        fs::write(
            dir.path().join("fr.json"),
            r#"{"code":"fr","name":"Français","messages":{}}"#,
        )
        .unwrap();
        assert!(catalog.choose(&path, "fr".into(), "en").is_err());
        let state = catalog.choose(&path, "en".into(), "zh-CN").unwrap();
        assert_eq!(state.messages["语言"], "Language");
        assert_eq!(catalog.current.read().unwrap().code, "en");
        assert_eq!(fs::read_to_string(&path).unwrap(), "en");
        let state = catalog.choose(&path, "system".into(), "zh-CN").unwrap();
        assert_eq!(state.code, "zh-CN");
        assert!(!state.options.iter().any(|o| o.code == "fr"));
        assert!(discover(dir.path()).contains_key("fr"));
    }

    #[test]
    fn follows_system_and_handles_partial_custom_packs() {
        let dir = tempdir().unwrap();
        let load_for = |preference: &str, tag: &str| {
            resolve(&discover(dir.path()), dir.path(), preference.into(), tag)
        };
        assert_eq!(load_for("system", "zh-Hant-TW").code, "zh-CN");
        assert_eq!(load_for("system", "nl-NL").code, "en");
        fs::write(
            dir.path().join("fr.json"),
            r#"{"code":"fr","name":"Français","messages":{"设置":"Réglages"}}"#,
        )
        .unwrap();
        fs::write(dir.path().join("bad.json"), b"{").unwrap();
        let selected = load_for("system", "fr-CA");
        assert_eq!(selected.code, "fr");
        assert!(selected.options.iter().any(|option| option.code == "fr"));
        assert!(!selected.options.iter().any(|option| option.code == "bad"));
        assert_eq!(selected.messages["设置"], "Réglages");
        assert_eq!(selected.messages["语言"], "Language");
        assert_eq!(load_for("zh-CN", "fr-CA").code, "zh-CN");
        fs::write(
            dir.path().join("es-MX.json"),
            r#"{"code":"es-MX","name":"Español","messages":{}}"#,
        )
        .unwrap();
        assert_eq!(load_for("system", "es-AR").code, "es-MX");
        fs::write(
            dir.path().join("es-ES.json"),
            r#"{"code":"es-ES","name":"Español","messages":{}}"#,
        )
        .unwrap();
        assert_eq!(load_for("system", "es-AR").code, "en");
        assert_eq!(load_for("system", "es-es").code, "es-ES");
    }
}
