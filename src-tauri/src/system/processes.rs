//! Port of `src/main/system/process-sampler.ts`: builds the System view's process list and
//! validates every close request against it.

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Arc;

use super::{Owner, ProcessEntry, ProcessInfo, SystemApi, TerminateResult};
use crate::contract::system::{KillInput, KillResult, ProcessOrder, ProcessRow};

/// A row that just dropped out of the list stays closable this long: the user may have confirmed
/// it right before a CPU re-rank pushed it out. The kill still re-checks everything fresh.
pub const LIST_GRACE_MS: u64 = 5000;
/// Below this interval a delta is too noisy (e.g. a sort switch right after a tick): reuse the
/// last value.
const MIN_CPU_INTERVAL_MS: u64 = 500;
/// `MAX_NAME` in UTF-16 code units, as the TS `slice(0, 260)`.
const MAX_NAME: usize = 260;
/// System Idle Process and System: never closable, whatever the API reports.
const SYSTEM_PIDS: [u32; 2] = [0, 4];

/// Monotonic clock in ms.
pub type MonotonicClock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// What the monitor needs from the process sampler (a trait so its tests can spy on it).
pub trait Processes: Send {
    /// Top processes by CPU or RAM; remembers the returned rows as "the last list" for `kill`.
    fn top(&mut self, by: ProcessOrder, limit: usize) -> Vec<ProcessRow>;
    /// Closes a process only if it was in the last list with the same start time and is still
    /// killable.
    fn kill(&mut self, input: &KillInput) -> KillResult;
    /// Forgets CPU baselines and the last list.
    fn reset(&mut self);
    /// Forgets only the last list (a fresh view must not close rows it never showed); keeps the
    /// CPU baselines.
    fn forget_list(&mut self);
}

#[derive(Clone, Copy, Debug)]
struct CpuMark {
    cpu_ms: f64,
    at: u64,
    /// Last CPU % computed for this process (`None` until a second sighting).
    percent: Option<f64>,
}

#[derive(Clone, Debug)]
struct Listed {
    start_time: String,
    killable: bool,
    /// When the row was last in a returned list.
    listed_at: u64,
}

/// Runs a raw read; a panicking adapter yields `fallback` (the TS `attempt`).
fn attempt<T>(read: impl FnOnce() -> T, fallback: T) -> T {
    catch_unwind(AssertUnwindSafe(read)).unwrap_or(fallback)
}

/// All transitive descendants of `root` in the snapshot; a visited set guards against PID-reuse
/// cycles. Limitation: a grandchild whose intermediate parent already exited is orphaned and is
/// not detected.
fn descendants_of(root: u32, entries: &[ProcessEntry]) -> HashSet<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for entry in entries {
        if entry.pid == entry.parent_pid {
            continue;
        }
        children
            .entry(entry.parent_pid)
            .or_default()
            .push(entry.pid);
    }
    let mut visited = HashSet::from([root]);
    let mut stack = vec![root];
    while let Some(pid) = stack.pop() {
        for &child in children.get(&pid).map_or(&[][..], Vec::as_slice) {
            if visited.insert(child) {
                stack.push(child);
            }
        }
    }
    visited.remove(&root);
    visited
}

/// Descending with `None` last.
fn compare_nullable_desc(a: Option<f64>, b: Option<f64>) -> Ordering {
    match (a, b) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(a), Some(b)) => b.partial_cmp(&a).unwrap_or(Ordering::Equal),
    }
}

/// At most [`MAX_NAME`] UTF-16 code units, never splitting a character.
fn truncate_name(name: &str) -> String {
    let mut units = 0;
    name.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= MAX_NAME
        })
        .collect()
}

pub struct ProcessSampler {
    api: Arc<dyn SystemApi>,
    now: MonotonicClock,
    marks: HashMap<(u32, String), CpuMark>,
    last_list: HashMap<u32, Listed>,
    /// When the most recent list was built: its rows stay closable until the next list.
    last_top_at: Option<u64>,
}

impl ProcessSampler {
    pub fn new(api: Arc<dyn SystemApi>, now: MonotonicClock) -> Self {
        Self {
            api,
            now,
            marks: HashMap::new(),
            last_list: HashMap::new(),
            last_top_at: None,
        }
    }

    fn is_killable(
        &self,
        pid: u32,
        info: Option<&ProcessInfo>,
        descendants: &HashSet<u32>,
    ) -> bool {
        let self_session = self.api.self_session_id();
        info.is_some_and(|info| {
            info.owner == Owner::Self_
                && !info.critical
                && info.session_id >= 0
                && self_session >= 0
                && info.session_id == self_session
                && pid != self.api.self_pid()
                && !SYSTEM_PIDS.contains(&pid)
                && !descendants.contains(&pid)
        })
    }

    /// Next baseline for a process; a too-short interval keeps the previous baseline and value.
    fn next_mark(&self, previous: Option<&CpuMark>, cpu_ms: f64, at: u64) -> CpuMark {
        let Some(previous) = previous else {
            return CpuMark {
                cpu_ms,
                at,
                percent: None,
            };
        };
        let elapsed = at.saturating_sub(previous.at);
        if elapsed < MIN_CPU_INTERVAL_MS {
            return *previous;
        }
        let cpu_count = self.api.cpu_count();
        if cpu_count == 0 {
            return CpuMark {
                cpu_ms,
                at,
                percent: None,
            };
        }
        let raw = 100.0 * (cpu_ms - previous.cpu_ms) / (elapsed as f64 * cpu_count as f64);
        CpuMark {
            cpu_ms,
            at,
            percent: Some((raw.clamp(0.0, 100.0) * 10.0).round() / 10.0),
        }
    }
}

impl Processes for ProcessSampler {
    fn top(&mut self, by: ProcessOrder, limit: usize) -> Vec<ProcessRow> {
        let entries = attempt(|| self.api.processes(), Vec::new());
        let descendants = descendants_of(self.api.self_pid(), &entries);
        let at = (self.now)();
        self.last_top_at = Some(at);
        let previous = std::mem::take(&mut self.marks);
        let mut rows = Vec::new();
        for entry in &entries {
            if entry.pid == 0 {
                continue;
            }
            let info = attempt(|| self.api.process_info(entry.pid), None);
            let mut cpu = None;
            if let Some(info) = &info {
                let key = (entry.pid, info.start_time.clone());
                let mark = self.next_mark(previous.get(&key), info.cpu_ms, at);
                cpu = mark.percent;
                self.marks.insert(key, mark);
            }
            rows.push(ProcessRow {
                pid: u64::from(entry.pid),
                name: truncate_name(&entry.name),
                cpu_percent: cpu,
                private_bytes: info
                    .as_ref()
                    .and_then(|info| info.private_bytes)
                    .map(|bytes| bytes as f64),
                start_time: info
                    .as_ref()
                    .map(|info| info.start_time.clone())
                    .unwrap_or_default(),
                killable: self.is_killable(entry.pid, info.as_ref(), &descendants),
            });
        }
        rows.sort_by(|a, b| {
            let primary = match by {
                ProcessOrder::Cpu => compare_nullable_desc(a.cpu_percent, b.cpu_percent)
                    .then_with(|| compare_nullable_desc(a.private_bytes, b.private_bytes)),
                ProcessOrder::Ram => compare_nullable_desc(a.private_bytes, b.private_bytes)
                    .then_with(|| compare_nullable_desc(a.cpu_percent, b.cpu_percent)),
            };
            primary.then(a.pid.cmp(&b.pid))
        });
        rows.truncate(limit);
        // Updated even if the caller's emit is later refused: kill() then fails closed.
        let mut next: HashMap<u32, Listed> = rows
            .iter()
            .filter_map(|row| {
                let pid = u32::try_from(row.pid).ok()?;
                let listed = Listed {
                    start_time: row.start_time.clone(),
                    killable: row.killable,
                    listed_at: at,
                };
                Some((pid, listed))
            })
            .collect();
        for (pid, listed) in self.last_list.drain() {
            if !next.contains_key(&pid) && at.saturating_sub(listed.listed_at) < LIST_GRACE_MS {
                next.insert(pid, listed);
            }
        }
        self.last_list = next;
        rows
    }

    fn kill(&mut self, input: &KillInput) -> KillResult {
        let start_time = input.start_time.as_str();
        if start_time.is_empty() {
            return KillResult::NotKillable;
        }
        let Ok(pid) = u32::try_from(input.pid) else {
            return KillResult::NotKillable;
        };
        let Some(listed) = self.last_list.get(&pid) else {
            return KillResult::NotKillable;
        };
        if listed.start_time != start_time || !listed.killable {
            return KillResult::NotKillable;
        }
        // A row kept only by the grace period expires with it.
        if Some(listed.listed_at) != self.last_top_at
            && (self.now)().saturating_sub(listed.listed_at) >= LIST_GRACE_MS
        {
            return KillResult::NotKillable;
        }
        let info = attempt(|| self.api.process_info(pid), None);
        let Some(info) = info.filter(|info| info.start_time == start_time) else {
            return KillResult::Gone;
        };
        // Without a fresh snapshot the notch's children cannot be ruled out: refuse rather than
        // guess. The adapter returns [] when the snapshot fails: an empty one proves nothing.
        let entries = attempt(|| Some(self.api.processes()), None);
        let Some(entries) = entries.filter(|entries| !entries.is_empty()) else {
            return KillResult::NotKillable;
        };
        let descendants = descendants_of(self.api.self_pid(), &entries);
        if !self.is_killable(pid, Some(&info), &descendants) {
            return KillResult::NotKillable;
        }
        match attempt(
            || self.api.terminate(pid, start_time),
            TerminateResult::Denied,
        ) {
            TerminateResult::Killed => KillResult::Killed,
            TerminateResult::Gone => KillResult::Gone,
            TerminateResult::Denied => KillResult::Denied,
        }
    }

    fn reset(&mut self) {
        self.marks.clear();
        self.last_list.clear();
    }

    fn forget_list(&mut self) {
        self.last_list.clear();
    }
}

#[cfg(test)]
mod tests;
