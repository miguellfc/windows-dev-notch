//! Which monitor the capsule lives on, and its work area in the controller's DIP.
//!
//! The controller works in DIP of the capsule's monitor: a monitor's work area in px divided by
//! that monitor's scale. [`MonitorScale`] holds the scale the window surface multiplies back by,
//! so every window call is in exact physical px whatever the window's current DPI.
//!
//! Like 0.1.0's `index.ts`, the capsule stays on its monitor; it moves to the cursor's monitor
//! only through [`NotchDisplay::move_to_monitor_at_cursor`] (the global shortcut, Task 9), and
//! when the monitors change it keeps its monitor if it still exists, else goes to the primary.
//! Monitor changes are noticed by polling every 2 s ([`NotchDisplay::watch`]): it also sees
//! work-area changes (a taskbar resized or moved), which `WM_DISPLAYCHANGE` does not report.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use super::controller::NotchController;
use super::geometry::Rect;

/// A rectangle in physical screen px (Win32 `RECT`: right and bottom exclusive).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PxRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MonitorInfo {
    /// GDI device name (`\\.\DISPLAY1`): stable while the monitor stays connected.
    pub device: String,
    /// The whole monitor (what a fullscreen window covers), as opposed to its work area.
    pub bounds_px: PxRect,
    pub work_px: PxRect,
    pub scale: f64,
    pub primary: bool,
}

/// A monitor's work area in the controller's DIP.
pub fn work_area_dip(monitor: &MonitorInfo) -> Rect {
    let PxRect {
        left,
        top,
        right,
        bottom,
    } = monitor.work_px;
    let scale = monitor.scale;
    Rect {
        x: f64::from(left) / scale,
        y: f64::from(top) / scale,
        width: f64::from(right - left) / scale,
        height: f64::from(bottom - top) / scale,
    }
}

/// The monitor to stay on after a change: the same device if it is still there, else the primary.
pub fn pick_monitor<'a>(monitors: &'a [MonitorInfo], current: &str) -> Option<&'a MonitorInfo> {
    monitors
        .iter()
        .find(|monitor| monitor.device == current)
        .or_else(|| monitors.iter().find(|monitor| monitor.primary))
        .or_else(|| monitors.first())
}

/// The scale of the capsule's monitor, shared by [`NotchDisplay`] (writer) and the window
/// surface (reader, to turn the controller's DIP into px).
pub struct MonitorScale(Mutex<f64>);

impl MonitorScale {
    pub fn new(scale: f64) -> Self {
        Self(Mutex::new(scale))
    }

    pub fn get(&self) -> f64 {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn set(&self, scale: f64) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) = scale;
    }
}

/// The capsule's monitor; tells the controller when its work area changes.
pub struct NotchDisplay {
    current: Mutex<MonitorInfo>,
    scale: Arc<MonitorScale>,
    controller: Arc<NotchController>,
    /// Told after the capsule changed monitor or metrics (the foreground watcher's `refresh`).
    on_change: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl NotchDisplay {
    /// `scale` must already hold `monitor`'s scale (the controller was built with its work area).
    pub fn new(
        monitor: MonitorInfo,
        scale: Arc<MonitorScale>,
        controller: Arc<NotchController>,
    ) -> Self {
        Self {
            current: Mutex::new(monitor),
            scale,
            controller,
            on_change: Mutex::new(None),
        }
    }

    /// Registers the hook run after every change of the capsule's monitor.
    pub fn set_on_change(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        *self
            .on_change
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = Some(hook);
    }

    pub fn current(&self) -> MonitorInfo {
        self.current
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Moves the capsule to `monitor` (or re-applies it when its metrics changed).
    pub fn apply(&self, monitor: MonitorInfo) {
        let mut current = self.current.lock().unwrap_or_else(PoisonError::into_inner);
        if *current == monitor {
            return;
        }
        log::info!(
            "notch: monitor {} work area {:?} scale {}",
            monitor.device,
            monitor.work_px,
            monitor.scale
        );
        self.scale.set(monitor.scale);
        let work_area = work_area_dip(&monitor);
        *current = monitor;
        drop(current);
        self.controller.set_work_area(work_area);
        // Cloned out so the hook never runs under the lock.
        let hook = self
            .on_change
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        if let Some(hook) = hook {
            hook();
        }
    }

    /// The monitors changed: keep the capsule's monitor if it still exists, else the primary.
    pub fn refresh(&self, monitors: &[MonitorInfo]) {
        let device = self.current().device;
        if let Some(next) = pick_monitor(monitors, &device) {
            self.apply(next.clone());
        }
    }

    /// For the global shortcut (Task 9): moves the capsule to the monitor under the cursor.
    pub fn move_to_monitor_at_cursor(&self) {
        if let Some(monitor) = monitor_at_cursor() {
            if monitor.device != self.current().device {
                self.apply(monitor);
            }
        }
    }

    /// Polls the monitors on a thread of its own until `stop` is set (the quit sequence).
    pub fn watch(
        self: &Arc<Self>,
        interval: Duration,
        stop: Arc<AtomicBool>,
    ) -> std::io::Result<()> {
        let display = Arc::clone(self);
        std::thread::Builder::new()
            .name("notch-displays".into())
            .spawn(move || loop {
                std::thread::sleep(interval);
                if stop.load(Ordering::SeqCst) {
                    return;
                }
                let monitors = monitors();
                if !monitors.is_empty() {
                    display.refresh(&monitors);
                }
            })
            .map(drop)
    }
}

mod win32 {
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{LPARAM, POINT, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        EnumDisplayMonitors, GetMonitorInfoW, MonitorFromPoint, HDC, HMONITOR, MONITORINFO,
        MONITORINFOEXW, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTOPRIMARY,
    };
    use windows_sys::Win32::UI::HiDpi::{GetDpiForMonitor, MDT_EFFECTIVE_DPI};
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetCursorPos, MONITORINFOF_PRIMARY};

    use super::{MonitorInfo, PxRect};

    pub fn info(monitor: HMONITOR) -> Option<MonitorInfo> {
        // SAFETY: a zeroed MONITORINFOEXW with cbSize set is what GetMonitorInfoW expects; the
        // DPI query writes two u32 out-params. A failure is reported, never read.
        unsafe {
            let mut info: MONITORINFOEXW = std::mem::zeroed();
            info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
            if GetMonitorInfoW(monitor, (&raw mut info).cast::<MONITORINFO>()) == 0 {
                return None;
            }
            let (mut dpi_x, mut dpi_y) = (96u32, 96u32);
            if GetDpiForMonitor(monitor, MDT_EFFECTIVE_DPI, &mut dpi_x, &mut dpi_y) != 0 {
                dpi_x = 96;
            }
            let device_len = info
                .szDevice
                .iter()
                .position(|&c| c == 0)
                .unwrap_or(info.szDevice.len());
            let work = info.monitorInfo.rcWork;
            Some(MonitorInfo {
                device: String::from_utf16_lossy(&info.szDevice[..device_len]),
                bounds_px: PxRect {
                    left: info.monitorInfo.rcMonitor.left,
                    top: info.monitorInfo.rcMonitor.top,
                    right: info.monitorInfo.rcMonitor.right,
                    bottom: info.monitorInfo.rcMonitor.bottom,
                },
                work_px: PxRect {
                    left: work.left,
                    top: work.top,
                    right: work.right,
                    bottom: work.bottom,
                },
                scale: f64::from(dpi_x) / 96.0,
                primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
            })
        }
    }

    unsafe extern "system" fn collect(
        monitor: HMONITOR,
        _hdc: HDC,
        _rect: *mut RECT,
        data: LPARAM,
    ) -> BOOL {
        // SAFETY: `data` is the `&mut Vec` passed by `all` below, alive for the whole enumeration.
        let monitors = unsafe { &mut *(data as *mut Vec<HMONITOR>) };
        monitors.push(monitor);
        1
    }

    pub fn all() -> Vec<MonitorInfo> {
        let mut handles: Vec<HMONITOR> = Vec::new();
        // SAFETY: the callback only pushes into `handles`, which outlives the call.
        unsafe {
            EnumDisplayMonitors(
                std::ptr::null_mut(),
                std::ptr::null(),
                Some(collect),
                (&raw mut handles) as LPARAM,
            );
        }
        handles.into_iter().filter_map(info).collect()
    }

    pub fn at_cursor() -> Option<MonitorInfo> {
        let mut point = POINT { x: 0, y: 0 };
        // SAFETY: a valid out-pointer; MonitorFromPoint takes the point by value.
        unsafe {
            if GetCursorPos(&mut point) == 0 {
                return None;
            }
            info(MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST))
        }
    }

    pub fn primary() -> Option<MonitorInfo> {
        // SAFETY: plain query by value; (0, 0) is always on the primary monitor.
        unsafe {
            info(MonitorFromPoint(
                POINT { x: 0, y: 0 },
                MONITOR_DEFAULTTOPRIMARY,
            ))
        }
    }
}

/// Every connected monitor (empty if Win32 fails).
pub fn monitors() -> Vec<MonitorInfo> {
    win32::all()
}

/// The monitor under the cursor.
pub fn monitor_at_cursor() -> Option<MonitorInfo> {
    win32::at_cursor()
}

/// The primary monitor, where the capsule starts (like `screen.getPrimaryDisplay()`).
pub fn primary_monitor() -> Option<MonitorInfo> {
    win32::primary()
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::notch::geometry::WINDOW_WIDTH;

    fn monitor(
        device: &str,
        work_px: (i32, i32, i32, i32),
        scale: f64,
        primary: bool,
    ) -> MonitorInfo {
        MonitorInfo {
            device: device.into(),
            bounds_px: PxRect {
                left: work_px.0,
                top: work_px.1,
                right: work_px.2,
                bottom: work_px.3,
            },
            work_px: PxRect {
                left: work_px.0,
                top: work_px.1,
                right: work_px.2,
                bottom: work_px.3,
            },
            scale,
            primary,
        }
    }

    #[test]
    fn work_area_is_in_the_monitors_dip() {
        let right = monitor("B", (1920, 0, 1920 + 2880, 1728 - 72), 1.5, false);
        assert_eq!(
            work_area_dip(&right),
            Rect {
                x: 1280.0,
                y: 0.0,
                width: 1920.0,
                height: 1104.0
            }
        );
        let main = monitor("A", (0, 0, 1920, 1032), 1.0, true);
        assert_eq!(work_area_dip(&main).width, 1920.0);
    }

    #[test]
    fn keeps_its_monitor_while_it_exists_else_the_primary() {
        let a = monitor("A", (0, 0, 1920, 1032), 1.0, true);
        let b = monitor("B", (1920, 0, 3840, 1032), 1.0, false);
        let both = [a.clone(), b.clone()];
        assert_eq!(pick_monitor(&both, "B"), Some(&b));
        assert_eq!(pick_monitor(&both, "C"), Some(&a));
        assert_eq!(pick_monitor(std::slice::from_ref(&b), "C"), Some(&b));
        assert_eq!(pick_monitor(&[], "A"), None);
    }

    #[derive(Default)]
    struct Bounds(Mutex<Vec<Rect>>);

    impl crate::notch::controller::NotchSurface for Bounds {
        fn set_bounds(&self, rect: Rect) {
            self.0.lock().unwrap().push(rect);
        }
        fn show(&self) {}
        fn hide(&self) {}
        fn focus(&self) {}
        fn blur(&self) {}
        fn set_ignore_mouse(&self, _ignore: bool) {}
        fn send_mode(&self, _mode: crate::notch::state::NotchMode) {}
        fn send_mail_alert(&self, _on: bool) {}
        fn send_review_alert(&self, _on: bool) {}
        fn send_redmine_alert(&self, _on: bool) {}
    }

    #[test]
    fn a_removed_monitor_sends_the_capsule_to_the_primary() {
        let a = monitor("A", (0, 0, 1920, 1032), 1.0, true);
        let b = monitor("B", (1920, 0, 1920 + 2880, 1656), 1.5, false);
        let surface = Arc::new(Bounds::default());
        let controller = NotchController::new(
            surface.clone(),
            Arc::new(crate::services::timers::TestTimers::new()),
            work_area_dip(&b),
            500,
        );
        controller.start();
        let scale = Arc::new(MonitorScale::new(b.scale));
        let display = NotchDisplay::new(b.clone(), Arc::clone(&scale), controller);
        surface.0.lock().unwrap().clear();

        // Nothing changed: no window call.
        display.refresh(&[a.clone(), b.clone()]);
        assert!(surface.0.lock().unwrap().is_empty());
        // Its work area changed (taskbar): same monitor, new bounds.
        let mut taller = b.clone();
        taller.work_px.bottom = 1728;
        display.refresh(&[a.clone(), taller]);
        assert_eq!(surface.0.lock().unwrap().len(), 1);
        // Unplugged: the primary, at its scale.
        display.refresh(std::slice::from_ref(&a));
        assert_eq!(display.current().device, "A");
        assert_eq!(scale.get(), 1.0);
        // Centred on its 1920 px work area.
        assert_eq!(
            surface.0.lock().unwrap().last().unwrap().x,
            (1920.0 - WINDOW_WIDTH) / 2.0
        );
    }

    #[test]
    fn the_real_monitors_include_a_primary() {
        let monitors = monitors();
        assert!(!monitors.is_empty());
        assert!(monitors.iter().any(|m| m.primary));
        assert!(monitors.iter().all(|m| m.scale >= 1.0));
        assert_eq!(primary_monitor().map(|m| m.primary), Some(true));
    }
}
