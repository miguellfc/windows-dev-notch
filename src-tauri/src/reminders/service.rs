//! Reminders rules (0.1.0's `reminders-service.ts`): create (free text, preset or the
//! notch form), edit, snooze, complete (repeating ones roll to their next occurrence), delete,
//! the due/missed sweeps and the 7-day retention of done reminders. Every mutation runs as one
//! exclusive turn (snapshot, compute, validate, write), so concurrent calls never build on a
//! stale list. Never logs reminder text.
//!
//! The service is generic over the time zone `Z` that gives "local" its meaning (default
//! `chrono::Local`; tests pin `chrono_tz::Europe::Madrid`). It is a type parameter rather than a
//! boxed trait object because `chrono::TimeZone` is not object safe.

use std::cmp::Ordering;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;

use chrono::{DateTime, Duration, Local, SecondsFormat, TimeZone, Utc};

use super::parse::parse_reminder;
use super::time::{local_hhmm, next_occurrence, preset_due_at, Recurrence, MINUTE_MS};
use crate::contract::reminders::{
    CreateReminderInput, Reminder, ReminderRepeat, ReminderState, ReminderText, RemindersFile,
    UpdateReminderInput, INVALID_REMINDER_MESSAGE, REMINDERS_ACTIVE_MAX, REMINDER_DONE_MESSAGE,
    REMINDER_LIMIT_MESSAGE, REMINDER_NOT_FOUND_MESSAGE, REMINDER_PAST_MESSAGE,
};
use crate::contract::Validate;
use crate::ipc::{BoxFuture, ExposedError, IpcErrorCode};
use crate::services::clock::WallClock;
use crate::services::json_store::JsonStore;

const DAY_MS: i64 = 24 * 60 * MINUTE_MS;
const DONE_RETENTION_MS: i64 = 7 * DAY_MS;
/// Safety cap when walking occurrences forward (about 270 years of daily repeats).
const MAX_ROLL_STEPS: usize = 100_000;

fn invalid(message: &str) -> ExposedError {
    ExposedError::new(IpcErrorCode::InvalidInput, message)
}

fn not_found() -> ExposedError {
    ExposedError::new(IpcErrorCode::NotFound, REMINDER_NOT_FOUND_MESSAGE)
}

/// `new Date(iso)` (millisecond precision); `None` is an Invalid Date, which never compares.
fn instant(iso: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(iso)
        .ok()
        .and_then(|at| DateTime::from_timestamp_millis(at.timestamp_millis()))
}

/// `toISOString()`: milliseconds and `Z`.
fn to_iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `ms(iso) <= at` (false for an unreadable timestamp, like NaN).
fn at_or_before(iso: &str, at: DateTime<Utc>) -> bool {
    instant(iso).is_some_and(|when| when <= at)
}

fn recurrence(repeat: ReminderRepeat) -> Option<Recurrence> {
    match repeat {
        ReminderRepeat::None => None,
        ReminderRepeat::Daily => Some(Recurrence::Daily),
        ReminderRepeat::Weekdays => Some(Recurrence::Weekdays),
    }
}

/// A done reminder completed before `cutoff`: purged at startup and hidden from `list()`.
fn is_expired_done(r: &Reminder, cutoff: DateTime<Utc>) -> bool {
    r.state == ReminderState::Done
        && r.completed_at
            .as_deref()
            .and_then(instant)
            .is_some_and(|completed| completed < cutoff)
}

fn find_in<'a>(all: &'a [Reminder], id: &str) -> Result<&'a Reminder, ExposedError> {
    all.iter().find(|r| r.id == id).ok_or_else(not_found)
}

/// Runs a listener; the reminder is saved, so a panic there must not fail the mutation.
fn notify(listener: &(dyn Fn() + Send + Sync), what: &str) {
    if catch_unwind(AssertUnwindSafe(listener)).is_err() {
        // No detail: whatever failed to go out may carry reminder text.
        log::warn!("Reminders {what} listener failed");
    }
}

/// The full next list plus the ids of the reminders it touched.
struct Plan {
    next: Vec<Reminder>,
    changed: Vec<String>,
}

impl Plan {
    fn single(all: &[Reminder], updated: Reminder) -> Self {
        let id = updated.id.clone();
        let next = all
            .iter()
            .map(|r| {
                if r.id == id {
                    updated.clone()
                } else {
                    r.clone()
                }
            })
            .collect();
        Self {
            next,
            changed: vec![id],
        }
    }
}

/// What a create resolves to before the turn (`fields` in the TS).
struct Fields {
    /// Raw parsed text (validated inside the turn) or an already valid one.
    text: Result<ReminderText, String>,
    due_at: DateTime<Utc>,
    repeat: ReminderRepeat,
    local_time: Option<String>,
}

/// What the service needs from the reminders file (`Pick<RemindersStore, 'all' | 'write'>`).
pub trait ReminderStore: Send + Sync {
    /// The reminders as last loaded or saved.
    fn all(&self) -> Vec<Reminder>;
    /// Saves `next` (after any write already queued) and makes it the current list.
    fn write(&self, next: Vec<Reminder>) -> BoxFuture<'_, Result<(), ExposedError>>;
}

impl ReminderStore for JsonStore<RemindersFile> {
    fn all(&self) -> Vec<Reminder> {
        self.get().reminders
    }

    fn write(&self, next: Vec<Reminder>) -> BoxFuture<'_, Result<(), ExposedError>> {
        Box::pin(JsonStore::write(self, RemindersFile::new(next)))
    }
}

/// A change listener; a panic in it is caught and logged without detail.
pub type Listener = Box<dyn Fn() + Send + Sync>;

/// `RemindersServiceOptions`.
pub struct RemindersOptions {
    pub store: Arc<dyn ReminderStore>,
    pub clock: Arc<WallClock>,
    pub new_id: Box<dyn Fn() -> String + Send + Sync>,
    /// Read at snooze time (the setting may change between calls).
    pub snooze_minutes: Box<dyn Fn() -> u32 + Send + Sync>,
    /// Told after every saved mutation (not after a no-op or a failed write).
    pub on_change: Listener,
    /// Told after a completion is saved (any caller: notch or Control Center).
    pub on_completed: Option<Listener>,
}

pub struct RemindersService<Z: TimeZone = Local> {
    tz: Z,
    store: Arc<dyn ReminderStore>,
    clock: Arc<WallClock>,
    new_id: Box<dyn Fn() -> String + Send + Sync>,
    snooze_minutes: Box<dyn Fn() -> u32 + Send + Sync>,
    on_change: Listener,
    on_completed: Option<Listener>,
    /// One mutation at a time, in call order (tokio's mutex is FIFO).
    chain: tokio::sync::Mutex<()>,
}

impl<Z: TimeZone + Send + Sync> RemindersService<Z> {
    pub fn new(options: RemindersOptions, tz: Z) -> Self {
        Self {
            tz,
            store: options.store,
            clock: options.clock,
            new_id: options.new_id,
            snooze_minutes: options.snooze_minutes,
            on_change: options.on_change,
            on_completed: options.on_completed,
            chain: tokio::sync::Mutex::new(()),
        }
    }

    /// The wall clock at JS `Date` precision (milliseconds).
    fn now(&self) -> DateTime<Utc> {
        let now = self.clock.now();
        DateTime::from_timestamp_millis(now.timestamp_millis()).unwrap_or(now)
    }

    /// Done reminders completed before this are expired.
    fn retention_cutoff(&self) -> DateTime<Utc> {
        let now = self.now();
        now.checked_sub_signed(Duration::milliseconds(DONE_RETENTION_MS))
            .unwrap_or(now)
    }

    /// Runs one mutation as an exclusive unit (snapshot, compute, validate, write), so concurrent
    /// operations never build on a stale snapshot. `plan` returns `None` for a no-op (nothing
    /// written, no change event), otherwise the full next list plus the ids it touched. Every
    /// touched reminder passes `reminderSchema` here. Returns the touched reminders (empty for
    /// removals). `on_change` runs after the write, once the turn is released; a failed
    /// mutation never blocks the ones queued after it.
    async fn mutate(
        &self,
        plan: impl FnOnce(&[Reminder]) -> Result<Option<Plan>, ExposedError>,
    ) -> Result<Vec<Reminder>, ExposedError> {
        let touched = {
            let _turn = self.chain.lock().await;
            let Some(planned) = plan(&self.store.all())? else {
                return Ok(Vec::new());
            };
            let touched: Vec<Reminder> = planned
                .next
                .iter()
                .filter(|r| planned.changed.contains(&r.id))
                .cloned()
                .collect();
            if touched.iter().any(|r| r.validate().is_err()) {
                return Err(invalid(INVALID_REMINDER_MESSAGE));
            }
            self.store.write(planned.next).await?;
            touched
        };
        notify(&*self.on_change, "change");
        Ok(touched)
    }

    async fn mutate_one(
        &self,
        plan: impl FnOnce(&[Reminder]) -> Result<Option<Plan>, ExposedError>,
    ) -> Result<Reminder, ExposedError> {
        self.mutate(plan)
            .await?
            .into_iter()
            .next()
            .ok_or_else(|| ExposedError::internal("mutation touched no reminder"))
    }

    /// Latest occurrence of a repeating reminder that is `<= now`, starting from its current
    /// dueAt (as an ISO string; an unreadable dueAt is kept as it is).
    fn latest_occurrence_up_to(&self, r: &Reminder, now: DateTime<Utc>) -> String {
        let Some(mut current) = instant(&r.due_at) else {
            return r.due_at.clone();
        };
        if let (Some(repeat), Some(local_time)) = (recurrence(r.repeat), &r.local_time) {
            for _ in 0..MAX_ROLL_STEPS {
                let next = next_occurrence(&self.tz, repeat, local_time, current);
                if next > now {
                    break;
                }
                current = next;
            }
        }
        to_iso(current)
    }

    /// A repeating reminder left `due`/`missed` whose following occurrence has already arrived:
    /// its current dueAt is stale and should roll forward to the latest occurrence.
    fn is_stale_repeating(&self, r: &Reminder, at: DateTime<Utc>) -> bool {
        if !matches!(r.state, ReminderState::Due | ReminderState::Missed) {
            return false;
        }
        let (Some(repeat), Some(local_time)) = (recurrence(r.repeat), &r.local_time) else {
            return false;
        };
        instant(&r.due_at)
            .is_some_and(|due| next_occurrence(&self.tz, repeat, local_time, due) <= at)
    }

    /// `markDue` / `markMissedOnStart`: overdue pending reminders and stale repeating ones move
    /// to `to`, repeating ones at their latest occurrence so one miss never fires twice.
    async fn sweep(&self, to: ReminderState) -> Result<Vec<Reminder>, ExposedError> {
        self.mutate(|all| {
            let at = self.now();
            let mut changed = Vec::new();
            let next = all
                .iter()
                .map(|r| {
                    let overdue_pending =
                        r.state == ReminderState::Pending && at_or_before(&r.due_at, at);
                    if !overdue_pending && !self.is_stale_repeating(r, at) {
                        return r.clone();
                    }
                    changed.push(r.id.clone());
                    Reminder {
                        state: to,
                        due_at: self.latest_occurrence_up_to(r, at),
                        ..r.clone()
                    }
                })
                .collect();
            Ok((!changed.is_empty()).then_some(Plan { next, changed }))
        })
        .await
    }

    /// Sorted by dueAt ascending; done reminders past the 7-day retention are hidden even before
    /// the startup purge removes them from disk.
    pub fn list(&self) -> Vec<Reminder> {
        let cutoff = self.retention_cutoff();
        let mut list: Vec<Reminder> = self
            .store
            .all()
            .into_iter()
            .filter(|r| !is_expired_done(r, cutoff))
            .collect();
        list.sort_by(|a, b| match (instant(&a.due_at), instant(&b.due_at)) {
            (Some(a), Some(b)) => a.cmp(&b),
            _ => Ordering::Equal,
        });
        list
    }

    pub async fn create(&self, input: CreateReminderInput) -> Result<Reminder, ExposedError> {
        let at = self.now();
        let fields = match input {
            CreateReminderInput::Parse(parse) => {
                let parsed = parse_reminder(&self.tz, &parse.input, at)
                    .map_err(|error| invalid(error.as_str()))?;
                Fields {
                    text: Err(parsed.text),
                    due_at: parsed.due_at,
                    repeat: parsed.repeat,
                    local_time: parsed.local_time,
                }
            }
            CreateReminderInput::Preset(preset) => Fields {
                text: Ok(preset.text),
                due_at: preset_due_at(&self.tz, preset.preset, at),
                repeat: ReminderRepeat::None,
                local_time: None,
            },
            CreateReminderInput::Explicit(explicit) => {
                let due_at =
                    instant(&explicit.due_at).ok_or_else(|| invalid(REMINDER_PAST_MESSAGE))?;
                match recurrence(explicit.repeat) {
                    None => {
                        if due_at <= at {
                            return Err(invalid(REMINDER_PAST_MESSAGE));
                        }
                        Fields {
                            text: Ok(explicit.text),
                            due_at,
                            repeat: ReminderRepeat::None,
                            local_time: None,
                        }
                    }
                    // Repeating: only the wall-clock time matters; the first occurrence is the
                    // next one.
                    Some(repeat) => {
                        let local_time = local_hhmm(&self.tz, due_at);
                        Fields {
                            text: Ok(explicit.text),
                            due_at: next_occurrence(&self.tz, repeat, &local_time, at),
                            repeat: explicit.repeat,
                            local_time: Some(local_time),
                        }
                    }
                }
            }
        };
        self.mutate_one(|all| {
            let active = all
                .iter()
                .filter(|r| r.state != ReminderState::Done)
                .count();
            if active >= REMINDERS_ACTIVE_MAX {
                return Err(invalid(REMINDER_LIMIT_MESSAGE));
            }
            // `reminderSchema` on the touched reminder: parsed text may still carry controls.
            let text = match fields.text {
                Ok(text) => text,
                Err(raw) => {
                    ReminderText::new(&raw).map_err(|_| invalid(INVALID_REMINDER_MESSAGE))?
                }
            };
            let fresh = Reminder {
                id: (self.new_id)(),
                text,
                due_at: to_iso(fields.due_at),
                repeat: fields.repeat,
                local_time: fields.local_time,
                state: ReminderState::Pending,
                created_at: to_iso(at),
                completed_at: None,
            };
            let mut next = all.to_vec();
            let changed = vec![fresh.id.clone()];
            next.push(fresh);
            Ok(Some(Plan { next, changed }))
        })
        .await
    }

    pub async fn update(&self, input: UpdateReminderInput) -> Result<Reminder, ExposedError> {
        self.mutate_one(|all| {
            let current = find_in(all, &input.id)?;
            if current.state == ReminderState::Done {
                return Err(invalid(REMINDER_DONE_MESSAGE));
            }
            let at = self.now();

            let mut next = current.clone();
            if let Some(text) = input.text {
                next.text = text;
            }
            if let Some(due_at) = &input.due_at {
                let due_at = instant(due_at)
                    .filter(|due| *due > at)
                    .ok_or_else(|| invalid(REMINDER_PAST_MESSAGE))?;
                next.due_at = to_iso(due_at);
                if matches!(next.state, ReminderState::Due | ReminderState::Missed) {
                    next.state = ReminderState::Pending;
                }
            }
            if let Some(repeat) = input.repeat {
                next.repeat = repeat;
            }

            let repeat_changed = next.repeat != current.repeat;
            let due_changed = next.due_at != current.due_at;
            if next.repeat == ReminderRepeat::None {
                next.local_time = None;
            } else if repeat_changed || due_changed {
                next.local_time = instant(&next.due_at).map(|due| local_hhmm(&self.tz, due));
            }
            Ok(Some(Plan::single(all, next)))
        })
        .await
    }

    /// Back to pending, due `snooze_minutes()` (read now) from now.
    pub async fn snooze(&self, id: &str) -> Result<Reminder, ExposedError> {
        self.mutate_one(|all| {
            let current = find_in(all, id)?;
            if current.state == ReminderState::Done {
                return Err(invalid(REMINDER_DONE_MESSAGE));
            }
            let minutes = i64::from((self.snooze_minutes)());
            let now = self.now();
            let due_at = now
                .checked_add_signed(Duration::milliseconds(minutes * MINUTE_MS))
                .unwrap_or(now);
            Ok(Some(Plan::single(
                all,
                Reminder {
                    state: ReminderState::Pending,
                    due_at: to_iso(due_at),
                    ..current.clone()
                },
            )))
        })
        .await
    }

    /// One-off: done. Repeating: pending at the occurrence after the later of now and its
    /// dueAt (completing early skips to the following one). `on_completed` runs once saved.
    pub async fn complete(&self, id: &str) -> Result<Reminder, ExposedError> {
        let saved = self
            .mutate_one(|all| {
                let current = find_in(all, id)?;
                if current.state == ReminderState::Done {
                    return Err(invalid(REMINDER_DONE_MESSAGE));
                }
                let at = self.now();
                let updated = match (recurrence(current.repeat), &current.local_time) {
                    (Some(repeat), Some(local_time)) => {
                        let from = instant(&current.due_at).map_or(at, |due| due.max(at));
                        Reminder {
                            state: ReminderState::Pending,
                            due_at: to_iso(next_occurrence(&self.tz, repeat, local_time, from)),
                            ..current.clone()
                        }
                    }
                    _ => Reminder {
                        state: ReminderState::Done,
                        completed_at: Some(to_iso(at)),
                        ..current.clone()
                    },
                };
                Ok(Some(Plan::single(all, updated)))
            })
            .await?;
        if let Some(listener) = &self.on_completed {
            notify(&**listener, "completion");
        }
        Ok(saved)
    }

    pub async fn remove(&self, id: &str) -> Result<(), ExposedError> {
        self.mutate(|all| {
            find_in(all, id)?;
            Ok(Some(Plan {
                next: all.iter().filter(|r| r.id != id).cloned().collect(),
                changed: Vec::new(),
            }))
        })
        .await
        .map(drop)
    }

    /// Newly due reminders (the batch to announce); empty, with nothing written, when none.
    pub async fn mark_due(&self) -> Result<Vec<Reminder>, ExposedError> {
        self.sweep(ReminderState::Due).await
    }

    /// At startup: what came due while the app was closed, reported once as missed.
    pub async fn mark_missed_on_start(&self) -> Result<Vec<Reminder>, ExposedError> {
        self.sweep(ReminderState::Missed).await
    }

    /// Deletes done reminders completed more than 7 days ago; writes nothing when none.
    pub async fn purge_done(&self) -> Result<(), ExposedError> {
        self.mutate(|all| {
            let cutoff = self.retention_cutoff();
            let kept: Vec<Reminder> = all
                .iter()
                .filter(|r| !is_expired_done(r, cutoff))
                .cloned()
                .collect();
            Ok((kept.len() != all.len()).then_some(Plan {
                next: kept,
                changed: Vec::new(),
            }))
        })
        .await
        .map(drop)
    }

    /// The earliest dueAt among pending reminders.
    pub fn next_due_at(&self) -> Option<DateTime<Utc>> {
        self.store
            .all()
            .iter()
            .filter(|r| r.state == ReminderState::Pending)
            .filter_map(|r| instant(&r.due_at))
            .min()
    }

    /// How many reminders want attention (due or missed).
    pub fn attention_count(&self) -> usize {
        self.store
            .all()
            .iter()
            .filter(|r| matches!(r.state, ReminderState::Due | ReminderState::Missed))
            .count()
    }
}

#[cfg(test)]
mod tests;
