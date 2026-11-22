use super::*;
use crate::claude::hook_events::{HookEvent, HookEventName, WorkPayload};

const M: i64 = 60_000;
const CAP: i64 = 30 * M;

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
        account_id: "claude".into(),
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

fn tool(name: HookEventName, tool_name: &str) -> HookEvent {
    HookEvent {
        tool_name: Some(tool_name.into()),
        ..event(name)
    }
}

fn run(session: &mut Session, steps: &[(i64, HookEvent)]) {
    for (minutes, ev) in steps {
        session.apply(ev, minutes * M, CAP);
    }
}

#[test]
fn idle_gap_between_turns_is_capped() {
    let mut s = Session::start(0);
    run(
        &mut s,
        &[
            (2, prompt("a")),
            (12, event(HookEventName::Stop)),
            (62, prompt("b")),
            (70, event(HookEventName::Stop)),
        ],
    );
    s.close(70 * M);
    assert_eq!(s.claude_ms(), 18 * M);
    assert_eq!(s.total_ms(), 50 * M);
    assert_eq!(s.turn_totals(), vec![42 * M, 8 * M]);
    assert_eq!(s.turn_totals().iter().sum::<i64>(), s.total_ms());
}

#[test]
fn long_tool_inside_a_turn_has_no_excess() {
    let mut s = Session::start(0);
    run(
        &mut s,
        &[
            (0, prompt("a")),
            (1, tool(HookEventName::PreToolUse, "Bash")),
            (45, tool(HookEventName::PostToolUse, "Bash")),
            (46, event(HookEventName::Stop)),
        ],
    );
    assert_eq!(s.claude_ms(), 46 * M);
    assert_eq!(s.total_ms(), 46 * M);
    assert_eq!(s.turns[0].tools.get("Bash"), Some(&1));
}

#[test]
fn permission_wait_is_not_claude_time() {
    let mut s = Session::start(0);
    run(
        &mut s,
        &[
            (0, prompt("a")),
            (5, event(HookEventName::PermissionRequest)),
            (25, tool(HookEventName::PreToolUse, "Bash")),
            (30, event(HookEventName::Stop)),
        ],
    );
    assert_eq!(s.claude_ms(), 10 * M);
    assert_eq!(s.total_ms(), 30 * M);
}

#[test]
fn ask_user_question_counts_as_a_wait() {
    let mut s = Session::start(0);
    run(
        &mut s,
        &[
            (0, prompt("a")),
            (5, tool(HookEventName::PreToolUse, "AskUserQuestion")),
            (25, tool(HookEventName::PostToolUse, "AskUserQuestion")),
            (30, event(HookEventName::Stop)),
        ],
    );
    assert_eq!(s.claude_ms(), 10 * M);
}

#[test]
fn a_new_prompt_closes_a_turn_left_open_at_its_last_event() {
    let mut s = Session::start(0);
    run(
        &mut s,
        &[
            (0, prompt("a")),
            (3, tool(HookEventName::PreToolUse, "Bash")),
            (20, prompt("b")),
            (25, event(HookEventName::Stop)),
        ],
    );
    assert_eq!(s.turns[0].ended_at, Some(3 * M));
    assert_eq!(s.claude_ms(), 8 * M);
    assert_eq!(s.total_ms(), 25 * M);
}

#[test]
fn session_without_turns_still_caps_idle_time() {
    let mut s = Session::start(0);
    run(&mut s, &[(50, event(HookEventName::SessionEnd))]);
    assert_eq!(s.total_ms(), 30 * M);
    assert_eq!(s.claude_ms(), 0);
    assert!(s.turn_totals().is_empty());
}

#[test]
fn live_total_adds_the_capped_idle_time() {
    let mut s = Session::start(0);
    run(
        &mut s,
        &[(0, prompt("a")), (10, event(HookEventName::Stop))],
    );
    assert_eq!(s.live_total_ms(55 * M, CAP), 40 * M);
}

#[test]
fn stop_keeps_the_reply_and_prompt_id_names_the_turn() {
    let mut s = Session::start(0);
    let mut p = prompt("a");
    p.work.as_mut().unwrap().prompt_id = Some("p1".into());
    let mut stop = event(HookEventName::Stop);
    stop.work = Some(WorkPayload {
        reply: Some("done".into()),
        ..WorkPayload::default()
    });
    run(&mut s, &[(0, p), (1, stop), (2, prompt("b"))]);
    assert_eq!(s.turns[0].id, "p1");
    assert_eq!(s.turns[0].reply.as_deref(), Some("done"));
    assert_eq!(s.turns[1].id, "t2");
}

#[test]
fn session_end_does_not_stretch_a_stalled_turn() {
    let mut s = Session::start(0);
    run(
        &mut s,
        &[
            (0, prompt("a")),
            (3, tool(HookEventName::PreToolUse, "Bash")),
            (300, event(HookEventName::SessionEnd)),
        ],
    );
    assert_eq!(s.turns[0].ended_at, Some(3 * M));
    assert_eq!(s.claude_ms(), 3 * M);
    assert_eq!(s.total_ms(), 33 * M);
    assert_eq!(s.turn_totals().iter().sum::<i64>(), s.total_ms());
}

#[test]
fn session_start_and_idle_notification_close_a_stalled_turn() {
    for name in [HookEventName::SessionStart, HookEventName::Notification] {
        let mut s = Session::start(0);
        let mut late = event(name);
        late.notification_type = Some("idle_prompt".into());
        run(
            &mut s,
            &[
                (0, prompt("a")),
                (5, tool(HookEventName::PreToolUse, "Bash")),
                (200, late),
            ],
        );
        assert_eq!(s.turns[0].ended_at, Some(5 * M), "{name:?}");
        assert_eq!(s.claude_ms(), 5 * M, "{name:?}");
        assert_eq!(s.total_ms(), 35 * M, "{name:?}");
    }
}

#[test]
fn a_permission_prompt_notification_keeps_the_turn_open() {
    let mut s = Session::start(0);
    let mut notice = event(HookEventName::Notification);
    notice.notification_type = Some("permission_prompt".into());
    run(
        &mut s,
        &[
            (0, prompt("a")),
            (5, event(HookEventName::PermissionRequest)),
            (6, notice),
            (15, tool(HookEventName::PreToolUse, "Bash")),
            (20, event(HookEventName::Stop)),
        ],
    );
    assert_eq!(s.turns[0].ended_at, Some(20 * M));
    assert_eq!(s.claude_ms(), 10 * M);
    assert_eq!(s.total_ms(), 20 * M);
}

#[test]
fn an_earlier_timestamp_never_makes_times_negative() {
    let mut s = Session::start(10 * M);
    run(
        &mut s,
        &[
            (12, prompt("a")),
            (5, tool(HookEventName::PreToolUse, "Bash")),
            (1, event(HookEventName::Stop)),
            (0, prompt("b")),
            (0, event(HookEventName::Stop)),
        ],
    );
    assert!(s.total_ms() >= 0);
    assert!(s.claude_ms() >= 0);
    assert!(
        s.turn_totals().iter().all(|t| *t >= 0),
        "{:?}",
        s.turn_totals()
    );
    assert_eq!(s.turn_totals().iter().sum::<i64>(), s.total_ms());
    assert!(s.turns.iter().all(|t| t.ended_at.unwrap() >= t.started_at));
}

#[test]
fn a_permission_still_pending_at_stop_is_waiting_time() {
    let mut s = Session::start(0);
    run(
        &mut s,
        &[
            (0, prompt("a")),
            (4, event(HookEventName::PermissionRequest)),
            (24, event(HookEventName::Stop)),
        ],
    );
    assert_eq!(s.turns[0].wait_ms, 20 * M);
    assert_eq!(s.claude_ms(), 4 * M);
    assert_eq!(s.total_ms(), 24 * M);
}

#[test]
fn compaction_mid_turn_keeps_the_turn_running() {
    let mut s = Session::start(0);
    let mut stop = event(HookEventName::Stop);
    stop.work = Some(WorkPayload {
        reply: Some("done".into()),
        ..WorkPayload::default()
    });
    let mut compact = event(HookEventName::SessionStart);
    compact.source = Some("compact".into());
    run(
        &mut s,
        &[
            (0, prompt("a")),
            (2, tool(HookEventName::PreToolUse, "Bash")),
            (4, compact),
            (6, tool(HookEventName::PreToolUse, "Edit")),
            (8, stop),
        ],
    );
    assert_eq!(s.turns.len(), 1);
    assert_eq!(s.turns[0].ended_at, Some(8 * M));
    assert_eq!(s.turns[0].reply.as_deref(), Some("done"));
    assert_eq!(s.turns[0].tools.get("Edit"), Some(&1));
    assert_eq!(s.claude_ms(), 8 * M);
}

#[test]
fn a_turn_closed_as_stalled_reopens_with_its_next_tool_event() {
    let mut s = Session::start(0);
    let mut stop = event(HookEventName::Stop);
    stop.work = Some(WorkPayload {
        reply: Some("built".into()),
        ..WorkPayload::default()
    });
    run(
        &mut s,
        &[
            (0, prompt("a")),
            (1, tool(HookEventName::PreToolUse, "Bash")),
        ],
    );
    s.close_stalled();
    assert_eq!(s.turns[0].ended_at, Some(M));
    run(
        &mut s,
        &[(45, tool(HookEventName::PostToolUse, "Bash")), (46, stop)],
    );
    assert_eq!(s.claude_ms(), 46 * M);
    assert_eq!(s.total_ms(), 46 * M);
    assert_eq!(s.turns[0].reply.as_deref(), Some("built"));
}

#[test]
fn a_new_prompt_after_a_stalled_turn_does_not_reopen_it() {
    let mut s = Session::start(0);
    run(
        &mut s,
        &[
            (0, prompt("a")),
            (1, tool(HookEventName::PreToolUse, "Bash")),
        ],
    );
    s.close_stalled();
    run(
        &mut s,
        &[(60, prompt("b")), (61, event(HookEventName::Stop))],
    );
    assert_eq!(s.turns[0].ended_at, Some(M));
    assert_eq!(s.claude_ms(), 2 * M);
    assert_eq!(s.total_ms(), 32 * M);
}

#[test]
fn a_stalled_turn_waiting_for_a_permission_counts_the_wait_as_wait() {
    let mut s = Session::start(0);
    let mut notice = event(HookEventName::Notification);
    notice.notification_type = Some("permission_prompt".into());
    run(
        &mut s,
        &[
            (0, prompt("a")),
            (5, event(HookEventName::PermissionRequest)),
            (6, notice),
        ],
    );
    s.close_stalled();
    assert_eq!(s.claude_ms(), 5 * M);
    assert_eq!(s.turns[0].claude_ms(), 5 * M);
    // Settled for good (restart, Cerrar y resumir): still a wait.
    s.close(99 * M);
    assert_eq!(s.claude_ms(), 5 * M);
    assert!(!s.turns[0].stalled);
}

#[test]
fn a_waiting_notification_on_a_stalled_turn_is_never_counted_twice() {
    let mut s = Session::start(0);
    run(
        &mut s,
        &[
            (0, prompt("a")),
            (1, tool(HookEventName::PreToolUse, "Bash")),
        ],
    );
    s.close_stalled();
    let mut notice = event(HookEventName::Notification);
    notice.notification_type = Some("permission_prompt".into());
    run(
        &mut s,
        &[
            (41, notice),
            (45, tool(HookEventName::PostToolUse, "Bash")),
            (46, event(HookEventName::Stop)),
        ],
    );
    assert_eq!(s.total_ms(), 46 * M);
    assert_eq!(s.turn_totals().iter().sum::<i64>(), s.total_ms());
    assert_eq!(s.turns[0].excess_after_ms, 0);
}
