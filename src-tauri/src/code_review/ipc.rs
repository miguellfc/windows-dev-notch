//! The eight `code-review:*` channels (port of 0.1.0's `code-review-ipc.ts`).
//! Guards live in `ipc::GUARDS`: lists, contributions, the view signal and the browser opener
//! belong to the notch; tokens to the Control Center; the state to both. Every handler waits for
//! the stored tokens to load, so the first state is never a guess; `list`, `set-token`, `clear`
//! and `contributions` wait inside the integration.
//!
//! Like Electron's dispatcher, an output that does not match the contract (a URL in a list, a
//! token in the state, more than 20 items) never leaves: it becomes INTERNAL.

use std::sync::{Arc, OnceLock};

use serde::Serialize;
use serde_json::Value;

use super::integration::LOG_TARGET;
use crate::contract::code_review::{
    CodeReviewList, CodeReviewState, CodeReviewViewInput, ContributionsResult, OpenInput, Platform,
    PlatformInput, SetTokenInput, SetTokenResult,
};
use crate::contract::{check, Direction};
use crate::ipc::{no_input, BoxFuture, Channel, Ctx, ExposedError, IpcErrorCode, Registry};

/// What the channels need from the integration (`Pick<CodeReviewIntegration, ...>`).
pub trait CodeReviewApi: Send + Sync {
    /// Resolves once both stored tokens were read.
    fn ready(&self) -> BoxFuture<'_, ()>;
    fn state(&self) -> CodeReviewState;
    fn list(&self, platform: Platform) -> BoxFuture<'_, CodeReviewList>;
    fn refresh(&self);
    /// INVALID_INPUT "Unknown item" / "Item URL not allowed".
    fn open(&self, platform: Platform, id: &str) -> Result<(), ExposedError>;
    fn set_token(
        &self,
        platform: Platform,
        token: String,
        url: Option<String>,
    ) -> BoxFuture<'_, SetTokenResult>;
    fn clear(&self, platform: Platform) -> BoxFuture<'_, ()>;
    fn set_view_open(&self, open: bool);
    fn contributions(&self, platform: Platform) -> BoxFuture<'_, ContributionsResult>;
}

/// Filled in `setup`; the channels answer UNAVAILABLE until then.
pub type CodeReviewSlot = OnceLock<Arc<dyn CodeReviewApi>>;

#[derive(Clone, Copy)]
enum Op {
    GetState,
    List,
    Refresh,
    Open,
    SetToken,
    Clear,
    View,
    Contributions,
}

/// Every `code-review:*` channel with its operation.
const CHANNELS: [(&str, Op); 8] = [
    ("code-review:get-state", Op::GetState),
    ("code-review:list", Op::List),
    ("code-review:refresh", Op::Refresh),
    ("code-review:open", Op::Open),
    ("code-review:set-token", Op::SetToken),
    ("code-review:clear", Op::Clear),
    ("code-review:view", Op::View),
    ("code-review:contributions", Op::Contributions),
];

fn json(value: impl Serialize) -> Result<Value, ExposedError> {
    serde_json::to_value(value).map_err(ExposedError::internal)
}

/// Electron's output check: a value outside the contract becomes INTERNAL (the cause is not
/// exposed: it could quote what leaked).
fn checked(channel: &str, value: Value) -> Result<Value, ExposedError> {
    match check(channel, Direction::Output, Some(&value)) {
        Some(Err(_)) => {
            log::error!(target: LOG_TARGET, "Code review output refused by the contract channel={channel}");
            Err(ExposedError::internal("output outside the contract"))
        }
        _ => Ok(value),
    }
}

async fn handle(
    api: &dyn CodeReviewApi,
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
        Op::List => {
            let PlatformInput { platform } = PlatformInput::from_input(input)?;
            json(api.list(platform).await)?
        }
        Op::Refresh => {
            no_input(&input)?;
            api.ready().await;
            api.refresh();
            Value::Null
        }
        Op::Open => {
            let OpenInput { platform, id } = OpenInput::from_input(input)?;
            api.ready().await;
            api.open(platform, &id)?;
            Value::Null
        }
        Op::SetToken => {
            let SetTokenInput {
                platform,
                token,
                url,
            } = SetTokenInput::from_input(input)?;
            json(api.set_token(platform, token, url).await)?
        }
        Op::Clear => {
            let PlatformInput { platform } = PlatformInput::from_input(input)?;
            api.clear(platform).await;
            Value::Null
        }
        Op::View => {
            let CodeReviewViewInput { open } = CodeReviewViewInput::from_input(input)?;
            api.ready().await;
            api.set_view_open(open);
            Value::Null
        }
        Op::Contributions => {
            let PlatformInput { platform } = PlatformInput::from_input(input)?;
            json(api.contributions(platform).await)?
        }
    };
    checked(channel, output)
}

struct CodeReviewChannel {
    slot: Arc<CodeReviewSlot>,
    name: &'static str,
    op: Op,
}

impl Channel for CodeReviewChannel {
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

/// Registers the eight `code-review:*` channels; they reach the integration through `slot`.
pub fn register(registry: &mut Registry, slot: &Arc<CodeReviewSlot>) {
    for (name, op) in CHANNELS {
        registry.register(
            name,
            CodeReviewChannel {
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
