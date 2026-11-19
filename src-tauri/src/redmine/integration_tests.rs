//! Port of 0.1.0's `redmine-integration.test.ts` (51 cases, every `it.each` row as its
//! own test): a fake client, token store and settings; virtual timers stepped in due order; a
//! fixed wall clock in Europe/Madrid moved with them (Saturday 14 Nov 2026, 10:00). Plus the
//! Rust-only cases of the part-5 plan.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use chrono::{DateTime, Utc};
use tokio::sync::watch;

use super::*;
use crate::contract::redmine::{
    LogTimeInput, Named, RedmineActivity, RedmineIssue, RedmineIssueDetail, RedmineIssueList,
    RedmineSetKeyResult, RedmineState, RedmineStatus, RedmineSummaryChanged, RedmineSummaryResult,
    RedmineWriteError, RedmineWriteResult, SetKeyReason, SummaryDay, UpdateIssueInput,
};
use crate::contract::settings::{RedmineEndOfDaySettings, RedmineSettings};
use crate::http::{
    ApiError, HttpRequest, HttpResponse, ReqwestTransport, Transport, TransportError,
};
use crate::ipc::{BoxFuture, ExposedError, IpcErrorCode};
use crate::redmine::client::{
    IssuePatch, RedmineApiClient, RedmineClient, TimeEntry, TimeEntryInput, Viewer,
};
use crate::services::clock::WallClock;
use crate::services::timers::{TestTimers, Timers};

const URL_A: &str = "https://redmine.example.com/base";
const URL_B: &str = "https://other.example.com";
const KEY: &str = "SECRETKEY-123";
const SUBJECT: &str = "Confidential subject";
const MADRID: chrono_tz::Tz = chrono_tz::Europe::Madrid;
const HOUR_MS: i64 = 3_600_000;

type Integration = RedmineIntegration<chrono_tz::Tz>;
type Res<T> = Result<T, ApiError>;

/// A Madrid wall time as an instant (`new Date('YYYY-MM-DDTHH:mm:00')` under `TZ=Europe/Madrid`).
fn madrid(y: i32, m: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
    MADRID
        .with_ymd_and_hms(y, m, d, h, mi, 0)
        .unwrap()
        .with_timezone(&Utc)
}

fn start_time() -> DateTime<Utc> {
    madrid(2026, 11, 14, 10, 0)
}

fn ms(at: DateTime<Utc>) -> f64 {
    at.timestamp_millis() as f64
}

fn issue(id: u64) -> RedmineIssue {
    RedmineIssue {
        id,
        subject: format!("{SUBJECT} {id}"),
        project: "Hidden project".into(),
        status: Named {
            id: 2,
            name: "In progress".into(),
        },
        estimated_hours: None,
        spent_hours: None,
        updated_on: "2026-11-12T10:00:00Z".into(),
    }
}

fn detail(id: u64, allowed: Vec<Named>) -> RedmineIssueDetail {
    let issue = issue(id);
    RedmineIssueDetail {
        id: issue.id,
        subject: issue.subject,
        project: issue.project,
        status: issue.status,
        estimated_hours: issue.estimated_hours,
        spent_hours: issue.spent_hours,
        updated_on: issue.updated_on,
        allowed_statuses: allowed,
    }
}

fn done_status() -> Vec<Named> {
    vec![Named {
        id: 3,
        name: "Done".into(),
    }]
}

fn dev_activity() -> Vec<RedmineActivity> {
    vec![RedmineActivity {
        id: 9,
        name: "Dev".into(),
        is_default: true,
    }]
}

fn list(ids: &[u64]) -> RedmineIssueList {
    RedmineIssueList {
        issues: ids.iter().copied().map(issue).collect(),
        truncated: false,
    }
}

fn entry(date: &str, hours: f64) -> TimeEntry {
    TimeEntry {
        date: date.into(),
        hours,
    }
}

/// The fake's default `timeEntries`: `[1.5, 2.25]` on the day asked when `from == to`.
fn default_entries(from: &str, to: &str) -> Vec<TimeEntry> {
    if from == to {
        vec![entry(from, 1.5), entry(from, 2.25)]
    } else {
        vec![]
    }
}

fn refused_write(reason: RedmineWriteError) -> RedmineWriteResult {
    RedmineWriteResult::Refused {
        reason,
        messages: None,
    }
}

fn accepted(account: &str) -> RedmineSetKeyResult {
    RedmineSetKeyResult::Accepted {
        account: account.into(),
    }
}

fn refused(reason: SetKeyReason) -> RedmineSetKeyResult {
    RedmineSetKeyResult::Refused { reason }
}

fn update(
    id: u64,
    status_id: Option<u64>,
    estimated_hours: Option<Option<f64>>,
) -> UpdateIssueInput {
    UpdateIssueInput {
        id,
        status_id,
        estimated_hours,
    }
}

fn log_input(hours: f64) -> LogTimeInput {
    LogTimeInput {
        issue_id: 12,
        spent_on: "2026-11-14".into(),
        hours,
        activity_id: 9,
        comments: String::new(),
    }
}

fn unconfigured() -> RedmineState {
    RedmineState {
        status: RedmineStatus::Unconfigured,
        account: None,
        today_hours: None,
        updated_at: None,
        persistent: true,
    }
}

fn expect_error(error: &ExposedError, code: IpcErrorCode, message: &str) {
    assert_eq!(error.code(), code, "{error:?}");
    assert_eq!(error.message(), message);
}

// ---------------------------------------------------------------------------------------------
// Fake client (`vi.fn` mocks)

/// A mock's answer: now, or once the test resolves a [`Deferred`] (`deferred()` in the TS).
enum Reply<O> {
    Now(O),
    Later(watch::Receiver<Option<O>>, O),
}

async fn resolve<O: Clone>(reply: Reply<O>) -> O {
    match reply {
        Reply::Now(value) => value,
        Reply::Later(mut receiver, fallback) => {
            let value = receiver
                .wait_for(Option::is_some)
                .await
                .ok()
                .and_then(|value| Option::clone(&value));
            value.unwrap_or(fallback)
        }
    }
}

/// `deferred<T>()`: one promise several calls may share.
struct Deferred<O>(watch::Sender<Option<O>>);

impl<O> Deferred<O> {
    fn new() -> Self {
        Self(watch::channel(None).0)
    }

    fn resolve(&self, value: O) {
        self.0.send_replace(Some(value));
    }
}

impl<O: Clone> Deferred<O> {
    fn reply(&self, fallback: O) -> Reply<O> {
        Reply::Later(self.0.subscribe(), fallback)
    }
}

type Imp<A, O> = Arc<dyn Fn(&A) -> Reply<O> + Send + Sync>;

/// `vi.fn(impl)`: the calls, the `*Once` answers and the current implementation.
struct Mock<A, O> {
    calls: Vec<A>,
    once: VecDeque<Reply<O>>,
    imp: Imp<A, O>,
    /// What a pending answer gives if its deferred is dropped unresolved.
    fallback: O,
}

impl<A, O: Clone + Send + Sync + 'static> Mock<A, O> {
    fn new(fallback: O, imp: impl Fn(&A) -> O + Send + Sync + 'static) -> Self {
        Self {
            calls: Vec::new(),
            once: VecDeque::new(),
            imp: Arc::new(move |args| Reply::Now(imp(args))),
            fallback,
        }
    }

    fn call(&mut self, args: A) -> Reply<O> {
        self.calls.push(args);
        match self.once.pop_front() {
            Some(reply) => reply,
            None => (self.imp)(self.calls.last().expect("just pushed")),
        }
    }

    /// `mockResolvedValue` / `mockRejectedValue`.
    fn set(&mut self, value: O) {
        self.imp = Arc::new(move |_| Reply::Now(value.clone()));
    }

    /// `mockImplementation`.
    fn set_with(&mut self, imp: impl Fn(&A) -> Reply<O> + Send + Sync + 'static) {
        self.imp = Arc::new(imp);
    }

    /// `mockResolvedValueOnce` / `mockRejectedValueOnce`.
    fn once(&mut self, value: O) {
        self.once.push_back(Reply::Now(value));
    }

    /// `mockReturnValueOnce(pending.promise)`.
    fn once_later(&mut self) -> Deferred<O> {
        let deferred = Deferred::new();
        self.once.push_back(deferred.reply(self.fallback.clone()));
        deferred
    }

    fn count(&self) -> usize {
        self.calls.len()
    }
}

/// `timeEntries(from, to)`.
type EntriesMock = Mock<(String, String), Res<Vec<TimeEntry>>>;

struct FakeClient {
    base_url: Mutex<String>,
    viewer: Mutex<Mock<(), Res<Viewer>>>,
    issues: Mutex<Mock<(), Res<RedmineIssueList>>>,
    issue: Mutex<Mock<u64, Res<RedmineIssueDetail>>>,
    find_issue: Mutex<Mock<u64, Res<bool>>>,
    activities: Mutex<Mock<(), Res<Vec<RedmineActivity>>>>,
    update_issue: Mutex<Mock<(u64, IssuePatch), RedmineWriteResult>>,
    log_time: Mutex<Mock<TimeEntryInput, RedmineWriteResult>>,
    time_entries: Mutex<EntriesMock>,
}

impl FakeClient {
    fn new(base_url: &str) -> Self {
        fn network<T>() -> Res<T> {
            Err(ApiError::Network)
        }
        Self {
            base_url: Mutex::new(base_url.to_owned()),
            viewer: Mutex::new(Mock::new(network(), |_| {
                Ok(Viewer {
                    id: 7,
                    name: "Alice Doe".into(),
                })
            })),
            issues: Mutex::new(Mock::new(network(), |_| Ok(list(&[12, 13])))),
            issue: Mutex::new(Mock::new(network(), |id| Ok(detail(*id, done_status())))),
            find_issue: Mutex::new(Mock::new(network(), |_| Ok(true))),
            activities: Mutex::new(Mock::new(network(), |_| Ok(dev_activity()))),
            update_issue: Mutex::new(Mock::new(refused_write(RedmineWriteError::Network), |_| {
                RedmineWriteResult::Done
            })),
            log_time: Mutex::new(Mock::new(refused_write(RedmineWriteError::Network), |_| {
                RedmineWriteResult::Done
            })),
            time_entries: Mutex::new(Mock::new(network(), |(from, to): &(String, String)| {
                Ok(default_entries(from, to))
            })),
        }
    }

    fn issues_calls(&self) -> usize {
        self.issues.lock().unwrap().count()
    }

    fn viewer_calls(&self) -> usize {
        self.viewer.lock().unwrap().count()
    }

    fn entries_calls(&self) -> Vec<(String, String)> {
        self.time_entries.lock().unwrap().calls.clone()
    }

    /// Calls of `timeEntries` for a range (the summary), not a single day.
    fn ranged_calls(&self) -> usize {
        self.entries_calls()
            .iter()
            .filter(|(from, to)| from != to)
            .count()
    }

    fn update_calls(&self) -> Vec<(u64, IssuePatch)> {
        self.update_issue.lock().unwrap().calls.clone()
    }

    /// `client.issueUrl = …`: the integration must not use it (it builds the URL from settings).
    fn set_issue_base(&self, base: &str) {
        *self.base_url.lock().unwrap() = base.to_owned();
    }
}

impl RedmineApiClient for FakeClient {
    fn viewer(&self) -> BoxFuture<'_, Res<Viewer>> {
        let reply = self.viewer.lock().unwrap().call(());
        Box::pin(resolve(reply))
    }

    fn issues(&self) -> BoxFuture<'_, Res<RedmineIssueList>> {
        let reply = self.issues.lock().unwrap().call(());
        Box::pin(resolve(reply))
    }

    fn issue(&self, id: u64) -> BoxFuture<'_, Res<RedmineIssueDetail>> {
        let reply = self.issue.lock().unwrap().call(id);
        Box::pin(resolve(reply))
    }

    fn find_issue(&self, id: u64) -> BoxFuture<'_, Res<bool>> {
        let reply = self.find_issue.lock().unwrap().call(id);
        Box::pin(resolve(reply))
    }

    fn statuses(&self) -> BoxFuture<'_, Res<Vec<Named>>> {
        Box::pin(async { Ok(Vec::new()) })
    }

    fn activities(&self) -> BoxFuture<'_, Res<Vec<RedmineActivity>>> {
        let reply = self.activities.lock().unwrap().call(());
        Box::pin(resolve(reply))
    }

    fn time_entries<'a>(
        &'a self,
        from: &'a str,
        to: &'a str,
    ) -> BoxFuture<'a, Res<Vec<TimeEntry>>> {
        let reply = self
            .time_entries
            .lock()
            .unwrap()
            .call((from.to_owned(), to.to_owned()));
        Box::pin(resolve(reply))
    }

    fn update_issue(&self, id: u64, patch: IssuePatch) -> BoxFuture<'_, RedmineWriteResult> {
        let reply = self.update_issue.lock().unwrap().call((id, patch));
        Box::pin(resolve(reply))
    }

    fn log_time<'a>(&'a self, entry: &'a TimeEntryInput) -> BoxFuture<'a, RedmineWriteResult> {
        let reply = self.log_time.lock().unwrap().call(entry.clone());
        Box::pin(resolve(reply))
    }

    fn issue_url(&self, id: u64) -> String {
        format!("{}/issues/{id}", self.base_url.lock().unwrap())
    }
}

// ---------------------------------------------------------------------------------------------
// Fake token store and settings

struct FakeStore {
    stored: Mutex<Option<String>>,
    /// `load`, `save:<key>`, `clear`, in call order.
    ops: Mutex<Vec<String>>,
}

impl FakeStore {
    fn new(key: Option<&str>) -> Self {
        Self {
            stored: Mutex::new(key.map(str::to_owned)),
            ops: Mutex::new(Vec::new()),
        }
    }

    fn stored(&self) -> Option<String> {
        self.stored.lock().unwrap().clone()
    }

    fn ops(&self) -> Vec<String> {
        self.ops.lock().unwrap().clone()
    }

    fn count(&self, op: &str) -> usize {
        self.ops().iter().filter(|o| o.starts_with(op)).count()
    }

    fn saves(&self) -> Vec<String> {
        self.ops()
            .iter()
            .filter_map(|op| op.strip_prefix("save:").map(str::to_owned))
            .collect()
    }
}

impl TokenStore for FakeStore {
    fn load(&self) -> BoxFuture<'_, Result<Option<String>, String>> {
        self.ops.lock().unwrap().push("load".into());
        let key = self.stored();
        Box::pin(async move { Ok(key) })
    }

    fn save<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            self.ops.lock().unwrap().push(format!("save:{token}"));
            *self.stored.lock().unwrap() = Some(token.to_owned());
            Ok(())
        })
    }

    fn clear(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.ops.lock().unwrap().push("clear".into());
            *self.stored.lock().unwrap() = None;
            Ok(())
        })
    }

    fn persistent(&self) -> bool {
        true
    }
}

struct FakeSettings {
    current: Mutex<RedmineSettings>,
    update_fails: bool,
    /// The URLs `update` was called with.
    updates: Mutex<Vec<String>>,
    /// `onChange`'s listener: the integration under test.
    listener: Mutex<Weak<Integration>>,
}

impl FakeSettings {
    fn notify(&self) {
        let next = self.current.lock().unwrap().clone();
        let listener = self.listener.lock().unwrap().upgrade();
        if let Some(integration) = listener {
            integration.on_settings_changed(&next);
        }
    }

    fn updates(&self) -> Vec<String> {
        self.updates.lock().unwrap().clone()
    }
}

impl SettingsSource for FakeSettings {
    fn get(&self) -> RedmineSettings {
        self.current.lock().unwrap().clone()
    }

    fn update(&self, url: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.updates.lock().unwrap().push(url.clone());
            if self.update_fails {
                return Err("Error".into());
            }
            self.current.lock().unwrap().url = url;
            self.notify();
            Ok(())
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Harness

struct Setup {
    url: &'static str,
    key: Option<&'static str>,
    started: bool,
    update_fails: bool,
    now: DateTime<Utc>,
    /// A factory other than the fake one (the real client against a loopback port).
    factory: Option<ClientFactory>,
}

impl Default for Setup {
    fn default() -> Self {
        Self {
            url: URL_A,
            key: Some(KEY),
            started: true,
            update_fails: false,
            now: start_time(),
            factory: None,
        }
    }
}

type Prepare = Box<dyn Fn(&FakeClient, &str) + Send>;

struct Built {
    client: Arc<FakeClient>,
}

struct T {
    integration: Arc<Integration>,
    timers: Arc<TestTimers>,
    clock: Arc<WallClock>,
    settings: Arc<FakeSettings>,
    store: Arc<FakeStore>,
    clients: Arc<Mutex<Vec<Built>>>,
    /// Every factory call, `(baseUrl, key)` (also when a custom factory is used).
    factory_calls: Arc<Mutex<Vec<(String, String)>>>,
    prepare: Arc<Mutex<Prepare>>,
    emitted: Arc<Mutex<Vec<RedmineState>>>,
    summary_events: Arc<Mutex<Vec<RedmineSummaryChanged>>>,
    opened: Arc<Mutex<Vec<String>>>,
}

fn setup(options: Setup) -> T {
    // Installed before anything logs (the capture is process-wide).
    crate::services::test_log::capture().expect("the test logger");
    let timers = Arc::new(TestTimers::new());
    let clock = Arc::new(WallClock::fixed(options.now));
    let settings = Arc::new(FakeSettings {
        current: Mutex::new(RedmineSettings {
            url: options.url.into(),
            daily_target_hours: 8.0,
            end_of_day: RedmineEndOfDaySettings {
                enabled: true,
                time: "18:00".into(),
                sound: true,
            },
        }),
        update_fails: options.update_fails,
        updates: Mutex::new(Vec::new()),
        listener: Mutex::new(Weak::new()),
    });
    let store = Arc::new(FakeStore::new(options.key));
    let clients: Arc<Mutex<Vec<Built>>> = Arc::default();
    let factory_calls: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
    let prepare: Arc<Mutex<Prepare>> = Arc::new(Mutex::new(Box::new(|_, _| {})));
    let emitted: Arc<Mutex<Vec<RedmineState>>> = Arc::default();
    let summary_events: Arc<Mutex<Vec<RedmineSummaryChanged>>> = Arc::default();
    let opened: Arc<Mutex<Vec<String>>> = Arc::default();

    let fake: ClientFactory = {
        let clients = Arc::clone(&clients);
        let prepare = Arc::clone(&prepare);
        Arc::new(move |base_url: &str, key: &str| {
            let client = Arc::new(FakeClient::new(base_url));
            (prepare.lock().unwrap())(&client, key);
            clients.lock().unwrap().push(Built {
                client: Arc::clone(&client),
            });
            Some(client as Arc<dyn RedmineApiClient>)
        })
    };
    let inner = options.factory.unwrap_or(fake);
    let factory: ClientFactory = {
        let calls = Arc::clone(&factory_calls);
        Arc::new(move |base_url: &str, key: &str| {
            calls
                .lock()
                .unwrap()
                .push((base_url.to_owned(), key.to_owned()));
            inner(base_url, key)
        })
    };
    let deps = RedmineDeps {
        settings: Arc::clone(&settings) as Arc<dyn SettingsSource>,
        store: Arc::clone(&store) as Arc<dyn TokenStore>,
        client: factory,
        timers: Arc::clone(&timers) as Arc<dyn Timers>,
        clock: Arc::clone(&clock),
        spawn: Arc::new(|future| {
            tokio::spawn(future);
        }),
        emit: {
            let emitted = Arc::clone(&emitted);
            Arc::new(move |state: &RedmineState| emitted.lock().unwrap().push(state.clone()))
        },
        emit_summary: {
            let events = Arc::clone(&summary_events);
            Arc::new(move |change: &RedmineSummaryChanged| events.lock().unwrap().push(*change))
        },
        open_external: {
            let opened = Arc::clone(&opened);
            Arc::new(move |url: String| {
                opened.lock().unwrap().push(url);
                Box::pin(async { Ok(()) }) as BoxFuture<'static, Result<(), String>>
            })
        },
    };
    let integration = RedmineIntegration::new(deps, MADRID);
    *settings.listener.lock().unwrap() = Arc::downgrade(&integration);
    if options.started {
        integration.start();
    }
    T {
        integration,
        timers,
        clock,
        settings,
        store,
        clients,
        factory_calls,
        prepare,
        emitted,
        summary_events,
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
    fn set_prepare(&self, prepare: impl Fn(&FakeClient, &str) + Send + 'static) {
        *self.prepare.lock().unwrap() = Box::new(prepare);
    }

    /// `t.last()`: the last client built.
    fn last(&self) -> Arc<FakeClient> {
        self.clients
            .lock()
            .unwrap()
            .last()
            .map(|built| Arc::clone(&built.client))
            .expect("no client")
    }

    fn client_count(&self) -> usize {
        self.factory_calls.lock().unwrap().len()
    }

    fn factory_calls(&self) -> Vec<(String, String)> {
        self.factory_calls.lock().unwrap().clone()
    }

    fn state(&self) -> RedmineState {
        self.integration.state()
    }

    fn status(&self) -> RedmineStatus {
        self.state().status
    }

    fn emitted(&self) -> Vec<RedmineState> {
        self.emitted.lock().unwrap().clone()
    }

    fn last_emitted(&self) -> RedmineState {
        self.emitted().last().cloned().expect("an emitted state")
    }

    fn summary_events(&self) -> Vec<RedmineSummaryChanged> {
        self.summary_events.lock().unwrap().clone()
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

    /// `vi.setSystemTime`: moves the wall clock only (no timer fires).
    fn set_time(&self, at: DateTime<Utc>) {
        let now = self.clock.now();
        self.clock.advance((at - now).num_milliseconds());
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

    /// `changeUrl(url)`: a settings change from outside the integration.
    fn change_url(&self, url: &str) {
        self.settings.current.lock().unwrap().url = url.to_owned();
        self.settings.notify();
    }

    fn settings_url(&self) -> String {
        self.settings.get().url
    }

    async fn issue_ids(&self) -> Vec<u64> {
        self.integration
            .issues()
            .await
            .issues
            .iter()
            .map(|issue| issue.id)
            .collect()
    }
}

/// Starts an integration call in the background (a JS promise runs without being awaited).
fn spawn<O: Send + 'static>(
    integration: &Arc<Integration>,
    call: impl FnOnce(Arc<Integration>) -> BoxFuture<'static, O>,
) -> tokio::task::JoinHandle<O> {
    tokio::spawn(call(Arc::clone(integration)))
}

/// The redmine lines this test logged. The capture is shared by the whole test binary, but a
/// current-thread `#[tokio::test]` runs its spawned tasks and timer callbacks on its own thread,
/// so only this test's lines are kept.
fn redmine_log() -> Vec<String> {
    crate::services::test_log::capture()
        .expect("the test logger")
        .lines_of_this_thread()
        .into_iter()
        .filter(|line| line.contains(&format!("{LOG_TARGET} ")))
        .collect()
}

// ---------------------------------------------------------------------------------------------
// parseRedmineBaseOverride

#[test]
fn parse_override_accepts_only_an_exact_http_127_0_0_1_port_origin() {
    assert_eq!(parse_base_override(None), None);
    assert_eq!(parse_base_override(Some("")), None);
    assert_eq!(
        parse_base_override(Some("http://127.0.0.1:4321")).as_deref(),
        Some("http://127.0.0.1:4321")
    );
    // Trimmed, like the TS `raw.trim()`.
    assert_eq!(
        parse_base_override(Some(" http://127.0.0.1:4321\n")).as_deref(),
        Some("http://127.0.0.1:4321")
    );
    for bad in [
        "http://localhost:4321",
        "https://127.0.0.1:4321",
        "http://127.0.0.1:4321/",
        "http://127.0.0.1",
        "http://127.0.0.1:0",
        "http://127.0.0.1:70000",
        "http://evil.test",
    ] {
        assert_eq!(parse_base_override(Some(bad)), None, "{bad}");
    }
    // Only in dev/E2E builds.
    assert_eq!(
        base_override_from(true, Some("http://127.0.0.1:4321")).as_deref(),
        Some("http://127.0.0.1:4321")
    );
    assert_eq!(
        base_override_from(false, Some("http://127.0.0.1:4321")),
        None
    );
}

// ---------------------------------------------------------------------------------------------
// start and rhythm

#[tokio::test]
async fn is_unconfigured_without_a_key_and_never_builds_a_client() {
    let t = setup(Setup {
        key: None,
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.state(), unconfigured());
    assert_eq!(t.integration.today_hours(), None);
    t.flush(TICK_MS * 3).await;
    assert_eq!(t.client_count(), 0);
}

#[tokio::test]
async fn without_a_server_forgets_a_stored_key_and_stays_unconfigured() {
    let t = setup(Setup {
        url: "",
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.status(), RedmineStatus::Unconfigured);
    assert!(t.store.count("clear") > 0);
    assert_eq!(t.store.count("load"), 0);
    assert_eq!(t.client_count(), 0);
}

#[tokio::test]
async fn with_a_key_queries_at_once_account_issues_todays_hours_and_then_every_300_s() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.factory_calls(), [(URL_A.to_owned(), KEY.to_owned())]);
    let client = t.last();
    assert_eq!(client.viewer_calls(), 1);
    assert_eq!(client.issues_calls(), 1);
    assert_eq!(
        client.entries_calls(),
        [("2026-11-14".to_owned(), "2026-11-14".to_owned())]
    );
    assert_eq!(
        t.state(),
        RedmineState {
            status: RedmineStatus::Ok,
            account: Some("Alice Doe".into()),
            today_hours: Some(3.75),
            updated_at: Some(ms(t.clock.now())),
            persistent: true,
        }
    );
    assert_eq!(t.integration.today_hours(), Some(3.75));
    assert_eq!(t.last_emitted().today_hours, Some(3.75));
    // A reading from yesterday is no longer today's hours (the next poll brings the new day's).
    t.clock.advance(24 * HOUR_MS);
    assert_eq!(t.integration.today_hours(), None);
    t.clock.advance(-24 * HOUR_MS);
    t.flush(TICK_MS - 1).await;
    assert_eq!(client.issues_calls(), 1);
    t.flush(1).await;
    assert_eq!(client.issues_calls(), 2);
    assert_eq!(client.entries_calls().len(), 2);
    // The account is asked once per session.
    assert_eq!(client.viewer_calls(), 1);
}

#[tokio::test]
async fn sums_float_hours_without_noise() {
    let t = setup(Setup::default());
    t.set_prepare(|c, _| {
        c.time_entries
            .lock()
            .unwrap()
            .set(Ok(vec![entry("2026-11-14", 0.1), entry("2026-11-14", 0.2)]));
    });
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.integration.today_hours(), Some(0.3));
}

#[tokio::test]
async fn does_not_query_before_start() {
    let t = setup(Setup {
        started: false,
        ..Setup::default()
    });
    t.ready().await;
    t.flush(TICK_MS * 2).await;
    assert_eq!(t.last().issues_calls(), 0);
    t.integration.start();
    t.flush(0).await;
    assert_eq!(t.last().issues_calls(), 1);
}

#[tokio::test]
async fn manual_refresh_queries_at_once_at_most_every_5_s() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let client = t.last();
    t.integration.refresh();
    t.flush(0).await;
    assert_eq!(client.issues_calls(), 2);
    t.integration.refresh();
    t.flush(5_000 - 1_000).await;
    assert_eq!(client.issues_calls(), 2);
    t.integration.refresh();
    t.flush(1_000).await;
    t.integration.refresh();
    t.flush(0).await;
    assert_eq!(client.issues_calls(), 3);
    assert_eq!(MANUAL_REFRESH_MIN_MS, 5_000);
}

#[tokio::test]
async fn failures_go_offline_with_growing_waits_1_2_4_5_5_min_and_keep_the_last_data() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let client = t.last();
    client.issues.lock().unwrap().set(Err(ApiError::Network));
    t.flush(TICK_MS).await;
    let state = t.state();
    assert_eq!(state.status, RedmineStatus::Offline);
    assert_eq!(state.account.as_deref(), Some("Alice Doe"));
    assert_eq!(state.today_hours, Some(3.75));
    assert_eq!(t.integration.issues().await.issues.len(), 2);
    let mut calls = client.issues_calls();
    for wait in [
        BACKOFF_MS[0],
        BACKOFF_MS[1],
        BACKOFF_MS[2],
        BACKOFF_MS[3],
        BACKOFF_MS[3],
    ] {
        t.flush(wait - 1).await;
        assert_eq!(client.issues_calls(), calls);
        t.flush(1).await;
        calls += 1;
        assert_eq!(client.issues_calls(), calls);
    }
    client.issues.lock().unwrap().set(Ok(list(&[])));
    t.flush(BACKOFF_MS[3]).await;
    assert_eq!(t.status(), RedmineStatus::Ok);
    // Back to the normal rhythm.
    let calls = client.issues_calls();
    t.flush(TICK_MS).await;
    assert_eq!(client.issues_calls(), calls + 1);
}

#[tokio::test]
async fn offline_after_midnight_no_longer_reports_yesterdays_hours_as_todays() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.state().today_hours, Some(3.75));
    let client = t.last();
    client.issues.lock().unwrap().set(Err(ApiError::Network));
    t.set_time(madrid(2026, 11, 15, 9, 0));
    t.integration.refresh();
    t.flush(0).await;
    let state = t.state();
    assert_eq!(state.status, RedmineStatus::Offline);
    assert_eq!(state.account.as_deref(), Some("Alice Doe"));
    assert_eq!(state.today_hours, None);
    let last = t.last_emitted();
    assert_eq!(last.status, RedmineStatus::Offline);
    assert_eq!(last.today_hours, None);
    assert_eq!(t.integration.today_hours(), None);
}

#[tokio::test]
async fn a_rejected_key_turns_auth_error_hides_the_hours_and_stops_polling() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let client = t.last();
    client.time_entries.lock().unwrap().set(Err(ApiError::Auth));
    t.flush(TICK_MS).await;
    let state = t.state();
    assert_eq!(state.status, RedmineStatus::AuthError);
    assert_eq!(state.today_hours, None);
    assert_eq!(t.integration.today_hours(), None);
    assert!(t.integration.issues().await.issues.is_empty());
    let calls = client.issues_calls();
    t.integration.set_view_open(true);
    t.integration.refresh();
    t.flush(60 * 60_000).await;
    assert_eq!(client.issues_calls(), calls);
}

// ---------------------------------------------------------------------------------------------
// setKey and clear

#[tokio::test]
async fn validates_the_key_with_viewer_then_saves_the_normalized_url_and_the_key() {
    let t = setup(Setup {
        url: "",
        key: None,
        ..Setup::default()
    });
    t.ready().await;
    let result = t
        .integration
        .set_key(" https://redmine.example.com/base/ ", &format!(" {KEY} "))
        .await;
    assert_eq!(result, accepted("Alice Doe"));
    assert_eq!(t.factory_calls(), [(URL_A.to_owned(), KEY.to_owned())]);
    assert_eq!(t.settings.updates(), [URL_A]);
    assert_eq!(t.settings_url(), URL_A);
    assert_eq!(t.store.saves(), [KEY]);
    // `clear` (of the key left without a server, at load) never comes after the save.
    let ops = t.store.ops();
    let saved_at = ops.iter().position(|op| op.starts_with("save:")).unwrap();
    assert!(!ops[saved_at..].contains(&"clear".to_owned()), "{ops:?}");
    assert_eq!(t.store.stored().as_deref(), Some(KEY));
    t.flush(0).await;
    let state = t.state();
    assert_eq!(state.status, RedmineStatus::Ok);
    assert_eq!(state.account.as_deref(), Some("Alice Doe"));
    assert_eq!(state.today_hours, Some(3.75));
}

#[tokio::test]
async fn refuses_a_non_https_or_malformed_url_before_building_a_client() {
    let t = setup(Setup {
        url: "",
        key: None,
        ..Setup::default()
    });
    t.ready().await;
    for url in [
        "http://redmine.example.com",
        "https://u:p@redmine.example.com",
        "https://redmine.example.com/?q=1",
        "nope",
    ] {
        assert_eq!(
            t.integration.set_key(url, KEY).await,
            refused(SetKeyReason::Url),
            "{url}"
        );
    }
    assert_eq!(t.client_count(), 0);
    assert!(t.settings.updates().is_empty());
    assert!(t.store.saves().is_empty());
}

/// `it.each`: a `code` failure of the key check answers `reason` and saves nothing.
async fn a_failure_of_the_check_answers(code: ApiError, reason: SetKeyReason) {
    let t = setup(Setup {
        url: "",
        key: None,
        ..Setup::default()
    });
    t.set_prepare(move |c, _| c.viewer.lock().unwrap().set(Err(code)));
    t.ready().await;
    assert_eq!(t.integration.set_key(URL_A, KEY).await, refused(reason));
    assert!(t.settings.updates().is_empty());
    assert!(t.store.saves().is_empty());
    assert_eq!(t.status(), RedmineStatus::Unconfigured);
}

#[tokio::test]
async fn an_auth_failure_of_the_check_answers_auth_and_saves_nothing() {
    a_failure_of_the_check_answers(ApiError::Auth, SetKeyReason::Auth).await;
}

#[tokio::test]
async fn a_network_failure_of_the_check_answers_network_and_saves_nothing() {
    a_failure_of_the_check_answers(ApiError::Network, SetKeyReason::Network).await;
}

#[tokio::test]
async fn a_server_failure_of_the_check_answers_network_and_saves_nothing() {
    a_failure_of_the_check_answers(ApiError::Server, SetKeyReason::Network).await;
}

#[tokio::test]
async fn an_invalid_response_failure_of_the_check_answers_url_and_saves_nothing() {
    a_failure_of_the_check_answers(ApiError::InvalidResponse, SetKeyReason::Url).await;
}

#[tokio::test]
async fn a_url_that_cannot_be_saved_keeps_the_old_session_and_saves_no_key() {
    let t = setup(Setup {
        update_fails: true,
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    assert_eq!(
        t.integration.set_key(URL_B, "other-key").await,
        refused(SetKeyReason::Network)
    );
    assert!(t.store.saves().is_empty());
    let state = t.state();
    assert_eq!(state.status, RedmineStatus::Ok);
    assert_eq!(state.account.as_deref(), Some("Alice Doe"));
    // Memory stays in step with the settings: an outside change back to A is not a change.
    assert_eq!(t.settings_url(), URL_A);
    t.change_url(URL_A);
    assert_eq!(t.status(), RedmineStatus::Ok);
}

#[tokio::test]
async fn clear_forgets_the_session_and_the_stored_key() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.clear().await;
    assert_eq!(t.state(), unconfigured());
    assert_eq!(t.store.stored(), None);
    let client = t.last();
    let calls = client.issues_calls();
    t.flush(TICK_MS * 2).await;
    assert_eq!(client.issues_calls(), calls);
}

#[tokio::test]
async fn a_server_changed_from_outside_clears_the_key_and_restarts_the_session() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let client = t.last();
    t.change_url(URL_B);
    t.flush(0).await;
    assert_eq!(t.status(), RedmineStatus::Unconfigured);
    assert_eq!(t.store.stored(), None);
    let calls = client.issues_calls();
    t.flush(TICK_MS * 2).await;
    assert_eq!(client.issues_calls(), calls);
    assert_eq!(t.client_count(), 1);
    // A new key for the new server works as usual.
    assert_eq!(
        t.integration.set_key(URL_B, "new-key").await,
        accepted("Alice Doe")
    );
    assert_eq!(
        t.factory_calls().last().cloned(),
        Some((URL_B.to_owned(), "new-key".to_owned()))
    );
    assert_eq!(t.store.stored().as_deref(), Some("new-key"));
}

/// TS takes `startedIn` and `serverUrl` when the integration is created: a URL changed from
/// outside before the load task first runs must not build a client for the new server with the
/// old server's key.
#[tokio::test]
async fn a_server_changed_from_outside_before_the_key_loads_never_sends_the_key_to_it() {
    let t = setup(Setup::default());
    // The load task is spawned but has not run yet (current-thread runtime).
    t.change_url(URL_B);
    t.ready().await;
    t.flush(TICK_MS * 2).await;
    assert_eq!(t.client_count(), 0);
    assert_eq!(t.factory_calls(), []);
    assert_eq!(t.status(), RedmineStatus::Unconfigured);
    assert_eq!(t.state(), unconfigured());
    assert_eq!(t.store.stored(), None);
}

#[tokio::test]
async fn its_own_url_save_is_not_taken_for_an_outside_change() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    assert_eq!(
        t.integration.set_key(URL_B, "new-key").await,
        accepted("Alice Doe")
    );
    t.flush(0).await;
    assert_eq!(t.store.stored().as_deref(), Some("new-key"));
    assert_eq!(t.status(), RedmineStatus::Ok);
    assert_eq!(t.settings_url(), URL_B);
}

// ---------------------------------------------------------------------------------------------
// reads and writes

#[tokio::test]
async fn issue_and_activities_go_through_the_client_reads_fail_with_unavailable_when_not_connected()
{
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let read = t.integration.issue(12).await.unwrap();
    assert_eq!(read.id, 12);
    assert_eq!(read.allowed_statuses, done_status());
    assert_eq!(t.integration.activities().await.unwrap(), dev_activity());
    t.last().issue.lock().unwrap().once(Err(ApiError::Network));
    let error = t.integration.issue(12).await.unwrap_err();
    expect_error(
        &error,
        IpcErrorCode::Unavailable,
        "Redmine request failed: network",
    );
    let none = setup(Setup {
        key: None,
        ..Setup::default()
    });
    none.ready().await;
    let error = none.integration.issue(12).await.unwrap_err();
    expect_error(
        &error,
        IpcErrorCode::Unavailable,
        "Redmine is not connected",
    );
    let error = none.integration.activities().await.unwrap_err();
    expect_error(
        &error,
        IpcErrorCode::Unavailable,
        "Redmine is not connected",
    );
}

#[tokio::test]
async fn a_read_rejected_for_auth_turns_the_session_auth_error() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.last().activities.lock().unwrap().set(Err(ApiError::Auth));
    let error = t.integration.activities().await.unwrap_err();
    expect_error(&error, IpcErrorCode::Unavailable, "Redmine key rejected");
    assert_eq!(t.status(), RedmineStatus::AuthError);
}

#[tokio::test]
async fn a_successful_write_asks_again_for_issues_and_todays_hours_and_the_summary_with_the_view_open_and_publishes(
) {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    let client = t.last();
    let issues = client.issues_calls();
    let entries = client.entries_calls().len();
    let emitted = t.emitted().len();
    let summaries = t.summary_events().len();
    client
        .time_entries
        .lock()
        .unwrap()
        .set(Ok(vec![entry("2026-11-14", 5.5)]));
    // No flush: the refreshed state and summary are there when the write resolves.
    assert_eq!(
        t.integration.update_issue(update(12, Some(3), None)).await,
        RedmineWriteResult::Done
    );
    assert_eq!(
        client.update_calls(),
        [(
            12,
            IssuePatch {
                status_id: Some(3),
                estimated_hours: None
            }
        )]
    );
    assert_eq!(client.issues_calls(), issues + 1);
    // Today's hours and the month summary.
    assert_eq!(client.entries_calls().len(), entries + 2);
    assert!(t.emitted().len() > emitted);
    assert_eq!(t.integration.today_hours(), Some(5.5));
    assert_eq!(t.summary_events().len(), summaries + 1);

    assert_eq!(
        t.integration.log_time(log_input(1.0)).await,
        RedmineWriteResult::Done
    );
    assert_eq!(
        client.log_time.lock().unwrap().calls,
        [TimeEntryInput {
            issue_id: 12,
            spent_on: "2026-11-14".into(),
            hours: 1.0,
            activity_id: 9,
            comments: String::new(),
        }]
    );
    assert_eq!(client.issues_calls(), issues + 2);
}

#[tokio::test]
async fn passes_only_the_fields_given_to_update_issue_null_clears_the_estimate() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration
        .update_issue(update(12, None, Some(None)))
        .await;
    assert_eq!(
        t.last().update_calls(),
        [(
            12,
            IssuePatch {
                status_id: None,
                estimated_hours: Some(None)
            }
        )]
    );
}

#[tokio::test]
async fn a_403_on_a_write_keeps_the_session_ok_and_returns_forbidden_without_refreshing() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let client = t.last();
    client
        .update_issue
        .lock()
        .unwrap()
        .set(refused_write(RedmineWriteError::Forbidden));
    let issues = client.issues_calls();
    assert_eq!(
        t.integration.update_issue(update(12, Some(3), None)).await,
        refused_write(RedmineWriteError::Forbidden)
    );
    assert_eq!(t.status(), RedmineStatus::Ok);
    assert_eq!(client.issues_calls(), issues);
    let validation = RedmineWriteResult::Refused {
        reason: RedmineWriteError::Validation,
        messages: Some(vec!["Hours is invalid".into()]),
    };
    client.log_time.lock().unwrap().set(validation.clone());
    assert_eq!(t.integration.log_time(log_input(1.0)).await, validation);
    assert_eq!(t.status(), RedmineStatus::Ok);
}

#[tokio::test]
async fn a_401_on_a_write_turns_the_session_auth_error() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.last()
        .log_time
        .lock()
        .unwrap()
        .set(refused_write(RedmineWriteError::Auth));
    assert_eq!(
        t.integration.log_time(log_input(1.0)).await,
        refused_write(RedmineWriteError::Auth)
    );
    assert_eq!(t.status(), RedmineStatus::AuthError);
}

#[tokio::test]
async fn a_write_without_a_session_answers_auth_and_calls_nothing() {
    let t = setup(Setup {
        key: None,
        ..Setup::default()
    });
    t.ready().await;
    assert_eq!(
        t.integration.update_issue(update(12, Some(3), None)).await,
        refused_write(RedmineWriteError::Auth)
    );
    assert_eq!(t.client_count(), 0);
}

// ---------------------------------------------------------------------------------------------
// month summary

#[tokio::test]
async fn is_queried_only_with_the_view_open_at_once_then_every_900_s_and_stops_when_it_closes() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(SUMMARY_TICK_MS * 2).await;
    let client = t.last();
    assert_eq!(client.ranged_calls(), 0);
    assert_eq!(
        t.integration.summary().await,
        RedmineSummaryResult {
            summary: None,
            error: false
        }
    );

    t.integration.set_view_open(true);
    t.flush(0).await;
    assert_eq!(client.ranged_calls(), 1);
    assert_eq!(t.summary_events(), [RedmineSummaryChanged { error: false }]);
    t.flush(SUMMARY_TICK_MS - 1).await;
    assert_eq!(client.ranged_calls(), 1);
    t.flush(1).await;
    assert_eq!(client.ranged_calls(), 2);

    t.integration.set_view_open(false);
    t.flush(SUMMARY_TICK_MS * 3).await;
    assert_eq!(client.ranged_calls(), 2);
}

#[tokio::test]
async fn covers_the_1st_of_the_month_to_today_and_sums_today_the_week_from_monday_and_the_month() {
    let t = setup(Setup::default());
    t.set_prepare(|c, _| {
        c.time_entries.lock().unwrap().set_with(|(from, to)| {
            Reply::Now(Ok(if from == to {
                vec![entry(from, 2.0)]
            } else {
                vec![
                    entry("2026-11-02", 8.0),
                    entry("2026-11-09", 4.0),
                    entry("2026-11-09", 3.5),
                    entry("2026-11-13", 6.0),
                    entry("2026-11-14", 2.0),
                ]
            }))
        });
    });
    t.ready().await;
    t.flush(0).await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    assert!(t
        .last()
        .entries_calls()
        .contains(&("2026-11-01".to_owned(), "2026-11-14".to_owned())));
    let RedmineSummaryResult { summary, error } = t.integration.summary().await;
    assert!(!error);
    let summary = summary.expect("a summary");
    assert_eq!(summary.month, "2026-11");
    assert_eq!(summary.today, 2.0);
    assert_eq!(summary.week, 15.5);
    assert_eq!(summary.month_total, 23.5);
    assert_eq!(summary.days.len(), 14);
    assert_eq!(
        summary.days[0],
        SummaryDay {
            date: "2026-11-01".into(),
            hours: 0.0
        }
    );
    assert_eq!(
        summary.days.iter().find(|d| d.date == "2026-11-09"),
        Some(&SummaryDay {
            date: "2026-11-09".into(),
            hours: 7.5
        })
    );
}

#[tokio::test]
async fn starts_on_the_monday_of_the_week_when_it_falls_in_the_previous_month() {
    // Wednesday 2 Dec 2026: the week began on Monday 30 Nov.
    let t = setup(Setup {
        now: madrid(2026, 12, 2, 10, 0),
        ..Setup::default()
    });
    t.set_prepare(|c, _| {
        c.time_entries.lock().unwrap().set_with(|(from, to)| {
            Reply::Now(Ok(if from == to {
                vec![]
            } else {
                vec![entry("2026-11-30", 4.0), entry("2026-12-01", 3.0)]
            }))
        });
    });
    t.ready().await;
    t.flush(0).await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    assert!(t
        .last()
        .entries_calls()
        .contains(&("2026-11-30".to_owned(), "2026-12-02".to_owned())));
    let summary = t.integration.summary().await.summary.expect("a summary");
    assert_eq!(summary.month, "2026-12");
    assert_eq!(summary.today, 0.0);
    assert_eq!(summary.week, 7.0);
    assert_eq!(summary.month_total, 3.0);
    let dates: Vec<&str> = summary.days.iter().map(|d| d.date.as_str()).collect();
    assert_eq!(dates, ["2026-12-01", "2026-12-02"]);
}

#[tokio::test]
async fn a_failed_query_keeps_the_last_summary_and_flags_the_error() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    let client = t.last();
    client.time_entries.lock().unwrap().set_with(|(from, to)| {
        Reply::Now(if from == to {
            Ok(vec![])
        } else {
            Err(ApiError::Server)
        })
    });
    t.flush(SUMMARY_TICK_MS).await;
    let result = t.integration.summary().await;
    assert!(result.error);
    assert!(result.summary.is_some());
    assert_eq!(
        t.summary_events().last(),
        Some(&RedmineSummaryChanged { error: true })
    );
    assert_eq!(t.status(), RedmineStatus::Ok);
}

// ---------------------------------------------------------------------------------------------
// find_issue

#[tokio::test]
async fn find_issue_found_marks_it_readable() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    // Not in the list sent and never read: not openable yet.
    expect_error(
        &t.integration.open(99).unwrap_err(),
        IpcErrorCode::InvalidInput,
        "Unknown issue",
    );
    assert!(t.integration.find_issue(99).await.unwrap());
    t.integration.open(99).unwrap();
    t.flush(0).await;
    assert_eq!(t.opened(), [format!("{URL_A}/issues/99")]);
    // The detail loads afterwards through the existing read.
    assert_eq!(t.integration.issue(99).await.unwrap().id, 99);
}

#[tokio::test]
async fn find_issue_forbidden_is_not_found_and_keeps_the_session() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.last().find_issue.lock().unwrap().once(Ok(false));
    assert!(!t.integration.find_issue(99).await.unwrap());
    assert_eq!(t.status(), RedmineStatus::Ok);
    // Not marked readable, and the session still serves reads.
    expect_error(
        &t.integration.open(99).unwrap_err(),
        IpcErrorCode::InvalidInput,
        "Unknown issue",
    );
    assert_eq!(t.integration.issue(12).await.unwrap().id, 12);
}

#[tokio::test]
async fn find_issue_missing_is_not_found() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.last().find_issue.lock().unwrap().once(Ok(false));
    assert!(!t.integration.find_issue(404).await.unwrap());
    assert_eq!(t.status(), RedmineStatus::Ok);
    expect_error(
        &t.integration.open(404).unwrap_err(),
        IpcErrorCode::InvalidInput,
        "Unknown issue",
    );
}

#[tokio::test]
async fn find_issue_unauthorized_ends_the_session() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.last()
        .find_issue
        .lock()
        .unwrap()
        .once(Err(ApiError::Auth));
    let error = t.integration.find_issue(99).await.unwrap_err();
    expect_error(&error, IpcErrorCode::Unavailable, "Redmine key rejected");
    assert_eq!(t.status(), RedmineStatus::AuthError);
}

#[tokio::test]
async fn find_issue_network_failure_is_unavailable_and_keeps_the_session() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.last()
        .find_issue
        .lock()
        .unwrap()
        .once(Err(ApiError::Network));
    let error = t.integration.find_issue(99).await.unwrap_err();
    expect_error(
        &error,
        IpcErrorCode::Unavailable,
        "Redmine request failed: network",
    );
    assert_eq!(t.status(), RedmineStatus::Ok);
}

// ---------------------------------------------------------------------------------------------
// open

#[tokio::test]
async fn opens_only_issues_of_the_last_list_sent_on_the_configured_server() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    expect_error(
        &t.integration.open(12).unwrap_err(),
        IpcErrorCode::InvalidInput,
        "Unknown issue",
    );
    t.integration.issues().await;
    t.integration.open(12).unwrap();
    t.flush(0).await;
    assert_eq!(t.opened(), [format!("{URL_A}/issues/12")]);
    expect_error(
        &t.integration.open(99).unwrap_err(),
        IpcErrorCode::InvalidInput,
        "Unknown issue",
    );
    assert_eq!(t.opened().len(), 1);
}

#[tokio::test]
async fn opens_an_issue_read_with_issue_id_even_after_it_left_the_open_list_eg_closed() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.issues().await;
    t.integration.issue(12).await.unwrap();
    // The issue is closed: the next list no longer has it.
    t.last().issues.lock().unwrap().set(Ok(list(&[13])));
    t.integration.refresh();
    t.flush(0).await;
    assert_eq!(t.issue_ids().await, [13]);
    t.integration.open(12).unwrap();
    t.flush(0).await;
    assert_eq!(t.opened(), [format!("{URL_A}/issues/12")]);
    // A read issue still goes through the origin check, against the settings URL: the client's
    // own `issue_url` (a loopback base under the dev override) is never used (ruling: the TS
    // case pointed `issueUrl` elsewhere and expected a refusal; here the URL cannot leave the
    // configured server, so the same id opens on it).
    t.integration.issue(55).await.unwrap();
    t.last().set_issue_base("https://evil.example.com");
    t.integration.open(55).unwrap();
    t.flush(0).await;
    assert_eq!(
        t.opened(),
        [format!("{URL_A}/issues/12"), format!("{URL_A}/issues/55")]
    );
    // A new session forgets the ids read before.
    t.integration.clear().await;
    expect_error(
        &t.integration.open(12).unwrap_err(),
        IpcErrorCode::InvalidInput,
        "Unknown issue",
    );
    expect_error(
        &t.integration.open(55).unwrap_err(),
        IpcErrorCode::InvalidInput,
        "Unknown issue",
    );
    assert_eq!(t.opened().len(), 2);
}

#[tokio::test]
async fn refuses_an_issue_url_outside_the_configured_origin() {
    // The client's URL pointing elsewhere changes nothing: the URL comes from the settings.
    let t = setup(Setup::default());
    t.set_prepare(|c, _| c.set_issue_base("https://evil.example.com"));
    t.ready().await;
    t.flush(0).await;
    t.integration.issues().await;
    t.integration.open(12).unwrap();
    t.flush(0).await;
    assert_eq!(t.opened(), [format!("{URL_A}/issues/12")]);
    // A server whose origin is not https (never stored by the settings validation) opens nothing.
    let t = setup(Setup {
        url: "http://redmine.example.com",
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    t.integration.issues().await;
    expect_error(
        &t.integration.open(12).unwrap_err(),
        IpcErrorCode::InvalidInput,
        "Issue URL not allowed",
    );
    t.flush(0).await;
    assert!(t.opened().is_empty());
}

// ---------------------------------------------------------------------------------------------
// privacy and lifecycle

const SECRETS: [&str; 9] = [
    "SECRETKEY",
    "Confidential",
    "Hidden project",
    "Alice",
    "redmine.example",
    "other.example",
    "evil.example",
    "In progress",
    "late-key",
];

fn assert_no_secret(lines: &[String], extra: &[&str]) {
    for line in lines {
        for secret in SECRETS.iter().chain(extra) {
            assert!(!line.contains(secret), "{secret} in {line}");
        }
    }
}

#[tokio::test]
async fn never_logs_the_key_subjects_projects_the_account_or_urls() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.last().issues.lock().unwrap().once(Err(ApiError::Network));
    t.flush(TICK_MS).await;
    t.integration.set_key(URL_B, "SECRETKEY-other").await;
    t.integration.issues().await;
    t.integration.open(12).unwrap();
    t.integration.update_issue(update(12, Some(3), None)).await;
    t.integration.clear().await;
    let log = redmine_log();
    assert!(!log.is_empty());
    assert_no_secret(&log, &[]);
}

#[tokio::test]
async fn dispose_stops_every_timer() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    let client = t.last();
    let calls = client.entries_calls().len();
    t.integration.dispose();
    t.flush(SUMMARY_TICK_MS * 4).await;
    assert_eq!(client.entries_calls().len(), calls);
    assert_eq!(t.timers.next_due_in(), None);
}

// ---------------------------------------------------------------------------------------------
// stale results are dropped (each `it.each` row × the 3 endings)

/// Ways a session ends while a request is pending.
#[derive(Clone, Copy)]
enum Ending {
    Clear,
    UrlChange,
    Dispose,
}

async fn end(t: &T, ending: Ending) {
    match ending {
        Ending::Clear => t.integration.clear().await,
        Ending::UrlChange => t.change_url(URL_B),
        Ending::Dispose => t.integration.dispose(),
    }
}

async fn a_poll_that_resolves_after_publishes_nothing(ending: Ending) {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let client = t.last();
    let pending = client.issues.lock().unwrap().once_later();
    t.integration.refresh();
    t.flush(0).await;
    end(&t, ending).await;
    t.flush(0).await;
    let emitted = t.emitted().len();
    let before = t.state();
    pending.resolve(Ok(list(&[99])));
    t.flush(0).await;
    assert_eq!(t.emitted().len(), emitted);
    assert_eq!(t.state(), before);
}

#[tokio::test]
async fn a_poll_that_resolves_after_clear_publishes_nothing() {
    a_poll_that_resolves_after_publishes_nothing(Ending::Clear).await;
}

#[tokio::test]
async fn a_poll_that_resolves_after_an_external_url_change_publishes_nothing() {
    a_poll_that_resolves_after_publishes_nothing(Ending::UrlChange).await;
}

#[tokio::test]
async fn a_poll_that_resolves_after_dispose_publishes_nothing() {
    a_poll_that_resolves_after_publishes_nothing(Ending::Dispose).await;
}

async fn a_summary_that_resolves_after_is_not_kept_or_announced(ending: Ending) {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let client = t.last();
    let pending: Deferred<Res<Vec<TimeEntry>>> = Deferred::new();
    let receiver = pending.0.subscribe();
    client
        .time_entries
        .lock()
        .unwrap()
        .set_with(move |(from, to)| {
            if from == to {
                Reply::Now(Ok(vec![]))
            } else {
                Reply::Later(receiver.clone(), Err(ApiError::Network))
            }
        });
    t.integration.set_view_open(true);
    t.flush(0).await;
    end(&t, ending).await;
    t.flush(0).await;
    let events = t.summary_events().len();
    pending.resolve(Ok(vec![entry("2026-11-14", 3.0)]));
    t.flush(0).await;
    assert_eq!(t.summary_events().len(), events);
    assert_eq!(
        t.integration.summary().await,
        RedmineSummaryResult {
            summary: None,
            error: false
        }
    );
}

#[tokio::test]
async fn a_summary_that_resolves_after_clear_is_not_kept_or_announced() {
    a_summary_that_resolves_after_is_not_kept_or_announced(Ending::Clear).await;
}

#[tokio::test]
async fn a_summary_that_resolves_after_an_external_url_change_is_not_kept_or_announced() {
    a_summary_that_resolves_after_is_not_kept_or_announced(Ending::UrlChange).await;
}

#[tokio::test]
async fn a_summary_that_resolves_after_dispose_is_not_kept_or_announced() {
    a_summary_that_resolves_after_is_not_kept_or_announced(Ending::Dispose).await;
}

async fn a_write_that_resolves_after_refreshes_and_publishes_nothing(ending: Ending) {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let client = t.last();
    let pending = client.update_issue.lock().unwrap().once_later();
    let result = spawn(&t.integration, |i| {
        Box::pin(async move { i.update_issue(update(12, Some(3), None)).await })
    });
    t.flush(0).await;
    end(&t, ending).await;
    t.flush(0).await;
    let issues = client.issues_calls();
    let emitted = t.emitted().len();
    let before = t.state();
    pending.resolve(RedmineWriteResult::Done);
    assert_eq!(result.await.unwrap(), RedmineWriteResult::Done);
    t.flush(0).await;
    assert_eq!(client.issues_calls(), issues);
    assert_eq!(t.emitted().len(), emitted);
    assert_eq!(t.state(), before);
}

#[tokio::test]
async fn a_write_that_resolves_after_clear_refreshes_and_publishes_nothing() {
    a_write_that_resolves_after_refreshes_and_publishes_nothing(Ending::Clear).await;
}

#[tokio::test]
async fn a_write_that_resolves_after_an_external_url_change_refreshes_and_publishes_nothing() {
    a_write_that_resolves_after_refreshes_and_publishes_nothing(Ending::UrlChange).await;
}

#[tokio::test]
async fn a_write_that_resolves_after_dispose_refreshes_and_publishes_nothing() {
    a_write_that_resolves_after_refreshes_and_publishes_nothing(Ending::Dispose).await;
}

async fn a_key_check_that_resolves_after_saves_nothing(ending: Ending) {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let pending: Arc<Deferred<Res<Viewer>>> = Arc::new(Deferred::new());
    {
        let pending = Arc::clone(&pending);
        t.set_prepare(move |c, _| {
            let mut viewer = c.viewer.lock().unwrap();
            let reply = pending.reply(Err(ApiError::Network));
            viewer.once.push_back(reply);
        });
    }
    let result = spawn(&t.integration, |i| {
        Box::pin(async move { i.set_key(URL_A, "late-key").await })
    });
    t.flush(0).await;
    end(&t, ending).await;
    t.flush(0).await;
    let emitted = t.emitted().len();
    let before = t.state();
    pending.resolve(Ok(Viewer {
        id: 7,
        name: "Late".into(),
    }));
    assert_eq!(result.await.unwrap(), refused(SetKeyReason::Network));
    t.flush(0).await;
    assert!(t.store.saves().is_empty());
    assert_ne!(t.store.stored().as_deref(), Some("late-key"));
    assert_eq!(t.emitted().len(), emitted);
    assert_eq!(t.state(), before);
    assert_ne!(t.state().account.as_deref(), Some("Late"));
}

#[tokio::test]
async fn a_key_check_that_resolves_after_clear_saves_nothing() {
    a_key_check_that_resolves_after_saves_nothing(Ending::Clear).await;
}

#[tokio::test]
async fn a_key_check_that_resolves_after_an_external_url_change_saves_nothing() {
    a_key_check_that_resolves_after_saves_nothing(Ending::UrlChange).await;
}

#[tokio::test]
async fn a_key_check_that_resolves_after_dispose_saves_nothing() {
    a_key_check_that_resolves_after_saves_nothing(Ending::Dispose).await;
}

async fn a_read_that_resolves_after_is_refused_as_unavailable(ending: Ending) {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let client = t.last();
    let detail_later = client.issue.lock().unwrap().once_later();
    let activities_later = client.activities.lock().unwrap().once_later();
    let pending_detail = spawn(&t.integration, |i| {
        Box::pin(async move { i.issue(12).await })
    });
    let pending_activities = spawn(&t.integration, |i| {
        Box::pin(async move { i.activities().await })
    });
    t.flush(0).await;
    end(&t, ending).await;
    detail_later.resolve(Ok(detail(12, vec![])));
    activities_later.resolve(Ok(dev_activity()));
    let error = pending_detail.await.unwrap().unwrap_err();
    expect_error(&error, IpcErrorCode::Unavailable, "Redmine session changed");
    let error = pending_activities.await.unwrap().unwrap_err();
    expect_error(&error, IpcErrorCode::Unavailable, "Redmine session changed");
    // Nothing read in an ended session can be opened.
    assert!(t.integration.open(12).is_err());
}

#[tokio::test]
async fn a_read_that_resolves_after_clear_is_refused_as_unavailable() {
    a_read_that_resolves_after_is_refused_as_unavailable(Ending::Clear).await;
}

#[tokio::test]
async fn a_read_that_resolves_after_an_external_url_change_is_refused_as_unavailable() {
    a_read_that_resolves_after_is_refused_as_unavailable(Ending::UrlChange).await;
}

#[tokio::test]
async fn a_read_that_resolves_after_dispose_is_refused_as_unavailable() {
    a_read_that_resolves_after_is_refused_as_unavailable(Ending::Dispose).await;
}

// ---------------------------------------------------------------------------------------------
// Rust-only cases of the part-5 plan

/// The fake Redmine answers until `fail` is set; then every request goes to the real
/// [`ReqwestTransport`] aimed at a closed loopback port (a VPN that went down: connect refused).
struct Switch {
    real: ReqwestTransport,
    closed: String,
    fail: AtomicBool,
    real_requests: AtomicUsize,
}

impl Transport for Switch {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, TransportError>> {
        if !self.fail.load(Ordering::SeqCst) {
            let path = request
                .url
                .split_once("127.0.0.1")
                .map(|(_, rest)| rest.to_owned())
                .unwrap_or_default();
            let body = if path.contains("/users/current.json") {
                r#"{"user":{"id":7,"login":"alice","firstname":"Alice","lastname":"Doe"}}"#
                    .to_owned()
            } else if path.contains("/issues.json") {
                format!(
                    r#"{{"issues":[{{"id":12,"subject":"{SUBJECT}","project":{{"id":1,"name":"Hidden project"}},"status":{{"id":2,"name":"In progress"}},"updated_on":"2026-11-12T10:00:00Z"}}],"total_count":1}}"#
                )
            } else if path.contains("/time_entries.json") {
                r#"{"time_entries":[{"spent_on":"2026-11-14","hours":2.5}],"total_count":1}"#
                    .to_owned()
            } else {
                "{}".to_owned()
            };
            let response = HttpResponse::new(200).with_body(body.into_bytes());
            return Box::pin(async move { Ok(response) });
        }
        self.real_requests.fetch_add(1, Ordering::SeqCst);
        // Same path and headers, on the closed port.
        let mut request = request;
        if let Some((_, rest)) = request.url.split_once("127.0.0.1:") {
            let path = rest.find('/').map_or("", |at| &rest[at..]);
            request.url = format!("{}{path}", self.closed);
        }
        self.real.send(request)
    }
}

/// Waits (real time) until `done` holds, at most 20 s.
async fn eventually(what: &str, done: impl Fn() -> bool) {
    for _ in 0..2_000 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn offline_when_redmine_unreachable_keeps_last_data() {
    // A port nothing listens on any more.
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port())
    };
    let switch = Arc::new(Switch {
        real: ReqwestTransport::with_limits(Duration::from_secs(10), 1 << 20).unwrap(),
        closed: closed.clone(),
        fail: AtomicBool::new(false),
        real_requests: AtomicUsize::new(0),
    });
    // The dev override: the settings keep the https URL, the client talks to 127.0.0.1.
    let factory: ClientFactory = {
        let switch = Arc::clone(&switch);
        let closed = closed.clone();
        Arc::new(move |_base_url: &str, key: &str| {
            RedmineClient::new_allowing_loopback_http(
                Arc::clone(&switch) as Arc<dyn Transport>,
                closed.clone(),
                key,
            )
            .ok()
            .map(|client| Arc::new(client) as Arc<dyn RedmineApiClient>)
        })
    };
    let t = setup(Setup {
        factory: Some(factory),
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    eventually("the first poll", || t.status() == RedmineStatus::Ok).await;
    let first = t.state();
    assert_eq!(first.account.as_deref(), Some("Alice Doe"));
    assert_eq!(first.today_hours, Some(2.5));
    assert_eq!(t.issue_ids().await, [12]);

    // The VPN goes down: every request is refused by the OS.
    switch.fail.store(true, Ordering::SeqCst);
    t.flush(TICK_MS).await;
    let mut before = 0;
    for wait in BACKOFF_MS.into_iter().chain([BACKOFF_MS[3]]) {
        // The failed poll (issues and today's entries at once) goes offline and waits 1, 2, 4,
        // 5, 5 min.
        eventually("the backoff timer", || t.timers.next_due_in() == Some(wait)).await;
        let sent = switch.real_requests.load(Ordering::SeqCst);
        assert!(sent > before, "{sent} real requests after {before}");
        before = sent;
        let offline = t.state();
        assert_eq!(offline.status, RedmineStatus::Offline);
        assert_eq!(offline.account, first.account);
        assert_eq!(offline.today_hours, first.today_hours);
        assert_eq!(offline.updated_at, first.updated_at);
        assert_eq!(t.issue_ids().await, [12]);
        assert_eq!(t.integration.today_hours(), Some(2.5));
        t.flush(wait - 1).await;
        assert_eq!(t.timers.next_due_in(), Some(1));
        t.flush(1).await;
    }
    eventually("the last backoff", || {
        t.timers.next_due_in() == Some(BACKOFF_MS[3])
    })
    .await;
    // Saving a key with the VPN down: `network`, and the session is untouched.
    assert_eq!(
        t.integration.set_key(URL_A, "another-key").await,
        refused(SetKeyReason::Network)
    );
    assert_eq!(t.status(), RedmineStatus::Offline);
    assert_eq!(t.store.stored().as_deref(), Some(KEY));
    assert!(redmine_log()
        .iter()
        .any(|line| line.contains("Redmine query failed code=network retryInMs=60000")));
    // Back online: it recovers on its own at the next try.
    switch.fail.store(false, Ordering::SeqCst);
    t.flush(BACKOFF_MS[3]).await;
    eventually("the recovery", || t.status() == RedmineStatus::Ok).await;
    eventually("the normal rhythm", || {
        t.timers.next_due_in() == Some(TICK_MS)
    })
    .await;
}

#[tokio::test]
async fn an_older_state_snapshot_that_reaches_the_emitter_last_is_dropped() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.status(), RedmineStatus::Ok);
    // A: a publish decided under the lock ("ok") whose emit is delayed, as on another runtime
    // worker...
    let mut late = Vec::new();
    {
        let mut inner = t.integration.lock();
        t.integration.publish(&mut inner, &mut late);
    }
    // ...B: a clear decided after it, and emitted first.
    t.integration.clear().await;
    let emitted = t.emitted().len();
    assert_eq!(t.last_emitted(), unconfigured());
    // A arrives last: its older snapshot never reaches the renderer.
    t.integration.run(late);
    assert_eq!(t.emitted().len(), emitted);
    assert_eq!(t.last_emitted(), t.state());
    // A newer publish still goes out.
    t.integration.set_key(URL_A, "again").await;
    assert_eq!(t.last_emitted().status, RedmineStatus::Ok);
}

#[tokio::test]
async fn an_older_summary_event_that_reaches_the_emitter_last_is_dropped() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let (mut late, mut fresh) = (Vec::new(), Vec::new());
    {
        let mut inner = t.integration.lock();
        t.integration.emit_summary(&mut inner, &mut late);
        inner.summary_error = true;
        t.integration.emit_summary(&mut inner, &mut fresh);
    }
    t.integration.run(fresh);
    t.integration.run(late);
    assert_eq!(t.summary_events(), [RedmineSummaryChanged { error: true }]);
}

#[tokio::test]
async fn a_timer_that_fires_after_it_was_replaced_does_not_poll() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    let client = t.last();
    assert_eq!(client.issues_calls(), 1);
    assert_eq!(client.ranged_calls(), 1);
    t.integration.timer_fired(Rhythm::Poll, u64::MAX);
    t.integration.timer_fired(Rhythm::Summary, u64::MAX);
    t.flush(0).await;
    assert_eq!(client.issues_calls(), 1);
    assert_eq!(client.ranged_calls(), 1);
    t.flush(TICK_MS - 1).await;
    assert_eq!(client.issues_calls(), 1);
    t.flush(1).await;
    assert_eq!(client.issues_calls(), 2);
}

#[tokio::test]
async fn nothing_is_emitted_after_dispose() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let mut late = Vec::new();
    {
        let mut inner = t.integration.lock();
        t.integration.publish(&mut inner, &mut late);
        t.integration.emit_summary(&mut inner, &mut late);
    }
    let emitted = t.emitted().len();
    t.integration.dispose();
    t.integration.run(late);
    assert_eq!(t.emitted().len(), emitted);
    assert!(t.summary_events().is_empty());
    // Calls after dispose publish nothing either.
    t.integration.refresh();
    t.integration.set_view_open(true);
    t.integration.clear().await;
    t.flush(TICK_MS).await;
    assert_eq!(t.emitted().len(), emitted);
}

#[tokio::test]
async fn no_redmine_log_carries_key_subject_or_host() {
    const COMMENT: &str = "Private comment about the client";
    let t = setup(Setup::default());
    t.set_prepare(|c, _| {
        c.issues.lock().unwrap().once(Ok(list(&[12, 13])));
        c.issues.lock().unwrap().once(Err(ApiError::Server));
        c.issue.lock().unwrap().once(Err(ApiError::InvalidResponse));
    });
    t.ready().await;
    t.flush(0).await;
    t.flush(TICK_MS).await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    t.last()
        .time_entries
        .lock()
        .unwrap()
        .set_with(|(from, to)| {
            Reply::Now(if from == to {
                Ok(vec![])
            } else {
                Err(ApiError::RateLimited)
            })
        });
    t.flush(SUMMARY_TICK_MS).await;
    t.integration.issues().await;
    let _ = t.integration.issue(12).await;
    t.integration.issue(12).await.unwrap();
    t.integration.open(12).unwrap();
    assert!(t.integration.open(4012).is_err());
    let mut log = log_input(1.5);
    log.comments = COMMENT.into();
    t.integration.log_time(log).await;
    t.last()
        .update_issue
        .lock()
        .unwrap()
        .once(RedmineWriteResult::Refused {
            reason: RedmineWriteError::Validation,
            messages: Some(vec!["Subject Confidential is invalid".into()]),
        });
    t.integration.update_issue(update(12, Some(3), None)).await;
    // A key check that fails, one that passes on a new server, and an outside server change.
    t.set_prepare(|c, key| {
        if key == "SECRETKEY-bad" {
            c.viewer.lock().unwrap().set(Err(ApiError::Auth));
        }
    });
    t.integration.set_key(URL_B, "SECRETKEY-bad").await;
    t.integration.set_key(URL_B, "SECRETKEY-other").await;
    t.flush(0).await;
    t.change_url("https://third.example.org/redmine");
    t.flush(0).await;
    t.integration.clear().await;
    let log = redmine_log();
    assert!(log.len() >= 8, "{log:?}");
    assert!(log.iter().all(|line| line.contains("redmine")));
    assert_no_secret(
        &log,
        &[
            KEY,
            COMMENT,
            "third.example",
            "/issues/",
            "alice",
            "Private",
        ],
    );
    // Only `key=value` pairs after the fixed message.
    assert!(log
        .iter()
        .any(|line| line.contains("Redmine write what=log-time result=ok")));
    assert!(log
        .iter()
        .any(|line| line.contains("Redmine read failed what=issue code=invalid-response")));
    assert!(log
        .iter()
        .any(|line| line.contains("Redmine summary query failed code=rate-limited")));
    assert!(log
        .iter()
        .any(|line| line.contains("Redmine key check failed code=auth")));
}

#[tokio::test]
async fn the_wall_clock_dates_the_poll_and_today_hours_follow_the_local_day() {
    // 23:30 local on Saturday: still the 14th in Madrid, the 14th in UTC too; 00:30 on Sunday
    // is the 15th in Madrid but still the 14th in UTC.
    let t = setup(Setup {
        now: madrid(2026, 11, 14, 23, 30),
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    assert_eq!(
        t.last().entries_calls()[0],
        ("2026-11-14".to_owned(), "2026-11-14".to_owned())
    );
    t.set_time(madrid(2026, 11, 15, 0, 30));
    assert_eq!(t.state().today_hours, None);
    t.integration.refresh();
    t.flush(0).await;
    assert_eq!(
        t.last().entries_calls().last().cloned(),
        Some(("2026-11-15".to_owned(), "2026-11-15".to_owned()))
    );
    assert_eq!(t.state().today_hours, Some(3.75));
}

// ---------------------------------------------------------------------------------------------
// v0.3.0: the integration disabled in the settings (`integrations.redmine.enabled`)

#[tokio::test]
async fn disabled_redmine_does_not_poll() {
    // Disabled before the start, as main applies the settings: not a single query.
    let t = setup(Setup {
        started: false,
        ..Setup::default()
    });
    t.integration.set_enabled(false);
    t.integration.start();
    t.ready().await;
    t.integration.set_view_open(true);
    t.integration.refresh();
    t.flush(TICK_MS * 3).await;
    let client = t.last();
    assert_eq!(client.viewer_calls(), 0);
    assert_eq!(client.issues_calls(), 0);
    assert!(client.entries_calls().is_empty());

    // Disabled at runtime: tasks and summary stop.
    let t = setup(Setup::default());
    t.ready().await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    let client = t.last();
    assert_eq!(client.issues_calls(), 1);
    assert_eq!(client.ranged_calls(), 1);
    t.integration.set_enabled(false);
    t.flush(SUMMARY_TICK_MS * 2).await;
    assert_eq!(client.issues_calls(), 1);
    assert_eq!(client.ranged_calls(), 1);
}

#[tokio::test]
async fn an_answer_that_arrives_after_disabling_redmine_is_dropped() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let client = t.last();
    let pending = client.issues.lock().unwrap().once_later();
    t.flush(TICK_MS).await;
    assert_eq!(client.issues_calls(), 2);
    let emitted = t.emitted().len();

    t.integration.set_enabled(false);
    pending.resolve(Ok(list(&[99])));
    t.flush(0).await;
    assert_eq!(t.emitted().len(), emitted);
    assert_eq!(t.issue_ids().await, [12, 13]);
}

#[tokio::test]
async fn reenabling_redmine_queries_at_once() {
    let t = setup(Setup::default());
    t.ready().await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    let client = t.last();
    t.integration.set_enabled(false);
    t.flush(TICK_MS * 2).await;
    assert_eq!(client.issues_calls(), 1);

    t.integration.set_enabled(true);
    t.flush(0).await;
    assert_eq!(client.issues_calls(), 2);
    assert_eq!(client.ranged_calls(), 2);
    t.flush(TICK_MS).await;
    assert_eq!(client.issues_calls(), 3);
}

#[tokio::test]
async fn reenabling_redmine_with_an_answer_still_pending_queries_again_and_rearms_the_timers() {
    let t = setup(Setup::default());
    t.ready().await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    let client = t.last();
    let pending = client.issues.lock().unwrap().once_later();
    t.flush(TICK_MS).await;
    assert_eq!(client.issues_calls(), 2);

    // Off, the answer comes back, on again before anything else runs.
    t.integration.set_enabled(false);
    pending.resolve(Ok(list(&[12])));
    t.integration.set_enabled(true);
    t.flush(0).await;
    assert_eq!(client.issues_calls(), 3);
    assert_eq!(client.ranged_calls(), 2);
    t.flush(TICK_MS).await;
    assert_eq!(client.issues_calls(), 4);
    t.flush(SUMMARY_TICK_MS).await;
    assert_eq!(client.ranged_calls(), 3);
}
