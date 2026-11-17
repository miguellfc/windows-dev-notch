//! The wall clock (`now: () => Date` in the Electron modules): real time plus an offset that the
//! E2E test clock moves (`clockOffsetMs` in 0.1.0's `index.ts`, `__e2e:advance-clock` here).
//! Shared as `Arc<WallClock>` (managed Tauri state), so every module that follows the test clock
//! sees the same offset.

use std::sync::{Mutex, PoisonError};

use chrono::{DateTime, Duration, Utc};

pub struct WallClock {
    /// `None`: the system clock. `Some`: a frozen base time (unit tests).
    base: Option<DateTime<Utc>>,
    offset_ms: Mutex<i64>,
}

impl WallClock {
    /// The system clock, with no offset until [`advance`](Self::advance) moves it.
    pub fn real() -> Self {
        Self {
            base: None,
            offset_ms: Mutex::new(0),
        }
    }

    /// A clock frozen at `at` (plus whatever [`advance`](Self::advance) adds), for tests.
    pub fn fixed(at: DateTime<Utc>) -> Self {
        Self {
            base: Some(at),
            offset_ms: Mutex::new(0),
        }
    }

    pub fn now(&self) -> DateTime<Utc> {
        let base = self.base.unwrap_or_else(Utc::now);
        Duration::try_milliseconds(*self.offset())
            .and_then(|offset| base.checked_add_signed(offset))
            .unwrap_or(base)
    }

    /// Moves the clock by `ms` (negative moves it back); saturates instead of wrapping.
    pub fn advance(&self, ms: i64) {
        let mut offset = self.offset();
        *offset = offset.saturating_add(ms);
    }

    fn offset(&self) -> std::sync::MutexGuard<'_, i64> {
        self.offset_ms
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wall_clock_advance_moves_now() {
        let clock = WallClock::real();
        let before = Utc::now();
        let now = clock.now();
        assert!(now >= before && now - before < Duration::seconds(5));
        clock.advance(31 * 60_000);
        let moved = clock.now();
        assert!(moved - now >= Duration::minutes(31));
        assert!(moved - now < Duration::minutes(31) + Duration::seconds(5));
        clock.advance(-31 * 60_000);
        assert!(clock.now() - now < Duration::seconds(5));
    }
}
