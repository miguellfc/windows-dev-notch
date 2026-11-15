//! Every log line of the unit-test binary, so tests can check none carries user content. One
//! logger per process: every test module shares this capture.

use std::sync::{Mutex, OnceLock, PoisonError};

pub struct Capture(Mutex<Vec<String>>);

impl Capture {
    /// The lines logged so far, as `"<LEVEL> <target> <message>"`.
    pub fn lines(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl log::Log for Capture {
    fn enabled(&self, _metadata: &log::Metadata) -> bool {
        true
    }

    fn log(&self, record: &log::Record) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(format!(
                "{} {} {}",
                record.level(),
                record.target(),
                record.args()
            ));
    }

    fn flush(&self) {}
}

/// Installs the capture on first use; `None` when another logger got there first.
pub fn capture() -> Option<&'static Capture> {
    static CAPTURE: OnceLock<Option<&'static Capture>> = OnceLock::new();
    *CAPTURE.get_or_init(|| {
        let capture: &'static Capture = Box::leak(Box::new(Capture(Mutex::new(Vec::new()))));
        log::set_logger(capture).ok()?;
        log::set_max_level(log::LevelFilter::Trace);
        Some(capture)
    })
}
