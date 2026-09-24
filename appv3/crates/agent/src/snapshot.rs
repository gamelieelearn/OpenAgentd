//! Out-of-tree Git-based workspace snapshots for session undo/redo — a
//! line-for-line port of `app/services/snapshot_service.py`.
//!
//! The on-disk layout (`{STATE_DIR}/snapshot/<sid>`, refs under
//! `refs/openagentd/snapshots/<tree>`, alternates seeding) and every git
//! invocation match v2, so v2 and v3 can share snapshot repos.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use appv3_core::settings::settings;
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RestoreResult {
    pub ok: bool,
    pub added: Vec<String>,
    pub modified: Vec<String>,
    pub removed: Vec<String>,
}

impl RestoreResult {
    fn fail() -> Self {
        Self::default()
    }
}

const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024;
const CORE_FLAGS: &[&str] =
    &["--no-optional-locks", "-c", "core.longpaths=true", "-c", "core.symlinks=true", "-c", "core.autocrlf=false", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false"];
const MAINTENANCE_INTERVAL: u64 = 16;
const SNAPSHOT_REF_PREFIX: &str = "refs/openagentd/snapshots";
const SIZE_CAP_ROUNDS: usize = 12;

type Lock = Arc<tokio::sync::Mutex<()>>;
static LOCKS: LazyLock<Mutex<HashMap<String, Lock>>> = LazyLock::new(Default::default);
static LAST_HASHES: LazyLock<Mutex<HashMap<(String, PathBuf), String>>> = LazyLock::new(Default::default);
static TRACK_COUNTS: LazyLock<Mutex<HashMap<String, u64>>> = LazyLock::new(Default::default);
static SEED_ATTEMPTED: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

/// `SNAPSHOT_SEED_OBJECTS` (default on).
pub fn seed_objects_enabled() -> bool {
    match std::env::var("SNAPSHOT_SEED_OBJECTS") {
        Err(_) => true,
        Ok(v) => matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on"),
    }
}

fn lock(session_id: &str) -> Lock {
    LOCKS.lock().unwrap().entry(session_id.to_string()).or_default().clone()
}

fn resolve(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().map(|c| c.join(p)).unwrap_or_else(|_| p.to_path_buf()) })
}

/// On-disk `GIT_DIR` for the session's snapshot repo.
pub fn snapshot_dir(session_id: &str) -> PathBuf {
    resolve(&settings().state_dir).join("snapshot").join(session_id)
}

/// `shutil.which("git") is not None`.
pub fn is_available() -> bool {
    let Some(path) = std::env::var_os("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|d| {
        let c = d.join("git");
        std::fs::metadata(&c)
            .map(|m| {
                use std::os::unix::fs::PermissionsExt;
                m.is_file() && m.permissions().mode() & 0o111 != 0
            })
            .unwrap_or(false)
    })
}

struct Out {
    code: i32,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl Out {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }
    fn err(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

/// Never fails: spawn errors surface as exit code 1.
async fn git(args: &[&str], cwd: Option<&Path>, env: &[(&str, &str)], stdin: Option<Vec<u8>>) -> Out {
    let mut cmd = tokio::process::Command::new("git");
    cmd.args(args).envs(env.iter().copied());
    if let Some(c) = cwd {
        cmd.current_dir(c);
    }
    cmd.stdin(if stdin.is_some() { std::process::Stdio::piped() } else { std::process::Stdio::null() })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("snapshot_git_spawn_failed args={:?} error={}", args, e);
            return Out { code: 1, stdout: vec![], stderr: e.to_string().into_bytes() };
        }
    };
    if let (Some(data), Some(mut w)) = (stdin, child.stdin.take()) {
        tokio::spawn(async move {
            let _ = w.write_all(&data).await;
            let _ = w.shutdown().await;
        });
    }
    match child.wait_with_output().await {
        Ok(o) => Out { code: o.status.code().unwrap_or(1), stdout: o.stdout, stderr: o.stderr },
        Err(e) => Out { code: 1, stdout: vec![], stderr: e.to_string().into_bytes() },
    }
}

fn p(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// `[*CORE_FLAGS, --git-dir, G, --work-tree, W, *rest]`.
fn wt_args<'a>(gd: &'a str, wt: &'a str, rest: &[&'a str]) -> Vec<&'a str> {
    let mut v: Vec<&str> = CORE_FLAGS.to_vec();
    v.extend(["--git-dir", gd, "--work-tree", wt]);
    v.extend_from_slice(rest);
    v
}

fn gd_args<'a>(gd: &'a str, rest: &[&'a str]) -> Vec<&'a str> {
    let mut v = vec!["--git-dir", gd];
    v.extend_from_slice(rest);
    v
}

fn snapshot_ref(tree: &str) -> String {
    format!("{SNAPSHOT_REF_PREFIX}/{tree}")
}

async fn repack(gitdir: &Path) {
    let gd = p(gitdir);
    let mut a: Vec<&str> = CORE_FLAGS.to_vec();
    a.extend(["--git-dir", &gd, "repack", "-a", "-d", "-q", "-l"]);
    let o = git(&a, None, &[], None).await;
    if o.code != 0 {
        tracing::warn!("snapshot_repack_failed gitdir={} stderr={}", gd, o.err());
    }
}

async fn prune_loose(gitdir: &Path) {
    let gd = p(gitdir);
    let o = git(&gd_args(&gd, &["prune", "--expire=now"]), None, &[], None).await;
    if o.code != 0 {
        tracing::warn!("snapshot_prune_failed gitdir={} stderr={}", gd, o.err());
    }
}

fn clean_temp_packs(gitdir: &Path) {
    if let Ok(rd) = std::fs::read_dir(gitdir.join("objects").join("pack")) {
        for e in rd.flatten() {
            if e.file_name().to_string_lossy().starts_with("tmp_pack_") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

async fn maintain_repo(gitdir: &Path) {
    repack(gitdir).await;
    clean_temp_packs(gitdir);
}

async fn ensure_ref(gitdir: &Path, tree: &str) {
    if tree.is_empty() {
        return;
    }
    let gd = p(gitdir);
    let r = snapshot_ref(tree);
    if git(&gd_args(&gd, &["rev-parse", "--verify", "--quiet", &r]), None, &[], None).await.code == 0 {
        return;
    }
    let o = git(&gd_args(&gd, &["commit-tree", tree, "-m", "snapshot"]), None, &[], None).await;
    if o.code != 0 {
        tracing::warn!("snapshot_ref_commit_failed gitdir={} tree={} stderr={}", gd, tree, o.err());
        return;
    }
    let commit = o.text().trim().to_string();
    if commit.is_empty() {
        return;
    }
    let o = git(&gd_args(&gd, &["update-ref", &r, &commit]), None, &[], None).await;
    if o.code != 0 {
        tracing::warn!("snapshot_ref_update_failed gitdir={} tree={} stderr={}", gd, tree, o.err());
    }
}

async fn list_snapshot_refs(gitdir: &Path) -> HashMap<String, String> {
    let gd = p(gitdir);
    let o = git(&gd_args(&gd, &["for-each-ref", "--format=%(refname)", SNAPSHOT_REF_PREFIX]), None, &[], None).await;
    let mut refs = HashMap::new();
    if o.code != 0 {
        return refs;
    }
    for line in o.text().lines() {
        let name = line.trim();
        let tree = name.rsplit('/').next().unwrap_or("");
        if !tree.is_empty() {
            refs.insert(tree.to_string(), name.to_string());
        }
    }
    refs
}

async fn present_trees(gitdir: &Path, trees: &[String]) -> HashSet<String> {
    if trees.is_empty() {
        return HashSet::new();
    }
    let gd = p(gitdir);
    let stdin = format!("{}\n", trees.join("\n")).into_bytes();
    let o = git(&gd_args(&gd, &["cat-file", "--batch-check=%(objectname)"]), None, &[], Some(stdin)).await;
    if o.code != 0 {
        return trees.iter().cloned().collect();
    }
    o.text().lines().map(str::trim).filter(|v| !v.is_empty() && !v.ends_with("missing")).map(String::from).collect()
}

async fn local_size(gitdir: &Path) -> u64 {
    let gd = p(gitdir);
    let o = git(&gd_args(&gd, &["count-objects", "-v"]), None, &[], None).await;
    if o.code != 0 {
        return 0;
    }
    let mut kib = 0u64;
    for line in o.text().lines() {
        let (k, v) = line.split_once(':').unwrap_or((line, ""));
        if matches!(k.trim(), "size" | "size-pack") {
            kib += v.trim().parse::<u64>().unwrap_or(0);
        }
    }
    kib * 1024
}

/// Local object-store bytes for this session's snapshot repo.
pub async fn local_size_bytes(session_id: &str) -> u64 {
    let gd = snapshot_dir(session_id);
    if !gd.join("HEAD").exists() {
        return 0;
    }
    local_size(&gd).await
}

async fn enforce_size_cap(gitdir: &Path, ordered: &[String], max_bytes: u64, protected: &HashSet<String>) {
    let gd = p(gitdir);
    let mut remaining: Vec<String> = ordered.to_vec();
    for _ in 0..SIZE_CAP_ROUNDS {
        let size = local_size(gitdir).await;
        if size <= max_bytes {
            return;
        }
        let droppable: Vec<String> = remaining.iter().filter(|t| !protected.contains(*t)).cloned().collect();
        if droppable.is_empty() {
            tracing::warn!("snapshot_size_cap_exceeded gitdir={} size={} cap={}", gd, size, max_bytes);
            return;
        }
        let per = (size / (remaining.len().max(1) as u64)).max(1);
        let n = (droppable.len() as u64).min(((size - max_bytes) / per + 1).max(1)) as usize;
        for tree in &droppable[..n] {
            let r = snapshot_ref(tree);
            git(&gd_args(&gd, &["update-ref", "-d", &r]), None, &[], None).await;
            remaining.retain(|t| t != tree);
        }
        repack(gitdir).await;
        prune_loose(gitdir).await;
    }
}

/// Reclaim snapshot objects the session no longer references.
pub async fn prune(session_id: &str, keep: &[String], max_bytes: Option<u64>, protected: &[String]) {
    if !is_available() {
        return;
    }
    let gitdir = snapshot_dir(session_id);
    if !gitdir.join("HEAD").exists() {
        return;
    }
    let mut seen = HashSet::new();
    let candidates: Vec<String> = keep.iter().filter(|t| !t.is_empty() && seen.insert((*t).clone())).cloned().collect();
    let present = present_trees(&gitdir, &candidates).await;
    let ordered: Vec<String> = candidates.into_iter().filter(|t| present.contains(t)).collect();
    let protected: HashSet<String> = protected.iter().filter(|t| !t.is_empty()).cloned().collect();
    let l = lock(session_id);
    let _g = l.lock().await;
    let existing = list_snapshot_refs(&gitdir).await;
    let wanted: HashSet<&String> = ordered.iter().collect();
    for tree in &ordered {
        if !existing.contains_key(tree) {
            ensure_ref(&gitdir, tree).await;
        }
    }
    let gd = p(&gitdir);
    for (tree, r) in &existing {
        if !wanted.contains(tree) {
            git(&gd_args(&gd, &["update-ref", "-d", r]), None, &[], None).await;
        }
    }
    repack(&gitdir).await;
    prune_loose(&gitdir).await;
    if let Some(cap) = max_bytes {
        enforce_size_cap(&gitdir, &ordered, cap, &protected).await;
    }
    clean_temp_packs(&gitdir);
}

fn read_alternates(objects_dir: &Path) -> Vec<PathBuf> {
    let Ok(raw) = std::fs::read(objects_dir.join("info").join("alternates")) else {
        return vec![];
    };
    String::from_utf8_lossy(&raw)
        .lines()
        .map(str::trim)
        .filter(|e| !e.is_empty() && !e.starts_with('#'))
        .map(|e| {
            let c = PathBuf::from(e);
            if c.is_absolute() {
                c
            } else {
                resolve(&objects_dir.join(c))
            }
        })
        .collect()
}

fn alternate_object_dirs(source: &Path) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for c in std::iter::once(source.to_path_buf()).chain(read_alternates(source)) {
        if !c.is_dir() {
            continue;
        }
        let t = p(&c);
        if !out.contains(&t) {
            out.push(t);
        }
    }
    out
}

async fn seed_objects(gitdir: &Path, worktree: &Path, copy_index: bool) -> bool {
    if !seed_objects_enabled() {
        return false;
    }
    let o = git(&["rev-parse", "--path-format=absolute", "--git-common-dir"], Some(worktree), &[], None).await;
    if o.code != 0 {
        return false;
    }
    let common = o.text().trim().to_string();
    if common.is_empty() {
        return false;
    }
    let alts = alternate_object_dirs(&Path::new(&common).join("objects"));
    if alts.is_empty() {
        return false;
    }
    let info = gitdir.join("objects").join("info");
    if std::fs::create_dir_all(&info).is_err() || std::fs::write(info.join("alternates"), format!("{}\n", alts.join("\n"))).is_err() {
        return false;
    }
    if copy_index {
        let src = Path::new(&common).join("index");
        if src.is_file() {
            if let Err(e) = std::fs::copy(&src, gitdir.join("index")) {
                tracing::debug!("snapshot_seed_index_failed gitdir={} error={}", p(gitdir), e);
            }
        }
    }
    tracing::info!("snapshot_seeded_objects gitdir={} alternates={}", p(gitdir), alts.len());
    true
}

async fn ensure_seed(gitdir: &Path, worktree: &Path, copy_index: bool) {
    if !SEED_ATTEMPTED.lock().unwrap().insert(p(gitdir)) {
        return;
    }
    seed_objects(gitdir, worktree, copy_index).await;
}

async fn init_repo(gitdir: &Path, worktree: &Path) -> bool {
    let _ = std::fs::create_dir_all(gitdir);
    if gitdir.join("HEAD").exists() {
        ensure_seed(gitdir, worktree, false).await;
        return true;
    }
    let (gd, wt) = (p(gitdir), p(worktree));
    let o = git(&["init"], None, &[("GIT_DIR", &gd), ("GIT_WORK_TREE", &wt)], None).await;
    if o.code != 0 {
        tracing::warn!("snapshot_init_failed gitdir={} stderr={}", gd, o.err());
        return false;
    }
    for (k, v) in [
        ("core.autocrlf", "false"),
        ("core.longpaths", "true"),
        ("core.symlinks", "true"),
        ("core.fsmonitor", "false"),
        ("user.email", "snapshot@openagentd.local"),
        ("user.name", "openagentd-snapshot"),
    ] {
        git(&["--git-dir", &gd, "config", k, v], None, &[], None).await;
    }
    ensure_seed(gitdir, worktree, true).await;
    tracing::info!("snapshot_initialised session_gitdir={}", gd);
    true
}

fn split_nul(b: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(b).split('\0').filter(|s| !s.is_empty()).map(String::from).collect()
}

async fn list_candidate_paths(gitdir: &Path, worktree: &Path) -> Vec<String> {
    let (gd, wt) = (p(gitdir), p(worktree));
    let a1 = wt_args(&gd, &wt, &["diff-files", "--name-only", "-z", "--", "."]);
    let a2 = wt_args(&gd, &wt, &["ls-files", "--others", "--exclude-standard", "-z", "--", "."]);
    let (d, o) = tokio::join!(git(&a1, Some(worktree), &[], None), git(&a2, Some(worktree), &[], None));
    if d.code != 0 || o.code != 0 {
        return vec![];
    }
    let tracked = split_nul(&d.stdout);
    let untracked = split_nul(&o.stdout);
    let mut seen = HashSet::new();
    if untracked.is_empty() {
        return tracked.into_iter().filter(|x| seen.insert(x.clone())).collect();
    }
    let untracked_set: HashSet<&String> = untracked.iter().collect();
    let mut out = Vec::new();
    for path in tracked.iter().chain(untracked.iter()) {
        if !seen.insert(path.clone()) {
            continue;
        }
        if untracked_set.contains(path) {
            match std::fs::metadata(worktree.join(path)) {
                Ok(m) if m.len() > MAX_FILE_SIZE => continue,
                Ok(_) => {}
                Err(_) => continue,
            }
        }
        out.push(path.clone());
    }
    out
}

async fn stage(gitdir: &Path, worktree: &Path, paths: &[String]) -> bool {
    if paths.is_empty() {
        return true;
    }
    let (gd, wt) = (p(gitdir), p(worktree));
    let stdin = format!("{}\0", paths.join("\0")).into_bytes();
    let a = wt_args(&gd, &wt, &["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"]);
    let o = git(&a, Some(worktree), &[], Some(stdin)).await;
    if o.code != 0 {
        tracing::warn!("snapshot_stage_failed stderr={}", o.err());
        return false;
    }
    true
}

/// Snapshot the workspace and return its tree hash (`None` on any failure,
/// for chat workspaces, or when git is missing).
pub async fn track(session_id: &str, workspace: &Path) -> Option<String> {
    if !is_available() || !workspace.is_dir() {
        return None;
    }
    if settings().is_chat_workspace(Some(workspace)) {
        return None;
    }
    let gitdir = snapshot_dir(session_id);
    let key = (session_id.to_string(), resolve(workspace));
    let l = lock(session_id);
    let _g = l.lock().await;
    if !init_repo(&gitdir, workspace).await {
        return None;
    }
    let paths = list_candidate_paths(&gitdir, workspace).await;
    if !paths.is_empty() {
        stage(&gitdir, workspace, &paths).await;
    } else if let Some(h) = LAST_HASHES.lock().unwrap().get(&key).cloned() {
        return Some(h);
    }
    let (gd, wt) = (p(&gitdir), p(workspace));
    let o = git(&wt_args(&gd, &wt, &["write-tree"]), Some(workspace), &[], None).await;
    if o.code != 0 {
        tracing::warn!("snapshot_write_tree_failed session_id={} stderr={}", session_id, o.err());
        return None;
    }
    let hash = o.text().trim().to_string();
    if hash.is_empty() {
        return None;
    }
    ensure_ref(&gitdir, &hash).await;
    LAST_HASHES.lock().unwrap().insert(key, hash.clone());
    let n = {
        let mut c = TRACK_COUNTS.lock().unwrap();
        let e = c.entry(session_id.to_string()).or_insert(0);
        *e += 1;
        *e
    };
    if n % MAINTENANCE_INTERVAL == 0 {
        maintain_repo(&gitdir).await;
    }
    tracing::debug!("snapshot_tracked session_id={} hash={}", session_id, hash);
    Some(hash)
}

/// Restore the workspace to the given snapshot tree.
pub async fn restore(session_id: &str, workspace: &Path, snapshot: &str, skip_stage: bool) -> RestoreResult {
    if !is_available() || snapshot.is_empty() {
        return RestoreResult::fail();
    }
    let gitdir = snapshot_dir(session_id);
    if !gitdir.join("HEAD").exists() {
        tracing::warn!("snapshot_restore_no_repo session_id={} hash={}", session_id, snapshot);
        return RestoreResult::fail();
    }
    let _ = std::fs::create_dir_all(workspace);
    let l = lock(session_id);
    let _g = l.lock().await;
    if !skip_stage {
        let live = list_candidate_paths(&gitdir, workspace).await;
        if !live.is_empty() {
            stage(&gitdir, workspace, &live).await;
        }
    }
    let (gd, wt) = (p(&gitdir), p(workspace));
    let a = wt_args(&gd, &wt, &["diff-index", "-R", "--cached", "--name-status", "-r", "-z", "--no-renames", snapshot]);
    let d = git(&a, Some(workspace), &[], None).await;
    if d.code != 0 {
        tracing::warn!("snapshot_diff_index_failed session_id={} hash={}", session_id, snapshot);
        return RestoreResult::fail();
    }
    let (mut added, mut modified, mut to_delete) = (vec![], vec![], vec![]);
    let text = String::from_utf8_lossy(&d.stdout).into_owned();
    let parts: Vec<&str> = text.split('\0').collect();
    let mut i = 0;
    while i + 1 < parts.len() {
        let (status, path) = (parts[i], parts[i + 1]);
        i += 2;
        if status.is_empty() || path.is_empty() {
            continue;
        }
        match status.as_bytes()[0] {
            b'A' => added.push(path.to_string()),
            b'M' | b'T' => modified.push(path.to_string()),
            b'D' => to_delete.push(path.to_string()),
            _ => {}
        }
    }
    let to_checkout: Vec<String> = added.iter().chain(modified.iter()).cloned().collect();
    if !to_checkout.is_empty() {
        let temp_index = gitdir.join(format!("restore-{}-{}.idx", std::process::id(), &snapshot[..snapshot.len().min(8)]));
        let ti = p(&temp_index);
        let env = [("GIT_INDEX_FILE", ti.as_str())];
        let result = async {
            let o = git(&wt_args(&gd, &wt, &["read-tree", snapshot]), Some(workspace), &env, None).await;
            if o.code != 0 {
                tracing::warn!("snapshot_read_tree_failed session_id={} hash={} stderr={}", session_id, snapshot, o.err());
                return false;
            }
            let stdin = format!("{}\0", to_checkout.join("\0")).into_bytes();
            let o = git(&wt_args(&gd, &wt, &["checkout-index", "-f", "-z", "--stdin"]), Some(workspace), &env, Some(stdin)).await;
            if o.code != 0 {
                tracing::warn!("snapshot_checkout_failed session_id={} hash={} stderr={} count={}", session_id, snapshot, o.err(), to_checkout.len());
                return false;
            }
            true
        }
        .await;
        let _ = std::fs::remove_file(&temp_index);
        if !result {
            return RestoreResult::fail();
        }
    }
    delete_extras(workspace, &to_delete);
    tracing::debug!("snapshot_restored session_id={} hash={} checkout={} extras={}", session_id, snapshot, to_checkout.len(), to_delete.len());
    RestoreResult { ok: true, added, modified, removed: to_delete }
}

fn delete_extras(workspace: &Path, extras: &[String]) {
    let root = resolve(workspace);
    let mut parents: HashSet<PathBuf> = HashSet::new();
    let uniq: HashSet<&String> = extras.iter().collect();
    for rel in uniq {
        let rp = Path::new(rel);
        if rp.is_absolute() || rp.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            continue;
        }
        let target = root.join(rp);
        let Some(parent) = target.parent() else {
            continue;
        };
        if !resolve(parent).starts_with(&root) {
            continue;
        }
        if let Err(e) = std::fs::remove_file(&target) {
            tracing::debug!("snapshot_extra_unlink_failed path={} error={}", p(&target), e);
        }
        let mut d = parent.to_path_buf();
        while d != root && d.starts_with(&root) {
            parents.insert(d.clone());
            if !d.pop() {
                break;
            }
        }
    }
    let mut dirs: Vec<PathBuf> = parents.into_iter().collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for d in dirs {
        let _ = std::fs::remove_dir(&d);
    }
}

/// Delete the session's snapshot repo (best effort).
pub async fn remove(session_id: &str) {
    let gitdir = snapshot_dir(session_id);
    {
        let l = lock(session_id);
        let _g = l.lock().await;
        if gitdir.exists() {
            let g2 = gitdir.clone();
            let _ = tokio::task::spawn_blocking(move || std::fs::remove_dir_all(g2)).await;
        }
        LAST_HASHES.lock().unwrap().retain(|k, _| k.0 != session_id);
        TRACK_COUNTS.lock().unwrap().remove(session_id);
        SEED_ATTEMPTED.lock().unwrap().remove(&p(&gitdir));
    }
    LOCKS.lock().unwrap().remove(session_id);
}

/// Clear a session's lock entry (used by artifact cleanup).
pub fn forget_lock(session_id: &str) {
    LOCKS.lock().unwrap().remove(session_id);
}

/// v2 `_promote_queued`: snapshot the session workspace (only when queued rows
/// exist) and promote every queued row, stamping the snapshot on each.
pub async fn release_queued(pool: &appv3_db::DbPool, session_id: &str) -> anyhow::Result<Vec<appv3_db::SessionMessage>> {
    let mut snap = None;
    if appv3_db::has_queued_user_messages(pool, session_id).await? {
        if let Some(row) = appv3_db::get_session(pool, session_id).await? {
            let ws = crate::session::session_workspace_dir(session_id, Some(&row.workspace));
            snap = track(session_id, &ws).await;
        }
    }
    Ok(appv3_db::release_queued_user_messages(pool, session_id, snap.as_deref()).await?)
}

// ── Retention sweep (port of `snapshot_maintenance.py`) ─────────────────────

fn int_env(name: &str, default: i64, min: i64) -> i64 {
    match std::env::var(name) {
        Err(_) => default,
        Ok(v) => v.trim().parse::<i64>().map(|x| x.max(min)).unwrap_or(default),
    }
}

fn maintenance_enabled() -> bool {
    match std::env::var("SNAPSHOT_MAINTENANCE_ENABLED") {
        Err(_) => true,
        Ok(v) => matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on"),
    }
}

/// `(ordered_keep, protected)` snapshot hashes for a session (db-form id).
pub async fn collect_keep_snapshots(pool: &appv3_db::DbPool, db_sid: &str) -> anyhow::Result<(Vec<String>, Vec<String>)> {
    let rows = sqlx::query_as::<_, appv3_db::SessionMessage>("SELECT * FROM session_messages WHERE session_id = ? ORDER BY seq ASC, id ASC").bind(db_sid).fetch_all(pool).await?;
    let mut ordered: Vec<String> = Vec::new();
    for r in &rows {
        if let Some(s) = r.snapshot() {
            if !ordered.contains(&s) {
                ordered.push(s);
            }
        }
    }
    let anchor = appv3_db::get_session(pool, db_sid).await?.and_then(|s| s.redo_anchor());
    Ok((ordered, anchor.into_iter().collect()))
}

/// One sweep over every session → `(sessions, freed_bytes)`.
pub async fn sweep_snapshots(pool: &appv3_db::DbPool, max_bytes: Option<u64>) -> anyhow::Result<(u64, u64)> {
    let ids: Vec<String> = sqlx::query_scalar("SELECT id FROM chat_sessions").fetch_all(pool).await?;
    let (mut sessions, mut freed) = (0u64, 0u64);
    for id in ids {
        let sid = appv3_db::codec::api_uuid(&id);
        let before = local_size_bytes(&sid).await;
        if before == 0 {
            continue;
        }
        let (ordered, protected) = match collect_keep_snapshots(pool, &id).await {
            Ok(x) => x,
            Err(e) => {
                tracing::warn!("snapshot_maintenance_session_failed session_id={} error={}", sid, e);
                continue;
            }
        };
        prune(&sid, &ordered, max_bytes, &protected).await;
        sessions += 1;
        let after = local_size_bytes(&sid).await;
        if after < before {
            freed += before - after;
        }
    }
    tracing::info!("snapshot_maintenance_swept sessions={} freed_bytes={}", sessions, freed);
    Ok((sessions, freed))
}

static MAINTENANCE: LazyLock<Mutex<Option<tokio::task::JoinHandle<()>>>> = LazyLock::new(Default::default);

/// `start_snapshot_maintenance` — idempotent background sweeper.
pub fn start_maintenance(pool: appv3_db::DbPool) {
    if !maintenance_enabled() {
        tracing::info!("snapshot_maintenance_disabled");
        return;
    }
    let mut slot = MAINTENANCE.lock().unwrap();
    if slot.as_ref().is_some_and(|h| !h.is_finished()) {
        return;
    }
    let hours = int_env("SNAPSHOT_MAINTENANCE_INTERVAL_HOURS", 6, 1) as u64;
    let delay = int_env("SNAPSHOT_MAINTENANCE_START_DELAY_SECONDS", 60, 0) as u64;
    let max_bytes = int_env("SNAPSHOT_MAX_BYTES", 256 * 1024 * 1024, 0) as u64;
    *slot = Some(tokio::spawn(async move {
        if delay > 0 {
            tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
        }
        loop {
            if let Err(e) = sweep_snapshots(&pool, (max_bytes > 0).then_some(max_bytes)).await {
                tracing::warn!("snapshot_maintenance_failed error={}", e);
            }
            tokio::time::sleep(std::time::Duration::from_secs(hours * 3600)).await;
        }
    }));
    tracing::info!("snapshot_maintenance_started interval_h={} max_bytes={}", hours, max_bytes);
}

/// `stop_snapshot_maintenance`.
pub fn stop_maintenance() {
    if let Some(h) = MAINTENANCE.lock().unwrap().take() {
        h.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn track_restore_roundtrip() {
        if !is_available() {
            return;
        }
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        std::fs::create_dir_all(ws.join("sub")).unwrap();
        std::fs::write(ws.join("a.txt"), "one").unwrap();
        std::fs::write(ws.join("sub/b.txt"), "bee").unwrap();
        // Use an explicit gitdir under tmp by pointing snapshot internals at it.
        let gitdir = tmp.path().join("snap");
        assert!(init_repo(&gitdir, &ws).await);
        let paths = list_candidate_paths(&gitdir, &ws).await;
        assert_eq!(paths.len(), 2);
        assert!(stage(&gitdir, &ws, &paths).await);
        let (gd, wt) = (p(&gitdir), p(&ws));
        let t1 = git(&wt_args(&gd, &wt, &["write-tree"]), Some(&ws), &[], None).await.text().trim().to_string();
        assert_eq!(t1.len(), 40);
        std::fs::write(ws.join("a.txt"), "two").unwrap();
        std::fs::write(ws.join("c.txt"), "new").unwrap();
        std::fs::remove_file(ws.join("sub/b.txt")).unwrap();
        let live = list_candidate_paths(&gitdir, &ws).await;
        stage(&gitdir, &ws, &live).await;
        let d = git(&wt_args(&gd, &wt, &["diff-index", "-R", "--cached", "--name-status", "-r", "-z", "--no-renames", &t1]), Some(&ws), &[], None).await;
        let s = String::from_utf8_lossy(&d.stdout).replace('\0', "|");
        assert!(s.contains("M|a.txt") && s.contains("A|sub/b.txt") && s.contains("D|c.txt"), "{s}");
        delete_extras(&ws, &["c.txt".into()]);
        assert!(!ws.join("c.txt").exists());
    }
}
