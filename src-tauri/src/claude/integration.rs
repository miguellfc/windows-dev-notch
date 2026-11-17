//! The Tauri adapter around [`ClaudeService`] (port of 0.1.0's `claude-integration.ts`
//! and its wiring in 0.1.0's `index.ts`): real files, DPAPI, toasts, the notch, the 60 s tick
//! and the quit cleanup.
//!
//! Dev/E2E switches (ignored unless `ipc::dev_overrides_enabled()`): `NOTCH_CLAUDE_SETTINGS`
//! (Claude's settings.json; else `~/.claude/settings.json`), `NOTCH_CLAUDE_PORT` (`^\d{1,5}$`,
//! at most 65535, `0` = ephemeral) and `NOTCH_DISABLE_CLAUDE_FOCUS=1` (never bring Claude's
//! window forward: E2E must not drive the desktop).

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::alerts::{NotchPort, NotchWebview, QuestionAlerts, QuestionAlertsOptions};
use super::bridge::{now_ms, ClaudeBridge};
use super::hook_installer::HookInstaller;
use super::ipc::ClaudeSlot;
use super::permission_broker::lock;
use super::service::{
    quit_cleanup, BoxFuture, Bridge, BridgeConfig, BridgeOptions, ClaudeService, ClaudeServiceDeps,
    ConfigFn, QUIT_STOP_WAIT,
};
use super::toast::ClaudeToasts;
use super::{bridge_config, focus};
use crate::contract::claude::{ClaudeState, PendingPermission};
use crate::notch::controller::NotchController;
use crate::notch::runtime::NotchRuntime;
use crate::notch::state::{NotchEvent, NotchMode, PANEL_MODES};
use crate::platform::toast::ToastSound;
use crate::services::dpapi;
use crate::services::quit::CleanupThread;
use crate::services::timers::Interval;
use crate::services::usage::{UsageEvent, UsageLog};
use crate::settings::SettingsStore;
use crate::{i18n, ipc, platform};

/// Housekeeping period: idle sessions and hooks edited outside the app.
pub const TICK_MS: u64 = 60_000;

/// On the main thread (a second exit request during the flush) the cleanup waits less: the
/// releases are already written; this only lets them flush.
pub(crate) const MAIN_THREAD_STOP_WAIT: std::time::Duration = std::time::Duration::from_millis(600);

/// One bridge-config operation on `claude-bridge.json`.
type ConfigRun = fn(PathBuf) -> BoxFuture<'static, io::Result<BridgeConfig>>;

/// The three dev/E2E switches.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Overrides {
    pub settings_file: Option<PathBuf>,
    pub port: Option<u16>,
    pub focus_disabled: bool,
}

/// `NOTCH_CLAUDE_PORT`: `^\d{1,5}$` and at most 65535; anything else is ignored.
pub fn parse_port(value: &str) -> Option<u16> {
    if !(1..=5).contains(&value.len()) || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value
        .parse::<u32>()
        .ok()
        .and_then(|port| u16::try_from(port).ok())
}

/// The switches as read from `var` (`std::env::var_os`); none in a release build.
pub fn overrides_from(enabled: bool, var: impl Fn(&str) -> Option<OsString>) -> Overrides {
    if !enabled {
        return Overrides::default();
    }
    let text = |name: &str| var(name).and_then(|value| value.into_string().ok());
    Overrides {
        settings_file: var("NOTCH_CLAUDE_SETTINGS")
            .filter(|value| !value.is_empty())
            .map(PathBuf::from),
        port: text("NOTCH_CLAUDE_PORT").as_deref().and_then(parse_port),
        focus_disabled: text("NOTCH_DISABLE_CLAUDE_FOCUS").as_deref() == Some("1"),
    }
}

/// The notch controller as the question alerts see it.
struct Notch(Arc<NotchController>);

impl NotchPort for Notch {
    fn mode(&self) -> NotchMode {
        self.0.mode()
    }

    fn dispatch(&self, event: NotchEvent) {
        self.0.dispatch(event);
    }
}

/// The notch webview (`claude:questions` goes to it alone).
struct NotchWindow(AppHandle);

impl NotchWebview for NotchWindow {
    fn is_destroyed(&self) -> bool {
        self.0.get_webview_window(ipc::NOTCH).is_none()
    }

    fn send(&self, event: &str, payload: &Value) {
        ipc::emit_event(&self.0, &[ipc::NOTCH], event, payload);
    }
}

/// The 60 s tick, armed once the service has started; `closed` once the quit began.
#[derive(Default)]
struct Tick {
    interval: Option<Interval>,
    closed: bool,
}

/// `createClaudeIntegration`'s handle: the service and its tick.
pub struct ClaudeIntegration {
    service: Arc<ClaudeService>,
    tick: Mutex<Tick>,
}

impl ClaudeIntegration {
    pub fn service(&self) -> &Arc<ClaudeService> {
        &self.service
    }

    /// `dispose`: stops the tick, releases every held permission and question (Claude falls
    /// back to its own prompt) and stops the bridge, waiting for it (bounded).
    pub fn dispose(&self, thread: CleanupThread) {
        let interval = {
            let mut tick = lock(&self.tick);
            tick.closed = true;
            tick.interval.take()
        };
        drop(interval);
        let wait = match thread {
            CleanupThread::Worker => QUIT_STOP_WAIT,
            CleanupThread::Main => MAIN_THREAD_STOP_WAIT,
        };
        quit_cleanup(&self.service, wait);
    }
}

/// Creates the service, fills `slot`, starts it in the background and then its 60 s tick on the
/// notch's timers. Call on the main thread, after the notch and before the reminders. `None`
/// (channels stay UNAVAILABLE) only when there is no user folder for Claude's settings.
pub fn install(
    app: &AppHandle,
    slot: &ClaudeSlot,
    notch: &Arc<NotchRuntime>,
    usage: &UsageLog,
    data_dir: &Path,
) -> Option<Arc<ClaudeIntegration>> {
    let overrides = overrides_from(ipc::dev_overrides_enabled(), |name| std::env::var_os(name));
    let settings_file = match overrides.settings_file {
        Some(file) => file,
        None => match app.path().home_dir() {
            Ok(home) => home.join(".claude").join("settings.json"),
            Err(_) => {
                log::error!("Claude: no user folder; the integration stays off");
                return None;
            }
        },
    };
    let controller = Arc::clone(&notch.controller);
    let toasts = {
        let app = app.clone();
        ClaudeToasts::new(
            Arc::new(|request| {
                platform::toast::show(
                    request.title,
                    request.body,
                    ToastSound::Default,
                    request.on_click,
                );
            }),
            Arc::new(move |key: &str| i18n::t(app.state::<SettingsStore>().get().language, key)),
        )
    };
    let alerts = Arc::new(QuestionAlerts::new(QuestionAlertsOptions {
        notch: Arc::new(Notch(Arc::clone(&controller))),
        notch_target: {
            let app = app.clone();
            Arc::new(move || {
                app.get_webview_window(ipc::NOTCH)
                    .is_some()
                    .then(|| Arc::new(NotchWindow(app.clone())) as Arc<dyn NotchWebview>)
            })
        },
        toast: {
            let toasts = toasts.clone();
            Arc::new(move |question, on_click| toasts.show_question(question, on_click))
        },
    }));
    let config_file = data_dir.join("claude-bridge.json");
    let config_fn = |run: ConfigRun| -> ConfigFn {
        let file = config_file.clone();
        Arc::new(move || run(file.clone()))
    };
    let focus_disabled = overrides.focus_disabled;
    let deps = ClaudeServiceDeps {
        now: Arc::new(now_ms),
        new_id: Arc::new(|| uuid::Uuid::new_v4().to_string()),
        encryption_available: Arc::new(dpapi::available),
        load_config: config_fn(|file| Box::pin(async move { bridge_config::load(&file).await })),
        rotate_config: config_fn(|file| {
            Box::pin(async move { bridge_config::rotate_token(&file).await })
        }),
        rotate_port_config: config_fn(|file| {
            Box::pin(async move { bridge_config::rotate_port(&file).await })
        }),
        create_bridge: Arc::new(|options: BridgeOptions| -> Arc<dyn Bridge> {
            Arc::new(ClaudeBridge::new(
                options.port,
                &options.token,
                options.on_event,
            ))
        }),
        installer: Arc::new(HookInstaller::new(
            settings_file,
            data_dir.join("claude-hooks-backups"),
            chrono::Utc::now,
        )),
        focus_claude: Arc::new(move || focus::focus_claude(focus_disabled)),
        on_state: {
            let alerts = Arc::clone(&alerts);
            let controller = Arc::clone(&controller);
            let app = app.clone();
            Arc::new(move |state: &ClaudeState| {
                alerts.on_permissions(&state.pending);
                controller.dispatch(NotchEvent::Attention {
                    on: !state.pending.is_empty(),
                });
                let targets = ipc::existing_windows(&app);
                if !targets.is_empty() {
                    ipc::emit_event(&app, &targets, "claude:state-changed", state);
                }
            })
        },
        on_new_pending: {
            let usage = usage.clone();
            let controller = Arc::clone(&controller);
            let toasts = toasts.clone();
            Arc::new(move |permission: &PendingPermission| {
                // After on_state above has dispatched `Attention` for this request: from the
                // bridge receiving the HTTP request (before its body) to the alert.
                usage.record(UsageEvent::ClaudeAlert {
                    latency_ms: now_ms() as f64 - permission.received_at,
                });
                // The open panel already shows the request; otherwise tell the user even if the
                // capsule is hidden.
                if !PANEL_MODES.contains(&controller.mode()) {
                    let controller = Arc::clone(&controller);
                    toasts.show_permission(
                        permission,
                        Arc::new(move || controller.dispatch(NotchEvent::Expand)),
                    );
                }
            })
        },
        on_questions: {
            let alerts = Arc::clone(&alerts);
            Arc::new(move |questions| alerts.on_questions(questions))
        },
        on_new_question: Arc::new(move |question| alerts.on_new_question(question)),
        port_override: overrides.port,
        idle_after_ms: None,
    };
    let service = ClaudeService::new(deps);
    if slot.set(Arc::clone(&service)).is_err() {
        log::error!("claude: installed twice");
    }
    let integration = Arc::new(ClaudeIntegration {
        service,
        tick: Mutex::default(),
    });
    {
        let integration = Arc::clone(&integration);
        let timers = notch.timers();
        tauri::async_runtime::spawn(async move {
            integration.service.start().await;
            let service = Arc::clone(&integration.service);
            let mut tick = lock(&integration.tick);
            if tick.closed {
                return;
            }
            tick.interval = Some(Interval::start(
                timers,
                TICK_MS,
                Arc::new(move || {
                    let service = Arc::clone(&service);
                    tauri::async_runtime::spawn(async move {
                        let run = tauri::async_runtime::spawn(async move { service.tick().await });
                        if run.await.is_err() {
                            log::error!("Claude tick failed");
                        }
                    });
                }),
            ));
        });
    }
    Some(integration)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<OsString> {
        let map: HashMap<String, OsString> = pairs
            .iter()
            .map(|(name, value)| ((*name).to_string(), OsString::from(value)))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn port_override_accepts_one_to_five_digits_up_to_65535() {
        assert_eq!(parse_port("0"), Some(0));
        assert_eq!(parse_port("47600"), Some(47_600));
        assert_eq!(parse_port("65535"), Some(65_535));
        for refused in [
            "", "65536", "99999", "123456", "-1", "+80", " 80", "8a", "1e3",
        ] {
            assert_eq!(parse_port(refused), None, "{refused:?}");
        }
    }

    #[test]
    fn switches_apply_only_with_dev_overrides() {
        let vars = env(&[
            ("NOTCH_CLAUDE_SETTINGS", "C:\\tmp\\claude-settings.json"),
            ("NOTCH_CLAUDE_PORT", "0"),
            ("NOTCH_DISABLE_CLAUDE_FOCUS", "1"),
        ]);
        assert_eq!(
            overrides_from(true, &vars),
            Overrides {
                settings_file: Some(PathBuf::from("C:\\tmp\\claude-settings.json")),
                port: Some(0),
                focus_disabled: true,
            }
        );
        assert_eq!(overrides_from(false, &vars), Overrides::default());
    }

    #[test]
    fn focus_is_disabled_only_by_exactly_1_and_an_empty_settings_path_is_ignored() {
        let vars = env(&[
            ("NOTCH_CLAUDE_SETTINGS", ""),
            ("NOTCH_CLAUDE_PORT", "70000"),
            ("NOTCH_DISABLE_CLAUDE_FOCUS", "true"),
        ]);
        assert_eq!(overrides_from(true, vars), Overrides::default());
    }
}
