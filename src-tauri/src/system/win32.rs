//! Win32 reads for the system monitor, ported call by call from 0.1.0's `win32-system.ts`.
//!
//! Every method runs inside `Guard::run`: an unexpected failure (a panic, the Rust analogue of a
//! koffi throw) yields that method's fallback and is logged once per method, by name only. Only
//! the light reads the capsule and the alerts need are left (the System view, its process list
//! and its PDH rates were removed).

use std::collections::HashSet;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Mutex, MutexGuard, PoisonError};

use windows_sys::Win32::Foundation::{FILETIME, NO_ERROR};
use windows_sys::Win32::NetworkManagement::IpHelper::GetNetworkConnectivityHint;
use windows_sys::Win32::Networking::WinSock::{
    NetworkConnectivityLevelHintConstrainedInternetAccess,
    NetworkConnectivityLevelHintInternetAccess, NetworkConnectivityLevelHintLocalAccess,
    NetworkConnectivityLevelHintNone, NL_NETWORK_CONNECTIVITY_HINT,
    NL_NETWORK_CONNECTIVITY_LEVEL_HINT,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives,
};
use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows_sys::Win32::System::Threading::GetSystemTimes;

use super::{DiskSpace, MemoryStatus, PowerStatus, SystemApi, SystemTimes};

const DRIVE_FIXED: u32 = 3;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// FILETIME ticks (100 ns) as milliseconds, fractional part kept (like `Number(big) / 10_000`).
fn filetime_ms(time: FILETIME) -> f64 {
    let ticks = (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
    ticks as f64 / 10_000.0
}

/// `SYSTEM_POWER_STATUS` decoded like the TS adapter.
pub fn power_status(ac_line: u8, flag: u8, percent: u8, life_time: u32) -> PowerStatus {
    PowerStatus {
        has_battery: flag & 128 == 0,
        percent: (percent != 255).then_some(percent),
        charging: flag != 255 && flag & 8 != 0,
        ac_online: ac_line == 1,
        seconds_left: (life_time != u32::MAX).then_some(life_time),
    }
}

/// `NL_NETWORK_CONNECTIVITY_LEVEL_HINT` as "reaches the internet": only `InternetAccess` is
/// online. `None` (no network), `LocalAccess` (a network without internet) and
/// `ConstrainedInternetAccess` (a captive portal or otherwise limited access) are offline.
/// `Unknown`, `Hidden` (connectivity the system does not disclose) and any future value are
/// not known: the renderer falls back to `navigator.onLine`.
pub fn online_from_level(level: NL_NETWORK_CONNECTIVITY_LEVEL_HINT) -> Option<bool> {
    // Compared rather than matched: the windows-sys constants are not upper case.
    const OFFLINE: [NL_NETWORK_CONNECTIVITY_LEVEL_HINT; 3] = [
        NetworkConnectivityLevelHintNone,
        NetworkConnectivityLevelHintLocalAccess,
        NetworkConnectivityLevelHintConstrainedInternetAccess,
    ];
    if level == NetworkConnectivityLevelHintInternetAccess {
        Some(true)
    } else if OFFLINE.contains(&level) {
        Some(false)
    } else {
        // Unknown, Hidden and any value a later Windows adds.
        None
    }
}

/// Fallback-and-log-once wrapper (the TS `guard()`).
#[derive(Default)]
pub(crate) struct Guard {
    failed: Mutex<HashSet<&'static str>>,
}

impl Guard {
    pub(crate) fn run<T>(&self, method: &'static str, fallback: T, body: impl FnOnce() -> T) -> T {
        match catch_unwind(AssertUnwindSafe(body)) {
            Ok(value) => value,
            Err(_) => {
                if lock(&self.failed).insert(method) {
                    // The method name only: never paths or other user data.
                    log::warn!("{method} failed");
                }
                fallback
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn failed_count(&self) -> usize {
        lock(&self.failed).len()
    }
}

#[derive(Default)]
pub struct Win32SystemApi {
    guard: Guard,
}

impl Win32SystemApi {
    /// The bindings link at build time, so this always succeeds on Windows; the `Option` keeps
    /// the TS contract (`null` = system monitor unavailable).
    pub fn new() -> Option<Self> {
        Some(Self::default())
    }
}

impl SystemApi for Win32SystemApi {
    fn system_times(&self) -> Option<SystemTimes> {
        self.guard.run("systemTimes", None, || {
            let (mut idle, mut kernel, mut user) = (
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
            );
            // SAFETY: three local out-params.
            if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } == 0 {
                return None;
            }
            Some(SystemTimes {
                idle_ms: filetime_ms(idle),
                kernel_ms: filetime_ms(kernel),
                user_ms: filetime_ms(user),
            })
        })
    }

    fn memory(&self) -> Option<MemoryStatus> {
        self.guard.run("memory", None, || {
            let mut status = MEMORYSTATUSEX {
                dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
                ..Default::default()
            };
            // SAFETY: local out-struct with its size field set.
            if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
                return None;
            }
            Some(MemoryStatus {
                total_bytes: status.ullTotalPhys,
                avail_bytes: status.ullAvailPhys,
            })
        })
    }

    fn power(&self) -> Option<PowerStatus> {
        self.guard.run("power", None, || {
            let mut status = SYSTEM_POWER_STATUS::default();
            // SAFETY: local out-struct.
            if unsafe { GetSystemPowerStatus(&mut status) } == 0 {
                return None;
            }
            Some(power_status(
                status.ACLineStatus,
                status.BatteryFlag,
                status.BatteryLifePercent,
                status.BatteryLifeTime,
            ))
        })
    }

    fn fixed_drives(&self) -> Option<Vec<char>> {
        self.guard.run("fixedDrives", None, || {
            // SAFETY: no arguments.
            let mask = unsafe { GetLogicalDrives() };
            let letters = (0..26u8)
                .filter(|bit| mask & (1 << bit) != 0)
                .map(|bit| char::from(b'A' + bit))
                .filter(|letter| {
                    let root: Vec<u16> = format!("{letter}:\\")
                        .encode_utf16()
                        .chain(std::iter::once(0))
                        .collect();
                    // SAFETY: NUL-terminated root path that outlives the call.
                    unsafe { GetDriveTypeW(root.as_ptr()) == DRIVE_FIXED }
                })
                .collect();
            Some(letters)
        })
    }

    fn disk_space(&self, letter: char) -> Option<DiskSpace> {
        self.guard.run("diskSpace", None, || {
            if !letter.is_ascii_alphabetic() {
                return None;
            }
            let root: Vec<u16> = format!("{}:\\", letter.to_ascii_uppercase())
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let (mut avail, mut total, mut free) = (0u64, 0u64, 0u64);
            // SAFETY: NUL-terminated root path and three local out-params.
            let ok =
                unsafe { GetDiskFreeSpaceExW(root.as_ptr(), &mut avail, &mut total, &mut free) };
            // The third value (total free), not the quota-aware "available to caller".
            (ok != 0).then_some(DiskSpace {
                total_bytes: total,
                free_bytes: free,
            })
        })
    }

    fn online(&self) -> Option<bool> {
        self.guard.run("online", None, || {
            let mut hint = NL_NETWORK_CONNECTIVITY_HINT::default();
            // SAFETY: local out-struct. Windows 10 2004+; a cached aggregate, no network I/O.
            if unsafe { GetNetworkConnectivityHint(&mut hint) } != NO_ERROR {
                return None;
            }
            online_from_level(hint.ConnectivityLevel)
        })
    }
}

#[cfg(test)]
mod tests;
