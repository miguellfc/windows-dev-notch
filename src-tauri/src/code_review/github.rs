//! GitHub GraphQL client (`src/main/code-review/github-client.ts`): one query per refresh, every
//! response validated as the zod schemas do.
//!
//! Responses are parsed to a [`serde_json::Value`] first and then checked by hand, field by
//! field, with zod's rules (see [`super::zod`]).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::{DateTime, FixedOffset, Local, SecondsFormat, TimeZone, Utc};
use serde_json::{json, Map, Value};

use super::client::{
    clip, clip_text, read_json, send_ok, snapshot, ClientItem, CodeReviewClient, CodeReviewError,
    CodeReviewSnapshot,
};
use super::contributions::{summarize, ContributionRange, SummaryInput};
use super::http::{HttpRequest, HttpResponse, Transport};
use super::zod::{
    array, boolean, count, int, invalid, nullish, object, optional, required, string, Obj, Parsed,
};
use crate::claude::js_json;
use crate::contract::code_review::{
    Checks, ContributionSummary, ContributionTotals, ReviewItem, ReviewState, COUNT_CAP, ID_MAX,
    LIST_LIMIT, UPDATED_AT_MAX,
};
use crate::contract::length;
use crate::ipc::BoxFuture;

/// Production GitHub API origin (GraphQL lives at `/graphql`).
pub const GITHUB_API_BASE: &str = "https://api.github.com";

pub const GITHUB_TO_REVIEW_QUERY: &str = "is:open is:pr review-requested:@me archived:false";
pub const GITHUB_MINE_QUERY: &str = "is:open is:pr author:@me archived:false";
/// Only its `issueCount` is read: the unreviewed count when `mine` is cut at the list limit.
pub const GITHUB_UNREVIEWED_QUERY: &str =
    "is:open is:pr author:@me archived:false draft:false review:none";

/// `GITHUB_QUERY`, byte for byte (`REVIEWS_READ` = 20 and the submitted review states inlined).
pub const GITHUB_QUERY: &str = "query CodeReview($toReview: String!, $mine: String!, $unreviewed: String!, $first: Int!) {
  viewer { login }
  toReview: search(type: ISSUE, first: $first, query: $toReview) { nodes { ...pr } }
  mine: search(type: ISSUE, first: $first, query: $mine) { issueCount nodes { ...pr } }
  unreviewed: search(type: ISSUE, first: 0, query: $unreviewed) { issueCount }
}
fragment pr on PullRequest {
  id
  number
  title
  url
  isDraft
  updatedAt
  reviewDecision
  mergeable
  repository { nameWithOwner }
  author { login }
  reviews(last: 20, states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED]) { totalCount nodes { state author { login } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}";

/// `GITHUB_CONTRIBUTIONS_QUERY`, byte for byte: month (with its calendar), week and today in one
/// query. `from`/`to` are the local midnights as instants.
pub const GITHUB_CONTRIBUTIONS_QUERY: &str = "query Contributions($monthFrom: DateTime!, $weekFrom: DateTime!, $todayFrom: DateTime!, $to: DateTime!, $mergedMonth: String!, $mergedWeek: String!, $mergedToday: String!) {
  viewer {
    month: contributionsCollection(from: $monthFrom, to: $to) { contributionCalendar { weeks { contributionDays { date contributionCount } } } totalCommitContributions totalPullRequestContributions totalPullRequestReviewContributions restrictedContributionsCount }
    week: contributionsCollection(from: $weekFrom, to: $to) { totalCommitContributions totalPullRequestContributions totalPullRequestReviewContributions restrictedContributionsCount }
    today: contributionsCollection(from: $todayFrom, to: $to) { totalCommitContributions totalPullRequestContributions totalPullRequestReviewContributions restrictedContributionsCount }
  }
  mergedMonth: search(type: ISSUE, first: 0, query: $mergedMonth) { issueCount }
  mergedWeek: search(type: ISSUE, first: 0, query: $mergedWeek) { issueCount }
  mergedToday: search(type: ISSUE, first: 0, query: $mergedToday) { issueCount }
}";

const VIEWER_QUERY: &str = "query Viewer { viewer { login } }";

/// `githubMergedQuery(localIsoWithOffset(start))`: own PRs merged on or after a local instant,
/// written as local wall time plus its UTC offset (`2026-11-13T00:00:00+01:00`) because a bare
/// date is read in UTC. Only `issueCount` is read.
pub fn github_merged_query(since: &DateTime<FixedOffset>) -> String {
    format!(
        "is:pr author:@me is:merged merged:>={}",
        since.format("%Y-%m-%dT%H:%M:%S%:z")
    )
}

/// `Date.prototype.toISOString`: UTC with milliseconds.
fn iso(instant: DateTime<Utc>) -> String {
    instant.to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// What `contributions(now)` hands to `summarize`: the calendar's counts by GitHub-side
/// `YYYY-MM-DD` (duplicate dates summed) and the totals of each range.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GithubContributions {
    pub counts: HashMap<String, u64>,
    pub today: ContributionTotals,
    pub week: ContributionTotals,
    pub month_totals: ContributionTotals,
    /// Some range has private contributions the token cannot see.
    pub restricted: bool,
}

/// `createGithubClient`: every call is `POST {api_base}/graphql` with the bearer token.
pub struct GithubClient {
    transport: Arc<dyn Transport>,
    api_base: String,
    token: String,
}

impl std::fmt::Debug for GithubClient {
    /// Never prints the token.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GithubClient").finish_non_exhaustive()
    }
}

/// `{ login: z.string() }`.
fn login(value: &Value) -> Parsed<&str> {
    string(required(object(value)?, "login")?)
}

/// `graphqlErrorsSchema`, and whether any error is a rate limit.
fn rate_limited(root: &Obj) -> Parsed<bool> {
    let Some(errors) = optional(root, "errors") else {
        return Ok(false);
    };
    let mut limited = false;
    for error in array(errors)? {
        if let Some(kind) = optional(object(error)?, "type") {
            limited |= string(kind)? == "RATE_LIMITED";
        }
    }
    Ok(limited)
}

/// The response's `data` (`nullable().optional()`), with its `errors` validated first. Without
/// data a rate limit is `rate-limited`, anything else `invalid-response` (`noDataError`); a 200
/// with both `errors` and `data` still uses the data.
fn data_of(body: &Value) -> Parsed<&Obj> {
    let root = object(body)?;
    let limited = rate_limited(root)?;
    match nullish(root, "data") {
        Some(data) => object(data),
        None if limited => Err(CodeReviewError::RateLimited),
        None => invalid(),
    }
}

/// `searchSchema`: `issueCount` (optional) and `nodes` (plain objects or `null`).
struct Search<'a> {
    issue_count: Option<u64>,
    nodes: Vec<Option<&'a Obj>>,
}

fn search(value: &Value) -> Parsed<Search<'_>> {
    let search = object(value)?;
    let issue_count = optional(search, "issueCount").map(count).transpose()?;
    let nodes = array(required(search, "nodes")?)?
        .iter()
        .map(|node| match node {
            Value::Null => Ok(None),
            node => object(node).map(Some),
        })
        .collect::<Parsed<_>>()?;
    Ok(Search { issue_count, nodes })
}

/// A review of `prSchema.reviews.nodes`: its state and its author's login, if any.
struct Review<'a> {
    state: &'a str,
    author: Option<&'a str>,
}

/// `prSchema` (the fields read).
struct Pr<'a> {
    id: &'a str,
    number: i64,
    title: &'a str,
    url: &'a str,
    is_draft: bool,
    updated_at: &'a str,
    review_decision: Option<&'a str>,
    mergeable: Option<&'a str>,
    name_with_owner: &'a str,
    author: Option<&'a str>,
    reviews: Vec<Option<Review<'a>>>,
    /// `statusCheckRollup.state` of each commit node (`None` for a `null` node or rollup).
    rollups: Vec<Option<&'a str>>,
}

fn optional_string<'a>(object: &'a Obj, key: &str) -> Parsed<Option<&'a str>> {
    nullish(object, key).map(string).transpose()
}

fn optional_login<'a>(object: &'a Obj, key: &str) -> Parsed<Option<&'a str>> {
    nullish(object, key).map(login).transpose()
}

fn pr(node: &Obj) -> Parsed<Pr<'_>> {
    let id = string(required(node, "id")?)?;
    if !(1..=ID_MAX).contains(&length(id)) {
        return invalid();
    }
    let repository = object(required(node, "repository")?)?;
    let mut reviews = Vec::new();
    if let Some(connection) = nullish(node, "reviews") {
        if let Some(nodes) = optional(object(connection)?, "nodes") {
            for review in array(nodes)? {
                if review.is_null() {
                    reviews.push(None);
                    continue;
                }
                let review = object(review)?;
                reviews.push(Some(Review {
                    state: string(required(review, "state")?)?,
                    author: optional_login(review, "author")?,
                }));
            }
        }
    }
    let mut rollups = Vec::new();
    if let Some(commits) = optional(node, "commits") {
        for commit in array(required(object(commits)?, "nodes")?)? {
            if commit.is_null() {
                rollups.push(None);
                continue;
            }
            let commit = object(required(object(commit)?, "commit")?)?;
            let rollup = nullish(commit, "statusCheckRollup")
                .map(|rollup| string(required(object(rollup)?, "state")?))
                .transpose()?;
            rollups.push(rollup);
        }
    }
    Ok(Pr {
        id,
        number: int(required(node, "number")?)?,
        title: string(required(node, "title")?)?,
        url: string(required(node, "url")?)?,
        is_draft: boolean(required(node, "isDraft")?)?,
        updated_at: string(required(node, "updatedAt")?)?,
        review_decision: optional_string(node, "reviewDecision")?,
        mergeable: optional_string(node, "mergeable")?,
        name_with_owner: string(required(repository, "nameWithOwner")?)?,
        author: optional_login(node, "author")?,
        reviews,
        rollups,
    })
}

/// `reviewOf`: only reviews by someone other than the PR's author count (a self-review never
/// marks a PR reviewed nor alerts; a review without author counts). None → `none`; then the
/// review decision; then the latest such review.
fn review_of(pr: &Pr<'_>) -> ReviewState {
    let others: Vec<&Review<'_>> = pr
        .reviews
        .iter()
        .flatten()
        .filter(|review| pr.author.is_none() || review.author != pr.author)
        .collect();
    let Some(latest) = others.last() else {
        return ReviewState::None;
    };
    match (pr.review_decision, latest.state) {
        (Some("APPROVED"), _) => ReviewState::Approved,
        (Some("CHANGES_REQUESTED"), _) => ReviewState::Changes,
        (_, "APPROVED") => ReviewState::Approved,
        (_, "CHANGES_REQUESTED") => ReviewState::Changes,
        _ => ReviewState::Commented,
    }
}

/// `checksOf`: the last commit's status rollup.
fn checks_of(pr: &Pr<'_>) -> Option<Checks> {
    match pr.rollups.last().copied().flatten()? {
        "SUCCESS" => Some(Checks::Pass),
        "FAILURE" | "ERROR" => Some(Checks::Fail),
        "PENDING" | "EXPECTED" => Some(Checks::Running),
        _ => None,
    }
}

fn to_item(pr: &Pr<'_>) -> ClientItem {
    ClientItem {
        item: ReviewItem {
            id: pr.id.to_owned(),
            reference: clip_text(&format!("{}#{}", pr.name_with_owner, pr.number)),
            title: clip_text(pr.title),
            author: clip_text(pr.author.unwrap_or("")),
            updated_at: clip(pr.updated_at, UPDATED_AT_MAX),
            draft: pr.is_draft,
            review: review_of(pr),
            checks: checks_of(pr),
            conflicts: pr.mergeable == Some("CONFLICTING"),
        },
        url: pr.url.to_owned(),
    }
}

/// `itemsOf`: keeps PR nodes (skips `null` and non-PR `{}` results, i.e. nodes without an `id`
/// key); a malformed PR is `invalid-response`. Stops at the list limit, so nodes past it are not
/// validated.
fn items_of(nodes: &[Option<&Obj>]) -> Parsed<Vec<ClientItem>> {
    let mut items = Vec::new();
    for node in nodes.iter().flatten() {
        if !node.contains_key("id") {
            continue;
        }
        items.push(to_item(&pr(node)?));
        if items.len() == LIST_LIMIT {
            break;
        }
    }
    Ok(items)
}

/// `collectionSchema` mapped by `totalsOf`; `merged` is `mergedSchema` (a failed merged search,
/// `null` in a 200 with `errors`, counts 0). Returns the totals and `restrictedContributionsCount`.
fn totals_of(collection: &Obj, merged: Option<&Value>) -> Parsed<(ContributionTotals, u64)> {
    let field = |key: &str| count(required(collection, key)?);
    let totals = ContributionTotals {
        commits: field("totalCommitContributions")?,
        opened: field("totalPullRequestContributions")?,
        merged: merged
            .map(|search| count(required(object(search)?, "issueCount")?))
            .transpose()?
            .unwrap_or(0),
        reviews: field("totalPullRequestReviewContributions")?,
    };
    Ok((totals, field("restrictedContributionsCount")?))
}

/// The month's `contributionCalendar` as counts by date (duplicate dates summed).
fn calendar_counts(month: &Obj) -> Parsed<HashMap<String, u64>> {
    let calendar = object(required(month, "contributionCalendar")?)?;
    let mut counts = HashMap::new();
    for week in array(required(calendar, "weeks")?)? {
        for day in array(required(object(week)?, "contributionDays")?)? {
            let day = object(day)?;
            let date = string(required(day, "date")?)?;
            let n = count(required(day, "contributionCount")?)?;
            let total: &mut u64 = counts.entry(date.to_owned()).or_default();
            *total = total.saturating_add(n);
        }
    }
    Ok(counts)
}

impl GithubClient {
    /// `api_base` is the API origin (`GITHUB_API_BASE`; a fake server in E2E).
    pub fn new(
        transport: Arc<dyn Transport>,
        api_base: impl Into<String>,
        token: impl Into<String>,
    ) -> Self {
        Self {
            transport,
            api_base: api_base.into(),
            token: token.into(),
        }
    }

    /// `post`: `JSON.stringify({query})` or `{query, variables}`, keys in that order.
    async fn post(&self, query: &str, variables: Option<Value>) -> Parsed<HttpResponse> {
        let mut body = Map::new();
        body.insert("query".to_owned(), Value::from(query));
        if let Some(variables) = variables {
            body.insert("variables".to_owned(), variables);
        }
        let request = HttpRequest::post(
            format!("{}/graphql", self.api_base),
            js_json::stringify_object(&body).into_bytes(),
        )
        .header("authorization", format!("Bearer {}", self.token))
        .header("accept", "application/json")
        .header("content-type", "application/json");
        send_ok(self.transport.as_ref(), request).await
    }

    /// The token's account login.
    pub async fn viewer(&self) -> Result<String, CodeReviewError> {
        let body: Value = read_json(&self.post(VIEWER_QUERY, None).await?)?;
        let data = data_of(&body)?;
        Ok(login(required(data, "viewer")?)?.to_owned())
    }

    /// `fetch()`: both lists and the unreviewed count in one query.
    pub async fn list(&self) -> Result<CodeReviewSnapshot, CodeReviewError> {
        let variables = json!({
            "toReview": GITHUB_TO_REVIEW_QUERY,
            "mine": GITHUB_MINE_QUERY,
            "unreviewed": GITHUB_UNREVIEWED_QUERY,
            "first": LIST_LIMIT,
        });
        let body: Value = read_json(&self.post(GITHUB_QUERY, Some(variables)).await?)?;
        let data = data_of(&body)?;
        login(required(data, "viewer")?)?;
        let to_review = search(required(data, "toReview")?)?;
        let mine = search(required(data, "mine")?)?;
        let unreviewed = nullish(data, "unreviewed")
            .map(|search| count(required(object(search)?, "issueCount")?))
            .transpose()?;
        let mut result = snapshot(
            items_of(&to_review.nodes)?,
            items_of(&mine.nodes)?,
            &HashSet::new(),
        );
        // The list rule (no review by anyone but the author) is exact while the list holds every
        // own PR. Beyond the limit, `review:none` counts the rest; it also treats self-reviews as
        // reviews, so it can only undercount: never report fewer than the list itself shows.
        let listed = u64::try_from(result.mine.len()).unwrap_or(u64::MAX);
        let list_complete = mine.issue_count.unwrap_or(0) <= listed;
        let mut unreviewed_count = u64::from(result.unreviewed);
        if let (false, Some(searched)) = (list_complete, unreviewed) {
            unreviewed_count = unreviewed_count.max(searched);
        }
        result.unreviewed =
            u32::try_from(unreviewed_count.min(u64::from(COUNT_CAP))).unwrap_or(COUNT_CAP);
        Ok(result)
    }

    /// The calendar and totals of the current month, week and day (`contributions(now)` up to
    /// `summarize`; [`Self::contribution_summary`] applies it).
    pub async fn contributions<Tz: TimeZone>(
        &self,
        range: &ContributionRange<Tz>,
    ) -> Result<GithubContributions, CodeReviewError> {
        let (month, week, today) = (range.month(), range.week(), range.today());
        let today_utc = today.with_timezone(&Utc);
        // Never an empty "today" range (now exactly at local midnight).
        let to = range
            .now()
            .max(today_utc + chrono::Duration::milliseconds(1000));
        let variables = json!({
            "monthFrom": iso(month.with_timezone(&Utc)),
            "weekFrom": iso(week.with_timezone(&Utc)),
            "todayFrom": iso(today_utc),
            "to": iso(to),
            "mergedMonth": github_merged_query(&month),
            "mergedWeek": github_merged_query(&week),
            "mergedToday": github_merged_query(&today),
        });
        let body: Value = read_json(
            &self
                .post(GITHUB_CONTRIBUTIONS_QUERY, Some(variables))
                .await?,
        )?;
        // As in `list`: a 200 with `errors` and `data` still uses the data.
        let data = data_of(&body)?;
        let viewer = object(required(data, "viewer")?)?;
        let month = object(required(viewer, "month")?)?;
        let week = object(required(viewer, "week")?)?;
        let today = object(required(viewer, "today")?)?;
        let counts = calendar_counts(month)?;
        let (month_totals, month_restricted) = totals_of(month, nullish(data, "mergedMonth"))?;
        let (week_totals, week_restricted) = totals_of(week, nullish(data, "mergedWeek"))?;
        let (today_totals, today_restricted) = totals_of(today, nullish(data, "mergedToday"))?;
        Ok(GithubContributions {
            counts,
            today: today_totals,
            week: week_totals,
            month_totals,
            restricted: [month_restricted, week_restricted, today_restricted]
                .iter()
                .any(|&n| n > 0),
        })
    }

    /// `contributions(now)`: the range of `now` in its own time zone, the query, then
    /// `summarize` (`partial` is always false on GitHub).
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
            partial: false,
            restricted: raw.restricted,
        }))
    }
}

impl CodeReviewClient for GithubClient {
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
#[path = "github_tests.rs"]
mod tests;
