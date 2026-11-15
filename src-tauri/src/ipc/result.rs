use serde::Serialize;
use serde_json::{json, Value};

/// Error codes shared with `src/shared/ipc/result.ts`.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum IpcErrorCode {
    InvalidInput,
    Forbidden,
    ReadOnly,
    Unavailable,
    NotFound,
    Internal,
}

/// `{ ok: true, data }`. A value that cannot be serialized becomes a generic INTERNAL error.
pub fn ok(data: impl Serialize) -> Value {
    match serde_json::to_value(data) {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(_) => {
            log::error!("IPC response could not be serialized");
            err(IpcErrorCode::Internal, "Unexpected error")
        }
    }
}

/// `{ ok: false, error: { code, message } }`.
pub fn err(code: IpcErrorCode, message: impl Into<String>) -> Value {
    json!({ "ok": false, "error": { "code": code, "message": message.into() } })
}

/// An error a handler returns. Its code and message reach the renderer unless the code is
/// INTERNAL, which is always reported as a generic "Unexpected error"; only its coarse
/// [`kind`](Self::kind) is logged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExposedError {
    code: IpcErrorCode,
    message: String,
    kind: &'static str,
}

/// The [`ExposedError::kind`] of an error built with [`ExposedError::new`].
pub const UNSPECIFIED_KIND: &str = "unspecified";

impl ExposedError {
    /// An error whose `message` is shown to the renderer (unless `code` is INTERNAL), so it must
    /// be a fixed, user-safe text.
    pub fn new(code: IpcErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            kind: UNSPECIFIED_KIND,
        }
    }

    /// Wraps an unexpected failure. Neither the renderer nor the log ever sees `cause`'s text
    /// (it may hold tokens, URLs or paths): it is dropped here, and only its type name is kept
    /// as the [`kind`](Self::kind) to log. Even so, never build a `cause` out of secrets.
    pub fn internal<C: std::fmt::Display>(_cause: C) -> Self {
        Self {
            code: IpcErrorCode::Internal,
            message: "Unexpected error".into(),
            kind: std::any::type_name::<C>(),
        }
    }

    pub fn code(&self) -> IpcErrorCode {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }

    /// A coarse, secret-free category for the log: the cause's type for [`internal`](Self::internal)
    /// errors, [`UNSPECIFIED_KIND`] otherwise.
    pub fn kind(&self) -> &'static str {
        self.kind
    }
}

impl std::fmt::Display for ExposedError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.code {
            // An INTERNAL message built with `new` may still be a detail: never print it.
            IpcErrorCode::Internal => write!(f, "Internal ({})", self.kind),
            code => write!(f, "{code:?}: {}", self.message),
        }
    }
}

impl std::error::Error for ExposedError {}
