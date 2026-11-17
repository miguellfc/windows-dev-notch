//! GitHub and self-hosted GitLab code review (port of `src/main/code-review` and
//! `src/shared/code-review`).

pub mod client;
pub mod contributions;
pub mod detector;
pub mod github;
pub mod gitlab;
pub mod integration;
pub mod ipc;

/// The shared HTTP transport, under its part 4 path.
pub use crate::http::transport as http;
/// The shared zod-style response checks, under their part 4 path.
use crate::http::zod;
