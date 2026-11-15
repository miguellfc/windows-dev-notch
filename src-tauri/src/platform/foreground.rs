//! Hides the capsule while a fullscreen app is in front (ports `src/main/platform/foreground-
//! classifier.ts` and `foreground-watcher.ts`). The classifier is pure; the probe lives in
//! `win32.rs`; the watcher polls it on a thread of its own and reports only changes of verdict.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::Duration;

use crate::notch::display::PxRect;
use crate::notch::state::Yielding;

/// Windows' own view of the session (`SHQueryUserNotificationState`), simplified.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotificationState {
    Normal,
    Busy,
    D3d,
    Presentation,
    App,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForegroundSnapshot {
    /// The foreground window's HWND, `None` when there is none.
    pub handle: Option<isize>,
    pub class_name: String,
    /// The window covers its whole monitor (borderless fullscreen, F11, games).
    pub covers_monitor: bool,
    /// Monitor of the foreground window, in physical px.
    pub monitor: PxRect,
    pub notification_state: NotificationState,
}

pub struct ClassifyContext {
    pub own_handles: Vec<isize>,
    /// Monitor the capsule lives on, in physical px.
    pub notch_monitor: PxRect,
}

/// `Keep` means "this window says nothing new": our own windows, the taskbar, unknown.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    None,
    Hidden,
    Keep,
}

impl Verdict {
    /// The yielding the controller should take, or `None` for `Keep` (no dispatch).
    pub fn yielding(self) -> Option<Yielding> {
        match self {
            Self::None => Some(Yielding::None),
            Self::Hidden => Some(Yielding::Hidden),
            Self::Keep => None,
        }
    }
}

/// Decides how the capsule yields to the foreground window: only fullscreen hides it. Geometry is
/// checked first because Windows reports fullscreen ~0.5 s late.
pub fn classify_foreground(snapshot: &ForegroundSnapshot, ctx: &ClassifyContext) -> Verdict {
    let Some(handle) = snapshot.handle else {
        return Verdict::Keep;
    };
    if ctx.own_handles.contains(&handle) {
        return Verdict::Keep;
    }
    match snapshot.class_name.as_str() {
        "Shell_TrayWnd" | "Shell_SecondaryTrayWnd" => return Verdict::Keep,
        "Progman" | "WorkerW" => return Verdict::None,
        _ => {}
    }
    if snapshot.monitor != ctx.notch_monitor {
        // A fullscreen app elsewhere does not concern this monitor; presentation mode is system-wide.
        return if snapshot.notification_state == NotificationState::Presentation {
            Verdict::Hidden
        } else {
            Verdict::None
        };
    }
    let fullscreen_state = matches!(
        snapshot.notification_state,
        NotificationState::Busy
            | NotificationState::D3d
            | NotificationState::Presentation
            | NotificationState::App
    );
    if snapshot.covers_monitor || fullscreen_state {
        Verdict::Hidden
    } else {
        Verdict::None
    }
}

type Probe = Box<dyn Fn() -> Result<Verdict, String> + Send + Sync>;
type OnChange = Box<dyn Fn(Yielding) + Send + Sync>;

struct CoreState {
    current: Yielding,
    failing: bool,
    logged_errors: usize,
}

/// The watcher's logic without the thread, so it is testable tick by tick.
pub(crate) struct WatcherCore {
    probe: Probe,
    on_change: OnChange,
    state: Mutex<CoreState>,
    /// Set by `stop`: later ticks (a refresh from a hook that outlives the watcher) do nothing.
    stopped: AtomicBool,
}

impl WatcherCore {
    pub(crate) fn new(probe: Probe, on_change: OnChange) -> Self {
        Self {
            probe,
            on_change,
            stopped: AtomicBool::new(false),
            state: Mutex::new(CoreState {
                current: Yielding::None,
                failing: false,
                logged_errors: 0,
            }),
        }
    }

    /// One poll. `force` reports the verdict even when it did not change.
    pub(crate) fn tick(&self, force: bool) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        // Held across the probe and the report so a refresh and a poll never interleave.
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let verdict = match (self.probe)() {
            Ok(verdict) => {
                state.failing = false;
                verdict
            }
            Err(error) => {
                // Once per failure streak, and only the cause (no window titles or paths).
                if !state.failing {
                    state.logged_errors += 1;
                    log::error!("foreground: probe failed: {error}");
                }
                state.failing = true;
                return;
            }
        };
        let Some(next) = verdict.yielding() else {
            return;
        };
        if next == state.current && !force {
            return;
        }
        state.current = next;
        (self.on_change)(next);
    }

    pub(crate) fn current(&self) -> Yielding {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .current
    }

    #[cfg(test)]
    pub(crate) fn logged_errors(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .logged_errors
    }
}

/// Polls the foreground window and reports only changes of verdict.
pub struct ForegroundWatcher {
    core: Arc<WatcherCore>,
    stop: Arc<(Mutex<bool>, Condvar)>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl ForegroundWatcher {
    pub fn start(interval_ms: u64, probe: Probe, on_change: OnChange) -> std::io::Result<Self> {
        let core = Arc::new(WatcherCore::new(probe, on_change));
        let stop = Arc::new((Mutex::new(false), Condvar::new()));
        let thread = {
            let core = Arc::clone(&core);
            let stop = Arc::clone(&stop);
            std::thread::Builder::new()
                .name("notch-foreground".into())
                .spawn(move || {
                    let (flag, wake) = &*stop;
                    let interval = Duration::from_millis(interval_ms);
                    loop {
                        let guard = flag.lock().unwrap_or_else(PoisonError::into_inner);
                        let (guard, _) = wake
                            .wait_timeout_while(guard, interval, |stopped| !*stopped)
                            .unwrap_or_else(PoisonError::into_inner);
                        if *guard {
                            return;
                        }
                        drop(guard);
                        core.tick(false);
                    }
                })?
        };
        Ok(Self {
            core,
            stop,
            thread: Mutex::new(Some(thread)),
        })
    }

    /// Probes now and reports the verdict even if unchanged (e.g. the capsule moved monitor).
    pub fn refresh(&self) {
        self.core.tick(true);
    }

    pub fn current(&self) -> Yielding {
        self.core.current()
    }

    /// Stops polling. Never blocks (it may run on the main thread, which a tick in flight can be
    /// waiting on): the thread exits by itself once its current tick ends.
    pub fn stop(&self) {
        self.core.stopped.store(true, Ordering::SeqCst);
        let (flag, wake) = &*self.stop;
        *flag.lock().unwrap_or_else(PoisonError::into_inner) = true;
        wake.notify_all();
        // Dropping the handle detaches the thread.
        drop(
            self.thread
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take(),
        );
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::notch::display::PxRect;
    use crate::notch::state::Yielding;

    const MONITOR: PxRect = PxRect {
        left: 0,
        top: 0,
        right: 1920,
        bottom: 1080,
    };
    const OTHER: PxRect = PxRect {
        left: 1920,
        top: 0,
        right: 4480,
        bottom: 1440,
    };

    fn snap() -> ForegroundSnapshot {
        ForegroundSnapshot {
            handle: Some(100),
            class_name: "Chrome_WidgetWin_1".into(),
            covers_monitor: false,
            monitor: MONITOR,
            notification_state: NotificationState::Normal,
        }
    }

    fn classify(snapshot: &ForegroundSnapshot) -> Verdict {
        let ctx = ClassifyContext {
            own_handles: vec![999],
            notch_monitor: MONITOR,
        };
        classify_foreground(snapshot, &ctx)
    }

    #[test]
    fn ordinary_window_is_none() {
        assert_eq!(classify(&snap()), Verdict::None);
    }

    #[test]
    fn own_window_keeps() {
        let own = ForegroundSnapshot {
            handle: Some(999),
            ..snap()
        };
        assert_eq!(classify(&own), Verdict::Keep);
        let unknown = ForegroundSnapshot {
            handle: None,
            ..snap()
        };
        assert_eq!(classify(&unknown), Verdict::Keep);
    }

    #[test]
    fn taskbar_keeps() {
        for class in ["Shell_TrayWnd", "Shell_SecondaryTrayWnd"] {
            let taskbar = ForegroundSnapshot {
                class_name: class.into(),
                ..snap()
            };
            assert_eq!(classify(&taskbar), Verdict::Keep, "{class}");
        }
    }

    #[test]
    fn desktop_is_none() {
        for class in ["Progman", "WorkerW"] {
            let desktop = ForegroundSnapshot {
                class_name: class.into(),
                covers_monitor: true,
                ..snap()
            };
            assert_eq!(classify(&desktop), Verdict::None, "{class}");
        }
    }

    #[test]
    fn fullscreen_same_monitor_hides() {
        let covering = ForegroundSnapshot {
            covers_monitor: true,
            ..snap()
        };
        assert_eq!(classify(&covering), Verdict::Hidden);
        for state in [
            NotificationState::Busy,
            NotificationState::D3d,
            NotificationState::Presentation,
            NotificationState::App,
        ] {
            let reported = ForegroundSnapshot {
                notification_state: state,
                ..snap()
            };
            assert_eq!(classify(&reported), Verdict::Hidden, "{state:?}");
        }
    }

    #[test]
    fn presentation_elsewhere_hides() {
        let elsewhere = ForegroundSnapshot {
            notification_state: NotificationState::Presentation,
            monitor: OTHER,
            ..snap()
        };
        assert_eq!(classify(&elsewhere), Verdict::Hidden);
    }

    #[test]
    fn fullscreen_elsewhere_is_none() {
        let elsewhere = ForegroundSnapshot {
            covers_monitor: true,
            monitor: OTHER,
            ..snap()
        };
        assert_eq!(classify(&elsewhere), Verdict::None);
    }

    type Script = Vec<Result<Verdict, String>>;

    /// Drives the watcher's tick by hand: one scripted probe result per call, the last one repeats.
    fn core(script: Script) -> (Arc<WatcherCore>, Arc<Mutex<Vec<Yielding>>>) {
        let calls = AtomicUsize::new(0);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&seen);
        let core = WatcherCore::new(
            Box::new(move || {
                let i = calls.fetch_add(1, Ordering::SeqCst).min(script.len() - 1);
                script[i].clone()
            }),
            Box::new(move |verdict| sink.lock().unwrap().push(verdict)),
        );
        (Arc::new(core), seen)
    }

    fn ok(verdict: Verdict) -> Result<Verdict, String> {
        Ok(verdict)
    }

    #[test]
    fn watcher_reports_only_changes() {
        use Verdict::{Hidden, None as No};
        let (core, seen) = core(vec![ok(No), ok(No), ok(Hidden), ok(Hidden), ok(No), ok(No)]);
        for _ in 0..6 {
            core.tick(false);
        }
        assert_eq!(
            *seen.lock().unwrap(),
            vec![Yielding::Hidden, Yielding::None]
        );
        assert_eq!(core.current(), Yielding::None);
    }

    #[test]
    fn keep_leaves_the_previous_verdict() {
        use Verdict::{Hidden, Keep, None as No};
        let (core, seen) = core(vec![ok(Hidden), ok(Keep), ok(Keep), ok(No)]);
        for _ in 0..4 {
            core.tick(false);
        }
        assert_eq!(
            *seen.lock().unwrap(),
            vec![Yielding::Hidden, Yielding::None]
        );
    }

    #[test]
    fn refresh_reports_unchanged() {
        let (core, seen) = core(vec![ok(Verdict::Hidden)]);
        core.tick(false);
        core.tick(true);
        assert_eq!(
            *seen.lock().unwrap(),
            vec![Yielding::Hidden, Yielding::Hidden]
        );
    }

    #[test]
    fn probe_error_logged_once() {
        let (core, seen) = core(vec![
            Err("boom".into()),
            Err("boom".into()),
            ok(Verdict::Hidden),
            Err("again".into()),
        ]);
        for _ in 0..4 {
            core.tick(false);
        }
        assert_eq!(*seen.lock().unwrap(), vec![Yielding::Hidden]);
        // One streak of two failures, then a second streak: two log lines in all, not three.
        assert_eq!(core.logged_errors(), 2);
    }

    #[test]
    fn stopped_watcher_ignores_refresh() {
        let (core, seen) = core(vec![ok(Verdict::Hidden)]);
        core.stopped.store(true, Ordering::SeqCst);
        core.tick(true);
        assert!(seen.lock().unwrap().is_empty());
    }

    #[test]
    fn stop_ends_polling() {
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&hits);
        let watcher = ForegroundWatcher::start(
            5,
            Box::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                Ok(Verdict::None)
            }),
            Box::new(|_| {}),
        )
        .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(60));
        watcher.stop();
        // A tick already in flight may still finish.
        std::thread::sleep(std::time::Duration::from_millis(20));
        let after_stop = hits.load(Ordering::SeqCst);
        assert!(after_stop > 0);
        std::thread::sleep(std::time::Duration::from_millis(40));
        assert_eq!(hits.load(Ordering::SeqCst), after_stop);
    }
}
