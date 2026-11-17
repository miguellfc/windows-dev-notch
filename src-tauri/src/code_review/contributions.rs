//! Pure date helpers and the summary of the contributions chart
//! (`src/shared/code-review/contributions.ts`), plus the GitLab event classification.
//!
//! Everything is in a local time zone, generic over [`TimeZone`] so tests can fix one
//! (`chrono_tz`) while the app passes `chrono::Local`. Dates are built as JS local constructors
//! build them (`new Date(y, m, d)`): calendar arithmetic first, then the local midnight of that
//! date, so a DST change never adds or drops a day; day keys come from the local date (never the
//! UTC one).
//!
//! A local midnight that does not exist (a DST gap at 00:00, e.g. America/Sao_Paulo on
//! 4 Nov 2018) resolves as JS `Date` does: the wall time is read with the offset in force just
//! before the gap, so it lands on the first valid instant after it (01:00 local that day). A
//! repeated midnight (a fall-back at 00:00) takes the earlier instant, as JS does.

use std::collections::HashMap;

use chrono::{
    DateTime, Datelike, Days, FixedOffset, Months, NaiveDate, NaiveTime, SecondsFormat, TimeZone,
    Utc,
};

use crate::contract::code_review::{ContributionDay, ContributionSummary, ContributionTotals};
use crate::reminders::time::resolve_local;

/// `YYYY-MM-DD` of a calendar date.
pub fn date_key(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

/// `localDate(d)`: `YYYY-MM-DD` of `at` in its own (local) time zone.
pub fn local_date<Tz: TimeZone>(at: &DateTime<Tz>) -> String {
    date_key(at.date_naive())
}

/// `localIsoWithOffset(d)`: local wall time with its UTC offset, e.g.
/// `2026-11-13T00:00:00+01:00`.
pub fn local_iso_with_offset<Tz: TimeZone>(at: &DateTime<Tz>) -> String {
    at.fixed_offset().format("%Y-%m-%dT%H:%M:%S%:z").to_string()
}

/// `new Date(y, m, d)`: the local midnight of `date` in `zone` (forward past a gap).
pub fn local_midnight<Tz: TimeZone>(zone: &Tz, date: NaiveDate) -> DateTime<Tz> {
    resolve_local(zone, date.and_time(NaiveTime::MIN)).with_timezone(zone)
}

/// `date - days` like `new Date(y, m, d - days)`; saturates at chrono's range.
fn minus_days(date: NaiveDate, days: u64) -> NaiveDate {
    date.checked_sub_days(Days::new(days))
        .unwrap_or(NaiveDate::MIN)
}

fn plus_days(date: NaiveDate, days: u64) -> NaiveDate {
    date.checked_add_days(Days::new(days))
        .unwrap_or(NaiveDate::MAX)
}

/// The 1st of the month after `first`'s.
fn next_month(first: NaiveDate) -> NaiveDate {
    first
        .checked_add_months(Months::new(1))
        .unwrap_or(NaiveDate::MAX)
}

/// The Monday on or before `date` (`d - ((getDay() + 6) % 7)`).
fn monday_of(date: NaiveDate) -> NaiveDate {
    minus_days(date, u64::from(date.weekday().num_days_from_monday()))
}

/// `dayStart(now)`: today at 00:00 local.
pub fn day_start<Tz: TimeZone>(now: &DateTime<Tz>) -> DateTime<Tz> {
    local_midnight(&now.timezone(), now.date_naive())
}

/// `weekStart(now)`: Monday of `now`'s week at 00:00 local (weeks run Monday -> Sunday).
pub fn week_start<Tz: TimeZone>(now: &DateTime<Tz>) -> DateTime<Tz> {
    local_midnight(&now.timezone(), monday_of(now.date_naive()))
}

/// `monthRange(now)`: the 1st at 00:00 local, the 1st of the next month at 00:00 local
/// (exclusive) and the `YYYY-MM` key.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MonthRange<Tz: TimeZone> {
    pub from: DateTime<Tz>,
    pub to: DateTime<Tz>,
    pub month: String,
}

pub fn month_range<Tz: TimeZone>(now: &DateTime<Tz>) -> MonthRange<Tz> {
    let zone = now.timezone();
    let today = now.date_naive();
    let first = today.with_day(1).unwrap_or(today);
    MonthRange {
        from: local_midnight(&zone, first),
        to: local_midnight(&zone, next_month(first)),
        month: first.format("%Y-%m").to_string(),
    }
}

/// `levelFor(count, max)`: 0 without activity; otherwise the quarter of `max` the count reaches
/// (1-4, the max is always 4).
pub fn level_for(count: u64, max: u64) -> u8 {
    if count == 0 || max == 0 {
        return 0;
    }
    // `Math.ceil(count / max * 4)`, in integers: when `4 * count / max` is a whole number the
    // float quotient is exact too, so both round up alike.
    let quarters = (u128::from(count) * 4).div_ceil(u128::from(max));
    u8::try_from(quarters.clamp(1, 4)).unwrap_or(4)
}

/// `YYYY-MM` to the 1st of that month (`None` when malformed).
fn month_start(month: &str) -> Option<NaiveDate> {
    let (year, number) = month.split_once('-')?;
    NaiveDate::from_ymd_opt(year.parse().ok()?, number.parse().ok()?, 1)
}

/// `buildGrid(month, counts, today)`: columns of 7 days (Monday -> Sunday) from the Monday on or
/// before the 1st to the Sunday on or after the last day (4-6 columns). `counts` is keyed by
/// `YYYY-MM-DD`; keys outside the month are ignored. Days after `today` are `future`.
///
/// The grid is calendar arithmetic only (`new Date(y, m, d + i)` read back with local getters),
/// so it needs no time zone. A malformed month key gives no grid (it always comes from
/// [`month_range`]).
pub fn build_grid(
    month: &str,
    counts: &HashMap<String, u64>,
    today: &str,
) -> Vec<Vec<ContributionDay>> {
    let Some(first) = month_start(month) else {
        return Vec::new();
    };
    let start = monday_of(first);
    let last = next_month(first).pred_opt().unwrap_or(first);
    let last_sunday = plus_days(last, u64::from(6 - last.weekday().num_days_from_monday()));

    let mut days = Vec::new();
    let mut day = start;
    loop {
        let in_month = day.month() == first.month() && day.year() == first.year();
        let date = date_key(day);
        let count = if in_month {
            counts.get(&date).copied().unwrap_or(0)
        } else {
            0
        };
        days.push((date, count, in_month));
        if day >= last_sunday {
            break;
        }
        day = plus_days(day, 1);
    }
    let max = days.iter().map(|(_, count, _)| *count).max().unwrap_or(0);
    days.chunks(7)
        .map(|week| {
            week.iter()
                .map(|(date, count, in_month)| ContributionDay {
                    future: date.as_str() > today,
                    level: level_for(*count, max),
                    date: date.clone(),
                    count: *count,
                    in_month: *in_month,
                })
                .collect()
        })
        .collect()
}

/// `GitlabEventLike`: the fields of a GitLab event the classification reads (`null` and absent
/// are both `None`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GitlabEventLike<'a> {
    pub action_name: &'a str,
    pub target_type: Option<&'a str>,
    /// `push_data.commit_count` (validated as `z.int().min(0)` by the client).
    pub commit_count: Option<u64>,
    /// `note.noteable_type`.
    pub noteable_type: Option<&'a str>,
}

/// `GitlabEventClass`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct GitlabEventClass {
    /// Counts as one square of the chart (like GitLab's own calendar).
    pub contribution: bool,
    pub commits: u64,
    pub opened: bool,
    pub merged: bool,
    pub review: bool,
}

// The chart counts like GitLab's own calendar (an allowlist): pushes, comments, and
// MR/issue/work item created, closed, merged and approved. Anything else (wiki edits, project
// created, milestone closed, membership changes, deletions...) is not a contribution.
const PUSH_ACTIONS: [&str; 2] = ["pushed to", "pushed new"];
const TARGET_ACTIONS: [&str; 6] = [
    "created", "opened", "closed", "merged", "accepted", "approved",
];
const CONTRIBUTION_TARGETS: [&str; 3] = ["MergeRequest", "Issue", "WorkItem"];

/// `classifyGitlabEvent`: commits from pushes (`commit_count`), MRs opened and merged
/// (`accepted`/`merged`), and reviews (approvals, comments on MRs). A comment on an issue is a
/// contribution but not a review.
pub fn classify_gitlab_event(event: &GitlabEventLike<'_>) -> GitlabEventClass {
    let action = event.action_name;
    let target = event.target_type;
    let on_mr = target == Some("MergeRequest");
    let push = PUSH_ACTIONS.contains(&action);
    let comment_on_mr = action == "commented on"
        && (event.noteable_type == Some("MergeRequest")
            || (event.noteable_type.is_none() && target == Some("DiffNote")));
    GitlabEventClass {
        contribution: push
            || action == "commented on"
            || (TARGET_ACTIONS.contains(&action)
                && target.is_some_and(|t| CONTRIBUTION_TARGETS.contains(&t))),
        commits: if push {
            event.commit_count.unwrap_or(0)
        } else {
            0
        },
        opened: action == "opened" && on_mr,
        merged: (action == "accepted" || action == "merged") && on_mr,
        review: (action == "approved" && on_mr) || comment_on_mr,
    }
}

/// `sumTotals(...totals)`: field by field (`ZERO_TOTALS` is `ContributionTotals::default()`).
pub fn sum_totals(totals: &[ContributionTotals]) -> ContributionTotals {
    totals
        .iter()
        .fold(ContributionTotals::default(), |acc, t| ContributionTotals {
            commits: acc.commits.saturating_add(t.commits),
            opened: acc.opened.saturating_add(t.opened),
            merged: acc.merged.saturating_add(t.merged),
            reviews: acc.reviews.saturating_add(t.reviews),
        })
}

/// What `summarize` takes.
pub struct SummaryInput<'a, Tz: TimeZone> {
    pub now: &'a DateTime<Tz>,
    pub counts: &'a HashMap<String, u64>,
    pub today: ContributionTotals,
    pub week: ContributionTotals,
    pub month_totals: ContributionTotals,
    pub partial: bool,
    pub restricted: bool,
}

/// `summarize`: the summary for `now`'s month; the grid, month total and active days come from
/// `counts`.
pub fn summarize<Tz: TimeZone>(input: &SummaryInput<'_, Tz>) -> ContributionSummary {
    let month = month_range(input.now).month;
    let weeks = build_grid(&month, input.counts, &local_date(input.now));
    let days = || weeks.iter().flatten().filter(|day| day.in_month);
    let month_total = days().fold(0u64, |sum, day| sum.saturating_add(day.count));
    let active_days = u32::try_from(days().filter(|day| day.count > 0).count()).unwrap_or(u32::MAX);
    ContributionSummary {
        month,
        month_total,
        active_days,
        today: input.today,
        week: input.week,
        month_totals: input.month_totals,
        partial: input.partial,
        restricted: input.restricted,
        // `now.toISOString()`.
        updated_at: input
            .now
            .with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true),
        weeks,
    }
}

/// The local starts of `now`'s month (the 1st), week (Monday) and day, each with the UTC offset
/// in effect at that instant, plus `now` and the time zone they were computed in.
///
/// It must come from the contributions helpers ([`ContributionRange::at`]): the fields are
/// private so the starts and the zone (GitLab places each event on its local date in it) can
/// never disagree.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContributionRange<Tz: TimeZone> {
    now: DateTime<Utc>,
    month: DateTime<FixedOffset>,
    week: DateTime<FixedOffset>,
    today: DateTime<FixedOffset>,
    zone: Tz,
}

impl<Tz: TimeZone> ContributionRange<Tz> {
    /// The range of `now` in `now`'s own time zone (`chrono::Local` in the app).
    pub fn at(now: &DateTime<Tz>) -> Self {
        Self {
            now: now.with_timezone(&Utc),
            month: month_range(now).from.fixed_offset(),
            week: week_start(now).fixed_offset(),
            today: day_start(now).fixed_offset(),
            zone: now.timezone(),
        }
    }

    pub fn now(&self) -> DateTime<Utc> {
        self.now
    }

    /// The 1st of the month at 00:00 local.
    pub fn month(&self) -> DateTime<FixedOffset> {
        self.month
    }

    /// Monday at 00:00 local (may fall in the previous month).
    pub fn week(&self) -> DateTime<FixedOffset> {
        self.week
    }

    /// Today at 00:00 local.
    pub fn today(&self) -> DateTime<FixedOffset> {
        self.today
    }

    pub fn zone(&self) -> &Tz {
        &self.zone
    }
}

#[cfg(test)]
#[path = "contributions_tests.rs"]
mod tests;
