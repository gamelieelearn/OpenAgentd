//! `server start|stop|restart|status|health|logs` — ports of
//! `app/cli/commands/{start,stop,restart,status,health,logs}.py`.
//! `start` launches this binary's `server serve` in place of uvicorn.

use crate::argparse::{Ns, Val};
use crate::net::{display_host, http_get, is_port_reachable, require_loopback_or_auth, resolve_host, resolve_port, server_addresses, server_settings};
use crate::paths::{clear_pids, find_pids, pid_alive, server_log, write_pids};
use crate::pystr::{strip, system_exit, uncaught};
use crate::ui::{bold, cyan, dim, green, ljust, print_banner, red, yellow};
use serde_json::Value;
use std::time::{Duration, Instant};

/// Env marker telling the spawned `server serve` it runs as the CLI daemon
/// (uvicorn in v2), so it skips the sidecar stdio-prime line.
pub const DAEMON_ENV: &str = "OPENAGENTD_CLI_DAEMON_CHILD";

pub fn ns_str<'a>(ns: &'a Ns, k: &str) -> Option<&'a str> {
    match ns.get(k) {
        Some(Val::Str(s)) => Some(s.as_str()),
        _ => None,
    }
}

pub fn ns_int(ns: &Ns, k: &str) -> Option<i64> {
    match ns.get(k) {
        Some(Val::Int(i)) => Some(*i),
        _ => None,
    }
}

pub fn ns_bool(ns: &Ns, k: &str) -> bool {
    matches!(ns.get(k), Some(Val::Bool(true)))
}

fn env_truthy(k: &str) -> bool {
    std::env::var(k).is_ok_and(|v| !v.is_empty())
}

/// `getpass.getpass(prompt)`.
fn getpass(prompt: &str) -> String {
    use std::io::{BufRead, Write};
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if let Ok(tty) = std::fs::OpenOptions::new().read(true).write(true).open("/dev/tty") {
            let fd = tty.as_raw_fd();
            let mut old: libc::termios = unsafe { std::mem::zeroed() };
            if unsafe { libc::tcgetattr(fd, &mut old) } == 0 {
                let mut new = old;
                new.c_lflag &= !libc::ECHO;
                let mut w = &tty;
                unsafe { libc::tcsetattr(fd, libc::TCSAFLUSH, &new) };
                let _ = w.write_all(prompt.as_bytes());
                let _ = w.flush();
                let mut line = String::new();
                let n = std::io::BufReader::new(&tty).read_line(&mut line);
                unsafe { libc::tcsetattr(fd, libc::TCSAFLUSH, &old) };
                let _ = w.write_all(b"\n");
                if matches!(n, Ok(0)) {
                    uncaught("EOFError", "");
                }
                return line.strip_suffix('\n').unwrap_or(&line).to_string();
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::Console::{GetConsoleMode, SetConsoleMode, ENABLE_ECHO_INPUT};
        if let Ok(con) = std::fs::OpenOptions::new().read(true).write(true).open("CONIN$") {
            let h = con.as_raw_handle() as windows_sys::Win32::Foundation::HANDLE;
            let mut old = 0u32;
            if unsafe { GetConsoleMode(h, &mut old) } != 0 {
                unsafe { SetConsoleMode(h, old & !ENABLE_ECHO_INPUT) };
                eprint!("{prompt}");
                let _ = std::io::stderr().flush();
                let mut line = String::new();
                let n = std::io::BufReader::new(&con).read_line(&mut line);
                unsafe { SetConsoleMode(h, old) };
                eprintln!();
                if matches!(n, Ok(0)) {
                    uncaught("EOFError", "");
                }
                return line.trim_end_matches(['\r', '\n']).to_string();
            }
        }
    }
    eprintln!("Warning: Password input may be echoed.");
    eprint!("{prompt}");
    let mut line = String::new();
    if matches!(std::io::stdin().lock().read_line(&mut line), Ok(0) | Err(_)) {
        uncaught("EOFError", "");
    }
    line.strip_suffix('\n').unwrap_or(&line).to_string()
}

fn prompt_access_key() -> String {
    let key = strip(&getpass("OpenAgentd LAN access key: ")).to_string();
    if key.is_empty() {
        system_exit("LAN access key cannot be empty.");
    }
    key
}

fn exe() -> std::path::PathBuf {
    std::env::current_exe().unwrap_or_else(|_| "openagentd".into())
}

pub fn cmd_start(ns: &Ns) {
    if !find_pids().is_empty() {
        println!("  {}  (run {} first)", yellow("already running"), bold("openagentd server stop"));
        return;
    }
    let mut cfg = server_settings();
    let arg_host = ns_str(ns, "host").filter(|h| !h.is_empty());
    let arg_port = ns_int(ns, "port");
    let key = ns_bool(ns, "key");
    if let Some(h) = arg_host {
        cfg.host = h.into();
    }
    if let Some(p) = arg_port.filter(|&p| p != 0) {
        cfg.port = p;
    }
    if key {
        cfg.access_key = Some(prompt_access_key());
    }
    let port = resolve_port(arg_port, Some(cfg.port));
    let host = resolve_host(arg_host, Some(&cfg.host));
    let has_key = cfg.access_key.as_deref().is_some_and(|k| !k.is_empty());
    require_loopback_or_auth(&host, env_truthy("OPENAGENTD_DESKTOP_TOKEN") || env_truthy("OPENAGENTD_ACCESS_KEY") || has_key);
    if arg_host.is_some() || arg_port.is_some_and(|p| p != 0) || key {
        if let Err(e) = appv3_core::runtime_settings::save_server_settings(&cfg) {
            uncaught("OSError", &format!("{e:#}"));
        }
    }

    let srv_log = server_log();
    print_banner(&host, port);
    if let Some(p) = srv_log.parent() {
        if let Err(e) = std::fs::create_dir_all(p) {
            crate::pystr::os_error(&e, Some(p));
        }
    }
    let log = match std::fs::OpenOptions::new().create(true).append(true).open(&srv_log) {
        Ok(f) => f,
        Err(e) => crate::pystr::os_error(&e, Some(&srv_log)),
    };
    let mut cmd = std::process::Command::new(exe());
    cmd.args(["server", "serve", "--host", &host, "--port", &port.to_string()]);
    cmd.env("APP_ENV", "production").env(DAEMON_ENV, "1");
    if has_key && !env_truthy("OPENAGENTD_ACCESS_KEY") {
        cmd.env("OPENAGENTD_ACCESS_KEY", cfg.access_key.as_deref().unwrap_or(""));
    }
    if let Some(dir) = exe().parent() {
        cmd.current_dir(dir);
    }
    let err = log.try_clone().expect("dup log fd");
    cmd.stdin(std::process::Stdio::null()).stdout(log).stderr(err);
    #[cfg(unix)]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    // Windows: detach from the caller's console group, and give the server a
    // hidden console so the shells it spawns don't open windows.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => uncaught("OSError", &e.to_string()),
    };
    let _ = write_pids(&[child.id()]);
    println!("  {}  {}", dim("Logs:"), srv_log.display());
    let addresses = server_addresses(&host, port);
    if let Some(lan) = addresses.lan.first() {
        println!("  {}   {}", dim("LAN:"), bold(lan));
        println!("  {} use the LAN address in the mobile app", dim("Mobile:"));
    }
    println!("  {}  {}", dim("Stop:"), bold("openagentd server stop"));
    println!();

    if ns_bool(ns, "wait") {
        let poll_host = display_host(&host);
        println!("  {} waiting for server to become ready...", dim("Status:"));
        let start = Instant::now();
        let max_wait = 30.0;
        let mut started = false;
        while start.elapsed().as_secs_f64() < max_wait {
            if matches!(child.try_wait(), Ok(Some(_))) {
                println!("  {}: server process died unexpectedly", bold(&red("error")));
                break;
            }
            if matches!(http_get(&poll_host, port, "/api/health/ready", Duration::from_secs(1)), Some((200, _))) {
                started = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        if started {
            println!("  {} {} (took {:.2}s)", dim("Status:"), green("started and ready"), start.elapsed().as_secs_f64());
        } else {
            println!("  {}: server did not become ready within {max_wait:.1}s (check logs)", bold(&yellow("warning")));
        }
        println!();
    }
}

#[cfg(unix)]
fn kill_pid(pid: i32, sig: nix::sys::signal::Signal) {
    use nix::unistd::Pid;
    let p = Pid::from_raw(pid);
    if let Ok(pgid) = nix::unistd::getpgid(Some(p)) {
        if pgid == p {
            let _ = nix::sys::signal::killpg(pgid, sig);
            return;
        }
    }
    let _ = nix::sys::signal::kill(p, sig);
}

pub fn cmd_stop(_ns: &Ns) {
    let alive = find_pids();
    if alive.is_empty() {
        println!("  {}", yellow("not running"));
        return;
    }
    #[cfg(unix)]
    {
        use nix::sys::signal::Signal;
        for &pid in &alive {
            kill_pid(pid, Signal::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive.iter().any(|&p| pid_alive(p)) {
            if Instant::now() > deadline {
                for &pid in &alive {
                    if pid_alive(pid) {
                        kill_pid(pid, Signal::SIGKILL);
                    }
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    // Windows has no SIGTERM; v2's `os.kill` there is TerminateProcess too.
    // `/T` also ends the server's children (shells, MCP and LSP servers).
    #[cfg(windows)]
    {
        for &pid in &alive {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while alive.iter().any(|&p| pid_alive(p)) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
    clear_pids();
    println!("  {}", green("stopped"));
}

pub fn cmd_restart(ns: &Ns) {
    println!();
    println!("  {}", bold(&cyan("Restarting OpenAgentd")));
    println!();
    if !find_pids().is_empty() {
        cmd_stop(ns);
    } else {
        println!("  {}  starting fresh", yellow("not running"));
    }
    cmd_start(ns);
    println!("  {}", green("restart complete"));
}

pub fn cmd_status(ns: &Ns) {
    let alive = find_pids();
    let port = resolve_port(ns_int(ns, "port"), None);
    let bind_host = resolve_host(ns_str(ns, "host"), None);
    let addresses = server_addresses(&bind_host, port);
    println!();
    println!("  {}", bold(&cyan("OpenAgentd server")));
    println!("  {} v{}", dim("Version:"), appv3_core::VERSION);
    println!();
    if !alive.is_empty() {
        let pids: Vec<String> = alive.iter().map(|p| p.to_string()).collect();
        println!("  {} {}  pids: {}", dim("Status:"), green("running"), pids.join(", "));
        println!("  {}  {}", dim("Local:"), bold(&addresses.local));
        if !addresses.lan.is_empty() {
            for (i, url) in addresses.lan.iter().enumerate() {
                let label = if i == 0 { "LAN:" } else { "" };
                println!("  {}  {}", ljust(&dim(label), 6), green(url));
            }
            if bind_host == "0.0.0.0" || bind_host == "::" {
                println!("  {} use the LAN address in the mobile app", dim("Mobile:"));
            }
        }
        println!("  {}   {}", dim("Logs:"), server_log().display());
    } else {
        println!("  {} {}", dim("Status:"), yellow("stopped"));
        println!("  {}  {}  or  {}", dim("Start:"), bold("openagentd server start"), bold("openagentd server start --host 0.0.0.0"));
    }
    println!();
}

/// `_fetch_json(url)` → `(status, payload)`; 0 on connection errors.
fn fetch_json(host: &str, port: i64, path: &str) -> (u16, Option<Value>) {
    let Some((status, body)) = http_get(host, port, path, Duration::from_secs(2)) else { return (0, None) };
    let text = String::from_utf8_lossy(&body);
    if text.is_empty() {
        return (status, None);
    }
    match serde_json::from_str::<Value>(&text) {
        Ok(v) => (status, Some(v)),
        Err(_) if status >= 400 => (status, None),
        Err(_) => (0, None),
    }
}

fn sort_keys(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort();
            Value::Object(keys.into_iter().map(|k| (k.clone(), sort_keys(&m[k]))).collect())
        }
        Value::Array(a) => Value::Array(a.iter().map(sort_keys).collect()),
        other => other.clone(),
    }
}

/// Python truthiness of a JSON value.
fn truthy(p: &Value) -> bool {
    match p {
        Value::Object(m) => !m.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64() != Some(0.0),
    }
}

struct Check {
    name: &'static str,
    status: &'static str,
    detail: String,
}

pub fn cmd_health(ns: &Ns) {
    let port = resolve_port(ns_int(ns, "port"), None);
    let bind_host = resolve_host(ns_str(ns, "host"), None);
    let host = display_host(&bind_host);
    let addresses = server_addresses(&bind_host, port);
    let alive = find_pids();
    let mut checks: Vec<Check> = vec![];
    let c = |name, status, detail: String| Check { name, status, detail };
    if alive.is_empty() {
        checks.push(c("Process", "fail", "not running".into()));
    } else {
        let pids: Vec<String> = alive.iter().map(|p| p.to_string()).collect();
        checks.push(c("Process", "ok", format!("running; pid {}", pids.join(", "))));
    }
    if is_port_reachable(&host, port) {
        checks.push(c("Port", "ok", format!("{host}:{port} accepts connections")));
    } else {
        checks.push(c("Port", "fail", format!("{host}:{port} is not reachable")));
    }
    let (live_status, live_payload) = fetch_json(&host, port, "/api/health/live");
    if live_status == 200 {
        let version = live_payload.as_ref().and_then(|p| p.get("version")).filter(|v| truthy(v));
        let suffix = version.map(|v| format!(" · v{}", v.as_str().map(String::from).unwrap_or_else(|| appv3_core::pyjson::dumps(v)))).unwrap_or_default();
        checks.push(c("API live", "ok", format!("live endpoint ok{suffix}")));
    } else {
        checks.push(c("API live", "fail", "no healthy /api/health/live response".into()));
    }
    let (ready_status, ready_payload) = fetch_json(&host, port, "/api/health/ready");
    if ready_status == 200 {
        checks.push(c("API ready", "ok", "database and runtime checks passed".into()));
    } else if ready_status != 0 {
        let truthy = ready_payload.as_ref().is_some_and(truthy);
        let detail = if truthy { appv3_core::pyjson::dumps(&sort_keys(ready_payload.as_ref().unwrap())) } else { "readiness degraded".into() };
        checks.push(c("API ready", "warn", detail));
    } else {
        checks.push(c("API ready", "fail", "no /api/health/ready response".into()));
    }
    if bind_host == "0.0.0.0" {
        if addresses.lan.is_empty() {
            checks.push(c("LAN binding", "warn", "bound to all interfaces, but no LAN IP was detected".into()));
        } else {
            checks.push(c("LAN binding", "ok", addresses.lan.join(", ")));
        }
    } else {
        checks.push(c("LAN binding", "warn", "local-only; use openagentd server start --host 0.0.0.0 for mobile".into()));
    }

    println!();
    println!("  {}", bold(&cyan("OpenAgentd server health")));
    println!();
    println!("  {}  {}", dim("Local:"), bold(&addresses.local));
    if let Some(lan) = addresses.lan.first() {
        println!("  {}    {}", dim("LAN:"), green(lan));
    }
    println!("  {}   {}", dim("Logs:"), server_log().display());
    println!();
    for ch in &checks {
        let marker = match ch.status {
            "ok" => green("✓"),
            "warn" => yellow("⚠"),
            _ => red("✗"),
        };
        println!("  {marker}  {}  {}", bold(ch.name), dim(&ch.detail));
    }
    println!();
    let failures = checks.iter().filter(|c| c.status == "fail").count();
    let warnings = checks.iter().filter(|c| c.status == "warn").count();
    if failures > 0 {
        if warnings > 0 {
            println!("  {}, {}", red(&format!("{failures} failed")), yellow(&format!("{warnings} warning(s)")));
        } else {
            println!("  {}", red(&format!("{failures} failed")));
        }
        system_exit_code(1);
    }
    if warnings > 0 {
        println!("  {}, {}", green("healthy"), yellow(&format!("{warnings} warning(s)")));
    } else {
        println!("  {}", green("healthy"));
    }
    println!();
}

/// `raise SystemExit(<int>)`.
pub fn system_exit_code(code: i32) -> ! {
    use std::io::Write;
    let _ = std::io::stdout().flush();
    std::process::exit(code)
}

pub fn cmd_logs(ns: &Ns) {
    let log = server_log();
    if log.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            let lines = ns_int(ns, "lines").unwrap_or(50);
            let err = std::process::Command::new("tail").arg0("tail").arg(format!("-n{lines}")).arg("-f").arg(&log).exec();
            uncaught("FileNotFoundError", &format!("[Errno 2] No such file or directory: 'tail' ({err})"));
        }
        #[cfg(not(unix))]
        {
            let lines = ns_int(ns, "lines").unwrap_or(50).max(0) as usize;
            follow_log(&log, lines);
        }
    }
    eprintln!("  No log file found. Start the server with {} first.", bold("openagentd"));
    std::process::exit(1)
}

/// `tail -n <lines> -f <path>` for platforms without `tail`. Runs until killed.
#[cfg(not(unix))]
fn follow_log(path: &std::path::Path, lines: usize) -> ! {
    use std::io::{Read, Seek, SeekFrom, Write};
    let mut out = std::io::stdout();
    let data = std::fs::read(path).unwrap_or_default();
    let start = tail_start(&data, lines);
    let _ = out.write_all(&data[start..]);
    let _ = out.flush();
    let mut pos = data.len() as u64;
    loop {
        std::thread::sleep(Duration::from_millis(250));
        let Ok(mut f) = std::fs::File::open(path) else { continue };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        if len < pos {
            pos = 0; // truncated or rotated
        }
        if len > pos && f.seek(SeekFrom::Start(pos)).is_ok() {
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_ok() {
                pos += buf.len() as u64;
                let _ = out.write_all(&buf);
                let _ = out.flush();
            }
        }
    }
}

/// Byte offset where the last `lines` lines of `data` begin (`tail -n`).
#[cfg_attr(unix, allow(dead_code))]
fn tail_start(data: &[u8], lines: usize) -> usize {
    if lines == 0 {
        return data.len();
    }
    let body = data.strip_suffix(b"\n").unwrap_or(data);
    let mut seen = 0;
    for (i, &b) in body.iter().enumerate().rev() {
        if b == b'\n' {
            seen += 1;
            if seen == lines {
                return i + 1;
            }
        }
    }
    0
}

#[cfg(test)]
mod tail_tests {
    use super::tail_start;

    #[test]
    fn tail_start_matches_tail_n() {
        let d = b"a\nb\nc\n";
        assert_eq!(&d[tail_start(d, 2)..], b"b\nc\n");
        assert_eq!(&d[tail_start(d, 5)..], b"a\nb\nc\n");
        assert_eq!(&d[tail_start(d, 0)..], b"");
        let e = b"a\nb";
        assert_eq!(&e[tail_start(e, 1)..], b"b");
    }
}
