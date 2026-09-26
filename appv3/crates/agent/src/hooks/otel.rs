//! Port of `app/agent/hooks/otel.py` — GenAI-convention spans and metrics
//! for every agent run. The `wrap_model_call` / `wrap_tool_call` halves are
//! driven from `Agent::run` via [`Hook::as_otel`] so the span can be made
//! current for the wrapped future.

use super::{AgentState, Hook, ModelRequest, RunContext};
use appv3_core::otel::{self, Span, SpanCtx, SpanKind};
use appv3_providers::{AssistantMessage, ToolCall};
use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// Span attribute naming the turn's workspace root (v3 addition; GenAI
/// semantic conventions have no workspace notion).
pub const WORKSPACE_ATTR: &str = "openagentd.workspace";

/// `set_usage_span_attributes` (usage dict from `usage_to_dict`).
pub fn set_usage_span_attributes(span: &Span, usage: &Value) {
    let get = |k: &str| usage.get(k).cloned().unwrap_or(json!(0));
    let truthy = |v: &Value| match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() != Some(0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    };
    for (key, attr) in [
        ("input", "gen_ai.usage.input_tokens"),
        ("output", "gen_ai.usage.output_tokens"),
        ("cache", "gen_ai.usage.cache_read.input_tokens"),
        ("cache_write", "gen_ai.usage.cache_creation.input_tokens"),
        ("thoughts", "gen_ai.usage.reasoning_tokens"),
        ("tool_use", "gen_ai.usage.tool_use_tokens"),
    ] {
        let v = get(key);
        if truthy(&v) {
            span.set_attr(attr, v);
        }
    }
    if let Some(Value::Number(n)) = usage.get("cost").and_then(|c| c.get("estimated_usd")) {
        if n.as_f64().map(|f| f > 0.0).unwrap_or(false) {
            span.set_attr("gen_ai.usage.estimated_cost_usd", Value::Number(n.clone()));
        }
    }
}

/// `_parse_model_id`.
pub fn parse_model_id(model_id: Option<&str>) -> (String, String) {
    match model_id {
        None | Some("") => ("unknown".into(), "unknown".into()),
        Some(m) => match m.split_once(':') {
            Some((p, rest)) => (if p.is_empty() { "unknown".into() } else { p.into() }, if rest.is_empty() { "unknown".into() } else { rest.into() }),
            None => ("unknown".into(), m.into()),
        },
    }
}

struct Instruments {
    op_duration: otel::Histogram,
    token_usage: otel::Histogram,
    tool_duration: otel::Histogram,
    runs: otel::Counter,
}

fn instruments() -> &'static Instruments {
    static I: OnceLock<Instruments> = OnceLock::new();
    I.get_or_init(|| Instruments {
        op_duration: otel::histogram("gen_ai.client.operation.duration", "GenAI operation duration", "s"),
        token_usage: otel::histogram("gen_ai.client.token.usage", "Number of input and output tokens used", "{token}"),
        tool_duration: otel::histogram("openagentd.tool.execution.duration", "Tool execution duration", "s"),
        runs: otel::counter("openagentd.agent.runs.total", "Total completed agent runs"),
    })
}

/// How a wrapped model call ended.
pub enum ModelOutcome<'a> {
    Ok(&'a AssistantMessage),
    /// `(python class name, qualified name, message)`.
    Err(&'a str, &'a str, &'a str),
}

/// How a wrapped tool call ended.
pub enum ToolOutcome<'a> {
    Ok(&'a str),
    QuestionSuspended(&'a str),
    LeadSuspended(&'a str),
}

pub struct OtelHook {
    agent_name: String,
    provider: String,
    model: String,
    agent_span: Mutex<Option<Span>>,
    token: Mutex<Option<Option<SpanCtx>>>,
    run_start: Mutex<Option<Instant>>,
}

impl OtelHook {
    pub fn new(agent_name: &str, model_id: Option<&str>) -> Self {
        let (provider, model) = parse_model_id(model_id);
        instruments();
        Self { agent_name: agent_name.into(), provider, model, agent_span: Mutex::new(None), token: Mutex::new(None), run_start: Mutex::new(None) }
    }

    fn conv(ctx: &RunContext) -> String {
        ctx.session_id.clone().unwrap_or_else(|| "no-session".into())
    }

    pub fn start_model_span(&self, ctx: &RunContext, req: &ModelRequest) -> Span {
        Span::start(
            format!("chat {}", self.model),
            SpanKind::Client,
            vec![
                ("gen_ai.operation.name", json!("chat")),
                ("gen_ai.provider.name", json!(self.provider)),
                ("gen_ai.request.model", json!(self.model)),
                ("gen_ai.conversation.id", json!(Self::conv(ctx))),
                ("run_id", json!(ctx.run_id)),
                ("gen_ai.agent.name", json!(self.agent_name)),
                ("gen_ai.request.message_count", json!(req.messages.len())),
            ],
        )
    }

    pub fn end_model_span(&self, span: &Span, started: Instant, outcome: ModelOutcome<'_>) {
        match outcome {
            ModelOutcome::Err(name, qualified, msg) => {
                span.set_attr("error.type", name);
                span.set_error();
                span.exit_with_exception(qualified, msg);
            }
            ModelOutcome::Ok(result) => {
                let elapsed = started.elapsed().as_secs_f64();
                let usage = result.meta.extra.as_ref().and_then(|e| e.get("usage")).cloned().unwrap_or(json!({}));
                set_usage_span_attributes(span, &usage);
                if let Some(m) = result.meta.extra.as_ref().and_then(|e| e.get("model")).filter(|m| crate::util::truthy(m)) {
                    span.set_attr("gen_ai.response.model", m.clone());
                }
                span.set_ok();
                span.end();
                let attrs = || vec![("gen_ai.operation.name", json!("chat")), ("gen_ai.provider.name", json!(self.provider)), ("gen_ai.request.model", json!(self.model))];
                instruments().op_duration.record_in(Some(span.ctx()), elapsed, attrs());
                let input = usage.get("input").cloned().unwrap_or(json!(0));
                let output = usage.get("output").cloned().unwrap_or(json!(0));
                if crate::util::truthy(&input) {
                    let mut a = attrs();
                    a.push(("gen_ai.token.type", json!("input")));
                    instruments().token_usage.record_in(Some(span.ctx()), input, a);
                }
                if crate::util::truthy(&output) {
                    let mut a = attrs();
                    a.push(("gen_ai.token.type", json!("output")));
                    instruments().token_usage.record_in(Some(span.ctx()), output, a);
                }
            }
        }
    }

    pub fn start_tool_span(&self, ctx: &RunContext, tc: &ToolCall) -> Span {
        Span::start(
            format!("execute_tool {}", tc.function.name),
            SpanKind::Internal,
            vec![
                ("gen_ai.operation.name", json!("execute_tool")),
                ("gen_ai.tool.name", json!(tc.function.name)),
                ("gen_ai.tool.call.id", json!(tc.id)),
                ("gen_ai.agent.name", json!(self.agent_name)),
                ("gen_ai.conversation.id", json!(Self::conv(ctx))),
                ("run_id", json!(ctx.run_id)),
            ],
        )
    }

    pub fn end_tool_span(&self, span: &Span, tool_name: &str, started: Instant, outcome: ToolOutcome<'_>) {
        match outcome {
            ToolOutcome::QuestionSuspended(msg) => {
                span.set_attr("tool.suspended", true);
                span.set_ok();
                span.exit_with_exception("app.agent.errors.QuestionSuspended", msg);
            }
            ToolOutcome::LeadSuspended(msg) => {
                span.set_attr("error.type", "LeadSuspended");
                span.set_error();
                span.exit_with_exception("app.agent.errors.LeadSuspended", msg);
            }
            ToolOutcome::Ok(result) => {
                span.set_attr("tool.result.length", result.chars().count());
                span.set_ok();
                span.end();
                instruments().tool_duration.record_in(
                    Some(span.ctx()),
                    started.elapsed().as_secs_f64(),
                    vec![("gen_ai.tool.name", json!(tool_name)), ("gen_ai.agent.name", json!(self.agent_name))],
                );
            }
        }
    }
}

#[async_trait]
impl Hook for OtelHook {
    fn as_otel(&self) -> Option<&OtelHook> {
        Some(self)
    }

    async fn before_agent(&self, ctx: &RunContext, _state: &mut AgentState) {
        *self.run_start.lock().unwrap() = Some(Instant::now());
        let mut attrs = vec![
            ("gen_ai.agent.name", json!(self.agent_name)),
            ("gen_ai.provider.name", json!(self.provider)),
            ("gen_ai.request.model", json!(self.model)),
            ("gen_ai.conversation.id", json!(Self::conv(ctx))),
            ("run_id", json!(ctx.run_id)),
        ];
        if let Some(workspace) = ctx.workspace.as_deref().filter(|w| !w.is_empty()) {
            attrs.push((WORKSPACE_ATTR, json!(workspace)));
        }
        let span = Span::start(format!("agent_run {}", self.agent_name), SpanKind::Internal, attrs);
        *self.token.lock().unwrap() = otel::attach(Some(span.ctx()));
        *self.agent_span.lock().unwrap() = Some(span);
    }

    async fn after_agent(&self, ctx: &RunContext, state: &mut AgentState, _resp: &AssistantMessage) {
        if let Some(span) = self.agent_span.lock().unwrap().take() {
            if state.usage.last_prompt_tokens != 0 {
                span.set_attr("gen_ai.usage.input_tokens", state.usage.last_prompt_tokens);
            }
            if state.usage.last_completion_tokens != 0 {
                span.set_attr("gen_ai.usage.output_tokens", state.usage.last_completion_tokens);
            }
            span.set_ok();
            span.end();
        }
        if let Some(prev) = self.token.lock().unwrap().take() {
            otel::attach(prev);
        }
        instruments().runs.add(1, vec![("gen_ai.agent.name", json!(self.agent_name)), ("gen_ai.provider.name", json!(self.provider)), ("gen_ai.request.model", json!(self.model))]);
        let elapsed = self.run_start.lock().unwrap().map(|t| t.elapsed().as_secs_f64()).unwrap_or(0.0);
        tracing::debug!("otel_agent_run_complete agent={} session={:?} elapsed_s={:.3}", self.agent_name, ctx.session_id, elapsed);
    }

    async fn on_rate_limit(&self, _ctx: &RunContext, retry_after: i64, attempt: i64, max_attempts: i64) {
        if let Some(span) = self.agent_span.lock().unwrap().as_ref() {
            span.add_event("rate_limit", vec![("retry_after_s", json!(retry_after as f64)), ("attempt", json!(attempt)), ("max_attempts", json!(max_attempts))]);
        }
    }
}
