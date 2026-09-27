//! A reasoning turn persists how long the model thought
//! (`extra.thinking_duration_ms`), which the transcript shows as
//! "Thought for Ns". Its own binary: the env and settings are process-global.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{store, Agent};
use appv3_providers::mock::{MockProvider, MockTurn};
use appv3_providers::{ChatCompletionChunk, ChatCompletionDelta, LlmProvider, Usage};
use std::sync::Arc;
use std::time::Duration;

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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reasoning_turn_records_how_long_the_model_thought() {
    let root = tempfile::tempdir().unwrap();
    setup_env(root.path());
    let pool = appv3_db::create_pool(root.path().join("oad.db")).await.unwrap();
    let ws = root.path().join("project");
    std::fs::create_dir_all(&ws).unwrap();

    let delta = |d: ChatCompletionDelta| ChatCompletionChunk::delta("mock", "mock", d, None, None);
    let turn = MockTurn::Chunks(vec![
        delta(ChatCompletionDelta { reasoning_content: Some("Let me think.".into()), ..Default::default() }),
        delta(ChatCompletionDelta { content: Some("Done.".into()), ..Default::default() }),
        ChatCompletionChunk::delta(
            "mock",
            "mock",
            ChatCompletionDelta::default(),
            Some("stop".into()),
            Some(Usage { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, ..Default::default() }),
        ),
    ]);
    let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(vec![turn]));
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let agent = Agent::new(provider.clone(), "code", "You are a test agent.", vec![], Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);

    let sid = uuid::Uuid::now_v7().to_string();
    session.handle_user_message(UserMessage { content: "think".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    let mut sub = store().attach(&sid).expect("turn is streaming");
    tokio::time::timeout(Duration::from_secs(10), async { while sub.next().await.is_some() {} }).await.expect("stream ends with done");
    session.wait_turn_finished().await;

    let rows = appv3_db::llm_window_rows(&pool, &sid, false).await.unwrap();
    let extra = rows[1].extra_json().unwrap();
    let thought = extra.get("thinking_duration_ms").and_then(|v| v.as_f64()).expect("thinking_duration_ms recorded");
    let total = extra.get("duration_ms").and_then(|v| v.as_f64()).unwrap();
    assert!((0.0..=total).contains(&thought), "thought {thought}ms of {total}ms");
}
