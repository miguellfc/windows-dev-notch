//! Gmail (port of 0.1.0's `gmail` module and `src/shared/gmail/headers.ts`): the user's own Google
//! client, OAuth, the unread count and recent list, message text, actions and the new-mail
//! alert. The IPC types live in `contract::gmail`.

pub mod auth;
pub mod client;
pub mod client_file;
pub mod headers;
mod html_text;
pub mod integration;
pub mod ipc;
pub mod loopback;
pub mod message_text;
pub mod new_mail;
pub mod token_store;
