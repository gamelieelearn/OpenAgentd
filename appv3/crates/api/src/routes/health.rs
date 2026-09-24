//! `app/api/routes/health.py`.

use crate::error::ApiError;
use crate::util::json;
use crate::AppState;
use appv3_core::VERSION;
use axum::extract::State;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde_json::json as j;

pub fn router() -> Router<AppState> {
    Router::new().route("/live", get(live)).route("/ready", get(ready))
}

async fn live() -> Response {
    json(j!({"status": "ok", "version": VERSION}))
}

async fn ready(State(st): State<AppState>) -> Result<Response, ApiError> {
    let db_ok = sqlx::query("SELECT 1").execute(&st.pool).await.is_ok();
    if !db_ok {
        tracing::warn!("health_ready_db_failed");
    }
    let agent = match appv3_agent::manager::validate_agents_dir(None) {
        Ok(true) => "ok",
        Ok(false) => "missing",
        Err(e) => {
            tracing::warn!("health_ready_agent_invalid error={}", e);
            "invalid"
        }
    };
    let body = j!({
        "status": if db_ok { "ok" } else { "degraded" },
        "version": VERSION,
        "checks": {"db": if db_ok { "ok" } else { "fail" }, "agent": agent},
    });
    if !db_ok {
        return Err(ApiError::with_detail(503, body));
    }
    Ok(json(body))
}
