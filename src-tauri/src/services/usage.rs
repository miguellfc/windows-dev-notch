//! Local, counts-only usage log (0.1.0's `usage-log.ts`, `usage.json`) used to check
//! the PRD success metrics, and its `usage:summary` channel (0.1.0's `usage-ipc.ts`).
//! Daily aggregates by local calendar day; no reminder text, session names, paths or commands.

use std::collections::BTreeMap;
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, PoisonError};

use chrono::{DateTime, Duration, FixedOffset, NaiveDate, SecondsFormat};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::contract::usage::{is_day_key, UsageSummary, UsageSummaryInput};
use crate::contract::{parse_input, MAX_SAFE_INTEGER};
use crate::ipc::{BoxFuture, Channel, Ctx, ExposedError, IpcErrorCode, Registry};
use crate::services::fs_atomic::write_atomic;

/// Days kept on disk, today included; older days are pruned on load.
pub const USAGE_RETENTION_DAYS: i64 = 90;
/// Latency samples stored per day; later alerts are still counted.
pub const USAGE_LATENCY_CAP: usize = 200;
/// `DEFAULT_USAGE_RANGE` in `src/shared/usage/schema.ts`.
pub const DEFAULT_USAGE_RANGE: u32 = 14;
/// `USAGE_TICK_MS` in 0.1.0's `index.ts`: one running minute per tick.
pub const USAGE_TICK_MS: u64 = 60_000;

const CURRENT_VERSION: u64 = 1;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum UsageEvent {
    Launch,
    RemindersFired {
        count: f64,
    },
    RemindersMissed {
        count: f64,
    },
    ReminderCompleted,
    /// A new Claude permission request turned the capsule into alert. `latency_ms` goes from the
    /// bridge receiving the HTTP request to the notch controller applying `attention`.
    ClaudeAlert {
        latency_ms: f64,
    },
}

/// The local wall clock (`Local::now().fixed_offset()` in the app).
pub type UsageClock = Arc<dyn Fn() -> DateTime<FixedOffset> + Send + Sync>;

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct UsageDay {
    running_minutes: u64,
    launches: u64,
    reminders_fired: u64,
    reminders_missed: u64,
    reminders_completed: u64,
    claude_alerts: u64,
    claude_latency_ms: Vec<u64>,
}

impl UsageDay {
    fn is_valid(&self) -> bool {
        let counts = [
            self.running_minutes,
            self.launches,
            self.reminders_fired,
            self.reminders_missed,
            self.reminders_completed,
            self.claude_alerts,
        ];
        self.claude_latency_ms.len() <= USAGE_LATENCY_CAP
            && counts
                .iter()
                .chain(&self.claude_latency_ms)
                .all(|&count| count <= MAX_SAFE_INTEGER)
    }

    fn add_latencies(&mut self, more: &[u64]) {
        let room = USAGE_LATENCY_CAP.saturating_sub(self.claude_latency_ms.len());
        self.claude_latency_ms
            .extend(more.iter().copied().take(room));
    }

    /// Adds `from`'s counts (and its latencies, up to the cap).
    fn merge(&mut self, from: &UsageDay) {
        self.running_minutes = self.running_minutes.saturating_add(from.running_minutes);
        self.launches = self.launches.saturating_add(from.launches);
        self.reminders_fired = self.reminders_fired.saturating_add(from.reminders_fired);
        self.reminders_missed = self.reminders_missed.saturating_add(from.reminders_missed);
        self.reminders_completed = self
            .reminders_completed
            .saturating_add(from.reminders_completed);
        self.claude_alerts = self.claude_alerts.saturating_add(from.claude_alerts);
        self.add_latencies(&from.claude_latency_ms);
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct UsageFile {
    version: u64,
    days: BTreeMap<String, UsageDay>,
}

impl UsageFile {
    fn is_valid(&self) -> bool {
        self.version == CURRENT_VERSION
            && self
                .days
                .iter()
                .all(|(key, day)| is_day_key(key) && day.is_valid())
    }
}

/// Local calendar day of `date`.
fn day_key(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

/// Local day `offset` days from `date` (calendar arithmetic, safe across DST changes).
fn shift_day(date: NaiveDate, offset: i64) -> NaiveDate {
    date.checked_add_signed(Duration::days(offset))
        .unwrap_or(date)
}

fn is_newer_version(raw: &Value) -> bool {
    raw.get("version")
        .and_then(Value::as_f64)
        .is_some_and(|version| version > CURRENT_VERSION as f64)
}

/// `safeCount`: a finite positive number, rounded; anything else counts as 0.
fn safe_count(n: f64) -> u64 {
    if n.is_finite() && n > 0.0 {
        // `as` saturates at u64::MAX.
        n.round() as u64
    } else {
        0
    }
}

fn median(sorted: &[u64]) -> f64 {
    let mid = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        sorted[mid] as f64
    } else {
        (sorted[mid - 1] as f64 + sorted[mid] as f64) / 2.0
    }
}

/// Nearest-rank percentile.
fn percentile(sorted: &[u64], p: f64) -> u64 {
    let rank = (p * sorted.len() as f64).ceil() as usize;
    sorted[rank.saturating_sub(1)]
}

#[derive(Default)]
struct State {
    days: BTreeMap<String, UsageDay>,
    loaded: bool,
    read_only: bool,
    dirty: bool,
}

struct Inner {
    file: PathBuf,
    now: UsageClock,
    state: Mutex<State>,
    /// Serializes `load` and the writes (the TS promise queue).
    queue: tokio::sync::Mutex<()>,
    loaded: tokio::sync::watch::Sender<bool>,
}

/// Shared handle to the usage log; clones see the same counts.
#[derive(Clone)]
pub struct UsageLog {
    inner: Arc<Inner>,
}

impl UsageLog {
    pub fn new(file: PathBuf, now: UsageClock) -> Self {
        Self {
            inner: Arc::new(Inner {
                file,
                now,
                state: Mutex::new(State::default()),
                queue: tokio::sync::Mutex::new(()),
                loaded: tokio::sync::watch::Sender::new(false),
            }),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    fn today(&self) -> NaiveDate {
        (self.inner.now)().date_naive()
    }

    /// Reads the file (never fails); events recorded before it finishes are kept and merged.
    pub async fn load(&self) {
        let _turn = self.inner.queue.lock().await;
        let (mut from_disk, read_only) = match self.read_from_disk().await {
            Ok(result) => result,
            Err(error) => {
                log::error!(
                    "Could not load the usage log; not recording to disk this session: {error}"
                );
                (BTreeMap::new(), true)
            }
        };
        let oldest = day_key(shift_day(self.today(), -(USAGE_RETENTION_DAYS - 1)));
        {
            let mut state = self.state();
            // Events recorded while the file was being read are added on top of it.
            for (key, day) in &state.days {
                from_disk.entry(key.clone()).or_default().merge(day);
            }
            from_disk.retain(|key, _| *key >= oldest);
            state.days = from_disk;
            state.read_only |= read_only;
            state.loaded = true;
        }
        self.inner.loaded.send_replace(true);
    }

    /// Resolves once [`load`](Self::load) has finished.
    pub async fn ready(&self) {
        let mut loaded = self.inner.loaded.subscribe();
        // The sender lives in `self`, so this only ends once loaded.
        let _ = loaded.wait_for(|loaded| *loaded).await;
    }

    /// The days read from disk (empty when there is no file or it was moved aside), and whether
    /// the log must stay read-only (a file from a newer version).
    async fn read_from_disk(&self) -> io::Result<(BTreeMap<String, UsageDay>, bool)> {
        let bytes = match tokio::fs::read(&self.inner.file).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok((BTreeMap::new(), false))
            }
            Err(error) => return Err(error),
        };
        let text = String::from_utf8_lossy(&bytes);
        let Ok(raw) = serde_json::from_str::<Value>(&text) else {
            self.quarantine("Usage file is not valid JSON").await?;
            return Ok((BTreeMap::new(), false));
        };
        if is_newer_version(&raw) {
            log::warn!("Usage file comes from a newer version; not recording to disk this session");
            return Ok((BTreeMap::new(), true));
        }
        match serde_json::from_value::<UsageFile>(raw) {
            Ok(file) if file.is_valid() => Ok((file.days, false)),
            _ => {
                self.quarantine("Usage file does not match the schema")
                    .await?;
                Ok((BTreeMap::new(), false))
            }
        }
    }

    /// Moves the file aside as `usage.corrupt-<UTC time>.json`.
    async fn quarantine(&self, reason: &str) -> io::Result<()> {
        let file = &self.inner.file;
        let stem = file
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default();
        let stamp = (self.inner.now)()
            .to_utc()
            .to_rfc3339_opts(SecondsFormat::Millis, true)
            .replace([':', '.'], "-");
        let name = format!("{stem}.corrupt-{stamp}.json");
        tokio::fs::rename(file, file.with_file_name(&name)).await?;
        log::warn!("{reason}; moved it aside as {name} and started a new log");
        Ok(())
    }

    pub fn record(&self, event: UsageEvent) {
        let key = day_key(self.today());
        let mut state = self.state();
        let day = state.days.entry(key).or_default();
        match event {
            UsageEvent::Launch => day.launches = day.launches.saturating_add(1),
            UsageEvent::RemindersFired { count } => {
                day.reminders_fired = day.reminders_fired.saturating_add(safe_count(count));
            }
            UsageEvent::RemindersMissed { count } => {
                day.reminders_missed = day.reminders_missed.saturating_add(safe_count(count));
            }
            UsageEvent::ReminderCompleted => {
                day.reminders_completed = day.reminders_completed.saturating_add(1);
            }
            UsageEvent::ClaudeAlert { latency_ms } => {
                day.claude_alerts = day.claude_alerts.saturating_add(1);
                day.add_latencies(&[safe_count(latency_ms)]);
            }
        }
        state.dirty = true;
    }

    /// Called every 60 s: one running minute for today, then a flush (in the background).
    pub fn tick(&self) {
        {
            let key = day_key(self.today());
            let mut state = self.state();
            let day = state.days.entry(key).or_default();
            day.running_minutes = day.running_minutes.saturating_add(1);
            state.dirty = true;
        }
        let usage = self.clone();
        tauri::async_runtime::spawn(async move { usage.flush().await });
    }

    /// Writes pending changes; serialized, never fails, no-op before `load()` or without changes.
    pub async fn flush(&self) {
        let _turn = self.inner.queue.lock().await;
        let text = {
            let mut state = self.state();
            if !state.loaded || state.read_only || !state.dirty {
                return;
            }
            state.dirty = false;
            let data = UsageFile {
                version: CURRENT_VERSION,
                days: state.days.clone(),
            };
            serde_json::to_string(&data).map(|json| format!("{json}\n"))
        };
        let result = match text {
            Ok(text) => write_atomic(&self.inner.file, text.as_bytes()).await,
            Err(error) => Err(io::Error::other(error)),
        };
        if let Err(error) = result {
            self.state().dirty = true;
            log::error!("Could not save the usage log: {error}");
        }
    }

    pub fn summary(&self, range_days: u32) -> UsageSummary {
        let end = self.today();
        let state = self.state();
        let mut total = UsageDay::default();
        let mut used = 0u64;
        let mut latencies = Vec::new();
        for offset in (0..i64::from(range_days)).rev() {
            let Some(day) = state.days.get(&day_key(shift_day(end, -offset))) else {
                continue;
            };
            // A launch counts too, so a fresh start never shows 0 days next to 1 launch.
            if day.running_minutes > 0 || day.launches > 0 {
                used += 1;
            }
            total.merge(&UsageDay {
                claude_latency_ms: Vec::new(),
                ..day.clone()
            });
            latencies.extend_from_slice(&day.claude_latency_ms);
        }
        drop(state);
        latencies.sort_unstable();
        let has_latencies = !latencies.is_empty();
        UsageSummary {
            days: used,
            running_hours_avg: if used == 0 {
                0.0
            } else {
                total.running_minutes as f64 / 60.0 / used as f64
            },
            launches: total.launches,
            reminders_fired: total.reminders_fired,
            reminders_missed: total.reminders_missed,
            reminders_completed: total.reminders_completed,
            claude_alerts: total.claude_alerts,
            claude_latency_median_ms: has_latencies.then(|| median(&latencies).round() as u64),
            claude_latency_p95_ms: has_latencies.then(|| percentile(&latencies, 0.95)),
            from: day_key(shift_day(end, -(i64::from(range_days.max(1)) - 1))),
            to: day_key(end),
        }
    }

    /// Ticks every [`USAGE_TICK_MS`] until the returned task is aborted (the quit sequence).
    pub fn start_ticker(&self) -> tauri::async_runtime::JoinHandle<()> {
        let usage = self.clone();
        tauri::async_runtime::spawn(async move {
            usage
                .run_ticker(std::time::Duration::from_millis(USAGE_TICK_MS))
                .await;
        })
    }

    /// Ticks every `period`, forever. A slipped deadline (the PC slept, the runtime stalled)
    /// gives a single tick, not one per missed period: like Node's `setInterval`, so a night of
    /// sleep never adds hundreds of running minutes.
    async fn run_ticker(&self, period: std::time::Duration) {
        let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + period, period);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            self.tick();
        }
    }
}

/// `usage:summary`: waits for the log to finish loading so the first summary already includes
/// the file.
struct SummaryChannel(Arc<OnceLock<UsageLog>>);

impl Channel for SummaryChannel {
    fn handle<'a>(
        &'a self,
        _ctx: &'a Ctx,
        input: Value,
    ) -> BoxFuture<'a, Result<Value, ExposedError>> {
        Box::pin(async move {
            let input: UsageSummaryInput = parse_input(input)?;
            let usage =
                self.0.get().cloned().ok_or_else(|| {
                    ExposedError::new(IpcErrorCode::Unavailable, "Not available yet")
                })?;
            usage.ready().await;
            let summary = usage.summary(input.days.unwrap_or(DEFAULT_USAGE_RANGE));
            serde_json::to_value(summary).map_err(ExposedError::internal)
        })
    }
}

/// Registers `usage:summary` (Control Center only, see `GUARDS`); the handler reaches the log
/// through `slot`, filled in `setup`.
pub fn register(registry: &mut Registry, slot: Arc<OnceLock<UsageLog>>) {
    registry.register("usage:summary", SummaryChannel(slot));
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use chrono::Utc;
    use serde_json::{json, Value};
    use tauri::async_runtime::block_on;

    use super::*;
    use crate::contract::Validate;
    use crate::ipc::{Ctx, Sender, CONTROL_CENTER};
    use crate::services::test_dir::TestDir;

    /// Madrid in November (CET, UTC+1).
    fn at(utc: &str) -> DateTime<FixedOffset> {
        utc.parse::<DateTime<Utc>>()
            .unwrap()
            .with_timezone(&FixedOffset::east_opt(3600).unwrap())
    }

    struct Fixture {
        dir: TestDir,
        clock: Arc<Mutex<DateTime<FixedOffset>>>,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                dir: TestDir::new("usage"),
                // 10:00 local (Madrid).
                clock: Arc::new(Mutex::new(at("2026-11-10T09:00:00.000Z"))),
            }
        }

        fn file(&self) -> PathBuf {
            self.dir.join("usage.json")
        }

        fn set_clock(&self, utc: &str) {
            *self.clock.lock().unwrap() = at(utc);
        }

        fn make(&self) -> UsageLog {
            let clock = Arc::clone(&self.clock);
            UsageLog::new(self.file(), Arc::new(move || *clock.lock().unwrap()))
        }

        fn write(&self, value: &Value) {
            std::fs::write(self.file(), value.to_string()).unwrap();
        }

        fn read_disk(&self) -> Value {
            serde_json::from_str(&std::fs::read_to_string(self.file()).unwrap()).unwrap()
        }
    }

    fn day(running_minutes: u64, launches: u64) -> Value {
        json!({
            "runningMinutes": running_minutes,
            "launches": launches,
            "remindersFired": 1,
            "remindersMissed": 0,
            "remindersCompleted": 1,
            "claudeAlerts": 0,
            "claudeLatencyMs": [],
        })
    }

    #[test]
    fn uses_the_local_calendar_day_of_the_clock() {
        let fx = Fixture::new();
        fx.set_clock("2026-11-10T23:30:00.000Z");
        let usage = fx.make();
        block_on(usage.load());
        usage.record(UsageEvent::Launch);
        assert_eq!(usage.summary(7).to, "2026-11-11");
    }

    #[test]
    fn starts_empty_when_there_is_no_file_and_writes_nothing_until_a_flush_with_changes() {
        let fx = Fixture::new();
        let usage = fx.make();
        block_on(usage.load());
        block_on(usage.flush());
        assert!(fx.dir.names().is_empty());
        let summary = usage.summary(14);
        assert_eq!(summary.days, 0);
        assert_eq!(summary.launches, 0);
        assert_eq!(summary.claude_latency_median_ms, None);
        assert_eq!(summary.claude_latency_p95_ms, None);
    }

    #[test]
    fn aggregates_events_per_local_day_and_persists_them() {
        let fx = Fixture::new();
        let usage = fx.make();
        block_on(usage.load());
        usage.record(UsageEvent::Launch);
        usage.tick();
        usage.tick();
        usage.record(UsageEvent::RemindersFired { count: 2.0 });
        usage.record(UsageEvent::RemindersMissed { count: 3.0 });
        usage.record(UsageEvent::ReminderCompleted);
        usage.record(UsageEvent::ReminderCompleted);
        usage.record(UsageEvent::ClaudeAlert { latency_ms: 40.0 });
        block_on(usage.flush());

        let disk = fx.read_disk();
        assert_eq!(disk["version"], 1);
        assert_eq!(
            disk["days"]["2026-11-10"],
            json!({
                "runningMinutes": 2,
                "launches": 1,
                "remindersFired": 2,
                "remindersMissed": 3,
                "remindersCompleted": 2,
                "claudeAlerts": 1,
                "claudeLatencyMs": [40],
            })
        );
    }

    #[test]
    fn counts_a_fresh_launch_as_a_used_day_even_before_the_first_full_minute() {
        let fx = Fixture::new();
        let usage = fx.make();
        block_on(usage.load());
        usage.record(UsageEvent::Launch);
        let summary = usage.summary(14);
        assert_eq!(
            (summary.days, summary.launches, summary.running_hours_avg),
            (1, 1, 0.0)
        );
    }

    #[test]
    fn rolls_over_to_the_next_day_at_local_midnight_not_utc_midnight() {
        let fx = Fixture::new();
        let usage = fx.make();
        block_on(usage.load());
        fx.set_clock("2026-11-10T22:59:30.000Z"); // 23:59:30 Madrid
        usage.tick();
        fx.set_clock("2026-11-10T23:00:30.000Z"); // 00:00:30 Madrid, next day
        usage.tick();
        usage.record(UsageEvent::Launch);
        block_on(usage.flush());

        let disk = fx.read_disk();
        assert_eq!(disk["days"]["2026-11-10"]["runningMinutes"], 1);
        assert_eq!(disk["days"]["2026-11-10"]["launches"], 0);
        assert_eq!(disk["days"]["2026-11-11"]["runningMinutes"], 1);
        assert_eq!(disk["days"]["2026-11-11"]["launches"], 1);
    }

    #[test]
    fn keeps_events_recorded_before_load_finished_and_merges_them_with_the_file() {
        let fx = Fixture::new();
        fx.write(&json!({ "version": 1, "days": { "2026-11-10": {
            "runningMinutes": 5, "launches": 1, "remindersFired": 0, "remindersMissed": 0,
            "remindersCompleted": 0, "claudeAlerts": 1, "claudeLatencyMs": [10]
        } } }));
        let usage = fx.make();
        usage.record(UsageEvent::Launch);
        usage.record(UsageEvent::ClaudeAlert { latency_ms: 30.0 });
        block_on(usage.load());
        block_on(usage.flush());
        let today = &fx.read_disk()["days"]["2026-11-10"];
        assert_eq!(today["runningMinutes"], 5);
        assert_eq!(today["launches"], 2);
        assert_eq!(today["claudeAlerts"], 2);
        assert_eq!(today["claudeLatencyMs"], json!([10, 30]));
    }

    #[test]
    fn prunes_days_older_than_the_retention_on_load() {
        let fx = Fixture::new();
        let one = json!({ "runningMinutes": 1, "launches": 1, "remindersFired": 0,
            "remindersMissed": 0, "remindersCompleted": 0, "claudeAlerts": 0, "claudeLatencyMs": [] });
        // Today is 2026-11-10: the oldest kept day is 2026-08-13 (90 days including today).
        fx.write(&json!({ "version": 1, "days": {
            "2026-08-12": one, "2026-08-13": one, "2026-11-09": one
        } }));
        let usage = fx.make();
        block_on(usage.load());
        usage.record(UsageEvent::Launch);
        block_on(usage.flush());
        let disk = fx.read_disk();
        let mut keys: Vec<&String> = disk["days"].as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["2026-08-13", "2026-11-09", "2026-11-10"]);
    }

    #[test]
    fn caps_stored_latencies_per_day_but_keeps_counting_alerts() {
        let fx = Fixture::new();
        let usage = fx.make();
        block_on(usage.load());
        for i in 0..USAGE_LATENCY_CAP + 5 {
            usage.record(UsageEvent::ClaudeAlert {
                latency_ms: i as f64,
            });
        }
        usage.record(UsageEvent::ClaudeAlert { latency_ms: -3.0 });
        block_on(usage.flush());
        let today = &fx.read_disk()["days"]["2026-11-10"];
        assert_eq!(today["claudeAlerts"], USAGE_LATENCY_CAP as u64 + 6);
        assert_eq!(
            today["claudeLatencyMs"].as_array().unwrap().len(),
            USAGE_LATENCY_CAP
        );
    }

    #[test]
    fn computes_median_and_p95_latency_over_the_range() {
        let fx = Fixture::new();
        let usage = fx.make();
        block_on(usage.load());
        for ms in 1..=20 {
            usage.record(UsageEvent::ClaudeAlert {
                latency_ms: f64::from(ms * 10),
            });
        }
        let summary = usage.summary(14);
        assert_eq!(summary.claude_latency_median_ms, Some(105)); // mean of 100 and 110
        assert_eq!(summary.claude_latency_p95_ms, Some(190)); // nearest rank: 19th of 20
        assert_eq!(summary.claude_alerts, 20);
    }

    #[test]
    fn rounds_non_integer_latencies_so_the_summary_stays_integral() {
        let fx = Fixture::new();
        let usage = fx.make();
        block_on(usage.load());
        usage.record(UsageEvent::ClaudeAlert { latency_ms: 12.6 });
        let summary = usage.summary(7);
        assert_eq!(summary.claude_latency_median_ms, Some(13));
        assert_eq!(summary.claude_latency_p95_ms, Some(13));
    }

    #[test]
    fn summarizes_a_range_with_empty_days_and_ignores_days_outside_it() {
        let fx = Fixture::new();
        // A 7-day range is 2026-11-04..2026-11-10: 2026-11-03 falls outside it.
        // 2026-11-08 has a launch but no full minute: it still counts as used.
        fx.write(&json!({ "version": 1, "days": {
            "2026-11-03": day(600, 9),
            "2026-11-05": day(120, 1),
            "2026-11-07": day(0, 0),
            "2026-11-08": day(0, 1),
            "2026-11-10": day(240, 2),
        } }));
        let usage = fx.make();
        block_on(usage.load());
        let summary = usage.summary(7);
        assert_eq!(summary.validate(), Ok(()));
        assert_eq!(
            summary,
            UsageSummary {
                days: 3,
                running_hours_avg: 2.0, // (120 + 0 + 240) min / 60 / 3 used days
                launches: 4,
                reminders_fired: 4,
                reminders_missed: 0,
                reminders_completed: 4,
                claude_alerts: 0,
                claude_latency_median_ms: None,
                claude_latency_p95_ms: None,
                from: "2026-11-04".into(),
                to: "2026-11-10".into(),
            }
        );
        let wide = usage.summary(14);
        assert_eq!(
            (wide.days, wide.launches, wide.from.as_str()),
            (4, 13, "2026-10-28")
        );
    }

    #[test]
    fn quarantines_a_corrupt_file_and_starts_empty() {
        let fx = Fixture::new();
        std::fs::write(fx.file(), "{ not json").unwrap();
        let usage = fx.make();
        block_on(usage.load());
        let names = fx.dir.names();
        assert_eq!(
            names,
            ["usage.corrupt-2026-11-10T09-00-00-000Z.json".to_owned()]
        );
        usage.record(UsageEvent::Launch);
        block_on(usage.flush());
        assert_eq!(fx.read_disk()["days"]["2026-11-10"]["launches"], 1);
    }

    #[test]
    fn quarantines_a_file_that_does_not_match_the_schema() {
        let fx = Fixture::new();
        fx.write(&json!({ "version": 1, "days": { "2026-11-10": { "launches": -1 } } }));
        let usage = fx.make();
        block_on(usage.load());
        assert!(fx
            .dir
            .names()
            .iter()
            .any(|name| name.starts_with("usage.corrupt-")));
        assert_eq!(usage.summary(14).launches, 0);
    }

    #[test]
    fn quarantines_bad_day_keys_and_oversized_latency_lists() {
        for days in [
            json!({ "2026-1-10": day(1, 1) }),
            json!({ "2026-11-10": {
                "runningMinutes": 0, "launches": 0, "remindersFired": 0, "remindersMissed": 0,
                "remindersCompleted": 0, "claudeAlerts": 0,
                "claudeLatencyMs": vec![1; USAGE_LATENCY_CAP + 1]
            } }),
            json!({ "2026-11-10": { "runningMinutes": 1.5, "launches": 0, "remindersFired": 0,
                "remindersMissed": 0, "remindersCompleted": 0, "claudeAlerts": 0,
                "claudeLatencyMs": [] } }),
        ] {
            let fx = Fixture::new();
            fx.write(&json!({ "version": 1, "days": days }));
            block_on(fx.make().load());
            assert!(!fx.file().exists(), "{days}");
        }
    }

    #[test]
    fn never_overwrites_a_file_from_a_newer_version() {
        let fx = Fixture::new();
        let newer = json!({ "version": 2, "days": {} }).to_string();
        std::fs::write(fx.file(), &newer).unwrap();
        let usage = fx.make();
        block_on(usage.load());
        usage.record(UsageEvent::Launch);
        block_on(usage.flush());
        assert_eq!(std::fs::read_to_string(fx.file()).unwrap(), newer);
    }

    #[test]
    fn serializes_flushes_so_the_last_write_wins_and_none_overlap() {
        let fx = Fixture::new();
        let usage = fx.make();
        block_on(usage.load());
        let (a, b, c) = (usage.clone(), usage.clone(), usage.clone());
        usage.record(UsageEvent::Launch);
        let first = tauri::async_runtime::spawn(async move { a.flush().await });
        usage.record(UsageEvent::Launch);
        let second = tauri::async_runtime::spawn(async move { b.flush().await });
        usage.record(UsageEvent::Launch);
        let third = tauri::async_runtime::spawn(async move { c.flush().await });
        block_on(async {
            first.await.unwrap();
            second.await.unwrap();
            third.await.unwrap();
        });
        block_on(usage.flush());
        assert_eq!(fx.read_disk()["days"]["2026-11-10"]["launches"], 3);
        // No temp files left behind by overlapping writes.
        assert_eq!(fx.dir.names(), ["usage.json".to_owned()]);
    }

    #[test]
    fn does_not_write_before_load_ran_so_an_unread_file_is_never_clobbered() {
        let fx = Fixture::new();
        let original = json!({ "version": 1, "days": {} }).to_string();
        std::fs::write(fx.file(), &original).unwrap();
        let usage = fx.make();
        usage.record(UsageEvent::Launch);
        block_on(usage.flush());
        assert_eq!(std::fs::read_to_string(fx.file()).unwrap(), original);
    }

    #[test]
    fn stores_nothing_but_counts() {
        let fx = Fixture::new();
        let usage = fx.make();
        block_on(usage.load());
        usage.record(UsageEvent::Launch);
        usage.record(UsageEvent::ClaudeAlert { latency_ms: 5.0 });
        block_on(usage.flush());
        let text = std::fs::read_to_string(fx.file()).unwrap().to_lowercase();
        for word in ["text", "session", "path", "command"] {
            assert!(!text.contains(word), "{word}");
        }
    }

    #[test]
    fn ready_waits_for_load() {
        let fx = Fixture::new();
        let usage = fx.make();
        let waiter = usage.clone();
        let ready = tauri::async_runtime::spawn(async move { waiter.ready().await });
        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(!ready.inner().is_finished());
        block_on(usage.load());
        block_on(ready).unwrap();
    }

    /// Running minutes in the last week (the summary does not expose them directly).
    fn running_minutes(usage: &UsageLog) -> f64 {
        let summary = usage.summary(7);
        (summary.running_hours_avg * 60.0 * summary.days as f64).round()
    }

    #[test]
    fn ticker_gives_one_tick_after_a_long_stall_not_one_per_missed_period() {
        let fx = Fixture::new();
        let usage = fx.make();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .start_paused(true)
            .build()
            .unwrap();
        runtime.block_on(async {
            let period = std::time::Duration::from_millis(USAGE_TICK_MS);
            let ticker = {
                let usage = usage.clone();
                tokio::spawn(async move { usage.run_ticker(period).await })
            };
            let settle = || async {
                for _ in 0..2_000 {
                    tokio::task::yield_now().await;
                }
            };
            settle().await;
            assert_eq!(running_minutes(&usage), 0.0);
            // One period on time: one tick.
            tokio::time::advance(period).await;
            settle().await;
            assert_eq!(running_minutes(&usage), 1.0);
            // The clock jumps 8 h while the ticker cannot run (the PC slept): one more tick.
            tokio::time::advance(period * 480).await;
            settle().await;
            assert_eq!(running_minutes(&usage), 2.0);
            // And the next one comes a full period later.
            tokio::time::advance(period / 2).await;
            settle().await;
            assert_eq!(running_minutes(&usage), 2.0);
            tokio::time::advance(period / 2).await;
            settle().await;
            assert_eq!(running_minutes(&usage), 3.0);
            ticker.abort();
        });
    }

    fn call(registry: &Registry, input: Value) -> Value {
        let ctx = Ctx::for_test(Sender {
            label: CONTROL_CENTER.into(),
            url: "http://tauri.localhost/control-center/index.html"
                .parse()
                .unwrap(),
        });
        block_on(registry.dispatch(&ctx, "usage:summary", Some(input)))
    }

    #[test]
    fn summary_channel_answers_from_the_log() {
        let fx = Fixture::new();
        let slot = Arc::new(OnceLock::new());
        let mut registry = Registry::with_dev_origin(false);
        register(&mut registry, Arc::clone(&slot));

        // Before setup filled the slot.
        assert_eq!(call(&registry, json!({}))["error"]["code"], "UNAVAILABLE");

        let usage = fx.make();
        block_on(usage.load());
        usage.record(UsageEvent::Launch);
        assert!(slot.set(usage).is_ok());

        let response = call(&registry, json!({}));
        assert_eq!(response["ok"], true);
        assert_eq!(response["data"]["launches"], 1);
        assert_eq!(response["data"]["from"], "2026-10-28"); // 14 days by default
        let week = call(&registry, json!({ "days": 7 }));
        assert_eq!(week["data"]["from"], "2026-11-04");
        assert_eq!(
            call(&registry, json!({ "days": 5 }))["error"]["code"],
            "INVALID_INPUT"
        );
        assert_eq!(
            call(&registry, Value::Null)["error"]["code"],
            "INVALID_INPUT"
        );
    }
}
