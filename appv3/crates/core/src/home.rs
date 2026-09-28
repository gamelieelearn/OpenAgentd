//! Python's `Path.home()` / `os.path.expanduser` on every platform.
//!
//! - Unix: `HOME` if set, else the passwd entry.
//! - Windows: `USERPROFILE`, else `HOMEDRIVE` + `HOMEPATH`. `HOME` is ignored
//!   (Python 3.8+), even though Git Bash and MSYS set it.
//!
//! v2 keeps its XDG-style dirs (`~/.local/share/openagentd`, …) under this
//! home on every OS, so v3 must resolve it identically to share them.

use std::path::PathBuf;

/// `Path.home()`, or `None` when it cannot be determined.
pub fn home_dir_opt() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(p) = std::env::var_os("USERPROFILE").filter(|v| !v.is_empty()) {
            return Some(PathBuf::from(p));
        }
        if let (Some(d), Some(p)) = (std::env::var_os("HOMEDRIVE"), std::env::var_os("HOMEPATH")) {
            let mut s = d;
            s.push(p);
            return Some(PathBuf::from(s));
        }
    }
    #[cfg(not(windows))]
    {
        if let Some(p) = std::env::var_os("HOME") {
            return Some(PathBuf::from(p));
        }
    }
    directories::BaseDirs::new().map(|b| b.home_dir().to_path_buf())
}

/// `Path.home()`, falling back to `.` when there is no home at all.
pub fn home_dir() -> PathBuf {
    home_dir_opt().unwrap_or_else(|| PathBuf::from("."))
}

/// `os.path.expanduser` for `~` and `~/…` (plus `~\…` on Windows).
/// `~user` forms are returned unchanged.
pub fn expanduser(p: &str) -> PathBuf {
    if p == "~" {
        return home_dir_opt().unwrap_or_else(|| PathBuf::from(p));
    }
    let rest = p.strip_prefix("~/").or_else(|| if cfg!(windows) { p.strip_prefix("~\\") } else { None });
    match (rest, home_dir_opt()) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(p),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expanduser_forms() {
        let home = home_dir();
        assert_eq!(expanduser("~"), home);
        assert_eq!(expanduser("~/a/b"), home.join("a/b"));
        assert_eq!(expanduser("~other/x"), PathBuf::from("~other/x"));
        assert_eq!(expanduser("/abs"), PathBuf::from("/abs"));
    }
}
