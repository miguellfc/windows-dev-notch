//! What the GitHub and GitLab clients share (`src/main/code-review/client-common.ts`): the error
//! codes, the status mapping, requests that never follow a redirect, JSON bodies, the per-item
//! pool and the snapshot built from the mapped lists.

use std::collections::HashSet;
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::task::Poll;

use chrono::{DateTime, Utc};
use serde::de::DeserializeOwned;

use super::http::{HttpRequest, HttpResponse, Transport, TransportError};
use crate::contract::code_review::{
    ContributionSummary, ReviewItem, ReviewState, LIST_LIMIT, TEXT_MAX,
};
use crate::contract::text::utf16_prefix;
use crate::ipc::BoxFuture;

/// `CodeReviewErrorCode`: the only thing a failure carries (never tokens, titles or repositories).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CodeReviewError {
    Auth,
    Network,
    RateLimited,
    Server,
    InvalidResponse,
}

impl CodeReviewError {
    /// The code as Electron spells it (logs, `failureReason`).
    pub fn code(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::Network => "network",
            Self::RateLimited => "rate-limited",
            Self::Server => "server",
            Self::InvalidResponse => "invalid-response",
        }
    }
}

impl std::fmt::Display for CodeReviewError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Code review API failed: {}", self.code())
    }
}

impl std::error::Error for CodeReviewError {}

impl From<TransportError> for CodeReviewError {
    /// A failed request is `network` (`fetch` rejected); a body over the cap cannot be a valid
    /// answer (`invalid-response`).
    fn from(error: TransportError) -> Self {
        match error {
            TransportError::Network => Self::Network,
            TransportError::BodyTooLarge => Self::InvalidResponse,
        }
    }
}

/// `ClientItem`: an item plus the URL main opens in the browser (never sent to the renderer).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClientItem {
    pub item: ReviewItem,
    pub url: String,
}

/// Review state of one own open, non-draft PR/MR (what the first-review detector observes).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnReview {
    pub id: String,
    pub review: ReviewState,
}

/// `CodeReviewSnapshot`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CodeReviewSnapshot {
    /// PR/MRs that wait for the user's review (at most `LIST_LIMIT`).
    pub to_review: Vec<ClientItem>,
    /// The user's open PR/MRs (at most `LIST_LIMIT`).
    pub mine: Vec<ClientItem>,
    /// Own open, non-draft PR/MRs without any review.
    pub unreviewed: u32,
    pub own_review: Vec<OwnReview>,
}

/// `CodeReviewClient`: one platform's API with one token.
pub trait CodeReviewClient: Send + Sync {
    /// Login (GitHub) or username (GitLab) of the token's account.
    fn viewer(&self) -> BoxFuture<'_, Result<String, CodeReviewError>>;
    fn fetch(&self) -> BoxFuture<'_, Result<CodeReviewSnapshot, CodeReviewError>>;
    /// The current month's contributions (local time of `now`).
    fn contributions(
        &self,
        now: DateTime<Utc>,
    ) -> BoxFuture<'_, Result<ContributionSummary, CodeReviewError>>;
}

/// `toReviewItem`: drops the URL, what may cross IPC to the notch.
pub fn to_review_item(item: &ClientItem) -> ReviewItem {
    item.item.clone()
}

/// `clip(text, max)`: JS `text.slice(0, max)` in UTF-16 units (a surrogate pair is never split).
pub fn clip(text: &str, max: usize) -> String {
    utf16_prefix(text, max).to_owned()
}

/// `clip(text)` with the default `CODE_REVIEW_TEXT_MAX`.
pub fn clip_text(text: &str) -> String {
    clip(text, TEXT_MAX)
}

/// `isRedirect`: any 3xx, or status 0 (an opaque redirect in Electron).
pub fn is_redirect(status: u16) -> bool {
    status == 0 || (300..400).contains(&status)
}

/// `statusError`: 401/403 are `auth` unless the 403 is a rate limit.
pub fn status_error(response: &HttpResponse) -> CodeReviewError {
    let status = response.status;
    if is_redirect(status) {
        return CodeReviewError::InvalidResponse;
    }
    if status == 429 {
        return CodeReviewError::RateLimited;
    }
    if status == 403
        && (response.header("x-ratelimit-remaining").as_deref() == Some("0")
            || response.has_header("retry-after"))
    {
        return CodeReviewError::RateLimited;
    }
    if status == 401 || status == 403 {
        return CodeReviewError::Auth;
    }
    if status >= 500 {
        return CodeReviewError::Server;
    }
    CodeReviewError::InvalidResponse
}

/// `sendRaw`: one request, never following a redirect (a 3xx is `invalid-response`); the
/// status is left to the caller. A failed request is `network`, a body over the cap
/// `invalid-response`.
pub async fn send_raw(
    transport: &dyn Transport,
    request: HttpRequest,
) -> Result<HttpResponse, CodeReviewError> {
    let response = transport.send(request).await?;
    if is_redirect(response.status) {
        return Err(CodeReviewError::InvalidResponse);
    }
    Ok(response)
}

/// `send`: [`send_raw`], then `None` for a 404 when `allow_not_found`, and [`status_error`] for
/// any other non-2xx status.
pub async fn send(
    transport: &dyn Transport,
    request: HttpRequest,
    allow_not_found: bool,
) -> Result<Option<HttpResponse>, CodeReviewError> {
    let response = send_raw(transport, request).await?;
    if allow_not_found && response.status == 404 {
        return Ok(None);
    }
    if !response.is_ok() {
        return Err(status_error(&response));
    }
    Ok(Some(response))
}

/// `sendOk`: [`send`] where a 404 is an error too.
pub async fn send_ok(
    transport: &dyn Transport,
    request: HttpRequest,
) -> Result<HttpResponse, CodeReviewError> {
    send(transport, request, false)
        .await?
        .ok_or(CodeReviewError::InvalidResponse) // unreachable without allow_not_found
}

/// `readJson`: the body as `T`; invalid JSON or a shape mismatch is `invalid-response`.
pub fn read_json<T: DeserializeOwned>(response: &HttpResponse) -> Result<T, CodeReviewError> {
    // `Response.json()`: UTF-8 decoding (invalid bytes replaced, a byte order mark skipped).
    let bytes = response
        .body
        .strip_prefix(&[0xEF, 0xBB, 0xBF])
        .unwrap_or(&response.body);
    serde_json::from_str(&String::from_utf8_lossy(bytes))
        .map_err(|_| CodeReviewError::InvalidResponse)
}

/// `mapPool`: maps `items` with at most `limit` calls of `call` in flight, keeping order; after
/// the first failure no new call starts and that error is returned.
pub async fn map_pool<'a, T, R, E, F, Fut>(
    items: &'a [T],
    limit: usize,
    call: F,
) -> Result<Vec<R>, E>
where
    F: Fn(&'a T) -> Fut,
    Fut: Future<Output = Result<R, E>>,
{
    debug_assert!(limit > 0, "map_pool needs a positive limit");
    let next = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let worker = || async {
        let mut done = Vec::new();
        while !failed.load(Ordering::SeqCst) {
            let index = next.fetch_add(1, Ordering::SeqCst);
            let Some(item) = items.get(index) else { break };
            match call(item).await {
                Ok(result) => done.push((index, result)),
                Err(error) => {
                    failed.store(true, Ordering::SeqCst);
                    return Err(error);
                }
            }
        }
        Ok(done)
    };
    let mut workers: Vec<_> = (0..limit.min(items.len()))
        .map(|_| Some(Box::pin(worker())))
        .collect();
    let mut results: Vec<Option<R>> = items.iter().map(|_| None).collect();
    // `Promise.all` over the workers: the first failure settles it. Unlike Electron, the calls
    // still in flight are dropped (cancelled) instead of finishing unobserved.
    std::future::poll_fn(|cx| {
        let mut pending = false;
        for slot in &mut workers {
            let Some(worker) = slot else { continue };
            match worker.as_mut().poll(cx) {
                Poll::Ready(Ok(done)) => {
                    for (index, result) in done {
                        results[index] = Some(result);
                    }
                    *slot = None;
                }
                Poll::Ready(Err(error)) => return Poll::Ready(Err(error)),
                Poll::Pending => pending = true,
            }
        }
        if pending {
            Poll::Pending
        } else {
            Poll::Ready(Ok(()))
        }
    })
    .await?;
    Ok(results.into_iter().flatten().collect())
}

/// `snapshot`: limits, the unreviewed count and the own review states. `uncertain` own items (a
/// per-item call failed) are left out of `own_review`.
pub fn snapshot(
    to_review: Vec<ClientItem>,
    mine: Vec<ClientItem>,
    uncertain: &HashSet<String>,
) -> CodeReviewSnapshot {
    let own: Vec<ClientItem> = mine.into_iter().take(LIST_LIMIT).collect();
    let open = || own.iter().filter(|client| !client.item.draft);
    let unreviewed = open()
        .filter(|client| client.item.review == ReviewState::None)
        .count();
    let own_review = open()
        .filter(|client| !uncertain.contains(&client.item.id))
        .map(|client| OwnReview {
            id: client.item.id.clone(),
            review: client.item.review,
        })
        .collect();
    CodeReviewSnapshot {
        to_review: to_review.into_iter().take(LIST_LIMIT).collect(),
        unreviewed: u32::try_from(unreviewed).unwrap_or(u32::MAX),
        own_review,
        mine: own,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use serde::Deserialize;
    use serde_json::json;
    use tokio::net::TcpListener;

    use super::*;
    use crate::code_review::http::test_support::{read_request, serve};
    use crate::code_review::http::{ReqwestTransport, BODY_LIMIT, REQUEST_TIMEOUT};

    const TOKEN: &str = "ghp_test_token";

    type Headers = &'static [(&'static str, &'static str)];
    type Respond = dyn Fn(&HttpRequest) -> Result<HttpResponse, TransportError> + Send + Sync;

    /// A fake transport answering with `respond(request)` and recording the requests.
    struct Fake {
        respond: Box<Respond>,
        requests: Mutex<Vec<HttpRequest>>,
    }

    impl Fake {
        fn new(
            respond: impl Fn(&HttpRequest) -> Result<HttpResponse, TransportError>
                + Send
                + Sync
                + 'static,
        ) -> Self {
            Self {
                respond: Box::new(respond),
                requests: Mutex::new(Vec::new()),
            }
        }

        fn status(status: u16, headers: &[(&str, &str)]) -> Self {
            let headers: Vec<(String, String)> = headers
                .iter()
                .map(|(name, value)| ((*name).to_owned(), (*value).to_owned()))
                .collect();
            Self::new(move |_| {
                let mut response = HttpResponse::new(status).with_body(b"{}".to_vec());
                for (name, value) in &headers {
                    response = response.with_header(name, value.clone());
                }
                Ok(response)
            })
        }

        fn calls(&self) -> usize {
            self.requests.lock().unwrap().len()
        }
    }

    impl Transport for Fake {
        fn send(
            &self,
            request: HttpRequest,
        ) -> BoxFuture<'_, Result<HttpResponse, TransportError>> {
            let result = (self.respond)(&request);
            self.requests.lock().unwrap().push(request);
            Box::pin(async move { result })
        }
    }

    fn github_request() -> HttpRequest {
        HttpRequest::post(
            "https://api.github.com/graphql",
            b"{\"query\":\"q\"}".to_vec(),
        )
        .header("authorization", format!("Bearer {TOKEN}"))
        .header("accept", "application/json")
        .header("content-type", "application/json")
    }

    fn gitlab_request() -> HttpRequest {
        HttpRequest::get("https://gitlab.x.com/base/api/v4/user")
            .header("private-token", TOKEN)
            .header("accept", "application/json")
    }

    fn expect_code<T: std::fmt::Debug>(result: Result<T, CodeReviewError>, code: CodeReviewError) {
        let error = result.expect_err("a failure");
        assert_eq!(error, code);
        // Never carries the token.
        assert!(!error.to_string().contains(TOKEN));
        assert_eq!(
            error.to_string(),
            format!("Code review API failed: {}", code.code())
        );
    }

    #[test]
    fn codes_are_spelled_as_in_electron() {
        assert_eq!(CodeReviewError::Auth.code(), "auth");
        assert_eq!(CodeReviewError::Network.code(), "network");
        assert_eq!(CodeReviewError::RateLimited.code(), "rate-limited");
        assert_eq!(CodeReviewError::Server.code(), "server");
        assert_eq!(CodeReviewError::InvalidResponse.code(), "invalid-response");
    }

    // github client: errors / maps HTTP statuses to codes (fetch).
    #[tokio::test]
    async fn github_maps_http_statuses_to_codes() {
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
            let fake = Fake::status(status, headers);
            expect_code(send_ok(&fake, github_request()).await, code);
            assert_eq!(fake.calls(), 1);
        }
    }

    // github client: contributions / maps HTTP statuses to codes.
    #[tokio::test]
    async fn github_contributions_map_http_statuses_to_codes() {
        use CodeReviewError::*;
        let cases: [(u16, Headers, CodeReviewError); 5] = [
            (401, &[], Auth),
            (403, &[], Auth),
            (403, &[("X-RateLimit-Remaining", "0")], RateLimited),
            (429, &[], RateLimited),
            (502, &[], Server),
        ];
        for (status, headers, code) in cases {
            expect_code(
                send_ok(&Fake::status(status, headers), github_request()).await,
                code,
            );
        }
    }

    #[tokio::test]
    async fn a_403_with_remaining_quota_or_other_headers_is_auth() {
        let fake = Fake::status(403, &[("x-ratelimit-remaining", "12")]);
        expect_code(
            send_ok(&fake, github_request()).await,
            CodeReviewError::Auth,
        );
        let fake = Fake::status(403, &[("Retry-After", "")]);
        expect_code(
            send_ok(&fake, github_request()).await,
            CodeReviewError::RateLimited,
        );
    }

    #[tokio::test]
    async fn other_statuses_are_invalid_response_and_2xx_pass() {
        for status in [100, 204, 299] {
            let response = send_ok(&Fake::status(status, &[]), github_request()).await;
            assert_eq!(response.is_ok(), (200..300).contains(&status), "{status}");
        }
        for status in [400, 405, 418, 499] {
            expect_code(
                send_ok(&Fake::status(status, &[]), github_request()).await,
                CodeReviewError::InvalidResponse,
            );
        }
        expect_code(
            send_ok(&Fake::status(599, &[]), github_request()).await,
            CodeReviewError::Server,
        );
    }

    // github/gitlab client: treats an opaque redirect as invalid-response.
    #[tokio::test]
    async fn an_opaque_redirect_is_invalid_response() {
        expect_code(
            send_ok(&Fake::status(0, &[]), github_request()).await,
            CodeReviewError::InvalidResponse,
        );
        expect_code(
            send_raw(&Fake::status(0, &[]), gitlab_request()).await,
            CodeReviewError::InvalidResponse,
        );
    }

    // github/gitlab client: gives network when fetch rejects.
    #[tokio::test]
    async fn a_failed_request_is_network() {
        let fake = Fake::new(|_| Err(TransportError::Network));
        expect_code(
            send_ok(&fake, github_request()).await,
            CodeReviewError::Network,
        );
        expect_code(
            send_raw(&fake, gitlab_request()).await,
            CodeReviewError::Network,
        );
    }

    #[tokio::test]
    async fn a_body_over_the_cap_is_invalid_response() {
        let fake = Fake::new(|_| Err(TransportError::BodyTooLarge));
        expect_code(
            send_ok(&fake, gitlab_request()).await,
            CodeReviewError::InvalidResponse,
        );
    }

    // gitlab client: errors / maps HTTP statuses to codes.
    #[tokio::test]
    async fn gitlab_maps_http_statuses_to_codes() {
        use CodeReviewError::*;
        for (status, code) in [
            (401, Auth),
            (403, Auth),
            (429, RateLimited),
            (500, Server),
            (503, Server),
            (404, InvalidResponse),
        ] {
            expect_code(
                send_ok(&Fake::status(status, &[]), gitlab_request()).await,
                code,
            );
        }
    }

    // gitlab client: never follows a redirect / events errors map to codes, one request each.
    #[tokio::test]
    async fn gitlab_events_errors_map_to_codes_with_one_request() {
        use CodeReviewError::*;
        let cases: [(u16, Headers, CodeReviewError); 5] = [
            (401, &[], Auth),
            (403, &[], Auth),
            (429, &[], RateLimited),
            (503, &[], Server),
            (
                302,
                &[("location", "https://evil.example/")],
                InvalidResponse,
            ),
        ];
        for (status, headers, code) in cases {
            let fake = Fake::status(status, headers);
            expect_code(send_ok(&fake, gitlab_request()).await, code);
            assert_eq!(fake.calls(), 1);
        }
    }

    #[tokio::test]
    async fn send_raw_leaves_non_redirect_statuses_to_the_caller() {
        for status in [200, 401, 403, 404, 429, 500] {
            let response = send_raw(&Fake::status(status, &[]), gitlab_request())
                .await
                .unwrap();
            assert_eq!(response.status, status);
        }
        for status in [300, 301, 302, 304, 307, 308, 399] {
            expect_code(
                send_raw(&Fake::status(status, &[]), gitlab_request()).await,
                CodeReviewError::InvalidResponse,
            );
        }
    }

    #[tokio::test]
    async fn send_allows_a_404_only_when_asked() {
        let fake = Fake::status(404, &[]);
        assert_eq!(send(&fake, gitlab_request(), true).await, Ok(None));
        expect_code(
            send(&fake, gitlab_request(), false).await,
            CodeReviewError::InvalidResponse,
        );
        expect_code(
            send(&Fake::status(302, &[]), gitlab_request(), true).await,
            CodeReviewError::InvalidResponse,
        );
        let ok = send(&Fake::status(200, &[]), gitlab_request(), true)
            .await
            .unwrap();
        assert_eq!(ok.map(|response| response.status), Some(200));
    }

    #[derive(Debug, Deserialize)]
    #[allow(dead_code, reason = "only deserialized to check the body parses")]
    struct Viewer {
        data: ViewerData,
    }

    #[derive(Debug, Deserialize)]
    #[allow(dead_code, reason = "only deserialized to check the body parses")]
    struct ViewerData {
        viewer: Login,
    }

    #[derive(Debug, Deserialize)]
    #[allow(dead_code, reason = "only deserialized to check the body parses")]
    struct Login {
        login: String,
    }

    // github/gitlab client: gives invalid-response for a malformed body or schema.
    #[test]
    fn read_json_gives_invalid_response_for_a_malformed_body_or_schema() {
        let body = |text: &str| HttpResponse::new(200).with_body(text.as_bytes().to_vec());
        expect_code(
            read_json::<Viewer>(&body("not json")),
            CodeReviewError::InvalidResponse,
        );
        expect_code(
            read_json::<Viewer>(&body("<html>")),
            CodeReviewError::InvalidResponse,
        );
        expect_code(
            read_json::<Viewer>(&body("")),
            CodeReviewError::InvalidResponse,
        );
        expect_code(
            read_json::<Viewer>(&body(r#"{"data":{"viewer":{"login":1}}}"#)),
            CodeReviewError::InvalidResponse,
        );
        let viewer =
            read_json::<Viewer>(&body(r#"{"data":{"viewer":{"login":"me","x":1}},"y":2}"#))
                .unwrap();
        assert_eq!(viewer.data.viewer.login, "me");
        // `Response.json()` decodes UTF-8 and skips a byte order mark.
        let with_bom = HttpResponse::new(200).with_body(b"\xEF\xBB\xBF{\"a\":1}".to_vec());
        assert_eq!(
            read_json::<serde_json::Value>(&with_bom).unwrap(),
            json!({ "a": 1 })
        );
    }

    #[test]
    fn clip_counts_utf16_units_and_never_splits_a_pair() {
        assert_eq!(clip("abcdef", 3), "abc");
        assert_eq!(clip("abc", 3), "abc");
        assert_eq!(clip("ab\u{1F600}cd", 3), "ab");
        assert_eq!(clip("ab\u{1F600}cd", 4), "ab\u{1F600}");
        assert_eq!(clip_text(&"t".repeat(1500)).len(), 1000);
        assert_eq!(clip_text(&"\u{1F600}".repeat(600)).chars().count(), 500);
    }

    fn item(id: &str, draft: bool, review: ReviewState) -> ClientItem {
        ClientItem {
            item: ReviewItem {
                id: id.into(),
                reference: format!("o/r#{id}"),
                title: "t".into(),
                author: "a".into(),
                updated_at: "2026-11-12T10:00:00Z".into(),
                draft,
                review,
                checks: None,
                conflicts: false,
            },
            url: format!("https://github.com/o/r/pull/{id}"),
        }
    }

    #[test]
    fn to_review_item_drops_the_url() {
        let client = item("1", false, ReviewState::None);
        let value = serde_json::to_value(to_review_item(&client)).unwrap();
        assert!(value.get("url").is_none());
        assert!(crate::contract::parse::<ReviewItem>(value).is_ok());
    }

    #[test]
    fn snapshot_limits_counts_and_leaves_uncertain_items_out() {
        let to_review: Vec<ClientItem> = (0..25)
            .map(|i| item(&format!("r{i}"), false, ReviewState::None))
            .collect();
        let mut mine = vec![
            item("a", false, ReviewState::None),
            item("b", true, ReviewState::None),
            item("c", false, ReviewState::Approved),
            item("d", false, ReviewState::None),
            item("e", false, ReviewState::Commented),
        ];
        mine.extend((0..20).map(|i| item(&format!("m{i}"), false, ReviewState::None)));
        let uncertain: HashSet<String> = ["d".to_owned(), "e".to_owned()].into();
        let result = snapshot(to_review, mine, &uncertain);
        assert_eq!(result.to_review.len(), 20);
        assert_eq!(result.mine.len(), 20);
        // a, d and m0..m14 (the first 20 own items minus the draft b and the approved c).
        assert_eq!(result.unreviewed, 17);
        let own: Vec<&str> = result
            .own_review
            .iter()
            .map(|own| own.id.as_str())
            .collect();
        assert_eq!(own[..2], ["a", "c"]);
        assert_eq!(own.len(), 17);
        assert!(!own.contains(&"b") && !own.contains(&"d") && !own.contains(&"e"));
        assert_eq!(result.own_review[1].review, ReviewState::Approved);
    }

    #[test]
    fn snapshot_without_uncertain_items_reports_every_open_one() {
        let mine = vec![
            item("a", false, ReviewState::Changes),
            item("b", true, ReviewState::Approved),
        ];
        let result = snapshot(Vec::new(), mine, &HashSet::new());
        assert_eq!(result.unreviewed, 0);
        assert_eq!(
            result.own_review,
            vec![OwnReview {
                id: "a".into(),
                review: ReviewState::Changes
            }]
        );
    }

    #[tokio::test]
    async fn map_pool_keeps_order_and_the_concurrency_limit() {
        let items: Vec<u32> = (0..10).collect();
        let in_flight = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let result: Result<Vec<u32>, CodeReviewError> = map_pool(&items, 3, |&n| {
            let in_flight = &in_flight;
            let peak = &peak;
            async move {
                let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                // Later items finish first: the order must still be the input's.
                for _ in 0..(10 - n) {
                    tokio::task::yield_now().await;
                }
                in_flight.fetch_sub(1, Ordering::SeqCst);
                Ok(n * 2)
            }
        })
        .await;
        assert_eq!(result.unwrap(), (0..10).map(|n| n * 2).collect::<Vec<_>>());
        assert_eq!(peak.load(Ordering::SeqCst), 3);
        let empty: Result<Vec<u32>, CodeReviewError> =
            map_pool(&[] as &[u32], 3, |&n| async move { Ok(n) }).await;
        assert_eq!(empty.unwrap(), Vec::<u32>::new());
    }

    #[tokio::test]
    async fn map_pool_stops_starting_calls_after_the_first_failure() {
        let items: Vec<u32> = (0..10).collect();
        let started = Mutex::new(Vec::new());
        let result: Result<Vec<u32>, CodeReviewError> = map_pool(&items, 2, |&n| {
            started.lock().unwrap().push(n);
            async move {
                tokio::task::yield_now().await;
                if n == 2 {
                    Err(CodeReviewError::Auth)
                } else {
                    Ok(n)
                }
            }
        })
        .await;
        assert_eq!(result, Err(CodeReviewError::Auth));
        let started = started.lock().unwrap().clone();
        assert!(started.len() < items.len(), "{started:?}");
        assert!(!started.contains(&5), "{started:?}");
    }

    // The real transport against loopback servers.

    #[tokio::test]
    async fn redirect_is_invalid_response_and_never_followed() {
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_addr = target.local_addr().unwrap();
        let forwarded = Arc::new(Mutex::new(Vec::<String>::new()));
        let seen_by_target = Arc::clone(&forwarded);
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = target.accept().await {
                let request = read_request(&mut stream).await;
                seen_by_target.lock().unwrap().push(request);
            }
        });
        for status in [301, 302, 303, 307, 308] {
            let location = format!("http://{target_addr}/graphql");
            let (base, mut requests) = serve(move |_| {
                format!("HTTP/1.1 {status} Moved\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                    .into_bytes()
            })
            .await;
            let transport = ReqwestTransport::new().unwrap();
            let request = HttpRequest::post(format!("{base}/graphql"), b"{}".to_vec())
                .header("authorization", format!("Bearer {TOKEN}"));
            expect_code(
                send_ok(&transport, request).await,
                CodeReviewError::InvalidResponse,
            );
            assert!(requests.recv().await.unwrap().contains(TOKEN));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        let forwarded = forwarded.lock().unwrap();
        assert!(forwarded.is_empty(), "the redirect was followed");
        assert!(!forwarded.iter().any(|request| request.contains(TOKEN)));
    }

    #[tokio::test]
    async fn body_over_16_mib_is_invalid_response() {
        let (base, _requests) = serve(|_| {
            let mut out =
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
                    .to_vec();
            let chunk = vec![b' '; 1024 * 1024];
            for _ in 0..17 {
                out.extend(format!("{:x}\r\n", chunk.len()).into_bytes());
                out.extend(&chunk);
                out.extend(b"\r\n");
            }
            out.extend(b"0\r\n\r\n");
            out
        })
        .await;
        assert_eq!(BODY_LIMIT, 16 * 1024 * 1024);
        let transport = ReqwestTransport::new().unwrap();
        expect_code(
            send_ok(&transport, HttpRequest::get(base)).await,
            CodeReviewError::InvalidResponse,
        );
    }

    #[tokio::test]
    async fn timeout_is_network_error() {
        assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(30));
        let silent = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = silent.local_addr().unwrap();
        let (_keep, hold) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let (_stream, _) = silent.accept().await.unwrap();
            let _ = hold.await;
        });
        let transport =
            ReqwestTransport::with_limits(Duration::from_millis(300), BODY_LIMIT).unwrap();
        expect_code(
            send_ok(&transport, HttpRequest::get(format!("http://{addr}/"))).await,
            CodeReviewError::Network,
        );
    }
}
