//! Installs and removes the bridge's HTTP hooks in Claude Code's `settings.json` (port of
//! 0.1.0's `hook-installer.ts`): pure planning functions that work on the file's text,
//! and [`HookInstaller`], the adapter that reads, backs up and atomically writes the file.
//!
//! A group of ours is one whose hooks are all `type: "http"` with the `x-notch-hook: 1` header;
//! a mixed group is someone else's and is never touched. Files that are not a JSON object whose
//! `hooks` is an object of arrays (bad JSON, a BOM, other shapes) are refused untouched, and so
//! are files that are not valid UTF-8 (Node would decode them lossily; reading one is an error
//! here, so a file we could not read faithfully is never rewritten).
//!
//! The written text is `JSON.stringify(settings, null, 2) + "\n"` byte for byte (see
//! [`js_json::stringify_pretty`]), with CRLF line endings when the file had them. JSON equality
//! follows `util.isDeepStrictEqual` on parsed values: key order is ignored and numbers compare as
//! doubles (`1` equals `1.0`; `-0` does not equal `0`). JSON that serde_json refuses but
//! `JSON.parse` takes (lone surrogate escapes, numbers beyond f64, nesting deeper than 128) is
//! refused as invalid.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Local, Utc};
use serde_json::{json, Map, Value};

pub use super::diff::{diff_lines, mask_diff};
use super::hook_events::{HookEventName, ASK_USER_QUESTION_TOOL, HOOK_EVENT_NAMES};
use super::js_json;
pub use crate::contract::claude::{DiffKind, DiffLine};
use crate::contract::string_enum;
use crate::services::fs_atomic::write_atomic;

string_enum! {
    /// `HookStatus`.
    pub enum HookStatus {
        Installed = "installed",
        Outdated = "outdated",
        Missing = "missing",
    }
}

/// `HookInstallOptions`: where the bridge listens and the token Claude must send.
#[derive(Clone, PartialEq, Eq)]
pub struct HookInstallOptions {
    pub port: u16,
    pub token: String,
}

/// Never shows the token (like `BridgeConfig`).
impl std::fmt::Debug for HookInstallOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HookInstallOptions")
            .field("port", &self.port)
            .field("token", &"••••••")
            .finish()
    }
}

/// The planned settings text and its diff from the current one.
#[derive(Clone, PartialEq, Eq)]
pub struct Plan {
    pub next: String,
    pub diff: Vec<DiffLine>,
}

/// The planned text and the diff carry the token: only their sizes are shown.
impl std::fmt::Debug for Plan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Plan")
            .field("next", &format_args!("<{} bytes>", self.next.len()))
            .field("diff", &format_args!("<{} lines>", self.diff.len()))
            .finish()
    }
}

/// `{ ok: false, reason: 'invalid-json' }`: the settings file was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidJson;

/// `HookPlan`.
pub type HookPlan = Result<Plan, InvalidJson>;

/// `{ ok: true, changed, diff, backupFile? }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WriteOutcome {
    pub changed: bool,
    pub diff: Vec<DiffLine>,
    pub backup_file: Option<PathBuf>,
}

/// `HookWriteResult`.
pub type HookWriteResult = Result<WriteOutcome, InvalidJson>;

const HOOK_MARKER_HEADER: &str = "x-notch-hook";
const TOKEN_HEADER: &str = "x-notch-token";
const PERMISSION_TIMEOUT_SECONDS: u32 = 3600;
const QUESTION_TIMEOUT_SECONDS: u32 = 3600;
const DEFAULT_TIMEOUT_SECONDS: u32 = 2;

/// The pre-install text, kept in the backup directory to restore it byte for byte.
pub const ORIGINAL_FILE: &str = "notch-hooks.original.json";
/// Older `settings.backup-*.json` files beyond this many are deleted.
pub const MAX_BACKUPS: usize = 10;

type Json = Map<String, Value>;

fn is_our_hook(hook: &Value) -> bool {
    hook.as_object().is_some_and(|hook| {
        hook.get("type") == Some(&Value::from("http"))
            && hook
                .get("headers")
                .and_then(Value::as_object)
                .is_some_and(|headers| headers.get(HOOK_MARKER_HEADER) == Some(&Value::from("1")))
    })
}

/// A group is ours iff it has hooks and every one of them is one of ours.
fn is_our_group(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| !hooks.is_empty() && hooks.iter().all(is_our_hook))
        && group.is_object()
}

fn our_hook(options: &HookInstallOptions, path: &str, timeout: u32) -> Value {
    json!({
        "type": "http",
        "url": format!("http://127.0.0.1:{}{path}", options.port),
        "headers": { TOKEN_HEADER: options.token, HOOK_MARKER_HEADER: "1" },
        "timeout": timeout,
    })
}

fn our_group(event: HookEventName, options: &HookInstallOptions) -> Value {
    let timeout = if event == HookEventName::PermissionRequest {
        PERMISSION_TIMEOUT_SECONDS
    } else {
        DEFAULT_TIMEOUT_SECONDS
    };
    json!({ "hooks": [our_hook(options, "/hook", timeout)] })
}

/// Claude waits on this one while the user answers in the notch (the bridge holds /hook/question).
fn question_group(options: &HookInstallOptions) -> Value {
    json!({
        "matcher": ASK_USER_QUESTION_TOOL,
        "hooks": [our_hook(options, "/hook/question", QUESTION_TIMEOUT_SECONDS)],
    })
}

/// Every group of ours an event must have, in order.
fn our_groups(event: HookEventName, options: &HookInstallOptions) -> Vec<Value> {
    if event == HookEventName::PreToolUse {
        vec![our_group(event, options), question_group(options)]
    } else {
        vec![our_group(event, options)]
    }
}

/// Parses settings text into a top-level object whose `hooks` (when present) is an object of
/// arrays. Anything else (bad JSON, BOM, other shapes) is refused so we never rewrite a file we
/// do not fully understand.
pub fn parse_settings(text: &str) -> Option<Json> {
    if text.starts_with('\u{feff}') {
        return None;
    }
    let Value::Object(settings) = serde_json::from_str::<Value>(text).ok()? else {
        return None;
    };
    if let Some(hooks) = settings.get("hooks") {
        if !hooks.as_object()?.values().all(Value::is_array) {
            return None;
        }
    }
    Some(settings)
}

/// `util.isDeepStrictEqual` on two parsed JSON values.
fn js_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let (x, y) = (x.as_f64().unwrap_or(0.0), y.as_f64().unwrap_or(0.0));
            // `Object.is`: `-0` and `0` differ.
            x == y && x.is_sign_negative() == y.is_sign_negative()
        }
        (Value::Array(x), Value::Array(y)) => js_equal_lists(x, y),
        (Value::Object(x), Value::Object(y)) => js_equal_maps(x, y),
        _ => a == b,
    }
}

/// Same keys (in any order) with deep-equal values.
fn js_equal_maps(a: &Json, b: &Json) -> bool {
    a.len() == b.len()
        && a.iter()
            .all(|(key, value)| b.get(key).is_some_and(|other| js_equal(value, other)))
}

fn js_equal_lists(a: &[Value], b: &[Value]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| js_equal(x, y))
}

fn line_ending(text: Option<&str>) -> &'static str {
    if text.is_some_and(|text| text.contains("\r\n")) {
        "\r\n"
    } else {
        "\n"
    }
}

/// `JSON.stringify(value, null, 2) + '\n'` with `eol` line endings.
fn serialize(value: Json, eol: &str) -> String {
    let body = format!("{}\n", js_json::stringify_pretty(&Value::Object(value)));
    if eol == "\n" {
        body
    } else {
        body.replace('\n', eol)
    }
}

/// Returns `settings` without any group of ours, and whether something was removed. Event arrays
/// (and `hooks`) that we emptied are dropped unless they already existed in `original`.
fn without_ours(mut settings: Json, original: Option<&Json>) -> (Json, bool) {
    let Some(current_hooks) = settings.get("hooks").and_then(Value::as_object) else {
        return (settings, false);
    };
    let original_hooks = original
        .and_then(|original| original.get("hooks"))
        .and_then(Value::as_object);
    let mut hooks = Json::new();
    let mut removed = false;
    for (event, groups) in current_hooks {
        let list = groups.as_array().map(Vec::as_slice).unwrap_or_default();
        let kept: Vec<Value> = list
            .iter()
            .filter(|group| !is_our_group(group))
            .cloned()
            .collect();
        if kept.len() == list.len() {
            hooks.insert(event.clone(), groups.clone());
            continue;
        }
        removed = true;
        if !kept.is_empty() || original_hooks.is_some_and(|hooks| hooks.contains_key(event)) {
            hooks.insert(event.clone(), Value::Array(kept));
        }
    }
    if !removed {
        return (settings, false);
    }
    if !hooks.is_empty() || original.is_some_and(|original| original.contains_key("hooks")) {
        settings.insert("hooks".into(), Value::Object(hooks));
    } else {
        // `shift_remove`: the keys after `hooks` keep their order.
        settings.shift_remove("hooks");
    }
    (settings, true)
}

/// `planInstall`: `current` is `None` when the file does not exist.
pub fn plan_install(current: Option<&str>, options: &HookInstallOptions) -> HookPlan {
    let mut settings = match current {
        None => Json::new(),
        Some(text) => parse_settings(text).ok_or(InvalidJson)?,
    };
    let mut hooks = Json::new();
    if let Some(existing) = settings.get("hooks").and_then(Value::as_object) {
        for (event, groups) in existing {
            let list = groups.as_array().map(Vec::as_slice).unwrap_or_default();
            let kept: Vec<Value> = list
                .iter()
                .filter(|group| !is_our_group(group))
                .cloned()
                .collect();
            // An event key that only held our (stale) groups is rebuilt below or dropped.
            if !kept.is_empty() || kept.len() == list.len() {
                hooks.insert(event.clone(), Value::Array(kept));
            }
        }
    }
    for &event in HOOK_EVENT_NAMES {
        let mut groups = match hooks.get_mut(event.as_str()).map(Value::take) {
            Some(Value::Array(existing)) => existing,
            _ => Vec::new(),
        };
        groups.extend(our_groups(event, options));
        // Replaces in place, or appends a new event after the existing ones.
        hooks.insert(event.as_str().into(), Value::Array(groups));
    }
    // Replaces `hooks` in place, or appends it when absent.
    settings.insert("hooks".into(), Value::Object(hooks));
    let next = serialize(settings, line_ending(current));
    let diff = diff_lines(current.unwrap_or(""), &next);
    Ok(Plan { next, diff })
}

/// `planUninstall`: `original` is the exact pre-install text. When removing our groups yields JSON
/// equal to it, that text is returned byte for byte.
pub fn plan_uninstall(current: &str, original: Option<&str>) -> HookPlan {
    let settings = parse_settings(current).ok_or(InvalidJson)?;
    let original_settings = original.and_then(parse_settings);
    let (value, removed) = without_ours(settings, original_settings.as_ref());
    if !removed {
        return Ok(Plan {
            next: current.to_owned(),
            diff: diff_lines(current, current),
        });
    }
    let next = match (original, &original_settings) {
        (Some(original), Some(original_settings)) if js_equal_maps(&value, original_settings) => {
            original.to_owned()
        }
        _ => serialize(value, line_ending(Some(current))),
    };
    let diff = diff_lines(current, &next);
    Ok(Plan { next, diff })
}

/// `hookStatus`: `installed` only when every event has exactly our groups for these options.
pub fn hook_status(current: Option<&str>, options: &HookInstallOptions) -> HookStatus {
    let Some(settings) = current.and_then(parse_settings) else {
        return HookStatus::Missing;
    };
    let Some(hooks) = settings.get("hooks").and_then(Value::as_object) else {
        return HookStatus::Missing;
    };
    let mut any_ours = false;
    let mut all_exact = true;
    for (event, groups) in hooks {
        let ours: Vec<Value> = groups
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter(|group| is_our_group(group))
            .cloned()
            .collect();
        any_ours |= !ours.is_empty();
        let exact = match HookEventName::from_name(event) {
            Some(event) => js_equal_lists(&ours, &our_groups(event, options)),
            None => ours.is_empty(),
        };
        all_exact &= exact;
    }
    if !any_ours {
        return HookStatus::Missing;
    }
    let covered = HOOK_EVENT_NAMES
        .iter()
        .all(|event| hooks.contains_key(event.as_str()));
    if all_exact && covered {
        HookStatus::Installed
    } else {
        HookStatus::Outdated
    }
}

// --- Adapter ---------------------------------------------------------------

/// The file's text, `None` when it does not exist. Text that is not valid UTF-8 is an
/// `InvalidData` error rather than a lossy decode, so such a file is never rewritten.
pub async fn read_text_opt(path: &Path) -> io::Result<Option<String>> {
    match tokio::fs::read(path).await {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "the file is not valid UTF-8")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// `path` without a `\\?\` (drive paths) or `\\?\UNC\` (shares → `\\`) prefix, as Node's
/// `realpath` returns it. Other verbatim paths (volume GUIDs) stay as they are.
#[cfg(windows)]
pub fn strip_verbatim(path: PathBuf) -> PathBuf {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    let wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    let unc: Vec<u16> = r"\\?\UNC\".encode_utf16().collect();
    let verbatim: Vec<u16> = r"\\?\".encode_utf16().collect();
    if wide.starts_with(&unc) {
        let mut plain: Vec<u16> = r"\\".encode_utf16().collect();
        plain.extend_from_slice(&wide[unc.len()..]);
        return PathBuf::from(OsString::from_wide(&plain));
    }
    let rest = wide.strip_prefix(verbatim.as_slice()).unwrap_or_default();
    let is_drive =
        |unit: u16| char::from_u32(u32::from(unit)).is_some_and(|c| c.is_ascii_alphabetic());
    if rest.len() >= 2 && is_drive(rest[0]) && rest[1] == u16::from(b':') {
        return PathBuf::from(OsString::from_wide(rest));
    }
    path
}

/// Verbatim prefixes only exist on Windows.
#[cfg(not(windows))]
pub fn strip_verbatim(path: PathBuf) -> PathBuf {
    path
}

/// The real path behind a (possibly symlinked) file; the path itself when it does not exist yet.
pub fn resolve_real_path(path: &Path) -> io::Result<PathBuf> {
    match std::fs::canonicalize(path) {
        Ok(real) => Ok(strip_verbatim(real)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(path.to_path_buf()),
        Err(error) => Err(error),
    }
}

type NowFn = Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>;
type RealPathFn = Arc<dyn Fn(&Path) -> io::Result<PathBuf> + Send + Sync>;

/// `createHookInstaller`: reads, backs up and writes `file` (resolved through symlinks first).
/// Backups and the pre-install original live in `backup_dir`.
pub struct HookInstaller {
    file: PathBuf,
    backup_dir: PathBuf,
    now: NowFn,
    realpath: RealPathFn,
}

/// `settings.backup-YYYYMMDD-HHMMSS[-N].json`: the stamp and the same-second number (1 without
/// a suffix), as `Number(...)` reads it.
fn backup_name(name: &str) -> Option<(&str, f64)> {
    let middle = name
        .strip_prefix("settings.backup-")?
        .strip_suffix(".json")?;
    let bytes = middle.as_bytes();
    let digits = |range: std::ops::Range<usize>| bytes[range].iter().all(u8::is_ascii_digit);
    if bytes.len() < 15 || !digits(0..8) || bytes[8] != b'-' || !digits(9..15) {
        return None;
    }
    let (stamp, suffix) = middle.split_at(15);
    if suffix.is_empty() {
        return Some((stamp, 1.0));
    }
    let number = suffix.strip_prefix('-')?;
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some((stamp, number.parse().ok()?))
}

impl HookInstaller {
    /// `now` stamps the backups (in local time).
    pub fn new(
        file: PathBuf,
        backup_dir: PathBuf,
        now: impl Fn() -> DateTime<Utc> + Send + Sync + 'static,
    ) -> Self {
        Self {
            file,
            backup_dir,
            now: Arc::new(now),
            realpath: Arc::new(resolve_real_path),
        }
    }

    /// Replaces [`resolve_real_path`] (tests).
    pub fn with_realpath(
        mut self,
        realpath: impl Fn(&Path) -> io::Result<PathBuf> + Send + Sync + 'static,
    ) -> Self {
        self.realpath = Arc::new(realpath);
        self
    }

    fn target(&self) -> io::Result<PathBuf> {
        (self.realpath)(&self.file)
    }

    fn original_path(&self) -> PathBuf {
        self.backup_dir.join(ORIGINAL_FILE)
    }

    /// Deletes all but the [`MAX_BACKUPS`] newest backups (by stamp, then same-second number).
    async fn prune_backups(&self) -> io::Result<()> {
        let mut backups: Vec<(String, String, f64)> = Vec::new();
        let mut entries = tokio::fs::read_dir(&self.backup_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let Ok(name) = entry.file_name().into_string() else {
                continue;
            };
            if let Some((stamp, number)) = backup_name(&name) {
                backups.push((name.clone(), stamp.to_owned(), number));
            }
        }
        backups.sort_by(|(_, a_stamp, a_n), (_, b_stamp, b_n)| {
            b_stamp.cmp(a_stamp).then_with(|| b_n.total_cmp(a_n))
        });
        for (name, _, _) in backups.iter().skip(MAX_BACKUPS) {
            match tokio::fs::remove_file(self.backup_dir.join(name)).await {
                Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
                _ => {}
            }
        }
        Ok(())
    }

    /// Saves `current` as a new backup (none when the file did not exist) and prunes old ones.
    async fn backup(&self, current: Option<&str>) -> io::Result<Option<PathBuf>> {
        let Some(current) = current else {
            return Ok(None);
        };
        let stamp = (self.now)()
            .with_timezone(&Local)
            .format("%Y%m%d-%H%M%S")
            .to_string();
        let mut path = self
            .backup_dir
            .join(format!("settings.backup-{stamp}.json"));
        // Several writes in the same second must not overwrite each other's backup.
        let mut n = 2;
        while tokio::fs::try_exists(&path).await? {
            path = self
                .backup_dir
                .join(format!("settings.backup-{stamp}-{n}.json"));
            n += 1;
        }
        write_atomic(&path, current.as_bytes()).await?;
        // Old backups that cannot be deleted must not block the write itself.
        if let Err(error) = self.prune_backups().await {
            log::warn!(
                "Could not prune old Claude settings backups ({:?})",
                error.kind()
            );
        }
        Ok(Some(path))
    }

    /// The install plan for the file as it is now; nothing is written.
    pub async fn preview(&self, options: &HookInstallOptions) -> io::Result<HookPlan> {
        let current = read_text_opt(&self.target()?).await?;
        Ok(plan_install(current.as_deref(), options))
    }

    pub async fn install(&self, options: &HookInstallOptions) -> io::Result<HookWriteResult> {
        let file = self.target()?;
        let current = read_text_opt(&file).await?;
        let Plan { next, diff } = match plan_install(current.as_deref(), options) {
            Ok(plan) => plan,
            Err(invalid) => return Ok(Err(invalid)),
        };
        if current.as_deref() == Some(next.as_str()) {
            return Ok(Ok(WriteOutcome {
                changed: false,
                diff,
                backup_file: None,
            }));
        }
        let backup_file = self.backup(current.as_deref()).await?;
        // Keep the pre-install text only while none of our groups exist yet; a reinstall must not
        // replace it with a file that already contains them.
        let already_ours = current
            .as_deref()
            .is_some_and(|text| hook_status(Some(text), options) != HookStatus::Missing);
        let original_path = self.original_path();
        if !already_ours || !tokio::fs::try_exists(&original_path).await? {
            let original = current.as_deref().unwrap_or("{}\n");
            write_atomic(&original_path, original.as_bytes()).await?;
        }
        write_atomic(&file, next.as_bytes()).await?;
        Ok(Ok(WriteOutcome {
            changed: true,
            diff,
            backup_file,
        }))
    }

    pub async fn uninstall(&self) -> io::Result<HookWriteResult> {
        let file = self.target()?;
        let Some(current) = read_text_opt(&file).await? else {
            return Ok(Ok(WriteOutcome {
                changed: false,
                diff: Vec::new(),
                backup_file: None,
            }));
        };
        // An unreadable original (locked, a directory, not UTF-8) only loses the byte-for-byte
        // restore: the uninstall still removes our groups by re-serializing.
        let original = match read_text_opt(&self.original_path()).await {
            Ok(original) => original,
            Err(error) => {
                log::warn!(
                    "Could not read the stored original Claude settings ({:?})",
                    error.kind()
                );
                None
            }
        };
        let Plan { next, diff } = match plan_uninstall(&current, original.as_deref()) {
            Ok(plan) => plan,
            Err(invalid) => return Ok(Err(invalid)),
        };
        if next == current {
            return Ok(Ok(WriteOutcome {
                changed: false,
                diff,
                backup_file: None,
            }));
        }
        let backup_file = self.backup(Some(&current)).await?;
        write_atomic(&file, next.as_bytes()).await?;
        Ok(Ok(WriteOutcome {
            changed: true,
            diff,
            backup_file,
        }))
    }

    /// `hookStatus` of the file as it is now (an unreadable file is an error; the service shows
    /// `unknown`).
    pub async fn status(&self, options: &HookInstallOptions) -> io::Result<HookStatus> {
        let current = read_text_opt(&self.target()?).await?;
        Ok(hook_status(current.as_deref(), options))
    }
}

#[cfg(test)]
mod tests;
