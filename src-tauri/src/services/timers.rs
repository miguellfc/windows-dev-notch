//! One-shot timers the main-process modules schedule work with: [`RealTimers`] on the Tauri async
//! runtime, and [`TestTimers`], the port of 0.1.0's `test-clock-timers.ts` (timers that
//! also fire when a test clock is moved past their due time).

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, Instant};

use tauri::async_runtime::JoinHandle;

/// Handle of an armed timer; clearing an unknown or already fired one does nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TimerId(u64);

/// The work a timer runs once when it fires.
pub type TimerCallback = Box<dyn FnOnce() + Send>;

/// `setTimeout` / `clearTimeout`. A timer never runs its callback synchronously inside
/// `set_timeout` or `clear`, so callers may hold their own locks across both.
pub trait Timers: Send + Sync {
    fn set_timeout(&self, ms: u64, f: TimerCallback) -> TimerId;
    fn clear(&self, id: TimerId);
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Timers on `tauri::async_runtime`: each one is a spawned task that sleeps, then runs its
/// callback on a runtime worker. Dropping the timers cancels whatever is still pending.
pub struct RealTimers {
    inner: Arc<RealInner>,
}

#[derive(Default)]
struct RealInner {
    next_id: AtomicU64,
    /// Armed timers; a task runs its callback only if it is still here when it wakes.
    tasks: Mutex<HashMap<TimerId, JoinHandle<()>>>,
}

impl Drop for RealInner {
    fn drop(&mut self) {
        for (_, task) in lock(&self.tasks).drain() {
            task.abort();
        }
    }
}

impl RealTimers {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RealInner::default()),
        }
    }
}

impl Default for RealTimers {
    fn default() -> Self {
        Self::new()
    }
}

impl Timers for RealTimers {
    fn set_timeout(&self, ms: u64, f: TimerCallback) -> TimerId {
        let id = TimerId(self.inner.next_id.fetch_add(1, Ordering::Relaxed));
        let inner = Arc::downgrade(&self.inner);
        // Held until the task is registered, so a task that wakes at once still finds itself.
        let mut tasks = lock(&self.inner.tasks);
        let task = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            let armed = inner
                .upgrade()
                .is_some_and(|inner| lock(&inner.tasks).remove(&id).is_some());
            if armed {
                f();
            }
        });
        tasks.insert(id, task);
        id
    }

    fn clear(&self, id: TimerId) {
        if let Some(task) = lock(&self.inner.tasks).remove(&id) {
            task.abort();
        }
    }
}

/// The test clock's base in ms; [`TestTimers::advance`] adds an offset to it.
pub type Clock = Box<dyn Fn() -> u64 + Send + Sync>;

/// Port of `createTestClockTimers`: timers due on a test clock (a base clock plus the offset
/// [`advance`](Self::advance) adds). Over real timers they still fire in real time too, and also
/// early when the test clock is moved past their due time (dev/E2E only, never in a release
/// build). Without real timers they only fire on `advance`, like fake timers in unit tests.
pub struct TestTimers {
    clock: Clock,
    real: Option<Arc<dyn Timers>>,
    inner: Arc<Mutex<TestState>>,
}

#[derive(Default)]
struct TestState {
    offset_ms: u64,
    next_id: u64,
    pending: BTreeMap<TimerId, Pending>,
}

struct Pending {
    due: u64,
    callback: TimerCallback,
    real: Option<TimerId>,
}

impl TestTimers {
    /// Virtual time only: nothing fires until [`advance`](Self::advance) reaches it.
    pub fn new() -> Self {
        Self::with_clock(Box::new(|| 0), None)
    }

    /// Real time plus the offset, over `real`: E2E tests can skip ahead without losing real firing.
    pub fn over_real(real: Arc<dyn Timers>) -> Self {
        let started = Instant::now();
        let clock = move || u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        Self::with_clock(Box::new(clock), Some(real))
    }

    pub fn with_clock(clock: Clock, real: Option<Arc<dyn Timers>>) -> Self {
        Self {
            clock,
            real,
            inner: Arc::new(Mutex::new(TestState::default())),
        }
    }

    fn now(&self, state: &TestState) -> u64 {
        (self.clock)().saturating_add(state.offset_ms)
    }

    /// Moves the test clock and runs (once) every timer armed before the move whose due time it
    /// has reached, earliest first. Timers armed by those callbacks wait for a later move.
    /// Callbacks run with no lock held, so they may arm, clear or dispatch freely.
    pub fn advance(&self, ms: u64) {
        let (at, armed_before) = {
            let mut state = lock(&self.inner);
            state.offset_ms = state.offset_ms.saturating_add(ms);
            (self.now(&state), TimerId(state.next_id))
        };
        loop {
            let next = {
                let mut state = lock(&self.inner);
                let due = state
                    .pending
                    .range(..armed_before)
                    .filter(|(_, entry)| entry.due <= at)
                    .min_by_key(|(id, entry)| (entry.due, **id))
                    .map(|(id, _)| *id);
                due.and_then(|id| state.pending.remove(&id))
            };
            let Some(entry) = next else { break };
            if let (Some(real), Some(handle)) = (&self.real, entry.real) {
                real.clear(handle);
            }
            (entry.callback)();
        }
    }

    /// Time left until the earliest armed timer, if any: unit tests step through the timers in
    /// due order, like `vi.advanceTimersByTimeAsync`.
    #[cfg(test)]
    pub(crate) fn next_due_in(&self) -> Option<u64> {
        let state = lock(&self.inner);
        let now = self.now(&state);
        state
            .pending
            .values()
            .map(|entry| entry.due.saturating_sub(now))
            .min()
    }
}

impl Default for TestTimers {
    fn default() -> Self {
        Self::new()
    }
}

impl Timers for TestTimers {
    fn set_timeout(&self, ms: u64, f: TimerCallback) -> TimerId {
        let id = {
            let mut state = lock(&self.inner);
            let id = TimerId(state.next_id);
            state.next_id += 1;
            let due = self.now(&state).saturating_add(ms);
            state.pending.insert(
                id,
                Pending {
                    due,
                    callback: f,
                    real: None,
                },
            );
            id
        };
        if let Some(real) = &self.real {
            let inner: Weak<Mutex<TestState>> = Arc::downgrade(&self.inner);
            let handle = real.set_timeout(
                ms,
                Box::new(move || {
                    let entry = inner
                        .upgrade()
                        .and_then(|inner| lock(&inner).pending.remove(&id));
                    if let Some(entry) = entry {
                        (entry.callback)();
                    }
                }),
            );
            if let Some(entry) = lock(&self.inner).pending.get_mut(&id) {
                entry.real = Some(handle);
            }
        }
        id
    }

    fn clear(&self, id: TimerId) {
        let entry = lock(&self.inner).pending.remove(&id);
        if let (Some(real), Some(handle)) = (&self.real, entry.and_then(|entry| entry.real)) {
            real.clear(handle);
        }
    }
}

/// `setInterval` / `clearInterval` over any [`Timers`] (the part-1 trait is one-shot only): it
/// re-arms a `set_timeout` each time it fires, before running the callback, so a slow callback
/// does not shift the rhythm and a callback may [`stop`](Self::stop) its own interval. With
/// [`TestTimers`] each `advance` fires it at most once (a timer armed by a fired callback waits
/// for the next move). Dropping the handle stops it.
pub struct Interval {
    shared: Arc<IntervalShared>,
}

struct IntervalShared {
    timers: Arc<dyn Timers>,
    period_ms: u64,
    f: Arc<dyn Fn() + Send + Sync>,
    state: Mutex<IntervalState>,
}

#[derive(Default)]
struct IntervalState {
    timer: Option<TimerId>,
    stopped: bool,
}

impl Interval {
    /// Fires `f` every `period_ms`, the first time one period from now (never synchronously).
    pub fn start(timers: Arc<dyn Timers>, period_ms: u64, f: Arc<dyn Fn() + Send + Sync>) -> Self {
        let shared = Arc::new(IntervalShared {
            timers,
            period_ms,
            f,
            state: Mutex::new(IntervalState::default()),
        });
        IntervalShared::arm(&shared);
        Self { shared }
    }

    /// Clears the pending timer: no new firing starts after `stop()`. A firing already in
    /// progress (its timer fired just before) may still run its callback once, so a callback
    /// that must not act after a stop checks its own state. Idempotent.
    pub fn stop(&self) {
        let timer = {
            let mut state = lock(&self.shared.state);
            state.stopped = true;
            state.timer.take()
        };
        if let Some(timer) = timer {
            self.shared.timers.clear(timer);
        }
    }
}

impl Drop for Interval {
    fn drop(&mut self) {
        self.stop();
    }
}

impl IntervalShared {
    /// Arms the next firing unless stopped. `set_timeout` never runs the callback synchronously,
    /// so holding the state lock across it is safe.
    fn arm(this: &Arc<Self>) {
        let mut state = lock(&this.state);
        if state.stopped {
            return;
        }
        let me = Arc::clone(this);
        state.timer = Some(
            this.timers
                .set_timeout(this.period_ms, Box::new(move || Self::fire(&me))),
        );
    }

    fn fire(this: &Arc<Self>) {
        if lock(&this.state).stopped {
            return;
        }
        Self::arm(this);
        // No lock held: the callback may stop the interval or arm other timers.
        (this.f)();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Mutex};
    use std::time::Duration;

    use super::*;

    /// Stands in for the real timers: records what was armed and cleared, fires on demand.
    #[derive(Default)]
    struct FakeReal {
        armed: Mutex<Vec<(u64, Option<TimerCallback>)>>,
        cleared: AtomicUsize,
    }

    impl FakeReal {
        fn fire(&self, index: usize) {
            let callback = self.armed.lock().unwrap()[index].1.take();
            callback.expect("armed and not fired yet")();
        }
    }

    impl Timers for FakeReal {
        fn set_timeout(&self, ms: u64, f: TimerCallback) -> TimerId {
            let mut armed = self.armed.lock().unwrap();
            armed.push((ms, Some(f)));
            TimerId(armed.len() as u64 - 1)
        }

        fn clear(&self, _id: TimerId) {
            self.cleared.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn counter() -> (Arc<AtomicUsize>, impl Fn() -> TimerCallback) {
        let count = Arc::new(AtomicUsize::new(0));
        let make = {
            let count = count.clone();
            move || -> TimerCallback {
                let count = count.clone();
                Box::new(move || {
                    count.fetch_add(1, Ordering::SeqCst);
                })
            }
        };
        (count, make)
    }

    fn over_fake() -> (Arc<FakeReal>, TestTimers) {
        let real = Arc::new(FakeReal::default());
        let timers = TestTimers::with_clock(Box::new(|| 1_000), Some(real.clone()));
        (real, timers)
    }

    #[test]
    fn arms_a_real_timer_too_so_it_still_fires_in_real_time() {
        let (real, timers) = over_fake();
        let (count, callback) = counter();
        timers.set_timeout(60_000, callback());
        assert_eq!(real.armed.lock().unwrap()[0].0, 60_000);
        real.fire(0);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        // Fired already: moving the clock does not run it again.
        timers.advance(60_000);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn fires_only_the_timers_the_moved_clock_has_reached_once_and_clears_their_real_timer() {
        let (real, timers) = over_fake();
        let (soon, soon_callback) = counter();
        let (later, later_callback) = counter();
        timers.set_timeout(60_000, soon_callback());
        timers.set_timeout(120_000, later_callback());
        timers.advance(59_999);
        assert_eq!(soon.load(Ordering::SeqCst), 0);
        timers.advance(1);
        assert_eq!(soon.load(Ordering::SeqCst), 1);
        assert_eq!(later.load(Ordering::SeqCst), 0);
        assert_eq!(real.cleared.load(Ordering::SeqCst), 1);
        timers.advance(0);
        assert_eq!(soon.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn never_fires_a_cleared_timer() {
        let (real, timers) = over_fake();
        let (count, callback) = counter();
        let id = timers.set_timeout(10, callback());
        timers.clear(id);
        assert_eq!(real.cleared.load(Ordering::SeqCst), 1);
        timers.advance(10);
        assert_eq!(count.load(Ordering::SeqCst), 0);
        // An unknown (or already cleared) id is ignored.
        timers.clear(id);
        timers.clear(TimerId(999));
        assert_eq!(real.cleared.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn leaves_a_timer_armed_by_a_fired_callback_for_a_later_move() {
        let timers = Arc::new(TestTimers::new());
        let (count, callback) = counter();
        let next = Mutex::new(Some(callback()));
        let rearm = {
            let timers = Arc::downgrade(&timers);
            Box::new(move || {
                let next = next.lock().unwrap().take().unwrap();
                timers.upgrade().unwrap().set_timeout(60_000, next);
            })
        };
        timers.set_timeout(60_000, rearm);
        timers.advance(60_000);
        assert_eq!(count.load(Ordering::SeqCst), 0);
        timers.advance(60_000);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn fires_due_timers_in_due_order_and_skips_one_cleared_by_an_earlier_callback() {
        let timers = Arc::new(TestTimers::new());
        let order = Arc::new(Mutex::new(Vec::new()));
        let late_order = order.clone();
        let late = timers.set_timeout(
            20,
            Box::new(move || late_order.lock().unwrap().push("late")),
        );
        let early_order = order.clone();
        timers.set_timeout(
            10,
            Box::new(move || early_order.lock().unwrap().push("early")),
        );
        let clear_order = order.clone();
        let clearer = Arc::downgrade(&timers);
        timers.set_timeout(
            15,
            Box::new(move || {
                clear_order.lock().unwrap().push("clear");
                clearer.upgrade().unwrap().clear(late);
            }),
        );
        timers.advance(100);
        assert_eq!(*order.lock().unwrap(), ["early", "clear"]);
    }

    fn counting_interval(timers: &Arc<TestTimers>, period_ms: u64) -> (Arc<AtomicUsize>, Interval) {
        let count = Arc::new(AtomicUsize::new(0));
        let tick = count.clone();
        let interval = Interval::start(
            timers.clone(),
            period_ms,
            Arc::new(move || {
                tick.fetch_add(1, Ordering::SeqCst);
            }),
        );
        (count, interval)
    }

    #[test]
    fn interval_fires_every_period_with_test_timers() {
        let timers = Arc::new(TestTimers::new());
        let (count, _interval) = counting_interval(&timers, 1_000);
        // Never synchronously on start.
        assert_eq!(count.load(Ordering::SeqCst), 0);
        timers.advance(999);
        assert_eq!(count.load(Ordering::SeqCst), 0);
        timers.advance(1);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        timers.advance(1_000);
        timers.advance(1_000);
        assert_eq!(count.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn stopped_interval_never_fires_again() {
        let timers = Arc::new(TestTimers::new());
        let (count, interval) = counting_interval(&timers, 1_000);
        timers.advance(1_000);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        interval.stop();
        timers.advance(1_000);
        timers.advance(5_000);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        // Stopping twice is harmless, and so is dropping a stopped interval.
        interval.stop();
        drop(interval);

        // A callback may stop its own interval: it never fires again.
        let slot: Arc<Mutex<Option<Interval>>> = Arc::new(Mutex::new(None));
        let fired = Arc::new(AtomicUsize::new(0));
        let (stopper, counter) = (slot.clone(), fired.clone());
        let interval = Interval::start(
            timers.clone(),
            10,
            Arc::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
                if let Some(interval) = stopper.lock().unwrap().as_ref() {
                    interval.stop();
                }
            }),
        );
        *slot.lock().unwrap() = Some(interval);
        timers.advance(10);
        timers.advance(10);
        assert_eq!(fired.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn dropping_an_interval_stops_it() {
        let timers = Arc::new(TestTimers::new());
        let (count, interval) = counting_interval(&timers, 100);
        drop(interval);
        timers.advance(100);
        assert_eq!(count.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn real_timers_fire_after_the_delay_and_never_once_cleared() {
        let timers = RealTimers::new();
        let (sender, receiver) = mpsc::channel();
        let cleared_sender = sender.clone();
        let cleared = timers.set_timeout(
            30,
            Box::new(move || cleared_sender.send("cleared").unwrap()),
        );
        timers.clear(cleared);
        timers.set_timeout(10, Box::new(move || sender.send("fired").unwrap()));
        assert_eq!(receiver.recv_timeout(Duration::from_secs(5)), Ok("fired"));
        assert!(receiver.recv_timeout(Duration::from_millis(200)).is_err());
    }
}
