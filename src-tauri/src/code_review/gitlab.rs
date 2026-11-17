//! Self-hosted GitLab REST client (0.1.0's `gitlab-client.ts`): `/api/v4` with the
//! `private-token` header, 3 + 2N requests per refresh (N = own non-draft MRs), every response
//! validated as the zod schemas do.
//!
//! As in the GitHub client, bodies are parsed to a [`serde_json::Value`] and checked by hand with
//! zod's rules (see [`super::zod`]).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::{DateTime, Days, Local, TimeZone, Utc};
use serde_json::Value;
use url::Url;

use super::client::{
    clip, clip_text, map_pool, read_json, send_ok, send_raw, snapshot, status_error, ClientItem,
    CodeReviewClient, CodeReviewError, CodeReviewSnapshot,
};
use super::contributions::{
    classify_gitlab_event, date_key, summarize, ContributionRange, GitlabEventClass,
    GitlabEventLike, SummaryInput,
};
use super::http::{HttpRequest, HttpResponse, Transport};
use super::zod::{
    array, boolean, count, int, invalid, nullish, object, optional, required, string, Obj, Parsed,
};
use crate::contract::code_review::{
    Checks, ContributionSummary, ContributionTotals, ReviewItem, ReviewState, LIST_LIMIT,
    UPDATED_AT_MAX,
};
use crate::ipc::BoxFuture;
use crate::settings::validate::normalize_gitlab_url;

/// Events per page and the most pages read per query (beyond it the data is `partial`).
pub const GITLAB_EVENTS_PER_PAGE: usize = 100;
pub const GITLAB_EVENTS_MAX_PAGES: u32 = 10;
/// At most this many per-MR requests (`/approvals`, `/reviewers`) are in flight at once: half
/// for each endpoint, both pools running together.
pub const GITLAB_PER_MR_CONCURRENCY: usize = 6;

/// `createGitlabClient` throws: the base URL is not a normalized https URL (nor an allowed
/// loopback http one).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidGitlabUrl;

impl std::fmt::Display for InvalidGitlabUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("GitLab base URL must be a normalized https URL")
    }
}

impl std::error::Error for InvalidGitlabUrl {}

/// What `contributions(now)` hands to `summarize`: chart squares by local `YYYY-MM-DD` (days of
/// the current month only) and the totals of each range.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GitlabContributions {
    pub counts: HashMap<String, u64>,
    pub today: ContributionTotals,
    pub week: ContributionTotals,
    pub month_totals: ContributionTotals,
    /// More events than `GITLAB_EVENTS_MAX_PAGES` pages hold: the counts are a lower bound.
    pub partial: bool,
}

/// `createGitlabClient`: every call is `GET {base_url}/api/v4/...` with the private token.
pub struct GitlabClient {
    transport: Arc<dyn Transport>,
    base_url: String,
    token: String,
}

impl std::fmt::Debug for GitlabClient {
    /// Never prints the token (nor the server URL).
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitlabClient").finish_non_exhaustive()
    }
}

/// `^http:\/\/127\.0\.0\.1:\d{1,5}$`.
fn is_loopback_http(base_url: &str) -> bool {
    base_url
        .strip_prefix("http://127.0.0.1:")
        .is_some_and(|port| {
            (1..=5).contains(&port.len()) && port.bytes().all(|b| b.is_ascii_digit())
        })
}

/// `userSchema`: `{ id: int > 0, username }`.
struct GitlabUser {
    id: i64,
    username: String,
}

/// `z.int().positive()`.
fn positive(value: &Value) -> Parsed<i64> {
    match int(value)? {
        n if n > 0 => Ok(n),
        _ => invalid(),
    }
}

fn user_of(body: &Value) -> Parsed<GitlabUser> {
    let user = object(body)?;
    Ok(GitlabUser {
        id: positive(required(user, "id")?)?,
        username: string(required(user, "username")?)?.to_owned(),
    })
}

/// `mrSchema` (the fields read).
struct Mr<'a> {
    iid: i64,
    project_id: i64,
    title: &'a str,
    web_url: &'a str,
    updated_at: &'a str,
    reference: Option<&'a str>,
    author: Option<&'a str>,
    draft: bool,
    conflicts: bool,
    pipeline: Option<&'a str>,
}

impl Mr<'_> {
    fn id(&self) -> String {
        format!("{}!{}", self.project_id, self.iid)
    }

    /// `{project_id}/merge_requests/{iid}` under `projects/`.
    fn path(&self) -> String {
        format!("projects/{}/merge_requests/{}", self.project_id, self.iid)
    }
}

fn nullish_string<'a>(object: &'a Obj, key: &str) -> Parsed<Option<&'a str>> {
    nullish(object, key).map(string).transpose()
}

fn nullish_bool(object: &Obj, key: &str) -> Parsed<Option<bool>> {
    nullish(object, key).map(boolean).transpose()
}

/// `z.object({ <key>: z.string() }).nullable().optional()`.
fn nullish_field<'a>(node: &'a Obj, key: &str, field: &str) -> Parsed<Option<&'a str>> {
    nullish(node, key)
        .map(|value| string(required(object(value)?, field)?))
        .transpose()
}

fn mr(value: &Value) -> Parsed<Mr<'_>> {
    let node = object(value)?;
    let draft = nullish_bool(node, "draft")? == Some(true)
        || nullish_bool(node, "work_in_progress")? == Some(true);
    let conflicts = nullish_bool(node, "has_conflicts")? == Some(true)
        || nullish_string(node, "detailed_merge_status")? == Some("conflict");
    Ok(Mr {
        iid: positive(required(node, "iid")?)?,
        project_id: positive(required(node, "project_id")?)?,
        title: string(required(node, "title")?)?,
        web_url: string(required(node, "web_url")?)?,
        updated_at: string(required(node, "updated_at")?)?,
        reference: nullish_field(node, "references", "full")?,
        author: nullish_field(node, "author", "username")?,
        draft,
        conflicts,
        pipeline: nullish_field(node, "head_pipeline", "status")?,
    })
}

/// `mrListSchema`: every MR is validated (also those past the list limit), then the first 20 kept.
fn mr_list(body: &Value) -> Parsed<Vec<Mr<'_>>> {
    let mut mrs = array(body)?.iter().map(mr).collect::<Parsed<Vec<_>>>()?;
    mrs.truncate(LIST_LIMIT);
    Ok(mrs)
}

const RUNNING: [&str; 7] = [
    "created",
    "waiting_for_resource",
    "preparing",
    "pending",
    "running",
    "scheduled",
    "waiting_for_callback",
];

/// `checksOf`: the head pipeline's status.
fn checks_of(mr: &Mr<'_>) -> Option<Checks> {
    match mr.pipeline? {
        "success" => Some(Checks::Pass),
        "failed" => Some(Checks::Fail),
        status if RUNNING.contains(&status) => Some(Checks::Running),
        _ => None,
    }
}

/// What others did on an own MR: approvals (by anyone but the user) and reviewer states.
#[derive(Default)]
struct OwnReview<'a> {
    approved: bool,
    states: Vec<Option<&'a str>>,
}

/// `reviewOf`: approvals win; then any `requested_changes` → changes, any `reviewed` → commented.
fn review_of(review: &OwnReview<'_>) -> ReviewState {
    let has = |state: &str| review.states.contains(&Some(state));
    if review.approved || has("approved") {
        ReviewState::Approved
    } else if has("requested_changes") {
        ReviewState::Changes
    } else if has("reviewed") {
        ReviewState::Commented
    } else {
        ReviewState::None
    }
}

fn to_item(mr: &Mr<'_>, review: &OwnReview<'_>) -> ClientItem {
    let reference = match mr.reference {
        Some(full) => clip_text(full),
        None => clip_text(&format!("!{}", mr.iid)),
    };
    ClientItem {
        item: ReviewItem {
            id: mr.id(),
            reference,
            title: clip_text(mr.title),
            author: clip_text(mr.author.unwrap_or("")),
            updated_at: clip(mr.updated_at, UPDATED_AT_MAX),
            draft: mr.draft,
            review: review_of(review),
            checks: checks_of(mr),
            conflicts: mr.conflicts,
        },
        url: mr.web_url.to_owned(),
    }
}

/// `userRefSchema` (`{ id?: int }`, loose, nullable, optional): the user's id, if any.
fn user_ref(entry: &Obj) -> Parsed<Option<i64>> {
    let Some(user) = nullish(entry, "user") else {
        return Ok(None);
    };
    optional(object(user)?, "id").map(int).transpose()
}

/// An entry of `approved_by` or `/reviewers`: its user's id (if any) and, for reviewers, the state.
struct Entry {
    user_id: Option<i64>,
    state: Option<String>,
}

/// `approvalsSchema`: `{ approved_by?: [{ user }] | null }`.
fn approvals_of(body: &Value) -> Parsed<Vec<Entry>> {
    let Some(approved_by) = nullish(object(body)?, "approved_by") else {
        return Ok(Vec::new());
    };
    array(approved_by)?
        .iter()
        .map(|entry| {
            Ok(Entry {
                user_id: user_ref(object(entry)?)?,
                state: None,
            })
        })
        .collect()
}

/// `reviewersSchema`: `[{ user, state?: string | null }]` (GitLab 15.9+).
fn reviewers_of(body: &Value) -> Parsed<Vec<Entry>> {
    array(body)?
        .iter()
        .map(|entry| {
            let entry = object(entry)?;
            Ok(Entry {
                user_id: user_ref(entry)?,
                state: nullish_string(entry, "state")?.map(str::to_owned),
            })
        })
        .collect()
}

/// Outcome of a per-MR request: `Missing` for a lasting "no data" (404, or a 403 from an edition
/// or permission quirk), `Failed` for a passing failure (5xx, 429, network, redirect, bad body).
enum PerMr {
    Ok(Vec<Entry>),
    Missing,
    Failed,
}

/// An event: when it happened and what the classification reads.
struct Event<'a> {
    created_at: &'a str,
    like: GitlabEventLike<'a>,
}

/// `eventSchema` (titles are never read).
fn event(value: &Value) -> Parsed<Event<'_>> {
    let node = object(value)?;
    let commit_count = match nullish(node, "push_data") {
        Some(push) => nullish(object(push)?, "commit_count")
            .map(count)
            .transpose()?,
        None => None,
    };
    let noteable_type = match nullish(node, "note") {
        Some(note) => nullish_string(object(note)?, "noteable_type")?,
        None => None,
    };
    Ok(Event {
        created_at: string(required(node, "created_at")?)?,
        like: GitlabEventLike {
            action_name: string(required(node, "action_name")?)?,
            target_type: nullish_string(node, "target_type")?,
            commit_count,
            noteable_type,
        },
    })
}

fn add(totals: &mut ContributionTotals, kind: GitlabEventClass) {
    totals.commits = totals.commits.saturating_add(kind.commits);
    totals.opened += u64::from(kind.opened);
    totals.merged += u64::from(kind.merged);
    totals.reviews += u64::from(kind.review);
}

/// `new Date(created_at)` for the ISO 8601 instants GitLab sends; anything else is skipped
/// (`NaN`).
fn instant(text: &str) -> Option<DateTime<chrono::FixedOffset>> {
    DateTime::parse_from_rfc3339(text).ok()
}

impl GitlabClient {
    /// `base_url` must be a normalized https URL (origin plus an optional base path, no trailing
    /// `/`), as `normalize_gitlab_url` gives.
    pub fn new(
        transport: Arc<dyn Transport>,
        base_url: impl Into<String>,
        token: impl Into<String>,
    ) -> Result<Self, InvalidGitlabUrl> {
        Self::build(transport, base_url.into(), token.into(), false)
    }

    /// Dev/E2E only: also accepts `http://127.0.0.1:<port>` (a fake local server).
    pub fn new_allowing_loopback_http(
        transport: Arc<dyn Transport>,
        base_url: impl Into<String>,
        token: impl Into<String>,
    ) -> Result<Self, InvalidGitlabUrl> {
        Self::build(transport, base_url.into(), token.into(), true)
    }

    fn build(
        transport: Arc<dyn Transport>,
        base_url: String,
        token: String,
        allow_loopback_http: bool,
    ) -> Result<Self, InvalidGitlabUrl> {
        let normalized = normalize_gitlab_url(&base_url).as_deref() == Some(base_url.as_str());
        if !normalized && !(allow_loopback_http && is_loopback_http(&base_url)) {
            return Err(InvalidGitlabUrl);
        }
        Ok(Self {
            transport,
            base_url,
            token,
        })
    }

    /// `new URL(`${baseUrl}/api/v4/${path}`)` plus `searchParams.set` for each parameter, in
    /// order (form-encoded values).
    fn url(&self, path: &str, query: &[(&str, &str)]) -> Parsed<String> {
        // The base URL was validated, so this parses; a failure would be a request never sent.
        let mut url = Url::parse(&format!("{}/api/v4/{path}", self.base_url))
            .map_err(|_| CodeReviewError::Network)?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        Ok(url.into())
    }

    fn request(&self, url: String) -> HttpRequest {
        HttpRequest::get(url)
            .header("private-token", self.token.clone())
            .header("accept", "application/json")
    }

    /// `get`: `sendOk` then the JSON body.
    async fn get(&self, path: &str, query: &[(&str, &str)]) -> Parsed<(HttpResponse, Value)> {
        let response = send_ok(
            self.transport.as_ref(),
            self.request(self.url(path, query)?),
        )
        .await?;
        let body = read_json(&response)?;
        Ok((response, body))
    }

    /// `getPerMr`: never fails the whole fetch, except on a 401 (the token is no longer valid).
    async fn get_per_mr(
        &self,
        path: String,
        parse: fn(&Value) -> Parsed<Vec<Entry>>,
    ) -> Parsed<PerMr> {
        let Ok(url) = self.url(&path, &[]) else {
            return Ok(PerMr::Failed);
        };
        let Ok(response) = send_raw(self.transport.as_ref(), self.request(url)).await else {
            return Ok(PerMr::Failed);
        };
        if response.status == 401 {
            return Err(CodeReviewError::Auth);
        }
        if response.status == 404
            || (response.status == 403 && status_error(&response) == CodeReviewError::Auth)
        {
            return Ok(PerMr::Missing);
        }
        if !response.is_ok() {
            return Ok(PerMr::Failed);
        }
        Ok(read_json::<Value>(&response)
            .and_then(|body| parse(&body))
            .map_or(PerMr::Failed, PerMr::Ok))
    }

    async fn user(&self) -> Parsed<GitlabUser> {
        user_of(&self.get("user", &[]).await?.1)
    }

    /// `list(query)`: `GET merge_requests?state=opened&<query>&per_page=20` (page 1 only).
    async fn list_body(&self, query: &[(&str, &str)]) -> Parsed<Value> {
        let per_page = LIST_LIMIT.to_string();
        let mut params = vec![("state", "opened")];
        params.extend_from_slice(query);
        params.push(("per_page", per_page.as_str()));
        Ok(self.get("merge_requests", &params).await?.1)
    }

    /// The token's account username.
    pub async fn viewer(&self) -> Result<String, CodeReviewError> {
        Ok(self.user().await?.username)
    }

    /// `fetch()`: the user, both lists, then the approvals and reviewers of each own non-draft MR.
    pub async fn list(&self) -> Result<CodeReviewSnapshot, CodeReviewError> {
        let me = self.user().await?;
        let me_id = me.id.to_string();
        let to_review_query = [("reviewer_id", me_id.as_str()), ("scope", "all")];
        let mine_query = [("scope", "created_by_me")];
        let (to_review_body, mine_body) = tokio::try_join!(
            self.list_body(&to_review_query),
            self.list_body(&mine_query),
        )?;
        let to_review = mr_list(&to_review_body)?;
        let mine = mr_list(&mine_body)?;
        // Drafts are never "unreviewed" nor alerted: no per-MR calls for them.
        let open: Vec<&Mr<'_>> = mine.iter().filter(|mr| !mr.draft).collect();
        let lane = GITLAB_PER_MR_CONCURRENCY / 2;
        let (approvals, reviewers) = tokio::try_join!(
            map_pool(&open, lane, |mr| self
                .get_per_mr(format!("{}/approvals", mr.path()), approvals_of)),
            map_pool(&open, lane, |mr| self
                .get_per_mr(format!("{}/reviewers", mr.path()), reviewers_of)),
        )?;
        // The user's own approval or review never counts. A passing failure degrades to what the
        // other call says and leaves the MR out of `own_review` this round, so it cannot fake a
        // first review.
        let others = |entries: &[Entry]| -> Vec<Option<String>> {
            entries
                .iter()
                .filter(|entry| entry.user_id != Some(me.id))
                .map(|entry| entry.state.clone())
                .collect()
        };
        let mut uncertain = HashSet::new();
        let mut reviews: HashMap<String, (bool, Vec<Option<String>>)> = HashMap::new();
        for ((mr, a), r) in open.iter().zip(&approvals).zip(&reviewers) {
            if matches!(a, PerMr::Failed) || matches!(r, PerMr::Failed) {
                uncertain.insert(mr.id());
            }
            let approved = matches!(a, PerMr::Ok(entries) if !others(entries).is_empty());
            let states = match r {
                PerMr::Ok(entries) => others(entries),
                _ => Vec::new(),
            };
            reviews.insert(mr.id(), (approved, states));
        }
        let mine_items = mine
            .iter()
            .map(|mr| {
                let review = reviews
                    .get(&mr.id())
                    .map(|(approved, states)| OwnReview {
                        approved: *approved,
                        states: states.iter().map(Option::as_deref).collect(),
                    })
                    .unwrap_or_default();
                to_item(mr, &review)
            })
            .collect();
        let to_review_items = to_review
            .iter()
            .map(|mr| to_item(mr, &OwnReview::default()))
            .collect();
        Ok(snapshot(to_review_items, mine_items, &uncertain))
    }

    /// The month's chart squares and the totals of the month, week and day (`contributions(now)`
    /// up to `summarize`; [`Self::contribution_summary`] applies it). Each event counts on its
    /// local date in the range's time zone.
    pub async fn contributions<Tz: TimeZone>(
        &self,
        range: &ContributionRange<Tz>,
    ) -> Result<GitlabContributions, CodeReviewError> {
        let me = self.user().await?;
        let zone = range.zone();
        let month_key = range.month().date_naive();
        let week_key = range.week().date_naive();
        let today_key = range.today().date_naive();
        // The week may start in the previous month: read from the earlier of both starts.
        let start = month_key.min(week_key);
        // `after`/`before` are exclusive dates applied in the SERVER's time zone (UTC on
        // gitlab.com). Two extra days on each side cover any local offset; events are then
        // filtered by their local date.
        let after = date_key(start.checked_sub_days(Days::new(2)).unwrap_or(start));
        let before = date_key(
            today_key
                .checked_add_days(Days::new(2))
                .unwrap_or(today_key),
        );
        let per_page = GITLAB_EVENTS_PER_PAGE.to_string();
        let path = format!("users/{}/events", me.id);

        let mut result = GitlabContributions::default();
        // Pages in series (newest first), until a short page, an empty X-Next-Page or the limit.
        for page in 1..=GITLAB_EVENTS_MAX_PAGES {
            let page_text = page.to_string();
            let query = [
                ("after", after.as_str()),
                ("before", before.as_str()),
                ("per_page", per_page.as_str()),
                ("page", page_text.as_str()),
            ];
            let (response, body) = self.get(&path, &query).await?;
            let next = response.header("x-next-page");
            let events = array(&body)?
                .iter()
                .map(event)
                .collect::<Parsed<Vec<_>>>()?;
            for event in &events {
                let Some(created) = instant(event.created_at) else {
                    continue;
                };
                let day = created.with_timezone(zone).date_naive();
                if day > today_key || (day < month_key && day < week_key) {
                    continue;
                }
                let kind = classify_gitlab_event(&event.like);
                if day >= month_key {
                    add(&mut result.month_totals, kind);
                    if kind.contribution {
                        *result.counts.entry(date_key(day)).or_default() += 1;
                    }
                }
                if day >= week_key {
                    add(&mut result.week, kind);
                }
                if day == today_key {
                    add(&mut result.today, kind);
                }
            }
            // A missing header is not an empty one (`null !== ''`): a full page asks for more.
            let more = events.len() >= GITLAB_EVENTS_PER_PAGE && next.as_deref() != Some("");
            if !more {
                break;
            }
            if page == GITLAB_EVENTS_MAX_PAGES {
                result.partial = true;
            }
        }
        Ok(result)
    }

    /// `contributions(now)`: the range of `now` in its own time zone, the events, then
    /// `summarize` (`restricted` is always false on GitLab).
    pub async fn contribution_summary<Tz: TimeZone>(
        &self,
        now: &DateTime<Tz>,
    ) -> Result<ContributionSummary, CodeReviewError> {
        let range = ContributionRange::at(now);
        let raw = self.contributions(&range).await?;
        Ok(summarize(&SummaryInput {
            now,
            counts: &raw.counts,
            today: raw.today,
            week: raw.week,
            month_totals: raw.month_totals,
            partial: raw.partial,
            restricted: false,
        }))
    }
}

impl CodeReviewClient for GitlabClient {
    fn viewer(&self) -> BoxFuture<'_, Result<String, CodeReviewError>> {
        Box::pin(Self::viewer(self))
    }

    fn fetch(&self) -> BoxFuture<'_, Result<CodeReviewSnapshot, CodeReviewError>> {
        Box::pin(self.list())
    }

    /// In the machine's local time zone (`chrono::Local`), as Electron's `Date` getters.
    fn contributions(
        &self,
        now: DateTime<Utc>,
    ) -> BoxFuture<'_, Result<ContributionSummary, CodeReviewError>> {
        Box::pin(async move { self.contribution_summary(&now.with_timezone(&Local)).await })
    }
}

#[cfg(test)]
#[path = "gitlab_tests.rs"]
mod tests;
