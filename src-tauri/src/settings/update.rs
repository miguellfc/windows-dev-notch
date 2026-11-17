//! A settings change with its side effects (0.1.0's `settings-update.ts`).
//!
//! The shortcut is registered first (so a taken combination is never saved) and rolled back if
//! saving fails, keeping the registered shortcut and the saved one in sync. Start with Windows
//! is applied after a successful save and never undoes it.

use std::future::Future;
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::contract::settings::{Settings, SettingsPatch};
use crate::ipc::{ExposedError, IpcErrorCode};
use crate::platform::autostart::sync_launch_at_login;
use crate::platform::shortcut::{ShortcutControl, ShortcutError, ShortcutService};
use crate::settings::SettingsStore;

/// Applies `patch`: `save` writes it (the settings store), `sync_launch_at_login` mirrors start
/// with Windows into the OS.
pub async fn update_settings_with<F, Fut>(
    patch: SettingsPatch,
    save: F,
    shortcut: &dyn ShortcutControl,
    sync_launch_at_login: impl FnOnce(bool) -> Result<(), String>,
) -> Result<Settings, ExposedError>
where
    F: FnOnce(SettingsPatch) -> Fut,
    Fut: Future<Output = Result<Settings, ExposedError>>,
{
    let previous = shortcut.current();
    if let Some(accelerator) = &patch.shortcut {
        shortcut.apply(accelerator).map_err(|error| match error {
            ShortcutError::Unavailable => ExposedError::new(
                IpcErrorCode::Unavailable,
                "Shortcut is used by another application",
            ),
            ShortcutError::Invalid => {
                ExposedError::new(IpcErrorCode::InvalidInput, "Shortcut is not valid")
            }
        })?;
    }

    let launch_at_login_changed = patch.launch_at_login.is_some();
    let saved = match save(patch).await {
        Ok(saved) => saved,
        Err(error) => {
            rollback_shortcut(shortcut, previous);
            return Err(error);
        }
    };

    if launch_at_login_changed {
        if let Err(error) = sync_launch_at_login(saved.launch_at_login) {
            log::error!("Could not apply start with Windows: {error}");
        }
    }
    Ok(saved)
}

/// [`update_settings_with`] on the app's settings store, shortcut and login items. Every settings
/// change goes through here (IPC, tray), so `settings:changed` and the tray follow the store.
pub async fn update_settings(
    app: &AppHandle,
    patch: SettingsPatch,
) -> Result<Settings, ExposedError> {
    let unavailable = || ExposedError::new(IpcErrorCode::Unavailable, "Not available yet");
    let store = app.try_state::<SettingsStore>().ok_or_else(unavailable)?;
    let shortcut = app
        .try_state::<Arc<ShortcutService>>()
        .ok_or_else(unavailable)?;
    update_settings_with(
        patch,
        |patch| store.update(patch),
        shortcut.as_ref(),
        |enabled| sync_launch_at_login(app, enabled),
    )
    .await
}

fn rollback_shortcut(shortcut: &dyn ShortcutControl, previous: Option<String>) {
    if shortcut.current() == previous {
        return;
    }
    match previous {
        None => shortcut.dispose(),
        Some(previous) => {
            if let Err(reason) = shortcut.apply(&previous) {
                log::error!("Could not roll back the global shortcut to {previous}: {reason:?}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::sync::{Mutex, PoisonError};

    use tauri::async_runtime::block_on;

    use super::*;
    use crate::contract::settings::Language;
    use crate::settings::default_settings;

    type ApplyFn = Box<dyn Fn(&str) -> Result<(), ShortcutError> + Send + Sync>;

    /// `ShortcutService` stand-in: `apply` answers with `answer` and records success.
    struct FakeShortcut {
        current: Mutex<Option<String>>,
        answer: ApplyFn,
        disposed: Mutex<bool>,
    }

    impl FakeShortcut {
        fn new(current: Option<&str>, answer: ApplyFn) -> Self {
            Self {
                current: Mutex::new(current.map(str::to_owned)),
                answer,
                disposed: Mutex::new(false),
            }
        }

        fn ok(current: Option<&str>) -> Self {
            Self::new(current, Box::new(|_| Ok(())))
        }
    }

    impl ShortcutControl for FakeShortcut {
        fn apply(&self, accelerator: &str) -> Result<(), ShortcutError> {
            (self.answer)(accelerator)?;
            *self.current.lock().unwrap_or_else(PoisonError::into_inner) =
                Some(accelerator.to_owned());
            Ok(())
        }

        fn current(&self) -> Option<String> {
            self.current
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
        }

        fn dispose(&self) {
            *self.disposed.lock().unwrap_or_else(PoisonError::into_inner) = true;
            *self.current.lock().unwrap_or_else(PoisonError::into_inner) = None;
        }
    }

    fn defaults() -> Settings {
        default_settings("es")
    }

    /// The store stand-in: merges the top-level fields this file uses.
    fn saved(patch: SettingsPatch) -> Result<Settings, ExposedError> {
        let mut settings = defaults();
        if let Some(shortcut) = patch.shortcut {
            settings.shortcut = shortcut;
        }
        if let Some(launch) = patch.launch_at_login {
            settings.launch_at_login = launch;
        }
        if let Some(language) = patch.language {
            settings.language = language;
        }
        Ok(settings)
    }

    fn save_ok(patch: SettingsPatch) -> std::future::Ready<Result<Settings, ExposedError>> {
        std::future::ready(saved(patch))
    }

    fn save_fails(_patch: SettingsPatch) -> std::future::Ready<Result<Settings, ExposedError>> {
        std::future::ready(Err(ExposedError::internal("disk full")))
    }

    fn shortcut_patch(accelerator: &str) -> SettingsPatch {
        SettingsPatch {
            shortcut: Some(accelerator.to_owned()),
            ..SettingsPatch::default()
        }
    }

    fn no_sync(_: bool) -> Result<(), String> {
        panic!("start with Windows must not be applied")
    }

    #[test]
    fn registers_a_new_shortcut_and_saves_it() {
        let shortcut = FakeShortcut::ok(Some("Control+Alt+Space"));
        let result = block_on(update_settings_with(
            shortcut_patch("Alt+N"),
            save_ok,
            &shortcut,
            no_sync,
        ));
        assert_eq!(result.unwrap().shortcut, "Alt+N");
        assert_eq!(shortcut.current().as_deref(), Some("Alt+N"));
    }

    #[test]
    fn refuses_a_taken_shortcut_without_saving() {
        let shortcut = FakeShortcut::new(
            Some("Control+Alt+Space"),
            Box::new(|_| Err(ShortcutError::Unavailable)),
        );
        let saves = Cell::new(0);
        let result = block_on(update_settings_with(
            shortcut_patch("Alt+N"),
            |patch| {
                saves.set(saves.get() + 1);
                save_ok(patch)
            },
            &shortcut,
            no_sync,
        ));
        assert_eq!(result.unwrap_err().code(), IpcErrorCode::Unavailable);
        assert_eq!(saves.get(), 0);
        assert_eq!(shortcut.current().as_deref(), Some("Control+Alt+Space"));
    }

    #[test]
    fn reports_unparsable_shortcuts_as_invalid_input() {
        let shortcut = FakeShortcut::new(None, Box::new(|_| Err(ShortcutError::Invalid)));
        let result = block_on(update_settings_with(
            shortcut_patch("Alt+N"),
            save_ok,
            &shortcut,
            no_sync,
        ));
        assert_eq!(result.unwrap_err().code(), IpcErrorCode::InvalidInput);
    }

    #[test]
    fn failed_save_rolls_back_shortcut() {
        let shortcut = FakeShortcut::ok(Some("Control+Alt+Space"));
        let result = block_on(update_settings_with(
            shortcut_patch("Alt+N"),
            save_fails,
            &shortcut,
            no_sync,
        ));
        assert_eq!(result.unwrap_err(), ExposedError::internal("disk full"));
        assert_eq!(shortcut.current().as_deref(), Some("Control+Alt+Space"));
    }

    #[test]
    fn failed_save_releases_the_new_shortcut_when_there_was_none() {
        let shortcut = FakeShortcut::ok(None);
        let result = block_on(update_settings_with(
            shortcut_patch("Alt+N"),
            save_fails,
            &shortcut,
            no_sync,
        ));
        assert!(result.is_err());
        assert!(*shortcut.disposed.lock().unwrap());
        assert_eq!(shortcut.current(), None);
    }

    #[test]
    fn failed_rollback_still_reports_the_save_error() {
        let calls = Mutex::new(0);
        let shortcut = FakeShortcut::new(
            Some("Control+Alt+Space"),
            Box::new(move |_| {
                let mut calls = calls.lock().unwrap();
                *calls += 1;
                if *calls == 1 {
                    Ok(())
                } else {
                    Err(ShortcutError::Unavailable)
                }
            }),
        );
        let result = block_on(update_settings_with(
            shortcut_patch("Alt+N"),
            save_fails,
            &shortcut,
            no_sync,
        ));
        assert_eq!(result.unwrap_err(), ExposedError::internal("disk full"));
    }

    #[test]
    fn keeps_saved_settings_when_start_with_windows_fails() {
        let shortcut = FakeShortcut::ok(Some("Control+Alt+Space"));
        let patch = SettingsPatch {
            shortcut: Some("Alt+N".into()),
            launch_at_login: Some(true),
            ..SettingsPatch::default()
        };
        let result = block_on(update_settings_with(patch, save_ok, &shortcut, |_| {
            Err("registry locked".into())
        }));
        assert!(result.unwrap().launch_at_login);
        assert_eq!(shortcut.current().as_deref(), Some("Alt+N"));
    }

    #[test]
    fn launch_at_login_applied_after_save_only() {
        let shortcut = FakeShortcut::ok(Some("Control+Alt+Space"));
        // Not part of the patch: untouched.
        let language = SettingsPatch {
            language: Some(Language::En),
            ..SettingsPatch::default()
        };
        block_on(update_settings_with(language, save_ok, &shortcut, no_sync)).unwrap();

        // Part of the patch: applied with the saved value.
        let applied = Cell::new(None);
        let launch = SettingsPatch {
            launch_at_login: Some(true),
            ..SettingsPatch::default()
        };
        block_on(update_settings_with(
            launch.clone(),
            save_ok,
            &shortcut,
            |enabled| {
                applied.set(Some(enabled));
                Ok(())
            },
        ))
        .unwrap();
        assert_eq!(applied.get(), Some(true));

        // The save failed: never applied.
        let result = block_on(update_settings_with(launch, save_fails, &shortcut, no_sync));
        assert!(result.is_err());
    }
}
