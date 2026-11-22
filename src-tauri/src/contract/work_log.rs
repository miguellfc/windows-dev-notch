//! `work-log:*` channels and the `work-log:changed` event (`src/shared/work-log/schema.ts`).

use serde::{Deserialize, Serialize};

use super::{len_in, max_len, nullable, present, Validate};

/// Longest subtask title the view carries (`WORK_LOG_SUBTASK_TITLE_MAX`).
pub const WORK_LOG_SUBTASK_TITLE_MAX: usize = 300;
/// Longest session or account id (`z.string().min(1).max(256)`).
const ID_MAX: usize = 256;
const PROJECT_MAX: usize = 512;
const TITLE_MAX: usize = 512;
/// Highest subtask position `work-log:copy` accepts.
const SUBTASK_INDEX_MAX: u64 = 1000;

string_enum! {
    /// `workLogSubtaskViewSchema.status`.
    pub enum WorkLogSubtaskStatus {
        Done = "done",
        Pending = "pending",
    }
}

string_enum! {
    /// `workLogStatusSchema`: ticking, paused by idleness, being summarized, waiting for a
    /// summary, or ready.
    pub enum WorkLogStatus {
        Running = "running",
        Paused = "paused",
        Summarizing = "summarizing",
        Unsummarized = "unsummarized",
        Ready = "ready",
    }
}

/// `z.number().nonnegative()` on the field `name`.
fn non_negative(name: &str, value: f64) -> Result<(), String> {
    // `!(a >= b)` also refuses NaN, like zod.
    if value >= 0.0 {
        Ok(())
    } else {
        Err(format!("{name} must not be negative"))
    }
}

/// `workLogSubtaskViewSchema`: a `done` subtask carries both durations.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkLogSubtaskView {
    pub title: String,
    pub status: WorkLogSubtaskStatus,
    #[serde(deserialize_with = "nullable")]
    pub claude_ms: Option<f64>,
    #[serde(deserialize_with = "nullable")]
    pub total_ms: Option<f64>,
}

impl Validate for WorkLogSubtaskView {
    fn validate(&self) -> Result<(), String> {
        len_in("title", &self.title, 1, WORK_LOG_SUBTASK_TITLE_MAX)?;
        if let Some(ms) = self.claude_ms {
            non_negative("claudeMs", ms)?;
        }
        if let Some(ms) = self.total_ms {
            non_negative("totalMs", ms)?;
        }
        if self.status == WorkLogSubtaskStatus::Done
            && (self.claude_ms.is_none() || self.total_ms.is_none())
        {
            return Err("A done subtask needs both durations".into());
        }
        Ok(())
    }
}

/// `workLogLiveSchema`: what the view needs to draw a running or paused session's clock.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkLogLive {
    pub last_event_at: f64,
    pub excess_ms: f64,
    pub turn_open: bool,
}

impl Validate for WorkLogLive {
    fn validate(&self) -> Result<(), String> {
        non_negative("lastEventAt", self.last_event_at)?;
        non_negative("excessMs", self.excess_ms)
    }
}

/// `workLogEntryViewSchema`: a session as the work log shows it. `live` only comes with a running
/// or paused one.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkLogEntryView {
    pub session_id: String,
    pub account_id: String,
    pub project: String,
    pub status: WorkLogStatus,
    pub invoiced: bool,
    pub started_at: f64,
    #[serde(deserialize_with = "nullable")]
    pub ended_at: Option<f64>,
    pub claude_ms: f64,
    pub total_ms: f64,
    #[serde(deserialize_with = "nullable")]
    pub live: Option<WorkLogLive>,
    pub title: String,
    pub subtasks: Vec<WorkLogSubtaskView>,
}

impl Validate for WorkLogEntryView {
    fn validate(&self) -> Result<(), String> {
        len_in("sessionId", &self.session_id, 1, ID_MAX)?;
        len_in("accountId", &self.account_id, 1, ID_MAX)?;
        max_len("project", &self.project, PROJECT_MAX)?;
        max_len("title", &self.title, TITLE_MAX)?;
        non_negative("startedAt", self.started_at)?;
        if let Some(ended_at) = self.ended_at {
            non_negative("endedAt", ended_at)?;
        }
        non_negative("claudeMs", self.claude_ms)?;
        non_negative("totalMs", self.total_ms)?;
        if let Some(live) = &self.live {
            live.validate()?;
            if !matches!(self.status, WorkLogStatus::Running | WorkLogStatus::Paused) {
                return Err("live only comes with a running or paused entry".into());
            }
        }
        self.subtasks.iter().try_for_each(Validate::validate)
    }
}

/// `workLogSnapshotSchema`: output of `work-log:list` and payload of `work-log:changed`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkLogSnapshot {
    pub entries: Vec<WorkLogEntryView>,
    pub idle_pause_ms: f64,
}

impl Validate for WorkLogSnapshot {
    fn validate(&self) -> Result<(), String> {
        self.entries.iter().try_for_each(Validate::validate)?;
        non_negative("idlePauseMs", self.idle_pause_ms)
    }
}

/// `workLogSessionInputSchema`: input of `work-log:delete`, `work-log:restore` and
/// `work-log:summarize`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkLogSessionInput {
    pub session_id: String,
}

impl Validate for WorkLogSessionInput {
    fn validate(&self) -> Result<(), String> {
        len_in("sessionId", &self.session_id, 1, ID_MAX)
    }
}

/// `workLogSetInvoicedInputSchema`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkLogSetInvoicedInput {
    pub session_id: String,
    pub invoiced: bool,
}

impl Validate for WorkLogSetInvoicedInput {
    fn validate(&self) -> Result<(), String> {
        len_in("sessionId", &self.session_id, 1, ID_MAX)
    }
}

/// `workLogCopyInputSchema`: `subtask` is the position of the subtask to copy; without it, the
/// whole session.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkLogCopyInput {
    pub session_id: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub subtask: Option<u64>,
}

impl Validate for WorkLogCopyInput {
    fn validate(&self) -> Result<(), String> {
        len_in("sessionId", &self.session_id, 1, ID_MAX)?;
        match self.subtask {
            Some(index) if index > SUBTASK_INDEX_MAX => {
                Err(format!("subtask must be at most {SUBTASK_INDEX_MAX}"))
            }
            _ => Ok(()),
        }
    }
}

/// `workLogClaudeAvailableSchema`: output of `work-log:claude-available`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkLogClaudeAvailable {
    pub found: bool,
}

impl Validate for WorkLogClaudeAvailable {}

input_entry!(WorkLogSessionInput, WorkLogSetInvoicedInput, WorkLogCopyInput);
