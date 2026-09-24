//! `openagentd lsp status|install` — port of `app/cli/commands/lsp.py`.

use crate::argparse::Ns;
use crate::cmd::server::{ns_bool, ns_str};
use crate::pystr::system_exit;

fn print_status(st: &appv3_tools::lsp::ManagedLspStatus) {
    use appv3_tools::lsp::managed::{TYPESCRIPT_LANGUAGE_SERVER_VERSION, TYPESCRIPT_VERSION};
    let m = appv3_tools::lsp::managed_lsp_tools();
    println!("\n  OpenAgentd LSP tools\n");
    for (name, available) in [("ty", st.ty_available), ("ruff", st.ruff_available)] {
        let suffix = m.python_tool_version(name).map(|v| format!(" (managed {v})")).unwrap_or_default();
        println!("  Python {name:<4}: {}{suffix}", if available { "ready" } else { "missing" });
    }
    println!("  TypeScript:    {} (language-server {TYPESCRIPT_LANGUAGE_SERVER_VERSION}, typescript {TYPESCRIPT_VERSION})", st.state);
    if let Some(d) = st.detail.as_deref().filter(|d| !d.is_empty()) {
        println!("  Detail:        {d}");
    }
    if !st.downloads_enabled {
        println!("  Downloads:     disabled by OPENAGENTD_DISABLE_LSP_DOWNLOAD");
    }
    println!();
}

pub fn cmd_lsp(ns: &Ns) {
    use appv3_tools::lsp::managed::InstallError;
    let m = appv3_tools::lsp::managed_lsp_tools();
    match ns_str(ns, "lsp_action") {
        Some("status") => print_status(&m.status()),
        Some("install") => {
            let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
            if ns_str(ns, "component") == Some("typescript") {
                match rt.block_on(m.install_typescript()) {
                    Ok(st) => print_status(&st),
                    Err(InstallError::Other(_)) => system_exit("TypeScript LSP installation failed; check backend logs."),
                    Err(e) => system_exit(&format!("TypeScript LSP installation failed: {e}")),
                }
            } else {
                let Some(tool) = ns_str(ns, "tool").filter(|t| *t == "ruff" || *t == "ty") else {
                    system_exit("Usage: openagentd lsp install python <ruff|ty> [--version X] [--force]");
                };
                match rt.block_on(m.install_python_tool(tool, ns_str(ns, "version"), ns_bool(ns, "force"))) {
                    Ok(cmd) => {
                        println!("Installed {tool} -> {}", cmd.join(" "));
                        print_status(&m.status());
                    }
                    Err(e @ (InstallError::Runtime(_) | InstallError::Value(_))) => system_exit(&format!("Python LSP installation failed: {e}")),
                    Err(_) => system_exit("Python LSP installation failed; check backend logs."),
                }
            }
        }
        _ => system_exit("Unknown LSP command"),
    }
}
