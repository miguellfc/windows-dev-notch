//! `usage:summary` (`src/shared/usage/schema.ts`).

use serde::{Deserialize, Serialize};

use super::{nullable, present, Validate, MAX_SAFE_INTEGER};

/// Ranges the Control Center can ask for, in days.
pub const USAGE_RANGES: [u32; 3] = [7, 14, 30];

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UsageSummaryInput {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub days: Option<u32>,
}

impl Validate for UsageSummaryInput {
    fn validate(&self) -> Result<(), String> {
        match self.days {
            Some(days) if !USAGE_RANGES.contains(&days) => Err("days must be 7, 14 or 30".into()),
            _ => Ok(()),
        }
    }
}

/// Aggregates of the local usage log over the last N days (counts only).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UsageSummary {
    pub days: u64,
    pub running_hours_avg: f64,
    pub launches: u64,
    pub reminders_fired: u64,
    pub reminders_missed: u64,
    pub reminders_completed: u64,
    pub claude_alerts: u64,
    #[serde(deserialize_with = "nullable")]
    pub claude_latency_median_ms: Option<u64>,
    #[serde(deserialize_with = "nullable")]
    pub claude_latency_p95_ms: Option<u64>,
    pub from: String,
    pub to: String,
}

impl Validate for UsageSummary {
    fn validate(&self) -> Result<(), String> {
        let counts = [
            Some(self.days),
            Some(self.launches),
            Some(self.reminders_fired),
            Some(self.reminders_missed),
            Some(self.reminders_completed),
            Some(self.claude_alerts),
            self.claude_latency_median_ms,
            self.claude_latency_p95_ms,
        ];
        if counts
            .into_iter()
            .flatten()
            .any(|count| count > MAX_SAFE_INTEGER)
        {
            return Err("counts must be safe integers".into());
        }
        if self.running_hours_avg < 0.0 {
            return Err("runningHoursAvg must not be negative".into());
        }
        if !is_day_key(&self.from) || !is_day_key(&self.to) {
            return Err("days must be YYYY-MM-DD".into());
        }
        Ok(())
    }
}

/// `dayKeySchema`: `/^\d{4}-\d{2}-\d{2}$/` (ASCII digits only, as JS `\d` without the `u` flag).
pub fn is_day_key(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            4 | 7 => *byte == b'-',
            _ => byte.is_ascii_digit(),
        })
}
