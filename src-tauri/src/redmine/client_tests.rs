//! Port of `tests/unit/main/redmine-client.test.ts` (49 cases, every `it.each` row counted), plus
//! the exact write bodies, the zod tolerances of the parser, the key never shown, and a PUT and a
//! redirect against a loopback server. A fake [`Transport`] or loopback only: no network.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use serde_json::{json, Value};
use url::Url;

use super::*;
use crate::contract::redmine::{Named, RedmineIssue, RedmineWriteError, RedmineWriteResult};
use crate::contract::Validate;
use crate::http::transport::test_support::serve;
use crate::http::{HttpRequest, HttpResponse, Method, ReqwestTransport, TransportError};
use crate::ipc::BoxFuture;

const BASE: &str = "https://redmine.x.com/base";
const KEY: &str = "secret-api-key";

type Reply = Result<HttpResponse, TransportError>;
type Respond = dyn Fn(&HttpRequest, usize) -> Reply + Send + Sync;

/// Answers with `respond(request, index)` and records every request.
struct Fake {
    respond: Box<Respond>,
    requests: Mutex<Vec<HttpRequest>>,
}

impl Fake {
    fn new(respond: impl Fn(&HttpRequest, usize) -> Reply + Send + Sync + 'static) -> Self {
        Self {
            respond: Box::new(respond),
            requests: Mutex::new(Vec::new()),
        }
    }
}

impl Transport for Fake {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Reply> {
        let index = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(request.clone());
            requests.len() - 1
        };
        let result = (self.respond)(&request, index);
        Box::pin(async move { result })
    }
}

fn json_status(body: &Value, status: u16) -> Reply {
    Ok(HttpResponse::new(status).with_body(serde_json::to_vec(body).unwrap()))
}

fn json_ok(body: &Value) -> Reply {
    json_status(body, 200)
}

fn empty(status: u16) -> Reply {
    Ok(HttpResponse::new(status))
}

fn url_of(request: &HttpRequest) -> Url {
    Url::parse(&request.url).expect("an absolute URL")
}

fn param(request: &HttpRequest, name: &str) -> Option<String> {
    url_of(request)
        .query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

/// The query in order (TS compares `Object.fromEntries`; the order is checked here too).
fn params(request: &HttpRequest) -> Vec<(String, String)> {
    url_of(request)
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect()
}

fn pairs(expected: &[(&str, &str)]) -> Vec<(String, String)> {
    expected
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect()
}

fn path(request: &HttpRequest) -> String {
    url_of(request).path().to_owned()
}

fn body_of(request: &HttpRequest) -> Value {
    serde_json::from_slice(request.body.as_deref().expect("a body")).expect("a JSON body")
}

fn body_text(request: &HttpRequest) -> String {
    String::from_utf8(request.body.clone().expect("a body")).unwrap()
}

struct Setup {
    client: RedmineClient,
    fake: Arc<Fake>,
}

impl Setup {
    fn requests(&self) -> Vec<HttpRequest> {
        self.fake.requests.lock().unwrap().clone()
    }

    fn calls(&self) -> usize {
        self.fake.requests.lock().unwrap().len()
    }
}

fn harness(respond: impl Fn(&HttpRequest, usize) -> Reply + Send + Sync + 'static) -> Setup {
    let fake = Arc::new(Fake::new(respond));
    let client = RedmineClient::new(fake.clone(), BASE, KEY).expect("a valid base URL");
    Setup { client, fake }
}

fn failing() -> RedmineClient {
    let fake = Arc::new(Fake::new(|_, _| Err(TransportError::Network)));
    RedmineClient::new(fake, BASE, KEY).unwrap()
}

fn raw_issue(id: u64) -> Value {
    json!({
        "id": id,
        "subject": format!("Task {id}"),
        "project": { "id": 1, "name": "Proj" },
        "status": { "id": 2, "name": "In progress" },
        "updated_on": "2026-11-12T10:00:00Z",
    })
}

fn raw_issue_with(id: u64, extra: &Value) -> Value {
    let mut issue = raw_issue(id);
    for (key, value) in extra.as_object().unwrap() {
        issue[key] = value.clone();
    }
    issue
}

fn offset_limit(request: &HttpRequest) -> (u64, u64) {
    (
        param(request, "offset").unwrap().parse().unwrap(),
        param(request, "limit").unwrap().parse().unwrap(),
    )
}

/// Serves `total` issues paged by the `offset`/`limit` query.
fn paged_issues(total: u64, reported: u64) -> impl Fn(&HttpRequest, usize) -> Reply {
    move |request, _| {
        let (offset, limit) = offset_limit(request);
        let count = limit.min(total.saturating_sub(offset));
        let issues: Vec<Value> = (0..count).map(|i| raw_issue(offset + i + 1)).collect();
        json_ok(
            &json!({ "issues": issues, "total_count": reported, "offset": offset, "limit": limit }),
        )
    }
}

/// Serves `total` time entries of 0.5 h paged by the `offset`/`limit` query.
fn paged_entries(total: u64, reported: u64) -> impl Fn(&HttpRequest, usize) -> Reply {
    move |request, _| {
        let (offset, limit) = offset_limit(request);
        let count = limit.min(total.saturating_sub(offset));
        let entries: Vec<Value> = (0..count)
            .map(|_| json!({ "spent_on": "2026-11-10", "hours": 0.5 }))
            .collect();
        json_ok(&json!({ "time_entries": entries, "total_count": reported }))
    }
}

fn refused(reason: RedmineWriteError) -> RedmineWriteResult {
    RedmineWriteResult::Refused {
        reason,
        messages: None,
    }
}

fn status_patch(status_id: u64) -> IssuePatch {
    IssuePatch {
        status_id: Some(status_id),
        estimated_hours: None,
    }
}

fn entry() -> TimeEntryInput {
    TimeEntryInput {
        issue_id: 5,
        spent_on: "2026-11-14".into(),
        hours: 1.5,
        activity_id: 9,
        comments: "work".into(),
    }
}

// --- createRedmineClient -------------------------------------------------------------------------

#[test]
fn refuses_http_unless_loopback_is_allowed() {
    let transport = || -> Arc<dyn Transport> { Arc::new(Fake::new(|_, _| json_ok(&json!({})))) };
    assert_eq!(
        RedmineClient::new(transport(), "http://redmine.x.com", KEY).unwrap_err(),
        InvalidRedmineUrl
    );
    assert!(RedmineClient::new(transport(), "http://127.0.0.1:4000", KEY).is_err());
    assert!(
        RedmineClient::new_allowing_loopback_http(transport(), "http://127.0.0.1:4000", KEY)
            .is_ok()
    );
    assert!(
        RedmineClient::new_allowing_loopback_http(transport(), "http://redmine.x.com", KEY)
            .is_err()
    );
    assert!(RedmineClient::new(transport(), "https://redmine.x.com/", KEY).is_err());
    // The normalized forms are accepted, with and without loopback.
    assert!(RedmineClient::new(transport(), BASE, KEY).is_ok());
    assert!(RedmineClient::new(transport(), "https://redmine.x.com", KEY).is_ok());
    assert!(RedmineClient::new_allowing_loopback_http(transport(), BASE, KEY).is_ok());
    // The constructor regex does not range-check the port (as in TS), but needs 1 to 5 digits.
    assert!(
        RedmineClient::new_allowing_loopback_http(transport(), "http://127.0.0.1:99999", KEY)
            .is_ok()
    );
    assert!(
        RedmineClient::new_allowing_loopback_http(transport(), "http://127.0.0.1:123456", KEY)
            .is_err()
    );
    assert!(
        RedmineClient::new_allowing_loopback_http(transport(), "http://127.0.0.1:", KEY).is_err()
    );
    assert_eq!(
        InvalidRedmineUrl.to_string(),
        "Redmine base URL must be a normalized https URL"
    );
}

#[test]
fn builds_issue_urls_from_the_base_url() {
    let setup = harness(|_, _| json_ok(&json!({})));
    assert_eq!(setup.client.issue_url(42), format!("{BASE}/issues/42"));
}

#[tokio::test]
async fn never_puts_the_api_key_in_a_request_url() {
    let setup = harness(|request, _| {
        let path = path(request);
        if path.ends_with("/users/current.json") {
            return json_ok(&json!({ "user": { "id": 7, "login": "alice" } }));
        }
        if path.ends_with("/issues.json") {
            return json_ok(&json!({ "issues": [raw_issue(1)], "total_count": 1 }));
        }
        if path.ends_with("/issue_statuses.json") {
            return json_ok(&json!({ "issue_statuses": [{ "id": 1, "name": "New" }] }));
        }
        if path.ends_with("/time_entry_activities.json") {
            return json_ok(&json!({ "time_entry_activities": [] }));
        }
        if path.ends_with("/time_entries.json") && request.method == Method::Get {
            return json_ok(&json!({ "time_entries": [], "total_count": 0 }));
        }
        if request.method != Method::Get {
            return empty(204);
        }
        json_ok(&json!({ "issue": raw_issue(5) }))
    });
    let client = &setup.client;
    client.viewer().await.unwrap();
    client.issues().await.unwrap();
    client.issue(5).await.unwrap();
    client.statuses().await.unwrap();
    client.activities().await.unwrap();
    client
        .time_entries("2026-11-01", "2026-11-14")
        .await
        .unwrap();
    assert_eq!(
        client.update_issue(5, status_patch(3)).await,
        RedmineWriteResult::Done
    );
    let input = TimeEntryInput {
        hours: 1.0,
        comments: String::new(),
        ..entry()
    };
    assert_eq!(client.log_time(&input).await, RedmineWriteResult::Done);
    let requests = setup.requests();
    assert!(requests.len() >= 8);
    for request in &requests {
        assert!(!request.url.contains(KEY));
        assert!(param(request, "key").is_none());
        assert_eq!(request.header_value("x-redmine-api-key"), Some(KEY));
        // Also: `accept` everywhere, `content-type` on writes only, never `authorization`.
        assert_eq!(request.header_value("accept"), Some("application/json"));
        assert_eq!(request.header_value("authorization"), None);
        let write = request.method != Method::Get;
        assert_eq!(
            request.header_value("content-type"),
            write.then_some("application/json")
        );
        assert_eq!(request.body.is_some(), write);
    }
}

// --- viewer --------------------------------------------------------------------------------------

#[tokio::test]
async fn viewer_requests_users_current_with_the_api_key_and_uses_firstname_lastname() {
    let setup = harness(|_, _| {
        json_ok(
            &json!({ "user": { "id": 7, "login": "alice", "firstname": "Alice", "lastname": "Doe" } }),
        )
    });
    assert_eq!(
        setup.client.viewer().await,
        Ok(Viewer {
            id: 7,
            name: "Alice Doe".into()
        })
    );
    let requests = setup.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].url, format!("{BASE}/users/current.json"));
    assert_eq!(requests[0].method, Method::Get);
    assert_eq!(requests[0].header_value("x-redmine-api-key"), Some(KEY));
    // `redirect: 'manual'`: the transport never follows one (see the loopback redirect test).
}

#[tokio::test]
async fn viewer_falls_back_to_the_login_without_a_name() {
    let setup = harness(|_, _| json_ok(&json!({ "user": { "id": 7, "login": "alice" } })));
    assert_eq!(
        setup.client.viewer().await,
        Ok(Viewer {
            id: 7,
            name: "alice".into()
        })
    );
    let blank = harness(|_, _| {
        json_ok(&json!({ "user": { "id": 7, "login": "alice", "firstname": "", "lastname": " " } }))
    });
    assert_eq!(
        blank.client.viewer().await,
        Ok(Viewer {
            id: 7,
            name: "alice".into()
        })
    );
    // `null` names count as absent; one name alone is trimmed.
    let nulls = harness(|_, _| {
        json_ok(
            &json!({ "user": { "id": 7, "login": "alice", "firstname": null, "lastname": "Doe" } }),
        )
    });
    assert_eq!(nulls.client.viewer().await.unwrap().name, "Doe");
}

// --- issues --------------------------------------------------------------------------------------

#[tokio::test]
async fn issues_requests_the_open_assigned_issues_of_the_first_page() {
    let setup = harness(paged_issues(2, 2));
    let list = setup.client.issues().await.unwrap();
    let requests = setup.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(path(&requests[0]), "/base/issues.json");
    assert_eq!(
        params(&requests[0]),
        pairs(&[
            ("assigned_to_id", "me"),
            ("status_id", "open"),
            ("sort", "updated_on:desc"),
            ("limit", "100"),
            ("offset", "0"),
        ])
    );
    // `searchParams` form-encodes `:` exactly as `url` does.
    assert_eq!(
        requests[0].url,
        format!("{BASE}/issues.json?assigned_to_id=me&status_id=open&sort=updated_on%3Adesc&limit=100&offset=0")
    );
    assert_eq!(requests[0].header_value("x-redmine-api-key"), Some(KEY));
    assert!(!list.truncated);
    assert_eq!(list.issues.len(), 2);
    assert_eq!(list.validate(), Ok(()));
}

#[tokio::test]
async fn issues_map_fields_spent_hours_is_spent_then_total_spent_then_null() {
    let setup = harness(|_, _| {
        json_ok(&json!({
            "issues": [
                raw_issue_with(1, &json!({ "estimated_hours": 4.5, "spent_hours": 2, "total_spent_hours": 9 })),
                raw_issue_with(2, &json!({ "total_spent_hours": 3 })),
                raw_issue(3),
            ],
            "total_count": 3,
        }))
    });
    let issues = setup.client.issues().await.unwrap().issues;
    assert_eq!(
        issues[0],
        RedmineIssue {
            id: 1,
            subject: "Task 1".into(),
            project: "Proj".into(),
            status: Named {
                id: 2,
                name: "In progress".into()
            },
            estimated_hours: Some(4.5),
            spent_hours: Some(2.0),
            updated_on: "2026-11-12T10:00:00Z".into(),
        }
    );
    assert_eq!(
        (issues[1].estimated_hours, issues[1].spent_hours),
        (None, Some(3.0))
    );
    assert_eq!(
        (issues[2].estimated_hours, issues[2].spent_hours),
        (None, None)
    );
}

#[tokio::test]
async fn issues_page_through_250_in_3_requests() {
    let setup = harness(paged_issues(250, 250));
    let list = setup.client.issues().await.unwrap();
    let offsets: Vec<String> = setup
        .requests()
        .iter()
        .map(|request| param(request, "offset").unwrap())
        .collect();
    assert_eq!(offsets, ["0", "100", "200"]);
    assert_eq!(list.issues.len(), 250);
    assert!(!list.truncated);
}

#[tokio::test]
async fn issues_stop_at_3_pages_and_flag_truncated_with_350() {
    let setup = harness(paged_issues(350, 350));
    let list = setup.client.issues().await.unwrap();
    assert_eq!(setup.calls(), 3);
    assert_eq!(list.issues.len(), 300);
    assert!(list.truncated);
}

#[tokio::test]
async fn issues_are_not_truncated_with_exactly_300() {
    let setup = harness(paged_issues(300, 300));
    let list = setup.client.issues().await.unwrap();
    assert_eq!(setup.calls(), 3);
    assert!(!list.truncated);
}

#[tokio::test]
async fn issues_do_not_loop_when_total_count_is_inconsistent() {
    let setup = harness(paged_issues(100, 100_000));
    let list = setup.client.issues().await.unwrap();
    assert!(setup.calls() <= 3);
    assert_eq!(list.issues.len(), 100);
    let none = harness(|_, _| json_ok(&json!({ "issues": [], "total_count": 9999 })));
    assert_eq!(none.client.issues().await.unwrap().issues, Vec::new());
    assert_eq!(none.calls(), 1);
}

#[tokio::test]
async fn issues_drop_an_issue_seen_on_an_earlier_page() {
    // Page 2 repeats issues 100 and 99 (two issues were updated meanwhile and moved to the top).
    let setup = harness(|request, _| {
        let (offset, _) = offset_limit(request);
        if offset == 0 {
            let issues: Vec<Value> = (1..=100).map(raw_issue).collect();
            return json_ok(&json!({ "issues": issues, "total_count": 150 }));
        }
        let mut issues = vec![
            raw_issue_with(100, &json!({ "subject": "moved" })),
            raw_issue(99),
        ];
        issues.extend((101..=148).map(raw_issue));
        json_ok(&json!({ "issues": issues, "total_count": 150 }))
    });
    let list = setup.client.issues().await.unwrap();
    let ids: Vec<u64> = list.issues.iter().map(|issue| issue.id).collect();
    let unique: std::collections::HashSet<u64> = ids.iter().copied().collect();
    assert_eq!(unique.len(), ids.len());
    assert_eq!(ids.len(), 148);
    assert_eq!(ids[..3], [1, 2, 3]);
    // The first sighting is the one kept, and `truncated` counts the 150 read (before dedupe).
    assert_eq!(list.issues[99].subject, "Task 100");
    assert!(!list.truncated);
}

#[tokio::test]
async fn issues_reject_an_invalid_body() {
    let setup = harness(|_, _| json_ok(&json!({ "nope": true })));
    assert_eq!(setup.client.issues().await, Err(ApiError::InvalidResponse));
}

// --- issue ---------------------------------------------------------------------------------------

#[tokio::test]
async fn issue_requests_the_detail_with_allowed_statuses() {
    let setup = harness(|_, _| {
        json_ok(&json!({
            "issue": raw_issue_with(5, &json!({
                "allowed_statuses": [{ "id": 2, "name": "In progress" }, { "id": 3, "name": "Done" }],
            })),
        }))
    });
    let detail = setup.client.issue(5).await.unwrap();
    let requests = setup.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(path(&requests[0]), "/base/issues/5.json");
    assert_eq!(
        param(&requests[0], "include").as_deref(),
        Some("allowed_statuses")
    );
    assert_eq!(
        requests[0].url,
        format!("{BASE}/issues/5.json?include=allowed_statuses")
    );
    assert_eq!(
        detail.allowed_statuses,
        [
            Named {
                id: 2,
                name: "In progress".into()
            },
            Named {
                id: 3,
                name: "Done".into()
            },
        ]
    );
    assert_eq!(detail.id, 5);
    assert_eq!(detail.subject, "Task 5");
    assert_eq!(detail.validate(), Ok(()));
}

#[tokio::test]
async fn issue_falls_back_to_issue_statuses_when_allowed_statuses_is_missing() {
    let setup = harness(|request, _| {
        if path(request).ends_with("/issue_statuses.json") {
            json_ok(&json!({
                "issue_statuses": [
                    { "id": 1, "name": "New", "is_closed": false },
                    { "id": 5, "name": "Closed", "is_closed": true },
                ],
            }))
        } else {
            json_ok(&json!({ "issue": raw_issue(5) }))
        }
    });
    let detail = setup.client.issue(5).await.unwrap();
    let paths: Vec<String> = setup.requests().iter().map(path).collect();
    assert_eq!(paths, ["/base/issues/5.json", "/base/issue_statuses.json"]);
    assert_eq!(
        detail.allowed_statuses,
        [
            Named {
                id: 1,
                name: "New".into()
            },
            Named {
                id: 5,
                name: "Closed".into()
            },
        ]
    );
}

#[tokio::test]
async fn issue_caches_the_statuses_for_the_session() {
    let setup = harness(|request, _| {
        if path(request).ends_with("/issue_statuses.json") {
            json_ok(&json!({ "issue_statuses": [{ "id": 1, "name": "New" }] }))
        } else {
            json_ok(&json!({ "issue": raw_issue(5) }))
        }
    });
    setup.client.issue(5).await.unwrap();
    setup.client.issue(6).await.unwrap();
    let status_calls = setup
        .requests()
        .iter()
        .filter(|request| path(request).ends_with("/issue_statuses.json"))
        .count();
    assert_eq!(status_calls, 1);
}

#[tokio::test]
async fn issue_404_on_read_is_invalid_response() {
    let setup = harness(|_, _| json_status(&json!({}), 404));
    assert_eq!(setup.client.issue(5).await, Err(ApiError::InvalidResponse));
}

#[tokio::test]
async fn issue_keeps_an_empty_allowed_statuses_and_falls_back_on_null() {
    // Only an absent or `null` list falls back; `[]` is kept (no status change allowed).
    let setup = harness(|request, _| {
        if path(request).ends_with("/issue_statuses.json") {
            json_ok(&json!({ "issue_statuses": [{ "id": 1, "name": "New" }] }))
        } else if path(request).ends_with("/5.json") {
            json_ok(&json!({ "issue": raw_issue_with(5, &json!({ "allowed_statuses": [] })) }))
        } else {
            json_ok(&json!({ "issue": raw_issue_with(6, &json!({ "allowed_statuses": null })) }))
        }
    });
    assert_eq!(
        setup.client.issue(5).await.unwrap().allowed_statuses,
        Vec::new()
    );
    assert_eq!(setup.calls(), 1);
    assert_eq!(
        setup.client.issue(6).await.unwrap().allowed_statuses,
        [Named {
            id: 1,
            name: "New".into()
        }]
    );
    assert_eq!(setup.calls(), 3);
}

// --- statuses and activities ---------------------------------------------------------------------

#[tokio::test]
async fn statuses_request_issue_statuses() {
    let setup = harness(|_, _| json_ok(&json!({ "issue_statuses": [{ "id": 1, "name": "New" }] })));
    assert_eq!(
        setup.client.statuses().await,
        Ok(vec![Named {
            id: 1,
            name: "New".into()
        }])
    );
    assert_eq!(
        setup.requests()[0].url,
        format!("{BASE}/issue_statuses.json")
    );
}

#[tokio::test]
async fn activities_request_time_entry_activities_with_is_default_false_by_default_cached() {
    let setup = harness(|_, _| {
        json_ok(&json!({
            "time_entry_activities": [
                { "id": 9, "name": "Dev", "is_default": true },
                { "id": 10, "name": "Test" },
            ],
        }))
    });
    let activities = setup.client.activities().await.unwrap();
    assert_eq!(
        activities,
        [
            RedmineActivity {
                id: 9,
                name: "Dev".into(),
                is_default: true
            },
            RedmineActivity {
                id: 10,
                name: "Test".into(),
                is_default: false
            },
        ]
    );
    assert!(activities.iter().all(|a| a.validate().is_ok()));
    assert_eq!(
        setup.requests()[0].url,
        format!("{BASE}/enumerations/time_entry_activities.json")
    );
    setup.client.activities().await.unwrap();
    assert_eq!(setup.calls(), 1);
}

#[tokio::test]
async fn activities_do_not_cache_a_failure() {
    let n = AtomicUsize::new(0);
    let setup = harness(move |_, _| {
        if n.fetch_add(1, Ordering::SeqCst) == 0 {
            json_status(&json!({}), 500)
        } else {
            json_ok(&json!({ "time_entry_activities": [] }))
        }
    });
    assert_eq!(setup.client.activities().await, Err(ApiError::Server));
    assert_eq!(setup.client.activities().await, Ok(Vec::new()));
    assert_eq!(setup.calls(), 2);
}

// --- timeEntries ---------------------------------------------------------------------------------

#[tokio::test]
async fn time_entries_request_the_user_entries_between_from_and_to() {
    let setup = harness(|_, _| {
        json_ok(&json!({
            "time_entries": [
                { "spent_on": "2026-11-10", "hours": 1.5 },
                { "spent_on": "2026-11-11", "hours": 2 },
            ],
            "total_count": 2,
        }))
    });
    assert_eq!(
        setup.client.time_entries("2026-11-01", "2026-11-14").await,
        Ok(vec![
            TimeEntry {
                date: "2026-11-10".into(),
                hours: 1.5
            },
            TimeEntry {
                date: "2026-11-11".into(),
                hours: 2.0
            },
        ])
    );
    let requests = setup.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(path(&requests[0]), "/base/time_entries.json");
    assert_eq!(
        params(&requests[0]),
        pairs(&[
            ("user_id", "me"),
            ("from", "2026-11-01"),
            ("to", "2026-11-14"),
            ("limit", "100"),
            ("offset", "0"),
        ])
    );
}

#[tokio::test]
async fn time_entries_page_until_a_short_page() {
    let setup = harness(paged_entries(250, 250));
    assert_eq!(
        setup
            .client
            .time_entries("2026-11-01", "2026-11-14")
            .await
            .unwrap()
            .len(),
        250
    );
    assert_eq!(setup.calls(), 3);
}

#[tokio::test]
async fn time_entries_read_at_most_10_pages() {
    let setup = harness(paged_entries(5000, 5000));
    assert_eq!(
        setup
            .client
            .time_entries("2026-11-01", "2026-11-14")
            .await
            .unwrap()
            .len(),
        1000
    );
    assert_eq!(setup.calls(), 10);
}

#[tokio::test]
async fn time_entries_do_not_loop_when_total_count_is_inconsistent() {
    let setup = harness(paged_entries(40, 100_000));
    assert_eq!(
        setup
            .client
            .time_entries("2026-11-01", "2026-11-14")
            .await
            .unwrap()
            .len(),
        40
    );
    assert_eq!(setup.calls(), 1);
}

/// `it.each` (5 rows): a malformed `spent_on` makes the whole read `invalid-response`.
#[tokio::test]
async fn time_entries_reject_a_malformed_spent_on_as_invalid_response() {
    for spent_on in [
        "2026-11-1",
        "14/11/2026",
        "2026-11-14T10:00:00Z",
        "2026-13-01",
        "",
    ] {
        let setup = harness(move |_, _| {
            json_ok(
                &json!({ "time_entries": [{ "spent_on": spent_on, "hours": 1 }], "total_count": 1 }),
            )
        });
        assert_eq!(
            setup.client.time_entries("2026-11-01", "2026-11-14").await,
            Err(ApiError::InvalidResponse),
            "{spent_on:?}"
        );
    }
}

// --- read errors ---------------------------------------------------------------------------------

/// `it.each` (5 rows): the read status mapping (`statusError`).
#[tokio::test]
async fn read_errors_map_statuses() {
    for (status, error) in [
        (401, ApiError::Auth),
        (403, ApiError::Auth),
        (500, ApiError::Server),
        (429, ApiError::RateLimited),
        (404, ApiError::InvalidResponse),
    ] {
        let setup = harness(move |_, _| json_status(&json!({}), status));
        assert_eq!(setup.client.viewer().await, Err(error), "{status}");
    }
}

#[tokio::test]
async fn read_errors_map_a_redirect_to_invalid_response() {
    let setup =
        harness(|_, _| Ok(HttpResponse::new(302).with_header("location", "https://evil.example/")));
    assert_eq!(setup.client.issues().await, Err(ApiError::InvalidResponse));
    assert_eq!(setup.calls(), 1);
}

#[tokio::test]
async fn read_errors_map_a_network_failure_to_network() {
    assert_eq!(failing().viewer().await, Err(ApiError::Network));
}

// --- updateIssue ---------------------------------------------------------------------------------

#[tokio::test]
async fn update_issue_puts_the_status_id_and_treats_204_as_ok() {
    let setup = harness(|_, _| empty(204));
    assert_eq!(
        setup.client.update_issue(5, status_patch(3)).await,
        RedmineWriteResult::Done
    );
    let request = &setup.requests()[0];
    assert_eq!(request.method, Method::Put);
    assert_eq!(request.url, format!("{BASE}/issues/5.json"));
    assert_eq!(request.header_value("x-redmine-api-key"), Some(KEY));
    assert_eq!(
        request.header_value("content-type"),
        Some("application/json")
    );
    assert_eq!(body_of(request), json!({ "issue": { "status_id": 3 } }));
    // `redirect: 'manual'`: the transport never follows one (see the loopback redirect test).
}

#[tokio::test]
async fn update_issue_puts_the_estimated_hours_and_null_clears_them() {
    let setup = harness(|_, _| empty(204));
    let set = IssuePatch {
        status_id: None,
        estimated_hours: Some(Some(2.5)),
    };
    let clear = IssuePatch {
        status_id: None,
        estimated_hours: Some(None),
    };
    setup.client.update_issue(5, set).await;
    setup.client.update_issue(5, clear).await;
    let requests = setup.requests();
    assert_eq!(
        body_of(&requests[0]),
        json!({ "issue": { "estimated_hours": 2.5 } })
    );
    assert_eq!(
        body_of(&requests[1]),
        json!({ "issue": { "estimated_hours": null } })
    );
}

/// `it.each` (6 rows): `writeReason`, without failing.
#[tokio::test]
async fn update_issue_maps_statuses_without_failing() {
    for (status, reason) in [
        (401, RedmineWriteError::Auth),
        (403, RedmineWriteError::Forbidden),
        (404, RedmineWriteError::NotFound),
        (500, RedmineWriteError::Server),
        (429, RedmineWriteError::Server),
        (400, RedmineWriteError::InvalidResponse),
    ] {
        let setup = harness(move |_, _| json_status(&json!({}), status));
        assert_eq!(
            setup.client.update_issue(5, status_patch(3)).await,
            refused(reason),
            "{status}"
        );
    }
}

#[tokio::test]
async fn update_issue_maps_422_to_validation_with_clipped_messages_at_most_3() {
    let long = "x".repeat(300);
    let setup = harness(move |_, _| {
        json_status(
            &json!({ "errors": ["Status is invalid", long, "c", "d"] }),
            422,
        )
    });
    assert_eq!(
        setup.client.update_issue(5, status_patch(3)).await,
        RedmineWriteResult::Refused {
            reason: RedmineWriteError::Validation,
            messages: Some(vec![
                "Status is invalid".into(),
                "x".repeat(200),
                "c".into()
            ]),
        }
    );
}

#[tokio::test]
async fn update_issue_maps_a_422_without_a_readable_body_to_validation_without_messages() {
    let setup = harness(|_, _| Ok(HttpResponse::new(422).with_body("<html>")));
    assert_eq!(
        setup.client.update_issue(5, status_patch(3)).await,
        refused(RedmineWriteError::Validation)
    );
}

#[tokio::test]
async fn update_issue_maps_a_redirect_to_invalid_response_and_a_network_failure_to_network() {
    let redirect = harness(|_, _| empty(302));
    assert_eq!(
        redirect.client.update_issue(5, status_patch(3)).await,
        refused(RedmineWriteError::InvalidResponse)
    );
    assert_eq!(
        failing().update_issue(5, status_patch(3)).await,
        refused(RedmineWriteError::Network)
    );
}

// --- logTime -------------------------------------------------------------------------------------

#[tokio::test]
async fn log_time_posts_the_time_entry_and_treats_201_as_ok() {
    let setup = harness(|_, _| json_status(&json!({ "time_entry": { "id": 1 } }), 201));
    assert_eq!(
        setup.client.log_time(&entry()).await,
        RedmineWriteResult::Done
    );
    let request = &setup.requests()[0];
    assert_eq!(request.method, Method::Post);
    assert_eq!(request.url, format!("{BASE}/time_entries.json"));
    assert_eq!(request.header_value("x-redmine-api-key"), Some(KEY));
    assert_eq!(
        body_of(request),
        json!({
            "time_entry": { "issue_id": 5, "spent_on": "2026-11-14", "hours": 1.5, "activity_id": 9, "comments": "work" },
        })
    );
}

#[tokio::test]
async fn log_time_maps_422_403_and_401_to_results() {
    let validation = harness(|_, _| json_status(&json!({ "errors": ["Hours is invalid"] }), 422));
    assert_eq!(
        validation.client.log_time(&entry()).await,
        RedmineWriteResult::Refused {
            reason: RedmineWriteError::Validation,
            messages: Some(vec!["Hours is invalid".into()]),
        }
    );
    let forbidden = harness(|_, _| json_status(&json!({}), 403));
    assert_eq!(
        forbidden.client.log_time(&entry()).await,
        refused(RedmineWriteError::Forbidden)
    );
    let auth = harness(|_, _| json_status(&json!({}), 401));
    assert_eq!(
        auth.client.log_time(&entry()).await,
        refused(RedmineWriteError::Auth)
    );
}

// --- Rust additions ------------------------------------------------------------------------------

#[tokio::test]
async fn write_body_prints_numbers_like_js() {
    let setup = harness(|_, _| empty(204));
    let both = IssuePatch {
        status_id: Some(3),
        estimated_hours: Some(Some(3.0)),
    };
    setup.client.update_issue(5, both).await;
    setup.client.log_time(&entry()).await;
    let whole = TimeEntryInput {
        hours: 3.0,
        comments: "a \"quoted\" é".into(),
        ..entry()
    };
    setup.client.log_time(&whole).await;
    let requests = setup.requests();
    // `JSON.stringify`: `3`, not `3.0`; key order status_id then estimated_hours.
    assert_eq!(
        body_text(&requests[0]),
        r#"{"issue":{"status_id":3,"estimated_hours":3}}"#
    );
    assert_eq!(
        body_text(&requests[1]),
        r#"{"time_entry":{"issue_id":5,"spent_on":"2026-11-14","hours":1.5,"activity_id":9,"comments":"work"}}"#
    );
    assert_eq!(
        body_text(&requests[2]),
        r#"{"time_entry":{"issue_id":5,"spent_on":"2026-11-14","hours":3,"activity_id":9,"comments":"a \"quoted\" é"}}"#
    );
}

#[tokio::test]
async fn a_422_with_empty_or_non_string_errors_has_no_messages() {
    for body in [
        json!({ "errors": [] }),
        json!({ "errors": ["ok", 7] }),
        json!({ "errors": "Status is invalid" }),
        json!(["Status is invalid"]),
    ] {
        let setup = harness(move |_, _| json_status(&body, 422));
        assert_eq!(
            setup.client.update_issue(5, status_patch(3)).await,
            refused(RedmineWriteError::Validation)
        );
    }
}

#[tokio::test]
async fn a_write_with_an_oversized_response_or_any_2xx_is_mapped() {
    let oversized = harness(|_, _| Err(TransportError::BodyTooLarge));
    assert_eq!(
        oversized.client.log_time(&entry()).await,
        refused(RedmineWriteError::InvalidResponse)
    );
    for status in [200, 201, 204] {
        let ok = harness(move |_, _| empty(status));
        assert_eq!(ok.client.log_time(&entry()).await, RedmineWriteResult::Done);
    }
    // A rate-limit 403 is still `forbidden` for a write (unlike a read).
    let limited = harness(|_, _| {
        Ok(HttpResponse::new(403)
            .with_header("retry-after", "60")
            .with_header("x-ratelimit-remaining", "0"))
    });
    assert_eq!(
        limited.client.update_issue(5, status_patch(3)).await,
        refused(RedmineWriteError::Forbidden)
    );
    let server = harness(|_, _| empty(503));
    assert_eq!(
        server.client.log_time(&entry()).await,
        refused(RedmineWriteError::Server)
    );
}

#[tokio::test]
async fn responses_follow_the_zod_rules() {
    async fn issues_with(issue: Value) -> Result<RedmineIssueList, ApiError> {
        let body = json!({ "issues": [issue] });
        harness(move |_, _| json_ok(&body)).client.issues().await
    }
    let bad = ApiError::InvalidResponse;
    // `id: z.int().min(1)`; an integral float is an integer.
    assert_eq!(
        issues_with(raw_issue_with(1, &json!({ "id": 0 }))).await,
        Err(bad)
    );
    assert_eq!(
        issues_with(raw_issue_with(1, &json!({ "id": 1.5 }))).await,
        Err(bad)
    );
    assert_eq!(
        issues_with(raw_issue_with(1, &json!({ "id": 12.0 })))
            .await
            .unwrap()
            .issues[0]
            .id,
        12
    );
    // Hours: `z.number().min(0).nullable().optional()`, each checked even when not used.
    assert_eq!(
        issues_with(raw_issue_with(1, &json!({ "estimated_hours": -1 }))).await,
        Err(bad)
    );
    assert_eq!(
        issues_with(raw_issue_with(
            1,
            &json!({ "spent_hours": 1, "total_spent_hours": "9" })
        ))
        .await,
        Err(bad)
    );
    let nulls = issues_with(raw_issue_with(
        1,
        &json!({ "estimated_hours": null, "spent_hours": null, "total_spent_hours": 4 }),
    ))
    .await
    .unwrap();
    assert_eq!(nulls.issues[0].spent_hours, Some(4.0));
    // The status id is any safe integer; the project needs a name.
    assert_eq!(
        issues_with(raw_issue_with(
            1,
            &json!({ "status": { "id": -3, "name": "Odd" } })
        ))
        .await
        .unwrap()
        .issues[0]
            .status
            .id,
        -3
    );
    assert_eq!(
        issues_with(raw_issue_with(1, &json!({ "project": {} }))).await,
        Err(bad)
    );
    assert_eq!(
        issues_with(raw_issue_with(
            1,
            &json!({ "allowed_statuses": [{ "id": 1 }] })
        ))
        .await,
        Err(bad)
    );
    // Texts are clipped to 512 UTF-16 units.
    let long = "é".repeat(600);
    let clipped = issues_with(raw_issue_with(1, &json!({ "subject": long })))
        .await
        .unwrap();
    assert_eq!(clipped.issues[0].subject.chars().count(), 512);
    // `total_count: z.int().min(0).nullable().optional()`.
    for total in [json!(-1), json!("2"), json!(1.5)] {
        let body = json!({ "issues": [], "total_count": total });
        assert_eq!(
            harness(move |_, _| json_ok(&body)).client.issues().await,
            Err(bad)
        );
    }
    let body = json!({ "issues": [], "total_count": null });
    assert!(harness(move |_, _| json_ok(&body))
        .client
        .issues()
        .await
        .is_ok());
    // Time entry hours: `z.number().min(0)` (not nullable).
    for hours in [json!(null), json!(-0.5), json!("1")] {
        let body = json!({ "time_entries": [{ "spent_on": "2026-11-10", "hours": hours }] });
        assert_eq!(
            harness(move |_, _| json_ok(&body))
                .client
                .time_entries("2026-11-01", "2026-11-14")
                .await,
            Err(bad)
        );
    }
    // A user id must be positive; names are `string | null | absent`.
    for user in [
        json!({ "id": 0, "login": "a" }),
        json!({ "id": 7 }),
        json!({ "id": 7, "login": "a", "firstname": 3 }),
    ] {
        let body = json!({ "user": user });
        assert_eq!(
            harness(move |_, _| json_ok(&body)).client.viewer().await,
            Err(bad)
        );
    }
    // `is_default: boolean | null | absent`.
    let body = json!({ "time_entry_activities": [{ "id": 1, "name": "A", "is_default": null }] });
    assert!(
        !harness(move |_, _| json_ok(&body))
            .client
            .activities()
            .await
            .unwrap()[0]
            .is_default
    );
    let body = json!({ "time_entry_activities": [{ "id": 1, "name": "A", "is_default": "yes" }] });
    assert_eq!(
        harness(move |_, _| json_ok(&body))
            .client
            .activities()
            .await,
        Err(bad)
    );
    // Not JSON at all.
    let text = harness(|_, _| Ok(HttpResponse::new(200).with_body("<html>")));
    assert_eq!(text.client.statuses().await, Err(bad));
    // A failed status read is not cached either.
    assert_eq!(text.client.statuses().await, Err(bad));
    assert_eq!(text.calls(), 2);
}

#[tokio::test]
async fn the_key_never_shows_in_debug_output_or_errors() {
    let setup = harness(|_, _| json_status(&json!({}), 401));
    let client_debug = format!("{:?}", setup.client);
    assert!(!client_debug.contains(KEY));
    assert!(!client_debug.contains("redmine.x.com"));
    let error = setup.client.viewer().await.unwrap_err();
    for text in [format!("{error}"), format!("{error:?}")] {
        assert!(!text.contains(KEY), "{text}");
    }
    let result = setup.client.update_issue(5, status_patch(3)).await;
    assert!(!format!("{result:?}").contains(KEY));
    for request in setup.requests() {
        assert!(!format!("{request:?}").contains(KEY));
    }
    let refused_url = RedmineClient::new(
        Arc::new(Fake::new(|_, _| empty(200))),
        "http://redmine.x.com",
        KEY,
    )
    .unwrap_err();
    for text in [format!("{refused_url}"), format!("{refused_url:?}")] {
        assert!(
            !text.contains(KEY) && !text.contains("redmine.x.com"),
            "{text}"
        );
    }
}

#[tokio::test]
async fn statuses_and_activities_are_cached_per_client() {
    let respond = |request: &HttpRequest, _: usize| {
        if path(request).ends_with("/issue_statuses.json") {
            json_ok(&json!({ "issue_statuses": [{ "id": 1, "name": "New" }] }))
        } else {
            json_ok(&json!({ "time_entry_activities": [{ "id": 9, "name": "Dev" }] }))
        }
    };
    let first = harness(respond);
    first.client.statuses().await.unwrap();
    first.client.statuses().await.unwrap();
    first.client.activities().await.unwrap();
    first.client.activities().await.unwrap();
    assert_eq!(first.calls(), 2);
    // A new client (a new session) reads them again.
    let second = harness(respond);
    second.client.statuses().await.unwrap();
    second.client.activities().await.unwrap();
    assert_eq!(second.calls(), 2);
}

// --- Loopback (real transport) -------------------------------------------------------------------

fn loopback(base: &str) -> RedmineClient {
    RedmineClient::new_allowing_loopback_http(Arc::new(ReqwestTransport::new().unwrap()), base, KEY)
        .unwrap()
}

fn drain(requests: &mut tokio::sync::mpsc::UnboundedReceiver<String>) -> Vec<String> {
    let mut seen = Vec::new();
    while let Ok(request) = requests.try_recv() {
        seen.push(request);
    }
    seen
}

#[tokio::test]
async fn writes_reach_a_loopback_server_as_put_and_post() {
    let (base, mut requests) = serve(|request| {
        if request.starts_with("PUT ") {
            b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".to_vec()
        } else {
            let body = br#"{"time_entry":{"id":1}}"#;
            let mut reply = format!(
                "HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .into_bytes();
            reply.extend_from_slice(body);
            reply
        }
    })
    .await;
    let client = loopback(&base);
    let patch = IssuePatch {
        status_id: Some(3),
        estimated_hours: Some(Some(1.5)),
    };
    assert_eq!(
        client.update_issue(5, patch).await,
        RedmineWriteResult::Done
    );
    assert_eq!(client.log_time(&entry()).await, RedmineWriteResult::Done);
    let seen = drain(&mut requests);
    assert_eq!(seen.len(), 2);
    let put = seen[0].to_ascii_lowercase();
    assert!(put.starts_with("put /issues/5.json http/1.1\r\n"), "{put}");
    assert!(put.contains(&format!("x-redmine-api-key: {KEY}\r\n")));
    assert!(put.contains("accept: application/json\r\n"));
    assert!(put.contains("content-type: application/json\r\n"));
    assert!(!put.contains("authorization"));
    assert!(seen[0].ends_with(r#"{"issue":{"status_id":3,"estimated_hours":1.5}}"#));
    let post = seen[1].to_ascii_lowercase();
    assert!(
        post.starts_with("post /time_entries.json http/1.1\r\n"),
        "{post}"
    );
    assert!(seen[1].ends_with(
        r#"{"time_entry":{"issue_id":5,"spent_on":"2026-11-14","hours":1.5,"activity_id":9,"comments":"work"}}"#
    ));
}

#[tokio::test]
async fn a_loopback_redirect_is_never_followed_for_reads_or_writes() {
    let (base, mut requests) = serve(|_| {
        b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            .to_vec()
    })
    .await;
    let client = loopback(&base);
    assert_eq!(client.viewer().await, Err(ApiError::InvalidResponse));
    assert_eq!(
        client.update_issue(5, status_patch(3)).await,
        refused(RedmineWriteError::InvalidResponse)
    );
    assert_eq!(
        client.log_time(&entry()).await,
        refused(RedmineWriteError::InvalidResponse)
    );
    // One request each: the redirect was not followed.
    assert_eq!(drain(&mut requests).len(), 3);
}
