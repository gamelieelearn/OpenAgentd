//! `yaml.safe_dump(data, sort_keys=False)` — a port of PyYAML 6.0.3's
//! SafeRepresenter + Serializer + Emitter (default options: block style,
//! indent 2, width 80, `allow_unicode=False`). Output is byte-identical,
//! including line folding of long scalars and `\xE9`-style escapes.
//!
//! The input is an alias-free [`Py`] tree, so no `&id001` anchors are
//! ever emitted (PyYAML only emits them for objects shared by identity).

use super::load::{resolve_plain, Py};

const TAG: &str = "tag:yaml.org,2002:";
const BREAKS: &str = "\n\u{85}\u{2028}\u{2029}";
const BLANK_Z: &str = "\0 \t\r\n\u{85}\u{2028}\u{2029}";

fn is_in(c: char, set: &str) -> bool {
    set.contains(c)
}

#[derive(Debug, Clone)]
enum Ev {
    StreamStart,
    StreamEnd,
    DocumentStart,
    DocumentEnd,
    Scalar { tag: String, implicit: (bool, bool), value: String, style: Option<char> },
    SequenceStart { tag: String, implicit: bool },
    SequenceEnd,
    MappingStart { tag: String, implicit: bool },
    MappingEnd,
}

// ── representer + serializer ────────────────────────────────────────────────

/// `repr(float).lower()` as `SafeRepresenter.represent_float` writes it.
fn float_value(f: f64) -> String {
    if f.is_nan() {
        return ".nan".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { ".inf" } else { "-.inf" }.into();
    }
    let mut v = crate::pyjson::float_repr(f).to_lowercase();
    if !v.contains('.') && v.contains('e') {
        v = v.replacen('e', ".0e", 1);
    }
    v
}

/// `base64.encodebytes` (76-character lines, each ending in `\n`).
fn encodebytes(b: &[u8]) -> String {
    use base64::Engine;
    let s = base64::engine::general_purpose::STANDARD.encode(b);
    let mut out = String::new();
    for chunk in s.as_bytes().chunks(76) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or(""));
        out.push('\n');
    }
    out
}

fn scalar(out: &mut Vec<Ev>, short: &str, value: String, style: Option<char>) {
    let tag = format!("{TAG}{short}");
    let detected = resolve_plain(&value).unwrap_or("str");
    let implicit = (short == detected, short == "str");
    out.push(Ev::Scalar { tag, implicit, value, style });
}

fn represent(p: &Py, out: &mut Vec<Ev>) {
    match p {
        Py::None => scalar(out, "null", "null".into(), None),
        Py::Bool(b) => scalar(out, "bool", if *b { "true" } else { "false" }.into(), None),
        Py::Int(i) => scalar(out, "int", i.to_string(), None),
        Py::Float(f) => scalar(out, "float", float_value(*f), None),
        Py::Str(s) => scalar(out, "str", s.clone(), None),
        Py::Bytes(b) => scalar(out, "binary", encodebytes(b), Some('|')),
        Py::Date(y, m, d) => scalar(out, "timestamp", format!("{y:04}-{m:02}-{d:02}"), None),
        Py::DateTime(dt) => scalar(out, "timestamp", dt.isoformat().replacen('T', " ", 1), None),
        Py::List(v) | Py::Tuple(v) => {
            out.push(Ev::SequenceStart { tag: format!("{TAG}seq"), implicit: true });
            for x in v {
                represent(x, out);
            }
            out.push(Ev::SequenceEnd);
        }
        Py::Set(v) => {
            out.push(Ev::MappingStart { tag: format!("{TAG}set"), implicit: false });
            for k in v {
                represent(k, out);
                represent(&Py::None, out);
            }
            out.push(Ev::MappingEnd);
        }
        Py::Dict(v) => {
            out.push(Ev::MappingStart { tag: format!("{TAG}map"), implicit: true });
            for (k, x) in v {
                represent(k, out);
                represent(x, out);
            }
            out.push(Ev::MappingEnd);
        }
    }
}

// ── emitter ─────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq)]
enum St {
    StreamStart,
    FirstDocumentStart,
    DocumentStart,
    DocumentEnd,
    DocumentRoot,
    Nothing,
    FirstFlowSequenceItem,
    FlowSequenceItem,
    FirstFlowMappingKey,
    FlowMappingKey,
    FlowMappingSimpleValue,
    FlowMappingValue,
    FirstBlockSequenceItem,
    BlockSequenceItem,
    FirstBlockMappingKey,
    BlockMappingKey,
    BlockMappingSimpleValue,
    BlockMappingValue,
}

#[derive(Debug, Clone)]
struct Analysis {
    scalar: String,
    empty: bool,
    multiline: bool,
    allow_flow_plain: bool,
    allow_block_plain: bool,
    allow_single_quoted: bool,
    allow_block: bool,
}

struct Emitter {
    out: String,
    events: Vec<Ev>,
    pos: usize,
    states: Vec<St>,
    state: St,
    indents: Vec<Option<i64>>,
    indent: Option<i64>,
    flow_level: usize,
    root_context: bool,
    simple_key_context: bool,
    mapping_context: bool,
    column: i64,
    whitespace: bool,
    indention: bool,
    open_ended: bool,
    best_indent: i64,
    best_width: i64,
    prepared_tag: Option<String>,
    analysis: Option<Analysis>,
    style: Option<String>,
}

fn analyze_scalar(scalar: &str) -> Analysis {
    let chars: Vec<char> = scalar.chars().collect();
    if chars.is_empty() {
        return Analysis { scalar: String::new(), empty: true, multiline: false, allow_flow_plain: false, allow_block_plain: true, allow_single_quoted: true, allow_block: false };
    }
    let (mut block_indicators, mut flow_indicators, mut line_breaks, mut special_characters) = (false, false, false, false);
    let (mut leading_space, mut leading_break, mut trailing_space, mut trailing_break, mut break_space, mut space_break) = (false, false, false, false, false, false);
    if scalar.starts_with("---") || scalar.starts_with("...") {
        block_indicators = true;
        flow_indicators = true;
    }
    let mut preceded_by_whitespace = true;
    let mut followed_by_whitespace = chars.len() == 1 || is_in(chars[1], BLANK_Z);
    let (mut previous_space, mut previous_break) = (false, false);
    let n = chars.len();
    for (index, &ch) in chars.iter().enumerate() {
        if index == 0 {
            if is_in(ch, "#,[]{}&*!|>'\"%@`") {
                flow_indicators = true;
                block_indicators = true;
            }
            if ch == '?' || ch == ':' {
                flow_indicators = true;
                if followed_by_whitespace {
                    block_indicators = true;
                }
            }
            if ch == '-' && followed_by_whitespace {
                flow_indicators = true;
                block_indicators = true;
            }
        } else {
            if is_in(ch, ",?[]{}") {
                flow_indicators = true;
            }
            if ch == ':' {
                flow_indicators = true;
                if followed_by_whitespace {
                    block_indicators = true;
                }
            }
            if ch == '#' && preceded_by_whitespace {
                flow_indicators = true;
                block_indicators = true;
            }
        }
        if is_in(ch, BREAKS) {
            line_breaks = true;
        }
        let u = ch as u32;
        if !(ch == '\n' || (0x20..=0x7e).contains(&u)) {
            let unicode = (u == 0x85 || (0xa0..=0xd7ff).contains(&u) || (0xe000..=0xfffd).contains(&u) || (0x10000..0x10ffff).contains(&u)) && u != 0xfeff;
            // `allow_unicode` is off: unicode characters are special too.
            let _ = unicode;
            special_characters = true;
        }
        if ch == ' ' {
            if index == 0 {
                leading_space = true;
            }
            if index == n - 1 {
                trailing_space = true;
            }
            if previous_break {
                break_space = true;
            }
            previous_space = true;
            previous_break = false;
        } else if is_in(ch, BREAKS) {
            if index == 0 {
                leading_break = true;
            }
            if index == n - 1 {
                trailing_break = true;
            }
            if previous_space {
                space_break = true;
            }
            previous_space = false;
            previous_break = true;
        } else {
            previous_space = false;
            previous_break = false;
        }
        preceded_by_whitespace = is_in(ch, BLANK_Z);
        followed_by_whitespace = index + 2 >= n || is_in(chars[index + 2], BLANK_Z);
    }
    let (mut allow_flow_plain, mut allow_block_plain, mut allow_single_quoted, mut allow_block) = (true, true, true, true);
    if leading_space || leading_break || trailing_space || trailing_break {
        allow_flow_plain = false;
        allow_block_plain = false;
    }
    if trailing_space {
        allow_block = false;
    }
    if break_space {
        allow_flow_plain = false;
        allow_block_plain = false;
        allow_single_quoted = false;
    }
    if space_break || special_characters {
        allow_flow_plain = false;
        allow_block_plain = false;
        allow_single_quoted = false;
        allow_block = false;
    }
    if line_breaks {
        allow_flow_plain = false;
        allow_block_plain = false;
    }
    if flow_indicators {
        allow_flow_plain = false;
    }
    if block_indicators {
        allow_block_plain = false;
    }
    Analysis { scalar: scalar.to_string(), empty: false, multiline: line_breaks, allow_flow_plain, allow_block_plain, allow_single_quoted, allow_block }
}

fn prepare_tag(tag: &str) -> String {
    if tag == "!" {
        return tag.into();
    }
    let mut handle: Option<&str> = None;
    let mut suffix: &str = tag;
    for (prefix, h) in [("!", "!"), (TAG, "!!")] {
        if tag.starts_with(prefix) && (prefix == "!" || prefix.len() < tag.len()) {
            handle = Some(h);
            suffix = &tag[prefix.len()..];
        }
    }
    let mut chunks = String::new();
    for ch in suffix.chars() {
        if ch.is_ascii_alphanumeric() || is_in(ch, "-;/?:@&=+$,_.~*'()[]") || (ch == '!' && handle != Some("!")) {
            chunks.push(ch);
        } else {
            let mut b = [0u8; 4];
            for byte in ch.encode_utf8(&mut b).bytes() {
                chunks.push_str(&format!("%{byte:02X}"));
            }
        }
    }
    match handle {
        Some(h) => format!("{h}{chunks}"),
        None => format!("!<{chunks}>"),
    }
}

impl Emitter {
    fn event(&self) -> &Ev {
        &self.events[self.pos]
    }
    fn next(&self) -> Option<&Ev> {
        self.events.get(self.pos + 1)
    }
    fn pop_state(&mut self) {
        self.state = self.states.pop().unwrap_or(St::Nothing);
    }
    fn pop_indent(&mut self) {
        self.indent = self.indents.pop().flatten();
    }

    fn increase_indent(&mut self, flow: bool, indentless: bool) {
        self.indents.push(self.indent);
        match self.indent {
            None => self.indent = Some(if flow { self.best_indent } else { 0 }),
            Some(i) if !indentless => self.indent = Some(i + self.best_indent),
            _ => {}
        }
    }

    fn step(&mut self) {
        match self.state {
            St::StreamStart => self.state = St::FirstDocumentStart,
            St::FirstDocumentStart => self.expect_document_start(true),
            St::DocumentStart => self.expect_document_start(false),
            St::DocumentEnd => {
                self.write_indent();
                self.state = St::DocumentStart;
            }
            St::DocumentRoot => {
                self.states.push(St::DocumentEnd);
                self.expect_node(true, false, false, false);
            }
            St::Nothing => {}
            St::FirstFlowSequenceItem | St::FlowSequenceItem => {
                let first = self.state == St::FirstFlowSequenceItem;
                if matches!(self.event(), Ev::SequenceEnd) {
                    self.pop_indent();
                    self.flow_level -= 1;
                    self.write_indicator("]", false, false, false);
                    self.pop_state();
                } else {
                    if !first {
                        self.write_indicator(",", false, false, false);
                    }
                    if self.column > self.best_width {
                        self.write_indent();
                    }
                    self.states.push(St::FlowSequenceItem);
                    self.expect_node(false, true, false, false);
                }
            }
            St::FirstFlowMappingKey | St::FlowMappingKey => {
                let first = self.state == St::FirstFlowMappingKey;
                if matches!(self.event(), Ev::MappingEnd) {
                    self.pop_indent();
                    self.flow_level -= 1;
                    self.write_indicator("}", false, false, false);
                    self.pop_state();
                } else {
                    if !first {
                        self.write_indicator(",", false, false, false);
                    }
                    if self.column > self.best_width {
                        self.write_indent();
                    }
                    if self.check_simple_key() {
                        self.states.push(St::FlowMappingSimpleValue);
                        self.expect_node(false, false, true, true);
                    } else {
                        self.write_indicator("?", true, false, false);
                        self.states.push(St::FlowMappingValue);
                        self.expect_node(false, false, true, false);
                    }
                }
            }
            St::FlowMappingSimpleValue => {
                self.write_indicator(":", false, false, false);
                self.states.push(St::FlowMappingKey);
                self.expect_node(false, false, true, false);
            }
            St::FlowMappingValue => {
                if self.column > self.best_width {
                    self.write_indent();
                }
                self.write_indicator(":", true, false, false);
                self.states.push(St::FlowMappingKey);
                self.expect_node(false, false, true, false);
            }
            St::FirstBlockSequenceItem | St::BlockSequenceItem => {
                let first = self.state == St::FirstBlockSequenceItem;
                if !first && matches!(self.event(), Ev::SequenceEnd) {
                    self.pop_indent();
                    self.pop_state();
                } else {
                    self.write_indent();
                    self.write_indicator("-", true, false, true);
                    self.states.push(St::BlockSequenceItem);
                    self.expect_node(false, true, false, false);
                }
            }
            St::FirstBlockMappingKey | St::BlockMappingKey => {
                let first = self.state == St::FirstBlockMappingKey;
                if !first && matches!(self.event(), Ev::MappingEnd) {
                    self.pop_indent();
                    self.pop_state();
                } else {
                    self.write_indent();
                    if self.check_simple_key() {
                        self.states.push(St::BlockMappingSimpleValue);
                        self.expect_node(false, false, true, true);
                    } else {
                        self.write_indicator("?", true, false, true);
                        self.states.push(St::BlockMappingValue);
                        self.expect_node(false, false, true, false);
                    }
                }
            }
            St::BlockMappingSimpleValue => {
                self.write_indicator(":", false, false, false);
                self.states.push(St::BlockMappingKey);
                self.expect_node(false, false, true, false);
            }
            St::BlockMappingValue => {
                self.write_indent();
                self.write_indicator(":", true, false, true);
                self.states.push(St::BlockMappingKey);
                self.expect_node(false, false, true, false);
            }
        }
    }

    fn expect_document_start(&mut self, first: bool) {
        match self.event() {
            Ev::DocumentStart => {
                // `check_empty_document` is always false: every scalar carries a tag.
                if !first {
                    self.write_indent();
                    self.write_indicator("---", true, false, false);
                }
                self.state = St::DocumentRoot;
            }
            Ev::StreamEnd => {
                if self.open_ended {
                    self.write_indicator("...", true, false, false);
                    self.write_indent();
                }
                self.state = St::Nothing;
            }
            _ => {}
        }
    }

    fn check_empty(&self, end_is_map: bool) -> bool {
        matches!((end_is_map, self.next()), (false, Some(Ev::SequenceEnd)) | (true, Some(Ev::MappingEnd)))
    }

    fn expect_node(&mut self, root: bool, _sequence: bool, mapping: bool, simple_key: bool) {
        self.root_context = root;
        self.mapping_context = mapping;
        self.simple_key_context = simple_key;
        self.process_tag();
        match self.event().clone() {
            Ev::Scalar { .. } => {
                self.increase_indent(true, false);
                self.process_scalar();
                self.pop_indent();
                self.pop_state();
            }
            Ev::SequenceStart { .. } => {
                if self.flow_level > 0 || self.check_empty(false) {
                    self.write_indicator("[", true, true, false);
                    self.flow_level += 1;
                    self.increase_indent(true, false);
                    self.state = St::FirstFlowSequenceItem;
                } else {
                    let indentless = self.mapping_context && !self.indention;
                    self.increase_indent(false, indentless);
                    self.state = St::FirstBlockSequenceItem;
                }
            }
            Ev::MappingStart { .. } => {
                if self.flow_level > 0 || self.check_empty(true) {
                    self.write_indicator("{", true, true, false);
                    self.flow_level += 1;
                    self.increase_indent(true, false);
                    self.state = St::FirstFlowMappingKey;
                } else {
                    self.increase_indent(false, false);
                    self.state = St::FirstBlockMappingKey;
                }
            }
            _ => {}
        }
    }

    fn check_simple_key(&mut self) -> bool {
        let mut length = 0usize;
        let ev = self.event().clone();
        match &ev {
            Ev::Scalar { tag, value, .. } => {
                if self.prepared_tag.is_none() {
                    self.prepared_tag = Some(prepare_tag(tag));
                }
                length += self.prepared_tag.as_ref().map(|t| t.chars().count()).unwrap_or(0);
                if self.analysis.is_none() {
                    self.analysis = Some(analyze_scalar(value));
                }
                let a = self.analysis.as_ref().unwrap();
                length += a.scalar.chars().count();
                length < 128 && !a.empty && !a.multiline
            }
            Ev::SequenceStart { tag, .. } | Ev::MappingStart { tag, .. } => {
                if self.prepared_tag.is_none() {
                    self.prepared_tag = Some(prepare_tag(tag));
                }
                length += self.prepared_tag.as_ref().map(|t| t.chars().count()).unwrap_or(0);
                length < 128 && (self.check_empty(false) && matches!(ev, Ev::SequenceStart { .. }) || self.check_empty(true) && matches!(ev, Ev::MappingStart { .. }))
            }
            _ => false,
        }
    }

    fn process_tag(&mut self) {
        let ev = self.event().clone();
        let tag = match &ev {
            Ev::Scalar { tag, implicit, .. } => {
                if self.style.is_none() {
                    self.style = Some(self.choose_scalar_style());
                }
                let style = self.style.clone().unwrap_or_default();
                if (style.is_empty() && implicit.0) || (!style.is_empty() && implicit.1) {
                    self.prepared_tag = None;
                    return;
                }
                tag.clone()
            }
            Ev::SequenceStart { tag, implicit } | Ev::MappingStart { tag, implicit } => {
                if *implicit {
                    self.prepared_tag = None;
                    return;
                }
                tag.clone()
            }
            _ => return,
        };
        let prepared = self.prepared_tag.take().unwrap_or_else(|| prepare_tag(&tag));
        if !prepared.is_empty() {
            self.write_indicator(&prepared, true, false, false);
        }
    }

    fn choose_scalar_style(&mut self) -> String {
        let Ev::Scalar { value, implicit, style, .. } = self.event().clone() else { return String::new() };
        if self.analysis.is_none() {
            self.analysis = Some(analyze_scalar(&value));
        }
        let a = self.analysis.clone().unwrap();
        if style == Some('"') {
            return "\"".into();
        }
        if style.is_none() && implicit.0 {
            let ok_ctx = !(self.simple_key_context && (a.empty || a.multiline));
            if ok_ctx && ((self.flow_level > 0 && a.allow_flow_plain) || (self.flow_level == 0 && a.allow_block_plain)) {
                return String::new();
            }
        }
        if let Some(s @ ('|' | '>')) = style {
            if self.flow_level == 0 && !self.simple_key_context && a.allow_block {
                return s.to_string();
            }
        }
        if style.is_none() || style == Some('\'') {
            if a.allow_single_quoted && !(self.simple_key_context && a.multiline) {
                return "'".into();
            }
        }
        "\"".into()
    }

    fn process_scalar(&mut self) {
        if self.analysis.is_none() {
            if let Ev::Scalar { value, .. } = self.event() {
                self.analysis = Some(analyze_scalar(value));
            }
        }
        if self.style.is_none() {
            self.style = Some(self.choose_scalar_style());
        }
        let split = !self.simple_key_context;
        let text = self.analysis.take().map(|a| a.scalar).unwrap_or_default();
        let style = self.style.take().unwrap_or_default();
        match style.as_str() {
            "\"" => self.write_double_quoted(&text, split),
            "'" => self.write_single_quoted(&text, split),
            ">" => self.write_folded(&text),
            "|" => self.write_literal(&text),
            _ => self.write_plain(&text, split),
        }
    }

    // ── writers ──

    fn write(&mut self, data: &str) {
        self.out.push_str(data);
    }

    fn write_counted(&mut self, data: &str) {
        self.column += data.chars().count() as i64;
        self.out.push_str(data);
    }

    fn write_indicator(&mut self, indicator: &str, need_whitespace: bool, whitespace: bool, indention: bool) {
        let data = if self.whitespace || !need_whitespace { indicator.to_string() } else { format!(" {indicator}") };
        self.whitespace = whitespace;
        self.indention = self.indention && indention;
        self.open_ended = false;
        self.write_counted(&data);
    }

    fn write_indent(&mut self) {
        let indent = self.indent.unwrap_or(0);
        if !self.indention || self.column > indent || (self.column == indent && !self.whitespace) {
            self.write_line_break(None);
        }
        if self.column < indent {
            self.whitespace = true;
            let data = " ".repeat((indent - self.column) as usize);
            self.column = indent;
            self.write(&data);
        }
    }

    fn write_line_break(&mut self, data: Option<char>) {
        self.whitespace = true;
        self.indention = true;
        self.column = 0;
        self.out.push(data.unwrap_or('\n'));
    }

    fn write_single_quoted(&mut self, text: &str, split: bool) {
        self.write_indicator("'", true, false, false);
        let t: Vec<char> = text.chars().collect();
        let (mut spaces, mut breaks) = (false, false);
        let (mut start, mut end) = (0usize, 0usize);
        while end <= t.len() {
            let ch = t.get(end).copied();
            if spaces {
                if ch != Some(' ') {
                    if start + 1 == end && self.column > self.best_width && split && start != 0 && end != t.len() {
                        self.write_indent();
                    } else {
                        let data: String = t[start..end].iter().collect();
                        self.write_counted(&data);
                    }
                    start = end;
                }
            } else if breaks {
                if ch.is_none_or(|c| !is_in(c, BREAKS)) {
                    if t[start] == '\n' {
                        self.write_line_break(None);
                    }
                    for &br in &t[start..end] {
                        self.write_line_break(if br == '\n' { None } else { Some(br) });
                    }
                    self.write_indent();
                    start = end;
                }
            } else if ch.is_none_or(|c| is_in(c, " \n\u{85}\u{2028}\u{2029}") || c == '\'') && start < end {
                let data: String = t[start..end].iter().collect();
                self.write_counted(&data);
                start = end;
            }
            if ch == Some('\'') {
                self.write_counted("''");
                start = end + 1;
            }
            if let Some(c) = ch {
                spaces = c == ' ';
                breaks = is_in(c, BREAKS);
            }
            end += 1;
        }
        self.write_indicator("'", false, false, false);
    }

    fn write_double_quoted(&mut self, text: &str, split: bool) {
        self.write_indicator("\"", true, false, false);
        let t: Vec<char> = text.chars().collect();
        let (mut start, mut end) = (0usize, 0usize);
        while end <= t.len() {
            let ch = t.get(end).copied();
            let escape = match ch {
                None => true,
                Some(c) => is_in(c, "\"\\\u{85}\u{2028}\u{2029}\u{feff}") || !(' '..='~').contains(&c),
            };
            if escape {
                if start < end {
                    let data: String = t[start..end].iter().collect();
                    self.write_counted(&data);
                    start = end;
                }
                if let Some(c) = ch {
                    let data = match c {
                        '\0' => "\\0".to_string(),
                        '\x07' => "\\a".into(),
                        '\x08' => "\\b".into(),
                        '\t' => "\\t".into(),
                        '\n' => "\\n".into(),
                        '\x0b' => "\\v".into(),
                        '\x0c' => "\\f".into(),
                        '\r' => "\\r".into(),
                        '\x1b' => "\\e".into(),
                        '"' => "\\\"".into(),
                        '\\' => "\\\\".into(),
                        '\u{85}' => "\\N".into(),
                        '\u{a0}' => "\\_".into(),
                        '\u{2028}' => "\\L".into(),
                        '\u{2029}' => "\\P".into(),
                        c if (c as u32) <= 0xff => format!("\\x{:02X}", c as u32),
                        c if (c as u32) <= 0xffff => format!("\\u{:04X}", c as u32),
                        c => format!("\\U{:08X}", c as u32),
                    };
                    self.write_counted(&data);
                    start = end + 1;
                }
            }
            if 0 < end && end + 1 < t.len() && (ch == Some(' ') || start >= end) && self.column + (end as i64 - start as i64) > self.best_width && split {
                let mut data: String = if start < end { t[start..end].iter().collect() } else { String::new() };
                data.push('\\');
                if start < end {
                    start = end;
                }
                self.write_counted(&data);
                self.write_indent();
                self.whitespace = false;
                self.indention = false;
                if t.get(start) == Some(&' ') {
                    self.write_counted("\\");
                }
            }
            end += 1;
        }
        self.write_indicator("\"", false, false, false);
    }

    fn block_hints(&self, t: &[char]) -> String {
        let mut hints = String::new();
        if let (Some(&first), Some(&last)) = (t.first(), t.last()) {
            if is_in(first, " \n\u{85}\u{2028}\u{2029}") {
                hints.push_str(&self.best_indent.to_string());
            }
            if !is_in(last, BREAKS) {
                hints.push('-');
            } else if t.len() == 1 || is_in(t[t.len() - 2], BREAKS) {
                hints.push('+');
            }
        }
        hints
    }

    fn write_folded(&mut self, text: &str) {
        let t: Vec<char> = text.chars().collect();
        let hints = self.block_hints(&t);
        self.write_indicator(&format!(">{hints}"), true, false, false);
        if hints.ends_with('+') {
            self.open_ended = true;
        }
        self.write_line_break(None);
        let (mut leading_space, mut spaces, mut breaks) = (true, false, true);
        let (mut start, mut end) = (0usize, 0usize);
        while end <= t.len() {
            let ch = t.get(end).copied();
            if breaks {
                if ch.is_none_or(|c| !is_in(c, BREAKS)) {
                    if !leading_space && ch.is_some() && ch != Some(' ') && t[start] == '\n' {
                        self.write_line_break(None);
                    }
                    leading_space = ch == Some(' ');
                    for &br in &t[start..end] {
                        self.write_line_break(if br == '\n' { None } else { Some(br) });
                    }
                    if ch.is_some() {
                        self.write_indent();
                    }
                    start = end;
                }
            } else if spaces {
                if ch != Some(' ') {
                    if start + 1 == end && self.column > self.best_width {
                        self.write_indent();
                    } else {
                        let data: String = t[start..end].iter().collect();
                        self.write_counted(&data);
                    }
                    start = end;
                }
            } else if ch.is_none_or(|c| is_in(c, " \n\u{85}\u{2028}\u{2029}")) {
                let data: String = t[start..end].iter().collect();
                self.write_counted(&data);
                if ch.is_none() {
                    self.write_line_break(None);
                }
                start = end;
            }
            if let Some(c) = ch {
                breaks = is_in(c, BREAKS);
                spaces = c == ' ';
            }
            end += 1;
        }
    }

    fn write_literal(&mut self, text: &str) {
        let t: Vec<char> = text.chars().collect();
        let hints = self.block_hints(&t);
        self.write_indicator(&format!("|{hints}"), true, false, false);
        if hints.ends_with('+') {
            self.open_ended = true;
        }
        self.write_line_break(None);
        let mut breaks = true;
        let (mut start, mut end) = (0usize, 0usize);
        while end <= t.len() {
            let ch = t.get(end).copied();
            if breaks {
                if ch.is_none_or(|c| !is_in(c, BREAKS)) {
                    for &br in &t[start..end] {
                        self.write_line_break(if br == '\n' { None } else { Some(br) });
                    }
                    if ch.is_some() {
                        self.write_indent();
                    }
                    start = end;
                }
            } else if ch.is_none_or(|c| is_in(c, BREAKS)) {
                // Python does not advance `column` here.
                let data: String = t[start..end].iter().collect();
                self.write(&data);
                if ch.is_none() {
                    self.write_line_break(None);
                }
                start = end;
            }
            if let Some(c) = ch {
                breaks = is_in(c, BREAKS);
            }
            end += 1;
        }
    }

    fn write_plain(&mut self, text: &str, split: bool) {
        if self.root_context {
            self.open_ended = true;
        }
        if text.is_empty() {
            return;
        }
        if !self.whitespace {
            self.write_counted(" ");
        }
        self.whitespace = false;
        self.indention = false;
        let t: Vec<char> = text.chars().collect();
        let (mut spaces, mut breaks) = (false, false);
        let (mut start, mut end) = (0usize, 0usize);
        while end <= t.len() {
            let ch = t.get(end).copied();
            if spaces {
                if ch != Some(' ') {
                    if start + 1 == end && self.column > self.best_width && split {
                        self.write_indent();
                        self.whitespace = false;
                        self.indention = false;
                    } else {
                        let data: String = t[start..end].iter().collect();
                        self.write_counted(&data);
                    }
                    start = end;
                }
            } else if breaks {
                if ch.is_none_or(|c| !is_in(c, BREAKS)) {
                    if t[start] == '\n' {
                        self.write_line_break(None);
                    }
                    for &br in &t[start..end] {
                        self.write_line_break(if br == '\n' { None } else { Some(br) });
                    }
                    self.write_indent();
                    self.whitespace = false;
                    self.indention = false;
                    start = end;
                }
            } else if ch.is_none_or(|c| is_in(c, " \n\u{85}\u{2028}\u{2029}")) {
                let data: String = t[start..end].iter().collect();
                self.write_counted(&data);
                start = end;
            }
            if let Some(c) = ch {
                spaces = c == ' ';
                breaks = is_in(c, BREAKS);
            }
            end += 1;
        }
    }
}

/// `yaml.safe_dump(data, sort_keys=False)`.
pub fn safe_dump_py(data: &Py) -> String {
    let mut events = vec![Ev::StreamStart, Ev::DocumentStart];
    represent(data, &mut events);
    events.push(Ev::DocumentEnd);
    events.push(Ev::StreamEnd);
    let mut e = Emitter {
        out: String::new(),
        events,
        pos: 0,
        states: vec![],
        state: St::StreamStart,
        indents: vec![],
        indent: None,
        flow_level: 0,
        root_context: false,
        simple_key_context: false,
        mapping_context: false,
        column: 0,
        whitespace: true,
        indention: true,
        open_ended: false,
        best_indent: 2,
        best_width: 80,
        prepared_tag: None,
        analysis: None,
        style: None,
    };
    while e.pos < e.events.len() {
        e.step();
        e.pos += 1;
    }
    e.out
}
