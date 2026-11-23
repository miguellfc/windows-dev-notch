//! Whole-minute subtask times that add up to the session's figure
//! (`src/shared/work-log/rounding.ts`, same algorithm and the shared cases in
//! `tests/parity/work-log-rounding.json`).

const MS_PER_MINUTE: i64 = 60_000;

/// Rounds each of `values` (ms) to whole minutes by largest remainder, so they add up to the
/// whole minutes of `target_ms` (what [`super::duration::duration_text`] shows for it): each value
/// is cut to its minute, then the minutes still missing go one each to the largest remainders
/// (the first on a tie). Values above the target lose minutes from the smallest remainders (the
/// last on a tie). Negative values read as 0. Results in ms.
pub fn round_to_minutes(values: &[i64], target_ms: i64) -> Vec<i64> {
    let values: Vec<i64> = values.iter().map(|value| (*value).max(0)).collect();
    let mut minutes: Vec<i64> = values.iter().map(|value| value / MS_PER_MINUTE).collect();
    let remainder = |i: usize| values[i] % MS_PER_MINUTE;
    let target = (target_ms / MS_PER_MINUTE).max(0);
    let missing = target - minutes.iter().sum::<i64>();
    let mut order: Vec<usize> = (0..values.len()).collect();
    if missing > 0 {
        // Largest remainder first, the first on a tie (a stable sort keeps the index order).
        order.sort_by_key(|&i| std::cmp::Reverse(remainder(i)));
        for &i in order.iter().take(missing as usize) {
            minutes[i] += 1;
        }
    } else if missing < 0 {
        // Smallest remainder first, the last on a tie.
        order.reverse();
        order.sort_by_key(|&i| remainder(i));
        let mut extra = -missing;
        for &i in &order {
            if extra == 0 {
                break;
            }
            if minutes[i] > 0 {
                minutes[i] -= 1;
                extra -= 1;
            }
        }
    }
    minutes.into_iter().map(|m| m * MS_PER_MINUTE).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Case {
        name: String,
        values: Vec<i64>,
        target_ms: i64,
        expected: Vec<i64>,
    }

    #[derive(Deserialize)]
    struct Cases {
        cases: Vec<Case>,
    }

    #[test]
    fn matches_the_shared_cases() {
        let cases: Cases =
            serde_json::from_str(include_str!("../../../tests/parity/work-log-rounding.json"))
                .unwrap();
        assert!(!cases.cases.is_empty());
        for case in cases.cases {
            assert_eq!(
                round_to_minutes(&case.values, case.target_ms),
                case.expected,
                "{}",
                case.name
            );
        }
    }
}
