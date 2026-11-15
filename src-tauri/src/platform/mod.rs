//! OS integration outside the capsule window: the foreground watcher, the tray, the global
//! shortcut and start with Windows.

pub mod autostart;
pub mod foreground;
pub mod shortcut;
pub mod tray;
pub mod win32;
