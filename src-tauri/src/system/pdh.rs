//! PDH counters for disk activity and network throughput: one query opened lazily, shared by
//! both readings, collected at most once per `PDH_REUSE_MS`.

use std::ptr;
use std::time::{Duration, Instant};

use windows_sys::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW,
    PdhGetFormattedCounterValue, PdhOpenQueryW, PDH_FMT_COUNTERVALUE, PDH_FMT_COUNTERVALUE_ITEM_W,
    PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
};

use super::NetworkRate;

/// Both PDH getters read the same cycle within this window.
pub const PDH_REUSE_MS: u64 = 500;
const PDH_CSTATUS_VALID_DATA: u32 = 0;
const PDH_CSTATUS_NEW_DATA: u32 = 1;
const ARRAY_ATTEMPTS: usize = 3;

const DISK_IDLE: &str = "\\PhysicalDisk(_Total)\\% Idle Time";
const BYTES_SENT: &str = "\\Network Interface(*)\\Bytes Sent/sec";
const BYTES_RECEIVED: &str = "\\Network Interface(*)\\Bytes Received/sec";

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PdhCycle {
    pub at: Instant,
    /// `% Idle Time` clamped to 0..=100; `None` without a finite value.
    pub disk_idle: Option<f64>,
    /// Sum over every instance, clamped >= 0; `None` without finite values.
    pub network: Option<NetworkRate>,
}

/// The open query and its counters (null when a counter could not be added).
struct Query {
    query: PDH_HQUERY,
    disk: PDH_HCOUNTER,
    sent: PDH_HCOUNTER,
    received: PDH_HCOUNTER,
}

impl Drop for Query {
    fn drop(&mut self) {
        // SAFETY: `query` came from a successful `PdhOpenQueryW` and is closed exactly once here;
        // closing the query also releases its counters.
        unsafe {
            PdhCloseQuery(self.query);
        }
    }
}

#[derive(Default)]
pub struct Pdh {
    query: Option<Query>,
    /// Latched when `PdhOpenQueryW` fails: disk and network activity stay disabled.
    broken: bool,
    last_cycle: Option<PdhCycle>,
    collections: u32,
}

// SAFETY: the PDH handles are plain kernel-side identifiers with no thread affinity; `Pdh` is only
// used behind a `Mutex`, so they are never touched from two threads at once.
unsafe impl Send for Pdh {}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn valid(status: u32) -> bool {
    status == PDH_CSTATUS_VALID_DATA || status == PDH_CSTATUS_NEW_DATA
}

fn finite(value: Option<f64>) -> Option<f64> {
    value.filter(|v| v.is_finite())
}

/// Builds a cycle from raw readings: NaN/Inf become `None`, idle is clamped to 0..=100 and the
/// network rates to >= 0.
pub fn cycle_from(at: Instant, idle: Option<f64>, up: Option<f64>, down: Option<f64>) -> PdhCycle {
    PdhCycle {
        at,
        disk_idle: finite(idle).map(|v| v.clamp(0.0, 100.0)),
        network: match (finite(up), finite(down)) {
            (Some(up), Some(down)) => Some(NetworkRate {
                up: up.max(0.0),
                down: down.max(0.0),
            }),
            _ => None,
        },
    }
}

fn open() -> Result<Query, u32> {
    let mut query: PDH_HQUERY = ptr::null_mut();
    // SAFETY: a null data source means "live data"; `query` is a local out-param.
    let status = unsafe { PdhOpenQueryW(ptr::null(), 0, &mut query) };
    if status != 0 {
        return Err(status);
    }
    let mut add_failure_logged = false;
    let mut add = |path: &str| -> PDH_HCOUNTER {
        let path = wide(path);
        let mut counter: PDH_HCOUNTER = ptr::null_mut();
        // SAFETY: `query` is open; `path` is NUL-terminated and outlives the call.
        let status = unsafe { PdhAddEnglishCounterW(query, path.as_ptr(), 0, &mut counter) };
        if status == 0 {
            return counter;
        }
        if !add_failure_logged {
            add_failure_logged = true;
            log::warn!("PdhAddEnglishCounterW failed (status 0x{status:x})");
        }
        ptr::null_mut()
    };
    let disk = add(DISK_IDLE);
    let sent = add(BYTES_SENT);
    let received = add(BYTES_RECEIVED);
    Ok(Query {
        query,
        disk,
        sent,
        received,
    })
}

fn counter_value(counter: PDH_HCOUNTER) -> Option<f64> {
    if counter.is_null() {
        return None;
    }
    let mut value = PDH_FMT_COUNTERVALUE::default();
    // SAFETY: `counter` belongs to the open query; the type out-param may be null and `value`
    // is a local out-struct.
    let status = unsafe {
        PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, ptr::null_mut(), &mut value)
    };
    if status != 0 || !valid(value.CStatus) {
        return None;
    }
    // SAFETY: PDH_FMT_DOUBLE fills the `doubleValue` member of the union.
    Some(unsafe { value.Anonymous.doubleValue })
}

/// Sum of the valid, finite instance values of a wildcard counter; 0 without instances.
fn counter_array_sum(counter: PDH_HCOUNTER) -> Option<f64> {
    if counter.is_null() {
        return None;
    }
    for _ in 0..ARRAY_ATTEMPTS {
        let mut size = 0u32;
        let mut count = 0u32;
        // SAFETY: a null buffer with size 0 asks PDH for the size it needs.
        let status = unsafe {
            PdhGetFormattedCounterArrayW(
                counter,
                PDH_FMT_DOUBLE,
                &mut size,
                &mut count,
                ptr::null_mut(),
            )
        };
        if status == 0 {
            return Some(0.0); // no instances
        }
        if status != PDH_MORE_DATA || size == 0 {
            return None;
        }
        // u64 words keep the item array (pointers and doubles) 8-byte aligned.
        let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
        let items = buffer.as_mut_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>();
        // SAFETY: `buffer` holds at least `size` bytes and outlives the call and the reads below.
        let status = unsafe {
            PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, items)
        };
        if status == PDH_MORE_DATA {
            continue; // instances appeared between the two calls
        }
        if status != 0 {
            return None;
        }
        let capacity = buffer.len() * 8 / std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
        let count = (count as usize).min(capacity);
        // SAFETY: PDH wrote `count` items at the start of `buffer` (bounded by its capacity).
        let items = unsafe { std::slice::from_raw_parts(items, count) };
        let sum = items
            .iter()
            .filter(|item| valid(item.FmtValue.CStatus))
            // SAFETY: PDH_FMT_DOUBLE fills the `doubleValue` member of the union.
            .map(|item| unsafe { item.FmtValue.Anonymous.doubleValue })
            .filter(|value| value.is_finite())
            .sum();
        return Some(sum);
    }
    None
}

impl Pdh {
    fn ensure_open(&mut self) -> Option<&Query> {
        if self.query.is_none() && !self.broken {
            match open() {
                Ok(query) => self.query = Some(query),
                Err(status) => {
                    self.broken = true;
                    log::warn!(
                        "PdhOpenQueryW failed (status 0x{status:x}); disk and network activity disabled"
                    );
                }
            }
        }
        self.query.as_ref()
    }

    /// At most one `PdhCollectQueryData` per `PDH_REUSE_MS`; the first cycle after opening has no
    /// values (rate counters need two collections).
    pub fn collect(&mut self, now: Instant) -> Option<PdhCycle> {
        if let Some(last) = self.last_cycle {
            if now.saturating_duration_since(last.at) < Duration::from_millis(PDH_REUSE_MS) {
                return Some(last);
            }
        }
        let query = self.ensure_open()?;
        // SAFETY: the query handle is open (owned by `self.query`).
        if unsafe { PdhCollectQueryData(query.query) } != 0 {
            return None;
        }
        let (disk, sent, received) = (query.disk, query.sent, query.received);
        self.collections += 1;
        let cycle = if self.collections < 2 {
            cycle_from(now, None, None, None)
        } else {
            cycle_from(
                now,
                counter_value(disk),
                counter_array_sum(sent),
                counter_array_sum(received),
            )
        };
        self.last_cycle = Some(cycle);
        Some(cycle)
    }

    /// Closes the query; the next `collect` opens a new one (unless opening failed before).
    pub fn close(&mut self) {
        self.query = None;
        self.last_cycle = None;
        self.collections = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cycle_values_are_clamped_and_finite() {
        let at = Instant::now();
        let cycle = cycle_from(at, Some(120.0), Some(-3.0), Some(5.0));
        assert_eq!(cycle.disk_idle, Some(100.0));
        assert_eq!(cycle.network, Some(NetworkRate { up: 0.0, down: 5.0 }));
        assert_eq!(cycle_from(at, Some(-1.0), None, None).disk_idle, Some(0.0));
        let broken = cycle_from(at, Some(f64::NAN), Some(f64::INFINITY), Some(1.0));
        assert_eq!((broken.disk_idle, broken.network), (None, None));
    }

    #[test]
    fn a_cycle_is_reused_within_the_window() {
        let mut pdh = Pdh::default();
        let start = Instant::now();
        let first = pdh.collect(start).expect("first cycle");
        assert_eq!((first.disk_idle, first.network), (None, None));
        // Within 500 ms the same cycle comes back without a new collection.
        let reused = pdh.collect(start + Duration::from_millis(499)).unwrap();
        assert_eq!(reused.at, first.at);
        assert_eq!(pdh.collections, 1);
        pdh.close();
        assert_eq!(pdh.collections, 0);
        assert!(pdh.query.is_none());
    }
}
