//! `notes:*` channels and the `notes:changed` event (`src/shared/notes/schema.ts`,
//! `notesSnapshotSchema` in `src/shared/ipc/contract.ts`).

use serde::{Deserialize, Deserializer, Serialize};

use super::text::{datetime, trimmed_text, uuid};
use super::{nullable, StoreNotice, Validate};

pub const NOTE_TEXT_MAX: usize = 2000;
pub const NOTES_MAX: usize = 500;

/// INVALID_INPUT message when creating or restoring would exceed [`NOTES_MAX`]; the notch maps it
/// to its own copy.
pub const NOTE_LIMIT_MESSAGE: &str = "Note limit reached (500)";
/// INVALID_INPUT message for a text that fails [`NoteText`] (`parseText` in notes-service.ts).
pub const INVALID_NOTE_TEXT_MESSAGE: &str = "Invalid note text";
/// INVALID_INPUT message for a mutated note that fails `noteSchema`.
pub const INVALID_NOTE_MESSAGE: &str = "Invalid note";
/// NOT_FOUND message for an unknown (or no longer restorable) note id.
pub const NOTE_NOT_FOUND_MESSAGE: &str = "Note not found";
/// READ_ONLY message when `notes.json` comes from a newer app version or could not be read.
pub const NOTES_READ_ONLY_MESSAGE: &str =
    "Notes are read-only in this session; changes cannot be saved";
/// The name the notes [`JsonStore`](crate::services::json_store::JsonStore) is built with: it
/// yields [`NOTES_READ_ONLY_MESSAGE`].
pub const NOTES_STORE_NAME: &str = "Notes";

/// Characters notes allow besides ZWJ among the controls: they are multiline.
const NOTE_ALLOWED_CONTROLS: [char; 3] = ['\n', '\r', '\t'];

/// `noteTextSchema`: trimmed first, then 1..=2000 code points, no control or format character
/// except line breaks, tabs and ZWJ, and something visible. Holds the trimmed text; a value that
/// fails is refused while deserializing.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(transparent)]
pub struct NoteText(String);

impl NoteText {
    pub fn new(raw: &str) -> Result<Self, String> {
        trimmed_text(raw, NOTE_TEXT_MAX, &NOTE_ALLOWED_CONTROLS).map(Self)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl<'de> Deserialize<'de> for NoteText {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Self::new(&raw).map_err(serde::de::Error::custom)
    }
}

impl Validate for NoteText {}

/// `noteSchema`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    pub text: NoteText,
    pub pinned: bool,
    pub created_at: String,
    pub updated_at: String,
}

impl Validate for Note {
    fn validate(&self) -> Result<(), String> {
        uuid("id", &self.id)?;
        datetime("createdAt", &self.created_at)?;
        datetime("updatedAt", &self.updated_at)
    }
}

/// `notesFileSchema`: the whole `notes.json` document (`{version: 1, notes: [...]}`). Its
/// default is the empty list a missing or quarantined file starts from.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NotesFile {
    pub version: u8,
    pub notes: Vec<Note>,
}

impl NotesFile {
    pub const VERSION: u8 = 1;

    pub fn new(notes: Vec<Note>) -> Self {
        Self {
            version: Self::VERSION,
            notes,
        }
    }
}

impl Default for NotesFile {
    fn default() -> Self {
        Self::new(Vec::new())
    }
}

impl Validate for NotesFile {
    fn validate(&self) -> Result<(), String> {
        if self.version != Self::VERSION {
            return Err("version must be 1".into());
        }
        self.notes.iter().try_for_each(Validate::validate)
    }
}

/// `notesSnapshotSchema`: output of `notes:list` and payload of `notes:changed`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NotesSnapshot {
    pub notes: Vec<Note>,
    #[serde(deserialize_with = "nullable")]
    pub notice: Option<StoreNotice>,
}

impl Validate for NotesSnapshot {
    fn validate(&self) -> Result<(), String> {
        self.notes.iter().try_for_each(Validate::validate)
    }
}

/// `createNoteInputSchema`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CreateNoteInput {
    pub text: NoteText,
}

impl Validate for CreateNoteInput {}

/// `updateNoteInputSchema`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct UpdateNoteInput {
    pub id: String,
    pub text: NoteText,
}

impl Validate for UpdateNoteInput {
    fn validate(&self) -> Result<(), String> {
        uuid("id", &self.id)
    }
}

/// `pinNoteInputSchema`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PinNoteInput {
    pub id: String,
    pub pinned: bool,
}

impl Validate for PinNoteInput {
    fn validate(&self) -> Result<(), String> {
        uuid("id", &self.id)
    }
}

/// `noteIdInputSchema` (`notes:delete`, `notes:restore`, `notes:copy`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NoteIdInput {
    pub id: String,
}

impl Validate for NoteIdInput {
    fn validate(&self) -> Result<(), String> {
        uuid("id", &self.id)
    }
}

input_entry!(CreateNoteInput, UpdateNoteInput, PinNoteInput, NoteIdInput);
