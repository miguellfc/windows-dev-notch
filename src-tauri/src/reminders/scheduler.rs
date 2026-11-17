//! Port of 0.1.0's `reminder-scheduler.ts`: one timer aimed at the next due reminder,
//! plus a periodic safety check that catches clock jumps and suspended timers. Every timer goes
//! through the shared [`Timers`] (so the E2E test clock drives them) and every check runs on the
//! async runtime. Logs carry counts and error codes only, never reminder text.

use std::future::Future;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use chrono::{DateTime, TimeZone, Utc};
use tokio::sync::watch;

use crate::contract::reminders::Reminder;
use crate::ipc::{BoxFuture, ExposedError};
use crate::platform::power::{PowerEvent, PowerListener};
use crate::reminders::service::RemindersService;
use crate::services::clock::WallClock;
use crate::services::timers::{Interval, TimerId, Timers};

/// Largest delay `setTimeout` accepts in Electron; longer waits are re-armed when it fires.
pub const MAX_TIMEOUT_MS: i64 = 2_147_483_647;
pub const SAFETY_INTERVAL_MS: u64 = 60_000;
/// After a failed pass (e.g. the file is locked or the disk is full), wait this long before
/// retrying.
pub const RETRY_MS: i64 = 30_000;

/// What the scheduler needs from the service (`Pick<RemindersService, 'markDue' | ...>`).
pub trait SchedulerService: Send + Sync {
    fn mark_due(&self) -> BoxFuture<'_, Result<Vec<Reminder>, ExposedError>>;
    fn mark_missed_on_start(&self) -> BoxFuture<'_, Result<Vec<Reminder>, ExposedError>>;
    fn purge_done(&self) -> BoxFuture<'_, Result<(), ExposedError>>;
    fn next_due_at(&self) -> Option<DateTime<Utc>>;
}

impl<Z> SchedulerService for RemindersService<Z>
where
    Z: TimeZone + Send + Sync,
    Z::Offset: Send + Sync,
{
    fn mark_due(&self) -> BoxFuture<'_, Result<Vec<Reminder>, ExposedError>> {
        Box::pin(RemindersService::mark_due(self))
    }

    fn mark_missed_on_start(&self) -> BoxFuture<'_, Result<Vec<Reminder>, ExposedError>> {
        Box::pin(RemindersService::mark_missed_on_start(self))
    }

    fn purge_done(&self) -> BoxFuture<'_, Result<(), ExposedError>> {
        Box::pin(RemindersService::purge_done(self))
    }

    fn next_due_at(&self) -> Option<DateTime<Utc>> {
        RemindersService::next_due_at(self)
    }
}

/// Told about a batch of reminders (newly due, or missed at startup).
pub type BatchListener = Box<dyn Fn(Vec<Reminder>) + Send + Sync>;

/// The periodic safety check (`setInterval(check, safetyIntervalMs)`).
pub struct Safety {
    pub timers: Arc<dyn Timers>,
    pub period_ms: u64,
}

pub struct SchedulerOptions {
    pub service: Arc<dyn SchedulerService>,
    pub clock: Arc<WallClock>,
    /// The one-shot timer aimed at the next due reminder.
    pub timers: Arc<dyn Timers>,
    /// `None` only in tests that leave the interval out (`noInterval`).
    pub safety: Option<Safety>,
    pub on_fired: BatchListener,
    pub on_missed: BatchListener,
}

#[derive(Default)]
struct State {
    /// The armed timer and the generation that armed it (its callback clears only its own).
    timeout: Option<(TimerId, u64)>,
    generation: u64,
    interval: Option<Interval>,
    started: bool,
    disposed: bool,
    /// The check in progress; it sends `true` once its loop has ended.
    running: Option<watch::Sender<bool>>,
    rerun: bool,
    /// Epoch ms before which the timer must not fire again, set after a failed pass.
    retry_not_before: Option<i64>,
}

pub struct ReminderScheduler {
    me: Weak<ReminderScheduler>,
    service: Arc<dyn SchedulerService>,
    clock: Arc<WallClock>,
    timers: Arc<dyn Timers>,
    safety: Option<Safety>,
    on_fired: BatchListener,
    on_missed: BatchListener,
    state: Mutex<State>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Waits for a check's loop to end (immediately when there is none).
async fn wait(receiver: Option<watch::Receiver<bool>>) {
    if let Some(mut receiver) = receiver {
        // An error means the sender is gone, which only happens after it sent `true`.
        let _ = receiver.wait_for(|done| *done).await;
    }
}

/// Ends a check's loop even if it panicked: clears `running` and wakes the waiters.
struct RunGuard<'a> {
    scheduler: &'a ReminderScheduler,
    armed: bool,
}

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        if self.armed {
            let running = lock(&self.scheduler.state).running.take();
            if let Some(running) = running {
                running.send_replace(true);
            }
        }
    }
}

impl ReminderScheduler {
    pub fn new(options: SchedulerOptions) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            service: options.service,
            clock: options.clock,
            timers: options.timers,
            safety: options.safety,
            on_fired: options.on_fired,
            on_missed: options.on_missed,
            state: Mutex::new(State::default()),
        })
    }

    fn now_ms(&self) -> i64 {
        self.clock.now().timestamp_millis()
    }

    /// Ms left in the failure backoff; clamped so a backwards clock jump cannot stretch it.
    fn backoff_remaining(&self, state: &State) -> i64 {
        state.retry_not_before.map_or(0, |not_before| {
            (not_before - self.now_ms()).clamp(0, RETRY_MS)
        })
    }

    /// Re-aims the single timer at the next pending reminder (none armed when there is none).
    pub fn reschedule(&self) {
        let mut state = lock(&self.state);
        self.reschedule_locked(&mut state);
    }

    /// `set_timeout` never runs its callback synchronously, so arming under the lock is safe.
    fn reschedule_locked(&self, state: &mut State) {
        if let Some((timer, _)) = state.timeout.take() {
            self.timers.clear(timer);
        }
        if state.disposed {
            return;
        }
        let Some(due_at) = self.service.next_due_at() else {
            return;
        };
        // While a failure backoff is active, an overdue reminder must not re-arm at 0: that
        // would turn a persistent write failure into a tight loop of writes and error logs.
        let delay = (due_at.timestamp_millis() - self.now_ms())
            .max(0)
            .max(self.backoff_remaining(state))
            .min(MAX_TIMEOUT_MS);
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
                    let mut state = lock(&scheduler.state);
                    if state.timeout.is_some_and(|(_, armed)| armed == generation) {
                        state.timeout = None;
                    }
                }
                // The check runs as its own task; nothing to wait for here.
                drop(scheduler.check());
            }),
        );
        state.timeout = Some((timer, generation));
    }

    /// Runs `markDue` now. Coalesced: a check requested while one is running is covered by
    /// exactly one more pass of that run, and its future resolves when that run ends. The run
    /// starts (as a task on the async runtime) before this returns, so dropping the future
    /// does not cancel it.
    pub fn check(&self) -> impl Future<Output = ()> + Send + 'static {
        let (receiver, start) = {
            let mut state = lock(&self.state);
            if state.disposed {
                (None, false)
            } else if let Some(receiver) = state.running.as_ref().map(watch::Sender::subscribe) {
                state.rerun = true;
                (Some(receiver), false)
            } else {
                let (sender, receiver) = watch::channel(false);
                state.running = Some(sender);
                // Reset here, not in the task: checks made before it starts count as a rerun.
                state.rerun = false;
                (Some(receiver), true)
            }
        };
        if start {
            if let Some(scheduler) = self.me.upgrade() {
                tauri::async_runtime::spawn(async move { scheduler.run().await });
            } else {
                lock(&self.state).running = None;
            }
        }
        wait(receiver)
    }

    /// Resolves once no check is running (tests: wait for the checks a timer started).
    #[cfg(test)]
    pub(crate) fn idle(&self) -> impl Future<Output = ()> + Send + 'static {
        wait(
            lock(&self.state)
                .running
                .as_ref()
                .map(watch::Sender::subscribe),
        )
    }

    async fn run(&self) {
        let mut guard = RunGuard {
            scheduler: self,
            armed: true,
        };
        loop {
            let ok = self.pass().await;
            let mut state = lock(&self.state);
            // After a failure the backoff timer (or the safety interval) retries; a coalesced
            // request must not trigger an immediate second failing write.
            if !(state.rerun && ok && !state.disposed) {
                // Cleared together with the loop exit, so a check() never lands in a gap where
                // `running` is still set but no further pass will happen.
                if let Some(running) = state.running.take() {
                    running.send_replace(true);
                }
                guard.armed = false;
                return;
            }
            state.rerun = false;
        }
    }

    /// One markDue pass, then re-arm. `false` when markDue failed (or the backoff is active).
    async fn pass(&self) -> bool {
        {
            let mut state = lock(&self.state);
            if self.backoff_remaining(&state) > 0 {
                // A safety tick or an external check during the backoff: wait for the retry timer.
                self.reschedule_locked(&mut state);
                return false;
            }
        }
        let ok = match self.service.mark_due().await {
            Ok(batch) => {
                let disposed = {
                    let mut state = lock(&self.state);
                    state.retry_not_before = None;
                    state.disposed
                };
                if !disposed && !batch.is_empty() {
                    let count = batch.len();
                    if catch_unwind(AssertUnwindSafe(|| (self.on_fired)(batch))).is_err() {
                        log::error!("onFired failed (count {count})");
                    }
                }
                true
            }
            Err(error) => {
                log::error!("markDue failed ({:?})", error.code());
                lock(&self.state).retry_not_before = Some(self.now_ms() + RETRY_MS);
                false
            }
        };
        self.reschedule();
        ok
    }

    /// Purges old done reminders, reports the ones missed while the app was closed, arms the
    /// timer and starts the safety interval. Runs once.
    pub async fn start(&self) {
        {
            let mut state = lock(&self.state);
            if state.started || state.disposed {
                return;
            }
            state.started = true;
        }
        if let Err(error) = self.service.purge_done().await {
            log::error!("purgeDone failed ({:?})", error.code());
        }
        match self.service.mark_missed_on_start().await {
            Ok(missed) => {
                let disposed = lock(&self.state).disposed;
                if !disposed && !missed.is_empty() {
                    let count = missed.len();
                    if catch_unwind(AssertUnwindSafe(|| (self.on_missed)(missed))).is_err() {
                        log::error!("markMissedOnStart failed: listener (count {count})");
                    }
                }
            }
            Err(error) => log::error!("markMissedOnStart failed ({:?})", error.code()),
        }
        let mut state = lock(&self.state);
        if state.disposed {
            return;
        }
        self.reschedule_locked(&mut state);
        if let Some(safety) = &self.safety {
            let me = self.me.clone();
            state.interval = Some(Interval::start(
                Arc::clone(&safety.timers),
                safety.period_ms,
                Arc::new(move || {
                    if let Some(scheduler) = me.upgrade() {
                        drop(scheduler.check());
                    }
                }),
            ));
        }
    }

    /// Cancels the timer and the interval; later checks and reschedules do nothing.
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

/// The power listener of the reminders: resume and unlock both start a (coalesced) check, as
/// timers stall while the PC sleeps.
pub fn check_on_power(scheduler: Weak<ReminderScheduler>) -> PowerListener {
    Arc::new(move |_event: PowerEvent| {
        if let Some(scheduler) = scheduler.upgrade() {
            drop(scheduler.check());
        }
    })
}

#[cfg(test)]
mod tests;
