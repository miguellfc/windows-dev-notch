//! Port of `tests/unit/main/gmail-client.test.ts` (28 cases), plus `iso_date` against JS `Date`,
//! `encodeURIComponent`, token-access errors passing through, the body cap, masked `Debug`, and a
//! DELETE and a redirect against a loopback server. A fake [`Transport`] or loopback only: never
//! Google.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine as _;
use serde_json::{json, Value};
use url::Url;

use super::*;
use crate::contract::gmail::GmailLink;
use crate::http::transport::test_support::serve;
use crate::http::{HttpRequest, HttpResponse, Method, ReqwestTransport, TransportError};

const API: &str = "https://gmail.test";

type Reply = Result<HttpResponse, TransportError>;
type Respond = dyn Fn(&HttpRequest, usize) -> Reply + Send + Sync;
type Delay = dyn Fn(&HttpRequest) -> Duration + Send + Sync;

/// Answers with `respond(request, index)` after `delay(request)` and records every request.
struct Fake {
    respond: Box<Respond>,
    delay: Box<Delay>,
    requests: Mutex<Vec<HttpRequest>>,
}

impl Transport for Fake {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Reply> {
        let index = {
            let mut requests = self.requests.lock().unwrap();
            requests.push(request.clone());
            requests.len() - 1
        };
        let result = (self.respond)(&request, index);
        let delay = (self.delay)(&request);
        Box::pin(async move {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            result
        })
    }
}

type Refresh = dyn Fn(&Access) -> Result<bool, GmailError> + Send + Sync;

/// `getAccessToken` / `onUnauthorized` of the TS `setup`: the token starts as `AT1`; by default
/// a refresh switches it to `AT2` and resolves `true`.
struct Access {
    token: Mutex<Result<String, GmailError>>,
    unauthorized: AtomicUsize,
    refresh: Box<Refresh>,
}

impl Access {
    fn new() -> Self {
        Self::refreshing(|access| {
            *access.token.lock().unwrap() = Ok("AT2".into());
            Ok(true)
        })
    }

    fn refreshing(
        refresh: impl Fn(&Access) -> Result<bool, GmailError> + Send + Sync + 'static,
    ) -> Self {
        Self {
            token: Mutex::new(Ok("AT1".into())),
            unauthorized: AtomicUsize::new(0),
            refresh: Box::new(refresh),
        }
    }

    fn unauthorized_calls(&self) -> usize {
        self.unauthorized.load(Ordering::SeqCst)
    }
}

impl TokenAccess for Access {
    fn access_token(&self) -> BoxFuture<'_, Result<String, GmailError>> {
        let token = self.token.lock().unwrap().clone();
        Box::pin(async move { token })
    }

    fn on_unauthorized(&self) -> BoxFuture<'_, Result<bool, GmailError>> {
        self.unauthorized.fetch_add(1, Ordering::SeqCst);
        let result = (self.refresh)(self);
        Box::pin(async move { result })
    }
}

struct Setup {
    client: GmailClient,
    fake: Arc<Fake>,
    access: Arc<Access>,
}

impl Setup {
    fn requests(&self) -> Vec<HttpRequest> {
        self.fake.requests.lock().unwrap().clone()
    }

    fn calls(&self) -> usize {
        self.fake.requests.lock().unwrap().len()
    }
}

fn build(
    respond: impl Fn(&HttpRequest, usize) -> Reply + Send + Sync + 'static,
    delay: impl Fn(&HttpRequest) -> Duration + Send + Sync + 'static,
    access: Access,
) -> Setup {
    let fake = Arc::new(Fake {
        respond: Box::new(respond),
        delay: Box::new(delay),
        requests: Mutex::new(Vec::new()),
    });
    let access = Arc::new(access);
    let client = GmailClient::new(fake.clone(), API, access.clone());
    Setup {
        client,
        fake,
        access,
    }
}

fn setup(respond: impl Fn(&HttpRequest, usize) -> Reply + Send + Sync + 'static) -> Setup {
    build(respond, |_| Duration::ZERO, Access::new())
}

fn setup_with(
    respond: impl Fn(&HttpRequest, usize) -> Reply + Send + Sync + 'static,
    access: Access,
) -> Setup {
    build(respond, |_| Duration::ZERO, access)
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

fn path(request: &HttpRequest) -> String {
    url_of(request).path().to_owned()
}

fn param(request: &HttpRequest, name: &str) -> Option<String> {
    params_named(request, name).into_iter().next()
}

fn params_named(request: &HttpRequest, name: &str) -> Vec<String> {
    url_of(request)
        .query_pairs()
        .filter(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
        .collect()
}

fn last_segment(request: &HttpRequest) -> String {
    path(request).rsplit('/').next().unwrap().to_owned()
}

fn api(code: GmailApiError) -> GmailError {
    GmailError::Api(code)
}

/// Sets `extra` on `base`; a `null` in `extra` removes the key (`undefined` in the TS fixtures).
fn merge(mut base: Value, extra: Value) -> Value {
    let node = base.as_object_mut().unwrap();
    for (key, value) in extra.as_object().unwrap() {
        if value.is_null() {
            node.shift_remove(key);
        } else {
            node.insert(key.clone(), value.clone());
        }
    }
    base
}

/// `metadata(id, headers, extra)`.
fn metadata(id: &str, headers: &[(&str, &str)], extra: Value) -> Value {
    let headers: Vec<Value> = headers
        .iter()
        .map(|(name, value)| json!({ "name": name, "value": value }))
        .collect();
    merge(
        json!({
            "id": id,
            "threadId": format!("t-{id}"),
            "snippet": format!("snippet {id}"),
            "labelIds": ["INBOX"],
            "internalDate": "1762851600000", // 2025-11-11T09:00:00.000Z
            "payload": { "headers": headers },
        }),
        extra,
    )
}

/// `listRoute(ids, meta)`: the list answers `ids`; a metadata request answers `meta(id)`, or a
/// 404 for `None`.
fn list_route(
    ids: &'static [&'static str],
    meta: impl Fn(&str) -> Option<Value> + Send + Sync + 'static,
) -> impl Fn(&HttpRequest, usize) -> Reply + Send + Sync + 'static {
    move |request, _| {
        if path(request).ends_with("/messages") {
            let refs: Vec<Value> = ids
                .iter()
                .map(|id| json!({ "id": id, "threadId": format!("t-{id}") }))
                .collect();
            return json_ok(&json!({ "messages": refs }));
        }
        match meta(&last_segment(request)) {
            Some(body) => json_ok(&body),
            None => json_status(&json!({ "error": { "code": 404 } }), 404),
        }
    }
}

fn b64(text: &str) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(text.as_bytes())
}

/// `full(id, extra)`.
fn full(id: &str, extra: Value) -> Value {
    merge(
        json!({
            "id": id,
            "threadId": format!("t-{id}"),
            "labelIds": ["INBOX", "UNREAD"],
            "internalDate": "1762851600000",
            "payload": {
                "mimeType": "multipart/mixed",
                "headers": [
                    { "name": "From", "value": "Ana García <ana@example.com>" },
                    { "name": "Subject", "value": "Presupuesto" },
                    { "name": "Date", "value": "Tue, 11 Nov 2025 10:00:00 +0000" },
                ],
                "body": { "size": 0 },
                "parts": [
                    { "mimeType": "text/plain", "headers": [], "body": { "size": 10, "data": b64("Hola, mira https://example.com/a") } },
                    { "mimeType": "application/pdf", "filename": "doc.pdf", "headers": [], "body": { "size": 100 } },
                ],
            },
        }),
        extra,
    )
}

fn set_headers(message: &mut Value, headers: &[(&str, &str)]) {
    message["payload"]["headers"] = Value::Array(
        headers
            .iter()
            .map(|(name, value)| json!({ "name": name, "value": value }))
            .collect(),
    );
}

// --- unreadIds ------------------------------------------------------------------------------------

#[tokio::test]
async fn asks_for_the_unread_messages_of_primary_with_the_exact_query_and_bearer_token() {
    let s = setup(|_, _| json_ok(&json!({ "messages": [{ "id": "a", "threadId": "a" }] })));
    assert_eq!(s.client.unread_ids().await, Ok(vec!["a".to_owned()]));
    let request = &s.requests()[0];
    let url = url_of(request);
    assert_eq!(
        format!("{}{}", url.origin().ascii_serialization(), url.path()),
        format!("{API}/gmail/v1/users/me/messages")
    );
    assert_eq!(
        param(request, "q").as_deref(),
        Some("in:inbox category:primary is:unread")
    );
    assert_eq!(param(request, "maxResults").as_deref(), Some("100"));
    assert_eq!(request.header_value("authorization"), Some("Bearer AT1"));
    // The exact bytes of `URLSearchParams.append`, and a plain GET.
    assert_eq!(
        request.url,
        format!("{API}/gmail/v1/users/me/messages?q=in%3Ainbox+category%3Aprimary+is%3Aunread&maxResults=100")
    );
    assert_eq!(request.method, Method::Get);
    assert_eq!(request.header_value("accept"), Some("application/json"));
    assert_eq!(request.header_value("content-type"), None);
    assert!(request.body.is_none());
}

#[tokio::test]
async fn returns_the_ids_in_list_order_at_most_100_and_empty_without_messages() {
    let ids: Vec<Value> = (0..101)
        .map(|i| json!({ "id": format!("m{i}"), "threadId": format!("t{i}") }))
        .collect();
    let body = json!({ "messages": ids });
    let result = setup(move |_, _| json_ok(&body))
        .client
        .unread_ids()
        .await
        .unwrap();
    assert_eq!(result.len(), 100);
    assert_eq!(result[..2], ["m0".to_owned(), "m1".to_owned()]);
    let none = setup(|_, _| json_ok(&json!({ "resultSizeEstimate": 0 })));
    assert_eq!(none.client.unread_ids().await, Ok(Vec::new()));
}

// --- recent ---------------------------------------------------------------------------------------

#[tokio::test]
async fn lists_the_5_most_recent_of_primary_and_asks_metadata_with_from_subject_and_date() {
    const IDS: &[&str] = &["m1", "m2", "m3", "m4", "m5"];
    let s = setup(list_route(IDS, |id| {
        let from = format!("Ana {id} <a@x>");
        let subject = format!("Asunto {id}");
        Some(metadata(
            id,
            &[
                ("From", &from),
                ("Subject", &subject),
                ("Date", "Tue, 11 Nov 2025 10:00:00 +0000"),
            ],
            json!({}),
        ))
    }));
    let messages = s.client.recent().await.unwrap();

    let requests = s.requests();
    let list = &requests[0];
    assert_eq!(path(list), "/gmail/v1/users/me/messages");
    assert_eq!(
        param(list, "q").as_deref(),
        Some("in:inbox category:primary")
    );
    assert_eq!(param(list, "maxResults").as_deref(), Some("5"));

    let meta = &requests[1..];
    assert_eq!(
        meta.iter().map(path).collect::<Vec<_>>(),
        IDS.iter()
            .map(|id| format!("/gmail/v1/users/me/messages/{id}"))
            .collect::<Vec<_>>()
    );
    for request in meta {
        assert_eq!(param(request, "format").as_deref(), Some("metadata"));
        assert_eq!(
            params_named(request, "metadataHeaders"),
            ["From", "Subject", "Date"]
        );
        assert!(request.url.ends_with(
            "?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date"
        ));
    }

    assert_eq!(
        messages.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        IDS
    );
    assert_eq!(
        messages[0],
        GmailMessage {
            id: "m1".into(),
            thread_id: "t-m1".into(),
            from: "Ana m1".into(),
            subject: "Asunto m1".into(),
            snippet: "snippet m1".into(),
            date: "2025-11-11T10:00:00.000Z".into(),
            unread: false,
        }
    );
}

#[tokio::test(start_paused = true)]
async fn keeps_the_list_order_even_when_metadata_arrives_out_of_order() {
    let s = build(
        list_route(&["m1", "m2", "m3"], |id| Some(metadata(id, &[], json!({})))),
        |request| {
            Duration::from_millis(match last_segment(request).as_str() {
                "m1" => 30,
                "m3" => 10,
                _ => 0,
            })
        },
        Access::refreshing(|_| Ok(false)),
    );
    let ids: Vec<String> = s
        .client
        .recent()
        .await
        .unwrap()
        .into_iter()
        .map(|m| m.id)
        .collect();
    assert_eq!(ids, ["m1", "m2", "m3"]);
}

#[tokio::test]
async fn handles_odd_headers_no_subject_unread_label_invalid_or_missing_date_lowercase_names() {
    let s = setup(list_route(&["a", "b", "c"], |id| {
        Some(match id {
            "a" => metadata(
                id,
                &[("From", "\"Doe, John\" <j@x.com>"), ("Date", "not a date")],
                json!({ "labelIds": ["INBOX", "UNREAD"] }),
            ),
            "b" => metadata(
                id,
                &[("from", "<b@x>"), ("subject", "Hola")],
                json!({ "labelIds": null }),
            ),
            _ => metadata(
                id,
                &[("From", "c@x"), ("Subject", "It&#39;s fine"), ("Date", "")],
                json!({ "snippet": "a &amp; b" }),
            ),
        })
    }));
    let messages = s.client.recent().await.unwrap();
    let [a, b, c] = &messages[..] else {
        panic!("three messages")
    };
    assert_eq!(
        (
            a.from.as_str(),
            a.subject.as_str(),
            a.date.as_str(),
            a.unread
        ),
        ("Doe, John", "", "2025-11-11T09:00:00.000Z", true)
    );
    assert_eq!(
        (
            b.from.as_str(),
            b.subject.as_str(),
            b.date.as_str(),
            b.unread
        ),
        ("b@x", "Hola", "2025-11-11T09:00:00.000Z", false)
    );
    // Subjects are header text, not HTML: never decoded. Snippets come HTML-escaped from Gmail.
    assert_eq!(
        (c.from.as_str(), c.subject.as_str(), c.snippet.as_str()),
        ("c@x", "It&#39;s fine", "a & b")
    );
}

#[tokio::test]
async fn drops_messages_deleted_between_the_list_and_their_metadata_404() {
    let s = setup(list_route(&["a", "gone", "c"], |id| {
        (id != "gone").then(|| metadata(id, &[], json!({})))
    }));
    let ids: Vec<String> = s
        .client
        .recent()
        .await
        .unwrap()
        .into_iter()
        .map(|m| m.id)
        .collect();
    assert_eq!(ids, ["a", "c"]);
}

#[tokio::test]
async fn returns_an_empty_list_when_primary_is_empty() {
    let s = setup(|_, _| json_ok(&json!({})));
    assert_eq!(s.client.recent().await, Ok(Vec::new()));
    assert_eq!(s.calls(), 1);
}

#[tokio::test]
async fn rejects_metadata_without_a_usable_date_as_invalid_response() {
    let s = setup(list_route(&["a"], |id| {
        Some(metadata(id, &[], json!({ "internalDate": "nope" })))
    }));
    assert_eq!(
        s.client.recent().await,
        Err(api(GmailApiError::InvalidResponse))
    );
}

// --- profile --------------------------------------------------------------------------------------

#[tokio::test]
async fn returns_the_account_address() {
    let s = setup(|_, _| json_ok(&json!({ "emailAddress": "me@x.com", "messagesTotal": 3 })));
    assert_eq!(s.client.profile().await, Ok("me@x.com".to_owned()));
    assert_eq!(path(&s.requests()[0]), "/gmail/v1/users/me/profile");
    // No query: not even a bare `?`.
    assert_eq!(
        s.requests()[0].url,
        format!("{API}/gmail/v1/users/me/profile")
    );
}

// --- errors ---------------------------------------------------------------------------------------

#[tokio::test]
async fn on_401_refreshes_once_and_repeats_with_the_new_token() {
    let s = setup(|_, index| {
        if index == 0 {
            json_status(&json!({}), 401)
        } else {
            json_ok(&json!({ "messages": [] }))
        }
    });
    assert_eq!(s.client.unread_ids().await, Ok(Vec::new()));
    assert_eq!(s.access.unauthorized_calls(), 1);
    assert_eq!(s.calls(), 2);
    let requests = s.requests();
    assert_eq!(
        requests[1].header_value("authorization"),
        Some("Bearer AT2")
    );
    assert_eq!(requests[1].url, requests[0].url);
}

#[tokio::test]
async fn a_second_401_is_unauthorized_without_looping() {
    let s = setup(|_, _| json_status(&json!({}), 401));
    assert_eq!(
        s.client.unread_ids().await,
        Err(api(GmailApiError::Unauthorized))
    );
    assert_eq!(s.access.unauthorized_calls(), 1);
    assert_eq!(s.calls(), 2);
}

#[tokio::test]
async fn a_refused_refresh_is_unauthorized_without_repeating_the_request() {
    let s = setup_with(
        |_, _| json_status(&json!({}), 401),
        Access::refreshing(|_| Ok(false)),
    );
    assert_eq!(
        s.client.unread_ids().await,
        Err(api(GmailApiError::Unauthorized))
    );
    assert_eq!(s.access.unauthorized_calls(), 1);
    assert_eq!(s.calls(), 1);
}

#[tokio::test]
async fn maps_429_and_403_to_rate_limited_5xx_to_server_other_4xx_to_invalid_response() {
    let status = |code: u16| setup(move |_, _| json_status(&json!({}), code));
    assert_eq!(
        status(429).client.unread_ids().await,
        Err(api(GmailApiError::RateLimited))
    );
    assert_eq!(
        status(403).client.unread_ids().await,
        Err(api(GmailApiError::RateLimited))
    );
    assert_eq!(
        status(500).client.unread_ids().await,
        Err(api(GmailApiError::Server))
    );
    assert_eq!(
        status(503).client.profile().await,
        Err(api(GmailApiError::Server))
    );
    assert_eq!(
        status(404).client.unread_ids().await,
        Err(api(GmailApiError::InvalidResponse))
    );
}

#[tokio::test]
async fn maps_a_thrown_fetch_to_network() {
    let s = setup(|_, _| Err(TransportError::Network));
    assert_eq!(
        s.client.unread_ids().await,
        Err(api(GmailApiError::Network))
    );
}

#[tokio::test]
async fn maps_bodies_that_are_not_json_or_do_not_match_the_schema_to_invalid_response() {
    let html = setup(|_, _| Ok(HttpResponse::new(200).with_body("<html>")));
    assert_eq!(
        html.client.unread_ids().await,
        Err(api(GmailApiError::InvalidResponse))
    );
    let numeric = setup(|_, _| json_ok(&json!({ "messages": [{ "id": 1 }] })));
    assert_eq!(
        numeric.client.unread_ids().await,
        Err(api(GmailApiError::InvalidResponse))
    );
    let profile = setup(|_, _| json_ok(&json!({ "email": "x" })));
    assert_eq!(
        profile.client.profile().await,
        Err(api(GmailApiError::InvalidResponse))
    );
}

#[tokio::test]
async fn carries_only_the_code_in_the_error_message() {
    let s = setup(|_, _| json_status(&json!({ "error": { "message": "secret subject" } }), 500));
    let error = s.client.unread_ids().await.unwrap_err();
    let message = error.to_string();
    assert_eq!(message, "Gmail API failed: server");
    assert!(!message.contains("secret"));
    assert!(!message.contains("AT1"));
    assert!(!format!("{error:?}").contains("secret"));
}

// --- message --------------------------------------------------------------------------------------

#[tokio::test]
async fn asks_format_full_and_builds_the_detail_sender_name_and_address_subject_date_unread_text_links_attachments(
) {
    let s = setup(|_, _| json_ok(&full("m1", json!({}))));
    let detail = s.client.message("m1").await.unwrap();
    let request = &s.requests()[0];
    assert_eq!(path(request), "/gmail/v1/users/me/messages/m1");
    assert_eq!(param(request, "format").as_deref(), Some("full"));
    assert_eq!(
        detail,
        GmailMessageDetail {
            id: "m1".into(),
            thread_id: "t-m1".into(),
            from: "Ana García".into(),
            from_address: "ana@example.com".into(),
            subject: "Presupuesto".into(),
            date: "2025-11-11T10:00:00.000Z".into(),
            unread: true,
            body: "Hola, mira https://example.com/a".into(),
            truncated: false,
            links: vec![GmailLink {
                text: "https://example.com/a".into(),
                url: "https://example.com/a".into(),
            }],
            attachments: 1,
        }
    );
}

#[tokio::test]
async fn reads_a_message_without_labels_as_read_without_subject_as_empty_the_date_from_internal_date(
) {
    let mut message = full("m2", json!({ "labelIds": null }));
    set_headers(&mut message, &[("From", "solo@example.com")]);
    let detail = setup(move |_, _| json_ok(&message))
        .client
        .message("m2")
        .await
        .unwrap();
    assert_eq!(detail.from, "solo@example.com");
    assert_eq!(detail.from_address, "solo@example.com");
    assert_eq!(detail.subject, "");
    assert!(!detail.unread);
    assert_eq!(detail.date, "2025-11-11T09:00:00.000Z");
}

#[tokio::test]
async fn cuts_sender_and_subject_to_1000_characters_so_a_valid_mail_never_fails_validation() {
    let mut message = full("m3", json!({}));
    let name = "N".repeat(1500);
    let address = format!("{}@example.com", "a".repeat(1500));
    let from = format!("{name} <{address}>");
    let subject = "S".repeat(5000);
    set_headers(&mut message, &[("From", &from), ("Subject", &subject)]);
    let detail = setup(move |_, _| json_ok(&message))
        .client
        .message("m3")
        .await
        .unwrap();
    assert_eq!(detail.from, "N".repeat(1000));
    assert_eq!(detail.from_address, "a".repeat(1000));
    assert_eq!(detail.subject, "S".repeat(1000));
}

#[tokio::test]
async fn encodes_the_id_in_the_path() {
    let s = setup(|_, _| json_ok(&full("a/b", json!({}))));
    s.client.message("a/b").await.unwrap();
    assert_eq!(path(&s.requests()[0]), "/gmail/v1/users/me/messages/a%2Fb");
}

#[tokio::test]
async fn a_404_is_not_found_a_bad_body_is_invalid_response() {
    let missing = setup(|_, _| json_status(&json!({}), 404));
    assert_eq!(
        missing.client.message("x").await,
        Err(api(GmailApiError::NotFound))
    );
    let bad = setup(|_, _| json_ok(&json!({ "id": "x" })));
    assert_eq!(
        bad.client.message("x").await,
        Err(api(GmailApiError::InvalidResponse))
    );
}

#[tokio::test]
async fn an_extraction_failure_is_invalid_response_never_a_crash() {
    fn failing(_: &MessagePart) -> MessageText {
        panic!("extractor failure (test)")
    }
    let s = setup(|_, _| json_ok(&full("m1", json!({}))));
    let client = s.client.with_extractor(failing);
    assert_eq!(
        client.message("m1").await,
        Err(api(GmailApiError::InvalidResponse))
    );
}

#[tokio::test]
async fn message_on_401_refreshes_once_and_repeats() {
    let s = setup(|_, index| {
        if index == 0 {
            json_status(&json!({}), 401)
        } else {
            json_ok(&full("m1", json!({})))
        }
    });
    assert_eq!(s.client.message("m1").await.unwrap().id, "m1");
    assert_eq!(s.access.unauthorized_calls(), 1);
}

// --- markRead and remove --------------------------------------------------------------------------

#[tokio::test]
async fn mark_read_posts_modify_with_remove_label_ids_unread() {
    let s = setup(|_, _| json_ok(&json!({ "id": "m1", "labelIds": ["INBOX"] })));
    assert_eq!(s.client.mark_read("m1").await, Ok(()));
    let request = &s.requests()[0];
    assert_eq!(path(request), "/gmail/v1/users/me/messages/m1/modify");
    assert_eq!(
        request.url,
        format!("{API}/gmail/v1/users/me/messages/m1/modify")
    );
    assert_eq!(request.method, Method::Post);
    assert_eq!(
        request.header_value("content-type"),
        Some("application/json")
    );
    assert_eq!(request.header_value("authorization"), Some("Bearer AT1"));
    let body: Value = serde_json::from_slice(request.body.as_deref().unwrap()).unwrap();
    assert_eq!(body, json!({ "removeLabelIds": ["UNREAD"] }));
    // `JSON.stringify` bytes.
    assert_eq!(
        request.body.as_deref(),
        Some(&br#"{"removeLabelIds":["UNREAD"]}"#[..])
    );
}

#[tokio::test]
async fn remove_sends_delete_on_the_message_permanent() {
    let s = setup(|_, _| empty(204));
    assert_eq!(s.client.remove("m1").await, Ok(()));
    let request = &s.requests()[0];
    assert_eq!(path(request), "/gmail/v1/users/me/messages/m1");
    assert_eq!(request.method, Method::Delete);
    assert!(request.body.is_none());
    assert_eq!(request.header_value("content-type"), None);
}

#[tokio::test]
async fn a_404_counts_as_done_for_both() {
    let gone = || setup(|_, _| json_status(&json!({}), 404));
    assert_eq!(gone().client.mark_read("gone").await, Ok(()));
    assert_eq!(gone().client.remove("gone").await, Ok(()));
}

#[tokio::test]
async fn writes_on_401_refresh_once_and_repeat_with_the_new_token() {
    let s = setup(|_, index| {
        if index == 0 {
            json_status(&json!({}), 401)
        } else {
            empty(204)
        }
    });
    s.client.remove("m1").await.unwrap();
    assert_eq!(s.access.unauthorized_calls(), 1);
    assert_eq!(s.calls(), 2);
    let requests = s.requests();
    assert_eq!(requests[1].method, Method::Delete);
    assert_eq!(
        requests[1].header_value("authorization"),
        Some("Bearer AT2")
    );
    let always = setup(|_, _| json_status(&json!({}), 401));
    assert_eq!(
        always.client.mark_read("m1").await,
        Err(api(GmailApiError::Unauthorized))
    );
}

#[tokio::test]
async fn maps_other_failures_like_the_reads() {
    assert_eq!(
        setup(|_, _| json_status(&json!({}), 500))
            .client
            .remove("m1")
            .await,
        Err(api(GmailApiError::Server))
    );
    assert_eq!(
        setup(|_, _| json_status(&json!({}), 429))
            .client
            .mark_read("m1")
            .await,
        Err(api(GmailApiError::RateLimited))
    );
    assert_eq!(
        setup(|_, _| Err(TransportError::Network))
            .client
            .remove("m1")
            .await,
        Err(api(GmailApiError::Network))
    );
}

// --- Rust-only ------------------------------------------------------------------------------------

#[test]
fn errors_carry_only_their_code_and_know_a_dead_session() {
    let codes = [
        (GmailApiError::Unauthorized, "unauthorized"),
        (GmailApiError::Network, "network"),
        (GmailApiError::RateLimited, "rate-limited"),
        (GmailApiError::Server, "server"),
        (GmailApiError::InvalidResponse, "invalid-response"),
        (GmailApiError::NotFound, "not-found"),
    ];
    for (error, code) in codes {
        assert_eq!(error.code(), code);
        assert_eq!(error.to_string(), format!("Gmail API failed: {code}"));
        assert_eq!(GmailError::from(error).code(), code);
        assert_eq!(
            GmailError::from(error).to_string(),
            format!("Gmail API failed: {code}")
        );
    }
    assert_eq!(GmailError::from(GmailAuthError::Denied).code(), "denied");
    assert_eq!(
        GmailError::from(GmailAuthError::Network).to_string(),
        "Gmail auth failed: network"
    );
    // `isSessionDead`: unauthorized or denied, nothing else.
    assert!(GmailError::from(GmailApiError::Unauthorized).is_session_dead());
    assert!(GmailError::from(GmailAuthError::Denied).is_session_dead());
    assert!(!GmailError::from(GmailApiError::RateLimited).is_session_dead());
    assert!(!GmailError::from(GmailAuthError::Network).is_session_dead());
    assert!(!GmailError::from(GmailAuthError::InvalidResponse).is_session_dead());
    assert!(GmailError::from(GmailApiError::NotFound).is_not_found());
    assert!(!GmailError::from(GmailApiError::InvalidResponse).is_not_found());
    // A refused body is invalid-response, a failed request network.
    assert_eq!(
        GmailApiError::from(TransportError::BodyTooLarge),
        GmailApiError::InvalidResponse
    );
    assert_eq!(
        GmailApiError::from(TransportError::Network),
        GmailApiError::Network
    );
}

#[tokio::test]
async fn token_access_errors_pass_through_unchanged() {
    // `getAccessToken` rejecting (a stale session, a failed refresh) sends nothing.
    for error in [
        api(GmailApiError::Unauthorized),
        GmailError::Auth(GmailAuthError::Network),
        GmailError::Auth(GmailAuthError::Denied),
    ] {
        let access = Access::new();
        *access.token.lock().unwrap() = Err(error);
        let s = setup_with(|_, _| json_ok(&json!({})), access);
        assert_eq!(s.client.unread_ids().await, Err(error));
        assert_eq!(s.client.remove("m1").await, Err(error));
        assert_eq!(s.calls(), 0);
    }
    // `onUnauthorized` rejecting with something other than denied propagates as is.
    let s = setup_with(
        |_, _| json_status(&json!({}), 401),
        Access::refreshing(|_| Err(GmailError::Auth(GmailAuthError::InvalidResponse))),
    );
    assert_eq!(
        s.client.message("m1").await,
        Err(GmailError::Auth(GmailAuthError::InvalidResponse))
    );
    assert_eq!(s.calls(), 1);
}

#[tokio::test]
async fn a_body_over_the_cap_and_a_redirect_are_invalid_responses() {
    let large = setup(|_, _| Err(TransportError::BodyTooLarge));
    assert_eq!(
        large.client.message("m1").await,
        Err(api(GmailApiError::InvalidResponse))
    );
    let moved =
        setup(|_, _| Ok(HttpResponse::new(302).with_header("location", "https://elsewhere.test/")));
    assert_eq!(
        moved.client.profile().await,
        Err(api(GmailApiError::InvalidResponse))
    );
    assert_eq!(
        moved.client.remove("m1").await,
        Err(api(GmailApiError::InvalidResponse))
    );
    assert_eq!(moved.calls(), 2);
}

#[tokio::test]
async fn reads_json_like_response_json() {
    // A byte order mark is skipped and invalid UTF-8 replaced, as `Response.json()` does.
    let mut body = vec![0xEF, 0xBB, 0xBF];
    body.extend_from_slice(br#"{"emailAddress":"me@x.com"}"#);
    let bom = setup(move |_, _| Ok(HttpResponse::new(200).with_body(body.clone())));
    assert_eq!(bom.client.profile().await, Ok("me@x.com".to_owned()));
    // `null` for an optional key is refused, as zod does.
    let nulls = setup(|_, _| json_ok(&json!({ "messages": null })));
    assert_eq!(
        nulls.client.unread_ids().await,
        Err(api(GmailApiError::InvalidResponse))
    );
}

#[tokio::test]
async fn an_unread_label_in_lower_case_is_not_unread_and_headers_match_case_insensitively() {
    let s = setup(list_route(&["a"], |id| {
        Some(metadata(
            id,
            &[
                ("DATE", "Tue, 11 Nov 2025 10:00:00 +0000"),
                ("Date", "garbage"),
                ("SUBJECT", "Primero"),
                ("subject", "Segundo"),
            ],
            json!({ "labelIds": ["unread"] }),
        ))
    }));
    let messages = s.client.recent().await.unwrap();
    // The first header with the name wins, whatever its case.
    assert_eq!(messages[0].date, "2025-11-11T10:00:00.000Z");
    assert_eq!(messages[0].subject, "Primero");
    assert!(!messages[0].unread);
}

#[tokio::test]
async fn summary_reads_one_row_and_gives_none_for_a_404() {
    let s = setup(|request, _| {
        if last_segment(request) == "gone" {
            empty(404)
        } else {
            json_ok(&metadata("m1", &[("From", "Ana <a@x>")], json!({})))
        }
    });
    let row = s.client.summary("m1").await.unwrap().unwrap();
    assert_eq!(row.from, "Ana");
    assert_eq!(s.client.summary("gone").await, Ok(None));
    let missing = setup(|_, _| empty(500));
    assert_eq!(
        missing.client.summary("m1").await,
        Err(api(GmailApiError::Server))
    );
}

#[tokio::test]
async fn the_first_failing_metadata_fails_the_whole_list() {
    let s = setup(list_route(&["a", "b", "c"], |id| {
        (id != "b").then(|| metadata(id, &[], json!({})))
    }));
    // A 404 is dropped; but any other failure rejects the list (`Promise.all`).
    assert_eq!(s.client.recent().await.unwrap().len(), 2);
    let failing = setup(|request, _| {
        if path(request).ends_with("/messages") {
            json_ok(
                &json!({ "messages": [{ "id": "a", "threadId": "a" }, { "id": "b", "threadId": "b" }] }),
            )
        } else if last_segment(request) == "b" {
            empty(429)
        } else {
            json_ok(&metadata("a", &[], json!({})))
        }
    });
    assert_eq!(
        failing.client.recent().await,
        Err(api(GmailApiError::RateLimited))
    );
}

#[test]
fn encode_uri_component_matches_js() {
    assert_eq!(encode_uri_component("a/b"), "a%2Fb");
    assert_eq!(encode_uri_component("AZaz09-_.!~*'()"), "AZaz09-_.!~*'()");
    assert_eq!(
        encode_uri_component(" #?&=+%:@,;$\"<>[]{}|\\^`"),
        "%20%23%3F%26%3D%2B%25%3A%40%2C%3B%24%22%3C%3E%5B%5D%7B%7D%7C%5C%5E%60"
    );
    assert_eq!(encode_uri_component("é😀"), "%C3%A9%F0%9F%98%80");
    assert_eq!(encode_uri_component("\u{0}\u{7f}"), "%00%7F");
}

#[tokio::test]
async fn ids_are_encoded_in_every_path() {
    let s = setup(|request, _| {
        if request.method == Method::Get {
            json_ok(&metadata("x", &[], json!({})))
        } else {
            empty(204)
        }
    });
    s.client.summary("a b?#").await.unwrap();
    s.client.mark_read("a b?#").await.unwrap();
    s.client.remove("a b?#").await.unwrap();
    let paths: Vec<String> = s.requests().iter().map(path).collect();
    assert_eq!(
        paths,
        [
            "/gmail/v1/users/me/messages/a%20b%3F%23",
            "/gmail/v1/users/me/messages/a%20b%3F%23/modify",
            "/gmail/v1/users/me/messages/a%20b%3F%23",
        ]
    );
}

#[test]
fn iso_date_reads_rfc_2822_with_comments_obsolete_zones_and_any_weekday() {
    let ok = |header: &str| iso_date(Some(header), "nope").unwrap();
    assert_eq!(
        ok("Tue, 11 Nov 2025 10:00:00 +0000"),
        "2025-11-11T10:00:00.000Z"
    );
    assert_eq!(
        ok("Tue, 11 Nov 2025 10:00:00 +0000 (UTC)"),
        "2025-11-11T10:00:00.000Z"
    );
    assert_eq!(
        ok("Tue, 11 Nov 2025 12:30:15 +0200 (CEST)"),
        "2025-11-11T10:30:15.000Z"
    );
    assert_eq!(ok("11 Nov 2025 10:00:00 GMT"), "2025-11-11T10:00:00.000Z");
    assert_eq!(
        ok("Tue, 11 Nov 2025 05:00:00 EST"),
        "2025-11-11T10:00:00.000Z"
    );
    assert_eq!(
        ok("Tue, 11 Nov 2025 03:00:00 PDT"),
        "2025-11-11T10:00:00.000Z"
    );
    assert_eq!(
        ok("Tue, 11 Nov 2025 10:00:00 UT"),
        "2025-11-11T10:00:00.000Z"
    );
    assert_eq!(
        ok("Tue, 11 Nov 2025 10:00 +0000"),
        "2025-11-11T10:00:00.000Z"
    );
    assert_eq!(
        ok("  Tue,  11 Nov 2025 10:00:00 -0130  "),
        "2025-11-11T11:30:00.000Z"
    );
    // JS reads a trailing `UTC` zone, in any case; chrono needs it as `+0000`.
    assert_eq!(
        ok("Tue, 11 Nov 2025 10:00:00 UTC"),
        "2025-11-11T10:00:00.000Z"
    );
    assert_eq!(
        ok("11 Nov 2025 12:00:00 utc (Coordinated)"),
        "2025-11-11T12:00:00.000Z"
    );
    // Chrono skips a comment still left at the end once one is stripped.
    assert_eq!(
        ok("Tue, 11 Nov 2025 10:00:00 +0000 (a) (b)"),
        "2025-11-11T10:00:00.000Z"
    );
    // JS ignores the weekday: a wrong one still parses.
    assert_eq!(
        ok("Mon, 11 Nov 2025 10:00:00 +0000"),
        "2025-11-11T10:00:00.000Z"
    );
    // Two-digit years: 00-49 are 20xx, 50-99 are 19xx.
    assert_eq!(
        ok("Tue, 11 Nov 25 10:00:00 +0000"),
        "2025-11-11T10:00:00.000Z"
    );
    assert_eq!(
        ok("Thu, 11 Nov 99 10:00:00 +0000"),
        "1999-11-11T10:00:00.000Z"
    );
}

#[test]
fn iso_date_reads_rfc_3339_with_milliseconds() {
    let ok = |header: &str| iso_date(Some(header), "nope").unwrap();
    assert_eq!(ok("2025-11-11T10:00:00Z"), "2025-11-11T10:00:00.000Z");
    assert_eq!(ok("2025-11-11T10:00:00.1234Z"), "2025-11-11T10:00:00.123Z");
    assert_eq!(
        ok("2025-11-11T12:00:00.5+02:00"),
        "2025-11-11T10:00:00.500Z"
    );
    assert_eq!(ok("1969-12-31T23:59:59.9999Z"), "1969-12-31T23:59:59.999Z");
}

#[test]
fn iso_date_falls_back_to_internal_date_in_milliseconds() {
    let internal = "1762851600000";
    let fallback = "2025-11-11T09:00:00.000Z";
    for header in [
        None,
        Some(""),
        Some("not a date"),
        Some("(UTC)"),
        Some("Tue, 11 Nov 2025 10:00:00"),
    ] {
        assert_eq!(
            iso_date(header, internal).as_deref(),
            Ok(fallback),
            "{header:?}"
        );
    }
    // Leap seconds and out-of-range dates are not valid JS dates either.
    assert_eq!(
        iso_date(Some("2016-12-31T23:59:60Z"), internal).as_deref(),
        Ok(fallback)
    );
    assert_eq!(
        iso_date(None, "0").as_deref(),
        Ok("1970-01-01T00:00:00.000Z")
    );
    assert_eq!(
        iso_date(None, "0001762851600123").as_deref(),
        Ok("2025-11-11T09:00:00.123Z")
    );
    // Years past 9999 are written expanded (`+YYYYYY`), as `toISOString` does.
    let far = iso_date(None, "6000000000000000").unwrap();
    assert!(
        far.starts_with("+19") && far.ends_with("Z") && far.len() == 27,
        "{far}"
    );
    // Deviation: JS's last valid time (+275760-09-13) is past chrono's range (about year
    // 262143), so it is invalid here.
    assert_eq!(
        iso_date(None, "8640000000000000"),
        Err(GmailApiError::InvalidResponse)
    );
    assert_eq!(
        iso_date(None, "253402300800000").as_deref(),
        Ok("+010000-01-01T00:00:00.000Z")
    );
}

#[test]
fn iso_date_without_a_usable_date_is_invalid_response() {
    for internal in [
        "",
        "nope",
        "-1",
        "1.5",
        " 1",
        "1e3",
        "١٢",
        "8640000000000001",
        "99999999999999999999999",
    ] {
        assert_eq!(
            iso_date(None, internal),
            Err(GmailApiError::InvalidResponse),
            "{internal:?}"
        );
    }
    assert_eq!(
        iso_date(Some("garbage"), "nope"),
        Err(GmailApiError::InvalidResponse)
    );
}

#[test]
fn debug_never_prints_the_token_or_the_base() {
    let s = setup(|_, _| empty(200));
    let shown = format!("{:?}", s.client);
    assert_eq!(shown, "GmailClient { .. }");
    assert!(!shown.contains("AT1"));
    assert!(!shown.contains("gmail.test"));
}

// --- Loopback (real transport) --------------------------------------------------------------------

fn loopback(base: &str) -> (GmailClient, Arc<Access>) {
    let access = Arc::new(Access::new());
    let client = GmailClient::new(
        Arc::new(ReqwestTransport::new().unwrap()),
        base,
        access.clone(),
    );
    (client, access)
}

fn drain(requests: &mut tokio::sync::mpsc::UnboundedReceiver<String>) -> Vec<String> {
    let mut seen = Vec::new();
    while let Ok(request) = requests.try_recv() {
        seen.push(request);
    }
    seen
}

#[tokio::test]
async fn delete_and_modify_reach_a_loopback_server() {
    let (base, mut requests) = serve(|request| {
        if request.starts_with("DELETE ") {
            b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".to_vec()
        } else {
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec()
        }
    })
    .await;
    let (client, _) = loopback(&base);
    assert_eq!(client.remove("m/1").await, Ok(()));
    assert_eq!(client.mark_read("m1").await, Ok(()));
    let seen = drain(&mut requests);
    assert_eq!(seen.len(), 2);
    let delete = seen[0].to_ascii_lowercase();
    assert!(
        delete.starts_with("delete /gmail/v1/users/me/messages/m%2f1 http/1.1\r\n"),
        "{delete}"
    );
    assert!(delete.contains("authorization: bearer at1\r\n"));
    assert!(delete.contains("accept: application/json\r\n"));
    assert!(!delete.contains("content-type"));
    let post = &seen[1];
    assert!(
        post.starts_with("POST /gmail/v1/users/me/messages/m1/modify HTTP/1.1\r\n"),
        "{post}"
    );
    assert!(post
        .to_ascii_lowercase()
        .contains("content-type: application/json\r\n"));
    assert!(post.ends_with(r#"{"removeLabelIds":["UNREAD"]}"#));
}

#[tokio::test]
async fn a_loopback_redirect_is_never_followed_for_reads_or_writes() {
    let (base, mut requests) = serve(|_| {
        b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            .to_vec()
    })
    .await;
    let (client, access) = loopback(&base);
    assert_eq!(
        client.profile().await,
        Err(api(GmailApiError::InvalidResponse))
    );
    assert_eq!(
        client.message("m1").await,
        Err(api(GmailApiError::InvalidResponse))
    );
    assert_eq!(
        client.remove("m1").await,
        Err(api(GmailApiError::InvalidResponse))
    );
    assert_eq!(
        client.mark_read("m1").await,
        Err(api(GmailApiError::InvalidResponse))
    );
    // One request each: the redirect was not followed, and it is not a 401.
    assert_eq!(drain(&mut requests).len(), 4);
    assert_eq!(access.unauthorized_calls(), 0);
}
