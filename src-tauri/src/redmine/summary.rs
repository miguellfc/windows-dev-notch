//! Hours and the month summary (the pure helpers of 0.1.0's `redmine-integration.ts`:
//! `round2`, `sumHours`, `summarizeHours` and the range `runSummary` asks for).
//!
//! Local dates come from `now`'s own time zone, generic over [`TimeZone`] like
//! `code_review::contributions` (production: `chrono::Local`, which follows the Windows zone
//! rules; tests: `chrono_tz::Europe::Madrid`). Where Windows and ICU disagree on an offset the
//! local day can differ from the renderer's for that hour: the same known follow-up as part 4,
//! documented, not fixed here.

use std::collections::HashMap;

use chrono::{DateTime, Datelike, TimeZone};

use crate::code_review::contributions::{local_date, local_midnight, week_start};
use crate::contract::redmine::{RedmineSummary, SummaryDay};
use crate::redmine::client::TimeEntry;

/// `Math.round(hours * 100) / 100`. `Math.round` rounds halves up (towards +infinity), unlike
/// `f64::round`, so it is spelt out; for the non-negative hours Redmine returns both agree.
pub fn round2(hours: f64) -> f64 {
    let scaled = hours * 100.0;
    let floor = scaled.floor();
    // `scaled - floor` is exact, so this is `Math.round` (no `+ 0.5` rounding error).
    let rounded = if scaled - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    };
    rounded / 100.0
}

/// `sumHours(entries)`: the sum in entry order, rounded to 2 decimals (0.1 + 0.2 = 0.3).
pub fn sum_hours<'a>(entries: impl IntoIterator<Item = &'a TimeEntry>) -> f64 {
    round2(
        entries
            .into_iter()
            .fold(0.0, |total, entry| total + entry.hours),
    )
}

/// The 1st of `now`'s month at 00:00 local (`new Date(y, m, 1)`).
fn month_first<Tz: TimeZone>(now: &DateTime<Tz>) -> DateTime<Tz> {
    let today = now.date_naive();
    local_midnight(&now.timezone(), today.with_day(1).unwrap_or(today))
}

/// `summarizeHours(entries, now)`: today, the week (from Monday), the month (from the 1st) and
/// one day per date from the 1st to today. Hours are summed per date in the order the dates
/// first appear, as the TS `Map` iterates, so the float sums match to the last bit; `week` and
/// `monthTotal` only count dates in `from..=today` (string comparison, like the TS).
pub fn summarize_hours<Tz: TimeZone>(entries: &[TimeEntry], now: &DateTime<Tz>) -> RedmineSummary {
    let zone = now.timezone();
    let today = local_date(now);
    let monday = local_date(&week_start(now));
    let first = local_date(&month_first(now));
    let mut by_day: Vec<(&str, f64)> = Vec::new();
    let mut index: HashMap<&str, usize> = HashMap::new();
    for entry in entries {
        match index.get(entry.date.as_str()) {
            Some(&at) => by_day[at].1 += entry.hours,
            None => {
                index.insert(&entry.date, by_day.len());
                // `0 + hours`, as the JS sum starts: a `-0` entry serializes as `0`.
                by_day.push((&entry.date, 0.0 + entry.hours));
            }
        }
    }
    let hours_on = |date: &str| index.get(date).map_or(0.0, |&at| by_day[at].1);
    let total = |from: &str| {
        round2(
            by_day
                .iter()
                .filter(|(date, _)| *date >= from && *date <= today.as_str())
                .fold(0.0, |sum, (_, hours)| sum + hours),
        )
    };
    let current = now.date_naive();
    let days = (1..=current.day())
        .filter_map(|day| current.with_day(day))
        .map(|day| {
            let date = local_date(&local_midnight(&zone, day));
            let hours = round2(hours_on(&date));
            SummaryDay { date, hours }
        })
        .collect();
    RedmineSummary {
        month: first.get(..7).unwrap_or(&first).to_string(),
        days,
        today: round2(hours_on(&today)),
        week: total(&monday),
        month_total: total(&first),
    }
}

/// The `timeEntries(from, to)` range of `runSummary`: from the Monday of the week or the 1st of
/// the month, whichever is earlier (the week may start in the previous month), to today.
pub fn summary_range<Tz: TimeZone>(now: &DateTime<Tz>) -> (String, String) {
    let first = month_first(now);
    let monday = week_start(now);
    let from = if monday < first { monday } else { first };
    (local_date(&from), local_date(now))
}

#[cfg(test)]
mod tests {
    use chrono::{DateTime, TimeZone};
    use chrono_tz::Europe::Madrid;
    use chrono_tz::Tz;

    use super::*;
    use crate::contract::redmine::SummaryDay;

    fn at(y: i32, mo: u32, d: u32, h: u32) -> DateTime<Tz> {
        Madrid.with_ymd_and_hms(y, mo, d, h, 0, 0).unwrap()
    }

    fn entry(date: &str, hours: f64) -> TimeEntry {
        TimeEntry {
            date: date.into(),
            hours,
        }
    }

    #[test]
    fn round2_rounds_like_math_round() {
        assert_eq!(round2(0.125), 0.13);
        // 1.005 * 100 is 100.49999999999999 in binary: down, as in JS.
        assert_eq!(round2(1.005), 1.0);
        assert_eq!(round2(7.5), 7.5);
        assert_eq!(round2(0.0), 0.0);
        assert_eq!(round2(2.0 / 3.0), 0.67);
    }

    #[test]
    fn summary_sums_float_hours_without_noise() {
        let entries = [entry("2026-11-16", 0.1), entry("2026-11-16", 0.2)];
        assert_eq!(0.1 + 0.2, 0.300_000_000_000_000_04);
        assert_eq!(sum_hours(&entries), 0.3);
        // An empty sum is +0 (JSON `0`), not the `-0.0` `Iterator::sum` starts from.
        assert!(sum_hours(entries.iter().filter(|e| e.date == "x")).is_sign_positive());
        let summary = summarize_hours(&entries, &at(2026, 11, 16, 10));
        assert_eq!(summary.today, 0.3);
        assert_eq!(summary.week, 0.3);
        assert_eq!(summary.month_total, 0.3);
        assert_eq!(summary.days.last().map(|d| d.hours), Some(0.3));
    }

    /// A `-0` entry starts its day as `0 + -0 = 0`, as the JS sum does: JSON `0`, not `-0.0`.
    #[test]
    fn summary_day_of_a_negative_zero_entry_is_positive_zero() {
        let summary = summarize_hours(&[entry("2026-11-16", -0.0)], &at(2026, 11, 16, 10));
        let day = summary.days.last().map(|d| d.hours).unwrap();
        assert!(day.is_sign_positive());
        assert_eq!(serde_json::to_string(&day).unwrap(), "0.0");
    }

    /// The integration test "covers the 1st of the month to today and sums today, the week (from
    /// Monday) and the month" (Saturday 14 Nov 2026), at the level of the pure helpers.
    #[test]
    fn summary_covers_the_first_of_the_month_to_today() {
        let now = at(2026, 11, 14, 10);
        assert_eq!(
            summary_range(&now),
            ("2026-11-01".to_string(), "2026-11-14".to_string())
        );
        let entries = [
            entry("2026-11-02", 8.0),
            entry("2026-11-09", 4.0),
            entry("2026-11-09", 3.5),
            entry("2026-11-13", 6.0),
            entry("2026-11-14", 2.0),
        ];
        let summary = summarize_hours(&entries, &now);
        assert_eq!(summary.month, "2026-11");
        assert_eq!(summary.today, 2.0);
        assert_eq!(summary.week, 15.5);
        assert_eq!(summary.month_total, 23.5);
        assert_eq!(summary.days.len(), 14);
        assert_eq!(
            summary.days[0],
            SummaryDay {
                date: "2026-11-01".into(),
                hours: 0.0
            }
        );
        assert_eq!(
            summary.days[8],
            SummaryDay {
                date: "2026-11-09".into(),
                hours: 7.5
            }
        );
        assert_eq!(summary.days[13].date, "2026-11-14");
    }

    #[test]
    fn summary_week_starting_in_previous_month() {
        // Wednesday 2 Dec 2026: the week began on Monday 30 Nov.
        let now = at(2026, 12, 2, 10);
        assert_eq!(
            summary_range(&now),
            ("2026-11-30".to_string(), "2026-12-02".to_string())
        );
        let entries = [entry("2026-11-30", 4.0), entry("2026-12-01", 3.0)];
        let summary = summarize_hours(&entries, &now);
        assert_eq!(summary.month, "2026-12");
        assert_eq!(summary.today, 0.0);
        assert_eq!(summary.week, 7.0);
        assert_eq!(summary.month_total, 3.0);
        assert_eq!(
            summary.days,
            [
                SummaryDay {
                    date: "2026-12-01".into(),
                    hours: 3.0
                },
                SummaryDay {
                    date: "2026-12-02".into(),
                    hours: 0.0
                },
            ]
        );
    }

    #[test]
    fn summary_ignores_entries_after_today() {
        // `total(from)` only counts `from <= date <= today`; `days` never goes past today.
        let now = at(2026, 11, 3, 10);
        let entries = [entry("2026-11-03", 1.0), entry("2026-11-04", 5.0)];
        let summary = summarize_hours(&entries, &now);
        assert_eq!(summary.week, 1.0);
        assert_eq!(summary.month_total, 1.0);
        assert_eq!(summary.days.len(), 3);
    }
}
