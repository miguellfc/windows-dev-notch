//! `createDefaultSettings` / `languageFromLocale` (`src/shared/settings/schema.ts`).

use crate::contract::settings::*;

/// `languageFromLocale`: Spanish locales get Spanish, everything else English.
pub fn language_from_locale(locale: &str) -> Language {
    if locale.to_lowercase().starts_with("es") {
        Language::Es
    } else {
        Language::En
    }
}

/// `cloneDefaultIntegrations`: all on but the work log (opt-in), capsule only where it exists, the default palette colors.
pub fn default_integrations() -> IntegrationsSettings {
    let entry = |capsule: bool, color: PaletteColor| IntegrationSettings {
        enabled: true,
        capsule,
        color: IntegrationColor::Palette(color),
    };
    IntegrationsSettings {
        claude: entry(true, PaletteColor::Clay),
        github: entry(true, PaletteColor::Green),
        gitlab: entry(true, PaletteColor::Orange),
        gmail: entry(true, PaletteColor::Salmon),
        redmine: entry(true, PaletteColor::Pink),
        work_log: IntegrationSettings {
            enabled: false,
            ..entry(true, PaletteColor::Cyan)
        },
        reminders: entry(false, PaletteColor::Blue),
        notes: entry(false, PaletteColor::Violet),
    }
}

/// `createDefaultSettings`.
pub fn default_settings(locale: &str) -> Settings {
    let alert = CodeReviewAlertSettings {
        enabled: true,
        sound: true,
    };
    Settings {
        version: SETTINGS_VERSION,
        language: language_from_locale(locale),
        shortcut: "Control+Alt+Space".into(),
        launch_at_login: false,
        reminders: RemindersSettings {
            snooze_minutes: 10,
            sound: true,
        },
        system_alerts: SystemAlertSettings {
            cpu: CpuAlertSettings {
                enabled: true,
                percent: 90,
                sustain_seconds: 30,
            },
            ram: PercentAlertSettings {
                enabled: true,
                percent: 90,
            },
            battery: PercentAlertSettings {
                enabled: true,
                percent: 15,
            },
            disk: DiskAlertSettings {
                enabled: true,
                free_percent: 10,
            },
        },
        gmail: GmailSettings {
            client_id: String::new(),
            client_secret: String::new(),
            alerts: GmailAlertSettings {
                enabled: true,
                hide_content: false,
                sound: true,
            },
        },
        code_review: CodeReviewSettings {
            gitlab_url: String::new(),
            alerts: CodeReviewAlerts {
                github: alert,
                gitlab: alert,
            },
        },
        redmine: RedmineSettings {
            url: String::new(),
            daily_target_hours: 8.0,
            end_of_day: RedmineEndOfDaySettings {
                enabled: true,
                time: "18:00".into(),
                sound: true,
            },
        },
        work_log: WorkLogSettings::default(),
        integrations: default_integrations(),
        claude_accounts: ClaudeAccountsSettings::default(),
    }
}
