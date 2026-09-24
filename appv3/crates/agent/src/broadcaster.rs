//! Process-local global SSE fan-out — port of `app/services/event_broadcaster.py`.
//! Retains no state: clients only see events published while connected.

use crate::events::{compact, WireEvent};
use crate::queue::SubQueue;
use serde_json::Value;
use std::sync::{Arc, Mutex, OnceLock};

const QUEUE_SIZE: usize = 256;

type Sub = Arc<SubQueue<Arc<WireEvent>>>;

#[derive(Default)]
pub struct Broadcaster {
    subs: Mutex<Vec<Sub>>,
}

pub fn broadcaster() -> &'static Broadcaster {
    static B: OnceLock<Broadcaster> = OnceLock::new();
    B.get_or_init(Broadcaster::default)
}

/// Shorthand for `broadcaster().publish`.
pub fn publish(event: &str, data: Value) {
    broadcaster().publish(event, data);
}

impl Broadcaster {
    pub fn publish(&self, event: &str, data: Value) {
        let wire = Arc::new(WireEvent { event: event.to_string(), data: compact(&data) });
        let mut subs = self.subs.lock().unwrap();
        subs.retain(|q| {
            if q.push(wire.clone()) {
                true
            } else {
                tracing::warn!("global_sse_subscriber_queue_full event={}", event);
                q.terminate();
                false
            }
        });
    }

    pub fn attach(&'static self) -> GlobalSubscription {
        let q: Sub = Arc::new(SubQueue::new(QUEUE_SIZE));
        self.subs.lock().unwrap().push(q.clone());
        GlobalSubscription { owner: self, queue: q }
    }

    pub fn subscriber_count(&self) -> usize {
        self.subs.lock().unwrap().len()
    }

    pub fn close(&self) {
        let subs: Vec<Sub> = std::mem::take(&mut *self.subs.lock().unwrap());
        for q in subs {
            q.terminate();
        }
    }
}

pub struct GlobalSubscription {
    owner: &'static Broadcaster,
    queue: Sub,
}

impl GlobalSubscription {
    pub async fn next(&mut self) -> Option<Arc<WireEvent>> {
        self.queue.recv().await
    }
}

impl Drop for GlobalSubscription {
    fn drop(&mut self) {
        self.owner.subs.lock().unwrap().retain(|q| !Arc::ptr_eq(q, &self.queue));
    }
}
