//! Windows toasts with a click handler (Electron's `Notification` in the reminders and Claude
//! integrations), through `tauri-winrt-notification`: Tauri's notification plugin delivers no
//! clicks on Windows.
//!
//! Attribution: the process takes the AppUserModelID `dev.developernotch.app` at startup
//! ([`set_app_user_model_id`]); release builds show their toasts under it (the installer's
//! Start-menu shortcut carries the same ID, which Windows needs to show and route them). Debug
//! and E2E builds have no such shortcut, so they use the PowerShell ID the crate provides: the
//! toast still appears (credited to Windows PowerShell), but its click may not come back to
//! the app in dev.
//!
//! Each toast is kept alive until it is clicked, dismissed (or timed out) or fails to show, so
//! its handlers are not dropped early (Electron's `liveToasts`). The live toasts belong to one
//! toast thread (WinRT objects are not `Send`), which also shows them: [`show`] only queues the
//! request, so it never blocks or panics the caller. Failures are logged by error name only.

use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, OnceLock};

use tauri_winrt_notification::{Error, Sound, Toast};

/// `app.setAppUserModelId(...)` in Electron; the same as the Tauri identifier.
pub const APP_USER_MODEL_ID: &str = "dev.developernotch.app";

/// Gives this process its AppUserModelID. Call early in `setup`, on the main thread.
pub fn set_app_user_model_id() {
    let id: Vec<u16> = APP_USER_MODEL_ID
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: a NUL-terminated UTF-16 string that outlives the call.
    let result = unsafe {
        windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(id.as_ptr())
    };
    if result < 0 {
        log::warn!("Could not set the AppUserModelID (HRESULT {result:#010x})");
    }
}

/// The AppUserModelID toasts are shown under (see the module docs).
fn toast_app_id() -> &'static str {
    if crate::ipc::dev_overrides_enabled() {
        Toast::POWERSHELL_APP_ID
    } else {
        APP_USER_MODEL_ID
    }
}

/// Whether a toast plays a sound: reminders are silent (the notch plays its own chime); Claude's
/// toasts play the default Windows sound, as Electron's `new Notification({title, body})` does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToastSound {
    Silent,
    Default,
}

/// The `audio` element of the toast for `sound`.
fn winrt_sound(sound: ToastSound) -> Option<Sound> {
    match sound {
        ToastSound::Silent => None,
        ToastSound::Default => Some(Sound::Default),
    }
}

enum Command {
    Show {
        title: String,
        body: String,
        sound: ToastSound,
        on_click: Arc<dyn Fn() + Send + Sync>,
    },
    /// Clicked or dismissed: its handlers may go.
    Forget(u64),
}

/// The toast thread's queue, started on first use.
fn queue() -> Option<&'static Sender<Command>> {
    static QUEUE: OnceLock<Option<Sender<Command>>> = OnceLock::new();
    QUEUE
        .get_or_init(|| {
            let (sender, receiver) = mpsc::channel();
            let own = sender.clone();
            let spawned = std::thread::Builder::new()
                .name("toasts".into())
                .spawn(move || run(&own, &receiver));
            match spawned {
                Ok(_) => Some(sender),
                Err(_) => {
                    log::error!("Could not start the toast thread");
                    None
                }
            }
        })
        .as_ref()
}

/// Shows a toast without buttons, with or without `sound`; `on_click` runs (on a Windows thread)
/// when its body is clicked. Returns at once.
pub fn show(title: String, body: String, sound: ToastSound, on_click: Arc<dyn Fn() + Send + Sync>) {
    let queued = queue().is_some_and(|queue| {
        queue
            .send(Command::Show {
                title,
                body,
                sound,
                on_click,
            })
            .is_ok()
    });
    if !queued {
        log::warn!("Toast failed: NoThread");
    }
}

/// The variant name of a toast error (never its text).
fn error_name(error: &Error) -> &'static str {
    match error {
        Error::Os(_) => "Os",
        Error::Io(_) => "Io",
    }
}

/// The toast thread: shows toasts and keeps each one until it is clicked or dismissed.
fn run(queue: &Sender<Command>, commands: &Receiver<Command>) {
    let mut live: HashMap<u64, Toast> = HashMap::new();
    let mut next_id = 0u64;
    while let Ok(command) = commands.recv() {
        match command {
            Command::Forget(id) => {
                live.remove(&id);
            }
            Command::Show {
                title,
                body,
                sound,
                on_click,
            } => {
                let id = next_id;
                next_id += 1;
                let shown = catch_unwind(AssertUnwindSafe(|| {
                    let toast = build(id, queue, &title, &body, sound, on_click);
                    toast.show().map(|()| toast)
                }));
                match shown {
                    Ok(Ok(toast)) => {
                        live.insert(id, toast);
                    }
                    Ok(Err(error)) => log::warn!("Toast failed: {}", error_name(&error)),
                    Err(_) => log::error!("Toast failed: Panic"),
                }
            }
        }
    }
}

fn build(
    id: u64,
    queue: &Sender<Command>,
    title: &str,
    body: &str,
    sound: ToastSound,
    on_click: Arc<dyn Fn() + Send + Sync>,
) -> Toast {
    let (clicked, dismissed) = (queue.clone(), queue.clone());
    Toast::new(toast_app_id())
        .title(title)
        .text1(body)
        .sound(winrt_sound(sound))
        .on_activated(move |_action| {
            // Never unwind into Windows: that would abort the process.
            if catch_unwind(AssertUnwindSafe(|| on_click())).is_err() {
                log::error!("Toast click failed");
            }
            // Released on the toast thread, never inside its own handler.
            let _ = clicked.send(Command::Forget(id));
            Ok(())
        })
        .on_dismissed(move |_reason| {
            let _ = dismissed.send(Command::Forget(id));
            Ok(())
        })
}

#[cfg(test)]
mod tests {
    use tauri_winrt_notification::Sound;

    use super::*;

    #[test]
    fn claude_toast_uses_default_sound() {
        // Electron's `new Notification({title, body})` plays the default Windows sound.
        assert_eq!(winrt_sound(ToastSound::Default), Some(Sound::Default));
    }

    #[test]
    fn silent_toasts_play_no_sound() {
        assert_eq!(winrt_sound(ToastSound::Silent), None);
    }
}
