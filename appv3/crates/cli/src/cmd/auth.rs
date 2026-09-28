//! `openagentd auth` — port of `app/cli/commands/auth.py`.

use crate::argparse::Ns;
use crate::cmd::server::{ns_bool, ns_str};

const PROVIDERS: &[(&str, &str)] = &[
    ("copilot", "GitHub Copilot — device-flow OAuth"),
    ("codex", "OpenAI Codex — PKCE OAuth (ChatGPT subscription)"),
    ("grok", "Grok Build — device-flow OAuth (Grok subscription)"),
];

fn list_providers() {
    println!("Available OAuth providers:\n");
    let mut sorted: Vec<_> = PROVIDERS.to_vec();
    sorted.sort();
    for (name, desc) in sorted {
        println!("  {name:<15}  {desc}");
    }
    let names: Vec<&str> = PROVIDERS.iter().map(|(n, _)| *n).collect();
    println!("\nUsage: openagentd auth <{}>", names.join("|"));
}

pub fn cmd_auth(ns: &Ns) {
    let provider = ns_str(ns, "provider").filter(|p| !p.is_empty());
    let Some(provider) = provider.filter(|_| !ns_bool(ns, "list_providers")) else {
        list_providers();
        return;
    };
    if !PROVIDERS.iter().any(|(n, _)| *n == provider) {
        println!("Unknown provider: '{provider}'");
        list_providers();
        crate::cmd::server::system_exit_code(1);
    }
    let device = ns_bool(ns, "device");
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    let res = rt.block_on(async move {
        match provider {
            "copilot" => appv3_providers::copilot::login(None, None).await,
            "codex" => appv3_providers::codex::login(None, device, false).await,
            _ => appv3_providers::grok::login(None).await,
        }
    });
    if let Err(e) = res {
        if !appv3_providers::codex::cli_failure_reported() {
            crate::pystr::uncaught("RuntimeError", &e);
        }
        crate::cmd::server::system_exit_code(1);
    }
}
