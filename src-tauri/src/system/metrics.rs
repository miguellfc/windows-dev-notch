//! Port of 0.1.0's `metrics-sampler.ts`: turns raw `SystemApi` readings into the samples
//! sent to the renderer (the monitor adds `alerts` before a sample leaves the backend).

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;

use super::alerts::DiskFree;
use super::{SystemApi, SystemTimes};
use crate::contract::system::{BatterySample, LightSample, RamSample, StorageSample, SystemAlerts};

/// A light sample without its `alerts` and `storage` (what the sampler measures; the monitor
/// adds both).
#[derive(Clone, Debug, PartialEq)]
pub struct MetricsLight {
    pub cpu_percent: Option<f64>,
    pub ram: Option<RamSample>,
    pub battery: Option<BatterySample>,
    /// Internet reachability (`SystemApi::online`); `None` when Windows does not know.
    pub online: Option<bool>,
}

impl MetricsLight {
    pub fn with_alerts(self, alerts: SystemAlerts, storage: Option<StorageSample>) -> LightSample {
        LightSample {
            cpu_percent: self.cpu_percent,
            ram: self.ram,
            battery: self.battery,
            alerts,
            storage,
            online: self.online,
        }
    }
}

/// What the monitor needs from the metrics sampler (a trait so its tests can spy on it).
pub trait Metrics: Send {
    fn light(&mut self) -> MetricsLight;
    /// Free space per fixed drive only (no CPU baseline): the light rhythm's disk-alert
    /// reading. `None` when the drive list could not be read, so the alert keeps its last reading.
    fn disks(&mut self) -> Option<Vec<DiskFree>>;
    /// Forgets the CPU baseline: the next sample reports `cpuPercent: null`.
    fn reset(&mut self);
}

/// Rounded 0-100; `None` for NaN or infinity (a PDH or division glitch the schema would reject).
pub(crate) fn clamp_percent(value: f64) -> Option<f64> {
    value.is_finite().then(|| value.round().clamp(0.0, 100.0))
}

/// Runs a raw read; a panicking adapter degrades that metric to `None` instead of failing the
/// sample (the TS `attempt` around a throwing call).
fn attempt<T>(read: impl FnOnce() -> Option<T>) -> Option<T> {
    catch_unwind(AssertUnwindSafe(read)).ok().flatten()
}

pub struct MetricsSampler {
    api: Arc<dyn SystemApi>,
    previous: Option<SystemTimes>,
    last_cpu: Option<f64>,
}

impl MetricsSampler {
    pub fn new(api: Arc<dyn SystemApi>) -> Self {
        Self {
            api,
            previous: None,
            last_cpu: None,
        }
    }

    fn cpu_percent(&mut self) -> Option<f64> {
        let now = attempt(|| self.api.system_times())?;
        // A failed or garbled read keeps the previous baseline, so the next good read is a delta.
        if !(now.idle_ms + now.kernel_ms + now.user_ms).is_finite() {
            return None;
        }
        let before = self.previous.replace(now)?;
        // GetSystemTimes: kernel time already includes idle time.
        let total = (now.kernel_ms - before.kernel_ms) + (now.user_ms - before.user_ms);
        if total.is_nan() || total <= 0.0 {
            return self.last_cpu;
        }
        let idle = now.idle_ms - before.idle_ms;
        self.last_cpu = clamp_percent(100.0 * (total - idle) / total);
        self.last_cpu
    }

    fn ram(&self) -> Option<RamSample> {
        let memory = attempt(|| self.api.memory())?;
        Some(RamSample {
            used_bytes: memory.total_bytes.saturating_sub(memory.avail_bytes) as f64,
            total_bytes: memory.total_bytes as f64,
        })
    }

    fn battery(&self) -> Option<BatterySample> {
        let power = attempt(|| self.api.power())?;
        if !power.has_battery {
            return None;
        }
        let percent = clamp_percent(f64::from(power.percent?))?;
        // Charging implies plugged in; on AC at 100 % the battery is plugged in but not charging.
        Some(BatterySample {
            percent,
            charging: power.charging,
            plugged_in: power.ac_online || power.charging,
            seconds_left: power.seconds_left.map(u64::from),
        })
    }
}

impl Metrics for MetricsSampler {
    fn light(&mut self) -> MetricsLight {
        MetricsLight {
            cpu_percent: self.cpu_percent(),
            ram: self.ram(),
            battery: self.battery(),
            online: attempt(|| self.api.online()),
        }
    }

    fn disks(&mut self) -> Option<Vec<DiskFree>> {
        let letters = attempt(|| self.api.fixed_drives())?;
        let mut result = Vec::new();
        for letter in letters {
            let Some(space) = attempt(|| self.api.disk_space(letter)) else {
                continue;
            };
            if space.total_bytes == 0 {
                continue;
            }
            let free = 100.0 * space.free_bytes as f64 / space.total_bytes as f64;
            if let Some(free_percent) = clamp_percent(free) {
                result.push(DiskFree {
                    letter: letter.to_string(),
                    free_percent,
                    free_bytes: space.free_bytes.min(space.total_bytes),
                    total_bytes: space.total_bytes,
                });
            }
        }
        Some(result)
    }

    fn reset(&mut self) {
        self.previous = None;
        self.last_cpu = None;
    }
}

#[cfg(test)]
mod tests;
