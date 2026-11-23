//! The summary of an ended session: `claude -p` (the account's `CLAUDE_CONFIG_DIR`, in the
//! notch's own folder, only the `Read` tool) groups the measured turns into a macro task and its
//! subtasks. Claude only says which turns go where; [`super::assign`] checks that and the notch
//! computes every time. One run at a time. Never logs the prompt, Claude's output or the
//! summary: only `work-log summary failed: <variant>`.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock, PoisonError, Weak};
use std::time::{Duration, Instant};

use chrono::{Local, TimeZone};
use serde::Deserialize;

use super::assign::{assign, SUMMARY_TITLE_MAX};
use super::service::{StoredEntry, Summarizer, Summary, WorkLogService};
use super::timing::Turn;
use crate::apps::launcher::{resolve_executable, Env};
use crate::claude::hook_events::HookEvent;
use crate::contract::settings::Language;
use crate::contract::work_log::WorkLogSubtaskStatus;

/// Dev/E2E only: the `claude` to run instead of the one on the PATH.
pub const CLAUDE_OVERRIDE_ENV: &str = "NOTCH_WORKLOG_CLAUDE";
/// How long one summary may take in production.
pub const SUMMARY_TIMEOUT: Duration = Duration::from_secs(300);
/// The longest prompt sent to Claude, in chars.
pub const PROMPT_MAX_CHARS: usize = 60_000;
/// The most subtasks an answer may have.
pub const SUBTASKS_MAX: usize = 40;
/// The tools that could write or reach out: never available to the summary.
const DENIED_TOOLS: [&str; 6] = [
    "Bash",
    "Edit",
    "Write",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
];
/// The settings file of every run, in the work folder: no hooks (the account's hooks would send
/// the run to the notch's bridge as one more session) and the denied tools.
const SETTINGS_FILE: &str = "settings.json";

/// `claude -p` with its answer as one JSON object, `Read` as the only built-in tool (the
/// transcript), everything else denied without asking (whatever the account's permission mode),
/// none of the account's MCP servers, and the settings file of [`run_settings`] (`--settings`
/// goes last: its value is an absolute path).
fn claude_args(settings: &Path) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = ["-p", "--output-format", "json", "--tools", "Read"]
        .iter()
        .chain(&["--allowedTools", "Read", "--disallowedTools"])
        .map(Into::into)
        .collect();
    args.extend(DENIED_TOOLS.iter().map(Into::into));
    args.extend(
        [
            "--permission-mode",
            "dontAsk",
            "--strict-mcp-config",
            "--settings",
        ]
        .iter()
        .map(Into::into),
    );
    args.push(settings.as_os_str().to_owned());
    args
}

/// `{"disableAllHooks": true, "permissions": {"deny": [...], "defaultMode": "dontAsk"}}`.
fn run_settings() -> String {
    serde_json::json!({
        "disableAllHooks": true,
        "permissions": { "deny": DENIED_TOOLS, "defaultMode": "dontAsk" },
    })
    .to_string()
}
const CONFIG_DIR_VAR: &str = "CLAUDE_CONFIG_DIR";
/// `CREATE_NO_WINDOW`: no console flashes up for `claude` (or its `.cmd` shim).
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const POLL: Duration = Duration::from_millis(500);
/// How much of each prompt and reply goes in before anything is cut to fit.
const PROMPT_CAP: usize = 2_000;
const REPLY_CAP: usize = 2_000;
/// How many tools a turn lists.
const TOOLS_MAX: usize = 20;
/// The most of Claude's output that is read (the rest is drained).
const OUTPUT_MAX_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SummaryError {
    /// No `claude` (or no folder for the account).
    NotFound,
    Spawn,
    Timeout,
    Exit(i32),
    Invalid,
}

/// One subtask as Claude answers it.
#[derive(Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SubtaskOut {
    pub title: String,
    pub status: WorkLogSubtaskStatus,
    #[serde(default)]
    pub turn_ids: Vec<String>,
}

/// Claude's answer, validated by [`parse_output`] but not yet checked against the session.
#[derive(Deserialize, Clone, Debug, PartialEq)]
pub struct SummaryOut {
    pub title: String,
    pub subtasks: Vec<SubtaskOut>,
}

/// The `CLAUDE_CONFIG_DIR` of an account's run.
#[derive(Clone, Debug, PartialEq)]
pub enum ConfigDir {
    /// The default account (`claude`, `~/.claude`): the variable is removed.
    Default,
    Dir(PathBuf),
}

pub type ConfigDirOf = Arc<dyn Fn(&str) -> Option<ConfigDir> + Send + Sync>;

/// The folder `claude -p` runs with for `account_id`, among the accounts the Control Center
/// lists ([`crate::claude::accounts::AccountDirectory`]: `NOTCH_CLAUDE_HOME`, added folders and
/// linked folders without a profile included). The default account of the user's real home
/// (`default_home`) runs without `CLAUDE_CONFIG_DIR`; any other with its folder. `None` for an
/// account that is not there.
pub fn config_dir_for(
    accounts: &[crate::claude::accounts::ClaudeAccount],
    account_id: &str,
    default_home: bool,
) -> Option<ConfigDir> {
    let account = accounts.iter().find(|account| account.id == account_id)?;
    if default_home && account.id == crate::claude::accounts::DEFAULT_ACCOUNT_ID {
        return Some(ConfigDir::Default);
    }
    Some(ConfigDir::Dir(account.dir.clone()))
}
pub type LanguageSource = Arc<dyn Fn() -> Language + Send + Sync>;

pub struct SummarizerDeps {
    /// [`CLAUDE_OVERRIDE_ENV`] (dev/E2E only).
    pub claude_override: Option<PathBuf>,
    /// The folder of an account id; `None` if the account is gone.
    pub config_dir: ConfigDirOf,
    /// The app's language: the summary is written in it.
    pub language: LanguageSource,
    /// `<data dir>/work-log-summarizer`, created on the first run.
    pub work_dir: PathBuf,
    /// [`SUMMARY_TIMEOUT`] in production.
    pub timeout: Duration,
}

struct Words {
    intro: &'static str,
    rules: &'static str,
    example: &'static str,
    folder: &'static str,
    transcript: &'static str,
    turns: &'static str,
    prompt: &'static str,
    reply: &'static str,
    tools: &'static str,
}

fn words(language: Language) -> Words {
    match language {
        Language::Es => Words {
            intro: "Resume esta sesión de trabajo de Claude Code para imputar sus horas.\n\n\
                    Responde SOLO con un objeto JSON, sin texto antes ni después, con esta forma:\n",
            rules: "Reglas:\n\
                    - \"title\": la tarea macro de la sesión, en una frase (como mucho 300 caracteres).\n\
                    - \"subtasks\": bloques de trabajo agrupados por resultado (no uno por tramo), cada uno descrito con detalle: qué se hizo y con qué resultado. Como mucho 40.\n\
                    - \"done\": lo que se hizo en la sesión. \"pending\": lo que quedó por hacer, siempre con \"turnIds\": [].\n\
                    - Cada id de tramo va en una sola subtarea \"done\". Usa solo los ids de la lista de tramos.\n\
                    - No escribas tiempos, horas ni duraciones en ningún texto: el notch los calcula.\n\
                    - Escribe los títulos en español.\n\
                    - No modifiques nada. Si necesitas más contexto puedes leer el transcript, pero no es obligatorio.\n",
            example: "Ejemplo de estilo (de otra sesión):\n",
            folder: "Carpeta de la sesión",
            transcript: "Transcript (referencia opcional)",
            turns: "Tramos (id · hora local):",
            prompt: "Prompt",
            reply: "Respuesta",
            tools: "Herramientas",
        },
        Language::En => Words {
            intro: "Summarize this Claude Code work session so its hours can be logged.\n\n\
                    Answer ONLY with one JSON object, with no text before or after it, shaped like this:\n",
            rules: "Rules:\n\
                    - \"title\": the session's overall task, in one sentence (300 characters at most).\n\
                    - \"subtasks\": blocks of work grouped by outcome (not one per turn), each described in detail: what was done and with what result. 40 at most.\n\
                    - \"done\": what was done in the session. \"pending\": what is left to do, always with \"turnIds\": [].\n\
                    - Each turn id goes in exactly one \"done\" subtask. Use only the ids of the turn list.\n\
                    - Write no times, hours or durations in any text: the notch computes them.\n\
                    - Write the titles in English.\n\
                    - Change nothing. If you need more context you may read the transcript, but you do not have to.\n",
            example: "Style example (from another session):\n",
            folder: "Session folder",
            transcript: "Transcript (optional reference)",
            turns: "Turns (id · local time):",
            prompt: "Prompt",
            reply: "Reply",
            tools: "Tools",
        },
    }
}

const SHAPE: &str = "{\"title\": string, \"subtasks\": [{\"title\": string, \"status\": \"done\" | \"pending\", \"turnIds\": string[]}]}\n\n";

/// Two subtasks of the Cashela session of the design, as the style to follow.
fn example(language: Language) -> &'static str {
    match language {
        Language::Es => "{\"title\": \"Integrar la pasarela Cashela en ms-pay\", \"subtasks\": [\n  \
                         {\"title\": \"Analizar la API Pay-In de Cashela\", \"status\": \"done\", \"turnIds\": [\"t1\", \"t2\"]},\n  \
                         {\"title\": \"Validar la firma con el vector oficial\", \"status\": \"pending\", \"turnIds\": []}]}\n\n",
        Language::En => "{\"title\": \"Integrate the Cashela gateway into ms-pay\", \"subtasks\": [\n  \
                         {\"title\": \"Analyze Cashela's Pay-In API\", \"status\": \"done\", \"turnIds\": [\"t1\", \"t2\"]},\n  \
                         {\"title\": \"Validate the signature against the official test vector\", \"status\": \"pending\", \"turnIds\": []}]}\n\n",
    }
}

/// `text` trimmed, cut at `max` chars (with `…` when cut).
fn shown(text: &str, max: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut cut: String = text.chars().take(max).collect();
    cut.push('…');
    cut
}

fn local_time(at: i64) -> String {
    Local
        .timestamp_millis_opt(at)
        .single()
        .map(|at| at.format("%d/%m %H:%M").to_string())
        .unwrap_or_default()
}

fn tools_line(turn: &Turn) -> String {
    turn.tools
        .iter()
        .take(TOOLS_MAX)
        .map(|(name, count)| format!("{} ×{count}", shown(name, 64)))
        .collect::<Vec<_>>()
        .join(", ")
}

fn render(entry: &StoredEntry, language: Language, prompt_cap: usize, reply_cap: usize) -> String {
    let words = words(language);
    let mut text = String::new();
    text.push_str(words.intro);
    text.push_str(SHAPE);
    text.push_str(words.rules);
    text.push('\n');
    text.push_str(words.example);
    text.push_str(example(language));
    if !entry.cwd.is_empty() {
        text.push_str(&format!("{}: {}\n", words.folder, entry.cwd));
    }
    if let Some(path) = entry.transcript_path.as_deref() {
        text.push_str(&format!("{}: {path}\n", words.transcript));
    }
    text.push('\n');
    text.push_str(words.turns);
    text.push('\n');
    for turn in &entry.session.turns {
        text.push_str(&format!(
            "\n### {} · {}\n",
            turn.id,
            local_time(turn.started_at)
        ));
        text.push_str(&format!(
            "{}: {}\n",
            words.prompt,
            shown(&turn.prompt, prompt_cap)
        ));
        if let Some(reply) = turn.reply.as_deref().filter(|r| !r.trim().is_empty()) {
            text.push_str(&format!("{}: {}\n", words.reply, shown(reply, reply_cap)));
        }
        if !turn.tools.is_empty() {
            text.push_str(&format!("{}: {}\n", words.tools, tools_line(turn)));
        }
    }
    text
}

/// The largest cap in `0..=max` whose text fits, if any.
fn largest_fitting(max: usize, fits: impl Fn(usize) -> bool) -> Option<usize> {
    if !fits(0) {
        return None;
    }
    let (mut low, mut high) = (0, max);
    while low < high {
        let mid = low + (high - low).div_ceil(2);
        if fits(mid) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    Some(low)
}

/// The prompt for `claude -p` (see the module docs). Over [`PROMPT_MAX_CHARS`], the longest
/// replies are cut first, then the longest prompts; no turn is ever left out.
pub fn build_prompt(entry: &StoredEntry, language: Language) -> String {
    let size = |prompt_cap, reply_cap| render(entry, language, prompt_cap, reply_cap);
    let fits = |text: &String| text.chars().count() <= PROMPT_MAX_CHARS;
    let full = size(PROMPT_CAP, REPLY_CAP);
    if fits(&full) {
        return full;
    }
    if let Some(reply_cap) = largest_fitting(REPLY_CAP, |cap| fits(&size(PROMPT_CAP, cap))) {
        return size(PROMPT_CAP, reply_cap);
    }
    let prompt_cap = largest_fitting(PROMPT_CAP, |cap| fits(&size(cap, 0))).unwrap_or(0);
    size(prompt_cap, 0)
}

/// The JSON inside `text`: without a ```` ```json ```` fence, else from its first `{` to its
/// last `}`.
fn json_in(text: &str) -> &str {
    let text = text.trim();
    if let Some(rest) = text.strip_prefix("```") {
        let body = rest.split_once('\n').map_or("", |(_, body)| body);
        return body.trim_end().trim_end_matches("```").trim();
    }
    match (text.find('{'), text.rfind('}')) {
        (Some(start), Some(end)) if start < end => &text[start..=end],
        _ => text,
    }
}

/// Reads `claude -p --output-format json`: its `result` must be the summary's JSON (maybe in a
/// fence), with a title of 1–300 chars and at most [`SUBTASKS_MAX`] subtasks.
pub fn parse_output(stdout: &str) -> Result<SummaryOut, SummaryError> {
    let value: serde_json::Value =
        serde_json::from_str(stdout.trim()).map_err(|_| SummaryError::Invalid)?;
    // A verbose run prints every message: the answer is the last `result`.
    let result = match value {
        serde_json::Value::Array(items) => items
            .into_iter()
            .rev()
            .find(|item| item.get("type").and_then(|t| t.as_str()) == Some("result")),
        other => Some(other),
    }
    .ok_or(SummaryError::Invalid)?;
    if result.get("is_error").and_then(|e| e.as_bool()) == Some(true) {
        return Err(SummaryError::Invalid);
    }
    let text = result
        .get("result")
        .and_then(|r| r.as_str())
        .ok_or(SummaryError::Invalid)?;
    let out: SummaryOut = serde_json::from_str(json_in(text)).map_err(|_| SummaryError::Invalid)?;
    let title = out.title.trim().chars().count();
    if !(1..=SUMMARY_TITLE_MAX).contains(&title) || out.subtasks.len() > SUBTASKS_MAX {
        return Err(SummaryError::Invalid);
    }
    Ok(out)
}

/// The `claude` to run: the override if it exists, else `claude.exe` (native install) or
/// `claude.cmd` (npm) on the PATH or in WindowsApps. A `.ps1` shim cannot be run directly.
pub fn find_claude(
    claude_override: Option<&Path>,
    env: &Env,
    exists: &dyn Fn(&str) -> bool,
) -> Option<PathBuf> {
    if let Some(path) = claude_override {
        return exists(&path.to_string_lossy()).then(|| path.to_owned());
    }
    ["claude.exe", "claude.cmd"]
        .iter()
        .find_map(|exe| resolve_executable(exe, env, exists))
        .map(PathBuf::from)
}

fn system_env() -> Env {
    std::env::vars_os().collect()
}

fn is_file(path: &str) -> bool {
    Path::new(path).is_file()
}

/// Kills `child` and everything it started: a `.cmd` shim's `node` is a grandchild, which
/// killing `cmd.exe` alone would leave running.
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let taskkill = std::env::var_os("SystemRoot")
            .map(|root| PathBuf::from(root).join("System32").join("taskkill.exe"))
            .filter(|path| path.is_file());
        if let Some(taskkill) = taskkill {
            let _ = Command::new(taskkill)
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Runs `program` with the prompt on stdin, checking every 500 ms, and kills it (and its tree)
/// at `timeout`. Its stdout, if it exits with 0.
fn run_claude(
    program: &Path,
    config_dir: &ConfigDir,
    work_dir: &Path,
    prompt: String,
    timeout: Duration,
) -> Result<String, SummaryError> {
    std::fs::create_dir_all(work_dir).map_err(|_| SummaryError::Spawn)?;
    let settings =
        std::path::absolute(work_dir.join(SETTINGS_FILE)).map_err(|_| SummaryError::Spawn)?;
    std::fs::write(&settings, run_settings()).map_err(|_| SummaryError::Spawn)?;
    let mut command = Command::new(program);
    command
        .args(claude_args(&settings))
        .current_dir(work_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    match config_dir {
        ConfigDir::Default => command.env_remove(CONFIG_DIR_VAR),
        ConfigDir::Dir(dir) => command.env(CONFIG_DIR_VAR, dir),
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn().map_err(|_| SummaryError::Spawn)?;
    // Both pipes on their own threads: a child that never reads its stdin (or fills its stdout)
    // must not block the wait, so the time limit always holds.
    if let Some(mut stdin) = child.stdin.take() {
        std::thread::spawn(move || {
            let _ = stdin.write_all(prompt.as_bytes());
        });
    }
    // The output comes over a channel: a descendant that inherited stdout can keep the pipe
    // open after `claude` exits, and the wait for it has the same deadline.
    let (output_tx, output) = std::sync::mpsc::channel();
    if let Some(mut stdout) = child.stdout.take() {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = (&mut stdout).take(OUTPUT_MAX_BYTES).read_to_end(&mut bytes);
            let _ = std::io::copy(&mut stdout, &mut std::io::sink());
            let _ = output_tx.send(bytes);
        });
    } else {
        let _ = output_tx.send(Vec::new());
    }
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(_) => {
                kill_tree(&mut child);
                return Err(SummaryError::Spawn);
            }
        }
        let now = Instant::now();
        if now >= deadline {
            kill_tree(&mut child);
            return Err(SummaryError::Timeout);
        }
        std::thread::sleep(POLL.min(deadline - now));
    };
    if !status.success() {
        return Err(SummaryError::Exit(status.code().unwrap_or(-1)));
    }
    let left = deadline.saturating_duration_since(Instant::now());
    match output.recv_timeout(left) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(_) => {
            // `claude` is gone; this kills what is left of its tree that is still reachable.
            kill_tree(&mut child);
            Err(SummaryError::Timeout)
        }
    }
}

/// A path as compared: `\` only, none at the end, lowercase.
fn normalized(path: &str) -> String {
    path.replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

/// The [`Summarizer`] behind the work log: `claude -p` on a blocking thread, one at a time.
pub struct ClaudeSummarizer {
    me: Weak<Self>,
    deps: SummarizerDeps,
    service: OnceLock<Weak<WorkLogService>>,
    /// Held while `claude` runs: the summaries queue behind it.
    running: Mutex<()>,
}

impl ClaudeSummarizer {
    pub fn new(deps: SummarizerDeps) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            deps,
            service: OnceLock::new(),
            running: Mutex::new(()),
        })
    }

    /// The service that gets the answers ([`WorkLogService::finish_summary`]).
    pub fn bind(&self, service: &Arc<WorkLogService>) {
        let _ = self.service.set(Arc::downgrade(service));
    }

    fn claude(&self) -> Option<PathBuf> {
        find_claude(
            self.deps.claude_override.as_deref(),
            &system_env(),
            &is_file,
        )
    }

    /// Runs `claude` for `entry` now (after any run in progress) and checks its answer.
    pub fn summarize_now(&self, entry: &StoredEntry) -> Result<Summary, SummaryError> {
        let _running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
        let program = self.claude().ok_or(SummaryError::NotFound)?;
        let config_dir = (self.deps.config_dir)(&entry.account_id).ok_or(SummaryError::NotFound)?;
        let language = (self.deps.language)();
        let stdout = run_claude(
            &program,
            &config_dir,
            &self.deps.work_dir,
            build_prompt(entry, language),
            self.deps.timeout,
        )?;
        let out = parse_output(&stdout)?;
        Ok(assign(out, &entry.session, language))
    }
}

impl Summarizer for ClaudeSummarizer {
    fn summarize(&self, entry: &StoredEntry) {
        let Some(me) = self.me.upgrade() else {
            return;
        };
        let entry = entry.clone();
        tauri::async_runtime::spawn_blocking(move || {
            // A panic must still answer, or the entry stays `summarizing` until the next start.
            let result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| me.summarize_now(&entry)))
                    .unwrap_or(Err(SummaryError::Spawn));
            if let Err(error) = &result {
                log::warn!("work-log summary failed: {error:?}");
            }
            if let Some(service) = me.service.get().and_then(Weak::upgrade) {
                service.finish_summary(&entry.session_id, result.ok());
            }
        });
    }

    fn claude_available(&self) -> bool {
        self.claude().is_some()
    }

    /// Its runs' `cwd` is the summarizer's folder (or one inside it).
    fn is_own_session(&self, event: &HookEvent) -> bool {
        let Some(cwd) = event.cwd.as_deref() else {
            return false;
        };
        let own = normalized(&self.deps.work_dir.to_string_lossy());
        let cwd = normalized(cwd);
        !own.is_empty() && (cwd == own || cwd.starts_with(&format!("{own}\\")))
    }
}

#[cfg(test)]
#[path = "summarizer_tests.rs"]
mod tests;
