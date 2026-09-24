//! `app/cli/main.py::build_parser` (+ `commands/serve.py::_add_serve_subparser`).

use crate::argparse::{Action, Parser, Val};

fn func(p: &mut Parser, name: &str) {
    p.set_default("func", Val::Str(name.into()));
}

fn add_start_flags(p: &mut Parser, include_key: bool, include_wait: bool) {
    p.add(Action::store(&["--host"]).suppress().help("Bind host (default: server.yaml host)"));
    p.add(Action::store(&["--port"]).int().suppress().help("API port (default: server.yaml port)"));
    if include_key {
        p.add(Action::store_true(&["--key"]).suppress().help("Prompt for an access key required by external clients."));
    }
    if include_wait {
        p.add(Action::store_true(&["--wait"]).suppress().help("Wait/poll until the background server is fully started and ready."));
    }
}

const EPILOG: &str = concat!(
    "Examples:\n",
    "  openagentd server start --host 0.0.0.0 --key  # start for mobile/LAN clients\n",
    "  openagentd server status             # check the background server\n",
    "  openagentd auth copilot              # authenticate with an OAuth provider\n",
    "  openagentd run --prompt 'Summarize this project'  # run an agent once\n",
    "  openagentd transfer migrate openclaw --from ~/.openclaw/workspace --model openai:gpt-5.5\n",
    "  openagentd transfer export           # pack config for migration\n",
    "  openagentd doctor                    # check system health\n",
    "  openagentd lsp status                # inspect managed language servers\n",
    "  openagentd upgrade                   # upgrade to the latest version\n",
);

pub fn build_parser() -> Parser {
    let mut parser = Parser::new("openagentd");
    parser.description = Some("OpenAgentd — on-machine coding agent".into());
    parser.epilog = Some(EPILOG.into());
    parser.raw = true;
    parser.add(Action::version(&["--version"], format!("openagentd v{}", appv3_core::VERSION)));
    func(&mut parser, "start");
    for (k, v) in [("host", Val::None), ("port", Val::None), ("key", Val::Bool(false)), ("wait", Val::Bool(false))] {
        parser.set_default(k, v);
    }
    parser.add_subparsers("command", false, Some("command"));

    parser.add_parser("transfer", Some("Move agent configuration between installations"), |t| {
        t.add_subparsers("transfer_action", true, None);
        t.add_parser("migrate", Some("Import agent config from another local agent tool"), |p| {
            p.add(Action::store(&["source"]).choices(&["openclaw", "hermes"]).help("Source format to import"));
            p.add(Action::store(&["--from"]).dest("from_dir").help("Source directory (defaults to ~/.openclaw/workspace or ~/.hermes)"));
            p.add(Action::store(&["--model"]).required().help("OpenAgentd model id, e.g. openai:gpt-5.5"));
            p.add(Action::store(&["--config-dir"]).help("OpenAgentd config directory (default: XDG config)"));
            p.add(Action::store_true(&["--force"]).help("Replace an existing imported agent file"));
            func(p, "migrate");
        });
        // export / import are registered after `upgrade` in v2; order only
        // matters within `transfer`, where migrate comes first.
        t.add_parser("export", Some("Pack config for migration to another server (agents, skills, commands, …)"), |p| {
            p.description = Some(
                "Creates a .tar.gz archive of your portable config layer — agents, skills,\n\
                 commands, plugins, mcp.json, settings.yaml, server.yaml, multimodal.yaml, and .env.\n\
                 \n\
                 Secrets in .env and server.yaml are redacted by default so the archive is safe to\n\
                 copy over untrusted channels. Use --include-secrets to embed them verbatim."
                    .into(),
            );
            p.raw = true;
            p.add(Action::store(&["--output"]).metavar("PATH").help("Archive path (default: openagentd-export-<TIMESTAMP>.tar.gz in CWD)"));
            p.add(
                Action::store_true(&["--include-secrets"])
                    .dest("include_secrets")
                    .help("Embed API keys verbatim instead of redacting them (use over trusted channels only)"),
            );
            p.add(Action::store(&["--config-dir"]).metavar("DIR").dest("config_dir").help("Config directory to export (default: XDG config)"));
            func(p, "export");
        });
        t.add_parser("import", Some("Unpack a migration archive on the target server"), |p| {
            p.description = Some(
                "Extracts an archive produced by `openagentd transfer export` into your config\n\
                 directory. Existing files are kept by default (fill-in-gaps); pass\n\
                 --force to overwrite them."
                    .into(),
            );
            p.raw = true;
            p.add(Action::store(&["archive"]).metavar("ARCHIVE").help("Path to the .tar.gz archive produced by `openagentd transfer export`"));
            p.add(Action::store_true(&["--force"]).help("Overwrite files that already exist in the config directory"));
            p.add(Action::store(&["--config-dir"]).metavar("DIR").dest("config_dir").help("Config directory to import into (default: XDG config)"));
            func(p, "import");
        });
    });

    parser.add_parser("auth", Some("Authenticate with an OAuth-based LLM provider"), |p| {
        p.add(Action::store(&["provider"]).optional().help("Provider to authenticate (e.g. copilot)"));
        p.add(Action::store_true(&["--list"]).dest("list_providers").help("List available OAuth providers"));
        p.add(Action::store_true(&["--device"]).help("Use the headless device-code flow when the provider supports it"));
        func(p, "auth");
    });

    parser.add_parser("server", Some("Run and inspect the API server"), |s| {
        s.add_subparsers("server_action", true, None);
        s.add_parser("start", Some("Start the background server"), |p| {
            add_start_flags(p, true, true);
            func(p, "start");
        });
        s.add_parser("serve", Some("Foreground server for desktop shells / embedding"), |p| {
            p.description = Some(
                "Run the API server in the foreground. Intended for embedding (Tauri desktop shell, CI smoke tests). \
                 For a backgrounded daemon use 'openagentd server start' instead."
                    .into(),
            );
            p.add(Action::store(&["--host"]).default(Val::Str("127.0.0.1".into())).help("Bind host (default: 127.0.0.1 — desktop must stay local)."));
            p.add(Action::store(&["--port"]).int().default(Val::Int(0)).help("Bind port. 0 (default) picks an OS-assigned ephemeral port."));
            p.add(Action::store_true(&["--handshake"]).help("Emit a single JSON line on stdout once bound (for Tauri/IPC)."));
            p.add(
                Action::store_true(&["--generate-token"])
                    .help("Generate a random desktop session token and require it for API access. The token is included in the handshake line."),
            );
            p.add(
                Action::store(&["--parent-pid"])
                    .int()
                    .help("Exit if the given PID is no longer alive. Used by the desktop shell to clean up the backend when it crashes."),
            );
            func(p, "serve");
        });
        s.add_parser("stop", Some("Stop the background server"), |p| func(p, "stop"));
        s.add_parser("restart", Some("Restart the background server"), |p| {
            add_start_flags(p, true, true);
            func(p, "restart");
        });
        s.add_parser("status", Some("Show whether the server is running and its network addresses"), |p| {
            add_start_flags(p, false, false);
            func(p, "status");
        });
        s.add_parser("health", Some("Run server and mobile diagnostics"), |p| {
            add_start_flags(p, false, false);
            func(p, "health");
        });
        s.add_parser("logs", Some("Tail the server log"), |p| {
            p.add(Action::store(&["-n", "--lines"]).int().default(Val::Int(50)).help("Lines to show initially (default: 50)"));
            func(p, "logs");
        });
    });

    parser.add_parser("lsp", Some("Inspect or install managed LSP tools"), |l| {
        l.add_subparsers("lsp_action", true, None);
        l.add_parser("status", Some("Show managed LSP tool status"), |_| {});
        l.add_parser("install", Some("Install a managed LSP component"), |p| {
            p.add(Action::store(&["component"]).choices(&["typescript", "python"]));
            p.add(Action::store(&["tool"]).optional().choices(&["ruff", "ty"]).help("Python tool to install (ruff | ty) — required for component=python"));
            p.add(Action::store(&["--version"]).help("Exact PyPI version to install (default: latest when unpinned)"));
            p.add(Action::store_true(&["--force"]).help("Re-download even when the version is already installed"));
        });
        func(l, "lsp");
    });

    parser.add_parser("doctor", Some("Check system health and report issues"), |p| func(p, "doctor"));

    parser.add_parser("run", Some("Run an agent in the current directory and print the response"), |p| {
        p.add(Action::store(&["--prompt"]).required().help("Prompt to send to the agent"));
        p.add(Action::store(&["--model"]).help("Model override, e.g. openai:gpt-5.5"));
        p.add(Action::store(&["--thinking"]).help("Provider-neutral thinking level override"));
        func(p, "run");
    });

    parser.add_parser("cleanup", Some("Dry-run cleanup for generated artifacts"), |p| {
        p.add(Action::store(&["--older-than-days"]).int().default(Val::Int(14)).help("Only delete artifacts older than this many days (default: 14)"));
        p.add(Action::store_false(&["--apply"]).dest("dry_run").help("Delete the listed artifacts instead of only printing them"));
        p.add(Action::store(&["--limit"]).int().default(Val::Int(50)).help("Maximum candidate paths to print (default: 50)"));
        p.add(
            Action::store_true(&["--vacuum"])
                .help("Rebuild the SQLite file so pages freed by deleted rows return to the OS (requires --apply; skipped on dry runs)"),
        );
        func(p, "cleanup");
        p.set_default("dry_run", Val::Bool(true));
    });

    parser.add_parser("upgrade", Some("Upgrade openagentd to the latest version"), |p| func(p, "upgrade"));
    parser
}
