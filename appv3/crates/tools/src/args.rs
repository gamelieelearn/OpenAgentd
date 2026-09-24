//! Pydantic-flavoured argument extraction with v2's alias choices and
//! lax coercion. Errors read like `format_validation_error` output.

use crate::ToolError;
use serde_json::Value;

pub struct Args<'a> {
    pub tool: &'a str,
    pub v: &'a Value,
    errors: Vec<String>,
}

impl<'a> Args<'a> {
    pub fn new(tool: &'a str, v: &'a Value) -> Self {
        Self { tool, v, errors: vec![] }
    }

    fn get(&self, names: &[&str]) -> Option<&'a Value> {
        let obj = self.v.as_object()?;
        names.iter().find_map(|n| obj.get(*n))
    }

    pub fn raw(&self, names: &[&str]) -> Option<&'a Value> {
        self.get(names)
    }

    pub fn err(&mut self, loc: &str, msg: &str) {
        if loc.is_empty() {
            self.errors.push(msg.to_string());
        } else {
            self.errors.push(format!("{loc}: {msg}"));
        }
    }

    pub fn req_str(&mut self, names: &[&str]) -> String {
        match self.get(names) {
            None => {
                self.err(names[0], "Field required");
                String::new()
            }
            Some(Value::String(s)) => s.clone(),
            Some(_) => {
                self.err(names[0], "Input should be a valid string");
                String::new()
            }
        }
    }

    pub fn opt_str(&mut self, names: &[&str]) -> Option<String> {
        match self.get(names) {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(_) => {
                self.err(names[0], "Input should be a valid string");
                None
            }
        }
    }

    pub fn str_or(&mut self, names: &[&str], default: &str) -> String {
        match self.get(names) {
            None => default.to_string(),
            Some(Value::String(s)) => s.clone(),
            Some(_) => {
                self.err(names[0], "Input should be a valid string");
                default.to_string()
            }
        }
    }

    /// Lax int with v2's numeric-string repair (`"180, "` → 180).
    pub fn opt_int(&mut self, names: &[&str], ge: Option<i64>, le: Option<i64>) -> Option<i64> {
        let v = match self.get(names) {
            None | Some(Value::Null) => return None,
            Some(v) => v,
        };
        let parsed = match v {
            Value::Number(n) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)),
            Value::Bool(b) => Some(*b as i64),
            Value::String(s) => {
                let t = s.trim();
                t.parse::<i64>().ok().or_else(|| t.trim_end_matches(',').trim().parse::<i64>().ok())
            }
            _ => None,
        };
        match parsed {
            None => {
                let msg = if v.is_string() { "Input should be a valid integer, unable to parse string as an integer" } else { "Input should be a valid integer" };
                self.err(names[0], msg);
                None
            }
            Some(n) => {
                if let Some(g) = ge {
                    if n < g {
                        self.err(names[0], &format!("Input should be greater than or equal to {g}"));
                    }
                }
                if let Some(l) = le {
                    if n > l {
                        self.err(names[0], &format!("Input should be less than or equal to {l}"));
                    }
                }
                Some(n)
            }
        }
    }

    pub fn bool_or(&mut self, names: &[&str], default: bool) -> bool {
        match self.get(names) {
            None | Some(Value::Null) => default,
            Some(v) => match coerce_bool(v) {
                Some(b) => b,
                None => {
                    self.err(names[0], "Input should be a valid boolean");
                    default
                }
            },
        }
    }

    pub fn literal(&mut self, names: &[&str], allowed: &[&str], default: &str) -> String {
        let s = self.str_or(names, default);
        if !allowed.contains(&s.as_str()) {
            let quoted: Vec<String> = allowed.iter().map(|a| format!("'{a}'")).collect();
            let list = if quoted.len() > 1 { format!("{} or {}", quoted[..quoted.len() - 1].join(", "), quoted[quoted.len() - 1]) } else { quoted.join("") };
            self.err(names[0], &format!("Input should be {list}"));
        }
        s
    }

    pub fn finish(self) -> Result<(), ToolError> {
        if self.errors.is_empty() {
            Ok(())
        } else {
            Err(ToolError::Argument(format!("Invalid arguments for tool '{}': {}", self.tool, self.errors.join("; "))))
        }
    }
}

pub fn coerce_bool(v: &Value) -> Option<bool> {
    match v {
        Value::Bool(b) => Some(*b),
        Value::Number(n) => match n.as_f64() {
            Some(0.0) => Some(false),
            Some(1.0) => Some(true),
            _ => None,
        },
        Value::String(s) => match s.trim().to_lowercase().as_str() {
            "true" | "1" | "yes" | "on" | "t" | "y" => Some(true),
            "false" | "0" | "no" | "off" | "f" | "n" => Some(false),
            _ => None,
        },
        _ => None,
    }
}
