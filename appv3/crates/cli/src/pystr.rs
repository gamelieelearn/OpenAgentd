//! Small Python `str` helpers used by the CLI ports.

/// `str.splitlines()`.
pub fn splitlines(s: &str) -> Vec<&str> {
    let mut out = vec![];
    let mut start = 0;
    let mut it = s.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        let brk = matches!(c, '\n' | '\r' | '\x0b' | '\x0c' | '\x1c' | '\x1d' | '\x1e' | '\u{85}' | '\u{2028}' | '\u{2029}');
        if brk {
            out.push(&s[start..i]);
            let mut end = i + c.len_utf8();
            if c == '\r' {
                if let Some(&(j, '\n')) = it.peek() {
                    it.next();
                    end = j + 1;
                }
            }
            start = end;
        }
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

pub fn is_py_space(c: char) -> bool {
    c.is_whitespace() || ('\x1c'..='\x1f').contains(&c)
}

/// `str.strip()`.
pub fn strip(s: &str) -> &str {
    s.trim_matches(is_py_space)
}

/// First code point of every Unicode `Nd` run (Python 3.14's tables).
const ND_ZEROS: &[u32] = &[
    0x30, 0x660, 0x6f0, 0x7c0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xde6, 0xe50, 0xed0, 0xf20, 0x1040, 0x1090, 0x17e0, 0x1810, 0x1946, 0x19d0, 0x1a80,
    0x1a90, 0x1b50, 0x1bb0, 0x1c40, 0x1c50, 0xa620, 0xa8d0, 0xa900, 0xa9d0, 0xa9f0, 0xaa50, 0xabf0, 0xff10, 0x104a0, 0x10d30, 0x10d40, 0x11066, 0x110f0, 0x11136, 0x111d0, 0x112f0,
    0x11450, 0x114d0, 0x11650, 0x116c0, 0x116d0, 0x116da, 0x11730, 0x118e0, 0x11950, 0x11bf0, 0x11c50, 0x11d50, 0x11da0, 0x11f50, 0x16130, 0x16a60, 0x16ac0, 0x16b50, 0x16d70,
    0x1ccf0, 0x1d7ce, 0x1d7d8, 0x1d7e2, 0x1d7ec, 0x1d7f6, 0x1e140, 0x1e2f0, 0x1e4f0, 0x1e5f1, 0x1e950, 0x1fbf0,
];

/// `unicodedata.decimal(c)`.
fn decimal(c: char) -> Option<u8> {
    let n = c as u32;
    ND_ZEROS.iter().find(|&&z| (z..z + 10).contains(&n)).map(|&z| (n - z) as u8)
}

/// `int(str)`.
pub fn py_int(s: &str) -> Option<i64> {
    let t = strip(s);
    let (neg, body) = match t.strip_prefix('-') {
        Some(b) => (true, b),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    if body.is_empty() || body.starts_with('_') || body.ends_with('_') || body.contains("__") {
        return None;
    }
    let digits: Option<String> = body.chars().filter(|&c| c != '_').map(decimal).map(|d| d.map(|d| char::from(b'0' + d))).collect();
    let v: i64 = digits?.parse().ok()?;
    Some(if neg { -v } else { v })
}

/// `raise SystemExit(msg)`: message on stderr, exit status 1.
pub fn system_exit(msg: &str) -> ! {
    use std::io::Write;
    let _ = std::io::stdout().flush();
    eprintln!("{msg}");
    std::process::exit(1)
}

/// An uncaught v2 exception: Python prints a traceback ending in
/// `ExcType: message` and exits 1. v3 prints only that last line.
pub fn uncaught(exc_type: &str, msg: &str) -> ! {
    use std::io::Write;
    let _ = std::io::stdout().flush();
    if msg.is_empty() {
        eprintln!("{exc_type}");
    } else {
        eprintln!("{exc_type}: {msg}");
    }
    std::process::exit(1)
}

/// Python's `OSError` subclass name and `str(exc)` for an I/O error,
/// e.g. `FileNotFoundError` / `[Errno 2] No such file or directory: '/x'`.
pub fn os_error_text(e: &std::io::Error, path: Option<&std::path::Path>) -> (&'static str, String) {
    let Some(errno) = e.raw_os_error() else { return ("OSError", e.to_string()) };
    let ty = match errno {
        libc::ENOENT => "FileNotFoundError",
        libc::EEXIST => "FileExistsError",
        libc::EACCES | libc::EPERM => "PermissionError",
        libc::EISDIR => "IsADirectoryError",
        libc::ENOTDIR => "NotADirectoryError",
        _ => "OSError",
    };
    let strerror = unsafe { std::ffi::CStr::from_ptr(libc::strerror(errno)) }.to_string_lossy().into_owned();
    let msg = match path {
        Some(p) => format!("[Errno {errno}] {strerror}: {}", crate::argparse::py_repr(&p.display().to_string())),
        None => format!("[Errno {errno}] {strerror}"),
    };
    (ty, msg)
}

/// Uncaught `OSError` from file I/O on `path`.
pub fn os_error(e: &std::io::Error, path: Option<&std::path::Path>) -> ! {
    let (ty, msg) = os_error_text(e, path);
    uncaught(ty, &msg)
}
