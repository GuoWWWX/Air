use super::{default_kernel_path, App, ProxyStatus, StartTarget};
use air::{proxy::Runtime, AirResult};
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::{atomic::Ordering, Arc}};
use tauri::{AppHandle, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupSettings {
    login: bool,
    proxy: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StartupSetting {
    Login,
    Proxy,
}

#[cfg(windows)]
mod login {
    use air::AirResult;
    use std::{ffi::OsString, io::ErrorKind, os::windows::ffi::OsStrExt};
    use tauri::AppHandle;
    use winreg::{enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE}, RegKey};

    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

    fn command() -> AirResult<OsString> {
        let exe = std::env::current_exe().map_err(|_| "无法读取 Air 的安装路径")?;
        let mut quoted = OsString::from("\"");
        quoted.push(exe);
        quoted.push("\"");
        Ok(quoted)
    }

    pub(super) fn enabled(app: &AppHandle) -> AirResult<bool> {
        let value = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(RUN, KEY_READ)
            .and_then(|key| key.get_value::<OsString, _>(&app.package_info().name));
        match value {
            Ok(value) => Ok(value == command()?),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
            Err(_) => Err("无法读取 Windows 登录启动项".into()),
        }
    }

    pub(super) fn set(app: &AppHandle, enable: bool) -> AirResult<()> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let name = &app.package_info().name;
        let result = if enable {
            let value = command()?;
            if value.encode_wide().count() >= 260 {
                return Err("Air 的安装路径超过 Windows 登录启动项长度限制".into());
            }
            hkcu.create_subkey_with_flags(RUN, KEY_SET_VALUE)
                .and_then(|(key, _)| key.set_value(name, &value))
        } else {
            hkcu.open_subkey_with_flags(RUN, KEY_SET_VALUE).and_then(|key| key.delete_value(name))
        };
        match result {
            Ok(()) => Ok(()),
            Err(e) if !enable && e.kind() == ErrorKind::NotFound => Ok(()),
            Err(_) => Err("无法保存 Windows 登录启动项".into()),
        }
    }
}

#[tauri::command]
pub fn startup_settings(state: State<'_, Arc<App>>, _app: AppHandle) -> AirResult<StartupSettings> {
    Ok(StartupSettings {
        #[cfg(windows)]
        login: login::enabled(&_app)?,
        #[cfg(not(windows))]
        login: false,
        proxy: state.store.startup_proxy()?.always_start,
    })
}

#[tauri::command]
pub async fn set_startup_setting(state: State<'_, Arc<App>>, app: AppHandle, setting: StartupSetting, enabled: bool) -> AirResult<StartupSettings> {
    match setting {
        StartupSetting::Login => {
            #[cfg(windows)]
            login::set(&app, enabled)?;
            #[cfg(not(windows))]
            return Err("当前平台不支持 Windows 登录启动项".into());
        }
        StartupSetting::Proxy => {
            let _runtime = state.proxy.lock().await;
            let mut settings = state.store.startup_proxy()?;
            settings.always_start = enabled;
            state.store.save_startup_proxy(&settings)?;
            state.launch_pending.store(false, Ordering::Relaxed);
        }
    }
    startup_settings(state, app)
}

#[tauri::command]
pub async fn start_proxy_on_launch(state: State<'_, Arc<App>>, app: AppHandle, kernel_override: Option<PathBuf>, target: StartTarget) -> AirResult<Option<ProxyStatus>> {
    let mut runtime = state.proxy.lock().await;
    #[cfg(windows)]
    let prepare = state.launch_pending.load(Ordering::Relaxed).then(|| target.clone());
    let status = launch_proxy(&state, &mut runtime, kernel_override, target).await?;
    if let Some(status) = &status {
        crate::tray::sync(&app, status);
    }
    #[cfg(windows)]
    if let Some(target) = prepare.filter(|_| status.is_none() && runtime.can_prepare_tun()) {
        let state = Arc::clone(state.inner());
        drop(runtime);
        tauri::async_runtime::spawn(async move {
            let mut runtime = state.proxy.lock().await;
            if !runtime.can_prepare_tun() {
                return;
            }
            if let Ok(config) = state.proxy_config(runtime.mode(), &target).await {
                let _ = runtime.prepare_tun(config).await;
            }
        });
    }
    Ok(status)
}

async fn launch_proxy(state: &App, runtime: &mut Runtime, kernel_override: Option<PathBuf>, target: StartTarget) -> AirResult<Option<ProxyStatus>> {
    // Only a new application process may autoconnect. Restoring a tray window or
    // reloading its WebView must respect an explicit manual stop.
    if !state.launch_pending.swap(false, Ordering::Relaxed) {
        return Ok(None);
    }
    let mut settings = state.store.startup_proxy()?;
    if !settings.always_start { return Ok(None); }
    let target = if settings.running { settings.target.take().unwrap_or(target) } else { target };
    let binary = kernel_override.or_else(default_kernel_path).ok_or("请先在设置里选择本机的 Mihomo 内核")?;
    let config = state.proxy_config(settings.mode, &target).await?;
    runtime.start(&binary, config).await?;
    let status = runtime.status().await?;
    settings.running = status.running;
    settings.target = Some(target);
    state.store.save_startup_proxy(&settings)?;
    Ok(Some(status))
}

#[cfg(test)]
mod tests {
    use super::*;
    use air::proxy::Mode;

    #[tokio::test]
    async fn disabled_autostart_keeps_proxy_stopped_after_a_running_session() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().to_owned()).unwrap();
        let mut session = app.store.startup_proxy().unwrap();
        assert!(!session.always_start && !session.running);
        session.mode = Mode::Global;
        session.tun = true;
        session.running = true;
        session.target = Some(StartTarget::Node {
            group_id: None,
            id: "chosen".into(),
        });
        app.store.save_startup_proxy(&session).unwrap();
        drop(app);

        let app = App::open(dir.path().to_owned()).unwrap();
        let mut runtime = app.proxy.lock().await;
        let attempted = launch_proxy(
            &app,
            &mut runtime,
            Some(dir.path().join("must-not-launch.exe")),
            StartTarget::Routing,
        ).await.unwrap();
        assert!(attempted.is_none());
        let status = runtime.status().await.unwrap();
        assert_eq!(status.mode, Mode::Global);
        assert_eq!(status.tun, cfg!(windows));
        let saved = app.store.startup_proxy().unwrap();
        assert!(!status.running && !saved.always_start);
        assert!(matches!(saved.target, Some(StartTarget::Node { id, .. }) if id == "chosen"));
    }

    #[tokio::test]
    async fn enabled_autostart_attempts_to_start_even_after_a_stopped_session() {
        let dir = tempfile::tempdir().unwrap();
        let app = App::open(dir.path().to_owned()).unwrap();
        let mut settings = app.store.startup_proxy().unwrap();
        settings.always_start = true;
        settings.mode = Mode::Direct;
        app.store.save_startup_proxy(&settings).unwrap();
        let mut runtime = app.proxy.lock().await;
        runtime.set_mode(Mode::Direct).await.unwrap();

        let missing = Some(dir.path().join("missing.exe"));
        assert!(launch_proxy(&app, &mut runtime, missing.clone(), StartTarget::Routing).await.is_err());
        assert!(launch_proxy(&app, &mut runtime, missing, StartTarget::Routing).await.unwrap().is_none());
    }

    #[test]
    fn legacy_row_keeps_explicit_always_start() {
        let settings: air::storage::StartupProxy = serde_json::from_str(r#"{"mode":"direct","tun":true}"#).unwrap();
        assert!(settings.always_start && settings.tun);
        assert!(!settings.running && settings.target.is_none());
    }
}
