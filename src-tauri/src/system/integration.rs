//! Port of 0.1.0's `system-integration.ts`: the adapter that owns the monitor. It exists from
//! `setup`; the Win32 API and the monitor are only built by [`SystemIntegration::start`], off the
//! startup path, which then applies the current notch mode. There are no channels: the System
//! view (its process order and its close-process request) was removed, and the metrics only go
//! out as the `system:metrics` event.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use super::alerts::AlertEvaluator;
use super::metrics::MetricsSampler;
use super::monitor::{
    AlertSettingsSource, Executor, MetricsSink, MonitorOptions, MonotonicClock, SystemMonitor,
};
use super::SystemApi;
use crate::contract::notch::NotchMode;
use crate::services::timers::Timers;

/// What [`SystemIntegration::start`] builds the monitor from.
pub struct StartOptions {
    /// `None` when the Win32 API could not load: the monitor only reports `unavailable`.
    pub api: Option<Arc<dyn SystemApi>>,
    pub timers: Arc<dyn Timers>,
    /// Monotonic: a wall-clock change must never stretch or shrink a pause (the CPU baseline
    /// and the alert windows reset after a long one).
    pub now: MonotonicClock,
    pub executor: Executor,
    /// The live alert settings (read on every sample, so a change applies to the next one).
    pub alert_settings: AlertSettingsSource,
    /// The notch window only (skipped while it does not exist).
    pub on_metrics: MetricsSink,
}

#[derive(Default)]
struct Started {
    monitor: Option<Arc<SystemMonitor>>,
}

/// The adapter around the monitor (`createSystemIntegration`).
#[derive(Default)]
pub struct SystemIntegration {
    started: Mutex<Started>,
    disposed: AtomicBool,
}

impl SystemIntegration {
    pub fn new() -> Self {
        Self::default()
    }

    fn started(&self) -> MutexGuard<'_, Started> {
        self.started.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn monitor(&self) -> Option<Arc<SystemMonitor>> {
        self.started().monitor.clone()
    }

    /// Builds the sampler and the monitor and starts sampling for `mode()` (read once the monitor
    /// exists). Run it off the main thread.
    pub fn start(&self, options: StartOptions, mode: impl FnOnce() -> NotchMode) {
        if self.disposed.load(Ordering::SeqCst) {
            return;
        }
        let StartOptions {
            api,
            timers,
            now,
            executor,
            alert_settings,
            on_metrics,
        } = options;
        if api.is_none() {
            log::warn!("System monitor unavailable");
        }
        let metrics = api.map(|api| Box::new(MetricsSampler::new(api)) as _);
        let monitor = Arc::new(SystemMonitor::new(MonitorOptions {
            metrics,
            alerts: Box::new(AlertEvaluator::new()),
            alert_settings,
            timers,
            now,
            on_metrics,
            executor,
        }));
        {
            let mut started = self.started();
            if self.disposed.load(Ordering::SeqCst) {
                monitor.dispose();
                return;
            }
            started.monitor = Some(Arc::clone(&monitor));
        }
        monitor.set_mode(mode());
    }

    /// A notch mode change (before `start` it is ignored: `start` reads the current mode).
    pub fn set_mode(&self, mode: NotchMode) {
        if let Some(monitor) = self.monitor() {
            monitor.set_mode(mode);
        }
    }

    /// The notch page (re)loaded.
    pub fn resync(&self) {
        if let Some(monitor) = self.monitor() {
            monitor.resync();
        }
    }

    /// Stops sampling (quit).
    pub fn dispose(&self) {
        self.disposed.store(true, Ordering::SeqCst);
        let monitor = self.started().monitor.take();
        if let Some(monitor) = monitor {
            monitor.dispose();
        }
    }
}

#[cfg(test)]
mod tests;
