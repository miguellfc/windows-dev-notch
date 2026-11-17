//! Services shared by the main-process modules.

pub mod clock;
pub mod dpapi;
pub mod fs_atomic;
pub mod json_store;
pub mod logger;
pub mod quit;
pub mod secure_token_store;
pub mod tasks;
#[cfg(test)]
pub(crate) mod test_dir;
#[cfg(test)]
pub(crate) mod test_log;
pub mod timers;
pub mod usage;

use std::path::{Path, PathBuf};

use chrono::{DateTime, SecondsFormat, Utc};

/// Where a file the app cannot understand is moved aside (settings, notes, reminders):
/// `<stem>.corrupt-<toISOString() with ':' and '.' as '-'>.json` next to `path`.
pub fn quarantine_path(path: &Path, now: DateTime<Utc>) -> PathBuf {
    let stamp = now
        .to_rfc3339_opts(SecondsFormat::Millis, true)
        .replace([':', '.'], "-");
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!("{stem}.corrupt-{stamp}.json"))
}
