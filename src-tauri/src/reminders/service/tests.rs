//! `tests/unit/main/reminders-service.test.ts`, in Europe/Madrid like the TS suite.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard, PoisonError};

use chrono_tz::Europe::Madrid;
use chrono_tz::Tz;
use serde_json::json;
use tauri::async_runtime::block_on;

use super::*;
use crate::contract::reminders::{
    ReminderRepeat, ReminderState, ReminderText, REMINDERS_ACTIVE_MAX,
};
use crate::ipc::IpcErrorCode;
use crate::reminders::time::tests::local;

fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
    local(y, mo, d, h, mi, 0)
}

fn uuid(n: usize) -> String {
    format!("00000000-0000-4000-8000-{n:012}")
}

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `reminder(n, over)`: pending, one-off, due 2026-11-10 15:00 local.
fn reminder(n: usize) -> Reminder {
    Reminder {
        id: uuid(n),
        text: ReminderText::new(&format!("r{n}")).unwrap(),
        due_at: iso(at(2026, 11, 10, 15, 0)),
        repeat: ReminderRepeat::None,
        local_time: None,
        state: ReminderState::Pending,
        created_at: iso(at(2026, 11, 1, 9, 0)),
        completed_at: None,
    }
}

fn with(n: usize, change: impl FnOnce(&mut Reminder)) -> Reminder {
    let mut r = reminder(n);
    change(&mut r);
    r
}

fn done(n: usize, completed_at: DateTime<Utc>) -> Reminder {
    with(n, |r| {
        r.state = ReminderState::Done;
        r.completed_at = Some(iso(completed_at));
    })
}

fn daily(n: usize, state: ReminderState, due_at: DateTime<Utc>) -> Reminder {
    with(n, |r| {
        r.repeat = ReminderRepeat::Daily;
        r.local_time = Some("09:00".into());
        r.state = state;
        r.due_at = iso(due_at);
    })
}

fn create_input(value: serde_json::Value) -> CreateReminderInput {
    CreateReminderInput::from_input(value).unwrap()
}

fn update_input(value: serde_json::Value) -> UpdateReminderInput {
    UpdateReminderInput::from_input(value).unwrap()
}

enum WriteStep {
    Fail(ExposedError),
}

#[derive(Default)]
struct FakeStore {
    items: Mutex<Vec<Reminder>>,
    writes: AtomicUsize,
    steps: Mutex<VecDeque<WriteStep>>,
    /// Like the real store: the list only changes once the (suspended) write resumes.
    deferred: AtomicBool,
}

impl ReminderStore for FakeStore {
    fn all(&self) -> Vec<Reminder> {
        lock(&self.items).clone()
    }

    fn write(&self, next: Vec<Reminder>) -> BoxFuture<'_, Result<(), ExposedError>> {
        Box::pin(async move {
            self.writes.fetch_add(1, Ordering::SeqCst);
            let step = lock(&self.steps).pop_front();
            if let Some(WriteStep::Fail(error)) = step {
                return Err(error);
            }
            if self.deferred.load(Ordering::SeqCst) {
                for _ in 0..5 {
                    tokio::task::yield_now().await;
                }
            }
            *lock(&self.items) = next;
            Ok(())
        })
    }
}

struct Fx {
    service: RemindersService<Tz>,
    store: Arc<FakeStore>,
    clock: Arc<WallClock>,
    changes: Arc<AtomicUsize>,
    completions: Arc<AtomicUsize>,
    listener_panics: Arc<AtomicBool>,
    snooze: Arc<AtomicU32>,
}

impl Fx {
    fn new() -> Self {
        Self::at(at(2026, 11, 10, 12, 0), 10)
    }

    fn at(start: DateTime<Utc>, snooze_minutes: u32) -> Self {
        Self::with_ids(start, snooze_minutes, 0)
    }

    fn with_ids(start: DateTime<Utc>, snooze_minutes: u32, first_id: usize) -> Self {
        let store = Arc::new(FakeStore::default());
        let clock = Arc::new(WallClock::fixed(start));
        let changes = Arc::new(AtomicUsize::new(0));
        let completions = Arc::new(AtomicUsize::new(0));
        let listener_panics = Arc::new(AtomicBool::new(false));
        let snooze = Arc::new(AtomicU32::new(snooze_minutes));
        let seq = AtomicUsize::new(first_id);
        let options = {
            let changes = Arc::clone(&changes);
            let completions = Arc::clone(&completions);
            let panics = Arc::clone(&listener_panics);
            let panics_too = Arc::clone(&listener_panics);
            let snooze = Arc::clone(&snooze);
            RemindersOptions {
                store: Arc::clone(&store) as Arc<dyn ReminderStore>,
                clock: Arc::clone(&clock),
                new_id: Box::new(move || uuid(seq.fetch_add(1, Ordering::SeqCst) + 1)),
                snooze_minutes: Box::new(move || snooze.load(Ordering::SeqCst)),
                on_change: Box::new(move || {
                    changes.fetch_add(1, Ordering::SeqCst);
                    if panics.load(Ordering::SeqCst) {
                        panic!("listener broke");
                    }
                }),
                on_completed: Some(Box::new(move || {
                    completions.fetch_add(1, Ordering::SeqCst);
                    if panics_too.load(Ordering::SeqCst) {
                        panic!("listener broke");
                    }
                })),
            }
        };
        Self {
            service: RemindersService::new(options, Madrid),
            store,
            clock,
            changes,
            completions,
            listener_panics,
            snooze,
        }
    }

    /// `deferredSetup()`: writes suspend before the list changes; ids start at 101.
    fn deferred() -> Self {
        let fx = Self::with_ids(at(2026, 11, 10, 12, 0), 10, 100);
        fx.store.deferred.store(true, Ordering::SeqCst);
        fx
    }

    fn seed(&self, list: Vec<Reminder>) {
        *lock(&self.store.items) = list;
    }

    fn items(&self) -> Vec<Reminder> {
        self.store.all()
    }

    fn item(&self, n: usize) -> Reminder {
        self.items()
            .into_iter()
            .find(|r| r.id == uuid(n))
            .expect("reminder")
    }

    fn writes(&self) -> usize {
        self.store.writes.load(Ordering::SeqCst)
    }

    fn changes(&self) -> usize {
        self.changes.load(Ordering::SeqCst)
    }

    fn set_now(&self, to: DateTime<Utc>) {
        let delta = to - self.clock.now();
        self.clock.advance(delta.num_milliseconds());
    }

    fn fail_next_write(&self, error: ExposedError) {
        lock(&self.store.steps).push_back(WriteStep::Fail(error));
    }
}

fn rejects<T: std::fmt::Debug>(result: Result<T, ExposedError>, code: IpcErrorCode) -> String {
    let error = result.unwrap_err();
    assert_eq!(error.code(), code, "{}", error.message());
    error.message().to_owned()
}

fn ids(list: &[Reminder]) -> Vec<String> {
    list.iter().map(|r| r.id.clone()).collect()
}

// create

#[test]
fn parses_free_form_input_and_stores_a_pending_reminder() {
    let fx = Fx::new();
    let r = block_on(
        fx.service
            .create(create_input(json!({ "input": "en 30 min revisar PR" }))),
    )
    .unwrap();
    assert_eq!(
        r,
        Reminder {
            id: uuid(1),
            text: ReminderText::new("revisar PR").unwrap(),
            due_at: iso(at(2026, 11, 10, 12, 30)),
            repeat: ReminderRepeat::None,
            local_time: None,
            state: ReminderState::Pending,
            created_at: iso(at(2026, 11, 10, 12, 0)),
            completed_at: None,
        }
    );
    assert_eq!(fx.items(), [r]);
    assert_eq!(fx.changes(), 1);
}

#[test]
fn keeps_repeat_and_local_time_from_a_repeating_input() {
    let fx = Fx::new();
    let r = block_on(
        fx.service
            .create(create_input(json!({ "input": "diario 9:00 standup" }))),
    )
    .unwrap();
    assert_eq!(r.repeat, ReminderRepeat::Daily);
    assert_eq!(r.local_time.as_deref(), Some("09:00"));
    assert_eq!(r.due_at, iso(at(2026, 11, 11, 9, 0)));
}

#[test]
fn maps_parse_errors_to_invalid_input() {
    for code in ["empty-text", "no-time", "too-long"] {
        let fx = Fx::new();
        let input = match code {
            "empty-text" => "en 5 min".to_owned(),
            "no-time" => "hola".to_owned(),
            _ => format!("en 5 min {}", "x".repeat(201)),
        };
        let message = rejects(
            block_on(fx.service.create(create_input(json!({ "input": input })))),
            IpcErrorCode::InvalidInput,
        );
        assert_eq!(message, code);
        assert_eq!(fx.writes(), 0);
        assert_eq!(fx.changes(), 0);
    }
}

#[test]
fn uses_preset_due_at_for_text_and_preset() {
    let fx = Fx::new();
    let r = block_on(fx.service.create(create_input(
        json!({ "text": "llamar", "preset": "tomorrow-9" }),
    )))
    .unwrap();
    assert_eq!(r.due_at, iso(at(2026, 11, 11, 9, 0)));
    assert_eq!(r.state, ReminderState::Pending);
    let r2 = block_on(
        fx.service
            .create(create_input(json!({ "text": "otra", "preset": "1h" }))),
    )
    .unwrap();
    assert_eq!(r2.due_at, iso(at(2026, 11, 10, 13, 0)));
}

#[test]
fn rejects_control_characters_with_a_generic_invalid_input() {
    let fx = Fx::new();
    let message = rejects(
        block_on(fx.service.create(create_input(
            json!({ "input": "en 5 min hola\u{202E}mundo" }),
        ))),
        IpcErrorCode::InvalidInput,
    );
    assert_eq!(message, "Invalid reminder");
    assert_eq!(fx.writes(), 0);
}

#[test]
fn accepts_emoji_zwj_sequences_on_both_create_paths() {
    let fx = Fx::new();
    let text = "\u{1F469}\u{200D}\u{1F4BB} deploy";
    let parsed = block_on(
        fx.service
            .create(create_input(json!({ "input": format!("en 5 min {text}") }))),
    )
    .unwrap();
    assert_eq!(parsed.text.as_str(), text);
    let preset = block_on(
        fx.service
            .create(create_input(json!({ "text": text, "preset": "15m" }))),
    )
    .unwrap();
    assert_eq!(preset.text.as_str(), text);
}

#[test]
fn rejects_the_501st_non_done_reminder_but_ignores_done_ones() {
    let fx = Fx::new();
    let list: Vec<Reminder> = (1..=REMINDERS_ACTIVE_MAX).map(reminder).collect();
    let mut seeded = list.clone();
    seeded.push(done(9000, at(2026, 11, 9, 0, 0)));
    fx.seed(seeded);
    let message = rejects(
        block_on(
            fx.service
                .create(create_input(json!({ "input": "en 5 min x" }))),
        ),
        IpcErrorCode::InvalidInput,
    );
    assert_eq!(message, "limit");
    fx.seed(list[1..].to_vec());
    assert!(block_on(
        fx.service
            .create(create_input(json!({ "input": "en 5 min x" })))
    )
    .is_ok());
}

// create: { text, dueAt, repeat } (notch form)

#[test]
fn notch_form_stores_a_one_off_reminder_at_the_given_instant() {
    let fx = Fx::new();
    let due_at = iso(at(2026, 11, 12, 16, 15));
    let r = block_on(fx.service.create(create_input(
        json!({ "text": " llamar ", "dueAt": due_at, "repeat": "none" }),
    )))
    .unwrap();
    assert_eq!(
        r,
        Reminder {
            id: uuid(1),
            text: ReminderText::new("llamar").unwrap(),
            due_at,
            repeat: ReminderRepeat::None,
            local_time: None,
            state: ReminderState::Pending,
            created_at: iso(at(2026, 11, 10, 12, 0)),
            completed_at: None,
        }
    );
}

#[test]
fn notch_form_rejects_a_one_off_reminder_at_or_before_now_with_the_past_message() {
    let fx = Fx::new();
    for when in [at(2026, 11, 10, 12, 0), at(2026, 11, 10, 11, 59)] {
        let message = rejects(
            block_on(fx.service.create(create_input(
                json!({ "text": "x", "dueAt": iso(when), "repeat": "none" }),
            ))),
            IpcErrorCode::InvalidInput,
        );
        assert_eq!(message, "dueAt must be in the future");
    }
    assert_eq!(fx.writes(), 0);
}

#[test]
fn notch_form_daily_keeps_the_wall_clock_time_and_starts_at_its_next_occurrence() {
    let fx = Fx::new();
    // Given a past day at 09:00: the next 09:00 after Tue 10 Nov 12:00 is Wed 11 Nov.
    let r = block_on(fx.service.create(create_input(json!({
        "text": "standup", "dueAt": iso(at(2026, 11, 1, 9, 0)), "repeat": "daily"
    }))))
    .unwrap();
    assert_eq!(r.repeat, ReminderRepeat::Daily);
    assert_eq!(r.local_time.as_deref(), Some("09:00"));
    assert_eq!(r.due_at, iso(at(2026, 11, 11, 9, 0)));
    // Later today stays today.
    let r2 = block_on(fx.service.create(create_input(json!({
        "text": "café", "dueAt": iso(at(2026, 11, 20, 16, 30)), "repeat": "daily"
    }))))
    .unwrap();
    assert_eq!(r2.due_at, iso(at(2026, 11, 10, 16, 30)));
}

#[test]
fn notch_form_weekdays_skips_the_weekend_for_the_first_occurrence() {
    // Friday 13 Nov 2026, 18:00: the next weekday 09:00 is Monday 16 Nov.
    let fx = Fx::at(at(2026, 11, 13, 18, 0), 10);
    let r = block_on(fx.service.create(create_input(json!({
        "text": "daily sync", "dueAt": iso(at(2026, 11, 13, 9, 0)), "repeat": "weekdays"
    }))))
    .unwrap();
    assert_eq!(r.local_time.as_deref(), Some("09:00"));
    assert_eq!(r.due_at, iso(at(2026, 11, 16, 9, 0)));
}

#[test]
fn notch_form_still_enforces_the_active_limit() {
    let fx = Fx::new();
    fx.seed((1..=REMINDERS_ACTIVE_MAX).map(reminder).collect());
    let message = rejects(
        block_on(fx.service.create(create_input(json!({
            "text": "x", "dueAt": iso(at(2026, 11, 11, 9, 0)), "repeat": "none"
        })))),
        IpcErrorCode::InvalidInput,
    );
    assert_eq!(message, "limit");
}

#[test]
fn propagates_a_failed_write_without_calling_on_change() {
    let fx = Fx::new();
    fx.fail_next_write(ExposedError::new(IpcErrorCode::ReadOnly, "ro"));
    rejects(
        block_on(
            fx.service
                .create(create_input(json!({ "input": "en 5 min x" }))),
        ),
        IpcErrorCode::ReadOnly,
    );
    assert_eq!(fx.changes(), 0);
}

// snooze

#[test]
fn snooze_sets_pending_and_due_at_now_plus_snooze_minutes() {
    let fx = Fx::at(at(2026, 11, 10, 12, 0), 15);
    fx.seed(vec![with(1, |r| {
        r.state = ReminderState::Due;
        r.due_at = iso(at(2026, 11, 10, 11, 0));
    })]);
    let r = block_on(fx.service.snooze(&uuid(1))).unwrap();
    assert_eq!(r.state, ReminderState::Pending);
    assert_eq!(r.due_at, iso(at(2026, 11, 10, 12, 15)));
    assert_eq!(fx.changes(), 1);
}

#[test]
fn snooze_works_on_missed_and_pending() {
    let fx = Fx::new();
    fx.seed(vec![
        with(1, |r| r.state = ReminderState::Missed),
        reminder(2),
    ]);
    assert_eq!(
        block_on(fx.service.snooze(&uuid(1))).unwrap().state,
        ReminderState::Pending
    );
    assert_eq!(
        block_on(fx.service.snooze(&uuid(2))).unwrap().due_at,
        iso(at(2026, 11, 10, 12, 10))
    );
}

#[test]
fn snooze_keeps_repeat_and_local_time_on_a_repeating_reminder() {
    let fx = Fx::new();
    fx.seed(vec![with(1, |r| {
        r.state = ReminderState::Due;
        r.repeat = ReminderRepeat::Daily;
        r.local_time = Some("09:00".into());
    })]);
    let r = block_on(fx.service.snooze(&uuid(1))).unwrap();
    assert_eq!(r.repeat, ReminderRepeat::Daily);
    assert_eq!(r.local_time.as_deref(), Some("09:00"));
}

#[test]
fn snooze_rejects_a_done_reminder() {
    let fx = Fx::new();
    fx.seed(vec![done(1, at(2026, 11, 10, 11, 0))]);
    let message = rejects(
        block_on(fx.service.snooze(&uuid(1))),
        IpcErrorCode::InvalidInput,
    );
    assert_eq!(message, "Reminder is already done");
}

#[test]
fn snooze_not_found_for_an_unknown_id() {
    let message = rejects(
        block_on(Fx::new().service.snooze(&uuid(77))),
        IpcErrorCode::NotFound,
    );
    assert_eq!(message, "Reminder not found");
}

#[test]
fn snooze_reads_the_setting_at_call_time() {
    let fx = Fx::new();
    fx.seed(vec![reminder(1)]);
    fx.snooze.store(30, Ordering::SeqCst);
    assert_eq!(
        block_on(fx.service.snooze(&uuid(1))).unwrap().due_at,
        iso(at(2026, 11, 10, 12, 30))
    );
}

// complete

#[test]
fn complete_marks_a_one_shot_reminder_done_with_completed_at() {
    let fx = Fx::new();
    fx.seed(vec![with(1, |r| r.state = ReminderState::Due)]);
    let r = block_on(fx.service.complete(&uuid(1))).unwrap();
    assert_eq!(r.state, ReminderState::Done);
    assert_eq!(r.completed_at, Some(iso(at(2026, 11, 10, 12, 0))));
    assert_eq!(fx.completions.load(Ordering::SeqCst), 1);
}

#[test]
fn complete_moves_a_repeating_reminder_to_its_next_occurrence_pending() {
    let fx = Fx::new();
    fx.seed(vec![daily(1, ReminderState::Due, at(2026, 11, 10, 9, 0))]);
    let r = block_on(fx.service.complete(&uuid(1))).unwrap();
    assert_eq!(r.state, ReminderState::Pending);
    assert_eq!(r.due_at, iso(at(2026, 11, 11, 9, 0)));
    assert_eq!(r.completed_at, None);
}

#[test]
fn complete_weekdays_on_a_friday_goes_to_monday() {
    let fx = Fx::at(at(2026, 11, 13, 10, 0), 10); // Friday
    fx.seed(vec![with(1, |r| {
        r.state = ReminderState::Due;
        r.repeat = ReminderRepeat::Weekdays;
        r.local_time = Some("09:00".into());
    })]);
    assert_eq!(
        block_on(fx.service.complete(&uuid(1))).unwrap().due_at,
        iso(at(2026, 11, 16, 9, 0))
    );
}

#[test]
fn snooze_then_complete_a_repeating_one_uses_local_time_not_the_snoozed_time() {
    let fx = Fx::new();
    fx.seed(vec![daily(1, ReminderState::Due, at(2026, 11, 10, 9, 0))]);
    block_on(fx.service.snooze(&uuid(1))).unwrap(); // dueAt 12:10
    fx.set_now(at(2026, 11, 10, 12, 20));
    let r = block_on(fx.service.complete(&uuid(1))).unwrap();
    assert_eq!(r.due_at, iso(at(2026, 11, 11, 9, 0)));
}

#[test]
fn completing_todays_occurrence_early_skips_to_tomorrow_not_the_same_time() {
    let fx = Fx::at(at(2026, 11, 10, 8, 0), 10);
    fx.seed(vec![daily(
        1,
        ReminderState::Pending,
        at(2026, 11, 10, 9, 0),
    )]);
    assert_eq!(
        block_on(fx.service.complete(&uuid(1))).unwrap().due_at,
        iso(at(2026, 11, 11, 9, 0))
    );
}

#[test]
fn complete_rejects_completing_a_done_reminder() {
    let fx = Fx::new();
    fx.seed(vec![done(1, at(2026, 11, 10, 11, 0))]);
    rejects(
        block_on(fx.service.complete(&uuid(1))),
        IpcErrorCode::InvalidInput,
    );
    assert_eq!(fx.completions.load(Ordering::SeqCst), 0);
}

#[test]
fn complete_not_found_for_an_unknown_id() {
    rejects(
        block_on(Fx::new().service.complete(&uuid(77))),
        IpcErrorCode::NotFound,
    );
}

#[test]
fn complete_does_not_report_a_completion_whose_write_failed() {
    let fx = Fx::new();
    fx.seed(vec![reminder(1)]);
    fx.fail_next_write(ExposedError::internal("EIO"));
    rejects(
        block_on(fx.service.complete(&uuid(1))),
        IpcErrorCode::Internal,
    );
    assert_eq!(fx.completions.load(Ordering::SeqCst), 0);
    assert_eq!(fx.changes(), 0);
}

// update

#[test]
fn update_changes_text_only() {
    let fx = Fx::new();
    fx.seed(vec![reminder(1)]);
    let r = block_on(
        fx.service
            .update(update_input(json!({ "id": uuid(1), "text": "  nuevo  " }))),
    )
    .unwrap();
    assert_eq!(r.text.as_str(), "nuevo");
    assert_eq!(r.due_at, reminder(1).due_at);
}

#[test]
fn update_rejects_a_due_at_at_or_before_now() {
    let fx = Fx::new();
    fx.seed(vec![reminder(1)]);
    for when in [at(2026, 11, 10, 12, 0), at(2026, 11, 10, 11, 0)] {
        let message = rejects(
            block_on(
                fx.service
                    .update(update_input(json!({ "id": uuid(1), "dueAt": iso(when) }))),
            ),
            IpcErrorCode::InvalidInput,
        );
        assert_eq!(message, "dueAt must be in the future");
    }
    assert_eq!(fx.writes(), 0);
}

#[test]
fn update_setting_repeat_to_daily_sets_local_time_from_the_resulting_due_at() {
    let fx = Fx::new();
    fx.seed(vec![with(1, |r| r.due_at = iso(at(2026, 11, 10, 15, 45)))]);
    let r = block_on(
        fx.service
            .update(update_input(json!({ "id": uuid(1), "repeat": "daily" }))),
    )
    .unwrap();
    assert_eq!(r.repeat, ReminderRepeat::Daily);
    assert_eq!(r.local_time.as_deref(), Some("15:45"));
}

#[test]
fn update_a_new_due_at_on_a_repeating_reminder_refreshes_local_time() {
    let fx = Fx::new();
    fx.seed(vec![with(1, |r| {
        r.repeat = ReminderRepeat::Daily;
        r.local_time = Some("15:00".into());
    })]);
    let r = block_on(fx.service.update(update_input(
        json!({ "id": uuid(1), "dueAt": iso(at(2026, 11, 11, 8, 30)) }),
    )))
    .unwrap();
    assert_eq!(r.local_time.as_deref(), Some("08:30"));
}

#[test]
fn update_repeat_none_drops_local_time() {
    let fx = Fx::new();
    fx.seed(vec![with(1, |r| {
        r.repeat = ReminderRepeat::Daily;
        r.local_time = Some("15:00".into());
    })]);
    let r = block_on(
        fx.service
            .update(update_input(json!({ "id": uuid(1), "repeat": "none" }))),
    )
    .unwrap();
    assert_eq!(r.repeat, ReminderRepeat::None);
    assert_eq!(r.local_time, None);
    assert!(serde_json::to_value(&r).unwrap().get("localTime").is_none());
}

#[test]
fn update_a_text_only_update_of_a_repeating_reminder_keeps_local_time() {
    let fx = Fx::new();
    fx.seed(vec![daily(
        1,
        ReminderState::Pending,
        at(2026, 11, 11, 9, 0),
    )]);
    let r = block_on(
        fx.service
            .update(update_input(json!({ "id": uuid(1), "text": "x" }))),
    )
    .unwrap();
    assert_eq!(r.local_time.as_deref(), Some("09:00"));
}

#[test]
fn update_a_future_due_at_puts_a_due_or_missed_reminder_back_to_pending() {
    let fx = Fx::new();
    fx.seed(vec![
        with(1, |r| r.state = ReminderState::Due),
        with(2, |r| r.state = ReminderState::Missed),
    ]);
    let future = iso(at(2026, 11, 10, 18, 0));
    for n in [1, 2] {
        let r = block_on(
            fx.service
                .update(update_input(json!({ "id": uuid(n), "dueAt": future }))),
        )
        .unwrap();
        assert_eq!(r.state, ReminderState::Pending);
    }
}

#[test]
fn update_a_text_only_update_keeps_a_due_reminder_due() {
    let fx = Fx::new();
    fx.seed(vec![with(1, |r| r.state = ReminderState::Due)]);
    let r = block_on(
        fx.service
            .update(update_input(json!({ "id": uuid(1), "text": "x" }))),
    )
    .unwrap();
    assert_eq!(r.state, ReminderState::Due);
}

#[test]
fn update_rejects_updating_a_done_reminder() {
    let fx = Fx::new();
    fx.seed(vec![done(1, at(2026, 11, 10, 11, 0))]);
    let message = rejects(
        block_on(
            fx.service
                .update(update_input(json!({ "id": uuid(1), "text": "x" }))),
        ),
        IpcErrorCode::InvalidInput,
    );
    assert_eq!(message, "Reminder is already done");
}

#[test]
fn update_rejects_text_with_control_characters() {
    // The TS service re-validates the text; here `ReminderText` refuses it while the input is
    // read, so the service never sees it and nothing is written.
    let fx = Fx::new();
    fx.seed(vec![reminder(1)]);
    let error =
        UpdateReminderInput::from_input(json!({ "id": uuid(1), "text": "a\u{0}b" })).unwrap_err();
    assert_eq!(error.code(), IpcErrorCode::InvalidInput);
    assert_eq!(fx.writes(), 0);
}

#[test]
fn update_not_found_for_an_unknown_id() {
    rejects(
        block_on(
            Fx::new()
                .service
                .update(update_input(json!({ "id": uuid(77), "text": "x" }))),
        ),
        IpcErrorCode::NotFound,
    );
}

#[test]
fn update_normalizes_the_due_at_to_milliseconds() {
    // `new Date(input.dueAt).toISOString()`.
    let fx = Fx::new();
    fx.seed(vec![reminder(1)]);
    let r = block_on(fx.service.update(update_input(
        json!({ "id": uuid(1), "dueAt": "2026-11-10T17:00:00Z" }),
    )))
    .unwrap();
    assert_eq!(r.due_at, "2026-11-10T17:00:00.000Z");
}

// remove

#[test]
fn remove_removes_the_reminder_and_notifies() {
    let fx = Fx::new();
    fx.seed(vec![reminder(1), reminder(2)]);
    block_on(fx.service.remove(&uuid(1))).unwrap();
    assert_eq!(ids(&fx.items()), [uuid(2)]);
    assert_eq!(fx.changes(), 1);
}

#[test]
fn remove_not_found_for_an_unknown_id() {
    rejects(
        block_on(Fx::new().service.remove(&uuid(77))),
        IpcErrorCode::NotFound,
    );
}

// markDue

#[test]
fn mark_due_moves_due_pending_reminders_to_due_and_returns_only_those() {
    let fx = Fx::new();
    fx.seed(vec![
        with(1, |r| r.due_at = iso(at(2026, 11, 10, 11, 0))),
        with(2, |r| r.due_at = iso(at(2026, 11, 10, 12, 0))),
        with(3, |r| r.due_at = iso(at(2026, 11, 10, 13, 0))),
        with(4, |r| {
            r.state = ReminderState::Missed;
            r.due_at = iso(at(2026, 11, 10, 10, 0));
        }),
    ]);
    let out = block_on(fx.service.mark_due()).unwrap();
    assert_eq!(ids(&out), [uuid(1), uuid(2)]);
    assert!(out.iter().all(|r| r.state == ReminderState::Due));
    assert_eq!(fx.item(3).state, ReminderState::Pending);
    assert_eq!(fx.item(4).state, ReminderState::Missed);
    assert_eq!(fx.changes(), 1);
}

#[test]
fn mark_due_a_second_immediate_call_returns_nothing_and_does_not_write() {
    let fx = Fx::new();
    fx.seed(vec![with(1, |r| r.due_at = iso(at(2026, 11, 10, 11, 0)))]);
    block_on(fx.service.mark_due()).unwrap();
    let (writes, changes) = (fx.writes(), fx.changes());
    assert!(block_on(fx.service.mark_due()).unwrap().is_empty());
    assert_eq!(fx.writes(), writes);
    assert_eq!(fx.changes(), changes);
}

#[test]
fn mark_due_rolls_a_due_daily_forward_the_next_day() {
    let fx = Fx::at(at(2026, 11, 10, 9, 0), 10);
    fx.seed(vec![daily(
        1,
        ReminderState::Pending,
        at(2026, 11, 10, 9, 0),
    )]);
    assert_eq!(block_on(fx.service.mark_due()).unwrap().len(), 1);
    assert_eq!(fx.items()[0].state, ReminderState::Due);

    fx.set_now(local(2026, 11, 11, 9, 0, 30));
    let out = block_on(fx.service.mark_due()).unwrap();
    assert_eq!(ids(&out), [uuid(1)]);
    assert_eq!(out[0].state, ReminderState::Due);
    assert_eq!(out[0].due_at, iso(at(2026, 11, 11, 9, 0)));
    assert!(block_on(fx.service.mark_due()).unwrap().is_empty());
}

#[test]
fn mark_due_rolls_a_missed_daily_to_the_latest_occurrence_up_to_now() {
    let fx = Fx::at(at(2026, 11, 13, 10, 0), 10);
    fx.seed(vec![daily(
        1,
        ReminderState::Missed,
        at(2026, 11, 10, 9, 0),
    )]);
    let out = block_on(fx.service.mark_due()).unwrap();
    assert_eq!(out[0].due_at, iso(at(2026, 11, 13, 9, 0)));
    assert_eq!(out[0].state, ReminderState::Due);
}

#[test]
fn mark_due_does_not_roll_a_due_repeating_reminder_before_its_next_occurrence() {
    let fx = Fx::at(at(2026, 11, 10, 20, 0), 10);
    fx.seed(vec![daily(1, ReminderState::Due, at(2026, 11, 10, 9, 0))]);
    assert!(block_on(fx.service.mark_due()).unwrap().is_empty());
}

#[test]
fn mark_due_a_pending_repeating_reminder_is_just_marked_due() {
    let fx = Fx::at(at(2026, 11, 13, 10, 0), 10);
    fx.seed(vec![daily(
        1,
        ReminderState::Pending,
        at(2026, 11, 10, 9, 0),
    )]);
    let out = block_on(fx.service.mark_due()).unwrap();
    assert_eq!(out[0].state, ReminderState::Due);
    assert_eq!(out[0].due_at, iso(at(2026, 11, 13, 9, 0)));
    assert!(block_on(fx.service.mark_due()).unwrap().is_empty());
}

// markMissedOnStart

#[test]
fn mark_missed_one_shot_overdue_becomes_missed_future_and_done_are_untouched() {
    let fx = Fx::new();
    fx.seed(vec![
        with(1, |r| r.due_at = iso(at(2026, 11, 10, 11, 0))),
        with(2, |r| r.due_at = iso(at(2026, 11, 10, 13, 0))),
        with(3, |r| {
            r.state = ReminderState::Done;
            r.completed_at = Some(iso(at(2026, 11, 9, 0, 0)));
            r.due_at = iso(at(2026, 11, 9, 0, 0));
        }),
        with(4, |r| {
            r.state = ReminderState::Due;
            r.due_at = iso(at(2026, 11, 10, 8, 0));
        }),
    ]);
    let out = block_on(fx.service.mark_missed_on_start()).unwrap();
    assert_eq!(ids(&out), [uuid(1)]);
    assert_eq!(out[0].state, ReminderState::Missed);
    assert_eq!(fx.item(4).state, ReminderState::Due);
    assert_eq!(fx.changes(), 1);
}

#[test]
fn mark_missed_a_daily_missed_for_3_days_yields_one_missed_entry_at_the_latest_occurrence() {
    let fx = Fx::at(at(2026, 11, 13, 10, 0), 10);
    fx.seed(vec![daily(
        1,
        ReminderState::Pending,
        at(2026, 11, 10, 9, 0),
    )]);
    let out = block_on(fx.service.mark_missed_on_start()).unwrap();
    assert_eq!(out.len(), 1);
    assert_eq!(fx.items().len(), 1);
    assert_eq!(out[0].state, ReminderState::Missed);
    assert_eq!(out[0].due_at, iso(at(2026, 11, 13, 9, 0)));
}

#[test]
fn mark_missed_a_repeating_overdue_by_less_than_a_period_keeps_its_due_at() {
    let fx = Fx::at(at(2026, 11, 10, 10, 0), 10);
    fx.seed(vec![daily(
        1,
        ReminderState::Pending,
        at(2026, 11, 10, 9, 0),
    )]);
    let out = block_on(fx.service.mark_missed_on_start()).unwrap();
    assert_eq!(out[0].due_at, iso(at(2026, 11, 10, 9, 0)));
}

#[test]
fn mark_missed_a_daily_left_due_by_the_last_session_rolls_to_today_as_one_missed_entry() {
    // Yesterday's 09:00 was left due; today's 09:00 has also passed.
    let fx = Fx::at(at(2026, 11, 10, 10, 0), 10);
    fx.seed(vec![
        daily(1, ReminderState::Due, at(2026, 11, 9, 9, 0)),
        daily(2, ReminderState::Missed, at(2026, 11, 8, 9, 0)),
    ]);
    let out = block_on(fx.service.mark_missed_on_start()).unwrap();
    assert_eq!(ids(&out), [uuid(1), uuid(2)]);
    for r in &out {
        assert_eq!(r.state, ReminderState::Missed);
        assert_eq!(r.due_at, iso(at(2026, 11, 10, 9, 0)));
    }
    assert_eq!(fx.changes(), 1);
    // Nothing left for the scheduler: no second toast for the same occurrence.
    assert!(block_on(fx.service.mark_due()).unwrap().is_empty());
}

#[test]
fn mark_missed_leaves_current_repeating_and_one_shot_due_or_missed_reminders_untouched() {
    let fx = Fx::at(at(2026, 11, 10, 10, 0), 10);
    fx.seed(vec![
        // Next occurrence (tomorrow 09:00) has not arrived yet.
        daily(1, ReminderState::Due, at(2026, 11, 10, 9, 0)),
        with(2, |r| {
            r.state = ReminderState::Missed;
            r.due_at = iso(at(2026, 11, 1, 9, 0));
        }),
        with(3, |r| {
            r.state = ReminderState::Due;
            r.due_at = iso(at(2026, 11, 2, 9, 0));
        }),
    ]);
    assert!(block_on(fx.service.mark_missed_on_start())
        .unwrap()
        .is_empty());
    assert_eq!(fx.writes(), 0);
}

#[test]
fn mark_missed_returns_nothing_and_does_not_write_when_nothing_is_overdue() {
    let fx = Fx::new();
    fx.seed(vec![reminder(1)]);
    assert!(block_on(fx.service.mark_missed_on_start())
        .unwrap()
        .is_empty());
    assert_eq!(fx.writes(), 0);
}

// purgeDone

#[test]
fn purge_removes_done_reminders_completed_more_than_7_days_ago_only() {
    let fx = Fx::new();
    fx.seed(vec![
        done(1, at(2026, 11, 2, 11, 0)), // 8 days
        done(2, at(2026, 11, 3, 12, 0)), // exactly 7
        done(3, at(2026, 11, 9, 0, 0)),
        reminder(4),
    ]);
    block_on(fx.service.purge_done()).unwrap();
    assert_eq!(ids(&fx.items()), [uuid(2), uuid(3), uuid(4)]);
    assert_eq!(fx.changes(), 1);
}

#[test]
fn purge_does_not_write_when_there_is_nothing_to_purge() {
    let fx = Fx::new();
    fx.seed(vec![reminder(1)]);
    block_on(fx.service.purge_done()).unwrap();
    assert_eq!(fx.writes(), 0);
}

// queries

#[test]
fn list_is_sorted_by_due_at_ascending() {
    let fx = Fx::new();
    fx.seed(vec![
        with(1, |r| r.due_at = iso(at(2026, 11, 10, 18, 0))),
        with(2, |r| r.due_at = iso(at(2026, 11, 10, 13, 0))),
        with(3, |r| r.due_at = iso(at(2026, 11, 10, 15, 0))),
    ]);
    assert_eq!(ids(&fx.service.list()), [uuid(2), uuid(3), uuid(1)]);
}

#[test]
fn list_hides_done_reminders_completed_more_than_7_days_ago() {
    let fx = Fx::new();
    fx.seed(vec![
        done(1, at(2026, 11, 2, 11, 0)), // 8 days
        done(2, at(2026, 11, 3, 12, 0)), // exactly 7
        done(3, at(2026, 11, 9, 0, 0)),
        reminder(4),
    ]);
    let mut listed = ids(&fx.service.list());
    listed.sort();
    assert_eq!(listed, [uuid(2), uuid(3), uuid(4)]);
}

#[test]
fn attention_count_counts_due_and_missed() {
    let fx = Fx::new();
    fx.seed(vec![
        with(1, |r| r.state = ReminderState::Due),
        with(2, |r| r.state = ReminderState::Missed),
        reminder(3),
        done(4, at(2026, 11, 10, 11, 0)),
    ]);
    assert_eq!(fx.service.attention_count(), 2);
}

#[test]
fn next_due_at_is_the_minimum_due_at_among_pending_or_none() {
    let fx = Fx::new();
    assert_eq!(fx.service.next_due_at(), None);
    fx.seed(vec![
        with(1, |r| r.due_at = iso(at(2026, 11, 10, 18, 0))),
        with(2, |r| r.due_at = iso(at(2026, 11, 10, 14, 0))),
        with(3, |r| {
            r.state = ReminderState::Due;
            r.due_at = iso(at(2026, 11, 10, 9, 0));
        }),
    ]);
    assert_eq!(fx.service.next_due_at(), Some(at(2026, 11, 10, 14, 0)));
    fx.seed(vec![with(3, |r| r.state = ReminderState::Due)]);
    assert_eq!(fx.service.next_due_at(), None);
}

// listeners (ruling: called after the write, panics caught)

#[test]
fn a_panicking_listener_never_fails_the_saved_mutation() {
    let fx = Fx::new();
    fx.seed(vec![reminder(1), reminder(2)]);
    fx.listener_panics.store(true, Ordering::SeqCst);
    let r = block_on(fx.service.complete(&uuid(1))).unwrap();
    assert_eq!(r.state, ReminderState::Done);
    assert_eq!(fx.changes(), 1);
    assert_eq!(fx.completions.load(Ordering::SeqCst), 1);
    // The chain is not poisoned either.
    assert!(block_on(fx.service.snooze(&uuid(2))).is_ok());
}

// concurrency

#[test]
fn create_racing_mark_due_keeps_both_effects() {
    let fx = Fx::deferred();
    fx.seed(vec![with(1, |r| r.due_at = iso(at(2026, 11, 10, 11, 0)))]);
    let (created, due) = block_on(async {
        tokio::join!(
            fx.service
                .create(create_input(json!({ "input": "en 5 min nuevo" }))),
            fx.service.mark_due(),
        )
    });
    let created = created.unwrap();
    assert_eq!(ids(&due.unwrap()), [uuid(1)]);
    let mut stored = ids(&fx.items());
    stored.sort();
    let mut expected = vec![uuid(1), created.id];
    expected.sort();
    assert_eq!(stored, expected);
    assert_eq!(fx.item(1).state, ReminderState::Due);
}

#[test]
fn snooze_a_and_complete_b_both_land() {
    let fx = Fx::deferred();
    fx.seed(vec![
        with(1, |r| r.state = ReminderState::Due),
        with(2, |r| r.state = ReminderState::Due),
    ]);
    let (first, second) = (uuid(1), uuid(2));
    let (a, b) =
        block_on(async { tokio::join!(fx.service.snooze(&first), fx.service.complete(&second)) });
    a.unwrap();
    b.unwrap();
    assert_eq!(fx.item(1).state, ReminderState::Pending);
    assert_eq!(fx.item(2).state, ReminderState::Done);
}

#[test]
fn two_concurrent_creates_cannot_both_pass_the_limit() {
    let fx = Fx::deferred();
    fx.seed((1..REMINDERS_ACTIVE_MAX).map(reminder).collect());
    let (a, b) = block_on(async {
        tokio::join!(
            fx.service
                .create(create_input(json!({ "input": "en 5 min a" }))),
            fx.service
                .create(create_input(json!({ "input": "en 5 min b" }))),
        )
    });
    let mut outcomes = [a.is_ok(), b.is_ok()];
    outcomes.sort();
    assert_eq!(outcomes, [false, true]);
    assert_eq!(fx.items().len(), REMINDERS_ACTIVE_MAX);
}

#[test]
fn a_failed_operation_does_not_block_the_next_one() {
    let fx = Fx::deferred();
    fx.seed(vec![reminder(1)]);
    let (unknown, known) = (uuid(77), uuid(1));
    let (bad, good) =
        block_on(async { tokio::join!(fx.service.snooze(&unknown), fx.service.snooze(&known)) });
    assert_eq!(bad.unwrap_err().code(), IpcErrorCode::NotFound);
    assert_eq!(good.unwrap().state, ReminderState::Pending);
}
