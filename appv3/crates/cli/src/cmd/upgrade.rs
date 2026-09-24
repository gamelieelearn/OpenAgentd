//! `openagentd upgrade` — stop the server, update, restart it (as
//! `app/cli/commands/upgrade.py`). Homebrew installs run `brew upgrade`;
//! every other install updates itself from the GitHub release archives
//! (`self_update`). v2's uv/pipx/pip paths are gone: v3 is not on PyPI, so
//! they would install the old Python package.

use crate::argparse::Ns;
use crate::cmd::self_update::{self, Outcome};
use crate::cmd::server::{cmd_stop, ns_int, ns_str, system_exit_code};
use crate::paths::find_pids;
use crate::ui::{bold, cyan, dim, green};
use std::process::{Command, Stdio};
use std::time::Duration;

use appv3_core::which::which;

/// `subprocess.run(cmd, capture_output=True, timeout=5)` → `(code, stdout)`.
fn capture(cmd: &[&str]) -> Option<(i32, String)> {
    let mut child = Command::new(cmd[0]).args(&cmd[1..]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().ok()?;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(Some(_)) = child.try_wait() {
            let out = child.wait_with_output().ok()?;
            return Some((out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stdout).into_owned()));
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            return None;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn is_brew_managed() -> bool {
    let Some(brew) = which("brew") else { return false };
    let exe = std::env::current_exe().ok().and_then(|p| dunce::canonicalize(p).ok()).unwrap_or_default();
    let parts: Vec<String> = exe.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    if parts.iter().any(|p| p == "Cellar") || (parts.iter().any(|p| p == "Homebrew") && parts.iter().any(|p| p == "opt")) {
        return true;
    }
    capture(&[&brew.to_string_lossy(), "list", "--formula", "openagentd"]).is_some_and(|(c, _)| c == 0)
}

/// `brew upgrade` (after `brew update`); returns the exit code.
fn brew_upgrade() -> i32 {
    let pre = vec!["brew".to_string(), "update".to_string()];
    println!("  {}", dim(&pre.join(" ")));
    let code = run(&pre);
    if code != 0 {
        return code;
    }
    let cmd: Vec<String> = ["brew", "upgrade", "--formula", "lthoangg/tap/openagentd"].iter().map(|s| s.to_string()).collect();
    println!("  {}", dim(&cmd.join(" ")));
    run(&cmd)
}

/// Update this binary from the release archives; returns the exit code.
fn release_upgrade(exe: &std::path::Path) -> i32 {
    let Some(dir) = exe.parent() else { return 1 };
    self_update::cleanup_old(dir);
    let base = self_update::releases_base();
    println!("  {}", dim(&format!("{base}/latest → {}", self_update::target_triple())));
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("tokio runtime");
    match rt.block_on(self_update::update(&base, appv3_core::VERSION, dir)) {
        Ok(Outcome::UpToDate(v)) => {
            println!("  {} (v{v})", green("Already up to date"));
            0
        }
        Ok(Outcome::Updated { from, to }) => {
            println!("  {} v{from} → v{to} ({})", green("Updated"), dir.display());
            0
        }
        Err(e) => {
            eprintln!("  Upgrade failed: {e:#}");
            1
        }
    }
}

fn restart_command(ns: &Ns) -> Vec<String> {
    let exe = which("openagentd")
        .map(|p| p.to_string_lossy().into_owned())
        .or_else(|| std::env::args().next().filter(|a| std::path::Path::new(a).is_file()))
        .unwrap_or_else(|| "openagentd".into());
    let mut cmd = vec![exe, "server".into(), "start".into()];
    if let Some(h) = ns_str(ns, "host").filter(|h| !h.is_empty()) {
        cmd.extend(["--host".into(), h.into()]);
    }
    if let Some(p) = ns_int(ns, "port") {
        cmd.extend(["--port".into(), p.to_string()]);
    }
    cmd
}

/// `subprocess.run(cmd).returncode` (negative for signals; missing binary raises).
fn run(cmd: &[String]) -> i32 {
    match Command::new(&cmd[0]).args(&cmd[1..]).status() {
        Ok(s) => {
            #[cfg(unix)]
            {
                use std::os::unix::process::ExitStatusExt;
                s.code().unwrap_or_else(|| -s.signal().unwrap_or(1))
            }
            #[cfg(not(unix))]
            {
                s.code().unwrap_or(1)
            }
        }
        Err(e) => crate::pystr::uncaught("FileNotFoundError", &format!("[Errno 2] No such file or directory: {} ({e})", crate::argparse::py_repr(&cmd[0]))),
    }
}

pub fn cmd_upgrade(ns: &Ns) {
    let exe = std::env::current_exe().ok().and_then(|p| dunce::canonicalize(p).ok()).unwrap_or_default();
    if self_update::is_desktop_bundled(&exe) {
        println!("  This openagentd is bundled with the desktop app, which updates it (Settings → About).");
        return;
    }
    let was_running = !find_pids().is_empty();
    if was_running {
        println!("  {} before upgrade ...", bold("Stopping openagentd"));
        cmd_stop(ns);
    }
    let manager = if is_brew_managed() { "brew" } else { "GitHub releases" };
    println!("  {} via {} ...", bold("Upgrading openagentd"), cyan(manager));
    let code = if manager == "brew" { brew_upgrade() } else { release_upgrade(&exe) };
    let mut restart_code = 0;
    if was_running {
        let restart = restart_command(ns);
        if code == 0 {
            println!("  {} ...", bold("Restarting openagentd"));
        } else {
            println!("  {} after failed upgrade ...", bold("Restarting openagentd"));
        }
        println!("  {}", dim(&restart.join(" ")));
        restart_code = run(&restart);
    }
    if code != 0 {
        system_exit_code(code & 0xff);
    }
    if restart_code != 0 {
        system_exit_code(restart_code & 0xff);
    }
}
