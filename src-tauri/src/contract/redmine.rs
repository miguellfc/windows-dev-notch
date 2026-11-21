//! `redmine:*` channels and events (`src/shared/redmine/schema.ts`).
//!
//! Every object is a `z.strictObject` (`deny_unknown_fields`). Lengths are zod's (code points,
//! see `contract::length`); the client cuts texts by UTF-16 units (`clip`), never past these.
//! zod's `z.number()` is an `f64` here (finite: JSON has no `Infinity` or `NaN`), so `updatedAt`
//! (epoch milliseconds) and the hours serialize as `8.0` where JS writes `8`; both parse the same.
//! No URL and no API key ever crosses IPC: the strict outputs refuse a `url` or `key` field.

use serde::{Deserialize, Serialize};

use super::claude::{BoolLiteral, False, True};
use super::code_review::{is_day_key, is_month_key};
use super::{
    at_most, len_in, max_len, nullable, present, safe_int_min, Validate, MAX_SAFE_INTEGER,
};

/// `TEXT_MAX`: subjects, projects, status and activity names, `updatedOn` and the account.
pub const TEXT_MAX: usize = 512;
/// `REDMINE_KEY_MAX`: a Redmine API key is never longer.
pub const KEY_MAX: usize = 255;
/// `REDMINE_COMMENT_MAX`: the comment of a time entry.
pub const COMMENT_MAX: usize = 255;
/// `REDMINE_URL_MAX`: the server URL as typed.
pub const URL_MAX: usize = crate::settings::validate::REDMINE_URL_MAX;
/// A write result carries at most this many validation messages...
pub const MESSAGES_MAX: usize = 3;
/// ...of at most this many characters each.
pub const MESSAGE_MAX: usize = 200;
/// Largest estimate `redmine:update-issue` accepts, in hours.
pub const ESTIMATE_MAX: f64 = 999.0;
/// Largest time entry `redmine:log-time` accepts, in hours.
pub const HOURS_MAX: f64 = 24.0;

string_enum! {
    /// `redmineStatusSchema`.
    pub enum RedmineStatus {
        Unconfigured = "unconfigured",
        Ok = "ok",
        Offline = "offline",
        AuthError = "auth-error",
    }
}

string_enum! {
    /// `redmineWriteErrorSchema`: why a write was refused.
    pub enum RedmineWriteError {
        Auth = "auth",
        Forbidden = "forbidden",
        NotFound = "not-found",
        Validation = "validation",
        Network = "network",
        Server = "server",
        InvalidResponse = "invalid-response",
    }
}

string_enum! {
    /// Why `redmine:set-key` refused a key.
    pub enum SetKeyReason {
        Auth = "auth",
        Network = "network",
        Url = "url",
    }
}

/// `z.number().min(0)` on the field `name`.
fn non_negative(name: &str, value: f64) -> Result<(), String> {
    if value >= 0.0 {
        Ok(())
    } else {
        Err(format!("{name} must be at least 0"))
    }
}

/// `z.int()` on a field deserialized as a signed integer: any safe integer.
fn safe_int(name: &str, value: i64) -> Result<(), String> {
    if value.unsigned_abs() <= MAX_SAFE_INTEGER {
        Ok(())
    } else {
        Err(format!("{name} must be a safe integer"))
    }
}

/// `hasMax2Decimals`: at most 2 decimals (hundredths), tolerant to float noise such as
/// `1.1 * 100`. `f64::round` differs from JS `Math.round` only on negative halves, which the
/// minimum checks refuse anyway.
pub fn has_max_2_decimals(value: f64) -> bool {
    let hundredths = value * 100.0;
    (hundredths - hundredths.round()).abs() < 1e-6
}

/// The local date the "not in the future" check compares with (`localDate(new Date())`).
///
/// Uses the REAL clock (`chrono::Local::now()`), not the test clock, as Electron uses
/// `new Date()`. `chrono::Local` follows the Windows zone rules while the renderer (ICU) may
/// differ by an offset for some zones and years: this is the part 4 ICU/Windows divergence
/// follow-up (#1, `docs/e2e.md`), documented and not fixed here.
pub fn today() -> String {
    crate::code_review::contributions::local_date(&chrono::Local::now())
}

/// `redmineStateSchema`: output of `redmine:get-state`, payload of `redmine:state`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RedmineState {
    pub status: RedmineStatus,
    #[serde(deserialize_with = "nullable")]
    pub account: Option<String>,
    /// Hours logged today; `None` until the first read.
    #[serde(deserialize_with = "nullable")]
    pub today_hours: Option<f64>,
    /// Hours logged from the 1st of the current month to today; `None` until the first read.
    #[serde(deserialize_with = "nullable")]
    pub month_hours: Option<f64>,
    /// Epoch milliseconds of the last successful query (a number, not an ISO string).
    #[serde(deserialize_with = "nullable")]
    pub updated_at: Option<f64>,
    /// Whether the API key is stored encrypted on disk (false: memory only).
    pub persistent: bool,
}

impl Validate for RedmineState {
    fn validate(&self) -> Result<(), String> {
        if let Some(account) = &self.account {
            max_len("account", account, TEXT_MAX)?;
        }
        if let Some(hours) = self.today_hours {
            non_negative("todayHours", hours)?;
        }
        if let Some(hours) = self.month_hours {
            non_negative("monthHours", hours)?;
        }
        Ok(())
    }
}

/// `namedSchema`: a status (`{id, name}`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Named {
    pub id: i64,
    pub name: String,
}

impl Validate for Named {
    fn validate(&self) -> Result<(), String> {
        safe_int("id", self.id)?;
        max_len("name", &self.name, TEXT_MAX)
    }
}

/// `redmineIssueSchema`: one issue as the notch sees it (no URL: main opens it by id).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RedmineIssue {
    pub id: u64,
    pub subject: String,
    pub project: String,
    pub status: Named,
    #[serde(deserialize_with = "nullable")]
    pub estimated_hours: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub spent_hours: Option<f64>,
    /// ISO time of the last update.
    pub updated_on: String,
}

/// The checks of `redmineIssueSchema`, shared with the detail.
fn validate_issue(
    id: u64,
    subject: &str,
    project: &str,
    status: &Named,
    estimated_hours: Option<f64>,
    spent_hours: Option<f64>,
    updated_on: &str,
) -> Result<(), String> {
    safe_int_min("id", id, 1)?;
    max_len("subject", subject, TEXT_MAX)?;
    max_len("project", project, TEXT_MAX)?;
    status.validate()?;
    if let Some(hours) = estimated_hours {
        non_negative("estimatedHours", hours)?;
    }
    if let Some(hours) = spent_hours {
        non_negative("spentHours", hours)?;
    }
    max_len("updatedOn", updated_on, TEXT_MAX)
}

impl Validate for RedmineIssue {
    fn validate(&self) -> Result<(), String> {
        validate_issue(
            self.id,
            &self.subject,
            &self.project,
            &self.status,
            self.estimated_hours,
            self.spent_hours,
            &self.updated_on,
        )
    }
}

/// `redmineIssueListSchema`: output of `redmine:issues`.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RedmineIssueList {
    pub issues: Vec<RedmineIssue>,
    /// More issues than the pages read.
    pub truncated: bool,
}

impl Validate for RedmineIssueList {
    fn validate(&self) -> Result<(), String> {
        self.issues.validate()
    }
}

/// `redmineIssueDetailSchema` (`redmineIssueSchema.extend({allowedStatuses})`, still strict):
/// output of `redmine:issue`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RedmineIssueDetail {
    pub id: u64,
    pub subject: String,
    pub project: String,
    pub status: Named,
    #[serde(deserialize_with = "nullable")]
    pub estimated_hours: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub spent_hours: Option<f64>,
    pub updated_on: String,
    pub allowed_statuses: Vec<Named>,
}

impl Validate for RedmineIssueDetail {
    fn validate(&self) -> Result<(), String> {
        validate_issue(
            self.id,
            &self.subject,
            &self.project,
            &self.status,
            self.estimated_hours,
            self.spent_hours,
            &self.updated_on,
        )?;
        self.allowed_statuses.validate()
    }
}

/// `redmineActivitySchema`: one time entry activity (`redmine:activities` answers a list).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RedmineActivity {
    pub id: i64,
    pub name: String,
    pub is_default: bool,
}

impl Validate for RedmineActivity {
    fn validate(&self) -> Result<(), String> {
        safe_int("id", self.id)?;
        max_len("name", &self.name, TEXT_MAX)
    }
}

/// One day of the summary.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SummaryDay {
    /// Local date `YYYY-MM-DD` (the regex only: `2026-02-31` passes).
    pub date: String,
    pub hours: f64,
}

impl Validate for SummaryDay {
    fn validate(&self) -> Result<(), String> {
        if !is_day_key(&self.date) {
            return Err("date must be YYYY-MM-DD".into());
        }
        non_negative("hours", self.hours)
    }
}

/// `redmineSummarySchema`: hours of today, this week and this month.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RedmineSummary {
    /// `YYYY-MM`.
    pub month: String,
    pub days: Vec<SummaryDay>,
    pub today: f64,
    pub week: f64,
    pub month_total: f64,
}

impl Validate for RedmineSummary {
    fn validate(&self) -> Result<(), String> {
        if !is_month_key(&self.month) {
            return Err("month must be YYYY-MM".into());
        }
        self.days.validate()?;
        non_negative("today", self.today)?;
        non_negative("week", self.week)?;
        non_negative("monthTotal", self.month_total)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteDone {
    ok: True,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteRefused {
    ok: False,
    reason: RedmineWriteError,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    messages: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum WriteWire {
    Done(WriteDone),
    Refused(WriteRefused),
}

/// `redmineWriteResultSchema`: `{ok: true}` or `{ok: false, reason, messages?}`. `messages` is
/// optional, never `null`, and omitted when there are none.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(into = "WriteWire", from = "WriteWire")]
pub enum RedmineWriteResult {
    Done,
    Refused {
        reason: RedmineWriteError,
        messages: Option<Vec<String>>,
    },
}

impl From<RedmineWriteResult> for WriteWire {
    fn from(result: RedmineWriteResult) -> Self {
        match result {
            RedmineWriteResult::Done => Self::Done(WriteDone { ok: BoolLiteral }),
            RedmineWriteResult::Refused { reason, messages } => Self::Refused(WriteRefused {
                ok: BoolLiteral,
                reason,
                messages,
            }),
        }
    }
}

impl From<WriteWire> for RedmineWriteResult {
    fn from(wire: WriteWire) -> Self {
        match wire {
            WriteWire::Done(_) => Self::Done,
            WriteWire::Refused(WriteRefused {
                reason, messages, ..
            }) => Self::Refused { reason, messages },
        }
    }
}

impl Validate for RedmineWriteResult {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Refused {
                messages: Some(messages),
                ..
            } => {
                at_most("messages", messages.len(), MESSAGES_MAX)?;
                messages
                    .iter()
                    .try_for_each(|message| max_len("message", message, MESSAGE_MAX))
            }
            _ => Ok(()),
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyAccepted {
    ok: True,
    account: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyRefused {
    ok: False,
    reason: SetKeyReason,
}

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum SetKeyWire {
    Accepted(KeyAccepted),
    Refused(KeyRefused),
}

/// `redmineSetKeyResultSchema`: `{ok: true, account}` or `{ok: false, reason}`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(into = "SetKeyWire", from = "SetKeyWire")]
pub enum RedmineSetKeyResult {
    Accepted { account: String },
    Refused { reason: SetKeyReason },
}

impl From<RedmineSetKeyResult> for SetKeyWire {
    fn from(result: RedmineSetKeyResult) -> Self {
        match result {
            RedmineSetKeyResult::Accepted { account } => Self::Accepted(KeyAccepted {
                ok: BoolLiteral,
                account,
            }),
            RedmineSetKeyResult::Refused { reason } => Self::Refused(KeyRefused {
                ok: BoolLiteral,
                reason,
            }),
        }
    }
}

impl From<SetKeyWire> for RedmineSetKeyResult {
    fn from(wire: SetKeyWire) -> Self {
        match wire {
            SetKeyWire::Accepted(KeyAccepted { account, .. }) => Self::Accepted { account },
            SetKeyWire::Refused(KeyRefused { reason, .. }) => Self::Refused { reason },
        }
    }
}

impl Validate for RedmineSetKeyResult {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Accepted { account } => max_len("account", account, TEXT_MAX),
            Self::Refused { .. } => Ok(()),
        }
    }
}

/// `redmineAlertSchema`: payload of `redmine:alert`, hours logged today versus the daily target.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RedmineAlert {
    pub hours: f64,
    /// `1..=24`.
    pub target: f64,
}

impl Validate for RedmineAlert {
    fn validate(&self) -> Result<(), String> {
        non_negative("hours", self.hours)?;
        if (1.0..=24.0).contains(&self.target) {
            Ok(())
        } else {
            Err("target must be between 1 and 24".into())
        }
    }
}

/// `updateIssueInputSchema`: input of `redmine:update-issue`. At least one of `statusId` and
/// `estimatedHours` ("Nothing to update"); `estimatedHours: null` counts and clears the estimate.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UpdateIssueInput {
    pub id: u64,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub status_id: Option<u64>,
    /// `None`: not sent; `Some(None)`: `null` (clear the estimate); `Some(Some(h))`: set it.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub estimated_hours: Option<Option<f64>>,
}

impl Validate for UpdateIssueInput {
    fn validate(&self) -> Result<(), String> {
        safe_int_min("id", self.id, 1)?;
        if let Some(status_id) = self.status_id {
            safe_int_min("statusId", status_id, 1)?;
        }
        if let Some(Some(hours)) = self.estimated_hours {
            if !(0.0..=ESTIMATE_MAX).contains(&hours) {
                return Err(format!(
                    "estimatedHours must be between 0 and {ESTIMATE_MAX}"
                ));
            }
            if !has_max_2_decimals(hours) {
                return Err("At most 2 decimals".into());
            }
        }
        // The refine: a `null` estimate counts as an update (it clears the estimate).
        if self.status_id.is_none() && self.estimated_hours.is_none() {
            return Err("Nothing to update".into());
        }
        Ok(())
    }
}

/// `logTimeInputSchema`: input of `redmine:log-time`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LogTimeInput {
    pub issue_id: u64,
    /// Local date `YYYY-MM-DD`, not after [`today`].
    pub spent_on: String,
    pub hours: f64,
    pub activity_id: u64,
    pub comments: String,
}

impl Validate for LogTimeInput {
    fn validate(&self) -> Result<(), String> {
        safe_int_min("issueId", self.issue_id, 1)?;
        if !is_day_key(&self.spent_on) {
            return Err("spentOn must be YYYY-MM-DD".into());
        }
        // `day <= localDate(new Date())`: both are `YYYY-MM-DD`, so the string order is the
        // date order. The real clock, see [`today`].
        if self.spent_on > today() {
            return Err("Date cannot be in the future".into());
        }
        if !(self.hours > 0.0 && self.hours <= HOURS_MAX) {
            return Err(format!("hours must be above 0 and at most {HOURS_MAX}"));
        }
        if !has_max_2_decimals(self.hours) {
            return Err("At most 2 decimals".into());
        }
        safe_int_min("activityId", self.activity_id, 1)?;
        max_len("comments", &self.comments, COMMENT_MAX)
    }
}

/// `setKeyInputSchema`: input of `redmine:set-key`. `url` is the server as typed (trimmed and
/// normalized in main).
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SetKeyInput {
    pub url: String,
    pub key: String,
}

/// Masks the key, so a `{:?}` in a log or a failed assertion never prints it (nor the server).
impl std::fmt::Debug for SetKeyInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SetKeyInput")
            .field("url", &"…")
            .field("key", &"••••••")
            .finish()
    }
}

impl Validate for SetKeyInput {
    fn validate(&self) -> Result<(), String> {
        max_len("url", &self.url, URL_MAX)?;
        len_in("key", &self.key, 1, KEY_MAX)
    }
}

/// `redmineIdInputSchema`: one issue by its Redmine id (the renderer never sends a URL).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RedmineIdInput {
    pub id: u64,
}

impl Validate for RedmineIdInput {
    fn validate(&self) -> Result<(), String> {
        safe_int_min("id", self.id, 1)
    }
}

/// `redmineFindIssueResultSchema`: output of `redmine:find-issue`; false for an issue that does
/// not exist or the key cannot see (the renderer cannot tell them apart).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RedmineFindIssueResult {
    pub found: bool,
}

impl Validate for RedmineFindIssueResult {}

/// `redmineViewInputSchema`: the Redmine view opened or closed.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RedmineViewInput {
    pub open: bool,
}

impl Validate for RedmineViewInput {}

/// `redmineSummaryResultSchema`: output of `redmine:summary`, the cached summary (`None` when not
/// connected or not loaded yet) and whether the last query failed.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RedmineSummaryResult {
    #[serde(deserialize_with = "nullable")]
    pub summary: Option<RedmineSummary>,
    pub error: bool,
}

impl Validate for RedmineSummaryResult {
    fn validate(&self) -> Result<(), String> {
        self.summary.as_ref().map_or(Ok(()), Validate::validate)
    }
}

/// `redmineSummaryChangedSchema`: payload of `redmine:summary-changed`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RedmineSummaryChanged {
    pub error: bool,
}

impl Validate for RedmineSummaryChanged {}

input_entry!(
    UpdateIssueInput,
    LogTimeInput,
    SetKeyInput,
    RedmineIdInput,
    RedmineViewInput
);

#[cfg(test)]
mod tests {
    use chrono::{Duration, Local};
    use serde_json::{json, Value};

    use super::*;
    use crate::code_review::contributions::local_date;
    use crate::contract::parse;

    fn accepts<T: serde::de::DeserializeOwned + serde::Serialize + Validate>(value: Value) -> bool {
        parse::<T>(value).is_ok()
    }

    fn tomorrow() -> String {
        local_date(&(Local::now() + Duration::hours(36)))
    }

    fn log(over: Value) -> Value {
        let mut value = json!({
            "issueId": 1, "spentOn": today(), "hours": 1, "activityId": 9, "comments": "",
        });
        for (key, field) in over.as_object().unwrap() {
            value[key] = field.clone();
        }
        value
    }

    // tests/unit/shared/redmine-schema.test.ts, logTimeInputSchema: accepts valid hours and
    // rejects 0, > 24 and more than 2 decimals.
    #[test]
    fn log_time_accepts_valid_hours_and_rejects_0_over_24_and_more_than_2_decimals() {
        for hours in [0.01, 1.0, 5.5, 24.0] {
            assert!(
                accepts::<LogTimeInput>(log(json!({ "hours": hours }))),
                "{hours}"
            );
        }
        for hours in [0.0, 24.01, 1.234, -1.0] {
            assert!(
                !accepts::<LogTimeInput>(log(json!({ "hours": hours }))),
                "{hours}"
            );
        }
        // `Number.NaN` cannot cross JSON (serde_json writes `null`); the check refuses it too.
        assert!(!accepts::<LogTimeInput>(log(json!({ "hours": f64::NAN }))));
        let mut input = parse::<LogTimeInput>(log(json!({}))).unwrap();
        input.hours = f64::NAN;
        assert!(input.validate().is_err());
    }

    // logTimeInputSchema: rejects a future date and malformed dates.
    #[test]
    fn log_time_rejects_a_future_date_and_malformed_dates() {
        assert!(!accepts::<LogTimeInput>(log(
            json!({ "spentOn": tomorrow() })
        )));
        assert!(!accepts::<LogTimeInput>(log(
            json!({ "spentOn": "2026-13-01" })
        )));
        assert!(!accepts::<LogTimeInput>(log(
            json!({ "spentOn": "2026-1-1" })
        )));
        assert!(accepts::<LogTimeInput>(log(
            json!({ "spentOn": "2026-02-31" })
        )));
    }

    // logTimeInputSchema: limits the comment to 255 characters.
    #[test]
    fn log_time_limits_the_comment_to_255_characters() {
        assert!(accepts::<LogTimeInput>(log(
            json!({ "comments": "a".repeat(255) })
        )));
        assert!(!accepts::<LogTimeInput>(log(
            json!({ "comments": "a".repeat(256) })
        )));
    }

    // logTimeInputSchema: is strict.
    #[test]
    fn log_time_is_strict() {
        assert!(!accepts::<LogTimeInput>(log(json!({ "extra": 1 }))));
    }

    // updateIssueInputSchema: rejects an empty update.
    #[test]
    fn update_issue_rejects_an_empty_update() {
        assert!(!accepts::<UpdateIssueInput>(json!({ "id": 1 })));
    }

    // updateIssueInputSchema: accepts a status, an estimate or null to clear it.
    #[test]
    fn update_issue_accepts_a_status_an_estimate_or_null_to_clear_it() {
        assert!(accepts::<UpdateIssueInput>(
            json!({ "id": 1, "statusId": 3 })
        ));
        assert!(accepts::<UpdateIssueInput>(
            json!({ "id": 1, "estimatedHours": 0 })
        ));
        assert!(accepts::<UpdateIssueInput>(
            json!({ "id": 1, "estimatedHours": 999 })
        ));
        assert!(accepts::<UpdateIssueInput>(
            json!({ "id": 1, "estimatedHours": 2.25 })
        ));
        assert!(accepts::<UpdateIssueInput>(
            json!({ "id": 1, "estimatedHours": null })
        ));
        let clear = parse::<UpdateIssueInput>(json!({ "id": 1, "estimatedHours": null })).unwrap();
        assert_eq!(clear.estimated_hours, Some(None));
        assert_eq!(
            serde_json::to_value(clear).unwrap(),
            json!({ "id": 1, "estimatedHours": null })
        );
    }

    // updateIssueInputSchema: bounds the estimate.
    #[test]
    fn update_issue_bounds_the_estimate() {
        for estimated in [-1.0, 999.01, 1.234] {
            assert!(
                !accepts::<UpdateIssueInput>(json!({ "id": 1, "estimatedHours": estimated })),
                "{estimated}"
            );
        }
    }

    // setKeyInputSchema: needs a key of 1 to 255 characters.
    #[test]
    fn set_key_needs_a_key_of_1_to_255_characters() {
        let url = "https://r.x.com";
        assert!(accepts::<SetKeyInput>(json!({ "url": url, "key": "k" })));
        assert!(!accepts::<SetKeyInput>(json!({ "url": url, "key": "" })));
        assert!(!accepts::<SetKeyInput>(
            json!({ "url": url, "key": "k".repeat(256) })
        ));
        let input = SetKeyInput::from_input(json!({ "url": url, "key": "SECRET" })).unwrap();
        let debug = format!("{input:?}");
        assert!(!debug.contains("SECRET") && !debug.contains("r.x.com"));
    }

    fn issue() -> Value {
        json!({
            "id": 12,
            "subject": "Fix",
            "project": "P",
            "status": { "id": 1, "name": "New" },
            "estimatedHours": null,
            "spentHours": 2.5,
            "updatedOn": "2026-11-14T10:00:00Z",
        })
    }

    // data schemas: parses issues and details.
    #[test]
    fn parses_issues_and_details() {
        let parsed = parse::<RedmineIssue>(issue()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), issue());
        let mut detail = issue();
        detail["allowedStatuses"] = json!([{ "id": 2, "name": "Done" }]);
        let parsed = parse::<RedmineIssueDetail>(detail.clone()).unwrap();
        assert_eq!(serde_json::to_value(&parsed).unwrap(), detail);
        let mut extra = issue();
        extra["extra"] = json!(1);
        assert!(!accepts::<RedmineIssue>(extra));
    }

    // data schemas: parses state and write results.
    #[test]
    fn parses_state_and_write_results() {
        let state = json!({
            "status": "ok", "account": "ana", "todayHours": 0, "monthHours": 12.5, "updatedAt": 1, "persistent": true,
        });
        assert_eq!(
            parse::<RedmineState>(state.clone()).unwrap(),
            RedmineState {
                status: RedmineStatus::Ok,
                account: Some("ana".into()),
                today_hours: Some(0.0),
                month_hours: Some(12.5),
                updated_at: Some(1.0),
                persistent: true,
            }
        );
        let mut bad = state;
        bad["status"] = json!("nope");
        assert!(!accepts::<RedmineState>(bad));
        assert!(accepts::<RedmineWriteResult>(json!({ "ok": true })));
        assert!(accepts::<RedmineWriteResult>(
            json!({ "ok": false, "reason": "validation", "messages": ["x"] })
        ));
        assert!(!accepts::<RedmineWriteResult>(
            json!({ "ok": false, "reason": "bad" })
        ));
    }

    #[test]
    fn write_and_set_key_results_serialize_to_the_discriminated_shapes() {
        assert_eq!(
            serde_json::to_value(RedmineWriteResult::Done).unwrap(),
            json!({ "ok": true })
        );
        assert_eq!(
            serde_json::to_value(RedmineWriteResult::Refused {
                reason: RedmineWriteError::NotFound,
                messages: None,
            })
            .unwrap(),
            json!({ "ok": false, "reason": "not-found" })
        );
        assert_eq!(
            serde_json::to_value(RedmineWriteResult::Refused {
                reason: RedmineWriteError::Validation,
                messages: Some(vec!["Hours is invalid".into()]),
            })
            .unwrap(),
            json!({ "ok": false, "reason": "validation", "messages": ["Hours is invalid"] })
        );
        assert_eq!(
            serde_json::to_value(RedmineSetKeyResult::Accepted {
                account: "Ana".into()
            })
            .unwrap(),
            json!({ "ok": true, "account": "Ana" })
        );
        assert_eq!(
            serde_json::to_value(RedmineSetKeyResult::Refused {
                reason: SetKeyReason::Url
            })
            .unwrap(),
            json!({ "ok": false, "reason": "url" })
        );
    }

    #[test]
    fn two_decimals_tolerate_float_noise() {
        for value in [0.0, 0.01, 1.1, 2.25, 5.5, 24.0, 999.0, 0.07, 1.15, 8.29] {
            assert!(has_max_2_decimals(value), "{value}");
        }
        for value in [1.234, 0.001, 0.005, 999.999, f64::NAN] {
            assert!(!has_max_2_decimals(value), "{value}");
        }
    }

    #[test]
    fn today_is_the_local_date_of_the_real_clock() {
        let before = local_date(&Local::now());
        let today = today();
        let after = local_date(&Local::now());
        assert!(today == before || today == after, "{today}");
        assert!(is_day_key(&today));
    }
}
