//! The user-facing texts the Rust side shows itself (the tray menu). They come from
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
}
