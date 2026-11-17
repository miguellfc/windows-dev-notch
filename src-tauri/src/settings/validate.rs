//! The refinements of `src/shared/settings/schema.ts` (ranges, formats), plus the ports of
//! `src/shared/settings/accelerator.ts`, `src/shared/code-review/schema.ts` and
//! `src/shared/redmine/url.ts` they depend on. Only the verdict has to match zod, not the message.

use url::Url;

use crate::contract::settings::{
    CodeReviewSettingsPatch, GmailSettings, RedmineEndOfDayPatch, RedmineSettingsPatch,
    RemindersSettings, Settings, SettingsPatch, SystemAlertSettings, SETTINGS_VERSION,
    SNOOZE_MINUTES_OPTIONS,
};
use crate::contract::text::js_trim;
use crate::contract::{int_in, length};

/// The GitLab server URL is never longer than this (`GITLAB_URL_MAX`).
pub const GITLAB_URL_MAX: usize = 512;
/// The Redmine server URL is never longer than this (`REDMINE_URL_MAX`).
pub const REDMINE_URL_MAX: usize = 512;

const SHORTCUT_MAX: usize = 64;
pub const GMAIL_CLIENT_MAX: usize = 256;

const REQUIRED_MODIFIERS: [&str; 7] = [
    "Control",
    "Ctrl",
    "CommandOrControl",
    "CmdOrCtrl",
    "Alt",
    "Super",
    "Meta",
];

fn is_modifier(part: &str) -> bool {
    part == "Shift" || REQUIRED_MODIFIERS.contains(&part)
}

/// A global shortcut must include Ctrl, Alt or Win and end in a real key; otherwise it would
/// steal a plain key (or Shift+key) from every application.
pub fn is_safe_accelerator(accelerator: &str) -> bool {
    let parts: Vec<&str> = accelerator.split('+').collect();
    let Some((last, modifiers)) = parts.split_last() else {
        return false;
    };
    !is_modifier(last)
        && modifiers
            .iter()
            .any(|part| REQUIRED_MODIFIERS.contains(part))
}

/// `/^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/`: alphanumeric keys joined by `+`.
fn is_accelerator_syntax(value: &str) -> bool {
    value
        .split('+')
        .all(|part| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphanumeric()))
}

fn validate_shortcut(shortcut: &str) -> Result<(), String> {
    if length(shortcut) > SHORTCUT_MAX || !is_accelerator_syntax(shortcut) {
        return Err("Invalid shortcut".into());
    }
    if !is_safe_accelerator(shortcut) {
        return Err("Shortcut needs Ctrl, Alt or Win plus a key".into());
    }
    Ok(())
}

/// Origin + base path without a trailing `/`, or `None` when not acceptable: only `https`, no
/// credentials, no query or hash (`normalizeGitlabUrl` / `normalizeRedmineUrl`).
fn normalize_https_url(raw: &str, max: usize) -> Option<String> {
    let trimmed = js_trim(raw);
    // `trimmed.length` in JS counts UTF-16 units.
    if trimmed.is_empty() || trimmed.encode_utf16().count() > max {
        return None;
    }
    let url = Url::parse(trimmed).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    // An empty `?`/`#` parses away; any of them in the input is refused all the same.
    if url.query().is_some()
        || url.fragment().is_some()
        || trimmed.contains('?')
        || trimmed.contains('#')
    {
        return None;
    }
    let path = url.path().trim_end_matches('/');
    Some(format!("{}{path}", url.origin().ascii_serialization()))
}

/// `normalizeGitlabUrl`: the GitLab server URL in its stored form, or `None` when not acceptable.
pub fn normalize_gitlab_url(raw: &str) -> Option<String> {
    normalize_https_url(raw, GITLAB_URL_MAX)
}

/// `normalizeRedmineUrl`: the Redmine server URL in its stored form, or `None` when not
/// acceptable (only `https`, no credentials, no query or hash).
pub fn normalize_redmine_url(raw: &str) -> Option<String> {
    normalize_https_url(raw, REDMINE_URL_MAX)
}

fn is_stored_url(value: &str, max: usize) -> bool {
    value.is_empty() || normalize_https_url(value, max).as_deref() == Some(value)
}

/// True for `""` (not configured) or a GitLab URL already in its normalized form.
pub fn is_stored_gitlab_url(value: &str) -> bool {
    is_stored_url(value, GITLAB_URL_MAX)
}

/// True for `""` (not configured) or a Redmine URL already in its normalized form.
pub fn is_stored_redmine_url(value: &str) -> bool {
    is_stored_url(value, REDMINE_URL_MAX)
}

/// `/^([01]\d|2[0-3]):[0-5]\d$/`, ASCII digits only.
fn is_hh_mm(value: &str) -> bool {
    match value.as_bytes() {
        [h1, h2, b':', m1, m2] => {
            let hour_ok = match h1 {
                b'0' | b'1' => h2.is_ascii_digit(),
                b'2' => (b'0'..=b'3').contains(h2),
                _ => false,
            };
            hour_ok && (b'0'..=b'5').contains(m1) && m2.is_ascii_digit()
        }
        _ => false,
    }
}

fn validate_reminders(reminders: &RemindersSettings) -> Result<(), String> {
    if SNOOZE_MINUTES_OPTIONS.contains(&reminders.snooze_minutes) {
        Ok(())
    } else {
        Err("snoozeMinutes must be 5, 10, 15 or 30".into())
    }
}

fn validate_system_alerts(alerts: &SystemAlertSettings) -> Result<(), String> {
    int_in("cpu.percent", alerts.cpu.percent, 50, 100)?;
    int_in("cpu.sustainSeconds", alerts.cpu.sustain_seconds, 5, 300)?;
    int_in("ram.percent", alerts.ram.percent, 50, 99)?;
    int_in("battery.percent", alerts.battery.percent, 5, 50)?;
    int_in("disk.freePercent", alerts.disk.free_percent, 1, 50)
}

fn validate_gmail(gmail: &GmailSettings) -> Result<(), String> {
    if length(&gmail.client_id) > GMAIL_CLIENT_MAX
        || length(&gmail.client_secret) > GMAIL_CLIENT_MAX
    {
        return Err("Gmail client fields are too long".into());
    }
    Ok(())
}

fn validate_gitlab_url(url: &str) -> Result<(), String> {
    if length(url) > GITLAB_URL_MAX || !is_stored_gitlab_url(url) {
        return Err("GitLab URL must be empty or a normalized https URL".into());
    }
    Ok(())
}

fn validate_redmine_url(url: &str) -> Result<(), String> {
    if length(url) > REDMINE_URL_MAX || !is_stored_redmine_url(url) {
        return Err("Redmine URL must be empty or a normalized https URL".into());
    }
    Ok(())
}

fn validate_daily_target(hours: f64) -> Result<(), String> {
    if !(1.0..=24.0).contains(&hours) || (hours * 2.0).fract() != 0.0 {
        return Err("Target must be 1-24 in steps of 0.5".into());
    }
    Ok(())
}

fn validate_time(time: &str) -> Result<(), String> {
    if is_hh_mm(time) {
        Ok(())
    } else {
        Err("Time must be HH:mm".into())
    }
}

/// Everything `settingsSchema` checks beyond the shape.
pub fn validate_settings(settings: &Settings) -> Result<(), String> {
    if settings.version != SETTINGS_VERSION {
        return Err(format!("version must be {SETTINGS_VERSION}"));
    }
    validate_shortcut(&settings.shortcut)?;
    validate_reminders(&settings.reminders)?;
    validate_system_alerts(&settings.system_alerts)?;
    validate_gmail(&settings.gmail)?;
    validate_gitlab_url(&settings.code_review.gitlab_url)?;
    validate_redmine_url(&settings.redmine.url)?;
    validate_daily_target(settings.redmine.daily_target_hours)?;
    validate_time(&settings.redmine.end_of_day.time)
}

fn is_empty_patch(patch: &SettingsPatch) -> bool {
    let SettingsPatch {
        language,
        shortcut,
        launch_at_login,
        reminders,
        system_alerts,
        gmail,
        code_review,
        redmine,
    } = patch;
    language.is_none()
        && shortcut.is_none()
        && launch_at_login.is_none()
        && reminders.is_none()
        && system_alerts.is_none()
        && gmail.is_none()
        && code_review.is_none()
        && redmine.is_none()
}

/// Everything `settingsPatchSchema` checks beyond the shape, including "not empty".
pub fn validate_patch(patch: &SettingsPatch) -> Result<(), String> {
    if is_empty_patch(patch) {
        return Err("Empty settings patch".into());
    }
    if let Some(shortcut) = &patch.shortcut {
        validate_shortcut(shortcut)?;
    }
    if let Some(reminders) = &patch.reminders {
        validate_reminders(reminders)?;
    }
    if let Some(alerts) = &patch.system_alerts {
        validate_system_alerts(alerts)?;
    }
    if let Some(gmail) = &patch.gmail {
        validate_gmail(gmail)?;
    }
    if let Some(CodeReviewSettingsPatch {
        gitlab_url: Some(url),
        ..
    }) = &patch.code_review
    {
        validate_gitlab_url(url)?;
    }
    if let Some(RedmineSettingsPatch {
        url,
        daily_target_hours,
        end_of_day,
    }) = &patch.redmine
    {
        if let Some(url) = url {
            validate_redmine_url(url)?;
        }
        if let Some(hours) = daily_target_hours {
            validate_daily_target(*hours)?;
        }
        if let Some(RedmineEndOfDayPatch {
            time: Some(time), ..
        }) = end_of_day
        {
            validate_time(time)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // `gitlabUrlSchema` cases of tests/unit/shared/code-review-schema.test.ts.
    #[test]
    fn gitlab_urls_normalize_to_origin_plus_base_path_without_a_trailing_slash() {
        for (raw, normalized) in [
            ("https://gitlab.x.com/", "https://gitlab.x.com"),
            ("https://gitlab.x.com", "https://gitlab.x.com"),
            (
                "  https://GitLab.X.com/gitlab/  ",
                "https://gitlab.x.com/gitlab",
            ),
            (
                "https://gitlab.x.com:8443/a/b//",
                "https://gitlab.x.com:8443/a/b",
            ),
            ("https://gitlab.x.com:443/", "https://gitlab.x.com"),
            // JS `trim()` also removes a byte order mark.
            (
                "\u{FEFF}https://gitlab.x.com\u{FEFF}",
                "https://gitlab.x.com",
            ),
        ] {
            assert_eq!(
                normalize_gitlab_url(raw).as_deref(),
                Some(normalized),
                "{raw}"
            );
        }
        let long = format!("https://gitlab.x.com/{}", "a".repeat(600));
        for raw in [
            "http://gitlab.x.com",
            "https://user@gitlab.x.com",
            "https://user:pass@gitlab.x.com",
            "https://gitlab.x.com/?a=1",
            "https://gitlab.x.com/#top",
            "https://gitlab.x.com/?",
            "gitlab.x.com",
            "ftp://gitlab.x.com",
            "javascript:alert(1)",
            "",
            "   ",
            long.as_str(),
        ] {
            assert_eq!(normalize_gitlab_url(raw), None, "{raw}");
        }
        // 512 UTF-16 units after the trim is the limit.
        let fits = format!("https://g.x/{}", "a".repeat(512 - 12));
        assert_eq!(
            normalize_gitlab_url(&format!(" {fits} ")),
            Some(fits.clone())
        );
        assert_eq!(normalize_gitlab_url(&format!("{fits}a")), None);
    }

    // tests/unit/shared/redmine-schema.test.ts, normalizeRedmineUrl: keeps origin plus base path
    // without trailing slash.
    #[test]
    fn redmine_urls_keep_origin_plus_base_path_without_trailing_slash() {
        assert_eq!(
            normalize_redmine_url("https://r.x.com/").as_deref(),
            Some("https://r.x.com")
        );
        assert_eq!(
            normalize_redmine_url("  https://r.x.com/redmine/ ").as_deref(),
            Some("https://r.x.com/redmine")
        );
    }

    // normalizeRedmineUrl: rejects http, credentials, query, hash and over-long input.
    #[test]
    fn redmine_urls_reject_http_credentials_query_hash_and_over_long_input() {
        for raw in [
            "http://r.x.com",
            "https://u:p@r.x.com",
            "https://r.x.com?a=1",
            "https://r.x.com/#x",
            "https://r.x.com?",
            "",
            "nope",
        ] {
            assert_eq!(normalize_redmine_url(raw), None, "{raw}");
        }
        assert_eq!(
            normalize_redmine_url(&format!("https://r.x.com/{}", "a".repeat(512))),
            None
        );
    }

    // normalizeRedmineUrl: has a schema and a stored-form check. `redmineUrlSchema` is
    // `z.string().max(512)` plus this normalization.
    #[test]
    fn redmine_urls_have_a_schema_and_a_stored_form_check() {
        assert_eq!(
            normalize_redmine_url("https://r.x.com/b/").as_deref(),
            Some("https://r.x.com/b")
        );
        assert_eq!(normalize_redmine_url("http://r.x.com"), None);
        assert!(is_stored_redmine_url(""));
        assert!(is_stored_redmine_url("https://r.x.com/b"));
        assert!(!is_stored_redmine_url("https://r.x.com/b/"));
    }

    #[test]
    fn accelerators_need_a_required_modifier_and_a_real_key() {
        assert!(is_safe_accelerator("Control+Alt+Space"));
        assert!(is_safe_accelerator("Super+K"));
        assert!(!is_safe_accelerator("Space"));
        assert!(!is_safe_accelerator("Shift+A"));
        assert!(!is_safe_accelerator("Control+Shift"));
        assert!(!is_safe_accelerator(""));
    }

    #[test]
    fn accelerator_syntax_is_alphanumeric_keys_joined_by_plus() {
        assert!(is_accelerator_syntax("Control+Alt+Space"));
        assert!(is_accelerator_syntax("F4"));
        assert!(is_accelerator_syntax("Ctrl+num1"));
        assert!(!is_accelerator_syntax(""));
        assert!(!is_accelerator_syntax("+A"));
        assert!(!is_accelerator_syntax("Control+"));
        assert!(!is_accelerator_syntax("Control++A"));
        assert!(!is_accelerator_syntax("Control-Alt"));
        assert!(!is_accelerator_syntax("Control+Alt+Space "));
        assert!(!is_accelerator_syntax("Control+É"));
    }

    #[test]
    fn stored_urls_are_empty_or_normalized_https() {
        assert!(is_stored_gitlab_url(""));
        assert!(is_stored_gitlab_url("https://gitlab.example.com/group"));
        assert!(!is_stored_gitlab_url("http://gitlab.example.com"));
        assert!(!is_stored_gitlab_url("https://gitlab.example.com/"));
        assert!(is_stored_redmine_url("https://redmine.example.com:8443"));
        assert!(!is_stored_redmine_url("https://redmine.example.com:443"));
        assert!(!is_stored_redmine_url("https://u@redmine.example.com"));
    }

    #[test]
    fn times_are_24h_hh_mm() {
        assert!(is_hh_mm("00:00"));
        assert!(is_hh_mm("23:59"));
        assert!(!is_hh_mm("24:00"));
        assert!(!is_hh_mm("9:00"));
        assert!(!is_hh_mm("12:60"));
    }
}
