//! The HTTP transport of the REST clients (Electron: `net.fetch` with `redirect: 'manual'`
//! and `AbortSignal.timeout(30000)`).
//!
//! [`Transport`] is what the clients see, so unit tests inject fakes (as the TS tests inject
//! `fetch`). [`ReqwestTransport`] is the real one: a direct connection (no proxy), redirects never
//! followed (a 3xx comes back as a response; the clients refuse it), one total timeout covering
//! connect, headers and body, and a body cap.
//!
//! Deviation: Electron reads bodies without a limit; here a body over [`BODY_LIMIT`] fails with
//! [`TransportError::BodyTooLarge`] (the clients map it to `invalid-response`).

use std::time::Duration;

use crate::ipc::BoxFuture;

/// `REQUEST_TIMEOUT_MS`: a request that hangs must not block the next tick forever.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Largest response body read (16 MiB).
pub const BODY_LIMIT: usize = 16 * 1024 * 1024;
/// GitHub refuses API requests without a `User-Agent`; this one names only the app.
pub const USER_AGENT: &str = concat!("DeveloperNotch/", env!("CARGO_PKG_VERSION"));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
}

/// One request. Header values may hold tokens: `Debug` prints only the method and header names.
#[derive(Clone, PartialEq, Eq)]
pub struct HttpRequest {
    pub method: Method,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<Vec<u8>>,
}

impl HttpRequest {
    pub fn get(url: impl Into<String>) -> Self {
        Self {
            method: Method::Get,
            url: url.into(),
            headers: Vec::new(),
            body: None,
        }
    }

    pub fn post(url: impl Into<String>, body: Vec<u8>) -> Self {
        Self {
            method: Method::Post,
            url: url.into(),
            headers: Vec::new(),
            body: Some(body),
        }
    }

    pub fn put(url: impl Into<String>, body: Vec<u8>) -> Self {
        Self {
            method: Method::Put,
            url: url.into(),
            headers: Vec::new(),
            body: Some(body),
        }
    }

    #[must_use]
    pub fn header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_owned(), value.into()));
        self
    }

    /// The value of a header this request carries (names compared case-insensitively).
    pub fn header_value(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

impl std::fmt::Debug for HttpRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let names: Vec<&str> = self.headers.iter().map(|(name, _)| name.as_str()).collect();
        f.debug_struct("HttpRequest")
            .field("method", &self.method)
            .field("headers", &names)
            .finish_non_exhaustive()
    }
}

/// A response with its whole body. Header names are kept lowercase.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl HttpResponse {
    pub fn new(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: Vec::new(),
        }
    }

    #[must_use]
    pub fn with_header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_ascii_lowercase(), value.into()));
        self
    }

    #[must_use]
    pub fn with_body(mut self, body: impl Into<Vec<u8>>) -> Self {
        self.body = body.into();
        self
    }

    /// `headers.get(name)`: case-insensitive; repeated headers joined with `", "`.
    pub fn header(&self, name: &str) -> Option<String> {
        let mut values = self
            .headers
            .iter()
            .filter(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
            .peekable();
        values.peek()?;
        Some(values.collect::<Vec<_>>().join(", "))
    }

    /// `headers.has(name)`.
    pub fn has_header(&self, name: &str) -> bool {
        self.headers
            .iter()
            .any(|(key, _)| key.eq_ignore_ascii_case(name))
    }

    /// `response.ok`: a 2xx status.
    pub fn is_ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// Why a request produced no response.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TransportError {
    /// Connection, TLS, timeout or body read failure (`fetch` rejected).
    Network,
    /// The body exceeded [`BODY_LIMIT`].
    BodyTooLarge,
}

pub trait Transport: Send + Sync {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, TransportError>>;
}

/// The real transport (reqwest over SChannel).
pub struct ReqwestTransport {
    client: reqwest::Client,
    body_limit: usize,
}

impl ReqwestTransport {
    /// No proxy, no redirects, [`REQUEST_TIMEOUT`] in total, [`BODY_LIMIT`].
    pub fn new() -> Result<Self, TransportError> {
        Self::with_limits(REQUEST_TIMEOUT, BODY_LIMIT)
    }

    /// [`Self::new`] with another total timeout and body cap (tests).
    pub fn with_limits(timeout: Duration, body_limit: usize) -> Result<Self, TransportError> {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout)
            .user_agent(USER_AGENT)
            .build()
            .map_err(|_| TransportError::Network)?;
        Ok(Self { client, body_limit })
    }

    async fn run(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        let method = match request.method {
            Method::Get => reqwest::Method::GET,
            Method::Post => reqwest::Method::POST,
            Method::Put => reqwest::Method::PUT,
        };
        let mut builder = self.client.request(method, &request.url);
        for (name, value) in &request.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        if let Some(body) = request.body {
            builder = builder.body(body);
        }
        // Every reqwest failure (connect, TLS, timeout, a malformed URL) is `fetch` rejecting.
        let mut response = builder.send().await.map_err(|_| TransportError::Network)?;
        let announced = response.content_length().unwrap_or(0);
        if usize::try_from(announced).map_or(true, |length| length > self.body_limit) {
            return Err(TransportError::BodyTooLarge);
        }
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_ascii_lowercase(),
                    String::from_utf8_lossy(value.as_bytes()).into_owned(),
                )
            })
            .collect();
        let mut body = Vec::new();
        // The total timeout covers these reads too.
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| TransportError::Network)?
        {
            if body.len() + chunk.len() > self.body_limit {
                return Err(TransportError::BodyTooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        Ok(HttpResponse {
            status,
            headers,
            body,
        })
    }
}

impl Transport for ReqwestTransport {
    fn send(&self, request: HttpRequest) -> BoxFuture<'_, Result<HttpResponse, TransportError>> {
        Box::pin(self.run(request))
    }
}

/// Loopback HTTP servers for the transport and client tests.
#[cfg(test)]
pub(crate) mod test_support {
    use std::sync::Arc;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    /// Reads one request head (and its `content-length` body) from `stream`.
    pub(crate) async fn read_request(stream: &mut TcpStream) -> String {
        let mut data = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let n = stream.read(&mut buf).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            data.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&data).into_owned();
            if let Some(end) = text.find("\r\n\r\n") {
                let length = text[..end]
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())?
                    })
                    .unwrap_or(0);
                if data.len() >= end + 4 + length {
                    break;
                }
            }
        }
        String::from_utf8_lossy(&data).into_owned()
    }

    /// A loopback server answering every connection with `respond(request)`; the requests seen
    /// are sent to the returned receiver.
    pub(crate) async fn serve(
        respond: impl Fn(&str) -> Vec<u8> + Send + Sync + 'static,
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let (seen, requests) = tokio::sync::mpsc::unbounded_channel();
        let respond = Arc::new(respond);
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let respond = Arc::clone(&respond);
                let seen = seen.clone();
                tokio::spawn(async move {
                    let request = read_request(&mut stream).await;
                    let _ = seen.send(request.clone());
                    let _ = stream.write_all(&respond(&request)).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        (base, requests)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use tokio::io::AsyncWriteExt;
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    use super::test_support::{read_request, serve};
    use super::*;

    fn transport() -> ReqwestTransport {
        ReqwestTransport::new().unwrap()
    }

    #[tokio::test]
    async fn sends_method_headers_body_and_user_agent_and_reads_the_response() {
        let (base, mut requests) = serve(|_| {
            b"HTTP/1.1 201 Created\r\nX-RateLimit-Remaining: 7\r\nSet-Thing: a\r\nSet-Thing: b\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello"
                .to_vec()
        })
        .await;
        let request = HttpRequest::post(format!("{base}/graphql"), b"{\"query\":1}".to_vec())
            .header("authorization", "Bearer t0k3n")
            .header("accept", "application/json")
            .header("content-type", "application/json");
        let response = transport().send(request).await.unwrap();
        assert_eq!(response.status, 201);
        assert!(response.is_ok());
        assert_eq!(response.body, b"hello");
        assert_eq!(
            response.header("x-ratelimit-remaining").as_deref(),
            Some("7")
        );
        assert_eq!(
            response.header("X-RATELIMIT-REMAINING").as_deref(),
            Some("7")
        );
        assert_eq!(response.header("set-thing").as_deref(), Some("a, b"));
        assert!(!response.has_header("retry-after"));

        let seen = requests.recv().await.unwrap().to_ascii_lowercase();
        assert!(seen.starts_with("post /graphql http/1.1\r\n"), "{seen}");
        assert!(seen.contains("\r\nauthorization: bearer t0k3n\r\n"));
        assert!(seen.contains("\r\naccept: application/json\r\n"));
        assert!(seen.contains("\r\ncontent-type: application/json\r\n"));
        assert!(seen.contains(&format!(
            "\r\nuser-agent: {}\r\n",
            USER_AGENT.to_ascii_lowercase()
        )));
        assert!(seen.ends_with("\r\n\r\n{\"query\":1}"));
        assert_eq!(
            USER_AGENT,
            format!("DeveloperNotch/{}", env!("CARGO_PKG_VERSION"))
        );
    }

    #[tokio::test]
    async fn put_request_carries_method_and_body() {
        let (base, mut requests) =
            serve(|_| b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n".to_vec()).await;
        let request = HttpRequest::put(
            format!("{base}/issues/7.json"),
            b"{\"issue\":{\"status_id\":3}}".to_vec(),
        )
        .header("x-redmine-api-key", "k3y")
        .header("content-type", "application/json");
        assert_eq!(request.method, Method::Put);
        let response = transport().send(request).await.unwrap();
        assert_eq!(response.status, 204);
        assert!(response.is_ok());
        assert!(response.body.is_empty());

        let seen = requests.recv().await.unwrap();
        let lower = seen.to_ascii_lowercase();
        assert!(
            lower.starts_with("put /issues/7.json http/1.1\r\n"),
            "{seen}"
        );
        assert!(lower.contains("\r\nx-redmine-api-key: k3y\r\n"));
        assert!(lower.contains("\r\ncontent-type: application/json\r\n"));
        assert!(lower.contains("\r\ncontent-length: 25\r\n"));
        assert!(seen.ends_with("\r\n\r\n{\"issue\":{\"status_id\":3}}"));
    }

    #[tokio::test]
    async fn a_redirect_comes_back_as_a_3xx_and_is_never_followed() {
        // The redirect target: it must never see a connection (so never the token).
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target_addr = target.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let target_hits = Arc::clone(&hits);
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = target.accept().await {
                target_hits.fetch_add(1, Ordering::SeqCst);
                let _ = read_request(&mut stream).await;
            }
        });
        let location = format!("http://{target_addr}/steal");
        let (base, mut requests) = serve(move |_| {
            format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .into_bytes()
        })
        .await;
        let request =
            HttpRequest::get(format!("{base}/api/v4/user")).header("private-token", "glpat-SECRET");
        let response = transport().send(request).await.unwrap();
        assert_eq!(response.status, 302);
        assert!(requests.recv().await.unwrap().contains("glpat-SECRET"));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(hits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_body_over_the_cap_is_too_large_with_or_without_content_length() {
        let limit = 64 * 1024;
        let transport = ReqwestTransport::with_limits(REQUEST_TIMEOUT, limit).unwrap();
        let (exact, _r1) = serve(move |_| {
            let mut out =
                format!("HTTP/1.1 200 OK\r\nContent-Length: {limit}\r\nConnection: close\r\n\r\n")
                    .into_bytes();
            out.extend(std::iter::repeat_n(b'a', limit));
            out
        })
        .await;
        assert_eq!(
            transport
                .send(HttpRequest::get(exact))
                .await
                .unwrap()
                .body
                .len(),
            limit
        );

        let (declared, _r2) = serve(move |_| {
            let mut out = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                limit + 1
            )
            .into_bytes();
            out.extend(std::iter::repeat_n(b'a', limit + 1));
            out
        })
        .await;
        assert_eq!(
            transport.send(HttpRequest::get(declared)).await,
            Err(TransportError::BodyTooLarge)
        );

        // Chunked, no length announced: the cap applies while streaming.
        let (streamed, _r3) = serve(move |_| {
            let mut out =
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
                    .to_vec();
            for _ in 0..3 {
                let chunk = vec![b'b'; limit / 2];
                out.extend(format!("{:x}\r\n", chunk.len()).into_bytes());
                out.extend(chunk);
                out.extend(b"\r\n");
            }
            out.extend(b"0\r\n\r\n");
            out
        })
        .await;
        assert_eq!(
            transport.send(HttpRequest::get(streamed)).await,
            Err(TransportError::BodyTooLarge)
        );
    }

    #[tokio::test]
    async fn the_timeout_covers_the_headers_and_the_body() {
        let transport =
            ReqwestTransport::with_limits(Duration::from_millis(300), BODY_LIMIT).unwrap();
        // Accepts and never answers.
        let silent = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let silent_addr = silent.local_addr().unwrap();
        let (keep, hold) = oneshot::channel::<()>();
        tokio::spawn(async move {
            let (_stream, _) = silent.accept().await.unwrap();
            let _ = hold.await;
        });
        assert_eq!(
            transport
                .send(HttpRequest::get(format!("http://{silent_addr}/")))
                .await,
            Err(TransportError::Network)
        );

        // Sends the head, then stalls in the body.
        let stalled = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let stalled_addr = stalled.local_addr().unwrap();
        let (keep2, hold2) = oneshot::channel::<()>();
        tokio::spawn(async move {
            let (mut stream, _) = stalled.accept().await.unwrap();
            let _ = read_request(&mut stream).await;
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc")
                .await;
            let _ = hold2.await;
        });
        assert_eq!(
            transport
                .send(HttpRequest::get(format!("http://{stalled_addr}/")))
                .await,
            Err(TransportError::Network)
        );
        drop((keep, keep2));
    }

    #[tokio::test]
    async fn a_refused_connection_or_a_bad_url_is_a_network_error() {
        let closed = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = closed.local_addr().unwrap();
        drop(closed);
        assert_eq!(
            transport()
                .send(HttpRequest::get(format!("http://{addr}/")))
                .await,
            Err(TransportError::Network)
        );
        assert_eq!(
            transport().send(HttpRequest::get("not a url")).await,
            Err(TransportError::Network)
        );
    }

    #[test]
    fn request_debug_never_prints_header_values() {
        let request = HttpRequest::get("https://api.example/x").header("private-token", "SECRET");
        let debug = format!("{request:?}");
        assert!(debug.contains("private-token"));
        assert!(!debug.contains("SECRET"));
        assert!(!debug.contains("api.example"));
    }
}
