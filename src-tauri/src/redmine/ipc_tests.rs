//! Port of `tests/unit/main/redmine-ipc.test.ts` (20 cases: 8 `it` blocks plus the 12 rows of
//! the guard `it.each`, each its own test): guards, pass-through, input and output validation of
//! the twelve `redmine:*` channels, against a fake integration. Plus
//! `no_redmine_output_carries_the_key`, over the real integration and client on a fake transport.

use std::sync::{Arc, Mutex};

use chrono::{TimeZone, Utc};
use serde_json::{json, Value};
use tokio::sync::watch;

use super::*;
use crate::contract::redmine::{
    LogTimeInput, Named, RedmineActivity, RedmineIssue, RedmineIssueDetail, RedmineIssueList,
    RedmineSetKeyResult, RedmineState, RedmineStatus, RedmineSummaryChanged, RedmineSummaryResult,
    RedmineWriteError, RedmineWriteResult, SetKeyReason, UpdateIssueInput,
};
use crate::contract::settings::{RedmineEndOfDaySettings, RedmineSettings};
use crate::contract::{check, Direction};
use crate::http::{HttpRequest, HttpResponse, Method, Transport, TransportError};
use crate::ipc::{Ctx, IpcErrorCode, Registry, Sender, CONTROL_CENTER, NOTCH};
use crate::redmine::integration::{
    client_factory, RedmineDeps, RedmineIntegration, SettingsSource,
};
use crate::services::clock::WallClock;
use crate::services::secure_token_store::TokenStore;
use crate::services::timers::{TestTimers, Timers};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Who {
    Notch,
    ControlCenter,
    Other,
}

fn ok_state() -> RedmineState {
    RedmineState {
        status: RedmineStatus::Ok,
        account: Some("Alice".into()),
        today_hours: Some(5.5),
        updated_at: Some(1_763_000_000_000.0),
        persistent: true,
    }
}

fn issue() -> RedmineIssue {
    RedmineIssue {
        id: 12,
        subject: "T".into(),
        project: "P".into(),
        status: Named {
            id: 2,
            name: "In progress".into(),
        },
        estimated_hours: None,
        spent_hours: None,
        updated_on: "2026-11-12T10:00:00Z".into(),
    }
}

fn detail() -> RedmineIssueDetail {
    let issue = issue();
    RedmineIssueDetail {
        id: issue.id,
        subject: issue.subject,
        project: issue.project,
        status: issue.status,
        estimated_hours: issue.estimated_hours,
        spent_hours: issue.spent_hours,
        updated_on: issue.updated_on,
        allowed_statuses: vec![Named {
            id: 3,
            name: "Done".into(),
        }],
    }
}

fn log_entry() -> Value {
    json!({ "issueId": 12, "spentOn": "2026-11-01", "hours": 1.5, "activityId": 9, "comments": "work" })
}

/// `{ ...logEntry, [field]: value }`.
fn log_entry_with(field: &str, value: Value) -> Value {
    let mut entry = log_entry();
    entry[field] = value;
    entry
}

/// The integration as the channels see it, recording every call (`vi.fn`).
struct FakeApi {
    ready: watch::Receiver<bool>,
    state: RedmineState,
    issues: RedmineIssueList,
    set_key: RedmineSetKeyResult,
    write: RedmineWriteResult,
    open_refusal: Mutex<Option<&'static str>>,
    calls: Mutex<Vec<String>>,
}

impl FakeApi {
    fn record(&self, call: String) {
        self.calls.lock().unwrap().push(call);
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }

    fn called(&self, prefix: &str) -> bool {
        self.calls().iter().any(|call| call.starts_with(prefix))
    }
}

impl RedmineApi for FakeApi {
    fn ready(&self) -> BoxFuture<'_, ()> {
        let mut ready = self.ready.clone();
        Box::pin(async move {
            let _ = ready.wait_for(|done| *done).await;
        })
    }

    fn state(&self) -> RedmineState {
        self.record("state".into());
        self.state.clone()
    }

    fn issues(&self) -> BoxFuture<'_, RedmineIssueList> {
        self.record("issues".into());
        let issues = self.issues.clone();
        Box::pin(async move { issues })
    }

    fn issue(&self, id: u64) -> BoxFuture<'_, Result<RedmineIssueDetail, ExposedError>> {
        self.record(format!("issue:{id}"));
        Box::pin(async { Ok(detail()) })
    }

    fn activities(&self) -> BoxFuture<'_, Result<Vec<RedmineActivity>, ExposedError>> {
        self.record("activities".into());
        Box::pin(async {
            Ok(vec![RedmineActivity {
                id: 9,
                name: "Dev".into(),
                is_default: true,
            }])
        })
    }

    fn update_issue(&self, input: UpdateIssueInput) -> BoxFuture<'_, RedmineWriteResult> {
        self.record(format!(
            "update-issue:{}",
            serde_json::to_string(&input).unwrap()
        ));
        let result = self.write.clone();
        Box::pin(async move { result })
    }

    fn log_time(&self, input: LogTimeInput) -> BoxFuture<'_, RedmineWriteResult> {
        self.record(format!(
            "log-time:{}",
            serde_json::to_string(&input).unwrap()
        ));
        let result = self.write.clone();
        Box::pin(async move { result })
    }

    fn summary(&self) -> BoxFuture<'_, RedmineSummaryResult> {
        self.record("summary".into());
        Box::pin(async {
            RedmineSummaryResult {
                summary: None,
                error: false,
            }
        })
    }

    fn set_view_open(&self, open: bool) {
        self.record(format!("view:{open}"));
    }

    fn refresh(&self) {
        self.record("refresh".into());
    }

    fn open(&self, id: u64) -> Result<(), ExposedError> {
        self.record(format!("open:{id}"));
        match self.open_refusal.lock().unwrap().take() {
            Some(message) => Err(ExposedError::new(IpcErrorCode::InvalidInput, message)),
            None => Ok(()),
        }
    }

    fn set_key(&self, url: String, key: String) -> BoxFuture<'_, RedmineSetKeyResult> {
        self.record(format!("set-key:{url}:{key}"));
        let result = self.set_key.clone();
        Box::pin(async move { result })
    }

    fn clear(&self) -> BoxFuture<'_, ()> {
        self.record("clear".into());
        Box::pin(async {})
    }
}

struct Options {
    ready: bool,
    state: RedmineState,
    issues: RedmineIssueList,
    set_key: RedmineSetKeyResult,
    write: RedmineWriteResult,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            ready: true,
            state: ok_state(),
            issues: RedmineIssueList {
                issues: vec![issue()],
                truncated: false,
            },
            set_key: RedmineSetKeyResult::Accepted {
                account: "Alice".into(),
            },
            write: RedmineWriteResult::Done,
        }
    }
}

struct Harness {
    registry: Arc<Registry>,
    api: Arc<FakeApi>,
    release: watch::Sender<bool>,
}

fn setup(options: Options) -> Harness {
    let (release, ready) = watch::channel(options.ready);
    let api = Arc::new(FakeApi {
        ready,
        state: options.state,
        issues: options.issues,
        set_key: options.set_key,
        write: options.write,
        open_refusal: Mutex::new(None),
        calls: Mutex::new(Vec::new()),
    });
    let slot: Arc<RedmineSlot> = Arc::default();
    assert!(slot.set(Arc::clone(&api) as Arc<dyn RedmineApi>).is_ok());
    Harness {
        registry: registry_over(&slot),
        api,
        release,
    }
}

fn registry_over(slot: &Arc<RedmineSlot>) -> Arc<Registry> {
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
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

const ALLOWED: [(&str, &str); 12] = [
    ("redmine:get-state", "both"),
    ("redmine:issues", "notch"),
    ("redmine:issue", "notch"),
    ("redmine:activities", "notch"),
    ("redmine:update-issue", "notch"),
    ("redmine:log-time", "notch"),
    ("redmine:summary", "notch"),
    ("redmine:view", "notch"),
    ("redmine:refresh", "notch"),
    ("redmine:open", "notch"),
    ("redmine:set-key", "control-center"),
    ("redmine:clear", "control-center"),
];

fn sample(channel: &str) -> Option<Value> {
    match channel {
        "redmine:issue" => Some(json!({ "id": 12 })),
        "redmine:update-issue" => Some(json!({ "id": 12, "statusId": 3 })),
        "redmine:log-time" => Some(log_entry()),
        "redmine:view" => Some(json!({ "open": true })),
        "redmine:open" => Some(json!({ "id": 12 })),
        "redmine:set-key" => {
            Some(json!({ "url": "https://redmine.example.test", "key": "fake-key" }))
        }
        _ => None,
    }
}

fn code(response: &Value) -> &Value {
    &response["error"]["code"]
}

// ---------------------------------------------------------------------------------------------
// redmine IPC guards

#[test]
fn covers_every_redmine_channel() {
    let mut ours: Vec<&str> = ALLOWED.iter().map(|(name, _)| *name).collect();
    ours.sort_unstable();
    let mut known: Vec<&str> = crate::ipc::known_channels()
        .iter()
        .copied()
        .filter(|name| name.starts_with("redmine:"))
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
            assert_eq!(response["ok"], json!(true), "{channel}: {response}");
        } else {
            assert_eq!(response["ok"], json!(false), "{channel}");
            assert_eq!(code(&response), &json!("FORBIDDEN"), "{channel}");
        }
    }
}

#[tokio::test]
async fn get_state_is_reachable_only_from_both() {
    reachable_only_from("redmine:get-state").await;
}

#[tokio::test]
async fn issues_is_reachable_only_from_notch() {
    reachable_only_from("redmine:issues").await;
}

#[tokio::test]
async fn issue_is_reachable_only_from_notch() {
    reachable_only_from("redmine:issue").await;
}

#[tokio::test]
async fn activities_is_reachable_only_from_notch() {
    reachable_only_from("redmine:activities").await;
}

#[tokio::test]
async fn update_issue_is_reachable_only_from_notch() {
    reachable_only_from("redmine:update-issue").await;
}

#[tokio::test]
async fn log_time_is_reachable_only_from_notch() {
    reachable_only_from("redmine:log-time").await;
}

#[tokio::test]
async fn summary_is_reachable_only_from_notch() {
    reachable_only_from("redmine:summary").await;
}

#[tokio::test]
async fn view_is_reachable_only_from_notch() {
    reachable_only_from("redmine:view").await;
}

#[tokio::test]
async fn refresh_is_reachable_only_from_notch() {
    reachable_only_from("redmine:refresh").await;
}

#[tokio::test]
async fn open_is_reachable_only_from_notch() {
    reachable_only_from("redmine:open").await;
}

#[tokio::test]
async fn set_key_is_reachable_only_from_control_center() {
    reachable_only_from("redmine:set-key").await;
}

#[tokio::test]
async fn clear_is_reachable_only_from_control_center() {
    reachable_only_from("redmine:clear").await;
}

#[tokio::test]
async fn a_forbidden_caller_never_reaches_the_integration() {
    let t = setup(Options::default());
    t.invoke("redmine:set-key", Who::Notch, sample("redmine:set-key"))
        .await;
    t.invoke("redmine:clear", Who::Notch, None).await;
    t.invoke(
        "redmine:open",
        Who::ControlCenter,
        Some(json!({ "id": 12 })),
    )
    .await;
    t.invoke("redmine:issues", Who::ControlCenter, None).await;
    t.invoke(
        "redmine:update-issue",
        Who::ControlCenter,
        Some(json!({ "id": 12, "statusId": 3 })),
    )
    .await;
    t.invoke("redmine:log-time", Who::ControlCenter, Some(log_entry()))
        .await;
    assert_eq!(t.api.calls(), Vec::<String>::new());
}

// ---------------------------------------------------------------------------------------------
// redmine IPC handlers

#[tokio::test]
async fn get_state_view_refresh_and_open_wait_for_the_stored_key_to_load() {
    let t = setup(Options {
        ready: false,
        ..Options::default()
    });
    let pending = [
        t.spawn("redmine:get-state", Who::ControlCenter, None),
        t.spawn("redmine:view", Who::Notch, Some(json!({ "open": true }))),
        t.spawn("redmine:refresh", Who::Notch, None),
        t.spawn("redmine:open", Who::Notch, Some(json!({ "id": 12 }))),
    ];
    settle().await;
    assert!(!t.api.called("state"));
    assert!(!t.api.called("view"));
    assert!(!t.api.called("refresh"));
    assert!(!t.api.called("open"));
    t.release.send(true).unwrap();
    let mut responses = Vec::new();
    for call in pending {
        responses.push(call.await.unwrap());
    }
    assert_eq!(
        responses,
        [
            json!({ "ok": true, "data": serde_json::to_value(ok_state()).unwrap() }),
            json!({ "ok": true, "data": null }),
            json!({ "ok": true, "data": null }),
            json!({ "ok": true, "data": null }),
        ]
    );
    assert!(t.api.called("view:true"));
    assert!(t.api.called("open:12"));
}

#[tokio::test]
async fn passes_reads_writes_set_key_and_clear_through() {
    let t = setup(Options::default());
    assert_eq!(
        t.invoke("redmine:issues", Who::Notch, None).await,
        json!({ "ok": true, "data": { "issues": [serde_json::to_value(issue()).unwrap()], "truncated": false } })
    );
    let response = t
        .invoke("redmine:issue", Who::Notch, Some(json!({ "id": 12 })))
        .await;
    assert_eq!(response["ok"], json!(true));
    assert_eq!(response["data"]["id"], json!(12));
    assert_eq!(
        response["data"]["allowedStatuses"],
        json!([{ "id": 3, "name": "Done" }])
    );
    assert!(t.api.called("issue:12"));
    assert_eq!(
        t.invoke("redmine:activities", Who::Notch, None).await,
        json!({ "ok": true, "data": [{ "id": 9, "name": "Dev", "isDefault": true }] })
    );
    assert_eq!(
        t.invoke(
            "redmine:update-issue",
            Who::Notch,
            Some(json!({ "id": 12, "estimatedHours": null }))
        )
        .await,
        json!({ "ok": true, "data": { "ok": true } })
    );
    // `null` reaches the integration as "clear the estimate", not as "no estimate given".
    assert!(t
        .api
        .called(r#"update-issue:{"id":12,"estimatedHours":null}"#));
    assert_eq!(
        t.invoke("redmine:log-time", Who::Notch, Some(log_entry()))
            .await,
        json!({ "ok": true, "data": { "ok": true } })
    );
    assert!(t.api.called(
        r#"log-time:{"issueId":12,"spentOn":"2026-11-01","hours":1.5,"activityId":9,"comments":"work"}"#
    ));
    assert_eq!(
        t.invoke("redmine:summary", Who::Notch, None).await,
        json!({ "ok": true, "data": { "summary": null, "error": false } })
    );
    assert_eq!(
        t.invoke(
            "redmine:set-key",
            Who::ControlCenter,
            Some(json!({ "url": "https://redmine.example.test", "key": "fake-key" }))
        )
        .await,
        json!({ "ok": true, "data": { "ok": true, "account": "Alice" } })
    );
    assert!(t
        .api
        .called("set-key:https://redmine.example.test:fake-key"));
    assert_eq!(
        t.invoke("redmine:clear", Who::ControlCenter, None).await,
        json!({ "ok": true, "data": null })
    );
    assert_eq!(
        t.api.calls().iter().filter(|call| *call == "clear").count(),
        1
    );
}

#[tokio::test]
async fn returns_a_refused_write_and_a_failed_key_check_as_data() {
    let forbidden = setup(Options {
        write: RedmineWriteResult::Refused {
            reason: RedmineWriteError::Forbidden,
            messages: None,
        },
        ..Options::default()
    });
    assert_eq!(
        forbidden
            .invoke(
                "redmine:update-issue",
                Who::Notch,
                Some(json!({ "id": 12, "statusId": 3 }))
            )
            .await,
        json!({ "ok": true, "data": { "ok": false, "reason": "forbidden" } })
    );
    let bad_key = setup(Options {
        set_key: RedmineSetKeyResult::Refused {
            reason: SetKeyReason::Auth,
        },
        ..Options::default()
    });
    assert_eq!(
        bad_key
            .invoke(
                "redmine:set-key",
                Who::ControlCenter,
                Some(json!({ "url": "https://redmine.example.test", "key": "k" }))
            )
            .await,
        json!({ "ok": true, "data": { "ok": false, "reason": "auth" } })
    );
}

#[tokio::test]
async fn exposes_invalid_input_from_open_unknown_id_or_origin() {
    let t = setup(Options::default());
    *t.api.open_refusal.lock().unwrap() = Some("Unknown issue");
    assert_eq!(
        t.invoke("redmine:open", Who::Notch, Some(json!({ "id": 99 })))
            .await,
        json!({ "ok": false, "error": { "code": "INVALID_INPUT", "message": "Unknown issue" } })
    );
}

#[tokio::test]
async fn validates_inputs_ids_only_never_a_url_bounded_hours_dates_and_keys() {
    let t = setup(Options::default());
    let cases = [
        (
            "redmine:open",
            Who::Notch,
            Some(json!({ "id": 12, "url": "https://evil.test" })),
        ),
        ("redmine:open", Who::Notch, Some(json!({ "id": 0 }))),
        ("redmine:issue", Who::Notch, Some(json!({ "id": "12" }))),
        (
            "redmine:update-issue",
            Who::Notch,
            Some(json!({ "id": 12 })),
        ),
        (
            "redmine:update-issue",
            Who::Notch,
            Some(json!({ "id": 12, "estimatedHours": 1.234 })),
        ),
        (
            "redmine:log-time",
            Who::Notch,
            Some(log_entry_with("hours", json!(24.01))),
        ),
        (
            "redmine:log-time",
            Who::Notch,
            Some(log_entry_with("hours", json!(0))),
        ),
        (
            "redmine:log-time",
            Who::Notch,
            Some(log_entry_with("spentOn", json!("2999-01-01"))),
        ),
        (
            "redmine:log-time",
            Who::Notch,
            Some(log_entry_with("comments", json!("x".repeat(256)))),
        ),
        (
            "redmine:refresh",
            Who::Notch,
            Some(json!({ "force": true })),
        ),
        ("redmine:view", Who::Notch, Some(json!({}))),
        (
            "redmine:set-key",
            Who::ControlCenter,
            Some(json!({ "url": "https://redmine.example.test", "key": "" })),
        ),
        (
            "redmine:set-key",
            Who::ControlCenter,
            Some(json!({ "url": "https://redmine.example.test", "key": "x".repeat(256) })),
        ),
        ("redmine:clear", Who::ControlCenter, Some(json!({}))),
    ];
    for (channel, who, input) in cases {
        let response = t.invoke(channel, who, input.clone()).await;
        assert_eq!(response["ok"], json!(false), "{channel} {input:?}");
        assert_eq!(
            code(&response),
            &json!("INVALID_INPUT"),
            "{channel} {input:?}"
        );
    }
    assert_eq!(t.api.calls(), Vec::<String>::new());
}

#[tokio::test]
async fn validates_outputs_strict_state_no_key_no_urls_in_lists_strict_key_result() {
    // Rust types cannot carry a key in the state, a URL in an issue or a key back: the strict
    // contract the channels check against refuses those shapes all the same.
    let mut leaky_state = serde_json::to_value(ok_state()).unwrap();
    leaky_state["key"] = json!("secret");
    assert!(matches!(
        check("redmine:get-state", Direction::Output, Some(&leaky_state)),
        Some(Err(_))
    ));
    let mut url_issue = serde_json::to_value(issue()).unwrap();
    url_issue["url"] = json!("https://redmine.example.test/issues/12");
    assert!(matches!(
        check(
            "redmine:issues",
            Direction::Output,
            Some(&json!({ "issues": [url_issue], "truncated": false }))
        ),
        Some(Err(_))
    ));
    assert!(matches!(
        check(
            "redmine:set-key",
            Direction::Output,
            Some(&json!({ "ok": true, "account": "Alice", "key": "secret" }))
        ),
        Some(Err(_))
    ));
    // What the integration returns is checked before it leaves: a value outside the contract
    // is INTERNAL, whatever the channel.
    let internal = |response: &Value| {
        assert_eq!(response["ok"], json!(false), "{response}");
        assert_eq!(code(response), &json!("INTERNAL"), "{response}");
    };
    let negative = setup(Options {
        state: RedmineState {
            today_hours: Some(-1.0),
            ..ok_state()
        },
        ..Options::default()
    });
    internal(&negative.invoke("redmine:get-state", Who::Notch, None).await);
    let long_subject = setup(Options {
        issues: RedmineIssueList {
            issues: vec![RedmineIssue {
                subject: "s".repeat(513),
                ..issue()
            }],
            truncated: false,
        },
        ..Options::default()
    });
    internal(
        &long_subject
            .invoke("redmine:issues", Who::Notch, None)
            .await,
    );
    let long_account = setup(Options {
        set_key: RedmineSetKeyResult::Accepted {
            account: "a".repeat(513),
        },
        ..Options::default()
    });
    internal(
        &long_account
            .invoke(
                "redmine:set-key",
                Who::ControlCenter,
                Some(json!({ "url": "https://redmine.example.test", "key": "k" })),
            )
            .await,
    );
    let too_many_messages = setup(Options {
        write: RedmineWriteResult::Refused {
            reason: RedmineWriteError::Validation,
            messages: Some(vec!["m".into(); 4]),
        },
        ..Options::default()
    });
    internal(
        &too_many_messages
            .invoke("redmine:log-time", Who::Notch, Some(log_entry()))
            .await,
    );
}

// ---------------------------------------------------------------------------------------------
// Rust additions

#[tokio::test]
async fn every_channel_answers_unavailable_until_the_integration_is_installed() {
    let slot: Arc<RedmineSlot> = Arc::default();
    let registry = registry_over(&slot);
    for (channel, who) in ALLOWED {
        let caller = if who == "control-center" {
            Who::ControlCenter
        } else {
            Who::Notch
        };
        let response = invoke(&registry, channel, caller, sample(channel)).await;
        assert_eq!(
            response,
            json!({ "ok": false, "error": { "code": "UNAVAILABLE", "message": "Not available yet" } }),
            "{channel}"
        );
    }
}

const KEY: &str = "SECRET-KEY-0123456789";
const NEW_KEY: &str = "SECRET-KEY-NEW-987654";
const SERVER: &str = "https://redmine.example.test";

/// A Redmine that answers every endpoint the channels reach, recording each request.
struct FakeRedmine {
    requests: Mutex<Vec<HttpRequest>>,
}

impl Transport for FakeRedmine {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, TransportError>> {
        let path = request
            .url
            .strip_prefix(SERVER)
            .unwrap_or_default()
            .split('?')
            .next()
            .unwrap_or_default()
            .to_owned();
        let method = request.method;
        self.requests.lock().unwrap().push(request);
        let body = match (method, path.as_str()) {
            (Method::Get, "/users/current.json") => {
                json!({ "user": { "id": 7, "login": "alice", "firstname": "Alice", "lastname": "Doe" } })
            }
            (Method::Get, "/issues.json") => json!({
                "issues": [{ "id": 12, "subject": "T", "project": { "id": 1, "name": "P" },
                    "status": { "id": 2, "name": "In progress" }, "updated_on": "2026-11-12T10:00:00Z" }],
                "total_count": 1
            }),
            (Method::Get, "/issues/12.json") => json!({
                "issue": { "id": 12, "subject": "T", "project": { "id": 1, "name": "P" },
                    "status": { "id": 2, "name": "In progress" }, "updated_on": "2026-11-12T10:00:00Z",
                    "allowed_statuses": [{ "id": 3, "name": "Done" }] }
            }),
            (Method::Get, "/enumerations/time_entry_activities.json") => {
                json!({ "time_entry_activities": [{ "id": 9, "name": "Dev", "is_default": true }] })
            }
            (Method::Get, "/time_entries.json") => json!({
                "time_entries": [{ "spent_on": "2026-11-16", "hours": 2.5 }],
                "total_count": 1
            }),
            (Method::Put, _) => {
                return Box::pin(async { Ok(HttpResponse::new(204)) });
            }
            (Method::Post, "/time_entries.json") => {
                json!({ "time_entry": { "id": 1 } })
            }
            _ => {
                return Box::pin(async { Ok(HttpResponse::new(404)) });
            }
        };
        let status = if method == Method::Post { 201 } else { 200 };
        let response = HttpResponse::new(status).with_body(serde_json::to_vec(&body).unwrap());
        Box::pin(async move { Ok(response) })
    }
}

struct MemoryKey(Mutex<Option<String>>);

impl TokenStore for MemoryKey {
    fn load(&self) -> BoxFuture<'_, Result<Option<String>, String>> {
        let key = self.0.lock().unwrap().clone();
        Box::pin(async move { Ok(key) })
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

struct FixedServer;

impl SettingsSource for FixedServer {
    fn get(&self) -> RedmineSettings {
        RedmineSettings {
            url: SERVER.into(),
            daily_target_hours: 8.0,
            end_of_day: RedmineEndOfDaySettings {
                enabled: true,
                time: "18:00".into(),
                sound: true,
            },
        }
    }

    fn update(&self, _url: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

#[tokio::test]
async fn no_redmine_output_carries_the_key() {
    // Installed before anything logs (the capture is process-wide; this test reads only the
    // lines of its own thread: a current-thread runtime runs every spawned task here).
    let capture = crate::services::test_log::capture().expect("the test logger");
    let transport = Arc::new(FakeRedmine {
        requests: Mutex::new(Vec::new()),
    });
    let events: Arc<Mutex<Vec<Value>>> = Arc::default();
    let opened: Arc<Mutex<Vec<String>>> = Arc::default();
    let deps = RedmineDeps {
        settings: Arc::new(FixedServer),
        store: Arc::new(MemoryKey(Mutex::new(Some(KEY.into())))),
        client: client_factory(Arc::clone(&transport) as Arc<dyn Transport>, None),
        timers: Arc::new(TestTimers::new()) as Arc<dyn Timers>,
        // Monday 16 Nov 2026, 10:00 in Madrid.
        clock: Arc::new(WallClock::fixed(
            Utc.with_ymd_and_hms(2026, 11, 16, 9, 0, 0).unwrap(),
        )),
        spawn: Arc::new(|future| {
            tokio::spawn(future);
        }),
        emit: {
            let events = Arc::clone(&events);
            Arc::new(move |state: &RedmineState| {
                events
                    .lock()
                    .unwrap()
                    .push(json!({ "redmine:state": state }));
            })
        },
        emit_summary: {
            let events = Arc::clone(&events);
            Arc::new(move |change: &RedmineSummaryChanged| {
                events
                    .lock()
                    .unwrap()
                    .push(json!({ "redmine:summary-changed": change }));
            })
        },
        open_external: {
            let opened = Arc::clone(&opened);
            Arc::new(move |url: String| {
                opened.lock().unwrap().push(url);
                Box::pin(async { Ok(()) }) as BoxFuture<'static, Result<(), String>>
            })
        },
    };
    let integration = RedmineIntegration::new(deps, chrono_tz::Europe::Madrid);
    let slot: Arc<RedmineSlot> = Arc::default();
    assert!(slot
        .set(Arc::clone(&integration) as Arc<dyn RedmineApi>)
        .is_ok());
    let registry = registry_over(&slot);
    integration.start();

    let calls: Vec<(&str, Who, Option<Value>)> = vec![
        ("redmine:get-state", Who::ControlCenter, None),
        ("redmine:issues", Who::Notch, None),
        ("redmine:issue", Who::Notch, Some(json!({ "id": 12 }))),
        ("redmine:activities", Who::Notch, None),
        ("redmine:view", Who::Notch, Some(json!({ "open": true }))),
        ("redmine:summary", Who::Notch, None),
        (
            "redmine:update-issue",
            Who::Notch,
            Some(json!({ "id": 12, "statusId": 3 })),
        ),
        ("redmine:log-time", Who::Notch, Some(log_entry())),
        ("redmine:refresh", Who::Notch, None),
        ("redmine:open", Who::Notch, Some(json!({ "id": 12 }))),
        ("redmine:open", Who::Notch, Some(json!({ "id": 99 }))),
        // Refused before the integration: the key must not be quoted back.
        (
            "redmine:set-key",
            Who::Notch,
            Some(json!({ "url": SERVER, "key": NEW_KEY })),
        ),
        (
            "redmine:set-key",
            Who::ControlCenter,
            Some(json!({ "url": SERVER, "key": NEW_KEY, "extra": NEW_KEY })),
        ),
        (
            "redmine:set-key",
            Who::ControlCenter,
            Some(json!({ "url": 1, "key": NEW_KEY })),
        ),
        (
            "redmine:set-key",
            Who::ControlCenter,
            Some(json!({ "url": SERVER, "key": NEW_KEY })),
        ),
        ("redmine:get-state", Who::Notch, None),
        ("redmine:summary", Who::Notch, None),
        ("redmine:clear", Who::ControlCenter, None),
        ("redmine:get-state", Who::ControlCenter, None),
    ];
    let mut responses = Vec::new();
    for (channel, who, input) in calls {
        let response = invoke(&registry, channel, who, input).await;
        responses.push(json!({ channel: response }));
    }
    settle().await;
    integration.dispose();

    // The calls did reach a working session.
    assert_eq!(responses[0]["redmine:get-state"]["data"]["status"], "ok");
    assert_eq!(
        responses[1]["redmine:issues"]["data"]["issues"][0]["id"],
        12
    );
    assert_eq!(
        responses[6]["redmine:update-issue"]["data"],
        json!({ "ok": true })
    );
    assert_eq!(
        responses[7]["redmine:log-time"]["data"],
        json!({ "ok": true })
    );
    assert_eq!(
        responses[14]["redmine:set-key"]["data"],
        json!({ "ok": true, "account": "Alice Doe" })
    );
    assert_eq!(
        responses[18]["redmine:get-state"]["data"]["status"],
        "unconfigured"
    );
    assert_eq!(*opened.lock().unwrap(), [format!("{SERVER}/issues/12")]);
    // Both keys went to the server, in the header only.
    let requests = transport.requests.lock().unwrap().clone();
    for key in [KEY, NEW_KEY] {
        assert!(requests.iter().any(|request| request
            .headers
            .iter()
            .any(|(name, value)| name == "x-redmine-api-key" && value == key)));
    }
    assert!(requests
        .iter()
        .all(|request| !request.url.contains("SECRET")));
    // Nothing that leaves main carries either key: answers, events, opened URLs, log lines.
    let out = [
        serde_json::to_string(&responses).unwrap(),
        serde_json::to_string(&*events.lock().unwrap()).unwrap(),
        opened.lock().unwrap().join("\n"),
        capture.lines_of_this_thread().join("\n"),
    ];
    assert!(!events.lock().unwrap().is_empty());
    for text in out {
        assert!(!text.contains("SECRET"), "a key left main: {text}");
    }
}
