//! `openagentd server serve` lifecycle against the real binary, the way the
//! desktop app drives it (handshake on stdout, SIGTERM on quit).
#![cfg(unix)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn spawn_server(root: &std::path::Path, desktop_token: Option<&str>) -> (Child, BufReader<std::process::ChildStdout>, u16) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_openagentd"));
    cmd.args(["server", "serve", "--host", "127.0.0.1", "--port", "0", "--handshake"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for (k, d) in [
        ("OPENAGENTD_DATA_DIR", "data"),
        ("OPENAGENTD_CONFIG_DIR", "config"),
        ("OPENAGENTD_STATE_DIR", "state"),
        ("OPENAGENTD_CACHE_DIR", "cache"),
        ("OPENAGENTD_WORKSPACE_DIR", "ws"),
        ("HOME", "home"),
    ] {
        cmd.env(k, root.join(d));
    }
    cmd.env("APP_ENV", "production").env("OPENAGENTD_MODEL_REGISTRY_REFRESH", "false").env("SNAPSHOT_MAINTENANCE_ENABLED", "false");
    for k in ["OPENAGENTD_DESKTOP_TOKEN", "OPENAGENTD_ACCESS_KEY", "DATABASE_URL", "OPENAGENTD_HANDSHAKE_FILE"] {
        cmd.env_remove(k);
    }
    if let Some(t) = desktop_token {
        cmd.env("OPENAGENTD_DESKTOP_TOKEN", t);
    }
    let mut child = cmd.spawn().expect("spawn openagentd");
    let mut line = String::new();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    stdout.read_line(&mut line).unwrap();
    let json = line.strip_prefix("OPENAGENTD_HANDSHAKE ").unwrap_or_else(|| panic!("no handshake: {line:?}"));
    let port = serde_json::from_str::<serde_json::Value>(json).unwrap()["port"].as_u64().unwrap() as u16;
    (child, stdout, port)
}

/// Open `/api/events/stream` and wait for the response head, like the web UI.
fn open_event_stream(port: u16) -> TcpStream {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    s.write_all(b"GET /api/events/stream HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n").unwrap();
    s.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        s.read_exact(&mut byte).unwrap();
        head.push(byte[0]);
    }
    assert!(head.starts_with(b"HTTP/1.1 200"), "{}", String::from_utf8_lossy(&head));
    s
}

#[test]
fn sigterm_with_an_open_event_stream_exits_promptly_after_shutdown_hooks() {
    let root = tempfile::tempdir().unwrap();
    let (mut child, _stdout, port) = spawn_server(root.path(), None);
    let _stream = open_event_stream(port);

    let started = Instant::now();
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(child.id() as i32), nix::sys::signal::Signal::SIGTERM).unwrap();
    let status = loop {
        if let Some(st) = child.try_wait().unwrap() {
            break st;
        }
        assert!(started.elapsed() < Duration::from_secs(20), "server never exited");
        std::thread::sleep(Duration::from_millis(20));
    };
    let elapsed = started.elapsed();
    let mut stderr = String::new();
    child.stderr.take().unwrap().read_to_string(&mut stderr).unwrap();

    assert!(status.success(), "{status:?}\n{stderr}");
    // The desktop force-kills after 750 ms on backend restart and 5 s on
    // quit, so an open SSE stream must not hold the drain open.
    assert!(elapsed < Duration::from_millis(1500), "shutdown took {elapsed:?}\n{stderr}");
    assert!(stderr.contains("server_shutdown"), "shutdown hooks did not run:\n{stderr}");
}
