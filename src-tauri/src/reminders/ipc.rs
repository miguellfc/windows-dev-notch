//! Port of 0.1.0's `reminders-ipc.ts`: the six `reminders:*` channels. Every handler
//! checks its input first (like the Electron dispatcher), then waits for the runtime to finish
//! starting, so a renderer that asks early gets the loaded list (never an empty one) and
//! mutations never run against an unloaded store. Guards live in `ipc::GUARDS` (`update` is
//! Control Center only; everything else works from the notch too).

use std::sync::{Arc, OnceLock};

use serde_json::Value;

use crate::contract::reminders::{
    CreateReminderInput, Reminder, ReminderIdInput, RemindersSnapshot, UpdateReminderInput,
};
use crate::ipc::{no_input, BoxFuture, Channel, Ctx, ExposedError, IpcErrorCode, Registry};

/// What the channels need (`Pick<RemindersService, ...>`, the snapshot and `ready`).
pub trait RemindersApi: Send + Sync {
    /// Resolves once start has finished (even if it failed).
    fn ready(&self) -> BoxFuture<'_, ()>;
    fn snapshot(&self) -> RemindersSnapshot;
    fn create(&self, input: CreateReminderInput) -> BoxFuture<'_, Result<Reminder, ExposedError>>;
    fn update(&self, input: UpdateReminderInput) -> BoxFuture<'_, Result<Reminder, ExposedError>>;
    fn snooze(&self, id: String) -> BoxFuture<'_, Result<Reminder, ExposedError>>;
    fn complete(&self, id: String) -> BoxFuture<'_, Result<Reminder, ExposedError>>;
    fn remove(&self, id: String) -> BoxFuture<'_, Result<(), ExposedError>>;
}

/// Filled in `setup`; the channels answer UNAVAILABLE until then.
pub type RemindersSlot = OnceLock<Arc<dyn RemindersApi>>;

/// Every `reminders:*` channel.
pub const CHANNELS: [&str; 6] = [
    "reminders:list",
    "reminders:create",
    "reminders:update",
    "reminders:snooze",
    "reminders:complete",
    "reminders:delete",
];

#[derive(Clone, Copy)]
enum Op {
    List,
    Create,
    Update,
    Snooze,
    Complete,
    Delete,
}

enum Call {
    List,
    Create(CreateReminderInput),
    Update(UpdateReminderInput),
    Snooze(ReminderIdInput),
    Complete(ReminderIdInput),
    Delete(ReminderIdInput),
}

impl Call {
    fn parse(op: Op, input: Value) -> Result<Self, ExposedError> {
        Ok(match op {
            Op::List => {
                no_input(&input)?;
                Self::List
            }
            Op::Create => Self::Create(CreateReminderInput::from_input(input)?),
            Op::Update => Self::Update(UpdateReminderInput::from_input(input)?),
            Op::Snooze => Self::Snooze(ReminderIdInput::from_input(input)?),
            Op::Complete => Self::Complete(ReminderIdInput::from_input(input)?),
            Op::Delete => Self::Delete(ReminderIdInput::from_input(input)?),
        })
    }
}

async fn handle(api: &dyn RemindersApi, op: Op, input: Value) -> Result<Value, ExposedError> {
    // The input is checked before waiting, like the Electron dispatcher.
    let call = Call::parse(op, input)?;
    api.ready().await;
    let json = |reminder: Reminder| serde_json::to_value(reminder).map_err(ExposedError::internal);
    match call {
        Call::List => serde_json::to_value(api.snapshot()).map_err(ExposedError::internal),
        Call::Create(input) => json(api.create(input).await?),
        Call::Update(input) => json(api.update(input).await?),
        Call::Snooze(input) => json(api.snooze(input.id).await?),
        Call::Complete(input) => json(api.complete(input.id).await?),
        Call::Delete(input) => {
            api.remove(input.id).await?;
            Ok(Value::Null)
        }
    }
}

struct RemindersChannel {
    slot: Arc<RemindersSlot>,
    op: Op,
}

impl Channel for RemindersChannel {
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
            handle(&**api, self.op, input).await
        })
    }
}

/// Registers the six `reminders:*` channels; they reach the runtime through `slot`.
pub fn register(registry: &mut Registry, slot: &Arc<RemindersSlot>) {
    let ops = [
        Op::List,
        Op::Create,
        Op::Update,
        Op::Snooze,
        Op::Complete,
        Op::Delete,
    ];
    for (name, op) in CHANNELS.into_iter().zip(ops) {
        registry.register(
            name,
            RemindersChannel {
                slot: Arc::clone(slot),
                op,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use serde_json::json;
    use tauri::async_runtime::block_on;

    use super::*;
    use crate::contract::reminders::{ReminderRepeat, ReminderState, ReminderText};
    use crate::contract::StoreNotice;
    use crate::ipc::{guard_for, Guard, Sender, CONTROL_CENTER, NOTCH};

    const ID: &str = "3f2c8a1e-5b7d-4c9e-8f10-2a3b4c5d6e7f";
    const OTHER: &str = "other";

    fn reminder() -> Reminder {
        Reminder {
            id: ID.into(),
            text: ReminderText::new("Revisar PR").unwrap(),
            due_at: "2026-11-10T10:00:00.000Z".into(),
            repeat: ReminderRepeat::None,
            local_time: None,
            state: ReminderState::Pending,
            created_at: "2026-11-10T09:00:00.000Z".into(),
            completed_at: None,
        }
    }

    /// `fakeService()`: records each call; `fail_next` makes the next mutation refuse.
    struct Fake {
        notice: Option<StoreNotice>,
        calls: Mutex<Vec<String>>,
        fail_next: Mutex<Option<ExposedError>>,
    }

    impl Fake {
        fn calls(&self) -> Vec<String> {
            self.calls.lock().unwrap().clone()
        }

        fn record<T>(&self, call: String, ok: T) -> BoxFuture<'_, Result<T, ExposedError>>
        where
            T: Send + 'static,
        {
            self.calls.lock().unwrap().push(call);
            let failure = self.fail_next.lock().unwrap().take();
            Box::pin(async move { failure.map_or(Ok(ok), Err) })
        }
    }

    impl RemindersApi for Fake {
        fn ready(&self) -> BoxFuture<'_, ()> {
            Box::pin(async {})
        }

        fn snapshot(&self) -> RemindersSnapshot {
            RemindersSnapshot {
                reminders: vec![reminder()],
                notice: self.notice,
            }
        }

        fn create(
            &self,
            input: CreateReminderInput,
        ) -> BoxFuture<'_, Result<Reminder, ExposedError>> {
            self.record(
                format!("create {}", serde_json::to_string(&input).unwrap()),
                reminder(),
            )
        }

        fn update(
            &self,
            input: UpdateReminderInput,
        ) -> BoxFuture<'_, Result<Reminder, ExposedError>> {
            let mut updated = reminder();
            updated.text = ReminderText::new("Otro").unwrap();
            self.record(
                format!("update {}", serde_json::to_string(&input).unwrap()),
                updated,
            )
        }

        fn snooze(&self, id: String) -> BoxFuture<'_, Result<Reminder, ExposedError>> {
            self.record(format!("snooze {id}"), reminder())
        }

        fn complete(&self, id: String) -> BoxFuture<'_, Result<Reminder, ExposedError>> {
            let mut done = reminder();
            done.state = ReminderState::Done;
            done.completed_at = Some("2026-11-10T10:01:00.000Z".into());
            self.record(format!("complete {id}"), done)
        }

        fn remove(&self, id: String) -> BoxFuture<'_, Result<(), ExposedError>> {
            self.record(format!("remove {id}"), ())
        }
    }

    struct Fx {
        fake: Arc<Fake>,
        registry: Registry,
    }

    fn setup(notice: Option<StoreNotice>) -> Fx {
        let fake = Arc::new(Fake {
            notice,
            calls: Mutex::new(Vec::new()),
            fail_next: Mutex::new(None),
        });
        let slot = Arc::new(RemindersSlot::new());
        assert!(slot.set(Arc::clone(&fake) as Arc<dyn RemindersApi>).is_ok());
        let mut registry = Registry::with_dev_origin(false);
        register(&mut registry, &slot);
        Fx { fake, registry }
    }

    impl Fx {
        fn invoke(&self, channel: &str, label: &str, input: Option<Value>) -> Value {
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
    fn lists_reminders_with_the_store_notice() {
        let fx = setup(Some(StoreNotice::Quarantined));
        assert_eq!(
            fx.invoke("reminders:list", NOTCH, None),
            json!({ "ok": true, "data": { "reminders": [reminder()], "notice": "quarantined" } })
        );
    }

    #[test]
    fn passes_each_call_to_the_service() {
        let fx = setup(None);
        let created = fx.invoke(
            "reminders:create",
            NOTCH,
            Some(json!({ "input": "en 30 min revisar PR" })),
        );
        assert_eq!(created["ok"], true);
        fx.invoke(
            "reminders:create",
            NOTCH,
            Some(json!({ "text": "Revisar PR", "preset": "15m" })),
        );
        let updated = fx.invoke(
            "reminders:update",
            CONTROL_CENTER,
            Some(json!({ "id": ID, "text": "Otro" })),
        );
        assert_eq!(updated["data"]["text"], "Otro");
        fx.invoke("reminders:snooze", NOTCH, Some(json!({ "id": ID })));
        let completed = fx.invoke("reminders:complete", NOTCH, Some(json!({ "id": ID })));
        assert_eq!(completed["data"]["state"], "done");
        assert_eq!(
            fx.invoke(
                "reminders:delete",
                CONTROL_CENTER,
                Some(json!({ "id": ID }))
            ),
            json!({ "ok": true, "data": null })
        );
        assert_eq!(
            fx.fake.calls(),
            [
                r#"create {"input":"en 30 min revisar PR"}"#.to_owned(),
                r#"create {"text":"Revisar PR","preset":"15m"}"#.to_owned(),
                format!(r#"update {{"id":"{ID}","text":"Otro"}}"#),
                format!("snooze {ID}"),
                format!("complete {ID}"),
                format!("remove {ID}"),
            ]
        );
    }

    #[test]
    fn rejects_invalid_inputs_with_invalid_input_before_reaching_the_service() {
        let fx = setup(None);
        let bad: [(&str, &str, Option<Value>); 8] = [
            (
                "reminders:create",
                NOTCH,
                Some(json!({ "input": "x".repeat(401) })),
            ),
            (
                "reminders:create",
                NOTCH,
                Some(json!({ "text": "a\u{0000}b", "preset": "15m" })),
            ),
            (
                "reminders:create",
                NOTCH,
                Some(json!({ "text": "ok", "preset": "2h" })),
            ),
            (
                "reminders:update",
                CONTROL_CENTER,
                Some(json!({ "id": ID })),
            ),
            (
                "reminders:update",
                CONTROL_CENTER,
                Some(json!({ "id": "nope", "text": "x" })),
            ),
            (
                "reminders:snooze",
                NOTCH,
                Some(json!({ "id": "not-a-uuid" })),
            ),
            (
                "reminders:complete",
                NOTCH,
                Some(json!({ "id": ID, "extra": true })),
            ),
            ("reminders:delete", NOTCH, None),
        ];
        for (channel, label, input) in bad {
            let result = fx.invoke(channel, label, input);
            assert_eq!(result["ok"], false, "{channel}");
            assert_eq!(result["error"]["code"], "INVALID_INPUT", "{channel}");
        }
        assert!(fx.fake.calls().is_empty());
    }

    #[test]
    fn forwards_service_refusals_as_their_codes() {
        let fx = setup(None);
        *fx.fake.fail_next.lock().unwrap() = Some(ExposedError::new(
            IpcErrorCode::NotFound,
            "Reminder not found",
        ));
        let snoozed = fx.invoke("reminders:snooze", NOTCH, Some(json!({ "id": ID })));
        assert_eq!(snoozed["error"]["code"], "NOT_FOUND");
        *fx.fake.fail_next.lock().unwrap() =
            Some(ExposedError::new(IpcErrorCode::ReadOnly, "read only"));
        let deleted = fx.invoke("reminders:delete", NOTCH, Some(json!({ "id": ID })));
        assert_eq!(deleted["error"]["code"], "READ_ONLY");
    }

    /// `remindersChannelGuards`: who may call each channel.
    const ALLOWED: [(&str, bool); 6] = [
        ("reminders:list", true),
        ("reminders:create", true),
        ("reminders:update", false),
        ("reminders:snooze", true),
        ("reminders:complete", true),
        ("reminders:delete", true),
    ];

    fn sample(channel: &str) -> Option<Value> {
        match channel {
            "reminders:create" => Some(json!({ "input": "en 30 min revisar PR" })),
            "reminders:update" => Some(json!({ "id": ID, "text": "Otro" })),
            "reminders:list" => None,
            _ => Some(json!({ "id": ID })),
        }
    }

    #[test]
    fn covers_every_reminders_channel() {
        let registry = Registry::new();
        let mut ours: Vec<&str> = registry
            .channel_names()
            .into_iter()
            .filter(|name| name.starts_with("reminders:"))
            .collect();
        ours.sort_unstable();
        let mut expected: Vec<&str> = ALLOWED.iter().map(|(name, _)| *name).collect();
        expected.sort_unstable();
        assert_eq!(ours, expected);
        let mut channels = CHANNELS.to_vec();
        channels.sort_unstable();
        assert_eq!(channels, expected);
        for (name, from_notch) in ALLOWED {
            let guard = if from_notch {
                Guard::Any
            } else {
                Guard::ControlCenterOnly
            };
            assert_eq!(guard_for(name), guard, "{name}");
        }
    }

    #[test]
    fn each_channel_is_reachable_only_from_its_windows() {
        for (channel, from_notch) in ALLOWED {
            let fx = setup(None);
            for label in [NOTCH, CONTROL_CENTER, OTHER] {
                let expected = label == CONTROL_CENTER || (from_notch && label == NOTCH);
                let result = fx.invoke(channel, label, sample(channel));
                if expected {
                    assert_eq!(result["ok"], true, "{channel} from {label}: {result}");
                } else {
                    assert_eq!(
                        result["error"]["code"], "FORBIDDEN",
                        "{channel} from {label}"
                    );
                }
            }
        }
    }

    #[test]
    fn refuses_reminders_update_from_the_notch() {
        let fx = setup(None);
        let result = fx.invoke(
            "reminders:update",
            NOTCH,
            Some(json!({ "id": ID, "text": "Otro" })),
        );
        assert_eq!(result["error"]["code"], "FORBIDDEN");
        assert!(fx.fake.calls().is_empty());
    }
}
