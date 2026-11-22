//! The fifteen `claude:*` channels (port of 0.1.0's `claude-ipc.ts`). Guards live in
//! `ipc::GUARDS`: decisions, questions and session actions belong to the notch; accounts, hooks,
//! token and port to the Control Center; `claude:get-state` to both. No response carries the bridge token
//! (the state has no field for it and every diff is masked).

use std::sync::{Arc, OnceLock};

use serde::Serialize;
use serde_json::Value;

use super::service::{AnswerResult, ClaudeService};
use crate::contract::claude::{
    AccountAddInput, AccountInput, AnswerInput, AnswerOutcome, DecideInput, DismissSessionInput,
    HooksPreviewInput, HooksPreviewMode, PendingQuestions, ReleaseQuestionInput,
    ANSWERS_DO_NOT_FIT_MESSAGE, NO_IDLE_SESSION_MESSAGE, NO_PENDING_REQUEST_MESSAGE,
};
use crate::ipc::{no_input, BoxFuture, Channel, Ctx, ExposedError, IpcErrorCode, Registry};

/// Filled in `setup`; the channels answer UNAVAILABLE until then.
pub type ClaudeSlot = OnceLock<Arc<ClaudeService>>;

#[derive(Clone, Copy)]
enum Op {
    GetState,
    Decide,
    FocusApp,
    GetQuestions,
    Answer,
    ReleaseQuestion,
    DismissSession,
    HooksPreview,
    HooksInstall,
    HooksUninstall,
    TestConnection,
    RotateToken,
    RotatePort,
    Accounts,
    AccountAdd,
}

/// Every `claude:*` channel with its operation.
const CHANNELS: [(&str, Op); 15] = [
    ("claude:get-state", Op::GetState),
    ("claude:decide", Op::Decide),
    ("claude:focus-app", Op::FocusApp),
    ("claude:get-questions", Op::GetQuestions),
    ("claude:answer", Op::Answer),
    ("claude:release-question", Op::ReleaseQuestion),
    ("claude:dismiss-session", Op::DismissSession),
    ("claude:hooks-preview", Op::HooksPreview),
    ("claude:hooks-install", Op::HooksInstall),
    ("claude:hooks-uninstall", Op::HooksUninstall),
    ("claude:test-connection", Op::TestConnection),
    ("claude:rotate-token", Op::RotateToken),
    ("claude:rotate-port", Op::RotatePort),
    ("claude:accounts", Op::Accounts),
    ("claude:account-add", Op::AccountAdd),
];

fn json(value: impl Serialize) -> Result<Value, ExposedError> {
    serde_json::to_value(value).map_err(ExposedError::internal)
}

async fn handle(service: &ClaudeService, op: Op, input: Value) -> Result<Value, ExposedError> {
    match op {
        Op::GetState => {
            no_input(&input)?;
            json(service.state())
        }
        Op::Decide => {
            let input = DecideInput::from_input(input)?;
            if !service.decide(&input.request_id, input.decision) {
                return Err(ExposedError::new(
                    IpcErrorCode::NotFound,
                    NO_PENDING_REQUEST_MESSAGE,
                ));
            }
            Ok(Value::Null)
        }
        Op::FocusApp => {
            no_input(&input)?;
            service.focus_app();
            Ok(Value::Null)
        }
        Op::GetQuestions => {
            no_input(&input)?;
            json(PendingQuestions(service.questions()))
        }
        Op::Answer => {
            let input = AnswerInput::from_input(input)?;
            match service.answer(&input.id, &input.answers) {
                AnswerResult::Sent => json(AnswerOutcome::Sent),
                AnswerResult::Gone => json(AnswerOutcome::Gone),
                AnswerResult::Invalid => Err(ExposedError::new(
                    IpcErrorCode::InvalidInput,
                    ANSWERS_DO_NOT_FIT_MESSAGE,
                )),
            }
        }
        Op::ReleaseQuestion => {
            let input = ReleaseQuestionInput::from_input(input)?;
            service.release_question(&input.id);
            Ok(Value::Null)
        }
        Op::DismissSession => {
            let input = DismissSessionInput::from_input(input)?;
            if !service.dismiss_session(&input.session_id) {
                return Err(ExposedError::new(
                    IpcErrorCode::NotFound,
                    NO_IDLE_SESSION_MESSAGE,
                ));
            }
            Ok(Value::Null)
        }
        Op::HooksPreview => {
            let input = HooksPreviewInput::from_input(input)?;
            let mode = input.mode.unwrap_or(HooksPreviewMode::Install);
            json(service.preview_hooks(&input.account_id, mode).await?)
        }
        Op::HooksInstall => {
            let input = AccountInput::from_input(input)?;
            json(service.install_hooks(&input.account_id).await?)
        }
        Op::HooksUninstall => {
            let input = AccountInput::from_input(input)?;
            json(service.uninstall_hooks(&input.account_id).await?)
        }
        Op::Accounts => {
            no_input(&input)?;
            json(service.accounts().await?)
        }
        Op::AccountAdd => {
            let input = AccountAddInput::from_input(input)?;
            json(service.add_account(&input.dir).await?)
        }
        Op::TestConnection => {
            no_input(&input)?;
            json(service.test_connection().await)
        }
        Op::RotateToken => {
            no_input(&input)?;
            json(service.rotate_token().await?)
        }
        Op::RotatePort => {
            no_input(&input)?;
            json(service.rotate_port().await?)
        }
    }
}

struct ClaudeChannel {
    slot: Arc<ClaudeSlot>,
    op: Op,
}

impl Channel for ClaudeChannel {
    fn handle<'a>(
        &'a self,
        _ctx: &'a Ctx,
        input: Value,
    ) -> BoxFuture<'a, Result<Value, ExposedError>> {
        Box::pin(async move {
            let service = self
                .slot
                .get()
                .ok_or_else(|| ExposedError::new(IpcErrorCode::Unavailable, "Not available yet"))?;
            handle(service, self.op, input).await
        })
    }
}

/// Registers the fifteen `claude:*` channels; they reach the service through `slot`.
pub fn register(registry: &mut Registry, slot: &Arc<ClaudeSlot>) {
    for (name, op) in CHANNELS {
        registry.register(
            name,
            ClaudeChannel {
                slot: Arc::clone(slot),
                op,
            },
        );
    }
}
