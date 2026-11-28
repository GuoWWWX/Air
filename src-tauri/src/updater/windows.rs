use std::{
    fs::{self, File},
    io,
    os::windows::{fs::OpenOptionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::Command,
    ptr::null_mut,
};

use semver::Version;
use windows_sys::Win32::{
    Foundation::{CloseHandle, WAIT_OBJECT_0},
    System::{
        Registry::{RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ},
        Threading::{
            OpenProcess, WaitForSingleObject, CREATE_NO_WINDOW, SYNCHRONIZATION_SYNCHRONIZE,
        },
    },
};

use super::package::{self, Manifest, EXE};

const UNINSTALL: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Air Proxy";
const HELPER: &str = "handoff.exe";
const LOADER: &str = "WebView2Loader.dll";

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

fn install_directory() -> Result<PathBuf, String> {
    let mut value = [0u16; 32768];
    let mut length = std::mem::size_of_val(&value) as u32;
    let code = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            wide(UNINSTALL).as_ptr(),
            wide("InstallLocation").as_ptr(),
            RRF_RT_REG_SZ,
            null_mut(),
            value.as_mut_ptr().cast(),
            &mut length,
        )
    };
    if code != 0 {
        return Err("未找到 Air Proxy 的当前用户安装，请运行 Air Proxy 安装包".into());
    }
    let value = String::from_utf16_lossy(&value[..length as usize / 2]);
    let path = PathBuf::from(value.trim_end_matches('\0').trim_matches('"'));
    if !path.is_absolute() || !path.join(EXE).is_file() || !path.join("uninstall.exe").is_file() {
        return Err("Air Proxy 安装路径无效".into());
    }
    path.canonicalize().map_err(package::io_error)
}

pub fn current_install() -> Result<PathBuf, String> {
    let dir = install_directory()?;
    let exe = std::env::current_exe()
        .and_then(|path| path.canonicalize())
        .map_err(package::io_error)?;
    if exe != dir.join(EXE) {
        return Err("请从当前用户安装目录启动 Air Proxy 后再更新".into());
    }
    Ok(dir)
}

fn update_version(version: &Version) {
    let value = wide(&version.to_string());
    unsafe {
        RegSetKeyValueW(
            HKEY_CURRENT_USER,
            wide(UNINSTALL).as_ptr(),
            wide("DisplayVersion").as_ptr(),
            REG_SZ,
            value.as_ptr().cast(),
            (value.len() * 2) as u32,
        );
    }
}

pub fn open_url(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "链接无效")?;
    if parsed.scheme() != "https" || !package::allowed_url(&parsed) {
        return Err("仅支持打开 HTTPS 链接".into());
    }
    crate::commands::open_in_browser(parsed.as_str())
}

pub fn handoff(root: &Path, install: &Path, id: &str) -> Result<(), String> {
    let folder = root.join("handoff");
    fs::create_dir_all(&folder).map_err(package::io_error)?;
    fs::copy(install.join(EXE), folder.join(HELPER)).map_err(package::io_error)?;
    fs::copy(install.join(LOADER), folder.join(LOADER)).map_err(package::io_error)?;
    Command::new(folder.join(HELPER))
        .arg("--air-apply-update")
        .arg(id)
        .arg(std::process::id().to_string())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(package::io_error)?;
    Ok(())
}

fn wait_for_application(pid: u32) -> Result<(), String> {
    let handle = unsafe { OpenProcess(SYNCHRONIZATION_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        if io::Error::last_os_error().raw_os_error() == Some(87) {
            return Ok(());
        }
        return Err("无法等待 Air Proxy 退出".into());
    }
    let state = unsafe { WaitForSingleObject(handle, 30_000) };
    unsafe { CloseHandle(handle) };
    if state != WAIT_OBJECT_0 {
        return Err("Air Proxy 正在退出，请重新打开后重试".into());
    }
    Ok(())
}

pub(super) fn apply(manifest: &Manifest, install: &Path, cache: &Path) -> Result<(), String> {
    let mut prepared = Vec::new();
    let mut saved: Vec<(PathBuf, Option<tempfile::NamedTempFile>)> = Vec::new();
    for asset in &manifest.files {
        if asset.matches(install) {
            continue;
        }
        let target = asset.materialized(install);
        if target
            .symlink_metadata()
            .is_ok_and(|meta| meta.file_type().is_symlink())
            || !asset.matches(cache)
        {
            return Err("安装前更新文件校验失败".into());
        }
        let mut replacement =
            tempfile::NamedTempFile::new_in(install).map_err(package::io_error)?;
        io::copy(
            &mut File::open(asset.materialized(cache)).map_err(package::io_error)?,
            &mut replacement,
        )
        .map_err(package::io_error)?;
        replacement
            .as_file()
            .sync_all()
            .map_err(package::io_error)?;
        let backup = if target.exists() {
            let mut backup = tempfile::NamedTempFile::new_in(install).map_err(package::io_error)?;
            io::copy(
                &mut File::open(&target).map_err(package::io_error)?,
                &mut backup,
            )
            .map_err(package::io_error)?;
            backup.as_file().sync_all().map_err(package::io_error)?;
            Some(backup)
        } else {
            None
        };
        prepared.push((target, replacement, backup));
    }
    // The executable is last, so a power loss can resume with the same signed manifest.
    for (target, replacement, backup) in prepared {
        if let Err(error) = replacement.persist(&target) {
            let mut recovered = true;
            for (target, backup) in saved.into_iter().rev() {
                recovered &= match backup {
                    Some(backup) => restore(backup, &target),
                    None => fs::remove_file(target).is_ok(),
                };
            }
            if !recovered {
                return Err("安装未完成，请在 Air Proxy 中重试更新".into());
            }
            return Err(package::io_error(error));
        }
        saved.push((target, backup));
    }
    Ok(())
}

fn restore(backup: tempfile::NamedTempFile, target: &Path) -> bool {
    backup.persist(target).is_ok()
}

pub fn lock(root: &Path) -> io::Result<File> {
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .share_mode(0)
        .open(root.join("install.lock"))
}

pub fn run_helper() -> bool {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() != Some("--air-apply-update") {
        return false;
    }
    let Ok(exe) = std::env::current_exe() else {
        return true;
    };
    let Some(root) = exe.parent().and_then(Path::parent) else {
        return true;
    };
    let Ok(install) = install_directory() else {
        return true;
    };
    let result = (|| {
        let id = args.next().ok_or("缺少更新清单")?;
        let pid = args
            .next()
            .and_then(|value| value.parse().ok())
            .ok_or("缺少 Air Proxy 进程")?;
        let _lock = lock(root).map_err(package::io_error)?;
        wait_for_application(pid)?;
        let raw = fs::read(root.join("approved.json")).map_err(package::io_error)?;
        if id != package::hash(&raw) {
            return Err("更新进度已失效".into());
        }
        let manifest = package::verify(&raw, &super::public_key()?)?;
        if manifest.version <= super::current_version() {
            return Err("更新版本低于或等于当前版本".into());
        }
        apply(&manifest, &install, &root.join(&id))?;
        update_version(&manifest.version);
        Ok::<_, String>(())
    })();
    if let Err(error) = result {
        let _ = package::write_atomic(&root.join("install-error.txt"), error.as_bytes());
    }
    let _ = Command::new(install.join(EXE))
        .current_dir(&install)
        .spawn();
    true
}

pub fn clean(root: &Path, raw: &[u8]) {
    update_version(&super::current_version());
    let cache = root.join(package::hash(raw));
    let helper = root.join("handoff");
    let _ = fs::remove_dir_all(cache);
    // The old helper can still be exiting while the new app starts.
    for _ in 0..10 {
        match fs::remove_dir_all(&helper) {
            Ok(()) => break,
            Err(error) if error.kind() == io::ErrorKind::NotFound => break,
            Err(_) => std::thread::sleep(std::time::Duration::from_millis(100)),
        }
    }
    let _ = fs::remove_file(root.join("approved.json"));
    let _ = fs::remove_file(root.join("install-error.txt"));
}
