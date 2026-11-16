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

pub mod app;
pub mod apps;
pub mod claude;
pub mod notch;
pub mod notes;
pub mod reminders;
pub mod settings;
pub mod system;
pub mod text;
pub mod usage;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer};
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

/// Deserializes and validates a value.
pub fn parse<T: DeserializeOwned + Validate>(value: Value) -> Result<T, String> {
    let parsed: T = serde_json::from_value(value).map_err(|error| error.to_string())?;
    parsed.validate()?;
    Ok(parsed)
}

/// [`parse`] for a handler's input: a refusal is INVALID_INPUT, like the Electron dispatcher.
pub fn parse_input<T: DeserializeOwned + Validate>(value: Value) -> Result<T, ExposedError> {
    parse(value).map_err(|_| ExposedError::new(IpcErrorCode::InvalidInput, "Invalid input"))
}

/// `z.undefined()` (`none` in contract.ts): only a value that was not sent at all.
fn none(value: Option<&Value>) -> Result<(), String> {
    match value {
        None => Ok(()),
        Some(_) => Err("expected no value".into()),
    }
}

fn required<T: DeserializeOwned + Validate>(value: Option<&Value>) -> Result<(), String> {
    let value = value.ok_or("a value is required")?;
    parse::<T>(value.clone()).map(drop)
}

/// `schema.optional()`: not sent, or a valid value (`null` is not "not sent").
fn optional<T: DeserializeOwned + Validate>(value: Option<&Value>) -> Result<(), String> {
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
            | "claude:hooks-preview"
            | "claude:hooks-install"
            | "claude:hooks-uninstall"
            | "claude:test-connection"
            | "claude:rotate-token"
            | "claude:rotate-port"
            | "claude:get-questions",
            Input,
        ) => none(value),
        ("claude:get-state", Output) => required::<claude::ClaudeState>(value),
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
        ("system:view", Input) => required::<system::ViewInput>(value),
        ("system:view", Output) => required::<Ack>(value),
        ("system:kill-process", Input) => required::<system::KillInput>(value),
        ("system:kill-process", Output) => required::<system::KillResult>(value),
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
        ("notch:mode-changed", Event) => required::<notch::NotchMode>(value),
        ("notch:mail-alert" | "notch:review-alert" | "notch:redmine-alert", Event) => {
            required::<bool>(value)
        }
        ("settings:changed", Event) => required::<settings::Settings>(value),
        ("system:metrics", Event) => required::<system::SystemMetrics>(value),
        ("system:processes", Event) => required::<system::ProcessList>(value),
        ("notes:changed", Event) => required::<notes::NotesSnapshot>(value),
        ("reminders:changed", Event) => required::<reminders::RemindersSnapshot>(value),
        ("reminders:fired", Event) => required::<reminders::ReminderFired>(value),
        ("claude:state-changed", Event) => required::<claude::ClaudeState>(value),
        ("claude:questions", Event) => required::<claude::PendingQuestions>(value),
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

/// `z.int().min(min).max(max)` on a field already deserialized as an unsigned integer.
pub(crate) fn int_in(name: &str, value: u32, min: u32, max: u32) -> Result<(), String> {
    if (min..=max).contains(&value) {
        Ok(())
    } else {
        Err(format!("{name} must be between {min} and {max}"))
    }
}
