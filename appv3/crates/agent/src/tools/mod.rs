//! Session-bound tools (v2 `app/agent/tools/builtin/{question,team,member,skill,schedule}.py`).

pub mod ask_user;
pub mod team;

use appv3_tools::ToolError;

/// v2 `Tool.arun` validation failure text.
pub fn invalid_args(tool: &str, errors: &[String]) -> ToolError {
    ToolError::Argument(format!("Invalid arguments for tool '{tool}': {}", errors.join("; ")))
}

/// Pydantic lax bool.
pub fn lax_bool(v: &serde_json::Value) -> Option<bool> {
    appv3_tools::args::coerce_bool(v)
}
