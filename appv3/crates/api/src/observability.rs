//! Port of `app/services/observability_service.py` — aggregate the OTEL span
//! JSONL files (`{STATE_DIR}/otel/spans/YYYY-MM-DD-HH.jsonl`) into the
//! observability page payloads.
//!
//! Results are memoised per 5 s bucket + file signatures `(path, size,
//! mtime_ns, inode)` exactly like v2's `lru_cache` wrappers, so repeated
//! calls inside one bucket return the same window.

use appv3_core::pymath::py_round;
use chrono::{DateTime, Duration, TimeZone, Utc};
use indexmap::IndexMap;
use serde_json::{json, Map, Value};
use std::cmp::Ordering;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

const CACHE_BUCKET_SECONDS: i64 = 5;
const CACHE_MAXSIZE: usize = 64;

type Signatures = Vec<(String, u64, i128, u64)>;

fn spans_dir() -> PathBuf {
    appv3_core::settings().state_dir.join("otel").join("spans")
}

/// `datetime.isoformat()` for an aware UTC datetime.
pub fn py_iso(dt: DateTime<Utc>) -> String {
    if dt.timestamp_subsec_micros() == 0 {
        dt.format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
    } else {
        dt.format("%Y-%m-%dT%H:%M:%S%.6f+00:00").to_string()
    }
}

/// Python-truthiness of a JSON value.
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

fn py_repr(v: &Value) -> String {
    match v {
        Value::String(s) => {
            let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
            let mut out = String::from(q);
            for c in s.chars() {
                match c {
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if c == q => {
                        out.push('\\');
                        out.push(c);
                    }
                    c => out.push(c),
                }
            }
            out.push(q);
            out
        }
        other => py_str(other),
    }
}

/// Python `str(value)` for a JSON-decoded value.
fn py_str(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => i.to_string(),
            (_, Some(u)) => u.to_string(),
            _ => appv3_core::pyjson::float_repr(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => s.clone(),
        Value::Array(a) => format!("[{}]", a.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(o) => format!("{{{}}}", o.iter().map(|(k, v)| format!("{}: {}", py_repr(&json!(k)), py_repr(v))).collect::<Vec<_>>().join(", ")),
    }
}

/// `_safe_int`.
fn safe_int(v: Option<&Value>) -> i64 {
    match v {
        None | Some(Value::Null) => 0,
        Some(Value::Bool(b)) => *b as i64,
        Some(Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.is_finite()).map(|f| f.trunc() as i64)).unwrap_or(0),
        Some(Value::String(s)) => s.trim().replace('_', "").parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

/// `_safe_float`.
fn safe_float(v: Option<&Value>) -> f64 {
    match v {
        None | Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => *b as i64 as f64,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => {
            let t = s.trim().to_ascii_lowercase();
            match t.as_str() {
                "nan" | "+nan" | "-nan" => f64::NAN,
                "inf" | "+inf" | "infinity" | "+infinity" => f64::INFINITY,
                "-inf" | "-infinity" => f64::NEG_INFINITY,
                _ => t.replace('_', "").parse::<f64>().unwrap_or(0.0),
            }
        }
        _ => 0.0,
    }
}

/// Numeric view of a JSON number for comparisons / `x or 0`.
fn num(v: Option<&Value>) -> Option<f64> {
    match v {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::Bool(b)) => Some(*b as i64 as f64),
        _ => None,
    }
}

/// `x or 0` for an ns timestamp, as an integer when it is one.
fn ns_or_zero(v: Option<&Value>) -> Value {
    match v {
        Some(val) if truthy(val) => val.clone(),
        _ => json!(0),
    }
}

/// `int(ns // 1_000_000)`.
fn ns_to_ms(v: &Value) -> i64 {
    match v {
        Value::Number(n) => match n.as_i64() {
            Some(i) => i.div_euclid(1_000_000),
            None => match n.as_u64() {
                Some(u) => (u / 1_000_000) as i64,
                None => (n.as_f64().unwrap_or(0.0) / 1_000_000.0).floor() as i64,
            },
        },
        Value::Bool(b) => (*b as i64).div_euclid(1_000_000),
        _ => 0,
    }
}

fn percent(part: f64, total: f64) -> f64 {
    if total <= 0.0 {
        return 0.0;
    }
    py_round(part / total * 100.0, 1)
}

fn quantile(values: &[f64], q: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let n = v.len();
    if n == 1 {
        return v[0];
    }
    let idx = (n - 1) as f64 * q;
    let i = idx as usize;
    let frac = idx - i as f64;
    if i + 1 < n {
        v[i] + frac * (v[i + 1] - v[i])
    } else {
        v[i]
    }
}

fn cmp_f64(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

fn candidate_files(window_start: DateTime<Utc>) -> Vec<PathBuf> {
    let dir = spans_dir();
    if !dir.is_dir() {
        tracing::debug!("observability_spans_dir_missing path={}", dir.display());
        return vec![];
    }
    let cutoff = window_start.format("%Y-%m-%d-%H").to_string();
    let mut out: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| {
                    let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                    name.ends_with(".jsonl") && name.len() > ".jsonl".len() && name[..name.len() - 6].to_string() >= cutoff
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

fn cache_context(days: i64) -> (DateTime<Utc>, i64, String, Signatures) {
    use std::os::unix::fs::MetadataExt;
    let now = Utc::now();
    let mut sigs = vec![];
    for p in candidate_files(now - Duration::days(days)) {
        if let Ok(m) = std::fs::metadata(&p) {
            sigs.push((p.to_string_lossy().into_owned(), m.size(), m.mtime() as i128 * 1_000_000_000 + m.mtime_nsec() as i128, m.ino()));
        }
    }
    (now, now.timestamp().div_euclid(CACHE_BUCKET_SECONDS), spans_dir().to_string_lossy().into_owned(), sigs)
}

fn load_spans_in_window(files: &[PathBuf], window_start: DateTime<Utc>, window_end: DateTime<Utc>) -> Vec<Map<String, Value>> {
    let ts_ns = |d: DateTime<Utc>| (d.timestamp() as f64 + d.timestamp_subsec_micros() as f64 / 1e6) * 1e9;
    let (start_ns, end_ns) = (ts_ns(window_start).trunc(), ts_ns(window_end).trunc());
    let mut spans = vec![];
    for path in files {
        let Ok(bytes) = std::fs::read(path) else { continue };
        for line in bytes.split(|b| *b == b'\n') {
            if line.iter().all(|b| b.is_ascii_whitespace()) {
                continue;
            }
            let Ok(Value::Object(s)) = serde_json::from_slice::<Value>(line) else { continue };
            if let Some(et) = num(s.get("end_time")) {
                if start_ns <= et && et <= end_ns {
                    spans.push(s);
                }
            }
        }
    }
    spans
}

fn attrs_of(s: &Map<String, Value>) -> Map<String, Value> {
    match s.get("attributes") {
        Some(Value::Object(m)) => m.clone(),
        _ => Map::new(),
    }
}

fn str_or(v: Option<&Value>, default: &str) -> String {
    match v {
        Some(x) if truthy(x) => py_str(x),
        _ => default.to_string(),
    }
}

// ── cache ───────────────────────────────────────────────────────────────────

fn cache() -> &'static Mutex<IndexMap<String, Option<Value>>> {
    static C: OnceLock<Mutex<IndexMap<String, Option<Value>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(IndexMap::new()))
}

fn cached(key: String, compute: impl FnOnce() -> Option<Value>) -> Option<Value> {
    {
        let mut c = cache().lock().unwrap();
        if let Some(idx) = c.get_index_of(&key) {
            let last = c.len() - 1;
            c.move_index(idx, last);
            return c[last].clone();
        }
    }
    let v = compute();
    let mut c = cache().lock().unwrap();
    c.insert(key, v.clone());
    while c.len() > CACHE_MAXSIZE {
        c.shift_remove_index(0);
    }
    v
}

fn sig_key(kind: &str, parts: &[String], bucket: i64, dir: &str, sigs: &Signatures) -> String {
    json!([kind, parts, bucket, dir, sigs.iter().map(|(p, s, m, i)| json!([p, s, m.to_string(), i])).collect::<Vec<_>>()]).to_string()
}

fn sig_paths(sigs: &Signatures) -> Vec<PathBuf> {
    sigs.iter().map(|(p, ..)| PathBuf::from(p)).collect()
}

// ── summary ─────────────────────────────────────────────────────────────────

fn empty_summary(start: DateTime<Utc>, end: DateTime<Utc>) -> Value {
    summary_json(start, end, Totals::default(), [0.0; 4], vec![], vec![], vec![], vec![])
}

#[derive(Default)]
struct Totals {
    turns: i64,
    llm_calls: i64,
    tool_calls: i64,
    input: i64,
    output: i64,
    cached: i64,
    cache_write: i64,
    cost: f64,
    errors: i64,
}

#[allow(clippy::too_many_arguments)]
fn summary_json(start: DateTime<Utc>, end: DateTime<Utc>, t: Totals, lat: [f64; 4], daily: Vec<Value>, by_model: Vec<Value>, by_step: Vec<Value>, by_tool: Vec<Value>) -> Value {
    json!({
        "window_start": py_iso(start),
        "window_end": py_iso(end),
        "sample_ratio": appv3_core::otel::sample_ratio(),
        "totals": {
            "turns": t.turns,
            "llm_calls": t.llm_calls,
            "tool_calls": t.tool_calls,
            "input_tokens": t.input,
            "output_tokens": t.output,
            "cached_tokens": t.cached,
            "cache_write_tokens": t.cache_write,
            "cache_percent": percent(t.cached as f64, t.input as f64),
            "estimated_cost_usd": t.cost,
            "errors": t.errors,
        },
        "latency_ms": {"turn_p50": lat[0], "turn_p95": lat[1], "llm_p50": lat[2], "llm_p95": lat[3]},
        "daily_turns": daily,
        "by_model": by_model,
        "cache_by_step": by_step,
        "by_tool": by_tool,
    })
}

#[derive(Default)]
struct ModelAgg {
    calls: i64,
    in_tok: i64,
    out_tok: i64,
    cached_tok: i64,
    cache_write_tok: i64,
    cost: f64,
    durations: Vec<f64>,
}

#[derive(Default)]
struct ToolAgg {
    calls: i64,
    errors: i64,
    durations: Vec<f64>,
}

fn run_queries(spans: &[Map<String, Value>], start: DateTime<Utc>, end: DateTime<Utc>) -> Value {
    if spans.is_empty() {
        return empty_summary(start, end);
    }
    let mut t = Totals::default();
    let mut turn_d = vec![];
    let mut llm_d = vec![];
    let mut daily: IndexMap<String, (i64, i64)> = IndexMap::new();
    let mut models: IndexMap<(String, String), ModelAgg> = IndexMap::new();
    let mut steps: IndexMap<(String, String, String), ModelAgg> = IndexMap::new();
    let mut tools: IndexMap<String, ToolAgg> = IndexMap::new();

    for s in spans {
        let name = str_or(s.get("name"), "");
        let is_error = s.get("status").and_then(|v| v.as_str()) == Some("ERROR");
        let dur = safe_float(s.get("duration_ms"));
        let attrs = attrs_of(s);
        let is_run = name.starts_with("agent_run");
        let is_chat = name.starts_with("chat");
        let is_tool = name.starts_with("execute_tool");
        if is_error {
            t.errors += 1;
        }
        if is_run {
            t.turns += 1;
            turn_d.push(dur);
            if let Some(et) = s.get("end_time").filter(|v| truthy(v)).and_then(|v| num(Some(v))) {
                let secs = et / 1e9;
                let dt = Utc.timestamp_opt(secs.floor() as i64, ((secs - secs.floor()) * 1e9) as u32).single().unwrap_or_default();
                let e = daily.entry(dt.format("%Y-%m-%d").to_string()).or_default();
                e.0 += 1;
                if is_error {
                    e.1 += 1;
                }
            }
        } else {
            if is_chat {
                t.llm_calls += 1;
                llm_d.push(dur);
            } else if is_tool {
                t.tool_calls += 1;
            }
            let it = safe_int(attrs.get("gen_ai.usage.input_tokens"));
            let ot = safe_int(attrs.get("gen_ai.usage.output_tokens"));
            let ct = safe_int(attrs.get("gen_ai.usage.cache_read.input_tokens"));
            let cw = safe_int(attrs.get("gen_ai.usage.cache_creation.input_tokens"));
            let cost = safe_float(attrs.get("gen_ai.usage.estimated_cost_usd"));
            t.input += it;
            t.output += ot;
            t.cached += ct;
            t.cache_write += cw;
            t.cost += cost;
            let provider = str_or(attrs.get("gen_ai.provider.name"), "unknown");
            let model = str_or(attrs.get("gen_ai.request.model"), "unknown");
            if attrs.contains_key("gen_ai.usage.input_tokens") || attrs.contains_key("gen_ai.usage.output_tokens") {
                let m = models.entry((provider.clone(), model.clone())).or_default();
                m.calls += 1;
                m.in_tok += it;
                m.out_tok += ot;
                m.cached_tok += ct;
                m.cache_write_tok += cw;
                m.cost += cost;
                m.durations.push(dur);
            }
            if attrs.contains_key("gen_ai.usage.input_tokens") || attrs.contains_key("gen_ai.usage.cache_read.input_tokens") {
                let step = match attrs.get("gen_ai.operation.name").filter(|v| truthy(v)) {
                    Some(op) => py_str(op),
                    None if name.starts_with("summarization") => "summarization".into(),
                    None if name.starts_with("title_generation") => "title_generation".into(),
                    None if name.starts_with("chat") => "chat".into(),
                    None => name.clone(),
                };
                let e = steps.entry((step, provider, model)).or_default();
                e.calls += 1;
                e.in_tok += it;
                e.cached_tok += ct;
                e.cache_write_tok += cw;
                e.cost += cost;
            }
        }
        if is_tool {
            let e = tools.entry(str_or(attrs.get("gen_ai.tool.name"), "unknown")).or_default();
            e.calls += 1;
            if is_error {
                e.errors += 1;
            }
            e.durations.push(dur);
        }
    }

    let mut daily_v: Vec<(String, (i64, i64))> = daily.into_iter().collect();
    daily_v.sort_by(|a, b| a.0.cmp(&b.0));
    let daily_turns = daily_v.into_iter().map(|(day, (turns, errors))| json!({"day": day, "turns": turns, "errors": errors})).collect();

    let mut mv: Vec<_> = models.into_iter().collect();
    mv.sort_by(|a, b| cmp_f64(b.1.cost, a.1.cost).then(b.1.calls.cmp(&a.1.calls)));
    let by_model = mv
        .into_iter()
        .map(|((p, m), d)| {
            json!({
                "provider": p, "model": m, "provider_model": format!("{p}:{m}"),
                "calls": d.calls, "input_tokens": d.in_tok, "output_tokens": d.out_tok,
                "cached_tokens": d.cached_tok, "cache_write_tokens": d.cache_write_tok,
                "cache_percent": percent(d.cached_tok as f64, d.in_tok as f64),
                "estimated_cost_usd": py_round(d.cost, 8),
                "p95_ms": py_round(quantile(&d.durations, 0.95), 1),
            })
        })
        .collect();

    let mut sv: Vec<_> = steps.into_iter().collect();
    sv.sort_by(|a, b| cmp_f64(b.1.cost, a.1.cost).then(b.1.in_tok.cmp(&a.1.in_tok)));
    let by_step = sv
        .into_iter()
        .map(|((step, p, m), d)| {
            json!({
                "step": step, "provider": p, "model": m, "provider_model": format!("{p}:{m}"),
                "calls": d.calls, "input_tokens": d.in_tok, "cached_tokens": d.cached_tok,
                "cache_write_tokens": d.cache_write_tok, "miss_tokens": (d.in_tok - d.cached_tok).max(0),
                "cache_percent": percent(d.cached_tok as f64, d.in_tok as f64),
                "estimated_cost_usd": py_round(d.cost, 8),
            })
        })
        .collect();

    let mut tv: Vec<_> = tools.into_iter().collect();
    tv.sort_by(|a, b| b.1.calls.cmp(&a.1.calls));
    let by_tool = tv.into_iter().map(|(tool, d)| json!({"tool": tool, "calls": d.calls, "errors": d.errors, "p95_ms": py_round(quantile(&d.durations, 0.95), 1)})).collect();

    t.cost = py_round(t.cost, 8);
    let lat = [py_round(quantile(&turn_d, 0.5), 1), py_round(quantile(&turn_d, 0.95), 1), py_round(quantile(&llm_d, 0.5), 1), py_round(quantile(&llm_d, 0.95), 1)];
    summary_json(start, end, t, lat, daily_turns, by_model, by_step, by_tool)
}

/// `summarize(days)`.
pub fn summarize(days: i64) -> Value {
    let days = days.clamp(1, 90);
    let (now, bucket, dir, sigs) = cache_context(days);
    let ratio = appv3_core::otel::sample_ratio();
    let key = sig_key("summary", &[days.to_string(), appv3_core::pyjson::float_repr(ratio)], bucket, &dir, &sigs);
    cached(key, || {
        let start = now - Duration::days(days);
        let files = sig_paths(&sigs);
        if files.is_empty() {
            return Some(empty_summary(start, now));
        }
        Some(run_queries(&load_spans_in_window(&files, start, now), start, now))
    })
    .unwrap_or(Value::Null)
}

// ── traces ──────────────────────────────────────────────────────────────────

/// `list_traces_with_count` → `(items, total)`.
pub fn list_traces_with_count(days: i64, limit: i64, offset: i64) -> (Vec<Value>, i64) {
    let days = days.clamp(1, 90);
    let limit = limit.clamp(1, 200);
    let offset = offset.max(0);
    let (now, bucket, dir, sigs) = cache_context(days);
    let key = sig_key("traces", &[days.to_string(), limit.to_string(), offset.to_string()], bucket, &dir, &sigs);
    let v = cached(key, || {
        let start = now - Duration::days(days);
        let files = sig_paths(&sigs);
        if files.is_empty() {
            return Some(json!([[], 0]));
        }
        let spans = load_spans_in_window(&files, start, now);
        let (items, total) = list_traces(&spans, limit, offset);
        Some(json!([items, total]))
    })
    .unwrap_or(json!([[], 0]));
    (v[0].as_array().cloned().unwrap_or_default(), v[1].as_i64().unwrap_or(0))
}

#[derive(Default)]
struct TraceAgg {
    llm_calls: i64,
    tool_calls: i64,
    input: i64,
    output: i64,
    cached: i64,
    cost: f64,
}

fn opt_str(v: Option<&Value>) -> Value {
    match v {
        None | Some(Value::Null) => Value::Null,
        Some(x) => json!(py_str(x)),
    }
}

fn list_traces(spans: &[Map<String, Value>], limit: i64, offset: i64) -> (Vec<Value>, i64) {
    let mut counts: IndexMap<String, TraceAgg> = IndexMap::new();
    let mut runs: Vec<&Map<String, Value>> = vec![];
    for s in spans {
        let name = str_or(s.get("name"), "");
        let Some(tid) = s.get("trace_id").filter(|v| truthy(v)) else { continue };
        let attrs = attrs_of(s);
        let c = counts.entry(py_str(tid)).or_default();
        if name.starts_with("agent_run") {
            runs.push(s);
        } else {
            if name.starts_with("chat") {
                c.llm_calls += 1;
            } else if name.starts_with("execute_tool") {
                c.tool_calls += 1;
            }
            c.input += safe_int(attrs.get("gen_ai.usage.input_tokens"));
            c.output += safe_int(attrs.get("gen_ai.usage.output_tokens"));
            c.cached += safe_int(attrs.get("gen_ai.usage.cache_read.input_tokens"));
            c.cost += safe_float(attrs.get("gen_ai.usage.estimated_cost_usd"));
        }
    }
    let end_key = |s: &Map<String, Value>| num(Some(&ns_or_zero(s.get("end_time")))).unwrap_or(0.0);
    runs.sort_by(|a, b| cmp_f64(end_key(b), end_key(a)));
    let total = runs.len() as i64;
    let empty = TraceAgg::default();
    let items = runs
        .into_iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(|s| {
            let tid = py_str(s.get("trace_id").unwrap_or(&Value::Null));
            let attrs = attrs_of(s);
            let c = counts.get(&tid).unwrap_or(&empty);
            let provider = opt_str(attrs.get("gen_ai.provider.name"));
            let model = opt_str(attrs.get("gen_ai.request.model"));
            let pm = match (provider.as_str(), model.as_str()) {
                (Some(p), Some(m)) => json!(format!("{p}:{m}")),
                _ => Value::Null,
            };
            json!({
                "trace_id": tid,
                "span_id": py_str(s.get("span_id").unwrap_or(&Value::Null)),
                "run_id": opt_str(attrs.get("run_id")),
                "session_id": opt_str(attrs.get("gen_ai.conversation.id")),
                "agent_name": opt_str(attrs.get("gen_ai.agent.name")),
                "provider": provider,
                "model": model,
                "provider_model": pm,
                "start_ms": ns_to_ms(&ns_or_zero(s.get("start_time"))),
                "end_ms": ns_to_ms(&ns_or_zero(s.get("end_time"))),
                "duration_ms": py_round(safe_float(s.get("duration_ms")), 1),
                "input_tokens": c.input,
                "output_tokens": c.output,
                "cached_tokens": c.cached,
                "estimated_cost_usd": py_round(c.cost, 8),
                "tool_calls": c.tool_calls,
                "llm_calls": c.llm_calls,
                "error": s.get("status").and_then(|v| v.as_str()) == Some("ERROR"),
            })
        })
        .collect();
    (items, total)
}

/// `get_trace(trace_id, days)`.
pub fn get_trace(trace_id: &str, days: i64) -> Option<Value> {
    let days = days.clamp(1, 90);
    let mut tid = trace_id.to_lowercase();
    if !tid.starts_with("0x") {
        tid = format!("0x{tid}");
    }
    let (now, bucket, dir, sigs) = cache_context(days);
    let key = sig_key("trace", &[tid.clone(), days.to_string()], bucket, &dir, &sigs);
    cached(key, || {
        let start = now - Duration::days(days);
        let files = sig_paths(&sigs);
        if files.is_empty() {
            return None;
        }
        let spans = load_spans_in_window(&files, start, now);
        let mut matching: Vec<&Map<String, Value>> = spans.iter().filter(|s| py_str(s.get("trace_id").unwrap_or(&Value::Null)).to_lowercase() == tid).collect();
        if matching.is_empty() {
            return None;
        }
        let start_key = |s: &Map<String, Value>| num(Some(&ns_or_zero(s.get("start_time")))).unwrap_or(0.0);
        matching.sort_by(|a, b| cmp_f64(start_key(a), start_key(b)));
        let out: Vec<Value> = matching
            .into_iter()
            .map(|s| {
                let attrs: Map<String, Value> = match s.get("attributes") {
                    Some(Value::Object(m)) => m.iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k.clone(), v.clone())).collect(),
                    _ => Map::new(),
                };
                json!({
                    "span_id": py_str(s.get("span_id").unwrap_or(&Value::Null)),
                    "parent_span_id": opt_str(s.get("parent_id")),
                    "trace_id": py_str(s.get("trace_id").unwrap_or(&Value::Null)),
                    "name": str_or(s.get("name"), ""),
                    "kind": str_or(s.get("kind"), "INTERNAL"),
                    "start_ms": ns_to_ms(&ns_or_zero(s.get("start_time"))),
                    "end_ms": ns_to_ms(&ns_or_zero(s.get("end_time"))),
                    "duration_ms": py_round(safe_float(s.get("duration_ms")), 1),
                    "status": str_or(s.get("status"), "UNSET"),
                    "attributes": attrs,
                })
            })
            .collect();
        Some(json!({"trace_id": out[0]["trace_id"], "spans": out}))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantiles_and_percent() {
        assert_eq!(quantile(&[], 0.5), 0.0);
        assert_eq!(quantile(&[3.0], 0.95), 3.0);
        assert!((quantile(&[1.0, 2.0, 3.0, 4.0], 0.95) - 3.85).abs() < 1e-9);
        assert_eq!(percent(1.0, 3.0), 33.3);
        assert_eq!(percent(1.0, 0.0), 0.0);
    }

    #[test]
    fn py_str_forms() {
        assert_eq!(py_str(&json!(1.0)), "1.0");
        assert_eq!(py_str(&json!(true)), "True");
        assert_eq!(py_str(&json!(["a", 1])), "['a', 1]");
        assert_eq!(safe_int(Some(&json!(2.9))), 2);
        assert_eq!(safe_int(Some(&json!("7"))), 7);
        assert_eq!(safe_int(Some(&json!("7.5"))), 0);
    }
}
