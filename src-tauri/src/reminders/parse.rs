//! Free-text reminders (`src/shared/reminders/parse.ts`): "en 30 min revisar PR",
//! "16:00 standup", "mañana 9:00 x", "diario 9:00 x", "laborables 9:30 x", 12 h and 24 h times.
//!
//! The TS regexes are matched by hand here, keeping their JS semantics (flag `i`, no `u`):
//! `\s` is the JS whitespace set (NBSP, U+3000, U+FEFF...), `\d` is ASCII only, and the
//! case-insensitive comparison never folds a non-ASCII letter onto an ASCII one (no long s for
//! `s`), while `[nñ]` / `[ií]` also take `Ñ` / `Í`. Every alternative is
//! tried in the regex's order, with the backtracking that can change the outcome.

use chrono::{DateTime, Duration, TimeZone, Utc};

use super::time::{at_local_time, next_occurrence, start_of_local_day, Recurrence, MINUTE_MS};
use crate::contract::reminders::{ReminderRepeat, REMINDER_TEXT_MAX};
use crate::contract::text::{has_visible_text, is_js_whitespace, js_trim};

/// What a free text resolves to. `text` still needs [`ReminderText`] validation (control
/// characters are left to the caller, as in the TS).
///
/// [`ReminderText`]: crate::contract::reminders::ReminderText
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedReminder {
    pub text: String,
    pub due_at: DateTime<Utc>,
    pub repeat: ReminderRepeat,
    pub local_time: Option<String>,
}

/// `{ error: 'empty-text' | 'no-time' | 'too-long' }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParseError {
    EmptyText,
    NoTime,
    TooLong,
}

impl ParseError {
    /// The TS error code, which is also the INVALID_INPUT message the service exposes.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EmptyText => "empty-text",
            Self::NoTime => "no-time",
            Self::TooLong => "too-long",
        }
    }
}

const MAX_RELATIVE_MINUTES: u64 = 7 * 24 * 60;

/// Relative units in the regex's order.
const UNITS: [&str; 12] = [
    "minutos", "minuto", "minutes", "minute", "mins", "min", "horas", "hora", "hours", "hour", "h",
    "m",
];

/// One element of a keyword: ASCII letters compared case-insensitively, a character class, or
/// `\s+`.
#[derive(Clone, Copy)]
enum Atom {
    Lit(&'static str),
    Class(&'static [char]),
    Spaces,
}

/// `[nñ]` and `[ií]` under the `i` flag.
const N_TILDE: &[char] = &['n', 'N', 'ñ', 'Ñ'];
const I_ACUTE: &[char] = &['i', 'I', 'í', 'Í'];

/// `(?:diario|daily|cada\s+d[ií]a|every\s+day)`.
const DAILY: &[&[Atom]] = &[
    &[Atom::Lit("diario")],
    &[Atom::Lit("daily")],
    &[
        Atom::Lit("cada"),
        Atom::Spaces,
        Atom::Lit("d"),
        Atom::Class(I_ACUTE),
        Atom::Lit("a"),
    ],
    &[Atom::Lit("every"), Atom::Spaces, Atom::Lit("day")],
];
/// `(?:laborables|weekdays)`.
const WEEKDAYS: &[&[Atom]] = &[&[Atom::Lit("laborables")], &[Atom::Lit("weekdays")]];
/// `(?:ma[nñ]ana|tomorrow)`.
const TOMORROW: &[&[Atom]] = &[
    &[Atom::Lit("ma"), Atom::Class(N_TILDE), Atom::Lit("ana")],
    &[Atom::Lit("tomorrow")],
];
/// `(?:a\s+las|at)` of `AT`.
const AT_WORDS: &[&[Atom]] = &[
    &[Atom::Lit("a"), Atom::Spaces, Atom::Lit("las")],
    &[Atom::Lit("at")],
];

fn next_char(s: &str, pos: usize) -> Option<char> {
    s[pos..].chars().next()
}

/// `\s*`: the end of the whitespace run at `pos`. Giving whitespace back never helps: what
/// follows each run in these patterns never starts with whitespace.
fn spaces(s: &str, pos: usize) -> usize {
    s[pos..]
        .char_indices()
        .find(|&(_, c)| !is_js_whitespace(c))
        .map_or(s.len(), |(i, _)| pos + i)
}

/// `\s+`.
fn spaces1(s: &str, pos: usize) -> Option<usize> {
    let end = spaces(s, pos);
    (end > pos).then_some(end)
}

/// `(?=\s|$)`.
fn at_boundary(s: &str, pos: usize) -> bool {
    next_char(s, pos).is_none_or(is_js_whitespace)
}

/// `word` (ASCII) at `pos`, case-insensitively without folding non-ASCII onto ASCII.
fn literal(s: &str, pos: usize, word: &str) -> Option<usize> {
    let end = pos + word.len();
    s.as_bytes()
        .get(pos..end)
        .is_some_and(|bytes| bytes.eq_ignore_ascii_case(word.as_bytes()))
        .then_some(end)
}

fn atoms(s: &str, mut pos: usize, sequence: &[Atom]) -> Option<usize> {
    for atom in sequence {
        pos = match *atom {
            Atom::Lit(word) => literal(s, pos, word)?,
            Atom::Class(set) => {
                let c = next_char(s, pos).filter(|c| set.contains(c))?;
                pos + c.len_utf8()
            }
            Atom::Spaces => spaces1(s, pos)?,
        };
    }
    Some(pos)
}

/// `\d{1,2}` at `pos`: the candidate ends, greedy first.
fn one_or_two_digits(s: &str, pos: usize) -> Vec<usize> {
    let run = s[pos..]
        .bytes()
        .take(2)
        .take_while(u8::is_ascii_digit)
        .count();
    (1..=run).rev().map(|len| pos + len).collect()
}

/// `\s?`: the candidate ends, greedy first.
fn optional_space(s: &str, pos: usize) -> Vec<usize> {
    match next_char(s, pos) {
        Some(c) if is_js_whitespace(c) => vec![pos + c.len_utf8(), pos],
        _ => vec![pos],
    }
}

/// `(am|pm)` at `pos`: its end and the lowercase meridiem.
fn meridiem(s: &str, pos: usize) -> Option<(usize, &'static str)> {
    ["am", "pm"]
        .into_iter()
        .find_map(|word| literal(s, pos, word).map(|end| (end, word)))
}

/// What `TIME` captured: hour digits, minute digits (H:mm form) and meridiem.
struct TimeMatch<'a> {
    end: usize,
    hour: &'a str,
    minute: Option<&'a str>,
    meridiem: Option<&'static str>,
}

/// `TIME = (?:(\d{1,2}):(\d{2})\s?(am|pm)?|(\d{1,2})\s?(am|pm))(?=\s|$)` at `pos`.
fn time(s: &str, pos: usize) -> Option<TimeMatch<'_>> {
    // H:mm [am|pm]
    for hour_end in one_or_two_digits(s, pos) {
        let Some(colon) = literal(s, hour_end, ":") else {
            continue;
        };
        let Some(minute) = s
            .get(colon..colon + 2)
            .filter(|digits| digits.bytes().all(|b| b.is_ascii_digit()))
        else {
            continue;
        };
        for after_space in optional_space(s, colon + 2) {
            let options = meridiem(s, after_space)
                .map(|(end, word)| (end, Some(word)))
                .into_iter()
                .chain([(after_space, None)]);
            for (end, meridiem) in options {
                if at_boundary(s, end) {
                    return Some(TimeMatch {
                        end,
                        hour: &s[pos..hour_end],
                        minute: Some(minute),
                        meridiem,
                    });
                }
            }
        }
    }
    // H am|pm
    for hour_end in one_or_two_digits(s, pos) {
        for after_space in optional_space(s, hour_end) {
            if let Some((end, word)) = meridiem(s, after_space) {
                if at_boundary(s, end) {
                    return Some(TimeMatch {
                        end,
                        hour: &s[pos..hour_end],
                        minute: None,
                        meridiem: Some(word),
                    });
                }
            }
        }
    }
    None
}

/// `AT TIME` with `AT = (?:(?:a\s+las|at)\s+)?` (greedy: with the words first).
fn at_time(s: &str, pos: usize) -> Option<TimeMatch<'_>> {
    AT_WORDS
        .iter()
        .filter_map(|words| atoms(s, pos, words).and_then(|end| spaces1(s, end)))
        .find_map(|start| time(s, start))
        .or_else(|| time(s, pos))
}

/// `^(?:<words>)\s+ AT TIME`.
fn keyword_time<'a>(s: &'a str, words: &[&[Atom]]) -> Option<TimeMatch<'a>> {
    words
        .iter()
        .filter_map(|sequence| atoms(s, 0, sequence).and_then(|end| spaces1(s, end)))
        .find_map(|start| at_time(s, start))
}

/// `timeFromMatch`: zero-padded `HH:mm`, or `None` when out of range.
fn time_from_match(m: &TimeMatch<'_>) -> Option<String> {
    let hour: u32 = m.hour.parse().ok()?;
    let minute: u32 = match m.minute {
        Some(digits) => digits.parse().ok()?,
        None => 0,
    };
    if minute > 59 {
        return None;
    }
    let h24 = match m.meridiem {
        Some(meridiem) => {
            if !(1..=12).contains(&hour) {
                return None;
            }
            hour % 12 + if meridiem == "pm" { 12 } else { 0 }
        }
        None if hour > 23 => return None,
        None => hour,
    };
    Some(format!("{h24:02}:{minute:02}"))
}

/// `finish`: the trimmed rest is the text; `text.length` counts UTF-16 units.
fn finish(
    rest: &str,
    due_at: DateTime<Utc>,
    repeat: ReminderRepeat,
    local_time: Option<String>,
) -> Result<ParsedReminder, ParseError> {
    let text = js_trim(rest);
    if !has_visible_text(text) {
        return Err(ParseError::EmptyText);
    }
    if text.encode_utf16().count() > REMINDER_TEXT_MAX {
        return Err(ParseError::TooLong);
    }
    Ok(ParsedReminder {
        text: text.to_owned(),
        due_at,
        repeat,
        local_time,
    })
}

/// `^(?:en|in)\s+(\d+)\s*(<unit>)(?=\s|$)`: the match end, the amount digits and the unit.
fn relative(s: &str) -> Option<(usize, &str, &'static str)> {
    let after_word = literal(s, 0, "en").or_else(|| literal(s, 0, "in"))?;
    let digits_start = spaces1(s, after_word)?;
    let digits_len = s[digits_start..]
        .bytes()
        .take_while(u8::is_ascii_digit)
        .count();
    if digits_len == 0 {
        return None;
    }
    let digits_end = digits_start + digits_len;
    let unit_start = spaces(s, digits_end);
    UNITS.into_iter().find_map(|unit| {
        literal(s, unit_start, unit)
            .filter(|&end| at_boundary(s, end))
            .map(|end| (end, &s[digits_start..digits_end], unit))
    })
}

/// `parseReminder(input, now)`. Control characters in the text are left to the caller's schema
/// validation.
pub fn parse_reminder<Tz: TimeZone>(
    tz: &Tz,
    input: &str,
    now: DateTime<Utc>,
) -> Result<ParsedReminder, ParseError> {
    let normalized = icu_normalizer::ComposingNormalizerBorrowed::new_nfc().normalize(input);
    let source = js_trim(&normalized);

    if let Some((end, digits, unit)) = relative(source) {
        // `Number(digits)`: a number too big for u64 is far past the limit anyway.
        let amount = digits.parse::<u64>().unwrap_or(u64::MAX);
        let minutes = if unit.starts_with('h') {
            amount.saturating_mul(60)
        } else {
            amount
        };
        if !(1..=MAX_RELATIVE_MINUTES).contains(&minutes) {
            return Err(ParseError::NoTime);
        }
        let offset = i64::try_from(minutes).unwrap_or(i64::MAX) * MINUTE_MS;
        let due_at = now
            .checked_add_signed(Duration::milliseconds(offset))
            .unwrap_or(now);
        return finish(&source[end..], due_at, ReminderRepeat::None, None);
    }

    for (words, repeat, recurrence) in [
        (DAILY, ReminderRepeat::Daily, Recurrence::Daily),
        (WEEKDAYS, ReminderRepeat::Weekdays, Recurrence::Weekdays),
    ] {
        let Some(m) = keyword_time(source, words) else {
            continue;
        };
        let hhmm = time_from_match(&m).ok_or(ParseError::NoTime)?;
        let due_at = next_occurrence(tz, recurrence, &hhmm, now);
        return finish(&source[m.end..], due_at, repeat, Some(hhmm));
    }

    if let Some(m) = keyword_time(source, TOMORROW) {
        let hhmm = time_from_match(&m).ok_or(ParseError::NoTime)?;
        let due_at = at_local_time(tz, start_of_local_day(tz, now, 1), &hhmm);
        return finish(&source[m.end..], due_at, ReminderRepeat::None, None);
    }

    if let Some(m) = at_time(source, 0) {
        let hhmm = time_from_match(&m).ok_or(ParseError::NoTime)?;
        let due_at = next_occurrence(tz, Recurrence::Daily, &hhmm, now);
        return finish(&source[m.end..], due_at, ReminderRepeat::None, None);
    }

    Err(ParseError::NoTime)
}

#[cfg(test)]
mod tests {
    use chrono::Duration;
    use chrono_tz::Europe::Madrid;

    use super::*;
    use crate::reminders::time::tests::local;

    fn at(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Utc> {
        local(y, mo, d, h, mi, 0)
    }

    /// Tuesday.
    fn now() -> DateTime<Utc> {
        at(2026, 11, 10, 12, 0)
    }

    fn parse(input: &str) -> Result<ParsedReminder, ParseError> {
        parse_reminder(&Madrid, input, now())
    }

    fn parse_at(input: &str, when: DateTime<Utc>) -> Result<ParsedReminder, ParseError> {
        parse_reminder(&Madrid, input, when)
    }

    fn once(text: &str, due_at: DateTime<Utc>) -> Result<ParsedReminder, ParseError> {
        Ok(ParsedReminder {
            text: text.into(),
            due_at,
            repeat: ReminderRepeat::None,
            local_time: None,
        })
    }

    fn due(result: Result<ParsedReminder, ParseError>) -> DateTime<Utc> {
        result.expect("parsed").due_at
    }

    // parseReminder relative

    #[test]
    fn relative_forms() {
        for (input, minutes, text) in [
            ("en 30 min revisar PR", 30, "revisar PR"),
            ("in 30 min review PR", 30, "review PR"),
            ("en 2 h llamar", 120, "llamar"),
            ("in 1 hour call", 60, "call"),
            ("en 5 minutos x", 5, "x"),
            ("in 3 hours x", 180, "x"),
            ("en 2h x", 120, "x"),
            ("EN 5 MIN x", 5, "x"),
        ] {
            assert_eq!(
                parse(input),
                once(text, now() + Duration::minutes(minutes)),
                "{input}"
            );
        }
    }

    #[test]
    fn relative_rejects_zero_fractions_and_more_than_7_days() {
        assert_eq!(parse("en 0 min x"), Err(ParseError::NoTime));
        assert_eq!(parse("en 1.5 h x"), Err(ParseError::NoTime));
        assert_eq!(parse("en 10081 min x"), Err(ParseError::NoTime));
        assert_eq!(parse("en 169 h x"), Err(ParseError::NoTime));
        assert_eq!(
            parse("en 10080 min x").unwrap().repeat,
            ReminderRepeat::None
        );
        // `Number("99999999999999999999999")` is just a big number: still no-time, no overflow.
        assert_eq!(
            parse("en 99999999999999999999999 h x"),
            Err(ParseError::NoTime)
        );
    }

    // parseReminder clock times

    #[test]
    fn clock_16_00_today_when_15_59_tomorrow_when_16_00_00_or_16_00_30() {
        assert_eq!(
            parse_at("16:00 standup", at(2026, 11, 10, 15, 59)),
            once("standup", at(2026, 11, 10, 16, 0))
        );
        assert_eq!(
            due(parse_at("16:00 standup", local(2026, 11, 10, 16, 0, 0))),
            at(2026, 11, 11, 16, 0)
        );
        assert_eq!(
            due(parse_at("16:00 standup", local(2026, 11, 10, 16, 0, 30))),
            at(2026, 11, 11, 16, 0)
        );
    }

    #[test]
    fn am_pm_forms() {
        assert_eq!(due(parse("4pm x")), at(2026, 11, 10, 16, 0));
        assert_eq!(due(parse("4 PM x")), at(2026, 11, 10, 16, 0));
        assert_eq!(due(parse("12am x")), at(2026, 11, 11, 0, 0));
        assert_eq!(
            due(parse_at("12pm x", at(2026, 11, 10, 8, 0))),
            at(2026, 11, 10, 12, 0)
        );
        assert_eq!(due(parse("4:30pm x")), at(2026, 11, 10, 16, 30));
        assert_eq!(due(parse("4:30 pm x")), at(2026, 11, 10, 16, 30));
    }

    #[test]
    fn optional_a_las_and_at() {
        let parsed = parse("a las 16:00 x").unwrap();
        assert_eq!(parsed.text, "x");
        assert_eq!(parsed.due_at, at(2026, 11, 10, 16, 0));
        assert_eq!(due(parse("at 4pm x")), at(2026, 11, 10, 16, 0));
    }

    #[test]
    fn tomorrow() {
        for input in [
            "mañana 9:00 x",
            "tomorrow 9:00 x",
            "Manana 9:00 x",
            "mañana a las 9:00 x",
            // Not in the TS table: the capital Ñ matches `[nñ]` under the `i` flag.
            "MAÑANA 9:00 x",
        ] {
            assert_eq!(parse(input), once("x", at(2026, 11, 11, 9, 0)), "{input}");
        }
    }

    // parseReminder rollover and normalization

    #[test]
    fn manana_on_dec_31_is_jan_1() {
        assert_eq!(
            due(parse_at("mañana 9:00 x", at(2026, 12, 31, 20, 0))),
            at(2027, 1, 1, 9, 0)
        );
    }

    #[test]
    fn a_plain_time_already_past_on_dec_31_falls_back_to_jan_1() {
        assert_eq!(
            parse_at("9:00 x", at(2026, 12, 31, 20, 0)),
            once("x", at(2027, 1, 1, 9, 0))
        );
    }

    #[test]
    fn parses_decomposed_accents_nfc_normalization() {
        // "di" + U+0301 and "man" + U+0303, as the TS test file spells them.
        let daily = parse("cada di\u{301}a 9:00 x").unwrap();
        assert_eq!(daily.repeat, ReminderRepeat::Daily);
        assert_eq!(daily.due_at, at(2026, 11, 11, 9, 0));
        assert_eq!(due(parse("man\u{303}ana 9:00 x")), at(2026, 11, 11, 9, 0));
        // The text itself comes out composed.
        assert_eq!(parse("en 5 min cafe\u{301}").unwrap().text, "café");
    }

    // parseReminder repeating

    #[test]
    fn daily() {
        for input in [
            "diario 9:00 x",
            "daily 9:00 x",
            "cada día 9:00 x",
            "cada dia 9:00 x",
            "every day 9:00 x",
            // Not in the TS table: capital accent and extra spacing.
            "CADA DÍA  9:00 x",
        ] {
            assert_eq!(
                parse(input),
                Ok(ParsedReminder {
                    text: "x".into(),
                    due_at: at(2026, 11, 11, 9, 0),
                    repeat: ReminderRepeat::Daily,
                    local_time: Some("09:00".into()),
                }),
                "{input}"
            );
        }
    }

    #[test]
    fn weekdays_on_friday_10_00_to_monday_09_30() {
        let friday = at(2026, 11, 13, 10, 0);
        for input in ["laborables 9:30 x", "weekdays 9:30 x"] {
            assert_eq!(
                parse_at(input, friday),
                Ok(ParsedReminder {
                    text: "x".into(),
                    due_at: at(2026, 11, 16, 9, 30),
                    repeat: ReminderRepeat::Weekdays,
                    local_time: Some("09:30".into()),
                }),
                "{input}"
            );
        }
    }

    #[test]
    fn daily_with_am_is_zero_padded_24h() {
        assert_eq!(
            parse("daily 9am x").unwrap().local_time.as_deref(),
            Some("09:00")
        );
    }

    // parseReminder errors

    #[test]
    fn empty_text() {
        assert_eq!(parse("16:00"), Err(ParseError::EmptyText));
        assert_eq!(parse("en 5 min   "), Err(ParseError::EmptyText));
    }

    #[test]
    fn invisible_only_text_counts_as_empty() {
        assert_eq!(parse("16:00 \u{200D}"), Err(ParseError::EmptyText));
        assert_eq!(
            parse("en 5 min \u{200D} \u{200D}"),
            Err(ParseError::EmptyText)
        );
    }

    #[test]
    fn no_time() {
        for input in [
            "revisar PR",
            "",
            "25:00 x",
            "13pm x",
            "0am x",
            "16:60 x",
            "mañana x",
            // Not in the TS table: `\d` is ASCII only (Arabic-Indic digits are not a time), a
            // three-digit hour is not `\d{1,2}`, and the time must end at a space.
            "\u{661}\u{666}:00 x",
            "123:00 x",
            "16:00x",
        ] {
            assert_eq!(parse(input), Err(ParseError::NoTime), "{input:?}");
        }
    }

    #[test]
    fn too_long() {
        assert_eq!(
            parse(&format!("16:00 {}", "a".repeat(201))),
            Err(ParseError::TooLong)
        );
        assert_eq!(
            parse(&format!("16:00 {}", "a".repeat(200))).unwrap().repeat,
            ReminderRepeat::None
        );
        // `text.length` counts UTF-16 units: 100 astral emoji are 200 units, 101 are too long.
        assert!(parse(&format!("16:00 {}", "\u{1F600}".repeat(100))).is_ok());
        assert_eq!(
            parse(&format!("16:00 {}", "\u{1F600}".repeat(101))),
            Err(ParseError::TooLong)
        );
    }

    #[test]
    fn returns_control_chars_as_is_service_validates() {
        assert_eq!(parse("16:00 a\tb").unwrap().text, "a\tb");
    }

    #[test]
    fn error_codes_are_the_ts_strings() {
        assert_eq!(ParseError::EmptyText.as_str(), "empty-text");
        assert_eq!(ParseError::NoTime.as_str(), "no-time");
        assert_eq!(ParseError::TooLong.as_str(), "too-long");
    }

    #[test]
    fn whitespace_follows_js_and_case_folding_stays_ascii() {
        // JS `\s` includes NBSP and U+3000 between the parts.
        assert_eq!(
            due(parse("en\u{A0}5\u{3000}min x")),
            now() + Duration::minutes(5)
        );
        // A two-space gap after the time still leaves just the text.
        assert_eq!(parse("16:00  x"), once("x", at(2026, 11, 10, 16, 0)));
        // Backtracking like JS: "pm" not followed by a space is text, so 4:30 is 04:30.
        assert_eq!(parse("4:30 pmx"), once("pmx", at(2026, 11, 11, 4, 30)));
        assert_eq!(due(parse("at  4pm x")), at(2026, 11, 10, 16, 0));
        // Non-u `i` never folds a non-ASCII letter onto ASCII: long s (kept by NFC) is not "s".
        assert_eq!(parse("weekday\u{17F} 9:30 x"), Err(ParseError::NoTime));
        // The Kelvin sign, though, is NFC-normalized to "K" before matching, as in JS.
        assert_eq!(
            parse("wee\u{212A}days 9:30 x").unwrap().repeat,
            ReminderRepeat::Weekdays
        );
    }
}
