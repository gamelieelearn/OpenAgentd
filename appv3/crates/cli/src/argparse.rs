//! Port of the CPython 3.14 `argparse` subset the v2 CLI uses
//! (`app/cli/main.py`): store / store_true / store_false / help / version
//! actions, `nargs` None / `?` / PARSER, `choices`, `type=int`, nested
//! subparsers, `allow_abbrev`, and `HelpFormatter` /
//! `RawDescriptionHelpFormatter` output including 3.14's colour theme.
//! Help, usage, and error texts are byte-identical to v2.

use crate::textwrap;
use std::collections::{HashMap, HashSet};
use std::io::Write;

#[derive(Clone, Debug, PartialEq)]
pub enum Val {
    None,
    Bool(bool),
    Int(i64),
    Str(String),
}

impl Val {
    fn py_str(&self) -> String {
        match self {
            Val::None => "None".into(),
            Val::Bool(b) => if *b { "True" } else { "False" }.into(),
            Val::Int(i) => i.to_string(),
            Val::Str(s) => s.clone(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Nargs {
    One,
    Optional,
    Zero,
    Parser,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Ty {
    Str,
    Int,
}

pub enum Kind {
    Help,
    Version(String),
    StoreTrue,
    StoreFalse,
    Store(Ty),
    Subparsers(Vec<(String, Parser)>, Vec<(String, String)>),
}

pub struct Action {
    pub option_strings: Vec<String>,
    /// `None` = `SUPPRESS`.
    pub dest: Option<String>,
    pub nargs: Nargs,
    pub kind: Kind,
    /// `None` = `SUPPRESS`.
    pub default: Option<Val>,
    pub choices: Option<Vec<String>>,
    pub required: bool,
    pub help: Option<String>,
    pub metavar: Option<String>,
}

impl Action {
    fn new(names: &[&str], kind: Kind, nargs: Nargs, default: Option<Val>) -> Self {
        let option_strings: Vec<String> = names.iter().filter(|n| n.starts_with('-')).map(|s| s.to_string()).collect();
        let dest = if option_strings.is_empty() {
            names[0].to_string()
        } else {
            let long = option_strings.iter().find(|s| s.starts_with("--"));
            let first = long.unwrap_or(&option_strings[0]);
            first.trim_start_matches('-').replace('-', "_")
        };
        let required = option_strings.is_empty() && nargs != Nargs::Optional;
        Action { option_strings, dest: Some(dest), nargs, kind, default, choices: None, required, help: None, metavar: None }
    }
    /// `add_argument(..., action="store")`.
    pub fn store(names: &[&str]) -> Self {
        Self::new(names, Kind::Store(Ty::Str), Nargs::One, Some(Val::None))
    }
    pub fn store_true(names: &[&str]) -> Self {
        Self::new(names, Kind::StoreTrue, Nargs::Zero, Some(Val::Bool(false)))
    }
    pub fn store_false(names: &[&str]) -> Self {
        Self::new(names, Kind::StoreFalse, Nargs::Zero, Some(Val::Bool(true)))
    }
    pub fn version(names: &[&str], version: String) -> Self {
        let mut a = Self::new(names, Kind::Version(version), Nargs::Zero, None);
        a.dest = None;
        a.help = Some("show program's version number and exit".into());
        a
    }
    pub fn help(mut self, h: &str) -> Self {
        self.help = Some(h.into());
        self
    }
    pub fn int(mut self) -> Self {
        self.kind = Kind::Store(Ty::Int);
        self
    }
    pub fn default(mut self, v: Val) -> Self {
        self.default = Some(v);
        self
    }
    pub fn suppress(mut self) -> Self {
        self.default = None;
        self
    }
    pub fn dest(mut self, d: &str) -> Self {
        self.dest = Some(d.into());
        self
    }
    pub fn metavar(mut self, m: &str) -> Self {
        self.metavar = Some(m.into());
        self
    }
    pub fn choices(mut self, c: &[&str]) -> Self {
        self.choices = Some(c.iter().map(|s| s.to_string()).collect());
        self
    }
    pub fn required(mut self) -> Self {
        self.required = true;
        self
    }
    pub fn optional(mut self) -> Self {
        self.nargs = Nargs::Optional;
        if self.option_strings.is_empty() {
            self.required = false;
        }
        self
    }

    fn choice_names(&self) -> Option<Vec<String>> {
        match &self.kind {
            Kind::Subparsers(p, _) => Some(p.iter().map(|(n, _)| n.clone()).collect()),
            _ => self.choices.clone(),
        }
    }
}

pub type Ns = HashMap<String, Val>;

pub struct Parser {
    pub prog: String,
    pub description: Option<String>,
    pub epilog: Option<String>,
    pub raw: bool,
    pub actions: Vec<Action>,
    pub defaults: Vec<(String, Val)>,
}

struct ArgErr {
    name: Option<String>,
    msg: String,
}

impl ArgErr {
    fn new(a: Option<&Action>, msg: String) -> Self {
        ArgErr { name: a.and_then(action_name), msg }
    }
    fn text(&self) -> String {
        match &self.name {
            Some(n) => format!("argument {n}: {}", self.msg),
            None => self.msg.clone(),
        }
    }
}

fn action_name(a: &Action) -> Option<String> {
    if !a.option_strings.is_empty() {
        Some(a.option_strings.join("/"))
    } else if let Some(m) = &a.metavar {
        Some(m.clone())
    } else if let Some(d) = &a.dest {
        Some(d.clone())
    } else {
        a.choice_names().filter(|c| !c.is_empty()).map(|c| format!("{{{}}}", c.join(",")))
    }
}

enum Values {
    Suppress,
    One(Val),
    List(Vec<String>),
}

/// Python `repr(str)`.
pub fn py_repr(s: &str) -> String {
    let q = if s.contains('\'') && !s.contains('"') { '"' } else { '\'' };
    let mut out = String::new();
    out.push(q);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c == q => {
                out.push('\\');
                out.push(c);
            }
            c if !py_printable(c) => {
                let n = c as u32;
                if n < 0x100 {
                    out.push_str(&format!("\\x{n:02x}"));
                } else if n < 0x10000 {
                    out.push_str(&format!("\\u{n:04x}"));
                } else {
                    out.push_str(&format!("\\U{n:08x}"));
                }
            }
            c => out.push(c),
        }
    }
    out.push(q);
    out
}

fn py_printable(c: char) -> bool {
    if c == ' ' {
        return true;
    }
    if c.is_control() || (c.is_whitespace() && c != ' ') {
        return false;
    }
    !matches!(c as u32, 0xAD | 0x600..=0x605 | 0x61C | 0x6DD | 0x70F | 0x180E | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF | 0xFFF9..=0xFFFB | 0xD800..=0xDFFF | 0xE000..=0xF8FF)
}

use crate::pystr::py_int;

// ── colour ──────────────────────────────────────────────────────────────────

#[derive(Default, Clone)]
pub struct Theme {
    usage: &'static str,
    prog: &'static str,
    heading: &'static str,
    summary_long_option: &'static str,
    summary_short_option: &'static str,
    summary_label: &'static str,
    summary_action: &'static str,
    long_option: &'static str,
    short_option: &'static str,
    label: &'static str,
    action: &'static str,
    reset: &'static str,
}

impl Theme {
    fn colored() -> Self {
        Theme {
            usage: "\x1b[1;34m",
            prog: "\x1b[1;35m",
            heading: "\x1b[1;34m",
            summary_long_option: "\x1b[36m",
            summary_short_option: "\x1b[32m",
            summary_label: "\x1b[33m",
            summary_action: "\x1b[32m",
            long_option: "\x1b[1;36m",
            short_option: "\x1b[1;32m",
            label: "\x1b[1;33m",
            action: "\x1b[1;32m",
            reset: "\x1b[0m",
        }
    }
}

pub fn stdout_isatty() -> bool {
    use std::io::IsTerminal;
    std::io::stdout().is_terminal()
}

/// `_colorize.can_colorize()` for stdout.
pub fn can_colorize() -> bool {
    let env = |k: &str| std::env::var(k).ok();
    match env("PYTHON_COLORS").as_deref() {
        Some("0") => return false,
        Some("1") => return true,
        _ => {}
    }
    if env("NO_COLOR").is_some_and(|v| !v.is_empty()) {
        return false;
    }
    if env("FORCE_COLOR").is_some_and(|v| !v.is_empty()) {
        return true;
    }
    if env("TERM").as_deref() == Some("dumb") {
        return false;
    }
    stdout_isatty()
}

/// `shutil.get_terminal_size().columns`.
pub fn terminal_columns() -> i64 {
    if let Some(c) = std::env::var("COLUMNS").ok().and_then(|v| py_int(&v)).filter(|&c| c > 0) {
        return c;
    }
    #[cfg(unix)]
    {
        let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
        if unsafe { libc::ioctl(1, libc::TIOCGWINSZ, &mut ws) } == 0 {
            return if ws.ws_col == 0 { 80 } else { ws.ws_col as i64 };
        }
    }
    80
}

fn decolor(s: &str) -> String {
    let mut out = String::new();
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' && it.peek() == Some(&'[') {
            it.next();
            for d in it.by_ref() {
                if d == 'm' {
                    break;
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn clen(s: &str) -> i64 {
    s.chars().count() as i64
}

// ── formatter ───────────────────────────────────────────────────────────────

struct Fmt {
    prog: String,
    width: i64,
    max_help_position: i64,
    raw: bool,
    t: Theme,
    indent: i64,
    max_len: i64,
}

fn pad(n: i64) -> String {
    " ".repeat(n.max(0) as usize)
}

impl Fmt {
    fn new(p: &Parser, color: bool) -> Self {
        let width = terminal_columns() - 2;
        Fmt {
            prog: p.prog.clone(),
            width,
            max_help_position: 24.min((width - 20).max(4)),
            raw: p.raw,
            t: if color { Theme::colored() } else { Theme::default() },
            indent: 0,
            max_len: 0,
        }
    }

    fn metavar(&self, a: &Action, default: &str) -> String {
        if let Some(m) = &a.metavar {
            m.clone()
        } else if let Some(c) = a.choice_names() {
            format!("{{{}}}", c.join(","))
        } else {
            default.to_string()
        }
    }

    fn format_args(&self, a: &Action, default: &str) -> String {
        let m = self.metavar(a, default);
        match a.nargs {
            Nargs::One => m,
            Nargs::Optional => format!("[{m}]"),
            Nargs::Parser => format!("{m} ..."),
            Nargs::Zero => String::new(),
        }
    }

    fn dest_upper(a: &Action) -> String {
        a.dest.clone().unwrap_or_default().to_uppercase()
    }

    /// `(plain, coloured)` usage parts.
    fn usage_parts(&self, actions: &[&Action]) -> Vec<(String, String)> {
        let t = &self.t;
        let mut parts = vec![];
        for a in actions {
            if a.option_strings.is_empty() {
                let args = self.format_args(a, a.dest.as_deref().unwrap_or(""));
                parts.push((args.clone(), format!("{}{args}{}", t.summary_action, t.reset)));
                continue;
            }
            let os = &a.option_strings[0];
            let color = if os.chars().count() > 2 { t.summary_long_option } else { t.summary_short_option };
            let (mut plain, mut col) = if a.nargs == Nargs::Zero {
                (os.clone(), format!("{color}{os}{}", t.reset))
            } else {
                let args = self.format_args(a, &Self::dest_upper(a));
                (format!("{os} {args}"), format!("{color}{os} {}{args}{}", t.summary_label, t.reset))
            };
            if !a.required {
                plain = format!("[{plain}]");
                col = format!("[{col}]");
            }
            parts.push((plain, col));
        }
        parts
    }

    fn format_usage(&self, p: &Parser, prefix: &str) -> String {
        let t = &self.t;
        let prog = self.prog.clone();
        let optionals: Vec<&Action> = p.actions.iter().filter(|a| !a.option_strings.is_empty()).collect();
        let positionals: Vec<&Action> = p.actions.iter().filter(|a| a.option_strings.is_empty()).collect();
        let opt_parts = self.usage_parts(&optionals);
        let pos_parts = self.usage_parts(&positionals);
        let all: Vec<&(String, String)> = opt_parts.iter().chain(pos_parts.iter()).collect();
        let action_plain = all.iter().map(|p| p.0.as_str()).collect::<Vec<_>>().join(" ");
        let action_col = all.iter().map(|p| p.1.as_str()).collect::<Vec<_>>().join(" ");
        let join2 = |a: &str, b: &str| if b.is_empty() { a.to_string() } else { format!("{a} {b}") };
        let plain = join2(&prog, &action_plain);
        let mut usage = join2(&prog, &action_col);
        let text_width = self.width - self.indent;
        if clen(prefix) + clen(&plain) > text_width {
            let get_lines = |parts: &[(i64, String)], indent: &str, prefix: Option<&str>| -> Vec<String> {
                let mut lines: Vec<String> = vec![];
                let mut line: Vec<&str> = vec![];
                let ilen = clen(indent);
                let mut line_len = match prefix {
                    Some(p) => clen(p) - 1,
                    None => ilen - 1,
                };
                for (plen, part) in parts {
                    if line_len + 1 + plen > text_width && !line.is_empty() {
                        lines.push(format!("{indent}{}", line.join(" ")));
                        line.clear();
                        line_len = ilen - 1;
                    }
                    line.push(part);
                    line_len += plen + 1;
                }
                if !line.is_empty() {
                    lines.push(format!("{indent}{}", line.join(" ")));
                }
                if prefix.is_some() {
                    lines[0] = lines[0].chars().skip(ilen as usize).collect();
                }
                lines
            };
            let conv = |v: &[(String, String)]| v.iter().map(|(p, c)| (clen(p), c.clone())).collect::<Vec<_>>();
            let (opt, pos) = (conv(&opt_parts), conv(&pos_parts));
            let prog_part = (clen(&prog), prog.clone());
            let prog_len = clen(&prog);
            let lines = if (clen(prefix) + prog_len) as f64 <= 0.75 * text_width as f64 {
                let indent = pad(clen(prefix) + prog_len + 1);
                if !opt.is_empty() {
                    let mut v = vec![prog_part];
                    v.extend(opt);
                    let mut lines = get_lines(&v, &indent, Some(prefix));
                    lines.extend(get_lines(&pos, &indent, None));
                    lines
                } else if !pos.is_empty() {
                    let mut v = vec![prog_part];
                    v.extend(pos);
                    get_lines(&v, &indent, Some(prefix))
                } else {
                    vec![prog.clone()]
                }
            } else {
                let indent = pad(clen(prefix));
                let mut parts = opt.clone();
                parts.extend(pos.clone());
                let mut lines = get_lines(&parts, &indent, None);
                if lines.len() > 1 {
                    lines = get_lines(&opt, &indent, None);
                    lines.extend(get_lines(&pos, &indent, None));
                }
                let mut v = vec![prog.clone()];
                v.extend(lines);
                v
            };
            usage = lines.join("\n");
        }
        let rest = usage.strip_prefix(prog.as_str()).unwrap_or(&usage).to_string();
        format!("{}{prefix}{}{}{prog}{}{rest}\n\n", t.usage, t.reset, t.prog, t.reset)
    }

    fn fill_text(&self, text: &str, width: i64, indent: &str) -> String {
        if self.raw {
            text.split_inclusive('\n').map(|l| format!("{indent}{l}")).collect()
        } else {
            textwrap::fill(&normalize_ws(text), width, indent)
        }
    }

    fn format_text(&self, text: &str) -> String {
        let text = text.replace("%(prog)s", &self.prog);
        let width = (self.width - self.indent).max(11);
        format!("{}\n\n", self.fill_text(&text, width, &pad(self.indent)))
    }

    fn invocation(&self, a: &Action) -> String {
        let t = &self.t;
        if a.option_strings.is_empty() {
            return format!("{}{}{}", t.action, self.metavar(a, a.dest.as_deref().unwrap_or("")), t.reset);
        }
        let opts: Vec<String> = a
            .option_strings
            .iter()
            .map(|s| if s.chars().count() > 2 { format!("{}{s}{}", t.long_option, t.reset) } else { format!("{}{s}{}", t.short_option, t.reset) })
            .collect();
        if a.nargs == Nargs::Zero {
            opts.join(", ")
        } else {
            format!("{} {}{}{}", opts.join(", "), t.label, self.format_args(a, &Self::dest_upper(a)), t.reset)
        }
    }

    fn format_action(&self, inv: &str, help: Option<&str>, subs: &[(String, String)]) -> String {
        let help_position = (self.max_len + 2).min(self.max_help_position);
        let help_width = (self.width - help_position).max(11);
        let action_width = help_position - self.indent - 2;
        let plain = decolor(inv);
        let mut indent_first = 0;
        let mut header;
        if help.is_none_or(|h| h.is_empty()) {
            header = format!("{}{inv}\n", pad(self.indent));
        } else if clen(&plain) <= action_width {
            let w = action_width.max(0) as usize;
            header = format!("{}{plain:<w$}  ", pad(self.indent));
            header = header.replace(&plain, inv);
        } else {
            header = format!("{}{inv}\n", pad(self.indent));
            indent_first = help_position;
        }
        let mut parts = vec![header.clone()];
        match help {
            Some(h) if !h.trim().is_empty() => {
                let lines = textwrap::wrap(&normalize_ws(h), help_width);
                parts.push(format!("{}{}\n", pad(indent_first), lines[0]));
                for l in &lines[1..] {
                    parts.push(format!("{}{l}\n", pad(help_position)));
                }
            }
            _ if !header.ends_with('\n') => parts.push("\n".into()),
            _ => {}
        }
        if !subs.is_empty() {
            let mut inner = Fmt { prog: self.prog.clone(), t: self.t.clone(), ..*self };
            inner.indent += 2;
            for (name, h) in subs {
                let inv = format!("{}{name}{}", self.t.action, self.t.reset);
                parts.push(inner.format_action(&inv, Some(h), &[]));
            }
        }
        parts.concat()
    }

    fn format_help(mut self, p: &Parser) -> String {
        // `add_argument` pass: longest invocation (section indent 2, sub-actions 4).
        for a in &p.actions {
            self.max_len = self.max_len.max(clen(&decolor(&self.invocation(a))) + 2);
            if let Kind::Subparsers(_, subs) = &a.kind {
                for (name, _) in subs {
                    self.max_len = self.max_len.max(clen(name) + 4);
                }
            }
        }
        let mut out = self.format_usage(p, "usage: ");
        if let Some(d) = &p.description {
            out.push_str(&self.format_text(d));
        }
        for (heading, positional) in [("positional arguments", true), ("options", false)] {
            self.indent += 2;
            let mut items = String::new();
            for a in p.actions.iter().filter(|a| a.option_strings.is_empty() == positional) {
                let subs: &[(String, String)] = match &a.kind {
                    Kind::Subparsers(_, s) => s,
                    _ => &[],
                };
                items.push_str(&self.format_action(&self.invocation(a), a.help.as_deref(), subs));
            }
            self.indent -= 2;
            if !items.is_empty() {
                out.push_str(&format!("\n{}{heading}:{}\n{items}\n", self.t.heading, self.t.reset));
            }
        }
        if let Some(e) = &p.epilog {
            out.push_str(&self.format_text(e));
        }
        finish(&out)
    }
}

/// `HelpFormatter.format_help` post-processing.
fn finish(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut nl = 0;
    for c in s.chars() {
        if c == '\n' {
            nl += 1;
            continue;
        }
        out.push_str(&"\n".repeat(if nl >= 3 { 2 } else { nl }));
        nl = 0;
        out.push(c);
    }
    let trimmed = out.trim_start_matches('\n');
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("{trimmed}\n")
    }
}

/// `_whitespace_matcher.sub(' ', text).strip()` (ASCII `\s`).
fn normalize_ws(text: &str) -> String {
    let mut out = String::new();
    let mut in_ws = false;
    for c in text.chars() {
        if matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0b' | '\x0c') {
            in_ws = true;
        } else {
            if in_ws && !out.is_empty() {
                out.push(' ');
            }
            in_ws = false;
            out.push(c);
        }
    }
    out.trim_matches(|c: char| c.is_whitespace() || ('\x1c'..='\x1f').contains(&c)).to_string()
}

// ── parser ──────────────────────────────────────────────────────────────────

type OptTuple = (Option<usize>, String, Option<String>, Option<String>);

fn out_flush() {
    let _ = std::io::stdout().flush();
}

impl Parser {
    pub fn new(prog: &str) -> Self {
        let mut p = Parser { prog: prog.into(), description: None, epilog: None, raw: false, actions: vec![], defaults: vec![] };
        let mut h = Action::new(&["-h", "--help"], Kind::Help, Nargs::Zero, None);
        h.dest = None;
        h.help = Some("show this help message and exit".into());
        p.actions.push(h);
        p
    }
    pub fn add(&mut self, a: Action) {
        self.actions.push(a);
    }
    pub fn set_default(&mut self, k: &str, v: Val) {
        self.defaults.retain(|(d, _)| d != k);
        self.defaults.push((k.into(), v));
    }
    /// `add_subparsers(dest=, required=, metavar=)`.
    pub fn add_subparsers(&mut self, dest: &str, required: bool, metavar: Option<&str>) {
        let mut a = Action::new(&[dest], Kind::Subparsers(vec![], vec![]), Nargs::Parser, Some(Val::None));
        a.required = required;
        a.metavar = metavar.map(String::from);
        self.actions.push(a);
    }
    /// `subparsers.add_parser(name, help=)`; `build` configures the child.
    pub fn add_parser(&mut self, name: &str, help: Option<&str>, build: impl FnOnce(&mut Parser)) {
        let prog = format!("{} {name}", self.prog);
        let mut child = Parser::new(&prog);
        build(&mut child);
        let a = self.actions.iter_mut().find(|a| matches!(a.kind, Kind::Subparsers(..))).expect("add_subparsers first");
        if let Kind::Subparsers(parsers, helps) = &mut a.kind {
            if let Some(h) = help {
                helps.push((name.into(), h.into()));
            }
            parsers.push((name.into(), child));
        }
    }

    fn formatter(&self) -> Fmt {
        Fmt::new(self, can_colorize())
    }

    pub fn format_help(&self) -> String {
        self.formatter().format_help(self)
    }

    pub fn format_usage(&self) -> String {
        finish(&self.formatter().format_usage(self, "usage: "))
    }

    /// `parser.error(msg)`: usage + `prog: error: msg` on stderr, exit 2.
    pub fn error(&self, msg: &str) -> ! {
        out_flush();
        eprint!("{}", self.format_usage());
        eprint!("{}: error: {msg}\n", self.prog);
        std::process::exit(2)
    }

    fn option_actions(&self) -> Vec<(&str, usize)> {
        let mut v = vec![];
        for (i, a) in self.actions.iter().enumerate() {
            for s in &a.option_strings {
                v.push((s.as_str(), i));
            }
        }
        v
    }

    fn lookup(&self, s: &str) -> Option<usize> {
        self.option_actions().into_iter().find(|(o, _)| *o == s).map(|(_, i)| i)
    }

    fn parse_optional(&self, arg: &str) -> Option<Vec<OptTuple>> {
        if arg.is_empty() || !arg.starts_with('-') {
            return None;
        }
        if let Some(i) = self.lookup(arg) {
            return Some(vec![(Some(i), arg.into(), None, None)]);
        }
        if arg.chars().count() == 1 {
            return None;
        }
        if let Some((os, ea)) = arg.split_once('=') {
            if let Some(i) = self.lookup(os) {
                return Some(vec![(Some(i), os.into(), Some("=".into()), Some(ea.into()))]);
            }
        }
        let tuples = self.option_tuples(arg);
        if !tuples.is_empty() {
            return Some(tuples);
        }
        let c: Vec<char> = arg.chars().collect();
        let digit = |c: Option<&char>| c.is_some_and(|c| c.is_ascii_digit() || (!c.is_ascii() && c.is_numeric()));
        if digit(c.get(1)) || (c.get(1) == Some(&'.') && digit(c.get(2))) {
            return None;
        }
        if arg.contains(' ') {
            return None;
        }
        Some(vec![(None, arg.into(), None, None)])
    }

    fn option_tuples(&self, s: &str) -> Vec<OptTuple> {
        let mut out = vec![];
        let second = s.chars().nth(1);
        let (prefix, sep, explicit) = match s.split_once('=') {
            Some((p, e)) => (p, Some("=".to_string()), Some(e.to_string())),
            None => (s, None, None),
        };
        if second == Some('-') {
            for (os, i) in self.option_actions() {
                if os.starts_with(prefix) {
                    out.push((Some(i), os.to_string(), sep.clone(), explicit.clone()));
                }
            }
        } else {
            let short: String = s.chars().take(2).collect();
            let short_explicit: String = s.chars().skip(2).collect();
            for (os, i) in self.option_actions() {
                if os == short {
                    out.push((Some(i), os.to_string(), Some(String::new()), Some(short_explicit.clone())));
                } else if os.starts_with(prefix) {
                    out.push((Some(i), os.to_string(), sep.clone(), explicit.clone()));
                }
            }
        }
        out
    }

    fn nargs_pattern(a: &Action) -> &'static str {
        let opt = !a.option_strings.is_empty();
        match (a.nargs, opt) {
            (Nargs::One, true) => "([A])",
            (Nargs::One, false) => "(-*A-*)",
            (Nargs::Optional, true) => "(A?)",
            (Nargs::Optional, false) => "(-*A?-*)",
            (Nargs::Parser, true) => "(A[AO]*)",
            (Nargs::Parser, false) => "(-*A[-AO]*)",
            (Nargs::Zero, true) => "([AO]{0})",
            (Nargs::Zero, false) => "((?:-*A){0}-*)",
        }
    }

    fn match_argument(&self, a: &Action, pattern: &str) -> Result<usize, ArgErr> {
        let re = regex::Regex::new(&format!("^{}", Self::nargs_pattern(a))).unwrap();
        match re.captures(pattern) {
            Some(c) => Ok(c.get(1).map_or(0, |m| m.len())),
            None => {
                let msg = match a.nargs {
                    Nargs::One => "expected one argument".to_string(),
                    Nargs::Optional => "expected at most one argument".to_string(),
                    _ => "expected 0 arguments".to_string(),
                };
                Err(ArgErr::new(Some(a), msg))
            }
        }
    }

    fn match_partial(&self, actions: &[usize], pattern: &str) -> Vec<usize> {
        for i in (1..=actions.len()).rev() {
            let pat: String = actions[..i].iter().map(|&j| Self::nargs_pattern(&self.actions[j])).collect();
            let re = regex::Regex::new(&format!("^{pat}")).unwrap();
            if let Some(c) = re.captures(pattern) {
                let mut result: Vec<usize> = (1..c.len()).map(|g| c.get(g).map_or(0, |m| m.len())).collect();
                let end = c.get(0).unwrap().end();
                if end < pattern.len() && pattern.as_bytes()[end] == b'O' {
                    while result.last() == Some(&0) {
                        result.pop();
                    }
                }
                return result;
            }
        }
        vec![]
    }

    fn get_value(&self, a: &Action, s: &str) -> Result<Val, ArgErr> {
        match a.kind {
            Kind::Store(Ty::Int) => py_int(s).map(Val::Int).ok_or_else(|| ArgErr::new(Some(a), format!("invalid int value: {}", py_repr(s)))),
            _ => Ok(Val::Str(s.into())),
        }
    }

    fn check_value(&self, a: &Action, v: &Val) -> Result<(), ArgErr> {
        let Some(choices) = a.choice_names() else { return Ok(()) };
        let ok = matches!(v, Val::Str(s) if choices.contains(s));
        if ok {
            return Ok(());
        }
        Err(ArgErr::new(Some(a), format!("invalid choice: {} (choose from {})", py_repr(&v.py_str()), choices.join(", "))))
    }

    fn get_values(&self, a: &Action, args: &[String]) -> Result<Values, ArgErr> {
        if args.is_empty() && a.nargs == Nargs::Optional {
            let v = if !a.option_strings.is_empty() { Some(Val::None) } else { a.default.clone() };
            return Ok(match v {
                None => Values::Suppress,
                Some(Val::Str(s)) => Values::One(self.get_value(a, &s)?),
                Some(v) => Values::One(v),
            });
        }
        if args.len() == 1 && matches!(a.nargs, Nargs::One | Nargs::Optional) {
            let v = self.get_value(a, &args[0])?;
            self.check_value(a, &v)?;
            return Ok(Values::One(v));
        }
        if a.nargs == Nargs::Parser {
            self.check_value(a, &Val::Str(args[0].clone()))?;
        }
        Ok(Values::List(args.to_vec()))
    }

    fn call(&self, i: usize, v: Values, ns: &mut Ns, unrecognized: &mut Vec<String>) {
        let a = &self.actions[i];
        match &a.kind {
            Kind::Help => {
                print!("{}", self.format_help());
                out_flush();
                std::process::exit(0)
            }
            Kind::Version(ver) => {
                let f = self.formatter();
                print!("{}", finish(&f.format_text(ver)));
                out_flush();
                std::process::exit(0)
            }
            Kind::StoreTrue => {
                ns.insert(a.dest.clone().unwrap(), Val::Bool(true));
            }
            Kind::StoreFalse => {
                ns.insert(a.dest.clone().unwrap(), Val::Bool(false));
            }
            Kind::Store(_) => {
                if let Values::One(v) = v {
                    ns.insert(a.dest.clone().unwrap(), v);
                }
            }
            Kind::Subparsers(parsers, _) => {
                let Values::List(vals) = v else { return };
                if let Some(d) = &a.dest {
                    ns.insert(d.clone(), Val::Str(vals[0].clone()));
                }
                let sub = &parsers.iter().find(|(n, _)| *n == vals[0]).unwrap().1;
                let (sub_ns, extras) = sub.parse_known_args(&vals[1..]);
                ns.extend(sub_ns);
                unrecognized.extend(extras);
            }
        }
    }

    pub fn parse_known_args(&self, args: &[String]) -> (Ns, Vec<String>) {
        let mut ns = Ns::new();
        for a in &self.actions {
            if let (Some(d), Some(v)) = (&a.dest, &a.default) {
                ns.entry(d.clone()).or_insert_with(|| v.clone());
            }
        }
        for (k, v) in &self.defaults {
            ns.entry(k.clone()).or_insert_with(|| v.clone());
        }
        let mut unrecognized = vec![];
        match self.parse_inner(args, &mut ns, &mut unrecognized) {
            Ok(mut extras) => {
                extras.extend(unrecognized);
                (ns, extras)
            }
            Err(e) => self.error(&e.text()),
        }
    }

    pub fn parse_args(&self, args: &[String]) -> Ns {
        let (ns, extras) = self.parse_known_args(args);
        if !extras.is_empty() {
            self.error(&format!("unrecognized arguments: {}", extras.join(" ")));
        }
        ns
    }

    fn parse_inner(&self, args: &[String], ns: &mut Ns, unrecognized: &mut Vec<String>) -> Result<Vec<String>, ArgErr> {
        let mut option_indices: HashMap<usize, Vec<OptTuple>> = HashMap::new();
        let mut pattern = String::new();
        let mut after_dd = false;
        for (i, s) in args.iter().enumerate() {
            if after_dd {
                pattern.push('A');
            } else if s == "--" {
                pattern.push('-');
                after_dd = true;
            } else if let Some(t) = self.parse_optional(s) {
                option_indices.insert(i, t);
                pattern.push('O');
            } else {
                pattern.push('A');
            }
        }
        let mut seen: HashSet<usize> = HashSet::new();
        let mut extras: Vec<String> = vec![];
        let mut positionals: Vec<usize> = (0..self.actions.len()).filter(|&i| self.actions[i].option_strings.is_empty()).collect();

        macro_rules! take_action {
            ($i:expr, $args:expr) => {{
                let i = $i;
                seen.insert(i);
                let v = self.get_values(&self.actions[i], $args)?;
                if !matches!(v, Values::Suppress) {
                    self.call(i, v, ns, unrecognized);
                }
            }};
        }

        let mut start = 0usize;
        let max_opt = option_indices.keys().max().map(|&m| m as isize).unwrap_or(-1);
        while (start as isize) <= max_opt {
            let mut next = start;
            while (next as isize) <= max_opt && !option_indices.contains_key(&next) {
                next += 1;
            }
            if start != next {
                let end = self.consume_positionals(start, args, &pattern, &mut positionals, &mut |i, a| {
                    take_action!(i, a);
                    Ok(())
                })?;
                if end > start {
                    start = end;
                    continue;
                }
                start = end;
            }
            if !option_indices.contains_key(&start) {
                extras.extend(args[start..next].iter().cloned());
                start = next;
            }
            // consume_optional
            let tuples = option_indices[&start].clone();
            if tuples.len() > 1 {
                let opts: Vec<&str> = tuples.iter().map(|t| t.1.as_str()).collect();
                return Err(ArgErr { name: None, msg: format!("ambiguous option: {} could match {}", args[start], opts.join(", ")) });
            }
            let (mut action, mut os, mut sep, mut explicit) = tuples[0].clone();
            let mut action_tuples: Vec<(usize, Vec<String>)> = vec![];
            let stop;
            loop {
                let Some(ai) = action else {
                    extras.push(args[start].clone());
                    stop = start + 1;
                    break;
                };
                let a = &self.actions[ai];
                if let Some(ea) = explicit.clone() {
                    let count = self.match_argument(a, "A")?;
                    if count == 0 && os.chars().nth(1) != Some('-') && !ea.is_empty() {
                        if sep.as_deref().is_some_and(|s| !s.is_empty()) || ea.starts_with('-') {
                            return Err(ArgErr::new(Some(a), format!("ignored explicit argument {}", py_repr(&ea))));
                        }
                        action_tuples.push((ai, vec![]));
                        let ch = os.chars().next().unwrap();
                        let first = ea.chars().next().unwrap();
                        os = format!("{ch}{first}");
                        let rest: String = ea.chars().skip(1).collect();
                        if let Some(a2) = self.lookup(&os) {
                            action = Some(a2);
                            if rest.is_empty() {
                                sep = None;
                                explicit = None;
                            } else if let Some(r) = rest.strip_prefix('=') {
                                sep = Some("=".into());
                                explicit = Some(r.into());
                            } else {
                                sep = Some(String::new());
                                explicit = Some(rest);
                            }
                        } else {
                            extras.push(format!("{ch}{ea}"));
                            stop = start + 1;
                            break;
                        }
                    } else if count == 1 {
                        action_tuples.push((ai, vec![ea]));
                        stop = start + 1;
                        break;
                    } else {
                        return Err(ArgErr::new(Some(a), format!("ignored explicit argument {}", py_repr(&ea))));
                    }
                } else {
                    let st = start + 1;
                    let count = self.match_argument(a, &pattern[st..])?;
                    action_tuples.push((ai, args[st..st + count].to_vec()));
                    stop = st + count;
                    break;
                }
            }
            for (ai, a) in action_tuples {
                take_action!(ai, &a);
            }
            start = stop;
        }
        let stop = self.consume_positionals(start, args, &pattern, &mut positionals, &mut |i, a| {
            take_action!(i, a);
            Ok(())
        })?;
        extras.extend(args[stop..].iter().cloned());

        let required: Vec<String> =
            self.actions.iter().enumerate().filter(|(i, a)| !seen.contains(i) && a.required).filter_map(|(_, a)| action_name(a)).collect();
        if !required.is_empty() {
            return Err(ArgErr { name: None, msg: format!("the following arguments are required: {}", required.join(", ")) });
        }
        Ok(extras)
    }

    fn consume_positionals(
        &self,
        mut start: usize,
        args: &[String],
        pattern: &str,
        positionals: &mut Vec<usize>,
        take: &mut dyn FnMut(usize, &[String]) -> Result<(), ArgErr>,
    ) -> Result<usize, ArgErr> {
        let counts = self.match_partial(positionals, &pattern[start..]);
        for (k, &count) in counts.iter().enumerate() {
            let i = positionals[k];
            let a = &self.actions[i];
            let mut v: Vec<String> = args[start..start + count].to_vec();
            if a.nargs == Nargs::Parser {
                if pattern.as_bytes().get(start) == Some(&b'-') {
                    v.remove(0);
                }
            } else if pattern[start..start + count].contains('-') {
                if let Some(p) = v.iter().position(|s| s == "--") {
                    v.remove(p);
                }
            }
            start += count;
            take(i, &v)?;
        }
        positionals.drain(..counts.len());
        Ok(start)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repr_and_int() {
        assert_eq!(py_repr("x"), "'x'");
        assert_eq!(py_repr("it's"), "\"it's\"");
        assert_eq!(py_int(" 1_0 "), Some(10));
        assert_eq!(py_int("1__0"), None);
        assert_eq!(py_int("-5"), Some(-5));
    }
}
