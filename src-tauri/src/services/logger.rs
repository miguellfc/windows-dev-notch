//! Local log file (0.1.0's `logger.ts`): `<data>/logs/main.log`, rotated by size and
//! when the local day changes, as `main.1.log`, `main.2.log` (same names as the Electron build).
//! The crate logs through the `log` macros; [`init_logger`] installs a `log::Log` that writes
//! every record to that file.
//!
//! Never log payloads, tokens or full URLs: use [`url_for_log`].

use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use chrono::{DateTime, Local, NaiveDate, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use url::Url;

/// Base name of the log files (`main.log`, `main.1.log`, …), like the Electron build.
pub const LOG_FILE_NAME: &str = "main";
/// The crate's own `log` targets start with this (module paths).
const CRATE_TARGET: &str = "developer_notch_lib";

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl LogLevel {
    fn label(self) -> &'static str {
        match self {
            Self::Debug => "DEBUG",
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        }
    }

    fn from_log(level: log::Level) -> Self {
        match level {
            log::Level::Error => Self::Error,
            log::Level::Warn => Self::Warn,
            log::Level::Info => Self::Info,
            log::Level::Debug | log::Level::Trace => Self::Debug,
        }
    }
}

pub type LogClock = Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>;

pub struct FileLoggerOptions {
    pub dir: PathBuf,
    /// Base name without extension; files are `<name>.log`, `<name>.1.log`, …
    pub file_name: String,
    pub max_bytes: u64,
    pub max_files: usize,
    pub min_level: LogLevel,
    pub mirror_to_console: bool,
    pub now: LogClock,
}

impl FileLoggerOptions {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            file_name: LOG_FILE_NAME.into(),
            max_bytes: 1_000_000,
            max_files: 3,
            min_level: LogLevel::Debug,
            mirror_to_console: false,
            now: Arc::new(Utc::now),
        }
    }
}

/// What is known about the current file once it has been looked at.
#[derive(Default)]
struct FileState {
    size: Option<u64>,
    /// Local day of the last line written (or of the file's last change at startup).
    day: Option<NaiveDate>,
}

/// Append-only file logger with size- and day-based rotation. Logging must never crash the app,
/// so every filesystem failure is swallowed.
pub struct FileLogger {
    options: FileLoggerOptions,
    state: Mutex<FileState>,
}

fn local_day(at: DateTime<Utc>) -> NaiveDate {
    at.with_timezone(&Local).date_naive()
}

impl FileLogger {
    pub fn new(options: FileLoggerOptions) -> Self {
        Self {
            options,
            state: Mutex::new(FileState::default()),
        }
    }

    /// The logger scoped to the file name (`[main]`), like the TS root logger.
    pub fn root(&self) -> Scoped<'_> {
        Scoped {
            logger: self,
            scope: self.options.file_name.clone(),
        }
    }

    fn file_at(&self, index: usize) -> PathBuf {
        let name = &self.options.file_name;
        self.options.dir.join(if index == 0 {
            format!("{name}.log")
        } else {
            format!("{name}.{index}.log")
        })
    }

    /// Writes one line; `meta` is already serialized.
    pub fn write(&self, level: LogLevel, scope: &str, message: &str, meta: Option<&str>) {
        if level < self.options.min_level {
            return;
        }
        let now = (self.options.now)();
        let meta = meta.map(|meta| format!(" {meta}")).unwrap_or_default();
        let line = format!(
            "{} {} [{scope}] {message}{meta}\n",
            now.to_rfc3339_opts(SecondsFormat::Millis, true),
            level.label()
        );
        if self.options.mirror_to_console {
            eprintln!("{}", line.trim_end());
        }
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        // Logging is best-effort; a broken log folder must not take the app down.
        let _ = self.append(&mut state, &line, local_day(now));
    }

    fn append(&self, state: &mut FileState, line: &str, today: NaiveDate) -> io::Result<()> {
        let size = match state.size {
            Some(size) => size,
            None => {
                fs::create_dir_all(&self.options.dir)?;
                let (size, day) = match fs::metadata(self.file_at(0)) {
                    Ok(meta) => (
                        meta.len(),
                        meta.modified()
                            .ok()
                            .map(|at| DateTime::<Local>::from(at).date_naive()),
                    ),
                    Err(_) => (0, None),
                };
                state.size = Some(size);
                state.day = day;
                size
            }
        };
        let bytes = line.len() as u64;
        let new_day = state.day.is_some_and(|day| day != today);
        if size > 0 && (size + bytes > self.options.max_bytes || new_day) {
            self.rotate(state)?;
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.file_at(0))?
            .write_all(line.as_bytes())?;
        state.size = Some(state.size.unwrap_or(0) + bytes);
        state.day = Some(today);
        Ok(())
    }

    fn rotate(&self, state: &mut FileState) -> io::Result<()> {
        let max_files = self.options.max_files.max(1);
        let _ = fs::remove_file(self.file_at(max_files - 1));
        for index in (0..max_files - 1).rev() {
            if self.file_at(index).exists() {
                fs::rename(self.file_at(index), self.file_at(index + 1))?;
            }
        }
        state.size = Some(0);
        Ok(())
    }
}

/// A logger bound to a scope (`main:ipc`); `child` appends to it.
pub struct Scoped<'a> {
    logger: &'a FileLogger,
    scope: String,
}

impl Scoped<'_> {
    pub fn child(&self, scope: &str) -> Scoped<'_> {
        Scoped {
            logger: self.logger,
            scope: format!("{}:{scope}", self.scope),
        }
    }

    pub fn log<M: Serialize + ?Sized>(&self, level: LogLevel, message: &str, meta: Option<&M>) {
        let meta = meta
            .map(|meta| serde_json::to_string(meta).unwrap_or_else(|_| "[unserializable]".into()));
        self.logger
            .write(level, &self.scope, message, meta.as_deref());
    }

    pub fn debug(&self, message: &str) {
        self.log(LogLevel::Debug, message, None::<&Value>);
    }

    pub fn info(&self, message: &str) {
        self.log(LogLevel::Info, message, None::<&Value>);
    }

    pub fn warn(&self, message: &str) {
        self.log(LogLevel::Warn, message, None::<&Value>);
    }

    pub fn error(&self, message: &str) {
        self.log(LogLevel::Error, message, None::<&Value>);
    }
}

/// `{ name, message }` of an error, for log metadata (Rust has no stack to add).
pub fn error_meta<E: std::error::Error + ?Sized>(error: &E) -> Value {
    let full = std::any::type_name::<E>();
    let base = full.split('<').next().unwrap_or(full);
    let name = base.rsplit("::").next().unwrap_or(base);
    json!({ "name": name, "message": error.to_string() })
}

/// Reduces a URL to origin + path (no query, hash or credentials) before it reaches a log file.
/// An empty value gives an empty string (`null` in TS); an unparsable one `[invalid url]`.
pub fn url_for_log(url: &str) -> String {
    url_for_log_max(url, 200)
}

pub fn url_for_log_max(url: &str, max_length: usize) -> String {
    if url.is_empty() {
        return String::new();
    }
    let Ok(url) = Url::parse(url) else {
        return "[invalid url]".into();
    };
    let base = if url.scheme() == "file" {
        format!("file://{}", url.path())
    } else {
        format!("{}{}", url.origin().ascii_serialization(), url.path())
    };
    base.chars().take(max_length).collect()
}

fn is_crate_target(target: &str) -> bool {
    target == CRATE_TARGET
        || target
            .strip_prefix(CRATE_TARGET)
            .is_some_and(|rest| rest.starts_with("::"))
}

/// The `[scope]` a `log` record is written under: `main`, then the module path without the crate
/// name (`main:notch:runtime`), or the other crate's target.
pub fn scope_for_target(target: &str) -> String {
    let rest = if is_crate_target(target) {
        target
            .strip_prefix(CRATE_TARGET)
            .unwrap_or_default()
            .trim_start_matches(':')
    } else {
        target
    };
    if rest.is_empty() {
        LOG_FILE_NAME.into()
    } else {
        format!("{LOG_FILE_NAME}:{}", rest.replace("::", ":"))
    }
}

/// The crates that tokenize mail HTML (`gmail/html_text.rs`): their `debug`/`trace` records
/// carry the text they read, i.e. mail bodies.
const SILENCED_CRATES: [&str; 5] = [
    "html5ever",
    "markup5ever",
    "tendril",
    "string_cache",
    "web_atoms",
];

/// A record of a crate that may carry mail content: never written, whatever the level (the app
/// logger and the test capture both drop it).
pub fn is_silenced_target(target: &str) -> bool {
    let krate = target.split("::").next().unwrap_or(target);
    SILENCED_CRATES.contains(&krate)
}

/// Every record of this crate from `debug` up is kept; other crates only reach the file from
/// `warn` up, and the HTML crates of [`SILENCED_CRATES`] never do.
pub fn target_enabled(target: &str, level: log::Level) -> bool {
    if is_silenced_target(target) {
        false
    } else if is_crate_target(target) {
        level <= log::Level::Debug
    } else {
        level <= log::Level::Warn
    }
}

/// The `log` facade over the file logger.
struct LogBridge(FileLogger);

impl log::Log for LogBridge {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        target_enabled(metadata.target(), metadata.level())
    }

    fn log(&self, record: &log::Record<'_>) {
        if !self.enabled(record.metadata()) {
            return;
        }
        self.0.write(
            LogLevel::from_log(record.level()),
            &scope_for_target(record.target()),
            &record.args().to_string(),
            None,
        );
    }

    fn flush(&self) {}
}

/// Installs the file logger behind the `log` macros: `<dir>/main.log`, mirrored to stderr when
/// `mirror` (debug builds). Only the first call does anything.
pub fn init_logger(dir: PathBuf, mirror: bool) {
    let mut options = FileLoggerOptions::new(dir);
    options.mirror_to_console = mirror;
    // Lives for the rest of the process, like the facade itself.
    let bridge: &'static LogBridge = Box::leak(Box::new(LogBridge(FileLogger::new(options))));
    if log::set_logger(bridge).is_ok() {
        log::set_max_level(log::LevelFilter::Debug);
    }
}

#[cfg(test)]
mod tests {
    use std::fmt;

    use chrono::TimeZone;
    use serde::Serializer;
    use serde_json::json;

    use super::*;
    use crate::services::test_dir::TestDir;

    fn fixed_now() -> LogClock {
        Arc::new(|| Utc.with_ymd_and_hms(2026, 11, 9, 10, 0, 0).unwrap())
    }

    fn logger(dir: &TestDir, tune: impl FnOnce(&mut FileLoggerOptions)) -> FileLogger {
        let mut options = FileLoggerOptions::new(dir.path().to_path_buf());
        options.now = fixed_now();
        tune(&mut options);
        FileLogger::new(options)
    }

    fn read(dir: &TestDir, name: &str) -> String {
        std::fs::read_to_string(dir.join(name)).unwrap()
    }

    #[derive(Debug)]
    struct TypeError;

    impl fmt::Display for TypeError {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("bad")
        }
    }

    impl std::error::Error for TypeError {}

    #[test]
    fn writes_timestamped_scoped_lines_with_metadata() {
        let dir = TestDir::new("logs");
        let logger = logger(&dir, |_| {});
        logger.root().child("ipc").log(
            LogLevel::Warn,
            "Rejected sender",
            Some(&json!({ "url": "https://evil.test" })),
        );
        assert_eq!(
            read(&dir, "main.log"),
            "2026-11-09T10:00:00.000Z WARN [main:ipc] Rejected sender {\"url\":\"https://evil.test\"}\n"
        );
    }

    #[test]
    fn serializes_errors_with_name_and_message() {
        let dir = TestDir::new("logs");
        let logger = logger(&dir, |_| {});
        logger.root().log(
            LogLevel::Error,
            "Boom",
            Some(&json!({ "error": error_meta(&TypeError) })),
        );
        // `preserve_order`: keys in insertion order, like Electron's `{ name, message }`.
        assert!(read(&dir, "main.log").contains(r#""error":{"name":"TypeError","message":"bad"}"#));
    }

    #[test]
    fn drops_entries_below_the_minimum_level() {
        let dir = TestDir::new("logs");
        let logger = logger(&dir, |o| o.min_level = LogLevel::Info);
        logger.root().debug("hidden");
        logger.root().info("shown");
        let text = read(&dir, "main.log");
        assert!(!text.contains("hidden"));
        assert!(text.contains("shown"));
    }

    #[test]
    fn rotates_files_when_the_size_limit_is_reached_and_keeps_a_bounded_history() {
        let dir = TestDir::new("logs");
        let logger = logger(&dir, |o| {
            o.max_bytes = 200;
            o.max_files = 3;
        });
        for i in 0..40 {
            logger
                .root()
                .info(&format!("entry {i:02} {}", "x".repeat(40)));
        }
        assert!(dir.join("main.log").exists());
        assert!(dir.join("main.1.log").exists());
        assert!(dir.join("main.2.log").exists());
        assert!(!dir.join("main.3.log").exists());
        let text = read(&dir, "main.log");
        assert!(text.contains("entry 39"));
        assert!(text.len() <= 200);
    }

    #[test]
    fn starts_a_new_file_when_the_day_changes() {
        let dir = TestDir::new("logs");
        let day = Arc::new(std::sync::atomic::AtomicI64::new(9));
        let clock_day = Arc::clone(&day);
        let logger = logger(&dir, move |o| {
            o.now = Arc::new(move || {
                let d = clock_day.load(std::sync::atomic::Ordering::SeqCst);
                Utc.with_ymd_and_hms(2026, 11, d as u32, 10, 0, 0).unwrap()
            });
        });
        logger.root().info("monday");
        logger.root().info("monday again");
        day.store(10, std::sync::atomic::Ordering::SeqCst);
        logger.root().info("tuesday");
        assert!(read(&dir, "main.1.log").contains("monday again"));
        assert_eq!(
            read(&dir, "main.log"),
            "2026-11-10T10:00:00.000Z INFO [main] tuesday\n"
        );
    }

    struct Unserializable;

    impl Serialize for Unserializable {
        fn serialize<S: Serializer>(&self, _serializer: S) -> Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom("circular"))
        }
    }

    #[test]
    fn never_throws_when_metadata_cannot_be_serialized() {
        let dir = TestDir::new("logs");
        let logger = logger(&dir, |_| {});
        logger
            .root()
            .log(LogLevel::Info, "circular", Some(&Unserializable));
        assert!(read(&dir, "main.log").contains("circular [unserializable]"));
    }

    #[test]
    fn never_throws_when_the_log_folder_is_unusable() {
        let dir = TestDir::new("logs");
        std::fs::write(dir.join("file-not-folder"), "x").unwrap();
        let mut options = FileLoggerOptions::new(dir.join("file-not-folder"));
        options.now = fixed_now();
        let logger = FileLogger::new(options);
        logger.root().error("still fine");
        logger.root().error("still fine again");
    }

    #[test]
    fn url_for_log_keeps_only_origin_and_path() {
        assert_eq!(
            url_for_log("https://user:secret@example.com:8443/a/b?token=1#frag"),
            "https://example.com:8443/a/b"
        );
        assert_eq!(
            url_for_log("http://tauri.localhost/notch/index.html?x=1"),
            "http://tauri.localhost/notch/index.html"
        );
        assert_eq!(
            url_for_log("file:///C:/Users/me/app/index.html?q"),
            "file:///C:/Users/me/app/index.html"
        );
        // Non-special schemes have an opaque origin, serialized as `null` like in JS.
        assert_eq!(url_for_log("tauri://localhost/x"), "null/x");
        assert_eq!(url_for_log("not a url"), "[invalid url]");
        assert_eq!(url_for_log(""), "");
        let long = format!("https://example.com/{}", "a".repeat(300));
        assert_eq!(url_for_log(&long).len(), 200);
        assert_eq!(
            url_for_log_max("https://example.com/abc", 22),
            "https://example.com/ab"
        );
    }

    #[test]
    fn scopes_follow_the_record_target() {
        assert_eq!(scope_for_target("developer_notch_lib"), "main");
        assert_eq!(
            scope_for_target("developer_notch_lib::notch::runtime"),
            "main:notch:runtime"
        );
        assert_eq!(
            scope_for_target("developer_notch_lib::services::usage"),
            "main:services:usage"
        );
        assert_eq!(scope_for_target("tao::platform"), "main:tao:platform");
    }

    #[test]
    fn other_crates_reach_the_file_only_from_warn() {
        assert!(target_enabled(
            "developer_notch_lib::ipc",
            log::Level::Debug
        ));
        assert!(!target_enabled("tauri", log::Level::Info));
        assert!(!target_enabled(
            "developer_notch_lib::ipc",
            log::Level::Trace
        ));
        assert!(!target_enabled("tao::platform", log::Level::Info));
        assert!(target_enabled("tao::platform", log::Level::Warn));
    }

    #[test]
    fn the_html_crates_never_reach_the_file() {
        for target in [
            "html5ever::tokenizer",
            "html5ever",
            "markup5ever::util::buffer_queue",
            "tendril",
            "string_cache::atom",
            "web_atoms",
        ] {
            for level in [log::Level::Error, log::Level::Warn, log::Level::Trace] {
                assert!(!target_enabled(target, level), "{target} {level}");
            }
        }
        // Only the crate name counts, not a prefix of it.
        assert!(target_enabled("html5everything", log::Level::Warn));
    }
}
