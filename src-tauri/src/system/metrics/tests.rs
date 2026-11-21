//! Port of 0.1.0's `metrics-sampler.test.ts`, light sample and free disk space only (the full
//! sample went with the System view).

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;

use super::*;
use crate::contract::system::SystemMetrics;
use crate::contract::{check, Direction};
use crate::system::fake::{times, FakeSystemApi};
use crate::system::{DiskSpace, MemoryStatus, PowerStatus};

fn fake() -> (Arc<FakeSystemApi>, MetricsSampler) {
    let api = Arc::new(FakeSystemApi::new());
    let sampler = MetricsSampler::new(Arc::clone(&api) as Arc<dyn SystemApi>);
    (api, sampler)
}

fn space(total_bytes: u64, free_bytes: u64) -> Option<DiskSpace> {
    Some(DiskSpace {
        total_bytes,
        free_bytes,
    })
}

fn power(
    percent: Option<u8>,
    charging: bool,
    ac_online: bool,
    seconds_left: Option<u32>,
) -> Option<PowerStatus> {
    Some(PowerStatus {
        has_battery: true,
        percent,
        charging,
        ac_online,
        seconds_left,
    })
}

fn free(letter: &str, free_percent: f64, free_bytes: u64, total_bytes: u64) -> DiskFree {
    DiskFree {
        letter: letter.into(),
        free_percent,
        free_bytes,
        total_bytes,
    }
}

/// `lightSampleSchema` with `NO_ALERTS`, through the event contract.
fn light_parses(sample: MetricsLight) -> bool {
    let value = serde_json::to_value(SystemMetrics::Light(
        sample.with_alerts(SystemAlerts::default(), None),
    ))
    .unwrap();
    check("system:metrics", Direction::Event, Some(&value)) == Some(Ok(()))
}

// --- cpu ---

#[test]
fn cpu_is_null_on_the_first_sample_and_computed_from_deltas_afterwards() {
    let (api, mut sampler) = fake();
    api.state().times = Some(times(100.0, 200.0, 100.0));
    assert_eq!(sampler.light().cpu_percent, None);
    // d-idle 50, d-kernel 100 (includes idle), d-user 100 -> total 200, busy 150 -> 75
    api.state().times = Some(times(150.0, 300.0, 200.0));
    assert_eq!(sampler.light().cpu_percent, Some(75.0));
}

#[test]
fn cpu_rounds_to_an_integer() {
    let (api, mut sampler) = fake();
    api.state().times = Some(times(0.0, 0.0, 0.0));
    sampler.light();
    // total 3, idle 1 -> 66.67 -> 67
    api.state().times = Some(times(1.0, 2.0, 1.0));
    assert_eq!(sampler.light().cpu_percent, Some(67.0));
}

#[test]
fn cpu_is_null_again_on_the_first_sample_after_reset() {
    let (api, mut sampler) = fake();
    sampler.light();
    api.state().times = Some(times(50.0, 100.0, 100.0));
    assert!(sampler.light().cpu_percent.is_some());
    sampler.reset();
    api.state().times = Some(times(100.0, 200.0, 200.0));
    assert_eq!(sampler.light().cpu_percent, None);
}

#[test]
fn cpu_repeats_the_last_value_when_the_total_delta_is_0() {
    let (api, mut sampler) = fake();
    sampler.light();
    api.state().times = Some(times(50.0, 100.0, 100.0));
    assert_eq!(sampler.light().cpu_percent, Some(75.0));
    assert_eq!(sampler.light().cpu_percent, Some(75.0));
}

#[test]
fn cpu_is_null_when_system_times_is_unavailable_or_throws_without_breaking_the_rest() {
    let (api, mut sampler) = fake();
    api.state().times = None;
    assert_eq!(sampler.light().cpu_percent, None);
    api.state().throwing.insert("systemTimes");
    let sample = sampler.light();
    assert_eq!(sample.cpu_percent, None);
    assert!(sample.ram.is_some());
}

// --- cpu baseline ---

#[test]
fn cpu_baseline_survives_a_null_system_times_read() {
    let (api, mut sampler) = fake();
    api.state().times = Some(times(100.0, 200.0, 100.0));
    sampler.light();
    api.state().times = None;
    assert_eq!(sampler.light().cpu_percent, None);
    // Delta against the read before the failure: d-idle 50, d-total 200 -> 75.
    api.state().times = Some(times(150.0, 300.0, 200.0));
    assert_eq!(sampler.light().cpu_percent, Some(75.0));
}

#[test]
fn cpu_baseline_survives_a_nan_system_times_read() {
    let (api, mut sampler) = fake();
    api.state().times = Some(times(100.0, 200.0, 100.0));
    sampler.light();
    api.state().times = Some(times(f64::NAN, 300.0, 200.0));
    assert_eq!(sampler.light().cpu_percent, None);
    api.state().times = Some(times(150.0, 300.0, 200.0));
    assert_eq!(sampler.light().cpu_percent, Some(75.0));
}

// --- unreadable readings ---

#[test]
fn unreadable_memory_drops_only_that_metric() {
    // TS feeds NaN; the Rust reads are integers, so an unreadable value is `None`.
    let (api, mut sampler) = fake();
    api.state().memory = None;
    let sample = sampler.light();
    assert_eq!(sample.ram, None);
    assert!(sample.battery.is_some());
    assert!(light_parses(sample));
}

// --- ram ---

#[test]
fn ram_uses_total_minus_available() {
    let (_api, mut sampler) = fake();
    assert_eq!(
        sampler.light().ram,
        Some(RamSample {
            used_bytes: 12_000.0,
            total_bytes: 16_000.0
        })
    );
}

#[test]
fn ram_is_null_when_unavailable_or_throwing() {
    let (api, mut sampler) = fake();
    api.state().memory = None;
    assert_eq!(sampler.light().ram, None);
    api.state().memory = Some(MemoryStatus {
        total_bytes: 1,
        avail_bytes: 1,
    });
    api.state().throwing.insert("memory");
    assert_eq!(sampler.light().ram, None);
}

// --- battery ---

#[test]
fn battery_maps_the_power_status() {
    let (api, mut sampler) = fake();
    api.state().power = power(Some(55), true, true, None);
    assert_eq!(
        sampler.light().battery,
        Some(BatterySample {
            percent: 55.0,
            charging: true,
            plugged_in: true,
            seconds_left: None
        })
    );
}

#[test]
fn battery_is_null_without_a_battery_with_a_null_percent_when_null_or_throwing() {
    let (api, mut sampler) = fake();
    api.state().power = Some(PowerStatus {
        has_battery: false,
        percent: Some(100),
        charging: true,
        ac_online: true,
        seconds_left: None,
    });
    assert_eq!(sampler.light().battery, None);
    api.state().power = power(None, false, false, None);
    assert_eq!(sampler.light().battery, None);
    api.state().power = None;
    assert_eq!(sampler.light().battery, None);
    api.state().power = power(Some(50), false, false, Some(10));
    api.state().throwing.insert("power");
    assert_eq!(sampler.light().battery, None);
}

#[test]
fn battery_reports_plugged_in_but_not_charging_when_full_on_ac() {
    let (api, mut sampler) = fake();
    api.state().power = power(Some(100), false, true, None);
    assert_eq!(
        sampler.light().battery,
        Some(BatterySample {
            percent: 100.0,
            charging: false,
            plugged_in: true,
            seconds_left: None
        })
    );
}

#[test]
fn battery_is_null_for_an_unknown_percent() {
    // TS feeds NaN; Windows' unknown percent (255) reaches Rust as `None`.
    let (api, mut sampler) = fake();
    api.state().power = power(None, false, false, None);
    assert_eq!(sampler.light().battery, None);
}

#[test]
fn battery_clamps_the_percent_to_0_100() {
    let (api, mut sampler) = fake();
    api.state().power = power(Some(140), false, false, None);
    assert_eq!(sampler.light().battery.map(|b| b.percent), Some(100.0));
    // A u8 cannot be negative (TS: -5 -> 0); the lower bound still holds.
    api.state().power = power(Some(0), false, false, None);
    assert_eq!(sampler.light().battery.map(|b| b.percent), Some(0.0));
}

// --- disks() (space only) ---

#[test]
fn space_only_reports_rounded_free_percent_per_fixed_drive_without_touching_pdh() {
    let (api, mut sampler) = fake();
    {
        let mut state = api.state();
        state.drives = Some(vec!['C', 'D']);
        state.space = HashMap::from([('C', space(3, 1)), ('D', space(1000, 1000))]);
        state.throwing.insert("diskIdlePercent");
        state.throwing.insert("systemTimes");
    }
    assert_eq!(
        sampler.disks(),
        Some(vec![free("C", 33.0, 1, 3), free("D", 100.0, 1000, 1000)])
    );
}

#[test]
fn space_only_skips_drives_with_total_0_or_no_space_info_and_clamps_to_0_100() {
    let (api, mut sampler) = fake();
    {
        let mut state = api.state();
        // TS also feeds a NaN total (E); an integer read cannot carry it, so E has no info.
        state.drives = Some(vec!['C', 'D', 'E', 'F', 'G']);
        state.space = HashMap::from([
            ('C', space(0, 0)),
            ('D', None),
            ('E', None),
            ('F', space(10, 20)),
            ('G', space(10, 1)),
        ]);
    }
    assert_eq!(
        sampler.disks(),
        Some(vec![free("F", 100.0, 10, 10), free("G", 10.0, 1, 10)])
    );
}

#[test]
fn space_only_is_null_when_the_drive_list_cannot_be_read_and_empty_when_disk_space_throws() {
    let (api, mut sampler) = fake();
    api.state().throwing.insert("fixedDrives");
    assert_eq!(sampler.disks(), None);
    api.state().throwing.remove("fixedDrives");
    api.state().drives = None;
    assert_eq!(sampler.disks(), None);
    api.state().drives = Some(vec!['C']);
    api.state().throwing.insert("diskSpace");
    assert_eq!(sampler.disks(), Some(vec![]));
}

#[test]
fn space_only_does_not_disturb_the_cpu_baseline() {
    let (api, mut sampler) = fake();
    sampler.light();
    api.state().times = Some(times(50.0, 100.0, 100.0));
    sampler.disks();
    assert_eq!(sampler.light().cpu_percent, Some(75.0));
}

// --- shape ---

fn keys(value: &Value) -> Vec<String> {
    let mut keys: Vec<String> = value
        .as_object()
        .unwrap()
        .keys()
        .filter(|key| !["alerts", "storage", "kind"].contains(&key.as_str()))
        .cloned()
        .collect();
    keys.sort();
    keys
}

#[test]
fn light_has_no_disks_or_network() {
    let (_api, mut sampler) = fake();
    let light =
        serde_json::to_value(sampler.light().with_alerts(SystemAlerts::default(), None)).unwrap();
    assert_eq!(keys(&light), ["battery", "cpuPercent", "online", "ram"]);
}

// --- connection ---

#[test]
fn online_follows_the_connectivity_read() {
    let (api, mut sampler) = fake();
    assert_eq!(sampler.light().online, Some(true));
    api.state().online = Some(false);
    assert_eq!(sampler.light().online, Some(false));
    // Windows does not know: no value, so the renderer falls back to navigator.onLine.
    api.state().online = None;
    let sample = sampler.light();
    assert_eq!(sample.online, None);
    assert!(light_parses(sample));
}

#[test]
fn a_throwing_connectivity_read_degrades_to_unknown_only() {
    let (api, mut sampler) = fake();
    sampler.light();
    api.state().throwing.insert("online");
    api.state().times = Some(times(50.0, 100.0, 100.0));
    let sample = sampler.light();
    assert_eq!(sample.online, None);
    assert_eq!(sample.cpu_percent, Some(75.0));
    assert!(sample.ram.is_some() && sample.battery.is_some());
}

#[test]
fn every_sample_passes_the_schemas() {
    let (api, mut sampler) = fake();
    let verify = |sampler: &mut MetricsSampler| {
        assert!(light_parses(sampler.light()));
    };
    verify(&mut sampler);
    {
        let mut state = api.state();
        state.times = Some(times(70.0, 200.0, 100.0));
        state.power = power(Some(200), true, true, Some(120));
    }
    verify(&mut sampler);
    {
        let mut state = api.state();
        state.memory = None;
        state.power = None;
        state.drives = Some(vec![]);
    }
    verify(&mut sampler);
    api.state()
        .throwing
        .extend(["systemTimes", "memory", "power", "fixedDrives", "diskSpace"]);
    verify(&mut sampler);
}
