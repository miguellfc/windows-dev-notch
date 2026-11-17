//! The global shortcut (0.1.0's `shortcut.ts`).
//!
//! Settings keep Electron accelerators (`Control+Alt+Space`); [`to_tauri_accelerator`] turns
//! them into what `tauri-plugin-global-shortcut` parses (`ctrl+alt+Space`).

use std::sync::{Arc, Mutex, MutexGuard, PoisonError, TryLockError};

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::contract::notch::NotchMode;
use crate::notch::runtime::NotchRuntime;
use crate::notch::state::NotchEvent;
use crate::settings::validate::is_safe_accelerator;

/// Why a shortcut could not be registered.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShortcutError {
    /// Another application holds the combination.
    Unavailable,
    /// The accelerator cannot be parsed.
    Invalid,
}

/// Maps an Electron accelerator accepted by `isSafeAccelerator` to the plugin's syntax, or
/// `None` when it is not one (no Ctrl/Alt/Win, no real key, or a key the app never stores).
pub fn to_tauri_accelerator(electron: &str) -> Option<String> {
    if !is_safe_accelerator(electron) {
        return None;
    }
    let parts: Vec<&str> = electron.split('+').collect();
    let (key, modifiers) = parts.split_last()?;
    let mut mapped: Vec<String> = modifiers
        .iter()
        .map(|part| tauri_modifier(part).map(str::to_owned))
        .collect::<Option<_>>()?;
    mapped.push(tauri_key(key)?);
    Some(mapped.join("+"))
}

fn tauri_modifier(part: &str) -> Option<&'static str> {
    match part {
        "Control" | "Ctrl" | "CommandOrControl" | "CmdOrCtrl" => Some("ctrl"),
        "Alt" => Some("alt"),
        "Shift" => Some("shift"),
        "Super" | "Meta" => Some("super"),
        _ => None,
    }
}

/// The keys `acceleratorFromKey` stores (letters, digits, keypad digits, F1-F24 and the named
/// keys), as the `Code` names the plugin parses.
fn tauri_key(key: &str) -> Option<String> {
    let mut chars = key.chars();
    if let (Some(c), None) = (chars.next(), chars.next()) {
        return match c {
            'A'..='Z' => Some(format!("Key{c}")),
            '0'..='9' => Some(format!("Digit{c}")),
            _ => None,
        };
    }
    if let Some(digit) = key.strip_prefix("num") {
        return (digit.len() == 1 && digit.bytes().all(|b| b.is_ascii_digit()))
            .then(|| format!("Numpad{digit}"));
    }
    if let Some(number) = key.strip_prefix('F') {
        let valid =
            !number.starts_with('0') && number.parse::<u8>().is_ok_and(|n| (1..=24).contains(&n));
        return valid.then(|| key.to_owned());
    }
    let named = match key {
        "Space" | "Enter" | "Tab" | "Backspace" | "Delete" | "Insert" | "Home" | "End"
        | "PageUp" | "PageDown" => key,
        "Up" => "ArrowUp",
        "Down" => "ArrowDown",
        "Left" => "ArrowLeft",
        "Right" => "ArrowRight",
        _ => return None,
    };
    Some(named.to_owned())
}

/// The part of the plugin the service needs.
pub trait ShortcutRegistrar: Send + Sync {
    fn register(&self, accelerator: &str) -> Result<(), ShortcutError>;
    fn unregister(&self, accelerator: &str);
}

/// What the settings updater needs from the shortcut (a fake in tests).
pub trait ShortcutControl: Send + Sync {
    /// Registers `accelerator`, releasing the previous one only if the new one succeeds.
    fn apply(&self, accelerator: &str) -> Result<(), ShortcutError>;
    fn current(&self) -> Option<String>;
    fn dispose(&self);
}

pub struct ShortcutService {
    registrar: Box<dyn ShortcutRegistrar>,
    /// Serializes `apply`/`dispose` (held across the main-thread round trip of the plugin).
    turn: Mutex<()>,
    /// Read by `current()`, never held across a plugin call: the main thread may read it while a
    /// worker waits on the main thread inside `apply`.
    current: Mutex<Option<String>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl ShortcutService {
    pub fn new(registrar: Box<dyn ShortcutRegistrar>) -> Self {
        Self {
            registrar,
            turn: Mutex::new(()),
            current: Mutex::new(None),
        }
    }

    /// [`dispose`](ShortcutControl::dispose) for the main thread: never waits on `turn`, which an
    /// `apply` on a worker may hold while it waits on the main thread. Returns `false` (and
    /// releases nothing) when such an `apply` is in flight; the OS frees the hotkey when the
    /// process exits anyway.
    pub fn try_dispose(&self) -> bool {
        let _turn = match self.turn.try_lock() {
            Ok(turn) => turn,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => return false,
        };
        let previous = lock(&self.current).take();
        if let Some(previous) = previous {
            self.registrar.unregister(&previous);
        }
        true
    }
}

impl ShortcutControl for ShortcutService {
    fn apply(&self, accelerator: &str) -> Result<(), ShortcutError> {
        let _turn = lock(&self.turn);
        let previous = self.current();
        if previous.as_deref() == Some(accelerator) {
            return Ok(());
        }
        if let Err(error) = self.registrar.register(accelerator) {
            match error {
                ShortcutError::Unavailable => {
                    log::warn!("Shortcut is taken by another application: {accelerator}");
                }
                ShortcutError::Invalid => log::warn!("Shortcut rejected: {accelerator}"),
            }
            return Err(error);
        }
        if let Some(previous) = previous {
            self.registrar.unregister(&previous);
        }
        *lock(&self.current) = Some(accelerator.to_owned());
        log::info!("Shortcut registered: {accelerator}");
        Ok(())
    }

    fn current(&self) -> Option<String> {
        lock(&self.current).clone()
    }

    fn dispose(&self) {
        let _turn = lock(&self.turn);
        let previous = lock(&self.current).take();
        if let Some(previous) = previous {
            self.registrar.unregister(&previous);
        }
    }
}

/// Registers through `tauri-plugin-global-shortcut`. Its calls run on the main thread and block
/// the caller until done (inline when the caller is the main thread).
pub struct PluginRegistrar {
    app: AppHandle,
    on_trigger: Arc<dyn Fn() + Send + Sync>,
}

impl PluginRegistrar {
    pub fn new(app: AppHandle, on_trigger: Arc<dyn Fn() + Send + Sync>) -> Self {
        Self { app, on_trigger }
    }
}

fn parse(accelerator: &str) -> Result<Shortcut, ShortcutError> {
    to_tauri_accelerator(accelerator)
        .and_then(|tauri| tauri.parse::<Shortcut>().ok())
        .ok_or(ShortcutError::Invalid)
}

impl ShortcutRegistrar for PluginRegistrar {
    fn register(&self, accelerator: &str) -> Result<(), ShortcutError> {
        let shortcut = parse(accelerator)?;
        let on_trigger = Arc::clone(&self.on_trigger);
        // Parsing succeeded, so a refusal comes from the OS: another app holds the combination.
        self.app
            .global_shortcut()
            .on_shortcut(shortcut, move |_app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    on_trigger();
                }
            })
            .map_err(|error| {
                log::warn!("Shortcut registration failed: {error}");
                ShortcutError::Unavailable
            })
    }

    fn unregister(&self, accelerator: &str) {
        let Ok(shortcut) = parse(accelerator) else {
            return;
        };
        if let Err(error) = self.app.global_shortcut().unregister(shortcut) {
            log::warn!("Shortcut could not be released: {error}");
        }
    }
}

/// What the shortcut does (`onTrigger` in 0.1.0's `index.ts`): unless the panel is open, the
/// capsule first moves to the monitor under the cursor; then it toggles. Runs on the main thread.
pub fn trigger(app: &AppHandle) {
    let Some(notch) = app.try_state::<Arc<NotchRuntime>>() else {
        return;
    };
    if notch.controller.mode() != NotchMode::Expanded {
        notch.display.move_to_monitor_at_cursor();
    }
    notch.controller.dispatch(NotchEvent::Toggle);
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::Arc;

    use super::*;

    #[derive(Default)]
    struct FakeRegistrar {
        taken: Vec<&'static str>,
        invalid: Vec<&'static str>,
        registered: Arc<Mutex<BTreeSet<String>>>,
    }

    impl ShortcutRegistrar for FakeRegistrar {
        fn register(&self, accelerator: &str) -> Result<(), ShortcutError> {
            if self.invalid.contains(&accelerator) {
                return Err(ShortcutError::Invalid);
            }
            if self.taken.contains(&accelerator) {
                return Err(ShortcutError::Unavailable);
            }
            lock(&self.registered).insert(accelerator.to_owned());
            Ok(())
        }

        fn unregister(&self, accelerator: &str) {
            lock(&self.registered).remove(accelerator);
        }
    }

    fn setup(
        taken: &[&'static str],
        invalid: &[&'static str],
    ) -> (ShortcutService, Arc<Mutex<BTreeSet<String>>>) {
        let registered = Arc::new(Mutex::new(BTreeSet::new()));
        let registrar = FakeRegistrar {
            taken: taken.to_vec(),
            invalid: invalid.to_vec(),
            registered: Arc::clone(&registered),
        };
        (ShortcutService::new(Box::new(registrar)), registered)
    }

    fn registered(set: &Arc<Mutex<BTreeSet<String>>>) -> Vec<String> {
        lock(set).iter().cloned().collect()
    }

    #[test]
    fn accelerator_mapping() {
        let map = |electron: &str| to_tauri_accelerator(electron);
        assert_eq!(map("Control+Alt+Space").as_deref(), Some("ctrl+alt+Space"));
        assert_eq!(map("Super+N").as_deref(), Some("super+KeyN"));
        assert_eq!(map("Space"), None);
        assert_eq!(map("Ctrl+Shift+7").as_deref(), Some("ctrl+shift+Digit7"));
        assert_eq!(map("Alt+num3").as_deref(), Some("alt+Numpad3"));
        assert_eq!(map("Meta+F12").as_deref(), Some("super+F12"));
        assert_eq!(map("CommandOrControl+Up").as_deref(), Some("ctrl+ArrowUp"));
        assert_eq!(map("CmdOrCtrl+PageDown").as_deref(), Some("ctrl+PageDown"));
        // Not safe: Shift alone, a modifier as the key, or an unknown key.
        assert_eq!(map("Shift+A"), None);
        assert_eq!(map("Control+Alt"), None);
        assert_eq!(map("Control+Foo"), None);
        assert_eq!(map("Control+F25"), None);
        assert_eq!(map(""), None);
    }

    #[test]
    fn every_mapped_accelerator_parses_in_the_plugin() {
        use tauri_plugin_global_shortcut::Shortcut;
        let keys = [
            "A",
            "Z",
            "0",
            "9",
            "num0",
            "num9",
            "F1",
            "F24",
            "Space",
            "Enter",
            "Tab",
            "Backspace",
            "Delete",
            "Insert",
            "Home",
            "End",
            "PageUp",
            "PageDown",
            "Up",
            "Down",
            "Left",
            "Right",
        ];
        for key in keys {
            let electron = format!("Control+Alt+Shift+Super+{key}");
            let tauri = to_tauri_accelerator(&electron).unwrap_or_else(|| panic!("{electron}"));
            assert!(tauri.parse::<Shortcut>().is_ok(), "{electron} -> {tauri}");
        }
    }

    #[test]
    fn registers_the_first_shortcut() {
        let (service, set) = setup(&[], &[]);
        assert_eq!(service.apply("Control+Alt+Space"), Ok(()));
        assert_eq!(registered(&set), ["Control+Alt+Space"]);
        assert_eq!(service.current().as_deref(), Some("Control+Alt+Space"));
    }

    #[test]
    fn swaps_to_a_new_shortcut_and_releases_the_old_one() {
        let (service, set) = setup(&[], &[]);
        service.apply("Control+Alt+Space").unwrap();
        assert_eq!(service.apply("Alt+N"), Ok(()));
        assert_eq!(registered(&set), ["Alt+N"]);
    }

    #[test]
    fn taken_shortcut_keeps_previous() {
        let (service, set) = setup(&["Alt+N"], &[]);
        service.apply("Control+Alt+Space").unwrap();
        assert_eq!(service.apply("Alt+N"), Err(ShortcutError::Unavailable));
        assert_eq!(registered(&set), ["Control+Alt+Space"]);
        assert_eq!(service.current().as_deref(), Some("Control+Alt+Space"));
    }

    #[test]
    fn reports_invalid_accelerators() {
        let (service, _) = setup(&[], &["Foo+Bar"]);
        assert_eq!(service.apply("Foo+Bar"), Err(ShortcutError::Invalid));
        assert_eq!(service.current(), None);
    }

    #[test]
    fn reapplying_the_same_shortcut_is_a_no_op() {
        let (service, set) = setup(&[], &[]);
        service.apply("Alt+N").unwrap();
        assert_eq!(service.apply("Alt+N"), Ok(()));
        assert_eq!(registered(&set), ["Alt+N"]);
    }

    #[test]
    fn try_dispose_releases_the_shortcut_unless_an_apply_is_in_flight() {
        let (service, set) = setup(&[], &[]);
        service.apply("Alt+N").unwrap();
        {
            let _busy = lock(&service.turn);
            assert!(!service.try_dispose());
            assert_eq!(registered(&set), ["Alt+N"]);
        }
        assert!(service.try_dispose());
        assert!(registered(&set).is_empty());
        assert_eq!(service.current(), None);
    }

    #[test]
    fn releases_everything_on_dispose() {
        let (service, set) = setup(&[], &[]);
        service.apply("Alt+N").unwrap();
        service.dispose();
        assert!(registered(&set).is_empty());
        assert_eq!(service.current(), None);
    }
}
