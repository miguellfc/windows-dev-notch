//! Port of 0.1.0's `code-review-integration.test.ts` (fake clients, token stores and
//! settings; virtual timers stepped in due order; a fixed wall clock moved with them), plus the
//! Rust-only cases of the part-4 plan.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, Weak};

use chrono::{DateTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use super::*;
use crate::code_review::client::{
    ClientItem, CodeReviewClient, CodeReviewError, CodeReviewSnapshot, OwnReview,
};
use crate::code_review::contributions::{date_key, summarize, SummaryInput};
use crate::code_review::ipc::{register, CodeReviewApi, CodeReviewSlot};
use crate::contract::code_review::{
    CodeReviewAlert, CodeReviewList, CodeReviewState, ContributionSummary, ContributionTotals,
    ContributionsChanged, ContributionsResult, Platform, PlatformState, PlatformStatus, ReviewItem,
    ReviewKind, ReviewState, SetTokenReason, SetTokenResult,
};
use crate::contract::settings::{CodeReviewAlertSettings, CodeReviewAlerts, CodeReviewSettings};
use crate::ipc::{BoxFuture, Ctx, IpcErrorCode, Registry, Sender, CONTROL_CENTER, NOTCH};
use crate::services::clock::WallClock;
use crate::services::timers::TestTimers;

const GITLAB: &str = "https://gitlab.example.com";
const TITLE: &str = "Secret feature title";
const MADRID: Tz = chrono_tz::Europe::Madrid;
const GITHUB: Platform = Platform::Github;
const GITLAB_P: Platform = Platform::Gitlab;

type Res<T> = Result<T, CodeReviewError>;

fn start_time() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 12, 10, 0, 0).unwrap()
}

fn iso(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// ---------------------------------------------------------------------------------------------
// Items and snapshots

fn item(platform: Platform, id: &str, review: ReviewState) -> ClientItem {
    let (reference, url) = match platform {
        Platform::Github => (
            format!("acme/repo#{id}"),
            format!("https://github.com/acme/repo/pull/{id}"),
        ),
        Platform::Gitlab => (
            format!("grp/proj!{id}"),
            format!("{GITLAB}/grp/proj/-/merge_requests/{id}"),
        ),
    };
    ClientItem {
        item: ReviewItem {
            id: id.into(),
            reference,
            title: format!("{TITLE} {id}"),
            author: "someone".into(),
            updated_at: "2026-11-12T10:00:00.000Z".into(),
            draft: false,
            review,
            checks: None,
            conflicts: false,
        },
        url,
    }
}

fn none(platform: Platform, id: &str) -> ClientItem {
    item(platform, id, ReviewState::None)
}

fn with_url(mut item: ClientItem, url: &str) -> ClientItem {
    item.url = url.into();
    item
}

fn draft(mut item: ClientItem) -> ClientItem {
    item.item.draft = true;
    item
}

/// A snapshot like the clients build it; `uncertain` ids are left out of `own_review`.
fn snap_with(
    mine: Vec<ClientItem>,
    to_review: Vec<ClientItem>,
    uncertain: &[&str],
) -> CodeReviewSnapshot {
    let open: Vec<&ClientItem> = mine.iter().filter(|i| !i.item.draft).collect();
    CodeReviewSnapshot {
        unreviewed: u32::try_from(
            open.iter()
                .filter(|i| i.item.review == ReviewState::None)
                .count(),
        )
        .unwrap(),
        own_review: open
            .iter()
            .filter(|i| !uncertain.contains(&i.item.id.as_str()))
            .map(|i| OwnReview {
                id: i.item.id.clone(),
                review: i.item.review,
            })
            .collect(),
        to_review,
        mine,
    }
}

fn snap(mine: Vec<ClientItem>) -> CodeReviewSnapshot {
    snap_with(mine, vec![], &[])
}

/// A summary like the clients build it for `now`'s month (Madrid), `commits` contributions today.
fn summary_for(now: DateTime<Utc>, commits: u64) -> ContributionSummary {
    let local = now.with_timezone(&MADRID);
    let counts: HashMap<String, u64> = HashMap::from([(date_key(local.date_naive()), commits)]);
    let totals = ContributionTotals {
        commits,
        ..ContributionTotals::default()
    };
    summarize(&SummaryInput {
        now: &local,
        counts: &counts,
        today: totals,
        week: totals,
        month_totals: totals,
        partial: false,
        restricted: false,
    })
}

// ---------------------------------------------------------------------------------------------
// Fake client

enum Reply<T> {
    Now(Res<T>),
    Later(oneshot::Receiver<Res<T>>),
}

async fn resolve<T>(reply: Reply<T>) -> Res<T> {
    match reply {
        Reply::Now(result) => result,
        Reply::Later(receiver) => receiver.await.unwrap_or(Err(CodeReviewError::Network)),
    }
}

struct Script<T: Clone> {
    once: VecDeque<Reply<T>>,
    default: Res<T>,
    calls: usize,
}

impl<T: Clone> Script<T> {
    fn new(default: Res<T>) -> Self {
        Self {
            once: VecDeque::new(),
            default,
            calls: 0,
        }
    }

    fn next(&mut self) -> Reply<T> {
        self.calls += 1;
        self.once
            .pop_front()
            .unwrap_or_else(|| Reply::Now(self.default.clone()))
    }
}

/// `vi.fn` mocks for `viewer`, `fetch` and `contributions`.
struct FakeClient {
    viewer: Mutex<Script<String>>,
    fetch: Mutex<Script<CodeReviewSnapshot>>,
    contributions_once: Mutex<VecDeque<Reply<ContributionSummary>>>,
    /// `mockRejectedValue` for contributions; else a summary for `now`.
    contributions_error: Mutex<Option<CodeReviewError>>,
    contributions_nows: Mutex<Vec<DateTime<Utc>>>,
}

impl FakeClient {
    fn new(platform: Platform) -> Self {
        let account = match platform {
            Platform::Github => "octo",
            Platform::Gitlab => "tanuki",
        };
        Self {
            viewer: Mutex::new(Script::new(Ok(account.into()))),
            fetch: Mutex::new(Script::new(Ok(snap(vec![])))),
            contributions_once: Mutex::new(VecDeque::new()),
            contributions_error: Mutex::new(None),
            contributions_nows: Mutex::new(Vec::new()),
        }
    }

    fn fetch_calls(&self) -> usize {
        self.fetch.lock().unwrap().calls
    }

    fn viewer_calls(&self) -> usize {
        self.viewer.lock().unwrap().calls
    }

    fn contributions_calls(&self) -> usize {
        self.contributions_nows.lock().unwrap().len()
    }

    fn contributions_now(&self, call: usize) -> DateTime<Utc> {
        self.contributions_nows.lock().unwrap()[call]
    }

    /// `fetch.mockResolvedValue` / `mockRejectedValue`.
    fn set_fetch(&self, result: Res<CodeReviewSnapshot>) {
        self.fetch.lock().unwrap().default = result;
    }

    /// `fetch.mockResolvedValueOnce` / `mockRejectedValueOnce`.
    fn fetch_once(&self, result: Res<CodeReviewSnapshot>) {
        self.fetch
            .lock()
            .unwrap()
            .once
            .push_back(Reply::Now(result));
    }

    /// A `fetch` that waits for the returned sender.
    fn fetch_later(&self) -> oneshot::Sender<Res<CodeReviewSnapshot>> {
        let (sender, receiver) = oneshot::channel();
        self.fetch
            .lock()
            .unwrap()
            .once
            .push_back(Reply::Later(receiver));
        sender
    }

    fn set_viewer(&self, result: Res<String>) {
        self.viewer.lock().unwrap().default = result;
    }

    fn contributions_fail(&self, error: Option<CodeReviewError>) {
        *self.contributions_error.lock().unwrap() = error;
    }

    fn contributions_once(&self, result: Res<ContributionSummary>) {
        self.contributions_once
            .lock()
            .unwrap()
            .push_back(Reply::Now(result));
    }

    fn contributions_later(&self) -> oneshot::Sender<Res<ContributionSummary>> {
        let (sender, receiver) = oneshot::channel();
        self.contributions_once
            .lock()
            .unwrap()
            .push_back(Reply::Later(receiver));
        sender
    }
}

impl CodeReviewClient for FakeClient {
    fn viewer(&self) -> BoxFuture<'_, Res<String>> {
        let reply = self.viewer.lock().unwrap().next();
        Box::pin(resolve(reply))
    }

    fn fetch(&self) -> BoxFuture<'_, Res<CodeReviewSnapshot>> {
        let reply = self.fetch.lock().unwrap().next();
        Box::pin(resolve(reply))
    }

    fn contributions(&self, now: DateTime<Utc>) -> BoxFuture<'_, Res<ContributionSummary>> {
        self.contributions_nows.lock().unwrap().push(now);
        let reply = self
            .contributions_once
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or_else(|| match *self.contributions_error.lock().unwrap() {
                Some(error) => Reply::Now(Err(error)),
                None => Reply::Now(Ok(summary_for(now, 1))),
            });
        Box::pin(resolve(reply))
    }
}

// ---------------------------------------------------------------------------------------------
// Fake token stores and settings

struct FakeStore {
    stored: Mutex<Option<String>>,
    saves: Mutex<Vec<String>>,
    clears: Mutex<usize>,
}

impl FakeStore {
    fn new(token: Option<&str>) -> Self {
        Self {
            stored: Mutex::new(token.map(str::to_owned)),
            saves: Mutex::new(Vec::new()),
            clears: Mutex::new(0),
        }
    }

    fn stored(&self) -> Option<String> {
        self.stored.lock().unwrap().clone()
    }

    fn saves(&self) -> Vec<String> {
        self.saves.lock().unwrap().clone()
    }

    fn clears(&self) -> usize {
        *self.clears.lock().unwrap()
    }

    fn reset_clears(&self) {
        *self.clears.lock().unwrap() = 0;
    }
}

impl TokenStore for FakeStore {
    fn load(&self) -> BoxFuture<'_, Result<Option<String>, String>> {
        let token = self.stored();
        Box::pin(async move { Ok(token) })
    }

    fn save<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.saves.lock().unwrap().push(token.to_owned());
            *self.stored.lock().unwrap() = Some(token.to_owned());
            Ok(())
        })
    }

    fn clear(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            *self.clears.lock().unwrap() += 1;
            *self.stored.lock().unwrap() = None;
            Ok(())
        })
    }

    fn persistent(&self) -> bool {
        true
    }
}

struct FakeSettings {
    current: Mutex<CodeReviewSettings>,
    update_fails: bool,
    updates: Mutex<usize>,
    /// `onChange`'s listener: the integration under test.
    listener: Mutex<Weak<CodeReviewIntegration>>,
}

impl FakeSettings {
    fn notify(&self) {
        let next = self.current.lock().unwrap().clone();
        let listener = self.listener.lock().unwrap().upgrade();
        if let Some(integration) = listener {
            integration.on_settings_changed(&next);
        }
    }
}

impl SettingsSource for FakeSettings {
    fn get(&self) -> CodeReviewSettings {
        self.current.lock().unwrap().clone()
    }

    fn update(&self, code_review: CodeReviewSettings) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            *self.updates.lock().unwrap() += 1;
            if self.update_fails {
                return Err("Error".into());
            }
            *self.current.lock().unwrap() = code_review;
            self.notify();
            Ok(())
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Harness

struct Setup {
    github: Option<&'static str>,
    gitlab: Option<&'static str>,
    gitlab_url: &'static str,
    alerts: bool,
    started: bool,
    update_fails: bool,
    now: DateTime<Utc>,
}

impl Default for Setup {
    fn default() -> Self {
        Self {
            github: Some("gh-token-stored"),
            gitlab: None,
            gitlab_url: GITLAB,
            alerts: true,
            started: true,
            update_fails: false,
            now: start_time(),
        }
    }
}

type Prepare = Box<dyn Fn(&FakeClient, Platform, &str) + Send>;

struct Built {
    platform: Platform,
    token: String,
    base_url: Option<String>,
    client: Arc<FakeClient>,
}

struct T {
    integration: Arc<CodeReviewIntegration>,
    timers: Arc<TestTimers>,
    clock: Arc<WallClock>,
    settings: Arc<FakeSettings>,
    github_store: Arc<FakeStore>,
    gitlab_store: Arc<FakeStore>,
    clients: Arc<Mutex<Vec<Built>>>,
    prepare: Arc<Mutex<Prepare>>,
    emitted: Arc<Mutex<Vec<CodeReviewState>>>,
    contribution_events: Arc<Mutex<Vec<ContributionsChanged>>>,
    alerts: Arc<Mutex<Vec<CodeReviewAlert>>>,
    opened: Arc<Mutex<Vec<String>>>,
}

fn alert_settings(enabled: bool) -> CodeReviewAlertSettings {
    CodeReviewAlertSettings {
        enabled,
        sound: true,
    }
}

fn setup(options: Setup) -> T {
    // Installed before anything logs (the capture is process-wide).
    crate::services::test_log::capture().expect("the test logger");
    let timers = Arc::new(TestTimers::new());
    let clock = Arc::new(WallClock::fixed(options.now));
    let settings = Arc::new(FakeSettings {
        current: Mutex::new(CodeReviewSettings {
            gitlab_url: options.gitlab_url.into(),
            alerts: CodeReviewAlerts {
                github: alert_settings(options.alerts),
                gitlab: alert_settings(options.alerts),
            },
        }),
        update_fails: options.update_fails,
        updates: Mutex::new(0),
        listener: Mutex::new(Weak::new()),
    });
    let github_store = Arc::new(FakeStore::new(options.github));
    let gitlab_store = Arc::new(FakeStore::new(options.gitlab));
    let clients: Arc<Mutex<Vec<Built>>> = Arc::default();
    let prepare: Arc<Mutex<Prepare>> = Arc::new(Mutex::new(Box::new(|_, _, _| {})));
    let emitted: Arc<Mutex<Vec<CodeReviewState>>> = Arc::default();
    let contribution_events: Arc<Mutex<Vec<ContributionsChanged>>> = Arc::default();
    let alerts: Arc<Mutex<Vec<CodeReviewAlert>>> = Arc::default();
    let opened: Arc<Mutex<Vec<String>>> = Arc::default();

    let build = {
        let clients = Arc::clone(&clients);
        let prepare = Arc::clone(&prepare);
        move |platform: Platform, token: &str, base_url: Option<&str>| {
            let client = Arc::new(FakeClient::new(platform));
            (prepare.lock().unwrap())(&client, platform, token);
            clients.lock().unwrap().push(Built {
                platform,
                token: token.to_owned(),
                base_url: base_url.map(str::to_owned),
                client: Arc::clone(&client),
            });
            client
        }
    };
    let deps = CodeReviewDeps {
        settings: Arc::clone(&settings) as Arc<dyn SettingsSource>,
        github_store: Arc::clone(&github_store) as Arc<dyn TokenStore>,
        gitlab_store: Arc::clone(&gitlab_store) as Arc<dyn TokenStore>,
        github_client: {
            let build = build.clone();
            Arc::new(move |token: &str| {
                build(Platform::Github, token, None) as Arc<dyn CodeReviewClient>
            })
        },
        gitlab_client: Arc::new(move |base_url: &str, token: &str| {
            Some(build(Platform::Gitlab, token, Some(base_url)) as Arc<dyn CodeReviewClient>)
        }),
        timers: Arc::clone(&timers) as Arc<dyn Timers>,
        clock: Arc::clone(&clock),
        spawn: Arc::new(|future| {
            tokio::spawn(future);
        }),
        emit: {
            let emitted = Arc::clone(&emitted);
            Arc::new(move |state: &CodeReviewState| emitted.lock().unwrap().push(state.clone()))
        },
        emit_contributions: {
            let events = Arc::clone(&contribution_events);
            Arc::new(move |change: &ContributionsChanged| events.lock().unwrap().push(*change))
        },
        open_external: {
            let opened = Arc::clone(&opened);
            Arc::new(move |url: String| {
                opened.lock().unwrap().push(url);
                Box::pin(async { Ok(()) }) as BoxFuture<'static, Result<(), String>>
            })
        },
        on_alert: {
            let alerts = Arc::clone(&alerts);
            Arc::new(move |alert: &CodeReviewAlert| alerts.lock().unwrap().push(alert.clone()))
        },
    };
    let integration = CodeReviewIntegration::new(deps);
    *settings.listener.lock().unwrap() = Arc::downgrade(&integration);
    if options.started {
        integration.start();
    }
    T {
        integration,
        timers,
        clock,
        settings,
        github_store,
        gitlab_store,
        clients,
        prepare,
        emitted,
        contribution_events,
        alerts,
        opened,
    }
}

/// Lets the spawned tasks run until they wait on something else.
async fn settle() {
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
}

impl T {
    fn set_prepare(&self, prepare: impl Fn(&FakeClient, Platform, &str) + Send + 'static) {
        *self.prepare.lock().unwrap() = Box::new(prepare);
    }

    /// The last client built for `platform`.
    fn last(&self, platform: Platform) -> Arc<FakeClient> {
        self.clients
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|built| built.platform == platform)
            .map(|built| Arc::clone(&built.client))
            .unwrap_or_else(|| panic!("no {} client", platform.as_str()))
    }

    /// `(token, baseUrl)` of every client built for `platform`.
    fn factory_calls(&self, platform: Platform) -> Vec<(String, Option<String>)> {
        self.clients
            .lock()
            .unwrap()
            .iter()
            .filter(|built| built.platform == platform)
            .map(|built| (built.token.clone(), built.base_url.clone()))
            .collect()
    }

    fn client_count(&self) -> usize {
        self.clients.lock().unwrap().len()
    }

    fn state(&self) -> CodeReviewState {
        self.integration.state()
    }

    fn status(&self, platform: Platform) -> PlatformStatus {
        self.platform_state(platform).status
    }

    fn platform_state(&self, platform: Platform) -> PlatformState {
        let state = self.state();
        match platform {
            Platform::Github => state.github,
            Platform::Gitlab => state.gitlab,
        }
    }

    fn alerts(&self) -> Vec<CodeReviewAlert> {
        self.alerts.lock().unwrap().clone()
    }

    fn events(&self) -> Vec<ContributionsChanged> {
        self.contribution_events.lock().unwrap().clone()
    }

    fn opened(&self) -> Vec<String> {
        self.opened.lock().unwrap().clone()
    }

    async fn ready(&self) {
        self.integration.ready().await;
    }

    fn advance(&self, ms: u64) {
        self.clock.advance(i64::try_from(ms).unwrap());
        self.timers.advance(ms);
    }

    /// `vi.advanceTimersByTimeAsync(ms)`: runs every timer due within `ms`, in due order
    /// (including those armed meanwhile), letting the spawned work run after each.
    async fn flush(&self, ms: u64) {
        settle().await;
        let mut remaining = ms;
        while let Some(due) = self.timers.next_due_in() {
            if due > remaining {
                break;
            }
            self.advance(due);
            remaining -= due;
            settle().await;
        }
        self.advance(remaining);
        settle().await;
    }

    fn change_settings(&self, next: CodeReviewSettings) {
        *self.settings.current.lock().unwrap() = next;
        self.settings.notify();
    }

    fn settings(&self) -> CodeReviewSettings {
        self.settings.get()
    }

    async fn list(&self, platform: Platform) -> CodeReviewList {
        self.integration.list(platform).await
    }

    async fn summary(&self, platform: Platform) -> Option<ContributionSummary> {
        self.integration.contributions(platform).await.summary
    }
}

fn unconfigured() -> PlatformState {
    PlatformState {
        status: PlatformStatus::Unconfigured,
        account: None,
        unreviewed: None,
        updated_at: None,
        persistent: true,
    }
}

fn accepted(account: &str) -> SetTokenResult {
    SetTokenResult::Accepted {
        account: account.into(),
    }
}

fn refused(reason: SetTokenReason) -> SetTokenResult {
    SetTokenResult::Refused { reason }
}

fn empty_list() -> CodeReviewList {
    CodeReviewList {
        to_review: vec![],
        mine: vec![],
    }
}

fn ids(items: &[ReviewItem]) -> Vec<&str> {
    items.iter().map(|item| item.id.as_str()).collect()
}

fn invalid_input(result: Result<(), ExposedError>, message: &str) {
    let error = result.expect_err("refused");
    assert_eq!(error.code(), IpcErrorCode::InvalidInput);
    assert_eq!(error.message(), message);
}

fn changed(platform: Platform, error: bool) -> ContributionsChanged {
    ContributionsChanged { platform, error }
}

/// The code-review lines this test logged. The capture is shared by the whole test binary, but
/// a current-thread `#[tokio::test]` runs its spawned tasks and timer callbacks on its own
/// thread, so only this test's lines are kept.
fn code_review_log() -> Vec<String> {
    crate::services::test_log::capture()
        .expect("the test logger")
        .lines_of_this_thread()
        .into_iter()
        .filter(|line| line.contains(&format!("{LOG_TARGET} ")))
        .collect()
}

const SECRETS: [&str; 8] = [
    "SECRET",
    "gh-token-stored",
    "gl-token",
    "acme",
    "grp/proj",
    "someone",
    "octo",
    "tanuki",
];

// ---------------------------------------------------------------------------------------------
// start and rhythm

#[tokio::test]
async fn is_unconfigured_without_a_token_and_never_builds_a_client() {
    let t = setup(Setup {
        github: None,
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.state().github, unconfigured());
    assert_eq!(t.status(GITLAB_P), PlatformStatus::Unconfigured);
    assert!(t.factory_calls(GITHUB).is_empty());
    t.flush(10 * 60_000).await;
    assert_eq!(t.client_count(), 0);
}

#[tokio::test]
async fn with_a_token_queries_at_once_reports_ok_with_account_and_count_then_every_120_s() {
    let t = setup(Setup::default());
    t.set_prepare(|c, _, _| {
        c.set_fetch(Ok(snap(vec![
            none(GITHUB, "1"),
            item(GITHUB, "2", ReviewState::Approved),
            draft(none(GITHUB, "3")),
        ])))
    });
    t.ready().await;
    t.flush(0).await;
    let client = t.last(GITHUB);
    assert_eq!(client.fetch_calls(), 1);
    let state = t.state().github;
    assert_eq!(state.status, PlatformStatus::Ok);
    assert_eq!(state.account.as_deref(), Some("octo"));
    assert_eq!(state.unreviewed, Some(1));
    assert_eq!(
        state.updated_at.as_deref(),
        Some("2026-11-12T10:00:00.000Z")
    );
    t.flush(TICK_MS - 1).await;
    assert_eq!(client.fetch_calls(), 1);
    t.flush(1).await;
    assert_eq!(client.fetch_calls(), 2);
    assert_eq!(
        t.emitted.lock().unwrap().last().unwrap().github.status,
        PlatformStatus::Ok
    );
}

#[tokio::test]
async fn does_not_query_before_start() {
    let t = setup(Setup {
        started: false,
        ..Setup::default()
    });
    t.ready().await;
    t.flush(TICK_MS * 2).await;
    assert_eq!(t.last(GITHUB).fetch_calls(), 0);
    t.integration.start();
    t.flush(0).await;
    assert_eq!(t.last(GITHUB).fetch_calls(), 1);
}

#[tokio::test]
async fn manual_refresh_queries_at_once_at_most_every_5_s() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let client = t.last(GITHUB);
    t.integration.refresh();
    t.flush(0).await;
    assert_eq!(client.fetch_calls(), 2);
    t.integration.refresh();
    t.flush(4_000).await;
    assert_eq!(client.fetch_calls(), 2);
    t.integration.refresh();
    t.flush(1_000).await;
    t.integration.refresh();
    t.flush(0).await;
    assert_eq!(client.fetch_calls(), 3);
}

#[tokio::test]
async fn failures_go_offline_with_growing_waits_1_2_4_5_5_min_and_keep_the_last_data() {
    let t = setup(Setup::default());
    t.set_prepare(|c, _, _| c.fetch_once(Ok(snap(vec![none(GITHUB, "1")]))));
    t.ready().await;
    t.flush(0).await;
    let client = t.last(GITHUB);
    client.set_fetch(Err(CodeReviewError::Network));
    t.list(GITHUB).await;
    t.flush(TICK_MS).await;
    let state = t.state().github;
    assert_eq!(state.status, PlatformStatus::Offline);
    assert_eq!(state.unreviewed, Some(1));
    assert_eq!(
        state.updated_at.as_deref(),
        Some("2026-11-12T10:00:00.000Z")
    );
    assert_eq!(t.list(GITHUB).await.mine.len(), 1);
    let mut calls = client.fetch_calls();
    for wait in [
        BACKOFF_MS[0],
        BACKOFF_MS[1],
        BACKOFF_MS[2],
        BACKOFF_MS[3],
        BACKOFF_MS[3],
    ] {
        t.flush(wait - 1).await;
        assert_eq!(client.fetch_calls(), calls);
        t.flush(1).await;
        calls += 1;
        assert_eq!(client.fetch_calls(), calls);
    }
    client.set_fetch(Ok(snap(vec![])));
    t.flush(BACKOFF_MS[3]).await;
    let state = t.state().github;
    assert_eq!(state.status, PlatformStatus::Ok);
    assert_eq!(state.unreviewed, Some(0));
    t.flush(TICK_MS).await;
    assert_eq!(client.fetch_calls(), calls + 2);
}

#[tokio::test]
async fn auth_401_403_turns_auth_error_and_stops_querying_that_platform_only() {
    let t = setup(Setup {
        gitlab: Some("gl-token"),
        ..Setup::default()
    });
    t.set_prepare(|c, platform, _| {
        if platform == GITHUB {
            c.set_fetch(Err(CodeReviewError::Auth));
        }
    });
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.status(GITHUB), PlatformStatus::AuthError);
    assert_eq!(t.state().github.unreviewed, None);
    assert_eq!(t.status(GITLAB_P), PlatformStatus::Ok);
    t.flush(TICK_MS * 5).await;
    assert_eq!(t.last(GITHUB).fetch_calls(), 1);
    assert_eq!(t.last(GITLAB_P).fetch_calls(), 6);
    t.integration.refresh();
    t.flush(0).await;
    assert_eq!(t.last(GITHUB).fetch_calls(), 1);
    assert_eq!(t.list(GITHUB).await, empty_list());
}

#[tokio::test]
async fn a_gitlab_token_without_a_configured_url_belongs_to_nobody_cleared_unconfigured() {
    let t = setup(Setup {
        gitlab_url: "",
        gitlab: Some("gl-orphan"),
        ..Setup::default()
    });
    t.ready().await;
    assert_eq!(t.status(GITLAB_P), PlatformStatus::Unconfigured);
    assert!(t.gitlab_store.clears() > 0);
    assert!(t.factory_calls(GITLAB_P).is_empty());
}

#[tokio::test]
async fn builds_the_gitlab_client_with_the_configured_url() {
    let t = setup(Setup {
        gitlab: Some("gl-token"),
        ..Setup::default()
    });
    t.ready().await;
    assert_eq!(
        t.factory_calls(GITLAB_P),
        vec![("gl-token".to_owned(), Some(GITLAB.to_owned()))]
    );
}

// ---------------------------------------------------------------------------------------------
// setToken and clear

#[tokio::test]
async fn validates_with_viewer_before_saving_then_queries() {
    let t = setup(Setup {
        github: None,
        ..Setup::default()
    });
    t.ready().await;
    assert_eq!(
        t.integration.set_token(GITHUB, " ghp_new ", None).await,
        accepted("octo")
    );
    assert_eq!(t.factory_calls(GITHUB), vec![("ghp_new".to_owned(), None)]);
    assert_eq!(t.github_store.saves(), vec!["ghp_new".to_owned()]);
    t.flush(0).await;
    let state = t.state().github;
    assert_eq!(state.status, PlatformStatus::Ok);
    assert_eq!(state.account.as_deref(), Some("octo"));
    assert_eq!(state.unreviewed, Some(0));
    assert_eq!(t.last(GITHUB).fetch_calls(), 1);
    // The token was checked once; the poll does not ask for the account again.
    assert_eq!(t.last(GITHUB).viewer_calls(), 1);
}

async fn a_failure_answers(code: CodeReviewError, reason: SetTokenReason) {
    let t = setup(Setup {
        github: None,
        ..Setup::default()
    });
    t.set_prepare(move |c, _, _| c.set_viewer(Err(code)));
    t.ready().await;
    assert_eq!(
        t.integration.set_token(GITHUB, "ghp_bad", None).await,
        refused(reason)
    );
    assert!(t.github_store.saves().is_empty());
    assert_eq!(t.status(GITHUB), PlatformStatus::Unconfigured);
}

#[tokio::test]
async fn an_auth_failure_answers_auth_and_saves_nothing() {
    a_failure_answers(CodeReviewError::Auth, SetTokenReason::Auth).await;
}

#[tokio::test]
async fn a_network_failure_answers_network_and_saves_nothing() {
    a_failure_answers(CodeReviewError::Network, SetTokenReason::Network).await;
}

#[tokio::test]
async fn a_server_failure_answers_network_and_saves_nothing() {
    a_failure_answers(CodeReviewError::Server, SetTokenReason::Network).await;
}

#[tokio::test]
async fn a_rate_limited_failure_answers_network_and_saves_nothing() {
    a_failure_answers(CodeReviewError::RateLimited, SetTokenReason::Network).await;
}

#[tokio::test]
async fn a_failed_new_token_leaves_a_working_one_untouched() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let working = t.last(GITHUB);
    t.set_prepare(|c, _, _| c.set_viewer(Err(CodeReviewError::Auth)));
    assert_eq!(
        t.integration.set_token(GITHUB, "ghp_bad", None).await,
        refused(SetTokenReason::Auth)
    );
    assert_eq!(t.status(GITHUB), PlatformStatus::Ok);
    t.flush(TICK_MS).await;
    assert_eq!(working.fetch_calls(), 2);
}

#[tokio::test]
async fn gitlab_refuses_a_non_https_url_with_reason_url_saves_the_normalized_url_in_settings() {
    let t = setup(Setup {
        gitlab_url: "",
        ..Setup::default()
    });
    t.ready().await;
    t.gitlab_store.reset_clears(); // the startup clear of an orphan token
    assert_eq!(
        t.integration
            .set_token(GITLAB_P, "glpat", Some("http://gitlab.example.com"))
            .await,
        refused(SetTokenReason::Url)
    );
    assert_eq!(
        t.integration.set_token(GITLAB_P, "glpat", None).await,
        refused(SetTokenReason::Url)
    );
    assert!(t.factory_calls(GITLAB_P).is_empty());
    assert_eq!(
        t.integration
            .set_token(GITLAB_P, "glpat", Some(" https://git.example.org/base/ "))
            .await,
        accepted("tanuki")
    );
    assert_eq!(
        t.factory_calls(GITLAB_P),
        vec![(
            "glpat".to_owned(),
            Some("https://git.example.org/base".to_owned())
        )]
    );
    assert_eq!(t.settings().gitlab_url, "https://git.example.org/base");
    assert_eq!(t.gitlab_store.stored().as_deref(), Some("glpat"));
    t.flush(0).await;
    assert_eq!(t.status(GITLAB_P), PlatformStatus::Ok);
    // Its own settings write does not count as an outside URL change.
    assert_eq!(t.gitlab_store.clears(), 0);
}

#[tokio::test]
async fn gitlab_an_invalid_response_from_the_server_not_gitlab_is_reason_url() {
    let t = setup(Setup::default());
    t.set_prepare(|c, _, _| c.set_viewer(Err(CodeReviewError::InvalidResponse)));
    t.ready().await;
    assert_eq!(
        t.integration
            .set_token(GITLAB_P, "glpat", Some("https://not-gitlab.example.com"))
            .await,
        refused(SetTokenReason::Url)
    );
    assert_eq!(*t.settings.updates.lock().unwrap(), 0);
}

#[tokio::test]
async fn gitlab_when_the_url_cannot_be_saved_the_new_token_is_refused_and_the_current_session_stays(
) {
    let t = setup(Setup {
        update_fails: true,
        gitlab: Some("gl-old"),
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    assert_eq!(
        t.integration
            .set_token(GITLAB_P, "gl-new", Some("https://other.example.com"))
            .await,
        refused(SetTokenReason::Network)
    );
    assert!(t.gitlab_store.saves().is_empty());
    assert_eq!(t.gitlab_store.stored().as_deref(), Some("gl-old"));
    assert_eq!(t.status(GITLAB_P), PlatformStatus::Ok);
}

#[tokio::test]
async fn gitlab_after_a_failed_url_save_an_unrelated_settings_change_wipes_nothing() {
    let t = setup(Setup {
        update_fails: true,
        gitlab: Some("gl-old"),
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    t.integration
        .set_token(GITLAB_P, "gl-new", Some("https://other.example.com"))
        .await;
    t.gitlab_store.reset_clears();
    let mut next = t.settings();
    next.alerts.github = CodeReviewAlertSettings {
        enabled: false,
        sound: false,
    };
    t.change_settings(next);
    t.flush(0).await;
    assert_eq!(t.gitlab_store.clears(), 0);
    assert_eq!(t.gitlab_store.stored().as_deref(), Some("gl-old"));
    assert_eq!(t.status(GITLAB_P), PlatformStatus::Ok);
}

#[tokio::test]
async fn a_new_token_resets_the_detector_and_drops_results_of_the_old_generation() {
    let t = setup(Setup::default());
    let release: Arc<Mutex<Option<oneshot::Sender<Res<CodeReviewSnapshot>>>>> = Arc::default();
    {
        let release = Arc::clone(&release);
        t.set_prepare(move |c, _, token| {
            if token == "gh-token-stored" {
                c.fetch_once(Ok(snap(vec![none(GITHUB, "1")])));
                *release.lock().unwrap() = Some(c.fetch_later());
            }
        });
    }
    t.ready().await;
    t.flush(0).await;
    t.integration.refresh();
    t.flush(0).await;
    // A token change while the old query is in flight.
    t.set_prepare(|c, _, _| c.set_fetch(Ok(snap(vec![item(GITHUB, "1", ReviewState::Approved)]))));
    t.integration.set_token(GITHUB, "ghp_other", None).await;
    t.flush(0).await;
    let sender = release.lock().unwrap().take().unwrap();
    let _ = sender.send(Ok(snap(vec![
        item(GITHUB, "1", ReviewState::Approved),
        none(GITHUB, "9"),
    ])));
    t.flush(0).await;
    assert_eq!(t.state().github.unreviewed, Some(0));
    // A baseline again: '1' was none for the old token, approved for the new one, yet no alert.
    assert_eq!(t.alerts(), vec![]);
    // GitLab is untouched by a GitHub token change.
    assert!(t.factory_calls(GITLAB_P).is_empty());
}

#[tokio::test]
async fn an_outside_change_of_the_gitlab_url_closes_the_session_and_drops_the_token() {
    let t = setup(Setup {
        gitlab: Some("gl-token"),
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    let before = t.last(GITLAB_P);
    let mut next = t.settings();
    next.gitlab_url = "https://elsewhere.example.com".into();
    t.change_settings(next);
    t.flush(0).await;
    assert_eq!(t.status(GITLAB_P), PlatformStatus::Unconfigured);
    assert_eq!(t.gitlab_store.stored(), None);
    t.flush(TICK_MS * 2).await;
    assert_eq!(before.fetch_calls(), 1);
    assert_eq!(t.status(GITHUB), PlatformStatus::Ok);
}

#[tokio::test]
async fn clear_removes_the_token_and_the_state_and_stops_querying() {
    let t = setup(Setup::default());
    t.set_prepare(|c, _, _| c.set_fetch(Ok(snap(vec![none(GITHUB, "1")]))));
    t.ready().await;
    t.flush(0).await;
    t.list(GITHUB).await;
    t.integration.clear(GITHUB).await;
    assert_eq!(t.github_store.stored(), None);
    assert_eq!(t.state().github, unconfigured());
    assert_eq!(t.list(GITHUB).await, empty_list());
    assert!(t.integration.open(GITHUB, "1").is_err());
    t.flush(TICK_MS * 2).await;
    assert_eq!(t.last(GITHUB).fetch_calls(), 1);
}

// ---------------------------------------------------------------------------------------------
// alerts

async fn review_round(alerts: bool) -> T {
    let t = setup(Setup {
        alerts,
        ..Setup::default()
    });
    t.set_prepare(|c, _, _| {
        c.fetch_once(Ok(snap(vec![none(GITHUB, "1"), none(GITHUB, "2")])));
        c.set_fetch(Ok(snap(vec![
            item(GITHUB, "1", ReviewState::Approved),
            none(GITHUB, "2"),
        ])));
    });
    t.ready().await;
    t.flush(0).await;
    t.flush(TICK_MS).await;
    t
}

#[tokio::test]
async fn one_first_review_alert_with_kind_ref_and_title() {
    let t = review_round(true).await;
    assert_eq!(
        t.alerts(),
        vec![CodeReviewAlert {
            platform: GITHUB,
            count: 1,
            kind: Some(ReviewKind::Approved),
            reference: Some("acme/repo#1".into()),
            title: Some(format!("{TITLE} 1")),
        }]
    );
    assert_eq!(t.state().github.unreviewed, Some(1));
}

#[tokio::test]
async fn no_alert_with_alerts_disabled() {
    let t = review_round(false).await;
    assert_eq!(t.alerts(), vec![]);
}

fn count_alert(platform: Platform, count: u64) -> CodeReviewAlert {
    CodeReviewAlert {
        platform,
        count,
        kind: None,
        reference: None,
        title: None,
    }
}

#[tokio::test]
async fn several_at_once_only_the_count() {
    let t = setup(Setup::default());
    t.set_prepare(|c, _, _| {
        c.fetch_once(Ok(snap(vec![none(GITHUB, "1"), none(GITHUB, "2")])));
        c.set_fetch(Ok(snap(vec![
            item(GITHUB, "1", ReviewState::Changes),
            item(GITHUB, "2", ReviewState::Commented),
        ])));
    });
    t.ready().await;
    t.flush(0).await;
    t.flush(TICK_MS).await;
    assert_eq!(t.alerts(), vec![count_alert(GITHUB, 2)]);
}

#[tokio::test]
async fn gitlab_an_mr_reviewed_during_a_transient_per_mr_failure_still_alerts_once_the_data_returns(
) {
    let t = setup(Setup {
        github: None,
        gitlab: Some("gl-token"),
        ..Setup::default()
    });
    t.set_prepare(|c, _, _| {
        c.fetch_once(Ok(snap(vec![none(GITLAB_P, "7"), none(GITLAB_P, "8")])));
        // Reviewed meanwhile, but the per-MR calls failed: degraded to 'none', uncertain.
        c.fetch_once(Ok(snap_with(
            vec![none(GITLAB_P, "7"), none(GITLAB_P, "8")],
            vec![],
            &["7"],
        )));
        c.set_fetch(Ok(snap(vec![
            item(GITLAB_P, "7", ReviewState::Approved),
            none(GITLAB_P, "8"),
        ])));
    });
    t.ready().await;
    t.flush(0).await;
    t.flush(TICK_MS).await;
    assert_eq!(t.alerts(), vec![]);
    t.flush(TICK_MS).await;
    assert_eq!(
        t.alerts(),
        vec![CodeReviewAlert {
            platform: GITLAB_P,
            count: 1,
            kind: Some(ReviewKind::Approved),
            reference: Some("grp/proj!7".into()),
            title: Some(format!("{TITLE} 7")),
        }]
    );
}

#[tokio::test]
async fn gitlab_an_uncertain_mr_keeps_its_previous_state_in_the_count_no_jump() {
    let t = setup(Setup {
        github: None,
        gitlab: Some("gl-token"),
        ..Setup::default()
    });
    t.set_prepare(|c, _, _| {
        // Round 1: 7 approved, 8 unreviewed -> 1.
        c.fetch_once(Ok(snap(vec![
            item(GITLAB_P, "7", ReviewState::Approved),
            none(GITLAB_P, "8"),
        ])));
        // Round 2: 7's calls fail and it degrades to 'none' -> the client counts 2; we keep 1.
        c.fetch_once(Ok(snap_with(
            vec![none(GITLAB_P, "7"), none(GITLAB_P, "8")],
            vec![],
            &["7"],
        )));
        // Round 3: an unknown MR (never seen) is uncertain: left out of the count.
        c.fetch_once(Ok(snap_with(
            vec![
                item(GITLAB_P, "7", ReviewState::Approved),
                none(GITLAB_P, "8"),
                none(GITLAB_P, "9"),
            ],
            vec![],
            &["9"],
        )));
        c.set_fetch(Ok(snap(vec![
            item(GITLAB_P, "7", ReviewState::Approved),
            none(GITLAB_P, "8"),
            item(GITLAB_P, "9", ReviewState::Approved),
        ])));
    });
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.state().gitlab.unreviewed, Some(1));
    for _ in 0..3 {
        t.flush(TICK_MS).await;
        assert_eq!(t.state().gitlab.unreviewed, Some(1));
    }
    // 9 was never known as 'none': appearing reviewed is no first review.
    assert_eq!(t.alerts(), vec![]);
}

// ---------------------------------------------------------------------------------------------
// list and open

#[tokio::test]
async fn lists_without_urls_and_opens_only_ids_of_the_last_list_on_allowed_origins() {
    let t = setup(Setup {
        gitlab: Some("gl-token"),
        ..Setup::default()
    });
    t.set_prepare(|c, platform, _| {
        if platform == GITHUB {
            c.set_fetch(Ok(snap_with(
                vec![
                    none(GITHUB, "1"),
                    with_url(none(GITHUB, "2"), "https://evil.example.com/x"),
                ],
                vec![with_url(none(GITHUB, "3"), "http://github.com/a")],
                &[],
            )));
        } else {
            c.set_fetch(Ok(snap(vec![
                none(GITLAB_P, "5"),
                with_url(none(GITLAB_P, "6"), "https://github.com/x"),
            ])));
        }
    });
    t.ready().await;
    t.flush(0).await;
    assert!(t.integration.open(GITHUB, "1").is_err()); // not listed yet
    let list = t.list(GITHUB).await;
    assert_eq!(ids(&list.mine), ["1", "2"]);
    assert!(!serde_json::to_string(&list).unwrap().contains("https://"));
    t.integration.open(GITHUB, "1").unwrap();
    t.flush(0).await;
    assert_eq!(t.opened(), ["https://github.com/acme/repo/pull/1"]);
    assert!(t.integration.open(GITHUB, "2").is_err());
    assert!(t.integration.open(GITHUB, "3").is_err());
    assert!(t.integration.open(GITLAB_P, "5").is_err()); // the gitlab list was never sent
    t.list(GITLAB_P).await;
    t.integration.open(GITLAB_P, "5").unwrap();
    t.flush(0).await;
    assert_eq!(
        t.opened().last().map(String::as_str),
        Some(format!("{GITLAB}/grp/proj/-/merge_requests/5").as_str())
    );
    assert!(t.integration.open(GITLAB_P, "6").is_err());
    assert!(t.integration.open(GITLAB_P, "1").is_err());
    assert_eq!(t.opened().len(), 2);
}

// ---------------------------------------------------------------------------------------------
// privacy

#[tokio::test]
async fn never_logs_tokens_titles_refs_or_authors() {
    let t = setup(Setup {
        gitlab: Some("glpat-SECRETTOKEN"),
        ..Setup::default()
    });
    t.set_prepare(|c, platform, _| {
        c.fetch_once(Ok(snap(vec![none(platform, "1")])));
        c.fetch_once(Ok(snap(vec![item(platform, "1", ReviewState::Approved)])));
        c.set_fetch(Err(CodeReviewError::Server));
    });
    t.ready().await;
    t.flush(0).await;
    t.flush(TICK_MS * 3).await;
    t.integration
        .set_token(GITHUB, "ghp_SECRETTOKEN", None)
        .await;
    t.list(GITHUB).await;
    assert!(t.integration.open(GITHUB, "nope").is_err());
    t.integration.clear(GITLAB_P).await;
    let log = code_review_log();
    assert!(!log.is_empty());
    for line in &log {
        for secret in SECRETS {
            assert!(!line.contains(secret), "{line}");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// contributions

fn both() -> Setup {
    Setup {
        gitlab: Some("gl-token"),
        ..Setup::default()
    }
}

#[tokio::test]
async fn never_queries_contributions_while_the_view_is_closed() {
    let t = setup(both());
    t.ready().await;
    t.flush(CONTRIBUTIONS_TICK_MS * 3).await;
    t.integration.refresh();
    t.flush(0).await;
    assert_eq!(t.last(GITHUB).contributions_calls(), 0);
    assert_eq!(t.last(GITLAB_P).contributions_calls(), 0);
    assert_eq!(t.summary(GITHUB).await, None);
}

#[tokio::test]
async fn queries_each_connected_platform_on_open_then_every_15_min_while_open_stops_on_close() {
    let t = setup(both());
    t.ready().await;
    t.flush(0).await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    let gh = t.last(GITHUB);
    let gl = t.last(GITLAB_P);
    assert_eq!(gh.contributions_calls(), 1);
    assert_eq!(gl.contributions_calls(), 1);
    assert_eq!(
        t.summary(GITHUB)
            .await
            .map(|summary| summary.month)
            .as_deref(),
        Some("2026-11")
    );
    let events = t.events();
    assert!(events.contains(&changed(GITHUB, false)));
    assert!(events.contains(&changed(GITLAB_P, false)));
    t.flush(CONTRIBUTIONS_TICK_MS - 1).await;
    assert_eq!(gh.contributions_calls(), 1);
    t.flush(1).await;
    assert_eq!(gh.contributions_calls(), 2);
    assert_eq!(gl.contributions_calls(), 2);
    t.integration.set_view_open(false);
    t.flush(CONTRIBUTIONS_TICK_MS * 4).await;
    assert_eq!(gh.contributions_calls(), 2);
    // The cache outlives the closed view (shown at once on the next open, then refreshed).
    assert!(t.summary(GITHUB).await.is_some());
    t.integration.set_view_open(true);
    t.flush(0).await;
    assert_eq!(gh.contributions_calls(), 3);
}

#[tokio::test]
async fn opening_twice_in_a_row_does_not_start_a_second_timer_or_query() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.set_view_open(true);
    t.integration.set_view_open(true);
    t.flush(0).await;
    assert_eq!(t.last(GITHUB).contributions_calls(), 1);
    t.flush(CONTRIBUTIONS_TICK_MS).await;
    assert_eq!(t.last(GITHUB).contributions_calls(), 2);
}

#[tokio::test]
async fn skips_unconfigured_and_auth_error_platforms() {
    let t = setup(Setup {
        github: None,
        gitlab: Some("gl-token"),
        ..Setup::default()
    });
    t.set_prepare(|c, _, _| c.set_fetch(Err(CodeReviewError::Auth)));
    t.ready().await;
    t.flush(0).await;
    t.integration.set_view_open(true);
    t.flush(CONTRIBUTIONS_TICK_MS).await;
    assert_eq!(t.last(GITLAB_P).contributions_calls(), 0);
    assert_eq!(t.summary(GITHUB).await, None);
    assert_eq!(t.summary(GITLAB_P).await, None);
}

#[tokio::test]
async fn manual_refresh_also_refreshes_contributions_while_open_sharing_the_5_s_minimum() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    let gh = t.last(GITHUB);
    assert_eq!(gh.contributions_calls(), 1);
    t.flush(5_000).await;
    t.integration.refresh();
    t.flush(0).await;
    assert_eq!(gh.contributions_calls(), 2);
    assert_eq!(gh.fetch_calls(), 2);
    t.integration.refresh();
    t.flush(4_000).await;
    assert_eq!(gh.contributions_calls(), 2);
    // The 15 min rhythm restarts from the manual query.
    t.flush(CONTRIBUTIONS_TICK_MS - 4_000 - 1).await;
    assert_eq!(gh.contributions_calls(), 2);
    t.flush(1).await;
    assert_eq!(gh.contributions_calls(), 3);
}

#[tokio::test]
async fn a_failure_keeps_the_cache_flags_the_error_and_leaves_lists_and_state_alone_success_clears_the_flag(
) {
    let t = setup(Setup::default());
    t.set_prepare(|c, _, _| c.set_fetch(Ok(snap(vec![none(GITHUB, "1")]))));
    t.ready().await;
    t.flush(0).await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    let gh = t.last(GITHUB);
    let cached = t.summary(GITHUB).await;
    assert!(cached.is_some());
    let states_before = t.emitted.lock().unwrap().len();
    gh.contributions_once(Err(CodeReviewError::Network));
    t.flush(CONTRIBUTIONS_TICK_MS).await;
    assert_eq!(t.events().last(), Some(&changed(GITHUB, true)));
    // A view that mounts now (reload, reopen) reads the error without waiting for the next event.
    assert_eq!(
        t.integration.contributions(GITHUB).await,
        ContributionsResult {
            summary: cached,
            error: true
        }
    );
    let state = t.state().github;
    assert_eq!(state.status, PlatformStatus::Ok);
    assert_eq!(state.unreviewed, Some(1));
    assert_eq!(t.list(GITHUB).await.mine.len(), 1);
    assert!(t.emitted.lock().unwrap()[states_before..]
        .iter()
        .all(|state| state.github.status == PlatformStatus::Ok));
    // A failed retry still ends with an event (the view stops its spinner).
    let events = t.events().len();
    gh.contributions_once(Err(CodeReviewError::Server));
    t.integration.refresh();
    t.flush(0).await;
    assert_eq!(t.events().len(), events + 1);
    assert_eq!(t.events().last(), Some(&changed(GITHUB, true)));
    t.flush(5_000).await;
    t.integration.refresh();
    t.flush(0).await;
    assert_eq!(t.events().last(), Some(&changed(GITHUB, false)));
    assert!(!t.integration.contributions(GITHUB).await.error);
}

#[tokio::test]
async fn a_401_403_on_contributions_goes_to_auth_error_like_the_lists_and_stops_both() {
    let t = setup(both());
    t.ready().await;
    t.flush(0).await;
    let gh = t.last(GITHUB);
    gh.contributions_fail(Some(CodeReviewError::Auth));
    t.integration.set_view_open(true);
    t.flush(0).await;
    assert_eq!(t.status(GITHUB), PlatformStatus::AuthError);
    assert_eq!(t.state().github.unreviewed, None);
    assert_eq!(t.status(GITLAB_P), PlatformStatus::Ok);
    // The retry ends with an error event; the state's auth-error decides what the view shows.
    assert_eq!(
        t.events()
            .into_iter()
            .rfind(|event| event.platform == GITHUB),
        Some(changed(GITHUB, true))
    );
    assert_eq!(
        t.integration.contributions(GITHUB).await,
        ContributionsResult {
            summary: None,
            error: false
        }
    );
    assert_eq!(t.list(GITHUB).await, empty_list());
    let fetches = gh.fetch_calls();
    t.flush(CONTRIBUTIONS_TICK_MS * 2).await;
    assert_eq!(gh.contributions_calls(), 1);
    assert_eq!(gh.fetch_calls(), fetches);
    assert_eq!(t.last(GITLAB_P).contributions_calls(), 3);
}

#[tokio::test]
async fn a_list_query_that_ends_after_a_contributions_401_does_not_revive_the_platform() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let gh = t.last(GITHUB);
    let release_list = gh.fetch_later();
    gh.contributions_fail(Some(CodeReviewError::Auth));
    t.flush(TICK_MS).await;
    assert_eq!(gh.fetch_calls(), 2);
    t.integration.set_view_open(true);
    t.flush(0).await;
    assert_eq!(t.status(GITHUB), PlatformStatus::AuthError);
    let _ = release_list.send(Ok(snap(vec![none(GITHUB, "1")])));
    t.flush(TICK_MS * 2).await;
    assert_eq!(t.status(GITHUB), PlatformStatus::AuthError);
    assert_eq!(t.state().github.unreviewed, None);
    assert_eq!(gh.fetch_calls(), 2);
}

#[tokio::test]
async fn a_new_token_starts_a_new_generation_empty_cache_old_results_dropped_new_query_while_open()
{
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    let old = t.last(GITHUB);
    assert!(t.summary(GITHUB).await.is_some());
    let release = old.contributions_later();
    t.flush(CONTRIBUTIONS_TICK_MS).await;
    assert_eq!(old.contributions_calls(), 2);
    let release_new: Arc<Mutex<Option<oneshot::Sender<Res<ContributionSummary>>>>> = Arc::default();
    {
        let release_new = Arc::clone(&release_new);
        t.set_prepare(move |c, _, _| *release_new.lock().unwrap() = Some(c.contributions_later()));
    }
    t.integration.set_token(GITHUB, "gh-new", None).await;
    assert_eq!(t.summary(GITHUB).await, None);
    assert_eq!(t.events().last(), Some(&changed(GITHUB, false)));
    let _ = release.send(Ok(summary_for(t.clock.now(), 99)));
    t.flush(0).await;
    assert_eq!(t.summary(GITHUB).await, None);
    let fresh = t.last(GITHUB);
    assert!(!Arc::ptr_eq(&fresh, &old));
    assert_eq!(fresh.contributions_calls(), 1);
    let sender = release_new.lock().unwrap().take().unwrap();
    let _ = sender.send(Ok(summary_for(t.clock.now(), 2)));
    t.flush(0).await;
    assert_eq!(
        t.summary(GITHUB).await.map(|summary| summary.month_total),
        Some(2)
    );
    t.integration.clear(GITHUB).await;
    assert_eq!(t.summary(GITHUB).await, None);
}

#[tokio::test]
async fn computes_the_range_from_the_clock_on_each_query_crossing_midnight_and_the_month_end() {
    let start = MADRID
        .with_ymd_and_hms(2026, 11, 30, 23, 50, 0)
        .unwrap()
        .with_timezone(&Utc);
    let t = setup(Setup {
        now: start,
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    let gh = t.last(GITHUB);
    assert_eq!(gh.contributions_now(0), start);
    assert_eq!(
        t.summary(GITHUB)
            .await
            .map(|summary| summary.month)
            .as_deref(),
        Some("2026-11")
    );
    t.flush(CONTRIBUTIONS_TICK_MS).await;
    let second = gh.contributions_now(1).with_timezone(&MADRID);
    assert_eq!(
        second.date_naive(),
        chrono::NaiveDate::from_ymd_opt(2026, 12, 1).unwrap()
    );
    let summary = t.summary(GITHUB).await.unwrap();
    assert_eq!(summary.month, "2026-12");
    assert_eq!(summary.today.commits, 1);
}

#[tokio::test]
async fn stops_the_contributions_timer_on_dispose() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    t.integration.dispose();
    t.flush(CONTRIBUTIONS_TICK_MS * 2).await;
    assert_eq!(t.last(GITHUB).contributions_calls(), 1);
}

#[tokio::test]
async fn logs_only_platforms_and_codes() {
    let t = setup(both());
    t.ready().await;
    t.flush(0).await;
    t.last(GITHUB)
        .contributions_once(Err(CodeReviewError::Network));
    t.integration.set_view_open(true);
    t.flush(CONTRIBUTIONS_TICK_MS).await;
    let log = code_review_log();
    assert!(log
        .iter()
        .any(|line| line
            .contains("Code review contributions query failed platform=github code=network")));
    for line in &log {
        for secret in SECRETS {
            assert!(!line.contains(secret), "{line}");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// parseCodeReviewBaseOverrides

#[test]
fn accepts_only_loopback_http_origins_with_a_port_per_platform() {
    assert_eq!(parse_base_overrides(None), BaseOverrides::default());
    assert_eq!(
        parse_base_overrides(Some(
            "github=http://127.0.0.1:1234,gitlab=http://127.0.0.1:5678"
        )),
        BaseOverrides {
            github: Some("http://127.0.0.1:1234".into()),
            gitlab: Some("http://127.0.0.1:5678".into()),
        }
    );
    assert_eq!(
        parse_base_overrides(Some("gitlab=http://127.0.0.1:5678")),
        BaseOverrides {
            github: None,
            gitlab: Some("http://127.0.0.1:5678".into()),
        }
    );
    for bad in [
        "github=https://api.github.com",
        "github=http://localhost:1234",
        "github=http://127.0.0.1",
        "github=http://127.0.0.1:1234/path",
        "github=http://127.0.0.1:99999",
        "other=http://127.0.0.1:1234",
        "github=http://127.0.0.1:1234,gitlab=http://evil.example.com:80",
        "nonsense",
    ] {
        assert_eq!(
            parse_base_overrides(Some(bad)),
            BaseOverrides::default(),
            "{bad}"
        );
    }
}

#[test]
fn base_overrides_edge_cases_match_the_js_parser() {
    // Blank, trimmed parts, port bounds, later duplicates overwrite, non-ASCII digits refused.
    assert_eq!(parse_base_overrides(Some("   ")), BaseOverrides::default());
    assert_eq!(
        parse_base_overrides(Some(
            " github = http://127.0.0.1:1 ,github=http://127.0.0.1:65535"
        )),
        BaseOverrides {
            github: Some("http://127.0.0.1:65535".into()),
            gitlab: None,
        }
    );
    for bad in [
        "github=http://127.0.0.1:0",
        "github=http://127.0.0.1:65536",
        "github=http://127.0.0.1:\u{0661}2",
        "github=http://127.0.0.1:123456",
        "github=",
        "github=http://127.0.0.1:80,",
    ] {
        assert_eq!(
            parse_base_overrides(Some(bad)),
            BaseOverrides::default(),
            "{bad}"
        );
    }
    assert_eq!(
        base_overrides_from(false, Some("github=http://127.0.0.1:1")),
        BaseOverrides::default()
    );
    assert_eq!(
        base_overrides_from(true, Some("github=http://127.0.0.1:1"))
            .github
            .as_deref(),
        Some("http://127.0.0.1:1")
    );
}

// ---------------------------------------------------------------------------------------------
// Rust-only cases of the part-4 plan

#[tokio::test]
async fn auth_error_stops_polling_only_that_platform() {
    let t = setup(both());
    t.set_prepare(|c, platform, token| {
        if platform == GITLAB_P && token == "gl-token" {
            c.set_fetch(Err(CodeReviewError::Auth));
        }
    });
    t.ready().await;
    t.flush(0).await;
    let gl = t.last(GITLAB_P);
    let gh = t.last(GITHUB);
    assert_eq!(t.status(GITLAB_P), PlatformStatus::AuthError);
    assert_eq!(t.state().gitlab.unreviewed, None);
    assert_eq!(
        t.emitted.lock().unwrap().last().unwrap().gitlab.status,
        PlatformStatus::AuthError
    );
    t.flush(TICK_MS * 3).await;
    assert_eq!(gl.fetch_calls(), 1);
    assert_eq!(gh.fetch_calls(), 4);
    // Neither the view, a manual refresh nor the 15 min rhythm query the rejected platform.
    t.integration.set_view_open(true);
    t.flush(5_000).await;
    t.integration.refresh();
    t.flush(CONTRIBUTIONS_TICK_MS).await;
    assert_eq!(gl.fetch_calls(), 1);
    assert_eq!(gl.contributions_calls(), 0);
    assert!(gh.contributions_calls() >= 2);
    assert_eq!(t.status(GITHUB), PlatformStatus::Ok);
    assert!(t.integration.open(GITLAB_P, "1").is_err());
    // Only a new token revives it.
    assert_eq!(
        t.integration.set_token(GITLAB_P, "gl-new", None).await,
        accepted("tanuki")
    );
    t.flush(0).await;
    assert_eq!(t.status(GITLAB_P), PlatformStatus::Ok);
    assert_eq!(t.last(GITLAB_P).fetch_calls(), 1);
    assert_eq!(gl.fetch_calls(), 1);
}

#[tokio::test]
async fn backoff_then_recovers_keeping_last_data() {
    let t = setup(Setup::default());
    t.set_prepare(|c, _, _| {
        c.fetch_once(Ok(snap(vec![
            none(GITHUB, "1"),
            item(GITHUB, "2", ReviewState::Approved),
        ])));
        for error in [
            CodeReviewError::RateLimited,
            CodeReviewError::Server,
            CodeReviewError::InvalidResponse,
            CodeReviewError::Network,
        ] {
            c.fetch_once(Err(error));
        }
        c.fetch_once(Ok(snap(vec![item(GITHUB, "1", ReviewState::Approved)])));
        c.fetch_once(Err(CodeReviewError::Network));
        c.set_fetch(Ok(snap(vec![])));
    });
    t.ready().await;
    t.flush(0).await;
    let client = t.last(GITHUB);
    let first = t.state().github;
    assert_eq!(first.status, PlatformStatus::Ok);
    t.flush(TICK_MS).await;
    let mut calls = 2;
    assert_eq!(client.fetch_calls(), calls);
    // rate-limited, server, invalid-response and network all back off: 1, 2, 4, 5 min.
    for wait in BACKOFF_MS {
        let offline = t.state().github;
        assert_eq!(offline.status, PlatformStatus::Offline);
        assert_eq!(offline.account.as_deref(), Some("octo"));
        assert_eq!(offline.unreviewed, Some(1));
        assert_eq!(offline.updated_at, first.updated_at);
        assert_eq!(t.list(GITHUB).await.mine.len(), 2);
        t.flush(wait - 1).await;
        assert_eq!(client.fetch_calls(), calls);
        t.flush(1).await;
        calls += 1;
        assert_eq!(client.fetch_calls(), calls);
    }
    // Recovered: fresh data, a new time, and the rhythm back to 120 s.
    let recovered = t.state().github;
    assert_eq!(recovered.status, PlatformStatus::Ok);
    assert_eq!(recovered.unreviewed, Some(0));
    assert_eq!(
        recovered.updated_at.as_deref(),
        Some(iso(start_time() + chrono::Duration::milliseconds(840_000)).as_str())
    );
    t.flush(TICK_MS).await;
    assert_eq!(t.status(GITHUB), PlatformStatus::Offline);
    // The failure count was reset by the success: the first wait again.
    t.flush(BACKOFF_MS[0] - 1).await;
    assert_eq!(client.fetch_calls(), calls + 1);
    t.flush(1).await;
    assert_eq!(client.fetch_calls(), calls + 2);
    assert_eq!(t.status(GITHUB), PlatformStatus::Ok);
}

#[tokio::test]
async fn open_refuses_unknown_ids_and_foreign_origins() {
    let t = setup(Setup {
        gitlab: Some("gl-token"),
        gitlab_url: "https://gitlab.example.com/base",
        ..Setup::default()
    });
    t.set_prepare(|c, platform, _| {
        if platform == GITHUB {
            c.set_fetch(Ok(snap(vec![
                none(GITHUB, "1"),
                with_url(none(GITHUB, "2"), "https://github.com.evil.example/x"),
                with_url(none(GITHUB, "3"), "https://github.com:8443/x"),
                with_url(none(GITHUB, "4"), "javascript:alert(1)"),
                with_url(none(GITHUB, "5"), "https://api.github.com/x"),
            ])));
        } else {
            c.set_fetch(Ok(snap(vec![
                with_url(
                    none(GITLAB_P, "7"),
                    "https://gitlab.example.com/other/-/merge_requests/7",
                ),
                with_url(none(GITLAB_P, "8"), "http://gitlab.example.com/base/x"),
                with_url(none(GITLAB_P, "9"), "https://gitlab.example.com:444/base/x"),
                with_url(none(GITLAB_P, "10"), "not a url"),
            ])));
        }
    });
    t.ready().await;
    t.flush(0).await;
    invalid_input(t.integration.open(GITHUB, "1"), "Unknown item");
    t.list(GITHUB).await;
    t.list(GITLAB_P).await;
    invalid_input(t.integration.open(GITHUB, "nope"), "Unknown item");
    invalid_input(t.integration.open(GITLAB_P, "1"), "Unknown item");
    for id in ["2", "3", "4", "5"] {
        invalid_input(t.integration.open(GITHUB, id), "Item URL not allowed");
    }
    for id in ["8", "9", "10"] {
        invalid_input(t.integration.open(GITLAB_P, id), "Item URL not allowed");
    }
    t.integration.open(GITHUB, "1").unwrap();
    // The GitLab origin allows any path of that server, not only the base path.
    t.integration.open(GITLAB_P, "7").unwrap();
    t.flush(0).await;
    assert_eq!(
        t.opened(),
        [
            "https://github.com/acme/repo/pull/1",
            "https://gitlab.example.com/other/-/merge_requests/7",
        ]
    );
    // A server change forgets what was sent: nothing of the old server opens.
    let mut next = t.settings();
    next.gitlab_url = "https://elsewhere.example.com".into();
    t.change_settings(next);
    invalid_input(t.integration.open(GITLAB_P, "7"), "Unknown item");
    assert_eq!(t.opened().len(), 2);
}

fn ctx(label: &str, page: &str) -> Ctx {
    Ctx::for_test(Sender {
        label: label.into(),
        url: format!("http://tauri.localhost/{page}/index.html")
            .parse()
            .unwrap(),
    })
}

#[tokio::test]
async fn no_code_review_output_carries_a_token() {
    const STORED: &str = "ghp_STORED-token-4f1a";
    const NEW_GITHUB: &str = "ghp_NEW-token-9b2c";
    const GITLAB_TOKEN: &str = "glpat-TOKEN-77e0";
    let t = setup(Setup {
        github: Some(STORED),
        gitlab: Some(GITLAB_TOKEN),
        ..Setup::default()
    });
    t.set_prepare(|c, platform, _| {
        c.fetch_once(Ok(snap(vec![none(platform, "1")])));
        c.set_fetch(Ok(snap(vec![item(platform, "1", ReviewState::Approved)])));
    });
    let slot: Arc<CodeReviewSlot> = Arc::default();
    assert!(slot
        .set(Arc::clone(&t.integration) as Arc<dyn CodeReviewApi>)
        .is_ok());
    let mut registry = Registry::with_dev_origin(false);
    register(&mut registry, &slot);
    let notch = ctx(NOTCH, "notch");
    let control = ctx(CONTROL_CENTER, "control-center");
    let mut outputs: Vec<Value> = Vec::new();
    t.ready().await;
    t.flush(0).await;
    outputs.push(
        registry
            .dispatch(&control, "code-review:get-state", None)
            .await,
    );
    outputs.push(
        registry
            .dispatch(&notch, "code-review:view", Some(json!({ "open": true })))
            .await,
    );
    t.flush(TICK_MS).await;
    for platform in ["github", "gitlab"] {
        outputs.push(
            registry
                .dispatch(
                    &notch,
                    "code-review:list",
                    Some(json!({ "platform": platform })),
                )
                .await,
        );
        outputs.push(
            registry
                .dispatch(
                    &notch,
                    "code-review:contributions",
                    Some(json!({ "platform": platform })),
                )
                .await,
        );
    }
    outputs.push(
        registry
            .dispatch(
                &control,
                "code-review:set-token",
                Some(json!({ "platform": "github", "token": NEW_GITHUB })),
            )
            .await,
    );
    t.flush(0).await;
    outputs.push(
        registry
            .dispatch(&notch, "code-review:get-state", None)
            .await,
    );
    outputs.push(
        registry
            .dispatch(
                &control,
                "code-review:clear",
                Some(json!({ "platform": "gitlab" })),
            )
            .await,
    );
    assert!(
        outputs.iter().all(|output| output["ok"] == json!(true)),
        "{outputs:?}"
    );
    // Every IPC answer, every event payload and every log line.
    let mut texts: Vec<String> = outputs.iter().map(Value::to_string).collect();
    texts.extend(
        t.emitted
            .lock()
            .unwrap()
            .iter()
            .map(|state| serde_json::to_string(state).unwrap()),
    );
    texts.extend(
        t.events()
            .iter()
            .map(|change| serde_json::to_string(change).unwrap()),
    );
    texts.extend(
        t.alerts()
            .iter()
            .map(|alert| serde_json::to_string(alert).unwrap()),
    );
    texts.extend(code_review_log());
    assert!(!t.alerts().is_empty());
    assert!(t.emitted.lock().unwrap().len() > 2);
    for text in &texts {
        for token in [STORED, NEW_GITHUB, GITLAB_TOKEN, "TOKEN"] {
            assert!(!text.contains(token), "{token} in {text}");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Fix round 1: emit order, stale timers, dispose

#[tokio::test]
async fn an_older_state_snapshot_that_reaches_the_emitter_last_is_dropped() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.status(GITHUB), PlatformStatus::Ok);
    // A: a publish decided under the lock (GitHub "ok") whose emit is delayed, as on another
    // runtime worker...
    let mut late = Vec::new();
    {
        let mut inner = t.integration.lock();
        t.integration.publish(&mut inner, &mut late);
    }
    // ...B: a clear decided after it, and emitted first.
    t.integration.clear(GITHUB).await;
    let emitted = t.emitted.lock().unwrap().len();
    assert_eq!(
        t.emitted.lock().unwrap().last().unwrap().github,
        unconfigured()
    );
    // A arrives last: its older snapshot never reaches the renderer.
    t.integration.run(late);
    assert_eq!(t.emitted.lock().unwrap().len(), emitted);
    assert_eq!(t.emitted.lock().unwrap().last().unwrap(), &t.state());
    // A newer publish still goes out.
    t.integration.set_token(GITHUB, "ghp_again", None).await;
    assert_eq!(
        t.emitted.lock().unwrap().last().unwrap().github.status,
        PlatformStatus::Ok
    );
}

#[tokio::test]
async fn an_older_contributions_event_that_reaches_the_emitter_last_is_dropped() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let (mut late, mut fresh) = (Vec::new(), Vec::new());
    {
        let mut inner = t.integration.lock();
        t.integration
            .emit_contributions(&mut inner, GITHUB, &mut late);
        inner.rt(GITHUB).contributions_error = true;
        t.integration
            .emit_contributions(&mut inner, GITHUB, &mut fresh);
        // Another platform has its own order.
        t.integration
            .emit_contributions(&mut inner, GITLAB_P, &mut late);
    }
    t.integration.run(fresh);
    t.integration.run(late);
    assert_eq!(
        t.events(),
        vec![changed(GITHUB, true), changed(GITLAB_P, false)]
    );
}

#[tokio::test]
async fn a_timer_that_fires_after_it_was_replaced_does_not_poll() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let client = t.last(GITHUB);
    assert_eq!(client.fetch_calls(), 1);
    // A callback whose timer was cleared or replaced meanwhile (fired in the race with `clear`).
    t.integration.timer_fired(GITHUB, Rhythm::Poll, u64::MAX);
    t.integration
        .timer_fired(GITHUB, Rhythm::Contributions, u64::MAX);
    t.flush(0).await;
    assert_eq!(client.fetch_calls(), 1);
    // The armed timer is untouched and still fires on time.
    t.flush(TICK_MS - 1).await;
    assert_eq!(client.fetch_calls(), 1);
    t.flush(1).await;
    assert_eq!(client.fetch_calls(), 2);
}

#[tokio::test]
async fn nothing_is_emitted_or_alerted_after_dispose() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let mut late = Vec::new();
    {
        let mut inner = t.integration.lock();
        t.integration.publish(&mut inner, &mut late);
        t.integration
            .emit_contributions(&mut inner, GITHUB, &mut late);
    }
    late.push(Effect::Alert(count_alert(GITHUB, 1)));
    let emitted = t.emitted.lock().unwrap().len();
    t.integration.dispose();
    t.integration.run(late);
    assert_eq!(t.emitted.lock().unwrap().len(), emitted);
    assert_eq!(t.events(), vec![]);
    assert_eq!(t.alerts(), vec![]);
}
