//! The capsule window and the [`NotchSurface`] the controller drives it through
//! (0.1.0's `notch-window.ts`).
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

/// Where the foreground window is when the capsule reports `Focused(false)`. On Windows Tauri
/// raises that event from the WebView2's own `LostFocus`, not from the window's deactivation like
/// Electron's `blur`, so it also fires when the keyboard focus only bounces inside the capsule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FocusLoss {
    /// The capsule is still the foreground window: only its webview lost the focus.
    StillForeground,
    /// The Control Center took the foreground.
    ControlCenter,
    /// Another window of this process (a WebView2 host window, say) is in the foreground.
    OwnProcess,
    /// A window of another process, or none, is in the foreground.
    Elsewhere,
}

impl FocusLoss {
    pub fn classify(foreground: &ForegroundWindow, own: isize, control_center: isize) -> Self {
        let hwnd = foreground.hwnd;
        if hwnd != 0 && hwnd == own {
            Self::StillForeground
        } else if hwnd != 0 && hwnd == control_center {
            Self::ControlCenter
        } else if hwnd != 0 && foreground.own_process {
            Self::OwnProcess
        } else {
            Self::Elsewhere
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::StillForeground => "the capsule is still the foreground window",
            Self::ControlCenter => "the Control Center is in the foreground",
            Self::OwnProcess => "another window of the app is in the foreground",
            Self::Elsewhere => "another app's window is in the foreground",
        }
    }
}

/// The foreground window: its `HWND` as an integer (0 when there is none), whether this process
/// owns it, and its window class. The log records the class only, never the window's title
/// (which could name a user's document) or its process's executable.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ForegroundWindow {
    pub hwnd: isize,
    pub own_process: bool,
    pub class: String,
}

pub fn foreground_window() -> ForegroundWindow {
    use windows_sys::Win32::System::Threading::GetCurrentProcessId;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetForegroundWindow, GetWindowThreadProcessId,
    };
    // SAFETY: plain Win32 queries; every buffer outlives its call and its length is passed.
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return ForegroundWindow::default();
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let mut class = [0u16; 128];
        let len = GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32);
        ForegroundWindow {
            hwnd: hwnd as isize,
            own_process: pid != 0 && pid == GetCurrentProcessId(),
            class: String::from_utf16_lossy(&class[..len.max(0) as usize]),
        }
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

    #[test]
    fn focus_loss_is_classified_by_the_foreground_window() {
        let fg = |hwnd: isize, own_process: bool| ForegroundWindow {
            hwnd,
            own_process,
            ..ForegroundWindow::default()
        };
        let classify = FocusLoss::classify;
        assert_eq!(classify(&fg(10, true), 10, 20), FocusLoss::StillForeground);
        assert_eq!(classify(&fg(20, true), 10, 20), FocusLoss::ControlCenter);
        assert_eq!(classify(&fg(30, true), 10, 20), FocusLoss::OwnProcess);
        assert_eq!(classify(&fg(30, false), 10, 20), FocusLoss::Elsewhere);
        // No foreground window, or no Control Center (0), never matches.
        assert_eq!(classify(&fg(0, true), 10, 0), FocusLoss::Elsewhere);
        assert_eq!(classify(&fg(0, false), 0, 0), FocusLoss::Elsewhere);
    }
}
