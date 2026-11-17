//! Port of 0.1.0's `code-review-gitlab-client.test.ts` (37 cases), plus the exact request
//! URLs and headers and the zod tolerances of the Rust parser. A fake [`Transport`] only: no
//! network.

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use chrono::{DateTime, FixedOffset, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::{json, Value};
use url::Url;

use super::*;
use crate::code_review::client::{ClientItem, OwnReview};
use crate::code_review::http::{HttpRequest, HttpResponse, Method, TransportError};
use crate::contract::code_review::{Checks, ContributionTotals, ReviewItem, ReviewState};
use crate::contract::Validate;
use crate::ipc::BoxFuture;

const BASE: &str = "https://gitlab.x.com/base";
const TOKEN: &str = "glpat-test-token";

type Reply = Result<HttpResponse, TransportError>;
type Respond = dyn Fn(&Url) -> Reply + Send + Sync;
/// A canned answer of the fake server.
type MakeReply = fn() -> Reply;

/// Answers with `respond(url)` and records every request.
struct Fake {
    respond: Box<Respond>,
    requests: Mutex<Vec<HttpRequest>>,
}

impl Transport for Fake {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Reply> {
        let url = Url::parse(&request.url).expect("an absolute URL");
        let result = (self.respond)(&url);
        self.requests.lock().unwrap().push(request);
        Box::pin(async move { result })
    }
}

fn json_status(body: &Value, status: u16) -> Reply {
    Ok(HttpResponse::new(status).with_body(serde_json::to_vec(body).unwrap()))
}

fn json_ok(body: &Value) -> Reply {
    json_status(body, 200)
}

fn json_headers(body: &Value, headers: &[(&str, &str)]) -> Reply {
    let mut response = HttpResponse::new(200).with_body(serde_json::to_vec(body).unwrap());
    for (name, value) in headers {
        response = response.with_header(name, *value);
    }
    Ok(response)
}

fn not_found() -> Reply {
    json_status(&json!({ "message": "not found" }), 404)
}

fn redirect(status: u16) -> Reply {
    Ok(HttpResponse::new(status).with_header("location", "https://evil.example/steal"))
}

fn param(url: &Url, name: &str) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

fn params(url: &Url) -> Vec<(String, String)> {
    url.query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect()
}

fn pairs(expected: &[(&str, &str)]) -> Vec<(String, String)> {
    expected
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect()
}

struct Setup {
    client: GitlabClient,
    fake: Arc<Fake>,
}

impl Setup {
    fn requests(&self) -> Vec<HttpRequest> {
        self.fake.requests.lock().unwrap().clone()
    }

    fn urls(&self) -> Vec<Url> {
        self.requests()
            .iter()
            .map(|request| Url::parse(&request.url).unwrap())
            .collect()
    }

    fn calls(&self) -> usize {
        self.fake.requests.lock().unwrap().len()
    }

    fn calls_containing(&self, part: &str) -> usize {
        self.requests()
            .iter()
            .filter(|request| request.url.contains(part))
            .count()
    }

    fn event_calls(&self) -> Vec<Url> {
        self.urls()
            .into_iter()
            .filter(|url| url.path() == EVENTS)
            .collect()
    }

    /// Every request: under the API root, a GET, with the token and no `authorization`.
    fn assert_token_on_every_request(&self) {
        for request in self.requests() {
            assert!(request.url.starts_with(&format!("{BASE}/api/v4/")));
            assert_eq!(request.method, Method::Get);
            assert_eq!(request.header_value("private-token"), Some(TOKEN));
            assert_eq!(request.header_value("authorization"), None);
        }
    }
}

fn with_fake(respond: impl Fn(&Url) -> Reply + Send + Sync + 'static) -> Setup {
    let fake = Arc::new(Fake {
        respond: Box::new(respond),
        requests: Mutex::new(Vec::new()),
    });
    let client = GitlabClient::new(fake.clone(), BASE, TOKEN).expect("a valid base URL");
    Setup { client, fake }
}

type Status = dyn Fn(&Url) -> Option<Reply> + Send + Sync;

/// The TS `Server`: the user, both lists, approvals and `/reviewers` answers by
/// `"{project}/{iid}"`, and a `status` override.
#[derive(Default)]
struct Server {
    user: Option<Value>,
    to_review: Option<Value>,
    mine: Option<Value>,
    approvals: Vec<(&'static str, Value)>,
    reviewers: Vec<(&'static str, Value)>,
    status: Option<Box<Status>>,
}

impl Server {
    fn status(mut self, status: impl Fn(&Url) -> Option<Reply> + Send + Sync + 'static) -> Self {
        self.status = Some(Box::new(status));
        self
    }

    fn respond(&self, url: &Url) -> Reply {
        if let Some(reply) = self.status.as_ref().and_then(|status| status(url)) {
            return reply;
        }
        let path = url.path();
        if path == "/base/api/v4/user" {
            return json_ok(
                self.user
                    .as_ref()
                    .unwrap_or(&json!({ "id": 42, "username": "me" })),
            );
        }
        if path == "/base/api/v4/merge_requests" {
            let list = if param(url, "scope").as_deref() == Some("created_by_me") {
                &self.mine
            } else {
                &self.to_review
            };
            return json_ok(list.as_ref().unwrap_or(&json!([])));
        }
        if let Some(rest) = path.strip_prefix("/base/api/v4/projects/") {
            let parts: Vec<&str> = rest.split('/').collect();
            if let [project, "merge_requests", iid, kind] = parts[..] {
                let key = format!("{project}/{iid}");
                let find = |entries: &[(&str, Value)]| {
                    entries
                        .iter()
                        .find(|(k, _)| *k == key)
                        .map_or_else(|| json!([]), |(_, v)| v.clone())
                };
                if kind == "approvals" {
                    return json_ok(&json!({
                        "id": 1,
                        "iid": iid.parse::<u64>().unwrap(),
                        "approved": true,
                        "approvals_required": 0,
                        "approved_by": find(&self.approvals),
                    }));
                }
                if kind == "reviewers" {
                    return json_ok(&find(&self.reviewers));
                }
            }
        }
        not_found()
    }
}

fn setup(server: Server) -> Setup {
    with_fake(move |url| server.respond(url))
}

fn expect_code<T: std::fmt::Debug>(result: Result<T, CodeReviewError>, code: CodeReviewError) {
    let error = result.expect_err("a failure");
    assert_eq!(error, code);
    // Never carries the token.
    assert!(!error.to_string().contains(TOKEN));
    assert!(!format!("{error:?}").contains(TOKEN));
}

#[derive(Default)]
struct MrOptions {
    project_id: Option<u64>,
    iid: Option<u64>,
    draft: Option<bool>,
    work_in_progress: Option<bool>,
    has_conflicts: Option<bool>,
    detailed_merge_status: Option<&'static str>,
    /// `Some(None)` for `head_pipeline: null`.
    pipeline: Option<Option<&'static str>>,
    no_references: bool,
}

fn mr(o: MrOptions) -> Value {
    let project_id = o.project_id.unwrap_or(10);
    let iid = o.iid.unwrap_or(1);
    let mut out = json!({
        "id": project_id * 1000 + iid,
        "iid": iid,
        "project_id": project_id,
        "title": "Improve thing",
        "web_url": format!("https://gitlab.x.com/base/group/project/-/merge_requests/{iid}"),
        "author": { "id": 7, "username": "alice", "name": "Alice" },
        "updated_at": "2026-11-12T10:00:00Z",
        "has_conflicts": o.has_conflicts.unwrap_or(false),
    });
    if !o.no_references {
        out["references"] =
            json!({ "short": format!("!{iid}"), "full": format!("group/project!{iid}") });
    }
    if let Some(draft) = o.draft {
        out["draft"] = json!(draft);
    }
    if let Some(wip) = o.work_in_progress {
        out["work_in_progress"] = json!(wip);
    }
    if let Some(status) = o.detailed_merge_status {
        out["detailed_merge_status"] = json!(status);
    }
    // The list endpoint carries reviewers as plain users (no review state).
    out["reviewers"] = json!([{ "id": 9, "username": "bob", "name": "Bob", "state": "active" }]);
    if let Some(pipeline) = o.pipeline {
        out["head_pipeline"] =
            pipeline.map_or(Value::Null, |status| json!({ "id": 1, "status": status }));
    }
    out
}

fn mr_iid(iid: u64) -> Value {
    mr(MrOptions {
        iid: Some(iid),
        ..MrOptions::default()
    })
}

fn user(id: u64, username: &str) -> Value {
    json!({
        "id": id,
        "username": username,
        "name": username,
        "state": "active",
        "avatar_url": null,
        "web_url": format!("https://gitlab.x.com/{username}"),
    })
}

fn approver() -> Value {
    json!({ "user": user(9, "bob") })
}

fn reviewer(state: &str) -> Value {
    reviewer_by(state, 9, "bob")
}

fn reviewer_by(state: &str, id: u64, username: &str) -> Value {
    json!({ "user": user(id, username), "state": state, "created_at": "2026-11-12T09:00:00Z" })
}

fn reviews(items: &[ClientItem]) -> Vec<ReviewState> {
    items.iter().map(|client| client.item.review).collect()
}

fn own(id: &str, review: ReviewState) -> OwnReview {
    OwnReview {
        id: id.into(),
        review,
    }
}

// --- gitlab client: requests ---------------------------------------------------------------

#[tokio::test]
async fn viewer_returns_the_username_using_private_token_and_never_following_redirects() {
    let s = setup(Server::default());
    assert_eq!(s.client.viewer().await.unwrap(), "me");
    let request = &s.requests()[0];
    assert_eq!(request.url, format!("{BASE}/api/v4/user"));
    assert_eq!(request.header_value("private-token"), Some(TOKEN));
    // `redirect: 'manual'` lives in the transport (`ReqwestTransport`, no redirect policy); the
    // client refuses any 3xx (see `never_follows_a_redirect`).
}

#[tokio::test]
async fn asks_for_the_user_both_lists_and_the_approvals_and_reviewers_of_each_own_mr() {
    let s = setup(Server {
        to_review: Some(json!([mr_iid(5)])),
        mine: Some(json!([
            mr_iid(1),
            mr(MrOptions {
                project_id: Some(11),
                iid: Some(2),
                ..MrOptions::default()
            })
        ])),
        ..Server::default()
    });
    s.client.list().await.unwrap();
    let urls = s.urls();
    let lists: Vec<&Url> = urls
        .iter()
        .filter(|url| url.path() == "/base/api/v4/merge_requests")
        .collect();
    assert_eq!(lists.len(), 2);
    let to_review = lists
        .iter()
        .find(|url| param(url, "scope").as_deref() == Some("all"))
        .unwrap();
    assert_eq!(
        params(to_review),
        pairs(&[
            ("state", "opened"),
            ("reviewer_id", "42"),
            ("scope", "all"),
            ("per_page", "20")
        ])
    );
    let mine = lists
        .iter()
        .find(|url| param(url, "scope").as_deref() == Some("created_by_me"))
        .unwrap();
    assert_eq!(
        params(mine),
        pairs(&[
            ("state", "opened"),
            ("scope", "created_by_me"),
            ("per_page", "20")
        ])
    );
    let paths: HashSet<&str> = urls.iter().map(Url::path).collect();
    for path in [
        "/base/api/v4/user",
        "/base/api/v4/projects/10/merge_requests/1/approvals",
        "/base/api/v4/projects/10/merge_requests/1/reviewers",
        "/base/api/v4/projects/11/merge_requests/2/approvals",
        "/base/api/v4/projects/11/merge_requests/2/reviewers",
    ] {
        assert!(paths.contains(path), "{path}");
    }
    assert_eq!(s.calls(), 7);
    s.assert_token_on_every_request();
}

#[tokio::test]
async fn never_follows_a_redirect_any_3xx_is_invalid_response_with_one_request() {
    let s = setup(Server::default().status(|_| Some(redirect(302))));
    expect_code(s.client.viewer().await, CodeReviewError::InvalidResponse);
    assert_eq!(s.calls(), 1);
    // An opaque redirect (status 0 in Electron).
    let s = setup(Server::default().status(|_| Some(Ok(HttpResponse::new(0)))));
    expect_code(s.client.list().await, CodeReviewError::InvalidResponse);
}

// --- gitlab client: mapping ----------------------------------------------------------------

#[tokio::test]
async fn maps_an_mr_to_an_item() {
    let s = setup(Server {
        to_review: Some(json!([mr(MrOptions {
            iid: Some(5),
            pipeline: Some(Some("success")),
            has_conflicts: Some(true),
            ..MrOptions::default()
        })])),
        ..Server::default()
    });
    let result = s.client.list().await.unwrap();
    assert_eq!(
        result.to_review,
        vec![ClientItem {
            item: ReviewItem {
                id: "10!5".into(),
                reference: "group/project!5".into(),
                title: "Improve thing".into(),
                author: "alice".into(),
                updated_at: "2026-11-12T10:00:00Z".into(),
                draft: false,
                review: ReviewState::None,
                checks: Some(Checks::Pass),
                conflicts: true,
            },
            url: "https://gitlab.x.com/base/group/project/-/merge_requests/5".into(),
        }]
    );
}

#[tokio::test]
async fn tolerates_missing_optional_fields() {
    let minimal = json!({
        "id": 1,
        "iid": 3,
        "project_id": 4,
        "title": "t",
        "web_url": "https://gitlab.x.com/base/g/p/-/merge_requests/3",
        "updated_at": "2026-11-12T10:00:00Z",
    });
    let mut mine = minimal.clone();
    mine["author"] = Value::Null;
    let s = setup(Server {
        to_review: Some(json!([minimal])),
        mine: Some(json!([mine])),
        ..Server::default()
    });
    let result = s.client.list().await.unwrap();
    let item = &result.to_review[0].item;
    assert_eq!(item.id, "4!3");
    assert_eq!(item.reference, "!3");
    assert_eq!(item.author, "");
    assert!(!item.draft);
    assert_eq!(item.checks, None);
    assert!(!item.conflicts);
    assert_eq!(item.review, ReviewState::None);
    assert_eq!(result.mine[0].item.author, "");
}

#[tokio::test]
async fn reads_drafts_from_draft_or_work_in_progress_and_conflicts_from_the_detailed_status() {
    let s = setup(Server {
        to_review: Some(json!([
            mr(MrOptions {
                iid: Some(1),
                draft: Some(true),
                ..MrOptions::default()
            }),
            mr(MrOptions {
                iid: Some(2),
                work_in_progress: Some(true),
                ..MrOptions::default()
            }),
            mr(MrOptions {
                iid: Some(3),
                detailed_merge_status: Some("conflict"),
                ..MrOptions::default()
            }),
        ])),
        ..Server::default()
    });
    let result = s.client.list().await.unwrap();
    assert!(result.to_review[0].item.draft);
    assert!(result.to_review[1].item.draft);
    assert!(result.to_review[2].item.conflicts);
}

#[tokio::test]
async fn maps_the_pipeline_status_to_checks() {
    let cases = [
        (Some("success"), Some(Checks::Pass)),
        (Some("failed"), Some(Checks::Fail)),
        (Some("running"), Some(Checks::Running)),
        (Some("pending"), Some(Checks::Running)),
        (Some("created"), Some(Checks::Running)),
        (Some("canceled"), None),
        (Some("skipped"), None),
        (None, None),
    ];
    for (pipeline, checks) in cases {
        let s = setup(Server {
            to_review: Some(json!([mr(MrOptions {
                pipeline: Some(pipeline),
                ..MrOptions::default()
            })])),
            ..Server::default()
        });
        assert_eq!(
            s.client.list().await.unwrap().to_review[0].item.checks,
            checks,
            "{pipeline:?}"
        );
    }
    // The other running states, and no pipeline at all.
    for status in [
        "waiting_for_resource",
        "preparing",
        "scheduled",
        "waiting_for_callback",
    ] {
        let s = setup(Server {
            to_review: Some(json!([mr(MrOptions {
                pipeline: Some(Some(status)),
                ..MrOptions::default()
            })])),
            ..Server::default()
        });
        let checks = s.client.list().await.unwrap().to_review[0].item.checks;
        assert_eq!(checks, Some(Checks::Running), "{status}");
    }
}

#[tokio::test]
async fn takes_the_review_from_approvals_alone_when_nobody_has_a_reviewer_state() {
    let s = setup(Server {
        mine: Some(json!([mr_iid(1), mr_iid(2)])),
        approvals: vec![("10/1", json!([approver()]))],
        reviewers: vec![("10/2", json!([reviewer("unreviewed")]))],
        ..Server::default()
    });
    let result = s.client.list().await.unwrap();
    assert_eq!(
        reviews(&result.mine),
        [ReviewState::Approved, ReviewState::None]
    );
    assert_eq!(result.unreviewed, 1);
}

#[tokio::test]
async fn ignores_the_plain_reviewer_users_of_the_list_payload() {
    let s = setup(Server {
        mine: Some(json!([mr_iid(1)])),
        ..Server::default()
    });
    assert_eq!(
        s.client.list().await.unwrap().mine[0].item.review,
        ReviewState::None
    );
}

#[tokio::test]
async fn combines_the_reviewers_states_with_approvals_approved_wins() {
    let s = setup(Server {
        mine: Some(json!((1..=6).map(mr_iid).collect::<Vec<_>>())),
        reviewers: vec![
            ("10/1", json!([reviewer("reviewed")])),
            ("10/2", json!([reviewer("requested_changes")])),
            ("10/3", json!([reviewer("requested_changes")])),
            (
                "10/4",
                json!([
                    reviewer("unreviewed"),
                    reviewer_by("review_started", 8, "eve")
                ]),
            ),
            (
                "10/5",
                json!([
                    reviewer("reviewed"),
                    reviewer_by("requested_changes", 8, "eve")
                ]),
            ),
            ("10/6", json!([reviewer("approved")])),
        ],
        approvals: vec![("10/3", json!([approver()]))],
        ..Server::default()
    });
    let result = s.client.list().await.unwrap();
    use ReviewState::*;
    assert_eq!(
        reviews(&result.mine),
        [Commented, Changes, Approved, None, Changes, Approved]
    );
    assert_eq!(result.unreviewed, 1);
}

#[tokio::test]
async fn ignores_the_users_own_approval_and_review_of_their_mr() {
    let s = setup(Server {
        mine: Some(json!([mr_iid(1)])),
        approvals: vec![("10/1", json!([{ "user": user(42, "me") }]))],
        reviewers: vec![("10/1", json!([reviewer_by("reviewed", 42, "me")]))],
        ..Server::default()
    });
    let result = s.client.list().await.unwrap();
    assert_eq!(result.mine[0].item.review, ReviewState::None);
    assert_eq!(result.unreviewed, 1);
}

#[tokio::test]
async fn makes_no_per_mr_calls_for_the_mrs_to_review_nor_for_own_drafts() {
    let s = setup(Server {
        to_review: Some(json!([mr_iid(1)])),
        mine: Some(json!([mr(MrOptions {
            iid: Some(2),
            draft: Some(true),
            ..MrOptions::default()
        })])),
        ..Server::default()
    });
    let result = s.client.list().await.unwrap();
    assert_eq!(result.to_review[0].item.review, ReviewState::None);
    assert_eq!(result.mine[0].item.review, ReviewState::None);
    assert_eq!(s.calls(), 3);
}

#[tokio::test]
async fn counts_own_open_non_draft_mrs_without_reviews_and_reports_their_review_state() {
    let s = setup(Server {
        mine: Some(json!([
            mr_iid(1),
            mr(MrOptions {
                iid: Some(2),
                draft: Some(true),
                ..MrOptions::default()
            }),
            mr_iid(3)
        ])),
        approvals: vec![("10/3", json!([approver()]))],
        ..Server::default()
    });
    let result = s.client.list().await.unwrap();
    assert_eq!(result.unreviewed, 1);
    assert_eq!(
        result.own_review,
        vec![
            own("10!1", ReviewState::None),
            own("10!3", ReviewState::Approved)
        ]
    );
}

#[tokio::test]
async fn keeps_at_most_20_items_per_list_and_asks_approvals_and_reviewers_only_for_those() {
    let many = json!((1..=25).map(mr_iid).collect::<Vec<_>>());
    let s = setup(Server {
        to_review: Some(many.clone()),
        mine: Some(many),
        ..Server::default()
    });
    let result = s.client.list().await.unwrap();
    assert_eq!(result.to_review.len(), 20);
    assert_eq!(result.mine.len(), 20);
    assert_eq!(result.unreviewed, 20);
    assert_eq!(s.calls_containing("/approvals"), 20);
    assert_eq!(s.calls_containing("/reviewers"), 20);
}

#[tokio::test]
async fn treats_missing_approvals_or_reviewers_endpoints_404_as_no_review() {
    let s = setup(
        Server {
            mine: Some(json!([mr_iid(1)])),
            ..Server::default()
        }
        .status(|url| {
            let path = url.path();
            (path.ends_with("/approvals") || path.ends_with("/reviewers"))
                .then(|| json_status(&json!({ "message": "404 Not found" }), 404))
        }),
    );
    let result = s.client.list().await.unwrap();
    assert_eq!(result.mine[0].item.review, ReviewState::None);
    // A lasting "no data" is not uncertain: the MR is still observed.
    assert_eq!(result.own_review, vec![own("10!1", ReviewState::None)]);
}

// --- gitlab client: errors -----------------------------------------------------------------

#[tokio::test]
async fn maps_http_statuses_to_codes() {
    // `Server` is the fake here, so the codes are spelled in full.
    for (status, code) in [
        (401, CodeReviewError::Auth),
        (403, CodeReviewError::Auth),
        (429, CodeReviewError::RateLimited),
        (500, CodeReviewError::Server),
        (503, CodeReviewError::Server),
        (404, CodeReviewError::InvalidResponse),
    ] {
        let s = setup(
            Server::default()
                .status(move |_| Some(json_status(&json!({ "message": "x" }), status))),
        );
        expect_code(s.client.list().await, code);
    }
}

#[tokio::test]
async fn fails_the_whole_fetch_when_a_list_call_fails_or_a_per_mr_call_says_401() {
    let s = setup(Server::default().status(|url| {
        (param(url, "scope").as_deref() == Some("all")).then(|| json_status(&json!({}), 500))
    }));
    expect_code(s.client.list().await, CodeReviewError::Server);
    for suffix in ["/approvals", "/reviewers"] {
        let s = setup(
            Server {
                mine: Some(json!([mr(MrOptions::default())])),
                ..Server::default()
            }
            .status(move |url| {
                url.path()
                    .ends_with(suffix)
                    .then(|| json_status(&json!({}), 401))
            }),
        );
        expect_code(s.client.list().await, CodeReviewError::Auth);
    }
    let s = setup(
        Server {
            mine: Some(json!([mr(MrOptions::default())])),
            ..Server::default()
        }
        .status(|url| {
            (param(url, "scope").as_deref() == Some("created_by_me"))
                .then(|| json_status(&json!({}), 403))
        }),
    );
    expect_code(s.client.list().await, CodeReviewError::Auth);
}

#[tokio::test]
async fn gives_invalid_response_for_a_malformed_body_or_schema() {
    let s = setup(
        Server::default()
            .status(|_| Some(Ok(HttpResponse::new(200).with_body(b"<html>".to_vec())))),
    );
    expect_code(s.client.viewer().await, CodeReviewError::InvalidResponse);
    let s = setup(Server {
        user: Some(json!({ "id": "x", "username": "me" })),
        ..Server::default()
    });
    expect_code(s.client.viewer().await, CodeReviewError::InvalidResponse);
    let mut bad = mr(MrOptions::default());
    bad["iid"] = json!("one");
    let s = setup(Server {
        to_review: Some(json!([bad])),
        ..Server::default()
    });
    expect_code(s.client.list().await, CodeReviewError::InvalidResponse);
    let s = setup(Server {
        mine: Some(json!({ "not": "a list" })),
        ..Server::default()
    });
    expect_code(s.client.list().await, CodeReviewError::InvalidResponse);
}

#[tokio::test]
async fn gives_network_when_fetch_rejects() {
    let s = with_fake(|_| Err(TransportError::Network));
    expect_code(s.client.list().await, CodeReviewError::Network);
}

// --- gitlab client: base URL ---------------------------------------------------------------

fn idle() -> Arc<dyn Transport> {
    Arc::new(Fake {
        respond: Box::new(|_| not_found()),
        requests: Mutex::new(Vec::new()),
    })
}

#[test]
fn refuses_a_base_url_that_is_not_normalized_https() {
    for base in [
        "http://gitlab.x.com",
        "https://gitlab.x.com/",
        "https://u@gitlab.x.com",
        "https://gitlab.x.com?a=1",
        "nope",
        "",
    ] {
        assert_eq!(
            GitlabClient::new(idle(), base, TOKEN).err(),
            Some(InvalidGitlabUrl),
            "{base}"
        );
    }
    assert!(GitlabClient::new(idle(), "https://gitlab.x.com/base", TOKEN).is_ok());
}

#[test]
fn accepts_a_loopback_http_server_only_when_explicitly_allowed() {
    assert!(GitlabClient::new(idle(), "http://127.0.0.1:4100", TOKEN).is_err());
    assert!(
        GitlabClient::new_allowing_loopback_http(idle(), "http://127.0.0.1:4100", TOKEN).is_ok()
    );
    assert!(
        GitlabClient::new_allowing_loopback_http(idle(), "http://evil.example:80", TOKEN).is_err()
    );
}

// --- gitlab client: per-MR failures degrade ------------------------------------------------

fn two() -> Server {
    Server {
        mine: Some(json!([mr_iid(1), mr_iid(2)])),
        approvals: vec![("10/1", json!([approver()]))],
        reviewers: vec![("10/2", json!([reviewer("requested_changes")]))],
        ..Server::default()
    }
}

fn failing(suffix: &'static str, reply: MakeReply) -> impl Fn(&Url) -> Option<Reply> {
    move |url| url.path().ends_with(suffix).then(reply)
}

fn forbidden() -> Reply {
    json_status(&json!({ "message": "403 Forbidden" }), 403)
}

#[tokio::test]
async fn a_403_on_reviewers_means_no_reviewer_data_approvals_only_still_observed() {
    let s = setup(two().status(failing("/reviewers", forbidden)));
    let result = s.client.list().await.unwrap();
    assert_eq!(
        reviews(&result.mine),
        [ReviewState::Approved, ReviewState::None]
    );
    assert_eq!(
        result.own_review,
        vec![
            own("10!1", ReviewState::Approved),
            own("10!2", ReviewState::None)
        ]
    );
}

#[tokio::test]
async fn a_403_on_approvals_means_no_approvals_reviewer_states_only_still_observed() {
    let s = setup(two().status(failing("/approvals", forbidden)));
    let result = s.client.list().await.unwrap();
    assert_eq!(
        reviews(&result.mine),
        [ReviewState::None, ReviewState::Changes]
    );
    assert_eq!(result.own_review.len(), 2);
}

#[tokio::test]
async fn a_passing_reviewers_failure_degrades_to_approvals_and_leaves_the_mrs_out_of_own_review() {
    let cases: [(&str, MakeReply); 4] = [
        ("500", || json_status(&json!({}), 500)),
        ("429", || json_status(&json!({}), 429)),
        ("malformed", || json_ok(&json!({ "not": "a list" }))),
        ("network", || Err(TransportError::Network)),
    ];
    for (name, reply) in cases {
        let s = setup(two().status(failing("/reviewers", reply)));
        let result = s.client.list().await.unwrap();
        assert_eq!(
            reviews(&result.mine),
            [ReviewState::Approved, ReviewState::None],
            "{name}"
        );
        assert_eq!(result.unreviewed, 1, "{name}");
        assert_eq!(result.own_review, vec![], "{name}");
    }
}

#[tokio::test]
async fn a_passing_approvals_failure_degrades_to_reviewer_states_and_leaves_the_mrs_out() {
    let s = setup(two().status(failing("/approvals", || json_status(&json!({}), 503))));
    let result = s.client.list().await.unwrap();
    assert_eq!(
        reviews(&result.mine),
        [ReviewState::None, ReviewState::Changes]
    );
    assert_eq!(result.own_review, vec![]);
}

#[tokio::test]
async fn only_the_mr_whose_call_failed_is_left_out() {
    let s = setup(two().status(|url| {
        (url.path() == "/base/api/v4/projects/10/merge_requests/2/reviewers")
            .then(|| json_status(&json!({}), 500))
    }));
    let result = s.client.list().await.unwrap();
    assert_eq!(result.own_review, vec![own("10!1", ReviewState::Approved)]);
}

// --- gitlab client: per-MR concurrency -----------------------------------------------------

/// Per-MR calls take a few polls each; the peak of calls in flight is recorded, overall and per
/// endpoint.
#[derive(Default)]
struct Slow {
    calls: AtomicUsize,
    in_flight: [AtomicUsize; 3],
    peak: [AtomicUsize; 3],
}

impl Transport for Slow {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Reply> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let url = Url::parse(&request.url).unwrap();
        let path = url.path().to_owned();
        Box::pin(async move {
            if path.ends_with("/user") {
                return json_ok(&json!({ "id": 42, "username": "me" }));
            }
            if path.ends_with("/merge_requests") {
                let mine = param(&url, "scope").as_deref() == Some("created_by_me");
                let list: Vec<Value> = if mine {
                    (1..=20).map(mr_iid).collect()
                } else {
                    Vec::new()
                };
                return json_ok(&json!(list));
            }
            let lane = if path.ends_with("/approvals") { 1 } else { 2 };
            for slot in [0, lane] {
                let now = self.in_flight[slot].fetch_add(1, Ordering::SeqCst) + 1;
                self.peak[slot].fetch_max(now, Ordering::SeqCst);
            }
            for _ in 0..5 {
                tokio::task::yield_now().await;
            }
            for slot in [0, lane] {
                self.in_flight[slot].fetch_sub(1, Ordering::SeqCst);
            }
            if lane == 1 {
                json_ok(&json!({ "approved_by": [] }))
            } else {
                json_ok(&json!([]))
            }
        })
    }
}

#[tokio::test]
async fn keeps_at_most_6_per_mr_requests_in_flight() {
    let slow = Arc::new(Slow::default());
    let client = GitlabClient::new(slow.clone(), BASE, TOKEN).unwrap();
    let result = client.list().await.unwrap();
    assert_eq!(result.unreviewed, 20);
    assert_eq!(slow.calls.load(Ordering::SeqCst), 43);
    let peak = slow.peak[0].load(Ordering::SeqCst);
    assert!(peak <= GITLAB_PER_MR_CONCURRENCY, "{peak}");
    assert!(peak > 1, "{peak}");
    // Rust-only: 3 + 3, one pool per endpoint, both at once.
    assert_eq!(slow.peak[1].load(Ordering::SeqCst), 3);
    assert_eq!(slow.peak[2].load(Ordering::SeqCst), 3);
    assert_eq!(peak, 6);
}

// --- gitlab client: contributions ----------------------------------------------------------

const MADRID: Tz = chrono_tz::Europe::Madrid;
const NEW_YORK: Tz = chrono_tz::America::New_York;
const EVENTS: &str = "/base/api/v4/users/42/events";

fn local(tz: Tz, y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<FixedOffset> {
    tz.with_ymd_and_hms(y, m, d, h, min, 0)
        .unwrap()
        .fixed_offset()
}

/// The range the contributions helpers derive from `now` in `tz`; `week` is the (month, day)
/// the week must start on (a check of the derivation).
fn range(tz: Tz, now: (i32, u32, u32, u32, u32), week: (u32, u32)) -> ContributionRange<Tz> {
    let (y, m, d, h, min) = now;
    let (week_month, monday) = week;
    let range = ContributionRange::at(&tz.with_ymd_and_hms(y, m, d, h, min, 0).unwrap());
    assert_eq!(range.now(), local(tz, y, m, d, h, min).with_timezone(&Utc));
    assert_eq!(range.month(), local(tz, y, m, 1, 0, 0));
    assert_eq!(range.week(), local(tz, y, week_month, monday, 0, 0));
    assert_eq!(range.today(), local(tz, y, m, d, 0, 0));
    assert_eq!(*range.zone(), tz);
    range
}

/// Friday 13 Nov 2026, 10:30 in Europe/Madrid (CET = UTC+1).
fn now_range() -> ContributionRange<Tz> {
    range(MADRID, (2026, 11, 13, 10, 30), (11, 9))
}

fn event(created_at: &str, action_name: &str, extra: Value) -> Value {
    let mut out = json!({
        "id": 1,
        "project_id": 10,
        "action_name": action_name,
        "target_type": null,
        "target_title": "Secret title",
        "author": { "id": 42, "username": "me" },
        "created_at": created_at,
    });
    for (key, value) in extra.as_object().unwrap() {
        out[key] = value.clone();
    }
    out
}

fn month_events() -> Vec<Value> {
    vec![
        // Local 14 Nov: future, ignored.
        event(
            "2026-11-13T23:30:00Z",
            "pushed to",
            json!({ "push_data": { "commit_count": 9, "ref": "main" } }),
        ),
        // Local 13 Nov.
        event(
            "2026-11-12T23:30:00Z",
            "pushed to",
            json!({ "push_data": { "commit_count": 3, "ref": "main" } }),
        ),
        event(
            "2026-11-13T08:00:00Z",
            "approved",
            json!({ "target_type": "MergeRequest" }),
        ),
        event(
            "2026-11-10T09:00:00Z",
            "opened",
            json!({ "target_type": "MergeRequest" }),
        ),
        event("2026-11-05T10:00:00Z", "joined", json!({})),
        event(
            "2026-11-02T09:00:00Z",
            "accepted",
            json!({ "target_type": "MergeRequest" }),
        ),
        event(
            "2026-11-02T10:00:00Z",
            "commented on",
            json!({ "target_type": "Note", "note": { "noteable_type": "Issue", "body": "x" } }),
        ),
        // Local 1 Nov 00:30.
        event(
            "2026-10-31T23:30:00Z",
            "commented on",
            json!({ "target_type": "DiffNote", "note": { "noteable_type": "MergeRequest" } }),
        ),
        // Local 31 Oct 23:30: outside.
        event(
            "2026-10-31T22:30:00Z",
            "pushed to",
            json!({ "push_data": { "commit_count": 5 } }),
        ),
        event(
            "not a date",
            "pushed to",
            json!({ "push_data": { "commit_count": 5 } }),
        ),
    ]
}

/// GitLab's EventsFinder in a UTC server: `created_at > after.end_of_day` and
/// `< before.beginning_of_day`.
fn served(url: &Url, events: &[Value]) -> Value {
    let day =
        |name: &str| NaiveDate::parse_from_str(&param(url, name).unwrap(), "%Y-%m-%d").unwrap();
    let after = day("after")
        .and_hms_milli_opt(23, 59, 59, 999)
        .unwrap()
        .and_utc();
    let before = day("before").and_hms_opt(0, 0, 0).unwrap().and_utc();
    let kept: Vec<Value> = events
        .iter()
        .filter(
            |e| match DateTime::parse_from_rfc3339(e["created_at"].as_str().unwrap()) {
                Ok(t) => t > after && t < before,
                Err(_) => true,
            },
        )
        .cloned()
        .collect();
    json!(kept)
}

fn paged_setup(pages: impl Fn(u32, &Url) -> Reply + Send + Sync + 'static) -> Setup {
    with_fake(move |url| {
        if url.path() == "/base/api/v4/user" {
            return json_ok(&json!({ "id": 42, "username": "me" }));
        }
        if url.path() == EVENTS {
            let page = param(url, "page").unwrap().parse().unwrap();
            return pages(page, url);
        }
        not_found()
    })
}

fn fill(n: usize) -> Value {
    json!((0..n)
        .map(|_| event(
            "2026-11-03T10:00:00Z",
            "pushed to",
            json!({ "push_data": { "commit_count": 1 } })
        ))
        .collect::<Vec<_>>())
}

fn totals(commits: u64, opened: u64, merged: u64, reviews: u64) -> ContributionTotals {
    ContributionTotals {
        commits,
        opened,
        merged,
        reviews,
    }
}

fn count_of(c: &GitlabContributions, date: &str) -> u64 {
    c.counts.get(date).copied().unwrap_or(0)
}

/// What `summarize` derives from the counts: the month total and the active days (in-month
/// keys only).
fn month_total_and_active_days(c: &GitlabContributions, month: &str) -> (u64, usize) {
    let in_month = c.counts.iter().filter(|(date, _)| date.starts_with(month));
    let total = in_month.clone().map(|(_, n)| n).sum();
    let active = in_month.filter(|(_, n)| **n > 0).count();
    (total, active)
}

#[tokio::test]
async fn contributions_ask_for_the_user_events_of_the_range_exclusive_dates_with_the_token() {
    let s = paged_setup(|_, url| json_ok(&served(url, &month_events())));
    s.client.contributions(&now_range()).await.unwrap();
    let calls = s.event_calls();
    assert_eq!(calls.len(), 1);
    assert_eq!(
        params(&calls[0]),
        pairs(&[
            ("after", "2026-10-30"),
            ("before", "2026-11-15"),
            ("per_page", "100"),
            ("page", "1")
        ])
    );
    s.assert_token_on_every_request();
}

#[tokio::test]
async fn contributions_reach_back_to_monday_when_the_week_starts_in_the_previous_month() {
    let s = paged_setup(|_, url| {
        json_ok(&served(
            url,
            &[event(
                "2026-11-30T10:00:00Z",
                "opened",
                json!({ "target_type": "MergeRequest" }),
            )],
        ))
    });
    // Wednesday 2 Dec 2026 09:00; the week starts on Monday 30 Nov.
    let c = s
        .client
        .contributions(&range(MADRID, (2026, 12, 2, 9, 0), (11, 30)))
        .await
        .unwrap();
    let call = &s.event_calls()[0];
    assert_eq!(param(call, "after").as_deref(), Some("2026-11-28"));
    assert_eq!(param(call, "before").as_deref(), Some("2026-12-04"));
    assert_eq!(c.week.opened, 1);
    assert_eq!(c.month_totals.opened, 0);
    assert_eq!(month_total_and_active_days(&c, "2026-12").0, 0);
}

#[tokio::test]
async fn contributions_classify_events_by_local_day_into_the_counts_and_the_totals() {
    let s = paged_setup(|_, url| json_ok(&served(url, &month_events())));
    let c = s.client.contributions(&now_range()).await.unwrap();
    assert_eq!(count_of(&c, "2026-11-13"), 2);
    assert_eq!(count_of(&c, "2026-11-10"), 1);
    assert_eq!(count_of(&c, "2026-11-05"), 0);
    assert_eq!(count_of(&c, "2026-11-02"), 2);
    assert_eq!(count_of(&c, "2026-11-01"), 1);
    assert_eq!(count_of(&c, "2026-11-14"), 0);
    assert_eq!(count_of(&c, "2026-10-31"), 0);
    assert_eq!(month_total_and_active_days(&c, "2026-11"), (6, 4));
    assert_eq!(c.today, totals(3, 0, 0, 1));
    assert_eq!(c.week, totals(3, 1, 0, 1));
    assert_eq!(c.month_totals, totals(3, 1, 1, 2));
    assert!(!c.partial);
    // Only in-month days are counted (summarize would ignore the rest anyway).
    assert!(c.counts.keys().all(|date| date.starts_with("2026-11")));
}

#[tokio::test]
async fn contributions_keep_local_edge_events_gitlab_filters_by_utc_dates_madrid_first_of_month() {
    // 2026-11-01 00:30 local = 2026-10-31T23:30Z: an `after` of the 31st would drop it.
    let s = paged_setup(|_, url| {
        json_ok(&served(
            url,
            &[event(
                "2026-10-31T23:30:00Z",
                "opened",
                json!({ "target_type": "MergeRequest" }),
            )],
        ))
    });
    let c = s.client.contributions(&now_range()).await.unwrap();
    assert_eq!(c.month_totals.opened, 1);
    assert_eq!(count_of(&c, "2026-11-01"), 1);
}

#[tokio::test]
async fn contributions_keep_local_edge_events_gitlab_filters_by_utc_dates_new_york_evening() {
    // 13 Nov 20:00 EST = 14 Nov 01:00Z.
    let r = range(NEW_YORK, (2026, 11, 13, 20, 0), (11, 9));
    assert_eq!(
        r.now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "2026-11-14T01:00:00.000Z"
    );
    // 13 Nov 19:30 EST = 14 Nov 00:30Z: a `before` of the 14th would drop it server-side.
    let s = paged_setup(|_, url| {
        json_ok(&served(
            url,
            &[event(
                "2026-11-14T00:30:00Z",
                "approved",
                json!({ "target_type": "MergeRequest" }),
            )],
        ))
    });
    let c = s.client.contributions(&r).await.unwrap();
    assert_eq!(c.today.reviews, 1);
    assert_eq!(count_of(&c, "2026-11-13"), 1);
}

#[tokio::test]
async fn contributions_page_in_series_until_a_page_has_fewer_than_100_events() {
    let s = paged_setup(|page, _| json_ok(&fill(if page < 3 { 100 } else { 5 })));
    let c = s.client.contributions(&now_range()).await.unwrap();
    let pages: Vec<String> = s
        .event_calls()
        .iter()
        .map(|url| param(url, "page").unwrap())
        .collect();
    assert_eq!(pages, ["1", "2", "3"]);
    assert_eq!(c.month_totals.commits, 205);
    assert!(!c.partial);
}

#[tokio::test]
async fn contributions_stop_on_an_empty_x_next_page_even_with_a_full_page() {
    let s = paged_setup(|page, _| {
        let next = if page == 2 {
            String::new()
        } else {
            (page + 1).to_string()
        };
        json_headers(&fill(100), &[("x-next-page", &next)])
    });
    let c = s.client.contributions(&now_range()).await.unwrap();
    assert_eq!(s.event_calls().len(), 2);
    assert!(!c.partial);
}

#[tokio::test]
async fn contributions_stop_after_10_pages_and_mark_the_data_partial() {
    let s = paged_setup(|_, _| json_ok(&fill(100)));
    let c = s.client.contributions(&now_range()).await.unwrap();
    assert_eq!(s.event_calls().len(), 10);
    assert!(c.partial);
    assert_eq!(c.month_totals.commits, 1000);
}

#[tokio::test]
async fn contributions_map_errors_of_the_events_request_to_codes_a_redirect_is_never_followed() {
    use CodeReviewError::*;
    let cases: [(MakeReply, CodeReviewError); 6] = [
        (|| json_status(&json!({}), 401), Auth),
        (|| json_status(&json!({}), 403), Auth),
        (|| json_status(&json!({}), 429), RateLimited),
        (|| json_status(&json!({}), 503), Server),
        (|| json_ok(&json!({ "not": "an array" })), InvalidResponse),
        (|| redirect(302), InvalidResponse),
    ];
    for (reply, code) in cases {
        let s = paged_setup(move |_, _| reply());
        expect_code(s.client.contributions(&now_range()).await, code);
        assert_eq!(s.event_calls().len(), 1);
    }
}

#[tokio::test]
async fn contributions_a_failure_on_a_later_page_fails_the_whole_query() {
    let s = paged_setup(|page, _| {
        if page == 1 {
            json_ok(&fill(100))
        } else {
            json_status(&json!({}), 500)
        }
    });
    expect_code(
        s.client.contributions(&now_range()).await,
        CodeReviewError::Server,
    );
}

// --- Rust-only -----------------------------------------------------------------------------

#[tokio::test]
async fn request_urls_keep_the_base_path_and_the_ts_parameter_order() {
    let s = setup(Server {
        mine: Some(json!([mr_iid(1)])),
        ..Server::default()
    });
    s.client.viewer().await.unwrap();
    s.client.list().await.unwrap();
    let mut urls: Vec<String> = s.requests().into_iter().map(|r| r.url).collect();
    assert_eq!(urls.remove(0), format!("{BASE}/api/v4/user"));
    assert_eq!(urls.remove(0), format!("{BASE}/api/v4/user"));
    urls.sort();
    assert_eq!(
        urls,
        [
            format!(
                "{BASE}/api/v4/merge_requests?state=opened&reviewer_id=42&scope=all&per_page=20"
            ),
            format!("{BASE}/api/v4/merge_requests?state=opened&scope=created_by_me&per_page=20"),
            format!("{BASE}/api/v4/projects/10/merge_requests/1/approvals"),
            format!("{BASE}/api/v4/projects/10/merge_requests/1/reviewers"),
        ]
    );
    let s = paged_setup(|_, _| json_ok(&json!([])));
    s.client.contributions(&now_range()).await.unwrap();
    assert_eq!(
        s.requests()[1].url,
        format!(
            "{BASE}/api/v4/users/42/events?after=2026-10-30&before=2026-11-15&per_page=100&page=1"
        )
    );
}

#[tokio::test]
async fn sends_exactly_the_gitlab_headers_and_never_shows_the_token() {
    let s = setup(Server::default());
    s.client.viewer().await.unwrap();
    let request = &s.requests()[0];
    assert_eq!(
        request.headers,
        vec![
            ("private-token".to_owned(), TOKEN.to_owned()),
            ("accept".to_owned(), "application/json".to_owned()),
        ]
    );
    assert_eq!(request.header_value("authorization"), None);
    assert!(!format!("{:?}", s.client).contains(TOKEN));
    assert!(!format!("{request:?}").contains(TOKEN));
    assert!(!format!("{InvalidGitlabUrl:?}").contains(TOKEN));
}

#[tokio::test]
async fn accepts_integral_floats_where_zod_int_does_and_rejects_the_rest() {
    let mut node = mr(MrOptions::default());
    node["iid"] = json!(12.0);
    node["project_id"] = json!(1e1);
    let s = setup(Server {
        user: Some(json!({ "id": 42.0, "username": "me" })),
        to_review: Some(json!([node])),
        ..Server::default()
    });
    let result = s.client.list().await.unwrap();
    assert_eq!(result.to_review[0].item.id, "10!12");
    assert!(s
        .requests()
        .iter()
        .any(|r| r.url.contains("reviewer_id=42&")));
    for bad in [
        json!(1.5),
        json!(0),
        json!(-1),
        json!(9_007_199_254_740_992_u64),
        json!("1"),
        Value::Null,
    ] {
        let mut node = mr(MrOptions::default());
        node["iid"] = bad.clone();
        let s = setup(Server {
            to_review: Some(json!([node])),
            ..Server::default()
        });
        expect_code(s.client.list().await, CodeReviewError::InvalidResponse);
    }
    // `commit_count`: `int().min(0)`; a negative count fails the page.
    let s = paged_setup(|_, _| {
        json_ok(&json!([event(
            "2026-11-03T10:00:00Z",
            "pushed to",
            json!({ "push_data": { "commit_count": -1 } })
        )]))
    });
    expect_code(
        s.client.contributions(&now_range()).await,
        CodeReviewError::InvalidResponse,
    );
    let s = paged_setup(|_, _| {
        json_ok(&json!([event(
            "2026-11-03T10:00:00Z",
            "pushed to",
            json!({ "push_data": { "commit_count": 2.0 } })
        )]))
    });
    let c = s.client.contributions(&now_range()).await.unwrap();
    assert_eq!(c.month_totals.commits, 2);
}

#[tokio::test]
async fn keeps_the_last_of_duplicate_keys_as_json_parse_does() {
    let s = with_fake(|_| {
        Ok(HttpResponse::new(200).with_body(br#"{"id":42,"username":1,"username":"me"}"#.to_vec()))
    });
    assert_eq!(s.client.viewer().await.unwrap(), "me");
}

#[tokio::test]
async fn zod_shape_rules_for_mrs_and_per_mr_answers() {
    // Nullable fields take `null`.
    let mut node = mr(MrOptions::default());
    for key in [
        "references",
        "author",
        "draft",
        "work_in_progress",
        "has_conflicts",
        "detailed_merge_status",
        "head_pipeline",
    ] {
        node[key] = Value::Null;
    }
    let s = setup(Server {
        to_review: Some(json!([node])),
        ..Server::default()
    });
    let item = s.client.list().await.unwrap().to_review[0].item.clone();
    assert_eq!((item.reference.as_str(), item.author.as_str()), ("!1", ""));
    // Required fields and nested shapes.
    for (key, value) in [
        ("title", Value::Null),
        ("web_url", json!(1)),
        ("updated_at", Value::Null),
        ("references", json!({ "short": "!1" })),
        ("author", json!({ "id": 1 })),
        ("draft", json!("yes")),
        ("head_pipeline", json!({ "id": 1 })),
    ] {
        let mut node = mr(MrOptions::default());
        node[key] = value;
        let s = setup(Server {
            to_review: Some(json!([node])),
            ..Server::default()
        });
        expect_code(s.client.list().await, CodeReviewError::InvalidResponse);
    }
    // The whole list is validated, also past the 20 kept.
    let mut many: Vec<Value> = (1..=21).map(mr_iid).collect();
    many[20]["iid"] = json!("x");
    let s = setup(Server {
        to_review: Some(json!(many)),
        ..Server::default()
    });
    expect_code(s.client.list().await, CodeReviewError::InvalidResponse);
    // Per-MR answers: a user id of `null` (optional, not nullable) or a non-object entry fails
    // the call (the MR is uncertain); a missing or `null` user counts as someone else.
    let cases: [(Value, Value, bool, ReviewState); 5] = [
        (
            json!([{ "user": { "id": null } }]),
            json!([]),
            false,
            ReviewState::None,
        ),
        (json!([1]), json!([]), false, ReviewState::None),
        (json!([{}]), json!([]), true, ReviewState::Approved),
        (
            json!([{ "user": null }]),
            json!([]),
            true,
            ReviewState::Approved,
        ),
        (
            json!([]),
            json!([{ "state": "reviewed" }]),
            true,
            ReviewState::Commented,
        ),
    ];
    for (approved_by, reviewer_answer, observed, review) in cases {
        let s = setup(Server {
            mine: Some(json!([mr_iid(1)])),
            approvals: vec![("10/1", approved_by.clone())],
            reviewers: vec![("10/1", reviewer_answer.clone())],
            ..Server::default()
        });
        let result = s.client.list().await.unwrap();
        assert_eq!(
            result.mine[0].item.review, review,
            "{approved_by} {reviewer_answer}"
        );
        assert_eq!(!result.own_review.is_empty(), observed, "{approved_by}");
    }
    // `approved_by: null` is no approvals; an approvals answer that is not an object fails.
    let s = setup(
        Server {
            mine: Some(json!([mr_iid(1)])),
            ..Server::default()
        }
        .status(|url| {
            url.path()
                .ends_with("/approvals")
                .then(|| json_ok(&json!({ "approved_by": null })))
        }),
    );
    assert_eq!(s.client.list().await.unwrap().own_review.len(), 1);
    let s = setup(
        Server {
            mine: Some(json!([mr_iid(1)])),
            ..Server::default()
        }
        .status(|url| {
            url.path()
                .ends_with("/approvals")
                .then(|| json_ok(&json!([])))
        }),
    );
    assert_eq!(s.client.list().await.unwrap().own_review, vec![]);
}

#[tokio::test]
async fn per_mr_rate_limits_and_redirects_are_passing_failures_not_missing() {
    let replies: [MakeReply; 3] = [
        || {
            Ok(HttpResponse::new(403)
                .with_header("x-ratelimit-remaining", "0")
                .with_body(b"{}".to_vec()))
        },
        || Ok(HttpResponse::new(403).with_header("retry-after", "60")),
        || redirect(302),
    ];
    for reply in replies {
        let s = setup(two().status(failing("/reviewers", reply)));
        let result = s.client.list().await.unwrap();
        assert_eq!(
            reviews(&result.mine),
            [ReviewState::Approved, ReviewState::None]
        );
        assert_eq!(result.own_review, vec![]);
    }
    // A 400 is a passing failure as well.
    let s = setup(two().status(failing("/reviewers", || json_status(&json!({}), 400))));
    assert_eq!(s.client.list().await.unwrap().own_review, vec![]);
}

#[tokio::test]
async fn contributions_count_every_contribution_kind_and_skip_unknown_dates() {
    let events = vec![
        event(
            "2026-11-13T09:00:00Z",
            "pushed new",
            json!({ "push_data": { "commit_count": 2 } }),
        ),
        event(
            "2026-11-13T09:00:00Z",
            "pushed to",
            json!({ "push_data": { "commit_count": null } }),
        ),
        event(
            "2026-11-13T09:00:00Z",
            "pushed to",
            json!({ "push_data": null }),
        ),
        event(
            "2026-11-13T09:00:00Z",
            "merged",
            json!({ "target_type": "MergeRequest" }),
        ),
        event(
            "2026-11-13T09:00:00Z",
            "closed",
            json!({ "target_type": "Issue" }),
        ),
        event(
            "2026-11-13T09:00:00Z",
            "created",
            json!({ "target_type": "WorkItem" }),
        ),
        event(
            "2026-11-13T09:00:00Z",
            "created",
            json!({ "target_type": "Project" }),
        ),
        event(
            "2026-11-13T09:00:00Z",
            "approved",
            json!({ "target_type": "Issue" }),
        ),
        event(
            "2026-11-13T09:00:00Z",
            "commented on",
            json!({ "target_type": "DiffNote" }),
        ),
        event(
            "2026-11-13T09:00:00Z",
            "commented on",
            json!({ "target_type": "Note", "note": { "noteable_type": null } }),
        ),
        event(
            "2026-11-13T09:00:00.123+01:00",
            "opened",
            json!({ "target_type": "MergeRequest" }),
        ),
        event("", "opened", json!({ "target_type": "MergeRequest" })),
    ];
    let s = paged_setup(move |_, _| json_ok(&json!(events)));
    let c = s.client.contributions(&now_range()).await.unwrap();
    // pushes 3, merged 1, closed issue 1, work item 1, approved issue 1, comments 2, opened 1.
    assert_eq!(count_of(&c, "2026-11-13"), 10);
    assert_eq!(c.today, totals(2, 1, 1, 1));
    assert_eq!(c.month_totals, c.today);
}

#[tokio::test]
async fn contributions_missing_x_next_page_continues_with_a_full_page() {
    // A missing header is not an empty one (`null !== ''`): a full page asks for the next.
    let s = paged_setup(|page, _| {
        if page == 1 {
            json_ok(&fill(100))
        } else {
            json_headers(&fill(100), &[("x-next-page", "")])
        }
    });
    s.client.contributions(&now_range()).await.unwrap();
    assert_eq!(s.event_calls().len(), 2);
}

#[tokio::test]
async fn contributions_use_the_local_date_of_each_event_in_summer_time_too() {
    // Madrid in July is UTC+2: 22:30Z on the 14th is the 15th locally.
    let r = range(MADRID, (2026, 7, 15, 12, 0), (7, 13));
    let s = paged_setup(|_, _| {
        json_ok(&json!([event(
            "2026-07-14T22:30:00Z",
            "opened",
            json!({ "target_type": "MergeRequest" })
        )]))
    });
    let c = s.client.contributions(&r).await.unwrap();
    assert_eq!(c.today.opened, 1);
    assert_eq!(count_of(&c, "2026-07-15"), 1);
    assert_eq!(
        params(&s.event_calls()[0])[..2],
        pairs(&[("after", "2026-06-29"), ("before", "2026-07-17")])[..]
    );
}

#[tokio::test]
async fn a_401_on_the_user_call_aborts_before_any_list() {
    let s = setup(Server::default().status(|url| {
        url.path()
            .ends_with("/user")
            .then(|| json_status(&json!({}), 401))
    }));
    expect_code(s.client.list().await, CodeReviewError::Auth);
    assert_eq!(s.calls(), 1);
}

// --- contributions(now): range helpers + summarize (carried from the TS client cases) -------

// gitlab client: contributions / classifies events by local day into the grid and the totals
// (the summary half: contributionSummarySchema-valid, grid counts, restricted false).
#[tokio::test]
async fn contribution_summary_classifies_events_by_local_day_into_the_grid_and_the_totals() {
    let s = paged_setup(|_, url| json_ok(&served(url, &month_events())));
    let now = MADRID.with_ymd_and_hms(2026, 11, 13, 10, 30, 0).unwrap();
    let summary = s.client.contribution_summary(&now).await.unwrap();
    let wire = serde_json::to_value(&summary).unwrap();
    assert_eq!(
        crate::contract::parse::<ContributionSummary>(wire).unwrap(),
        summary
    );
    let count = |date: &str| {
        summary
            .weeks
            .iter()
            .flatten()
            .find(|day| day.date == date)
            .map(|day| day.count)
    };
    assert_eq!(count("2026-11-13"), Some(2));
    assert_eq!(count("2026-11-10"), Some(1));
    assert_eq!(count("2026-11-05"), Some(0));
    assert_eq!(count("2026-11-02"), Some(2));
    assert_eq!(count("2026-11-01"), Some(1));
    assert_eq!(count("2026-11-14"), Some(0));
    assert_eq!(count("2026-10-31"), Some(0));
    assert_eq!(summary.month_total, 6);
    assert_eq!(summary.active_days, 4);
    assert_eq!(summary.today, totals(3, 0, 0, 1));
    assert_eq!(summary.week, totals(3, 1, 0, 1));
    assert_eq!(summary.month_totals, totals(3, 1, 1, 2));
    assert!(!summary.partial);
    assert!(!summary.restricted);
    assert_eq!(summary.updated_at, "2026-11-13T09:30:00.000Z");
}

#[tokio::test]
async fn contribution_summary_carries_partial_from_the_page_limit() {
    let s = paged_setup(|_, _| json_ok(&fill(100)));
    let now = MADRID.with_ymd_and_hms(2026, 11, 13, 10, 30, 0).unwrap();
    let summary = s.client.contribution_summary(&now).await.unwrap();
    assert!(summary.partial);
    assert!(!summary.restricted);
    summary.validate().unwrap();
}

/// The `CodeReviewClient` glue: `viewer`, `fetch` = `list`, `contributions(now)` = range +
/// summarize in the machine's local time zone.
#[tokio::test]
async fn implements_code_review_client() {
    let server = Server {
        mine: Some(json!([mr_iid(1)])),
        ..Server::default()
    }
    .status(|url| (url.path() == EVENTS).then(|| json_ok(&served(url, &month_events()))));
    let s = setup(server);
    let client: &dyn CodeReviewClient = &s.client;
    assert_eq!(client.viewer().await.unwrap(), "me");
    let snapshot = client.fetch().await.unwrap();
    assert_eq!(snapshot, s.client.list().await.unwrap());
    assert_eq!(snapshot.mine.len(), 1);
    let now = MADRID
        .with_ymd_and_hms(2026, 11, 13, 10, 30, 0)
        .unwrap()
        .with_timezone(&Utc);
    let summary = client.contributions(now).await.unwrap();
    summary.validate().unwrap();
    let local = now.with_timezone(&chrono::Local);
    assert_eq!(summary.month, local.format("%Y-%m").to_string());
    assert_eq!(summary.updated_at, "2026-11-13T09:30:00.000Z");
    assert!(!summary.restricted);
}
