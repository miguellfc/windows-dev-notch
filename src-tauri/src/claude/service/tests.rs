//! Port of `tests/unit/main/claude-service.test.ts` (every case, including the IPC handlers),
//! plus the Rust-only quit and port-in-use checks.

use std::collections::VecDeque;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Map, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use super::*;
use crate::claude::bridge::{BridgeError, ClaudeBridge, HookRoute, OnEvent, PendingReply};
use crate::claude::hook_events::{HookEvent, HookEventName, Preview};
use crate::claude::hook_installer::{
    HookInstallOptions, HookPlan, HookStatus, HookWriteResult, InvalidJson, Plan, WriteOutcome,
};
use crate::claude::ipc::ClaudeSlot;
use crate::claude::permission_broker::test_support::{ev, FakeReply};
use crate::claude::questions::AskUserQuestionInput;
use crate::contract::claude::{
    ClaudeConnection, ClaudeConnectionErrorReason, ClaudeHooksStatus, ClaudeQuestion,
    ClaudeSessionStatus, Decision, DiffKind, DiffLine, PendingPermission, PendingQuestionView,
    QuestionAnswer, QuestionOption, RotateHooks,
};
use crate::ipc::{Ctx, IpcErrorCode, Registry, Sender, CONTROL_CENTER, NOTCH};

const NEW_PORT: u16 = 50_001;
const ALLOW: &str = r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#;

fn token() -> String {
    "a".repeat(64)
}

fn new_token() -> String {
    "b".repeat(64)
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

// ---------------------------------------------------------------------------------------------
// Fakes

type StartFn = Arc<dyn Fn(u16) -> Result<(), BridgeError> + Send + Sync>;

struct FakeBridge {
    port: u16,
    token: String,
    on_event: OnEvent,
    starts: AtomicUsize,
    stopped: AtomicBool,
    start: StartFn,
}

impl FakeBridge {
    fn emit(&self, e: HookEvent, reply: Option<Arc<FakeReply>>, route: HookRoute) {
        (self.on_event)(e, reply.map(|r| r as Arc<dyn PendingReply>), route);
    }
}

impl Bridge for FakeBridge {
    fn start(&self) -> BoxFuture<'_, Result<u16, BridgeError>> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        let result = (self.start)(self.port).map(|()| self.port);
        Box::pin(async move { result })
    }

    fn stop(&self) -> BoxFuture<'_, ()> {
        self.stopped.store(true, Ordering::SeqCst);
        Box::pin(async {})
    }

    fn port(&self) -> u16 {
        self.port
    }
}

fn token_line(token: &str) -> DiffLine {
    DiffLine {
        kind: DiffKind::Add,
        text: format!("          \"x-notch-token\": \"{token}\","),
    }
}

/// `fakeInstaller()`: `install` answers from `install_results` first, else installs.
struct FakeInstaller {
    status: Mutex<HookStatus>,
    status_calls: AtomicUsize,
    installs: Mutex<Vec<HookInstallOptions>>,
    install_results: Mutex<VecDeque<io::Result<HookWriteResult>>>,
}

impl FakeInstaller {
    fn new(status: HookStatus) -> Arc<Self> {
        Arc::new(Self {
            status: Mutex::new(status),
            status_calls: AtomicUsize::new(0),
            installs: Mutex::default(),
            install_results: Mutex::default(),
        })
    }

    fn set_status(&self, status: HookStatus) {
        *lock(&self.status) = status;
    }

    fn installs(&self) -> Vec<HookInstallOptions> {
        lock(&self.installs).clone()
    }
}

impl Installer for FakeInstaller {
    fn preview<'a>(
        &'a self,
        options: &'a HookInstallOptions,
    ) -> BoxFuture<'a, io::Result<HookPlan>> {
        let plan = Plan {
            next: format!("{{\"x-notch-token\": \"{}\"}}", options.token),
            diff: vec![token_line(&options.token)],
        };
        Box::pin(async move { Ok(Ok(plan)) })
    }

    fn install<'a>(
        &'a self,
        options: &'a HookInstallOptions,
    ) -> BoxFuture<'a, io::Result<HookWriteResult>> {
        lock(&self.installs).push(options.clone());
        let result = lock(&self.install_results).pop_front().unwrap_or_else(|| {
            *lock(&self.status) = HookStatus::Installed;
            Ok(Ok(WriteOutcome {
                changed: true,
                diff: vec![token_line(&options.token)],
                backup_file: Some(PathBuf::from("C:\\backups\\settings.json")),
            }))
        });
        Box::pin(async move { result })
    }

    fn uninstall(&self) -> BoxFuture<'_, io::Result<HookWriteResult>> {
        *lock(&self.status) = HookStatus::Missing;
        let diff = vec![DiffLine {
            kind: DiffKind::Remove,
            text: format!("\"x-notch-token\": \"{}\"", token()),
        }];
        Box::pin(async move {
            Ok(Ok(WriteOutcome {
                changed: true,
                diff,
                backup_file: None,
            }))
        })
    }

    fn status<'a>(
        &'a self,
        _options: &'a HookInstallOptions,
    ) -> BoxFuture<'a, io::Result<HookStatus>> {
        self.status_calls.fetch_add(1, Ordering::SeqCst);
        let status = *lock(&self.status);
        Box::pin(async move { Ok(status) })
    }
}

// ---------------------------------------------------------------------------------------------
// Fixture (`setup()`)

#[derive(Clone)]
enum BridgeKind {
    Fake(StartFn),
    /// A real loopback bridge; `Some(token)` makes it expect another token than the config's.
    Real(Option<String>),
}

struct Opts {
    hooks: HookStatus,
    encryption: bool,
    port: u16,
    bridge: BridgeKind,
    /// Also receives every question list (e.g. the real `QuestionAlerts`).
    on_questions: Option<OnQuestions>,
}

impl Default for Opts {
    fn default() -> Self {
        Self {
            hooks: HookStatus::Installed,
            encryption: true,
            port: 47_600,
            bridge: BridgeKind::Fake(Arc::new(|_| Ok(()))),
            on_questions: None,
        }
    }
}

struct Fx {
    service: Arc<ClaudeService>,
    bridges: Arc<Mutex<Vec<Arc<FakeBridge>>>>,
    real: Arc<Mutex<Vec<Arc<ClaudeBridge>>>>,
    states: Arc<Mutex<Vec<ClaudeState>>>,
    new_pending: Arc<Mutex<Vec<PendingPermission>>>,
    question_lists: Arc<Mutex<Vec<Vec<PendingQuestionView>>>>,
    new_questions: Arc<Mutex<Vec<PendingQuestionView>>>,
    order: Arc<Mutex<Vec<String>>>,
    installer: Arc<FakeInstaller>,
    focus_calls: Arc<AtomicUsize>,
    load_calls: Arc<AtomicUsize>,
    /// Calls of `rotate_config` and `rotate_port_config` (each one rewrites claude-bridge.json).
    rotate_calls: Arc<AtomicUsize>,
    clock: Arc<AtomicU64>,
}

fn setup() -> Fx {
    setup_with(Opts::default())
}

fn hooks(status: HookStatus) -> Fx {
    setup_with(Opts {
        hooks: status,
        ..Opts::default()
    })
}

fn failing_bridge(error: fn() -> BridgeError) -> Fx {
    setup_with(Opts {
        bridge: BridgeKind::Fake(Arc::new(move |_| Err(error()))),
        ..Opts::default()
    })
}

fn setup_with(opts: Opts) -> Fx {
    let clock = Arc::new(AtomicU64::new(1_000_000));
    let ids = Arc::new(AtomicUsize::new(0));
    let bridges: Arc<Mutex<Vec<Arc<FakeBridge>>>> = Arc::default();
    let real: Arc<Mutex<Vec<Arc<ClaudeBridge>>>> = Arc::default();
    let states: Arc<Mutex<Vec<ClaudeState>>> = Arc::default();
    let new_pending: Arc<Mutex<Vec<PendingPermission>>> = Arc::default();
    let question_lists: Arc<Mutex<Vec<Vec<PendingQuestionView>>>> = Arc::default();
    let new_questions: Arc<Mutex<Vec<PendingQuestionView>>> = Arc::default();
    let order: Arc<Mutex<Vec<String>>> = Arc::default();
    let installer = FakeInstaller::new(opts.hooks);
    let focus_calls = Arc::new(AtomicUsize::new(0));
    let load_calls = Arc::new(AtomicUsize::new(0));
    let rotate_calls = Arc::new(AtomicUsize::new(0));
    let current_token = Arc::new(Mutex::new(token()));
    let port = opts.port;

    let deps = ClaudeServiceDeps {
        now: {
            let clock = Arc::clone(&clock);
            Arc::new(move || clock.load(Ordering::SeqCst))
        },
        new_id: Arc::new(move || {
            format!(
                "00000000-0000-4000-8000-{:012}",
                ids.fetch_add(1, Ordering::SeqCst) + 1
            )
        }),
        encryption_available: {
            let encryption = opts.encryption;
            Arc::new(move || encryption)
        },
        load_config: {
            let current_token = Arc::clone(&current_token);
            let load_calls = Arc::clone(&load_calls);
            Arc::new(move || {
                load_calls.fetch_add(1, Ordering::SeqCst);
                let token = lock(&current_token).clone();
                Box::pin(async move { Ok(BridgeConfig { port, token }) })
            })
        },
        rotate_config: {
            let current_token = Arc::clone(&current_token);
            let rotate_calls = Arc::clone(&rotate_calls);
            Arc::new(move || {
                rotate_calls.fetch_add(1, Ordering::SeqCst);
                *lock(&current_token) = new_token();
                Box::pin(async move {
                    Ok(BridgeConfig {
                        port: 47_600,
                        token: new_token(),
                    })
                })
            })
        },
        rotate_port_config: {
            let current_token = Arc::clone(&current_token);
            let rotate_calls = Arc::clone(&rotate_calls);
            Arc::new(move || {
                rotate_calls.fetch_add(1, Ordering::SeqCst);
                let token = lock(&current_token).clone();
                Box::pin(async move {
                    Ok(BridgeConfig {
                        port: NEW_PORT,
                        token,
                    })
                })
            })
        },
        create_bridge: {
            let bridges = Arc::clone(&bridges);
            let real = Arc::clone(&real);
            let kind = opts.bridge.clone();
            Arc::new(move |options: BridgeOptions| -> Arc<dyn Bridge> {
                match &kind {
                    BridgeKind::Fake(start) => {
                        let bridge = Arc::new(FakeBridge {
                            port: options.port,
                            token: options.token,
                            on_event: options.on_event,
                            starts: AtomicUsize::new(0),
                            stopped: AtomicBool::new(false),
                            start: Arc::clone(start),
                        });
                        lock(&bridges).push(Arc::clone(&bridge));
                        bridge
                    }
                    BridgeKind::Real(other_token) => {
                        let token = other_token.clone().unwrap_or(options.token);
                        let bridge =
                            Arc::new(ClaudeBridge::new(options.port, &token, options.on_event));
                        lock(&real).push(Arc::clone(&bridge));
                        bridge
                    }
                }
            })
        },
        installer: Arc::clone(&installer) as Arc<dyn Installer>,
        focus_claude: {
            let focus_calls = Arc::clone(&focus_calls);
            Arc::new(move || {
                focus_calls.fetch_add(1, Ordering::SeqCst);
            })
        },
        on_state: {
            let states = Arc::clone(&states);
            let order = Arc::clone(&order);
            Arc::new(move |state: &ClaudeState| {
                lock(&order).push(format!("state:{}", state.pending.len()));
                lock(&states).push(state.clone());
            })
        },
        on_new_pending: {
            let new_pending = Arc::clone(&new_pending);
            let order = Arc::clone(&order);
            Arc::new(move |permission: &PendingPermission| {
                lock(&order).push(format!("new:{}", permission.received_at));
                lock(&new_pending).push(permission.clone());
            })
        },
        on_questions: {
            let question_lists = Arc::clone(&question_lists);
            let also = opts.on_questions.clone();
            Arc::new(move |questions: &[PendingQuestionView]| {
                lock(&question_lists).push(questions.to_vec());
                if let Some(also) = &also {
                    also(questions);
                }
            })
        },
        on_new_question: {
            let new_questions = Arc::clone(&new_questions);
            Arc::new(move |question: &PendingQuestionView| {
                lock(&new_questions).push(question.clone());
            })
        },
        port_override: None,
        idle_after_ms: None,
    };
    Fx {
        service: ClaudeService::new(deps),
        bridges,
        real,
        states,
        new_pending,
        question_lists,
        new_questions,
        order,
        installer,
        focus_calls,
        load_calls,
        rotate_calls,
        clock,
    }
}

const CWD: &str = "C:\\work\\my-project";

/// An event of `session-1` in `C:\work\my-project`.
fn e(name: HookEventName) -> HookEvent {
    on(name, "session-1")
}

fn on(name: HookEventName, session_id: &str) -> HookEvent {
    HookEvent {
        cwd: Some(CWD.into()),
        ..ev(name, session_id)
    }
}

fn tool(name: HookEventName, tool_name: &str, tool_use_id: Option<&str>) -> HookEvent {
    HookEvent {
        tool_name: Some(tool_name.into()),
        tool_use_id: tool_use_id.map(Into::into),
        ..e(name)
    }
}

fn permission_request(session_id: &str, tool_name: &str, preview: Option<&str>) -> HookEvent {
    HookEvent {
        tool_name: Some(tool_name.into()),
        preview: preview.map(|text| Preview {
            preview: text.into(),
            preview_truncated: false,
            preview_length: text.len(),
        }),
        ..on(HookEventName::PermissionRequest, session_id)
    }
}

impl Fx {
    fn bridge(&self) -> Arc<FakeBridge> {
        Arc::clone(lock(&self.bridges).last().expect("a bridge"))
    }

    fn bridge_at(&self, index: usize) -> Arc<FakeBridge> {
        Arc::clone(&lock(&self.bridges)[index])
    }

    fn bridge_count(&self) -> usize {
        lock(&self.bridges).len()
    }

    /// `send(name, extra, sessionId, reply)` on `/hook`.
    fn send(&self, event: HookEvent) {
        self.bridge().emit(event, None, HookRoute::Hook);
    }

    fn send_held(&self, event: HookEvent, reply: &Arc<FakeReply>) {
        self.bridge()
            .emit(event, Some(Arc::clone(reply)), HookRoute::Hook);
    }

    fn status_of(&self, id: &str) -> Option<ClaudeSessionStatus> {
        self.service
            .state()
            .sessions
            .into_iter()
            .find(|session| session.id == id)
            .map(|session| session.status)
    }

    fn status(&self) -> Option<ClaudeSessionStatus> {
        self.status_of("session-1")
    }

    fn advance(&self, ms: u64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }

    fn last_state(&self) -> ClaudeState {
        lock(&self.states)
            .last()
            .cloned()
            .expect("a published state")
    }

    fn states_len(&self) -> usize {
        lock(&self.states).len()
    }

    fn pending_id(&self, index: usize) -> String {
        self.service.state().pending[index].id.clone()
    }

    fn question_id(&self, index: usize) -> String {
        self.service.questions()[index].id.clone()
    }

    fn ask(&self, reply: Option<&Arc<FakeReply>>, session_id: &str, route: HookRoute) {
        self.bridge().emit(
            HookEvent {
                cwd: Some(CWD.into()),
                ..ask_event(session_id, "tu-ask")
            },
            reply.map(Arc::clone),
            route,
        );
    }
}

// ---------------------------------------------------------------------------------------------
// ClaudeService connection

#[tokio::test]
async fn starts_the_bridge_with_the_stored_config_and_reports_not_installed_without_hooks() {
    let fx = hooks(HookStatus::Missing);
    fx.service.start().await;
    assert_eq!(fx.bridge_count(), 1);
    let bridge = fx.bridge_at(0);
    assert_eq!((bridge.port, bridge.token.clone()), (47_600, token()));
    assert_eq!(bridge.starts.load(Ordering::SeqCst), 1);
    assert_eq!(
        fx.service.state(),
        ClaudeState {
            connection: ClaudeConnection::NotInstalled,
            reason: None,
            hooks: ClaudeHooksStatus::Missing,
            sessions: Vec::new(),
            pending: Vec::new(),
        }
    );
    assert_eq!(fx.last_state(), fx.service.state());
}

#[tokio::test]
async fn waits_for_events_once_hooks_are_installed_and_is_connected_after_the_first_event() {
    let fx = hooks(HookStatus::Installed);
    fx.service.start().await;
    assert_eq!(
        fx.service.state().connection,
        ClaudeConnection::WaitingForEvents
    );
    fx.send(e(HookEventName::UserPromptSubmit));
    assert_eq!(fx.service.state().connection, ClaudeConnection::Connected);
    let sessions = fx.service.state().sessions;
    assert_eq!(sessions.len(), 1);
    assert_eq!(
        (
            sessions[0].id.as_str(),
            sessions[0].name.as_str(),
            sessions[0].status
        ),
        ("session-1", "my-project", ClaudeSessionStatus::Working)
    );
}

#[tokio::test]
async fn treats_outdated_hooks_as_installed_for_the_connection_and_reports_them() {
    let fx = hooks(HookStatus::Outdated);
    fx.service.start().await;
    let state = fx.service.state();
    assert_eq!(state.connection, ClaudeConnection::WaitingForEvents);
    assert_eq!(state.hooks, ClaudeHooksStatus::Outdated);
}

#[tokio::test]
async fn reports_error_and_never_starts_a_bridge_when_encryption_is_unavailable() {
    let fx = setup_with(Opts {
        encryption: false,
        ..Opts::default()
    });
    fx.service.start().await;
    assert_eq!(fx.load_calls.load(Ordering::SeqCst), 0);
    assert_eq!(fx.bridge_count(), 0);
    let state = fx.service.state();
    assert_eq!(state.connection, ClaudeConnection::Error);
    assert_eq!(state.hooks, ClaudeHooksStatus::Unknown);
}

#[tokio::test]
async fn reports_error_when_the_port_is_taken_and_keeps_working_otherwise() {
    let fx = failing_bridge(|| BridgeError::PortInUse);
    fx.service.start().await;
    assert_eq!(fx.service.state().connection, ClaudeConnection::Error);
    assert_eq!(
        fx.service.test_connection().await,
        TestConnectionResult { ok: false }
    );
    assert!(fx.installer.status_calls.load(Ordering::SeqCst) > 0);
}

#[tokio::test]
async fn ignores_connection_test_events_entirely() {
    let fx = setup();
    fx.service.start().await;
    fx.send(HookEvent {
        notification_type: Some("idle_prompt".into()),
        ..on(HookEventName::Notification, CONNECTION_TEST_SESSION_ID)
    });
    let state = fx.service.state();
    assert_eq!(state.connection, ClaudeConnection::WaitingForEvents);
    assert!(state.sessions.is_empty());
}

// ---------------------------------------------------------------------------------------------
// ClaudeService permissions

// The usage log measures alert latency in on_new_pending as now - receivedAt: that is only valid
// if the state carrying the request (which applies `Attention`) was published first.
#[tokio::test]
async fn publishes_the_state_with_a_new_request_before_announcing_it_stamped_when_the_hook_arrived()
{
    let fx = setup();
    fx.service.start().await;
    fx.advance(500);
    lock(&fx.order).clear();
    // The bridge stamps the HTTP arrival (before the body was read); that time wins over the clock.
    fx.send_held(
        permission_request("session-1", "Bash", Some("npm test")),
        &FakeReply::arriving_at(1_000_420),
    );
    assert_eq!(*lock(&fx.order), ["state:1", "new:1000420"]);
    // Without an arrival stamp (another transport), the service clock is used.
    fx.send_held(
        permission_request("session-1", "Read", Some("x")),
        &FakeReply::new(),
    );
    assert_eq!(lock(&fx.order).last().unwrap(), "new:1000500");
}

#[tokio::test]
async fn holds_a_permission_request_announces_it_once_and_decides_it() {
    let fx = setup();
    fx.service.start().await;
    let r = FakeReply::new();
    fx.send(tool(HookEventName::PreToolUse, "Bash", None));
    fx.send_held(
        permission_request("session-1", "Bash", Some("npm test")),
        &r,
    );

    let pending = fx.service.state().pending[0].clone();
    assert_eq!(
        (
            pending.session_id.as_str(),
            pending.session_name.as_str(),
            pending.tool_name.as_str(),
            pending.preview.as_str()
        ),
        ("session-1", "my-project", "Bash", "npm test")
    );
    assert_eq!(fx.status(), Some(ClaudeSessionStatus::Waiting));
    assert_eq!(*lock(&fx.new_pending), std::slice::from_ref(&pending));
    assert_eq!(fx.last_state().pending.len(), 1);

    fx.send(HookEvent {
        notification_type: Some("permission_prompt".into()),
        ..e(HookEventName::Notification)
    });
    assert_eq!(lock(&fx.new_pending).len(), 1);

    assert!(fx.service.decide(&pending.id, Decision::Allow));
    assert_eq!(r.sends(), [Some(ALLOW.to_string())]);
    assert!(fx.service.state().pending.is_empty());
    assert_eq!(fx.status(), Some(ClaudeSessionStatus::Working));
    assert!(fx.last_state().pending.is_empty());
    assert!(!fx.service.decide(&pending.id, Decision::Deny));
}

#[tokio::test]
async fn the_post_tool_use_of_the_same_tool_call_releases_the_request_without_a_decision() {
    let fx = setup();
    fx.service.start().await;
    let r = FakeReply::new();
    fx.send(tool(HookEventName::PreToolUse, "Bash", Some("tu1")));
    fx.send_held(permission_request("session-1", "Bash", None), &r);
    fx.send(tool(HookEventName::PreToolUse, "Bash", Some("tu2")));
    fx.send(tool(HookEventName::PostToolUse, "Bash", Some("tu2")));
    assert!(r.sends().is_empty());
    fx.send(tool(HookEventName::PostToolUse, "Bash", Some("tu1")));
    assert_eq!(r.sends(), [None]);
    assert!(fx.service.state().pending.is_empty());
    assert_eq!(fx.status(), Some(ClaudeSessionStatus::Working));
}

async fn session_end_releases(name: HookEventName) {
    let fx = setup();
    fx.service.start().await;
    let r = FakeReply::new();
    fx.send(tool(HookEventName::PreToolUse, "Bash", Some("tu1")));
    fx.send_held(permission_request("session-1", "Bash", None), &r);
    fx.send(e(name));
    assert_eq!(r.sends(), [None]);
    assert!(fx.service.state().pending.is_empty());
}

#[tokio::test]
async fn user_prompt_submit_of_the_session_releases_the_request() {
    session_end_releases(HookEventName::UserPromptSubmit).await;
}

#[tokio::test]
async fn stop_failure_of_the_session_releases_the_request() {
    session_end_releases(HookEventName::StopFailure).await;
}

#[tokio::test]
async fn leaves_waiting_when_claude_closes_the_held_connection() {
    let fx = setup();
    fx.service.start().await;
    let r = FakeReply::new();
    fx.send_held(permission_request("session-1", "Bash", None), &r);
    r.close();
    assert!(fx.service.state().pending.is_empty());
    assert_eq!(fx.status(), Some(ClaudeSessionStatus::Working));
    assert_eq!(
        fx.last_state().sessions[0].status,
        ClaudeSessionStatus::Working
    );
}

#[tokio::test]
async fn stays_waiting_while_the_session_still_has_another_pending_request() {
    let fx = setup();
    fx.service.start().await;
    fx.send_held(
        permission_request("session-1", "Bash", None),
        &FakeReply::new(),
    );
    fx.send_held(
        permission_request("session-1", "Edit", None),
        &FakeReply::new(),
    );
    let first = fx.pending_id(0);
    fx.service.decide(&first, Decision::Deny);
    assert_eq!(fx.service.state().pending.len(), 1);
    assert_eq!(fx.status(), Some(ClaudeSessionStatus::Waiting));
}

#[tokio::test]
async fn stop_releases_every_request_without_a_decision_and_stops_the_bridge() {
    let fx = setup();
    fx.service.start().await;
    let r = FakeReply::new();
    fx.send_held(permission_request("session-1", "Bash", None), &r);
    fx.service.stop().await;
    assert_eq!(r.sends(), [None]);
    assert_eq!(fx.status(), Some(ClaudeSessionStatus::Working));
    assert!(fx.bridge().stopped.load(Ordering::SeqCst));
}

// ---------------------------------------------------------------------------------------------
// ClaudeService questions

const SECRET_QUESTION: &str = "SECRET-QUESTION-TEXT?";
const SECRET_OPTION: &str = "SECRET-OPTION-A";
const SECRET_OTHER: &str = "SECRET-FREE-TEXT";

fn ask_questions(header: &str) -> Vec<ClaudeQuestion> {
    vec![ClaudeQuestion {
        question: SECRET_QUESTION.into(),
        header: header.into(),
        multi_select: false,
        options: vec![
            QuestionOption {
                label: SECRET_OPTION.into(),
                description: "first".into(),
            },
            QuestionOption {
                label: "B".into(),
                description: "second".into(),
            },
        ],
    }]
}

/// `askEvent()`: a PreToolUse of AskUserQuestion (no cwd).
fn ask_event(session_id: &str, tool_use_id: &str) -> HookEvent {
    let questions = ask_questions("Pick\u{202e}");
    let mut raw = Map::new();
    raw.insert(
        "questions".into(),
        serde_json::to_value(&questions).unwrap(),
    );
    raw.insert("extraKey".into(), json!(1));
    HookEvent {
        tool_name: Some("AskUserQuestion".into()),
        tool_use_id: Some(tool_use_id.into()),
        ask_user_question: Some(Some(AskUserQuestionInput { questions })),
        ask_user_question_raw: Some(raw),
        ..ev(HookEventName::PreToolUse, session_id)
    }
}

fn answer(selected: &[u64]) -> Vec<QuestionAnswer> {
    vec![QuestionAnswer {
        selected: selected.to_vec(),
        other: None,
    }]
}

#[tokio::test]
async fn holds_an_ask_user_question_from_the_question_route_announces_it_once_and_answers_it() {
    let fx = setup();
    fx.service.start().await;
    fx.send(e(HookEventName::UserPromptSubmit));
    let r = FakeReply::arriving_at(1_000_123);
    fx.ask(Some(&r), "session-1", HookRoute::Question);

    let view = fx.service.questions()[0].clone();
    assert_eq!(
        view,
        PendingQuestionView {
            id: view.id.clone(),
            project: "my-project".into(),
            arrived_at: 1_000_123.0,
            // Display-only sanitising: the bidi override is gone from what the notch sees.
            questions: ask_questions("Pick"),
        }
    );
    // The view type has no session id at all.
    assert!(serde_json::to_value(&view)
        .unwrap()
        .get("sessionId")
        .is_none());
    assert_eq!(*lock(&fx.new_questions), std::slice::from_ref(&view));
    assert_eq!(
        lock(&fx.question_lists).last().unwrap(),
        std::slice::from_ref(&view)
    );

    assert_eq!(
        fx.service.answer(&view.id, &answer(&[0])),
        AnswerResult::Sent
    );
    let body: Value = serde_json::from_str(r.sends()[0].as_deref().unwrap()).unwrap();
    // Answers go back keyed by the original texts, with Claude's tool_input echoed untouched.
    let updated = &body["hookSpecificOutput"]["updatedInput"];
    assert_eq!(updated["extraKey"], json!(1));
    assert_eq!(
        updated["answers"],
        json!({ SECRET_QUESTION: SECRET_OPTION })
    );
    assert!(fx.service.questions().is_empty());
    assert!(lock(&fx.question_lists).last().unwrap().is_empty());
    assert_eq!(
        fx.service.answer(&view.id, &answer(&[0])),
        AnswerResult::Gone
    );
    assert_eq!(lock(&fx.new_questions).len(), 1);
}

#[tokio::test]
async fn reports_invalid_answers_without_settling_the_question() {
    let fx = setup();
    fx.service.start().await;
    let r = FakeReply::new();
    fx.ask(Some(&r), "session-1", HookRoute::Question);
    let id = fx.question_id(0);
    assert_eq!(
        fx.service.answer(&id, &answer(&[0, 1])),
        AnswerResult::Invalid
    );
    assert_eq!(fx.service.answer(&id, &answer(&[5])), AnswerResult::Invalid);
    assert!(r.sends().is_empty());
    assert_eq!(fx.service.questions().len(), 1);
}

#[tokio::test]
async fn observes_ask_user_question_only_from_hook_and_holds_it_only_from_hook_question() {
    let fx = setup();
    fx.service.start().await;
    let r = FakeReply::new();
    // Claude sends the same call to both of our PreToolUse groups.
    fx.ask(None, "session-1", HookRoute::Hook);
    fx.ask(Some(&r), "session-1", HookRoute::Question);
    assert_eq!(fx.service.questions().len(), 1);
    assert!(fx.service.state().pending.is_empty());
    assert_eq!(fx.service.state().sessions.len(), 1);
    // Anything else on the question route is ignored: it is not a session event nor a release.
    let before = fx.service.state();
    fx.bridge().emit(
        ev(HookEventName::Stop, "session-1"),
        None,
        HookRoute::Question,
    );
    fx.bridge().emit(
        ev(HookEventName::UserPromptSubmit, "other"),
        None,
        HookRoute::Question,
    );
    assert_eq!(fx.service.questions().len(), 1);
    assert_eq!(fx.service.state(), before);
    assert!(r.sends().is_empty());
}

#[tokio::test]
async fn every_hook_event_is_observed_the_stop_of_the_session_releases_the_question() {
    let fx = setup();
    fx.service.start().await;
    let r = FakeReply::new();
    fx.ask(Some(&r), "session-1", HookRoute::Question);
    fx.send(on(HookEventName::Stop, "other-session"));
    assert!(r.sends().is_empty());
    fx.send(e(HookEventName::Stop));
    assert_eq!(r.sends(), [Some("{}".to_string())]);
    assert!(fx.service.questions().is_empty());
    assert!(lock(&fx.question_lists).last().unwrap().is_empty());
}

#[tokio::test]
async fn the_post_tool_use_of_the_ask_user_question_call_releases_it() {
    let fx = setup();
    fx.service.start().await;
    let r = FakeReply::new();
    fx.ask(Some(&r), "session-1", HookRoute::Question);
    fx.send(tool(
        HookEventName::PostToolUse,
        "AskUserQuestion",
        Some("tu-ask"),
    ));
    assert_eq!(r.sends(), [Some("{}".to_string())]);
}

#[tokio::test]
async fn release_question_gives_the_question_back_to_claude_and_brings_claude_forward() {
    let fx = setup();
    fx.service.start().await;
    let r = FakeReply::new();
    fx.ask(Some(&r), "session-1", HookRoute::Question);
    fx.service.release_question(&fx.question_id(0));
    assert_eq!(r.sends(), [Some("{}".to_string())]);
    assert_eq!(fx.focus_calls.load(Ordering::SeqCst), 1);
    // An id that is no longer pending still brings Claude forward (that is what the user asked for).
    fx.service.release_question("gone-id");
    assert_eq!(fx.focus_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn stop_releases_held_questions_along_with_the_permissions() {
    let fx = setup();
    fx.service.start().await;
    let q = FakeReply::new();
    let p = FakeReply::new();
    fx.ask(Some(&q), "session-1", HookRoute::Question);
    fx.send_held(permission_request("session-1", "Bash", None), &p);
    fx.service.stop().await;
    assert_eq!(q.sends(), [Some("{}".to_string())]);
    assert_eq!(p.sends(), [None]);
}

#[tokio::test]
async fn a_session_with_a_held_question_does_not_go_idle() {
    let fx = setup();
    fx.service.start().await;
    fx.send(on(HookEventName::UserPromptSubmit, "asking"));
    fx.send(on(HookEventName::UserPromptSubmit, "quiet"));
    fx.ask(Some(&FakeReply::new()), "asking", HookRoute::Question);
    fx.advance(31 * 60_000);
    fx.service.tick().await;
    assert_eq!(fx.status_of("quiet"), Some(ClaudeSessionStatus::Idle));
    assert_ne!(fx.status_of("asking"), Some(ClaudeSessionStatus::Idle));
}

// session status while a question waits

#[tokio::test]
async fn holding_makes_the_session_waiting_published_and_the_hook_copy_of_the_call_keeps_it_waiting(
) {
    let fx = setup();
    fx.service.start().await;
    fx.send(e(HookEventName::UserPromptSubmit));
    fx.ask(Some(&FakeReply::new()), "session-1", HookRoute::Question);
    assert_eq!(fx.status(), Some(ClaudeSessionStatus::Waiting));
    assert_eq!(
        fx.last_state().sessions[0].status,
        ClaudeSessionStatus::Waiting
    );
    // Claude's copy of the same PreToolUse on /hook may arrive after the held one.
    fx.ask(None, "session-1", HookRoute::Hook);
    assert_eq!(fx.status(), Some(ClaudeSessionStatus::Waiting));
    assert_eq!(
        fx.last_state().sessions[0].status,
        ClaudeSessionStatus::Waiting
    );
}

#[tokio::test]
async fn answering_or_releasing_goes_back_to_working_published() {
    let fx = setup();
    fx.service.start().await;
    fx.send(e(HookEventName::UserPromptSubmit));
    fx.ask(Some(&FakeReply::new()), "session-1", HookRoute::Question);
    fx.service.answer(&fx.question_id(0), &answer(&[1]));
    assert_eq!(fx.status(), Some(ClaudeSessionStatus::Working));
    assert_eq!(
        fx.last_state().sessions[0].status,
        ClaudeSessionStatus::Working
    );
    fx.ask(Some(&FakeReply::new()), "session-1", HookRoute::Question);
    assert_eq!(fx.status(), Some(ClaudeSessionStatus::Waiting));
    fx.service.release_question(&fx.question_id(0));
    assert_eq!(fx.status(), Some(ClaudeSessionStatus::Working));
    assert_eq!(
        fx.last_state().sessions[0].status,
        ClaudeSessionStatus::Working
    );
}

#[tokio::test]
async fn stop_of_the_session_releases_the_question_and_ends_done() {
    let fx = setup();
    fx.service.start().await;
    fx.send(e(HookEventName::UserPromptSubmit));
    fx.ask(Some(&FakeReply::new()), "session-1", HookRoute::Question);
    fx.send(e(HookEventName::Stop));
    assert_eq!(fx.status(), Some(ClaudeSessionStatus::Done));
    assert_eq!(
        fx.last_state().sessions[0].status,
        ClaudeSessionStatus::Done
    );
}

#[tokio::test]
async fn with_a_permission_and_a_question_in_the_same_session_resolving_one_keeps_it_waiting() {
    let fx = setup();
    fx.service.start().await;
    fx.send(e(HookEventName::UserPromptSubmit));
    fx.ask(Some(&FakeReply::new()), "session-1", HookRoute::Question);
    fx.send_held(
        permission_request("session-1", "Bash", None),
        &FakeReply::new(),
    );
    fx.service.decide(&fx.pending_id(0), Decision::Allow);
    assert_eq!(fx.status(), Some(ClaudeSessionStatus::Waiting));
    fx.service.answer(&fx.question_id(0), &answer(&[0]));
    assert_eq!(fx.status(), Some(ClaudeSessionStatus::Working));

    fx.ask(Some(&FakeReply::new()), "session-1", HookRoute::Question);
    fx.send_held(
        permission_request("session-1", "Bash", None),
        &FakeReply::new(),
    );
    fx.service.answer(&fx.question_id(0), &answer(&[0]));
    assert_eq!(fx.status(), Some(ClaudeSessionStatus::Waiting));
    fx.service.decide(&fx.pending_id(0), Decision::Deny);
    assert_eq!(fx.status(), Some(ClaudeSessionStatus::Working));
}

#[tokio::test]
async fn a_session_first_seen_on_the_question_route_is_named_from_its_cwd_and_listed_as_waiting() {
    let fx = setup();
    fx.service.start().await;
    fx.bridge().emit(
        HookEvent {
            cwd: Some("C:\\work\\fresh-project".into()),
            ..ask_event("brand-new-session", "tu-ask")
        },
        Some(FakeReply::new()),
        HookRoute::Question,
    );
    assert_eq!(fx.service.questions()[0].project, "fresh-project");
    let sessions = fx.service.state().sessions;
    assert_eq!(sessions.len(), 1);
    assert_eq!(
        (
            sessions[0].id.as_str(),
            sessions[0].name.as_str(),
            sessions[0].status
        ),
        (
            "brand-new-session",
            "fresh-project",
            ClaudeSessionStatus::Waiting
        )
    );
}

#[tokio::test]
async fn a_malformed_ask_user_question_on_the_question_route_is_answered_at_once_and_never_pending()
{
    let fx = setup();
    fx.service.start().await;
    let r = FakeReply::new();
    fx.bridge().emit(
        HookEvent {
            tool_name: Some("AskUserQuestion".into()),
            ask_user_question: Some(None),
            ..ev(HookEventName::PreToolUse, "session-1")
        },
        Some(Arc::clone(&r)),
        HookRoute::Question,
    );
    assert_eq!(r.sends(), [Some("{}".to_string())]);
    assert!(lock(&fx.new_questions).is_empty());
}

#[tokio::test]
async fn never_logs_question_option_or_answer_texts() {
    let capture = crate::services::test_log::capture().expect("the test logger");
    let fx = setup();
    fx.service.start().await;
    fx.ask(Some(&FakeReply::new()), "session-1", HookRoute::Question);
    let id = fx.question_id(0);
    let answered = fx.service.answer(
        &id,
        &[QuestionAnswer {
            selected: Vec::new(),
            other: Some(SECRET_OTHER.into()),
        }],
    );
    assert_eq!(answered, AnswerResult::Sent);
    fx.ask(Some(&FakeReply::new()), "session-1", HookRoute::Question);
    fx.service.release_question(&fx.question_id(0));
    let lines = capture.lines();
    assert!(lines
        .iter()
        .any(|line| line.contains("Claude question answered") && line.contains(&id)));
    for secret in [SECRET_QUESTION, SECRET_OPTION, SECRET_OTHER] {
        assert!(lines.iter().all(|line| !line.contains(secret)), "{secret}");
    }
}

// ---------------------------------------------------------------------------------------------
// ClaudeService sessions

#[tokio::test]
async fn tick_marks_quiet_sessions_idle_and_emits_only_when_something_changed() {
    let fx = setup();
    fx.service.start().await;
    fx.send(e(HookEventName::Stop));
    let before = fx.states_len();
    fx.service.tick().await;
    assert_eq!(fx.states_len(), before);
    fx.advance(31 * 60_000);
    fx.service.tick().await;
    assert_eq!(fx.status(), Some(ClaudeSessionStatus::Idle));
    assert_eq!(fx.states_len(), before + 1);
}

#[tokio::test]
async fn a_waiting_session_goes_idle_after_30_min_only_when_no_request_of_it_is_held() {
    let fx = setup();
    fx.service.start().await;
    fx.send(HookEvent {
        notification_type: Some("permission_prompt".into()),
        ..on(HookEventName::Notification, "no-held")
    });
    fx.send_held(permission_request("held", "Bash", None), &FakeReply::new());
    fx.advance(31 * 60_000);
    fx.service.tick().await;
    assert_eq!(fx.status_of("no-held"), Some(ClaudeSessionStatus::Idle));
    assert_eq!(fx.status_of("held"), Some(ClaudeSessionStatus::Waiting));
}

#[tokio::test]
async fn tick_picks_up_hooks_changed_outside_the_app() {
    let fx = hooks(HookStatus::Installed);
    fx.service.start().await;
    fx.installer.set_status(HookStatus::Missing);
    fx.service.tick().await;
    let state = fx.service.state();
    assert_eq!(state.connection, ClaudeConnection::NotInstalled);
    assert_eq!(state.hooks, ClaudeHooksStatus::Missing);
}

#[tokio::test]
async fn dismisses_only_idle_sessions() {
    let fx = setup();
    fx.service.start().await;
    fx.send(e(HookEventName::Stop));
    assert!(!fx.service.dismiss_session("session-1"));
    fx.advance(31 * 60_000);
    fx.service.tick().await;
    assert!(fx.service.dismiss_session("session-1"));
    assert!(fx.service.state().sessions.is_empty());
}

// ---------------------------------------------------------------------------------------------
// ClaudeService hooks and token

#[tokio::test]
async fn masks_the_token_in_previews_and_write_results_and_refreshes_the_hook_status() {
    let fx = hooks(HookStatus::Missing);
    fx.service.start().await;
    let preview = fx.service.preview_hooks().await.unwrap();
    assert!(!serde_json::to_string(&preview).unwrap().contains(&token()));
    assert_eq!(
        serde_json::to_value(&preview).unwrap(),
        json!({"ok": true, "diff": [{"kind": "add", "text": "          \"x-notch-token\": \"••••••\","}]})
    );

    let installed = fx.service.install_hooks().await.unwrap();
    let installed = serde_json::to_value(&installed).unwrap();
    assert!(!installed.to_string().contains(&token()));
    assert_eq!(installed["ok"], json!(true));
    assert_eq!(installed["changed"], json!(true));
    assert_eq!(installed["backupFile"], json!("C:\\backups\\settings.json"));
    let state = fx.service.state();
    assert_eq!(state.hooks, ClaudeHooksStatus::Installed);
    assert_eq!(state.connection, ClaudeConnection::WaitingForEvents);

    let removed = fx.service.uninstall_hooks().await.unwrap();
    assert!(!serde_json::to_string(&removed).unwrap().contains(&token()));
    let state = fx.service.state();
    assert_eq!(state.hooks, ClaudeHooksStatus::Missing);
    assert_eq!(state.connection, ClaudeConnection::NotInstalled);
}

#[tokio::test]
async fn refuses_hook_installs_without_a_bridge_config() {
    let fx = setup_with(Opts {
        encryption: false,
        ..Opts::default()
    });
    fx.service.start().await;
    let install = fx.service.install_hooks().await.unwrap_err();
    assert_eq!(install.code(), IpcErrorCode::Unavailable);
    let preview = fx.service.preview_hooks().await.unwrap_err();
    assert_eq!(preview.code(), IpcErrorCode::Unavailable);
}

#[tokio::test]
async fn rotating_the_token_restarts_the_bridge_and_reinstalls_installed_hooks() {
    let fx = hooks(HookStatus::Installed);
    fx.service.start().await;
    let r = FakeReply::new();
    fx.send_held(permission_request("session-1", "Bash", None), &r);
    assert_eq!(
        fx.service.rotate_token().await.unwrap().hooks,
        RotateHooks::Reinstalled
    );
    assert_eq!(r.sends(), [None]);
    assert_eq!(fx.bridge_count(), 2);
    assert!(fx.bridge_at(0).stopped.load(Ordering::SeqCst));
    let second = fx.bridge_at(1);
    assert_eq!((second.port, second.token.clone()), (47_600, new_token()));
    assert_eq!(second.starts.load(Ordering::SeqCst), 1);
    assert_eq!(
        fx.installer.installs(),
        [HookInstallOptions {
            port: 47_600,
            token: new_token()
        }]
    );
}

#[tokio::test]
async fn rotating_the_token_does_not_install_hooks_that_were_not_installed() {
    let fx = hooks(HookStatus::Missing);
    fx.service.start().await;
    assert_eq!(
        fx.service.rotate_token().await.unwrap().hooks,
        RotateHooks::NotInstalled
    );
    assert!(fx.installer.installs().is_empty());
}

#[tokio::test]
async fn rotating_reports_a_failed_reinstall_instead_of_success() {
    let fx = hooks(HookStatus::Installed);
    fx.service.start().await;
    lock(&fx.installer.install_results).push_back(Ok(Err(InvalidJson)));
    assert_eq!(
        fx.service.rotate_token().await.unwrap().hooks,
        RotateHooks::ReinstallFailed
    );
    fx.installer.set_status(HookStatus::Outdated);
    lock(&fx.installer.install_results)
        .push_back(Err(io::Error::from(io::ErrorKind::PermissionDenied)));
    assert_eq!(
        fx.service.rotate_token().await.unwrap().hooks,
        RotateHooks::ReinstallFailed
    );
    assert_eq!(
        fx.service.state().connection,
        ClaudeConnection::WaitingForEvents
    );
}

#[tokio::test]
async fn reports_port_in_use_when_the_bridge_port_is_taken() {
    let fx = failing_bridge(|| BridgeError::PortInUse);
    fx.service.start().await;
    let state = fx.service.state();
    assert_eq!(state.connection, ClaudeConnection::Error);
    assert_eq!(state.reason, Some(ClaudeConnectionErrorReason::PortInUse));
}

// Deviation from TS (which used EACCES here): on Windows a port inside a Hyper-V reserved range
// fails with WSAEACCES (PermissionDenied), which the service reports as port-in-use so the
// Control Center offers "rotate port". Any other error still carries no reason.
#[tokio::test]
async fn other_bridge_errors_carry_no_port_in_use_reason() {
    let fx =
        failing_bridge(|| BridgeError::Other(io::Error::from(io::ErrorKind::AddrNotAvailable)));
    fx.service.start().await;
    let state = fx.service.state();
    assert_eq!(state.connection, ClaudeConnection::Error);
    assert_eq!(state.reason, None);
    assert!(serde_json::to_value(&state)
        .unwrap()
        .get("reason")
        .is_none());
}

#[tokio::test]
async fn a_reserved_port_access_denied_counts_as_port_in_use() {
    let fx =
        failing_bridge(|| BridgeError::Other(io::Error::from(io::ErrorKind::PermissionDenied)));
    fx.service.start().await;
    assert_eq!(
        fx.service.state().reason,
        Some(ClaudeConnectionErrorReason::PortInUse)
    );
}

#[tokio::test]
async fn rotate_port_moves_the_bridge_reinstalls_installed_hooks_and_clears_port_in_use() {
    let started: Arc<Mutex<Vec<u16>>> = Arc::default();
    let sink = Arc::clone(&started);
    let fx = setup_with(Opts {
        hooks: HookStatus::Installed,
        bridge: BridgeKind::Fake(Arc::new(move |port| {
            if port == 47_600 {
                return Err(BridgeError::PortInUse);
            }
            lock(&sink).push(port);
            Ok(())
        })),
        ..Opts::default()
    });
    fx.service.start().await;
    let state = fx.service.state();
    assert_eq!(state.connection, ClaudeConnection::Error);
    assert_eq!(state.reason, Some(ClaudeConnectionErrorReason::PortInUse));
    assert_eq!(
        fx.service.rotate_port().await.unwrap().hooks,
        RotateHooks::Reinstalled
    );
    assert_eq!(*lock(&started), [NEW_PORT]);
    assert_eq!(
        fx.installer.installs(),
        [HookInstallOptions {
            port: NEW_PORT,
            token: token()
        }]
    );
    let state = fx.service.state();
    assert_eq!(state.connection, ClaudeConnection::WaitingForEvents);
    assert_eq!(state.reason, None);
}

#[tokio::test]
async fn rotate_port_without_hooks_installed_does_not_install_them() {
    let fx = hooks(HookStatus::Missing);
    fx.service.start().await;
    assert_eq!(
        fx.service.rotate_port().await.unwrap().hooks,
        RotateHooks::NotInstalled
    );
    assert!(fx.installer.installs().is_empty());
}

#[tokio::test]
async fn never_puts_the_token_in_the_state() {
    let fx = setup();
    fx.service.start().await;
    fx.send(e(HookEventName::UserPromptSubmit));
    fx.send_held(
        permission_request("session-1", "Bash", Some("echo hi")),
        &FakeReply::new(),
    );
    fx.service.rotate_token().await.unwrap();
    let mut everything = vec![fx.service.state()];
    everything.extend(lock(&fx.states).iter().cloned());
    let everything = serde_json::to_string(&everything).unwrap();
    assert!(fx.service.state().pending.is_empty());
    assert!(!everything.contains(&token()));
    assert!(!everything.contains(&new_token()));
}

// ---------------------------------------------------------------------------------------------
// ClaudeService test connection

#[tokio::test]
async fn posts_a_real_hook_event_to_the_running_bridge_with_the_current_token() {
    let capture = crate::services::test_log::capture().expect("the test logger");
    let fx = setup_with(Opts {
        port: 0,
        bridge: BridgeKind::Real(None),
        ..Opts::default()
    });
    fx.service.start().await;
    let port = lock(&fx.real)[0].port();
    assert_eq!(
        fx.service.test_connection().await,
        TestConnectionResult { ok: true }
    );
    let state = fx.service.state();
    assert!(state.sessions.is_empty());
    assert_eq!(state.connection, ClaudeConnection::WaitingForEvents);
    let lines = capture.lines();
    assert!(lines
        .iter()
        .any(|line| line.contains("hook request POST /hook 200 Notification")));
    assert!(lines.iter().all(|line| !line.contains(&token())));
    fx.service.stop().await;
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
}

#[tokio::test]
async fn fails_when_the_bridge_rejects_the_token() {
    let fx = setup_with(Opts {
        port: 0,
        bridge: BridgeKind::Real(Some(new_token())),
        ..Opts::default()
    });
    fx.service.start().await;
    assert_eq!(
        fx.service.test_connection().await,
        TestConnectionResult { ok: false }
    );
    fx.service.stop().await;
}

// ---------------------------------------------------------------------------------------------
// Quit (Rust only): the cleanup answers every held request before the app exits.

async fn post(port: u16, path: &str, body: Value) -> io::Result<(u16, String)> {
    let body = body.to_string();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
    let head = format!(
        "POST {path} HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\nx-notch-token: {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n",
        token(),
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).await?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|status| status.parse().ok())
        .unwrap_or(0);
    Ok((status, body.to_string()))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quit_releases_every_held_request_before_exit() {
    let fx = setup_with(Opts {
        port: 0,
        bridge: BridgeKind::Real(None),
        ..Opts::default()
    });
    fx.service.start().await;
    let port = lock(&fx.real)[0].port();
    let permission = tokio::spawn(post(
        port,
        "/hook",
        json!({"session_id": "s1", "hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "npm test"}}),
    ));
    let question = tokio::spawn(post(
        port,
        "/hook/question",
        json!({"session_id": "s1", "hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion", "tool_use_id": "tu-1",
               "tool_input": {"questions": [{"question": "Q?", "header": "H", "multiSelect": false,
                   "options": [{"label": "A", "description": ""}, {"label": "B", "description": ""}]}]}}),
    ));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while fx.service.state().pending.len() != 1 || fx.service.questions().len() != 1 {
        assert!(
            tokio::time::Instant::now() < deadline,
            "requests never held"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    let service = Arc::clone(&fx.service);
    tokio::task::spawn_blocking(move || quit_cleanup(&service, QUIT_STOP_WAIT))
        .await
        .unwrap();
    // The cleanup returned only after the bridge had stopped: both answers are already out (the
    // short timeout only lets the client tasks read what is on the wire).
    let soon = Duration::from_millis(500);
    let permission = tokio::time::timeout(soon, permission).await;
    let question = tokio::time::timeout(soon, question).await;
    assert_eq!(permission.unwrap().unwrap().unwrap(), (200, String::new()));
    assert_eq!(question.unwrap().unwrap().unwrap(), (200, "{}".to_string()));
    assert!(fx.service.state().pending.is_empty());
    assert!(TcpStream::connect(("127.0.0.1", port)).await.is_err());
}

#[tokio::test]
async fn a_stop_racing_start_wins() {
    let fx = setup();
    let service = Arc::clone(&fx.service);
    let (started, stopped) = tokio::join!(service.start(), fx.service.stop());
    let ((), ()) = (started, stopped);
    // Whichever ran first, no bridge is left running.
    assert_eq!(fx.service.state().connection, ClaudeConnection::Error);
    for index in 0..fx.bridge_count() {
        assert!(fx.bridge_at(index).stopped.load(Ordering::SeqCst));
    }
}

// ---------------------------------------------------------------------------------------------
// Claude IPC handlers

const QUESTION_ID_SAMPLE: &str = "11111111-1111-4111-8111-111111111111";

fn registry(service: &Arc<ClaudeService>) -> Registry {
    let slot: Arc<ClaudeSlot> = Arc::default();
    assert!(slot.set(Arc::clone(service)).is_ok());
    let mut registry = Registry::with_dev_origin(false);
    crate::claude::ipc::register(&mut registry, &slot);
    registry
}

async fn invoke(registry: &Registry, channel: &str, input: Option<Value>) -> Value {
    let (label, page) = if crate::ipc::guard_for(channel) == crate::ipc::Guard::ControlCenterOnly {
        (CONTROL_CENTER, "control-center")
    } else {
        (NOTCH, "notch")
    };
    let ctx = Ctx::for_test(Sender {
        label: label.into(),
        url: format!("http://tauri.localhost/{page}/index.html")
            .parse()
            .unwrap(),
    });
    registry.dispatch(&ctx, channel, input).await
}

fn error_code(response: &Value) -> &str {
    assert_eq!(response["ok"], json!(false), "{response}");
    response["error"]["code"].as_str().unwrap_or_default()
}

#[tokio::test]
async fn claude_decide_with_an_unknown_id_is_not_found() {
    let fx = setup();
    fx.service.start().await;
    let registry = registry(&fx.service);
    let response = invoke(
        &registry,
        "claude:decide",
        Some(json!({"requestId": QUESTION_ID_SAMPLE, "decision": "allow"})),
    )
    .await;
    assert_eq!(error_code(&response), "NOT_FOUND");
}

#[tokio::test]
async fn claude_decide_answers_a_pending_request() {
    let fx = setup();
    fx.service.start().await;
    let r = FakeReply::new();
    fx.send_held(permission_request("session-1", "Bash", None), &r);
    let registry = registry(&fx.service);
    let request_id = fx.pending_id(0);
    assert_eq!(
        invoke(
            &registry,
            "claude:decide",
            Some(json!({"requestId": request_id, "decision": "allow"}))
        )
        .await,
        json!({"ok": true, "data": null})
    );
    assert_eq!(r.sends(), [Some(ALLOW.to_string())]);
}

#[tokio::test]
async fn claude_dismiss_session_on_a_session_that_is_not_idle_is_not_found() {
    let fx = setup();
    fx.service.start().await;
    fx.send(e(HookEventName::Stop));
    let registry = registry(&fx.service);
    let response = invoke(
        &registry,
        "claude:dismiss-session",
        Some(json!({"sessionId": "session-1"})),
    )
    .await;
    assert_eq!(error_code(&response), "NOT_FOUND");
}

#[tokio::test]
async fn claude_focus_app_brings_the_claude_app_forward() {
    let fx = setup();
    fx.service.start().await;
    let registry = registry(&fx.service);
    assert_eq!(
        invoke(&registry, "claude:focus-app", None).await,
        json!({"ok": true, "data": null})
    );
    assert_eq!(fx.focus_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn claude_get_questions_claude_answer_and_claude_release_question() {
    let fx = setup();
    fx.service.start().await;
    let first = FakeReply::new();
    let second = FakeReply::new();
    fx.bridge().emit(
        ask_event("session-1", "tu-ask"),
        Some(Arc::clone(&first)),
        HookRoute::Question,
    );
    fx.bridge().emit(
        ask_event("session-2", "tu-2"),
        Some(Arc::clone(&second)),
        HookRoute::Question,
    );
    let registry = registry(&fx.service);

    let listed = invoke(&registry, "claude:get-questions", None).await;
    assert_eq!(listed["ok"], json!(true));
    let listed = listed["data"].as_array().unwrap().clone();
    assert_eq!(listed.len(), 2);
    let a = listed[0]["id"].clone();
    let b = listed[1]["id"].clone();

    let answer = |input: Value| invoke(&registry, "claude:answer", Some(input));
    assert_eq!(
        error_code(&answer(json!({"id": a, "answers": [{"selected": [0, 1]}]})).await),
        "INVALID_INPUT"
    );
    assert_eq!(
        error_code(&answer(json!({"id": a, "answers": [{"selected": [], "label": "x"}]})).await),
        "INVALID_INPUT"
    );
    assert_eq!(
        answer(json!({"id": a, "answers": [{"selected": [1]}]})).await,
        json!({"ok": true, "data": "sent"})
    );
    assert_eq!(
        answer(json!({"id": a, "answers": [{"selected": [1]}]})).await,
        json!({"ok": true, "data": "gone"})
    );
    assert_eq!(first.sends().len(), 1);

    assert_eq!(
        invoke(&registry, "claude:release-question", Some(json!({"id": b}))).await,
        json!({"ok": true, "data": null})
    );
    assert_eq!(second.sends(), [Some("{}".to_string())]);
    assert_eq!(fx.focus_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn no_claude_response_carries_the_token() {
    let fx = hooks(HookStatus::Missing);
    fx.service.start().await;
    fx.send_held(
        permission_request("session-1", "Bash", None),
        &FakeReply::new(),
    );
    let registry = registry(&fx.service);
    let mut results = Vec::new();
    for channel in [
        "claude:get-state",
        "claude:hooks-preview",
        "claude:hooks-install",
        "claude:test-connection",
        "claude:hooks-uninstall",
        "claude:rotate-token",
        "claude:rotate-port",
        "claude:get-state",
    ] {
        let response = invoke(&registry, channel, None).await;
        assert_eq!(response["ok"], json!(true), "{channel}: {response}");
        results.push(response);
    }
    let text = Value::Array(results).to_string();
    assert!(!text.contains(&token()));
    assert!(!text.contains(&new_token()));
}

// ---------------------------------------------------------------------------------------------
// Final review: nothing is written or held once the quit began.

#[tokio::test]
async fn after_stop_rotations_and_hook_operations_write_nothing() {
    let fx = hooks(HookStatus::Installed);
    fx.service.start().await;
    fx.service.stop().await;
    let bridges = fx.bridge_count();
    for result in [
        fx.service.rotate_token().await.map(|_| ()),
        fx.service.rotate_port().await.map(|_| ()),
        fx.service.install_hooks().await.map(|_| ()),
        fx.service.uninstall_hooks().await.map(|_| ()),
    ] {
        assert_eq!(result.unwrap_err().code(), IpcErrorCode::Unavailable);
    }
    // claude-bridge.json was never rewritten, settings.json never touched, no bridge started.
    assert_eq!(fx.rotate_calls.load(Ordering::SeqCst), 0);
    assert!(fx.installer.installs().is_empty());
    assert_eq!(*lock(&fx.installer.status), HookStatus::Installed);
    assert_eq!(fx.bridge_count(), bridges);
}

#[tokio::test]
async fn a_rotation_queued_before_stop_that_gets_its_turn_after_it_writes_nothing() {
    let fx = hooks(HookStatus::Installed);
    fx.service.start().await;
    // An operation holds the turn; a rotation queues behind it, then the quit begins.
    let turn = fx.service.serial.lock().await;
    let rotation = tokio::spawn({
        let service = Arc::clone(&fx.service);
        async move { service.rotate_token().await }
    });
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    let stopping = tokio::spawn({
        let service = Arc::clone(&fx.service);
        async move { service.stop().await }
    });
    while !fx.service.is_stopped() {
        tokio::task::yield_now().await;
    }
    drop(turn);
    // The rotation (first in the queue) gets the turn after `stop` raised `stopped`.
    let rotated = rotation.await.unwrap();
    assert_eq!(rotated.unwrap_err().code(), IpcErrorCode::Unavailable);
    stopping.await.unwrap();
    assert_eq!(fx.rotate_calls.load(Ordering::SeqCst), 0);
    assert!(fx.installer.installs().is_empty());
    assert_eq!(fx.bridge_count(), 1);
    assert!(fx.bridge().stopped.load(Ordering::SeqCst));
}

#[tokio::test]
async fn a_request_arriving_while_stopping_is_answered_at_once_and_never_held() {
    let fx = setup();
    fx.service.start().await;
    let bridge = fx.bridge();
    // `stop` raised the flag and still waits for its turn (or for the bridge to close).
    fx.service.stopped.store(true, Ordering::SeqCst);
    let permission = FakeReply::new();
    bridge.emit(
        permission_request("session-1", "Bash", None),
        Some(Arc::clone(&permission)),
        HookRoute::Hook,
    );
    let question = FakeReply::new();
    bridge.emit(
        ask_event("session-1", "tu-ask"),
        Some(Arc::clone(&question)),
        HookRoute::Question,
    );
    assert_eq!(permission.sends(), [None]);
    assert_eq!(question.sends(), [Some("{}".to_string())]);
    assert!(fx.service.state().pending.is_empty());
    assert!(fx.service.questions().is_empty());
    assert!(lock(&fx.new_pending).is_empty());
    assert!(lock(&fx.new_questions).is_empty());
}

#[tokio::test]
async fn tick_skips_the_hook_refresh_while_an_operation_has_the_turn() {
    let fx = hooks(HookStatus::Installed);
    fx.service.start().await;
    let calls = fx.installer.status_calls.load(Ordering::SeqCst);
    // A read here could land after (and overwrite) what the operation holding the turn sets.
    fx.installer.set_status(HookStatus::Missing);
    {
        let _turn = fx.service.serial.lock().await;
        fx.service.tick().await;
        assert_eq!(fx.installer.status_calls.load(Ordering::SeqCst), calls);
        assert_eq!(fx.service.state().hooks, ClaudeHooksStatus::Installed);
    }
    fx.service.tick().await;
    assert_eq!(fx.service.state().hooks, ClaudeHooksStatus::Missing);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn overlapping_connection_tests_each_see_their_own_probe() {
    let fx = setup_with(Opts {
        port: 0,
        bridge: BridgeKind::Real(None),
        ..Opts::default()
    });
    fx.service.start().await;
    let tests: Vec<_> = (0..4)
        .map(|_| {
            let service = Arc::clone(&fx.service);
            tokio::spawn(async move { service.test_connection().await })
        })
        .collect();
    for test in tests {
        assert_eq!(test.await.unwrap(), TestConnectionResult { ok: true });
    }
    fx.service.stop().await;
}

/// The notch as the question alerts drive it: records every event.
#[derive(Default)]
struct RecordingNotch(Mutex<Vec<crate::notch::state::NotchEvent>>);

impl crate::claude::alerts::NotchPort for RecordingNotch {
    fn mode(&self) -> crate::notch::state::NotchMode {
        crate::notch::state::NotchMode::Compact
    }

    fn dispatch(&self, event: crate::notch::state::NotchEvent) {
        lock(&self.0).push(event);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn claude_hanging_up_on_a_held_question_clears_the_list_and_turns_the_alert_off() {
    use crate::claude::alerts::{NotchPort, QuestionAlerts, QuestionAlertsOptions};
    use crate::notch::state::NotchEvent;

    let notch = Arc::new(RecordingNotch::default());
    let alerts = Arc::new(QuestionAlerts::new(QuestionAlertsOptions {
        notch: Arc::clone(&notch) as Arc<dyn NotchPort>,
        notch_target: Arc::new(|| None),
        toast: Arc::new(|_, _| {}),
    }));
    let fx = setup_with(Opts {
        port: 0,
        bridge: BridgeKind::Real(None),
        on_questions: Some({
            let alerts = Arc::clone(&alerts);
            Arc::new(move |questions: &[PendingQuestionView]| alerts.on_questions(questions))
        }),
        ..Opts::default()
    });
    fx.service.start().await;
    let port = lock(&fx.real)[0].port();
    let body = json!({"session_id": "s1", "hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion", "tool_use_id": "tu-1",
        "tool_input": {"questions": [{"question": "Q?", "header": "H", "multiSelect": false,
            "options": [{"label": "A", "description": ""}, {"label": "B", "description": ""}]}]}})
    .to_string();
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let head = format!(
        "POST /hook/question HTTP/1.1\r\nhost: 127.0.0.1:{port}\r\nx-notch-token: {}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n",
        token(),
        body.len()
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(body.as_bytes()).await.unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while fx.service.questions().len() != 1 {
        assert!(tokio::time::Instant::now() < deadline, "never held");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(fx.status_of("s1"), Some(ClaudeSessionStatus::Waiting));
    assert!(lock(&notch.0).contains(&NotchEvent::Question { on: true }));

    // Claude gives up (its hook timed out or the user answered in its own window).
    drop(stream);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while !fx.service.questions().is_empty() {
        assert!(tokio::time::Instant::now() < deadline, "never released");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(lock(&fx.question_lists).last().unwrap().is_empty());
    let last_flag = lock(&notch.0)
        .iter()
        .rev()
        .find(|event| matches!(event, NotchEvent::Question { .. }))
        .copied();
    assert_eq!(last_flag, Some(NotchEvent::Question { on: false }));
    assert_ne!(fx.status_of("s1"), Some(ClaudeSessionStatus::Waiting));
    fx.service.stop().await;
}

/// The quit on the main thread (a second exit request during the flush): no tokio runtime is
/// current there, so the stop runs on Tauri's runtime and the wait is the shorter one.
#[test]
fn quit_cleanup_on_a_thread_without_a_runtime_releases_everything_within_the_main_thread_wait() {
    use crate::claude::integration::MAIN_THREAD_STOP_WAIT;

    assert!(tokio::runtime::Handle::try_current().is_err());
    let fx = setup_with(Opts {
        port: 0,
        bridge: BridgeKind::Real(None),
        ..Opts::default()
    });
    tauri::async_runtime::block_on(fx.service.start());
    let port = lock(&fx.real)[0].port();
    let permission = tauri::async_runtime::spawn(post(
        port,
        "/hook",
        json!({"session_id": "s1", "hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": {"command": "npm test"}}),
    ));
    let question = tauri::async_runtime::spawn(post(
        port,
        "/hook/question",
        json!({"session_id": "s1", "hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion", "tool_use_id": "tu-1",
               "tool_input": {"questions": [{"question": "Q?", "header": "H", "multiSelect": false,
                   "options": [{"label": "A", "description": ""}, {"label": "B", "description": ""}]}]}}),
    ));
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while fx.service.state().pending.len() != 1 || fx.service.questions().len() != 1 {
        assert!(std::time::Instant::now() < deadline, "requests never held");
        std::thread::sleep(Duration::from_millis(10));
    }

    let began = std::time::Instant::now();
    quit_cleanup(&fx.service, MAIN_THREAD_STOP_WAIT);
    // Bounded by the main-thread wait (plus scheduling slack), never the worker one.
    assert!(began.elapsed() < MAIN_THREAD_STOP_WAIT + Duration::from_millis(400));
    assert!(fx.service.is_stopped());
    let answers = tauri::async_runtime::block_on(async {
        let soon = Duration::from_secs(2);
        (
            tokio::time::timeout(soon, permission).await,
            tokio::time::timeout(soon, question).await,
        )
    });
    assert_eq!(answers.0.unwrap().unwrap().unwrap(), (200, String::new()));
    assert_eq!(
        answers.1.unwrap().unwrap().unwrap(),
        (200, "{}".to_string())
    );
    assert!(fx.service.state().pending.is_empty());
    assert!(fx.service.questions().is_empty());
}
