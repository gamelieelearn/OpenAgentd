//! `slugify` from `app/scheduler/utils.py` (byte-for-byte with the frontend).

/// `slugify`.
pub fn slugify(text: &str) -> String {
    use unicode_normalization::UnicodeNormalization;
    let stripped: String = text.nfd().filter(|c| !unicode_normalization::char::is_combining_mark(*c)).collect();
    let lower = stripped.to_lowercase();
    let re1 = regex::Regex::new(r"[^a-z0-9._-]").unwrap();
    let s = re1.replace_all(&lower, "-");
    let re2 = regex::Regex::new(r"-+").unwrap();
    let s = re2.replace_all(&s, "-");
    let re3 = regex::Regex::new(r"^[._-]+|[._-]+$").unwrap();
    let mut s = re3.replace_all(&s, "").to_string();
    if !s.is_empty() && !s.chars().next().map(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).unwrap_or(false) {
        s = s.trim_start_matches(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit())).to_string();
    }
    s.chars().take(64).collect()
}
