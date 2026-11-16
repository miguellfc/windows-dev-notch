//! Claude Code integration (port of `src/main/claude` and `src/shared/claude`).

pub mod alerts;
pub mod bridge;
pub mod bridge_config;
pub mod diff;
pub mod dpapi;
pub mod focus;
pub mod hook_events;
pub mod hook_installer;
pub mod integration;
pub mod ipc;
pub mod js_json;
pub mod permission_broker;
pub mod question_broker;
pub mod questions;
pub mod service;
pub mod session_registry;
pub mod toast;
