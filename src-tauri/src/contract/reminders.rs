//! `reminders:*` channels and events (`src/shared/reminders/schema.ts`,
//! `remindersSnapshotSchema` in `src/shared/ipc/contract.ts`).

use serde::{Deserialize, Deserializer, Serialize};

use super::text::{datetime, is_local_time, trimmed_text, uuid};
use super::{length, nullable, present, StoreNotice, Validate, MAX_SAFE_INTEGER};

pub const REMINDER_TEXT_MAX: usize = 200;
pub const REMINDERS_ACTIVE_MAX: usize = 500;
/// Longest free text `reminders:create` parses (`{ input }`).
pub const REMINDER_INPUT_MAX: usize = 400;

/// INVALID_INPUT message for a dueAt that is not in the future; the renderer maps it.
pub const REMINDER_PAST_MESSAGE: &str = "dueAt must be in the future";
/// INVALID_INPUT message for acting on a reminder that is already done; the renderer maps it.
pub const REMINDER_DONE_MESSAGE: &str = "Reminder is already done";
/// INVALID_INPUT message when creating would exceed [`REMINDERS_ACTIVE_MAX`] (literally "limit").
pub const REMINDER_LIMIT_MESSAGE: &str = "limit";
/// NOT_FOUND message for an unknown reminder id.
pub const REMINDER_NOT_FOUND_MESSAGE: &str = "Reminder not found";
/// INVALID_INPUT message for a mutated reminder that fails `reminderSchema`.
pub const INVALID_REMINDER_MESSAGE: &str = "Invalid reminder";
/// READ_ONLY message when `reminders.json` comes from a newer app version or could not be read.
pub const REMINDERS_READ_ONLY_MESSAGE: &str =
    "Reminders are read-only in this session; changes cannot be saved";
/// The name the reminders [`JsonStore`](crate::services::json_store::JsonStore) is built with:
/// it yields [`REMINDERS_READ_ONLY_MESSAGE`].
pub const REMINDERS_STORE_NAME: &str = "Reminders";

/// `reminderTextSchema`: like a note's text but at most 200 code points and single-line (line
/// breaks and tabs are control characters here; only ZWJ is allowed). Holds the trimmed text.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(transparent)]
pub struct ReminderText(String);

impl ReminderText {
    pub fn new(raw: &str) -> Result<Self, String> {
        trimmed_text(raw, REMINDER_TEXT_MAX, &[]).map(Self)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for ReminderText {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::new(&raw).map_err(serde::de::Error::custom)
    }
}

impl Validate for ReminderText {}

string_enum! {
    /// `reminderRepeatSchema`.
    pub enum ReminderRepeat {
        None = "none",
        Daily = "daily",
        Weekdays = "weekdays",
    }
}

string_enum! {
    /// `reminderStateSchema`.
    pub enum ReminderState {
        Pending = "pending",
        Due = "due",
        Missed = "missed",
        Done = "done",
    }
}

string_enum! {
    /// `reminderPresetSchema`.
    pub enum ReminderPreset {
        FifteenMinutes = "15m",
        OneHour = "1h",
        TomorrowAtNine = "tomorrow-9",
    }
}

/// `reminderSchema`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Reminder {
    pub id: String,
    pub text: ReminderText,
    pub due_at: String,
    pub repeat: ReminderRepeat,
    /// Wall-clock `HH:mm`; required for repeating reminders.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub local_time: Option<String>,
    pub state: ReminderState,
    pub created_at: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub completed_at: Option<String>,
}

impl Validate for Reminder {
    fn validate(&self) -> Result<(), String> {
        uuid("id", &self.id)?;
        datetime("dueAt", &self.due_at)?;
        datetime("createdAt", &self.created_at)?;
        if let Some(completed_at) = &self.completed_at {
            datetime("completedAt", completed_at)?;
        }
        match &self.local_time {
            Some(time) if !is_local_time(time) => Err("Invalid HH:mm time".into()),
            None if self.repeat != ReminderRepeat::None => {
                Err("localTime is required for repeating reminders".into())
            }
            _ => Ok(()),
        }
    }
}

/// `remindersFileSchema`: the whole `reminders.json` document (`{version: 1, reminders: [...]}`).
/// Its default is the empty list a missing or quarantined file starts from.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RemindersFile {
    pub version: u8,
    pub reminders: Vec<Reminder>,
}

impl RemindersFile {
    pub const VERSION: u8 = 1;

    pub fn new(reminders: Vec<Reminder>) -> Self {
        Self {
            version: Self::VERSION,
            reminders,
        }
    }
}

impl Default for RemindersFile {
    fn default() -> Self {
        Self::new(Vec::new())
    }
}

impl Validate for RemindersFile {
    fn validate(&self) -> Result<(), String> {
        if self.version != Self::VERSION {
            return Err("version must be 1".into());
        }
        self.reminders.iter().try_for_each(Validate::validate)
    }
}

/// `remindersSnapshotSchema`: output of `reminders:list` and payload of `reminders:changed`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RemindersSnapshot {
    pub reminders: Vec<Reminder>,
    #[serde(deserialize_with = "nullable")]
    pub notice: Option<StoreNotice>,
}

impl Validate for RemindersSnapshot {
    fn validate(&self) -> Result<(), String> {
        self.reminders.iter().try_for_each(Validate::validate)
    }
}

/// `{ input }`: free text the service parses ("en 10 min café"); only its length is checked here.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ParseReminderInput {
    pub input: String,
}

/// `{ text, preset }`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PresetReminderInput {
    pub text: ReminderText,
    pub preset: ReminderPreset,
}

/// `{ text, dueAt, repeat }`, the notch form: for repeating reminders only its local HH:mm counts.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ExplicitReminderInput {
    pub text: ReminderText,
    pub due_at: String,
    pub repeat: ReminderRepeat,
}

/// `createReminderInputSchema`: a union of three strict objects. Their required keys differ, so
/// the shape alone picks the member and the refinements run on that member only, as in zod.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(untagged)]
pub enum CreateReminderInput {
    Parse(ParseReminderInput),
    Preset(PresetReminderInput),
    Explicit(ExplicitReminderInput),
}

impl Validate for CreateReminderInput {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::Parse(parse) if length(&parse.input) > REMINDER_INPUT_MAX => Err(format!(
                "input must be at most {REMINDER_INPUT_MAX} characters"
            )),
            Self::Explicit(explicit) => datetime("dueAt", &explicit.due_at),
            _ => Ok(()),
        }
    }
}

/// `updateReminderInputSchema`: the id plus at least one field to change.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UpdateReminderInput {
    pub id: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub text: Option<ReminderText>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub due_at: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub repeat: Option<ReminderRepeat>,
}

impl Validate for UpdateReminderInput {
    fn validate(&self) -> Result<(), String> {
        uuid("id", &self.id)?;
        if let Some(due_at) = &self.due_at {
            datetime("dueAt", due_at)?;
        }
        if self.text.is_none() && self.due_at.is_none() && self.repeat.is_none() {
            return Err("Update needs at least one field besides id".into());
        }
        Ok(())
    }
}

/// `{ id }` of `reminders:snooze`, `reminders:complete` and `reminders:delete`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReminderIdInput {
    pub id: String,
}

impl Validate for ReminderIdInput {
    fn validate(&self) -> Result<(), String> {
        uuid("id", &self.id)
    }
}

/// Payload of `reminders:fired`: how many reminders are newly due (or were missed at startup).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReminderFired {
    pub count: u64,
}

impl Validate for ReminderFired {
    fn validate(&self) -> Result<(), String> {
        if (1..=MAX_SAFE_INTEGER).contains(&self.count) {
            Ok(())
        } else {
            Err("count must be a positive safe integer".into())
        }
    }
}

input_entry!(CreateReminderInput, UpdateReminderInput, ReminderIdInput);

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::{check, Direction};

    #[test]
    fn a_serialized_reminder_omits_absent_optionals_and_passes_its_contract() {
        let reminder = Reminder {
            id: "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b".into(),
            text: ReminderText::new("  Llamar  ").unwrap(),
            due_at: "2026-11-15T09:30:00.000Z".into(),
            repeat: ReminderRepeat::None,
            local_time: None,
            state: ReminderState::Pending,
            created_at: "2026-11-15T09:00:00.000Z".into(),
            completed_at: None,
        };
        let value = serde_json::to_value(&reminder).unwrap();
        assert_eq!(value["text"], "Llamar");
        assert!(value.get("localTime").is_none() && value.get("completedAt").is_none());
        assert_eq!(
            check("reminders:create", Direction::Output, Some(&value)),
            Some(Ok(()))
        );
    }

    #[test]
    fn create_input_picks_the_member_by_shape() {
        let input =
            CreateReminderInput::from_input(serde_json::json!({ "text": " a ", "preset": "1h" }));
        assert!(
            matches!(input, Ok(CreateReminderInput::Preset(preset)) if preset.text.as_str() == "a")
        );
    }
}
