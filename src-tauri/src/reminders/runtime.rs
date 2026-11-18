//! Port of 0.1.0's `reminders-runtime.ts`, the Tauri-free core of the reminders
//! integration: store + service + scheduler, and what happens after each change (alert flag,
//! `reminders:changed`, timer moved to the new next due reminder). Never logs reminder text.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};

use chrono::{Local, TimeZone};

use super::ipc::RemindersApi;
use super::scheduler::{check_on_power, ReminderScheduler, Safety, SchedulerOptions};
use super::service::{ReminderStore, RemindersOptions, RemindersService};
use super::toast::ToastSink;
use crate::contract::reminders::{
    CreateReminderInput, Reminder, RemindersFile, RemindersSnapshot, UpdateReminderInput,
};
use crate::contract::StoreNotice;
use crate::ipc::{BoxFuture, ExposedError};
use crate::platform::power::PowerListener;
use crate::services::clock::WallClock;
use crate::services::json_store::{JsonStore, LoadOutcome};
use crate::services::timers::Timers;
use crate::services::usage::UsageEvent;

/// `Pick<RemindersStore, 'load' | 'all' | 'write'>`.
pub trait RuntimeStore: ReminderStore {
    fn load(&self) -> BoxFuture<'_, Result<LoadOutcome, ExposedError>>;
}

impl RuntimeStore for JsonStore<RemindersFile> {
    fn load(&self) -> BoxFuture<'_, Result<LoadOutcome, ExposedError>> {
        Box::pin(async move { Ok(JsonStore::load(self).await) })
    }
}

pub struct RuntimeOptions {
    pub store: Arc<dyn RuntimeStore>,
    pub clock: Arc<WallClock>,
    pub new_id: Box<dyn Fn() -> String + Send + Sync>,
    /// Read on every snooze so a settings change applies at once.
    pub snooze_minutes: Box<dyn Fn() -> u32 + Send + Sync>,
    pub timers: Arc<dyn Timers>,
    /// The 60 s safety check (`None` only in tests).
    pub safety: Option<Safety>,
    pub toast: Arc<dyn ToastSink>,
    /// Turns the notch's reminder alert on or off.
    pub set_due: Box<dyn Fn(bool) + Send + Sync>,
    /// `reminders:changed` to the notch and the Control Center.
    pub emit_changed: Box<dyn Fn(&RemindersSnapshot) + Send + Sync>,
    /// `reminders:fired` to the notch only (plays the chime).
    pub emit_fired: Box<dyn Fn(u64) + Send + Sync>,
    /// Counts for the local usage log (never reminder content).
    pub record_usage: Option<Box<dyn Fn(UsageEvent) + Send + Sync>>,
}

/// Marks the runtime ready when dropped, so a start that fails or panics still opens the gate
/// (the `finally` of `start()`).
struct MarkReady<'a>(&'a tokio::sync::watch::Sender<bool>);

impl Drop for MarkReady<'_> {
    fn drop(&mut self) {
        self.0.send_replace(true);
    }
}

type UsageRecorder = Arc<dyn Fn(UsageEvent) + Send + Sync>;

pub struct RemindersRuntime<Z: TimeZone = Local> {
    store: Arc<dyn RuntimeStore>,
    service: Arc<RemindersService<Z>>,
    scheduler: Arc<ReminderScheduler>,
    notice: Mutex<Option<StoreNotice>>,
    ready: tokio::sync::watch::Sender<bool>,
    set_due: Box<dyn Fn(bool) + Send + Sync>,
    emit_changed: Box<dyn Fn(&RemindersSnapshot) + Send + Sync>,
    emit_fired: Box<dyn Fn(u64) + Send + Sync>,
    toast: Arc<dyn ToastSink>,
    record_usage: Option<UsageRecorder>,
    /// False while the reminders integration is turned off in the settings: reminders still
    /// come due, but nothing alerts (no toast, no chime, no alert flag).
    alerts: AtomicBool,
}

fn notice_of(outcome: LoadOutcome) -> Option<StoreNotice> {
    match outcome.notice()? {
        LoadOutcome::Ok => None,
        LoadOutcome::Quarantined => Some(StoreNotice::Quarantined),
        LoadOutcome::ReadOnly => Some(StoreNotice::ReadOnly),
    }
}

impl<Z> RemindersRuntime<Z>
where
    Z: TimeZone + Send + Sync + 'static,
    Z::Offset: Send + Sync,
{
    pub fn new(options: RuntimeOptions, tz: Z) -> Arc<Self> {
        let record_usage: Option<UsageRecorder> = options.record_usage.map(Arc::from);
        Arc::new_cyclic(|me: &Weak<Self>| {
            let on_change = {
                let me = me.clone();
                Box::new(move || {
                    // Only after a mutation, so the runtime (and its scheduler) exists.
                    if let Some(runtime) = me.upgrade() {
                        runtime.publish();
                    }
                })
            };
            let on_completed = record_usage.clone().map(|record| {
                Box::new(move || record(UsageEvent::ReminderCompleted))
                    as Box<dyn Fn() + Send + Sync>
            });
            let service = Arc::new(RemindersService::new(
                RemindersOptions {
                    store: Arc::clone(&options.store) as Arc<dyn ReminderStore>,
                    clock: Arc::clone(&options.clock),
                    new_id: options.new_id,
                    snooze_minutes: options.snooze_minutes,
                    on_change,
                    on_completed,
                },
                tz,
            ));
            let on_fired = {
                let me = me.clone();
                Box::new(move |batch: Vec<Reminder>| {
                    if let Some(runtime) = me.upgrade() {
                        runtime.on_fired(&batch);
                    }
                })
            };
            let on_missed = {
                let me = me.clone();
                Box::new(move |missed: Vec<Reminder>| {
                    if let Some(runtime) = me.upgrade() {
                        runtime.on_missed(missed.len());
                    }
                })
            };
            let scheduler = ReminderScheduler::new(SchedulerOptions {
                service: Arc::clone(&service) as _,
                clock: options.clock,
                timers: options.timers,
                safety: options.safety,
                on_fired,
                on_missed,
            });
            let (ready, _) = tokio::sync::watch::channel(false);
            Self {
                store: options.store,
                service,
                scheduler,
                notice: Mutex::new(None),
                ready,
                set_due: options.set_due,
                emit_changed: options.emit_changed,
                emit_fired: options.emit_fired,
                toast: options.toast,
                record_usage,
                alerts: AtomicBool::new(true),
            }
        })
    }

    pub fn service(&self) -> &RemindersService<Z> {
        &self.service
    }

    fn record(&self, event: UsageEvent) {
        if let Some(record) = &self.record_usage {
            record(event);
        }
    }

    fn alerts_enabled(&self) -> bool {
        self.alerts.load(Ordering::SeqCst)
    }

    /// Turns the alerts on or off (the reminders integration in the settings; on by default).
    /// Off: due reminders raise no toast, chime or alert flag, and the flag is cleared now. On:
    /// the flag comes back for whatever came due meanwhile (they show as due or missed), with no
    /// toast or chime replayed.
    pub fn set_alerts_enabled(&self, on: bool) {
        if self.alerts.swap(on, Ordering::SeqCst) != on {
            self.publish_due();
        }
    }

    fn fired(&self, count: usize) {
        log::info!("Reminders fired: count {count}");
        (self.emit_fired)(count as u64);
    }

    fn on_fired(&self, batch: &[Reminder]) {
        self.record(UsageEvent::RemindersFired {
            count: batch.len() as f64,
        });
        if self.alerts_enabled() {
            self.toast.fired(batch);
            self.fired(batch.len());
        }
    }

    fn on_missed(&self, count: usize) {
        self.record(UsageEvent::RemindersMissed {
            count: count as f64,
        });
        if self.alerts_enabled() {
            self.toast.missed(count);
            self.fired(count);
        }
    }

    /// The notch's alert flag: on while something needs attention and the alerts are on.
    fn due_flag(&self) -> bool {
        self.alerts_enabled() && self.service.attention_count() > 0
    }

    fn publish_due(&self) {
        if catch_unwind(AssertUnwindSafe(|| (self.set_due)(self.due_flag()))).is_err() {
            log::error!("Publishing the reminders alert flag failed");
        }
    }

    /// `{ reminders, notice }`: the `reminders:list` answer and `reminders:changed` payload.
    pub fn snapshot(&self) -> RemindersSnapshot {
        RemindersSnapshot {
            reminders: self.service.list(),
            notice: *self.notice.lock().unwrap_or_else(PoisonError::into_inner),
        }
    }

    /// After every change: alert flag, renderers, and the timer (creating or snoozing moves it).
    fn publish(&self) {
        let published = catch_unwind(AssertUnwindSafe(|| {
            (self.set_due)(self.due_flag());
            (self.emit_changed)(&self.snapshot());
            self.scheduler.reschedule();
        }));
        if published.is_err() {
            // The change is already on disk: a failed notification must not report it as
            // failed. Nothing else is logged: the payload could carry reminder text.
            log::error!("Publishing reminders failed");
        }
    }

    /// Loads the file, purges old done ones, reports missed ones and arms the timer, then
    /// publishes (the file may hold due reminders from the last session). The channels wait for
    /// this to finish, even if it failed.
    pub async fn start(&self) -> Result<(), ExposedError> {
        let _ready = MarkReady(&self.ready);
        let outcome = self.store.load().await?;
        *self.notice.lock().unwrap_or_else(PoisonError::into_inner) = notice_of(outcome);
        self.scheduler.start().await;
        self.publish();
        Ok(())
    }

    /// Resolves once [`start`](Self::start) has finished (even if it failed).
    pub async fn ready(&self) {
        let mut ready = self.ready.subscribe();
        // The sender lives as long as `self`, so this only ends once the gate is open.
        let _ = ready.wait_for(|ready| *ready).await;
    }

    /// A coalesced due check (power events, the E2E test clock).
    pub async fn check(&self) {
        self.scheduler.check().await;
    }

    /// For [`PowerEvents`](crate::platform::power::PowerEvents): resume and unlock check at once.
    pub fn power_listener(&self) -> PowerListener {
        check_on_power(Arc::downgrade(&self.scheduler))
    }

    /// Stops the timer and the safety interval (quit).
    pub fn dispose(&self) {
        self.scheduler.dispose();
    }
}

impl<Z> RemindersApi for RemindersRuntime<Z>
where
    Z: TimeZone + Send + Sync + 'static,
    Z::Offset: Send + Sync,
{
    fn ready(&self) -> BoxFuture<'_, ()> {
        Box::pin(RemindersRuntime::ready(self))
    }

    fn snapshot(&self) -> RemindersSnapshot {
        RemindersRuntime::snapshot(self)
    }

    fn create(&self, input: CreateReminderInput) -> BoxFuture<'_, Result<Reminder, ExposedError>> {
        Box::pin(self.service.create(input))
    }

    fn update(&self, input: UpdateReminderInput) -> BoxFuture<'_, Result<Reminder, ExposedError>> {
        Box::pin(self.service.update(input))
    }

    fn snooze(&self, id: String) -> BoxFuture<'_, Result<Reminder, ExposedError>> {
        Box::pin(async move { self.service.snooze(&id).await })
    }

    fn complete(&self, id: String) -> BoxFuture<'_, Result<Reminder, ExposedError>> {
        Box::pin(async move { self.service.complete(&id).await })
    }

    fn remove(&self, id: String) -> BoxFuture<'_, Result<(), ExposedError>> {
        Box::pin(async move { self.service.remove(&id).await })
    }
}

#[cfg(test)]
mod tests;
