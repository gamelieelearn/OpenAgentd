//! Serve a workspace directory for previews of plain HTML files.
//!
//! Paths stay inside the root, and the same denied-path rules as the file
//! tools apply, so `.git`, `.env*`, keys, and the app's data dirs are never
//! served.

use crate::inject::inject;
use crate::manager::Entry;
use crate::proxy::plain;
use axum::body::Body;
use axum::extract::Request;
use axum::http::{header, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use std::path::{Path, PathBuf};

/// Largest file served; previews are for pages, not archives.
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;

/// Percent-encode a workspace-relative path for use as a URL path.
pub fn url_path(rel: &str) -> String {
    const SEGMENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'~');
    let encoded: Vec<String> = rel.split('/').filter(|s| !s.is_empty()).map(|s| percent_encoding::utf8_percent_encode(s, SEGMENT).to_string()).collect();
    format!("/{}", encoded.join("/"))
}

/// A workspace file to preview: relative, inside the root, not denied.
pub fn resolve_workspace_file(root: &Path, rel: &str) -> Result<String, String> {
    let rel = rel.trim().trim_start_matches("./").replace('\\', "/");
    if rel.is_empty() || rel.starts_with('/') || (rel.len() >= 2 && rel.as_bytes()[1] == b':') {
        return Err("path must be relative to the workspace.".into());
    }
    if Path::new(&rel).components().any(|c| matches!(c, std::path::Component::ParentDir)) || appv3_core::security::is_denied_path(Path::new(&rel)) {
        return Err(format!("'{rel}' cannot be previewed."));
    }
    let root = appv3_tools::denied::resolve(root);
    let resolved = appv3_tools::denied::resolve(&root.join(&rel));
    if !resolved.starts_with(&root) {
        return Err(format!("'{rel}' is outside the workspace."));
    }
    if !resolved.is_file() {
        return Err(format!("'{rel}' is not a file in the workspace."));
    }
    Ok(rel)
}

#[derive(Debug, PartialEq)]
pub(crate) enum Resolved {
    File(PathBuf),
    /// A directory requested without a trailing slash.
    RedirectToSlash,
    Denied,
    NotFound,
}

/// Map a URL path onto a file under `root` (already resolved).
pub(crate) fn resolve_path(root: &Path, url_path: &str, denied: Option<&appv3_tools::denied::DeniedPaths>) -> Resolved {
    let decoded = percent_encoding::percent_decode_str(url_path).decode_utf8_lossy().to_string();
    if decoded.contains('\0') || decoded.contains('\\') {
        return Resolved::NotFound;
    }
    let rel = decoded.trim_start_matches('/');
    let rel_path = Path::new(rel);
    if rel_path.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::Prefix(_) | std::path::Component::RootDir)) {
        return Resolved::NotFound;
    }
    if appv3_core::security::is_denied_path(rel_path) {
        return Resolved::Denied;
    }
    let resolved = appv3_tools::denied::resolve(&root.join(rel_path));
    if !resolved.starts_with(root) {
        return Resolved::Denied;
    }
    if let Ok(inner) = resolved.strip_prefix(root) {
        if appv3_core::security::is_denied_path(inner) {
            return Resolved::Denied;
        }
    }
    if denied.is_some_and(|d| d.is_denied_read_path(&resolved)) {
        return Resolved::Denied;
    }
    if resolved.is_dir() {
        if !decoded.is_empty() && !decoded.ends_with('/') {
            return Resolved::RedirectToSlash;
        }
        let index = resolved.join("index.html");
        return if index.is_file() { Resolved::File(index) } else { Resolved::NotFound };
    }
    if resolved.is_file() {
        Resolved::File(resolved)
    } else {
        Resolved::NotFound
    }
}

pub(crate) async fn serve(entry: &Entry, root: &Path, req: Request) -> Response {
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return plain(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed.");
    }
    let head = req.method() == Method::HEAD;
    let url_path = req.uri().path().to_string();
    let file = match resolve_path(root, &url_path, entry.denied.as_ref()) {
        Resolved::File(f) => f,
        Resolved::RedirectToSlash => {
            let query = req.uri().query().map(|q| format!("?{q}")).unwrap_or_default();
            return (StatusCode::FOUND, [(header::LOCATION, format!("{url_path}/{query}")), (header::CACHE_CONTROL, "no-store".to_string())]).into_response();
        }
        Resolved::Denied => return plain(StatusCode::FORBIDDEN, "This path is not served by the preview."),
        Resolved::NotFound => return plain(StatusCode::NOT_FOUND, "Not found."),
    };
    let size = tokio::fs::metadata(&file).await.map(|m| m.len()).unwrap_or(0);
    if size > MAX_FILE_BYTES {
        return plain(StatusCode::PAYLOAD_TOO_LARGE, "File too large to preview.");
    }
    let name = file.to_string_lossy().to_string();
    let media = appv3_core::mimetypes::guess_type(&name).unwrap_or_else(|| "application/octet-stream".to_string());
    let html = media == "text/html";
    let content_type = if media.starts_with("text/") || media == "application/javascript" { format!("{media}; charset=utf-8") } else { media };
    let body = match tokio::fs::read(&file).await {
        Ok(b) => b,
        Err(e) => return plain(StatusCode::NOT_FOUND, &format!("Could not read file: {e}")),
    };
    let body = if html { inject(&body) } else { body };
    let len = body.len();
    let mut resp = Response::new(if head { Body::empty() } else { Body::from(body) });
    let h = resp.headers_mut();
    if let Ok(v) = content_type.parse() {
        h.insert(header::CONTENT_TYPE, v);
    }
    h.insert(header::CONTENT_LENGTH, len.into());
    h.insert(header::CACHE_CONTROL, "no-store".parse().expect("static header"));
    crate::proxy::add_frame_ancestors(h);
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = appv3_tools::denied::resolve(dir.path());
        std::fs::create_dir_all(root.join("site/css")).unwrap();
        std::fs::write(root.join("site/index.html"), "<html></html>").unwrap();
        std::fs::write(root.join("site/css/a.css"), "a{}").unwrap();
        std::fs::write(root.join("page.html"), "<p>").unwrap();
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::write(root.join(".git/config"), "x").unwrap();
        std::fs::write(root.join(".env"), "SECRET=1").unwrap();
        (dir, root)
    }

    #[test]
    fn serves_files_and_directory_indexes() {
        let (_d, r) = root();
        assert_eq!(resolve_path(&r, "/page.html", None), Resolved::File(r.join("page.html")));
        assert_eq!(resolve_path(&r, "/site/", None), Resolved::File(r.join("site/index.html")));
        assert_eq!(resolve_path(&r, "/site", None), Resolved::RedirectToSlash);
        assert_eq!(resolve_path(&r, "/site/css/a.css", None), Resolved::File(r.join("site/css/a.css")));
        assert_eq!(resolve_path(&r, "/site/css/", None), Resolved::NotFound);
        assert_eq!(resolve_path(&r, "/missing.html", None), Resolved::NotFound);
    }

    #[test]
    fn refuses_traversal_and_denied_paths() {
        let (_d, r) = root();
        assert_eq!(resolve_path(&r, "/../etc/passwd", None), Resolved::NotFound);
        assert_eq!(resolve_path(&r, "/%2e%2e/etc/passwd", None), Resolved::NotFound);
        assert_eq!(resolve_path(&r, "/site/%2E%2E/%2E%2E/x", None), Resolved::NotFound);
        assert_eq!(resolve_path(&r, "/.git/config", None), Resolved::Denied);
        assert_eq!(resolve_path(&r, "/.env", None), Resolved::Denied);
        assert_eq!(resolve_path(&r, "/a%00.html", None), Resolved::NotFound);
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_that_leave_the_root() {
        let (_d, r) = root();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "x").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret.txt"), r.join("link.txt")).unwrap();
        assert_eq!(resolve_path(&r, "/link.txt", None), Resolved::Denied);
    }

    #[test]
    fn encodes_url_paths() {
        assert_eq!(url_path("designs/landing page.html"), "/designs/landing%20page.html");
        assert_eq!(url_path("a/ü#.html"), "/a/%C3%BC%23.html");
    }

    #[test]
    fn resolves_only_workspace_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("index.html"), "x").unwrap();
        std::fs::write(dir.path().join(".env"), "x").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        assert_eq!(resolve_workspace_file(dir.path(), "./index.html").unwrap(), "index.html");
        for bad in ["", "/etc/passwd", "../x.html", ".env", "sub", "missing.html", "C:/x.html"] {
            assert!(resolve_workspace_file(dir.path(), bad).is_err(), "{bad}");
        }
    }
}
