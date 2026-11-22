//! Port of 0.1.0's `claude-hook-installer.test.ts` (every case), plus the Rust-only checks.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{DateTime, Local, TimeZone, Utc};
use serde_json::{json, Map, Value};

use super::*;
use crate::claude::js_json::{stringify, stringify_pretty};
use crate::services::fs_atomic::write_atomic;
use crate::services::test_dir::TestDir;

const FOREIGN_EVENTS: [&str; 12] = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PermissionRequest",
    "Notification",
    "Stop",
    "SubagentStop",
    "SessionEnd",
    "PreCompact",
    "SubagentStart",
    "StopFailure",
];

fn opts() -> HookInstallOptions {
    opts_with(47600, "tok-1")
}

fn opts_with(port: u16, token: &str) -> HookInstallOptions {
    HookInstallOptions {
        port,
        token: token.into(),
        account: "claude".into(),
    }
}

fn event_names() -> Vec<&'static str> {
    HOOK_EVENT_NAMES
        .iter()
        .map(|event| event.as_str())
        .collect()
}

fn coucou_group(event: &str) -> Value {
    json!({
        "matcher": "*",
        "hooks": [{ "type": "command", "command": format!("node \"C:/coucou/hook.js\" {event}"), "timeout": 5 }],
    })
}

fn fixture_object() -> Value {
    let mut hooks = Map::new();
    for event in FOREIGN_EVENTS {
        hooks.insert(event.into(), json!([coucou_group(event)]));
    }
    json!({
        "theme": "dark",
        "enabledPlugins": { "ecc@ecc": true, "superpowers@x": false },
        "hooks": hooks,
        "permissions": { "allow": ["Bash(git status)"] },
    })
}

/// `${JSON.stringify(value, null, 2)}\n`
fn pretty(value: &Value) -> String {
    format!("{}\n", stringify_pretty(value))
}

fn fixture_text() -> String {
    pretty(&fixture_object())
}

fn ok(plan: HookPlan) -> Plan {
    plan.expect("expected ok, got invalid-json")
}

fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap()
}

fn keys(value: &Value) -> Vec<String> {
    value.as_object().unwrap().keys().cloned().collect()
}

fn groups<'a>(value: &'a Value, event: &str) -> &'a Vec<Value> {
    value["hooks"][event].as_array().unwrap()
}

fn groups_mut<'a>(value: &'a mut Value, event: &str) -> &'a mut Vec<Value> {
    value["hooks"][event].as_array_mut().unwrap()
}

fn is_ours(group: &Value) -> bool {
    group["hooks"]
        .as_array()
        .unwrap()
        .iter()
        .all(|hook| hook["type"] == "http" && hook["headers"]["x-notch-hook"] == "1")
}

fn is_question(group: &Value) -> bool {
    group.get("matcher") == Some(&json!("AskUserQuestion"))
}

fn ours(value: &Value, event: &str) -> Vec<Value> {
    groups(value, event)
        .iter()
        .filter(|group| is_ours(group))
        .cloned()
        .collect()
}

// --- planInstall -------------------------------------------------------------

#[test]
fn adds_one_marked_group_per_event_and_leaves_foreign_groups_and_keys_untouched() {
    let result = parse(&ok(plan_install(Some(&fixture_text()), &opts())).next);
    let original = fixture_object();

    assert_eq!(keys(&result), keys(&original));
    assert_eq!(result["theme"], "dark");
    assert_eq!(result["enabledPlugins"], original["enabledPlugins"]);
    assert_eq!(result["permissions"], original["permissions"]);
    for event in FOREIGN_EVENTS {
        assert_eq!(groups(&result, event)[0], coucou_group(event));
    }
    for event in event_names() {
        // PreToolUse also gets the AskUserQuestion group.
        let expected = if event == "PreToolUse" { 2 } else { 1 };
        assert_eq!(ours(&result, event).len(), expected, "{event}");
    }
    // The original groups keep their position; ours are appended.
    let pre = groups(&result, "PreToolUse");
    assert_eq!(pre.len(), 3);
    assert_eq!(pre[0], coucou_group("PreToolUse"));
    assert!(is_ours(&pre[1]));
    assert!(is_ours(&pre[2]));
}

#[test]
fn adds_the_ask_user_question_group_to_pre_tool_use_held_for_up_to_an_hour() {
    let result = parse(&ok(plan_install(Some(&fixture_text()), &opts())).next);
    assert_eq!(
        groups(&result, "PreToolUse")[2],
        json!({
            "matcher": "AskUserQuestion",
            "hooks": [{
                "type": "http",
                "url": "http://127.0.0.1:47600/hook/question",
                "headers": { "x-notch-token": "tok-1", "x-notch-hook": "1", "x-notch-account": "claude" },
                "timeout": 3600,
            }],
        })
    );
    for event in event_names().into_iter().filter(|e| *e != "PreToolUse") {
        assert!(!stringify(&result["hooks"][event]).contains("/hook/question"));
    }
}

#[test]
fn the_diff_preview_shows_the_ask_user_question_group_being_added_to_an_older_install() {
    let mut older = parse(&ok(plan_install(Some(&fixture_text()), &opts())).next);
    groups_mut(&mut older, "PreToolUse").retain(|group| !is_question(group));
    let older_text = pretty(&older);
    assert_eq!(
        hook_status(Some(&older_text), &opts()),
        HookStatus::Outdated
    );
    let Plan { next, diff } = ok(plan_install(Some(&older_text), &opts()));
    let added: Vec<&str> = diff
        .iter()
        .filter(|line| line.kind == DiffKind::Add)
        .map(|line| line.text.as_str())
        .collect();
    assert!(added
        .iter()
        .any(|text| text.contains("\"matcher\": \"AskUserQuestion\"")));
    assert!(added.iter().any(|text| text.contains("/hook/question")));
    assert!(!diff.iter().any(|line| line.kind == DiffKind::Remove));
    assert_eq!(hook_status(Some(&next), &opts()), HookStatus::Installed);
}

#[test]
fn writes_the_exact_group_shape_with_a_long_timeout_only_for_permission_request() {
    let result = parse(&ok(plan_install(Some(&fixture_text()), &opts())).next);
    for event in event_names() {
        let group = groups(&result, event)
            .iter()
            .find(|group| is_ours(group))
            .unwrap();
        let timeout = if event == "PermissionRequest" {
            3600
        } else {
            2
        };
        assert_eq!(
            *group,
            json!({
                "hooks": [{
                    "type": "http",
                    "url": "http://127.0.0.1:47600/hook",
                    "headers": { "x-notch-token": "tok-1", "x-notch-hook": "1", "x-notch-account": "claude" },
                    "timeout": timeout,
                }],
            })
        );
    }
}

#[test]
fn every_hook_of_ours_carries_the_account_header() {
    let options = HookInstallOptions {
        account: "claude-work".into(),
        ..opts()
    };
    let next = ok(plan_install(Some(&fixture_text()), &options)).next;
    let result = parse(&next);
    for event in event_names() {
        for group in ours(&result, event) {
            for hook in group["hooks"].as_array().unwrap() {
                assert_eq!(hook["headers"]["x-notch-account"], "claude-work", "{event}");
            }
        }
    }
    assert_eq!(hook_status(Some(&next), &options), HookStatus::Installed);
    // The same hooks for another account are not this one's.
    assert_eq!(hook_status(Some(&next), &opts()), HookStatus::Outdated);
}

#[test]
fn hooks_installed_by_0_3_0_without_the_account_header_are_outdated() {
    let mut value = parse(&ok(plan_install(Some(&fixture_text()), &opts())).next);
    for event in event_names() {
        for group in groups_mut(&mut value, event) {
            for hook in group["hooks"].as_array_mut().unwrap() {
                if let Some(headers) = hook["headers"].as_object_mut() {
                    if headers.get("x-notch-hook") == Some(&json!("1")) {
                        headers.remove("x-notch-account");
                    }
                }
            }
        }
    }
    // 0.3.0 had no SessionStart group either.
    groups_mut(&mut value, "SessionStart").retain(|group| !is_ours(group));
    let old = pretty(&value);
    assert!(!old.contains("x-notch-account"));
    assert_eq!(hook_status(Some(&old), &opts()), HookStatus::Outdated);
    // Reinstalling replaces them: one group of ours per event again, all marked.
    let next = ok(plan_install(Some(&old), &opts())).next;
    assert_eq!(hook_status(Some(&next), &opts()), HookStatus::Installed);
    assert_eq!(ours(&parse(&next), "SessionStart").len(), 1);
}

#[test]
fn installs_a_session_start_group() {
    let result = parse(&ok(plan_install(None, &opts())).next);
    assert_eq!(ours(&result, "SessionStart").len(), 1);
}

#[test]
fn formats_as_2_space_json_with_a_trailing_newline() {
    let next = ok(plan_install(Some(&fixture_text()), &opts())).next;
    assert_eq!(next, pretty(&parse(&next)));
    assert!(next
        .starts_with("{\n  \"theme\": \"dark\",\n  \"enabledPlugins\": {\n    \"ecc@ecc\": true,"));
}

#[test]
fn is_idempotent() {
    let first = ok(plan_install(Some(&fixture_text()), &opts())).next;
    let second = ok(plan_install(Some(&first), &opts())).next;
    assert_eq!(second, first);
}

#[test]
fn replaces_only_our_groups_when_reinstalling_with_a_new_token_or_port() {
    let first = ok(plan_install(Some(&fixture_text()), &opts())).next;
    let result = parse(&ok(plan_install(Some(&first), &opts_with(47601, "tok-2"))).next);
    for event in event_names() {
        let ours = ours(&result, event);
        assert_eq!(ours.len(), if event == "PreToolUse" { 2 } else { 1 });
        for group in ours {
            let text = stringify(&group);
            assert!(text.contains("tok-2"));
            assert!(text.contains("127.0.0.1:47601"));
            assert!(!text.contains("tok-1"));
        }
    }
    for event in FOREIGN_EVENTS {
        assert_eq!(groups(&result, event)[0], coucou_group(event));
    }
}

#[test]
fn creates_the_hooks_block_when_the_file_is_missing() {
    let result = parse(&ok(plan_install(None, &opts())).next);
    assert_eq!(keys(&result), ["hooks"]);
    let mut events = keys(&result["hooks"]);
    events.sort();
    let mut expected: Vec<String> = event_names().into_iter().map(String::from).collect();
    expected.sort();
    assert_eq!(events, expected);
}

#[test]
fn adds_the_hooks_key_to_a_file_that_has_none() {
    let next = ok(plan_install(Some(r#"{ "theme": "dark" }"#), &opts())).next;
    assert_eq!(keys(&parse(&next)), ["theme", "hooks"]);
}

#[test]
fn keeps_crlf_line_endings_when_the_file_used_them() {
    let crlf = fixture_text().replace('\n', "\r\n");
    let next = ok(plan_install(Some(&crlf), &opts())).next;
    assert!(next.contains("\r\n"));
    assert!(!next.replace("\r\n", "").contains('\n'));
}

#[test]
fn rejects_malformed_settings_as_invalid_json() {
    let bom = format!("\u{feff}{}", fixture_text());
    let cases: [(&str, &str); 8] = [
        ("not json", "{ nope"),
        ("empty", ""),
        ("BOM", &bom),
        ("array", "[]"),
        ("primitive", "42"),
        ("null", "null"),
        ("hooks not an object", r#"{ "hooks": [] }"#),
        ("event not an array", r#"{ "hooks": { "Stop": {} } }"#),
    ];
    for (name, text) in cases {
        assert_eq!(
            plan_install(Some(text), &opts()),
            Err(InvalidJson),
            "{name}"
        );
    }
}

#[test]
fn diff_lists_added_lines_and_keeps_context_lines_as_same() {
    let result = ok(plan_install(Some(r#"{ "theme": "dark" }"#), &opts()));
    assert!(result
        .diff
        .iter()
        .any(|l| l.kind == DiffKind::Add && l.text.contains("x-notch-hook")));
    assert!(result
        .diff
        .iter()
        .any(|l| l.kind == DiffKind::Remove && l.text.contains("theme")));
    let fresh = ok(plan_install(None, &opts())).next;
    let same = ok(plan_install(Some(&fresh), &opts())).diff;
    assert!(same.iter().all(|l| l.kind == DiffKind::Same));
}

#[test]
fn diff_reports_removed_lines_when_the_token_is_replaced() {
    let first = ok(plan_install(Some(&fixture_text()), &opts())).next;
    let diff = ok(plan_install(Some(&first), &opts_with(47600, "tok-2"))).diff;
    assert!(diff
        .iter()
        .any(|l| l.kind == DiffKind::Remove && l.text.contains("tok-1")));
    assert!(diff
        .iter()
        .any(|l| l.kind == DiffKind::Add && l.text.contains("tok-2")));
}

// --- planUninstall -----------------------------------------------------------

#[test]
fn uninstall_removes_only_our_groups() {
    let installed = ok(plan_install(Some(&fixture_text()), &opts())).next;
    let mut edited = parse(&installed);
    edited["theme"] = json!("light");
    let result = parse(&ok(plan_uninstall(&pretty(&edited), None)).next);
    assert_eq!(result["theme"], "light");
    for event in FOREIGN_EVENTS {
        assert_eq!(result["hooks"][event], json!([coucou_group(event)]));
    }
    assert!(!stringify(&result).contains("x-notch-hook"));
    // Events that only existed because of us are gone.
    assert!(result["hooks"].get("PermissionDenied").is_none());
}

#[test]
fn drops_the_hooks_key_when_we_created_it_and_it_ends_up_empty() {
    let installed = ok(plan_install(Some(r#"{ "theme": "dark" }"#), &opts())).next;
    assert_eq!(
        parse(&ok(plan_uninstall(&installed, None)).next),
        json!({ "theme": "dark" })
    );
}

#[test]
fn returns_the_stored_original_text_byte_for_byte_when_nothing_else_changed() {
    let original = "{\r\n\t\"theme\":\"dark\",\r\n\t\"hooks\": {}\r\n}";
    let installed = ok(plan_install(Some(original), &opts())).next;
    assert_eq!(
        ok(plan_uninstall(&installed, Some(original))).next,
        original
    );
}

#[test]
fn keeps_an_empty_hooks_object_that_existed_in_the_original() {
    let installed = ok(plan_install(Some(r#"{ "hooks": {} }"#), &opts())).next;
    let next = ok(plan_uninstall(
        &installed,
        Some(r#"{ "hooks": { "Stop": [] } }"#),
    ))
    .next;
    assert_eq!(parse(&next), json!({ "hooks": { "Stop": [] } }));
}

#[test]
fn does_not_restore_the_original_when_other_changes_happened_meanwhile() {
    let original = fixture_text();
    let mut installed = parse(&ok(plan_install(Some(&original), &opts())).next);
    installed["theme"] = json!("light");
    let next = ok(plan_uninstall(
        &stringify_pretty(&installed),
        Some(&original),
    ))
    .next;
    assert_eq!(parse(&next)["theme"], "light");
    assert_ne!(next, original);
}

#[test]
fn leaves_the_text_unchanged_when_nothing_of_ours_is_present() {
    let Plan { next, diff } = ok(plan_uninstall(&fixture_text(), None));
    assert_eq!(next, fixture_text());
    assert!(diff.iter().all(|l| l.kind == DiffKind::Same));
}

#[test]
fn uninstall_rejects_invalid_json() {
    assert_eq!(plan_uninstall("{ nope", None), Err(InvalidJson));
    let bom = format!("\u{feff}{}", fixture_text());
    assert_eq!(plan_uninstall(&bom, None), Err(InvalidJson));
}

// --- hookStatus --------------------------------------------------------------

#[test]
fn is_missing_without_our_groups_for_a_missing_file_and_for_garbage() {
    assert_eq!(hook_status(None, &opts()), HookStatus::Missing);
    assert_eq!(
        hook_status(Some(&fixture_text()), &opts()),
        HookStatus::Missing
    );
    assert_eq!(hook_status(Some("{ nope"), &opts()), HookStatus::Missing);
}

#[test]
fn is_installed_after_install_with_the_same_port_and_token() {
    let installed = ok(plan_install(Some(&fixture_text()), &opts())).next;
    assert_eq!(
        hook_status(Some(&installed), &opts()),
        HookStatus::Installed
    );
}

#[test]
fn is_outdated_for_a_different_token_or_port() {
    let installed = ok(plan_install(Some(&fixture_text()), &opts())).next;
    assert_eq!(
        hook_status(Some(&installed), &opts_with(47600, "other")),
        HookStatus::Outdated
    );
    assert_eq!(
        hook_status(Some(&installed), &opts_with(1234, "tok-1")),
        HookStatus::Outdated
    );
}

#[test]
fn is_outdated_when_an_event_is_missing_or_a_timeout_differs() {
    let installed = parse(&ok(plan_install(Some(&fixture_text()), &opts())).next);
    let mut without_stop = installed.clone();
    groups_mut(&mut without_stop, "Stop").retain(|group| !is_ours(group));
    assert_eq!(
        hook_status(Some(&stringify(&without_stop)), &opts()),
        HookStatus::Outdated
    );

    let mut bad_timeout = installed.clone();
    let group = groups_mut(&mut bad_timeout, "PermissionRequest")
        .iter_mut()
        .find(|group| is_ours(group))
        .unwrap();
    group["hooks"][0]["timeout"] = json!(2);
    assert_eq!(
        hook_status(Some(&stringify(&bad_timeout)), &opts()),
        HookStatus::Outdated
    );
}

#[test]
fn is_outdated_when_the_ask_user_question_group_is_missing_changed_or_duplicated() {
    let installed = parse(&ok(plan_install(Some(&fixture_text()), &opts())).next);
    let status = |value: &Value| hook_status(Some(&stringify(value)), &opts());
    fn question(value: &mut Value) -> &mut Value {
        groups_mut(value, "PreToolUse")
            .iter_mut()
            .find(|group| is_question(group))
            .unwrap()
    }

    let mut without = installed.clone();
    groups_mut(&mut without, "PreToolUse").retain(|group| !is_question(group));
    assert_eq!(status(&without), HookStatus::Outdated);

    let mut short_timeout = installed.clone();
    question(&mut short_timeout)["hooks"][0]["timeout"] = json!(2);
    assert_eq!(status(&short_timeout), HookStatus::Outdated);

    let mut wrong_url = installed.clone();
    question(&mut wrong_url)["hooks"][0]["url"] = json!("http://127.0.0.1:47600/hook");
    assert_eq!(status(&wrong_url), HookStatus::Outdated);

    let mut twice = installed.clone();
    let copy = question(&mut twice).clone();
    groups_mut(&mut twice, "PreToolUse").push(copy);
    assert_eq!(status(&twice), HookStatus::Outdated);
}

#[test]
fn a_foreign_ask_user_question_group_is_not_ours_and_is_kept_on_install_and_uninstall() {
    let foreign = json!({ "matcher": "AskUserQuestion", "hooks": [{ "type": "command", "command": "other-app ask" }] });
    let mut settings = fixture_object();
    groups_mut(&mut settings, "PreToolUse").push(foreign.clone());
    let text = pretty(&settings);
    let installed = ok(plan_install(Some(&text), &opts())).next;
    assert_eq!(
        hook_status(Some(&installed), &opts()),
        HookStatus::Installed
    );
    assert_eq!(
        groups(&parse(&installed), "PreToolUse")[..2],
        [coucou_group("PreToolUse"), foreign.clone()]
    );
    let removed = parse(&ok(plan_uninstall(&installed, None)).next);
    assert_eq!(
        removed["hooks"]["PreToolUse"],
        json!([coucou_group("PreToolUse"), foreign])
    );
}

// --- Rust-only planning checks -------------------------------------------------

#[test]
fn mixed_groups_are_foreign() {
    // A group holding one of our hooks next to someone else's is never touched or counted.
    let mixed = json!({ "hooks": [
        { "type": "http", "url": "http://127.0.0.1:1/hook", "headers": { "x-notch-token": "old", "x-notch-hook": "1" }, "timeout": 2 },
        { "type": "command", "command": "other" },
    ] });
    let text = pretty(&json!({ "hooks": { "Stop": [mixed.clone()] } }));
    assert_eq!(hook_status(Some(&text), &opts()), HookStatus::Missing);
    let installed = parse(&ok(plan_install(Some(&text), &opts())).next);
    let stop = groups(&installed, "Stop");
    assert_eq!(stop.len(), 2);
    assert_eq!(stop[0], mixed);
    assert!(is_ours(&stop[1]));
    let removed = ok(plan_uninstall(&pretty(&installed), None)).next;
    assert_eq!(parse(&removed), json!({ "hooks": { "Stop": [mixed] } }));
    // An empty `hooks` array is not ours either.
    let empty = pretty(&json!({ "hooks": { "Stop": [{ "hooks": [] }] } }));
    assert_eq!(hook_status(Some(&empty), &opts()), HookStatus::Missing);
}

#[test]
fn uninstall_restores_key_order_and_js_number_equality() {
    // `shift_remove` keeps the other keys in place; `1.0` equals `1` as in `isDeepStrictEqual`.
    let original = "{\"a\": 1.0, \"hooks\": {\"Stop\": [{\"hooks\": []}]}, \"z\": [1e2]}";
    let installed = ok(plan_install(Some(original), &opts())).next;
    assert!(installed.starts_with("{\n  \"a\": 1,\n  \"hooks\": {"));
    assert_eq!(
        ok(plan_uninstall(&installed, Some(original))).next,
        original
    );
    // Without the original, the re-serialized file keeps the key order.
    let next = ok(plan_uninstall(&installed, None)).next;
    assert_eq!(keys(&parse(&next)), ["a", "hooks", "z"]);
}

#[test]
fn negative_zero_is_not_deep_strict_equal_to_zero() {
    // isDeepStrictEqual(-0, 0) is false, so the original text is not restored verbatim.
    let original = "{\"a\": -0}";
    let installed = ok(plan_install(Some("{\"a\": 0}"), &opts())).next;
    assert_ne!(
        ok(plan_uninstall(&installed, Some(original))).next,
        original
    );
}

#[test]
fn diff_lines_trims_common_ends_and_prefers_add_on_ties() {
    let lines = |diff: Vec<DiffLine>| -> Vec<String> {
        diff.into_iter()
            .map(|l| {
                let mark = match l.kind {
                    DiffKind::Add => '+',
                    DiffKind::Remove => '-',
                    DiffKind::Same => ' ',
                };
                format!("{mark}{}", l.text)
            })
            .collect()
    };
    assert_eq!(
        lines(diff_lines("a\nb\nc\n", "a\nx\nc\n")),
        [" a", "+x", "-b", " c"]
    );
    assert_eq!(lines(diff_lines("", "")), Vec::<String>::new());
    assert_eq!(lines(diff_lines("a\r\nb", "a\nb\n")), [" a", " b"]);
    assert_eq!(
        lines(diff_lines("a\nb\nc\nd", "a\nc\nb\nd")),
        [" a", "+c", " b", "-c", " d"]
    );
    // Only one trailing empty line is dropped.
    assert_eq!(lines(diff_lines("a\n\n", "a\n")), [" a", "-"]);
}

#[test]
fn mask_diff_hides_the_token_field_and_every_token_occurrence() {
    let diff = vec![
        DiffLine {
            kind: DiffKind::Add,
            text: "        \"x-notch-token\": \"secret-1\",".into(),
        },
        DiffLine {
            kind: DiffKind::Remove,
            text: "\"x-notch-token\" :\u{a0}\"\" and \"x-notch-token\":\"b\" plus secret-1".into(),
        },
        DiffLine {
            kind: DiffKind::Same,
            text: "\"x-notch-token\": \"unterminated".into(),
        },
    ];
    let masked = mask_diff(&diff, Some("secret-1"));
    assert_eq!(masked[0].text, "        \"x-notch-token\": \"••••••\",");
    assert_eq!(masked[0].kind, DiffKind::Add);
    assert_eq!(
        masked[1].text,
        "\"x-notch-token\" :\u{a0}\"••••••\" and \"x-notch-token\":\"••••••\" plus ••••••"
    );
    assert_eq!(masked[2].text, "\"x-notch-token\": \"unterminated");
    // No config: only the field is masked.
    assert_eq!(
        mask_diff(&diff[1..2], None)[0].text,
        "\"x-notch-token\" :\u{a0}\"••••••\" and \"x-notch-token\":\"••••••\" plus secret-1"
    );
}

#[cfg(windows)]
#[test]
fn strips_verbatim_prefixes() {
    assert_eq!(
        strip_verbatim(PathBuf::from(r"\\?\C:\Users\x\settings.json")),
        PathBuf::from(r"C:\Users\x\settings.json")
    );
    assert_eq!(
        strip_verbatim(PathBuf::from(r"\\?\UNC\server\share\settings.json")),
        PathBuf::from(r"\\server\share\settings.json")
    );
    assert_eq!(
        strip_verbatim(PathBuf::from(r"C:\plain.json")),
        PathBuf::from(r"C:\plain.json")
    );
}

#[test]
fn resolve_real_path_returns_plain_paths_and_the_path_itself_when_missing() {
    let dir = TestDir::new("hook-realpath");
    let missing = dir.join("nope").join("settings.json");
    assert_eq!(resolve_real_path(&missing).unwrap(), missing);
    let file = dir.join("settings.json");
    std::fs::write(&file, "{}").unwrap();
    let real = resolve_real_path(&file).unwrap();
    assert!(!real.to_string_lossy().starts_with(r"\\?\"));
    assert!(real.is_absolute());
    assert_eq!(std::fs::read_to_string(real).unwrap(), "{}");
}

// --- HookInstaller -----------------------------------------------------------

struct Fixture {
    dir: TestDir,
    file: PathBuf,
    backup_dir: PathBuf,
}

/// `new Date(2026, 10, 10, 9, 5, 7)`: local time.
fn fixed_now() -> DateTime<Utc> {
    Local
        .with_ymd_and_hms(2026, 11, 10, 9, 5, 7)
        .single()
        .unwrap()
        .with_timezone(&Utc)
}

impl Fixture {
    fn new() -> Self {
        let dir = TestDir::new("hook-installer");
        let file = dir.path().join(".claude").join("settings.json");
        let backup_dir = dir.path().join("backups");
        Self {
            dir,
            file,
            backup_dir,
        }
    }

    fn make(&self) -> HookInstaller {
        HookInstaller::new(self.file.clone(), self.backup_dir.clone(), fixed_now)
    }

    async fn seed(&self, text: &str) {
        write_atomic(&self.file, text.as_bytes()).await.unwrap();
    }

    fn read(&self, path: &Path) -> String {
        std::fs::read_to_string(path).unwrap()
    }

    fn settings(&self) -> String {
        self.read(&self.file)
    }

    fn backups(&self) -> Vec<String> {
        names(&self.backup_dir)
    }
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn written(result: io::Result<HookWriteResult>) -> WriteOutcome {
    result.unwrap().expect("expected ok, got invalid-json")
}

#[tokio::test]
async fn creates_the_file_and_the_claude_dir_when_missing_with_no_backup() {
    let fx = Fixture::new();
    let installer = fx.make();
    let result = written(installer.install(&opts()).await);
    assert!(result.changed);
    assert_eq!(result.backup_file, None);
    assert_eq!(keys(&parse(&fx.settings())), ["hooks"]);
    assert_eq!(fx.backups(), ["notch-hooks.original.json"]);
    assert_eq!(
        fx.read(&fx.backup_dir.join("notch-hooks.original.json")),
        "{}\n"
    );
    assert_eq!(
        installer.status(&opts()).await.unwrap(),
        HookStatus::Installed
    );
}

#[tokio::test]
async fn backs_up_the_previous_text_before_writing_named_by_timestamp() {
    let fx = Fixture::new();
    let original = fixture_text();
    fx.seed(&original).await;
    let result = written(fx.make().install(&opts()).await);
    let backup = fx.backup_dir.join("settings.backup-20261110-090507.json");
    assert!(fx
        .backups()
        .contains(&"settings.backup-20261110-090507.json".to_string()));
    assert_eq!(result.backup_file, Some(backup.clone()));
    assert_eq!(fx.read(&backup), original);
    assert_ne!(fx.settings(), original);
}

#[tokio::test]
async fn uninstall_right_after_install_restores_the_exact_original_bytes() {
    let fx = Fixture::new();
    let original = "{\r\n\t\"theme\":\"dark\",\r\n\t\"hooks\":{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"x\"}]}]}\r\n}";
    fx.seed(original).await;
    let installer = fx.make();
    written(installer.install(&opts()).await);
    assert_eq!(
        installer.status(&opts()).await.unwrap(),
        HookStatus::Installed
    );
    let result = written(installer.uninstall().await);
    assert!(result.changed);
    assert_eq!(fx.settings(), original);
    assert_eq!(
        installer.status(&opts()).await.unwrap(),
        HookStatus::Missing
    );
}

#[tokio::test]
async fn uninstall_after_other_edits_removes_only_our_groups() {
    let fx = Fixture::new();
    fx.seed(&fixture_text()).await;
    let installer = fx.make();
    written(installer.install(&opts()).await);
    let mut edited = parse(&fx.settings());
    edited["theme"] = json!("light");
    std::fs::write(&fx.file, stringify_pretty(&edited)).unwrap();
    written(installer.uninstall().await);
    let result = parse(&fx.settings());
    assert_eq!(result["theme"], "light");
    assert!(!stringify(&result).contains("x-notch-hook"));
    assert_eq!(result["hooks"]["Stop"], json!([coucou_group("Stop")]));
}

#[tokio::test]
async fn does_not_overwrite_the_stored_original_when_reinstalling() {
    let fx = Fixture::new();
    let original = fixture_text();
    fx.seed(&original).await;
    let installer = fx.make();
    written(installer.install(&opts()).await);
    written(installer.install(&opts_with(47600, "tok-2")).await);
    written(installer.uninstall().await);
    assert_eq!(fx.settings(), original);
}

#[tokio::test]
async fn refuses_invalid_json_and_writes_nothing() {
    let fx = Fixture::new();
    fx.seed("{ nope").await;
    let installer = fx.make();
    assert_eq!(installer.install(&opts()).await.unwrap(), Err(InvalidJson));
    assert_eq!(installer.uninstall().await.unwrap(), Err(InvalidJson));
    assert_eq!(fx.settings(), "{ nope");
    assert!(std::fs::read_dir(&fx.backup_dir).is_err());
}

#[tokio::test]
async fn refuses_a_bom_file_and_writes_nothing() {
    let fx = Fixture::new();
    let text = format!("\u{feff}{}", fixture_text());
    fx.seed(&text).await;
    assert_eq!(fx.make().install(&opts()).await.unwrap(), Err(InvalidJson));
    assert_eq!(fx.settings(), text);
}

#[tokio::test]
async fn preview_returns_the_diff_without_touching_disk() {
    let fx = Fixture::new();
    fx.seed(&fixture_text()).await;
    let preview = fx.make().preview(&opts()).await.unwrap();
    assert!(preview
        .unwrap()
        .diff
        .iter()
        .any(|l| l.kind == DiffKind::Add));
    assert_eq!(fx.settings(), fixture_text());
    assert!(std::fs::read_dir(&fx.backup_dir).is_err());
}

#[tokio::test]
async fn uninstall_with_nothing_installed_writes_nothing() {
    let fx = Fixture::new();
    fx.seed(&fixture_text()).await;
    let result = written(fx.make().uninstall().await);
    assert!(!result.changed);
    assert!(std::fs::read_dir(&fx.backup_dir).is_err());
}

#[tokio::test]
async fn writes_through_a_symlinked_settings_json_to_the_real_file_instead_of_replacing_the_link() {
    let fx = Fixture::new();
    let real_dir = fx.dir.path().join("dotfiles");
    let real = real_dir.join("claude-settings.json");
    std::fs::create_dir_all(&real_dir).unwrap();
    std::fs::write(&real, fixture_text()).unwrap();
    std::fs::create_dir_all(fx.file.parent().unwrap()).unwrap();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(&real, &fx.file);
    #[cfg(not(windows))]
    let linked = std::os::unix::fs::symlink(&real, &fx.file);
    if linked.is_err() {
        // Creating symlinks on Windows needs Developer Mode or admin; the injected resolver test
        // below covers the logic.
        eprintln!("skipped: cannot create a symlink here");
        return;
    }
    written(fx.make().install(&opts()).await);
    assert!(std::fs::symlink_metadata(&fx.file)
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(fx.read(&real).contains("x-notch-hook"));
}

#[tokio::test]
async fn resolves_the_settings_path_before_reading_and_writing_injected_realpath() {
    let fx = Fixture::new();
    let real = fx.dir.path().join("elsewhere").join("settings.json");
    write_atomic(&real, fixture_text().as_bytes())
        .await
        .unwrap();
    let file = fx.file.clone();
    let target = real.clone();
    let installer = fx.make().with_realpath(move |path: &Path| {
        Ok(if path == file {
            target.clone()
        } else {
            path.to_path_buf()
        })
    });
    written(installer.install(&opts()).await);
    assert!(fx.read(&real).contains("x-notch-hook"));
    assert_eq!(read_text_opt(&fx.file).await.unwrap(), None);
    assert_eq!(
        installer.status(&opts()).await.unwrap(),
        HookStatus::Installed
    );
    written(installer.uninstall().await);
    assert_eq!(fx.read(&real), fixture_text());
}

#[tokio::test]
async fn names_backups_uniquely_within_the_same_second() {
    let fx = Fixture::new();
    fx.seed(&fixture_text()).await;
    let installer = fx.make();
    written(installer.install(&opts()).await);
    written(installer.install(&opts_with(47600, "tok-2")).await);
    written(installer.install(&opts_with(47600, "tok-3")).await);
    let backups: Vec<String> = fx
        .backups()
        .into_iter()
        .filter(|name| name.starts_with("settings.backup-"))
        .collect();
    assert_eq!(
        backups,
        [
            "settings.backup-20261110-090507-2.json",
            "settings.backup-20261110-090507-3.json",
            "settings.backup-20261110-090507.json",
        ]
    );
}

#[tokio::test]
async fn keeps_only_the_10_newest_backups() {
    let fx = Fixture::new();
    std::fs::create_dir_all(&fx.backup_dir).unwrap();
    for day in 1..=12 {
        std::fs::write(
            fx.backup_dir
                .join(format!("settings.backup-202611{day:02}-080000.json")),
            "{}",
        )
        .unwrap();
    }
    std::fs::write(
        fx.backup_dir.join("settings.backup-20261109-080000-2.json"),
        "{}",
    )
    .unwrap();
    std::fs::write(fx.backup_dir.join("unrelated.txt"), "keep me").unwrap();
    fx.seed(&fixture_text()).await;
    written(fx.make().install(&opts()).await);
    let files = fx.backups();
    let backups: Vec<&String> = files
        .iter()
        .filter(|name| name.starts_with("settings.backup-"))
        .collect();
    assert_eq!(backups.len(), 10);
    let has = |name: &str| files.iter().any(|file| file == name);
    // Newest first by timestamp then suffix: the 12th, the new 10th-09:05:07 one, 11th, 10th, ...
    assert!(has("settings.backup-20261110-090507.json"));
    assert!(has("settings.backup-20261112-080000.json"));
    assert!(has("settings.backup-20261109-080000-2.json"));
    assert!(!has("settings.backup-20261101-080000.json"));
    assert!(!has("settings.backup-20261104-080000.json"));
    assert!(has("settings.backup-20261105-080000.json"));
    assert!(has("unrelated.txt"));
    assert!(has("notch-hooks.original.json"));
}

#[tokio::test]
async fn leaves_no_temp_files_next_to_the_settings_file() {
    let fx = Fixture::new();
    fx.seed(&fixture_text()).await;
    written(fx.make().install(&opts()).await);
    assert_eq!(names(fx.file.parent().unwrap()), ["settings.json"]);
}

// --- Rust-only installer checks ----------------------------------------------

#[tokio::test]
async fn bom_is_refused_untouched() {
    let fx = Fixture::new();
    let text = format!("\u{feff}{}", ok(plan_install(None, &opts())).next);
    fx.seed(&text).await;
    let installer = fx.make();
    assert_eq!(installer.preview(&opts()).await.unwrap(), Err(InvalidJson));
    assert_eq!(installer.install(&opts()).await.unwrap(), Err(InvalidJson));
    assert_eq!(installer.uninstall().await.unwrap(), Err(InvalidJson));
    assert_eq!(
        installer.status(&opts()).await.unwrap(),
        HookStatus::Missing
    );
    assert_eq!(std::fs::read(&fx.file).unwrap(), text.as_bytes());
    assert!(std::fs::read_dir(&fx.backup_dir).is_err());
}

#[tokio::test]
async fn crlf_is_preserved() {
    let fx = Fixture::new();
    let original = fixture_text().replace('\n', "\r\n");
    fx.seed(&original).await;
    let installer = fx.make();
    written(installer.install(&opts()).await);
    let installed = fx.settings();
    assert!(installed.ends_with("}\r\n"));
    assert!(!installed.replace("\r\n", "").contains('\n'));
    // Another edit, so uninstall re-serializes instead of restoring the original text.
    let edited = installed.replace("\"dark\"", "\"light\"");
    std::fs::write(&fx.file, &edited).unwrap();
    written(installer.uninstall().await);
    let uninstalled = fx.settings();
    assert_eq!(uninstalled, original.replace("\"dark\"", "\"light\""));
}

#[tokio::test]
async fn uninstall_restores_original_bytes() {
    let fx = Fixture::new();
    // Odd formatting, no trailing newline, non-ASCII, an index-like key and `1.0`.
    let original = "{\"b\":1.0,  \"2\": \"é😀\",\n\"hooks\":{ }}";
    fx.seed(original).await;
    let installer = fx.make();
    written(installer.install(&opts()).await);
    written(installer.install(&opts_with(47601, "tok-2")).await);
    assert_eq!(
        hook_status(Some(&fx.settings()), &opts_with(47601, "tok-2")),
        HookStatus::Installed
    );
    let result = written(installer.uninstall().await);
    assert!(result.changed);
    assert!(result.backup_file.is_some());
    assert_eq!(std::fs::read(&fx.file).unwrap(), original.as_bytes());
    // The stored original stays for the next round.
    assert_eq!(
        fx.read(&fx.backup_dir.join("notch-hooks.original.json")),
        original
    );
    // A second uninstall finds nothing of ours.
    assert!(!written(installer.uninstall().await).changed);
}

#[tokio::test]
async fn invalid_utf8_is_an_error_and_untouched() {
    let fx = Fixture::new();
    let bytes = b"{\"theme\": \"\xff\"}".to_vec();
    std::fs::create_dir_all(fx.file.parent().unwrap()).unwrap();
    std::fs::write(&fx.file, &bytes).unwrap();
    let installer = fx.make();
    assert!(installer.preview(&opts()).await.is_err());
    assert!(installer.install(&opts()).await.is_err());
    assert!(installer.uninstall().await.is_err());
    assert!(installer.status(&opts()).await.is_err());
    assert_eq!(std::fs::read(&fx.file).unwrap(), bytes);
    assert!(std::fs::read_dir(&fx.backup_dir).is_err());
}

#[tokio::test]
async fn unchanged_install_writes_nothing() {
    let fx = Fixture::new();
    let installer = fx.make();
    written(installer.install(&opts()).await);
    let before = fx.backups();
    let again = written(installer.install(&opts()).await);
    assert!(!again.changed);
    assert!(again.diff.iter().all(|l| l.kind == DiffKind::Same));
    assert_eq!(fx.backups(), before);
}

#[test]
fn installer_is_shareable() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<HookInstaller>();
    let _: Arc<HookInstaller> = Arc::new(HookInstaller::new(
        PathBuf::from("x"),
        PathBuf::from("y"),
        Utc::now,
    ));
}

#[test]
fn matches_electron_byte_for_byte() {
    // Expected values generated by running the TS planInstall/planUninstall on the same input
    // (0.3.0), then extended by hand with the account header and the SessionStart group.
    let input = "{\"2\":\"x\",\"b\":1.0,\"hooks\":{\"Stop\":[{\"hooks\":[]}],\"1\":[],\"PreToolUse\":[{\"hooks\":[{\"type\":\"http\",\"headers\":{\"x-notch-hook\":\"1\"}}]}]},\"n\":1e21,\"s\":\"\\u2028/\u{e9}\"}\r\n";
    let installed = "{\r\n  \"2\": \"x\",\r\n  \"b\": 1,\r\n  \"hooks\": {\r\n    \"1\": [],\r\n    \"Stop\": [\r\n      {\r\n        \"hooks\": []\r\n      },\r\n      {\r\n        \"hooks\": [\r\n          {\r\n            \"type\": \"http\",\r\n            \"url\": \"http://127.0.0.1:5/hook\",\r\n            \"headers\": {\r\n              \"x-notch-token\": \"t\",\r\n              \"x-notch-hook\": \"1\",\r\n              \"x-notch-account\": \"claude\"\r\n            },\r\n            \"timeout\": 2\r\n          }\r\n        ]\r\n      }\r\n    ],\r\n    \"UserPromptSubmit\": [\r\n      {\r\n        \"hooks\": [\r\n          {\r\n            \"type\": \"http\",\r\n            \"url\": \"http://127.0.0.1:5/hook\",\r\n            \"headers\": {\r\n              \"x-notch-token\": \"t\",\r\n              \"x-notch-hook\": \"1\",\r\n              \"x-notch-account\": \"claude\"\r\n            },\r\n            \"timeout\": 2\r\n          }\r\n        ]\r\n      }\r\n    ],\r\n    \"PreToolUse\": [\r\n      {\r\n        \"hooks\": [\r\n          {\r\n            \"type\": \"http\",\r\n            \"url\": \"http://127.0.0.1:5/hook\",\r\n            \"headers\": {\r\n              \"x-notch-token\": \"t\",\r\n              \"x-notch-hook\": \"1\",\r\n              \"x-notch-account\": \"claude\"\r\n            },\r\n            \"timeout\": 2\r\n          }\r\n        ]\r\n      },\r\n      {\r\n        \"matcher\": \"AskUserQuestion\",\r\n        \"hooks\": [\r\n          {\r\n            \"type\": \"http\",\r\n            \"url\": \"http://127.0.0.1:5/hook/question\",\r\n            \"headers\": {\r\n              \"x-notch-token\": \"t\",\r\n              \"x-notch-hook\": \"1\",\r\n              \"x-notch-account\": \"claude\"\r\n            },\r\n            \"timeout\": 3600\r\n          }\r\n        ]\r\n      }\r\n    ],\r\n    \"PostToolUse\": [\r\n      {\r\n        \"hooks\": [\r\n          {\r\n            \"type\": \"http\",\r\n            \"url\": \"http://127.0.0.1:5/hook\",\r\n            \"headers\": {\r\n              \"x-notch-token\": \"t\",\r\n              \"x-notch-hook\": \"1\",\r\n              \"x-notch-account\": \"claude\"\r\n            },\r\n            \"timeout\": 2\r\n          }\r\n        ]\r\n      }\r\n    ],\r\n    \"PostToolUseFailure\": [\r\n      {\r\n        \"hooks\": [\r\n          {\r\n            \"type\": \"http\",\r\n            \"url\": \"http://127.0.0.1:5/hook\",\r\n            \"headers\": {\r\n              \"x-notch-token\": \"t\",\r\n              \"x-notch-hook\": \"1\",\r\n              \"x-notch-account\": \"claude\"\r\n            },\r\n            \"timeout\": 2\r\n          }\r\n        ]\r\n      }\r\n    ],\r\n    \"PermissionRequest\": [\r\n      {\r\n        \"hooks\": [\r\n          {\r\n            \"type\": \"http\",\r\n            \"url\": \"http://127.0.0.1:5/hook\",\r\n            \"headers\": {\r\n              \"x-notch-token\": \"t\",\r\n              \"x-notch-hook\": \"1\",\r\n              \"x-notch-account\": \"claude\"\r\n            },\r\n            \"timeout\": 3600\r\n          }\r\n        ]\r\n      }\r\n    ],\r\n    \"PermissionDenied\": [\r\n      {\r\n        \"hooks\": [\r\n          {\r\n            \"type\": \"http\",\r\n            \"url\": \"http://127.0.0.1:5/hook\",\r\n            \"headers\": {\r\n              \"x-notch-token\": \"t\",\r\n              \"x-notch-hook\": \"1\",\r\n              \"x-notch-account\": \"claude\"\r\n            },\r\n            \"timeout\": 2\r\n          }\r\n        ]\r\n      }\r\n    ],\r\n    \"Notification\": [\r\n      {\r\n        \"hooks\": [\r\n          {\r\n            \"type\": \"http\",\r\n            \"url\": \"http://127.0.0.1:5/hook\",\r\n            \"headers\": {\r\n              \"x-notch-token\": \"t\",\r\n              \"x-notch-hook\": \"1\",\r\n              \"x-notch-account\": \"claude\"\r\n            },\r\n            \"timeout\": 2\r\n          }\r\n        ]\r\n      }\r\n    ],\r\n    \"StopFailure\": [\r\n      {\r\n        \"hooks\": [\r\n          {\r\n            \"type\": \"http\",\r\n            \"url\": \"http://127.0.0.1:5/hook\",\r\n            \"headers\": {\r\n              \"x-notch-token\": \"t\",\r\n              \"x-notch-hook\": \"1\",\r\n              \"x-notch-account\": \"claude\"\r\n            },\r\n            \"timeout\": 2\r\n          }\r\n        ]\r\n      }\r\n    ],\r\n    \"SubagentStart\": [\r\n      {\r\n        \"hooks\": [\r\n          {\r\n            \"type\": \"http\",\r\n            \"url\": \"http://127.0.0.1:5/hook\",\r\n            \"headers\": {\r\n              \"x-notch-token\": \"t\",\r\n              \"x-notch-hook\": \"1\",\r\n              \"x-notch-account\": \"claude\"\r\n            },\r\n            \"timeout\": 2\r\n          }\r\n        ]\r\n      }\r\n    ],\r\n    \"SubagentStop\": [\r\n      {\r\n        \"hooks\": [\r\n          {\r\n            \"type\": \"http\",\r\n            \"url\": \"http://127.0.0.1:5/hook\",\r\n            \"headers\": {\r\n              \"x-notch-token\": \"t\",\r\n              \"x-notch-hook\": \"1\",\r\n              \"x-notch-account\": \"claude\"\r\n            },\r\n            \"timeout\": 2\r\n          }\r\n        ]\r\n      }\r\n    ],\r\n    \"SessionEnd\": [\r\n      {\r\n        \"hooks\": [\r\n          {\r\n            \"type\": \"http\",\r\n            \"url\": \"http://127.0.0.1:5/hook\",\r\n            \"headers\": {\r\n              \"x-notch-token\": \"t\",\r\n              \"x-notch-hook\": \"1\",\r\n              \"x-notch-account\": \"claude\"\r\n            },\r\n            \"timeout\": 2\r\n          }\r\n        ]\r\n      }\r\n    ],\r\n    \"SessionStart\": [\r\n      {\r\n        \"hooks\": [\r\n          {\r\n            \"type\": \"http\",\r\n            \"url\": \"http://127.0.0.1:5/hook\",\r\n            \"headers\": {\r\n              \"x-notch-token\": \"t\",\r\n              \"x-notch-hook\": \"1\",\r\n              \"x-notch-account\": \"claude\"\r\n            },\r\n            \"timeout\": 2\r\n          }\r\n        ]\r\n      }\r\n    ]\r\n  },\r\n  \"n\": 1e+21,\r\n  \"s\": \"\u{2028}/\u{e9}\"\r\n}\r\n";
    let kinds = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaar";
    let uninstalled = "{\r\n  \"2\": \"x\",\r\n  \"b\": 1,\r\n  \"hooks\": {\r\n    \"1\": [],\r\n    \"Stop\": [\r\n      {\r\n        \"hooks\": []\r\n      }\r\n    ]\r\n  },\r\n  \"n\": 1e+21,\r\n  \"s\": \"\u{2028}/\u{e9}\"\r\n}\r\n";
    let plan = ok(plan_install(Some(input), &opts_with(5, "t")));
    assert_eq!(plan.next, installed);
    let actual: String = plan.diff.iter().map(|l| &l.kind.as_str()[..1]).collect();
    assert_eq!(actual, kinds);
    assert_eq!(ok(plan_uninstall(installed, None)).next, uninstalled);
}

// --- Robustness (final review) -----------------------------------------------

/// Installs over the fixture, then replaces the stored original with whatever `spoil` leaves.
async fn uninstall_with_a_spoiled_original(spoil: impl FnOnce(&Path)) {
    let fx = Fixture::new();
    fx.seed(&fixture_text()).await;
    let installer = fx.make();
    written(installer.install(&opts()).await);
    let original = fx.backup_dir.join(ORIGINAL_FILE);
    std::fs::remove_file(&original).unwrap();
    spoil(&original);
    let result = written(installer.uninstall().await);
    assert!(result.changed);
    let after = parse(&fx.settings());
    assert!(!stringify(&after).contains("x-notch-hook"));
    // Only our groups went away: the foreign ones and the other keys are all still there.
    assert_eq!(after, parse(&fixture_text()));
    assert_eq!(
        installer.status(&opts()).await.unwrap(),
        HookStatus::Missing
    );
}

#[tokio::test]
async fn uninstall_still_removes_our_groups_when_the_stored_original_is_a_directory() {
    uninstall_with_a_spoiled_original(|original| std::fs::create_dir(original).unwrap()).await;
}

#[tokio::test]
async fn uninstall_still_removes_our_groups_when_the_stored_original_is_not_utf8() {
    uninstall_with_a_spoiled_original(|original| {
        std::fs::write(original, [0xff, 0xfe, b'{', 0x80, b'}']).unwrap();
    })
    .await;
}

#[tokio::test]
async fn a_failed_backup_prune_does_not_block_install_or_uninstall() {
    let fx = Fixture::new();
    fx.seed(&fixture_text()).await;
    // Old "backups" that cannot be deleted with remove_file: directories.
    let stuck: Vec<PathBuf> = (0..MAX_BACKUPS + 1)
        .map(|i| {
            fx.backup_dir
                .join(format!("settings.backup-20200101-0000{:02}.json", i))
        })
        .collect();
    for dir in &stuck {
        std::fs::create_dir_all(dir).unwrap();
    }
    let installer = fx.make();
    let result = written(installer.install(&opts()).await);
    assert!(result.changed);
    assert!(result.backup_file.is_some());
    assert_eq!(
        installer.status(&opts()).await.unwrap(),
        HookStatus::Installed
    );
    let result = written(installer.uninstall().await);
    assert!(result.changed);
    assert_eq!(fx.settings(), fixture_text());
    assert!(stuck.iter().all(|dir| dir.is_dir()));
}

#[test]
fn debug_output_never_shows_the_token() {
    let secret = "SECRET-TOKEN-VALUE";
    let options = opts_with(47600, secret);
    let shown = format!("{options:?}");
    assert!(
        shown.contains("47600") && shown.contains("••••••"),
        "{shown}"
    );
    assert!(!shown.contains(secret));
    let plan = ok(plan_install(None, &options));
    let shown = format!("{plan:?}");
    assert!(!shown.contains(secret), "{shown}");
}
