#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod tray;
mod languages;
mod profile;
#[cfg(windows)]
mod updater;

use std::{
    io,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindowBuilder};

const TRAY_SUSPEND_DELAY: Duration = Duration::from_secs(3);
const TRAY_TRIM_DELAY: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum HibernationStage {
    Active,
    Suspended,
    Trimmed,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct WindowBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

#[derive(Debug)]
struct HibernationInner {
    tray_hidden: bool,
    hidden_since: Option<Instant>,
    stage: HibernationStage,
    bounds: Option<WindowBounds>,
    pending_maximize: bool,
    recreating: bool,
}

pub(crate) struct WindowHibernation(Mutex<HibernationInner>);

impl WindowHibernation {
    fn new() -> Self {
        Self(Mutex::new(HibernationInner {
            tray_hidden: false,
            hidden_since: None,
            stage: HibernationStage::Active,
            bounds: None,
            pending_maximize: false,
            recreating: false,
        }))
    }

    fn mark_tray_hidden(&self, bounds: Option<WindowBounds>) {
        let mut inner = self.0.lock().expect("window hibernation poisoned");
        inner.tray_hidden = true;
        inner.hidden_since.get_or_insert_with(Instant::now);
        inner.pending_maximize = false;
        inner.stage = HibernationStage::Active;
        if let Some(bounds) = bounds {
            inner.bounds = Some(bounds);
        }
    }

    fn mark_shown(&self) {
        let mut inner = self.0.lock().expect("window hibernation poisoned");
        inner.tray_hidden = false;
        inner.hidden_since = None;
        inner.stage = HibernationStage::Active;
        inner.recreating = false;
    }

    fn is_tray_hidden(&self) -> bool {
        self.0.lock().expect("window hibernation poisoned").tray_hidden
    }

    fn saved_bounds(&self) -> Option<WindowBounds> {
        self.0.lock().expect("window hibernation poisoned").bounds
    }

    fn take_pending_maximize(&self) -> bool {
        let mut inner = self.0.lock().expect("window hibernation poisoned");
        std::mem::take(&mut inner.pending_maximize)
    }

    fn begin_recreate(&self) -> bool {
        let mut inner = self.0.lock().expect("window hibernation poisoned");
        inner.tray_hidden = false;
        inner.hidden_since = None;
        if inner.recreating {
            return false;
        }
        inner.recreating = true;
        inner.pending_maximize = inner.bounds.is_some_and(|b| b.maximized);
        true
    }

    fn finish_recreate(&self, succeeded: bool) {
        let mut inner = self.0.lock().expect("window hibernation poisoned");
        inner.recreating = false;
        if succeeded {
            inner.stage = HibernationStage::Active;
        } else {
            inner.pending_maximize = false;
        }
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    fn next_action(&self, now: Instant) -> Option<HibernationStage> {
        let inner = self.0.lock().expect("window hibernation poisoned");
        if !inner.tray_hidden {
            return None;
        }
        let elapsed = now.saturating_duration_since(inner.hidden_since?);
        match inner.stage {
            HibernationStage::Active if elapsed >= TRAY_SUSPEND_DELAY => {
                Some(HibernationStage::Suspended)
            }
            HibernationStage::Suspended if elapsed >= TRAY_TRIM_DELAY => {
                Some(HibernationStage::Trimmed)
            }
            _ => None,
        }
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    fn set_stage(&self, stage: HibernationStage) {
        let mut inner = self.0.lock().expect("window hibernation poisoned");
        if inner.tray_hidden {
            inner.stage = stage;
        }
    }
}

fn window_background_color(dark: bool) -> tauri::window::Color {
    if dark {
        tauri::window::Color(22, 22, 24, 255)
    } else {
        tauri::window::Color(243, 245, 249, 255)
    }
}

pub(crate) struct StartupReveal(pub(crate) AtomicBool);

fn reveal_on_startup(app: &tauri::AppHandle) {
    if !app.state::<StartupReveal>().0.swap(true, Ordering::AcqRel) {
        let _ = tray::show_window(app);
    }
}

#[tauri::command]
fn reveal_startup_window(app: tauri::AppHandle) {
    reveal_on_startup(&app);
}

#[tauri::command]
fn set_window_background(window: tauri::WebviewWindow, dark: bool) {
    let _ = window.set_background_color(Some(window_background_color(dark)));
}

#[tauri::command]
fn system_prefers_dark() -> Option<bool> {
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let key = RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize")
            .ok()?;
        Some(key.get_value::<u32, _>("AppsUseLightTheme").ok()? == 0)
    }
    #[cfg(not(windows))]
    {
        None
    }
}

fn saved_window_theme(directory: &Path) -> Option<tauri::Theme> {
    let preferences = std::fs::read(directory.join("interface.json"))
        .ok()
        .and_then(|bytes| {
            serde_json::from_slice::<std::collections::HashMap<String, String>>(&bytes).ok()
        });
    match preferences.as_ref().and_then(|values| values.get("air.theme")).map(String::as_str) {
        Some("dark") => Some(tauri::Theme::Dark),
        Some("system") => None,
        _ => Some(tauri::Theme::Light),
    }
}

#[cfg(test)]
mod theme_tests {
    use super::*;

    #[test]
    fn following_system_leaves_the_native_window_theme_automatic() {
        let profile = tempfile::tempdir().unwrap();
        let path = profile.path().join("interface.json");
        assert_eq!(saved_window_theme(profile.path()), Some(tauri::Theme::Light));
        for (preference, expected) in [
            ("system", None),
            ("dark", Some(tauri::Theme::Dark)),
            ("light", Some(tauri::Theme::Light)),
        ] {
            std::fs::write(&path, serde_json::json!({ "air.theme": preference }).to_string()).unwrap();
            assert_eq!(saved_window_theme(profile.path()), expected);
        }
    }
}

#[cfg(test)]
mod hibernation_tests {
    use super::*;

    #[test]
    fn two_stage_hibernation_transitions_and_cancels_cleanly() {
        let state = WindowHibernation::new();
        let t0 = Instant::now();
        assert_eq!(state.next_action(t0), None);

        let bounds = WindowBounds {
            x: 100.0,
            y: 80.0,
            width: 1200.0,
            height: 760.0,
            maximized: true,
        };
        state.mark_tray_hidden(Some(bounds));
        let start = state.0.lock().unwrap().hidden_since.unwrap();
        assert_eq!(state.next_action(start + Duration::from_secs(2)), None);
        assert_eq!(
            state.next_action(start + TRAY_SUSPEND_DELAY),
            Some(HibernationStage::Suspended)
        );
        state.set_stage(HibernationStage::Suspended);
        assert_eq!(state.next_action(start + Duration::from_secs(10)), None);
        assert_eq!(
            state.next_action(start + TRAY_TRIM_DELAY),
            Some(HibernationStage::Trimmed)
        );

        state.mark_shown();
        state.set_stage(HibernationStage::Trimmed);
        assert!(!state.is_tray_hidden());
        assert_eq!(state.0.lock().unwrap().stage, HibernationStage::Active);
        assert_eq!(state.next_action(start + Duration::from_secs(120)), None);

        assert!(state.begin_recreate());
        assert!(!state.begin_recreate());
        assert!(state.take_pending_maximize());
        assert!(!state.take_pending_maximize());
        state.finish_recreate(true);
        assert_eq!(state.saved_bounds(), Some(bounds));
    }
}

#[cfg(windows)]
fn set_taskbar_icon(hwnd: windows_sys::Win32::Foundation::HWND) {
    use windows_sys::Win32::{
        System::LibraryLoader::GetModuleHandleW,
        UI::{
            HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi},
            WindowsAndMessaging::{
                LoadImageW, SendMessageW, ICON_BIG, IDI_APPLICATION, IMAGE_ICON, LR_SHARED,
                SM_CXICON, SM_CYICON, WM_SETICON,
            },
        },
    };
    // Tauri embeds the application icon at resource 32512 (IDI_APPLICATION).
    // A shared module icon remains valid for the window's lifetime.
    unsafe {
        let module = GetModuleHandleW(std::ptr::null());
        if module.is_null() { return; }
        let dpi = GetDpiForWindow(hwnd).max(96);
        let icon = LoadImageW(module, IDI_APPLICATION, IMAGE_ICON,
            GetSystemMetricsForDpi(SM_CXICON, dpi), GetSystemMetricsForDpi(SM_CYICON, dpi), LR_SHARED);
        if !icon.is_null() {
            SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, icon as isize);
        }
    }
}

#[cfg(windows)]
fn suspend_webview(window: &tauri::WebviewWindow) {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_19, ICoreWebView2_3, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        },
        TrySuspendCompletedHandler,
    };
    use windows_core::Interface;
    let _ = window.with_webview(move |view| unsafe {
        let controller = view.controller();
        let _ = controller.SetIsVisible(false);
        if let Ok(core) = controller.CoreWebView2() {
            if let Ok(control) = core.cast::<ICoreWebView2_19>() {
                let _ = control.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW);
            }
            if let Ok(suspendable) = core.cast::<ICoreWebView2_3>() {
                let handler = TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(())));
                let _ = suspendable.TrySuspend(&handler);
            }
        }
    });
}

#[cfg(windows)]
fn wake_webview(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, ICoreWebView2_3, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;
    let _ = window.with_webview(move |view| unsafe {
        let controller = view.controller();
        if let Ok(core) = controller.CoreWebView2() {
            if let Ok(suspendable) = core.cast::<ICoreWebView2_3>() {
                let _ = suspendable.Resume();
            }
            if let Ok(control) = core.cast::<ICoreWebView2_19>() {
                let _ = control.SetMemoryUsageTargetLevel(COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL);
            }
        }
        let _ = controller.SetIsVisible(true);
    });
}

#[cfg(windows)]
fn trim_process_working_set(pid: u32) {
    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::Threading::{OpenProcess, SetProcessWorkingSetSize, PROCESS_SET_QUOTA},
    };
    unsafe {
        let handle = OpenProcess(PROCESS_SET_QUOTA, 0, pid);
        if !handle.is_null() {
            let _ = SetProcessWorkingSetSize(handle, usize::MAX, usize::MAX);
            CloseHandle(handle);
        }
    }
}

#[cfg(windows)]
fn trim_webview_working_set(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Environment8;
    use windows_core::Interface;
    let app = window.app_handle().clone();
    let _ = window.with_webview(move |view| {
        if !app.state::<WindowHibernation>().is_tray_hidden() {
            return;
        }
        unsafe {
            let mut pids = Vec::new();
            if let Ok(env8) = view.environment().cast::<ICoreWebView2Environment8>() {
                if let Ok(infos) = env8.GetProcessInfos() {
                    let mut count = 0u32;
                    if infos.Count(&mut count).is_ok() {
                        for idx in 0..count {
                            if let Ok(info) = infos.GetValueAtIndex(idx) {
                                let mut pid = 0i32;
                                if info.ProcessId(&mut pid).is_ok() && pid > 0 {
                                    pids.push(pid as u32);
                                }
                            }
                        }
                    }
                }
            } else if let Ok(core) = view.controller().CoreWebView2() {
                let mut pid = 0u32;
                if core.BrowserProcessId(&mut pid).is_ok() && pid > 0 {
                    pids.push(pid);
                }
            }
            for pid in pids {
                trim_process_working_set(pid);
            }
            let _ = windows_sys::Win32::System::Threading::SetProcessWorkingSetSize(
                windows_sys::Win32::System::Threading::GetCurrentProcess(),
                usize::MAX,
                usize::MAX,
            );
        }
    });
}

#[cfg(windows)]
fn set_webview_memory_target(app: &tauri::AppHandle, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows_core::Interface;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.with_webview(move |view| unsafe {
            if let Ok(core) = view.controller().CoreWebView2() {
                if let Ok(control) = core.cast::<ICoreWebView2_19>() {
                    let level = if low {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                    } else {
                        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                    };
                    let _ = control.SetMemoryUsageTargetLevel(level);
                }
            }
        });
    }
}

fn capture_window_bounds(window: &tauri::Window) -> Option<WindowBounds> {
    if !matches!(window.is_visible(), Ok(true)) || matches!(window.is_minimized(), Ok(true)) {
        return None;
    }
    let scale = window.scale_factor().ok().filter(|s| *s > 0.0)?;
    let maximized = window.is_maximized().unwrap_or(false);
    let size = window.inner_size().ok()?;
    let pos = window.outer_position().ok()?;
    Some(WindowBounds {
        x: f64::from(pos.x) / scale,
        y: f64::from(pos.y) / scale,
        width: f64::from(size.width) / scale,
        height: f64::from(size.height) / scale,
        maximized,
    })
}

pub(crate) fn create_main_window(
    app: &tauri::AppHandle,
    is_resume: bool,
) -> tauri::Result<tauri::WebviewWindow> {
    let state = app.state::<Arc<commands::App>>();
    let preferred_theme = saved_window_theme(state.config_dir());
    let system_dark = system_prefers_dark();
    let dark = preferred_theme.map_or(system_dark.unwrap_or(false), |theme| theme == tauri::Theme::Dark);
    let boot_theme = match preferred_theme {
        Some(tauri::Theme::Dark) => "dark",
        Some(_) => "light",
        None => "system",
    };
    app.state::<StartupReveal>().0.store(false, Ordering::Release);
    let mut builder = WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
        .visible(false)
        .initialization_script(format!(
            "window.airBootTheme = {{ preference: '{boot_theme}', systemDark: {} }};\
            window.__airTrayResume = {is_resume};\
            if (!window.__airFindDisabled) {{ window.__airFindDisabled = true; window.addEventListener('keydown', function(e) {{ if (e.defaultPrevented) return; var k = (e.key || '').toLowerCase(); if (((e.ctrlKey || e.metaKey) && !e.altKey && (k === 'f' || k === 'g')) || e.key === 'F3') e.preventDefault(); }}); }}",
            serde_json::to_string(&system_dark)?
        ))
        .background_color(window_background_color(dark))
        .theme(preferred_theme);
    if is_resume {
        if let Some(bounds) = app.state::<WindowHibernation>().saved_bounds() {
            if !bounds.maximized && bounds.width >= 600.0 && bounds.height >= 400.0 {
                builder = builder
                    .inner_size(bounds.width, bounds.height)
                    .position(bounds.x, bounds.y);
            }
        }
    }
    // Disable Skia Graphite to prevent excessive GPU process commit spikes on AMD GPUs.
    // An active dev WebView2 process can block another app using its profile.
    #[cfg(windows)]
    {
        builder = builder.additional_browser_args(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,SkiaGraphite,SkiaGraphitePrecompilation --disable-skia-graphite --use-angle=d3d11",
        );
        if !tauri::is_dev() {
            builder = builder.data_directory(state.runtime_dir().join("webview-release"));
        }
    }
    let window = builder.build()?;
    #[cfg(windows)]
    set_taskbar_icon(window.hwnd()?.0);
    let startup_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(2500)).await;
        let reveal_handle = startup_handle.clone();
        let _ = startup_handle.run_on_main_thread(move || reveal_on_startup(&reveal_handle));
    });
    Ok(window)
}

pub(crate) fn ensure_main_window_shown(app: &tauri::AppHandle) -> tauri::Result<()> {
    app.state::<Arc<commands::App>>().set_window_hidden(false);
    if let Some(window) = app.get_webview_window("main") {
        let hibernation = app.state::<WindowHibernation>();
        hibernation.mark_shown();
        let maximize = hibernation.take_pending_maximize();
        if let Some(startup) = app.try_state::<StartupReveal>() {
            startup.0.store(true, Ordering::Release);
        }
        #[cfg(windows)]
        wake_webview(&window);
        window.show()?;
        if maximize {
            let _ = window.maximize();
        }
        if window.is_minimized()? {
            window.unminimize()?;
        }
        window.set_focus()?;
        return Ok(());
    }
    if !app.state::<WindowHibernation>().begin_recreate() {
        return Ok(());
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let created = create_main_window(&handle, true);
        handle
            .state::<WindowHibernation>()
            .finish_recreate(created.is_ok());
        if let Err(error) = created {
            eprintln!("Air recreate window failed: {error}");
        }
    });
    Ok(())
}

fn main() {
    #[cfg(windows)]
    if let Some(result) = air::proxy::tun_service::handle_command() {
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    #[cfg(windows)]
    if updater::run_helper() {
        return;
    }
    let builder = tauri::Builder::default();
    #[cfg(windows)]
    let builder = if tauri::is_dev() {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            let _ = tray::show_window(app);
        }))
    };
    builder
        .setup(|app| {
            let directory = app.path().app_local_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            let resources = app.path().resource_dir()?;
            let install = std::env::current_exe()?;
            let config = profile::prepare(if tauri::is_dev() { None } else { install.parent() }, &directory, &resources.join("languages"))?;
            languages::init(&config)?;
            let state = Arc::new(commands::App::open_profile(config, directory.clone()).map_err(io::Error::other)?);
            app.manage(state.clone());
            #[cfg(windows)]
            let updates = {
                let updates =
                    Arc::new(updater::Updater::open(&directory).map_err(io::Error::other)?);
                app.manage(updates.clone());
                updates
            };

            app.manage(WindowHibernation::new());
            app.manage(tray::PendingTrayAction::default());
            app.manage(StartupReveal(AtomicBool::new(false)));
            let _main_window = create_main_window(app.handle(), false)?;
            tray::setup(app)?;

            #[cfg(windows)]
            tauri::async_runtime::spawn(updates.background(app.handle().clone()));
            let watcher = state.clone();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(1));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                #[cfg(windows)]
                let (mut minimized_since, mut minimized_low) = (None, false);
                loop {
                    interval.tick().await;
                    let hidden = watcher.window_hidden();
                    #[cfg(windows)]
                    {
                        let hibernation = handle.state::<WindowHibernation>();
                        if hibernation.is_tray_hidden() {
                            minimized_since = None;
                            minimized_low = false;
                            match hibernation.next_action(Instant::now()) {
                                Some(HibernationStage::Suspended) => {
                                    if let Some(window) = handle.get_webview_window("main") {
                                        suspend_webview(&window);
                                        hibernation.set_stage(HibernationStage::Suspended);
                                    }
                                }
                                Some(HibernationStage::Trimmed) => {
                                    if let Some(window) = handle.get_webview_window("main") {
                                        if matches!(window.is_visible(), Ok(false)) {
                                            trim_webview_working_set(&window);
                                            hibernation.set_stage(HibernationStage::Trimmed);
                                        }
                                    }
                                }
                                _ => {}
                            }
                        } else {
                            let low = if hidden {
                                minimized_since
                                    .get_or_insert_with(Instant::now)
                                    .elapsed()
                                    >= TRAY_SUSPEND_DELAY
                            } else {
                                minimized_since = None;
                                false
                            };
                            if low != minimized_low {
                                set_webview_memory_target(&handle, low);
                                minimized_low = low;
                            }
                        }
                    }
                    air::proxy::Runtime::sample_telemetry_with_visibility(&watcher.proxy, hidden).await;
                    if let Ok(status) = watcher.proxy.lock().await.status().await {
                        tray::sync(&handle, &status);
                    }
                }
            });
            tauri::async_runtime::spawn(state.clone().update_subscriptions(app.handle().clone()));
            tauri::async_runtime::spawn(state.background_loop());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            let state = window.state::<Arc<commands::App>>();
            match event {
                tauri::WindowEvent::CloseRequested { api, .. }
                    if window.app_handle().tray_by_id(tray::ID).is_some() =>
                {
                    let bounds = capture_window_bounds(window);
                    if window.hide().is_ok() {
                        api.prevent_close();
                        window.app_handle().state::<StartupReveal>().0.store(true, Ordering::Release);
                        state.set_window_hidden(true);
                        window.app_handle().state::<WindowHibernation>().mark_tray_hidden(bounds);
                    }
                }
                tauri::WindowEvent::Focused(true) => {
                    let visible = matches!(window.is_visible(), Ok(true));
                    let minimized = matches!(window.is_minimized(), Ok(true));
                    if visible {
                        window.app_handle().state::<WindowHibernation>().mark_shown();
                    }
                    state.set_window_hidden(!visible || minimized);
                }
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(false) => {
                    let visible = matches!(window.is_visible(), Ok(true));
                    let minimized = matches!(window.is_minimized(), Ok(true));
                    let tray_hidden = window.app_handle().state::<WindowHibernation>().is_tray_hidden();
                    state.set_window_hidden(tray_hidden || !visible || minimized);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            system_prefers_dark,
            reveal_startup_window,
            set_window_background,
            languages::list_languages,
            languages::choose_language,
            languages::import_language,
            commands::read_ui_preferences,
            commands::write_ui_preferences,
            commands::library,
            commands::import_subscription,
            commands::preview_subscription,
            commands::subscription_url,
            commands::refresh_subscription,
            commands::subscription_policy,
            commands::subscription_extension,
            commands::save_subscription_extension,
            commands::subscription_yaml,
            commands::update_subscription,
            commands::delete_subscription,
            commands::change_subscription_item,
            commands::edit_node,
            commands::reset_node,
            commands::source_document,
            commands::restore_source_yaml,
            commands::validate_yaml,
            commands::save_yaml,
            commands::custom_node,
            commands::save_custom_node,
            commands::delete_custom_node,
            commands::test_custom_node,
            commands::custom_groups,
            commands::save_custom_group,
            commands::change_custom_group_members,
            commands::delete_custom_group,
            commands::verify_chain,
            commands::validate_chain,
            commands::routing_path,
            #[cfg(windows)]
            commands::open_config_folder,
            commands::validate_config_file,
            commands::read_config_file,
            commands::save_config_file,
            commands::routing_settings,
            commands::network_settings,
            commands::subscription_resolvers,
            commands::test_dns_settings,
            commands::save_network_settings,
            commands::preview_routing,
            commands::save_routing,
            commands::default_kernel_path,
            commands::proxy_status,
            commands::startup::startup_settings,
            commands::startup::set_startup_setting,
            commands::startup::start_proxy_on_launch,
            commands::proxy_exit,
            commands::proxy_connectivity,
            #[cfg(windows)]
            commands::install_tun_service,
            commands::proxy_telemetry,
            commands::resolve_applications,
            commands::proxy_control,
            commands::clear_connection_logs,
            commands::close_matching_connections,
            commands::batch_probe,
            commands::cancel_batch_probe,
            commands::probe_node,
            commands::node_metrics,
            commands::set_background,
            commands::monitor_status,
            tray::show_main_window,
            tray::take_pending_tray_action,
            #[cfg(windows)]
            updater::update_status,
            #[cfg(windows)]
            updater::check_update,
            #[cfg(windows)]
            updater::start_update,
            #[cfg(windows)]
            updater::pause_update,
            #[cfg(windows)]
            updater::cancel_update,
            #[cfg(windows)]
            updater::ignore_update,
            #[cfg(windows)]
            updater::open_update_link,
        ])
        .build(tauri::generate_context!())
        .expect("could not build Air")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, code, .. } if code.is_none() => {
                api.prevent_exit();
            }
            tauri::RunEvent::Exit => {
                let state = app.state::<Arc<commands::App>>();
                if let Err(error) = tauri::async_runtime::block_on(state.shutdown()) {
                    eprintln!("{error}");
                }
            }
            _ => {}
        });
}
