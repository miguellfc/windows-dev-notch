//! Port of `src/main/system/system-monitor.ts`: decides when to sample. Light every 3 s while
//! the capsule is visible (peek included), full + processes every 1 s in `system` mode (the System
//! view), nothing in mini / hidden / alert. Exactly one of `light()` or `full()` runs per tick,
//! because both share the CPU baseline. The view's open state follows the mode alone.
//!
//! Threads: the rhythm state lives behind a short lock that is never held across a sample.
//! Everything that touches the samplers (a tick, the silent warm-up, a re-sort, the baseline
//! resets) is queued as a job and run, in order, by one drain at a time through the injected
//! [`Executor`] (`spawn_blocking` in the app, inline in unit tests), so the Win32 reads never run
//! on the caller's thread (the main thread for mode changes and page loads) and two samples never
//! overlap. Results are emitted after each job, outside the samplers' lock. Like JS `setInterval`
//! callbacks, interval ticks never overlap: an interval tick that fires while another tick is
//! still queued or running is skipped (coalesced) rather than piled up. Explicit samples (a
//! restart, a resync, a kill refresh) always run, after whatever is queued.
//! [`kill`](SystemMonitor::kill) runs the sampler synchronously and blocks on the samplers'
//! lock: call it off the main thread.

use std::collections::VecDeque;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use super::alerts::{AlertInput, Alerts, BatteryInput, DiskFree};
use super::metrics::{Metrics, MetricsFull, MetricsLight};
use super::processes::{MonotonicClock, Processes};
use crate::contract::notch::NotchMode;
use crate::contract::settings::SystemAlertSettings;
use crate::contract::system::{
    KillInput, KillResult, ProcessOrder, ProcessRow, SystemAlerts, SystemMetrics, Unavailable,
    PROCESS_LIMIT,
};
use crate::services::timers::{Interval, TimerId, Timers};

pub const LIGHT_INTERVAL_MS: u64 = 3000;
pub const FULL_INTERVAL_MS: u64 = 1000;
/// A pause at least this long resets the CPU baseline; over a shorter one the delta is a true
/// average.
pub const LONG_PAUSE_MS: u64 = 10_000;
/// When the view opens with no recent full sample, the backend samples once silently and sends
/// the first full sample this much later, so per-process CPU and the PDH rates (which need two
/// reads at least 500 ms apart) are real values instead of "—".
pub const WARMUP_MS: u64 = 600;
/// The light rhythm reads free disk space (no PDH) at most this often, for the disk alert.
pub const DISK_CHECK_MS: u64 = 60_000;

/// Runs a job on a worker thread (`spawn_blocking` in the app; inline in unit tests).
pub type Executor = Arc<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;
/// Receives every `system:metrics` payload.
pub type MetricsSink = Box<dyn Fn(&SystemMetrics) + Send + Sync>;
/// Receives every `system:processes` payload.
pub type ProcessesSink = Box<dyn Fn(&[ProcessRow]) + Send + Sync>;
/// The live alert settings.
pub type AlertSettingsSource = Box<dyn Fn() -> SystemAlertSettings + Send + Sync>;

/// Both samplers; absent when the Win32 API could not load (the monitor then only reports
/// `unavailable`).
pub struct Samplers {
    pub metrics: Box<dyn Metrics>,
    pub processes: Box<dyn Processes>,
}

pub struct MonitorOptions {
    pub samplers: Option<Samplers>,
    /// Turns each emitted sample into its `alerts`.
    pub alerts: Box<dyn Alerts>,
    /// The live alert settings, read on every tick.
    pub alert_settings: AlertSettingsSource,
    pub timers: Arc<dyn Timers>,
    /// Monotonic clock in ms, used to measure pauses.
    pub now: MonotonicClock,
    pub on_metrics: MetricsSink,
    pub on_processes: ProcessesSink,
    pub executor: Executor,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Rhythm {
    Paused,
    Light,
    Full,
}

/// Modes where nothing is sampled: the capsule is the user's pinned pill, off screen, or showing
/// an alert. Peek (the resting capsule) keeps the light rhythm although it shows no metrics:
/// pausing there would reset the CPU baseline and the sustained-alert window after every long
/// rest, so each hover into compact would open on "—" and stale alerts.
fn desired(mode: NotchMode) -> Rhythm {
    match mode {
        NotchMode::Mini | NotchMode::Hidden | NotchMode::Alert => Rhythm::Paused,
        NotchMode::System => Rhythm::Full,
        _ => Rhythm::Light,
    }
}

struct State {
    mode: NotchMode,
    order: ProcessOrder,
    rhythm: Rhythm,
    interval: Option<Interval>,
    /// The one-shot timer of a warm-up; `None` otherwise.
    warmup: Option<TimerId>,
    /// A warm-up whose baselines are still being taken (its timer is armed once they are, as
    /// `warmUp` does synchronously): the generation it was started with.
    warmup_pending: Option<u64>,
    /// Bumped every time the timers stop (a restart, a warm-up, a pause, dispose). Ticks, interval
    /// firings and warm-up callbacks carry the generation they were started with and do nothing
    /// once it is stale: a callback already in flight when its timer was cleared, or a tick
    /// queued before the rhythm changed, cannot act on the newer rhythm (JS never interleaves
    /// like this, so the stamped behaviour is the faithful one).
    generation: u64,
    /// When the last full sample (or warm-up) ran; `None` before the first one.
    last_full_at: Option<u64>,
    /// When the current pause began; `None` before the first rhythm (always a fresh start).
    paused_at: Option<u64>,
    /// When the light rhythm last read free disk space; `None` = read on its next tick.
    last_disk_at: Option<u64>,
    disposed: bool,
    /// Ticks queued or running: an interval tick is skipped while this is not zero.
    ticks_pending: usize,
}

struct Work {
    samplers: Option<Samplers>,
    alerts: Box<dyn Alerts>,
}

enum Emission {
    Metrics(SystemMetrics),
    Processes(Vec<ProcessRow>),
}

type Job = Box<dyn FnOnce(&Inner, &mut Work) -> Vec<Emission> + Send>;

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
    on_processes: ProcessesSink,
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

/// Never logs the panic payload: it could carry a process name.
fn guarded(what: &str, run: impl FnOnce()) {
    if catch_unwind(AssertUnwindSafe(run)).is_err() {
        log::error!("System sample failed: {what} (panic)");
    }
}

/// Free space from a full sample, so the full rhythm needs no extra disk read.
fn free_from_full(sample: &MetricsFull) -> Vec<DiskFree> {
    sample
        .disks
        .iter()
        .map(|disk| DiskFree {
            letter: disk.letter.clone(),
            free_percent: 100.0 - disk.used_percent,
        })
        .collect()
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
            let emissions = {
                let mut work = lock(&self.work);
                catch_unwind(AssertUnwindSafe(|| job(self, &mut work))).unwrap_or_else(|_| {
                    log::error!("System sample failed: job (panic)");
                    Vec::new()
                })
            };
            for emission in emissions {
                guarded("emit", || match &emission {
                    Emission::Metrics(metrics) => (self.on_metrics)(metrics),
                    Emission::Processes(rows) => (self.on_processes)(rows),
                });
            }
        }
    }

    fn stop_timer(&self, state: &mut State) {
        state.generation += 1;
        // Dropping the interval clears its pending timer.
        state.interval = None;
        state.warmup_pending = None;
        if let Some(id) = state.warmup.take() {
            self.timers.clear(id);
        }
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
        let period = if state.rhythm == Rhythm::Full {
            FULL_INTERVAL_MS
        } else {
            LIGHT_INTERVAL_MS
        };
        let me = self.me.clone();
        let generation = state.generation;
        state.interval = Some(Interval::start(
            Arc::clone(&self.timers),
            period,
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

    /// Takes silent baselines now and starts the full rhythm [`WARMUP_MS`] after they are taken
    /// (`warmUp` reads them synchronously before arming its timeout). Arming the timer before the
    /// queued baselines ran would leave the first full tick less than the sampler's minimum CPU
    /// interval after them whenever the baselines are slow (a cold PDH query, a long process
    /// list), and the first list would show no CPU values.
    fn warm_up(&self, state: &mut State) {
        self.stop_timer(state);
        state.last_full_at = Some((self.now)());
        let generation = state.generation;
        state.warmup_pending = Some(generation);
        self.push(Box::new(move |inner: &Inner, work: &mut Work| {
            let order = lock(&inner.state).order;
            if let Some(samplers) = work.samplers.as_mut() {
                guarded("warm-up", || {
                    samplers.metrics.full();
                    samplers.processes.top(order, PROCESS_LIMIT);
                });
                // The warm-up list never reached the view: nothing in it may be closed.
                samplers.processes.forget_list();
            }
            inner.arm_warmup(generation);
            Vec::new()
        }));
    }

    /// Arms the warm-up's timer, unless that warm-up was stopped while its baselines ran. The
    /// timer only starts the rhythm while its warm-up is still the current one: a late callback
    /// of a stopped warm-up must not cut a newer one short.
    fn arm_warmup(&self, generation: u64) {
        let mut state = lock(&self.state);
        if state.disposed || state.warmup_pending != Some(generation) {
            return;
        }
        state.warmup_pending = None;
        let me = self.me.clone();
        state.warmup = Some(self.timers.set_timeout(
            WARMUP_MS,
            Box::new(move || {
                let Some(inner) = me.upgrade() else { return };
                {
                    let mut state = lock(&inner.state);
                    if state.disposed || state.generation != generation {
                        return;
                    }
                    state.warmup = None;
                    inner.restart(&mut state);
                }
                inner.kick();
            }),
        ));
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
                if let Some(samplers) = work.samplers.as_mut() {
                    samplers.metrics.reset();
                }
                work.alerts.reset();
                Vec::new()
            }));
        }
        // Entering the light rhythm (from a pause or the view) reads disk space on its first tick.
        if next == Rhythm::Light {
            state.last_disk_at = None;
        }
        if next == Rhythm::Full {
            // A fresh view may only close rows it shows. Per-process CPU baselines survive a short
            // close (the delta is then a true average); after a long one they are stale.
            self.push(Box::new(|_: &Inner, work: &mut Work| {
                if let Some(samplers) = work.samplers.as_mut() {
                    samplers.processes.forget_list();
                }
                Vec::new()
            }));
            let stale = state
                .last_full_at
                .is_none_or(|at| (self.now)().saturating_sub(at) >= LONG_PAUSE_MS);
            if stale {
                self.push(Box::new(|_: &Inner, work: &mut Work| {
                    if let Some(samplers) = work.samplers.as_mut() {
                        samplers.processes.reset();
                    }
                    Vec::new()
                }));
                self.warm_up(state);
                return;
            }
        }
        self.restart(state);
    }

    fn push_processes(&self) {
        self.push(Box::new(|inner: &Inner, work: &mut Work| {
            let order = lock(&inner.state).order;
            let mut out = Vec::new();
            if let Some(samplers) = work.samplers.as_mut() {
                guarded("processes", || {
                    out.push(Emission::Processes(
                        samplers.processes.top(order, PROCESS_LIMIT),
                    ));
                });
            }
            out
        }));
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

    fn tick(&self, work: &mut Work, stamp: Stamp) -> Vec<Emission> {
        // Released even if the tick panics outside `guarded`: a stuck count would make every
        // later interval tick skip.
        let _pending = TickPending(self);
        self.tick_inner(work, stamp)
    }

    fn tick_inner(&self, work: &mut Work, stamp: Stamp) -> Vec<Emission> {
        let (rhythm, order, now) = {
            let mut state = lock(&self.state);
            if state.disposed
                || state.rhythm != stamp.rhythm
                || state.generation != stamp.generation
            {
                return Vec::new();
            }
            let now = (self.now)();
            if state.rhythm == Rhythm::Full {
                state.last_full_at = Some(now);
            }
            (state.rhythm, state.order, now)
        };
        let Work { samplers, alerts } = work;
        let Some(samplers) = samplers.as_mut() else {
            return Vec::new();
        };
        let mut out = Vec::new();
        match rhythm {
            Rhythm::Full => {
                guarded("full", || {
                    let sample = samplers.metrics.full();
                    let disks = Some(free_from_full(&sample));
                    let alerts = self.evaluate(alerts.as_mut(), &sample.light(), disks, now);
                    out.push(Emission::Metrics(SystemMetrics::Full(
                        sample.with_alerts(alerts),
                    )));
                });
                guarded("processes", || {
                    out.push(Emission::Processes(
                        samplers.processes.top(order, PROCESS_LIMIT),
                    ));
                });
            }
            Rhythm::Light => {
                guarded("light", || {
                    let sample = samplers.metrics.light();
                    let disks = self.light_disks(samplers.metrics.as_mut(), now);
                    let alerts = self.evaluate(alerts.as_mut(), &sample, disks, now);
                    out.push(Emission::Metrics(SystemMetrics::Light(
                        sample.with_alerts(alerts),
                    )));
                });
            }
            Rhythm::Paused => {}
        }
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
        let available = options.samplers.is_some();
        let inner = Arc::new_cyclic(|me| Inner {
            me: me.clone(),
            available,
            state: Mutex::new(State {
                mode: NotchMode::Hidden,
                order: ProcessOrder::Cpu,
                rhythm: Rhythm::Paused,
                interval: None,
                warmup: None,
                warmup_pending: None,
                generation: 0,
                last_full_at: None,
                paused_at: None,
                last_disk_at: None,
                disposed: false,
                ticks_pending: 0,
            }),
            work: Mutex::new(Work {
                samplers: options.samplers,
                alerts: options.alerts,
            }),
            queue: Mutex::new(Queue::default()),
            timers: options.timers,
            now: options.now,
            alert_settings: options.alert_settings,
            on_metrics: options.on_metrics,
            on_processes: options.on_processes,
            executor: options.executor,
        });
        if !available {
            inner.unavailable();
        }
        Self { inner }
    }

    /// The `system` mode is the System view: entering it starts the full rhythm, leaving it
    /// stops it.
    pub fn set_mode(&self, mode: NotchMode) {
        {
            let mut state = lock(&self.inner.state);
            state.mode = mode;
            self.inner.apply(&mut state);
        }
        self.inner.kick();
    }

    /// The process order for the next emissions (re-sorts at once while the view is open).
    pub fn set_order(&self, by: ProcessOrder) {
        {
            let mut state = lock(&self.inner.state);
            if state.disposed {
                return;
            }
            // The view sends its order on mount: an unavailable monitor answers with its state.
            if !self.inner.available {
                drop(state);
                self.inner.unavailable();
                return;
            }
            if by == state.order {
                return;
            }
            state.order = by;
            // A new order re-sorts at once (the sampler reuses CPU values on a short interval);
            // during a warm-up the first emission already uses it.
            if state.rhythm == Rhythm::Full
                && state.warmup.is_none()
                && state.warmup_pending.is_none()
            {
                self.inner.push_processes();
            }
        }
        self.inner.kick();
    }

    /// Validates and performs a close request. Blocks while a sample runs: call it off the main
    /// thread.
    pub fn kill(&self, input: &KillInput) -> KillResult {
        if lock(&self.inner.state).disposed || !self.inner.available {
            return KillResult::NotKillable;
        }
        let result = {
            let mut work = lock(&self.inner.work);
            match work.samplers.as_mut() {
                Some(samplers) => samplers.processes.kill(input),
                None => KillResult::NotKillable,
            }
        };
        // The result only: never the pid or the process name.
        log::info!("Process close requested: {}", result.as_str());
        if result == KillResult::Killed {
            {
                let mut state = lock(&self.inner.state);
                if state.rhythm == Rhythm::Full && !state.disposed {
                    self.inner.restart(&mut state);
                }
            }
            self.inner.kick();
        }
        result
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
