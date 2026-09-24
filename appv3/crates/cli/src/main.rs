//! `openagentd` (v3) — the Rust backend binary and a drop-in port of the v2
//! CLI (`app/cli/main.py`): the same argparse tree, help/usage/error texts,
//! and command behaviour. `server start` daemonises this binary's
//! `server serve` in place of uvicorn.

mod argparse;
mod cmd;
mod logging;
mod net;
mod parser;
mod paths;
mod pystr;
mod textwrap;
mod ui;

use argparse::Val;

fn main() {
    logging::mark_start();
    // `app/cli/__init__.py`: the installed CLI is a production launcher.
    if std::env::var_os("APP_ENV").is_none() {
        std::env::set_var("APP_ENV", "production");
    }
    let mut args: Vec<String> = std::env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()).collect();
    // Hidden v3-only alias: the desktop sidecar launches the Rust binary as
    // `openagentd serve …` (v2 only has `server serve`).
    if args.first().map(String::as_str) == Some("serve") {
        args.insert(0, "server".into());
    }
    let ns = parser::build_parser().parse_args(&args);
    let func = match ns.get("func") {
        Some(Val::Str(f)) => f.clone(),
        _ => "start".into(),
    };
    match func.as_str() {
        "start" => cmd::server::cmd_start(&ns),
        "stop" => cmd::server::cmd_stop(&ns),
        "restart" => cmd::server::cmd_restart(&ns),
        "status" => cmd::server::cmd_status(&ns),
        "health" => cmd::server::cmd_health(&ns),
        "logs" => cmd::server::cmd_logs(&ns),
        "serve" => {
            if let Err(e) = cmd::serve::cmd_serve(&ns) {
                pystr::uncaught("Error", &format!("{e:#}"));
            }
        }
        "auth" => cmd::auth::cmd_auth(&ns),
        "lsp" => cmd::lsp::cmd_lsp(&ns),
        "doctor" => cmd::doctor::cmd_doctor(),
        "run" => cmd::run::cmd_run(&ns),
        "cleanup" => cmd::cleanup::cmd_cleanup(&ns),
        "upgrade" => cmd::upgrade::cmd_upgrade(&ns),
        "migrate" => cmd::transfer::cmd_migrate(&ns),
        "export" => cmd::transfer::cmd_export(&ns),
        "import" => cmd::transfer::cmd_import(&ns),
        other => unreachable!("unknown command {other}"),
    }
    use std::io::Write;
    let _ = std::io::stdout().flush();
}
