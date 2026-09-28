//! `sse_starlette.EventSourceResponse` equivalent: `\r\n` framing, a
//! `: ping - <utc>` comment every 15 s, and the same response headers.

use appv3_agent::WireEvent;
use axum::body::Body;
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::Response;
use bytes::Bytes;
use futures::{Stream, StreamExt};
use std::sync::Arc;
use std::time::Duration;

pub const PING_INTERVAL: Duration = Duration::from_secs(15);

/// `str(datetime.now(timezone.utc))`.
fn py_now() -> String {
    let now = chrono::Utc::now();
    let micros = now.timestamp_subsec_micros();
    if micros == 0 {
        now.format("%Y-%m-%d %H:%M:%S+00:00").to_string()
    } else {
        format!("{}.{:06}+00:00", now.format("%Y-%m-%d %H:%M:%S"), micros)
    }
}

pub fn ping_frame() -> String {
    format!(": ping - {}\r\n\r\n", py_now())
}

/// Wrap an event stream as an SSE response. The stream ending closes the
/// response (sse-starlette does the same when its generator returns).
pub fn sse_response<S>(events: S) -> Response
where
    S: Stream<Item = Arc<WireEvent>> + Send + 'static,
{
    let body = async_stream::stream! {
        let mut events = Box::pin(events);
        let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + PING_INTERVAL, PING_INTERVAL);
        loop {
            tokio::select! {
                ev = events.next() => match ev {
                    Some(ev) => yield Ok::<Bytes, std::io::Error>(Bytes::from(ev.to_sse())),
                    None => break,
                },
                _ = ticker.tick() => yield Ok(Bytes::from(ping_frame())),
            }
        }
    };
    let mut resp = Response::new(Body::from_stream(body));
    *resp.status_mut() = StatusCode::OK;
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream; charset=utf-8"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    resp
}
