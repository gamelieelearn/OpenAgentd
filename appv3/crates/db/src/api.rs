//! Row → wire JSON, matching v2's Pydantic response models field-for-field
//! (declaration order, `_ExcludeNoneModel` null-stripping, UUID/datetime
//! rendering). Keep in sync with `app/api/schemas/*.py`.

use crate::codec::{api_dt, api_uuid, parse_dt, py_isoformat};
use crate::models::{
    kind, ChatSession, CodingWorkspace, PendingQuestion, ScheduledTask, SessionMessage,
};
use serde_json::{Map, Value};

/// Live, non-persisted session state merged into `SessionResponse`.
#[derive(Debug, Default, Clone)]
pub struct SessionOverlay {
    pub running: bool,
    pub needs_input: bool,
    pub pending_interaction_mode: Option<String>,
    pub estimated_cost_usd: Option<f64>,
    pub completion_tokens: Option<i64>,
    pub agent_name: Option<String>,
    pub subagents: Vec<Value>,
}

fn put(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(v) = value {
        if !v.is_null() {
            map.insert(key.to_string(), v);
        }
    }
}

/// `SessionResponse` (an `_ExcludeNoneModel`).
pub fn session_response(s: &ChatSession, o: &SessionOverlay) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("id".into(), Value::String(api_uuid(&s.id)));
    put(&mut m, "parent_session_id", s.parent_session_id.as_deref().map(|p| Value::String(api_uuid(p))));
    put(&mut m, "title", s.title.clone().map(Value::String));
    let agent_name = o.agent_name.clone().or_else(|| s.agent_name.clone());
    put(&mut m, "agent_name", agent_name.map(Value::String));
    put(&mut m, "scheduled_task_name", s.scheduled_task_name.clone().map(Value::String));
    m.insert("workspace".into(), Value::String(s.workspace.clone()));
    let mode = if s.interaction_mode == "plan" { "plan" } else { "code" };
    m.insert("interaction_mode".into(), Value::String(mode.into()));
    put(&mut m, "pending_interaction_mode", o.pending_interaction_mode.clone().map(Value::String));
    put(&mut m, "model", s.model.clone().map(Value::String));
    put(&mut m, "thinking_level", s.thinking_level.clone().map(Value::String));
    put(&mut m, "revert", s.revert_json());
    m.insert("running".into(), Value::Bool(o.running));
    put(&mut m, "estimated_cost_usd", o.estimated_cost_usd.map(|c| serde_json::json!(c)));
    put(&mut m, "completion_tokens", o.completion_tokens.map(|c| serde_json::json!(c)));
    m.insert("needs_input".into(), Value::Bool(o.needs_input));
    m.insert("subagents".into(), Value::Array(o.subagents.clone()));
    m.insert("created_at".into(), Value::String(api_dt(&s.created_at)));
    m.insert("updated_at".into(), Value::String(api_dt(&s.updated_at)));
    m
}

const INTERNAL_ATTACHMENT_FIELDS: [&str; 3] = ["converted_text", "path", "workspace_path"];
const DISPLAY_STRIPPED_EXTRA_FIELDS: [&str; 1] = ["parts"];

/// `MessageResponse` via `_message_response` (strips `extra.parts`, internal
/// attachment fields, and continuation reasoning).
pub fn message_response(r: &SessionMessage) -> Map<String, Value> {
    let mut extra = r.extra_json();
    let mut reasoning = r.reasoning_content.clone();
    let mut attachments: Option<Value> = None;
    let mut file_message = false;
    let mut stripped = false;

    if let Some(Value::Object(ref mut e)) = extra {
        if e.get("is_continuation").map(truthy).unwrap_or(false) {
            reasoning = None;
        }
        for key in DISPLAY_STRIPPED_EXTRA_FIELDS {
            stripped |= e.remove(key).is_some();
        }
        if let Some(Value::Array(atts)) = e.get("attachments") {
            let public: Vec<Value> = atts
                .iter()
                .map(|a| match a {
                    Value::Object(obj) => Value::Object(
                        obj.iter()
                            .filter(|(k, _)| !INTERNAL_ATTACHMENT_FIELDS.contains(&k.as_str()))
                            .map(|(k, v)| (k.clone(), v.clone()))
                            .collect(),
                    ),
                    other => other.clone(),
                })
                .collect();
            e.insert("attachments".into(), Value::Array(public.clone()));
            attachments = Some(Value::Array(public));
            file_message = true;
        }
    }
    // Only the display-stripping branch collapses `{}` to None (v2 does
    // `resp.extra = extra or None` there); an extra stored as `{}` stays `{}`.
    if stripped && matches!(extra, Some(Value::Object(ref e)) if e.is_empty()) {
        extra = None;
    }

    let mut m = Map::new();
    m.insert("id".into(), Value::String(api_uuid(&r.id)));
    m.insert("session_id".into(), Value::String(api_uuid(&r.session_id)));
    m.insert("role".into(), Value::String(r.role.clone()));
    put(&mut m, "content", r.content.clone().map(Value::String));
    put(&mut m, "reasoning_content", reasoning.map(Value::String));
    put(&mut m, "tool_calls", r.tool_calls_json());
    put(&mut m, "tool_call_id", r.tool_call_id.clone().map(Value::String));
    put(&mut m, "name", r.name.clone().map(Value::String));
    m.insert("seq".into(), serde_json::json!(r.seq));
    m.insert("kind".into(), Value::String(r.kind.clone()));
    m.insert("is_summary".into(), Value::Bool(r.kind == kind::SUMMARY));
    put(&mut m, "extra", extra);
    m.insert("created_at".into(), Value::String(api_dt(&r.created_at)));
    put(&mut m, "attachments", attachments);
    m.insert("file_message".into(), Value::Bool(file_message));
    m
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// `PendingQuestionResponse.from_row` (note: `created_at` is Python
/// `isoformat()`, i.e. `+00:00`, not `Z`).
pub fn pending_question_response(q: &PendingQuestion) -> Value {
    let created = parse_dt(&q.created_at)
        .map(|d| py_isoformat(&d))
        .unwrap_or_else(|| q.created_at.clone());
    serde_json::json!({
        "id": api_uuid(&q.id),
        "session_id": api_uuid(&q.session_id),
        "tool_call_id": q.tool_call_id,
        "questions": q.questions(),
        "created_at": created,
    })
}

fn opt_dt(v: &Option<String>) -> Value {
    v.as_deref().map(|d| Value::String(api_dt(d))).unwrap_or(Value::Null)
}

/// `ScheduledTaskResponse` (a plain `BaseModel` — nulls are kept).
pub fn scheduled_task_response(t: &ScheduledTask) -> Value {
    serde_json::json!({
        "id": api_uuid(&t.id),
        "slug": t.slug,
        "name": t.name,
        "workspace": t.workspace,
        "schedule_type": t.schedule_type,
        "at_datetime": opt_dt(&t.at_datetime),
        "every_seconds": t.every_seconds,
        "cron_expression": t.cron_expression,
        "timezone": t.timezone,
        "prompt": t.prompt,
        "session_id": t.session_id,
        "max_runs": t.max_runs,
        "enabled": t.enabled,
        "status": t.status,
        "run_count": t.run_count,
        "last_run_at": opt_dt(&t.last_run_at),
        "last_error": t.last_error,
        "next_fire_at": opt_dt(&t.next_fire_at),
        "created_at": api_dt(&t.created_at),
        "updated_at": api_dt(&t.updated_at),
    })
}

/// Display name for a coding workspace row (`row.name or Path(row.path).name`).
pub fn workspace_display_name(w: &CodingWorkspace) -> String {
    w.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| {
        std::path::Path::new(&w.path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
    })
}
