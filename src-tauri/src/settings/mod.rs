//! User settings. The types are in [`crate::contract::settings`].

pub mod defaults;
pub mod store;
pub mod update;
pub mod validate;

use std::ffi::OsString;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

pub use defaults::default_settings;
pub use store::SettingsStore;

/// Test-only override of the data directory.
const DATA_DIR_ENV: &str = "NOTCH_USER_DATA_DIR";

fn resolve_data_dir(default: PathBuf, over: Option<OsString>, allow_override: bool) -> PathBuf {
    match over {
        Some(dir) if allow_override && !dir.is_empty() => PathBuf::from(dir),
        _ => default,
    }
}

/// Where the app keeps its files: `app_data_dir`, overridden by `NOTCH_USER_DATA_DIR` only in
/// debug and `e2e` builds (never in release).
pub fn data_dir(app: &AppHandle) -> PathBuf {
    let default = app
        .path()
        .app_data_dir()
        .expect("the platform has an app data directory");
    resolve_data_dir(
        default,
        std::env::var_os(DATA_DIR_ENV),
        cfg!(debug_assertions) || cfg!(feature = "e2e"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_dir_override_only_when_allowed() {
        let default = PathBuf::from("default");
        let over = Some(OsString::from("custom"));
        assert_eq!(
            resolve_data_dir(default.clone(), over.clone(), true),
            PathBuf::from("custom")
        );
        assert_eq!(resolve_data_dir(default.clone(), over, false), default);
        assert_eq!(resolve_data_dir(default.clone(), None, true), default);
    }
}
