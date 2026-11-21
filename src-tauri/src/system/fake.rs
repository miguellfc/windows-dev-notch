//! `FakeSystemApi`: the scripted `SystemApi` the sampler tests run against (the TS tests' `fakeApi()`
//! and `fake()`). A method named in `throwing` panics, the Rust stand-in for a throwing adapter.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard, PoisonError};

use super::{DiskSpace, MemoryStatus, PowerStatus, SystemApi, SystemTimes};

pub(crate) struct FakeState {
    pub times: Option<SystemTimes>,
    pub memory: Option<MemoryStatus>,
    pub power: Option<PowerStatus>,
    pub drives: Option<Vec<char>>,
    pub space: HashMap<char, Option<DiskSpace>>,
    pub online: Option<bool>,
    pub throwing: HashSet<&'static str>,
}

pub(crate) struct FakeSystemApi(Mutex<FakeState>);

impl FakeSystemApi {
    /// The metrics fixture: 16 000 bytes of RAM with 4 000 free, a battery at 80 % and drive C
    /// with 250 of 1 000 bytes free, online.
    pub fn new() -> Self {
        Self(Mutex::new(FakeState {
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
            online: Some(true),
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

    fn online(&self) -> Option<bool> {
        self.read("online", |s| s.online)
    }
}
