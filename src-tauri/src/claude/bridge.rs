//! The Claude Code hooks bridge (port of `src/main/claude/claude-bridge.ts`): a loopback-only
//! HTTP/1.1 server Claude Code's `http` hooks POST to.
//!
//! Every request is checked on its head, in this order, before any of its body is read: Host,
//! token, path, method, content type, declared size. Then the body is read up to
//! [`MAX_BODY_BYTES`] (with or without `content-length`), parsed and turned into a [`HookEvent`].
//! Every answer but a held one is the status alone (`connection: close`, empty body). A held
//! request stays open until the app answers it, Claude disconnects or the bridge stops.
//!
//! Deviations from Node, all answered 400 (Claude then falls back to its own dialog): numbers
//! beyond the double range (`1e400`, which `JSON.parse` reads as Infinity), lone UTF-16 surrogate
//! escapes and nesting deeper than 128 levels, which serde_json refuses.
//!
//! Logs carry the method, the path, the status (or `held`) and the event name, never the body,
//! the token or any preview.

use std::convert::Infallible;
use std::future::{poll_fn, Future};
use std::io;
use std::net::Ipv4Addr;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::pin::Pin;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use http_body_util::{BodyExt, Full};
use hyper::body::{Body as _, Bytes, Incoming};
use hyper::header::{HeaderValue, CONNECTION, CONTENT_TYPE, HOST};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;

use super::hook_events::{parse_hook_event, HookEvent, HookEventName, ASK_USER_QUESTION_TOOL};
use crate::contract::string_enum;
use crate::contract::text::is_js_whitespace;

pub const MAX_BODY_BYTES: usize = 262_144;
pub const TOKEN_HEADER: &str = "x-notch-token";
/// How long `stop()` lets pending replies (e.g. `release_all`'s empty 200s) flush before closing
/// the remaining connections.
pub const STOP_GRACE_MS: u64 = 500;

/// After its response, a connection reads (and drops) what the client still sends for this long
/// at most, so closing it never resets the response away (Node's lingering close).
const LINGER: Duration = Duration::from_secs(1);
const LINGER_MAX_BYTES: usize = 1 << 20;

/// Node's `server.headersTimeout`: a connection that has not sent a whole request head by then
/// is closed (no answer), so idle or slowly dripping clients cannot pile up.
pub const HEADERS_TIMEOUT: Duration = Duration::from_secs(60);
/// Body deadline (408), counted from when the request head has arrived, not from the
/// connection: unlike Node's `server.requestTimeout`, a client can take up to
/// [`HEADERS_TIMEOUT`] for the head and then this long again for the body (worst case 60 s +
/// 300 s). It never covers the wait of a held request (Claude's hook timeout is 3600 s).
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
/// Largest request head (Node's 16 KiB `maxHeaderSize`); hyper answers a longer one with 431.
/// It is also the size of hyper's read buffer, so the body arrives in pieces of at most this.
const MAX_HEAD_BYTES: usize = 16 * 1024;

string_enum! {
    /// Which hook URL an event came in on. `hook`: every event of our hook groups. `question`:
    /// only our AskUserQuestion group (`/hook/question`), the one route whose requests are held
    /// for an answer.
    pub enum HookRoute {
        Hook = "hook",
        Question = "question",
    }
}

/// A held hook request, answered once by the app (`PendingReply` in TS).
pub trait PendingReply: Send + Sync {
    /// When the request arrived (ms since the epoch), the origin of the alert latency.
    fn arrived_at(&self) -> Option<u64>;
    /// Answers 200, with `body` as JSON or empty for `None`. Only the first call acts; never
    /// fails, even when Claude is gone.
    fn send(&self, body: Option<String>);
    /// `callback` runs if the connection closes before [`PendingReply::send`] (at once when it
    /// already has).
    fn on_close(&self, callback: Box<dyn FnOnce() + Send>);
}

/// Receives every accepted event, with its reply when the request is held.
pub type OnEvent = Arc<dyn Fn(HookEvent, Option<Arc<dyn PendingReply>>, HookRoute) + Send + Sync>;

#[derive(Debug)]
pub enum BridgeError {
    /// `EADDRINUSE`: the service reports `port-in-use`.
    PortInUse,
    Other(io::Error),
}

impl std::fmt::Display for BridgeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PortInUse => f.write_str("EADDRINUSE"),
            Self::Other(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for BridgeError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Running,
    /// `stop()` was called: no new connections; open ones finish what they were sending.
    Graceful,
    /// [`STOP_GRACE_MS`] are over: every connection still open is closed.
    Force,
}

/// What every connection shares.
struct Shared {
    token: Vec<u8>,
    port: AtomicU16,
    on_event: OnEvent,
    /// Arrival stamp of the last held request.
    held_at: Mutex<u64>,
    headers_timeout: Duration,
    request_timeout: Duration,
}

enum State {
    Idle,
    Running {
        phase: watch::Sender<Phase>,
        /// Closes (recv -> None) once the accept loop and every connection task have ended.
        connections: mpsc::Receiver<()>,
        done_tx: watch::Sender<bool>,
        done: watch::Receiver<bool>,
    },
    Stopping {
        done: watch::Receiver<bool>,
    },
}

/// `createClaudeBridge`.
pub struct ClaudeBridge {
    requested_port: u16,
    shared: Arc<Shared>,
    state: Mutex<State>,
}

impl ClaudeBridge {
    pub fn new(port: u16, token: &str, on_event: OnEvent) -> Self {
        Self::with_timeouts(port, token, on_event, HEADERS_TIMEOUT, REQUEST_TIMEOUT)
    }

    /// [`ClaudeBridge::new`] with other timeouts (tests).
    pub(crate) fn with_timeouts(
        port: u16,
        token: &str,
        on_event: OnEvent,
        headers_timeout: Duration,
        request_timeout: Duration,
    ) -> Self {
        Self {
            requested_port: port,
            shared: Arc::new(Shared {
                token: token.as_bytes().to_vec(),
                port: AtomicU16::new(port),
                on_event,
                held_at: Mutex::new(0),
                headers_timeout,
                request_timeout,
            }),
            state: Mutex::new(State::Idle),
        }
    }

    /// Listens on `127.0.0.1:<port>`; returns the actual port (port 0 picks a free one). Must
    /// run inside a tokio runtime, which then serves the connections.
    pub async fn start(&self) -> Result<u16, BridgeError> {
        match &*lock(&self.state) {
            State::Idle => {}
            State::Running { .. } => return Ok(self.port()),
            State::Stopping { .. } => {
                return Err(BridgeError::Other(io::Error::other(
                    "the bridge was stopped",
                )))
            }
        }
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, self.requested_port))
            .await
            .map_err(|error| match error.kind() {
                io::ErrorKind::AddrInUse => BridgeError::PortInUse,
                _ => BridgeError::Other(error),
            })?;
        let port = listener.local_addr().map_err(BridgeError::Other)?.port();
        self.shared.port.store(port, Ordering::SeqCst);

        let (phase, phase_rx) = watch::channel(Phase::Running);
        let (connection_tx, connections) = mpsc::channel(1);
        let (done_tx, done) = watch::channel(false);
        tokio::spawn(accept_loop(
            listener,
            self.shared.clone(),
            phase_rx,
            connection_tx,
        ));
        *lock(&self.state) = State::Running {
            phase,
            connections,
            done_tx,
            done,
        };
        log::info!("bridge listening {port}");
        Ok(port)
    }

    /// The listening port (the requested one before `start`).
    pub fn port(&self) -> u16 {
        self.shared.port.load(Ordering::SeqCst)
    }

    /// Stops accepting, lets already-sent responses flush and closes whatever is still open
    /// after [`STOP_GRACE_MS`]. Idempotent; returns once everything is closed. Like `start`, it
    /// must run inside a tokio runtime (the stop sequence is a task of its own).
    pub async fn stop(&self) {
        let mut done = {
            let mut state = lock(&self.state);
            match std::mem::replace(&mut *state, State::Idle) {
                State::Idle => return,
                State::Stopping { done } => {
                    *state = State::Stopping { done: done.clone() };
                    done
                }
                State::Running {
                    phase,
                    connections,
                    done_tx,
                    done,
                } => {
                    *state = State::Stopping { done: done.clone() };
                    // Its own task, so a caller that gives up waiting never leaves it half done.
                    tokio::spawn(stop_sequence(phase, connections, done_tx));
                    done
                }
            }
        };
        let _ = done.wait_for(|done| *done).await;
    }
}

async fn stop_sequence(
    phase: watch::Sender<Phase>,
    mut connections: mpsc::Receiver<()>,
    done: watch::Sender<bool>,
) {
    phase.send_replace(Phase::Graceful);
    let grace = Duration::from_millis(STOP_GRACE_MS);
    if tokio::time::timeout(grace, connections.recv())
        .await
        .is_err()
    {
        phase.send_replace(Phase::Force);
        let _ = connections.recv().await;
    }
    done.send_replace(true);
}

async fn accept_loop(
    listener: TcpListener,
    shared: Arc<Shared>,
    phase: watch::Receiver<Phase>,
    connection: mpsc::Sender<()>,
) {
    let mut stopping = phase.clone();
    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            _ = async { stopping.wait_for(|phase| *phase != Phase::Running).await.is_ok() } => break,
        };
        match accepted {
            Ok((stream, _)) => {
                tokio::spawn(serve(
                    stream,
                    shared.clone(),
                    phase.clone(),
                    connection.clone(),
                ));
            }
            Err(error) => {
                // Runtime errors after start never stop the bridge.
                log::error!("bridge server error: {error}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

type BoxedResponse =
    Pin<Box<dyn Future<Output = Result<Response<Full<Bytes>>, Infallible>> + Send>>;

/// One connection: a single request (every answer closes it), then a lingering close.
/// `_connection` is dropped when the task ends, which is how `stop()` knows it is gone.
async fn serve(
    stream: TcpStream,
    shared: Arc<Shared>,
    mut phase: watch::Receiver<Phase>,
    _connection: mpsc::Sender<()>,
) {
    let _ = stream.set_nodelay(true);
    let headers_timeout = shared.headers_timeout;
    let service = service_fn(move |request| -> BoxedResponse {
        let shared = shared.clone();
        Box::pin(async move { Ok(handle(request, &shared).await) })
    });
    // hyper drops its default header timeout unless a timer is set.
    let mut connection = http1::Builder::new()
        .timer(TokioTimer::new())
        .header_read_timeout(headers_timeout)
        .max_buf_size(MAX_HEAD_BYTES)
        .serve_connection(TokioIo::new(stream), service);
    let mut graceful = false;
    let result = loop {
        match *phase.borrow_and_update() {
            Phase::Running => {}
            Phase::Graceful if !graceful => {
                graceful = true;
                Pin::new(&mut connection).graceful_shutdown();
            }
            Phase::Graceful => {}
            // Dropping the connection drops a held request's future: its close guard fires.
            Phase::Force => return,
        }
        tokio::select! {
            result = poll_fn(|cx| connection.poll_without_shutdown(cx)) => break result,
            changed = phase.changed() => {
                if changed.is_err() {
                    // The bridge itself was dropped.
                    return;
                }
            }
        }
    };
    // On an error too: hyper may have answered a malformed or oversized head (400/431) with bytes
    // of it still unread, and a plain close would reset that answer away. When Claude went away
    // (a held request's guard already fired) the drain ends at once.
    let _ = result;
    let stream = connection.into_parts().io.into_inner();
    linger(stream, phase).await;
}

/// Sends FIN after the response, then reads whatever the client still sends until it closes,
/// so the close never turns into a reset that could discard the response on the client side.
async fn linger(mut stream: TcpStream, mut phase: watch::Receiver<Phase>) {
    let _ = stream.shutdown().await;
    let drain = async {
        let mut buf = [0u8; 8192];
        let mut total = 0;
        while let Ok(read @ 1..) = stream.read(&mut buf).await {
            total += read;
            if total > LINGER_MAX_BYTES {
                break;
            }
        }
    };
    tokio::select! {
        _ = tokio::time::timeout(LINGER, drain) => {}
        // `stop()` ends the drain at once: the response was already flushed and FIN sent.
        _ = phase.wait_for(|phase| *phase != Phase::Running) => {}
    }
}

/// The whole check sequence of one request (`handle` in TS).
async fn handle(request: Request<Incoming>, shared: &Shared) -> Response<Full<Bytes>> {
    // Start of the alert latency the usage log measures: body read + parse + dispatch.
    let arrived_at = now_ms();
    let method = request.method().as_str().to_owned();
    // `req.url.split('?')[0]`: the request target as sent, without its query, never normalized.
    let target = request.uri().to_string();
    let path = target.split('?').next().unwrap_or_default().to_owned();
    let finish = |status: u16, event: Option<HookEventName>| finish(&method, &path, status, event);

    let headers = request.headers();
    let host = headers.get(HOST).map(HeaderValue::as_bytes);
    if !host_matches(host, shared.port.load(Ordering::SeqCst)) {
        return finish(403, None);
    }
    let tokens: Vec<&[u8]> = headers
        .get_all(TOKEN_HEADER)
        .iter()
        .map(HeaderValue::as_bytes)
        .collect();
    if !token_matches(&shared.token, &tokens) {
        return finish(403, None);
    }
    let route = match path.as_str() {
        "/hook" => HookRoute::Hook,
        "/hook/question" => HookRoute::Question,
        _ => return finish(404, None),
    };
    if request.method() != Method::POST {
        return finish(405, None);
    }
    if !is_json(headers.get(CONTENT_TYPE).map(HeaderValue::as_bytes)) {
        return finish(415, None);
    }
    let declared = request.body().size_hint().exact();
    if declared.is_some_and(|declared| declared > MAX_BODY_BYTES as u64) {
        return finish(413, None);
    }

    let deadline = Instant::now() + shared.request_timeout;
    let bytes = match tokio::time::timeout_at(deadline, read_body(request.into_body())).await {
        Err(_) => return finish(408, None),
        Ok(BodyRead::TooLarge) => return finish(413, None),
        // The client went away mid-body: nobody reads this answer (TS logs nothing either).
        Ok(BodyRead::Aborted) => return empty(StatusCode::BAD_REQUEST),
        Ok(BodyRead::Done(bytes)) => bytes,
    };
    // `Buffer.toString('utf8')` replaces invalid bytes before `JSON.parse`.
    let Ok(parsed) = serde_json::from_str::<Value>(&String::from_utf8_lossy(&bytes)) else {
        return finish(400, None);
    };
    let Some(event) = parse_hook_event(&parsed) else {
        return finish(400, None);
    };

    if !holds(&event, route) {
        let response = finish(200, Some(event.name));
        deliver(shared, event, None, route);
        return response;
    }
    log::info!("hook request {method} {path} held {}", event.name.as_str());
    // One strictly increasing stamp across held permissions and questions, so the notch can open
    // the earliest even when two arrive within the same millisecond.
    let held_at = {
        let mut last = lock(&shared.held_at);
        *last = arrived_at.max(*last + 1);
        *last
    };
    let (sender, receiver) = oneshot::channel();
    let reply = Arc::new(HeldReply {
        arrived_at: held_at,
        state: Mutex::new(ReplyState {
            sender: Some(sender),
            sent: false,
            closed: false,
            on_close: Vec::new(),
        }),
    });
    // Dropped with this future: when hyper drops it because Claude disconnected (or `stop()`
    // closes the connection) before `send`, the reply's close callbacks run.
    let _guard = CloseGuard(reply.clone());
    deliver(shared, event, Some(reply), route);
    let body = receiver.await.unwrap_or_default();
    let mut response = Response::new(Full::new(Bytes::from(body.clone().unwrap_or_default())));
    let headers = response.headers_mut();
    if body.is_some() {
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    }
    headers.insert(CONNECTION, HeaderValue::from_static("close"));
    response
}

enum BodyRead {
    Done(Vec<u8>),
    TooLarge,
    Aborted,
}

/// The whole body, up to [`MAX_BODY_BYTES`] whether or not it declared its length.
async fn read_body(mut body: Incoming) -> BodyRead {
    let mut bytes = Vec::new();
    while let Some(frame) = body.frame().await {
        let Ok(frame) = frame else {
            return BodyRead::Aborted;
        };
        if let Ok(data) = frame.into_data() {
            if bytes.len() + data.len() > MAX_BODY_BYTES {
                return BodyRead::TooLarge;
            }
            bytes.extend_from_slice(&data);
        }
    }
    BodyRead::Done(bytes)
}

/// Permission requests are held on /hook; a valid AskUserQuestion only on /hook/question (on
/// /hook the same call is answered at once: Claude sends it to both of our PreToolUse groups).
/// Anything else gets an empty 200 right away, which Claude reads as no decision.
fn holds(event: &HookEvent, route: HookRoute) -> bool {
    match route {
        HookRoute::Hook => event.name == HookEventName::PermissionRequest,
        HookRoute::Question => {
            event.name == HookEventName::PreToolUse
                && event.tool_name.as_deref() == Some(ASK_USER_QUESTION_TOOL)
                && matches!(event.ask_user_question, Some(Some(_)))
        }
    }
}

fn deliver(shared: &Shared, event: HookEvent, reply: Option<Arc<HeldReply>>, route: HookRoute) {
    let name = event.name;
    let reply = reply.map(|reply| reply as Arc<dyn PendingReply>);
    let delivered = catch_unwind(AssertUnwindSafe(|| (shared.on_event)(event, reply, route)));
    if delivered.is_err() {
        log::error!("onEvent failed {}", name.as_str());
    }
}

/// A header-only answer that closes the connection, logged without any payload.
fn finish(
    method: &str,
    path: &str,
    status: u16,
    event: Option<HookEventName>,
) -> Response<Full<Bytes>> {
    match event {
        Some(event) => log::info!("hook request {method} {path} {status} {}", event.as_str()),
        None => log::info!("hook request {method} {path} {status}"),
    }
    empty(StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR))
}

fn empty(status: StatusCode) -> Response<Full<Bytes>> {
    let mut response = Response::new(Full::new(Bytes::new()));
    *response.status_mut() = status;
    response
        .headers_mut()
        .insert(CONNECTION, HeaderValue::from_static("close"));
    response
}

struct ReplyState {
    sender: Option<oneshot::Sender<Option<String>>>,
    sent: bool,
    closed: bool,
    on_close: Vec<Box<dyn FnOnce() + Send>>,
}

/// `createReply`.
struct HeldReply {
    arrived_at: u64,
    state: Mutex<ReplyState>,
}

impl HeldReply {
    /// The connection is gone: runs the close callbacks unless the reply was already sent.
    fn close(&self) {
        let callbacks = {
            let mut state = lock(&self.state);
            if state.sent || state.closed {
                return;
            }
            state.closed = true;
            std::mem::take(&mut state.on_close)
        };
        for callback in callbacks {
            run_close_callback(callback);
        }
    }
}

fn run_close_callback(callback: Box<dyn FnOnce() + Send>) {
    if catch_unwind(AssertUnwindSafe(callback)).is_err() {
        log::error!("onClose failed");
    }
}

impl PendingReply for HeldReply {
    fn arrived_at(&self) -> Option<u64> {
        Some(self.arrived_at)
    }

    fn send(&self, body: Option<String>) {
        let sender = {
            let mut state = lock(&self.state);
            if state.sent {
                return;
            }
            state.sent = true;
            state.on_close.clear();
            state.sender.take()
        };
        // The peer may be gone: a held reply never fails into the broker.
        if let Some(sender) = sender {
            let _ = sender.send(body);
        }
    }

    fn on_close(&self, callback: Box<dyn FnOnce() + Send>) {
        let mut state = lock(&self.state);
        if state.sent {
            return;
        }
        if state.closed {
            drop(state);
            run_close_callback(callback);
            return;
        }
        state.on_close.push(callback);
    }
}

struct CloseGuard(Arc<HeldReply>);

impl Drop for CloseGuard {
    fn drop(&mut self) {
        self.0.close();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `Date.now()`.
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

/// Only our own loopback names: a DNS-rebound page would send its own host name.
fn host_matches(host: Option<&[u8]>, port: u16) -> bool {
    let Some(host) = host else { return false };
    [format!("127.0.0.1:{port}"), format!("localhost:{port}")]
        .iter()
        .any(|expected| host.eq_ignore_ascii_case(expected.as_bytes()))
}

/// One `x-notch-token` header with exactly the token's bytes (a repeated header never matches).
/// After the length check the comparison takes the same time whatever the bytes are.
fn token_matches(expected: &[u8], received: &[&[u8]]) -> bool {
    let [candidate] = received else { return false };
    if candidate.len() != expected.len() {
        return false;
    }
    let difference = candidate
        .iter()
        .zip(expected)
        .fold(0u8, |difference, (a, b)| difference | (a ^ b));
    std::hint::black_box(difference) == 0
}

/// `/^application\/json\s*(;|$)/i` on the header as Node reads it (latin1).
fn is_json(content_type: Option<&[u8]>) -> bool {
    let text: String = content_type
        .unwrap_or_default()
        .iter()
        .map(|&byte| char::from(byte))
        .collect();
    let mut chars = text.chars();
    for expected in "application/json".chars() {
        if chars.next().map(|c| c.to_ascii_lowercase()) != Some(expected) {
            return false;
        }
    }
    let rest = chars.as_str().trim_start_matches(is_js_whitespace);
    rest.is_empty() || rest.starts_with(';')
}

#[cfg(test)]
mod tests;
