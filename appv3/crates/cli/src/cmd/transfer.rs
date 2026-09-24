//! `openagentd transfer migrate|export|import` — ports of
//! `app/cli/commands/{migrate,export,importcmd}.py`.

use crate::argparse::Ns;
use crate::cmd::server::{ns_bool, ns_str};
use crate::paths::{config_dir, home};
use crate::pystr::{strip, uncaught};
use crate::ui::{bold, cyan, dim, green, red, yellow};
use appv3_core::pyyaml::{safe_dump_py, safe_load_py, Py};
use std::path::{Component, Path, PathBuf};

const ARCHIVE_ROOT: &str = "openagentd-export";
const TREE_DIRS: &[&str] = &["agents", "skills", "commands", "plugins"];
const ROOT_FILES: &[&str] = &["mcp.json", "settings.yaml", "server.yaml", "multimodal.yaml", ".env"];

/// `Path(p).expanduser()`.
pub fn expanduser(p: &str) -> PathBuf {
    if p == "~" {
        return home();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        return home().join(rest);
    }
    PathBuf::from(p)
}

/// `Path.resolve()` (non-strict, absolute).
fn resolve(p: &Path) -> PathBuf {
    let abs = if p.is_absolute() { p.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(p) };
    appv3_tools::denied::resolve(&abs)
}

fn yaml_exc(e: &appv3_core::pyyaml::LoadError) -> ! {
    let module = match e.kind {
        "ReaderError" => "yaml.reader.",
        "ScannerError" => "yaml.scanner.",
        "ParserError" => "yaml.parser.",
        "ComposerError" => "yaml.composer.",
        "ConstructorError" => "yaml.constructor.",
        _ => "",
    };
    uncaught(&format!("{module}{}", e.kind), &e.message)
}

fn read_text(p: &Path) -> String {
    match std::fs::read(p) {
        Ok(b) => match String::from_utf8(b) {
            Ok(s) => s.replace("\r\n", "\n").replace('\r', "\n"),
            Err(_) => uncaught("UnicodeDecodeError", "'utf-8' codec can't decode bytes"),
        },
        Err(e) => crate::pystr::os_error(&e, Some(p)),
    }
}

// ── migrate ─────────────────────────────────────────────────────────────────

const OPENCLAW_PROMPT_FILES: &[&str] = &["AGENTS.md", "SOUL.md", "SOULS.md", "TOOLS.md"];
const HERMES_CONTEXT_FILES: &[&str] = &["SOUL.md", ".hermes.md", "HERMES.md", "AGENTS.md", "CLAUDE.md", ".cursorrules"];

fn read_markdown_body(path: &Path) -> String {
    let text = strip(&read_text(path)).to_string();
    let Some(rest) = text.strip_prefix("---\n") else { return text };
    match rest.split_once("\n---") {
        Some((_, body)) => strip(body.trim_start_matches(['\r', '\n'])).to_string(),
        None => text,
    }
}

pub fn cmd_migrate(ns: &Ns) {
    let cfg = ns_str(ns, "config_dir").filter(|s| !s.is_empty()).map(expanduser).unwrap_or_else(config_dir);
    let source = ns_str(ns, "source").unwrap_or("");
    let source_dir = match ns_str(ns, "from_dir").filter(|s| !s.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => PathBuf::from(if source == "hermes" { "~/.hermes" } else { "~/.openclaw/workspace" }),
    };
    let (files, label, missing, description) = if source == "openclaw" {
        (OPENCLAW_PROMPT_FILES, "OpenClaw workspace", "OpenClaw prompt files", "Migrated from OpenClaw/Hermes workspace prompt files.")
    } else {
        (HERMES_CONTEXT_FILES, "Hermes home or project directory", "Hermes context files", "Migrated from Hermes identity/context files.")
    };
    let model = ns_str(ns, "model").unwrap_or("");
    let source_dir = resolve(&expanduser(&source_dir.to_string_lossy()));
    if !source_dir.is_dir() {
        uncaught("ValueError", &format!("{label} does not exist: {}", source_dir.display()));
    }
    let mut sections = vec![];
    let mut imported = vec![];
    for f in files {
        let p = source_dir.join(f);
        if !p.is_file() {
            continue;
        }
        let body = read_markdown_body(&p);
        if body.is_empty() {
            continue;
        }
        sections.push(format!("# Imported from {f}\n\n{body}"));
        imported.push(*f);
    }
    if sections.is_empty() {
        uncaught("ValueError", &format!("No {missing} found in {}: {}", source_dir.display(), files.join(", ")));
    }
    let agents_dir = cfg.join("agents");
    let target = agents_dir.join("code.md");
    if target.exists() && !ns_bool(ns, "force") {
        uncaught("FileExistsError", &format!("Agent already exists: {}. Pass --force to replace it.", target.display()));
    }
    let s = |v: &str| Py::Str(v.into());
    let fm = Py::Dict(vec![(s("name"), s("code")), (s("role"), s("lead")), (s("description"), s(description)), (s("model"), s(model))]);
    let frontmatter = strip(&safe_dump_py(&fm)).to_string();
    let content = format!("---\n{frontmatter}\n---\n\n{}\n", sections.join("\n\n---\n\n"));
    if let Err(e) = std::fs::create_dir_all(&agents_dir) {
        crate::pystr::os_error(&e, Some(&agents_dir));
    }
    if let Err(e) = std::fs::write(&target, content) {
        crate::pystr::os_error(&e, Some(&target));
    }
    println!("Imported {} into {}", imported.join(", "), target.display());
}

// ── export ──────────────────────────────────────────────────────────────────

fn redact_env(content: &str) -> String {
    let re = regex::Regex::new(r"^([A-Z0-9_]*_API_KEY|[A-Z0-9_]*_SECRET(?:_KEY)?|[A-Z0-9_]*_TOKEN|[A-Z0-9_]*_PASSWORD|ACCESS_KEY|AWS_BEARER_TOKEN_BEDROCK)=(.+)$").unwrap();
    let mut out = String::new();
    for line in splitlines_keepends(content) {
        let stripped = line.trim_end_matches(['\r', '\n']);
        match re.captures(stripped) {
            Some(m) => {
                out.push_str(&m[1]);
                out.push('=');
                out.push_str(&line[stripped.len()..]);
            }
            None => out.push_str(line),
        }
    }
    out
}

/// `str.splitlines(keepends=True)`.
fn splitlines_keepends(s: &str) -> Vec<&str> {
    let mut out = vec![];
    let mut start = 0;
    let b: Vec<(usize, char)> = s.char_indices().collect();
    let mut k = 0;
    while k < b.len() {
        let (i, c) = b[k];
        if matches!(c, '\n' | '\r' | '\x0b' | '\x0c' | '\x1c' | '\x1d' | '\x1e' | '\u{85}' | '\u{2028}' | '\u{2029}') {
            let mut end = i + c.len_utf8();
            if c == '\r' && b.get(k + 1).is_some_and(|&(_, n)| n == '\n') {
                end += 1;
                k += 1;
            }
            out.push(&s[start..end]);
            start = end;
        }
        k += 1;
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

fn redact_server_settings(content: &str) -> String {
    let raw = match safe_load_py(content) {
        Ok(p) if !p.truthy() => Py::Dict(vec![]),
        Ok(p) => p,
        Err(e) if e.is_yaml_error() => yaml_exc(&e),
        Err(e) => uncaught(e.kind, &e.message),
    };
    let Py::Dict(mut items) = raw else { uncaught("ValueError", "server.yaml must contain a YAML mapping.") };
    items.retain(|(k, _)| !matches!(k, Py::Str(s) if s == "access_key"));
    safe_dump_py(&Py::Dict(items))
}

/// `Path.rglob("*")` (no symlinked-dir recursion), sorted like `sorted(paths)`.
fn rglob(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let is_real_dir = std::fs::symlink_metadata(&p).is_ok_and(|m| m.is_dir());
        out.push(p.clone());
        if is_real_dir {
            rglob(&p, out);
        }
    }
}

fn posix_rel(p: &Path, base: &Path) -> String {
    p.strip_prefix(base).unwrap_or(p).components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/")
}

fn export_config(cfg: &Path, output: &Path, include_secrets: bool) -> std::io::Result<Vec<String>> {
    let file = std::fs::File::create(output).map_err(|e| {
        let (ty, msg) = crate::pystr::os_error_text(&e, Some(output));
        std::io::Error::other(format!("{ty}\0{msg}"))
    })?;
    let gz = flate2::write::GzEncoder::new(file, flate2::Compression::new(9));
    let mut tar = tar::Builder::new(gz);
    tar.follow_symlinks(false);
    let mut packed = vec![];
    for d in TREE_DIRS {
        let src_dir = cfg.join(d);
        if !src_dir.is_dir() {
            continue;
        }
        let mut all = vec![];
        rglob(&src_dir, &mut all);
        all.sort();
        for src in all {
            if !src.is_file() || src.components().any(|c| c.as_os_str() == "__pycache__") || src.to_string_lossy().ends_with(".pyc") {
                continue;
            }
            let rel = posix_rel(&src, cfg);
            tar.append_path_with_name(&src, format!("{ARCHIVE_ROOT}/{rel}"))?;
            packed.push(rel);
        }
    }
    for f in ROOT_FILES {
        let src = cfg.join(f);
        if !src.is_file() {
            continue;
        }
        let arc = format!("{ARCHIVE_ROOT}/{f}");
        if (*f == ".env" || *f == "server.yaml") && !include_secrets {
            let raw = read_text(&src);
            let red = if *f == ".env" { redact_env(&raw) } else { redact_server_settings(&raw) };
            let mut h = tar::Header::new_gnu();
            h.set_size(red.len() as u64);
            h.set_mode(0o644);
            h.set_mtime(0);
            h.set_uid(0);
            h.set_gid(0);
            h.set_entry_type(tar::EntryType::Regular);
            tar.append_data(&mut h, &arc, red.as_bytes())?;
        } else {
            tar.append_path_with_name(&src, &arc)?;
        }
        packed.push(f.to_string());
    }
    tar.into_inner()?.finish()?;
    packed.sort();
    Ok(packed)
}

pub fn cmd_export(ns: &Ns) {
    let cfg = ns_str(ns, "config_dir").filter(|s| !s.is_empty()).map(expanduser).unwrap_or_else(config_dir);
    let output = match ns_str(ns, "output").filter(|s| !s.is_empty()) {
        Some(o) => resolve(&expanduser(o)),
        None => {
            let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
            std::env::current_dir().unwrap_or_default().join(format!("openagentd-export-{stamp}.tar.gz"))
        }
    };
    let include_secrets = ns_bool(ns, "include_secrets");
    if include_secrets {
        println!();
        println!("  {}  {} is set — API and server access keys will be stored in plaintext inside the archive.", yellow("⚠"), bold("--include-secrets"));
        println!("     {}", dim("Only use this over a trusted, encrypted channel (e.g. local disk → SCP → remote)."));
        println!();
    }
    println!("  {}  Exporting config from {}", dim("…"), cfg.display());
    let packed = match export_config(&cfg, &output, include_secrets) {
        Ok(p) => p,
        Err(e) => match e.to_string().split_once('\0') {
            Some((ty, msg)) => uncaught(ty, msg),
            None => crate::pystr::os_error(&e, None),
        },
    };
    println!("  {}  Archive: {}", green("✓"), bold(&output.display().to_string()));
    println!("  {} {} file(s):", dim("Packed"), packed.len());
    for f in &packed {
        let secret = f == ".env" || f == "server.yaml";
        let marker = if secret { yellow("  •") } else { cyan("  •") };
        let suffix = if secret && !include_secrets { dim("  (secrets redacted)") } else { String::new() };
        println!("    {marker} {f}{suffix}");
    }
    println!();
    println!("  {}", bold("To import on the target server:"));
    println!("    openagentd transfer import {}", output.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
    println!();
}

// ── import ──────────────────────────────────────────────────────────────────

struct Member {
    name: String,
    data: Vec<u8>,
}

/// `TarInfo.frombuf` validation of the first header block (only the first
/// member's errors surface as `ReadError` at `tarfile.open`).
fn first_header_check(raw: &[u8]) -> Result<(), String> {
    if raw.len() < 512 {
        return Err("truncated header".into());
    }
    let buf = &raw[..512];
    if buf.iter().all(|&b| b == 0) {
        return Ok(());
    }
    let field = &buf[148..156];
    let chksum: i64 = if field[0] == 0o200 || field[0] == 0o377 {
        let mut n: i64 = 0;
        for &b in &field[1..] {
            n = (n << 8) + b as i64;
        }
        if field[0] == 0o377 {
            n - (1i64 << 56)
        } else {
            n
        }
    } else {
        let end = field.iter().position(|&b| b == 0).unwrap_or(field.len());
        let text = String::from_utf8_lossy(&field[..end]).trim().to_string();
        let text = if text.is_empty() { "0".to_string() } else { text };
        i64::from_str_radix(text.trim_start_matches('+'), 8).map_err(|_| "invalid header".to_string())?
    };
    let unsigned: i64 = 256 + buf[..148].iter().chain(&buf[156..]).map(|&b| b as i64).sum::<i64>();
    let signed: i64 = 256 + buf[..148].iter().chain(&buf[156..]).map(|&b| b as i8 as i64).sum::<i64>();
    if chksum != unsigned && chksum != signed {
        return Err("bad checksum".into());
    }
    Ok(())
}

/// `tarfile.open(path, "r:gz")` + regular-file members (with contents).
fn read_archive(path: &Path) -> Result<Vec<Member>, String> {
    use std::io::Read;
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    if bytes.is_empty() {
        return Err("empty file".into());
    }
    if bytes.len() < 2 || bytes[0] != 0x1f || bytes[1] != 0x8b {
        return Err("not a gzip file".into());
    }
    let mut raw = vec![];
    if let Err(e) = flate2::read::MultiGzDecoder::new(&bytes[..]).read_to_end(&mut raw) {
        if e.kind() == std::io::ErrorKind::UnexpectedEof {
            uncaught("EOFError", "Compressed file ended before the end-of-stream marker was reached");
        }
        return Err("not a gzip file".into());
    }
    if raw.is_empty() {
        return Err("empty file".into());
    }
    first_header_check(&raw)?;
    let mut ar = tar::Archive::new(&raw[..]);
    let mut out = vec![];
    let entries = ar.entries().map_err(|_| "invalid header".to_string())?;
    for (i, e) in entries.enumerate() {
        let mut e = match e {
            Ok(e) => e,
            Err(_) if i == 0 => return Err("invalid header".into()),
            Err(_) => return Err("unexpected end of data".into()),
        };
        let et = e.header().entry_type();
        if !(et.is_file() || et == tar::EntryType::Continuous) {
            continue;
        }
        let name = String::from_utf8_lossy(&e.path_bytes()).trim_end_matches('/').to_string();
        let mut data = vec![];
        e.read_to_end(&mut data).map_err(|e| e.to_string())?;
        out.push(Member { name, data });
    }
    Ok(out)
}

fn import_config(archive: &Path, cfg: &Path, force: bool) -> Result<(Vec<String>, Vec<String>), String> {
    if !archive.is_file() {
        return Err(format!("not a valid archive — file not found: {}", archive.display()));
    }
    let members = read_archive(archive).map_err(|e| format!("not a valid tar.gz archive: {e}"))?;
    let cfg = resolve(cfg);
    if members.is_empty() {
        return Err("not a valid openagentd export — archive contains no files".into());
    }
    let prefix = format!("{ARCHIVE_ROOT}/");
    for m in &members {
        if !m.name.starts_with(&prefix) {
            return Err(format!(
                "not a valid openagentd export — unexpected archive root in entry: {}. Expected entries under '{ARCHIVE_ROOT}/'.",
                crate::argparse::py_repr(&m.name)
            ));
        }
    }
    for m in &members {
        let rel = &m.name[prefix.len()..];
        if Path::new(rel).components().any(|c| c == Component::ParentDir) {
            return Err(format!("path traversal detected in archive entry: {}", crate::argparse::py_repr(&m.name)));
        }
        if !resolve(&cfg.join(rel)).starts_with(&cfg) {
            return Err(format!("path traversal detected in archive entry: {}", crate::argparse::py_repr(&m.name)));
        }
    }
    let (mut written, mut skipped) = (vec![], vec![]);
    for m in members {
        let rel = m.name[prefix.len()..].to_string();
        let target = resolve(&cfg.join(&rel));
        if target.exists() && !force {
            skipped.push(rel);
            continue;
        }
        if let Some(p) = target.parent() {
            std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
        }
        std::fs::write(&target, &m.data).map_err(|e| e.to_string())?;
        written.push(rel);
    }
    Ok((written, skipped))
}

pub fn cmd_import(ns: &Ns) {
    let cfg = ns_str(ns, "config_dir").filter(|s| !s.is_empty()).map(expanduser).unwrap_or_else(config_dir);
    let archive = resolve(&expanduser(ns_str(ns, "archive").unwrap_or("")));
    let force = ns_bool(ns, "force");
    println!();
    println!("  {}  Importing from {}", dim("…"), archive.display());
    println!("  {}  Config dir: {}", dim("→"), cfg.display());
    println!();
    let (mut written, mut skipped) = match import_config(&archive, &cfg, force) {
        Ok(r) => r,
        Err(e) => {
            println!("  {}  {e}", red("✗"));
            crate::cmd::server::system_exit_code(1);
        }
    };
    if !written.is_empty() {
        println!("  {}  Wrote {} file(s):", green("✓"), written.len());
        written.sort();
        for f in &written {
            println!("    {} {f}", green("  +"));
        }
    }
    if !skipped.is_empty() {
        println!("  {}  Skipped {} existing file(s):", yellow("ℹ"), skipped.len());
        skipped.sort();
        for f in &skipped {
            println!("    {} {f}", dim("  ·"));
        }
        println!("\n  {} {} {}", dim("Tip: pass"), bold("--force"), dim("to overwrite existing files."));
    }
    if written.is_empty() && skipped.is_empty() {
        println!("  {}  Nothing to import — archive appears empty.", yellow("ℹ"));
    }
    println!();
    println!("  {} start the server:", bold("Next:"));
    println!("    openagentd");
    println!();
}
