//! Claude's `AskUserQuestion` (port of `src/shared/claude/questions.ts`): the validated view of its
//! `tool_input`, the `answers` map built from the notch's answers, the hook response that carries
//! them back, and the display-only copies the notch receives.
//!
//! Lengths: the schema limits are zod's, which count code points (`contract::length`); the free
//! text ("Other") is checked with JS `.length`, in UTF-16 code units.

use serde::Serialize;
use serde_json::{Map, Value};

use super::hook_events::is_hidden_control;
use super::js_json;
use crate::contract::claude::{limits, ClaudeQuestion, QuestionAnswer, QuestionOption};
use crate::contract::length;
use crate::contract::text::{is_format, js_trim, utf16_len};

/// `QUESTION_LIMITS`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QuestionLimits {
    pub min_questions: usize,
    pub max_questions: usize,
    pub min_options: usize,
    pub max_options: usize,
    pub question: usize,
    pub header: usize,
    pub label: usize,
    pub description: usize,
    pub other: usize,
}

pub const QUESTION_LIMITS: QuestionLimits = QuestionLimits {
    min_questions: limits::MIN_QUESTIONS,
    max_questions: limits::MAX_QUESTIONS,
    min_options: limits::MIN_OPTIONS,
    max_options: limits::MAX_OPTIONS,
    question: limits::QUESTION,
    header: limits::HEADER,
    label: limits::LABEL,
    description: limits::DESCRIPTION,
    other: limits::OTHER,
};

/// Body that releases a held question: Claude asks it in the terminal instead.
pub const QUESTION_RELEASE_BODY: &str = "{}";

/// Validated view of `AskUserQuestion`'s `tool_input` (for the UI and [`build_answers`]). Unknown
/// keys are dropped from this view only; the raw `tool_input` is what goes back to Claude. Texts
/// are kept exactly as received.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AskUserQuestionInput {
    pub questions: Vec<ClaudeQuestion>,
}

/// `askUserQuestionInputSchema.safeParse(value)`: `None` when it does not fit.
pub fn parse_ask_user_question(value: &Value) -> Option<AskUserQuestionInput> {
    let questions = value.as_object()?.get("questions")?.as_array()?;
    let limits = QUESTION_LIMITS;
    if !(limits.min_questions..=limits.max_questions).contains(&questions.len()) {
        return None;
    }
    let questions = questions
        .iter()
        .map(parse_question)
        .collect::<Option<Vec<_>>>()?;
    // `answers` is keyed by the question texts, so they must be unique.
    let unique = questions.iter().enumerate().all(|(index, question)| {
        questions[..index]
            .iter()
            .all(|earlier| earlier.question != question.question)
    });
    unique.then_some(AskUserQuestionInput { questions })
}

/// `z.string().min(min).max(max)`, counting code points as zod does.
fn text_in(value: &Value, min: usize, max: usize) -> Option<String> {
    let text = value.as_str()?;
    (min..=max).contains(&length(text)).then(|| text.to_owned())
}

fn parse_question(value: &Value) -> Option<ClaudeQuestion> {
    let object = value.as_object()?;
    let limits = QUESTION_LIMITS;
    let question = text_in(object.get("question")?, 1, limits.question)?;
    let header = text_in(object.get("header")?, 0, limits.header)?;
    let multi_select = object.get("multiSelect")?.as_bool()?;
    let options = object.get("options")?.as_array()?;
    if !(limits.min_options..=limits.max_options).contains(&options.len()) {
        return None;
    }
    let options = options
        .iter()
        .map(|option| {
            let option = option.as_object()?;
            Some(QuestionOption {
                label: text_in(option.get("label")?, 1, limits.label)?,
                description: text_in(option.get("description")?, 0, limits.description)?,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    Some(ClaudeQuestion {
        question,
        header,
        multi_select,
        options,
    })
}

/// `freeText`: `Ok(None)` without one, `Err(())` when it breaks the rules (blank, longer than
/// [`QuestionLimits::other`] UTF-16 units after JS trim, or with a line break).
fn free_text(other: Option<&str>) -> Result<Option<&str>, ()> {
    let Some(other) = other else {
        return Ok(None);
    };
    let text = js_trim(other);
    let length = utf16_len(text);
    let line_break = text.contains(['\n', '\r', '\u{2028}', '\u{2029}']);
    if !(1..=QUESTION_LIMITS.other).contains(&length) || line_break {
        return Err(());
    }
    Ok(Some(text))
}

/// Every index in range, none repeated.
fn valid_selection(selected: &[u64], option_count: usize) -> bool {
    selected
        .iter()
        .all(|&index| usize::try_from(index).is_ok_and(|index| index < option_count))
        && selected
            .iter()
            .enumerate()
            .all(|(position, index)| !selected[..position].contains(index))
}

/// `buildAnswers`: Claude's `answers` map (question text -> answer), built only from the questions
/// main received, or `None` when the answers break any rule. Single choice: exactly one option or
/// a free text. multiSelect: labels joined by ", " in option order, the free text last (commas are
/// not escaped; Claude takes the text as is).
pub fn build_answers(
    questions: &[ClaudeQuestion],
    answers: &[QuestionAnswer],
) -> Option<Map<String, Value>> {
    if answers.len() != questions.len() {
        return None;
    }
    let mut out = Map::new();
    for (question, answer) in questions.iter().zip(answers) {
        if !valid_selection(&answer.selected, question.options.len()) {
            return None;
        }
        let other = free_text(answer.other.as_deref()).ok()?;
        // In the order the options are shown, whatever order they were picked in.
        let mut selected = answer.selected.clone();
        selected.sort_unstable();
        let mut parts: Vec<&str> = selected
            .iter()
            .filter_map(|&index| usize::try_from(index).ok())
            .filter_map(|index| question.options.get(index))
            .map(|option| option.label.as_str())
            .collect();
        if question.multi_select {
            if parts.is_empty() && other.is_none() {
                return None;
            }
        } else if parts.len() + usize::from(other.is_some()) != 1 {
            return None;
        }
        parts.extend(other);
        out.insert(question.question.clone(), Value::String(parts.join(", ")));
    }
    Some(out)
}

/// `questionResponseBody`: allow, with Claude's original `tool_input` untouched (unknown keys
/// included) plus `answers` (replacing, in place, an `answers` key the input already had, as
/// `{ ...rawInput, answers }` does).
pub fn question_answered_body(
    raw_input: &Map<String, Value>,
    answers: &Map<String, Value>,
) -> String {
    let mut updated_input = raw_input.clone();
    updated_input.insert("answers".into(), Value::Object(answers.clone()));
    let mut decision = Map::new();
    decision.insert("hookEventName".into(), Value::from("PreToolUse"));
    decision.insert("permissionDecision".into(), Value::from("allow"));
    decision.insert("updatedInput".into(), Value::Object(updated_input));
    let mut body = Map::new();
    body.insert("hookSpecificOutput".into(), Value::Object(decision));
    js_json::stringify_object(&body)
}

/// `displayText`: display-only copy of a Claude text: CRLF, CR, U+2028 and U+2029 become `\n`,
/// controls (but `\t`, `\n`) and format characters go. Never apply it to what goes back to Claude.
pub fn display_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut characters = text.chars().peekable();
    while let Some(character) = characters.next() {
        match character {
            '\r' => {
                characters.next_if_eq(&'\n');
                out.push('\n');
            }
            '\u{2028}' | '\u{2029}' => out.push('\n'),
            hidden if is_hidden_control(hidden) || is_format(hidden) => {}
            kept => out.push(kept),
        }
    }
    out
}

/// `displayLine`: [`display_text`] on one line (each run of `\n`/`\t` becomes one space).
fn display_line(text: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for character in display_text(text).chars() {
        if character == '\n' || character == '\t' {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(character);
            in_run = false;
        }
    }
    out
}

/// `displayQuestions`: display-only copy of the questions (headers and labels on one line).
pub fn display_questions(questions: &[ClaudeQuestion]) -> Vec<ClaudeQuestion> {
    questions
        .iter()
        .map(|question| ClaudeQuestion {
            question: display_text(&question.question),
            header: display_line(&question.header),
            multi_select: question.multi_select,
            options: question
                .options
                .iter()
                .map(|option| QuestionOption {
                    label: display_line(&option.label),
                    description: display_text(&option.description),
                })
                .collect(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::contract::claude::AnswerInput;

    fn opt(label: &str) -> Value {
        json!({"label": label, "description": format!("{label} desc")})
    }

    fn opt_with(label: &str, description: &str) -> Value {
        json!({"label": label, "description": description})
    }

    fn q_json(question: &str, labels: &[&str], multi_select: bool, header: &str) -> Value {
        json!({
            "question": question,
            "header": header,
            "multiSelect": multi_select,
            "options": labels.iter().map(|label| opt(label)).collect::<Vec<_>>(),
        })
    }

    fn q1(question: &str, labels: &[&str]) -> Value {
        q_json(question, labels, false, "H")
    }

    fn q(question: &str, labels: &[&str], multi_select: bool) -> ClaudeQuestion {
        ClaudeQuestion {
            question: question.into(),
            header: "H".into(),
            multi_select,
            options: labels
                .iter()
                .map(|label| QuestionOption {
                    label: (*label).into(),
                    description: format!("{label} desc"),
                })
                .collect(),
        }
    }

    fn single() -> ClaudeQuestion {
        q("Fruit?", &["Apple", "Pear", "Plum"], false)
    }

    fn multi() -> ClaudeQuestion {
        q("Colours?", &["Red", "Green", "Blue"], true)
    }

    fn answer(selected: &[u64], other: Option<&str>) -> QuestionAnswer {
        QuestionAnswer {
            selected: selected.to_vec(),
            other: other.map(str::to_owned),
        }
    }

    fn answers_of(pairs: &[(&str, &str)]) -> Map<String, Value> {
        pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), json!(value)))
            .collect()
    }

    fn valid(questions: Value) -> bool {
        parse_ask_user_question(&json!({ "questions": questions })).is_some()
    }

    fn with_options(question: &str, options: Vec<Value>) -> Value {
        let mut value = q1(question, &[]);
        value["options"] = Value::Array(options);
        value
    }

    // describe('askUserQuestionInputSchema')

    #[test]
    fn accepts_1_to_4_questions_and_rejects_0_or_5() {
        let many =
            |texts: &[&str]| Value::Array(texts.iter().map(|text| q1(text, &["x", "y"])).collect());
        assert!(!valid(json!([])));
        assert!(valid(json!([q1("a", &["x", "y"])])));
        assert!(valid(many(&["a", "b", "c", "d"])));
        assert!(!valid(many(&["a", "b", "c", "d", "e"])));
    }

    #[test]
    fn accepts_2_to_4_options_and_rejects_1_or_5() {
        assert!(!valid(json!([q1("a", &["x"])])));
        assert!(valid(json!([q1("a", &["x", "y"])])));
        assert!(valid(json!([q1("a", &["w", "x", "y", "z"])])));
        assert!(!valid(json!([q1("a", &["v", "w", "x", "y", "z"])])));
    }

    #[test]
    fn enforces_the_text_limits_at_the_edge_and_beyond() {
        let x = |count: usize| "x".repeat(count);
        assert!(valid(json!([q1(&x(500), &["a", "b"])])));
        assert!(!valid(json!([q1(&x(501), &["a", "b"])])));
        assert!(valid(json!([q_json(
            "a",
            &["a", "b"],
            false,
            &"h".repeat(60)
        )])));
        assert!(!valid(json!([q_json(
            "a",
            &["a", "b"],
            false,
            &"h".repeat(61)
        )])));
        assert!(valid(json!([q1("a", &[&"l".repeat(120), "b"])])));
        assert!(!valid(json!([q1("a", &[&"l".repeat(121), "b"])])));
        assert!(valid(json!([with_options(
            "a",
            vec![opt_with("a", &"d".repeat(300)), opt("b")]
        )])));
        assert!(!valid(json!([with_options(
            "a",
            vec![opt_with("a", &"d".repeat(301)), opt("b")]
        )])));
    }

    #[test]
    fn schema_limits_count_code_points_like_zod() {
        // zod 4 counts code points: 499 'x' + one astral emoji (501 UTF-16 units) still fits.
        let edge = format!("{}😀", "x".repeat(499));
        assert!(valid(json!([q1(&edge, &["a", "b"])])));
        let beyond = format!("{}😀", "x".repeat(500));
        assert!(!valid(json!([q1(&beyond, &["a", "b"])])));
    }

    #[test]
    fn rejects_empty_question_texts_and_labels_wrong_types_and_missing_fields() {
        assert!(!valid(json!([q1("", &["a", "b"])])));
        assert!(!valid(json!([q1("a", &["", "b"])])));
        let mut wrong = q1("a", &["x", "y"]);
        wrong["multiSelect"] = json!("yes");
        assert!(!valid(json!([wrong])));
        assert!(!valid(
            json!([{"question": "a", "options": [opt("x"), opt("y")], "multiSelect": false}])
        ));
        assert!(parse_ask_user_question(&Value::Null).is_none());
        assert!(parse_ask_user_question(&json!({})).is_none());
    }

    #[test]
    fn rejects_two_questions_with_the_same_text() {
        assert!(!valid(json!([
            q1("Same?", &["a", "b"]),
            q1("Same?", &["c", "d"])
        ])));
    }

    #[test]
    fn validates_input_with_unknown_keys_at_every_level() {
        let mut question = q1("a", &["x", "y"]);
        question["extra"] = json!(2);
        let mut first = opt("x");
        first["extra"] = json!(3);
        question["options"] = json!([first, opt("y")]);
        let raw = json!({"extra": 1, "questions": [question]});
        let view = parse_ask_user_question(&raw).expect("valid");
        assert_eq!(view.questions[0].options[0].label, "x");
    }

    // describe('questionAnswerInputSchema'): the shape lives in `contract::claude::AnswerInput`.

    #[test]
    fn answer_input_accepts_ids_and_selections_with_an_optional_free_text() {
        assert!(AnswerInput::from_input(
            json!({"id": "q1", "answers": [{"selected": [0]}, {"selected": [], "other": "x"}]})
        )
        .is_ok());
    }

    #[test]
    fn answer_input_rejects_unknown_keys_bad_indices_and_empty_ids() {
        let refused = |value: Value| AnswerInput::from_input(value).is_err();
        assert!(refused(
            json!({"id": "q1", "answers": [{"selected": [0]}], "extra": 1})
        ));
        assert!(refused(
            json!({"id": "q1", "answers": [{"selected": [0], "label": "x"}]})
        ));
        assert!(refused(
            json!({"id": "q1", "answers": [{"selected": [1.5]}]})
        ));
        assert!(refused(
            json!({"id": "q1", "answers": [{"selected": [-1]}]})
        ));
        assert!(refused(json!({"id": "", "answers": [{"selected": [0]}]})));
        assert!(refused(json!({"id": "q1", "answers": []})));
    }

    // describe('buildAnswers')

    #[test]
    fn maps_a_single_choice_question_to_its_label() {
        assert_eq!(
            build_answers(&[single()], &[answer(&[1], None)]),
            Some(answers_of(&[("Fruit?", "Pear")]))
        );
    }

    #[test]
    fn joins_multi_select_labels_in_option_order() {
        assert_eq!(
            build_answers(&[multi()], &[answer(&[0, 2], None)]),
            Some(answers_of(&[("Colours?", "Red, Blue")]))
        );
        assert_eq!(
            build_answers(&[multi()], &[answer(&[2, 0, 1], None)]),
            Some(answers_of(&[("Colours?", "Red, Green, Blue")]))
        );
    }

    #[test]
    fn sends_a_trimmed_free_text_alone() {
        assert_eq!(
            build_answers(&[single()], &[answer(&[], Some("  Mango  "))]),
            Some(answers_of(&[("Fruit?", "Mango")]))
        );
        assert_eq!(
            build_answers(&[multi()], &[answer(&[], Some("Teal"))]),
            Some(answers_of(&[("Colours?", "Teal")]))
        );
    }

    #[test]
    fn appends_the_free_text_after_the_joined_labels() {
        assert_eq!(
            build_answers(&[multi()], &[answer(&[1], Some("Teal, or Cyan"))]),
            Some(answers_of(&[("Colours?", "Green, Teal, or Cyan")]))
        );
    }

    #[test]
    fn answers_several_questions_in_order() {
        let built = build_answers(
            &[single(), multi()],
            &[answer(&[0], None), answer(&[1, 0], None)],
        )
        .expect("valid");
        assert_eq!(
            built,
            answers_of(&[("Fruit?", "Apple"), ("Colours?", "Red, Green")])
        );
        assert_eq!(built.keys().collect::<Vec<_>>(), ["Fruit?", "Colours?"]);
    }

    #[test]
    fn rejects_a_count_that_does_not_match_the_questions() {
        assert_eq!(
            build_answers(&[single(), multi()], &[answer(&[0], None)]),
            None
        );
        assert_eq!(
            build_answers(&[single()], &[answer(&[0], None), answer(&[0], None)]),
            None
        );
    }

    #[test]
    fn rejects_repeated_or_out_of_range_indices() {
        assert_eq!(build_answers(&[multi()], &[answer(&[0, 0], None)]), None);
        assert_eq!(build_answers(&[multi()], &[answer(&[3], None)]), None);
        // -1 and 0.5 cannot reach `build_answers`: the `claude:answer` shape refuses them.
        for selected in [json!([-1]), json!([0.5])] {
            assert!(
                serde_json::from_value::<QuestionAnswer>(json!({ "selected": selected })).is_err()
            );
        }
    }

    #[test]
    fn needs_exactly_one_option_or_a_free_text_for_a_single_choice_question() {
        assert_eq!(build_answers(&[single()], &[answer(&[0, 1], None)]), None);
        assert_eq!(
            build_answers(&[single()], &[answer(&[0], Some("Mango"))]),
            None
        );
        assert_eq!(build_answers(&[single()], &[answer(&[], None)]), None);
    }

    #[test]
    fn needs_at_least_an_option_or_a_free_text_for_multi_select() {
        assert_eq!(build_answers(&[multi()], &[answer(&[], None)]), None);
    }

    #[test]
    fn rejects_a_blank_multiline_or_too_long_free_text() {
        let free = |text: &str| build_answers(&[single()], &[answer(&[], Some(text))]);
        assert_eq!(free("   "), None);
        assert_eq!(free("a\nb"), None);
        assert_eq!(free("a\rb"), None);
        assert_eq!(free("a\u{2028}b"), None);
        assert_eq!(free("a\u{2029}b"), None);
        assert_eq!(free(&"x".repeat(501)), None);
        let edge = "x".repeat(500);
        assert_eq!(
            free(&format!(" {edge} ")),
            Some(answers_of(&[("Fruit?", &edge)]))
        );
    }

    #[test]
    fn free_text_counts_utf16_units_and_trims_like_js() {
        // JS `.length`: an astral emoji is 2 units, so 499 'x' + emoji (501) is too long.
        let free = |text: &str| build_answers(&[single()], &[answer(&[], Some(text))]);
        assert_eq!(free(&format!("{}😀", "x".repeat(499))), None);
        let fits = format!("{}😀", "x".repeat(498));
        assert_eq!(free(&fits), Some(answers_of(&[("Fruit?", &fits)])));
        // `String.prototype.trim` strips U+FEFF but not U+0085.
        assert_eq!(
            free("\u{feff}Mango\u{3000}"),
            Some(answers_of(&[("Fruit?", "Mango")]))
        );
        assert_eq!(
            free("\u{85}Mango"),
            Some(answers_of(&[("Fruit?", "\u{85}Mango")]))
        );
    }

    // describe('questionResponseBody')

    fn raw_of(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => panic!("an object"),
        }
    }

    #[test]
    fn is_the_exact_pre_tool_use_allow_json() {
        let questions = serde_json::to_value([single(), multi()]).unwrap();
        let raw = raw_of(json!({ "questions": questions }));
        let answers = answers_of(&[("Fruit?", "Pear"), ("Colours?", "Red, Blue")]);
        let expected = format!(
            r#"{{"hookSpecificOutput":{{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{{"questions":{},"answers":{{"Fruit?":"Pear","Colours?":"Red, Blue"}}}}}}}}"#,
            serde_json::to_string(&questions).unwrap()
        );
        assert_eq!(question_answered_body(&raw, &answers), expected);
    }

    #[test]
    fn echoes_unknown_keys_exactly_as_received() {
        let text = r#"{"metadata":{"source":"x"},"questions":[{"extra":2,"question":"Fruit?","header":"H","options":[{"label":"A","description":"a","icon":"*"},{"label":"B","description":"b"}],"multiSelect":false}]}"#;
        let raw = raw_of(serde_json::from_str(text).unwrap());
        let snapshot = raw.clone();
        let body = question_answered_body(&raw, &answers_of(&[("Fruit?", "A")]));
        assert_eq!(
            body,
            format!(
                r#"{{"hookSpecificOutput":{{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{}}}}}"#,
                format_args!(
                    "{},\"answers\":{{\"Fruit?\":\"A\"}}}}",
                    &text[..text.len() - 1]
                )
            )
        );
        assert_eq!(raw, snapshot);
    }

    #[test]
    fn replaces_an_answers_key_already_present_in_the_input() {
        let raw = raw_of(json!({"answers": {"stale": "x"}, "questions": []}));
        let body = question_answered_body(&raw, &answers_of(&[("Fruit?", "Pear")]));
        assert_eq!(
            body,
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"answers":{"Fruit?":"Pear"},"questions":[]}}}"#
        );
    }

    #[test]
    fn answers_keep_raw_key_order() {
        let text = r#"{"zeta":1,"questions":[],"alpha":{"b":2,"a":1},"7":"index first"}"#;
        let raw = raw_of(serde_json::from_str(text).unwrap());
        // Question texts that look like array indices come first, as in a JS object.
        let answers = answers_of(&[("Why?", "x"), ("2", "y")]);
        assert_eq!(
            question_answered_body(&raw, &answers),
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"7":"index first","zeta":1,"questions":[],"alpha":{"b":2,"a":1},"answers":{"2":"y","Why?":"x"}}}}"#
        );
    }

    #[test]
    fn release_body_is_an_empty_object() {
        assert_eq!(QUESTION_RELEASE_BODY, "{}");
    }

    // describe('displayText / displayQuestions')

    #[test]
    fn display_strips_bidi_zero_width_and_control_characters() {
        let bidi: String = [
            0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
        ]
        .into_iter()
        .filter_map(char::from_u32)
        .collect();
        let text = format!("a{bidi}b\u{200b}c\u{0}\u{7}\u{1b}\u{7f}\u{9b}d\u{feff}");
        assert_eq!(display_text(&text), "abcd");
    }

    #[test]
    fn display_keeps_newlines_and_tabs_and_turns_line_separators_into_newlines() {
        assert_eq!(
            display_text("a\nb\tc\u{2028}d\u{2029}e\r\nf"),
            "a\nb\tc\nd\ne\nf"
        );
        assert_eq!(display_text("a\rb\r\r\nc"), "a\nb\n\nc");
    }

    #[test]
    fn display_questions_maps_every_text_and_never_touches_the_input() {
        let raw = vec![ClaudeQuestion {
            question: "Pick\u{202e}?".into(),
            header: "H\n1".into(),
            multi_select: true,
            options: vec![
                QuestionOption {
                    label: "A\u{2066}\nB".into(),
                    description: "d\u{200f}".into(),
                },
                QuestionOption {
                    label: "C".into(),
                    description: "C desc".into(),
                },
            ],
        }];
        let snapshot = raw.clone();
        assert_eq!(
            display_questions(&raw),
            vec![ClaudeQuestion {
                question: "Pick?".into(),
                header: "H 1".into(),
                multi_select: true,
                options: vec![
                    QuestionOption {
                        label: "A B".into(),
                        description: "d".into(),
                    },
                    QuestionOption {
                        label: "C".into(),
                        description: "C desc".into(),
                    },
                ],
            }]
        );
        assert_eq!(raw, snapshot);
        // Runs of tabs and line breaks become one space in one-line texts.
        let line = ClaudeQuestion {
            header: "a\t\n\r\nb".into(),
            ..snapshot[0].clone()
        };
        assert_eq!(display_questions(&[line])[0].header, "a b");
    }
}
