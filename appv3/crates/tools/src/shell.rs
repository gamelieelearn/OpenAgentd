//! `shell` — port of `builtin/shell.py` + `shell_runtime.py`.

use crate::args::Args;
use crate::{Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use regex::bytes::Regex as BRegex;
use serde_json::Value;
use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::AsyncReadExt;

pub const DEFAULT_TIMEOUT_SECONDS: u64 = 120;
const POST_KILL_WAIT: Duration = Duration::from_secs(5);
const TERM_GRACE: Duration = Duration::from_secs(2);
const OUTPUT_MAX_LINES: usize = 300;
const OUTPUT_MAX_BYTES: usize = 131_072;
const SPILL_MAX_BYTES: usize = 10 * 1024 * 1024;
const STREAM_INTERVAL: Duration = Duration::from_millis(500);
const LIVE_MAX_CHARS: usize = 100_000;
const LIVE_MAX_LINES: usize = 100;
const LIVE_TRUNCATED: &str = "... [truncated live output] ...\n";
pub const LEAK_KEYS: &[&str] =
    &["PYTHONPATH", "PYTHONHOME", "PYTHONEXECUTABLE", "PYTHONUSERBASE", "PYTHONSTARTUP", "VIRTUAL_ENV", "VIRTUAL_ENV_PROMPT", "UV_PYTHON", "UV_PROJECT_ENVIRONMENT"];
const BLACKLIST: &[&str] = &["fish", "nu", "nushell"];

pub fn shell_name_of(path: &str) -> String {
    let base = path.rsplit(['/', '\\']).next().unwrap_or(path);
    base.split('.').next().unwrap_or(base).to_lowercase()
}

fn which(name: &str) -> Option<String> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(name)).find(|p| p.is_file()).map(|p| p.display().to_string())
}

/// v2 `shell_runtime.acceptable()`.
pub fn acceptable() -> String {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        if cfg!(windows) {
            return ["pwsh", "powershell", "cmd"].iter().find_map(|n| which(n)).unwrap_or_else(|| "cmd.exe".into());
        }
        if let Ok(env_shell) = std::env::var("SHELL") {
            if !env_shell.is_empty() && !BLACKLIST.contains(&shell_name_of(&env_shell).as_str()) {
                let usable = if Path::new(&env_shell).is_absolute() { Path::new(&env_shell).is_file() } else { which(&env_shell).is_some() };
                if usable {
                    return env_shell;
                }
            }
        }
        if cfg!(target_os = "macos") {
            return "/bin/zsh".into();
        }
        ["zsh", "bash", "sh"].iter().find_map(|n| which(n)).unwrap_or_else(|| "/bin/sh".into())
    })
    .clone()
}

pub fn environment_summary() -> String {
    let os = match std::env::consts::OS {
        "macos" => "Darwin",
        "linux" => "Linux",
        "windows" => "Windows",
        o => o,
    };
    let arch = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "arm64",
        ("windows", "x86_64") => "AMD64",
        (_, a) => a,
    };
    format!("Environment: {os} {arch}, shell={}.", shell_name_of(&acceptable()))
}

pub fn build_argv(shell_bin: &str, command: &str) -> Vec<String> {
    match shell_name_of(shell_bin).as_str() {
        "pwsh" | "powershell" => vec!["-NoLogo".into(), "-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), command.into()],
        "cmd" => vec!["/d".into(), "/s".into(), "/c".into(), command.into()],
        "zsh" => vec![
            "-l".into(),
            "-c".into(),
            "[[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true; [[ -f \"${ZDOTDIR:-$HOME}/.zshrc\" ]] && source \"${ZDOTDIR:-$HOME}/.zshrc\" >/dev/null 2>&1 || true; unset HISTFILE; HISTSIZE=0; SAVEHIST=0; unsetopt appendhistory incappendhistory sharehistory 2>/dev/null; eval \"$1\"".into(),
            "openagentd".into(),
            command.into(),
        ],
        "bash" => vec![
            "-l".into(),
            "-c".into(),
            "shopt -s expand_aliases; [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true; unset HISTFILE; HISTSIZE=0; HISTFILESIZE=0; set +o history 2>/dev/null; eval \"$1\"".into(),
            "openagentd".into(),
            command.into(),
        ],
        _ => vec!["-c".into(), command.into()],
    }
}

fn ansi_rx() -> &'static BRegex {
    static R: OnceLock<BRegex> = OnceLock::new();
    R.get_or_init(|| BRegex::new(r"(?s-u)\x1b(?:\[[0-?]*[ -/]*[@-~]|\].*?(?:\x07|\x1b\\)|[@-Z\\-_])").unwrap())
}

pub fn strip_ansi_bytes(b: &[u8]) -> Vec<u8> {
    ansi_rx().replace_all(b, &b""[..]).into_owned()
}

pub fn strip_ansi(s: &str) -> String {
    String::from_utf8_lossy(&strip_ansi_bytes(s.as_bytes())).into_owned()
}

fn decode_ignore(b: &[u8]) -> String {
    // utf-8 decode with errors="ignore" at the cut edges
    let s = String::from_utf8_lossy(b);
    s.trim_start_matches('\u{FFFD}').trim_end_matches('\u{FFFD}').to_string()
}

/// v2 `_tail_text`.
pub fn tail_text(text: &str, max_lines: usize, max_bytes: usize) -> (String, bool) {
    let lines: Vec<&str> = text.split('\n').collect();
    if lines.len() <= max_lines && text.len() <= max_bytes {
        return (text.to_string(), false);
    }
    let mut text = text.to_string();
    if lines.len() > max_lines {
        let head = max_lines / 2;
        let tail = max_lines - head;
        let omitted = lines.len() - head - tail;
        let mut v: Vec<String> = lines[..head].iter().map(|s| s.to_string()).collect();
        v.push(format!("...output truncated ({omitted} lines omitted)..."));
        v.extend(lines[lines.len() - tail..].iter().map(|s| s.to_string()));
        text = v.join("\n");
    }
    let enc = text.as_bytes();
    if enc.len() <= max_bytes {
        return (text, true);
    }
    let probe = b"\n...output truncated (000000000 bytes omitted)...\n".len();
    if max_bytes <= probe {
        return (decode_ignore(&enc[enc.len() - max_bytes..]), true);
    }
    let content = max_bytes - probe;
    let hb = content / 2;
    let tb = content - hb;
    let omitted = enc.len() - hb - tb;
    (format!("{}\n...output truncated ({omitted} bytes omitted)...\n{}", decode_ignore(&enc[..hb]), decode_ignore(&enc[enc.len() - tb..])), true)
}

fn live_window(text: &str) -> (String, bool) {
    let mut t = text.to_string();
    let mut cut = false;
    if t.matches('\n').count() > LIVE_MAX_LINES {
        let mut idx = t.len();
        let mut found = true;
        for _ in 0..LIVE_MAX_LINES {
            match t[..idx].rfind('\n') {
                Some(i) => idx = i,
                None => {
                    found = false;
                    break;
                }
            }
        }
        if found {
            t = t[idx + 1..].to_string();
            cut = true;
        }
    }
    let n = t.chars().count();
    if n > LIVE_MAX_CHARS {
        t = t.chars().skip(n - LIVE_MAX_CHARS).collect();
        cut = true;
    }
    (t, cut)
}

struct Collector {
    total: usize,
    head: Vec<u8>,
    tail: VecDeque<Vec<u8>>,
    tail_bytes: usize,
    spill_dir: PathBuf,
    spill_path: Option<PathBuf>,
    file: Option<std::fs::File>,
    spill_bytes: usize,
    capped: bool,
    failed: bool,
}

impl Collector {
    fn new(spill_dir: PathBuf) -> Self {
        Self { total: 0, head: vec![], tail: VecDeque::new(), tail_bytes: 0, spill_dir, spill_path: None, file: None, spill_bytes: 0, capped: false, failed: false }
    }
    fn dest(&self) -> std::io::Result<PathBuf> {
        std::fs::create_dir_all(&self.spill_dir)?;
        Ok(self.spill_dir.join(format!("{}.txt", &uuid::Uuid::new_v4().to_string()[..8])))
    }
    fn write_spill(&mut self, payload: &[u8]) {
        let remaining = SPILL_MAX_BYTES.saturating_sub(self.spill_bytes);
        if remaining == 0 {
            self.capped = true;
            return;
        }
        let take = payload.len().min(remaining);
        if let Some(f) = self.file.as_mut() {
            if f.write_all(&payload[..take]).is_err() {
                self.file = None;
                self.failed = true;
                return;
            }
        }
        self.spill_bytes += take;
        if payload.len() > remaining {
            self.capped = true;
        }
    }
    fn add(&mut self, chunk: &[u8]) {
        self.total += chunk.len();
        let mut rest = chunk;
        if self.head.len() < OUTPUT_MAX_BYTES {
            let take = chunk.len().min(OUTPUT_MAX_BYTES - self.head.len());
            self.head.extend_from_slice(&chunk[..take]);
            rest = &chunk[take..];
        }
        if rest.is_empty() {
            return;
        }
        if self.file.is_none() && !self.failed {
            match self.dest().and_then(|d| std::fs::File::create(&d).map(|f| (d, f))) {
                Ok((d, f)) => {
                    self.file = Some(f);
                    self.spill_path = Some(d);
                    let h = strip_ansi_bytes(&self.head);
                    self.write_spill(&h);
                }
                Err(_) => self.failed = true,
            }
        }
        if self.file.is_some() {
            let p = strip_ansi_bytes(rest);
            self.write_spill(&p);
        }
        self.tail.push_back(rest.to_vec());
        self.tail_bytes += rest.len();
        while self.tail_bytes > OUTPUT_MAX_BYTES && self.tail.len() > 1 {
            self.tail_bytes -= self.tail.pop_front().unwrap().len();
        }
    }
    fn inline(&self) -> (String, bool) {
        let tail: Vec<u8> = self.tail.iter().flatten().copied().collect();
        let dropped = self.total as i64 - self.head.len() as i64 - self.tail_bytes as i64;
        if dropped <= 0 {
            let mut all = self.head.clone();
            all.extend_from_slice(&tail);
            return tail_text(&strip_ansi(&String::from_utf8_lossy(&all)), OUTPUT_MAX_LINES, OUTPUT_MAX_BYTES);
        }
        let combined =
            format!("{}\n...output truncated ({dropped} bytes omitted)...\n{}", strip_ansi(&String::from_utf8_lossy(&self.head)), strip_ansi(&String::from_utf8_lossy(&tail)));
        (tail_text(&combined, OUTPUT_MAX_LINES, OUTPUT_MAX_BYTES).0, true)
    }
    fn finalize(&mut self) -> (String, bool) {
        self.file = None;
        let (inline, cut) = self.inline();
        if cut && self.spill_path.is_none() && !self.failed {
            if let Ok(d) = self.dest() {
                let mut all = self.head.clone();
                all.extend(self.tail.iter().flatten());
                let payload = strip_ansi_bytes(&all);
                if std::fs::write(&d, &payload[..payload.len().min(SPILL_MAX_BYTES)]).is_ok() {
                    self.capped = payload.len() > SPILL_MAX_BYTES;
                    self.spill_path = Some(d);
                }
            }
        }
        (inline, cut)
    }
}

#[cfg(unix)]
fn descendants(root: i32) -> Vec<i32> {
    let out = std::process::Command::new("ps").args(["-Ao", "pid=,ppid="]).output();
    let Ok(out) = out else { return vec![] };
    let text = String::from_utf8_lossy(&out.stdout);
    let mut children: std::collections::HashMap<i32, Vec<i32>> = Default::default();
    for line in text.lines() {
        let p: Vec<&str> = line.split_whitespace().collect();
        if p.len() == 2 {
            if let (Ok(a), Ok(b)) = (p[0].parse(), p[1].parse()) {
                children.entry(b).or_default().push(a);
            }
        }
    }
    let mut res = vec![];
    let mut frontier = vec![root];
    while !frontier.is_empty() {
        let mut next = vec![];
        for pid in frontier {
            for c in children.get(&pid).cloned().unwrap_or_default() {
                res.push(c);
                next.push(c);
            }
        }
        frontier = next;
    }
    res
}

#[cfg(unix)]
async fn kill_group(pid: u32, sig: nix::sys::signal::Signal) {
    use nix::sys::signal::{kill, killpg};
    use nix::unistd::Pid;
    let pid = pid as i32;
    let desc = tokio::task::spawn_blocking(move || descendants(pid)).await.unwrap_or_default();
    let _ = killpg(Pid::from_raw(pid), sig);
    for d in desc {
        let _ = kill(Pid::from_raw(d), sig);
    }
    let _ = kill(Pid::from_raw(pid), sig);
}

#[cfg(not(unix))]
async fn kill_group(pid: u32, _sig: ()) {
    let _ = tokio::process::Command::new("taskkill").args(["/PID", &pid.to_string(), "/T", "/F"]).status().await;
}

fn format_exit_code(code: Option<i32>, signal: Option<i32>) -> String {
    if let Some(s) = signal {
        let name = match s {
            1 => "SIGHUP",
            2 => "SIGINT",
            3 => "SIGQUIT",
            6 => "SIGABRT",
            9 => "SIGKILL",
            11 => "SIGSEGV",
            13 => "SIGPIPE",
            15 => "SIGTERM",
            _ => "",
        };
        return if name.is_empty() { format!("{}", 128 + s) } else { format!("{} ({name})", 128 + s) };
    }
    code.map(|c| c.to_string()).unwrap_or_else(|| "unknown".into())
}

fn scrubbed_env(cmd: &mut tokio::process::Command) {
    for k in LEAK_KEYS {
        cmd.env_remove(k);
    }
}

/// Kills the foreground process group if the tool future is cancelled
/// (v2: `CancelledError` → SIGKILL the group before propagating).
struct GroupGuard {
    pid: u32,
    armed: bool,
}

impl Drop for GroupGuard {
    fn drop(&mut self) {
        if !self.armed || self.pid == 0 {
            return;
        }
        #[cfg(unix)]
        {
            use nix::sys::signal::{killpg, Signal};
            let _ = killpg(nix::unistd::Pid::from_raw(self.pid as i32), Signal::SIGKILL);
        }
        #[cfg(not(unix))]
        {
            let _ = std::process::Command::new("taskkill").args(["/PID", &self.pid.to_string(), "/T", "/F"]).status();
        }
    }
}

pub struct ShellTool;

#[async_trait]
impl Tool for ShellTool {
    fn name(&self) -> &str {
        "shell"
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let mut a = Args::new("shell", &args);
        let command = a.req_str(&["command", "cmd"]);
        let description = a.str_or(&["description"], "");
        let workdir = a.opt_str(&["workdir", "cwd", "dir"]);
        let timeout_s = a.opt_int(&["timeout_seconds"], Some(1), None).map(|n| n as u64).unwrap_or(DEFAULT_TIMEOUT_SECONDS);
        let background = a.bool_or(&["background"], false);
        a.finish()?;
        if let Some(hit) = ctx.denied.check_command(&command) {
            return Err(ToolError::Execution(format!("Sandbox blocked 'shell': command would touch denied path or pattern '{hit}'.")));
        }
        let cwd = match &workdir {
            None => ctx.denied.workspace_root.clone(),
            Some(w) => {
                let expanded = if let Some(rest) = w.strip_prefix("~") { format!("{}{}", std::env::var("HOME").unwrap_or_default(), rest) } else { w.clone() };
                ctx.denied.validate_path(&expanded)?
            }
        };
        let shell_bin = acceptable();
        let desc_tag = if description.is_empty() { String::new() } else { format!(" ({description})") };
        tracing::info!(
            "shell_execute_start shell={} command={} cwd={} timeout={} background={}{}",
            shell_name_of(&shell_bin),
            command.chars().take(200).collect::<String>(),
            cwd.display(),
            timeout_s,
            background,
            desc_tag
        );
        if command.trim().is_empty() {
            return Ok(ToolOutput::text("[Succeeded]\n\n"));
        }
        let argv = build_argv(&shell_bin, &command);
        let mut cmd = tokio::process::Command::new(&shell_bin);
        cmd.args(&argv).current_dir(&cwd).stdin(std::process::Stdio::null());
        scrubbed_env(&mut cmd);
        #[cfg(unix)]
        cmd.process_group(0);
        if background {
            cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
            let child = cmd.spawn().map_err(|e| ToolError::Execution(format!("Command execution failed: {e}")))?;
            let pid = child.id().unwrap_or(0);
            tracing::info!("shell_background_started pid={} command={}", pid, command.chars().take(200).collect::<String>());
            // detach: reap in background
            tokio::spawn(async move {
                let mut c = child;
                let _ = c.wait().await;
            });
            return Ok(ToolOutput::Text(format!("PID: {pid}")));
        }
        // stdout+stderr merged via a single pipe
        let (reader, writer) = os_pipe::pipe().map_err(|e| ToolError::Execution(format!("Command execution failed: {e}")))?;
        let writer2 = writer.try_clone().map_err(|e| ToolError::Execution(format!("Command execution failed: {e}")))?;
        cmd.stdout(writer).stderr(writer2);
        let mut child = cmd.spawn().map_err(|e| ToolError::Execution(format!("Command execution failed: {e}")))?;
        drop(cmd); // closes our copies of the write ends
        let pid = child.id().unwrap_or(0);
        let mut group_guard = GroupGuard { pid, armed: true };
        let mut out = tokio::fs::File::from_std(unsafe_file_from_reader(reader));
        let spill_dir = ctx.artifacts_dir().join(".tool_results").join("shell");
        let collector = Arc::new(Mutex::new(Collector::new(spill_dir)));
        let pending = Arc::new(Mutex::new(String::new()));
        let sink = ctx.output.clone();
        let flush = {
            let pending = pending.clone();
            let sink = sink.clone();
            move || {
                let text = std::mem::take(&mut *pending.lock().unwrap());
                if let (Some(s), false) = (&sink, text.is_empty()) {
                    let t = strip_ansi(&text);
                    if !t.is_empty() {
                        let (w, cut) = live_window(&t);
                        s(if cut { format!("{LIVE_TRUNCATED}{w}") } else { w });
                    }
                }
            }
        };
        let flusher = {
            let flush = flush.clone();
            tokio::spawn(async move {
                loop {
                    tokio::time::sleep(STREAM_INTERVAL).await;
                    flush();
                }
            })
        };
        let read_all = {
            let collector = collector.clone();
            let pending = pending.clone();
            async move {
                let mut buf = vec![0u8; 8192];
                loop {
                    match out.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            collector.lock().unwrap().add(&buf[..n]);
                            let mut p = pending.lock().unwrap();
                            p.push_str(&String::from_utf8_lossy(&buf[..n]));
                            if p.chars().count() > 2 * LIVE_MAX_CHARS {
                                let (kept, _) = live_window(&p);
                                *p = format!("{LIVE_TRUNCATED}{kept}");
                            }
                        }
                    }
                }
                out
            }
        };
        let mut aborted = false;
        let status = match tokio::time::timeout(Duration::from_secs(timeout_s), async {
            let out = read_all.await;
            let st = child.wait().await;
            (out, st)
        })
        .await
        {
            Ok((_out, st)) => st.ok(),
            Err(_) => {
                #[cfg(unix)]
                {
                    kill_group(pid, nix::sys::signal::Signal::SIGTERM).await;
                    if tokio::time::timeout(TERM_GRACE, child.wait()).await.is_err() {
                        kill_group(pid, nix::sys::signal::Signal::SIGKILL).await;
                    }
                }
                #[cfg(not(unix))]
                kill_group(pid, ()).await;
                aborted = true;
                tokio::time::timeout(POST_KILL_WAIT, child.wait()).await.ok().and_then(|r| r.ok())
            }
        };
        flusher.abort();
        flush();
        group_guard.armed = false;
        let (code, signal) = match status {
            Some(s) => {
                #[cfg(unix)]
                {
                    use std::os::unix::process::ExitStatusExt;
                    (s.code(), s.signal())
                }
                #[cfg(not(unix))]
                {
                    (s.code(), None)
                }
            }
            None => (Some(0), None),
        };
        let mut col = collector.lock().unwrap();
        tracing::info!("shell_execute_complete exit_code={:?} output_bytes={}{}", code, col.total, desc_tag);
        let ok = code == Some(0) && signal.is_none();
        let status_line = if !aborted && ok {
            "[Succeeded]".to_string()
        } else if aborted {
            format!("[Timed out after {timeout_s}s]")
        } else {
            format!("[Failed — exit code {}]", format_exit_code(code, signal))
        };
        let (inline, cut) = col.finalize();
        let mut result = if cut {
            match &col.spill_path {
                Some(p) => {
                    format!("{status_line}\n\n...output truncated{} — full output saved to {}\n\n{inline}", if col.capped { " (spill file capped)" } else { "" }, p.display())
                }
                None => format!("{status_line}\n\n...output truncated\n\n{inline}"),
            }
        } else if aborted && inline.trim().is_empty() {
            format!("{status_line}\n\n(No output before timeout)")
        } else if inline.is_empty() {
            status_line
        } else {
            format!("{status_line}\n\n{inline}")
        };
        if aborted {
            result.push_str(&format!(
                "\n\n<shell_metadata>\nCommand timed out after {timeout_s}s. If this command legitimately takes longer, retry with a higher timeout_seconds value.\n</shell_metadata>"
            ));
        }
        Ok(ToolOutput::Text(result))
    }
}

#[cfg(unix)]
fn unsafe_file_from_reader(r: os_pipe::PipeReader) -> std::fs::File {
    use std::os::fd::{FromRawFd, IntoRawFd};
    unsafe { std::fs::File::from_raw_fd(r.into_raw_fd()) }
}

#[cfg(windows)]
fn unsafe_file_from_reader(r: os_pipe::PipeReader) -> std::fs::File {
    use std::os::windows::io::{FromRawHandle, IntoRawHandle};
    unsafe { std::fs::File::from_raw_handle(r.into_raw_handle()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_text_line_cut() {
        let text = (0..400).map(|i| i.to_string()).collect::<Vec<_>>().join("\n");
        let (t, cut) = tail_text(&text, 300, OUTPUT_MAX_BYTES);
        assert!(cut);
        assert!(t.contains("...output truncated (100 lines omitted)..."));
    }

    #[test]
    fn strips_ansi() {
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m"), "red");
    }

    fn ctx(ws: &Path) -> ToolContext {
        ToolContext {
            session_id: None,
            agent_name: "t".into(),
            tool_call_id: "c".into(),
            denied: Arc::new(crate::DeniedPaths::with(ws, None, Some(vec![]), Some(vec![]))),
            workspace: None,
            output: None,
            metadata: Default::default(),
            messages: None,
        }
    }

    #[tokio::test]
    async fn runs_commands_like_v2() {
        let d = tempfile::tempdir().unwrap();
        let c = ctx(d.path());
        let out = ShellTool.run(&c, serde_json::json!({"command": "echo hi; echo err 1>&2"})).await.unwrap();
        assert_eq!(out, ToolOutput::text("[Succeeded]\n\nhi\nerr\n"));
        let out = ShellTool.run(&c, serde_json::json!({"command": "exit 3"})).await.unwrap();
        assert_eq!(out, ToolOutput::text("[Failed — exit code 3]"));
        let out = ShellTool.run(&c, serde_json::json!({"command": "sleep 5", "timeout_seconds": 1})).await.unwrap();
        let ToolOutput::Text(t) = out else { panic!() };
        assert!(t.starts_with("[Timed out after 1s]\n\n(No output before timeout)\n\n<shell_metadata>"), "{t}");
    }
}
