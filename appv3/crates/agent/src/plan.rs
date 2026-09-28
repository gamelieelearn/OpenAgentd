//! The session plan: the latest Plan-mode `<proposed_plan>`, saved as
//! `plan.md` in the session's artifacts directory.
//!
//! A plan otherwise lives only in an assistant message, and compaction folds
//! that message into the summary (coding workspaces keep no assistant
//! messages verbatim), so the agent lost the plan it was following. The
//! file is the source of truth: [`PlanCaptureHook`] writes it when a
//! Plan-mode turn ends, and compaction restates it through [`carry_note`].

use crate::hooks::{AgentState, Hook, RunContext};
use appv3_providers::AssistantMessage;
use appv3_tools::todo;
use async_trait::async_trait;
use chrono::{DateTime, SecondsFormat, Utc};
use regex::Regex;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const PLAN_FILENAME: &str = "plan.md";

/// `extra` key marking the compaction note that restates the plan.
pub const SESSION_PLAN_KEY: &str = "session_plan";

/// Appended to the summariser's request while a plan file exists, so the
/// summary records progress against the plan instead of a second, lossy copy.
pub const PLAN_SUMMARY_RULE: &str = "A `<session_plan>` note keeps this session's latest `<proposed_plan>` verbatim next to this summary. Do not restate its steps: refer to them by number or title when recording progress, and record any user-requested changes to the plan.";

const CARRY_GUIDANCE: &str = "This is the session's latest plan, restated verbatim after context compaction; the summary records progress. The plan outranks the summary on scope and step order, and the task board records step status. In Code mode, continue from the first unfinished step; in Plan mode, keep revising it with the user. If the user has since redirected the work, follow the user. Edit the file at `path` only when the user changes the plan's scope; track progress with `todo_manage`.";

pub fn plan_path(dir: &Path) -> PathBuf {
    dir.join(PLAN_FILENAME)
}

fn tag_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?i)<proposed_plan\b[^>]*>|</proposed_plan>").unwrap())
}

/// Byte ranges of inline code spans on one line. An unclosed backtick run
/// runs to the end of the line.
fn inline_code_ranges(line: &str) -> Vec<(usize, usize)> {
    let bytes = line.as_bytes();
    let run_at = |i: usize| bytes[i..].iter().take_while(|&&b| b == b'`').count();
    let mut ranges = vec![];
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'`' {
            i += 1;
            continue;
        }
        let open = run_at(i);
        let mut j = i + open;
        let mut end = None;
        while j < bytes.len() {
            if bytes[j] == b'`' {
                let close = run_at(j);
                if close == open {
                    end = Some(j + close);
                    break;
                }
                j += close;
            } else {
                j += 1;
            }
        }
        let stop = end.unwrap_or(bytes.len());
        ranges.push((i, stop));
        i = stop;
    }
    ranges
}

/// The opening fence of a Markdown code block: `(char, run length, rest)`.
fn fence_marker(line: &str) -> Option<(u8, usize, &str)> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let c = *rest.as_bytes().first()?;
    if c != b'`' && c != b'~' {
        return None;
    }
    let run = rest.bytes().take_while(|&b| b == c).count();
    (run >= 3).then(|| (c, run, &rest[run..]))
}

/// The body of the last complete `<proposed_plan>` block in `text`.
///
/// Tags inside fenced code or inline code are ignored, matching the web
/// renderer (`web/src/utils/markdown-plan.tsx`). A block without its
/// closing tag (an interrupted stream) never counts.
pub fn extract_proposed_plan(text: &str) -> Option<String> {
    let mut fence: Option<(u8, usize)> = None;
    let mut open_end: Option<usize> = None;
    let mut last: Option<(usize, usize)> = None;
    let mut offset = 0;
    for raw in text.split_inclusive('\n') {
        let start = offset;
        offset += raw.len();
        let line = raw.trim_end_matches(['\n', '\r']);
        if let Some((c, run, rest)) = fence_marker(line) {
            match fence {
                None => {
                    fence = Some((c, run));
                    continue;
                }
                Some((fc, flen)) if fc == c && run >= flen && rest.trim().is_empty() => {
                    fence = None;
                    continue;
                }
                _ => {}
            }
        }
        if fence.is_some() {
            continue;
        }
        let code = inline_code_ranges(line);
        for m in tag_re().find_iter(line) {
            if code.iter().any(|&(s, e)| s <= m.start() && m.end() <= e) {
                continue;
            }
            let closing = m.as_str().starts_with("</");
            match (closing, open_end) {
                (false, None) => open_end = Some(start + m.end()),
                (true, Some(body_start)) => {
                    last = Some((body_start, start + m.start()));
                    open_end = None;
                }
                _ => {}
            }
        }
    }
    let (s, e) = last?;
    let body = text[s..e].trim();
    (!body.is_empty()).then(|| body.to_string())
}

/// Write `body` as the plan. Returns `false` when the file already holds it.
pub fn save(dir: &Path, body: &str) -> std::io::Result<bool> {
    let path = plan_path(dir);
    let body = body.trim();
    if std::fs::read_to_string(&path).map(|t| t.trim() == body).unwrap_or(false) {
        return Ok(false);
    }
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension("md.tmp");
    std::fs::write(&tmp, format!("{body}\n"))?;
    std::fs::rename(tmp, path)?;
    Ok(true)
}

/// The saved plan and when it last changed.
pub fn load(dir: &Path) -> Option<(String, DateTime<Utc>)> {
    let path = plan_path(dir);
    let text = std::fs::read_to_string(&path).ok()?;
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    let modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok()?;
    Some((text.to_string(), DateTime::<Utc>::from(modified)))
}

/// Delete the plan. Returns whether there was one.
pub fn clear(dir: &Path) -> std::io::Result<bool> {
    match std::fs::remove_file(plan_path(dir)) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// The note compaction places before the summary, or `None` with no plan.
///
/// Once every tracked task is finished the plan is only pointed at, so a
/// completed plan does not cost its full size at every later compaction.
pub fn carry_note(dir: &Path) -> Option<String> {
    let (plan, updated) = load(dir)?;
    let path = plan_path(dir);
    let stamp = updated.to_rfc3339_opts(SecondsFormat::Secs, true);
    let store = todo::load_store(&todo::todos_path(dir));
    let items = store["items"].as_array().cloned().unwrap_or_default();
    let finished = !items.is_empty() && items.iter().all(|i| matches!(i["status"].as_str(), Some("completed" | "cancelled")));
    if finished {
        return Some(format!(
            "<session_plan path=\"{}\" updated_at=\"{stamp}\" status=\"tasks_finished\">\nAll tracked tasks for this session's plan are finished, so the plan is not restated. Read the file at `path` if you need it again.\n</session_plan>",
            path.display()
        ));
    }
    let mut note = format!("<session_plan path=\"{}\" updated_at=\"{stamp}\">\n{plan}\n</session_plan>", path.display());
    if !items.is_empty() {
        note.push_str(&format!("\n<task_board>\n{}\n</task_board>", todo::format_items(&items)));
    }
    note.push_str("\n\n");
    note.push_str(CARRY_GUIDANCE);
    Some(note)
}

/// Saves the plan when a lead Plan-mode turn ends with a `<proposed_plan>`.
/// `after_agent` sees only this run's last assistant message, so an older
/// plan in history is never written back.
pub struct PlanCaptureHook {
    pub dir: PathBuf,
}

#[async_trait]
impl Hook for PlanCaptureHook {
    async fn after_agent(&self, ctx: &RunContext, _state: &mut AgentState, resp: &AssistantMessage) {
        let Some(body) = resp.content.as_deref().and_then(extract_proposed_plan) else {
            return;
        };
        match save(&self.dir, &body) {
            Ok(true) => tracing::info!("plan_saved session_id={:?} bytes={}", ctx.session_id, body.len()),
            Ok(false) => {}
            Err(e) => tracing::warn!("plan_save_failed session_id={:?} error={}", ctx.session_id, e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_the_plan_body() {
        let text = "Findings first.\n\n<proposed_plan>\n## Summary\nFix it.\n</proposed_plan>\n";
        assert_eq!(extract_proposed_plan(text).as_deref(), Some("## Summary\nFix it."));
    }

    #[test]
    fn takes_the_last_complete_block() {
        let text = "<proposed_plan>\nold\n</proposed_plan>\nRevised:\n<proposed_plan>\nnew\n</proposed_plan>\n<proposed_plan>\ncut off";
        assert_eq!(extract_proposed_plan(text).as_deref(), Some("new"));
    }

    #[test]
    fn ignores_tags_in_code() {
        let fenced = "```xml\n<proposed_plan>\nexample\n</proposed_plan>\n```\n";
        assert_eq!(extract_proposed_plan(fenced), None);
        let inline = "Wrap it in `<proposed_plan>` and `</proposed_plan>`.";
        assert_eq!(extract_proposed_plan(inline), None);
        let body_with_code = "<proposed_plan>\n## Steps\n```\n</proposed_plan>\n```\nRun `</proposed_plan>` check.\n</proposed_plan>";
        assert_eq!(extract_proposed_plan(body_with_code).as_deref(), Some("## Steps\n```\n</proposed_plan>\n```\nRun `</proposed_plan>` check."));
    }

    #[test]
    fn unclosed_or_empty_blocks_are_not_plans() {
        assert_eq!(extract_proposed_plan("<proposed_plan>\n## Summary\nhalf a pl"), None);
        assert_eq!(extract_proposed_plan("<proposed_plan>\n  \n</proposed_plan>"), None);
        assert_eq!(extract_proposed_plan("no plan here"), None);
    }

    #[test]
    fn finds_inline_tags_after_prose() {
        let text = "Here is the plan: <proposed_plan>## Step 1</proposed_plan> that is all.";
        assert_eq!(extract_proposed_plan(text).as_deref(), Some("## Step 1"));
    }

    #[test]
    fn save_load_and_clear() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("sid");
        assert!(load(&dir).is_none());
        assert!(save(&dir, "  ## Plan\n1. a\n").unwrap());
        assert!(!save(&dir, "## Plan\n1. a").unwrap(), "identical content is not rewritten");
        assert_eq!(std::fs::read_to_string(plan_path(&dir)).unwrap(), "## Plan\n1. a\n");
        assert_eq!(load(&dir).unwrap().0, "## Plan\n1. a");
        assert!(save(&dir, "## Plan\n1. b").unwrap());
        assert!(clear(&dir).unwrap());
        assert!(!clear(&dir).unwrap());
        assert!(load(&dir).is_none());
    }

    #[test]
    fn carry_note_restates_plan_and_board() {
        let d = tempfile::tempdir().unwrap();
        assert!(carry_note(d.path()).is_none());
        save(d.path(), "## Steps\n1. Build\n2. Test").unwrap();
        let note = carry_note(d.path()).unwrap();
        assert!(note.starts_with(&format!("<session_plan path=\"{}\"", plan_path(d.path()).display())));
        assert!(note.contains("\n## Steps\n1. Build\n2. Test\n</session_plan>"));
        assert!(!note.contains("<task_board>"));
        assert!(note.ends_with(CARRY_GUIDANCE));

        let todos = todo::todos_path(d.path());
        todo::apply(&todos, &[json!({"action": "create", "content": "Build", "status": "completed"}), json!({"action": "create", "content": "Test"})]).unwrap();
        let note = carry_note(d.path()).unwrap();
        assert!(note.contains("<task_board>\n[task_1] [completed] Build\n[task_2] [pending] Test\n</task_board>"));
    }

    #[test]
    fn carry_note_only_points_at_a_finished_plan() {
        let d = tempfile::tempdir().unwrap();
        save(d.path(), "## Steps\n1. Build").unwrap();
        todo::apply(&todo::todos_path(d.path()), &[json!({"action": "create", "content": "Build", "status": "completed"})]).unwrap();
        let note = carry_note(d.path()).unwrap();
        assert!(note.contains("status=\"tasks_finished\""));
        assert!(!note.contains("1. Build"));
    }

    #[tokio::test]
    async fn capture_hook_saves_the_final_plan() {
        let d = tempfile::tempdir().unwrap();
        let hook = PlanCaptureHook { dir: d.path().to_path_buf() };
        let ctx = RunContext { session_id: None, run_id: "run".into(), agent_name: "lead".into(), workspace: None };
        let mut state = AgentState::new(vec![], String::new());
        let reply = AssistantMessage { content: Some("Done exploring.\n<proposed_plan>\n## Summary\nShip it.\n</proposed_plan>".into()), ..Default::default() };
        hook.after_agent(&ctx, &mut state, &reply).await;
        assert_eq!(load(d.path()).unwrap().0, "## Summary\nShip it.");

        let chat = AssistantMessage { content: Some("No plan this time.".into()), ..Default::default() };
        hook.after_agent(&ctx, &mut state, &chat).await;
        assert_eq!(load(d.path()).unwrap().0, "## Summary\nShip it.", "a reply without a plan leaves the file alone");
    }
}
