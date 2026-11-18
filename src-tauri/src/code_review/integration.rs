//! The GitHub and GitLab state machine of the main process (port of
//! 0.1.0's `code-review-integration.ts`) and its Tauri wiring (0.1.0's `index.ts`).
//!
//! One independent runtime per platform: token, client, generation, 120 s rhythm, backoff,
//! first-review detector and contributions. Everything lives under one `Mutex`, never held across
//! an `.await`, an emit or an alert: each operation collects its effects under the lock and runs
//! them once it is released. After every `.await` the result is dropped when the platform moved to
//! another generation, was disposed or turned `auth-error` meanwhile (`isStale`).
//!
//! Logs carry only platforms, states, counts and codes, as `key=value`, under the
//! `main:code-review` scope (never tokens, titles, refs, authors, accounts or URLs).
//!
//! Dev/E2E switch (ignored unless `ipc::dev_overrides_enabled()`):
//! `NOTCH_CODE_REVIEW_BASE_URLS=github=http://127.0.0.1:<port>,gitlab=http://127.0.0.1:<port>`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use chrono::{DateTime, SecondsFormat, Utc};
use tokio::sync::watch;

use super::client::{to_review_item, ClientItem, CodeReviewClient, CodeReviewError};
use super::detector::{merge_uncertain, Alert, ReviewDetector};
use super::ipc::{CodeReviewApi, CodeReviewSlot};
pub use crate::apps::OpenExternal;
use crate::apps::{is_loopback_origin, opener, origin_of};
use crate::contract::code_review::{
    CodeReviewAlert, CodeReviewList, CodeReviewState, ContributionSummary, ContributionsChanged,
    ContributionsResult, Platform, PlatformState, PlatformStatus, ReviewState, SetTokenReason,
    SetTokenResult, GITLAB_URL_MAX,
};
use crate::contract::settings::CodeReviewSettings;
use crate::contract::text::{js_trim, utf16_len};
use crate::ipc::{BoxFuture, ExposedError, IpcErrorCode};
use crate::notch::runtime::NotchRuntime;
use crate::services::clock::WallClock;
use crate::services::secure_token_store::SecureTokenStore;
pub use crate::services::secure_token_store::TokenStore;
use crate::services::tasks::finished;
pub use crate::services::tasks::Spawner;
use crate::services::timers::{TimerId, Timers};
use crate::settings::validate::normalize_gitlab_url;

/// Query rhythm, in every notch mode (first-review alerts show over mini and hidden too).
pub const TICK_MS: u64 = 120_000;
/// Waits after consecutive network / 5xx / 429 / invalid-response failures: 1, 2, 4, 5 min (max).
pub const BACKOFF_MS: [u64; 4] = [60_000, 120_000, 240_000, 300_000];
/// Contributions rhythm, only while the "Revisiones" view is open.
pub const CONTRIBUTIONS_TICK_MS: u64 = 900_000;
/// Minimum time between two manual refreshes (process-wide, not per platform).
pub const MANUAL_REFRESH_MIN_MS: i64 = 5_000;
/// The only origin GitHub items may open in the browser.
pub const GITHUB_WEB_ORIGIN: &str = "https://github.com";
/// `log` target whose scope is `main:code-review` (the E2E log check looks for `code-review`).
pub const LOG_TARGET: &str = concat!(env!("CARGO_CRATE_NAME"), "::code-review");

const PLATFORMS: [Platform; 2] = [Platform::Github, Platform::Gitlab];

/// `CodeReviewSettingsSource` without `onChange`: the wiring calls
/// [`CodeReviewIntegration::on_settings_changed`] from the store's listener instead.
pub trait SettingsSource: Send + Sync {
    fn get(&self) -> CodeReviewSettings;
    /// Saves the whole `codeReview` block through the settings updater (validation,
    /// `settings:changed`, listeners). The error is a code only.
    fn update(&self, code_review: CodeReviewSettings) -> BoxFuture<'_, Result<(), String>>;
}

/// `clientFactories.github(token)`.
pub type GithubFactory = Arc<dyn Fn(&str) -> Arc<dyn CodeReviewClient> + Send + Sync>;
/// `clientFactories.gitlab(baseUrl, token)`; `None` where the TS factory throws.
pub type GitlabFactory = Arc<dyn Fn(&str, &str) -> Option<Arc<dyn CodeReviewClient>> + Send + Sync>;

/// `CodeReviewIntegrationOptions`.
pub struct CodeReviewDeps {
    pub settings: Arc<dyn SettingsSource>,
    pub github_store: Arc<dyn TokenStore>,
    pub gitlab_store: Arc<dyn TokenStore>,
    pub github_client: GithubFactory,
    pub gitlab_client: GitlabFactory,
    pub timers: Arc<dyn Timers>,
    /// `now`: the wall clock the E2E test clock moves (`updatedAt`, the refresh gate and the
    /// contributions range).
    pub clock: Arc<WallClock>,
    pub spawn: Spawner,
    /// `code-review:state` to the notch and the Control Center.
    pub emit: Arc<dyn Fn(&CodeReviewState) + Send + Sync>,
    /// `code-review:contributions-changed` to the notch.
    pub emit_contributions: Arc<dyn Fn(&ContributionsChanged) + Send + Sync>,
    pub open_external: OpenExternal,
    /// Own PR/MRs got their first review while that platform's alerts are on.
    pub on_alert: Arc<dyn Fn(&CodeReviewAlert) + Send + Sync>,
}

/// `parseCodeReviewBaseOverrides`: the API base per platform in dev/E2E.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BaseOverrides {
    pub github: Option<String>,
    pub gitlab: Option<String>,
}

/// `NOTCH_CODE_REVIEW_BASE_URLS` (`github=http://127.0.0.1:1234,gitlab=http://127.0.0.1:1234`):
/// each value must be an exact `http://127.0.0.1:<port>` origin (`^http:\/\/127\.0\.0\.1:(\d{1,5})$`,
/// port 1..=65535). Anything malformed turns the whole switch off.
pub fn parse_base_overrides(raw: Option<&str>) -> BaseOverrides {
    let Some(raw) = raw.filter(|raw| !js_trim(raw).is_empty()) else {
        return BaseOverrides::default();
    };
    let mut result = BaseOverrides::default();
    for part in raw.split(',') {
        let Some((key, value)) = part.split_once('=') else {
            return BaseOverrides::default();
        };
        let value = js_trim(value);
        if !is_loopback_origin(value) {
            return BaseOverrides::default();
        }
        match js_trim(key) {
            "github" => result.github = Some(value.to_owned()),
            "gitlab" => result.gitlab = Some(value.to_owned()),
            _ => return BaseOverrides::default(),
        }
    }
    result
}

/// [`parse_base_overrides`] of `raw` in dev/E2E builds; nothing in a release build.
pub fn base_overrides_from(enabled: bool, raw: Option<&str>) -> BaseOverrides {
    if enabled {
        parse_base_overrides(raw)
    } else {
        BaseOverrides::default()
    }
}

/// `errorCode`: only a code, never a message (messages could quote tokens or titles).
fn error_code(error: CodeReviewError) -> &'static str {
    error.code()
}

/// `failureReason`: why `set_token` refused a token the API did not accept.
fn failure_reason(platform: Platform, error: CodeReviewError) -> SetTokenReason {
    match error {
        CodeReviewError::Auth => SetTokenReason::Auth,
        // A server that answers, but not like GitLab: most likely a wrong URL.
        CodeReviewError::InvalidResponse if platform == Platform::Gitlab => SetTokenReason::Url,
        _ => SetTokenReason::Network,
    }
}

fn index(platform: Platform) -> usize {
    match platform {
        Platform::Github => 0,
        Platform::Gitlab => 1,
    }
}

fn usable(status: PlatformStatus) -> bool {
    matches!(status, PlatformStatus::Ok | PlatformStatus::Offline)
}

/// The integration's handle: what the channels and the wiring use.
pub struct CodeReviewIntegration {
    deps: CodeReviewDeps,
    me: Weak<Self>,
    inner: Mutex<Inner>,
    ready: watch::Receiver<bool>,
    /// Whether each store's token survives a restart, asked once (a DPAPI round trip): never
    /// under the lock on every `state()`.
    persistent: [bool; 2],
    /// The newest effect of each ordered kind that went out. Held while emitting, so effects
    /// decided under `inner` in order A, B never reach the renderer as B, A.
    emitted: Mutex<Emitted>,
    /// The platform of the last first-review alert sent (the notch's review alert is one for
    /// both): turning that platform off ends the alert.
    last_alert: Mutex<Option<Platform>>,
}

/// Sequence numbers (assigned under `inner`) of the last state and contributions events sent.
#[derive(Default)]
struct Emitted {
    state: u64,
    contributions: [u64; 2],
}

struct Inner {
    /// Copy of the settings' GitLab URL (updated by `set_token` and by outside changes).
    gitlab_url: String,
    started: bool,
    disposed: bool,
    /// `None`: never (`-Infinity`).
    last_manual_refresh: Option<DateTime<Utc>>,
    view_open: bool,
    runtimes: [Runtime; 2],
    /// Identifies timers and in-flight runs (a stale callback never clears a newer one).
    next_id: u64,
    /// Orders the effects decided under the lock (see [`Emitted`]).
    next_seq: u64,
}

impl Inner {
    fn new(gitlab_url: String) -> Self {
        Self {
            gitlab_url,
            started: false,
            disposed: false,
            last_manual_refresh: None,
            view_open: false,
            runtimes: [Runtime::default(), Runtime::default()],
            next_id: 0,
            next_seq: 0,
        }
    }

    fn rt(&mut self, platform: Platform) -> &mut Runtime {
        &mut self.runtimes[index(platform)]
    }

    fn next_id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    /// `canPoll`.
    fn can_poll(&self, platform: Platform) -> bool {
        let rt = &self.runtimes[index(platform)];
        !self.disposed && !rt.paused && self.started && rt.client.is_some() && usable(rt.status.0)
    }

    /// `isStale`: another generation, disposed, or the token was rejected meanwhile (only a new
    /// token revives it).
    fn is_stale(&self, platform: Platform, started_in: u64) -> bool {
        let rt = &self.runtimes[index(platform)];
        started_in != rt.generation || self.disposed || rt.status.0 == PlatformStatus::AuthError
    }

    /// A query's answer is dropped: stale, or the platform was turned off meanwhile.
    fn poll_dropped(&self, platform: Platform, started_in: u64) -> bool {
        self.is_stale(platform, started_in) || self.runtimes[index(platform)].paused
    }
}

/// A query in flight: who started it and a signal for when it ends.
struct InFlight {
    generation: u64,
    id: u64,
    done: watch::Receiver<bool>,
}

#[derive(Default)]
struct Runtime {
    client: Option<Arc<dyn CodeReviewClient>>,
    status: Status,
    account: Option<String>,
    unreviewed: Option<u32>,
    updated_at: Option<String>,
    to_review: Vec<ClientItem>,
    mine: Vec<ClientItem>,
    /// Id -> URL of the last list handed to the notch: `open` only accepts these.
    sent: HashMap<String, String>,
    detector: ReviewDetector,
    /// Last known review state of each own open PR/MR (kept for items uncertain in a round).
    remembered: HashMap<String, ReviewState>,
    /// Bumped whenever the token, URL or session changes: stale results are dropped.
    generation: u64,
    /// Bumped by every `set_token`/`clear`: an older validation that ends later changes nothing.
    token_seq: u64,
    timer: Option<(TimerId, u64)>,
    failures: usize,
    in_flight: Option<InFlight>,
    /// A token save in progress; a clear waits for it so the token never outlives a removal.
    pending_save: Option<watch::Receiver<bool>>,
    logged_status: Option<PlatformStatus>,
    contributions: Option<ContributionSummary>,
    contributions_error: bool,
    contributions_timer: Option<(TimerId, u64)>,
    contributions_in_flight: Option<InFlight>,
    /// Turned off in the settings (`integrations.github|gitlab.enabled`): no review or
    /// contributions query, no state from one, no alert. Unlike `disposed`, it can be undone.
    paused: bool,
}

/// `PlatformStatus` with a default (`unconfigured`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Status(PlatformStatus);

impl Default for Status {
    fn default() -> Self {
        Self(PlatformStatus::Unconfigured)
    }
}

/// What an operation decided under the lock, run once it is released (in order).
enum Effect {
    /// With its sequence number: an older snapshot never overwrites a newer one.
    State(u64, CodeReviewState),
    Contributions(u64, ContributionsChanged),
    /// First reviews: sent only if that platform's alerts are still on.
    Alert(CodeReviewAlert),
}

type Effects = Vec<Effect>;

/// Which of the two per-platform timers.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Rhythm {
    Poll,
    Contributions,
}

impl CodeReviewIntegration {
    /// `createCodeReviewIntegration`: starts loading both stored tokens (`ready`) at once.
    pub fn new(deps: CodeReviewDeps) -> Arc<Self> {
        let gitlab_url = deps.settings.get().gitlab_url;
        let (loaded, ready) = watch::channel(false);
        // Deviation: TS asks `isEncryptionAvailable()` on every state; DPAPI's availability
        // does not change while the app runs, so it is asked once per store.
        let persistent = [
            deps.github_store.persistent(),
            deps.gitlab_store.persistent(),
        ];
        let this = Arc::new_cyclic(|me| Self {
            deps,
            me: me.clone(),
            inner: Mutex::new(Inner::new(gitlab_url)),
            ready,
            persistent,
            emitted: Mutex::new(Emitted::default()),
            last_alert: Mutex::new(None),
        });
        let task = Arc::clone(&this);
        (this.deps.spawn)(Box::pin(async move {
            task.load_tokens().await;
            let _ = loaded.send(true);
        }));
        this
    }

    /// The platform of the last first-review alert sent, if any.
    pub fn last_alert_platform(&self) -> Option<Platform> {
        *self
            .last_alert
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Never taken while `inner` is held (emits never run under the state lock).
    fn emitted(&self) -> MutexGuard<'_, Emitted> {
        self.emitted.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn store(&self, platform: Platform) -> &Arc<dyn TokenStore> {
        match platform {
            Platform::Github => &self.deps.github_store,
            Platform::Gitlab => &self.deps.gitlab_store,
        }
    }

    /// Resolves once both stored tokens were read (never fails).
    pub async fn ready(&self) {
        finished(Some(self.ready.clone())).await;
    }

    async fn load_tokens(&self) {
        tokio::join!(
            self.load_token(Platform::Github),
            self.load_token(Platform::Gitlab)
        );
        let mut effects = Effects::new();
        {
            let mut inner = self.lock();
            self.publish(&mut inner, &mut effects);
            for platform in PLATFORMS {
                self.poll(&mut inner, platform);
            }
        }
        self.run(effects);
    }

    async fn load_token(&self, platform: Platform) {
        let (started_in, no_server) = {
            let mut inner = self.lock();
            let no_server = platform == Platform::Gitlab && inner.gitlab_url.is_empty();
            (inner.rt(platform).generation, no_server)
        };
        if no_server {
            // No server: a token left behind belongs to nobody.
            self.clear_stored_token(platform).await;
            return;
        }
        let token = match self.store(platform).load().await {
            Ok(token) => token,
            Err(error) => {
                log::warn!(target: LOG_TARGET, "Could not load the code review token platform={} error={error}", platform.as_str());
                None
            }
        };
        let mut inner = self.lock();
        let Some(token) = token.filter(|token| !token.is_empty()) else {
            return;
        };
        if started_in != inner.rt(platform).generation || inner.disposed {
            return;
        }
        let base_url = inner.gitlab_url.clone();
        let Some(client) = self.build_client(platform, &token, &base_url) else {
            return;
        };
        let rt = inner.rt(platform);
        rt.client = Some(client);
        rt.status = Status(PlatformStatus::Ok);
    }

    /// `buildClient`: `None` when GitLab has no acceptable URL.
    fn build_client(
        &self,
        platform: Platform,
        token: &str,
        base_url: &str,
    ) -> Option<Arc<dyn CodeReviewClient>> {
        match platform {
            Platform::Github => Some((self.deps.github_client)(token)),
            Platform::Gitlab if base_url.is_empty() => None,
            Platform::Gitlab => (self.deps.gitlab_client)(base_url, token),
        }
    }

    fn platform_state(&self, inner: &Inner, platform: Platform) -> PlatformState {
        let rt = &inner.runtimes[index(platform)];
        PlatformState {
            status: rt.status.0,
            account: rt.account.clone(),
            unreviewed: rt.unreviewed,
            updated_at: rt.updated_at.clone(),
            persistent: self.persistent[index(platform)],
        }
    }

    fn state_of(&self, inner: &Inner) -> CodeReviewState {
        CodeReviewState {
            github: self.platform_state(inner, Platform::Github),
            gitlab: self.platform_state(inner, Platform::Gitlab),
        }
    }

    pub fn state(&self) -> CodeReviewState {
        self.state_of(&self.lock())
    }

    /// `publish`: logs status changes, then the whole state goes out.
    fn publish(&self, inner: &mut Inner, effects: &mut Effects) {
        if inner.disposed {
            return;
        }
        for platform in PLATFORMS {
            let rt = inner.rt(platform);
            if rt.logged_status != Some(rt.status.0) {
                log::info!(target: LOG_TARGET, "Code review status platform={} status={}", platform.as_str(), rt.status.0.as_str());
                rt.logged_status = Some(rt.status.0);
            }
        }
        inner.next_seq += 1;
        effects.push(Effect::State(inner.next_seq, self.state_of(inner)));
    }

    fn emit_contributions(&self, inner: &mut Inner, platform: Platform, effects: &mut Effects) {
        if inner.disposed {
            return;
        }
        let error = inner.rt(platform).contributions_error;
        inner.next_seq += 1;
        effects.push(Effect::Contributions(
            inner.next_seq,
            ContributionsChanged { platform, error },
        ));
    }

    /// Runs what the lock decided, with no lock held.
    ///
    /// Two operations may lock in order A, B and get here in order B, A (the tauri runtime has
    /// several workers): the emit-order lock drops a state or contributions event older than
    /// the last one sent (it carries a stale snapshot; the newer one already went out). Nothing
    /// goes out once disposed (the quit is under way).
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
                Effect::Contributions(seq, change) => {
                    let mut emitted = self.emitted();
                    let last = &mut emitted.contributions[index(change.platform)];
                    if seq > *last {
                        *last = seq;
                        (self.deps.emit_contributions)(&change);
                    }
                }
                Effect::Alert(alert) => {
                    // Turned off between the answer and here: no alert.
                    if self.lock().rt(alert.platform).paused {
                        continue;
                    }
                    // The setting is read when the alert is due; `sound` is the renderer's.
                    let alerts = self.deps.settings.get().alerts;
                    let enabled = match alert.platform {
                        Platform::Github => alerts.github.enabled,
                        Platform::Gitlab => alerts.gitlab.enabled,
                    };
                    if !enabled {
                        continue;
                    }
                    log::info!(target: LOG_TARGET, "Code review first reviews platform={} count={}", alert.platform.as_str(), alert.count);
                    *self
                        .last_alert
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner) = Some(alert.platform);
                    (self.deps.on_alert)(&alert);
                }
            }
        }
    }

    fn timer_slot(rt: &mut Runtime, rhythm: Rhythm) -> &mut Option<(TimerId, u64)> {
        match rhythm {
            Rhythm::Poll => &mut rt.timer,
            Rhythm::Contributions => &mut rt.contributions_timer,
        }
    }

    fn clear_timer(&self, inner: &mut Inner, platform: Platform, rhythm: Rhythm) {
        if let Some((id, _)) = Self::timer_slot(inner.rt(platform), rhythm).take() {
            self.deps.timers.clear(id);
        }
    }

    /// Arms a timer (callbacks never run inside `set_timeout`, so the lock may be held).
    fn arm(&self, inner: &mut Inner, platform: Platform, rhythm: Rhythm, ms: u64) {
        let token = inner.next_id();
        let me = self.me.clone();
        let id = self.deps.timers.set_timeout(
            ms,
            Box::new(move || {
                if let Some(this) = me.upgrade() {
                    this.timer_fired(platform, rhythm, token);
                }
            }),
        );
        *Self::timer_slot(inner.rt(platform), rhythm) = Some((id, token));
    }

    fn timer_fired(&self, platform: Platform, rhythm: Rhythm, token: u64) {
        let mut inner = self.lock();
        let slot = Self::timer_slot(inner.rt(platform), rhythm);
        // Another token: this timer was cleared or replaced meanwhile (it fired in the race
        // with `clear`), so it must not poll.
        if !slot.is_some_and(|(_, armed)| armed == token) {
            return;
        }
        *slot = None;
        match rhythm {
            Rhythm::Poll => self.poll(&mut inner, platform),
            Rhythm::Contributions => self.poll_contributions(&mut inner, platform),
        };
    }

    /// `schedule`.
    fn schedule(&self, inner: &mut Inner, platform: Platform, ms: u64) {
        self.clear_timer(inner, platform, Rhythm::Poll);
        if !inner.started || inner.disposed {
            return;
        }
        self.arm(inner, platform, Rhythm::Poll, ms);
    }

    /// `scheduleContributions`.
    fn schedule_contributions(&self, inner: &mut Inner, platform: Platform) {
        self.clear_timer(inner, platform, Rhythm::Contributions);
        if !inner.view_open || !inner.started || inner.disposed {
            return;
        }
        self.arm(
            inner,
            platform,
            Rhythm::Contributions,
            CONTRIBUTIONS_TICK_MS,
        );
    }

    /// `resetSession`: forgets everything tied to the current token (not the stored token).
    /// Callers publish.
    fn reset_session(&self, inner: &mut Inner, platform: Platform, effects: &mut Effects) {
        self.clear_timer(inner, platform, Rhythm::Poll);
        self.clear_timer(inner, platform, Rhythm::Contributions);
        let rt = inner.rt(platform);
        rt.generation += 1;
        rt.client = None;
        rt.account = None;
        rt.unreviewed = None;
        rt.updated_at = None;
        rt.to_review.clear();
        rt.mine.clear();
        rt.sent.clear();
        rt.remembered.clear();
        rt.detector.reset();
        rt.failures = 0;
        rt.status = Status::default();
        let had_contributions = rt.contributions.is_some() || rt.contributions_error;
        rt.contributions = None;
        rt.contributions_error = false;
        if had_contributions {
            self.emit_contributions(inner, platform, effects);
        }
    }

    /// `authFailed`: the token no longer works; stop asking until a new one is saved.
    fn auth_failed(&self, inner: &mut Inner, platform: Platform, effects: &mut Effects) {
        log::warn!(target: LOG_TARGET, "Code review token rejected platform={}", platform.as_str());
        self.clear_timer(inner, platform, Rhythm::Poll);
        self.clear_timer(inner, platform, Rhythm::Contributions);
        let rt = inner.rt(platform);
        rt.unreviewed = None;
        rt.to_review.clear();
        rt.mine.clear();
        rt.sent.clear();
        rt.status = Status(PlatformStatus::AuthError);
        self.publish(inner, effects);
    }

    /// `clearStoredToken`: after any save in progress.
    async fn clear_stored_token(&self, platform: Platform) {
        let pending = self.lock().rt(platform).pending_save.clone();
        finished(pending).await;
        if let Err(error) = self.store(platform).clear().await {
            log::warn!(target: LOG_TARGET, "Could not clear the code review token platform={} error={error}", platform.as_str());
        }
    }

    /// `poll`: one query per platform and generation at a time; returns the signal of the run.
    fn poll(&self, inner: &mut Inner, platform: Platform) -> Option<watch::Receiver<bool>> {
        let can_poll = inner.can_poll(platform);
        let rt = inner.rt(platform);
        if let Some(in_flight) = &rt.in_flight {
            if in_flight.generation == rt.generation {
                return Some(in_flight.done.clone());
            }
        }
        if !can_poll {
            return None;
        }
        let client = Arc::clone(rt.client.as_ref()?);
        let started_in = rt.generation;
        let this = self.me.upgrade()?;
        self.clear_timer(inner, platform, Rhythm::Poll);
        let id = inner.next_id();
        let (finish, done) = watch::channel(false);
        inner.rt(platform).in_flight = Some(InFlight {
            generation: started_in,
            id,
            done: done.clone(),
        });
        (self.deps.spawn)(Box::pin(async move {
            this.run_poll(platform, started_in, client).await;
            {
                let mut inner = this.lock();
                let rt = inner.rt(platform);
                if rt.in_flight.as_ref().is_some_and(|run| run.id == id) {
                    rt.in_flight = None;
                }
            }
            let _ = finish.send(true);
        }));
        Some(done)
    }

    /// `runPoll`.
    async fn run_poll(
        &self,
        platform: Platform,
        started_in: u64,
        client: Arc<dyn CodeReviewClient>,
    ) {
        let known = self.lock().rt(platform).account.clone();
        let result = async {
            // The account only until known (the token check already asked for it).
            let account = match known {
                Some(account) => account,
                None => client.viewer().await?,
            };
            let snapshot = client.fetch().await?;
            Ok::<_, CodeReviewError>((account, snapshot))
        }
        .await;
        let mut effects = Effects::new();
        {
            let mut inner = self.lock();
            if inner.poll_dropped(platform, started_in) {
                return;
            }
            match result {
                Ok((account, snapshot)) => {
                    let updated_at = self
                        .deps
                        .clock
                        .now()
                        .to_rfc3339_opts(SecondsFormat::Millis, true);
                    let rt = inner.rt(platform);
                    // Own open items uncertain this round (a per-MR call failed) keep their last
                    // known state, for both the detector and the count.
                    let observation = merge_uncertain(&snapshot, &rt.remembered);
                    rt.account = Some(account);
                    rt.to_review = snapshot.to_review;
                    rt.mine = snapshot.mine;
                    rt.unreviewed = Some(observation.unreviewed);
                    rt.remembered = observation.remembered;
                    rt.updated_at = Some(updated_at);
                    rt.failures = 0;
                    rt.status = Status(PlatformStatus::Ok);
                    self.publish(&mut inner, &mut effects);
                    self.schedule(&mut inner, platform, TICK_MS);
                    let rt = inner.rt(platform);
                    let fresh = rt.detector.observe(&observation.observed);
                    if let Some(alert) = announcement(platform, &rt.mine, &fresh) {
                        effects.push(Effect::Alert(alert));
                    }
                }
                Err(CodeReviewError::Auth) => self.auth_failed(&mut inner, platform, &mut effects),
                Err(error) => {
                    let rt = inner.rt(platform);
                    let wait = BACKOFF_MS[rt.failures.min(BACKOFF_MS.len() - 1)];
                    rt.failures += 1;
                    log::warn!(target: LOG_TARGET, "Code review query failed platform={} code={} retryInMs={wait}", platform.as_str(), error_code(error));
                    rt.status = Status(PlatformStatus::Offline);
                    self.publish(&mut inner, &mut effects);
                    self.schedule(&mut inner, platform, wait);
                }
            }
        }
        self.run(effects);
    }

    /// `pollContributions`: never with the view closed; one query per platform and generation.
    fn poll_contributions(
        &self,
        inner: &mut Inner,
        platform: Platform,
    ) -> Option<watch::Receiver<bool>> {
        if !inner.view_open || !inner.can_poll(platform) {
            return None;
        }
        let rt = inner.rt(platform);
        if let Some(in_flight) = &rt.contributions_in_flight {
            if in_flight.generation == rt.generation {
                return Some(in_flight.done.clone());
            }
        }
        let client = Arc::clone(rt.client.as_ref()?);
        let started_in = rt.generation;
        let this = self.me.upgrade()?;
        self.clear_timer(inner, platform, Rhythm::Contributions);
        let id = inner.next_id();
        let (finish, done) = watch::channel(false);
        inner.rt(platform).contributions_in_flight = Some(InFlight {
            generation: started_in,
            id,
            done: done.clone(),
        });
        (self.deps.spawn)(Box::pin(async move {
            this.run_contributions(platform, started_in, client).await;
            {
                let mut inner = this.lock();
                let rt = inner.rt(platform);
                if rt
                    .contributions_in_flight
                    .as_ref()
                    .is_some_and(|run| run.id == id)
                {
                    rt.contributions_in_flight = None;
                }
            }
            let _ = finish.send(true);
        }));
        Some(done)
    }

    /// `runContributions`: the range comes from the clock on every query.
    async fn run_contributions(
        &self,
        platform: Platform,
        started_in: u64,
        client: Arc<dyn CodeReviewClient>,
    ) {
        let result = client.contributions(self.deps.clock.now()).await;
        let mut effects = Effects::new();
        {
            let mut inner = self.lock();
            if inner.poll_dropped(platform, started_in) {
                return;
            }
            match result {
                Ok(summary) => {
                    let rt = inner.rt(platform);
                    rt.contributions = Some(summary);
                    rt.contributions_error = false;
                }
                Err(CodeReviewError::Auth) => {
                    self.auth_failed(&mut inner, platform, &mut effects);
                    // The state's auth-error decides what the view shows; the flag only ends a
                    // pending retry.
                    inner.rt(platform).contributions_error = true;
                    self.emit_contributions(&mut inner, platform, &mut effects);
                    drop(inner);
                    self.run(effects);
                    return;
                }
                Err(error) => {
                    // Lists, status and the rest of the state stay: only the chart shows it.
                    log::warn!(target: LOG_TARGET, "Code review contributions query failed platform={} code={}", platform.as_str(), error_code(error));
                    inner.rt(platform).contributions_error = true;
                }
            }
            self.emit_contributions(&mut inner, platform, &mut effects);
            self.schedule_contributions(&mut inner, platform);
        }
        self.run(effects);
    }

    /// The last lists of a platform (no URLs), remembered as the ids `open` accepts.
    pub async fn list(&self, platform: Platform) -> CodeReviewList {
        self.ready().await;
        let in_flight = self
            .lock()
            .rt(platform)
            .in_flight
            .as_ref()
            .map(|run| run.done.clone());
        finished(in_flight).await;
        let mut inner = self.lock();
        let rt = inner.rt(platform);
        let (to_review, mine) = if usable(rt.status.0) {
            (rt.to_review.clone(), rt.mine.clone())
        } else {
            (Vec::new(), Vec::new())
        };
        rt.sent = to_review
            .iter()
            .chain(&mine)
            .map(|item| (item.item.id.clone(), item.url.clone()))
            .collect();
        CodeReviewList {
            to_review: to_review.iter().map(to_review_item).collect(),
            mine: mine.iter().map(to_review_item).collect(),
        }
    }

    /// Queries every connected platform now (at most every 5 s); contributions too while open.
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
        for platform in PLATFORMS {
            self.poll(&mut inner, platform);
            self.poll_contributions(&mut inner, platform);
        }
    }

    /// A platform turned off or on in the settings (`integrations.github|gitlab.enabled`);
    /// the wiring applies the saved value before `start()`, then every change.
    ///
    /// Off: that platform's review and contributions rhythms stop and an answer still in flight
    /// is dropped (no state, no alert); its token and last state stay. On: queries at once
    /// (contributions too while the view is open; once a run still in flight has ended), then
    /// the usual rhythm. The first-review
    /// baseline starts again, so reviews that came while off are not announced. The other
    /// platform is untouched. Not [`Self::dispose`], which is final.
    pub fn set_enabled(&self, platform: Platform, enabled: bool) {
        let mut inner = self.lock();
        if inner.disposed || inner.rt(platform).paused != enabled {
            return;
        }
        inner.rt(platform).paused = !enabled;
        log::info!(target: LOG_TARGET, "Code review platform enabled platform={} enabled={enabled}", platform.as_str());
        if enabled {
            self.resume(&mut inner, platform);
        } else {
            self.clear_timer(&mut inner, platform, Rhythm::Poll);
            self.clear_timer(&mut inner, platform, Rhythm::Contributions);
            inner.rt(platform).detector.reset();
        }
    }

    /// Queries a platform turned on again, after any run of it still in flight, whatever its
    /// fate: one dropped while off clears its `in_flight` only once the lock is released, and
    /// `poll` would take that run for the current one (no new query, no timer).
    fn resume(&self, inner: &mut Inner, platform: Platform) {
        let rt = inner.rt(platform);
        let waiting: Vec<watch::Receiver<bool>> = [&rt.in_flight, &rt.contributions_in_flight]
            .into_iter()
            .flatten()
            .map(|run| run.done.clone())
            .collect();
        if waiting.is_empty() {
            self.poll(inner, platform);
            self.poll_contributions(inner, platform);
            return;
        }
        let Some(this) = self.me.upgrade() else {
            return;
        };
        (self.deps.spawn)(Box::pin(async move {
            for done in waiting {
                finished(Some(done)).await;
            }
            let mut inner = this.lock();
            this.poll(&mut inner, platform);
            this.poll_contributions(&mut inner, platform);
        }));
    }

    /// The "Revisiones" view opened or closed: contributions are queried on open and every
    /// 15 min while open (an in-flight query still finishes after a close).
    pub fn set_view_open(&self, open: bool) {
        let mut inner = self.lock();
        if inner.view_open == open {
            return;
        }
        inner.view_open = open;
        for platform in PLATFORMS {
            if open {
                self.poll_contributions(&mut inner, platform);
            } else {
                self.clear_timer(&mut inner, platform, Rhythm::Contributions);
            }
        }
    }

    /// The cached month summary and the last query's error; never queries.
    pub async fn contributions(&self, platform: Platform) -> ContributionsResult {
        self.ready().await;
        let mut inner = self.lock();
        let rt = inner.rt(platform);
        let usable = usable(rt.status.0);
        ContributionsResult {
            summary: if usable {
                rt.contributions.clone()
            } else {
                None
            },
            error: usable && rt.contributions_error,
        }
    }

    /// Opens an item of the last list sent, only on its platform's allowed origin. Returns at
    /// once; the browser opens in the background.
    pub fn open(&self, platform: Platform, id: &str) -> Result<(), ExposedError> {
        let url = {
            let mut inner = self.lock();
            let Some(url) = inner.rt(platform).sent.get(id).cloned() else {
                log::warn!(target: LOG_TARGET, "Refused to open an item not shown in the notch platform={}", platform.as_str());
                return Err(ExposedError::new(
                    IpcErrorCode::InvalidInput,
                    "Unknown item",
                ));
            };
            let allowed = match platform {
                Platform::Github => Some(GITHUB_WEB_ORIGIN.to_owned()),
                Platform::Gitlab if inner.gitlab_url.is_empty() => None,
                Platform::Gitlab => origin_of(&inner.gitlab_url),
            };
            if allowed.is_none() || origin_of(&url) != allowed {
                log::warn!(target: LOG_TARGET, "Refused to open an item outside the allowed origin platform={}", platform.as_str());
                return Err(ExposedError::new(
                    IpcErrorCode::InvalidInput,
                    "Item URL not allowed",
                ));
            }
            url
        };
        let opening = (self.deps.open_external)(url);
        (self.deps.spawn)(Box::pin(async move {
            if let Err(error) = opening.await {
                log::warn!(target: LOG_TARGET, "Could not open the item in the browser platform={} error={error}", platform.as_str());
            }
        }));
        Ok(())
    }

    /// Validates the token (and GitLab URL) against the API before saving anything.
    pub async fn set_token(
        &self,
        platform: Platform,
        token: &str,
        url: Option<&str>,
    ) -> SetTokenResult {
        let refused = |reason| SetTokenResult::Refused { reason };
        self.ready().await;
        let token = js_trim(token);
        if token.is_empty() {
            return refused(SetTokenReason::Auth);
        }
        let current_url = self.lock().gitlab_url.clone();
        let mut base_url = current_url.clone();
        if platform == Platform::Gitlab {
            // `gitlabUrlSchema`: at most 512 UTF-16 units, then normalized.
            let raw = url.unwrap_or(&current_url);
            let normalized = (utf16_len(raw) <= GITLAB_URL_MAX)
                .then(|| normalize_gitlab_url(raw))
                .flatten();
            let Some(normalized) = normalized else {
                return refused(SetTokenReason::Url);
            };
            base_url = normalized;
        }
        let Some(client) = self.build_client(platform, token, &base_url) else {
            return refused(SetTokenReason::Url);
        };
        let seq = {
            let mut inner = self.lock();
            let rt = inner.rt(platform);
            rt.token_seq += 1;
            rt.token_seq
        };
        let account = match client.viewer().await {
            Ok(account) => account,
            Err(error) => {
                log::warn!(target: LOG_TARGET, "Code review token check failed platform={} code={}", platform.as_str(), error_code(error));
                return refused(failure_reason(platform, error));
            }
        };
        let superseded = |inner: &mut Inner| inner.rt(platform).token_seq != seq || inner.disposed;
        // `Some(previous URL)` when the GitLab server must be saved first.
        let new_server = {
            let mut inner = self.lock();
            if superseded(&mut inner) {
                return refused(SetTokenReason::Network);
            }
            (platform == Platform::Gitlab && base_url != inner.gitlab_url)
                // Set first, so the settings change is not taken for an outside one.
                .then(|| std::mem::replace(&mut inner.gitlab_url, base_url.clone()))
        };
        if let Some(previous_url) = new_server {
            let mut code_review = self.deps.settings.get();
            code_review.gitlab_url = base_url.clone();
            if let Err(error) = self.deps.settings.update(code_review).await {
                // Settings still hold the old server: keep memory in step and keep nothing of
                // the new token. The current session is untouched.
                log::warn!(target: LOG_TARGET, "Could not save the GitLab server error={error}");
                let mut inner = self.lock();
                if inner.gitlab_url == base_url {
                    inner.gitlab_url = previous_url;
                }
                return refused(SetTokenReason::Network);
            }
            if superseded(&mut self.lock()) {
                return refused(SetTokenReason::Network);
            }
        }
        let persistent = self.persistent[index(platform)];
        let (saved, pending_save) = watch::channel(false);
        let mut effects = Effects::new();
        {
            let mut inner = self.lock();
            self.reset_session(&mut inner, platform, &mut effects);
            let rt = inner.rt(platform);
            rt.client = Some(client);
            rt.account = Some(account.clone());
            rt.status = Status(PlatformStatus::Ok);
            rt.pending_save = Some(pending_save);
            log::info!(target: LOG_TARGET, "Code review token saved platform={} persistent={persistent}", platform.as_str());
            self.publish(&mut inner, &mut effects);
            self.poll(&mut inner, platform);
            self.poll_contributions(&mut inner, platform);
        }
        self.run(effects);
        if let Err(error) = self.store(platform).save(token).await {
            log::warn!(target: LOG_TARGET, "Could not save the code review token platform={} error={error}", platform.as_str());
        }
        let _ = saved.send(true);
        SetTokenResult::Accepted { account }
    }

    /// Removes the token and the state of a platform (a GitLab clear keeps the server URL).
    pub async fn clear(&self, platform: Platform) {
        self.ready().await;
        let mut effects = Effects::new();
        {
            let mut inner = self.lock();
            inner.rt(platform).token_seq += 1;
            self.reset_session(&mut inner, platform, &mut effects);
            self.publish(&mut inner, &mut effects);
        }
        self.run(effects);
        self.clear_stored_token(platform).await;
    }

    /// Starts the rhythm (once the channels and the windows exist).
    pub fn start(&self) {
        let mut inner = self.lock();
        if inner.started {
            return;
        }
        inner.started = true;
        for platform in PLATFORMS {
            self.poll(&mut inner, platform);
            self.poll_contributions(&mut inner, platform);
        }
    }

    /// Stops every timer; later results and publishes are dropped (in-flight work is not
    /// waited for).
    pub fn dispose(&self) {
        let mut inner = self.lock();
        inner.disposed = true;
        for platform in PLATFORMS {
            self.clear_timer(&mut inner, platform, Rhythm::Poll);
            self.clear_timer(&mut inner, platform, Rhythm::Contributions);
        }
    }

    /// The settings changed (`settings.onChange`): a GitLab URL changed from outside
    /// `set_token` closes the GitLab session and drops its token, which must never reach the
    /// new server. Alert changes need nothing (they are read when an alert is due).
    pub fn on_settings_changed(&self, next: &CodeReviewSettings) {
        let mut effects = Effects::new();
        {
            let mut inner = self.lock();
            if inner.disposed || next.gitlab_url == inner.gitlab_url {
                return;
            }
            inner.gitlab_url = next.gitlab_url.clone();
            inner.rt(Platform::Gitlab).token_seq += 1;
            self.reset_session(&mut inner, Platform::Gitlab, &mut effects);
            log::info!(target: LOG_TARGET, "GitLab server changed; session closed");
            self.publish(&mut inner, &mut effects);
        }
        self.run(effects);
        if let Some(this) = self.me.upgrade() {
            (self.deps.spawn)(Box::pin(async move {
                this.clear_stored_token(Platform::Gitlab).await;
            }));
        }
    }
}

/// `announce`'s payload: one first review with its kind, ref and title (from the current list),
/// otherwise just how many.
fn announcement(
    platform: Platform,
    mine: &[ClientItem],
    fresh: &[Alert],
) -> Option<CodeReviewAlert> {
    let first = fresh.first()?;
    let single = (fresh.len() == 1)
        .then(|| mine.iter().find(|item| item.item.id == first.id))
        .flatten();
    Some(match single {
        Some(item) => CodeReviewAlert {
            platform,
            count: 1,
            kind: Some(first.kind),
            reference: Some(item.item.reference.clone()),
            title: Some(item.item.title.clone()),
        },
        None => CodeReviewAlert {
            platform,
            count: u64::try_from(fresh.len()).unwrap_or(u64::MAX),
            kind: None,
            reference: None,
            title: None,
        },
    })
}

impl CodeReviewApi for CodeReviewIntegration {
    fn ready(&self) -> BoxFuture<'_, ()> {
        Box::pin(CodeReviewIntegration::ready(self))
    }

    fn state(&self) -> CodeReviewState {
        CodeReviewIntegration::state(self)
    }

    fn list(&self, platform: Platform) -> BoxFuture<'_, CodeReviewList> {
        Box::pin(CodeReviewIntegration::list(self, platform))
    }

    fn refresh(&self) {
        CodeReviewIntegration::refresh(self);
    }

    fn open(&self, platform: Platform, id: &str) -> Result<(), ExposedError> {
        CodeReviewIntegration::open(self, platform, id)
    }

    fn set_token(
        &self,
        platform: Platform,
        token: String,
        url: Option<String>,
    ) -> BoxFuture<'_, SetTokenResult> {
        Box::pin(async move {
            CodeReviewIntegration::set_token(self, platform, &token, url.as_deref()).await
        })
    }

    fn clear(&self, platform: Platform) -> BoxFuture<'_, ()> {
        Box::pin(CodeReviewIntegration::clear(self, platform))
    }

    fn set_view_open(&self, open: bool) {
        CodeReviewIntegration::set_view_open(self, open);
    }

    fn contributions(&self, platform: Platform) -> BoxFuture<'_, ContributionsResult> {
        Box::pin(CodeReviewIntegration::contributions(self, platform))
    }
}

// ---------------------------------------------------------------------------------------------
// Tauri wiring (0.1.0's `index.ts`)

/// The settings store as the integration sees it: the `codeReview` block, saved through
/// `SettingsStore::update` like every other change (validation, `settings:changed`, listeners).
struct AppSettings(tauri::AppHandle);

impl SettingsSource for AppSettings {
    fn get(&self) -> CodeReviewSettings {
        use tauri::Manager;
        self.0
            .state::<crate::settings::SettingsStore>()
            .get()
            .code_review
    }

    fn update(&self, code_review: CodeReviewSettings) -> BoxFuture<'_, Result<(), String>> {
        use crate::contract::settings::{CodeReviewSettingsPatch, SettingsPatch};
        use tauri::Manager;
        Box::pin(async move {
            let patch = SettingsPatch {
                code_review: Some(CodeReviewSettingsPatch {
                    gitlab_url: Some(code_review.gitlab_url),
                    alerts: Some(code_review.alerts),
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

/// Creates the integration on the notch's timers and the shared wall clock, fills `slot` and
/// starts it. Call on the main thread after the notch and Claude, once the settings store and
/// the wall clock are managed. `None` (channels stay UNAVAILABLE) only when the HTTP client
/// cannot be built.
pub fn install(
    app: &tauri::AppHandle,
    slot: &CodeReviewSlot,
    notch: &Arc<NotchRuntime>,
    data_dir: &Path,
) -> Option<Arc<CodeReviewIntegration>> {
    use super::github::{GithubClient, GITHUB_API_BASE};
    use super::gitlab::GitlabClient;
    use super::http::{ReqwestTransport, Transport};
    use crate::notch::state::NotchEvent;
    use crate::{ipc, settings::SettingsStore};
    use tauri::Manager;

    let overrides = base_overrides_from(
        ipc::dev_overrides_enabled(),
        ipc::dev_env_var("NOTCH_CODE_REVIEW_BASE_URLS").as_deref(),
    );
    let transport: Arc<dyn Transport> = match ReqwestTransport::new() {
        Ok(transport) => Arc::new(transport),
        Err(_) => {
            log::error!(target: LOG_TARGET, "Code review HTTP client unavailable; the integration stays off");
            return None;
        }
    };
    let token_store = |file: &str| -> Arc<dyn TokenStore> {
        Arc::new(SecureTokenStore::new(
            data_dir.join(file),
            "code-review-token",
        ))
    };
    let github_client: GithubFactory = {
        let transport = Arc::clone(&transport);
        let api_base = overrides
            .github
            .clone()
            .unwrap_or_else(|| GITHUB_API_BASE.to_owned());
        Arc::new(move |token: &str| {
            Arc::new(GithubClient::new(
                Arc::clone(&transport),
                api_base.clone(),
                token,
            )) as Arc<dyn CodeReviewClient>
        })
    };
    // Settings only ever hold an https server; in dev/E2E the fake on 127.0.0.1 stands in for it.
    let gitlab_client: GitlabFactory = {
        let transport = Arc::clone(&transport);
        let loopback = overrides.gitlab.clone();
        Arc::new(move |base_url: &str, token: &str| {
            let client = match &loopback {
                Some(fake) => GitlabClient::new_allowing_loopback_http(
                    Arc::clone(&transport),
                    fake.clone(),
                    token,
                ),
                None => GitlabClient::new(Arc::clone(&transport), base_url, token),
            };
            client
                .ok()
                .map(|client| Arc::new(client) as Arc<dyn CodeReviewClient>)
        })
    };
    let controller = Arc::clone(&notch.controller);
    let deps = CodeReviewDeps {
        settings: Arc::new(AppSettings(app.clone())),
        github_store: token_store("code-review-github.bin"),
        gitlab_store: token_store("code-review-gitlab.bin"),
        github_client,
        gitlab_client,
        timers: notch.timers(),
        clock: Arc::clone(&app.state::<Arc<WallClock>>()),
        spawn: Arc::new(|future| {
            tauri::async_runtime::spawn(future);
        }),
        emit: {
            let app = app.clone();
            Arc::new(move |state: &CodeReviewState| {
                let targets = ipc::existing_windows(&app);
                if !targets.is_empty() {
                    ipc::emit_event(&app, &targets, "code-review:state", state);
                }
            })
        },
        // Contributions are shown only in the notch's "Revisiones" view.
        emit_contributions: {
            let app = app.clone();
            Arc::new(move |change: &ContributionsChanged| {
                if app.get_webview_window(ipc::NOTCH).is_some() {
                    ipc::emit_event(
                        &app,
                        &[ipc::NOTCH],
                        "code-review:contributions-changed",
                        change,
                    );
                }
            })
        },
        open_external: opener(app),
        // First reviews go to the notch only, payload first: the capsule already knows what to
        // show when the mode turns to alert; the controller drops it with a panel open and ends
        // it after 6 s.
        on_alert: {
            let app = app.clone();
            Arc::new(move |alert: &CodeReviewAlert| {
                if app.get_webview_window(ipc::NOTCH).is_none() {
                    return;
                }
                ipc::emit_event(&app, &[ipc::NOTCH], "code-review:alert", alert);
                controller.dispatch(NotchEvent::Review { on: true });
            })
        },
    };
    let integration = CodeReviewIntegration::new(deps);
    {
        let integration = Arc::downgrade(&integration);
        app.state::<SettingsStore>().on_change(move |next| {
            if let Some(integration) = integration.upgrade() {
                integration.on_settings_changed(&next.code_review);
            }
        });
    }
    // A platform disabled in the settings never queries, not even at start; `lib.rs` follows
    // later changes.
    let integrations = app.state::<SettingsStore>().get().integrations;
    integration.set_enabled(Platform::Github, integrations.github.enabled);
    integration.set_enabled(Platform::Gitlab, integrations.gitlab.enabled);
    if slot
        .set(Arc::clone(&integration) as Arc<dyn CodeReviewApi>)
        .is_err()
    {
        log::error!(target: LOG_TARGET, "Code review installed twice");
    }
    integration.start();
    Some(integration)
}

#[cfg(test)]
#[path = "integration_tests.rs"]
mod tests;
