//! Code/document outline — port of `filesystem/outline.py` (Python outline is
//! regex-based here instead of `ast`).

use regex::Regex;
use std::path::Path;
use std::sync::OnceLock;

fn rx(p: &str) -> Regex {
    Regex::new(p).unwrap()
}

fn py_outline(lines: &[&str]) -> Vec<(usize, String)> {
    static CLASS: OnceLock<Regex> = OnceLock::new();
    static DEF: OnceLock<Regex> = OnceLock::new();
    let class = CLASS.get_or_init(|| rx(r"^class\s+(\w+)\s*(\((.*)\))?\s*:"));
    let def = DEF.get_or_init(|| rx(r"^(\s*)(async\s+)?def\s+\w+"));
    let mut out = vec![];
    let mut in_class = false;
    let mut class_indent: Option<usize> = None;
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let indent = line.len() - line.trim_start().len();
        if !line.trim().is_empty() && indent == 0 && !line.starts_with('#') && !line.starts_with('@') {
            in_class = false;
            class_indent = None;
        }
        if let Some(c) = class.captures(line) {
            let bases = c.get(3).map(|m| m.as_str().trim().to_string()).filter(|s| !s.is_empty());
            out.push((i + 1, format!("class {}{}:", &c[1], bases.map(|b| format!("({b})")).unwrap_or_default())));
            in_class = true;
            i += 1;
            continue;
        }
        if let Some(c) = def.captures(line) {
            let ind = c[1].len();
            let top = ind == 0;
            let method = in_class && ind > 0 && class_indent.map(|ci| ci == ind).unwrap_or(true);
            if top || method {
                if method {
                    class_indent.get_or_insert(ind);
                }
                // join a multi-line signature up to the trailing ':'
                let mut sig = line.trim().to_string();
                let mut j = i;
                let mut depth: i32 = sig
                    .chars()
                    .map(|ch| match ch {
                        '(' | '[' => 1,
                        ')' | ']' => -1,
                        _ => 0,
                    })
                    .sum();
                while depth > 0 && j + 1 < lines.len() {
                    j += 1;
                    let t = lines[j].trim();
                    depth += t
                        .chars()
                        .map(|ch| match ch {
                            '(' | '[' => 1,
                            ')' | ']' => -1,
                            _ => 0,
                        })
                        .sum::<i32>();
                    if sig.ends_with('(') || sig.ends_with('[') || t.starts_with(')') || t.starts_with(']') {
                        sig.push_str(t);
                    } else {
                        sig.push(' ');
                        sig.push_str(t);
                    }
                }
                let sig = sig.trim_end_matches(':').trim().replace(",)", ")");
                out.push((i + 1, if method { format!("  {sig}") } else { sig }));
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn ts_outline(lines: &[&str]) -> Vec<(usize, String)> {
    let (iface, ty, func, class, en, cst) = (
        rx(r"^(export\s+)?(default\s+)?interface\s+\w+"),
        rx(r"^(export\s+)?(default\s+)?type\s+\w+\s*="),
        rx(r"^(export\s+)?(default\s+)?(async\s+)?function\s+\w+"),
        rx(r"^(export\s+)?(default\s+)?class\s+\w+"),
        rx(r"^(export\s+)?enum\s+\w+"),
        rx(r"^export\s+const\s+(use\w+|[A-Z]\w+)\s*="),
    );
    let mut out = vec![];
    for (i, line) in lines.iter().enumerate() {
        let s = line.trim();
        if s.is_empty() || ["//", "/*", "*", "import ", "from "].iter().any(|p| s.starts_with(p)) {
            continue;
        }
        let head = || s.split('{').next().unwrap_or("").trim().to_string();
        if iface.is_match(s) || func.is_match(s) || class.is_match(s) || en.is_match(s) {
            out.push((i + 1, head()));
        } else if ty.is_match(s) {
            out.push((i + 1, s.trim_end_matches(';').trim().to_string()));
        } else if cst.is_match(s) {
            out.push((i + 1, s.split('=').next().unwrap_or("").trim().to_string()));
        }
    }
    out
}

fn rust_outline(lines: &[&str]) -> Vec<(usize, String)> {
    let (item, func, imp) =
        (rx(r"^(pub(\(.*\))?\s+)?(struct|enum|trait|type|union)\s+\w+"), rx(r"^(pub(\(.*\))?\s+)?(async\s+)?(unsafe\s+)?fn\s+\w+"), rx(r"^impl(\s+<.*>)?\s+.*"));
    let mut out = vec![];
    for (i, line) in lines.iter().enumerate() {
        let s = line.trim();
        if s.is_empty() || ["//", "/*", "*", "use "].iter().any(|p| s.starts_with(p)) {
            continue;
        }
        if item.is_match(s) || func.is_match(s) {
            out.push((i + 1, s.split('{').next().unwrap_or("").split(';').next().unwrap_or("").trim().to_string()));
        } else if imp.is_match(s) {
            out.push((i + 1, s.split('{').next().unwrap_or("").trim().to_string()));
        }
    }
    out
}

fn go_outline(lines: &[&str]) -> Vec<(usize, String)> {
    let (ty, func) = (rx(r"^type\s+\w+\s+(struct|interface)"), rx(r"^func\s+(\(.*\)\s+)?\w+"));
    let mut out = vec![];
    for (i, line) in lines.iter().enumerate() {
        let s = line.trim();
        if s.is_empty() || ["//", "/*", "*", "import ", "package "].iter().any(|p| s.starts_with(p)) {
            continue;
        }
        if ty.is_match(s) || func.is_match(s) {
            out.push((i + 1, s.split('{').next().unwrap_or("").trim().to_string()));
        }
    }
    out
}

pub fn generate_file_outline(resolved: &Path, rel: &str) -> std::io::Result<String> {
    let raw = std::fs::read(resolved)?;
    let content = crate::read::decode_text(&raw);
    if content.trim().is_empty() {
        return Ok(format!("[Outline of {rel} (empty file)]"));
    }
    let lines: Vec<&str> = content.lines().collect();
    let total = lines.len();
    let entries = match crate::read::ext_of(resolved).as_str() {
        ".py" => py_outline(&lines),
        ".ts" | ".tsx" | ".js" | ".jsx" | ".mjs" | ".cjs" => ts_outline(&lines),
        ".rs" => rust_outline(&lines),
        ".go" => go_outline(&lines),
        ".md" | ".markdown" => lines.iter().enumerate().filter(|(_, l)| l.trim().starts_with('#')).map(|(i, l)| (i + 1, l.trim().to_string())).collect(),
        _ => vec![],
    };
    if entries.is_empty() {
        return Ok(format!("[Outline of {rel} ({total} lines): no symbol declarations found]"));
    }
    let header = format!("[Outline of {rel} ({total} lines, {} symbols)]\n", entries.len());
    Ok(header + &entries.iter().map(|(n, t)| format!("Line {n}: {t}")).collect::<Vec<_>>().join("\n"))
}
