//! Gmail OAuth for a desktop client (`src/main/gmail/gmail-auth.ts` and `auth-error.ts`):
//! PKCE (S256) with an anti-CSRF state, the consent screen in the user's browser, the
//! [`loopback`](super::loopback) redirect, and the `/token` and `/revoke` calls.
//!
//! Every token call is a form POST (`application/x-www-form-urlencoded`, fields in the TS
//! order) with its own [`AUTH_TIMEOUT`]; a timeout or a failed request is `network`. Nothing
//! here logs: errors are codes only, and `Debug` never prints a token, the client secret, the
//! code, the verifier or the state.

use std::fmt;
use std::io;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use base64::Engine as _;
use sha2::{Digest, Sha256};
use tokio::sync::watch;

use super::loopback::{self, Loopback, LoopbackCloser, LOOPBACK_TIMEOUT};
use crate::apps::OpenExternal;
use crate::contract::gmail::google::TokenResponse;
use crate::contract::text::is_js_whitespace;
use crate::http::{is_redirect, read_json, HttpRequest, HttpResponse, Transport};
use crate::ipc::BoxFuture;
use crate::services::clock::WallClock;

/// Full mail access: the only scope that allows permanent deletion (`messages.delete`).
pub const GMAIL_SCOPE: &str = "https://mail.google.com/";
pub const GOOGLE_AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
/// Origin serving `/token` and `/revoke`.
pub const GOOGLE_OAUTH_BASE: &str = "https://oauth2.googleapis.com";
/// `GMAIL_AUTH_TIMEOUT_MS`: a token exchange, refresh or revoke that has not answered by then
/// fails as `network`.
pub const AUTH_TIMEOUT: Duration = Duration::from_secs(30);
/// Path of the consent screen under a base override (the E2E fake).
const AUTH_PATH: &str = "/o/oauth2/v2/auth";
const FORM: &str = "application/x-www-form-urlencoded";
const BASE64URL: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

/// `GmailAuthError`: a failure of the OAuth flow, as a code only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GmailAuthError {
    Cancelled,
    Timeout,
    Denied,
    Network,
    InvalidResponse,
}

impl GmailAuthError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Cancelled => "cancelled",
            Self::Timeout => "timeout",
            Self::Denied => "denied",
            Self::Network => "network",
            Self::InvalidResponse => "invalid-response",
        }
    }
}

impl fmt::Display for GmailAuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Gmail auth failed: {}", self.code())
    }
}

impl std::error::Error for GmailAuthError {}

/// The auth half of `isSessionDead`: a refresh Google refused (400/401) ends the session. The
/// Gmail client's `unauthorized` is the other half ([`crate::gmail::client::GmailError`]).
pub fn is_session_dead(error: GmailAuthError) -> bool {
    error == GmailAuthError::Denied
}

/// Why [`GmailAuth::sign_in`] failed: the flow's own error, or the local setup (the loopback
/// could not listen, or no randomness), which TS rethrows as is and the integration logs by
/// name and answers `error`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SignInError {
    Auth(GmailAuthError),
    Setup(io::ErrorKind),
}

impl SignInError {
    /// `errorCode(error)`: the auth code, or the I/O error kind.
    pub fn code(&self) -> String {
        match self {
            Self::Auth(error) => error.code().to_owned(),
            Self::Setup(kind) => format!("{kind:?}"),
        }
    }

    pub fn is_cancelled(&self) -> bool {
        *self == Self::Auth(GmailAuthError::Cancelled)
    }
}

impl From<GmailAuthError> for SignInError {
    fn from(error: GmailAuthError) -> Self {
        Self::Auth(error)
    }
}

/// `hasRequiredScope`: true when Google's whitespace-separated (`/\s+/`) scope list holds
/// exactly [`GMAIL_SCOPE`].
pub fn has_required_scope(scope: Option<&str>) -> bool {
    match scope {
        Some(scope) if !scope.is_empty() => scope.split(is_js_whitespace).any(|s| s == GMAIL_SCOPE),
        _ => false,
    }
}

/// `pkceChallenge`: base64url (no padding) of SHA-256 of the verifier.
pub fn pkce_challenge(verifier: &str) -> String {
    BASE64URL.encode(Sha256::digest(verifier.as_bytes()))
}

/// `createPkce`: a verifier from 32 random bytes (43 characters), its S256 challenge and a
/// state from 16 random bytes (22 characters), all base64url without padding.
#[derive(Clone, PartialEq, Eq)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

impl fmt::Debug for Pkce {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Pkce").finish_non_exhaustive()
    }
}

impl Pkce {
    /// From the OS random generator.
    pub fn generate() -> io::Result<Self> {
        Self::from_random(|length| {
            let mut bytes = vec![0; length];
            getrandom::fill(&mut bytes).map_err(|_| io::Error::other("no randomness"))?;
            Ok(bytes)
        })
    }

    /// With injected randomness (`random(n)` gives `n` bytes): the verifier first, then the state.
    pub fn from_random(mut random: impl FnMut(usize) -> io::Result<Vec<u8>>) -> io::Result<Self> {
        let verifier = BASE64URL.encode(random(32)?);
        let state = BASE64URL.encode(random(16)?);
        Ok(Self {
            challenge: pkce_challenge(&verifier),
            verifier,
            state,
        })
    }
}

/// A finished sign-in. `expires_at` is in epoch milliseconds (`now() + expires_in * 1000`).
#[derive(Clone, PartialEq)]
pub struct SignInResult {
    pub refresh_token: String,
    pub access_token: String,
    pub expires_at: f64,
    /// The scopes Google granted, when it says (check with [`has_required_scope`]).
    pub scope: Option<String>,
}

impl fmt::Debug for SignInResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SignInResult")
            .field("expires_at", &self.expires_at)
            .field("scope", &self.scope)
            .finish_non_exhaustive()
    }
}

/// A refreshed access token; the caller checks `scope` with [`has_required_scope`].
#[derive(Clone, PartialEq)]
pub struct RefreshResult {
    pub access_token: String,
    pub expires_at: f64,
    pub scope: Option<String>,
}

impl fmt::Debug for RefreshResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RefreshResult")
            .field("expires_at", &self.expires_at)
            .field("scope", &self.scope)
            .finish_non_exhaustive()
    }
}

/// `GmailAuth`, as the integration sees it (a fake in its tests, [`GoogleAuth`] in the app).
pub trait GmailAuth: Send + Sync {
    /// One sign-in at a time: starting one cancels the previous (`cancelled`).
    fn sign_in(&self) -> BoxFuture<'_, Result<SignInResult, SignInError>>;
    /// Cancels the pending sign-in, if any: its loopback closes, its exchange is aborted and it
    /// fails with `cancelled`.
    fn cancel(&self);
    /// `denied` (400/401: the session is dead), `network` (5xx, 429, failure, timeout) or
    /// `invalid-response`.
    fn refresh<'a>(
        &'a self,
        refresh_token: &'a str,
    ) -> BoxFuture<'a, Result<RefreshResult, GmailAuthError>>;
    /// Best effort; never fails, and ends within [`AUTH_TIMEOUT`].
    fn revoke<'a>(&'a self, token: &'a str) -> BoxFuture<'a, ()>;
}

/// The client and the OAuth endpoints. `Debug` prints neither the id nor the secret.
#[derive(Clone, PartialEq, Eq)]
pub struct GoogleAuthConfig {
    pub client_id: String,
    pub client_secret: String,
    /// Origin of `/token` and `/revoke`.
    pub oauth_base: String,
    /// The consent screen.
    pub auth_url: String,
}

impl fmt::Debug for GoogleAuthConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GoogleAuthConfig")
            .field("oauth_base", &self.oauth_base)
            .field("auth_url", &self.auth_url)
            .finish_non_exhaustive()
    }
}

impl GoogleAuthConfig {
    /// Google's endpoints, or every one on `base_override` (the dev/E2E
    /// `NOTCH_GMAIL_BASE_URL`, already checked): `/token`, `/revoke` and `/o/oauth2/v2/auth`.
    pub fn new(client_id: &str, client_secret: &str, base_override: Option<&str>) -> Self {
        let (oauth_base, auth_url) = match base_override {
            Some(base) => (base.to_owned(), format!("{base}{AUTH_PATH}")),
            None => (GOOGLE_OAUTH_BASE.to_owned(), GOOGLE_AUTH_URL.to_owned()),
        };
        Self {
            client_id: client_id.to_owned(),
            client_secret: client_secret.to_owned(),
            oauth_base,
            auth_url,
        }
    }
}

/// One sign-in attempt.
struct Session {
    cancelled: watch::Sender<bool>,
    loopback: Mutex<Option<LoopbackCloser>>,
}

impl Session {
    fn new() -> Self {
        Self {
            cancelled: watch::channel(false).0,
            loopback: Mutex::new(None),
        }
    }

    fn is_cancelled(&self) -> bool {
        *self.cancelled.borrow()
    }

    /// `cancelSession`: flags it, aborts its exchange and closes its loopback.
    fn cancel(&self) {
        self.cancelled.send_replace(true);
        self.close_loopback();
    }

    fn close_loopback(&self) {
        if let Some(closer) = lock(&self.loopback).as_ref() {
            closer.close();
        }
    }

    async fn until_cancelled(&self) {
        let mut cancelled = self.cancelled.subscribe();
        // The sender lives in `self`, so this only ends on a cancel.
        let _ = cancelled.wait_for(|cancelled| *cancelled).await;
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `createGmailAuth` over the shared transport, an injected browser opener and the wall clock.
pub struct GoogleAuth {
    transport: Arc<dyn Transport>,
    open: OpenExternal,
    clock: Arc<WallClock>,
    config: GoogleAuthConfig,
    request_timeout: Duration,
    loopback_timeout: Duration,
    current: Mutex<Option<Arc<Session>>>,
}

/// `finally` of `signIn`: closes the loopback and forgets the session, also when the sign-in
/// future is dropped.
struct SessionGuard<'a> {
    current: &'a Mutex<Option<Arc<Session>>>,
    session: Arc<Session>,
}

impl Drop for SessionGuard<'_> {
    fn drop(&mut self) {
        self.session.close_loopback();
        let mut current = lock(self.current);
        if current
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, &self.session))
        {
            *current = None;
        }
    }
}

impl GoogleAuth {
    /// [`AUTH_TIMEOUT`] per token call and [`LOOPBACK_TIMEOUT`] for the browser.
    pub fn new(
        transport: Arc<dyn Transport>,
        open: OpenExternal,
        clock: Arc<WallClock>,
        config: GoogleAuthConfig,
    ) -> Self {
        Self {
            transport,
            open,
            clock,
            config,
            request_timeout: AUTH_TIMEOUT,
            loopback_timeout: LOOPBACK_TIMEOUT,
            current: Mutex::new(None),
        }
    }

    /// Other limits (tests).
    #[must_use]
    pub fn with_timeouts(mut self, request: Duration, loopback: Duration) -> Self {
        self.request_timeout = request;
        self.loopback_timeout = loopback;
        self
    }

    pub fn request_timeout(&self) -> Duration {
        self.request_timeout
    }

    pub fn loopback_timeout(&self) -> Duration {
        self.loopback_timeout
    }

    fn expires_at(&self, expires_in: f64) -> f64 {
        self.clock.now().timestamp_millis() as f64 + expires_in * 1000.0
    }

    /// `postForm`: any failure, the timeout and an abort included, is `network`; a caller maps
    /// a real cancel to `cancelled` itself. Dropping the request future aborts it.
    ///
    /// Deviation: a 3xx is `network` too. Electron's `fetch` followed redirects, so
    /// a 3xx never reached `readTokens`; this transport never follows them, and a captive
    /// portal's 302 must not read as a refused refresh (`denied` signs the user out).
    async fn post_form(
        &self,
        path: &str,
        fields: &[(&str, &str)],
        session: Option<&Session>,
    ) -> Result<HttpResponse, GmailAuthError> {
        let body = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(fields)
            .finish();
        let request = HttpRequest::post(
            format!("{}{path}", self.config.oauth_base),
            body.into_bytes(),
        )
        .header("content-type", FORM);
        let send = tokio::time::timeout(self.request_timeout, self.transport.send(request));
        let cancelled = async {
            match session {
                Some(session) => session.until_cancelled().await,
                None => std::future::pending().await,
            }
        };
        // A cancel wins over an answer that arrives in the same poll: TS aborts at once.
        tokio::select! {
            biased;
            () = cancelled => Err(GmailAuthError::Network),
            sent = send => match sent {
                Ok(Ok(response)) if !is_redirect(response.status) => Ok(response),
                _ => Err(GmailAuthError::Network),
            },
        }
    }

    /// The synchronous start of `signIn()`: cancels the current session and makes a new one
    /// current before any await, so a `cancel()` right after `sign_in()` (even before the
    /// future is first polled) reaches it.
    fn begin_session(&self) -> SessionGuard<'_> {
        let session = Arc::new(Session::new());
        let previous = lock(&self.current).replace(Arc::clone(&session));
        if let Some(previous) = previous {
            previous.cancel();
        }
        SessionGuard {
            current: &self.current,
            session,
        }
    }

    async fn run_sign_in(&self, guard: SessionGuard<'_>) -> Result<SignInResult, SignInError> {
        let session = Arc::clone(&guard.session);

        let pkce = Pkce::generate().map_err(|error| SignInError::Setup(error.kind()))?;
        let Loopback {
            redirect_uri,
            code,
            closer,
        } = loopback::start(&pkce.state, self.loopback_timeout)
            .await
            .map_err(|error| SignInError::Setup(error.kind()))?;
        *lock(&session.loopback) = Some(closer.clone());
        if session.is_cancelled() {
            closer.close();
        }

        let consent = consent_url(&self.config, &redirect_uri, &pkce)
            .ok_or(SignInError::Setup(io::ErrorKind::InvalidInput))?;
        if !session.is_cancelled() && (self.open)(consent).await.is_err() {
            closer.close();
            return Err(GmailAuthError::Network.into());
        }

        let code = code.await?;
        let fields = [
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("client_id", self.config.client_id.as_str()),
            ("client_secret", self.config.client_secret.as_str()),
            ("redirect_uri", redirect_uri.as_str()),
            ("code_verifier", pkce.verifier.as_str()),
        ];
        let exchanged = self
            .post_form("/token", &fields, Some(&session))
            .await
            .and_then(|response| read_tokens(&response, GmailAuthError::InvalidResponse));
        let tokens = match exchanged {
            Ok(tokens) => tokens,
            Err(_) if session.is_cancelled() => return Err(GmailAuthError::Cancelled.into()),
            Err(error) => return Err(error.into()),
        };
        if session.is_cancelled() {
            return Err(GmailAuthError::Cancelled.into());
        }
        let Some(refresh_token) = tokens.refresh_token else {
            return Err(GmailAuthError::InvalidResponse.into());
        };
        Ok(SignInResult {
            refresh_token,
            access_token: tokens.access_token,
            expires_at: self.expires_at(tokens.expires_in),
            scope: tokens.scope,
        })
    }

    async fn run_refresh(&self, refresh_token: &str) -> Result<RefreshResult, GmailAuthError> {
        let fields = [
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", self.config.client_id.as_str()),
            ("client_secret", self.config.client_secret.as_str()),
        ];
        let response = self.post_form("/token", &fields, None).await?;
        let tokens = read_tokens(&response, GmailAuthError::Denied)?;
        Ok(RefreshResult {
            access_token: tokens.access_token,
            expires_at: self.expires_at(tokens.expires_in),
            scope: tokens.scope,
        })
    }
}

/// The consent URL: `auth_url` with its query replaced by the nine parameters in the TS order
/// (`URLSearchParams` encoding). `None` when `auth_url` is not a URL.
fn consent_url(config: &GoogleAuthConfig, redirect_uri: &str, pkce: &Pkce) -> Option<String> {
    let mut url = url::Url::parse(&config.auth_url).ok()?;
    url.set_query(None);
    url.query_pairs_mut()
        .append_pair("client_id", &config.client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", GMAIL_SCOPE)
        .append_pair("code_challenge", &pkce.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &pkce.state)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    Some(url.into())
}

/// `readTokens`: 5xx or 429 -> `network`; another non-2xx -> `failure`; a body that is not a
/// token response -> `invalid-response`.
fn read_tokens(
    response: &HttpResponse,
    failure: GmailAuthError,
) -> Result<TokenResponse, GmailAuthError> {
    if response.status >= 500 || response.status == 429 {
        return Err(GmailAuthError::Network);
    }
    if !response.is_ok() {
        return Err(failure);
    }
    read_json(response).map_err(|_| GmailAuthError::InvalidResponse)
}

impl GmailAuth for GoogleAuth {
    fn sign_in(&self) -> BoxFuture<'_, Result<SignInResult, SignInError>> {
        // Registered now, not on the first poll; the guard travels with the future.
        let guard = self.begin_session();
        Box::pin(self.run_sign_in(guard))
    }

    fn cancel(&self) {
        let current = lock(&self.current).clone();
        if let Some(session) = current {
            session.cancel();
        }
    }

    fn refresh<'a>(
        &'a self,
        refresh_token: &'a str,
    ) -> BoxFuture<'a, Result<RefreshResult, GmailAuthError>> {
        Box::pin(self.run_refresh(refresh_token))
    }

    fn revoke<'a>(&'a self, token: &'a str) -> BoxFuture<'a, ()> {
        Box::pin(async move {
            // Best effort: the caller discards the token either way.
            let _ = self.post_form("/revoke", &[("token", token)], None).await;
        })
    }
}

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;
