//! Local-time recurrence math (`src/shared/reminders/time.ts`). Instants are UTC
//! (`DateTime<Utc>`, a JS `Date`); the calendar and wall clock are those of `tz` (production:
//! `chrono::Local`; tests: `chrono_tz::Europe::Madrid`, the zone the TS suite pins with
//! `process.env.TZ`).
//!
//! JS `Date` semantics mirrored here:
//! - `new Date(y, m, d + days, h, min)` normalises calendar overflow (month and year ends).
//! - A wall time skipped by a spring-forward gap is read with the offset in force before the
//!   gap, so it lands `gap` later (ECMA-262 "compatible" disambiguation); [`at_local_time`] then
//!   walks back to the first valid instant after the gap.
//! - A wall time repeated on fall-back resolves to its first (earliest) occurrence.

use chrono::{
    DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, Offset, TimeZone, Timelike, Utc,
    Weekday,
};

use crate::contract::reminders::ReminderPreset;

pub const MINUTE_MS: i64 = 60_000;
/// Upper bound for scanning day by day (covers weekends plus slack).
const MAX_SCAN_DAYS: i64 = 10;
/// How far [`at_local_time`] walks back to find the start of a gap (`i < 180`).
const MAX_GAP_WALK_MINUTES: usize = 180;

/// The two repeating kinds (`'daily' | 'weekdays'`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recurrence {
    Daily,
    Weekdays,
}

/// The UTC offset `tz` uses at the instant `at` (`-getTimezoneOffset()`, in seconds).
fn offset_at<Tz: TimeZone>(tz: &Tz, at: DateTime<Utc>) -> i32 {
    tz.offset_from_utc_datetime(&at.naive_utc())
        .fix()
        .local_minus_utc()
}

/// The instant JS `new Date(y, m, d, h, min)` builds for the wall time `local` in `tz`: the only
/// match; the earliest of a repeated (fall-back) time; and for a time skipped by a gap, the
/// wall time read with the offset in force just before the gap (so it lands `gap` later).
pub fn resolve_local<Tz: TimeZone>(tz: &Tz, local: NaiveDateTime) -> DateTime<Utc> {
    if let Some(at) = tz.from_local_datetime(&local).earliest() {
        return at.with_timezone(&Utc);
    }
    // In a gap: the offset of the last valid wall time before it (gaps are at most a day).
    let before = (1..=24 * 60)
        .filter_map(|minutes| local.checked_sub_signed(Duration::minutes(minutes)))
        .find_map(|earlier| tz.from_local_datetime(&earlier).latest())
        .map_or(0, |earlier| earlier.offset().fix().local_minus_utc());
    local
        .checked_sub_signed(Duration::seconds(i64::from(before)))
        .unwrap_or(local)
        .and_utc()
}

/// The local calendar date of `at`.
fn local_date<Tz: TimeZone>(tz: &Tz, at: DateTime<Utc>) -> NaiveDate {
    at.with_timezone(tz).date_naive()
}

/// `date + days` like `new Date(y, m, d + days)` (month and year overflow); saturates at
/// chrono's range instead of failing.
fn shift_days(date: NaiveDate, days: i64) -> NaiveDate {
    date.checked_add_signed(Duration::days(days))
        .unwrap_or(if days < 0 {
            NaiveDate::MIN
        } else {
            NaiveDate::MAX
        })
}

/// `startOfLocalDay(day, days)`: 00:00 local of the local calendar date of `day` shifted by
/// `days` whole days.
pub fn start_of_local_day<Tz: TimeZone>(tz: &Tz, day: DateTime<Utc>, days: i64) -> DateTime<Utc> {
    let date = shift_days(local_date(tz, day), days);
    resolve_local(tz, date.and_time(chrono::NaiveTime::MIN))
}

/// `hhmm.split(':').map(Number)`. Callers pass a validated `HH:mm` (`localTimeSchema`); anything
/// else reads as 00:00 instead of failing.
fn hour_minute(hhmm: &str) -> (u32, u32) {
    let mut parts = hhmm.split(':').map(|part| part.parse::<u32>().ok());
    match (parts.next().flatten(), parts.next().flatten()) {
        (Some(hour), Some(minute)) if hour < 24 && minute < 60 => (hour, minute),
        _ => (0, 0),
    }
}

/// `atLocalTime(day, "HH:mm")`: the instant of wall-clock `hhmm` on the local calendar date of
/// `day`. A wall time skipped by a spring-forward gap resolves to the first valid instant after
/// the gap; an ambiguous fall-back time to its first occurrence.
pub fn at_local_time<Tz: TimeZone>(tz: &Tz, day: DateTime<Utc>, hhmm: &str) -> DateTime<Utc> {
    let (hour, minute) = hour_minute(hhmm);
    let date = local_date(tz, day);
    let wall = date
        .and_hms_opt(hour, minute, 0)
        .unwrap_or_else(|| date.and_time(chrono::NaiveTime::MIN));
    let candidate = resolve_local(tz, wall);
    let shown = candidate.with_timezone(tz);
    if shown.hour() == hour && shown.minute() == minute {
        return candidate;
    }
    // Nonexistent wall time: it was shifted forward by the gap length. Walk back to the
    // transition instant (the first minute that already uses the post-gap offset).
    let offset = offset_at(tz, candidate);
    let mut t = candidate;
    for _ in 0..MAX_GAP_WALK_MINUTES {
        let Some(previous) = t.checked_sub_signed(Duration::minutes(1)) else {
            break;
        };
        if offset_at(tz, previous) != offset {
            break;
        }
        t = previous;
    }
    t
}

/// `nextOccurrence`: the next `local_time` strictly after `after`; weekdays skip local Saturday
/// and Sunday.
pub fn next_occurrence<Tz: TimeZone>(
    tz: &Tz,
    repeat: Recurrence,
    local_time: &str,
    after: DateTime<Utc>,
) -> DateTime<Utc> {
    for i in 0..=MAX_SCAN_DAYS {
        let day = start_of_local_day(tz, after, i);
        let weekday = day.with_timezone(tz).weekday();
        if repeat == Recurrence::Weekdays && matches!(weekday, Weekday::Sat | Weekday::Sun) {
            continue;
        }
        let candidate = at_local_time(tz, day, local_time);
        if candidate > after {
            return candidate;
        }
    }
    // Unreachable for valid input; keeps the function total.
    at_local_time(
        tz,
        start_of_local_day(tz, after, MAX_SCAN_DAYS + 1),
        local_time,
    )
}

/// `presetDueAt`.
pub fn preset_due_at<Tz: TimeZone>(
    tz: &Tz,
    preset: ReminderPreset,
    now: DateTime<Utc>,
) -> DateTime<Utc> {
    match preset {
        ReminderPreset::FifteenMinutes => now + Duration::milliseconds(15 * MINUTE_MS),
        ReminderPreset::OneHour => now + Duration::milliseconds(60 * MINUTE_MS),
        ReminderPreset::TomorrowAtNine => {
            at_local_time(tz, start_of_local_day(tz, now, 1), "09:00")
        }
    }
}

/// Local `HH:mm` of `at` (`localHHmm` in reminders-service.ts).
pub fn local_hhmm<Tz: TimeZone>(tz: &Tz, at: DateTime<Utc>) -> String {
    let local = at.with_timezone(tz);
    format!("{:02}:{:02}", local.hour(), local.minute())
}

#[cfg(test)]
pub(crate) mod tests {
    use chrono::{FixedOffset, Local};
    use chrono_tz::Europe::Madrid;

    use super::*;

    /// `new Date(y, mo - 1, d, h, mi, s)` in Madrid, for wall times that exist exactly once.
    pub(crate) fn local(y: i32, mo: u32, d: u32, h: u32, mi: u32, s: u32) -> DateTime<Utc> {
        Madrid
            .with_ymd_and_hms(y, mo, d, h, mi, s)
            .single()
            .expect("unique local time")
            .with_timezone(&Utc)
    }

    pub(crate) fn day(y: i32, mo: u32, d: u32) -> DateTime<Utc> {
        local(y, mo, d, 0, 0, 0)
    }

    /// `getTimezoneOffset()` is minutes west of UTC; this is seconds east.
    fn offset_secs(at: DateTime<Utc>) -> i32 {
        Madrid
            .offset_from_utc_datetime(&at.naive_utc())
            .fix()
            .local_minus_utc()
    }

    fn wall(at: DateTime<Utc>) -> (u32, u32) {
        let local = at.with_timezone(&Madrid);
        (local.hour(), local.minute())
    }

    fn utc(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, mo, d, h, mi, 0).unwrap()
    }

    // timezone setup

    #[test]
    fn runs_in_europe_madrid() {
        assert_eq!(offset_secs(local(2026, 1, 15, 12, 0, 0)), 3600);
        assert_eq!(offset_secs(local(2026, 7, 15, 12, 0, 0)), 7200);
    }

    // atLocalTime

    #[test]
    fn at_local_time_uses_the_local_calendar_date_of_the_given_day() {
        assert_eq!(
            at_local_time(&Madrid, local(2026, 11, 10, 23, 59, 0), "09:05"),
            local(2026, 11, 10, 9, 5, 0)
        );
    }

    #[test]
    fn at_local_time_moves_a_nonexistent_spring_forward_time_to_the_first_valid_instant_after_the_gap(
    ) {
        assert_eq!(
            at_local_time(&Madrid, local(2026, 3, 29, 12, 0, 0), "02:30"),
            local(2026, 3, 29, 3, 0, 0)
        );
    }

    #[test]
    fn at_local_time_uses_the_first_occurrence_on_fall_back() {
        let d = at_local_time(&Madrid, local(2026, 10, 25, 12, 0, 0), "02:30");
        assert_eq!(offset_secs(d), 7200);
        assert_eq!(wall(d), (2, 30));
    }

    // nextOccurrence

    #[test]
    fn daily_later_today_when_still_ahead() {
        assert_eq!(
            next_occurrence(
                &Madrid,
                Recurrence::Daily,
                "09:00",
                local(2026, 11, 10, 8, 0, 0)
            ),
            local(2026, 11, 10, 9, 0, 0)
        );
    }

    #[test]
    fn daily_strictly_after_equal_counts_as_past() {
        assert_eq!(
            next_occurrence(
                &Madrid,
                Recurrence::Daily,
                "09:00",
                local(2026, 11, 10, 9, 0, 0)
            ),
            local(2026, 11, 11, 9, 0, 0)
        );
    }

    #[test]
    fn weekdays_friday_10_00_to_monday_09_30() {
        assert_eq!(
            next_occurrence(
                &Madrid,
                Recurrence::Weekdays,
                "09:30",
                local(2026, 11, 13, 10, 0, 0)
            ),
            local(2026, 11, 16, 9, 30, 0)
        );
    }

    #[test]
    fn weekdays_saturday_to_monday() {
        assert_eq!(
            next_occurrence(
                &Madrid,
                Recurrence::Weekdays,
                "09:30",
                local(2026, 11, 14, 7, 0, 0)
            ),
            local(2026, 11, 16, 9, 30, 0)
        );
    }

    #[test]
    fn daily_02_30_on_the_spring_forward_day_fires_at_03_00() {
        assert_eq!(
            next_occurrence(
                &Madrid,
                Recurrence::Daily,
                "02:30",
                local(2026, 3, 29, 0, 10, 0)
            ),
            local(2026, 3, 29, 3, 0, 0)
        );
    }

    #[test]
    fn daily_02_30_on_the_fall_back_day_fires_once() {
        let first = next_occurrence(
            &Madrid,
            Recurrence::Daily,
            "02:30",
            local(2026, 10, 25, 0, 10, 0),
        );
        assert_eq!(offset_secs(first), 7200);
        assert_eq!(wall(first).0, 2);
        let second = next_occurrence(&Madrid, Recurrence::Daily, "02:30", first);
        assert_eq!(second, local(2026, 10, 26, 2, 30, 0));
    }

    // nextOccurrence pinning

    #[test]
    fn daily_02_30_returns_to_02_30_the_day_after_the_spring_forward_gap() {
        assert_eq!(
            next_occurrence(
                &Madrid,
                Recurrence::Daily,
                "02:30",
                local(2026, 3, 29, 3, 0, 0)
            ),
            local(2026, 3, 30, 2, 30, 0)
        );
    }

    #[test]
    fn weekdays_starting_on_sunday_to_monday() {
        assert_eq!(
            next_occurrence(
                &Madrid,
                Recurrence::Weekdays,
                "09:30",
                local(2026, 11, 15, 8, 0, 0)
            ),
            local(2026, 11, 16, 9, 30, 0)
        );
    }

    #[test]
    fn weekdays_on_friday_before_the_time_same_friday() {
        assert_eq!(
            next_occurrence(
                &Madrid,
                Recurrence::Weekdays,
                "09:30",
                local(2026, 11, 13, 8, 0, 0)
            ),
            local(2026, 11, 13, 9, 30, 0)
        );
    }

    #[test]
    fn daily_rolls_over_the_year_boundary() {
        assert_eq!(
            next_occurrence(
                &Madrid,
                Recurrence::Daily,
                "09:00",
                local(2026, 12, 31, 10, 0, 0)
            ),
            local(2027, 1, 1, 9, 0, 0)
        );
    }

    // presetDueAt

    #[test]
    fn preset_15m_and_1h_add_minutes_to_now() {
        let now = local(2026, 11, 10, 15, 0, 20);
        assert_eq!(
            preset_due_at(&Madrid, ReminderPreset::FifteenMinutes, now),
            now + Duration::minutes(15)
        );
        assert_eq!(
            preset_due_at(&Madrid, ReminderPreset::OneHour, now),
            now + Duration::minutes(60)
        );
    }

    #[test]
    fn preset_tomorrow_9_is_tomorrow_09_00_local() {
        let now = local(2026, 11, 10, 15, 0, 20);
        assert_eq!(
            preset_due_at(&Madrid, ReminderPreset::TomorrowAtNine, now),
            local(2026, 11, 11, 9, 0, 0)
        );
    }

    // startOfLocalDay

    #[test]
    fn start_of_local_day_returns_local_midnight_shifting_whole_days_across_month_and_year_ends() {
        assert_eq!(
            start_of_local_day(&Madrid, local(2026, 12, 31, 18, 30, 0), 0),
            day(2026, 12, 31)
        );
        assert_eq!(
            start_of_local_day(&Madrid, local(2026, 12, 31, 18, 30, 0), 1),
            day(2027, 1, 1)
        );
        assert_eq!(
            start_of_local_day(&Madrid, local(2026, 1, 31, 18, 30, 0), 1),
            day(2026, 2, 1)
        );
    }

    // Brief extras: the DST rules pinned to UTC instants, independent of any helper.

    #[test]
    fn daily_reminder_in_spring_gap_lands_after_gap() {
        // 2026-03-29 02:00 CET jumps to 03:00 CEST: 02:30 does not exist; 03:00 CEST = 01:00Z.
        let at = next_occurrence(&Madrid, Recurrence::Daily, "02:30", utc(2026, 3, 28, 23, 0));
        assert_eq!(at, utc(2026, 3, 29, 1, 0));
        assert_eq!(wall(at), (3, 0));
    }

    #[test]
    fn fall_back_takes_first_occurrence() {
        // 2026-10-25 03:00 CEST falls back to 02:00 CET: 02:30 happens at 00:30Z and 01:30Z.
        let at = at_local_time(&Madrid, utc(2026, 10, 25, 10, 0), "02:30");
        assert_eq!(at, utc(2026, 10, 25, 0, 30));
        assert_eq!(offset_secs(at), 7200);
    }

    #[test]
    fn a_gap_read_like_js_lands_gap_later_without_the_walk_back() {
        // `new Date(2026, 2, 29, 2, 30)` in Madrid is 03:30 CEST (pre-gap offset +01:00).
        let naive = NaiveDate::from_ymd_opt(2026, 3, 29)
            .unwrap()
            .and_hms_opt(2, 30, 0)
            .unwrap();
        assert_eq!(resolve_local(&Madrid, naive), utc(2026, 3, 29, 1, 30));
    }

    #[test]
    fn local_hhmm_is_zero_padded_local_wall_time() {
        assert_eq!(local_hhmm(&Madrid, utc(2026, 11, 10, 8, 5)), "09:05");
        assert_eq!(local_hhmm(&Madrid, utc(2026, 7, 10, 22, 30)), "00:30");
    }

    #[test]
    fn works_with_fixed_offsets_and_the_machine_zone() {
        let plus_one = FixedOffset::east_opt(3600).unwrap();
        assert_eq!(
            next_occurrence(
                &plus_one,
                Recurrence::Daily,
                "09:00",
                utc(2026, 11, 10, 9, 0)
            ),
            utc(2026, 11, 11, 8, 0)
        );
        // Production zone: whatever it is, the next 09:00 is ahead, within two days, at 09:00.
        let now = Utc::now();
        let next = next_occurrence(&Local, Recurrence::Daily, "09:00", now);
        assert!(next > now && next - now <= Duration::days(2));
        assert_eq!(local_hhmm(&Local, next), "09:00");
    }
}
