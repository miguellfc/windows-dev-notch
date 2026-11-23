//! Formato de duraciones del registro de trabajo: `Xh Ym`, `Xh` o `Ym`, igual que la versión TS.

const MS_PER_MINUTE: i64 = 60_000;

/// Formats a duration in milliseconds as `Xh Ym`, `Xh` or `Ym` (minutes truncated; negatives read as 0).
pub fn duration_text(ms: i64) -> String {
    let total_minutes = (ms / MS_PER_MINUTE).max(0);
    let hours = total_minutes / 60;
    let minutes = total_minutes % 60;
    match (hours, minutes) {
        (0, m) => format!("{m}m"),
        (h, 0) => format!("{h}h"),
        (h, m) => format!("{h}h {m}m"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;

    #[test]
    fn formats_zero_as_0m() {
        assert_eq!(duration_text(0), "0m");
    }

    #[test]
    fn truncates_partial_minutes() {
        assert_eq!(duration_text(59_999), "0m");
    }

    #[test]
    fn formats_whole_minutes() {
        assert_eq!(duration_text(MIN), "1m");
        assert_eq!(duration_text(25 * MIN), "25m");
    }

    #[test]
    fn formats_whole_hours_without_minutes() {
        assert_eq!(duration_text(60 * MIN), "1h");
    }

    #[test]
    fn formats_hours_and_minutes() {
        assert_eq!(duration_text(85 * MIN), "1h 25m");
        assert_eq!(duration_text((5 * 60 + 45) * MIN), "5h 45m");
    }

    #[test]
    fn clamps_negative_to_0m() {
        assert_eq!(duration_text(-5 * MIN), "0m");
    }
}
