//! Port of `tests/unit/main/system-ipc.test.ts` (every case), plus the integration's start
//! behaviour (`system-integration.ts`: pending order, current mode, unavailable).

use std::sync::atomic::AtomicU64;

use serde_json::json;
use tauri::async_runtime::block_on;

use super::*;
use crate::contract::system::{ProcessRow, SystemMetrics, Unavailable};
use crate::ipc::{Sender, CONTROL_CENTER, NOTCH};
use crate::services::timers::TestTimers;
use crate::settings::default_settings;
use crate::system::fake::FakeSystemApi;

const START: &str = "2026-11-10T09:00:00.000Z";
const OTHER: &str = "other";

#[derive(Default)]
struct Fake {
    orders: Mutex<Vec<ProcessOrder>>,
    kills: Mutex<Vec<KillInput>>,
}

impl SystemControl for Fake {
    fn set_order(&self, by: ProcessOrder) {
        self.orders.lock().unwrap().push(by);
    }

    fn kill(&self, input: &KillInput) -> KillResult {
        self.kills.lock().unwrap().push(input.clone());
        KillResult::Killed
    }
}

struct Fx {
    fake: Arc<Fake>,
    registry: Registry,
}

fn setup() -> Fx {
    let fake = Arc::new(Fake::default());
    let slot = Arc::new(SystemSlot::new());
    assert!(slot
        .set(Arc::clone(&fake) as Arc<dyn SystemControl>)
        .is_ok());
    let mut registry = Registry::with_dev_origin(false);
    register(&mut registry, &slot);
    Fx { fake, registry }
}

impl Fx {
    fn invoke(&self, channel: &str, label: &str, input: Option<Value>) -> Value {
        let ctx = Ctx::for_test(Sender {
            label: label.into(),
            url: format!("http://tauri.localhost/{label}/index.html")
                .parse()
                .unwrap(),
        });
        block_on(self.registry.dispatch(&ctx, channel, input))
    }

    fn untouched(&self) -> bool {
        self.fake.orders.lock().unwrap().is_empty() && self.fake.kills.lock().unwrap().is_empty()
    }
}

#[test]
fn sets_the_process_order() {
    let fx = setup();
    assert_eq!(
        fx.invoke("system:view", NOTCH, Some(json!({ "by": "ram" }))),
        json!({ "ok": true, "data": null })
    );
    assert_eq!(
        fx.fake.orders.lock().unwrap().last(),
        Some(&ProcessOrder::Ram)
    );
    fx.invoke("system:view", NOTCH, Some(json!({ "by": "cpu" })));
    assert_eq!(
        fx.fake.orders.lock().unwrap().last(),
        Some(&ProcessOrder::Cpu)
    );
}

#[test]
fn closes_a_process_and_returns_the_result() {
    let fx = setup();
    assert_eq!(
        fx.invoke(
            "system:kill-process",
            NOTCH,
            Some(json!({ "pid": 42, "startTime": START }))
        ),
        json!({ "ok": true, "data": "killed" })
    );
    assert_eq!(
        *fx.fake.kills.lock().unwrap(),
        [KillInput {
            pid: 42,
            start_time: START.into()
        }]
    );
}

#[test]
fn both_channels_are_forbidden_outside_the_notch() {
    for channel in ["system:view", "system:kill-process"] {
        let fx = setup();
        let input = if channel == "system:view" {
            json!({ "by": "cpu" })
        } else {
            json!({ "pid": 42, "startTime": START })
        };
        for label in [CONTROL_CENTER, OTHER] {
            let answer = fx.invoke(channel, label, Some(input.clone()));
            assert_eq!(answer["ok"], false, "{channel} from {label}");
            assert_eq!(
                answer["error"]["code"], "FORBIDDEN",
                "{channel} from {label}"
            );
        }
        assert!(fx.untouched());
    }
}

#[test]
fn rejects_invalid_inputs_as_invalid_input() {
    let cases: [(&str, Option<Value>); 10] = [
        ("system:view", Some(json!({ "open": true }))),
        ("system:view", Some(json!({ "by": "cpu", "open": false }))),
        ("system:view", Some(json!({ "by": "disk" }))),
        ("system:view", Some(json!({ "by": "cpu", "extra": 1 }))),
        ("system:view", None),
        (
            "system:kill-process",
            Some(json!({ "pid": 0, "startTime": START })),
        ),
        (
            "system:kill-process",
            Some(json!({ "pid": 1.5, "startTime": START })),
        ),
        ("system:kill-process", Some(json!({ "pid": 42 }))),
        (
            "system:kill-process",
            Some(json!({ "pid": 42, "startTime": "x".repeat(41) })),
        ),
        (
            "system:kill-process",
            Some(json!({ "pid": 42, "startTime": START, "name": "chrome.exe" })),
        ),
    ];
    for (channel, input) in cases {
        let fx = setup();
        let answer = fx.invoke(channel, NOTCH, input.clone());
        assert_eq!(answer["ok"], false, "{channel} {input:?}");
        assert_eq!(
            answer["error"]["code"], "INVALID_INPUT",
            "{channel} {input:?}"
        );
        assert!(fx.untouched());
    }
}

#[test]
fn answers_unavailable_before_setup_fills_the_slot() {
    let slot = Arc::new(SystemSlot::new());
    let mut registry = Registry::with_dev_origin(false);
    register(&mut registry, &slot);
    let fx = Fx {
        fake: Arc::new(Fake::default()),
        registry,
    };
    let answer = fx.invoke("system:view", NOTCH, Some(json!({ "by": "cpu" })));
    assert_eq!(answer["error"]["code"], "UNAVAILABLE");
}

// --- integration ---

type Sent = Arc<Mutex<Vec<SystemMetrics>>>;

fn options(
    api: Option<Arc<dyn SystemApi>>,
    timers: Arc<TestTimers>,
    sent: &Sent,
    rows: &Arc<Mutex<Vec<Vec<ProcessRow>>>>,
) -> StartOptions {
    let clock = Arc::new(AtomicU64::new(0));
    StartOptions {
        api,
        timers,
        now: Arc::new(move || clock.load(Ordering::SeqCst)),
        executor: Arc::new(|job| job()),
        alert_settings: Box::new(|| default_settings("en").system_alerts),
        on_metrics: {
            let sent = Arc::clone(sent);
            Box::new(move |metrics| sent.lock().unwrap().push(metrics.clone()))
        },
        on_processes: {
            let rows = Arc::clone(rows);
            Box::new(move |list| rows.lock().unwrap().push(list.to_vec()))
        },
    }
}

#[test]
fn start_applies_the_current_mode_and_replays_an_order_received_before_it() {
    let api = Arc::new(FakeSystemApi::new());
    {
        let mut state = api.state();
        state.entries.push(crate::system::ProcessEntry {
            pid: 10,
            parent_pid: 1,
            name: "p10".into(),
        });
    }
    let timers = Arc::new(TestTimers::new());
    let sent: Sent = Arc::default();
    let rows = Arc::default();
    let system = SystemIntegration::new();
    // Before start: the order is kept, the mode is ignored and nothing is sampled.
    system.set_order(ProcessOrder::Ram);
    system.set_mode(NotchMode::Compact);
    system.resync();
    assert_eq!(
        system.kill(&KillInput {
            pid: 10,
            start_time: "t".into()
        }),
        KillResult::NotKillable
    );
    assert!(sent.lock().unwrap().is_empty());
    system.start(
        options(
            Some(api as Arc<dyn SystemApi>),
            Arc::clone(&timers),
            &sent,
            &rows,
        ),
        || NotchMode::Compact,
    );
    let first = sent.lock().unwrap().clone();
    assert_eq!(first.len(), 1);
    assert!(matches!(first[0], SystemMetrics::Light(_)));
    system.set_mode(NotchMode::System);
    timers.advance(super::super::monitor::WARMUP_MS);
    assert!(matches!(
        sent.lock().unwrap().last(),
        Some(SystemMetrics::Full(_))
    ));
    assert_eq!(rows.lock().unwrap().len(), 1);
    system.dispose();
    timers.advance(10_000);
    assert_eq!(rows.lock().unwrap().len(), 1);
}

#[test]
fn start_without_the_win32_api_reports_unavailable_and_again_on_order_and_resync() {
    let timers = Arc::new(TestTimers::new());
    let sent: Sent = Arc::default();
    let rows = Arc::default();
    let system = SystemIntegration::new();
    system.start(options(None, timers, &sent, &rows), || NotchMode::Compact);
    let unavailable = SystemMetrics::Unavailable(Unavailable {});
    assert_eq!(*sent.lock().unwrap(), std::slice::from_ref(&unavailable));
    system.set_order(ProcessOrder::Cpu);
    system.resync();
    assert_eq!(
        *sent.lock().unwrap(),
        [unavailable.clone(), unavailable.clone(), unavailable]
    );
    assert_eq!(
        system.kill(&KillInput {
            pid: 1,
            start_time: "t".into()
        }),
        KillResult::NotKillable
    );
}

#[test]
fn a_start_after_dispose_does_nothing() {
    let sent: Sent = Arc::default();
    let rows = Arc::default();
    let system = SystemIntegration::new();
    system.dispose();
    system.start(
        options(None, Arc::new(TestTimers::new()), &sent, &rows),
        || NotchMode::Compact,
    );
    assert!(sent.lock().unwrap().is_empty());
}
