//! Port of `tests/unit/main/gmail-ipc.test.ts` (25 cases: 11 `it` blocks plus the 14 rows of the
//! guard `it.each`, each its own test): guards, pass-through, input and output validation of the
//! fourteen `gmail:*` channels, against a fake integration and a fake client-file picker. Plus
//! the Rust-only cases: the `ready` waits per channel, UNAVAILABLE before install, a dropped
//! sign-in call, the new-mail order (`new_mail_event_goes_before_the_notch_alert`) and
//! `no_gmail_output_carries_a_token`, over the real integration and the real Gmail client on a
//! fake transport.

use std::sync::{Arc, Mutex};

use chrono::{TimeZone, Utc};
use serde_json::{json, Value};
use tokio::sync::watch;

use super::*;
use crate::contract::gmail::{
    GmailClientFile, GmailLink, GmailMessage, GmailMessageDetail, GmailNewMail, GmailSignInResult,
    GmailState, GmailStatus,
};
use crate::contract::settings::{GmailAlertSettings, GmailSettings};
use crate::contract::{check, Direction};
use crate::gmail::auth::{GmailAuth, GmailAuthError, RefreshResult, SignInError, SignInResult};
use crate::gmail::client::{GmailApiClient, GmailClient, TokenAccess};
use crate::gmail::client_file::PickClientFile;
use crate::gmail::integration::{
    AuthFactory, ClientFactory, Credentials, GmailDeps, GmailIntegration, SettingsSource,
    LOG_TARGET,
};
use crate::http::{HttpRequest, HttpResponse, Method, Transport, TransportError};
use crate::ipc::{
    BoxFuture, Ctx, ExposedError, IpcErrorCode, Registry, Sender, CONTROL_CENTER, NOTCH,
};
use crate::notch::state::NotchEvent;
use crate::services::clock::WallClock;
use crate::services::secure_token_store::TokenStore;
use crate::services::timers::{TestTimers, Timers};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Who {
    Notch,
    ControlCenter,
    Other,
}

fn ok_state() -> GmailState {
    GmailState {
        status: GmailStatus::Ok,
        account: Some("me@x.com".into()),
        unread: Some(3),
        updated_at: Some("2026-11-11T10:00:00.000Z".into()),
        persistent: true,
        reason: None,
    }
}

fn detail(id: &str) -> GmailMessageDetail {
    GmailMessageDetail {
        id: id.into(),
        thread_id: format!("t{id}"),
        from: "A".into(),
        from_address: "a@example.com".into(),
        subject: "S".into(),
        date: "2026-11-11T09:00:00.000Z".into(),
        unread: true,
        body: "B".into(),
        truncated: false,
        links: Vec::new(),
        attachments: 0,
    }
}

fn msg(id: &str) -> GmailMessage {
    GmailMessage {
        id: id.into(),
        thread_id: format!("t{id}"),
        from: "A".into(),
        subject: "S".into(),
        snippet: String::new(),
        date: "2026-11-11T09:00:00.000Z".into(),
        unread: false,
    }
}

fn client_file(id: &str, secret: &str) -> GmailClientFile {
    GmailClientFile {
        client_id: id.into(),
        client_secret: secret.into(),
    }
}

/// The integration as the channels see it, recording every call (`vi.fn`).
struct FakeApi {
    ready: watch::Receiver<bool>,
    state: GmailState,
    recent: Vec<GmailMessage>,
    detail: Option<GmailMessageDetail>,
    /// The next refusal of `remove`, `message` and `open_link` (`mockRejectedValueOnce`).
    remove_refusal: Mutex<Option<ExposedError>>,
    message_refusal: Mutex<Option<ExposedError>>,
    open_link_refusal: Mutex<Option<ExposedError>>,
    calls: Mutex<Vec<String>>,
}

impl FakeApi {
    fn record(&self, call: String) {
        self.calls.lock().unwrap().push(call);
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn count(&self, call: &str) -> usize {
        self.calls().iter().filter(|c| *c == call).count()
    }

    fn called(&self, prefix: &str) -> bool {
        self.calls().iter().any(|call| call.starts_with(prefix))
    }
}

impl GmailApi for FakeApi {
    fn ready(&self) -> BoxFuture<'_, ()> {
        let mut ready = self.ready.clone();
        Box::pin(async move {
            let _ = ready.wait_for(|done| *done).await;
        })
    }

    fn state(&self) -> GmailState {
        self.record("state".into());
        self.state.clone()
    }

    fn recent(&self) -> BoxFuture<'_, Vec<GmailMessage>> {
        self.record("recent".into());
        let recent = self.recent.clone();
        Box::pin(async move { recent })
    }

    fn set_view_open(&self, open: bool) {
        self.record(format!("view:{open}"));
    }

    fn refresh(&self) {
        self.record("refresh".into());
    }

    fn open(&self, id: Option<&str>) {
        self.record(format!("open:{id:?}"));
    }

    fn message(&self, id: String) -> BoxFuture<'_, Result<GmailMessageDetail, ExposedError>> {
        self.record(format!("message:{id}"));
        let refusal = self.message_refusal.lock().unwrap().take();
        let detail = self.detail.clone().unwrap_or_else(|| detail(&id));
        Box::pin(async move { refusal.map_or(Ok(detail), Err) })
    }

    fn mark_read(&self, id: String) -> BoxFuture<'_, Result<(), ExposedError>> {
        self.record(format!("mark-read:{id}"));
        Box::pin(async { Ok(()) })
    }

    fn remove(&self, id: String) -> BoxFuture<'_, Result<(), ExposedError>> {
        self.record(format!("remove:{id}"));
        let refusal = self.remove_refusal.lock().unwrap().take();
        Box::pin(async move { refusal.map_or(Ok(()), Err) })
    }

    fn open_link(&self, id: &str, index: u32) -> Result<(), ExposedError> {
        self.record(format!("open-link:{id}:{index}"));
        self.open_link_refusal
            .lock()
            .unwrap()
            .take()
            .map_or(Ok(()), Err)
    }

    fn close_message(&self) {
        self.record("close-message".into());
    }

    fn sign_in(&self) -> BoxFuture<'_, GmailSignInResult> {
        self.record("sign-in".into());
        Box::pin(async { GmailSignInResult::Ok })
    }

    fn cancel_sign_in(&self) {
        self.record("cancel-sign-in".into());
    }

    fn sign_out(&self) -> BoxFuture<'_, ()> {
        self.record("sign-out".into());
        Box::pin(async {})
    }
}

/// `pickClientFile`: answers the configured value and counts the calls.
struct FakePicker {
    picked: Option<GmailClientFile>,
    calls: Mutex<usize>,
}

impl PickClientFile for FakePicker {
    fn pick_client_file(&self) -> BoxFuture<'_, Result<Option<GmailClientFile>, ExposedError>> {
        *self.calls.lock().unwrap() += 1;
        let picked = self.picked.clone();
        Box::pin(async move { Ok(picked) })
    }
}

struct Options {
    ready: bool,
    state: GmailState,
    recent: Vec<GmailMessage>,
    detail: Option<GmailMessageDetail>,
    picked: Option<GmailClientFile>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            ready: true,
            state: ok_state(),
            recent: vec![msg("1")],
            detail: None,
            picked: Some(client_file("id", "sec")),
        }
    }
}

struct Harness {
    registry: Arc<Registry>,
    api: Arc<FakeApi>,
    picker: Arc<FakePicker>,
    release: watch::Sender<bool>,
}

fn setup(options: Options) -> Harness {
    let (release, ready) = watch::channel(options.ready);
    let api = Arc::new(FakeApi {
        ready,
        state: options.state,
        recent: options.recent,
        detail: options.detail,
        remove_refusal: Mutex::new(None),
        message_refusal: Mutex::new(None),
        open_link_refusal: Mutex::new(None),
        calls: Mutex::new(Vec::new()),
    });
    let picker = Arc::new(FakePicker {
        picked: options.picked,
        calls: Mutex::new(0),
    });
    let slot: Arc<GmailSlot> = Arc::default();
    assert!(slot
        .set(GmailHandles {
            api: Arc::clone(&api) as Arc<dyn GmailApi>,
            client_file: Arc::clone(&picker) as Arc<dyn PickClientFile>,
        })
        .is_ok());
    Harness {
        registry: registry_over(&slot),
        api,
        picker,
        release,
    }
}

fn registry_over(slot: &Arc<GmailSlot>) -> Arc<Registry> {
    let mut registry = Registry::with_dev_origin(false);
    register(&mut registry, slot);
    Arc::new(registry)
}

fn ctx(who: Who) -> Ctx {
    let (label, page) = match who {
        Who::Notch => (NOTCH, "notch"),
        Who::ControlCenter => (CONTROL_CENTER, "control-center"),
        Who::Other => ("other", "notch"),
    };
    Ctx::for_test(Sender {
        label: label.into(),
        url: format!("http://tauri.localhost/{page}/index.html")
            .parse()
            .unwrap(),
    })
}

async fn invoke(registry: &Registry, channel: &str, who: Who, input: Option<Value>) -> Value {
    registry.dispatch(&ctx(who), channel, input).await
}

impl Harness {
    async fn invoke(&self, channel: &str, who: Who, input: Option<Value>) -> Value {
        invoke(&self.registry, channel, who, input).await
    }

    /// The call in the background (to observe it waiting).
    fn spawn(
        &self,
        channel: &'static str,
        who: Who,
        input: Option<Value>,
    ) -> tokio::task::JoinHandle<Value> {
        let registry = Arc::clone(&self.registry);
        tokio::spawn(async move { registry.dispatch(&ctx(who), channel, input).await })
    }
}

async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

const ALLOWED: [(&str, &str); 14] = [
    ("gmail:get-state", "both"),
    ("gmail:recent", "notch"),
    ("gmail:view", "notch"),
    ("gmail:refresh", "notch"),
    ("gmail:open", "notch"),
    ("gmail:sign-in", "control-center"),
    ("gmail:cancel-sign-in", "control-center"),
    ("gmail:sign-out", "control-center"),
    ("gmail:pick-client-file", "control-center"),
    ("gmail:message", "notch"),
    ("gmail:mark-read", "notch"),
    ("gmail:delete", "notch"),
    ("gmail:open-link", "notch"),
    ("gmail:close-message", "notch"),
];

fn sample(channel: &str) -> Option<Value> {
    match channel {
        "gmail:view" => Some(json!({ "open": true })),
        "gmail:open" | "gmail:message" | "gmail:mark-read" | "gmail:delete" => {
            Some(json!({ "id": "1" }))
        }
        "gmail:open-link" => Some(json!({ "id": "1", "index": 0 })),
        _ => None,
    }
}

fn code(response: &Value) -> &Value {
    &response["error"]["code"]
}

fn assert_refused(response: &Value, expected: &str) {
    assert_eq!(response["ok"], json!(false), "{response}");
    assert_eq!(code(response), &json!(expected), "{response}");
}

// ---------------------------------------------------------------------------------------------
// gmail IPC guards

#[test]
fn covers_every_gmail_channel() {
    let mut ours: Vec<&str> = ALLOWED.iter().map(|(name, _)| *name).collect();
    ours.sort_unstable();
    let mut known: Vec<&str> = crate::ipc::known_channels()
        .iter()
        .copied()
        .filter(|name| name.starts_with("gmail:"))
        .collect();
    known.sort_unstable();
    assert_eq!(ours, known);
    let mut registered: Vec<&str> = CHANNELS.iter().map(|(name, _)| *name).collect();
    registered.sort_unstable();
    assert_eq!(registered, known);
}

async fn reachable_only_from(channel: &str) {
    let who = ALLOWED
        .iter()
        .find(|(name, _)| *name == channel)
        .map(|(_, who)| *who)
        .unwrap();
    let harness = setup(Options::default());
    for caller in [Who::Notch, Who::ControlCenter, Who::Other] {
        let allowed = (who == "both" && caller != Who::Other)
            || (who == "notch" && caller == Who::Notch)
            || (who == "control-center" && caller == Who::ControlCenter);
        let response = harness.invoke(channel, caller, sample(channel)).await;
        if allowed {
            assert_eq!(
                response["ok"],
                json!(true),
                "{channel} {caller:?}: {response}"
            );
        } else {
            assert_refused(&response, "FORBIDDEN");
        }
    }
}

#[tokio::test]
async fn get_state_is_reachable_only_from_both() {
    reachable_only_from("gmail:get-state").await;
}

#[tokio::test]
async fn recent_is_reachable_only_from_notch() {
    reachable_only_from("gmail:recent").await;
}

#[tokio::test]
async fn view_is_reachable_only_from_notch() {
    reachable_only_from("gmail:view").await;
}

#[tokio::test]
async fn refresh_is_reachable_only_from_notch() {
    reachable_only_from("gmail:refresh").await;
}

#[tokio::test]
async fn open_is_reachable_only_from_notch() {
    reachable_only_from("gmail:open").await;
}

#[tokio::test]
async fn sign_in_is_reachable_only_from_control_center() {
    reachable_only_from("gmail:sign-in").await;
}

#[tokio::test]
async fn cancel_sign_in_is_reachable_only_from_control_center() {
    reachable_only_from("gmail:cancel-sign-in").await;
}

#[tokio::test]
async fn sign_out_is_reachable_only_from_control_center() {
    reachable_only_from("gmail:sign-out").await;
}

#[tokio::test]
async fn pick_client_file_is_reachable_only_from_control_center() {
    reachable_only_from("gmail:pick-client-file").await;
}

#[tokio::test]
async fn message_is_reachable_only_from_notch() {
    reachable_only_from("gmail:message").await;
}

#[tokio::test]
async fn mark_read_is_reachable_only_from_notch() {
    reachable_only_from("gmail:mark-read").await;
}

#[tokio::test]
async fn delete_is_reachable_only_from_notch() {
    reachable_only_from("gmail:delete").await;
}

#[tokio::test]
async fn open_link_is_reachable_only_from_notch() {
    reachable_only_from("gmail:open-link").await;
}

#[tokio::test]
async fn close_message_is_reachable_only_from_notch() {
    reachable_only_from("gmail:close-message").await;
}

// ---------------------------------------------------------------------------------------------
// gmail IPC handlers

#[tokio::test]
async fn get_state_waits_for_the_integration_to_load() {
    let t = setup(Options {
        ready: false,
        ..Options::default()
    });
    let pending = t.spawn("gmail:get-state", Who::ControlCenter, None);
    settle().await;
    assert!(!t.api.called("state"));
    t.release.send(true).unwrap();
    assert_eq!(
        pending.await.unwrap(),
        json!({ "ok": true, "data": serde_json::to_value(ok_state()).unwrap() })
    );
}

#[tokio::test]
async fn passes_view_refresh_open_and_sign_in_calls_through() {
    let t = setup(Options::default());
    assert_eq!(
        t.invoke("gmail:view", Who::Notch, Some(json!({ "open": true })))
            .await,
        json!({ "ok": true, "data": null })
    );
    assert!(t.api.called("view:true"));
    t.invoke("gmail:refresh", Who::Notch, None).await;
    assert_eq!(t.api.count("refresh"), 1);
    t.invoke("gmail:open", Who::Notch, Some(json!({ "id": "abc" })))
        .await;
    assert_eq!(t.api.calls().last().unwrap(), r#"open:Some("abc")"#);
    t.invoke("gmail:open", Who::Notch, Some(json!({}))).await;
    assert_eq!(t.api.calls().last().unwrap(), "open:None");
    assert_eq!(
        t.invoke("gmail:sign-in", Who::ControlCenter, None).await,
        json!({ "ok": true, "data": "ok" })
    );
    t.invoke("gmail:cancel-sign-in", Who::ControlCenter, None)
        .await;
    assert_eq!(t.api.count("cancel-sign-in"), 1);
    assert_eq!(
        t.invoke("gmail:sign-out", Who::ControlCenter, None).await,
        json!({ "ok": true, "data": null })
    );
    assert_eq!(t.api.count("sign-out"), 1);
    assert_eq!(
        t.invoke("gmail:recent", Who::Notch, None).await,
        json!({ "ok": true, "data": [serde_json::to_value(msg("1")).unwrap()] })
    );
}

#[tokio::test]
async fn pick_client_file_returns_the_credentials_null_on_cancel_and_rejects_extra_output_fields() {
    assert_eq!(
        setup(Options::default())
            .invoke("gmail:pick-client-file", Who::ControlCenter, None)
            .await,
        json!({ "ok": true, "data": { "clientId": "id", "clientSecret": "sec" } })
    );
    assert_eq!(
        setup(Options {
            picked: None,
            ..Options::default()
        })
        .invoke("gmail:pick-client-file", Who::ControlCenter, None)
        .await,
        json!({ "ok": true, "data": null })
    );
    // A Rust value cannot carry an extra field: the strict contract the channel checks against
    // refuses that shape, and a value outside its bounds is refused on the way out.
    assert!(matches!(
        check(
            "gmail:pick-client-file",
            Direction::Output,
            Some(&json!({ "clientId": "id", "clientSecret": "s", "extra": 1 }))
        ),
        Some(Err(_))
    ));
    let response = setup(Options {
        picked: Some(client_file("id", &"s".repeat(257))),
        ..Options::default()
    })
    .invoke("gmail:pick-client-file", Who::ControlCenter, None)
    .await;
    assert_eq!(response["ok"], json!(false));
    let t = setup(Options::default());
    assert_refused(
        &t.invoke(
            "gmail:pick-client-file",
            Who::ControlCenter,
            Some(json!({ "path": "/x" })),
        )
        .await,
        "INVALID_INPUT",
    );
    assert_eq!(*t.picker.calls.lock().unwrap(), 0);
}

#[tokio::test]
async fn validates_inputs_the_renderer_never_sends_a_url() {
    let t = setup(Options::default());
    assert_refused(
        &t.invoke(
            "gmail:open",
            Who::Notch,
            Some(json!({ "url": "https://evil.test" })),
        )
        .await,
        "INVALID_INPUT",
    );
    assert_refused(
        &t.invoke("gmail:view", Who::Notch, Some(json!({ "open": "yes" })))
            .await,
        "INVALID_INPUT",
    );
    assert_refused(
        &t.invoke("gmail:refresh", Who::Notch, Some(json!({ "force": true })))
            .await,
        "INVALID_INPUT",
    );
    assert!(!t.api.called("open"));
    assert!(!t.api.called("view"));
}

#[tokio::test]
async fn close_message_makes_main_forget_the_open_message_taking_no_input() {
    let t = setup(Options::default());
    assert_eq!(
        t.invoke("gmail:close-message", Who::Notch, None).await,
        json!({ "ok": true, "data": null })
    );
    assert_eq!(t.api.count("close-message"), 1);
    assert_refused(
        &t.invoke(
            "gmail:close-message",
            Who::Notch,
            Some(json!({ "id": "m1" })),
        )
        .await,
        "INVALID_INPUT",
    );
    assert_eq!(t.api.count("close-message"), 1);
}

#[tokio::test]
async fn passes_message_mark_read_delete_and_open_link_through_after_the_token_loads() {
    let t = setup(Options::default());
    assert_eq!(
        t.invoke("gmail:message", Who::Notch, Some(json!({ "id": "m1" })))
            .await,
        json!({ "ok": true, "data": serde_json::to_value(detail("m1")).unwrap() })
    );
    assert!(t.api.called("message:m1"));
    assert_eq!(
        t.invoke("gmail:mark-read", Who::Notch, Some(json!({ "id": "m1" })))
            .await,
        json!({ "ok": true, "data": null })
    );
    assert!(t.api.called("mark-read:m1"));
    assert_eq!(
        t.invoke("gmail:delete", Who::Notch, Some(json!({ "id": "m1" })))
            .await,
        json!({ "ok": true, "data": null })
    );
    assert!(t.api.called("remove:m1"));
    assert_eq!(
        t.invoke(
            "gmail:open-link",
            Who::Notch,
            Some(json!({ "id": "m1", "index": 3 }))
        )
        .await,
        json!({ "ok": true, "data": null })
    );
    assert!(t.api.called("open-link:m1:3"));
}

#[tokio::test]
async fn exposes_invalid_input_and_not_found_from_the_integration() {
    let t = setup(Options::default());
    *t.api.remove_refusal.lock().unwrap() = Some(ExposedError::new(
        IpcErrorCode::InvalidInput,
        "Unknown message",
    ));
    assert_eq!(
        t.invoke("gmail:delete", Who::Notch, Some(json!({ "id": "x" })))
            .await,
        json!({ "ok": false, "error": { "code": "INVALID_INPUT", "message": "Unknown message" } })
    );
    *t.api.message_refusal.lock().unwrap() = Some(ExposedError::new(
        IpcErrorCode::NotFound,
        "The message no longer exists",
    ));
    assert_refused(
        &t.invoke("gmail:message", Who::Notch, Some(json!({ "id": "x" })))
            .await,
        "NOT_FOUND",
    );
    *t.api.open_link_refusal.lock().unwrap() = Some(ExposedError::new(
        IpcErrorCode::InvalidInput,
        "Unknown link",
    ));
    assert_refused(
        &t.invoke(
            "gmail:open-link",
            Who::Notch,
            Some(json!({ "id": "x", "index": 0 })),
        )
        .await,
        "INVALID_INPUT",
    );
}

#[tokio::test]
async fn validates_action_inputs_ids_only_link_by_index() {
    let t = setup(Options::default());
    assert_refused(
        &t.invoke("gmail:delete", Who::Notch, Some(json!({}))).await,
        "INVALID_INPUT",
    );
    assert_refused(
        &t.invoke(
            "gmail:open-link",
            Who::Notch,
            Some(json!({ "id": "m1", "url": "https://evil.test" })),
        )
        .await,
        "INVALID_INPUT",
    );
    assert_refused(
        &t.invoke(
            "gmail:open-link",
            Who::Notch,
            Some(json!({ "id": "m1", "index": 50 })),
        )
        .await,
        "INVALID_INPUT",
    );
    assert!(!t.api.called("remove"));
    assert!(!t.api.called("open-link"));
}

#[tokio::test]
async fn validates_the_message_output_strict_http_https_links_only() {
    let mut extra = serde_json::to_value(detail("m1")).unwrap();
    extra["html"] = json!("<b>x</b>");
    assert!(matches!(
        check("gmail:message", Direction::Output, Some(&extra)),
        Some(Err(_))
    ));
    let bad = setup(Options {
        detail: Some(GmailMessageDetail {
            links: vec![GmailLink {
                text: "x".into(),
                url: "file:///c:/x".into(),
            }],
            ..detail("m1")
        }),
        ..Options::default()
    });
    assert_refused(
        &bad.invoke("gmail:message", Who::Notch, Some(json!({ "id": "m1" })))
            .await,
        "INTERNAL",
    );
}

#[tokio::test]
async fn validates_outputs_no_extra_state_fields_and_at_most_5_messages() {
    let mut leaky = serde_json::to_value(ok_state()).unwrap();
    leaky["token"] = json!("RT");
    assert!(matches!(
        check("gmail:get-state", Direction::Output, Some(&leaky)),
        Some(Err(_))
    ));
    let over_cap = setup(Options {
        state: GmailState {
            unread: Some(101),
            ..ok_state()
        },
        ..Options::default()
    });
    assert_refused(
        &over_cap.invoke("gmail:get-state", Who::Notch, None).await,
        "INTERNAL",
    );
    let many = setup(Options {
        recent: ["1", "2", "3", "4", "5", "6"].map(msg).to_vec(),
        ..Options::default()
    });
    assert_refused(
        &many.invoke("gmail:recent", Who::Notch, None).await,
        "INTERNAL",
    );
}

// ---------------------------------------------------------------------------------------------
// Rust additions

#[tokio::test]
async fn only_the_handlers_that_wait_in_ts_wait_for_the_token_to_load() {
    let t = setup(Options {
        ready: false,
        ..Options::default()
    });
    // `await gmail.ready` in the handler: nothing reaches the integration before the load.
    let waiting = [
        t.spawn("gmail:view", Who::Notch, sample("gmail:view")),
        t.spawn("gmail:refresh", Who::Notch, None),
        t.spawn("gmail:open", Who::Notch, sample("gmail:open")),
        t.spawn("gmail:message", Who::Notch, sample("gmail:message")),
        t.spawn("gmail:mark-read", Who::Notch, sample("gmail:mark-read")),
        t.spawn("gmail:delete", Who::Notch, sample("gmail:delete")),
        t.spawn("gmail:open-link", Who::Notch, sample("gmail:open-link")),
        t.spawn("gmail:close-message", Who::Notch, None),
    ];
    // No wait in the handler (`recent`, `signIn` and `signOut` wait inside the integration).
    for (channel, who) in [
        ("gmail:recent", Who::Notch),
        ("gmail:sign-in", Who::ControlCenter),
        ("gmail:cancel-sign-in", Who::ControlCenter),
        ("gmail:sign-out", Who::ControlCenter),
        ("gmail:pick-client-file", Who::ControlCenter),
    ] {
        assert_eq!(
            t.invoke(channel, who, None).await["ok"],
            json!(true),
            "{channel}"
        );
    }
    settle().await;
    assert_eq!(
        t.api.calls(),
        ["recent", "sign-in", "cancel-sign-in", "sign-out"]
    );
    t.release.send(true).unwrap();
    for call in waiting {
        assert_eq!(call.await.unwrap()["ok"], json!(true));
    }
    for call in [
        "view:true",
        r#"open:Some("1")"#,
        "refresh",
        "message:1",
        "mark-read:1",
        "remove:1",
        "open-link:1:0",
        "close-message",
    ] {
        assert_eq!(t.api.count(call), 1, "{call}");
    }
}

#[tokio::test]
async fn every_channel_answers_unavailable_until_the_integration_is_installed() {
    let slot: Arc<GmailSlot> = Arc::default();
    let registry = registry_over(&slot);
    for (channel, who) in ALLOWED {
        let caller = if who == "control-center" {
            Who::ControlCenter
        } else {
            Who::Notch
        };
        assert_eq!(
            invoke(&registry, channel, caller, sample(channel)).await,
            json!({ "ok": false, "error": { "code": "UNAVAILABLE", "message": "Not available yet" } }),
            "{channel}"
        );
    }
}

#[tokio::test]
async fn a_forbidden_caller_never_reaches_the_integration_or_the_dialog() {
    let t = setup(Options::default());
    for (channel, who) in ALLOWED {
        let caller = if who == "notch" {
            Who::ControlCenter
        } else {
            Who::Other
        };
        t.invoke(channel, caller, sample(channel)).await;
    }
    assert_eq!(t.api.calls(), Vec::<String>::new());
    assert_eq!(*t.picker.calls.lock().unwrap(), 0);
}

/// A sign-in and a sign-out that only finish when told to, then record that they ran to the
/// end.
struct SlowSession {
    inner: FakeApi,
    finish: watch::Receiver<bool>,
    finished: Mutex<Vec<&'static str>>,
}

impl GmailApi for SlowSession {
    fn ready(&self) -> BoxFuture<'_, ()> {
        self.inner.ready()
    }
    fn state(&self) -> GmailState {
        self.inner.state()
    }
    fn recent(&self) -> BoxFuture<'_, Vec<GmailMessage>> {
        self.inner.recent()
    }
    fn set_view_open(&self, open: bool) {
        self.inner.set_view_open(open);
    }
    fn refresh(&self) {
        self.inner.refresh();
    }
    fn open(&self, id: Option<&str>) {
        self.inner.open(id);
    }
    fn message(&self, id: String) -> BoxFuture<'_, Result<GmailMessageDetail, ExposedError>> {
        self.inner.message(id)
    }
    fn mark_read(&self, id: String) -> BoxFuture<'_, Result<(), ExposedError>> {
        self.inner.mark_read(id)
    }
    fn remove(&self, id: String) -> BoxFuture<'_, Result<(), ExposedError>> {
        self.inner.remove(id)
    }
    fn open_link(&self, id: &str, index: u32) -> Result<(), ExposedError> {
        self.inner.open_link(id, index)
    }
    fn close_message(&self) {
        self.inner.close_message();
    }
    fn sign_in(&self) -> BoxFuture<'_, GmailSignInResult> {
        let mut finish = self.finish.clone();
        Box::pin(async move {
            let _ = finish.wait_for(|done| *done).await;
            self.finished.lock().unwrap().push("sign-in");
            GmailSignInResult::Ok
        })
    }
    fn cancel_sign_in(&self) {
        self.inner.cancel_sign_in();
    }
    fn sign_out(&self) -> BoxFuture<'_, ()> {
        let mut finish = self.finish.clone();
        Box::pin(async move {
            let _ = finish.wait_for(|done| *done).await;
            self.finished.lock().unwrap().push("sign-out");
        })
    }
}

/// Starts `channel` over a [`SlowSession`], drops the call half way, then lets the session
/// operation finish: what ran to the end.
async fn drop_call_then_finish(channel: &'static str) -> Vec<&'static str> {
    let (_release, ready) = watch::channel(true);
    let (finish_tx, finish) = watch::channel(false);
    let api = Arc::new(SlowSession {
        inner: FakeApi {
            ready,
            state: ok_state(),
            recent: Vec::new(),
            detail: None,
            remove_refusal: Mutex::new(None),
            message_refusal: Mutex::new(None),
            open_link_refusal: Mutex::new(None),
            calls: Mutex::new(Vec::new()),
        },
        finish,
        finished: Mutex::new(Vec::new()),
    });
    let slot: Arc<GmailSlot> = Arc::default();
    assert!(slot
        .set(GmailHandles {
            api: Arc::clone(&api) as Arc<dyn GmailApi>,
            client_file: Arc::new(FakePicker {
                picked: None,
                calls: Mutex::new(0),
            }),
        })
        .is_ok());
    let registry = registry_over(&slot);
    let call = {
        let registry = Arc::clone(&registry);
        tokio::spawn(async move {
            registry
                .dispatch(&ctx(Who::ControlCenter), channel, None)
                .await
        })
    };
    settle().await;
    call.abort();
    let _ = call.await;
    assert!(api.finished.lock().unwrap().is_empty());
    finish_tx.send(true).unwrap();
    settle().await;
    let finished = api.finished.lock().unwrap().clone();
    finished
}

#[tokio::test]
async fn a_dropped_sign_in_call_still_runs_the_sign_in_to_the_end() {
    // `GmailIntegration::sign_in` must never be dropped half way (it would stay signing-in or
    // never save the token): the channel runs it as its own task.
    assert_eq!(drop_call_then_finish("gmail:sign-in").await, ["sign-in"]);
}

#[tokio::test]
async fn a_dropped_sign_out_call_still_runs_the_sign_out_to_the_end() {
    // `GmailIntegration::sign_out` must never be dropped half way (the stored token would
    // survive): the channel runs it as its own task too.
    assert_eq!(drop_call_then_finish("gmail:sign-out").await, ["sign-out"]);
}

/// The capsule as the new-mail alert sees it, recording calls in order.
struct FakeNotch {
    exists: bool,
    calls: Mutex<Vec<String>>,
}

impl MailNotch for FakeNotch {
    fn exists(&self) -> bool {
        self.exists
    }

    fn emit(&self, mail: &GmailNewMail) {
        self.calls.lock().unwrap().push(format!(
            "gmail:new-mail {}",
            serde_json::to_string(mail).unwrap()
        ));
    }

    fn dispatch(&self, event: NotchEvent) {
        let name = match event {
            NotchEvent::Mail { on } => format!("mail on={on}"),
            _ => "other".into(),
        };
        self.calls.lock().unwrap().push(name);
    }
}

#[test]
fn new_mail_event_goes_before_the_notch_alert() {
    let mail = GmailNewMail {
        count: 2,
        id: "m9".into(),
        from: Some("Ann".into()),
        subject: None,
    };
    let notch = Arc::new(FakeNotch {
        exists: true,
        calls: Mutex::new(Vec::new()),
    });
    let listener = new_mail_listener(Arc::clone(&notch) as Arc<dyn MailNotch>);
    listener(&mail);
    assert_eq!(
        *notch.calls.lock().unwrap(),
        [
            r#"gmail:new-mail {"count":2,"id":"m9","from":"Ann"}"#.to_owned(),
            "mail on=true".to_owned(),
        ]
    );
    // Without the notch window there is nothing to alert: neither the payload nor the alert.
    let gone = FakeNotch {
        exists: false,
        calls: Mutex::new(Vec::new()),
    };
    deliver_new_mail(&gone, &mail);
    assert!(gone.calls.lock().unwrap().is_empty());
}

// ---------------------------------------------------------------------------------------------
// no_gmail_output_carries_a_token: the real integration and client over a fake Google.

const API_BASE: &str = "http://127.0.0.1:9";
const STORED_RT: &str = "RT-SECRET-stored-0123";
const NEW_RT: &str = "RT-SECRET-new-4567";
const ACCESS_1: &str = "AT-SECRET-first-89ab";
const ACCESS_2: &str = "AT-SECRET-second-cdef";
const CLIENT_SECRET: &str = "GOCSPX-CLIENT-SECRET";
const FULL_SCOPE: &str = "https://mail.google.com/";

fn b64(text: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(text)
}

/// Gmail's REST API for the ids it is told are unread, recording every request.
struct FakeGoogle {
    unread: Mutex<Vec<&'static str>>,
    requests: Mutex<Vec<HttpRequest>>,
}

impl FakeGoogle {
    fn metadata(id: &str) -> Value {
        json!({
            "id": id, "threadId": format!("thread-{id}"), "snippet": "snippet text",
            "labelIds": ["UNREAD", "INBOX"], "internalDate": "1762855200000",
            "payload": { "headers": [
                { "name": "From", "value": "Ann <ann@example.com>" },
                { "name": "Subject", "value": "Subject line" },
                { "name": "Date", "value": "Tue, 11 Nov 2025 10:00:00 +0000" }
            ] }
        })
    }
}

impl Transport for FakeGoogle {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, TransportError>> {
        let url = url::Url::parse(&request.url).unwrap();
        let path = url
            .path()
            .strip_prefix("/gmail/v1/users/me/")
            .unwrap_or_default()
            .to_owned();
        let query: Vec<(String, String)> = url.query_pairs().into_owned().collect();
        let method = request.method;
        self.requests.lock().unwrap().push(request);
        let format = query
            .iter()
            .find(|(name, _)| name == "format")
            .map(|(_, value)| value.clone());
        let body = match (method, path.as_str(), format.as_deref()) {
            (Method::Get, "profile", _) => json!({ "emailAddress": "me@example.com" }),
            (Method::Get, "messages", _) => {
                let unread = query
                    .iter()
                    .any(|(name, value)| name == "q" && value.contains("is:unread"));
                let ids: Vec<&str> = if unread {
                    self.unread.lock().unwrap().clone()
                } else {
                    vec!["m1"]
                };
                json!({ "messages": ids.iter().map(|id| json!({ "id": id, "threadId": format!("thread-{id}") })).collect::<Vec<_>>() })
            }
            (Method::Get, id, Some("metadata")) => {
                Self::metadata(id.trim_start_matches("messages/"))
            }
            (Method::Get, _, Some("full")) => json!({
                "id": "m1", "threadId": "thread-m1", "labelIds": ["UNREAD"],
                "internalDate": "1762855200000",
                "payload": {
                    "mimeType": "text/plain",
                    "headers": [
                        { "name": "From", "value": "Ann <ann@example.com>" },
                        { "name": "Subject", "value": "Subject line" }
                    ],
                    "body": { "size": 40, "data": b64("Body text https://example.com/link") }
                }
            }),
            (Method::Post, _, _) => json!({}),
            (Method::Delete, _, _) => {
                return Box::pin(async { Ok(HttpResponse::new(204)) });
            }
            _ => return Box::pin(async { Ok(HttpResponse::new(404)) }),
        };
        let response = HttpResponse::new(200).with_body(serde_json::to_vec(&body).unwrap());
        Box::pin(async move { Ok(response) })
    }
}

/// OAuth: a sign-in that grants `NEW_RT`, refreshes that hand out access tokens, a revoke that
/// records the token.
struct FakeAuth {
    revoked: Mutex<Vec<String>>,
}

impl GmailAuth for FakeAuth {
    fn sign_in(&self) -> BoxFuture<'_, Result<SignInResult, SignInError>> {
        Box::pin(async {
            Ok(SignInResult {
                refresh_token: NEW_RT.into(),
                access_token: ACCESS_2.into(),
                expires_at: 4_000_000_000_000.0,
                scope: Some(FULL_SCOPE.into()),
            })
        })
    }

    fn cancel(&self) {}

    fn refresh<'a>(
        &'a self,
        refresh_token: &'a str,
    ) -> BoxFuture<'a, Result<RefreshResult, GmailAuthError>> {
        let access = if refresh_token == STORED_RT {
            ACCESS_1
        } else {
            ACCESS_2
        };
        Box::pin(async move {
            Ok(RefreshResult {
                access_token: access.into(),
                expires_at: 4_000_000_000_000.0,
                scope: Some(FULL_SCOPE.into()),
            })
        })
    }

    fn revoke<'a>(&'a self, token: &'a str) -> BoxFuture<'a, ()> {
        self.revoked.lock().unwrap().push(token.to_owned());
        Box::pin(async {})
    }
}

struct MemoryToken(Mutex<Option<String>>);

impl TokenStore for MemoryToken {
    fn load(&self) -> BoxFuture<'_, Result<Option<String>, String>> {
        let token = self.0.lock().unwrap().clone();
        Box::pin(async move { Ok(token) })
    }

    fn save<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<(), String>> {
        *self.0.lock().unwrap() = Some(token.to_owned());
        Box::pin(async { Ok(()) })
    }

    fn clear(&self) -> BoxFuture<'_, Result<(), String>> {
        *self.0.lock().unwrap() = None;
        Box::pin(async { Ok(()) })
    }

    fn persistent(&self) -> bool {
        true
    }
}

struct FixedClient;

impl SettingsSource for FixedClient {
    fn get(&self) -> GmailSettings {
        GmailSettings {
            client_id: "cid.apps.googleusercontent.com".into(),
            client_secret: CLIENT_SECRET.into(),
            alerts: GmailAlertSettings {
                enabled: true,
                hide_content: false,
                sound: true,
            },
        }
    }
}

#[tokio::test]
async fn no_gmail_output_carries_a_token() {
    // Installed before anything logs (the capture is process-wide; this test reads only the
    // lines of its own thread: a current-thread runtime runs every spawned task here).
    let capture = crate::services::test_log::capture().expect("the test logger");
    let google = Arc::new(FakeGoogle {
        unread: Mutex::new(vec!["m1"]),
        requests: Mutex::new(Vec::new()),
    });
    let auth = Arc::new(FakeAuth {
        revoked: Mutex::new(Vec::new()),
    });
    let timers = Arc::new(TestTimers::new());
    let states: Arc<Mutex<Vec<Value>>> = Arc::default();
    let opened: Arc<Mutex<Vec<String>>> = Arc::default();
    let notch = Arc::new(FakeNotch {
        exists: true,
        calls: Mutex::new(Vec::new()),
    });
    let deps = GmailDeps {
        settings: Arc::new(FixedClient),
        store: Arc::new(MemoryToken(Mutex::new(Some(STORED_RT.into())))),
        auth: {
            let auth = Arc::clone(&auth);
            Arc::new(move |_credentials: &Credentials| Arc::clone(&auth) as Arc<dyn GmailAuth>)
                as AuthFactory
        },
        client: {
            let google = Arc::clone(&google);
            Arc::new(move |access: Arc<dyn TokenAccess>| {
                Arc::new(GmailClient::new(
                    Arc::clone(&google) as Arc<dyn Transport>,
                    API_BASE,
                    access,
                )) as Arc<dyn GmailApiClient>
            }) as ClientFactory
        },
        timers: Arc::clone(&timers) as Arc<dyn Timers>,
        clock: Arc::new(WallClock::fixed(
            Utc.with_ymd_and_hms(2026, 11, 11, 10, 0, 0).unwrap(),
        )),
        spawn: Arc::new(|future| {
            tokio::spawn(future);
        }),
        emit: {
            let states = Arc::clone(&states);
            Arc::new(move |state: &GmailState| {
                states.lock().unwrap().push(json!({ "gmail:state": state }));
            })
        },
        open_external: {
            let opened = Arc::clone(&opened);
            Arc::new(move |url: String| {
                opened.lock().unwrap().push(url);
                Box::pin(async { Ok(()) }) as BoxFuture<'static, Result<(), String>>
            })
        },
        on_new_mail: Some(new_mail_listener(Arc::clone(&notch) as Arc<dyn MailNotch>)),
    };
    let integration = GmailIntegration::new(deps);
    let slot: Arc<GmailSlot> = Arc::default();
    assert!(slot
        .set(GmailHandles {
            api: Arc::clone(&integration) as Arc<dyn GmailApi>,
            client_file: Arc::new(FakePicker {
                picked: Some(client_file("cid", CLIENT_SECRET)),
                calls: Mutex::new(0),
            }),
        })
        .is_ok());
    let registry = registry_over(&slot);
    integration.start();
    settle().await;

    let mut responses = Vec::new();
    let call = |channel: &'static str, who: Who, input: Option<Value>| {
        let registry = Arc::clone(&registry);
        async move {
            let response = invoke(&registry, channel, who, input).await;
            json!({ channel: response })
        }
    };
    for (channel, who, input) in [
        ("gmail:get-state", Who::ControlCenter, None),
        ("gmail:view", Who::Notch, Some(json!({ "open": true }))),
        ("gmail:recent", Who::Notch, None),
        ("gmail:message", Who::Notch, Some(json!({ "id": "m1" }))),
        (
            "gmail:open-link",
            Who::Notch,
            Some(json!({ "id": "m1", "index": 0 })),
        ),
        (
            "gmail:open-link",
            Who::Notch,
            Some(json!({ "id": "m1", "index": 9 })),
        ),
        ("gmail:open", Who::Notch, Some(json!({ "id": "m1" }))),
        (
            "gmail:open",
            Who::Notch,
            Some(json!({ "id": "never-shown" })),
        ),
        ("gmail:mark-read", Who::Notch, Some(json!({ "id": "m1" }))),
        ("gmail:refresh", Who::Notch, None),
        ("gmail:close-message", Who::Notch, None),
        ("gmail:pick-client-file", Who::ControlCenter, None),
    ] {
        responses.push(call(channel, who, input).await);
        settle().await;
    }
    // New mail on the next tick.
    google.unread.lock().unwrap().insert(0, "m2");
    timers.advance(60_000);
    settle().await;
    for (channel, who, input) in [
        ("gmail:delete", Who::Notch, Some(json!({ "id": "m1" }))),
        ("gmail:sign-out", Who::ControlCenter, None),
        ("gmail:sign-in", Who::ControlCenter, None),
        ("gmail:cancel-sign-in", Who::ControlCenter, None),
        ("gmail:get-state", Who::Notch, None),
        ("gmail:recent", Who::Notch, None),
    ] {
        responses.push(call(channel, who, input).await);
        settle().await;
    }
    integration.dispose();

    // The calls did reach a working session.
    assert_eq!(responses[0]["gmail:get-state"]["data"]["status"], "ok");
    assert_eq!(responses[2]["gmail:recent"]["data"][0]["id"], "m1");
    assert_eq!(
        responses[3]["gmail:message"]["data"]["body"],
        "Body text https://example.com/link"
    );
    assert_eq!(
        responses[5]["gmail:open-link"]["error"]["code"],
        "INVALID_INPUT"
    );
    // Signed in again after the sign-out.
    assert_eq!(responses[14]["gmail:sign-in"]["data"], "ok");
    assert_eq!(responses[16]["gmail:get-state"]["data"]["status"], "ok");
    let mail = notch.calls.lock().unwrap().clone();
    assert_eq!(
        mail,
        [
            r#"gmail:new-mail {"count":1,"id":"m2","from":"Ann","subject":"Subject line"}"#
                .to_owned(),
            "mail on=true".to_owned()
        ]
    );
    assert_eq!(*auth.revoked.lock().unwrap(), [STORED_RT]);
    // The tokens went to Google, in the header only.
    let requests = google.requests.lock().unwrap().clone();
    for access in [ACCESS_1, ACCESS_2] {
        assert!(requests.iter().any(|request| request
            .header_value("authorization")
            .is_some_and(|value| value == format!("Bearer {access}"))));
    }
    assert!(requests
        .iter()
        .all(|request| !request.url.contains("SECRET")));
    // Nothing that leaves main carries a token: answers, events, opened URLs, log lines. The
    // client secret appears only in the answer of `gmail:pick-client-file`, which is its job.
    let picked = responses.remove(11);
    assert_eq!(
        picked["gmail:pick-client-file"]["data"]["clientSecret"],
        CLIENT_SECRET
    );
    let log = capture
        .lines_of_this_thread()
        .into_iter()
        .filter(|line| line.contains(&format!("{LOG_TARGET} ")))
        .collect::<Vec<_>>();
    assert!(!log.is_empty());
    let out = [
        serde_json::to_string(&responses).unwrap(),
        serde_json::to_string(&*states.lock().unwrap()).unwrap(),
        mail.join("\n"),
        opened.lock().unwrap().join("\n"),
        log.join("\n"),
    ];
    assert!(!states.lock().unwrap().is_empty());
    for text in out {
        for secret in ["RT-SECRET", "AT-SECRET", CLIENT_SECRET, "Bearer"] {
            assert!(!text.contains(secret), "{secret} left main: {text}");
        }
    }
}
