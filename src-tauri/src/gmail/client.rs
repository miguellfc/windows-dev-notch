//! Gmail REST client (0.1.0's `gmail-client.ts`): every request carries a bearer access
//! token from [`TokenAccess`], goes straight to the API (no proxy), never follows a redirect and
//! times out after 30 s (the shared [`crate::http`] transport). A 401 asks the token access for a
//! new token once and repeats the request once.
//!
//! Failures carry only a code ([`GmailApiError`], or the [`GmailAuthError`] of a failed refresh,
//! together a [`GmailError`]): never the token, ids or mail data. Nothing here logs.
//!
//! Gmail's own status mapping differs from the code review one ([`crate::http::status_error`]):
//! a 403 is a per-user rate limit, never an auth failure, and a 404 means something different
//! for each call (a list row is dropped, a message is `not-found`, a write is already done).
//!
//! Answers over [`crate::http::BODY_LIMIT`] (16 MiB) are `invalid-response`. Electron read any
//! size; Gmail returns big attachments by id rather than inline, so a text answer that large is
//! not expected.
//!
//! serde_json stops at 128 nested JSON levels. Each MIME level of a `format=full` answer takes
//! two (the part object and its `parts` array), so a mail nested deeper than about 63 MIME
//! levels is `invalid-response`, where Electron's `JSON.parse` read it. Real mail nests a few
//! levels.

use std::borrow::Cow;
use std::fmt;
use std::sync::Arc;

use chrono::{DateTime, Datelike, Timelike, Utc};
use serde::de::DeserializeOwned;
use url::Url;

use crate::contract::gmail::google::{
    Header, MessageFull, MessageList, MessageMetadata, MessagePart, Profile,
};
use crate::contract::gmail::{
    GmailMessage, GmailMessageDetail, HEADER_MAX, RECENT_LIMIT, UNREAD_CAP,
};
use crate::contract::text::js_trim;
use crate::contract::Validate;
use crate::gmail::auth::{is_session_dead, GmailAuthError};
use crate::gmail::headers::{clip, decode_snippet, display_sender, sender_address};
use crate::gmail::message_text::{extract_message, MessageText};
use crate::http::{map_pool, read_json, HttpRequest, HttpResponse, Transport, TransportError};
use crate::ipc::BoxFuture;

/// Production Gmail API origin (paths live under `/gmail/v1/users/me/`).
pub const GMAIL_API_BASE: &str = "https://gmail.googleapis.com";

const PRIMARY: &str = "in:inbox category:primary";
const UNREAD_QUERY: &str = "in:inbox category:primary is:unread";
/// `JSON.stringify({ removeLabelIds: ['UNREAD'] })`.
const MARK_READ_BODY: &[u8] = br#"{"removeLabelIds":["UNREAD"]}"#;
/// The largest time a JS `Date` holds (±8.64e15 ms from the epoch).
const JS_DATE_MAX_MS: i64 = 8_640_000_000_000_000;

/// `GmailApiErrorCode`: the failure of a Gmail API call. Carries only its code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GmailApiError {
    Unauthorized,
    Network,
    RateLimited,
    Server,
    InvalidResponse,
    NotFound,
}

impl GmailApiError {
    /// The code as Electron spells it (logs, `Gmail request failed: <code>`).
    pub fn code(self) -> &'static str {
        match self {
            Self::Unauthorized => "unauthorized",
            Self::Network => "network",
            Self::RateLimited => "rate-limited",
            Self::Server => "server",
            Self::InvalidResponse => "invalid-response",
            Self::NotFound => "not-found",
        }
    }

    /// `statusError`: 401 unauthorized; 429 or 403 rate-limited (Gmail reports per-user rate
    /// limits as 403); 5xx server; anything else (a 3xx, a 400, an unhandled 404)
    /// invalid-response.
    fn from_status(status: u16) -> Self {
        match status {
            401 => Self::Unauthorized,
            403 | 429 => Self::RateLimited,
            500.. => Self::Server,
            _ => Self::InvalidResponse,
        }
    }
}

impl fmt::Display for GmailApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Gmail API failed: {}", self.code())
    }
}

impl std::error::Error for GmailApiError {}

impl From<TransportError> for GmailApiError {
    /// A failed request (`fetch` rejected, or the 30 s timeout) is `network`; a body over the
    /// 16 MiB cap cannot be a valid answer (`invalid-response`).
    fn from(error: TransportError) -> Self {
        match error {
            TransportError::Network => Self::Network,
            TransportError::BodyTooLarge => Self::InvalidResponse,
        }
    }
}

/// What a client call fails with: its own [`GmailApiError`], or the [`GmailAuthError`] that the
/// token access passed on unchanged (a failed refresh), as the TS client lets it through.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GmailError {
    Api(GmailApiError),
    Auth(GmailAuthError),
}

impl GmailError {
    /// `errorCode(error)` of the integration: the code only.
    pub fn code(self) -> &'static str {
        match self {
            Self::Api(error) => error.code(),
            Self::Auth(error) => error.code(),
        }
    }

    /// `isSessionDead`: the API refused the token (`unauthorized`) or the refresh was denied.
    pub fn is_session_dead(self) -> bool {
        match self {
            Self::Api(error) => error == GmailApiError::Unauthorized,
            Self::Auth(error) => is_session_dead(error),
        }
    }

    /// The message of `message(id)` no longer exists.
    pub fn is_not_found(self) -> bool {
        self == Self::Api(GmailApiError::NotFound)
    }
}

impl fmt::Display for GmailError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Api(error) => error.fmt(f),
            Self::Auth(error) => error.fmt(f),
        }
    }
}

impl std::error::Error for GmailError {}

impl From<GmailApiError> for GmailError {
    fn from(error: GmailApiError) -> Self {
        Self::Api(error)
    }
}

impl From<GmailAuthError> for GmailError {
    fn from(error: GmailAuthError) -> Self {
        Self::Auth(error)
    }
}

/// `getAccessToken` / `onUnauthorized` of `GmailClientOptions`, implemented by the integration
/// for one session generation.
pub trait TokenAccess: Send + Sync {
    /// A valid access token. Its error reaches the caller of the client unchanged (a stale
    /// session is `Api(Unauthorized)`; a failed refresh is its `Auth` error).
    fn access_token(&self) -> BoxFuture<'_, Result<String, GmailError>>;

    /// Called once on a 401: forget the access token and refresh it. `Ok(true)` when a new one
    /// is available (the request is sent once more); `Ok(false)` ends the call as
    /// `unauthorized`; an error reaches the caller unchanged.
    fn on_unauthorized(&self) -> BoxFuture<'_, Result<bool, GmailError>>;
}

/// JS `encodeURIComponent`: everything but `A-Z a-z 0-9 - _ . ! ~ * ' ( )` is percent-encoded
/// as UTF-8 with upper-case hex. (A Rust string never holds the lone surrogate that makes JS
/// throw.)
pub fn encode_uri_component(text: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push('%');
            out.push(char::from(HEX[usize::from(byte >> 4)]));
            out.push(char::from(HEX[usize::from(byte & 0x0F)]));
        }
    }
    out
}

/// `Date.prototype.toISOString` of `ms` (epoch milliseconds): `YYYY-MM-DDTHH:MM:SS.mmmZ`, with
/// the expanded `±YYYYYY` year outside 0..=9999. `None` outside the JS range, or the (smaller)
/// chrono one.
fn js_iso_string(ms: i64) -> Option<String> {
    if !(-JS_DATE_MAX_MS..=JS_DATE_MAX_MS).contains(&ms) {
        return None;
    }
    let time = DateTime::<Utc>::from_timestamp_millis(ms)?;
    let year = time.year();
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    Some(format!(
        "{year}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        time.month(),
        time.day(),
        time.hour(),
        time.minute(),
        time.second(),
        time.timestamp_subsec_millis(),
    ))
}

/// Drops one trailing parenthesised comment (`+0000 (UTC)`), as JS `Date` ignores it.
fn strip_trailing_comment(text: &str) -> &str {
    let trimmed = text.trim_end();
    if trimmed.ends_with(')') {
        if let Some(open) = trimmed.rfind('(') {
            return trimmed[..open].trim_end();
        }
    }
    trimmed
}

/// Drops a leading `Word,` (the RFC 2822 weekday), which JS `Date` never checks.
fn strip_weekday(text: &str) -> &str {
    let trimmed = text.trim_start();
    match trimmed.split_once(',') {
        Some((day, rest)) if !day.is_empty() && day.bytes().all(|b| b.is_ascii_alphabetic()) => {
            rest.trim_start()
        }
        _ => trimmed,
    }
}

/// Rewrites a trailing, case-insensitive `UTC` zone (`10:00:00 UTC`), which JS `Date` reads
/// and chrono's RFC 2822 parser does not, as `+0000`.
fn utc_zone_as_offset(text: &str) -> Cow<'_, str> {
    let bytes = text.as_bytes();
    let n = bytes.len();
    if n > 3 && bytes[n - 3..].eq_ignore_ascii_case(b"utc") && bytes[n - 4].is_ascii_whitespace() {
        return Cow::Owned(format!("{}+0000", &text[..n - 3]));
    }
    Cow::Borrowed(text)
}

/// `new Date(header)` for the forms mail uses, as epoch milliseconds: RFC 2822 (obsolete zones
/// and two-digit years included, and a trailing `UTC` read as `+0000`) after one trailing
/// comment and the weekday are dropped, else RFC 3339. Chrono's RFC 2822 parser itself skips a
/// comment still left at the end (`+0000 (a) (b)`); a comment anywhere else fails and the
/// header falls back. A leap second is not a JS date.
fn parse_date_header(header: &str) -> Option<i64> {
    let text = js_trim(header);
    let rfc2822 = utc_zone_as_offset(strip_weekday(strip_trailing_comment(text)));
    let parsed = DateTime::parse_from_rfc2822(&rfc2822)
        .or_else(|_| DateTime::parse_from_rfc3339(text))
        .ok()?;
    if parsed.nanosecond() >= 1_000_000_000 {
        return None;
    }
    Some(parsed.timestamp_millis())
}

/// `isoDate(dateHeader, internalDate)`: the `Date` header when it parses (an empty header is
/// skipped), else an all-ASCII-digit `internalDate` in epoch milliseconds, else
/// `invalid-response`. Output as [`js_iso_string`].
///
/// Deviations from JS `Date` (documented in the task report): only RFC 2822 and RFC 3339 are
/// read; JS's other forms (no zone, read in local time; ISO date only; `Nov 11 2025`; ...) fall
/// back to `internalDate`. Chrono's range ends near year 262143, below JS's 275760: a date past
/// it is invalid here.
pub fn iso_date(date_header: Option<&str>, internal_date: &str) -> Result<String, GmailApiError> {
    if let Some(header) = date_header.filter(|header| !header.is_empty()) {
        if let Some(text) = parse_date_header(header).and_then(js_iso_string) {
            return Ok(text);
        }
    }
    // `/^\d+$/` then `Number(...)`: past 8.64e15 (or u64) the date is invalid anyway.
    if internal_date.is_empty() || !internal_date.bytes().all(|b| b.is_ascii_digit()) {
        return Err(GmailApiError::InvalidResponse);
    }
    internal_date
        .parse::<u64>()
        .ok()
        .and_then(|ms| i64::try_from(ms).ok())
        .and_then(js_iso_string)
        .ok_or(GmailApiError::InvalidResponse)
}

/// `header(headers, name)`: the first header with that name, compared with `toLowerCase`.
fn header<'a>(headers: &'a [Header], name: &str) -> Option<&'a str> {
    let name = name.to_lowercase();
    headers
        .iter()
        .find(|h| h.name.to_lowercase() == name)
        .map(|h| h.value.as_str())
}

/// `labelIds?.includes('UNREAD') ?? false`.
fn is_unread(label_ids: Option<&Vec<String>>) -> bool {
    label_ids.is_some_and(|labels| labels.iter().any(|label| label == "UNREAD"))
}

/// `messagePath(id)`.
fn message_path(id: &str) -> String {
    format!("messages/{}", encode_uri_component(id))
}

/// A write: `POST` with a JSON body, or `DELETE` without one.
#[derive(Clone, Copy)]
enum Write {
    Post(&'static [u8]),
    Delete,
}

/// The Gmail API calls the integration makes. Async through [`BoxFuture`], so the integration
/// can hold an `Arc<dyn GmailApiClient>` and tests can inject a fake.
pub trait GmailApiClient: Send + Sync {
    /// Address of the signed-in account.
    fn profile(&self) -> BoxFuture<'_, Result<String, GmailError>>;
    /// Ids of the unread messages in Primary, newest first, at most `UNREAD_CAP` (the count is
    /// its length).
    fn unread_ids(&self) -> BoxFuture<'_, Result<Vec<String>, GmailError>>;
    /// The most recent messages in Primary (at most `RECENT_LIMIT`), newest first.
    fn recent(&self) -> BoxFuture<'_, Result<Vec<GmailMessage>, GmailError>>;
    /// One message as a list row (metadata only); `None` when it no longer exists.
    fn summary<'a>(
        &'a self,
        id: &'a str,
    ) -> BoxFuture<'a, Result<Option<GmailMessage>, GmailError>>;
    /// One message as plain text (`format=full`); a missing message is `not-found`.
    fn message<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<GmailMessageDetail, GmailError>>;
    /// Removes the UNREAD label; a message that no longer exists counts as done.
    fn mark_read<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), GmailError>>;
    /// Deletes the message permanently (no trash); a message that no longer exists counts as
    /// done.
    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), GmailError>>;
}

type Extractor = fn(&MessagePart) -> MessageText;

/// `createGmailClient`: one client per session generation (its [`TokenAccess`] is bound to it).
pub struct GmailClient {
    transport: Arc<dyn Transport>,
    api_base: String,
    access: Arc<dyn TokenAccess>,
    extract: Extractor,
}

impl fmt::Debug for GmailClient {
    /// Never prints the token access or the API base.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GmailClient").finish_non_exhaustive()
    }
}

impl GmailClient {
    /// `api_base` is an origin without a trailing `/`: [`GMAIL_API_BASE`], or the validated
    /// loopback override of a fake server. It is not checked, as in TS.
    pub fn new(
        transport: Arc<dyn Transport>,
        api_base: impl Into<String>,
        access: Arc<dyn TokenAccess>,
    ) -> Self {
        Self {
            transport,
            api_base: api_base.into(),
            access,
            extract: extract_message,
        }
    }

    /// Replaces the text extractor (tests: an extractor that fails).
    #[cfg(test)]
    fn with_extractor(mut self, extract: Extractor) -> Self {
        self.extract = extract;
        self
    }

    /// `new URL(apiBase + "/gmail/v1/users/me/" + path)` plus `searchParams.append` for each
    /// pair, in order. An unparseable base is `network` and nothing is sent (the integration
    /// only passes valid origins).
    fn url(&self, path: &str, query: &[(&str, &str)]) -> Result<String, GmailApiError> {
        let mut url = Url::parse(&format!("{}/gmail/v1/users/me/{path}", self.api_base))
            .map_err(|_| GmailApiError::Network)?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        Ok(url.into())
    }

    /// `send`: the token (its error passes through), the bearer and `accept` headers, a JSON
    /// body for a POST; a failed request is `network`.
    async fn send(&self, url: &str, write: Option<Write>) -> Result<HttpResponse, GmailError> {
        let token = self.access.access_token().await?;
        let request = match write {
            None => HttpRequest::get(url),
            Some(Write::Post(body)) => HttpRequest::post(url, body.to_vec()),
            Some(Write::Delete) => HttpRequest::delete(url),
        }
        .header("authorization", format!("Bearer {token}"))
        .header("accept", "application/json");
        let request = match write {
            Some(Write::Post(_)) => request.header("content-type", "application/json"),
            _ => request,
        };
        Ok(self
            .transport
            .send(request)
            .await
            .map_err(GmailApiError::from)?)
    }

    /// `request`: sends once; on a 401, one refresh and one retry (a refused refresh is
    /// `unauthorized`; a second 401 is left to the caller's mapping, never a loop).
    async fn request(
        &self,
        path: &str,
        query: &[(&str, &str)],
        write: Option<Write>,
    ) -> Result<HttpResponse, GmailError> {
        let url = self.url(path, query)?;
        let mut response = self.send(&url, write).await?;
        if response.status == 401 {
            if !self.access.on_unauthorized().await? {
                return Err(GmailApiError::Unauthorized.into());
            }
            response = self.send(&url, write).await?;
        }
        Ok(response)
    }

    /// `writeTo`: a write whose target is gone (404) is already done.
    async fn write_to(&self, path: &str, write: Write) -> Result<(), GmailError> {
        let response = self.request(path, &[], Some(write)).await?;
        if response.status == 404 || response.is_ok() {
            return Ok(());
        }
        Err(GmailApiError::from_status(response.status).into())
    }

    /// `getOrMissing`: a 404 is `None`; another non-2xx is mapped; the body must be JSON of
    /// the expected shape, else `invalid-response`.
    async fn get_or_missing<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<Option<T>, GmailError> {
        let response = self.request(path, query, None).await?;
        if response.status == 404 {
            return Ok(None);
        }
        if !response.is_ok() {
            return Err(GmailApiError::from_status(response.status).into());
        }
        read_json(&response)
            .map(Some)
            .map_err(|_| GmailApiError::InvalidResponse.into())
    }

    /// `get`: [`Self::get_or_missing`] where a 404 is `invalid-response`.
    async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T, GmailError> {
        self.get_or_missing(path, query)
            .await?
            .ok_or_else(|| GmailApiError::from_status(404).into())
    }

    /// `list(q, maxResults)`: the ids of one `messages.list` page (none when absent).
    async fn list(&self, q: &str, max_results: usize) -> Result<Vec<String>, GmailError> {
        let max = max_results.to_string();
        let list: MessageList = self
            .get("messages", &[("q", q), ("maxResults", &max)])
            .await?;
        Ok(list
            .messages
            .unwrap_or_default()
            .into_iter()
            .take(max_results)
            .map(|message| message.id)
            .collect())
    }

    pub async fn profile(&self) -> Result<String, GmailError> {
        let profile: Profile = self.get("profile", &[]).await?;
        Ok(profile.email_address)
    }

    pub async fn unread_ids(&self) -> Result<Vec<String>, GmailError> {
        self.list(UNREAD_QUERY, UNREAD_CAP as usize).await
    }

    /// `Promise.all` over the summaries: list order kept whatever order they arrive in, the
    /// first failure fails the list (the others still in flight are dropped), 404s dropped.
    pub async fn recent(&self) -> Result<Vec<GmailMessage>, GmailError> {
        let ids = self.list(PRIMARY, RECENT_LIMIT).await?;
        let found = map_pool(&ids, RECENT_LIMIT, |id| self.summary(id)).await?;
        Ok(found.into_iter().flatten().collect())
    }

    pub async fn summary(&self, id: &str) -> Result<Option<GmailMessage>, GmailError> {
        let meta: Option<MessageMetadata> = self
            .get_or_missing(
                &message_path(id),
                &[
                    ("format", "metadata"),
                    ("metadataHeaders", "From"),
                    ("metadataHeaders", "Subject"),
                    ("metadataHeaders", "Date"),
                ],
            )
            .await?;
        // Deleted between the list and its metadata.
        let Some(meta) = meta else { return Ok(None) };
        let headers = &meta.payload.headers;
        Ok(Some(GmailMessage {
            from: display_sender(header(headers, "From")),
            subject: header(headers, "Subject").unwrap_or("").to_owned(),
            snippet: decode_snippet(&meta.snippet),
            date: iso_date(header(headers, "Date"), &meta.internal_date)?,
            unread: is_unread(meta.label_ids.as_ref()),
            id: meta.id,
            thread_id: meta.thread_id,
        }))
    }

    pub async fn message(&self, id: &str) -> Result<GmailMessageDetail, GmailError> {
        let full: Option<MessageFull> = self
            .get_or_missing(&message_path(id), &[("format", "full")])
            .await?;
        let MessageFull {
            id: message_id,
            thread_id,
            label_ids,
            internal_date,
            payload,
        } = full.ok_or(GmailApiError::NotFound)?;
        // Hostile HTML can take a while to tokenize: the extraction runs on a blocking thread,
        // never on an async worker. A mail the extractor cannot read (a panic, or a lost
        // blocking task) is a clean error for the reader, never a crash.
        let extract = self.extract;
        let (extracted, payload) = tokio::task::spawn_blocking(move || {
            let extracted = extract(&payload);
            (extracted, payload)
        })
        .await
        .map_err(|_| GmailApiError::InvalidResponse)?;
        let headers = &payload.headers;
        let from = header(headers, "From");
        // Headers are cut to the schema's bound: an odd long header never makes a mail
        // unreadable.
        let detail = GmailMessageDetail {
            from: clip(&display_sender(from), HEADER_MAX),
            from_address: clip(&sender_address(from), HEADER_MAX),
            subject: clip(header(headers, "Subject").unwrap_or(""), HEADER_MAX),
            date: iso_date(header(headers, "Date"), &internal_date)?,
            unread: is_unread(label_ids.as_ref()),
            body: extracted.body,
            truncated: extracted.truncated,
            links: extracted.links,
            attachments: extracted.attachments,
            id: message_id,
            thread_id,
        };
        detail
            .validate()
            .map_err(|_| GmailApiError::InvalidResponse)?;
        Ok(detail)
    }

    pub async fn mark_read(&self, id: &str) -> Result<(), GmailError> {
        let path = format!("{}/modify", message_path(id));
        self.write_to(&path, Write::Post(MARK_READ_BODY)).await
    }

    pub async fn remove(&self, id: &str) -> Result<(), GmailError> {
        self.write_to(&message_path(id), Write::Delete).await
    }
}

impl GmailApiClient for GmailClient {
    fn profile(&self) -> BoxFuture<'_, Result<String, GmailError>> {
        Box::pin(Self::profile(self))
    }

    fn unread_ids(&self) -> BoxFuture<'_, Result<Vec<String>, GmailError>> {
        Box::pin(Self::unread_ids(self))
    }

    fn recent(&self) -> BoxFuture<'_, Result<Vec<GmailMessage>, GmailError>> {
        Box::pin(Self::recent(self))
    }

    fn summary<'a>(
        &'a self,
        id: &'a str,
    ) -> BoxFuture<'a, Result<Option<GmailMessage>, GmailError>> {
        Box::pin(Self::summary(self, id))
    }

    fn message<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<GmailMessageDetail, GmailError>> {
        Box::pin(Self::message(self, id))
    }

    fn mark_read<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), GmailError>> {
        Box::pin(Self::mark_read(self, id))
    }

    fn remove<'a>(&'a self, id: &'a str) -> BoxFuture<'a, Result<(), GmailError>> {
        Box::pin(Self::remove(self, id))
    }
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
