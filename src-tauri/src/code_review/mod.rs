//! GitHub and self-hosted GitLab code review (port of `src/main/code-review` and
//! `src/shared/code-review`).

pub mod client;
pub mod contributions;
pub mod detector;
pub mod github;
pub mod gitlab;
pub mod http;
pub mod integration;
pub mod ipc;
mod zod;
