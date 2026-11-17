//! Pending Claude questions reaching the notch (port of 0.1.0's `question-alerts.ts`):
//! pushes the list, raises the question alert, toasts each new question once and tells the notch
//! which pending item (permission or question) arrived first. Both carry a stamp from the
//! bridge's one strictly increasing clock, so the earliest opens first.
//!
//! Concurrency: self-locking (`&self`). The two first-arrival stamps sit behind an internal
//! `Mutex` that is released before the notch, the event target or the toast is called.

use std::sync::{Arc, Mutex};

use serde_json::Value;

use super::permission_broker::lock;
use crate::contract::claude::{PendingPermission, PendingQuestionView, PendingQuestions};
use crate::contract::Validate;
use crate::notch::state::{ClaudeItem, NotchEvent, NotchMode, PANEL_MODES};

/// The event that carries the pending questions to the notch.
pub const QUESTIONS_EVENT: &str = "claude:questions";

/// The part of the notch the alerts drive.
pub trait NotchPort: Send + Sync {
    fn mode(&self) -> NotchMode;
    fn dispatch(&self, event: NotchEvent);
}

/// The notch webview as far as pushing an event goes (`EventTarget` in
/// 0.1.0's `events.ts`; renamed so it never clashes with `tauri::EventTarget`).
pub trait NotchWebview: Send + Sync {
    fn is_destroyed(&self) -> bool;
    fn send(&self, event: &str, payload: &Value);
}

/// Shows the toast of a new question; the callback runs on click.
pub type QuestionToast =
    Arc<dyn Fn(&PendingQuestionView, Arc<dyn Fn() + Send + Sync>) + Send + Sync>;

/// `QuestionAlertsOptions`.
#[derive(Clone)]
pub struct QuestionAlertsOptions {
    pub notch: Arc<dyn NotchPort>,
    /// Only the notch gets Claude's questions (never the Control Center); `None` when its window
    /// is gone.
    pub notch_target: Arc<dyn Fn() -> Option<Arc<dyn NotchWebview>> + Send + Sync>,
    pub toast: QuestionToast,
}

#[derive(Default)]
struct Firsts {
    permission_at: Option<f64>,
    question_at: Option<f64>,
}

impl Firsts {
    /// `question` iff a question exists and none of the permissions came before it.
    fn kind(&self) -> ClaudeItem {
        match (self.question_at, self.permission_at) {
            (Some(_), None) => ClaudeItem::Question,
            (Some(question), Some(permission)) if question < permission => ClaudeItem::Question,
            _ => ClaudeItem::Permission,
        }
    }
}

fn earliest(stamps: impl IntoIterator<Item = f64>) -> Option<f64> {
    stamps.into_iter().reduce(f64::min)
}

/// `createQuestionAlerts`.
pub struct QuestionAlerts {
    options: QuestionAlertsOptions,
    firsts: Mutex<Firsts>,
}

impl QuestionAlerts {
    pub fn new(options: QuestionAlertsOptions) -> Self {
        Self {
            options,
            firsts: Mutex::default(),
        }
    }

    fn dispatch_first(&self, update: impl FnOnce(&mut Firsts)) {
        let kind = {
            let mut firsts = lock(&self.firsts);
            update(&mut firsts);
            firsts.kind()
        };
        self.options
            .notch
            .dispatch(NotchEvent::ClaudeFirst { kind });
    }

    /// `emitEvent`: validated against the contract first, then sent to a live notch window.
    fn emit_questions(&self, questions: &[PendingQuestionView]) {
        let payload = PendingQuestions(questions.to_vec());
        let value = match payload.validate().map(|()| serde_json::to_value(&payload)) {
            Ok(Ok(value)) => value,
            _ => {
                log::error!("Refused to emit an event outside the contract: {QUESTIONS_EVENT}");
                return;
            }
        };
        if let Some(target) = (self.options.notch_target)() {
            if !target.is_destroyed() {
                target.send(QUESTIONS_EVENT, &value);
            }
        }
    }

    /// The pending permissions changed: call before dispatching `Attention`, so the notch knows
    /// which Claude item came first before the flag that may open it.
    pub fn on_permissions(&self, pending: &[PendingPermission]) {
        let first = earliest(pending.iter().map(|permission| permission.received_at));
        self.dispatch_first(|firsts| firsts.permission_at = first);
    }

    pub fn on_questions(&self, questions: &[PendingQuestionView]) {
        // The list goes first, so the capsule already knows what to show when the alert turns on.
        self.emit_questions(questions);
        let first = earliest(questions.iter().map(|question| question.arrived_at));
        self.dispatch_first(|firsts| firsts.question_at = first);
        self.options.notch.dispatch(NotchEvent::Question {
            on: !questions.is_empty(),
        });
    }

    pub fn on_new_question(&self, question: &PendingQuestionView) {
        // Like a permission: the open panel already shows it; otherwise tell the user even if the
        // capsule is hidden.
        if PANEL_MODES.contains(&self.options.notch.mode()) {
            return;
        }
        let notch = Arc::clone(&self.options.notch);
        (self.options.toast)(
            question,
            Arc::new(move || notch.dispatch(NotchEvent::Expand)),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::claude::{ClaudeQuestion, QuestionOption};

    type Toasted = Vec<(PendingQuestionView, Arc<dyn Fn() + Send + Sync>)>;

    #[derive(Default)]
    struct Recorder {
        order: Mutex<Vec<String>>,
        events: Mutex<Vec<NotchEvent>>,
        sent: Mutex<Vec<(String, Value)>>,
        toasts: Mutex<Toasted>,
    }

    struct FakeNotch {
        mode: NotchMode,
        recorder: Arc<Recorder>,
    }

    impl NotchPort for FakeNotch {
        fn mode(&self) -> NotchMode {
            self.mode
        }

        fn dispatch(&self, event: NotchEvent) {
            let name = format!("{event:?}");
            let kind = name
                .split([' ', '{'])
                .next()
                .unwrap_or_default()
                .to_string();
            lock(&self.recorder.order).push(format!("dispatch:{kind}"));
            lock(&self.recorder.events).push(event);
        }
    }

    struct FakeTarget {
        destroyed: bool,
        recorder: Arc<Recorder>,
    }

    impl NotchWebview for FakeTarget {
        fn is_destroyed(&self) -> bool {
            self.destroyed
        }

        fn send(&self, event: &str, payload: &Value) {
            lock(&self.recorder.sent).push((event.into(), payload.clone()));
            lock(&self.recorder.order).push(format!("send:{event}"));
        }
    }

    fn question() -> PendingQuestionView {
        let option = |label: &str| QuestionOption {
            label: label.into(),
            description: String::new(),
        };
        PendingQuestionView {
            id: "q1".into(),
            project: "my-project".into(),
            arrived_at: 1.0,
            questions: vec![ClaudeQuestion {
                question: "SECRET-QUESTION?".into(),
                header: "Pick".into(),
                multi_select: false,
                options: vec![option("A"), option("B")],
            }],
        }
    }

    fn setup_with(mode: NotchMode, destroyed: bool) -> (QuestionAlerts, Arc<Recorder>) {
        let recorder = Arc::new(Recorder::default());
        let notch = Arc::new(FakeNotch {
            mode,
            recorder: Arc::clone(&recorder),
        });
        let target: Arc<dyn NotchWebview> = Arc::new(FakeTarget {
            destroyed,
            recorder: Arc::clone(&recorder),
        });
        let toasts = Arc::clone(&recorder);
        let alerts = QuestionAlerts::new(QuestionAlertsOptions {
            notch,
            notch_target: Arc::new(move || Some(Arc::clone(&target))),
            toast: Arc::new(move |question, on_click| {
                lock(&toasts.toasts).push((question.clone(), on_click));
            }),
        });
        (alerts, recorder)
    }

    fn setup(mode: NotchMode) -> (QuestionAlerts, Arc<Recorder>) {
        setup_with(mode, false)
    }

    fn firsts(recorder: &Recorder) -> Vec<ClaudeItem> {
        lock(&recorder.events)
            .iter()
            .filter_map(|event| match event {
                NotchEvent::ClaudeFirst { kind } => Some(*kind),
                _ => None,
            })
            .collect()
    }

    fn permission(received_at: f64) -> PendingPermission {
        PendingPermission {
            id: "p".into(),
            session_id: "s".into(),
            session_name: "n".into(),
            tool_name: "Bash".into(),
            preview: String::new(),
            preview_truncated: false,
            preview_length: 0.0,
            received_at,
        }
    }

    #[test]
    fn sends_the_list_to_the_notch_before_turning_the_question_alert_on_or_off() {
        let (alerts, recorder) = setup(NotchMode::Compact);
        alerts.on_questions(&[question()]);
        alerts.on_questions(&[]);
        assert_eq!(
            *lock(&recorder.sent),
            vec![
                (
                    QUESTIONS_EVENT.to_string(),
                    serde_json::to_value(vec![question()]).unwrap()
                ),
                (QUESTIONS_EVENT.to_string(), Value::Array(vec![])),
            ]
        );
        let flags: Vec<NotchEvent> = lock(&recorder.events)
            .iter()
            .filter(|event| matches!(event, NotchEvent::Question { .. }))
            .copied()
            .collect();
        assert_eq!(
            flags,
            vec![
                NotchEvent::Question { on: true },
                NotchEvent::Question { on: false }
            ]
        );
        assert_eq!(
            *lock(&recorder.order),
            vec![
                "send:claude:questions",
                "dispatch:ClaudeFirst",
                "dispatch:Question",
                "send:claude:questions",
                "dispatch:ClaudeFirst",
                "dispatch:Question",
            ]
        );
    }

    // TS sends a view with a stray `sessionId`, which Rust's type cannot carry; a header over the
    // contract's limit is the Rust way to step outside it.
    #[test]
    fn never_sends_a_list_outside_the_contract() {
        crate::services::test_log::capture().expect("the test logger");
        let (alerts, recorder) = setup(NotchMode::Compact);
        let mut outside = question();
        outside.questions[0].header = format!("SECRET-HEADER{}", "x".repeat(60));
        alerts.on_questions(&[outside]);
        assert!(lock(&recorder.sent).is_empty());
        let lines = crate::services::test_log::capture()
            .expect("the test logger")
            .lines();
        assert!(lines
            .iter()
            .any(|line| line.contains("outside the contract")));
        assert!(lines.iter().all(|line| !line.contains("SECRET")));
    }

    #[test]
    fn toasts_a_new_question_with_the_panel_closed_a_click_opens_the_panel() {
        let (alerts, recorder) = setup(NotchMode::Alert);
        alerts.on_new_question(&question());
        let on_click = {
            let toasts = lock(&recorder.toasts);
            assert_eq!(toasts.len(), 1);
            assert_eq!(toasts[0].0, question());
            Arc::clone(&toasts[0].1)
        };
        on_click();
        assert_eq!(*lock(&recorder.events), vec![NotchEvent::Expand]);
    }

    #[test]
    fn does_not_toast_while_a_panel_is_open() {
        for mode in [NotchMode::Expanded, NotchMode::Permission, NotchMode::Gmail] {
            let (alerts, recorder) = setup(mode);
            alerts.on_new_question(&question());
            assert!(lock(&recorder.toasts).is_empty(), "{mode:?}");
        }
    }

    #[test]
    fn skips_a_destroyed_notch_window() {
        let (alerts, recorder) = setup_with(NotchMode::Compact, true);
        alerts.on_questions(&[question()]);
        assert!(lock(&recorder.sent).is_empty());
        assert!(lock(&recorder.events).contains(&NotchEvent::Question { on: true }));
    }

    #[test]
    fn tells_the_notch_the_kind_of_the_earliest_item_whenever_either_list_changes() {
        let (alerts, recorder) = setup(NotchMode::Compact);
        alerts.on_permissions(&[permission(5.0), permission(2.0)]);
        alerts.on_questions(&[PendingQuestionView {
            arrived_at: 3.0,
            ..question()
        }]);
        alerts.on_permissions(&[permission(5.0)]);
        alerts.on_questions(&[]);
        alerts.on_permissions(&[]);
        use ClaudeItem::*;
        assert_eq!(
            firsts(&recorder),
            vec![Permission, Permission, Question, Permission, Permission]
        );
    }

    #[test]
    fn counts_the_earliest_question_of_the_list_whatever_its_position() {
        let (alerts, recorder) = setup(NotchMode::Compact);
        alerts.on_permissions(&[permission(4.0)]);
        alerts.on_questions(&[
            PendingQuestionView {
                arrived_at: 6.0,
                ..question()
            },
            PendingQuestionView {
                id: "q2".into(),
                arrived_at: 1.0,
                ..question()
            },
        ]);
        assert_eq!(firsts(&recorder).last(), Some(&ClaudeItem::Question));
    }
}
