//! `openagentd run` — port of `app/cli/commands/run.py`.

use crate::argparse::Ns;
use crate::cmd::server::ns_str;
use crate::pystr::{strip, system_exit};
use appv3_agent::{manager, service, stream_store};
use serde_json::Value;

enum RunErr {
    Exit(String),
    Other,
}

impl<E: std::fmt::Display> From<E> for RunErr {
    fn from(e: E) -> Self {
        tracing::error!("cli_run_failed error={}", e);
        RunErr::Other
    }
}

fn normalized(v: Option<&str>) -> Option<String> {
    v.map(strip).filter(|s| !s.is_empty()).map(String::from)
}

async fn run(prompt: String, model: Option<String>, thinking: Option<String>) -> Result<(), RunErr> {
    if strip(&prompt).is_empty() {
        return Err(RunErr::Exit("--prompt must not be blank.".into()));
    }
    if let Some(m) = &model {
        if !appv3_api::providers::is_registered_model_id(m) {
            return Err(RunErr::Exit("Choose a model from the registry.".into()));
        }
    }
    appv3_api::startup::ensure_workspace_initialized()?;
    let pool = appv3_db::pool::create_pool(&appv3_core::settings().database_path).await?;
    manager::init(pool.clone(), appv3_agent::loader::default_provider_factory());

    let session_id = uuid::Uuid::now_v7().to_string();
    let cwd = std::env::current_dir()?.display().to_string();
    let workspace = manager::validate_workspace(&cwd, true).map_err(|e| anyhow::anyhow!(e))?;
    let Some(session) = manager::get_or_start_agent_session(&workspace, Some(&session_id)).await? else {
        return Err(RunErr::Exit("No agent configured.".into()));
    };
    let (session_id, _, _) = service::dispatch_user_message(
        &session,
        service::Dispatch { content: prompt, session_id: Some(session_id), workspace: Some(workspace), model, thinking_level: thinking, ..Default::default() },
    )
    .await?;

    let mut wrote_text = false;
    let mut terminal_error: Option<String> = None;
    let lead_name = session.name();
    if let Some(mut sub) = stream_store::store().attach(&session_id) {
        while let Some(ev) = sub.next().await {
            let data: serde_json::Map<String, Value> = match serde_json::from_str::<Value>(&ev.data) {
                Ok(Value::Object(m)) => m,
                _ => Default::default(),
            };
            let s = |k: &str| data.get(k).and_then(|v| v.as_str()).filter(|v| !v.is_empty()).map(String::from);
            match ev.event.as_str() {
                "message" => {
                    let agent = data.get("agent").and_then(|v| v.as_str());
                    if agent.is_some_and(|a| a == lead_name || a == "openagentd" || a == "lead") {
                        if let Some(t) = s("text") {
                            use std::io::Write;
                            print!("{t}");
                            let _ = std::io::stdout().flush();
                            wrote_text = true;
                        }
                    }
                }
                "error" => terminal_error = Some(s("title").or_else(|| s("code")).unwrap_or_else(|| "Agent run failed".into())),
                "agent_not_configured" => terminal_error = Some(s("message").unwrap_or_else(|| "The agent is not configured.".into())),
                "question_asked" => {
                    service::interrupt_agent(&session, Some(&session_id)).await;
                    terminal_error = Some("Non-interactive run cannot answer agent questions.".into());
                    break;
                }
                _ => {}
            }
        }
    }
    if wrote_text {
        println!();
    }
    if let Some(e) = terminal_error {
        eprintln!("{e}");
        return Err(RunErr::Exit(e));
    }
    Ok(())
}

pub fn cmd_run(ns: &Ns) {
    appv3_core::env::init_env();
    appv3_core::env::load_config_env(&appv3_core::settings().config_dir);
    crate::logging::setup("ERROR", "DEBUG", true);
    let prompt = ns_str(ns, "prompt").unwrap_or("").to_string();
    let model = normalized(ns_str(ns, "model"));
    let thinking = normalized(ns_str(ns, "thinking"));
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().expect("tokio runtime");
    let res = rt.block_on(run(prompt, model, thinking));
    rt.shutdown_background();
    match res {
        Ok(()) => {}
        Err(RunErr::Exit(msg)) => system_exit(&msg),
        Err(RunErr::Other) => system_exit("Unable to run the agent; check backend logs."),
    }
}
