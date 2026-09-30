//! Insert the inspector `<script>` into HTML responses.

use crate::INSPECTOR_PATH;

pub fn script_tag() -> String {
    format!("<script src=\"{INSPECTOR_PATH}\"></script>")
}

/// Byte index just past the opening tag `<name ...>`, matched
/// case-insensitively. `<header>` does not count as `<head>`.
fn after_open_tag(html: &[u8], name: &[u8]) -> Option<usize> {
    let lower: Vec<u8> = html.iter().map(|b| b.to_ascii_lowercase()).collect();
    let mut from = 0;
    while let Some(rel) = find(&lower[from..], b"<") {
        let start = from + rel + 1;
        let end = start + name.len();
        if lower.len() >= end && &lower[start..end] == name {
            let next = lower.get(end).copied();
            if matches!(next, Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') | Some(b'/')) {
                let close = find(&lower[end..], b">")?;
                return Some(end + close + 1);
            }
        }
        from = start;
    }
    None
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// The document with the inspector script after `<head>`, else after
/// `<html>`, else at the start (after a UTF-8 BOM).
pub fn inject(html: &[u8]) -> Vec<u8> {
    let tag = script_tag();
    let at = after_open_tag(html, b"head").or_else(|| after_open_tag(html, b"html")).unwrap_or(if html.starts_with(&[0xEF, 0xBB, 0xBF]) { 3 } else { 0 });
    let mut out = Vec::with_capacity(html.len() + tag.len());
    out.extend_from_slice(&html[..at]);
    out.extend_from_slice(tag.as_bytes());
    out.extend_from_slice(&html[at..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inj(s: &str) -> String {
        String::from_utf8(inject(s.as_bytes())).unwrap()
    }

    #[test]
    fn goes_after_head() {
        let t = script_tag();
        assert_eq!(inj("<!doctype html><html><head><title>x</title></head></html>"), format!("<!doctype html><html><head>{t}<title>x</title></head></html>"));
        assert_eq!(inj("<HTML><HEAD lang=\"en\">"), format!("<HTML><HEAD lang=\"en\">{t}"));
    }

    #[test]
    fn header_is_not_head() {
        let t = script_tag();
        assert_eq!(inj("<html><body><header>x</header></body></html>"), format!("<html>{t}<body><header>x</header></body></html>"));
    }

    #[test]
    fn falls_back_to_start() {
        let t = script_tag();
        assert_eq!(inj("<p>hi</p>"), format!("{t}<p>hi</p>"));
        let bom = inject("\u{feff}<p>hi</p>".as_bytes());
        assert!(bom.starts_with(&[0xEF, 0xBB, 0xBF]));
        assert_eq!(String::from_utf8(bom[3..].to_vec()).unwrap(), format!("{t}<p>hi</p>"));
    }
}
