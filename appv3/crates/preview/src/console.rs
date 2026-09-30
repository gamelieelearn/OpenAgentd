//! Console entries reported by the in-page inspector.
//!
//! The buffer is bounded twice: by entry count and by the length of each
//! message, so a page that logs in a loop cannot grow the backend.

use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

pub const MAX_ENTRIES: usize = 500;
pub const MAX_MESSAGE_CHARS: usize = 2000;
/// Largest accepted `POST /__openagentd/console` body.
pub const MAX_BATCH_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ConsoleEntry {
    /// `error`, `warn`, `info`, `log`, or `debug`.
    pub level: String,
    pub message: String,
    /// Page path (with query) the entry came from.
    #[serde(default)]
    pub url: String,
    /// Milliseconds since the Unix epoch, as reported by the page.
    #[serde(default)]
    pub ts: f64,
}

#[derive(Default, Debug)]
pub struct ConsoleBuffer {
    entries: VecDeque<ConsoleEntry>,
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

fn normalize_level(level: &str) -> &'static str {
    match level {
        "error" => "error",
        "warn" | "warning" => "warn",
        "info" => "info",
        "debug" => "debug",
        _ => "log",
    }
}

impl ConsoleBuffer {
    pub fn push(&mut self, entry: ConsoleEntry) {
        let entry =
            ConsoleEntry { level: normalize_level(&entry.level).to_string(), message: truncate(&entry.message, MAX_MESSAGE_CHARS), url: truncate(&entry.url, 500), ts: entry.ts };
        if self.entries.len() >= MAX_ENTRIES {
            self.entries.pop_front();
        }
        self.entries.push_back(entry);
    }

    /// Oldest first.
    pub fn entries(&self) -> Vec<ConsoleEntry> {
        self.entries.iter().cloned().collect()
    }

    pub fn error_count(&self) -> usize {
        self.entries.iter().filter(|e| e.level == "error").count()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
    }
}

/// Parse a batch posted by the inspector: `{"entries": [...]}`.
pub fn parse_batch(body: &[u8]) -> Result<Vec<ConsoleEntry>, String> {
    if body.len() > MAX_BATCH_BYTES {
        return Err("Console batch too large.".into());
    }
    #[derive(Deserialize)]
    struct Batch {
        entries: Vec<ConsoleEntry>,
    }
    let batch: Batch = serde_json::from_slice(body).map_err(|e| format!("Invalid console batch: {e}"))?;
    Ok(batch.entries.into_iter().take(MAX_ENTRIES).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(level: &str, message: &str) -> ConsoleEntry {
        ConsoleEntry { level: level.into(), message: message.into(), url: "/".into(), ts: 0.0 }
    }

    #[test]
    fn keeps_the_newest_entries() {
        let mut b = ConsoleBuffer::default();
        for i in 0..(MAX_ENTRIES + 10) {
            b.push(entry("log", &i.to_string()));
        }
        let all = b.entries();
        assert_eq!(all.len(), MAX_ENTRIES);
        assert_eq!(all[0].message, "10");
    }

    #[test]
    fn truncates_messages_and_normalizes_levels() {
        let mut b = ConsoleBuffer::default();
        b.push(entry("warning", &"x".repeat(MAX_MESSAGE_CHARS + 50)));
        b.push(entry("weird", "a"));
        b.push(entry("error", "boom"));
        let all = b.entries();
        assert_eq!(all[0].level, "warn");
        assert_eq!(all[0].message.chars().count(), MAX_MESSAGE_CHARS + 1);
        assert_eq!(all[1].level, "log");
        assert_eq!(b.error_count(), 1);
    }

    #[test]
    fn rejects_oversized_or_malformed_batches() {
        assert!(parse_batch(&vec![b' '; MAX_BATCH_BYTES + 1]).is_err());
        assert!(parse_batch(b"not json").is_err());
        let ok = parse_batch(br#"{"entries":[{"level":"error","message":"x"}]}"#).unwrap();
        assert_eq!(ok.len(), 1);
        assert_eq!(ok[0].url, "");
    }
}
