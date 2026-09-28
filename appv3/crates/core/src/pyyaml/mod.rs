//! PyYAML-compatible YAML: `safe_load` ([`load`], a port of PyYAML's
//! pure-Python SafeLoader) and `safe_dump` ([`dump`], a port of its
//! SafeRepresenter/Serializer/Emitter). Both matched PyYAML 6.0.3
//! byte-for-byte in differential fuzzing (see `appv3/REPORT.md`).

mod dump;
mod load;

pub use dump::safe_dump_py;
pub use load::{safe_load, safe_load_py, LoadError, Py, PyDateTime};
use serde_json::Value;

/// JSON → the Python object `json.loads` would build.
pub fn py_from_json(v: &Value) -> Py {
    match v {
        Value::Null => Py::None,
        Value::Bool(b) => Py::Bool(*b),
        Value::Number(n) => match (n.as_i64(), n.as_u64()) {
            (Some(i), _) => Py::Int(i as i128),
            (None, Some(u)) => Py::Int(u as i128),
            _ => Py::Float(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => Py::Str(s.clone()),
        Value::Array(a) => Py::List(a.iter().map(py_from_json).collect()),
        Value::Object(o) => Py::Dict(o.iter().map(|(k, x)| (Py::Str(k.clone()), py_from_json(x))).collect()),
    }
}

/// `yaml.safe_dump(value, sort_keys=False)` for a JSON value.
pub fn safe_dump(v: &Value) -> String {
    safe_dump_py(&py_from_json(v))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn loads_yaml_1_1() {
        // Expected values from PyYAML 6 `yaml.safe_load`.
        let v = safe_load("a: yes\nb: 012\nc: 1:30\nd: 0x1F\ne: 1e5\nf: 1.5e+3\ng: ~\nh: 2024-01-02\ni: Off\nj: '1'").unwrap();
        assert_eq!(v, json!({"a": true, "b": 10, "c": 90, "d": 31, "e": "1e5", "f": 1500.0, "g": null, "h": "2024-01-02", "i": false, "j": "1"}));
        let v = safe_load("base: &b {x: 1, y: 2}\nd:\n  <<: *b\n  y: 3\n1: one\ntrue: t").unwrap();
        assert_eq!(v, json!({"base": {"x": 1, "y": 2}, "d": {"x": 1, "y": 3}, "1": "t"}), "True == 1: PyYAML keeps the first key, last value");
        let e = safe_load("a: b: c").unwrap_err();
        assert_eq!(e.kind, "ScannerError");
        assert_eq!(e.message, "mapping values are not allowed here\n  in \"<unicode string>\", line 1, column 5:\n    a: b: c\n        ^");
        let e = safe_load("d: 2024-13-01").unwrap_err();
        assert_eq!((e.kind, e.message.as_str(), e.is_yaml_error()), ("ValueError", "month must be in 1..12, not 13", false));
        assert_eq!(safe_load_py("").unwrap(), Py::None);
    }

    #[test]
    fn matches_pyyaml() {
        // Expected strings produced by PyYAML 6 `yaml.safe_dump(v, sort_keys=False)`.
        let v = json!({"image": {"model": "googlegenai:gemini-3.1-flash-image-preview", "aspect_ratio": "1:1", "image_size": "1K"},
            "video": {"resolution": "720p", "duration_seconds": "8"}});
        assert_eq!(
            safe_dump(&v),
            "image:\n  model: googlegenai:gemini-3.1-flash-image-preview\n  aspect_ratio: '1:1'\n  image_size: 1K\nvideo:\n  resolution: 720p\n  duration_seconds: '8'\n"
        );
        assert_eq!(safe_dump(&json!({"denied_patterns": ["**/.env", "**/.env.*"]})), "denied_patterns:\n- '**/.env'\n- '**/.env.*'\n");
        assert_eq!(
            safe_dump(&json!({"a": [], "b": {}, "c": null, "d": true, "e": 3.0, "f": 1e-5, "g": "yes", "h": "", "i": "it's"})),
            "a: []\nb: {}\nc: null\nd: true\ne: 3.0\nf: 1.0e-05\ng: 'yes'\nh: ''\ni: it's\n"
        );
        assert_eq!(safe_dump(&json!({"l": [{"x": 1, "y": [1, 2]}]})), "l:\n- x: 1\n  y:\n  - 1\n  - 2\n");
        assert_eq!(
            safe_dump(&json!({"sp": " x", "col": "x:", "q2": "say \"hi\"", "at": "@x", "dash": "-x", "n1": "1.5", "tl": "~"})),
            "sp: ' x'\ncol: 'x:'\nq2: say \"hi\"\nat: '@x'\ndash: -x\nn1: '1.5'\ntl: '~'\n"
        );
        assert_eq!(
            safe_dump(&json!({"k": "a: b", "m": "- x", "n": "#c", "o": "x #y", "p": "2024-01-01", "q": "0o7", "r": "012"})),
            "k: 'a: b'\nm: '- x'\nn: '#c'\no: 'x #y'\np: '2024-01-01'\nq: 0o7\nr: '012'\n"
        );
    }
}
