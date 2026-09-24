//! `ProviderCredentialStore` — port of `plugin_registry.ProviderCredentialStore`
//! (overrides → real process env → `{CONFIG_DIR}/.env`).

use appv3_core::settings;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// `dotenv_values(path)` (python-dotenv semantics, simplified).
pub fn dotenv_values(path: &Path) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(text) = std::fs::read_to_string(path) else { return out };
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') {
            continue;
        }
        let t = t.strip_prefix("export ").unwrap_or(t);
        let Some((k, v)) = t.split_once('=') else { continue };
        let k = k.trim().to_string();
        let mut v = v.trim().to_string();
        if v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\''))) {
            v = v[1..v.len() - 1].to_string();
        } else if let Some(i) = v.find(" #") {
            v = v[..i].trim_end().to_string();
        }
        out.insert(k, v);
    }
    out
}

#[derive(Debug, Clone, Default)]
pub struct CredentialStore {
    pub provider_id: String,
    overrides: HashMap<String, String>,
    saved: HashMap<String, String>,
}

impl CredentialStore {
    pub fn new(overrides: HashMap<String, String>) -> Self {
        Self::for_provider("", overrides)
    }

    pub fn for_provider(provider_id: &str, overrides: HashMap<String, String>) -> Self {
        CredentialStore { provider_id: provider_id.to_string(), overrides, saved: dotenv_values(&settings().env_file()) }
    }

    /// Explicit overrides (values being validated before they are saved).
    pub fn overrides(&self) -> &HashMap<String, String> {
        &self.overrides
    }

    /// `get(name, default="")`.
    pub fn get(&self, name: &str) -> String {
        if let Some(v) = self.overrides.get(name) {
            return v.clone();
        }
        appv3_core::env::os_environ(name).filter(|v| !v.is_empty()).or_else(|| self.saved.get(name).cloned().filter(|v| !v.is_empty())).unwrap_or_default()
    }

    /// `{CACHE_DIR}/provider-plugins/<id>` (created).
    pub fn token_dir(&self) -> PathBuf {
        let root = settings().cache_dir.join("provider-plugins").join(&self.provider_id);
        let _ = std::fs::create_dir_all(&root);
        root
    }

    /// `token_path(filename)`.
    pub fn token_path(&self, filename: &str) -> PathBuf {
        self.token_dir().join(filename.replace('/', "_"))
    }
}
