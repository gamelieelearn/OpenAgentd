//! End-to-end HTTP tests: the real `create_app` router (full middleware
//! stack) driven with `tower::ServiceExt::oneshot` against a temp DB, temp
//! XDG roots and a local mock OpenAI-compatible provider.
//!
//! Settings and managers are process-global, so everything runs in one test.

use appv3_api::{create_app, AppState, ConnInfo, Policy};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use axum::routing::post;
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;
use tower::ServiceExt;

fn setup_env(root: &std::path::Path, mock: SocketAddr) {
    for (k, d) in [
        ("OPENAGENTD_DATA_DIR", "data"),
        ("OPENAGENTD_CONFIG_DIR", "config"),
        ("OPENAGENTD_STATE_DIR", "state"),
        ("OPENAGENTD_CACHE_DIR", "cache"),
        ("OPENAGENTD_WORKSPACE_DIR", "ws"),
    ] {
        std::env::set_var(k, root.join(d));
    }
    std::env::set_var("HOME", root.join("home"));
    std::env::set_var("APP_ENV", "production");
    std::env::set_var("OPENAGENTD_MODEL_REGISTRY_REFRESH", "false");
    std::env::set_var("SNAPSHOT_MAINTENANCE_ENABLED", "false");
    std::env::set_var("OLLAMA_BASE_URL", format!("http://{mock}/v1"));
    for k in ["OPENAGENTD_DESKTOP_TOKEN", "OPENAGENTD_ACCESS_KEY", "DATABASE_URL"] {
        std::env::remove_var(k);
    }
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
}

/// Streaming chat-completions mock: plain text reply.
async fn mock_openai() -> SocketAddr {
    async fn chat(axum::Json(_req): axum::Json<Value>) -> axum::response::Response {
        let chunk = |delta: Value, finish: Value| {
            format!(
                "data: {}\n\n",
                json!({"id": "c", "object": "chat.completion.chunk", "created": 0, "model": "mock-1",
                       "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]})
            )
        };
        let mut body = chunk(json!({"role": "assistant", "content": "Hello "}), Value::Null);
        body += &chunk(json!({"content": "from mock."}), Value::Null);
        body += &chunk(json!({}), json!("stop"));
        body += &format!(
            "data: {}\n\ndata: [DONE]\n\n",
            json!({"id": "c", "object": "chat.completion.chunk", "created": 0, "model": "mock-1", "choices": [],
                   "usage": {"prompt_tokens": 7, "completion_tokens": 3, "total_tokens": 10}})
        );
        axum::response::Response::builder().header("content-type", "text/event-stream").body(Body::from(body)).unwrap()
    }
    let app = Router::new().route("/v1/chat/completions", post(chat));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
    addr
}

struct Client {
    app: Router,
    /// Address the connection arrived on (uvicorn's `scope["server"]`).
    local: SocketAddr,
}

impl Client {
    fn new(app: Router) -> Self {
        Client { app, local: "127.0.0.1:8000".parse().unwrap() }
    }
    async fn send(&self, mut req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
        req.extensions_mut().insert(ConnectInfo(ConnInfo { local: Some(self.local), remote: Some("127.0.0.1:50000".parse().unwrap()) }));
        let resp = self.app.clone().oneshot(req).await.unwrap();
        let (parts, body) = resp.into_parts();
        let bytes = body.collect().await.unwrap().to_bytes().to_vec();
        (parts.status, parts.headers, bytes)
    }
    async fn json(&self, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
        let mut b = Request::builder().method(method).uri(uri);
        let body = match body {
            Some(v) => {
                b = b.header("content-type", "application/json");
                Body::from(v.to_string())
            }
            None => Body::empty(),
        };
        let (s, _, bytes) = self.send(b.body(body).unwrap()).await;
        (s, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
    async fn form(&self, uri: &str, fields: &[(&str, &str)]) -> (StatusCode, Value) {
        let boundary = "XBOUNDARYX";
        let mut body = String::new();
        for (k, v) in fields {
            body += &format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n");
        }
        body += &format!("--{boundary}--\r\n");
        let req = Request::post(uri).header("content-type", format!("multipart/form-data; boundary={boundary}")).body(Body::from(body)).unwrap();
        let (s, _, bytes) = self.send(req).await;
        (s, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }
}

fn sse_events(raw: &[u8]) -> Vec<(String, Value)> {
    let text = String::from_utf8_lossy(raw);
    let mut out = vec![];
    for block in text.replace("\r\n", "\n").split("\n\n") {
        let mut ev = "message".to_string();
        let mut data = String::new();
        for line in block.lines() {
            if let Some(e) = line.strip_prefix("event:") {
                ev = e.trim().to_string();
            } else if let Some(d) = line.strip_prefix("data:") {
                data += d.trim_start();
            }
        }
        if !data.is_empty() {
            out.push((ev, serde_json::from_str(&data).unwrap_or(Value::String(data))));
        }
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn http_api_end_to_end() {
    let root = tempfile::tempdir().unwrap();
    let mock = mock_openai().await;
    setup_env(root.path(), mock);
    let s = appv3_core::settings();
    std::fs::create_dir_all(s.database_path.parent().unwrap()).unwrap();
    let pool = appv3_db::create_pool(&s.database_path).await.unwrap();
    appv3_db::migrations::run_migrations(&pool).await.unwrap();
    appv3_api::startup::startup(&pool).await.unwrap();
    let c = Client::new(create_app(AppState { pool: pool.clone() }, Policy::from_env()));

    // ── health + security headers ────────────────────────────────────────
    let (st, h, body) = c.send(Request::get("/api/health/live").body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    assert_eq!(h.get("x-content-type-options").unwrap(), "nosniff");
    assert!(h.get("access-control-allow-origin").is_none(), "no CORS headers without Origin");
    let (st, _) = c.json("GET", "/api/health/ready", None).await;
    assert_eq!(st, StatusCode::OK);
    let live: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert!(live["capabilities"].as_array().unwrap().iter().any(|c| c == "api.plugins"), "{live}");
    let (st, plugins) = c.json("GET", "/api/plugins", None).await;
    assert_eq!(st, StatusCode::OK);
    assert!(plugins["plugins"].is_array() && plugins["unported"].is_array(), "{plugins}");

    // ── first-run workspace: builtin agents ──────────────────────────────
    let (st, v) = c.json("GET", "/api/agents", None).await;
    assert_eq!(st, StatusCode::OK);
    let names: Vec<&str> = v["agents"].as_array().unwrap().iter().map(|a| a["name"].as_str().unwrap()).collect();
    for n in ["code", "explorer", "researcher"] {
        assert!(names.contains(&n), "{names:?}");
    }

    // ── validation envelopes (pydantic shape) ────────────────────────────
    let (st, v) = c.json("PUT", "/api/settings/denied-paths", Some(json!({"x": 1}))).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(v["detail"].is_array() || v["detail"].is_string(), "{v}");
    let (st, v) = c.json("POST", "/api/mcp/servers", Some(json!({"name": "1bad", "server": {"transport": "stdio", "command": "x"}}))).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    let (st, v) = c.json("GET", "/api/nope", None).await;
    assert_eq!((st, v), (StatusCode::NOT_FOUND, json!({"detail": "Not Found"})));

    // ── skills CRUD ──────────────────────────────────────────────────────
    let (st, v) = c.json("POST", "/api/skills", Some(json!({"name": "my-skill", "content": "---\nname: my-skill\ndescription: d\n---\nbody\n"}))).await;
    assert_eq!(st, StatusCode::CREATED, "{v}");
    let (st, _) = c.json("GET", "/api/skills/my-skill", None).await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = c.json("DELETE", "/api/skills/my-skill", None).await;
    assert_eq!(st, StatusCode::OK);

    // ── chat turn through the mock provider ──────────────────────────────
    let (st, _) = c.json("POST", "/api/settings/default-model", Some(json!({"provider_model": "ollama:mock-1"}))).await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = c.json("PUT", "/api/settings/title-generation", Some(json!({"enabled": false, "model": "ollama:mock-1", "wait_timeout_seconds": 0}))).await;
    assert_eq!(st, StatusCode::OK);
    let ws = root.path().join("proj");
    std::fs::create_dir_all(&ws).unwrap();
    std::fs::write(ws.join("a.txt"), "x").unwrap();
    let wss = ws.display().to_string();
    let (st, v) = c.form("/api/agent/chat", &[("message", "  ")]).await;
    assert_eq!(st, StatusCode::UNPROCESSABLE_ENTITY, "{v}");
    let (st, v) = c.form("/api/agent/chat", &[("message", "hi"), ("workspace", &wss)]).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    assert_eq!(v["status"], "accepted");
    let sid = v["session_id"].as_str().unwrap().to_string();

    let req = Request::get(format!("/api/agent/{sid}/stream")).body(Body::empty()).unwrap();
    let (st, h, raw) = tokio::time::timeout(std::time::Duration::from_secs(20), c.send(req)).await.expect("stream ends");
    assert_eq!(st, StatusCode::OK);
    assert!(h.get("content-type").unwrap().to_str().unwrap().starts_with("text/event-stream"));
    let events = sse_events(&raw);
    let names: Vec<&str> = events.iter().map(|(e, _)| e.as_str()).collect();
    assert_eq!(names.last(), Some(&"done"), "{names:?}");
    let text: String = events.iter().filter(|(e, _)| e == "message").filter_map(|(_, d)| d["text"].as_str()).collect();
    assert_eq!(text, "Hello from mock.", "{events:?}");

    let mut history = Value::Null;
    for _ in 0..50 {
        let (st, v) = c.json("GET", &format!("/api/agent/{sid}/history"), None).await;
        assert_eq!(st, StatusCode::OK);
        if v["lead"]["messages"].as_array().map(|m| m.len() >= 2).unwrap_or(false) {
            history = v;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    let msgs = history["lead"]["messages"].as_array().expect("history persisted");
    assert_eq!(msgs[0]["role"], "user");
    assert_eq!(msgs[0]["content"], "hi");
    assert!(msgs[0]["extra"]["snapshot"].as_str().map(|s| s.len() == 40).unwrap_or(false), "git snapshot recorded: {}", msgs[0]);
    assert_eq!(msgs[1]["role"], "assistant");
    assert_eq!(msgs[1]["content"], "Hello from mock.");
    assert_eq!(msgs[1]["extra"]["usage"], json!({"input": 7, "output": 3}));

    // undo restores the workspace snapshot and reports changed paths
    std::fs::write(ws.join("b.txt"), "later").unwrap();
    let (st, v) = c.json("POST", "/api/agent/commands", Some(json!({"command": "undo", "session_id": sid}))).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    assert_eq!(v["changed_paths"]["removed"], json!(["b.txt"]));
    assert!(!ws.join("b.txt").exists());
    let (st, v) = c.json("POST", "/api/agent/commands", Some(json!({"command": "redo-all", "session_id": sid}))).await;
    assert_eq!(st, StatusCode::ACCEPTED, "{v}");
    assert!(ws.join("b.txt").exists());

    let (st, v) = c.json("GET", "/api/agent/sessions?limit=5", None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["data"][0]["id"].as_str().or(v["sessions"][0]["id"].as_str()), Some(sid.as_str()), "{v}");

    // `active=true` (v3 addition) lists only sessions running or waiting on the user
    let (st, v) = c.json("GET", "/api/agent/sessions?active=true", None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v, json!({"data": [], "next_cursor": null, "has_more": false}));
    appv3_db::create_pending_question(&pool, &sid, "call-active", &[json!({"question": "Which?", "options": []})]).await.unwrap();
    let (st, v) = c.json("GET", "/api/agent/sessions?active=true&limit=1", None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["data"].as_array().map(Vec::len), Some(1), "{v}");
    assert_eq!(v["data"][0]["id"], json!(sid));
    assert_eq!(v["data"][0]["needs_input"], json!(true));
    assert_eq!(v["has_more"], json!(false));

    // `q` (v3 addition) matches titles case-insensitively; LIKE wildcards are literal
    let (st, v) = c.json("GET", "/api/agent/sessions?q=HI", None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["data"][0]["id"], json!(sid), "{v}");
    for miss in ["zzz", "%25", "h_"] {
        let (_, v) = c.json("GET", &format!("/api/agent/sessions?q={miss}"), None).await;
        assert_eq!(v["data"], json!([]), "q={miss}: {v}");
    }

    let (st, _) = c.json("DELETE", &format!("/api/agent/sessions/{sid}"), None).await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    assert!(!appv3_agent::snapshot::snapshot_dir(&sid).exists());
    let (st, _) = c.json("GET", &format!("/api/agent/sessions/{sid}"), None).await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    // ── desktop token middleware ─────────────────────────────────────────
    let authed = Client::new(create_app(AppState { pool: pool.clone() }, Policy { token: Arc::new("tok".into()), ..Policy::from_env() }));
    let (st, v) = authed.json("GET", "/api/agents", None).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(v, json!({"detail": "Unauthorized — OpenAgentd access key required."}));
    let (st, _) = authed.json("GET", "/api/health/live", None).await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = authed.json("GET", "/api/agents?_token=tok", None).await;
    assert_eq!(st, StatusCode::OK);
    let (st, _, _) = authed.send(Request::get("/api/agents").header("authorization", "Bearer tok").body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::OK);

    // ── CORS preflight (Starlette semantics) with an access key ──────────
    let (st, h, body) = authed
        .send(Request::builder().method("OPTIONS").uri("/api/agents").header("origin", "http://x").header("access-control-request-method", "GET").body(Body::empty()).unwrap())
        .await;
    assert_eq!((st, body.as_slice()), (StatusCode::OK, b"OK".as_slice()));
    assert_eq!(h.get("access-control-allow-origin").unwrap(), "http://x");
    assert_eq!(h.get("access-control-allow-methods").unwrap(), "DELETE, GET, HEAD, OPTIONS, PATCH, POST, PUT");

    // ── cross-origin guard without an access key ─────────────────────────
    // Without a key the loopback API trusts its callers, so a web page on
    // another origin must not be able to drive it (terminal tickets, chat).
    let preflight = |origin: &str| {
        Request::builder()
            .method("OPTIONS")
            .uri("/api/terminal/ticket")
            .header("origin", origin)
            .header("access-control-request-method", "POST")
            .header("access-control-request-headers", "content-type")
            .body(Body::empty())
            .unwrap()
    };
    let (st, h, _) = c.send(preflight("https://evil.example")).await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    assert!(h.get("access-control-allow-origin").is_none());
    for origin in ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost", "http://localhost:5173", "http://127.0.0.1:5173"] {
        let (st, h, _) = c.send(preflight(origin)).await;
        assert_eq!(st, StatusCode::OK, "{origin}");
        assert_eq!(h.get("access-control-allow-origin").unwrap(), origin);
    }
    // A "simple" request skips the preflight, so the guard must refuse it outright.
    let ticket = |origin: &str| {
        Request::post("/api/terminal/ticket").header("origin", origin).header("content-type", "text/plain").body(Body::from(json!({"workspace": wss}).to_string())).unwrap()
    };
    let (st, _, body) = c.send(ticket("https://evil.example")).await;
    assert_eq!(st, StatusCode::FORBIDDEN, "{}", String::from_utf8_lossy(&body));
    let (st, _, body) = c.send(ticket("http://localhost:5173")).await;
    assert_eq!(st, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let upgrade = Request::get("/api/terminal/ws?ticket=x")
        .header("origin", "https://evil.example")
        .header("connection", "upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(Body::empty())
        .unwrap();
    let (st, _, _) = c.send(upgrade).await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    // DNS rebinding: a same-origin GET carries no Origin, only a foreign Host.
    let (st, _, _) = c.send(Request::get("/api/agents").header("host", "attacker.example:8000").body(Body::empty()).unwrap()).await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    for host in ["localhost:8000", "127.0.0.1:8000", "[::1]:8000"] {
        let (st, _, _) = c.send(Request::get("/api/agents").header("host", host).body(Body::empty()).unwrap()).await;
        assert_eq!(st, StatusCode::OK, "{host}");
    }

    // ── LAN server with an access key (mobile app) ───────────────────────
    // The key is the boundary there: any Host/Origin works once it matches.
    let lan =
        Client { app: create_app(AppState { pool: pool.clone() }, Policy { token: Arc::new("tok".into()), ..Policy::from_env() }), local: "192.168.1.100:4082".parse().unwrap() };
    let lan_get = |origin: &str, auth: Option<&str>| {
        let mut b = Request::get("/api/agents").header("host", "192.168.1.100:4082").header("origin", origin);
        if let Some(a) = auth {
            b = b.header("authorization", a);
        }
        b.body(Body::empty()).unwrap()
    };
    for origin in ["tauri://localhost", "http://tauri.localhost"] {
        let (st, h, _) = lan.send(lan_get(origin, Some("Bearer tok"))).await;
        assert_eq!(st, StatusCode::OK, "{origin}");
        assert_eq!(h.get("access-control-allow-origin").unwrap(), origin);
    }
    let (st, _, _) = lan.send(lan_get("https://evil.example", None)).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);

    appv3_api::startup::shutdown().await;
}
