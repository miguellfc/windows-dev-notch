//! Port of 0.1.0's `code-review-ipc.test.ts`: guards, pass-through, input and output
//! validation of the eight `code-review:*` channels, against a fake integration.

use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tokio::sync::watch;

use super::*;
use crate::contract::code_review::{
    CodeReviewState, ContributionSummary, ContributionTotals, ContributionsResult, Platform,
    PlatformState, PlatformStatus, SetTokenReason, SetTokenResult,
};
use crate::contract::{check, Direction};
use crate::ipc::{Ctx, Registry, Sender, CONTROL_CENTER, NOTCH};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Who {
    Notch,
    ControlCenter,
    Other,
}

fn platform_state() -> PlatformState {
    PlatformState {
        status: PlatformStatus::Ok,
        account: Some("me".into()),
        unreviewed: Some(2),
        updated_at: Some("2026-11-13T10:00:00.000Z".into()),
        persistent: true,
    }
}

fn ok_state() -> CodeReviewState {
    CodeReviewState {
        github: platform_state(),
        gitlab: PlatformState {
            status: PlatformStatus::Unconfigured,
            account: None,
            unreviewed: None,
            updated_at: None,
            ..platform_state()
        },
    }
}

/// The integration as the channels see it, recording every call.
struct FakeApi {
    ready: watch::Receiver<bool>,
    state: CodeReviewState,
    set_token: SetTokenResult,
    contributions: ContributionsResult,
    /// What `open_profile` and `open_alert` answer.
    opens: bool,
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

impl CodeReviewApi for FakeApi {
    fn ready(&self) -> BoxFuture<'_, ()> {
        let mut ready = self.ready.clone();
        Box::pin(async move {
            let _ = ready.wait_for(|done| *done).await;
        })
    }

    fn state(&self) -> CodeReviewState {
        self.record("state".into());
        self.state.clone()
    }

    fn refresh(&self) {
        self.record("refresh".into());
    }

    fn open_profile(&self, platform: Platform) -> bool {
        self.record(format!("open-profile:{}", platform.as_str()));
        self.opens
    }

    fn open_alert(&self, platform: Platform) -> bool {
        self.record(format!("open-alert:{}", platform.as_str()));
        self.opens
    }

    fn set_token(
        &self,
        platform: Platform,
        token: String,
        url: Option<String>,
    ) -> BoxFuture<'_, SetTokenResult> {
        self.record(format!("set-token:{}:{token}:{url:?}", platform.as_str()));
        let result = self.set_token.clone();
        Box::pin(async move { result })
    }

    fn clear(&self, platform: Platform) -> BoxFuture<'_, ()> {
        self.record(format!("clear:{}", platform.as_str()));
        Box::pin(async {})
    }

    fn set_view_open(&self, open: bool) {
        self.record(format!("view:{open}"));
    }

    fn contributions(&self, platform: Platform) -> BoxFuture<'_, ContributionsResult> {
        self.record(format!("contributions:{}", platform.as_str()));
        let result = self.contributions.clone();
        Box::pin(async move { result })
    }
}

struct Options {
    ready: bool,
    opens: bool,
    set_token: SetTokenResult,
    contributions: ContributionsResult,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            ready: true,
            opens: true,
            set_token: SetTokenResult::Accepted {
                account: "me".into(),
            },
            contributions: ContributionsResult {
                summary: None,
                error: false,
            },
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
        state: ok_state(),
        set_token: options.set_token,
        contributions: options.contributions,
        opens: options.opens,
        calls: Mutex::new(Vec::new()),
    });
    let slot: Arc<CodeReviewSlot> = Arc::default();
    assert!(slot.set(Arc::clone(&api) as Arc<dyn CodeReviewApi>).is_ok());
    let mut registry = Registry::with_dev_origin(false);
    register(&mut registry, &slot);
    Harness {
        registry: Arc::new(registry),
        api,
        release,
    }
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

impl Harness {
    async fn invoke(&self, channel: &str, who: Who, input: Option<Value>) -> Value {
        self.registry.dispatch(&ctx(who), channel, input).await
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

const ALLOWED: [(&str, &str); 8] = [
    ("code-review:get-state", "both"),
    ("code-review:refresh", "notch"),
    ("code-review:open-profile", "notch"),
    ("code-review:open-alert", "notch"),
    ("code-review:set-token", "control-center"),
    ("code-review:clear", "control-center"),
    ("code-review:view", "notch"),
    ("code-review:contributions", "notch"),
];

fn sample(channel: &str) -> Option<Value> {
    match channel {
        "code-review:open-profile" | "code-review:open-alert" => {
            Some(json!({ "platform": "github" }))
        }
        "code-review:set-token" => Some(json!({ "platform": "github", "token": "fake-token" })),
        "code-review:clear" => Some(json!({ "platform": "gitlab" })),
        "code-review:view" => Some(json!({ "open": true })),
        "code-review:contributions" => Some(json!({ "platform": "github" })),
        _ => None,
    }
}

fn code(response: &Value) -> &Value {
    &response["error"]["code"]
}

#[test]
fn covers_every_code_review_channel() {
    let mut ours: Vec<&str> = ALLOWED.iter().map(|(name, _)| *name).collect();
    ours.sort_unstable();
    let mut known: Vec<&str> = crate::ipc::known_channels()
        .iter()
        .copied()
        .filter(|name| name.starts_with("code-review:"))
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
    reachable_only_from("code-review:get-state").await;
}

#[tokio::test]
async fn refresh_is_reachable_only_from_notch() {
    reachable_only_from("code-review:refresh").await;
}

#[tokio::test]
async fn open_profile_is_reachable_only_from_notch() {
    reachable_only_from("code-review:open-profile").await;
}

#[tokio::test]
async fn open_alert_is_reachable_only_from_notch() {
    reachable_only_from("code-review:open-alert").await;
}

#[tokio::test]
async fn set_token_is_reachable_only_from_control_center() {
    reachable_only_from("code-review:set-token").await;
}

#[tokio::test]
async fn clear_is_reachable_only_from_control_center() {
    reachable_only_from("code-review:clear").await;
}

#[tokio::test]
async fn view_is_reachable_only_from_notch() {
    reachable_only_from("code-review:view").await;
}

#[tokio::test]
async fn contributions_is_reachable_only_from_notch() {
    reachable_only_from("code-review:contributions").await;
}

#[tokio::test]
async fn a_forbidden_caller_never_reaches_the_integration() {
    let t = setup(Options::default());
    t.invoke(
        "code-review:set-token",
        Who::Notch,
        Some(json!({ "platform": "github", "token": "fake-token" })),
    )
    .await;
    t.invoke(
        "code-review:clear",
        Who::Notch,
        Some(json!({ "platform": "github" })),
    )
    .await;
    for channel in ["code-review:open-profile", "code-review:open-alert"] {
        t.invoke(
            channel,
            Who::ControlCenter,
            Some(json!({ "platform": "github" })),
        )
        .await;
    }
    t.invoke(
        "code-review:view",
        Who::ControlCenter,
        Some(json!({ "open": true })),
    )
    .await;
    t.invoke(
        "code-review:contributions",
        Who::ControlCenter,
        Some(json!({ "platform": "github" })),
    )
    .await;
    assert_eq!(t.api.calls(), Vec::<String>::new());
}

#[tokio::test]
async fn get_state_waits_for_the_stored_tokens_to_load() {
    let t = setup(Options {
        ready: false,
        ..Options::default()
    });
    let pending = t.spawn("code-review:get-state", Who::ControlCenter, None);
    settle().await;
    assert!(!t.api.called("state"));
    t.release.send(true).unwrap();
    let response = pending.await.unwrap();
    assert_eq!(
        response,
        json!({ "ok": true, "data": serde_json::to_value(ok_state()).unwrap() })
    );
}

#[tokio::test]
async fn passes_refresh_set_token_and_clear_through() {
    let t = setup(Options::default());
    assert_eq!(
        t.invoke("code-review:refresh", Who::Notch, None).await,
        json!({ "ok": true, "data": null })
    );
    assert_eq!(
        t.invoke(
            "code-review:set-token",
            Who::ControlCenter,
            Some(json!({ "platform": "gitlab", "token": "fake-token", "url": "https://gitlab.example.test" }))
        )
        .await,
        json!({ "ok": true, "data": { "ok": true, "account": "me" } })
    );
    assert_eq!(
        t.invoke(
            "code-review:clear",
            Who::ControlCenter,
            Some(json!({ "platform": "gitlab" }))
        )
        .await,
        json!({ "ok": true, "data": null })
    );
    assert_eq!(
        t.api.calls(),
        vec![
            "refresh".to_owned(),
            "set-token:gitlab:fake-token:Some(\"https://gitlab.example.test\")".to_owned(),
            "clear:gitlab".to_owned(),
        ]
    );
}

#[tokio::test]
async fn returns_a_failed_token_check_as_data() {
    let t = setup(Options {
        set_token: SetTokenResult::Refused {
            reason: SetTokenReason::Url,
        },
        ..Options::default()
    });
    assert_eq!(
        t.invoke(
            "code-review:set-token",
            Who::ControlCenter,
            Some(json!({ "platform": "gitlab", "token": "fake-token", "url": "http://x" }))
        )
        .await,
        json!({ "ok": true, "data": { "ok": false, "reason": "url" } })
    );
}

#[tokio::test]
async fn open_profile_and_open_alert_answer_a_boolean_and_never_a_url() {
    let t = setup(Options::default());
    for channel in ["code-review:open-profile", "code-review:open-alert"] {
        assert_eq!(
            t.invoke(channel, Who::Notch, Some(json!({ "platform": "gitlab" })))
                .await,
            json!({ "ok": true, "data": { "opened": true } }),
            "{channel}"
        );
    }
    assert_eq!(
        t.api.calls(),
        vec![
            "open-profile:gitlab".to_owned(),
            "open-alert:gitlab".to_owned()
        ]
    );
    let nothing = setup(Options {
        opens: false,
        ..Options::default()
    });
    for channel in ["code-review:open-profile", "code-review:open-alert"] {
        assert_eq!(
            nothing
                .invoke(channel, Who::Notch, Some(json!({ "platform": "github" })))
                .await,
            json!({ "ok": true, "data": { "opened": false } }),
            "{channel}"
        );
    }
}

#[tokio::test]
async fn validates_inputs_a_platform_only_never_a_url_known_platforms_bounded_tokens() {
    let t = setup(Options::default());
    let cases = [
        (
            "code-review:open-profile",
            Who::Notch,
            Some(json!({ "platform": "github", "url": "https://evil.test" })),
        ),
        (
            "code-review:open-alert",
            Who::Notch,
            Some(json!({ "platform": "github", "id": "a" })),
        ),
        (
            "code-review:open-alert",
            Who::Notch,
            Some(json!({ "platform": "bitbucket" })),
        ),
        ("code-review:open-profile", Who::Notch, Some(json!({}))),
        ("code-review:open-alert", Who::Notch, None),
        (
            "code-review:refresh",
            Who::Notch,
            Some(json!({ "force": true })),
        ),
        ("code-review:get-state", Who::Notch, Some(json!({}))),
        (
            "code-review:set-token",
            Who::ControlCenter,
            Some(json!({ "platform": "github", "token": "" })),
        ),
        (
            "code-review:set-token",
            Who::ControlCenter,
            Some(json!({ "platform": "github", "token": "x".repeat(256) })),
        ),
        (
            "code-review:set-token",
            Who::ControlCenter,
            Some(json!({ "platform": "github", "token": "t", "extra": 1 })),
        ),
        ("code-review:clear", Who::ControlCenter, Some(json!({}))),
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
async fn validates_outputs_strict_state_no_urls_in_opened_strict_token_result() {
    // Rust types cannot carry a token in the state, a URL in a result or a token back: the strict
    // contract the dispatcher checks against refuses those shapes all the same.
    let mut leaky_state = serde_json::to_value(ok_state()).unwrap();
    leaky_state["github"]["token"] = json!("secret");
    assert!(matches!(
        check(
            "code-review:get-state",
            Direction::Output,
            Some(&leaky_state)
        ),
        Some(Err(_))
    ));
    for output in [
        json!({ "opened": true, "url": "https://github.com/o/r/pull/1" }),
        json!({ "opened": "yes" }),
        json!({}),
    ] {
        assert!(matches!(
            check("code-review:open-alert", Direction::Output, Some(&output)),
            Some(Err(_))
        ));
    }
    assert!(matches!(
        check(
            "code-review:set-token",
            Direction::Output,
            Some(&json!({ "ok": true, "account": "me", "token": "secret" }))
        ),
        Some(Err(_))
    ));
    // The serialized shapes hold exactly the contract's keys.
    let state = serde_json::to_value(ok_state()).unwrap();
    let mut keys: Vec<&str> = state["github"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["account", "persistent", "status", "unreviewed", "updatedAt"]
    );
}

#[tokio::test]
async fn view_waits_for_the_stored_tokens_then_passes_open_close_through() {
    let t = setup(Options {
        ready: false,
        ..Options::default()
    });
    let pending = t.spawn(
        "code-review:view",
        Who::Notch,
        Some(json!({ "open": true })),
    );
    settle().await;
    assert!(!t.api.called("view"));
    t.release.send(true).unwrap();
    assert_eq!(pending.await.unwrap(), json!({ "ok": true, "data": null }));
    assert_eq!(t.api.calls(), vec!["view:true".to_owned()]);
    t.invoke(
        "code-review:view",
        Who::Notch,
        Some(json!({ "open": false })),
    )
    .await;
    assert_eq!(t.api.calls().last().map(String::as_str), Some("view:false"));
    let response = t
        .invoke("code-review:view", Who::Notch, Some(json!({})))
        .await;
    assert_eq!(code(&response), &json!("INVALID_INPUT"));
}

fn invalid_summary() -> ContributionSummary {
    let totals = ContributionTotals::default();
    ContributionSummary {
        month: "acme/secret".into(),
        weeks: vec![],
        month_total: 0,
        active_days: 0,
        today: totals,
        week: totals,
        month_totals: totals,
        partial: false,
        restricted: false,
        updated_at: "2026-11-13T09:00:00.000Z".into(),
    }
}

#[tokio::test]
async fn contributions_returns_the_cached_summary_or_null_and_the_error_flag_validated_strictly() {
    let t = setup(Options::default());
    assert_eq!(
        t.invoke(
            "code-review:contributions",
            Who::Notch,
            Some(json!({ "platform": "gitlab" }))
        )
        .await,
        json!({ "ok": true, "data": { "summary": null, "error": false } })
    );
    assert_eq!(t.api.calls(), vec!["contributions:gitlab".to_owned()]);
    let refused = t
        .invoke(
            "code-review:contributions",
            Who::Notch,
            Some(json!({ "platform": "bitbucket" })),
        )
        .await;
    assert_eq!(code(&refused), &json!("INVALID_INPUT"));
    let failed = setup(Options {
        contributions: ContributionsResult {
            summary: None,
            error: true,
        },
        ..Options::default()
    });
    assert_eq!(
        failed
            .invoke(
                "code-review:contributions",
                Who::Notch,
                Some(json!({ "platform": "github" }))
            )
            .await,
        json!({ "ok": true, "data": { "summary": null, "error": true } })
    );
    let leaky = setup(Options {
        contributions: ContributionsResult {
            summary: Some(invalid_summary()),
            error: false,
        },
        ..Options::default()
    });
    let response = leaky
        .invoke(
            "code-review:contributions",
            Who::Notch,
            Some(json!({ "platform": "github" })),
        )
        .await;
    assert_eq!(code(&response), &json!("INTERNAL"));
    assert!(matches!(
        check(
            "code-review:contributions",
            Direction::Output,
            Some(
                &json!({ "summary": { "month": "2026-11", "repo": "acme/secret" }, "error": false })
            )
        ),
        Some(Err(_))
    ));
}
