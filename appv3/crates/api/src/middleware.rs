//! Port of `app/core/middlewares.py` + `app/core/desktop_auth.py`.
//!
//! Layer order mirrors v2's `add_middleware` sequence (last added =
//! outermost): CORS → SecurityHeaders → DesktopToken → GZip →
//! RequestSizeLimit → NetworkBindGuard → router.

use crate::util::json_status;
use appv3_core::auth::{configured_access_token, constant_time_eq, is_loopback_host, path_is_api, path_is_exempt, QS_TOKEN_PARAM};
use axum::body::Body;
use axum::extract::{ConnectInfo, Request};
use axum::http::{header, HeaderName, HeaderValue, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;

pub const DEFAULT_MAX_BYTES: u64 = 56 * 1024 * 1024;

/// Per-connection addresses (uvicorn's `scope["server"]` / `scope["client"]`).
#[derive(Clone, Copy, Debug)]
pub struct ConnInfo {
    pub local: Option<SocketAddr>,
    pub remote: Option<SocketAddr>,
}

impl axum::extract::connect_info::Connected<axum::serve::IncomingStream<'_, tokio::net::TcpListener>> for ConnInfo {
    fn connect_info(stream: axum::serve::IncomingStream<'_, tokio::net::TcpListener>) -> Self {
        ConnInfo { local: stream.io().local_addr().ok(), remote: Some(*stream.remote_addr()) }
    }
}

fn is_ws_upgrade(req: &Request) -> bool {
    req.headers().get(header::UPGRADE).and_then(|v| v.to_str().ok()).map(|v| v.eq_ignore_ascii_case("websocket")).unwrap_or(false)
}

/// Closing a WebSocket before `accept()` makes the ASGI server answer the
/// handshake with HTTP 403.
/// uvicorn's reply: `403`, empty `text/plain; charset=utf-8`, `Connection: close`.
pub fn ws_reject() -> Response {
    let mut r = (StatusCode::FORBIDDEN, Body::empty()).into_response();
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    h.insert(header::CONNECTION, HeaderValue::from_static("close"));
    r
}

fn detail(status: StatusCode, msg: &str) -> Response {
    json_status(status, &json!({"detail": msg}))
}

// ── NetworkBindGuard ────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct Policy {
    pub token: Arc<String>,
    pub allow_insecure_lan: bool,
    pub max_bytes: u64,
}

impl Policy {
    pub fn from_env() -> Self {
        let token = configured_access_token();
        if !token.is_empty() {
            tracing::info!("desktop_token_auth_enabled token_len={}", token.len());
        }
        Policy { token: Arc::new(token), allow_insecure_lan: appv3_core::settings().api_allow_insecure_lan, max_bytes: DEFAULT_MAX_BYTES }
    }
}

pub async fn network_bind_guard(policy: axum::extract::State<Policy>, req: Request, next: Next) -> Response {
    if !policy.token.is_empty() || policy.allow_insecure_lan {
        return next.run(req).await;
    }
    let host = req.extensions().get::<ConnectInfo<ConnInfo>>().and_then(|c| c.0.local).map(|a| a.ip().to_string());
    match host {
        None => next.run(req).await,
        Some(h) if is_loopback_host(&h) => next.run(req).await,
        Some(h) => {
            tracing::error!("non_loopback_bind_rejected host={}", h);
            if is_ws_upgrade(&req) {
                return ws_reject();
            }
            detail(StatusCode::SERVICE_UNAVAILABLE, "Non-loopback binding requires an access key.")
        }
    }
}

// ── RequestSizeLimit ────────────────────────────────────────────────────────

pub async fn request_size_limit(policy: axum::extract::State<Policy>, req: Request, next: Next) -> Response {
    if !is_ws_upgrade(&req) {
        if let Some(len) = req.headers().get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|s| s.trim().parse::<i128>().ok()) {
            if len > policy.max_bytes as i128 {
                tracing::warn!("request_too_large content_length={} limit={}", len, policy.max_bytes);
                return detail(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large.");
            }
        }
    }
    let resp = next.run(req).await;
    // Streamed bodies that overflow are cut by `DefaultBodyLimit`; surface
    // them with v2's JSON 413 rather than axum's plain-text rejection.
    if resp.status() == StatusCode::PAYLOAD_TOO_LARGE && resp.headers().get(header::CONTENT_TYPE).map(|v| v.as_bytes().starts_with(b"text/plain")).unwrap_or(false) {
        tracing::warn!("request_too_large received_bytes>limit limit={}", policy.max_bytes);
        return detail(StatusCode::PAYLOAD_TOO_LARGE, "Request body too large.");
    }
    resp
}

// ── DesktopToken ────────────────────────────────────────────────────────────

fn extract_token(req: &Request) -> Option<String> {
    if let Some(v) = req.headers().get(header::AUTHORIZATION) {
        let raw = String::from_utf8_lossy(v.as_bytes()).to_string();
        let (scheme, token) = raw.split_once(' ').unwrap_or((raw.as_str(), ""));
        if scheme.eq_ignore_ascii_case("bearer") && !token.is_empty() {
            return Some(token.trim().to_string());
        }
    }
    let q = req.uri().query().unwrap_or("");
    if q.contains(QS_TOKEN_PARAM) {
        for (k, v) in form_urlencoded::parse(q.as_bytes()) {
            if k == QS_TOKEN_PARAM && !v.is_empty() {
                return Some(v.into_owned());
            }
        }
    }
    None
}

fn strip_token(req: &mut Request) {
    let Some(q) = req.uri().query() else { return };
    if !q.contains(QS_TOKEN_PARAM) {
        return;
    }
    let kept: Vec<(String, String)> = form_urlencoded::parse(q.as_bytes()).filter(|(k, _)| k != QS_TOKEN_PARAM).map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
    let new_q = form_urlencoded::Serializer::new(String::new()).extend_pairs(kept).finish();
    let path = req.uri().path().to_string();
    let pq = if new_q.is_empty() { path } else { format!("{path}?{new_q}") };
    let mut parts = req.uri().clone().into_parts();
    if let Ok(v) = pq.parse() {
        parts.path_and_query = Some(v);
        if let Ok(u) = Uri::from_parts(parts) {
            *req.uri_mut() = u;
        }
    }
}

pub async fn desktop_token(policy: axum::extract::State<Policy>, mut req: Request, next: Next) -> Response {
    if policy.token.is_empty() {
        return next.run(req).await;
    }
    let path = req.uri().path().to_string();
    if is_ws_upgrade(&req) {
        if !path_is_api(&path) {
            return ws_reject();
        }
        match extract_token(&req) {
            Some(t) if constant_time_eq(&t, &policy.token) => {}
            other => {
                tracing::warn!("desktop_token_rejected_ws path={} has_token={}", path, other.is_some());
                return ws_reject();
            }
        }
        strip_token(&mut req);
        return next.run(req).await;
    }
    if path_is_exempt(&path) {
        return next.run(req).await;
    }
    match extract_token(&req) {
        Some(t) if constant_time_eq(&t, &policy.token) => {}
        other => {
            tracing::warn!("desktop_token_rejected path={} has_token={}", path, other.is_some());
            return detail(StatusCode::UNAUTHORIZED, "Unauthorized — OpenAgentd access key required.");
        }
    }
    strip_token(&mut req);
    next.run(req).await
}

// ── SecurityHeaders ─────────────────────────────────────────────────────────

const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'";

const SECURITY_HEADERS: [(&str, &str); 7] = [
    ("x-content-type-options", "nosniff"),
    ("x-frame-options", "DENY"),
    ("referrer-policy", "no-referrer"),
    ("permissions-policy", "geolocation=(), camera=(), microphone=(), payment=()"),
    ("cross-origin-opener-policy", "same-origin"),
    ("cross-origin-resource-policy", "cross-origin"),
    ("content-security-policy", CSP),
];

pub async fn security_headers(req: Request, next: Next) -> Response {
    if is_ws_upgrade(&req) {
        return next.run(req).await;
    }
    let mut resp = next.run(req).await;
    let h = resp.headers_mut();
    for (k, v) in SECURITY_HEADERS {
        let name = HeaderName::from_static(k);
        if !h.contains_key(&name) {
            h.insert(name, HeaderValue::from_static(v));
        }
    }
    resp
}

// ── CORS ────────────────────────────────────────────────────────────────────

/// Port of Starlette's `CORSMiddleware` as configured by v2
/// (`allow_credentials=True`, `allow_methods=["*"]`, `allow_headers=["*"]`,
/// `expose_headers=[Accept-Ranges, Content-Range, Content-Length]`,
/// `max_age=600`). Requests without `Origin` pass through untouched.
#[derive(Clone)]
pub struct Cors {
    origins: Arc<Vec<String>>,
    allow_all: bool,
}

impl Cors {
    pub fn new(origins: &[String]) -> Self {
        Self { allow_all: origins.iter().any(|o| o == "*"), origins: Arc::new(origins.to_vec()) }
    }
    fn allowed(&self, origin: &str) -> bool {
        self.allow_all || self.origins.iter().any(|o| o == origin)
    }
}

const CORS_METHODS: [&str; 7] = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];

fn hv(s: &str) -> HeaderValue {
    HeaderValue::from_str(s).unwrap_or_else(|_| HeaderValue::from_static(""))
}

fn add_vary_origin(h: &mut axum::http::HeaderMap) {
    let v = match h.get(header::VARY).and_then(|v| v.to_str().ok()) {
        Some(existing) => format!("{existing}, Origin"),
        None => "Origin".into(),
    };
    h.insert(header::VARY, hv(&v));
}

pub async fn cors(axum::extract::State(c): axum::extract::State<Cors>, req: Request, next: Next) -> Response {
    let Some(origin) = req.headers().get(header::ORIGIN).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned()) else {
        return next.run(req).await;
    };
    let rh = req.headers();
    if req.method() == axum::http::Method::OPTIONS && rh.contains_key(header::ACCESS_CONTROL_REQUEST_METHOD) {
        // preflight_response(); preflight_explicit_allow_origin is always true
        // here because allow_credentials=True.
        let method = String::from_utf8_lossy(rh[header::ACCESS_CONTROL_REQUEST_METHOD].as_bytes()).into_owned();
        let req_headers = rh.get(header::ACCESS_CONTROL_REQUEST_HEADERS).map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned());
        let private = rh.contains_key("access-control-request-private-network");
        let mut failures: Vec<&str> = vec![];
        let mut resp_headers: Vec<(HeaderName, HeaderValue)> = vec![
            (header::VARY, hv("Origin")),
            (header::ACCESS_CONTROL_ALLOW_METHODS, hv(&CORS_METHODS.join(", "))),
            (header::ACCESS_CONTROL_MAX_AGE, hv("600")),
            (header::ACCESS_CONTROL_ALLOW_CREDENTIALS, hv("true")),
        ];
        if c.allowed(&origin) {
            resp_headers.push((header::ACCESS_CONTROL_ALLOW_ORIGIN, hv(&origin)));
        } else {
            failures.push("origin");
        }
        if !CORS_METHODS.contains(&method.as_str()) {
            failures.push("method");
        }
        if let Some(h) = req_headers {
            resp_headers.push((header::ACCESS_CONTROL_ALLOW_HEADERS, hv(&h)));
        }
        if private {
            failures.push("private-network");
        }
        let (status, text) = if failures.is_empty() { (StatusCode::OK, "OK".to_string()) } else { (StatusCode::BAD_REQUEST, format!("Disallowed CORS {}", failures.join(", "))) };
        let mut resp = Response::new(Body::from(text.clone()));
        *resp.status_mut() = status;
        let h = resp.headers_mut();
        for (k, v) in resp_headers {
            h.insert(k, v);
        }
        h.insert(header::CONTENT_LENGTH, hv(&text.len().to_string()));
        h.insert(header::CONTENT_TYPE, hv("text/plain; charset=utf-8"));
        return resp;
    }
    let mut resp = next.run(req).await;
    let h = resp.headers_mut();
    h.insert(header::ACCESS_CONTROL_ALLOW_CREDENTIALS, hv("true"));
    h.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, hv("Accept-Ranges, Content-Range, Content-Length"));
    if c.allowed(&origin) {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, hv(&origin));
        add_vary_origin(h);
    }
    resp
}

// ── GZip ────────────────────────────────────────────────────────────────────

pub fn gzip_layer() -> tower_http::compression::CompressionLayer<impl tower_http::compression::Predicate + Clone> {
    use tower_http::compression::predicate::{NotForContentType, Predicate, SizeAbove};
    tower_http::compression::CompressionLayer::new().no_br().no_deflate().no_zstd().compress_when(SizeAbove::new(1000).and(NotForContentType::SSE).and(NotForContentType::GRPC))
}
