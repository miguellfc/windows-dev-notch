//! Held Claude `AskUserQuestion` hook requests (port of 0.1.0's `question-broker.ts`):
//! held until the user answers them in the notch, releases them (`{}`: Claude asks in its own
//! window) or they stop being pending. Never logs question or answer texts.
//!
//! Concurrency: self-locking, exactly like [`super::permission_broker::PermissionBroker`]. The
//! callbacks and `PendingReply::{send, on_close}` run with the internal lock released; a settle
//! removes the entry first, then sends, then calls `on_change`.

use std::sync::{Arc, Mutex, Weak};

use serde_json::{Map, Value};

use super::bridge::PendingReply;
use super::hook_events::{HookEvent, HookEventName};
use super::permission_broker::{is_session_end, lock, safe_send, NewId, Now, OnChange};
use super::questions::{build_answers, question_answered_body, QUESTION_RELEASE_BODY};
use crate::contract::claude::{ClaudeQuestion, QuestionAnswer};

/// `QuestionBrokerOptions`.
/// Display name of a session; `cwd` names one this app has not seen yet.
pub type QuestionSessionName = Arc<dyn Fn(&str, Option<&str>) -> String + Send + Sync>;

#[derive(Clone)]
pub struct QuestionBrokerOptions {
    pub new_id: NewId,
    pub now: Now,
    pub session_name: QuestionSessionName,
    pub on_change: OnChange,
}

/// `PendingQuestion`: a held question with its session (the notch's view drops the session id).
#[derive(Clone, Debug, PartialEq)]
pub struct PendingQuestion {
    pub id: String,
    pub session_id: String,
    /// Display name of the session's project (same source as the permissions' `sessionName`).
    pub project: String,
    /// As validated, texts untouched.
    pub questions: Vec<ClaudeQuestion>,
    /// When the hook request arrived (ms); orders questions against permissions.
    pub arrived_at: u64,
}

/// `AnswerResult`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnswerResult {
    Sent,
    Gone,
    Invalid,
}

/// The AskUserQuestion call is over (answered in Claude's window, or failed).
fn is_tool_end(name: HookEventName) -> bool {
    matches!(
        name,
        HookEventName::PostToolUse | HookEventName::PostToolUseFailure
    )
}

fn no_decision() -> Option<String> {
    Some(QUESTION_RELEASE_BODY.to_string())
}

struct Entry {
    info: PendingQuestion,
    reply: Arc<dyn PendingReply>,
    tool_use_id: Option<String>,
    /// Claude's tool_input as received: echoed back untouched in the answer. Never logged.
    raw_input: Map<String, Value>,
}

#[derive(Default)]
struct Inner {
    /// In arrival order.
    entries: Vec<Entry>,
}

impl Inner {
    fn take(&mut self, id: &str) -> Option<Entry> {
        let index = self.entries.iter().position(|entry| entry.info.id == id)?;
        Some(self.entries.remove(index))
    }

    fn ids_where(&self, matches: impl Fn(&Entry) -> bool) -> Vec<String> {
        self.entries
            .iter()
            .filter(|entry| matches(entry))
            .map(|entry| entry.info.id.clone())
            .collect()
    }
}

/// `createQuestionBroker`.
pub struct QuestionBroker {
    options: QuestionBrokerOptions,
    inner: Arc<Mutex<Inner>>,
}

impl QuestionBroker {
    pub fn new(options: QuestionBrokerOptions) -> Self {
        Self {
            options,
            inner: Arc::default(),
        }
    }

    /// Sends `body` to a taken entry and notifies. False when the send failed.
    fn finish(&self, entry: Entry, body: Option<String>) -> bool {
        let sent = safe_send(entry.reply.as_ref(), body, "question");
        (self.options.on_change)();
        sent
    }

    /// `None` when the id is unknown; else whether the send went through.
    fn settle(&self, id: &str, body: Option<String>) -> Option<bool> {
        let entry = lock(&self.inner).take(id)?;
        Some(self.finish(entry, body))
    }

    fn release_ids(&self, ids: Vec<String>) {
        for id in ids {
            self.settle(&id, no_decision());
        }
    }

    /// Holds an AskUserQuestion PreToolUse; anything else is answered `{}` at once.
    pub fn hold(&self, e: &HookEvent, reply: Arc<dyn PendingReply>) {
        let input = match (&e.name, &e.ask_user_question) {
            (HookEventName::PreToolUse, Some(Some(input))) => input,
            _ => {
                safe_send(reply.as_ref(), no_decision(), "question");
                return;
            }
        };
        let id = (self.options.new_id)();
        let project = (self.options.session_name)(&e.session_id, e.cwd.as_deref());
        let arrived_at = reply.arrived_at().unwrap_or_else(|| (self.options.now)());
        let raw_input =
            e.ask_user_question_raw
                .clone()
                .unwrap_or_else(|| match serde_json::to_value(input) {
                    Ok(Value::Object(map)) => map,
                    _ => Map::new(),
                });
        lock(&self.inner).entries.push(Entry {
            info: PendingQuestion {
                id: id.clone(),
                session_id: e.session_id.clone(),
                project,
                questions: input.questions.clone(),
                arrived_at,
            },
            reply: Arc::clone(&reply),
            tool_use_id: e.tool_use_id.clone(),
            raw_input,
        });
        let weak: Weak<Mutex<Inner>> = Arc::downgrade(&self.inner);
        let on_change = Arc::clone(&self.options.on_change);
        reply.on_close(Box::new(move || {
            let Some(inner) = weak.upgrade() else { return };
            let removed = lock(&inner).take(&id).is_some();
            if removed {
                on_change();
            }
        }));
        (self.options.on_change)();
    }

    /// Answers a held question. `Invalid` keeps it pending; `Gone` when it is unknown or the
    /// send failed.
    pub fn answer(&self, id: &str, answers: &[QuestionAnswer]) -> AnswerResult {
        let taken = {
            let mut inner = lock(&self.inner);
            let Some(entry) = inner.entries.iter().find(|entry| entry.info.id == id) else {
                return AnswerResult::Gone;
            };
            let Some(built) = build_answers(&entry.info.questions, answers) else {
                return AnswerResult::Invalid;
            };
            let body = question_answered_body(&entry.raw_input, &built);
            inner.take(id).map(|entry| (entry, body))
        };
        let Some((entry, body)) = taken else {
            return AnswerResult::Gone;
        };
        if self.finish(entry, Some(body)) {
            AnswerResult::Sent
        } else {
            AnswerResult::Gone
        }
    }

    /// Releases a held question with `{}` (Claude shows its own dialog). False if unknown.
    pub fn release(&self, id: &str) -> bool {
        self.settle(id, no_decision()).is_some()
    }

    /// Called for `/hook` events only.
    pub fn observe(&self, e: &HookEvent) {
        let ids = {
            let inner = lock(&self.inner);
            if is_session_end(e.name) {
                inner.ids_where(|entry| entry.info.session_id == e.session_id)
            } else if is_tool_end(e.name) && e.tool_use_id.is_some() {
                inner.ids_where(|entry| {
                    entry.info.session_id == e.session_id && entry.tool_use_id == e.tool_use_id
                })
            } else {
                // PreToolUse, PermissionRequest, PermissionDenied, Notification, Subagent*:
                // never release.
                Vec::new()
            }
        };
        self.release_ids(ids);
    }

    pub fn release_all(&self) {
        let ids = lock(&self.inner).ids_where(|_| true);
        self.release_ids(ids);
    }

    /// Copies of the held questions, oldest first.
    pub fn pending(&self) -> Vec<PendingQuestion> {
        lock(&self.inner)
            .entries
            .iter()
            .map(|entry| entry.info.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};

    use serde_json::json;

    use super::*;
    use crate::claude::permission_broker::test_support::{ev, tool, Counter, FakeReply};
    use crate::claude::questions::AskUserQuestionInput;
    use crate::contract::claude::QuestionOption;
    use HookEventName::*;

    fn single() -> ClaudeQuestion {
        ClaudeQuestion {
            question: "Fruit?".into(),
            header: "Pick".into(),
            multi_select: false,
            options: vec![
                QuestionOption {
                    label: "Apple".into(),
                    description: "red".into(),
                },
                QuestionOption {
                    label: "Pear".into(),
                    description: "green".into(),
                },
            ],
        }
    }

    fn raw_of(questions: &[ClaudeQuestion]) -> Map<String, Value> {
        match json!({ "questions": questions }) {
            Value::Object(map) => map,
            _ => unreachable!(),
        }
    }

    fn ask(session_id: &str, tool_use_id: &str) -> HookEvent {
        let questions = vec![single()];
        HookEvent {
            ask_user_question: Some(Some(AskUserQuestionInput {
                questions: questions.clone(),
            })),
            ask_user_question_raw: Some(raw_of(&questions)),
            ..tool(
                PreToolUse,
                session_id,
                Some("AskUserQuestion"),
                Some(tool_use_id),
                None,
            )
        }
    }

    fn setup() -> (QuestionBroker, Arc<Counter>) {
        let n = Arc::new(AtomicU64::new(0));
        let t = Arc::new(AtomicU64::new(1000));
        let changes = Arc::new(Counter::default());
        let counter = Arc::clone(&changes);
        let broker = QuestionBroker::new(QuestionBrokerOptions {
            new_id: Arc::new(move || format!("id{}", n.fetch_add(1, Ordering::SeqCst) + 1)),
            now: Arc::new(move || t.fetch_add(10, Ordering::SeqCst) + 10),
            session_name: Arc::new(|id, _| format!("name-{id}")),
            on_change: Arc::new(move || counter.bump()),
        });
        (broker, changes)
    }

    fn hold(broker: &QuestionBroker, e: &HookEvent) -> Arc<FakeReply> {
        let reply = FakeReply::new();
        broker.hold(e, reply.clone());
        reply
    }

    fn ids(broker: &QuestionBroker) -> Vec<String> {
        broker.pending().into_iter().map(|p| p.id).collect()
    }

    fn released(reply: &FakeReply) -> bool {
        reply.sends() == vec![Some("{}".to_string())]
    }

    fn pick(selected: &[u64]) -> Vec<QuestionAnswer> {
        vec![QuestionAnswer {
            selected: selected.to_vec(),
            other: None,
        }]
    }

    #[test]
    fn names_the_project_from_the_session_and_the_cwd_of_the_event() {
        type Calls = Mutex<Vec<(String, Option<String>)>>;
        let calls: Arc<Calls> = Arc::default();
        let seen = Arc::clone(&calls);
        let broker = QuestionBroker::new(QuestionBrokerOptions {
            new_id: Arc::new(|| "q".into()),
            now: Arc::new(|| 1),
            session_name: Arc::new(move |id, cwd| {
                lock(&seen).push((id.into(), cwd.map(Into::into)));
                format!("{id}:{}", cwd.unwrap_or("-"))
            }),
            on_change: Arc::new(|| {}),
        });
        let e = HookEvent {
            cwd: Some("C:\\work\\first-seen".into()),
            ..ask("s9", "tu1")
        };
        broker.hold(&e, FakeReply::new());
        assert_eq!(
            *lock(&calls),
            vec![("s9".to_string(), Some("C:\\work\\first-seen".to_string()))]
        );
        assert_eq!(broker.pending()[0].project, "s9:C:\\work\\first-seen");
    }

    #[test]
    fn answers_empty_at_once_and_holds_nothing_without_a_valid_ask_user_question() {
        let (broker, changes) = setup();
        let invalid = hold(
            &broker,
            &HookEvent {
                ask_user_question: Some(None),
                ..tool(PreToolUse, "s1", Some("AskUserQuestion"), Some("tu1"), None)
            },
        );
        assert!(released(&invalid));
        let missing = hold(
            &broker,
            &tool(PreToolUse, "s1", Some("AskUserQuestion"), Some("tu2"), None),
        );
        assert!(released(&missing));
        let other = hold(
            &broker,
            &HookEvent {
                name: PermissionRequest,
                ..ask("s1", "tu1")
            },
        );
        assert!(released(&other));
        assert!(broker.pending().is_empty());
        assert_eq!(changes.get(), 0);
    }

    #[test]
    fn queues_questions_in_arrival_order_without_exposing_the_reply() {
        let (broker, changes) = setup();
        broker.hold(&ask("s1", "tu1"), FakeReply::arriving_at(500));
        broker.hold(&ask("s2", "tu2"), FakeReply::new());
        let mut list = broker.pending();
        let expected = |id: &str, s: &str, at: u64| PendingQuestion {
            id: id.into(),
            session_id: s.into(),
            project: format!("name-{s}"),
            questions: vec![single()],
            arrived_at: at,
        };
        assert_eq!(
            list,
            vec![expected("id1", "s1", 500), expected("id2", "s2", 1010)]
        );
        assert_eq!(changes.get(), 2);
        list[0].questions[0].options[0].label = "mutated".into();
        assert_eq!(broker.pending()[0].questions[0].options[0].label, "Apple");
    }

    #[test]
    fn answer_sends_the_exact_allow_body_built_from_the_held_questions() {
        let (broker, changes) = setup();
        let a = hold(&broker, &ask("s1", "tu1"));
        changes.clear();
        assert_eq!(broker.answer("id1", &pick(&[1])), AnswerResult::Sent);
        let mut answers = Map::new();
        answers.insert("Fruit?".into(), Value::from("Pear"));
        assert_eq!(
            a.sends(),
            vec![Some(question_answered_body(&raw_of(&[single()]), &answers))]
        );
        assert!(broker.pending().is_empty());
        assert_eq!(changes.get(), 1);
        assert_eq!(broker.answer("id1", &pick(&[1])), AnswerResult::Gone);
    }

    #[test]
    fn answer_returns_invalid_and_sends_nothing_when_the_answers_break_the_rules() {
        let (broker, changes) = setup();
        let a = hold(&broker, &ask("s1", "tu1"));
        changes.clear();
        assert_eq!(broker.answer("id1", &pick(&[0, 1])), AnswerResult::Invalid);
        assert_eq!(broker.answer("id1", &pick(&[5])), AnswerResult::Invalid);
        assert_eq!(broker.answer("id1", &[]), AnswerResult::Invalid);
        assert!(a.sends().is_empty());
        assert_eq!(changes.get(), 0);
        assert_eq!(broker.pending().len(), 1);
    }

    #[test]
    fn answer_returns_gone_for_an_unknown_id() {
        let (broker, _) = setup();
        assert_eq!(broker.answer("nope", &pick(&[0])), AnswerResult::Gone);
    }

    #[test]
    fn release_sends_empty_and_removes_the_entry_an_unknown_id_returns_false() {
        let (broker, changes) = setup();
        let a = hold(&broker, &ask("s1", "tu1"));
        changes.clear();
        assert!(broker.release("id1"));
        assert!(released(&a));
        assert!(broker.pending().is_empty());
        assert_eq!(changes.get(), 1);
        assert!(!broker.release("id1"));
        assert_eq!(a.sends().len(), 1);
    }

    #[test]
    fn a_tool_end_with_the_same_tool_use_id_releases_only_that_question() {
        for name in [PostToolUse, PostToolUseFailure] {
            let (broker, _) = setup();
            let a = hold(&broker, &ask("s1", "tu1"));
            let b = hold(&broker, &ask("s1", "tu2"));
            let c = hold(&broker, &ask("s2", "tu1"));
            broker.observe(&tool(
                name,
                "s1",
                Some("AskUserQuestion"),
                Some("tu1"),
                None,
            ));
            assert!(released(&a), "{name:?}");
            assert!(b.sends().is_empty(), "{name:?}");
            assert!(c.sends().is_empty(), "{name:?}");
            assert_eq!(ids(&broker), vec!["id2", "id3"], "{name:?}");
        }
    }

    #[test]
    fn a_tool_end_without_tool_use_id_releases_nothing() {
        let (broker, _) = setup();
        let a = hold(&broker, &ask("s1", "tu1"));
        broker.observe(&tool(
            PostToolUse,
            "s1",
            Some("AskUserQuestion"),
            None,
            None,
        ));
        broker.observe(&tool(
            PermissionDenied,
            "s1",
            Some("AskUserQuestion"),
            Some("tu1"),
            None,
        ));
        assert!(a.sends().is_empty());
        assert_eq!(broker.pending().len(), 1);
    }

    #[test]
    fn a_session_end_releases_only_the_questions_of_that_session() {
        for name in [Stop, StopFailure, SessionEnd, UserPromptSubmit] {
            let (broker, changes) = setup();
            let a = hold(&broker, &ask("s1", "tu1"));
            let b = hold(&broker, &ask("s1", "tu2"));
            let c = hold(&broker, &ask("s2", "tu3"));
            changes.clear();
            broker.observe(&ev(name, "s1"));
            assert!(released(&a), "{name:?}");
            assert!(released(&b), "{name:?}");
            assert!(c.sends().is_empty(), "{name:?}");
            assert_eq!(ids(&broker), vec!["id3"], "{name:?}");
            assert!(changes.get() > 0, "{name:?}");
        }
    }

    #[test]
    fn other_events_never_release() {
        for name in [
            PreToolUse,
            Notification,
            PermissionRequest,
            SubagentStart,
            SubagentStop,
        ] {
            let (broker, _) = setup();
            let a = hold(&broker, &ask("s1", "tu1"));
            broker.observe(&tool(name, "s1", None, Some("tu1"), None));
            assert!(a.sends().is_empty(), "{name:?}");
            assert_eq!(broker.pending().len(), 1, "{name:?}");
        }
    }

    #[test]
    fn a_closed_socket_removes_the_question_and_a_later_answer_is_gone() {
        let (broker, changes) = setup();
        let a = hold(&broker, &ask("s1", "tu1"));
        changes.clear();
        a.close();
        assert!(broker.pending().is_empty());
        assert_eq!(changes.get(), 1);
        assert_eq!(broker.answer("id1", &pick(&[0])), AnswerResult::Gone);
        assert!(!broker.release("id1"));
        assert!(a.sends().is_empty());
    }

    #[test]
    fn a_close_after_the_answer_is_a_no_op() {
        let (broker, changes) = setup();
        let a = hold(&broker, &ask("s1", "tu1"));
        broker.answer("id1", &pick(&[0]));
        changes.clear();
        a.close();
        assert_eq!(changes.get(), 0);
    }

    #[test]
    fn release_all_sends_empty_to_every_held_question() {
        let (broker, _) = setup();
        let a = hold(&broker, &ask("s1", "tu1"));
        let b = hold(&broker, &ask("s2", "tu2"));
        broker.release_all();
        assert!(released(&a));
        assert!(released(&b));
        assert!(broker.pending().is_empty());
    }

    #[test]
    fn answers_with_the_raw_tool_input_unknown_keys_included_not_the_validated_copy() {
        let (broker, _) = setup();
        let raw = match json!({
            "meta": { "v": 2 },
            "questions": [{
                "question": "Fruit?", "header": "Pick", "multiSelect": false, "extra": 1,
                "options": [
                    { "label": "Apple", "description": "red", "icon": "*" },
                    { "label": "Pear", "description": "green" },
                ],
            }],
        }) {
            Value::Object(map) => map,
            _ => unreachable!(),
        };
        let a = hold(
            &broker,
            &HookEvent {
                ask_user_question_raw: Some(raw.clone()),
                ..ask("s1", "tu1")
            },
        );
        assert_eq!(broker.pending()[0].questions, vec![single()]);
        assert_eq!(broker.answer("id1", &pick(&[0])), AnswerResult::Sent);
        let body: Value = serde_json::from_str(a.sends()[0].as_deref().unwrap()).unwrap();
        let mut expected = Value::Object(raw);
        expected["answers"] = json!({ "Fruit?": "Apple" });
        assert_eq!(body["hookSpecificOutput"]["updatedInput"], expected);
    }

    #[test]
    fn a_send_that_panics_still_removes_the_entry_notifies_releases_the_others_and_answers_gone() {
        crate::services::test_log::capture().expect("the test logger");
        let (broker, changes) = setup();
        let bad = FakeReply::panicking();
        let good = FakeReply::new();
        broker.hold(&ask("s1", "tu1"), bad.clone());
        broker.hold(&ask("s1", "tu2"), good.clone());
        changes.clear();
        broker.release_all();
        assert!(released(&good));
        assert!(broker.pending().is_empty());
        assert_eq!(changes.get(), 2);

        broker.hold(&ask("s2", "tu3"), bad.clone());
        broker.hold(&ask("s2", "tu4"), good.clone());
        broker.observe(&ev(Stop, "s2"));
        assert_eq!(good.sends().len(), 2);
        assert!(broker.pending().is_empty());

        broker.hold(&ask("s3", "tu5"), bad.clone());
        assert_eq!(broker.answer("id5", &pick(&[0])), AnswerResult::Gone);
        assert!(broker.pending().is_empty());
        // Only which broker failed is logged, never the body (it echoes the questions).
        let lines = crate::services::test_log::capture()
            .expect("the test logger")
            .lines();
        assert!(lines
            .iter()
            .any(|line| line.contains("Claude question reply could not be sent")));
        assert!(lines.iter().all(|line| !line.contains("Fruit?")));
    }

    #[test]
    fn an_immediate_empty_answer_that_panics_does_not_escape_hold() {
        let (broker, _) = setup();
        let bad = FakeReply::panicking();
        broker.hold(
            &HookEvent {
                ask_user_question: Some(None),
                ..ev(PreToolUse, "s1")
            },
            bad.clone(),
        );
        assert_eq!(bad.sends().len(), 1);
    }

    // Extra (Rust port): no event of another session ever releases a held question.
    #[test]
    fn another_sessions_events_never_release() {
        let (broker, changes) = setup();
        let a = hold(&broker, &ask("s1", "tu1"));
        changes.clear();
        for name in HookEventName::ALL.iter().copied() {
            broker.observe(&tool(
                name,
                "s2",
                Some("AskUserQuestion"),
                Some("tu1"),
                None,
            ));
        }
        assert!(a.sends().is_empty());
        assert_eq!(ids(&broker), vec!["id1"]);
        assert_eq!(changes.get(), 0);
    }

    // Extra (Rust port): an answer racing a disconnect on another thread acts once.
    #[test]
    fn an_answer_racing_a_disconnect_settles_once() {
        for _ in 0..200 {
            let (broker, changes) = setup();
            let a = hold(&broker, &ask("s1", "tu1"));
            changes.clear();
            let closer = {
                let a = Arc::clone(&a);
                std::thread::spawn(move || a.close())
            };
            let result = broker.answer("id1", &pick(&[0]));
            closer.join().unwrap();
            assert!(broker.pending().is_empty());
            assert_eq!(changes.get(), 1);
            assert_eq!(a.sends().len(), usize::from(result == AnswerResult::Sent));
        }
    }
}
