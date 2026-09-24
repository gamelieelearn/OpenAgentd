//! `app/cli/paths.py` + `app/cli/pids.py`.

use std::path::PathBuf;

pub fn home() -> PathBuf {
    appv3_core::home::home_dir_opt().unwrap_or_else(|| PathBuf::from("/"))
}

fn xdg(env: &str, rel: &[&str]) -> PathBuf {
    if let Some(v) = std::env::var_os(env) {
        return PathBuf::from(v);
    }
    let mut p = home();
    for r in rel {
        p.push(r);
    }
    p
}

pub fn state_dir() -> PathBuf {
    xdg("OPENAGENTD_STATE_DIR", &[".local", "state", "openagentd"])
}

pub fn data_dir() -> PathBuf {
    xdg("OPENAGENTD_DATA_DIR", &[".local", "share", "openagentd"])
}

pub fn config_dir() -> PathBuf {
    xdg("OPENAGENTD_CONFIG_DIR", &[".config", "openagentd"])
}

pub fn pid_file() -> PathBuf {
    state_dir().join("openagentd.pid")
}

pub fn server_log() -> PathBuf {
    state_dir().join("logs").join("app").join("app.log")
}

pub fn write_pids(pids: &[u32]) -> std::io::Result<()> {
    let f = pid_file();
    if let Some(p) = f.parent() {
        std::fs::create_dir_all(p)?;
    }
    std::fs::write(f, pids.iter().map(|p| p.to_string()).collect::<Vec<_>>().join("\n"))
}

/// `_read_pids`: any unparsable line discards the whole file.
pub fn read_pids() -> Vec<i32> {
    let Ok(text) = std::fs::read_to_string(pid_file()) else { return vec![] };
    let mut out = vec![];
    for line in crate::pystr::splitlines(&text) {
        if line.trim().is_empty() {
            continue;
        }
        match crate::pystr::py_int(line) {
            Some(v) if (i32::MIN as i64..=i32::MAX as i64).contains(&v) => out.push(v as i32),
            _ => return vec![],
        }
    }
    out
}

#[cfg(unix)]
pub fn pid_alive(pid: i32) -> bool {
    use nix::errno::Errno;
    match nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None) {
        Ok(()) => true,
        Err(Errno::EPERM) => true,
        Err(_) => false,
    }
}

/// Windows: the process exists and has not exited (`STILL_ACTIVE`).
#[cfg(windows)]
pub fn pid_alive(pid: i32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    if pid <= 0 {
        return false;
    }
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
        if h.is_null() {
            // Access denied still means the process exists (like EPERM on Unix).
            return std::io::Error::last_os_error().raw_os_error() == Some(5);
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(h, &mut code) != 0;
        CloseHandle(h);
        ok && code == STILL_ACTIVE as u32
    }
}

pub fn find_pids() -> Vec<i32> {
    read_pids().into_iter().filter(|&p| pid_alive(p)).collect()
}

pub fn clear_pids() {
    let _ = std::fs::remove_file(pid_file());
}
