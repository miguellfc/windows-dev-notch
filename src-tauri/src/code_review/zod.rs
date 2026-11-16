//! zod's rules for the API responses, checked by hand on a [`serde_json::Value`] (shared by the
//! GitHub and GitLab clients).
//!
//! Unknown fields are ignored; `optional` means "absent" (a `null` there reaches the inner schema
//! and fails), `nullable().optional()` takes both; `z.int()` takes any safe integer, including one
//! written as an integral float (`12.0`, `1e2`). Parsing to a `Value` also keeps the last of
//! duplicate keys, as `JSON.parse` does (a typed serde struct would reject the duplicate).

use serde_json::{Map, Value};

use super::client::CodeReviewError;
use crate::contract::MAX_SAFE_INTEGER;

pub(super) type Obj = Map<String, Value>;
pub(super) type Parsed<T> = Result<T, CodeReviewError>;

pub(super) const fn invalid<T>() -> Parsed<T> {
    Err(CodeReviewError::InvalidResponse)
}

/// `z.object(...)` on a value: a plain object, else the schema fails.
pub(super) fn object(value: &Value) -> Parsed<&Obj> {
    value.as_object().ok_or(CodeReviewError::InvalidResponse)
}

/// A required field (`undefined` fails every non-optional schema).
pub(super) fn required<'a>(object: &'a Obj, key: &str) -> Parsed<&'a Value> {
    object.get(key).ok_or(CodeReviewError::InvalidResponse)
}

/// `.optional()`: only an absent key is "no value" (a `null` reaches the inner schema).
pub(super) fn optional<'a>(object: &'a Obj, key: &str) -> Option<&'a Value> {
    object.get(key)
}

/// `.nullable().optional()`: absent or `null` is "no value".
pub(super) fn nullish<'a>(object: &'a Obj, key: &str) -> Option<&'a Value> {
    object.get(key).filter(|value| !value.is_null())
}

pub(super) fn string(value: &Value) -> Parsed<&str> {
    value.as_str().ok_or(CodeReviewError::InvalidResponse)
}

pub(super) fn boolean(value: &Value) -> Parsed<bool> {
    value.as_bool().ok_or(CodeReviewError::InvalidResponse)
}

/// `z.int()`: a safe integer, also when written as an integral float (`12.0` parses to 12).
pub(super) fn int(value: &Value) -> Parsed<i64> {
    let Value::Number(number) = value else {
        return invalid();
    };
    let safe = |n: i64| n.unsigned_abs() <= MAX_SAFE_INTEGER;
    if let Some(n) = number.as_i64() {
        return if safe(n) { Ok(n) } else { invalid() };
    }
    if number.as_u64().is_some() {
        return invalid(); // above i64::MAX, far beyond a safe integer
    }
    match number.as_f64() {
        #[allow(
            clippy::cast_possible_truncation,
            clippy::cast_precision_loss,
            reason = "integral and within MAX_SAFE_INTEGER, so exact"
        )]
        Some(f) if f.fract() == 0.0 && f.abs() <= MAX_SAFE_INTEGER as f64 => Ok(f as i64),
        _ => invalid(),
    }
}

/// `z.int().min(0)`.
pub(super) fn count(value: &Value) -> Parsed<u64> {
    u64::try_from(int(value)?).map_err(|_| CodeReviewError::InvalidResponse)
}

pub(super) fn array(value: &Value) -> Parsed<&Vec<Value>> {
    value.as_array().ok_or(CodeReviewError::InvalidResponse)
}
