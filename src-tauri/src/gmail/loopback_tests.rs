//! 0.1.0's `gmail-loopback.test.ts` (8 cases) plus Rust-only edges. Every request is a
//! real HTTP request over 127.0.0.1 (the shared reqwest transport); nothing leaves the machine.

use std::time::Duration;

use super::*;
use crate::http::{HttpRequest, HttpResponse, ReqwestTransport, Transport, TransportError};

const STATE: &str = "good-state";

async fn start_default() -> Loopback {
    start(STATE, LOOPBACK_TIMEOUT)
        .await
        .expect("the loopback binds")
}

async fn send(request: HttpRequest) -> Result<HttpResponse, TransportError> {
    ReqwestTransport::new().unwrap().send(request).await
}

async fn get(url: String) -> Result<HttpResponse, TransportError> {
    send(HttpRequest::get(url)).await
}

async fn status(url: String) -> u16 {
    get(url).await.expect("the loopback answers").status
}

/// True when `code` has not settled yet (polled once, without waiting).
async fn pending(code: &mut LoopbackCode) -> bool {
    tokio::time::timeout(Duration::ZERO, code).await.is_err()
}

fn port_of(redirect_uri: &str) -> u16 {
    redirect_uri
        .strip_prefix("http://127.0.0.1:")
        .and_then(|rest| rest.strip_suffix("/callback"))
        .and_then(|port| port.parse().ok())
        .expect("a 127.0.0.1 redirect uri")
}

#[tokio::test]
async fn listens_on_127_0_0_1_and_builds_the_redirect_uri() {
    let loopback = start_default().await;
    let port = port_of(&loopback.redirect_uri);
    assert_ne!(port, 0, "a real port, chosen by the OS");
    assert_eq!(
        loopback.redirect_uri,
        format!("http://127.0.0.1:{port}/callback")
    );
    loopback.close();
}

#[tokio::test]
async fn answers_400_to_a_wrong_state_and_keeps_waiting() {
    let Loopback {
        redirect_uri,
        mut code,
        closer,
    } = start_default().await;
    assert_eq!(
        status(format!("{redirect_uri}?code=abc&state=evil")).await,
        400
    );
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(pending(&mut code).await);
    assert_eq!(
        status(format!("{redirect_uri}?code=abc&state=good-state")).await,
        200
    );
    assert_eq!(code.await, Ok("abc".to_owned()));
    closer.close();
}

#[tokio::test]
async fn answers_405_to_post_and_404_to_other_paths() {
    let Loopback {
        redirect_uri,
        mut code,
        closer,
    } = start_default().await;
    let post = send(HttpRequest::post(
        format!("{redirect_uri}?code=abc&state=good-state"),
        Vec::new(),
    ))
    .await
    .unwrap();
    assert_eq!(post.status, 405);
    let other = redirect_uri.replace("/callback", "/other?code=abc&state=good-state");
    assert_eq!(status(other).await, 404);
    assert!(pending(&mut code).await);
    closer.close();
}

#[tokio::test]
async fn answers_400_when_the_code_is_missing() {
    let Loopback {
        redirect_uri,
        mut code,
        closer,
    } = start_default().await;
    assert_eq!(
        status(format!("{redirect_uri}?state=good-state")).await,
        400
    );
    // An empty code is no code either (`if (!authCode)`), and the wait goes on.
    assert_eq!(
        status(format!("{redirect_uri}?code=&state=good-state")).await,
        400
    );
    assert!(pending(&mut code).await);
    closer.close();
}

#[tokio::test]
async fn resolves_with_the_code_replies_with_minimal_html_and_closes_the_server() {
    let Loopback {
        redirect_uri, code, ..
    } = start_default().await;
    let response = get(format!("{redirect_uri}?code=the-code&state=good-state"))
        .await
        .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(
        response.header("content-type").as_deref(),
        Some("text/html; charset=utf-8")
    );
    assert_eq!(
        response.header("cache-control").as_deref(),
        Some("no-store")
    );
    assert_eq!(response.header("connection").as_deref(), Some("close"));
    let body = String::from_utf8(response.body).unwrap();
    assert!(body.contains("<html"));
    assert!(body.contains("Developer Notch"));
    assert_eq!(body, PAGE);
    assert_eq!(code.await, Ok("the-code".to_owned()));
    assert!(
        get(format!("{redirect_uri}?code=x&state=good-state"))
            .await
            .is_err(),
        "the listener is gone once the code is out"
    );
}

#[tokio::test]
async fn rejects_with_denied_when_the_user_refuses() {
    let Loopback {
        redirect_uri, code, ..
    } = start_default().await;
    let response = get(format!(
        "{redirect_uri}?error=access_denied&state=good-state"
    ))
    .await
    .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(String::from_utf8(response.body).unwrap(), PAGE);
    assert_eq!(code.await, Err(GmailAuthError::Denied));
}

#[tokio::test(start_paused = true)]
async fn rejects_with_timeout_after_the_lifetime_and_stops_listening() {
    let Loopback {
        redirect_uri,
        mut code,
        closer,
    } = start(STATE, Duration::from_millis(300_000)).await.unwrap();
    tokio::time::advance(Duration::from_millis(299_999)).await;
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    assert!(pending(&mut code).await);
    tokio::time::advance(Duration::from_millis(2)).await;
    assert_eq!(code.await, Err(GmailAuthError::Timeout));
    // A raw connect (no client timers under the paused clock): nothing listens any more.
    let port = port_of(&redirect_uri);
    assert!(tokio::net::TcpStream::connect(("127.0.0.1", port))
        .await
        .is_err());
    closer.close();
}

#[tokio::test]
async fn close_rejects_a_pending_wait_with_cancelled() {
    let Loopback {
        redirect_uri,
        code,
        closer,
    } = start_default().await;
    closer.close();
    assert_eq!(code.await, Err(GmailAuthError::Cancelled));
    assert!(get(format!("{redirect_uri}?code=x&state=good-state"))
        .await
        .is_err());
}

// Rust-only edges.

#[tokio::test]
async fn checks_run_in_the_ts_order() {
    let Loopback {
        redirect_uri,
        mut code,
        closer,
    } = start_default().await;
    // The path before the method and the state; the method before the state.
    let other = redirect_uri.replace("/callback", "/other?state=evil");
    assert_eq!(status(other).await, 404);
    let post = send(HttpRequest::post(
        format!("{redirect_uri}?state=evil"),
        Vec::new(),
    ))
    .await
    .unwrap();
    assert_eq!(post.status, 405);
    // The state before the error: a forged error never ends the wait.
    assert_eq!(
        status(format!("{redirect_uri}?error=access_denied&state=evil")).await,
        400
    );
    assert_eq!(
        status(format!("{redirect_uri}?error=access_denied")).await,
        400
    );
    // A query-less or path-encoded callback is not the callback with the state.
    assert_eq!(status(redirect_uri.clone()).await, 400);
    assert_eq!(
        status(redirect_uri.replace("/callback", "/%63allback?code=a&state=good-state")).await,
        404
    );
    // The first `state` counts (`searchParams.get`); form decoding applies.
    assert_eq!(
        status(format!("{redirect_uri}?state=evil&state=good-state&code=a")).await,
        400
    );
    assert!(pending(&mut code).await);
    let response = get(format!("{redirect_uri}?state=good%2Dstate&code=a+b%21"))
        .await
        .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(code.await, Ok("a b!".to_owned()));
    closer.close();
}

#[tokio::test]
async fn bad_requests_answer_plain_text_with_no_store_and_close() {
    let loopback = start_default().await;
    let response = get(format!("{}?state=evil", loopback.redirect_uri))
        .await
        .unwrap();
    assert_eq!(response.status, 400);
    assert_eq!(
        response.header("content-type").as_deref(),
        Some("text/plain; charset=utf-8")
    );
    assert_eq!(
        response.header("cache-control").as_deref(),
        Some("no-store")
    );
    assert_eq!(response.header("connection").as_deref(), Some("close"));
    assert!(response.body.is_empty());
    loopback.close();
}

#[tokio::test]
async fn an_error_other_than_access_denied_is_an_invalid_response() {
    let Loopback {
        redirect_uri, code, ..
    } = start_default().await;
    let response = get(format!(
        "{redirect_uri}?error=server_error&code=ignored&state=good-state"
    ))
    .await
    .unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(code.await, Err(GmailAuthError::InvalidResponse));
}

#[tokio::test]
async fn it_settles_once_and_dropping_the_code_closes_the_server() {
    let Loopback {
        redirect_uri,
        code,
        closer,
    } = start_default().await;
    closer.close();
    closer.close();
    assert_eq!(code.await, Err(GmailAuthError::Cancelled));

    let Loopback {
        redirect_uri: second,
        code,
        ..
    } = start_default().await;
    drop(code);
    assert!(get(format!("{second}?code=x&state=good-state"))
        .await
        .is_err());
    assert!(get(format!("{redirect_uri}?code=x&state=good-state"))
        .await
        .is_err());
}

#[test]
fn the_page_and_limits_match_the_ts() {
    assert_eq!(LOOPBACK_TIMEOUT, Duration::from_millis(300_000));
    assert_eq!(CALLBACK_PATH, "/callback");
    assert_eq!(
        PAGE,
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>Developer Notch</title></head><body style=\"font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0\"><p>You can close this tab and go back to Developer Notch.</p></body></html>"
    );
}
