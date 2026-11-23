//! The notch: its pure logic (the mode state machine and the window geometry, ported from
//! `src/shared/notch/{state,geometry}.ts` and kept equal to them by the fixtures in `tests/parity`),
//! the controller, and the capsule window with its cursor poller.

pub mod controller;
pub mod cursor;
pub mod display;
pub mod geometry;
pub mod ipc;
pub mod runtime;
pub mod state;
pub mod window;

pub use geometry::*;
pub use state::*;

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};

    use super::*;

    const TRACES: &str = include_str!("../../../tests/parity/notch-traces.json");
    const GEOMETRY: &str = include_str!("../../../tests/parity/geometry.json");

    fn visible_mode(name: &str) -> VisibleMode {
        VisibleMode::ALL
            .iter()
            .copied()
            .find(|mode| mode.as_str() == name)
            .unwrap_or_else(|| panic!("unknown visible mode {name}"))
    }

    fn rect(value: &Value) -> Rect {
        Rect {
            x: value["x"].as_f64().unwrap(),
            y: value["y"].as_f64().unwrap(),
            width: value["width"].as_f64().unwrap(),
            height: value["height"].as_f64().unwrap(),
        }
    }

    /// Integers compare exactly; any other float within 1e-9.
    fn assert_number(actual: f64, expected: &Value, what: &str) {
        let expected = expected
            .as_f64()
            .unwrap_or_else(|| panic!("{what}: not a number"));
        if expected.fract() == 0.0 {
            assert_eq!(actual, expected, "{what}");
        } else {
            assert!(
                (actual - expected).abs() < 1e-9,
                "{what}: {actual} vs {expected}"
            );
        }
    }

    #[test]
    fn replays_notch_traces() {
        let traces: Value = serde_json::from_str(TRACES).expect("notch-traces.json is valid");
        let initial: NotchState = serde_json::from_value(traces["initial"].clone()).unwrap();
        assert_eq!(initial, NotchState::default(), "initial state");

        let sequences = traces["sequences"].as_array().unwrap();
        assert_eq!(sequences.len(), 200);
        for (s, sequence) in sequences.iter().enumerate() {
            let mut state = initial;
            let mut expected = serde_json::to_value(initial).unwrap();
            for (i, step) in sequence.as_array().unwrap().iter().enumerate() {
                let at = format!("sequence {s} step {i}");
                let event: NotchEvent = serde_json::from_value(step["event"].clone())
                    .unwrap_or_else(|error| panic!("{at}: {error}"));
                state = reduce_notch(&state, &event);
                for (key, value) in step["changes"].as_object().unwrap() {
                    expected[key] = value.clone();
                }
                assert_eq!(
                    serde_json::to_value(state).unwrap(),
                    expected,
                    "{at}: state"
                );
                assert_eq!(
                    json!(notch_mode(&state).as_str()),
                    step["mode"],
                    "{at}: mode"
                );
                assert_eq!(mail_alert_shown(&state), step["mailShown"], "{at}: mail");
                assert_eq!(
                    review_alert_shown(&state),
                    step["reviewShown"],
                    "{at}: review"
                );
                assert_eq!(
                    redmine_alert_shown(&state),
                    step["redmineShown"],
                    "{at}: redmine"
                );
            }
        }
    }

    #[test]
    fn geometry_matches_ts() {
        let geometry: Value = serde_json::from_str(GEOMETRY).expect("geometry.json is valid");
        assert_number(WINDOW_WIDTH, &geometry["windowWidth"], "window width");

        for (name, size) in geometry["capsuleSizes"].as_object().unwrap() {
            let actual = capsule_size(visible_mode(name));
            assert_number(actual.width, &size["width"], name);
            assert_number(actual.height, &size["height"], name);
        }
        assert_eq!(
            geometry["capsuleSizes"].as_object().unwrap().len(),
            VisibleMode::ALL.len()
        );
        for (name, top) in geometry["capsuleTop"].as_object().unwrap() {
            assert_number(capsule_top_for(visible_mode(name)), top, name);
        }
        for (name, height) in geometry["windowHeight"].as_object().unwrap() {
            assert_number(window_height_for(visible_mode(name)), height, name);
        }
        for case in geometry["windowBounds"].as_array().unwrap() {
            let mode = visible_mode(case["mode"].as_str().unwrap());
            let actual = window_bounds_for(mode, rect(&case["workArea"]));
            let expected = &case["bounds"];
            let at = format!("bounds of {} in {}", mode.as_str(), case["workArea"]);
            assert_number(actual.x, &expected["x"], &at);
            assert_number(actual.y, &expected["y"], &at);
            assert_number(actual.width, &expected["width"], &at);
            assert_number(actual.height, &expected["height"], &at);
        }
        let orders = geometry["resizeOrder"].as_array().unwrap();
        assert_eq!(orders.len(), VisibleMode::ALL.len().pow(2));
        for case in orders {
            let (from, to) = (
                visible_mode(case["from"].as_str().unwrap()),
                visible_mode(case["to"].as_str().unwrap()),
            );
            assert_eq!(
                json!(resize_order(from, to).as_str()),
                case["order"],
                "{} -> {}",
                from.as_str(),
                to.as_str()
            );
        }
        let widths = geometry["compactWidths"].as_array().unwrap();
        assert_eq!(widths.len(), 3 * 2 * 2 * 3 * 2 * 2);
        for case in widths {
            let system = case["system"].as_object().map(|system| SystemZone {
                battery: system["battery"].as_bool().unwrap(),
            });
            let blocks = &case["blocks"];
            let actual = compact_width_for(
                system,
                CapsuleBlocks {
                    claude: blocks["claude"].as_bool().unwrap(),
                    mail: blocks["mail"].as_bool().unwrap(),
                    reviews: blocks["reviews"].as_i64().unwrap(),
                    redmine: blocks["redmine"].as_bool().unwrap(),
                    work_log: blocks["workLog"].as_bool().unwrap(),
                },
            );
            assert_number(actual, &case["width"], &format!("compact width {case}"));
        }
    }
}
