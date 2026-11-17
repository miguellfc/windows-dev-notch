//! `JSON.stringify` (compact, or with `null, 2` indentation) of a parsed JSON value, byte for byte as V8 writes it: the
//! permission preview and the bodies Claude reads back must match Electron's.
//!
//! Differences from `serde_json::to_string` this handles:
//! - object keys that are array indices (`"0"`, `"7"`, not `"07"`, below 2^32 - 1) come first in
//!   ascending numeric order, as in every JS object; the other keys keep their insertion order
//!   (serde_json's `preserve_order`);
//! - numbers are JS numbers: `1.0` is `1`, `-0` is `0`, `1e21` is `1e+21`, and integers beyond
//!   2^53 are rounded to the nearest double, as `JSON.parse` would have done.
//!
//! String escaping already agrees with serde_json (only `"`, `\` and C0 controls are escaped, with
//! lowercase `\u00xx`; `/`, U+2028/U+2029 and non-ASCII stay raw) and is written here as well.

use std::fmt::Write as _;

use serde_json::{Map, Value};

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

/// `JSON.stringify(object)` for an object already held as a map.
pub fn stringify_object(object: &Map<String, Value>) -> String {
    let mut out = String::new();
    write_object(&mut out, object);
    out
}

/// `JSON.stringify(value, null, 2)`: two-space indentation, `": "` after keys, `[]`/`{}` for
/// empty containers, and the same key order, numbers and escaping as [`stringify`].
pub fn stringify_pretty(value: &Value) -> String {
    let mut out = String::new();
    write_pretty(&mut out, value, 0);
    out
}

fn write_pretty(out: &mut String, value: &Value, depth: usize) {
    match value {
        Value::Array(items) if !items.is_empty() => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                out.push_str(if index > 0 { ",\n" } else { "\n" });
                indent(out, depth + 1);
                write_pretty(out, item, depth + 1);
            }
            out.push('\n');
            indent(out, depth);
            out.push(']');
        }
        Value::Object(object) if !object.is_empty() => {
            out.push('{');
            for (position, (key, item)) in js_entries(object).into_iter().enumerate() {
                out.push_str(if position > 0 { ",\n" } else { "\n" });
                indent(out, depth + 1);
                write_string(out, key);
                out.push_str(": ");
                write_pretty(out, item, depth + 1);
            }
            out.push('\n');
            indent(out, depth);
            out.push('}');
        }
        other => write_value(out, other),
    }
}

fn indent(out: &mut String, depth: usize) {
    for _ in 0..depth {
        out.push_str("  ");
    }
}

/// The entries of `object` in JS property order: array indices ascending, then the rest in
/// insertion order.
fn js_entries(object: &Map<String, Value>) -> Vec<(&String, &Value)> {
    let mut indexed: Vec<(u32, &String, &Value)> = Vec::new();
    let mut named: Vec<(&String, &Value)> = Vec::new();
    for (key, value) in object {
        match array_index(key) {
            Some(index) => indexed.push((index, key, value)),
            None => named.push((key, value)),
        }
    }
    indexed.sort_by_key(|&(index, _, _)| index);
    indexed
        .into_iter()
        .map(|(_, key, value)| (key, value))
        .chain(named)
        .collect()
}

fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Value::Number(number) => write_number(out, number),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(object) => write_object(out, object),
    }
}

fn write_object(out: &mut String, object: &Map<String, Value>) {
    out.push('{');
    for (position, (key, value)) in js_entries(object).into_iter().enumerate() {
        if position > 0 {
            out.push(',');
        }
        write_string(out, key);
        out.push(':');
        write_value(out, value);
    }
    out.push('}');
}

/// A canonical array index (`ToString(ToUint32(key)) === key` and below 2^32 - 1).
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key.starts_with('0')) {
        return None;
    }
    if !key.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let index: u64 = key.parse().ok()?;
    u32::try_from(index).ok().filter(|&index| index != u32::MAX)
}

fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            control if u32::from(control) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(control));
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

fn write_number(out: &mut String, number: &serde_json::Number) {
    // Every JSON number is a double in JS; serde_json only keeps wider integers exactly.
    let value = number.as_f64().unwrap_or(0.0);
    out.push_str(&js_number(value));
}

/// `Number.prototype.toString()` of a finite double (ECMA-262 Number::toString, radix 10).
fn js_number(value: f64) -> String {
    if value == 0.0 {
        return "0".into();
    }
    let sign = if value < 0.0 { "-" } else { "" };
    // Rust's `{:e}` writes the shortest digits that round-trip, as JS does: `d.ddde±x`.
    let formatted = format!("{:e}", value.abs());
    let (mantissa, exponent) = formatted
        .split_once('e')
        .expect("`{:e}` always writes an exponent");
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let exponent: i64 = exponent.parse().expect("`{:e}` writes an integer exponent");
    let k = i64::try_from(digits.len()).expect("a double has few digits");
    // value = 0.digits * 10^n
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!(
            "{digits}{}",
            "0".repeat(usize::try_from(n - k).unwrap_or(0))
        )
    } else if 0 < n && n <= 21 {
        let (whole, fraction) = digits.split_at(usize::try_from(n).unwrap_or(0));
        format!("{whole}.{fraction}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat(usize::try_from(-n).unwrap_or(0)))
    } else {
        let exponent_sign = if n - 1 < 0 { '-' } else { '+' };
        let magnitude = (n - 1).abs();
        let (first, rest) = digits.split_at(1);
        if rest.is_empty() {
            format!("{first}e{exponent_sign}{magnitude}")
        } else {
            format!("{first}.{rest}e{exponent_sign}{magnitude}")
        }
    };
    format!("{sign}{body}")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn writes_compact_json_in_insertion_order() {
        let value: Value = serde_json::from_str(
            r#"{"file_path":"/fake/a.ts","content":"evil();","n":[1,true,null]}"#,
        )
        .unwrap();
        assert_eq!(
            stringify(&value),
            r#"{"file_path":"/fake/a.ts","content":"evil();","n":[1,true,null]}"#
        );
        assert_eq!(stringify(&json!({})), "{}");
        assert_eq!(stringify(&json!("x")), r#""x""#);
    }

    #[test]
    fn puts_array_index_keys_first_like_js_objects() {
        // JSON.stringify(JSON.parse('{"b":1,"1":2,"01":3,"4294967295":4,"4294967294":5,"0":6}'))
        let value: Value =
            serde_json::from_str(r#"{"b":1,"1":2,"01":3,"4294967295":4,"4294967294":5,"0":6}"#)
                .unwrap();
        assert_eq!(
            stringify(&value),
            r#"{"0":6,"1":2,"4294967294":5,"b":1,"01":3,"4294967295":4}"#
        );
    }

    #[test]
    fn escapes_like_js() {
        let text = "q\"b\\s/\u{8}\u{c}\n\r\t\u{0}\u{1b}\u{1f}\u{7f}\u{85}\u{2028}\u{2029}é😀";
        assert_eq!(
            stringify(&json!(text)),
            "\"q\\\"b\\\\s/\\b\\f\\n\\r\\t\\u0000\\u001b\\u001f\u{7f}\u{85}\u{2028}\u{2029}é😀\""
        );
        // serde_json agrees on strings, U+2028/U+2029 included (JS leaves them raw since ES2019).
        assert_eq!(
            serde_json::to_string(&json!(text)).unwrap(),
            stringify(&json!(text))
        );
    }

    #[test]
    fn writes_numbers_like_js() {
        // JSON.stringify([1e21,1e-7,123e-20,0.1,-0,1.5e300,2**53+2,1.0,-2.5,123456789012,1e-6,100])
        let value: Value = serde_json::from_str(
            "[1e21,1e-7,123e-20,0.1,-0,1.5e300,9007199254740994,1.0,-2.5,123456789012,1e-6,100,-0.0,12345678901234567890]",
        )
        .unwrap();
        assert_eq!(
            stringify(&value),
            "[1e+21,1e-7,1.23e-18,0.1,0,1.5e+300,9007199254740994,1,-2.5,123456789012,0.000001,100,0,12345678901234567000]"
        );
    }

    #[test]
    fn writes_pretty_json_like_js() {
        // JSON.stringify(JSON.parse(text), null, 2)
        let value: Value = serde_json::from_str(
            r#"{"b":[],"1":{},"a":[1,{"x":null,"y":[true,"s"]}],"0":1.0,"e":{"k":[[]]}}"#,
        )
        .unwrap();
        assert_eq!(
            stringify_pretty(&value),
            "{\n  \"0\": 1,\n  \"1\": {},\n  \"b\": [],\n  \"a\": [\n    1,\n    {\n      \"x\": null,\n      \"y\": [\n        true,\n        \"s\"\n      ]\n    }\n  ],\n  \"e\": {\n    \"k\": [\n      []\n    ]\n  }\n}"
        );
        assert_eq!(stringify_pretty(&json!([])), "[]");
        assert_eq!(stringify_pretty(&json!({})), "{}");
        assert_eq!(stringify_pretty(&json!("a\nb")), "\"a\\nb\"");
        assert_eq!(stringify_pretty(&json!(-0.0)), "0");
    }
}
