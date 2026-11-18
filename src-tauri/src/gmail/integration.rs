//! The Gmail state machine of the main process (port of 0.1.0's `gmail-integration.ts`)
//! and its Tauri wiring pieces (the Gmail part of 0.1.0's `index.ts`).
//!
//! One runtime: the client credentials, the stored refresh token, the access token (refreshed
//! once per session generation, 60 s before it expires), the unread count every 60 s in every
//! notch mode (plus the recent list while the Gmail view is open, and once per opening of the
//! main panel, at most every 60 s), backoff on trouble (1, 2, 4, 5 min), the shown ids (`sent`, the open message, the last alert), the actions, sign-in and
//! sign-out, and the new-mail alert.
//!
//! Everything lives under one `Mutex`, never held across an `.await`, an emit, the opener, the
//! new-mail callback or the browser wait of a sign-in: each operation collects its effects under
//! the lock and runs them once it is released, in sequence order (an older state snapshot that
//! reaches the emitter late is dropped). After every `.await` the result is dropped when the
//! session moved to another generation, was disposed or a sign-in started meanwhile
//! (`isStale`). `GmailAuth::cancel` and `GmailAuth::sign_in` (which registers its session
//! synchronously) are called under the lock, so a cancel and a new sign-in never cross.
//!
//! The access-token refresh is shared per generation and runs as its own task: a caller whose
//! future is dropped (a cancelled `map_pool` row, a dropped IPC call) never leaves it half done,
//! and every waiter of that generation gets its result. The client reaches the integration
//! through a [`TokenAccess`] holding a `Weak` and the generation it was built for: a call from an
//! older session changes nothing in the new one.
//!
//! Logs carry only states, codes, `action`, `count`, `reason`, `retryInMs` and error names, as
//! `key=value`, under the `main:gmail` scope: never tokens, the client secret, the account,
//! subjects, senders, snippets, bodies, links, URLs or ids. Never `Debug`-log a `GmailState` or
//! a message (their derived `Debug` prints the account and mail data).
//!
//! Dev/E2E switch (ignored unless `ipc::dev_overrides_enabled()`):
//! `NOTCH_GMAIL_BASE_URL=http://127.0.0.1:<port>` (exactly, no trim) moves the Gmail API, the
//! token endpoints and the consent screen to a loopback fake, as `index.ts` does.

use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use chrono::{DateTime, SecondsFormat, Utc};
use tokio::sync::watch;

use crate::apps::is_loopback_origin;
pub use crate::apps::OpenExternal;
use crate::contract::gmail::{
    is_web_url, GmailExpiredReason, GmailLink, GmailMessage, GmailMessageDetail, GmailNewMail,
    GmailSignInResult, GmailState, GmailStatus, UNREAD_CAP,
};
use crate::contract::settings::GmailSettings;
use crate::contract::text::js_trim;
use crate::gmail::auth::{has_required_scope, GmailAuth};
use crate::gmail::client::{
    encode_uri_component, GmailApiClient, GmailApiError, GmailError, TokenAccess,
};
use crate::gmail::new_mail::NewMailDetector;
use crate::ipc::{BoxFuture, ExposedError, IpcErrorCode};
use crate::notch::runtime::NotchRuntime;
use crate::services::clock::WallClock;
pub use crate::services::secure_token_store::TokenStore;
use crate::services::tasks::finished;
pub use crate::services::tasks::Spawner;
use crate::services::timers::{TimerId, Timers};

/// The unread count, in every notch mode (new-mail alerts show over mini and hidden too).
pub const TICK_MS: u64 = 60_000;
/// Waits after consecutive failures that do not end the session: 1, 2, 4, 5 min (max).
pub const BACKOFF_MS: [u64; 4] = [60_000, 120_000, 240_000, 300_000];
/// Minimum time between two manual refreshes.
pub const MANUAL_REFRESH_MIN_MS: i64 = 5_000;
/// Minimum time between two queries started by opening the main panel.
pub const PANEL_REFRESH_MIN_MS: u64 = 60_000;
/// An access token this close to expiry (ms) is refreshed before use.
pub const ACCESS_TOKEN_MARGIN_MS: f64 = 60_000.0;
/// The inbox; a thread is `INBOX_URL + "/" + encodeURIComponent(threadId)`.
pub const INBOX_URL: &str = "https://mail.google.com/mail/u/0/#inbox";
/// The dev/E2E switch (a single loopback origin).
pub const BASE_URL_ENV: &str = "NOTCH_GMAIL_BASE_URL";
/// `log` target whose scope is `main:gmail` (the E2E log check looks for `gmail`).
pub const LOG_TARGET: &str = concat!(env!("CARGO_CRATE_NAME"), "::gmail");

/// `parseGmailBaseOverride`: only an exact `http://127.0.0.1:<port>` origin (port 1..=65535),
/// **not** trimmed (unlike Redmine); anything else turns the switch off.
pub fn parse_base_override(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    is_loopback_origin(raw).then(|| raw.to_owned())
}

/// [`parse_base_override`] of `raw` in dev/E2E builds; nothing in a release build.
pub fn base_override_from(enabled: bool, raw: Option<&str>) -> Option<String> {
    if enabled {
        parse_base_override(raw)
    } else {
        None
    }
}

/// `GmailCredentials`: the trimmed client id and secret. `Debug` prints neither.
#[derive(Clone, PartialEq, Eq, Default)]
pub struct Credentials {
    pub client_id: String,
    pub client_secret: String,
}

impl std::fmt::Debug for Credentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Credentials").finish_non_exhaustive()
    }
}

impl Credentials {
    /// `credentialsOf`: JS `trim()` of both.
    pub fn of(settings: &GmailSettings) -> Self {
        Self {
            client_id: js_trim(&settings.client_id).to_owned(),
            client_secret: js_trim(&settings.client_secret).to_owned(),
        }
    }
}

/// `GmailSettingsSource` without `onChange`: the wiring calls
/// [`GmailIntegration::on_settings_changed`] from the store's listener instead. Main never
/// writes the Gmail settings.
pub trait SettingsSource: Send + Sync {
    fn get(&self) -> GmailSettings;
}

/// `authFactory(credentials)`.
pub type AuthFactory = Arc<dyn Fn(&Credentials) -> Arc<dyn GmailAuth> + Send + Sync>;
/// `clientFactory(access)`: one client per session generation.
pub type ClientFactory = Arc<dyn Fn(Arc<dyn TokenAccess>) -> Arc<dyn GmailApiClient> + Send + Sync>;
/// `onNewMail`: the app emits `gmail:new-mail` to the notch, then `NotchEvent::Mail { on: true }`.
pub type NewMailListener = Arc<dyn Fn(&GmailNewMail) + Send + Sync>;

/// `GmailIntegrationOptions`.
pub struct GmailDeps {
    pub settings: Arc<dyn SettingsSource>,
    pub store: Arc<dyn TokenStore>,
    pub auth: AuthFactory,
    pub client: ClientFactory,
    pub timers: Arc<dyn Timers>,
    /// `now`: the wall clock the E2E test clock moves (`updatedAt`, the refresh gate and the
    /// access token's expiry).
    pub clock: Arc<WallClock>,
    pub spawn: Spawner,
    /// `gmail:state` to the notch and the Control Center.
    pub emit: Arc<dyn Fn(&GmailState) + Send + Sync>,
    pub open_external: OpenExternal,
    pub on_new_mail: Option<NewMailListener>,
}

fn usable(status: GmailStatus) -> bool {
    matches!(status, GmailStatus::Ok | GmailStatus::Offline)
}

/// `stale()`: what a result of a session that no longer exists fails with.
fn stale() -> GmailError {
    GmailError::Api(GmailApiError::Unauthorized)
}

fn unavailable(message: impl Into<String>) -> ExposedError {
    ExposedError::new(IpcErrorCode::Unavailable, message)
}

fn now_ms(clock: &WallClock) -> f64 {
    #[allow(clippy::cast_precision_loss, reason = "epoch ms fit f64 exactly")]
    let ms = clock.now().timestamp_millis() as f64;
    ms
}

/// `new Date(now).toISOString()`.
fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// `GmailAction` (+ `open-link` for the refusal log).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Action {
    Message,
    MarkRead,
    Delete,
}

impl Action {
    fn as_str(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::MarkRead => "mark-read",
            Self::Delete => "delete",
        }
    }
}

/// The integration's handle: what the channels and the wiring use.
pub struct GmailIntegration {
    deps: GmailDeps,
    me: Weak<Self>,
    inner: Mutex<Inner>,
    ready: watch::Receiver<bool>,
    /// Whether the stored token survives a restart, asked once (the part-4 deviation).
    persistent: bool,
    /// Sequence number of the last state sent. Held while emitting, so states decided under
    /// `inner` in order A, B never reach the renderer as B, A.
    emitted: Mutex<u64>,
}

/// A run in flight: who started it and a signal for when it ends.
struct InFlight {
    generation: u64,
    id: u64,
    done: watch::Receiver<bool>,
}

/// The shared access-token refresh of one generation (`refreshing`).
struct Refreshing {
    generation: u64,
    id: u64,
    result: watch::Receiver<Option<Result<String, GmailError>>>,
}

struct Access {
    token: String,
    /// Epoch milliseconds.
    expires_at: f64,
}

/// `session`: the auth of the current credentials and the client of one generation.
struct Session {
    auth: Arc<dyn GmailAuth>,
    client: Option<(u64, Arc<dyn GmailApiClient>)>,
}

/// The message being read: its thread (`None` until the read finishes) and its links.
struct Opened {
    id: String,
    thread_id: Option<String>,
    links: Vec<GmailLink>,
}

struct Inner {
    credentials: Credentials,
    status: GmailStatus,
    account: Option<String>,
    unread: Option<u32>,
    updated_at: Option<String>,
    /// The last recent list.
    messages: Vec<GmailMessage>,
    /// The last list handed to the notch: `open` and the actions accept its ids.
    sent: Vec<GmailMessage>,
    opened: Option<Opened>,
    /// Bumped whenever the open message is forgotten: a read that finishes later is not kept.
    open_seq: u64,
    /// Id of the last new-mail alert: the notch may open it.
    alert_id: Option<String>,
    reason: Option<GmailExpiredReason>,
    /// Reset only with the session (sign-in, sign-out, client change); never by the notch mode.
    detector: NewMailDetector,
    refresh_token: Option<String>,
    access: Option<Access>,
    refreshing: Option<Refreshing>,
    /// Bumped whenever the session changes: stale results are dropped.
    generation: u64,
    session: Option<Session>,
    started: bool,
    view_open: bool,
    timer: Option<(TimerId, u64)>,
    failures: usize,
    in_flight: Option<InFlight>,
    /// `None`: never (`-Infinity`).
    last_manual_refresh: Option<DateTime<Utc>>,
    /// The last query started by opening the main panel, in this session (`None`: none yet).
    last_panel_refresh: Option<DateTime<Utc>>,
    /// The next query also brings the recent list, with the view closed (the panel's card).
    recent_wanted: bool,
    sign_in_seq: u64,
    /// Sequence number of the sign-in waiting for the browser, if any.
    pending_sign_in: Option<u64>,
    /// A token save from a finished sign-in; a clear waits for it.
    pending_save: Option<watch::Receiver<bool>>,
    status_before_sign_in: Option<GmailStatus>,
    disposed: bool,
    /// Turned off in the settings (`integrations.gmail.enabled`): no query, no state from a
    /// query, no alert. Unlike `disposed`, it can be undone.
    paused: bool,
    logged_status: Option<GmailStatus>,
    next_id: u64,
    next_seq: u64,
}

impl Inner {
    fn new(credentials: Credentials) -> Self {
        let status = if credentials.client_id.is_empty() {
            GmailStatus::Unconfigured
        } else {
            GmailStatus::SignedOut
        };
        Self {
            credentials,
            status,
            account: None,
            unread: None,
            updated_at: None,
            messages: Vec::new(),
            sent: Vec::new(),
            opened: None,
            open_seq: 0,
            alert_id: None,
            reason: None,
            detector: NewMailDetector::new(),
            refresh_token: None,
            access: None,
            refreshing: None,
            generation: 0,
            session: None,
            started: false,
            view_open: false,
            timer: None,
            failures: 0,
            in_flight: None,
            last_manual_refresh: None,
            last_panel_refresh: None,
            recent_wanted: false,
            sign_in_seq: 0,
            pending_sign_in: None,
            pending_save: None,
            status_before_sign_in: None,
            disposed: false,
            paused: false,
            logged_status: None,
            next_id: 0,
            next_seq: 0,
        }
    }

    fn next_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    fn configured(&self) -> bool {
        !self.credentials.client_id.is_empty()
    }

    /// `canPoll`.
    fn can_poll(&self) -> bool {
        !self.disposed
            && !self.paused
            && self.started
            && self.refresh_token.is_some()
            && usable(self.status)
    }

    /// `isStale`: another generation, disposed, or a sign-in under way.
    fn is_stale(&self, started_in: u64) -> bool {
        started_in != self.generation || self.disposed || self.status == GmailStatus::SigningIn
    }

    /// A query's answer (or its alert) is dropped: stale, or the integration was turned off
    /// meanwhile. User actions use [`Self::is_stale`] only: their answer is still owed.
    fn poll_dropped(&self, started_in: u64) -> bool {
        self.is_stale(started_in) || self.paused
    }

    /// `forgetOpen`.
    fn forget_open(&mut self) {
        self.open_seq += 1;
        self.opened = None;
    }

    /// `isShown`.
    fn is_shown(&self, id: &str) -> bool {
        self.sent.iter().any(|m| m.id == id)
            || self.opened.as_ref().is_some_and(|o| o.id == id)
            || self.alert_id.as_deref() == Some(id)
    }

    /// `requireShown`: main trusts no id from the renderer, only those it showed to the notch.
    fn require_shown(&self, action: &str, id: &str) -> Result<(), ExposedError> {
        if self.is_shown(id) {
            return Ok(());
        }
        log::warn!(target: LOG_TARGET, "Refused a Gmail action on a message not shown in the notch action={action}");
        Err(ExposedError::new(
            IpcErrorCode::InvalidInput,
            "Unknown message",
        ))
    }

    /// `activeSession`: the generation of a usable session, or UNAVAILABLE.
    fn active_session(&self) -> Result<u64, ExposedError> {
        if self.disposed || self.refresh_token.is_none() || !usable(self.status) {
            return Err(unavailable("Gmail is not connected"));
        }
        Ok(self.generation)
    }
}

/// What an operation decided under the lock, run once it is released (in order).
enum Effect {
    /// With its sequence number: an older snapshot never overwrites a newer one.
    State(u64, GmailState),
    /// With the generation it was decided in: a session that changed before it runs drops it.
    NewMail(u64, GmailNewMail),
}

type Effects = Vec<Effect>;

/// `accessFor(owner)`: token access bound to one session generation.
struct AccessFor {
    integration: Weak<GmailIntegration>,
    owner: u64,
}

impl TokenAccess for AccessFor {
    fn access_token(&self) -> BoxFuture<'_, Result<String, GmailError>> {
        Box::pin(async move {
            match self.integration.upgrade() {
                Some(integration) => integration.access_token(self.owner).await,
                None => Err(stale()),
            }
        })
    }

    fn on_unauthorized(&self) -> BoxFuture<'_, Result<bool, GmailError>> {
        Box::pin(async move {
            match self.integration.upgrade() {
                Some(integration) => integration.on_unauthorized(self.owner).await,
                None => Ok(false),
            }
        })
    }
}

/// Waits for a shared refresh; a refresh task that vanished (runtime shutting down) is stale.
async fn refreshed(
    mut result: watch::Receiver<Option<Result<String, GmailError>>>,
) -> Result<String, GmailError> {
    let value = result
        .wait_for(Option::is_some)
        .await
        .ok()
        .and_then(|value| Option::clone(&value));
    value.unwrap_or_else(|| Err(stale()))
}

impl GmailIntegration {
    /// `createGmailIntegration`: starts loading the stored token (`ready`) at once.
    pub fn new(deps: GmailDeps) -> Arc<Self> {
        let credentials = Credentials::of(&deps.settings.get());
        let (loaded, ready) = watch::channel(false);
        let persistent = deps.store.persistent();
        let this = Arc::new_cyclic(|me| Self {
            deps,
            me: me.clone(),
            inner: Mutex::new(Inner::new(credentials)),
            ready,
            persistent,
            emitted: Mutex::new(0),
        });
        // Captured now, as TS takes `startedIn` and `configured()` synchronously.
        let (started_in, configured) = {
            let inner = this.lock();
            (inner.generation, inner.configured())
        };
        let task = Arc::clone(&this);
        (this.deps.spawn)(Box::pin(async move {
            task.load_token(started_in, configured).await;
            let _ = loaded.send(true);
        }));
        this
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Never taken while `inner` is held.
    fn emitted(&self) -> MutexGuard<'_, u64> {
        self.emitted.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Resolves once the stored token was read (never fails).
    pub async fn ready(&self) {
        finished(Some(self.ready.clone())).await;
    }

    /// The `ready` task.
    async fn load_token(&self, started_in: u64, configured: bool) {
        let mut poll = false;
        if configured {
            let token = match self.deps.store.load().await {
                Ok(token) => token,
                Err(error) => {
                    log::warn!(target: LOG_TARGET, "Could not load the Gmail token error={error}");
                    None
                }
            };
            let mut inner = self.lock();
            if started_in == inner.generation && !inner.disposed {
                if let Some(token) = token.filter(|token| !token.is_empty()) {
                    inner.refresh_token = Some(token);
                    inner.status = GmailStatus::Ok;
                }
                poll = true;
            }
        } else {
            // No client: a token left behind belongs to nobody.
            let pending = self.lock().pending_save.clone();
            self.clear_stored_token(pending).await;
        }
        let mut effects = Effects::new();
        {
            let mut inner = self.lock();
            if started_in == inner.generation {
                self.publish(&mut inner, &mut effects);
            }
            if poll {
                self.poll(&mut inner);
            }
        }
        self.run(effects);
    }

    fn state_of(&self, inner: &Inner) -> GmailState {
        GmailState {
            status: inner.status,
            account: inner.account.clone(),
            unread: inner.unread,
            updated_at: inner.updated_at.clone(),
            persistent: self.persistent,
            reason: if inner.status == GmailStatus::Expired {
                inner.reason
            } else {
                None
            },
        }
    }

    pub fn state(&self) -> GmailState {
        self.state_of(&self.lock())
    }

    /// `publish`: logs status changes, then the whole state goes out.
    fn publish(&self, inner: &mut Inner, effects: &mut Effects) {
        if inner.disposed {
            return;
        }
        if inner.logged_status != Some(inner.status) {
            log::info!(target: LOG_TARGET, "Gmail status status={}", inner.status.as_str());
            inner.logged_status = Some(inner.status);
        }
        inner.next_seq += 1;
        effects.push(Effect::State(inner.next_seq, self.state_of(inner)));
    }

    /// Runs what the lock decided, with no lock held. A state older than the last one sent is
    /// dropped (two operations may lock in order A, B and get here in order B, A). A new-mail
    /// alert whose session went stale meanwhile is dropped: the check is made under the lock,
    /// which is released before the listener runs. Nothing goes out once disposed.
    fn run(&self, effects: Effects) {
        for effect in effects {
            let stale = {
                let inner = self.lock();
                if inner.disposed {
                    return;
                }
                matches!(effect, Effect::NewMail(started_in, _) if inner.poll_dropped(started_in))
            };
            if stale {
                continue;
            }
            match effect {
                Effect::State(seq, state) => {
                    let mut emitted = self.emitted();
                    if seq > *emitted {
                        *emitted = seq;
                        (self.deps.emit)(&state);
                    }
                }
                Effect::NewMail(_, mail) => {
                    if let Some(listener) = &self.deps.on_new_mail {
                        listener(&mail);
                    }
                }
            }
        }
    }

    fn clear_timer(&self, inner: &mut Inner) {
        if let Some((id, _)) = inner.timer.take() {
            self.deps.timers.clear(id);
        }
    }

    /// `schedule`: callbacks never run inside `set_timeout`, so the lock may be held.
    fn schedule(&self, inner: &mut Inner, ms: u64) {
        self.clear_timer(inner);
        if !inner.started || inner.disposed {
            return;
        }
        let token = inner.next_id();
        let me = self.me.clone();
        let id = self.deps.timers.set_timeout(
            ms,
            Box::new(move || {
                if let Some(this) = me.upgrade() {
                    this.timer_fired(token);
                }
            }),
        );
        inner.timer = Some((id, token));
    }

    fn timer_fired(&self, token: u64) {
        let mut inner = self.lock();
        // Another token: this timer was cleared or replaced meanwhile.
        if !inner.timer.is_some_and(|(_, armed)| armed == token) {
            return;
        }
        inner.timer = None;
        self.poll(&mut inner);
    }

    /// `resetSession`: forgets everything tied to the current session (not the stored token).
    /// Does not publish nor set the status.
    fn reset_session(&self, inner: &mut Inner) {
        inner.generation += 1;
        self.clear_timer(inner);
        inner.refresh_token = None;
        inner.access = None;
        inner.refreshing = None;
        inner.account = None;
        inner.unread = None;
        inner.updated_at = None;
        inner.messages.clear();
        inner.sent.clear();
        inner.forget_open();
        inner.alert_id = None;
        inner.reason = None;
        inner.detector.reset();
        inner.failures = 0;
        inner.last_panel_refresh = None;
        inner.recent_wanted = false;
    }

    /// `clearStoredToken`: after the save in progress that the caller saw under the lock, if any
    /// (taken by the caller, so a save started later is never waited for here).
    async fn clear_stored_token(&self, pending: Option<watch::Receiver<bool>>) {
        finished(pending).await;
        if let Err(error) = self.deps.store.clear().await {
            log::warn!(target: LOG_TARGET, "Could not clear the Gmail token error={error}");
        }
    }

    /// `getSession().auth`: built once per credentials.
    fn session_auth(&self, inner: &mut Inner) -> Arc<dyn GmailAuth> {
        if inner.session.is_none() {
            let auth = (self.deps.auth)(&inner.credentials);
            inner.session = Some(Session { auth, client: None });
        }
        let session = inner.session.as_ref().expect("just created");
        Arc::clone(&session.auth)
    }

    /// `getClient`: one client per session generation.
    fn client(&self, inner: &mut Inner) -> Arc<dyn GmailApiClient> {
        self.session_auth(inner);
        let generation = inner.generation;
        let session = inner.session.as_mut().expect("just created");
        match &session.client {
            Some((built_for, client)) if *built_for == generation => Arc::clone(client),
            _ => {
                let access = Arc::new(AccessFor {
                    integration: self.me.clone(),
                    owner: generation,
                });
                let client = (self.deps.client)(access);
                session.client = Some((generation, Arc::clone(&client)));
                client
            }
        }
    }

    /// `refreshAccess`: one refresh per generation at a time, in its own task (it always
    /// finishes, whoever waits for it); returns its result slot.
    fn refresh_access(
        &self,
        inner: &mut Inner,
    ) -> Result<watch::Receiver<Option<Result<String, GmailError>>>, GmailError> {
        if let Some(refreshing) = &inner.refreshing {
            if refreshing.generation == inner.generation {
                return Ok(refreshing.result.clone());
            }
        }
        let Some(token) = inner.refresh_token.clone() else {
            return Err(stale());
        };
        let Some(this) = self.me.upgrade() else {
            return Err(stale());
        };
        let auth = self.session_auth(inner);
        let started_in = inner.generation;
        let id = inner.next_id();
        let (settle, result) = watch::channel(None);
        inner.refreshing = Some(Refreshing {
            generation: started_in,
            id,
            result: result.clone(),
        });
        (self.deps.spawn)(Box::pin(async move {
            let next = auth.refresh(&token).await;
            let outcome = {
                let mut inner = this.lock();
                let outcome = if started_in != inner.generation {
                    Err(stale())
                } else {
                    match next {
                        Ok(next)
                            if next.scope.is_some()
                                && !has_required_scope(next.scope.as_deref()) =>
                        {
                            // A session without full mail access: nothing more is asked until
                            // the user signs in again.
                            inner.reason = Some(GmailExpiredReason::Scope);
                            Err(GmailError::Auth(crate::gmail::auth::GmailAuthError::Denied))
                        }
                        Ok(next) => {
                            inner.access = Some(Access {
                                token: next.access_token.clone(),
                                expires_at: next.expires_at,
                            });
                            Ok(next.access_token)
                        }
                        Err(error) => Err(GmailError::Auth(error)),
                    }
                };
                if inner.refreshing.as_ref().is_some_and(|r| r.id == id) {
                    inner.refreshing = None;
                }
                outcome
            };
            settle.send_replace(Some(outcome));
        }));
        Ok(result)
    }

    /// `accessFor(owner).getAccessToken`.
    async fn access_token(&self, owner: u64) -> Result<String, GmailError> {
        let waiting = {
            let mut inner = self.lock();
            if owner != inner.generation {
                return Err(stale());
            }
            if let Some(access) = &inner.access {
                if access.expires_at - now_ms(&self.deps.clock) > ACCESS_TOKEN_MARGIN_MS {
                    return Ok(access.token.clone());
                }
            }
            self.refresh_access(&mut inner)?
        };
        refreshed(waiting).await
    }

    /// `accessFor(owner).onUnauthorized`.
    async fn on_unauthorized(&self, owner: u64) -> Result<bool, GmailError> {
        let waiting = {
            let mut inner = self.lock();
            if owner != inner.generation {
                return Ok(false);
            }
            inner.access = None;
            self.refresh_access(&mut inner)?
        };
        match refreshed(waiting).await {
            Ok(_) => Ok(true),
            Err(GmailError::Auth(crate::gmail::auth::GmailAuthError::Denied)) => Ok(false),
            Err(error) => Err(error),
        }
    }

    /// `expire`: the session is dead (revoked, or without the needed permission). The refresh
    /// token, account, count and time stay (`can_poll` is false from now on).
    fn expire(&self, inner: &mut Inner, effects: &mut Effects, error: GmailError) {
        match inner.reason {
            Some(reason) => {
                log::warn!(target: LOG_TARGET, "Gmail session expired code={} reason={}", error.code(), reason.as_str());
            }
            None => log::warn!(target: LOG_TARGET, "Gmail session expired code={}", error.code()),
        }
        self.clear_timer(inner);
        inner.access = None;
        inner.messages.clear();
        inner.sent.clear();
        inner.forget_open();
        inner.alert_id = None;
        inner.status = GmailStatus::Expired;
        self.publish(inner, effects);
    }

    /// `poll`: one query per generation at a time; returns the signal of the run.
    fn poll(&self, inner: &mut Inner) -> Option<watch::Receiver<bool>> {
        if let Some(in_flight) = &inner.in_flight {
            if in_flight.generation == inner.generation {
                return Some(in_flight.done.clone());
            }
        }
        if !inner.can_poll() {
            inner.recent_wanted = false;
            return None;
        }
        let this = self.me.upgrade()?;
        self.clear_timer(inner);
        let started_in = inner.generation;
        let with_recent = std::mem::take(&mut inner.recent_wanted) || inner.view_open;
        let client = self.client(inner);
        let id = inner.next_id();
        let (finish, done) = watch::channel(false);
        inner.in_flight = Some(InFlight {
            generation: started_in,
            id,
            done: done.clone(),
        });
        (self.deps.spawn)(Box::pin(async move {
            this.run_poll(started_in, with_recent, client).await;
            {
                let mut inner = this.lock();
                if inner.in_flight.as_ref().is_some_and(|run| run.id == id) {
                    inner.in_flight = None;
                }
            }
            let _ = finish.send(true);
        }));
        Some(done)
    }

    /// `afterInFlight().then(() => poll())`: after the run in flight (if any), poll.
    fn poll_after_in_flight(&self, inner: &mut Inner) {
        match inner.in_flight.as_ref().map(|run| run.done.clone()) {
            None => {
                self.poll(inner);
            }
            Some(done) => {
                if let Some(this) = self.me.upgrade() {
                    (self.deps.spawn)(Box::pin(async move {
                        finished(Some(done)).await;
                        let mut inner = this.lock();
                        this.poll(&mut inner);
                    }));
                }
            }
        }
    }

    /// `runPoll`.
    async fn run_poll(&self, started_in: u64, with_recent: bool, client: Arc<dyn GmailApiClient>) {
        let known = self.lock().account.clone();
        let result = async {
            let account = match known {
                Some(account) => account,
                None => client.profile().await?,
            };
            let ids = client.unread_ids().await?;
            let mut list = None;
            if with_recent {
                match client.recent().await {
                    Ok(recent) => list = Some(recent),
                    // The count is still good: a failed list keeps the last one, unless the
                    // session died.
                    Err(error) if error.is_session_dead() => return Err(error),
                    Err(error) => {
                        if !self.lock().is_stale(started_in) {
                            log::warn!(target: LOG_TARGET, "Gmail recent list failed code={}", error.code());
                        }
                    }
                }
            }
            Ok::<_, GmailError>((account, ids, list))
        }
        .await;
        let mut effects = Effects::new();
        let fresh = {
            let mut inner = self.lock();
            if inner.poll_dropped(started_in) {
                return;
            }
            match result {
                Ok((account, ids, list)) => {
                    inner.account = Some(account);
                    let count = ids.len().min(UNREAD_CAP as usize);
                    inner.unread = Some(u32::try_from(count).unwrap_or(UNREAD_CAP));
                    inner.updated_at = Some(iso(self.deps.clock.now()));
                    if let Some(list) = list {
                        inner.messages = list;
                    }
                    inner.failures = 0;
                    inner.status = GmailStatus::Ok;
                    self.publish(&mut inner, &mut effects);
                    self.schedule(&mut inner, TICK_MS);
                    inner.detector.observe(&ids)
                }
                Err(error) if error.is_session_dead() => {
                    self.expire(&mut inner, &mut effects, error);
                    Vec::new()
                }
                Err(error) => {
                    let wait = BACKOFF_MS[inner.failures.min(BACKOFF_MS.len() - 1)];
                    inner.failures += 1;
                    log::warn!(target: LOG_TARGET, "Gmail query failed code={} retryInMs={wait}", error.code());
                    inner.status = GmailStatus::Offline;
                    self.publish(&mut inner, &mut effects);
                    self.schedule(&mut inner, wait);
                    Vec::new()
                }
            }
        };
        self.run(effects);
        if !fresh.is_empty() {
            if let Some(this) = self.me.upgrade() {
                (self.deps.spawn)(Box::pin(async move {
                    this.announce(started_in, fresh, client).await;
                }));
            }
        }
    }

    /// `announce`: alerts the notch about new unread mail (the newest one), unless alerts are
    /// off. The alert settings are read now; the metadata is asked only when content is shown.
    async fn announce(&self, started_in: u64, fresh: Vec<String>, client: Arc<dyn GmailApiClient>) {
        let alerts = self.deps.settings.get().alerts;
        let Some(id) = fresh.first().cloned() else {
            return;
        };
        if !alerts.enabled || self.deps.on_new_mail.is_none() || self.lock().paused {
            return;
        }
        let mut mail = GmailNewMail {
            count: fresh.len() as u64,
            id: id.clone(),
            from: None,
            subject: None,
        };
        if !alerts.hide_content {
            let summary = client.summary(&id).await;
            let inner = self.lock();
            if inner.poll_dropped(started_in) {
                return;
            }
            match summary {
                Ok(Some(summary)) => {
                    mail.from = Some(summary.from);
                    mail.subject = Some(summary.subject);
                }
                // Gone before it could be shown.
                Ok(None) => return,
                // The alert still goes out, without sender or subject.
                Err(error) => {
                    log::warn!(target: LOG_TARGET, "Gmail new-mail details failed code={}", error.code());
                }
            }
        }
        let mut effects = Effects::new();
        {
            let mut inner = self.lock();
            if inner.poll_dropped(started_in) {
                return;
            }
            inner.alert_id = Some(id);
            log::info!(target: LOG_TARGET, "Gmail new mail count={}", mail.count);
            effects.push(Effect::NewMail(started_in, mail));
        }
        self.run(effects);
    }

    /// The last recent list (empty without a session), remembered as the list `open` and the
    /// actions accept.
    pub async fn recent(&self) -> Vec<GmailMessage> {
        self.ready().await;
        let in_flight = self.lock().in_flight.as_ref().map(|run| run.done.clone());
        finished(in_flight).await;
        let mut inner = self.lock();
        inner.sent = if usable(inner.status) {
            inner.messages.clone()
        } else {
            Vec::new()
        };
        inner.sent.clone()
    }

    /// Starts the rhythm (main calls it once the channels exist). It then runs whenever there
    /// is a session, in every notch mode.
    pub fn start(&self) {
        let mut inner = self.lock();
        if inner.started {
            return;
        }
        inner.started = true;
        self.poll(&mut inner);
    }

    /// The integration turned off or on in the settings (`integrations.gmail.enabled`); main
    /// calls it before `start()` with the saved value, then on every change.
    ///
    /// Off: the rhythm stops and an answer still in flight is dropped (no state, no alert);
    /// the session, token and last state stay. On: queries at once (once a run still in flight
    /// has ended), then the usual rhythm. The
    /// new-mail baseline starts again, so mail that arrived while off is not announced. Not
    /// [`Self::dispose`], which is final.
    pub fn set_enabled(&self, enabled: bool) {
        let mut inner = self.lock();
        if inner.disposed || inner.paused != enabled {
            return;
        }
        inner.paused = !enabled;
        log::info!(target: LOG_TARGET, "Gmail integration enabled={enabled}");
        if enabled {
            // After any run in flight, whatever its fate: one dropped while off clears its
            // `in_flight` only once the lock is released, and `poll` would take that run for
            // the current one (no new query, no timer).
            self.poll_after_in_flight(&mut inner);
        } else {
            self.clear_timer(&mut inner);
            inner.detector.reset();
            inner.last_panel_refresh = None;
            inner.recent_wanted = false;
        }
    }

    /// The Gmail view opened or closed: opening (with status `ok`) queries the count and the
    /// list; closing forgets the open message.
    pub fn set_view_open(&self, open: bool) {
        let mut inner = self.lock();
        let opening = open && !inner.view_open;
        inner.view_open = open;
        if !open {
            inner.forget_open();
        }
        if opening && inner.status == GmailStatus::Ok {
            self.poll_after_in_flight(&mut inner);
        }
    }

    /// The main panel opened: with a live session (`ok`), one query that brings the recent list
    /// even with the view closed, at most every [`PANEL_REFRESH_MIN_MS`]. It runs after a query in
    /// flight, which may not carry the list, unless that query left the session anything but `ok`:
    /// its backoff stands. The view's own queries do not count here.
    pub fn panel_opened(&self) {
        let at = self.deps.clock.now();
        let mut inner = self.lock();
        if !inner.can_poll() || inner.status != GmailStatus::Ok {
            return;
        }
        // A clock moved backwards never counts as "just asked".
        let recently = inner.last_panel_refresh.is_some_and(|last| {
            u64::try_from((at - last).num_milliseconds())
                .is_ok_and(|elapsed| elapsed < PANEL_REFRESH_MIN_MS)
        });
        if recently {
            return;
        }
        inner.last_panel_refresh = Some(at);
        inner.recent_wanted = true;
        let Some(done) = inner.in_flight.as_ref().map(|run| run.done.clone()) else {
            self.poll(&mut inner);
            return;
        };
        let Some(this) = self.me.upgrade() else {
            return;
        };
        (self.deps.spawn)(Box::pin(async move {
            finished(Some(done)).await;
            let mut inner = this.lock();
            if inner.status == GmailStatus::Ok {
                this.poll(&mut inner);
            } else {
                inner.recent_wanted = false;
            }
        }));
    }

    /// Queries now, at most every 5 s.
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
    }

    /// Opens the inbox (no id) or the thread of a shown message in the browser. Never fails: an
    /// id never shown is refused silently (logged); a shown id whose thread is unknown opens the
    /// inbox.
    pub fn open(&self, id: Option<&str>) {
        let mut url = INBOX_URL.to_owned();
        if let Some(id) = id {
            let inner = self.lock();
            let thread = inner
                .sent
                .iter()
                .find(|m| m.id == id)
                .map(|m| m.thread_id.clone())
                .or_else(|| {
                    inner
                        .opened
                        .as_ref()
                        .filter(|o| o.id == id)
                        .and_then(|o| o.thread_id.clone())
                });
            match thread {
                Some(thread) => url = format!("{INBOX_URL}/{}", encode_uri_component(&thread)),
                None if !inner.is_shown(id) => {
                    log::warn!(target: LOG_TARGET, "Refused to open a message not shown in the notch");
                    return;
                }
                None => {}
            }
        }
        let opening = (self.deps.open_external)(url);
        (self.deps.spawn)(Box::pin(async move {
            if let Err(error) = opening.await {
                log::warn!(target: LOG_TARGET, "Could not open Gmail in the browser error={error}");
            }
        }));
    }

    /// `actionFailed`: a code the notch can show, never the message data.
    fn action_failed(
        &self,
        inner: &mut Inner,
        effects: &mut Effects,
        action: Action,
        started_in: u64,
        error: GmailError,
    ) -> ExposedError {
        if inner.is_stale(started_in) {
            return unavailable("Gmail session changed");
        }
        if error.is_not_found() {
            return ExposedError::new(IpcErrorCode::NotFound, "The message no longer exists");
        }
        if error.is_session_dead() {
            self.expire(inner, effects, error);
            return unavailable("Gmail session expired");
        }
        let code = error.code();
        log::warn!(target: LOG_TARGET, "Gmail action failed action={} code={code}", action.as_str());
        unavailable(format!("Gmail request failed: {code}"))
    }

    /// Reads a shown message as plain text and remembers it as the open message.
    pub async fn message(&self, id: &str) -> Result<GmailMessageDetail, ExposedError> {
        self.ready().await;
        let (client, started_in, seq) = {
            let mut inner = self.lock();
            inner.require_shown(Action::Message.as_str(), id)?;
            let started_in = inner.active_session()?;
            // A new read replaces the open message; the id stays shown while it loads.
            inner.forget_open();
            let seq = inner.open_seq;
            inner.opened = Some(Opened {
                id: id.to_owned(),
                thread_id: None,
                links: Vec::new(),
            });
            (self.client(&mut inner), started_in, seq)
        };
        let result = client.message(id).await;
        let mut effects = Effects::new();
        let outcome = {
            let mut inner = self.lock();
            match result {
                Err(error) => Err(self.action_failed(
                    &mut inner,
                    &mut effects,
                    Action::Message,
                    started_in,
                    error,
                )),
                Ok(_) if inner.is_stale(started_in) => Err(unavailable("Gmail session changed")),
                Ok(detail) => {
                    if seq == inner.open_seq {
                        inner.opened = Some(Opened {
                            id: id.to_owned(),
                            thread_id: Some(detail.thread_id.clone()),
                            links: detail.links.clone(),
                        });
                    }
                    Ok(detail)
                }
            }
        };
        self.run(effects);
        outcome
    }

    /// Marks a shown message as read, then queries at once.
    pub async fn mark_read(&self, id: &str) -> Result<(), ExposedError> {
        self.act(Action::MarkRead, id).await
    }

    /// Deletes a shown message permanently, forgets it, then queries at once.
    pub async fn remove(&self, id: &str) -> Result<(), ExposedError> {
        self.act(Action::Delete, id).await
    }

    async fn act(&self, action: Action, id: &str) -> Result<(), ExposedError> {
        self.ready().await;
        let (client, started_in) = {
            let mut inner = self.lock();
            inner.require_shown(action.as_str(), id)?;
            let started_in = inner.active_session()?;
            (self.client(&mut inner), started_in)
        };
        let result = if action == Action::Delete {
            client.remove(id).await
        } else {
            client.mark_read(id).await
        };
        let mut effects = Effects::new();
        let outcome = {
            let mut inner = self.lock();
            match result {
                Err(error) => {
                    Err(self.action_failed(&mut inner, &mut effects, action, started_in, error))
                }
                Ok(()) if inner.is_stale(started_in) => Err(unavailable("Gmail session changed")),
                Ok(()) => {
                    if action == Action::Delete {
                        // Gone for good: no later call may name it.
                        inner.sent.retain(|m| m.id != id);
                        inner.messages.retain(|m| m.id != id);
                        if inner.opened.as_ref().is_some_and(|o| o.id == id) {
                            inner.forget_open();
                        }
                        if inner.alert_id.as_deref() == Some(id) {
                            inner.alert_id = None;
                        }
                    }
                    log::info!(target: LOG_TARGET, "Gmail action done action={}", action.as_str());
                    // A fresh count and list now, past the manual-refresh floor.
                    self.poll_after_in_flight(&mut inner);
                    Ok(())
                }
            }
        };
        self.run(effects);
        outcome
    }

    /// Opens link `index` of the open message in the browser; anything else is INVALID_INPUT.
    pub fn open_link(&self, id: &str, index: u32) -> Result<(), ExposedError> {
        let url = {
            let inner = self.lock();
            let link = inner
                .opened
                .as_ref()
                .filter(|o| o.id == id)
                .and_then(|o| o.links.get(index as usize));
            match link {
                Some(link) if is_web_url(&link.url) => link.url.clone(),
                _ => {
                    log::warn!(target: LOG_TARGET, "Refused to open a link outside the open message");
                    return Err(ExposedError::new(
                        IpcErrorCode::InvalidInput,
                        "Unknown link",
                    ));
                }
            }
        };
        let opening = (self.deps.open_external)(url);
        (self.deps.spawn)(Box::pin(async move {
            if let Err(error) = opening.await {
                log::warn!(target: LOG_TARGET, "Could not open a mail link in the browser error={error}");
            }
        }));
        Ok(())
    }

    /// The reader closed: forgets the open message's body and links (list ids stay shown).
    pub fn close_message(&self) {
        self.lock().forget_open();
    }

    /// Signs in through the browser (one sign-in at a time; a second one, `cancel_sign_in`, a
    /// client change, sign-out or dispose cancel it).
    pub async fn sign_in(&self) -> GmailSignInResult {
        self.ready().await;
        let auth: Arc<dyn GmailAuth>;
        let pending;
        let (seq, started_in) = {
            let mut effects = Effects::new();
            let mut inner = self.lock();
            if inner.disposed || !inner.configured() {
                return GmailSignInResult::Error;
            }
            inner.sign_in_seq += 1;
            let seq = inner.sign_in_seq;
            inner.pending_sign_in = Some(seq);
            let started_in = inner.generation;
            if inner.status != GmailStatus::SigningIn {
                inner.status_before_sign_in = Some(inner.status);
            }
            inner.status = GmailStatus::SigningIn;
            self.clear_timer(&mut inner);
            self.publish(&mut inner, &mut effects);
            auth = self.session_auth(&mut inner);
            // Registers the session now, under the lock: a cancel that comes after it always
            // reaches it.
            pending = auth.sign_in();
            drop(inner);
            self.run(effects);
            (seq, started_in)
        };
        // The browser wait (up to 300 s), with no lock held.
        let result = pending.await;
        let superseded = |inner: &Inner| {
            seq != inner.sign_in_seq || started_in != inner.generation || inner.disposed
        };
        let mut effects = Effects::new();
        match result {
            Ok(signed) => {
                let lacks_scope =
                    signed.scope.is_some() && !has_required_scope(signed.scope.as_deref());
                if lacks_scope {
                    {
                        let mut inner = self.lock();
                        if superseded(&inner) {
                            return GmailSignInResult::Cancelled;
                        }
                        inner.status_before_sign_in = None;
                        inner.pending_sign_in = None;
                        // No full mail access: this token is of no use, nor is the old one.
                        log::warn!(target: LOG_TARGET, "Gmail sign-in lacks the full mail permission");
                        self.reset_session(&mut inner);
                        inner.reason = Some(GmailExpiredReason::Scope);
                        inner.status = GmailStatus::Expired;
                        self.publish(&mut inner, &mut effects);
                    }
                    self.run(effects);
                    let pending = self.lock().pending_save.clone();
                    self.clear_stored_token(pending).await;
                    return GmailSignInResult::Error;
                }
                let (saved, token) = {
                    let mut inner = self.lock();
                    if superseded(&inner) {
                        return GmailSignInResult::Cancelled;
                    }
                    inner.status_before_sign_in = None;
                    inner.pending_sign_in = None;
                    let (saved, pending_save) = watch::channel(false);
                    inner.pending_save = Some(pending_save);
                    self.reset_session(&mut inner);
                    inner.refresh_token = Some(signed.refresh_token.clone());
                    inner.access = Some(Access {
                        token: signed.access_token,
                        expires_at: signed.expires_at,
                    });
                    inner.status = GmailStatus::Ok;
                    self.publish(&mut inner, &mut effects);
                    self.poll(&mut inner);
                    (saved, signed.refresh_token)
                };
                self.run(effects);
                if let Err(error) = self.deps.store.save(&token).await {
                    log::warn!(target: LOG_TARGET, "Could not save the Gmail token error={error}");
                }
                let _ = saved.send(true);
                GmailSignInResult::Ok
            }
            Err(error) => {
                let clear = {
                    let mut inner = self.lock();
                    if superseded(&inner) {
                        return GmailSignInResult::Cancelled;
                    }
                    inner.pending_sign_in = None;
                    log::warn!(target: LOG_TARGET, "Gmail sign-in did not finish code={}", error.code());
                    let previous = inner.status_before_sign_in.take();
                    if previous.is_some_and(usable) && inner.refresh_token.is_some() {
                        inner.status = previous.unwrap_or(GmailStatus::Ok);
                        self.publish(&mut inner, &mut effects);
                        self.poll(&mut inner);
                        false
                    } else {
                        // From signed-out or expired: any old token is dead; drop it so the
                        // state is truthful.
                        let had_token = inner.refresh_token.is_some();
                        self.reset_session(&mut inner);
                        inner.status = GmailStatus::SignedOut;
                        self.publish(&mut inner, &mut effects);
                        had_token
                    }
                };
                self.run(effects);
                if clear {
                    let pending = self.lock().pending_save.clone();
                    self.clear_stored_token(pending).await;
                }
                if error.is_cancelled() {
                    GmailSignInResult::Cancelled
                } else {
                    GmailSignInResult::Error
                }
            }
        }
    }

    /// Cancels the sign-in waiting for the browser, if any.
    pub fn cancel_sign_in(&self) {
        let inner = self.lock();
        if inner.pending_sign_in.is_some() {
            if let Some(session) = &inner.session {
                session.auth.cancel();
            }
        }
    }

    /// Signs out: the session goes at once; the token is revoked (best effort, at most 30 s)
    /// while the stored one is cleared (after any save in progress).
    pub async fn sign_out(&self) {
        self.ready().await;
        let mut effects = Effects::new();
        let (token, auth, pending) = {
            let mut inner = self.lock();
            inner.sign_in_seq += 1;
            inner.pending_sign_in = None;
            inner.status_before_sign_in = None;
            if let Some(session) = &inner.session {
                session.auth.cancel();
            }
            let token = inner.refresh_token.clone();
            let auth = inner.session.as_ref().map(|s| Arc::clone(&s.auth));
            self.reset_session(&mut inner);
            inner.status = if inner.configured() {
                GmailStatus::SignedOut
            } else {
                GmailStatus::Unconfigured
            };
            self.publish(&mut inner, &mut effects);
            (token, auth, inner.pending_save.clone())
        };
        self.run(effects);
        let revoke = async {
            if let (Some(token), Some(auth)) = (token, auth) {
                auth.revoke(&token).await;
            }
        };
        tokio::join!(revoke, self.clear_stored_token(pending));
    }

    /// Stops the rhythm and cancels a pending sign-in; later results, publishes and settings
    /// changes are dropped (in-flight work is not waited for).
    pub fn dispose(&self) {
        let mut inner = self.lock();
        inner.disposed = true;
        self.clear_timer(&mut inner);
        inner.sign_in_seq += 1;
        inner.pending_sign_in = None;
        if let Some(session) = &inner.session {
            session.auth.cancel();
        }
    }

    /// The settings changed (`settings.onChange`): a new client id or secret closes the session
    /// and drops the stored token (no request may go out with the old client). Alert changes
    /// need nothing here: they are read when an alert goes out.
    pub fn on_settings_changed(&self, next: &GmailSettings) {
        let next = Credentials::of(next);
        let mut effects = Effects::new();
        let pending = {
            let mut inner = self.lock();
            if inner.disposed || next == inner.credentials {
                return;
            }
            inner.sign_in_seq += 1;
            inner.pending_sign_in = None;
            inner.status_before_sign_in = None;
            if let Some(session) = inner.session.take() {
                session.auth.cancel();
            }
            inner.credentials = next;
            self.reset_session(&mut inner);
            inner.status = if inner.configured() {
                GmailStatus::SignedOut
            } else {
                GmailStatus::Unconfigured
            };
            log::info!(target: LOG_TARGET, "Gmail client changed; session closed");
            self.publish(&mut inner, &mut effects);
            // The save in progress now, captured with the change: the clear waits for it.
            inner.pending_save.clone()
        };
        self.run(effects);
        if let Some(this) = self.me.upgrade() {
            (self.deps.spawn)(Box::pin(async move {
                this.clear_stored_token(pending).await;
            }));
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Tauri wiring pieces (0.1.0's `index.ts` 360-393). `lib.rs` manages the returned
// integration, fills the `gmail` slot and calls `start()`; `ipc.rs` and `e2e.rs` hold the channels.

/// The settings store as the integration sees it: the `gmail` block.
struct AppSettings(tauri::AppHandle);

impl SettingsSource for AppSettings {
    fn get(&self) -> GmailSettings {
        use tauri::Manager;
        self.0.state::<crate::settings::SettingsStore>().get().gmail
    }
}

/// Creates the integration on the notch's timers, the shared wall clock and one direct
/// transport (auth and API), and subscribes it to the settings store. Call on the main thread
/// once the settings store, the wall clock and `OpenedUrls` (if any) are managed: the auth and
/// the integration open URLs through `apps::opener`, which checks for the recorder when built.
/// `on_new_mail` is `onNewMail` (the app's listener: `gmail:new-mail` to the notch, then
/// `NotchEvent::Mail { on: true }`). It does not start: call `start()` once the channels exist.
/// `None` only when the HTTP client cannot be built.
pub fn install(
    app: &tauri::AppHandle,
    notch: &Arc<NotchRuntime>,
    data_dir: &Path,
    on_new_mail: NewMailListener,
) -> Option<Arc<GmailIntegration>> {
    use crate::gmail::auth::{GoogleAuth, GoogleAuthConfig};
    use crate::gmail::client::{GmailClient, GMAIL_API_BASE};
    use crate::gmail::token_store::token_store;
    use crate::http::{ReqwestTransport, Transport};
    use crate::{ipc, settings::SettingsStore};
    use tauri::Manager;

    let overridden = base_override_from(
        ipc::dev_overrides_enabled(),
        ipc::dev_env_var(BASE_URL_ENV).as_deref(),
    );
    let transport: Arc<dyn Transport> = match ReqwestTransport::new() {
        Ok(transport) => Arc::new(transport),
        Err(_) => {
            log::error!(target: LOG_TARGET, "Gmail HTTP client unavailable; the integration stays off");
            return None;
        }
    };
    let clock = Arc::clone(&app.state::<Arc<WallClock>>());
    let open_external = crate::apps::opener(app);
    let auth: AuthFactory = {
        let transport = Arc::clone(&transport);
        let open = open_external.clone();
        let clock = Arc::clone(&clock);
        let overridden = overridden.clone();
        Arc::new(move |credentials: &Credentials| {
            Arc::new(GoogleAuth::new(
                Arc::clone(&transport),
                open.clone(),
                Arc::clone(&clock),
                GoogleAuthConfig::new(
                    &credentials.client_id,
                    &credentials.client_secret,
                    overridden.as_deref(),
                ),
            )) as Arc<dyn GmailAuth>
        })
    };
    let client: ClientFactory = {
        let api_base = overridden.unwrap_or_else(|| GMAIL_API_BASE.to_owned());
        Arc::new(move |access: Arc<dyn TokenAccess>| {
            Arc::new(GmailClient::new(
                Arc::clone(&transport),
                api_base.clone(),
                access,
            )) as Arc<dyn GmailApiClient>
        })
    };
    let deps = GmailDeps {
        settings: Arc::new(AppSettings(app.clone())),
        store: Arc::new(token_store(data_dir)),
        auth,
        client,
        timers: notch.timers(),
        clock,
        spawn: Arc::new(|future| {
            tauri::async_runtime::spawn(future);
        }),
        emit: {
            let app = app.clone();
            Arc::new(move |state: &GmailState| {
                let targets = ipc::existing_windows(&app);
                if !targets.is_empty() {
                    ipc::emit_event(&app, &targets, "gmail:state", state);
                }
            })
        },
        open_external,
        on_new_mail: Some(on_new_mail),
    };
    let integration = GmailIntegration::new(deps);
    {
        let integration = Arc::downgrade(&integration);
        app.state::<SettingsStore>().on_change(move |next| {
            if let Some(integration) = integration.upgrade() {
                integration.on_settings_changed(&next.gmail);
            }
        });
    }
    Some(integration)
}

#[cfg(test)]
#[path = "integration_tests.rs"]
mod tests;
