//! Start with Windows (0.1.0's `auto-launch.ts`): the app's value under
//! `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
//!
//! Written here instead of through `tauri-plugin-autostart`, whose `auto-launch` crate writes the
//! executable path unquoted (`C:\...\Developer Notch\developer-notch.exe `). Windows then has to
//! guess where the path ends and could launch `C:\...\Developer.exe` if one existed. Electron
//! (0.1.0) wrote it quoted, as here. Only the current user's hive is touched, as in 0.1.0.

use tauri::AppHandle;

/// The part of the OS login items this module needs (the `Run` entry, or a fake in tests).
pub trait LoginItems {
    fn set(&self, enabled: bool) -> Result<(), String>;
    fn get(&self) -> Result<bool, String>;
}

/// The registry values the `Run` entry reads and writes (`HKCU`, or a fake in tests).
pub trait UserRegistry {
    /// Writes the `REG_SZ` value `name` under `Run`, creating the key if needed.
    fn set_run(&self, name: &str, command: &str) -> Result<(), String>;
    /// Removes the value `name` under `Run`; a missing value or key is not an error.
    fn remove_run(&self, name: &str) -> Result<(), String>;
    /// The value `name` under `Run`, or `None` when it does not exist.
    fn run(&self, name: &str) -> Result<Option<String>, String>;
    /// Marks `name` enabled in Task Manager's `StartupApproved\Run`, when that key exists.
    fn approve(&self, name: &str) -> Result<(), String>;
    /// The value `name` under `StartupApproved\Run`, or `None` when it does not exist.
    fn approval(&self, name: &str) -> Result<Option<Vec<u8>>, String>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LaunchAtLoginResult {
    Applied,
    /// Development builds (and the `e2e` build) never touch the OS.
    NotPackaged,
    /// The OS did not take the change.
    Rejected,
}

/// Task Manager's "enabled" `StartupApproved` data (Windows writes `03` plus a FILETIME when
/// the user disables the entry there).
const STARTUP_APPROVED_ENABLED: [u8; 12] = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

/// The `Run` value data: the executable path in quotes, then the arguments.
pub fn run_command(exe: &str, args: &[&str]) -> String {
    let mut command = format!("\"{exe}\"");
    for arg in args {
        command.push(' ');
        command.push_str(arg);
    }
    command
}

/// Whether Task Manager leaves the entry enabled: no `StartupApproved` value, or one whose last
/// eight bytes (the "disabled at" FILETIME) are zero.
fn approved(value: Option<&[u8]>) -> bool {
    match value {
        Some(bytes) if bytes.len() >= 8 => bytes[bytes.len() - 8..].iter().all(|byte| *byte == 0),
        _ => true,
    }
}

/// The app's `Run` entry: `name` launches `command` at login.
pub struct RunEntry<'a, R: UserRegistry> {
    registry: &'a R,
    name: &'a str,
    command: String,
}

impl<'a, R: UserRegistry> RunEntry<'a, R> {
    pub fn new(registry: &'a R, name: &'a str, command: String) -> Self {
        Self {
            registry,
            name,
            command,
        }
    }
}

impl<R: UserRegistry> LoginItems for RunEntry<'_, R> {
    fn set(&self, enabled: bool) -> Result<(), String> {
        if enabled {
            self.registry.set_run(self.name, &self.command)?;
            self.registry.approve(self.name)
        } else {
            self.registry.remove_run(self.name)
        }
    }

    fn get(&self) -> Result<bool, String> {
        if self.registry.run(self.name)?.is_none() {
            return Ok(false);
        }
        Ok(approved(self.registry.approval(self.name)?.as_deref()))
    }
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

/// The real `HKEY_CURRENT_USER`. Never used by tests.
struct CurrentUser;

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const STARTUP_APPROVED_KEY: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
/// `HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)`: the key or the value does not exist.
const FILE_NOT_FOUND: i32 = 0x8007_0002_u32 as i32;

fn missing_as_none<T>(result: windows_registry::Result<T>) -> Result<Option<T>, String> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.code().0 == FILE_NOT_FOUND => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

impl UserRegistry for CurrentUser {
    fn set_run(&self, name: &str, command: &str) -> Result<(), String> {
        windows_registry::CURRENT_USER
            .create(RUN_KEY)
            .and_then(|key| key.set_string(name, command))
            .map_err(|error| error.to_string())
    }

    fn remove_run(&self, name: &str) -> Result<(), String> {
        let result = windows_registry::CURRENT_USER
            .options()
            .write()
            .open(RUN_KEY)
            .and_then(|key| key.remove_value(name));
        missing_as_none(result).map(|_| ())
    }

    fn run(&self, name: &str) -> Result<Option<String>, String> {
        missing_as_none(
            windows_registry::CURRENT_USER
                .open(RUN_KEY)
                .and_then(|key| key.get_string(name)),
        )
    }

    fn approve(&self, name: &str) -> Result<(), String> {
        let key = windows_registry::CURRENT_USER
            .options()
            .write()
            .open(STARTUP_APPROVED_KEY);
        let Some(key) = missing_as_none(key)? else {
            return Ok(());
        };
        key.set_bytes(
            name,
            windows_registry::Type::Bytes,
            &STARTUP_APPROVED_ENABLED,
        )
        .map_err(|error| error.to_string())
    }

    fn approval(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        missing_as_none(
            windows_registry::CURRENT_USER
                .open(STARTUP_APPROVED_KEY)
                .and_then(|key| key.get_value(name))
                .map(|value| value.to_vec()),
        )
    }
}

/// Mirrors the "start with Windows" setting into the OS; a no-op in development and `e2e`
/// builds. The settings updater logs an error result.
pub fn sync_launch_at_login(app: &AppHandle, enabled: bool) -> Result<(), String> {
    if !launch_at_login_available() {
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let entry = RunEntry::new(
        &CurrentUser,
        &app.package_info().name,
        run_command(&exe.display().to_string(), &[]),
    );
    match sync_with(enabled, true, &entry) {
        LaunchAtLoginResult::Applied | LaunchAtLoginResult::NotPackaged => Ok(()),
        LaunchAtLoginResult::Rejected => Err("Windows did not accept the change".into()),
    }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    use super::*;

    const EXE: &str = r"C:\Users\Ana\AppData\Local\Developer Notch\developer-notch.exe";
    const NAME: &str = "Developer Notch";

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

    /// An in-memory `HKCU`: `Run` values, and `StartupApproved\Run` when `approved_key`.
    #[derive(Default)]
    struct FakeRegistry {
        run: RefCell<HashMap<String, String>>,
        approved_key: Option<RefCell<HashMap<String, Vec<u8>>>>,
    }

    impl FakeRegistry {
        fn with_startup_approved() -> Self {
            Self {
                approved_key: Some(RefCell::default()),
                ..Self::default()
            }
        }
    }

    impl UserRegistry for FakeRegistry {
        fn set_run(&self, name: &str, command: &str) -> Result<(), String> {
            self.run.borrow_mut().insert(name.into(), command.into());
            Ok(())
        }

        fn remove_run(&self, name: &str) -> Result<(), String> {
            self.run.borrow_mut().remove(name);
            Ok(())
        }

        fn run(&self, name: &str) -> Result<Option<String>, String> {
            Ok(self.run.borrow().get(name).cloned())
        }

        fn approve(&self, name: &str) -> Result<(), String> {
            if let Some(key) = &self.approved_key {
                key.borrow_mut()
                    .insert(name.into(), STARTUP_APPROVED_ENABLED.to_vec());
            }
            Ok(())
        }

        fn approval(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self
                .approved_key
                .as_ref()
                .and_then(|key| key.borrow().get(name).cloned()))
        }
    }

    fn entry(registry: &FakeRegistry) -> RunEntry<'_, FakeRegistry> {
        RunEntry::new(registry, NAME, run_command(EXE, &[]))
    }

    #[test]
    fn autostart_value_quotes_a_path_with_spaces() {
        assert_eq!(
            run_command(EXE, &[]),
            r#""C:\Users\Ana\AppData\Local\Developer Notch\developer-notch.exe""#
        );
    }

    #[test]
    fn autostart_value_keeps_args_after_the_quoted_path() {
        assert_eq!(
            run_command(EXE, &["--hidden", "--from-login"]),
            format!("\"{EXE}\" --hidden --from-login")
        );
    }

    #[test]
    fn turning_on_writes_the_quoted_value_and_turning_off_removes_it() {
        let registry = FakeRegistry::default();
        assert_eq!(
            sync_with(true, true, &entry(&registry)),
            LaunchAtLoginResult::Applied
        );
        assert_eq!(
            registry.run.borrow().get(NAME).map(String::as_str),
            Some(format!("\"{EXE}\"").as_str())
        );

        assert_eq!(
            sync_with(false, true, &entry(&registry)),
            LaunchAtLoginResult::Applied
        );
        assert!(registry.run.borrow().is_empty());
    }

    #[test]
    fn turning_off_when_already_off_is_applied() {
        let registry = FakeRegistry::default();
        assert_eq!(
            sync_with(false, true, &entry(&registry)),
            LaunchAtLoginResult::Applied
        );
    }

    #[test]
    fn turning_on_replaces_an_unquoted_value_from_the_plugin() {
        let registry = FakeRegistry::default();
        registry.set_run(NAME, &format!("{EXE} ")).unwrap();
        sync_with(true, true, &entry(&registry));
        assert_eq!(registry.run(NAME).unwrap(), Some(format!("\"{EXE}\"")));
    }

    #[test]
    fn reads_the_state_back_from_the_run_value() {
        let registry = FakeRegistry::default();
        assert_eq!(entry(&registry).get(), Ok(false));
        registry.set_run(NAME, "anything").unwrap();
        assert_eq!(entry(&registry).get(), Ok(true));
    }

    #[test]
    fn turning_on_re_enables_an_entry_disabled_in_task_manager() {
        let registry = FakeRegistry::with_startup_approved();
        let disabled = vec![3, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8];
        registry
            .approved_key
            .as_ref()
            .unwrap()
            .borrow_mut()
            .insert(NAME.into(), disabled);
        registry.set_run(NAME, "anything").unwrap();
        assert_eq!(entry(&registry).get(), Ok(false));

        assert_eq!(
            sync_with(true, true, &entry(&registry)),
            LaunchAtLoginResult::Applied
        );
        assert_eq!(
            registry.approval(NAME).unwrap(),
            Some(STARTUP_APPROVED_ENABLED.to_vec())
        );
    }

    #[test]
    fn task_manager_approval_without_a_filetime_is_enabled() {
        assert!(approved(None));
        assert!(approved(Some(&STARTUP_APPROVED_ENABLED)));
        assert!(approved(Some(&[3, 0])));
        assert!(!approved(Some(&[3, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0])));
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
