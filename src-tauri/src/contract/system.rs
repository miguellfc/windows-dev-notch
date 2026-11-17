//! `system:*` channels and events (`src/shared/system/schema.ts`).

use serde::{Deserialize, Serialize};

use super::{length, nullable, Validate, MAX_SAFE_INTEGER};

/// Rows of the System view's process list: the sampler's default limit and the event's maximum.
pub const PROCESS_LIMIT: usize = 5;

/// `percentSchema`: 0..=100.
fn percent(name: &str, value: f64) -> Result<(), String> {
    if (0.0..=100.0).contains(&value) {
        Ok(())
    } else {
        Err(format!("{name} must be between 0 and 100"))
    }
}

fn optional_percent(name: &str, value: Option<f64>) -> Result<(), String> {
    value.map_or(Ok(()), |value| percent(name, value))
}

/// `bytesSchema`: non-negative.
fn bytes(name: &str, value: f64) -> Result<(), String> {
    if value >= 0.0 {
        Ok(())
    } else {
        Err(format!("{name} must not be negative"))
    }
}

/// `z.int().positive()`.
fn positive_int(name: &str, value: u64) -> Result<(), String> {
    if (1..=MAX_SAFE_INTEGER).contains(&value) {
        Ok(())
    } else {
        Err(format!("{name} must be a positive safe integer"))
    }
}

/// `/^[A-Z]$/`.
fn drive_letter(letter: &str) -> Result<(), String> {
    match letter.as_bytes() {
        [byte] if byte.is_ascii_uppercase() => Ok(()),
        _ => Err("letter must be one of A-Z".into()),
    }
}

fn max_length(name: &str, value: &str, max: usize) -> Result<(), String> {
    if length(value) <= max {
        Ok(())
    } else {
        Err(format!("{name} must be at most {max} characters"))
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DiskAlert {
    pub letter: String,
    pub free_percent: f64,
}

/// `systemAlertsSchema`: which alerts are active; `disk` is the worst fixed drive below its threshold.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SystemAlerts {
    pub cpu: bool,
    pub ram: bool,
    pub battery: bool,
    #[serde(deserialize_with = "nullable")]
    pub disk: Option<DiskAlert>,
}

impl Validate for SystemAlerts {
    fn validate(&self) -> Result<(), String> {
        self.disk.as_ref().map_or(Ok(()), |disk| {
            drive_letter(&disk.letter)?;
            percent("freePercent", disk.free_percent)
        })
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RamSample {
    pub used_bytes: f64,
    pub total_bytes: f64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BatterySample {
    pub percent: f64,
    pub charging: bool,
    /// On AC power (charging or full); `charging` alone is false at 100 % on AC.
    pub plugged_in: bool,
    #[serde(deserialize_with = "nullable")]
    pub seconds_left: Option<u64>,
}

/// `lightSampleSchema`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LightSample {
    #[serde(deserialize_with = "nullable")]
    pub cpu_percent: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub ram: Option<RamSample>,
    #[serde(deserialize_with = "nullable")]
    pub battery: Option<BatterySample>,
    pub alerts: SystemAlerts,
}

impl Validate for LightSample {
    fn validate(&self) -> Result<(), String> {
        optional_percent("cpuPercent", self.cpu_percent)?;
        if let Some(ram) = self.ram {
            bytes("usedBytes", ram.used_bytes)?;
            bytes("totalBytes", ram.total_bytes)?;
        }
        if let Some(battery) = self.battery {
            percent("percent", battery.percent)?;
            if battery
                .seconds_left
                .is_some_and(|seconds| seconds > MAX_SAFE_INTEGER)
            {
                return Err("secondsLeft must be a safe integer".into());
            }
        }
        self.alerts.validate()
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DiskSample {
    pub letter: String,
    pub used_percent: f64,
    pub free_bytes: f64,
    #[serde(deserialize_with = "nullable")]
    pub activity_percent: Option<f64>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NetworkSample {
    pub up_bytes_per_sec: f64,
    pub down_bytes_per_sec: f64,
}

/// `fullSampleSchema`: the light sample plus disks and network (fields repeated rather than
/// flattened: `#[serde(flatten)]` cannot be combined with `deny_unknown_fields`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FullSample {
    #[serde(deserialize_with = "nullable")]
    pub cpu_percent: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub ram: Option<RamSample>,
    #[serde(deserialize_with = "nullable")]
    pub battery: Option<BatterySample>,
    pub alerts: SystemAlerts,
    pub disks: Vec<DiskSample>,
    #[serde(deserialize_with = "nullable")]
    pub network: Option<NetworkSample>,
}

impl FullSample {
    /// The fields both sample kinds share.
    pub fn light(&self) -> LightSample {
        LightSample {
            cpu_percent: self.cpu_percent,
            ram: self.ram,
            battery: self.battery,
            alerts: self.alerts.clone(),
        }
    }
}

impl Validate for FullSample {
    fn validate(&self) -> Result<(), String> {
        self.light().validate()?;
        for disk in &self.disks {
            drive_letter(&disk.letter)?;
            percent("usedPercent", disk.used_percent)?;
            bytes("freeBytes", disk.free_bytes)?;
            optional_percent("activityPercent", disk.activity_percent)?;
        }
        if let Some(network) = self.network {
            bytes("upBytesPerSec", network.up_bytes_per_sec)?;
            bytes("downBytesPerSec", network.down_bytes_per_sec)?;
        }
        Ok(())
    }
}

/// `{ kind: 'unavailable' }`, strict.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields)]
pub struct Unavailable {}

/// `systemMetricsSchema`: discriminated on `kind`. The tag is removed before the variant's
/// strict struct sees the remaining keys.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SystemMetrics {
    Light(LightSample),
    Full(FullSample),
    Unavailable(Unavailable),
}

impl Validate for SystemMetrics {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Light(sample) => sample.validate(),
            Self::Full(sample) => sample.validate(),
            Self::Unavailable(_) => Ok(()),
        }
    }
}

/// `processRowSchema`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ProcessRow {
    pub pid: u64,
    pub name: String,
    #[serde(deserialize_with = "nullable")]
    pub cpu_percent: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub private_bytes: Option<f64>,
    /// ISO-8601 start instant; with the pid it identifies the process across pid reuse.
    pub start_time: String,
    pub killable: bool,
}

impl Validate for ProcessRow {
    fn validate(&self) -> Result<(), String> {
        positive_int("pid", self.pid)?;
        max_length("name", &self.name, 260)?;
        optional_percent("cpuPercent", self.cpu_percent)?;
        if let Some(private) = self.private_bytes {
            bytes("privateBytes", private)?;
        }
        max_length("startTime", &self.start_time, 40)
    }
}

/// Payload of `system:processes`: at most [`PROCESS_LIMIT`] rows.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(transparent)]
pub struct ProcessList(pub Vec<ProcessRow>);

impl Validate for ProcessList {
    fn validate(&self) -> Result<(), String> {
        if self.0.len() > PROCESS_LIMIT {
            return Err(format!("at most {PROCESS_LIMIT} processes"));
        }
        self.0.iter().try_for_each(Validate::validate)
    }
}

string_enum! {
    /// `processOrderSchema`.
    pub enum ProcessOrder {
        Cpu = "cpu",
        Ram = "ram",
    }
}

string_enum! {
    /// `killResultSchema`.
    pub enum KillResult {
        Killed = "killed",
        Gone = "gone",
        Denied = "denied",
        NotKillable = "not-killable",
    }
}

/// `killInputSchema` (input of `system:kill-process`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct KillInput {
    pub pid: u64,
    pub start_time: String,
}

impl Validate for KillInput {
    fn validate(&self) -> Result<(), String> {
        positive_int("pid", self.pid)?;
        max_length("startTime", &self.start_time, 40)
    }
}

/// `viewInputSchema` (input of `system:view`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ViewInput {
    pub by: ProcessOrder,
}

impl Validate for ViewInput {}

input_entry!(KillInput, ViewInput);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{check, Direction};

    #[test]
    fn serialized_metrics_pass_their_own_contract() {
        let light = LightSample {
            cpu_percent: Some(5.0),
            ram: None,
            battery: None,
            alerts: SystemAlerts::default(),
        };
        let full = FullSample {
            cpu_percent: None,
            ram: Some(RamSample {
                used_bytes: 1.0,
                total_bytes: 2.0,
            }),
            battery: None,
            alerts: SystemAlerts::default(),
            disks: Vec::new(),
            network: None,
        };
        for metrics in [
            SystemMetrics::Light(light),
            SystemMetrics::Full(full),
            SystemMetrics::Unavailable(Unavailable {}),
        ] {
            let value = serde_json::to_value(&metrics).unwrap();
            assert_eq!(
                check("system:metrics", Direction::Event, Some(&value)),
                Some(Ok(()))
            );
        }
        let unavailable = serde_json::to_value(SystemMetrics::Unavailable(Unavailable {})).unwrap();
        assert_eq!(unavailable, serde_json::json!({ "kind": "unavailable" }));
    }

    #[test]
    fn kill_input_entry_refuses_pid_zero() {
        let refused = KillInput::from_input(serde_json::json!({ "pid": 0, "startTime": "" }));
        assert!(refused.is_err());
    }
}
