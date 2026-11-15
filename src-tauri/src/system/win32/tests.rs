use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use windows_sys::Win32::System::Threading::{
    GetActiveProcessorCount, ALL_PROCESSOR_GROUPS, CREATE_NO_WINDOW,
};

use super::*;

/// 100 ns ticks since 1601-01-01 UTC for an ISO instant, plus extra sub-millisecond ticks.
fn ticks(iso: &str, extra: u64) -> u64 {
    let ms = DateTime::parse_from_rfc3339(iso)
        .unwrap()
        .timestamp_millis();
    ((ms + 11_644_473_600_000) as u64) * 10_000 + extra
}

fn api() -> Win32SystemApi {
    Win32SystemApi::new().expect("the Win32 system API loads on Windows")
}

fn is_iso_ms_utc(value: &str) -> bool {
    let bytes = value.as_bytes();
    let digits = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22];
    bytes.len() == 24
        && digits.iter().all(|&i| bytes[i].is_ascii_digit())
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
        && bytes[16] == b':'
        && bytes[19] == b'.'
        && bytes[23] == b'Z'
}

// ---- pure helpers -------------------------------------------------------------------------

#[test]
fn filetime_to_iso() {
    for iso in [
        "2026-11-11T08:30:15.123Z",
        "1970-01-01T00:00:00.000Z",
        "2001-09-09T01:46:40.999Z",
    ] {
        assert_eq!(super::filetime_to_iso(ticks(iso, 0)).as_deref(), Some(iso));
    }
    // Sub-millisecond ticks are truncated, never rounded up.
    assert_eq!(
        super::filetime_to_iso(ticks("2026-11-11T08:30:15.123Z", 9_999)).as_deref(),
        Some("2026-11-11T08:30:15.123Z")
    );
}

#[test]
fn power_status_mapping() {
    // No system battery (flag 128): unknown percent and lifetime.
    let none = power_status(1, 128, 255, u32::MAX);
    assert_eq!(
        none,
        PowerStatus {
            has_battery: false,
            percent: None,
            charging: false,
            ac_online: true,
            seconds_left: None,
        }
    );
    // Unknown status (flag 255): no battery and never "charging" although bit 8 is set.
    let unknown = power_status(255, 255, 255, u32::MAX);
    assert!(!unknown.has_battery && !unknown.charging && !unknown.ac_online);
    assert_eq!(unknown.percent, None);
    // Charging (flag 8) on AC.
    let charging = power_status(1, 8, 42, u32::MAX);
    assert!(charging.has_battery && charging.charging && charging.ac_online);
    assert_eq!(charging.percent, Some(42));
    // Plugged in and full: on AC, not charging; on battery: seconds left reported.
    let plugged = power_status(1, 1, 100, u32::MAX);
    assert!(plugged.ac_online && !plugged.charging && plugged.has_battery);
    let on_battery = power_status(0, 2, 30, 3_600);
    assert!(!on_battery.ac_online && !on_battery.charging);
    assert_eq!(on_battery.seconds_left, Some(3_600));
}

#[test]
fn guard_returns_the_fallback_when_the_body_panics() {
    let guard = Guard::default();
    assert_eq!(guard.run("method", 7, || panic!("boom")), 7);
    assert_eq!(guard.run("method", 7, || panic!("boom")), 7);
    assert_eq!(guard.run("method", 7, || 3), 3);
    assert_eq!(guard.failed_count(), 1);
}

// ---- shape against the real machine (read-only) -------------------------------------------

#[test]
fn the_api_is_object_safe_and_shared() {
    let shared: Arc<dyn SystemApi> = Arc::new(api());
    assert_eq!(shared.self_pid(), std::process::id());
    assert!(shared.self_session_id() >= 0);
}

#[test]
fn cpu_count_matches_the_logical_processors() {
    // SAFETY: plain value in, plain value out.
    let active = unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) } as usize;
    let count = api().cpu_count();
    assert!(count > 0);
    assert_eq!(count, active);
}

#[test]
fn memory_total_is_positive() {
    let memory = api().memory().expect("memory");
    assert!(memory.total_bytes > 0);
    assert!(memory.avail_bytes <= memory.total_bytes);
}

#[test]
fn system_times_and_drives_answer() {
    let api = api();
    let times = api.system_times().expect("system times");
    assert!(times.kernel_ms >= times.idle_ms && times.user_ms >= 0.0);
    let drives = api.fixed_drives().expect("fixed drives");
    assert!(!drives.is_empty());
    let space = api
        .disk_space(drives[0].to_ascii_lowercase())
        .expect("disk space");
    assert!(space.total_bytes > 0 && space.free_bytes <= space.total_bytes);
    assert_eq!(api.disk_space('1'), None);
    assert!(api.power().is_some());
}

#[test]
fn processes_include_self() {
    let me = std::process::id();
    let list = api().processes();
    let entry = list
        .iter()
        .find(|p| p.pid == me)
        .expect("own process listed");
    assert!(!entry.name.is_empty() && entry.name.len() <= 260 * 3);
    assert!(list.len() > 10);
}

#[test]
fn self_process_info_is_owned_and_not_critical() {
    let api = api();
    let info = api.process_info(std::process::id()).expect("own info");
    assert_eq!(info.owner, Owner::Self_);
    assert!(!info.critical);
    assert!(info.session_id >= 0);
    assert_eq!(info.session_id, api.self_session_id());
    assert!(info.cpu_ms >= 0.0);
    assert!(info.private_bytes.unwrap_or(0) > 0);
    // Cached static facts give the same answer.
    let again = api
        .process_info(std::process::id())
        .expect("own info again");
    assert_eq!(
        (
            again.owner,
            again.critical,
            again.session_id,
            again.start_time
        ),
        (info.owner, info.critical, info.session_id, info.start_time)
    );
}

#[test]
fn start_time_is_iso_ms_utc() {
    let info = api().process_info(std::process::id()).expect("own info");
    assert!(is_iso_ms_utc(&info.start_time), "{}", info.start_time);
    let started: DateTime<Utc> = info.start_time.parse().unwrap();
    assert!(started <= Utc::now());
}

#[test]
fn a_missing_pid_has_no_info_and_is_gone() {
    let api = api();
    // Real PIDs are multiples of 4 far below this one.
    let missing = 0x3FFF_FFFC;
    assert_eq!(api.process_info(missing), None);
    assert_eq!(
        api.terminate(missing, "2026-11-11T08:30:15.123Z"),
        TerminateResult::Gone
    );
}

#[test]
fn pdh_second_collect_gives_values() {
    let api = api();
    // The first collection after opening has no rate values. (Reuse of that cycle by the
    // network getter is covered with explicit instants in `pdh::tests`: under a loaded test run,
    // opening the query can itself take longer than the 500 ms window.)
    assert_eq!(api.disk_idle_percent(), None);
    std::thread::sleep(Duration::from_millis(1_100));
    let idle = api.disk_idle_percent().expect("disk idle");
    assert!((0.0..=100.0).contains(&idle));
    let network = api.network_bytes_per_sec().expect("network");
    assert!(network.up >= 0.0 && network.down >= 0.0);
    api.dispose();
    // A new query after dispose starts again without values.
    assert_eq!(api.disk_idle_percent(), None);
    api.dispose();
}

/// A child the test owns (killed and reaped on drop, whatever the test outcome).
struct OwnChild(Child);

impl Drop for OwnChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn terminate_kills_only_a_matching_own_child() {
    let api = api();
    let child = OwnChild(
        Command::new("ping.exe")
            .args(["-n", "30", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("spawn ping"),
    );
    let pid = child.0.id();
    let info = api.process_info(pid).expect("child info");
    assert_eq!(info.owner, Owner::Self_);
    assert!(!info.critical);
    assert!(api
        .processes()
        .iter()
        .any(|p| p.pid == pid && p.parent_pid == std::process::id()));

    // A different start time means the PID was reused: nothing is killed.
    assert_eq!(
        api.terminate(pid, "2001-09-09T01:46:40.999Z"),
        TerminateResult::Gone
    );
    assert!(api.process_info(pid).is_some());

    assert_eq!(
        api.terminate(pid, &info.start_time),
        TerminateResult::Killed
    );
    let mut child = child;
    let status = child.0.wait().expect("child exits");
    assert_eq!(status.code(), Some(1));
    // Exited (our Child still holds a handle, so it opens): reported as gone.
    assert_eq!(api.terminate(pid, &info.start_time), TerminateResult::Gone);
}
