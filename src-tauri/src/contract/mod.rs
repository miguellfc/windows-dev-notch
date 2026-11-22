//! Rust side of `src/shared/ipc/contract.ts`: serde types for the inputs, outputs and event
//! payloads of the ported channels, plus the checks zod runs on top of the shapes.
//!
//! A value is accepted only when it deserializes into the type *and* passes [`Validate`]. The
//! verdicts are kept equal to zod's by `tests/parity/contract-cases.json` (checked by both
//! `src-tauri/tests/parity.rs` and `tests/unit/shared/parity.test.ts`).
//!
//! Known boundary differences, unreachable from `JSON.stringify` (what the bridge sends):
//! an integral float such as `90.0` is rejected where zod sees the integer `90`, and duplicate
//! object keys are rejected where `JSON.parse` keeps the last one.

/// A `z.enum([...])` of strings. Deserializes from a JSON string only: a derived serde enum would
/// also accept a single-key map such as `{"compact": null}`, which zod rejects.
macro_rules! string_enum {
    (
        $(#[$meta:meta])*
        $vis:vis enum $name:ident { $($variant:ident = $text:literal),+ $(,)? }
    ) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        $vis enum $name { $($variant),+ }

        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $text),+ }
            }
        }

        impl ::serde::Serialize for $name {
            fn serialize<S: ::serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.as_str())
            }
        }

        impl<'de> ::serde::Deserialize<'de> for $name {
            fn deserialize<D: ::serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let text = String::deserialize(deserializer)?;
                match text.as_str() {
                    $($text => Ok(Self::$variant),)+
                    _ => Err(<D::Error as ::serde::de::Error>::unknown_variant(&text, &[$($text),+])),
                }
            }
        }

        impl $crate::contract::Validate for $name {}
    };
}

/// `pub fn from_input(value)` on each input type: [`parse_input`] for the handlers that take it.
macro_rules! input_entry {
    ($($name:ident),+ $(,)?) => {
        $(
            impl $name {
                /// Deserializes and validates a channel input; a refusal is INVALID_INPUT.
                pub fn from_input(
                    value: ::serde_json::Value,
                ) -> Result<Self, $crate::ipc::ExposedError> {
                    $crate::contract::parse_input(value)
                }
            }
        )+
    };
}

/// [`string_enum!`] for the modules outside `contract` (path-based, so declaration order is free).
pub(crate) use string_enum;

/// A redacted `Debug` for a type that holds secrets or mail data: it prints only the listed
/// fields, each an expression over the value (`|this| { "unread": this.unread }`), which must be
/// a status, a count or a boolean. Everything else stays out (`Name { unread: true, .. }`).
macro_rules! redacted_debug {
    ($ty:ty $(, |$this:ident| { $($field:literal: $value:expr),* $(,)? })? $(,)?) => {
        impl ::std::fmt::Debug for $ty {
            fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
                let name = ::std::any::type_name::<Self>();
                let mut out = f.debug_struct(name.rsplit("::").next().unwrap_or(name));
                $(
                    let $this = self;
                    $(out.field($field, &$value);)*
                )?
                out.finish_non_exhaustive()
            }
        }
    };
}

/// [`redacted_debug!`] for the modules outside `contract`.
pub(crate) use redacted_debug;

pub mod app;
pub mod apps;
pub mod claude;
pub mod code_review;
pub mod gmail;
pub mod notch;
pub mod notes;
pub mod redmine;
pub mod reminders;
pub mod settings;
pub mod system;
pub mod text;
pub mod usage;
pub mod work_log;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::ipc::{ExposedError, IpcErrorCode};

/// The refinements zod applies beyond the shape (ranges, lengths, formats).
pub trait Validate {
    fn validate(&self) -> Result<(), String> {
        Ok(())
    }
}

/// `z.null()`: the answer of channels that only acknowledge.
pub type Ack = ();

impl Validate for () {}
impl Validate for bool {}

/// `schema.nullable()` at the top level (`gmail:pick-client-file`): `null`, or a valid value.
impl<T: Validate> Validate for Option<T> {
    fn validate(&self) -> Result<(), String> {
        self.as_ref().map_or(Ok(()), Validate::validate)
    }
}

/// `z.array(schema)`: every item passes its schema.
impl<T: Validate> Validate for Vec<T> {
    fn validate(&self) -> Result<(), String> {
        self.iter().try_for_each(Validate::validate)
    }
}

string_enum! {
    /// Why a notes or reminders snapshot may be incomplete: the corrupt file was moved aside, or
    /// the session is read-only.
    pub enum StoreNotice {
        Quarantined = "quarantined",
        ReadOnly = "read-only",
    }
}

/// Which schema of a channel a value is checked against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Input,
    Output,
    Event,
}

/// Deserializes and validates a value, then checks its shape (see [`same_shape`]).
pub fn parse<T: DeserializeOwned + Serialize + Validate>(value: Value) -> Result<T, String> {
    let parsed: T = serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
    let shape = serde_json::to_value(&parsed).map_err(|error| error.to_string())?;
    if !same_shape(&shape, &value) {
        return Err("expected an object or an array where the schema has one".into());
    }
    parsed.validate()?;
    Ok(parsed)
}

/// serde reads a struct from a JSON array too (`["m1"]` as `{ "id": "m1" }`), which zod never
/// accepts. So the parsed value is serialized again and walked together with the input: where
/// the parsed shape has an object the input must have an object, and where it has an array the
/// input must have an array. Only keys present in both are followed, since defaults and skipped
/// `None`s add or drop keys. This covers nested and untagged types alike.
fn same_shape(shape: &Value, input: &Value) -> bool {
    match (shape, input) {
        (Value::Object(shape), Value::Object(input)) => shape
            .iter()
            .all(|(key, shape)| input.get(key).is_none_or(|input| same_shape(shape, input))),
        (Value::Object(_), _) => false,
        (Value::Array(shape), Value::Array(input)) => shape
            .iter()
            .zip(input)
            .all(|(shape, input)| same_shape(shape, input)),
        (Value::Array(_), _) => false,
        _ => true,
    }
}

/// [`parse`] for a handler's input: a refusal is INVALID_INPUT, like the Electron dispatcher.
pub fn parse_input<T: DeserializeOwned + Serialize + Validate>(
    value: Value,
) -> Result<T, ExposedError> {
    parse(value).map_err(|_| ExposedError::new(IpcErrorCode::InvalidInput, "Invalid input"))
}

/// `z.undefined()` (`none` in contract.ts): only a value that was not sent at all.
fn none(value: Option<&Value>) -> Result<(), String> {
    match value {
        None => Ok(()),
        Some(_) => Err("expected no value".into()),
    }
}

fn required<T: DeserializeOwned + Serialize + Validate>(
    value: Option<&Value>,
) -> Result<(), String> {
    let value = value.ok_or("a value is required")?;
    parse::<T>(value.clone()).map(drop)
}

/// `schema.optional()`: not sent, or a valid value (`null` is not "not sent").
fn optional<T: DeserializeOwned + Serialize + Validate>(
    value: Option<&Value>,
) -> Result<(), String> {
    value.map_or(Ok(()), |value| parse::<T>(value.clone()).map(drop))
}

/// Verdict of the ported contract for one value; `None` when `channel` is not ported (yet).
/// `value: None` stands for `undefined`.
pub fn check(
    channel: &str,
    direction: Direction,
    value: Option<&Value>,
) -> Option<Result<(), String>> {
    use Direction::{Event, Input, Output};
    let verdict = match (channel, direction) {
        ("app:get-info", Input) => none(value),
        ("app:get-info", Output) => required::<app::AppInfo>(value),
        ("app:get-runtime", Input) => none(value),
        ("app:get-runtime", Output) => required::<app::Runtime>(value),
        ("app:open-control-center", Input) => optional::<app::OpenControlCenterInput>(value),
        ("app:open-control-center", Output) => required::<Ack>(value),
        ("app:hide-notch", Input) => none(value),
        ("app:hide-notch", Output) => required::<Ack>(value),
        ("settings:get", Input) => none(value),
        ("settings:get", Output) => required::<settings::Settings>(value),
        ("settings:update", Input) => required::<settings::SettingsPatch>(value),
        ("settings:update", Output) => required::<settings::Settings>(value),
        ("notch:get-mode", Input) => none(value),
        ("notch:get-mode", Output) => required::<notch::NotchMode>(value),
        ("notch:request", Input) => required::<notch::RequestInput>(value),
        ("notch:request", Output) => required::<Ack>(value),
        ("notch:pointer", Input) => required::<notch::PointerInput>(value),
        ("notch:pointer", Output) => required::<Ack>(value),
        ("notch:settled", Input) => none(value),
        ("notch:settled", Output) => required::<Ack>(value),
        ("notch:open-integration", Input) => required::<notch::OpenIntegrationInput>(value),
        ("notch:open-integration", Output) => required::<Ack>(value),
        ("notch:back", Input) => none(value),
        ("notch:back", Output) => required::<Ack>(value),
        ("notch:capsule-rect", Input) => required::<notch::CapsuleRectInput>(value),
        ("notch:capsule-rect", Output) => required::<Ack>(value),
        ("usage:summary", Input) => required::<usage::UsageSummaryInput>(value),
        ("usage:summary", Output) => required::<usage::UsageSummary>(value),
        ("apps:open", Input) => required::<apps::OpenAppInput>(value),
        ("apps:open", Output) => required::<apps::OpenAppResult>(value),
        (
            "claude:get-state"
            | "claude:focus-app"
            | "claude:accounts"
            | "claude:test-connection"
            | "claude:rotate-token"
            | "claude:rotate-port"
            | "claude:get-questions",
            Input,
        ) => none(value),
        ("claude:get-state", Output) => required::<claude::ClaudeState>(value),
        ("claude:hooks-preview", Input) => required::<claude::HooksPreviewInput>(value),
        ("claude:hooks-install" | "claude:hooks-uninstall", Input) => {
            required::<claude::AccountInput>(value)
        }
        ("claude:account-add", Input) => required::<claude::AccountAddInput>(value),
        ("claude:accounts" | "claude:account-add", Output) => {
            required::<claude::ClaudeAccounts>(value)
        }
        ("claude:decide", Input) => required::<claude::DecideInput>(value),
        ("claude:dismiss-session", Input) => required::<claude::DismissSessionInput>(value),
        ("claude:answer", Input) => required::<claude::AnswerInput>(value),
        ("claude:answer", Output) => required::<claude::AnswerOutcome>(value),
        ("claude:release-question", Input) => required::<claude::ReleaseQuestionInput>(value),
        (
            "claude:decide"
            | "claude:focus-app"
            | "claude:dismiss-session"
            | "claude:release-question",
            Output,
        ) => required::<Ack>(value),
        ("claude:hooks-preview", Output) => required::<claude::HooksPreview>(value),
        ("claude:hooks-install" | "claude:hooks-uninstall", Output) => {
            required::<claude::HooksWrite>(value)
        }
        ("claude:test-connection", Output) => required::<claude::TestConnectionResult>(value),
        ("claude:rotate-token" | "claude:rotate-port", Output) => {
            required::<claude::RotateOutcome>(value)
        }
        ("claude:get-questions", Output) => required::<claude::PendingQuestions>(value),
        ("code-review:get-state" | "code-review:refresh", Input) => none(value),
        ("code-review:get-state", Output) => required::<code_review::CodeReviewState>(value),
        ("code-review:open-profile", Input) => required::<code_review::OpenProfileInput>(value),
        ("code-review:open-alert", Input) => required::<code_review::OpenAlertInput>(value),
        ("code-review:open-profile" | "code-review:open-alert", Output) => {
            required::<code_review::OpenedResult>(value)
        }
        ("code-review:set-token", Input) => required::<code_review::SetTokenInput>(value),
        ("code-review:set-token", Output) => required::<code_review::SetTokenResult>(value),
        ("code-review:clear", Input) => required::<code_review::ClearInput>(value),
        ("code-review:view", Input) => required::<code_review::CodeReviewViewInput>(value),
        ("code-review:contributions", Input) => required::<code_review::ContributionsInput>(value),
        ("code-review:contributions", Output) => {
            required::<code_review::ContributionsResult>(value)
        }
        ("code-review:refresh" | "code-review:clear" | "code-review:view", Output) => {
            required::<Ack>(value)
        }
        (
            "redmine:get-state" | "redmine:issues" | "redmine:activities" | "redmine:summary"
            | "redmine:refresh" | "redmine:clear",
            Input,
        ) => none(value),
        ("redmine:get-state", Output) => required::<redmine::RedmineState>(value),
        ("redmine:issues", Output) => required::<redmine::RedmineIssueList>(value),
        ("redmine:issue" | "redmine:find-issue" | "redmine:open", Input) => {
            required::<redmine::RedmineIdInput>(value)
        }
        ("redmine:find-issue", Output) => required::<redmine::RedmineFindIssueResult>(value),
        ("redmine:issue", Output) => required::<redmine::RedmineIssueDetail>(value),
        ("redmine:activities", Output) => required::<Vec<redmine::RedmineActivity>>(value),
        ("redmine:update-issue", Input) => required::<redmine::UpdateIssueInput>(value),
        ("redmine:log-time", Input) => required::<redmine::LogTimeInput>(value),
        ("redmine:update-issue" | "redmine:log-time", Output) => {
            required::<redmine::RedmineWriteResult>(value)
        }
        ("redmine:summary", Output) => required::<redmine::RedmineSummaryResult>(value),
        ("redmine:view", Input) => required::<redmine::RedmineViewInput>(value),
        ("redmine:set-key", Input) => required::<redmine::SetKeyInput>(value),
        ("redmine:set-key", Output) => required::<redmine::RedmineSetKeyResult>(value),
        ("redmine:view" | "redmine:refresh" | "redmine:open" | "redmine:clear", Output) => {
            required::<Ack>(value)
        }
        (
            "gmail:get-state"
            | "gmail:recent"
            | "gmail:refresh"
            | "gmail:close-message"
            | "gmail:sign-in"
            | "gmail:cancel-sign-in"
            | "gmail:sign-out"
            | "gmail:pick-client-file",
            Input,
        ) => none(value),
        ("gmail:get-state", Output) => required::<gmail::GmailState>(value),
        ("gmail:recent", Output) => required::<gmail::GmailRecent>(value),
        ("gmail:view", Input) => required::<gmail::GmailViewInput>(value),
        ("gmail:open", Input) => required::<gmail::GmailOpenInput>(value),
        ("gmail:message" | "gmail:mark-read" | "gmail:delete", Input) => {
            required::<gmail::GmailIdInput>(value)
        }
        ("gmail:message", Output) => required::<gmail::GmailMessageDetail>(value),
        ("gmail:open-link", Input) => required::<gmail::GmailOpenLinkInput>(value),
        ("gmail:sign-in", Output) => required::<gmail::GmailSignInResult>(value),
        ("gmail:pick-client-file", Output) => required::<Option<gmail::GmailClientFile>>(value),
        (
            "gmail:view"
            | "gmail:refresh"
            | "gmail:open"
            | "gmail:mark-read"
            | "gmail:delete"
            | "gmail:open-link"
            | "gmail:close-message"
            | "gmail:cancel-sign-in"
            | "gmail:sign-out",
            Output,
        ) => required::<Ack>(value),
        ("notes:list", Input) | ("reminders:list", Input) => none(value),
        ("notes:list", Output) => required::<notes::NotesSnapshot>(value),
        ("notes:create", Input) => required::<notes::CreateNoteInput>(value),
        ("notes:update", Input) => required::<notes::UpdateNoteInput>(value),
        ("notes:pin", Input) => required::<notes::PinNoteInput>(value),
        ("notes:delete" | "notes:restore" | "notes:copy", Input) => {
            required::<notes::NoteIdInput>(value)
        }
        (
            "notes:create" | "notes:update" | "notes:pin" | "notes:delete" | "notes:restore",
            Output,
        ) => required::<notes::Note>(value),
        ("notes:copy", Output) => required::<Ack>(value),
        ("reminders:list", Output) => required::<reminders::RemindersSnapshot>(value),
        ("reminders:create", Input) => required::<reminders::CreateReminderInput>(value),
        ("reminders:update", Input) => required::<reminders::UpdateReminderInput>(value),
        ("reminders:snooze" | "reminders:complete" | "reminders:delete", Input) => {
            required::<reminders::ReminderIdInput>(value)
        }
        (
            "reminders:create" | "reminders:update" | "reminders:snooze" | "reminders:complete",
            Output,
        ) => required::<reminders::Reminder>(value),
        ("reminders:delete", Output) => required::<Ack>(value),
        ("work-log:list" | "work-log:claude-available", Input) => none(value),
        ("work-log:list", Output) => required::<work_log::WorkLogSnapshot>(value),
        ("work-log:set-invoiced", Input) => required::<work_log::WorkLogSetInvoicedInput>(value),
        ("work-log:delete" | "work-log:restore" | "work-log:summarize", Input) => {
            required::<work_log::WorkLogSessionInput>(value)
        }
        ("work-log:copy", Input) => required::<work_log::WorkLogCopyInput>(value),
        (
            "work-log:set-invoiced"
            | "work-log:delete"
            | "work-log:restore"
            | "work-log:copy"
            | "work-log:summarize",
            Output,
        ) => required::<Ack>(value),
        ("work-log:claude-available", Output) => {
            required::<work_log::WorkLogClaudeAvailable>(value)
        }
        ("notch:mode-changed", Event) => required::<notch::NotchMode>(value),
        ("notch:mail-alert" | "notch:review-alert" | "notch:redmine-alert", Event) => {
            required::<bool>(value)
        }
        ("settings:changed", Event) => required::<settings::Settings>(value),
        ("system:metrics", Event) => required::<system::SystemMetrics>(value),
        ("notes:changed", Event) => required::<notes::NotesSnapshot>(value),
        ("work-log:changed", Event) => required::<work_log::WorkLogSnapshot>(value),
        ("reminders:changed", Event) => required::<reminders::RemindersSnapshot>(value),
        ("reminders:fired", Event) => required::<reminders::ReminderFired>(value),
        ("claude:state-changed", Event) => required::<claude::ClaudeState>(value),
        ("claude:questions", Event) => required::<claude::PendingQuestions>(value),
        ("code-review:state", Event) => required::<code_review::CodeReviewState>(value),
        ("code-review:alert", Event) => required::<code_review::CodeReviewAlert>(value),
        ("code-review:contributions-changed", Event) => {
            required::<code_review::ContributionsChanged>(value)
        }
        ("redmine:state", Event) => required::<redmine::RedmineState>(value),
        ("redmine:summary-changed", Event) => required::<redmine::RedmineSummaryChanged>(value),
        ("redmine:alert", Event) => required::<redmine::RedmineAlert>(value),
        ("gmail:state", Event) => required::<gmail::GmailState>(value),
        ("gmail:new-mail", Event) => required::<gmail::GmailNewMail>(value),
        _ => return None,
    };
    Some(verdict)
}

/// For `#[serde(default, deserialize_with = "present")]` on an `Option` field: zod's
/// `.optional()` allows a missing key but not `null` (plain serde would map both to `None`).
pub(crate) fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// For `#[serde(deserialize_with = "nullable")]` on an `Option` field: zod's `.nullable()`
/// requires the key (plain serde would let it be missing).
pub(crate) fn nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

/// String length as zod measures it for `.min()`/`.max()`: Unicode code points (zod 4 counts
/// them, not UTF-16 units; the astral-emoji cases in `contract-cases.json` pin it).
pub(crate) fn length(value: &str) -> usize {
    value.chars().count()
}

/// `Number.MAX_SAFE_INTEGER`: `z.int()` refuses anything larger.
pub(crate) const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// `z.string().max(max)` on the field `name`.
pub(crate) fn max_len(name: &str, value: &str, max: usize) -> Result<(), String> {
    if length(value) <= max {
        Ok(())
    } else {
        Err(format!("{name} must have at most {max} characters"))
    }
}

/// `z.string().min(min).max(max)` on the field `name`.
pub(crate) fn len_in(name: &str, value: &str, min: usize, max: usize) -> Result<(), String> {
    if (min..=max).contains(&length(value)) {
        Ok(())
    } else {
        Err(format!("{name} must have {min} to {max} characters"))
    }
}

/// `z.int().min(min)` on a field deserialized as an unsigned integer (also `<= MAX_SAFE_INTEGER`).
pub(crate) fn safe_int_min(name: &str, value: u64, min: u64) -> Result<(), String> {
    if (min..=MAX_SAFE_INTEGER).contains(&value) {
        Ok(())
    } else {
        Err(format!("{name} must be an integer of at least {min}"))
    }
}

/// `.max(max)` on the array `name`.
pub(crate) fn at_most(name: &str, len: usize, max: usize) -> Result<(), String> {
    if len <= max {
        Ok(())
    } else {
        Err(format!("{name} must have at most {max} items"))
    }
}

/// `z.int().min(min).max(max)` on a field already deserialized as an unsigned integer.
pub(crate) fn int_in(name: &str, value: u32, min: u32, max: u32) -> Result<(), String> {
    if (min..=max).contains(&value) {
        Ok(())
    } else {
        Err(format!("{name} must be between {min} and {max}"))
    }
}

#[cfg(test)]
mod shape_tests {
    use serde_json::{json, Value};

    use super::claude::HooksWrite;
    use super::gmail::{GmailIdInput, GmailMessageDetail};
    use super::parse;

    fn detail(links: Value) -> Value {
        json!({
            "id": "m1", "threadId": "t1", "from": "Ana", "fromAddress": "ana@example.com",
            "subject": "Hola", "date": "2026-11-11T10:00:00.000Z", "unread": true,
            "body": "texto", "truncated": false, "links": links, "attachments": 0
        })
    }

    #[test]
    fn an_array_in_place_of_an_object_is_refused_where_serde_alone_takes_it() {
        assert!(serde_json::from_value::<GmailIdInput>(json!(["m1"])).is_ok());
        assert!(parse::<GmailIdInput>(json!(["m1"])).is_err());
        assert!(parse::<GmailIdInput>(json!({ "id": "m1" })).is_ok());
    }

    #[test]
    fn the_shape_walk_reaches_nested_objects() {
        let good = detail(json!([{ "text": "Docs", "url": "https://example.com/docs" }]));
        assert!(parse::<GmailMessageDetail>(good).is_ok());
        let nested = detail(json!([["Docs", "https://example.com/docs"]]));
        assert!(serde_json::from_value::<GmailMessageDetail>(nested.clone()).is_ok());
        assert!(parse::<GmailMessageDetail>(nested).is_err());
    }

    #[test]
    fn the_shape_walk_reaches_untagged_variants() {
        let good = json!({ "ok": true, "changed": true, "diff": [{ "kind": "add", "text": "x" }] });
        assert!(parse::<HooksWrite>(good).is_ok());
        let nested = json!({ "ok": true, "changed": true, "diff": [["add", "x"]] });
        assert!(serde_json::from_value::<HooksWrite>(nested.clone()).is_ok());
        assert!(parse::<HooksWrite>(nested).is_err());
        assert!(parse::<HooksWrite>(json!([false, "invalid-json"])).is_err());
    }
}
