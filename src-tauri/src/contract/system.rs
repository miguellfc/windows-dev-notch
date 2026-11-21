//! The `system:metrics` event (`src/shared/system/schema.ts`).

use serde::{Deserialize, Serialize};

use super::{nullable, Validate, MAX_SAFE_INTEGER};

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

/// `/^[A-Z]$/`.
fn drive_letter(letter: &str) -> Result<(), String> {
    match letter.as_bytes() {
        [byte] if byte.is_ascii_uppercase() => Ok(()),
        _ => Err("letter must be one of A-Z".into()),
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

/// `lightSampleSchema.storage`: the whole computer's fill, used bytes over total bytes of every
/// fixed drive read, as a percent.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StorageSample {
    pub used_percent: f64,
}

fn optional_storage(storage: Option<StorageSample>) -> Result<(), String> {
    storage.map_or(Ok(()), |storage| {
        percent("usedPercent", storage.used_percent)
    })
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
    #[serde(deserialize_with = "nullable")]
    pub storage: Option<StorageSample>,
    /// Internet reachability from Windows' connectivity hint (`GetNetworkConnectivityHint`):
    /// `true` with internet access, `false` with none, local only or captive/limited; `None`
    /// (JSON `null`) when Windows does not know, so the renderer falls back to `navigator.onLine`.
    #[serde(deserialize_with = "nullable")]
    pub online: Option<bool>,
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
        optional_storage(self.storage)?;
        self.alerts.validate()
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
    Unavailable(Unavailable),
}

impl Validate for SystemMetrics {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Light(sample) => sample.validate(),
            Self::Unavailable(_) => Ok(()),
        }
    }
}

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
            storage: Some(StorageSample { used_percent: 62.0 }),
            online: Some(false),
        };
        for metrics in [
            SystemMetrics::Light(light),
            SystemMetrics::Unavailable(Unavailable {}),
        ] {
            let value = serde_json::to_value(&metrics).unwrap();
            assert_eq!(
                check("system:metrics", Direction::Event, Some(&value)),
                Some(Ok(()))
            );
        }
        // Unknown connectivity is sent as `online: null`, never left out (the schema is strict).
        let unknown = LightSample {
            cpu_percent: None,
            ram: None,
            battery: None,
            alerts: SystemAlerts::default(),
            storage: None,
            online: None,
        };
        let value = serde_json::to_value(SystemMetrics::Light(unknown)).unwrap();
        assert_eq!(value["online"], serde_json::Value::Null);
        assert!(value.as_object().unwrap().contains_key("online"));
        assert_eq!(
            check("system:metrics", Direction::Event, Some(&value)),
            Some(Ok(()))
        );
        let unavailable = serde_json::to_value(SystemMetrics::Unavailable(Unavailable {})).unwrap();
        assert_eq!(unavailable, serde_json::json!({ "kind": "unavailable" }));
    }
}
