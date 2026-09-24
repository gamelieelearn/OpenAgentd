//! `grep` — port of `filesystem/grep.py` (+ `_ignore.py`).

use crate::args::Args;
use crate::denied::fnmatch_translate;
use crate::{Tool, ToolContext, ToolError, ToolOutput, ToolResult};
use async_trait::async_trait;
use ignore::gitignore::{Gitignore, GitignoreBuilder};
use serde_json::Value;
use std::io::{BufRead, Read};
use std::path::Path;

pub const NOISE_DIR_NAMES: &[&str] = &[
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".ruff_cache",
    ".pytest_cache",
    ".tox",
    ".nox",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".parcel-cache",
    ".gradle",
    ".terraform",
];
const MAX_PATTERN_LEN: usize = 500;
const SCAN_TIMEOUT_S: u64 = 10;
const BINARY_SNIFF_BYTES: usize = 4096;
const REGEX_META: &str = ".^$*+?{}[]()|\\";

/// Root `.gitignore` only (v2 limitation preserved).
pub fn load_gitignore(root: &Path) -> Gitignore {
    let mut b = GitignoreBuilder::new(root);
    let gi = root.join(".gitignore");
    if gi.is_file() {
        let _ = b.add(gi);
    }
    b.build().unwrap_or_else(|_| Gitignore::empty())
}

pub fn is_gitignored(gi: &Gitignore, rel: &str, is_dir: bool) -> bool {
    gi.matched_path_or_any_parents(rel, is_dir).is_ignore()
}

pub fn compile_pattern(pattern: &str) -> Result<fancy_regex::Regex, ToolError> {
    if pattern.chars().count() > MAX_PATTERN_LEN {
        return Err(ToolError::Execution(format!("Pattern too long ({} chars, max {MAX_PATTERN_LEN})", pattern.chars().count())));
    }
    fancy_regex::Regex::new(pattern).map_err(|e| ToolError::Execution(format!("Invalid regex: {e}")))
}

fn required_literals(pattern: &str) -> Vec<Vec<u8>> {
    let branches: Vec<&str> = pattern.split('|').collect();
    if branches.iter().all(|b| !b.is_empty() && !b.chars().any(|c| REGEX_META.contains(c))) {
        branches.iter().map(|b| b.as_bytes().to_vec()).collect()
    } else {
        vec![]
    }
}

struct Scanner<'a> {
    rx: &'a fancy_regex::Regex,
    literals: &'a [Vec<u8>],
    max: usize,
}

impl Scanner<'_> {
    /// Append matches; true once max reached.
    fn scan(&self, fpath: &Path, display: &str, hits: &mut Vec<String>) -> bool {
        let Ok(mut f) = std::fs::File::open(fpath) else {
            return false;
        };
        let mut sniff = vec![0u8; BINARY_SNIFF_BYTES];
        let n = f.read(&mut sniff).unwrap_or(0);
        if sniff[..n].contains(&0) {
            return false;
        }
        let Ok(data) = std::fs::read(fpath) else {
            return false;
        };
        if !self.literals.is_empty() && !self.literals.iter().any(|l| memchr::memmem::find(&data, l).is_some()) {
            return false;
        }
        let reader = std::io::BufReader::new(&data[..]);
        for (i, line) in reader.split(b'\n').enumerate() {
            let Ok(line) = line else { break };
            let text = String::from_utf8_lossy(&line);
            // v2 iterates lines *with* newline; `$` still matches before it.
            if self.rx.is_match(&text).unwrap_or(false) {
                let shown: String = text.trim_end().chars().take(200).collect();
                hits.push(format!("{display}:{}: {shown}", i + 1));
                if hits.len() >= self.max {
                    return true;
                }
            }
        }
        false
    }
}

pub struct GrepTool;

#[async_trait]
impl Tool for GrepTool {
    fn name(&self) -> &str {
        "grep"
    }
    async fn run(&self, ctx: &ToolContext, args: Value) -> ToolResult {
        let mut a = Args::new("grep", &args);
        let pattern = a.req_str(&["pattern", "query", "regex"]);
        let directory = a.str_or(&["directory", "dir", "path"], ".");
        let include = a.str_or(&["include", "glob", "file_pattern"], "*");
        let max_results = a.opt_int(&["max_results"], Some(1), None).unwrap_or(100) as usize;
        if let Err(ToolError::Execution(e)) = compile_pattern(&pattern) {
            a.err("pattern", &format!("Value error, {e}"));
        }
        a.finish()?;
        let denied = ctx.denied.clone();
        let resolved = denied.validate_path(&directory)?;
        if !resolved.exists() {
            return Err(ToolError::Execution(format!("File or directory not found: {}", denied.display_path(&resolved))));
        }
        let no_match = format!("No matches for pattern '{pattern}' in {} (include={include})", denied.display_path(&resolved));
        let task = tokio::task::spawn_blocking(move || -> Result<Vec<String>, ToolError> {
            let rx = compile_pattern(&pattern)?;
            let literals = required_literals(&pattern);
            let sc = Scanner { rx: &rx, literals: &literals, max: max_results };
            let mut hits = vec![];
            if resolved.is_file() {
                sc.scan(&resolved, &denied.display_path(&resolved), &mut hits);
                return Ok(hits);
            }
            let gi = load_gitignore(&resolved);
            let inc = regex::Regex::new(&fnmatch_translate(&include)).map_err(ToolError::exec)?;
            let mut stack = vec![resolved.clone()];
            while let Some(dir) = stack.pop() {
                let Ok(rd) = std::fs::read_dir(&dir) else {
                    continue;
                };
                let mut dirs = vec![];
                let mut files = vec![];
                for e in rd.flatten() {
                    let ft = match e.file_type() {
                        Ok(t) => t,
                        Err(_) => continue,
                    };
                    // os.walk follows neither dir symlinks; file symlinks count as files
                    let name = e.file_name().to_string_lossy().to_string();
                    if ft.is_dir() {
                        dirs.push(name);
                    } else if ft.is_file() || (ft.is_symlink() && e.path().is_file()) {
                        files.push(name);
                    }
                }
                let rel_dir = dir.strip_prefix(&resolved).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
                let join = |n: &str| {
                    if rel_dir.is_empty() {
                        n.to_string()
                    } else {
                        format!("{rel_dir}/{n}")
                    }
                };
                for f in files {
                    if !inc.is_match(&f) {
                        continue;
                    }
                    let rel = join(&f);
                    if is_gitignored(&gi, &rel, false) {
                        continue;
                    }
                    let fp = dir.join(&f);
                    if denied.is_denied_path(&fp) {
                        continue;
                    }
                    if sc.scan(&fp, &denied.display_path(&fp), &mut hits) {
                        return Ok(hits);
                    }
                }
                // os.walk is top-down in listing order; push reversed for DFS order
                let mut kept: Vec<String> = dirs.into_iter().filter(|d| !NOISE_DIR_NAMES.contains(&d.as_str()) && !is_gitignored(&gi, &join(d), true)).collect();
                kept.reverse();
                for d in kept {
                    stack.push(dir.join(d));
                }
            }
            Ok(hits)
        });
        let hits = match tokio::time::timeout(std::time::Duration::from_secs(SCAN_TIMEOUT_S), task).await {
            Ok(r) => r.map_err(ToolError::exec)??,
            Err(_) => return Err(ToolError::Execution(format!("grep_files scan timed out after {SCAN_TIMEOUT_S}s — pattern may be too complex or directory too large"))),
        };
        if hits.is_empty() {
            return Ok(ToolOutput::Text(no_match));
        }
        Ok(ToolOutput::Text(hits.join("\n")))
    }
}
