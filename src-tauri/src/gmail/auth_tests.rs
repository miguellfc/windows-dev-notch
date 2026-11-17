//! `tests/unit/main/gmail-auth.test.ts` (23 cases) plus Rust-only checks. A fake [`Transport`]
//! plays Google and a recording opener stands in for the browser; the consent redirect is a real
//! HTTP request to the loopback on 127.0.0.1. Nothing reaches Google or opens a browser.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use chrono::DateTime;
use serde_json::{json, Value};
use tokio::sync::watch;

use super::*;
use crate::gmail::loopback::LOOPBACK_TIMEOUT;
use crate::http::{HttpRequest, HttpResponse, ReqwestTransport, TransportError};

type Reply = Arc<
    dyn Fn(&HttpRequest) -> BoxFuture<'static, Result<HttpResponse, TransportError>> + Send + Sync,
>;

/// Records every request; `aborted` turns true when a request future is dropped unfinished
/// (the `AbortSignal` of the TS fake).
struct FakeTransport {
    reply: Reply,
    calls: Mutex<Vec<HttpRequest>>,
    aborted: Arc<AtomicBool>,
}

struct AbortGuard {
    aborted: Arc<AtomicBool>,
    done: bool,
}

impl Drop for AbortGuard {
    fn drop(&mut self) {
        if !self.done {
            self.aborted.store(true, Ordering::SeqCst);
        }
    }
}

impl Transport for FakeTransport {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, TransportError>> {
        let future = (self.reply)(&request);
        lock(&self.calls).push(request);
        let guard = AbortGuard {
            aborted: Arc::clone(&self.aborted),
            done: false,
        };
        Box::pin(async move {
            // Move the whole guard in (a closure would capture only `guard.done`).
            let mut guard = guard;
            let result = future.await;
            guard.done = true;
            result
        })
    }
}

impl FakeTransport {
    fn calls(&self) -> Vec<HttpRequest> {
        lock(&self.calls).clone()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn json_reply(body: Value, status: u16) -> HttpResponse {
    HttpResponse::new(status).with_body(serde_json::to_vec(&body).unwrap())
}

fn replying(body: Value, status: u16) -> Reply {
    Arc::new(move |_| {
        let response = json_reply(body.clone(), status);
        Box::pin(async move { Ok(response) })
    })
}

fn failing() -> Reply {
    Arc::new(|_| Box::pin(async { Err(TransportError::Network) }))
}

/// A request that never answers (it only ends when dropped).
fn hung() -> Reply {
    Arc::new(|_| Box::pin(std::future::pending()))
}

fn tokens() -> Value {
    json!({ "access_token": "AT", "refresh_token": "RT", "expires_in": 3600, "token_type": "Bearer" })
}

struct Setup {
    auth: Arc<GoogleAuth>,
    transport: Arc<FakeTransport>,
    urls: Arc<Mutex<Vec<String>>>,
}

impl Setup {
    fn urls(&self) -> Vec<String> {
        lock(&self.urls).clone()
    }

    fn sign_in(&self) -> tokio::task::JoinHandle<Result<SignInResult, SignInError>> {
        let auth = Arc::clone(&self.auth);
        tokio::spawn(async move { auth.sign_in().await })
    }
}

fn config() -> GoogleAuthConfig {
    let mut config = GoogleAuthConfig::new("cid", "csecret", None);
    config.oauth_base = "https://oauth.test".into();
    config
}

fn clock() -> Arc<WallClock> {
    Arc::new(WallClock::fixed(
        DateTime::from_timestamp_millis(1_000_000).unwrap(),
    ))
}

fn recording_opener(urls: &Arc<Mutex<Vec<String>>>) -> OpenExternal {
    let urls = Arc::clone(urls);
    Arc::new(move |url: String| {
        lock(&urls).push(url);
        Box::pin(async { Ok(()) })
    })
}

fn setup_with(reply: Reply, configure: impl FnOnce(GoogleAuth) -> GoogleAuth) -> Setup {
    let transport = Arc::new(FakeTransport {
        reply,
        calls: Mutex::new(Vec::new()),
        aborted: Arc::new(AtomicBool::new(false)),
    });
    let urls = Arc::new(Mutex::new(Vec::new()));
    let auth = GoogleAuth::new(
        Arc::clone(&transport) as Arc<dyn Transport>,
        recording_opener(&urls),
        clock(),
        config(),
    );
    Setup {
        auth: Arc::new(configure(auth)),
        transport,
        urls,
    }
}

fn setup(reply: Reply) -> Setup {
    setup_with(reply, |auth| auth)
}

async fn until(check: impl Fn() -> bool) {
    for _ in 0..400 {
        if check() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(check(), "condition not reached in time");
}

fn query(url: &str) -> Vec<(String, String)> {
    url::Url::parse(url)
        .unwrap()
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect()
}

fn param(url: &str, name: &str) -> String {
    query(url)
        .into_iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value)
        .unwrap_or_else(|| panic!("no {name}"))
}

fn form(request: &HttpRequest) -> Vec<(String, String)> {
    url::form_urlencoded::parse(request.body.as_deref().unwrap_or_default())
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect()
}

async fn browser_get(url: String) -> Result<HttpResponse, TransportError> {
    ReqwestTransport::new()
        .unwrap()
        .send(HttpRequest::get(url))
        .await
}

/// Plays the browser coming back from the consent screen with `extra` (e.g. `code=c`).
async fn come_back(consent_url: &str, extra: &str) {
    let redirect = param(consent_url, "redirect_uri");
    let state = param(consent_url, "state");
    let response = browser_get(format!("{redirect}?{extra}&state={state}"))
        .await
        .expect("the loopback answers");
    assert_eq!(response.status, 200);
}

fn assert_cancelled(result: Result<SignInResult, SignInError>) {
    assert_eq!(result, Err(SignInError::Auth(GmailAuthError::Cancelled)));
}

// --- scope ---

#[test]
fn asks_for_full_mail_access() {
    assert_eq!(GMAIL_SCOPE, "https://mail.google.com/");
}

#[test]
fn requires_the_exact_full_mail_token_in_the_granted_scope_list() {
    assert!(has_required_scope(Some("https://mail.google.com/")));
    assert!(has_required_scope(Some("https://mail.google.com/ openid")));
    assert!(has_required_scope(Some(
        "openid\thttps://mail.google.com/\n"
    )));
    assert!(!has_required_scope(Some(
        "https://www.googleapis.com/auth/gmail.readonly"
    )));
    assert!(!has_required_scope(Some(
        "https://mail.google.com/x https://mail.google.com"
    )));
    assert!(!has_required_scope(Some("")));
    assert!(!has_required_scope(None));
    // `\s` is JS whitespace: a no-break space separates too; U+0085 does not.
    assert!(has_required_scope(Some(
        "openid\u{a0}https://mail.google.com/"
    )));
    assert!(!has_required_scope(Some(
        "openid\u{85}https://mail.google.com/"
    )));
}

// --- pkce ---

#[test]
fn matches_the_rfc_7636_appendix_b_vector() {
    assert_eq!(
        pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
}

fn is_base64url(text: &str) -> bool {
    text.bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[test]
fn creates_a_base64url_verifier_of_valid_length_its_challenge_and_a_distinct_state() {
    let Pkce {
        verifier,
        challenge,
        state,
    } = Pkce::generate().unwrap();
    assert!(is_base64url(&verifier) && (43..=128).contains(&verifier.len()));
    assert_eq!(verifier.len(), 43, "32 random bytes");
    assert_eq!(challenge, pkce_challenge(&verifier));
    assert!(is_base64url(&state) && state.len() >= 16);
    assert_eq!(state.len(), 22, "16 random bytes");
    assert_ne!(state, verifier);
    assert_ne!(Pkce::generate().unwrap().verifier, verifier);
}

#[test]
fn uses_the_injected_randomness() {
    let ones = |n: usize| Ok(vec![1u8; n]);
    let a = Pkce::from_random(ones).unwrap();
    let b = Pkce::from_random(ones).unwrap();
    assert_eq!(a, b);
    assert_eq!(a.verifier, "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE");
    assert_eq!(a.state, "AQEBAQEBAQEBAQEBAQEBAQ");
    let mut sizes = Vec::new();
    Pkce::from_random(|n| {
        sizes.push(n);
        Ok(vec![0; n])
    })
    .unwrap();
    assert_eq!(sizes, [32, 16]);
    let failed = Pkce::from_random(|_| Err(std::io::Error::other("no entropy")));
    assert!(failed.is_err());
}

// --- signIn ---

#[tokio::test]
async fn opens_the_consent_url_with_every_parameter_and_exchanges_the_code_with_the_verifier() {
    let s = setup(replying(tokens(), 200));
    let result = s.sign_in();
    until(|| s.urls().len() == 1).await;
    let consent = s.urls()[0].clone();
    let url = url::Url::parse(&consent).unwrap();
    assert_eq!(
        format!("{}{}", url.origin().ascii_serialization(), url.path()),
        "https://accounts.google.com/o/oauth2/v2/auth"
    );
    let keys: Vec<String> = query(&consent).into_iter().map(|(key, _)| key).collect();
    assert_eq!(
        keys,
        [
            "client_id",
            "redirect_uri",
            "response_type",
            "scope",
            "code_challenge",
            "code_challenge_method",
            "state",
            "access_type",
            "prompt"
        ]
    );
    assert_eq!(param(&consent, "client_id"), "cid");
    assert_eq!(param(&consent, "response_type"), "code");
    assert_eq!(param(&consent, "scope"), "https://mail.google.com/");
    assert_eq!(param(&consent, "code_challenge_method"), "S256");
    assert_eq!(param(&consent, "access_type"), "offline");
    assert_eq!(param(&consent, "prompt"), "consent");
    // `URLSearchParams` encoding.
    assert!(consent.contains("&scope=https%3A%2F%2Fmail.google.com%2F&"));
    let redirect = param(&consent, "redirect_uri");
    let port = redirect
        .strip_prefix("http://127.0.0.1:")
        .and_then(|rest| rest.strip_suffix("/callback"))
        .unwrap();
    assert!(port.parse::<u16>().is_ok());
    let challenge = param(&consent, "code_challenge");
    assert!(challenge.len() == 43 && is_base64url(&challenge));

    come_back(&consent, "code=auth-code").await;
    let signed_in = result.await.unwrap().unwrap();
    assert_eq!(
        signed_in,
        SignInResult {
            refresh_token: "RT".into(),
            access_token: "AT".into(),
            expires_at: 1_000_000.0 + 3_600_000.0,
            scope: None,
        }
    );

    let calls = s.transport.calls();
    assert_eq!(calls.len(), 1);
    let request = &calls[0];
    assert_eq!(request.url, "https://oauth.test/token");
    assert_eq!(request.method, crate::http::Method::Post);
    assert_eq!(
        request.header_value("content-type"),
        Some("application/x-www-form-urlencoded")
    );
    let body = form(request);
    let keys: Vec<&str> = body.iter().map(|(key, _)| key.as_str()).collect();
    assert_eq!(
        keys,
        [
            "grant_type",
            "code",
            "client_id",
            "client_secret",
            "redirect_uri",
            "code_verifier"
        ]
    );
    assert_eq!(body[0].1, "authorization_code");
    assert_eq!(body[1].1, "auth-code");
    assert_eq!(body[2].1, "cid");
    assert_eq!(body[3].1, "csecret");
    assert_eq!(body[4].1, redirect);
    assert_eq!(pkce_challenge(&body[5].1), challenge);
    // The loopback is closed once the sign-in is over.
    assert!(browser_get(format!("{redirect}?code=x&state=y"))
        .await
        .is_err());
}

#[tokio::test]
async fn rejects_the_first_sign_in_with_cancelled_when_a_second_one_starts() {
    let s = setup(replying(tokens(), 200));
    let first = s.sign_in();
    until(|| s.urls().len() == 1).await;
    // Not spawned and not yet polled: `sign_in()` itself must cancel the first session, so
    // nothing here depends on the order tokio runs tasks in.
    let mut second = s.auth.sign_in();
    assert_cancelled(first.await.unwrap());
    let (second, ()) = tokio::join!(&mut second, async {
        until(|| s.urls().len() == 2).await;
        s.auth.cancel();
    });
    assert_cancelled(second);
    assert!(s.transport.calls().is_empty());
}

#[tokio::test]
async fn cancel_before_the_sign_in_future_is_polled_cancels_it() {
    let s = setup(replying(tokens(), 200));
    let pending = s.auth.sign_in();
    s.auth.cancel();
    assert_cancelled(pending.await);
    assert!(s.urls().is_empty(), "the browser is never opened");
    assert!(s.transport.calls().is_empty());
    // An unpolled sign-in that is dropped cancels nothing later and leaves no session.
    let dropped = s.auth.sign_in();
    drop(dropped);
    let result = s.sign_in();
    until(|| s.urls().len() == 1).await;
    come_back(&s.urls()[0], "code=c").await;
    assert!(result.await.unwrap().is_ok());
}

#[tokio::test]
async fn cancel_closes_the_loopback_server_and_rejects_with_cancelled() {
    let s = setup(replying(tokens(), 200));
    let result = s.sign_in();
    until(|| s.urls().len() == 1).await;
    let redirect = param(&s.urls()[0], "redirect_uri");
    s.auth.cancel();
    assert_cancelled(result.await.unwrap());
    assert!(browser_get(format!("{redirect}?code=x&state=y"))
        .await
        .is_err());
}

#[tokio::test]
async fn rejects_with_denied_when_the_user_refuses_consent() {
    let s = setup(replying(tokens(), 200));
    let result = s.sign_in();
    until(|| s.urls().len() == 1).await;
    come_back(&s.urls()[0], "error=access_denied").await;
    assert_eq!(
        result.await.unwrap(),
        Err(SignInError::Auth(GmailAuthError::Denied))
    );
    assert!(s.transport.calls().is_empty());
}

#[tokio::test]
async fn rejects_with_invalid_response_on_a_malformed_or_refresh_less_token_response() {
    for body in [
        json!({ "nope": 1 }),
        json!({ "access_token": "AT", "expires_in": 1, "token_type": "Bearer" }),
    ] {
        let s = setup(replying(body, 200));
        let result = s.sign_in();
        until(|| s.urls().len() == 1).await;
        come_back(&s.urls()[0], "code=c").await;
        assert_eq!(
            result.await.unwrap(),
            Err(SignInError::Auth(GmailAuthError::InvalidResponse))
        );
    }
}

#[tokio::test]
async fn rejects_with_network_when_the_token_request_fails() {
    // Rust-only second reply: an unfollowed redirect is a failed request too (ruling M1).
    for reply in [failing(), replying(tokens(), 302)] {
        let s = setup(reply);
        let result = s.sign_in();
        until(|| s.urls().len() == 1).await;
        come_back(&s.urls()[0], "code=c").await;
        assert_eq!(
            result.await.unwrap(),
            Err(SignInError::Auth(GmailAuthError::Network))
        );
    }
}

#[tokio::test]
async fn rejects_with_network_when_the_browser_cannot_be_opened() {
    let tried = Arc::new(Mutex::new(Vec::<String>::new()));
    let opener: OpenExternal = {
        let tried = Arc::clone(&tried);
        Arc::new(move |url: String| {
            lock(&tried).push(url);
            Box::pin(async { Err("no browser".to_owned()) })
        })
    };
    let transport = Arc::new(FakeTransport {
        reply: failing(),
        calls: Mutex::new(Vec::new()),
        aborted: Arc::new(AtomicBool::new(false)),
    });
    let auth = GoogleAuth::new(
        Arc::clone(&transport) as Arc<dyn Transport>,
        opener,
        clock(),
        config(),
    );
    assert_eq!(
        auth.sign_in().await,
        Err(SignInError::Auth(GmailAuthError::Network))
    );
    assert!(transport.calls().is_empty());
    let redirect = param(&lock(&tried)[0], "redirect_uri");
    assert!(browser_get(format!("{redirect}?code=x&state=y"))
        .await
        .is_err());
}

// --- cancelling during the token exchange ---

struct Slow {
    setup: Setup,
    release: watch::Sender<bool>,
}

fn slow_setup() -> Slow {
    let (release, gate) = watch::channel(false);
    let reply: Reply = Arc::new(move |_| {
        let mut gate = gate.clone();
        Box::pin(async move {
            let _ = gate.wait_for(|open| *open).await;
            Ok(json_reply(tokens(), 200))
        })
    });
    Slow {
        setup: setup(reply),
        release,
    }
}

#[tokio::test]
async fn cancel_during_a_slow_token_request_rejects_with_cancelled_and_aborts_the_request() {
    let Slow { setup: s, release } = slow_setup();
    let result = s.sign_in();
    until(|| s.urls().len() == 1).await;
    come_back(&s.urls()[0], "code=c").await;
    until(|| s.transport.calls().len() == 1).await;
    s.auth.cancel();
    release.send_replace(true);
    assert_cancelled(result.await.unwrap());
    assert!(s.transport.aborted.load(Ordering::SeqCst));
}

#[tokio::test]
async fn a_second_sign_in_during_the_exchange_makes_the_first_reject_with_cancelled() {
    let Slow { setup: s, release } = slow_setup();
    let first = s.sign_in();
    until(|| s.urls().len() == 1).await;
    come_back(&s.urls()[0], "code=c").await;
    until(|| s.transport.calls().len() == 1).await;
    // Registered synchronously; polled once (it binds its loopback) before the first one's
    // `/token` answer is released, so the outcome cannot depend on the run-queue order.
    let mut second = s.auth.sign_in();
    assert!(tokio::time::timeout(Duration::ZERO, &mut second)
        .await
        .is_err());
    release.send_replace(true);
    assert_cancelled(first.await.unwrap());
    let (second, ()) = tokio::join!(&mut second, async {
        until(|| s.urls().len() == 2).await;
        s.auth.cancel();
    });
    assert_cancelled(second);
}

// --- refresh and revoke ---

#[tokio::test]
async fn refresh_sends_the_refresh_grant_and_returns_the_new_access_token() {
    let s = setup(replying(
        json!({ "access_token": "AT2", "expires_in": 100, "token_type": "Bearer" }),
        200,
    ));
    assert_eq!(
        s.auth.refresh("RT").await,
        Ok(RefreshResult {
            access_token: "AT2".into(),
            expires_at: 1_000_000.0 + 100_000.0,
            scope: None,
        })
    );
    let calls = s.transport.calls();
    assert_eq!(calls[0].url, "https://oauth.test/token");
    assert_eq!(calls[0].method, crate::http::Method::Post);
    assert_eq!(
        calls[0].header_value("content-type"),
        Some("application/x-www-form-urlencoded")
    );
    assert_eq!(
        form(&calls[0]),
        [
            ("grant_type".to_owned(), "refresh_token".to_owned()),
            ("refresh_token".to_owned(), "RT".to_owned()),
            ("client_id".to_owned(), "cid".to_owned()),
            ("client_secret".to_owned(), "csecret".to_owned()),
        ]
    );
    // Form encoding of the values (`URLSearchParams`).
    let tricky = setup(replying(
        json!({ "access_token": "AT2", "expires_in": 100, "token_type": "Bearer" }),
        200,
    ));
    tricky.auth.refresh("1//a b+c&d=é").await.unwrap();
    let body = String::from_utf8(tricky.transport.calls()[0].body.clone().unwrap()).unwrap();
    assert!(body.starts_with("grant_type=refresh_token&refresh_token=1%2F%2Fa+b%2Bc%26d%3D%C3%A9&"));
}

#[tokio::test]
async fn sign_in_passes_on_the_granted_scope_when_google_sends_it() {
    let mut body = tokens();
    body["scope"] = json!("https://mail.google.com/");
    let s = setup(replying(body, 200));
    let result = s.sign_in();
    until(|| s.urls().len() == 1).await;
    come_back(&s.urls()[0], "code=auth-code").await;
    assert_eq!(
        result.await.unwrap(),
        Ok(SignInResult {
            refresh_token: "RT".into(),
            access_token: "AT".into(),
            expires_at: 1_000_000.0 + 3_600_000.0,
            scope: Some("https://mail.google.com/".into()),
        })
    );
}

#[tokio::test]
async fn refresh_passes_on_the_granted_scope_when_google_sends_it() {
    let s = setup(replying(
        json!({ "access_token": "AT2", "expires_in": 100, "token_type": "Bearer", "scope": "https://www.googleapis.com/auth/gmail.readonly" }),
        200,
    ));
    assert_eq!(
        s.auth.refresh("RT").await,
        Ok(RefreshResult {
            access_token: "AT2".into(),
            expires_at: 1_000_000.0 + 100_000.0,
            scope: Some("https://www.googleapis.com/auth/gmail.readonly".into()),
        })
    );
}

#[tokio::test]
async fn refresh_maps_errors_400_401_denied_5xx_and_throws_network_bad_body_invalid_response() {
    async fn code(reply: Reply) -> Result<RefreshResult, GmailAuthError> {
        setup(reply).auth.refresh("RT").await
    }
    use GmailAuthError::{Denied, InvalidResponse, Network};
    assert_eq!(
        code(replying(json!({ "error": "invalid_grant" }), 400)).await,
        Err(Denied)
    );
    assert_eq!(code(replying(json!({}), 401)).await, Err(Denied));
    assert_eq!(code(replying(json!({}), 503)).await, Err(Network));
    assert_eq!(code(replying(json!({}), 429)).await, Err(Network));
    assert_eq!(
        code(replying(json!({ "nope": 1 }), 200)).await,
        Err(InvalidResponse)
    );
    assert_eq!(code(failing()).await, Err(Network));
    // Rust-only: other non-2xx statuses are the given failure; a redirect (never followed
    // here, followed by Electron) is `network`, so a captive portal never signs the user out
    // (ruling M1); a body over the cap is a failed fetch; a body that is not JSON is invalid.
    assert_eq!(code(replying(json!({}), 403)).await, Err(Denied));
    for redirect in [301, 302, 303, 307, 308] {
        assert_eq!(
            code(replying(json!({}), redirect)).await,
            Err(Network),
            "{redirect}"
        );
    }
    assert_eq!(code(replying(json!({}), 500)).await, Err(Network));
    assert_eq!(
        code(Arc::new(|_| Box::pin(async {
            Err(TransportError::BodyTooLarge)
        })))
        .await,
        Err(Network)
    );
    assert_eq!(
        code(Arc::new(|_| {
            Box::pin(async { Ok(HttpResponse::new(200).with_body("not json")) })
        }))
        .await,
        Err(InvalidResponse)
    );
    assert!(is_session_dead(Denied));
}

#[tokio::test]
async fn revoke_posts_the_token_and_never_throws_on_failure() {
    let s = setup(replying(json!({}), 200));
    s.auth.revoke("RT").await;
    let calls = s.transport.calls();
    assert_eq!(calls[0].url, "https://oauth.test/revoke");
    assert_eq!(calls[0].method, crate::http::Method::Post);
    assert_eq!(
        calls[0].header_value("content-type"),
        Some("application/x-www-form-urlencoded")
    );
    assert_eq!(form(&calls[0]), [("token".to_owned(), "RT".to_owned())]);

    let failing = setup(failing());
    failing.auth.revoke("RT").await;
    assert_eq!(failing.transport.calls().len(), 1);
    let rejected = setup(replying(json!({ "error": "invalid_token" }), 400));
    rejected.auth.revoke("RT").await;
}

// --- request timeout ---

#[tokio::test(start_paused = true)]
async fn a_stalled_refresh_rejects_with_network_after_the_timeout_30_s_by_default() {
    let s = setup(hung());
    let started = tokio::time::Instant::now();
    assert_eq!(s.auth.refresh("RT").await, Err(GmailAuthError::Network));
    assert_eq!(started.elapsed(), Duration::from_secs(30));
    assert!(s.transport.aborted.load(Ordering::SeqCst));
}

#[tokio::test(start_paused = true)]
async fn a_stalled_revoke_resolves_after_the_timeout() {
    let s = setup(hung());
    let started = tokio::time::Instant::now();
    s.auth.revoke("RT").await;
    assert_eq!(started.elapsed(), Duration::from_secs(30));
    assert!(s.transport.aborted.load(Ordering::SeqCst));
}

#[tokio::test]
async fn a_stalled_code_exchange_rejects_with_network_not_cancelled() {
    let s = setup_with(hung(), |auth| {
        auth.with_timeouts(Duration::from_millis(20), LOOPBACK_TIMEOUT)
    });
    let result = s.sign_in();
    until(|| s.urls().len() == 1).await;
    come_back(&s.urls()[0], "code=c").await;
    assert_eq!(
        result.await.unwrap(),
        Err(SignInError::Auth(GmailAuthError::Network))
    );
    assert!(s.transport.aborted.load(Ordering::SeqCst));
}

#[test]
fn uses_a_30_s_timeout_when_none_is_given() {
    assert_eq!(AUTH_TIMEOUT, Duration::from_millis(30_000));
    let s = setup(failing());
    assert_eq!(s.auth.request_timeout(), AUTH_TIMEOUT);
    assert_eq!(s.auth.loopback_timeout(), LOOPBACK_TIMEOUT);
}

// --- Rust-only ---

#[test]
fn errors_carry_only_their_code() {
    use GmailAuthError::*;
    let codes: Vec<&str> = [Cancelled, Timeout, Denied, Network, InvalidResponse]
        .into_iter()
        .map(GmailAuthError::code)
        .collect();
    assert_eq!(
        codes,
        [
            "cancelled",
            "timeout",
            "denied",
            "network",
            "invalid-response"
        ]
    );
    assert_eq!(
        InvalidResponse.to_string(),
        "Gmail auth failed: invalid-response"
    );
    assert!(is_session_dead(Denied));
    for other in [Cancelled, Timeout, Network, InvalidResponse] {
        assert!(!is_session_dead(other));
    }
    assert_eq!(SignInError::Auth(Network).code(), "network");
    assert_eq!(
        SignInError::Setup(std::io::ErrorKind::AddrInUse).code(),
        "AddrInUse"
    );
    assert!(SignInError::Auth(Cancelled).is_cancelled());
    assert!(!SignInError::Auth(Denied).is_cancelled());
    assert!(!SignInError::Setup(std::io::ErrorKind::Other).is_cancelled());
}

#[test]
fn the_oauth_endpoints_follow_the_base_override() {
    let google = GoogleAuthConfig::new("cid", "csecret", None);
    assert_eq!(google.oauth_base, "https://oauth2.googleapis.com");
    assert_eq!(
        google.auth_url,
        "https://accounts.google.com/o/oauth2/v2/auth"
    );
    assert_eq!(GOOGLE_OAUTH_BASE, google.oauth_base);
    assert_eq!(GOOGLE_AUTH_URL, google.auth_url);
    let fake = GoogleAuthConfig::new("cid", "csecret", Some("http://127.0.0.1:4545"));
    assert_eq!(fake.oauth_base, "http://127.0.0.1:4545");
    assert_eq!(fake.auth_url, "http://127.0.0.1:4545/o/oauth2/v2/auth");
    assert_eq!(fake.client_id, "cid");
    assert_eq!(fake.client_secret, "csecret");
}

#[test]
fn debug_never_prints_a_secret() {
    let pkce = Pkce::from_random(|n| Ok(vec![7; n])).unwrap();
    let signed_in = SignInResult {
        refresh_token: "RT-SECRET".into(),
        access_token: "AT-SECRET".into(),
        expires_at: 1.0,
        scope: Some("https://mail.google.com/".into()),
    };
    let refreshed = RefreshResult {
        access_token: "AT-SECRET".into(),
        expires_at: 1.0,
        scope: None,
    };
    let config = GoogleAuthConfig::new("cid-SECRET", "csecret-SECRET", None);
    let printed = format!("{pkce:?} {signed_in:?} {refreshed:?} {config:?}");
    for secret in [
        pkce.verifier.as_str(),
        pkce.challenge.as_str(),
        pkce.state.as_str(),
        "SECRET",
    ] {
        assert!(!printed.contains(secret), "{printed}");
    }
    assert!(printed.contains("expires_at"));
}

#[tokio::test]
async fn cancel_without_a_sign_in_does_nothing() {
    let s = setup(replying(tokens(), 200));
    s.auth.cancel();
    let result = s.sign_in();
    until(|| s.urls().len() == 1).await;
    come_back(&s.urls()[0], "code=c").await;
    assert!(result.await.unwrap().is_ok());
}
