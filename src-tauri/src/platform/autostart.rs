//! Start with Windows (`src/main/platform/auto-launch.ts`), through `tauri-plugin-autostart`.

use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::AutoLaunchManager;

/// The part of the OS login items this module needs (the plugin, or a fake in tests).
pub trait LoginItems {
    fn set(&self, enabled: bool) -> Result<(), String>;
    fn get(&self) -> Result<bool, String>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LaunchAtLoginResult {
    Applied,
    /// Development builds (and the `e2e` build) never touch the OS.
    NotPackaged,
    /// The OS did not take the change.
    Rejected,
}

/// Like `app.isPackaged`: registering a development build would launch it at every login.
pub fn launch_at_login_available() -> bool {
    !(cfg!(debug_assertions) || cfg!(feature = "e2e"))
}

/// Mirrors the setting into the OS when `packaged`.
pub fn sync_with(enabled: bool, packaged: bool, items: &dyn LoginItems) -> LaunchAtLoginResult {
    if !packaged {
        return LaunchAtLoginResult::NotPackaged;
    }
    if let Err(error) = items.set(enabled) {
        log::error!("Could not change start with Windows: {error}");
        return LaunchAtLoginResult::Rejected;
    }
    match items.get() {
        Ok(actual) if actual == enabled => LaunchAtLoginResult::Applied,
        Ok(_) => LaunchAtLoginResult::Rejected,
        Err(error) => {
            log::error!("Could not read start with Windows: {error}");
            LaunchAtLoginResult::Rejected
        }
    }
}

/// The plugin's `HKCU\...\Run` entry for the running executable.
struct PluginItems<'a>(&'a AutoLaunchManager);

impl LoginItems for PluginItems<'_> {
    fn set(&self, enabled: bool) -> Result<(), String> {
        let result = if enabled {
            self.0.enable()
        } else {
            self.0.disable()
        };
        result.map_err(|error| error.to_string())
    }

    fn get(&self) -> Result<bool, String> {
        self.0.is_enabled().map_err(|error| error.to_string())
    }
}

/// Mirrors the "start with Windows" setting into the OS; a no-op in development and `e2e`
/// builds. The settings updater logs an error result.
pub fn sync_launch_at_login(app: &AppHandle, enabled: bool) -> Result<(), String> {
    if !launch_at_login_available() {
        return Ok(());
    }
    let Some(manager) = app.try_state::<AutoLaunchManager>() else {
        return Err("the autostart plugin is not installed".into());
    };
    match sync_with(enabled, true, &PluginItems(&manager)) {
        LaunchAtLoginResult::Applied | LaunchAtLoginResult::NotPackaged => Ok(()),
        LaunchAtLoginResult::Rejected => Err("Windows did not accept the change".into()),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    struct FakeItems {
        enabled: Cell<bool>,
        applies: bool,
        calls: Cell<u32>,
    }

    impl FakeItems {
        fn new(applies: bool) -> Self {
            Self {
                enabled: Cell::new(false),
                applies,
                calls: Cell::new(0),
            }
        }
    }

    impl LoginItems for FakeItems {
        fn set(&self, enabled: bool) -> Result<(), String> {
            self.calls.set(self.calls.get() + 1);
            if self.applies {
                self.enabled.set(enabled);
            }
            Ok(())
        }

        fn get(&self) -> Result<bool, String> {
            Ok(self.enabled.get())
        }
    }

    #[test]
    fn does_nothing_in_development_builds() {
        let items = FakeItems::new(true);
        assert_eq!(
            sync_with(true, false, &items),
            LaunchAtLoginResult::NotPackaged
        );
        assert_eq!(items.calls.get(), 0);
    }

    #[test]
    fn enables_and_disables_in_the_installed_app() {
        let items = FakeItems::new(true);
        assert_eq!(sync_with(true, true, &items), LaunchAtLoginResult::Applied);
        assert!(items.enabled.get());
        assert_eq!(sync_with(false, true, &items), LaunchAtLoginResult::Applied);
        assert!(!items.enabled.get());
    }

    #[test]
    fn reports_when_windows_did_not_accept_the_change() {
        assert_eq!(
            sync_with(true, true, &FakeItems::new(false)),
            LaunchAtLoginResult::Rejected
        );
    }

    #[test]
    fn development_and_e2e_builds_are_not_packaged() {
        assert_eq!(
            launch_at_login_available(),
            !cfg!(debug_assertions) && !cfg!(feature = "e2e")
        );
    }
}
