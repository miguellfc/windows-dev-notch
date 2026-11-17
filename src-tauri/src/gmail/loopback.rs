//! The OAuth redirect listener (`src/main/gmail/loopback.ts`): a one-shot HTTP/1.1 server on
//! `127.0.0.1` (IPv4 only, a port the OS picks) that waits for Google's redirect to
//! `/callback` with the expected `state`.
//!
//! Per request, in this order: already finished -> 410; another path -> 404; not `GET` -> 405;
//! another `state` -> 400 (and keep waiting); an `error` -> the page, then `denied`
//! (`access_denied`) or `invalid-response`; no `code` -> 400 (and keep waiting); else the page and
//! the code. Every answer carries `content-type`, `cache-control: no-store` and
//! `connection: close`. It settles once: with the code, an error, `timeout` after the lifetime
//! (a real timer, not the test clock) or `cancelled` on [`LoopbackCloser::close`] (or when the
//! code future is dropped). On settling the listener is dropped first (later connects are
//! refused), then the code future resolves; a reply in flight still flushes.
//!
//! Shares hyper and tokio with the Claude bridge, not its module. Nothing here is logged: the
//! query holds the authorization code and the state.

use std::convert::Infallible;
use std::future::Future;
use std::io;
use std::net::Ipv4Addr;
use std::pin::{pin, Pin};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;

use http_body_util::Full;
use hyper::body::{Bytes, Incoming};
use hyper::header::{HeaderValue, CACHE_CONTROL, CONNECTION, CONTENT_TYPE};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, watch};
use tokio::time::Instant;

use super::auth::GmailAuthError;

/// `LOOPBACK_TIMEOUT_MS`: how long the browser has to come back.
pub const LOOPBACK_TIMEOUT: Duration = Duration::from_secs(300);
pub const CALLBACK_PATH: &str = "/callback";
/// The fixed page the browser shows once it is back (the E2E looks for `Developer Notch`).
pub const PAGE: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Developer Notch</title></head><body style=\"font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0\"><p>You can close this tab and go back to Developer Notch.</p></body></html>";

/// A connection that sends no request head in this time is dropped.
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);
/// After settling, a connection gets this long to flush its reply.
const FLUSH_GRACE: Duration = Duration::from_secs(5);
const PLAIN: &str = "text/plain; charset=utf-8";
const HTML: &str = "text/html; charset=utf-8";

type Outcome = Result<String, GmailAuthError>;

struct Shared {
    state: String,
    /// The settle side; `None` once settled (`finished`).
    settle: Mutex<Option<oneshot::Sender<Outcome>>>,
    /// Turns true on settling: open connections finish their reply and close.
    finished: watch::Sender<bool>,
}

impl Shared {
    fn settle(&self) -> MutexGuard<'_, Option<oneshot::Sender<Outcome>>> {
        self.settle.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `finish()`: settles once; later calls do nothing.
    fn finish(&self, outcome: Outcome) {
        finish_locked(&mut self.settle(), &self.finished, outcome);
    }

    /// The answer to one request (and, for the callback, the settlement).
    fn respond(&self, method: &Method, target: &str) -> Response<Full<Bytes>> {
        let mut settle = self.settle();
        if settle.is_none() {
            return reply(StatusCode::GONE, "", PLAIN);
        }
        // `new URL(req.url, 'http://127.0.0.1')`.
        let Ok(url) = url::Url::options().base_url(Some(&base())).parse(target) else {
            return reply(StatusCode::NOT_FOUND, "", PLAIN);
        };
        if url.path() != CALLBACK_PATH {
            return reply(StatusCode::NOT_FOUND, "", PLAIN);
        }
        if method != Method::GET {
            return reply(StatusCode::METHOD_NOT_ALLOWED, "", PLAIN);
        }
        // `searchParams.get(name)`: the first value, form-decoded.
        let get = |name: &str| {
            url.query_pairs()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.into_owned())
        };
        if get("state").as_deref() != Some(self.state.as_str()) {
            return reply(StatusCode::BAD_REQUEST, "", PLAIN);
        }
        if let Some(error) = get("error").filter(|error| !error.is_empty()) {
            let outcome = if error == "access_denied" {
                GmailAuthError::Denied
            } else {
                GmailAuthError::InvalidResponse
            };
            finish_locked(&mut settle, &self.finished, Err(outcome));
            return reply(StatusCode::OK, PAGE, HTML);
        }
        let Some(code) = get("code").filter(|code| !code.is_empty()) else {
            return reply(StatusCode::BAD_REQUEST, "", PLAIN);
        };
        finish_locked(&mut settle, &self.finished, Ok(code));
        reply(StatusCode::OK, PAGE, HTML)
    }
}

fn finish_locked(
    settle: &mut Option<oneshot::Sender<Outcome>>,
    finished: &watch::Sender<bool>,
    outcome: Outcome,
) {
    if let Some(sender) = settle.take() {
        finished.send_replace(true);
        // The accept loop drops the listener, then hands the outcome to the code future.
        let _ = sender.send(outcome);
    }
}

fn base() -> url::Url {
    url::Url::parse("http://127.0.0.1").expect("a valid base URL")
}

fn reply(
    status: StatusCode,
    body: &'static str,
    content_type: &'static str,
) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::from_static(body.as_bytes())));
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(CONNECTION, HeaderValue::from_static("close"));
    response
}

/// Resolves with the authorization code or a [`GmailAuthError`]. Dropping it closes the
/// listener (as [`LoopbackCloser::close`]).
pub struct LoopbackCode {
    receiver: oneshot::Receiver<Outcome>,
    shared: Arc<Shared>,
}

impl Future for LoopbackCode {
    type Output = Outcome;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Outcome> {
        Pin::new(&mut self.receiver)
            .poll(cx)
            // The accept loop is gone without settling (its runtime shut down).
            .map(|outcome| outcome.unwrap_or(Err(GmailAuthError::Cancelled)))
    }
}

impl Drop for LoopbackCode {
    fn drop(&mut self) {
        self.shared.finish(Err(GmailAuthError::Cancelled));
    }
}

/// `close()`: settles a pending wait with `cancelled` and stops listening; idempotent.
#[derive(Clone)]
pub struct LoopbackCloser(Arc<Shared>);

impl LoopbackCloser {
    pub fn close(&self) {
        self.0.finish(Err(GmailAuthError::Cancelled));
    }
}

/// A started listener. `Debug` shows no state.
pub struct Loopback {
    /// `http://127.0.0.1:<port>/callback`.
    pub redirect_uri: String,
    pub code: LoopbackCode,
    pub closer: LoopbackCloser,
}

impl Loopback {
    pub fn close(&self) {
        self.closer.close();
    }
}

impl std::fmt::Debug for Loopback {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Loopback").finish_non_exhaustive()
    }
}

/// `startLoopback({state, timeoutMs})`: binds `127.0.0.1:0` and waits for the redirect for at
/// most `timeout`. A bind failure is returned as is. Must run inside a tokio runtime.
pub async fn start(state: &str, timeout: Duration) -> io::Result<Loopback> {
    // The deadline is fixed now, not when the accept loop first runs.
    let deadline = Instant::now() + timeout;
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let port = listener.local_addr()?.port();
    let (settle_tx, settle_rx) = oneshot::channel();
    let (code_tx, code_rx) = oneshot::channel();
    let shared = Arc::new(Shared {
        state: state.to_owned(),
        settle: Mutex::new(Some(settle_tx)),
        finished: watch::channel(false).0,
    });
    tokio::spawn(accept_loop(
        listener,
        Arc::clone(&shared),
        settle_rx,
        code_tx,
        deadline,
    ));
    Ok(Loopback {
        redirect_uri: format!("http://127.0.0.1:{port}{CALLBACK_PATH}"),
        code: LoopbackCode {
            receiver: code_rx,
            shared: Arc::clone(&shared),
        },
        closer: LoopbackCloser(shared),
    })
}

async fn accept_loop(
    listener: TcpListener,
    shared: Arc<Shared>,
    mut settled: oneshot::Receiver<Outcome>,
    code: oneshot::Sender<Outcome>,
    deadline: Instant,
) {
    let mut timer = pin!(tokio::time::sleep_until(deadline));
    let outcome = loop {
        tokio::select! {
            biased;
            outcome = &mut settled => break outcome.unwrap_or(Err(GmailAuthError::Cancelled)),
            () = &mut timer => shared.finish(Err(GmailAuthError::Timeout)),
            accepted = listener.accept() => match accepted {
                Ok((stream, _)) => {
                    tokio::spawn(serve(stream, Arc::clone(&shared)));
                }
                // A failed accept (the peer reset first) never ends the wait.
                Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
            },
        }
    };
    // `server.close()` before the caller hears: a later connect is refused.
    drop(listener);
    let _ = code.send(outcome);
}

/// One connection. Once the loopback settles, the reply in flight flushes and the connection
/// closes (`closeAllConnections()` after the flush), within [`FLUSH_GRACE`].
async fn serve(stream: TcpStream, shared: Arc<Shared>) {
    let _ = stream.set_nodelay(true);
    let mut finished = shared.finished.subscribe();
    let service = service_fn(move |request: Request<Incoming>| {
        let response = shared.respond(request.method(), &request.uri().to_string());
        async move { Ok::<_, Infallible>(response) }
    });
    let mut connection = pin!(http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(HEADER_TIMEOUT)
        .serve_connection(TokioIo::new(stream), service));
    tokio::select! {
        _ = connection.as_mut() => return,
        _ = finished.wait_for(|finished| *finished) => {}
    }
    connection.as_mut().graceful_shutdown();
    let _ = tokio::time::timeout(FLUSH_GRACE, connection).await;
}

#[cfg(test)]
#[path = "loopback_tests.rs"]
mod tests;
