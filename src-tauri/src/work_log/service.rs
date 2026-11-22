//! The work log's rules: one entry per Claude Code session of the chosen account, measured from
//! its hook events ([`Session`]) and kept in `work-log.json` (a [`JsonStore`] of
//! [`WorkLogFile`]). The entries in memory are the truth; every change is saved in the background
//! (each save writes the latest entries, so their order never matters) and sent as a
//! [`WorkLogSnapshot`]. Never logs prompts, replies, summaries or transcript paths: only ids and
//! error kinds.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use chrono::{Local, TimeZone};
use serde::{Deserialize, Serialize};

use super::assign::subtask_times;
use super::timing::Session;
use crate::claude::hook_events::{HookEvent, HookEventName};
use crate::contract::settings::Language;
use crate::contract::work_log::{
    WorkLogEntryView, WorkLogLive, WorkLogSnapshot, WorkLogStatus, WorkLogSubtaskStatus,
    WorkLogSubtaskView, WORK_LOG_SUBTASK_TITLE_MAX,
};
use crate::contract::Validate;
use crate::ipc::{ExposedError, IpcErrorCode};
use crate::services::clock::WallClock;
use crate::services::json_store::{JsonStore, LoadOutcome};

/// Plural name for the logs and the READ_ONLY message.
pub const WORK_LOG_STORE_NAME: &str = "Work log entries";
pub const ENTRY_NOT_FOUND_MESSAGE: &str = "Work log entry not found";
/// How long a deleted entry stays restorable (as Notes).
pub const RESTORE_WINDOW_MS: i64 = crate::notes::service::RESTORE_WINDOW_MS;
/// `SessionStart.source` of `claude --resume`.
const RESUME_SOURCE: &str = "resume";
/// Events kept while the file loads; more are dropped (the notch just started).
const PENDING_MAX: usize = 1_000;
/// Longest session or account id the view accepts.
const ID_MAX: usize = 256;
/// The view's caps on `project` and `title`, in chars.
const PROJECT_MAX: usize = 512;
const TITLE_MAX: usize = 512;
/// How much of the first prompt the provisional title shows.
const TITLE_PROMPT_CHARS: usize = 40;

/// A subtask as Claude's summary describes it: its turns are those of a `done` one.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StoredSubtask {
    pub title: String,
    pub status: WorkLogSubtaskStatus,
    pub turn_ids: Vec<String>,
}

/// The macro task and its subtasks (Task 6 fills it).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Summary {
    pub title: String,
    pub subtasks: Vec<StoredSubtask>,
}

/// One session in `work-log.json`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct StoredEntry {
    pub session_id: String,
    pub account_id: String,
    pub cwd: String,
    /// The session's transcript, from its hook events: only a reference the summary may read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript_path: Option<String>,
    pub status: WorkLogStatus,
    pub invoiced: bool,
    pub ended_at: Option<i64>,
    pub session: Session,
    pub summary: Option<Summary>,
    /// Set by `work-log:delete`. Past the restore window the entry stays as an empty tombstone,
    /// so the rest of a deleted session never brings it back.
    pub deleted_at: Option<i64>,
}

impl StoredEntry {
    fn new(event: &HookEvent, at: i64) -> Self {
        Self {
            session_id: event.session_id.clone(),
            account_id: event.account_id.clone(),
            cwd: String::new(),
            transcript_path: None,
            status: WorkLogStatus::Running,
            invoiced: false,
            ended_at: None,
            session: Session::start(at),
            summary: None,
            deleted_at: None,
        }
    }

    fn is_live(&self) -> bool {
        matches!(self.status, WorkLogStatus::Running | WorkLogStatus::Paused)
    }
}

/// The whole `work-log.json` document.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct WorkLogFile {
    pub version: u8,
    pub entries: Vec<StoredEntry>,
}

impl WorkLogFile {
    pub const VERSION: u8 = 1;

    pub fn new(entries: Vec<StoredEntry>) -> Self {
        Self {
            version: Self::VERSION,
            entries,
        }
    }
}

impl Default for WorkLogFile {
    fn default() -> Self {
        Self::new(Vec::new())
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= ID_MAX
}

impl Validate for WorkLogFile {
    fn validate(&self) -> Result<(), String> {
        if self.version != Self::VERSION {
            return Err("version must be 1".into());
        }
        if self
            .entries
            .iter()
            .any(|e| !valid_id(&e.session_id) || !valid_id(&e.account_id))
        {
            return Err("every entry needs a session and an account id".into());
        }
        Ok(())
    }
}

/// What the service reads from the settings, each time it needs it.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkLogConfig {
    /// `integrations.workLog.enabled`.
    pub enabled: bool,
    /// `workLog.accountId`: only this account's sessions are recorded.
    pub account_id: Option<String>,
    /// `workLog.idlePauseMinutes` in ms: the cap on idle gaps.
    pub idle_pause_ms: i64,
    pub language: Language,
}

/// Writes the summary of an ended session ([`super::summarizer`]). `summarize` is called with the
/// entry already `summarizing`, outside the service's lock; it must not block (spawn the work)
/// and reports back with [`WorkLogService::finish_summary`].
pub trait Summarizer: Send + Sync {
    fn summarize(&self, entry: &StoredEntry);
    /// Whether `claude` can be launched (`work-log:claude-available`).
    fn claude_available(&self) -> bool;
    /// An event of the summarizer's own `claude -p` (it runs with the account's hooks): never
    /// recorded, or every summary would make a new entry to summarize.
    fn is_own_session(&self, _event: &HookEvent) -> bool {
        false
    }
}

/// A summarizer that never summarizes (entries stay `summarizing`) and only looks for `claude`
/// on the PATH (tests).
pub struct NoSummarizer;

impl Summarizer for NoSummarizer {
    fn summarize(&self, _entry: &StoredEntry) {}

    fn claude_available(&self) -> bool {
        claude_on_path()
    }
}

/// `claude.exe` (native install) or `claude.cmd` (npm) on the PATH or in WindowsApps.
pub fn claude_on_path() -> bool {
    let env: crate::apps::launcher::Env = std::env::vars_os().collect();
    let exists = |path: &str| std::path::Path::new(path).is_file();
    super::summarizer::find_claude(None, &env, &exists).is_some()
}

pub type Now = Arc<dyn Fn() -> i64 + Send + Sync>;
pub type ConfigSource = Arc<dyn Fn() -> WorkLogConfig + Send + Sync>;
pub type ChangeListener = Arc<dyn Fn(&WorkLogSnapshot) + Send + Sync>;

pub struct WorkLogDeps {
    /// `work-log.json`.
    pub file: PathBuf,
    /// Stamps the quarantine file name.
    pub clock: Arc<WallClock>,
    /// Epoch ms for the channels (delete, restore) and the start.
    pub now: Now,
    pub config: ConfigSource,
    pub summarizer: Arc<dyn Summarizer>,
    /// Told after every change with the new snapshot.
    pub on_change: ChangeListener,
}

#[derive(Default)]
struct State {
    /// False until the file is loaded: events wait in `pending`.
    loaded: bool,
    entries: Vec<StoredEntry>,
    pending: Vec<(HookEvent, i64)>,
}

pub struct WorkLogService {
    me: Weak<Self>,
    store: JsonStore<WorkLogFile>,
    now: Now,
    config: ConfigSource,
    summarizer: Arc<dyn Summarizer>,
    on_change: ChangeListener,
    state: Mutex<State>,
    /// Bumped under the state lock on every change.
    generation: AtomicU64,
    /// The generation last written; held while writing, so saves never overlap.
    saved: tokio::sync::Mutex<u64>,
    read_only: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn not_found() -> ExposedError {
    ExposedError::new(IpcErrorCode::NotFound, ENTRY_NOT_FOUND_MESSAGE)
}

/// The first `max` chars of `text`.
fn cut(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// What one hook event does to the entries: `None` when nothing changed.
fn apply_event(
    entries: &mut Vec<StoredEntry>,
    event: &HookEvent,
    now: i64,
    cap_ms: i64,
) -> Option<Option<StoredEntry>> {
    let resume =
        event.name == HookEventName::SessionStart && event.source.as_deref() == Some(RESUME_SOURCE);
    let index = match entries
        .iter()
        .position(|e| e.session_id == event.session_id)
    {
        Some(index) => index,
        None => {
            entries.push(StoredEntry::new(event, now));
            entries.len() - 1
        }
    };
    let entry = &mut entries[index];
    if entry.deleted_at.is_some() {
        return None;
    }
    // Ended (it has an end, even if paused since the start): late events (background agents)
    // never reopen it; only a resume does.
    if entry.ended_at.is_some() && !resume {
        return None;
    }
    if resume {
        entry.status = WorkLogStatus::Running;
        entry.invoiced = false;
        entry.ended_at = None;
    } else {
        match entry.status {
            WorkLogStatus::Running => {}
            WorkLogStatus::Paused => entry.status = WorkLogStatus::Running,
            // Ended: late events (background agents) never reopen it; only a resume does.
            WorkLogStatus::Summarizing | WorkLogStatus::Unsummarized | WorkLogStatus::Ready => {
                return None
            }
        }
    }
    if let Some(cwd) = event.cwd.as_deref().filter(|cwd| !cwd.is_empty()) {
        entry.cwd = cwd.to_owned();
    }
    if let Some(path) = event
        .work
        .as_ref()
        .and_then(|work| work.transcript_path.as_deref())
        .filter(|path| !path.is_empty())
    {
        entry.transcript_path = Some(path.to_owned());
    }
    entry.session.apply(event, now, cap_ms);
    if event.name == HookEventName::SessionEnd {
        entry.session.close(now);
        entry.ended_at = Some(entry.session.last_event_at);
        entry.status = WorkLogStatus::Summarizing;
        return Some(Some(entry.clone()));
    }
    Some(None)
}

/// Empties the entries deleted longer ago than the restore window. True if any changed.
fn prune(entries: &mut [StoredEntry], now: i64) -> bool {
    let mut changed = false;
    for entry in entries.iter_mut() {
        let expired = entry
            .deleted_at
            .is_some_and(|at| now - at > RESTORE_WINDOW_MS);
        let empty = entry.session.turns.is_empty()
            && entry.summary.is_none()
            && entry.transcript_path.is_none();
        if expired && !empty {
            entry.session = Session::start(entry.session.started_at);
            entry.summary = None;
            entry.cwd.clear();
            entry.transcript_path = None;
            changed = true;
        }
    }
    changed
}

/// The view's `project`: the last component of `cwd`.
fn project_of(cwd: &str) -> String {
    let name = cwd
        .trim_end_matches(['\\', '/'])
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or_default();
    cut(name, PROJECT_MAX)
}

/// «Sesión del DD/MM · «<first 40 chars of the first prompt>…»» (the dots only when cut).
pub(crate) fn provisional_title(entry: &StoredEntry, language: Language) -> String {
    let date = Local
        .timestamp_millis_opt(entry.session.started_at)
        .single()
        .map(|at| at.format("%d/%m").to_string())
        .unwrap_or_default();
    let prompt = entry
        .session
        .turns
        .iter()
        .map(|turn| turn.prompt.split_whitespace().collect::<Vec<_>>().join(" "))
        .find(|prompt| !prompt.is_empty());
    let head = match language {
        Language::Es => format!("Sesión del {date}"),
        Language::En => format!("Session on {date}"),
    };
    let Some(prompt) = prompt else {
        return head;
    };
    let mut quoted = cut(&prompt, TITLE_PROMPT_CHARS);
    if prompt.chars().count() > TITLE_PROMPT_CHARS {
        quoted.push('…');
    }
    match language {
        Language::Es => format!("{head} · «{quoted}»"),
        Language::En => format!("{head} · “{quoted}”"),
    }
}

/// The summary's title, or the provisional one.
pub(crate) fn title_of(entry: &StoredEntry, language: Language) -> String {
    match entry
        .summary
        .as_ref()
        .filter(|summary| !summary.title.trim().is_empty())
    {
        Some(summary) => summary.title.clone(),
        None => provisional_title(entry, language),
    }
}

/// Whole times of the session, never negative.
pub(crate) fn entry_times(entry: &StoredEntry) -> (i64, i64) {
    (
        entry.session.claude_ms().max(0),
        entry.session.total_ms().max(0),
    )
}

fn view_of(entry: &StoredEntry, language: Language) -> WorkLogEntryView {
    let session = &entry.session;
    let (claude_ms, total_ms) = entry_times(entry);
    let live = entry.is_live().then(|| WorkLogLive {
        last_event_at: session.last_event_at.max(0) as f64,
        excess_ms: (session.last_event_at - session.started_at - session.total_ms()).max(0) as f64,
        turn_open: session.turns.last().is_some_and(|t| t.ended_at.is_none()),
    });
    let subtasks = entry
        .summary
        .iter()
        .flat_map(|summary| summary.subtasks.iter().zip(subtask_times(summary, session)))
        .map(|(subtask, (claude, total))| {
            let title = cut(subtask.title.trim(), WORK_LOG_SUBTASK_TITLE_MAX);
            let (claude, total) = (claude.map(|ms| ms as f64), total.map(|ms| ms as f64));
            WorkLogSubtaskView {
                title: if title.is_empty() {
                    "—".into()
                } else {
                    title
                },
                status: subtask.status,
                claude_ms: claude,
                total_ms: total,
            }
        })
        .collect();
    WorkLogEntryView {
        session_id: entry.session_id.clone(),
        account_id: entry.account_id.clone(),
        project: project_of(&entry.cwd),
        status: entry.status,
        invoiced: entry.invoiced,
        started_at: session.started_at.max(0) as f64,
        ended_at: entry.ended_at.map(|at| at.max(0) as f64),
        claude_ms: claude_ms as f64,
        total_ms: total_ms as f64,
        live,
        title: cut(&title_of(entry, language), TITLE_MAX),
        subtasks,
    }
}

/// The snapshot: entries not deleted, running and paused first (latest activity first), then by
/// end, newest first.
pub fn snapshot_of(entries: &[StoredEntry], config: &WorkLogConfig) -> WorkLogSnapshot {
    let mut shown: Vec<&StoredEntry> = entries.iter().filter(|e| e.deleted_at.is_none()).collect();
    shown.sort_by(|a, b| {
        b.is_live()
            .cmp(&a.is_live())
            .then_with(|| {
                if a.is_live() {
                    b.session.last_event_at.cmp(&a.session.last_event_at)
                } else {
                    b.ended_at.cmp(&a.ended_at)
                }
            })
            .then_with(|| b.session.started_at.cmp(&a.session.started_at))
            .then_with(|| a.session_id.cmp(&b.session_id))
    });
    WorkLogSnapshot {
        entries: shown
            .into_iter()
            .map(|entry| view_of(entry, config.language))
            .collect(),
        idle_pause_ms: config.idle_pause_ms.max(0) as f64,
    }
}

impl WorkLogService {
    pub fn new(deps: WorkLogDeps) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            store: JsonStore::new(deps.file, WORK_LOG_STORE_NAME, deps.clock),
            now: deps.now,
            config: deps.config,
            summarizer: deps.summarizer,
            on_change: deps.on_change,
            state: Mutex::new(State::default()),
            generation: AtomicU64::new(0),
            saved: tokio::sync::Mutex::new(0),
            read_only: AtomicBool::new(false),
        })
    }

    /// Loads the file: what was running or summarizing when the notch closed is now paused (its
    /// session may have ended unseen). Then replays the events that arrived meanwhile and sends
    /// the first snapshot.
    pub async fn start(&self) {
        let outcome = self.store.load().await;
        self.read_only
            .store(outcome == LoadOutcome::ReadOnly, Ordering::SeqCst);
        let now = (self.now)();
        let ended = {
            let mut state = lock(&self.state);
            state.entries = self.store.get().entries;
            let mut changed = prune(&mut state.entries, now);
            for entry in &mut state.entries {
                if matches!(
                    entry.status,
                    WorkLogStatus::Running | WorkLogStatus::Summarizing
                ) && entry.deleted_at.is_none()
                {
                    entry.status = WorkLogStatus::Paused;
                    entry.session.close(entry.session.last_event_at);
                    changed = true;
                }
            }
            // The events that came during the load, in order and before any later one: the lock
            // is held until `loaded` is set.
            let cap = (self.config)().idle_pause_ms;
            let mut ended = Vec::new();
            for (event, at) in std::mem::take(&mut state.pending) {
                if let Some(result) = apply_event(&mut state.entries, &event, at, cap) {
                    changed = true;
                    ended.extend(result);
                }
            }
            if changed {
                self.generation.fetch_add(1, Ordering::SeqCst);
            }
            state.loaded = true;
            ended
        };
        self.after_change();
        for entry in ended {
            self.summarizer.summarize(&entry);
        }
    }

    /// Saves whatever is not on disk yet, waiting for a save in progress.
    pub async fn flush(&self) {
        if let Err(error) = self.persist().await {
            log::warn!("Could not save the work log ({:?})", error.code());
        }
    }

    /// A copy of every entry, deleted ones included.
    pub fn entries(&self) -> Vec<StoredEntry> {
        lock(&self.state).entries.clone()
    }

    pub fn snapshot(&self) -> WorkLogSnapshot {
        let config = (self.config)();
        snapshot_of(&lock(&self.state).entries, &config)
    }

    /// Sends the snapshot again (the settings it depends on changed).
    pub fn emit_snapshot(&self) {
        (self.on_change)(&self.snapshot());
    }

    pub fn claude_available(&self) -> bool {
        self.summarizer.claude_available()
    }

    /// One hook event from the bridge (any account). Only the chosen account's sessions are
    /// recorded, and only with the integration on.
    pub fn on_hook_event(&self, event: &HookEvent, now: i64) {
        let config = (self.config)();
        if !config.enabled || config.account_id.as_deref() != Some(event.account_id.as_str()) {
            return;
        }
        if !valid_id(&event.session_id) || !valid_id(&event.account_id) {
            return;
        }
        if self.summarizer.is_own_session(event) {
            return;
        }
        let ended = {
            let mut state = lock(&self.state);
            if !state.loaded {
                if state.pending.len() < PENDING_MAX {
                    state.pending.push((event.clone(), now));
                }
                return;
            }
            let Some(ended) = apply_event(&mut state.entries, event, now, config.idle_pause_ms)
            else {
                return;
            };
            self.generation.fetch_add(1, Ordering::SeqCst);
            ended
        };
        self.after_change();
        if let Some(entry) = ended {
            self.summarizer.summarize(&entry);
        }
    }

    /// Every 60 s: a running session quiet for longer than the cap is paused; one whose open
    /// turn went quiet that long stalled (no `Stop`), so the turn is closed at its last event.
    pub fn tick(&self, now: i64) {
        let cap = (self.config)().idle_pause_ms;
        let changed = {
            let mut state = lock(&self.state);
            let mut changed = prune(&mut state.entries, now);
            for entry in &mut state.entries {
                if entry.status != WorkLogStatus::Running || entry.deleted_at.is_some() {
                    continue;
                }
                let session = &mut entry.session;
                let quiet_since = match session.turns.last().filter(|t| t.ended_at.is_none()) {
                    Some(open) => open.last_event_at,
                    None => session.last_event_at,
                };
                if now - quiet_since > cap {
                    // Maybe one long tool call: a later event of that turn reopens it.
                    session.close_stalled();
                    entry.status = WorkLogStatus::Paused;
                    changed = true;
                }
            }
            if changed {
                self.generation.fetch_add(1, Ordering::SeqCst);
            }
            changed
        };
        if changed {
            self.after_change();
        }
    }

    pub async fn set_invoiced(&self, session_id: &str, invoiced: bool) -> Result<(), ExposedError> {
        self.mutate(session_id, |entry, _| {
            let changed = entry.invoiced != invoiced;
            entry.invoiced = invoiced;
            Ok(changed)
        })
        .await
    }

    pub async fn delete(&self, session_id: &str) -> Result<(), ExposedError> {
        self.mutate(session_id, |entry, now| {
            entry.deleted_at = Some(now);
            Ok(true)
        })
        .await
    }

    /// Undoes a delete within [`RESTORE_WINDOW_MS`]; NOT_FOUND after it.
    pub async fn restore(&self, session_id: &str) -> Result<(), ExposedError> {
        self.mutate_any(session_id, |entry, now| match entry.deleted_at {
            Some(at) if now - at <= RESTORE_WINDOW_MS => {
                entry.deleted_at = None;
                Ok(true)
            }
            _ => Err(not_found()),
        })
        .await
    }

    /// Cerrar y resumir (paused or running) and Reintentar (unsummarized): the entry becomes
    /// `summarizing` and goes to the summarizer. Already summarizing: nothing to do.
    pub async fn summarize(&self, session_id: &str) -> Result<(), ExposedError> {
        let mut queued = None;
        self.mutate(session_id, |entry, _| {
            if entry.status == WorkLogStatus::Summarizing {
                return Ok(false);
            }
            if entry.is_live() {
                let last = entry.session.last_event_at;
                entry.session.close(last);
                entry.ended_at = Some(last);
            }
            entry.status = WorkLogStatus::Summarizing;
            queued = Some(entry.clone());
            Ok(true)
        })
        .await?;
        if let Some(entry) = queued {
            self.summarizer.summarize(&entry);
        }
        Ok(())
    }

    /// The summarizer's answer for a `summarizing` entry: `Some` makes it `ready`, `None` (it
    /// failed) `unsummarized`. Ignored if the entry is gone or no longer summarizing (resumed).
    pub fn finish_summary(&self, session_id: &str, summary: Option<Summary>) {
        {
            let mut state = lock(&self.state);
            let Some(entry) = state.entries.iter_mut().find(|e| {
                e.session_id == session_id
                    && e.deleted_at.is_none()
                    && e.status == WorkLogStatus::Summarizing
            }) else {
                return;
            };
            match summary {
                Some(summary) => {
                    entry.summary = Some(summary);
                    entry.status = WorkLogStatus::Ready;
                }
                None => entry.status = WorkLogStatus::Unsummarized,
            }
            self.generation.fetch_add(1, Ordering::SeqCst);
        }
        self.after_change();
    }

    /// The text `work-log:copy` puts on the clipboard.
    pub fn copy_text(
        &self,
        session_id: &str,
        subtask: Option<usize>,
    ) -> Result<String, ExposedError> {
        let language = (self.config)().language;
        let state = lock(&self.state);
        let entry = state
            .entries
            .iter()
            .find(|e| e.session_id == session_id && e.deleted_at.is_none())
            .ok_or_else(not_found)?;
        if let Some(index) = subtask {
            let count = entry.summary.as_ref().map_or(0, |s| s.subtasks.len());
            if index >= count {
                return Err(not_found());
            }
        }
        Ok(super::copy::copy_text(entry, language, subtask))
    }

    /// A channel's change to one visible entry, saved before answering.
    async fn mutate(
        &self,
        session_id: &str,
        change: impl FnOnce(&mut StoredEntry, i64) -> Result<bool, ExposedError>,
    ) -> Result<(), ExposedError> {
        self.mutate_any(session_id, |entry, now| {
            if entry.deleted_at.is_some() {
                return Err(not_found());
            }
            change(entry, now)
        })
        .await
    }

    async fn mutate_any(
        &self,
        session_id: &str,
        change: impl FnOnce(&mut StoredEntry, i64) -> Result<bool, ExposedError>,
    ) -> Result<(), ExposedError> {
        if self.read_only.load(Ordering::SeqCst) {
            return Err(ExposedError::new(
                IpcErrorCode::ReadOnly,
                format!(
                    "{WORK_LOG_STORE_NAME} are read-only in this session; changes cannot be saved"
                ),
            ));
        }
        let now = (self.now)();
        let (pruned, result) = {
            let mut state = lock(&self.state);
            let pruned = prune(&mut state.entries, now);
            let result = state
                .entries
                .iter_mut()
                .find(|e| e.session_id == session_id)
                .ok_or_else(not_found)
                .and_then(|entry| change(entry, now));
            if pruned || result.as_ref().is_ok_and(|changed| *changed) {
                self.generation.fetch_add(1, Ordering::SeqCst);
            }
            (pruned, result)
        };
        let changed = match result {
            Ok(changed) => changed,
            Err(error) => {
                if pruned {
                    self.after_change();
                }
                return Err(error);
            }
        };
        if changed {
            (self.on_change)(&self.snapshot());
            self.persist().await?;
        } else if pruned {
            self.after_change();
        }
        Ok(())
    }

    /// Sends the snapshot and saves in the background.
    fn after_change(&self) {
        (self.on_change)(&self.snapshot());
        if self.read_only.load(Ordering::SeqCst) {
            return;
        }
        let Some(me) = self.me.upgrade() else {
            return;
        };
        tauri::async_runtime::spawn(async move { me.flush().await });
    }

    /// Writes the latest entries unless they are already on disk.
    async fn persist(&self) -> Result<(), ExposedError> {
        let mut saved = self.saved.lock().await;
        let (generation, entries) = {
            let state = lock(&self.state);
            (
                self.generation.load(Ordering::SeqCst),
                state.entries.clone(),
            )
        };
        if generation == *saved {
            return Ok(());
        }
        self.store.write(WorkLogFile::new(entries)).await?;
        *saved = generation;
        Ok(())
    }
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;
