//! Port of 0.1.0's `system-ipc.ts` and `system-integration.ts`: the two notch-only
//! `system:*` channels (guards in `ipc::GUARDS`) and the adapter that owns the monitor. The
//! integration exists from `setup` (the channels reach it through [`SystemSlot`]); the Win32 API
//! and the monitor are only built by [`SystemIntegration::start`], off the startup path, which then
//! replays an order received before it and applies the current notch mode.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use serde_json::Value;

use super::alerts::AlertEvaluator;
use super::metrics::MetricsSampler;
use super::monitor::{
    AlertSettingsSource, Executor, MetricsSink, MonitorOptions, ProcessesSink, Samplers,
    SystemMonitor,
};
use super::processes::{MonotonicClock, ProcessSampler};
use super::SystemApi;
use crate::contract::notch::NotchMode;
use crate::contract::system::{KillInput, KillResult, ProcessOrder, ViewInput};
use crate::ipc::{BoxFuture, Channel, Ctx, ExposedError, IpcErrorCode, Registry};
use crate::services::timers::Timers;

/// What the channels need (`Pick<SystemMonitor, 'setOrder' | 'kill'>`).
pub trait SystemControl: Send + Sync {
    fn set_order(&self, by: ProcessOrder);
    /// Blocking (Win32 reads behind the samplers' lock): the channel runs it on a worker.
    fn kill(&self, input: &KillInput) -> KillResult;
}

/// Filled in `setup`; the channels answer UNAVAILABLE until then.
pub type SystemSlot = OnceLock<Arc<dyn SystemControl>>;

fn control(slot: &SystemSlot) -> Result<Arc<dyn SystemControl>, ExposedError> {
    slot.get()
        .cloned()
        .ok_or_else(|| ExposedError::new(IpcErrorCode::Unavailable, "Not available yet"))
}

/// `system:view`: the process order (the view itself follows the notch mode).
struct ViewChannel(Arc<SystemSlot>);

impl Channel for ViewChannel {
    fn handle<'a>(
        &'a self,
        _ctx: &'a Ctx,
        input: Value,
    ) -> BoxFuture<'a, Result<Value, ExposedError>> {
        Box::pin(async move {
            let control = control(&self.0)?;
            let input = ViewInput::from_input(input)?;
            control.set_order(input.by);
            Ok(Value::Null)
        })
    }
}

/// `system:kill-process`: closes a listed process and answers the result.
struct KillChannel(Arc<SystemSlot>);

impl Channel for KillChannel {
    fn handle<'a>(
        &'a self,
        _ctx: &'a Ctx,
        input: Value,
    ) -> BoxFuture<'a, Result<Value, ExposedError>> {
        Box::pin(async move {
            let control = control(&self.0)?;
            let input = KillInput::from_input(input)?;
            let result = tauri::async_runtime::spawn_blocking(move || control.kill(&input))
                .await
                .map_err(ExposedError::internal)?;
            serde_json::to_value(result).map_err(ExposedError::internal)
        })
    }
}

/// Registers `system:view` and `system:kill-process`; they reach the monitor through `slot`.
pub fn register(registry: &mut Registry, slot: &Arc<SystemSlot>) {
    registry.register("system:view", ViewChannel(Arc::clone(slot)));
    registry.register("system:kill-process", KillChannel(Arc::clone(slot)));
}

/// What [`SystemIntegration::start`] builds the monitor from.
pub struct StartOptions {
    /// `None` when the Win32 API could not load: the monitor only reports `unavailable`.
    pub api: Option<Arc<dyn SystemApi>>,
    pub timers: Arc<dyn Timers>,
    /// Monotonic: a wall-clock change must never freeze per-process CPU.
    pub now: MonotonicClock,
    pub executor: Executor,
    /// The live alert settings (read on every sample, so a change applies to the next one).
    pub alert_settings: AlertSettingsSource,
    /// The notch window only (skipped while it does not exist).
    pub on_metrics: MetricsSink,
    pub on_processes: ProcessesSink,
}

#[derive(Default)]
struct Started {
    monitor: Option<Arc<SystemMonitor>>,
    api: Option<Arc<dyn SystemApi>>,
    /// An order that arrives before `start` is replayed once the monitor exists.
    pending_order: Option<ProcessOrder>,
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

    /// Builds the samplers and the monitor, replays a pending order and starts sampling for
    /// `mode()` (read once the monitor exists). Run it off the main thread.
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
            on_processes,
        } = options;
        if api.is_none() {
            log::warn!("System monitor unavailable");
        }
        let samplers = api.as_ref().map(|api| Samplers {
            metrics: Box::new(MetricsSampler::new(Arc::clone(api))) as _,
            processes: Box::new(ProcessSampler::new(Arc::clone(api), Arc::clone(&now))) as _,
        });
        let monitor = Arc::new(SystemMonitor::new(MonitorOptions {
            samplers,
            alerts: Box::new(AlertEvaluator::new()),
            alert_settings,
            timers,
            now,
            on_metrics,
            on_processes,
            executor,
        }));
        {
            let mut started = self.started();
            if self.disposed.load(Ordering::SeqCst) {
                monitor.dispose();
                if let Some(api) = api {
                    api.dispose();
                }
                return;
            }
            if let Some(order) = started.pending_order.take() {
                monitor.set_order(order);
            }
            started.monitor = Some(Arc::clone(&monitor));
            started.api = api;
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

    /// Stops sampling and closes the PDH query (quit). The PDH lock is only ever held for one
    /// Win32 read, never while waiting on the main thread, so this is safe there too.
    pub fn dispose(&self) {
        self.disposed.store(true, Ordering::SeqCst);
        let (monitor, api) = {
            let mut started = self.started();
            (started.monitor.take(), started.api.take())
        };
        if let Some(monitor) = monitor {
            monitor.dispose();
        }
        if let Some(api) = api {
            api.dispose();
        }
    }
}

impl SystemControl for SystemIntegration {
    fn set_order(&self, by: ProcessOrder) {
        let monitor = {
            let mut started = self.started();
            match &started.monitor {
                Some(monitor) => Arc::clone(monitor),
                None => {
                    started.pending_order = Some(by);
                    return;
                }
            }
        };
        monitor.set_order(by);
    }

    fn kill(&self, input: &KillInput) -> KillResult {
        self.monitor()
            .map_or(KillResult::NotKillable, |monitor| monitor.kill(input))
    }
}

#[cfg(test)]
mod tests;
