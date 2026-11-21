mod package;
#[cfg(test)]
mod tests;
mod windows;

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::VerifyingKey;
use reqwest::{Client, StatusCode, Url};
use semver::Version;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use self::package::{io_error, Manifest, MAX_MANIFEST};
pub use self::windows::run_helper;

const EVENT: &str = "air://update";
const APPROVED: &str = "approved.json";
const IGNORED: &str = "ignored.txt";
const FEED: Option<&str> = option_env!("AIR_UPDATE_FEED");
const KEY: Option<&str> = option_env!("AIR_UPDATE_PUBLIC_KEY");

pub fn current_version() -> Version {
    Version::parse(env!("CARGO_PKG_VERSION")).expect("valid package version")
}

fn public_key() -> Result<VerifyingKey, String> {
    let key = KEY.ok_or("尚未配置正式更新渠道")?;
    let bytes: [u8; 32] = STANDARD
        .decode(key.trim())
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or("更新签名公钥无效")?;
    VerifyingKey::from_bytes(&bytes).map_err(|_| "更新签名公钥无效".into())
}

#[derive(Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Idle,
    Checking,
    Current,
    Available,
    Preparing,
    Downloading,
    Installing,
    Interrupted,
    Unconfigured,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    received: u64,
    total: u64,
    speed: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    current: String,
    phase: Phase,
    version: Option<String>,
    notes: Option<String>,
    message: Option<String>,
    progress: Progress,
    ignored: bool,
}

struct View {
    status: Status,
    release: Option<Arc<[u8]>>,
}

pub struct Updater {
    root: PathBuf,
    client: Client,
    view: Mutex<View>,
    operation: Arc<tokio::sync::Mutex<()>>,
}

impl Updater {
    pub fn open(data: &Path) -> Result<Self, String> {
        let root = data.join("updates");
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(12))
            .read_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(180))
            .user_agent(concat!("Air/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::custom(|redirect| {
                if redirect.previous().len() < 5
                    && package::allowed_url(redirect.url())
                    && !redirect
                        .previous()
                        .iter()
                        .any(|url| url.scheme() == "https" && redirect.url().scheme() != "https")
                {
                    redirect.follow()
                } else {
                    redirect.error("invalid update redirect")
                }
            }))
            .build()
            .map_err(|_| "无法初始化更新连接")?;
        Ok(Self {
            root,
            client,
            view: Mutex::new(View {
                status: Status {
                    current: current_version().to_string(),
                    phase: Phase::Idle,
                    version: None,
                    notes: None,
                    message: None,
                    progress: Progress::default(),
                    ignored: false,
                },
                release: None,
            }),
            operation: Arc::new(tokio::sync::Mutex::new(())),
        })
    }

    fn status(&self) -> Status {
        self.view.lock().unwrap().status.clone()
    }

    fn emit(&self, app: &AppHandle, edit: impl FnOnce(&mut View)) {
        let snapshot = {
            let mut view = self.view.lock().unwrap();
            edit(&mut view);
            view.status.clone()
        };
        let _ = app.emit(EVENT, snapshot);
    }

    fn phase(&self, app: &AppHandle, phase: Phase, message: Option<String>) {
        self.emit(app, |view| {
            view.status.phase = phase;
            view.status.message = message;
        });
    }

    fn release(&self, app: &AppHandle, raw: Arc<[u8]>, manifest: &Manifest, ignored: bool) {
        let version = manifest.version.to_string();
        self.emit(app, |view| {
            if view.status.version.as_deref() != Some(&version) {
                view.status.progress = Progress::default();
            }
            view.release = Some(raw);
            view.status.version = Some(version);
            view.status.notes = Some(manifest.notes.clone());
            view.status.ignored = ignored;
            view.status.phase = Phase::Available;
            view.status.message = None;
        });
    }

    async fn read_feed(&self, url: Url) -> Result<Option<Arc<[u8]>>, String> {
        let mut response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|_| "无法连接更新服务器")?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(format!(
                "更新服务器返回 HTTP {}",
                response.status().as_u16()
            ));
        }
        let mut raw = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| "更新清单下载中断")? {
            if raw.len() + chunk.len() > MAX_MANIFEST {
                return Err("更新清单过大".into());
            }
            raw.extend_from_slice(&chunk);
        }
        Ok(Some(raw.into()))
    }

    async fn check(&self, app: &AppHandle) {
        let Ok(_operation) = self.operation.try_lock() else {
            return;
        };
        let phase = self.status().phase;
        if phase == Phase::Installing {
            return;
        }
        let Some(url) = FEED
            .and_then(|value| Url::parse(value).ok())
            .filter(package::allowed_url)
        else {
            self.phase(
                app,
                Phase::Unconfigured,
                Some("当前安装包没有配置更新渠道".into()),
            );
            return;
        };
        let Ok(key) = public_key() else {
            self.phase(
                app,
                Phase::Unconfigured,
                Some("当前安装包没有有效的更新公钥".into()),
            );
            return;
        };
        self.phase(app, Phase::Checking, None);
        let found = self.read_feed(url).await.and_then(|raw| {
            raw.map(|raw| package::verify(&raw, &key).map(|manifest| (raw, manifest)))
                .transpose()
        });
        match found {
            Ok(Some((raw, manifest))) if manifest.version > current_version() => {
                let ignored = fs::read_to_string(self.root.join(IGNORED))
                    .is_ok_and(|version| version == manifest.version.to_string());
                self.release(app, raw, &manifest, ignored);
            }
            Ok(_) => self.emit(app, |view| {
                view.release = None;
                view.status.phase = Phase::Current;
                view.status.version = None;
                view.status.notes = None;
                view.status.ignored = false;
                view.status.progress = Progress::default();
            }),
            Err(error) => self.phase(app, Phase::Interrupted, Some(error)),
        }
    }

    async fn download_and_handoff(
        &self,
        app: &AppHandle,
        raw: Arc<[u8]>,
        manifest: Arc<Manifest>,
    ) -> Result<(), String> {
        let install = windows::current_install()?;
        let id = package::hash(&raw);
        let cache = self.root.join(&id);
        fs::create_dir_all(&cache).map_err(io_error)?;
        package::write_atomic(&self.root.join(APPROVED), &raw).map_err(io_error)?;
        let _ = fs::remove_file(self.root.join("install-error.txt"));
        self.phase(app, Phase::Preparing, None);

        let mut url = Url::parse(&manifest.asset).map_err(|_| "更新包地址无效")?;
        for attempt in 0..3 {
            let plan = tokio::task::spawn_blocking({
                let (manifest, install, cache) = (manifest.clone(), install.clone(), cache.clone());
                move || package::plan(&manifest, &install, &cache)
            })
            .await
            .map_err(|_| "无法准备更新数据")?;
            let mut progress = Progress {
                received: plan.iter().map(|block| block.saved).sum(),
                total: plan.iter().map(|block| block.length()).sum(),
                speed: 0,
            };
            let mut last = Instant::now();
            let mut last_bytes = progress.received;
            self.emit(app, |view| {
                view.status.phase = Phase::Downloading;
                view.status.progress = progress.clone();
                view.status.message = None;
            });
            let mut result = Ok(());
            for block in &plan {
                result = package::fetch_block(
                    &self.client,
                    &mut url,
                    manifest.asset_size,
                    block,
                    |len| {
                        progress.received += len;
                        let elapsed = last.elapsed();
                        if elapsed >= Duration::from_millis(200)
                            || progress.received == progress.total
                        {
                            progress.speed = ((progress.received - last_bytes) as f64
                                / elapsed.as_secs_f64().max(0.001))
                                as u64;
                            last = Instant::now();
                            last_bytes = progress.received;
                            self.emit(app, |view| view.status.progress = progress.clone());
                        }
                    },
                )
                .await;
                if result.is_err() {
                    break;
                }
            }
            match result {
                Ok(()) => break,
                Err(error) if attempt == 2 => return Err(error),
                Err(error) => {
                    self.phase(app, Phase::Downloading, Some(format!("{error}，正在重试")));
                    tokio::time::sleep(Duration::from_secs(2 << attempt)).await;
                    url = Url::parse(&manifest.asset).map_err(|_| "更新包地址无效")?;
                }
            }
        }
        self.phase(app, Phase::Preparing, Some("正在校验更新文件…".into()));
        tokio::task::spawn_blocking({
            let (manifest, install, cache) = (manifest, install.clone(), cache.clone());
            move || package::assemble(&manifest, &install, &cache)
        })
        .await
        .map_err(|_| "无法准备安装文件")??;

        let state = app.state::<Arc<crate::commands::App>>();
        let mut proxy = state.proxy.lock().await;
        proxy
            .stop()
            .await
            .map_err(|error| format!("停止代理后才能安装（{error}）"))?;
        self.phase(app, Phase::Installing, None);
        // Hold the proxy lock until exit is requested so it cannot start in the handoff.
        windows::handoff(&self.root, &install, &id)?;
        app.exit(0);
        Ok(())
    }

    async fn start(&self, app: &AppHandle, raw: Arc<[u8]>) {
        let result = async {
            let manifest = Arc::new(package::verify(&raw, &public_key()?)?);
            if manifest.version <= current_version() {
                return Err("当前已安装此更新".into());
            }
            self.release(app, raw.clone(), &manifest, false);
            self.download_and_handoff(app, raw, manifest).await
        }
        .await;
        if let Err(error) = result {
            self.phase(app, Phase::Interrupted, Some(error));
        }
    }

    async fn resume(&self, app: &AppHandle) -> bool {
        let Ok(_operation) = self.operation.try_lock() else {
            return true;
        };
        let Ok(raw) = fs::read(self.root.join(APPROVED)) else {
            return false;
        };
        let Ok(manifest) = public_key().and_then(|key| package::verify(&raw, &key)) else {
            let _ = fs::remove_file(self.root.join(APPROVED));
            return false;
        };
        if manifest.version <= current_version() {
            if windows::current_install().is_ok() {
                let _ = tokio::task::spawn_blocking({
                    let root = self.root.clone();
                    move || windows::clean(&root, &raw)
                })
                .await;
            }
            return false;
        }
        if let Ok(error) = fs::read_to_string(self.root.join("install-error.txt")) {
            self.release(app, raw.into(), &manifest, false);
            self.phase(app, Phase::Interrupted, Some(error));
            return true;
        }
        self.start(app, raw.into()).await;
        true
    }

    pub async fn background(self: Arc<Self>, app: AppHandle) {
        let mut next_check = Instant::now();
        loop {
            if self.status().phase != Phase::Installing
                && !self.resume(&app).await
                && Instant::now() >= next_check
            {
                self.check(&app).await;
                let interval = if self.status().phase == Phase::Interrupted {
                    30 * 60
                } else {
                    6 * 60 * 60
                };
                next_check = Instant::now() + Duration::from_secs(interval);
            }
            tokio::time::sleep(Duration::from_secs(5 * 60)).await;
        }
    }
}

#[tauri::command]
pub fn update_status(state: State<'_, Arc<Updater>>) -> Status {
    state.status()
}

#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    state: State<'_, Arc<Updater>>,
) -> Result<Status, String> {
    // A previously approved release remains available offline until installation succeeds.
    if !state.root.join(APPROVED).is_file() {
        state.check(&app).await;
    }
    Ok(state.status())
}

#[tauri::command]
pub fn start_update(app: AppHandle, state: State<'_, Arc<Updater>>) -> Result<(), String> {
    let updater = state.inner().clone();
    let lock = updater
        .operation
        .clone()
        .try_lock_owned()
        .map_err(|_| "更新任务正在进行")?;
    if updater.status().phase == Phase::Installing {
        return Err("正在安装更新".into());
    }
    let raw = updater
        .view
        .lock()
        .unwrap()
        .release
        .clone()
        .ok_or("没有可安装的更新")?;
    updater.phase(&app, Phase::Preparing, None);
    tauri::async_runtime::spawn(async move {
        let _lock = lock;
        updater.start(&app, raw).await;
    });
    Ok(())
}

#[tauri::command]
pub fn ignore_update(app: AppHandle, state: State<'_, Arc<Updater>>) -> Result<(), String> {
    let _lock = state.operation.try_lock().map_err(|_| "更新任务正在进行")?;
    let version = state.status().version.ok_or("没有可忽略的更新")?;
    fs::create_dir_all(&state.root).map_err(io_error)?;
    package::write_atomic(&state.root.join(IGNORED), version.as_bytes()).map_err(io_error)?;
    if let Ok(raw) = fs::read(state.root.join(APPROVED)) {
        fs::remove_file(state.root.join(APPROVED)).map_err(io_error)?;
        let _ = fs::remove_dir_all(state.root.join(package::hash(&raw)));
        let _ = fs::remove_file(state.root.join("install-error.txt"));
    }
    state.emit(&app, |view| view.status.ignored = true);
    Ok(())
}

#[tauri::command]
pub fn open_update_link(url: String) -> Result<(), String> {
    windows::open_url(&url)
}
