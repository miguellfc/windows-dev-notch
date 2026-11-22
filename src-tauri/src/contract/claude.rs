//! `claude:*` channels and events (`claudeStateSchema`, `pendingQuestionsSchema`,
//! `claudeRotateSchema`, `claudeHooks{Preview,Write}Schema` in `src/shared/ipc/contract.ts`;
//! `questionAnswerInputSchema` and `QUESTION_LIMITS` in `src/shared/claude/questions.ts`).
//!
//! Lengths here are zod's (code points, see [`length`]). The question texts' runtime rules that
//! count UTF-16 units belong to the Claude modules, not to the contract.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use super::text::uuid;
use super::{length, nullable, present, Validate, MAX_SAFE_INTEGER};

/// `QUESTION_LIMITS` (`src/shared/claude/questions.ts`).
pub mod limits {
    pub const MIN_QUESTIONS: usize = 1;
    pub const MAX_QUESTIONS: usize = 4;
    pub const MIN_OPTIONS: usize = 2;
    pub const MAX_OPTIONS: usize = 4;
    pub const QUESTION: usize = 500;
    pub const HEADER: usize = 60;
    pub const LABEL: usize = 120;
    pub const DESCRIPTION: usize = 300;
    pub const OTHER: usize = 500;
}

/// Longest id or session id the notch may send (`z.string().min(1).max(256)`).
pub const ID_MAX: usize = 256;
/// Longest free text of one answer the notch may send (`QUESTION_LIMITS.other * 4`).
pub const ANSWER_OTHER_MAX: usize = limits::OTHER * 4;

/// NOT_FOUND message of `claude:decide` for an unknown (or already settled) request.
pub const NO_PENDING_REQUEST_MESSAGE: &str = "No pending request with that id";
/// NOT_FOUND message of `claude:dismiss-session` for a session that is not idle (or unknown).
pub const NO_IDLE_SESSION_MESSAGE: &str = "No idle session with that id";
/// INVALID_INPUT message of `claude:answer` when the answers do not fit the question.
pub const ANSWERS_DO_NOT_FIT_MESSAGE: &str = "The answers do not fit the question";

/// `z.literal(true)` / `z.literal(false)`: the discriminant of the hooks results.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BoolLiteral<const VALUE: bool>;

pub type True = BoolLiteral<true>;
pub type False = BoolLiteral<false>;

impl<const VALUE: bool> Serialize for BoolLiteral<VALUE> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bool(VALUE)
    }
}

impl<'de, const VALUE: bool> Deserialize<'de> for BoolLiteral<VALUE> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        if bool::deserialize(deserializer)? == VALUE {
            Ok(Self)
        } else {
            Err(serde::de::Error::custom(format!("expected {VALUE}")))
        }
    }
}

/// `z.string().max(max)` on the field `name`.
fn max_len(name: &str, value: &str, max: usize) -> Result<(), String> {
    if length(value) <= max {
        Ok(())
    } else {
        Err(format!("{name} must have at most {max} characters"))
    }
}

/// `z.string().min(1).max(256)` on the field `name`.
fn id(name: &str, value: &str) -> Result<(), String> {
    if (1..=ID_MAX).contains(&length(value)) {
        Ok(())
    } else {
        Err(format!("{name} must have 1 to {ID_MAX} characters"))
    }
}

/// `.min(min).max(max)` on the array `name`.
fn count(name: &str, len: usize, min: usize, max: usize) -> Result<(), String> {
    if (min..=max).contains(&len) {
        Ok(())
    } else {
        Err(format!("{name} must have {min} to {max} items"))
    }
}

string_enum! {
    /// `ClaudeConnection`.
    pub enum ClaudeConnection {
        Connected = "connected",
        WaitingForEvents = "waiting-for-events",
        NotInstalled = "not-installed",
        Error = "error",
    }
}

string_enum! {
    /// `ClaudeConnectionErrorReason`: another program holds our port.
    pub enum ClaudeConnectionErrorReason {
        PortInUse = "port-in-use",
    }
}

string_enum! {
    /// `ClaudeHooksStatus`: `unknown` when they cannot be checked (no bridge config).
    pub enum ClaudeHooksStatus {
        Installed = "installed",
        Outdated = "outdated",
        Missing = "missing",
        Unknown = "unknown",
    }
}

string_enum! {
    /// `ClaudeSessionStatus`.
    pub enum ClaudeSessionStatus {
        Working = "working",
        Waiting = "waiting",
        Done = "done",
        Error = "error",
        Idle = "idle",
    }
}

/// `ClaudeSession`. `updatedAt` is a JS millisecond timestamp (`z.number()`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ClaudeSession {
    pub id: String,
    pub name: String,
    pub status: ClaudeSessionStatus,
    pub updated_at: f64,
}

/// `PendingPermission`: a held permission request as the renderers see it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PendingPermission {
    pub id: String,
    pub session_id: String,
    pub session_name: String,
    pub tool_name: String,
    pub preview: String,
    /// The preview was cut: Allow stays disabled (decide in Claude instead).
    pub preview_truncated: bool,
    /// Length of the whole sanitised preview, before the cut.
    pub preview_length: f64,
    pub received_at: f64,
}

/// `claudeStateSchema`: output of `claude:get-state` and payload of `claude:state-changed`.
/// Never carries the bridge token; `reason` is omitted (never `null`) when absent.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ClaudeState {
    pub connection: ClaudeConnection,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub reason: Option<ClaudeConnectionErrorReason>,
    pub hooks: ClaudeHooksStatus,
    pub sessions: Vec<ClaudeSession>,
    pub pending: Vec<PendingPermission>,
}

impl Validate for ClaudeState {}

/// `QuestionOption`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

/// `ClaudeQuestion` as `pendingQuestionsSchema` checks it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ClaudeQuestion {
    pub question: String,
    pub header: String,
    pub multi_select: bool,
    pub options: Vec<QuestionOption>,
}

impl Validate for ClaudeQuestion {
    fn validate(&self) -> Result<(), String> {
        max_len("question", &self.question, limits::QUESTION)?;
        max_len("header", &self.header, limits::HEADER)?;
        count(
            "options",
            self.options.len(),
            limits::MIN_OPTIONS,
            limits::MAX_OPTIONS,
        )?;
        self.options.iter().try_for_each(|option| {
            max_len("label", &option.label, limits::LABEL)?;
            max_len("description", &option.description, limits::DESCRIPTION)
        })
    }
}

/// `PendingQuestionView`: a held `AskUserQuestion` as the notch sees it (no session id).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PendingQuestionView {
    pub id: String,
    pub project: String,
    pub questions: Vec<ClaudeQuestion>,
    pub arrived_at: f64,
}

impl Validate for PendingQuestionView {
    fn validate(&self) -> Result<(), String> {
        count(
            "questions",
            self.questions.len(),
            limits::MIN_QUESTIONS,
            limits::MAX_QUESTIONS,
        )?;
        self.questions.iter().try_for_each(Validate::validate)
    }
}

/// `pendingQuestionsSchema`: output of `claude:get-questions` and payload of `claude:questions`
/// (oldest first).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(transparent)]
pub struct PendingQuestions(pub Vec<PendingQuestionView>);

impl Validate for PendingQuestions {
    fn validate(&self) -> Result<(), String> {
        self.0.iter().try_for_each(Validate::validate)
    }
}

string_enum! {
    /// `claude:decide`'s decision.
    pub enum Decision {
        Allow = "allow",
        Deny = "deny",
    }
}

/// Input of `claude:decide`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DecideInput {
    pub request_id: String,
    pub decision: Decision,
}

impl Validate for DecideInput {
    fn validate(&self) -> Result<(), String> {
        uuid("requestId", &self.request_id)
    }
}

/// Input of `claude:dismiss-session`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DismissSessionInput {
    pub session_id: String,
}

impl Validate for DismissSessionInput {
    fn validate(&self) -> Result<(), String> {
        id("sessionId", &self.session_id)
    }
}

/// One answer of `claude:answer`, per question in order: option positions and an optional free
/// text ("Other"). Only the shape: the rules that depend on the question live in the broker.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct QuestionAnswer {
    pub selected: Vec<u64>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub other: Option<String>,
}

impl Validate for QuestionAnswer {
    fn validate(&self) -> Result<(), String> {
        if self.selected.len() > limits::MAX_OPTIONS {
            return Err(format!(
                "selected must have at most {} items",
                limits::MAX_OPTIONS
            ));
        }
        if self.selected.iter().any(|&index| index > MAX_SAFE_INTEGER) {
            return Err("selected must hold safe integers".into());
        }
        match &self.other {
            Some(other) => max_len("other", other, ANSWER_OTHER_MAX),
            None => Ok(()),
        }
    }
}

/// Input of `claude:answer` (`questionAnswerInputSchema`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AnswerInput {
    pub id: String,
    pub answers: Vec<QuestionAnswer>,
}

impl Validate for AnswerInput {
    fn validate(&self) -> Result<(), String> {
        id("id", &self.id)?;
        count(
            "answers",
            self.answers.len(),
            limits::MIN_QUESTIONS,
            limits::MAX_QUESTIONS,
        )?;
        self.answers.iter().try_for_each(Validate::validate)
    }
}

string_enum! {
    /// Output of `claude:answer`: delivered to Claude, or the question was already gone.
    pub enum AnswerOutcome {
        Sent = "sent",
        Gone = "gone",
    }
}

/// Input of `claude:release-question`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ReleaseQuestionInput {
    pub id: String,
}

impl Validate for ReleaseQuestionInput {
    fn validate(&self) -> Result<(), String> {
        id("id", &self.id)
    }
}

string_enum! {
    /// Kind of one line of the settings.json diff.
    pub enum DiffKind {
        Add = "add",
        Remove = "remove",
        Same = "same",
    }
}

/// One line of the settings.json diff (every bridge token masked).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffKind,
    pub text: String,
}

string_enum! {
    /// `z.literal('invalid-json')`: Claude's settings.json could not be parsed.
    pub enum InvalidJsonReason {
        InvalidJson = "invalid-json",
    }
}

/// `{ ok: false, reason: 'invalid-json' }`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InvalidJson {
    pub ok: False,
    pub reason: InvalidJsonReason,
}

impl InvalidJson {
    pub const VALUE: Self = Self {
        ok: BoolLiteral,
        reason: InvalidJsonReason::InvalidJson,
    };
}

/// `{ ok: true, diff }`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HooksPreviewDiff {
    pub ok: True,
    pub diff: Vec<DiffLine>,
}

/// `claudeHooksPreviewSchema`: output of `claude:hooks-preview`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(untagged)]
pub enum HooksPreview {
    Diff(HooksPreviewDiff),
    InvalidJson(InvalidJson),
}

impl Validate for HooksPreview {}

/// `{ ok: true, changed, diff, backupFile? }`; `backupFile` is the full path of the backup.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HooksWritten {
    pub ok: True,
    pub changed: bool,
    pub diff: Vec<DiffLine>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub backup_file: Option<String>,
}

/// `claudeHooksWriteSchema`: output of `claude:hooks-install` and `claude:hooks-uninstall`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(untagged)]
pub enum HooksWrite {
    Written(HooksWritten),
    InvalidJson(InvalidJson),
}

impl Validate for HooksWrite {}

/// Output of `claude:test-connection`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TestConnectionResult {
    pub ok: bool,
}

impl Validate for TestConnectionResult {}

string_enum! {
    /// What a token or port rotation did to installed hooks.
    pub enum RotateHooks {
        Reinstalled = "reinstalled",
        NotInstalled = "not-installed",
        ReinstallFailed = "reinstall-failed",
    }
}

/// `claudeRotateSchema`: output of `claude:rotate-token` and `claude:rotate-port`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RotateOutcome {
    pub hooks: RotateHooks,
}

impl Validate for RotateOutcome {}

/// Input of `claude:hooks-install` and `claude:hooks-uninstall`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AccountInput {
    pub account_id: String,
}

impl Validate for AccountInput {
    fn validate(&self) -> Result<(), String> {
        account_id(&self.account_id)
    }
}

string_enum! {
    /// `claudeHooksPreviewInputSchema.mode`: the diff of installing or of removing the hooks.
    pub enum HooksPreviewMode {
        Install = "install",
        Uninstall = "uninstall",
    }
}

/// `claudeHooksPreviewInputSchema`: input of `claude:hooks-preview`; without `mode`, install.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct HooksPreviewInput {
    pub account_id: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub mode: Option<HooksPreviewMode>,
}

impl Validate for HooksPreviewInput {
    fn validate(&self) -> Result<(), String> {
        account_id(&self.account_id)
    }
}

/// `^[a-z0-9-]{1,64}$`.
fn account_id(value: &str) -> Result<(), String> {
    if crate::claude::accounts::is_account_id(value) {
        Ok(())
    } else {
        Err("accountId must be 1 to 64 of a-z, 0-9 and -".into())
    }
}

/// Longest folder `claude:account-add` takes.
pub const ACCOUNT_DIR_MAX: usize = 1024;

/// Input of `claude:account-add`: a folder added by hand.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AccountAddInput {
    pub dir: String,
}

impl Validate for AccountAddInput {
    fn validate(&self) -> Result<(), String> {
        if (1..=ACCOUNT_DIR_MAX).contains(&length(&self.dir)) {
            Ok(())
        } else {
            Err(format!("dir must have 1 to {ACCOUNT_DIR_MAX} characters"))
        }
    }
}

string_enum! {
    /// The hooks of one account.
    pub enum AccountHookStatus {
        Installed = "installed",
        Outdated = "outdated",
        Missing = "missing",
    }
}

/// One account as the Control Center lists it. `email` and `organization` are `null` without a
/// profile.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ClaudeAccountView {
    pub id: String,
    pub dir: String,
    #[serde(deserialize_with = "nullable")]
    pub email: Option<String>,
    #[serde(deserialize_with = "nullable")]
    pub organization: Option<String>,
    pub linked: bool,
    pub hook_status: AccountHookStatus,
}

/// `claudeAccountsSchema`: output of `claude:accounts` and `claude:account-add`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ClaudeAccounts {
    pub accounts: Vec<ClaudeAccountView>,
}

impl Validate for ClaudeAccounts {
    fn validate(&self) -> Result<(), String> {
        self.accounts
            .iter()
            .try_for_each(|account| account_id(&account.id))
    }
}

input_entry!(
    DecideInput,
    DismissSessionInput,
    AnswerInput,
    ReleaseQuestionInput,
    AccountInput,
    HooksPreviewInput,
    AccountAddInput
);

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::contract::parse;
    use crate::ipc::IpcErrorCode;

    #[test]
    fn hooks_results_serialize_with_ok_first() {
        let preview = HooksPreview::Diff(HooksPreviewDiff {
            ok: BoolLiteral,
            diff: vec![DiffLine {
                kind: DiffKind::Add,
                text: "x".into(),
            }],
        });
        assert_eq!(
            serde_json::to_string(&preview).unwrap(),
            r#"{"ok":true,"diff":[{"kind":"add","text":"x"}]}"#
        );
        assert_eq!(
            serde_json::to_string(&HooksWrite::InvalidJson(InvalidJson::VALUE)).unwrap(),
            r#"{"ok":false,"reason":"invalid-json"}"#
        );
        let written = HooksWrite::Written(HooksWritten {
            ok: BoolLiteral,
            changed: false,
            diff: Vec::new(),
            backup_file: None,
        });
        assert_eq!(
            serde_json::to_string(&written).unwrap(),
            r#"{"ok":true,"changed":false,"diff":[]}"#
        );
    }

    #[test]
    fn state_omits_an_absent_reason_and_round_trips() {
        let state = ClaudeState {
            connection: ClaudeConnection::Error,
            reason: None,
            hooks: ClaudeHooksStatus::Unknown,
            sessions: Vec::new(),
            pending: Vec::new(),
        };
        let value = serde_json::to_value(&state).unwrap();
        assert_eq!(
            value,
            json!({"connection": "error", "hooks": "unknown", "sessions": [], "pending": []})
        );
        assert_eq!(parse::<ClaudeState>(value).unwrap(), state);
    }

    #[test]
    fn answer_input_keeps_positions_and_free_text() {
        let input = AnswerInput::from_input(
            json!({"id": "q-1", "answers": [{"selected": [2, 0]}, {"selected": [], "other": "Otro"}]}),
        )
        .unwrap();
        assert_eq!(input.answers[0].selected, vec![2, 0]);
        assert_eq!(input.answers[1].other.as_deref(), Some("Otro"));
        let refused = AnswerInput::from_input(json!({"id": "q-1", "answers": []})).unwrap_err();
        assert_eq!(refused.code(), IpcErrorCode::InvalidInput);
    }

    #[test]
    fn decide_input_needs_a_uuid() {
        let input = DecideInput::from_input(
            json!({"requestId": "3f2c8a1e-5b7d-4c9e-8f10-2a3b4c5d6e71", "decision": "deny"}),
        )
        .unwrap();
        assert_eq!(input.decision, Decision::Deny);
        assert!(DecideInput::from_input(json!({"requestId": "r-1", "decision": "deny"})).is_err());
    }
}
