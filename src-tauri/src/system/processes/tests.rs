//! Port of 0.1.0's `process-sampler.test.ts` (every case) plus
//! `kill_refuses_every_unsafe_target`. "Throws" is a panicking fake.

use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

use super::*;
use crate::contract::system::PROCESS_LIMIT;
use crate::contract::Validate;
use crate::system::fake::FakeSystemApi;

const SELF: u32 = 100;
const SESSION: i64 = 1;
const START: &str = "2026-11-10T00:00:00.000Z";

struct Fx {
    api: Arc<FakeSystemApi>,
    clock: Arc<AtomicU64>,
}

impl Fx {
    fn new() -> Self {
        let api = Arc::new(FakeSystemApi::new());
        {
            let mut state = api.state();
            state.cpu_count = 4;
            state.self_pid = SELF;
            state.self_session_id = SESSION;
        }
        Self {
            api,
            clock: Arc::new(AtomicU64::new(0)),
        }
    }

    fn sampler(&self) -> ProcessSampler {
        let clock = Arc::clone(&self.clock);
        ProcessSampler::new(
            Arc::clone(&self.api) as Arc<dyn SystemApi>,
            Arc::new(move || clock.load(AtomicOrdering::SeqCst)),
        )
    }

    fn at(&self, t: u64) {
        self.clock.store(t, AtomicOrdering::SeqCst);
    }

    fn add(&self, pid: u32, info: Option<ProcessInfo>) {
        self.add_child(pid, info, 1);
    }

    fn add_child(&self, pid: u32, info: Option<ProcessInfo>, parent_pid: u32) {
        let mut state = self.api.state();
        state.entries.push(ProcessEntry {
            pid,
            parent_pid,
            name: format!("p{pid}"),
        });
        state.infos.insert(pid, info);
    }

    fn set(&self, pid: u32, info: Option<ProcessInfo>) {
        self.api.state().infos.insert(pid, info);
    }

    fn terminated(&self) -> Vec<(u32, String)> {
        self.api.state().terminated.clone()
    }
}

fn info() -> ProcessInfo {
    ProcessInfo {
        cpu_ms: 0.0,
        private_bytes: Some(1000),
        start_time: START.into(),
        owner: Owner::Self_,
        critical: false,
        session_id: SESSION,
    }
}

fn cpu(cpu_ms: f64) -> Option<ProcessInfo> {
    Some(ProcessInfo { cpu_ms, ..info() })
}

fn cpu_started(cpu_ms: f64, start_time: &str) -> Option<ProcessInfo> {
    Some(ProcessInfo {
        cpu_ms,
        start_time: start_time.into(),
        ..info()
    })
}

fn ram(private_bytes: u64) -> Option<ProcessInfo> {
    Some(ProcessInfo {
        private_bytes: Some(private_bytes),
        ..info()
    })
}

fn cpu_ram(cpu_ms: f64, private_bytes: u64) -> Option<ProcessInfo> {
    Some(ProcessInfo {
        cpu_ms,
        private_bytes: Some(private_bytes),
        ..info()
    })
}

fn kill_input(pid: u64, start_time: &str) -> KillInput {
    KillInput {
        pid,
        start_time: start_time.into(),
    }
}

fn top(s: &mut ProcessSampler, by: ProcessOrder) -> Vec<ProcessRow> {
    s.top(by, PROCESS_LIMIT)
}

fn pids(rows: &[ProcessRow]) -> Vec<u64> {
    rows.iter().map(|row| row.pid).collect()
}

fn row_of(rows: &[ProcessRow], pid: u64) -> &ProcessRow {
    rows.iter().find(|row| row.pid == pid).unwrap()
}

// --- cpu ---

#[test]
fn cpu_is_null_on_first_sight_and_computed_from_deltas_over_cpu_count_afterwards() {
    let f = Fx::new();
    f.add(10, cpu(1000.0));
    let mut s = f.sampler();
    assert_eq!(top(&mut s, ProcessOrder::Cpu)[0].cpu_percent, None);
    f.at(1000);
    f.set(10, cpu(3000.0));
    // 2000 ms of CPU over 1000 ms x 4 cores = 50 %
    assert_eq!(top(&mut s, ProcessOrder::Cpu)[0].cpu_percent, Some(50.0));
}

#[test]
fn cpu_rounds_to_one_decimal_and_clamps_to_0_100() {
    let f = Fx::new();
    f.add(10, cpu(0.0));
    f.add(11, cpu_started(0.0, "b"));
    f.add(12, cpu_started(5000.0, "c"));
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Cpu);
    f.at(3000);
    f.set(10, cpu(1000.0)); // 1000 / 12000 = 8.333 %
    f.set(11, cpu_started(99_999.0, "b"));
    f.set(12, cpu_started(1000.0, "c")); // went backwards
    let rows = top(&mut s, ProcessOrder::Cpu);
    assert_eq!(row_of(&rows, 10).cpu_percent, Some(8.3));
    assert_eq!(row_of(&rows, 11).cpu_percent, Some(100.0));
    assert_eq!(row_of(&rows, 12).cpu_percent, Some(0.0));
}

#[test]
fn cpu_treats_a_pid_whose_start_time_changed_as_a_new_process() {
    let f = Fx::new();
    f.add(10, cpu(1000.0));
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Cpu);
    f.at(1000);
    f.set(10, cpu_started(2000.0, "2026-11-10T01:00:00.000Z"));
    assert_eq!(top(&mut s, ProcessOrder::Cpu)[0].cpu_percent, None);
}

#[test]
fn cpu_keeps_the_baseline_and_last_value_when_called_again_within_500_ms() {
    let f = Fx::new();
    f.add(10, cpu(0.0));
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Cpu);
    f.at(100);
    f.set(10, cpu(400.0));
    assert_eq!(top(&mut s, ProcessOrder::Cpu)[0].cpu_percent, None); // tiny dt ignored
    f.at(1000);
    f.set(10, cpu(2000.0));
    assert_eq!(top(&mut s, ProcessOrder::Cpu)[0].cpu_percent, Some(50.0)); // against t=0
    f.at(1100);
    f.set(10, cpu(2400.0));
    assert_eq!(top(&mut s, ProcessOrder::Ram)[0].cpu_percent, Some(50.0)); // last value reused
    f.at(2000);
    f.set(10, cpu(2400.0));
    // 400 ms over 1000 ms x 4 against t=1000
    assert_eq!(top(&mut s, ProcessOrder::Cpu)[0].cpu_percent, Some(10.0));
}

#[test]
fn cpu_reset_forgets_the_baseline() {
    let f = Fx::new();
    f.add(10, cpu(1000.0));
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Cpu);
    s.reset();
    f.at(1000);
    f.set(10, cpu(2000.0));
    assert_eq!(top(&mut s, ProcessOrder::Cpu)[0].cpu_percent, None);
}

// --- ordering ---

fn three_processes() -> (Fx, ProcessSampler) {
    let f = Fx::new();
    f.add(10, cpu_ram(0.0, 300));
    f.add(11, cpu_ram(0.0, 100));
    f.add(12, cpu_ram(0.0, 200));
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Cpu);
    f.at(1000);
    f.set(10, cpu_ram(400.0, 300)); // 10 %
    f.set(11, cpu_ram(2000.0, 100)); // 50 %
    f.set(12, cpu_ram(800.0, 200)); // 20 %
    f.add(
        13,
        Some(ProcessInfo {
            private_bytes: Some(50),
            start_time: "new".into(),
            ..info()
        }),
    ); // first sight -> null
    (f, s)
}

#[test]
fn sorts_by_cpu_desc_with_null_last() {
    let (_f, mut s) = three_processes();
    assert_eq!(pids(&top(&mut s, ProcessOrder::Cpu)), [11, 12, 10, 13]);
}

#[test]
fn sorts_by_ram_desc_with_null_last() {
    let (f, mut s) = three_processes();
    f.add(14, None);
    assert_eq!(pids(&top(&mut s, ProcessOrder::Ram)), [10, 12, 11, 13, 14]);
}

#[test]
fn breaks_cpu_ties_by_private_bytes_then_pid_and_ram_ties_by_cpu_then_pid() {
    let f = Fx::new();
    f.add(20, ram(100));
    f.add(21, ram(500));
    f.add(22, ram(500));
    let mut s = f.sampler();
    assert_eq!(pids(&top(&mut s, ProcessOrder::Cpu)), [21, 22, 20]);
    assert_eq!(pids(&top(&mut s, ProcessOrder::Ram)), [21, 22, 20]);
}

#[test]
fn limits_to_process_limit_by_default_and_honours_a_custom_limit() {
    let f = Fx::new();
    for pid in 10..20 {
        f.add(pid, ram(u64::from(pid)));
    }
    let mut s = f.sampler();
    assert_eq!(top(&mut s, ProcessOrder::Ram).len(), PROCESS_LIMIT);
    assert_eq!(pids(&s.top(ProcessOrder::Ram, 3)), [19, 18, 17]);
}

// --- rows ---

#[test]
fn degrades_a_process_whose_info_is_unreadable_to_nulls_and_not_killable() {
    let f = Fx::new();
    f.add(10, None);
    let rows = top(&mut f.sampler(), ProcessOrder::Cpu);
    assert_eq!(rows[0].pid, 10);
    assert_eq!(rows[0].cpu_percent, None);
    assert_eq!(rows[0].private_bytes, None);
    assert!(!rows[0].killable);
}

#[test]
fn produces_rows_that_satisfy_the_row_schema_and_truncates_long_names() {
    let f = Fx::new();
    f.add(10, Some(info()));
    f.api.state().entries[0].name = "x".repeat(400);
    f.add(11, None);
    f.add(
        12,
        Some(ProcessInfo {
            private_bytes: None,
            ..info()
        }),
    );
    let rows = top(&mut f.sampler(), ProcessOrder::Cpu);
    for row in &rows {
        assert_eq!(row.validate(), Ok(()));
    }
    assert_eq!(row_of(&rows, 10).name.len(), 260);
}

#[test]
fn a_long_name_never_splits_a_character() {
    let f = Fx::new();
    f.add(10, Some(info()));
    // 259 units, then a two-unit character that would not fit.
    f.api.state().entries[0].name = format!("{}\u{1F600}", "x".repeat(259));
    let rows = top(&mut f.sampler(), ProcessOrder::Cpu);
    assert_eq!(rows[0].name, "x".repeat(259));
}

#[test]
fn omits_pid_0() {
    let f = Fx::new();
    f.add(0, Some(info()));
    f.add(10, Some(info()));
    assert_eq!(pids(&top(&mut f.sampler(), ProcessOrder::Cpu)), [10]);
}

#[test]
fn survives_a_throwing_processes() {
    let f = Fx::new();
    f.api.state().throwing.insert("processes");
    assert_eq!(top(&mut f.sampler(), ProcessOrder::Cpu), []);
}

// --- killable ---

fn killable_of(f: &Fx, pid: u64) -> Option<bool> {
    f.sampler()
        .top(ProcessOrder::Cpu, 50)
        .iter()
        .find(|row| row.pid == pid)
        .map(|row| row.killable)
}

#[test]
fn killable_for_an_own_non_critical_process_in_the_same_session() {
    let f = Fx::new();
    f.add(10, Some(info()));
    assert_eq!(killable_of(&f, 10), Some(true));
}

#[test]
fn not_killable_for_another_user_unknown_owner_critical_or_another_or_unreadable_session() {
    let cases: [(&str, ProcessInfo); 5] = [
        (
            "another user",
            ProcessInfo {
                owner: Owner::Other,
                ..info()
            },
        ),
        (
            "unknown owner",
            ProcessInfo {
                owner: Owner::Unknown,
                ..info()
            },
        ),
        (
            "critical",
            ProcessInfo {
                critical: true,
                ..info()
            },
        ),
        (
            "another session",
            ProcessInfo {
                session_id: 2,
                ..info()
            },
        ),
        (
            "unreadable session",
            ProcessInfo {
                session_id: -1,
                ..info()
            },
        ),
    ];
    for (label, case) in cases {
        let f = Fx::new();
        f.add(10, Some(case));
        assert_eq!(killable_of(&f, 10), Some(false), "{label}");
    }
}

#[test]
fn not_killable_for_every_process_when_the_notch_session_is_unreadable() {
    let f = Fx::new();
    f.add(
        10,
        Some(ProcessInfo {
            session_id: -1,
            ..info()
        }),
    );
    f.add(11, Some(info()));
    f.api.state().self_session_id = -1;
    let rows = f.sampler().top(ProcessOrder::Cpu, 50);
    assert!(rows.iter().all(|row| !row.killable));
}

#[test]
fn not_killable_for_the_notch_itself() {
    let f = Fx::new();
    f.add(SELF, Some(info()));
    assert_eq!(killable_of(&f, u64::from(SELF)), Some(false));
}

#[test]
fn not_killable_for_pid_4() {
    let f = Fx::new();
    f.add(4, Some(info()));
    assert_eq!(killable_of(&f, 4), Some(false));
}

#[test]
fn not_killable_for_direct_and_transitive_descendants_of_the_notch() {
    let f = Fx::new();
    f.add_child(SELF, Some(info()), 1);
    f.add_child(200, Some(info()), SELF);
    f.add_child(300, Some(info()), 200);
    f.add_child(400, Some(info()), 1);
    let rows = f.sampler().top(ProcessOrder::Cpu, 50);
    assert!(!row_of(&rows, 200).killable);
    assert!(!row_of(&rows, 300).killable);
    assert!(row_of(&rows, 400).killable);
}

#[test]
fn terminates_on_parent_cycles_without_hanging() {
    let f = Fx::new();
    f.add_child(500, Some(info()), 600);
    f.add_child(600, Some(info()), 500);
    f.add_child(700, Some(info()), 700);
    let rows = f.sampler().top(ProcessOrder::Cpu, 50);
    assert!(rows.iter().all(|row| row.killable));
}

// --- kill ---

#[test]
fn kills_a_killable_process_from_the_last_list() {
    let f = Fx::new();
    f.add(10, Some(info()));
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Cpu);
    assert_eq!(s.kill(&kill_input(10, START)), KillResult::Killed);
    assert_eq!(f.terminated(), [(10, START.to_owned())]);
}

#[test]
fn kill_refuses_a_pid_that_was_not_in_the_last_list() {
    let f = Fx::new();
    for pid in 10..20 {
        f.add(pid, ram(u64::from(pid)));
    }
    let mut s = f.sampler();
    assert_eq!(s.kill(&kill_input(19, START)), KillResult::NotKillable); // no top() yet
    top(&mut s, ProcessOrder::Ram);
    assert_eq!(s.kill(&kill_input(10, START)), KillResult::NotKillable); // outside the top 5
    assert_eq!(s.kill(&kill_input(999, START)), KillResult::NotKillable);
    assert_eq!(f.terminated(), []);
}

#[test]
fn kill_refuses_a_start_time_that_differs_from_the_listed_one() {
    let f = Fx::new();
    f.add(10, Some(info()));
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Cpu);
    assert_eq!(
        s.kill(&kill_input(10, "2026-11-10T09:00:00.000Z")),
        KillResult::NotKillable
    );
    assert_eq!(f.terminated(), []);
}

#[test]
fn kill_reports_gone_when_the_process_disappeared_or_its_pid_was_reused() {
    let f = Fx::new();
    f.add(10, Some(info()));
    f.add(11, Some(info()));
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Cpu);
    f.set(10, None);
    f.set(11, cpu_started(0.0, "2026-11-10T05:00:00.000Z"));
    assert_eq!(s.kill(&kill_input(10, START)), KillResult::Gone);
    assert_eq!(s.kill(&kill_input(11, START)), KillResult::Gone);
    assert_eq!(f.terminated(), []);
}

#[test]
fn kill_refuses_a_listed_row_that_is_not_killable() {
    let f = Fx::new();
    f.add(
        10,
        Some(ProcessInfo {
            owner: Owner::Other,
            ..info()
        }),
    );
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Cpu);
    assert_eq!(s.kill(&kill_input(10, START)), KillResult::NotKillable);
    assert_eq!(f.terminated(), []);
}

#[test]
fn kill_revalidates_and_refuses_a_process_that_stopped_being_killable() {
    let f = Fx::new();
    f.add(10, Some(info()));
    f.add(11, Some(info()));
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Cpu);
    f.set(
        10,
        Some(ProcessInfo {
            critical: true,
            ..info()
        }),
    );
    {
        let mut state = f.api.state();
        state.entries.push(ProcessEntry {
            pid: SELF,
            parent_pid: 1,
            name: "notch".into(),
        });
        state
            .entries
            .iter_mut()
            .find(|entry| entry.pid == 11)
            .unwrap()
            .parent_pid = SELF;
    }
    assert_eq!(s.kill(&kill_input(10, START)), KillResult::NotKillable);
    assert_eq!(s.kill(&kill_input(11, START)), KillResult::NotKillable);
    assert_eq!(f.terminated(), []);
}

#[test]
fn kill_refuses_when_the_fresh_process_snapshot_fails() {
    let f = Fx::new();
    f.add(10, Some(info()));
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Cpu);
    f.api.state().throwing.insert("processes");
    assert_eq!(s.kill(&kill_input(10, START)), KillResult::NotKillable);
    assert_eq!(f.terminated(), []);
}

#[test]
fn kill_refuses_an_empty_start_time_a_null_info_row_the_notch_pid_4_and_a_listed_descendant() {
    let f = Fx::new();
    f.add_child(SELF, Some(info()), 1);
    f.add_child(4, Some(info()), 0);
    f.add_child(200, Some(info()), SELF);
    f.add(10, None);
    let mut s = f.sampler();
    let rows = s.top(ProcessOrder::Cpu, 50);
    assert_eq!(row_of(&rows, 10).start_time, "");
    assert_eq!(s.kill(&kill_input(10, "")), KillResult::NotKillable);
    assert_eq!(
        s.kill(&kill_input(u64::from(SELF), START)),
        KillResult::NotKillable
    );
    assert_eq!(s.kill(&kill_input(4, START)), KillResult::NotKillable);
    assert_eq!(s.kill(&kill_input(200, START)), KillResult::NotKillable);
    assert_eq!(f.terminated(), []);
}

#[test]
fn kill_reports_gone_when_process_info_throws() {
    let f = Fx::new();
    f.add(10, Some(info()));
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Cpu);
    f.api.state().throwing.insert("processInfo");
    assert_eq!(s.kill(&kill_input(10, START)), KillResult::Gone);
    assert_eq!(f.terminated(), []);
}

#[test]
fn kill_reports_denied_when_terminate_throws() {
    let f = Fx::new();
    f.add(10, Some(info()));
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Cpu);
    f.api.state().throwing.insert("terminate");
    assert_eq!(s.kill(&kill_input(10, START)), KillResult::Denied);
}

#[test]
fn kill_propagates_denied_and_gone_from_terminate() {
    let f = Fx::new();
    f.add(10, Some(info()));
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Cpu);
    f.api.state().terminate_result = TerminateResult::Denied;
    assert_eq!(s.kill(&kill_input(10, START)), KillResult::Denied);
    f.api.state().terminate_result = TerminateResult::Gone;
    assert_eq!(s.kill(&kill_input(10, START)), KillResult::Gone);
}

#[test]
fn kill_refuses_when_the_fresh_process_snapshot_comes_back_empty() {
    let f = Fx::new();
    f.add(10, Some(info()));
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Cpu);
    f.api.state().entries.clear();
    assert_eq!(s.kill(&kill_input(10, START)), KillResult::NotKillable);
    assert_eq!(f.terminated(), []);
}

#[test]
fn kill_still_accepts_a_row_that_dropped_out_of_the_top_list_within_the_grace_period() {
    let f = Fx::new();
    for pid in 10..19 {
        f.add(pid, ram(u64::from(pid)));
    }
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Ram); // 18..14: pid 14 is the last row
    f.at(1000);
    f.set(10, ram(1_000_000)); // pid 10 jumps in, pushing 14 out
    assert!(!pids(&top(&mut s, ProcessOrder::Ram)).contains(&14));
    f.at(LIST_GRACE_MS - 1);
    assert_eq!(s.kill(&kill_input(14, START)), KillResult::Killed);
    assert_eq!(f.terminated(), [(14, START.to_owned())]);
}

#[test]
fn kill_refuses_a_dropped_row_once_the_grace_period_is_over() {
    let f = Fx::new();
    for pid in 10..19 {
        f.add(pid, ram(u64::from(pid)));
    }
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Ram);
    f.at(1000);
    f.set(10, ram(1_000_000));
    top(&mut s, ProcessOrder::Ram);
    f.at(LIST_GRACE_MS);
    assert_eq!(s.kill(&kill_input(14, START)), KillResult::NotKillable);
    // A later list drops the expired entry altogether.
    top(&mut s, ProcessOrder::Ram);
    f.at(1000);
    assert_eq!(s.kill(&kill_input(14, START)), KillResult::NotKillable);
    assert_eq!(f.terminated(), []);
}

#[test]
fn kill_a_grace_row_still_goes_through_the_fresh_checks() {
    let f = Fx::new();
    for pid in 10..19 {
        f.add(pid, ram(u64::from(pid)));
    }
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Ram);
    f.at(1000);
    f.set(10, ram(1_000_000));
    top(&mut s, ProcessOrder::Ram);
    f.set(
        14,
        Some(ProcessInfo {
            private_bytes: Some(14),
            critical: true,
            ..info()
        }),
    );
    assert_eq!(s.kill(&kill_input(14, START)), KillResult::NotKillable);
    f.set(14, None);
    assert_eq!(s.kill(&kill_input(14, START)), KillResult::Gone);
    assert_eq!(f.terminated(), []);
}

#[test]
fn forget_list_forgets_the_last_list_but_keeps_the_cpu_baselines() {
    let f = Fx::new();
    f.add(10, cpu(1000.0));
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Cpu);
    s.forget_list();
    assert_eq!(s.kill(&kill_input(10, START)), KillResult::NotKillable);
    f.at(1000);
    f.set(10, cpu(3000.0));
    assert_eq!(top(&mut s, ProcessOrder::Cpu)[0].cpu_percent, Some(50.0));
}

#[test]
fn reset_forgets_the_last_list() {
    let f = Fx::new();
    f.add(10, Some(info()));
    let mut s = f.sampler();
    top(&mut s, ProcessOrder::Cpu);
    s.reset();
    assert_eq!(s.kill(&kill_input(10, START)), KillResult::NotKillable);
}

#[test]
fn kill_refuses_every_unsafe_target() {
    // Each target is listed (so only the safety checks can refuse it), then asked to close.
    let f = Fx::new();
    f.add(
        10,
        Some(ProcessInfo {
            owner: Owner::Other,
            ..info()
        }),
    ); // another user
    f.add(
        11,
        Some(ProcessInfo {
            session_id: 2,
            ..info()
        }),
    ); // another session
    f.add(
        12,
        Some(ProcessInfo {
            critical: true,
            ..info()
        }),
    ); // critical
    f.add_child(SELF, Some(info()), 1); // the notch itself
    f.add_child(13, Some(info()), SELF); // a child of the notch
    f.add_child(4, Some(info()), 0); // System
    f.add(0, Some(info())); // System Idle Process (never listed)
    f.add(14, Some(info())); // killable, but asked with another start time
    let mut s = f.sampler();
    s.top(ProcessOrder::Cpu, 50);
    for pid in [10, 11, 12, u64::from(SELF), 13, 4, 0] {
        assert_eq!(
            s.kill(&kill_input(pid, START)),
            KillResult::NotKillable,
            "pid {pid}"
        );
    }
    assert_eq!(
        s.kill(&kill_input(14, "2026-11-10T00:00:00.001Z")),
        KillResult::NotKillable
    );
    assert_eq!(f.terminated(), []);
    // The same row with its own start time does close: only the checks above refused.
    assert_eq!(s.kill(&kill_input(14, START)), KillResult::Killed);
}
