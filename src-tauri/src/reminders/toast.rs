//! Port of `src/main/reminders/reminder-toast.ts`: what the Windows toast says for a batch that
//! just came due or for the reminders missed while the app was closed. Silent (the notch plays
//! its own chime) and without buttons (Task 0 verdict B: Windows did not reliably deliver button
//! clicks, so Snooze and Complete live in the notch view the click opens).

use std::sync::Arc;

use crate::contract::reminders::Reminder;

/// What the platform adapter turns into a Windows toast.
pub struct ToastRequest {
    pub title: String,
    pub body: String,
    /// Always `true`.
    pub silent: bool,
    /// Clicking the toast body.
    pub on_click: Arc<dyn Fn() + Send + Sync>,
}

/// One toast per batch (the runtime's `toast` option).
pub trait ToastSink: Send + Sync {
    /// One toast for a whole batch that just became due.
    fn fired(&self, batch: &[Reminder]);
    /// One toast for the reminders missed while the app was closed or the PC asleep.
    fn missed(&self, count: usize);
}

pub type Notify = Box<dyn Fn(ToastRequest) + Send + Sync>;
/// `translate(key, params)` in the current settings language.
pub type Translate = Box<dyn Fn(&str, &[(&str, String)]) -> String + Send + Sync>;

const BODY_TEXTS: usize = 2;

pub struct ReminderToast {
    notify: Notify,
    translate: Translate,
    on_click: Arc<dyn Fn() + Send + Sync>,
}

impl ReminderToast {
    pub fn new(
        notify: Notify,
        translate: Translate,
        on_click: Arc<dyn Fn() + Send + Sync>,
    ) -> Self {
        Self {
            notify,
            translate,
            on_click,
        }
    }

    fn show(&self, title: String, body: String) {
        (self.notify)(ToastRequest {
            title,
            body,
            silent: true,
            on_click: Arc::clone(&self.on_click),
        });
    }
}

impl ToastSink for ReminderToast {
    fn fired(&self, batch: &[Reminder]) {
        match batch {
            [] => {}
            [only] => self.show(
                (self.translate)("reminders.toast.title", &[]),
                only.text.as_str().to_owned(),
            ),
            _ => self.show(
                (self.translate)(
                    "reminders.toast.titleMany",
                    &[("count", batch.len().to_string())],
                ),
                batch
                    .iter()
                    .take(BODY_TEXTS)
                    .map(|r| r.text.as_str())
                    .collect::<Vec<_>>()
                    .join(" · "),
            ),
        }
    }

    fn missed(&self, count: usize) {
        if count == 0 {
            return;
        }
        let body = if count == 1 {
            (self.translate)("reminders.toast.missedOne", &[])
        } else {
            (self.translate)(
                "reminders.toast.missedMany",
                &[("count", count.to_string())],
            )
        };
        self.show((self.translate)("reminders.toast.missedTitle", &[]), body);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use super::*;
    use crate::contract::reminders::{ReminderRepeat, ReminderState, ReminderText};
    use crate::contract::settings::Language;
    use crate::i18n::t_with;

    fn reminder(n: usize, text: &str) -> Reminder {
        Reminder {
            id: format!("3f2c8a1e-5b7d-4c9e-8f10-2a3b4c5d6e7{n}"),
            text: ReminderText::new(text).unwrap(),
            due_at: "2026-11-10T10:00:00.000Z".into(),
            repeat: ReminderRepeat::None,
            local_time: None,
            state: ReminderState::Due,
            created_at: "2026-11-10T09:00:00.000Z".into(),
            completed_at: None,
        }
    }

    struct Fx {
        toast: ReminderToast,
        shown: Arc<Mutex<Vec<ToastRequest>>>,
        clicks: Arc<AtomicUsize>,
    }

    impl Fx {
        fn new(language: Language) -> Self {
            let shown = Arc::new(Mutex::new(Vec::new()));
            let clicks = Arc::new(AtomicUsize::new(0));
            let toast = ReminderToast::new(
                {
                    let shown = Arc::clone(&shown);
                    Box::new(move |request| shown.lock().unwrap().push(request))
                },
                Box::new(move |key, params| t_with(language, key, params)),
                {
                    let clicks = Arc::clone(&clicks);
                    Arc::new(move || {
                        clicks.fetch_add(1, Ordering::SeqCst);
                    })
                },
            );
            Self {
                toast,
                shown,
                clicks,
            }
        }

        fn count(&self) -> usize {
            self.shown.lock().unwrap().len()
        }

        /// The last request's title, body and silent flag.
        fn last(&self) -> (String, String, bool) {
            let shown = self.shown.lock().unwrap();
            let last = shown.last().expect("a toast");
            (last.title.clone(), last.body.clone(), last.silent)
        }

        fn click_last(&self) {
            let on_click = Arc::clone(&self.shown.lock().unwrap().last().unwrap().on_click);
            on_click();
        }

        fn clicks(&self) -> usize {
            self.clicks.load(Ordering::SeqCst)
        }
    }

    fn texts(title: &str, body: &str) -> (String, String, bool) {
        (title.into(), body.into(), true)
    }

    #[test]
    fn shows_a_single_reminder_with_its_text_as_the_body() {
        let fx = Fx::new(Language::Es);
        fx.toast.fired(&[reminder(1, "Revisar PR")]);
        assert_eq!(fx.count(), 1);
        assert_eq!(fx.last(), texts("Recordatorio", "Revisar PR"));
    }

    #[test]
    fn groups_several_reminders_into_one_toast_with_the_first_two_texts() {
        let fx = Fx::new(Language::Es);
        fx.toast.fired(&[
            reminder(1, "Revisar PR"),
            reminder(2, "Llamar a Ana"),
            reminder(3, "Desplegar"),
        ]);
        assert_eq!(fx.count(), 1);
        assert_eq!(
            fx.last(),
            texts("3 recordatorios", "Revisar PR · Llamar a Ana")
        );
        assert!(!fx.last().1.contains("Desplegar"));
    }

    #[test]
    fn uses_the_current_language() {
        let fx = Fx::new(Language::En);
        fx.toast.fired(&[reminder(1, "Review PR")]);
        assert_eq!(fx.last(), texts("Reminder", "Review PR"));
        fx.toast
            .fired(&[reminder(1, "Review PR"), reminder(2, "Call Ana")]);
        assert_eq!(fx.last(), texts("2 reminders", "Review PR · Call Ana"));
    }

    #[test]
    fn summarizes_missed_reminders_by_count_only() {
        let es = Fx::new(Language::Es);
        es.toast.missed(4);
        assert_eq!(
            es.last(),
            texts("Recordatorios perdidos", "Tienes 4 recordatorios perdidos")
        );

        let en = Fx::new(Language::En);
        en.toast.missed(4);
        assert_eq!(
            en.last(),
            texts("Missed reminders", "You have 4 missed reminders")
        );
        en.toast.missed(1);
        assert_eq!(en.last().1, "You have 1 missed reminder");
    }

    #[test]
    fn has_no_buttons_the_toast_only_carries_title_body_silent_and_the_click() {
        let fx = Fx::new(Language::Es);
        fx.toast.fired(&[reminder(1, "Revisar PR")]);
        // Exhaustive destructuring: a new field (e.g. buttons) would not compile here.
        let shown = fx.shown.lock().unwrap();
        let ToastRequest {
            title,
            body,
            silent,
            on_click: _,
        } = shown.last().unwrap();
        assert_eq!(
            (title.as_str(), body.as_str(), *silent),
            ("Recordatorio", "Revisar PR", true)
        );
    }

    #[test]
    fn does_nothing_for_an_empty_batch_or_zero_missed() {
        let fx = Fx::new(Language::Es);
        fx.toast.fired(&[]);
        fx.toast.missed(0);
        assert_eq!(fx.count(), 0);
    }

    #[test]
    fn clicking_the_body_runs_the_open_callback() {
        let fx = Fx::new(Language::Es);
        fx.toast.fired(&[reminder(1, "Revisar PR")]);
        assert_eq!(fx.clicks(), 0);
        fx.click_last();
        assert_eq!(fx.clicks(), 1);
        fx.toast.missed(2);
        fx.click_last();
        assert_eq!(fx.clicks(), 2);
    }
}
