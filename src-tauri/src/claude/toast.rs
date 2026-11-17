//! The informational toasts of new Claude permissions and questions (port of
//! 0.1.0's `toast.ts`). They carry only a translated title and the session's project name:
//! never the command, the tool input, the question or its options, and no buttons.

use std::sync::Arc;

use crate::contract::claude::{PendingPermission, PendingQuestionView};

/// Runs when the toast's body is clicked.
pub type OnClick = Arc<dyn Fn() + Send + Sync>;

/// `ToastRequest`.
pub struct ToastRequest {
    pub title: String,
    pub body: String,
    pub on_click: OnClick,
}

/// Shows a toast (the integration plays the default Windows sound, like Electron's Notification).
pub type Notify = Arc<dyn Fn(ToastRequest) + Send + Sync>;
/// The text of a message key in the current language.
pub type Translate = Arc<dyn Fn(&str) -> String + Send + Sync>;

/// `createPermissionToast` and `createQuestionToast`.
#[derive(Clone)]
pub struct ClaudeToasts {
    notify: Notify,
    translate: Translate,
}

impl ClaudeToasts {
    pub fn new(notify: Notify, translate: Translate) -> Self {
        Self { notify, translate }
    }

    pub fn show_permission(&self, permission: &PendingPermission, on_click: OnClick) {
        (self.notify)(ToastRequest {
            title: (self.translate)("claude.toast.title"),
            body: permission.session_name.clone(),
            on_click,
        });
    }

    pub fn show_question(&self, question: &PendingQuestionView, on_click: OnClick) {
        (self.notify)(ToastRequest {
            title: (self.translate)("claude.toast.question"),
            body: question.project.clone(),
            on_click,
        });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::contract::claude::{ClaudeQuestion, QuestionOption};
    use crate::contract::settings::Language;

    fn permission() -> PendingPermission {
        PendingPermission {
            id: "p1".into(),
            session_id: "s1".into(),
            session_name: "mi-proyecto".into(),
            tool_name: "Bash".into(),
            preview: "rm -rf secret-command".into(),
            preview_truncated: false,
            preview_length: 21.0,
            received_at: 1.0,
        }
    }

    fn question() -> PendingQuestionView {
        let option = |label: &str| QuestionOption {
            label: label.into(),
            description: String::new(),
        };
        PendingQuestionView {
            id: "q1".into(),
            project: "mi-proyecto".into(),
            arrived_at: 1.0,
            questions: vec![ClaudeQuestion {
                question: "SECRET-QUESTION?".into(),
                header: "Pick".into(),
                multi_select: false,
                options: vec![option("SECRET-OPTION"), option("B")],
            }],
        }
    }

    type Shown = Arc<Mutex<Vec<ToastRequest>>>;

    fn toasts(texts: &'static [(&'static str, &'static str)]) -> (ClaudeToasts, Shown) {
        let shown: Shown = Arc::default();
        let sink = Arc::clone(&shown);
        let toasts = ClaudeToasts::new(
            Arc::new(move |request| sink.lock().unwrap().push(request)),
            Arc::new(move |key: &str| {
                texts
                    .iter()
                    .find(|(k, _)| *k == key)
                    .map_or_else(|| key.to_string(), |(_, text)| (*text).to_string())
            }),
        );
        (toasts, shown)
    }

    fn counter() -> (Arc<AtomicUsize>, OnClick) {
        let clicks = Arc::new(AtomicUsize::new(0));
        let count = Arc::clone(&clicks);
        (
            clicks,
            Arc::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
            }),
        )
    }

    #[test]
    fn shows_title_and_session_name_without_the_command() {
        let (toasts, shown) = toasts(&[("claude.toast.title", "Claude espera permiso")]);
        toasts.show_permission(&permission(), Arc::new(|| {}));
        let shown = shown.lock().unwrap();
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].title, "Claude espera permiso");
        assert_eq!(shown[0].body, "mi-proyecto");
        let text = format!("{}{}", shown[0].title, shown[0].body);
        assert!(!text.contains("secret-command"));
        assert!(!text.contains("Bash"));
    }

    #[test]
    fn invokes_the_callback_on_click() {
        let (toasts, shown) = toasts(&[]);
        let (clicks, on_click) = counter();
        toasts.show_permission(&permission(), on_click);
        assert_eq!(clicks.load(Ordering::SeqCst), 0);
        let click = Arc::clone(&shown.lock().unwrap()[0].on_click);
        click();
        assert_eq!(clicks.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn shows_the_question_title_and_the_project_never_the_question_or_its_options() {
        let (toasts, shown) = toasts(&[("claude.toast.question", "Claude te pregunta")]);
        let (clicks, on_click) = counter();
        toasts.show_question(&question(), on_click);
        let click = {
            let shown = shown.lock().unwrap();
            assert_eq!(shown.len(), 1);
            assert_eq!(shown[0].title, "Claude te pregunta");
            assert_eq!(shown[0].body, "mi-proyecto");
            assert!(!format!("{}{}", shown[0].title, shown[0].body).contains("SECRET"));
            Arc::clone(&shown[0].on_click)
        };
        click();
        assert_eq!(clicks.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn has_both_translations() {
        assert_eq!(
            crate::i18n::t(Language::Es, "claude.toast.question"),
            "Claude te pregunta"
        );
        assert_eq!(
            crate::i18n::t(Language::En, "claude.toast.question"),
            "Claude asks"
        );
    }
}
