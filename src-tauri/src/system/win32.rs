//! Win32 reads for the system monitor, ported call by call from `src/main/system/win32-system.ts`.
//!
//! Every method runs inside `Guard::run`: an unexpected failure (a panic, the Rust analogue of a
//! koffi throw) yields that method's fallback and is logged once per method, by name only.
//! Handles are owned by small RAII wrappers, so they are closed on every path.

use std::collections::{HashMap, HashSet};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Instant;

use chrono::{DateTime, SecondsFormat, Utc};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, FILETIME, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::{
    EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
};
use windows_sys::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows_sys::Win32::System::ProcessStatus::{
    K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX,
};
use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows_sys::Win32::System::SystemInformation::{
    GetSystemInfo, GlobalMemoryStatusEx, MEMORYSTATUSEX, SYSTEM_INFO,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetExitCodeProcess, GetProcessTimes, GetSystemTimes, IsProcessCritical,
    OpenProcess, OpenProcessToken, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    PROCESS_TERMINATE,
};

use super::pdh::Pdh;
use super::{
    DiskSpace, MemoryStatus, NetworkRate, Owner, PowerStatus, ProcessEntry, ProcessInfo, SystemApi,
    SystemTimes, TerminateResult,
};

const DRIVE_FIXED: u32 = 3;
/// `STILL_ACTIVE` as the exit code `GetExitCodeProcess` reports for a running process.
const STILL_ACTIVE: u32 = 259;
/// Milliseconds between 1601-01-01 (FILETIME epoch) and 1970-01-01 (Unix epoch).
const FILETIME_UNIX_EPOCH_MS: i64 = 11_644_473_600_000;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn ticks(time: FILETIME) -> u64 {
    (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
}

/// FILETIME ticks (100 ns) as milliseconds, fractional part kept (like `Number(big) / 10_000`).
fn filetime_ms(time: FILETIME) -> f64 {
    ticks(time) as f64 / 10_000.0
}

/// FILETIME ticks (100 ns since 1601-01-01 UTC) as an ISO-8601 instant with millisecond
/// precision and a `Z` suffix (`Date.toISOString()`); sub-millisecond ticks are truncated.
pub fn filetime_to_iso(ticks: u64) -> Option<String> {
    let ms = i64::try_from(ticks / 10_000).ok()? - FILETIME_UNIX_EPOCH_MS;
    let instant = DateTime::<Utc>::from_timestamp_millis(ms)?;
    Some(instant.to_rfc3339_opts(SecondsFormat::Millis, true))
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
                    // The method name only: never process names or other user data.
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

/// A kernel handle closed on drop.
struct OwnedHandle(HANDLE);

impl OwnedHandle {
    /// `None` for null (`OpenProcess`, `OpenProcessToken`) or `INVALID_HANDLE_VALUE` (toolhelp).
    fn new(handle: HANDLE) -> Option<Self> {
        // Not `then_some`: it would build (and drop, i.e. close) a wrapper around the invalid
        // handle, overwriting the caller's last error.
        if handle.is_null() || handle == INVALID_HANDLE_VALUE {
            None
        } else {
            Some(Self(handle))
        }
    }
}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        // SAFETY: the handle was valid when wrapped and is closed exactly once, here.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// A `TOKEN_USER` buffer; the SID it points to lives inside it, so the buffer must outlive every
/// use of `sid()` (e.g. `EqualSid`).
struct TokenUserBuffer {
    // u64 words keep `TOKEN_USER` (a pointer + u32) aligned.
    words: Vec<u64>,
}

impl TokenUserBuffer {
    fn sid(&self) -> *mut core::ffi::c_void {
        // SAFETY: `words` holds a `TOKEN_USER` written by `GetTokenInformation`, aligned to 8.
        unsafe { (*self.words.as_ptr().cast::<TOKEN_USER>()).User.Sid }
    }
}

// SAFETY: the buffer is plain owned memory; its internal SID pointer only refers to itself.
unsafe impl Send for TokenUserBuffer {}

/// `TokenUser` of a process handle (2 calls: size, then fill).
fn token_user(process: HANDLE) -> Option<TokenUserBuffer> {
    let mut raw: HANDLE = ptr::null_mut();
    // SAFETY: `process` is a valid process handle (or the current-process pseudo handle) and
    // `raw` is a local out-param.
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut raw) } == 0 {
        return None;
    }
    let token = OwnedHandle::new(raw)?;
    let mut needed = 0u32;
    // SAFETY: a null buffer of length 0 asks for the size needed.
    unsafe { GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut needed) };
    if needed == 0 {
        return None;
    }
    let mut words = vec![0u64; (needed as usize).div_ceil(8)];
    // SAFETY: `words` holds at least `needed` bytes and outlives the call.
    let ok = unsafe {
        GetTokenInformation(
            token.0,
            TokenUser,
            words.as_mut_ptr().cast(),
            needed,
            &mut needed,
        )
    };
    (ok != 0).then_some(TokenUserBuffer { words })
}

fn session_of(pid: u32) -> i64 {
    let mut session = 0u32;
    // SAFETY: plain value in, local out-param.
    if unsafe { ProcessIdToSessionId(pid, &mut session) } != 0 {
        i64::from(session)
    } else {
        -1
    }
}

/// `GetProcessTimes`: (creation, kernel, user).
fn process_times(process: &OwnedHandle) -> Option<(FILETIME, FILETIME, FILETIME)> {
    let mut creation = FILETIME::default();
    let mut exit = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: valid handle, four local out-params.
    let ok =
        unsafe { GetProcessTimes(process.0, &mut creation, &mut exit, &mut kernel, &mut user) };
    (ok != 0).then_some((creation, kernel, user))
}

/// Static per-process facts, cached by `pid:startTime` so a reused PID never inherits them.
#[derive(Debug, Clone, Copy)]
struct StaticInfo {
    owner: Owner,
    critical: bool,
    session_id: i64,
}

pub struct Win32SystemApi {
    guard: Guard,
    cpu_count: usize,
    self_pid: u32,
    self_session_id: i64,
    static_cache: Mutex<HashMap<(u32, String), StaticInfo>>,
    /// Only a successful lookup is cached; a failure is retried on the next call.
    self_token: Mutex<Option<TokenUserBuffer>>,
    pdh: Mutex<Pdh>,
}

impl Win32SystemApi {
    /// The bindings link at build time, so this always succeeds on Windows; the `Option` keeps
    /// the TS contract (`null` = system monitor unavailable).
    pub fn new() -> Option<Self> {
        let guard = Guard::default();
        let self_pid = std::process::id();
        let self_session_id = guard.run("selfSessionId", -1, || session_of(self_pid));
        Some(Self {
            guard,
            cpu_count: logical_processors(),
            self_pid,
            self_session_id,
            static_cache: Mutex::new(HashMap::new()),
            self_token: Mutex::new(None),
            pdh: Mutex::new(Pdh::default()),
        })
    }

    fn read_static(&self, pid: u32, process: &OwnedHandle) -> StaticInfo {
        let user = token_user(process.0);
        let owner = {
            let mut self_token = lock(&self.self_token);
            if self_token.is_none() {
                // SAFETY: the current-process pseudo handle needs no closing.
                *self_token = token_user(unsafe { GetCurrentProcess() });
            }
            match (self_token.as_ref(), user.as_ref()) {
                // SAFETY: both SIDs point into buffers borrowed for the whole call.
                (Some(me), Some(them)) => match unsafe { EqualSid(them.sid(), me.sid()) } {
                    0 => Owner::Other,
                    _ => Owner::Self_,
                },
                _ => Owner::Unknown,
            }
        };
        let mut critical = 0;
        // SAFETY: valid handle, local out-param.
        let read = unsafe { IsProcessCritical(process.0, &mut critical) } != 0;
        StaticInfo {
            owner,
            // Fail safe: if criticality cannot be read, treat the process as critical.
            critical: if read { critical != 0 } else { true },
            session_id: session_of(pid),
        }
    }

    fn collect_pdh(&self) -> Option<super::pdh::PdhCycle> {
        lock(&self.pdh).collect(Instant::now())
    }
}

/// Logical processors exactly as Node's `os.cpus().length`: libuv's `uv_cpu_info` sizes its list
/// with `GetSystemInfo().dwNumberOfProcessors` (the current processor group). On this
/// single-group machine it equals `GetActiveProcessorCount(ALL_PROCESSOR_GROUPS)` (16).
fn logical_processors() -> usize {
    let mut info = SYSTEM_INFO::default();
    // SAFETY: local out-struct; the call cannot fail.
    unsafe { GetSystemInfo(&mut info) };
    info.dwNumberOfProcessors as usize
}

impl SystemApi for Win32SystemApi {
    fn cpu_count(&self) -> usize {
        self.cpu_count
    }

    fn self_pid(&self) -> u32 {
        self.self_pid
    }

    fn self_session_id(&self) -> i64 {
        self.self_session_id
    }

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

    fn disk_idle_percent(&self) -> Option<f64> {
        self.guard
            .run("diskIdlePercent", None, || self.collect_pdh()?.disk_idle)
    }

    fn network_bytes_per_sec(&self) -> Option<NetworkRate> {
        self.guard
            .run("networkBytesPerSec", None, || self.collect_pdh()?.network)
    }

    fn processes(&self) -> Vec<ProcessEntry> {
        self.guard.run("processes", Vec::new(), || {
            // SAFETY: plain values in; the result is checked before use.
            let Some(snapshot) =
                OwnedHandle::new(unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) })
            else {
                return Vec::new();
            };
            let mut list = Vec::new();
            let mut entry = PROCESSENTRY32W {
                dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            // SAFETY: valid snapshot handle and a local entry with its size field set.
            let mut ok = unsafe { Process32FirstW(snapshot.0, &mut entry) } != 0;
            while ok {
                let name = &entry.szExeFile;
                let length = name.iter().position(|&c| c == 0).unwrap_or(name.len());
                list.push(ProcessEntry {
                    pid: entry.th32ProcessID,
                    parent_pid: entry.th32ParentProcessID,
                    name: String::from_utf16_lossy(&name[..length]),
                });
                // SAFETY: as above.
                ok = unsafe { Process32NextW(snapshot.0, &mut entry) } != 0;
            }
            drop(snapshot);
            let seen: HashSet<u32> = list.iter().map(|p| p.pid).collect();
            lock(&self.static_cache).retain(|(pid, _), _| seen.contains(pid));
            list
        })
    }

    fn process_info(&self, pid: u32) -> Option<ProcessInfo> {
        self.guard.run("processInfo", None, || {
            // SAFETY: plain values in; a null result is checked.
            let process = OwnedHandle::new(unsafe {
                OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
            })?;
            let (creation, kernel, user) = process_times(&process)?;
            let start_time = filetime_to_iso(ticks(creation))?;
            let mut counters = PROCESS_MEMORY_COUNTERS_EX {
                cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32,
                ..Default::default()
            };
            // SAFETY: valid handle; the EX struct starts with the base struct and `cb` tells
            // Windows its full size.
            let private_bytes = (unsafe {
                K32GetProcessMemoryInfo(
                    process.0,
                    (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX)
                        .cast::<PROCESS_MEMORY_COUNTERS>(),
                    counters.cb,
                )
            } != 0)
                .then_some(counters.PrivateUsage as u64);

            let key = (pid, start_time.clone());
            let cached = lock(&self.static_cache).get(&key).copied();
            let info = match cached {
                Some(info) => info,
                None => {
                    let info = self.read_static(pid, &process);
                    let mut cache = lock(&self.static_cache);
                    // A new start time for this PID means it was reused: drop the stale entries.
                    cache.retain(|(other, _), _| *other != pid);
                    cache.insert(key, info);
                    info
                }
            };
            Some(ProcessInfo {
                cpu_ms: filetime_ms(kernel) + filetime_ms(user),
                private_bytes,
                start_time,
                owner: info.owner,
                critical: info.critical,
                session_id: info.session_id,
            })
        })
    }

    fn terminate(&self, pid: u32, start_time: &str) -> TerminateResult {
        self.guard.run("terminate", TerminateResult::Denied, || {
            // SAFETY: plain values in; a null result is checked.
            let raw = unsafe {
                OpenProcess(
                    PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION,
                    0,
                    pid,
                )
            };
            let Some(process) = OwnedHandle::new(raw) else {
                // SAFETY: reads this thread's last error, set by the failed `OpenProcess`.
                return if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
                    TerminateResult::Gone
                } else {
                    TerminateResult::Denied
                };
            };
            let Some((creation, _, _)) = process_times(&process) else {
                return TerminateResult::Denied;
            };
            let Some(created) = filetime_to_iso(ticks(creation)) else {
                return TerminateResult::Denied;
            };
            // A different creation time means the PID was reused.
            if created != start_time {
                return TerminateResult::Gone;
            }
            let mut code = 0u32;
            // SAFETY: valid handle, local out-param.
            if unsafe { GetExitCodeProcess(process.0, &mut code) } != 0 && code != STILL_ACTIVE {
                return TerminateResult::Gone;
            }
            // SAFETY: valid handle opened with PROCESS_TERMINATE.
            if unsafe { TerminateProcess(process.0, 1) } != 0 {
                TerminateResult::Killed
            } else {
                TerminateResult::Denied
            }
        })
    }

    fn dispose(&self) {
        self.guard.run("dispose", (), || lock(&self.pdh).close());
        lock(&self.static_cache).clear();
        *lock(&self.self_token) = None;
    }
}

#[cfg(test)]
mod tests;
