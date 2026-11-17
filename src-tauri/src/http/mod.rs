//! The HTTP pieces every REST integration shares (code review, Redmine and later Gmail): the
//! [`transport`], the [`common`] request/error helpers and the [`zod`]-style response checks.

pub mod common;
pub mod transport;
pub(crate) mod zod;

pub use common::{
    clip, is_redirect, map_pool, read_json, send, send_ok, send_raw, status_error, ApiError,
};
pub use transport::{
    HttpRequest, HttpResponse, Method, ReqwestTransport, Transport, TransportError, BODY_LIMIT,
    REQUEST_TIMEOUT, USER_AGENT,
};
