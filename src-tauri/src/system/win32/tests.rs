use std::sync::Arc;

use super::*;

fn api() -> Win32SystemApi {
    Win32SystemApi::new().expect("the Win32 system API loads on Windows")
}

// ---- pure helpers -------------------------------------------------------------------------

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
fn connectivity_level_mapping() {
    use windows_sys::Win32::Networking::WinSock::{
        NetworkConnectivityLevelHintConstrainedInternetAccess, NetworkConnectivityLevelHintHidden,
        NetworkConnectivityLevelHintInternetAccess, NetworkConnectivityLevelHintLocalAccess,
        NetworkConnectivityLevelHintNone, NetworkConnectivityLevelHintUnknown,
    };
    // Only internet access is online.
    assert_eq!(
        online_from_level(NetworkConnectivityLevelHintInternetAccess),
        Some(true)
    );
    // No network, a network without internet, a captive portal or limited access: offline.
    for level in [
        NetworkConnectivityLevelHintNone,
        NetworkConnectivityLevelHintLocalAccess,
        NetworkConnectivityLevelHintConstrainedInternetAccess,
    ] {
        assert_eq!(online_from_level(level), Some(false), "{level}");
    }
    // Not known: the renderer falls back to navigator.onLine.
    for level in [
        NetworkConnectivityLevelHintUnknown,
        NetworkConnectivityLevelHintHidden,
        42,
        -1,
    ] {
        assert_eq!(online_from_level(level), None, "{level}");
    }
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
    assert!(shared.memory().is_some());
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
    // Whatever the machine's connection, the read answers without panicking.
    let _ = api.online();
}
