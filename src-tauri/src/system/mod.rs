//! System monitor: the Windows reads behind `SystemApi` (port of 0.1.0's `win32-system.ts`). It
//! feeds the capsule's metrics (and the panel header's copy of them) and the system alerts.
//!
//! The sampler and the monitor only see the `SystemApi` trait, so tests can swap in a
//! fake. Every method is synchronous and cheap (well under 20 ms): callers run them off the
//! Tauri main thread (`spawn_blocking`).

pub mod alerts;
#[cfg(test)]
pub(crate) mod fake;
pub mod integration;
pub mod metrics;
pub mod monitor;
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

/// The Windows reads the system monitor needs. Each method degrades on its own: a failure yields
/// the documented fallback (`None`) for that call only.
pub trait SystemApi: Send + Sync {
    fn system_times(&self) -> Option<SystemTimes>;
    fn memory(&self) -> Option<MemoryStatus>;
    fn power(&self) -> Option<PowerStatus>;
    /// Letters of the fixed drives; `None` when they could not be listed (not the same as none).
    fn fixed_drives(&self) -> Option<Vec<char>>;
    fn disk_space(&self, letter: char) -> Option<DiskSpace>;
    /// Whether the machine reaches the internet (Windows' aggregate connectivity hint); `None`
    /// when Windows does not know or the read failed. Unlike `navigator.onLine`, a network
    /// without internet (or behind a captive portal) reads `false`.
    fn online(&self) -> Option<bool>;
}
