mod package;
#[cfg(test)]
mod tests;
mod windows;

use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
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
    Paused,
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
    control: Mutex<Option<tokio::sync::watch::Sender<package::Control>>>,
}

struct ControlGuard<'a>(&'a Mutex<Option<tokio::sync::watch::Sender<package::Control>>>);

impl Drop for ControlGuard<'_> {
    fn drop(&mut self) {
        *self.0.lock().unwrap() = None;
    }
}

async fn active_proxy_port(app: &AppHandle) -> Option<u16> {
    let state = app.try_state::<Arc<crate::commands::App>>()?;
    let proxy = state.proxy.lock().await;
    proxy.subscription_proxy_port()
}

impl Updater {
    fn build_client(proxy_port: Option<u16>) -> Result<Client, String> {
        let mut builder = Client::builder()
            .connect_timeout(Duration::from_secs(12))
            .read_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(180))
            .pool_max_idle_per_host(6)
            .tcp_nodelay(true)
            .user_agent(concat!("Air-Proxy/", env!("CARGO_PKG_VERSION")))
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
            }));
        if let Some(port) = proxy_port {
            let proxy = reqwest::Proxy::all(format!("http://127.0.0.1:{port}"))
                .map_err(|_| "无法配置 Air Proxy 下载代理")?;
            builder = builder.no_proxy().proxy(proxy);
        }
        builder.build().map_err(|_| "无法初始化更新连接".into())
    }

    pub fn open(data: &Path) -> Result<Self, String> {
        let root = data.join("updates");
        let client = Self::build_client(None)?;
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
            control: Mutex::new(None),
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

    async fn read_feed_with(client: &Client, url: Url) -> Result<Option<Arc<[u8]>>, (bool, String)> {
        let mut response = client
            .get(url)
            .send()
            .await
            .map_err(|_| (true, "无法连接更新服务器".to_owned()))?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err((
                false,
                format!("更新服务器返回 HTTP {}", response.status().as_u16()),
            ));
        }
        let mut raw = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| (false, "更新清单下载中断".to_owned()))?
        {
            if raw.len() + chunk.len() > MAX_MANIFEST {
                return Err((false, "更新清单过大".to_owned()));
            }
            raw.extend_from_slice(&chunk);
        }
        Ok(Some(raw.into()))
    }

    async fn read_feed(&self, app: &AppHandle, url: Url) -> Result<Option<Arc<[u8]>>, String> {
        if let Some(port) = active_proxy_port(app).await {
            let proxy_client = Self::build_client(Some(port))?;
            match Self::read_feed_with(&proxy_client, url.clone()).await {
                Ok(raw) => return Ok(raw),
                Err((true, _)) => {}
                Err((false, error)) => return Err(error),
            }
        }
        Self::read_feed_with(&self.client, url)
            .await
            .map_err(|(_, error)| error)
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
        let found = self.read_feed(app, url).await.and_then(|raw| {
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

        let (ctrl_tx, mut ctrl_rx) = tokio::sync::watch::channel(package::Control::Running);
        *self.control.lock().unwrap() = Some(ctrl_tx.clone());
        let _control_guard = ControlGuard(&self.control);

        let mut url = Url::parse(&manifest.asset).map_err(|_| "更新包地址无效")?;
        let mut using_proxy = false;
        let mut download_client = match active_proxy_port(app).await {
            Some(port) => {
                using_proxy = true;
                Self::build_client(Some(port))?
            }
            None => self.client.clone(),
        };

        let mut use_patches = true;
        for attempt in 0..3 {
            let (selected_patches, plan) = tokio::task::spawn_blocking({
                let (manifest, install, cache) = (manifest.clone(), install.clone(), cache.clone());
                move || {
                    let patches: Vec<(package::Asset, package::Patch)> = if use_patches {
                        package::select_patches(&manifest, &install, &cache)
                            .into_iter()
                            .map(|(asset, patch)| (
                                package::Asset {
                                    name: asset.name.clone(),
                                    size: asset.size,
                                    sha256: asset.sha256.clone(),
                                    blocks: asset.blocks.clone(),
                                },
                                patch.clone(),
                            ))
                            .collect()
                    } else {
                        Vec::new()
                    };
                    let skip: HashSet<&str> = patches.iter().map(|(asset, _)| asset.name.as_str()).collect();
                    let blocks = package::plan_without(&manifest, &install, &cache, &skip);
                    (patches, blocks)
                }
            })
            .await
            .map_err(|_| "无法准备更新数据")?;

            let patch_total: u64 = selected_patches.iter().map(|(_, patch)| patch.size).sum();
            let patch_saved: u64 = selected_patches
                .iter()
                .map(|(_, patch)| package::patch_saved_bytes(&cache, patch))
                .sum();
            let total: u64 = patch_total + plan.iter().map(|block| block.length()).sum::<u64>();
            let initial_saved: u64 = patch_saved + plan.iter().map(|block| block.saved).sum::<u64>();
            let received = Arc::new(AtomicU64::new(initial_saved));
            let tracker = Arc::new(Mutex::new((Instant::now(), initial_saved)));
            self.emit(app, |view| {
                view.status.phase = Phase::Downloading;
                view.status.progress = Progress {
                    received: initial_saved,
                    total,
                    speed: 0,
                };
                view.status.message = None;
            });

            let report_progress = {
                let updater_app = app.clone();
                let received = received.clone();
                let tracker = tracker.clone();
                move |len: u64| {
                    let current = received.fetch_add(len, Ordering::Relaxed) + len;
                    let mut guard = tracker.lock().unwrap();
                    let elapsed = guard.0.elapsed();
                    if elapsed >= Duration::from_millis(200) || current >= total {
                        let delta = current.saturating_sub(guard.1);
                        let speed = (delta as f64 / elapsed.as_secs_f64().max(0.001)) as u64;
                        guard.0 = Instant::now();
                        guard.1 = current;
                        drop(guard);
                        let _ = updater_app.emit(
                            EVENT,
                            Status {
                                current: self.status().current,
                                phase: Phase::Downloading,
                                version: self.status().version,
                                notes: self.status().notes,
                                message: None,
                                progress: Progress {
                                    received: current,
                                    total,
                                    speed,
                                },
                                ignored: false,
                            },
                        );
                    }
                }
            };

            let mut outcome: Result<(), package::FetchError> = Ok(());
            for (asset, patch) in &selected_patches {
                match package::fetch_patch(&download_client, patch, &cache, &mut ctrl_rx, &report_progress).await {
                    Ok(patch_path) => {
                        let old_path = install.join(&asset.name);
                        let cache_dir = cache.clone();
                        let asset_clone = package::Asset {
                            name: asset.name.clone(),
                            size: asset.size,
                            sha256: asset.sha256.clone(),
                            blocks: asset.blocks.clone(),
                        };
                        let applied = tokio::task::spawn_blocking(move || {
                            package::apply_patch(&old_path, &patch_path, &asset_clone, &cache_dir)
                        })
                        .await
                        .unwrap_or_else(|_| Err("无法应用更新差分".into()));
                        if let Err(err) = applied {
                            use_patches = false;
                            outcome = Err(package::FetchError::Failed(err));
                            break;
                        }
                    }
                    Err(package::FetchError::Paused) => {
                        outcome = Err(package::FetchError::Paused);
                        break;
                    }
                    Err(package::FetchError::Canceled) => {
                        outcome = Err(package::FetchError::Canceled);
                        break;
                    }
                    Err(package::FetchError::Failed(err)) => {
                        use_patches = false;
                        outcome = Err(package::FetchError::Failed(err));
                        break;
                    }
                }
            }

            let pending: Vec<_> = plan
                .into_iter()
                .filter(|block| block.saved < block.length())
                .collect();
            if outcome.is_ok() {
                if let Some((first, rest)) = pending.split_first() {
                outcome = package::fetch_block(
                    &download_client,
                    &mut url,
                    manifest.asset_size,
                    first,
                    &mut ctrl_rx,
                    &report_progress,
                )
                .await;
                if outcome.is_ok() && !rest.is_empty() {
                    let semaphore = Arc::new(tokio::sync::Semaphore::new(4));
                    let mut tasks = tokio::task::JoinSet::new();
                    for block in rest.iter().cloned() {
                        let client = download_client.clone();
                        let mut worker_url = url.clone();
                        let mut worker_rx = ctrl_tx.subscribe();
                        let permit_pool = semaphore.clone();
                        let pack_size = manifest.asset_size;
                        let received = received.clone();
                        let tracker = tracker.clone();
                        let worker_app = app.clone();
                        let base_status = self.status();
                        tasks.spawn(async move {
                            let Ok(_permit) = permit_pool.acquire_owned().await else {
                                return Err(package::FetchError::Canceled);
                            };
                            package::fetch_block(
                                &client,
                                &mut worker_url,
                                pack_size,
                                &block,
                                &mut worker_rx,
                                |len| {
                                    let current = received.fetch_add(len, Ordering::Relaxed) + len;
                                    let mut guard = tracker.lock().unwrap();
                                    let elapsed = guard.0.elapsed();
                                    if elapsed >= Duration::from_millis(200) || current >= total {
                                        let delta = current.saturating_sub(guard.1);
                                        let speed =
                                            (delta as f64 / elapsed.as_secs_f64().max(0.001)) as u64;
                                        guard.0 = Instant::now();
                                        guard.1 = current;
                                        drop(guard);
                                        let _ = worker_app.emit(
                                            EVENT,
                                            Status {
                                                current: base_status.current.clone(),
                                                phase: Phase::Downloading,
                                                version: base_status.version.clone(),
                                                notes: base_status.notes.clone(),
                                                message: None,
                                                progress: Progress {
                                                    received: current,
                                                    total,
                                                    speed,
                                                },
                                                ignored: false,
                                            },
                                        );
                                    }
                                },
                            )
                            .await
                        });
                    }
                    while let Some(joined) = tasks.join_next().await {
                        match joined {
                            Ok(Ok(())) => {}
                            Ok(Err(error)) => {
                                outcome = Err(error);
                                tasks.abort_all();
                                while tasks.join_next().await.is_some() {}
                                break;
                            }
                            Err(_) => {
                                outcome = Err(package::FetchError::Failed("更新下载任务异常".into()));
                                tasks.abort_all();
                                while tasks.join_next().await.is_some() {}
                                break;
                            }
                        }
                    }
                }
                }
            }

            let saved_now = received.load(Ordering::Relaxed);
            self.emit(app, |view| {
                view.status.progress.received = saved_now;
                view.status.progress.total = total;
            });

            match outcome {
                Ok(()) => break,
                Err(package::FetchError::Paused) => {
                    let _ = fs::remove_file(self.root.join(APPROVED));
                    self.emit(app, |view| {
                        view.status.phase = Phase::Paused;
                        view.status.progress.received = saved_now;
                        view.status.progress.total = total;
                        view.status.progress.speed = 0;
                        view.status.message = None;
                    });
                    return Ok(());
                }
                Err(package::FetchError::Canceled) => {
                    let _ = fs::remove_file(self.root.join(APPROVED));
                    let _ = fs::remove_dir_all(&cache);
                    let _ = fs::remove_file(self.root.join("install-error.txt"));
                    self.emit(app, |view| {
                        view.status.phase = Phase::Available;
                        view.status.progress = Progress::default();
                        view.status.message = None;
                    });
                    return Ok(());
                }
                Err(package::FetchError::Failed(error)) if attempt == 2 => return Err(error),
                Err(package::FetchError::Failed(error)) => {
                    self.phase(app, Phase::Downloading, Some(format!("{error}，正在重试")));
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(2 << attempt)) => {}
                        _ = ctrl_rx.changed() => {
                            match *ctrl_rx.borrow() {
                                package::Control::Pause => {
                                    let _ = fs::remove_file(self.root.join(APPROVED));
                                    self.emit(app, |view| {
                                        view.status.phase = Phase::Paused;
                                        view.status.progress.speed = 0;
                                        view.status.message = None;
                                    });
                                    return Ok(());
                                }
                                package::Control::Cancel => {
                                    let _ = fs::remove_file(self.root.join(APPROVED));
                                    let _ = fs::remove_dir_all(&cache);
                                    let _ = fs::remove_file(self.root.join("install-error.txt"));
                                    self.emit(app, |view| {
                                        view.status.phase = Phase::Available;
                                        view.status.progress = Progress::default();
                                        view.status.message = None;
                                    });
                                    return Ok(());
                                }
                                package::Control::Running => {}
                            }
                        }
                    }
                    if using_proxy {
                        using_proxy = false;
                        download_client = self.client.clone();
                    } else if let Some(port) = active_proxy_port(app).await {
                        if let Ok(client) = Self::build_client(Some(port)) {
                            using_proxy = true;
                            download_client = client;
                        }
                    }
                    url = Url::parse(&manifest.asset).map_err(|_| "更新包地址无效")?;
                }
            }
        }
        drop(_control_guard);
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
            let phase = self.status().phase;
            if phase != Phase::Installing
                && phase != Phase::Paused
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
pub async fn pause_update(state: State<'_, Arc<Updater>>) -> Result<(), String> {
    let sender = state.control.lock().unwrap().clone();
    if let Some(sender) = sender {
        let _ = sender.send(package::Control::Pause);
        let _lock = state.operation.lock().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn cancel_update(app: AppHandle, state: State<'_, Arc<Updater>>) -> Result<(), String> {
    if state.status().phase == Phase::Installing {
        return Err("正在安装更新".into());
    }
    let sender = state.control.lock().unwrap().clone();
    if let Some(sender) = sender {
        let _ = sender.send(package::Control::Cancel);
    }
    let _lock = state.operation.lock().await;
    let _ = fs::remove_file(state.root.join(APPROVED));
    let _ = fs::remove_file(state.root.join("install-error.txt"));
    let release = state.view.lock().unwrap().release.clone();
    if let Some(raw) = release {
        let _ = fs::remove_dir_all(state.root.join(package::hash(&raw)));
        state.emit(&app, |view| {
            view.status.phase = Phase::Available;
            view.status.progress = Progress::default();
            view.status.message = None;
        });
    }
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
