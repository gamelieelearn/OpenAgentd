//! Access-token policy — port of `app/core/desktop_auth.py`
//! (the HTTP middleware lives in the api crate).

use crate::runtime_settings::load_server_settings;

pub const DESKTOP_TOKEN_ENV: &str = "OPENAGENTD_DESKTOP_TOKEN";
pub const ACCESS_KEY_ENV: &str = "OPENAGENTD_ACCESS_KEY";
pub const QS_TOKEN_PARAM: &str = "_token";

/// `configured_access_token()`: desktop token > access-key env > server.yaml.
pub fn configured_access_token() -> String {
    std::env::var(DESKTOP_TOKEN_ENV)
        .ok()
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var(ACCESS_KEY_ENV).ok().filter(|v| !v.is_empty()))
        .or_else(|| load_server_settings().ok().and_then(|s| s.access_key).filter(|v| !v.is_empty()))
        .unwrap_or_default()
}

const EXEMPT_EXACT: [&str; 9] = ["/api/health/live", "/api/health/ready", "/", "/index.html", "/favicon.ico", "/favicon.svg", "/vite.svg", "/robots.txt", "/manifest.json"];
const EXEMPT_PREFIXES: [&str; 3] = ["/api/health/", "/assets/", "/static/"];

pub fn path_is_api(path: &str) -> bool {
    path == "/api" || path.starts_with("/api/")
}

/// Paths reachable without a token (probes and the SPA shell).
pub fn path_is_exempt(path: &str) -> bool {
    EXEMPT_EXACT.contains(&path) || EXEMPT_PREFIXES.iter().any(|p| path.starts_with(p)) || !path_is_api(path)
}

/// Constant-time string comparison (`hmac.compare_digest`).
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// `is_loopback_host` from `app/cli/net.py`.
pub fn is_loopback_host(host: &str) -> bool {
    let h = host.trim().trim_start_matches('[').trim_end_matches(']');
    if h.eq_ignore_ascii_case("localhost") {
        return true;
    }
    h.parse::<std::net::IpAddr>().map(|ip| ip.is_loopback()).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exemptions_match_v2() {
        assert!(path_is_exempt("/api/health/live"));
        assert!(path_is_exempt("/api/health/anything"));
        assert!(path_is_exempt("/assets/app.js"));
        assert!(path_is_exempt("/settings/providers"));
        assert!(!path_is_exempt("/api/health"));
        assert!(!path_is_exempt("/api/agent/chat"));
        assert!(!path_is_exempt("/api"));
    }

    #[test]
    fn compare() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "abcd"));
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("localhost"));
        assert!(!is_loopback_host("192.168.1.2"));
    }
}
