fn main() {
    println!("cargo:rerun-if-env-changed=AIR_UPDATE_FEED");
    println!("cargo:rerun-if-env-changed=AIR_UPDATE_PUBLIC_KEY");
    stage_geodata();
    #[cfg(feature = "desktop")]
    tauri_build::build();
}

fn stage_geodata() {
    use std::{env, fs, path::PathBuf};

    let staged = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .join("../.cache/air/mihomo-data");
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let windows = env::var_os("CARGO_CFG_TARGET_OS").is_some_and(|os| os == "windows");
    let release = windows && env::var_os("CARGO_FEATURE_CUSTOM_PROTOCOL").is_some();
    for name in ["geosite.dat", "geoip.metadb"] {
        let source = staged.join(name);
        println!("cargo:rerun-if-changed={}", source.display());
        let target = out.join(name);
        if windows && source.is_file() {
            fs::copy(source, target).expect("copy staged Mihomo geodata");
        } else {
            assert!(
                !release,
                "Missing {name}. Run scripts/prepare-mihomo-data.ps1 before building the Windows installer."
            );
            fs::write(target, []).expect("write empty optional geodata");
        }
    }
}
