mod artwork;
mod menu_icons;

use crate::languages::tr;
use self::artwork::TaskbarAppearance;
use air::proxy::{Mode, Status};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{CheckMenuItem, IconMenuItem, Menu, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Emitter, Manager,
};

pub const ID: &str = "air-tray";
const EVENT: &str = "air://tray-action";

#[derive(Clone, Serialize)]
#[serde(tag = "action", rename_all = "camelCase")]
enum TrayAction {
    Start,
    Stop,
    Mode { mode: Mode },
    SystemProxy { enabled: bool },
    Tun { enabled: bool },
    ReportError { message: String },
}

#[derive(Clone, Copy, Default, PartialEq)]
struct MenuState {
    running: bool,
    mode: Mode,
    system_proxy: bool,
    tun: bool,
    appearance: TaskbarAppearance,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TrayStatusIcon {
    Stopped,
    Running,
    SystemProxy,
    Tun,
}

impl MenuState {
    fn status_icon(self) -> TrayStatusIcon {
        match (self.running, self.tun, self.system_proxy) {
            (false, _, _) => TrayStatusIcon::Stopped,
            (true, true, _) => TrayStatusIcon::Tun,
            (true, false, true) => TrayStatusIcon::SystemProxy,
            (true, false, false) => TrayStatusIcon::Running,
        }
    }
}

impl TrayStatusIcon {
    fn tooltip(self) -> &'static str {
        match self {
            Self::Stopped => "Air · 代理已停止",
            Self::Running => "Air · 代理运行中",
            Self::SystemProxy => "Air · 系统代理已启用",
            Self::Tun => "Air · TUN 已启用",
        }
    }
}

struct TrayMenu {
    state: Mutex<MenuState>,
    captions: [(&'static str, IconMenuItem<tauri::Wry>); 4],
    power: IconMenuItem<tauri::Wry>,
    icons: Mutex<menu_icons::MenuIcons>,
    modes: [(Mode, CheckMenuItem<tauri::Wry>); 3],
    system_proxy: CheckMenuItem<tauri::Wry>,
    tun: CheckMenuItem<tauri::Wry>,
}

impl TrayMenu {
    fn update(&self, app: &AppHandle, next: MenuState) -> tauri::Result<()> {
        let mut state = self.state.lock().expect("tray state poisoned");
        if *state == next {
            return Ok(());
        }
        let icon = next.status_icon();
        if icon != state.status_icon() || next.appearance != state.appearance {
            if let Some(tray) = app.tray_by_id(ID) {
                tray.set_icon(Some(next.appearance.image(icon)?))?;
                tray.set_tooltip(Some(tr(icon.tooltip())))?;
            }
        }
        if next.running != state.running {
            self.power.set_text(tr(if next.running { "停止代理" } else { "启动代理" }))?;
        }
        let size_changed = next.appearance.icon_size != state.appearance.icon_size;
        if size_changed || next.running != state.running {
            self.icons.lock().expect("tray icons poisoned").apply(
                next.appearance.icon_size, next.running, !size_changed,
            )?;
        }
        if next.mode != state.mode {
            for (mode, item) in &self.modes {
                item.set_checked(*mode == next.mode)?;
            }
        }
        if next.system_proxy != state.system_proxy {
            self.system_proxy.set_checked(next.system_proxy)?;
        }
        if next.tun != state.tun {
            self.tun.set_checked(next.tun)?;
        }
        *state = next;
        Ok(())
    }

    fn action(&self, id: &str) -> tauri::Result<Option<TrayAction>> {
        let state = *self.state.lock().expect("tray state poisoned");
        // Native check items toggle on click. Restore the confirmed state until IPC succeeds.
        if let Some((mode, item)) = self.modes.iter().find(|(_, item)| item.id().as_ref() == id) {
            item.set_checked(*mode == state.mode)?;
            return Ok((*mode != state.mode).then_some(TrayAction::Mode { mode: *mode }));
        }
        Ok(match id {
            "tray-power" if state.running => Some(TrayAction::Stop),
            "tray-power" => Some(TrayAction::Start),
            "tray-system-proxy" => {
                self.system_proxy.set_checked(state.system_proxy)?;
                Some(TrayAction::SystemProxy {
                    enabled: !state.system_proxy,
                })
            }
            "tray-tun" => {
                self.tun.set_checked(state.tun)?;
                Some(TrayAction::Tun {
                    enabled: !state.tun,
                })
            }
            _ => None,
        })
    }
}

pub fn setup(app: &App) -> tauri::Result<()> {
    let icon_item = |id, text, enabled| {
        IconMenuItem::with_id(app, id, tr(text), enabled, None, None::<&str>)
    };
    let check_item = |id, text, enabled, checked| {
        CheckMenuItem::with_id(app, id, tr(text), enabled, checked, None::<&str>)
    };
    let state = MenuState {
        appearance: TaskbarAppearance::current(),
        ..MenuState::default()
    };
    let icon = state.appearance.image(state.status_icon())?;
    let show = icon_item("tray-show", "打开 Air", true)?;
    let power = icon_item("tray-power", "启动代理", true)?;
    let route = icon_item("tray-route-heading", "出站模式", false)?;
    let network = icon_item("tray-network-heading", "网络接管", false)?;
    let exit = icon_item("tray-exit", "退出 Air", true)?;
    let modes = [
        (
            Mode::Rule,
            check_item("tray-rule", "规则", true, state.mode == Mode::Rule)?,
        ),
        (
            Mode::Global,
            check_item("tray-global", "全局", true, state.mode == Mode::Global)?,
        ),
        (
            Mode::Direct,
            check_item("tray-direct", "直连", true, state.mode == Mode::Direct)?,
        ),
    ];
    let system_proxy = check_item("tray-system-proxy", "系统代理", true, false)?;
    let tun = check_item("tray-tun", "虚拟网卡", true, false)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &power,
            &PredefinedMenuItem::separator(app)?,
            &route,
            &modes[0].1,
            &modes[1].1,
            &modes[2].1,
            &PredefinedMenuItem::separator(app)?,
            &network,
            &system_proxy,
            &tun,
            &PredefinedMenuItem::separator(app)?,
            &exit,
        ],
    )?;
    let mut icons = menu_icons::MenuIcons::new(menu.clone());
    icons.apply(state.appearance.icon_size, state.running, false)?;
    app.manage(TrayMenu {
        state: Mutex::new(state),
        captions: [("打开 Air", show), ("出站模式", route), ("网络接管", network), ("退出 Air", exit)],
        power,
        icons: Mutex::new(icons),
        modes,
        system_proxy,
        tun,
    });
    TrayIconBuilder::with_id(ID)
        .icon(icon)
        .tooltip(tr(state.status_icon().tooltip()))
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            if let Err(error) = on_menu(app, event.id().as_ref()) {
                eprintln!("Air tray: {error}");
            }
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                let _ = show_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

pub fn refresh_language(app: &AppHandle) -> tauri::Result<()> {
    let menu = app.state::<TrayMenu>();
    let state = *menu.state.lock().expect("tray state poisoned");
    for (key, item) in &menu.captions {
        item.set_text(tr(key))?;
    }
    menu.power.set_text(tr(if state.running { "停止代理" } else { "启动代理" }))?;
    for (mode, item) in &menu.modes {
        item.set_text(tr(match mode {
            Mode::Rule => "规则",
            Mode::Global => "全局",
            Mode::Direct => "直连",
        }))?;
    }
    menu.system_proxy.set_text(tr("系统代理"))?;
    menu.tun.set_text(tr("虚拟网卡"))?;
    if let Some(tray) = app.tray_by_id(ID) {
        tray.set_tooltip(Some(tr(state.status_icon().tooltip())))?;
    }
    Ok(())
}

pub fn sync(app: &AppHandle, status: &Status) {
    let state = MenuState {
        running: status.running,
        mode: status.mode,
        system_proxy: status.system_proxy,
        tun: status.tun,
        appearance: TaskbarAppearance::current(),
    };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(error) = handle.state::<TrayMenu>().update(&handle, state) {
            eprintln!("Air tray: {error}");
        }
    });
}

fn on_menu(app: &AppHandle, id: &str) -> tauri::Result<()> {
    match id {
        "tray-show" => show_window(app)?,
        "tray-exit" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<Arc<crate::commands::App>>();
                let result = state.proxy.lock().await.stop().await;
                match result {
                    Ok(()) => app.exit(0),
                    Err(error) => {
                        let _ = app.emit(
                            EVENT,
                            TrayAction::ReportError {
                                message: format!("退出 Air 失败：{error}"),
                            },
                        );
                        let _ = show_window(&app);
                    }
                }
            });
        }
        _ => {
            if let Some(action) = app.state::<TrayMenu>().action(id)? {
                app.emit(EVENT, action)?;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn show_main_window(app: AppHandle) -> Result<(), String> {
    show_window(&app).map_err(|error| error.to_string())
}

pub(crate) fn show_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(startup) = app.try_state::<crate::StartupReveal>() {
        startup.0.store(true, std::sync::atomic::Ordering::Release);
    }
    if let Some(window) = app.get_webview_window("main") {
        app.state::<Arc<crate::commands::App>>().set_window_hidden(false);
        window.show()?;
        if window.is_minimized()? {
            window.unminimize()?;
        }
        window.set_focus()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{MenuState, Mode, TrayStatusIcon};

    #[test]
    fn tray_icon_follows_confirmed_network_capture() {
        for (running, system_proxy, tun, expected) in [
            (false, false, false, TrayStatusIcon::Stopped),
            (false, true, true, TrayStatusIcon::Stopped),
            (true, false, false, TrayStatusIcon::Running),
            (true, true, false, TrayStatusIcon::SystemProxy),
            (true, false, true, TrayStatusIcon::Tun),
            (true, true, true, TrayStatusIcon::Tun),
        ] {
            for mode in [Mode::Rule, Mode::Global, Mode::Direct] {
                let state = MenuState { running, mode, system_proxy, tun, ..MenuState::default() };
                assert_eq!(state.status_icon(), expected);
            }
        }
    }
}
