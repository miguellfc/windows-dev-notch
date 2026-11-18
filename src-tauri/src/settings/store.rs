//! `settings.json` owner (0.1.0's `settings-store.ts`): validates on read and write,
//! writes atomically, serializes updates and quarantines files it cannot understand.

use std::io::ErrorKind;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::contract::settings::{
    IntegrationSettings, IntegrationSettingsPatch, Settings, SettingsPatch, SETTINGS_VERSION,
};
use crate::ipc::{ExposedError, IpcErrorCode};
use crate::services::fs_atomic::write_atomic;
use crate::services::quarantine_path;
use crate::settings::defaults::default_integrations;
use crate::settings::validate::validate_settings;

type Listener = Arc<dyn Fn(&Settings) + Send + Sync>;

struct State {
    current: Settings,
    read_only: bool,
}

pub struct SettingsStore {
    path: PathBuf,
    defaults: Settings,
    now: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    state: Mutex<State>,
    listeners: Mutex<Vec<Listener>>,
    /// Serializes updates: each one starts after the previous one has been written.
    queue: tokio::sync::Mutex<()>,
}

/// A poisoned lock only means a listener or a test panicked elsewhere; the data is intact.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn serialize(settings: &Settings) -> Vec<u8> {
    let mut text = serde_json::to_string_pretty(settings).expect("settings serialize");
    text.push('\n');
    text.into_bytes()
}

impl SettingsStore {
    pub fn new(
        path: PathBuf,
        defaults: Settings,
        now: Arc<dyn Fn() -> DateTime<Utc> + Send + Sync>,
    ) -> Self {
        Self {
            path,
            state: Mutex::new(State {
                current: defaults.clone(),
                read_only: false,
            }),
            defaults,
            now,
            listeners: Mutex::new(Vec::new()),
            queue: tokio::sync::Mutex::new(()),
        }
    }

    /// Never fails: if the file cannot be read, moved aside or written (locked by antivirus,
    /// permissions...), the app still starts with defaults in read-only mode.
    pub async fn load(&self) -> Settings {
        match self.load_from_disk().await {
            Ok(settings) => settings,
            Err(error) => {
                log::error!("Could not load settings; using defaults in read-only mode: {error}");
                self.use_settings(self.defaults.clone(), true)
            }
        }
    }

    async fn load_from_disk(&self) -> std::io::Result<Settings> {
        let bytes = match tokio::fs::read(&self.path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                write_atomic(&self.path, &serialize(&self.defaults)).await?;
                return Ok(self.use_settings(self.defaults.clone(), false));
            }
            Err(error) => return Err(error),
        };

        let Ok(raw) = serde_json::from_slice::<Value>(&bytes) else {
            return self.recover("Settings file is not valid JSON").await;
        };
        let version = raw.get("version").and_then(Value::as_u64);
        if let Some(version) = version.filter(|v| *v > u64::from(SETTINGS_VERSION)) {
            log::warn!(
                "Settings file comes from a newer version ({version}); using defaults in read-only mode"
            );
            return Ok(self.use_settings(self.defaults.clone(), true));
        }
        // Only v7 migrates; an older (or missing) version is not usable.
        let Some(migrated) = migrate(raw) else {
            return self.recover("Settings file has no usable version").await;
        };
        let Ok(settings) = crate::contract::parse::<Settings>(migrated) else {
            return self
                .recover("Settings file does not match the schema")
                .await;
        };
        if version != Some(u64::from(SETTINGS_VERSION)) {
            write_atomic(&self.path, &serialize(&settings)).await?;
            log::info!("Migrated the settings file to version {SETTINGS_VERSION}");
        }
        Ok(self.use_settings(settings, false))
    }

    pub fn get(&self) -> Settings {
        lock(&self.state).current.clone()
    }

    /// Merges `patch` into the current settings (`codeReview` and `redmine` one level deep,
    /// `redmine.endOfDay` one more, `integrations` per key and per field), validates the whole
    /// result (a patch can only break the capsule rule once merged), writes it and notifies
    /// listeners.
    pub async fn update(&self, patch: SettingsPatch) -> Result<Settings, ExposedError> {
        let _turn = self.queue.lock().await;
        let (mut next, read_only) = {
            let state = lock(&self.state);
            (state.current.clone(), state.read_only)
        };
        if read_only {
            return Err(ExposedError::new(
                IpcErrorCode::ReadOnly,
                "Settings are read-only in this session; changes cannot be saved",
            ));
        }
        apply_patch(&mut next, patch);
        validate_settings(&next)
            .map_err(|_| ExposedError::new(IpcErrorCode::InvalidInput, "Invalid input"))?;
        write_atomic(&self.path, &serialize(&next))
            .await
            .map_err(ExposedError::internal)?;
        lock(&self.state).current = next.clone();
        self.notify(&next);
        Ok(next)
    }

    /// Registers a listener called after every successful update. A panicking listener is
    /// logged and skipped; it never breaks the update nor the other listeners.
    pub fn on_change(&self, listener: impl Fn(&Settings) + Send + Sync + 'static) {
        lock(&self.listeners).push(Arc::new(listener));
    }

    fn notify(&self, settings: &Settings) {
        let listeners: Vec<Listener> = lock(&self.listeners).clone();
        for listener in listeners {
            if catch_unwind(AssertUnwindSafe(|| listener(settings))).is_err() {
                log::error!("Settings listener panicked");
            }
        }
    }

    fn use_settings(&self, settings: Settings, read_only: bool) -> Settings {
        let mut state = lock(&self.state);
        state.current = settings;
        state.read_only = read_only;
        state.current.clone()
    }

    /// Moves the unusable file to `settings.corrupt-<ISO stamp>.json` and restores defaults.
    async fn recover(&self, reason: &str) -> std::io::Result<Settings> {
        let quarantine = quarantine_path(&self.path, (self.now)());
        tokio::fs::rename(&self.path, &quarantine).await?;
        log::warn!(
            "{reason}; moved it to {} and restored defaults",
            quarantine.display()
        );
        write_atomic(&self.path, &serialize(&self.defaults)).await?;
        Ok(self.use_settings(self.defaults.clone(), false))
    }
}

/// Brings a settings file up to [`SETTINGS_VERSION`]: v7 gets the default `integrations`; the
/// current version passes through untouched. Anything older (or without a version) is `None`,
/// which sends the file to quarantine. The result still has to pass the schema.
pub fn migrate(mut raw: Value) -> Option<Value> {
    match raw.get("version").and_then(Value::as_u64)? {
        version if version == u64::from(SETTINGS_VERSION) => Some(raw),
        7 => {
            let integrations = serde_json::to_value(default_integrations()).ok()?;
            let object = raw.as_object_mut()?;
            object.insert("integrations".into(), integrations);
            object.insert("version".into(), SETTINGS_VERSION.into());
            Some(raw)
        }
        _ => None,
    }
}

fn apply_integration_patch(
    target: &mut IntegrationSettings,
    patch: Option<IntegrationSettingsPatch>,
) {
    let Some(patch) = patch else { return };
    if let Some(enabled) = patch.enabled {
        target.enabled = enabled;
    }
    if let Some(capsule) = patch.capsule {
        target.capsule = capsule;
    }
    if let Some(color) = patch.color {
        target.color = color;
    }
}

fn apply_patch(settings: &mut Settings, patch: SettingsPatch) {
    if let Some(value) = patch.language {
        settings.language = value;
    }
    if let Some(value) = patch.shortcut {
        settings.shortcut = value;
    }
    if let Some(value) = patch.launch_at_login {
        settings.launch_at_login = value;
    }
    if let Some(value) = patch.reminders {
        settings.reminders = value;
    }
    if let Some(value) = patch.system_alerts {
        settings.system_alerts = value;
    }
    if let Some(value) = patch.gmail {
        settings.gmail = value;
    }
    if let Some(code_review) = patch.code_review {
        if let Some(url) = code_review.gitlab_url {
            settings.code_review.gitlab_url = url;
        }
        if let Some(alerts) = code_review.alerts {
            settings.code_review.alerts = alerts;
        }
    }
    if let Some(redmine) = patch.redmine {
        if let Some(url) = redmine.url {
            settings.redmine.url = url;
        }
        if let Some(hours) = redmine.daily_target_hours {
            settings.redmine.daily_target_hours = hours;
        }
        if let Some(end_of_day) = redmine.end_of_day {
            let target = &mut settings.redmine.end_of_day;
            if let Some(enabled) = end_of_day.enabled {
                target.enabled = enabled;
            }
            if let Some(time) = end_of_day.time {
                target.time = time;
            }
            if let Some(sound) = end_of_day.sound {
                target.sound = sound;
            }
        }
    }
    if let Some(integrations) = patch.integrations {
        let target = &mut settings.integrations;
        apply_integration_patch(&mut target.claude, integrations.claude);
        apply_integration_patch(&mut target.github, integrations.github);
        apply_integration_patch(&mut target.gitlab, integrations.gitlab);
        apply_integration_patch(&mut target.gmail, integrations.gmail);
        apply_integration_patch(&mut target.redmine, integrations.redmine);
        apply_integration_patch(&mut target.reminders, integrations.reminders);
        apply_integration_patch(&mut target.notes, integrations.notes);
        apply_integration_patch(&mut target.system, integrations.system);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract::settings::*;
    use crate::ipc::IpcErrorCode;
    use crate::settings::default_settings;
    use crate::settings::defaults::default_integrations;
    use chrono::{TimeZone, Utc};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use tauri::async_runtime::block_on;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            static N: AtomicUsize = AtomicUsize::new(0);
            let dir = std::env::temp_dir().join(format!(
                "notch-settings-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn file(&self) -> PathBuf {
            self.0.join("nested").join("settings.json")
        }
        fn names(&self) -> Vec<String> {
            std::fs::read_dir(self.0.join("nested"))
                .unwrap()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn defaults() -> Settings {
        default_settings("es-ES")
    }

    fn store(path: &Path) -> SettingsStore {
        let now = Arc::new(|| {
            Utc.with_ymd_and_hms(2026, 11, 14, 10, 20, 30).unwrap()
                + chrono::Duration::milliseconds(123)
        });
        SettingsStore::new(path.to_path_buf(), defaults(), now)
    }

    fn saved(path: &Path) -> Settings {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn lang(language: Language) -> SettingsPatch {
        SettingsPatch {
            language: Some(language),
            ..Default::default()
        }
    }

    #[test]
    fn missing_file_writes_defaults() {
        let dir = TempDir::new();
        let s = store(&dir.file());
        assert_eq!(block_on(s.load()), defaults());
        assert_eq!(saved(&dir.file()), defaults());
        assert_eq!(dir.names(), vec!["settings.json"]);
    }

    #[test]
    fn valid_saved_settings_are_loaded() {
        let dir = TempDir::new();
        let mut custom = defaults();
        custom.language = Language::En;
        write(&dir.file(), &serde_json::to_string(&custom).unwrap());
        assert_eq!(block_on(store(&dir.file()).load()), custom);
    }

    #[test]
    fn invalid_json_is_quarantined_with_timestamp() {
        let dir = TempDir::new();
        write(&dir.file(), "{ not json");
        let s = store(&dir.file());
        assert_eq!(block_on(s.load()), defaults());
        let mut names = dir.names();
        names.sort();
        assert_eq!(
            names,
            vec![
                "settings.corrupt-2026-11-14T10-20-30-123Z.json",
                "settings.json"
            ]
        );
        assert_eq!(saved(&dir.file()), defaults());
    }

    #[test]
    fn schema_mismatch_is_quarantined() {
        let dir = TempDir::new();
        let mut value = serde_json::to_value(defaults()).unwrap();
        value["language"] = "klingon".into();
        write(&dir.file(), &value.to_string());
        assert_eq!(block_on(store(&dir.file()).load()), defaults());
        assert!(dir
            .names()
            .iter()
            .any(|n| n.starts_with("settings.corrupt-")));
    }

    #[test]
    fn v7_file_migrates_to_v8_keeping_other_fields() {
        let dir = TempDir::new();
        let mut value = serde_json::to_value(defaults()).unwrap();
        value["version"] = 7.into();
        value["language"] = "en".into();
        value["shortcut"] = "Control+Alt+K".into();
        value.as_object_mut().unwrap().remove("integrations");
        write(&dir.file(), &value.to_string());
        let loaded = block_on(store(&dir.file()).load());
        let mut expected = defaults();
        expected.language = Language::En;
        expected.shortcut = "Control+Alt+K".into();
        assert_eq!(loaded.version, 8);
        assert_eq!(loaded.integrations, default_integrations());
        assert_eq!(loaded, expected);
        assert_eq!(saved(&dir.file()), expected);
        assert_eq!(dir.names(), vec!["settings.json"]);
    }

    #[test]
    fn v7_file_that_does_not_match_the_schema_is_quarantined() {
        let dir = TempDir::new();
        let mut value = serde_json::to_value(defaults()).unwrap();
        value["version"] = 7.into();
        value["language"] = "klingon".into();
        value.as_object_mut().unwrap().remove("integrations");
        write(&dir.file(), &value.to_string());
        assert_eq!(block_on(store(&dir.file()).load()), defaults());
        assert!(dir
            .names()
            .iter()
            .any(|n| n.starts_with("settings.corrupt-")));
    }

    #[test]
    fn migrate_handles_only_v7_and_the_current_version() {
        let current = serde_json::to_value(defaults()).unwrap();
        assert_eq!(migrate(current.clone()), Some(current.clone()));
        let mut v7 = current.clone();
        v7["version"] = 7.into();
        v7.as_object_mut().unwrap().remove("integrations");
        assert_eq!(migrate(v7), Some(current.clone()));
        for version in [6, 3, 0] {
            let mut old = current.clone();
            old["version"] = version.into();
            assert_eq!(migrate(old), None, "version {version}");
        }
        assert_eq!(migrate(serde_json::json!({ "language": "es" })), None);
    }

    #[test]
    fn older_than_v7_is_still_quarantined() {
        let dir = TempDir::new();
        let mut value = serde_json::to_value(defaults()).unwrap();
        value["version"] = 6.into();
        write(&dir.file(), &value.to_string());
        assert_eq!(block_on(store(&dir.file()).load()), defaults());
        assert!(dir
            .names()
            .iter()
            .any(|n| n.starts_with("settings.corrupt-")));
        assert_eq!(saved(&dir.file()), defaults());
    }

    #[test]
    fn newer_version_is_read_only_with_defaults() {
        let dir = TempDir::new();
        let newer = r#"{"version":99,"language":"en"}"#;
        write(&dir.file(), newer);
        let s = store(&dir.file());
        assert_eq!(block_on(s.load()), defaults());
        assert_eq!(std::fs::read_to_string(dir.file()).unwrap(), newer);
        let err = block_on(s.update(lang(Language::En))).unwrap_err();
        assert_eq!(err.code(), IpcErrorCode::ReadOnly);
    }

    #[test]
    fn unreadable_file_is_read_only() {
        let dir = TempDir::new();
        std::fs::create_dir_all(dir.file()).unwrap(); // a folder where the file should be
        let s = store(&dir.file());
        assert_eq!(block_on(s.load()), defaults());
        let err = block_on(s.update(lang(Language::En))).unwrap_err();
        assert_eq!(err.code(), IpcErrorCode::ReadOnly);
    }

    #[test]
    fn update_merges_persists_and_notifies() {
        let dir = TempDir::new();
        let s = store(&dir.file());
        block_on(s.load());
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = seen.clone();
        s.on_change(move |settings| sink.lock().unwrap().push(settings.clone()));
        let next = block_on(s.update(SettingsPatch {
            language: Some(Language::En),
            launch_at_login: Some(true),
            ..Default::default()
        }))
        .unwrap();
        let mut expected = defaults();
        expected.language = Language::En;
        expected.launch_at_login = true;
        assert_eq!(next, expected);
        assert_eq!(s.get(), expected);
        assert_eq!(saved(&dir.file()), expected);
        assert_eq!(*seen.lock().unwrap(), vec![expected]);
        assert_eq!(dir.names(), vec!["settings.json"]);
    }

    #[test]
    fn updates_are_serialized_in_order() {
        let dir = TempDir::new();
        let s = store(&dir.file());
        block_on(s.load());
        block_on(async {
            let (a, b, c) = tokio::join!(
                s.update(lang(Language::En)),
                s.update(SettingsPatch {
                    launch_at_login: Some(true),
                    ..Default::default()
                }),
                s.update(lang(Language::Es)),
            );
            assert_eq!(a.unwrap().language, Language::En);
            assert!(b.unwrap().launch_at_login);
            assert_eq!(c.unwrap().language, Language::Es);
        });
        let mut expected = defaults();
        expected.launch_at_login = true;
        assert_eq!(s.get(), expected);
        assert_eq!(saved(&dir.file()), expected);
    }

    #[test]
    fn code_review_patch_merges_one_level() {
        let dir = TempDir::new();
        let s = store(&dir.file());
        block_on(s.load());
        block_on(s.update(SettingsPatch {
            code_review: Some(CodeReviewSettingsPatch {
                gitlab_url: Some("https://gitlab.example.com".into()),
                alerts: None,
            }),
            ..Default::default()
        }))
        .unwrap();
        let alerts = CodeReviewAlerts {
            github: CodeReviewAlertSettings {
                enabled: false,
                sound: false,
            },
            gitlab: CodeReviewAlertSettings {
                enabled: true,
                sound: true,
            },
        };
        block_on(s.update(SettingsPatch {
            code_review: Some(CodeReviewSettingsPatch {
                gitlab_url: None,
                alerts: Some(alerts),
            }),
            ..Default::default()
        }))
        .unwrap();
        let expected = CodeReviewSettings {
            gitlab_url: "https://gitlab.example.com".into(),
            alerts,
        };
        assert_eq!(s.get().code_review, expected);
        assert_eq!(saved(&dir.file()).code_review, expected);
    }

    #[test]
    fn redmine_end_of_day_merges_two_levels() {
        let dir = TempDir::new();
        let s = store(&dir.file());
        block_on(s.load());
        block_on(s.update(SettingsPatch {
            redmine: Some(RedmineSettingsPatch {
                url: Some("https://redmine.example.com".into()),
                daily_target_hours: Some(6.0),
                end_of_day: None,
            }),
            ..Default::default()
        }))
        .unwrap();
        block_on(s.update(SettingsPatch {
            redmine: Some(RedmineSettingsPatch {
                end_of_day: Some(RedmineEndOfDayPatch {
                    time: Some("17:30".into()),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        }))
        .unwrap();
        let expected = RedmineSettings {
            url: "https://redmine.example.com".into(),
            daily_target_hours: 6.0,
            end_of_day: RedmineEndOfDaySettings {
                enabled: true,
                time: "17:30".into(),
                sound: true,
            },
        };
        assert_eq!(s.get().redmine, expected);
        assert_eq!(saved(&dir.file()).redmine, expected);
    }

    #[test]
    fn patch_merges_one_integration_field() {
        let dir = TempDir::new();
        let s = store(&dir.file());
        block_on(s.load());
        block_on(s.update(SettingsPatch {
            integrations: Some(IntegrationsPatch {
                gmail: Some(IntegrationSettingsPatch {
                    enabled: Some(false),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        }))
        .unwrap();
        let next = block_on(s.update(SettingsPatch {
            integrations: Some(IntegrationsPatch {
                gmail: Some(IntegrationSettingsPatch {
                    color: Some(IntegrationColor::Blue),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            ..Default::default()
        }))
        .unwrap();
        let mut expected = default_integrations();
        expected.gmail = IntegrationSettings {
            enabled: false,
            capsule: true,
            color: IntegrationColor::Blue,
        };
        assert_eq!(next.integrations, expected);
        assert_eq!(next.integrations.github, default_integrations().github);
        assert_eq!(saved(&dir.file()).integrations, expected);
    }

    #[test]
    fn patch_turning_on_capsule_for_notes_is_rejected_after_the_merge() {
        let dir = TempDir::new();
        let s = store(&dir.file());
        block_on(s.load());
        let before = std::fs::read_to_string(dir.file()).unwrap();
        let patch: SettingsPatch = serde_json::from_value(
            serde_json::json!({ "integrations": { "notes": { "capsule": true } } }),
        )
        .unwrap();
        // The patch shape is fine (as in zod); only the merged settings are invalid.
        assert!(crate::settings::validate::validate_patch(&patch).is_ok());
        let err = block_on(s.update(patch)).unwrap_err();
        assert_eq!(err.code(), IpcErrorCode::InvalidInput);
        assert_eq!(s.get(), defaults());
        assert_eq!(std::fs::read_to_string(dir.file()).unwrap(), before);
    }

    #[test]
    fn invalid_patch_is_rejected_and_file_untouched() {
        let dir = TempDir::new();
        let s = store(&dir.file());
        block_on(s.load());
        let before = std::fs::read_to_string(dir.file()).unwrap();
        let err = block_on(s.update(SettingsPatch {
            shortcut: Some("bad shortcut".into()),
            ..Default::default()
        }))
        .unwrap_err();
        assert_eq!(err.code(), IpcErrorCode::InvalidInput);
        assert_eq!(s.get(), defaults());
        assert_eq!(std::fs::read_to_string(dir.file()).unwrap(), before);
        // Keeps working after a failed update.
        assert_eq!(
            block_on(s.update(lang(Language::En))).unwrap().language,
            Language::En
        );
    }

    #[test]
    fn listener_panic_does_not_break_update() {
        let dir = TempDir::new();
        let s = store(&dir.file());
        block_on(s.load());
        let healthy = Arc::new(AtomicUsize::new(0));
        let counter = healthy.clone();
        s.on_change(|_| panic!("listener bug"));
        s.on_change(move |_| {
            counter.fetch_add(1, Ordering::Relaxed);
        });
        let next = block_on(s.update(lang(Language::En))).unwrap();
        assert_eq!(next.language, Language::En);
        assert_eq!(healthy.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn get_returns_independent_copies() {
        let dir = TempDir::new();
        let s = store(&dir.file());
        block_on(s.load());
        let mut snapshot = s.get();
        snapshot.shortcut = "x".into();
        assert_eq!(s.get().shortcut, defaults().shortcut);
    }

    #[test]
    fn default_language_follows_locale() {
        assert_eq!(default_settings("es-ES").language, Language::Es);
        assert_eq!(default_settings("fr").language, Language::En);
        assert_eq!(default_settings("ES").language, Language::Es);
    }
}
