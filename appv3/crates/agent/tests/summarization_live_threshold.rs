//! The summarization trigger must follow `settings.yaml` edits made while a
//! turn is running, not the value read when the turn started.

use appv3_agent::hooks::summarization::build_summarization_hook;
use appv3_agent::hooks::{AgentState, Hook, ModelRequest, RunContext};
use appv3_core::runtime_settings::{load_runtime_settings, save_runtime_settings};
use appv3_providers::mock::MockProvider;
use appv3_providers::ChatMessage;
use std::sync::Arc;

fn setup_env(root: &std::path::Path) {
    for (k, d) in [
        ("OPENAGENTD_DATA_DIR", "data"),
        ("OPENAGENTD_CONFIG_DIR", "config"),
        ("OPENAGENTD_STATE_DIR", "state"),
        ("OPENAGENTD_CACHE_DIR", "cache"),
        ("OPENAGENTD_WORKSPACE_DIR", "ws"),
    ] {
        std::env::set_var(k, root.join(d));
    }
    std::env::set_var("HOME", root.join("home"));
    appv3_core::settings::install(appv3_core::settings::Settings::from_env());
}

fn set_threshold(value: i64) {
    let mut cfg = load_runtime_settings().unwrap();
    cfg.summarization.prompt_token_threshold = Some(value);
    save_runtime_settings(&cfg).unwrap();
}

fn ctx() -> RunContext {
    RunContext { session_id: None, run_id: "run".into(), agent_name: "code".into(), workspace: None }
}

/// One model call at `prompt_tokens`; returns whether the hook compacted.
async fn model_call_compacts(hook: &dyn Hook, prompt_tokens: i64) -> bool {
    let mut state = AgentState::new(vec![ChatMessage::user("Refactor the settings page."), ChatMessage::assistant("Reading the current code.")], String::new());
    state.usage.last_prompt_tokens = prompt_tokens;
    let req = ModelRequest { messages: state.messages_for_llm(), system_prompt: String::new() };
    hook.before_model(&ctx(), &mut state, &req).await;
    hook.before_model_call(&ctx(), &mut state, "sys").await
}

#[tokio::test]
async fn threshold_change_applies_to_the_running_turn() {
    let root = tempfile::tempdir().unwrap();
    setup_env(root.path());
    std::fs::create_dir_all(root.path().join("config")).unwrap();

    // Turn starts with a 15k trigger…
    set_threshold(15_000);
    let provider = Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")]));
    let hook = build_summarization_hook(provider, "coding", Some("mock:mock"), true).expect("hook enabled");

    // …and the user raises it to 50k mid-turn: a 20k prompt must not compact.
    set_threshold(50_000);
    assert!(!model_call_compacts(&hook, 20_000).await, "compacted at 20k after the trigger was raised to 50k");

    // Lowering it again mid-turn takes effect on the next model call too.
    set_threshold(15_000);
    assert!(model_call_compacts(&hook, 20_000).await, "did not compact at 20k after the trigger was lowered to 15k");
}
