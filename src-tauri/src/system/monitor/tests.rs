//! Port of `tests/unit/main/system-monitor.test.ts` (every case). The vitest fake timers become
//! [`TestTimers`] moved one millisecond at a time (so an interval fires as often as in vitest),
//! wrapped to count the armed timers (`vi.getTimerCount()`); the executor runs jobs inline, so
//! every sample happens synchronously as in the single-threaded TS. "Throws" is a panicking spy.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};

use super::*;
use crate::contract::system::{FullSample, LightSample, RamSample};
use crate::services::timers::{TestTimers, TimerCallback};
use crate::settings::default_settings;
use crate::system::alerts::AlertEvaluator;

// --- virtual clock ---

struct Clock {
    timers: TestTimers,
    armed: Arc<Mutex<HashSet<TimerId>>>,
    now: AtomicU64,
}

impl Clock {
    fn new() -> Self {
        Self {
            timers: TestTimers::new(),
            armed: Arc::new(Mutex::new(HashSet::new())),
            now: AtomicU64::new(0),
        }
    }

    /// `vi.advanceTimersByTime(ms)`.
    fn advance(&self, ms: u64) {
        for _ in 0..ms {
            self.now.fetch_add(1, Ordering::SeqCst);
            self.timers.advance(1);
        }
    }

    /// `vi.getTimerCount()`.
    fn count(&self) -> usize {
        lock(&self.armed).len()
    }
}

impl Timers for Clock {
    fn set_timeout(&self, ms: u64, f: TimerCallback) -> TimerId {
        let slot: Arc<Mutex<Option<TimerId>>> = Arc::new(Mutex::new(None));
        let armed = Arc::clone(&self.armed);
        let own = Arc::clone(&slot);
        let id = self.timers.set_timeout(
            ms,
            Box::new(move || {
                if let Some(id) = lock(&own).take() {
                    lock(&armed).remove(&id);
                }
                f();
            }),
        );
        *lock(&slot) = Some(id);
        lock(&self.armed).insert(id);
        id
    }

    fn clear(&self, id: TimerId) {
        lock(&self.armed).remove(&id);
        self.timers.clear(id);
    }
}

// --- spies ---

fn light() -> MetricsLight {
    MetricsLight {
        cpu_percent: Some(10.0),
        ram: Some(RamSample {
            used_bytes: 1.0,
            total_bytes: 2.0,
        }),
        battery: None,
    }
}

fn full() -> MetricsFull {
    let light = light();
    MetricsFull {
        cpu_percent: light.cpu_percent,
        ram: light.ram,
        battery: light.battery,
        disks: Vec::new(),
        network: None,
    }
}

fn disks() -> Vec<DiskFree> {
    vec![DiskFree {
        letter: "C".into(),
        free_percent: 40.0,
    }]
}

fn row(pid: u64) -> ProcessRow {
    ProcessRow {
        pid,
        name: "x.exe".into(),
        cpu_percent: Some(1.0),
        private_bytes: Some(1.0),
        start_time: "t".into(),
        killable: true,
    }
}

fn no_alerts() -> SystemAlerts {
    SystemAlerts::default()
}

fn light_metrics(sample: MetricsLight) -> SystemMetrics {
    SystemMetrics::Light(sample.with_alerts(no_alerts()))
}

fn full_metrics(sample: MetricsFull) -> SystemMetrics {
    SystemMetrics::Full(sample.with_alerts(no_alerts()))
}

fn default_alert_settings() -> SystemAlertSettings {
    default_settings("en").system_alerts
}

struct Spy {
    calls: Vec<String>,
    light: MetricsLight,
    full: MetricsFull,
    disks: Option<Vec<DiskFree>>,
    light_panics: usize,
    full_panics: usize,
    evaluate_result: SystemAlerts,
    evaluate_panics: bool,
    settings_panics: bool,
    real: Option<AlertEvaluator>,
    inputs: Vec<(AlertInput, SystemAlertSettings)>,
    settings: SystemAlertSettings,
    kill_result: KillResult,
    kills: Vec<KillInput>,
    metrics_out: Vec<SystemMetrics>,
    processes_out: Vec<Vec<ProcessRow>>,
}

type Shared = Arc<Mutex<Spy>>;
type Deferred = Arc<Mutex<Vec<Box<dyn FnOnce() + Send>>>>;

fn record(spy: &Shared, call: impl Into<String>) {
    lock(spy).calls.push(call.into());
}

struct SpyMetrics(Shared);
struct SpyProcesses(Shared);
struct SpyAlerts(Shared);

impl Metrics for SpyMetrics {
    fn light(&mut self) -> MetricsLight {
        let mut spy = lock(&self.0);
        spy.calls.push("light".into());
        if spy.light_panics > 0 {
            spy.light_panics -= 1;
            drop(spy);
            panic!("boom chrome.exe");
        }
        spy.light.clone()
    }

    fn full(&mut self) -> MetricsFull {
        let mut spy = lock(&self.0);
        spy.calls.push("full".into());
        if spy.full_panics > 0 {
            spy.full_panics -= 1;
            drop(spy);
            panic!("pdh");
        }
        spy.full.clone()
    }

    fn disks(&mut self) -> Option<Vec<DiskFree>> {
        let mut spy = lock(&self.0);
        spy.calls.push("disks".into());
        spy.disks.clone()
    }

    fn reset(&mut self) {
        record(&self.0, "metrics.reset");
    }
}

impl Processes for SpyProcesses {
    fn top(&mut self, by: ProcessOrder, _limit: usize) -> Vec<ProcessRow> {
        record(&self.0, format!("top:{}", by.as_str()));
        vec![row(if by == ProcessOrder::Cpu { 1 } else { 2 })]
    }

    fn kill(&mut self, input: &KillInput) -> KillResult {
        let mut spy = lock(&self.0);
        spy.calls.push("kill".into());
        spy.kills.push(input.clone());
        spy.kill_result
    }

    fn reset(&mut self) {
        record(&self.0, "processes.reset");
    }

    fn forget_list(&mut self) {
        record(&self.0, "forget");
    }
}

impl Alerts for SpyAlerts {
    fn evaluate(&mut self, input: &AlertInput, settings: &SystemAlertSettings) -> SystemAlerts {
        let mut spy = lock(&self.0);
        spy.calls.push("evaluate".into());
        spy.inputs.push((input.clone(), *settings));
        if spy.evaluate_panics {
            drop(spy);
            panic!("secret C:\\Users\\me");
        }
        match spy.real.as_mut() {
            Some(real) => real.evaluate(input, settings),
            None => spy.evaluate_result.clone(),
        }
    }

    fn reset(&mut self) {
        let mut spy = lock(&self.0);
        spy.calls.push("alerts.reset".into());
        if let Some(real) = spy.real.as_mut() {
            real.reset();
        }
    }
}

struct Fx {
    monitor: SystemMonitor,
    spy: Shared,
    clock: Arc<Clock>,
}

impl Fx {
    fn spy(&self) -> MutexGuard<'_, Spy> {
        lock(&self.spy)
    }

    fn count(&self, call: &str) -> usize {
        self.spy().calls.iter().filter(|c| *c == call).count()
    }

    /// `mockClear()` of the given spies.
    fn clear(&self, calls: &[&str]) {
        self.spy().calls.retain(|c| !calls.contains(&c.as_str()));
    }

    /// The calls among `names`, in order.
    fn order(&self, names: &[&str]) -> Vec<String> {
        self.spy()
            .calls
            .iter()
            .filter(|c| names.contains(&c.as_str()))
            .cloned()
            .collect()
    }

    fn last_top(&self) -> Option<String> {
        self.spy()
            .calls
            .iter()
            .rev()
            .find(|c| c.starts_with("top:"))
            .cloned()
    }

    fn metrics_out(&self) -> Vec<SystemMetrics> {
        self.spy().metrics_out.clone()
    }

    fn last_metrics(&self) -> Option<SystemMetrics> {
        self.spy().metrics_out.last().cloned()
    }

    fn processes_out(&self) -> Vec<Vec<ProcessRow>> {
        self.spy().processes_out.clone()
    }

    fn inputs(&self) -> Vec<AlertInput> {
        self.spy()
            .inputs
            .iter()
            .map(|(input, _)| input.clone())
            .collect()
    }

    fn settings_read(&self) -> usize {
        self.count("settings")
    }

    fn advance(&self, ms: u64) {
        self.clock.advance(ms);
    }

    /// Enters `system` and lets the first-time warm-up finish: the full rhythm is running.
    fn open_view(&self) {
        self.monitor.set_mode(NotchMode::System);
        self.advance(WARMUP_MS);
    }
}

fn setup() -> Fx {
    setup_with(true)
}

fn setup_with(available: bool) -> Fx {
    setup_with_executor(available, Arc::new(|job| job()))
}

fn setup_with_executor(available: bool, executor: Executor) -> Fx {
    // Installed before anything logs, so the log checks see every line.
    crate::services::test_log::capture().expect("the test logger");
    let spy: Shared = Arc::new(Mutex::new(Spy {
        calls: Vec::new(),
        light: light(),
        full: full(),
        disks: Some(disks()),
        light_panics: 0,
        full_panics: 0,
        evaluate_result: no_alerts(),
        evaluate_panics: false,
        settings_panics: false,
        real: None,
        inputs: Vec::new(),
        settings: default_alert_settings(),
        kill_result: KillResult::Killed,
        kills: Vec::new(),
        metrics_out: Vec::new(),
        processes_out: Vec::new(),
    }));
    let clock = Arc::new(Clock::new());
    let samplers = available.then(|| Samplers {
        metrics: Box::new(SpyMetrics(Arc::clone(&spy))) as Box<dyn Metrics>,
        processes: Box::new(SpyProcesses(Arc::clone(&spy))) as Box<dyn Processes>,
    });
    let monitor = SystemMonitor::new(MonitorOptions {
        samplers,
        alerts: Box::new(SpyAlerts(Arc::clone(&spy))),
        alert_settings: {
            let spy = Arc::clone(&spy);
            Box::new(move || {
                let mut spy = lock(&spy);
                spy.calls.push("settings".into());
                if spy.settings_panics {
                    drop(spy);
                    panic!("secret C:\\Users\\me");
                }
                spy.settings
            })
        },
        timers: Arc::clone(&clock) as Arc<dyn Timers>,
        now: {
            let clock = Arc::clone(&clock);
            Arc::new(move || clock.now.load(Ordering::SeqCst))
        },
        on_metrics: {
            let spy = Arc::clone(&spy);
            Box::new(move |metrics| lock(&spy).metrics_out.push(metrics.clone()))
        },
        on_processes: {
            let spy = Arc::clone(&spy);
            Box::new(move |rows| lock(&spy).processes_out.push(rows.to_vec()))
        },
        executor,
    });
    Fx {
        monitor,
        spy,
        clock,
    }
}

fn log_lines() -> Vec<String> {
    crate::services::test_log::capture()
        .expect("the test logger")
        .lines()
}

// --- rhythms ---

#[test]
fn light_modes_sample_at_once_and_then_every_3000_ms() {
    for mode in [
        NotchMode::Compact,
        NotchMode::Peek,
        NotchMode::Expanded,
        NotchMode::Reminders,
        NotchMode::Permission,
    ] {
        let fx = setup();
        fx.monitor.set_mode(mode);
        assert_eq!(fx.count("light"), 1, "{mode:?}");
        assert_eq!(fx.last_metrics(), Some(light_metrics(light())));
        fx.advance(2999);
        assert_eq!(fx.count("light"), 1);
        fx.advance(1);
        assert_eq!(fx.count("light"), 2);
        fx.advance(6000);
        assert_eq!(fx.count("light"), 4);
        assert_eq!(fx.count("full"), 0);
        assert_eq!(fx.last_top(), None);
    }
}

#[test]
fn does_not_restart_the_rhythm_when_the_mode_changes_within_the_light_rhythm() {
    let fx = setup();
    fx.monitor.set_mode(NotchMode::Compact);
    fx.advance(2000);
    fx.monitor.set_mode(NotchMode::Expanded);
    assert_eq!(fx.count("light"), 1);
    fx.advance(1000);
    assert_eq!(fx.count("light"), 2);
}

#[test]
fn keeps_sampling_in_peek_so_the_first_hover_into_compact_shows_current_values() {
    let fx = setup();
    fx.monitor.set_mode(NotchMode::Peek);
    fx.advance(LONG_PAUSE_MS * 3);
    let before = fx.count("light");
    assert!(before > 1);
    // The first start always takes a fresh baseline; resting in peek never does again.
    fx.clear(&["metrics.reset"]);
    fx.spy().metrics_out.clear();
    fx.monitor.set_mode(NotchMode::Compact);
    // No restart (the next sample keeps the 3 s rhythm) and no reset of the baseline.
    assert_eq!(fx.count("light"), before);
    assert_eq!(fx.count("metrics.reset"), 0);
    assert!(fx.metrics_out().is_empty());
    fx.monitor.set_mode(NotchMode::Peek);
    fx.advance(LIGHT_INTERVAL_MS);
    assert_eq!(fx.count("light"), before + 1);
}

#[test]
fn entering_system_mode_the_first_time_warms_up_silently_then_emits_full_and_processes() {
    let fx = setup();
    fx.monitor.set_mode(NotchMode::Compact);
    fx.spy().metrics_out.clear();
    fx.clear(&["light"]);
    fx.monitor.set_mode(NotchMode::System);
    // Baselines taken (CPU, PDH, per-process CPU) but nothing sent yet.
    assert_eq!(fx.count("full"), 1);
    assert_eq!(fx.count("top:cpu"), 1);
    assert!(fx.count("forget") > 0);
    assert!(fx.metrics_out().is_empty());
    assert!(fx.processes_out().is_empty());
    fx.advance(WARMUP_MS - 1);
    assert!(fx.metrics_out().is_empty());
    fx.advance(1);
    assert_eq!(fx.last_metrics(), Some(full_metrics(full())));
    assert_eq!(fx.processes_out().last(), Some(&vec![row(1)]));
    assert_eq!(fx.count("full"), 2);
    fx.advance(3000);
    assert_eq!(fx.count("full"), 5);
    assert_eq!(fx.count("top:cpu"), 5);
    assert_eq!(fx.count("light"), 0);
}

#[test]
fn a_quick_reopen_keeps_per_process_cpu_and_emits_at_once() {
    let fx = setup();
    fx.open_view();
    fx.monitor.set_mode(NotchMode::Expanded);
    fx.advance(LONG_PAUSE_MS - 1000);
    fx.clear(&["processes.reset", "forget"]);
    fx.spy().processes_out.clear();
    fx.monitor.set_mode(NotchMode::System);
    assert_eq!(fx.count("processes.reset"), 0);
    assert_eq!(fx.count("forget"), 1);
    assert_eq!(fx.processes_out().len(), 1);
    assert_eq!(fx.last_metrics(), Some(full_metrics(full())));
}

#[test]
fn a_reopen_after_a_long_close_resets_per_process_cpu_and_warms_up_again() {
    let fx = setup();
    fx.open_view();
    fx.monitor.set_mode(NotchMode::Expanded);
    fx.advance(LONG_PAUSE_MS);
    fx.spy().calls.clear();
    fx.spy().processes_out.clear();
    fx.monitor.set_mode(NotchMode::System);
    assert_eq!(
        fx.order(&["processes.reset", "top:cpu"]),
        ["processes.reset", "top:cpu"]
    );
    assert!(fx.processes_out().is_empty());
    fx.advance(WARMUP_MS);
    assert_eq!(fx.processes_out().len(), 1);
}

/// The app runs jobs on a worker thread: slow baselines (a cold PDH query, a long process list)
/// must not eat into the warm-up, or the first full tick comes less than the sampler's minimum CPU
/// interval after them and the first list shows no CPU values. The timer starts once they ran.
#[test]
fn the_warm_up_delay_starts_once_the_baselines_were_taken() {
    type Jobs = Arc<Mutex<Vec<Box<dyn FnOnce() + Send>>>>;
    let jobs: Jobs = Arc::new(Mutex::new(Vec::new()));
    let deferred = Arc::clone(&jobs);
    let fx = setup_with_executor(true, Arc::new(move |job| lock(&deferred).push(job)));
    let run_jobs = || loop {
        let next = lock(&jobs).pop();
        match next {
            Some(job) => job(),
            None => break,
        }
    };
    fx.monitor.set_mode(NotchMode::System);
    // The baselines are still queued when the warm-up delay would have run out.
    fx.advance(WARMUP_MS);
    run_jobs();
    assert_eq!(fx.count("top:cpu"), 1);
    assert!(fx.processes_out().is_empty());
    fx.advance(WARMUP_MS - 1);
    run_jobs();
    assert!(fx.processes_out().is_empty());
    fx.advance(1);
    run_jobs();
    assert_eq!(fx.processes_out().len(), 1);
    assert_eq!(fx.count("top:cpu"), 2);
}

/// A warm-up stopped while its baselines run never arms its timer.
#[test]
fn a_warm_up_stopped_before_its_baselines_ran_never_starts_the_full_rhythm() {
    type Jobs = Arc<Mutex<Vec<Box<dyn FnOnce() + Send>>>>;
    let jobs: Jobs = Arc::new(Mutex::new(Vec::new()));
    let deferred = Arc::clone(&jobs);
    let fx = setup_with_executor(true, Arc::new(move |job| lock(&deferred).push(job)));
    fx.monitor.set_mode(NotchMode::System);
    fx.monitor.set_mode(NotchMode::Mini);
    loop {
        let next = lock(&jobs).pop();
        match next {
            Some(job) => job(),
            None => break,
        }
    }
    fx.advance(WARMUP_MS * 2);
    assert!(fx.processes_out().is_empty());
    assert_eq!(fx.count("full"), 1);
}

#[test]
fn leaving_system_mode_during_the_warm_up_cancels_it() {
    let fx = setup();
    fx.monitor.set_mode(NotchMode::System);
    fx.monitor.set_mode(NotchMode::Expanded);
    fx.clear(&["full"]);
    fx.advance(WARMUP_MS * 2);
    assert_eq!(fx.count("full"), 0);
    assert_eq!(fx.last_metrics(), Some(light_metrics(light())));
}

#[test]
fn leaving_system_mode_drops_to_the_light_rhythm() {
    let fx = setup();
    fx.open_view();
    fx.clear(&["full"]);
    fx.monitor.set_mode(NotchMode::Expanded);
    fx.advance(3000);
    assert_eq!(fx.count("full"), 0);
    assert!(fx.count("light") > 0);
}

#[test]
fn a_new_order_sorts_the_next_emission_processes_at_once_metrics_untouched() {
    let fx = setup();
    fx.open_view();
    fx.clear(&["full"]);
    fx.monitor.set_order(ProcessOrder::Ram);
    assert_eq!(fx.last_top().as_deref(), Some("top:ram"));
    assert_eq!(fx.processes_out().last(), Some(&vec![row(2)]));
    assert_eq!(fx.count("full"), 0);
    fx.advance(1000);
    assert_eq!(fx.last_top().as_deref(), Some("top:ram"));
    assert_eq!(fx.count("full"), 1);
}

#[test]
fn the_same_order_again_does_not_re_emit() {
    let fx = setup();
    fx.open_view();
    fx.clear(&["top:cpu", "top:ram"]);
    fx.monitor.set_order(ProcessOrder::Cpu);
    assert_eq!(fx.last_top(), None);
}

#[test]
fn an_order_sent_before_system_mode_or_during_the_warm_up_is_used_by_the_first_emission() {
    let fx = setup();
    fx.monitor.set_order(ProcessOrder::Ram);
    assert_eq!(fx.last_top(), None);
    fx.monitor.set_mode(NotchMode::System);
    fx.monitor.set_order(ProcessOrder::Cpu);
    assert!(fx.processes_out().is_empty());
    fx.advance(WARMUP_MS);
    assert_eq!(fx.last_top().as_deref(), Some("top:cpu"));
    assert_eq!(fx.processes_out().len(), 1);
}

#[test]
fn the_order_survives_leaving_and_re_entering_system_mode() {
    let fx = setup();
    fx.open_view();
    fx.monitor.set_order(ProcessOrder::Ram);
    fx.monitor.set_mode(NotchMode::Expanded);
    fx.monitor.set_mode(NotchMode::System);
    assert_eq!(fx.last_top().as_deref(), Some("top:ram"));
}

#[test]
fn paused_modes_stop_every_timer_and_reset_the_cpu_baseline_after_a_long_pause() {
    for paused in [NotchMode::Mini, NotchMode::Hidden, NotchMode::Alert] {
        let fx = setup();
        fx.open_view();
        fx.clear(&["metrics.reset", "full", "light"]);
        fx.monitor.set_mode(paused);
        assert_eq!(fx.clock.count(), 0, "{paused:?}");
        fx.advance(LONG_PAUSE_MS);
        assert_eq!(fx.count("full"), 0);
        assert_eq!(fx.count("light"), 0);
        assert_eq!(fx.count("metrics.reset"), 0);

        fx.spy().calls.clear();
        // Back straight into 'system': fresh CPU baseline, fresh per-process CPU, silent warm-up.
        fx.monitor.set_mode(NotchMode::System);
        let names = ["metrics.reset", "processes.reset", "full"];
        assert_eq!(
            fx.order(&names),
            ["metrics.reset", "processes.reset", "full"]
        );
        fx.advance(WARMUP_MS);
        assert_eq!(
            fx.order(&names),
            ["metrics.reset", "processes.reset", "full", "full"]
        );
    }
}

#[test]
fn an_alert_over_a_hidden_capsule_samples_nothing() {
    let fx = setup();
    fx.monitor.set_mode(NotchMode::Hidden);
    fx.monitor.set_mode(NotchMode::Alert);
    fx.advance(6_000);
    fx.monitor.set_mode(NotchMode::Hidden);
    fx.advance(LONG_PAUSE_MS);
    assert_eq!(fx.clock.count(), 0);
    assert_eq!(fx.count("light"), 0);
    assert_eq!(fx.count("full"), 0);
    assert_eq!(fx.last_top(), None);
}

#[test]
fn a_short_pause_keeps_the_cpu_baseline_and_resumes_light_at_once() {
    let fx = setup();
    fx.monitor.set_mode(NotchMode::Compact);
    fx.clear(&["metrics.reset"]);
    fx.monitor.set_mode(NotchMode::Alert);
    fx.advance(9_999);
    fx.clear(&["light"]);
    fx.monitor.set_mode(NotchMode::Compact);
    assert_eq!(fx.count("metrics.reset"), 0);
    assert_eq!(fx.count("processes.reset"), 0);
    assert_eq!(fx.count("light"), 1);
}

#[test]
fn a_pause_of_10_s_or_more_resets_the_cpu_baseline_before_the_first_tick() {
    let fx = setup();
    fx.monitor.set_mode(NotchMode::Compact);
    fx.clear(&["metrics.reset"]);
    fx.monitor.set_mode(NotchMode::Mini);
    fx.advance(10_000);
    fx.spy().calls.clear();
    fx.monitor.set_mode(NotchMode::Compact);
    assert_eq!(
        fx.order(&["metrics.reset", "light"]),
        ["metrics.reset", "light"]
    );
}

#[test]
fn resync_samples_at_once_when_running_and_stays_quiet_when_paused() {
    let fx = setup();
    fx.monitor.set_mode(NotchMode::Compact);
    fx.advance(1000);
    fx.clear(&["light"]);
    fx.monitor.resync();
    assert_eq!(fx.count("light"), 1);
    // The 3 s rhythm restarts from the resync sample.
    fx.advance(2999);
    assert_eq!(fx.count("light"), 1);
    fx.monitor.set_mode(NotchMode::Hidden);
    fx.clear(&["light"]);
    fx.monitor.resync();
    assert_eq!(fx.count("light"), 0);
    assert_eq!(fx.clock.count(), 0);
}

#[test]
fn never_samples_while_starting_in_a_paused_mode() {
    let fx = setup();
    fx.monitor.set_mode(NotchMode::Hidden);
    fx.advance(10_000);
    assert_eq!(fx.count("light"), 0);
    assert_eq!(fx.clock.count(), 0);
}

#[test]
fn dispose_cancels_everything_the_warm_up_included() {
    let fx = setup();
    fx.monitor.set_mode(NotchMode::System);
    fx.monitor.dispose();
    assert_eq!(fx.clock.count(), 0);
    fx.clear(&["full", "light"]);
    fx.monitor.set_mode(NotchMode::Compact);
    fx.monitor.set_order(ProcessOrder::Ram);
    fx.advance(10_000);
    assert_eq!(fx.count("full"), 0);
    assert_eq!(fx.count("light"), 0);
}

#[test]
fn a_failing_sample_is_logged_without_details_and_the_rhythm_continues() {
    let fx = setup();
    fx.spy().light_panics = 1;
    fx.monitor.set_mode(NotchMode::Compact);
    fx.advance(3000);
    assert_eq!(fx.count("light"), 2);
    let lines = log_lines();
    assert!(!lines.iter().any(|line| line.contains("chrome")));
    assert!(lines
        .iter()
        .any(|line| line.starts_with("ERROR") && line.contains("System sample failed: light")));
}

#[test]
fn fails_open_when_the_evaluator_or_the_alert_settings_panic() {
    for which in ["evaluate", "settings"] {
        let fx = setup();
        if which == "evaluate" {
            fx.spy().evaluate_panics = true;
        } else {
            fx.spy().settings_panics = true;
        }
        fx.monitor.set_mode(NotchMode::Compact);
        assert_eq!(fx.metrics_out(), [light_metrics(light())], "{which}");
        fx.open_view();
        assert_eq!(fx.last_metrics(), Some(full_metrics(full())));
        let lines = log_lines();
        assert!(!lines.iter().any(|line| line.contains("secret")));
        assert!(lines
            .iter()
            .any(|line| line.starts_with("ERROR") && line.contains("Alert evaluation failed")));
    }
}

#[test]
fn a_failing_warm_up_still_starts_the_full_rhythm() {
    let fx = setup();
    fx.spy().full_panics = 1;
    fx.monitor.set_mode(NotchMode::System);
    fx.advance(WARMUP_MS);
    assert_eq!(fx.last_metrics(), Some(full_metrics(full())));
}

// --- alerts ---

#[test]
fn every_light_sample_carries_the_evaluator_result_built_from_the_sample() {
    let fx = setup();
    let flagged = SystemAlerts {
        cpu: true,
        ram: false,
        battery: true,
        disk: Some(crate::contract::system::DiskAlert {
            letter: "C".into(),
            free_percent: 4.0,
        }),
    };
    {
        let mut spy = fx.spy();
        spy.evaluate_result = flagged.clone();
        spy.light = MetricsLight {
            cpu_percent: Some(91.0),
            ram: Some(RamSample {
                used_bytes: 2.0,
                total_bytes: 3.0,
            }),
            battery: Some(crate::contract::system::BatterySample {
                percent: 12.0,
                charging: false,
                plugged_in: false,
                seconds_left: Some(60),
            }),
        };
    }
    fx.monitor.set_mode(NotchMode::Compact);
    fx.advance(3000);
    let first = &fx.inputs()[0];
    assert_eq!(first.cpu_percent, Some(91.0));
    assert_eq!(first.ram_percent, Some(67.0));
    assert_eq!(
        first.battery,
        Some(BatteryInput {
            percent: 12.0,
            plugged_in: false
        })
    );
    assert_eq!(first.disks, Some(disks()));
    // Each sample owns its alerts (a Rust value is never shared between samples).
    let sent: Vec<SystemAlerts> = fx
        .metrics_out()
        .into_iter()
        .map(|metrics| match metrics {
            SystemMetrics::Light(LightSample { alerts, .. }) => alerts,
            other => panic!("unexpected {other:?}"),
        })
        .collect();
    assert_eq!(sent, [flagged.clone(), flagged]);
}

#[test]
fn passes_null_ram_and_battery_percent_when_the_sample_has_none() {
    let fx = setup();
    fx.spy().light = MetricsLight {
        cpu_percent: None,
        ram: None,
        battery: None,
    };
    fx.monitor.set_mode(NotchMode::Compact);
    let first = &fx.inputs()[0];
    assert_eq!(first.cpu_percent, None);
    assert_eq!(first.ram_percent, None);
    assert_eq!(first.battery, None);
}

#[test]
fn reads_disk_space_on_the_first_light_tick_and_then_every_60000_ms_passing_null_between() {
    let fx = setup();
    fx.monitor.set_mode(NotchMode::Compact);
    assert_eq!(fx.count("disks"), 1);
    fx.advance(57_000);
    assert_eq!(fx.count("disks"), 1);
    let inputs = fx.inputs();
    assert!(inputs[1..].iter().all(|input| input.disks.is_none()));
    assert_eq!(inputs.len(), 20);
    fx.advance(3000);
    assert_eq!(fx.count("disks"), 2);
    assert_eq!(fx.inputs().last().unwrap().disks, Some(disks()));
    fx.advance(3000);
    assert_eq!(fx.inputs().last().unwrap().disks, None);
}

#[test]
fn a_resync_within_the_light_rhythm_does_not_re_read_disk_space_early() {
    let fx = setup();
    fx.monitor.set_mode(NotchMode::Compact);
    fx.advance(1000);
    fx.monitor.resync();
    assert_eq!(fx.count("disks"), 1);
}

#[test]
fn the_full_rhythm_feeds_the_full_sample_disks_as_free_percent_and_never_calls_disks() {
    let fx = setup();
    fx.spy().full = MetricsFull {
        disks: vec![
            crate::contract::system::DiskSample {
                letter: "C".into(),
                used_percent: 93.0,
                free_bytes: 7.0,
                activity_percent: None,
            },
            crate::contract::system::DiskSample {
                letter: "D".into(),
                used_percent: 10.0,
                free_bytes: 90.0,
                activity_percent: Some(5.0),
            },
        ],
        ..full()
    };
    fx.open_view();
    fx.advance(1000);
    assert_eq!(fx.count("disks"), 0);
    let inputs = fx.inputs();
    assert_eq!(inputs.len(), 2);
    let expected = vec![
        DiskFree {
            letter: "C".into(),
            free_percent: 7.0,
        },
        DiskFree {
            letter: "D".into(),
            free_percent: 90.0,
        },
    ];
    for input in inputs {
        assert_eq!(input.disks.as_ref(), Some(&expected));
    }
    assert!(fx
        .metrics_out()
        .iter()
        .all(|metrics| matches!(metrics, SystemMetrics::Full(FullSample { .. }))));
}

#[test]
fn the_silent_warm_up_sample_is_not_evaluated() {
    let fx = setup();
    fx.monitor.set_mode(NotchMode::System);
    assert_eq!(fx.count("full"), 1);
    assert_eq!(fx.count("evaluate"), 0);
    fx.advance(WARMUP_MS);
    assert_eq!(fx.count("evaluate"), 1);
}

#[test]
fn back_to_light_after_the_view_reads_disk_space_again_on_its_first_tick() {
    let fx = setup();
    fx.monitor.set_mode(NotchMode::Compact);
    fx.advance(3000);
    fx.monitor.set_mode(NotchMode::System);
    fx.advance(WARMUP_MS + 2000);
    fx.monitor.set_mode(NotchMode::Compact);
    assert_eq!(fx.count("disks"), 2);
    assert_eq!(fx.inputs().last().unwrap().disks, Some(disks()));
}

#[test]
fn resets_the_evaluator_on_the_first_start_and_after_a_long_pause_before_the_first_tick() {
    let fx = setup();
    let names = ["alerts.reset", "evaluate"];
    fx.monitor.set_mode(NotchMode::Compact);
    assert_eq!(fx.order(&names), ["alerts.reset", "evaluate"]);
    fx.monitor.set_mode(NotchMode::Alert);
    fx.advance(LONG_PAUSE_MS);
    fx.spy().calls.clear();
    fx.monitor.set_mode(NotchMode::Compact);
    assert_eq!(fx.order(&names), ["alerts.reset", "evaluate"]);
    // A restart re-reads disk space at once.
    assert_eq!(fx.count("disks"), 1);
}

#[test]
fn a_short_pause_keeps_the_evaluator_state() {
    let fx = setup();
    fx.monitor.set_mode(NotchMode::Compact);
    fx.clear(&["alerts.reset"]);
    fx.monitor.set_mode(NotchMode::Mini);
    fx.advance(LONG_PAUSE_MS - 1);
    fx.monitor.set_mode(NotchMode::Compact);
    assert_eq!(fx.count("alerts.reset"), 0);
}

#[test]
fn reads_the_alert_settings_on_every_tick() {
    let fx = setup();
    fx.monitor.set_mode(NotchMode::Compact);
    let mut changed = default_alert_settings();
    changed.ram.percent = 60;
    fx.spy().settings = changed;
    fx.advance(3000);
    assert_eq!(fx.settings_read(), 2);
    let spy = fx.spy();
    assert_eq!(spy.inputs[0].1.ram.percent, 90);
    assert_eq!(spy.inputs[1].1.ram.percent, 60);
}

#[test]
fn works_end_to_end_with_the_real_evaluator() {
    let fx = setup();
    {
        let mut spy = fx.spy();
        spy.real = Some(AlertEvaluator::new());
        spy.light = MetricsLight {
            cpu_percent: Some(5.0),
            ram: Some(RamSample {
                used_bytes: 95.0,
                total_bytes: 100.0,
            }),
            battery: None,
        };
        spy.disks = Some(vec![DiskFree {
            letter: "D".into(),
            free_percent: 3.0,
        }]);
    }
    fx.monitor.set_mode(NotchMode::Compact);
    fx.advance(3000);
    assert_eq!(
        fx.last_metrics(),
        Some(SystemMetrics::Light(LightSample {
            cpu_percent: Some(5.0),
            ram: Some(RamSample {
                used_bytes: 95.0,
                total_bytes: 100.0
            }),
            battery: None,
            alerts: SystemAlerts {
                cpu: false,
                ram: true,
                battery: false,
                disk: Some(crate::contract::system::DiskAlert {
                    letter: "D".into(),
                    free_percent: 3.0
                }),
            },
        }))
    );
}

// --- kill ---

#[test]
fn kill_forwards_to_the_sampler_and_refreshes_at_once_after_a_kill() {
    // TS uses pid 1234; a more distinctive pid keeps the log check meaningful across the binary.
    let fx = setup();
    fx.open_view();
    fx.clear(&["full", "top:cpu"]);
    let input = KillInput {
        pid: 4_242_421,
        start_time: "t".into(),
    };
    assert_eq!(fx.monitor.kill(&input), KillResult::Killed);
    assert_eq!(fx.spy().kills, [input]);
    assert_eq!(fx.count("full"), 1);
    assert_eq!(fx.count("top:cpu"), 1);
    // The 1 s rhythm restarts from the kill refresh.
    fx.advance(999);
    assert_eq!(fx.count("full"), 1);
    fx.advance(1);
    assert_eq!(fx.count("full"), 2);
    let lines = log_lines();
    assert!(lines
        .iter()
        .any(|line| line.contains("Process close requested: killed")));
    assert!(!lines.iter().any(|line| line.contains("4242421")));
    assert!(!lines.iter().any(|line| line.contains("x.exe")));
}

#[test]
fn kill_does_not_refresh_when_the_close_did_not_happen() {
    let fx = setup();
    fx.open_view();
    fx.clear(&["full"]);
    fx.spy().kill_result = KillResult::Denied;
    let input = KillInput {
        pid: 5,
        start_time: "t".into(),
    };
    assert_eq!(fx.monitor.kill(&input), KillResult::Denied);
    assert_eq!(fx.count("full"), 0);
}

// --- without SystemApi ---

#[test]
fn without_system_api_emits_unavailable_once_and_never_arms_a_timer() {
    let fx = setup_with(false);
    for mode in [
        NotchMode::Compact,
        NotchMode::System,
        NotchMode::Mini,
        NotchMode::Expanded,
    ] {
        fx.monitor.set_mode(mode);
    }
    fx.advance(10_000);
    assert_eq!(
        fx.metrics_out(),
        [SystemMetrics::Unavailable(Unavailable {})]
    );
    assert!(fx.processes_out().is_empty());
    assert_eq!(fx.clock.count(), 0);
}

#[test]
fn without_system_api_re_emits_unavailable_when_the_view_sends_its_order_or_the_notch_reloads() {
    let fx = setup_with(false);
    fx.monitor.set_order(ProcessOrder::Cpu);
    fx.monitor.resync();
    assert_eq!(fx.metrics_out().len(), 3);
    assert_eq!(
        fx.last_metrics(),
        Some(SystemMetrics::Unavailable(Unavailable {}))
    );
    let input = KillInput {
        pid: 1,
        start_time: "t".into(),
    };
    assert_eq!(fx.monitor.kill(&input), KillResult::NotKillable);
}

// --- threading (Rust only) ---

#[test]
fn an_interval_tick_is_skipped_while_another_tick_is_still_queued() {
    // A deferred executor: drains wait until the test runs them (a slow worker). The fixture
    // only lends its spy and clock to this second monitor.
    let deferred: Deferred = Arc::new(Mutex::new(Vec::new()));
    let fx = setup();
    let spy = Arc::clone(&fx.spy);
    let clock = Arc::clone(&fx.clock);
    let monitor = SystemMonitor::new(MonitorOptions {
        samplers: Some(Samplers {
            metrics: Box::new(SpyMetrics(Arc::clone(&spy))),
            processes: Box::new(SpyProcesses(Arc::clone(&spy))),
        }),
        alerts: Box::new(SpyAlerts(Arc::clone(&spy))),
        alert_settings: Box::new(default_alert_settings),
        timers: Arc::clone(&clock) as Arc<dyn Timers>,
        now: {
            let clock = Arc::clone(&clock);
            Arc::new(move || clock.now.load(Ordering::SeqCst))
        },
        on_metrics: Box::new(|_| {}),
        on_processes: Box::new(|_| {}),
        executor: {
            let jobs = Arc::clone(&deferred);
            Arc::new(move |job| lock(&jobs).push(job))
        },
    });
    monitor.set_mode(NotchMode::Compact);
    // Nothing ran on the caller's thread: the first tick is queued for the worker.
    assert_eq!(fx.count("light"), 0);
    // Three interval periods pass while the worker is stuck: no tick piles up behind it.
    clock.advance(LIGHT_INTERVAL_MS * 3);
    let drains: Vec<_> = lock(&deferred).drain(..).collect();
    assert_eq!(drains.len(), 1);
    for drain in drains {
        drain();
    }
    assert_eq!(fx.count("light"), 1);
    // Once the worker caught up the rhythm resumes.
    clock.advance(LIGHT_INTERVAL_MS);
    let drains: Vec<_> = lock(&deferred).drain(..).collect();
    for drain in drains {
        drain();
    }
    assert_eq!(fx.count("light"), 2);
}

/// A monitor sharing the fixture's spy (its emissions land in `metrics_out` / `processes_out`)
/// with its own timers, clock and executor.
fn monitor_with(
    spy: &Shared,
    timers: Arc<dyn Timers>,
    now: MonotonicClock,
    executor: Executor,
) -> SystemMonitor {
    SystemMonitor::new(MonitorOptions {
        samplers: Some(Samplers {
            metrics: Box::new(SpyMetrics(Arc::clone(spy))),
            processes: Box::new(SpyProcesses(Arc::clone(spy))),
        }),
        alerts: Box::new(SpyAlerts(Arc::clone(spy))),
        alert_settings: Box::new(default_alert_settings),
        timers,
        now,
        on_metrics: {
            let spy = Arc::clone(spy);
            Box::new(move |metrics| lock(&spy).metrics_out.push(metrics.clone()))
        },
        on_processes: {
            let spy = Arc::clone(spy);
            Box::new(move |rows| lock(&spy).processes_out.push(rows.to_vec()))
        },
        executor,
    })
}

fn deferred_executor(deferred: &Deferred) -> Executor {
    let jobs = Arc::clone(deferred);
    Arc::new(move |job| lock(&jobs).push(job))
}

/// Runs the worker until nothing is queued; returns how many drains ran.
fn run_deferred(deferred: &Deferred) -> usize {
    let mut ran = 0;
    loop {
        let drains: Vec<_> = lock(deferred).drain(..).collect();
        if drains.is_empty() {
            return ran;
        }
        for drain in drains {
            drain();
            ran += 1;
        }
    }
}

#[test]
fn a_light_tick_queued_before_the_view_opens_does_not_become_a_full_sample() {
    let deferred: Deferred = Arc::new(Mutex::new(Vec::new()));
    let fx = setup();
    let clock = Arc::clone(&fx.clock);
    let monitor = monitor_with(
        &fx.spy,
        Arc::clone(&clock) as Arc<dyn Timers>,
        {
            let clock = Arc::clone(&clock);
            Arc::new(move || clock.now.load(Ordering::SeqCst))
        },
        deferred_executor(&deferred),
    );
    // A light tick is queued behind a slow worker when the System view opens on stale data.
    monitor.set_mode(NotchMode::Compact);
    monitor.set_mode(NotchMode::System);
    run_deferred(&deferred);
    // Only the silent warm-up sampled: the stale light tick did not run as a full sample with
    // stale baselines, and nothing reached the view before the warm-up.
    assert_eq!(fx.count("light"), 0);
    assert_eq!(fx.count("full"), 1);
    assert!(fx.metrics_out().is_empty());
    assert!(fx.processes_out().is_empty());
    // The warm-up then starts the full rhythm as usual.
    clock.advance(WARMUP_MS);
    run_deferred(&deferred);
    assert_eq!(fx.count("full"), 2);
    assert_eq!(fx.metrics_out().len(), 1);
}

/// Timers whose `clear` comes too late: the callback was already in flight, so the test can
/// still run it by hand.
struct LateTimers {
    ids: TestTimers,
    callbacks: Mutex<Vec<(u64, TimerCallback)>>,
}

impl LateTimers {
    fn new() -> Self {
        Self {
            ids: TestTimers::new(),
            callbacks: Mutex::new(Vec::new()),
        }
    }

    /// Takes every armed callback of `ms`, in arming order.
    fn take(&self, ms: u64) -> Vec<TimerCallback> {
        let mut callbacks = lock(&self.callbacks);
        let (taken, kept): (Vec<_>, Vec<_>) = callbacks.drain(..).partition(|(at, _)| *at == ms);
        *callbacks = kept;
        taken.into_iter().map(|(_, f)| f).collect()
    }
}

impl Timers for LateTimers {
    fn set_timeout(&self, ms: u64, f: TimerCallback) -> TimerId {
        lock(&self.callbacks).push((ms, f));
        self.ids.set_timeout(ms, Box::new(|| {}))
    }

    fn clear(&self, _id: TimerId) {}
}

#[test]
fn a_stale_warm_up_callback_does_not_cut_a_newer_warm_up_short() {
    let fx = setup();
    let timers = Arc::new(LateTimers::new());
    let now = Arc::new(AtomicU64::new(0));
    let monitor = monitor_with(
        &fx.spy,
        Arc::clone(&timers) as Arc<dyn Timers>,
        {
            let now = Arc::clone(&now);
            Arc::new(move || now.load(Ordering::SeqCst))
        },
        Arc::new(|job| job()),
    );
    // First warm-up: its timer is armed, then the view closes before it fires.
    monitor.set_mode(NotchMode::System);
    let mut first = timers.take(WARMUP_MS);
    assert_eq!(first.len(), 1);
    monitor.set_mode(NotchMode::Compact);
    // Long enough later the view opens again on stale data: a second warm-up.
    now.fetch_add(LONG_PAUSE_MS, Ordering::SeqCst);
    monitor.set_mode(NotchMode::System);
    let mut second = timers.take(WARMUP_MS);
    assert_eq!(second.len(), 1);
    let fulls = fx.count("full");
    // The first warm-up's callback was already in flight: it must not start the rhythm now,
    // only 0 ms into the second warm-up.
    (first.remove(0))();
    assert_eq!(fx.count("full"), fulls);
    assert_eq!(fx.count("top:cpu"), 2);
    // The current warm-up's callback starts the full rhythm.
    (second.remove(0))();
    assert_eq!(fx.count("full"), fulls + 1);
}

#[test]
fn a_tick_that_panics_outside_the_sample_guard_does_not_stop_later_ticks() {
    let deferred: Deferred = Arc::new(Mutex::new(Vec::new()));
    let fx = setup();
    let clock = Arc::clone(&fx.clock);
    let clock_panics = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let monitor = monitor_with(
        &fx.spy,
        Arc::clone(&clock) as Arc<dyn Timers>,
        {
            let clock = Arc::clone(&clock);
            let clock_panics = Arc::clone(&clock_panics);
            Arc::new(move || {
                assert!(!clock_panics.load(Ordering::SeqCst), "clock");
                clock.now.load(Ordering::SeqCst)
            })
        },
        deferred_executor(&deferred),
    );
    monitor.set_mode(NotchMode::Compact);
    // The tick's clock read panics (outside the per-sample guards).
    clock_panics.store(true, Ordering::SeqCst);
    run_deferred(&deferred);
    clock_panics.store(false, Ordering::SeqCst);
    assert_eq!(fx.count("light"), 0);
    // The next interval tick still runs.
    clock.advance(LIGHT_INTERVAL_MS);
    run_deferred(&deferred);
    assert_eq!(fx.count("light"), 1);
}
