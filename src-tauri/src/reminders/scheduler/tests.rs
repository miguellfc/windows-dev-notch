//! 0.1.0's `reminder-scheduler.test.ts` (17 cases) plus `resume_runs_a_single_check`,
//! with the real service over an in-memory store in Europe/Madrid, the virtual [`TestTimers`]
//! and a frozen [`WallClock`] that `advance` moves together with the timers (`jump` moves only
//! the wall clock, like a suspend/resume).

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, SecondsFormat, Utc};
use chrono_tz::Europe::Madrid;
use chrono_tz::Tz;
use tauri::async_runtime::block_on;

use super::*;
use crate::contract::reminders::{
    CreateReminderInput, ReminderRepeat, ReminderState, ReminderText,
};
use crate::platform::power::PowerEvent;
use crate::reminders::service::{ReminderStore, RemindersOptions, RemindersService};
use crate::reminders::time::tests::local;
use crate::services::timers::{TestTimers, TimerCallback, TimerId};

const MAX_TIMEOUT: u64 = 2_147_483_647;
const MIN: i64 = 60_000;
const HOUR: i64 = 60 * MIN;
const DAY: i64 = 24 * HOUR;

fn t0() -> DateTime<Utc> {
    local(2026, 11, 10, 12, 0, 0)
}

fn plus(ms: i64) -> DateTime<Utc> {
    t0() + chrono::Duration::milliseconds(ms)
}

fn uuid(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn reminder(n: usize, due_at: DateTime<Utc>) -> Reminder {
    Reminder {
        id: uuid(n),
        text: ReminderText::new(&format!("secret-text-{n}")).unwrap(),
        due_at: iso(due_at),
        repeat: ReminderRepeat::None,
        local_time: None,
        state: ReminderState::Pending,
        created_at: iso(t0()),
        completed_at: None,
    }
}

#[derive(Default)]
struct MemoryStore(Mutex<Vec<Reminder>>);

impl ReminderStore for MemoryStore {
    fn all(&self) -> Vec<Reminder> {
        self.0.lock().unwrap().clone()
    }

    fn write(&self, next: Vec<Reminder>) -> BoxFuture<'_, Result<(), ExposedError>> {
        *self.0.lock().unwrap() = next;
        Box::pin(async { Ok(()) })
    }
}

/// `wrapService`: the real service with the overrides the TS tests patch in.
#[derive(Default)]
struct Hooks {
    /// Calls of `mark_due` so far.
    mark_due_calls: AtomicUsize,
    /// The first `n` calls of `mark_due` fail.
    mark_due_failures: AtomicUsize,
    /// `mark_due` waits for the gate: on its first call only, or on every call.
    gate: Option<(tokio::sync::watch::Sender<bool>, bool)>,
    purge_fails: bool,
    missed_fails: bool,
}

struct Wrapped {
    real: Arc<RemindersService<Tz>>,
    hooks: Arc<Hooks>,
}

fn boom() -> ExposedError {
    ExposedError::internal("boom")
}

impl SchedulerService for Wrapped {
    fn mark_due(&self) -> BoxFuture<'_, Result<Vec<Reminder>, ExposedError>> {
        Box::pin(async move {
            let call = self.hooks.mark_due_calls.fetch_add(1, Ordering::SeqCst) + 1;
            if let Some((gate, first_only)) = &self.hooks.gate {
                if !first_only || call == 1 {
                    let _ = gate.subscribe().wait_for(|open| *open).await;
                }
            }
            let failures = self.hooks.mark_due_failures.load(Ordering::SeqCst);
            if failures > 0 {
                self.hooks
                    .mark_due_failures
                    .store(failures - 1, Ordering::SeqCst);
                return Err(boom());
            }
            self.real.mark_due().await
        })
    }

    fn mark_missed_on_start(&self) -> BoxFuture<'_, Result<Vec<Reminder>, ExposedError>> {
        if self.hooks.missed_fails {
            return Box::pin(async { Err(boom()) });
        }
        SchedulerService::mark_missed_on_start(&*self.real)
    }

    fn purge_done(&self) -> BoxFuture<'_, Result<(), ExposedError>> {
        if self.hooks.purge_fails {
            return Box::pin(async { Err(boom()) });
        }
        SchedulerService::purge_done(&*self.real)
    }

    fn next_due_at(&self) -> Option<DateTime<Utc>> {
        self.real.next_due_at()
    }
}

/// Wraps the test timers: records the delays asked for (timeouts only) and which timers are
/// still armed (`vi.getTimerCount()`, shared by the timeout and interval wrappers).
struct Counting {
    inner: Arc<TestTimers>,
    delays: Option<Arc<Mutex<Vec<u64>>>>,
    active: Arc<Mutex<HashSet<TimerId>>>,
}

impl Timers for Counting {
    fn set_timeout(&self, ms: u64, f: TimerCallback) -> TimerId {
        if let Some(delays) = &self.delays {
            delays.lock().unwrap().push(ms);
        }
        let me: Arc<OnceLock<TimerId>> = Arc::new(OnceLock::new());
        let (active, mine) = (Arc::clone(&self.active), Arc::clone(&me));
        let id = self.inner.set_timeout(
            ms,
            Box::new(move || {
                if let Some(id) = mine.get() {
                    active.lock().unwrap().remove(id);
                }
                f();
            }),
        );
        let _ = me.set(id);
        self.active.lock().unwrap().insert(id);
        id
    }

    fn clear(&self, id: TimerId) {
        self.active.lock().unwrap().remove(&id);
        self.inner.clear(id);
    }
}

#[derive(Default)]
struct Opts {
    no_interval: bool,
    hooks: Hooks,
}

struct H {
    scheduler: Arc<ReminderScheduler>,
    real: Arc<RemindersService<Tz>>,
    hooks: Arc<Hooks>,
    store: Arc<MemoryStore>,
    clock: Arc<WallClock>,
    timers: Arc<TestTimers>,
    delays: Arc<Mutex<Vec<u64>>>,
    active: Arc<Mutex<HashSet<TimerId>>>,
    fired: Arc<Mutex<Vec<Vec<Reminder>>>>,
    missed: Arc<Mutex<Vec<Vec<Reminder>>>>,
}

fn setup(opts: Opts) -> H {
    let clock = Arc::new(WallClock::fixed(t0()));
    let store = Arc::new(MemoryStore::default());
    let seq = Arc::new(AtomicUsize::new(100));
    let real = Arc::new(RemindersService::new(
        RemindersOptions {
            store: Arc::clone(&store) as Arc<dyn ReminderStore>,
            clock: Arc::clone(&clock),
            new_id: Box::new(move || uuid(seq.fetch_add(1, Ordering::SeqCst) + 1)),
            snooze_minutes: Box::new(|| 10),
            on_change: Box::new(|| {}),
            on_completed: None,
        },
        Madrid,
    ));
    let hooks = Arc::new(opts.hooks);
    let timers = Arc::new(TestTimers::new());
    let delays = Arc::new(Mutex::new(Vec::new()));
    let active = Arc::new(Mutex::new(HashSet::new()));
    let fired = Arc::new(Mutex::new(Vec::new()));
    let missed = Arc::new(Mutex::new(Vec::new()));
    let safety = (!opts.no_interval).then(|| Safety {
        timers: Arc::new(Counting {
            inner: Arc::clone(&timers),
            delays: None,
            active: Arc::clone(&active),
        }),
        period_ms: SAFETY_INTERVAL_MS,
    });
    let scheduler = ReminderScheduler::new(SchedulerOptions {
        service: Arc::new(Wrapped {
            real: Arc::clone(&real),
            hooks: Arc::clone(&hooks),
        }),
        clock: Arc::clone(&clock),
        timers: Arc::new(Counting {
            inner: Arc::clone(&timers),
            delays: Some(Arc::clone(&delays)),
            active: Arc::clone(&active),
        }),
        safety,
        on_fired: {
            let fired = Arc::clone(&fired);
            Box::new(move |batch| fired.lock().unwrap().push(batch))
        },
        on_missed: {
            let missed = Arc::clone(&missed);
            Box::new(move |batch| missed.lock().unwrap().push(batch))
        },
    });
    H {
        scheduler,
        real,
        hooks,
        store,
        clock,
        timers,
        delays,
        active,
        fired,
        missed,
    }
}

impl H {
    fn seed(&self, list: Vec<Reminder>) {
        *self.store.0.lock().unwrap() = list;
    }

    fn ids(&self) -> Vec<String> {
        self.store.all().into_iter().map(|r| r.id).collect()
    }

    /// Moves the wall clock and the timers together, then waits for the checks they started.
    fn advance(&self, ms: i64) {
        self.clock.advance(ms);
        self.timers.advance(ms as u64);
        block_on(self.scheduler.idle());
    }

    /// Moves only the wall clock (a jump, e.g. suspend/resume).
    fn jump(&self, ms: i64) {
        self.clock.advance(ms);
    }

    fn check(&self) {
        block_on(self.scheduler.check());
    }

    fn start(&self) {
        block_on(self.scheduler.start());
    }

    fn delays(&self) -> Vec<u64> {
        self.delays.lock().unwrap().clone()
    }

    fn last_delay(&self) -> Option<u64> {
        self.delays().last().copied()
    }

    fn timer_count(&self) -> usize {
        self.active.lock().unwrap().len()
    }

    fn fired(&self) -> Vec<Vec<Reminder>> {
        self.fired.lock().unwrap().clone()
    }

    fn fired_ids(&self) -> Vec<Vec<String>> {
        self.fired()
            .into_iter()
            .map(|batch| {
                let mut ids: Vec<String> = batch.into_iter().map(|r| r.id).collect();
                ids.sort();
                ids
            })
            .collect()
    }

    fn missed(&self) -> Vec<Vec<Reminder>> {
        self.missed.lock().unwrap().clone()
    }

    fn mark_due_calls(&self) -> usize {
        self.hooks.mark_due_calls.load(Ordering::SeqCst)
    }

    fn release(&self) {
        if let Some((gate, _)) = &self.hooks.gate {
            gate.send_replace(true);
        }
    }
}

fn gated(first_only: bool) -> Opts {
    let (gate, _) = tokio::sync::watch::channel(false);
    Opts {
        hooks: Hooks {
            gate: Some((gate, first_only)),
            ..Hooks::default()
        },
        ..Opts::default()
    }
}

fn log_lines() -> &'static crate::services::test_log::Capture {
    crate::services::test_log::capture().expect("the test logger")
}

#[test]
fn fires_at_the_due_time_once_with_every_due_reminder_together() {
    let h = setup(Opts::default());
    h.seed(vec![
        reminder(1, plus(5 * MIN)),
        reminder(2, plus(5 * MIN)),
        reminder(3, plus(30 * MIN)),
    ]);
    h.start();
    assert_eq!(h.last_delay(), Some(5 * MIN as u64));
    h.advance(5 * MIN - 1);
    assert!(h.fired().is_empty());
    h.advance(1);
    assert_eq!(h.fired_ids(), [vec![uuid(1), uuid(2)]]);
    assert!(h.fired()[0].iter().all(|r| r.state == ReminderState::Due));
    // Re-armed for the remaining one.
    h.advance(25 * MIN);
    assert_eq!(h.fired_ids().len(), 2);
    assert_eq!(h.fired_ids()[1], [uuid(3)]);
}

#[test]
fn arms_no_timer_when_nothing_is_pending() {
    let h = setup(Opts::default());
    h.start();
    assert!(h.delays().is_empty());
    assert_eq!(h.timer_count(), 1); // only the safety interval
}

#[test]
fn reschedule_after_adding_an_earlier_reminder_moves_the_timer_forward() {
    let h = setup(Opts::default());
    h.seed(vec![reminder(1, plus(60 * MIN))]);
    h.start();
    assert_eq!(h.last_delay(), Some(60 * MIN as u64));
    let input = CreateReminderInput::from_input(serde_json::json!({
        "text": "sooner", "preset": "15m"
    }))
    .unwrap();
    block_on(h.real.create(input)).unwrap();
    h.scheduler.reschedule();
    assert_eq!(h.last_delay(), Some(15 * MIN as u64));
    h.advance(15 * MIN);
    assert_eq!(h.fired().len(), 1);
    assert_eq!(h.fired()[0][0].text.as_str(), "sooner");
}

#[test]
fn reschedule_replaces_the_previous_timer_instead_of_stacking() {
    let h = setup(Opts::default());
    h.seed(vec![reminder(1, plus(60 * MIN))]);
    h.start();
    h.scheduler.reschedule();
    h.scheduler.reschedule();
    assert_eq!(h.timer_count(), 2); // one timeout + the interval
}

#[test]
fn coalesces_resume_timer_and_interval_at_the_same_instant_into_one_on_fired() {
    let h = setup(Opts::default());
    h.seed(vec![reminder(1, plus(MIN))]);
    h.start();
    h.jump(MIN);
    block_on(async {
        let (a, b, c) = (
            h.scheduler.check(),
            h.scheduler.check(),
            h.scheduler.check(),
        );
        a.await;
        b.await;
        c.await;
    });
    assert_eq!(h.fired().len(), 1);
    // The timers that were also due at that instant add nothing.
    h.timers.advance(MIN as u64);
    block_on(h.scheduler.idle());
    assert_eq!(h.fired().len(), 1);
}

#[test]
fn runs_exactly_one_extra_pass_for_a_check_requested_while_one_is_in_flight() {
    let h = setup(gated(true));
    h.seed(vec![reminder(1, plus(-MIN))]);
    let (a, b, c) = (
        h.scheduler.check(),
        h.scheduler.check(),
        h.scheduler.check(),
    );
    h.release();
    block_on(async {
        a.await;
        b.await;
        c.await;
    });
    assert_eq!(h.mark_due_calls(), 2);
    assert_eq!(h.fired().len(), 1);
}

#[test]
fn resume_runs_a_single_check() {
    // Two power events in a row while a check is in flight: one extra mark_due, not two.
    let h = setup(gated(true));
    h.seed(vec![reminder(1, plus(-MIN))]);
    let on_power = check_on_power(Arc::downgrade(&h.scheduler));
    let running = h.scheduler.check();
    on_power(PowerEvent::Resume);
    on_power(PowerEvent::Unlock);
    h.release();
    block_on(running);
    block_on(h.scheduler.idle());
    assert_eq!(h.mark_due_calls(), 2);
    assert_eq!(h.fired().len(), 1);
}

#[test]
fn detects_a_clock_that_jumps_2h_ahead_through_the_safety_interval() {
    let h = setup(Opts::default());
    h.seed(vec![reminder(1, plus(30 * MIN))]);
    h.start();
    h.jump(2 * HOUR); // wall clock leaps; the 30 min timeout has not fired
    assert!(h.fired().is_empty());
    h.timers.advance(60_000);
    block_on(h.scheduler.idle());
    assert_eq!(h.fired_ids(), [vec![uuid(1)]]);
}

#[test]
fn caps_a_40_day_timer_at_2147483647_ms_and_re_arms_when_it_fires_early() {
    let h = setup(Opts {
        no_interval: true,
        ..Opts::default()
    });
    h.seed(vec![reminder(1, plus(40 * DAY))]);
    h.start();
    assert_eq!(h.delays(), [MAX_TIMEOUT]);
    h.advance(MAX_TIMEOUT as i64);
    assert!(h.fired().is_empty());
    let rest = (40 * DAY) as u64 - MAX_TIMEOUT;
    assert_eq!(h.delays(), [MAX_TIMEOUT, rest]);
    h.advance(rest as i64);
    assert_eq!(h.fired().len(), 1);
    assert_eq!(h.delays(), [MAX_TIMEOUT, rest]);
}

#[test]
fn start_purges_done_reports_missed_ones_then_arms_and_checks_periodically() {
    let h = setup(Opts::default());
    let mut old_done = reminder(3, plus(-20 * DAY));
    old_done.state = ReminderState::Done;
    old_done.completed_at = Some(iso(plus(-10 * DAY)));
    h.seed(vec![
        reminder(1, plus(-3 * HOUR)),
        reminder(2, plus(HOUR)),
        old_done,
    ]);
    h.start();
    assert!(!h.ids().contains(&uuid(3)));
    let missed = h.missed();
    assert_eq!(missed.len(), 1);
    assert_eq!(
        missed[0].iter().map(|r| r.id.clone()).collect::<Vec<_>>(),
        [uuid(1)]
    );
    assert_eq!(missed[0][0].state, ReminderState::Missed);
    assert!(h.fired().is_empty());
    assert_eq!(h.last_delay(), Some(HOUR as u64));
}

#[test]
fn does_not_call_on_missed_when_nothing_was_missed_and_start_twice_is_a_no_op() {
    let h = setup(Opts::default());
    h.seed(vec![reminder(1, plus(HOUR))]);
    h.start();
    h.start();
    assert!(h.missed().is_empty());
    assert_eq!(h.timer_count(), 2);
}

#[test]
fn does_not_call_on_fired_with_an_empty_batch() {
    let h = setup(Opts::default());
    h.start();
    h.advance(5 * MIN);
    h.check();
    assert!(h.fired().is_empty());
}

#[test]
fn dispose_cancels_timers_and_silences_callbacks() {
    let h = setup(Opts::default());
    h.seed(vec![reminder(1, plus(MIN))]);
    h.start();
    h.scheduler.dispose();
    assert_eq!(h.timer_count(), 0);
    h.advance(10 * MIN);
    h.check();
    h.scheduler.reschedule();
    assert!(h.fired().is_empty());
    assert_eq!(h.timer_count(), 0);
}

#[test]
fn dispose_during_an_in_flight_check_suppresses_on_fired_and_re_arming() {
    let h = setup(gated(false));
    h.seed(vec![reminder(1, plus(-MIN))]);
    let running = h.scheduler.check();
    h.scheduler.dispose();
    h.release();
    block_on(running);
    assert!(h.fired().is_empty());
    assert_eq!(h.timer_count(), 0);
}

#[test]
fn logs_service_errors_without_reminder_text_and_keeps_running() {
    let capture = log_lines();
    let h = setup(Opts {
        hooks: Hooks {
            mark_due_failures: AtomicUsize::new(1),
            ..Hooks::default()
        },
        ..Opts::default()
    });
    h.seed(vec![reminder(1, plus(MIN))]);
    h.start();
    h.jump(MIN);
    h.check();
    let lines = capture.lines();
    assert!(
        lines
            .iter()
            .any(|line| line.starts_with("ERROR") && line.contains("reminders::scheduler")),
        "{lines:?}"
    );
    assert!(lines.iter().all(|line| !line.contains("secret-text")));
    assert_eq!(h.timer_count(), 2); // re-armed + interval
                                    // The overdue reminder is retried after the backoff, not at once.
    assert_eq!(h.last_delay(), Some(RETRY_MS as u64));
    // A check inside the backoff waits for the retry timer instead of writing again.
    h.check();
    assert!(h.fired().is_empty());
    h.advance(RETRY_MS);
    assert_eq!(h.fired().len(), 1);
}

#[test]
fn a_persistently_failing_mark_due_never_re_arms_at_0() {
    let h = setup(Opts {
        hooks: Hooks {
            mark_due_failures: AtomicUsize::new(usize::MAX),
            ..Hooks::default()
        },
        ..Opts::default()
    });
    h.seed(vec![reminder(1, plus(MIN))]);
    h.start();
    assert_eq!(h.delays(), [MIN as u64]);
    h.advance(MIN);
    assert_eq!(h.mark_due_calls(), 1);
    assert_eq!(h.last_delay(), Some(RETRY_MS as u64));
    // A mutation elsewhere re-arming the timer still honours the backoff.
    h.scheduler.reschedule();
    assert_eq!(h.last_delay(), Some(RETRY_MS as u64));
    h.advance(RETRY_MS - 1);
    assert_eq!(h.mark_due_calls(), 1);
    // Over two safety intervals: one attempt per retry or interval tick, never a tight loop.
    // (`TestTimers` fires each timer at most once per move, so the window is walked in steps.)
    for _ in 0..120 {
        h.advance(1_000);
    }
    assert!(h.mark_due_calls() <= 6, "{}", h.mark_due_calls());
    assert!(h.delays().iter().all(|d| *d > 0));
    assert!(h.fired().is_empty());
}

#[test]
fn a_failing_purge_does_not_skip_the_missed_sweep_arming_and_polling_continue() {
    let capture = log_lines();
    let h = setup(Opts {
        hooks: Hooks {
            purge_fails: true,
            ..Hooks::default()
        },
        ..Opts::default()
    });
    h.seed(vec![reminder(1, plus(-HOUR)), reminder(2, plus(MIN))]);
    h.start();
    assert!(capture
        .lines()
        .iter()
        .any(|line| line.starts_with("ERROR") && line.contains("purgeDone failed")));
    let missed: Vec<Vec<String>> = h
        .missed()
        .into_iter()
        .map(|batch| batch.into_iter().map(|r| r.id).collect())
        .collect();
    assert_eq!(missed, [vec![uuid(1)]]);
    h.advance(MIN);
    assert_eq!(h.fired().len(), 1);
}

#[test]
fn a_failing_missed_sweep_is_logged_and_start_still_arms_and_polls() {
    let h = setup(Opts {
        hooks: Hooks {
            missed_fails: true,
            ..Hooks::default()
        },
        ..Opts::default()
    });
    h.seed(vec![reminder(1, plus(MIN))]);
    h.start();
    assert!(h.missed().is_empty());
    h.advance(MIN);
    assert_eq!(h.fired().len(), 1);
}

#[test]
fn a_panicking_on_fired_is_logged_and_the_scheduler_keeps_going() {
    let fired_once = Arc::new(AtomicBool::new(false));
    let h = setup(Opts::default());
    let scheduler = ReminderScheduler::new(SchedulerOptions {
        service: Arc::new(Wrapped {
            real: Arc::clone(&h.real),
            hooks: Arc::new(Hooks::default()),
        }),
        clock: Arc::clone(&h.clock),
        timers: Arc::clone(&h.timers) as Arc<dyn Timers>,
        safety: None,
        on_fired: {
            let fired_once = Arc::clone(&fired_once);
            Box::new(move |_| {
                fired_once.store(true, Ordering::SeqCst);
                panic!("listener failed");
            })
        },
        on_missed: Box::new(|_| {}),
    });
    h.seed(vec![reminder(1, plus(-MIN)), reminder(2, plus(MIN))]);
    block_on(scheduler.check());
    assert!(fired_once.load(Ordering::SeqCst));
    // Still armed for the next one, and not stuck "running".
    h.clock.advance(MIN);
    block_on(scheduler.check());
    assert_eq!(h.real.attention_count(), 2);
}
