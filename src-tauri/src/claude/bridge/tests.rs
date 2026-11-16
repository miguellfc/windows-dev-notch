//! Port of `tests/unit/main/claude-bridge.test.ts`, against a real loopback socket.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;

use super::*;
use crate::claude::hook_events::HookEventName;

const TOKEN: &str = "secret-token-value";

#[derive(Debug, PartialEq, Eq)]
struct Res {
    status: u16,
    body: String,
}

/// The raw response: status, lowercased head, body.
struct RawRes {
    status: u16,
    head: String,
    body: String,
}

#[derive(Clone)]
struct Req {
    method: &'static str,
    path: String,
    /// `None`: no token header.
    token: Option<String>,
    /// `None`: no content-type header.
    content_type: Option<String>,
    /// `None`: `127.0.0.1:<port>`.
    host: Option<String>,
    body: Vec<u8>,
}

fn req(body: impl Into<Vec<u8>>) -> Req {
    Req {
        method: "POST",
        path: "/hook".into(),
        token: Some(TOKEN.into()),
        content_type: Some("application/json".into()),
        host: None,
        body: body.into(),
    }
}

impl Req {
    fn path(mut self, path: &str) -> Self {
        self.path = path.into();
        self
    }
    fn method(mut self, method: &'static str) -> Self {
        self.method = method;
        self
    }
    fn token(mut self, token: Option<&str>) -> Self {
        self.token = token.map(str::to_owned);
        self
    }
    fn content_type(mut self, content_type: Option<&str>) -> Self {
        self.content_type = content_type.map(str::to_owned);
        self
    }
    fn host(mut self, host: &str) -> Self {
        self.host = Some(host.into());
        self
    }

    /// Request line and headers (with content-length), up to the blank line.
    fn head(&self, port: u16) -> String {
        let host = self
            .host
            .clone()
            .unwrap_or_else(|| format!("127.0.0.1:{port}"));
        let mut head = format!("{} {} HTTP/1.1\r\nhost: {host}\r\n", self.method, self.path);
        if let Some(token) = &self.token {
            head.push_str(&format!("x-notch-token: {token}\r\n"));
        }
        if let Some(content_type) = &self.content_type {
            head.push_str(&format!("content-type: {content_type}\r\n"));
        }
        head.push_str(&format!("content-length: {}\r\n\r\n", self.body.len()));
        head
    }

    fn bytes(&self, port: u16) -> Vec<u8> {
        let mut bytes = self.head(port).into_bytes();
        bytes.extend_from_slice(&self.body);
        bytes
    }
}

async fn read_response(stream: &mut TcpStream) -> io::Result<RawRes> {
    let mut buf = Vec::new();
    loop {
        match stream.read_buf(&mut buf).await {
            Ok(0) => break,
            Ok(_) => {}
            // A reset after the whole response arrived still counts as that response.
            Err(_) if !buf.is_empty() => break,
            Err(error) => return Err(error),
        }
    }
    parse_response(&buf)
}

fn parse_response(buf: &[u8]) -> io::Result<RawRes> {
    let text = String::from_utf8_lossy(buf);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .ok_or_else(|| io::Error::new(io::ErrorKind::UnexpectedEof, "closed"))?;
    let status = head
        .split(' ')
        .nth(1)
        .and_then(|status| status.parse().ok())
        .ok_or_else(|| io::Error::other("no status"))?;
    Ok(RawRes {
        status,
        head: head.to_ascii_lowercase(),
        body: body.to_owned(),
    })
}

async fn send_raw(port: u16, request: Req) -> io::Result<RawRes> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
    stream.write_all(&request.bytes(port)).await?;
    read_response(&mut stream).await
}

async fn send(port: u16, request: Req) -> io::Result<Res> {
    send_raw(port, request).await.map(|raw| Res {
        status: raw.status,
        body: raw.body,
    })
}

async fn status(port: u16, request: Req) -> u16 {
    send(port, request).await.unwrap().status
}

fn spawn_send(port: u16, request: Req) -> JoinHandle<io::Result<Res>> {
    tokio::spawn(send(port, request))
}

fn ok(body: &str) -> Res {
    Res {
        status: 200,
        body: body.into(),
    }
}

fn hook(name: &str, extra: Value) -> String {
    let mut body = json!({ "session_id": "s1", "hook_event_name": name });
    if let (Some(body), Value::Object(extra)) = (body.as_object_mut(), extra) {
        body.extend(extra);
    }
    body.to_string()
}

fn plain(name: &str) -> String {
    hook(name, json!({}))
}

async fn sleep(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

#[derive(Clone)]
struct Delivered {
    event: HookEvent,
    reply: Option<Arc<dyn PendingReply>>,
    route: HookRoute,
}

struct Fx {
    bridge: ClaudeBridge,
    port: u16,
    events: Arc<Mutex<Vec<Delivered>>>,
}

impl Fx {
    async fn boot() -> Self {
        Self::boot_with(HEADERS_TIMEOUT, REQUEST_TIMEOUT).await
    }

    async fn boot_with(headers_timeout: Duration, request_timeout: Duration) -> Self {
        // Installed before anything logs, so the log assertions see every line.
        crate::services::test_log::capture().expect("the test logger");
        let events: Arc<Mutex<Vec<Delivered>>> = Arc::default();
        let sink = events.clone();
        let bridge = ClaudeBridge::with_timeouts(
            0,
            TOKEN,
            Arc::new(move |event, reply, route| {
                sink.lock().unwrap().push(Delivered {
                    event,
                    reply,
                    route,
                })
            }),
            headers_timeout,
            request_timeout,
        );
        let port = bridge.start().await.unwrap();
        assert_ne!(port, 0);
        assert_eq!(bridge.port(), port);
        Self {
            bridge,
            port,
            events,
        }
    }

    fn events(&self) -> Vec<Delivered> {
        self.events.lock().unwrap().clone()
    }

    fn count(&self) -> usize {
        self.events.lock().unwrap().len()
    }

    fn reply(&self, index: usize) -> Arc<dyn PendingReply> {
        self.events()[index].reply.clone().expect("a held request")
    }
}

fn counter() -> (Arc<AtomicUsize>, Box<dyn FnOnce() + Send>) {
    let count = Arc::new(AtomicUsize::new(0));
    let bump = count.clone();
    (
        count,
        Box::new(move || {
            bump.fetch_add(1, Ordering::SeqCst);
        }),
    )
}

fn log_lines() -> Vec<String> {
    crate::services::test_log::capture()
        .expect("the test logger")
        .lines()
}

#[tokio::test]
async fn rejects_missing_or_wrong_token_with_403_before_reading_the_body() {
    let fx = Fx::boot().await;
    let port = fx.port;
    assert_eq!(status(port, req(plain("Stop")).token(None)).await, 403);
    assert_eq!(
        status(port, req(plain("Stop")).token(Some("nope"))).await,
        403
    );
    let longer = format!("{TOKEN}x");
    assert_eq!(
        status(port, req(plain("Stop")).token(Some(&longer))).await,
        403
    );
    assert_eq!(fx.count(), 0);
    fx.bridge.stop().await;
}

#[tokio::test]
async fn returns_404_for_other_paths_and_405_for_other_methods() {
    let fx = Fx::boot().await;
    assert_eq!(status(fx.port, req("{}").path("/other")).await, 404);
    assert_eq!(status(fx.port, req("").method("GET")).await, 405);
    fx.bridge.stop().await;
}

#[tokio::test]
async fn returns_413_for_bodies_over_256_kib_without_parsing() {
    let fx = Fx::boot().await;
    let big = hook("Stop", json!({ "pad": "x".repeat(262_144) }));
    assert_eq!(status(fx.port, req(big)).await, 413);
    assert_eq!(fx.count(), 0);
    fx.bridge.stop().await;
}

#[tokio::test]
async fn returns_415_when_content_type_is_not_json_and_accepts_a_charset_suffix() {
    let fx = Fx::boot().await;
    let port = fx.port;
    assert_eq!(
        status(port, req(plain("Stop")).content_type(Some("text/plain"))).await,
        415
    );
    assert_eq!(
        status(
            port,
            req(plain("Stop")).content_type(Some("application/json; charset=utf-8"))
        )
        .await,
        200
    );
    fx.bridge.stop().await;
}

#[tokio::test]
async fn returns_400_for_invalid_json_and_unknown_events() {
    let fx = Fx::boot().await;
    assert_eq!(status(fx.port, req("{oops")).await, 400);
    assert_eq!(status(fx.port, req(plain("Bogus"))).await, 400);
    assert_eq!(fx.count(), 0);
    fx.bridge.stop().await;
}

#[tokio::test]
async fn answers_valid_non_permission_events_with_an_empty_200_and_calls_on_event_with_no_reply() {
    let fx = Fx::boot().await;
    let raw = send_raw(
        fx.port,
        req(hook("PreToolUse", json!({ "tool_name": "Bash" }))),
    )
    .await
    .unwrap();
    assert_eq!((raw.status, raw.body.as_str()), (200, ""));
    assert!(raw.head.contains("\r\nconnection: close"), "{}", raw.head);
    let events = fx.events();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event.name, HookEventName::PreToolUse);
    assert_eq!(events[0].event.session_id, "s1");
    assert_eq!(events[0].event.tool_name.as_deref(), Some("Bash"));
    assert!(events[0].reply.is_none());
    fx.bridge.stop().await;
}

#[tokio::test]
async fn holds_a_permission_request_until_reply_send_is_called() {
    let fx = Fx::boot().await;
    let pending = tokio::spawn(send_raw(
        fx.port,
        req(hook(
            "PermissionRequest",
            json!({ "tool_name": "Bash", "tool_input": { "command": "ls" } }),
        )),
    ));
    sleep(100).await;
    assert_eq!(fx.count(), 1);
    assert!(!pending.is_finished());
    let reply = fx.reply(0);
    reply.send(Some(r#"{"ok":true}"#.into()));
    reply.send(Some(r#"{"second":true}"#.into()));
    let raw = pending.await.unwrap().unwrap();
    assert_eq!((raw.status, raw.body.as_str()), (200, r#"{"ok":true}"#));
    assert!(raw.head.contains("\r\ncontent-type: application/json"));
    fx.bridge.stop().await;
}

#[tokio::test]
async fn stamps_a_held_request_when_it_arrives_before_its_body_is_read() {
    let fx = Fx::boot().await;
    let request = req(plain("PermissionRequest"));
    let mut stream = TcpStream::connect(("127.0.0.1", fx.port)).await.unwrap();
    stream
        .write_all(request.head(fx.port).as_bytes())
        .await
        .unwrap();
    sleep(150).await;
    stream.write_all(&request.body).await.unwrap();
    sleep(100).await;
    let reply = fx.reply(0);
    let arrived_at = reply.arrived_at().expect("a stamp");
    // The body came ~150 ms after the headers: the stamp is from the headers.
    assert!(now_ms() - arrived_at >= 200, "{}", now_ms() - arrived_at);
    reply.send(None);
    assert_eq!(read_response(&mut stream).await.unwrap().status, 200);
    fx.bridge.stop().await;
}

#[tokio::test]
async fn replies_200_empty_for_send_none_and_never_fails_on_a_finished_response() {
    let fx = Fx::boot().await;
    let pending = spawn_send(fx.port, req(plain("PermissionRequest")));
    sleep(50).await;
    let reply = fx.reply(0);
    reply.send(None);
    assert_eq!(pending.await.unwrap().unwrap(), ok(""));
    reply.send(Some("late".into()));
    fx.bridge.stop().await;
}

#[tokio::test]
async fn fires_on_close_when_the_client_disconnects_before_we_reply_and_not_after_we_sent() {
    let fx = Fx::boot().await;
    let mut stream = TcpStream::connect(("127.0.0.1", fx.port)).await.unwrap();
    stream
        .write_all(&req(plain("PermissionRequest")).bytes(fx.port))
        .await
        .unwrap();
    sleep(100).await;
    let (closed, on_close) = counter();
    fx.reply(0).on_close(on_close);
    drop(stream);
    sleep(100).await;
    assert_eq!(closed.load(Ordering::SeqCst), 1);

    let done = spawn_send(fx.port, req(plain("PermissionRequest")));
    sleep(50).await;
    let second = fx.reply(1);
    let (second_closed, on_close) = counter();
    second.on_close(on_close);
    second.send(None);
    done.await.unwrap().unwrap();
    sleep(50).await;
    assert_eq!(second_closed.load(Ordering::SeqCst), 0);
    fx.bridge.stop().await;
}

#[tokio::test]
async fn never_logs_prompt_or_tool_input_values_or_the_token() {
    let fx = Fx::boot().await;
    let port = fx.port;
    send(
        port,
        req(hook(
            "UserPromptSubmit",
            json!({ "prompt": "SECRET-PROMPT-TEXT" }),
        )),
    )
    .await
    .unwrap();
    send(
        port,
        req(hook(
            "PreToolUse",
            json!({ "tool_input": { "command": "SECRET-COMMAND" } }),
        )),
    )
    .await
    .unwrap();
    send(port, req(plain("Stop")).token(Some("wrong-token-attempt")))
        .await
        .unwrap();
    fx.bridge.stop().await;
    let lines = log_lines();
    assert!(lines
        .iter()
        .any(|line| line.ends_with("hook request POST /hook 200 UserPromptSubmit")));
    assert!(lines
        .iter()
        .any(|line| line.ends_with("hook request POST /hook 403")));
    for line in &lines {
        for secret in [
            "SECRET-PROMPT-TEXT",
            "SECRET-COMMAND",
            TOKEN,
            "wrong-token-attempt",
        ] {
            assert!(!line.contains(secret), "{line}");
        }
    }
}

#[tokio::test]
async fn stop_closes_open_held_connections_without_hanging() {
    let fx = Fx::boot().await;
    let pending = spawn_send(fx.port, req(plain("PermissionRequest")));
    sleep(100).await;
    let (closed, on_close) = counter();
    fx.reply(0).on_close(on_close);
    fx.bridge.stop().await;
    assert!(pending.await.unwrap().is_err(), "the connection was closed");
    assert_eq!(closed.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn rejects_a_host_other_than_127_0_0_1_or_localhost_with_the_port_dns_rebinding() {
    let fx = Fx::boot().await;
    let port = fx.port;
    let host = |value: String| req(plain("Stop")).host(&value);
    assert_eq!(
        status(port, host(format!("evil.example:{port}"))).await,
        403
    );
    assert_eq!(status(port, host("127.0.0.1".into())).await, 403);
    assert_eq!(
        status(port, host(format!("127.0.0.1:{}", port + 1))).await,
        403
    );
    assert_eq!(fx.count(), 0);
    assert_eq!(status(port, host(format!("localhost:{port}"))).await, 200);
    assert_eq!(status(port, host(format!("LOCALHOST:{port}"))).await, 200);
    assert_eq!(status(port, req(plain("Stop"))).await, 200);
    fx.bridge.stop().await;
}

#[tokio::test]
async fn stop_right_after_send_none_still_delivers_the_empty_200() {
    let fx = Fx::boot().await;
    let pending = spawn_send(fx.port, req(plain("PermissionRequest")));
    sleep(100).await;
    fx.reply(0).send(None);
    fx.bridge.stop().await;
    assert_eq!(pending.await.unwrap().unwrap(), ok(""));
}

#[tokio::test]
async fn stop_finishes_within_a_bounded_time_even_if_a_client_keeps_its_connection_open() {
    let fx = Fx::boot().await;
    // A raw socket that never sends a full request nor closes.
    let mut stream = TcpStream::connect(("127.0.0.1", fx.port)).await.unwrap();
    stream
        .write_all(b"POST /hook HTTP/1.1\r\nhost: 127.0.0.1\r\n")
        .await
        .unwrap();
    sleep(20).await;
    let started = Instant::now();
    fx.bridge.stop().await;
    assert!(started.elapsed() < Duration::from_secs(2));
    drop(stream);
}

mod ask_user_question {
    use super::*;

    fn ask_input() -> Value {
        json!({
            "questions": [{
                "question": "SECRET-QUESTION-TEXT?",
                "header": "Pick",
                "multiSelect": false,
                "options": [
                    { "label": "SECRET-OPTION-A", "description": "a" },
                    { "label": "B", "description": "b" },
                ],
            }],
        })
    }

    fn ask_with(extra: Value) -> String {
        let mut fields = json!({
            "tool_name": "AskUserQuestion",
            "tool_use_id": "tu-1",
            "tool_input": ask_input(),
        });
        if let (Some(fields), Value::Object(extra)) = (fields.as_object_mut(), extra) {
            fields.extend(extra);
        }
        hook("PreToolUse", fields)
    }

    fn ask() -> String {
        ask_with(json!({}))
    }

    #[tokio::test]
    async fn answers_ask_user_question_on_hook_at_once_and_delivers_it_unheld_on_the_hook_route() {
        let fx = Fx::boot().await;
        assert_eq!(send(fx.port, req(ask())).await.unwrap(), ok(""));
        let events = fx.events();
        assert_eq!(events.len(), 1);
        assert!(events[0].reply.is_none());
        assert_eq!(events[0].route, HookRoute::Hook);
        let questions = events[0].event.ask_user_question.clone().flatten().unwrap();
        assert_eq!(questions.questions.len(), 1);
        fx.bridge.stop().await;
    }

    #[tokio::test]
    async fn holds_ask_user_question_on_hook_question_until_reply_send_on_the_question_route() {
        let fx = Fx::boot().await;
        let pending = spawn_send(fx.port, req(ask()).path("/hook/question"));
        sleep(100).await;
        assert!(!pending.is_finished());
        let events = fx.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].route, HookRoute::Question);
        let reply = fx.reply(0);
        assert!(reply.arrived_at().is_some());
        reply.send(Some(r#"{"answered":true}"#.into()));
        assert_eq!(pending.await.unwrap().unwrap(), ok(r#"{"answered":true}"#));
        fx.bridge.stop().await;
    }

    #[tokio::test]
    async fn stamps_held_permissions_and_questions_in_one_strictly_increasing_order() {
        let fx = Fx::boot().await;
        let sends = [
            spawn_send(fx.port, req(plain("PermissionRequest"))),
            spawn_send(fx.port, req(ask()).path("/hook/question")),
            spawn_send(fx.port, req(plain("PermissionRequest"))),
            spawn_send(fx.port, req(ask()).path("/hook/question")),
        ];
        sleep(100).await;
        let events = fx.events();
        let stamps: Vec<u64> = events
            .iter()
            .map(|x| x.reply.as_ref().unwrap().arrived_at().unwrap())
            .collect();
        assert_eq!(stamps.len(), 4);
        for pair in stamps.windows(2) {
            assert!(pair[1] > pair[0], "{stamps:?}");
        }
        for x in &events {
            x.reply.as_ref().unwrap().send(None);
        }
        for pending in sends {
            pending.await.unwrap().unwrap();
        }
        fx.bridge.stop().await;
    }

    #[tokio::test]
    async fn answers_any_other_event_on_hook_question_at_once() {
        let fx = Fx::boot().await;
        let question = |body: String| req(body).path("/hook/question");
        let bash = hook("PreToolUse", json!({ "tool_name": "Bash" }));
        assert_eq!(send(fx.port, question(bash)).await.unwrap(), ok(""));
        assert_eq!(
            send(fx.port, question(plain("Stop"))).await.unwrap(),
            ok("")
        );
        assert_eq!(
            send(fx.port, question(plain("PermissionRequest")))
                .await
                .unwrap(),
            ok("")
        );
        let seen: Vec<(HookEventName, HookRoute, bool)> = fx
            .events()
            .iter()
            .map(|x| (x.event.name, x.route, x.reply.is_some()))
            .collect();
        assert_eq!(
            seen,
            [
                (HookEventName::PreToolUse, HookRoute::Question, false),
                (HookEventName::Stop, HookRoute::Question, false),
                (HookEventName::PermissionRequest, HookRoute::Question, false),
            ]
        );
        fx.bridge.stop().await;
    }

    #[tokio::test]
    async fn answers_an_ask_user_question_that_does_not_fit_the_schema_at_once() {
        let fx = Fx::boot().await;
        let body = ask_with(json!({ "tool_input": { "questions": [] } }));
        assert_eq!(
            send(fx.port, req(body).path("/hook/question"))
                .await
                .unwrap(),
            ok("")
        );
        let events = fx.events();
        assert!(events[0].reply.is_none());
        assert_eq!(events[0].event.ask_user_question, Some(None));
        fx.bridge.stop().await;
    }

    #[tokio::test]
    async fn hook_question_checks_the_token_method_and_content_type_like_hook() {
        let fx = Fx::boot().await;
        let port = fx.port;
        let question = || req(ask()).path("/hook/question");
        assert_eq!(status(port, question().token(None)).await, 403);
        assert_eq!(status(port, question().token(Some("nope"))).await, 403);
        assert_eq!(
            status(port, req("").path("/hook/question").method("GET")).await,
            405
        );
        assert_eq!(
            status(port, question().content_type(Some("text/plain"))).await,
            415
        );
        assert_eq!(status(port, question().path("/hook/question/x")).await, 404);
        assert_eq!(fx.count(), 0);
        fx.bridge.stop().await;
    }

    #[tokio::test]
    async fn never_logs_question_or_option_texts() {
        let fx = Fx::boot().await;
        send(fx.port, req(ask())).await.unwrap();
        let pending = spawn_send(fx.port, req(ask()).path("/hook/question"));
        sleep(50).await;
        fx.reply(fx.count() - 1).send(None);
        pending.await.unwrap().unwrap();
        fx.bridge.stop().await;
        let lines = log_lines();
        assert!(lines
            .iter()
            .any(|line| line.ends_with("hook request POST /hook/question held PreToolUse")));
        for line in &lines {
            assert!(!line.contains("SECRET-QUESTION-TEXT"), "{line}");
            assert!(!line.contains("SECRET-OPTION-A"), "{line}");
        }
    }
}

#[tokio::test]
async fn start_rejects_when_the_port_is_already_in_use() {
    let fx = Fx::boot().await;
    let other = ClaudeBridge::new(fx.port, TOKEN, Arc::new(|_, _, _| {}));
    assert!(matches!(other.start().await, Err(BridgeError::PortInUse)));
    fx.bridge.stop().await;
}

// Beyond the TS cases.

#[tokio::test]
async fn rejects_before_reading_the_body() {
    let fx = Fx::boot().await;
    let port = fx.port;
    // Only the head is sent (the declared body never comes): the answer must not wait for it.
    let head_only = |request: Req| async move {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream
            .write_all(request.head(port).as_bytes())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), read_response(&mut stream))
            .await
            .expect("answered without the body")
            .unwrap()
            .status
    };
    let small = plain("Stop");
    assert_eq!(head_only(req(small.clone()).token(None)).await, 403);
    let foreign = format!("evil.example:{}", fx.port);
    assert_eq!(head_only(req(small).host(&foreign)).await, 403);
    let mut huge = req(Vec::new());
    huge.body = vec![b' '; 300 * 1024];
    assert_eq!(head_only(huge).await, 413);
    assert_eq!(fx.count(), 0);
    fx.bridge.stop().await;
}

#[tokio::test]
async fn client_disconnect_while_held_drops_the_pending_item() {
    // A broker-like consumer: holds the reply in a map and drops it when Claude goes away.
    let pending: Arc<Mutex<Vec<usize>>> = Arc::default();
    let next = Arc::new(AtomicUsize::new(0));
    let map = pending.clone();
    let bridge = ClaudeBridge::new(
        0,
        TOKEN,
        Arc::new(move |_event, reply, _route| {
            let Some(reply) = reply else { return };
            let id = next.fetch_add(1, Ordering::SeqCst);
            map.lock().unwrap().push(id);
            let map = map.clone();
            reply.on_close(Box::new(move || map.lock().unwrap().retain(|x| *x != id)));
        }),
    );
    let port = bridge.start().await.unwrap();
    let mut first = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    first
        .write_all(&req(plain("PermissionRequest")).bytes(port))
        .await
        .unwrap();
    let mut second = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    second
        .write_all(&req(ask_body()).path("/hook/question").bytes(port))
        .await
        .unwrap();
    sleep(100).await;
    assert_eq!(*pending.lock().unwrap(), [0, 1]);
    first.shutdown().await.unwrap();
    drop(first);
    sleep(100).await;
    assert_eq!(*pending.lock().unwrap(), [1]);
    drop(second);
    sleep(100).await;
    assert!(pending.lock().unwrap().is_empty());
    bridge.stop().await;

    fn ask_body() -> String {
        hook(
            "PreToolUse",
            json!({
                "tool_name": "AskUserQuestion",
                "tool_input": { "questions": [{
                    "question": "Q?", "header": "", "multiSelect": false,
                    "options": [{ "label": "A", "description": "" }, { "label": "B", "description": "" }],
                }] },
            }),
        )
    }
}

#[tokio::test]
async fn caps_a_chunked_body_without_content_length_at_256_kib() {
    let fx = Fx::boot().await;
    let mut stream = TcpStream::connect(("127.0.0.1", fx.port)).await.unwrap();
    let head = format!(
        "POST /hook HTTP/1.1\r\nhost: 127.0.0.1:{}\r\nx-notch-token: {TOKEN}\r\n\
         content-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n",
        fx.port
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    let chunk = vec![b' '; 64 * 1024];
    // Five 64 KiB chunks (320 KiB) and no terminating chunk: the cap answers before the end.
    for _ in 0..5 {
        let mut frame = format!("{:x}\r\n", chunk.len()).into_bytes();
        frame.extend_from_slice(&chunk);
        frame.extend_from_slice(b"\r\n");
        if stream.write_all(&frame).await.is_err() {
            break;
        }
    }
    let answered = tokio::time::timeout(Duration::from_secs(2), read_response(&mut stream))
        .await
        .expect("answered before the body ended")
        .unwrap();
    assert_eq!(answered.status, 413);
    assert_eq!(fx.count(), 0);
    fx.bridge.stop().await;
}

#[tokio::test]
async fn accepts_a_chunked_body_under_the_cap() {
    let fx = Fx::boot().await;
    let body = plain("Stop");
    let mut stream = TcpStream::connect(("127.0.0.1", fx.port)).await.unwrap();
    let request = format!(
        "POST /hook HTTP/1.1\r\nhost: 127.0.0.1:{}\r\nx-notch-token: {TOKEN}\r\n\
         content-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n{:x}\r\n{body}\r\n0\r\n\r\n",
        fx.port,
        body.len()
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    assert_eq!(read_response(&mut stream).await.unwrap().status, 200);
    assert_eq!(fx.count(), 1);
    fx.bridge.stop().await;
}

#[tokio::test]
async fn a_repeated_token_header_is_a_mismatch() {
    let fx = Fx::boot().await;
    let mut request = req(plain("Stop"));
    request.content_type = Some(format!("application/json\r\nx-notch-token: {TOKEN}"));
    assert_eq!(status(fx.port, request).await, 403);
    assert_eq!(fx.count(), 0);
    fx.bridge.stop().await;
}

#[tokio::test]
async fn ignores_the_query_string_and_never_normalizes_the_path() {
    let fx = Fx::boot().await;
    assert_eq!(
        status(fx.port, req(plain("Stop")).path("/hook?x=1")).await,
        200
    );
    assert_eq!(
        status(fx.port, req(plain("Stop")).path("/hook/")).await,
        404
    );
    assert_eq!(status(fx.port, req(plain("Stop")).path("/HOOK")).await, 404);
    let absolute = format!("http://127.0.0.1:{}/hook", fx.port);
    assert_eq!(
        status(fx.port, req(plain("Stop")).path(&absolute)).await,
        404
    );
    fx.bridge.stop().await;
}

#[tokio::test]
async fn reads_the_body_as_lossy_utf8_and_refuses_out_of_range_numbers() {
    let fx = Fx::boot().await;
    // `Buffer.toString('utf8')` replaces invalid bytes before `JSON.parse`.
    let mut body = br#"{"session_id":"s"#.to_vec();
    body.push(0xff);
    body.extend_from_slice(br#"","hook_event_name":"Stop"}"#);
    assert_eq!(status(fx.port, req(body)).await, 200);
    assert_eq!(fx.events()[0].event.session_id, "s\u{fffd}");
    // Deviation: JS reads 1e400 as Infinity; serde_json refuses the body (400).
    let huge = r#"{"session_id":"s1","hook_event_name":"Stop","n":1e400}"#;
    assert_eq!(status(fx.port, req(huge)).await, 400);
    fx.bridge.stop().await;
}

#[tokio::test]
async fn a_panicking_on_event_is_logged_and_the_bridge_keeps_serving() {
    crate::services::test_log::capture().expect("the test logger");
    let bridge = ClaudeBridge::new(
        0,
        TOKEN,
        Arc::new(|event, _, _| {
            if event.name == HookEventName::Stop {
                panic!("boom");
            }
        }),
    );
    let port = bridge.start().await.unwrap();
    assert_eq!(status(port, req(plain("Stop"))).await, 200);
    assert_eq!(status(port, req(plain("Notification"))).await, 200);
    bridge.stop().await;
    assert!(log_lines()
        .iter()
        .any(|line| line.contains("onEvent failed Stop")));
}

#[tokio::test]
async fn stop_is_idempotent_and_frees_the_port() {
    let fx = Fx::boot().await;
    tokio::join!(fx.bridge.stop(), fx.bridge.stop());
    fx.bridge.stop().await;
    assert!(TcpStream::connect(("127.0.0.1", fx.port)).await.is_err());
    let again = ClaudeBridge::new(fx.port, TOKEN, Arc::new(|_, _, _| {}));
    assert_eq!(again.start().await.unwrap(), fx.port);
    again.stop().await;
    // Never started: stop returns at once.
    ClaudeBridge::new(0, TOKEN, Arc::new(|_, _, _| {}))
        .stop()
        .await;
}

#[test]
fn token_compare_needs_one_header_with_the_same_bytes() {
    let token = TOKEN.as_bytes();
    assert!(token_matches(token, &[token]));
    assert!(!token_matches(token, &[]));
    assert!(!token_matches(token, &[token, token]));
    assert!(!token_matches(token, &[b"secret-token-valuE"]));
    assert!(!token_matches(token, &[b"secret-token-valu"]));
    assert!(!token_matches(token, &[b""]));
}

#[test]
fn content_type_must_be_application_json_with_an_optional_parameter() {
    for yes in [
        "application/json",
        "Application/JSON",
        "application/json;charset=utf-8",
        "application/json ; charset=utf-8",
        "application/json \t",
    ] {
        assert!(is_json(Some(yes.as_bytes())), "{yes}");
    }
    for no in [
        "",
        "text/plain",
        "application/jsonx",
        "application/json-patch+json",
        " application/json",
        "application/json x",
    ] {
        assert!(!is_json(Some(no.as_bytes())), "{no}");
    }
    assert!(!is_json(None));
}

// Fix round 1: timeouts, head limit, stop without waiting for lingering clients.

const SHORT: Duration = Duration::from_millis(200);

#[tokio::test]
async fn closes_a_connection_that_sends_only_part_of_its_head() {
    let fx = Fx::boot_with(SHORT, REQUEST_TIMEOUT).await;
    let mut stream = TcpStream::connect(("127.0.0.1", fx.port)).await.unwrap();
    stream
        .write_all(b"POST /hook HTTP/1.1\r\nhost: 127.0.0.1\r\n")
        .await
        .unwrap();
    let mut buf = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut buf))
        .await
        .expect("closed by the header timeout");
    // Closed without an answer (or reset), never served.
    assert!(closed.is_err() || buf.is_empty() || buf.starts_with(b"HTTP/1.1 408"));
    assert_eq!(fx.count(), 0);
    fx.bridge.stop().await;
}

#[tokio::test]
async fn closes_an_idle_connection_that_never_sends_anything() {
    let fx = Fx::boot_with(SHORT, REQUEST_TIMEOUT).await;
    let mut stream = TcpStream::connect(("127.0.0.1", fx.port)).await.unwrap();
    let mut buf = Vec::new();
    let closed = tokio::time::timeout(Duration::from_secs(2), stream.read_to_end(&mut buf)).await;
    assert!(closed.is_ok(), "closed by the header timeout");
    fx.bridge.stop().await;
}

#[tokio::test]
async fn answers_408_when_the_body_does_not_arrive_in_time() {
    let fx = Fx::boot_with(HEADERS_TIMEOUT, SHORT).await;
    // The head declares the whole body; only its first bytes ever come.
    let request = req(plain("PermissionRequest"));
    let mut stream = TcpStream::connect(("127.0.0.1", fx.port)).await.unwrap();
    stream
        .write_all(request.head(fx.port).as_bytes())
        .await
        .unwrap();
    stream.write_all(&request.body[..5]).await.unwrap();
    let answered = tokio::time::timeout(Duration::from_secs(2), read_response(&mut stream))
        .await
        .expect("answered by the request timeout")
        .unwrap();
    assert_eq!(answered.status, 408);
    assert_eq!(fx.count(), 0);
    fx.bridge.stop().await;
}

#[tokio::test]
async fn never_times_out_a_held_request() {
    let fx = Fx::boot_with(SHORT, SHORT).await;
    let pending = spawn_send(fx.port, req(plain("PermissionRequest")));
    sleep(700).await;
    assert!(!pending.is_finished(), "still held after both timeouts");
    let (closed, on_close) = counter();
    let reply = fx.reply(0);
    reply.on_close(on_close);
    reply.send(Some("{}".into()));
    assert_eq!(pending.await.unwrap().unwrap(), ok("{}"));
    assert_eq!(closed.load(Ordering::SeqCst), 0);
    fx.bridge.stop().await;
}

#[tokio::test]
async fn answers_431_to_a_head_over_16_kib() {
    let fx = Fx::boot().await;
    let mut request = req(plain("Stop"));
    request.content_type = Some(format!(
        "application/json\r\nx-padding: {}",
        "p".repeat(17 * 1024)
    ));
    assert_eq!(status(fx.port, request).await, 431);
    assert_eq!(fx.count(), 0);
    // A head just under the limit is still served.
    let mut request = req(plain("Stop"));
    request.content_type = Some(format!(
        "application/json\r\nx-padding: {}",
        "p".repeat(15 * 1024)
    ));
    assert_eq!(status(fx.port, request).await, 200);
    fx.bridge.stop().await;
}

#[tokio::test]
async fn stop_does_not_wait_for_a_client_that_keeps_an_answered_connection_open() {
    let fx = Fx::boot().await;
    let mut stream = TcpStream::connect(("127.0.0.1", fx.port)).await.unwrap();
    stream
        .write_all(&req(plain("Stop")).bytes(fx.port))
        .await
        .unwrap();
    // Read the answer up to the server's FIN, but keep our side open.
    assert_eq!(read_response(&mut stream).await.unwrap().status, 200);
    let started = Instant::now();
    fx.bridge.stop().await;
    assert!(
        started.elapsed() < Duration::from_millis(400),
        "{:?}",
        started.elapsed()
    );
    drop(stream);
}
