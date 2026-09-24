//! Port of `app/agent/usage.py`.

use crate::registry::get_model_cost;
use crate::types::Usage;
use serde_json::{json, Map, Value};

pub fn usage_to_dict(usage: &Usage, model_id: Option<&str>) -> Value {
    let mut r = Map::new();
    r.insert("input".into(), json!(usage.prompt_tokens));
    r.insert("output".into(), json!(usage.completion_tokens));
    if let Some(v) = usage.cached_tokens {
        r.insert("cache".into(), json!(v));
    }
    if let Some(v) = usage.cache_write_tokens {
        r.insert("cache_write".into(), json!(v));
    }
    if let Some(v) = usage.thoughts_tokens {
        r.insert("thoughts".into(), json!(v));
    }
    if let Some(v) = usage.tool_use_tokens {
        r.insert("tool_use".into(), json!(v));
    }
    if let Some(cost) = estimate_cost(usage, model_id) {
        r.insert("cost".into(), cost);
    }
    Value::Object(r)
}

fn estimate_cost(usage: &Usage, model_id: Option<&str>) -> Option<Value> {
    let prices = get_model_cost(model_id);
    let mut comps: Vec<(&str, f64)> = vec![];
    let cached = usage.cached_tokens.unwrap_or(0);
    let cw = usage.cache_write_tokens.unwrap_or(0);
    let mut input = usage.prompt_tokens;
    if let (Some(p), true) = (prices.cache_read, cached > 0) {
        comps.push(("cache_read_usd", cached as f64 * p / 1_000_000.0));
        input -= cached;
    }
    if let (Some(p), true) = (prices.cache_write, cw > 0) {
        comps.push(("cache_write_usd", cw as f64 * p / 1_000_000.0));
        input -= cw;
    }
    let input = input.max(0);
    if let (Some(p), true) = (prices.input, input > 0) {
        comps.push(("input_usd", input as f64 * p / 1_000_000.0));
    }
    if let (Some(p), true) = (prices.output, usage.completion_tokens > 0) {
        comps.push(("output_usd", usage.completion_tokens as f64 * p / 1_000_000.0));
    }
    if comps.is_empty() {
        return None;
    }
    // Python dict order: estimated_usd first, then components in insertion order.
    let total = appv3_core::pymath::py_sum(comps.iter().map(|(_, v)| *v));
    let mut m = Map::new();
    m.insert("estimated_usd".into(), json!(total));
    for (k, v) in comps {
        m.insert(k.into(), json!(v));
    }
    Some(Value::Object(m))
}
