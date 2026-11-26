use futures_util::{
    future::{BoxFuture, Shared},
    stream::{self, FuturesUnordered}, FutureExt, StreamExt,
};
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque}, future::Future, net::IpAddr,
    sync::{Arc, Mutex as StdMutex, Weak}, time::Duration,
};
use tokio::{
    sync::{Mutex, Semaphore},
    time::timeout,
};

pub const BASE_FOREGROUND_CONCURRENCY: usize = 32;
pub const BACKGROUND_CONCURRENCY: usize = 8;
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
pub const TIMEOUT: Duration = Duration::from_secs(12);
pub const BACKGROUND_INTERVAL: Duration = Duration::from_secs(300);

pub fn foreground_concurrency(processors: usize) -> usize {
    processors.saturating_mul(4).clamp(BASE_FOREGROUND_CONCURRENCY, 64)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "status", content = "latencyMs", rename_all = "camelCase")]
pub enum Probe {
    Available(u64),
    Timeout,
    Unreachable,
}

impl Probe {
    pub fn status(&self) -> &'static str {
        match self {
            Self::Available(_) => "available",
            Self::Timeout => "timeout",
            Self::Unreachable => "unreachable",
        }
    }

    pub fn latency(&self) -> Option<u64> {
        match self {
            Self::Available(value) => Some(*value),
            _ => None,
        }
    }
}

type Flight = Shared<BoxFuture<'static, Probe>>;

pub fn server_key(server: &str) -> String {
    let host = server.trim().trim_end_matches('.');
    let literal = host.strip_prefix('[').and_then(|s| s.strip_suffix(']')).unwrap_or(host);
    literal.parse::<IpAddr>().map_or_else(|_| host.to_ascii_lowercase(), |ip| ip.to_canonical().to_string())
}

pub struct Scheduler {
    limit: usize,
    deadline: Duration,
    slots: Semaphore,
    standard_slots: Semaphore,
    servers: StdMutex<HashMap<String, Weak<Mutex<()>>>>,
    pending: Mutex<HashMap<String, Flight>>,
}

impl Scheduler {
    pub fn new(limit: usize, deadline: Duration) -> Arc<Self> {
        assert!(limit > 0);
        Arc::new(Self {
            limit,
            deadline,
            slots: Semaphore::new(limit),
            standard_slots: Semaphore::new(limit.min(BASE_FOREGROUND_CONCURRENCY)),
            servers: StdMutex::new(HashMap::new()),
            pending: Mutex::new(HashMap::new()),
        })
    }

    pub async fn measure_background(&self, server: &str, operation: impl Future<Output = Probe>) -> Probe {
        let gate = {
            let mut servers = self.servers.lock().expect("probe server registry");
            if let Some(gate) = servers.get(server).and_then(Weak::upgrade) {
                gate
            } else {
                servers.retain(|_, gate| gate.strong_count() > 0);
                let gate = Arc::new(Mutex::new(()));
                servers.insert(server.to_owned(), Arc::downgrade(&gate));
                gate
            }
        };
        let _server = gate.lock().await;
        self.with_slot(false, operation).await
    }

    async fn with_slot(&self, high_speed: bool, operation: impl Future<Output = Probe>) -> Probe {
        let _standard = if high_speed { None } else { Some(self.standard_slots.acquire().await.expect("scheduler stays open")) };
        let _permit = self.slots.acquire().await.expect("scheduler stays open");
        timeout(self.deadline, operation)
            .await
            .unwrap_or(Probe::Timeout)
    }

    pub async fn probe<F, R>(self: &Arc<Self>, key: String, high_speed: bool, operation: F, record: R) -> Probe
    where
        F: Future<Output = Probe> + Send + 'static,
        R: FnOnce(&Probe) + Send + 'static,
    {
        let mut pending = self.pending.lock().await;
        let flight = if let Some(flight) = pending.get(&key) {
            flight.clone()
        } else {
            let scheduler = self.clone();
            let task_key = key.clone();
            let flight = async move {
                let probe = scheduler.with_slot(high_speed, operation).await;
                record(&probe);
                scheduler.pending.lock().await.remove(&task_key);
                probe
            }
            .boxed()
            .shared();
            pending.insert(key, flight.clone());
            tokio::spawn(flight.clone());
            flight
        };
        drop(pending);
        flight.await
    }

    pub async fn foreground_batch<J, F, R>(
        &self,
        jobs: impl IntoIterator<Item = J>,
        high_speed: bool,
        run: impl FnMut(J) -> F,
        mut receive: impl FnMut(R),
    ) where
        F: Future<Output = R>,
    {
        let limit = if high_speed { self.limit } else { self.limit.min(BASE_FOREGROUND_CONCURRENCY) };
        let running = stream::iter(jobs).map(run).buffer_unordered(limit);
        futures_util::pin_mut!(running);
        while let Some(result) = running.next().await {
            receive(result);
        }
    }

    pub async fn background_batch<J, F, R>(
        &self,
        jobs: impl IntoIterator<Item = J>,
        concurrency: usize,
        server_for: impl Fn(&J) -> String,
        mut run: impl FnMut(J) -> F,
        mut receive: impl FnMut(R),
    ) where
        F: Future<Output = R>,
    {
        let limit = concurrency.clamp(1, self.limit);
        let mut ready = VecDeque::new();
        let mut queues = HashMap::new();
        for job in jobs {
            queues.entry(server_for(&job)).or_insert_with_key(|server| {
                ready.push_back(server.clone());
                VecDeque::new()
            }).push_back(job);
        }
        let mut running = FuturesUnordered::new();
        loop {
            while running.len() < limit {
                let Some(server) = ready.pop_front() else { break };
                let job = queues.get_mut(&server).unwrap().pop_front().unwrap();
                let task = run(job);
                running.push(async move { (server, task.await) });
            }
            let Some((server, result)) = running.next().await else { break };
            receive(result);
            if !queues[&server].is_empty() {
                ready.push_back(server);
            }
        }
    }
}
