//! The Claude Code service (port of `src/main/claude/claude-service.ts`): ties the hooks bridge,
//! the hook installer, the permission and question brokers and the session registry together,
//! and publishes every change to the integration callbacks.
//!
//! Concurrency (the TS service is single-threaded; here hook events arrive on tokio workers,
//! disconnects on others, channel calls anywhere):
//! - `core` (a std `Mutex`) holds the bridge config, the connection flags and the session
//!   registry. It is only held for short synchronous sections; it may be held while a broker's
//!   own lock is taken (`pending()`), never the other way round (the brokers call out with their
//!   lock released).
//! - Hook events are processed one at a time (`events`). While one is processed, the brokers'
//!   `on_change` on the same thread does nothing (the TS `inEvent` flag): the event syncs the
//!   `waiting` sessions and publishes once at its end. A change from another thread (Claude
//!   hanging up) syncs and publishes at once.
//! - Publishing is one serialized path: a request marks what is due and the thread that is
//!   already delivering (or this one) delivers until nothing is due, building each state at
//!   delivery time. So the last `on_state` / `on_questions` always carries the latest state (a
//!   stale `ClaudeFirst` can never land last), and no lock is held while the callbacks dispatch
//!   to the notch, emit events or show toasts.
//! - `serial` (a tokio `Mutex`) runs start, stop, the hook operations and the rotations one at
//!   a time. `stop` raises `stopped` before waiting for its turn, so a start, a rotation or a
//!   hook install/uninstall that gets its turn after it does nothing: no bridge starts again and
//!   neither `claude-bridge.json` nor Claude's settings are written during quit. The tick's hook
//!   refresh also runs under `serial` (skipped when busy), so it never overwrites the status an
//!   operation has just set.
//!
//! Logs carry ids, enum names and counts only: never a question, an option, an answer, a
//! command, a path or the token.

use std::collections::HashSet;
use std::io;
use std::net::Ipv4Addr;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread::ThreadId;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::bridge::{BridgeError, ClaudeBridge, HookRoute, OnEvent, PendingReply, TOKEN_HEADER};
pub use super::bridge_config::BridgeConfig;
use super::diff::mask_diff;
use super::hook_events::{HookEvent, HookEventName};
use super::hook_installer::{
    HookInstallOptions, HookInstaller, HookPlan, HookStatus, HookWriteResult,
};
use super::permission_broker::{lock, NewId, Now, PermissionBroker, PermissionBrokerOptions};
pub use super::question_broker::AnswerResult;
use super::question_broker::{QuestionBroker, QuestionBrokerOptions};
use super::questions::display_questions;
use super::session_registry::{SessionRegistry, SessionRegistryOptions};
use crate::contract::claude::{
    BoolLiteral, ClaudeConnection, ClaudeConnectionErrorReason, ClaudeHooksStatus, Decision,
    DiffLine, HooksPreview, HooksPreviewDiff, HooksWrite, HooksWritten, InvalidJson,
    QuestionAnswer, RotateHooks, RotateOutcome,
};
pub use crate::contract::claude::{
    ClaudeState, PendingPermission, PendingQuestionView, TestConnectionResult,
};
use crate::contract::text::is_uuid;
pub use crate::ipc::BoxFuture;
use crate::ipc::{ExposedError, IpcErrorCode};

/// Session id used by "test connection"; its events never become a session.
pub const CONNECTION_TEST_SESSION_ID: &str = "developer-notch-connection-test";

const TEST_TIMEOUT: Duration = Duration::from_millis(3_000);
/// Largest answer `test_connection` reads (the bridge answers with an empty body).
const TEST_RESPONSE_MAX_BYTES: u64 = 64 * 1024;

/// How long the quit cleanup waits for the bridge to stop: its 500 ms grace plus margin, inside
/// the 2 000 ms cleanup budget (`QUIT_CLEANUP_MS`).
pub const QUIT_STOP_WAIT: Duration = Duration::from_millis(1_500);

/// The hooks bridge as the service drives it (`ClaudeBridge` in TS).
pub trait Bridge: Send + Sync {
    /// Listens; the actual port (port 0 picks one).
    fn start(&self) -> BoxFuture<'_, Result<u16, BridgeError>>;
    /// Stops accepting, flushes and closes everything (bounded by the bridge's grace period).
    fn stop(&self) -> BoxFuture<'_, ()>;
    fn port(&self) -> u16;
}

impl Bridge for ClaudeBridge {
    fn start(&self) -> BoxFuture<'_, Result<u16, BridgeError>> {
        Box::pin(ClaudeBridge::start(self))
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        Box::pin(ClaudeBridge::stop(self))
    }

    fn port(&self) -> u16 {
        ClaudeBridge::port(self)
    }
}

/// What a new bridge gets (`ClaudeBridgeOptions` without the logger).
pub struct BridgeOptions {
    pub port: u16,
    pub token: String,
    pub on_event: OnEvent,
}

/// The hook installer as the service uses it (`HookInstaller` in TS).
pub trait Installer: Send + Sync {
    fn preview<'a>(
        &'a self,
        options: &'a HookInstallOptions,
    ) -> BoxFuture<'a, io::Result<HookPlan>>;
    fn install<'a>(
        &'a self,
        options: &'a HookInstallOptions,
    ) -> BoxFuture<'a, io::Result<HookWriteResult>>;
    fn uninstall(&self) -> BoxFuture<'_, io::Result<HookWriteResult>>;
    fn status<'a>(
        &'a self,
        options: &'a HookInstallOptions,
    ) -> BoxFuture<'a, io::Result<HookStatus>>;
}

impl Installer for HookInstaller {
    fn preview<'a>(
        &'a self,
        options: &'a HookInstallOptions,
    ) -> BoxFuture<'a, io::Result<HookPlan>> {
        Box::pin(HookInstaller::preview(self, options))
    }

    fn install<'a>(
        &'a self,
        options: &'a HookInstallOptions,
    ) -> BoxFuture<'a, io::Result<HookWriteResult>> {
        Box::pin(HookInstaller::install(self, options))
    }

    fn uninstall(&self) -> BoxFuture<'_, io::Result<HookWriteResult>> {
        Box::pin(HookInstaller::uninstall(self))
    }

    fn status<'a>(
        &'a self,
        options: &'a HookInstallOptions,
    ) -> BoxFuture<'a, io::Result<HookStatus>> {
        Box::pin(HookInstaller::status(self, options))
    }
}

/// Loads or replaces the persisted bridge config.
pub type ConfigFn = Arc<dyn Fn() -> BoxFuture<'static, io::Result<BridgeConfig>> + Send + Sync>;

/// Receives the whole pending question list.
pub type OnQuestions = Arc<dyn Fn(&[PendingQuestionView]) + Send + Sync>;

/// `ClaudeServiceDeps`.
pub struct ClaudeServiceDeps {
    /// Wall clock in ms since the epoch (`Date.now()`; never the E2E test clock).
    pub now: Now,
    pub new_id: NewId,
    /// False when the OS cannot protect the token (DPAPI); the bridge then never starts.
    pub encryption_available: Arc<dyn Fn() -> bool + Send + Sync>,
    pub load_config: ConfigFn,
    pub rotate_config: ConfigFn,
    /// Persists a new random port (same token).
    pub rotate_port_config: ConfigFn,
    pub create_bridge: Arc<dyn Fn(BridgeOptions) -> Arc<dyn Bridge> + Send + Sync>,
    pub installer: Arc<dyn Installer>,
    pub focus_claude: Arc<dyn Fn() + Send + Sync>,
    /// Called after every state change.
    pub on_state: Arc<dyn Fn(&ClaudeState) + Send + Sync>,
    /// Called once per permission request when it starts waiting, after `on_state` listed it.
    pub on_new_pending: Arc<dyn Fn(&PendingPermission) + Send + Sync>,
    /// Called whenever the pending questions change (display-safe views, never the session id).
    pub on_questions: OnQuestions,
    /// Called once per question when it starts waiting, after `on_questions` listed it.
    pub on_new_question: Arc<dyn Fn(&PendingQuestionView) + Send + Sync>,
    /// Dev/test only: listen here instead of the stored port (0 = ephemeral); hooks are written
    /// with the real one.
    pub port_override: Option<u16>,
    pub idle_after_ms: Option<u64>,
}

struct Core {
    config: Option<BridgeConfig>,
    bridge: Option<Arc<dyn Bridge>>,
    bridge_running: bool,
    bridge_error: Option<ClaudeConnectionErrorReason>,
    hooks: ClaudeHooksStatus,
    event_seen: bool,
    /// Session ids with a held request, as of the last sync.
    pending_sessions: Vec<String>,
    announced: HashSet<String>,
    announced_questions: HashSet<String>,
    registry: SessionRegistry,
}

/// What is due to be published, and whether a thread is delivering it.
#[derive(Default)]
struct Delivery {
    running: bool,
    state: bool,
    /// The question list changed since it was last sent (`questionsDirty`).
    questions: bool,
}

/// `createClaudeService`.
pub struct ClaudeService {
    deps: ClaudeServiceDeps,
    me: Weak<ClaudeService>,
    core: Mutex<Core>,
    permissions: PermissionBroker,
    questions: QuestionBroker,
    delivery: Mutex<Delivery>,
    /// One hook event at a time.
    events: Mutex<()>,
    /// The thread processing a hook event (`inEvent`).
    in_event: Mutex<Option<ThreadId>>,
    /// Start, stop and the Control Center operations, one at a time (`serial`).
    serial: tokio::sync::Mutex<()>,
    stopped: AtomicBool,
    test_probe_seen: AtomicBool,
    /// One connection test at a time: they share `test_probe_seen`.
    testing: tokio::sync::Mutex<()>,
}

/// Clears `in_event` when the event is done, even if a broker panicked.
struct InEvent<'a>(&'a Mutex<Option<ThreadId>>);

impl Drop for InEvent<'_> {
    fn drop(&mut self) {
        *lock(self.0) = None;
    }
}

fn install_options(config: &BridgeConfig) -> HookInstallOptions {
    HookInstallOptions {
        port: config.port,
        token: config.token.clone(),
    }
}

fn hooks_status(status: HookStatus) -> ClaudeHooksStatus {
    match status {
        HookStatus::Installed => ClaudeHooksStatus::Installed,
        HookStatus::Outdated => ClaudeHooksStatus::Outdated,
        HookStatus::Missing => ClaudeHooksStatus::Missing,
    }
}

/// `EADDRINUSE`, and (deviation) `PermissionDenied`: on Windows a port inside a Hyper-V or WinNAT
/// reserved range fails to bind with WSAEACCES. Both mean "pick another port", which the
/// Control Center offers for `port-in-use`.
fn is_port_in_use(error: &BridgeError) -> bool {
    match error {
        BridgeError::PortInUse => true,
        BridgeError::Other(error) => error.kind() == io::ErrorKind::PermissionDenied,
    }
}

fn error_code(error: &BridgeError) -> String {
    match error {
        BridgeError::PortInUse => "EADDRINUSE".into(),
        BridgeError::Other(error) => format!("{:?}", error.kind()),
    }
}

fn unavailable() -> ExposedError {
    ExposedError::new(IpcErrorCode::Unavailable, "Claude bridge is not available")
}

/// The answer that hands a held request back to Claude's own prompt: an empty 200 on `/hook`,
/// `{}` on `/hook/question` (what the brokers' `release_all` sends).
fn release_reply(reply: &dyn PendingReply, route: HookRoute) {
    match route {
        HookRoute::Question => reply.send(Some("{}".into())),
        HookRoute::Hook => reply.send(None),
    }
}

fn io_failure(error: io::Error) -> ExposedError {
    ExposedError::internal(error.kind())
}

/// A renderer-supplied id reaches the log only when it is one of our UUIDs.
fn id_for_log(id: &str) -> &str {
    if is_uuid(id) {
        id
    } else {
        "-"
    }
}

fn answer_name(result: AnswerResult) -> &'static str {
    match result {
        AnswerResult::Sent => "sent",
        AnswerResult::Gone => "gone",
        AnswerResult::Invalid => "invalid",
    }
}

impl ClaudeService {
    pub fn new(deps: ClaudeServiceDeps) -> Arc<Self> {
        Arc::new_cyclic(|me: &Weak<Self>| {
            let registry = SessionRegistry::new(SessionRegistryOptions {
                now: Arc::clone(&deps.now),
                idle_after_ms: deps.idle_after_ms,
            });
            let permissions = PermissionBroker::new(PermissionBrokerOptions {
                new_id: Arc::clone(&deps.new_id),
                now: Arc::clone(&deps.now),
                session_name: {
                    let me = me.clone();
                    Arc::new(move |id: &str| {
                        me.upgrade()
                            .map(|service| service.name_of(id, None))
                            .unwrap_or_default()
                    })
                },
                on_change: {
                    let me = me.clone();
                    Arc::new(move || {
                        if let Some(service) = me.upgrade() {
                            service.broker_changed(false);
                        }
                    })
                },
            });
            let questions = QuestionBroker::new(QuestionBrokerOptions {
                new_id: Arc::clone(&deps.new_id),
                now: Arc::clone(&deps.now),
                session_name: {
                    let me = me.clone();
                    Arc::new(move |id: &str, cwd: Option<&str>| {
                        me.upgrade()
                            .map(|service| service.name_of(id, cwd))
                            .unwrap_or_default()
                    })
                },
                on_change: {
                    let me = me.clone();
                    Arc::new(move || {
                        if let Some(service) = me.upgrade() {
                            service.broker_changed(true);
                        }
                    })
                },
            });
            Self {
                deps,
                me: me.clone(),
                core: Mutex::new(Core {
                    config: None,
                    bridge: None,
                    bridge_running: false,
                    bridge_error: None,
                    hooks: ClaudeHooksStatus::Unknown,
                    event_seen: false,
                    pending_sessions: Vec::new(),
                    announced: HashSet::new(),
                    announced_questions: HashSet::new(),
                    registry,
                }),
                permissions,
                questions,
                delivery: Mutex::default(),
                events: Mutex::new(()),
                in_event: Mutex::new(None),
                serial: tokio::sync::Mutex::new(()),
                stopped: AtomicBool::new(false),
                test_probe_seen: AtomicBool::new(false),
                testing: tokio::sync::Mutex::new(()),
            }
        })
    }

    fn name_of(&self, id: &str, cwd: Option<&str>) -> String {
        lock(&self.core).registry.name_of(id, cwd)
    }

    fn state_of(&self, core: &Core) -> ClaudeState {
        let connection = if core.config.is_none() || !core.bridge_running {
            ClaudeConnection::Error
        } else if core.hooks == ClaudeHooksStatus::Missing {
            ClaudeConnection::NotInstalled
        } else if core.event_seen {
            ClaudeConnection::Connected
        } else {
            ClaudeConnection::WaitingForEvents
        };
        ClaudeState {
            connection,
            reason: if connection == ClaudeConnection::Error {
                core.bridge_error
            } else {
                None
            },
            hooks: core.hooks,
            sessions: core.registry.sessions(),
            pending: self.permissions.pending(),
        }
    }

    pub fn state(&self) -> ClaudeState {
        let core = lock(&self.core);
        self.state_of(&core)
    }

    /// Sessions with something held for the user (they never go idle meanwhile), in order.
    fn held_sessions(&self) -> Vec<String> {
        let mut held: Vec<String> = Vec::new();
        let ids = self
            .permissions
            .pending()
            .into_iter()
            .map(|permission| permission.session_id)
            .chain(
                self.questions
                    .pending()
                    .into_iter()
                    .map(|question| question.session_id),
            );
        for id in ids {
            if !held.contains(&id) {
                held.push(id);
            }
        }
        held
    }

    /// A session with a held permission or question is `waiting` (even after a later event of
    /// it said `working`); one whose last held request went away leaves `waiting`. `first`
    /// names a session first seen through the request being held.
    fn sync_waiting(&self, first: Option<(&str, Option<&str>)>) {
        let mut core = lock(&self.core);
        let held = self.held_sessions();
        let previous = std::mem::take(&mut core.pending_sessions);
        for id in previous.iter().filter(|id| !held.contains(id)) {
            core.registry.resolve_waiting(id);
        }
        for id in &held {
            let cwd = first
                .filter(|(session, _)| session == id)
                .and_then(|(_, cwd)| cwd);
            core.registry.mark_waiting(id, cwd);
        }
        core.pending_sessions = held;
    }

    fn in_event_here(&self) -> bool {
        *lock(&self.in_event) == Some(std::thread::current().id())
    }

    /// Outside a hook event, a broker change is synced and published at once; the event does it
    /// at its end.
    fn broker_changed(&self, questions: bool) {
        if questions {
            lock(&self.delivery).questions = true;
        }
        if self.in_event_here() {
            return;
        }
        self.sync_waiting(None);
        self.publish();
    }

    /// `publish()` (and `publishQuestions()` when the list changed).
    fn publish(&self) {
        {
            let mut delivery = lock(&self.delivery);
            delivery.state = true;
            if delivery.running {
                return;
            }
            delivery.running = true;
        }
        loop {
            let (state, questions) = {
                let mut delivery = lock(&self.delivery);
                let due = (
                    std::mem::take(&mut delivery.state),
                    std::mem::take(&mut delivery.questions),
                );
                if due == (false, false) {
                    delivery.running = false;
                    return;
                }
                due
            };
            if state && catch_unwind(AssertUnwindSafe(|| self.deliver_state())).is_err() {
                log::error!("Claude state publish failed");
            }
            if questions && catch_unwind(AssertUnwindSafe(|| self.deliver_questions())).is_err() {
                log::error!("Claude questions publish failed");
            }
        }
    }

    /// `on_state`, then `on_new_pending` for each request not announced yet.
    fn deliver_state(&self) {
        let (state, fresh) = {
            let mut core = lock(&self.core);
            let state = self.state_of(&core);
            let ids: HashSet<&str> = state.pending.iter().map(|p| p.id.as_str()).collect();
            core.announced.retain(|id| ids.contains(id.as_str()));
            let fresh: Vec<PendingPermission> = state
                .pending
                .iter()
                .filter(|permission| core.announced.insert(permission.id.clone()))
                .cloned()
                .collect();
            (state, fresh)
        };
        (self.deps.on_state)(&state);
        for permission in &fresh {
            (self.deps.on_new_pending)(permission);
        }
    }

    fn question_views(&self) -> Vec<PendingQuestionView> {
        self.questions
            .pending()
            .into_iter()
            .map(|question| PendingQuestionView {
                id: question.id,
                project: question.project,
                questions: display_questions(&question.questions),
                arrived_at: question.arrived_at as f64,
            })
            .collect()
    }

    /// `on_questions`, then `on_new_question` for each question not announced yet.
    fn deliver_questions(&self) {
        let views = self.question_views();
        let fresh: Vec<PendingQuestionView> = {
            let mut core = lock(&self.core);
            let ids: HashSet<&str> = views.iter().map(|q| q.id.as_str()).collect();
            core.announced_questions
                .retain(|id| ids.contains(id.as_str()));
            views
                .iter()
                .filter(|question| core.announced_questions.insert(question.id.clone()))
                .cloned()
                .collect()
        };
        (self.deps.on_questions)(&views);
        for question in &fresh {
            (self.deps.on_new_question)(question);
        }
    }

    fn on_event(&self, e: HookEvent, reply: Option<Arc<dyn PendingReply>>, route: HookRoute) {
        if e.session_id == CONNECTION_TEST_SESSION_ID {
            self.test_probe_seen.store(true, Ordering::SeqCst);
            if let Some(reply) = reply {
                reply.send(None);
            }
            return;
        }
        // The question route only matters for the AskUserQuestion call it holds: Claude sends
        // the same call to /hook too, where it is observed like every other event.
        if route == HookRoute::Question && reply.is_none() {
            return;
        }
        // While stopping, nothing new is held: Claude gets its answer at once and asks in its own
        // window (what `release_all` sends).
        if self.is_stopped() {
            if let Some(reply) = reply {
                release_reply(&*reply, route);
                return;
            }
        }
        {
            let _turn = lock(&self.events);
            *lock(&self.in_event) = Some(std::thread::current().id());
            let _in_event = InEvent(&self.in_event);
            lock(&self.core).event_seen = true;
            match (route, reply) {
                (HookRoute::Question, Some(reply)) => self.questions.hold(&e, reply),
                (_, reply) => {
                    lock(&self.core).registry.apply(&e);
                    self.questions.observe(&e);
                    // observe first: nothing that arrived before this request may release it.
                    match reply {
                        Some(reply) if e.name == HookEventName::PermissionRequest => {
                            self.permissions.hold(&e, reply);
                        }
                        _ => self.permissions.observe(&e),
                    }
                }
            }
            // A stop that began while this request was being held: its `release_all` may have run
            // before the hold, so release again (a no-op otherwise).
            if self.is_stopped() {
                self.release_all();
            }
            // After the brokers: a Stop that released the session's requests leaves it `done`.
            self.sync_waiting(Some((&e.session_id, e.cwd.as_deref())));
        }
        self.publish();
    }

    /// `installer.status`; `unknown` without a config or when the file cannot be read. True if
    /// it changed.
    async fn refresh_hooks(&self) -> bool {
        let config = lock(&self.core).config.clone();
        let next = match config {
            None => ClaudeHooksStatus::Unknown,
            Some(config) => match self.deps.installer.status(&install_options(&config)).await {
                Ok(status) => hooks_status(status),
                Err(error) => {
                    log::warn!("Could not read Claude settings ({:?})", error.kind());
                    ClaudeHooksStatus::Unknown
                }
            },
        };
        let mut core = lock(&self.core);
        let changed = core.hooks != next;
        core.hooks = next;
        changed
    }

    async fn start_bridge(&self, current: BridgeConfig) {
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        let on_event: OnEvent = {
            let me = self.me.clone();
            Arc::new(move |e, reply, route| {
                if let Some(service) = me.upgrade() {
                    service.on_event(e, reply, route);
                }
            })
        };
        let bridge = (self.deps.create_bridge)(BridgeOptions {
            port: self.deps.port_override.unwrap_or(current.port),
            token: current.token.clone(),
            on_event,
        });
        lock(&self.core).bridge = Some(Arc::clone(&bridge));
        let started = bridge.start().await;
        let mut core = lock(&self.core);
        match started {
            Ok(_) => {
                core.bridge_running = true;
                core.bridge_error = None;
                if self.deps.port_override.is_some() {
                    core.config = Some(BridgeConfig {
                        port: bridge.port(),
                        ..current
                    });
                }
            }
            Err(error) => {
                core.bridge_running = false;
                core.bridge_error =
                    is_port_in_use(&error).then_some(ClaudeConnectionErrorReason::PortInUse);
                drop(core);
                log::warn!(
                    "Claude bridge could not start port={} code={}",
                    current.port,
                    error_code(&error)
                );
            }
        }
    }

    fn release_all(&self) {
        self.permissions.release_all();
        self.questions.release_all();
    }

    async fn stop_bridge(&self) {
        self.release_all();
        let bridge = {
            let mut core = lock(&self.core);
            core.bridge_running = false;
            core.bridge.take()
        };
        if let Some(bridge) = bridge {
            bridge.stop().await;
        }
    }

    fn require_config(&self) -> Result<BridgeConfig, ExposedError> {
        lock(&self.core).config.clone().ok_or_else(unavailable)
    }

    /// Unavailable once `stop` began: called after taking the `serial` turn, so an operation
    /// queued behind (or racing) the quit writes nothing.
    fn require_running(&self) -> Result<(), ExposedError> {
        if self.is_stopped() {
            Err(unavailable())
        } else {
            Ok(())
        }
    }

    fn mask(&self, diff: &[DiffLine]) -> Vec<DiffLine> {
        let token = lock(&self.core)
            .config
            .as_ref()
            .map(|config| config.token.clone());
        mask_diff(diff, token.as_deref())
    }

    fn written(&self, result: HookWriteResult) -> HooksWrite {
        match result {
            Ok(outcome) => HooksWrite::Written(HooksWritten {
                ok: BoolLiteral,
                changed: outcome.changed,
                diff: self.mask(&outcome.diff),
                backup_file: outcome
                    .backup_file
                    .map(|path| path.to_string_lossy().into_owned()),
            }),
            Err(_) => HooksWrite::InvalidJson(InvalidJson::VALUE),
        }
    }

    pub async fn start(&self) {
        let _turn = self.serial.lock().await;
        if self.stopped.load(Ordering::SeqCst) {
            return;
        }
        if (self.deps.encryption_available)() {
            match (self.deps.load_config)().await {
                Ok(config) => lock(&self.core).config = Some(config),
                Err(error) => {
                    log::error!(
                        "Could not load the Claude bridge config ({:?})",
                        error.kind()
                    );
                }
            }
            let config = lock(&self.core).config.clone();
            if let Some(config) = config {
                self.start_bridge(config).await;
            }
        } else {
            log::warn!("Encryption is unavailable; the Claude bridge stays off");
        }
        self.refresh_hooks().await;
        self.publish();
    }

    /// Releases every held request without a decision (Claude asks in its own window), then
    /// stops the bridge. Wins over a start that has not run yet: no bridge starts afterwards.
    pub async fn stop(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        // At once, even if a Control Center operation still has its turn.
        self.release_all();
        let _turn = self.serial.lock().await;
        self.stop_bridge().await;
    }

    pub fn is_stopped(&self) -> bool {
        self.stopped.load(Ordering::SeqCst)
    }

    /// Periodic housekeeping: idle sessions and hooks edited outside the app. The hook refresh
    /// takes `serial` and is skipped while an operation has it (that operation refreshes them
    /// itself), so an older status read here can never overwrite a fresher one.
    pub async fn tick(&self) {
        let idle_changed = {
            let mut core = lock(&self.core);
            let held: HashSet<String> = self.held_sessions().into_iter().collect();
            core.registry.tick(&held)
        };
        let hooks_changed = match self.serial.try_lock() {
            Ok(_turn) => self.refresh_hooks().await,
            Err(_) => false,
        };
        if idle_changed || hooks_changed {
            self.publish();
        }
    }

    pub fn decide(&self, id: &str, decision: Decision) -> bool {
        self.permissions.decide(id, decision)
    }

    /// Pending AskUserQuestion calls, oldest first, as the notch may see them.
    pub fn questions(&self) -> Vec<PendingQuestionView> {
        self.question_views()
    }

    /// Answers a question from option positions and free text; the texts sent to Claude are
    /// built here.
    pub fn answer(&self, id: &str, answers: &[QuestionAnswer]) -> AnswerResult {
        let result = self.questions.answer(id, answers);
        // Ids and results only: question, option and answer texts never reach the log.
        log::info!(
            "Claude question answered id={} result={} count={}",
            id_for_log(id),
            answer_name(result),
            answers.len()
        );
        result
    }

    /// Gives the question back to Claude's own dialog (if still pending) and brings Claude
    /// forward.
    pub fn release_question(&self, id: &str) {
        let released = self.questions.release(id);
        log::info!(
            "Claude question handed back to Claude id={} released={released}",
            id_for_log(id)
        );
        (self.deps.focus_claude)();
    }

    pub fn dismiss_session(&self, id: &str) -> bool {
        let removed = lock(&self.core).registry.dismiss(id);
        if removed {
            self.publish();
        }
        removed
    }

    pub fn focus_app(&self) {
        (self.deps.focus_claude)();
    }

    pub async fn preview_hooks(&self) -> Result<HooksPreview, ExposedError> {
        let _turn = self.serial.lock().await;
        let config = self.require_config()?;
        let plan = self
            .deps
            .installer
            .preview(&install_options(&config))
            .await
            .map_err(io_failure)?;
        Ok(match plan {
            Ok(plan) => HooksPreview::Diff(HooksPreviewDiff {
                ok: BoolLiteral,
                diff: self.mask(&plan.diff),
            }),
            Err(_) => HooksPreview::InvalidJson(InvalidJson::VALUE),
        })
    }

    pub async fn install_hooks(&self) -> Result<HooksWrite, ExposedError> {
        let _turn = self.serial.lock().await;
        self.require_running()?;
        let config = self.require_config()?;
        let result = self
            .deps
            .installer
            .install(&install_options(&config))
            .await
            .map_err(io_failure)?;
        self.refresh_hooks().await;
        self.publish();
        Ok(self.written(result))
    }

    pub async fn uninstall_hooks(&self) -> Result<HooksWrite, ExposedError> {
        let _turn = self.serial.lock().await;
        self.require_running()?;
        let result = self.deps.installer.uninstall().await.map_err(io_failure)?;
        self.refresh_hooks().await;
        self.publish();
        Ok(self.written(result))
    }

    /// POSTs a probe event to our own bridge with the current token: ok only if it answered 200
    /// and the event really went through `on_event`.
    pub async fn test_connection(&self) -> TestConnectionResult {
        let target = {
            let core = lock(&self.core);
            match (&core.config, &core.bridge, core.bridge_running) {
                (Some(config), Some(bridge), true) => Some((bridge.port(), config.token.clone())),
                _ => None,
            }
        };
        let Some((port, token)) = target else {
            return TestConnectionResult { ok: false };
        };
        // Overlapping tests would reset each other's flag: one at a time.
        let _testing = self.testing.lock().await;
        self.test_probe_seen.store(false, Ordering::SeqCst);
        let status = tokio::time::timeout(TEST_TIMEOUT, post_probe(port, &token)).await;
        TestConnectionResult {
            ok: matches!(status, Ok(Ok(200))) && self.test_probe_seen.load(Ordering::SeqCst),
        }
    }

    /// Replaces the bridge config (token or port), restarts the bridge and reinstalls hooks that
    /// were installed. Reports what happened to them, so a failed reinstall is never a success.
    async fn rotate(&self, next: &ConfigFn, what: &str) -> Result<RotateOutcome, ExposedError> {
        let _turn = self.serial.lock().await;
        self.require_running()?;
        self.require_config()?;
        let reinstall = matches!(
            lock(&self.core).hooks,
            ClaudeHooksStatus::Installed | ClaudeHooksStatus::Outdated
        );
        let rotated = next().await.map_err(io_failure)?;
        self.stop_bridge().await;
        lock(&self.core).config = Some(rotated.clone());
        self.start_bridge(rotated.clone()).await;
        let mut outcome = RotateHooks::NotInstalled;
        if reinstall {
            let config = lock(&self.core).config.clone().unwrap_or(rotated);
            outcome = match self.deps.installer.install(&install_options(&config)).await {
                Ok(Ok(_)) => RotateHooks::Reinstalled,
                Ok(Err(_)) => {
                    log::warn!(
                        "Could not reinstall Claude hooks after rotating the {what} (invalid-json)"
                    );
                    RotateHooks::ReinstallFailed
                }
                Err(error) => {
                    log::warn!(
                        "Could not reinstall Claude hooks after rotating the {what} ({:?})",
                        error.kind()
                    );
                    RotateHooks::ReinstallFailed
                }
            };
        }
        self.refresh_hooks().await;
        self.publish();
        Ok(RotateOutcome { hooks: outcome })
    }

    pub async fn rotate_token(&self) -> Result<RotateOutcome, ExposedError> {
        let next = Arc::clone(&self.deps.rotate_config);
        self.rotate(&next, "token").await
    }

    /// Moves the bridge to a new random port (e.g. ours is taken), reinstalling installed hooks.
    pub async fn rotate_port(&self) -> Result<RotateOutcome, ExposedError> {
        let next = Arc::clone(&self.deps.rotate_port_config);
        self.rotate(&next, "port").await
    }
}

/// The connection test's request: a Notification of [`CONNECTION_TEST_SESSION_ID`]. Returns the
/// response status.
async fn post_probe(port: u16, token: &str) -> io::Result<u16> {
    let body = serde_json::json!({
        "session_id": CONNECTION_TEST_SESSION_ID,
        "hook_event_name": "Notification",
        "notification_type": "connection_test",
    })
    .to_string();
    let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).await?;
    let head = format!(
        "POST /hook HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\ncontent-type: application/json\r\n{TOKEN_HEADER}: {token}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    let mut response = Vec::new();
    (&mut stream)
        .take(TEST_RESPONSE_MAX_BYTES)
        .read_to_end(&mut response)
        .await?;
    let status_line = response
        .split(|&byte| byte == b'\n')
        .next()
        .unwrap_or_default();
    std::str::from_utf8(status_line)
        .ok()
        .and_then(|line| line.split(' ').nth(1))
        .and_then(|status| status.trim().parse().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "no HTTP status"))
}

/// The quit cleanup (`dispose` of the integration, awaited here): releases every held
/// permission (empty 200) and question (`{}`) at once, then stops the bridge (its 500 ms grace
/// lets those answers reach Claude) and waits for it, at most `wait`.
pub fn quit_cleanup(service: &Arc<ClaudeService>, wait: Duration) {
    service.stopped.store(true, Ordering::SeqCst);
    service.release_all();
    let (done, finished) = std::sync::mpsc::channel();
    let stopping = Arc::clone(service);
    let stop = async move {
        stopping.stop().await;
        let _ = done.send(());
    };
    match tokio::runtime::Handle::try_current() {
        Ok(runtime) => drop(runtime.spawn(stop)),
        Err(_) => drop(tauri::async_runtime::spawn(stop)),
    }
    if finished.recv_timeout(wait).is_err() {
        log::error!("Claude bridge did not stop cleanly");
    }
}

#[cfg(test)]
mod tests;
