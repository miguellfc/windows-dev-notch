//! `code-review:*` channels and events (`src/shared/code-review/schema.ts`).
//!
//! Every object is a `z.strictObject` (`deny_unknown_fields`). Lengths are zod's (code points,
//! see [`length`]); the clients cut texts by UTF-16 units (`clip`), which never exceeds these.

use serde::{Deserialize, Serialize};

use super::claude::{BoolLiteral, False, True};
use super::{at_most, len_in, max_len, nullable, present, safe_int_min, Validate};

/// `CODE_REVIEW_LIST_LIMIT`: each list (`toReview`, `mine`) holds at most this many items.
pub const LIST_LIMIT: usize = 20;
/// `CODE_REVIEW_COUNT_CAP`: unreviewed counts are capped here (the UI shows "99+").
pub const COUNT_CAP: u32 = 100;
/// `CODE_REVIEW_TEXT_MAX`: titles, refs, authors and accounts.
pub const TEXT_MAX: usize = 1000;
/// `CODE_REVIEW_ID_MAX`: item ids (GitHub node ids, `projectId!iid` on GitLab).
pub const ID_MAX: usize = 256;
/// `CODE_REVIEW_TOKEN_MAX`: a personal access token is never longer.
pub const TOKEN_MAX: usize = 255;
/// `GITLAB_URL_MAX`: the GitLab server URL is never longer.
pub const GITLAB_URL_MAX: usize = 512;
/// `updatedAt` of an item or a contributions summary (`z.string().max(64)`).
pub const UPDATED_AT_MAX: usize = 64;
/// Most columns (weeks) of the month chart; the fewest is [`WEEKS_MIN`].
pub const WEEKS_MAX: usize = 6;
pub const WEEKS_MIN: usize = 4;

string_enum! {
    /// `platformSchema`.
    pub enum Platform {
        Github = "github",
        Gitlab = "gitlab",
    }
}

string_enum! {
    /// `reviewStateSchema`.
    pub enum ReviewState {
        None = "none",
        Approved = "approved",
        Changes = "changes",
        Commented = "commented",
    }
}

string_enum! {
    /// `reviewKindSchema`: a review that counts as "reviewed" (what an alert announces).
    pub enum ReviewKind {
        Approved = "approved",
        Changes = "changes",
        Commented = "commented",
    }
}

string_enum! {
    /// `checksSchema` without its `null` (an `Option<Checks>` field).
    pub enum Checks {
        Pass = "pass",
        Fail = "fail",
        Running = "running",
    }
}

string_enum! {
    /// `platformStatusSchema`.
    pub enum PlatformStatus {
        Unconfigured = "unconfigured",
        Ok = "ok",
        Offline = "offline",
        AuthError = "auth-error",
    }
}

string_enum! {
    /// Why `code-review:set-token` refused a token.
    pub enum SetTokenReason {
        Auth = "auth",
        Network = "network",
        Url = "url",
    }
}

/// `itemSchema`: one PR/MR as the notch sees it (no URL: main opens it by id).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReviewItem {
    pub id: String,
    /// `owner/repo#123` (GitHub) or `group/project!45` (GitLab).
    #[serde(rename = "ref")]
    pub reference: String,
    pub title: String,
    pub author: String,
    /// ISO time of the last update.
    pub updated_at: String,
    pub draft: bool,
    pub review: ReviewState,
    #[serde(deserialize_with = "nullable")]
    pub checks: Option<Checks>,
    pub conflicts: bool,
}

impl Validate for ReviewItem {
    fn validate(&self) -> Result<(), String> {
        len_in("id", &self.id, 1, ID_MAX)?;
        max_len("ref", &self.reference, TEXT_MAX)?;
        max_len("title", &self.title, TEXT_MAX)?;
        max_len("author", &self.author, TEXT_MAX)?;
        max_len("updatedAt", &self.updated_at, UPDATED_AT_MAX)
    }
}

/// `codeReviewListSchema`: output of `code-review:list`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodeReviewList {
    pub to_review: Vec<ReviewItem>,
    pub mine: Vec<ReviewItem>,
}

impl Validate for CodeReviewList {
    fn validate(&self) -> Result<(), String> {
        at_most("toReview", self.to_review.len(), LIST_LIMIT)?;
        at_most("mine", self.mine.len(), LIST_LIMIT)?;
        self.to_review
            .iter()
            .chain(&self.mine)
            .try_for_each(Validate::validate)
    }
}

/// `platformStateSchema`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PlatformState {
    pub status: PlatformStatus,
    /// Login (GitHub) or username (GitLab) of the token's account.
    #[serde(deserialize_with = "nullable")]
    pub account: Option<String>,
    /// Own open, non-draft PR/MRs without any review (`0..=COUNT_CAP`).
    #[serde(deserialize_with = "nullable")]
    pub unreviewed: Option<u32>,
    /// ISO time of the last successful query.
    #[serde(deserialize_with = "nullable")]
    pub updated_at: Option<String>,
    /// False when the token lives only in memory (no OS encryption).
    pub persistent: bool,
}

impl Validate for PlatformState {
    fn validate(&self) -> Result<(), String> {
        if let Some(account) = &self.account {
            max_len("account", account, TEXT_MAX)?;
        }
        match self.unreviewed {
            Some(count) if count > COUNT_CAP => {
                Err(format!("unreviewed must be at most {COUNT_CAP}"))
            }
            _ => Ok(()),
        }
    }
}

/// `codeReviewStateSchema`: output of `code-review:get-state`, payload of `code-review:state`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CodeReviewState {
    pub github: PlatformState,
    pub gitlab: PlatformState,
}

impl Validate for CodeReviewState {
    fn validate(&self) -> Result<(), String> {
        self.github.validate()?;
        self.gitlab.validate()
    }
}

/// `codeReviewAlertSchema`: own PR/MRs got their first review; `kind`/`ref`/`title` only for a
/// single one (omitted, never `null`, otherwise).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CodeReviewAlert {
    pub platform: Platform,
    pub count: u64,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub kind: Option<ReviewKind>,
    #[serde(
        rename = "ref",
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub reference: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub title: Option<String>,
}

impl Validate for CodeReviewAlert {
    fn validate(&self) -> Result<(), String> {
        safe_int_min("count", self.count, 1)?;
        if let Some(reference) = &self.reference {
            max_len("ref", reference, TEXT_MAX)?;
        }
        if let Some(title) = &self.title {
            max_len("title", title, TEXT_MAX)?;
        }
        Ok(())
    }
}

/// `listInputSchema`, `clearInputSchema` and `contributionsInputSchema`: just a platform.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PlatformInput {
    pub platform: Platform,
}

impl Validate for PlatformInput {}

/// `code-review:list` input.
pub type ListInput = PlatformInput;
/// `code-review:clear` input.
pub type ClearInput = PlatformInput;
/// `code-review:contributions` input.
pub type ContributionsInput = PlatformInput;

/// `openInputSchema`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct OpenInput {
    pub platform: Platform,
    pub id: String,
}

impl Validate for OpenInput {
    fn validate(&self) -> Result<(), String> {
        len_in("id", &self.id, 1, ID_MAX)
    }
}

/// `setTokenInputSchema`. `url` is the GitLab server as typed (normalized in main).
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SetTokenInput {
    pub platform: Platform,
    pub token: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub url: Option<String>,
}

/// Masks the token, so a `{:?}` in a log or a failed assertion never prints it.
impl std::fmt::Debug for SetTokenInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SetTokenInput")
            .field("platform", &self.platform)
            .field("token", &"••••••")
            .field("url", &self.url.as_ref().map(|_| "…"))
            .finish()
    }
}

impl Validate for SetTokenInput {
    fn validate(&self) -> Result<(), String> {
        len_in("token", &self.token, 1, TOKEN_MAX)?;
        if let Some(url) = &self.url {
            max_len("url", url, GITLAB_URL_MAX)?;
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Accepted {
    ok: True,
    account: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Refused {
    ok: False,
    reason: SetTokenReason,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum SetTokenWire {
    Accepted(Accepted),
    Refused(Refused),
}

/// `setTokenResultSchema`: `{ok: true, account}` or `{ok: false, reason}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(into = "SetTokenWire", from = "SetTokenWire")]
pub enum SetTokenResult {
    Accepted { account: String },
    Refused { reason: SetTokenReason },
}

impl From<SetTokenResult> for SetTokenWire {
    fn from(result: SetTokenResult) -> Self {
        match result {
            SetTokenResult::Accepted { account } => Self::Accepted(Accepted {
                ok: BoolLiteral,
                account,
            }),
            SetTokenResult::Refused { reason } => Self::Refused(Refused {
                ok: BoolLiteral,
                reason,
            }),
        }
    }
}

impl From<SetTokenWire> for SetTokenResult {
    fn from(wire: SetTokenWire) -> Self {
        match wire {
            SetTokenWire::Accepted(Accepted { account, .. }) => Self::Accepted { account },
            SetTokenWire::Refused(Refused { reason, .. }) => Self::Refused { reason },
        }
    }
}

impl Validate for SetTokenResult {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Accepted { account } => max_len("account", account, TEXT_MAX),
            Self::Refused { .. } => Ok(()),
        }
    }
}

/// `codeReviewViewInputSchema`: the notch's "Revisiones" view opened or closed.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CodeReviewViewInput {
    pub open: bool,
}

impl Validate for CodeReviewViewInput {}

/// `/^\d{4}-(0[1-9]|1[0-2])$/` (`\d` is ASCII in a JS regex without `u`).
pub fn is_month_key(value: &str) -> bool {
    is_month_bytes(value.as_bytes())
}

/// `/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/`.
pub fn is_day_key(value: &str) -> bool {
    match value.as_bytes() {
        [month @ .., b'-', d1, d2] if month.len() == 7 => {
            is_month_bytes(month)
                && match d1 {
                    b'0' => (b'1'..=b'9').contains(d2),
                    b'1' | b'2' => d2.is_ascii_digit(),
                    b'3' => matches!(d2, b'0' | b'1'),
                    _ => false,
                }
        }
        _ => false,
    }
}

fn is_month_bytes(bytes: &[u8]) -> bool {
    match bytes {
        [y1, y2, y3, y4, b'-', m1, m2] => {
            [y1, y2, y3, y4].iter().all(|byte| byte.is_ascii_digit()) && is_month(*m1, *m2)
        }
        _ => false,
    }
}

fn is_month(m1: u8, m2: u8) -> bool {
    match m1 {
        b'0' => (b'1'..=b'9').contains(&m2),
        b'1' => (b'0'..=b'2').contains(&m2),
        _ => false,
    }
}

/// `contributionDaySchema`: one square of the month chart.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ContributionDay {
    /// Local date `YYYY-MM-DD`.
    pub date: String,
    pub count: u64,
    /// `0..=4`.
    pub level: u8,
    pub in_month: bool,
    /// After today (local).
    pub future: bool,
}

impl Validate for ContributionDay {
    fn validate(&self) -> Result<(), String> {
        if !is_day_key(&self.date) {
            return Err("date must be YYYY-MM-DD".into());
        }
        safe_int_min("count", self.count, 0)?;
        if self.level > 4 {
            return Err("level must be 0 to 4".into());
        }
        Ok(())
    }
}

/// `contributionTotalsSchema`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContributionTotals {
    pub commits: u64,
    pub opened: u64,
    pub merged: u64,
    pub reviews: u64,
}

impl Validate for ContributionTotals {
    fn validate(&self) -> Result<(), String> {
        safe_int_min("commits", self.commits, 0)?;
        safe_int_min("opened", self.opened, 0)?;
        safe_int_min("merged", self.merged, 0)?;
        safe_int_min("reviews", self.reviews, 0)
    }
}

/// `contributionSummarySchema`: the current month's chart plus today / week / month totals.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ContributionSummary {
    /// `YYYY-MM` (local).
    pub month: String,
    /// Columns Monday -> Sunday, 7 days each; 4 to 6 of them.
    pub weeks: Vec<Vec<ContributionDay>>,
    pub month_total: u64,
    /// `0..=31`.
    pub active_days: u32,
    pub today: ContributionTotals,
    pub week: ContributionTotals,
    pub month_totals: ContributionTotals,
    /// GitLab: the page limit was reached, older events of the month are missing.
    pub partial: bool,
    /// GitHub: there are private contributions that are not detailed.
    pub restricted: bool,
    /// ISO time of the query.
    pub updated_at: String,
}

impl Validate for ContributionSummary {
    fn validate(&self) -> Result<(), String> {
        if !is_month_key(&self.month) {
            return Err("month must be YYYY-MM".into());
        }
        if !(WEEKS_MIN..=WEEKS_MAX).contains(&self.weeks.len()) {
            return Err(format!("weeks must have {WEEKS_MIN} to {WEEKS_MAX} items"));
        }
        for week in &self.weeks {
            if week.len() != 7 {
                return Err("a week must have 7 days".into());
            }
            week.iter().try_for_each(Validate::validate)?;
        }
        safe_int_min("monthTotal", self.month_total, 0)?;
        if self.active_days > 31 {
            return Err("activeDays must be 0 to 31".into());
        }
        self.today.validate()?;
        self.week.validate()?;
        self.month_totals.validate()?;
        max_len("updatedAt", &self.updated_at, UPDATED_AT_MAX)
    }
}

/// `contributionsResultSchema`: the cached summary (`null` when not connected or not loaded) and
/// whether the last query failed.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContributionsResult {
    #[serde(deserialize_with = "nullable")]
    pub summary: Option<ContributionSummary>,
    pub error: bool,
}

impl Validate for ContributionsResult {
    fn validate(&self) -> Result<(), String> {
        self.summary.as_ref().map_or(Ok(()), Validate::validate)
    }
}

/// `contributionsChangedSchema`: payload of `code-review:contributions-changed`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ContributionsChanged {
    pub platform: Platform,
    pub error: bool,
}

impl Validate for ContributionsChanged {}

input_entry!(PlatformInput, OpenInput, SetTokenInput, CodeReviewViewInput);

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::contract::parse;

    #[test]
    fn set_token_result_serializes_to_the_discriminated_shapes() {
        let accepted = SetTokenResult::Accepted {
            account: "me".into(),
        };
        let refused = SetTokenResult::Refused {
            reason: SetTokenReason::Url,
        };
        assert_eq!(
            serde_json::to_value(&accepted).unwrap(),
            json!({ "ok": true, "account": "me" })
        );
        assert_eq!(
            serde_json::to_value(&refused).unwrap(),
            json!({ "ok": false, "reason": "url" })
        );
        assert_eq!(
            parse::<SetTokenResult>(json!({ "ok": true, "account": "me" })).unwrap(),
            accepted
        );
    }

    #[test]
    fn item_serializes_ref_and_null_checks_without_a_url() {
        let item = ReviewItem {
            id: "PR_1".into(),
            reference: "o/r#1".into(),
            title: "t".into(),
            author: "a".into(),
            updated_at: "2026-11-12T10:00:00Z".into(),
            draft: false,
            review: ReviewState::None,
            checks: None,
            conflicts: false,
        };
        assert_eq!(
            serde_json::to_value(&item).unwrap(),
            json!({
                "id": "PR_1", "ref": "o/r#1", "title": "t", "author": "a",
                "updatedAt": "2026-11-12T10:00:00Z", "draft": false, "review": "none",
                "checks": null, "conflicts": false,
            })
        );
    }

    #[test]
    fn alert_omits_the_single_review_fields_when_absent() {
        let alert = CodeReviewAlert {
            platform: Platform::Gitlab,
            count: 3,
            kind: None,
            reference: None,
            title: None,
        };
        assert_eq!(
            serde_json::to_value(&alert).unwrap(),
            json!({ "platform": "gitlab", "count": 3 })
        );
    }

    #[test]
    fn set_token_input_debug_never_prints_the_token() {
        let input =
            SetTokenInput::from_input(json!({ "platform": "github", "token": "ghp_SECRET" }))
                .unwrap();
        assert!(!format!("{input:?}").contains("SECRET"));
    }

    #[test]
    fn day_and_month_keys_follow_the_regexes() {
        assert!(is_day_key("2026-11-01"));
        assert!(is_day_key("2026-02-31"));
        assert!(!is_day_key("2026-11-00"));
        assert!(!is_day_key("2026-11-32"));
        assert!(!is_day_key("2026-1-011"));
        assert!(is_month_key("2026-10"));
        assert!(!is_month_key("2026-13"));
        assert!(!is_month_key("２026-10"));
    }
}
