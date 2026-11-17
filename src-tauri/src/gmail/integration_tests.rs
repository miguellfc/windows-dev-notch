//! Port of `tests/unit/main/gmail-integration.test.ts` (67 cases: 64 `it`s plus the 3 generated
//! notch-state cases, which run against the real `NotchController`): a fake client, auth, token
//! store and settings; virtual timers stepped in due order; a fixed wall clock moved with them
//! (2026-11-11T10:00:00Z, UTC instants only). Plus the Rust-only cases of the part-6 plan.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use chrono::{DateTime, Utc};
use tokio::sync::{oneshot, watch};

use super::*;
use crate::contract::gmail::{
    GmailExpiredReason, GmailLink, GmailMessage, GmailMessageDetail, GmailNewMail,
    GmailSignInResult, GmailState, GmailStatus,
};
use crate::contract::settings::{GmailAlertSettings, GmailSettings};
use crate::gmail::auth::{
    GmailAuth, GmailAuthError, GoogleAuth, GoogleAuthConfig, RefreshResult, SignInError,
    SignInResult,
};
use crate::gmail::client::{GmailApiClient, GmailApiError, GmailClient, GmailError, TokenAccess};
use crate::http::{HttpRequest, HttpResponse, ReqwestTransport, Transport, TransportError};
use crate::ipc::{BoxFuture, ExposedError, IpcErrorCode};
use crate::notch::controller::{NotchController, NotchSurface};
use crate::notch::geometry::Rect;
use crate::notch::state::{NotchEvent, NotchMode, Yielding};
use crate::services::clock::WallClock;
use crate::services::timers::{TestTimers, Timers};

const MIN: u64 = 60_000;
const HOUR_MS: f64 = 3_600_000.0;
const READONLY: &str = "https://www.googleapis.com/auth/gmail.readonly";

type Res<T> = Result<T, GmailError>;

fn start_time() -> DateTime<Utc> {
    "2026-11-11T10:00:00Z".parse().unwrap()
}

fn api(code: GmailApiError) -> GmailError {
    GmailError::Api(code)
}

fn message(id: &str) -> GmailMessage {
    GmailMessage {
        id: id.into(),
        thread_id: format!("thread-{id}"),
        from: format!("Sender {id}"),
        subject: format!("Subject {id}"),
        snippet: format!("Snippet {id}"),
        date: "2026-11-11T09:00:00.000Z".into(),
        unread: true,
    }
}

/// Unread ids as the client returns them: `count` ids, newest first.
fn ids(count: usize) -> Vec<String> {
    (1..=count).map(|i| format!("u{i}")).collect()
}

/// `['n1', ...ids(3)]`.
fn with_new(new: &[&str]) -> Vec<String> {
    new.iter()
        .map(|id| (*id).to_owned())
        .chain(ids(3))
        .collect()
}

fn detail(id: &str) -> GmailMessageDetail {
    GmailMessageDetail {
        id: id.into(),
        thread_id: format!("thread-{id}"),
        from: format!("Sender {id}"),
        from_address: format!("{id}@example.com"),
        subject: format!("Subject {id}"),
        date: "2026-11-11T09:00:00.000Z".into(),
        unread: true,
        body: format!("Body {id}"),
        truncated: false,
        links: vec![
            GmailLink {
                text: "First".into(),
                url: format!("https://example.com/{id}/1"),
            },
            GmailLink {
                text: "Second".into(),
                url: format!("https://example.com/{id}/2"),
            },
        ],
        attachments: 0,
    }
}

fn state(status: GmailStatus) -> GmailState {
    GmailState {
        status,
        account: None,
        unread: None,
        updated_at: None,
        persistent: true,
        reason: None,
    }
}

fn now_of(clock: &WallClock) -> f64 {
    clock.now().timestamp_millis() as f64
}

/// The error code of a refusal.
fn refusal<T>(result: Result<T, ExposedError>) -> IpcErrorCode {
    match result {
        Ok(_) => panic!("expected a refusal"),
        Err(error) => error.code(),
    }
}

// ---------------------------------------------------------------------------------------------
// Mocks (`vi.fn`)

/// A mock's answer: now, or once the test resolves a [`Deferred`].
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

/// A pending promise the test resolves.
struct Deferred<O>(watch::Sender<Option<O>>);

impl<O> Deferred<O> {
    fn resolve(&self, value: O) {
        self.0.send_replace(Some(value));
    }
}

type Imp<A, O> = Arc<dyn Fn(&A) -> Reply<O> + Send + Sync>;

struct Mock<A, O> {
    calls: Vec<A>,
    once: VecDeque<Reply<O>>,
    imp: Imp<A, O>,
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
    fn set_with(&mut self, imp: impl Fn(&A) -> O + Send + Sync + 'static) {
        self.imp = Arc::new(move |args| Reply::Now(imp(args)));
    }

    /// `mockResolvedValueOnce` / `mockRejectedValueOnce`.
    fn once(&mut self, value: O) {
        self.once.push_back(Reply::Now(value));
    }

    /// `mockImplementationOnce(() => new Promise(...))`.
    fn once_later(&mut self) -> Deferred<O> {
        let (sender, receiver) = watch::channel(None);
        self.once
            .push_back(Reply::Later(receiver, self.fallback.clone()));
        Deferred(sender)
    }

    fn count(&self) -> usize {
        self.calls.len()
    }
}

/// The API mocks, shared by every client (`api` in the TS harness).
struct Api {
    profile: Mutex<Mock<(), Res<String>>>,
    unread_ids: Mutex<Mock<(), Res<Vec<String>>>>,
    recent: Mutex<Mock<(), Res<Vec<GmailMessage>>>>,
    summary: Mutex<Mock<String, Res<Option<GmailMessage>>>>,
    message: Mutex<Mock<String, Res<GmailMessageDetail>>>,
    mark_read: Mutex<Mock<String, Res<()>>>,
    remove: Mutex<Mock<String, Res<()>>>,
    list: Arc<Mutex<Vec<GmailMessage>>>,
}

impl Api {
    fn new() -> Self {
        let list = Arc::new(Mutex::new(vec![message("m1"), message("m2")]));
        let network = Err(api(GmailApiError::Network));
        Self {
            profile: Mutex::new(Mock::new(Err(api(GmailApiError::Network)), |_| {
                Ok("me@example.com".to_owned())
            })),
            unread_ids: Mutex::new(Mock::new(Err(api(GmailApiError::Network)), |_| Ok(ids(3)))),
            recent: Mutex::new({
                let list = Arc::clone(&list);
                Mock::new(Err(api(GmailApiError::Network)), move |_| {
                    Ok(list.lock().unwrap().clone())
                })
            }),
            summary: Mutex::new(Mock::new(
                Err(api(GmailApiError::Network)),
                |id: &String| Ok(Some(message(id))),
            )),
            message: Mutex::new(Mock::new(
                Err(api(GmailApiError::Network)),
                |id: &String| Ok(detail(id)),
            )),
            mark_read: Mutex::new(Mock::new(network, |_| Ok(()))),
            remove: Mutex::new(Mock::new(Err(api(GmailApiError::Network)), |_| Ok(()))),
            list,
        }
    }

    fn requests(&self) -> usize {
        self.profile.lock().unwrap().count()
            + self.unread_ids.lock().unwrap().count()
            + self.recent.lock().unwrap().count()
            + self.summary.lock().unwrap().count()
            + self.message.lock().unwrap().count()
            + self.mark_read.lock().unwrap().count()
            + self.remove.lock().unwrap().count()
    }

    fn unread_calls(&self) -> usize {
        self.unread_ids.lock().unwrap().count()
    }

    fn recent_calls(&self) -> usize {
        self.recent.lock().unwrap().count()
    }
}

/// The TS harness's client: each call asks for an access token first, then calls the API mock.
struct FakeClient {
    api: Arc<Api>,
    access: Arc<dyn TokenAccess>,
    tokens: Arc<Mutex<Vec<String>>>,
}

impl FakeClient {
    async fn token(&self) -> Res<()> {
        let token = self.access.access_token().await?;
        self.tokens.lock().unwrap().push(token);
        Ok(())
    }
}

impl GmailApiClient for FakeClient {
    fn profile(&self) -> BoxFuture<'_, Res<String>> {
        Box::pin(async move {
            self.token().await?;
            let reply = self.api.profile.lock().unwrap().call(());
            resolve(reply).await
        })
    }

    fn unread_ids(&self) -> BoxFuture<'_, Res<Vec<String>>> {
        Box::pin(async move {
            self.token().await?;
            let reply = self.api.unread_ids.lock().unwrap().call(());
            resolve(reply).await
        })
    }

    fn recent(&self) -> BoxFuture<'_, Res<Vec<GmailMessage>>> {
        Box::pin(async move {
            self.token().await?;
            let reply = self.api.recent.lock().unwrap().call(());
            resolve(reply).await
        })
    }

    fn summary<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Res<Option<GmailMessage>>> {
        Box::pin(async move {
            self.token().await?;
            let reply = self.api.summary.lock().unwrap().call(id.to_owned());
            resolve(reply).await
        })
    }

    fn message<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Res<GmailMessageDetail>> {
        Box::pin(async move {
            self.token().await?;
            let reply = self.api.message.lock().unwrap().call(id.to_owned());
            resolve(reply).await
        })
    }

    fn mark_read<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Res<()>> {
        Box::pin(async move {
            self.token().await?;
            let reply = self.api.mark_read.lock().unwrap().call(id.to_owned());
            resolve(reply).await
        })
    }

    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Res<()>> {
        Box::pin(async move {
            self.token().await?;
            let reply = self.api.remove.lock().unwrap().call(id.to_owned());
            resolve(reply).await
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Fake auth: a second sign-in cancels the first, as the real one (the pending sign-in is shared
// by every auth of the test, as in TS).

type SignInSlot = Mutex<Option<oneshot::Sender<Result<SignInResult, SignInError>>>>;

fn cancelled() -> SignInError {
    SignInError::Auth(GmailAuthError::Cancelled)
}

struct FakeAuth {
    pending: Arc<SignInSlot>,
    sign_in_calls: AtomicUsize,
    cancel_calls: AtomicUsize,
    refresh: Mutex<Mock<String, Result<RefreshResult, GmailAuthError>>>,
    /// `mockImplementation((token) => stalled.real.refresh(token))`.
    refresh_via: Mutex<Option<Arc<dyn GmailAuth>>>,
    revokes: Mutex<Vec<String>>,
    revoke_via: Mutex<Option<Arc<dyn GmailAuth>>>,
    clock: Arc<WallClock>,
}

impl FakeAuth {
    fn new(pending: Arc<SignInSlot>, clock: Arc<WallClock>) -> Self {
        let refresh_clock = Arc::clone(&clock);
        Self {
            pending,
            sign_in_calls: AtomicUsize::new(0),
            cancel_calls: AtomicUsize::new(0),
            refresh: Mutex::new(Mock::new(Err(GmailAuthError::Network), move |_| {
                Ok(RefreshResult {
                    access_token: "AT-refreshed".into(),
                    expires_at: now_of(&refresh_clock) + HOUR_MS,
                    scope: None,
                })
            })),
            refresh_via: Mutex::new(None),
            revokes: Mutex::new(Vec::new()),
            revoke_via: Mutex::new(None),
            clock,
        }
    }

    /// A refresh answer valid for `valid_ms` from now.
    fn refreshed(&self, token: &str, valid_ms: f64, scope: Option<&str>) -> RefreshResult {
        RefreshResult {
            access_token: token.into(),
            expires_at: now_of(&self.clock) + valid_ms,
            scope: scope.map(str::to_owned),
        }
    }

    fn refresh_calls(&self) -> Vec<String> {
        self.refresh.lock().unwrap().calls.clone()
    }

    fn refresh_count(&self) -> usize {
        self.refresh.lock().unwrap().count()
    }

    fn cancels(&self) -> usize {
        self.cancel_calls.load(Ordering::SeqCst)
    }
}

impl GmailAuth for FakeAuth {
    fn sign_in(&self) -> BoxFuture<'_, Result<SignInResult, SignInError>> {
        // Registered when called, as the real one.
        self.sign_in_calls.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = oneshot::channel();
        if let Some(previous) = self.pending.lock().unwrap().replace(sender) {
            let _ = previous.send(Err(cancelled()));
        }
        Box::pin(async move { receiver.await.unwrap_or(Err(cancelled())) })
    }

    fn cancel(&self) {
        self.cancel_calls.fetch_add(1, Ordering::SeqCst);
        if let Some(pending) = self.pending.lock().unwrap().take() {
            let _ = pending.send(Err(cancelled()));
        }
    }

    fn refresh<'a>(
        &'a self,
        refresh_token: &'a str,
    ) -> BoxFuture<'a, Result<RefreshResult, GmailAuthError>> {
        let reply = self.refresh.lock().unwrap().call(refresh_token.to_owned());
        let via = self.refresh_via.lock().unwrap().clone();
        Box::pin(async move {
            match via {
                Some(via) => via.refresh(refresh_token).await,
                None => resolve(reply).await,
            }
        })
    }

    fn revoke<'a>(&'a self, token: &'a str) -> BoxFuture<'a, ()> {
        self.revokes.lock().unwrap().push(token.to_owned());
        let via = self.revoke_via.lock().unwrap().clone();
        Box::pin(async move {
            if let Some(via) = via {
                via.revoke(token).await;
            }
        })
    }
}

// ---------------------------------------------------------------------------------------------
// Fake token store and settings

struct FakeStore {
    stored: Mutex<Option<String>>,
    /// `load`, `save:<token>`, `clear`, as each finishes.
    ops: Mutex<Vec<String>>,
    persistent: bool,
    /// Holds the next save until the test releases it.
    save_gate: Mutex<Option<watch::Receiver<bool>>>,
}

impl FakeStore {
    fn stored(&self) -> Option<String> {
        self.stored.lock().unwrap().clone()
    }

    fn ops(&self) -> Vec<String> {
        self.ops.lock().unwrap().clone()
    }

    fn count(&self, op: &str) -> usize {
        self.ops().iter().filter(|o| o.starts_with(op)).count()
    }

    /// The saves and clears, in the order they finished.
    fn writes(&self) -> Vec<String> {
        self.ops().into_iter().filter(|op| op != "load").collect()
    }

    fn hold_next_save(&self) -> watch::Sender<bool> {
        let (release, gate) = watch::channel(false);
        *self.save_gate.lock().unwrap() = Some(gate);
        release
    }
}

impl TokenStore for FakeStore {
    fn load(&self) -> BoxFuture<'_, Result<Option<String>, String>> {
        self.ops.lock().unwrap().push("load".into());
        let token = self.stored();
        Box::pin(async move { Ok(token) })
    }

    fn save<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<(), String>> {
        let gate = self.save_gate.lock().unwrap().take();
        Box::pin(async move {
            finished(gate).await;
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
        self.persistent
    }
}

struct FakeSettings {
    current: Mutex<GmailSettings>,
    listener: Mutex<Weak<GmailIntegration>>,
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
    fn get(&self) -> GmailSettings {
        self.current.lock().unwrap().clone()
    }
}

// ---------------------------------------------------------------------------------------------
// Harness

type PrepareAuth = Arc<dyn Fn(&FakeAuth) + Send + Sync>;

struct Setup {
    client_id: &'static str,
    token: Option<&'static str>,
    persistent: bool,
    /// Calls `start()`, as main does once the channels exist.
    started: bool,
    /// Also called for each new-mail alert (main dispatches it to the notch).
    on_new_mail: Option<NewMailListener>,
    /// Adjusts each fake auth as it is created.
    prepare_auth: Option<PrepareAuth>,
    /// Shared with a real notch controller.
    timers: Option<Arc<TestTimers>>,
    /// A factory other than the fake one (the real client against a loopback port).
    client: Option<ClientFactory>,
}

impl Default for Setup {
    fn default() -> Self {
        Self {
            client_id: "cid",
            token: Some("RT-stored"),
            persistent: true,
            started: true,
            on_new_mail: None,
            prepare_auth: None,
            timers: None,
            client: None,
        }
    }
}

struct T {
    integration: Arc<GmailIntegration>,
    timers: Arc<TestTimers>,
    clock: Arc<WallClock>,
    settings: Arc<FakeSettings>,
    store: Arc<FakeStore>,
    api: Arc<Api>,
    auths: Arc<Mutex<Vec<Arc<FakeAuth>>>>,
    /// Every `authFactory` call.
    auth_credentials: Arc<Mutex<Vec<Credentials>>>,
    pending_sign_in: Arc<SignInSlot>,
    states: Arc<Mutex<Vec<GmailState>>>,
    opened: Arc<Mutex<Vec<String>>>,
    new_mail: Arc<Mutex<Vec<GmailNewMail>>>,
    tokens_used: Arc<Mutex<Vec<String>>>,
    /// The token access handed to the last client built.
    access: Arc<Mutex<Option<Arc<dyn TokenAccess>>>>,
}

fn setup(options: Setup) -> T {
    // Installed before anything logs (the capture is process-wide).
    crate::services::test_log::capture().expect("the test logger");
    let timers = options
        .timers
        .unwrap_or_else(|| Arc::new(TestTimers::new()));
    let clock = Arc::new(WallClock::fixed(start_time()));
    let settings = Arc::new(FakeSettings {
        current: Mutex::new(GmailSettings {
            client_id: options.client_id.into(),
            client_secret: "csecret".into(),
            alerts: GmailAlertSettings {
                enabled: true,
                hide_content: false,
                sound: true,
            },
        }),
        listener: Mutex::new(Weak::new()),
    });
    let store = Arc::new(FakeStore {
        stored: Mutex::new(options.token.map(str::to_owned)),
        ops: Mutex::new(Vec::new()),
        persistent: options.persistent,
        save_gate: Mutex::new(None),
    });
    let api = Arc::new(Api::new());
    let auths: Arc<Mutex<Vec<Arc<FakeAuth>>>> = Arc::default();
    let auth_credentials: Arc<Mutex<Vec<Credentials>>> = Arc::default();
    let pending_sign_in: Arc<SignInSlot> = Arc::default();
    let states: Arc<Mutex<Vec<GmailState>>> = Arc::default();
    let opened: Arc<Mutex<Vec<String>>> = Arc::default();
    let new_mail: Arc<Mutex<Vec<GmailNewMail>>> = Arc::default();
    let tokens_used: Arc<Mutex<Vec<String>>> = Arc::default();
    let access: Arc<Mutex<Option<Arc<dyn TokenAccess>>>> = Arc::default();

    let auth: AuthFactory = {
        let auths = Arc::clone(&auths);
        let calls = Arc::clone(&auth_credentials);
        let pending = Arc::clone(&pending_sign_in);
        let clock = Arc::clone(&clock);
        let prepare = options.prepare_auth.clone();
        Arc::new(move |credentials: &Credentials| {
            calls.lock().unwrap().push(credentials.clone());
            let auth = Arc::new(FakeAuth::new(Arc::clone(&pending), Arc::clone(&clock)));
            if let Some(prepare) = &prepare {
                prepare(&auth);
            }
            auths.lock().unwrap().push(Arc::clone(&auth));
            auth as Arc<dyn GmailAuth>
        })
    };
    let fake_client: ClientFactory = {
        let api = Arc::clone(&api);
        let tokens = Arc::clone(&tokens_used);
        Arc::new(move |deps: Arc<dyn TokenAccess>| {
            Arc::new(FakeClient {
                api: Arc::clone(&api),
                access: deps,
                tokens: Arc::clone(&tokens),
            }) as Arc<dyn GmailApiClient>
        })
    };
    let inner_client = options.client.unwrap_or(fake_client);
    let client: ClientFactory = {
        let access = Arc::clone(&access);
        Arc::new(move |deps: Arc<dyn TokenAccess>| {
            *access.lock().unwrap() = Some(Arc::clone(&deps));
            inner_client(deps)
        })
    };
    let deps = GmailDeps {
        settings: Arc::clone(&settings) as Arc<dyn SettingsSource>,
        store: Arc::clone(&store) as Arc<dyn TokenStore>,
        auth,
        client,
        timers: Arc::clone(&timers) as Arc<dyn Timers>,
        clock: Arc::clone(&clock),
        spawn: Arc::new(|future| {
            tokio::spawn(future);
        }),
        emit: {
            let states = Arc::clone(&states);
            Arc::new(move |state: &GmailState| states.lock().unwrap().push(state.clone()))
        },
        open_external: {
            let opened = Arc::clone(&opened);
            Arc::new(move |url: String| {
                opened.lock().unwrap().push(url);
                Box::pin(async { Ok(()) }) as BoxFuture<'static, Result<(), String>>
            })
        },
        on_new_mail: {
            let new_mail = Arc::clone(&new_mail);
            let extra = options.on_new_mail.clone();
            Some(Arc::new(move |mail: &GmailNewMail| {
                new_mail.lock().unwrap().push(mail.clone());
                if let Some(extra) = &extra {
                    extra(mail);
                }
            }))
        },
    };
    let integration = GmailIntegration::new(deps);
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
        api,
        auths,
        auth_credentials,
        pending_sign_in,
        states,
        opened,
        new_mail,
        tokens_used,
        access,
    }
}

/// Lets the spawned tasks run until they wait on something else.
async fn settle() {
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
}

impl T {
    fn g(&self) -> Arc<GmailIntegration> {
        Arc::clone(&self.integration)
    }

    async fn ready(&self) {
        self.integration.ready().await;
    }

    fn state(&self) -> GmailState {
        self.integration.state()
    }

    fn status(&self) -> GmailStatus {
        self.state().status
    }

    fn last_state(&self) -> GmailState {
        self.states
            .lock()
            .unwrap()
            .last()
            .cloned()
            .expect("a state")
    }

    fn opened(&self) -> Vec<String> {
        self.opened.lock().unwrap().clone()
    }

    fn new_mail(&self) -> Vec<GmailNewMail> {
        self.new_mail.lock().unwrap().clone()
    }

    fn new_mail_ids(&self) -> Vec<String> {
        self.new_mail().into_iter().map(|m| m.id).collect()
    }

    fn requests(&self) -> usize {
        self.api.requests()
    }

    fn auth(&self, index: usize) -> Arc<FakeAuth> {
        Arc::clone(&self.auths.lock().unwrap()[index])
    }

    fn auth_count(&self) -> usize {
        self.auths.lock().unwrap().len()
    }

    fn access(&self) -> Arc<dyn TokenAccess> {
        self.access.lock().unwrap().clone().expect("a client")
    }

    fn tokens_used(&self) -> Vec<String> {
        self.tokens_used.lock().unwrap().clone()
    }

    fn set_list(&self, list: Vec<GmailMessage>) {
        *self.api.list.lock().unwrap() = list;
    }

    fn set_unread(&self, next: Vec<String>) {
        self.api.unread_ids.lock().unwrap().set(Ok(next));
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

    /// `finishSignIn(result)`.
    fn finish_sign_in(&self, scope: Option<&str>) {
        let pending = self.pending_sign_in.lock().unwrap().take();
        if let Some(pending) = pending {
            let _ = pending.send(Ok(SignInResult {
                refresh_token: "RT-new".into(),
                access_token: "AT-new".into(),
                expires_at: now_of(&self.clock) + HOUR_MS,
                scope: scope.map(str::to_owned),
            }));
        }
    }

    /// `failSignIn(code)`.
    fn fail_sign_in(&self, code: GmailAuthError) {
        let pending = self.pending_sign_in.lock().unwrap().take();
        if let Some(pending) = pending {
            let _ = pending.send(Err(SignInError::Auth(code)));
        }
    }

    /// `changeSettings(credentials)`: keeps the alerts.
    fn change_settings(&self, client_id: &str, client_secret: &str) {
        {
            let mut current = self.settings.current.lock().unwrap();
            current.client_id = client_id.into();
            current.client_secret = client_secret.into();
        }
        self.settings.notify();
    }

    /// `setAlerts(alerts)`.
    fn set_alerts(&self, change: impl FnOnce(&mut GmailAlertSettings)) {
        change(&mut self.settings.current.lock().unwrap().alerts);
        self.settings.notify();
    }

    fn sign_in(&self) -> tokio::task::JoinHandle<GmailSignInResult> {
        let g = self.g();
        tokio::spawn(async move { g.sign_in().await })
    }

    /// `showList`: the list m1, m2 has been sent to the notch.
    async fn show_list(&self) {
        self.ready().await;
        self.flush(0).await;
        self.integration.set_view_open(true);
        self.flush(0).await;
        self.integration.recent().await;
    }
}

/// The gmail lines this test logged (a current-thread test runs its tasks on its own thread).
fn gmail_log() -> Vec<String> {
    crate::services::test_log::capture()
        .expect("the test logger")
        .lines_of_this_thread()
        .into_iter()
        .filter(|line| line.contains(&format!("{LOG_TARGET} ")))
        .collect()
}

fn assert_no_secret(log: &[String], secrets: &[&str]) {
    for line in log {
        for secret in secrets {
            assert!(!line.contains(secret), "{secret} in {line}");
        }
    }
}

// ---------------------------------------------------------------------------------------------
// startup

#[tokio::test]
async fn without_a_client_id_is_unconfigured_and_makes_no_request() {
    let t = setup(Setup {
        client_id: "",
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.state(), state(GmailStatus::Unconfigured));
    assert_eq!(t.requests(), 0);
    assert_eq!(t.auth_count(), 0);
}

#[tokio::test]
async fn with_a_client_and_no_token_is_signed_out() {
    let t = setup(Setup {
        token: None,
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.status(), GmailStatus::SignedOut);
    assert_eq!(t.requests(), 0);
}

#[tokio::test]
async fn with_a_token_queries_and_reports_ok_with_unread_account_and_updated_at() {
    let t = setup(Setup {
        persistent: false,
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    assert_eq!(
        t.state(),
        GmailState {
            status: GmailStatus::Ok,
            account: Some("me@example.com".into()),
            unread: Some(3),
            updated_at: Some("2026-11-11T10:00:00.000Z".into()),
            persistent: false,
            reason: None,
        }
    );
    assert_eq!(t.auth(0).refresh_calls(), ["RT-stored"]);
    assert_eq!(t.last_state(), t.state());
}

#[tokio::test]
async fn without_network_at_startup_with_a_token_is_offline_not_expired_and_recovers() {
    let t = setup(Setup {
        prepare_auth: Some(Arc::new(|a: &FakeAuth| {
            a.refresh.lock().unwrap().set(Err(GmailAuthError::Network));
        })),
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.status(), GmailStatus::Offline);
    assert_eq!(t.store.count("clear"), 0);

    let auth = t.auth(0);
    let back = auth.refreshed("AT-back", HOUR_MS, None);
    auth.refresh.lock().unwrap().set(Ok(back));
    t.flush(MIN).await;
    assert_eq!(t.status(), GmailStatus::Ok);
    assert_eq!(t.state().unread, Some(3));
}

#[tokio::test]
async fn does_not_query_before_it_is_started() {
    let t = setup(Setup {
        started: false,
        ..Setup::default()
    });
    t.ready().await;
    t.flush(10 * MIN).await;
    assert_eq!(t.requests(), 0);
    assert_eq!(t.status(), GmailStatus::Ok);
}

// ---------------------------------------------------------------------------------------------
// rhythm

#[tokio::test]
async fn ticks_every_60_s_for_as_long_as_it_runs_whatever_the_capsule_shows_asking_the_account_once(
) {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.api.unread_calls(), 1);
    t.flush(MIN - 1).await;
    assert_eq!(t.api.unread_calls(), 1);
    t.flush(1).await;
    assert_eq!(t.api.unread_calls(), 2);

    t.flush(10 * MIN).await;
    assert_eq!(t.api.unread_calls(), 12);
    // A second start changes nothing (no extra query, no second timer).
    t.integration.start();
    t.flush(0).await;
    assert_eq!(t.api.unread_calls(), 12);
    t.flush(MIN).await;
    assert_eq!(t.api.unread_calls(), 13);
    assert_eq!(t.api.recent_calls(), 0);
    // The account is asked once.
    assert_eq!(t.api.profile.lock().unwrap().count(), 1);
}

#[tokio::test]
async fn with_the_view_open_also_fetches_the_recent_list_on_open_and_on_every_tick() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    assert_eq!(t.api.recent_calls(), 1);
    assert_eq!(t.integration.recent().await, [message("m1"), message("m2")]);
    t.flush(MIN).await;
    assert_eq!(t.api.recent_calls(), 2);

    t.integration.set_view_open(false);
    t.flush(MIN).await;
    assert_eq!(t.api.recent_calls(), 2);
    assert_eq!(t.api.unread_calls(), 4);
}

#[tokio::test]
async fn a_manual_refresh_queries_at_once_at_most_once_per_5_s() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.flush(10_000).await;
    assert_eq!(t.api.unread_calls(), 1);
    t.integration.refresh();
    t.flush(0).await;
    t.integration.refresh();
    t.flush(0).await;
    assert_eq!(t.api.unread_calls(), 2);
    t.flush(5_000).await;
    t.integration.refresh();
    t.flush(0).await;
    assert_eq!(t.api.unread_calls(), 3);
}

#[tokio::test]
async fn refreshes_the_access_token_only_when_missing_or_within_60_s_of_expiry_a_401_forces_one() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let auth = t.auth(0);
    assert_eq!(auth.refresh_count(), 1);
    t.flush(5 * MIN).await;
    assert_eq!(auth.refresh_count(), 1);
    assert!(!t.tokens_used().is_empty());
    assert!(t.tokens_used().iter().all(|token| token == "AT-refreshed"));

    let forced = auth.refreshed("AT-forced", HOUR_MS, None);
    auth.refresh.lock().unwrap().once(Ok(forced));
    assert_eq!(t.access().on_unauthorized().await, Ok(true));
    assert_eq!(auth.refresh_count(), 2);
    assert_eq!(t.access().access_token().await.as_deref(), Ok("AT-forced"));

    let short = auth.refreshed("AT-short", 30_000.0, None);
    auth.refresh.lock().unwrap().once(Ok(short));
    t.access().on_unauthorized().await.unwrap();
    // Inside the 60 s margin: the next use refreshes again.
    assert_eq!(
        t.access().access_token().await.as_deref(),
        Ok("AT-refreshed")
    );
    assert_eq!(auth.refresh_count(), 4);

    auth.refresh
        .lock()
        .unwrap()
        .once(Err(GmailAuthError::Denied));
    assert_eq!(t.access().on_unauthorized().await, Ok(false));
}

// ---------------------------------------------------------------------------------------------
// failures

#[tokio::test]
async fn network_server_and_rate_limited_go_offline_keeping_unread_waiting_1_2_4_5_5_min_success_restores_the_rhythm(
) {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.state().unread, Some(3));

    let codes = [
        GmailApiError::Network,
        GmailApiError::Server,
        GmailApiError::RateLimited,
        GmailApiError::Network,
        GmailApiError::Server,
    ];
    let failure = AtomicUsize::new(0);
    t.api.unread_ids.lock().unwrap().set_with(move |_| {
        Err(api(
            codes[failure.fetch_add(1, Ordering::SeqCst) % codes.len()]
        ))
    });
    // First failure.
    t.flush(MIN).await;
    let offline = t.state();
    assert_eq!(offline.status, GmailStatus::Offline);
    assert_eq!(offline.unread, Some(3));
    assert_eq!(offline.account.as_deref(), Some("me@example.com"));
    assert_eq!(
        offline.updated_at.as_deref(),
        Some("2026-11-11T10:00:00.000Z")
    );

    for wait in [1, 2, 4, 5] {
        let before = t.api.unread_calls();
        t.flush(wait * MIN - 1).await;
        assert_eq!(t.api.unread_calls(), before);
        t.flush(1).await;
        assert_eq!(t.api.unread_calls(), before + 1);
        assert_eq!(t.status(), GmailStatus::Offline);
        assert_eq!(t.state().unread, Some(3));
    }
    // Capped at 5 min.
    let before = t.api.unread_calls();
    t.flush(5 * MIN).await;
    assert_eq!(t.api.unread_calls(), before + 1);

    t.set_unread(ids(7));
    t.flush(5 * MIN).await;
    assert_eq!(t.status(), GmailStatus::Ok);
    assert_eq!(t.state().unread, Some(7));
    let before = t.api.unread_calls();
    t.flush(MIN).await;
    assert_eq!(t.api.unread_calls(), before + 1);
}

#[tokio::test]
async fn unauthorized_expires_and_no_more_requests_until_signing_in_again() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    t.api
        .unread_ids
        .lock()
        .unwrap()
        .set(Err(api(GmailApiError::Unauthorized)));
    t.flush(MIN).await;
    assert_eq!(t.status(), GmailStatus::Expired);
    assert!(t.integration.recent().await.is_empty());

    let before = t.requests();
    let refreshes = t.auth(0).refresh_count();
    t.integration.refresh();
    t.integration.start();
    t.flush(30 * MIN).await;
    assert_eq!(t.requests(), before);
    assert_eq!(t.auth(0).refresh_count(), refreshes);

    t.set_unread(ids(1));
    let result = t.sign_in();
    t.flush(0).await;
    t.finish_sign_in(None);
    assert_eq!(result.await.unwrap(), GmailSignInResult::Ok);
    t.flush(0).await;
    assert_eq!(t.status(), GmailStatus::Ok);
    assert_eq!(t.state().unread, Some(1));
}

#[tokio::test]
async fn a_refused_token_refresh_denied_expires() {
    let t = setup(Setup {
        prepare_auth: Some(Arc::new(|a: &FakeAuth| {
            a.refresh.lock().unwrap().set(Err(GmailAuthError::Denied));
        })),
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.status(), GmailStatus::Expired);
    assert_eq!(t.requests(), 0);
}

// ---------------------------------------------------------------------------------------------
// sign-in and sign-out

#[tokio::test]
async fn sign_in_goes_signing_in_then_ok_saves_the_token_and_queries_with_the_new_access_token() {
    let t = setup(Setup {
        token: None,
        ..Setup::default()
    });
    t.ready().await;
    let result = t.sign_in();
    t.flush(0).await;
    assert_eq!(t.status(), GmailStatus::SigningIn);
    assert_eq!(t.last_state().status, GmailStatus::SigningIn);
    t.finish_sign_in(None);
    assert_eq!(result.await.unwrap(), GmailSignInResult::Ok);
    t.flush(0).await;
    assert_eq!(t.store.writes(), ["save:RT-new"]);
    let now = t.state();
    assert_eq!(now.status, GmailStatus::Ok);
    assert_eq!(now.account.as_deref(), Some("me@example.com"));
    assert_eq!(now.unread, Some(3));
    assert!(t.tokens_used().contains(&"AT-new".to_owned()));
    assert_eq!(t.auth(0).refresh_count(), 0);
}

#[tokio::test]
async fn a_cancelled_sign_in_goes_back_to_signed_out_timeout_and_denied_are_errors() {
    let t = setup(Setup {
        token: None,
        ..Setup::default()
    });
    t.ready().await;
    let result = t.sign_in();
    t.flush(0).await;
    t.integration.cancel_sign_in();
    assert_eq!(result.await.unwrap(), GmailSignInResult::Cancelled);
    assert_eq!(t.status(), GmailStatus::SignedOut);

    for code in [
        GmailAuthError::Timeout,
        GmailAuthError::Denied,
        GmailAuthError::Network,
    ] {
        let result = t.sign_in();
        t.flush(0).await;
        t.fail_sign_in(code);
        assert_eq!(result.await.unwrap(), GmailSignInResult::Error);
        assert_eq!(t.status(), GmailStatus::SignedOut);
    }
    assert_eq!(t.store.count("save"), 0);
}

#[tokio::test]
async fn two_sign_ins_keep_only_one_alive_the_first_resolves_cancelled_the_second_wins() {
    let t = setup(Setup {
        token: None,
        ..Setup::default()
    });
    t.ready().await;
    let first = t.sign_in();
    t.flush(0).await;
    let second = t.sign_in();
    t.flush(0).await;
    assert_eq!(first.await.unwrap(), GmailSignInResult::Cancelled);
    assert_eq!(t.status(), GmailStatus::SigningIn);
    t.finish_sign_in(None);
    assert_eq!(second.await.unwrap(), GmailSignInResult::Ok);
    assert_eq!(t.status(), GmailStatus::Ok);
    assert_eq!(t.auth_count(), 1);
    assert_eq!(t.auth(0).sign_in_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn without_a_client_sign_in_is_an_error_and_opens_nothing() {
    let t = setup(Setup {
        client_id: "",
        ..Setup::default()
    });
    t.ready().await;
    assert_eq!(t.integration.sign_in().await, GmailSignInResult::Error);
    assert_eq!(t.auth_count(), 0);
}

#[tokio::test]
async fn sign_out_revokes_and_clears_the_token_a_failed_revoke_does_not_stop_the_clear() {
    // `revoke` never fails in Rust (it swallows its own errors): the clear is checked as is.
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.sign_out().await;
    assert_eq!(*t.auth(0).revokes.lock().unwrap(), ["RT-stored"]);
    assert_eq!(t.store.count("clear"), 1);
    assert_eq!(t.store.stored(), None);
    assert_eq!(t.state(), state(GmailStatus::SignedOut));

    let before = t.requests();
    t.flush(10 * MIN).await;
    assert_eq!(t.requests(), before);
}

#[tokio::test]
async fn a_poll_in_flight_when_signing_out_never_brings_old_data_back() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let release = t.api.unread_ids.lock().unwrap().once_later();
    t.flush(MIN).await;
    t.integration.sign_out().await;
    release.resolve(Ok(ids(9)));
    t.flush(0).await;
    assert_eq!(t.status(), GmailStatus::SignedOut);
    assert_eq!(t.state().unread, None);
}

// ---------------------------------------------------------------------------------------------
// settings

#[tokio::test]
async fn changing_the_client_id_while_signed_in_clears_the_token_and_signs_out_with_no_request_on_the_old_client(
) {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let old = t.auth(0);
    let before = t.requests();

    t.change_settings("cid-2", "csecret");
    t.flush(0).await;
    assert_eq!(t.store.count("clear"), 1);
    assert_eq!(t.store.stored(), None);
    let now = t.state();
    assert_eq!(now.status, GmailStatus::SignedOut);
    assert_eq!(now.account, None);
    assert_eq!(now.unread, None);
    t.flush(10 * MIN).await;
    assert_eq!(t.requests(), before);
    assert_eq!(old.refresh_count(), 1);
    assert!(old.revokes.lock().unwrap().is_empty());

    // Signing in again uses the new client.
    let result = t.sign_in();
    t.flush(0).await;
    assert_eq!(
        t.auth_credentials.lock().unwrap().last().cloned(),
        Some(Credentials {
            client_id: "cid-2".into(),
            client_secret: "csecret".into(),
        })
    );
    t.finish_sign_in(None);
    assert_eq!(result.await.unwrap(), GmailSignInResult::Ok);
}

#[tokio::test]
async fn changing_the_secret_also_signs_out_emptying_the_client_id_is_unconfigured() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.change_settings("cid", "other");
    t.flush(0).await;
    assert_eq!(t.status(), GmailStatus::SignedOut);
    t.change_settings("", "");
    t.flush(0).await;
    assert_eq!(t.status(), GmailStatus::Unconfigured);
    t.change_settings("cid", "x");
    t.flush(0).await;
    assert_eq!(t.status(), GmailStatus::SignedOut);
}

#[tokio::test]
async fn ignores_unrelated_settings_changes() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.change_settings("cid", "csecret");
    t.flush(0).await;
    assert_eq!(t.status(), GmailStatus::Ok);
    assert_eq!(t.store.count("clear"), 0);
}

#[tokio::test]
async fn a_sign_in_in_progress_is_cancelled_when_the_client_changes() {
    let t = setup(Setup {
        token: None,
        ..Setup::default()
    });
    t.ready().await;
    let result = t.sign_in();
    t.flush(0).await;
    t.change_settings("cid-2", "csecret");
    assert_eq!(result.await.unwrap(), GmailSignInResult::Cancelled);
    assert_eq!(t.status(), GmailStatus::SignedOut);
    assert_eq!(t.store.count("save"), 0);
}

// ---------------------------------------------------------------------------------------------
// open

#[tokio::test]
async fn opens_only_ids_of_the_last_list_sent_by_thread_without_id_opens_the_inbox() {
    let t = setup(Setup::default());
    t.show_list().await;

    t.integration.open(Some("unknown"));
    t.flush(0).await;
    assert!(t.opened().is_empty());

    t.integration.open(Some("m2"));
    t.flush(0).await;
    assert_eq!(
        t.opened().last().map(String::as_str),
        Some("https://mail.google.com/mail/u/0/#inbox/thread-m2")
    );

    t.integration.open(None);
    t.flush(0).await;
    assert_eq!(
        t.opened().last().map(String::as_str),
        Some("https://mail.google.com/mail/u/0/#inbox")
    );
}

#[tokio::test]
async fn refuses_ids_that_were_fetched_but_never_sent_to_the_notch() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    t.integration.open(Some("m1"));
    t.flush(0).await;
    assert!(t.opened().is_empty());
}

// ---------------------------------------------------------------------------------------------
// open from the reader

/// A new mail that is only known from the alert (never in a sent list).
async fn alert_only() -> T {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.set_unread(with_new(&["n1"]));
    t.flush(MIN).await;
    assert_eq!(t.new_mail_ids(), ["n1"]);
    t
}

#[tokio::test]
async fn opens_the_thread_of_the_open_message_even_when_it_is_not_in_the_last_list() {
    let t = alert_only().await;
    t.integration.message("n1").await.unwrap();
    t.integration.open(Some("n1"));
    t.flush(0).await;
    assert_eq!(
        t.opened().last().map(String::as_str),
        Some("https://mail.google.com/mail/u/0/#inbox/thread-n1")
    );
}

#[tokio::test]
async fn opens_the_inbox_for_a_shown_id_whose_thread_is_unknown_alert_only_or_the_read_never_finished(
) {
    let t = alert_only().await;
    t.integration.open(Some("n1"));
    t.flush(0).await;
    assert_eq!(
        t.opened().last().map(String::as_str),
        Some("https://mail.google.com/mail/u/0/#inbox")
    );

    t.api
        .message
        .lock()
        .unwrap()
        .once(Err(api(GmailApiError::Network)));
    assert_eq!(
        refusal(t.integration.message("n1").await),
        IpcErrorCode::Unavailable
    );
    t.integration.open(Some("n1"));
    t.flush(0).await;
    assert_eq!(
        t.opened().last().map(String::as_str),
        Some("https://mail.google.com/mail/u/0/#inbox")
    );
    assert_eq!(t.opened().len(), 2);
}

#[tokio::test]
async fn still_refuses_ids_never_shown_to_the_notch() {
    let t = alert_only().await;
    t.integration.open(Some("m1"));
    t.integration.open(Some("zzz"));
    t.flush(0).await;
    assert!(t.opened().is_empty());
}

// ---------------------------------------------------------------------------------------------
// privacy and lifecycle

#[tokio::test]
async fn never_logs_tokens_subjects_senders_or_snippets() {
    let t = setup(Setup::default());
    t.show_list().await;
    t.integration.open(Some("nope"));
    t.api
        .unread_ids
        .lock()
        .unwrap()
        .once(Err(api(GmailApiError::Network)));
    t.flush(MIN).await;
    t.api
        .unread_ids
        .lock()
        .unwrap()
        .once(Err(api(GmailApiError::Unauthorized)));
    t.flush(MIN).await;
    let result = t.sign_in();
    t.flush(0).await;
    t.finish_sign_in(None);
    result.await.unwrap();
    t.integration.sign_out().await;

    let log = gmail_log();
    assert_no_secret(
        &log,
        &[
            "RT-stored",
            "RT-new",
            "AT-refreshed",
            "AT-new",
            "csecret",
            "Subject m1",
            "Sender m1",
            "Snippet m1",
            "me@example.com",
        ],
    );
    assert!(!log.is_empty());
}

#[tokio::test]
async fn dispose_stops_the_rhythm_and_ignores_later_settings_changes() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.dispose();
    let before = t.requests();
    t.change_settings("other", "x");
    t.flush(10 * MIN).await;
    assert_eq!(t.requests(), before);
    assert_eq!(t.store.count("clear"), 0);
}

// ---------------------------------------------------------------------------------------------
// helpers

#[test]
fn accepts_only_an_http_127_0_0_1_port_origin_as_the_dev_base_url() {
    assert_eq!(
        parse_base_override(Some("http://127.0.0.1:4567")).as_deref(),
        Some("http://127.0.0.1:4567")
    );
    for bad in [
        None,
        Some(""),
        Some("http://127.0.0.1"),
        Some("http://127.0.0.1:0"),
        Some("http://127.0.0.1:70000"),
        Some("http://127.0.0.1:4567/"),
        Some("http://127.0.0.1:4567/gmail"),
        Some("https://127.0.0.1:4567"),
        Some("http://localhost:4567"),
        Some("http://127.0.0.1.evil.test:4567"),
        Some("http://user@127.0.0.1:4567"),
    ] {
        assert_eq!(parse_base_override(bad), None, "{bad:?}");
    }
    // Not trimmed (unlike Redmine).
    assert_eq!(parse_base_override(Some(" http://127.0.0.1:4567")), None);
    assert_eq!(parse_base_override(Some("http://127.0.0.1:4567\n")), None);
    // Only in dev/E2E builds.
    assert_eq!(
        base_override_from(true, Some("http://127.0.0.1:4567")).as_deref(),
        Some("http://127.0.0.1:4567")
    );
    assert_eq!(
        base_override_from(false, Some("http://127.0.0.1:4567")),
        None
    );
}

// ---------------------------------------------------------------------------------------------
// fix round 1

#[tokio::test]
async fn a_poll_in_flight_when_sign_in_starts_never_overwrites_signing_in_cancel_still_works_no_ticks_meanwhile(
) {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let release = t.api.unread_ids.lock().unwrap().once_later();
    // Poll now in flight.
    t.flush(MIN).await;
    let result = t.sign_in();
    t.flush(0).await;
    release.resolve(Ok(ids(9)));
    t.flush(0).await;
    assert_eq!(t.status(), GmailStatus::SigningIn);
    let before = t.requests();
    t.flush(10 * MIN).await;
    assert_eq!(t.requests(), before);
    assert_eq!(t.status(), GmailStatus::SigningIn);

    t.integration.cancel_sign_in();
    assert_eq!(result.await.unwrap(), GmailSignInResult::Cancelled);
    assert!(t.auth(0).cancels() > 0);
    // The previous session comes back and polls again.
    t.flush(0).await;
    assert_eq!(t.status(), GmailStatus::Ok);
}

#[tokio::test]
async fn cancel_sign_in_does_nothing_without_a_pending_sign_in() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.cancel_sign_in();
    assert_eq!(t.auth(0).cancels(), 0);
}

#[tokio::test]
async fn a_sign_out_right_after_a_sign_in_waits_for_the_token_save_before_clearing_it() {
    let t = setup(Setup {
        token: None,
        ..Setup::default()
    });
    t.ready().await;
    let release = t.store.hold_next_save();
    let result = t.sign_in();
    t.flush(0).await;
    t.finish_sign_in(None);
    t.flush(0).await;
    let g = t.g();
    let sign_out = tokio::spawn(async move { g.sign_out().await });
    t.flush(0).await;
    assert!(t.store.writes().is_empty());
    release.send_replace(true);
    sign_out.await.unwrap();
    result.await.unwrap();
    assert_eq!(t.store.writes(), ["save:RT-new", "clear"]);
    assert_eq!(t.store.stored(), None);
}

#[tokio::test]
async fn on_unauthorized_from_an_older_session_changes_nothing_in_the_new_one() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    let old = t.access();
    t.integration.sign_out().await;
    let result = t.sign_in();
    t.flush(0).await;
    t.finish_sign_in(None);
    result.await.unwrap();
    t.flush(0).await;
    let refreshes = t.auth(0).refresh_count();
    assert_eq!(old.on_unauthorized().await, Ok(false));
    assert_eq!(
        old.access_token().await,
        Err(api(GmailApiError::Unauthorized))
    );
    assert_eq!(t.auth(0).refresh_count(), refreshes);
    assert_eq!(t.access().access_token().await.as_deref(), Ok("AT-new"));
}

#[tokio::test]
async fn a_failed_recent_list_keeps_the_new_count_and_the_last_list() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    assert_eq!(t.integration.recent().await.len(), 2);
    t.set_unread(ids(5));
    t.api
        .recent
        .lock()
        .unwrap()
        .once(Err(api(GmailApiError::Network)));
    t.flush(MIN).await;
    assert_eq!(t.status(), GmailStatus::Ok);
    assert_eq!(t.state().unread, Some(5));
    assert_eq!(t.integration.recent().await.len(), 2);
}

// ---------------------------------------------------------------------------------------------
// stalled OAuth requests: the real auth over a transport that never answers; its 30 s timeout
// runs on tokio's paused clock.

#[derive(Default)]
struct Stalled {
    calls: AtomicUsize,
}

impl Transport for Stalled {
    fn send(&self, _request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, TransportError>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(std::future::pending())
    }
}

fn stalled_auth(stalled: &Arc<Stalled>) -> Arc<dyn GmailAuth> {
    Arc::new(GoogleAuth::new(
        Arc::clone(stalled) as Arc<dyn Transport>,
        Arc::new(|_url: String| Box::pin(async { Ok(()) }) as BoxFuture<'static, _>),
        Arc::new(WallClock::fixed(start_time())),
        GoogleAuthConfig::new("cid", "csecret", Some("http://127.0.0.1:9")),
    ))
}

#[tokio::test(start_paused = true)]
async fn a_hung_token_refresh_times_out_as_network_goes_offline_then_recovers() {
    let stalled = Arc::new(Stalled::default());
    let real = stalled_auth(&stalled);
    let t = setup(Setup {
        prepare_auth: Some(Arc::new(move |a: &FakeAuth| {
            *a.refresh_via.lock().unwrap() = Some(Arc::clone(&real));
        })),
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    // Waiting on the refresh, nothing published yet.
    assert_eq!(t.status(), GmailStatus::Ok);
    assert_eq!(stalled.calls.load(Ordering::SeqCst), 1);

    tokio::time::advance(Duration::from_secs(30)).await;
    t.flush(30_000).await;
    assert_eq!(t.status(), GmailStatus::Offline);
    assert_eq!(t.store.count("clear"), 0);

    let auth = t.auth(0);
    *auth.refresh_via.lock().unwrap() = None;
    let back = auth.refreshed("AT-back", HOUR_MS, None);
    auth.refresh.lock().unwrap().set(Ok(back));
    t.flush(MIN).await;
    assert_eq!(t.status(), GmailStatus::Ok);
    assert_eq!(t.state().unread, Some(3));
}

#[tokio::test(start_paused = true)]
async fn sign_out_with_a_hung_revoke_still_clears_the_token_and_finishes() {
    let stalled = Arc::new(Stalled::default());
    let real = stalled_auth(&stalled);
    let t = setup(Setup {
        prepare_auth: Some(Arc::new(move |a: &FakeAuth| {
            *a.revoke_via.lock().unwrap() = Some(Arc::clone(&real));
        })),
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    let g = t.g();
    let signing_out = tokio::spawn(async move { g.sign_out().await });
    t.flush(0).await;
    assert_eq!(t.store.stored(), None);
    assert_eq!(t.status(), GmailStatus::SignedOut);
    assert!(!signing_out.is_finished());
    assert_eq!(stalled.calls.load(Ordering::SeqCst), 1);
    tokio::time::advance(Duration::from_secs(30)).await;
    t.flush(30_000).await;
    signing_out.await.unwrap();
}

// ---------------------------------------------------------------------------------------------
// shown ids

#[tokio::test]
async fn accepts_ids_of_the_last_list_sent_refuses_others_without_any_request() {
    let t = setup(Setup::default());
    t.show_list().await;
    assert_eq!(t.integration.message("m1").await, Ok(detail("m1")));
    assert_eq!(t.api.message.lock().unwrap().calls, ["m1"]);

    assert_eq!(
        refusal(t.integration.message("zzz").await),
        IpcErrorCode::InvalidInput
    );
    assert_eq!(
        refusal(t.integration.mark_read("zzz").await),
        IpcErrorCode::InvalidInput
    );
    assert_eq!(
        refusal(t.integration.remove("zzz").await),
        IpcErrorCode::InvalidInput
    );
    assert_eq!(t.api.message.lock().unwrap().count(), 1);
    assert_eq!(t.api.mark_read.lock().unwrap().count(), 0);
    assert_eq!(t.api.remove.lock().unwrap().count(), 0);
}

#[tokio::test]
async fn actions_refuse_ids_fetched_but_never_sent_to_the_notch() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    assert_eq!(
        refusal(t.integration.remove("m1").await),
        IpcErrorCode::InvalidInput
    );
    assert_eq!(t.api.remove.lock().unwrap().count(), 0);
}

#[tokio::test]
async fn the_open_message_and_the_last_alert_also_count_as_shown() {
    let t = setup(Setup::default());
    t.show_list().await;
    t.integration.message("m1").await.unwrap();
    t.set_list(vec![message("m3")]);
    t.flush(MIN).await;
    // The notch now shows only m3.
    t.integration.recent().await;
    assert_eq!(t.integration.mark_read("m1").await, Ok(()));
    assert_eq!(t.api.mark_read.lock().unwrap().calls, ["m1"]);

    t.set_unread(with_new(&["n1"]));
    t.flush(MIN).await;
    assert_eq!(t.new_mail_ids(), ["n1"]);
    assert_eq!(t.integration.message("n1").await.unwrap().id, "n1");
}

#[tokio::test]
async fn maps_failures_to_clean_codes_gone_is_not_found_others_unavailable_a_dead_session_expires()
{
    let t = setup(Setup::default());
    t.show_list().await;
    t.api
        .message
        .lock()
        .unwrap()
        .once(Err(api(GmailApiError::NotFound)));
    assert_eq!(
        refusal(t.integration.message("m1").await),
        IpcErrorCode::NotFound
    );
    t.api
        .message
        .lock()
        .unwrap()
        .once(Err(api(GmailApiError::InvalidResponse)));
    assert_eq!(
        refusal(t.integration.message("m1").await),
        IpcErrorCode::Unavailable
    );
    t.api
        .mark_read
        .lock()
        .unwrap()
        .once(Err(api(GmailApiError::Network)));
    assert_eq!(
        refusal(t.integration.mark_read("m1").await),
        IpcErrorCode::Unavailable
    );
    assert_eq!(t.status(), GmailStatus::Ok);
    t.api
        .remove
        .lock()
        .unwrap()
        .once(Err(api(GmailApiError::Unauthorized)));
    let error = t.integration.remove("m2").await.unwrap_err();
    assert_eq!(error.code(), IpcErrorCode::Unavailable);
    assert_eq!(error.message(), "Gmail session expired");
    assert_eq!(t.status(), GmailStatus::Expired);
}

#[tokio::test]
async fn without_a_session_every_action_is_refused() {
    let t = setup(Setup {
        token: None,
        ..Setup::default()
    });
    t.ready().await;
    assert_eq!(
        refusal(t.integration.message("m1").await),
        IpcErrorCode::InvalidInput
    );
    assert_eq!(t.requests(), 0);
}

// ---------------------------------------------------------------------------------------------
// links

#[tokio::test]
async fn opens_only_a_link_of_the_open_message_by_index() {
    let t = setup(Setup::default());
    t.show_list().await;
    t.integration.message("m1").await.unwrap();
    t.integration.open_link("m1", 1).unwrap();
    t.flush(0).await;
    assert_eq!(
        t.opened().last().map(String::as_str),
        Some("https://example.com/m1/2")
    );

    assert_eq!(
        refusal(t.integration.open_link("m1", 2)),
        IpcErrorCode::InvalidInput
    );
    assert_eq!(
        refusal(t.integration.open_link("m2", 0)),
        IpcErrorCode::InvalidInput
    );
    assert_eq!(t.opened().len(), 1);
}

#[tokio::test]
async fn refuses_a_link_that_is_not_http_https_even_if_it_slipped_into_the_message() {
    let t = setup(Setup::default());
    t.show_list().await;
    let mut hostile = detail("m1");
    hostile.links = vec![GmailLink {
        text: "x".into(),
        url: "javascript:alert(1)".into(),
    }];
    t.api.message.lock().unwrap().once(Ok(hostile));
    t.integration.message("m1").await.unwrap();
    assert_eq!(
        refusal(t.integration.open_link("m1", 0)),
        IpcErrorCode::InvalidInput
    );
    assert!(t.opened().is_empty());
}

#[tokio::test]
async fn forgets_the_open_message_when_the_reading_closes_another_one_opens_or_on_sign_out() {
    let t = setup(Setup::default());
    t.show_list().await;
    t.integration.message("m1").await.unwrap();
    t.integration.set_view_open(false);
    assert_eq!(
        refusal(t.integration.open_link("m1", 0)),
        IpcErrorCode::InvalidInput
    );

    t.integration.set_view_open(true);
    t.integration.message("m1").await.unwrap();
    t.integration.message("m2").await.unwrap();
    assert_eq!(
        refusal(t.integration.open_link("m1", 0)),
        IpcErrorCode::InvalidInput
    );
    t.integration.open_link("m2", 0).unwrap();
    t.flush(0).await;
    assert_eq!(
        t.opened().last().map(String::as_str),
        Some("https://example.com/m2/1")
    );

    t.integration.sign_out().await;
    assert_eq!(
        refusal(t.integration.open_link("m2", 0)),
        IpcErrorCode::InvalidInput
    );
}

#[tokio::test]
async fn a_read_that_finishes_after_the_reading_closed_is_not_remembered() {
    let t = setup(Setup::default());
    t.show_list().await;
    let finish = t.api.message.lock().unwrap().once_later();
    let g = t.g();
    let reading = tokio::spawn(async move { g.message("m1").await });
    t.flush(0).await;
    t.integration.set_view_open(false);
    finish.resolve(Ok(detail("m1")));
    reading.await.unwrap().unwrap();
    assert_eq!(
        refusal(t.integration.open_link("m1", 0)),
        IpcErrorCode::InvalidInput
    );
}

// ---------------------------------------------------------------------------------------------
// closing the reader

#[tokio::test]
async fn closing_the_reader_forgets_the_open_message_and_its_links_while_the_list_ids_stay_shown() {
    let t = setup(Setup::default());
    t.show_list().await;
    t.integration.message("m1").await.unwrap();
    t.integration.close_message();
    assert_eq!(
        refusal(t.integration.open_link("m1", 0)),
        IpcErrorCode::InvalidInput
    );
    assert!(t.opened().is_empty());
    // Still in the last list: the row actions keep working.
    t.integration.mark_read("m1").await.unwrap();
    assert_eq!(t.api.mark_read.lock().unwrap().calls, ["m1"]);
}

#[tokio::test]
async fn a_read_that_finishes_after_the_reader_closed_is_not_remembered() {
    let t = setup(Setup::default());
    t.show_list().await;
    let finish = t.api.message.lock().unwrap().once_later();
    let g = t.g();
    let reading = tokio::spawn(async move { g.message("m1").await });
    t.flush(0).await;
    t.integration.close_message();
    finish.resolve(Ok(detail("m1")));
    reading.await.unwrap().unwrap();
    assert_eq!(
        refusal(t.integration.open_link("m1", 0)),
        IpcErrorCode::InvalidInput
    );
}

// ---------------------------------------------------------------------------------------------
// actions

#[tokio::test]
async fn mark_read_and_remove_query_at_once_past_the_5_s_manual_floor() {
    let t = setup(Setup::default());
    t.show_list().await;
    t.integration.refresh();
    t.flush(0).await;
    let before = t.api.unread_calls();
    t.integration.mark_read("m1").await.unwrap();
    t.flush(0).await;
    assert_eq!(t.api.unread_calls(), before + 1);
    t.integration.remove("m2").await.unwrap();
    t.flush(0).await;
    assert_eq!(t.api.unread_calls(), before + 2);
    assert!(t.api.recent_calls() >= 3);
}

#[tokio::test]
async fn a_deleted_message_can_no_longer_be_named() {
    let t = setup(Setup::default());
    t.show_list().await;
    t.integration.message("m1").await.unwrap();
    t.integration.remove("m1").await.unwrap();
    assert_eq!(t.api.remove.lock().unwrap().calls, ["m1"]);
    assert_eq!(
        refusal(t.integration.open_link("m1", 0)),
        IpcErrorCode::InvalidInput
    );
    assert_eq!(
        refusal(t.integration.remove("m1").await),
        IpcErrorCode::InvalidInput
    );
    assert_eq!(t.api.remove.lock().unwrap().count(), 1);
}

#[tokio::test]
async fn a_message_marked_as_read_stays_shown_the_reader_can_still_delete_it() {
    let t = setup(Setup::default());
    t.show_list().await;
    t.integration.message("m1").await.unwrap();
    t.integration.mark_read("m1").await.unwrap();
    assert_eq!(t.integration.remove("m1").await, Ok(()));
}

// ---------------------------------------------------------------------------------------------
// new mail

fn mail(count: u64, id: &str, content: bool) -> GmailNewMail {
    GmailNewMail {
        count,
        id: id.into(),
        from: content.then(|| format!("Sender {id}")),
        subject: content.then(|| format!("Subject {id}")),
    }
}

#[tokio::test]
async fn the_first_query_only_sets_the_baseline_new_ids_announce_the_newest_with_sender_and_subject(
) {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    assert!(t.new_mail().is_empty());

    t.set_unread(with_new(&["n1"]));
    t.flush(MIN).await;
    assert_eq!(t.api.summary.lock().unwrap().calls, ["n1"]);
    assert_eq!(t.new_mail(), [mail(1, "n1", true)]);

    t.set_unread(with_new(&["n3", "n2", "n1"]));
    t.flush(MIN).await;
    assert_eq!(t.new_mail().last(), Some(&mail(2, "n3", true)));

    // Same ids, or ids that went away: nothing new.
    t.set_unread(vec!["n3".into()]);
    t.flush(MIN).await;
    assert_eq!(t.new_mail().len(), 2);
}

#[tokio::test]
async fn with_hide_content_the_alert_carries_no_sender_or_subject_and_asks_no_metadata() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.set_alerts(|alerts| alerts.hide_content = true);
    t.set_unread(with_new(&["n1"]));
    t.flush(MIN).await;
    assert_eq!(t.new_mail(), [mail(1, "n1", false)]);
    assert_eq!(t.api.summary.lock().unwrap().count(), 0);
}

#[tokio::test]
async fn with_alerts_off_nothing_is_announced() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.set_alerts(|alerts| alerts.enabled = false);
    t.set_unread(with_new(&["n1"]));
    t.flush(MIN).await;
    assert!(t.new_mail().is_empty());
    assert_eq!(t.api.summary.lock().unwrap().count(), 0);
}

#[tokio::test]
async fn a_failed_metadata_request_still_alerts_without_content_a_message_already_gone_does_not() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.api
        .summary
        .lock()
        .unwrap()
        .once(Err(api(GmailApiError::Network)));
    t.set_unread(with_new(&["n1"]));
    t.flush(MIN).await;
    assert_eq!(t.new_mail(), [mail(1, "n1", false)]);

    t.api.summary.lock().unwrap().once(Ok(None));
    t.set_unread(with_new(&["n2", "n1"]));
    t.flush(MIN).await;
    assert_eq!(t.new_mail().len(), 1);
}

#[tokio::test]
async fn keeps_the_baseline_over_long_stretches_mail_arriving_after_an_hour_still_alerts() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.flush(60 * MIN).await;
    t.set_unread(with_new(&["n1"]));
    t.flush(MIN).await;
    assert_eq!(t.new_mail_ids(), ["n1"]);
}

// whatever the notch shows (the user-reported bug: mini paused polling and reset the baseline)

struct NoSurface;

impl NotchSurface for NoSurface {
    fn set_bounds(&self, _rect: Rect) {}
    fn show(&self) {}
    fn hide(&self) {}
    fn focus(&self) {}
    fn blur(&self) {}
    fn set_ignore_mouse(&self, _ignore: bool) {}
    fn send_mode(&self, _mode: NotchMode) {}
    fn send_mail_alert(&self, _on: bool) {}
    fn send_review_alert(&self, _on: bool) {}
    fn send_redmine_alert(&self, _on: bool) {}
}

/// Main's wiring: a new mail dispatches the alert to the real notch controller (on the same
/// virtual timers); the notch mode never reaches Gmail.
fn wired() -> (T, Arc<NotchController>) {
    let timers = Arc::new(TestTimers::new());
    let notch = NotchController::new(
        Arc::new(NoSurface),
        Arc::clone(&timers) as Arc<dyn Timers>,
        Rect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1032.0,
        },
        400,
    );
    notch.start();
    let dispatch = Arc::clone(&notch);
    let t = setup(Setup {
        timers: Some(timers),
        on_new_mail: Some(Arc::new(move |_mail: &GmailNewMail| {
            dispatch.dispatch(NotchEvent::Mail { on: true });
        })),
        ..Setup::default()
    });
    (t, notch)
}

async fn alerts_new_mail_while_the_capsule_is(event: NotchEvent) {
    let (t, notch) = wired();
    t.ready().await;
    t.flush(0).await;
    notch.dispatch(event);
    let before = notch.mode();
    t.set_unread(with_new(&["n1"]));
    t.flush(MIN).await;
    assert_eq!(t.new_mail_ids(), ["n1"]);
    assert_eq!(notch.mode(), NotchMode::Alert);
    t.flush(6_000).await;
    assert_eq!(notch.mode(), before);
}

#[tokio::test]
async fn alerts_new_mail_while_the_capsule_is_mini_pinned_by_the_user() {
    alerts_new_mail_while_the_capsule_is(NotchEvent::PinMini).await;
}

#[tokio::test]
async fn alerts_new_mail_while_the_capsule_is_hidden_yielding_to_fullscreen() {
    alerts_new_mail_while_the_capsule_is(NotchEvent::Foreground {
        verdict: Yielding::Hidden,
    })
    .await;
}

#[tokio::test]
async fn alerts_new_mail_while_the_capsule_is_hidden_by_the_user() {
    alerts_new_mail_while_the_capsule_is(NotchEvent::UserVisibility { hidden: true }).await;
}

#[tokio::test]
async fn alerts_mail_that_arrived_during_a_long_hidden_stretch_no_new_baseline() {
    let (t, notch) = wired();
    t.ready().await;
    t.flush(0).await;
    notch.dispatch(NotchEvent::UserVisibility { hidden: true });
    t.flush(30 * MIN).await;
    t.set_unread(with_new(&["n1"]));
    t.flush(MIN).await;
    assert_eq!(t.new_mail_ids(), ["n1"]);
    // And mail arriving while that alert shows still counts as new afterwards.
    t.set_unread(with_new(&["n2", "n1"]));
    t.flush(MIN).await;
    assert_eq!(t.new_mail_ids(), ["n1", "n2"]);
}

#[tokio::test]
async fn a_new_client_starts_a_new_baseline() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.set_unread(with_new(&["n1"]));
    t.change_settings("other", "x");
    t.flush(0).await;
    let result = t.sign_in();
    t.flush(0).await;
    t.finish_sign_in(None);
    result.await.unwrap();
    t.flush(0).await;
    assert!(t.new_mail().is_empty());
    t.set_unread(with_new(&["n2", "n1"]));
    t.flush(MIN).await;
    assert_eq!(t.new_mail_ids(), ["n2"]);
}

#[tokio::test]
async fn signing_out_and_in_again_starts_a_new_baseline_then_new_mail_alerts_again() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.sign_out().await;
    t.set_unread(with_new(&["n1"]));
    let result = t.sign_in();
    t.flush(0).await;
    t.finish_sign_in(None);
    result.await.unwrap();
    t.flush(0).await;
    assert!(t.new_mail().is_empty());
    t.set_unread(with_new(&["n2", "n1"]));
    t.flush(MIN).await;
    assert_eq!(t.new_mail_ids(), ["n2"]);
}

#[tokio::test]
async fn a_new_session_starts_a_new_baseline() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    t.integration.sign_out().await;
    t.set_unread(with_new(&["n1"]));
    let result = t.sign_in();
    t.flush(0).await;
    t.finish_sign_in(None);
    result.await.unwrap();
    t.flush(0).await;
    assert!(t.new_mail().is_empty());
}

// ---------------------------------------------------------------------------------------------
// permission (scope)

#[tokio::test]
async fn a_refresh_without_the_full_mail_scope_expires_with_reason_scope_and_no_more_requests() {
    let t = setup(Setup {
        prepare_auth: Some(Arc::new(|a: &FakeAuth| {
            let old = a.refreshed("AT-old", HOUR_MS, Some(READONLY));
            a.refresh.lock().unwrap().set(Ok(old));
        })),
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.status(), GmailStatus::Expired);
    assert_eq!(t.state().reason, Some(GmailExpiredReason::Scope));
    assert_eq!(t.last_state().status, GmailStatus::Expired);
    assert_eq!(t.last_state().reason, Some(GmailExpiredReason::Scope));
    assert_eq!(t.requests(), 0);
    let refreshes = t.auth(0).refresh_count();
    t.integration.refresh();
    t.flush(30 * MIN).await;
    assert_eq!(t.requests(), 0);
    assert_eq!(t.auth(0).refresh_count(), refreshes);
    assert_eq!(t.store.count("clear"), 0);

    // Signing in again with the full scope clears the reason.
    let result = t.sign_in();
    t.flush(0).await;
    t.finish_sign_in(Some("https://mail.google.com/"));
    assert_eq!(result.await.unwrap(), GmailSignInResult::Ok);
    t.flush(0).await;
    assert_eq!(t.status(), GmailStatus::Ok);
    assert_eq!(t.state().reason, None);
}

#[tokio::test]
async fn a_refresh_with_the_full_scope_among_others_is_fine() {
    let t = setup(Setup {
        prepare_auth: Some(Arc::new(|a: &FakeAuth| {
            let both = a.refreshed("AT", HOUR_MS, Some("openid https://mail.google.com/"));
            a.refresh.lock().unwrap().set(Ok(both));
        })),
        ..Setup::default()
    });
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.status(), GmailStatus::Ok);
    assert_eq!(t.state().reason, None);
}

#[tokio::test]
async fn a_sign_in_that_did_not_grant_the_full_scope_is_not_kept() {
    let t = setup(Setup {
        token: None,
        ..Setup::default()
    });
    t.ready().await;
    let result = t.sign_in();
    t.flush(0).await;
    t.finish_sign_in(Some(READONLY));
    assert_eq!(result.await.unwrap(), GmailSignInResult::Error);
    assert_eq!(t.status(), GmailStatus::Expired);
    assert_eq!(t.state().reason, Some(GmailExpiredReason::Scope));
    assert_eq!(t.store.count("save"), 0);
    assert_eq!(t.requests(), 0);
}

// ---------------------------------------------------------------------------------------------
// privacy of mail data

#[tokio::test]
async fn never_logs_bodies_links_subjects_or_senders() {
    let t = setup(Setup::default());
    t.show_list().await;
    t.integration.message("m1").await.unwrap();
    t.integration.open_link("m1", 0).unwrap();
    assert_eq!(
        refusal(t.integration.open_link("m1", 9)),
        IpcErrorCode::InvalidInput
    );
    t.integration.mark_read("m1").await.unwrap();
    t.api
        .remove
        .lock()
        .unwrap()
        .once(Err(api(GmailApiError::Server)));
    let _ = t.integration.remove("m2").await;
    t.set_unread(with_new(&["n1"]));
    t.flush(MIN).await;
    assert_eq!(t.new_mail().len(), 1);
    assert_no_secret(
        &gmail_log(),
        &[
            "Body m1",
            "example.com/m1",
            "Subject n1",
            "Sender n1",
            "Subject m1",
            "Sender m1",
            "m1@example.com",
        ],
    );
}

// ---------------------------------------------------------------------------------------------
// Rust-only cases of the part-6 plan

/// The fake Google answers until `fail` is set; then every request goes to the real
/// [`ReqwestTransport`] aimed at a loopback port that is bound but never listens (a network that
/// went down: the connection is refused).
struct Switch {
    real: ReqwestTransport,
    fail: AtomicBool,
    real_requests: AtomicUsize,
}

const METADATA: &str = r#"{"id":"m1","threadId":"thread-m1","snippet":"Snippet m1","labelIds":["UNREAD"],"internalDate":"1793001600000","payload":{"headers":[{"name":"From","value":"Sender m1 <m1@example.com>"},{"name":"Subject","value":"Subject m1"},{"name":"Date","value":"Wed, 11 Nov 2026 09:00:00 GMT"}]}}"#;

impl Transport for Switch {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, TransportError>> {
        if self.fail.load(Ordering::SeqCst) {
            self.real_requests.fetch_add(1, Ordering::SeqCst);
            return self.real.send(request);
        }
        let body = if request.url.ends_with("/profile") {
            r#"{"emailAddress":"me@example.com","messagesTotal":7}"#.to_owned()
        } else if request.url.contains("format=metadata") {
            METADATA.to_owned()
        } else if request.url.contains("maxResults=5") {
            r#"{"messages":[{"id":"m1","threadId":"thread-m1"}]}"#.to_owned()
        } else {
            r#"{"messages":[{"id":"u1","threadId":"t1"},{"id":"u2","threadId":"t2"}]}"#.to_owned()
        };
        let response = HttpResponse::new(200).with_body(body.into_bytes());
        Box::pin(async move { Ok(response) })
    }
}

/// Waits (real time) until `done` holds, at most 30 s.
async fn eventually(what: &str, done: impl Fn() -> bool) {
    for _ in 0..3_000 {
        if done() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

#[tokio::test]
async fn offline_when_google_unreachable_keeps_last_count() {
    // Bound and kept for the whole test (nothing else can take the port), never listening: every
    // connection is refused.
    let reserved = tokio::net::TcpSocket::new_v4().unwrap();
    reserved.bind("127.0.0.1:0".parse().unwrap()).unwrap();
    let closed = format!("http://127.0.0.1:{}", reserved.local_addr().unwrap().port());
    let switch = Arc::new(Switch {
        real: ReqwestTransport::with_limits(Duration::from_secs(10), 1 << 20).unwrap(),
        fail: AtomicBool::new(false),
        real_requests: AtomicUsize::new(0),
    });
    let client: ClientFactory = {
        let switch = Arc::clone(&switch);
        Arc::new(move |access: Arc<dyn TokenAccess>| {
            Arc::new(GmailClient::new(
                Arc::clone(&switch) as Arc<dyn Transport>,
                closed.clone(),
                access,
            )) as Arc<dyn GmailApiClient>
        })
    };
    let t = setup(Setup {
        client: Some(client),
        ..Setup::default()
    });
    t.ready().await;
    t.integration.set_view_open(true);
    t.flush(0).await;
    eventually("the first poll", || t.state().unread == Some(2)).await;
    let first = t.state();
    assert_eq!(first.status, GmailStatus::Ok);
    assert_eq!(first.account.as_deref(), Some("me@example.com"));
    let recent = t.integration.recent().await;
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].id, "m1");

    // The network goes down: every request is refused by the OS.
    switch.fail.store(true, Ordering::SeqCst);
    t.flush(TICK_MS).await;
    let mut before = 0;
    for wait in BACKOFF_MS {
        eventually("the backoff timer", || t.timers.next_due_in() == Some(wait)).await;
        let sent = switch.real_requests.load(Ordering::SeqCst);
        assert!(sent > before, "{sent} real requests after {before}");
        before = sent;
        let offline = t.state();
        assert_eq!(offline.status, GmailStatus::Offline);
        assert_eq!(offline.account, first.account);
        assert_eq!(offline.unread, first.unread);
        assert_eq!(offline.updated_at, first.updated_at);
        assert_eq!(t.integration.recent().await, recent);
        t.flush(wait - 1).await;
        assert_eq!(t.timers.next_due_in(), Some(1));
        t.flush(1).await;
    }
    eventually("the last backoff", || {
        t.timers.next_due_in() == Some(BACKOFF_MS[3])
    })
    .await;
    assert!(gmail_log()
        .iter()
        .any(|line| line.contains("Gmail query failed code=network retryInMs=60000")));
    assert_eq!(t.store.count("clear"), 0);
    // Back online: it recovers on its own at the next try.
    switch.fail.store(false, Ordering::SeqCst);
    t.flush(BACKOFF_MS[3]).await;
    eventually("the recovery", || t.status() == GmailStatus::Ok).await;
    eventually("the normal rhythm", || {
        t.timers.next_due_in() == Some(TICK_MS)
    })
    .await;
    drop(reserved);
}

#[tokio::test]
async fn an_older_state_snapshot_that_reaches_the_emitter_last_is_dropped() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.status(), GmailStatus::Ok);
    // A: a publish decided under the lock ("ok") whose emit is delayed, as on another worker...
    let mut late = Vec::new();
    {
        let mut inner = t.integration.lock();
        t.integration.publish(&mut inner, &mut late);
    }
    // ...B: a sign-out decided after it, and emitted first.
    t.integration.sign_out().await;
    let emitted = t.states.lock().unwrap().len();
    assert_eq!(t.last_state(), state(GmailStatus::SignedOut));
    // A arrives last: its older snapshot never reaches the renderer.
    t.integration.run(late);
    assert_eq!(t.states.lock().unwrap().len(), emitted);
    assert_eq!(t.last_state(), t.state());
    // A newer publish still goes out.
    let result = t.sign_in();
    t.flush(0).await;
    t.finish_sign_in(None);
    result.await.unwrap();
    assert_eq!(t.last_state().status, GmailStatus::Ok);
}

#[tokio::test]
async fn no_gmail_log_carries_tokens_or_mail_data() {
    let t = setup(Setup::default());
    t.show_list().await;
    t.integration.message("m1").await.unwrap();
    t.integration.open_link("m1", 0).unwrap();
    let _ = t.integration.open_link("m1", 7);
    t.integration.open(Some("never-shown"));
    t.integration.open(Some("m2"));
    let _ = t.integration.mark_read("unknown-id").await;
    t.api
        .message
        .lock()
        .unwrap()
        .once(Err(api(GmailApiError::InvalidResponse)));
    let _ = t.integration.message("m2").await;
    t.api
        .recent
        .lock()
        .unwrap()
        .once(Err(api(GmailApiError::RateLimited)));
    t.set_unread(with_new(&["n1"]));
    t.flush(MIN).await;
    t.api
        .summary
        .lock()
        .unwrap()
        .once(Err(api(GmailApiError::Server)));
    t.set_unread(with_new(&["n2", "n1"]));
    t.flush(MIN).await;
    t.api
        .unread_ids
        .lock()
        .unwrap()
        .once(Err(api(GmailApiError::Network)));
    t.flush(MIN).await;
    t.integration.remove("m1").await.unwrap();
    // A sign-in that fails, one that lacks the scope, one that works; a client change; a scope
    // refresh that expires; a sign-out.
    let result = t.sign_in();
    t.flush(0).await;
    t.fail_sign_in(GmailAuthError::Denied);
    result.await.unwrap();
    let result = t.sign_in();
    t.flush(0).await;
    t.finish_sign_in(Some(READONLY));
    result.await.unwrap();
    let result = t.sign_in();
    t.flush(0).await;
    t.finish_sign_in(None);
    result.await.unwrap();
    t.flush(0).await;
    let auth = t.auth(0);
    let readonly = auth.refreshed("AT-readonly-secret", HOUR_MS, Some(READONLY));
    auth.refresh.lock().unwrap().set(Ok(readonly));
    t.access().on_unauthorized().await.unwrap();
    t.flush(MIN).await;
    t.change_settings("cid-2", "csecret-2");
    t.flush(0).await;
    t.integration.sign_out().await;

    let log = gmail_log();
    assert!(log.len() >= 10, "{log:?}");
    assert!(log.iter().all(|line| line.contains("gmail")));
    assert_no_secret(
        &log,
        &[
            "RT-",
            "AT-",
            "csecret",
            "cid",
            "me@example.com",
            "Subject",
            "Sender",
            "Snippet",
            "Body",
            "example.com",
            "thread-",
            "mail.google.com",
            "http",
            "m1",
            "m2",
            "n1",
            "n2",
            "never-shown",
            "unknown-id",
        ],
    );
    for expected in [
        "Gmail status status=ok",
        "Refused a Gmail action on a message not shown in the notch action=mark-read",
        "Refused to open a message not shown in the notch",
        "Refused to open a link outside the open message",
        "Gmail action failed action=message code=invalid-response",
        "Gmail recent list failed code=rate-limited",
        "Gmail new mail count=1",
        "Gmail new-mail details failed code=server",
        "Gmail query failed code=network retryInMs=60000",
        "Gmail action done action=delete",
        "Gmail sign-in did not finish code=denied",
        "Gmail sign-in lacks the full mail permission",
        "Gmail session expired code=denied reason=scope",
        "Gmail client changed; session closed",
    ] {
        assert!(
            log.iter().any(|line| line.contains(expected)),
            "{expected} missing from {log:?}"
        );
    }
}

#[tokio::test]
async fn a_dropped_waiter_never_strands_the_shared_refresh() {
    let t = setup(Setup {
        started: false,
        ..Setup::default()
    });
    t.ready().await;
    let auth_for = |owner| AccessFor {
        integration: Arc::downgrade(&t.integration),
        owner,
    };
    // The only waiter starts the refresh, then is dropped (a cancelled `map_pool` row).
    let pending = {
        let mut inner = t.integration.lock();
        t.integration.session_auth(&mut inner);
        t.auth(0).refresh.lock().unwrap().once_later()
    };
    let g = t.g();
    let dropped = tokio::spawn(async move {
        let access = AccessFor {
            integration: Arc::downgrade(&g),
            owner: 0,
        };
        access.access_token().await
    });
    settle().await;
    assert_eq!(t.auth(0).refresh_count(), 1);
    dropped.abort();
    assert!(dropped.await.unwrap_err().is_cancelled());
    // The refresh still finishes on its own...
    let fresh = t.auth(0).refreshed("AT-shared", HOUR_MS, None);
    pending.resolve(Ok(fresh));
    settle().await;
    assert!(t.integration.lock().refreshing.is_none());
    // ...and a later call gets its token without a second refresh.
    assert_eq!(auth_for(0).access_token().await.as_deref(), Ok("AT-shared"));
    assert_eq!(t.auth(0).refresh_count(), 1);
}

#[tokio::test]
async fn an_old_generation_refresh_finishing_after_a_new_sign_in_changes_nothing() {
    let t = setup(Setup {
        started: false,
        ..Setup::default()
    });
    t.ready().await;
    let access_for = |owner| AccessFor {
        integration: Arc::downgrade(&t.integration),
        owner,
    };
    let old_generation = t.integration.lock().generation;
    let old_refresh = {
        let mut inner = t.integration.lock();
        t.integration.session_auth(&mut inner);
        t.auth(0).refresh.lock().unwrap().once_later()
    };
    let old_waiter = {
        let access = access_for(old_generation);
        tokio::spawn(async move { access.access_token().await })
    };
    settle().await;
    assert_eq!(t.auth(0).refresh_count(), 1);

    // Signed out and in again: a new generation with its own access token.
    t.integration.sign_out().await;
    let result = t.sign_in();
    t.flush(0).await;
    t.finish_sign_in(None);
    assert_eq!(result.await.unwrap(), GmailSignInResult::Ok);
    settle().await;
    let new_generation = t.integration.lock().generation;
    assert_ne!(new_generation, old_generation);
    // Inside the 60 s margin: the new generation starts its own refresh, keeping its token.
    t.clock.advance(HOUR_MS as i64 - 30_000);
    let new_refresh = t.auth(0).refresh.lock().unwrap().once_later();
    let new_waiter = {
        let access = access_for(new_generation);
        tokio::spawn(async move { access.access_token().await })
    };
    settle().await;
    assert_eq!(t.auth(0).refresh_count(), 2);

    // The old refresh finishes only now.
    old_refresh.resolve(Ok(t.auth(0).refreshed("AT-old", HOUR_MS, None)));
    settle().await;
    assert_eq!(
        old_waiter.await.unwrap(),
        Err(api(GmailApiError::Unauthorized))
    );
    {
        let inner = t.integration.lock();
        assert_eq!(
            inner.access.as_ref().map(|access| access.token.as_str()),
            Some("AT-new")
        );
        assert!(inner
            .refreshing
            .as_ref()
            .is_some_and(|slot| slot.generation == new_generation));
    }
    // The new slot still settles its own waiter.
    new_refresh.resolve(Ok(t.auth(0).refreshed("AT-next", HOUR_MS, None)));
    assert_eq!(new_waiter.await.unwrap().as_deref(), Ok("AT-next"));
    assert_eq!(t.auth(0).refresh_count(), 2);
}

#[tokio::test]
async fn concurrent_waiters_share_one_refresh_per_generation() {
    let t = setup(Setup {
        started: false,
        ..Setup::default()
    });
    t.ready().await;
    let pending = {
        let mut inner = t.integration.lock();
        t.integration.session_auth(&mut inner);
        t.auth(0).refresh.lock().unwrap().once_later()
    };
    let calls: Vec<_> = (0..3)
        .map(|_| {
            let g = t.g();
            tokio::spawn(async move {
                AccessFor {
                    integration: Arc::downgrade(&g),
                    owner: 0,
                }
                .access_token()
                .await
            })
        })
        .collect();
    settle().await;
    let fresh = t.auth(0).refreshed("AT-one", HOUR_MS, None);
    pending.resolve(Ok(fresh));
    for call in calls {
        assert_eq!(call.await.unwrap().as_deref(), Ok("AT-one"));
    }
    assert_eq!(t.auth(0).refresh_count(), 1);
}

#[tokio::test]
async fn a_timer_that_fires_after_it_was_replaced_does_not_poll() {
    let t = setup(Setup::default());
    t.ready().await;
    t.flush(0).await;
    assert_eq!(t.api.unread_calls(), 1);
    t.integration.timer_fired(u64::MAX);
    t.flush(0).await;
    assert_eq!(t.api.unread_calls(), 1);
    t.flush(TICK_MS).await;
    assert_eq!(t.api.unread_calls(), 2);
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
    }
    let emitted = t.states.lock().unwrap().len();
    t.integration.dispose();
    t.integration.run(late);
    t.integration.refresh();
    t.integration.set_view_open(true);
    t.flush(TICK_MS).await;
    assert_eq!(t.states.lock().unwrap().len(), emitted);
    // A sign-in after dispose opens nothing.
    assert_eq!(t.integration.sign_in().await, GmailSignInResult::Error);
    assert_eq!(t.auth(0).sign_in_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn a_cancel_right_after_sign_in_starts_reaches_it() {
    // `sign_in` registers with the auth under the lock: a cancel that runs as soon as the call
    // has started (before its future is polled again) still cancels it.
    let t = setup(Setup {
        token: None,
        ..Setup::default()
    });
    t.ready().await;
    let g = t.g();
    let mut call = Box::pin(async move { g.sign_in().await });
    assert!(futures_poll_once(&mut call).await.is_none());
    t.integration.cancel_sign_in();
    assert_eq!(call.await, GmailSignInResult::Cancelled);
    assert_eq!(t.status(), GmailStatus::SignedOut);
}

/// Polls `future` once; `Some` when it finished.
async fn futures_poll_once<F: std::future::Future + Unpin>(future: &mut F) -> Option<F::Output> {
    std::future::poll_fn(|cx| {
        std::task::Poll::Ready(match std::pin::Pin::new(&mut *future).poll(cx) {
            std::task::Poll::Ready(value) => Some(value),
            std::task::Poll::Pending => None,
        })
    })
    .await
}
