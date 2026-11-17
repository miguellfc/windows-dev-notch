//! Every log line of the unit-test binary, so tests can check none carries user content. One
//! logger per process: every test module shares this capture.

use std::sync::{Mutex, OnceLock, PoisonError};
use std::thread::ThreadId;

/// Each line with the thread that logged it.
pub struct Capture(Mutex<Vec<(ThreadId, String)>>);

impl Capture {
    /// The lines logged so far, as `"<LEVEL> <target> <message>"`.
    pub fn lines(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .map(|(_, line)| line.clone())
            .collect()
    }

    /// Only the lines this thread logged: a test whose work all runs on its own thread (a
    /// current-thread `#[tokio::test]`) sees its lines and no other test's.
    pub fn lines_of_this_thread(&self) -> Vec<String> {
        let me = std::thread::current().id();
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .filter(|(thread, _)| *thread == me)
            .map(|(_, line)| line.clone())
            .collect()
    }
}

impl log::Log for Capture {
    fn enabled(&self, _metadata: &log::Metadata) -> bool {
        true
    }

    fn log(&self, record: &log::Record) {
        // As the app logger: the HTML crates' records carry mail text and are never kept.
        if super::logger::is_silenced_target(record.target()) {
            return;
        }
        self.0.lock().unwrap_or_else(PoisonError::into_inner).push((
            std::thread::current().id(),
            format!("{} {} {}", record.level(), record.target(), record.args()),
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
