//! Verbatim v2 prompt strings (`contract/builtin_prompts.json`).

use serde_json::Value;
use std::sync::OnceLock;

const JSON: &str = include_str!("../../../contract/builtin_prompts.json");

pub fn contract() -> &'static Value {
    static C: OnceLock<Value> = OnceLock::new();
    C.get_or_init(|| serde_json::from_str(JSON).expect("builtin_prompts.json"))
}

pub fn s(key: &str) -> &'static str {
    contract().get(key).and_then(|v| v.as_str()).unwrap_or("")
}

pub fn coding_prompt() -> &'static str {
    s("coding_prompt")
}
pub fn coding_description() -> &'static str {
    s("coding_description")
}
pub fn coding_tools() -> Vec<String> {
    contract()["coding_tools"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default()
}
/// `BUILTIN_MEMBER_PROFILES` (insertion order: explorer, researcher).
pub fn member_profiles() -> &'static serde_json::Map<String, Value> {
    contract()["members"].as_object().expect("members")
}
