//! The twelve `redmine:*` channels (port of 0.1.0's `redmine-ipc.ts`).
//! Guards live in `ipc::GUARDS`: issues, writes, the summary, the view signal and the browser
//! opener belong to the notch; the server and the key to the Control Center; the state to both.
//! `get-state`, `view`, `refresh` and `open` wait here for the stored key to load, so the first
//! state is never a guess; every other call waits inside the integration.
//!
//! Like Electron's dispatcher, an output that does not match the contract (a key in the state, a
//! URL in an issue, a subject too long) never leaves: it becomes INTERNAL. A refused write and a
//! refused key are results (`{ok: false, reason}`), returned as data.

use std::sync::{Arc, OnceLock};

use chrono::TimeZone;
use serde::Serialize;
use serde_json::Value;

use super::integration::{RedmineIntegration, LOG_TARGET};
use crate::contract::redmine::{
    LogTimeInput, RedmineActivity, RedmineIdInput, RedmineIssueDetail, RedmineIssueList,
    RedmineSetKeyResult, RedmineState, RedmineSummaryResult, RedmineViewInput, RedmineWriteResult,
    SetKeyInput, UpdateIssueInput,
};
use crate::contract::{check, Direction};
use crate::ipc::{no_input, BoxFuture, Channel, Ctx, ExposedError, IpcErrorCode, Registry};

/// What the channels need from the integration (`Pick<RedmineIntegration, ...>`).
pub trait RedmineApi: Send + Sync {
    /// Resolves once the stored key was read.
    fn ready(&self) -> BoxFuture<'_, ()>;
    fn state(&self) -> RedmineState;
    fn issues(&self) -> BoxFuture<'_, RedmineIssueList>;
    /// UNAVAILABLE when there is no usable session.
    fn issue(&self, id: u64) -> BoxFuture<'_, Result<RedmineIssueDetail, ExposedError>>;
    /// UNAVAILABLE when there is no usable session.
    fn activities(&self) -> BoxFuture<'_, Result<Vec<RedmineActivity>, ExposedError>>;
    fn update_issue(&self, input: UpdateIssueInput) -> BoxFuture<'_, RedmineWriteResult>;
    fn log_time(&self, input: LogTimeInput) -> BoxFuture<'_, RedmineWriteResult>;
    fn summary(&self) -> BoxFuture<'_, RedmineSummaryResult>;
    fn set_view_open(&self, open: bool);
    fn refresh(&self);
    /// INVALID_INPUT "Unknown issue" / "Issue URL not allowed".
    fn open(&self, id: u64) -> Result<(), ExposedError>;
    fn set_key(&self, url: String, key: String) -> BoxFuture<'_, RedmineSetKeyResult>;
    fn clear(&self) -> BoxFuture<'_, ()>;
}

impl<Tz> RedmineApi for RedmineIntegration<Tz>
where
    Tz: TimeZone + Send + Sync + 'static,
    Tz::Offset: Send + Sync,
{
    fn ready(&self) -> BoxFuture<'_, ()> {
        Box::pin(RedmineIntegration::ready(self))
    }

    fn state(&self) -> RedmineState {
        RedmineIntegration::state(self)
    }

    fn issues(&self) -> BoxFuture<'_, RedmineIssueList> {
        Box::pin(RedmineIntegration::issues(self))
    }

    fn issue(&self, id: u64) -> BoxFuture<'_, Result<RedmineIssueDetail, ExposedError>> {
        Box::pin(RedmineIntegration::issue(self, id))
    }

    fn activities(&self) -> BoxFuture<'_, Result<Vec<RedmineActivity>, ExposedError>> {
        Box::pin(RedmineIntegration::activities(self))
    }

    fn update_issue(&self, input: UpdateIssueInput) -> BoxFuture<'_, RedmineWriteResult> {
        Box::pin(RedmineIntegration::update_issue(self, input))
    }

    fn log_time(&self, input: LogTimeInput) -> BoxFuture<'_, RedmineWriteResult> {
        Box::pin(RedmineIntegration::log_time(self, input))
    }

    fn summary(&self) -> BoxFuture<'_, RedmineSummaryResult> {
        Box::pin(RedmineIntegration::summary(self))
    }

    fn set_view_open(&self, open: bool) {
        RedmineIntegration::set_view_open(self, open);
    }

    fn refresh(&self) {
        RedmineIntegration::refresh(self);
    }

    fn open(&self, id: u64) -> Result<(), ExposedError> {
        RedmineIntegration::open(self, id)
    }

    fn set_key(&self, url: String, key: String) -> BoxFuture<'_, RedmineSetKeyResult> {
        Box::pin(async move { RedmineIntegration::set_key(self, &url, &key).await })
    }

    fn clear(&self) -> BoxFuture<'_, ()> {
        Box::pin(RedmineIntegration::clear(self))
    }
}

/// Filled in `setup`; the channels answer UNAVAILABLE until then.
pub type RedmineSlot = OnceLock<Arc<dyn RedmineApi>>;

#[derive(Clone, Copy)]
enum Op {
    GetState,
    Issues,
    Issue,
    Activities,
    UpdateIssue,
    LogTime,
    Summary,
    View,
    Refresh,
    Open,
    SetKey,
    Clear,
}

/// Every `redmine:*` channel with its operation.
const CHANNELS: [(&str, Op); 12] = [
    ("redmine:get-state", Op::GetState),
    ("redmine:issues", Op::Issues),
    ("redmine:issue", Op::Issue),
    ("redmine:activities", Op::Activities),
    ("redmine:update-issue", Op::UpdateIssue),
    ("redmine:log-time", Op::LogTime),
    ("redmine:summary", Op::Summary),
    ("redmine:view", Op::View),
    ("redmine:refresh", Op::Refresh),
    ("redmine:open", Op::Open),
    ("redmine:set-key", Op::SetKey),
    ("redmine:clear", Op::Clear),
];

fn json(value: impl Serialize) -> Result<Value, ExposedError> {
    serde_json::to_value(value).map_err(ExposedError::internal)
}

/// Electron's output check: a value outside the contract becomes INTERNAL (the cause is not
/// exposed nor logged: it could quote what leaked).
fn checked(channel: &str, value: Value) -> Result<Value, ExposedError> {
    match check(channel, Direction::Output, Some(&value)) {
        Some(Err(_)) => {
            log::error!(target: LOG_TARGET, "Redmine output refused by the contract channel={channel}");
            Err(ExposedError::internal("output outside the contract"))
        }
        _ => Ok(value),
    }
}

async fn handle(
    api: &dyn RedmineApi,
    channel: &str,
    op: Op,
    input: Value,
) -> Result<Value, ExposedError> {
    let output = match op {
        Op::GetState => {
            no_input(&input)?;
            api.ready().await;
            json(api.state())?
        }
        Op::Issues => {
            no_input(&input)?;
            json(api.issues().await)?
        }
        Op::Issue => {
            let RedmineIdInput { id } = RedmineIdInput::from_input(input)?;
            json(api.issue(id).await?)?
        }
        Op::Activities => {
            no_input(&input)?;
            json(api.activities().await?)?
        }
        Op::UpdateIssue => {
            let input = UpdateIssueInput::from_input(input)?;
            json(api.update_issue(input).await)?
        }
        Op::LogTime => {
            let input = LogTimeInput::from_input(input)?;
            json(api.log_time(input).await)?
        }
        Op::Summary => {
            no_input(&input)?;
            json(api.summary().await)?
        }
        Op::View => {
            let RedmineViewInput { open } = RedmineViewInput::from_input(input)?;
            api.ready().await;
            api.set_view_open(open);
            Value::Null
        }
        Op::Refresh => {
            no_input(&input)?;
            api.ready().await;
            api.refresh();
            Value::Null
        }
        Op::Open => {
            let RedmineIdInput { id } = RedmineIdInput::from_input(input)?;
            api.ready().await;
            api.open(id)?;
            Value::Null
        }
        Op::SetKey => {
            let SetKeyInput { url, key } = SetKeyInput::from_input(input)?;
            json(api.set_key(url, key).await)?
        }
        Op::Clear => {
            no_input(&input)?;
            api.clear().await;
            Value::Null
        }
    };
    checked(channel, output)
}

struct RedmineChannel {
    slot: Arc<RedmineSlot>,
    name: &'static str,
    op: Op,
}

impl Channel for RedmineChannel {
    fn handle<'a>(
        &'a self,
        _ctx: &'a Ctx,
        input: Value,
    ) -> BoxFuture<'a, Result<Value, ExposedError>> {
        Box::pin(async move {
            let api = self
                .slot
                .get()
                .ok_or_else(|| ExposedError::new(IpcErrorCode::Unavailable, "Not available yet"))?;
            handle(api.as_ref(), self.name, self.op, input).await
        })
    }
}

/// Registers the twelve `redmine:*` channels; they reach the integration through `slot`.
pub fn register(registry: &mut Registry, slot: &Arc<RedmineSlot>) {
    for (name, op) in CHANNELS {
        registry.register(
            name,
            RedmineChannel {
                slot: Arc::clone(slot),
                name,
                op,
            },
        );
    }
}

#[cfg(test)]
#[path = "ipc_tests.rs"]
mod tests;
