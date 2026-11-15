//! Parity with the TS sources of truth, through the fixtures in `tests/parity`
//! (see `tests/unit/shared/parity.test.ts`).

use std::collections::BTreeSet;

use developer_notch_lib::contract::text::{CONTROL_OR_FORMAT, DEFAULT_IGNORABLE, WHITESPACE};
use developer_notch_lib::contract::{check, Direction};
use developer_notch_lib::ipc::Registry;
use serde_json::Value;

const CONTRACT_CASES: &str = include_str!("../../tests/parity/contract-cases.json");
const CHANNELS: &str = include_str!("../../tests/parity/channels.json");
const UNICODE_CLASSES: &str = include_str!("../../tests/parity/unicode-classes.json");

#[test]
fn every_contract_case_gets_the_expected_serde_verdict() {
    let cases: Vec<serde_json::Map<String, Value>> =
        serde_json::from_str(CONTRACT_CASES).expect("contract-cases.json is valid");
    assert!(cases.len() >= 60, "too few contract cases");

    let mut mismatches = Vec::new();
    for (index, case) in cases.iter().enumerate() {
        let channel = case["channel"].as_str().expect("channel is a string");
        let direction = match case["direction"].as_str() {
            Some("input") => Direction::Input,
            Some("output") => Direction::Output,
            Some("event") => Direction::Event,
            other => panic!("#{index}: unknown direction {other:?}"),
        };
        let accept = case["accept"].as_bool().expect("accept is a boolean");
        // A case without `value` is `undefined` in TS: nothing was sent.
        let Some(verdict) = check(channel, direction, case.get("value")) else {
            mismatches.push(format!("#{index} {channel}: no Rust contract"));
            continue;
        };
        if verdict.is_ok() != accept {
            mismatches.push(format!(
                "#{index} {channel} {direction:?}: expected accept={accept}, got {verdict:?}"
            ));
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

#[test]
fn channels_registry_covers_channels_json() {
    let fixture: Value = serde_json::from_str(CHANNELS).expect("channels.json is valid");
    let expected: BTreeSet<&str> = fixture["channels"]
        .as_array()
        .expect("channels is an array")
        .iter()
        .map(|name| name.as_str().expect("channel names are strings"))
        .collect();
    let registered: BTreeSet<&str> = Registry::with_dev_origin(false)
        .channel_names()
        .into_iter()
        .collect();
    assert_eq!(registered, expected);
}

#[test]
fn text_rule_tables_match_the_js_regex_engine() {
    let fixture: Value =
        serde_json::from_str(UNICODE_CLASSES).expect("unicode-classes.json is valid");
    let ranges = |name: &str| -> Vec<(u32, u32)> {
        fixture[name]
            .as_array()
            .expect("an array of ranges")
            .iter()
            .map(|pair| {
                let bound = |index: usize| {
                    u32::try_from(pair[index].as_u64().expect("a code point")).expect("fits u32")
                };
                (bound(0), bound(1))
            })
            .collect()
    };
    assert_eq!(ranges("whitespace"), WHITESPACE);
    assert_eq!(ranges("controlOrFormat"), CONTROL_OR_FORMAT);
    assert_eq!(ranges("defaultIgnorable"), DEFAULT_IGNORABLE);
}
