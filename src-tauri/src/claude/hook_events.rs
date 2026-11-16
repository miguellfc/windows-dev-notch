//! Claude Code hook payloads (port of `src/shared/claude/hook-events.ts`): the sanitised
//! [`HookEvent`] the service works with, and the permission response bodies.
//!
//! Lengths follow JS strings (UTF-16 code units): the preview is cut at [`PREVIEW_MAX_CHARS`]
//! units and `previewLength` is the UTF-16 length. Where JS `slice` would split a surrogate pair,
//! the whole pair is left out instead (a Rust string cannot hold the lone high surrogate), so a
//! cut preview may be one unit shorter than JS's; `previewTruncated`/`previewLength` are the same.

use serde::Serialize;
use serde_json::{Map, Value};

use super::js_json;
use super::questions::{parse_ask_user_question, AskUserQuestionInput};
use crate::contract::claude::Decision;
use crate::contract::string_enum;
use crate::contract::text::{is_format, is_js_whitespace, utf16_len, utf16_prefix};

string_enum! {
    /// `HookEventName`.
    pub enum HookEventName {
        UserPromptSubmit = "UserPromptSubmit",
        PreToolUse = "PreToolUse",
        PostToolUse = "PostToolUse",
        PostToolUseFailure = "PostToolUseFailure",
        PermissionRequest = "PermissionRequest",
        PermissionDenied = "PermissionDenied",
        Notification = "Notification",
        Stop = "Stop",
        StopFailure = "StopFailure",
        SubagentStart = "SubagentStart",
        SubagentStop = "SubagentStop",
        SessionEnd = "SessionEnd",
    }
}

/// `HOOK_EVENT_NAMES`, in the order the installer writes them.
pub const HOOK_EVENT_NAMES: &[HookEventName] = HookEventName::ALL;

impl HookEventName {
    /// The event named `name`, if it is one of ours.
    pub fn from_name(name: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|event| event.as_str() == name)
    }

    /// Events that carry the identity of one tool call (`tool_use_id`).
    fn is_tool_call(self) -> bool {
        matches!(
            self,
            Self::PreToolUse
                | Self::PostToolUse
                | Self::PostToolUseFailure
                | Self::PermissionDenied
        )
    }
}

pub const ASK_USER_QUESTION_TOOL: &str = "AskUserQuestion";
/// Longest preview, in UTF-16 code units.
pub const PREVIEW_MAX_CHARS: usize = 2_000;
/// Longest tool name, in UTF-16 code units.
pub const TOOL_NAME_MAX_CHARS: usize = 64;

/// The permission preview: the sanitised text, cut at [`PREVIEW_MAX_CHARS`].
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub preview: String,
    /// The sanitised preview was longer than [`PREVIEW_MAX_CHARS`] and was cut.
    pub preview_truncated: bool,
    /// UTF-16 length of the whole sanitised preview, before the cut.
    pub preview_length: usize,
}

/// Sanitised view of a Claude Code hook payload. It carries no prompt, message, tool_response or
/// last_assistant_message; `preview` exists only for PermissionRequest and the AskUserQuestion
/// fields only for its PreToolUse. None of it may be logged. Serializes as the TS object would.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HookEvent {
    pub name: HookEventName,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// Identity of one tool call (PreToolUse, PostToolUse, PostToolUseFailure, PermissionDenied).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    /// Set when the event comes from a subagent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notification_type: Option<String>,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub preview: Option<Preview>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Only for a PreToolUse of AskUserQuestion: `Some(None)` when its input does not fit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask_user_question: Option<Option<AskUserQuestionInput>>,
    /// Only with a valid `ask_user_question`: the `tool_input` exactly as received (key order
    /// kept), echoed back to Claude.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ask_user_question_raw: Option<Map<String, Value>>,
}

/// C0/C1 controls except `\t` and `\n`: `[\u0000-\u0008\u000b-\u001f\u007f-\u009f]`.
pub(crate) fn is_hidden_control(character: char) -> bool {
    matches!(character, '\u{0}'..='\u{8}' | '\u{b}'..='\u{1f}' | '\u{7f}'..='\u{9f}')
}

/// `sanitizeText`: display-safe text, without controls or format characters, and without
/// padding that could hide the payload.
pub fn sanitize_text(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .filter_map(|character| match character {
            '\u{2028}' | '\u{2029}' => Some('\n'),
            hidden if is_hidden_control(hidden) || is_format(hidden) => None,
            kept => Some(kept),
        })
        .collect();
    let cleaned = collapse_long_blank_runs(&cleaned);
    let mut out: Vec<&str> = Vec::new();
    let mut blanks: Vec<&str> = Vec::new();
    // A run of 3 or more blank lines becomes one `⋯` line; shorter runs stay.
    fn flush<'a>(out: &mut Vec<&'a str>, blanks: &mut Vec<&'a str>) {
        if blanks.len() >= 3 {
            out.push(ELLIPSIS);
            blanks.clear();
        } else {
            out.append(blanks);
        }
    }
    for line in cleaned.split('\n') {
        // `/^\s*$/`
        if line.chars().all(is_js_whitespace) {
            blanks.push(line);
            continue;
        }
        flush(&mut out, &mut blanks);
        out.push(line);
    }
    flush(&mut out, &mut blanks);
    out.join("\n")
}

const ELLIPSIS: &str = "\u{22EF}";
/// Long runs of spaces/tabs could push the rest of a line out of view: `/[ \t]{64,}/g`.
const LONG_BLANK_RUN: usize = 64;

/// Replaces every run of at least [`LONG_BLANK_RUN`] spaces/tabs with ` ⋯ `.
fn collapse_long_blank_runs(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut run: Option<(usize, usize)> = None; // (start byte, length)
    let close = |out: &mut String, (start, length): (usize, usize), end: usize| {
        if length >= LONG_BLANK_RUN {
            out.push(' ');
            out.push_str(ELLIPSIS);
            out.push(' ');
        } else {
            out.push_str(&text[start..end]);
        }
    };
    for (index, character) in text.char_indices() {
        if character == ' ' || character == '\t' {
            run = Some(run.map_or((index, 1), |(start, length)| (start, length + 1)));
            continue;
        }
        if let Some(open) = run.take() {
            close(&mut out, open, index);
        }
        out.push(character);
    }
    if let Some(open) = run {
        close(&mut out, open, text.len());
    }
    out
}

/// `cut`: the first [`PREVIEW_MAX_CHARS`] UTF-16 units (never half a surrogate pair).
fn cut(text: &str) -> Preview {
    let length = utf16_len(text);
    Preview {
        preview: utf16_prefix(text, PREVIEW_MAX_CHARS).to_owned(),
        preview_truncated: length > PREVIEW_MAX_CHARS,
        preview_length: length,
    }
}

/// The command for shell tools; everything else shows its whole input (Write content, MCP
/// arguments...) as `JSON.stringify` writes it.
fn preview_from_tool_input(tool_input: Option<&Value>) -> Option<Preview> {
    let tool_input = tool_input.filter(|value| !value.is_null())?;
    let command = tool_input
        .as_object()
        .and_then(|object| object.get("command"))
        .and_then(Value::as_str)
        .filter(|command| !command.is_empty());
    let text = match command {
        Some(command) => sanitize_text(command),
        None => sanitize_text(&js_json::stringify(tool_input)),
    };
    Some(cut(&text))
}

/// `parseHookEvent`: `None` when the payload is not an object with a non-empty `session_id` and
/// one of our event names. Unknown keys are ignored; wrongly typed optional strings are dropped.
pub fn parse_hook_event(raw: &Value) -> Option<HookEvent> {
    let data = raw.as_object()?;
    let session_id = data
        .get("session_id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())?;
    let name = data
        .get("hook_event_name")
        .and_then(Value::as_str)
        .and_then(HookEventName::from_name)?;
    // `z.string().optional().catch(undefined)`: a wrong type drops the field.
    let optional = |key: &str| data.get(key).and_then(Value::as_str).map(str::to_owned);
    let raw_tool_name = data.get("tool_name").and_then(Value::as_str);
    let tool_input = data.get("tool_input");

    let mut event = HookEvent {
        name,
        session_id: session_id.to_owned(),
        cwd: optional("cwd"),
        tool_name: raw_tool_name.map(|tool_name| {
            let one_line = sanitize_text(tool_name).replace(['\n', '\t'], " ");
            utf16_prefix(&one_line, TOOL_NAME_MAX_CHARS).to_owned()
        }),
        tool_use_id: optional("tool_use_id").filter(|_| name.is_tool_call()),
        agent_id: optional("agent_id"),
        notification_type: optional("notification_type")
            .filter(|_| name == HookEventName::Notification),
        preview: None,
        reason: optional("reason").filter(|_| name == HookEventName::SessionEnd),
        ask_user_question: None,
        ask_user_question_raw: None,
    };
    if name == HookEventName::PermissionRequest {
        event.preview = preview_from_tool_input(tool_input);
    }
    if name == HookEventName::PreToolUse && raw_tool_name == Some(ASK_USER_QUESTION_TOOL) {
        let input = tool_input.and_then(parse_ask_user_question);
        if input.is_some() {
            event.ask_user_question_raw = tool_input.and_then(Value::as_object).cloned();
        }
        event.ask_user_question = Some(input);
    }
    Some(event)
}

/// Body that settles a held PermissionRequest (`allow` or `deny`).
pub fn permission_body(decision: Decision) -> String {
    format!(
        r#"{{"hookSpecificOutput":{{"hookEventName":"PermissionRequest","decision":{{"behavior":"{}"}}}}}}"#,
        decision.as_str()
    )
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use serde_json::json;

    use super::*;

    fn u(code_point: u32) -> char {
        char::from_u32(code_point).expect("a scalar value")
    }

    fn fixtures() -> Vec<(String, Value)> {
        let dir =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tests/unit/fixtures/claude-hooks");
        let mut out: Vec<(String, Value)> = std::fs::read_dir(&dir)
            .expect("fixture dir")
            .map(|entry| entry.expect("entry").path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .map(|path| {
                let text = std::fs::read_to_string(&path).expect("fixture");
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                (name, serde_json::from_str(&text).expect("fixture JSON"))
            })
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    fn permission(tool_input: Value) -> Value {
        json!({"session_id": "s1", "hook_event_name": "PermissionRequest", "tool_name": "Bash", "tool_input": tool_input})
    }

    fn with(mut value: Value, key: &str, field: Value) -> Value {
        value[key] = field;
        value
    }

    fn preview_of(raw: &Value) -> Option<String> {
        parse_hook_event(raw)
            .and_then(|event| event.preview)
            .map(|preview| preview.preview)
    }

    fn command_preview(command: &str) -> Option<String> {
        preview_of(&permission(json!({ "command": command })))
    }

    fn to_json(event: &HookEvent) -> Value {
        serde_json::to_value(event).unwrap()
    }

    #[test]
    fn has_a_fixture_for_every_hook_event_name() {
        let mut names: Vec<String> = fixtures()
            .iter()
            .map(|(_, raw)| raw["hook_event_name"].as_str().unwrap().to_owned())
            .collect();
        names.sort();
        let mut expected: Vec<String> = HOOK_EVENT_NAMES
            .iter()
            .map(|n| n.as_str().to_owned())
            .collect();
        expected.sort();
        assert_eq!(names, expected);
        assert_eq!(
            HOOK_EVENT_NAMES
                .iter()
                .map(|n| n.as_str())
                .collect::<Vec<_>>(),
            [
                "UserPromptSubmit",
                "PreToolUse",
                "PostToolUse",
                "PostToolUseFailure",
                "PermissionRequest",
                "PermissionDenied",
                "Notification",
                "Stop",
                "StopFailure",
                "SubagentStart",
                "SubagentStop",
                "SessionEnd",
            ]
        );
    }

    #[test]
    fn parses_every_fixture() {
        for (file, raw) in fixtures() {
            let event = parse_hook_event(&raw).unwrap_or_else(|| panic!("{file} parses"));
            assert_eq!(event.name.as_str(), raw["hook_event_name"], "{file}");
            assert_eq!(event.session_id, raw["session_id"], "{file}");
            assert_eq!(event.cwd.as_deref(), raw["cwd"].as_str(), "{file}");
        }
    }

    #[test]
    fn never_exposes_sensitive_payload_fields() {
        for (_, raw) in fixtures() {
            let value = to_json(&parse_hook_event(&raw).unwrap());
            let keys: Vec<&String> = value.as_object().unwrap().keys().collect();
            for forbidden in [
                "prompt",
                "message",
                "tool_response",
                "toolResponse",
                "last_assistant_message",
                "lastAssistantMessage",
                "toolInput",
            ] {
                assert!(!keys.iter().any(|key| *key == forbidden), "{forbidden}");
            }
        }
    }

    #[test]
    fn maps_tool_name_notification_type_and_reason() {
        let fixtures = fixtures();
        let by_name = |name: &str| {
            let (_, raw) = fixtures
                .iter()
                .find(|(_, raw)| raw["hook_event_name"] == name)
                .unwrap();
            parse_hook_event(raw).unwrap()
        };
        assert_eq!(by_name("PreToolUse").tool_name.as_deref(), Some("Bash"));
        assert_eq!(
            by_name("Notification").notification_type.as_deref(),
            Some("permission_prompt")
        );
        assert_eq!(by_name("SessionEnd").reason.as_deref(), Some("other"));
    }

    #[test]
    fn only_produces_a_preview_for_permission_request() {
        let pre = with(
            permission(json!({"command": "ls"})),
            "hook_event_name",
            json!("PreToolUse"),
        );
        assert_eq!(preview_of(&pre), None);
        assert_eq!(command_preview("ls").as_deref(), Some("ls"));
    }

    #[test]
    fn ignores_unknown_fields() {
        let event = parse_hook_event(
            &json!({"session_id": "s1", "hook_event_name": "Stop", "brand_new_field": {"a": 1}}),
        )
        .unwrap();
        assert_eq!(to_json(&event), json!({"name": "Stop", "sessionId": "s1"}));
    }

    #[test]
    fn returns_none_without_session_id_or_with_an_unknown_event_name() {
        assert_eq!(parse_hook_event(&json!({"hook_event_name": "Stop"})), None);
        assert_eq!(
            parse_hook_event(&json!({"session_id": "", "hook_event_name": "Stop"})),
            None
        );
        assert_eq!(
            parse_hook_event(&json!({"session_id": "s1", "hook_event_name": "Nope"})),
            None
        );
        assert_eq!(parse_hook_event(&json!({"session_id": "s1"})), None);
        assert_eq!(parse_hook_event(&Value::Null), None);
        assert_eq!(parse_hook_event(&json!("text")), None);
        assert_eq!(parse_hook_event(&json!([])), None);
        // Wrong types for the required fields are refused too.
        assert_eq!(
            parse_hook_event(&json!({"session_id": 1, "hook_event_name": "Stop"})),
            None
        );
    }

    // describe('permission preview')

    #[test]
    fn shows_the_command_when_tool_input_command_is_a_string() {
        assert_eq!(
            preview_of(&permission(
                json!({"command": "git status", "file_path": "/a", "url": "http://x"})
            ))
            .as_deref(),
            Some("git status")
        );
    }

    #[test]
    fn shows_the_whole_tool_input_as_compact_json_for_every_other_tool() {
        let write = with(
            permission(json!({"file_path": "/fake/a.ts", "content": "evil();"})),
            "tool_name",
            json!("Write"),
        );
        assert_eq!(
            preview_of(&write).as_deref(),
            Some(r#"{"file_path":"/fake/a.ts","content":"evil();"}"#)
        );
        assert_eq!(
            preview_of(&permission(
                json!({"url": "https://example.test/", "prompt": "x"})
            ))
            .as_deref(),
            Some(r#"{"url":"https://example.test/","prompt":"x"}"#)
        );
        assert_eq!(
            preview_of(&permission(json!({"pattern": "foo", "n": 2}))).as_deref(),
            Some(r#"{"pattern":"foo","n":2}"#)
        );
        assert_eq!(
            preview_of(&permission(json!({"command": 42}))).as_deref(),
            Some(r#"{"command":42}"#)
        );
        // An empty command is not a command; a non-object input is shown as JSON too.
        assert_eq!(
            preview_of(&permission(json!({"command": ""}))).as_deref(),
            Some(r#"{"command":""}"#)
        );
        assert_eq!(
            preview_of(&permission(json!(["a", 1.0]))).as_deref(),
            Some(r#"["a",1]"#)
        );
    }

    #[test]
    fn has_no_preview_without_tool_input() {
        assert_eq!(
            preview_of(&json!({"session_id": "s1", "hook_event_name": "PermissionRequest"})),
            None
        );
        assert_eq!(preview_of(&permission(Value::Null)), None);
    }

    #[test]
    fn strips_control_characters_except_newline_and_tab() {
        assert_eq!(
            command_preview("a\u{0}b\u{1b}[31mc\r\nd\te\u{7f}f\u{85}g").as_deref(),
            Some("ab[31mc\nd\tefg")
        );
    }

    #[test]
    fn strips_bidi_overrides_isolates_zero_width_and_other_format_characters() {
        let command = format!(
            "echo {}safe{}{}x{} {}z{}w{}j{}k{}end{}",
            u(0x202e),
            u(0x202c),
            u(0x2066),
            u(0x2069),
            u(0x200b),
            u(0x200f),
            u(0x2060),
            u(0x2064),
            u(0xfeff),
            u(0xad)
        );
        assert_eq!(
            command_preview(&command).as_deref(),
            Some("echo safex zwjkend")
        );
    }

    #[test]
    fn turns_u2028_and_u2029_into_newlines() {
        assert_eq!(
            command_preview("a\u{2028}b\u{2029}c").as_deref(),
            Some("a\nb\nc")
        );
    }

    #[test]
    fn collapses_3_or_more_consecutive_blank_lines_into_a_single_ellipsis_line() {
        assert_eq!(command_preview("a\n\nb").as_deref(), Some("a\n\nb"));
        assert_eq!(command_preview("a\n\n\nb").as_deref(), Some("a\n\n\nb"));
        let long = format!("safe\n{}rm -rf /", "\n".repeat(200));
        assert_eq!(command_preview(&long).as_deref(), Some("safe\n⋯\nrm -rf /"));
        // Whitespace-only and U+2028 "lines" count as blank too.
        assert_eq!(
            command_preview("a\n \n\t\n\u{2028}\u{2028}b").as_deref(),
            Some("a\n⋯\nb")
        );
        // Leading and trailing runs collapse as well.
        assert_eq!(command_preview("\n\n\na").as_deref(), Some("⋯\na"));
        assert_eq!(command_preview("a\n\n\n").as_deref(), Some("a\n⋯"));
    }

    #[test]
    fn collapses_very_long_runs_of_spaces_or_tabs() {
        let long = format!("ls{}; rm -rf /", " ".repeat(500));
        assert_eq!(command_preview(&long).as_deref(), Some("ls ⋯ ; rm -rf /"));
        assert_eq!(
            command_preview("    indented").as_deref(),
            Some("    indented")
        );
        // 63 stay, 64 (spaces and tabs mixed) collapse.
        let kept = format!("a{}b", " ".repeat(63));
        assert_eq!(command_preview(&kept), Some(kept.clone()));
        let mixed = format!("a{}b", " \t".repeat(32));
        assert_eq!(command_preview(&mixed).as_deref(), Some("a ⋯ b"));
    }

    #[test]
    fn cuts_to_2000_characters_and_reports_the_truncation_and_the_full_length() {
        let event = parse_hook_event(&permission(json!({"command": "x".repeat(2400)}))).unwrap();
        let preview = event.preview.unwrap();
        assert_eq!(utf16_len(&preview.preview), 2000);
        assert!(preview.preview_truncated);
        assert_eq!(preview.preview_length, 2400);
    }

    #[test]
    fn is_not_truncated_at_exactly_2000_characters() {
        let event = parse_hook_event(&permission(json!({"command": "x".repeat(2000)}))).unwrap();
        let preview = event.preview.unwrap();
        assert!(!preview.preview_truncated);
        assert_eq!(preview.preview_length, 2000);
    }

    #[test]
    fn counts_and_cuts_the_preview_in_utf16_units_without_splitting_a_pair() {
        // 1999 units then an emoji (2 units): JS would keep a lone high surrogate; the pair is
        // left out whole instead, and the length stays the JS one.
        let command = format!("{}😀tail", "x".repeat(1999));
        let preview = parse_hook_event(&permission(json!({ "command": command })))
            .unwrap()
            .preview
            .unwrap();
        assert_eq!(preview.preview, "x".repeat(1999));
        assert!(preview.preview_truncated);
        assert_eq!(preview.preview_length, 1999 + 2 + 4);
        // 1000 emoji are exactly 2000 units: not truncated.
        let emoji = "😀".repeat(1000);
        let preview = parse_hook_event(&permission(json!({ "command": emoji })))
            .unwrap()
            .preview
            .unwrap();
        assert_eq!(preview.preview, emoji);
        assert!(!preview.preview_truncated);
        assert_eq!(preview.preview_length, 2000);
    }

    #[test]
    fn clamps_and_sanitises_tool_name_to_64_characters() {
        let name = format!("mcp__{}evil{}", u(0x202e), "x".repeat(100));
        let event = parse_hook_event(&with(
            permission(json!({"command": "ls"})),
            "tool_name",
            json!(name),
        ))
        .unwrap();
        assert_eq!(
            event.tool_name,
            Some(format!("mcp__evil{}", "x".repeat(55)))
        );
        let event = parse_hook_event(&with(
            permission(json!({"command": "ls"})),
            "tool_name",
            json!("Bash"),
        ))
        .unwrap();
        assert_eq!(event.tool_name.as_deref(), Some("Bash"));
        // Newlines and tabs become spaces, one each.
        let event = parse_hook_event(&with(
            permission(json!({"command": "ls"})),
            "tool_name",
            json!("a\n\tb"),
        ))
        .unwrap();
        assert_eq!(event.tool_name.as_deref(), Some("a  b"));
    }

    // describe('tool call identity')

    #[test]
    fn reads_tool_use_id_on_tool_call_events() {
        for name in [
            "PreToolUse",
            "PostToolUse",
            "PostToolUseFailure",
            "PermissionDenied",
        ] {
            let event = parse_hook_event(
                &json!({"session_id": "s1", "hook_event_name": name, "tool_name": "Bash", "tool_use_id": "tu1"}),
            )
            .unwrap();
            assert_eq!(event.tool_use_id.as_deref(), Some("tu1"), "{name}");
        }
    }

    #[test]
    fn ignores_tool_use_id_on_other_events_and_reads_agent_id_when_present() {
        let parse = |value: Value| parse_hook_event(&value).unwrap();
        assert_eq!(
            parse(json!({"session_id": "s1", "hook_event_name": "Stop", "tool_use_id": "tu1"}))
                .tool_use_id,
            None
        );
        assert_eq!(
            parse(json!({"session_id": "s1", "hook_event_name": "PreToolUse", "agent_id": "ag1"}))
                .agent_id
                .as_deref(),
            Some("ag1")
        );
        assert_eq!(
            parse(json!({"session_id": "s1", "hook_event_name": "PermissionRequest", "agent_id": "ag1"})).agent_id.as_deref(),
            Some("ag1")
        );
        assert_eq!(
            parse(json!({"session_id": "s1", "hook_event_name": "PreToolUse", "agent_id": 7}))
                .agent_id,
            None
        );
        // Every optional string is dropped, not refused, when wrongly typed.
        let event = parse(json!({
            "session_id": "s1", "hook_event_name": "SessionEnd", "cwd": null, "tool_name": 1,
            "agent_id": [], "reason": {"x": 1}
        }));
        assert_eq!(
            to_json(&event),
            json!({"name": "SessionEnd", "sessionId": "s1"})
        );
    }

    #[test]
    fn keeps_no_ask_user_question_on_other_tools_or_other_events() {
        let tool_input = json!({"questions": [{"question": "a", "header": "h", "multiSelect": false, "options": [{"label": "x", "description": ""}, {"label": "y", "description": ""}]}]});
        let keys = |name: &str, tool: &str| {
            let event = parse_hook_event(
                &json!({"session_id": "s1", "hook_event_name": name, "tool_name": tool, "tool_input": tool_input}),
            )
            .unwrap();
            to_json(&event)
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect::<Vec<_>>()
        };
        let pre_bash = keys("PreToolUse", "Bash");
        assert!(!pre_bash.contains(&"askUserQuestion".to_owned()));
        assert!(!pre_bash.contains(&"askUserQuestionRaw".to_owned()));
        assert!(
            !keys("PermissionRequest", "AskUserQuestion").contains(&"askUserQuestion".to_owned())
        );
        assert!(!keys("PostToolUse", "AskUserQuestion").contains(&"askUserQuestion".to_owned()));
    }

    #[test]
    fn parses_post_tool_use_failure() {
        let event = parse_hook_event(
            &json!({"session_id": "s1", "hook_event_name": "PostToolUseFailure", "tool_name": "Bash"}),
        )
        .unwrap();
        assert_eq!(event.name, HookEventName::PostToolUseFailure);
        assert_eq!(event.tool_name.as_deref(), Some("Bash"));
    }

    // describe('AskUserQuestion')

    fn question() -> Value {
        json!({"question": "Fruit?", "header": "Pick", "multiSelect": false, "options": [{"label": "Apple", "description": "red"}, {"label": "Pear", "description": "green"}]})
    }

    fn ask(tool_input: Option<Value>) -> Value {
        let mut value = json!({"session_id": "s1", "hook_event_name": "PreToolUse", "tool_name": "AskUserQuestion", "tool_use_id": "tu1"});
        if let Some(tool_input) = tool_input {
            value["tool_input"] = tool_input;
        }
        value
    }

    #[test]
    fn keeps_the_validated_questions_and_the_tool_use_id() {
        let event = parse_hook_event(&ask(Some(json!({"questions": [question()]})))).unwrap();
        assert_eq!(
            to_json(&event),
            json!({
                "name": "PreToolUse",
                "sessionId": "s1",
                "toolName": "AskUserQuestion",
                "toolUseId": "tu1",
                "askUserQuestion": {"questions": [question()]},
                "askUserQuestionRaw": {"questions": [question()]},
            })
        );
    }

    #[test]
    fn carries_the_raw_tool_input_next_to_the_validated_view() {
        let mut first = question()["options"][0].clone();
        first["icon"] = json!("x");
        let mut extended = question();
        extended["extra"] = json!(true);
        extended["options"] = json!([first, question()["options"][1]]);
        let raw = json!({"meta": 1, "questions": [extended]});
        let event = parse_hook_event(&ask(Some(raw.clone()))).unwrap();
        assert_eq!(
            event.ask_user_question_raw.map(Value::Object),
            Some(raw.clone())
        );
        assert_eq!(
            serde_json::to_value(event.ask_user_question.unwrap()).unwrap(),
            json!({"questions": [question()]})
        );
        // The raw input keeps its key order.
        let text = r#"{"zeta":0,"questions":[{"question":"Fruit?","header":"Pick","multiSelect":false,"options":[{"label":"A","description":""},{"label":"B","description":""}]}],"alpha":1}"#;
        let event = parse_hook_event(&ask(Some(serde_json::from_str(text).unwrap()))).unwrap();
        let keys: Vec<String> = event
            .ask_user_question_raw
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(keys, ["zeta", "questions", "alpha"]);
    }

    #[test]
    fn keeps_the_raw_question_texts_unchanged() {
        let mut raw = question();
        raw["question"] = json!("Line one\n\n\n\nLine two?");
        let event = parse_hook_event(&ask(Some(json!({"questions": [raw.clone()]})))).unwrap();
        assert_eq!(
            serde_json::to_value(event.ask_user_question.unwrap()).unwrap(),
            json!({"questions": [raw]})
        );
    }

    #[test]
    fn is_null_when_tool_input_does_not_fit_the_schema() {
        let view = |tool_input: Option<Value>| {
            parse_hook_event(&ask(tool_input))
                .unwrap()
                .ask_user_question
        };
        assert_eq!(view(Some(json!({"questions": []}))), Some(None));
        let mut one_option = question();
        one_option["options"] = json!([question()["options"][0]]);
        assert_eq!(view(Some(json!({"questions": [one_option]}))), Some(None));
        assert_eq!(view(None), Some(None));
        assert_eq!(view(Some(json!("nope"))), Some(None));
        let empty = parse_hook_event(&ask(Some(json!({"questions": []})))).unwrap();
        assert_eq!(empty.ask_user_question_raw, None);
        let serialized = to_json(&empty);
        assert_eq!(serialized["askUserQuestion"], Value::Null);
        assert!(serialized.get("askUserQuestionRaw").is_none());
        let valid = parse_hook_event(&ask(Some(json!({"questions": [question()]})))).unwrap();
        assert_eq!(valid.preview, None);
    }

    // Response bodies (map §3): byte for byte what Electron writes.

    #[test]
    fn permission_bodies_match_bytes() {
        assert_eq!(
            permission_body(Decision::Allow),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#
        );
        assert_eq!(
            permission_body(Decision::Deny),
            r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}"#
        );
    }
}
