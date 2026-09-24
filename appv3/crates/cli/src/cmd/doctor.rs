//! `openagentd doctor` — port of `app/cli/commands/doctor.py`.

use crate::paths::{config_dir, data_dir, home};
use crate::pystr::{splitlines, strip};
use crate::ui::{bold, cyan, dim, green, red, yellow};
use std::path::Path;

const OAUTH_PROVIDERS: &[&str] = &["copilot", "codex", "grok", "vertexai", "cliproxy", "router9", "ollama"];

/// `PROVIDER_KEY_VAR` in catalog order.
fn provider_key_vars() -> Vec<(String, String)> {
    appv3_providers::catalog::builtin_providers()
        .iter()
        .filter_map(|e| {
            let var = e.get("env_var").and_then(|v| v.as_str()).filter(|s| !s.is_empty())?;
            Some((e["id"].as_str().unwrap_or("").to_string(), var.to_string()))
        })
        .collect()
}

fn display(p: &Path) -> String {
    p.display().to_string().replace(&home().display().to_string(), "~")
}

/// `sorted(dir.glob("*.md"))`.
fn md_files(dir: &Path) -> Vec<std::path::PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut v: Vec<_> = rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(".md"))).collect();
    v.sort();
    v
}

/// `_read_lead_provider`.
fn read_lead_provider(agents_dir: &Path) -> Option<String> {
    if !agents_dir.is_dir() {
        return None;
    }
    let candidates = md_files(agents_dir);
    if candidates.is_empty() {
        return None;
    }
    let lead = agents_dir.join("code.md");
    let target = if lead.is_file() { lead } else { candidates[0].clone() };
    let text = std::fs::read_to_string(&target).ok()?;
    let lines = splitlines(&text);
    if lines.is_empty() || strip(lines[0]) != "---" {
        return None;
    }
    for line in &lines[1..] {
        let s = strip(line);
        if s == "---" {
            break;
        }
        if let Some(rest) = s.strip_prefix("model:") {
            let value = strip(rest).trim_matches('"').trim_matches('\'');
            if let Some((provider, _)) = value.split_once(':') {
                let p = strip(provider);
                return (!p.is_empty()).then(|| p.to_string());
            }
            return None;
        }
    }
    None
}

pub fn cmd_doctor() {
    let (mut passes, mut warnings, mut errors) = (0, 0, 0);
    let mut ok = |m: &str| {
        passes += 1;
        println!("  {}  {m}", green("✓"));
    };
    let mut warn = |m: &str| {
        warnings += 1;
        println!("  {}  {m}", yellow("⚠"));
    };
    let mut fail = |m: &str| {
        errors += 1;
        println!("  {}  {m}", red("✗"));
    };
    println!();
    println!("  {}", bold(&cyan("openagentd doctor")));
    println!();

    // 1. Runtime (v2 checks the Python interpreter; v3 has none).
    ok(&format!("Rust runtime (openagentd v{})", appv3_core::VERSION));

    // 2. LLM provider API keys
    let cfg = config_dir();
    let key_vars = provider_key_vars();
    let configured = read_lead_provider(&cfg.join("agents"));
    let mut all_vars: Vec<&str> = key_vars.iter().map(|(_, v)| v.as_str()).collect();
    all_vars.push("VERTEXAI_API_KEY");
    let found: Vec<&str> = all_vars.iter().copied().filter(|k| std::env::var(k).is_ok_and(|v| !v.is_empty())).collect();
    let uses_oauth = configured.as_deref().is_some_and(|p| OAUTH_PROVIDERS.contains(&p));
    if !found.is_empty() {
        for k in &found {
            ok(&format!("API key: {k}"));
        }
    } else if uses_oauth {
        ok(&format!("Provider '{}' uses OAuth — no API key required", configured.as_deref().unwrap()));
    } else if configured.is_none() {
        warn("No agents configured — cannot verify provider credentials");
    } else {
        fail("No LLM provider API key configured");
        let names: Vec<&str> = key_vars.iter().map(|(_, v)| v.as_str()).collect();
        println!("     {}", dim(&format!("  Set one of: {}", names.join(", "))));
    }

    // 3. Configured provider has matching key
    if let Some(p) = &configured {
        if uses_oauth {
            ok(&format!("Provider '{p}' authenticated via OAuth"));
        } else {
            match key_vars.iter().find(|(id, _)| id == p).map(|(_, v)| v.as_str()) {
                None => warn(&format!("Lead agent uses unknown provider: {p}")),
                Some(k) if found.contains(&k) => ok(&format!("Provider key matches agent: {k}")),
                Some(k) => fail(&format!("Lead agent uses '{p}' but {k} is not set")),
            }
        }
    }

    // 4. Database file
    let db = data_dir().join("openagentd.db");
    if db.exists() {
        ok(&format!("Database: {}", display(&db)));
    } else {
        warn(&format!("Database not found: {}  (will be created on first run)", display(&db)));
    }

    // 5. Migrations are compiled into the binary (v2: alembic.ini bundled).
    // v2's `from app.core import db` creates the DB's parent directory here.
    if let Some(parent) = std::path::Path::new(&appv3_core::settings().database_path).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    ok("Alembic config bundled");

    // 6. Default port availability
    let default_port = 4082;
    if std::net::TcpListener::bind(("127.0.0.1", default_port)).is_ok() {
        ok(&format!("Port {default_port} available"));
    } else {
        warn(&format!("Port {default_port} in use  (server may already be running)"));
    }

    // 7. Agents directory
    let agents = cfg.join("agents");
    if agents.is_dir() && !md_files(&agents).is_empty() {
        ok(&format!("Agents: {}", display(&agents)));
    } else {
        fail(&format!("Agents not found: {}  (restart OpenAgentd to restore defaults)", display(&agents)));
    }

    println!();
    let mut parts = vec![green(&format!("{passes} passed"))];
    if warnings > 0 {
        parts.push(yellow(&format!("{warnings} warning{}", if warnings != 1 { "s" } else { "" })));
    }
    if errors > 0 {
        parts.push(red(&format!("{errors} error{}", if errors != 1 { "s" } else { "" })));
    }
    println!("  {}", parts.join(", "));
    println!();
    if errors > 0 {
        crate::cmd::server::system_exit_code(1);
    }
}
