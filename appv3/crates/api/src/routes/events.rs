//! `app/api/routes/events.py` — live global event stream (no replay).

use crate::sse::sse_response;
use crate::AppState;
use appv3_agent::broadcaster::broadcaster;
use axum::response::Response;
use axum::routing::get;
use axum::Router;

pub fn router() -> Router<AppState> {
    Router::new().route("/stream", get(stream))
}

async fn stream() -> Response {
    let mut sub = broadcaster().attach();
    let events = async_stream::stream! {
        while let Some(ev) = sub.next().await {
            yield ev;
        }
    };
    sse_response(events)
}
