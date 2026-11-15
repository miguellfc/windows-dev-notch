//! Puts the capsule together (the "Capsule" block of `src/main/index.ts`): window, surface,
//! controller, cursor poller and monitor tracking.

use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use tauri::{AppHandle, WebviewWindow, WindowEvent};

use super::controller::NotchController;
use super::cursor::{CapsuleRectStore, CursorPoller, WindowPlacement};
use super::display::{
    monitors, primary_monitor, work_area_dip, MonitorInfo, MonitorScale, NotchDisplay, PxRect,
};
use super::ipc::{NotchHandles, NotchSlot};
use super::state::NotchEvent;
use super::window::{create_notch_window, TauriNotchSurface};
use crate::ipc::dev_overrides_enabled;
use crate::platform::foreground::{
    classify_foreground, ClassifyContext, ForegroundWatcher, Verdict,
};
use crate::platform::win32::probe_foreground;
#[cfg(feature = "e2e")]
use crate::services::timers::TestTimers;
use crate::services::timers::{RealTimers, Timers};

/// Fallback for a shrink whose animation never reports its end (`settleTimeoutMs` in TS).
pub const SETTLE_TIMEOUT_MS: u64 = 500;
/// Cursor polling period, like the spike's Electron twin.
pub const CURSOR_POLL_MS: u64 = 33;
/// Monitor polling period (see `display.rs`).
pub const DISPLAY_POLL: Duration = Duration::from_secs(2);
/// Foreground window polling period.
pub const FOREGROUND_POLL_MS: u64 = 500;

pub struct NotchRuntime {
    pub window: WebviewWindow,
    pub controller: Arc<NotchController>,
    pub rects: Arc<CapsuleRectStore>,
    pub display: Arc<NotchDisplay>,
    placement: Arc<WindowPlacement>,
    started: AtomicBool,
    /// Set by [`stop_pollers`](Self::stop_pollers): the cursor and monitor threads exit.
    pollers_stopped: Arc<AtomicBool>,
    foreground: Mutex<Option<Arc<ForegroundWatcher>>>,
    /// HWND of the Control Center window, 0 while it does not exist (see `set_control_center_hwnd`).
    control_center_hwnd: Arc<AtomicIsize>,
    /// The controller's timers, shared with the part-2 services (see [`timers`](Self::timers)).
    timers: Arc<dyn Timers>,
    /// The controller's timers when the `e2e` build runs with `NOTCH_TEST_CLOCK=1`.
    #[cfg(feature = "e2e")]
    test_clock: Option<Arc<TestTimers>>,
}

/// Used only if Win32 reports no monitor at all.
fn fallback_monitor() -> MonitorInfo {
    MonitorInfo {
        device: String::new(),
        bounds_px: PxRect {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1080,
        },
        work_px: PxRect {
            left: 0,
            top: 0,
            right: 1920,
            bottom: 1032,
        },
        scale: 1.0,
        primary: true,
    }
}

impl NotchRuntime {
    /// Creates the hidden window and the controller on the primary monitor, and fills `slot` for
    /// the `notch:*` handlers. Nothing is shown until [`page_loaded`](Self::page_loaded).
    pub fn install(app: &AppHandle, slot: &NotchSlot) -> tauri::Result<Arc<Self>> {
        let monitor = primary_monitor()
            .or_else(|| monitors().into_iter().next())
            .unwrap_or_else(fallback_monitor);
        let scale = Arc::new(MonitorScale::new(monitor.scale));
        let window = create_notch_window(app)?;
        let surface = Arc::new(TauriNotchSurface::new(window.clone(), Arc::clone(&scale))?);
        let real: Arc<dyn Timers> = Arc::new(RealTimers::new());
        #[cfg(feature = "e2e")]
        let test_clock = crate::e2e::test_clock_enabled()
            .then(|| Arc::new(TestTimers::over_real(Arc::clone(&real))));
        #[cfg(feature = "e2e")]
        let real: Arc<dyn Timers> = match &test_clock {
            Some(clock) => Arc::clone(clock) as Arc<dyn Timers>,
            None => real,
        };
        let timers = real;
        let controller = NotchController::new(
            surface,
            Arc::clone(&timers),
            work_area_dip(&monitor),
            SETTLE_TIMEOUT_MS,
        );
        let rects = Arc::new(CapsuleRectStore::new());
        let origin = window.outer_position()?;
        let placement = Arc::new(WindowPlacement::new(
            (origin.x, origin.y),
            window.scale_factor()?,
        ));
        let display = Arc::new(NotchDisplay::new(monitor, scale, Arc::clone(&controller)));

        {
            let controller = Arc::clone(&controller);
            let placement = Arc::clone(&placement);
            window.on_window_event(move |event| match event {
                WindowEvent::Moved(position) => placement.set_origin((position.x, position.y)),
                WindowEvent::ScaleFactorChanged { scale_factor, .. } => {
                    placement.set_scale(*scale_factor);
                }
                // Like Electron's `blur`: leaving the panel closes it (focus only exists in panels).
                WindowEvent::Focused(false) => controller.dispatch(NotchEvent::Dismiss),
                _ => {}
            });
        }

        let handles = NotchHandles {
            controller: Arc::clone(&controller),
            rects: Arc::clone(&rects),
        };
        if slot.set(handles).is_err() {
            log::error!("notch: the window was installed twice");
        }
        Ok(Arc::new(Self {
            window,
            controller,
            rects,
            display,
            placement,
            started: AtomicBool::new(false),
            pollers_stopped: Arc::new(AtomicBool::new(false)),
            foreground: Mutex::new(None),
            control_center_hwnd: Arc::new(AtomicIsize::new(0)),
            timers,
            #[cfg(feature = "e2e")]
            test_clock,
        }))
    }

    /// The timers the controller uses: real ones, or the test clock's (`e2e` build with
    /// `NOTCH_TEST_CLOCK=1`), so other modules' timers move with `__e2e:advance-clock` too.
    pub fn timers(&self) -> Arc<dyn Timers> {
        Arc::clone(&self.timers)
    }

    /// The test clock the controller's timers follow (`e2e` build with `NOTCH_TEST_CLOCK=1`).
    #[cfg(feature = "e2e")]
    pub fn test_clock(&self) -> Option<&Arc<TestTimers>> {
        self.test_clock.as_ref()
    }

    /// Whoever creates or destroys the Control Center window (Task 9) reports its HWND here, from
    /// the main thread (`window.hwnd()`), so the watcher never has to ask the main thread itself.
    pub fn set_control_center_hwnd(&self, hwnd: Option<isize>) {
        self.control_center_hwnd
            .store(hwnd.unwrap_or(0), Ordering::SeqCst);
    }

    /// Starts the foreground watcher: a fullscreen app in front hides the capsule. Disabled by
    /// `NOTCH_DISABLE_FOREGROUND_WATCH=1` in dev builds only.
    pub fn start_foreground_watch(&self) {
        if dev_overrides_enabled()
            && std::env::var("NOTCH_DISABLE_FOREGROUND_WATCH").as_deref() == Ok("1")
        {
            log::info!("foreground: watcher disabled by NOTCH_DISABLE_FOREGROUND_WATCH");
            return;
        }
        // `hwnd()` is a blocking round trip to the main thread (tauri-runtime-wry's window_getter),
        // so it is read once here and the watcher thread never calls it.
        let notch_hwnd = match self.window.hwnd() {
            Ok(hwnd) => hwnd.0 as isize,
            Err(error) => {
                log::error!("foreground: no window handle, watcher not started: {error}");
                return;
            }
        };
        let control_center = Arc::clone(&self.control_center_hwnd);
        let display = Arc::clone(&self.display);
        let controller = Arc::clone(&self.controller);
        let probe = Box::new(move || {
            let snapshot = probe_foreground()?;
            // The Control Center may not exist yet (or any more): 0 means none.
            let mut own_handles = vec![notch_hwnd];
            match control_center.load(Ordering::SeqCst) {
                0 => {}
                hwnd => own_handles.push(hwnd),
            }
            let ctx = ClassifyContext {
                own_handles,
                notch_monitor: display.current().bounds_px,
            };
            Ok::<Verdict, String>(classify_foreground(&snapshot, &ctx))
        });
        let on_change = Box::new(move |verdict| {
            controller.dispatch(NotchEvent::Foreground { verdict });
        });
        match ForegroundWatcher::start(FOREGROUND_POLL_MS, probe, on_change) {
            Ok(watcher) => {
                let watcher = Arc::new(watcher);
                // The verdict depends on which monitor the capsule is on.
                let refresher = Arc::clone(&watcher);
                self.display
                    .set_on_change(Arc::new(move || refresher.refresh()));
                *self
                    .foreground
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner) = Some(watcher);
            }
            Err(error) => log::error!("foreground: could not start the watcher: {error}"),
        }
    }

    /// Stops the foreground watcher (the quit sequence).
    pub fn stop_foreground_watch(&self) {
        let watcher = self
            .foreground
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        if let Some(watcher) = watcher {
            watcher.stop();
        }
    }

    /// Stops the cursor and monitor pollers (the quit sequence). Never blocks: each thread exits
    /// after its current sleep.
    pub fn stop_pollers(&self) {
        self.pollers_stopped.store(true, Ordering::SeqCst);
    }

    /// The notch page finished loading (Electron's `ready-to-show`): show the capsule and start
    /// hover and monitor tracking. A reload only reaches `start()`, which ignores a second call.
    pub fn page_loaded(&self) {
        self.controller.start();
        if self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        if cursor_poll_disabled() {
            // Tests drive hover through `notch:pointer`; the user's real cursor must not.
            log::info!("notch: cursor poller disabled by NOTCH_DISABLE_CURSOR_POLL");
        } else if let Err(error) = CursorPoller::start(
            Arc::clone(&self.controller),
            Arc::clone(&self.rects),
            Arc::clone(&self.placement),
            CURSOR_POLL_MS,
            Arc::clone(&self.pollers_stopped),
        ) {
            log::error!("notch: could not start the cursor poller: {error}");
        }
        if let Err(error) = self
            .display
            .watch(DISPLAY_POLL, Arc::clone(&self.pollers_stopped))
        {
            log::error!("notch: could not start the monitor watcher: {error}");
        }
    }
}

/// `NOTCH_DISABLE_CURSOR_POLL=1`, in dev builds only (R5): hover comes from `notch:pointer` alone.
fn cursor_poll_disabled() -> bool {
    dev_overrides_enabled() && std::env::var("NOTCH_DISABLE_CURSOR_POLL").as_deref() == Ok("1")
}
