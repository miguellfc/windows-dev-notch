//! Port of 0.1.0's `alerts.ts`: the pure threshold evaluator behind the capsule's system
//! alerts (sustained CPU, RAM, battery and the worst fixed drive), each with a fixed 5-point
//! hysteresis. Changing an alert's settings recomputes it without its previous state, so raising a
//! threshold above the current value clears it on the next evaluation.

use crate::contract::settings::SystemAlertSettings;
use crate::contract::system::{DiskAlert, SystemAlerts};

/// An alert clears only once the metric is this many points back on the safe side.
const HYSTERESIS: f64 = 5.0;

/// Free space of one fixed drive, in percent.
#[derive(Clone, Debug, PartialEq)]
pub struct DiskFree {
    pub letter: String,
    pub free_percent: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BatteryInput {
    pub percent: f64,
    pub plugged_in: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct AlertInput {
    /// Sample instant in ms; the evaluator never reads the clock itself.
    pub now: u64,
    pub cpu_percent: Option<f64>,
    pub ram_percent: Option<f64>,
    pub battery: Option<BatteryInput>,
    /// `None` = no new disk reading this tick: keep the last one.
    pub disks: Option<Vec<DiskFree>>,
}

/// What the monitor needs from the evaluator (a trait so its tests can spy on it).
pub trait Alerts: Send {
    fn evaluate(&mut self, input: &AlertInput, settings: &SystemAlertSettings) -> SystemAlerts;
    /// Drops the CPU window, the last disk reading and every alert state (e.g. after a pause).
    fn reset(&mut self);
}

#[derive(Clone, Copy, Debug)]
struct CpuSample {
    at: i64,
    value: f64,
}

fn finite(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite())
}

fn worst_disk(disks: &[DiskFree]) -> Option<&DiskFree> {
    let mut worst: Option<&DiskFree> = None;
    for disk in disks {
        if worst.is_none_or(|worst| disk.free_percent < worst.free_percent) {
            worst = Some(disk);
        }
    }
    worst
}

#[derive(Default)]
pub struct AlertEvaluator {
    cpu_window: Vec<CpuSample>,
    last_disks: Option<Vec<DiskFree>>,
    cpu: bool,
    ram: bool,
    battery: bool,
    disk: Option<DiskFree>,
    /// The settings of the previous evaluation; `None` before the first one (and after a reset).
    previous: Option<SystemAlertSettings>,
}

impl AlertEvaluator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Keeps the samples inside the window plus the newest older one, which proves it is covered.
    fn record_cpu(&mut self, now: i64, value: Option<f64>, sustain_ms: i64) {
        if let Some(value) = value {
            self.cpu_window.push(CpuSample { at: now, value });
        }
        let start = now - sustain_ms;
        match self.cpu_window.iter().position(|sample| sample.at >= start) {
            None => {
                let keep_from = self.cpu_window.len().saturating_sub(1);
                self.cpu_window.drain(..keep_from);
            }
            Some(first_inside) if first_inside > 1 => {
                self.cpu_window.drain(..first_inside - 1);
            }
            Some(_) => {}
        }
    }

    fn evaluate_cpu(
        &self,
        now: i64,
        value: Option<f64>,
        percent: f64,
        sustain_ms: i64,
        was: bool,
    ) -> bool {
        let Some(value) = value else { return was };
        if value < percent - HYSTERESIS {
            return false;
        }
        let start = now - sustain_ms;
        let covered = self
            .cpu_window
            .first()
            .is_some_and(|oldest| oldest.at <= start);
        let all_high = self
            .cpu_window
            .iter()
            .all(|sample| sample.at < start || sample.value >= percent);
        (covered && all_high) || was
    }
}

fn evaluate_ram(value: Option<f64>, percent: f64, was: bool) -> bool {
    let Some(value) = value else { return was };
    if value >= percent {
        return true;
    }
    if value < percent - HYSTERESIS {
        return false;
    }
    was
}

fn evaluate_battery(battery: Option<BatteryInput>, threshold: f64, was: bool) -> bool {
    let Some(battery) = battery else { return false };
    let Some(percent) = finite(Some(battery.percent)) else {
        return false;
    };
    if battery.plugged_in {
        return false;
    }
    if percent <= threshold {
        return true;
    }
    if percent > threshold + HYSTERESIS {
        return false;
    }
    was
}

fn evaluate_disk(disks: Option<&[DiskFree]>, threshold: f64, was: bool) -> Option<DiskFree> {
    let worst = worst_disk(disks?)?;
    if worst.free_percent >= threshold + HYSTERESIS {
        return None;
    }
    (worst.free_percent < threshold || was).then(|| worst.clone())
}

impl Alerts for AlertEvaluator {
    fn evaluate(&mut self, input: &AlertInput, settings: &SystemAlertSettings) -> SystemAlerts {
        let previous = self.previous;
        let now = i64::try_from(input.now).unwrap_or(i64::MAX);
        let sustain_ms = i64::from(settings.cpu.sustain_seconds) * 1000;

        let cpu_value = finite(input.cpu_percent);
        self.record_cpu(now, cpu_value, sustain_ms);
        if let Some(disks) = &input.disks {
            self.last_disks = Some(
                disks
                    .iter()
                    .filter(|disk| disk.free_percent.is_finite())
                    .cloned()
                    .collect(),
            );
        }

        let cpu_fresh = previous.is_none_or(|p| p.cpu != settings.cpu);
        let ram_fresh = previous.is_none_or(|p| p.ram != settings.ram);
        let battery_fresh = previous.is_none_or(|p| p.battery != settings.battery);
        let disk_fresh = previous.is_none_or(|p| p.disk != settings.disk);

        self.cpu = settings.cpu.enabled
            && self.evaluate_cpu(
                now,
                cpu_value,
                f64::from(settings.cpu.percent),
                sustain_ms,
                self.cpu && !cpu_fresh,
            );
        self.ram = settings.ram.enabled
            && evaluate_ram(
                finite(input.ram_percent),
                f64::from(settings.ram.percent),
                self.ram && !ram_fresh,
            );
        self.battery = settings.battery.enabled
            && evaluate_battery(
                input.battery,
                f64::from(settings.battery.percent),
                self.battery && !battery_fresh,
            );
        self.disk = if settings.disk.enabled {
            evaluate_disk(
                self.last_disks.as_deref(),
                f64::from(settings.disk.free_percent),
                self.disk.is_some() && !disk_fresh,
            )
        } else {
            None
        };

        self.previous = Some(*settings);
        SystemAlerts {
            cpu: self.cpu,
            ram: self.ram,
            battery: self.battery,
            disk: self.disk.as_ref().map(|disk| DiskAlert {
                letter: disk.letter.clone(),
                free_percent: disk.free_percent,
            }),
        }
    }

    fn reset(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests;
