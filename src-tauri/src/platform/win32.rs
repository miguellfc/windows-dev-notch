//! Win32 reads for the foreground watcher (the koffi probe of 0.1.0's `win32.ts`).

use windows_sys::Win32::Foundation::RECT;
use windows_sys::Win32::Graphics::Gdi::{
    GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows_sys::Win32::UI::Shell::SHQueryUserNotificationState;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetClassNameW, GetForegroundWindow, GetWindowRect,
};

use super::foreground::{ForegroundSnapshot, NotificationState};
use crate::notch::display::PxRect;

/// `QUERY_USER_NOTIFICATION_STATE` simplified like the TS table.
fn notification_state(raw: i32) -> NotificationState {
    match raw {
        1 | 5 | 6 => NotificationState::Normal,
        2 => NotificationState::Busy,
        3 => NotificationState::D3d,
        4 => NotificationState::Presentation,
        7 => NotificationState::App,
        _ => NotificationState::Unknown,
    }
}

fn px(rect: RECT) -> PxRect {
    PxRect {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
    }
}

/// Reads the foreground window, its monitor and Windows' notification state.
pub fn probe_foreground() -> Result<ForegroundSnapshot, String> {
    // SAFETY: every call below takes plain values or pointers to locals that outlive it; the
    // out-structs are zeroed with their size fields set, and a failed call is checked before
    // its output is read.
    unsafe {
        let mut raw = 0;
        let state = if SHQueryUserNotificationState(&mut raw) >= 0 {
            notification_state(raw)
        } else {
            NotificationState::Unknown
        };

        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return Ok(ForegroundSnapshot {
                handle: None,
                class_name: String::new(),
                covers_monitor: false,
                monitor: PxRect {
                    left: 0,
                    top: 0,
                    right: 0,
                    bottom: 0,
                },
                notification_state: state,
            });
        }

        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return Err("GetWindowRect failed".into());
        }
        let mut info: MONITORINFO = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut info) == 0 {
            return Err("GetMonitorInfoW failed".into());
        }
        let monitor = info.rcMonitor;

        let mut name = [0u16; 256];
        let length = GetClassNameW(hwnd, name.as_mut_ptr(), name.len() as i32).max(0) as usize;

        Ok(ForegroundSnapshot {
            handle: Some(hwnd as isize),
            class_name: String::from_utf16_lossy(&name[..length]),
            covers_monitor: rect.left <= monitor.left
                && rect.top <= monitor.top
                && rect.right >= monitor.right
                && rect.bottom >= monitor.bottom,
            monitor: px(monitor),
            notification_state: state,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_the_notification_states() {
        assert_eq!(notification_state(2), NotificationState::Busy);
        assert_eq!(notification_state(5), NotificationState::Normal);
        assert_eq!(notification_state(0), NotificationState::Unknown);
    }

    #[test]
    fn the_real_probe_answers() {
        // Any session answers (a headless one reports no foreground window): it must not fail.
        assert!(probe_foreground().is_ok());
    }
}
