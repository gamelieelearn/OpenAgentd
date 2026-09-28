use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::{Mutex, OwnedMutexGuard};

type LockMap = HashMap<PathBuf, (Arc<Mutex<()>>, usize)>;

/// Global async path locking mechanism with reference counting and ordered acquisition.
#[derive(Default, Clone)]
pub struct PathLockManager {
    inner: Arc<Mutex<LockMap>>,
}

impl PathLockManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Acquire a lock on a single path.
    pub async fn lock(&self, path: impl AsRef<Path>) -> PathGuard {
        let canonical = dunce::canonicalize(path.as_ref()).unwrap_or_else(|_| path.as_ref().to_path_buf());

        let lock_arc = {
            let mut map = self.inner.lock().await;
            let entry = map.entry(canonical.clone()).or_insert_with(|| (Arc::new(Mutex::new(())), 0));
            entry.1 += 1;
            Arc::clone(&entry.0)
        };

        let guard = lock_arc.lock_owned().await;

        PathGuard { manager: self.clone(), canonical, _guard: guard }
    }
}

pub struct PathGuard {
    manager: PathLockManager,
    canonical: PathBuf,
    _guard: OwnedMutexGuard<()>,
}

impl Drop for PathGuard {
    fn drop(&mut self) {
        let manager = self.manager.clone();
        let canonical = self.canonical.clone();
        tokio::spawn(async move {
            let mut map = manager.inner.lock().await;
            if let Some(entry) = map.get_mut(&canonical) {
                entry.1 = entry.1.saturating_sub(1);
                if entry.1 == 0 {
                    map.remove(&canonical);
                }
            }
        });
    }
}

pub async fn path_lock(path: impl AsRef<Path>) -> PathGuard {
    use std::sync::OnceLock;
    static GLOBAL_LOCKS: OnceLock<PathLockManager> = OnceLock::new();
    GLOBAL_LOCKS.get_or_init(PathLockManager::new).lock(path).await
}

pub async fn acquire_all_locks(paths: &[PathBuf]) -> Vec<PathGuard> {
    let mut sorted = paths.to_vec();
    sorted.sort();
    sorted.dedup();

    let mut guards = Vec::with_capacity(sorted.len());
    for p in sorted {
        guards.push(path_lock(p).await);
    }
    guards
}
