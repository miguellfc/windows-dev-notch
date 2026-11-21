//! Port of 0.1.0's `system-monitor.ts`: decides when to sample. Light every 3 s while the
//! capsule is visible (peek included, and every panel), nothing in mini / hidden / alert. The
//! System view and its full rhythm (disks, network, processes every 1 s) were removed: what is
//! left feeds the capsule's metrics, the panel header's copy of them and the system alerts.
//!
//! Threads: the rhythm state lives behind a short lock that is never held across a sample.
//! Everything that touches the sampler (a tick, the baseline reset) is queued as a job and run,
//! in order, by one drain at a time through the injected [`Executor`] (`spawn_blocking` in the
//! app, inline in unit tests), so the Win32 reads never run on the caller's thread (the main
//! thread for mode changes and page loads) and two samples never overlap. Results are emitted
//! after each job, outside the sampler's lock. Like JS `setInterval` callbacks, interval ticks
//! never overlap: an interval tick that fires while another tick is still queued or running is
//! skipped (coalesced) rather than piled up. Explicit samples (a restart, a resync) always run,
//! after whatever is queued.

use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use super::alerts::{AlertInput, Alerts, BatteryInput, DiskFree};
use super::metrics::{Metrics, MetricsLight};
use crate::contract::notch::NotchMode;
use crate::contract::settings::SystemAlertSettings;
use crate::contract::system::{StorageSample, SystemAlerts, SystemMetrics, Unavailable};
use crate::services::timers::{Interval, Timers};

pub const LIGHT_INTERVAL_MS: u64 = 3000;
/// A pause at least this long resets the CPU baseline; over a shorter one the delta is a true
/// average.
pub const LONG_PAUSE_MS: u64 = 10_000;
/// The light rhythm reads free disk space (no PDH) at most this often, for the disk alert.
pub const DISK_CHECK_MS: u64 = 60_000;

/// Runs a job on a worker thread (`spawn_blocking` in the app; inline in unit tests).
pub type Executor = Arc<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;
/// Receives every `system:metrics` payload.
pub type MetricsSink = Box<dyn Fn(&SystemMetrics) + Send + Sync>;
/// A monotonic clock in milliseconds: a wall-clock change must never stretch or shrink a pause.
pub type MonotonicClock = Arc<dyn Fn() -> u64 + Send + Sync>;
/// The live alert settings.
pub type AlertSettingsSource = Box<dyn Fn() -> SystemAlertSettings + Send + Sync>;

pub struct MonitorOptions {
    /// Absent when the Win32 API could not load (the monitor then only reports `unavailable`).
    pub metrics: Option<Box<dyn Metrics>>,
    /// Turns each emitted sample into its `alerts`.
    pub alerts: Box<dyn Alerts>,
    /// The live alert settings, read on every tick.
    pub alert_settings: AlertSettingsSource,
    pub timers: Arc<dyn Timers>,
    /// Monotonic clock in ms, used to measure pauses.
    pub now: MonotonicClock,
    pub on_metrics: MetricsSink,
    pub executor: Executor,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Rhythm {
    Paused,
    Light,
}

/// Modes where nothing is sampled: the capsule is the user's pinned pill, off screen, or showing
/// an alert. Peek (the resting capsule) keeps the light rhythm although it shows no metrics:
/// pausing there would reset the CPU baseline and the sustained-alert window after every long
/// rest, so each hover into compact would open on "—" and stale alerts.
fn desired(mode: NotchMode) -> Rhythm {
    match mode {
        NotchMode::Mini | NotchMode::Hidden | NotchMode::Alert => Rhythm::Paused,
        _ => Rhythm::Light,
    }
}

struct State {
    mode: NotchMode,
    rhythm: Rhythm,
    interval: Option<Interval>,
    /// Bumped every time the timers stop (a restart, a pause, dispose). Ticks and interval
    /// firings carry the generation they were started with and do nothing once it is stale: a
    /// callback already in flight when its timer was cleared, or a tick queued before the rhythm
    /// changed, cannot act on the newer rhythm.
    generation: u64,
    /// When the current pause began; `None` before the first rhythm (always a fresh start).
    paused_at: Option<u64>,
    /// When the light rhythm last read free disk space; `None` = read on its next tick.
    last_disk_at: Option<u64>,
    disposed: bool,
    /// Ticks queued or running: an interval tick is skipped while this is not zero.
    ticks_pending: usize,
}

struct Work {
    metrics: Option<Box<dyn Metrics>>,
    alerts: Box<dyn Alerts>,
    /// The worst drive of the last disk reading, sent with every sample until the next one (the
    /// light rhythm reads disks every [`DISK_CHECK_MS`]); a failed read keeps it.
    storage: Option<StorageSample>,
}

type Job = Box<dyn FnOnce(&Inner, &mut Work) -> Option<SystemMetrics> + Send>;

#[derive(Default)]
struct Queue {
    jobs: VecDeque<Job>,
    running: bool,
}

struct Inner {
    me: Weak<Inner>,
    available: bool,
    /// Lock order: `work` before `state`, `state` before `queue`. `state` is never held across
    /// a sample, a job or a callback.
    state: Mutex<State>,
    work: Mutex<Work>,
    queue: Mutex<Queue>,
    timers: Arc<dyn Timers>,
    now: MonotonicClock,
    alert_settings: AlertSettingsSource,
    on_metrics: MetricsSink,
    executor: Executor,
}

/// The rhythm and generation a tick was queued with.
#[derive(Clone, Copy)]
struct Stamp {
    rhythm: Rhythm,
    generation: u64,
}

/// Decrements `ticks_pending` when a tick ends, normally or by a panic.
struct TickPending<'a>(&'a Inner);

impl Drop for TickPending<'_> {
    fn drop(&mut self) {
        let mut state = lock(&self.0.state);
        state.ticks_pending = state.ticks_pending.saturating_sub(1);
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Never logs the panic payload: it could carry a path or other machine details.
fn guarded(what: &str, run: impl FnOnce()) {
    if catch_unwind(AssertUnwindSafe(run)).is_err() {
        log::error!("System sample failed: {what} (panic)");
    }
}

/// The capsule's storage figure: the whole computer's fill, as % used over every fixed drive read
/// (used bytes over total bytes, so a big drive weighs more than a small one). `None` without one.
fn storage_of(disks: &[DiskFree]) -> Option<StorageSample> {
    let (used, total) = disks.iter().fold((0u128, 0u128), |(used, total), disk| {
        let free = disk.free_bytes.min(disk.total_bytes);
        (
            used + u128::from(disk.total_bytes - free),
            total + u128::from(disk.total_bytes),
        )
    });
    (total > 0).then(|| StorageSample {
        used_percent: (100.0 * used as f64 / total as f64).clamp(0.0, 100.0),
    })
}

impl Inner {
    fn unavailable(&self) {
        (self.on_metrics)(&SystemMetrics::Unavailable(Unavailable {}));
    }

    fn push(&self, job: Job) {
        lock(&self.queue).jobs.push_back(job);
    }

    /// Starts a drain unless one is running. Call with no `state` lock held: an inline executor
    /// runs the jobs right here.
    fn kick(&self) {
        {
            let mut queue = lock(&self.queue);
            if queue.running || queue.jobs.is_empty() {
                return;
            }
            queue.running = true;
        }
        let me = self.me.clone();
        (self.executor)(Box::new(move || {
            if let Some(inner) = me.upgrade() {
                inner.drain();
            }
        }));
    }

    fn drain(&self) {
        loop {
            let job = {
                let mut queue = lock(&self.queue);
                match queue.jobs.pop_front() {
                    Some(job) => job,
                    None => {
                        queue.running = false;
                        return;
                    }
                }
            };
            let emission = {
                let mut work = lock(&self.work);
                catch_unwind(AssertUnwindSafe(|| job(self, &mut work))).unwrap_or_else(|_| {
                    log::error!("System sample failed: job (panic)");
                    None
                })
            };
            if let Some(metrics) = emission {
                guarded("emit", || (self.on_metrics)(&metrics));
            }
        }
    }

    fn stop_timer(&self, state: &mut State) {
        state.generation += 1;
        // Dropping the interval clears its pending timer.
        state.interval = None;
    }

    /// Queues a tick stamped with the current rhythm and generation: it does nothing if either
    /// changed by the time it runs.
    fn push_tick(&self, state: &mut State) {
        state.ticks_pending += 1;
        let stamp = Stamp {
            rhythm: state.rhythm,
            generation: state.generation,
        };
        self.push(Box::new(move |inner: &Inner, work: &mut Work| {
            inner.tick(work, stamp)
        }));
    }

    /// Samples now and restarts the interval from this sample.
    fn restart(&self, state: &mut State) {
        self.stop_timer(state);
        if state.rhythm == Rhythm::Paused {
            return;
        }
        self.push_tick(state);
        let me = self.me.clone();
        let generation = state.generation;
        state.interval = Some(Interval::start(
            Arc::clone(&self.timers),
            LIGHT_INTERVAL_MS,
            Arc::new(move || {
                if let Some(inner) = me.upgrade() {
                    inner.on_interval(generation);
                }
            }),
        ));
    }

    /// An interval firing; ignored if its interval was stopped meanwhile (a firing already in
    /// progress when `stop()` ran).
    fn on_interval(&self, generation: u64) {
        {
            let mut state = lock(&self.state);
            if state.disposed || state.generation != generation || state.ticks_pending > 0 {
                return;
            }
            self.push_tick(&mut state);
        }
        self.kick();
    }

    fn apply(&self, state: &mut State) {
        if state.disposed || !self.available {
            return;
        }
        let next = desired(state.mode);
        if next == state.rhythm {
            return;
        }
        let previous = state.rhythm;
        state.rhythm = next;
        if next == Rhythm::Paused {
            self.stop_timer(state);
            state.paused_at = Some((self.now)());
            return;
        }
        // After a long pause the old CPU baseline is stale: forget it (the next CPU is null). A
        // short pause (e.g. a brief alert) keeps it, so the capsule does not flash "—". The alert
        // state (CPU window, last disk reading) is as stale as the baseline: it resets with it.
        let long_pause = state
            .paused_at
            .is_none_or(|at| (self.now)().saturating_sub(at) >= LONG_PAUSE_MS);
        if previous == Rhythm::Paused && long_pause {
            self.push(Box::new(|_: &Inner, work: &mut Work| {
                if let Some(metrics) = work.metrics.as_mut() {
                    metrics.reset();
                }
                work.alerts.reset();
                None
            }));
        }
        // Entering the light rhythm reads disk space on its first tick.
        state.last_disk_at = None;
        self.restart(state);
    }

    /// Evaluates one emitted sample. Fails open: if the settings or the evaluator panic, the
    /// sample still goes out with no alerts.
    fn evaluate(
        &self,
        alerts: &mut dyn Alerts,
        sample: &MetricsLight,
        disks: Option<Vec<DiskFree>>,
        now: u64,
    ) -> SystemAlerts {
        let run = || {
            let input = AlertInput {
                now,
                cpu_percent: sample.cpu_percent,
                ram_percent: sample
                    .ram
                    .filter(|ram| ram.total_bytes > 0.0)
                    .map(|ram| (100.0 * ram.used_bytes / ram.total_bytes).round()),
                battery: sample.battery.map(|battery| BatteryInput {
                    percent: battery.percent,
                    plugged_in: battery.plugged_in,
                }),
                disks,
            };
            alerts.evaluate(&input, &(self.alert_settings)())
        };
        catch_unwind(AssertUnwindSafe(run)).unwrap_or_else(|_| {
            log::error!("Alert evaluation failed (panic)");
            SystemAlerts::default()
        })
    }

    fn tick(&self, work: &mut Work, stamp: Stamp) -> Option<SystemMetrics> {
        // Released even if the tick panics outside `guarded`: a stuck count would make every
        // later interval tick skip.
        let _pending = TickPending(self);
        self.tick_inner(work, stamp)
    }

    fn tick_inner(&self, work: &mut Work, stamp: Stamp) -> Option<SystemMetrics> {
        let now = {
            let state = lock(&self.state);
            if state.disposed
                || state.rhythm != stamp.rhythm
                || state.generation != stamp.generation
                || state.rhythm == Rhythm::Paused
            {
                return None;
            }
            (self.now)()
        };
        let Work {
            metrics,
            alerts,
            storage,
        } = work;
        let metrics = metrics.as_mut()?;
        let mut out = None;
        guarded("light", || {
            let sample = metrics.light();
            let disks = self.light_disks(metrics.as_mut(), now);
            if let Some(disks) = &disks {
                *storage = storage_of(disks);
            }
            let alerts = self.evaluate(alerts.as_mut(), &sample, disks, now);
            out = Some(SystemMetrics::Light(
                sample.with_alerts(alerts, storage.clone()),
            ));
        });
        out
    }

    /// Free disk space on the first light tick after a (re)start, then every [`DISK_CHECK_MS`];
    /// otherwise `None`.
    fn light_disks(&self, metrics: &mut dyn Metrics, now: u64) -> Option<Vec<DiskFree>> {
        {
            let mut state = lock(&self.state);
            if state
                .last_disk_at
                .is_some_and(|at| now.saturating_sub(at) < DISK_CHECK_MS)
            {
                return None;
            }
            state.last_disk_at = Some(now);
        }
        metrics.disks()
    }
}

pub struct SystemMonitor {
    inner: Arc<Inner>,
}

impl SystemMonitor {
    pub fn new(options: MonitorOptions) -> Self {
        let available = options.metrics.is_some();
        let inner = Arc::new_cyclic(|me| Inner {
            me: me.clone(),
            available,
            state: Mutex::new(State {
                mode: NotchMode::Hidden,
                rhythm: Rhythm::Paused,
                interval: None,
                generation: 0,
                paused_at: None,
                last_disk_at: None,
                disposed: false,
                ticks_pending: 0,
            }),
            work: Mutex::new(Work {
                metrics: options.metrics,
                alerts: options.alerts,
                storage: None,
            }),
            queue: Mutex::new(Queue::default()),
            timers: options.timers,
            now: options.now,
            alert_settings: options.alert_settings,
            on_metrics: options.on_metrics,
            executor: options.executor,
        });
        if !available {
            inner.unavailable();
        }
        Self { inner }
    }

    /// Mini, hidden and alert pause the sampling; every other mode samples on the light rhythm.
    pub fn set_mode(&self, mode: NotchMode) {
        {
            let mut state = lock(&self.inner.state);
            state.mode = mode;
            self.inner.apply(&mut state);
        }
        self.inner.kick();
    }

    /// The notch (re)loaded: samples at once (or re-sends `unavailable`) so it never waits.
    pub fn resync(&self) {
        {
            let mut state = lock(&self.inner.state);
            if state.disposed {
                return;
            }
            if !self.inner.available {
                drop(state);
                self.inner.unavailable();
                return;
            }
            if state.rhythm != Rhythm::Paused {
                self.inner.restart(&mut state);
            }
        }
        self.inner.kick();
    }

    pub fn dispose(&self) {
        let mut state = lock(&self.inner.state);
        state.disposed = true;
        self.inner.stop_timer(&mut state);
        state.rhythm = Rhythm::Paused;
        lock(&self.inner.queue).jobs.clear();
    }
}

#[cfg(test)]
mod tests;
