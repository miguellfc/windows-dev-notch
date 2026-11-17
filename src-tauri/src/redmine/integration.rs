//! The Redmine state machine of the main process (port of
//! 0.1.0's `redmine-integration.ts`) and its Tauri wiring pieces (0.1.0's `index.ts`).
//!
//! One runtime: key, client, generation, 300 s rhythm with backoff (issues and today's hours),
//! and the month summary every 900 s while the Redmine view is open. Everything lives under one
//! `Mutex`, never held across an `.await`, an emit or the opener: each operation collects its
//! effects under the lock and runs them once it is released, in sequence order (an older
//! snapshot that reaches the emitter late is dropped). After every `.await` the result is
//! dropped when the session moved to another generation, was disposed or turned `auth-error`
//! meanwhile (`isStale`).
//!
//! Offline is the VPN case: a DNS failure, a refused connection, a TLS failure or the 30 s
//! timeout is `network`, which backs off (1, 2, 4, 5 min) with status `offline` and keeps the
//! account, the issues and today's hours; the next success recovers on its own.
//!
//! Local dates ("today", the summary range, the day stamp of today's hours) are those of `Tz`
//! (production `chrono::Local`, which follows the Windows zone rules; tests `chrono_tz`), read
//! from the [`WallClock`] (the E2E test clock moves it). Where Windows and ICU disagree on an
//! offset the local day can differ from the renderer's for that hour: the part-4 follow-up,
//! documented, not fixed here.
//!
//! Logs carry only states, codes, `what`, `result`, `retryInMs` and `persistent`, as
//! `key=value`, under the `main:redmine` scope: never the key, subjects, projects, comments, the
//! account, URLs or the server host.
//!
//! Dev/E2E switch (ignored unless `ipc::dev_overrides_enabled()`):
//! `NOTCH_REDMINE_BASE_URL=http://127.0.0.1:<port>`. The settings keep the https URL (`open`
//! builds the issue URL from it); only the client talks to the loopback fake.

use std::collections::HashSet;
use std::future::Future;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use chrono::{DateTime, Local, TimeZone, Utc};
use tokio::sync::watch;

pub use crate::apps::OpenExternal;
use crate::apps::{is_loopback_origin, origin_of};
use crate::code_review::contributions::local_date;
use crate::contract::redmine::{
    LogTimeInput, RedmineActivity, RedmineIssueDetail, RedmineIssueList, RedmineSetKeyResult,
    RedmineState, RedmineStatus, RedmineSummary, RedmineSummaryChanged, RedmineSummaryResult,
    RedmineWriteError, RedmineWriteResult, SetKeyReason, UpdateIssueInput,
};
use crate::contract::settings::RedmineSettings;
use crate::contract::text::js_trim;
use crate::http::ApiError;
use crate::ipc::{BoxFuture, ExposedError, IpcErrorCode};
use crate::notch::runtime::NotchRuntime;
use crate::redmine::client::{IssuePatch, RedmineApiClient, TimeEntryInput};
use crate::redmine::summary::{sum_hours, summarize_hours, summary_range};
use crate::services::clock::WallClock;
pub use crate::services::secure_token_store::TokenStore;
use crate::services::tasks::finished;
pub use crate::services::tasks::Spawner;
use crate::services::timers::{TimerId, Timers};
use crate::settings::validate::normalize_redmine_url;

/// Today's hours and the assigned issues: one query every 5 minutes, in every notch mode.
pub const TICK_MS: u64 = 300_000;
/// Waits after consecutive network / 5xx / 429 / invalid-response failures: 1, 2, 4, 5 min (max).
pub const BACKOFF_MS: [u64; 4] = [60_000, 120_000, 240_000, 300_000];
/// Month summary rhythm, only while the Redmine view is open.
pub const SUMMARY_TICK_MS: u64 = 900_000;
/// Minimum time between two manual refreshes.
pub const MANUAL_REFRESH_MIN_MS: i64 = 5_000;
/// The dev/E2E switch (a single loopback origin).
pub const BASE_URL_ENV: &str = "NOTCH_REDMINE_BASE_URL";
/// `log` target whose scope is `main:redmine` (the E2E log check looks for `redmine`).
pub const LOG_TARGET: &str = concat!(env!("CARGO_CRATE_NAME"), "::redmine");
/// The DPAPI key file in the data directory, and its log scope.
pub const KEY_FILE: &str = "redmine.bin";
pub const KEY_LOG_SCOPE: &str = "redmine-token";

/// `RedmineSettingsSource` without `onChange`: the wiring calls
/// [`RedmineIntegration::on_settings_changed`] from the store's listener instead.
pub trait SettingsSource: Send + Sync {
    fn get(&self) -> RedmineSettings;
    /// Saves `redmine.url` through the settings updater (validation, `settings:changed`,
    /// listeners). The error is a code only.
    fn update(&self, url: String) -> BoxFuture<'_, Result<(), String>>;
}

/// `clientFactory(baseUrl, apiKey)`; `None` where the TS factory throws.
pub type ClientFactory = Arc<dyn Fn(&str, &str) -> Option<Arc<dyn RedmineApiClient>> + Send + Sync>;

/// `RedmineIntegrationOptions`.
pub struct RedmineDeps {
    pub settings: Arc<dyn SettingsSource>,
    pub store: Arc<dyn TokenStore>,
    /// Called with the normalized https URL of the settings.
    pub client: ClientFactory,
    pub timers: Arc<dyn Timers>,
    /// `now`: the wall clock the E2E test clock moves (`updatedAt`, the refresh gate, "today"
    /// and the summary range).
    pub clock: Arc<WallClock>,
    pub spawn: Spawner,
    /// `redmine:state` to the notch and the Control Center.
    pub emit: Arc<dyn Fn(&RedmineState) + Send + Sync>,
    /// `redmine:summary-changed` to the notch.
    pub emit_summary: Arc<dyn Fn(&RedmineSummaryChanged) + Send + Sync>,
    pub open_external: OpenExternal,
}

/// `parseRedmineBaseOverride`: only an exact `http://127.0.0.1:<port>` origin (port 1..=65535),
/// trimmed; anything else turns the switch off.
pub fn parse_base_override(raw: Option<&str>) -> Option<String> {
    let value = js_trim(raw?);
    is_loopback_origin(value).then(|| value.to_owned())
}

/// [`parse_base_override`] of `raw` in dev/E2E builds; nothing in a release build.
pub fn base_override_from(enabled: bool, raw: Option<&str>) -> Option<String> {
    if enabled {
        parse_base_override(raw)
    } else {
        None
    }
}

fn usable(status: RedmineStatus) -> bool {
    matches!(status, RedmineStatus::Ok | RedmineStatus::Offline)
}

/// `failureReason`: why `set_key` refused a key the server did not accept.
fn failure_reason(error: ApiError) -> SetKeyReason {
    match error {
        ApiError::Auth => SetKeyReason::Auth,
        // A server that answers, but not like Redmine: most likely a wrong URL.
        ApiError::InvalidResponse => SetKeyReason::Url,
        _ => SetKeyReason::Network,
    }
}

fn write_result_code(result: &RedmineWriteResult) -> &'static str {
    match result {
        RedmineWriteResult::Done => "ok",
        RedmineWriteResult::Refused { reason, .. } => reason.as_str(),
    }
}

fn unavailable(message: impl Into<String>) -> ExposedError {
    ExposedError::new(IpcErrorCode::Unavailable, message)
}

/// The integration's handle: what the channels and the wiring use.
pub struct RedmineIntegration<Tz: TimeZone = Local> {
    deps: RedmineDeps,
    me: Weak<Self>,
    /// The local zone of "today" and the summary.
    tz: Tz,
    inner: Mutex<Inner>,
    ready: watch::Receiver<bool>,
    /// Whether the stored key survives a restart, asked once (a DPAPI round trip), never under
    /// the lock on every `state()` (the part-4 deviation).
    persistent: bool,
    /// The newest effect of each ordered kind that went out. Held while emitting, so effects
    /// decided under `inner` in order A, B never reach the renderer as B, A.
    emitted: Mutex<Emitted>,
}

/// Sequence numbers (assigned under `inner`) of the last state and summary events sent.
#[derive(Default)]
struct Emitted {
    state: u64,
    summary: u64,
}

/// A query in flight: who started it and a signal for when it ends.
struct InFlight {
    generation: u64,
    id: u64,
    done: watch::Receiver<bool>,
}

struct Inner {
    /// Copy of the settings' URL (updated by `set_key` and by outside changes).
    server_url: String,
    started: bool,
    disposed: bool,
    /// `None`: never (`-Infinity`).
    last_manual_refresh: Option<DateTime<Utc>>,
    view_open: bool,
    client: Option<Arc<dyn RedmineApiClient>>,
    status: RedmineStatus,
    account: Option<String>,
    today_hours: Option<f64>,
    /// Local date the `today_hours` reading belongs to: after midnight it is no longer today's.
    today_hours_day: Option<String>,
    /// Epoch milliseconds of the last successful query.
    updated_at: Option<f64>,
    issue_list: RedmineIssueList,
    /// Ids of the last list handed to the notch: `open` accepts these...
    sent: HashSet<u64>,
    /// ...and those read with `issue(id)` in this session (still openable once closed).
    read_issues: HashSet<u64>,
    /// Bumped whenever the key, URL or session changes: stale results are dropped.
    generation: u64,
    /// Bumped by every `set_key`/`clear`: an older validation that ends later changes nothing.
    key_seq: u64,
    timer: Option<(TimerId, u64)>,
    failures: usize,
    in_flight: Option<InFlight>,
    /// A key save in progress; a clear waits for it so the key never outlives a removal.
    pending_save: Option<watch::Receiver<bool>>,
    logged_status: Option<RedmineStatus>,
    summary: Option<RedmineSummary>,
    summary_error: bool,
    summary_timer: Option<(TimerId, u64)>,
    summary_in_flight: Option<InFlight>,
    /// Identifies timers and in-flight runs (a stale callback never clears a newer one).
    next_id: u64,
    /// Orders the effects decided under the lock (see [`Emitted`]).
    next_seq: u64,
}

impl Inner {
    fn new(server_url: String) -> Self {
        Self {
            server_url,
            started: false,
            disposed: false,
            last_manual_refresh: None,
            view_open: false,
            client: None,
            status: RedmineStatus::Unconfigured,
            account: None,
            today_hours: None,
            today_hours_day: None,
            updated_at: None,
            issue_list: RedmineIssueList::default(),
            sent: HashSet::new(),
            read_issues: HashSet::new(),
            generation: 0,
            key_seq: 0,
            timer: None,
            failures: 0,
            in_flight: None,
            pending_save: None,
            logged_status: None,
            summary: None,
            summary_error: false,
            summary_timer: None,
            summary_in_flight: None,
            next_id: 0,
            next_seq: 0,
        }
    }

    fn next_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    /// `canPoll`.
    fn can_poll(&self) -> bool {
        !self.disposed && self.started && self.client.is_some() && usable(self.status)
    }

    /// `isStale`: another generation, disposed, or the key was rejected meanwhile (only a new
    /// key revives it).
    fn is_stale(&self, started_in: u64) -> bool {
        started_in != self.generation || self.disposed || self.status == RedmineStatus::AuthError
    }

    /// `sessionClient`: the client of a usable session.
    fn session_client(&self) -> Option<Arc<dyn RedmineApiClient>> {
        self.client.clone().filter(|_| usable(self.status))
    }
}

/// What an operation decided under the lock, run once it is released (in order).
enum Effect {
    /// With its sequence number: an older snapshot never overwrites a newer one.
    State(u64, RedmineState),
    Summary(u64, RedmineSummaryChanged),
}

type Effects = Vec<Effect>;

/// Which of the two timers.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Rhythm {
    Poll,
    Summary,
}

impl<Tz> RedmineIntegration<Tz>
where
    Tz: TimeZone + Send + Sync + 'static,
    Tz::Offset: Send + Sync,
{
    /// `createRedmineIntegration`: starts loading the stored key (`ready`) at once.
    pub fn new(deps: RedmineDeps, tz: Tz) -> Arc<Self> {
        let server_url = deps.settings.get().url;
        let (loaded, ready) = watch::channel(false);
        let persistent = deps.store.persistent();
        let this = Arc::new_cyclic(|me| Self {
            deps,
            me: me.clone(),
            tz,
            inner: Mutex::new(Inner::new(server_url)),
            ready,
            persistent,
            emitted: Mutex::new(Emitted::default()),
        });
        // Captured now, as TS takes `startedIn` and `serverUrl` synchronously: an outside URL
        // change before the task first runs must not hand the old server's key to the new one.
        let (started_in, server_url) = {
            let inner = this.lock();
            (inner.generation, inner.server_url.clone())
        };
        let task = Arc::clone(&this);
        (this.deps.spawn)(Box::pin(async move {
            task.load_key(started_in, server_url).await;
            let _ = loaded.send(true);
        }));
        this
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Never taken while `inner` is held (emits never run under the state lock).
    fn emitted(&self) -> MutexGuard<'_, Emitted> {
        self.emitted.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The wall clock in the local zone.
    fn local_now(&self) -> DateTime<Tz> {
        self.deps.clock.now().with_timezone(&self.tz)
    }

    /// Resolves once the stored key was read (never fails).
    pub async fn ready(&self) {
        finished(Some(self.ready.clone())).await;
    }

    /// The `ready` task: reads the stored key, then publishes and polls (polling waits for
    /// `start`). `started_in` and `server_url` are those of the creation: the key is only used
    /// with the server it was loaded for, and only while that generation lasts.
    async fn load_key(&self, started_in: u64, server_url: String) {
        if server_url.is_empty() {
            // No server: a key left behind belongs to nobody.
            self.clear_stored_key().await;
        } else {
            let key = match self.deps.store.load().await {
                Ok(key) => key,
                Err(error) => {
                    log::warn!(target: LOG_TARGET, "Could not load the Redmine key error={error}");
                    None
                }
            };
            let mut inner = self.lock();
            if let Some(key) = key.filter(|key| !key.is_empty()) {
                if started_in == inner.generation && !inner.disposed {
                    if let Some(client) = self.build_client(&server_url, &key) {
                        inner.client = Some(client);
                        inner.status = RedmineStatus::Ok;
                    }
                }
            }
        }
        let mut effects = Effects::new();
        {
            let mut inner = self.lock();
            self.publish(&mut inner, &mut effects);
            self.poll(&mut inner);
        }
        self.run(effects);
    }

    /// `buildClient`: `None` when there is no acceptable URL.
    fn build_client(&self, base_url: &str, key: &str) -> Option<Arc<dyn RedmineApiClient>> {
        if base_url.is_empty() {
            return None;
        }
        (self.deps.client)(base_url, key)
    }

    /// `currentTodayHours`: the last reading only while it is still the same local day.
    fn current_today_hours(&self, inner: &Inner) -> Option<f64> {
        let today = local_date(&self.local_now());
        (inner.today_hours_day.as_deref() == Some(today.as_str()))
            .then_some(inner.today_hours)
            .flatten()
    }

    fn state_of(&self, inner: &Inner) -> RedmineState {
        RedmineState {
            status: inner.status,
            account: inner.account.clone(),
            today_hours: self.current_today_hours(inner),
            updated_at: inner.updated_at,
            persistent: self.persistent,
        }
    }

    pub fn state(&self) -> RedmineState {
        self.state_of(&self.lock())
    }

    /// Hours logged today with a session (`ok`/`offline`), else `None` (also when the last
    /// reading is from an earlier day); for the end-of-day alert.
    pub fn today_hours(&self) -> Option<f64> {
        let inner = self.lock();
        if usable(inner.status) {
            self.current_today_hours(&inner)
        } else {
            None
        }
    }

    /// `publish`: logs status changes, then the whole state goes out.
    fn publish(&self, inner: &mut Inner, effects: &mut Effects) {
        if inner.disposed {
            return;
        }
        if inner.logged_status != Some(inner.status) {
            log::info!(target: LOG_TARGET, "Redmine status status={}", inner.status.as_str());
            inner.logged_status = Some(inner.status);
        }
        inner.next_seq += 1;
        effects.push(Effect::State(inner.next_seq, self.state_of(inner)));
    }

    /// `emitSummary`.
    fn emit_summary(&self, inner: &mut Inner, effects: &mut Effects) {
        if inner.disposed {
            return;
        }
        inner.next_seq += 1;
        effects.push(Effect::Summary(
            inner.next_seq,
            RedmineSummaryChanged {
                error: inner.summary_error,
            },
        ));
    }

    /// Runs what the lock decided, with no lock held.
    ///
    /// Two operations may lock in order A, B and get here in order B, A (the tauri runtime has
    /// several workers): the emit-order lock drops an event older than the last one of its kind
    /// sent (it carries a stale snapshot; the newer one already went out). Nothing goes out once
    /// disposed (the quit is under way).
    fn run(&self, effects: Effects) {
        for effect in effects {
            if self.lock().disposed {
                return;
            }
            match effect {
                Effect::State(seq, state) => {
                    let mut emitted = self.emitted();
                    if seq > emitted.state {
                        emitted.state = seq;
                        (self.deps.emit)(&state);
                    }
                }
                Effect::Summary(seq, change) => {
                    let mut emitted = self.emitted();
                    if seq > emitted.summary {
                        emitted.summary = seq;
                        (self.deps.emit_summary)(&change);
                    }
                }
            }
        }
    }

    fn timer_slot(inner: &mut Inner, rhythm: Rhythm) -> &mut Option<(TimerId, u64)> {
        match rhythm {
            Rhythm::Poll => &mut inner.timer,
            Rhythm::Summary => &mut inner.summary_timer,
        }
    }

    fn clear_timer(&self, inner: &mut Inner, rhythm: Rhythm) {
        if let Some((id, _)) = Self::timer_slot(inner, rhythm).take() {
            self.deps.timers.clear(id);
        }
    }

    /// Arms a timer (callbacks never run inside `set_timeout`, so the lock may be held).
    fn arm(&self, inner: &mut Inner, rhythm: Rhythm, ms: u64) {
        let token = inner.next_id();
        let me = self.me.clone();
        let id = self.deps.timers.set_timeout(
            ms,
            Box::new(move || {
                if let Some(this) = me.upgrade() {
                    this.timer_fired(rhythm, token);
                }
            }),
        );
        *Self::timer_slot(inner, rhythm) = Some((id, token));
    }

    fn timer_fired(&self, rhythm: Rhythm, token: u64) {
        let mut inner = self.lock();
        let slot = Self::timer_slot(&mut inner, rhythm);
        // Another token: this timer was cleared or replaced meanwhile (it fired in the race with
        // `clear`), so it must not poll.
        if !slot.is_some_and(|(_, armed)| armed == token) {
            return;
        }
        *slot = None;
        match rhythm {
            Rhythm::Poll => self.poll(&mut inner),
            Rhythm::Summary => self.poll_summary(&mut inner),
        };
    }

    /// `schedule`.
    fn schedule(&self, inner: &mut Inner, ms: u64) {
        self.clear_timer(inner, Rhythm::Poll);
        if !inner.started || inner.disposed {
            return;
        }
        self.arm(inner, Rhythm::Poll, ms);
    }

    /// `scheduleSummary`.
    fn schedule_summary(&self, inner: &mut Inner) {
        self.clear_timer(inner, Rhythm::Summary);
        if !inner.view_open || !inner.started || inner.disposed {
            return;
        }
        self.arm(inner, Rhythm::Summary, SUMMARY_TICK_MS);
    }

    /// `resetSession`: forgets everything tied to the current key (not the stored key itself).
    /// Callers publish. `today_hours_day` stays, as in TS (`today_hours` is `None` anyway).
    fn reset_session(&self, inner: &mut Inner, effects: &mut Effects) {
        inner.generation += 1;
        self.clear_timer(inner, Rhythm::Poll);
        inner.client = None;
        inner.account = None;
        inner.today_hours = None;
        inner.updated_at = None;
        inner.issue_list = RedmineIssueList::default();
        inner.sent.clear();
        inner.read_issues.clear();
        inner.failures = 0;
        inner.status = RedmineStatus::Unconfigured;
        self.clear_timer(inner, Rhythm::Summary);
        let had_summary = inner.summary.is_some() || inner.summary_error;
        inner.summary = None;
        inner.summary_error = false;
        if had_summary {
            self.emit_summary(inner, effects);
        }
    }

    /// `authFailed`: the key no longer works; stop asking until a new one is saved. The client
    /// and the account stay (`can_poll` is false from now on).
    fn auth_failed(&self, inner: &mut Inner, effects: &mut Effects) {
        log::warn!(target: LOG_TARGET, "Redmine key rejected");
        self.clear_timer(inner, Rhythm::Poll);
        self.clear_timer(inner, Rhythm::Summary);
        inner.today_hours = None;
        inner.issue_list = RedmineIssueList::default();
        inner.sent.clear();
        inner.read_issues.clear();
        inner.status = RedmineStatus::AuthError;
        self.publish(inner, effects);
    }

    /// `clearStoredKey`: after any save in progress.
    async fn clear_stored_key(&self) {
        let pending = self.lock().pending_save.clone();
        finished(pending).await;
        if let Err(error) = self.deps.store.clear().await {
            log::warn!(target: LOG_TARGET, "Could not clear the Redmine key error={error}");
        }
    }

    /// Starts a background run and records it as in flight; returns its signal.
    fn spawn_run<F, Fut>(
        &self,
        inner: &mut Inner,
        rhythm: Rhythm,
        run: F,
    ) -> Option<watch::Receiver<bool>>
    where
        F: FnOnce(Arc<Self>, u64, Arc<dyn RedmineApiClient>) -> Fut,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let client = Arc::clone(inner.client.as_ref()?);
        let this = self.me.upgrade()?;
        let started_in = inner.generation;
        self.clear_timer(inner, rhythm);
        let id = inner.next_id();
        let (finish, done) = watch::channel(false);
        let entry = Some(InFlight {
            generation: started_in,
            id,
            done: done.clone(),
        });
        match rhythm {
            Rhythm::Poll => inner.in_flight = entry,
            Rhythm::Summary => inner.summary_in_flight = entry,
        }
        let task = run(Arc::clone(&this), started_in, client);
        (self.deps.spawn)(Box::pin(async move {
            task.await;
            {
                let mut inner = this.lock();
                let slot = match rhythm {
                    Rhythm::Poll => &mut inner.in_flight,
                    Rhythm::Summary => &mut inner.summary_in_flight,
                };
                if slot.as_ref().is_some_and(|run| run.id == id) {
                    *slot = None;
                }
            }
            let _ = finish.send(true);
        }));
        Some(done)
    }

    /// `poll`: one query per generation at a time; returns the signal of the run.
    fn poll(&self, inner: &mut Inner) -> Option<watch::Receiver<bool>> {
        if let Some(in_flight) = &inner.in_flight {
            if in_flight.generation == inner.generation {
                return Some(in_flight.done.clone());
            }
        }
        if !inner.can_poll() {
            return None;
        }
        self.spawn_run(inner, Rhythm::Poll, |this, started_in, client| async move {
            this.run_poll(started_in, client).await;
        })
    }

    /// `runPoll`.
    async fn run_poll(&self, started_in: u64, client: Arc<dyn RedmineApiClient>) {
        let known = self.lock().account.clone();
        let result = async {
            // The account once per session (the key check already asked for it).
            let account = match known {
                Some(account) => account,
                None => client.viewer().await?.name,
            };
            // The day comes from the clock on every query: midnight takes effect at once.
            let today = local_date(&self.local_now());
            let (list, entries) =
                tokio::try_join!(client.issues(), client.time_entries(&today, &today))?;
            Ok::<_, ApiError>((account, today, list, entries))
        }
        .await;
        let mut effects = Effects::new();
        {
            let mut inner = self.lock();
            if inner.is_stale(started_in) {
                return;
            }
            match result {
                Ok((account, today, list, entries)) => {
                    inner.account = Some(account);
                    inner.issue_list = list;
                    inner.today_hours = Some(sum_hours(
                        entries.iter().filter(|entry| entry.date == today),
                    ));
                    inner.today_hours_day = Some(today);
                    #[allow(clippy::cast_precision_loss, reason = "epoch ms fit f64 exactly")]
                    let updated_at = self.deps.clock.now().timestamp_millis() as f64;
                    inner.updated_at = Some(updated_at);
                    inner.failures = 0;
                    inner.status = RedmineStatus::Ok;
                    self.publish(&mut inner, &mut effects);
                    self.schedule(&mut inner, TICK_MS);
                }
                Err(ApiError::Auth) => self.auth_failed(&mut inner, &mut effects),
                Err(error) => {
                    let wait = BACKOFF_MS[inner.failures.min(BACKOFF_MS.len() - 1)];
                    inner.failures += 1;
                    log::warn!(target: LOG_TARGET, "Redmine query failed code={} retryInMs={wait}", error.code());
                    inner.status = RedmineStatus::Offline;
                    self.publish(&mut inner, &mut effects);
                    self.schedule(&mut inner, wait);
                }
            }
        }
        self.run(effects);
    }

    /// `pollSummary`: never with the view closed; one query per generation at a time.
    fn poll_summary(&self, inner: &mut Inner) -> Option<watch::Receiver<bool>> {
        if !inner.view_open || !inner.can_poll() {
            return None;
        }
        if let Some(in_flight) = &inner.summary_in_flight {
            if in_flight.generation == inner.generation {
                return Some(in_flight.done.clone());
            }
        }
        self.spawn_run(
            inner,
            Rhythm::Summary,
            |this, started_in, client| async move {
                this.run_summary(started_in, client).await;
            },
        )
    }

    /// `runSummary`: the range comes from the clock on every query (a new day, week or month
    /// takes effect at once).
    async fn run_summary(&self, started_in: u64, client: Arc<dyn RedmineApiClient>) {
        let at = self.local_now();
        let (from, to) = summary_range(&at);
        let result = client.time_entries(&from, &to).await;
        let mut effects = Effects::new();
        {
            let mut inner = self.lock();
            if inner.is_stale(started_in) {
                return;
            }
            match result {
                Ok(entries) => {
                    inner.summary = Some(summarize_hours(&entries, &at));
                    inner.summary_error = false;
                }
                Err(ApiError::Auth) => {
                    self.auth_failed(&mut inner, &mut effects);
                    // The state's auth-error decides what the view shows; the flag only ends a
                    // pending retry.
                    inner.summary_error = true;
                    self.emit_summary(&mut inner, &mut effects);
                    drop(inner);
                    self.run(effects);
                    return;
                }
                Err(error) => {
                    // The issues, hours and status stay: only the view's summary shows it.
                    log::warn!(target: LOG_TARGET, "Redmine summary query failed code={}", error.code());
                    inner.summary_error = true;
                }
            }
            self.emit_summary(&mut inner, &mut effects);
            self.schedule_summary(&mut inner);
        }
        self.run(effects);
    }

    /// `afterInFlight`: the in-flight poll's signal, if any.
    fn in_flight_poll(&self) -> Option<watch::Receiver<bool>> {
        self.lock().in_flight.as_ref().map(|run| run.done.clone())
    }

    /// The last list of open assigned issues (no URLs), remembered as the ids `open` accepts.
    pub async fn issues(&self) -> RedmineIssueList {
        self.ready().await;
        finished(self.in_flight_poll()).await;
        let mut inner = self.lock();
        let list = if usable(inner.status) {
            inner.issue_list.clone()
        } else {
            RedmineIssueList::default()
        };
        inner.sent = list.issues.iter().map(|issue| issue.id).collect();
        list
    }

    /// `read`: a read for the view. `auth` turns the session auth-error; every failure is
    /// UNAVAILABLE with a code only. `keep` runs under the lock with the result, only when it is
    /// handed out.
    async fn read<T, F, Fut>(
        &self,
        what: &'static str,
        run: F,
        keep: impl FnOnce(&mut Inner),
    ) -> Result<T, ExposedError>
    where
        F: FnOnce(Arc<dyn RedmineApiClient>) -> Fut,
        Fut: Future<Output = Result<T, ApiError>>,
    {
        self.ready().await;
        let (client, started_in) = {
            let inner = self.lock();
            let Some(client) = inner.session_client() else {
                return Err(unavailable("Redmine is not connected"));
            };
            (client, inner.generation)
        };
        let result = run(client).await;
        let mut effects = Effects::new();
        let outcome = {
            let mut inner = self.lock();
            if inner.is_stale(started_in) {
                // An answer for a session that ended meanwhile (clear, new key or server,
                // dispose) is never handed out.
                Err(unavailable("Redmine session changed"))
            } else {
                match result {
                    Ok(value) => {
                        keep(&mut inner);
                        Ok(value)
                    }
                    Err(ApiError::Auth) => {
                        self.auth_failed(&mut inner, &mut effects);
                        Err(unavailable("Redmine key rejected"))
                    }
                    Err(error) => {
                        let code = error.code();
                        log::warn!(target: LOG_TARGET, "Redmine read failed what={what} code={code}");
                        Err(unavailable(format!("Redmine request failed: {code}")))
                    }
                }
            }
        };
        self.run(effects);
        outcome
    }

    /// One issue with its allowed statuses; UNAVAILABLE without a session or on failure. Its id
    /// stays openable for the rest of the session.
    pub async fn issue(&self, id: u64) -> Result<RedmineIssueDetail, ExposedError> {
        self.read(
            "issue",
            |client| async move { client.issue(id).await },
            |inner| {
                inner.read_issues.insert(id);
            },
        )
        .await
    }

    pub async fn activities(&self) -> Result<Vec<RedmineActivity>, ExposedError> {
        self.read(
            "activities",
            |client| async move { client.activities().await },
            |_| {},
        )
        .await
    }

    /// `refreshAfterWrite`: issues and today's hours again (the summary too with the view open),
    /// awaited, so the write's answer comes after the refreshed state and summary.
    async fn refresh_after_write(&self) {
        // A query started before the write may have read the old data: wait for it, then ask
        // again.
        finished(self.in_flight_poll()).await;
        let poll = self.poll(&mut self.lock());
        finished(poll).await;
        let summary = {
            let inner = self.lock();
            inner
                .view_open
                .then(|| inner.summary_in_flight.as_ref().map(|run| run.done.clone()))
        };
        if let Some(in_flight) = summary {
            finished(in_flight).await;
            let poll = self.poll_summary(&mut self.lock());
            finished(poll).await;
        }
    }

    /// `write`: never fails for Redmine's refusals. A success refreshes; a 401 ends the
    /// session; 403/404/422 and transport failures go back to the form as they are.
    async fn write<F, Fut>(&self, what: &'static str, run: F) -> RedmineWriteResult
    where
        F: FnOnce(Arc<dyn RedmineApiClient>) -> Fut,
        Fut: Future<Output = RedmineWriteResult>,
    {
        self.ready().await;
        let (client, started_in) = {
            let inner = self.lock();
            let Some(client) = inner.session_client() else {
                return RedmineWriteResult::Refused {
                    reason: RedmineWriteError::Auth,
                    messages: None,
                };
            };
            (client, inner.generation)
        };
        let result = run(client).await;
        log::info!(target: LOG_TARGET, "Redmine write what={what} result={}", write_result_code(&result));
        let refresh = {
            let mut inner = self.lock();
            if inner.is_stale(started_in) {
                return result;
            }
            match &result {
                RedmineWriteResult::Done => true,
                RedmineWriteResult::Refused {
                    reason: RedmineWriteError::Auth,
                    ..
                } => {
                    let mut effects = Effects::new();
                    self.auth_failed(&mut inner, &mut effects);
                    drop(inner);
                    self.run(effects);
                    false
                }
                RedmineWriteResult::Refused { .. } => false,
            }
        };
        if refresh {
            self.refresh_after_write().await;
        }
        result
    }

    /// Passes only the fields given (`estimatedHours: null` clears the estimate).
    pub async fn update_issue(&self, input: UpdateIssueInput) -> RedmineWriteResult {
        let patch = IssuePatch::from(&input);
        self.write("update-issue", |client| async move {
            client.update_issue(input.id, patch).await
        })
        .await
    }

    pub async fn log_time(&self, input: LogTimeInput) -> RedmineWriteResult {
        let entry = TimeEntryInput::from(&input);
        self.write(
            "log-time",
            |client| async move { client.log_time(&entry).await },
        )
        .await
    }

    /// The cached month summary (`None` without a session or not loaded yet) and the last
    /// query's error; never queries.
    pub async fn summary(&self) -> RedmineSummaryResult {
        self.ready().await;
        let inner = self.lock();
        let usable = usable(inner.status);
        RedmineSummaryResult {
            summary: if usable { inner.summary.clone() } else { None },
            error: usable && inner.summary_error,
        }
    }

    /// The Redmine view opened or closed: the summary is queried on open and every 15 min while
    /// open (an in-flight query still finishes and emits after a close).
    pub fn set_view_open(&self, open: bool) {
        let mut inner = self.lock();
        if inner.view_open == open {
            return;
        }
        inner.view_open = open;
        if open {
            self.poll_summary(&mut inner);
        } else {
            self.clear_timer(&mut inner, Rhythm::Summary);
        }
    }

    /// Queries now (at most every 5 s); the summary too while the view is open.
    pub fn refresh(&self) {
        let at = self.deps.clock.now();
        let mut inner = self.lock();
        if inner
            .last_manual_refresh
            .is_some_and(|last| (at - last).num_milliseconds() < MANUAL_REFRESH_MIN_MS)
        {
            return;
        }
        inner.last_manual_refresh = Some(at);
        self.poll(&mut inner);
        self.poll_summary(&mut inner);
    }

    /// Opens an issue of the last list sent or one read with `issue(id)`, only on the
    /// configured server's https origin. The URL is built from the settings URL (also under the
    /// dev override, whose client talks to a loopback fake). Returns at once; the browser opens
    /// in the background.
    pub fn open(&self, id: u64) -> Result<(), ExposedError> {
        let url = {
            let inner = self.lock();
            let known = inner.sent.contains(&id) || inner.read_issues.contains(&id);
            if !known || inner.client.is_none() {
                log::warn!(target: LOG_TARGET, "Refused to open an issue not shown in the notch");
                return Err(ExposedError::new(
                    IpcErrorCode::InvalidInput,
                    "Unknown issue",
                ));
            }
            let url = format!("{}/issues/{id}", inner.server_url);
            let allowed = if inner.server_url.is_empty() {
                None
            } else {
                origin_of(&inner.server_url)
            };
            if allowed.is_none() || origin_of(&url) != allowed {
                log::warn!(target: LOG_TARGET, "Refused to open an issue outside the configured server");
                return Err(ExposedError::new(
                    IpcErrorCode::InvalidInput,
                    "Issue URL not allowed",
                ));
            }
            url
        };
        let opening = (self.deps.open_external)(url);
        (self.deps.spawn)(Box::pin(async move {
            if let Err(error) = opening.await {
                log::warn!(target: LOG_TARGET, "Could not open the issue in the browser error={error}");
            }
        }));
        Ok(())
    }

    /// Validates the key (and the URL) against the server before saving anything.
    pub async fn set_key(&self, raw_url: &str, raw_key: &str) -> RedmineSetKeyResult {
        let refused = |reason| RedmineSetKeyResult::Refused { reason };
        self.ready().await;
        let key = js_trim(raw_key);
        if key.is_empty() {
            return refused(SetKeyReason::Auth);
        }
        let Some(base_url) = normalize_redmine_url(raw_url) else {
            return refused(SetKeyReason::Url);
        };
        let Some(candidate) = self.build_client(&base_url, key) else {
            return refused(SetKeyReason::Url);
        };
        let seq = {
            let mut inner = self.lock();
            inner.key_seq += 1;
            inner.key_seq
        };
        let name = match candidate.viewer().await {
            Ok(viewer) => viewer.name,
            Err(error) => {
                log::warn!(target: LOG_TARGET, "Redmine key check failed code={}", error.code());
                return refused(failure_reason(error));
            }
        };
        let superseded = |inner: &Inner| inner.key_seq != seq || inner.disposed;
        // `Some(previous URL)` when the server must be saved first.
        let new_server = {
            let mut inner = self.lock();
            if superseded(&inner) {
                return refused(SetKeyReason::Network);
            }
            // Set first, so the settings change is not taken for an outside one.
            (base_url != inner.server_url)
                .then(|| std::mem::replace(&mut inner.server_url, base_url.clone()))
        };
        if let Some(previous_url) = new_server {
            if let Err(error) = self.deps.settings.update(base_url.clone()).await {
                // Settings still hold the old server: keep memory in step with them and keep
                // nothing of the new key (it belongs to a server that was never saved). The
                // current session is untouched.
                log::warn!(target: LOG_TARGET, "Could not save the Redmine server error={error}");
                let mut inner = self.lock();
                if inner.server_url == base_url {
                    inner.server_url = previous_url;
                }
                return refused(SetKeyReason::Network);
            }
            if superseded(&self.lock()) {
                return refused(SetKeyReason::Network);
            }
        }
        let (saved, pending_save) = watch::channel(false);
        let mut effects = Effects::new();
        {
            let mut inner = self.lock();
            self.reset_session(&mut inner, &mut effects);
            inner.client = Some(candidate);
            inner.account = Some(name.clone());
            inner.status = RedmineStatus::Ok;
            inner.pending_save = Some(pending_save);
            log::info!(target: LOG_TARGET, "Redmine key saved persistent={}", self.persistent);
            self.publish(&mut inner, &mut effects);
            self.poll(&mut inner);
            self.poll_summary(&mut inner);
        }
        self.run(effects);
        if let Err(error) = self.deps.store.save(key).await {
            log::warn!(target: LOG_TARGET, "Could not save the Redmine key error={error}");
        }
        let _ = saved.send(true);
        RedmineSetKeyResult::Accepted { account: name }
    }

    /// Removes the key and the session (the URL stays in settings).
    pub async fn clear(&self) {
        self.ready().await;
        let mut effects = Effects::new();
        {
            let mut inner = self.lock();
            inner.key_seq += 1;
            self.reset_session(&mut inner, &mut effects);
            self.publish(&mut inner, &mut effects);
        }
        self.run(effects);
        self.clear_stored_key().await;
    }

    /// Starts the rhythm (once the channels and the windows exist).
    pub fn start(&self) {
        let mut inner = self.lock();
        if inner.started {
            return;
        }
        inner.started = true;
        self.poll(&mut inner);
        self.poll_summary(&mut inner);
    }

    /// Stops both timers; later results and publishes are dropped (in-flight work is not
    /// waited for).
    pub fn dispose(&self) {
        let mut inner = self.lock();
        inner.disposed = true;
        self.clear_timer(&mut inner, Rhythm::Poll);
        self.clear_timer(&mut inner, Rhythm::Summary);
    }

    /// The settings changed (`settings.onChange`): a URL changed from outside `set_key` closes
    /// the session and drops the stored key, which must never reach the new server. Target and
    /// end-of-day changes need nothing here.
    pub fn on_settings_changed(&self, next: &RedmineSettings) {
        let mut effects = Effects::new();
        {
            let mut inner = self.lock();
            if inner.disposed || next.url == inner.server_url {
                return;
            }
            inner.server_url = next.url.clone();
            inner.key_seq += 1;
            self.reset_session(&mut inner, &mut effects);
            log::info!(target: LOG_TARGET, "Redmine server changed; session closed");
            self.publish(&mut inner, &mut effects);
        }
        self.run(effects);
        if let Some(this) = self.me.upgrade() {
            (self.deps.spawn)(Box::pin(async move {
                this.clear_stored_key().await;
            }));
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Tauri wiring pieces (0.1.0's `index.ts`). Task 5 owns `lib.rs`, the channels and `e2e.rs`:
// it fills the `redmine` slot with the returned integration, manages it and calls `start()`
// once the channels are registered.

/// The settings store as the integration sees it: the `redmine` block, with `redmine.url` saved
/// through `SettingsStore::update` like every other change (validation, `settings:changed`,
/// listeners).
struct AppSettings(tauri::AppHandle);

impl SettingsSource for AppSettings {
    fn get(&self) -> RedmineSettings {
        use tauri::Manager;
        self.0
            .state::<crate::settings::SettingsStore>()
            .get()
            .redmine
    }

    fn update(&self, url: String) -> BoxFuture<'_, Result<(), String>> {
        use crate::contract::settings::{RedmineSettingsPatch, SettingsPatch};
        use tauri::Manager;
        Box::pin(async move {
            let patch = SettingsPatch {
                redmine: Some(RedmineSettingsPatch {
                    url: Some(url),
                    ..RedmineSettingsPatch::default()
                }),
                ..SettingsPatch::default()
            };
            self.0
                .state::<crate::settings::SettingsStore>()
                .update(patch)
                .await
                .map(drop)
                .map_err(|error| format!("{:?}", error.code()))
        })
    }
}

/// The client factory of the app: the settings' https URL, or the loopback fake of
/// `NOTCH_REDMINE_BASE_URL` in dev/E2E (`overridden`), on one shared transport.
pub fn client_factory(
    transport: Arc<dyn crate::http::Transport>,
    overridden: Option<String>,
) -> ClientFactory {
    use super::client::RedmineClient;
    Arc::new(move |base_url: &str, key: &str| {
        let client = match &overridden {
            Some(fake) => {
                RedmineClient::new_allowing_loopback_http(Arc::clone(&transport), fake.clone(), key)
            }
            None => RedmineClient::new(Arc::clone(&transport), base_url, key),
        };
        client
            .ok()
            .map(|client| Arc::new(client) as Arc<dyn RedmineApiClient>)
    })
}

/// Creates the integration on the notch's timers and the shared wall clock, and subscribes it
/// to the settings store. Call on the main thread once the settings store and the wall clock
/// are managed. It does not fill a slot nor start: Task 5 does both (`start()` after the
/// channels exist, as Electron does). `None` only when the HTTP client cannot be built.
pub fn install(
    app: &tauri::AppHandle,
    notch: &Arc<NotchRuntime>,
    data_dir: &Path,
) -> Option<Arc<RedmineIntegration>> {
    use crate::http::{ReqwestTransport, Transport};
    use crate::services::secure_token_store::SecureTokenStore;
    use crate::{ipc, settings::SettingsStore};
    use tauri::Manager;

    let overridden = base_override_from(
        ipc::dev_overrides_enabled(),
        ipc::dev_env_var(BASE_URL_ENV).as_deref(),
    );
    let transport: Arc<dyn Transport> = match ReqwestTransport::new() {
        Ok(transport) => Arc::new(transport),
        Err(_) => {
            log::error!(target: LOG_TARGET, "Redmine HTTP client unavailable; the integration stays off");
            return None;
        }
    };
    let deps = RedmineDeps {
        settings: Arc::new(AppSettings(app.clone())),
        store: Arc::new(SecureTokenStore::new(
            data_dir.join(KEY_FILE),
            KEY_LOG_SCOPE,
        )),
        client: client_factory(transport, overridden),
        timers: notch.timers(),
        clock: Arc::clone(&app.state::<Arc<WallClock>>()),
        spawn: Arc::new(|future| {
            tauri::async_runtime::spawn(future);
        }),
        emit: {
            let app = app.clone();
            Arc::new(move |state: &RedmineState| {
                let targets = ipc::existing_windows(&app);
                if !targets.is_empty() {
                    ipc::emit_event(&app, &targets, "redmine:state", state);
                }
            })
        },
        // The summary is shown only in the notch's Redmine view.
        emit_summary: {
            let app = app.clone();
            Arc::new(move |change: &RedmineSummaryChanged| {
                if app.get_webview_window(ipc::NOTCH).is_some() {
                    ipc::emit_event(&app, &[ipc::NOTCH], "redmine:summary-changed", change);
                }
            })
        },
        open_external: crate::apps::opener(app),
    };
    let integration = RedmineIntegration::new(deps, Local);
    {
        let integration = Arc::downgrade(&integration);
        app.state::<SettingsStore>().on_change(move |next| {
            if let Some(integration) = integration.upgrade() {
                integration.on_settings_changed(&next.redmine);
            }
        });
    }
    Some(integration)
}

#[cfg(test)]
#[path = "integration_tests.rs"]
mod tests;
