//! Reminders: `reminders.json` (a [`JsonStore`](crate::services::json_store::JsonStore) of
//! [`RemindersFile`](crate::contract::reminders::RemindersFile)), the local-time recurrence math
//! ([`time`]), the free-text parser ([`parse`]), the rules ([`service`]), the due-time
//! [`scheduler`], the toast texts ([`toast`]), the glue between them ([`runtime`]) and the six
//! `reminders:*` channels ([`ipc`]). No Tauri types here: `lib.rs` wires them to the app.

pub mod ipc;
pub mod parse;
pub mod runtime;
pub mod scheduler;
pub mod service;
pub mod time;
pub mod toast;

/// The app's reminders: the runtime on the machine's local time zone.
pub type Reminders = runtime::RemindersRuntime<chrono::Local>;

/// `tests/unit/main/reminders-store.test.ts`, against the shared `JsonStore` with the reminders
/// document.
#[cfg(test)]
mod store_tests {
    use std::sync::Arc;

    use chrono::{TimeZone, Utc};
    use tauri::async_runtime::block_on;

    use super::service::ReminderStore;
    use crate::contract::reminders::{
        Reminder, ReminderRepeat, ReminderState, ReminderText, RemindersFile,
        REMINDERS_READ_ONLY_MESSAGE, REMINDERS_STORE_NAME,
    };
    use crate::ipc::{ExposedError, IpcErrorCode};
    use crate::services::clock::WallClock;
    use crate::services::json_store::{JsonStore, LoadOutcome};
    use crate::services::test_dir::TestDir;

    fn reminder(n: usize) -> Reminder {
        Reminder {
            id: format!("00000000-0000-4000-8000-00000000000{n}"),
            text: ReminderText::new(&format!("secret text {n}")).unwrap(),
            due_at: "2026-11-10T12:00:00.000Z".into(),
            repeat: ReminderRepeat::None,
            local_time: None,
            state: ReminderState::Pending,
            created_at: "2026-11-10T10:00:00.000Z".into(),
            completed_at: None,
        }
    }

    struct Fx {
        dir: TestDir,
    }

    impl Fx {
        fn new() -> Self {
            Self {
                dir: TestDir::new("reminders-store"),
            }
        }

        fn file(&self) -> std::path::PathBuf {
            self.dir.join("reminders.json")
        }

        fn make(&self) -> JsonStore<RemindersFile> {
            let now = Utc.with_ymd_and_hms(2026, 11, 10, 10, 0, 0).unwrap();
            JsonStore::new(
                self.file(),
                REMINDERS_STORE_NAME,
                Arc::new(WallClock::fixed(now)),
            )
        }

        fn saved(&self) -> Vec<Reminder> {
            let text = std::fs::read_to_string(self.file()).unwrap();
            serde_json::from_str::<RemindersFile>(&text)
                .unwrap()
                .reminders
        }
    }

    fn write(store: &JsonStore<RemindersFile>, list: Vec<Reminder>) -> Result<(), ExposedError> {
        block_on(ReminderStore::write(store, list))
    }

    #[test]
    fn treats_a_missing_file_as_ok_with_an_empty_list() {
        let fx = Fx::new();
        let store = fx.make();
        assert_eq!(block_on(store.load()), LoadOutcome::Ok);
        assert!(ReminderStore::all(&store).is_empty());
    }

    #[test]
    fn writes_and_reloads_reminders() {
        let fx = Fx::new();
        let a = fx.make();
        block_on(a.load());
        write(&a, vec![reminder(1)]).unwrap();
        assert_eq!(ReminderStore::all(&a), [reminder(1)]);
        let b = fx.make();
        assert_eq!(block_on(b.load()), LoadOutcome::Ok);
        assert_eq!(ReminderStore::all(&b), [reminder(1)]);
        // `JSON.stringify(data, null, 2) + "\n"`.
        let text = std::fs::read_to_string(fx.file()).unwrap();
        assert!(text.starts_with("{\n  \"version\": 1,\n  \"reminders\": [\n    {\n      \"id\""));
        assert!(text.ends_with("}\n"));
    }

    #[test]
    fn quarantines_unreadable_files() {
        for (name, content) in [
            ("invalid JSON", "{not json"),
            (
                "schema mismatch",
                r#"{"version":1,"reminders":[{"id":"x"}]}"#,
            ),
            ("no version", r#"{"reminders":[]}"#),
        ] {
            let fx = Fx::new();
            std::fs::write(fx.file(), content).unwrap();
            let store = fx.make();
            assert_eq!(block_on(store.load()), LoadOutcome::Quarantined, "{name}");
            assert!(ReminderStore::all(&store).is_empty());
            assert_eq!(
                fx.dir.names(),
                ["reminders.corrupt-2026-11-10T10-00-00-000Z.json"],
                "{name}"
            );
            write(&store, vec![reminder(1)]).unwrap();
            assert_eq!(ReminderStore::all(&store).len(), 1);
        }
    }

    #[test]
    fn goes_read_only_for_a_newer_version_and_never_writes_over_it() {
        let fx = Fx::new();
        let original = r#"{"version":2,"reminders":[{"anything":true}]}"#;
        std::fs::write(fx.file(), original).unwrap();
        let store = fx.make();
        assert_eq!(block_on(store.load()), LoadOutcome::ReadOnly);
        assert!(ReminderStore::all(&store).is_empty());
        let error = write(&store, vec![reminder(1)]).unwrap_err();
        assert_eq!(error.code(), IpcErrorCode::ReadOnly);
        assert_eq!(error.message(), REMINDERS_READ_ONLY_MESSAGE);
        assert_eq!(
            error.message(),
            "Reminders are read-only in this session; changes cannot be saved"
        );
        assert_eq!(std::fs::read_to_string(fx.file()).unwrap(), original);
        assert!(ReminderStore::all(&store).is_empty());
    }

    #[test]
    fn serializes_writes_the_last_queued_one_wins() {
        let fx = Fx::new();
        let store = fx.make();
        block_on(store.load());
        block_on(async {
            let (first, second) = tokio::join!(
                ReminderStore::write(&store, vec![reminder(1)]),
                ReminderStore::write(&store, vec![reminder(2)]),
            );
            first.unwrap();
            second.unwrap();
        });
        assert_eq!(fx.saved(), [reminder(2)]);
        assert_eq!(ReminderStore::all(&store), [reminder(2)]);
        assert_eq!(fx.dir.names(), ["reminders.json"]);
    }

    #[test]
    fn survives_an_io_failure_rejects_keeps_the_list_and_accepts_later_writes() {
        let fx = Fx::new();
        let store = fx.make();
        block_on(store.load());
        write(&store, vec![reminder(1)]).unwrap();
        // A folder where the file should be: the atomic rename fails.
        std::fs::remove_file(fx.file()).unwrap();
        std::fs::create_dir_all(fx.file().join("blocker")).unwrap();
        assert_eq!(
            write(&store, vec![reminder(2)]).unwrap_err().code(),
            IpcErrorCode::Internal
        );
        assert_eq!(ReminderStore::all(&store), [reminder(1)]);
        std::fs::remove_dir_all(fx.file()).unwrap();
        write(&store, vec![reminder(3)]).unwrap();
        assert_eq!(ReminderStore::all(&store), [reminder(3)]);
        assert_eq!(fx.saved(), [reminder(3)]);
    }

    #[test]
    fn keeps_the_previous_list_when_a_write_fails() {
        let fx = Fx::new();
        let store = fx.make();
        block_on(store.load());
        write(&store, vec![reminder(1)]).unwrap();
        // `{ ...reminder(2), text: '' }` cannot be built (`ReminderText` refuses it); an invalid
        // id fails the document schema the same way.
        let broken = Reminder {
            id: "x".into(),
            ..reminder(2)
        };
        assert!(write(&store, vec![broken]).is_err());
        assert_eq!(ReminderStore::all(&store), [reminder(1)]);
        // A failure does not poison later writes.
        write(&store, vec![reminder(3)]).unwrap();
        assert_eq!(ReminderStore::all(&store), [reminder(3)]);
    }

    #[test]
    fn never_logs_reminder_text() {
        let Some(capture) = crate::services::test_log::capture() else {
            panic!("another logger is installed in the test binary");
        };
        let fx = Fx::new();
        std::fs::write(fx.file(), "{bad secret text 9").unwrap();
        let store = fx.make();
        block_on(store.load());
        write(&store, vec![reminder(1), reminder(2)]).unwrap();
        let lines = capture.lines();
        let ours: Vec<&String> = lines
            .iter()
            .filter(|line| line.contains("json_store") && line.contains("Reminders"))
            .collect();
        assert!(ours.len() >= 2, "{ours:?}");
        assert!(lines.iter().all(|line| !line.contains("secret text")));
    }
}
