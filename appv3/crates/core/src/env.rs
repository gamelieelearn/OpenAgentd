use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

fn injected() -> &'static Mutex<HashMap<String, String>> {
    static I: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    I.get_or_init(Default::default)
}

/// v2 `os.environ.get(name)`: the process environment *without* values that
/// only exist because a `.env` file was loaded into it. v2 reads those files
/// through pydantic-settings, which never touches `os.environ`, so checks
/// such as "is this provider configured" must not see them.
pub fn os_environ(name: &str) -> Option<String> {
    let v = std::env::var(name).ok()?;
    match injected().lock().unwrap().get(name) {
        Some(inj) if *inj == v => None,
        _ => Some(v),
    }
}

/// Load key-value pairs from an env file without overwriting existing environment variables.
pub fn load_env_file(path: &Path) {
    if !path.exists() {
        return;
    }
    if let Ok(content) = std::fs::read_to_string(path) {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some((key, val)) = line.split_once('=') {
                let key = key.trim();
                let mut val = val.trim();
                if (val.starts_with('"') && val.ends_with('"')) || (val.starts_with('\'') && val.ends_with('\'')) {
                    val = &val[1..val.len() - 1];
                }
                if std::env::var(key).is_err() {
                    std::env::set_var(key, val);
                    injected().lock().unwrap().insert(key.to_string(), val.to_string());
                }
            }
        }
    }
}

/// Load `.env` files with v2 (pydantic-settings) precedence:
/// real environment > `~/.config/openagentd/.env` > project `.env`.
///
/// `load_env_file` never overwrites an existing variable, so the
/// higher-priority file is loaded first.
pub fn init_env() {
    if let Some(home) = crate::home::home_dir_opt() {
        load_env_file(&home.join(".config").join("openagentd").join(".env"));
    }
    load_env_file(Path::new(".env"));
}

/// Load the active config dir's `.env` (provider keys saved via the UI live
/// there; in development that is `.openagentd/dev/config/.env`).
pub fn load_config_env(config_dir: &Path) {
    load_env_file(&config_dir.join(".env"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_load_env_file() {
        let dir = tempdir().unwrap();
        let env_path = dir.path().join(".env");
        std::fs::write(&env_path, "TEST_OPENAGENTD_KEY=secret_value_123\n# comment\nOTHER_KEY=\"quoted\"\n").unwrap();

        load_env_file(&env_path);
        assert_eq!(std::env::var("TEST_OPENAGENTD_KEY").unwrap(), "secret_value_123");
        assert_eq!(std::env::var("OTHER_KEY").unwrap(), "quoted");
    }
}
