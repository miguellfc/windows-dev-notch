//! OS integration outside the capsule window: the foreground watcher, the tray, the global
//! shortcut, start with Windows, the clipboard, power/session events and toasts.

pub mod autostart;
pub mod clipboard;
pub mod foreground;
pub mod power;
pub mod shortcut;
pub mod toast;
pub mod tray;
pub mod win32;
