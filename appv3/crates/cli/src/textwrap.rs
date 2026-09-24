//! Port of CPython 3.14 `textwrap.TextWrapper` with default options
//! (`break_long_words`, `break_on_hyphens`, `drop_whitespace`, no
//! `max_lines`) — the subset argparse's `HelpFormatter` uses.

const WS: [char; 6] = ['\t', '\n', '\x0b', '\x0c', '\r', ' '];

fn is_ws(c: char) -> bool {
    WS.contains(&c)
}

/// Python `\w` (str pattern, Unicode).
fn is_w(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

fn is_digit(c: char) -> bool {
    c.is_ascii_digit() || (!c.is_ascii() && c.is_numeric())
}

/// `letter = [^\d\W]`.
fn is_letter(c: char) -> bool {
    is_w(c) && !is_digit(c)
}

/// `word_punct = [\w!"'&.,?]`.
fn is_wp(c: char) -> bool {
    is_w(c) || matches!(c, '!' | '"' | '\'' | '&' | '.' | ',' | '?')
}

/// Emulates `TextWrapper.wordsep_re.split(text)` (empty chunks dropped).
pub fn split_chunks(text: &str) -> Vec<String> {
    let c: Vec<char> = text.chars().collect();
    let n = c.len();
    let at = |i: isize| -> Option<char> { (i >= 0 && (i as usize) < n).then(|| c[i as usize]) };
    // `(?=-{2,}\w)` at position q.
    let emdash_ahead = |q: usize| -> Option<usize> {
        let mut h = 0;
        while q + h < n && c[q + h] == '-' {
            h += 1;
        }
        (h >= 2 && at((q + h) as isize).is_some_and(is_w)).then_some(h)
    };
    let mut out = vec![];
    let mut i = 0;
    while i < n {
        if is_ws(c[i]) {
            let mut j = i;
            while j < n && is_ws(c[j]) {
                j += 1;
            }
            out.push(c[i..j].iter().collect());
            i = j;
            continue;
        }
        // em-dash between words: (?<=wp) -{2,} (?=\w)
        if i > 0 && is_wp(c[i - 1]) && c[i] == '-' {
            if let Some(h) = emdash_ahead(i) {
                out.push(c[i..i + h].iter().collect());
                i += h;
                continue;
            }
        }
        // word, possibly hyphenated: nws+? (?: hyphen | end | em-dash)
        let mut len = 1;
        let end = loop {
            let q = i + len;
            let qi = q as isize;
            // hyphenated word
            if at(qi) == Some('-') {
                let lb2 = at(qi - 2).is_some_and(is_letter) && at(qi - 1).is_some_and(is_letter);
                let lb4 = at(qi - 3).is_some_and(is_letter) && at(qi - 2) == Some('-') && at(qi - 1).is_some_and(is_letter);
                let la = at(qi + 1).is_some_and(is_letter)
                    && (at(qi + 2).is_some_and(is_letter) || (at(qi + 2) == Some('-') && at(qi + 3).is_some_and(is_letter)));
                if (lb2 || lb4) && la {
                    break q + 1;
                }
            }
            // end of word
            if q >= n || is_ws(c[q]) {
                break q;
            }
            // em-dash
            if is_wp(c[q - 1]) && emdash_ahead(q).is_some() {
                break q;
            }
            len += 1;
        };
        out.push(c[i..end].iter().collect());
        i = end;
    }
    out
}

/// `str.isspace()` per char (so `chunk.strip() == ''`).
fn py_isspace(c: char) -> bool {
    c.is_whitespace() || ('\x1c'..='\x1f').contains(&c)
}

fn clen(s: &str) -> usize {
    s.chars().count()
}

fn munge(text: &str) -> String {
    // expand_tabs(8) then replace_whitespace.
    let mut out = String::new();
    let mut col = 0;
    for ch in text.chars() {
        match ch {
            '\t' => {
                let pad = 8 - col % 8;
                out.extend(std::iter::repeat_n(' ', pad));
                col += pad;
            }
            '\n' | '\r' => {
                out.push(' ');
                col = 0;
            }
            c if is_ws(c) => {
                out.push(' ');
                col += 1;
            }
            c => {
                out.push(c);
                col += 1;
            }
        }
    }
    out
}

/// `textwrap.wrap(text, width, initial_indent=, subsequent_indent=)`.
pub fn wrap_indent(text: &str, width: i64, initial: &str, subsequent: &str) -> Vec<String> {
    let mut chunks = split_chunks(&munge(text));
    chunks.reverse();
    let mut lines: Vec<String> = vec![];
    while !chunks.is_empty() {
        let mut cur: Vec<String> = vec![];
        let mut cur_len: i64 = 0;
        let indent = if lines.is_empty() { initial } else { subsequent };
        let w = width - clen(indent) as i64;
        if chunks.last().is_some_and(|c| c.chars().all(py_isspace)) && !lines.is_empty() {
            chunks.pop();
        }
        while let Some(last) = chunks.last() {
            let l = clen(last) as i64;
            if cur_len + l <= w {
                cur_len += l;
                cur.push(chunks.pop().unwrap());
            } else {
                break;
            }
        }
        if chunks.last().is_some_and(|c| clen(c) as i64 > w) {
            handle_long_word(&mut chunks, &mut cur, cur_len, w);
        }
        if cur.last().is_some_and(|c| c.chars().all(py_isspace)) {
            cur.pop();
        }
        if !cur.is_empty() {
            lines.push(format!("{indent}{}", cur.concat()));
        }
    }
    lines
}

fn handle_long_word(chunks: &mut Vec<String>, cur: &mut Vec<String>, cur_len: i64, width: i64) {
    let space_left = if width < 1 { 1 } else { width - cur_len };
    if space_left > 0 {
        let chunk: Vec<char> = chunks.last().unwrap().chars().collect();
        let mut end = space_left as usize;
        if chunk.len() > end {
            if let Some(h) = chunk[..end].iter().rposition(|&c| c == '-') {
                if h > 0 && chunk[..h].iter().any(|&c| c != '-') {
                    end = h + 1;
                }
            }
        }
        let end = end.min(chunk.len());
        cur.push(chunk[..end].iter().collect());
        *chunks.last_mut().unwrap() = chunk[end..].iter().collect();
    } else if cur.is_empty() {
        cur.push(chunks.pop().unwrap());
    }
}

pub fn wrap(text: &str, width: i64) -> Vec<String> {
    wrap_indent(text, width, "", "")
}

pub fn fill(text: &str, width: i64, indent: &str) -> String {
    wrap_indent(text, width, indent, indent).join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_like_wordsep_re() {
        let got = split_chunks("Look, goof-ball -- use the -b option!");
        assert_eq!(got, ["Look,", " ", "goof-", "ball", " ", "--", " ", "use", " ", "the", " ", "-b", " ", "option!"]);
        assert_eq!(split_chunks("Hello there -- you goof-ball"), ["Hello", " ", "there", " ", "--", " ", "you", " ", "goof-", "ball"]);
        assert_eq!(split_chunks("a--b"), ["a", "--", "b"]);
    }

    #[test]
    fn wraps() {
        assert_eq!(wrap("Re-download even when the version is already installed", 20), ["Re-download even", "when the version is", "already installed"]);
    }
}
