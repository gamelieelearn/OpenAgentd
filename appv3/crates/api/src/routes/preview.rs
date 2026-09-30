//! `/api/preview`: start, list, and close built-in web previews (v3 only).
//!
//! Each preview is a loopback listener owned by `appv3-preview`; these
//! routes only validate the workspace and target and shape the response.

use crate::error::{ApiError, ApiResult};
use crate::routes::agent::helpers::validate_workspace_or_422;
use crate::util::{json, no_content, Qs};
use crate::AppState;
use appv3_preview::{parse_url_target, resolve_workspace_file, static_backend, url_path, Backend, PreviewError, PreviewInfo};
use axum::extract::Path as AxPath;
use axum::response::Response;
use axum::routing::{delete, get};
use axum::Router;
use bytes::Bytes;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

pub fn router() -> Router<AppState> {
    Router::new().route("/", get(list_previews).post(open_preview)).route("/{id}", delete(close_preview))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenRequest {
    workspace: String,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    preferred_port: Option<u16>,
}

fn preview_json(info: &PreviewInfo, path: &str) -> Value {
    let errors = appv3_preview::global().get(&info.id).map(|e| e.console_error_count()).unwrap_or(0);
    json!({
        "id": info.id,
        "workspace": info.workspace,
        "kind": info.kind,
        "target": info.target,
        "port": info.port,
        "origin": info.origin,
        "path": path,
        "url": format!("{}{}", info.origin, path),
        "console_errors": errors,
    })
}

fn preview_err(e: PreviewError) -> ApiError {
    match e {
        PreviewError::Invalid(m) => ApiError::unprocessable(m),
        PreviewError::Bind(m) => ApiError::internal(m),
    }
}

async fn open_preview(raw: Bytes) -> ApiResult<Response> {
    let req: OpenRequest = serde_json::from_slice(&raw).map_err(|e| ApiError::unprocessable(format!("Invalid preview request: {e}")))?;
    let workspace = validate_workspace_or_422(&req.workspace, true)?;
    let (backend, path) = match (req.url.as_deref().filter(|s| !s.trim().is_empty()), req.path.as_deref().filter(|s| !s.trim().is_empty())) {
        (Some(url), None) => {
            let (target, path) = parse_url_target(url).map_err(|e| ApiError::unprocessable(e.to_string()))?;
            (Backend::Upstream(target), path)
        }
        (None, Some(rel)) => {
            let rel = resolve_workspace_file(Path::new(&workspace), rel).map_err(ApiError::unprocessable)?;
            (static_backend(Path::new(&workspace)), url_path(&rel))
        }
        _ => return Err(ApiError::unprocessable("Give either url or path.")),
    };
    let info = appv3_preview::global().ensure(&workspace, backend, req.preferred_port).await.map_err(preview_err)?;
    Ok(json(preview_json(&info, &path)))
}

async fn list_previews(q: Qs) -> ApiResult<Response> {
    let workspace = match q.get("workspace") {
        Some(w) => Some(validate_workspace_or_422(w, false)?),
        None => None,
    };
    let previews: Vec<Value> = appv3_preview::global().list(workspace.as_deref()).iter().map(|e| preview_json(&e.info(), "/")).collect();
    Ok(json(json!({ "previews": previews })))
}

async fn close_preview(AxPath(id): AxPath<String>) -> ApiResult<Response> {
    if appv3_preview::global().close(&id) {
        Ok(no_content())
    } else {
        Err(ApiError::not_found("Preview not found."))
    }
}
