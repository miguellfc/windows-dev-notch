//! A versioned JSON document on disk (`src/main/notes/notes-store.ts` and
//! `src/main/reminders/reminders-store.ts`, which share one policy): validated on read and write,
//! written atomically through a queue, quarantined when unreadable, and never overwritten when
//! it comes from a newer app version.
//!
//! `T` is the whole file document (e.g. `{version: 1, notes: [...]}`); its `Default` is the
//! empty document a missing or quarantined file starts from, and its `Validate` must check the
//! version literal (`z.literal(1)`) along with the rest of the schema. Never logs the content.

use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;

use crate::contract::Validate;
use crate::ipc::{ExposedError, IpcErrorCode};
use crate::services::clock::WallClock;
use crate::services::fs_atomic::write_atomic;
use crate::services::quarantine_path;

/// `CURRENT_VERSION` of both TS stores: a file with a higher `version` is read-only.
pub const CURRENT_VERSION: f64 = 1.0;

/// What [`JsonStore::load`] found (`NotesLoadResult` / `RemindersLoadResult`). Serializes as the
/// TS strings, so [`notice`](Self::notice) can go straight into a snapshot's `notice` field.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum LoadOutcome {
    Ok,
    Quarantined,
    ReadOnly,
}

impl LoadOutcome {
    /// The snapshot `notice`: `None` when the load was fine (`loaded === 'ok' ? null : loaded`).
    pub fn notice(self) -> Option<LoadOutcome> {
        (self != LoadOutcome::Ok).then_some(self)
    }
}

struct State<T> {
    current: T,
    read_only: bool,
}

pub struct JsonStore<T> {
    path: PathBuf,
    /// Plural, capitalized name for logs and the READ_ONLY message (`"Notes"`, `"Reminders"`).
    name: &'static str,
    now: Arc<WallClock>,
    state: Mutex<State<T>>,
    /// Serializes writes: each one starts after the previous one has settled.
    queue: tokio::sync::Mutex<()>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn serialize<T: Serialize>(value: &T) -> Result<Vec<u8>, serde_json::Error> {
    let mut text = serde_json::to_string_pretty(value)?;
    text.push('\n');
    Ok(text.into_bytes())
}

/// `typeof raw.version === 'number' && raw.version > CURRENT_VERSION`.
fn is_newer_version(raw: &Value) -> bool {
    raw.get("version")
        .and_then(Value::as_f64)
        .is_some_and(|version| version > CURRENT_VERSION)
}

impl<T> JsonStore<T>
where
    T: Serialize + DeserializeOwned + Validate + Default + Clone + Send,
{
    /// `name` is the plural, capitalized name of what the file holds (`"Notes"`): it appears in
    /// the logs and in the READ_ONLY message `"<name> are read-only in this session; changes
    /// cannot be saved"`. `now` stamps the quarantine file name.
    pub fn new(path: PathBuf, name: &'static str, now: Arc<WallClock>) -> Self {
        Self {
            path,
            name,
            now,
            state: Mutex::new(State {
                current: T::default(),
                read_only: false,
            }),
            queue: tokio::sync::Mutex::new(()),
        }
    }

    /// Never fails: a file that cannot be read or moved aside leaves the store empty and
    /// read-only for this session.
    pub async fn load(&self) -> LoadOutcome {
        match self.load_from_disk().await {
            Ok(outcome) => outcome,
            Err(error) => {
                // The kind only: an error message could quote a path or part of the file.
                log::error!(
                    "Could not load {}; read-only mode ({:?})",
                    self.name.to_lowercase(),
                    error.kind()
                );
                self.set(T::default(), true);
                LoadOutcome::ReadOnly
            }
        }
    }

    async fn load_from_disk(&self) -> std::io::Result<LoadOutcome> {
        let bytes = match tokio::fs::read(&self.path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(LoadOutcome::Ok),
            Err(error) => return Err(error),
        };
        // Node's `readFile(path, 'utf8')` replaces invalid sequences instead of failing.
        let text = String::from_utf8_lossy(&bytes);
        let Ok(raw) = serde_json::from_str::<Value>(&text) else {
            return self.quarantine("file is not valid JSON").await;
        };
        if is_newer_version(&raw) {
            log::warn!(
                "{} file comes from a newer version; read-only mode",
                self.name
            );
            self.set(T::default(), true);
            return Ok(LoadOutcome::ReadOnly);
        }
        match crate::contract::parse::<T>(raw) {
            Ok(value) => {
                self.set(value, false);
                log::info!("{} loaded", self.name);
                Ok(LoadOutcome::Ok)
            }
            Err(_) => self.quarantine("file does not match the schema").await,
        }
    }

    /// Moves the file to `<stem>.corrupt-<stamp>.json` and starts from the empty document. A
    /// failed rename is a load error (read-only), like the TS stores.
    async fn quarantine(&self, reason: &str) -> std::io::Result<LoadOutcome> {
        let target = quarantine_path(&self.path, self.now.now());
        tokio::fs::rename(&self.path, &target).await?;
        log::warn!(
            "{} {reason}; moved it aside to {} and started with an empty list",
            self.name,
            target.display()
        );
        self.set(T::default(), false);
        Ok(LoadOutcome::Quarantined)
    }

    fn set(&self, value: T, read_only: bool) {
        let mut state = lock(&self.state);
        state.current = value;
        state.read_only = read_only;
    }

    /// The document as last loaded or written.
    pub fn get(&self) -> T {
        lock(&self.state).current.clone()
    }

    /// Validates `value`, writes it atomically after any write already queued, then makes it
    /// the current document. READ_ONLY when the load left the store read-only; a value that
    /// fails validation (a programming error: callers validate first) is INTERNAL and nothing is
    /// written. A failed write leaves the current document as it was and never blocks the queue.
    pub async fn write(&self, value: T) -> Result<(), ExposedError> {
        let _turn = self.queue.lock().await;
        if lock(&self.state).read_only {
            return Err(ExposedError::new(
                IpcErrorCode::ReadOnly,
                format!(
                    "{} are read-only in this session; changes cannot be saved",
                    self.name
                ),
            ));
        }
        value.validate().map_err(ExposedError::internal)?;
        let bytes = serialize(&value).map_err(ExposedError::internal)?;
        write_atomic(&self.path, &bytes)
            .await
            .map_err(ExposedError::internal)?;
        lock(&self.state).current = value;
        log::debug!("{} saved", self.name);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use chrono::{TimeZone, Utc};
    use serde::Deserialize;
    use tauri::async_runtime::block_on;

    use super::*;
    use crate::ipc::IpcErrorCode;
    use crate::services::test_dir::TestDir;

    /// A stand-in for `{version: 1, notes: [...]}`: items must be non-empty strings.
    #[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
    #[serde(deny_unknown_fields)]
    struct Doc {
        version: u32,
        items: Vec<String>,
    }

    impl Default for Doc {
        fn default() -> Self {
            Self {
                version: 1,
                items: Vec::new(),
            }
        }
    }

    impl Validate for Doc {
        fn validate(&self) -> Result<(), String> {
            if self.version != 1 {
                return Err("version".into());
            }
            if self.items.iter().any(String::is_empty) {
                return Err("items".into());
            }
            Ok(())
        }
    }

    fn doc(items: &[&str]) -> Doc {
        Doc {
            version: 1,
            items: items.iter().map(|item| (*item).to_owned()).collect(),
        }
    }

    const STAMP_NAME: &str = "doc.corrupt-2026-11-14T10-20-30-123Z.json";

    fn store(path: &Path, name: &'static str) -> JsonStore<Doc> {
        let at = Utc.with_ymd_and_hms(2026, 11, 14, 10, 20, 30).unwrap()
            + chrono::Duration::milliseconds(123);
        JsonStore::new(path.to_path_buf(), name, Arc::new(WallClock::fixed(at)))
    }

    fn write(path: &Path, text: &str) {
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn missing_file_is_empty_ok() {
        let dir = TestDir::new("json-store");
        let s = store(&dir.join("doc.json"), "Docs");
        assert_eq!(block_on(s.load()), LoadOutcome::Ok);
        assert_eq!(s.get(), Doc::default());
        // Like the TS store, loading never creates the file.
        assert!(dir.names().is_empty());
    }

    #[test]
    fn valid_file_is_loaded() {
        let dir = TestDir::new("json-store");
        let path = dir.join("doc.json");
        write(&path, r#"{"version":1,"items":["a","b"]}"#);
        let s = store(&path, "Docs");
        assert_eq!(block_on(s.load()), LoadOutcome::Ok);
        assert_eq!(s.get(), doc(&["a", "b"]));
    }

    #[test]
    fn invalid_json_is_quarantined() {
        let dir = TestDir::new("json-store");
        let path = dir.join("doc.json");
        write(&path, "{not json");
        let s = store(&path, "Docs");
        assert_eq!(block_on(s.load()), LoadOutcome::Quarantined);
        assert_eq!(s.get(), Doc::default());
        assert_eq!(dir.names(), [STAMP_NAME]);
        assert_eq!(
            std::fs::read_to_string(dir.join(STAMP_NAME)).unwrap(),
            "{not json"
        );
        // Not read-only: the next write creates a fresh file.
        block_on(s.write(doc(&["new"]))).unwrap();
        assert_eq!(
            dir.names(),
            ["doc.corrupt-2026-11-14T10-20-30-123Z.json", "doc.json"]
        );
    }

    #[test]
    fn schema_mismatch_is_quarantined() {
        for text in [
            r#"{"version":1,"items":[""]}"#,
            r#"{"version":1,"items":[],"extra":true}"#,
            r#"{"version":1}"#,
            r#"[1,2]"#,
            r#"{"version":"2","items":[]}"#,
            r#"{"version":0,"items":[]}"#,
        ] {
            let dir = TestDir::new("json-store");
            let path = dir.join("doc.json");
            write(&path, text);
            let s = store(&path, "Docs");
            assert_eq!(block_on(s.load()), LoadOutcome::Quarantined, "{text}");
            assert_eq!(s.get(), Doc::default());
            assert_eq!(dir.names(), [STAMP_NAME], "{text}");
        }
    }

    #[test]
    fn newer_version_is_read_only_and_untouched() {
        let dir = TestDir::new("json-store");
        let path = dir.join("doc.json");
        let text = r#"{"version":2,"items":["kept"],"future":{"x":1}}"#;
        write(&path, text);
        let s = store(&path, "Docs");
        assert_eq!(block_on(s.load()), LoadOutcome::ReadOnly);
        assert_eq!(s.get(), Doc::default());
        let error = block_on(s.write(doc(&["lost"]))).unwrap_err();
        assert_eq!(error.code(), IpcErrorCode::ReadOnly);
        assert_eq!(dir.names(), ["doc.json"]);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
    }

    #[test]
    fn unreadable_file_is_read_only() {
        let dir = TestDir::new("json-store");
        let path = dir.join("doc.json");
        std::fs::create_dir_all(&path).unwrap(); // a folder where the file should be
        let s = store(&path, "Docs");
        assert_eq!(block_on(s.load()), LoadOutcome::ReadOnly);
        assert_eq!(s.get(), Doc::default());
        let error = block_on(s.write(doc(&["x"]))).unwrap_err();
        assert_eq!(error.code(), IpcErrorCode::ReadOnly);
        assert!(path.is_dir());
    }

    #[test]
    fn writes_are_serialized_and_atomic() {
        let dir = TestDir::new("json-store");
        let path = dir.join("doc.json");
        let s = store(&path, "Docs");
        assert_eq!(block_on(s.load()), LoadOutcome::Ok);
        block_on(async {
            let (a, b, c) = tokio::join!(
                s.write(doc(&["a"])),
                s.write(doc(&["a", "b"])),
                s.write(doc(&["a", "b", "c"])),
            );
            a.unwrap();
            b.unwrap();
            c.unwrap();
        });
        assert_eq!(s.get(), doc(&["a", "b", "c"]));
        // Pretty JSON with a trailing newline, like `JSON.stringify(data, null, 2) + "\n"`.
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "{\n  \"version\": 1,\n  \"items\": [\n    \"a\",\n    \"b\",\n    \"c\"\n  ]\n}\n"
        );
        // No temp file left behind.
        assert_eq!(dir.names(), ["doc.json"]);
    }

    #[test]
    fn invalid_value_is_refused_and_nothing_written() {
        let dir = TestDir::new("json-store");
        let path = dir.join("doc.json");
        let s = store(&path, "Docs");
        block_on(s.load());
        block_on(s.write(doc(&["ok"]))).unwrap();
        let error = block_on(s.write(doc(&[""]))).unwrap_err();
        assert_eq!(error.code(), IpcErrorCode::Internal);
        assert_eq!(s.get(), doc(&["ok"]));
        let saved: Doc = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(saved, doc(&["ok"]));
        // A refused write does not block the queue.
        block_on(s.write(doc(&["next"]))).unwrap();
        assert_eq!(s.get(), doc(&["next"]));
    }

    #[test]
    fn read_only_write_returns_given_message() {
        for (name, message) in [
            (
                "Notes",
                "Notes are read-only in this session; changes cannot be saved",
            ),
            (
                "Reminders",
                "Reminders are read-only in this session; changes cannot be saved",
            ),
        ] {
            let dir = TestDir::new("json-store");
            let path = dir.join("doc.json");
            write(&path, r#"{"version":3}"#);
            let s = store(&path, name);
            assert_eq!(block_on(s.load()), LoadOutcome::ReadOnly);
            let error = block_on(s.write(doc(&["x"]))).unwrap_err();
            assert_eq!(error.code(), IpcErrorCode::ReadOnly);
            assert_eq!(error.message(), message);
        }
    }

    #[test]
    fn load_outcome_serializes_like_the_ts_notice() {
        assert_eq!(serde_json::to_value(LoadOutcome::Ok).unwrap(), "ok");
        assert_eq!(
            serde_json::to_value(LoadOutcome::Quarantined).unwrap(),
            "quarantined"
        );
        assert_eq!(
            serde_json::to_value(LoadOutcome::ReadOnly).unwrap(),
            "read-only"
        );
        assert_eq!(LoadOutcome::Ok.notice(), None);
        assert_eq!(
            LoadOutcome::Quarantined.notice(),
            Some(LoadOutcome::Quarantined)
        );
        assert_eq!(LoadOutcome::ReadOnly.notice(), Some(LoadOutcome::ReadOnly));
    }

    #[test]
    fn quarantine_path_matches_the_settings_naming() {
        let at = Utc.with_ymd_and_hms(2026, 11, 15, 10, 20, 30).unwrap()
            + chrono::Duration::milliseconds(123);
        assert_eq!(
            crate::services::quarantine_path(Path::new("C:/data/reminders.json"), at),
            Path::new("C:/data/reminders.corrupt-2026-11-15T10-20-30-123Z.json")
        );
    }
}
