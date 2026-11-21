#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod tray;
#[cfg(windows)]
mod updater;

use std::{io, sync::Arc};
use tauri::{Manager, WebviewWindowBuilder};

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
            let state = Arc::new(commands::App::open(directory.clone()).map_err(io::Error::other)?);
            app.manage(state.clone());
            #[cfg(windows)]
            let updates = {
                let updates =
                    Arc::new(updater::Updater::open(&directory).map_err(io::Error::other)?);
                app.manage(updates.clone());
                updates
            };

            let window =
                WebviewWindowBuilder::from_config(app.handle(), &app.config().app.windows[0])?;
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
            commands::batch_probe,
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
