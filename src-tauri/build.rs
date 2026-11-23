fn main() {
    println!("cargo:rerun-if-env-changed=AIR_UPDATE_FEED");
    println!("cargo:rerun-if-env-changed=AIR_UPDATE_PUBLIC_KEY");
    stage_windows_assets();
    embed_languages();
    #[cfg(feature = "desktop")]
    tauri_build::build();
}

fn stage_windows_assets() {
    use std::{env, fs, path::PathBuf};

    let staged = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../.cache/air");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let windows = env::var_os("CARGO_CFG_TARGET_OS").is_some_and(|os| os == "windows");
    let release = windows && env::var_os("CARGO_FEATURE_CUSTOM_PROTOCOL").is_some();
    for (name, directory, script) in [
        ("geosite.dat", "mihomo-data", "prepare-mihomo-data.ps1"),
        ("geoip.metadb", "mihomo-data", "prepare-mihomo-data.ps1"),
        ("wintun.dll", "windows-x64", "prepare-windows-kernel.ps1"),
        ("Wintun-LICENSE.txt", "windows-x64", "prepare-windows-kernel.ps1"),
    ] {
        let source = staged.join(directory).join(name);
        println!("cargo:rerun-if-changed={}", source.display());
        let target = out.join(name);
        if windows && source.is_file() {
            fs::copy(source, target).expect("copy staged Windows asset");
        } else {
            assert!(
                !release,
                "Missing {name}. Run scripts/{script} before building the Windows installer."
            );
            fs::write(target, []).expect("write empty optional Windows asset");
        }
    }
}

fn embed_languages() {
    use std::{env, fs, path::PathBuf};

    let directory =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../resources/languages");
    println!("cargo:rerun-if-changed={}", directory.display());
    let mut files = fs::read_dir(&directory)
        .expect("language directory")
        .map(|entry| entry.expect("language file").path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
        .collect::<Vec<_>>();
    files.sort();
    let mut source = String::from("&[\n");
    for path in files {
        let name = path
            .file_name()
            .unwrap()
            .to_str()
            .expect("UTF-8 language filename");
        source.push_str(&format!("    ({name:?}, include_str!({path:?})),\n"));
    }
    source.push_str("]\n");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    fs::write(out.join("language-files.rs"), source).expect("write embedded language list");
}
