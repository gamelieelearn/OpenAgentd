//! `SummarizationHook` — port of `app/agent/hooks/summarization.py`.

use super::{AgentState, Hook, ModelRequest, RunContext};
use crate::events::{self, UsageFrame};
use crate::prompts;
use crate::stream_store::store;
use crate::streaming::{merge_consecutive_user_messages, RetryItem, RetryStream};
use appv3_providers::{registry::get_model_limits, usage::usage_to_dict, ChatMessage, Kwargs, LlmProvider, MessageMeta};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use super::otel::set_usage_span_attributes;
use appv3_core::otel::{self, Span, SpanKind};

/// A failed summariser LLM call (`type(exc).__name__`, qualified name, `str(exc)`).
struct LlmFailure {
    name: String,
    qualified: String,
    message: String,
    cancelled: bool,
}

pub const DEFAULT_PROMPT_TOKEN_THRESHOLD: i64 = 250_000;
pub const CONTEXT_RATIO: f64 = 0.9;
pub const DEFAULT_KEEP_LAST_ASSISTANTS: usize = 3;
pub const CODING_KEEP_LAST_ASSISTANTS: usize = 0;
pub const DEFAULT_MAX_TOKEN_LENGTH: i64 = 30_000;
pub const DEFAULT_MIN_MESSAGES_SINCE_LAST_SUMMARY: usize = 4;

pub fn prompt_token_threshold_for_model(model_id: Option<&str>) -> i64 {
    let l = get_model_limits(model_id);
    let known: Vec<i64> = [l.context_length, l.max_input_tokens].into_iter().flatten().collect();
    match known.iter().min() {
        Some(m) => (*m as f64 * CONTEXT_RATIO) as i64,
        None => DEFAULT_PROMPT_TOKEN_THRESHOLD,
    }
}

pub fn resolve_prompt_token_threshold(model_id: Option<&str>, custom: Option<i64>) -> i64 {
    let auto = prompt_token_threshold_for_model(model_id);
    match custom {
        Some(c) if c < auto => c,
        _ => auto,
    }
}

pub struct SummarizationHook {
    provider: Arc<dyn LlmProvider>,
    model_id: Option<String>,
    threshold: i64,
    keep_last: usize,
    summary_prompt: String,
    max_token_length: i64,
    min_since_last: usize,
    support_interrupt: bool,
    at_last_summary: Mutex<usize>,
    pending: Mutex<bool>,
}

/// `build_summarization_hook`.
pub fn build_summarization_hook(provider: Arc<dyn LlmProvider>, mode: &str, model_id: Option<&str>, support_interrupt: bool) -> Option<SummarizationHook> {
    let custom = appv3_core::runtime_settings::load_runtime_settings().ok().and_then(|s| s.summarization.prompt_token_threshold);
    let limits = get_model_limits(model_id);
    let max_len = limits.max_completion_tokens.map(|m| m.min(DEFAULT_MAX_TOKEN_LENGTH)).unwrap_or(DEFAULT_MAX_TOKEN_LENGTH);
    let threshold = resolve_prompt_token_threshold(model_id, custom);
    tracing::info!(
        "summarization_config model={:?} context_length={:?} max_input_tokens={:?} effective_threshold={}",
        model_id,
        limits.context_length,
        limits.max_input_tokens,
        threshold
    );
    let coding = mode == "coding";
    Some(SummarizationHook {
        provider,
        model_id: model_id.map(String::from),
        threshold,
        keep_last: if coding { CODING_KEEP_LAST_ASSISTANTS } else { DEFAULT_KEEP_LAST_ASSISTANTS },
        summary_prompt: prompts::s(if coding { "summary_coding" } else { "summary_chat" }).to_string(),
        max_token_length: max_len,
        min_since_last: DEFAULT_MIN_MESSAGES_SINCE_LAST_SUMMARY,
        support_interrupt,
        at_last_summary: Mutex::new(0),
        pending: Mutex::new(false),
    })
}

fn extra_truthy(m: &ChatMessage, key: &str) -> bool {
    m.meta().extra.as_ref().and_then(|e| e.get(key)).map(crate::util::truthy).unwrap_or(false)
}

/// `_find_assistant_cutoff` over `msgs` (indices into eligible).
fn find_assistant_cutoff(msgs: &[&ChatMessage], keep_last: usize) -> usize {
    if keep_last == 0 {
        return msgs.len();
    }
    let mut remaining = keep_last;
    for i in (0..msgs.len()).rev() {
        if msgs[i].role() == "assistant" {
            remaining -= 1;
            if remaining == 0 {
                return i;
            }
        }
    }
    0
}

/// `_expand_tool_pair_ids` over state indices.
fn expand_tool_pairs(messages: &[ChatMessage], pool: &[usize], seed: HashSet<usize>) -> HashSet<usize> {
    if seed.is_empty() {
        return seed;
    }
    let mut a_by: HashMap<String, HashSet<usize>> = HashMap::new();
    let mut t_by: HashMap<String, HashSet<usize>> = HashMap::new();
    for &i in pool {
        match &messages[i] {
            ChatMessage::Assistant(a) => {
                for tc in a.tool_calls.iter().flatten() {
                    if !tc.id.is_empty() {
                        a_by.entry(tc.id.clone()).or_default().insert(i);
                    }
                }
            }
            ChatMessage::Tool { tool_call_id, .. } if !tool_call_id.is_empty() => {
                t_by.entry(tool_call_id.clone()).or_default().insert(i);
            }
            _ => {}
        }
    }
    let mut expanded = seed;
    loop {
        let mut changed = false;
        for &i in pool {
            if !expanded.contains(&i) {
                continue;
            }
            let mut related = HashSet::new();
            match &messages[i] {
                ChatMessage::Assistant(a) => {
                    for tc in a.tool_calls.iter().flatten() {
                        related.extend(t_by.get(&tc.id).cloned().unwrap_or_default());
                    }
                }
                ChatMessage::Tool { tool_call_id, .. } if !tool_call_id.is_empty() => {
                    related.extend(a_by.get(tool_call_id).cloned().unwrap_or_default());
                }
                _ => {}
            }
            for r in related {
                if expanded.insert(r) {
                    changed = true;
                }
            }
        }
        if !changed {
            return expanded;
        }
    }
}

/// `_skill_tool_pair_ids`.
fn skill_tool_pairs(messages: &[ChatMessage], pool: &[usize]) -> HashSet<usize> {
    let mut call_ids = HashSet::new();
    let mut ids = HashSet::new();
    let mut seen = HashSet::new();
    for &i in pool {
        if let ChatMessage::Assistant(a) = &messages[i] {
            for tc in a.tool_calls.iter().flatten() {
                if tc.id.is_empty() || tc.function.name != "skill" {
                    continue;
                }
                let args: Value = serde_json::from_str(if tc.function.arguments.is_empty() { "{}" } else { &tc.function.arguments }).unwrap_or(Value::Null);
                let Some(name) = args.get("skill_name").and_then(|v| v.as_str()).filter(|s| !s.is_empty()) else {
                    continue;
                };
                if !seen.insert(name.to_string()) {
                    continue;
                }
                call_ids.insert(tc.id.clone());
                ids.insert(i);
            }
        }
    }
    if call_ids.is_empty() {
        return HashSet::new();
    }
    for &i in pool {
        if let ChatMessage::Tool { tool_call_id, .. } = &messages[i] {
            if call_ids.contains(tool_call_id) {
                ids.insert(i);
            }
        }
    }
    expand_tool_pairs(messages, pool, ids)
}

/// The newest Plan/Code instruction note in `pool`, if any.
///
/// The note is appended once per mode switch and is not re-added while it
/// exists in history, so compacting it away would leave the model without
/// the active mode's rules (Plan mode's read-only workflow and
/// `<proposed_plan>` format) until the next switch. Older notes are
/// superseded and compact like anything else.
fn active_mode_note(messages: &[ChatMessage], pool: &[usize]) -> Option<usize> {
    pool.iter().rev().copied().find(|&i| extra_truthy(&messages[i], "interaction_mode_prompt"))
}

impl SummarizationHook {
    fn at_user_turn_boundary(state: &AgentState) -> bool {
        let visible = state.messages_for_llm();
        let Some(last) = visible.last() else {
            return true;
        };
        if !matches!(last, ChatMessage::User { .. }) || last.meta().is_summary() {
            return false;
        }
        if extra_truthy(last, "hidden_from_summary") {
            return false;
        }
        match last.meta().extra.as_ref().and_then(|e| e.get("from_agent")) {
            None | Some(Value::Null) => true,
            Some(Value::String(s)) => s == "user",
            _ => false,
        }
    }

    /// `_call_llm` inside the `summarization_llm_call` CLIENT span.
    async fn call_llm(&self, ctx: &RunContext, messages: Vec<ChatMessage>, tools: Option<&[Value]>) -> Result<(String, Option<Value>), LlmFailure> {
        let span = Span::start("summarization_llm_call", SpanKind::Client, vec![]);
        let t0 = std::time::Instant::now();
        let model_id = self.model_id.clone().or_else(|| self.provider.cost_model_id()).filter(|m| !m.is_empty());
        let mut provider_name = self.provider.provider_name().filter(|p| !p.is_empty()).map(String::from);
        span.set_attr("gen_ai.operation.name", "summarization");
        if let Some(p) = &provider_name {
            span.set_attr("gen_ai.provider.name", p.as_str());
        }
        if let Some(mid) = &model_id {
            let mut model_name = mid.clone();
            if let Some((pp, pm)) = mid.split_once(':') {
                if provider_name.is_none() {
                    provider_name = Some(pp.to_string()).filter(|p| !p.is_empty());
                }
                if !pm.is_empty() {
                    model_name = pm.to_string();
                }
            }
            span.set_attr("gen_ai.request.model", model_name);
            if let Some(p) = &provider_name {
                span.set_attr("gen_ai.provider.name", p.as_str());
            }
        }
        let res = otel::scope(Some(span.ctx()), self.call_llm_inner(ctx, messages, tools, model_id.clone(), provider_name.as_deref() == Some("codex"))).await;
        match res {
            Err(f) => {
                if f.cancelled {
                    span.exit_with_exception("asyncio.exceptions.CancelledError", "");
                } else {
                    span.set_attr("error.type", f.name.as_str());
                    span.set_error();
                    span.exit_with_exception(&f.qualified, &f.message);
                }
                Err(f)
            }
            Ok((text, last_usage)) => {
                span.set_attr("summarization.llm_duration_s", json!(appv3_core::pymath::py_round(t0.elapsed().as_secs_f64(), 3)));
                span.set_attr("summarization.response_length", text.chars().count());
                let usage = last_usage.map(|u| usage_to_dict(&u, model_id.as_deref()));
                if let Some(u) = &usage {
                    tracing::info!(
                        "summarization_usage model={:?} input={:?} output={:?} cache={}",
                        model_id,
                        u.get("input"),
                        u.get("output"),
                        u.get("cache").cloned().unwrap_or(json!(0))
                    );
                    set_usage_span_attributes(&span, u);
                }
                span.set_ok();
                span.end();
                Ok((text.trim().to_string(), usage))
            }
        }
    }

    async fn call_llm_inner(
        &self,
        ctx: &RunContext,
        messages: Vec<ChatMessage>,
        tools: Option<&[Value]>,
        model_id: Option<String>,
        is_codex: bool,
    ) -> Result<(String, Option<appv3_providers::Usage>), LlmFailure> {
        let mut kw = Kwargs::new();
        if self.max_token_length > 0 {
            kw.insert("max_tokens".into(), json!(self.max_token_length));
        }
        kw.insert("tool_choice".into(), json!("none"));
        if is_codex {
            if let Some(s) = &ctx.session_id {
                kw.insert("session_id".into(), json!(s));
            }
        }
        let label = model_id.clone().unwrap_or_else(|| "summarizer".into());
        let mut rs = RetryStream::new(self.provider.clone(), label, &messages, tools, kw, None, None);
        let mut text = String::new();
        let mut last_usage = None;
        loop {
            match rs.next().await {
                Ok(Some(RetryItem::Restart)) => text.clear(),
                Ok(Some(RetryItem::Chunk(c))) => {
                    if c.usage.is_some() {
                        last_usage = c.usage.clone();
                    }
                    if let Some(content) = c.choices.first().and_then(|ch| ch.delta.content.clone()).filter(|s| !s.is_empty()) {
                        text.push_str(&content);
                        if let Some(sid) = &ctx.session_id {
                            store().push_event(sid, &events::summarization_content(&ctx.agent_name, &content), false);
                        }
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    return Err(match e {
                        crate::streaming::ModelError::Agent(a) => {
                            let (name, qualified) = crate::errors::python_exception_names(&a);
                            LlmFailure { name: name.into(), qualified, message: a.to_string(), cancelled: matches!(a, crate::errors::AgentError::Cancelled) }
                        }
                        crate::streaming::ModelError::Transient { error_type, message } => {
                            LlmFailure { qualified: format!("httpx2.{error_type}"), name: error_type, message, cancelled: false }
                        }
                    })
                }
            }
        }
        Ok((text, last_usage))
    }

    fn emit_end(&self, ctx: &RunContext, summary: &str, error: bool) {
        if let Some(sid) = &ctx.session_id {
            let meta = if error { json!({"error": true}) } else { json!({}) };
            store().push_event(sid, &events::summarization_end(&ctx.agent_name, summary, Some(meta)), false);
        }
    }

    async fn summarise(&self, ctx: &RunContext, state: &mut AgentState, system_prompt: &str) -> bool {
        tracing::info!("summarization_started session_id={:?} agent={}", ctx.session_id, ctx.agent_name);
        let span = Span::start(
            "summarization",
            SpanKind::Internal,
            vec![
                ("gen_ai.agent.name", json!(ctx.agent_name)),
                ("gen_ai.conversation.id", json!(ctx.session_id.clone().unwrap_or_default())),
                ("run_id", json!(ctx.run_id)),
                ("summarization.prompt_tokens", json!(state.usage.last_prompt_tokens)),
                ("summarization.threshold", json!(self.threshold)),
            ],
        );
        let (done, cancelled) = otel::scope(Some(span.ctx()), self.summarise_inner(ctx, state, system_prompt, &span)).await;
        if cancelled {
            span.exit_with_exception("asyncio.exceptions.CancelledError", "");
        } else {
            span.end();
        }
        done
    }

    /// Returns `(summarised, cancelled)`.
    async fn summarise_inner(&self, ctx: &RunContext, state: &mut AgentState, system_prompt: &str, span: &Span) -> (bool, bool) {
        let eligible: Vec<usize> = (0..state.messages.len())
            .filter(|&i| {
                let m = &state.messages[i];
                !m.meta().exclude_from_context && !matches!(m, ChatMessage::System { .. }) && !extra_truthy(m, "hidden_from_summary")
            })
            .collect();
        if eligible.is_empty() {
            tracing::debug!("summarization_skipped_no_messages session_id={:?}", ctx.session_id);
            span.set_attr("summarization.skipped", "no_messages");
            span.set_ok();
            return (false, false);
        }
        let refs: Vec<&ChatMessage> = eligible.iter().map(|&i| &state.messages[i]).collect();
        let cutoff = find_assistant_cutoff(&refs, self.keep_last);
        let seed: HashSet<usize> = if cutoff > 0 { eligible[..cutoff].iter().copied().collect() } else { eligible.iter().copied().collect() };
        let to_ids = expand_tool_pairs(&state.messages, &eligible, seed);
        let mut retained = skill_tool_pairs(&state.messages, &eligible);
        // A mode note already in the kept window stays where it is; retaining
        // it would move the summary below it.
        retained.extend(active_mode_note(&state.messages, &eligible).filter(|i| to_ids.contains(i)));
        let to_summarise: Vec<usize> = eligible.iter().copied().filter(|i| to_ids.contains(i)).collect();
        if to_summarise.is_empty() {
            tracing::debug!("summarization_skipped_all_messages_in_keep_window session_id={:?}", ctx.session_id);
            span.set_attr("summarization.skipped", "all_in_keep_window");
            span.set_ok();
            return (false, false);
        }
        let has_prior = to_summarise.iter().any(|&i| state.messages[i].meta().is_summary());
        let request_line = prompts::s(if has_prior { "summary_merge" } else { "summary_request" });
        let mut prefix = Vec::new();
        if !system_prompt.is_empty() {
            prefix.push(ChatMessage::system(system_prompt));
        }
        prefix.extend(to_summarise.iter().map(|&i| state.messages[i].clone()));
        let mut msgs = merge_consecutive_user_messages(prefix);
        msgs.push(ChatMessage::user(format!("{request_line}\n\n{}", self.summary_prompt)));
        span.set_attr("summarization.messages_to_summarise", to_summarise.len());
        span.set_attr("summarization.keep_last_assistants", self.keep_last);
        span.set_attr("summarization.has_prior_summary", has_prior);

        if let Some(sid) = &ctx.session_id {
            store().push_event(sid, &events::summarization_start(&ctx.agent_name), false);
        }
        let tools = if state.tool_defs.is_empty() { None } else { Some(state.tool_defs.as_slice()) };
        let (text, usage) = match self.call_llm(ctx, msgs, tools).await {
            Ok(r) => r,
            Err(e) if e.cancelled => return (false, true),
            Err(e) => {
                tracing::error!("summarization_llm_failed session_id={:?} error={}", ctx.session_id, e.message);
                span.set_attr("error.type", e.name.as_str());
                span.set_error();
                self.emit_end(ctx, "", true);
                return (false, false);
            }
        };
        if text.is_empty() {
            tracing::warn!("summarization_skipped_empty_response session_id={:?} agent={}", ctx.session_id, ctx.agent_name);
            span.set_attr("summarization.skipped", "empty_llm_response");
            span.set_ok();
            self.emit_end(ctx, "", true);
            return (false, false);
        }
        let to_set: HashSet<usize> = to_summarise.iter().copied().collect();
        for (i, m) in state.messages.iter_mut().enumerate() {
            if to_set.contains(&i) && !retained.contains(&i) {
                let meta = m.meta_mut();
                meta.exclude_from_context = true;
                meta.pinned = false;
            }
        }
        for (i, m) in state.messages.iter_mut().enumerate() {
            if m.meta().is_summary() && !to_set.contains(&i) {
                m.meta_mut().exclude_from_context = true;
            }
        }
        let mut first_kept = match retained.iter().max() {
            Some(&mx) => mx + 1,
            None => state.messages.iter().position(|m| !m.meta().exclude_from_context).unwrap_or(state.messages.len()),
        };
        let last_excluded = state.messages.iter().rposition(|m| m.meta().exclude_from_context).map(|i| i as i64).unwrap_or(-1);
        first_kept = first_kept.max((last_excluded + 1) as usize);
        for m in state.messages[..first_kept].iter_mut() {
            if !m.meta().exclude_from_context && !matches!(m, ChatMessage::System { .. }) {
                m.meta_mut().pinned = true;
            }
        }
        let mut meta = MessageMeta { kind: "summary".into(), ..Default::default() };
        if let Some(u) = &usage {
            let mut e = Map::new();
            e.insert("usage".into(), u.clone());
            meta.extra = Some(e);
        }
        state.messages.insert(first_kept, ChatMessage::User { content: Some(text.clone()), parts: None, meta });
        *self.at_last_summary.lock().unwrap() = state.messages.len();
        span.set_attr("summarization.summary_length", text.chars().count());
        span.set_attr("summarization.kept", eligible.len() - to_summarise.len());
        span.set_ok();

        if let Some(sid) = &ctx.session_id {
            if let Some(u) = &usage {
                let int = |k: &str| u.get(k).and_then(|v| v.as_i64());
                let mut md = json!({"agent": ctx.agent_name, "summarization": true});
                if let Some(m) = self.model_id.clone().or_else(|| self.provider.cost_model_id()).filter(|m| !m.is_empty()) {
                    md["model"] = json!(m);
                }
                let p = int("input").unwrap_or(0);
                let c = int("output").unwrap_or(0);
                store().push_event(
                    sid,
                    &events::usage(
                        &UsageFrame {
                            prompt_tokens: p,
                            completion_tokens: c,
                            total_tokens: p + c,
                            cached_tokens: int("cache"),
                            thoughts_tokens: int("thoughts"),
                            tool_use_tokens: None,
                            estimated_cost_usd: u.get("cost").and_then(|c| c.get("estimated_usd")).cloned(),
                        },
                        md,
                    ),
                    false,
                );
            }
            self.emit_end(ctx, &text, false);
        }
        tracing::info!("summarization_complete session_id={:?} summarised={}", ctx.session_id, to_summarise.len());
        (true, false)
    }
}

#[async_trait]
impl Hook for SummarizationHook {
    async fn before_model(&self, ctx: &RunContext, state: &mut AgentState, _req: &ModelRequest) -> Option<ModelRequest> {
        let force = state.meta_get("force_summarization") == Some(Value::Bool(true));
        if self.threshold <= 0 && !force {
            return None;
        }
        if state.usage.last_prompt_tokens < self.threshold && !force {
            return None;
        }
        if self.min_since_last > 0 && !force {
            let at = *self.at_last_summary.lock().unwrap();
            if at > 0 && state.messages.len().saturating_sub(at) < self.min_since_last {
                return None;
            }
        }
        if !self.support_interrupt && !force && !Self::at_user_turn_boundary(state) {
            return None;
        }
        tracing::info!("summarization_triggered agent={} last_prompt_tokens={}", ctx.agent_name, state.usage.last_prompt_tokens);
        *self.pending.lock().unwrap() = true;
        None
    }

    async fn before_model_call(&self, ctx: &RunContext, state: &mut AgentState, system_prompt: &str) -> bool {
        let pending = std::mem::replace(&mut *self.pending.lock().unwrap(), false);
        if !pending {
            return false;
        }
        self.summarise(ctx, state, system_prompt).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use appv3_providers::mock::MockProvider;

    fn hook(keep_last: usize) -> SummarizationHook {
        SummarizationHook {
            provider: Arc::new(MockProvider::new(vec![MockProvider::text("Summary.")])),
            model_id: None,
            threshold: 1,
            keep_last,
            summary_prompt: "test summary prompt".into(),
            max_token_length: 0,
            min_since_last: 0,
            support_interrupt: true,
            at_last_summary: Mutex::new(0),
            pending: Mutex::new(false),
        }
    }

    /// A persisted Plan/Code instruction note as history loading yields it.
    fn mode_note(mode: &str) -> ChatMessage {
        let mut m = ChatMessage::user(format!("<interaction_mode>\n## {mode} mode\n</interaction_mode>"));
        let meta = m.meta_mut();
        meta.kind = "note".into();
        meta.pinned = true;
        let mut extra = Map::new();
        extra.insert("hidden_from_user".into(), json!(true));
        extra.insert("interaction_mode".into(), json!(mode));
        extra.insert("interaction_mode_prompt".into(), json!(true));
        meta.extra = Some(extra);
        m
    }

    async fn compact(keep_last: usize, messages: Vec<ChatMessage>) -> AgentState {
        let ctx = RunContext { session_id: None, run_id: "run".into(), agent_name: "test".into(), workspace: None };
        let mut state = AgentState::new(messages, String::new());
        assert!(hook(keep_last).summarise(&ctx, &mut state, "sys").await, "compaction did not run");
        state
    }

    fn find<'a>(state: &'a AgentState, content: &str) -> (usize, &'a ChatMessage) {
        state.messages.iter().enumerate().find(|(_, m)| m.content() == Some(content)).unwrap_or_else(|| panic!("no message {content:?}"))
    }

    fn summary_index(state: &AgentState) -> usize {
        state.messages.iter().position(|m| m.meta().is_summary()).expect("summary inserted")
    }

    fn visible(state: &AgentState, content: &str) -> bool {
        state.messages_for_llm().iter().any(|m| m.content() == Some(content))
    }

    /// Compacting a Plan-mode session must not drop the Plan instructions: the
    /// note is appended once per switch and not re-added while it exists in
    /// history, so losing it leaves the model without the read-only workflow
    /// and `<proposed_plan>` format for the rest of the mode.
    #[tokio::test]
    async fn active_plan_mode_note_stays_in_context_after_compaction() {
        let note = mode_note("plan");
        let note_text = note.content().unwrap().to_string();
        let state = compact(0, vec![note, ChatMessage::user("Redesign the settings screen."), ChatMessage::assistant("I will inspect the current UI.")]).await;

        assert!(visible(&state, &note_text), "Plan-mode note left the LLM window");
        let (idx, kept) = find(&state, &note_text);
        // Pinned so the derived DB window (pinned rows + rows after the
        // summary) still contains it when the session is reloaded.
        assert!(kept.meta().pinned);
        assert!(idx < summary_index(&state));
        assert!(!visible(&state, "Redesign the settings screen."));
        assert!(!visible(&state, "I will inspect the current UI."));
    }

    #[tokio::test]
    async fn only_the_newest_mode_note_survives_compaction() {
        let plan = mode_note("plan");
        let code = mode_note("code");
        let (plan_text, code_text) = (plan.content().unwrap().to_string(), code.content().unwrap().to_string());
        let state = compact(
            0,
            vec![
                plan,
                ChatMessage::user("Plan the redesign."),
                ChatMessage::assistant("<proposed_plan>…</proposed_plan>"),
                code,
                ChatMessage::user("Approve, proceed."),
                ChatMessage::assistant("Implementing step 1."),
            ],
        )
        .await;

        assert!(visible(&state, &code_text));
        assert!(find(&state, &code_text).1.meta().pinned);
        assert!(!visible(&state, &plan_text));
        let (_, plan) = find(&state, &plan_text);
        assert!(plan.meta().exclude_from_context);
        assert!(!plan.meta().pinned);
    }

    /// Retention must not move the summary below a note it never covered.
    #[tokio::test]
    async fn mode_note_inside_the_kept_window_is_left_in_place() {
        let note = mode_note("plan");
        let note_text = note.content().unwrap().to_string();
        let state = compact(
            2,
            vec![
                ChatMessage::user("first"),
                ChatMessage::assistant("first reply"),
                ChatMessage::user("second"),
                ChatMessage::assistant("second reply"),
                note,
                ChatMessage::user("third"),
                ChatMessage::assistant("third reply"),
            ],
        )
        .await;

        let summary = summary_index(&state);
        let (kept_reply, _) = find(&state, "second reply");
        let (note_idx, _) = find(&state, &note_text);
        assert!(summary < kept_reply && kept_reply < note_idx, "summary {summary}, kept reply {kept_reply}, note {note_idx}");
        assert!(visible(&state, &note_text));
    }
}
