//! `questions.py`, `todos.py`, `permissions.py`, and the v3 session plan.

use super::helpers::get_or_start;
use crate::error::{loc, verr, ApiError, ApiResult};
use crate::util::*;
use crate::AppState;
use appv3_agent::{broadcaster, events, manager, store, Envelope};
use appv3_db::{self as db, DbPool};
use axum::extract::{Path as AxPath, State};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use bytes::Bytes;
use serde_json::{json, Value};

pub const MAX_ANSWER_CHARS: usize = 2000;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/{session_id}/question", get(get_question))
        .route("/{session_id}/question/{question_id}/answer", post(answer))
        .route("/{session_id}/question/{question_id}/dismiss", post(dismiss))
        .route("/sessions/{session_id}/todos", get(todos))
        .route("/sessions/{session_id}/plan", get(get_plan).delete(delete_plan))
        .route("/{session_id}/permissions", get(list_permissions))
        .route("/{session_id}/permissions/{request_id}/reply", post(reply_permission))
}

async fn get_question(State(st): State<AppState>, AxPath(raw): AxPath<String>) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &raw)?;
    let q = db::get_pending_question(&st.pool, &sid).await?;
    Ok(json(json!({"question": q.map(|q| db::api::pending_question_response(&q))})))
}

async fn open_question(pool: &DbPool, sid: &str, qid: &str) -> ApiResult<db::PendingQuestion> {
    let row = db::get_pending_question(pool, sid).await?;
    match row {
        None => Err(ApiError::new(409, "Question is not open.")),
        Some(r) if db::codec::api_uuid(&r.id) != qid => Err(ApiError::new(404, "Question is not open.")),
        Some(r) => Ok(r),
    }
}

fn parse_answers(b: &Value) -> ApiResult<Vec<Vec<String>>> {
    let Some(v) = b.get("answers") else { return Err(ApiError::validation(vec![verr("missing", &loc(&["body", "answers"]), "Field required", b.clone())])) };
    let Some(groups) = v.as_array() else { return Err(ApiError::validation(vec![verr("list_type", &loc(&["body", "answers"]), "Input should be a valid list", v.clone())])) };
    let mut out = vec![];
    let mut errs = vec![];
    for (i, g) in groups.iter().enumerate() {
        match g.as_array() {
            None => errs.push(verr("list_type", &[json!("body"), json!("answers"), json!(i)], "Input should be a valid list", g.clone())),
            Some(items) => {
                let mut grp = vec![];
                for (j, it) in items.iter().enumerate() {
                    match it.as_str() {
                        Some(s) => grp.push(s.to_string()),
                        None => errs.push(verr("string_type", &[json!("body"), json!("answers"), json!(i), json!(j)], "Input should be a valid string", it.clone())),
                    }
                }
                out.push(grp);
            }
        }
    }
    if !errs.is_empty() {
        return Err(ApiError::validation(errs));
    }
    Ok(out)
}

fn validate_answers(questions: &[Value], answers: &[Vec<String>]) -> ApiResult<()> {
    if answers.len() > questions.len() {
        return Err(ApiError::unprocessable(format!("Expected at most {} answer groups, got {}.", questions.len(), answers.len())));
    }
    for (i, selected) in answers.iter().enumerate() {
        let q = &questions[i];
        let mut labels: Vec<String> = vec![];
        for o in q.get("options").and_then(|o| o.as_array()).into_iter().flatten() {
            let l = match o.get("label") {
                Some(Value::String(s)) => s.clone(),
                Some(other) => appv3_agent::pystr::py_str(other),
                None => String::new(),
            };
            if !labels.contains(&l) {
                labels.push(l);
            }
        }
        let allows_custom = match q.get("custom") {
            None => true,
            Some(v) => *v == Value::Bool(true),
        };
        if selected.len() > 1 && q.get("multiple") != Some(&Value::Bool(true)) {
            return Err(ApiError::unprocessable(format!("Question {i} accepts a single answer.")));
        }
        let max = labels.len() + usize::from(allows_custom);
        if selected.len() > max {
            return Err(ApiError::unprocessable(format!("Question {i} accepts at most {max} answers.")));
        }
        for v in selected {
            if v.chars().count() > MAX_ANSWER_CHARS {
                return Err(ApiError::unprocessable(format!("Answer to question {i} exceeds {MAX_ANSWER_CHARS} characters.")));
            }
            if !labels.contains(v) && !allows_custom {
                return Err(ApiError::unprocessable(format!("Question {i} does not accept a custom answer; choose one of its options.")));
            }
        }
    }
    Ok(())
}

fn end_turn(sid: &str) {
    store().push_event(sid, &Envelope::from_parts("done", json!({})), false);
    store().mark_done(sid);
    broadcaster::publish("session_turn_completed", json!({"session_id": sid, "status": "completed"}));
}

async fn resume_agent(pool: &DbPool, sid: &str) -> bool {
    let agent = match manager::find_live_session_serving_session(sid) {
        Some(a) => a,
        None => {
            let row = match db::get_session(pool, sid).await {
                Ok(Some(r)) => r,
                _ => {
                    tracing::warn!("question_resume_session_not_resumable session_id={}", sid);
                    return false;
                }
            };
            if row.workspace.is_empty() {
                tracing::warn!("question_resume_session_not_resumable session_id={} workspace=None", sid);
                return false;
            }
            match get_or_start(&row.workspace, Some(sid)).await {
                Ok(Some(a)) => a,
                _ => {
                    tracing::warn!("question_resume_no_live_agent session_id={}", sid);
                    return false;
                }
            }
        }
    };
    if agent.session_id() != sid {
        if agent.is_busy() {
            tracing::warn!("question_resume_agent_busy_elsewhere session_id={} current_sid={}", sid, agent.session_id());
            return false;
        }
        if agent.attach_to_session(sid, None).await.is_err() {
            return false;
        }
    }
    agent.resume_after_question_answer().await;
    true
}

async fn answer(State(st): State<AppState>, AxPath((sid_raw, qid_raw)): AxPath<(String, String)>, body: Bytes) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &sid_raw)?;
    let qid = path_uuid("question_id", &qid_raw)?;
    let b = body_value(&body)?;
    let answers = parse_answers(&b)?;
    let row = open_question(&st.pool, &sid, &qid).await?;
    validate_answers(&row.questions(), &answers)?;
    let av = json!(answers);
    if db::resolve_pending_question(&st.pool, &qid, "answered", Some(&av)).await?.is_none() {
        return Err(ApiError::conflict("Question already resolved."));
    }
    store().push_event(&sid, &events::question_answered(&qid, &sid, &av), true);
    let resumed = resume_agent(&st.pool, &sid).await;
    if !resumed {
        end_turn(&sid);
    }
    tracing::info!("question_answered session_id={} question_id={} resumed={}", sid, qid, resumed);
    Ok(json(json!({"status": "ok", "resumed": resumed})))
}

async fn dismiss(State(st): State<AppState>, AxPath((sid_raw, qid_raw)): AxPath<(String, String)>) -> ApiResult<Response> {
    let sid = path_uuid("session_id", &sid_raw)?;
    let qid = path_uuid("question_id", &qid_raw)?;
    open_question(&st.pool, &sid, &qid).await?;
    if db::resolve_pending_question(&st.pool, &qid, "dismissed", None).await?.is_none() {
        return Err(ApiError::conflict("Question already resolved."));
    }
    store().push_event(&sid, &events::question_dismissed(&qid, &sid, "dismissed"), true);
    let handled = match manager::find_live_session_serving_session(&sid) {
        Some(a) => a.end_turn_after_question_dismissed(&sid).await,
        None => false,
    };
    if !handled {
        end_turn(&sid);
    }
    tracing::info!("question_dismissed_by_user session_id={} question_id={}", sid, qid);
    Ok(json(json!({"status": "ok", "resumed": false})))
}

async fn todos(AxPath(sid): AxPath<String>) -> ApiResult<Response> {
    if py_uuid(&sid).is_none() {
        return Err(ApiError::bad_request("Invalid session id."));
    }
    let path = appv3_tools::todo::todos_path(&appv3_tools::denied::session_artifacts_dir(Some(&sid)));
    if !path.exists() {
        return Ok(json(json!({"todos": []})));
    }
    let parsed = || -> Option<Vec<Value>> {
        let data: Value = serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
        let items = data.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let mut out = vec![];
        for it in items.iter().filter(|i| i.is_object()) {
            let f = |k: &str| it.get(k).and_then(|v| v.as_str()).map(String::from);
            out.push(json!({"task_id": f("task_id")?, "content": f("content")?, "status": f("status")?}));
        }
        Some(out)
    };
    Ok(json(json!({"todos": parsed().unwrap_or_default()})))
}

/// The saved Plan-mode plan (`appv3_agent::plan`); v2 has no such route.
async fn get_plan(AxPath(sid): AxPath<String>) -> ApiResult<Response> {
    if py_uuid(&sid).is_none() {
        return Err(ApiError::bad_request("Invalid session id."));
    }
    let dir = appv3_tools::denied::session_artifacts_dir(Some(&sid));
    let plan = appv3_agent::plan::load(&dir).map(|(content, updated)| json!({"content": content, "updated_at": updated.to_rfc3339()}));
    Ok(json(json!({"plan": plan})))
}

async fn delete_plan(AxPath(sid): AxPath<String>) -> ApiResult<Response> {
    if py_uuid(&sid).is_none() {
        return Err(ApiError::bad_request("Invalid session id."));
    }
    let deleted = appv3_agent::plan::clear(&appv3_tools::denied::session_artifacts_dir(Some(&sid)))?;
    Ok(json(json!({"deleted": deleted})))
}

/// The v2 route sees the process-default `AutoAllowPermissionService`
/// (session `"default"`), which never holds pending requests.
async fn list_permissions(AxPath(_sid): AxPath<String>) -> Response {
    json(json!({"permissions": []}))
}

async fn reply_permission(AxPath((_sid, rid)): AxPath<(String, String)>, body: Bytes) -> ApiResult<Response> {
    let b = body_value(&body)?;
    let reply = match b.get("reply") {
        Some(Value::String(s)) => s.clone(),
        None => return Err(ApiError::validation(vec![verr("missing", &loc(&["body", "reply"]), "Field required", b.clone())])),
        Some(o) => return Err(ApiError::validation(vec![verr("string_type", &loc(&["body", "reply"]), "Input should be a valid string", o.clone())])),
    };
    opt_str_field(&b, "message")?;
    if !["once", "always", "reject"].contains(&reply.as_str()) {
        return Err(ApiError::unprocessable(format!("Invalid reply '{reply}'. Must be one of: ['always', 'once', 'reject']")));
    }
    Err(ApiError::not_found(format!("Permission request '{rid}' not found or already resolved.")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answer_rules() {
        let qs = vec![json!({"question": "q", "options": [{"label": "A"}, {"label": "B"}], "custom": false})];
        assert!(validate_answers(&qs, &[vec!["A".into()]]).is_ok());
        assert_eq!(validate_answers(&qs, &[vec!["A".into(), "B".into()]]).unwrap_err().detail, json!("Question 0 accepts a single answer."));
        assert_eq!(validate_answers(&qs, &[vec!["Z".into()]]).unwrap_err().detail, json!("Question 0 does not accept a custom answer; choose one of its options."));
        assert_eq!(validate_answers(&qs, &[vec![], vec![]]).unwrap_err().detail, json!("Expected at most 1 answer groups, got 2."));
    }
}
