//! `FakeSystemApi`: the scripted `SystemApi` the sampler tests run against (the TS tests' `fakeApi()`
//! and `fake()`). A method named in `throwing` panics, the Rust stand-in for a throwing adapter.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, PoisonError};

use super::{
    DiskSpace, MemoryStatus, NetworkRate, PowerStatus, ProcessEntry, ProcessInfo, SystemApi,
    SystemTimes, TerminateResult,
};

pub(crate) struct FakeState {
    pub cpu_count: usize,
    pub self_pid: u32,
    pub self_session_id: i64,
    pub times: Option<SystemTimes>,
    pub memory: Option<MemoryStatus>,
    pub power: Option<PowerStatus>,
    pub drives: Option<Vec<char>>,
    pub space: HashMap<char, Option<DiskSpace>>,
    pub disk_idle: Option<f64>,
    pub network: Option<NetworkRate>,
    pub entries: Vec<ProcessEntry>,
    pub infos: HashMap<u32, Option<ProcessInfo>>,
    pub terminated: Vec<(u32, String)>,
    pub terminate_result: TerminateResult,
    pub throwing: HashSet<&'static str>,
}

pub(crate) struct FakeSystemApi(Mutex<FakeState>);

impl FakeSystemApi {
    /// The metrics fixture: 8 cores, 16 000 bytes of RAM with 4 000 free, a battery at 80 %,
    /// drive C with 250 of 1 000 bytes free, disk 90 % idle, 100 up / 200 down.
    pub fn new() -> Self {
        Self(Mutex::new(FakeState {
            cpu_count: 8,
            self_pid: 1,
            self_session_id: 1,
            times: Some(times(0.0, 0.0, 0.0)),
            memory: Some(MemoryStatus {
                total_bytes: 16_000,
                avail_bytes: 4_000,
            }),
            power: Some(PowerStatus {
                has_battery: true,
                percent: Some(80),
                charging: false,
                ac_online: false,
                seconds_left: Some(3600),
            }),
            drives: Some(vec!['C']),
            space: HashMap::from([(
                'C',
                Some(DiskSpace {
                    total_bytes: 1000,
                    free_bytes: 250,
                }),
            )]),
            disk_idle: Some(90.0),
            network: Some(NetworkRate {
                up: 100.0,
                down: 200.0,
            }),
            entries: Vec::new(),
            infos: HashMap::new(),
            terminated: Vec::new(),
            terminate_result: TerminateResult::Killed,
            throwing: HashSet::new(),
        }))
    }

    pub fn state(&self) -> MutexGuard<'_, FakeState> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn read<T>(&self, name: &'static str, value: impl FnOnce(&FakeState) -> T) -> T {
        let state = self.state();
        if state.throwing.contains(name) {
            drop(state);
            panic!("{name} failed");
        }
        value(&state)
    }
}

pub(crate) fn times(idle_ms: f64, kernel_ms: f64, user_ms: f64) -> SystemTimes {
    SystemTimes {
        idle_ms,
        kernel_ms,
        user_ms,
    }
}

impl SystemApi for FakeSystemApi {
    fn cpu_count(&self) -> usize {
        self.state().cpu_count
    }

    fn self_pid(&self) -> u32 {
        self.state().self_pid
    }

    fn self_session_id(&self) -> i64 {
        self.state().self_session_id
    }

    fn system_times(&self) -> Option<SystemTimes> {
        self.read("systemTimes", |s| s.times)
    }

    fn memory(&self) -> Option<MemoryStatus> {
        self.read("memory", |s| s.memory)
    }

    fn power(&self) -> Option<PowerStatus> {
        self.read("power", |s| s.power)
    }

    fn fixed_drives(&self) -> Option<Vec<char>> {
        self.read("fixedDrives", |s| s.drives.clone())
    }

    fn disk_space(&self, letter: char) -> Option<DiskSpace> {
        self.read("diskSpace", |s| s.space.get(&letter).copied().flatten())
    }

    fn disk_idle_percent(&self) -> Option<f64> {
        self.read("diskIdlePercent", |s| s.disk_idle)
    }

    fn network_bytes_per_sec(&self) -> Option<NetworkRate> {
        self.read("networkBytesPerSec", |s| s.network)
    }

    fn processes(&self) -> Vec<ProcessEntry> {
        self.read("processes", |s| s.entries.clone())
    }

    fn process_info(&self, pid: u32) -> Option<ProcessInfo> {
        self.read("processInfo", |s| s.infos.get(&pid).cloned().flatten())
    }

    fn terminate(&self, pid: u32, start_time: &str) -> TerminateResult {
        self.read("terminate", |_| ());
        let mut state = self.state();
        state.terminated.push((pid, start_time.to_owned()));
        state.terminate_result
    }

    fn dispose(&self) {}
}
