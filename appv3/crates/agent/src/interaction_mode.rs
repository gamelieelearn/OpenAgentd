//! Session interaction modes — port of `app/agent/interaction_mode.py` and
//! `app/services/session_interaction_mode.py`.

use anyhow::{anyhow, Result};
use appv3_db::{self as db, DbPool, NewMessage};
use serde_json::{json, Map, Value};

pub const PLAN_MODE_ALLOWED_TOOLS: [&str; 9] = ["ask_user", "delegate", "glob", "grep", "read", "shell", "skill", "web_fetch", "web_search"];

pub fn normalize(value: &str) -> &'static str {
    if value == "plan" {
        "plan"
    } else {
        "code"
    }
}

pub fn tool_allowed_in_mode(mode: &str, tool: &str) -> bool {
    mode != "plan" || PLAN_MODE_ALLOWED_TOOLS.contains(&tool)
}

pub fn transition_instruction(mode: &str) -> &'static str {
    crate::prompts::s(if mode == "plan" { "mode_plan" } else { "mode_code" })
}

async fn has_mode_prompt(pool: &DbPool, sid: &str, mode: &str) -> Result<bool> {
    let rows: Vec<Option<String>> =
        sqlx::query_scalar("SELECT extra FROM session_messages WHERE session_id = ? AND kind = 'note'").bind(db::codec::db_id(sid)).fetch_all(pool).await?;
    Ok(rows.iter().any(|e| {
        let v = db::codec::json_col(e.as_deref());
        v.as_ref().and_then(|v| v.get("interaction_mode")).and_then(|m| m.as_str()) == Some(mode)
            && v.as_ref().and_then(|v| v.get("interaction_mode_prompt")) == Some(&Value::Bool(true))
    }))
}

async fn append_mode_prompt(pool: &DbPool, sid: &str, mode: &str, transition: bool) -> Result<()> {
    let mut extra = Map::new();
    extra.insert("hidden_from_user".into(), json!(true));
    extra.insert("interaction_mode".into(), json!(mode));
    extra.insert("interaction_mode_prompt".into(), json!(true));
    if transition {
        extra.insert("interaction_mode_transition".into(), json!(true));
    }
    db::save_message(pool, sid, NewMessage { kind: Some("note".into()), pinned: Some(true), extra: Some(extra), ..NewMessage::user(transition_instruction(mode)) }).await?;
    db::bump_history_revision(pool, sid, true).await
}

/// `ensure_session_interaction_mode_prompt`.
pub async fn ensure_prompt(pool: &DbPool, sid: &str, mode: &str) -> Result<bool> {
    if mode != "plan" || has_mode_prompt(pool, sid, mode).await? {
        return Ok(false);
    }
    append_mode_prompt(pool, sid, mode, false).await?;
    Ok(true)
}

/// `set_session_interaction_mode` → `(session, changed)`.
pub async fn set_mode(pool: &DbPool, sid: &str, mode: &str) -> Result<(db::ChatSession, bool)> {
    let session = db::get_session(pool, sid).await?.ok_or_else(|| anyhow!("Session not found."))?;
    if session.parent_session_id.is_some() {
        return Err(anyhow!("Session not found."));
    }
    if session.interaction_mode == mode {
        return Ok((session, false));
    }
    db::update_session(pool, sid, db::SessionUpdate { interaction_mode: Some(mode.to_string()), ..Default::default() }).await?;
    append_mode_prompt(pool, sid, mode, true).await?;
    let s = db::get_session(pool, sid).await?.ok_or_else(|| anyhow!("Session not found."))?;
    Ok((s, true))
}

/// Align a subagent session with its lead's current mode; returns the mode.
///
/// Members persist across delegations and each turn reads the member's own
/// row, so a mode copied at spawn goes stale when the lead switches: a member
/// spawned in Code mode could still edit files after the lead entered Plan
/// mode, where `delegate` stays available. The member gets the same
/// transition note its lead got.
pub async fn follow_lead(pool: &DbPool, sid: &str, session: &db::ChatSession) -> Result<&'static str> {
    let own = normalize(&session.interaction_mode);
    let Some(lead_id) = session.parent_session_id.as_deref() else {
        return Ok(own);
    };
    let Some(lead) = db::get_session(pool, lead_id).await? else {
        return Ok(own);
    };
    let mode = normalize(&lead.interaction_mode);
    if mode != own {
        db::update_session(pool, sid, db::SessionUpdate { interaction_mode: Some(mode.to_string()), ..Default::default() }).await?;
        append_mode_prompt(pool, sid, mode, true).await?;
    }
    Ok(mode)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn pool(dir: &tempfile::TempDir) -> DbPool {
        db::create_pool(dir.path().join("oad.db")).await.unwrap()
    }

    async fn session(pool: &DbPool, parent: Option<&str>, mode: &str) -> String {
        let id = uuid::Uuid::now_v7();
        db::create_session(
            pool,
            db::NewSession { id: Some(id), parent_session_id: parent.map(String::from), workspace: "/tmp/ws".into(), interaction_mode: Some(mode.into()), ..Default::default() },
        )
        .await
        .unwrap();
        id.to_string()
    }

    async fn mode_notes(pool: &DbPool, sid: &str) -> Vec<String> {
        let rows = db::llm_window_rows(pool, sid, false).await.unwrap();
        rows.iter()
            .filter_map(|r| {
                let e = r.extra_json()?;
                (e.get("interaction_mode_prompt") == Some(&Value::Bool(true))).then(|| e["interaction_mode"].as_str().unwrap_or_default().to_string())
            })
            .collect()
    }

    async fn follow(pool: &DbPool, sid: &str) -> &'static str {
        let row = db::get_session(pool, sid).await.unwrap().unwrap();
        follow_lead(pool, sid, &row).await.unwrap()
    }

    /// A member spawned in Code mode must not keep write access after the
    /// lead enters Plan mode (`delegate` stays available in Plan mode).
    #[tokio::test]
    async fn subagent_enters_plan_mode_with_its_lead() {
        let dir = tempfile::tempdir().unwrap();
        let pool = pool(&dir).await;
        let lead = session(&pool, None, "code").await;
        let child = session(&pool, Some(&lead), "code").await;
        set_mode(&pool, &lead, "plan").await.unwrap();

        assert_eq!(follow(&pool, &child).await, "plan");
        assert_eq!(db::get_session(&pool, &child).await.unwrap().unwrap().interaction_mode, "plan");
        assert_eq!(mode_notes(&pool, &child).await, vec!["plan"]);
    }

    #[tokio::test]
    async fn subagent_leaves_plan_mode_with_its_lead() {
        let dir = tempfile::tempdir().unwrap();
        let pool = pool(&dir).await;
        let lead = session(&pool, None, "plan").await;
        let child = session(&pool, Some(&lead), "plan").await;
        ensure_prompt(&pool, &child, "plan").await.unwrap();
        set_mode(&pool, &lead, "code").await.unwrap();

        assert_eq!(follow(&pool, &child).await, "code");
        assert_eq!(db::get_session(&pool, &child).await.unwrap().unwrap().interaction_mode, "code");
        assert_eq!(mode_notes(&pool, &child).await, vec!["plan", "code"]);
    }

    #[tokio::test]
    async fn following_an_unchanged_lead_adds_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let pool = pool(&dir).await;
        let lead = session(&pool, None, "plan").await;
        let child = session(&pool, Some(&lead), "plan").await;
        ensure_prompt(&pool, &child, "plan").await.unwrap();

        assert_eq!(follow(&pool, &child).await, "plan");
        assert_eq!(follow(&pool, &lead).await, "plan");
        assert_eq!(mode_notes(&pool, &child).await, vec!["plan"]);
        assert!(mode_notes(&pool, &lead).await.is_empty());
    }
}
