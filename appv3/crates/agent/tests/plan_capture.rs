//! A lead Plan-mode turn saves its `<proposed_plan>` as the session plan file.

use appv3_agent::loader::ProviderFactory;
use appv3_agent::session::{AgentSession, UserMessage};
use appv3_agent::{store, Agent};
use appv3_providers::mock::MockProvider;
use appv3_providers::LlmProvider;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

const REPLY: &str = "I read the code.\n\n<proposed_plan>\n## Summary\nFix the bug.\n</proposed_plan>";

fn setup_env(root: &Path) {
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

/// Run one turn in a new session created in `mode`; returns the session id.
async fn run_turn(pool: &appv3_db::DbPool, ws: &Path, mode: &str) -> String {
    let provider: Arc<dyn LlmProvider> = Arc::new(MockProvider::new(vec![MockProvider::text(REPLY)]));
    let p2 = provider.clone();
    let factory: ProviderFactory = Arc::new(move |_, _| Ok(p2.clone()));
    let agent = Agent::new(provider, "code", "You are a test agent.", vec![], Some("mock:mock".into()));
    let session = AgentSession::new(agent, None, Some(ws.display().to_string()), pool.clone(), factory, None);

    let id = uuid::Uuid::now_v7();
    let new = appv3_db::NewSession { id: Some(id), workspace: ws.display().to_string(), interaction_mode: Some(mode.into()), ..Default::default() };
    appv3_db::create_session(pool, new).await.unwrap();
    let sid = id.to_string();
    session.handle_user_message(UserMessage { content: "hi".into(), session_id: sid.clone(), origin: "user".into(), ..Default::default() }).await.unwrap();
    let mut sub = store().attach(&sid).expect("turn is streaming");
    tokio::time::timeout(Duration::from_secs(10), async { while sub.next().await.is_some() {} }).await.expect("stream ends with done");
    session.wait_turn_finished().await;
    sid
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn only_plan_mode_turns_save_the_session_plan() {
    let root = tempfile::tempdir().unwrap();
    setup_env(root.path());
    let pool = appv3_db::create_pool(root.path().join("oad.db")).await.unwrap();
    let ws = root.path().join("project");
    std::fs::create_dir_all(&ws).unwrap();
    let plan_file = |sid: &str| root.path().join("data").join("sessions").join(sid).join(appv3_agent::plan::PLAN_FILENAME);

    let planned = run_turn(&pool, &ws, "plan").await;
    assert_eq!(std::fs::read_to_string(plan_file(&planned)).unwrap(), "## Summary\nFix the bug.\n");

    let coded = run_turn(&pool, &ws, "code").await;
    assert!(!plan_file(&coded).exists(), "a Code-mode turn must not write a plan");
}
