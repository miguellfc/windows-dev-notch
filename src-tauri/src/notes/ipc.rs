//! The notes integration (0.1.0's `notes-integration.ts` and `notes-ipc.ts`): the real
//! `notes.json`, the service, the seven `notes:*` channels (notch only, see `GUARDS`) and
//! `notes:changed` to the notch window. Every handler waits for the file to finish loading, so
//! an early renderer gets the loaded list and no mutation runs against an unloaded store.
//! Copying goes through here: the renderer names a note by id and never sends clipboard text.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::service::{sort_notes, NoteStore, NotesService};
use crate::contract::notes::{
    CreateNoteInput, NoteIdInput, NotesFile, NotesSnapshot, PinNoteInput, UpdateNoteInput,
    NOTES_STORE_NAME,
};
use crate::contract::StoreNotice;
use crate::ipc::{
    emit_event, no_input, BoxFuture, Channel, Ctx, ExposedError, IpcErrorCode, Registry, NOTCH,
};
use crate::platform::clipboard::{self, ClipboardError};
use crate::services::clock::WallClock;
use crate::services::json_store::{JsonStore, LoadOutcome};

/// Puts a note's text on the system clipboard.
pub type ClipboardWriter =
    Arc<dyn Fn(String) -> BoxFuture<'static, Result<(), ExposedError>> + Send + Sync>;
/// Sends `notes:changed` (to the notch window only, when it exists).
pub type SnapshotEmitter = Arc<dyn Fn(&NotesSnapshot) + Send + Sync>;

pub type NotesSlot = OnceLock<Arc<Notes>>;

/// Every `notes:*` channel.
pub const CHANNELS: [&str; 7] = [
    "notes:list",
    "notes:create",
    "notes:update",
    "notes:pin",
    "notes:delete",
    "notes:restore",
    "notes:copy",
];

pub struct Notes {
    store: Arc<JsonStore<NotesFile>>,
    service: NotesService,
    notice: Arc<Mutex<Option<StoreNotice>>>,
    ready: tokio::sync::watch::Sender<bool>,
    emit: SnapshotEmitter,
    clipboard: ClipboardWriter,
}

fn notice_of(outcome: LoadOutcome) -> Option<StoreNotice> {
    match outcome.notice()? {
        LoadOutcome::Ok => None,
        LoadOutcome::Quarantined => Some(StoreNotice::Quarantined),
        LoadOutcome::ReadOnly => Some(StoreNotice::ReadOnly),
    }
}

fn snapshot_of(store: &JsonStore<NotesFile>, notice: &Mutex<Option<StoreNotice>>) -> NotesSnapshot {
    NotesSnapshot {
        notes: sort_notes(&store.get().notes),
        notice: *notice.lock().unwrap_or_else(PoisonError::into_inner),
    }
}

/// Marks the integration ready when dropped, so a load that fails or panics still opens the
/// gate (the `finally` of `start()`).
struct MarkReady<'a>(&'a tokio::sync::watch::Sender<bool>);

impl Drop for MarkReady<'_> {
    fn drop(&mut self) {
        self.0.send_replace(true);
    }
}

impl Notes {
    /// `file` is `notes.json`; `clock` is the real wall clock (notes never follow the E2E test
    /// clock). Ids are random v4 UUIDs.
    pub fn new(
        file: PathBuf,
        clock: Arc<WallClock>,
        emit: SnapshotEmitter,
        clipboard: ClipboardWriter,
    ) -> Arc<Self> {
        let store = Arc::new(JsonStore::new(file, NOTES_STORE_NAME, Arc::clone(&clock)));
        let notice = Arc::new(Mutex::new(None));
        let on_change = {
            let store = Arc::clone(&store);
            let notice = Arc::clone(&notice);
            let emit = Arc::clone(&emit);
            Box::new(move || emit(&snapshot_of(&store, &notice)))
        };
        let service = NotesService::new(
            Arc::clone(&store) as Arc<dyn NoteStore>,
            clock,
            Box::new(|| uuid::Uuid::new_v4().to_string()),
            on_change,
        );
        let (ready, _) = tokio::sync::watch::channel(false);
        Arc::new(Self {
            store,
            service,
            notice,
            ready,
            emit,
            clipboard,
        })
    }

    /// Loads the file and sends the first snapshot; the channels wait for this to finish (even
    /// if loading failed).
    pub async fn start(&self) {
        let _ready = MarkReady(&self.ready);
        let outcome = self.store.load().await;
        *self.notice.lock().unwrap_or_else(PoisonError::into_inner) = notice_of(outcome);
        (self.emit)(&self.snapshot());
    }

    /// Waits for any in-flight write (create, edit, delete...) so quitting never cuts a save
    /// short.
    pub async fn flush(&self) {
        self.service.idle().await;
    }

    /// The `notes:list` answer and `notes:changed` payload.
    pub fn snapshot(&self) -> NotesSnapshot {
        snapshot_of(&self.store, &self.notice)
    }

    async fn ready(&self) {
        let mut ready = self.ready.subscribe();
        // The sender lives as long as `self`, so this only ends once the gate is open.
        let _ = ready.wait_for(|ready| *ready).await;
    }

    async fn handle(&self, channel: Op, input: Value) -> Result<Value, ExposedError> {
        // The input is checked before waiting, like the Electron dispatcher.
        let call = Call::parse(channel, input)?;
        self.ready().await;
        let json = |value: crate::contract::notes::Note| {
            serde_json::to_value(value).map_err(ExposedError::internal)
        };
        match call {
            Call::List => serde_json::to_value(self.snapshot()).map_err(ExposedError::internal),
            Call::Create(input) => json(self.service.create(input.text.as_str()).await?),
            Call::Update(input) => json(self.service.update(&input.id, input.text.as_str()).await?),
            Call::Pin(input) => json(self.service.set_pinned(&input.id, input.pinned).await?),
            Call::Delete(input) => json(self.service.remove(&input.id).await?),
            Call::Restore(input) => json(self.service.restore(&input.id).await?),
            Call::Copy(input) => {
                let text = self.service.text(&input.id)?;
                (self.clipboard)(text).await?;
                Ok(Value::Null)
            }
        }
    }
}

#[derive(Clone, Copy)]
enum Op {
    List,
    Create,
    Update,
    Pin,
    Delete,
    Restore,
    Copy,
}

enum Call {
    List,
    Create(CreateNoteInput),
    Update(UpdateNoteInput),
    Pin(PinNoteInput),
    Delete(NoteIdInput),
    Restore(NoteIdInput),
    Copy(NoteIdInput),
}

impl Call {
    fn parse(op: Op, input: Value) -> Result<Self, ExposedError> {
        Ok(match op {
            Op::List => {
                no_input(&input)?;
                Self::List
            }
            Op::Create => Self::Create(CreateNoteInput::from_input(input)?),
            Op::Update => Self::Update(UpdateNoteInput::from_input(input)?),
            Op::Pin => Self::Pin(PinNoteInput::from_input(input)?),
            Op::Delete => Self::Delete(NoteIdInput::from_input(input)?),
            Op::Restore => Self::Restore(NoteIdInput::from_input(input)?),
            Op::Copy => Self::Copy(NoteIdInput::from_input(input)?),
        })
    }
}

struct NotesChannel {
    slot: Arc<NotesSlot>,
    op: Op,
}

impl Channel for NotesChannel {
    fn handle<'a>(
        &'a self,
        _ctx: &'a Ctx,
        input: Value,
    ) -> BoxFuture<'a, Result<Value, ExposedError>> {
        Box::pin(async move {
            let notes = self
                .slot
                .get()
                .ok_or_else(|| ExposedError::new(IpcErrorCode::Unavailable, "Not available yet"))?;
            notes.handle(self.op, input).await
        })
    }
}

/// Registers the seven `notes:*` channels; they reach the integration through `slot`, filled in
/// `setup` (UNAVAILABLE until then).
pub fn register(registry: &mut Registry, slot: &Arc<NotesSlot>) {
    let ops = [
        Op::List,
        Op::Create,
        Op::Update,
        Op::Pin,
        Op::Delete,
        Op::Restore,
        Op::Copy,
    ];
    for (name, op) in CHANNELS.into_iter().zip(ops) {
        registry.register(
            name,
            NotesChannel {
                slot: Arc::clone(slot),
                op,
            },
        );
    }
}

/// `notes:changed` to the notch window, only while it exists.
pub fn notch_emitter(app: &AppHandle) -> SnapshotEmitter {
    let app = app.clone();
    Arc::new(move |snapshot: &NotesSnapshot| {
        if app.get_webview_window(NOTCH).is_some() {
            emit_event(&app, &[NOTCH], "notes:changed", snapshot);
        }
    })
}

/// The system clipboard, written on a blocking-pool thread (opening may wait for another app).
/// A clipboard another app keeps open is UNAVAILABLE.
pub fn system_clipboard() -> ClipboardWriter {
    clipboard_writer(clipboard::write_text)
}

/// A [`ClipboardWriter`] running `write` on a blocking-pool thread, its errors mapped for the
/// renderer: busy is UNAVAILABLE "Clipboard is busy", anything else INTERNAL.
fn clipboard_writer(write: fn(&str) -> Result<(), ClipboardError>) -> ClipboardWriter {
    Arc::new(move |text: String| {
        Box::pin(async move {
            let written = tauri::async_runtime::spawn_blocking(move || write(&text))
                .await
                .map_err(ExposedError::internal)?;
            written.map_err(|error| match error {
                ClipboardError::Busy => {
                    ExposedError::new(IpcErrorCode::Unavailable, "Clipboard is busy")
                }
                ClipboardError::Failed => ExposedError::internal(error),
            })
        })
    })
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use serde_json::json;
    use tauri::async_runtime::block_on;

    use super::*;
    use crate::ipc::{Sender, CONTROL_CENTER};
    use crate::services::test_dir::TestDir;

    const OTHER: &str = "other";

    struct Fx {
        dir: TestDir,
        notes: Arc<Notes>,
        registry: Registry,
        copied: Arc<Mutex<Vec<String>>>,
        emitted: Arc<Mutex<Vec<NotesSnapshot>>>,
    }

    impl Fx {
        fn with_clipboard(clipboard: Option<ClipboardWriter>) -> Self {
            let dir = TestDir::new("notes-ipc");
            let copied = Arc::new(Mutex::new(Vec::new()));
            let emitted = Arc::new(Mutex::new(Vec::new()));
            let clipboard = clipboard.unwrap_or_else(|| {
                let copied = Arc::clone(&copied);
                Arc::new(move |text: String| {
                    copied.lock().unwrap().push(text);
                    Box::pin(async { Ok(()) })
                })
            });
            let notes = {
                let emitted = Arc::clone(&emitted);
                Notes::new(
                    dir.join("notes.json"),
                    Arc::new(WallClock::real()),
                    Arc::new(move |snapshot: &NotesSnapshot| {
                        emitted.lock().unwrap().push(snapshot.clone())
                    }),
                    clipboard,
                )
            };
            let slot = Arc::new(NotesSlot::new());
            assert!(slot.set(Arc::clone(&notes)).is_ok());
            let mut registry = Registry::with_dev_origin(false);
            register(&mut registry, &slot);
            Self {
                dir,
                notes,
                registry,
                copied,
                emitted,
            }
        }

        fn new() -> Self {
            Self::with_clipboard(None)
        }

        fn started() -> Self {
            let fx = Self::new();
            block_on(fx.notes.start());
            fx
        }

        fn call(&self, label: &str, channel: &str, input: Option<Value>) -> Value {
            block_on(dispatch(&self.registry, label, channel, input))
        }

        fn notch(&self, channel: &str, input: Value) -> Value {
            self.call(NOTCH, channel, Some(input))
        }

        fn copied(&self) -> Vec<String> {
            self.copied.lock().unwrap().clone()
        }

        fn saved(&self) -> bool {
            self.dir.join("notes.json").exists()
        }
    }

    fn ctx(label: &str) -> Ctx {
        Ctx::for_test(Sender {
            label: label.into(),
            url: format!("http://tauri.localhost/{label}/index.html")
                .parse()
                .unwrap(),
        })
    }

    async fn dispatch(
        registry: &Registry,
        label: &str,
        channel: &str,
        input: Option<Value>,
    ) -> Value {
        registry.dispatch(&ctx(label), channel, input).await
    }

    fn code(response: &Value) -> &Value {
        &response["error"]["code"]
    }

    #[test]
    fn lists_notes_with_the_store_notice() {
        let fx = Fx::new();
        std::fs::write(fx.dir.join("notes.json"), r#"{"version":2,"notes":[]}"#).unwrap();
        block_on(fx.notes.start());
        assert_eq!(
            fx.notch("notes:list", Value::Null),
            json!({ "ok": true, "data": { "notes": [], "notice": "read-only" } })
        );

        let fresh = Fx::started();
        assert_eq!(
            fresh.notch("notes:list", Value::Null),
            json!({ "ok": true, "data": { "notes": [], "notice": null } })
        );
    }

    #[test]
    fn passes_each_call_to_the_service() {
        let fx = Fx::started();
        let created = fx.notch("notes:create", json!({ "text": " Revisar PR " }));
        assert_eq!(created["ok"], true);
        let note = created["data"].clone();
        assert_eq!(note["text"], "Revisar PR");
        assert_eq!(note["pinned"], false);
        let id = note["id"].as_str().unwrap().to_owned();
        assert!(crate::contract::text::is_uuid(&id), "{id}");

        let updated = fx.notch("notes:update", json!({ "id": id, "text": "Otro" }));
        assert_eq!(updated["data"]["text"], "Otro");
        let pinned = fx.notch("notes:pin", json!({ "id": id, "pinned": true }));
        assert_eq!(pinned["data"]["pinned"], true);
        let deleted = fx.notch("notes:delete", json!({ "id": id }));
        assert_eq!(deleted["ok"], true);
        assert_eq!(deleted["data"], pinned["data"]);
        assert_eq!(
            fx.notch("notes:list", Value::Null)["data"]["notes"],
            json!([])
        );
        let restored = fx.notch("notes:restore", json!({ "id": id }));
        assert_eq!(restored, json!({ "ok": true, "data": pinned["data"] }));
        assert_eq!(
            fx.notch("notes:list", Value::Null)["data"]["notes"],
            json!([pinned["data"]])
        );
        // Saved for real.
        let saved: NotesFile =
            serde_json::from_str(&std::fs::read_to_string(fx.dir.join("notes.json")).unwrap())
                .unwrap();
        assert_eq!(saved.notes.len(), 1);
    }

    #[test]
    fn copies_the_text_main_holds_for_that_id_never_text_from_the_renderer() {
        let fx = Fx::started();
        fx.notch("notes:create", json!({ "text": "Revisar PR" }));
        let other = fx.notch("notes:create", json!({ "text": "Otra nota" }))["data"]["id"].clone();
        assert_eq!(
            fx.notch("notes:copy", json!({ "id": other })),
            json!({ "ok": true, "data": null })
        );
        assert_eq!(fx.copied(), ["Otra nota"]);
        // A text field is not part of the input: it is rejected.
        let evil = fx.notch("notes:copy", json!({ "id": other, "text": "evil" }));
        assert_eq!(code(&evil), "INVALID_INPUT");
        assert_eq!(fx.copied().len(), 1);
    }

    #[test]
    fn does_not_touch_the_clipboard_when_the_note_does_not_exist() {
        let fx = Fx::started();
        let response = fx.notch(
            "notes:copy",
            json!({ "id": "11111111-2222-4333-8444-555555555555" }),
        );
        assert_eq!(code(&response), "NOT_FOUND");
        assert!(fx.copied().is_empty());
    }

    #[test]
    fn rejects_invalid_inputs_with_invalid_input_before_reaching_the_service() {
        let fx = Fx::started();
        let id = "3f2c8a1e-5b7d-4c9e-8f10-2a3b4c5d6e7f";
        let bad: Vec<(&str, Option<Value>)> = vec![
            ("notes:create", Some(json!({ "text": "" }))),
            ("notes:create", Some(json!({ "text": "x".repeat(2001) }))),
            ("notes:create", Some(json!({ "text": "a\u{0}b" }))),
            ("notes:create", None),
            ("notes:update", Some(json!({ "id": id }))),
            ("notes:update", Some(json!({ "id": "nope", "text": "x" }))),
            ("notes:pin", Some(json!({ "id": id, "pinned": "yes" }))),
            ("notes:delete", Some(json!({ "id": "not-a-uuid" }))),
            ("notes:restore", Some(json!({ "id": id, "extra": true }))),
            ("notes:copy", None),
            ("notes:list", Some(json!({}))),
        ];
        for (channel, input) in bad {
            let response = fx.call(NOTCH, channel, input);
            assert_eq!(code(&response), "INVALID_INPUT", "{channel}");
        }
        assert!(!fx.saved());
        assert!(fx.copied().is_empty());
    }

    #[test]
    fn forwards_service_refusals_as_their_codes() {
        let fx = Fx::started();
        let response = fx.notch(
            "notes:restore",
            json!({ "id": "3f2c8a1e-5b7d-4c9e-8f10-2a3b4c5d6e7f" }),
        );
        assert_eq!(
            response,
            json!({ "ok": false, "error": { "code": "NOT_FOUND", "message": "Note not found" } })
        );
    }

    #[test]
    fn waits_for_the_ready_gate_before_answering_list_or_mutating() {
        let fx = Fx::new();
        std::fs::write(
            fx.dir.join("notes.json"),
            r#"{"version":1,"notes":[{"id":"3f2c8a1e-5b7d-4c9e-8f10-2a3b4c5d6e7f","text":"Revisar PR","pinned":false,"createdAt":"2026-11-10T09:00:00.000Z","updatedAt":"2026-11-10T09:00:00.000Z"}]}"#,
        )
        .unwrap();
        block_on(async {
            let list = dispatch(&fx.registry, NOTCH, "notes:list", None);
            let create = dispatch(
                &fx.registry,
                NOTCH,
                "notes:create",
                Some(json!({ "text": "x" })),
            );
            tokio::pin!(list);
            tokio::pin!(create);
            assert!(tokio::time::timeout(Duration::from_millis(20), &mut list)
                .await
                .is_err());
            assert!(tokio::time::timeout(Duration::from_millis(20), &mut create)
                .await
                .is_err());
            assert!(!fx.saved_after_load());
            fx.notes.start().await;
            let listed = list.await;
            assert_eq!(listed["ok"], true);
            assert_eq!(listed["data"]["notes"][0]["text"], "Revisar PR");
            assert_eq!(create.await["ok"], true);
        });
        assert_eq!(fx.notes.snapshot().notes.len(), 2);
    }

    impl Fx {
        /// Whether something besides the seeded file was written (no temp file, same content).
        fn saved_after_load(&self) -> bool {
            self.dir.names() != ["notes.json"]
                || std::fs::read_to_string(self.dir.join("notes.json"))
                    .unwrap()
                    .contains("\"x\"")
        }
    }

    #[test]
    fn sends_notes_changed_on_start_and_after_each_saved_mutation() {
        let fx = Fx::new();
        block_on(fx.notes.start());
        fx.notch("notes:create", json!({ "text": "Uno" }));
        // A refused call sends nothing.
        fx.notch("notes:create", json!({ "text": "" }));
        let emitted = fx.emitted.lock().unwrap().clone();
        assert_eq!(emitted.len(), 2);
        assert!(emitted[0].notes.is_empty());
        assert_eq!(emitted[1], fx.notes.snapshot());
        assert_eq!(emitted[1].notes[0].text.as_str(), "Uno");
    }

    #[test]
    fn flush_waits_for_in_flight_writes() {
        let fx = Fx::started();
        block_on(async {
            let create = dispatch(
                &fx.registry,
                NOTCH,
                "notes:create",
                Some(json!({ "text": "Uno" })),
            );
            let (response, ()) = tokio::join!(create, fx.notes.flush());
            assert_eq!(response["ok"], true);
        });
        assert!(fx.saved());
    }

    #[test]
    fn copy_reports_error_when_clipboard_is_busy() {
        let busy = Fx::with_clipboard(Some(clipboard_writer(|_| Err(ClipboardError::Busy))));
        block_on(busy.notes.start());
        let id = busy.notch("notes:create", json!({ "text": "Revisar PR" }))["data"]["id"].clone();
        assert_eq!(
            busy.notch("notes:copy", json!({ "id": id })),
            json!({ "ok": false, "error": { "code": "UNAVAILABLE", "message": "Clipboard is busy" } })
        );

        let failed = Fx::with_clipboard(Some(clipboard_writer(|_| Err(ClipboardError::Failed))));
        block_on(failed.notes.start());
        let id =
            failed.notch("notes:create", json!({ "text": "Revisar PR" }))["data"]["id"].clone();
        assert_eq!(
            failed.notch("notes:copy", json!({ "id": id })),
            json!({ "ok": false, "error": { "code": "INTERNAL", "message": "Unexpected error" } })
        );
    }

    #[test]
    fn covers_every_notes_channel() {
        let mut known: Vec<&str> = crate::ipc::known_channels()
            .iter()
            .copied()
            .filter(|name| name.starts_with("notes:"))
            .collect();
        known.sort_unstable();
        let mut ours = CHANNELS.to_vec();
        ours.sort_unstable();
        assert_eq!(ours, known);
    }

    #[test]
    fn every_notes_channel_answers_only_the_notch() {
        let id = "3f2c8a1e-5b7d-4c9e-8f10-2a3b4c5d6e7f";
        let samples: [(&str, Option<Value>); 7] = [
            ("notes:list", None),
            ("notes:create", Some(json!({ "text": "Hola" }))),
            ("notes:update", Some(json!({ "id": id, "text": "Otro" }))),
            ("notes:pin", Some(json!({ "id": id, "pinned": true }))),
            ("notes:delete", Some(json!({ "id": id }))),
            ("notes:restore", Some(json!({ "id": id }))),
            ("notes:copy", Some(json!({ "id": id }))),
        ];
        for (channel, input) in samples {
            let fx = Fx::new();
            std::fs::write(
                fx.dir.join("notes.json"),
                format!(
                    r#"{{"version":1,"notes":[{{"id":"{id}","text":"Revisar PR","pinned":false,"createdAt":"2026-11-10T09:00:00.000Z","updatedAt":"2026-11-10T09:00:00.000Z"}}]}}"#
                ),
            )
            .unwrap();
            block_on(fx.notes.start());
            let before = std::fs::read_to_string(fx.dir.join("notes.json")).unwrap();
            for sender in [CONTROL_CENTER, OTHER] {
                let response = fx.call(sender, channel, input.clone());
                assert_eq!(code(&response), "FORBIDDEN", "{channel} from {sender}");
            }
            assert_eq!(
                std::fs::read_to_string(fx.dir.join("notes.json")).unwrap(),
                before,
                "{channel}"
            );
            assert!(fx.copied().is_empty(), "{channel}");
            let response = fx.call(NOTCH, channel, input);
            if channel == "notes:restore" {
                // Allowed through: nothing was deleted, so the service refuses it.
                assert_eq!(code(&response), "NOT_FOUND", "{channel}");
            } else {
                assert_eq!(response["ok"], true, "{channel}: {response}");
            }
        }
    }

    #[test]
    fn answers_unavailable_before_setup() {
        let slot = Arc::new(NotesSlot::new());
        let mut registry = Registry::with_dev_origin(false);
        register(&mut registry, &slot);
        let response = block_on(dispatch(&registry, NOTCH, "notes:list", None));
        assert_eq!(code(&response), "UNAVAILABLE");
    }
}
