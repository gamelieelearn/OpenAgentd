//! `openagentd server serve` — port of `app/cli/commands/serve.py`
//! (foreground server for the desktop sidecar / embedding, and the process
//! `server start` daemonises in place of uvicorn).

use crate::argparse::Ns;
use crate::cmd::server::{ns_bool, ns_int, ns_str, DAEMON_ENV};
use appv3_api::{create_app, AppState, ConnInfo, Policy};
use serde_json::json;
use std::io::Write;
use std::sync::OnceLock;
use tokio::sync::Notify;

/// `app/server.py`: `setup_logging(settings.LOG_LEVEL, file_log_level=settings.FILE_LOG_LEVEL)`.
fn init_logging() {
    let file_level = std::env::var("FILE_LOG_LEVEL").ok().filter(|v| !v.is_empty()).unwrap_or_else(|| "DEBUG".into());
    crate::logging::setup(&appv3_core::settings().log_level, &file_level, true);
    crate::logging::install_panic_hook();
}

/// Shutdown request from the parent-watch thread. A stored permit, so it
/// also works if the parent dies before the server awaits it.
fn parent_gone() -> &'static Notify {
    static N: OnceLock<Notify> = OnceLock::new();
    N.get_or_init(Notify::new)
}

/// `_start_parent_watch` — shut down gracefully when the parent dies (on
/// every OS; v2 signalled itself with SIGTERM, which Windows lacks), hard
/// exit if shutdown has not finished within the grace period.
fn start_parent_watch(parent: i32) {
    std::thread::Builder::new()
        .name("parent-watch".into())
        .spawn(move || loop {
            if !crate::paths::pid_alive(parent) {
                eprintln!("parent-watch: parent pid {parent} no longer alive; shutting down");
                parent_gone().notify_one();
                std::thread::sleep(std::time::Duration::from_secs(15));
                std::process::exit(1);
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        })
        .expect("spawn parent watch");
}

fn emit_handshake(port: u16, token: Option<&str>) {
    let mut payload = json!({"port": port, "pid": std::process::id(), "version": appv3_core::VERSION});
    if let Some(t) = token {
        payload["token"] = json!(t);
    }
    let line = appv3_core::pyjson::dumps(&payload);
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "OPENAGENTD_HANDSHAKE {line}");
    let _ = out.flush();
    if let Ok(path) = std::env::var("OPENAGENTD_HANDSHAKE_FILE") {
        if !path.is_empty() {
            let tmp = format!("{path}.tmp");
            let res = std::fs::write(&tmp, &line).and_then(|_| std::fs::rename(&tmp, &path));
            if let Err(e) = res {
                eprintln!("handshake file write failed path={path} error={e}");
            }
        }
    }
}

async fn shutdown_signal() {
    let parent = parent_gone().notified();
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("sigterm handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
            _ = parent => {}
        }
    }
    #[cfg(not(unix))]
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = parent => {}
    }
}

pub fn cmd_serve(ns: &Ns) -> anyhow::Result<()> {
    // `app/cli/__main__.py` stdio prime: the desktop shell captures stderr
    // into backend.log, and this line marks the sidecar start there. The
    // `server start` daemon (uvicorn in v2) does not print it.
    if std::env::var_os(DAEMON_ENV).is_none() {
        eprintln!("openagentd: sidecar bootstrap");
    }
    std::env::remove_var(DAEMON_ENV);
    let host = ns_str(ns, "host").unwrap_or("127.0.0.1").to_string();
    let port = ns_int(ns, "port").unwrap_or(0);
    let Ok(port) = u16::try_from(port) else { crate::pystr::uncaught("OverflowError", "bind(): port must be 0-65535.") };
    // Token must be in env before the middleware policy is built.
    let token = if ns_bool(ns, "generate_token") {
        let t = appv3_api::util::token_urlsafe();
        std::env::set_var("OPENAGENTD_DESKTOP_TOKEN", &t);
        Some(t)
    } else {
        std::env::var("OPENAGENTD_DESKTOP_TOKEN").ok().filter(|t| !t.is_empty())
    };
    // v2 builds `settings` (reading `.env`) when importing server_settings.
    appv3_core::env::init_env();
    let has_auth =
        token.is_some() || std::env::var("OPENAGENTD_ACCESS_KEY").is_ok_and(|v| !v.is_empty()) || crate::net::server_settings().access_key.is_some_and(|k| !k.is_empty());
    crate::net::require_loopback_or_auth(&host, has_auth);
    // Hard-enforce production mode in this entry point (before settings load).
    if std::env::var_os("APP_ENV").is_none() {
        std::env::set_var("APP_ENV", "production");
    }
    appv3_core::env::load_config_env(&appv3_core::settings().config_dir);
    init_logging();
    if let Some(p) = ns_int(ns, "parent_pid") {
        start_parent_watch(p as i32);
    }
    let handshake = ns_bool(ns, "handshake");

    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    rt.block_on(async move {
        let s = appv3_core::settings();
        // Runs the migrations too.
        let pool = appv3_db::pool::create_pool(&s.database_path).await?;
        appv3_api::startup::startup(&pool).await?;

        let app = create_app(AppState { pool: pool.clone() }, Policy::from_env());
        let listener = tokio::net::TcpListener::bind((host.as_str(), port)).await?;
        let port = listener.local_addr()?.port();
        tracing::info!("server_listening host={} port={}", host, port);
        if handshake {
            emit_handshake(port, token.as_deref());
        }
        // SSE streams never finish on their own, so end them as soon as the
        // signal arrives (sse-starlette does the same); the timeout only
        // bounds requests that are still running.
        let (tx, mut rx) = tokio::sync::watch::channel(false);
        let server = axum::serve(listener, app.into_make_service_with_connect_info::<ConnInfo>()).with_graceful_shutdown(async move {
            shutdown_signal().await;
            tracing::info!("server_shutdown_requested");
            appv3_api::startup::close_event_streams();
            let _ = tx.send(true);
        });
        tokio::select! {
            r = server => r?,
            _ = async {
                let _ = rx.wait_for(|v| *v).await;
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            } => tracing::info!("graceful_shutdown_timeout"),
        }
        appv3_api::startup::shutdown().await;
        appv3_db::close_pool(&pool).await;
        anyhow::Ok(())
    })
}
