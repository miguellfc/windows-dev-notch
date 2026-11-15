//! Quick notes in the notch: `notes.json` (a [`JsonStore`](crate::services::json_store::JsonStore)
//! of [`NotesFile`](crate::contract::notes::NotesFile)), the rules ([`service`]) and the
//! `notes:*` channels ([`ipc`]).

pub mod ipc;
pub mod service;

/// `tests/unit/main/notes-store.test.ts`, against the shared `JsonStore` with the notes document.
#[cfg(test)]
mod store_tests {
    use std::sync::Arc;

    use chrono::{TimeZone, Utc};
    use tauri::async_runtime::block_on;

    use super::service::NoteStore;
    use crate::contract::notes::{Note, NoteText, NotesFile, NOTES_STORE_NAME};
    use crate::ipc::IpcErrorCode;
    use crate::services::clock::WallClock;
    use crate::services::json_store::{JsonStore, LoadOutcome};
    use crate::services::test_dir::TestDir;

    fn note(n: usize) -> Note {
        Note {
            id: format!("00000000-0000-4000-8000-00000000000{n}"),
            text: NoteText::new(&format!("secret text {n}")).unwrap(),
            pinned: false,
            created_at: "2026-11-10T10:00:00.000Z".into(),
            updated_at: "2026-11-10T10:00:00.000Z".into(),
        }
    }

    struct Fx {
        dir: TestDir,
    }

    impl Fx {
        fn new() -> Self {
            Self {
                dir: TestDir::new("notes-store"),
            }
        }

        fn file(&self) -> std::path::PathBuf {
            self.dir.join("notes.json")
        }

        fn make(&self) -> JsonStore<NotesFile> {
            let now = Utc.with_ymd_and_hms(2026, 11, 10, 10, 0, 0).unwrap();
            JsonStore::new(
                self.file(),
                NOTES_STORE_NAME,
                Arc::new(WallClock::fixed(now)),
            )
        }

        fn saved(&self) -> Vec<Note> {
            let text = std::fs::read_to_string(self.file()).unwrap();
            serde_json::from_str::<NotesFile>(&text).unwrap().notes
        }
    }

    fn write(store: &JsonStore<NotesFile>, notes: Vec<Note>) -> Result<(), IpcErrorCode> {
        block_on(NoteStore::write(store, notes)).map_err(|error| error.code())
    }

    #[test]
    fn treats_a_missing_file_as_ok_with_an_empty_list() {
        let fx = Fx::new();
        let store = fx.make();
        assert_eq!(block_on(store.load()), LoadOutcome::Ok);
        assert!(store.all().is_empty());
    }

    #[test]
    fn writes_and_reloads_notes() {
        let fx = Fx::new();
        let a = fx.make();
        block_on(a.load());
        write(&a, vec![note(1)]).unwrap();
        assert_eq!(a.all(), [note(1)]);
        let b = fx.make();
        assert_eq!(block_on(b.load()), LoadOutcome::Ok);
        assert_eq!(b.all(), [note(1)]);
        // `JSON.stringify(data, null, 2) + "\n"`.
        let text = std::fs::read_to_string(fx.file()).unwrap();
        assert!(text.starts_with("{\n  \"version\": 1,\n  \"notes\": [\n    {\n      \"id\""));
        assert!(text.ends_with("}\n"));
    }

    #[test]
    fn quarantines_unreadable_files() {
        for (name, content) in [
            ("invalid JSON", "{not json".to_owned()),
            (
                "schema mismatch",
                r#"{"version":1,"notes":[{"id":"x"}]}"#.to_owned(),
            ),
            ("no version", r#"{"notes":[]}"#.to_owned()),
        ] {
            let fx = Fx::new();
            std::fs::write(fx.file(), content).unwrap();
            let store = fx.make();
            assert_eq!(block_on(store.load()), LoadOutcome::Quarantined, "{name}");
            assert!(store.all().is_empty());
            assert_eq!(
                fx.dir.names(),
                ["notes.corrupt-2026-11-10T10-00-00-000Z.json"],
                "{name}"
            );
            write(&store, vec![note(1)]).unwrap();
            assert_eq!(store.all().len(), 1);
        }
    }

    #[test]
    fn goes_read_only_for_a_newer_version_and_never_writes_over_it() {
        let fx = Fx::new();
        let original = r#"{"version":2,"notes":[{"anything":true}]}"#;
        std::fs::write(fx.file(), original).unwrap();
        let store = fx.make();
        assert_eq!(block_on(store.load()), LoadOutcome::ReadOnly);
        assert!(store.all().is_empty());
        assert_eq!(write(&store, vec![note(1)]), Err(IpcErrorCode::ReadOnly));
        assert_eq!(std::fs::read_to_string(fx.file()).unwrap(), original);
        assert!(store.all().is_empty());
    }

    #[test]
    fn serializes_writes_the_last_queued_one_wins() {
        let fx = Fx::new();
        let store = fx.make();
        block_on(store.load());
        block_on(async {
            let (first, second) = tokio::join!(
                NoteStore::write(&store, vec![note(1)]),
                NoteStore::write(&store, vec![note(2)]),
            );
            first.unwrap();
            second.unwrap();
        });
        assert_eq!(fx.saved(), [note(2)]);
        assert_eq!(store.all(), [note(2)]);
        assert_eq!(fx.dir.names(), ["notes.json"]);
    }

    #[test]
    fn survives_an_io_failure_rejects_keeps_the_list_and_accepts_later_writes() {
        let fx = Fx::new();
        let store = fx.make();
        block_on(store.load());
        write(&store, vec![note(1)]).unwrap();
        // A folder where the file should be: the atomic rename fails.
        std::fs::remove_file(fx.file()).unwrap();
        std::fs::create_dir_all(fx.file().join("blocker")).unwrap();
        assert_eq!(write(&store, vec![note(2)]), Err(IpcErrorCode::Internal));
        assert_eq!(store.all(), [note(1)]);
        std::fs::remove_dir_all(fx.file()).unwrap();
        write(&store, vec![note(3)]).unwrap();
        assert_eq!(store.all(), [note(3)]);
        assert_eq!(fx.saved(), [note(3)]);
    }

    #[test]
    fn keeps_the_previous_list_when_a_write_is_invalid() {
        let fx = Fx::new();
        let store = fx.make();
        block_on(store.load());
        write(&store, vec![note(1)]).unwrap();
        let broken = Note {
            id: "x".into(),
            ..note(2)
        };
        assert!(write(&store, vec![broken]).is_err());
        assert_eq!(store.all(), [note(1)]);
        // A failure does not poison later writes.
        write(&store, vec![note(3)]).unwrap();
        assert_eq!(store.all(), [note(3)]);
    }

    #[test]
    fn never_logs_note_text() {
        let Some(capture) = crate::services::test_log::capture() else {
            panic!("another logger is installed in the test binary");
        };
        let fx = Fx::new();
        std::fs::write(fx.file(), "{bad secret text 9").unwrap();
        let store = fx.make();
        block_on(store.load());
        write(&store, vec![note(1), note(2)]).unwrap();
        let unreadable = Fx::new();
        std::fs::create_dir_all(unreadable.file()).unwrap();
        block_on(unreadable.make().load());
        let lines = capture.lines();
        let ours: Vec<&String> = lines
            .iter()
            .filter(|line| line.contains("json_store"))
            .collect();
        assert!(ours.len() >= 3, "{ours:?}");
        assert!(lines.iter().all(|line| !line.contains("secret text")));
    }
}
