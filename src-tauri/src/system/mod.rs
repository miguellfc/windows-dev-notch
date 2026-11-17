//! System monitor: the Windows reads behind `SystemApi` (port of 0.1.0's `win32-system.ts`).
//!
//! The samplers and the monitor (Task 7) only see the `SystemApi` trait, so tests can swap in a
//! fake. Every method is synchronous and cheap (well under 20 ms): callers run them off the
//! Tauri main thread (`spawn_blocking`).

pub mod alerts;
#[cfg(test)]
pub(crate) mod fake;
pub mod ipc;
pub mod metrics;
pub mod monitor;
pub mod pdh;
pub mod processes;
pub mod win32;

pub use win32::Win32SystemApi;

/// `GetSystemTimes`, each FILETIME as milliseconds (kernel time already includes idle time).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SystemTimes {
    pub idle_ms: f64,
    pub kernel_ms: f64,
    pub user_ms: f64,
}

/// Physical memory (`GlobalMemoryStatusEx`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MemoryStatus {
    pub total_bytes: u64,
    pub avail_bytes: u64,
}

/// `GetSystemPowerStatus` decoded like the TS adapter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PowerStatus {
    pub has_battery: bool,
    /// `None` when Windows reports 255 (unknown).
    pub percent: Option<u8>,
    /// The battery is charging (flag 8).
    pub charging: bool,
    /// On AC power, charging or not (full on AC).
    pub ac_online: bool,
    /// `None` when Windows reports 0xFFFFFFFF (unknown).
    pub seconds_left: Option<u32>,
}

/// `GetDiskFreeSpaceExW`: total size and total free bytes (not the quota-aware "available").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DiskSpace {
    pub total_bytes: u64,
    pub free_bytes: u64,
}

/// Network throughput summed over every PDH `Network Interface` instance, clamped >= 0.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NetworkRate {
    pub up: f64,
    pub down: f64,
}

/// One toolhelp snapshot entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessEntry {
    pub pid: u32,
    pub parent_pid: u32,
    pub name: String,
}

/// Whose process it is, compared by token user SID with this process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Owner {
    Self_,
    Other,
    /// Either token could not be read.
    Unknown,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProcessInfo {
    /// Kernel + user CPU time in milliseconds.
    pub cpu_ms: f64,
    /// Private commit in bytes; `None` when the memory read failed.
    pub private_bytes: Option<u64>,
    /// Creation time as ISO-8601 UTC with milliseconds; identifies the process together with the PID.
    pub start_time: String,
    pub owner: Owner,
    /// `IsProcessCritical`; true when that call fails (fail safe: never killable).
    pub critical: bool,
    /// Terminal Services session; -1 when it could not be read.
    pub session_id: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TerminateResult {
    Killed,
    Gone,
    Denied,
}

impl TerminateResult {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Killed => "killed",
            Self::Gone => "gone",
            Self::Denied => "denied",
        }
    }
}

/// The Windows reads the system monitor needs. Each method degrades on its own: a failure yields
/// the documented fallback (`None`, an empty list or `Denied`) for that call only.
pub trait SystemApi: Send + Sync {
    /// Logical processors, as Node's `os.cpus().length`.
    fn cpu_count(&self) -> usize;
    fn self_pid(&self) -> u32;
    /// This process's session; -1 when it could not be read.
    fn self_session_id(&self) -> i64;
    fn system_times(&self) -> Option<SystemTimes>;
    fn memory(&self) -> Option<MemoryStatus>;
    fn power(&self) -> Option<PowerStatus>;
    /// Letters of the fixed drives; `None` when they could not be listed (not the same as none).
    fn fixed_drives(&self) -> Option<Vec<char>>;
    fn disk_space(&self, letter: char) -> Option<DiskSpace>;
    /// `\PhysicalDisk(_Total)\% Idle Time`, 0..=100.
    fn disk_idle_percent(&self) -> Option<f64>;
    fn network_bytes_per_sec(&self) -> Option<NetworkRate>;
    fn processes(&self) -> Vec<ProcessEntry>;
    fn process_info(&self, pid: u32) -> Option<ProcessInfo>;
    fn terminate(&self, pid: u32, start_time: &str) -> TerminateResult;
    /// Releases the PDH query and the caches.
    fn dispose(&self);
}
