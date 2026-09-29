//! Terminal output: colours, aligned fields, check lines, the start banner,
//! and the hidden-input prompt for secrets.

use std::io::IsTerminal;
use std::path::Path;
use std::sync::OnceLock;

/// Colour is off with `NO_COLOR` or `TERM=dumb`, and when not on a terminal.
fn color_allowed() -> bool {
    std::env::var_os("NO_COLOR").is_none_or(|v| v.is_empty()) && std::env::var("TERM").map_or(true, |t| t != "dumb")
}

/// Whether stdout gets ANSI colours.
pub fn color() -> bool {
    static C: OnceLock<bool> = OnceLock::new();
    *C.get_or_init(|| color_allowed() && std::io::stdout().is_terminal())
}

fn paint(code: &str, t: &str) -> String {
    if color() {
        format!("\x1b[{code}m{t}\x1b[0m")
    } else {
        t.to_string()
    }
}

pub fn dim(t: &str) -> String {
    paint("2", t)
}
pub fn bold(t: &str) -> String {
    paint("1", t)
}
pub fn cyan(t: &str) -> String {
    paint("36", t)
}
pub fn green(t: &str) -> String {
    paint("32", t)
}
pub fn red(t: &str) -> String {
    paint("31", t)
}
pub fn yellow(t: &str) -> String {
    paint("33", t)
}

/// `  Label:  value` with labels padded to one column.
pub fn field(label: &str, value: &str) {
    println!("  {}{value}", dim(&format!("{label:<9}")));
}

/// `error: msg` on stderr (red on a terminal).
pub fn print_error(msg: &str) {
    let prefix = if color_allowed() && std::io::stderr().is_terminal() { "\x1b[1;31merror:\x1b[0m" } else { "error:" };
    eprintln!("{prefix} {msg}");
}

/// A path with the home directory shown as `~`.
pub fn tilde(p: &Path) -> String {
    let s = p.display().to_string();
    match appv3_core::home::home_dir_opt().map(|h| h.display().to_string()).filter(|h| !h.is_empty() && s.starts_with(h.as_str())) {
        Some(h) => format!("~{}", &s[h.len()..]),
        None => s,
    }
}

/// ✓ / ⚠ / ✗ lines with a summary (`doctor`, `server status`).
#[derive(Default)]
pub struct Checks {
    pub passed: usize,
    pub warnings: usize,
    pub failures: usize,
}

impl Checks {
    pub fn ok(&mut self, msg: &str) {
        self.passed += 1;
        println!("  {}  {msg}", green("✓"));
    }
    pub fn warn(&mut self, msg: &str) {
        self.warnings += 1;
        println!("  {}  {msg}", yellow("⚠"));
    }
    pub fn fail(&mut self, msg: &str) {
        self.failures += 1;
        println!("  {}  {msg}", red("✗"));
    }
    /// `3 passed, 1 warning, 2 failed`.
    pub fn summary(&self) -> String {
        let plural = |n: usize| if n == 1 { "" } else { "s" };
        let mut parts = vec![green(&format!("{} passed", self.passed))];
        if self.warnings > 0 {
            parts.push(yellow(&format!("{} warning{}", self.warnings, plural(self.warnings))));
        }
        if self.failures > 0 {
            parts.push(red(&format!("{} failed", self.failures)));
        }
        parts.join(", ")
    }
}

const WORDMARK: &str = concat!(
    " _____             _____             _     _ \n",
    "|     |___ ___ ___|  _  |___ ___ ___| |_ _| |\n",
    "|  |  | . | -_|   |     | . | -_|   |  _| . |\n",
    "|_____|  _|___|_|_|__|__|_  |___|_|_|_| |___|\n",
    "      |_|               |___|"
);

/// The `server start` banner. The server is API-only, so the URL is what the
/// desktop or mobile app connects to.
pub fn print_banner(host: &str, port: u16) {
    println!();
    if color() {
        for line in WORDMARK.lines() {
            println!("  {}", cyan(line));
        }
        println!();
        println!("  {}", dim(&format!("v{}", appv3_core::VERSION)));
    } else {
        println!("  OpenAgentd v{}", appv3_core::VERSION);
    }
    field("Server:", &bold(&format!("http://{host}:{port}")));
}

/// Read a line from the terminal without echo (stdin if there is none).
pub fn read_secret(prompt: &str) -> anyhow::Result<String> {
    use std::io::{BufRead, Write};
    let eof = || anyhow::anyhow!("no input");
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        if let Ok(tty) = std::fs::OpenOptions::new().read(true).write(true).open("/dev/tty") {
            let fd = tty.as_raw_fd();
            let mut old: libc::termios = unsafe { std::mem::zeroed() };
            if unsafe { libc::tcgetattr(fd, &mut old) } == 0 {
                let mut quiet = old;
                quiet.c_lflag &= !libc::ECHO;
                let mut w = &tty;
                unsafe { libc::tcsetattr(fd, libc::TCSAFLUSH, &quiet) };
                let _ = w.write_all(prompt.as_bytes());
                let _ = w.flush();
                let mut line = String::new();
                let n = std::io::BufReader::new(&tty).read_line(&mut line);
                unsafe { libc::tcsetattr(fd, libc::TCSAFLUSH, &old) };
                let _ = w.write_all(b"\n");
                if matches!(n, Ok(0) | Err(_)) {
                    return Err(eof());
                }
                return Ok(line.trim_end_matches(['\r', '\n']).to_string());
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
                if matches!(n, Ok(0) | Err(_)) {
                    return Err(eof());
                }
                return Ok(line.trim_end_matches(['\r', '\n']).to_string());
            }
        }
    }
    eprintln!("warning: no terminal; the input may be echoed");
    eprint!("{prompt}");
    let mut line = String::new();
    if matches!(std::io::stdin().lock().read_line(&mut line), Ok(0) | Err(_)) {
        return Err(eof());
    }
    Ok(line.trim_end_matches(['\r', '\n']).to_string())
}
