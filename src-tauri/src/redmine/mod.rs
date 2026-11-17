//! Redmine (port of `src/main/redmine` and `src/shared/redmine`): the REST client, the hours
//! summary, the end-of-day alert and the integration state machine, the twelve `redmine:*`
//! channels and the end-of-day wiring to the capsule and the power events.

pub mod alert;
pub mod client;
pub mod end_of_day;
pub mod integration;
pub mod ipc;
pub mod summary;
