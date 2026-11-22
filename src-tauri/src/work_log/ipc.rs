//! The work log integration: the service, its 60 s tick, the seven `work-log:*` channels (see
//! `GUARDS`: all notch only but `work-log:claude-available`, Control Center only) and
//! `work-log:changed` to the notch window. Every handler waits for the file to finish loading.
//! Copying goes through here: the renderer names an entry (and a subtask) and never sends text.

use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::service::WorkLogService;
use crate::contract::work_log::{
    WorkLogClaudeAvailable, WorkLogCopyInput, WorkLogSessionInput, WorkLogSetInvoicedInput,
    WorkLogSnapshot,
};
use crate::ipc::{
    emit_event, no_input, BoxFuture, Channel, Ctx, ExposedError, IpcErrorCode, Registry, NOTCH,
};
use crate::notes::ipc::ClipboardWriter;
use crate::services::timers::{Interval, Timers};

pub use crate::notes::ipc::system_clipboard;

/// Housekeeping period: idle sessions pause.
pub const TICK_MS: u64 = 60_000;

/// Sends `work-log:changed` (to the notch window only, when it exists).
pub type SnapshotEmitter = Arc<dyn Fn(&WorkLogSnapshot) + Send + Sync>;

pub type WorkLogSlot = OnceLock<Arc<WorkLog>>;

/// Every `work-log:*` channel.
pub const CHANNELS: [&str; 7] = [
    "work-log:list",
    "work-log:set-invoiced",
    "work-log:delete",
    "work-log:restore",
    "work-log:copy",
    "work-log:summarize",
    "work-log:claude-available",
];

#[derive(Default)]
struct Tick {
    interval: Option<Interval>,
    closed: bool,
}

pub struct WorkLog {
    service: Arc<WorkLogService>,
    ready: tokio::sync::watch::Sender<bool>,
    clipboard: ClipboardWriter,
    tick: Mutex<Tick>,
}

/// Marks the integration ready when dropped, so a load that fails or panics still opens the gate.
struct MarkReady<'a>(&'a tokio::sync::watch::Sender<bool>);

impl Drop for MarkReady<'_> {
    fn drop(&mut self) {
        self.0.send_replace(true);
    }
}

impl WorkLog {
    pub fn new(service: Arc<WorkLogService>, clipboard: ClipboardWriter) -> Arc<Self> {
        let (ready, _) = tokio::sync::watch::channel(false);
        Arc::new(Self {
            service,
            ready,
            clipboard,
            tick: Mutex::default(),
        })
    }

    pub fn service(&self) -> &Arc<WorkLogService> {
        &self.service
    }

    /// Loads the file and sends the first snapshot; the channels wait for this to finish.
    pub async fn start(&self) {
        let _ready = MarkReady(&self.ready);
        self.service.start().await;
    }

    /// Runs [`WorkLogService::tick`] every [`TICK_MS`] on `timers`, at `now`.
    pub fn start_tick(&self, timers: Arc<dyn Timers>, now: Arc<dyn Fn() -> i64 + Send + Sync>) {
        let mut tick = self.tick.lock().unwrap_or_else(PoisonError::into_inner);
        if tick.closed || tick.interval.is_some() {
            return;
        }
        let service = Arc::downgrade(&self.service);
        tick.interval = Some(Interval::start(
            timers,
            TICK_MS,
            Arc::new(move || {
                if let Some(service) = service.upgrade() {
                    service.tick(now());
                }
            }),
        ));
    }

    /// Stops the tick (quit).
    pub fn dispose(&self) {
        let interval = {
            let mut tick = self.tick.lock().unwrap_or_else(PoisonError::into_inner);
            tick.closed = true;
            tick.interval.take()
        };
        drop(interval);
    }

    /// Saves what is not on disk yet, so quitting never loses the last events.
    pub async fn flush(&self) {
        self.service.flush().await;
    }

    async fn ready(&self) {
        let mut ready = self.ready.subscribe();
        let _ = ready.wait_for(|ready| *ready).await;
    }

    async fn handle(&self, op: Op, input: Value) -> Result<Value, ExposedError> {
        let call = Call::parse(op, input)?;
        self.ready().await;
        match call {
            Call::List => {
                serde_json::to_value(self.service.snapshot()).map_err(ExposedError::internal)
            }
            Call::SetInvoiced(input) => {
                self.service
                    .set_invoiced(&input.session_id, input.invoiced)
                    .await?;
                Ok(Value::Null)
            }
            Call::Delete(input) => {
                self.service.delete(&input.session_id).await?;
                Ok(Value::Null)
            }
            Call::Restore(input) => {
                self.service.restore(&input.session_id).await?;
                Ok(Value::Null)
            }
            Call::Copy(input) => {
                let subtask = input
                    .subtask
                    .map(|index| usize::try_from(index).unwrap_or(usize::MAX));
                let text = self.service.copy_text(&input.session_id, subtask)?;
                (self.clipboard)(text).await?;
                Ok(Value::Null)
            }
            Call::Summarize(input) => {
                self.service.summarize(&input.session_id).await?;
                Ok(Value::Null)
            }
            Call::ClaudeAvailable => {
                let service = Arc::clone(&self.service);
                let found =
                    tauri::async_runtime::spawn_blocking(move || service.claude_available())
                        .await
                        .map_err(ExposedError::internal)?;
                serde_json::to_value(WorkLogClaudeAvailable { found })
                    .map_err(ExposedError::internal)
            }
        }
    }
}

#[derive(Clone, Copy)]
enum Op {
    List,
    SetInvoiced,
    Delete,
    Restore,
    Copy,
    Summarize,
    ClaudeAvailable,
}

enum Call {
    List,
    SetInvoiced(WorkLogSetInvoicedInput),
    Delete(WorkLogSessionInput),
    Restore(WorkLogSessionInput),
    Copy(WorkLogCopyInput),
    Summarize(WorkLogSessionInput),
    ClaudeAvailable,
}

impl Call {
    fn parse(op: Op, input: Value) -> Result<Self, ExposedError> {
        Ok(match op {
            Op::List => {
                no_input(&input)?;
                Self::List
            }
            Op::SetInvoiced => Self::SetInvoiced(WorkLogSetInvoicedInput::from_input(input)?),
            Op::Delete => Self::Delete(WorkLogSessionInput::from_input(input)?),
            Op::Restore => Self::Restore(WorkLogSessionInput::from_input(input)?),
            Op::Copy => Self::Copy(WorkLogCopyInput::from_input(input)?),
            Op::Summarize => Self::Summarize(WorkLogSessionInput::from_input(input)?),
            Op::ClaudeAvailable => {
                no_input(&input)?;
                Self::ClaudeAvailable
            }
        })
    }
}

struct WorkLogChannel {
    slot: Arc<WorkLogSlot>,
    op: Op,
}

impl Channel for WorkLogChannel {
    fn handle<'a>(
        &'a self,
        _ctx: &'a Ctx,
        input: Value,
    ) -> BoxFuture<'a, Result<Value, ExposedError>> {
        Box::pin(async move {
            let work_log = self
                .slot
                .get()
                .ok_or_else(|| ExposedError::new(IpcErrorCode::Unavailable, "Not available yet"))?;
            work_log.handle(self.op, input).await
        })
    }
}

/// Registers the seven `work-log:*` channels; they reach the integration through `slot`, filled
/// in `setup` (UNAVAILABLE until then).
pub fn register(registry: &mut Registry, slot: &Arc<WorkLogSlot>) {
    let ops = [
        Op::List,
        Op::SetInvoiced,
        Op::Delete,
        Op::Restore,
        Op::Copy,
        Op::Summarize,
        Op::ClaudeAvailable,
    ];
    for (name, op) in CHANNELS.into_iter().zip(ops) {
        registry.register(
            name,
            WorkLogChannel {
                slot: Arc::clone(slot),
                op,
            },
        );
    }
}

/// `work-log:changed` to the notch window, only while it exists.
pub fn notch_emitter(app: &AppHandle) -> SnapshotEmitter {
    let app = app.clone();
    Arc::new(move |snapshot: &WorkLogSnapshot| {
        if app.get_webview_window(NOTCH).is_some() {
            emit_event(&app, &[NOTCH], "work-log:changed", snapshot);
        }
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tauri::async_runtime::block_on;

    use super::*;
    use crate::claude::hook_events::{HookEvent, HookEventName, WorkPayload};
    use crate::contract::settings::Language;
    use crate::ipc::{Sender, CONTROL_CENTER};
    use crate::services::clock::WallClock;
    use crate::services::test_dir::TestDir;
    use crate::work_log::service::{NoSummarizer, WorkLogConfig, WorkLogDeps};

    struct Fx {
        _dir: TestDir,
        _work_log: Arc<WorkLog>,
        registry: Registry,
        copied: Arc<Mutex<Vec<String>>>,
    }

    impl Fx {
        fn new() -> Self {
            let dir = TestDir::new("work-log-ipc");
            let copied = Arc::new(Mutex::new(Vec::new()));
            let service = WorkLogService::new(WorkLogDeps {
                file: dir.join("work-log.json"),
                clock: Arc::new(WallClock::real()),
                now: Arc::new(|| 0),
                config: Arc::new(|| WorkLogConfig {
                    enabled: true,
                    account_id: Some("claude-work".into()),
                    idle_pause_ms: 30 * 60_000,
                    language: Language::Es,
                }),
                summarizer: Arc::new(NoSummarizer),
                on_change: Arc::new(|_| {}),
            });
            let clipboard: ClipboardWriter = {
                let copied = Arc::clone(&copied);
                Arc::new(move |text: String| {
                    copied.lock().unwrap().push(text);
                    Box::pin(async { Ok(()) })
                })
            };
            let work_log = WorkLog::new(service, clipboard);
            let slot = Arc::new(WorkLogSlot::new());
            assert!(slot.set(Arc::clone(&work_log)).is_ok());
            let mut registry = Registry::with_dev_origin(false);
            register(&mut registry, &slot);
            block_on(work_log.start());
            let prompt = HookEvent {
                name: HookEventName::UserPromptSubmit,
                session_id: "s1".into(),
                cwd: Some("C:\\code\\ms-pay".into()),
                tool_name: None,
                tool_use_id: None,
                agent_id: None,
                notification_type: None,
                preview: None,
                reason: None,
                ask_user_question: None,
                ask_user_question_raw: None,
                source: None,
                account_id: "claude-work".into(),
                work: Some(WorkPayload {
                    prompt: Some("Revisar el PR".into()),
                    ..WorkPayload::default()
                }),
            };
            work_log.service().on_hook_event(&prompt, 0);
            Self {
                _dir: dir,
                _work_log: work_log,
                registry,
                copied,
            }
        }

        fn call(&self, label: &str, channel: &str, input: Option<Value>) -> Value {
            let ctx = Ctx::for_test(Sender {
                label: label.into(),
                url: format!("http://tauri.localhost/{label}/index.html")
                    .parse()
                    .unwrap(),
            });
            block_on(self.registry.dispatch(&ctx, channel, input))
        }
    }

    #[test]
    fn lists_marks_copies_deletes_and_restores() {
        let fx = Fx::new();
        let list = fx.call(NOTCH, "work-log:list", None);
        assert_eq!(list["ok"], true, "{list}");
        assert_eq!(list["data"]["entries"][0]["project"], "ms-pay");
        let id = json!({ "sessionId": "s1" });
        let ack = json!({ "ok": true, "data": null });
        assert_eq!(
            fx.call(
                NOTCH,
                "work-log:set-invoiced",
                Some(json!({ "sessionId": "s1", "invoiced": true }))
            ),
            ack
        );
        // Running: nothing to copy until it pauses or ends.
        let running = fx.call(NOTCH, "work-log:copy", Some(id.clone()));
        assert_eq!(running["error"]["code"], "INVALID_INPUT");
        assert_eq!(fx.call(NOTCH, "work-log:summarize", Some(id.clone())), ack);
        assert_eq!(fx.call(NOTCH, "work-log:copy", Some(id.clone())), ack);
        let copied = fx.copied.lock().unwrap().clone();
        assert_eq!(copied.len(), 1);
        assert!(copied[0].starts_with("Tarea: Sesión del "), "{copied:?}");
        let missing = fx.call(
            NOTCH,
            "work-log:copy",
            Some(json!({ "sessionId": "s1", "subtask": 0 })),
        );
        assert_eq!(missing["error"]["code"], "NOT_FOUND");
        assert_eq!(fx.call(NOTCH, "work-log:delete", Some(id.clone())), ack);
        assert_eq!(
            fx.call(NOTCH, "work-log:list", None)["data"]["entries"],
            json!([])
        );
        assert_eq!(fx.call(NOTCH, "work-log:restore", Some(id)), ack);
        let restored = fx.call(NOTCH, "work-log:list", None);
        assert_eq!(restored["data"]["entries"][0]["status"], "summarizing");
        assert_eq!(restored["data"]["entries"][0]["invoiced"], true);
    }

    #[test]
    fn claude_available_answers_only_the_control_center() {
        let fx = Fx::new();
        let answer = fx.call(CONTROL_CENTER, "work-log:claude-available", None);
        assert_eq!(answer["ok"], true, "{answer}");
        assert!(answer["data"]["found"].is_boolean());
        let refused = fx.call(NOTCH, "work-log:claude-available", None);
        assert_eq!(refused["error"]["code"], "FORBIDDEN");
    }

    #[test]
    fn notch_channels_refuse_other_windows_and_bad_input() {
        let fx = Fx::new();
        for channel in &CHANNELS[..6] {
            let response = fx.call(CONTROL_CENTER, channel, Some(json!({ "sessionId": "s1" })));
            assert_eq!(response["error"]["code"], "FORBIDDEN", "{channel}");
        }
        let bad = fx.call(
            NOTCH,
            "work-log:copy",
            Some(json!({ "sessionId": "s1", "text": "evil" })),
        );
        assert_eq!(bad["error"]["code"], "INVALID_INPUT");
        assert!(fx.copied.lock().unwrap().is_empty());
    }

    #[test]
    fn covers_every_work_log_channel() {
        let mut known: Vec<&str> = crate::ipc::known_channels()
            .iter()
            .copied()
            .filter(|name| name.starts_with("work-log:"))
            .collect();
        known.sort_unstable();
        let mut ours = CHANNELS.to_vec();
        ours.sort_unstable();
        assert_eq!(ours, known);
    }

    #[test]
    fn answers_unavailable_before_setup() {
        let slot = Arc::new(WorkLogSlot::new());
        let mut registry = Registry::with_dev_origin(false);
        register(&mut registry, &slot);
        let ctx = Ctx::for_test(Sender {
            label: NOTCH.into(),
            url: "http://tauri.localhost/notch/index.html".parse().unwrap(),
        });
        let response = block_on(registry.dispatch(&ctx, "work-log:list", None));
        assert_eq!(response["error"]["code"], "UNAVAILABLE");
    }
}
