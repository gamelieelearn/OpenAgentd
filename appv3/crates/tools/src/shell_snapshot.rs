//! Shell snapshots: source the user's rc files once, reuse them per call.
//!
//! v2 runs every `shell` call as a login shell that sources `.zshrc` /
//! `.bashrc` so aliases, functions and PATH tweaks work. Typical rc files
//! (oh-my-zsh, nvm, compinit) cost 100+ ms per call. Instead, one login+rc
//! shell dumps its functions (minus `_*` completion functions), aliases,
//! non-default options and the environment variables the rc changed into a
//! script; each call then runs a plain `-c` shell that sources it.
//!
//! Differences from v2: rc side effects are not re-run per call, and rc
//! changes are picked up when an rc file's mtime/size changes or after
//! [`MAX_AGE`] (for files the rc sources indirectly). Any build failure falls
//! back to v2's argv; `OPENAGENTD_SHELL_SNAPSHOT=false` disables snapshots.
//! The script can hold values the rc exports, so it is written owner-only.

use std::collections::{BTreeMap, HashMap};
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

const MAX_AGE: Duration = Duration::from_secs(30 * 60);
const BUILD_TIMEOUT: Duration = Duration::from_secs(15);
/// Never exported from a snapshot: per-process/per-directory state.
const VOLATILE: &[&str] = &["PWD", "OLDPWD", "SHLVL", "_", "ZSH_EXECUTION_STRING", "BASH_EXECUTION_STRING", "COLUMNS", "LINES", "RANDOM", "SECONDS"];
/// Options that cannot or must not be set from a script.
const FIXED_OPTIONS: &[&str] = &["interactive", "login", "shinstdin", "monitor", "zle", "privileged", "restricted", "singlecommand", "login_shell"];
/// Separates definitions from the option listing in the dump.
const OPTIONS_MARKER: &str = "#__openagentd_options__";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Zsh,
    Bash,
}

impl Kind {
    pub fn of(shell_name: &str) -> Option<Kind> {
        match shell_name {
            "zsh" => Some(Kind::Zsh),
            "bash" => Some(Kind::Bash),
            _ => None,
        }
    }

    /// rc files whose changes invalidate a snapshot.
    fn rc_files(self, home: &Path, env: &HashMap<String, String>) -> Vec<PathBuf> {
        match self {
            Kind::Zsh => {
                let z = env.get("ZDOTDIR").map(PathBuf::from).unwrap_or_else(|| home.to_path_buf());
                let mut v: Vec<PathBuf> =
                    ["/etc/zshenv", "/etc/zprofile", "/etc/zshrc", "/etc/zlogin", "/etc/zsh/zshenv", "/etc/zsh/zprofile", "/etc/zsh/zshrc"].iter().map(PathBuf::from).collect();
                v.push(home.join(".zshenv"));
                v.extend([".zshenv", ".zprofile", ".zshrc", ".zlogin"].iter().map(|f| z.join(f)));
                v
            }
            Kind::Bash => {
                let mut v: Vec<PathBuf> = ["/etc/profile", "/etc/bash.bashrc", "/etc/bashrc"].iter().map(PathBuf::from).collect();
                v.extend([".bash_profile", ".bash_login", ".profile", ".bashrc"].iter().map(|f| home.join(f)));
                v
            }
        }
    }

    /// Run by a v2-style login+rc shell; `$1` = body file, `$2` = env file.
    fn dump_script(self) -> &'static str {
        match self {
            Kind::Zsh => {
                r#"{ for f in ${(k)functions}; do [[ $f == _* ]] || typeset -f -- "$f"; done; alias -L; echo '#__openagentd_options__'; setopt; } > "$1" 2>/dev/null; env -0 > "$2""#
            }
            Kind::Bash => {
                r#"{ for f in $(compgen -A function); do [[ $f == _* ]] || declare -f -- "$f"; done; alias -p; echo '#__openagentd_options__'; shopt -p; } > "$1" 2>/dev/null; env -0 > "$2""#
            }
        }
    }
}

pub fn enabled() -> bool {
    !matches!(std::env::var("OPENAGENTD_SHELL_SNAPSHOT").map(|v| v.to_ascii_lowercase()).as_deref(), Ok("0" | "false" | "no" | "off" | "f" | "n"))
}

/// POSIX single-quoting.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn fingerprint(files: &[PathBuf]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    for f in files {
        f.hash(&mut h);
        if let Ok(m) = std::fs::metadata(f) {
            m.len().hash(&mut h);
            m.modified().ok().and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok()).hash(&mut h);
        }
    }
    h.finish()
}

/// Snapshot body: the dumped definitions with unsettable options removed,
/// plus `export`/`unset` for every variable the rc changed relative to `base`.
fn render(kind: Kind, body: &str, rc_env: &[u8], base: &HashMap<String, String>, never_export: &[&str]) -> String {
    let mut out = String::from("# openagentd shell snapshot (generated; safe to delete)\n");
    let (defs, options) = body.split_once(&format!("{OPTIONS_MARKER}\n")).unwrap_or((body, ""));
    out.push_str(defs);
    if !defs.is_empty() && !defs.ends_with('\n') {
        out.push('\n');
    }
    for line in options.lines().map(str::trim).filter(|l| !l.is_empty()) {
        match kind {
            // zsh `setopt` lists non-default options by name (`no…` = negated default).
            Kind::Zsh => {
                let name = line.strip_prefix("no").filter(|n| FIXED_OPTIONS.contains(n)).unwrap_or(line);
                if !FIXED_OPTIONS.contains(&name) && line.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    out.push_str(&format!("setopt {line} 2>/dev/null\n"));
                }
            }
            // bash `shopt -p` prints `shopt -s|-u name`.
            Kind::Bash => {
                if !FIXED_OPTIONS.iter().any(|f| line.ends_with(&format!(" {f}"))) {
                    out.push_str(&format!("{line} 2>/dev/null\n"));
                }
            }
        }
    }
    let mut rc: BTreeMap<String, String> = BTreeMap::new();
    for kv in rc_env.split(|b| *b == 0) {
        let kv = String::from_utf8_lossy(kv);
        if let Some((k, v)) = kv.split_once('=') {
            rc.insert(k.to_string(), v.to_string());
        }
    }
    let skip = |k: &str| VOLATILE.contains(&k) || never_export.contains(&k) || k.is_empty() || !k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
    for (k, v) in &rc {
        if !skip(k) && base.get(k) != Some(v) {
            out.push_str(&format!("export {k}={}\n", sh_quote(v)));
        }
    }
    for k in base.keys().filter(|k| !rc.contains_key(*k) && !skip(k)) {
        out.push_str(&format!("unset {k}\n"));
    }
    out
}

/// Build a snapshot with `shell_bin` (a login+rc shell using `v2_prefix`,
/// the same rc-sourcing prelude v2 runs before `eval`) under `env`.
pub async fn build(kind: Kind, shell_bin: &str, v2_prefix: &str, env: &HashMap<String, String>, never_export: &[&str], dest: &Path) -> Result<(), String> {
    let dir = dest.parent().ok_or("snapshot path has no parent")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let tmp = tempfile::Builder::new().prefix(".snapshot-").tempdir_in(dir).map_err(|e| e.to_string())?;
    let (body_f, env_f) = (tmp.path().join("body"), tmp.path().join("env"));
    let script = format!("{v2_prefix} {}", kind.dump_script());
    let mut cmd = tokio::process::Command::new(shell_bin);
    appv3_core::proctree::hide_window(&mut cmd)
        .args(["-l", "-c", &script, "openagentd"])
        .arg(&body_f)
        .arg(&env_f)
        .env_clear()
        .envs(env)
        .current_dir(dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    let status = tokio::time::timeout(BUILD_TIMEOUT, cmd.status()).await.map_err(|_| "timed out".to_string())?.map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("rc shell exited with {status}"));
    }
    let body = std::fs::read_to_string(&body_f).map_err(|e| e.to_string())?;
    let rc_env = std::fs::read(&env_f).map_err(|e| e.to_string())?;
    if rc_env.is_empty() {
        return Err("rc shell produced no environment".into());
    }
    appv3_core::secret_files::write_secret_file(dest, &render(kind, &body, &rc_env, env, never_export)).map_err(|e| e.to_string())
}

/// `-c` argv that sources `snapshot` and then runs `command` like v2 does.
pub fn argv(kind: Kind, snapshot: &Path, command: &str) -> Vec<String> {
    let src = sh_quote(&snapshot.to_string_lossy());
    let script = match kind {
        Kind::Zsh => format!("source {src} >/dev/null 2>&1; unset HISTFILE; HISTSIZE=0; SAVEHIST=0; unsetopt appendhistory incappendhistory sharehistory 2>/dev/null; eval \"$1\""),
        Kind::Bash => format!("shopt -s expand_aliases; source {src} >/dev/null 2>&1; unset HISTFILE; HISTSIZE=0; HISTFILESIZE=0; set +o history 2>/dev/null; eval \"$1\""),
    };
    vec!["-c".into(), script, "openagentd".into(), command.into()]
}

struct Entry {
    path: PathBuf,
    fingerprint: u64,
    built: Instant,
    ok: bool,
}

/// Process-wide cache: one snapshot per shell binary, rebuilt when stale.
pub struct Cache {
    entries: tokio::sync::Mutex<HashMap<String, Entry>>,
}

impl Default for Cache {
    fn default() -> Self {
        Self { entries: tokio::sync::Mutex::new(HashMap::new()) }
    }
}

impl Cache {
    /// A fresh snapshot path for `shell_bin`, building it if needed; `None`
    /// means "use v2's argv" (build failed recently, or unsupported).
    pub async fn get(&self, kind: Kind, shell_bin: &str, v2_prefix: &str, env: &HashMap<String, String>, never_export: &[&str], dir: &Path) -> Option<PathBuf> {
        let home = appv3_core::home::home_dir_opt()?;
        let fp = fingerprint(&kind.rc_files(&home, env));
        // Held across the build so concurrent calls wait for one build.
        let mut entries = self.entries.lock().await;
        if let Some(e) = entries.get(shell_bin) {
            if e.fingerprint == fp && e.built.elapsed() < MAX_AGE && (!e.ok || e.path.is_file()) {
                return e.ok.then(|| e.path.clone());
            }
        }
        let name = crate::shell::shell_name_of(shell_bin);
        let mut h = std::collections::hash_map::DefaultHasher::new();
        shell_bin.hash(&mut h);
        let path = dir.join(format!("{name}-{:016x}.sh", h.finish()));
        let t = Instant::now();
        let ok = match build(kind, shell_bin, v2_prefix, env, never_export, &path).await {
            Ok(()) => {
                tracing::info!("shell_snapshot_built shell={} ms={}", name, t.elapsed().as_millis());
                true
            }
            Err(e) => {
                tracing::warn!("shell_snapshot_failed shell={} error={} (falling back to sourcing rc files per call)", name, e);
                false
            }
        };
        entries.insert(shell_bin.to_string(), Entry { path: path.clone(), fingerprint: fp, built: Instant::now(), ok });
        ok.then_some(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_filters_volatile_and_fixed() {
        let base: HashMap<String, String> = [("PATH", "/bin"), ("KEEP", "same"), ("GONE", "x"), ("PYTHONPATH", "/p")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let rc = b"PATH=/opt/bin:/bin\0KEEP=same\0PWD=/tmp\0SHLVL=2\0NEW=it's\0PYTHONPATH=/leak\0";
        let s = render(Kind::Zsh, "alias ll='ls -l'\nfoo () {\n\techo hi\n}\n#__openagentd_options__\ninteractive\nnomatch\nnoglob\nnomonitor\n", rc, &base, &["PYTHONPATH"]);
        assert!(s.contains("alias ll='ls -l'\n") && s.contains("foo () {\n\techo hi\n}\n"));
        assert!(s.contains("setopt noglob 2>/dev/null\n") && s.contains("setopt nomatch 2>/dev/null\n"));
        assert!(!s.contains("setopt interactive") && !s.contains("setopt nomonitor"));
        assert!(s.contains("export PATH='/opt/bin:/bin'\n"));
        assert!(s.contains("export NEW='it'\\''s'\n"));
        assert!(s.contains("unset GONE\n"));
        for absent in ["KEEP", "PWD", "SHLVL", "PYTHONPATH"] {
            assert!(!s.contains(&format!("export {absent}=")), "{absent}");
        }
    }

    /// Commands see the same aliases, functions, env and cwd with and
    /// without a snapshot (per available shell). Snapshots are Unix-only.
    #[cfg(unix)]
    #[tokio::test]
    async fn snapshot_matches_sourcing_rc() {
        for (kind, name, rc_file) in [(Kind::Zsh, "zsh", ".zshrc"), (Kind::Bash, "bash", ".bashrc")] {
            let Some(bin) = appv3_core::which::which(name) else { continue };
            let bin = bin.to_string_lossy().into_owned();
            let home = tempfile::tempdir().unwrap();
            let rc = "alias greet='echo hello'\nshout() { echo \"$1!\"; }\nexport OAD_SNAP_T=\"from rc\"\nexport PATH=\"/oad/snap/bin:$PATH\"\n";
            std::fs::write(home.path().join(rc_file), rc).unwrap();
            if kind == Kind::Bash {
                std::fs::write(home.path().join(".bash_profile"), "[ -f ~/.bashrc ] && . ~/.bashrc\n").unwrap();
            }
            let mut env: HashMap<String, String> =
                [("HOME", home.path().to_str().unwrap()), ("PATH", "/usr/bin:/bin"), ("TERM", "dumb")].iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            env.insert("PYTHONPATH".into(), "/should/stay/unset".into());
            let v2 = crate::shell::build_argv(&bin, "x");
            let prefix = v2[2].trim_end_matches("eval \"$1\"").to_string();
            let dest = home.path().join("snap/s.sh");
            build(kind, &bin, &prefix, &env, &["PYTHONPATH"], &dest).await.unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                assert_eq!(std::fs::metadata(&dest).unwrap().permissions().mode() & 0o777, 0o600);
            }
            let work = tempfile::tempdir().unwrap();
            let cmd = "greet; shout hey; echo \"$OAD_SNAP_T\"; echo \"$PATH\" | cut -d: -f1; pwd -P; echo \"py=${PYTHONPATH:-none}\"";
            let run = |argv: Vec<String>| {
                let mut env = env.clone();
                env.remove("PYTHONPATH");
                let out = std::process::Command::new(&bin).args(argv).env_clear().envs(&env).current_dir(work.path()).output().unwrap();
                String::from_utf8_lossy(&out.stdout).into_owned()
            };
            let with = run(argv(kind, &dest, cmd));
            let without = run(crate::shell::build_argv(&bin, cmd));
            let real = std::fs::canonicalize(work.path()).unwrap();
            assert_eq!(with, format!("hello\nhey!\nfrom rc\n/oad/snap/bin\n{}\npy=none\n", real.display()), "{name}");
            assert_eq!(with, without, "{name}");
        }
    }
}
