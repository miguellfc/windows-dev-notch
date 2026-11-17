use serde::Serialize;
use tauri::{AppHandle, Emitter, EventTarget};

use super::known;

pub fn is_known_event(event: &str) -> bool {
    known().events.contains(&event)
}

/// Pushes an event to the given windows (labels). The bridge listens only for events aimed at
/// its own window, so other windows never see it. Unknown events are refused and logged.
pub fn emit_event(app: &AppHandle, targets: &[&str], event: &str, payload: &impl Serialize) {
    if !is_known_event(event) {
        log::error!("Refused to emit an unknown event: {event}");
        return;
    }
    for target in targets {
        if let Err(error) = app.emit_to(EventTarget::webview_window(*target), event, payload) {
            log::warn!("Could not emit {event} to {target}: {error}");
        }
    }
}

/// The notch and the Control Center, only those that exist (the Control Center is created on
/// demand; at quit a window may already be gone).
pub fn existing_windows(app: &AppHandle) -> Vec<&'static str> {
    use tauri::Manager;
    [super::NOTCH, super::CONTROL_CENTER]
        .into_iter()
        .filter(|label| app.get_webview_window(label).is_some())
        .collect()
}
