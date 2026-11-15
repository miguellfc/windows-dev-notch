//! The capsule window and the [`NotchSurface`] the controller drives it through
//! (`src/main/windows/notch-window.ts`).
//!
//! Learned in `spikes/tauri-capsule`: the window is shown only through tao (`show()`), never a raw
//! `ShowWindow`, or tao hides it again on its next style change (click-through); and it is created
//! `focusable(false)` (`WS_EX_NOACTIVATE`) so neither showing it nor clicking the capsule takes
//! focus. Only the panel modes make it focusable, around `focus()`/`blur()`.
//!
//! Every method here is a Tauri setter or a plain Win32 call, safe from any thread: the
//! controller runs them on IPC and timer threads (tokio workers) as well as the main thread.

use std::sync::Arc;

use serde::Serialize;
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use super::controller::NotchSurface;
use super::display::MonitorScale;
use super::geometry::{window_height_for, Rect, VisibleMode, WINDOW_WIDTH};
use super::state::NotchMode;
use crate::ipc::{emit_event, BRIDGE_SCRIPT, NOTCH};
use crate::security::harden;

const PAGE: &str = "notch/index.html";

/// Creates the capsule window, hidden; the controller sizes, places and shows it on `start`.
pub fn create_notch_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let builder = WebviewWindowBuilder::new(app, NOTCH, WebviewUrl::App(PAGE.into()))
        .title("Developer Notch")
        .inner_size(WINDOW_WIDTH, window_height_for(VisibleMode::Peek))
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .focusable(false)
        .focused(false)
        .visible(false)
        .initialization_script(BRIDGE_SCRIPT);
    harden(builder, PAGE).build()
}

/// The controller's view of the window. Bounds come in the DIP of the capsule's monitor and are
/// turned into px with that monitor's scale ([`MonitorScale`]), never the window's current one:
/// moving to a monitor with another DPI must land exactly on the computed px.
pub struct TauriNotchSurface {
    window: WebviewWindow,
    app: AppHandle,
    scale: Arc<MonitorScale>,
    /// The window's `HWND`, kept as an integer so the surface stays `Send + Sync`.
    hwnd: isize,
}

impl TauriNotchSurface {
    pub fn new(window: WebviewWindow, scale: Arc<MonitorScale>) -> tauri::Result<Self> {
        let hwnd = window.hwnd()?.0 as isize;
        Ok(Self {
            app: window.app_handle().clone(),
            window,
            scale,
            hwnd,
        })
    }

    fn emit(&self, event: &str, payload: &impl Serialize) {
        emit_event(&self.app, &[NOTCH], event, payload);
    }
}

/// Logs a failed window call; the controller has no way to recover from one either.
fn check(what: &str, result: tauri::Result<()>) {
    if let Err(error) = result {
        log::warn!("notch window: {what} failed: {error}");
    }
}

/// Bounds in px for a rect in DIP at `scale`: position and size rounded on their own, so the
/// size never depends on where the window sits.
pub fn physical_bounds(rect: Rect, scale: f64) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    let px = |dip: f64| (dip * scale).round();
    (
        PhysicalPosition::new(px(rect.x) as i32, px(rect.y) as i32),
        PhysicalSize::new(
            px(rect.width).max(1.0) as u32,
            px(rect.height).max(1.0) as u32,
        ),
    )
}

impl NotchSurface for TauriNotchSurface {
    fn set_bounds(&self, rect: Rect) {
        let (position, size) = physical_bounds(rect, self.scale.get());
        // Position first: entering a monitor with another DPI sends WM_DPICHANGED and tao applies
        // Windows' suggested rect, which moves and rescales the window. The size set next
        // overrides the rescale but keeps the suggested position, so the position is set again.
        check("set_position", self.window.set_position(position));
        check("set_size", self.window.set_size(size));
        check("set_position", self.window.set_position(position));
    }

    fn show(&self) {
        // Through tao (see the module docs); focusable(false) keeps it from activating.
        check("show", self.window.show());
    }

    fn hide(&self) {
        check("hide", self.window.hide());
    }

    fn focus(&self) {
        check("set_focusable", self.window.set_focusable(true));
        check("set_focus", self.window.set_focus());
    }

    fn blur(&self) {
        give_focus_back(self.hwnd);
        check("set_focusable", self.window.set_focusable(false));
    }

    fn set_ignore_mouse(&self, ignore: bool) {
        check(
            "set_ignore_cursor_events",
            self.window.set_ignore_cursor_events(ignore),
        );
    }

    fn send_mode(&self, mode: NotchMode) {
        self.emit("notch:mode-changed", &mode);
    }

    fn send_mail_alert(&self, on: bool) {
        self.emit("notch:mail-alert", &on);
    }

    fn send_review_alert(&self, on: bool) {
        self.emit("notch:review-alert", &on);
    }

    fn send_redmine_alert(&self, on: bool) {
        self.emit("notch:redmine-alert", &on);
    }
}

/// Electron's `BrowserWindow.blur()` on Windows: if the capsule is the foreground window, hand
/// the foreground to the next visible window below it in z-order.
fn give_focus_back(hwnd: isize) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindow, IsWindowVisible, SetForegroundWindow, GW_HWNDNEXT,
    };
    let own = hwnd as HWND;
    // SAFETY: plain Win32 queries on window handles; a stale handle only makes them fail.
    unsafe {
        if GetForegroundWindow() != own {
            return;
        }
        let mut next = GetWindow(own, GW_HWNDNEXT);
        while !next.is_null() {
            if IsWindowVisible(next) != 0 {
                SetForegroundWindow(next);
                return;
            }
            next = GetWindow(next, GW_HWNDNEXT);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_scale_to_px() {
        let rect = Rect {
            x: 1860.0,
            y: 0.0,
            width: 760.0,
            height: 114.0,
        };
        let (position, size) = physical_bounds(rect, 1.5);
        assert_eq!(position, PhysicalPosition::new(2790, 0));
        assert_eq!(size, PhysicalSize::new(1140, 171));
        let (position, size) = physical_bounds(rect, 1.0);
        assert_eq!(position, PhysicalPosition::new(1860, 0));
        assert_eq!(size, PhysicalSize::new(760, 114));
    }
}
