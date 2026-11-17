//! Port of 0.1.0's `notch-controller.ts`: owns the capsule's state and drives the window
//! in the order M0 validated: grow the window then animate; animate then shrink the window. It
//! compares against the size the window actually has, so a shrink still in progress is never cut
//! short.
//!
//! The state lives under a `Mutex` that is held only to compute a transition. The window calls
//! and listener calls it produces are queued and run after the lock is released, in order: a
//! timer or a listener may dispatch again (from any thread) without deadlocking, and the window
//! never sees two dispatches' calls interleaved.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use super::geometry::{resize_order, window_bounds_for, Rect, ResizeOrder, VisibleMode};
use super::state::{
    is_capsule_hidden, mail_alert_shown, notch_mode, redmine_alert_shown, reduce_notch,
    review_alert_shown, NotchEvent, NotchMode, NotchState, MAIL_ALERT_MS, PANEL_MODES,
    REDMINE_ALERT_MS, REVIEW_ALERT_MS, STICKY_COMPACT_MS,
};
use crate::services::timers::{TimerId, Timers};

/// What the controller needs from the capsule window; the Tauri adapter implements it.
pub trait NotchSurface: Send + Sync {
    fn set_bounds(&self, rect: Rect);
    /// Show without stealing focus.
    fn show(&self);
    fn hide(&self);
    fn focus(&self);
    fn blur(&self);
    fn set_ignore_mouse(&self, ignore: bool);
    fn send_mode(&self, mode: NotchMode);
    /// Whether the alert capsule shows the new-mail alert; sent before the mode that shows it.
    fn send_mail_alert(&self, on: bool);
    /// Whether the alert capsule shows the first-review alert; sent before the mode that shows it.
    fn send_review_alert(&self, on: bool);
    /// Whether the alert capsule shows the end-of-day Redmine alert; sent before the mode that shows it.
    fn send_redmine_alert(&self, on: bool);
}

type ModeListener = Arc<dyn Fn(NotchMode) + Send + Sync>;
type HiddenListener = Arc<dyn Fn(bool) + Send + Sync>;

/// A surface or listener call, queued under the lock and run after it.
#[derive(Clone, Copy, Debug)]
enum Effect {
    SetBounds(Rect),
    Show,
    Hide,
    Focus,
    Blur,
    IgnoreMouse(bool),
    Mode(NotchMode),
    Alert(AlertKind, bool),
    ModeChanged(NotchMode),
    HiddenChanged(bool),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AlertKind {
    Mail,
    Review,
    Redmine,
}

impl AlertKind {
    const ALL: [Self; 3] = [Self::Mail, Self::Review, Self::Redmine];

    fn duration_ms(self) -> u64 {
        match self {
            Self::Mail => MAIL_ALERT_MS,
            Self::Review => REVIEW_ALERT_MS,
            Self::Redmine => REDMINE_ALERT_MS,
        }
    }

    fn shown(self, state: &NotchState) -> bool {
        match self {
            Self::Mail => mail_alert_shown(state),
            Self::Review => review_alert_shown(state),
            Self::Redmine => redmine_alert_shown(state),
        }
    }

    /// The event that ends this alert when its timer fires.
    fn off(self) -> NotchEvent {
        match self {
            Self::Mail => NotchEvent::Mail { on: false },
            Self::Review => NotchEvent::Review { on: false },
            Self::Redmine => NotchEvent::Redmine { on: false },
        }
    }
}

/// An armed timer. The token tells a callback that fires late (after it was cleared or replaced,
/// which real timers on another thread allow) that it no longer owns the slot.
#[derive(Clone, Copy, Debug)]
struct Slot {
    token: u64,
    id: TimerId,
}

struct Inner {
    state: NotchState,
    mode: NotchMode,
    /// Last value of each `*_alert_shown`, sent to the renderer whenever it changes.
    mail_shown: bool,
    review_shown: bool,
    redmine_shown: bool,
    /// Last value of `is_capsule_hidden`, reported through `on_hidden_change`.
    hidden: bool,
    work_area: Rect,
    /// Mode the window is currently sized for (may be larger than `mode` while shrinking).
    window_mode: VisibleMode,
    pending_shrink: Option<(VisibleMode, Slot)>,
    mail_timer: Option<Slot>,
    review_timer: Option<Slot>,
    redmine_timer: Option<Slot>,
    /// Ends the sticky compact after a click on the pill if the pointer never reaches compact.
    sticky_timer: Option<Slot>,
    started: bool,
    disposed: bool,
    next_token: u64,
    effects: VecDeque<Effect>,
    /// Some call is running the queued effects; others only queue theirs.
    draining: bool,
}

impl Inner {
    fn emit(&mut self, effect: Effect) {
        self.effects.push_back(effect);
    }

    fn shown(&mut self, kind: AlertKind) -> &mut bool {
        match kind {
            AlertKind::Mail => &mut self.mail_shown,
            AlertKind::Review => &mut self.review_shown,
            AlertKind::Redmine => &mut self.redmine_shown,
        }
    }

    fn alert_timer(&mut self, kind: AlertKind) -> &mut Option<Slot> {
        match kind {
            AlertKind::Mail => &mut self.mail_timer,
            AlertKind::Review => &mut self.review_timer,
            AlertKind::Redmine => &mut self.redmine_timer,
        }
    }
}

fn is_panel(mode: NotchMode) -> bool {
    PANEL_MODES.contains(&mode)
}

fn visible(mode: NotchMode) -> VisibleMode {
    VisibleMode::from_notch_mode(mode).expect("only `hidden` has no capsule")
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Owns the capsule's state and drives the window. Shared as `Arc`; its timers hold a `Weak`, so
/// a pending timer never keeps a dropped controller alive.
pub struct NotchController {
    me: Weak<NotchController>,
    surface: Arc<dyn NotchSurface>,
    timers: Arc<dyn Timers>,
    /// Fallback if the renderer never reports the end of a shrinking animation.
    settle_timeout_ms: u64,
    inner: Mutex<Inner>,
    /// Called in registration order (see [`add_mode_listener`](Self::add_mode_listener)).
    mode_listeners: Mutex<Vec<ModeListener>>,
    /// The capsule became hidden or shown again (by the user or yielding); alerts over it do not count.
    on_hidden_change: Mutex<Option<HiddenListener>>,
}

impl NotchController {
    pub fn new(
        surface: Arc<dyn NotchSurface>,
        timers: Arc<dyn Timers>,
        work_area: Rect,
        settle_timeout_ms: u64,
    ) -> Arc<Self> {
        let state = NotchState::default();
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            surface,
            timers,
            settle_timeout_ms,
            inner: Mutex::new(Inner {
                state,
                mode: notch_mode(&state),
                mail_shown: false,
                review_shown: false,
                redmine_shown: false,
                hidden: is_capsule_hidden(&state),
                work_area,
                window_mode: VisibleMode::Peek,
                pending_shrink: None,
                mail_timer: None,
                review_timer: None,
                redmine_timer: None,
                sticky_timer: None,
                started: false,
                disposed: false,
                next_token: 0,
                effects: VecDeque::new(),
                draining: false,
            }),
            mode_listeners: Mutex::new(Vec::new()),
            on_hidden_change: Mutex::new(None),
        })
    }

    /// The window is ready: show it in whatever state events have produced so far.
    pub fn start(&self) {
        let mut s = self.lock();
        if !s.started && !s.disposed {
            s.started = true;
            if s.mode != NotchMode::Hidden {
                let mode = visible(s.mode);
                Self::resize_to(&mut s, mode);
            }
            s.emit(Effect::IgnoreMouse(true));
            for kind in AlertKind::ALL {
                if *s.shown(kind) {
                    s.emit(Effect::Alert(kind, true));
                }
            }
            let mode = s.mode;
            s.emit(Effect::Mode(mode));
            s.emit(if mode == NotchMode::Hidden {
                Effect::Hide
            } else {
                Effect::Show
            });
        }
        self.drain(s);
    }

    pub fn dispatch(&self, event: NotchEvent) {
        let mut s = self.lock();
        self.apply(&mut s, event);
        self.drain(s);
    }

    /// The renderer finished a shrinking animation; the window may shrink now.
    pub fn settled(&self) {
        let mut s = self.lock();
        self.finish_shrink(&mut s);
        self.drain(s);
    }

    pub fn set_work_area(&self, work_area: Rect) {
        let mut s = self.lock();
        s.work_area = work_area;
        if s.started && !s.disposed && s.mode != NotchMode::Hidden {
            self.cancel_pending_shrink(&mut s);
            let mode = visible(s.mode);
            Self::resize_to(&mut s, mode);
        }
        self.drain(s);
    }

    pub fn mode(&self) -> NotchMode {
        self.lock().mode
    }

    /// Whether the capsule is hidden (by the user or yielding) with no panel open. An alert shows
    /// the window over it while the capsule stays hidden: the tray offers "Show", not "Hide".
    pub fn hidden(&self) -> bool {
        self.lock().hidden
    }

    /// Stops pending work; the controller ignores everything afterwards.
    pub fn dispose(&self) {
        let mut s = self.lock();
        s.disposed = true;
        // Window calls still queued (disposed from a listener or another thread) never run.
        s.effects.clear();
        self.cancel_pending_shrink(&mut s);
        for kind in AlertKind::ALL {
            self.clear_slot(s.alert_timer(kind));
        }
        self.clear_slot(&mut s.sticky_timer);
    }

    /// Adds a listener called after the window calls of each dispatch that changes the mode,
    /// outside the lock. Listeners accumulate and run in registration order (the tray, the
    /// system monitor...); none replaces another.
    pub fn add_mode_listener(&self, f: impl Fn(NotchMode) + Send + Sync + 'static) {
        lock(&self.mode_listeners).push(Arc::new(f));
    }

    /// Alias of [`add_mode_listener`](Self::add_mode_listener) (kept for the tray's wiring).
    pub fn on_mode_change(&self, f: impl Fn(NotchMode) + Send + Sync + 'static) {
        self.add_mode_listener(f);
    }

    /// Called after the window calls of each dispatch that changes [`hidden`](Self::hidden).
    pub fn on_hidden_change(&self, f: impl Fn(bool) + Send + Sync + 'static) {
        *lock(&self.on_hidden_change) = Some(Arc::new(f));
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        lock(&self.inner)
    }

    fn apply(&self, s: &mut Inner, event: NotchEvent) {
        if s.disposed {
            return;
        }
        let raised = match event {
            NotchEvent::Mail { on: true } => Some(AlertKind::Mail),
            NotchEvent::Review { on: true } => Some(AlertKind::Review),
            NotchEvent::Redmine { on: true } => Some(AlertKind::Redmine),
            _ => None,
        };
        if let Some(kind) = raised {
            // Never shown with a panel open (the state drops it too); each new alert restarts its 6 s.
            if is_panel(s.mode) {
                return;
            }
            self.clear_slot(s.alert_timer(kind));
            let slot = self.arm(s, kind.duration_ms(), move |c, token| {
                c.alert_fired(kind, token)
            });
            *s.alert_timer(kind) = Some(slot);
        }
        let next = reduce_notch(&s.state, &event);
        if next == s.state {
            return;
        }
        // The sticky compact (after a click on the pill) has a deadline; anything that ends it
        // first clears it.
        if next.sticky_compact && !s.state.sticky_compact {
            self.clear_slot(&mut s.sticky_timer);
            let slot = self.arm(s, STICKY_COMPACT_MS, |c, token| c.sticky_fired(token));
            s.sticky_timer = Some(slot);
        } else if !next.sticky_compact {
            self.clear_slot(&mut s.sticky_timer);
        }
        s.state = next;
        // The alert's kind can change while the mode stays `alert` (a permission over a mail
        // alert, a review replacing mail), and it reaches the renderer before a mode change that
        // shows it. The ones turning off go first, so the renderer never sees two on.
        for on in [false, true] {
            for kind in AlertKind::ALL {
                if kind.shown(&s.state) == on && *s.shown(kind) != on {
                    *s.shown(kind) = on;
                    if s.started {
                        s.emit(Effect::Alert(kind, on));
                    }
                }
            }
        }
        let next_mode = notch_mode(&s.state);
        let mode_changed = next_mode != s.mode;
        if mode_changed {
            let from = s.mode;
            s.mode = next_mode;
            log::debug!(
                "notch: mode change from {} to {} on {event:?}",
                from.as_str(),
                next_mode.as_str()
            );
            // Before the window is ready only the state moves; start() applies it.
            if s.started {
                self.transition(s, from, next_mode);
            }
        }
        let next_hidden = is_capsule_hidden(&s.state);
        let hidden_changed = next_hidden != s.hidden;
        s.hidden = next_hidden;
        if let NotchEvent::Pointer { inside } = event {
            if s.started && s.mode != NotchMode::Hidden {
                s.emit(Effect::IgnoreMouse(!inside));
            }
        }
        // The listeners run after this dispatch's window calls.
        if mode_changed {
            s.emit(Effect::ModeChanged(next_mode));
        }
        if hidden_changed {
            s.emit(Effect::HiddenChanged(next_hidden));
        }
    }

    fn transition(&self, s: &mut Inner, from: NotchMode, to: NotchMode) {
        self.cancel_pending_shrink(s);
        if to == NotchMode::Hidden {
            s.emit(Effect::Mode(NotchMode::Hidden));
            s.emit(Effect::Hide);
            s.emit(Effect::IgnoreMouse(true));
        } else if from == NotchMode::Hidden {
            Self::resize_to(s, visible(to));
            s.emit(Effect::Mode(to));
            s.emit(Effect::Show);
        } else if resize_order(s.window_mode, visible(to)) == ResizeOrder::ResizeFirst {
            Self::resize_to(s, visible(to));
            s.emit(Effect::Mode(to));
        } else {
            s.emit(Effect::Mode(to));
            let slot = self.arm(s, self.settle_timeout_ms, |c, token| c.shrink_fired(token));
            s.pending_shrink = Some((visible(to), slot));
        }
        // Focus belongs to the panel; moving between panel views keeps it, leaving gives it back.
        if is_panel(to) && !is_panel(from) {
            s.emit(Effect::Focus);
        } else if is_panel(from) && !is_panel(to) {
            s.emit(Effect::Blur);
        }
    }

    fn resize_to(s: &mut Inner, target: VisibleMode) {
        let bounds = window_bounds_for(target, s.work_area);
        s.emit(Effect::SetBounds(bounds));
        s.window_mode = target;
    }

    fn finish_shrink(&self, s: &mut Inner) {
        if s.disposed {
            return;
        }
        if let Some((target, _)) = s.pending_shrink {
            self.cancel_pending_shrink(s);
            Self::resize_to(s, target);
        }
    }

    fn cancel_pending_shrink(&self, s: &mut Inner) {
        if let Some((_, slot)) = s.pending_shrink.take() {
            self.timers.clear(slot.id);
        }
    }

    fn clear_slot(&self, slot: &mut Option<Slot>) {
        if let Some(slot) = slot.take() {
            self.timers.clear(slot.id);
        }
    }

    /// Arms a timer that calls `fire` with its token on this controller, if it still exists.
    fn arm(
        &self,
        s: &mut Inner,
        ms: u64,
        fire: impl FnOnce(&NotchController, u64) + Send + 'static,
    ) -> Slot {
        let token = s.next_token;
        s.next_token += 1;
        let me = self.me.clone();
        let id = self.timers.set_timeout(
            ms,
            Box::new(move || {
                if let Some(controller) = me.upgrade() {
                    fire(&controller, token);
                }
            }),
        );
        Slot { token, id }
    }

    fn owns(slot: Option<Slot>, token: u64) -> bool {
        slot.is_some_and(|slot| slot.token == token)
    }

    fn alert_fired(&self, kind: AlertKind, token: u64) {
        let mut s = self.lock();
        if Self::owns(*s.alert_timer(kind), token) {
            *s.alert_timer(kind) = None;
            self.apply(&mut s, kind.off());
        }
        self.drain(s);
    }

    fn sticky_fired(&self, token: u64) {
        let mut s = self.lock();
        if Self::owns(s.sticky_timer, token) {
            s.sticky_timer = None;
            self.apply(&mut s, NotchEvent::StickyEnd);
        }
        self.drain(s);
    }

    fn shrink_fired(&self, token: u64) {
        let mut s = self.lock();
        if Self::owns(s.pending_shrink.map(|(_, slot)| slot), token) {
            self.finish_shrink(&mut s);
        }
        self.drain(s);
    }

    /// Runs the queued effects in order with the lock released. A call made while another one is
    /// draining (a listener dispatching, or another thread) only queues; that drainer runs them.
    fn drain<'a>(&'a self, mut s: MutexGuard<'a, Inner>) {
        if s.draining {
            return;
        }
        s.draining = true;
        let reset = DrainReset(self);
        while let Some(effect) = s.effects.pop_front() {
            drop(s);
            self.run(effect);
            s = self.lock();
        }
        s.draining = false;
        drop(s);
        std::mem::forget(reset);
    }

    fn run(&self, effect: Effect) {
        let surface = &self.surface;
        match effect {
            Effect::SetBounds(rect) => surface.set_bounds(rect),
            Effect::Show => surface.show(),
            Effect::Hide => surface.hide(),
            Effect::Focus => surface.focus(),
            Effect::Blur => surface.blur(),
            Effect::IgnoreMouse(ignore) => surface.set_ignore_mouse(ignore),
            Effect::Mode(mode) => surface.send_mode(mode),
            Effect::Alert(AlertKind::Mail, on) => surface.send_mail_alert(on),
            Effect::Alert(AlertKind::Review, on) => surface.send_review_alert(on),
            Effect::Alert(AlertKind::Redmine, on) => surface.send_redmine_alert(on),
            Effect::ModeChanged(mode) => {
                // A snapshot: a listener may add another one without deadlocking.
                let listeners = lock(&self.mode_listeners).clone();
                for listener in listeners {
                    listener(mode);
                }
            }
            Effect::HiddenChanged(hidden) => {
                let listener = lock(&self.on_hidden_change).clone();
                if let Some(listener) = listener {
                    listener(hidden);
                }
            }
        }
    }
}

/// Only dropped (not forgotten) when a surface or listener call panics mid-drain: the next call
/// then drains again instead of queueing forever.
struct DrainReset<'a>(&'a NotchController);

impl Drop for DrainReset<'_> {
    fn drop(&mut self) {
        self.0.lock().draining = false;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::contract::notch::IntegrationId;
    use crate::notch::geometry::{window_bounds_for, VisibleMode};
    use crate::notch::state::{
        ClaudeItem, Yielding, MAIL_ALERT_MS, REDMINE_ALERT_MS, REVIEW_ALERT_MS, STICKY_COMPACT_MS,
    };
    use crate::services::timers::TestTimers;
    use NotchEvent as E;

    const WORK_AREA: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 1920.0,
        height: 1032.0,
    };

    #[derive(Default)]
    struct Log {
        /// Window calls and modes, without the alert flags (the TS `calls`).
        calls: Vec<String>,
        /// Everything, alert flags included, in order.
        order: Vec<String>,
        rects: Vec<Rect>,
        ignores: Vec<bool>,
        modes: Vec<String>,
        mail: Vec<bool>,
        review: Vec<bool>,
        redmine: Vec<bool>,
    }

    #[derive(Default)]
    struct FakeSurface {
        log: Mutex<Log>,
    }

    impl FakeSurface {
        fn call(&self, call: String) {
            let mut log = self.log.lock().unwrap();
            log.calls.push(call.clone());
            log.order.push(call);
        }
    }

    impl NotchSurface for FakeSurface {
        fn set_bounds(&self, rect: Rect) {
            self.log.lock().unwrap().rects.push(rect);
            self.call(format!("bounds:{}x{}", rect.width, rect.height));
        }
        fn show(&self) {
            self.call("show".into());
        }
        fn hide(&self) {
            self.call("hide".into());
        }
        fn focus(&self) {
            self.call("focus".into());
        }
        fn blur(&self) {
            self.call("blur".into());
        }
        fn set_ignore_mouse(&self, ignore: bool) {
            self.log.lock().unwrap().ignores.push(ignore);
            self.call(format!("ignore:{ignore}"));
        }
        fn send_mode(&self, mode: NotchMode) {
            self.log.lock().unwrap().modes.push(mode.as_str().into());
            self.call(format!("mode:{}", mode.as_str()));
        }
        fn send_mail_alert(&self, on: bool) {
            let mut log = self.log.lock().unwrap();
            log.mail.push(on);
            log.order.push(format!("mail:{on}"));
        }
        fn send_review_alert(&self, on: bool) {
            let mut log = self.log.lock().unwrap();
            log.review.push(on);
            log.order.push(format!("review:{on}"));
        }
        fn send_redmine_alert(&self, on: bool) {
            let mut log = self.log.lock().unwrap();
            log.redmine.push(on);
            log.order.push(format!("redmine:{on}"));
        }
    }

    struct Harness {
        controller: Arc<NotchController>,
        surface: Arc<FakeSurface>,
        timers: Arc<TestTimers>,
        mode_changes: Arc<Mutex<Vec<NotchMode>>>,
        hidden_changes: Arc<Mutex<Vec<bool>>>,
    }

    impl Harness {
        /// Built, not started.
        fn unstarted() -> Self {
            let surface = Arc::new(FakeSurface::default());
            let timers = Arc::new(TestTimers::new());
            let controller = NotchController::new(surface.clone(), timers.clone(), WORK_AREA, 400);
            let mode_changes = Arc::new(Mutex::new(Vec::new()));
            let hidden_changes = Arc::new(Mutex::new(Vec::new()));
            let modes = mode_changes.clone();
            controller.on_mode_change(move |mode| modes.lock().unwrap().push(mode));
            let hiddens = hidden_changes.clone();
            controller.on_hidden_change(move |hidden| hiddens.lock().unwrap().push(hidden));
            Self {
                controller,
                surface,
                timers,
                mode_changes,
                hidden_changes,
            }
        }

        /// Started, with the start calls still recorded (`placed()` in TS).
        fn placed() -> Self {
            let h = Self::unstarted();
            h.controller.start();
            h
        }

        /// Started, with the record cleared (`setup()` in TS).
        fn setup() -> Self {
            let h = Self::placed();
            h.reset();
            h
        }

        fn dispatch(&self, event: NotchEvent) {
            self.controller.dispatch(event);
        }

        fn mode(&self) -> NotchMode {
            self.controller.mode()
        }

        fn advance(&self, ms: u64) {
            self.timers.advance(ms);
        }

        fn reset(&self) {
            *self.surface.log.lock().unwrap() = Log::default();
        }

        fn log<T>(&self, read: impl FnOnce(&Log) -> T) -> T {
            read(&self.surface.log.lock().unwrap())
        }

        fn calls(&self) -> Vec<String> {
            self.log(|log| log.calls.clone())
        }

        fn order(&self) -> Vec<String> {
            self.log(|log| log.order.clone())
        }

        fn mail(&self) -> Vec<bool> {
            self.log(|log| log.mail.clone())
        }

        fn review(&self) -> Vec<bool> {
            self.log(|log| log.review.clone())
        }

        fn redmine(&self) -> Vec<bool> {
            self.log(|log| log.redmine.clone())
        }

        fn rects(&self) -> Vec<Rect> {
            self.log(|log| log.rects.clone())
        }

        fn ignores(&self) -> Vec<bool> {
            self.log(|log| log.ignores.clone())
        }
    }

    fn at(mode: VisibleMode) -> Rect {
        window_bounds_for(mode, WORK_AREA)
    }

    fn size(mode: VisibleMode) -> String {
        let bounds = at(mode);
        format!("bounds:{}x{}", bounds.width, bounds.height)
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    const OPEN_SYSTEM: NotchEvent = E::OpenIntegration {
        id: IntegrationId::System,
    };
    const OPEN_REMINDERS: NotchEvent = E::OpenIntegration {
        id: IntegrationId::Reminders,
    };
    const OPEN_NOTES: NotchEvent = E::OpenIntegration {
        id: IntegrationId::Notes,
    };
    const YIELD_HIDDEN: NotchEvent = E::Foreground {
        verdict: Yielding::Hidden,
    };
    const YIELD_NONE: NotchEvent = E::Foreground {
        verdict: Yielding::None,
    };

    // --- notch controller ---

    #[test]
    fn starts_in_peek_visible_and_click_through() {
        let h = Harness::placed();
        assert_eq!(
            h.calls(),
            [
                size(VisibleMode::Peek),
                "ignore:true".into(),
                "mode:peek".into(),
                "show".into()
            ]
        );
    }

    #[test]
    fn events_before_start_only_move_state() {
        let h = Harness::unstarted();
        h.dispatch(YIELD_HIDDEN);
        assert!(h.calls().is_empty());
        assert_eq!(h.mode(), NotchMode::Hidden);
        h.controller.start();
        assert_eq!(h.calls(), strings(&["ignore:true", "mode:hidden", "hide"]));

        let other = Harness::unstarted();
        other.dispatch(E::PinMini);
        other.controller.start();
        assert_eq!(
            other.calls(),
            [
                size(VisibleMode::Mini),
                "ignore:true".into(),
                "mode:mini".into(),
                "show".into()
            ]
        );
    }

    #[test]
    fn alerts_raised_before_start_are_sent_on_start_before_the_mode() {
        let h = Harness::unstarted();
        h.dispatch(E::Mail { on: true });
        assert!(h.order().is_empty());
        h.controller.start();
        h.controller.start();
        assert_eq!(
            h.order(),
            [
                size(VisibleMode::Alert),
                "ignore:true".into(),
                "mail:true".into(),
                "mode:alert".into(),
                "show".into()
            ]
        );
    }

    #[test]
    fn grows_window_before_mode_and_shrinks_after_settle() {
        let h = Harness::setup();
        h.dispatch(E::Expand);
        assert_eq!(
            h.calls(),
            [
                size(VisibleMode::Expanded),
                "mode:expanded".into(),
                "focus".into()
            ]
        );
        assert_eq!(*h.mode_changes.lock().unwrap(), [NotchMode::Expanded]);
        h.reset();
        h.dispatch(E::Dismiss);
        assert_eq!(h.calls(), strings(&["mode:peek", "blur"]));
        h.controller.settled();
        assert_eq!(
            h.calls(),
            ["mode:peek".into(), "blur".into(), size(VisibleMode::Peek)]
        );
    }

    #[test]
    fn shrink_falls_back_after_settle_timeout() {
        let h = Harness::setup();
        h.dispatch(E::Expand);
        h.dispatch(E::Dismiss);
        h.reset();
        h.advance(399);
        assert!(h.calls().is_empty());
        h.advance(1);
        assert_eq!(h.calls(), [size(VisibleMode::Peek)]);
        // Settling afterwards does nothing more.
        h.controller.settled();
        assert_eq!(h.calls(), [size(VisibleMode::Peek)]);
    }

    #[test]
    fn ignores_a_repeated_dismiss_instead_of_cutting_the_animation() {
        let h = Harness::setup();
        h.dispatch(E::Expand);
        h.dispatch(E::Dismiss);
        h.reset();
        h.dispatch(E::Dismiss);
        assert!(h.calls().is_empty());
    }

    #[test]
    fn cancels_a_pending_shrink_when_the_user_re_expands_mid_animation() {
        let h = Harness::setup();
        h.dispatch(E::Expand);
        h.dispatch(E::Dismiss);
        h.dispatch(E::Expand);
        h.reset();
        h.advance(1000);
        h.controller.settled();
        assert!(h.calls().is_empty());
    }

    #[test]
    fn accepts_clicks_only_while_the_pointer_is_over_the_capsule() {
        let h = Harness::setup();
        h.dispatch(E::Pointer { inside: true });
        assert!(h.calls().contains(&"ignore:false".to_string()));
        h.dispatch(E::Pointer { inside: false });
        assert_eq!(h.calls().last().unwrap(), "ignore:true");
    }

    #[test]
    fn hides_immediately_and_shows_again_on_the_right_size() {
        let h = Harness::setup();
        h.dispatch(YIELD_HIDDEN);
        assert_eq!(h.calls(), strings(&["mode:hidden", "hide", "ignore:true"]));
        h.reset();
        h.dispatch(YIELD_NONE);
        assert_eq!(
            h.calls(),
            [size(VisibleMode::Peek), "mode:peek".into(), "show".into()]
        );
    }

    #[test]
    fn repositions_on_a_new_work_area() {
        let h = Harness::setup();
        let next = Rect {
            x: 1920.0,
            y: 0.0,
            width: 2560.0,
            height: 1400.0,
        };
        h.controller.set_work_area(next);
        assert_eq!(h.rects(), [window_bounds_for(VisibleMode::Peek, next)]);
    }

    #[test]
    fn a_new_work_area_while_hidden_or_before_start_only_records_it() {
        let h = Harness::unstarted();
        let next = Rect {
            x: 1920.0,
            y: 0.0,
            width: 2560.0,
            height: 1400.0,
        };
        h.controller.set_work_area(next);
        assert!(h.calls().is_empty());
        h.controller.start();
        assert_eq!(h.rects(), [window_bounds_for(VisibleMode::Peek, next)]);
        h.dispatch(YIELD_HIDDEN);
        h.reset();
        h.controller.set_work_area(WORK_AREA);
        assert!(h.calls().is_empty());
    }

    #[test]
    fn a_new_work_area_cancels_a_pending_shrink_and_sizes_for_the_current_mode() {
        let h = Harness::setup();
        h.dispatch(E::Expand);
        h.dispatch(E::Dismiss);
        h.reset();
        h.controller.set_work_area(WORK_AREA);
        assert_eq!(h.calls(), [size(VisibleMode::Peek)]);
        h.advance(1000);
        h.controller.settled();
        assert_eq!(h.calls(), [size(VisibleMode::Peek)]);
    }

    #[test]
    fn makes_the_window_click_through_again_when_it_hides() {
        let h = Harness::setup();
        h.dispatch(E::Pointer { inside: true });
        h.reset();
        h.dispatch(E::UserVisibility { hidden: true });
        assert_eq!(h.calls(), strings(&["mode:hidden", "hide", "ignore:true"]));
    }

    #[test]
    fn keeps_the_window_large_while_a_shrink_is_pending_even_if_a_smaller_mode_arrives() {
        let h = Harness::setup();
        h.dispatch(E::Expand);
        h.dispatch(E::Dismiss);
        h.reset();
        h.dispatch(E::Pointer { inside: true });
        assert_eq!(h.calls(), strings(&["mode:compact", "ignore:false"]));
        h.controller.settled();
        assert_eq!(*h.calls().last().unwrap(), size(VisibleMode::Compact));
    }

    #[test]
    fn dispose_ignores_everything() {
        let h = Harness::setup();
        h.dispatch(E::Expand);
        h.dispatch(E::Dismiss);
        h.dispatch(E::Mail { on: true });
        h.controller.dispose();
        h.reset();
        h.advance(10_000);
        h.controller.settled();
        h.controller.set_work_area(WORK_AREA);
        h.controller.start();
        h.dispatch(E::Expand);
        assert!(h.order().is_empty());
        assert_eq!(h.mode(), NotchMode::Alert);
    }

    #[test]
    fn a_pending_timer_does_not_keep_a_dropped_controller_alive() {
        let h = Harness::setup();
        h.dispatch(E::Mail { on: true });
        h.dispatch(E::Expand);
        h.dispatch(E::Dismiss);
        let weak = Arc::downgrade(&h.controller);
        let Harness {
            controller, timers, ..
        } = h;
        drop(controller);
        assert!(weak.upgrade().is_none());
        timers.advance(10_000);
    }

    #[test]
    fn two_mode_listeners_both_run_in_order() {
        let h = Harness::setup();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (first, second) = (seen.clone(), seen.clone());
        h.controller
            .add_mode_listener(move |mode| first.lock().unwrap().push(("first", mode)));
        h.controller
            .add_mode_listener(move |mode| second.lock().unwrap().push(("second", mode)));
        h.dispatch(E::Pointer { inside: true });
        assert_eq!(
            *seen.lock().unwrap(),
            [
                ("first", NotchMode::Compact),
                ("second", NotchMode::Compact)
            ]
        );
    }

    #[test]
    fn tray_listener_still_runs_after_adding_another() {
        // `lib.rs` registers the tray refresh with `on_mode_change`; a module adding its own
        // listener later must not replace it.
        let h = Harness::setup();
        let tray = Arc::new(Mutex::new(Vec::new()));
        let other = Arc::new(Mutex::new(Vec::new()));
        let tray_sink = tray.clone();
        h.controller
            .on_mode_change(move |mode| tray_sink.lock().unwrap().push(mode));
        let other_sink = other.clone();
        h.controller
            .add_mode_listener(move |mode| other_sink.lock().unwrap().push(mode));
        h.dispatch(E::Toggle);
        assert_eq!(*tray.lock().unwrap(), [NotchMode::Expanded]);
        assert_eq!(*other.lock().unwrap(), [NotchMode::Expanded]);
        // The harness's own recorder (registered first) still runs too.
        assert_eq!(*h.mode_changes.lock().unwrap(), [NotchMode::Expanded]);
    }

    #[test]
    fn reports_the_current_mode() {
        let h = Harness::setup();
        h.dispatch(E::Toggle);
        assert_eq!(h.mode(), NotchMode::Expanded);
    }

    #[test]
    fn a_listener_may_dispatch_and_its_calls_follow_in_order() {
        let h = Harness::setup();
        let weak = Arc::downgrade(&h.controller);
        h.controller.on_mode_change(move |mode| {
            if mode == NotchMode::Expanded {
                weak.upgrade().unwrap().dispatch(E::Dismiss);
            }
        });
        h.dispatch(E::Expand);
        assert_eq!(
            h.calls(),
            [
                size(VisibleMode::Expanded),
                "mode:expanded".into(),
                "focus".into(),
                "mode:peek".into(),
                "blur".into()
            ]
        );
        assert_eq!(h.mode(), NotchMode::Peek);
    }

    #[test]
    fn mode_listener_runs_after_the_surface_calls_of_its_dispatch() {
        let h = Harness::setup();
        let surface = h.surface.clone();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        h.controller.on_mode_change(move |_| {
            record
                .lock()
                .unwrap()
                .push(surface.log.lock().unwrap().calls.clone());
        });
        h.dispatch(E::Pointer { inside: true });
        assert_eq!(
            *seen.lock().unwrap(),
            [vec![
                size(VisibleMode::Compact),
                "mode:compact".into(),
                "ignore:false".into()
            ]]
        );
    }

    #[test]
    fn focus_on_entering_panel_and_blur_on_leaving() {
        // Grows into the system panel and takes focus, then gives it back on dismiss.
        let h = Harness::setup();
        h.dispatch(OPEN_SYSTEM);
        assert_eq!(
            h.calls(),
            [
                size(VisibleMode::System),
                "mode:system".into(),
                "focus".into()
            ]
        );
        h.reset();
        h.dispatch(E::Dismiss);
        assert_eq!(h.calls(), strings(&["mode:peek", "blur"]));
        // Moving between panel views keeps the focus.
        h.dispatch(OPEN_SYSTEM);
        h.reset();
        h.dispatch(E::Back);
        // The home panel's window is shorter than the system view's: mode first, shrink after.
        assert_eq!(h.calls(), strings(&["mode:expanded"]));
    }

    // --- attention ---

    #[test]
    fn grows_into_the_alert_capsule_without_taking_focus() {
        let h = Harness::setup();
        h.dispatch(E::Attention { on: true });
        assert_eq!(h.calls(), [size(VisibleMode::Alert), "mode:alert".into()]);
    }

    #[test]
    fn takes_focus_when_expanding_into_the_permission_card_and_gives_it_back_on_dismiss() {
        let h = Harness::setup();
        h.dispatch(E::Attention { on: true });
        h.reset();
        h.dispatch(E::Expand);
        assert_eq!(
            h.calls(),
            [
                size(VisibleMode::Permission),
                "mode:permission".into(),
                "focus".into()
            ]
        );
        h.reset();
        h.dispatch(E::Dismiss);
        assert_eq!(h.calls(), strings(&["mode:alert", "blur"]));
    }

    #[test]
    fn grows_the_window_before_animating_from_the_permission_card_into_the_taller_reminders_panel()
    {
        let h = Harness::setup();
        h.dispatch(E::Attention { on: true });
        h.dispatch(E::Expand);
        h.reset();
        h.dispatch(OPEN_REMINDERS);
        assert_eq!(
            h.calls(),
            [size(VisibleMode::Reminders), "mode:reminders".into()]
        );
    }

    #[test]
    fn keeps_focus_between_the_permission_card_and_the_panel() {
        let h = Harness::setup();
        h.dispatch(E::Attention { on: true });
        h.dispatch(E::Expand);
        h.reset();
        h.dispatch(E::Attention { on: false });
        assert_eq!(h.calls(), strings(&["mode:expanded"]));
    }

    // --- reminders ---

    #[test]
    fn grows_into_the_alert_capsule_without_taking_focus_when_a_reminder_is_due() {
        let h = Harness::setup();
        h.dispatch(E::Reminders { due: true });
        assert_eq!(h.calls(), [size(VisibleMode::Alert), "mode:alert".into()]);
    }

    #[test]
    fn grows_before_animating_into_the_reminders_panel_and_takes_focus() {
        let h = Harness::setup();
        h.dispatch(E::Reminders { due: true });
        h.reset();
        h.dispatch(E::Expand);
        assert_eq!(
            h.calls(),
            [
                size(VisibleMode::Reminders),
                "mode:reminders".into(),
                "focus".into()
            ]
        );
    }

    #[test]
    fn takes_focus_when_opening_the_reminders_integration_and_gives_it_back_on_dismiss() {
        let h = Harness::setup();
        h.dispatch(OPEN_REMINDERS);
        assert_eq!(
            h.calls(),
            [
                size(VisibleMode::Reminders),
                "mode:reminders".into(),
                "focus".into()
            ]
        );
        h.reset();
        h.dispatch(E::Dismiss);
        assert_eq!(h.calls(), strings(&["mode:peek", "blur"]));
    }

    #[test]
    fn keeps_the_panel_open_and_focused_when_the_reminder_is_cleared() {
        let h = Harness::setup();
        h.dispatch(E::Reminders { due: true });
        h.dispatch(E::Expand);
        h.reset();
        h.dispatch(E::Reminders { due: false });
        assert!(h.calls().is_empty());
    }

    // --- new mail ---

    #[test]
    fn mail_alert_ends_after_6s_and_restarts_on_new_mail() {
        assert_eq!(MAIL_ALERT_MS, 6000);
        let h = Harness::setup();
        h.dispatch(E::Mail { on: true });
        assert_eq!(h.calls(), [size(VisibleMode::Alert), "mode:alert".into()]);
        h.advance(5999);
        assert_eq!(h.mode(), NotchMode::Alert);
        h.advance(1);
        assert_eq!(h.mode(), NotchMode::Peek);

        // More mail while it shows restarts the 6 s.
        let h = Harness::setup();
        h.dispatch(E::Mail { on: true });
        h.advance(4000);
        h.dispatch(E::Mail { on: true });
        h.advance(4000);
        assert_eq!(h.mode(), NotchMode::Alert);
        h.advance(2000);
        assert_eq!(h.mode(), NotchMode::Peek);
    }

    #[test]
    fn mail_dropped_with_panel_open() {
        let h = Harness::setup();
        h.dispatch(OPEN_NOTES);
        h.reset();
        h.dispatch(E::Mail { on: true });
        assert!(h.order().is_empty());
        h.dispatch(E::Dismiss);
        assert_eq!(h.mode(), NotchMode::Peek);
        // No timer was armed for the dropped mail.
        h.advance(6000);
        assert_eq!(h.mode(), NotchMode::Peek);
    }

    #[test]
    fn mail_never_covers_a_permission_or_a_due_reminder() {
        let h = Harness::setup();
        h.dispatch(E::Attention { on: true });
        h.dispatch(E::Mail { on: true });
        h.dispatch(E::Expand);
        assert_eq!(h.mode(), NotchMode::Permission);

        let other = Harness::setup();
        other.dispatch(E::Mail { on: true });
        other.dispatch(E::Reminders { due: true });
        other.dispatch(E::Expand);
        assert_eq!(other.mode(), NotchMode::Reminders);
    }

    #[test]
    fn opens_the_gmail_view_and_takes_focus_when_expanding_from_the_mail_alert() {
        let h = Harness::setup();
        h.dispatch(E::Mail { on: true });
        h.reset();
        h.dispatch(E::Expand);
        assert_eq!(
            h.calls(),
            [
                size(VisibleMode::Gmail),
                "mode:gmail".into(),
                "focus".into()
            ]
        );
        // The timer ending later changes nothing in the open panel.
        h.reset();
        h.advance(6000);
        assert!(h.calls().is_empty());
    }

    #[test]
    fn tells_the_renderer_whether_the_alert_it_shows_is_the_mail_alert() {
        let h = Harness::setup();
        h.dispatch(E::Mail { on: true });
        assert_eq!(h.mail(), [true]);
        // A permission takes the alert capsule over: no longer the mail alert, mode stays `alert`.
        h.dispatch(E::Attention { on: true });
        assert_eq!(h.mode(), NotchMode::Alert);
        assert_eq!(h.mail(), [true, false]);
        h.dispatch(E::Attention { on: false });
        assert_eq!(h.mail(), [true, false, true]);
        h.advance(6000);
        assert_eq!(h.mail(), [true, false, true, false]);
    }

    #[test]
    fn never_calls_a_reminder_or_permission_alert_a_mail_alert() {
        let h = Harness::setup();
        h.dispatch(E::Reminders { due: true });
        h.dispatch(E::Attention { on: true });
        h.dispatch(E::Mail { on: true });
        assert_eq!(h.mode(), NotchMode::Alert);
        assert!(h.mail().is_empty());
    }

    #[test]
    fn sends_the_mail_alert_flag_ahead_of_the_mode_change() {
        let h = Harness::setup();
        h.dispatch(E::Mail { on: true });
        assert_eq!(
            h.order(),
            [
                "mail:true".into(),
                size(VisibleMode::Alert),
                "mode:alert".into()
            ]
        );
    }

    #[test]
    fn alert_kind_off_is_sent_before_on() {
        let h = Harness::setup();
        h.dispatch(E::Mail { on: true });
        h.reset();
        h.dispatch(E::Review { on: true });
        assert_eq!(h.order(), strings(&["mail:false", "review:true"]));
        h.reset();
        h.dispatch(E::Redmine { on: true });
        assert_eq!(h.order(), strings(&["review:false", "redmine:true"]));
        h.reset();
        h.dispatch(E::Mail { on: true });
        assert_eq!(h.order(), strings(&["redmine:false", "mail:true"]));
    }

    #[test]
    fn stops_the_mail_timer_on_dispose() {
        let h = Harness::setup();
        h.dispatch(E::Mail { on: true });
        h.controller.dispose();
        h.reset();
        h.advance(6000);
        assert!(h.order().is_empty());
        assert_eq!(h.mode(), NotchMode::Alert);
    }

    // --- alerts over a hidden capsule ---

    fn hidden_setup(by_user: bool) -> Harness {
        let h = Harness::setup();
        h.dispatch(if by_user {
            E::UserVisibility { hidden: true }
        } else {
            YIELD_HIDDEN
        });
        assert_eq!(h.mode(), NotchMode::Hidden);
        h.reset();
        h
    }

    #[test]
    fn shows_the_window_without_focus_for_a_permission_and_hides_it_again_when_answered() {
        for by_user in [true, false] {
            let h = hidden_setup(by_user);
            h.dispatch(E::Attention { on: true });
            assert_eq!(h.mode(), NotchMode::Alert);
            assert_eq!(
                h.calls(),
                [size(VisibleMode::Alert), "mode:alert".into(), "show".into()]
            );
            h.reset();
            h.dispatch(E::Attention { on: false });
            assert_eq!(h.mode(), NotchMode::Hidden);
            assert_eq!(h.calls(), strings(&["mode:hidden", "hide", "ignore:true"]));
        }
    }

    #[test]
    fn shows_a_due_reminder_over_the_hidden_capsule_and_hides_again_when_it_is_cleared() {
        let h = hidden_setup(true);
        h.dispatch(E::Reminders { due: true });
        assert_eq!(
            h.calls(),
            [size(VisibleMode::Alert), "mode:alert".into(), "show".into()]
        );
        h.reset();
        h.dispatch(E::Reminders { due: false });
        assert_eq!(h.calls(), strings(&["mode:hidden", "hide", "ignore:true"]));
    }

    #[test]
    fn shows_the_mail_alert_over_the_hidden_capsule_for_6s_then_hides_the_window_again() {
        let h = hidden_setup(false);
        h.dispatch(E::Mail { on: true });
        assert_eq!(h.mail(), [true]);
        assert_eq!(
            h.calls(),
            [size(VisibleMode::Alert), "mode:alert".into(), "show".into()]
        );
        h.reset();
        h.advance(5999);
        assert_eq!(h.mode(), NotchMode::Alert);
        h.advance(1);
        assert_eq!(h.mode(), NotchMode::Hidden);
        assert_eq!(h.calls(), strings(&["mode:hidden", "hide", "ignore:true"]));
        assert_eq!(h.mail(), [false]);
    }

    #[test]
    fn a_repeated_yield_verdict_while_the_alert_shows_does_not_hide_it() {
        let h = hidden_setup(false);
        h.dispatch(E::Attention { on: true });
        h.reset();
        h.dispatch(YIELD_HIDDEN);
        h.dispatch(YIELD_NONE);
        h.dispatch(YIELD_HIDDEN);
        assert_eq!(h.mode(), NotchMode::Alert);
        assert!(!h.calls().contains(&"hide".to_string()));
    }

    #[test]
    fn opens_the_panel_from_the_alert_and_goes_back_to_hidden_when_it_closes() {
        let h = hidden_setup(true);
        h.dispatch(E::Attention { on: true });
        h.dispatch(E::Expand);
        assert_eq!(h.mode(), NotchMode::Permission);
        assert!(h.calls().contains(&"focus".to_string()));
        h.dispatch(E::Attention { on: false });
        h.reset();
        h.dispatch(E::Dismiss);
        assert_eq!(h.mode(), NotchMode::Hidden);
        assert_eq!(
            h.calls(),
            strings(&["mode:hidden", "hide", "ignore:true", "blur"])
        );
    }

    #[test]
    fn show_from_the_alert_un_hides_so_closing_the_panel_leaves_the_capsule_on_screen() {
        let h = hidden_setup(true);
        h.dispatch(E::Attention { on: true });
        h.dispatch(E::Show);
        assert_eq!(h.mode(), NotchMode::Permission);
        assert!(!h.controller.hidden());
        h.dispatch(E::Attention { on: false });
        h.dispatch(E::Dismiss);
        assert_eq!(h.mode(), NotchMode::Peek);
    }

    #[test]
    fn hidden_change_ignores_alerts_over_hidden() {
        let h = Harness::setup();
        assert!(!h.controller.hidden());
        h.dispatch(E::Attention { on: true });
        h.dispatch(E::UserVisibility { hidden: true });
        // Still showing the alert, yet hidden as far as the tray is concerned.
        assert_eq!(h.mode(), NotchMode::Alert);
        assert!(h.controller.hidden());
        assert_eq!(*h.hidden_changes.lock().unwrap(), [true]);
        h.dispatch(E::UserVisibility { hidden: false });
        assert!(!h.controller.hidden());
        assert_eq!(*h.hidden_changes.lock().unwrap(), [true, false]);
    }

    // --- Claude question ---

    #[test]
    fn a_question_grows_into_the_alert_capsule_without_taking_focus_also_from_mini() {
        let h = Harness::setup();
        h.dispatch(E::PinMini);
        h.reset();
        h.dispatch(E::Question { on: true });
        assert_eq!(h.calls(), [size(VisibleMode::Alert), "mode:alert".into()]);
    }

    #[test]
    fn opens_the_question_card_with_focus_and_closes_once_the_card_is_done_with_the_last_item() {
        let h = Harness::setup();
        h.dispatch(E::Question { on: true });
        h.reset();
        h.dispatch(E::Expand);
        assert_eq!(
            h.calls(),
            [
                size(VisibleMode::Question),
                "mode:question".into(),
                "focus".into()
            ]
        );
        h.reset();
        // Answered: the card stays to say so, then asks for the next item.
        h.dispatch(E::Question { on: false });
        assert_eq!(h.mode(), NotchMode::Question);
        h.dispatch(E::Next);
        assert_eq!(h.mode(), NotchMode::Peek);
        assert_eq!(h.calls(), strings(&["mode:peek", "blur"]));
    }

    #[test]
    fn opens_the_earliest_of_a_permission_and_a_question_then_the_other_one() {
        let h = Harness::setup();
        h.dispatch(E::ClaudeFirst {
            kind: ClaudeItem::Question,
        });
        h.dispatch(E::Question { on: true });
        h.dispatch(E::ClaudeFirst {
            kind: ClaudeItem::Question,
        });
        h.dispatch(E::Attention { on: true });
        h.dispatch(E::Expand);
        assert_eq!(h.mode(), NotchMode::Question);
        h.dispatch(E::ClaudeFirst {
            kind: ClaudeItem::Permission,
        });
        h.dispatch(E::Question { on: false });
        h.dispatch(E::Next);
        assert_eq!(h.mode(), NotchMode::Permission);
        h.dispatch(E::Attention { on: false });
        assert_eq!(h.mode(), NotchMode::Expanded);
    }

    #[test]
    fn never_shows_the_new_mail_alert_while_a_question_waits() {
        let h = Harness::setup();
        h.dispatch(E::Question { on: true });
        h.dispatch(E::Mail { on: true });
        assert_eq!(h.mode(), NotchMode::Alert);
        assert!(h.mail().is_empty());
    }

    // --- first-review alert ---

    #[test]
    fn shows_the_review_alert_for_6s_and_tells_the_renderer_before_the_mode() {
        assert_eq!(REVIEW_ALERT_MS, 6000);
        let h = Harness::setup();
        h.dispatch(E::Review { on: true });
        assert_eq!(h.mode(), NotchMode::Alert);
        assert_eq!(
            h.order(),
            [
                "review:true".into(),
                size(VisibleMode::Alert),
                "mode:alert".into()
            ]
        );
        assert!(h.mail().is_empty());
        h.advance(5999);
        assert_eq!(h.mode(), NotchMode::Alert);
        h.advance(1);
        assert_eq!(h.mode(), NotchMode::Peek);
        assert_eq!(h.review(), [true, false]);
    }

    #[test]
    fn the_review_alert_is_ignored_with_a_panel_open() {
        let h = Harness::setup();
        h.dispatch(E::Expand);
        h.dispatch(E::Review { on: true });
        assert_eq!(h.mode(), NotchMode::Expanded);
        assert!(h.review().is_empty());
    }

    #[test]
    fn the_newer_of_mail_and_review_shows_with_its_own_full_6s() {
        let h = Harness::setup();
        h.dispatch(E::Mail { on: true });
        h.advance(4000);
        h.dispatch(E::Review { on: true });
        assert_eq!(h.mail(), [true, false]);
        assert_eq!(h.review(), [true]);
        // The mail timer ending does not cut the review alert short.
        h.advance(2000);
        assert_eq!(h.mode(), NotchMode::Alert);
        h.advance(4000);
        assert_eq!(h.mode(), NotchMode::Peek);
        assert_eq!(h.review(), [true, false]);
    }

    #[test]
    fn the_review_alert_shows_over_a_hidden_capsule_and_hides_again() {
        let h = hidden_setup(true);
        h.dispatch(E::Review { on: true });
        assert_eq!(
            h.calls(),
            [size(VisibleMode::Alert), "mode:alert".into(), "show".into()]
        );
        h.advance(6000);
        assert_eq!(h.mode(), NotchMode::Hidden);
    }

    #[test]
    fn opens_the_reviews_view_when_expanding_from_the_review_alert() {
        let h = Harness::setup();
        h.dispatch(E::Review { on: true });
        h.dispatch(E::Expand);
        assert_eq!(h.mode(), NotchMode::Reviews);
    }

    // --- end-of-day Redmine alert ---

    #[test]
    fn shows_the_redmine_alert_for_6s_and_tells_the_renderer_before_the_mode() {
        assert_eq!(REDMINE_ALERT_MS, 6000);
        let h = Harness::setup();
        h.dispatch(E::Redmine { on: true });
        assert_eq!(h.mode(), NotchMode::Alert);
        assert_eq!(
            h.order(),
            [
                "redmine:true".into(),
                size(VisibleMode::Alert),
                "mode:alert".into()
            ]
        );
        assert!(h.mail().is_empty());
        assert!(h.review().is_empty());
        h.advance(5999);
        assert_eq!(h.mode(), NotchMode::Alert);
        h.advance(1);
        assert_eq!(h.mode(), NotchMode::Peek);
        assert_eq!(h.redmine(), [true, false]);
    }

    #[test]
    fn the_redmine_alert_is_ignored_with_a_panel_open() {
        let h = Harness::setup();
        h.dispatch(E::Expand);
        h.dispatch(E::Redmine { on: true });
        assert_eq!(h.mode(), NotchMode::Expanded);
        assert!(h.redmine().is_empty());
    }

    #[test]
    fn the_newest_of_mail_review_and_redmine_shows_each_with_its_own_full_6s() {
        let h = Harness::setup();
        h.dispatch(E::Mail { on: true });
        h.advance(2000);
        h.dispatch(E::Review { on: true });
        h.advance(2000);
        h.dispatch(E::Redmine { on: true });
        assert_eq!(h.mail(), [true, false]);
        assert_eq!(h.review(), [true, false]);
        assert_eq!(h.redmine(), [true]);
        // The older timers ending do not cut the Redmine alert short.
        h.advance(4000);
        assert_eq!(h.mode(), NotchMode::Alert);
        h.advance(2000);
        assert_eq!(h.mode(), NotchMode::Peek);
        assert_eq!(h.redmine(), [true, false]);
        // And a mail arriving over it replaces it.
        h.dispatch(E::Redmine { on: true });
        h.dispatch(E::Mail { on: true });
        assert_eq!(h.redmine(), [true, false, true, false]);
        assert_eq!(h.mail(), [true, false, true]);
    }

    #[test]
    fn the_redmine_alert_never_covers_a_permission_or_a_due_reminder() {
        let h = Harness::setup();
        h.dispatch(E::Reminders { due: true });
        h.dispatch(E::Redmine { on: true });
        assert!(h.redmine().is_empty());
        h.dispatch(E::Reminders { due: false });
        assert_eq!(h.redmine(), [true]);
        h.dispatch(E::Attention { on: true });
        assert_eq!(h.redmine(), [true, false]);
    }

    #[test]
    fn the_redmine_alert_shows_over_a_hidden_capsule_and_hides_again() {
        let h = hidden_setup(true);
        h.dispatch(E::Redmine { on: true });
        assert_eq!(
            h.calls(),
            [size(VisibleMode::Alert), "mode:alert".into(), "show".into()]
        );
        h.advance(6000);
        assert_eq!(h.mode(), NotchMode::Hidden);
    }

    // --- capsule modes (peek, compact, pinned mini) ---

    #[test]
    fn starts_sized_for_peek_at_the_top_of_the_work_area() {
        let h = Harness::placed();
        assert_eq!(h.rects(), [at(VisibleMode::Peek)]);
        assert_eq!(h.log(|log| log.modes.clone()), ["peek"]);
    }

    #[test]
    fn hovering_peek_shows_compact_without_resizing_the_window_and_leaving_goes_back() {
        let h = Harness::placed();
        h.surface.log.lock().unwrap().rects.clear();
        h.dispatch(E::Pointer { inside: true });
        assert_eq!(h.mode(), NotchMode::Compact);
        h.dispatch(E::Pointer { inside: false });
        h.advance(400);
        assert_eq!(h.mode(), NotchMode::Peek);
        assert_eq!(h.log(|log| log.modes[1..].to_vec()), ["compact", "peek"]);
        let peek = at(VisibleMode::Peek).height;
        assert!(h.rects().iter().all(|rect| rect.height == peek));
    }

    #[test]
    fn right_click_pins_mini_animates_first_then_shrinks_to_a_window_at_the_screen_edge() {
        let h = Harness::placed();
        h.dispatch(E::Pointer { inside: true });
        h.reset();
        h.dispatch(E::PinMini);
        assert_eq!(h.mode(), NotchMode::Mini);
        assert!(h.rects().is_empty());
        h.controller.settled();
        assert_eq!(h.rects(), [at(VisibleMode::Mini)]);
        assert_eq!(h.rects()[0].y, WORK_AREA.y);
    }

    #[test]
    fn in_mini_only_the_pill_takes_the_mouse() {
        let h = Harness::placed();
        h.dispatch(E::Pointer { inside: true });
        h.dispatch(E::PinMini);
        h.dispatch(E::Pointer { inside: false });
        assert_eq!(h.ignores().last(), Some(&true));
        h.dispatch(E::Pointer { inside: true });
        assert_eq!(h.mode(), NotchMode::Mini);
        assert_eq!(h.ignores().last(), Some(&false));
        h.dispatch(E::Pointer { inside: false });
        assert_eq!(h.ignores().last(), Some(&true));
    }

    #[test]
    fn left_click_on_mini_grows_back_to_compact_which_sticks_until_the_pointer_has_been_on_it() {
        let h = Harness::placed();
        h.dispatch(E::Pointer { inside: true });
        h.dispatch(E::PinMini);
        h.controller.settled();
        h.reset();
        h.dispatch(E::UnpinMini);
        assert_eq!(h.mode(), NotchMode::Compact);
        assert_eq!(h.rects(), [at(VisibleMode::Compact)]);
        // The pill is above compact: the pointer is off it at once, and compact stays.
        h.dispatch(E::Pointer { inside: false });
        assert_eq!(h.mode(), NotchMode::Compact);
        h.dispatch(E::Pointer { inside: true });
        h.dispatch(E::Pointer { inside: false });
        assert_eq!(h.mode(), NotchMode::Peek);
        // The entered pointer cancelled the timer: nothing fires later.
        h.advance(STICKY_COMPACT_MS);
        assert_eq!(h.mode(), NotchMode::Peek);
    }

    #[test]
    fn sticky_compact_ends_after_3s() {
        assert_eq!(STICKY_COMPACT_MS, 3000);
        let h = Harness::placed();
        h.dispatch(E::PinMini);
        h.dispatch(E::UnpinMini);
        h.dispatch(E::Pointer { inside: false });
        h.advance(STICKY_COMPACT_MS - 1);
        assert_eq!(h.mode(), NotchMode::Compact);
        h.advance(1);
        assert_eq!(h.mode(), NotchMode::Peek);
    }

    #[test]
    fn dispose_stops_the_sticky_timer() {
        let h = Harness::placed();
        h.dispatch(E::PinMini);
        h.dispatch(E::UnpinMini);
        h.controller.dispose();
        h.advance(STICKY_COMPACT_MS);
        assert_eq!(h.mode(), NotchMode::Compact);
    }

    #[test]
    fn an_alert_grows_out_of_mini_and_goes_back_to_mini_when_it_ends() {
        let h = Harness::placed();
        h.dispatch(E::PinMini);
        h.controller.settled();
        h.reset();
        h.dispatch(E::Mail { on: true });
        assert_eq!(h.rects(), [at(VisibleMode::Alert)]);
        h.advance(MAIL_ALERT_MS);
        assert_eq!(h.mode(), NotchMode::Mini);
        h.controller.settled();
        assert_eq!(h.rects().last(), Some(&at(VisibleMode::Mini)));
    }

    #[test]
    fn a_maximized_window_cannot_shrink_the_capsule_any_more_fullscreen_still_hides_it() {
        let h = Harness::placed();
        h.dispatch(YIELD_NONE);
        assert_eq!(h.mode(), NotchMode::Peek);
        h.dispatch(YIELD_HIDDEN);
        assert_eq!(h.mode(), NotchMode::Hidden);
    }

    #[test]
    fn focus_never_taken_outside_panel_modes() {
        let h = Harness::setup();
        assert_eq!(h.mode(), NotchMode::Peek);
        h.dispatch(E::Pointer { inside: true });
        assert_eq!(h.mode(), NotchMode::Compact);
        h.dispatch(E::Mail { on: true });
        assert_eq!(h.mode(), NotchMode::Alert);
        h.advance(MAIL_ALERT_MS);
        h.controller.settled();
        h.dispatch(E::PinMini);
        assert_eq!(h.mode(), NotchMode::Mini);
        h.dispatch(E::UserVisibility { hidden: true });
        assert_eq!(h.mode(), NotchMode::Hidden);
        h.dispatch(E::UserVisibility { hidden: false });
        h.dispatch(E::UnpinMini);
        h.dispatch(E::Pointer { inside: false });
        h.advance(STICKY_COMPACT_MS);
        assert_eq!(h.mode(), NotchMode::Peek);
        let calls = h.calls();
        assert!(
            !calls.iter().any(|call| call == "focus" || call == "blur"),
            "{calls:?}"
        );
    }

    #[test]
    fn dispose_drops_the_effects_still_queued() {
        let h = Harness::setup();
        let weak = Arc::downgrade(&h.controller);
        // Disposing from the mode listener: the hidden listener queued after it must not run.
        h.controller.on_mode_change(move |_| {
            if let Some(controller) = weak.upgrade() {
                controller.dispose();
            }
        });
        h.dispatch(E::UserVisibility { hidden: true });
        assert!(h.hidden_changes.lock().unwrap().is_empty());
        h.dispatch(E::Show);
        assert!(!h.order().contains(&"show".to_string()));
    }
}
