//! Port of `tests/unit/shared/code-review-contributions.test.ts` (35 cases as vitest counts them,
//! `it.each` rows included). The TS suite runs with `TZ=Europe/Madrid`; here the zone is passed
//! explicitly (`chrono_tz`), so other zones are tested the same way. Plus the DST and
//! previous-month week cases of the Rust port.

use chrono::{Datelike, Duration, Offset, Timelike};
use chrono_tz::Tz;
use serde_json::json;

use super::*;
use crate::contract::code_review::{ContributionsInput, WEEKS_MAX, WEEKS_MIN};
use crate::contract::{parse, Validate};

const MADRID: Tz = chrono_tz::Europe::Madrid;
const SAO_PAULO: Tz = chrono_tz::America::Sao_Paulo;

/// `new Date(y, m - 1, d, h, min, s)` in `tz` (an existing, unambiguous wall time).
fn at(tz: Tz, y: i32, m: u32, d: u32, h: u32, min: u32, s: u32) -> DateTime<Tz> {
    tz.with_ymd_and_hms(y, m, d, h, min, s).unwrap()
}

/// `new Date(y, m - 1, d, h, min)` in Madrid, the TS suite's zone.
fn mad(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Tz> {
    at(MADRID, y, m, d, h, min, 0)
}

fn utc(text: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(text)
        .unwrap()
        .with_timezone(&Utc)
}

fn offset_seconds(at: &DateTime<Tz>) -> i32 {
    at.offset().fix().local_minus_utc()
}

fn hms(at: &DateTime<Tz>) -> (u32, u32, u32) {
    (at.hour(), at.minute(), at.second())
}

fn no_counts() -> HashMap<String, u64> {
    HashMap::new()
}

fn counts(entries: &[(&str, u64)]) -> HashMap<String, u64> {
    entries
        .iter()
        .map(|(date, n)| ((*date).to_owned(), *n))
        .collect()
}

fn in_month(weeks: &[Vec<ContributionDay>]) -> Vec<&ContributionDay> {
    weeks.iter().flatten().filter(|day| day.in_month).collect()
}

fn find<'a>(weeks: &'a [Vec<ContributionDay>], date: &str) -> &'a ContributionDay {
    weeks
        .iter()
        .flatten()
        .find(|day| day.date == date)
        .unwrap_or_else(|| panic!("{date} in the grid"))
}

/// `contributionSummarySchema.shape.weeks`: 4-6 columns of 7 valid days.
fn weeks_are_valid(weeks: &[Vec<ContributionDay>]) -> bool {
    (WEEKS_MIN..=WEEKS_MAX).contains(&weeks.len())
        && weeks
            .iter()
            .all(|week| week.len() == 7 && week.iter().all(|day| day.validate().is_ok()))
}

// runs with the Europe/Madrid time zone (DST cases depend on it)
#[test]
fn runs_with_the_europe_madrid_time_zone() {
    assert_eq!(offset_seconds(&mad(2026, 1, 15, 0, 0)), 3600);
    assert_eq!(offset_seconds(&mad(2026, 7, 15, 0, 0)), 7200);
}

// --- localDate / dayStart / weekStart --------------------------------------------------------

#[test]
fn formats_with_local_getters_zero_padded() {
    assert_eq!(local_date(&mad(2026, 1, 5, 0, 0)), "2026-01-05");
    assert_eq!(local_date(&mad(2026, 12, 31, 23, 59)), "2026-12-31");
}

#[test]
fn puts_a_gitlab_event_at_23_30_utc_on_the_local_day_madrid_is_ahead_of_utc() {
    let local = |text: &str| local_date(&utc(text).with_timezone(&MADRID));
    assert_eq!(local("2026-11-12T23:30:00Z"), "2026-11-13"); // CET, +1
    assert_eq!(local("2026-07-12T23:30:00Z"), "2026-07-13"); // CEST, +2
    assert_eq!(local("2026-11-12T22:30:00Z"), "2026-11-12"); // 23:30 local
    assert_eq!(local("2026-11-30T23:30:00Z"), "2026-12-01"); // crosses the month
}

#[test]
fn local_iso_with_offset_keeps_the_local_wall_time_with_its_utc_offset() {
    assert_eq!(
        local_iso_with_offset(&mad(2026, 11, 13, 0, 0)),
        "2026-11-13T00:00:00+01:00"
    );
    assert_eq!(
        local_iso_with_offset(&at(MADRID, 2026, 7, 5, 9, 7, 3)),
        "2026-07-05T09:07:03+02:00"
    );
    let st_johns = at(chrono_tz::America::St_Johns, 2026, 1, 2, 0, 0, 0);
    assert_eq!(
        local_iso_with_offset(&st_johns),
        "2026-01-02T00:00:00-03:30"
    );
}

#[test]
fn day_start_is_local_midnight() {
    let d = day_start(&at(MADRID, 2026, 11, 13, 17, 45, 12));
    assert_eq!((d.year(), d.month(), d.day()), (2026, 11, 13));
    assert_eq!(hms(&d), (0, 0, 0));
}

#[test]
fn week_start_is_monday_00_00_local_also_on_monday_and_sunday() {
    assert_eq!(
        local_date(&week_start(&mad(2026, 11, 13, 10, 0))),
        "2026-11-09"
    ); // Friday
    assert_eq!(
        local_date(&week_start(&mad(2026, 11, 9, 0, 0))),
        "2026-11-09"
    ); // Monday 00:00
    assert_eq!(
        local_date(&week_start(&mad(2026, 11, 15, 23, 59))),
        "2026-11-09"
    ); // Sunday
    assert_eq!(week_start(&mad(2026, 11, 15, 23, 59)).hour(), 0);
}

#[test]
fn a_week_that_crosses_the_month_starts_in_the_previous_month() {
    assert_eq!(
        local_date(&week_start(&mad(2026, 12, 2, 9, 0))),
        "2026-11-30"
    );
}

#[test]
fn week_start_across_the_dst_change_keeps_local_midnight() {
    // 25 Oct 2026, CEST -> CET.
    let w = week_start(&mad(2026, 10, 25, 23, 30)); // Sunday after the change
    assert_eq!(local_date(&w), "2026-10-19");
    assert_eq!(w.hour(), 0);
    let next = week_start(&mad(2026, 10, 26, 0, 30));
    assert_eq!(local_date(&next), "2026-10-26");
    assert_eq!(next.hour(), 0);
}

// --- monthRange ------------------------------------------------------------------------------

fn month_range_case(now: DateTime<Tz>, month: &str, days: u32) {
    let r = month_range(&now);
    assert_eq!(r.month, month);
    assert_eq!(local_date(&r.from), format!("{month}-01"));
    assert_eq!(r.from.hour(), 0);
    // `to` is the 1st of the next month at 00:00 local (exclusive).
    assert_eq!(r.to.day(), 1);
    assert_eq!(r.to.hour(), 0);
    let last = r.to.date_naive().pred_opt().unwrap();
    assert_eq!(last.day(), days);
}

#[test]
fn month_range_2026_02_has_28_days() {
    month_range_case(mad(2026, 2, 10, 0, 0), "2026-02", 28);
}

#[test]
fn month_range_2028_02_has_29_days() {
    month_range_case(mad(2028, 2, 29, 0, 0), "2028-02", 29);
}

#[test]
fn month_range_2026_11_has_30_days() {
    month_range_case(mad(2026, 11, 13, 0, 0), "2026-11", 30);
}

#[test]
fn month_range_2026_12_has_31_days() {
    month_range_case(mad(2026, 12, 31, 23, 59), "2026-12", 31);
}

#[test]
fn a_month_with_a_dst_change_is_not_24h_times_days_long_but_both_ends_are_local_midnights() {
    let oct = month_range(&mad(2026, 10, 15, 0, 0));
    assert_eq!(oct.to - oct.from, Duration::hours(31 * 24 + 1));
    let mar = month_range(&mad(2026, 3, 30, 0, 0));
    assert_eq!(mar.to - mar.from, Duration::hours(31 * 24 - 1));
    assert_eq!(local_date(&mar.to), "2026-04-01");
}

// --- buildGrid -------------------------------------------------------------------------------

#[test]
fn monday_first_columns_of_7_days_days_outside_the_month_are_not_in_the_month() {
    let weeks = build_grid("2026-11", &no_counts(), "2026-11-13"); // 1 Nov 2026 is a Sunday
    assert_eq!(weeks.len(), 6);
    assert!(weeks.iter().all(|week| week.len() == 7));
    assert_eq!(weeks[0][0].date, "2026-10-26");
    assert!(weeks[0][..6].iter().all(|day| !day.in_month));
    assert_eq!(
        (weeks[0][6].date.as_str(), weeks[0][6].in_month),
        ("2026-11-01", true)
    );
    assert_eq!(
        (weeks[5][0].date.as_str(), weeks[5][0].in_month),
        ("2026-11-30", true)
    );
    assert_eq!(
        (weeks[5][6].date.as_str(), weeks[5][6].in_month),
        ("2026-12-06", false)
    );
    assert_eq!(in_month(&weeks).len(), 30);
}

#[test]
fn a_month_that_starts_on_monday_starts_the_first_column_on_the_1st_5_columns() {
    let weeks = build_grid("2026-06", &no_counts(), "2026-06-10"); // 1 Jun 2026 is a Monday
    assert_eq!(weeks.len(), 5);
    assert_eq!(
        (weeks[0][0].date.as_str(), weeks[0][0].in_month),
        ("2026-06-01", true)
    );
    assert_eq!(in_month(&weeks).len(), 30);
}

#[test]
fn a_28_day_february_that_starts_on_monday_fills_exactly_4_columns() {
    let weeks = build_grid("2027-02", &no_counts(), "2027-02-10");
    assert_eq!(weeks.len(), 4);
    assert!(weeks.iter().flatten().all(|day| day.in_month));
}

fn consecutive_and_unique(month: &str, days: u32) {
    let weeks = build_grid(month, &no_counts(), &format!("{month}-01"));
    let dates: Vec<&str> = in_month(&weeks)
        .iter()
        .map(|day| day.date.as_str())
        .collect();
    let expected: Vec<String> = (1..=days).map(|d| format!("{month}-{d:02}")).collect();
    assert_eq!(dates, expected);
    let all: Vec<&str> = weeks
        .iter()
        .flatten()
        .map(|day| day.date.as_str())
        .collect();
    let unique: std::collections::HashSet<&&str> = all.iter().collect();
    assert_eq!(unique.len(), all.len());
    assert!(weeks_are_valid(&weeks));
}

#[test]
fn grid_2026_02_has_28_in_month_days_consecutive_and_unique() {
    consecutive_and_unique("2026-02", 28);
}

#[test]
fn grid_2028_02_has_29_in_month_days_consecutive_and_unique() {
    consecutive_and_unique("2028-02", 29);
}

#[test]
fn grid_2026_04_has_30_in_month_days_consecutive_and_unique() {
    consecutive_and_unique("2026-04", 30);
}

#[test]
fn grid_2026_03_has_31_in_month_days_consecutive_and_unique_across_dst() {
    consecutive_and_unique("2026-03", 31);
}

#[test]
fn grid_2026_10_has_31_in_month_days_consecutive_and_unique_across_dst() {
    consecutive_and_unique("2026-10", 31);
}

#[test]
fn marks_future_days_and_ignores_counts_outside_the_month() {
    let counts = counts(&[("2026-10-31", 9), ("2026-11-02", 3), ("2026-11-13", 1)]);
    let weeks = build_grid("2026-11", &counts, "2026-11-13");
    let d = find(&weeks, "2026-10-31");
    assert_eq!((d.count, d.level, d.in_month), (0, 0, false));
    let d = find(&weeks, "2026-11-02");
    assert_eq!((d.count, d.level, d.future), (3, 4, false));
    let d = find(&weeks, "2026-11-13");
    assert_eq!((d.count, d.level, d.future), (1, 2, false));
    let d = find(&weeks, "2026-11-14");
    assert_eq!((d.count, d.future), (0, true));
}

// --- levelFor --------------------------------------------------------------------------------

#[test]
fn everything_0_is_level_0() {
    assert_eq!(level_for(0, 0), 0);
    let weeks = build_grid("2026-11", &no_counts(), "2026-11-30");
    assert!(weeks.iter().flatten().all(|day| day.level == 0));
}

#[test]
fn a_single_active_day_is_level_4() {
    assert_eq!(level_for(1, 1), 4);
    let weeks = build_grid("2026-11", &counts(&[("2026-11-05", 2)]), "2026-11-30");
    let active: Vec<(&str, u8)> = weeks
        .iter()
        .flatten()
        .filter(|day| day.level > 0)
        .map(|day| (day.date.as_str(), day.level))
        .collect();
    assert_eq!(active, [("2026-11-05", 4)]);
}

#[test]
fn quartiles_of_the_max_repeated_maximums_are_all_level_4() {
    let levels: Vec<u8> = (1..=8).map(|c| level_for(c, 8)).collect();
    assert_eq!(levels, [1, 1, 2, 2, 3, 3, 4, 4]);
    assert_eq!(level_for(1, 100), 1);
    let weeks = build_grid(
        "2026-11",
        &counts(&[("2026-11-03", 6), ("2026-11-04", 6), ("2026-11-05", 1)]),
        "2026-11-30",
    );
    let top: Vec<&str> = weeks
        .iter()
        .flatten()
        .filter(|day| day.level == 4)
        .map(|day| day.date.as_str())
        .collect();
    assert_eq!(top, ["2026-11-03", "2026-11-04"]);
}

// --- classifyGitlabEvent ---------------------------------------------------------------------

const BASE: GitlabEventClass = GitlabEventClass {
    contribution: true,
    commits: 0,
    opened: false,
    merged: false,
    review: false,
};

fn ev<'a>(
    action_name: &'a str,
    target_type: Option<&'a str>,
    commit_count: Option<u64>,
    noteable_type: Option<&'a str>,
) -> GitlabEventLike<'a> {
    GitlabEventLike {
        action_name,
        target_type,
        commit_count,
        noteable_type,
    }
}

fn classify(action_name: &str, target_type: Option<&str>) -> GitlabEventClass {
    classify_gitlab_event(&ev(action_name, target_type, None, None))
}

#[test]
fn pushes_count_their_commit_count() {
    assert_eq!(
        classify_gitlab_event(&ev("pushed to", None, Some(3), None)),
        GitlabEventClass { commits: 3, ..BASE }
    );
    assert_eq!(
        classify_gitlab_event(&ev("pushed new", None, Some(1), None)),
        GitlabEventClass { commits: 1, ..BASE }
    );
    assert_eq!(classify("pushed to", None), BASE);
}

#[test]
fn opened_mr_merged_mr_accepted_or_merged() {
    let mr = Some("MergeRequest");
    assert_eq!(
        classify("opened", mr),
        GitlabEventClass {
            opened: true,
            ..BASE
        }
    );
    assert_eq!(
        classify("accepted", mr),
        GitlabEventClass {
            merged: true,
            ..BASE
        }
    );
    assert_eq!(
        classify("merged", mr),
        GitlabEventClass {
            merged: true,
            ..BASE
        }
    );
}

#[test]
fn reviews_approvals_and_comments_on_mrs() {
    let review = GitlabEventClass {
        review: true,
        ..BASE
    };
    assert_eq!(classify("approved", Some("MergeRequest")), review);
    assert_eq!(
        classify_gitlab_event(&ev(
            "commented on",
            Some("Note"),
            None,
            Some("MergeRequest")
        )),
        review
    );
    assert_eq!(
        classify_gitlab_event(&ev(
            "commented on",
            Some("DiffNote"),
            None,
            Some("MergeRequest")
        )),
        review
    );
    assert_eq!(classify("commented on", Some("DiffNote")), review);
}

#[test]
fn a_comment_on_an_issue_or_an_opened_issue_is_a_contribution_but_no_review_nor_mr() {
    assert_eq!(
        classify_gitlab_event(&ev("commented on", Some("Note"), None, Some("Issue"))),
        BASE
    );
    assert_eq!(classify("opened", Some("Issue")), BASE);
    assert_eq!(classify("closed", Some("MergeRequest")), BASE);
}

#[test]
fn joining_or_leaving_a_project_is_not_a_contribution() {
    for action in ["joined", "left", "expired"] {
        assert!(!classify(action, None).contribution, "{action}");
    }
}

#[test]
fn the_chart_counts_only_an_allowlist_like_gitlabs_calendar() {
    for target in ["MergeRequest", "Issue", "WorkItem"] {
        for action in [
            "created", "opened", "closed", "merged", "accepted", "approved",
        ] {
            assert!(
                classify(action, Some(target)).contribution,
                "{action} {target}"
            );
        }
    }
    let counts = |event: GitlabEventLike<'_>| classify_gitlab_event(&event).contribution;
    assert!(counts(ev("pushed to", None, None, None)));
    assert!(counts(ev("pushed new", None, Some(0), None)));
    assert!(counts(ev(
        "commented on",
        Some("Note"),
        None,
        Some("Commit")
    )));
    assert!(!counts(ev("updated", Some("WikiPage::Meta"), None, None)));
    assert!(!counts(ev("created", Some("WikiPage::Meta"), None, None)));
    assert!(!counts(ev("created", None, None, None)));
    assert!(!counts(ev("closed", Some("Milestone"), None, None)));
    assert!(!counts(ev("deleted", None, None, None)));
    assert!(!counts(ev("deleted", Some("MergeRequest"), None, None)));
    assert!(!counts(ev("reopened", Some("Issue"), None, None)));
}

// --- sumTotals / summarize -------------------------------------------------------------------

fn totals(commits: u64, opened: u64, merged: u64, reviews: u64) -> ContributionTotals {
    ContributionTotals {
        commits,
        opened,
        merged,
        reviews,
    }
}

#[test]
fn sum_totals_adds_field_by_field() {
    assert_eq!(sum_totals(&[]), ContributionTotals::default());
    assert_eq!(
        sum_totals(&[totals(1, 2, 3, 4), totals(10, 0, 1, 0)]),
        totals(11, 2, 4, 4)
    );
}

#[test]
fn summarize_builds_a_valid_summary_with_month_total_and_active_days_from_the_grid() {
    let now = mad(2026, 11, 13, 10, 0);
    let t = totals(5, 1, 1, 2);
    let counts = counts(&[("2026-10-30", 7), ("2026-11-01", 2), ("2026-11-13", 3)]);
    let s = summarize(&SummaryInput {
        now: &now,
        counts: &counts,
        today: t,
        week: t,
        month_totals: t,
        partial: false,
        restricted: true,
    });
    assert_eq!(s.month, "2026-11");
    assert_eq!(s.month_total, 5);
    assert_eq!(s.active_days, 2);
    assert!(s.restricted);
    assert_eq!(s.updated_at, "2026-11-13T09:00:00.000Z"); // now.toISOString()
    let wire = serde_json::to_value(&s).unwrap();
    assert_eq!(parse::<ContributionSummary>(wire).unwrap(), s);
}

// --- schemas ---------------------------------------------------------------------------------

#[test]
fn schemas_are_strict() {
    let day =
        json!({ "date": "2026-11-13", "count": 2, "level": 3, "inMonth": true, "future": false });
    let with = |key: &str, value: serde_json::Value| {
        let mut out = day.clone();
        out[key] = value;
        out
    };
    assert!(parse::<ContributionDay>(day.clone()).is_ok());
    assert!(parse::<ContributionDay>(with("extra", json!(1))).is_err());
    assert!(parse::<ContributionDay>(with("level", json!(5))).is_err());
    assert!(parse::<ContributionDay>(with("count", json!(-1))).is_err());
    assert!(parse::<ContributionDay>(with("date", json!("2026-11-13T00:00"))).is_err());
    let zero = json!({ "commits": 0, "opened": 0, "merged": 0, "reviews": 0 });
    assert!(parse::<ContributionTotals>(zero.clone()).is_ok());
    let mut issues = zero.clone();
    issues["issues"] = json!(1);
    assert!(parse::<ContributionTotals>(issues).is_err());
    let mut fraction = zero;
    fraction["commits"] = json!(1.5);
    assert!(parse::<ContributionTotals>(fraction).is_err());
    assert!(parse::<ContributionsInput>(json!({ "platform": "gitlab" })).is_ok());
    assert!(parse::<ContributionsInput>(json!({ "platform": "gitlab", "x": 1 })).is_err());
    assert!(parse::<ContributionsInput>(json!({ "platform": "bitbucket" })).is_err());
}

#[test]
fn summary_weeks_of_7_days_4_to_6_columns_yyyy_mm_month() {
    let day =
        json!({ "date": "2026-11-13", "count": 2, "level": 3, "inMonth": true, "future": false });
    let week: Vec<serde_json::Value> = (0..7).map(|_| day.clone()).collect();
    let totals = json!({ "commits": 0, "opened": 0, "merged": 0, "reviews": 0 });
    let summary = json!({
        "month": "2026-11",
        "weeks": [week, week, week, week, week],
        "monthTotal": 0,
        "activeDays": 0,
        "today": totals,
        "week": totals,
        "monthTotals": totals,
        "partial": false,
        "restricted": false,
        "updatedAt": "2026-11-13T09:00:00.000Z",
    });
    let with = |key: &str, value: serde_json::Value| {
        let mut out = summary.clone();
        out[key] = value;
        out
    };
    assert!(parse::<ContributionSummary>(summary.clone()).is_ok());
    assert!(parse::<ContributionSummary>(with("weeks", json!([week, week, week]))).is_err());
    let seven: Vec<_> = (0..7).map(|_| week.clone()).collect();
    assert!(parse::<ContributionSummary>(with("weeks", json!(seven))).is_err());
    assert!(parse::<ContributionSummary>(with(
        "weeks",
        json!([week[1..].to_vec(), week, week, week, week])
    ))
    .is_err());
    assert!(parse::<ContributionSummary>(with("month", json!("2026-13"))).is_err());
    assert!(parse::<ContributionSummary>(with("extra", json!(true))).is_err());
}

// --- Rust port: DST, nonexistent midnights and weeks from the previous month ------------------

/// Every day of a month with a DST change appears once and in order, whichever zone builds it,
/// and the range's starts are local midnights.
///
/// - Europe/Madrid, October 2026: CEST -> CET on Sunday 25 Oct (03:00 -> 02:00).
/// - America/Sao_Paulo, November 2018: DST started on Sunday 4 Nov at 00:00, so that midnight
///   does not exist. JS `new Date(2018, 10, 4)` (Node 22, `TZ=America/Sao_Paulo`) gives
///   `2018-11-04T03:00:00.000Z` = 01:00 local at -02:00: the wall time read with the offset in
///   force before the gap (-03:00), i.e. the first instant after it. `day_start` mirrors that.
#[test]
fn month_with_dst_change_keeps_every_day_once() {
    // Madrid, October 2026.
    let now = mad(2026, 10, 26, 9, 0); // the Monday after the change
    let range = ContributionRange::at(&now);
    assert_eq!(range.month().to_rfc3339(), "2026-10-01T00:00:00+02:00");
    assert_eq!(range.week().to_rfc3339(), "2026-10-26T00:00:00+01:00");
    assert_eq!(range.today().to_rfc3339(), "2026-10-26T00:00:00+01:00");
    let sunday = mad(2026, 10, 25, 12, 0);
    assert_eq!(day_start(&sunday).to_rfc3339(), "2026-10-25T00:00:00+02:00");
    assert_eq!(
        week_start(&sunday).to_rfc3339(),
        "2026-10-19T00:00:00+02:00"
    );
    let summary = summarize(&SummaryInput {
        now: &now,
        counts: &counts(&[("2026-10-25", 1), ("2026-10-26", 2)]),
        today: ContributionTotals::default(),
        week: ContributionTotals::default(),
        month_totals: ContributionTotals::default(),
        partial: false,
        restricted: false,
    });
    let dates: Vec<String> = in_month(&summary.weeks)
        .iter()
        .map(|day| day.date.clone())
        .collect();
    let expected: Vec<String> = (1..=31).map(|d| format!("2026-10-{d:02}")).collect();
    assert_eq!(dates, expected);
    assert_eq!((summary.month_total, summary.active_days), (3, 2));
    assert!(!find(&summary.weeks, "2026-10-26").future);
    assert!(find(&summary.weeks, "2026-10-27").future);
    summary.validate().unwrap();

    // Sao Paulo, November 2018: the 4th has no midnight.
    let gap_day = at(SAO_PAULO, 2018, 11, 4, 10, 0, 0);
    let start = day_start(&gap_day);
    assert_eq!(
        start
            .with_timezone(&Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "2018-11-04T03:00:00.000Z"
    );
    assert_eq!(local_iso_with_offset(&start), "2018-11-04T01:00:00-02:00");
    assert_eq!(local_date(&start), "2018-11-04");
    let midnight = local_midnight(&SAO_PAULO, NaiveDate::from_ymd_opt(2018, 11, 4).unwrap());
    assert_eq!(midnight, start);
    // The days around it are ordinary midnights (-03:00 before, -02:00 after).
    let before = local_midnight(&SAO_PAULO, NaiveDate::from_ymd_opt(2018, 11, 3).unwrap());
    assert_eq!(local_iso_with_offset(&before), "2018-11-03T00:00:00-03:00");
    let after = local_midnight(&SAO_PAULO, NaiveDate::from_ymd_opt(2018, 11, 5).unwrap());
    assert_eq!(local_iso_with_offset(&after), "2018-11-05T00:00:00-02:00");
    // The day of the gap is 23 h long, but still one day.
    assert_eq!(after - start, Duration::hours(23));

    let range = ContributionRange::at(&gap_day);
    assert_eq!(range.today().to_rfc3339(), "2018-11-04T01:00:00-02:00");
    assert_eq!(range.week().to_rfc3339(), "2018-10-29T00:00:00-03:00");
    assert_eq!(range.month().to_rfc3339(), "2018-11-01T00:00:00-03:00");
    let month = month_range(&gap_day);
    assert_eq!(month.month, "2018-11");
    assert_eq!(
        local_iso_with_offset(&month.to),
        "2018-12-01T00:00:00-02:00"
    );
    // 30 days, one of 23 h.
    assert_eq!(month.to - month.from, Duration::hours(30 * 24 - 1));
    let summary = summarize(&SummaryInput {
        now: &gap_day,
        counts: &counts(&[("2018-11-03", 1), ("2018-11-04", 4)]),
        today: ContributionTotals::default(),
        week: ContributionTotals::default(),
        month_totals: ContributionTotals::default(),
        partial: false,
        restricted: false,
    });
    let dates: Vec<String> = in_month(&summary.weeks)
        .iter()
        .map(|day| day.date.clone())
        .collect();
    let expected: Vec<String> = (1..=30).map(|d| format!("2018-11-{d:02}")).collect();
    assert_eq!(dates, expected);
    let today = find(&summary.weeks, "2018-11-04");
    assert_eq!((today.count, today.level, today.future), (4, 4, false));
    assert!(find(&summary.weeks, "2018-11-05").future);
    assert_eq!(summary.updated_at, "2018-11-04T12:00:00.000Z");
    summary.validate().unwrap();

    // A wall time inside the gap (00:30) also lands one hour later, as JS does.
    let in_gap = NaiveDate::from_ymd_opt(2018, 11, 4)
        .unwrap()
        .and_hms_opt(0, 30, 0)
        .unwrap();
    assert!(SAO_PAULO.from_local_datetime(&in_gap).earliest().is_none());
    assert_eq!(
        crate::reminders::time::resolve_local(&SAO_PAULO, in_gap).to_rfc3339(),
        "2018-11-04T03:30:00+00:00"
    );
}

/// The week may start in the previous month (and year): the range reaches back to that
/// Monday, while the month (and its grid's in-month days) stay in the current month.
#[test]
fn week_starting_in_previous_month() {
    // Wednesday 2 Dec 2026 09:00 in Madrid.
    let now = mad(2026, 12, 2, 9, 0);
    let range = ContributionRange::at(&now);
    assert_eq!(range.week().to_rfc3339(), "2026-11-30T00:00:00+01:00");
    assert_eq!(range.month().to_rfc3339(), "2026-12-01T00:00:00+01:00");
    assert_eq!(range.today().to_rfc3339(), "2026-12-02T00:00:00+01:00");
    assert!(range.week() < range.month());
    assert_eq!(range.now(), now.with_timezone(&Utc));
    assert_eq!(*range.zone(), MADRID);
    let weeks = build_grid("2026-12", &counts(&[("2026-11-30", 5)]), "2026-12-02");
    assert_eq!(weeks[0][0].date, "2026-11-30");
    assert!(!weeks[0][0].in_month);
    assert_eq!(weeks[0][0].count, 0); // out of the month: not in the chart
    assert_eq!(weeks[0][1].date, "2026-12-01");

    // Across the year: Friday 1 Jan 2027 -> Monday 28 Dec 2026.
    let new_year = mad(2027, 1, 1, 12, 0);
    let range = ContributionRange::at(&new_year);
    assert_eq!(range.week().to_rfc3339(), "2026-12-28T00:00:00+01:00");
    assert_eq!(range.month().to_rfc3339(), "2027-01-01T00:00:00+01:00");

    // A week that starts in summer time and ends in winter time (Madrid, 25 Oct 2026).
    let range = ContributionRange::at(&mad(2026, 10, 31, 23, 0));
    assert_eq!(range.week().to_rfc3339(), "2026-10-26T00:00:00+01:00");
    let range = ContributionRange::at(&mad(2026, 11, 1, 8, 0)); // Sunday 1 Nov
    assert_eq!(range.week().to_rfc3339(), "2026-10-26T00:00:00+01:00");
    assert_eq!(range.month().to_rfc3339(), "2026-11-01T00:00:00+01:00");
    let range = ContributionRange::at(&mad(2026, 10, 25, 8, 0)); // Sunday of the change
    assert_eq!(range.week().to_rfc3339(), "2026-10-19T00:00:00+02:00");
    assert_eq!(range.today().to_rfc3339(), "2026-10-25T00:00:00+02:00");
}

/// `ContributionRange::at` keeps the zone of `now`: the carried derivation of the GitHub
/// variables (NOW = Fri 13 Nov 2026 10:30 Madrid) and the UTC instants of each start.
#[test]
fn range_derivation_from_now() {
    let iso = |at: DateTime<FixedOffset>| {
        at.with_timezone(&Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    };
    let range = ContributionRange::at(&mad(2026, 11, 13, 10, 30));
    assert_eq!(iso(range.month()), "2026-10-31T23:00:00.000Z");
    assert_eq!(iso(range.week()), "2026-11-08T23:00:00.000Z");
    assert_eq!(iso(range.today()), "2026-11-12T23:00:00.000Z");
    assert_eq!(
        range
            .now()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "2026-11-13T09:30:00.000Z"
    );
    assert_eq!(
        local_iso_with_offset(&range.today()),
        "2026-11-13T00:00:00+01:00"
    );
    let july = ContributionRange::at(&mad(2026, 7, 15, 12, 0));
    assert_eq!(
        local_iso_with_offset(&july.today()),
        "2026-07-15T00:00:00+02:00"
    );
    // The same instant in another zone gives other starts.
    let utc_now = mad(2026, 11, 13, 10, 30).with_timezone(&Utc);
    let ny = ContributionRange::at(&utc_now.with_timezone(&chrono_tz::America::New_York));
    assert_eq!(iso(ny.month()), "2026-11-01T04:00:00.000Z");
    assert_eq!(iso(ny.today()), "2026-11-13T05:00:00.000Z");
}

#[test]
fn build_grid_with_a_malformed_month_is_empty() {
    assert!(build_grid("2026-13", &no_counts(), "2026-11-13").is_empty());
    assert!(build_grid("nope", &no_counts(), "2026-11-13").is_empty());
    assert_eq!(
        date_key(NaiveDate::from_ymd_opt(2026, 3, 4).unwrap()),
        "2026-03-04"
    );
}
