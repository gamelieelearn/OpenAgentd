//! MCP client integration — port of `app/agent/mcp` (config, manager, tools).
//! HTTP servers with an `oauth` block run the MCP SDK OAuth flow
//! (`oauth.rs`), sharing `{CACHE_DIR}/mcp-oauth/<name>.json` with v2.

pub mod client;
pub mod config;
pub mod oauth;
pub mod tool;

use appv3_tools::ToolRef;
use client::{McpClient, McpError};
use config::ServerConfig;
use indexmap::IndexMap;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;
use tokio::sync::watch;
use tool::{McpTool, SessionProvider};

#[derive(Debug, Clone, PartialEq)]
pub struct ServerStatus {
    pub name: String,
    pub transport: String,
    pub enabled: bool,
    /// `stopped` | `starting` | `ready` | `error` | `auth_required`
    pub state: String,
    pub error: Option<String>,
    pub tool_names: Vec<String>,
    pub started_at: Option<String>,
}

struct Runner {
    status: Mutex<ServerStatus>,
    tools: Mutex<Vec<ToolRef>>,
    client: Mutex<Option<Arc<McpClient>>>,
    ready: watch::Sender<bool>,
    shutdown: watch::Sender<bool>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl SessionProvider for Runner {
    fn client(&self) -> Option<Arc<McpClient>> {
        self.client.lock().unwrap().clone()
    }
}

impl Runner {
    fn new(name: &str, cfg: &ServerConfig, state: &str) -> Arc<Self> {
        Arc::new(Runner {
            status: Mutex::new(ServerStatus {
                name: name.into(),
                transport: cfg.transport().into(),
                enabled: cfg.enabled(),
                state: state.into(),
                error: None,
                tool_names: vec![],
                started_at: None,
            }),
            tools: Mutex::new(vec![]),
            client: Mutex::new(None),
            ready: watch::channel(state == "stopped").0,
            shutdown: watch::channel(state == "stopped").0,
            task: Mutex::new(None),
        })
    }
    fn state(&self) -> String {
        self.status.lock().unwrap().state.clone()
    }
    fn finish(&self, state: &str, error: Option<String>) {
        *self.client.lock().unwrap() = None;
        self.tools.lock().unwrap().clear();
        let mut st = self.status.lock().unwrap();
        st.state = state.into();
        st.error = error;
        st.tool_names.clear();
        drop(st);
        let _ = self.ready.send(true);
    }
    async fn wait_ready(&self, timeout: Duration) -> bool {
        tokio::time::timeout(timeout, wait_true(self.ready.subscribe())).await.is_ok()
    }
}

async fn wait_true(mut rx: watch::Receiver<bool>) {
    let _ = rx.wait_for(|v| *v).await;
}

#[derive(Default)]
pub struct McpManager {
    runners: RwLock<IndexMap<String, Arc<Runner>>>,
    lock: tokio::sync::Mutex<bool>,
}

/// Python `datetime.now(UTC).isoformat()`.
fn utc_isoformat() -> String {
    let now = chrono::Utc::now();
    if now.timestamp_subsec_micros() == 0 {
        now.format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
    } else {
        now.format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()
    }
}

fn oauth_required_config_message(name: &str) -> String {
    format!("MCP server '{name}' requires OAuth. Enable OAuth, add the OAuth app client ID and secret in Settings, then Connect OAuth.")
}

fn oauth_credentials_required_message(name: &str) -> String {
    format!("MCP server '{name}' requires OAuth app credentials. Add the OAuth app client ID/secret in Settings, then Connect OAuth.")
}

/// `_is_oauth_registration_failure`.
fn is_oauth_registration_failure(e: &McpError) -> bool {
    let msg = e.to_string();
    e.type_name() == "OAuthRegistrationError" || msg.contains("Registration failed") || msg.contains("OAuthRegistrationError")
}

/// OAuth block with a configured but unresolvable client id.
fn unresolved_client_id(cfg: &ServerConfig) -> bool {
    match cfg {
        ServerConfig::Http { oauth: Some(o), .. } => o.client_id.as_deref().map(|s| !s.is_empty()).unwrap_or(false) && !oauth::has_resolved_client_id(Some(o)),
        _ => false,
    }
}

fn is_http_auth_failure(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("missing_token") || m.contains("unauthorized") || m.contains("401") || m.contains("authentication")
}

enum RunError {
    AuthRequired(String),
    Failed(McpError),
}

impl From<McpError> for RunError {
    fn from(e: McpError) -> Self {
        RunError::Failed(e)
    }
}

/// `_get_user_path` — login-shell PATH, cached.
async fn user_path(force: bool) -> String {
    static CACHE: OnceLock<Mutex<Option<String>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if !force {
        if let Some(p) = cache.lock().unwrap().clone() {
            return p;
        }
    }
    const PREFIX: &str = "__OPENAGENTD_PATH__";
    let shell = appv3_tools::shell::acceptable();
    let argv = appv3_tools::shell::build_argv(&shell, &format!("printf \"{PREFIX}%s\\n\" \"$PATH\""));
    let probe = tokio::process::Command::new(&shell).args(argv).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null()).kill_on_drop(true).output();
    let mut found = None;
    if let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(3), probe).await {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            found = text.lines().rev().find_map(|l| l.strip_prefix(PREFIX).map(|p| p.trim().to_string()).filter(|p| !p.is_empty()));
        }
    }
    let p = found.unwrap_or_else(|| std::env::var("PATH").unwrap_or_default());
    *cache.lock().unwrap() = Some(p.clone());
    p
}

fn which_in(cmd: &str, path: &str) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    let is_exec = |p: &std::path::Path| std::fs::metadata(p).map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false);
    if cmd.contains('/') {
        return is_exec(std::path::Path::new(cmd)).then(|| cmd.to_string());
    }
    std::env::split_paths(path).map(|d| d.join(cmd)).find(|p| is_exec(p)).map(|p| p.display().to_string())
}

async fn connect(name: &str, cfg: &ServerConfig) -> Result<McpClient, RunError> {
    match cfg {
        ServerConfig::Stdio { command, args, env, .. } => {
            let configured = env.get("PATH").cloned();
            let mut path = match &configured {
                Some(p) => p.clone(),
                None => {
                    let u = user_path(false).await;
                    if u.is_empty() {
                        std::env::var("PATH").unwrap_or_default()
                    } else {
                        u
                    }
                }
            };
            let mut resolved = which_in(command, &path);
            if resolved.is_none() && configured.is_none() {
                let u = user_path(true).await;
                path = if u.is_empty() { std::env::var("PATH").unwrap_or_default() } else { u };
                resolved = which_in(command, &path);
            }
            let mut launch_env: Vec<(String, String)> = vec![];
            if !path.is_empty() {
                launch_env.push(("PATH".into(), path));
            }
            for (k, v) in config::resolve_env_dict(env) {
                launch_env.retain(|(n, _)| *n != k);
                launch_env.push((k, v));
            }
            Ok(McpClient::stdio(resolved.as_deref().unwrap_or(command), args, &launch_env)?)
        }
        ServerConfig::Http { url, headers, oauth, .. } => {
            let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
            if oauth.is_none() && host == "mcp.slack.com" {
                return Err(RunError::AuthRequired(oauth_required_config_message(name)));
            }
            if oauth.is_some() && !oauth::has_cached_oauth_tokens(name) && !oauth::interactive_oauth_allowed(name) {
                return Err(RunError::AuthRequired(oauth::needs_oauth_message(name)));
            }
            if oauth.is_some() && oauth::interactive_oauth_allowed(name) && unresolved_client_id(cfg) {
                return Err(RunError::AuthRequired(oauth_credentials_required_message(name)));
            }
            let hdrs: Vec<(String, String)> = config::resolve_env_dict(headers).into_iter().collect();
            let auth = oauth::build_oauth_provider(name, url, oauth.as_ref())?;
            Ok(McpClient::http(url, &hdrs, auth)?)
        }
    }
}

async fn run_server(name: String, cfg: ServerConfig, runner: Arc<Runner>) {
    let res: Result<(), RunError> = async {
        let client = Arc::new(connect(&name, &cfg).await?);
        let setup = async {
            client.initialize().await?;
            client.list_tools().await
        };
        let shutdown = runner.shutdown.subscribe();
        let defs = tokio::select! {
            r = setup => match r {
                Ok(d) => d,
                Err(e) => {
                    match e {
                        McpError::Rpc(_) | McpError::Session(..) => client.close().await,
                        McpError::Transport(..) => client.abort().await,
                    }
                    return Err(e.into());
                }
            },
            _ = wait_true(shutdown.clone()) => {
                client.close().await;
                return Ok(());
            }
        };
        let weak: std::sync::Weak<dyn SessionProvider> = Arc::downgrade(&(runner.clone() as Arc<dyn SessionProvider>));
        let tools: Vec<ToolRef> = defs.into_iter().map(|d| Arc::new(McpTool::new(&name, d, weak.clone())) as ToolRef).collect();
        let names: Vec<String> = tools.iter().map(|t| t.name().to_string()).collect();
        *runner.client.lock().unwrap() = Some(client.clone());
        *runner.tools.lock().unwrap() = tools;
        {
            let mut st = runner.status.lock().unwrap();
            st.state = "ready".into();
            st.tool_names = names.clone();
            st.started_at = Some(utc_isoformat());
            st.error = None;
        }
        let _ = runner.ready.send(true);
        tracing::info!("mcp_server_ready name={} transport={} tools={}", name, cfg.transport(), names.len());
        wait_true(shutdown).await;
        *runner.client.lock().unwrap() = None;
        tracing::info!("mcp_server_stopping name={}", name);
        client.close().await;
        Ok(())
    }
    .await;
    match res {
        Ok(()) => {
            if runner.state() != "ready" {
                runner.finish("stopped", None);
            }
        }
        Err(RunError::AuthRequired(m)) => {
            tracing::warn!("mcp_server_auth_required name={} transport={} err={}", name, cfg.transport(), m);
            runner.finish("auth_required", Some(m));
        }
        Err(RunError::Failed(e)) => {
            if e.type_name() == "OAuthRequiredError" {
                tracing::warn!("mcp_server_auth_required name={} transport={} err={}", name, cfg.transport(), e);
                runner.finish("auth_required", Some(e.to_string()));
                return;
            }
            let is_http_no_oauth = matches!(&cfg, ServerConfig::Http { oauth: None, .. });
            if is_http_no_oauth && is_http_auth_failure(&e.to_string()) {
                let m = oauth_required_config_message(&name);
                tracing::warn!("mcp_server_auth_required name={} transport={} err={}", name, cfg.transport(), m);
                runner.finish("auth_required", Some(m));
                return;
            }
            if is_oauth_registration_failure(&e) || unresolved_client_id(&cfg) {
                let m = oauth_credentials_required_message(&name);
                tracing::warn!("mcp_server_auth_required name={} transport={} err={}", name, cfg.transport(), m);
                runner.finish("auth_required", Some(m));
                return;
            }
            tracing::error!("mcp_server_failed name={} transport={} err={}", name, cfg.transport(), e);
            runner.finish("error", Some(e.formatted()));
        }
    }
}

impl McpManager {
    fn spawn_runner(&self, name: &str, cfg: &ServerConfig) {
        let runner = if cfg.enabled() { Runner::new(name, cfg, "starting") } else { Runner::new(name, cfg, "stopped") };
        self.runners.write().unwrap().insert(name.to_string(), runner.clone());
        if cfg.enabled() {
            let h = tokio::spawn(run_server(name.to_string(), cfg.clone(), runner.clone()));
            *runner.task.lock().unwrap() = Some(h);
        }
    }

    fn start_locked(&self) {
        let cfg = match config::load_config() {
            Ok(c) => c,
            Err(e) => {
                tracing::error!("mcp_config_invalid err={}", e);
                return;
            }
        };
        if cfg.servers.is_empty() {
            tracing::info!("mcp_no_servers_configured");
            return;
        }
        for (name, sc) in &cfg.servers {
            self.spawn_runner(name, sc);
        }
        tracing::info!("mcp_manager_started servers={:?}", self.runners.read().unwrap().iter().map(|(n, r)| (n.clone(), r.state())).collect::<Vec<_>>());
    }

    /// `start()` — idempotent.
    pub async fn start(&self) {
        let mut started = self.lock.lock().await;
        if *started {
            return;
        }
        *started = true;
        self.start_locked();
    }

    async fn stop_runner(runner: &Arc<Runner>) {
        let _ = runner.shutdown.send(true);
        let task = runner.task.lock().unwrap().take();
        if let Some(mut h) = task {
            if tokio::time::timeout(Duration::from_secs(10), &mut h).await.is_err() {
                h.abort();
                let _ = h.await;
                runner.finish("stopped", None);
            }
        }
    }

    async fn stop_all(&self) {
        let all: Vec<Arc<Runner>> = self.runners.read().unwrap().values().cloned().collect();
        futures::future::join_all(all.iter().map(Self::stop_runner)).await;
        self.runners.write().unwrap().clear();
    }

    pub async fn stop(&self) {
        let mut started = self.lock.lock().await;
        if !*started {
            return;
        }
        self.stop_all().await;
        *started = false;
        tracing::info!("mcp_manager_stopped");
    }

    pub async fn reload_from_config(&self) {
        let mut started = self.lock.lock().await;
        self.stop_all().await;
        *started = true;
        self.start_locked();
    }

    /// `restart_server` — `Err(())` when *name* is not in `mcp.json`.
    pub async fn restart_server(&self, name: &str, ready_timeout: Duration) -> Result<ServerStatus, String> {
        let cfg = config::load_config()?;
        let Some(sc) = cfg.servers.get(name).cloned() else { return Err(format!("'{name}'")) };
        {
            let _g = self.lock.lock().await;
            let old = self.runners.read().unwrap().get(name).cloned();
            if let Some(r) = old {
                Self::stop_runner(&r).await;
            }
            self.spawn_runner(name, &sc);
        }
        let runner = self.runners.read().unwrap().get(name).cloned().expect("runner");
        if runner.state() != "stopped" && !runner.wait_ready(ready_timeout).await {
            tracing::warn!("mcp_restart_timeout server={} timeout_s={}", name, ready_timeout.as_secs_f64());
        }
        let st = runner.status.lock().unwrap().clone();
        Ok(st)
    }

    pub async fn remove_runner(&self, name: &str) {
        let _g = self.lock.lock().await;
        let old = self.runners.read().unwrap().get(name).cloned();
        if let Some(r) = old {
            Self::stop_runner(&r).await;
        }
        self.runners.write().unwrap().shift_remove(name);
    }

    pub async fn wait_until_ready(&self, timeout: Duration) {
        let all: Vec<Arc<Runner>> = self.runners.read().unwrap().values().cloned().collect();
        let _ = tokio::time::timeout(timeout, futures::future::join_all(all.iter().map(|r| r.wait_ready(timeout)))).await;
    }

    pub fn list_status(&self) -> Vec<ServerStatus> {
        self.runners.read().unwrap().values().map(|r| r.status.lock().unwrap().clone()).collect()
    }

    pub fn get_status(&self, name: &str) -> Option<ServerStatus> {
        self.runners.read().unwrap().get(name).map(|r| r.status.lock().unwrap().clone())
    }

    pub fn server_names(&self) -> Vec<String> {
        self.runners.read().unwrap().keys().cloned().collect()
    }

    pub fn tools_for_server(&self, name: &str) -> Option<Vec<ToolRef>> {
        let r = self.runners.read().unwrap().get(name).cloned()?;
        if r.state() != "ready" {
            return Some(vec![]);
        }
        let t = r.tools.lock().unwrap().clone();
        Some(t)
    }

    /// `call_app_tool` errors: `KeyError` → NotFound, `RuntimeError` → NotConnected,
    /// `ValueError` → Forbidden, anything else → Failed.
    pub async fn call_app_tool(&self, server: &str, tool: &str, arguments: Value) -> Result<Value, AppToolError> {
        let Some(r) = self.runners.read().unwrap().get(server).cloned() else { return Err(AppToolError::NotFound) };
        let client = r.client.lock().unwrap().clone();
        let Some(client) = client.filter(|_| r.state() == "ready") else {
            return Err(AppToolError::NotConnected(format!("MCP server '{server}' is not connected.")));
        };
        let prefix = format!("{server}_");
        let advertised = r.tools.lock().unwrap().iter().any(|t| t.name().strip_prefix(&prefix).unwrap_or(t.name()) == tool);
        if !advertised {
            return Err(AppToolError::Forbidden(format!("MCP tool '{tool}' is not available.")));
        }
        client.call_tool(tool, arguments).await.map(|v| tool::dump_call_result(&v)).map_err(|e| AppToolError::Failed(e.to_string()))
    }
}

#[derive(Debug)]
pub enum AppToolError {
    NotFound,
    NotConnected(String),
    Forbidden(String),
    Failed(String),
}

impl appv3_agent::loader::McpSource for McpManager {
    fn server_names(&self) -> Vec<String> {
        McpManager::server_names(self)
    }
    fn tools_for_server(&self, name: &str) -> Vec<ToolRef> {
        McpManager::tools_for_server(self, name).unwrap_or_default()
    }
}

/// Global `mcp_manager`, registered as the agent loader's MCP source.
pub fn mcp_manager() -> Arc<McpManager> {
    static M: OnceLock<Arc<McpManager>> = OnceLock::new();
    M.get_or_init(|| {
        let m = Arc::new(McpManager::default());
        appv3_agent::loader::set_mcp_source(m.clone());
        m
    })
    .clone()
}

/// `ServerStatusResponse.config` body with masked secrets (`_config_to_body`).
pub fn masked_config_body(cfg: Option<&ServerConfig>) -> Value {
    const MASK: &str = "********";
    match cfg {
        None => Value::Null,
        Some(ServerConfig::Stdio { command, args, env, enabled }) => json!({"transport": "stdio", "command": command, "args": args, "env": env, "enabled": enabled}),
        Some(ServerConfig::Http { url, headers, oauth, enabled }) => {
            let oauth = oauth.as_ref().map(|o| {
                json!({"client_id": o.client_id.as_ref().filter(|s| !s.is_empty()).map(|_| MASK), "client_secret": o.client_secret.as_ref().filter(|s| !s.is_empty()).map(|_| MASK)})
            });
            let hdrs: serde_json::Map<String, Value> = headers.keys().map(|k| (k.clone(), json!(MASK))).collect();
            json!({"transport": "http", "url": url, "headers": hdrs, "oauth": oauth, "enabled": enabled})
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tiny MCP server over stdio implemented as a shell script.
    #[tokio::test]
    async fn stdio_roundtrip() {
        let d = tempfile::tempdir().unwrap();
        let script = d.path().join("srv.py");
        std::fs::write(
            &script,
            r#"import sys, json
for line in sys.stdin:
    m = json.loads(line)
    if "id" not in m: continue
    if m["method"] == "initialize":
        r = {"protocolVersion": "2025-06-18", "capabilities": {}, "serverInfo": {"name": "t", "version": "1"}}
    elif m["method"] == "tools/list":
        r = {"tools": [{"name": "echo", "description": "Echo", "inputSchema": {"type": "object", "properties": {"x": {"type": "string"}}}}]}
    elif m["method"] == "tools/call":
        r = {"content": [{"type": "text", "text": "got " + m["params"]["arguments"].get("x", "")}]}
    else:
        r = {}
    print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": r}), flush=True)
"#,
        )
        .unwrap();
        let Some(py) = which_in("python3", &std::env::var("PATH").unwrap_or_default()) else { return };
        let c = McpClient::stdio(&py, &[script.display().to_string()], &[]).unwrap();
        c.initialize().await.unwrap();
        let tools = c.list_tools().await.unwrap();
        assert_eq!(tools[0]["name"], "echo");
        let r = c.call_tool("echo", json!({"x": "hi"})).await.unwrap();
        assert_eq!(tool::extract_text(r.get("content")), "got hi");
        c.close().await;
        assert!(c.list_tools().await.is_err());
    }
}
