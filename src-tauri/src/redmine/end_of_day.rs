//! Port of 0.1.0's `end-of-day.ts`: the end-of-day alert. On weekdays at
//! `redmine.endOfDay.time` (local), once a day, when there is a session and today's hours are
//! under `redmine.dailyTargetHours`. One timer aims at the next due moment; a 60 s safety
//! [`Interval`] and [`check`](EndOfDay::check) (power resume and unlock, the E2E test clock)
//! catch suspended timers and a first reading of the hours that arrives after the time. An alert
//! refused because a panel is open is offered again on the next check within the 1 h grace. A
//! start after the time, or a settings change that moves the time to one already past, does not
//! alert that day. Memory only: nothing is stored, and nothing is logged except one
//! `result=panic` line when `on_alert` panics.
//!
//! Local time: the weekday, the local day and the due instant are those of `tz` (production
//! `chrono::Local`, which follows the Windows zone rules; tests `chrono_tz`). Where Windows and
//! ICU disagree on an offset, the alert fires at the time Windows reads, not the instant 0.1.0
//! would have used: the part-4 follow-up, documented, not fixed here.
//!
//! Timers: production passes `notch.timers()` (under the E2E test clock that is
//! `TestTimers::over_real`, so `advance` also fires this timer and the interval), where Electron
//! used real timers and reached the test clock only through an explicit `check()` after each
//! `advance`. The outcome is the same: every check is idempotent within a day (`settled_day`),
//! and `__e2e:advance-clock` still calls `check()` explicitly, as Electron did.
//!
//! Concurrency: checks come from the timer, the interval, the power thread, the settings
//! listener and the E2E channel. They are serialized by `serial` (decide, then commit), but
//! `on_alert` runs with no lock held: it may dispatch to the notch, and a settings change made
//! from there runs the listener, which calls `check()` again on the same thread. An `offering`
//! flag makes such a nested (or concurrent) check skip the alert, so it is offered at most once
//! at a time. Calls on a disposed scheduler do nothing (the power events have no unsubscribe).

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use chrono::{DateTime, Datelike, Days, Local, NaiveDate, TimeZone, Utc, Weekday};

use crate::code_review::contributions::date_key;
use crate::contract::redmine::RedmineAlert;
use crate::contract::settings::{RedmineEndOfDaySettings, RedmineSettings};
use crate::platform::power::{PowerEvent, PowerListener};
use crate::reminders::time::resolve_local;
use crate::services::clock::WallClock;
use crate::services::timers::{Interval, TimerId, Timers};

/// Largest delay `setTimeout` accepts in Electron; a longer wait is clamped (and the timer then
/// fires early, finds nothing due and re-arms). Unreachable with a 7-day scan, kept for parity.
pub const MAX_TIMEOUT_MS: i64 = 2_147_483_647;
pub const END_OF_DAY_SAFETY_INTERVAL_MS: u64 = 60_000;
/// A check that finds the time long past (a PC that slept through it) no longer alerts.
pub const END_OF_DAY_GRACE_MS: i64 = 3_600_000;
/// `for (let offset = 0; offset <= 7; offset++)`.
const SCAN_DAYS: u64 = 7;

/// Told about every settings change, with the new `redmine` block.
pub type SettingsListener = Box<dyn Fn(&RedmineSettings) + Send + Sync>;

/// `EndOfDaySettingsSource`: the `redmine` block of the settings. `on_change` has no
/// unsubscribe (like `SettingsStore::on_change`); the scheduler ignores changes once disposed.
pub trait EndOfDaySettings: Send + Sync {
    fn get(&self) -> RedmineSettings;
    fn on_change(&self, listener: SettingsListener);
    /// `integrations.redmine.enabled`: with the integration off there is no end of day.
    fn integration_enabled(&self) -> bool;
}

/// The app's settings store (managed `SettingsStore`), for the wiring.
pub struct AppEndOfDaySettings(pub tauri::AppHandle);

impl EndOfDaySettings for AppEndOfDaySettings {
    fn get(&self) -> RedmineSettings {
        use tauri::Manager;
        self.0
            .state::<crate::settings::SettingsStore>()
            .get()
            .redmine
    }

    fn on_change(&self, listener: SettingsListener) {
        use tauri::Manager;
        self.0
            .state::<crate::settings::SettingsStore>()
            .on_change(move |next| listener(&next.redmine));
    }

    fn integration_enabled(&self) -> bool {
        use tauri::Manager;
        self.0
            .state::<crate::settings::SettingsStore>()
            .get()
            .integrations
            .redmine
            .enabled
    }
}

pub struct EndOfDayOptions {
    pub settings: Arc<dyn EndOfDaySettings>,
    /// Wall clock; the dev-only test clock moves it.
    pub clock: Arc<WallClock>,
    /// The one-shot timer and the safety interval.
    pub timers: Arc<dyn Timers>,
    /// Hours logged today, or `None` before the first reading.
    pub today_hours: Box<dyn Fn() -> Option<f64> + Send + Sync>,
    /// Whether there is a usable Redmine session (a configured key the server has not rejected).
    pub is_connected: Box<dyn Fn() -> bool + Send + Sync>,
    /// Shows the alert; `false` when it could not be shown (no notch, or a panel is open): the
    /// day then stays open and the next check offers it again, within the grace window. Called
    /// with no lock of the scheduler held.
    pub on_alert: Box<dyn Fn(RedmineAlert) -> bool + Send + Sync>,
}

struct State {
    /// The armed timer and the generation that armed it (its callback forgets only its own).
    timeout: Option<(TimerId, u64)>,
    generation: u64,
    interval: Option<Interval>,
    started: bool,
    disposed: bool,
    /// The local day (`YYYY-MM-DD`) already decided: alerted, or nothing to alert about.
    settled_day: Option<String>,
    /// Epoch ms: a due moment before this (app start, a settings change) was missed, not due.
    not_before: i64,
    /// The `endOfDay` block the last decision saw; a different `time` or `enabled` moves
    /// `not_before` to now.
    last_settings: RedmineEndOfDaySettings,
    /// `integrations.redmine.enabled` as the last decision saw it; a change moves `not_before`
    /// to now too (turned on after the time, it does not alert that day).
    last_integration_enabled: bool,
    /// An alert is out to `on_alert`: no other check offers one until it returns.
    offering: bool,
}

/// What a check decided to offer, committed once `on_alert` answers.
struct Offer {
    day: String,
    alert: RedmineAlert,
}

pub struct EndOfDay<Tz: TimeZone = Local> {
    me: Weak<EndOfDay<Tz>>,
    tz: Tz,
    settings: Arc<dyn EndOfDaySettings>,
    clock: Arc<WallClock>,
    timers: Arc<dyn Timers>,
    today_hours: Box<dyn Fn() -> Option<f64> + Send + Sync>,
    is_connected: Box<dyn Fn() -> bool + Send + Sync>,
    on_alert: Box<dyn Fn(RedmineAlert) -> bool + Send + Sync>,
    /// Serializes the decide and commit phases of `check()` (never held across `on_alert`).
    serial: Mutex<()>,
    state: Mutex<State>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Monday to Friday (`getDay()` in 1..=5).
fn is_weekday(date: NaiveDate) -> bool {
    !matches!(date.weekday(), Weekday::Sat | Weekday::Sun)
}

/// `time.split(':').map(Number)` for the validated `HH:mm` of the settings; anything else
/// (which the settings validation never lets through) is never due, where JS would build an
/// Invalid Date.
fn hour_minute(time: &str) -> Option<(u32, u32)> {
    let mut parts = time.split(':');
    let hours = parts.next()?.parse::<u32>().ok()?;
    let minutes = parts
        .next()
        .map_or(Some(0), |part| part.parse::<u32>().ok())?;
    (hours < 24 && minutes < 60).then_some((hours, minutes))
}

impl<Tz> EndOfDay<Tz>
where
    Tz: TimeZone + Send + Sync + 'static,
    Tz::Offset: Send + Sync,
{
    pub fn new(options: EndOfDayOptions, tz: Tz) -> Arc<Self> {
        let last_settings = options.settings.get().end_of_day;
        let last_integration_enabled = options.settings.integration_enabled();
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            tz,
            settings: options.settings,
            clock: options.clock,
            timers: options.timers,
            today_hours: options.today_hours,
            is_connected: options.is_connected,
            on_alert: options.on_alert,
            serial: Mutex::new(()),
            state: Mutex::new(State {
                timeout: None,
                generation: 0,
                interval: None,
                started: false,
                disposed: false,
                settled_day: None,
                not_before: 0,
                last_settings,
                last_integration_enabled,
                offering: false,
            }),
        })
    }

    fn now(&self) -> DateTime<Utc> {
        self.clock.now()
    }

    /// `dueOn(day, time)`: `new Date(y, m, d, HH, mm)`, so a wall time skipped by a DST gap lands
    /// the gap later (`resolve_local`), not at the transition (`at_local_time`).
    fn due_on(&self, date: NaiveDate, time: &str) -> Option<i64> {
        let (hours, minutes) = hour_minute(time)?;
        let wall = date.and_hms_opt(hours, minutes, 0)?;
        Some(resolve_local(&self.tz, wall).timestamp_millis())
    }

    /// Subscribes to the settings, starts the safety interval and checks at once. Runs once;
    /// `notBefore` = now, so a start after the time does not alert that day.
    pub fn start(&self) {
        {
            let mut state = lock(&self.state);
            if state.started || state.disposed {
                return;
            }
            state.started = true;
            state.not_before = self.now().timestamp_millis();
            let me = self.me.clone();
            state.interval = Some(Interval::start(
                Arc::clone(&self.timers),
                END_OF_DAY_SAFETY_INTERVAL_MS,
                Arc::new(move || {
                    if let Some(scheduler) = me.upgrade() {
                        scheduler.check();
                    }
                }),
            ));
        }
        let me = self.me.clone();
        self.settings.on_change(Box::new(move |next| {
            if let Some(scheduler) = me.upgrade() {
                scheduler.settings_changed(next);
            }
        }));
        self.check();
    }

    /// Any change re-checks (and re-aims the timer). The `notBefore` move of a changed time or
    /// `enabled` happens in [`decide`](Self::decide), under the state lock: the store publishes
    /// the new value before it notifies, so a check on another thread may see it first.
    fn settings_changed(&self, _next: &RedmineSettings) {
        self.check();
    }

    /// Decides whether today is due and alerts (at most once a day), then re-aims the timer.
    pub fn check(&self) {
        let offer = {
            let _serial = lock(&self.serial);
            self.decide()
        };
        let Some(offer) = offer else {
            return;
        };
        // Redmine turned off since `decide` read it: no alert (the day stays open).
        if !self.settings.integration_enabled() {
            let _serial = lock(&self.serial);
            let end_of_day = self.settings.get().end_of_day;
            let mut state = lock(&self.state);
            state.offering = false;
            // Seen off: turned on again after the time, it does not alert that day.
            state.last_integration_enabled = false;
            self.reschedule_locked(&mut state, &end_of_day, false);
            return;
        }
        // No lock held: `on_alert` may dispatch to the notch, and a nested check skips the
        // alert because `offering` is set.
        let shown =
            catch_unwind(AssertUnwindSafe(|| (self.on_alert)(offer.alert))).unwrap_or_else(|_| {
                log::error!("redmine end of day: what=alert result=panic");
                false
            });
        let _serial = lock(&self.serial);
        let end_of_day = self.settings.get().end_of_day;
        let integration_enabled = self.settings.integration_enabled();
        let mut state = lock(&self.state);
        state.offering = false;
        if shown {
            state.settled_day = Some(offer.day);
        }
        self.reschedule_locked(&mut state, &end_of_day, integration_enabled);
    }

    /// The decision of `check()`, under `serial`. Settles the day when it is long past or the
    /// target is reached; returns the alert to offer otherwise. Re-aims the timer either way.
    fn decide(&self) -> Option<Offer> {
        let settings = self.settings.get();
        let integration_enabled = self.settings.integration_enabled();
        let now = self.now();
        let now_ms = now.timestamp_millis();
        let date = now.with_timezone(&self.tz).date_naive();
        let day = date_key(date);
        let wants_reading = {
            let mut state = lock(&self.state);
            if state.disposed || !state.started {
                return None;
            }
            // TS moves `notBefore` synchronously in `onChange`; here the first check to see a
            // changed time or `enabled` does it, so a time already past does not alert today.
            let end_of_day = &settings.end_of_day;
            if state.last_settings.time != end_of_day.time
                || state.last_settings.enabled != end_of_day.enabled
                || state.last_integration_enabled != integration_enabled
            {
                state.not_before = now_ms;
                state.last_settings = end_of_day.clone();
                state.last_integration_enabled = integration_enabled;
            }
            let open = integration_enabled
                && settings.end_of_day.enabled
                && is_weekday(date)
                && state.settled_day.as_deref() != Some(day.as_str());
            match self.due_on(date, &settings.end_of_day.time) {
                Some(due) if open && due >= state.not_before && now_ms >= due => {
                    if now_ms - due > END_OF_DAY_GRACE_MS {
                        // Slept through it: given up silently.
                        state.settled_day = Some(day.clone());
                        false
                    } else {
                        !state.offering
                    }
                }
                _ => false,
            }
        };
        // Outside the state lock: these read the integration's state.
        let mut offer = None;
        if wants_reading && (self.is_connected)() {
            // Without a reading yet the day stays open: the next tick looks again.
            if let Some(hours) = (self.today_hours)() {
                let target = settings.daily_target_hours;
                let mut state = lock(&self.state);
                if state.disposed {
                    return None;
                }
                if hours >= target {
                    state.settled_day = Some(day);
                } else {
                    state.offering = true;
                    offer = Some(Offer {
                        day,
                        alert: RedmineAlert { hours, target },
                    });
                }
            }
        }
        self.reschedule_locked(
            &mut lock(&self.state),
            &settings.end_of_day,
            integration_enabled,
        );
        offer
    }

    /// Arms the timer for the next due moment still ahead (7-day scan, weekdays, not the settled
    /// day, not before `notBefore`); today's pending one, already past, is left to the safety
    /// interval. `set_timeout` never runs its callback synchronously, so arming under the lock
    /// is safe. Nothing is armed with the end of day or the Redmine integration off.
    fn reschedule_locked(
        &self,
        state: &mut State,
        end_of_day: &RedmineEndOfDaySettings,
        integration_enabled: bool,
    ) {
        if let Some((timer, _)) = state.timeout.take() {
            self.timers.clear(timer);
        }
        if state.disposed || !end_of_day.enabled || !integration_enabled {
            return;
        }
        let now = self.now();
        let now_ms = now.timestamp_millis();
        let today = now.with_timezone(&self.tz).date_naive();
        let next_due = (0..=SCAN_DAYS)
            .filter_map(|offset| today.checked_add_days(Days::new(offset)))
            .filter(|date| {
                is_weekday(*date) && state.settled_day.as_deref() != Some(date_key(*date).as_str())
            })
            .filter_map(|date| self.due_on(date, &end_of_day.time))
            .find(|due| *due >= state.not_before && *due > now_ms);
        let Some(due) = next_due else {
            return;
        };
        let delay = (due - now_ms).min(MAX_TIMEOUT_MS);
        state.generation += 1;
        let generation = state.generation;
        let me = self.me.clone();
        let timer = self.timers.set_timeout(
            u64::try_from(delay).unwrap_or(0),
            Box::new(move || {
                let Some(scheduler) = me.upgrade() else {
                    return;
                };
                {
                    // Only the timer's own firing forgets its handle: any other check re-arms
                    // through `reschedule_locked`, which clears it.
                    let mut state = lock(&scheduler.state);
                    if state.timeout.is_some_and(|(_, armed)| armed == generation) {
                        state.timeout = None;
                    }
                }
                scheduler.check();
            }),
        );
        state.timeout = Some((timer, generation));
    }

    /// For `PowerEvents::subscribe`: resume and unlock check at once (timers stall while the PC
    /// sleeps). Runs on the power thread; a check only locks, computes and maybe alerts. There is
    /// no unsubscribe: an event after `dispose` does nothing.
    pub fn power_listener(self: &Arc<Self>) -> PowerListener {
        let me = Arc::downgrade(self);
        Arc::new(move |_event: PowerEvent| {
            if let Some(scheduler) = me.upgrade() {
                scheduler.check();
            }
        })
    }

    /// Cancels the timer and the interval; later checks, settings changes and power events do
    /// nothing. Idempotent.
    pub fn dispose(&self) {
        let interval = {
            let mut state = lock(&self.state);
            state.disposed = true;
            if let Some((timer, _)) = state.timeout.take() {
                self.timers.clear(timer);
            }
            state.interval.take()
        };
        if let Some(interval) = interval {
            interval.stop();
        }
    }
}

#[cfg(test)]
#[path = "end_of_day_tests.rs"]
mod tests;
