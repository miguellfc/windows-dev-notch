use std::sync::{Arc, Mutex};

use chrono::{Local, TimeZone};
use tauri::async_runtime::block_on;

use super::*;
use crate::claude::hook_events::{HookEvent, HookEventName, WorkPayload};
use crate::contract::Validate;
use crate::services::test_dir::TestDir;

const M: i64 = 60_000;
const CAP: i64 = 30 * M;
const WORK: &str = "claude-work";

fn event(name: HookEventName, session: &str) -> HookEvent {
    HookEvent {
        name,
        session_id: session.into(),
        cwd: Some("C:\\Users\\me\\code\\ms-pay".into()),
        tool_name: None,
        tool_use_id: None,
        agent_id: None,
        notification_type: None,
        preview: None,
        reason: None,
        ask_user_question: None,
        ask_user_question_raw: None,
        source: None,
        account_id: WORK.into(),
        work: None,
    }
}

fn prompt(session: &str, text: &str) -> HookEvent {
    HookEvent {
        work: Some(WorkPayload {
            prompt: Some(text.into()),
            ..WorkPayload::default()
        }),
        ..event(HookEventName::UserPromptSubmit, session)
    }
}

fn resume(session: &str) -> HookEvent {
    HookEvent {
        source: Some("resume".into()),
        ..event(HookEventName::SessionStart, session)
    }
}

#[derive(Default)]
struct Recorder {
    summarized: Mutex<Vec<String>>,
}

impl Summarizer for Recorder {
    fn summarize(&self, entry: &StoredEntry) {
        self.summarized
            .lock()
            .unwrap()
            .push(entry.session_id.clone());
    }

    fn claude_available(&self) -> bool {
        true
    }
}

struct Fx {
    dir: TestDir,
    config: Arc<Mutex<WorkLogConfig>>,
    summarizer: Arc<Recorder>,
    emitted: Arc<Mutex<Vec<WorkLogSnapshot>>>,
    now: Arc<Mutex<i64>>,
}

impl Fx {
    fn new() -> Self {
        Self {
            dir: TestDir::new("work-log-service"),
            config: Arc::new(Mutex::new(WorkLogConfig {
                enabled: true,
                account_id: Some(WORK.into()),
                idle_pause_ms: CAP,
                language: Language::Es,
            })),
            summarizer: Arc::new(Recorder::default()),
            emitted: Arc::new(Mutex::new(Vec::new())),
            now: Arc::new(Mutex::new(0)),
        }
    }

    fn file(&self) -> std::path::PathBuf {
        self.dir.join("work-log.json")
    }

    fn make(&self) -> Arc<WorkLogService> {
        let config = Arc::clone(&self.config);
        let emitted = Arc::clone(&self.emitted);
        let now = Arc::clone(&self.now);
        WorkLogService::new(WorkLogDeps {
            file: self.file(),
            clock: Arc::new(WallClock::real()),
            now: Arc::new(move || *now.lock().unwrap()),
            config: Arc::new(move || config.lock().unwrap().clone()),
            summarizer: Arc::clone(&self.summarizer) as Arc<dyn Summarizer>,
            on_change: Arc::new(move |snapshot: &WorkLogSnapshot| {
                emitted.lock().unwrap().push(snapshot.clone())
            }),
        })
    }

    fn started(&self) -> Arc<WorkLogService> {
        let service = self.make();
        block_on(service.start());
        service
    }

    fn set_now(&self, at: i64) {
        *self.now.lock().unwrap() = at;
    }

    fn seed(&self, entries: Vec<StoredEntry>) {
        let file = WorkLogFile::new(entries);
        std::fs::write(self.file(), serde_json::to_string(&file).unwrap()).unwrap();
    }

    fn saved(&self) -> Vec<StoredEntry> {
        let text = std::fs::read_to_string(self.file()).unwrap();
        serde_json::from_str::<WorkLogFile>(&text).unwrap().entries
    }
}

fn run(service: &WorkLogService, steps: &[(i64, HookEvent)]) {
    for (minutes, ev) in steps {
        service.on_hook_event(ev, minutes * M);
    }
}

fn only(service: &WorkLogService) -> StoredEntry {
    let entries = service.entries();
    assert_eq!(entries.len(), 1, "{entries:?}");
    entries.into_iter().next().unwrap()
}

fn stored(session: &str, status: WorkLogStatus) -> StoredEntry {
    let mut session_times = Session::start(0);
    session_times.apply(&prompt(session, "Integrar la pasarela"), 0, CAP);
    session_times.apply(&event(HookEventName::Stop, session), 10 * M, CAP);
    StoredEntry {
        session_id: session.into(),
        account_id: WORK.into(),
        cwd: "C:\\code\\ms-pay".into(),
        status,
        invoiced: false,
        ended_at: None,
        session: session_times,
        summary: None,
        deleted_at: None,
    }
}

#[test]
fn ignores_events_of_another_account_or_with_the_integration_off() {
    let fx = Fx::new();
    let service = fx.started();
    let personal = HookEvent {
        account_id: "claude".into(),
        ..prompt("s1", "hola")
    };
    service.on_hook_event(&personal, 0);
    assert!(service.entries().is_empty());

    fx.config.lock().unwrap().enabled = false;
    service.on_hook_event(&prompt("s1", "hola"), 0);
    assert!(service.entries().is_empty());

    let fx = Fx::new();
    fx.config.lock().unwrap().account_id = None;
    let service = fx.started();
    service.on_hook_event(&prompt("s1", "hola"), 0);
    assert!(service.entries().is_empty());
}

#[test]
fn a_whole_session_ends_summarizing_with_its_end_time() {
    let fx = Fx::new();
    let service = fx.started();
    run(
        &service,
        &[
            (0, event(HookEventName::SessionStart, "s1")),
            (1, prompt("s1", "Integrar la pasarela")),
            (11, event(HookEventName::Stop, "s1")),
            (12, event(HookEventName::SessionEnd, "s1")),
        ],
    );
    let entry = only(&service);
    assert_eq!(entry.status, WorkLogStatus::Summarizing);
    assert_eq!(entry.ended_at, Some(12 * M));
    assert_eq!(entry.session.claude_ms(), 10 * M);
    assert_eq!(entry.session.total_ms(), 12 * M);
    assert_eq!(entry.cwd, "C:\\Users\\me\\code\\ms-pay");
    assert_eq!(*fx.summarizer.summarized.lock().unwrap(), ["s1"]);
    block_on(service.flush());
    assert_eq!(fx.saved(), service.entries());
}

#[test]
fn the_first_event_creates_the_entry_when_session_start_was_missed() {
    let fx = Fx::new();
    let service = fx.started();
    run(&service, &[(5, event(HookEventName::PreToolUse, "s1"))]);
    let entry = only(&service);
    assert_eq!(entry.status, WorkLogStatus::Running);
    assert_eq!(entry.session.started_at, 5 * M);
}

#[test]
fn resume_reopens_the_same_entry_and_clears_invoiced() {
    let fx = Fx::new();
    let mut ready = stored("s1", WorkLogStatus::Ready);
    ready.invoiced = true;
    ready.ended_at = Some(10 * M);
    ready.summary = Some(Summary {
        title: "Cashela".into(),
        subtasks: Vec::new(),
    });
    fx.seed(vec![ready]);
    let service = fx.started();
    run(&service, &[(100, resume("s1"))]);
    let entry = only(&service);
    assert_eq!(entry.status, WorkLogStatus::Running);
    assert!(!entry.invoiced);
    assert_eq!(entry.ended_at, None);
    // The gap since the end is a pause: capped.
    assert_eq!(entry.session.total_ms(), 40 * M);
}

#[test]
fn events_after_the_end_without_resume_change_nothing() {
    let fx = Fx::new();
    let service = fx.started();
    run(
        &service,
        &[
            (0, prompt("s1", "a")),
            (5, event(HookEventName::SessionEnd, "s1")),
            (6, event(HookEventName::PostToolUse, "s1")),
        ],
    );
    let entry = only(&service);
    assert_eq!(entry.status, WorkLogStatus::Summarizing);
    assert_eq!(entry.session.last_event_at, 5 * M);
}

#[test]
fn start_pauses_saved_running_entries_and_an_event_resumes_them() {
    let fx = Fx::new();
    fx.seed(vec![
        stored("s1", WorkLogStatus::Running),
        stored("s2", WorkLogStatus::Summarizing),
        stored("s3", WorkLogStatus::Ready),
    ]);
    let service = fx.started();
    let status = |id: &str| {
        service
            .entries()
            .into_iter()
            .find(|e| e.session_id == id)
            .unwrap()
            .status
    };
    assert_eq!(status("s1"), WorkLogStatus::Paused);
    assert_eq!(status("s2"), WorkLogStatus::Paused);
    assert_eq!(status("s3"), WorkLogStatus::Ready);
    run(
        &service,
        &[(
            20,
            HookEvent {
                tool_name: Some("Bash".into()),
                ..event(HookEventName::PreToolUse, "s1")
            },
        )],
    );
    assert_eq!(status("s1"), WorkLogStatus::Running);
    block_on(service.flush());
    assert_eq!(fx.saved(), service.entries());
}

#[test]
fn events_before_the_load_are_replayed_after_it() {
    let fx = Fx::new();
    fx.seed(vec![stored("s1", WorkLogStatus::Running)]);
    let service = fx.make();
    run(&service, &[(15, event(HookEventName::PreToolUse, "s1"))]);
    block_on(service.start());
    let entry = only(&service);
    assert_eq!(entry.status, WorkLogStatus::Running);
    assert_eq!(entry.session.last_event_at, 15 * M);
}

#[test]
fn tick_pauses_a_session_idle_past_the_cap() {
    let fx = Fx::new();
    let service = fx.started();
    run(
        &service,
        &[
            (0, prompt("s1", "a")),
            (10, event(HookEventName::Stop, "s1")),
        ],
    );
    service.tick(40 * M);
    assert_eq!(only(&service).status, WorkLogStatus::Running);
    service.tick(41 * M);
    assert_eq!(only(&service).status, WorkLogStatus::Paused);
    run(&service, &[(50, prompt("s1", "b"))]);
    assert_eq!(only(&service).status, WorkLogStatus::Running);
}

#[test]
fn tick_closes_a_stalled_open_turn_and_pauses() {
    let fx = Fx::new();
    let service = fx.started();
    run(
        &service,
        &[
            (0, prompt("s1", "a")),
            (3, event(HookEventName::PreToolUse, "s1")),
        ],
    );
    service.tick(30 * M);
    let entry = only(&service);
    assert_eq!(entry.status, WorkLogStatus::Running);
    assert_eq!(entry.session.turns[0].ended_at, None);
    service.tick(34 * M);
    let entry = only(&service);
    assert_eq!(entry.status, WorkLogStatus::Paused);
    assert_eq!(entry.session.turns[0].ended_at, Some(3 * M));
    assert_eq!(entry.session.claude_ms(), 3 * M);
}

#[test]
fn set_invoiced_delete_and_restore_within_the_window() {
    let fx = Fx::new();
    fx.seed(vec![stored("s1", WorkLogStatus::Ready)]);
    let service = fx.started();
    block_on(service.set_invoiced("s1", true)).unwrap();
    assert!(only(&service).invoiced);

    fx.set_now(1_000);
    block_on(service.delete("s1")).unwrap();
    assert!(service.snapshot().entries.is_empty());
    fx.set_now(1_000 + RESTORE_WINDOW_MS);
    block_on(service.restore("s1")).unwrap();
    assert_eq!(service.snapshot().entries.len(), 1);

    block_on(service.delete("s1")).unwrap();
    fx.set_now(2_000 + 2 * RESTORE_WINDOW_MS);
    let late = block_on(service.restore("s1")).unwrap_err();
    assert_eq!(late.code(), IpcErrorCode::NotFound);
    // Deleted for good: its events are ignored, it never comes back.
    run(&service, &[(900, resume("s1"))]);
    assert!(service.snapshot().entries.is_empty());
    let missing = block_on(service.set_invoiced("nope", true)).unwrap_err();
    assert_eq!(missing.code(), IpcErrorCode::NotFound);
    block_on(service.flush());
    assert!(fx.saved()[0].deleted_at.is_some());
    assert!(fx.saved()[0].session.turns.is_empty());
}

#[test]
fn summarize_closes_a_paused_entry_and_finish_stores_the_summary() {
    let fx = Fx::new();
    fx.seed(vec![stored("s1", WorkLogStatus::Paused)]);
    let service = fx.started();
    block_on(service.summarize("s1")).unwrap();
    let entry = only(&service);
    assert_eq!(entry.status, WorkLogStatus::Summarizing);
    assert_eq!(entry.ended_at, Some(10 * M));
    assert_eq!(*fx.summarizer.summarized.lock().unwrap(), ["s1"]);

    service.finish_summary("s1", None);
    assert_eq!(only(&service).status, WorkLogStatus::Unsummarized);
    block_on(service.summarize("s1")).unwrap();
    service.finish_summary(
        "s1",
        Some(Summary {
            title: "Cashela".into(),
            subtasks: Vec::new(),
        }),
    );
    let entry = only(&service);
    assert_eq!(entry.status, WorkLogStatus::Ready);
    assert_eq!(entry.summary.unwrap().title, "Cashela");
}

#[test]
fn snapshot_orders_live_first_then_by_end_and_names_the_project() {
    let fx = Fx::new();
    let mut old = stored("old", WorkLogStatus::Ready);
    old.ended_at = Some(5 * M);
    let mut new = stored("new", WorkLogStatus::Unsummarized);
    new.ended_at = Some(50 * M);
    let paused = stored("paused", WorkLogStatus::Paused);
    fx.seed(vec![old, paused, new]);
    let service = fx.started();
    run(&service, &[(60, prompt("live", "otra cosa"))]);
    let snapshot = service.snapshot();
    snapshot.validate().unwrap();
    let ids: Vec<&str> = snapshot
        .entries
        .iter()
        .map(|e| e.session_id.as_str())
        .collect();
    assert_eq!(ids, ["live", "paused", "new", "old"]);
    assert_eq!(snapshot.idle_pause_ms, CAP as f64);
    let live = &snapshot.entries[0];
    assert_eq!(live.project, "ms-pay");
    assert!(live.live.unwrap().turn_open);
    assert!(snapshot.entries[3].live.is_none());
    assert_eq!(snapshot.entries[3].total_ms, (10 * M) as f64);
}

#[test]
fn provisional_title_uses_the_date_and_the_first_prompt() {
    let fx = Fx::new();
    let service = fx.started();
    let at = Local
        .with_ymd_and_hms(2026, 11, 20, 10, 0, 0)
        .unwrap()
        .timestamp_millis();
    service.on_hook_event(
        &prompt(
            "s1",
            "Integrar la pasarela Cashela en ms-pay con\nfirma y webhooks",
        ),
        at,
    );
    service.on_hook_event(&prompt("s2", "Corto"), at);
    let titles: Vec<String> = service
        .snapshot()
        .entries
        .into_iter()
        .map(|e| e.title)
        .collect();
    assert!(titles
        .contains(&"Sesión del 20/11 · «Integrar la pasarela Cashela en ms-pay c…»".to_owned()));
    assert!(titles.contains(&"Sesión del 20/11 · «Corto»".to_owned()));
}

#[test]
fn snapshot_cuts_long_project_and_title_so_it_stays_valid() {
    let fx = Fx::new();
    let mut entry = stored("s1", WorkLogStatus::Ready);
    entry.cwd = format!("C:\\{}", "é".repeat(600));
    entry.summary = Some(Summary {
        title: "ñ".repeat(700),
        subtasks: vec![StoredSubtask {
            title: "x".repeat(400),
            status: WorkLogSubtaskStatus::Pending,
            turn_ids: Vec::new(),
        }],
    });
    fx.seed(vec![entry]);
    let service = fx.started();
    let snapshot = service.snapshot();
    snapshot.validate().unwrap();
    assert_eq!(snapshot.entries[0].project.chars().count(), 512);
    assert_eq!(snapshot.entries[0].title.chars().count(), 512);
}

#[test]
fn done_subtasks_carry_the_times_of_their_turns() {
    let fx = Fx::new();
    let service = fx.started();
    run(
        &service,
        &[
            (0, prompt("s1", "a")),
            (10, event(HookEventName::Stop, "s1")),
            (20, prompt("s1", "b")),
            (25, event(HookEventName::Stop, "s1")),
            (26, event(HookEventName::SessionEnd, "s1")),
        ],
    );
    service.finish_summary(
        "s1",
        Some(Summary {
            title: "Cashela".into(),
            subtasks: vec![
                StoredSubtask {
                    title: "Analizar".into(),
                    status: WorkLogSubtaskStatus::Done,
                    turn_ids: vec!["t1".into(), "t2".into()],
                },
                StoredSubtask {
                    title: "Validar".into(),
                    status: WorkLogSubtaskStatus::Pending,
                    turn_ids: Vec::new(),
                },
            ],
        }),
    );
    let view = service.snapshot().entries.remove(0);
    view.validate().unwrap();
    assert_eq!(view.title, "Cashela");
    assert_eq!(view.subtasks[0].claude_ms, Some((15 * M) as f64));
    assert_eq!(view.subtasks[0].total_ms, Some((26 * M) as f64));
    assert_eq!(view.subtasks[1].claude_ms, None);
}

#[test]
fn every_change_is_emitted() {
    let fx = Fx::new();
    let service = fx.started();
    let before = fx.emitted.lock().unwrap().len();
    run(&service, &[(0, prompt("s1", "a"))]);
    let emitted = fx.emitted.lock().unwrap().clone();
    assert_eq!(emitted.len(), before + 1);
    assert_eq!(emitted.last().unwrap(), &service.snapshot());
}

#[test]
fn a_read_only_file_refuses_changes_and_is_never_overwritten() {
    let fx = Fx::new();
    let original = r#"{"version":2,"entries":[]}"#;
    std::fs::write(fx.file(), original).unwrap();
    let service = fx.started();
    run(&service, &[(0, prompt("s1", "a"))]);
    let refused = block_on(service.set_invoiced("s1", true)).unwrap_err();
    assert_eq!(refused.code(), IpcErrorCode::ReadOnly);
    block_on(service.flush());
    assert_eq!(std::fs::read_to_string(fx.file()).unwrap(), original);
}

#[test]
fn never_logs_prompt_or_reply_text() {
    let Some(capture) = crate::services::test_log::capture() else {
        panic!("another logger is installed in the test binary");
    };
    let fx = Fx::new();
    std::fs::write(fx.file(), "{bad secret prompt").unwrap();
    let service = fx.started();
    run(
        &service,
        &[
            (0, prompt("s1", "secret prompt")),
            (1, event(HookEventName::SessionEnd, "s1")),
        ],
    );
    block_on(service.flush());
    assert!(capture
        .lines()
        .iter()
        .all(|line| !line.contains("secret prompt")));
}

#[test]
fn a_long_tool_call_paused_by_the_tick_counts_fully_when_it_ends() {
    let fx = Fx::new();
    let service = fx.started();
    let mut stop = event(HookEventName::Stop, "s1");
    stop.work = Some(WorkPayload {
        reply: Some("built".into()),
        ..WorkPayload::default()
    });
    run(
        &service,
        &[
            (0, prompt("s1", "a")),
            (1, event(HookEventName::PreToolUse, "s1")),
        ],
    );
    service.tick(40 * M);
    let entry = only(&service);
    assert_eq!(entry.status, WorkLogStatus::Paused);
    assert_eq!(entry.session.turns[0].ended_at, Some(M));
    run(
        &service,
        &[(45, event(HookEventName::PostToolUse, "s1")), (46, stop)],
    );
    let entry = only(&service);
    assert_eq!(entry.status, WorkLogStatus::Running);
    assert_eq!(entry.session.claude_ms(), 46 * M);
    assert_eq!(entry.session.total_ms(), 46 * M);
    assert_eq!(entry.session.turns[0].reply.as_deref(), Some("built"));
}

#[test]
fn an_entry_that_ended_reopens_only_with_resume() {
    let fx = Fx::new();
    let mut ended = stored("s1", WorkLogStatus::Summarizing);
    ended.ended_at = Some(10 * M);
    fx.seed(vec![ended]);
    let service = fx.started();
    assert_eq!(only(&service).status, WorkLogStatus::Paused);
    run(&service, &[(20, event(HookEventName::PostToolUse, "s1"))]);
    let entry = only(&service);
    assert_eq!(entry.status, WorkLogStatus::Paused);
    assert_eq!(entry.session.last_event_at, 10 * M);
    run(&service, &[(30, resume("s1"))]);
    let entry = only(&service);
    assert_eq!(entry.status, WorkLogStatus::Running);
    assert_eq!(entry.ended_at, None);
}

#[test]
fn buffered_events_are_replayed_in_order_under_the_lock_with_one_snapshot() {
    let fx = Fx::new();
    let service = fx.make();
    run(
        &service,
        &[
            (0, prompt("s1", "a")),
            (5, event(HookEventName::Stop, "s1")),
            (6, event(HookEventName::SessionEnd, "s1")),
        ],
    );
    block_on(service.start());
    let entry = only(&service);
    assert_eq!(entry.status, WorkLogStatus::Summarizing);
    assert_eq!(entry.session.claude_ms(), 5 * M);
    assert_eq!(fx.emitted.lock().unwrap().len(), 1);
    assert_eq!(*fx.summarizer.summarized.lock().unwrap(), ["s1"]);
}

#[test]
fn a_pending_permission_of_a_stalled_turn_stays_a_wait_through_restart_and_close() {
    let fx = Fx::new();
    let service = fx.started();
    let notice = HookEvent {
        notification_type: Some("permission_prompt".into()),
        ..event(HookEventName::Notification, "s1")
    };
    run(
        &service,
        &[
            (0, prompt("s1", "a")),
            (5, event(HookEventName::PermissionRequest, "s1")),
            (6, notice),
        ],
    );
    service.tick(40 * M);
    assert_eq!(only(&service).status, WorkLogStatus::Paused);
    assert_eq!(only(&service).session.claude_ms(), 5 * M);
    block_on(service.flush());
    let restarted = fx.started();
    assert_eq!(only(&restarted).session.claude_ms(), 5 * M);
    block_on(restarted.summarize("s1")).unwrap();
    let entry = only(&restarted);
    assert_eq!(entry.status, WorkLogStatus::Summarizing);
    assert_eq!(entry.session.claude_ms(), 5 * M);
    assert!(!entry.session.turns[0].stalled);
}

mod copy {
    use super::*;
    use crate::work_log::copy::copy_text;

    fn cashela() -> StoredEntry {
        let mut session = Session::start(0);
        let mut at = 0;
        let mut step = |s: &mut Session, name: HookEvent, minutes: i64| {
            at += minutes * M;
            s.apply(&name, at, 24 * 60 * M);
        };
        // t1: Claude 25m, total 50m (25m of gap before t2).
        step(&mut session, prompt("s1", "a"), 0);
        step(&mut session, event(HookEventName::Stop, "s1"), 25);
        // t2: Claude 2h 45m, total 4h 55m (2h 10m of gap after it).
        step(&mut session, prompt("s1", "b"), 25);
        step(&mut session, event(HookEventName::Stop, "s1"), 165);
        step(&mut session, event(HookEventName::PostToolUse, "s1"), 130);
        StoredEntry {
            session,
            status: WorkLogStatus::Ready,
            summary: Some(Summary {
                title: "Integrar la pasarela Cashela en ms-pay".into(),
                subtasks: vec![
                    StoredSubtask {
                        title: "Analizar la API Pay-In de Cashela".into(),
                        status: WorkLogSubtaskStatus::Done,
                        turn_ids: vec!["t1".into()],
                    },
                    StoredSubtask {
                        title: "Validar la firma con el vector oficial".into(),
                        status: WorkLogSubtaskStatus::Pending,
                        turn_ids: Vec::new(),
                    },
                ],
            }),
            ..stored("s1", WorkLogStatus::Ready)
        }
    }

    #[test]
    fn copies_the_task_and_its_subtasks() {
        assert_eq!(
            copy_text(&cashela(), Language::Es, None),
            "Tarea: Integrar la pasarela Cashela en ms-pay (Claude 3h 10m · Total 5h 45m)\n\
             Subtareas:\n\
             1 - Analizar la API Pay-In de Cashela (Claude 25m · Total 50m)\n\
             2 - Validar la firma con el vector oficial (pendiente)"
        );
    }

    #[test]
    fn copies_one_subtask_without_its_number() {
        assert_eq!(
            copy_text(&cashela(), Language::Es, Some(0)),
            "Analizar la API Pay-In de Cashela (Claude 25m · Total 50m)"
        );
        assert_eq!(
            copy_text(&cashela(), Language::En, Some(1)),
            "Validar la firma con el vector oficial (pending)"
        );
    }

    #[test]
    fn copies_in_english() {
        let text = copy_text(&cashela(), Language::En, None);
        assert!(text.starts_with("Task: Integrar"), "{text}");
        assert!(text.contains("\nSubtasks:\n1 - "), "{text}");
        assert!(text.ends_with("(pending)"), "{text}");
    }

    #[test]
    fn an_entry_without_summary_copies_its_provisional_title() {
        let text = copy_text(
            &stored("s1", WorkLogStatus::Unsummarized),
            Language::Es,
            None,
        );
        assert!(text.starts_with("Tarea: Sesión del "), "{text}");
        assert!(text.ends_with("(Claude 10m · Total 10m)"), "{text}");
        assert!(!text.contains("Subtareas"), "{text}");
    }
}
