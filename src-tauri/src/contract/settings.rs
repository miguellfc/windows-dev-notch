//! `settings:*` channels and `settings:changed` (`src/shared/settings/schema.ts`).
//!
//! The ranges live in [`crate::settings::validate`]; these types only carry the shapes.

use serde::{Deserialize, Serialize};

use super::{present, Validate};
use crate::settings::validate::{validate_patch, validate_settings};

/// Current settings file version (`SETTINGS_VERSION`). v9 dropped `integrations.system`; v10
/// adds `claudeAccounts`.
pub const SETTINGS_VERSION: u32 = 10;

/// `SNOOZE_MINUTES_OPTIONS`.
pub const SNOOZE_MINUTES_OPTIONS: [u32; 4] = [5, 10, 15, 30];

string_enum! {
    /// `languageSchema`.
    pub enum Language {
        Es = "es",
        En = "en",
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RemindersSettings {
    pub snooze_minutes: u32,
    pub sound: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CpuAlertSettings {
    pub enabled: bool,
    pub percent: u32,
    pub sustain_seconds: u32,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PercentAlertSettings {
    pub enabled: bool,
    pub percent: u32,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DiskAlertSettings {
    pub enabled: bool,
    pub free_percent: u32,
}

/// Thresholds of the capsule's system alerts.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SystemAlertSettings {
    pub cpu: CpuAlertSettings,
    pub ram: PercentAlertSettings,
    pub battery: PercentAlertSettings,
    pub disk: DiskAlertSettings,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GmailAlertSettings {
    pub enabled: bool,
    pub hide_content: bool,
    pub sound: bool,
}

/// OAuth desktop client (empty means Gmail is not configured) and the alerts. `Debug` never
/// prints the client.
#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct GmailSettings {
    pub client_id: String,
    pub client_secret: String,
    pub alerts: GmailAlertSettings,
}

redacted_debug!(GmailSettings, |this| {
    "has_client_id": !this.client_id.is_empty(),
    "has_client_secret": !this.client_secret.is_empty(),
    "alerts": this.alerts,
});

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodeReviewAlertSettings {
    pub enabled: bool,
    pub sound: bool,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodeReviewAlerts {
    pub github: CodeReviewAlertSettings,
    pub gitlab: CodeReviewAlertSettings,
}

/// GitLab server (`""` = not configured; stored normalized, https only) and the alerts.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodeReviewSettings {
    pub gitlab_url: String,
    pub alerts: CodeReviewAlerts,
}

/// End-of-day alert: weekdays at `time` (local `HH:mm`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RedmineEndOfDaySettings {
    pub enabled: bool,
    pub time: String,
    pub sound: bool,
}

/// Redmine server (`""` = not configured), daily target (1-24 in 0.5 steps) and the alert.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RedmineSettings {
    pub url: String,
    pub daily_target_hours: f64,
    pub end_of_day: RedmineEndOfDaySettings,
}

/// `integrationColorIds` (`src/shared/integrations/colors.ts`): the 21 palette ids, in display
/// order.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum PaletteColor {
    Pistachio,
    Lime,
    Green,
    Emerald,
    Teal,
    Cyan,
    Sky,
    Blue,
    Cobalt,
    Indigo,
    Violet,
    Lavender,
    Plum,
    Fuchsia,
    Pink,
    Salmon,
    Peach,
    Orange,
    Amber,
    Clay,
    Sand,
}

/// `IntegrationColor`: a palette id (`"green"`) or a custom color, stored as uppercase
/// `"#RRGGBB"` (`HEX_COLOR`). Anything else is rejected, lowercase hex included.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum IntegrationColor {
    Palette(PaletteColor),
    Hex([u8; 3]),
}

impl IntegrationColor {
    /// Parses `#RRGGBB` with uppercase hex digits only (`/^#[0-9A-F]{6}$/`).
    fn parse_hex(text: &str) -> Option<[u8; 3]> {
        let digits = text.strip_prefix('#')?;
        if digits.len() != 6
            || !digits
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
        {
            return None;
        }
        let byte = |i: usize| u8::from_str_radix(&digits[i..i + 2], 16).ok();
        Some([byte(0)?, byte(2)?, byte(4)?])
    }
}

impl Serialize for IntegrationColor {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Palette(color) => color.serialize(serializer),
            Self::Hex([r, g, b]) => serializer.serialize_str(&format!("#{r:02X}{g:02X}{b:02X}")),
        }
    }
}

impl<'de> Deserialize<'de> for IntegrationColor {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        if let Some(rgb) = Self::parse_hex(&text) {
            return Ok(Self::Hex(rgb));
        }
        PaletteColor::deserialize(serde::de::value::StrDeserializer::<D::Error>::new(&text))
            .map(Self::Palette)
            .map_err(|_| {
                serde::de::Error::custom(format!(
                    "invalid color {text:?}: expected a palette id or #RRGGBB"
                ))
            })
    }
}

/// `integrationSettingsSchema`: on/off, whether it shows in the capsule, and its color.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct IntegrationSettings {
    pub enabled: bool,
    pub capsule: bool,
    pub color: IntegrationColor,
}

/// `integrationsSettingsSchema` (v9): the seven integrations, in `integrationKeys` order. Only
/// claude, github, gitlab, gmail and redmine may have `capsule: true` (checked in `validate`).
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct IntegrationsSettings {
    pub claude: IntegrationSettings,
    pub github: IntegrationSettings,
    pub gitlab: IntegrationSettings,
    pub gmail: IntegrationSettings,
    pub redmine: IntegrationSettings,
    pub reminders: IntegrationSettings,
    pub notes: IntegrationSettings,
}

/// `claudeAccountsSettingsSchema` (v10): the Claude Code accounts (config folders) the notch
/// installs its hooks in. Only main changes it (the `claude:*` account channels), never a
/// `settings:update` patch.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ClaudeAccountsSettings {
    /// Ids of the accounts whose hooks the user installed.
    pub linked: Vec<String>,
    /// Folders added by hand ("Otra carpeta…").
    pub extra_dirs: Vec<String>,
    /// The first start after the update has linked `~/.claude` when it already had our hooks.
    pub initialized: bool,
}

/// `settingsSchema`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Settings {
    pub version: u32,
    pub language: Language,
    pub shortcut: String,
    pub launch_at_login: bool,
    pub reminders: RemindersSettings,
    pub system_alerts: SystemAlertSettings,
    pub gmail: GmailSettings,
    pub code_review: CodeReviewSettings,
    pub redmine: RedmineSettings,
    pub integrations: IntegrationsSettings,
    pub claude_accounts: ClaudeAccountsSettings,
}

impl Validate for Settings {
    fn validate(&self) -> Result<(), String> {
        validate_settings(self)
    }
}

/// `codeReviewSettingsSchema.partial()`: merged one level deep by the store.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CodeReviewSettingsPatch {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub gitlab_url: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub alerts: Option<CodeReviewAlerts>,
}

/// `redmineEndOfDaySettingsSchema.partial()`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RedmineEndOfDayPatch {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub enabled: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub time: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub sound: Option<bool>,
}

/// Redmine settings, partial, with `endOfDay` partial one level further down.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RedmineSettingsPatch {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub url: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub daily_target_hours: Option<f64>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub end_of_day: Option<RedmineEndOfDayPatch>,
}

/// `integrationSettingsSchema.partial()`.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct IntegrationSettingsPatch {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub enabled: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub capsule: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub color: Option<IntegrationColor>,
}

/// The `integrations` patch: per integration and per field, so recoloring one never touches the
/// others. `capsule` is only checked on the merged settings.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct IntegrationsPatch {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub claude: Option<IntegrationSettingsPatch>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub github: Option<IntegrationSettingsPatch>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub gitlab: Option<IntegrationSettingsPatch>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub gmail: Option<IntegrationSettingsPatch>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub redmine: Option<IntegrationSettingsPatch>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub reminders: Option<IntegrationSettingsPatch>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub notes: Option<IntegrationSettingsPatch>,
}

/// `settingsPatchSchema`: any non-empty subset of the user fields, never `version`.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SettingsPatch {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub language: Option<Language>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub shortcut: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub launch_at_login: Option<bool>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub reminders: Option<RemindersSettings>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub system_alerts: Option<SystemAlertSettings>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub gmail: Option<GmailSettings>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub code_review: Option<CodeReviewSettingsPatch>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub redmine: Option<RedmineSettingsPatch>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    pub integrations: Option<IntegrationsPatch>,
}

impl Validate for SettingsPatch {
    fn validate(&self) -> Result<(), String> {
        validate_patch(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Result<IntegrationColor, serde_json::Error> {
        serde_json::from_value(serde_json::Value::String(text.to_owned()))
    }

    #[test]
    fn integration_color_round_trips_palette_ids_and_hex() {
        for (text, color) in [
            ("green", IntegrationColor::Palette(PaletteColor::Green)),
            ("sand", IntegrationColor::Palette(PaletteColor::Sand)),
            ("#A3B18A", IntegrationColor::Hex([0xA3, 0xB1, 0x8A])),
            ("#000000", IntegrationColor::Hex([0, 0, 0])),
            ("#FFFFFF", IntegrationColor::Hex([0xFF, 0xFF, 0xFF])),
        ] {
            assert_eq!(parse(text).unwrap(), color, "{text}");
            assert_eq!(
                serde_json::to_value(color).unwrap(),
                serde_json::Value::String(text.to_owned())
            );
        }
    }

    #[test]
    fn integration_color_rejects_malformed_strings() {
        for text in [
            "#4ade80", "#4ADE8a", "#12345", "#1234567", "4ADE80", "red", "", "#", "Green",
            "#GGGGGG",
        ] {
            assert!(parse(text).is_err(), "{text:?} must be rejected");
        }
        assert!(serde_json::from_value::<IntegrationColor>(serde_json::json!(1)).is_err());
    }
}
