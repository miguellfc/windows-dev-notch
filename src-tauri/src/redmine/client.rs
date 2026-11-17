//! Redmine REST client (0.1.0's `redmine-client.ts`): every request carries
//! `x-redmine-api-key` (never `authorization`, never the key in the URL), never follows a redirect
//! and times out (the shared [`crate::http`] pieces). Reads fail with [`ApiError`]; writes never
//! fail and return a [`RedmineWriteResult`].
//!
//! As in the code review clients, bodies are parsed to a [`serde_json::Value`] and checked by
//! hand with zod's rules (see [`crate::http::zod`]): not strict, and optional wherever Redmine (or
//! a plugin or version) may omit a field.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{Map, Value};
use tokio::sync::OnceCell;
use url::Url;

use crate::claude::js_json::stringify;
use crate::contract::code_review::is_day_key;
use crate::contract::redmine::{
    LogTimeInput, Named, RedmineActivity, RedmineIssue, RedmineIssueDetail, RedmineIssueList,
    RedmineWriteError, RedmineWriteResult, UpdateIssueInput,
};
use crate::contract::text::js_trim;
use crate::http::zod::{
    array, boolean, count, int, invalid, non_negative, nullish, object, required, string, Parsed,
};
use crate::http::{
    clip, read_json, send, send_raw, ApiError, HttpRequest, HttpResponse, Transport,
};
use crate::ipc::BoxFuture;
use crate::settings::validate::normalize_redmine_url;

/// Items per page (`limit`) and the most pages read per query.
pub const REDMINE_PAGE_SIZE: usize = 100;
pub const REDMINE_ISSUE_MAX_PAGES: usize = 3;
pub const REDMINE_TIME_ENTRY_MAX_PAGES: usize = 10;

/// Every text read from Redmine (subject, project, names, `updated_on`) is clipped to this.
const TEXT_CLIP: usize = 512;
const VALIDATION_MESSAGE_MAX: usize = 200;
const VALIDATION_MESSAGES_MAX: usize = 3;

/// `createRedmineClient` throws: the base URL is not a normalized https URL (nor an allowed
/// loopback http one). Carries nothing (never the URL).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidRedmineUrl;

impl std::fmt::Display for InvalidRedmineUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Redmine base URL must be a normalized https URL")
    }
}

impl std::error::Error for InvalidRedmineUrl {}

/// `viewer()`: the key's account, id and display name ("firstname lastname", or the login).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Viewer {
    pub id: u64,
    pub name: String,
}

/// One item of `timeEntries(from, to)`: a local day `YYYY-MM-DD` and its hours.
#[derive(Clone, Debug, PartialEq)]
pub struct TimeEntry {
    pub date: String,
    pub hours: f64,
}

/// `updateIssue(id, patch)`: only the given fields are sent. `estimated_hours: Some(None)` sends
/// `null` (clears the estimate).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct IssuePatch {
    pub status_id: Option<u64>,
    pub estimated_hours: Option<Option<f64>>,
}

impl From<&UpdateIssueInput> for IssuePatch {
    fn from(input: &UpdateIssueInput) -> Self {
        Self {
            status_id: input.status_id,
            estimated_hours: input.estimated_hours,
        }
    }
}

/// `logTime(entry)`: the time entry to create (`LogTimeInput`).
#[derive(Clone, Debug, PartialEq)]
pub struct TimeEntryInput {
    pub issue_id: u64,
    pub spent_on: String,
    pub hours: f64,
    pub activity_id: u64,
    pub comments: String,
}

impl From<&LogTimeInput> for TimeEntryInput {
    fn from(input: &LogTimeInput) -> Self {
        Self {
            issue_id: input.issue_id,
            spent_on: input.spent_on.clone(),
            hours: input.hours,
            activity_id: input.activity_id,
            comments: input.comments.clone(),
        }
    }
}

/// `createRedmineClient`. The status and activity lists are cached for the lifetime of the client
/// (one client per key and URL session); a failed read is not cached.
pub struct RedmineClient {
    transport: Arc<dyn Transport>,
    base_url: String,
    key: String,
    statuses: OnceCell<Vec<Named>>,
    activities: OnceCell<Vec<RedmineActivity>>,
}

impl std::fmt::Debug for RedmineClient {
    /// Never prints the key (nor the server URL).
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RedmineClient").finish_non_exhaustive()
    }
}

/// `^http:\/\/127\.0\.0\.1:\d{1,5}$` (the port is not range-checked, as in TS).
fn is_loopback_http(base_url: &str) -> bool {
    base_url
        .strip_prefix("http://127.0.0.1:")
        .is_some_and(|port| {
            (1..=5).contains(&port.len()) && port.bytes().all(|b| b.is_ascii_digit())
        })
}

/// `namedSchema`: `{ id: z.int(), name: string }`.
fn named(value: &Value) -> Parsed<Named> {
    let node = object(value)?;
    Ok(Named {
        id: int(required(node, "id")?)?,
        name: string(required(node, "name")?)?.to_owned(),
    })
}

fn named_list(value: &Value) -> Parsed<Vec<Named>> {
    array(value)?.iter().map(named).collect()
}

/// `hoursSchema`: `z.number().min(0).nullable().optional()`.
fn hours(node: &Map<String, Value>, key: &str) -> Parsed<Option<f64>> {
    nullish(node, key).map(non_negative).transpose()
}

/// A string field that is `string | null | absent`.
fn nullish_string<'a>(node: &'a Map<String, Value>, key: &str) -> Parsed<Option<&'a str>> {
    nullish(node, key).map(string).transpose()
}

/// `issueSchema` mapped by `toIssue`, plus its `allowed_statuses` (absent or `null` is `None`).
struct RawIssue {
    issue: RedmineIssue,
    allowed_statuses: Option<Vec<Named>>,
}

fn raw_issue(value: &Value) -> Parsed<RawIssue> {
    let node = object(value)?;
    let id = u64::try_from(int(required(node, "id")?)?).map_err(|_| ApiError::InvalidResponse)?;
    if id < 1 {
        return invalid();
    }
    let subject = string(required(node, "subject")?)?;
    let project = string(required(object(required(node, "project")?)?, "name")?)?;
    let status = named(required(node, "status")?)?;
    // Every hours field is checked, even the one `spentHours` does not end up using.
    let estimated_hours = hours(node, "estimated_hours")?;
    let spent_hours = hours(node, "spent_hours")?;
    let total_spent_hours = hours(node, "total_spent_hours")?;
    let updated_on = string(required(node, "updated_on")?)?;
    let allowed_statuses = nullish(node, "allowed_statuses")
        .map(named_list)
        .transpose()?;
    Ok(RawIssue {
        issue: RedmineIssue {
            id,
            subject: clip(subject, TEXT_CLIP),
            project: clip(project, TEXT_CLIP),
            status: Named {
                id: status.id,
                name: clip(&status.name, TEXT_CLIP),
            },
            estimated_hours,
            // `spent_hours ?? total_spent_hours ?? null`.
            spent_hours: spent_hours.or(total_spent_hours),
            updated_on: clip(updated_on, TEXT_CLIP),
        },
        allowed_statuses,
    })
}

/// One page read: its items and its `total_count`.
type Page<T> = Parsed<(Vec<T>, Option<u64>)>;

/// `total_count`: `z.int().min(0).nullable().optional()`.
fn total_count(node: &Map<String, Value>) -> Parsed<Option<u64>> {
    nullish(node, "total_count").map(count).transpose()
}

/// `issueListSchema`.
fn issue_page(body: &Value) -> Page<RedmineIssue> {
    let node = object(body)?;
    let issues = array(required(node, "issues")?)?
        .iter()
        .map(|value| raw_issue(value).map(|raw| raw.issue))
        .collect::<Parsed<Vec<_>>>()?;
    Ok((issues, total_count(node)?))
}

/// `timeEntryListSchema`: `spent_on` must be a day key (a malformed one fails the whole read).
fn time_entry_page(body: &Value) -> Page<TimeEntry> {
    let node = object(body)?;
    let entries = array(required(node, "time_entries")?)?
        .iter()
        .map(|value| {
            let entry = object(value)?;
            let date = string(required(entry, "spent_on")?)?;
            if !is_day_key(date) {
                return invalid();
            }
            Ok(TimeEntry {
                date: date.to_owned(),
                hours: non_negative(required(entry, "hours")?)?,
            })
        })
        .collect::<Parsed<Vec<_>>>()?;
    Ok((entries, total_count(node)?))
}

/// `userSchema` mapped to the display name: `"${firstname ?? ''} ${lastname ?? ''}"` trimmed, or
/// the login when empty, clipped.
fn viewer_of(body: &Value) -> Parsed<Viewer> {
    let user = object(required(object(body)?, "user")?)?;
    let id = u64::try_from(int(required(user, "id")?)?).map_err(|_| ApiError::InvalidResponse)?;
    if id < 1 {
        return invalid();
    }
    let login = string(required(user, "login")?)?;
    let first = nullish_string(user, "firstname")?.unwrap_or("");
    let last = nullish_string(user, "lastname")?.unwrap_or("");
    let full = format!("{first} {last}");
    let full = js_trim(&full);
    let name = if full.is_empty() { login } else { full };
    Ok(Viewer {
        id,
        name: clip(name, TEXT_CLIP),
    })
}

/// `activityListSchema` mapped: `is_default ?? false`.
fn activities_of(body: &Value) -> Parsed<Vec<RedmineActivity>> {
    array(required(object(body)?, "time_entry_activities")?)?
        .iter()
        .map(|value| {
            let base = named(value)?;
            let is_default = nullish(object(value)?, "is_default")
                .map(boolean)
                .transpose()?
                .unwrap_or(false);
            Ok(RedmineActivity {
                id: base.id,
                name: clip(&base.name, TEXT_CLIP),
                is_default,
            })
        })
        .collect()
}

/// `statusListSchema` mapped (names clipped).
fn statuses_of(body: &Value) -> Parsed<Vec<Named>> {
    Ok(named_list(required(object(body)?, "issue_statuses")?)?
        .into_iter()
        .map(|status| Named {
            id: status.id,
            name: clip(&status.name, TEXT_CLIP),
        })
        .collect())
}

/// `writeReason`: 401 auth, 403 forbidden (even a rate limit), 404 not-found, 422 validation,
/// 429 or 5xx server, anything else invalid-response.
fn write_reason(status: u16) -> RedmineWriteError {
    match status {
        401 => RedmineWriteError::Auth,
        403 => RedmineWriteError::Forbidden,
        404 => RedmineWriteError::NotFound,
        422 => RedmineWriteError::Validation,
        429 | 500.. => RedmineWriteError::Server,
        _ => RedmineWriteError::InvalidResponse,
    }
}

/// `validationMessages`: the body of a 422, `{ errors: string[] }`, as at most 3 messages clipped
/// to 200; `None` when unreadable or empty.
fn validation_messages(response: &HttpResponse) -> Option<Vec<String>> {
    let body: Value = read_json(response).ok()?;
    let errors = array(required(object(&body).ok()?, "errors").ok()?).ok()?;
    let errors: Vec<&str> = errors.iter().map(string).collect::<Parsed<_>>().ok()?;
    let messages: Vec<String> = errors
        .into_iter()
        .take(VALIDATION_MESSAGES_MAX)
        .map(|message| clip(message, VALIDATION_MESSAGE_MAX))
        .collect();
    (!messages.is_empty()).then_some(messages)
}

const fn refused(reason: RedmineWriteError) -> RedmineWriteResult {
    RedmineWriteResult::Refused {
        reason,
        messages: None,
    }
}

impl RedmineClient {
    /// `base_url` must be a normalized https URL (origin plus an optional base path, no trailing
    /// `/`), as `normalize_redmine_url` gives.
    pub fn new(
        transport: Arc<dyn Transport>,
        base_url: impl Into<String>,
        key: impl Into<String>,
    ) -> Result<Self, InvalidRedmineUrl> {
        Self::build(transport, base_url.into(), key.into(), false)
    }

    /// Dev/E2E only: also accepts `http://127.0.0.1:<port>` (a fake local server).
    pub fn new_allowing_loopback_http(
        transport: Arc<dyn Transport>,
        base_url: impl Into<String>,
        key: impl Into<String>,
    ) -> Result<Self, InvalidRedmineUrl> {
        Self::build(transport, base_url.into(), key.into(), true)
    }

    fn build(
        transport: Arc<dyn Transport>,
        base_url: String,
        key: String,
        allow_loopback_http: bool,
    ) -> Result<Self, InvalidRedmineUrl> {
        let normalized = normalize_redmine_url(&base_url).as_deref() == Some(base_url.as_str());
        if !normalized && !(allow_loopback_http && is_loopback_http(&base_url)) {
            return Err(InvalidRedmineUrl);
        }
        Ok(Self {
            transport,
            base_url,
            key,
            statuses: OnceCell::new(),
            activities: OnceCell::new(),
        })
    }

    /// `issueUrl(id)`: the issue in Redmine (opened by the app, never sent to the renderer).
    pub fn issue_url(&self, id: u64) -> String {
        format!("{}/issues/{id}", self.base_url)
    }

    /// `new URL(`${baseUrl}/${path}`)` plus `searchParams.set` for each parameter, in order
    /// (form-encoded values). The base path is kept.
    fn url(&self, path: &str, query: &[(&str, &str)]) -> Option<String> {
        // The base URL was validated, so this parses.
        let mut url = Url::parse(&format!("{}/{path}", self.base_url)).ok()?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        Some(url.into())
    }

    /// The headers of every request: the key and `accept` (writes add `content-type`).
    fn with_headers(&self, request: HttpRequest) -> HttpRequest {
        request
            .header("x-redmine-api-key", self.key.clone())
            .header("accept", "application/json")
    }

    /// `get`: `send` (no 404 allowance) then the JSON body.
    async fn get(&self, path: &str, query: &[(&str, &str)]) -> Parsed<Value> {
        // Unreachable with a validated base URL; never a request sent.
        let url = self.url(path, query).ok_or(ApiError::Network)?;
        let response = send(
            self.transport.as_ref(),
            self.with_headers(HttpRequest::get(url)),
            false,
        )
        .await?
        .ok_or(ApiError::InvalidResponse)?; // unreachable without allow_not_found
        read_json(&response)
    }

    /// `paged`: reads `path` page by page (`limit`/`offset`) until a short or empty page,
    /// `max_pages`, or the reported total is reached. `total_count` only shortens the loop; a
    /// wrong one can never extend it. Returns the items and `more` (computed on every item read,
    /// before any dedupe).
    async fn paged<T>(
        &self,
        path: &str,
        query: &[(&str, &str)],
        max_pages: usize,
        read: fn(&Value) -> Page<T>,
    ) -> Parsed<(Vec<T>, bool)> {
        let mut items = Vec::new();
        let mut total = None;
        let limit = REDMINE_PAGE_SIZE.to_string();
        for index in 0..max_pages {
            let offset = index * REDMINE_PAGE_SIZE;
            let offset_text = offset.to_string();
            let mut page_query = query.to_vec();
            page_query.push(("limit", &limit));
            page_query.push(("offset", &offset_text));
            let (page, page_total) = read(&self.get(path, &page_query).await?)?;
            total = page_total;
            let length = page.len();
            items.extend(page);
            let full = length >= REDMINE_PAGE_SIZE;
            if !full || total.is_some_and(|total| (offset + length) as u64 >= total) {
                return Ok((items, false));
            }
        }
        let more = total.is_none_or(|total| total > items.len() as u64);
        Ok((items, more))
    }

    /// One write: any status maps to a result; only transport failures come from [`ApiError`]
    /// (`network`; a redirect or an oversized body is `invalid-response`).
    async fn write(
        &self,
        make: fn(String, Vec<u8>) -> HttpRequest,
        path: &str,
        body: &Value,
    ) -> RedmineWriteResult {
        let Some(url) = self.url(path, &[]) else {
            return refused(RedmineWriteError::InvalidResponse);
        };
        let request = self
            .with_headers(make(url, stringify(body).into_bytes()))
            .header("content-type", "application/json");
        let response = match send_raw(self.transport.as_ref(), request).await {
            Ok(response) => response,
            Err(ApiError::Network) => return refused(RedmineWriteError::Network),
            Err(_) => return refused(RedmineWriteError::InvalidResponse),
        };
        if response.is_ok() {
            return RedmineWriteResult::Done;
        }
        let reason = write_reason(response.status);
        if reason != RedmineWriteError::Validation {
            return refused(reason);
        }
        RedmineWriteResult::Refused {
            reason,
            messages: validation_messages(&response),
        }
    }

    /// `GET users/current.json`.
    pub async fn viewer(&self) -> Result<Viewer, ApiError> {
        viewer_of(&self.get("users/current.json", &[]).await?)
    }

    /// Open issues assigned to the user (at most 300, most recently updated first, each id once:
    /// an issue updated while paging may show up again on a later page, the first sighting is
    /// kept).
    pub async fn issues(&self) -> Result<RedmineIssueList, ApiError> {
        let (items, more) = self
            .paged(
                "issues.json",
                &[
                    ("assigned_to_id", "me"),
                    ("status_id", "open"),
                    ("sort", "updated_on:desc"),
                ],
                REDMINE_ISSUE_MAX_PAGES,
                issue_page,
            )
            .await?;
        let mut seen = HashSet::new();
        let issues = items
            .into_iter()
            .filter(|issue| seen.insert(issue.id))
            .collect();
        Ok(RedmineIssueList {
            issues,
            truncated: more,
        })
    }

    /// `GET issues/{id}.json?include=allowed_statuses`; without `allowed_statuses` (absent or
    /// `null`, older Redmine) every status is offered. An empty list is kept.
    pub async fn issue(&self, id: u64) -> Result<RedmineIssueDetail, ApiError> {
        let body = self
            .get(
                &format!("issues/{id}.json"),
                &[("include", "allowed_statuses")],
            )
            .await?;
        let RawIssue {
            issue,
            allowed_statuses,
        } = raw_issue(required(object(&body)?, "issue")?)?;
        let allowed = match allowed_statuses {
            Some(allowed) => allowed,
            None => self.statuses().await?,
        };
        Ok(RedmineIssueDetail {
            id: issue.id,
            subject: issue.subject,
            project: issue.project,
            status: issue.status,
            estimated_hours: issue.estimated_hours,
            spent_hours: issue.spent_hours,
            updated_on: issue.updated_on,
            allowed_statuses: allowed
                .into_iter()
                .map(|status| Named {
                    id: status.id,
                    name: clip(&status.name, TEXT_CLIP),
                })
                .collect(),
        })
    }

    /// All issue statuses, cached for this client (a failure is not cached).
    ///
    /// Deviation: a caller arriving while a failing first read is in flight retries instead of
    /// sharing the rejection (harmless).
    pub async fn statuses(&self) -> Result<Vec<Named>, ApiError> {
        self.statuses
            .get_or_try_init(|| async { statuses_of(&self.get("issue_statuses.json", &[]).await?) })
            .await
            .cloned()
    }

    /// Time entry activities, cached for this client (a failure is not cached).
    pub async fn activities(&self) -> Result<Vec<RedmineActivity>, ApiError> {
        self.activities
            .get_or_try_init(|| async {
                activities_of(
                    &self
                        .get("enumerations/time_entry_activities.json", &[])
                        .await?,
                )
            })
            .await
            .cloned()
    }

    /// The user's time entries between two local dates (inclusive), one item per entry (at most
    /// 1000; the `more` flag is ignored).
    pub async fn time_entries(&self, from: &str, to: &str) -> Result<Vec<TimeEntry>, ApiError> {
        let (items, _) = self
            .paged(
                "time_entries.json",
                &[("user_id", "me"), ("from", from), ("to", to)],
                REDMINE_TIME_ENTRY_MAX_PAGES,
                time_entry_page,
            )
            .await?;
        Ok(items)
    }

    /// `PUT issues/{id}.json` with `{"issue": {status_id?, estimated_hours?}}` (that key order,
    /// only the given keys). Never fails.
    pub async fn update_issue(&self, id: u64, patch: IssuePatch) -> RedmineWriteResult {
        let mut issue = Map::new();
        if let Some(status_id) = patch.status_id {
            issue.insert("status_id".into(), Value::from(status_id));
        }
        if let Some(estimated_hours) = patch.estimated_hours {
            issue.insert("estimated_hours".into(), Value::from(estimated_hours));
        }
        let mut body = Map::new();
        body.insert("issue".into(), Value::Object(issue));
        self.write(
            HttpRequest::put,
            &format!("issues/{id}.json"),
            &Value::Object(body),
        )
        .await
    }

    /// `POST time_entries.json` with `{"time_entry": {issue_id, spent_on, hours, activity_id,
    /// comments}}` (that key order). Never fails.
    pub async fn log_time(&self, entry: &TimeEntryInput) -> RedmineWriteResult {
        let mut time_entry = Map::new();
        time_entry.insert("issue_id".into(), Value::from(entry.issue_id));
        time_entry.insert("spent_on".into(), Value::from(entry.spent_on.as_str()));
        time_entry.insert("hours".into(), Value::from(entry.hours));
        time_entry.insert("activity_id".into(), Value::from(entry.activity_id));
        time_entry.insert("comments".into(), Value::from(entry.comments.as_str()));
        let mut body = Map::new();
        body.insert("time_entry".into(), Value::Object(time_entry));
        self.write(HttpRequest::post, "time_entries.json", &Value::Object(body))
            .await
    }
}

/// The client as the integration sees it (`RedmineClient` in TS), so its tests inject a fake.
pub trait RedmineApiClient: Send + Sync {
    fn viewer(&self) -> BoxFuture<'_, Result<Viewer, ApiError>>;
    fn issues(&self) -> BoxFuture<'_, Result<RedmineIssueList, ApiError>>;
    fn issue(&self, id: u64) -> BoxFuture<'_, Result<RedmineIssueDetail, ApiError>>;
    fn statuses(&self) -> BoxFuture<'_, Result<Vec<Named>, ApiError>>;
    fn activities(&self) -> BoxFuture<'_, Result<Vec<RedmineActivity>, ApiError>>;
    fn time_entries<'a>(
        &'a self,
        from: &'a str,
        to: &'a str,
    ) -> BoxFuture<'a, Result<Vec<TimeEntry>, ApiError>>;
    fn update_issue(&self, id: u64, patch: IssuePatch) -> BoxFuture<'_, RedmineWriteResult>;
    fn log_time<'a>(&'a self, entry: &'a TimeEntryInput) -> BoxFuture<'a, RedmineWriteResult>;
    fn issue_url(&self, id: u64) -> String;
}

impl RedmineApiClient for RedmineClient {
    fn viewer(&self) -> BoxFuture<'_, Result<Viewer, ApiError>> {
        Box::pin(Self::viewer(self))
    }

    fn issues(&self) -> BoxFuture<'_, Result<RedmineIssueList, ApiError>> {
        Box::pin(Self::issues(self))
    }

    fn issue(&self, id: u64) -> BoxFuture<'_, Result<RedmineIssueDetail, ApiError>> {
        Box::pin(Self::issue(self, id))
    }

    fn statuses(&self) -> BoxFuture<'_, Result<Vec<Named>, ApiError>> {
        Box::pin(Self::statuses(self))
    }

    fn activities(&self) -> BoxFuture<'_, Result<Vec<RedmineActivity>, ApiError>> {
        Box::pin(Self::activities(self))
    }

    fn time_entries<'a>(
        &'a self,
        from: &'a str,
        to: &'a str,
    ) -> BoxFuture<'a, Result<Vec<TimeEntry>, ApiError>> {
        Box::pin(Self::time_entries(self, from, to))
    }

    fn update_issue(&self, id: u64, patch: IssuePatch) -> BoxFuture<'_, RedmineWriteResult> {
        Box::pin(Self::update_issue(self, id, patch))
    }

    fn log_time<'a>(&'a self, entry: &'a TimeEntryInput) -> BoxFuture<'a, RedmineWriteResult> {
        Box::pin(Self::log_time(self, entry))
    }

    fn issue_url(&self, id: u64) -> String {
        Self::issue_url(self, id)
    }
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
