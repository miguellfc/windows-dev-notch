//! The fourteen `gmail:*` channels (port of `src/main/gmail/gmail-ipc.ts`) and the new-mail
//! alert's wiring to the capsule (the `onNewMail` of `src/main/index.ts`).
//!
//! Guards live in `ipc::GUARDS`: mail data and the browser opener belong to the notch; the
//! session (sign-in, sign-out, the client file) to the Control Center; the state to both.
//! Exactly as in TS, `get-state`, `view`, `refresh`, `open`, `message`, `mark-read`, `delete`,
//! `open-link` and `close-message` wait here for the stored token to load, so the first state is
//! never a guess; `recent`, `sign-in` and `sign-out` wait inside the integration;
//! `cancel-sign-in` and `pick-client-file` never wait.
//!
//! Like Electron's dispatcher, an output that does not match the contract (a token in the state,
//! a URL that is not http(s) in a message, six recent messages) never leaves: it becomes
//! INTERNAL.
//!
//! `sign-in` and `sign-out` run as their own task, awaited by the channel: a dropped IPC call
//! never cancels them half way (a dropped `GmailIntegration::sign_in` would stay signing-in or
//! never save the token).

use std::sync::{Arc, OnceLock};

use serde::Serialize;
use serde_json::Value;

use super::client_file::PickClientFile;
use super::integration::{GmailIntegration, NewMailListener, LOG_TARGET};
use crate::contract::gmail::{
    GmailIdInput, GmailMessage, GmailMessageDetail, GmailNewMail, GmailOpenInput,
    GmailOpenLinkInput, GmailRecent, GmailSignInResult, GmailState, GmailViewInput,
};
use crate::contract::{check, Direction};
use crate::ipc::{no_input, BoxFuture, Channel, Ctx, ExposedError, IpcErrorCode, Registry};
use crate::notch::controller::NotchController;
use crate::notch::state::NotchEvent;

/// What the channels need from the integration (`Pick<GmailIntegration, ...>`).
pub trait GmailApi: Send + Sync {
    /// Resolves once the stored token was read.
    fn ready(&self) -> BoxFuture<'_, ()>;
    fn state(&self) -> GmailState;
    /// The list last fetched, now counted as shown (waits for the load and any poll in flight).
    fn recent(&self) -> BoxFuture<'_, Vec<GmailMessage>>;
    fn set_view_open(&self, open: bool);
    fn refresh(&self);
    /// Never fails: an id never shown is refused silently.
    fn open(&self, id: Option<&str>);
    fn message(&self, id: String) -> BoxFuture<'_, Result<GmailMessageDetail, ExposedError>>;
    fn mark_read(&self, id: String) -> BoxFuture<'_, Result<(), ExposedError>>;
    fn remove(&self, id: String) -> BoxFuture<'_, Result<(), ExposedError>>;
    /// INVALID_INPUT "Unknown link".
    fn open_link(&self, id: &str, index: u32) -> Result<(), ExposedError>;
    fn close_message(&self);
    /// Must run to the end once started: the channel spawns it.
    fn sign_in(&self) -> BoxFuture<'_, GmailSignInResult>;
    fn cancel_sign_in(&self);
    fn sign_out(&self) -> BoxFuture<'_, ()>;
}

impl GmailApi for GmailIntegration {
    fn ready(&self) -> BoxFuture<'_, ()> {
        Box::pin(GmailIntegration::ready(self))
    }

    fn state(&self) -> GmailState {
        GmailIntegration::state(self)
    }

    fn recent(&self) -> BoxFuture<'_, Vec<GmailMessage>> {
        Box::pin(GmailIntegration::recent(self))
    }

    fn set_view_open(&self, open: bool) {
        GmailIntegration::set_view_open(self, open);
    }

    fn refresh(&self) {
        GmailIntegration::refresh(self);
    }

    fn open(&self, id: Option<&str>) {
        GmailIntegration::open(self, id);
    }

    fn message(&self, id: String) -> BoxFuture<'_, Result<GmailMessageDetail, ExposedError>> {
        Box::pin(async move { GmailIntegration::message(self, &id).await })
    }

    fn mark_read(&self, id: String) -> BoxFuture<'_, Result<(), ExposedError>> {
        Box::pin(async move { GmailIntegration::mark_read(self, &id).await })
    }

    fn remove(&self, id: String) -> BoxFuture<'_, Result<(), ExposedError>> {
        Box::pin(async move { GmailIntegration::remove(self, &id).await })
    }

    fn open_link(&self, id: &str, index: u32) -> Result<(), ExposedError> {
        GmailIntegration::open_link(self, id, index)
    }

    fn close_message(&self) {
        GmailIntegration::close_message(self);
    }

    fn sign_in(&self) -> BoxFuture<'_, GmailSignInResult> {
        Box::pin(GmailIntegration::sign_in(self))
    }

    fn cancel_sign_in(&self) {
        GmailIntegration::cancel_sign_in(self);
    }

    fn sign_out(&self) -> BoxFuture<'_, ()> {
        Box::pin(GmailIntegration::sign_out(self))
    }
}

/// What the channels reach: the integration and the client-file picker.
pub struct GmailHandles {
    pub api: Arc<dyn GmailApi>,
    pub client_file: Arc<dyn PickClientFile>,
}

/// Filled in `setup`; the channels answer UNAVAILABLE until then.
pub type GmailSlot = OnceLock<GmailHandles>;

#[derive(Clone, Copy)]
enum Op {
    GetState,
    Recent,
    View,
    Refresh,
    Open,
    Message,
    MarkRead,
    Delete,
    OpenLink,
    CloseMessage,
    SignIn,
    CancelSignIn,
    SignOut,
    PickClientFile,
}

/// Every `gmail:*` channel with its operation.
const CHANNELS: [(&str, Op); 14] = [
    ("gmail:get-state", Op::GetState),
    ("gmail:recent", Op::Recent),
    ("gmail:view", Op::View),
    ("gmail:refresh", Op::Refresh),
    ("gmail:open", Op::Open),
    ("gmail:message", Op::Message),
    ("gmail:mark-read", Op::MarkRead),
    ("gmail:delete", Op::Delete),
    ("gmail:open-link", Op::OpenLink),
    ("gmail:close-message", Op::CloseMessage),
    ("gmail:sign-in", Op::SignIn),
    ("gmail:cancel-sign-in", Op::CancelSignIn),
    ("gmail:sign-out", Op::SignOut),
    ("gmail:pick-client-file", Op::PickClientFile),
];

fn json(value: impl Serialize) -> Result<Value, ExposedError> {
    serde_json::to_value(value).map_err(ExposedError::internal)
}

/// Electron's output check: a value outside the contract becomes INTERNAL (the cause is not
/// exposed nor logged: it could quote what leaked).
fn checked(channel: &str, value: Value) -> Result<Value, ExposedError> {
    match check(channel, Direction::Output, Some(&value)) {
        Some(Err(_)) => {
            log::error!(target: LOG_TARGET, "Gmail output refused by the contract channel={channel}");
            Err(ExposedError::internal("output outside the contract"))
        }
        _ => Ok(value),
    }
}

async fn handle(
    handles: &GmailHandles,
    channel: &str,
    op: Op,
    input: Value,
) -> Result<Value, ExposedError> {
    let api = handles.api.as_ref();
    let output = match op {
        Op::GetState => {
            no_input(&input)?;
            api.ready().await;
            json(api.state())?
        }
        Op::Recent => {
            no_input(&input)?;
            json(GmailRecent(api.recent().await))?
        }
        Op::View => {
            let GmailViewInput { open } = GmailViewInput::from_input(input)?;
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
            let GmailOpenInput { id } = GmailOpenInput::from_input(input)?;
            api.ready().await;
            api.open(id.as_deref());
            Value::Null
        }
        Op::Message => {
            let GmailIdInput { id } = GmailIdInput::from_input(input)?;
            api.ready().await;
            json(api.message(id).await?)?
        }
        Op::MarkRead => {
            let GmailIdInput { id } = GmailIdInput::from_input(input)?;
            api.ready().await;
            api.mark_read(id).await?;
            Value::Null
        }
        Op::Delete => {
            let GmailIdInput { id } = GmailIdInput::from_input(input)?;
            api.ready().await;
            api.remove(id).await?;
            Value::Null
        }
        Op::OpenLink => {
            let GmailOpenLinkInput { id, index } = GmailOpenLinkInput::from_input(input)?;
            api.ready().await;
            api.open_link(&id, index)?;
            Value::Null
        }
        Op::CloseMessage => {
            no_input(&input)?;
            api.ready().await;
            api.close_message();
            Value::Null
        }
        Op::SignIn => {
            no_input(&input)?;
            // Spawned: the sign-in runs to the end even if this call is dropped.
            let api = Arc::clone(&handles.api);
            let result = tokio::spawn(async move { api.sign_in().await })
                .await
                .map_err(ExposedError::internal)?;
            json(result)?
        }
        Op::CancelSignIn => {
            no_input(&input)?;
            api.cancel_sign_in();
            Value::Null
        }
        Op::SignOut => {
            no_input(&input)?;
            // Spawned for the same reason: the token is cleared even if this call is dropped.
            let api = Arc::clone(&handles.api);
            tokio::spawn(async move { api.sign_out().await })
                .await
                .map_err(ExposedError::internal)?;
            Value::Null
        }
        Op::PickClientFile => {
            no_input(&input)?;
            json(handles.client_file.pick_client_file().await?)?
        }
    };
    checked(channel, output)
}

struct GmailChannel {
    slot: Arc<GmailSlot>,
    name: &'static str,
    op: Op,
}

impl Channel for GmailChannel {
    fn handle<'a>(
        &'a self,
        _ctx: &'a Ctx,
        input: Value,
    ) -> BoxFuture<'a, Result<Value, ExposedError>> {
        Box::pin(async move {
            let handles = self
                .slot
                .get()
                .ok_or_else(|| ExposedError::new(IpcErrorCode::Unavailable, "Not available yet"))?;
            handle(handles, self.name, self.op, input).await
        })
    }
}

/// Registers the fourteen `gmail:*` channels; they reach the integration through `slot`.
pub fn register(registry: &mut Registry, slot: &Arc<GmailSlot>) {
    for (name, op) in CHANNELS {
        registry.register(
            name,
            GmailChannel {
                slot: Arc::clone(slot),
                name,
                op,
            },
        );
    }
}

/// The capsule as far as the new-mail alert goes.
pub trait MailNotch: Send + Sync {
    /// The notch window exists (`!notchWindow.isDestroyed()`).
    fn exists(&self) -> bool;
    /// `gmail:new-mail` with its payload, to the notch only.
    fn emit(&self, mail: &GmailNewMail);
    fn dispatch(&self, event: NotchEvent);
}

/// `onNewMail`: nothing without the notch; otherwise the payload first, so the capsule already
/// knows what to show when the mode turns to alert, then the alert. No panel check: the
/// controller drops the alert under a panel and ends it after 6 s.
pub fn deliver_new_mail(notch: &dyn MailNotch, mail: &GmailNewMail) {
    if !notch.exists() {
        return;
    }
    notch.emit(mail);
    notch.dispatch(NotchEvent::Mail { on: true });
}

/// The integration's `on_new_mail` over `notch`.
pub fn new_mail_listener(notch: Arc<dyn MailNotch>) -> NewMailListener {
    Arc::new(move |mail| deliver_new_mail(notch.as_ref(), mail))
}

/// The real capsule: the notch window of `app` and its controller. Called from a tokio task with
/// no integration lock held; `dispatch` runs window effects, which Tauri marshals to the main
/// thread, and the window lookup is a map read, not a round trip to the main thread.
pub struct AppMailNotch {
    pub app: tauri::AppHandle,
    pub controller: Arc<NotchController>,
}

impl MailNotch for AppMailNotch {
    fn exists(&self) -> bool {
        use tauri::Manager;
        self.app.get_webview_window(crate::ipc::NOTCH).is_some()
    }

    fn emit(&self, mail: &GmailNewMail) {
        crate::ipc::emit_event(&self.app, &[crate::ipc::NOTCH], "gmail:new-mail", mail);
    }

    fn dispatch(&self, event: NotchEvent) {
        self.controller.dispatch(event);
    }
}

#[cfg(test)]
#[path = "ipc_tests.rs"]
mod tests;
