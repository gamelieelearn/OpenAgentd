//! Builtin OAuth login flows (`app/cli/commands/auth.py::_PROVIDERS`).

use crate::plugin::OAuthSink;

/// `(provider, description)` — `openagentd auth` listing order is sorted.
pub const PROVIDERS: [(&str, &str); 3] = [
    ("copilot", "GitHub Copilot — device-flow OAuth"),
    ("codex", "OpenAI Codex — PKCE OAuth (ChatGPT subscription)"),
    ("grok", "Grok Build — device-flow OAuth (Grok subscription)"),
];

/// Run the builtin `login(event_sink=sink)` for `codex` / `copilot` / `grok`
/// (UI flow: codex defaults to the device flow unless `browser`).
pub async fn builtin_login(provider_id: &str, browser: bool, sink: OAuthSink) -> Result<(), String> {
    match provider_id {
        "codex" => crate::codex::login(Some(sink), false, browser).await,
        "copilot" => crate::copilot::login(Some(sink), None).await,
        "grok" => crate::grok::login(Some(sink)).await,
        _ => Err(format!("Unknown OAuth provider '{provider_id}'.")),
    }
}

/// Builtin OAuth modules expose no `callback`/`oauth_callback` in v2.
pub async fn builtin_callback(_provider_id: &str, _code: &str, _sink: OAuthSink) -> Option<Result<(), String>> {
    None
}
