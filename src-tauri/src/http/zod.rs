//! zod's rules for the API responses, checked by hand on a [`serde_json::Value`] (shared by the
//! GitHub, GitLab and Redmine clients).
//!
//! Unknown fields are ignored; `optional` means "absent" (a `null` there reaches the inner schema
//! and fails), `nullable().optional()` takes both; `z.int()` takes any safe integer, including one
//! written as an integral float (`12.0`, `1e2`). Parsing to a `Value` also keeps the last of
//! duplicate keys, as `JSON.parse` does (a typed serde struct would reject the duplicate).

use serde_json::{Map, Value};

use super::common::ApiError;
use crate::contract::MAX_SAFE_INTEGER;

pub(crate) type Obj = Map<String, Value>;
pub(crate) type Parsed<T> = Result<T, ApiError>;

pub(crate) const fn invalid<T>() -> Parsed<T> {
    Err(ApiError::InvalidResponse)
}

/// `z.object(...)` on a value: a plain object, else the schema fails.
pub(crate) fn object(value: &Value) -> Parsed<&Obj> {
    value.as_object().ok_or(ApiError::InvalidResponse)
}

/// A required field (`undefined` fails every non-optional schema).
pub(crate) fn required<'a>(object: &'a Obj, key: &str) -> Parsed<&'a Value> {
    object.get(key).ok_or(ApiError::InvalidResponse)
}

/// `.optional()`: only an absent key is "no value" (a `null` reaches the inner schema).
pub(crate) fn optional<'a>(object: &'a Obj, key: &str) -> Option<&'a Value> {
    object.get(key)
}

/// `.nullable().optional()`: absent or `null` is "no value".
pub(crate) fn nullish<'a>(object: &'a Obj, key: &str) -> Option<&'a Value> {
    object.get(key).filter(|value| !value.is_null())
}

pub(crate) fn string(value: &Value) -> Parsed<&str> {
    value.as_str().ok_or(ApiError::InvalidResponse)
}

pub(crate) fn boolean(value: &Value) -> Parsed<bool> {
    value.as_bool().ok_or(ApiError::InvalidResponse)
}

/// `z.int()`: a safe integer, also when written as an integral float (`12.0` parses to 12).
pub(crate) fn int(value: &Value) -> Parsed<i64> {
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
pub(crate) fn count(value: &Value) -> Parsed<u64> {
    u64::try_from(int(value)?).map_err(|_| ApiError::InvalidResponse)
}

/// `z.number()`: a finite number (zod 4 refuses `Infinity` and `NaN`), integers included.
pub(crate) fn number(value: &Value) -> Parsed<f64> {
    match value.as_f64() {
        Some(n) if n.is_finite() => Ok(n),
        _ => invalid(),
    }
}

/// `z.number().min(0)`.
pub(crate) fn non_negative(value: &Value) -> Parsed<f64> {
    let n = number(value)?;
    if n >= 0.0 {
        Ok(n)
    } else {
        invalid()
    }
}

pub(crate) fn array(value: &Value) -> Parsed<&Vec<Value>> {
    value.as_array().ok_or(ApiError::InvalidResponse)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn number_takes_finite_numbers_only() {
        assert_eq!(number(&json!(1.5)), Ok(1.5));
        assert_eq!(number(&json!(3)), Ok(3.0));
        assert_eq!(number(&json!(-2)), Ok(-2.0));
        assert_eq!(number(&json!(0)), Ok(0.0));
        assert_eq!(number(&json!(u64::MAX)), Ok(18_446_744_073_709_551_615.0));
        assert_eq!(number(&json!(f64::MAX)), Ok(f64::MAX));
        for bad in [
            json!("1"),
            json!(null),
            json!(true),
            json!([1]),
            json!({ "n": 1 }),
        ] {
            assert_eq!(number(&bad), Err(ApiError::InvalidResponse), "{bad}");
        }
        // serde_json stores a non-finite float as `null`, and refuses one in a body.
        assert_eq!(
            number(&json!(f64::INFINITY)),
            Err(ApiError::InvalidResponse)
        );
        assert_eq!(number(&json!(f64::NAN)), Err(ApiError::InvalidResponse));
        assert!(serde_json::from_str::<Value>("1e400").is_err());
    }

    #[test]
    fn non_negative_refuses_values_below_zero() {
        assert_eq!(non_negative(&json!(0)), Ok(0.0));
        assert_eq!(non_negative(&json!(-0.0)), Ok(0.0));
        assert_eq!(non_negative(&json!(2.25)), Ok(2.25));
        assert_eq!(non_negative(&json!(-0.01)), Err(ApiError::InvalidResponse));
        assert_eq!(non_negative(&json!(-1)), Err(ApiError::InvalidResponse));
        assert_eq!(non_negative(&json!("2")), Err(ApiError::InvalidResponse));
        assert_eq!(non_negative(&json!(null)), Err(ApiError::InvalidResponse));
    }
}
