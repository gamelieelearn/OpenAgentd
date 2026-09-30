//! Preview targets: a loopback dev server or a workspace directory.
//!
//! Only loopback origins are proxied. Anything else would turn the preview
//! listener into an SSRF relay reachable from the page it serves.

use reqwest::Url;
use std::fmt;
use std::net::IpAddr;
use std::path::PathBuf;

/// A loopback origin the proxy forwards to.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct UrlTarget {
    pub scheme: String,
    /// Host as written in a URL: `localhost`, `127.0.0.1`, or `[::1]`.
    pub host: String,
    pub port: u16,
}

impl UrlTarget {
    pub fn origin(&self) -> String {
        format!("{}://{}:{}", self.scheme, self.host, self.port)
    }

    pub fn authority(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }

    /// Origins that name the same server (`localhost` vs `127.0.0.1`).
    pub fn origin_aliases(&self) -> Vec<String> {
        let mut hosts = vec![self.host.clone()];
        for h in ["localhost", "127.0.0.1", "[::1]"] {
            if !hosts.iter().any(|x| x == h) {
                hosts.push(h.to_string());
            }
        }
        hosts.into_iter().map(|h| format!("{}://{}:{}", self.scheme, h, self.port)).collect()
    }
}

/// What a preview listener serves.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Backend {
    Upstream(UrlTarget),
    /// A workspace root served as static files.
    Static(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetError {
    Invalid(String),
}

impl fmt::Display for TargetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TargetError::Invalid(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for TargetError {}

fn invalid(msg: impl Into<String>) -> TargetError {
    TargetError::Invalid(msg.into())
}

/// Parse a user- or agent-supplied URL into a loopback target plus the path
/// (with query and fragment) to open first. A bare `localhost:3000` or
/// `:3000` gets `http://` added.
pub fn parse_url_target(raw: &str) -> Result<(UrlTarget, String), TargetError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(invalid("URL is empty."));
    }
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else if let Some(port) = raw.strip_prefix(':') {
        format!("http://localhost:{port}")
    } else {
        format!("http://{raw}")
    };
    let url = Url::parse(&with_scheme).map_err(|e| invalid(format!("Invalid URL '{raw}': {e}.")))?;
    let scheme = url.scheme().to_string();
    if scheme != "http" && scheme != "https" {
        return Err(invalid(format!("Only http and https URLs can be previewed, not '{scheme}'.")));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(invalid("Preview URLs cannot contain credentials."));
    }
    let host = match url.host() {
        Some(url::Host::Domain(d)) if d.eq_ignore_ascii_case("localhost") => "localhost".to_string(),
        Some(url::Host::Ipv4(ip)) if ip.is_unspecified() => "127.0.0.1".to_string(),
        Some(url::Host::Ipv4(ip)) if IpAddr::V4(ip).is_loopback() => ip.to_string(),
        Some(url::Host::Ipv6(ip)) if ip.is_loopback() || ip.is_unspecified() => "[::1]".to_string(),
        _ => return Err(invalid(format!("Only local servers (localhost, 127.0.0.1, ::1) can be previewed, not '{}'.", url.host_str().unwrap_or("")))),
    };
    let port = url.port_or_known_default().ok_or_else(|| invalid("URL has no port."))?;
    let mut path = url.path().to_string();
    if let Some(q) = url.query() {
        path.push('?');
        path.push_str(q);
    }
    if let Some(f) = url.fragment() {
        path.push('#');
        path.push_str(f);
    }
    Ok((UrlTarget { scheme, host, port }, path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(raw: &str) -> (String, String) {
        let (t, p) = parse_url_target(raw).unwrap();
        (t.origin(), p)
    }

    #[test]
    fn accepts_loopback_urls() {
        assert_eq!(ok("http://localhost:5173/pricing?x=1#top"), ("http://localhost:5173".into(), "/pricing?x=1#top".into()));
        assert_eq!(ok("http://127.0.0.1:3000"), ("http://127.0.0.1:3000".into(), "/".into()));
        assert_eq!(ok("http://127.1.2.3:3000/"), ("http://127.1.2.3:3000".into(), "/".into()));
        assert_eq!(ok("https://localhost:8443/"), ("https://localhost:8443".into(), "/".into()));
        assert_eq!(ok("http://[::1]:4000/a"), ("http://[::1]:4000".into(), "/a".into()));
        assert_eq!(ok("http://LOCALHOST/"), ("http://localhost:80".into(), "/".into()));
    }

    #[test]
    fn normalizes_shorthand_and_unspecified() {
        assert_eq!(ok("localhost:3000"), ("http://localhost:3000".into(), "/".into()));
        assert_eq!(ok(":5173"), ("http://localhost:5173".into(), "/".into()));
        assert_eq!(ok("http://0.0.0.0:8080/x"), ("http://127.0.0.1:8080".into(), "/x".into()));
    }

    #[test]
    fn rejects_non_loopback_and_odd_urls() {
        for raw in [
            "",
            "http://example.com",
            "http://192.168.1.2:3000",
            "http://10.0.0.1",
            "ftp://localhost/",
            "file:///etc/passwd",
            "http://user:pw@localhost:3000/",
            "http://localhost.evil.com:3000",
            "javascript:alert(1)",
        ] {
            assert!(parse_url_target(raw).is_err(), "{raw} should be rejected");
        }
    }

    #[test]
    fn aliases_cover_loopback_names() {
        let (t, _) = parse_url_target("http://localhost:5173").unwrap();
        assert_eq!(t.origin_aliases(), vec!["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173"]);
    }
}
