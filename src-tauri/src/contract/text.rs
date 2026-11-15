//! String rules shared by the part-2 schemas: zod's `.trim()`, the control-character refinements
//! of notes and reminders, `hasVisibleText` (`src/shared/text.ts`), `z.uuid()` and
//! `z.iso.datetime()`.
//!
//! The code point tables are the classes of the JS regex engine (`\s`, `\p{Cc}`/`\p{Cf}`,
//! `\p{Default_Ignorable_Code_Point}`); `tests/parity/unicode-classes.json` is generated from it
//! and `src-tauri/tests/parity.rs` checks the tables still equal it. Rust's own `str::trim` and
//! `char::is_whitespace` differ from JS (U+0085 vs U+FEFF), so they are not used here.

/// `\s` with the `u` flag, which is also the set `String.prototype.trim` strips.
pub const WHITESPACE: &[(u32, u32)] = &[
    (0x9, 0xD),
    (0x20, 0x20),
    (0xA0, 0xA0),
    (0x1680, 0x1680),
    (0x2000, 0x200A),
    (0x2028, 0x2029),
    (0x202F, 0x202F),
    (0x205F, 0x205F),
    (0x3000, 0x3000),
    (0xFEFF, 0xFEFF),
];

/// `[\p{Cc}\p{Cf}]`: control and format characters.
pub const CONTROL_OR_FORMAT: &[(u32, u32)] = &[
    (0x0, 0x1F),
    (0x7F, 0x9F),
    (0xAD, 0xAD),
    (0x600, 0x605),
    (0x61C, 0x61C),
    (0x6DD, 0x6DD),
    (0x70F, 0x70F),
    (0x890, 0x891),
    (0x8E2, 0x8E2),
    (0x180E, 0x180E),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x2064),
    (0x2066, 0x206F),
    (0xFEFF, 0xFEFF),
    (0xFFF9, 0xFFFB),
    (0x110BD, 0x110BD),
    (0x110CD, 0x110CD),
    (0x13430, 0x1343F),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0001, 0xE0001),
    (0xE0020, 0xE007F),
];

/// `\p{Default_Ignorable_Code_Point}`: ZWJ, variation selectors, Hangul fillers...
pub const DEFAULT_IGNORABLE: &[(u32, u32)] = &[
    (0xAD, 0xAD),
    (0x34F, 0x34F),
    (0x61C, 0x61C),
    (0x115F, 0x1160),
    (0x17B4, 0x17B5),
    (0x180B, 0x180F),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x206F),
    (0x3164, 0x3164),
    (0xFE00, 0xFE0F),
    (0xFEFF, 0xFEFF),
    (0xFFA0, 0xFFA0),
    (0xFFF0, 0xFFF8),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0000, 0xE0FFF),
];

/// U+200D, allowed in every text: emoji sequences (woman + ZWJ + laptop) need it.
const ZERO_WIDTH_JOINER: char = '\u{200D}';

fn in_table(character: char, table: &[(u32, u32)]) -> bool {
    let code = u32::from(character);
    table
        .binary_search_by(|&(start, end)| {
            if end < code {
                std::cmp::Ordering::Less
            } else if start > code {
                std::cmp::Ordering::Greater
            } else {
                std::cmp::Ordering::Equal
            }
        })
        .is_ok()
}

/// JS `\s` (with or without the `u` flag): the characters `String.prototype.trim` strips.
pub fn is_js_whitespace(character: char) -> bool {
    in_table(character, WHITESPACE)
}

/// `String.prototype.trim`.
pub fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `hasVisibleText`: some character is neither whitespace nor default-ignorable.
pub fn has_visible_text(text: &str) -> bool {
    text.chars()
        .any(|character| !is_js_whitespace(character) && !in_table(character, DEFAULT_IGNORABLE))
}

/// The refinements of `noteTextSchema` / `reminderTextSchema` after `.trim()`: length in code
/// points (zod 4 counts code points, so an astral emoji is one), no control or format character
/// outside `allowed` and ZWJ, and something visible. Returns the trimmed text.
pub(crate) fn trimmed_text(raw: &str, max: usize, allowed: &[char]) -> Result<String, String> {
    let text = js_trim(raw);
    let length = super::length(text);
    if length == 0 || length > max {
        return Err(format!("text must be 1 to {max} characters"));
    }
    if text.chars().any(|character| {
        character != ZERO_WIDTH_JOINER
            && !allowed.contains(&character)
            && in_table(character, CONTROL_OR_FORMAT)
    }) {
        return Err("Text contains control characters".into());
    }
    if !has_visible_text(text) {
        return Err("Text has no visible characters".into());
    }
    Ok(text.to_owned())
}

/// `z.uuid()`: 8-4-4-4-12 hex with version 1-8 and variant 8, 9, a or b; or the nil and max
/// UUIDs (lowercase only, as zod's regex spells them).
pub fn is_uuid(value: &str) -> bool {
    if value == "00000000-0000-0000-0000-000000000000"
        || value == "ffffffff-ffff-ffff-ffff-ffffffffffff"
    {
        return true;
    }
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            14 => (b'1'..=b'8').contains(byte),
            19 => matches!(byte, b'8' | b'9' | b'a' | b'b' | b'A' | b'B'),
            _ => byte.is_ascii_hexdigit(),
        })
}

/// [`is_uuid`] as a refinement of the field `name`.
pub(crate) fn uuid(name: &str, value: &str) -> Result<(), String> {
    if is_uuid(value) {
        Ok(())
    } else {
        Err(format!("{name} must be a UUID"))
    }
}

/// [`is_iso_datetime`] as a refinement of the field `name`.
pub(crate) fn datetime(name: &str, value: &str) -> Result<(), String> {
    if is_iso_datetime(value) {
        Ok(())
    } else {
        Err(format!("{name} must be an ISO datetime"))
    }
}

/// The number written with ASCII digits in `bytes`, if they all are digits.
fn digits(bytes: &[u8]) -> Option<u32> {
    bytes.iter().try_fold(0u32, |total, byte| {
        byte.is_ascii_digit()
            .then(|| total * 10 + u32::from(byte - b'0'))
    })
}

/// `z.iso.datetime()` with zod's defaults: `YYYY-MM-DDTHH:mm:ss[.fraction]Z`, a real calendar
/// date (leap years included), seconds required, UTC `Z` only (no offsets, no local times).
pub fn is_iso_datetime(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() < 20 {
        return false;
    }
    let separators = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':')];
    if separators.iter().any(|&(index, byte)| bytes[index] != byte) {
        return false;
    }
    let field = |start: usize, len: usize| digits(&bytes[start..start + len]);
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = (
        field(0, 4),
        field(5, 2),
        field(8, 2),
        field(11, 2),
        field(14, 2),
        field(17, 2),
    ) else {
        return false;
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    if day == 0 || day > month_days || hour > 23 || minute > 59 || second > 59 {
        return false;
    }
    match &bytes[19..] {
        [b'Z'] => true,
        [b'.', fraction @ .., b'Z'] => {
            !fraction.is_empty() && fraction.iter().all(u8::is_ascii_digit)
        }
        _ => false,
    }
}

/// `localTimeSchema`: `HH:mm`, 24 hours.
pub fn is_local_time(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 5
        && bytes[2] == b':'
        && digits(&bytes[0..2]).is_some_and(|hour| hour <= 23)
        && digits(&bytes[3..5]).is_some_and(|minute| minute <= 59)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trim_follows_js_not_rust() {
        assert_eq!(js_trim("\u{FEFF} a \u{3000}"), "a");
        assert_eq!(js_trim("\u{85}a"), "\u{85}a");
    }

    #[test]
    fn visible_text_ignores_whitespace_and_default_ignorables() {
        assert!(!has_visible_text(" \u{200D}\u{FE0F}\u{3164}\t"));
        assert!(has_visible_text("\u{200D}a"));
    }

    #[test]
    fn datetime_follows_the_gregorian_calendar() {
        assert!(is_iso_datetime("2000-02-29T00:00:00Z"));
        assert!(!is_iso_datetime("1900-02-29T00:00:00Z"));
        assert!(is_iso_datetime("2026-11-15T09:30:00.1Z"));
        assert!(!is_iso_datetime("2026-11-15T09:30:00.Z"));
        assert!(!is_iso_datetime("2026-11-15T09:30:00+00:00"));
    }

    #[test]
    fn local_time_is_24_hour_hh_mm() {
        assert!(is_local_time("00:00") && is_local_time("23:59"));
        assert!(!is_local_time("24:00") && !is_local_time("9:00") && !is_local_time("09:5x"));
    }
}
