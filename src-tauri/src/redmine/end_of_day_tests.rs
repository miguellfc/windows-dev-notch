//! 0.1.0's `redmine-end-of-day.test.ts` (20 cases, the 3 `it.each` rows as their own
//! tests) plus the Rust additions: a time in a DST gap, the power listener, an alert that
//! changes the settings from inside `on_alert`, concurrent checks and settings changes after
//! dispose, and a check that sees a settings change before its listener runs.
//!
//! Harness: the virtual [`TestTimers`] behind a counting wrapper (`vi.getTimerCount()`), a frozen
//! [`WallClock`] in Europe/Madrid (the zone `tests/unit/setup-tz.ts` pins), and
//! [`H::advance_to`], which steps the clock and the timers together from one due timer to the
//! next, like `vi.advanceTimersByTime` (each timer fires with the clock at its due time).
//! [`H::jump`] moves only the wall clock (`vi.setSystemTime`: a suspend/resume).
//! 2026-11-16 is a Monday, 2026-11-21 a Saturday, 2026-11-22 a Sunday (local time).

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};
use chrono_tz::Africa::Cairo;
use chrono_tz::Europe::Madrid;
use chrono_tz::Tz;

use super::*;
use crate::contract::redmine::RedmineAlert;
use crate::contract::settings::{RedmineEndOfDaySettings, RedmineSettings};
use crate::platform::power::PowerEvent;
use crate::reminders::time::tests::local;
use crate::services::clock::WallClock;
use crate::services::timers::{TestTimers, TimerCallback, TimerId, Timers};

const GRACE: i64 = END_OF_DAY_GRACE_MS;

fn at(day: u32, h: u32, m: u32, s: u32) -> DateTime<Utc> {
    local(2026, 11, day, h, m, s)
}

fn plus(base: DateTime<Utc>, ms: i64) -> DateTime<Utc> {
    base + chrono::Duration::milliseconds(ms)
}

fn settings_with(enabled: bool, time: &str, daily_target_hours: f64) -> RedmineSettings {
    RedmineSettings {
        url: "https://redmine.example.com".into(),
        daily_target_hours,
        end_of_day: RedmineEndOfDaySettings {
            enabled,
            time: time.into(),
            sound: true,
        },
    }
}

fn default_settings() -> RedmineSettings {
    settings_with(true, "18:00", 8.0)
}

type Listener = Arc<dyn Fn(&RedmineSettings) + Send + Sync>;

/// `settings.get` / `settings.onChange` over a value the test swaps with [`H::change`].
struct FakeSettings {
    current: Mutex<RedmineSettings>,
    /// `integrations.redmine.enabled`.
    redmine_enabled: AtomicBool,
    /// `Some(n)`: turns Redmine off on the read after the next `n` (a change racing a check).
    off_after_reads: Mutex<Option<usize>>,
    listeners: Mutex<Vec<Listener>>,
}

impl FakeSettings {
    fn change(&self, next: RedmineSettings) {
        *self.current.lock().unwrap() = next.clone();
        let listeners = self.listeners.lock().unwrap().clone();
        for listener in listeners {
            listener(&next);
        }
    }

    /// Turns the Redmine integration on or off, then notifies like the store.
    fn set_redmine_enabled(&self, enabled: bool) {
        self.redmine_enabled.store(enabled, Ordering::SeqCst);
        let current = self.current.lock().unwrap().clone();
        self.change(current);
    }
}

impl EndOfDaySettings for FakeSettings {
    fn get(&self) -> RedmineSettings {
        self.current.lock().unwrap().clone()
    }

    fn on_change(&self, listener: SettingsListener) {
        self.listeners.lock().unwrap().push(Arc::from(listener));
    }

    fn integration_enabled(&self) -> bool {
        let mut off_after = self.off_after_reads.lock().unwrap();
        match *off_after {
            Some(0) => {
                self.redmine_enabled.store(false, Ordering::SeqCst);
                *off_after = None;
            }
            Some(n) => *off_after = Some(n - 1),
            None => {}
        }
        self.redmine_enabled.load(Ordering::SeqCst)
    }
}

/// Counts the pending timers (`vi.getTimerCount()`): armed and neither fired nor cleared.
struct Counting {
    inner: Arc<TestTimers>,
    active: Arc<Mutex<HashSet<TimerId>>>,
}

impl Timers for Counting {
    fn set_timeout(&self, ms: u64, f: TimerCallback) -> TimerId {
        let mine: Arc<OnceLock<TimerId>> = Arc::new(OnceLock::new());
        let (me, active) = (Arc::clone(&mine), Arc::clone(&self.active));
        let id = self.inner.set_timeout(
            ms,
            Box::new(move || {
                if let Some(id) = me.get() {
                    active.lock().unwrap().remove(id);
                }
                f();
            }),
        );
        let _ = mine.set(id);
        self.active.lock().unwrap().insert(id);
        id
    }

    fn clear(&self, id: TimerId) {
        self.active.lock().unwrap().remove(&id);
        self.inner.clear(id);
    }
}

type Hook = Box<dyn Fn(RedmineAlert) + Send + Sync>;

struct H {
    scheduler: Arc<EndOfDay<Tz>>,
    settings: Arc<FakeSettings>,
    clock: Arc<WallClock>,
    timers: Arc<TestTimers>,
    active: Arc<Mutex<HashSet<TimerId>>>,
    hours: Arc<Mutex<Option<f64>>>,
    connected: Arc<AtomicBool>,
    /// False while a panel is open: the alert is refused and not shown.
    accepting: Arc<AtomicBool>,
    alerts: Arc<Mutex<Vec<RedmineAlert>>>,
    /// Every alert offered, accepted or not.
    offered: Arc<Mutex<Vec<RedmineAlert>>>,
    /// Runs inside `on_alert` (re-entrancy tests).
    hook: Arc<Mutex<Option<Hook>>>,
}

fn build(start: DateTime<Utc>, initial: RedmineSettings, tz: Tz) -> H {
    let clock = Arc::new(WallClock::fixed(start));
    let timers = Arc::new(TestTimers::new());
    let active = Arc::new(Mutex::new(HashSet::new()));
    let settings = Arc::new(FakeSettings {
        current: Mutex::new(initial),
        redmine_enabled: AtomicBool::new(true),
        off_after_reads: Mutex::new(None),
        listeners: Mutex::new(Vec::new()),
    });
    let hours = Arc::new(Mutex::new(Some(5.5)));
    let connected = Arc::new(AtomicBool::new(true));
    let accepting = Arc::new(AtomicBool::new(true));
    let alerts = Arc::new(Mutex::new(Vec::new()));
    let offered = Arc::new(Mutex::new(Vec::new()));
    let hook: Arc<Mutex<Option<Hook>>> = Arc::new(Mutex::new(None));
    let scheduler = EndOfDay::new(
        EndOfDayOptions {
            settings: Arc::clone(&settings) as Arc<dyn EndOfDaySettings>,
            clock: Arc::clone(&clock),
            timers: Arc::new(Counting {
                inner: Arc::clone(&timers),
                active: Arc::clone(&active),
            }),
            today_hours: {
                let hours = Arc::clone(&hours);
                Box::new(move || *hours.lock().unwrap())
            },
            is_connected: {
                let connected = Arc::clone(&connected);
                Box::new(move || connected.load(Ordering::SeqCst))
            },
            on_alert: {
                let (accepting, alerts, offered, hook) = (
                    Arc::clone(&accepting),
                    Arc::clone(&alerts),
                    Arc::clone(&offered),
                    Arc::clone(&hook),
                );
                Box::new(move |alert| {
                    offered.lock().unwrap().push(alert);
                    if let Some(hook) = hook.lock().unwrap().as_ref() {
                        hook(alert);
                    }
                    if !accepting.load(Ordering::SeqCst) {
                        return false;
                    }
                    alerts.lock().unwrap().push(alert);
                    true
                })
            },
        },
        tz,
    );
    H {
        scheduler,
        settings,
        clock,
        timers,
        active,
        hours,
        connected,
        accepting,
        alerts,
        offered,
        hook,
    }
}

/// `setup(start, initial)`: built in Madrid and started.
fn setup_with(start: DateTime<Utc>, initial: RedmineSettings) -> H {
    let h = build(start, initial, Madrid);
    h.scheduler.start();
    h
}

fn setup(start: DateTime<Utc>) -> H {
    setup_with(start, default_settings())
}

impl H {
    /// `vi.advanceTimersByTime(target - now)`: every timer due on the way fires in due order,
    /// with the wall clock at its due time.
    fn advance_to(&self, target: DateTime<Utc>) {
        loop {
            let remaining = u64::try_from((target - self.clock.now()).num_milliseconds())
                .expect("advance_to never goes back");
            match self.timers.next_due_in() {
                Some(next) if next <= remaining => self.step(next),
                _ => {
                    self.step(remaining);
                    return;
                }
            }
        }
    }

    fn advance_by(&self, ms: i64) {
        self.advance_to(plus(self.clock.now(), ms));
    }

    fn step(&self, ms: u64) {
        self.clock.advance(ms as i64);
        self.timers.advance(ms);
    }

    /// `vi.setSystemTime(target)`: only the wall clock moves (timers stalled in a suspend).
    fn jump(&self, target: DateTime<Utc>) {
        self.clock
            .advance((target - self.clock.now()).num_milliseconds());
    }

    fn change(&self, next: RedmineSettings) {
        self.settings.change(next);
    }

    fn set_hours(&self, value: Option<f64>) {
        *self.hours.lock().unwrap() = value;
    }

    fn alerts(&self) -> Vec<RedmineAlert> {
        self.alerts.lock().unwrap().clone()
    }

    fn offered(&self) -> Vec<RedmineAlert> {
        self.offered.lock().unwrap().clone()
    }

    fn timer_count(&self) -> usize {
        self.active.lock().unwrap().len()
    }
}

fn alert(hours: f64, target: f64) -> RedmineAlert {
    RedmineAlert { hours, target }
}

#[test]
fn fires_at_18_00_00_and_not_at_17_59_59_with_the_hours_and_the_target() {
    let h = setup(at(16, 9, 0, 0));
    h.advance_to(at(16, 17, 59, 59));
    assert_eq!(h.alerts(), []);
    h.advance_to(at(16, 18, 0, 0));
    assert_eq!(h.alerts(), [alert(5.5, 8.0)]);
    h.scheduler.dispose();
}

#[test]
fn does_not_fire_on_saturday_or_sunday() {
    let h = setup(at(21, 9, 0, 0));
    h.advance_to(at(22, 23, 59, 0));
    assert_eq!(h.alerts(), []);
    h.scheduler.dispose();
}

#[test]
fn skips_the_weekend_and_fires_again_on_monday() {
    // Friday, after the time: no alert that day.
    let h = setup(at(20, 19, 0, 0));
    h.advance_to(at(23, 9, 0, 0));
    assert_eq!(h.alerts(), []);
    h.advance_to(at(23, 18, 0, 0));
    assert_eq!(h.alerts().len(), 1);
    h.scheduler.dispose();
}

/// The `it.each` "does not fire when %s" with its arrangement.
fn does_not_fire_when(arrange: impl FnOnce(&H)) {
    let h = setup(at(16, 9, 0, 0));
    arrange(&h);
    h.advance_to(at(16, 18, 30, 0));
    assert_eq!(h.alerts(), []);
    h.scheduler.dispose();
}

#[test]
fn does_not_fire_when_the_hours_reach_the_target() {
    does_not_fire_when(|h| h.set_hours(Some(8.0)));
}

#[test]
fn does_not_fire_when_the_hours_pass_the_target() {
    does_not_fire_when(|h| h.set_hours(Some(9.25)));
}

#[test]
fn does_not_fire_when_there_is_no_session() {
    does_not_fire_when(|h| h.connected.store(false, Ordering::SeqCst));
}

#[test]
fn does_not_fire_when_disabled() {
    let h = setup_with(at(16, 9, 0, 0), settings_with(false, "18:00", 8.0));
    h.advance_to(at(16, 19, 0, 0));
    assert_eq!(h.alerts(), []);
    h.scheduler.dispose();
}

#[test]
fn fires_once_a_day_even_across_the_safety_interval_and_explicit_checks() {
    let h = setup(at(16, 9, 0, 0));
    h.advance_to(at(16, 18, 0, 0));
    h.scheduler.check();
    h.advance_to(at(16, 18, 10, 0));
    h.scheduler.check();
    assert_eq!(h.alerts().len(), 1);
    h.advance_to(at(17, 18, 0, 0));
    assert_eq!(h.alerts().len(), 2);
    h.scheduler.dispose();
}

#[test]
fn does_not_alert_when_the_app_starts_after_the_time() {
    let h = setup(at(16, 18, 5, 0));
    h.scheduler.check();
    h.advance_to(at(16, 20, 0, 0));
    assert_eq!(h.alerts(), []);
    h.advance_to(at(17, 18, 0, 0));
    assert_eq!(h.alerts().len(), 1);
    h.scheduler.dispose();
}

#[test]
fn reschedules_when_the_time_changes_in_settings() {
    let h = setup(at(16, 9, 0, 0));
    h.change(settings_with(true, "17:30", 8.0));
    h.advance_to(at(16, 17, 29, 59));
    assert_eq!(h.alerts(), []);
    h.advance_to(at(16, 17, 30, 0));
    assert_eq!(h.alerts().len(), 1);
    h.advance_to(at(16, 18, 30, 0));
    assert_eq!(h.alerts().len(), 1);
    h.scheduler.dispose();
}

#[test]
fn a_time_already_passed_when_it_is_changed_does_not_fire_today() {
    let h = setup(at(16, 17, 20, 0));
    h.change(settings_with(true, "17:00", 8.0));
    h.advance_to(at(16, 20, 0, 0));
    assert_eq!(h.alerts(), []);
    h.scheduler.dispose();
}

/// `SettingsStore::update` publishes the new value before it notifies: a check on another
/// thread in between sees the new time first. It must not alert for a time already past.
#[test]
fn a_check_that_sees_a_time_moved_into_the_past_before_the_listener_runs_does_not_fire() {
    let h = setup(at(16, 8, 30, 0));
    h.jump(at(16, 10, 0, 0));
    // The store's `current` changes; the listener has not run yet.
    *h.settings.current.lock().unwrap() = settings_with(true, "09:00", 8.0);
    h.scheduler.check();
    assert_eq!(h.offered(), []);
    // The listener runs late: still nothing today.
    h.change(settings_with(true, "09:00", 8.0));
    h.advance_to(at(16, 20, 0, 0));
    assert_eq!(h.offered(), []);
    // The next weekday fires at the new time.
    h.advance_to(at(17, 9, 0, 0));
    assert_eq!(h.alerts(), [alert(5.5, 8.0)]);
    h.scheduler.dispose();
}

#[test]
fn uses_the_target_from_settings() {
    let h = setup_with(at(16, 9, 0, 0), settings_with(true, "18:00", 6.0));
    h.set_hours(Some(6.0));
    h.advance_to(at(16, 18, 1, 0));
    assert_eq!(h.alerts(), []);
    h.scheduler.dispose();
    let second = setup_with(at(17, 9, 0, 0), settings_with(true, "18:00", 6.0));
    second.set_hours(Some(5.0));
    second.advance_to(at(17, 18, 1, 0));
    assert_eq!(second.alerts(), [alert(5.0, 6.0)]);
    second.scheduler.dispose();
}

#[test]
fn waits_for_the_first_reading_of_the_hours_then_fires() {
    let h = setup(at(16, 9, 0, 0));
    h.set_hours(None);
    h.advance_to(at(16, 18, 0, 30));
    assert_eq!(h.alerts(), []);
    h.set_hours(Some(3.0));
    h.advance_to(at(16, 18, 2, 0));
    assert_eq!(h.alerts(), [alert(3.0, 8.0)]);
    h.scheduler.dispose();
}

#[test]
fn catches_up_on_check_after_a_sleep_that_skipped_the_time_within_the_grace_window() {
    let h = setup(at(16, 9, 0, 0));
    // Resume: timers did not run.
    h.jump(at(16, 18, 20, 0));
    h.scheduler.check();
    assert_eq!(h.alerts().len(), 1);
    h.scheduler.dispose();
}

#[test]
fn does_not_alert_long_after_the_time() {
    let h = setup(at(16, 9, 0, 0));
    h.jump(plus(at(16, 18, 0, 0), GRACE + 1000));
    h.scheduler.check();
    assert_eq!(h.alerts(), []);
    h.scheduler.dispose();
}

#[test]
fn keeps_a_single_pending_timer_plus_the_safety_interval_however_often_it_checks() {
    let h = setup(at(16, 9, 0, 0));
    assert_eq!(h.timer_count(), 2);
    for _ in 0..120 {
        h.advance_by(60_000);
        h.scheduler.check();
        h.scheduler.check();
    }
    assert_eq!(h.timer_count(), 2);
    h.scheduler.dispose();
    assert_eq!(h.timer_count(), 0);
}

#[test]
fn alerts_once_when_the_session_or_the_hours_turn_up_within_the_grace_window_not_after_it() {
    let h = setup(at(16, 9, 0, 0));
    h.connected.store(false, Ordering::SeqCst);
    h.advance_to(at(16, 18, 40, 0));
    assert_eq!(h.alerts(), []);
    h.connected.store(true, Ordering::SeqCst);
    h.advance_to(at(16, 18, 42, 0));
    assert_eq!(h.alerts().len(), 1);
    h.advance_to(at(16, 20, 0, 0));
    assert_eq!(h.alerts().len(), 1);
    h.scheduler.dispose();

    let late = setup(at(17, 9, 0, 0));
    late.set_hours(None);
    late.advance_to(at(17, 19, 1, 0));
    late.set_hours(Some(3.0));
    late.advance_to(at(17, 19, 30, 0));
    assert_eq!(late.alerts(), []);
    late.scheduler.dispose();
}

#[test]
fn an_alert_refused_with_a_panel_open_leaves_the_day_open_and_shows_once_the_panel_closes() {
    let h = setup(at(16, 9, 0, 0));
    h.accepting.store(false, Ordering::SeqCst);
    h.advance_to(at(16, 18, 0, 0));
    assert_eq!(h.offered().len(), 1);
    assert_eq!(h.alerts(), []);
    h.advance_to(at(16, 18, 10, 0));
    assert_eq!(h.alerts(), []);
    h.accepting.store(true, Ordering::SeqCst);
    h.advance_to(at(16, 18, 11, 0));
    assert_eq!(h.alerts(), [alert(5.5, 8.0)]);
    let offered = h.offered().len();
    h.advance_to(at(16, 18, 40, 0));
    assert_eq!(h.offered().len(), offered);
    h.scheduler.dispose();
}

#[test]
fn an_alert_refused_through_the_whole_grace_window_is_given_up_for_the_day() {
    let h = setup(at(16, 9, 0, 0));
    h.accepting.store(false, Ordering::SeqCst);
    h.advance_to(plus(at(16, 18, 0, 0), GRACE + 60_000));
    h.accepting.store(true, Ordering::SeqCst);
    h.advance_to(at(16, 21, 0, 0));
    assert_eq!(h.alerts(), []);
    // The next weekday alerts as usual.
    h.advance_to(at(17, 18, 0, 0));
    assert_eq!(h.alerts().len(), 1);
    h.scheduler.dispose();
}

#[test]
fn stops_after_dispose() {
    let h = setup(at(16, 9, 0, 0));
    h.scheduler.dispose();
    h.advance_to(at(16, 19, 0, 0));
    h.scheduler.check();
    assert_eq!(h.alerts(), []);
}

// --- Rust additions ---

/// `new Date(y, m, d, 0, 30)` on a day whose 00:00-01:00 is skipped reads 00:30 with the offset
/// before the gap, so it lands at 01:30 local (not at the 01:00 transition `at_local_time` would
/// pick). Cairo, Friday 28 Apr 2023 (a weekday; Madrid's gaps are all on Sundays).
#[test]
fn end_of_day_time_in_a_dst_gap_moves_forward() {
    let cairo = |d: u32, h: u32, m: u32, s: u32| {
        Cairo
            .with_ymd_and_hms(2023, 4, d, h, m, s)
            .single()
            .expect("unique local time")
            .with_timezone(&Utc)
    };
    // The wall time does not exist that day.
    assert!(Cairo
        .with_ymd_and_hms(2023, 4, 28, 0, 30, 0)
        .earliest()
        .is_none());
    let h = build(
        cairo(27, 12, 0, 0),
        settings_with(true, "00:30", 8.0),
        Cairo,
    );
    h.scheduler.start();
    h.advance_to(cairo(28, 1, 0, 0));
    assert_eq!(h.alerts(), [], "not at the transition");
    h.advance_to(cairo(28, 1, 29, 59));
    assert_eq!(h.alerts(), []);
    h.advance_to(cairo(28, 1, 30, 0));
    assert_eq!(h.alerts(), [alert(5.5, 8.0)]);
    h.scheduler.dispose();
}

#[test]
fn a_power_event_runs_a_check() {
    let h = setup(at(16, 9, 0, 0));
    let listener = h.scheduler.power_listener();
    h.jump(at(16, 18, 5, 0));
    listener(PowerEvent::Resume);
    assert_eq!(h.alerts().len(), 1);
    h.scheduler.dispose();
    // No unsubscribe exists: a late event on a disposed scheduler does nothing.
    h.jump(at(17, 18, 5, 0));
    listener(PowerEvent::Unlock);
    assert_eq!(h.alerts().len(), 1);
}

#[test]
fn an_alert_that_changes_the_settings_from_on_alert_neither_deadlocks_nor_repeats() {
    let h = setup(at(16, 9, 0, 0));
    let settings = Arc::downgrade(&h.settings);
    let reentered = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&reentered);
    *h.hook.lock().unwrap() = Some(Box::new(move |_| {
        // The settings listener calls check() on this same thread, inside on_alert.
        if count.fetch_add(1, Ordering::SeqCst) == 0 {
            if let Some(settings) = settings.upgrade() {
                settings.change(settings_with(true, "18:00", 7.0));
            }
        }
    }));
    // On a worker thread, so a deadlock fails the test instead of hanging it.
    let h = Arc::new(h);
    let (sender, receiver) = std::sync::mpsc::channel();
    let runner = Arc::clone(&h);
    std::thread::spawn(move || {
        runner.advance_to(at(16, 18, 30, 0));
        let _ = sender.send(());
    });
    receiver
        .recv_timeout(Duration::from_secs(10))
        .expect("no deadlock");
    assert_eq!(reentered.load(Ordering::SeqCst), 1);
    assert_eq!(h.alerts(), [alert(5.5, 8.0)]);
    h.scheduler.dispose();
}

#[test]
fn concurrent_checks_offer_the_alert_once() {
    let h = Arc::new(setup(at(16, 9, 0, 0)));
    // Slow on_alert: the other threads check while the first offer is still out.
    *h.hook.lock().unwrap() = Some(Box::new(|_| std::thread::sleep(Duration::from_millis(50))));
    h.jump(at(16, 18, 5, 0));
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let h = Arc::clone(&h);
            std::thread::spawn(move || h.scheduler.check())
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    assert_eq!(h.offered().len(), 1);
    assert_eq!(h.alerts().len(), 1);
    h.scheduler.dispose();
}

#[test]
fn settings_changes_after_dispose_do_nothing() {
    let h = setup(at(16, 9, 0, 0));
    h.scheduler.dispose();
    h.change(settings_with(true, "17:30", 8.0));
    h.jump(at(16, 17, 35, 0));
    h.change(settings_with(true, "17:30", 7.0));
    assert_eq!(h.offered(), []);
    assert_eq!(h.timer_count(), 0);
}

#[test]
fn start_twice_or_after_dispose_arms_nothing_more() {
    let h = setup(at(16, 9, 0, 0));
    h.scheduler.start();
    assert_eq!(h.timer_count(), 2);
    h.scheduler.dispose();
    h.scheduler.start();
    assert_eq!(h.timer_count(), 0);

    // Never started: check() does nothing.
    let idle = build(at(16, 18, 5, 0), default_settings(), Madrid);
    idle.scheduler.check();
    assert_eq!(idle.offered(), []);
    assert_eq!(idle.timer_count(), 0);
}

// ---------------------------------------------------------------------------------------------
// v0.3.0: the Redmine integration disabled in the settings (`integrations.redmine.enabled`)

#[test]
fn end_of_day_skipped_when_redmine_disabled() {
    let h = setup(at(16, 9, 0, 0));
    h.settings.set_redmine_enabled(false);
    h.advance_to(at(16, 18, 30, 0));
    h.scheduler.check();
    assert_eq!(h.offered(), []);
    assert_eq!(h.alerts(), []);
    h.scheduler.dispose();
}

#[test]
fn end_of_day_disabled_at_start_never_offers() {
    let h = build(at(16, 9, 0, 0), default_settings(), Madrid);
    h.settings.redmine_enabled.store(false, Ordering::SeqCst);
    h.scheduler.start();
    h.advance_to(at(17, 19, 0, 0));
    assert_eq!(h.offered(), []);
    h.scheduler.dispose();
}

#[test]
fn end_of_day_comes_back_when_redmine_is_enabled_again_but_not_for_a_time_already_past() {
    let h = setup(at(16, 9, 0, 0));
    h.settings.set_redmine_enabled(false);
    h.advance_to(at(16, 17, 0, 0));
    h.settings.set_redmine_enabled(true);
    h.advance_to(at(16, 18, 0, 0));
    assert_eq!(h.alerts(), [alert(5.5, 8.0)]);

    // Off over the next day's time, back on after it (within the grace): not that day.
    h.settings.set_redmine_enabled(false);
    h.advance_to(at(17, 18, 10, 0));
    h.settings.set_redmine_enabled(true);
    h.advance_to(at(17, 18, 40, 0));
    assert_eq!(h.alerts().len(), 1);
    h.advance_to(at(18, 18, 0, 0));
    assert_eq!(h.alerts().len(), 2);
    h.scheduler.dispose();
}

#[test]
fn redmine_turned_off_between_the_decision_and_the_alert_offers_nothing() {
    let h = setup(at(16, 9, 0, 0));
    h.advance_to(at(16, 17, 59, 0));
    // The check's decision still sees Redmine on; it is off right before the alert.
    *h.settings.off_after_reads.lock().unwrap() = Some(1);
    h.jump(at(16, 18, 0, 30));
    h.scheduler.check();
    assert_eq!(h.offered(), []);
    // Nothing is left half-offered: on again, the next day alerts as usual.
    h.settings.set_redmine_enabled(true);
    h.advance_to(at(17, 18, 0, 0));
    assert_eq!(h.alerts(), [alert(5.5, 8.0)]);
    h.scheduler.dispose();
}
