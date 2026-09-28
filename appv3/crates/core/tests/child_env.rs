//! The server reads its access token once, then removes it from the
//! process environment so no child process can inherit it (agent shell,
//! terminal, git hooks, `bun install` scripts, MCP servers, plugins).
//! Separate test binary: it mutates the process environment.

use appv3_core::auth::{is_desktop_session, scrub_child_env_secrets, CHILD_ENV_SECRETS};

#[test]
fn scrubbed_secrets_are_not_inherited_by_children() {
    for k in CHILD_ENV_SECRETS {
        std::env::set_var(k, "oad-leak-canary");
    }
    scrub_child_env_secrets();
    assert!(is_desktop_session(), "the desktop flag survives the scrub");
    for k in CHILD_ENV_SECRETS {
        assert!(std::env::var_os(k).is_none(), "{k} still set");
    }
    let out = if cfg!(windows) { std::process::Command::new("cmd").args(["/C", "set"]).output().unwrap() } else { std::process::Command::new("env").output().unwrap() };
    let env = String::from_utf8_lossy(&out.stdout);
    assert!(!env.contains("oad-leak-canary"), "{env}");
}
