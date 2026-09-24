//! `glob` — port of `filesystem/glob.py`.

use crate::args::Args;
use crate::grep::{is_gitignored, load_gitignore, NOISE_DIR_NAMES};
use crate::{Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use globset::{GlobBuilder, GlobMatcher};
use serde_json::Value;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const MAX_BRACE_VARIANTS: usize = 64;

pub fn expand_braces(pattern: &str) -> Vec<String> {
    let Some(start) = pattern.find('{') else {
        return vec![pattern.to_string()];
    };
    let bytes: Vec<char> = pattern.chars().collect();
    let cstart = pattern[..start].chars().count();
    let mut depth = 0;
    let mut end = None;
    for (i, c) in bytes.iter().enumerate().skip(cstart) {
        if *c == '{' {
            depth += 1;
        } else if *c == '}' {
            depth -= 1;
            if depth == 0 {
                end = Some(i);
                break;
            }
        }
    }
    let Some(end) = end else {
        return vec![pattern.to_string()];
    };
    let prefix: String = bytes[..cstart].iter().collect();
    let body: Vec<char> = bytes[cstart + 1..end].to_vec();
    let suffix: String = bytes[end + 1..].iter().collect();
    let mut options = vec![];
    let mut cur = String::new();
    let mut d = 0;
    for c in body {
        if c == '{' {
            d += 1;
        } else if c == '}' {
            d -= 1;
        }
        if c == ',' && d == 0 {
            options.push(std::mem::take(&mut cur));
            continue;
        }
        cur.push(c);
    }
    options.push(cur);
    if options.len() == 1 {
        return vec![pattern.to_string()];
    }
    let mut out: Vec<String> = vec![];
    for o in options {
        for e in expand_braces(&format!("{prefix}{o}{suffix}")) {
            if !out.contains(&e) {
                out.push(e);
            }
            if out.len() >= MAX_BRACE_VARIANTS {
                return out;
            }
        }
    }
    out
}

fn matcher(p: &str) -> Option<GlobMatcher> {
    GlobBuilder::new(p).literal_separator(true).backslash_escape(true).build().ok().map(|g| g.compile_matcher())
}

fn rank(rel: &str) -> (u8, String) {
    (if rel.split('/').any(|p| p.starts_with('.')) { 1 } else { 0 }, rel.to_string())
}

fn has_wildcard(s: &str) -> bool {
    s.contains(['*', '?', '[', ']'])
}

fn literal_prefix(p: &str) -> Vec<String> {
    let parts: Vec<&str> = p.split('/').filter(|s| !s.is_empty() && *s != ".").collect();
    let mut out = vec![];
    for (i, part) in parts.iter().enumerate() {
        if i == parts.len() - 1 || has_wildcard(part) {
            break;
        }
        out.push(part.to_string());
    }
    out
}

fn shared_prefix(prefixes: &[Vec<String>]) -> Vec<String> {
    let Some(first) = prefixes.first() else {
        return vec![];
    };
    let mut out = vec![];
    for (i, seg) in first.iter().enumerate() {
        if prefixes.iter().all(|p| p.get(i) == Some(seg)) {
            out.push(seg.clone());
        } else {
            break;
        }
    }
    out
}

fn visible_files(root: &Path, base: &Path, gi: &ignore::gitignore::Gitignore, allowed_noise: &BTreeSet<String>) -> Vec<(String, PathBuf)> {
    let mut found = vec![];
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
        let rel_dir = dir.strip_prefix(base).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
        let join = |n: &str| {
            if rel_dir.is_empty() {
                n.to_string()
            } else {
                format!("{rel_dir}/{n}")
            }
        };
        let mut dirs = vec![];
        let mut files = vec![];
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            match e.file_type() {
                Ok(t) if t.is_dir() => dirs.push(name),
                Ok(_) => files.push(name),
                Err(_) => {}
            }
        }
        files.sort();
        for f in files {
            let rel = join(&f);
            if is_gitignored(gi, &rel, false) {
                continue;
            }
            found.push((rel, dir.join(&f)));
        }
        let mut kept: Vec<String> =
            dirs.into_iter().filter(|d| (!NOISE_DIR_NAMES.contains(&d.as_str()) || allowed_noise.contains(d)) && !is_gitignored(gi, &join(d), true)).collect();
        kept.sort_by(|a, b| (a.starts_with('.'), a).cmp(&(b.starts_with('.'), b)));
        kept.reverse();
        for d in kept {
            stack.push(dir.join(d));
        }
    }
    found
}

pub struct GlobTool;

#[async_trait]
impl Tool for GlobTool {
    fn name(&self) -> &str {
        "glob"
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let mut a = Args::new("glob", &args);
        let pattern = a.req_str(&["pattern", "glob"]);
        let directory = a.str_or(&["directory", "dir", "path"], ".");
        let mode = a.literal(&["match"], &["path", "name"], "path");
        let max_results = a.opt_int(&["max_results"], Some(1), None).unwrap_or(200) as usize;
        a.finish()?;
        let denied = ctx.denied.clone();
        let resolved = denied.validate_path(&directory)?;
        if !resolved.is_dir() {
            return Err(ToolError::Execution(format!("Not a directory: {}", denied.display_path(&resolved))));
        }
        if mode == "path" {
            if Path::new(&pattern).is_absolute() || pattern.starts_with('/') {
                return Err(ToolError::Execution(format!("Pattern must be relative to the search directory: {}", crate::py_repr_str(&pattern))));
            }
            if pattern.split('/').any(|p| p == "..") {
                return Err(ToolError::Execution(format!(
                    "'..' is not allowed in a pattern: {} — pass the 'directory' argument to search somewhere else.",
                    crate::py_repr_str(&pattern)
                )));
            }
        }
        let pat = pattern.clone();
        let (hits, dir_hints) = tokio::task::spawn_blocking(move || {
            let gi = load_gitignore(&resolved);
            let variants = expand_braces(&pat);
            let allowed_noise: BTreeSet<String> =
                variants.iter().flat_map(|v| v.split('/').map(String::from).collect::<Vec<_>>()).filter(|s| NOISE_DIR_NAMES.contains(&s.as_str()) && s != ".git").collect();
            let prefix = if mode == "path" { shared_prefix(&variants.iter().map(|v| literal_prefix(v)).collect::<Vec<_>>()) } else { vec![] };
            let walk_root = prefix.iter().fold(resolved.clone(), |p, s| p.join(s));
            if !prefix.is_empty() {
                let mut rel = String::new();
                for seg in &prefix {
                    rel = if rel.is_empty() { seg.clone() } else { format!("{rel}/{seg}") };
                    if (NOISE_DIR_NAMES.contains(&seg.as_str()) && !allowed_noise.contains(seg)) || is_gitignored(&gi, &rel, true) {
                        return (vec![], vec![]);
                    }
                }
            }
            if !walk_root.is_dir() {
                return (vec![], vec![]);
            }
            let cands = visible_files(&walk_root, &resolved, &gi, &allowed_noise);
            let select = |pats: &[String]| -> Vec<(String, PathBuf)> {
                let mut hit: Vec<(String, PathBuf)> = if mode == "name" {
                    let rxs: Vec<regex::Regex> = pats.iter().filter_map(|p| regex::Regex::new(&crate::denied::fnmatch_translate(p)).ok()).collect();
                    cands.iter().filter(|(_, p)| rxs.iter().any(|r| r.is_match(&p.file_name().unwrap_or_default().to_string_lossy()))).cloned().collect()
                } else if pats.iter().any(|p| p.ends_with('/')) {
                    vec![]
                } else {
                    let ms: Vec<GlobMatcher> = pats.iter().filter_map(|p| matcher(p)).collect();
                    cands.iter().filter(|(r, _)| ms.iter().any(|m| m.is_match(r))).cloned().collect()
                };
                hit.sort_by_key(|(r, _)| rank(r));
                hit
            };
            let mut matched = select(&variants);
            if matched.is_empty() {
                let widened: Vec<String> = variants.iter().filter(|p| !p.contains('/') && !p.starts_with("**")).map(|p| format!("**/{p}")).collect();
                if !widened.is_empty() {
                    matched = select(&widened);
                }
            }
            let mut hits = vec![];
            for (_, p) in matched {
                if !p.is_file() || denied.is_denied_path(&p) {
                    continue;
                }
                hits.push(denied.display_path(&p));
                if hits.len() >= max_results {
                    break;
                }
            }
            if !hits.is_empty() || mode == "name" {
                return (hits, vec![]);
            }
            let mut dirs: BTreeSet<String> = BTreeSet::new();
            for (rel, _) in &cands {
                let parts: Vec<&str> = rel.split('/').collect();
                for i in 1..parts.len() {
                    dirs.insert(parts[..i].join("/"));
                }
            }
            let ms: Vec<GlobMatcher> = variants.iter().filter_map(|p| matcher(p)).collect();
            (hits, dirs.into_iter().filter(|d| ms.iter().any(|m| m.is_match(d))).collect())
        })
        .await
        .map_err(ToolError::exec)?;
        if hits.is_empty() {
            let miss = format!("No files matching '{pattern}' in {}", ctx.denied.display_path(&ctx.denied.validate_path(&directory)?));
            if !dir_hints.is_empty() {
                let named = dir_hints.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
                return Ok(ToolOutput::Text(format!("{miss}; it matches directories ({named}) — use '{}/**' to list files inside", dir_hints[0])));
            }
            return Ok(ToolOutput::Text(miss));
        }
        Ok(ToolOutput::Text(hits.join("\n")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn braces_expand() {
        assert_eq!(expand_braces("src/**/*.{ts,tsx}"), vec!["src/**/*.ts", "src/**/*.tsx"]);
        assert_eq!(expand_braces("b{.py,}"), vec!["b.py", "b"]);
        assert_eq!(expand_braces("x{"), vec!["x{"]);
    }

    #[test]
    fn globs_like_pathlib() {
        let m = matcher("**/*.py").unwrap();
        assert!(m.is_match("a.py"));
        assert!(m.is_match("a/b/c.py"));
        let m = matcher("src/*.py").unwrap();
        assert!(!m.is_match("src/a/b.py"));
    }
}
