//! The work log: each Claude Code session of the chosen account, measured from its hook events
//! ([`timing`]), kept in `work-log.json` ([`service`]) and served on the `work-log:*` channels
//! ([`ipc`]).

pub mod copy;
pub mod duration;
pub mod ipc;
pub mod service;
pub mod timing;
