use air::{
    chains::probe_revisions,
    monitoring::{foreground_concurrency, server_key, Probe, Scheduler, BACKGROUND_CONCURRENCY, BACKGROUND_INTERVAL, BASE_FOREGROUND_CONCURRENCY, TIMEOUT},
    storage::Store,
    subscriptions::parse,
};
use std::{
    future::pending,
    sync::{
        atomic::{AtomicUsize, Ordering::SeqCst},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::time::{sleep, Instant};

#[test]
fn probe_history_survives_an_unrelated_edit_and_expires_for_affected_nodes() {
    let mut source = parse("a".into(), "A".into(), "proxies:\n  - { name: Front, type: http, server: front.example.net, port: 8000 }\n  - { name: Via, type: http, server: via.example.net, port: 8001, dialer-proxy: Front }\n  - { name: Independent, type: http, server: other.example.net, port: 8002 }\n").unwrap();
    let previous = probe_revisions(&source).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("air.sqlite3")).unwrap();
    for node in &source.nodes {
        store
            .save_probe(&node.id, "legacy-current-library", &Probe::Available(25))
            .unwrap();
        store
            .save_probe(&node.id, "legacy-other-library", &Probe::Timeout)
            .unwrap();
    }
    store
        .migrate_probe_samples("legacy-current-library", &previous)
        .unwrap();
    store
        .migrate_probe_samples("legacy-current-library", &previous)
        .unwrap();
    source.nodes[0].port = 9000;
    source.nodes[2].display_name = "Renamed".into();
    let current = probe_revisions(&source).unwrap();
    let stats = store
        .stats(
            current
                .iter()
                .map(|(id, revision)| (id.as_str(), revision.as_str())),
        )
        .unwrap();
    assert_ne!(current[&source.nodes[0].id], previous[&source.nodes[0].id]);
    assert_ne!(current[&source.nodes[1].id], previous[&source.nodes[1].id]);
    assert_eq!(current[&source.nodes[2].id], previous[&source.nodes[2].id]);
    assert_eq!(stats.len(), 1);
    let retained = &stats[&source.nodes[2].id];
    assert_eq!(retained.total, 1);
    assert_eq!(retained.latest_ms, Some(25));
}

#[test]
fn probe_schedule_reuses_fresh_samples_and_refreshes_stale_or_edited_nodes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("air.sqlite3");
    let store = Store::open(&path).unwrap();
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let connection = rusqlite::Connection::open(&path).unwrap();
    for (id, revision, age) in [
        ("fresh", "current", 60_000),
        ("stale", "current", 301_000),
        ("edited", "old", 20_000),
    ] {
        connection
            .execute(
                "INSERT INTO probe_samples VALUES (?1, ?2, ?3, 'timeout', NULL)",
                rusqlite::params![id, revision, now - age],
            )
            .unwrap();
    }
    let revisions = ["fresh", "stale", "edited", "new"]
        .into_iter()
        .map(|id| (id.to_owned(), "current".to_owned()))
        .collect();
    let (mut due, next) = store.probe_schedule(&revisions, BACKGROUND_INTERVAL).unwrap();
    due.sort();
    assert_eq!(due, ["edited", "new", "stale"]);
    assert!(next <= Duration::from_secs(240) && next > Duration::from_secs(230));
}

#[derive(Default)]
struct Active {
    current: AtomicUsize,
    peak: AtomicUsize,
}

impl Active {
    fn enter(&self) -> InFlight<'_> {
        let count = self.current.fetch_add(1, SeqCst) + 1;
        self.peak.fetch_max(count, SeqCst);
        InFlight(self)
    }
}

struct InFlight<'a>(&'a Active);

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.0.current.fetch_sub(1, SeqCst);
    }
}

#[tokio::test(start_paused = true)]
async fn three_hundred_timeouts_release_every_slot() {
    let scheduler = Scheduler::new(BASE_FOREGROUND_CONCURRENCY, TIMEOUT);
    let active = Arc::new(Active::default());
    let start = Instant::now();
    let mut results = Vec::new();
    let mut first = None;

    scheduler
        .foreground_batch(
            0..300,
            false,
            |index| {
                let active = active.clone();
                scheduler.probe(
                    index.to_string(),
                    false,
                    async move {
                        let _active = active.enter();
                        pending::<Probe>().await
                    },
                    |_| {},
                )
            },
            |probe| {
                first.get_or_insert_with(|| start.elapsed());
                results.push(probe);
            },
        )
        .await;

    let elapsed = start.elapsed();
    let peak = active.peak.load(SeqCst);
    assert_eq!(peak, BASE_FOREGROUND_CONCURRENCY);
    assert_eq!(active.current.load(SeqCst), 0);
    assert_eq!(results, vec![Probe::Timeout; 300]);
    assert_eq!(first, Some(TIMEOUT));
    assert_eq!(elapsed, TIMEOUT * 300_u32.div_ceil(BASE_FOREGROUND_CONCURRENCY as u32));
    println!("all timeout: completed=300 timeout=300 peak={peak} first={:?} elapsed={elapsed:?} (simulated clock)", first.unwrap());
}

#[tokio::test(start_paused = true)]
async fn foreground_scales_with_processors_and_never_exceeds_the_device_window() {
    for (processors, expected) in [(0, 32), (2, 32), (8, 32), (12, 48), (16, 64), (usize::MAX, 64)] {
        let limit = foreground_concurrency(processors);
        assert_eq!(limit, expected);
        let scheduler = Scheduler::new(limit, TIMEOUT);
        let active = Arc::new(Active::default());
        scheduler.foreground_batch(0..106, true, |_| {
            let active = active.clone();
            async move {
                let _active = active.enter();
                sleep(Duration::from_millis(10)).await;
            }
        }, |_| {}).await;
        assert_eq!(active.peak.load(SeqCst), expected);
    }
}

#[tokio::test(start_paused = true)]
async fn foreground_refills_in_page_order_while_an_earlier_probe_is_still_running() {
    let scheduler = Scheduler::new(BASE_FOREGROUND_CONCURRENCY, TIMEOUT);
    let start = Instant::now();
    let requested: Vec<_> = (0..106).rev().collect();
    let mut admitted = Vec::new();
    let mut completed = Vec::new();
    scheduler.foreground_batch(requested.iter().copied(), false, |id| {
        admitted.push((id, start.elapsed()));
        async move {
            sleep(Duration::from_millis(if id == 105 { 200 } else { 10 })).await;
            id
        }
    }, |id| completed.push(id)).await;
    assert_eq!(admitted.iter().map(|(id, _)| *id).collect::<Vec<_>>(), requested);
    assert_eq!(admitted[BASE_FOREGROUND_CONCURRENCY - 1].1, Duration::ZERO);
    assert_eq!(admitted[BASE_FOREGROUND_CONCURRENCY].1, Duration::from_millis(10));
    assert_eq!(completed.last(), Some(&105));
}

#[tokio::test(start_paused = true)]
async fn mixed_results_progress_and_preserve_the_global_limit() {
    let scheduler = Scheduler::new(BASE_FOREGROUND_CONCURRENCY, TIMEOUT);
    let active = Arc::new(Active::default());
    let start = Instant::now();
    let mut first = None;
    let mut counts = [0; 3];

    scheduler
        .background_batch(
            0..300,
            BACKGROUND_CONCURRENCY,
            |index| index.to_string(),
            |index| {
                let active = active.clone();
                scheduler.probe(
                    index.to_string(),
                    false,
                    async move {
                        let _active = active.enter();
                        match index % 5 {
                            0 => pending::<Probe>().await,
                            1 => {
                                sleep(Duration::from_millis(80)).await;
                                Probe::Unreachable
                            }
                            _ => {
                                sleep(Duration::from_millis(120)).await;
                                Probe::Available(120)
                            }
                        }
                    },
                    |_| {},
                )
            },
            |result| {
                first.get_or_insert_with(|| start.elapsed());
                counts[match result {
                    Probe::Available(_) => 0,
                    Probe::Timeout => 1,
                    Probe::Unreachable => 2,
                }] += 1;
            },
        )
        .await;

    let peak = active.peak.load(SeqCst);
    assert_eq!(counts, [180, 60, 60]);
    assert_eq!(peak, BACKGROUND_CONCURRENCY);
    assert_eq!(active.current.load(SeqCst), 0);
    assert_eq!(first, Some(Duration::from_millis(80)));
    assert!(start.elapsed() < TIMEOUT * (60_u32.div_ceil(BACKGROUND_CONCURRENCY as u32) + 1));
    println!("mixed: completed=300 available=180 timeout=60 failed=60 peak={peak} first={:?} elapsed={:?} (simulated clock)", first.unwrap(), start.elapsed());
}

#[tokio::test(start_paused = true)]
async fn cancelling_automatic_measurement_releases_the_slot_for_manual_measurement() {
    let scheduler = Scheduler::new(1, TIMEOUT);
    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let automatic = tokio::spawn({
        let scheduler = scheduler.clone();
        async move {
            scheduler
                .measure_background("same.test", async move {
                    started_tx.send(()).unwrap();
                    pending::<Probe>().await
                })
                .await
        }
    });
    started_rx.await.unwrap();
    let start = Instant::now();
    automatic.abort();
    assert!(automatic.await.unwrap_err().is_cancelled());

    let manual = scheduler
        .probe("node".into(), false, async { Probe::Available(200) }, |_| {})
        .await;
    assert_eq!(manual, Probe::Available(200));
    assert_eq!(start.elapsed(), Duration::ZERO);
}

#[tokio::test(start_paused = true)]
async fn concurrent_single_and_batch_probes_share_the_same_sample() {
    let scheduler = Scheduler::new(BASE_FOREGROUND_CONCURRENCY, TIMEOUT);
    let requests = Arc::new(AtomicUsize::new(0));
    let records = Arc::new(AtomicUsize::new(0));
    let run = || {
        let requests = requests.clone();
        let records = records.clone();
        scheduler.probe(
            "same revision and node".into(),
            false,
            async move {
                requests.fetch_add(1, SeqCst);
                sleep(Duration::from_millis(80)).await;
                Probe::Available(80)
            },
            move |_| {
                records.fetch_add(1, SeqCst);
            },
        )
    };

    let (single, background) = tokio::join!(run(), async {
        let mut output = Vec::new();
        scheduler
            .foreground_batch([()], false, |_| run(), |result| output.push(result))
            .await;
        output
    });
    assert_eq!(single, Probe::Available(80));
    assert_eq!(background, [Probe::Available(80)]);
    assert_eq!(requests.load(SeqCst), 1);
    assert_eq!(records.load(SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn background_shared_entrances_queue_without_stalling_other_hosts_or_spending_their_timeout() {
    let scheduler = Scheduler::new(2, Duration::from_millis(150));
    let shared = Arc::new(Active::default());
    let all = Arc::new(Active::default());
    let entered = Instant::now();
    let jobs = ["Pool.Test", "pool.test.", "pool.test", "pool.test", "other.test"];
    let mut completed = Vec::new();
    let (_, manual) = tokio::join!(
        scheduler.background_batch(jobs, 2, |name| server_key(name), |name| {
            let key = server_key(name);
            let shared = shared.clone();
            let all = all.clone();
            let scheduler = scheduler.clone();
            async move {
                let sample = scheduler.measure_background(&key, async {
                    let _all = all.enter();
                    let _shared = (key == "pool.test").then(|| shared.enter());
                    sleep(Duration::from_millis(100)).await;
                    Probe::Available(100)
                }).await;
                (name, sample)
            }
        }, |(name, sample)| completed.push((name, sample, entered.elapsed()))),
        scheduler.measure_background("pool.test", async {
            let _all = all.enter();
            let _shared = shared.enter();
            sleep(Duration::from_millis(100)).await;
            Probe::Available(100)
        })
    );
    assert_eq!(manual, Probe::Available(100));
    assert_eq!(completed.len(), jobs.len());
    assert!(completed.iter().all(|(_, sample, _)| sample == &Probe::Available(100)));
    assert_eq!(completed.iter().find(|(name, _, _)| *name == "other.test").unwrap().2, Duration::from_millis(100));
    assert_eq!(shared.peak.load(SeqCst), 1);
    assert_eq!(all.peak.load(SeqCst), 2);
    assert_eq!(server_key("[2001:db8:0:0::1]"), server_key("2001:db8::1"));
}
