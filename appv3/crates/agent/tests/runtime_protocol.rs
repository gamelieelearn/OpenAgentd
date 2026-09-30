//! The runtime protocol reaches every agent, whatever its own prompt says:
//! the rules come from the runtime, not from the agent file.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::prompts;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{store, Agent};
use appv3_providers::mock::MockProvider;
use appv3_providers::{ChatMessage, LlmProvider};
use std::path::Path;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// Settings are process-wide, so every test shares one set of roots.
fn root() -> &'static Path {
    static ROOT: OnceLock<tempfile::TempDir> = OnceLock::new();
    ROOT.get_or_init(|| {
        let root = tempfile::tempdir().unwrap();
        for (k, d) in [
            ("OPENAGENTD_DATA_DIR", "data"),
            ("OPENAGENTD_CONFIG_DIR", "config"),
            ("OPENAGENTD_STATE_DIR", "state"),
            ("OPENAGENTD_CACHE_DIR", "cache"),
            ("OPENAGENTD_WORKSPACE_DIR", "ws"),
        ] {
            std::env::set_var(k, root.path().join(d));
        }
        std::env::set_var("HOME", root.path().join("home"));
        appv3_core::settings::install(appv3_core::settings::Settings::from_env());
        let mem = root.path().join("config").join("memory");
        std::fs::create_dir_all(&mem).unwrap();
        std::fs::write(mem.join("preferences.md"), "# User Preferences\n\n- Use Bun, not npm.\n").unwrap();
        root
    })
    .path()
}

/// The system prompt of the first model call of one turn.
async fn system_prompt(name: &str, prompt: &str, delegated: bool) -> String {
    let root = root();
    let pool = appv3_db::create_pool(root.join(format!("{name}.db"))).await.unwrap();
    let ws = root.join("project");
    std::fs::create_dir_all(&ws).unwrap();
    let mock = Arc::new(MockProvider::new(vec![MockProvider::text("Done.")]));
    let provider: Arc<dyn LlmProvider> = mock.clone();
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let parent = if delegated {
        // A delegated turn reports back through the process-wide manager.
        appv3_agent::manager::init(pool.clone(), factory.clone());
        let id = uuid::Uuid::now_v7();
        appv3_db::create_session(&pool, appv3_db::NewSession { id: Some(id), workspace: ws.display().to_string(), ..Default::default() }).await.unwrap();
        Some(id.to_string())
    } else {
        None
    };
    let agent = Agent::new(provider, name, prompt, vec![], Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool, factory, parent);
    let sid = uuid::Uuid::now_v7().to_string();
    session.handle_user_message(UserMessage { content: "hi".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    if let Some(mut sub) = store().attach(&sid) {
        let _ = tokio::time::timeout(Duration::from_secs(10), async { while sub.next().await.is_some() {} }).await;
    }
    tokio::time::timeout(Duration::from_secs(10), session.wait_turn_finished()).await.expect("turn finishes");
    let calls = mock.calls.lock().unwrap();
    let (messages, _, _) = calls.first().expect("the model was called");
    match &messages[0] {
        ChatMessage::System { content, .. } => content.clone().unwrap_or_default(),
        other => panic!("first message is not the system prompt: {other:?}"),
    }
}

fn at(prompt: &str, needle: &str) -> usize {
    prompt.find(needle).unwrap_or_else(|| panic!("{needle:?} missing from system prompt:\n{prompt}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn custom_lead_agent_gets_the_runtime_and_memory_protocols() {
    let prompt = system_prompt("reviewer", "You are a custom reviewer.", false).await;
    let persona = at(&prompt, "You are a custom reviewer.");
    let protocol = at(&prompt, prompts::runtime_protocol());
    let memory_rules = at(&prompt, prompts::memory_protocol(true));
    let memory = at(&prompt, "<openagentd_memory>");
    assert!(persona < protocol && protocol < memory_rules && memory_rules < memory, "order: {persona} {protocol} {memory_rules} {memory}");
    assert!(prompt.contains("- Use Bun, not npm."), "preferences are pinned");
    assert!(!prompt.contains(prompts::memory_protocol(false)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn delegated_agent_gets_read_only_memory_rules() {
    let prompt = system_prompt("explorer", "You are an explorer.", true).await;
    at(&prompt, prompts::runtime_protocol());
    at(&prompt, prompts::memory_protocol(false));
    assert!(!prompt.contains(prompts::memory_protocol(true)), "a subagent must not be told to save memory");
}

#[test]
fn protocol_texts_are_distinct_and_present() {
    for text in [prompts::runtime_protocol(), prompts::memory_protocol(true), prompts::memory_protocol(false)] {
        assert!(!text.is_empty());
    }
    assert_ne!(prompts::memory_protocol(true), prompts::memory_protocol(false));
    // The rules moved out of the built-in prompt, so custom prompts get them too.
    assert!(!prompts::coding_prompt().contains("## Persistent memory"));
    assert!(!prompts::coding_prompt().contains("git reset --hard"));
}
