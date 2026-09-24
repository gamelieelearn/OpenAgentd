//! Minimal pydantic-style body validation for request models with
//! `extra="forbid"` — errors are collected in field order, then extras.

use crate::error::{verr, verr_ctx, ApiError, ApiResult};
use crate::util::pydantic_bool;
use serde_json::{json, Map, Value};

pub struct Body<'a> {
    pub obj: &'a Map<String, Value>,
    pub errs: Vec<Value>,
    prefix: Vec<Value>,
}

impl<'a> Body<'a> {
    /// Require a JSON object (`model_attributes_type` otherwise).
    pub fn new(v: &'a Value) -> ApiResult<Self> {
        Self::nested(v, vec![json!("body")]).map_err(ApiError::validation)
    }

    /// Validate a nested model at `prefix` (errors are returned raw).
    pub fn nested(v: &'a Value, prefix: Vec<Value>) -> Result<Self, Vec<Value>> {
        match v {
            Value::Object(obj) => Ok(Body { obj, errs: vec![], prefix }),
            other => Err(vec![verr("model_attributes_type", &prefix, "Input should be a valid dictionary or object to extract fields from", other.clone())]),
        }
    }

    fn l(&self, k: &str) -> Vec<Value> {
        let mut v = self.prefix.clone();
        v.push(json!(k));
        v
    }

    fn l2(&self, k: &str, i: Value) -> Vec<Value> {
        let mut v = self.l(k);
        v.push(i);
        v
    }

    /// `str` with `min_length=1`.
    pub fn str_min1(&mut self, k: &str) -> String {
        let s = self.str(k, None);
        if self.obj.get(k).map(|v| v == "").unwrap_or(false) {
            let loc = self.l(k);
            self.errs.push(verr_ctx("string_too_short", &loc, "String should have at least 1 character", json!(""), json!({"min_length": 1})));
        }
        s
    }

    /// `str | None = None`.
    pub fn opt_str(&mut self, k: &str) -> Option<String> {
        match self.obj.get(k) {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(o) => {
                let loc = self.l(k);
                self.errs.push(verr("string_type", &loc, "Input should be a valid string", o.clone()));
                None
            }
        }
    }

    /// `dict[str, Any]` (default `{}`).
    pub fn dict_any(&mut self, k: &str) -> Map<String, Value> {
        match self.obj.get(k) {
            None => Map::new(),
            Some(Value::Object(m)) => m.clone(),
            Some(o) => {
                let loc = self.l(k);
                self.errs.push(verr("dict_type", &loc, "Input should be a valid dictionary", o.clone()));
                Map::new()
            }
        }
    }

    /// Collect errors (plus `extra_forbidden`) without failing.
    pub fn into_errs(mut self, allowed: &[&str]) -> Vec<Value> {
        for (k, v) in self.obj {
            if !allowed.contains(&k.as_str()) {
                let loc = self.l(k);
                self.errs.push(verr("extra_forbidden", &loc, "Extra inputs are not permitted", v.clone()));
            }
        }
        self.errs
    }

    fn missing(&mut self, k: &str) {
        self.errs.push(verr("missing", &self.l(k), "Field required", Value::Object(self.obj.clone())));
    }

    pub fn str(&mut self, k: &str, default: Option<&str>) -> String {
        match self.obj.get(k) {
            None => match default {
                Some(d) => d.to_string(),
                None => {
                    self.missing(k);
                    String::new()
                }
            },
            Some(Value::String(s)) => s.clone(),
            Some(o) => {
                self.errs.push(verr("string_type", &self.l(k), "Input should be a valid string", o.clone()));
                String::new()
            }
        }
    }

    pub fn bool(&mut self, k: &str, default: Option<bool>) -> bool {
        match self.obj.get(k) {
            None => match default {
                Some(d) => d,
                None => {
                    self.missing(k);
                    false
                }
            },
            Some(Value::Bool(b)) => *b,
            Some(Value::Number(n)) if n.as_f64() == Some(0.0) || n.as_f64() == Some(1.0) => n.as_f64() == Some(1.0),
            Some(Value::String(s)) if pydantic_bool(s).is_some() => pydantic_bool(s).unwrap(),
            Some(o @ (Value::String(_) | Value::Number(_))) => {
                self.errs.push(verr("bool_parsing", &self.l(k), "Input should be a valid boolean, unable to interpret input", o.clone()));
                false
            }
            Some(o) => {
                self.errs.push(verr("bool_type", &self.l(k), "Input should be a valid boolean", o.clone()));
                false
            }
        }
    }

    pub fn float(&mut self, k: &str, default: f64) -> f64 {
        match self.obj.get(k) {
            None => default,
            Some(Value::Number(n)) => n.as_f64().unwrap_or(default),
            Some(Value::Bool(b)) => f64::from(u8::from(*b)),
            Some(Value::String(s)) => match s.trim().parse::<f64>() {
                Ok(f) => f,
                Err(_) => {
                    self.errs.push(verr("float_parsing", &self.l(k), "Input should be a valid number, unable to parse string as a number", json!(s)));
                    default
                }
            },
            Some(o) => {
                self.errs.push(verr("float_type", &self.l(k), "Input should be a valid number", o.clone()));
                default
            }
        }
    }

    /// `int | None = None`.
    pub fn opt_int(&mut self, k: &str) -> Option<i64> {
        match self.obj.get(k) {
            None | Some(Value::Null) => None,
            Some(Value::Number(n)) => match n.as_i64().or_else(|| n.as_f64().filter(|f| f.fract() == 0.0).map(|f| f as i64)) {
                Some(i) => Some(i),
                None => {
                    self.errs.push(verr("int_from_float", &self.l(k), "Input should be a valid integer, got a number with a fractional part", Value::Number(n.clone())));
                    None
                }
            },
            Some(Value::String(s)) => match s.trim().parse::<i64>() {
                Ok(i) => Some(i),
                Err(_) => {
                    self.errs.push(verr("int_parsing", &self.l(k), "Input should be a valid integer, unable to parse string as an integer", json!(s)));
                    None
                }
            },
            Some(Value::Bool(b)) => Some(i64::from(*b)),
            Some(o) => {
                self.errs.push(verr("int_type", &self.l(k), "Input should be a valid integer", o.clone()));
                None
            }
        }
    }

    pub fn list_str(&mut self, k: &str) -> Vec<String> {
        match self.obj.get(k) {
            None => vec![],
            Some(Value::Array(a)) => {
                let mut out = vec![];
                for (i, x) in a.iter().enumerate() {
                    match x {
                        Value::String(s) => out.push(s.clone()),
                        o => self.errs.push(verr("string_type", &self.l2(k, json!(i)), "Input should be a valid string", o.clone())),
                    }
                }
                out
            }
            Some(o) => {
                self.errs.push(verr("list_type", &self.l(k), "Input should be a valid list", o.clone()));
                vec![]
            }
        }
    }

    /// `dict[str, str]` preserving JSON order.
    pub fn dict_str(&mut self, k: &str) -> Vec<(String, String)> {
        match self.obj.get(k) {
            None => vec![],
            Some(Value::Object(m)) => {
                let mut out = vec![];
                for (key, x) in m {
                    match x {
                        Value::String(s) => out.push((key.clone(), s.clone())),
                        o => self.errs.push(verr("string_type", &self.l2(k, json!(key)), "Input should be a valid string", o.clone())),
                    }
                }
                out
            }
            Some(o) => {
                self.errs.push(verr("dict_type", &self.l(k), "Input should be a valid dictionary", o.clone()));
                vec![]
            }
        }
    }

    pub fn value_error(&mut self, k: &str, msg: &str, input: Value) {
        self.errs.push(verr_ctx("value_error", &self.l(k), &format!("Value error, {msg}"), input, json!({"error": {}})));
    }

    /// Finish: append `extra_forbidden` items for unknown keys.
    pub fn finish(self, allowed: &[&str]) -> ApiResult<()> {
        let errs = self.into_errs(allowed);
        if errs.is_empty() {
            Ok(())
        } else {
            Err(ApiError::validation(errs))
        }
    }
}
