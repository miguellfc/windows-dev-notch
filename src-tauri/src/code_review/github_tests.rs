//! Port of 0.1.0's `code-review-github-client.test.ts` (31 cases), plus the exact request
//! bytes and the zod tolerances of the Rust parser. A fake [`Transport`] only: no network.

use std::sync::Mutex;

use chrono::{FixedOffset, TimeZone};
use chrono_tz::Tz;
use serde_json::{json, Value};

use super::*;
use crate::code_review::client::to_review_item;
use crate::code_review::http::{Method, TransportError};
use crate::contract::Validate;
use crate::ipc::BoxFuture;

const TOKEN: &str = "ghp_test_token";

type Header = (&'static str, &'static str);
type Headers = &'static [Header];
type Respond = dyn Fn(&Value) -> Result<HttpResponse, TransportError> + Send + Sync;

/// Answers with `respond(parsed body)` and records every request.
struct Fake {
    respond: Box<Respond>,
    requests: Mutex<Vec<HttpRequest>>,
}

impl Transport for Fake {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, TransportError>> {
        let body: Value = serde_json::from_slice(request.body.as_deref().unwrap_or_default())
            .expect("a JSON request body");
        let result = (self.respond)(&body);
        self.requests.lock().unwrap().push(request);
        Box::pin(async move { result })
    }
}

fn json_response(body: &Value) -> HttpResponse {
    HttpResponse::new(200).with_body(serde_json::to_vec(body).unwrap())
}

fn status_response(status: u16, headers: &[(&str, &str)]) -> HttpResponse {
    let mut response = HttpResponse::new(status).with_body(b"{}".to_vec());
    for (name, value) in headers {
        response = response.with_header(name, *value);
    }
    response
}

struct Setup {
    client: GithubClient,
    fake: Arc<Fake>,
}

impl Setup {
    fn requests(&self) -> Vec<HttpRequest> {
        self.fake.requests.lock().unwrap().clone()
    }

    fn body(&self, index: usize) -> String {
        String::from_utf8(self.requests()[index].body.clone().unwrap()).unwrap()
    }

    fn variables(&self, index: usize) -> Value {
        serde_json::from_str::<Value>(&self.body(index)).unwrap()["variables"].clone()
    }
}

fn setup_with(
    api_base: &str,
    respond: impl Fn(&Value) -> Result<HttpResponse, TransportError> + Send + Sync + 'static,
) -> Setup {
    let fake = Arc::new(Fake {
        respond: Box::new(respond),
        requests: Mutex::new(Vec::new()),
    });
    let client = GithubClient::new(fake.clone(), api_base, TOKEN);
    Setup { client, fake }
}

fn setup(respond: impl Fn(&Value) -> HttpResponse + Send + Sync + 'static) -> Setup {
    setup_with(GITHUB_API_BASE, move |body| Ok(respond(body)))
}

fn answer(body: Value) -> Setup {
    setup(move |_| json_response(&body))
}

fn raw(text: &'static str) -> Setup {
    setup(move |_| HttpResponse::new(200).with_body(text.as_bytes().to_vec()))
}

fn expect_code<T: std::fmt::Debug>(result: Result<T, CodeReviewError>, code: CodeReviewError) {
    let error = result.expect_err("a failure");
    assert_eq!(error, code);
    // Never carries the token.
    assert!(!error.to_string().contains(TOKEN));
}

#[derive(Default)]
struct PrOptions {
    id: Option<&'static str>,
    number: Option<i64>,
    is_draft: bool,
    review_decision: Option<&'static str>,
    total_count: Option<usize>,
    latest: Option<&'static str>,
    mergeable: Option<&'static str>,
    rollup: Option<&'static str>,
    /// `Some(Value::Null)` for a deleted author; default `{login: 'octocat'}`.
    author: Option<Value>,
    no_commits: bool,
    /// Explicit review nodes (oldest first); otherwise built from `latest` by `bob`.
    review_nodes: Option<Value>,
    /// `reviews: null` (connection not available).
    null_reviews: bool,
}

fn reviews_of(o: &PrOptions) -> Value {
    let nodes = o.review_nodes.clone().unwrap_or_else(|| match o.latest {
        Some(state) => json!([{ "state": state, "author": { "login": "bob" } }]),
        None => json!([]),
    });
    let total = o
        .total_count
        .unwrap_or_else(|| nodes.as_array().unwrap().len());
    json!({ "totalCount": total, "nodes": nodes })
}

fn pr(o: PrOptions) -> Value {
    let number = o.number.unwrap_or(1);
    let rollup = o
        .rollup
        .map_or(Value::Null, |state| json!({ "state": state }));
    json!({
        "id": o.id.unwrap_or("PR_1"),
        "number": number,
        "title": "Add feature",
        "url": format!("https://github.com/owner/repo/pull/{number}"),
        "isDraft": o.is_draft,
        "updatedAt": "2026-11-12T10:00:00Z",
        "reviewDecision": o.review_decision,
        "mergeable": o.mergeable.unwrap_or("MERGEABLE"),
        "repository": { "nameWithOwner": "owner/repo" },
        "author": o.author.clone().unwrap_or_else(|| json!({ "login": "octocat" })),
        "reviews": if o.null_reviews { Value::Null } else { reviews_of(&o) },
        "commits": { "nodes": if o.no_commits { json!([]) } else { json!([{ "commit": { "statusCheckRollup": rollup } }]) } },
    })
}

fn pr_default() -> Value {
    pr(PrOptions::default())
}

/// `counts.unreviewed`: `None` = default 0, `Some(None)` = `null`.
fn data_with(
    to_review: Vec<Value>,
    mine: Vec<Value>,
    mine_count: Option<usize>,
    unreviewed: Option<Option<u64>>,
) -> Value {
    let mine_count = mine_count.unwrap_or(mine.len());
    let unreviewed = match unreviewed {
        Some(None) => Value::Null,
        Some(Some(n)) => json!({ "issueCount": n }),
        None => json!({ "issueCount": 0 }),
    };
    json!({
        "data": {
            "viewer": { "login": "octocat" },
            "toReview": { "issueCount": to_review.len(), "nodes": to_review },
            "mine": { "issueCount": mine_count, "nodes": mine },
            "unreviewed": unreviewed,
        }
    })
}

fn data(to_review: Vec<Value>, mine: Vec<Value>) -> Value {
    data_with(to_review, mine, None, None)
}

fn ids(items: &[ClientItem]) -> Vec<&str> {
    items.iter().map(|client| client.item.id.as_str()).collect()
}

fn own(id: &str, review: ReviewState) -> crate::code_review::client::OwnReview {
    crate::code_review::client::OwnReview {
        id: id.to_owned(),
        review,
    }
}

// --- github client: request ---------------------------------------------------------------

#[tokio::test]
async fn posts_one_graphql_query_with_both_searches_the_bearer_token_and_no_redirects() {
    let s = answer(data(vec![], vec![]));
    s.client.list().await.unwrap();
    let requests = s.requests();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.url, format!("{GITHUB_API_BASE}/graphql"));
    assert_eq!(GITHUB_API_BASE, "https://api.github.com");
    assert_eq!(request.method, Method::Post);
    // `redirect: 'manual'`: the transport never follows one; a 3xx is `invalid-response` (see
    // `maps_http_statuses_to_codes`).
    assert_eq!(
        request.header_value("authorization"),
        Some(format!("Bearer {TOKEN}").as_str())
    );
    let body = s.body(0);
    assert!(body.contains("is:open is:pr review-requested:@me archived:false"));
    assert!(body.contains("is:open is:pr author:@me archived:false"));
    assert!(body.contains("is:open is:pr author:@me archived:false draft:false review:none"));
    let parsed: Value = serde_json::from_str(&body).unwrap();
    let query = parsed["query"].as_str().unwrap();
    assert!(query.contains("viewer"));
    assert!(query.contains("search(type: ISSUE"));
    assert_eq!(parsed["variables"]["first"], json!(20));
    assert!(query
        .contains("unreviewed: search(type: ISSUE, first: 0, query: $unreviewed) { issueCount }"));
    assert!(
        query.contains("mine: search(type: ISSUE, first: $first, query: $mine) { issueCount nodes")
    );
    assert!(query.contains(
        "reviews(last: 20, states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]) { totalCount nodes { state author { login } } }"
    ));
}

#[tokio::test]
async fn uses_a_custom_api_base_when_given() {
    let body = data(vec![], vec![]);
    let s = setup_with("http://127.0.0.1:4100", move |_| Ok(json_response(&body)));
    s.client.list().await.unwrap();
    assert_eq!(s.requests()[0].url, "http://127.0.0.1:4100/graphql");
}

#[tokio::test]
async fn viewer_returns_the_login() {
    let s = answer(json!({ "data": { "viewer": { "login": "octocat" } } }));
    assert_eq!(s.client.viewer().await.unwrap(), "octocat");
    assert_eq!(
        s.requests()[0].header_value("authorization"),
        Some(format!("Bearer {TOKEN}").as_str())
    );
}

// --- github client: mapping ---------------------------------------------------------------

#[tokio::test]
async fn maps_a_pr_to_an_item_with_ref_author_url_and_flags() {
    let s = answer(data(
        vec![pr(PrOptions {
            id: Some("PR_r"),
            number: Some(7),
            rollup: Some("SUCCESS"),
            mergeable: Some("CONFLICTING"),
            ..PrOptions::default()
        })],
        vec![],
    ));
    let result = s.client.list().await.unwrap();
    assert_eq!(
        result.to_review,
        vec![ClientItem {
            item: ReviewItem {
                id: "PR_r".into(),
                reference: "owner/repo#7".into(),
                title: "Add feature".into(),
                author: "octocat".into(),
                updated_at: "2026-11-12T10:00:00Z".into(),
                draft: false,
                review: ReviewState::None,
                checks: Some(Checks::Pass),
                conflicts: true,
            },
            url: "https://github.com/owner/repo/pull/7".into(),
        }]
    );
    assert!(result.mine.is_empty());
}

#[tokio::test]
async fn maps_checks_from_the_status_rollup() {
    let cases = [
        (Some("SUCCESS"), Some(Checks::Pass)),
        (Some("FAILURE"), Some(Checks::Fail)),
        (Some("ERROR"), Some(Checks::Fail)),
        (Some("PENDING"), Some(Checks::Running)),
        (Some("EXPECTED"), Some(Checks::Running)),
        (None, None),
    ];
    for (rollup, checks) in cases {
        let s = answer(data(
            vec![pr(PrOptions {
                rollup,
                ..PrOptions::default()
            })],
            vec![],
        ));
        assert_eq!(
            s.client.list().await.unwrap().to_review[0].item.checks,
            checks,
            "{rollup:?}"
        );
    }
    let s = answer(data(
        vec![pr(PrOptions {
            no_commits: true,
            ..PrOptions::default()
        })],
        vec![],
    ));
    assert_eq!(
        s.client.list().await.unwrap().to_review[0].item.checks,
        None
    );
}

#[tokio::test]
async fn maps_the_review_state_from_the_decision_and_the_latest_review() {
    let case =
        |total: usize, decision: Option<&'static str>, latest: Option<&'static str>| PrOptions {
            total_count: Some(total),
            review_decision: decision,
            latest,
            ..PrOptions::default()
        };
    let cases = [
        (case(0, None, None), ReviewState::None),
        (
            case(1, Some("APPROVED"), Some("COMMENTED")),
            ReviewState::Approved,
        ),
        (
            case(1, Some("CHANGES_REQUESTED"), Some("COMMENTED")),
            ReviewState::Changes,
        ),
        (case(1, None, Some("APPROVED")), ReviewState::Approved),
        (
            case(2, Some("REVIEW_REQUIRED"), Some("CHANGES_REQUESTED")),
            ReviewState::Changes,
        ),
        (
            case(1, Some("REVIEW_REQUIRED"), Some("COMMENTED")),
            ReviewState::Commented,
        ),
        (case(1, None, Some("DISMISSED")), ReviewState::Commented),
    ];
    for (options, review) in cases {
        let label = format!("{:?} {:?}", options.review_decision, options.latest);
        let s = answer(data(vec![], vec![pr(options)]));
        assert_eq!(
            s.client.list().await.unwrap().mine[0].item.review,
            review,
            "{label}"
        );
    }
}

#[tokio::test]
async fn counts_own_open_non_draft_prs_without_reviews_and_reports_their_review_state() {
    let mine = vec![
        pr(PrOptions {
            id: Some("a"),
            total_count: Some(0),
            ..PrOptions::default()
        }),
        pr(PrOptions {
            id: Some("b"),
            total_count: Some(0),
            is_draft: true,
            ..PrOptions::default()
        }),
        pr(PrOptions {
            id: Some("c"),
            total_count: Some(1),
            latest: Some("COMMENTED"),
            ..PrOptions::default()
        }),
        pr(PrOptions {
            id: Some("d"),
            total_count: Some(0),
            ..PrOptions::default()
        }),
    ];
    let s = answer(data(vec![], mine));
    let result = s.client.list().await.unwrap();
    assert_eq!(result.unreviewed, 2);
    assert_eq!(
        result.own_review,
        vec![
            own("a", ReviewState::None),
            own("c", ReviewState::Commented),
            own("d", ReviewState::None),
        ]
    );
    assert_eq!(ids(&result.mine), ["a", "b", "c", "d"]);
    assert!(result.mine[1].item.draft);
}

fn many(count: usize, latest: impl Fn(usize) -> Option<&'static str>) -> Vec<Value> {
    (0..count)
        .map(|i| {
            let id: &'static str = Box::leak(format!("PR_{i}").into_boxed_str());
            pr(PrOptions {
                id: Some(id),
                number: Some(i64::try_from(i).unwrap()),
                latest: latest(i),
                ..PrOptions::default()
            })
        })
        .collect()
}

#[tokio::test]
async fn keeps_at_most_20_items_per_list() {
    let prs = many(25, |_| None);
    let s = answer(data(prs.clone(), prs));
    let result = s.client.list().await.unwrap();
    assert_eq!(result.to_review.len(), 20);
    assert_eq!(result.mine.len(), 20);
    assert_eq!(result.unreviewed, 20);
}

#[tokio::test]
async fn skips_null_and_non_pr_search_nodes_and_tolerates_a_deleted_author() {
    let s = answer(data(
        vec![
            Value::Null,
            json!({}),
            pr(PrOptions {
                author: Some(Value::Null),
                ..PrOptions::default()
            }),
        ],
        vec![],
    ));
    let result = s.client.list().await.unwrap();
    assert_eq!(result.to_review.len(), 1);
    assert_eq!(result.to_review[0].item.author, "");
}

#[tokio::test]
async fn cuts_very_long_titles() {
    let mut long = pr_default();
    long["title"] = json!("x".repeat(5000));
    let s = answer(data(vec![long], vec![]));
    assert_eq!(
        s.client.list().await.unwrap().to_review[0]
            .item
            .title
            .encode_utf16()
            .count(),
        1000
    );
}

// --- github client: unreviewed count beyond the list --------------------------------------

#[tokio::test]
async fn uses_the_list_when_it_holds_every_own_pr_even_if_the_search_disagrees() {
    let mine = vec![
        pr(PrOptions {
            id: Some("a"),
            ..PrOptions::default()
        }),
        pr(PrOptions {
            id: Some("b"),
            latest: Some("APPROVED"),
            ..PrOptions::default()
        }),
    ];
    let s = answer(data_with(vec![], mine, None, Some(Some(0))));
    assert_eq!(s.client.list().await.unwrap().unreviewed, 1);
}

#[tokio::test]
async fn uses_the_review_none_search_count_when_the_list_is_cut_at_20() {
    let prs = many(20, |i| (i < 15).then_some("APPROVED"));
    let s = answer(data_with(vec![], prs, Some(40), Some(Some(27))));
    assert_eq!(s.client.list().await.unwrap().unreviewed, 27);
}

#[tokio::test]
async fn never_reports_fewer_than_the_list_shows_and_caps_at_100() {
    let prs = many(20, |_| None);
    let unreviewed = |mine: usize, searched: Option<u64>| {
        answer(data_with(vec![], prs.clone(), Some(mine), Some(searched)))
    };
    assert_eq!(
        unreviewed(40, Some(3))
            .client
            .list()
            .await
            .unwrap()
            .unreviewed,
        20
    );
    assert_eq!(
        unreviewed(400, Some(350))
            .client
            .list()
            .await
            .unwrap()
            .unreviewed,
        100
    );
    assert_eq!(
        unreviewed(40, None).client.list().await.unwrap().unreviewed,
        20
    );
}

// --- github client: tolerant reviews ------------------------------------------------------

#[tokio::test]
async fn treats_a_null_reviews_connection_as_no_review_without_failing() {
    let s = answer(data(
        vec![],
        vec![pr(PrOptions {
            id: Some("a"),
            null_reviews: true,
            ..PrOptions::default()
        })],
    ));
    let result = s.client.list().await.unwrap();
    assert_eq!(result.mine[0].item.review, ReviewState::None);
    assert_eq!(result.unreviewed, 1);
}

#[tokio::test]
async fn ignores_the_pr_authors_own_reviews_self_review_never_counts_nor_alerts() {
    let own_review = json!({ "state": "COMMENTED", "author": { "login": "octocat" } });
    let s = answer(data(
        vec![],
        vec![
            pr(PrOptions {
                id: Some("a"),
                review_nodes: Some(json!([own_review])),
                ..PrOptions::default()
            }),
            pr(PrOptions {
                id: Some("b"),
                review_nodes: Some(json!([
                    { "state": "APPROVED", "author": { "login": "bob" } },
                    own_review,
                ])),
                ..PrOptions::default()
            }),
            pr(PrOptions {
                id: Some("c"),
                review_nodes: Some(json!([{ "state": "COMMENTED", "author": null }])),
                ..PrOptions::default()
            }),
        ],
    ));
    let result = s.client.list().await.unwrap();
    assert_eq!(
        result.own_review,
        vec![
            own("a", ReviewState::None),
            own("b", ReviewState::Approved),
            own("c", ReviewState::Commented),
        ]
    );
    assert_eq!(result.unreviewed, 1);
}

// --- github client: errors ----------------------------------------------------------------

#[tokio::test]
async fn uses_the_data_of_a_200_response_that_also_has_errors() {
    let mut body = data(vec![pr_default()], vec![]);
    body["errors"] = json!([{ "message": "Some repo not accessible" }]);
    let s = answer(body);
    assert_eq!(s.client.list().await.unwrap().to_review.len(), 1);
}

#[tokio::test]
async fn gives_invalid_response_for_errors_without_data() {
    let s = answer(json!({ "errors": [{ "message": "Bad query" }] }));
    expect_code(s.client.list().await, CodeReviewError::InvalidResponse);
}

#[tokio::test]
async fn gives_rate_limited_for_a_rate_limited_graphql_error_without_data() {
    let s =
        answer(json!({ "data": null, "errors": [{ "type": "RATE_LIMITED", "message": "limit" }] }));
    expect_code(s.client.list().await, CodeReviewError::RateLimited);
}

#[tokio::test]
async fn gives_invalid_response_for_a_malformed_body_or_schema() {
    expect_code(
        raw("not json").client.list().await,
        CodeReviewError::InvalidResponse,
    );
    expect_code(
        answer(json!({ "data": { "viewer": { "login": 1 } } }))
            .client
            .viewer()
            .await,
        CodeReviewError::InvalidResponse,
    );
    let mut bad = pr_default();
    bad["isDraft"] = json!("no");
    expect_code(
        answer(data(vec![bad], vec![])).client.list().await,
        CodeReviewError::InvalidResponse,
    );
}

#[tokio::test]
async fn maps_http_statuses_to_codes() {
    use CodeReviewError::*;
    let cases: [(u16, CodeReviewError, Headers); 9] = [
        (401, Auth, &[]),
        (403, Auth, &[]),
        (403, RateLimited, &[("x-ratelimit-remaining", "0")]),
        (403, RateLimited, &[("retry-after", "60")]),
        (429, RateLimited, &[]),
        (500, Server, &[]),
        (502, Server, &[]),
        (404, InvalidResponse, &[]),
        (
            301,
            InvalidResponse,
            &[("location", "https://evil.example/graphql")],
        ),
    ];
    for (status, code, headers) in cases {
        let headers: Vec<(String, String)> = headers
            .iter()
            .map(|(n, v)| ((*n).to_owned(), (*v).to_owned()))
            .collect();
        let s = setup(move |_| {
            let pairs: Vec<(&str, &str)> = headers
                .iter()
                .map(|(n, v)| (n.as_str(), v.as_str()))
                .collect();
            status_response(status, &pairs)
        });
        expect_code(s.client.list().await, code);
        // A redirect is never followed: one request only.
        assert_eq!(s.requests().len(), 1);
    }
}

#[tokio::test]
async fn treats_an_opaque_redirect_as_invalid_response() {
    let s = setup(|_| HttpResponse::new(0));
    expect_code(s.client.list().await, CodeReviewError::InvalidResponse);
}

#[tokio::test]
async fn gives_network_when_fetch_rejects() {
    let s = setup_with(GITHUB_API_BASE, |_| Err(TransportError::Network));
    expect_code(s.client.list().await, CodeReviewError::Network);
}

// --- toReviewItem -------------------------------------------------------------------------

#[tokio::test]
async fn to_review_item_drops_the_url_so_the_item_fits_the_strict_ipc_schema() {
    let s = answer(data(vec![pr_default()], vec![]));
    let result = s.client.list().await.unwrap();
    let item = to_review_item(&result.to_review[0]);
    item.validate().unwrap();
    let wire = serde_json::to_value(&item).unwrap();
    assert!(wire.get("url").is_none());
    let back: ReviewItem = serde_json::from_value(wire).unwrap();
    assert_eq!(back, item);
}

// --- github client: contributions ---------------------------------------------------------

const MADRID: Tz = chrono_tz::Europe::Madrid;

fn local(tz: Tz, y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<FixedOffset> {
    tz.with_ymd_and_hms(y, m, d, h, min, 0)
        .unwrap()
        .fixed_offset()
}

/// The range the contributions helpers derive from `now` in `tz`; `monday` is the day of the
/// month the week must start on (a check of the derivation).
fn range(tz: Tz, now: (i32, u32, u32, u32, u32), monday: u32) -> ContributionRange<Tz> {
    let (y, m, d, h, min) = now;
    let range = ContributionRange::at(&tz.with_ymd_and_hms(y, m, d, h, min, 0).unwrap());
    assert_eq!(range.now(), local(tz, y, m, d, h, min).with_timezone(&Utc));
    assert_eq!(range.month(), local(tz, y, m, 1, 0, 0));
    assert_eq!(range.week(), local(tz, y, m, monday, 0, 0));
    assert_eq!(range.today(), local(tz, y, m, d, 0, 0));
    range
}

/// Friday 13 Nov 2026, 10:30 in Europe/Madrid (CET = UTC+1).
fn now_range() -> ContributionRange<Tz> {
    range(MADRID, (2026, 11, 13, 10, 30), 9)
}

fn collection(commits: u64, prs: u64, reviews: u64, restricted: u64) -> Value {
    json!({
        "totalCommitContributions": commits,
        "totalPullRequestContributions": prs,
        "totalPullRequestReviewContributions": reviews,
        "restrictedContributionsCount": restricted,
    })
}

fn contributions_data(restricted: u64, merged: [Option<u64>; 3], errors: Option<Value>) -> Value {
    let days = |list: &[(&str, u64)]| -> Value {
        list.iter()
            .map(|(date, n)| json!({ "date": date, "contributionCount": n }))
            .collect()
    };
    let mut month = collection(9, 3, 6, restricted);
    month["contributionCalendar"] = json!({
        "weeks": [
            { "contributionDays": days(&[("2026-11-01", 2), ("2026-11-02", 0), ("2026-11-09", 5)]) },
            { "contributionDays": days(&[("2026-11-12", 1), ("2026-11-13", 3)]) },
        ]
    });
    let search = |n: Option<u64>| n.map_or(Value::Null, |n| json!({ "issueCount": n }));
    let mut body = json!({
        "data": {
            "viewer": {
                "month": month,
                "week": collection(7, 2, 4, 0),
                "today": collection(3, 1, 2, 0),
            },
            "mergedMonth": search(merged[0]),
            "mergedWeek": search(merged[1]),
            "mergedToday": search(merged[2]),
        }
    });
    if let Some(errors) = errors {
        body["errors"] = errors;
    }
    body
}

fn default_contributions() -> Value {
    contributions_data(0, [Some(4), Some(2), Some(1)], None)
}

#[tokio::test]
async fn contributions_post_one_query_with_the_three_collections_and_three_merged_searches() {
    let s = answer(default_contributions());
    s.client.contributions(&now_range()).await.unwrap();
    let requests = s.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].url, format!("{GITHUB_API_BASE}/graphql"));
    assert_eq!(
        requests[0].header_value("authorization"),
        Some(format!("Bearer {TOKEN}").as_str())
    );
    let parsed: Value = serde_json::from_str(&s.body(0)).unwrap();
    let query = parsed["query"].as_str().unwrap();
    assert!(query.contains("month: contributionsCollection(from: $monthFrom, to: $to)"));
    assert!(query.contains("week: contributionsCollection(from: $weekFrom, to: $to)"));
    assert!(query.contains("today: contributionsCollection(from: $todayFrom, to: $to)"));
    assert!(query.contains(
        "contributionCalendar { weeks { contributionDays { date contributionCount } } }"
    ));
    assert!(query.contains(
        "mergedMonth: search(type: ISSUE, first: 0, query: $mergedMonth) { issueCount }"
    ));
    assert_eq!(
        parsed["variables"],
        json!({
            "monthFrom": "2026-10-31T23:00:00.000Z",
            "weekFrom": "2026-11-08T23:00:00.000Z",
            "todayFrom": "2026-11-12T23:00:00.000Z",
            "to": "2026-11-13T09:30:00.000Z",
            "mergedMonth": "is:pr author:@me is:merged merged:>=2026-11-01T00:00:00+01:00",
            "mergedWeek": "is:pr author:@me is:merged merged:>=2026-11-09T00:00:00+01:00",
            "mergedToday": "is:pr author:@me is:merged merged:>=2026-11-13T00:00:00+01:00",
        })
    );
}

#[tokio::test]
async fn contributions_never_send_an_empty_today_range_now_exactly_at_local_midnight() {
    let s = answer(default_contributions());
    s.client
        .contributions(&range(MADRID, (2026, 11, 13, 0, 0), 9))
        .await
        .unwrap();
    let variables = s.variables(0);
    assert_eq!(variables["todayFrom"], "2026-11-12T23:00:00.000Z");
    assert_eq!(variables["to"], "2026-11-12T23:00:01.000Z");
}

#[tokio::test]
async fn merged_searches_use_the_local_start_with_its_offset_summer_time_too() {
    let s = answer(default_contributions());
    s.client
        .contributions(&range(MADRID, (2026, 7, 15, 12, 0), 13))
        .await
        .unwrap();
    assert_eq!(
        s.variables(0)["mergedToday"],
        "is:pr author:@me is:merged merged:>=2026-07-15T00:00:00+02:00"
    );
}

/// The grid, levels, `future` flags and `updatedAt` of this TS case belong to `summarize`
/// (contributions helpers); the client's part is the counts by date and the totals.
#[tokio::test]
async fn contributions_map_the_calendar_and_the_totals() {
    let s = answer(default_contributions());
    let c = s.client.contributions(&now_range()).await.unwrap();
    let expected: HashMap<String, u64> = [
        ("2026-11-01", 2),
        ("2026-11-02", 0),
        ("2026-11-09", 5),
        ("2026-11-12", 1),
        ("2026-11-13", 3),
    ]
    .into_iter()
    .map(|(date, n)| (date.to_owned(), n))
    .collect();
    assert_eq!(c.counts, expected);
    assert_eq!(c.counts.values().sum::<u64>(), 11); // monthTotal
    assert_eq!(c.counts.values().filter(|&&n| n > 0).count(), 4); // activeDays
    let totals = |commits, opened, merged, reviews| ContributionTotals {
        commits,
        opened,
        merged,
        reviews,
    };
    assert_eq!(c.today, totals(3, 1, 1, 2));
    assert_eq!(c.week, totals(7, 2, 2, 4));
    assert_eq!(c.month_totals, totals(9, 3, 4, 6));
    assert!(!c.restricted);
}

#[tokio::test]
async fn contributions_flag_restricted_private_contributions() {
    let s = answer(contributions_data(2, [Some(4), Some(2), Some(1)], None));
    assert!(
        s.client
            .contributions(&now_range())
            .await
            .unwrap()
            .restricted
    );
}

#[tokio::test]
async fn contributions_use_the_data_of_a_200_with_errors_a_failed_merged_search_counts_0() {
    let s = answer(contributions_data(
        0,
        [None, Some(2), None],
        Some(json!([{ "type": "FORBIDDEN", "path": ["mergedMonth"] }])),
    ));
    let c = s.client.contributions(&now_range()).await.unwrap();
    assert_eq!(c.month_totals.merged, 0);
    assert_eq!(c.week.merged, 2);
    assert_eq!(c.counts.values().sum::<u64>(), 11);
}

#[tokio::test]
async fn contributions_errors_without_data_rate_limited_or_invalid_response() {
    let range = now_range();
    expect_code(
        answer(json!({ "errors": [{ "type": "RATE_LIMITED" }] }))
            .client
            .contributions(&range)
            .await,
        CodeReviewError::RateLimited,
    );
    expect_code(
        answer(json!({ "data": null, "errors": [{ "type": "X" }] }))
            .client
            .contributions(&range)
            .await,
        CodeReviewError::InvalidResponse,
    );
    expect_code(
        answer(json!({ "data": { "viewer": { "month": {} } } }))
            .client
            .contributions(&range)
            .await,
        CodeReviewError::InvalidResponse,
    );
}

#[tokio::test]
async fn contributions_map_http_statuses_to_codes() {
    use CodeReviewError::*;
    let cases: [(u16, Option<Header>, CodeReviewError); 5] = [
        (401, None, Auth),
        (403, None, Auth),
        (403, Some(("x-ratelimit-remaining", "0")), RateLimited),
        (429, None, RateLimited),
        (502, None, Server),
    ];
    for (status, header, code) in cases {
        let s = setup(move |_| status_response(status, header.as_slice()));
        expect_code(s.client.contributions(&now_range()).await, code);
    }
}

// --- Rust-only: exact bytes, headers and zod tolerances -----------------------------------

/// Bodies captured from the TS client (`JSON.stringify`) with `now` = 13 Nov 2026 10:30 in
/// America/New_York, where the month starts in summer time (-04:00) and the week in winter time.
#[tokio::test]
async fn request_bodies_match_electron_byte_for_byte() {
    let s = answer(json!({ "data": { "viewer": { "login": "octocat" } } }));
    s.client.viewer().await.unwrap();
    assert_eq!(
        s.body(0),
        r#"{"query":"query Viewer { viewer { login } }"}"#
    );

    let s = answer(data(vec![], vec![]));
    s.client.list().await.unwrap();
    assert_eq!(
        s.body(0),
        r#"{"query":"query CodeReview($toReview: String!, $mine: String!, $unreviewed: String!, $first: Int!) {\n  viewer { login }\n  toReview: search(type: ISSUE, first: $first, query: $toReview) { nodes { ...pr } }\n  mine: search(type: ISSUE, first: $first, query: $mine) { issueCount nodes { ...pr } }\n  unreviewed: search(type: ISSUE, first: 0, query: $unreviewed) { issueCount }\n}\nfragment pr on PullRequest {\n  id\n  number\n  title\n  url\n  isDraft\n  updatedAt\n  reviewDecision\n  mergeable\n  repository { nameWithOwner }\n  author { login }\n  reviews(last: 20, states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]) { totalCount nodes { state author { login } } }\n  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }\n}","variables":{"toReview":"is:open is:pr review-requested:@me archived:false","mine":"is:open is:pr author:@me archived:false","unreviewed":"is:open is:pr author:@me archived:false draft:false review:none","first":20}}"#
    );

    let s = answer(default_contributions());
    s.client
        .contributions(&range(
            chrono_tz::America::New_York,
            (2026, 11, 13, 10, 30),
            9,
        ))
        .await
        .unwrap();
    assert_eq!(
        s.body(0),
        r#"{"query":"query Contributions($monthFrom: DateTime!, $weekFrom: DateTime!, $todayFrom: DateTime!, $to: DateTime!, $mergedMonth: String!, $mergedWeek: String!, $mergedToday: String!) {\n  viewer {\n    month: contributionsCollection(from: $monthFrom, to: $to) { contributionCalendar { weeks { contributionDays { date contributionCount } } } totalCommitContributions totalPullRequestContributions totalPullRequestReviewContributions restrictedContributionsCount }\n    week: contributionsCollection(from: $weekFrom, to: $to) { totalCommitContributions totalPullRequestContributions totalPullRequestReviewContributions restrictedContributionsCount }\n    today: contributionsCollection(from: $todayFrom, to: $to) { totalCommitContributions totalPullRequestContributions totalPullRequestReviewContributions restrictedContributionsCount }\n  }\n  mergedMonth: search(type: ISSUE, first: 0, query: $mergedMonth) { issueCount }\n  mergedWeek: search(type: ISSUE, first: 0, query: $mergedWeek) { issueCount }\n  mergedToday: search(type: ISSUE, first: 0, query: $mergedToday) { issueCount }\n}","variables":{"monthFrom":"2026-11-01T04:00:00.000Z","weekFrom":"2026-11-09T05:00:00.000Z","todayFrom":"2026-11-13T05:00:00.000Z","to":"2026-11-13T15:30:00.000Z","mergedMonth":"is:pr author:@me is:merged merged:>=2026-11-01T00:00:00-04:00","mergedWeek":"is:pr author:@me is:merged merged:>=2026-11-09T00:00:00-05:00","mergedToday":"is:pr author:@me is:merged merged:>=2026-11-13T00:00:00-05:00"}}"#
    );
}

#[tokio::test]
async fn sends_exactly_the_github_headers() {
    let s = answer(json!({ "data": { "viewer": { "login": "octocat" } } }));
    s.client.viewer().await.unwrap();
    let request = &s.requests()[0];
    assert_eq!(
        request.headers,
        vec![
            ("authorization".to_owned(), format!("Bearer {TOKEN}")),
            ("accept".to_owned(), "application/json".to_owned()),
            ("content-type".to_owned(), "application/json".to_owned()),
        ]
    );
    assert_eq!(request.header_value("private-token"), None);
    assert!(!format!("{:?}", s.client).contains(TOKEN));
    assert!(!format!("{request:?}").contains(TOKEN));
}

#[tokio::test]
async fn accepts_integral_floats_where_zod_int_does_and_rejects_the_rest() {
    let mut node = pr_default();
    node["number"] = json!(12.0);
    let mut body = data_with(vec![], vec![node], None, None);
    body["data"]["mine"]["issueCount"] = json!(1e0);
    let s = answer(body);
    assert_eq!(
        s.client.list().await.unwrap().mine[0].item.reference,
        "owner/repo#12"
    );
    for bad in [json!(1.5), json!(9_007_199_254_740_992_u64), json!("1")] {
        let mut node = pr_default();
        node["number"] = bad;
        expect_code(
            answer(data(vec![node], vec![])).client.list().await,
            CodeReviewError::InvalidResponse,
        );
    }
    // `int().min(0)` counts: a negative count fails.
    let mut body = data(vec![], vec![]);
    body["data"]["unreviewed"]["issueCount"] = json!(-1);
    expect_code(
        answer(body).client.list().await,
        CodeReviewError::InvalidResponse,
    );
}

#[tokio::test]
async fn keeps_the_last_of_duplicate_keys_as_json_parse_does() {
    let s = raw(r#"{"data":{"viewer":{"login":1},"viewer":{"login":"octocat"}}}"#);
    assert_eq!(s.client.viewer().await.unwrap(), "octocat");
}

#[tokio::test]
async fn zod_shape_rules_for_nodes_and_optional_fields() {
    // A node with an `id` that fails the schema is invalid; a non-object node fails the search.
    for node in [
        json!({ "id": null }),
        json!({ "id": "" }),
        json!([1]),
        json!("PR"),
    ] {
        expect_code(
            answer(data(vec![node], vec![])).client.list().await,
            CodeReviewError::InvalidResponse,
        );
    }
    // Nodes past the 20th item are never validated.
    let mut prs = many(20, |_| None);
    prs.push(json!({ "id": "broken" }));
    assert_eq!(
        answer(data(prs, vec![]))
            .client
            .list()
            .await
            .unwrap()
            .to_review
            .len(),
        20
    );
    // `commits` is optional but not nullable; `reviews` is both.
    let mut node = pr_default();
    node["commits"] = Value::Null;
    expect_code(
        answer(data(vec![node], vec![])).client.list().await,
        CodeReviewError::InvalidResponse,
    );
    let mut node = pr_default();
    node.as_object_mut().unwrap().remove("commits");
    node.as_object_mut().unwrap().remove("reviews");
    node.as_object_mut().unwrap().remove("author");
    let result = answer(data(vec![], vec![node]))
        .client
        .list()
        .await
        .unwrap();
    assert_eq!(result.mine[0].item.checks, None);
    assert_eq!(result.mine[0].item.author, "");
    // Malformed `errors` fail the whole response, even with data.
    let mut body = data(vec![], vec![]);
    body["errors"] = json!([{ "type": 1 }]);
    expect_code(
        answer(body).client.list().await,
        CodeReviewError::InvalidResponse,
    );
    // A missing `unreviewed` search is allowed; a cut list then keeps the list count.
    let mut body = data_with(vec![], many(20, |_| None), Some(40), None);
    body["data"]
        .as_object_mut()
        .unwrap()
        .shift_remove("unreviewed");
    assert_eq!(answer(body).client.list().await.unwrap().unreviewed, 20);
}

#[tokio::test]
async fn contributions_sum_duplicate_calendar_dates() {
    let mut body = default_contributions();
    body["data"]["viewer"]["month"]["contributionCalendar"]["weeks"][1]["contributionDays"]
        .as_array_mut()
        .unwrap()
        .push(json!({ "date": "2026-11-13", "contributionCount": 4 }));
    let c = answer(body)
        .client
        .contributions(&now_range())
        .await
        .unwrap();
    assert_eq!(c.counts["2026-11-13"], 7);
}

// --- contributions(now): range helpers + summarize (carried from the TS client cases) -------

/// Friday 13 Nov 2026, 10:30 in Europe/Madrid.
fn now_madrid() -> DateTime<Tz> {
    MADRID.with_ymd_and_hms(2026, 11, 13, 10, 30, 0).unwrap()
}

fn day<'a>(
    summary: &'a ContributionSummary,
    date: &str,
) -> &'a crate::contract::code_review::ContributionDay {
    summary
        .weeks
        .iter()
        .flatten()
        .find(|day| day.date == date)
        .unwrap_or_else(|| panic!("{date} in the grid"))
}

// github client: contributions / maps the calendar into the month grid and the totals.
#[tokio::test]
async fn contribution_summary_maps_the_calendar_into_the_month_grid_and_the_totals() {
    let s = answer(default_contributions());
    let summary = s.client.contribution_summary(&now_madrid()).await.unwrap();
    // contributionSummarySchema.parse(s) round-trips.
    let wire = serde_json::to_value(&summary).unwrap();
    assert_eq!(
        crate::contract::parse::<ContributionSummary>(wire).unwrap(),
        summary
    );
    assert_eq!(summary.month, "2026-11");
    assert_eq!(summary.weeks.len(), 6);
    let d9 = day(&summary, "2026-11-09");
    assert_eq!(
        (d9.count, d9.level, d9.in_month, d9.future),
        (5, 4, true, false)
    );
    let d13 = day(&summary, "2026-11-13");
    assert_eq!((d13.count, d13.future), (3, false));
    let d14 = day(&summary, "2026-11-14");
    assert_eq!((d14.count, d14.future), (0, true));
    assert_eq!(summary.month_total, 11);
    assert_eq!(summary.active_days, 4);
    let totals = |commits, opened, merged, reviews| ContributionTotals {
        commits,
        opened,
        merged,
        reviews,
    };
    assert_eq!(summary.today, totals(3, 1, 1, 2));
    assert_eq!(summary.week, totals(7, 2, 2, 4));
    assert_eq!(summary.month_totals, totals(9, 3, 4, 6));
    assert!(!summary.partial);
    assert!(!summary.restricted);
    assert_eq!(summary.updated_at, "2026-11-13T09:30:00.000Z");
}

// github client: contributions / flags restricted private contributions (summary).
#[tokio::test]
async fn contribution_summary_flags_restricted_private_contributions() {
    let s = answer(contributions_data(2, [Some(4), Some(2), Some(1)], None));
    let summary = s.client.contribution_summary(&now_madrid()).await.unwrap();
    assert!(summary.restricted);
    assert!(!summary.partial);
}

// github client: contributions / uses the data of a 200 with errors (summary).
#[tokio::test]
async fn contribution_summary_uses_the_data_of_a_200_with_errors() {
    let s = answer(contributions_data(
        0,
        [None, Some(2), None],
        Some(json!([{ "type": "FORBIDDEN", "path": ["mergedMonth"] }])),
    ));
    let summary = s.client.contribution_summary(&now_madrid()).await.unwrap();
    assert_eq!(summary.month_total, 11);
    assert_eq!(summary.month_totals.merged, 0);
    assert_eq!(summary.week.merged, 2);
}

/// The range comes from `now` alone (no hand-built starts): the instants, `to` and the merged
/// searches with their offsets.
#[tokio::test]
async fn contribution_summary_derives_the_range_from_now() {
    let s = answer(default_contributions());
    s.client.contribution_summary(&now_madrid()).await.unwrap();
    let variables = s.variables(0);
    assert_eq!(variables["monthFrom"], "2026-10-31T23:00:00.000Z");
    assert_eq!(variables["weekFrom"], "2026-11-08T23:00:00.000Z");
    assert_eq!(variables["todayFrom"], "2026-11-12T23:00:00.000Z");
    assert_eq!(variables["to"], "2026-11-13T09:30:00.000Z");
    for key in ["mergedMonth", "mergedWeek", "mergedToday"] {
        assert!(
            variables[key]
                .as_str()
                .unwrap()
                .ends_with("T00:00:00+01:00"),
            "{key}"
        );
    }

    // Exactly at local midnight: never an empty "today" range.
    let s = answer(default_contributions());
    let midnight = MADRID.with_ymd_and_hms(2026, 11, 13, 0, 0, 0).unwrap();
    s.client.contribution_summary(&midnight).await.unwrap();
    assert_eq!(s.variables(0)["todayFrom"], "2026-11-12T23:00:00.000Z");
    assert_eq!(s.variables(0)["to"], "2026-11-12T23:00:01.000Z");

    // Summer time.
    let s = answer(default_contributions());
    let july = MADRID.with_ymd_and_hms(2026, 7, 15, 12, 0, 0).unwrap();
    s.client.contribution_summary(&july).await.unwrap();
    assert_eq!(
        s.variables(0)["mergedToday"],
        "is:pr author:@me is:merged merged:>=2026-07-15T00:00:00+02:00"
    );
}

/// The `CodeReviewClient` glue: `viewer`, `fetch` = `list`, `contributions(now)` = range +
/// summarize in the machine's local time zone.
#[tokio::test]
async fn implements_code_review_client() {
    let s = setup(|body| {
        let query = body["query"].as_str().unwrap();
        if query.starts_with("query Viewer") {
            json_response(&json!({ "data": { "viewer": { "login": "octocat" } } }))
        } else if query.starts_with("query CodeReview") {
            json_response(&data(vec![], vec![pr_default()]))
        } else {
            json_response(&default_contributions())
        }
    });
    let client: &dyn CodeReviewClient = &s.client;
    assert_eq!(client.viewer().await.unwrap(), "octocat");
    let snapshot = client.fetch().await.unwrap();
    assert_eq!(snapshot, s.client.list().await.unwrap());
    let now = MADRID
        .with_ymd_and_hms(2026, 11, 13, 10, 30, 0)
        .unwrap()
        .with_timezone(&Utc);
    let summary = client.contributions(now).await.unwrap();
    summary.validate().unwrap();
    let local = now.with_timezone(&Local);
    assert_eq!(summary.month, local.format("%Y-%m").to_string());
    assert_eq!(summary.updated_at, "2026-11-13T09:30:00.000Z");
    assert_eq!(summary.month_totals.commits, 9);
    assert!(!summary.partial);
}
