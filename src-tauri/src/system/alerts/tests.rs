//! Port of 0.1.0's `system-alerts.test.ts` (every case).

use super::*;
use crate::settings::default_settings;

fn input() -> AlertInput {
    AlertInput {
        now: 0,
        cpu_percent: None,
        ram_percent: None,
        battery: None,
        disks: None,
    }
}

fn settings() -> SystemAlertSettings {
    default_settings("en").system_alerts
}

fn settings_with(mutate: impl FnOnce(&mut SystemAlertSettings)) -> SystemAlertSettings {
    let mut s = settings();
    mutate(&mut s);
    s
}

fn no_alerts() -> SystemAlerts {
    SystemAlerts::default()
}

/// Feeds one CPU sample per second from `from` to `to` (inclusive) and returns the last result.
fn feed_cpu_with(
    e: &mut AlertEvaluator,
    from: u64,
    to: u64,
    value: Option<f64>,
    s: &SystemAlertSettings,
) -> SystemAlerts {
    let mut last = no_alerts();
    for t in from..=to {
        let sample = AlertInput {
            now: t * 1000,
            cpu_percent: value,
            ..input()
        };
        last = e.evaluate(&sample, s);
    }
    last
}

fn feed_cpu(e: &mut AlertEvaluator, from: u64, to: u64, value: Option<f64>) -> SystemAlerts {
    feed_cpu_with(e, from, to, value, &settings())
}

fn disk(letter: &str, free_percent: f64) -> DiskFree {
    DiskFree {
        letter: letter.into(),
        free_percent,
    }
}

fn disk_alert(letter: &str, free_percent: f64) -> Option<DiskAlert> {
    Some(DiskAlert {
        letter: letter.into(),
        free_percent,
    })
}

// --- CPU ---

#[test]
fn cpu_stays_off_until_the_window_covers_sustain_seconds_of_high_samples() {
    let mut e = AlertEvaluator::new();
    assert!(!feed_cpu(&mut e, 0, 29, Some(95.0)).cpu);
    assert!(feed_cpu(&mut e, 30, 30, Some(95.0)).cpu);
}

#[test]
fn cpu_does_not_turn_on_when_one_sample_inside_the_window_is_below_the_threshold() {
    let mut e = AlertEvaluator::new();
    feed_cpu(&mut e, 0, 10, Some(95.0));
    feed_cpu(&mut e, 11, 11, Some(89.0));
    assert!(!feed_cpu(&mut e, 12, 40, Some(95.0)).cpu);
    // Once the low sample at 11 s leaves the window [now - 30 s, now] it can turn on.
    assert!(!feed_cpu(&mut e, 41, 41, Some(95.0)).cpu);
    assert!(feed_cpu(&mut e, 42, 42, Some(95.0)).cpu);
}

#[test]
fn cpu_accepts_exactly_the_threshold_as_high() {
    let mut e = AlertEvaluator::new();
    assert!(feed_cpu(&mut e, 0, 30, Some(90.0)).cpu);
}

#[test]
fn cpu_keeps_the_alert_between_threshold_minus_5_and_threshold_and_turns_off_below() {
    let mut e = AlertEvaluator::new();
    feed_cpu(&mut e, 0, 30, Some(95.0));
    assert!(feed_cpu(&mut e, 31, 31, Some(87.0)).cpu);
    assert!(feed_cpu(&mut e, 32, 32, Some(85.0)).cpu);
    assert!(!feed_cpu(&mut e, 33, 33, Some(84.9)).cpu);
    // And needs a full sustained window again to come back.
    assert!(!feed_cpu(&mut e, 34, 63, Some(95.0)).cpu);
    assert!(feed_cpu(&mut e, 64, 64, Some(95.0)).cpu);
}

#[test]
fn cpu_ignores_null_samples_they_neither_count_as_high_nor_cut_an_active_alert() {
    let mut e = AlertEvaluator::new();
    assert!(!feed_cpu(&mut e, 0, 0, None).cpu);
    feed_cpu(&mut e, 1, 31, Some(95.0));
    let sample = AlertInput {
        now: 31_000,
        cpu_percent: Some(95.0),
        ..input()
    };
    assert!(e.evaluate(&sample, &settings()).cpu);
    assert!(feed_cpu(&mut e, 32, 40, None).cpu);
    assert!(feed_cpu(&mut e, 41, 41, Some(95.0)).cpu);
}

#[test]
fn cpu_a_null_first_sample_does_not_make_the_window_covered() {
    let mut e = AlertEvaluator::new();
    feed_cpu(&mut e, 0, 0, None);
    assert!(!feed_cpu(&mut e, 1, 30, Some(95.0)).cpu);
    assert!(feed_cpu(&mut e, 31, 31, Some(95.0)).cpu);
}

#[test]
fn cpu_treats_non_finite_values_as_null() {
    let mut e = AlertEvaluator::new();
    feed_cpu(&mut e, 0, 30, Some(95.0));
    assert!(feed_cpu(&mut e, 31, 31, Some(f64::NAN)).cpu);
    assert!(feed_cpu(&mut e, 32, 32, Some(f64::INFINITY)).cpu);
}

#[test]
fn cpu_honours_a_custom_sustain_seconds_and_percent() {
    let mut e = AlertEvaluator::new();
    let s = settings_with(|x| {
        x.cpu.percent = 60;
        x.cpu.sustain_seconds = 5;
    });
    assert!(!feed_cpu_with(&mut e, 0, 4, Some(70.0), &s).cpu);
    assert!(feed_cpu_with(&mut e, 5, 5, Some(70.0), &s).cpu);
    assert!(!feed_cpu_with(&mut e, 6, 6, Some(54.0), &s).cpu);
}

#[test]
fn cpu_turns_off_at_once_when_disabled_and_does_not_come_back_until_re_enabled() {
    let mut e = AlertEvaluator::new();
    feed_cpu(&mut e, 0, 30, Some(95.0));
    let off = settings_with(|x| x.cpu.enabled = false);
    assert!(!feed_cpu_with(&mut e, 31, 31, Some(95.0), &off).cpu);
    assert!(!feed_cpu_with(&mut e, 32, 70, Some(95.0), &off).cpu);
}

#[test]
fn cpu_recomputes_without_hysteresis_when_its_settings_change() {
    let mut e = AlertEvaluator::new();
    feed_cpu(&mut e, 0, 30, Some(95.0));
    assert!(feed_cpu(&mut e, 31, 31, Some(92.0)).cpu);
    let higher = settings_with(|x| x.cpu.percent = 95);
    // 92 is within the old hysteresis band of 95 - 5 but the settings changed: recomputed fresh.
    assert!(!feed_cpu_with(&mut e, 32, 32, Some(92.0), &higher).cpu);
}

#[test]
fn cpu_recomputing_after_a_settings_change_can_still_turn_on_from_the_stored_window() {
    let mut e = AlertEvaluator::new();
    assert!(!feed_cpu(&mut e, 0, 30, Some(80.0)).cpu);
    let lower = settings_with(|x| x.cpu.percent = 75);
    assert!(feed_cpu_with(&mut e, 31, 31, Some(80.0), &lower).cpu);
}

// --- RAM ---

fn ram_with(e: &mut AlertEvaluator, value: Option<f64>, s: &SystemAlertSettings) -> bool {
    let sample = AlertInput {
        ram_percent: value,
        ..input()
    };
    e.evaluate(&sample, s).ram
}

fn ram(e: &mut AlertEvaluator, value: Option<f64>) -> bool {
    ram_with(e, value, &settings())
}

#[test]
fn ram_applies_the_threshold_with_5_point_hysteresis() {
    let mut e = AlertEvaluator::new();
    assert!(!ram(&mut e, Some(89.9)));
    assert!(ram(&mut e, Some(90.0)));
    assert!(ram(&mut e, Some(86.0)));
    assert!(ram(&mut e, Some(85.0)));
    assert!(!ram(&mut e, Some(84.9)));
    assert!(!ram(&mut e, Some(88.0)));
}

#[test]
fn ram_keeps_its_state_on_null_or_non_finite_values() {
    let mut e = AlertEvaluator::new();
    ram(&mut e, Some(95.0));
    assert!(ram(&mut e, None));
    assert!(ram(&mut e, Some(f64::NAN)));
}

#[test]
fn ram_turns_off_at_once_when_disabled() {
    let mut e = AlertEvaluator::new();
    ram(&mut e, Some(95.0));
    assert!(!ram_with(
        &mut e,
        Some(95.0),
        &settings_with(|x| x.ram.enabled = false)
    ));
}

#[test]
fn ram_recomputes_without_hysteresis_when_its_settings_change() {
    let mut e = AlertEvaluator::new();
    ram(&mut e, Some(92.0));
    assert!(ram(&mut e, Some(88.0)));
    assert!(!ram_with(
        &mut e,
        Some(88.0),
        &settings_with(|x| x.ram.percent = 89)
    ));
}

// --- battery ---

fn on_battery(percent: f64) -> Option<BatteryInput> {
    Some(BatteryInput {
        percent,
        plugged_in: false,
    })
}

fn plugged(percent: f64) -> Option<BatteryInput> {
    Some(BatteryInput {
        percent,
        plugged_in: true,
    })
}

fn bat_with(
    e: &mut AlertEvaluator,
    battery: Option<BatteryInput>,
    s: &SystemAlertSettings,
) -> bool {
    let sample = AlertInput { battery, ..input() };
    e.evaluate(&sample, s).battery
}

fn bat(e: &mut AlertEvaluator, battery: Option<BatteryInput>) -> bool {
    bat_with(e, battery, &settings())
}

#[test]
fn battery_turns_on_at_or_below_the_threshold_and_off_above_threshold_plus_5() {
    let mut e = AlertEvaluator::new();
    assert!(!bat(&mut e, on_battery(16.0)));
    assert!(bat(&mut e, on_battery(15.0)));
    assert!(bat(&mut e, on_battery(20.0)));
    assert!(!bat(&mut e, on_battery(20.1)));
    assert!(!bat(&mut e, on_battery(18.0)));
}

#[test]
fn battery_is_off_when_plugged_in_or_without_a_battery() {
    let mut e = AlertEvaluator::new();
    assert!(!bat(&mut e, plugged(5.0)));
    bat(&mut e, on_battery(5.0));
    assert!(!bat(&mut e, None));
    bat(&mut e, on_battery(5.0));
    assert!(!bat(&mut e, plugged(5.0)));
}

#[test]
fn battery_treats_a_non_finite_percent_as_no_battery() {
    let mut e = AlertEvaluator::new();
    bat(&mut e, on_battery(5.0));
    assert!(!bat(&mut e, on_battery(f64::NAN)));
}

#[test]
fn battery_turns_off_when_disabled_and_recomputes_when_settings_change() {
    let mut e = AlertEvaluator::new();
    bat(&mut e, on_battery(10.0));
    assert!(!bat_with(
        &mut e,
        on_battery(10.0),
        &settings_with(|x| x.battery.enabled = false)
    ));
    let mut e2 = AlertEvaluator::new();
    bat(&mut e2, on_battery(15.0));
    assert!(bat(&mut e2, on_battery(18.0)));
    assert!(!bat_with(
        &mut e2,
        on_battery(18.0),
        &settings_with(|x| x.battery.percent = 16)
    ));
}

// --- disk ---

fn disk_with(
    e: &mut AlertEvaluator,
    disks: Option<Vec<DiskFree>>,
    s: &SystemAlertSettings,
) -> Option<DiskAlert> {
    let sample = AlertInput { disks, ..input() };
    e.evaluate(&sample, s).disk
}

fn disk_of(e: &mut AlertEvaluator, disks: Option<Vec<DiskFree>>) -> Option<DiskAlert> {
    disk_with(e, disks, &settings())
}

#[test]
fn disk_reports_the_worst_drive_below_the_threshold() {
    let mut e = AlertEvaluator::new();
    assert_eq!(
        disk_of(&mut e, Some(vec![disk("C", 30.0), disk("D", 12.0)])),
        None
    );
    assert_eq!(
        disk_of(&mut e, Some(vec![disk("C", 8.0), disk("D", 5.0)])),
        disk_alert("D", 5.0)
    );
}

#[test]
fn disk_stays_on_reporting_the_current_worst_until_every_drive_has_threshold_plus_5_free() {
    let mut e = AlertEvaluator::new();
    disk_of(&mut e, Some(vec![disk("C", 9.0), disk("D", 40.0)]));
    assert_eq!(
        disk_of(&mut e, Some(vec![disk("C", 14.0), disk("D", 40.0)])),
        disk_alert("C", 14.0)
    );
    assert_eq!(
        disk_of(&mut e, Some(vec![disk("C", 15.0), disk("D", 40.0)])),
        None
    );
    assert_eq!(disk_of(&mut e, Some(vec![disk("C", 12.0)])), None);
}

#[test]
fn disk_keeps_the_last_result_when_no_new_disk_data_arrives() {
    let mut e = AlertEvaluator::new();
    disk_of(&mut e, Some(vec![disk("C", 5.0)]));
    assert_eq!(disk_of(&mut e, None), disk_alert("C", 5.0));
    disk_of(&mut e, Some(vec![disk("C", 50.0)]));
    assert_eq!(disk_of(&mut e, None), None);
}

#[test]
fn disk_moves_to_the_next_worst_drive_or_turns_off_when_the_worst_disappears() {
    let mut e = AlertEvaluator::new();
    disk_of(&mut e, Some(vec![disk("C", 7.0), disk("E", 2.0)]));
    assert_eq!(
        disk_of(&mut e, Some(vec![disk("C", 7.0)])),
        disk_alert("C", 7.0)
    );
    assert_eq!(disk_of(&mut e, Some(vec![disk("D", 40.0)])), None);
    disk_of(&mut e, Some(vec![disk("E", 2.0)]));
    assert_eq!(disk_of(&mut e, Some(vec![])), None);
}

#[test]
fn disk_ignores_drives_with_a_non_finite_free_percent() {
    let mut e = AlertEvaluator::new();
    assert_eq!(
        disk_of(&mut e, Some(vec![disk("C", f64::NAN), disk("D", 40.0)])),
        None
    );
}

#[test]
fn disk_turns_off_when_disabled_and_recomputes_when_settings_change_even_without_new_data() {
    let mut e = AlertEvaluator::new();
    disk_of(&mut e, Some(vec![disk("C", 12.0)]));
    assert_eq!(disk_of(&mut e, None), None);
    let higher = settings_with(|x| x.disk.free_percent = 15);
    assert_eq!(disk_with(&mut e, None, &higher), disk_alert("C", 12.0));
    let lower = settings_with(|x| x.disk.free_percent = 11);
    // 12 would be within 15's hysteresis band, but the settings changed: recomputed fresh.
    assert_eq!(disk_with(&mut e, None, &lower), None);
    disk_with(&mut e, Some(vec![disk("C", 3.0)]), &lower);
    assert_eq!(
        disk_with(
            &mut e,
            Some(vec![disk("C", 3.0)]),
            &settings_with(|x| x.disk.enabled = false)
        ),
        None
    );
}

// --- general ---

#[test]
fn returns_no_alerts_for_an_empty_input() {
    assert_eq!(
        AlertEvaluator::new().evaluate(&input(), &settings()),
        no_alerts()
    );
}

#[test]
fn a_settings_change_on_one_alert_does_not_reset_the_others() {
    let mut e = AlertEvaluator::new();
    e.evaluate(
        &AlertInput {
            ram_percent: Some(95.0),
            battery: on_battery(10.0),
            ..input()
        },
        &settings(),
    );
    let result = e.evaluate(
        &AlertInput {
            ram_percent: Some(87.0),
            battery: on_battery(18.0),
            ..input()
        },
        &settings_with(|x| x.battery.percent = 16),
    );
    assert!(result.ram);
    assert!(!result.battery);
}

#[test]
fn reset_clears_the_cpu_window_and_every_state() {
    let mut e = AlertEvaluator::new();
    feed_cpu(&mut e, 0, 30, Some(95.0));
    e.evaluate(
        &AlertInput {
            now: 31_000,
            cpu_percent: Some(95.0),
            ram_percent: Some(95.0),
            disks: Some(vec![disk("C", 5.0)]),
            ..input()
        },
        &settings(),
    );
    e.reset();
    let after = e.evaluate(
        &AlertInput {
            now: 32_000,
            cpu_percent: Some(95.0),
            ram_percent: Some(87.0),
            ..input()
        },
        &settings(),
    );
    assert_eq!(after, no_alerts());
    assert!(!feed_cpu(&mut e, 33, 61, Some(95.0)).cpu);
    assert!(feed_cpu(&mut e, 62, 62, Some(95.0)).cpu);
}

#[test]
fn does_not_mutate_the_result_it_returned_before() {
    let mut e = AlertEvaluator::new();
    let first = e.evaluate(
        &AlertInput {
            disks: Some(vec![disk("C", 5.0)]),
            ..input()
        },
        &settings(),
    );
    e.evaluate(
        &AlertInput {
            disks: Some(vec![disk("C", 50.0)]),
            ..input()
        },
        &settings(),
    );
    assert_eq!(first.disk, disk_alert("C", 5.0));
}
