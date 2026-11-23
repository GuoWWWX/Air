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
        Arc,
    },
};
use tauri::{Manager, WebviewWindowBuilder};

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
            let preferred_theme = saved_window_theme(&config);
            let system_dark = system_prefers_dark();
            let state = Arc::new(commands::App::open_profile(config, directory.clone()).map_err(io::Error::other)?);
            app.manage(state.clone());
            #[cfg(windows)]
            let updates = {
                let updates =
                    Arc::new(updater::Updater::open(&directory).map_err(io::Error::other)?);
                app.manage(updates.clone());
                updates
            };

            app.manage(StartupReveal(AtomicBool::new(false)));
            let dark = preferred_theme.map_or(system_dark.unwrap_or(false), |theme| theme == tauri::Theme::Dark);
            let boot_theme = match preferred_theme {
                Some(tauri::Theme::Dark) => "dark",
                Some(_) => "light",
                None => "system",
            };
            let window =
                WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?
                    .visible(false)
                    .initialization_script(format!(
                        "window.airBootTheme = {{ preference: '{boot_theme}', systemDark: {} }};\
                        if (!window.__airFindDisabled) {{ window.__airFindDisabled = true; window.addEventListener('keydown', function(e) {{ if (e.defaultPrevented) return; var k = (e.key || '').toLowerCase(); if (((e.ctrlKey || e.metaKey) && !e.altKey && (k === 'f' || k === 'g')) || e.key === 'F3') e.preventDefault(); }}); }}",
                        serde_json::to_string(&system_dark)?
                    ))
                    .background_color(window_background_color(dark))
                    .theme(preferred_theme);
            // An active dev WebView2 process can block another app using its profile.
            #[cfg(windows)]
            let window = if tauri::is_dev() {
                window
            } else {
                window.data_directory(directory.join("webview-release"))
            };
            let _main_window = window.build()?;
            #[cfg(windows)]
            set_taskbar_icon(_main_window.hwnd()?.0);
            tray::setup(app)?;
            let startup_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
                let reveal_handle = startup_handle.clone();
                let _ = startup_handle.run_on_main_thread(move || reveal_on_startup(&reveal_handle));
            });

            #[cfg(windows)]
            tauri::async_runtime::spawn(updates.background(app.handle().clone()));
            let watcher = state.clone();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
                interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                loop {
                    interval.tick().await;
                    air::proxy::Runtime::sample_telemetry(&watcher.proxy).await;
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
                    if window.app_handle().tray_by_id(tray::ID).is_some()
                        && window.hide().is_ok() =>
                {
                    api.prevent_close();
                    window.app_handle().state::<StartupReveal>().0.store(true, Ordering::Release);
                    state.set_window_hidden(true);
                }
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Focused(_) => {
                    let hidden = matches!(window.is_visible(), Ok(false))
                        || matches!(window.is_minimized(), Ok(true));
                    state.set_window_hidden(hidden);
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
            #[cfg(windows)]
            commands::install_tun_service,
            commands::proxy_telemetry,
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
            #[cfg(windows)]
            updater::update_status,
            #[cfg(windows)]
            updater::check_update,
            #[cfg(windows)]
            updater::start_update,
            #[cfg(windows)]
            updater::ignore_update,
            #[cfg(windows)]
            updater::open_update_link,
        ])
        .build(tauri::generate_context!())
        .expect("could not build Air")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<Arc<commands::App>>();
                if let Err(error) =
                    tauri::async_runtime::block_on(async { state.proxy.lock().await.stop().await })
                {
                    eprintln!("{error}");
                }
            }
        });
}
