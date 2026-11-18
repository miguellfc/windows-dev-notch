//! The end-of-day wiring of `index.ts`: `onAlert` (refused without a notch or with a panel open,
//! payload before the capsule alert), the readings taken from the integration, and the power
//! hook (resume and unlock run a check). Virtual timers that are never advanced stand for a PC
//! asleep: its timers stall while the wall clock jumps.

use std::sync::{Arc, Mutex};

use chrono_tz::Europe::Madrid;

use super::*;
use crate::contract::redmine::{RedmineAlert, RedmineStatus};
use crate::contract::settings::{RedmineEndOfDaySettings, RedmineSettings};
use crate::notch::state::{NotchEvent, NotchMode, PANEL_MODES};
use crate::platform::power::{PowerEvent, PowerListener};
use crate::redmine::end_of_day::{EndOfDaySettings, SettingsListener};
use crate::reminders::time::tests::local;
use crate::services::clock::WallClock;
use crate::services::timers::TestTimers;

const MINUTE_MS: i64 = 60_000;

/// The capsule: a mode (`None`: no notch window) and every call, in order.
struct FakeNotch {
    mode: Mutex<Option<NotchMode>>,
    calls: Mutex<Vec<String>>,
}

impl FakeNotch {
    fn new(mode: Option<NotchMode>) -> Arc<Self> {
        Arc::new(Self {
            mode: Mutex::new(mode),
            calls: Mutex::new(Vec::new()),
        })
    }

    fn set_mode(&self, mode: Option<NotchMode>) {
        *self.mode.lock().unwrap() = mode;
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

impl AlertNotch for FakeNotch {
    fn mode(&self) -> Option<NotchMode> {
        *self.mode.lock().unwrap()
    }

    fn emit(&self, alert: &RedmineAlert) {
        self.calls.lock().unwrap().push(format!(
            "redmine:alert {}",
            serde_json::to_string(alert).unwrap()
        ));
    }

    fn dispatch(&self, event: NotchEvent) {
        self.calls
            .lock()
            .unwrap()
            .push(format!("dispatch {event:?}"));
    }
}

fn alert() -> RedmineAlert {
    RedmineAlert {
        hours: 2.5,
        target: 8.0,
    }
}

const SHOWN: [&str; 2] = [
    r#"redmine:alert {"hours":2.5,"target":8.0}"#,
    "dispatch Redmine { on: true }",
];

#[test]
fn alert_is_refused_with_a_panel_open_or_without_notch() {
    // No notch window: refused, nothing sent.
    let absent = FakeNotch::new(None);
    assert!(!offer(absent.as_ref(), alert()));
    assert!(absent.calls().is_empty());
    // Every panel mode: refused, nothing sent (the controller would drop it).
    for mode in PANEL_MODES {
        let notch = FakeNotch::new(Some(mode));
        assert!(!offer(notch.as_ref(), alert()), "{mode:?}");
        assert!(notch.calls().is_empty(), "{mode:?}");
    }
    // Any other mode: the payload first, then the capsule alert.
    for mode in [
        NotchMode::Compact,
        NotchMode::Peek,
        NotchMode::Alert,
        NotchMode::Mini,
        NotchMode::Hidden,
    ] {
        let notch = FakeNotch::new(Some(mode));
        assert!(offer(notch.as_ref(), alert()), "{mode:?}");
        assert_eq!(notch.calls(), SHOWN, "{mode:?}");
    }
}

/// `{enabled: true, time: "18:00"}`, target 8 h.
struct FixedSettings;

impl EndOfDaySettings for FixedSettings {
    fn get(&self) -> RedmineSettings {
        RedmineSettings {
            url: "https://redmine.example.test".into(),
            daily_target_hours: 8.0,
            end_of_day: RedmineEndOfDaySettings {
                enabled: true,
                time: "18:00".into(),
                sound: true,
            },
        }
    }

    fn on_change(&self, _listener: SettingsListener) {}

    fn integration_enabled(&self) -> bool {
        true
    }
}

struct FakeReadings {
    hours: Mutex<Option<f64>>,
    status: Mutex<RedmineStatus>,
}

impl Readings for FakeReadings {
    fn today_hours(&self) -> Option<f64> {
        *self.hours.lock().unwrap()
    }

    fn status(&self) -> RedmineStatus {
        *self.status.lock().unwrap()
    }
}

/// `powerMonitor`: the listeners the wiring subscribed, fired by hand.
#[derive(Default)]
struct FakePower(Mutex<Vec<PowerListener>>);

impl FakePower {
    fn fire(&self, event: PowerEvent) {
        let listeners = self.0.lock().unwrap().clone();
        for listener in listeners {
            listener(event);
        }
    }
}

impl PowerSource for FakePower {
    fn subscribe(&self, listener: PowerListener) {
        self.0.lock().unwrap().push(listener);
    }
}

struct H {
    clock: Arc<WallClock>,
    notch: Arc<FakeNotch>,
    readings: Arc<FakeReadings>,
    power: FakePower,
    end_of_day: Arc<EndOfDay<chrono_tz::Tz>>,
    /// The integration outlives the scheduler in the app; here the harness keeps it.
    _redmine: Arc<dyn Readings>,
}

/// Monday 16 Nov 2026 at `h:m` in Madrid, started; `status` and 2.5 h logged today.
fn started_at(h: u32, m: u32, status: RedmineStatus) -> H {
    let clock = Arc::new(WallClock::fixed(local(2026, 11, 16, h, m, 0)));
    let notch = FakeNotch::new(Some(NotchMode::Compact));
    let readings = Arc::new(FakeReadings {
        hours: Mutex::new(Some(2.5)),
        status: Mutex::new(status),
    });
    let power = FakePower::default();
    let redmine: Arc<dyn Readings> = Arc::clone(&readings) as Arc<dyn Readings>;
    let end_of_day = install_end_of_day(
        EndOfDayWiring {
            settings: Arc::new(FixedSettings),
            clock: Arc::clone(&clock),
            // Never advanced: the PC sleeps through 18:00, its timers stall.
            timers: Arc::new(TestTimers::new()),
            redmine: Arc::downgrade(&redmine),
            notch: Arc::clone(&notch) as Arc<dyn AlertNotch>,
        },
        Madrid,
        &power,
    );
    end_of_day.start();
    H {
        clock,
        notch,
        readings,
        power,
        end_of_day,
        _redmine: redmine,
    }
}

#[test]
fn power_resume_runs_the_end_of_day_check() {
    let t = started_at(17, 0, RedmineStatus::Ok);
    assert_eq!(t.power.0.lock().unwrap().len(), 1);
    // Asleep from 17:00 to 18:20: no timer fired, so nothing alerted yet.
    t.clock.advance(80 * MINUTE_MS);
    assert!(t.notch.calls().is_empty());
    // The PC wakes: within the grace hour the alert is offered, payload first.
    t.power.fire(PowerEvent::Resume);
    assert_eq!(t.notch.calls(), SHOWN);
    // Never twice the same day: an unlock right after offers nothing more.
    t.power.fire(PowerEvent::Unlock);
    t.power.fire(PowerEvent::Resume);
    assert_eq!(t.notch.calls().len(), 2);
    // Disposed: a late power event is a no-op.
    t.end_of_day.dispose();
    t.clock.advance(24 * 60 * MINUTE_MS);
    t.power.fire(PowerEvent::Resume);
    assert_eq!(t.notch.calls().len(), 2);
}

#[test]
fn a_resume_with_a_panel_open_waits_until_it_closes_within_the_grace_window() {
    let t = started_at(17, 0, RedmineStatus::Ok);
    t.notch.set_mode(Some(NotchMode::Redmine));
    t.clock.advance(70 * MINUTE_MS);
    t.power.fire(PowerEvent::Unlock);
    assert!(t.notch.calls().is_empty());
    // The panel closes; the next check (here an unlock) shows it.
    t.notch.set_mode(Some(NotchMode::Compact));
    t.power.fire(PowerEvent::Unlock);
    assert_eq!(t.notch.calls(), SHOWN);
}

#[test]
fn the_end_of_day_reads_the_session_and_hours_of_the_integration() {
    // Without a usable session (unconfigured, or a rejected key) nothing is offered.
    for status in [RedmineStatus::Unconfigured, RedmineStatus::AuthError] {
        let t = started_at(17, 0, status);
        t.clock.advance(70 * MINUTE_MS);
        t.power.fire(PowerEvent::Resume);
        assert!(t.notch.calls().is_empty(), "{status:?}");
    }
    // Offline still counts as connected: the last hours read are used.
    let t = started_at(17, 0, RedmineStatus::Offline);
    t.clock.advance(70 * MINUTE_MS);
    // No reading yet: the day stays open.
    *t.readings.hours.lock().unwrap() = None;
    t.power.fire(PowerEvent::Resume);
    assert!(t.notch.calls().is_empty());
    *t.readings.hours.lock().unwrap() = Some(2.5);
    t.power.fire(PowerEvent::Resume);
    assert_eq!(t.notch.calls(), SHOWN);
    // The target reached: nothing to alert about.
    let reached = started_at(17, 0, RedmineStatus::Ok);
    *reached.readings.hours.lock().unwrap() = Some(8.0);
    reached.clock.advance(70 * MINUTE_MS);
    reached.power.fire(PowerEvent::Resume);
    assert!(reached.notch.calls().is_empty());
}

#[test]
fn an_integration_that_is_gone_offers_nothing() {
    let clock = Arc::new(WallClock::fixed(local(2026, 11, 16, 18, 10, 0)));
    let notch = FakeNotch::new(Some(NotchMode::Compact));
    let power = FakePower::default();
    let gone: Arc<dyn Readings> = Arc::new(FakeReadings {
        hours: Mutex::new(Some(1.0)),
        status: Mutex::new(RedmineStatus::Ok),
    });
    let redmine = Arc::downgrade(&gone);
    drop(gone);
    let end_of_day = install_end_of_day(
        EndOfDayWiring {
            settings: Arc::new(FixedSettings),
            clock,
            timers: Arc::new(TestTimers::new()),
            redmine,
            notch: Arc::clone(&notch) as Arc<dyn AlertNotch>,
        },
        Madrid,
        &power,
    );
    end_of_day.start();
    power.fire(PowerEvent::Resume);
    assert!(notch.calls().is_empty());
}
