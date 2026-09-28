//! Kill a child process together with everything it spawned.
//!
//! - Unix: the child leads a new process group; termination sends SIGTERM to
//!   the group, then SIGKILL after a grace period.
//! - Windows: the child is placed in a Job Object with KILL_ON_JOB_CLOSE;
//!   termination ends the whole job (Windows has no graceful signal). The
//!   child also gets CREATE_NO_WINDOW so console programs never pop a window.
//!
//! Mirrors the MCP SDK's stdio transport (`start_new_session=True` /
//! `create_windows_process` + `terminate_*_process_tree`).

use std::time::Duration;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Windows: start a console child without a console window of its own. The
/// desktop sidecar has no console to share, so without this every `git`,
/// shell or LSP spawn would pop up a window. No-op elsewhere.
pub fn hide_window(cmd: &mut tokio::process::Command) -> &mut tokio::process::Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// [`hide_window`] for `std::process::Command`.
pub fn hide_window_std(cmd: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Prepare `cmd` so its process tree can be terminated as a unit.
pub fn configure(cmd: &mut tokio::process::Command) {
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    hide_window(cmd);
}

/// Handle to a spawned process tree. On Windows dropping it kills the tree.
pub struct ProcessTree {
    #[cfg(unix)]
    pgid: Option<i32>,
    #[cfg(windows)]
    job: Option<win::Job>,
}

impl ProcessTree {
    /// Track the tree of a child spawned from a [`configure`]d command.
    pub fn attach(child: &tokio::process::Child) -> Self {
        #[cfg(unix)]
        {
            ProcessTree { pgid: child.id().map(|p| p as i32) }
        }
        #[cfg(windows)]
        {
            ProcessTree { job: child.raw_handle().and_then(|h| win::Job::with_process(h as _)) }
        }
    }

    /// Terminate the whole tree and reap `child`. Unix waits up to `grace`
    /// after SIGTERM before SIGKILL; Windows kills immediately.
    pub async fn terminate(&self, child: &mut tokio::process::Child, grace: Duration) {
        #[cfg(unix)]
        {
            use nix::sys::signal::{killpg, Signal};
            use nix::unistd::Pid;
            match self.pgid {
                Some(pgid) => {
                    let _ = killpg(Pid::from_raw(pgid), Signal::SIGTERM);
                    if tokio::time::timeout(grace, child.wait()).await.is_err() {
                        let _ = killpg(Pid::from_raw(pgid), Signal::SIGKILL);
                    }
                    // The leader may be gone while the group lives on.
                    let _ = killpg(Pid::from_raw(pgid), Signal::SIGKILL);
                }
                None => {
                    let _ = child.start_kill();
                }
            }
        }
        #[cfg(windows)]
        {
            let _ = grace;
            match &self.job {
                Some(job) => job.terminate(),
                None => {
                    let _ = child.start_kill();
                }
            }
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    }
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);

    // A job handle is a kernel object reference, usable from any thread.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn with_process(process: HANDLE) -> Option<Job> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    return None;
                }
                let job = Job(job);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
                if SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, &info as *const _ as *const _, size) == 0 {
                    return None;
                }
                if AssignProcessToJobObject(job.0, process) == 0 {
                    return None;
                }
                Some(job)
            }
        }

        pub fn terminate(&self) {
            unsafe { TerminateJobObject(self.0, 1) };
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn terminate_kills_grandchildren() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("grandchild.pid");
        let mut cmd = tokio::process::Command::new("/bin/sh");
        cmd.arg("-c").arg(format!("sleep 60 & echo $! > {}; wait", pidfile.display()));
        configure(&mut cmd);
        let mut child = cmd.spawn().unwrap();
        let tree = ProcessTree::attach(&child);
        let mut gc = None;
        for _ in 0..100 {
            if let Some(p) = std::fs::read_to_string(&pidfile).ok().and_then(|s| s.trim().parse::<i32>().ok()) {
                gc = Some(p);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let gc = gc.expect("grandchild started");
        tree.terminate(&mut child, Duration::from_millis(500)).await;
        let mut alive = true;
        for _ in 0..50 {
            alive = nix::sys::signal::kill(nix::unistd::Pid::from_raw(gc), None).is_ok() && !zombie(gc);
            if !alive {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(!alive, "grandchild {gc} survived");
    }

    /// A killed orphan stays a zombie until PID 1 reaps it, and in a container
    /// PID 1 is often `cargo`, which never does. A zombie is dead.
    fn zombie(pid: i32) -> bool {
        std::fs::read_to_string(format!("/proc/{pid}/stat")).ok().and_then(|s| s.rsplit_once(") ").map(|(_, rest)| rest.starts_with('Z'))).unwrap_or(false)
    }
}
