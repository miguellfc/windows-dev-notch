use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::async_runtime::block_on;

use super::*;
use crate::claude::hook_events::{HookEvent, HookEventName, WorkPayload};
use crate::contract::work_log::{WorkLogStatus, WorkLogSubtaskStatus};
use crate::services::clock::WallClock;
use crate::services::test_dir::TestDir;
use crate::work_log::assign::{assign, subtask_times};
use crate::work_log::service::{
    StoredEntry, Summary, WorkLogConfig, WorkLogDeps, WorkLogFile, WorkLogService,
};
use crate::work_log::timing::Session;

const M: i64 = 60_000;
const CAP: i64 = 30 * M;
const WORK: &str = "claude-work";

fn event(name: HookEventName) -> HookEvent {
    HookEvent {
        name,
        session_id: "s1".into(),
        cwd: None,
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

fn prompt(text: &str) -> HookEvent {
    HookEvent {
        work: Some(WorkPayload {
            prompt: Some(text.into()),
            ..WorkPayload::default()
        }),
        ..event(HookEventName::UserPromptSubmit)
    }
}

fn stop(reply: &str) -> HookEvent {
    HookEvent {
        work: Some(WorkPayload {
            reply: Some(reply.into()),
            ..WorkPayload::default()
        }),
        ..event(HookEventName::Stop)
    }
}

/// Turns `t1..tn`, one every 10 minutes, 5 minutes each.
fn session_of(turns: usize, reply: &str) -> Session {
    let mut session = Session::start(0);
    for i in 0..turns as i64 {
        session.apply(&prompt(&format!("prompt {i}")), i * 10 * M, CAP);
        session.apply(&stop(reply), i * 10 * M + 5 * M, CAP);
    }
    session
}

/// The session of Task 4's first test: Claude 18m, total 50m.
fn task4_session() -> Session {
    let mut s = Session::start(0);
    s.apply(&prompt("a"), 2 * M, CAP);
    s.apply(&event(HookEventName::Stop), 12 * M, CAP);
    s.apply(&prompt("b"), 62 * M, CAP);
    s.apply(&event(HookEventName::Stop), 70 * M, CAP);
    s.close(30 * M);
    s
}

fn entry_with(session: Session, status: WorkLogStatus) -> StoredEntry {
    StoredEntry {
        session_id: "s1".into(),
        account_id: WORK.into(),
        cwd: "C:\\code\\ms-pay".into(),
        transcript_path: Some("C:\\Users\\me\\.claude-work\\projects\\x\\s1.jsonl".into()),
        status,
        invoiced: false,
        ended_at: None,
        session,
        summary: None,
        deleted_at: None,
    }
}

fn out(title: &str, subtasks: &[(&str, WorkLogSubtaskStatus, &[&str])]) -> SummaryOut {
    SummaryOut {
        title: title.into(),
        subtasks: subtasks
            .iter()
            .map(|(title, status, ids)| SubtaskOut {
                title: (*title).into(),
                status: *status,
                turn_ids: ids.iter().map(|id| (*id).to_owned()).collect(),
            })
            .collect(),
    }
}

fn cli(result: &str) -> String {
    serde_json::json!({ "type": "result", "subtype": "success", "is_error": false, "result": result })
        .to_string()
}

mod parse {
    use super::*;

    #[test]
    fn reads_the_result_inside_a_json_fence() {
        let inner = r#"{"title":"Integrar Cashela","subtasks":[{"title":"Analizar la API","status":"done","turnIds":["t1"]},{"title":"Validar la firma","status":"pending","turnIds":[]}]}"#;
        let parsed = parse_output(&cli(&format!("```json\n{inner}\n```"))).unwrap();
        assert_eq!(
            parsed,
            out(
                "Integrar Cashela",
                &[
                    ("Analizar la API", WorkLogSubtaskStatus::Done, &["t1"]),
                    ("Validar la firma", WorkLogSubtaskStatus::Pending, &[]),
                ]
            )
        );
    }

    #[test]
    fn a_result_without_json_is_invalid() {
        assert_eq!(
            parse_output(&cli("No puedo resumir esta sesión.")),
            Err(SummaryError::Invalid)
        );
        assert_eq!(parse_output("not json"), Err(SummaryError::Invalid));
    }

    #[test]
    fn more_than_forty_subtasks_is_invalid() {
        let subtasks: Vec<_> = (0..41)
            .map(|i| serde_json::json!({ "title": format!("s{i}"), "status": "pending", "turnIds": [] }))
            .collect();
        let inner = serde_json::json!({ "title": "T", "subtasks": subtasks }).to_string();
        assert_eq!(parse_output(&cli(&inner)), Err(SummaryError::Invalid));
    }

    #[test]
    fn the_title_must_have_one_to_three_hundred_chars() {
        let empty = r#"{"title":"  ","subtasks":[]}"#;
        assert_eq!(parse_output(&cli(empty)), Err(SummaryError::Invalid));
        let long = serde_json::json!({ "title": "x".repeat(301), "subtasks": [] }).to_string();
        assert_eq!(parse_output(&cli(&long)), Err(SummaryError::Invalid));
    }

    #[test]
    fn an_error_result_is_invalid() {
        let text = serde_json::json!({ "type": "result", "is_error": true, "result": "{\"title\":\"T\",\"subtasks\":[]}" })
            .to_string();
        assert_eq!(parse_output(&text), Err(SummaryError::Invalid));
    }
}

mod assigning {
    use super::*;

    #[test]
    fn unknown_and_repeated_turns_are_dropped_and_the_rest_go_to_other() {
        let session = session_of(4, "ok");
        let summary = assign(
            out(
                "Tarea",
                &[
                    ("A", WorkLogSubtaskStatus::Done, &["t1", "t2"]),
                    ("B", WorkLogSubtaskStatus::Done, &["t2", "tX"]),
                    ("C", WorkLogSubtaskStatus::Pending, &[]),
                ],
            ),
            &session,
            Language::Es,
        );
        let ids: Vec<(&str, WorkLogSubtaskStatus, Vec<&str>)> = summary
            .subtasks
            .iter()
            .map(|s| {
                (
                    s.title.as_str(),
                    s.status,
                    s.turn_ids.iter().map(String::as_str).collect(),
                )
            })
            .collect();
        assert_eq!(
            ids,
            vec![
                ("A", WorkLogSubtaskStatus::Done, vec!["t1", "t2"]),
                ("B", WorkLogSubtaskStatus::Done, vec![]),
                ("C", WorkLogSubtaskStatus::Pending, vec![]),
                ("Otros", WorkLogSubtaskStatus::Done, vec!["t3", "t4"]),
            ]
        );
        let done_total: i64 = subtask_times(&summary.subtasks, &session)
            .iter()
            .filter_map(|(_, total)| *total)
            .sum();
        assert_eq!(done_total, session.total_ms());
    }

    #[test]
    fn other_is_in_english_and_only_when_needed() {
        let session = session_of(2, "ok");
        let all = assign(
            out("T", &[("A", WorkLogSubtaskStatus::Done, &["t1", "t2"])]),
            &session,
            Language::En,
        );
        assert_eq!(all.subtasks.len(), 1);
        let pending_ids = assign(
            out("T", &[("A", WorkLogSubtaskStatus::Pending, &["t1"])]),
            &session,
            Language::En,
        );
        assert_eq!(pending_ids.subtasks[0].turn_ids, Vec::<String>::new());
        assert_eq!(pending_ids.subtasks[1].title, "Other");
        assert_eq!(pending_ids.subtasks[1].turn_ids, vec!["t1", "t2"]);
    }

    #[test]
    fn titles_are_trimmed_and_cut_and_empty_subtasks_dropped() {
        let session = session_of(1, "ok");
        let long = "y".repeat(400);
        let summary = assign(
            out(
                "  T  ",
                &[
                    ("   ", WorkLogSubtaskStatus::Done, &["t1"]),
                    (&long, WorkLogSubtaskStatus::Pending, &[]),
                ],
            ),
            &session,
            Language::Es,
        );
        assert_eq!(summary.title, "T");
        assert_eq!(summary.subtasks[0].title.chars().count(), 300);
        assert_eq!(summary.subtasks[1].title, "Otros");
        assert_eq!(summary.subtasks[1].turn_ids, vec!["t1"]);
    }

    #[test]
    fn subtask_times_add_the_turns_of_a_done_subtask() {
        let session = task4_session();
        let summary = Summary {
            title: "T".into(),
            subtasks: vec![
                crate::work_log::service::StoredSubtask {
                    title: "A".into(),
                    status: WorkLogSubtaskStatus::Done,
                    turn_ids: vec!["t1".into(), "t2".into()],
                },
                crate::work_log::service::StoredSubtask {
                    title: "B".into(),
                    status: WorkLogSubtaskStatus::Pending,
                    turn_ids: Vec::new(),
                },
            ],
        };
        assert_eq!(
            subtask_times(&summary.subtasks, &session),
            vec![(Some(18 * M), Some(50 * M)), (None, None)]
        );
    }
}

mod prompt_text {
    use super::*;

    #[test]
    fn two_hundred_long_turns_fit_in_sixty_thousand_chars() {
        let entry = entry_with(
            session_of(200, &"r".repeat(1000)),
            WorkLogStatus::Summarizing,
        );
        let text = build_prompt(&entry, Language::Es);
        assert!(text.chars().count() <= PROMPT_MAX_CHARS, "{}", text.len());
        for i in 1..=200 {
            assert!(text.contains(&format!("### t{i} ")), "t{i} missing");
        }
    }

    #[test]
    fn asks_for_json_in_the_app_language_with_the_context() {
        let entry = entry_with(session_of(2, "hecho"), WorkLogStatus::Summarizing);
        let es = build_prompt(&entry, Language::Es);
        assert!(es.contains("\"turnIds\""), "{es}");
        assert!(es.contains("Analizar la API Pay-In de Cashela"), "{es}");
        assert!(es.contains("C:\\code\\ms-pay"), "{es}");
        assert!(es.contains("s1.jsonl"), "{es}");
        assert!(es.contains("prompt 0") && es.contains("hecho"), "{es}");
        assert!(es.contains("español"), "{es}");
        let en = build_prompt(&entry, Language::En);
        assert!(en.contains("English"), "{en}");
    }

    #[test]
    fn long_prompts_are_cut_only_after_the_replies() {
        let mut session = Session::start(0);
        for i in 0..100 {
            session.apply(&prompt(&"p".repeat(3000)), i * 10 * M, CAP);
            session.apply(&stop(&"r".repeat(3000)), i * 10 * M + M, CAP);
        }
        let text = build_prompt(
            &entry_with(session, WorkLogStatus::Summarizing),
            Language::Es,
        );
        assert!(text.chars().count() <= PROMPT_MAX_CHARS);
        assert!(!text.contains("rrrr"), "the replies go first");
        assert!(text.contains("ppp"), "the prompts keep what fits");
        assert!(text.contains("### t100 "));
    }
}

mod running {
    use super::*;

    struct Fx {
        dir: TestDir,
    }

    impl Fx {
        fn new() -> Self {
            Self {
                dir: TestDir::new("work-log-summarizer"),
            }
        }

        fn script(&self, name: &str, body: &str) -> PathBuf {
            let path = self.dir.join(name);
            std::fs::write(&path, format!("@echo off\r\n{body}\r\n")).unwrap();
            path
        }

        fn summarizer(&self, claude: PathBuf, timeout: Duration) -> Arc<ClaudeSummarizer> {
            let account = self.dir.join("account");
            std::fs::create_dir_all(&account).unwrap();
            ClaudeSummarizer::new(SummarizerDeps {
                claude_override: Some(claude),
                config_dir: Arc::new(move |id: &str| {
                    (id == WORK).then(|| ConfigDir::Dir(account.clone()))
                }),
                language: Arc::new(|| Language::Es),
                work_dir: self.dir.join("work-log-summarizer"),
                timeout,
            })
        }

        /// A started service with one paused entry `s1`, wired to `summarizer`.
        fn service(&self, summarizer: &Arc<ClaudeSummarizer>) -> Arc<WorkLogService> {
            let file = self.dir.join("work-log.json");
            let entry = entry_with(session_of(2, "ok"), WorkLogStatus::Paused);
            std::fs::write(
                &file,
                serde_json::to_string(&WorkLogFile::new(vec![entry])).unwrap(),
            )
            .unwrap();
            let service = WorkLogService::new(WorkLogDeps {
                file,
                clock: Arc::new(WallClock::real()),
                now: Arc::new(|| 100 * M),
                config: Arc::new(|| WorkLogConfig {
                    enabled: true,
                    account_id: Some(WORK.into()),
                    idle_pause_ms: CAP,
                    language: Language::Es,
                }),
                summarizer: Arc::clone(summarizer) as Arc<dyn crate::work_log::service::Summarizer>,
                on_change: Arc::new(|_: &crate::contract::work_log::WorkLogSnapshot| {}),
            });
            summarizer.bind(&service);
            block_on(service.start());
            service
        }
    }

    fn wait_for(service: &WorkLogService, status: WorkLogStatus) -> StoredEntry {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let entry = service.entries().remove(0);
            if entry.status == status || Instant::now() > deadline {
                return entry;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn a_claude_slower_than_the_limit_times_out_and_the_entry_keeps_its_times() {
        let fx = Fx::new();
        let slow = fx.script(
            "slow.cmd",
            &format!(
                "ping -n 8 127.0.0.1 >nul\r\necho late> \"{}\"",
                fx.dir.join("late.txt").display()
            ),
        );
        let summarizer = fx.summarizer(slow, Duration::from_secs(1));
        let started = Instant::now();
        let entry = entry_with(session_of(2, "ok"), WorkLogStatus::Summarizing);
        assert_eq!(summarizer.summarize_now(&entry), Err(SummaryError::Timeout));
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "{:?}",
            started.elapsed()
        );

        let service = fx.service(&summarizer);
        let before = service.entries()[0].session.clone();
        block_on(service.summarize("s1")).unwrap();
        let entry = wait_for(&service, WorkLogStatus::Unsummarized);
        assert_eq!(entry.status, WorkLogStatus::Unsummarized);
        assert_eq!(entry.session.claude_ms(), before.claude_ms());
        assert_eq!(entry.session.total_ms(), before.total_ms());
        assert!(entry.summary.is_none());
        // The script was killed, not left running.
        std::thread::sleep(Duration::from_secs(8));
        assert!(!fx.dir.join("late.txt").exists());
    }

    #[test]
    fn a_missing_claude_is_not_found_and_the_entry_keeps_its_times() {
        let fx = Fx::new();
        let summarizer = fx.summarizer(
            fx.dir.join("nope").join("claude.cmd"),
            Duration::from_secs(1),
        );
        let entry = entry_with(session_of(2, "ok"), WorkLogStatus::Summarizing);
        assert_eq!(
            summarizer.summarize_now(&entry),
            Err(SummaryError::NotFound)
        );
        assert!(!summarizer.claude_available());

        let service = fx.service(&summarizer);
        let before = service.entries()[0].session.clone();
        block_on(service.summarize("s1")).unwrap();
        let entry = wait_for(&service, WorkLogStatus::Unsummarized);
        assert_eq!(entry.status, WorkLogStatus::Unsummarized);
        assert_eq!(entry.session.claude_ms(), before.claude_ms());
        assert_eq!(entry.session.total_ms(), before.total_ms());
    }

    #[test]
    fn a_failing_claude_reports_its_exit_code() {
        let fx = Fx::new();
        let failing = fx.script("failing.cmd", "exit /b 3");
        let summarizer = fx.summarizer(failing, Duration::from_secs(10));
        let entry = entry_with(session_of(1, "ok"), WorkLogStatus::Summarizing);
        assert_eq!(summarizer.summarize_now(&entry), Err(SummaryError::Exit(3)));
    }

    #[test]
    fn a_good_answer_makes_the_entry_ready_with_the_account_folder_and_the_prompt() {
        let fx = Fx::new();
        let dir = fx.dir.path().display().to_string();
        let good = fx.script(
            "good.cmd",
            &format!(
                "echo(%CLAUDE_CONFIG_DIR%> \"{dir}\\env.txt\"\r\n\
                 cd> \"{dir}\\cwd.txt\"\r\n\
                 echo(%*> \"{dir}\\args.txt\"\r\n\
                 more > \"{dir}\\stdin.txt\"\r\n\
                 echo {{\"type\":\"result\",\"is_error\":false,\"result\":\"{{\\\"title\\\":\\\"Integrar\\\",\\\"subtasks\\\":[{{\\\"title\\\":\\\"A\\\",\\\"status\\\":\\\"done\\\",\\\"turnIds\\\":[\\\"t1\\\"]}}]}}\"}}"
            ),
        );
        let summarizer = fx.summarizer(good, Duration::from_secs(20));
        assert!(summarizer.claude_available());
        let service = fx.service(&summarizer);
        block_on(service.summarize("s1")).unwrap();
        let entry = wait_for(&service, WorkLogStatus::Ready);
        assert_eq!(entry.status, WorkLogStatus::Ready);
        let summary = entry.summary.unwrap();
        assert_eq!(summary.title, "Integrar");
        assert_eq!(summary.subtasks[0].turn_ids, vec!["t1"]);
        assert_eq!(summary.subtasks[1].title, "Otros");
        assert_eq!(summary.subtasks[1].turn_ids, vec!["t2"]);

        let read = |name: &str| std::fs::read_to_string(fx.dir.join(name)).unwrap();
        assert_eq!(
            read("env.txt").trim(),
            fx.dir.join("account").display().to_string()
        );
        assert_eq!(
            read("cwd.txt").trim(),
            fx.dir.join("work-log-summarizer").display().to_string()
        );
        let settings = fx.dir.join("work-log-summarizer").join("settings.json");
        assert_eq!(
            read("args.txt").trim(),
            format!(
                "-p --output-format json --tools Read --allowedTools Read --disallowedTools Bash Edit Write NotebookEdit WebFetch WebSearch --permission-mode dontAsk --strict-mcp-config --settings {}",
                settings.display()
            )
        );
        let written: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(
            written,
            serde_json::json!({
                "disableAllHooks": true,
                "permissions": {
                    "deny": ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"],
                    "defaultMode": "dontAsk",
                },
            })
        );
        assert!(read("stdin.txt").contains("### t2 "));
    }

    #[test]
    fn a_descendant_holding_stdout_after_the_exit_still_times_out() {
        let fx = Fx::new();
        // `start /b` leaves ping running with the inherited stdout after the script exits 0.
        let lingering = fx.script(
            "lingering.cmd",
            "start /b ping -n 8 127.0.0.1
exit /b 0",
        );
        let summarizer = fx.summarizer(lingering, Duration::from_secs(1));
        let entry = entry_with(session_of(1, "ok"), WorkLogStatus::Summarizing);
        let started = Instant::now();
        assert_eq!(summarizer.summarize_now(&entry), Err(SummaryError::Timeout));
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn a_panic_still_leaves_the_entry_unsummarized() {
        let fx = Fx::new();
        let script = fx.script("claude.cmd", "exit /b 0");
        let summarizer = ClaudeSummarizer::new(SummarizerDeps {
            claude_override: Some(script),
            config_dir: Arc::new(|_: &str| panic!("no accounts")),
            language: Arc::new(|| Language::Es),
            work_dir: fx.dir.join("work-log-summarizer"),
            timeout: Duration::from_secs(1),
        });
        let service = fx.service(&summarizer);
        block_on(service.summarize("s1")).unwrap();
        let entry = wait_for(&service, WorkLogStatus::Unsummarized);
        assert_eq!(entry.status, WorkLogStatus::Unsummarized);
    }

    #[test]
    fn the_override_wins_and_a_missing_one_finds_nothing() {
        let fx = Fx::new();
        let script = fx.script("claude.cmd", "exit /b 0");
        let env: crate::apps::launcher::Env = Vec::new();
        let exists = |path: &str| std::path::Path::new(path).is_file();
        assert_eq!(
            find_claude(Some(&script), &env, &exists),
            Some(script.clone())
        );
        assert_eq!(
            find_claude(Some(&fx.dir.join("nope.cmd")), &env, &exists),
            None
        );
        let env: crate::apps::launcher::Env =
            vec![("PATH".into(), fx.dir.path().display().to_string().into())];
        assert_eq!(
            find_claude(None, &env, &exists),
            Some(PathBuf::from(
                fx.dir.join("claude.cmd").display().to_string()
            ))
        );
    }

    #[test]
    fn its_own_runs_are_never_recorded() {
        let fx = Fx::new();
        let summarizer = fx.summarizer(fx.dir.join("claude.cmd"), Duration::from_secs(1));
        let own = HookEvent {
            cwd: Some(format!("{}\\", fx.dir.join("work-log-summarizer").display()).to_uppercase()),
            ..event(HookEventName::SessionStart)
        };
        assert!(crate::work_log::service::Summarizer::is_own_session(
            &*summarizer,
            &own
        ));
        let other = HookEvent {
            cwd: Some("C:\\code\\ms-pay".into()),
            ..event(HookEventName::SessionStart)
        };
        assert!(!crate::work_log::service::Summarizer::is_own_session(
            &*summarizer,
            &other
        ));

        // Through the service: the summarizer's own session makes no entry.
        let service = fx.service(&summarizer);
        let own_prompt = HookEvent {
            session_id: "own".into(),
            cwd: own.cwd.clone(),
            ..prompt("Resume esta sesión")
        };
        service.on_hook_event(&own_prompt, 200 * M);
        assert_eq!(service.entries().len(), 1);
        let mine = HookEvent {
            session_id: "s2".into(),
            cwd: other.cwd.clone(),
            ..prompt("hola")
        };
        service.on_hook_event(&mine, 200 * M);
        assert_eq!(service.entries().len(), 2);
    }
}

mod account_folder {
    use super::*;
    use crate::claude::accounts::ClaudeAccount;

    fn account(id: &str, dir: &str) -> ClaudeAccount {
        ClaudeAccount {
            id: id.into(),
            dir: PathBuf::from(dir),
            settings_file: PathBuf::from(dir).join("settings.json"),
            email: None,
            organization: None,
        }
    }

    fn accounts() -> Vec<ClaudeAccount> {
        vec![
            account("claude", "C:/home/.claude"),
            // A linked folder that lost its profile is still listed by the directory.
            account("claude-work", "C:/home/.claude-work"),
            account("dir-0123abcd", "D:/other/claude"),
        ]
    }

    #[test]
    fn the_account_list_gives_each_folder_and_the_real_default_runs_without_it() {
        assert_eq!(
            config_dir_for(&accounts(), "claude", true),
            Some(ConfigDir::Default)
        );
        assert_eq!(
            config_dir_for(&accounts(), "claude-work", true),
            Some(ConfigDir::Dir(PathBuf::from("C:/home/.claude-work")))
        );
        assert_eq!(
            config_dir_for(&accounts(), "dir-0123abcd", true),
            Some(ConfigDir::Dir(PathBuf::from("D:/other/claude")))
        );
        assert_eq!(config_dir_for(&accounts(), "claude-gone", true), None);
    }

    #[test]
    fn with_another_home_the_default_account_runs_with_its_folder() {
        assert_eq!(
            config_dir_for(&accounts(), "claude", false),
            Some(ConfigDir::Dir(PathBuf::from("C:/home/.claude")))
        );
    }
}
