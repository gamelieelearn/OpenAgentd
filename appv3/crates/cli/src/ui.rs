//! `app/cli/ui.py` — ANSI colours (only when stdout is a TTY) and the banner.

use std::sync::OnceLock;

pub fn is_tty() -> bool {
    static T: OnceLock<bool> = OnceLock::new();
    *T.get_or_init(crate::argparse::stdout_isatty)
}

fn c(code: &str, t: &str) -> String {
    if is_tty() {
        format!("\x1b[{code}m{t}\x1b[0m")
    } else {
        t.to_string()
    }
}

pub fn dim(t: &str) -> String {
    c("2", t)
}
pub fn bold(t: &str) -> String {
    c("1", t)
}
pub fn cyan(t: &str) -> String {
    c("36", t)
}
pub fn green(t: &str) -> String {
    c("32", t)
}
pub fn red(t: &str) -> String {
    c("31", t)
}
pub fn yellow(t: &str) -> String {
    c("33", t)
}

const WORDMARK: &str = concat!(
    " _____             _____             _     _ \n",
    "|     |___ ___ ___|  _  |___ ___ ___| |_ _| |\n",
    "|  |  | . | -_|   |     | . | -_|   |  _| . |\n",
    "|_____|  _|___|_|_|__|__|_  |___|_|_|_| |___|\n",
    "      |_|               |___|"
);

/// `_print_banner(host=, port=)`.
pub fn print_banner(host: &str, port: i64) {
    let url = format!("http://{host}:{port}");
    println!();
    if is_tty() {
        for line in WORDMARK.lines() {
            println!("  {}", cyan(line));
        }
        println!();
        println!("  {}", dim(&format!("v{}", appv3_core::VERSION)));
        println!("  {}  {}", dim("Open:"), bold(&url));
    } else {
        println!("  OpenAgentd v{}", appv3_core::VERSION);
        println!("  Open: {url}");
    }
    println!();
}

/// Python f-string `{s:<width}` (pads by code points, escape codes included).
pub fn ljust(s: &str, width: usize) -> String {
    let n = s.chars().count();
    if n >= width {
        s.to_string()
    } else {
        format!("{s}{}", " ".repeat(width - n))
    }
}
