use futures_util::{
    future::{BoxFuture, Shared},
    stream, FutureExt, StreamExt,
};
use serde::Serialize;
use std::{collections::HashMap, future::Future, sync::Arc, time::Duration};
use tokio::{
    sync::{Mutex, Semaphore},
    time::timeout,
};

pub const CONCURRENCY: usize = 8;
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(8);
pub const TIMEOUT: Duration = Duration::from_secs(PROBE_TIMEOUT.as_secs() + 1);
pub const BACKGROUND_INTERVAL: Duration = Duration::from_secs(300);

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

pub struct Scheduler {
    limit: usize,
    deadline: Duration,
    slots: Semaphore,
    pending: Mutex<HashMap<String, Flight>>,
}

impl Scheduler {
    pub fn new(limit: usize, deadline: Duration) -> Arc<Self> {
        assert!(limit > 0);
        Arc::new(Self {
            limit,
            deadline,
            slots: Semaphore::new(limit),
            pending: Mutex::new(HashMap::new()),
        })
    }

    pub async fn measure(&self, operation: impl Future<Output = Probe>) -> Probe {
        let _permit = self.slots.acquire().await.expect("scheduler stays open");
        timeout(self.deadline, operation)
            .await
            .unwrap_or(Probe::Timeout)
    }

    pub async fn probe<F, R>(self: &Arc<Self>, key: String, operation: F, record: R) -> Probe
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
                let probe = scheduler.measure(operation).await;
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

    pub async fn batch<J, F, R>(
        &self,
        jobs: impl IntoIterator<Item = J>,
        run: impl FnMut(J) -> F,
        mut receive: impl FnMut(R),
    ) where
        F: Future<Output = R>,
    {
        let stream = stream::iter(jobs).map(run).buffer_unordered(self.limit);
        futures_util::pin_mut!(stream);
        while let Some(result) = stream.next().await {
            receive(result);
        }
    }
}
