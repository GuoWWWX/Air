use air::{
    chains::{
        chain_hops, custom_node_mapping, node_configs, probe_revisions, CustomNodeInput, EXIT_NAME,
    },
    custom_groups::{self, CustomGroup, CustomGroupInput, MemberAction},
    mihomo::Kernel,
    network::NetworkSettings,
    monitoring::{Probe, Scheduler, BACKGROUND_CONCURRENCY, BACKGROUND_INTERVAL, FOREGROUND_CONCURRENCY, TIMEOUT},
    proxy::{
        self, Action as ProxyAction, Mode, ProxyConfig, Runtime as ProxyRuntime, StartTarget,
        Status as ProxyStatus,
        TelemetrySnapshot,
    },
    routing::{Document, NetworkDocument, RoutingConfig, RoutingFile, Target},
    storage::{NodeOverride, SourceDetails, SourceDocument, Stats, Store},
    subscriptions::{self, digest, Download, Group, Node, Source, Usage},
    AirResult,
};
use serde::{Deserialize, Serialize};
use serde_yaml::{Mapping, Value};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex as StdMutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{watch, Mutex, RwLock};
pub mod startup;

const CUSTOM_SOURCE_ID: &str = "custom";
const CUSTOM_SOURCE_NAME: &str = "自定义";

#[cfg(test)]
mod subscription_deletion_tests {
    use super::*;

    #[tokio::test]
    async fn importing_files_with_the_same_filename_keeps_both_documents() {
        let directory = tempfile::tempdir().unwrap();
        let app = App::open(directory.path().to_owned()).unwrap();
        let mut ids = Vec::new();
        for (label, host) in [("Family.yaml","one.test"),("Family.yaml (1)","two.test")] {
            let draft = prepare_import(&app, Import::File { name: String::new(), filename: "Family.yaml".into(),
                yaml: format!("proxies: [{{name: node, type: http, server: {host}, port: 80}}]") }).await.unwrap();
            assert_eq!(app.store.preview_file_name(&draft.id, &draft.name).unwrap(), label);
            app.store.save_source(&draft.id, &draft.name, &draft.download, draft.kind, None).unwrap();
            ids.push(draft.id);
        }
        assert_ne!(ids[0], ids[1]);
        assert!(app.store.source_document(&ids[0]).unwrap().original.contains("one.test"));
        assert!(app.store.source_document(&ids[1]).unwrap().original.contains("two.test"));
    }

    #[tokio::test]
    async fn saved_host_records_scope_probes_and_invalidate_stale_results() {
        let directory = tempfile::tempdir().unwrap();
        let app = App::open(directory.path().to_owned()).unwrap();
        let save = |id: &str, ip: &str| {
            let yaml = format!("hosts: {{node.home.arpa: ['2001:db8::1', '{ip}']}}\nproxies: [{{name: JP, type: http, server: node.home.arpa, port: 80}}]");
            app.store.save_source(id, id, &Download { profile_title: None, yaml, interval_hours: None, usage: None }, "file", None).unwrap();
        };
        save("one", "192.0.2.1");
        save("two", "192.0.2.2");
        app.reload().await.unwrap();
        let batches = app.probe_batches(&[]).await.unwrap();
        assert_eq!(batches.len(), 2);
        for batch in &batches {
            assert_eq!(batch.nodes.len(), 1);
            assert_eq!(batch.selected.len(), 1);
            let addresses = batch.hosts["node.home.arpa"].as_sequence().unwrap();
            assert_eq!(addresses[0], "2001:db8::1");
            assert_eq!(addresses[1], if batch.nodes[0].source_id == "one" { "192.0.2.1" } else { "192.0.2.2" });
        }
        let old = &batches.iter().find(|b| b.nodes[0].source_id == "one").unwrap().selected[0];
        save("one", "192.0.2.3");
        app.reload().await.unwrap();
        let updated = app.probe_batches(std::slice::from_ref(&old.0.id)).await.unwrap();
        assert_eq!(updated.len(), 1);
        assert_ne!(old.1, updated[0].selected[0].1);
    }

    #[tokio::test]
    async fn subscription_paused_while_syncing_keeps_the_old_original() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::sync::oneshot;
        let directory = tempfile::tempdir().unwrap();
        let app = Arc::new(App::open(directory.path().to_owned()).unwrap());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/sub", listener.local_addr().unwrap());
        let original = "proxies:\n  - {name: QA, type: http, server: old.example, port: 80}\n";
        app.store.save_source("fixture", "Fixture", &Download {
            profile_title: None,
            yaml: original.into(), interval_hours: None, usage: None,
        }, "url", Some(&url)).unwrap();
        app.reload().await.unwrap();
        let (received, requested) = oneshot::channel();
        let (respond, ready) = oneshot::channel();
        let provider = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            stream.read(&mut request).await.unwrap();
            received.send(()).unwrap();
            ready.await.unwrap();
            let body = original.replace("old.example", "fresh.example");
            let header = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            stream.write_all(header.as_bytes()).await.unwrap();
            stream.write_all(body.as_bytes()).await.unwrap();
        });
        let worker = app.clone();
        let sync = tokio::spawn(async move { sync_source(&worker, "fixture".into(), true).await });
        tokio::time::timeout(Duration::from_secs(5), requested).await.unwrap().unwrap();
        app.store.save_local_yaml("fixture", &original.replace("old.example", "local.example")).unwrap();
        respond.send(()).unwrap();
        provider.await.unwrap();
        sync.await.unwrap().unwrap();
        let doc = app.store.source_document("fixture").unwrap();
        assert_eq!(doc.original, original);
        assert!(doc.local.unwrap().contains("local.example"));
        assert_eq!(app.store.source_details().unwrap()["fixture"].auto_update, Some(false));
    }

    #[tokio::test]
    async fn deletes_a_selected_source_and_keeps_other_sources() {
        let directory = tempfile::tempdir().unwrap();
        let app = App::open(directory.path().to_owned()).unwrap();
        let source = Download {
            profile_title: None,
            interval_hours: None,
            yaml: concat!(
                "proxies:\n  - {name: Node, type: http, server: 127.0.0.1, port: 8080}\n",
                "proxy-groups:\n  - {name: Group, type: select, proxies: [Node]}\n",
                "rules: ['MATCH,Group']\n",
            ).into(),
            usage: None,
        };
        for (id, name) in [("remove", "Removal fixture"), ("keep", "Other fixture")] {
            app.store.save_source(id, name, &source, "file", None).unwrap();
        }
        app.reload().await.unwrap();
        let file = RoutingFile::new(directory.path());
        let before = file.load().unwrap();
        file.save(
            &RoutingConfig {
                rule_library: None, match_fallback: None, subscription_id: Some("remove".into()),
                inherit_rules: true,
                fallback: Target::Subscription,
                ..before.routing
            },
            &before.revision,
        ).unwrap();

        app.delete_subscription("remove").await.unwrap();
        let library = app.library.read().await;
        assert_eq!(library.sources.len(), 1);
        assert_eq!(library.sources[0].id, "keep");
        assert_eq!(library.nodes().count(), 1);
        assert_eq!(file.load().unwrap().routing.compile(&library.sources).unwrap(), ["MATCH,GLOBAL"]);
    }
}

#[derive(Default)]
struct Library {
    sources: Vec<Source>,
    revision: String,
    probe_revisions: HashMap<String, String>,
}

impl Library {
    fn load(store: &Store) -> AirResult<Self> {
        let mut fingerprints = Vec::new();
        let mut sources = Vec::new();
        for stored in store.sources()? {
            fingerprints.push(format!("{}:{}", stored.id, digest(stored.yaml.as_bytes())));
            sources.push(subscriptions::parse(stored.id, stored.name, &stored.yaml)?);
        }
        let nodes = sources
            .iter_mut()
            .flat_map(|source| source.nodes.iter_mut());
        let mut indexed = nodes
            .map(|node| (node.id.clone(), node))
            .collect::<std::collections::HashMap<_, _>>();
        for edit in store.node_overrides()? {
            if let Some(node) = indexed.get_mut(&edit.id) {
                fingerprints.push(digest(format!(
                    "{}\0{}\0{}",
                    edit.id, edit.server, edit.port
                )));
                node.display_name = edit.name;
                node.server = edit.server;
                node.port = edit.port;
            }
        }
        let mut revisions = HashMap::new();
        for source in &sources {
            revisions.extend(probe_revisions(source)?);
        }
        Ok(Self {
            sources,
            revision: digest(fingerprints.join("\n")),
            probe_revisions: revisions,
        })
    }

    fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.sources.iter().flat_map(|source| source.nodes.iter())
    }
}

pub struct App {
    launch_pending: std::sync::atomic::AtomicBool,
    directory: PathBuf,
    runtime: PathBuf,
    store: Arc<Store>,
    library: RwLock<Library>,
    edits: Mutex<()>,
    scheduler: Arc<Scheduler>,
    kernel: Mutex<Option<CachedKernel>>,
    pub proxy: Mutex<ProxyRuntime>,
    batch: Mutex<()>,
    batch_cancel: watch::Sender<u64>,
    progress: StdMutex<Progress>,
    background: watch::Sender<BackgroundMonitoring>,
}

#[derive(Default)]
struct BackgroundMonitoring {
    kernel_path: Option<PathBuf>,
    window_hidden: bool,
}

struct ProbeBatch {
    revision: String,
    nodes: Vec<Node>,
    hosts: Mapping,
    selected: Vec<(Node, String)>,
}

struct CachedKernel {
    network: NetworkSettings,
    interface: Option<String>,
    revision: String,
    path: PathBuf,
    kernel: Arc<Kernel>,
}

impl App {
    #[cfg(test)]
    pub fn open(directory: PathBuf) -> AirResult<Self> {
        Self::open_profile(directory.clone(), directory)
    }

    pub fn open_profile(directory: PathBuf, runtime: PathBuf) -> AirResult<Self> {
        let store = Arc::new(Store::open(&directory.join("air.sqlite3"))?);
        let session = store.startup_proxy()?;
        let mut proxy = ProxyRuntime::with_profile(runtime.clone(), directory.clone(), session.mode, session.tun);
        #[cfg(windows)]
        proxy.set_system_proxy(store.system_proxy_preference()?)?;
        RoutingFile::new(&directory).upgrade_factory_network()?;
        let library = Library::load(&store)?;
        store.initialize_updates(&library.sources)?;
        let (batch_cancel, _) = watch::channel(0u64);
        let (background, _) = watch::channel(BackgroundMonitoring::default());
        Ok(Self {
            launch_pending: std::sync::atomic::AtomicBool::new(true),
            proxy: Mutex::new(proxy),
            directory,
            runtime,
            store,
            library: RwLock::new(library),
            edits: Mutex::new(()),
            scheduler: Scheduler::new(FOREGROUND_CONCURRENCY, TIMEOUT),
            kernel: Mutex::new(None),
            batch: Mutex::new(()),
            batch_cancel,
            progress: StdMutex::new(Progress::default()),
            background,
        })
    }

    async fn reload(&self) -> AirResult<()> {
        *self.library.write().await = Library::load(&self.store)?;
        Ok(())
    }

    async fn delete_subscription(&self, id: &str) -> AirResult<()> {
        let _edit = self.edits.lock().await;
        let removed_node_ids: HashSet<String> = self
            .library
            .read()
            .await
            .sources
            .iter()
            .filter(|source| source.id == id)
            .flat_map(|source| source.nodes.iter().map(|node| node.id.clone()))
            .collect();
        let file = RoutingFile::new(&self.directory);
        let previous = file.load()?;
        let mut routing = previous.routing.clone();
        let detached = routing.detach_subscription(id) | routing.detach_nodes(&removed_node_ids);
        let updated = detached
            .then(|| file.save(&routing, &previous.revision))
            .transpose()?;
        if let Err(error) = self.store.delete_source(id) {
            if let Some(updated) = updated {
                file.save(&previous.routing, &updated.revision)
                    .map_err(|restore| format!("{error}。未能恢复分流配置：{restore}"))?;
            }
            return Err(error);
        }
        self.reload().await
    }

    async fn proxy_config(&self, mode: Mode, target: &StartTarget) -> AirResult<ProxyConfig> {
        let _edit = self.edits.lock().await;
        let library = self.library.read().await;
        let routing = RoutingFile::new(&self.directory).load()?.routing;
        self.compile_target(mode, &routing, &library, target)
    }

    fn compile_target(&self, mode: Mode, routing: &RoutingConfig, library: &Library, target: &StartTarget) -> AirResult<ProxyConfig> {
        let mut adjusted;
        let target = if let StartTarget::Group { id, .. } = target {
            let group = custom_groups::load(&self.directory)?.into_iter().find(|g| &g.id == id).ok_or("分组已不存在")?;
            adjusted = StartTarget::Group { id:group.id, name:group.name, members:group.members };
            &adjusted
        } else if let StartTarget::Node { id, group_id: Some(group_id) } = target {
            if custom_groups::load(&self.directory)?.iter().any(|g| &g.id == group_id && g.members.contains(id)) { target }
            else { adjusted = target.clone(); if let StartTarget::Node { group_id, .. } = &mut adjusted { *group_id = None; } &adjusted }
        } else { target };
        let yaml = match (target, &routing.subscription_id) {
            (StartTarget::Routing, Some(id)) => self.store.effective_source_yaml(id)?,
            _ => None,
        };
        proxy::compile(mode, routing, &library.sources, yaml.as_deref(), target)
    }

    async fn probe_batches(&self, requested: &[String]) -> AirResult<Vec<ProbeBatch>> {
        let library = self.library.read().await;
        let requested: HashSet<_> = requested.iter().collect();
        let mut batches = Vec::new();
        for source in &library.sources {
            let selected: Vec<_> = source.nodes.iter()
                .filter(|node| requested.is_empty() || requested.contains(&node.id))
                .map(|node| (node.clone(), library.probe_revisions[&node.id].clone()))
                .collect();
            if !selected.is_empty() {
                batches.push(ProbeBatch {
                    revision: format!("{}:{}", library.revision, source.id),
                    nodes: source.nodes.clone(),
                    hosts: source.hosts.clone(),
                    selected,
                });
            }
        }
        if batches.is_empty() {
            return Err("请先导入订阅并选择有效节点".into());
        }
        Ok(batches)
    }

    async fn probe_kernel(&self, path: &std::path::Path, batch: &ProbeBatch, reuse: bool) -> AirResult<Arc<Kernel>> {
        let cached = if reuse { Some(self.kernel.lock().await) } else { None };
        let network = RoutingFile::new(&self.directory).network()?.settings;
        let interface = Kernel::probe_interface();
        if let Some(active) = cached.as_deref().and_then(Option::as_ref)
            .filter(|active| active.revision == batch.revision && active.path == path && active.network == network && active.interface == interface)
        {
            return Ok(active.kernel.clone());
        }
        let config = node_configs(&batch.nodes)?;
        let kernel = Arc::new(Kernel::start_probes(path, &self.runtime, config, &batch.hosts, &network, interface.as_deref()).await?);
        if let Some(mut cached) = cached {
            *cached = Some(CachedKernel {
                network, interface, revision: batch.revision.clone(), path: path.to_owned(), kernel: kernel.clone(),
            });
        }
        Ok(kernel)
    }

    async fn measure(&self, revision: String, kernel: Arc<Kernel>, node: Node) -> AirResult<Probe> {
        let name = node.kernel_name();
        let target = node.probe_target.clone();
        let store = self.store.clone();
        let key = format!("{revision}:{}", node.id);
        let saved = Arc::new(StdMutex::new(Ok(())));
        let record = saved.clone();
        let result = self
            .scheduler
            .probe(
                key,
                async move { kernel.delay_for(&name, target.as_ref()).await },
                move |probe| {
                    *record.lock().expect("sample result lock") =
                        store.save_probe(&node.id, &revision, probe);
                },
            )
            .await;
        saved.lock().expect("sample result lock").clone()?;
        Ok(result)
    }

    pub fn cancel_batch(&self) {
        self.batch_cancel
            .send_modify(|generation| *generation = generation.wrapping_add(1));
        let mut progress = self.progress.lock().expect("progress lock");
        progress.running = false;
        progress.active_ids.clear();
    }

    async fn run_batch(&self, path: PathBuf, requested: Vec<String>) -> AirResult<()> {
        let mut cancel = self.batch_cancel.subscribe();
        cancel.borrow_and_update();
        {
            let mut progress = self.progress.lock().expect("progress lock");
            *progress = Progress {
                running: true,
                batch_id: progress.batch_id + 1,
                ..Progress::default()
            };
        }
        let result = tokio::select! {
            biased;
            _ = cancel.changed() => Ok(()),
            outcome = async {
                let batches = self.probe_batches(&requested).await?;
                self.progress.lock().expect("progress lock").total = batches.iter().map(|batch| batch.selected.len()).sum();
                self.store.prune_samples()?;
                let mut write_error = None;
                for batch in batches {
                    let kernel = self.probe_kernel(&path, &batch, true).await?;
                    self.scheduler
                        .batch(
                            batch.selected,
                            FOREGROUND_CONCURRENCY,
                            |(node, revision)| {
                                let kernel = kernel.clone();
                                async move {
                                    let id = node.id.clone();
                                    self.progress
                                        .lock()
                                        .expect("progress lock")
                                        .active_ids
                                        .insert(id.clone());
                                    let probe = self.measure(revision, kernel, node).await;
                                    (id, probe)
                                }
                            },
                            |(id, probe)| {
                                let mut progress = self.progress.lock().expect("progress lock");
                                progress.active_ids.remove(&id);
                                progress.completed += 1;
                                if probe.is_ok() {
                                    progress.completed_ids.push(id);
                                }
                                match probe {
                                    Ok(Probe::Available(_)) => progress.available += 1,
                                    Ok(Probe::Timeout) => progress.timeouts += 1,
                                    Ok(Probe::Unreachable) => progress.failed += 1,
                                    Err(error) => {
                                        progress.failed += 1;
                                        write_error = Some(error);
                                    }
                                }
                            },
                        )
                        .await;
                }
                write_error.map_or(Ok(()), Err)
            } => outcome,
        };
        let mut progress = self.progress.lock().expect("progress lock");
        progress.running = false;
        progress.active_ids.clear();
        progress.error = result.as_ref().err().cloned();
        result
    }

    pub fn set_window_hidden(&self, hidden: bool) {
        self.background.send_if_modified(|current| {
            if current.window_hidden == hidden {
                return false;
            }
            current.window_hidden = hidden;
            true
        });
    }

    async fn refresh_background(&self, path: PathBuf) -> AirResult<Duration> {
        let _batch = self.batch.lock().await;
        let network = RoutingFile::new(&self.directory).network()?.settings;
        network.validate()?;
        let interval = Duration::from_secs(u64::from(network.probe_interval_minutes) * 60);
        let (due, next) = {
            let library = self.library.read().await;
            self.store.probe_schedule(&library.probe_revisions, interval)?
        };
        let started = Instant::now();
        if !due.is_empty() {
            // The automatic batch owns its kernel so foregrounding can cancel it.
            let batches = self.probe_batches(&due).await?;
            self.store.prune_samples()?;
            let mut saved = Ok(());
            for batch in batches {
                let kernel = self.probe_kernel(&path, &batch, false).await?;
                self.scheduler
                    .batch(
                        batch.selected,
                        BACKGROUND_CONCURRENCY,
                        |(node, revision)| {
                            let kernel = &kernel;
                            async move {
                                let name = node.kernel_name();
                                let probe = self.scheduler.measure(kernel.delay_for(&name, node.probe_target.as_ref())).await;
                                (node.id, revision, probe)
                            }
                        },
                        |(id, revision, probe)| {
                            if let Err(error) = self.store.save_probe(&id, &revision, &probe) {
                                saved = Err(error);
                            }
                        },
                    )
                    .await;
            }
            saved?;
        }
        Ok(next.saturating_sub(started.elapsed()).max(Duration::from_secs(1)))
    }

    pub async fn update_subscriptions(self: Arc<Self>, app: AppHandle) {
        loop {
            if let Ok(ids) = self.store.due_subscriptions() {
                for id in ids {
                    let _ = sync_source(&self, id, true).await;
                    let _ = app.emit("air://subscriptions-changed", ());
                }
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    }

    pub async fn background_loop(self: Arc<Self>) {
        let mut setting = self.background.subscribe();
        loop {
            let path = {
                let current = setting.borrow_and_update();
                current.kernel_path.clone().filter(|_| current.window_hidden)
            };
            if let Some(path) = path {
                let next = tokio::select! {
                    biased;
                    changed = setting.changed() => {
                        if changed.is_err() { break; }
                        continue;
                    }
                    result = self.refresh_background(path) => result.unwrap_or(BACKGROUND_INTERVAL),
                };
                tokio::select! {
                    _ = tokio::time::sleep(next) => {},
                    changed = setting.changed() => if changed.is_err() { break; },
                }
            } else if setting.changed().await.is_err() {
                break;
            }
        }
    }
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    running: bool,
    batch_id: u64,
    active_ids: HashSet<String>,
    completed_ids: Vec<String>,
    total: usize,
    completed: usize,
    available: usize,
    timeouts: usize,
    failed: usize,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeView {
    source_id: String,
    source: String,
    name: String,
    protocol: String,
    server: String,
    port: u16,
    subscription_notice: bool,
    #[serde(flatten)]
    metrics: NodeMetrics,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeMetrics {
    id: String,
    probe_revision: String,
    status: Option<String>,
    latest_ms: Option<u64>,
    average_ms: Option<u64>,
    availability: Option<f64>,
    continuous_ms: Option<u64>,
}

impl NodeMetrics {
    fn new(id: String, probe_revision: String, stats: Stats) -> Self {
        Self {
            id,
            probe_revision,
            status: stats.status,
            latest_ms: stats.latest_ms,
            average_ms: stats.average_ms,
            availability: (stats.total > 0).then(|| stats.success as f64 / stats.total as f64),
            continuous_ms: stats.continuous_ms,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceView {
    id: String,
    name: String,
    nodes: usize,
    groups: usize,
    details: Option<SourceDetails>,
}

#[derive(Serialize)]
pub struct Snapshot {
    nodes: Vec<NodeView>,
    sources: Vec<SourceView>,
    groups: Vec<GroupView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GroupView {
    #[serde(flatten)]
    group: Group,
    member_names: Vec<String>,
}

#[tauri::command]
pub fn read_ui_preferences(state: State<'_, Arc<App>>) -> AirResult<Option<HashMap<String, String>>> {
    match std::fs::read(state.directory.join("interface.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn write_ui_preferences(state: State<'_, Arc<App>>, values: HashMap<String, String>) -> AirResult<()> {
    let file = tempfile::NamedTempFile::new_in(&state.directory).map_err(|e| e.to_string())?;
    serde_json::to_writer(file.as_file(), &values).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(state.directory.join("interface.json")).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn library(state: State<'_, Arc<App>>) -> AirResult<Snapshot> {
    let library = state.library.read().await;
    let mut stats = state.store.stats(
        library
            .probe_revisions
            .iter()
            .map(|(id, revision)| (id.as_str(), revision.as_str())),
    )?;
    let mut details = state.store.source_details()?;
    let nodes = library
        .sources
        .iter()
        .flat_map(|source| source.nodes.iter().map(move |node| (source, node)))
        .map(|(source, node)| {
            let stats = stats.remove(&node.id).unwrap_or_default();
            NodeView {
                source_id: source.id.clone(),
                source: source.name.clone(),
                name: node.display_name.clone(),
                protocol: node.protocol.clone(),
                server: node.server.clone(),
                port: node.port,
                subscription_notice: node.is_subscription_notice(),
                metrics: NodeMetrics::new(
                    node.id.clone(),
                    library.probe_revisions[&node.id].clone(),
                    stats,
                ),
            }
        })
        .collect();
    let sources = library
        .sources
        .iter()
        .map(|source| SourceView {
            id: source.id.clone(),
            name: source.name.clone(),
            nodes: source.nodes.len(),
            groups: source.groups.len(),
            details: details.remove(&source.id),
        })
        .collect();
    let groups = library
        .sources
        .iter()
        .flat_map(|source| {
            source.groups.iter().map(|group| GroupView {
                member_names: group.members.clone(),
                group: Group {
                    source_id: group.source_id.clone(),
                    name: group.name.clone(),
                    strategy: group.strategy.clone(),
                    members: group
                        .members
                        .iter()
                        .filter_map(|name| {
                            source
                                .nodes
                                .iter()
                                .find(|node| &node.name == name)
                                .map(|node| node.id.clone())
                        })
                        .collect(),
                },
            })
        })
        .collect();
    Ok(Snapshot {
        nodes,
        sources,
        groups,
    })
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Import {
    Url {
        name: String,
        url: String,
        #[serde(default)]
        qr: bool,
        #[serde(rename = "profileTitle")]
        profile_title: Option<String>,
        yaml: Option<String>,
        usage: Option<Usage>,
        #[serde(rename = "intervalHours")]
        interval_hours: Option<u16>,
    },
    File {
        name: String,
        filename: String,
        yaml: String,
    },
}

struct ImportDraft {
    id: String,
    name: String,
    kind: &'static str,
    url: Option<String>,
    download: Download,
}

async fn prepare_import(state: &App, input: Import) -> AirResult<ImportDraft> {
    let draft = match input {
        Import::Url {
            name,
            url,
            qr,
            profile_title,
            yaml,
            usage,
            interval_hours,
        } => {
            let url = url.trim();
            let parsed = reqwest::Url::parse(url).map_err(|_| "请输入有效的订阅链接")?;
            parsed
                .host_str()
                .filter(|_| matches!(parsed.scheme(), "http" | "https"))
                .ok_or("订阅链接必须使用 HTTP 或 HTTPS")?;
            ImportDraft {
                id: state.store.import_id_for_url(url)?,
                name: name.trim().to_owned(),
                kind: if qr { "qr" } else { "url" },
                url: Some(url.into()),
                download: match yaml {
                    Some(yaml) => Download { profile_title, yaml, usage, interval_hours },
                    None => download_subscription(state, url).await?,
                },
            }
        }
        Import::File {
            name,
            filename,
            yaml,
        } => ImportDraft {
            id: uuid::Uuid::new_v4().to_string(),
            name: if name.trim().is_empty() {
                filename
            } else {
                name.trim().into()
            },
            kind: "file",
            url: None,
            download: Download { profile_title: None, yaml, usage: None, interval_hours: None },
        },
    };
    Ok(draft)
}

async fn download_subscription(state: &App, url: &str) -> AirResult<Download> {
    let port = state.proxy.lock().await.subscription_proxy_port();
    subscriptions::fetch(url, port).await
}

async fn download_existing_subscription(state: &App, id: &str, url: &str) -> AirResult<Download> {
    let first_error = match download_subscription(state, url).await {
        Ok(download) => return Ok(download),
        Err(error) => error,
    };
    let Ok(url) = reqwest::Url::parse(url) else { return Err(first_error) };
    let Some(binary) = default_kernel_path().filter(|_| url.scheme() == "https") else { return Err(first_error) };
    let (nodes, hosts) = {
        let library = state.library.read().await;
        let Some(source) = library.sources.iter().find(|source| source.id == id) else { return Err(first_error) };
        let stats = state.store.stats(source.nodes.iter().map(|node| (node.id.as_str(), library.probe_revisions[&node.id].as_str())))?;
        let mut nodes = source.nodes.clone();
        nodes.sort_by_key(|node| {
            let measured = stats.get(&node.id);
            let rank = match measured.and_then(|s| s.status.as_deref()) {
                Some("available") => 0, None => 1, _ => 2,
            };
            (rank, measured.and_then(|s| s.latest_ms).unwrap_or(u64::MAX))
        });
        (nodes, source.hosts.clone())
    };
    let retry = subscriptions::fetch_with_saved_nodes(&url, &binary, &state.directory, &state.runtime, &nodes, &hosts);
    match tokio::time::timeout(Duration::from_secs(25), retry).await {
        Ok(Ok(download)) => Ok(download),
        Ok(Err(error)) => Err(format!("{first_error} · 订阅节点 {error}")),
        Err(_) => Err(format!("{first_error} · 订阅节点连接超时")),
    }
}

#[derive(Serialize)]
pub struct ImportPreview {
    #[serde(rename = "profileTitle")]
    profile_title: Option<String>,
    #[serde(rename = "intervalHours")]
    interval_hours: Option<u16>,
    name: String,
    nodes: usize,
    groups: usize,
    yaml: String,
    usage: Option<Usage>,
}

#[tauri::command]
pub async fn preview_subscription(state: State<'_, Arc<App>>, input: Import) -> AirResult<ImportPreview> {
    let draft = prepare_import(&state, input).await?;
    let name = match draft.url.as_deref() {
        Some(url) => state.store.preview_source_name(&draft.id, &draft.name, url, draft.download.profile_title.as_deref())?,
        None => state.store.preview_file_name(&draft.id, &draft.name)?,
    };
    let source = subscriptions::parse(draft.id, name, &draft.download.yaml)?;
    Ok(ImportPreview {
        name: source.name,
        profile_title: draft.download.profile_title,
        nodes: source.nodes.len(),
        groups: source.groups.len(),
        yaml: draft.download.yaml,
        usage: draft.download.usage,
        interval_hours: draft.download.interval_hours,
    })
}

#[tauri::command]
pub async fn import_subscription(state: State<'_, Arc<App>>, input: Import) -> AirResult<String> {
    let draft = prepare_import(&state, input).await?;
    subscriptions::parse(draft.id.clone(), draft.name.clone(), &draft.download.yaml)?;
    let _edit = state.edits.lock().await;
    let id = match draft.url.as_deref() {
        Some(url) => state.store.import_id_for_url(url)?,
        None => draft.id,
    };
    let name = state.store.save_source(
        &id,
        &draft.name,
        &draft.download,
        draft.kind,
        draft.url.as_deref(),
    )?;
    state.reload().await?;
    Ok(name)
}

#[tauri::command]
pub fn subscription_url(state: State<'_, Arc<App>>, id: String) -> AirResult<Option<String>> {
    state.store.source_url(&id)
}

#[tauri::command]
pub async fn refresh_subscription(state: State<'_, Arc<App>>, id: String) -> AirResult<()> {
    sync_source(&state, id, false).await
}

async fn sync_source(state: &App, id: String, automatic: bool) -> AirResult<()> {
    let before = state.store.source_details()?.remove(&id).ok_or("订阅已不存在")?;
    if automatic && before.auto_update != Some(true) { return Ok(()); }
    state.store.record_subscription_attempt(&id)?;
    let url = state.store.source_url(&id)?
        .ok_or("请先在编辑订阅中补充链接")?;
    let result = download_existing_subscription(state, &id, &url).await;
    let _edit = state.edits.lock().await;
    let current = state.store.source_details()?.remove(&id).ok_or("订阅已不存在")?;
    if current.updated_at != before.updated_at || (automatic && current.auto_update != Some(true)) { return Ok(()); }
    if state.store.source_url(&id)?.as_deref() != Some(url.as_str()) {
        return Err("订阅链接已更改，请重新刷新".into());
    }
    match result {
        Ok(download) => {
            let kind = current.kind;
            if let Err(error) = state.store.save_source(&id, "", &download, &kind, Some(&url)) {
                state.store.set_refresh_error(&id, &error)?;
                return Err(error);
            }
            state.reload().await
        }
        Err(error) => {
            state.store.set_refresh_error(&id, &error)?;
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn update_subscription(
    state: State<'_, Arc<App>>,
    id: String,
    name: String,
    url: String,
) -> AirResult<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err("请输入订阅名称".into());
    }
    let url = url.trim();
    let previous = state.store.source_url(&id)?;
    let replacement = if !url.is_empty() && previous.as_deref() != Some(url) {
        Some(download_subscription(&state, url).await?)
    } else {
        None
    };
    let _edit = state.edits.lock().await;
    let current_name = state.library.read().await.sources.iter().find(|source| source.id == id)
        .map(|source| source.name.clone()).ok_or("订阅已不存在")?;
    if previous != state.store.source_url(&id)? {
        return Err("订阅链接已更改，请重新打开编辑".into());
    }
    if let Some(download) = replacement {
        let owner = state.store.import_id_for_url(url)?;
        if owner != id && state.store.source_url(&owner)?.is_some() {
            return Err("这个链接已用于另一条订阅".into());
        }
        state
            .store
            .save_source(&id, if name == current_name { "" } else { name }, &download, "url", Some(url))?;
    } else {
        state.store.rename_source(&id, name)?;
    }
    state.reload().await
}

#[tauri::command]
pub async fn delete_subscription(state: State<'_, Arc<App>>, id: String) -> AirResult<()> {
    state.delete_subscription(&id).await
}

#[derive(Deserialize)]
pub struct NodeEdit {
    id: String,
    name: String,
    server: String,
    port: u16,
}

#[tauri::command]
pub async fn edit_node(state: State<'_, Arc<App>>, edit: NodeEdit) -> AirResult<()> {
    let _guard = state.edits.lock().await;
    let source_id = state.library.read().await.nodes().find(|node| node.id == edit.id)
        .map(|node| node.source_id.clone()).ok_or("节点已不存在")?;
    if edit.name.trim().is_empty() || edit.server.trim().is_empty() || edit.port == 0 {
        return Err("请输入节点名称、服务器地址和端口".into());
    }
    state.store.save_override(&source_id, &NodeOverride {
        id: edit.id,
        name: edit.name.trim().into(),
        server: edit.server.trim().into(),
        port: edit.port,
    })?;
    *state.library.write().await = Library::load(&state.store)?;
    Ok(())
}

#[tauri::command]
pub async fn reset_node(state: State<'_, Arc<App>>, id: String) -> AirResult<()> {
    let _guard = state.edits.lock().await;
    state.store.reset_override(&id)?;
    *state.library.write().await = Library::load(&state.store)?;
    Ok(())
}

#[tauri::command]
pub fn source_document(state: State<'_, Arc<App>>, source_id: String) -> AirResult<SourceDocument> {
    state.store.source_document(&source_id)
}

#[tauri::command]
pub async fn subscription_policy(state: State<'_, Arc<App>>, id: String, enabled: bool, hours: Option<u16>) -> AirResult<()> {
    let _guard = state.edits.lock().await;
    state.store.set_subscription_update(&id, enabled, hours)
}

#[tauri::command]
pub fn subscription_extension(state: State<'_, Arc<App>>, id: String) -> AirResult<subscriptions::extension::Extension> {
    state.store.extension(&id)
}

#[tauri::command]
pub async fn save_subscription_extension(state: State<'_, Arc<App>>, id: String, extension: subscriptions::extension::Extension) -> AirResult<()> {
    // Proxy control acquires these locks in the same order.
    let mut runtime = state.proxy.lock().await;
    {
        let _guard = state.edits.lock().await;
        state.store.save_extension(&id, &extension)?;
        state.reload().await?;
    }
    if runtime.uses_subscription(&id) {
        let target = state.store.startup_proxy()?.target.unwrap_or(StartTarget::Routing);
        let apply = async {
            let config = state.proxy_config(runtime.mode(), &target).await?;
            runtime.select_node(config).await
        };
        apply.await.map_err(|e| format!("扩展已保存，当前连接应用失败：{e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn subscription_yaml(state: State<'_, Arc<App>>, id: String, runtime: bool) -> AirResult<String> {
    if runtime {
        if let Some(yaml) = state.proxy.lock().await.subscription_snapshot(&id)? {
            return Ok(format!("# 当前运行配置\n{yaml}"));
        }
    }
    let _guard = state.edits.lock().await;
    if !runtime {
        return state.store.sources()?.into_iter().find(|s| s.id == id).map(|s| s.yaml).ok_or("订阅已不存在".into());
    }
    let file = RoutingFile::new(&state.directory);
    let library = state.library.read().await;
    let node = library.sources.iter().find(|s| s.id == id).ok_or("订阅已不存在")?.nodes.iter()
        .find(|node| !node.is_subscription_notice()).ok_or("订阅没有可用的节点")?;
    let session = state.store.startup_proxy()?;
    let config = state.compile_target(session.mode, &file.load()?.routing, &library, &StartTarget::Node { group_id: None, id: node.id.clone() })?;
    config.preview_yaml(&file.network()?.settings, session.mode, session.tun).map(|yaml| format!("# 按当前设置生成的订阅预览\n{yaml}"))
}

#[tauri::command]
pub fn subscription_resolvers(state: State<'_, Arc<App>>, source_id: String) -> AirResult<std::collections::BTreeMap<String, Vec<String>>> {
    let doc = state.store.source_document(&source_id)?;
    air::network::subscription_resolvers(doc.local.as_deref().unwrap_or(&doc.original))
}

#[tauri::command]
pub async fn restore_source_yaml(state: State<'_, Arc<App>>, source_id: String) -> AirResult<()> {
    let _edit = state.edits.lock().await;
    state.store.use_original_yaml(&source_id)?;
    state.reload().await
}

#[derive(Deserialize)]
pub struct GroupEdit {
    name: String,
    strategy: String,
    members: Vec<String>,
}

#[tauri::command]
pub async fn change_subscription_item(
    state: State<'_, Arc<App>>,
    source_id: String,
    item: String,
    group: bool,
    edit: Option<GroupEdit>,
) -> AirResult<()> {
    let _edit = state.edits.lock().await;
    let library = state.library.read().await;
    let source = library
        .sources
        .iter()
        .find(|source| source.id == source_id)
        .ok_or("订阅已不存在")?;
    let name = if group {
        source
            .groups
            .iter()
            .find(|group| group.name == item)
            .map(|group| group.name.clone())
    } else {
        source
            .nodes
            .iter()
            .find(|node| node.id == item)
            .map(|node| node.name.clone())
    }
    .ok_or("订阅条目已不存在")?;
    let replacement = edit.as_ref().map(|edit| edit.name.trim());
    if replacement.is_some_and(|next| {
        next != name
            && (source.nodes.iter().any(|node| node.name == next)
                || source.groups.iter().any(|group| group.name == next))
    }) {
        return Err("此名称已被同一订阅中的节点或分组使用".into());
    }
    if replacement != Some(name.as_str()) {
        let routing = RoutingFile::new(&state.directory).load()?.routing;
        let in_air_rules = group && std::iter::once(&routing.fallback).chain(routing.rules.iter().map(|rule| &rule.target))
            .any(|target| matches!(target, Target::Group { source_id: id, name: target } if id == &source_id && target == &name));
        let in_subscription_rules = replacement.is_none()
            && source.rules.iter().any(|rule| {
                let target = rule
                    .rsplit(',')
                    .find(|part| !matches!(part.trim(), "no-resolve" | "src"));
                target.is_some_and(|target| target.trim() == name)
            });
        if in_air_rules || in_subscription_rules {
            return Err("此条目仍被分流规则引用，请先修改相关规则".into());
        }
    }
    drop(library);
    let document = state.store.source_document(&source_id)?;
    let yaml = document.local.as_deref().unwrap_or(&document.original);
    let yaml = subscriptions::change_item(
        yaml,
        &name,
        group,
        edit.map(|edit| (edit.name, edit.strategy, edit.members)),
    )?;
    validate_yaml(yaml.clone())?;
    state.store.save_local_yaml(&source_id, &yaml)?;
    state.reload().await
}

#[tauri::command]
pub fn validate_yaml(yaml: String) -> AirResult<()> {
    let source = subscriptions::parse("draft".into(), "draft".into(), &yaml)?;
    node_configs(&source.nodes)?;
    Ok(())
}

#[tauri::command]
pub async fn save_yaml(
    state: State<'_, Arc<App>>,
    source_id: String,
    yaml: String,
) -> AirResult<()> {
    validate_yaml(yaml.clone())?;
    let _guard = state.edits.lock().await;
    state.store.save_local_yaml(&source_id, &yaml)?;
    *state.library.write().await = Library::load(&state.store)?;
    Ok(())
}

#[tauri::command]
pub async fn custom_node(state: State<'_, Arc<App>>, id: String) -> AirResult<CustomNodeInput> {
    let document = state
        .store
        .source_document(CUSTOM_SOURCE_ID)
        .map_err(|_| "自定义节点已不存在")?;
    let yaml = document.local.as_deref().unwrap_or(&document.original);
    let config: Value = serde_yaml::from_str(yaml).map_err(|_| "无法解析自定义节点配置")?;
    let entries = config["proxies"]
        .as_sequence()
        .ok_or("自定义节点列表无效")?;
    let entry = entries
        .iter()
        .find(|item| {
            item["name"]
                .as_str()
                .is_some_and(|name| digest(format!("{CUSTOM_SOURCE_ID}\0{name}")) == id)
        })
        .ok_or("自定义节点已不存在")?;
    let kind = entry["type"].as_str().unwrap_or("http");
    let tls = entry["tls"].as_bool().unwrap_or(false);
    let protocol = if kind == "http" && tls {
        "https"
    } else if kind == "socks5" {
        "socks5"
    } else {
        "http"
    };
    let port = entry["port"]
        .as_u64()
        .and_then(|n| u16::try_from(n).ok())
        .or_else(|| entry["port"].as_str()?.parse().ok())
        .ok_or("自定义节点端口无效")?;
    Ok(CustomNodeInput {
        id: Some(id),
        name: entry["name"].as_str().unwrap_or_default().into(),
        protocol: protocol.into(),
        server: entry["server"].as_str().unwrap_or_default().into(),
        port,
        username: entry["username"].as_str().unwrap_or_default().into(),
        password: entry["password"].as_str().unwrap_or_default().into(),
    })
}

fn load_custom_entries(store: &Store) -> AirResult<Vec<Value>> {
    match store.source_document(CUSTOM_SOURCE_ID) {
        Ok(document) => {
            let yaml = document.local.as_deref().unwrap_or(&document.original);
            let config: Value =
                serde_yaml::from_str(yaml).map_err(|_| "无法解析自定义节点配置")?;
            Ok(config["proxies"]
                .as_sequence()
                .cloned()
                .unwrap_or_default())
        }
        Err(_) => Ok(Vec::new()),
    }
}

fn serialize_custom_entries(entries: Vec<Value>) -> AirResult<String> {
    let mut root = Mapping::new();
    root.insert("proxies".into(), Value::Sequence(entries));
    serde_yaml::to_string(&Value::Mapping(root)).map_err(|_| "无法序列化自定义节点".into())
}

#[tauri::command]
pub async fn save_custom_node(
    state: State<'_, Arc<App>>,
    input: CustomNodeInput,
) -> AirResult<String> {
    let mapping = custom_node_mapping(&input)?;
    let next_name = mapping["name"]
        .as_str()
        .ok_or("请输入有效的节点名称")?
        .to_owned();
    let _edit = state.edits.lock().await;
    let mut entries = load_custom_entries(&state.store)?;
    let existing_id = input.id.as_deref().filter(|id| !id.trim().is_empty());
    let target_index = if let Some(id) = existing_id {
        Some(
            entries
                .iter()
                .position(|item| {
                    item["name"]
                        .as_str()
                        .is_some_and(|name| digest(format!("{CUSTOM_SOURCE_ID}\0{name}")) == id)
                })
                .ok_or("自定义节点已不存在")?,
        )
    } else {
        None
    };
    if entries.iter().enumerate().any(|(idx, item)| {
        Some(idx) != target_index && item["name"].as_str() == Some(next_name.as_str())
    }) {
        return Err("自定义节点名称已存在".into());
    }
    let next_value = Value::Mapping(mapping);
    if let Some(index) = target_index {
        entries[index] = next_value;
        if let Some(id) = existing_id {
            state.store.reset_override(id)?;
        }
    } else {
        entries.push(next_value);
    }
    let yaml = serialize_custom_entries(entries)?;
    subscriptions::parse(CUSTOM_SOURCE_ID.into(), CUSTOM_SOURCE_NAME.into(), &yaml)?;
    state.store.save_source(
        CUSTOM_SOURCE_ID,
        CUSTOM_SOURCE_NAME,
        &Download { profile_title: None, yaml, usage: None, interval_hours: None },
        "custom",
        None,
    )?;
    state.reload().await?;
    Ok(digest(format!("{CUSTOM_SOURCE_ID}\0{next_name}")))
}

#[tauri::command]
pub async fn delete_custom_node(state: State<'_, Arc<App>>, id: String) -> AirResult<()> {
    let _edit = state.edits.lock().await;
    let mut entries = load_custom_entries(&state.store)?;
    let index = entries
        .iter()
        .position(|item| {
            item["name"]
                .as_str()
                .is_some_and(|name| digest(format!("{CUSTOM_SOURCE_ID}\0{name}")) == id)
        })
        .ok_or("自定义节点已不存在")?;
    entries.remove(index);
    state.store.reset_override(&id)?;
    let removed = HashSet::from([id]);
    let file = RoutingFile::new(&state.directory);
    if let Ok(previous) = file.load() {
        let mut routing = previous.routing.clone();
        if routing.detach_nodes(&removed) {
            let _ = file.save(&routing, &previous.revision);
        }
    }
    if entries.is_empty() {
        state.store.delete_source(CUSTOM_SOURCE_ID)?;
    } else {
        let yaml = serialize_custom_entries(entries)?;
        state.store.save_source(
            CUSTOM_SOURCE_ID,
            CUSTOM_SOURCE_NAME,
            &Download { profile_title: None, yaml, usage: None, interval_hours: None },
            "custom",
            None,
        )?;
    }
    state.reload().await
}

#[tauri::command]
pub async fn test_custom_node(
    state: State<'_, Arc<App>>,
    kernel_path: PathBuf,
    input: CustomNodeInput,
) -> AirResult<u64> {
    let mut mapping = custom_node_mapping(&input)?;
    mapping.insert("name".into(), "air-custom-test".into());
    let kernel = Kernel::start(&kernel_path, &state.directory, &state.runtime, vec![Value::Mapping(mapping)], &Mapping::new(), None).await?;
    match kernel.delay("air-custom-test").await {
        Probe::Available(ms) => Ok(ms),
        Probe::Timeout => Err("连接测试超时".into()),
        Probe::Unreachable => Err("无法连接到该代理节点".into()),
    }
}

#[tauri::command]
pub fn custom_groups(state: State<'_, Arc<App>>) -> AirResult<Vec<CustomGroup>> {
    custom_groups::load(&state.directory)
}

#[tauri::command]
pub async fn save_custom_group(
    state: State<'_, Arc<App>>,
    input: CustomGroupInput,
) -> AirResult<CustomGroup> {
    let _edit = state.edits.lock().await;
    if let Some(members) = &input.members {
        let library = state.library.read().await;
        ensure_group_members(&library, members)?;
    }
    custom_groups::save(&state.directory, input)
}

fn ensure_group_members(library: &Library, ids: &[String]) -> AirResult<()> {
    let valid: HashSet<_> = library.nodes().map(|node| node.id.as_str()).collect();
    if ids.iter().any(|id| !valid.contains(id.as_str())) {
        return Err("所选分组成员已不存在，请刷新节点库".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn change_custom_group_members(
    state: State<'_, Arc<App>>,
    id: String,
    action: MemberAction,
    ids: Vec<String>,
) -> AirResult<()> {
    let _edit = state.edits.lock().await;
    if matches!(action, MemberAction::Add) {
        let library = state.library.read().await;
        ensure_group_members(&library, &ids)?;
    }
    custom_groups::change_members(&state.directory, &id, action, ids)
}

#[tauri::command]
pub async fn delete_custom_group(state: State<'_, Arc<App>>, id: String) -> AirResult<()> {
    let _edit = state.edits.lock().await;
    let file = RoutingFile::new(&state.directory);
    let previous = file.load()?;
    let mut routing = previous.routing.clone();
    let detached = routing.rule_library.as_mut().and_then(|lib| lib.bindings.remove(&format!("group:{id}")));
    let saved = detached.map(|_| file.save(&routing, &previous.revision)).transpose()?;
    if let Err(error) = custom_groups::delete(&state.directory, &id) {
        if let Some(doc) = saved { file.save(&previous.routing, &doc.revision)?; }
        return Err(error);
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitVerification {
    ip: String,
    latency_ms: u64,
}

#[tauri::command]
pub async fn verify_chain(
    state: State<'_, Arc<App>>,
    kernel_path: PathBuf,
    hops: Vec<String>,
) -> AirResult<ExitVerification> {
    let library = state.library.read().await;
    let nodes = library.nodes().cloned().collect::<Vec<_>>();
    let config = chain_hops(&nodes, &hops).map_err(|error| format!("链路校验失败 · {error}"))?;
    let used = nodes.iter().filter(|node| hops.contains(&node.id)).map(|node| node.source_id.clone()).collect();
    let hosts = subscriptions::combined_hosts(&library.sources, &used)?;
    drop(library);
    let kernel = Kernel::start(&kernel_path, &state.directory, &state.runtime, config, &hosts, Some(EXIT_NAME))
        .await
        .map_err(|error| format!("启动探测内核失败 · {error}"))?;
    let (ip, latency_ms) = kernel
        .exit_ip()
        .await
        .map_err(|error| format!("出口探测失败 · {error}"))?;
    Ok(ExitVerification {
        ip: ip.to_string(),
        latency_ms,
    })
}

#[tauri::command]
pub async fn validate_chain(state: State<'_, Arc<App>>, hops: Vec<String>) -> AirResult<()> {
    let nodes = state
        .library
        .read()
        .await
        .nodes()
        .cloned()
        .collect::<Vec<_>>();
    chain_hops(&nodes, &hops).map(|_| ())
}

#[tauri::command]
pub fn routing_path(state: State<'_, Arc<App>>) -> PathBuf {
    RoutingFile::new(&state.directory).path().to_path_buf()
}

#[cfg(windows)]
#[tauri::command]
pub fn open_config_folder(state: State<'_, Arc<App>>) -> AirResult<()> {
    use std::{os::windows::ffi::OsStrExt, ptr::{null, null_mut}};
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};

    let folder: Vec<u16> = state.directory.as_os_str().encode_wide().chain([0]).collect();
    let result = unsafe {
        ShellExecuteW(null_mut(), null(), folder.as_ptr(), null(), null(), SW_SHOWNORMAL)
    };
    if result as isize <= 32 {
        return Err("无法在资源管理器中打开配置文件夹".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn validate_config_file(state: State<'_, Arc<App>>, contents: String) -> AirResult<()> {
    RoutingFile::validate_text(&contents, &state.library.read().await.sources)
}

#[tauri::command]
pub fn read_config_file(state: State<'_, Arc<App>>) -> AirResult<air::routing::ConfigSource> {
    RoutingFile::new(&state.directory).source()
}

#[tauri::command]
pub async fn save_config_file(state: State<'_, Arc<App>>, contents: String, revision: String) -> AirResult<String> {
    let _edit = state.edits.lock().await;
    RoutingFile::new(&state.directory).save_text(&contents, &revision, &state.library.read().await.sources)
}

#[tauri::command]
pub fn routing_settings(state: State<'_, Arc<App>>) -> AirResult<Document> {
    RoutingFile::new(&state.directory).load()
}

#[tauri::command]
pub fn network_settings(state: State<'_, Arc<App>>) -> AirResult<NetworkDocument> {
    RoutingFile::new(&state.directory).network()
}

#[tauri::command]
pub async fn test_dns_settings(state: State<'_, Arc<App>>, kernel_path: PathBuf, settings: NetworkSettings, domain: String) -> AirResult<air::network::DnsResult> {
    let domain = domain.trim().trim_end_matches('.');
    if domain.is_empty() || domain.len() > 253 || domain.split('.').any(|label| label.is_empty() || label.len() > 63 || label.starts_with('-') || label.ends_with('-')
        || !label.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')) {
        return Err("请填写要解析的域名，例如 www.baidu.com".into());
    }
    let mut kernel = Kernel::start_diagnostic(&kernel_path, &state.runtime, vec![], &Mapping::new(), None, &settings).await?;
    let result = kernel.query_dns(domain).await;
    kernel.stop().await?;
    result
}

#[tauri::command]
pub async fn save_network_settings(state: State<'_, Arc<App>>, settings: NetworkSettings, revision: String) -> AirResult<NetworkDocument> {
    let _guard = state.edits.lock().await;
    RoutingFile::new(&state.directory).save_network(&settings, &revision)
}

#[tauri::command]
pub async fn preview_routing(
    state: State<'_, Arc<App>>,
    config: RoutingConfig,
    target: Option<StartTarget>,
) -> AirResult<Vec<String>> {
    let runtime = state.proxy.lock().await;
    let active = runtime.active_target();
    let target = active.or(target).unwrap_or(StartTarget::Routing);
    let library = state.library.read().await;
    let file = RoutingFile::new(&state.directory);
    let network = runtime.active_network().cloned().unwrap_or(file.network()?.settings);
    let mode = if runtime.active_target().is_some() { runtime.mode() } else { Mode::Direct };
    state.compile_target(mode, &config, &library, &target)?.preview_rules(&network)
}

#[tauri::command]
pub async fn save_routing(
    state: State<'_, Arc<App>>,
    config: RoutingConfig,
    revision: String,
    target: Option<StartTarget>,
) -> AirResult<Document> {
    let mut runtime = state.proxy.lock().await;
    let _guard = state.edits.lock().await;
    let library = state.library.read().await;
    let active = runtime.active_target();
    let next_proxy = if let Some(target) = &active {
        Some(state.compile_target(runtime.mode(), &config, &library, target)?)
    } else {
        if let Some(selected) = target.filter(|t| !matches!(t, StartTarget::Routing)) {
            state.compile_target(Mode::Rule, &config, &library, &selected)?;
        } else {
            config.compile(&library.sources)?;
        }
        None
    };
    let file = RoutingFile::new(&state.directory);
    let previous = file.load()?;
    let document = file.save(&config, &revision)?;
    if let Some(proxy_config) = next_proxy {
        if let Err(error) = runtime.reload_routing(proxy_config).await {
            file.save(&previous.routing, &document.revision)
                .map_err(|restore| format!("{error}。未能恢复分流配置：{restore}"))?;
            return Err(error);
        }
    }
    Ok(document)
}

#[tauri::command]
pub async fn clear_connection_logs(state: State<'_, Arc<App>>) -> AirResult<()> {
    state.proxy.lock().await.clear_connection_logs();
    Ok(())
}

#[tauri::command]
pub async fn close_matching_connections(
    state: State<'_, Arc<App>>,
    process_name: Option<String>,
    host: Option<String>,
) -> AirResult<()> {
    state
        .proxy
        .lock()
        .await
        .close_matching_connections(process_name.as_deref(), host.as_deref())
        .await;
    Ok(())
}

#[tauri::command]
pub fn default_kernel_path() -> Option<PathBuf> {
    let path = std::env::current_exe().ok()?.with_file_name("mihomo.exe");
    path.is_file().then_some(path)
}

#[tauri::command]
pub async fn proxy_status(state: State<'_, Arc<App>>) -> AirResult<ProxyStatus> {
    state.proxy.lock().await.status().await
}

#[tauri::command]
#[cfg(windows)]
pub async fn install_tun_service(state: State<'_, Arc<App>>) -> AirResult<ProxyStatus> {
    tokio::task::spawn_blocking(proxy::tun_service::request_install)
        .await
        .map_err(|_| "虚拟网卡服务安装任务异常结束")??;
    state.proxy.lock().await.status().await
}

#[tauri::command]
pub async fn proxy_exit(state: State<'_, Arc<App>>, session_id: String) -> AirResult<proxy::exit::Exit> {
    let port = state.proxy.lock().await.exit_port(&session_id)?;
    proxy::exit::lookup(port).await
}

#[tauri::command]
pub async fn proxy_telemetry(state: State<'_, Arc<App>>) -> AirResult<Option<TelemetrySnapshot>> {
    Ok(state.proxy.lock().await.telemetry())
}

#[tauri::command]
pub async fn proxy_control(
    state: State<'_, Arc<App>>,
    app: AppHandle,
    request: ProxyAction,
) -> AirResult<ProxyStatus> {
    let mut runtime = state.proxy.lock().await;
    state.launch_pending.store(false, std::sync::atomic::Ordering::Relaxed);
    let mut session = state.store.startup_proxy()?;
    match request {
        ProxyAction::Start {
            kernel_path,
            target,
        } => {
            if !runtime.status().await?.running {
                let config = state.proxy_config(runtime.mode(), &target).await?;
                runtime.start(&kernel_path, config).await?;
                session.target = Some(target);
            }
        }
        ProxyAction::SelectGroup { id } => {
            let target = StartTarget::Group { id, name:String::new(), members:vec![] };
            let config = state.proxy_config(runtime.mode(), &target).await?;
            runtime.select_node(config).await?;
            session.target = Some(target);
        }
        ProxyAction::SelectNode { id, group_id } => {
            let target = StartTarget::Node { id, group_id };
            let config = state.proxy_config(runtime.mode(), &target).await?;
            runtime.select_node(config).await?;
            session.target = Some(target);
        }
        ProxyAction::Stop => runtime.pause().await?,
        ProxyAction::Mode { mode } => runtime.set_mode(mode).await?,
        ProxyAction::SystemProxy { enabled } => {
            let previous = state.store.system_proxy_preference()?;
            runtime.set_system_proxy(enabled)?;
            if let Err(error) = state.store.save_system_proxy_preference(enabled) {
                runtime.set_system_proxy(previous)?;
                return Err(error);
            }
        }
        ProxyAction::Tun { enabled } => runtime.set_tun(enabled).await?,
    }
    let status = runtime.status().await?;
    session.mode = status.mode;
    session.tun = status.tun;
    session.running = status.running;
    state.store.save_startup_proxy(&session)?;
    crate::tray::sync(&app, &status);
    Ok(status)
}

#[tauri::command]
pub async fn batch_probe(
    state: State<'_, Arc<App>>,
    kernel_path: PathBuf,
    ids: Vec<String>,
) -> AirResult<()> {
    let _batch = state.batch.lock().await;
    state.run_batch(kernel_path, ids).await
}

#[tauri::command]
pub fn cancel_batch_probe(state: State<'_, Arc<App>>) {
    state.cancel_batch();
}

#[tauri::command]
pub async fn probe_node(
    state: State<'_, Arc<App>>,
    kernel_path: PathBuf,
    id: String,
) -> AirResult<Probe> {
    let batch = state.probe_batches(&[id]).await?.pop().ok_or("节点已不存在")?;
    let kernel = state.probe_kernel(&kernel_path, &batch, true).await?;
    let (node, revision) = batch.selected.into_iter().next().ok_or("节点已不存在")?;
    state.measure(revision, kernel, node).await
}

#[tauri::command]
pub async fn node_metrics(
    state: State<'_, Arc<App>>,
    ids: Vec<String>,
) -> AirResult<Vec<NodeMetrics>> {
    let library = state.library.read().await;
    let revisions: HashMap<_, _> = ids
        .into_iter()
        .filter_map(|id| {
            library
                .probe_revisions
                .get(&id)
                .map(|revision| (id, revision))
        })
        .collect();
    let mut stats = state.store.stats(
        revisions
            .iter()
            .map(|(id, revision)| (id.as_str(), revision.as_str())),
    )?;
    Ok(revisions
        .into_iter()
        .map(|(id, revision)| {
            let stats = stats.remove(&id).unwrap_or_default();
            NodeMetrics::new(id, revision.clone(), stats)
        })
        .collect())
}

#[tauri::command]
pub fn set_background(
    state: State<'_, Arc<App>>,
    kernel_path: PathBuf,
    enabled: bool,
) -> AirResult<()> {
    if enabled && (!kernel_path.is_absolute() || !kernel_path.is_file()) {
        state.background.send_if_modified(|current| current.kernel_path.take().is_some());
        return Err("请选择本机 mihomo.exe 的绝对路径".into());
    }
    let path = enabled.then_some(kernel_path);
    state.background.send_if_modified(|current| {
        if current.kernel_path == path {
            return false;
        }
        current.kernel_path = path;
        true
    });
    Ok(())
}

#[tauri::command]
pub fn monitor_status(state: State<'_, Arc<App>>) -> Progress {
    state.progress.lock().expect("progress lock").clone()
}
