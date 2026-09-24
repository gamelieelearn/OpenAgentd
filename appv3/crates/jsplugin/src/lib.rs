//! JavaScript / TypeScript plugins, run in embedded QuickJS (`rquickjs`).
//!
//! Every `*.ts` / `*.js` file in `settings.plugins_dirs` (except `_*` helper
//! modules and `*.d.ts`) is loaded into its own runtime. What a file provides
//! is decided by its exports — `provider` (a provider plugin) and/or a
//! `plugin()` factory returning tool hooks — and consumed by the provider
//! registry (`appv3-providers`) and the agent tool loop (`appv3-agent`).
//! v3 never reads the v2 `*.py` plugins.

mod host;
mod runtime;
pub mod transpile;

pub use host::{parse_iso_ts, parse_qs, register_native, url_query, which, Callback, CallbackFn, NativeFn};
pub use runtime::{CallResult, JsError, JsPlugin, Mode, Target};

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};

/// The `openagentd` module's type declarations (for plugin authors' editors).
pub const TYPES: &str = include_str!("../openagentd.d.ts");

fn is_plugin_file(p: &Path) -> bool {
    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.starts_with('_') || name.starts_with('.') || name.ends_with(".d.ts") {
        return false;
    }
    matches!(p.extension().and_then(|e| e.to_str()), Some("ts" | "js"))
}

/// Plugin files across `dirs`: sorted per directory, deduplicated by real path.
pub fn plugin_files(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = vec![];
    for d in dirs {
        let Ok(rd) = std::fs::read_dir(d) else { continue };
        let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_file() && is_plugin_file(p)).collect();
        files.sort();
        for f in files {
            if seen.insert(dunce::canonicalize(&f).unwrap_or_else(|_| f.clone())) {
                out.push(f);
            }
        }
    }
    out
}

/// Load every plugin in `dirs` (in order); broken files are logged and skipped.
pub fn load_all(dirs: &[PathBuf]) -> Vec<Arc<JsPlugin>> {
    let files = plugin_files(dirs);
    // Evaluate concurrently (each file has its own thread), keep file order.
    let handles: Vec<_> = files.into_iter().map(|f| (f.clone(), std::thread::spawn(move || JsPlugin::load(&f)))).collect();
    let mut out = vec![];
    for (f, h) in handles {
        match h.join().unwrap_or_else(|_| Err("plugin loader panicked".into())) {
            Ok(p) => out.push(p),
            Err(e) => tracing::warn!("plugin_load_failed file={} error={}", f.display(), e),
        }
    }
    out
}

/// All plugins from `settings.plugins_dirs`, loaded once per process.
pub fn plugins() -> &'static Vec<Arc<JsPlugin>> {
    static P: OnceLock<Vec<Arc<JsPlugin>>> = OnceLock::new();
    P.get_or_init(|| load_all(&appv3_core::settings().plugins_dirs))
}
