//! The user-facing texts the Rust side shows itself (the tray menu, the reminder toasts). They come from
//! `src/shared/i18n/messages.ts` through `tests/parity/i18n-main.json`, generated and checked by
//! `tests/unit/shared/parity.test.ts`.

use std::collections::HashMap;
use std::sync::OnceLock;

use crate::contract::settings::Language;

type Messages = HashMap<String, HashMap<String, String>>;

fn messages() -> &'static Messages {
    static MESSAGES: OnceLock<Messages> = OnceLock::new();
    MESSAGES.get_or_init(|| {
        serde_json::from_str(include_str!("../../tests/parity/i18n-main.json"))
            .expect("tests/parity/i18n-main.json is valid")
    })
}

/// The text of `key` in `language`; the key itself if it is missing (a programming error the
/// tests catch), like a missing translation would show in the renderer.
pub fn t(language: Language, key: &str) -> String {
    messages()
        .get(language.as_str())
        .and_then(|texts| texts.get(key))
        .cloned()
        .unwrap_or_else(|| {
            log::error!("Missing message {key} for {}", language.as_str());
            key.to_owned()
        })
}

/// [`t`] with `{name}` placeholders replaced by `params`, like `translate()` in
/// `src/shared/i18n/messages.ts`: a placeholder without a param stays as written.
pub fn t_with(language: Language, key: &str, params: &[(&str, String)]) -> String {
    substitute(&t(language, key), params)
}

/// `template.replace(/\{(\w+)\}/g, ...)`: `\w` is `[A-Za-z0-9_]` (no `u` flag) and values are
/// inserted verbatim, never scanned again.
fn substitute(template: &str, params: &[(&str, String)]) -> String {
    let is_word = |c: char| c.is_ascii_alphanumeric() || c == '_';
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let name_len = after.find(|c: char| !is_word(c)).unwrap_or(after.len());
        let name = &after[..name_len];
        let closed = after[name_len..].starts_with('}');
        let value = params
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| value);
        match value {
            Some(value) if closed && !name.is_empty() => {
                out.push_str(value);
                rest = &after[name_len + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_language_has_the_same_keys() {
        let all = messages();
        for language in Language::ALL {
            assert!(all.contains_key(language.as_str()), "{}", language.as_str());
        }
        let mut es: Vec<_> = all["es"].keys().collect();
        let mut en: Vec<_> = all["en"].keys().collect();
        es.sort();
        en.sort();
        assert_eq!(es, en);
        assert!(!es.is_empty());
    }

    #[test]
    fn translates_and_falls_back_to_the_key() {
        assert_eq!(t(Language::Es, "tray.quit"), "Salir");
        assert_eq!(t(Language::En, "tray.quit"), "Quit");
        assert_eq!(t(Language::En, "tray.nope"), "tray.nope");
    }

    #[test]
    fn t_with_replaces_count_in_es_and_en() {
        let count = [("count", "3".to_owned())];
        assert_eq!(
            t_with(Language::Es, "reminders.toast.titleMany", &count),
            "3 recordatorios"
        );
        assert_eq!(
            t_with(Language::En, "reminders.toast.titleMany", &count),
            "3 reminders"
        );
        assert_eq!(
            t_with(Language::Es, "reminders.toast.missedMany", &count),
            "Tienes 3 recordatorios perdidos"
        );
        // Without the param the placeholder stays, like `translate()`.
        assert_eq!(
            t_with(Language::En, "reminders.toast.titleMany", &[]),
            "{count} reminders"
        );
        // No placeholder: same as `t`.
        assert_eq!(
            t_with(Language::En, "reminders.toast.title", &count),
            "Reminder"
        );
    }

    #[test]
    fn t_with_reads_the_claude_toast_texts_in_es_and_en() {
        assert_eq!(
            t_with(Language::Es, "claude.toast.title", &[]),
            "Claude espera permiso"
        );
        assert_eq!(
            t_with(Language::En, "claude.toast.title", &[]),
            "Claude needs permission"
        );
        assert_eq!(
            t_with(Language::Es, "claude.toast.question", &[]),
            "Claude te pregunta"
        );
        assert_eq!(
            t_with(Language::En, "claude.toast.question", &[]),
            "Claude asks"
        );
    }

    #[test]
    fn substitute_follows_the_translate_regex() {
        let params = [("a", "1".to_owned()), ("b_2", "x".to_owned())];
        assert_eq!(substitute("{a}-{b_2}-{c}", &params), "1-x-{c}");
        // `\w+` needs at least one word character; anything else is left as is.
        assert_eq!(substitute("{}{ a}{a }{{a}}", &params), "{}{ a}{a }{1}");
        assert_eq!(substitute("{a", &params), "{a");
        // A value is inserted verbatim, never re-scanned.
        let nested = [("a", "{b_2}".to_owned()), ("b_2", "no".to_owned())];
        assert_eq!(substitute("{a}", &nested), "{b_2}");
        assert_eq!(substitute("ñ{a}é", &params), "ñ1é");
    }
}
