//! `/api/auth`, `/api/diagnostics`, `/api/observability` — ports of
//! `app/api/routes/{auth,diagnostics,observability}.py` (span analytics
//! live in `crate::observability`).

use crate::error::{ApiError, ApiResult};
use crate::schema::Body;
use crate::util::*;
use crate::AppState;
use appv3_agent::manager;
use appv3_agent::WireEvent;
use appv3_core::runtime_settings as rs;
use appv3_core::settings;
use axum::extract::Path as AxPath;
use axum::response::Response;
use axum::routing::{delete, get, post};
use axum::Router;
use bytes::Bytes;
use serde_json::{json, Map, Value};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;

// ── auth ────────────────────────────────────────────────────────────────────

const OAUTH_PROVIDERS: [&str; 3] = ["codex", "copilot", "grok"];

pub fn auth_router() -> Router<AppState> {
    Router::new()
        .route("/check", get(|| async { json(json!({"ok": true})) }))
        .route("/{provider_id}", delete(oauth_disconnect))
        .route("/{provider_id}/login", get(oauth_login))
        .route("/{provider_id}/callback", post(oauth_callback))
}

async fn oauth_disconnect(AxPath(id): AxPath<String>) -> ApiResult<Response> {
    let plugin = appv3_providers::plugin::find_provider_plugin(&id);
    if crate::providers::find(&id).is_none() && plugin.is_none() {
        return Err(ApiError::not_found(format!("Unknown OAuth provider '{id}'.")));
    }
    let file = match id.as_str() {
        "codex" => Some("codex_oauth.json"),
        "copilot" => Some("copilot_oauth.json"),
        "grok" => Some("grok_oauth.json"),
        _ => None,
    };
    if let Some(f) = file {
        let p = settings().cache_dir.join(f);
        if p.is_file() {
            if let Err(e) = std::fs::remove_file(&p) {
                tracing::warn!("failed_to_delete_oauth_file provider={} path={} error={}", id, p.display(), e);
            }
        } else if plugin.is_some() {
            remove_plugin_tokens(&id);
        }
    } else if plugin.is_some() {
        remove_plugin_tokens(&id);
    }
    let _ = rs::forget_provider_models(&id);
    Ok(json(json!({"ok": true, "provider": id})))
}

/// Remove a provider plugin's token directory.
///
/// v2 computes `Path(store.token_path("")).parent`, which is the shared
/// `provider-plugins/` root, and so wipes every plugin's tokens when one is
/// disconnected. v3 removes only this plugin's own directory.
fn remove_plugin_tokens(id: &str) {
    let dir = appv3_providers::creds::CredentialStore::for_provider(id, Default::default()).token_dir();
    if dir.is_dir() {
        let _ = std::fs::remove_dir_all(&dir);
    }
}

async fn oauth_login(AxPath(id): AxPath<String>, axum::extract::RawQuery(q): axum::extract::RawQuery) -> ApiResult<Response> {
    let builtin = OAUTH_PROVIDERS.contains(&id.as_str());
    let plugin = if builtin { None } else { appv3_providers::plugin::find_provider_plugin(&id).filter(|p| p.info().kind == "oauth" && p.has_login()) };
    if !builtin && plugin.is_none() {
        return Err(ApiError::not_found(format!("Unknown OAuth provider '{id}'. Known: ['codex', 'copilot', 'grok'].")));
    }
    let browser = id == "codex" && q.as_deref().map(|q| appv3_providers::plugin::qs_first(&appv3_providers::plugin::parse_qs(q), "mode") == "browser").unwrap_or(false);
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Arc<WireEvent>>();
    let failed = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let sink: appv3_providers::plugin::OAuthSink = {
        let tx = tx.clone();
        let failed = failed.clone();
        Arc::new(move |event: &str, data: Value| {
            if event == "failed" {
                failed.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            let _ = tx.send(Arc::new(WireEvent { event: event.to_string(), data: appv3_core::pyjson::dumps(&data) }));
        })
    };
    // v2 runs login() in a worker thread that keeps going if the client
    // disconnects; the spawned task mirrors that.
    tokio::spawn(async move {
        let res = match plugin {
            Some(p) => p.login(sink).await,
            None => appv3_providers::oauth::builtin_login(&id, browser, sink).await,
        };
        if let Err(e) = res {
            tracing::warn!("oauth_login_failed provider={} error={}", id, e);
            if !failed.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = tx.send(Arc::new(WireEvent { event: "failed".into(), data: appv3_core::pyjson::dumps(&json!({"message": e, "reason": "exception"})) }));
            }
        }
    });
    Ok(crate::sse::sse_response(tokio_stream::wrappers::UnboundedReceiverStream::new(rx)))
}

async fn oauth_callback(AxPath(id): AxPath<String>, raw: Bytes) -> ApiResult<Response> {
    let v = body_value(&raw)?;
    let mut b = Body::new(&v)?;
    let code = b.str("code", None);
    let mut errs = b.into_errs(&["code"]);
    if errs.is_empty() {
        let stripped = crate::routes::library::py_strip(&code);
        let n = stripped.chars().count();
        if n < 1 {
            errs.push(crate::error::verr_ctx(
                "string_too_short",
                &[json!("body"), json!("code")],
                "String should have at least 1 character",
                json!(code),
                json!({"min_length": 1}),
            ));
        } else if n > 8192 {
            errs.push(crate::error::verr_ctx(
                "string_too_long",
                &[json!("body"), json!("code")],
                "String should have at most 8192 characters",
                json!(code),
                json!({"max_length": 8192}),
            ));
        }
    }
    if !errs.is_empty() {
        return Err(ApiError::validation(errs));
    }
    let code = crate::routes::library::py_strip(&code);
    let events: Arc<std::sync::Mutex<Vec<(String, Value)>>> = Default::default();
    let sink: appv3_providers::plugin::OAuthSink = {
        let events = events.clone();
        Arc::new(move |e: &str, d: Value| events.lock().unwrap().push((e.to_string(), d)))
    };
    let res = match appv3_providers::plugin::find_provider_plugin(&id).filter(|p| p.has_oauth_callback()) {
        Some(p) => p.oauth_callback(&code, sink).await,
        None => match appv3_providers::oauth::builtin_callback(&id, &code, sink).await {
            Some(r) => r,
            None => return Err(ApiError::not_found(format!("OAuth callback unsupported for '{id}'"))),
        },
    };
    if let Err(e) = res {
        tracing::warn!("oauth_callback_failed provider={} error={}", id, e);
        return Err(ApiError::new(400, e));
    }
    let evs = events.lock().unwrap().clone();
    if let Some((_, d)) = evs.iter().find(|(e, _)| e == "failed") {
        let msg = d.get("message").map(|m| m.as_str().map(String::from).unwrap_or_else(|| appv3_agent::pystr::py_str(m))).unwrap_or_else(|| "OAuth callback failed".into());
        return Err(ApiError::new(400, msg));
    }
    let mut body = Map::new();
    body.insert("ok".into(), json!(true));
    if let Some((_, Value::Object(s))) = evs.iter().find(|(e, _)| e == "success") {
        for (k, v) in s {
            body.insert(k.clone(), v.clone());
        }
    }
    Ok(json(Value::Object(body)))
}

// ── diagnostics ─────────────────────────────────────────────────────────────

const SECRET_FIELDS: [&str; 16] = [
    "ZAI_API_KEY",
    "GOOGLE_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENCODE_ZEN_API_KEY",
    "OPENCODE_GO_API_KEY",
    "OPENROUTER_API_KEY",
    "NVIDIA_API_KEY",
    "XAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "AWS_BEARER_TOKEN_BEDROCK",
    "ROUTER9_API_KEY",
    "CLIPROXY_API_KEY",
    "OLLAMA_API_KEY",
    "VERTEXAI_API_KEY",
    "DATABASE_URL",
];
const MAX_DIR_ENTRIES: usize = 1000;

pub fn diagnostics_router() -> Router<AppState> {
    Router::new().route("/", get(diagnostics))
}

fn dir_info(p: &Path) -> Value {
    let mut m = Map::new();
    m.insert("path".into(), json!(pstr(p)));
    m.insert("exists".into(), json!(p.exists()));
    let mut entries = Value::Null;
    let mut truncated = Value::Null;
    if p.is_dir() {
        if let Ok(rd) = std::fs::read_dir(p) {
            let mut n = 0usize;
            for _ in rd {
                n += 1;
                if n >= MAX_DIR_ENTRIES {
                    truncated = json!(true);
                    break;
                }
            }
            entries = json!(n);
        }
    }
    m.insert("entries".into(), entries);
    m.insert("entries_truncated".into(), truncated);
    Value::Object(m)
}

fn tail(path: &Path, n: usize) -> Vec<String> {
    if n == 0 || !path.is_file() {
        return vec![];
    }
    let Ok(mut f) = std::fs::File::open(path) else { return vec![] };
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let chunk = size.min((n as u64 * 200).max(8192));
    if f.seek(SeekFrom::Start(size - chunk)).is_err() {
        return vec![];
    }
    let mut data = vec![];
    if f.read_to_end(&mut data).is_err() {
        return vec![];
    }
    let text = String::from_utf8_lossy(&data).to_string();
    let lines: Vec<String> = text.lines().map(String::from).collect();
    lines[lines.len().saturating_sub(n)..].to_vec()
}

fn secret_present(name: &str) -> bool {
    if name == "DATABASE_URL" {
        return true; // v2 defaults it to the SQLite path under DATA_DIR.
    }
    std::env::var(name).map(|v| !v.trim().is_empty()).unwrap_or(false)
}

fn safe_env() -> Map<String, Value> {
    let mut out = Map::new();
    for (k, v) in std::env::vars() {
        if !["OPENAGENTD_", "APP_", "PYTHON"].iter().any(|p| k.starts_with(p)) {
            continue;
        }
        let up = k.to_uppercase();
        if ["KEY", "TOKEN", "SECRET", "PASSWORD"].iter().any(|s| up.contains(s)) {
            out.insert(k, json!(if v.trim().is_empty() { "<empty>" } else { "<set>" }));
        } else {
            out.insert(k, json!(v));
        }
    }
    out
}

fn machine() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "arm64",
        (_, a) => a,
    }
}

async fn diagnostics(q: Qs) -> ApiResult<Response> {
    let n = q.int("tail", 200, None, None)?.clamp(0, 2000) as usize;
    let s = settings();
    let logs = s.state_dir.join("logs").join("app");
    let (log_path, err_path) = (logs.join("app.log"), logs.join("app-error.log"));
    let body = blocking(move || {
        let s = settings();
        let providers: Map<String, Value> = SECRET_FIELDS.iter().map(|k| (k.to_string(), json!(secret_present(k)))).collect();
        let loadable = match std::panic::catch_unwind(|| manager::validate_agents_dir(None)) {
            Ok(Ok(b)) => json!(b),
            _ => Value::Null,
        };
        let exe = std::env::current_exe().map(|p| pstr(&p)).unwrap_or_default();
        let dirs = |p: &PathBuf| dir_info(p);
        json!({
            "version": appv3_core::VERSION,
            "app_env": s.app_env,
            "runtime": {
                "python": "n/a",
                "implementation": "Rust",
                "os": format!("{}-{}", std::env::consts::OS, machine()),
                "machine": machine(),
                "executable": exe,
                "desktop_session": std::env::var("OPENAGENTD_DESKTOP_TOKEN").map(|v| !v.is_empty()).unwrap_or(false),
                "sidecar_version": appv3_core::VERSION,
            },
            "dirs": {
                "data": dirs(&s.data_dir), "config": dirs(&s.config_dir), "state": dirs(&s.state_dir), "cache": dirs(&s.cache_dir),
                "workspace": dirs(&s.workspace_dir), "agents": dirs(&s.agents_dir), "skills": dirs(&s.skills_dir),
            },
            "providers": providers,
            "env": safe_env(),
            "agent": {"loaded": manager::current_agent_session().is_some(), "loadable": loadable},
            "mcp": {"servers": appv3_mcp::mcp_manager().server_names().len()},
            "log_tail": tail(&log_path, n),
            "log_path": pstr(&log_path),
            "error_log_path": pstr(&err_path),
        })
    })
    .await;
    Ok(json(body))
}

// ── observability ───────────────────────────────────────────────────────────

pub fn observability_router() -> Router<AppState> {
    Router::new().route("/summary", get(obs_summary)).route("/traces", get(obs_traces)).route("/traces/{trace_id}", get(obs_trace))
}

async fn obs_summary(q: Qs) -> ApiResult<Response> {
    let days = q.int("days", 7, Some(1), Some(90))?;
    let v = tokio::task::spawn_blocking(move || crate::observability::summarize(days)).await.map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(json(v))
}

async fn obs_traces(q: Qs) -> ApiResult<Response> {
    let days = q.int("days", 7, Some(1), Some(90))?;
    let limit = q.int("limit", 50, Some(1), Some(200))?;
    let offset = q.int("offset", 0, Some(0), None)?;
    let (items, total) =
        tokio::task::spawn_blocking(move || crate::observability::list_traces_with_count(days, limit, offset)).await.map_err(|e| ApiError::internal(e.to_string()))?;
    Ok(json(json!({"traces": items, "limit": limit, "offset": offset, "total": total, "has_next": offset + limit < total})))
}

async fn obs_trace(AxPath(trace_id): AxPath<String>, q: Qs) -> ApiResult<Response> {
    let days = q.int("days", 30, Some(1), Some(90))?;
    let re = regex::Regex::new(r"^(0x)?[0-9a-fA-F]{1,64}$").unwrap();
    if !re.is_match(trace_id.strip_suffix('\n').unwrap_or(&trace_id)) {
        return Err(ApiError::unprocessable("Invalid trace_id: expected a hex string."));
    }
    let tid = trace_id.clone();
    match tokio::task::spawn_blocking(move || crate::observability::get_trace(&tid, days)).await.map_err(|e| ApiError::internal(e.to_string()))? {
        Some(v) => Ok(json(v)),
        None => Err(ApiError::with_detail(404, json!({"reason": "trace_not_found", "trace_id": trace_id}))),
    }
}
