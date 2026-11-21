//! Port of 0.1.0's `system-monitor.test.ts`, light rhythm only (the System view's full rhythm,
//! warm-up, process order and close went with the view). The vitest fake timers become
//! [`TestTimers`] moved one millisecond at a time (so an interval fires as often as in vitest),
//! wrapped to count the armed timers (`vi.getTimerCount()`); the executor runs jobs inline, so
//! every sample happens synchronously as in the single-threaded TS. "Throws" is a panicking spy.

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};

use super::*;
use crate::contract::system::{LightSample, RamSample, StorageSample};
use crate::services::timers::{TestTimers, TimerCallback, TimerId};
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
        online: Some(true),
    }
}

/// One fixed drive read with `free_bytes` of `total_bytes` free.
fn drive(letter: &str, free_bytes: u64, total_bytes: u64) -> DiskFree {
    DiskFree {
        letter: letter.into(),
        free_percent: 100.0 * free_bytes as f64 / total_bytes as f64,
        free_bytes,
        total_bytes,
    }
}

fn disks() -> Vec<DiskFree> {
    vec![drive("C", 40, 100)]
}

fn no_alerts() -> SystemAlerts {
    SystemAlerts::default()
}

fn storage(used_percent: f64) -> Option<StorageSample> {
    Some(StorageSample { used_percent })
}

/// A light sample as emitted with the default [`disks`] reading (C: 40 % free).
fn light_metrics(sample: MetricsLight) -> SystemMetrics {
    SystemMetrics::Light(sample.with_alerts(no_alerts(), storage(60.0)))
}

fn storage_out(metrics: &SystemMetrics) -> Option<StorageSample> {
    match metrics {
        SystemMetrics::Light(sample) => sample.storage.clone(),
        SystemMetrics::Unavailable(_) => panic!("unexpected unavailable"),
    }
}

fn default_alert_settings() -> SystemAlertSettings {
    default_settings("en").system_alerts
}

struct Spy {
    calls: Vec<String>,
    light: MetricsLight,
    disks: Option<Vec<DiskFree>>,
    light_panics: usize,
    evaluate_result: SystemAlerts,
    evaluate_panics: bool,
    settings_panics: bool,
    real: Option<AlertEvaluator>,
    inputs: Vec<(AlertInput, SystemAlertSettings)>,
    settings: SystemAlertSettings,
    metrics_out: Vec<SystemMetrics>,
}

type Shared = Arc<Mutex<Spy>>;
type Deferred = Arc<Mutex<Vec<Box<dyn FnOnce() + Send>>>>;

fn record(spy: &Shared, call: impl Into<String>) {
    lock(spy).calls.push(call.into());
}

struct SpyMetrics(Shared);
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

    fn disks(&mut self) -> Option<Vec<DiskFree>> {
        let mut spy = lock(&self.0);
        spy.calls.push("disks".into());
        spy.disks.clone()
    }

    fn reset(&mut self) {
        record(&self.0, "metrics.reset");
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

    fn metrics_out(&self) -> Vec<SystemMetrics> {
        self.spy().metrics_out.clone()
    }

    fn last_metrics(&self) -> Option<SystemMetrics> {
        self.spy().metrics_out.last().cloned()
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
        disks: Some(disks()),
        light_panics: 0,
        evaluate_result: no_alerts(),
        evaluate_panics: false,
        settings_panics: false,
        real: None,
        inputs: Vec::new(),
        settings: default_alert_settings(),
        metrics_out: Vec::new(),
    }));
    let clock = Arc::new(Clock::new());
    let metrics = available.then(|| Box::new(SpyMetrics(Arc::clone(&spy))) as Box<dyn Metrics>);
    let monitor = SystemMonitor::new(MonitorOptions {
        metrics,
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
fn paused_modes_stop_every_timer_and_reset_the_cpu_baseline_after_a_long_pause() {
    for paused in [NotchMode::Mini, NotchMode::Hidden, NotchMode::Alert] {
        let fx = setup();
        fx.monitor.set_mode(NotchMode::Expanded);
        fx.clear(&["metrics.reset", "light"]);
        fx.monitor.set_mode(paused);
        assert_eq!(fx.clock.count(), 0, "{paused:?}");
        fx.advance(LONG_PAUSE_MS);
        assert_eq!(fx.count("light"), 0);
        assert_eq!(fx.count("metrics.reset"), 0);

        fx.spy().calls.clear();
        // Back into a panel: fresh CPU baseline, then a light sample at once.
        fx.monitor.set_mode(NotchMode::Expanded);
        assert_eq!(
            fx.order(&["metrics.reset", "light"]),
            ["metrics.reset", "light"]
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
        fx.advance(LIGHT_INTERVAL_MS);
        assert_eq!(fx.metrics_out().len(), 2, "{which}");
        let lines = log_lines();
        assert!(!lines.iter().any(|line| line.contains("secret")));
        assert!(lines
            .iter()
            .any(|line| line.starts_with("ERROR") && line.contains("Alert evaluation failed")));
    }
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
            online: None,
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
        online: None,
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
fn light_sample_carries_the_whole_computer_storage_weighted_by_size() {
    let fx = setup();
    // C: 40 of 100 free, D: 100 of 1000 free -> 960 used of 1100, not the worst drive's 90 %.
    fx.spy().disks = Some(vec![drive("C", 40, 100), drive("D", 100, 1000)]);
    fx.monitor.set_mode(NotchMode::Compact);
    assert_eq!(
        fx.last_metrics().as_ref().map(storage_out),
        Some(storage(100.0 * 960.0 / 1100.0))
    );
}

#[test]
fn storage_ignores_drives_without_size_and_never_counts_more_free_than_total() {
    let fx = setup();
    fx.spy().disks = Some(vec![
        drive("C", 25, 100),
        DiskFree {
            letter: "D".into(),
            free_percent: 100.0,
            free_bytes: 0,
            total_bytes: 0,
        },
        DiskFree {
            letter: "E".into(),
            free_percent: 100.0,
            free_bytes: 500,
            total_bytes: 100,
        },
    ]);
    fx.monitor.set_mode(NotchMode::Compact);
    assert_eq!(
        fx.last_metrics().as_ref().map(storage_out),
        Some(storage(75.0 / 2.0))
    );
}

#[test]
fn storage_is_null_when_every_drive_reads_size_0() {
    let fx = setup();
    fx.spy().disks = Some(vec![DiskFree {
        letter: "C".into(),
        free_percent: 100.0,
        free_bytes: 0,
        total_bytes: 0,
    }]);
    fx.monitor.set_mode(NotchMode::Compact);
    assert_eq!(fx.last_metrics().as_ref().map(storage_out), Some(None));
}

#[test]
fn storage_is_kept_between_disk_reads() {
    let fx = setup();
    fx.monitor.set_mode(NotchMode::Compact);
    fx.advance(3000);
    assert_eq!(fx.count("disks"), 1);
    let sent: Vec<_> = fx.metrics_out().iter().map(storage_out).collect();
    assert_eq!(sent, [storage(60.0), storage(60.0)]);
    // A failed read (`None`) keeps the last value too.
    fx.spy().disks = None;
    fx.advance(57_000);
    assert_eq!(fx.count("disks"), 2);
    assert_eq!(
        fx.last_metrics().as_ref().map(storage_out),
        Some(storage(60.0))
    );
}

#[test]
fn storage_is_null_without_a_reading() {
    for reading in [None, Some(Vec::new())] {
        let fx = setup();
        fx.spy().disks = reading.clone();
        fx.monitor.set_mode(NotchMode::Compact);
        fx.advance(3000);
        assert!(
            fx.metrics_out().iter().all(|m| storage_out(m).is_none()),
            "{reading:?}"
        );
    }
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
            online: Some(false),
        };
        spy.disks = Some(vec![drive("D", 3, 100)]);
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
            storage: storage(97.0),
            online: Some(false),
        }))
    );
}

// --- without SystemApi ---

#[test]
fn without_system_api_emits_unavailable_once_and_never_arms_a_timer() {
    let fx = setup_with(false);
    for mode in [
        NotchMode::Compact,
        NotchMode::Notes,
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
    assert_eq!(fx.clock.count(), 0);
}

#[test]
fn without_system_api_re_emits_unavailable_when_the_notch_reloads() {
    let fx = setup_with(false);
    fx.monitor.resync();
    assert_eq!(fx.metrics_out().len(), 2);
    assert_eq!(
        fx.last_metrics(),
        Some(SystemMetrics::Unavailable(Unavailable {}))
    );
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
        metrics: Some(Box::new(SpyMetrics(Arc::clone(&spy)))),
        alerts: Box::new(SpyAlerts(Arc::clone(&spy))),
        alert_settings: Box::new(default_alert_settings),
        timers: Arc::clone(&clock) as Arc<dyn Timers>,
        now: {
            let clock = Arc::clone(&clock);
            Arc::new(move || clock.now.load(Ordering::SeqCst))
        },
        on_metrics: Box::new(|_| {}),
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

/// A monitor sharing the fixture's spy (its emissions land in `metrics_out`)
/// with its own timers, clock and executor.
fn monitor_with(
    spy: &Shared,
    timers: Arc<dyn Timers>,
    now: MonotonicClock,
    executor: Executor,
) -> SystemMonitor {
    SystemMonitor::new(MonitorOptions {
        metrics: Some(Box::new(SpyMetrics(Arc::clone(spy)))),
        alerts: Box::new(SpyAlerts(Arc::clone(spy))),
        alert_settings: Box::new(default_alert_settings),
        timers,
        now,
        on_metrics: {
            let spy = Arc::clone(spy);
            Box::new(move |metrics| lock(&spy).metrics_out.push(metrics.clone()))
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
