//! `notch_ipc`: the single Tauri command behind `window.notch`.
//!
//! Every call is checked in order: trusted sender (window label + page URL) → known channel →
//! per-channel window guard → handler. Handlers always answer with a `Result` envelope, like
//! the Electron main process (0.1.0's `register.ts`).

mod events;
mod guard;
mod result;

use std::collections::HashMap;
use std::future::Future;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::pin::Pin;
use std::sync::OnceLock;
use std::task::{Context, Poll};

use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State, WebviewWindow};

use crate::services::logger::url_for_log;
use crate::App;

pub use events::{emit_event, existing_windows, is_known_event};
pub use guard::{
    dev_env_var, dev_env_var_os, dev_overrides_enabled, guard_for, is_trusted_sender,
    is_trusted_url, Guard, Sender, CONTROL_CENTER, DEV_ORIGIN, GUARDS, NOTCH,
};
pub use result::{err, ok, ExposedError, IpcErrorCode, UNSPECIFIED_KIND};

/// The `window.notch` bridge (built by `npm run build:bridge`), injected as an initialization script.
pub const BRIDGE_SCRIPT: &str = include_str!("../../gen/bridge.js");

/// Prefix of the test-only channels of the `e2e` build; never in `channels.json` nor a release build.
pub const TEST_CHANNEL_PREFIX: &str = "__e2e:";

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Channel and event names generated from `src/shared/ipc/channels.ts` (see `tests/unit/shared/parity.test.ts`).
#[derive(Deserialize)]
struct Known<'a> {
    #[serde(borrow)]
    channels: Vec<&'a str>,
    #[serde(borrow)]
    events: Vec<&'a str>,
}

fn known() -> &'static Known<'static> {
    static KNOWN: OnceLock<Known<'static>> = OnceLock::new();
    KNOWN.get_or_init(|| {
        serde_json::from_str(include_str!("../../../tests/parity/channels.json"))
            .expect("tests/parity/channels.json is valid")
    })
}

pub fn known_channels() -> &'static [&'static str] {
    &known().channels
}

/// What a handler knows about the call.
pub struct Ctx {
    sender: Sender,
    app: Option<AppHandle>,
}

impl Ctx {
    pub fn new(sender: Sender, app: AppHandle) -> Self {
        Self {
            sender,
            app: Some(app),
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(sender: Sender) -> Self {
        Self { sender, app: None }
    }

    pub fn sender(&self) -> &Sender {
        &self.sender
    }

    /// The app handle; `None` only in unit tests.
    pub fn app(&self) -> Option<&AppHandle> {
        self.app.as_ref()
    }
}

pub trait Channel: Send + Sync {
    fn handle<'a>(
        &'a self,
        ctx: &'a Ctx,
        input: Value,
    ) -> BoxFuture<'a, Result<Value, ExposedError>>;
}

/// `input: none`. The live dispatch path turns "not sent" into `null`, so `null` counts as not sent.
pub fn no_input(input: &Value) -> Result<(), ExposedError> {
    if input.is_null() {
        Ok(())
    } else {
        Err(ExposedError::new(
            IpcErrorCode::InvalidInput,
            "Invalid input",
        ))
    }
}

/// Placeholder for every channel not migrated to Rust yet.
struct Unavailable;

impl Channel for Unavailable {
    fn handle<'a>(
        &'a self,
        _ctx: &'a Ctx,
        _input: Value,
    ) -> BoxFuture<'a, Result<Value, ExposedError>> {
        Box::pin(async {
            Err(ExposedError::new(
                IpcErrorCode::Unavailable,
                "Not available yet",
            ))
        })
    }
}

pub struct Registry {
    channels: HashMap<&'static str, (Box<dyn Channel>, Guard)>,
    allow_dev_origin: bool,
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

impl Registry {
    /// Every known channel, answering UNAVAILABLE until a handler is registered.
    pub fn new() -> Self {
        Self::with_dev_origin(dev_overrides_enabled())
    }

    pub fn with_dev_origin(allow_dev_origin: bool) -> Self {
        let channels = known_channels()
            .iter()
            .map(|&name| {
                (
                    name,
                    (Box::new(Unavailable) as Box<dyn Channel>, guard_for(name)),
                )
            })
            .collect();
        Self {
            channels,
            allow_dev_origin,
        }
    }

    /// Replaces the handler of a known channel; the guard stays the one from [`GUARDS`].
    ///
    /// # Panics
    /// If `name` is not in `channels.json` (a programming error caught at startup).
    pub fn register(&mut self, name: &str, channel: impl Channel + 'static) {
        let Some(entry) = self.channels.get_mut(name) else {
            panic!("unknown channel {name}");
        };
        entry.0 = Box::new(channel);
    }

    /// Adds a test-only channel (`__e2e:*`, see `crate::e2e`), callable from both windows. Exists
    /// only in the `e2e` build: those channels are not part of the renderer contract
    /// (`channels.json`), and a release build cannot register them.
    ///
    /// # Panics
    /// If `name` is not an `__e2e:` name or is already registered (a programming error).
    #[cfg(feature = "e2e")]
    pub fn register_test_channel(&mut self, name: &'static str, channel: impl Channel + 'static) {
        assert!(
            name.starts_with(TEST_CHANNEL_PREFIX),
            "not a test channel: {name}"
        );
        let previous = self.channels.insert(name, (Box::new(channel), Guard::Any));
        assert!(previous.is_none(), "test channel {name} registered twice");
    }

    /// `channel` if it is a registered name, else `"unknown"`: renderer-supplied text never
    /// reaches the log as is.
    pub fn channel_for_log<'a>(&'a self, channel: &str) -> &'a str {
        self.channels
            .get_key_value(channel)
            .map_or("unknown", |(name, _)| name)
    }

    pub fn channel_names(&self) -> Vec<&'static str> {
        self.channels.keys().copied().collect()
    }

    pub async fn dispatch(&self, ctx: &Ctx, channel: &str, input: Option<Value>) -> Value {
        let sender = ctx.sender();
        if !is_trusted_sender(sender, self.allow_dev_origin) {
            // `channel` comes from the untrusted page: only a known name is logged.
            log::warn!(
                "Rejected IPC from untrusted sender: channel={} label={} url={}",
                self.channel_for_log(channel),
                sender.label,
                url_for_log(sender.url.as_str())
            );
            return err(IpcErrorCode::Forbidden, "Untrusted sender");
        }
        let Some((handler, guard)) = self.channels.get(channel) else {
            log::warn!("Rejected IPC for an unknown channel");
            return err(IpcErrorCode::InvalidInput, "Unknown channel");
        };
        if !guard.allows(&sender.label) {
            log::warn!("Rejected IPC from a window not allowed on this channel: channel={channel} label={}", sender.label);
            return err(IpcErrorCode::Forbidden, "Untrusted sender");
        }

        let input = input.unwrap_or(Value::Null);
        let outcome = match catch_unwind(AssertUnwindSafe(|| handler.handle(ctx, input))) {
            Ok(future) => CatchUnwind(future).await,
            Err(panic) => Err(panic),
        };
        match outcome {
            Ok(Ok(data)) => ok(data),
            Ok(Err(error)) if error.code() != IpcErrorCode::Internal => {
                log::warn!(
                    "IPC handler refused the call: channel={channel} code={:?}",
                    error.code()
                );
                err(error.code(), error.message())
            }
            Ok(Err(error)) => {
                // Only the coarse kind: a cause may carry tokens or URLs (see `ExposedError::internal`).
                log::error!(
                    "IPC handler failed: channel={channel} kind={}",
                    error.kind()
                );
                err(IpcErrorCode::Internal, "Unexpected error")
            }
            Err(_) => {
                log::error!("IPC handler panicked: channel={channel}");
                err(IpcErrorCode::Internal, "Unexpected error")
            }
        }
    }
}

/// Turns a panic while polling into an error. Relies on `panic = "unwind"`, which the
/// release profile keeps for that reason.
struct CatchUnwind<F>(F);

impl<F: Future + Unpin> Future for CatchUnwind<F> {
    type Output = std::thread::Result<F::Output>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        let inner = &mut self.0;
        match catch_unwind(AssertUnwindSafe(|| Pin::new(inner).poll(cx))) {
            Ok(Poll::Pending) => Poll::Pending,
            Ok(Poll::Ready(value)) => Poll::Ready(Ok(value)),
            Err(panic) => Poll::Ready(Err(panic)),
        }
    }
}

/// Uninhabited error for [`notch_ipc`]: Tauri requires async commands that borrow `State` to
/// return a `Result`, but the command always resolves with a `Result` envelope.
pub enum Never {}

impl serde::Serialize for Never {
    fn serialize<S: serde::Serializer>(&self, _serializer: S) -> Result<S::Ok, S::Error> {
        match *self {}
    }
}

/// Never rejects: every outcome, including refusals, is a `{ ok, ... }` envelope.
#[tauri::command]
pub async fn notch_ipc(
    window: WebviewWindow,
    channel: String,
    input: Option<Value>,
    state: State<'_, App>,
) -> Result<Value, Never> {
    let Ok(url) = window.url() else {
        log::warn!(
            "Rejected IPC from a webview without a URL: channel={}",
            state.ipc.channel_for_log(&channel)
        );
        return Ok(err(IpcErrorCode::Forbidden, "Untrusted sender"));
    };
    let sender = Sender {
        label: window.label().to_owned(),
        url,
    };
    let ctx = Ctx::new(sender, window.app_handle().clone());
    Ok(state.ipc.dispatch(&ctx, &channel, input).await)
}

#[cfg(test)]
mod tests;
