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
