//! Hover for the capsule. Electron forwards mouse moves to a click-through window, so the renderer
//! sees `pointerenter`/`pointerleave`; Tauri cannot, so a thread polls the cursor every 33 ms
//! against the capsule's box (reported by the renderer through `notch:capsule-rect`) and
//! dispatches `pointer` when it crosses the edge. The controller then toggles click-through.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use super::controller::NotchController;
use super::geometry::{capsule_size, capsule_top_for, Rect, VisibleMode, WINDOW_WIDTH};
use super::state::{NotchEvent, NotchMode};

/// Whether the cursor (physical px, screen) is over the capsule (DIP, relative to the window
/// whose top-left is `window_origin_px` at `scale`). Edges are half-open: left/top in, right/bottom out.
pub fn cursor_inside(
    capsule_dip: Rect,
    window_origin_px: (i32, i32),
    scale: f64,
    cursor_px: (i32, i32),
) -> bool {
    let x = f64::from(cursor_px.0 - window_origin_px.0);
    let y = f64::from(cursor_px.1 - window_origin_px.1);
    let left = capsule_dip.x * scale;
    let top = capsule_dip.y * scale;
    x >= left
        && x < left + capsule_dip.width * scale
        && y >= top
        && y < top + capsule_dip.height * scale
}

/// Where a mode's capsule sits before the renderer has reported its box: its nominal size,
/// centred in the window at its top offset.
pub fn default_capsule_rect(mode: VisibleMode) -> Rect {
    let size = capsule_size(mode);
    Rect {
        x: (WINDOW_WIDTH - size.width) / 2.0,
        y: capsule_top_for(mode),
        width: size.width,
        height: size.height,
    }
}

/// The last capsule box the renderer reported (`notch:capsule-rect`).
#[derive(Default)]
pub struct CapsuleRectStore {
    last: Mutex<Option<Rect>>,
}

impl CapsuleRectStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set(&self, rect: Rect) {
        *self.last.lock().unwrap_or_else(PoisonError::into_inner) = Some(rect);
    }

    pub fn last(&self) -> Option<Rect> {
        *self.last.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The box to test the cursor against in `mode`; `None` while hidden (no capsule).
    pub fn rect_for(&self, mode: NotchMode) -> Option<Rect> {
        let visible = VisibleMode::from_notch_mode(mode)?;
        Some(self.last().unwrap_or_else(|| default_capsule_rect(visible)))
    }
}

/// Decides when the poller dispatches `pointer`: only when the answer changes, never while hidden.
/// Hiding makes the controller ignore the mouse, so it counts as "outside" from then on.
#[derive(Default)]
pub struct PointerTracker {
    inside: bool,
}

impl PointerTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// The `inside` to dispatch, if any.
    pub fn update(&mut self, mode: NotchMode, inside: bool) -> Option<bool> {
        if mode == NotchMode::Hidden {
            self.inside = false;
            return None;
        }
        if inside == self.inside {
            return None;
        }
        self.inside = inside;
        Some(inside)
    }
}

/// The notch window's top-left (physical px) and scale factor, cached from its `Moved` and
/// `ScaleFactorChanged` events so the poller never queries the window.
pub struct WindowPlacement {
    inner: Mutex<((i32, i32), f64)>,
}

impl WindowPlacement {
    pub fn new(origin_px: (i32, i32), scale: f64) -> Self {
        Self {
            inner: Mutex::new((origin_px, scale)),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ((i32, i32), f64)> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn set_origin(&self, origin_px: (i32, i32)) {
        self.lock().0 = origin_px;
    }

    pub fn set_scale(&self, scale: f64) {
        self.lock().1 = scale;
    }

    pub fn get(&self) -> ((i32, i32), f64) {
        *self.lock()
    }
}

/// One poll: where the cursor is against the current mode's capsule, and the dispatch it causes.
pub fn poll_once(
    controller: &NotchController,
    rects: &CapsuleRectStore,
    placement: &WindowPlacement,
    tracker: &mut PointerTracker,
    cursor_px: (i32, i32),
) {
    let mode = controller.mode();
    let inside = rects.rect_for(mode).is_some_and(|rect| {
        let (origin, scale) = placement.get();
        cursor_inside(rect, origin, scale, cursor_px)
    });
    if let Some(inside) = tracker.update(mode, inside) {
        controller.dispatch(NotchEvent::Pointer { inside });
    }
}

/// Runs one poll so that a panic in it cannot end hover for the rest of the session: it is
/// logged (only the first time, as it would repeat every 33 ms) and the caller keeps polling.
/// Returns whether the poll completed.
pub fn guarded_poll(panicked: &mut bool, poll: impl FnOnce()) -> bool {
    if catch_unwind(AssertUnwindSafe(poll)).is_ok() {
        return true;
    }
    if !std::mem::replace(panicked, true) {
        log::error!("notch: the cursor poll panicked; polling continues");
    }
    false
}

/// The polling thread. It runs until `stop` is set (the quit sequence).
pub struct CursorPoller;

impl CursorPoller {
    pub fn start(
        controller: Arc<NotchController>,
        rects: Arc<CapsuleRectStore>,
        placement: Arc<WindowPlacement>,
        interval_ms: u64,
        stop: Arc<AtomicBool>,
    ) -> std::io::Result<()> {
        std::thread::Builder::new()
            .name("notch-cursor".into())
            .spawn(move || {
                let mut tracker = PointerTracker::new();
                let interval = std::time::Duration::from_millis(interval_ms);
                let mut panicked = false;
                while !stop.load(Ordering::SeqCst) {
                    if let Some(cursor) = cursor_position() {
                        guarded_poll(&mut panicked, || {
                            poll_once(&controller, &rects, &placement, &mut tracker, cursor);
                        });
                    }
                    std::thread::sleep(interval);
                }
            })
            .map(drop)
    }
}

/// `GetCursorPos`, in physical screen px; `None` when it fails (e.g. on the secure desktop).
fn cursor_position() -> Option<(i32, i32)> {
    use windows_sys::Win32::{Foundation::POINT, UI::WindowsAndMessaging::GetCursorPos};
    let mut point = POINT { x: 0, y: 0 };
    // SAFETY: a valid out-pointer to a local.
    let ok = unsafe { GetCursorPos(&mut point) };
    (ok != 0).then_some((point.x, point.y))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notch::controller::NotchSurface;
    use crate::services::timers::TestTimers;

    const fn rect(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn cursor_in_capsule_is_inside() {
        let capsule = rect(296.0, 6.0, 168.0, 36.0);
        assert!(cursor_inside(capsule, (0, 0), 1.0, (380, 24)));
        assert!(cursor_inside(capsule, (100, 50), 1.0, (480, 74)));
    }

    #[test]
    fn cursor_in_shadow_is_outside() {
        let capsule = rect(56.0, 6.0, 168.0, 36.0);
        assert!(!cursor_inside(capsule, (0, 0), 1.0, (30, 20)));
        // Below the capsule, in the shadow room.
        assert!(!cursor_inside(capsule, (0, 0), 1.0, (100, 60)));
    }

    #[test]
    fn rect_scales_with_monitor() {
        let capsule = rect(296.0, 6.0, 168.0, 36.0);
        assert!(cursor_inside(
            capsule,
            (1920, 0),
            1.5,
            (1920 + 444 + 10, 9 + 10)
        ));
        // The capsule's near edge is at 296 * 1.5 = 444 px: 440 is left of it.
        assert!(!cursor_inside(capsule, (1920, 0), 1.5, (1920 + 440, 19)));
        // The capsule's far edge is at 296 * 1.5 + 168 * 1.5 = 696 px.
        assert!(cursor_inside(capsule, (1920, 0), 1.5, (1920 + 695, 19)));
        assert!(!cursor_inside(capsule, (1920, 0), 1.5, (1920 + 696, 19)));
    }

    #[test]
    fn edges_are_half_open() {
        let capsule = rect(10.0, 6.0, 20.0, 10.0);
        let at = |x, y| cursor_inside(capsule, (0, 0), 1.0, (x, y));
        assert!(at(10, 6), "top-left corner is in");
        assert!(at(29, 15), "last pixel is in");
        assert!(!at(30, 10), "right edge is out");
        assert!(!at(20, 16), "bottom edge is out");
        assert!(!at(9, 10), "left of the left edge is out");
        assert!(!at(20, 5), "above the top edge is out");
    }

    #[test]
    fn default_rect_is_the_mode_size_centred() {
        assert_eq!(
            default_capsule_rect(VisibleMode::Peek),
            rect((WINDOW_WIDTH - 177.0) / 2.0, 6.0, 177.0, 36.0)
        );
        assert_eq!(default_capsule_rect(VisibleMode::Mini).y, 0.0);
    }

    #[test]
    fn store_falls_back_to_the_default_until_a_rect_arrives() {
        let store = CapsuleRectStore::new();
        assert_eq!(store.rect_for(NotchMode::Hidden), None);
        assert_eq!(
            store.rect_for(NotchMode::Peek),
            Some(default_capsule_rect(VisibleMode::Peek))
        );
        let reported = rect(201.0, 6.0, 358.0, 36.0);
        store.set(reported);
        assert_eq!(store.rect_for(NotchMode::Compact), Some(reported));
        assert_eq!(store.rect_for(NotchMode::Hidden), None);
    }

    #[test]
    fn tracker_reports_changes_only_and_never_while_hidden() {
        let mut tracker = PointerTracker::new();
        assert_eq!(tracker.update(NotchMode::Peek, false), None);
        assert_eq!(tracker.update(NotchMode::Peek, true), Some(true));
        assert_eq!(tracker.update(NotchMode::Compact, true), None);
        assert_eq!(tracker.update(NotchMode::Compact, false), Some(false));
        assert_eq!(tracker.update(NotchMode::Peek, true), Some(true));
        // Hidden: nothing is sent, and hiding counts as having left.
        assert_eq!(tracker.update(NotchMode::Hidden, true), None);
        assert_eq!(tracker.update(NotchMode::Hidden, false), None);
        assert_eq!(tracker.update(NotchMode::Peek, true), Some(true));
    }

    #[test]
    fn a_panicking_poll_is_contained_and_polling_goes_on() {
        let mut panicked = false;
        assert!(!guarded_poll(&mut panicked, || panic!("poll failed")));
        assert!(panicked);
        assert!(!guarded_poll(&mut panicked, || panic!("poll failed again")));
        let mut ran = false;
        assert!(guarded_poll(&mut panicked, || ran = true));
        assert!(ran, "the next poll still runs");
    }

    #[derive(Default)]
    struct Recorder {
        ignores: Mutex<Vec<bool>>,
    }

    impl NotchSurface for Recorder {
        fn set_bounds(&self, _rect: Rect) {}
        fn show(&self) {}
        fn hide(&self) {}
        fn focus(&self) {}
        fn blur(&self) {}
        fn set_ignore_mouse(&self, ignore: bool) {
            self.ignores.lock().unwrap().push(ignore);
        }
        fn send_mode(&self, _mode: NotchMode) {}
        fn send_mail_alert(&self, _on: bool) {}
        fn send_review_alert(&self, _on: bool) {}
        fn send_redmine_alert(&self, _on: bool) {}
    }

    #[test]
    fn polling_hovers_the_capsule_and_toggles_click_through() {
        let surface = Arc::new(Recorder::default());
        let controller = NotchController::new(
            surface.clone(),
            Arc::new(TestTimers::new()),
            rect(0.0, 0.0, 1920.0, 1032.0),
            1_000,
        );
        controller.start();
        let rects = CapsuleRectStore::new();
        let placement = WindowPlacement::new((494, 0), 1.0);
        let mut tracker = PointerTracker::new();
        // Peek at its default box: x 377.5..554.5 in the window, so 871.5..1048.5 on screen.
        let mut poll = |cursor| poll_once(&controller, &rects, &placement, &mut tracker, cursor);
        poll((500, 20));
        assert_eq!(controller.mode(), NotchMode::Peek);
        poll((900, 20));
        assert_eq!(controller.mode(), NotchMode::Compact);
        poll((901, 21));
        poll((900, 80));
        assert_eq!(controller.mode(), NotchMode::Peek);
        // start() ignores the mouse; then one call per crossing.
        assert_eq!(*surface.ignores.lock().unwrap(), vec![true, false, true]);
    }
}
