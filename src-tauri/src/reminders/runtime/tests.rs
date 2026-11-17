//! 0.1.0's `reminders-runtime.test.ts` (11 cases, the `it.each` one as a table) plus
//! `missed_on_start_fires_one_missed_toast_only`. Timers that never fire record their delays,
//! like the TS fakes; the wall clock is frozen and moved by hand.

use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};
use std::sync::Mutex;

use chrono::{DateTime, Duration, SecondsFormat, TimeZone, Utc};
use chrono_tz::Europe::Madrid;
use chrono_tz::Tz;
use serde_json::json;
use tauri::async_runtime::block_on;

use super::*;
use crate::contract::reminders::{ReminderRepeat, ReminderState, ReminderText};
use crate::ipc::{IpcErrorCode, Registry, Sender, NOTCH};
use crate::reminders::ipc::{register, RemindersApi, RemindersSlot};
use crate::services::timers::{TimerCallback, TimerId};

const MIN: i64 = 60_000;

fn t0() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 10, 11, 0, 0).unwrap()
}

fn plus(ms: i64) -> DateTime<Utc> {
    t0() + Duration::milliseconds(ms)
}

fn uuid(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn reminder(n: usize, due_at: DateTime<Utc>) -> Reminder {
    Reminder {
        id: uuid(n),
        text: ReminderText::new(&format!("secret-text-{n}")).unwrap(),
        due_at: iso(due_at),
        repeat: ReminderRepeat::None,
        local_time: None,
        state: ReminderState::Pending,
        created_at: iso(plus(-60 * MIN)),
        completed_at: None,
    }
}

enum Load {
    Outcome(LoadOutcome),
    Fail,
}

struct MemoryStore {
    items: Mutex<Vec<Reminder>>,
    load: Load,
    gate: Option<tokio::sync::watch::Receiver<bool>>,
}

impl ReminderStore for MemoryStore {
    fn all(&self) -> Vec<Reminder> {
        self.items.lock().unwrap().clone()
    }

    fn write(&self, next: Vec<Reminder>) -> BoxFuture<'_, Result<(), ExposedError>> {
        *self.items.lock().unwrap() = next;
        Box::pin(async { Ok(()) })
    }
}

impl RuntimeStore for MemoryStore {
    fn load(&self) -> BoxFuture<'_, Result<LoadOutcome, ExposedError>> {
        Box::pin(async move {
            if let Some(gate) = &self.gate {
                let _ = gate.clone().wait_for(|open| *open).await;
            }
            match self.load {
                Load::Outcome(outcome) => Ok(outcome),
                Load::Fail => Err(ExposedError::internal("disk")),
            }
        })
    }
}

/// Records delays; never fires (`setTimeout` fake of the TS test): virtual timers never advanced.
#[derive(Default)]
struct DelayTimers {
    delays: Mutex<Vec<u64>>,
    inner: crate::services::timers::TestTimers,
}

impl Timers for DelayTimers {
    fn set_timeout(&self, ms: u64, f: TimerCallback) -> TimerId {
        self.delays.lock().unwrap().push(ms);
        self.inner.set_timeout(ms, f)
    }

    fn clear(&self, id: TimerId) {
        self.inner.clear(id);
    }
}

#[derive(Default)]
struct Toasts {
    fired: Mutex<Vec<Vec<String>>>,
    missed: Mutex<Vec<usize>>,
}

impl ToastSink for Toasts {
    fn fired(&self, batch: &[Reminder]) {
        self.fired
            .lock()
            .unwrap()
            .push(batch.iter().map(|r| r.id.clone()).collect());
    }

    fn missed(&self, count: usize) {
        self.missed.lock().unwrap().push(count);
    }
}

type Shared<T> = Arc<Mutex<Vec<T>>>;

struct Fx {
    runtime: Arc<RemindersRuntime<Tz>>,
    clock: Arc<WallClock>,
    timers: Arc<DelayTimers>,
    toast: Arc<Toasts>,
    set_due: Shared<bool>,
    changed: Shared<RemindersSnapshot>,
    fired: Shared<u64>,
    usage: Shared<UsageEvent>,
    snooze: Arc<AtomicU32>,
    set_due_panics: Arc<std::sync::atomic::AtomicBool>,
}

#[derive(Default)]
struct Opts {
    load: Option<Load>,
    seed: Vec<Reminder>,
    gate: Option<tokio::sync::watch::Receiver<bool>>,
}

fn setup(opts: Opts) -> Fx {
    let clock = Arc::new(WallClock::fixed(t0()));
    let store = Arc::new(MemoryStore {
        items: Mutex::new(opts.seed),
        load: opts.load.unwrap_or(Load::Outcome(LoadOutcome::Ok)),
        gate: opts.gate,
    });
    let seq = Arc::new(AtomicUsize::new(100));
    let snooze = Arc::new(AtomicU32::new(10));
    let timers = Arc::new(DelayTimers::default());
    let toast = Arc::new(Toasts::default());
    let set_due: Shared<bool> = Arc::default();
    let changed: Shared<RemindersSnapshot> = Arc::default();
    let fired: Shared<u64> = Arc::default();
    let usage: Shared<UsageEvent> = Arc::default();
    let set_due_panics = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let runtime = RemindersRuntime::new(
        RuntimeOptions {
            store,
            clock: Arc::clone(&clock),
            new_id: Box::new(move || uuid(seq.fetch_add(1, Ordering::SeqCst) + 1)),
            snooze_minutes: {
                let snooze = Arc::clone(&snooze);
                Box::new(move || snooze.load(Ordering::SeqCst))
            },
            timers: Arc::clone(&timers) as Arc<dyn Timers>,
            safety: None,
            toast: Arc::clone(&toast) as Arc<dyn ToastSink>,
            set_due: {
                let (set_due, panics) = (Arc::clone(&set_due), Arc::clone(&set_due_panics));
                Box::new(move |due| {
                    if panics.load(Ordering::SeqCst) {
                        panic!("window gone secret-text-x");
                    }
                    set_due.lock().unwrap().push(due);
                })
            },
            emit_changed: {
                let changed = Arc::clone(&changed);
                Box::new(move |snapshot| changed.lock().unwrap().push(snapshot.clone()))
            },
            emit_fired: {
                let fired = Arc::clone(&fired);
                Box::new(move |count| fired.lock().unwrap().push(count))
            },
            record_usage: Some({
                let usage = Arc::clone(&usage);
                Box::new(move |event| usage.lock().unwrap().push(event))
            }),
        },
        Madrid,
    );
    Fx {
        runtime,
        clock,
        timers,
        toast,
        set_due,
        changed,
        fired,
        usage,
        snooze,
        set_due_panics,
    }
}

fn last<T: Clone>(list: &Shared<T>) -> Option<T> {
    list.lock().unwrap().last().cloned()
}

fn all<T: Clone>(list: &Shared<T>) -> Vec<T> {
    list.lock().unwrap().clone()
}

impl Fx {
    fn start(&self) {
        block_on(self.runtime.start()).unwrap();
    }

    fn check(&self) {
        block_on(self.runtime.check());
    }

    fn advance(&self, ms: i64) {
        self.clock.advance(ms);
    }

    fn last_delay(&self) -> Option<u64> {
        self.timers.delays.lock().unwrap().last().copied()
    }

    fn toast_fired(&self) -> Vec<Vec<String>> {
        self.toast.fired.lock().unwrap().clone()
    }

    fn toast_missed(&self) -> Vec<usize> {
        self.toast.missed.lock().unwrap().clone()
    }
}

#[test]
fn maps_each_load_outcome_to_its_notice() {
    for (load, notice) in [
        (LoadOutcome::Ok, None),
        (LoadOutcome::Quarantined, Some(StoreNotice::Quarantined)),
        (LoadOutcome::ReadOnly, Some(StoreNotice::ReadOnly)),
    ] {
        let fx = setup(Opts {
            load: Some(Load::Outcome(load)),
            ..Opts::default()
        });
        fx.start();
        assert_eq!(fx.runtime.snapshot().notice, notice, "{load:?}");
        assert_eq!(
            last(&fx.changed),
            Some(RemindersSnapshot {
                reminders: vec![],
                notice
            })
        );
    }
}

#[test]
fn publishes_the_initial_state_after_start_without_toasts_when_nothing_is_overdue() {
    let future = reminder(1, plus(30 * MIN));
    let fx = setup(Opts {
        seed: vec![future.clone()],
        ..Opts::default()
    });
    fx.start();
    assert_eq!(last(&fx.set_due), Some(false));
    assert_eq!(
        last(&fx.changed),
        Some(RemindersSnapshot {
            reminders: vec![future],
            notice: None
        })
    );
    assert!(fx.toast_fired().is_empty());
    assert!(fx.toast_missed().is_empty());
    assert!(all(&fx.fired).is_empty());
    assert_eq!(fx.last_delay(), Some(30 * MIN as u64));
}

#[test]
fn reports_reminders_missed_while_the_app_was_closed_with_one_toast_and_one_chime() {
    let fx = setup(Opts {
        seed: vec![reminder(1, plus(-120 * MIN)), reminder(2, plus(-60 * MIN))],
        ..Opts::default()
    });
    fx.start();
    assert_eq!(fx.toast_missed(), [2]);
    assert_eq!(all(&fx.fired), [2]);
    assert_eq!(last(&fx.set_due), Some(true));
    let states: Vec<ReminderState> = last(&fx.changed)
        .unwrap()
        .reminders
        .iter()
        .map(|r| r.state)
        .collect();
    assert_eq!(states, [ReminderState::Missed, ReminderState::Missed]);
}

#[test]
fn missed_on_start_fires_one_missed_toast_only() {
    let fx = setup(Opts {
        seed: vec![reminder(1, plus(-120 * MIN)), reminder(2, plus(-60 * MIN))],
        ..Opts::default()
    });
    fx.start();
    assert_eq!(fx.toast_missed(), [2]);
    assert!(fx.toast_fired().is_empty());
    assert_eq!(all(&fx.fired), [2]);
    // `reminders-missed`, and not also `reminders-fired`.
    assert_eq!(all(&fx.usage), [UsageEvent::RemindersMissed { count: 2.0 }]);
    // A later check has nothing new to fire.
    fx.check();
    assert!(fx.toast_fired().is_empty());
    assert_eq!(all(&fx.usage).len(), 1);
}

#[test]
fn records_missed_fired_and_completed_reminders_in_the_usage_log() {
    let fx = setup(Opts {
        seed: vec![
            reminder(1, plus(-60 * MIN)),
            reminder(2, plus(5 * MIN)),
            reminder(3, plus(6 * MIN)),
        ],
        ..Opts::default()
    });
    fx.start();
    assert_eq!(all(&fx.usage), [UsageEvent::RemindersMissed { count: 1.0 }]);
    fx.advance(10 * MIN);
    fx.check();
    assert_eq!(
        last(&fx.usage),
        Some(UsageEvent::RemindersFired { count: 2.0 })
    );
    block_on(fx.runtime.service().complete(&uuid(2))).unwrap();
    assert_eq!(last(&fx.usage), Some(UsageEvent::ReminderCompleted));
    // A refused completion (already done) is not counted.
    assert!(block_on(fx.runtime.service().complete(&uuid(2))).is_err());
    assert_eq!(all(&fx.usage).len(), 3);
}

#[test]
fn after_a_create_publishes_keeps_due_off_and_aims_the_timer_at_the_new_reminder() {
    let fx = setup(Opts::default());
    fx.start();
    fx.set_due.lock().unwrap().clear();
    fx.changed.lock().unwrap().clear();
    let input =
        CreateReminderInput::from_input(json!({ "text": "Revisar PR", "preset": "15m" })).unwrap();
    let created = block_on(fx.runtime.service().create(input)).unwrap();
    assert!(all(&fx.set_due).contains(&false));
    assert_eq!(
        last(&fx.changed),
        Some(RemindersSnapshot {
            reminders: vec![created],
            notice: None
        })
    );
    assert_eq!(fx.last_delay(), Some(15 * MIN as u64));
}

#[test]
fn fires_a_batch_on_check_toast_chime_and_due_on() {
    let fx = setup(Opts {
        seed: vec![reminder(1, plus(5 * MIN)), reminder(2, plus(6 * MIN))],
        ..Opts::default()
    });
    fx.start();
    fx.advance(10 * MIN);
    fx.check();
    assert_eq!(fx.toast_fired(), [vec![uuid(1), uuid(2)]]);
    assert_eq!(all(&fx.fired), [2]);
    assert_eq!(last(&fx.set_due), Some(true));
}

#[test]
fn snoozing_with_the_live_setting_turns_due_off_and_moves_the_timer() {
    let fx = setup(Opts {
        seed: vec![reminder(1, plus(5 * MIN))],
        ..Opts::default()
    });
    fx.start();
    fx.advance(5 * MIN);
    fx.check();
    assert_eq!(last(&fx.set_due), Some(true));
    fx.snooze.store(30, Ordering::SeqCst);
    block_on(fx.runtime.service().snooze(&uuid(1))).unwrap();
    assert_eq!(last(&fx.set_due), Some(false));
    assert_eq!(fx.last_delay(), Some(30 * MIN as u64));
}

#[test]
fn stops_reacting_after_dispose() {
    let fx = setup(Opts {
        seed: vec![reminder(1, plus(5 * MIN))],
        ..Opts::default()
    });
    fx.start();
    fx.runtime.dispose();
    fx.advance(10 * MIN);
    fx.check();
    assert!(fx.toast_fired().is_empty());
}

#[test]
fn never_logs_reminder_text() {
    let capture = crate::services::test_log::capture().expect("the test logger");
    let fx = setup(Opts {
        seed: vec![reminder(1, plus(-MIN)), reminder(2, plus(MIN))],
        ..Opts::default()
    });
    fx.start();
    fx.advance(2 * MIN);
    fx.check();
    let lines = capture.lines();
    assert!(lines.iter().any(|line| line.contains("Reminders fired")));
    assert!(lines.iter().all(|line| !line.contains("secret-text")));
}

fn ctx(label: &str) -> crate::ipc::Ctx {
    crate::ipc::Ctx::for_test(Sender {
        label: label.into(),
        url: format!("http://tauri.localhost/{label}/index.html")
            .parse()
            .unwrap(),
    })
}

#[test]
fn ipc_calls_made_before_start_finishes_wait_for_the_loaded_store() {
    let (open, gate) = tokio::sync::watch::channel(false);
    let future = reminder(1, plus(30 * MIN));
    let fx = setup(Opts {
        seed: vec![future.clone()],
        load: Some(Load::Outcome(LoadOutcome::Quarantined)),
        gate: Some(gate),
    });
    let slot = Arc::new(RemindersSlot::new());
    assert!(slot
        .set(Arc::clone(&fx.runtime) as Arc<dyn RemindersApi>)
        .is_ok());
    let mut registry = Registry::with_dev_origin(false);
    register(&mut registry, &slot);
    let registry = Arc::new(registry);

    let runtime = Arc::clone(&fx.runtime);
    let starting = tauri::async_runtime::spawn(async move { runtime.start().await });
    let settled = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let list = {
        let (registry, settled) = (Arc::clone(&registry), Arc::clone(&settled));
        tauri::async_runtime::spawn(async move {
            let response = registry.dispatch(&ctx(NOTCH), "reminders:list", None).await;
            settled.store(true, Ordering::SeqCst);
            response
        })
    };
    let created = {
        let registry = Arc::clone(&registry);
        tauri::async_runtime::spawn(async move {
            registry
                .dispatch(
                    &ctx(NOTCH),
                    "reminders:create",
                    Some(json!({ "text": "Otro", "preset": "1h" })),
                )
                .await
        })
    };
    std::thread::sleep(std::time::Duration::from_millis(50));
    assert!(!settled.load(Ordering::SeqCst));

    open.send_replace(true);
    block_on(starting).unwrap().unwrap();
    // Mutations run after the load too, so the early list sees the file and the notice. (Both
    // calls wake together at the gate; unlike JS microtasks, either may finish first, so the
    // list may already hold the new one.)
    let listed = block_on(list).unwrap();
    assert_eq!(listed["ok"], true);
    assert_eq!(listed["data"]["notice"], "quarantined");
    assert_eq!(listed["data"]["reminders"][0], json!(future));
    assert_eq!(block_on(created).unwrap()["data"]["text"], "Otro");
    assert_eq!(fx.runtime.snapshot().reminders.len(), 2);
}

#[test]
fn ready_resolves_even_when_start_fails() {
    let fx = setup(Opts {
        load: Some(Load::Fail),
        ..Opts::default()
    });
    let error = block_on(fx.runtime.start()).unwrap_err();
    assert_eq!(error.code(), IpcErrorCode::Internal);
    block_on(fx.runtime.ready());
    fx.runtime.dispose();
}

#[test]
fn a_throwing_publish_does_not_fail_a_change_that_was_saved() {
    let capture = crate::services::test_log::capture().expect("the test logger");
    let fx = setup(Opts::default());
    fx.start();
    fx.set_due_panics.store(true, Ordering::SeqCst);
    let input =
        CreateReminderInput::from_input(json!({ "text": "secret-text-9", "preset": "15m" }))
            .unwrap();
    let created = block_on(fx.runtime.service().create(input)).unwrap();
    assert_eq!(created.text.as_str(), "secret-text-9");
    assert_eq!(fx.runtime.snapshot().reminders.len(), 1);
    let lines = capture.lines();
    assert!(lines
        .iter()
        .any(|line| line.starts_with("ERROR") && line.ends_with("Publishing reminders failed")));
    assert!(lines.iter().all(|line| !line.contains("secret-text")));
}

#[test]
fn the_power_listener_starts_a_check() {
    let fx = setup(Opts {
        seed: vec![reminder(1, plus(5 * MIN))],
        ..Opts::default()
    });
    fx.start();
    fx.advance(5 * MIN);
    (fx.runtime.power_listener())(crate::platform::power::PowerEvent::Resume);
    block_on(fx.runtime.check());
    assert_eq!(fx.toast_fired(), [vec![uuid(1)]]);
}
