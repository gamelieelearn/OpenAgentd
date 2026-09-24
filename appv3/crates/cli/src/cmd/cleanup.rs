//! `openagentd cleanup` — ports of `app/cli/commands/cleanup.py` and
//! `app/services/artifact_cleanup.py::cleanup_generated_artifacts`.

use crate::argparse::Ns;
use crate::cmd::server::{ns_bool, ns_int};
use crate::ui::{bold, cyan, dim, green, yellow};
use chrono::{DateTime, Utc};
use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::{Row, SqlitePool};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::str::FromStr;

struct Candidate {
    path: PathBuf,
    #[allow(dead_code)]
    reason: &'static str,
    bytes: u64,
}

#[derive(Default)]
struct CleanupResult {
    dry_run: bool,
    candidates: Vec<Candidate>,
    deleted: Vec<PathBuf>,
    expired_sessions: usize,
    expired_messages: i64,
    vacuum_reclaimed_bytes: Option<u64>,
    vacuum_error: Option<String>,
}

fn mtime(p: &Path) -> Option<DateTime<Utc>> {
    std::fs::metadata(p).ok()?.modified().ok().map(DateTime::<Utc>::from)
}

fn old_enough(p: &Path, cutoff: Option<DateTime<Utc>>) -> bool {
    match cutoff {
        None => true,
        Some(c) => mtime(p).is_some_and(|m| m < c),
    }
}

/// `_dir_size`: regular files under `path` (symlinks followed by `stat`).
fn dir_size(path: &Path) -> u64 {
    if path.is_file() {
        return std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    }
    let mut total = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            if let Ok(m) = std::fs::metadata(&p) {
                if m.is_file() {
                    total += m.len();
                }
            }
            if std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_dir()) {
                stack.push(p);
            }
        }
    }
    total
}

fn child_dirs(root: &Path) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(root) else { return vec![] };
    rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect()
}

/// `uuid.UUID(value)` accepts it.
fn is_uuid(v: &str) -> bool {
    let h = v.replace("urn:", "").replace("uuid:", "");
    let h = h.trim_matches(|c| c == '{' || c == '}').replace('-', "");
    h.len() == 32 && h.chars().all(|c| c.is_ascii_hexdigit())
}

fn name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

struct SessionRow {
    id: String,
    workspace: String,
    created_at: Option<DateTime<Utc>>,
}

async fn session_rows(db: &SqlitePool) -> Result<Option<Vec<SessionRow>>, sqlx::Error> {
    match sqlx::query("SELECT id, workspace, created_at FROM chat_sessions").fetch_all(db).await {
        Ok(rows) => Ok(Some(
            rows.iter()
                .map(|r| SessionRow {
                    id: appv3_db::codec::api_uuid(&r.try_get::<String, _>(0).unwrap_or_default()),
                    workspace: r.try_get::<String, _>(1).unwrap_or_default(),
                    created_at: r.try_get::<String, _>(2).ok().and_then(|s| appv3_db::codec::parse_dt(&s)),
                })
                .collect(),
        )),
        Err(e) => {
            let d = e.to_string().to_lowercase();
            if d.contains("no such table") && d.contains("chat_sessions") {
                Ok(None)
            } else {
                Err(e)
            }
        }
    }
}

fn resolve(p: &Path) -> PathBuf {
    let abs = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(p) };
    appv3_tools::denied::resolve(&abs)
}

async fn cleanup_generated_artifacts(db: &SqlitePool, db_path: &Path, older_than_days: Option<i64>, dry_run: bool, vacuum: bool) -> Result<CleanupResult, sqlx::Error> {
    let s = appv3_core::settings();
    let cutoff = older_than_days.map(|d| Utc::now() - chrono::Duration::days(d));
    let rows = session_rows(db).await?;
    let live: HashSet<String> = rows.iter().flatten().map(|r| r.id.clone()).collect();
    let mut expired: Vec<String> = vec![];
    let mut coding_workspaces: HashSet<String> = HashSet::new();
    for r in rows.iter().flatten() {
        coding_workspaces.insert(resolve(Path::new(&r.workspace)).display().to_string());
        if let (Some(c), Some(at)) = (cutoff, r.created_at) {
            if at < c && !expired.contains(&r.id) {
                expired.push(r.id.clone());
            }
        }
    }
    let coding: &HashSet<String> = &live;
    let mut candidates = vec![];

    for (rel, reason) in [(Path::new("logs").join("sessions"), "old session logs"), (PathBuf::from("telemetry"), "old telemetry files"), (PathBuf::from("otel"), "old otel files")] {
        for child in child_dirs(&s.state_dir.join(rel)) {
            if old_enough(&child, cutoff) {
                let bytes = dir_size(&child);
                candidates.push(Candidate { path: child, reason, bytes });
            }
        }
    }
    let scan = |root: PathBuf, expired_reason: (&'static str, &'static str), orphan_reason: &'static str, out: &mut Vec<Candidate>| {
        for child in child_dirs(&root) {
            let n = name(&child);
            if is_uuid(&n) && expired.contains(&n) {
                let reason = if coding.contains(&n) { expired_reason.0 } else { expired_reason.1 };
                let bytes = dir_size(&child);
                out.push(Candidate { path: child, reason, bytes });
            } else if !live.contains(&n) && is_uuid(&n) && old_enough(&child, cutoff) {
                let bytes = dir_size(&child);
                out.push(Candidate { path: child, reason: orphan_reason, bytes });
            }
        }
    };
    scan(s.data_dir.join(appv3_tools::denied::SESSIONS_DIR), ("expired coding session artifacts", "expired session artifacts"), "orphaned session artifacts", &mut candidates);
    scan(s.state_dir.join("snapshot"), ("expired coding session snapshots", "expired session snapshots"), "old session snapshots", &mut candidates);

    for repo in child_dirs(&s.data_dir.join("worktrees")) {
        for child in child_dirs(&repo) {
            if coding_workspaces.contains(&resolve(&child).display().to_string()) {
                continue;
            }
            if old_enough(&child, cutoff) && appv3_api::routes::agent::worktrees::find_managed_worktree_source(&child).await.is_some() {
                let bytes = dir_size(&child);
                candidates.push(Candidate { path: child, reason: "old managed git worktrees", bytes });
            }
        }
    }

    let db_ids: Vec<String> = expired.iter().map(|id| appv3_db::codec::db_id(id)).collect();
    let in_list = || vec!["?"; db_ids.len()].join(", ");
    let mut expired_messages = 0;
    if !db_ids.is_empty() {
        let sql = format!("SELECT count(*) FROM session_messages WHERE session_messages.session_id IN ({})", in_list());
        let mut q = sqlx::query_scalar::<_, i64>(&sql);
        for id in &db_ids {
            q = q.bind(id);
        }
        expired_messages = q.fetch_one(db).await?;
    }
    let mut deleted = vec![];
    if !dry_run {
        if !db_ids.is_empty() {
            let mut tx = db.begin().await?;
            for table in ["session_messages", "chat_sessions"] {
                let col = if table == "session_messages" { "session_id" } else { "id" };
                let sql = format!("DELETE FROM {table} WHERE {table}.{col} IN ({})", in_list());
                let mut q = sqlx::query(&sql);
                for id in &db_ids {
                    q = q.bind(id);
                }
                q.execute(&mut *tx).await?;
            }
            tx.commit().await?;
        }
        for c in &candidates {
            let _ = std::fs::remove_dir_all(&c.path);
            deleted.push(c.path.clone());
        }
    }
    let (mut reclaimed, mut verr) = (None, None);
    if vacuum && !dry_run {
        match vacuum_sqlite(db_path).await {
            Ok((before, after)) => reclaimed = Some(before.saturating_sub(after)),
            Err(e) => {
                tracing::warn!("cleanup_vacuum_failed db={} error={}", db_path.display(), e);
                verr = Some(e);
            }
        }
    }
    Ok(CleanupResult {
        dry_run,
        candidates,
        deleted,
        expired_sessions: expired.len(),
        expired_messages,
        vacuum_reclaimed_bytes: reclaimed,
        vacuum_error: verr,
    })
}

/// `app/core/db.py::vacuum_sqlite` → `(size_before, size_after)`; the error
/// string is `str(sqlite3.Error)`.
async fn vacuum_sqlite(path: &Path) -> Result<(u64, u64), String> {
    use sqlx::Connection;
    let before = std::fs::metadata(path).map(|m| m.len()).map_err(|e| e.to_string())?;
    let msg = |e: sqlx::Error| e.as_database_error().map(|d| d.message().to_string()).unwrap_or_else(|| e.to_string());
    let opts = SqliteConnectOptions::new().filename(path).busy_timeout(std::time::Duration::from_secs(5));
    let mut conn = sqlx::SqliteConnection::connect_with(&opts).await.map_err(msg)?;
    for sql in ["VACUUM", "PRAGMA wal_checkpoint(TRUNCATE)"] {
        sqlx::query(sql).execute(&mut conn).await.map_err(msg)?;
    }
    let _ = conn.close().await;
    let after = std::fs::metadata(path).map(|m| m.len()).map_err(|e| e.to_string())?;
    Ok((before, after))
}

/// `_format_bytes`.
fn format_bytes(size: u64) -> String {
    let mut v = size as f64;
    for unit in ["B", "KB", "MB", "GB"] {
        if v < 1024.0 || unit == "GB" {
            return if unit == "B" { format!("{} B", v as u64) } else { format!("{v:.1} {unit}") };
        }
        v /= 1024.0;
    }
    unreachable!()
}

pub fn cmd_cleanup(ns: &Ns) {
    let older = ns_int(ns, "older_than_days");
    let dry_run = ns_bool(ns, "dry_run");
    let vacuum = ns_bool(ns, "vacuum");
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    let result = rt.block_on(async move {
        let db_path = appv3_core::settings().database_path.clone();
        if let Some(p) = Path::new(&db_path).parent() {
            let _ = std::fs::create_dir_all(p);
        }
        let opts = SqliteConnectOptions::from_str(&format!("sqlite://{}", Path::new(&db_path).display()))?.create_if_missing(true).busy_timeout(std::time::Duration::from_secs(5));
        let pool = SqlitePoolOptions::new().max_connections(1).connect_with(opts).await?;
        let r = cleanup_generated_artifacts(&pool, Path::new(&db_path), older, dry_run, vacuum).await;
        pool.close().await;
        r
    });
    let r = match result {
        Ok(r) => r,
        Err(e) => crate::pystr::uncaught("sqlalchemy.exc.OperationalError", &e.to_string()),
    };
    let mode = if r.dry_run { "dry run" } else { "deleted" };
    let total: u64 = r.candidates.iter().map(|c| c.bytes).sum();
    println!("  {} ({mode})", bold(&cyan("Generated artifact cleanup")));
    println!("  {} {}", dim("Expired sessions:"), r.expired_sessions);
    println!("  {} {}", dim("Expired messages:"), r.expired_messages);
    println!("  {} {}", dim("Candidates:"), r.candidates.len());
    println!("  {}      {}", dim("Total:"), format_bytes(total));
    if let Some(b) = r.vacuum_reclaimed_bytes {
        println!("  {} {}", dim("Vacuum reclaimed:"), format_bytes(b));
    }
    if let Some(e) = &r.vacuum_error {
        println!("  {} {e}", yellow("Vacuum skipped:"));
    }
    if r.dry_run {
        println!("  {} Re-run with {} to delete.", yellow("No files deleted."), bold("--apply"));
    } else {
        println!("  {} {} paths.", green("Deleted"), r.deleted.len());
    }
}
