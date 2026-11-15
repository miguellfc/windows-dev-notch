pub mod app_ipc;
pub mod contract;
pub mod control_center;
#[cfg(feature = "e2e")]
pub mod e2e;
pub mod i18n;
pub mod ipc;
pub mod notch;
pub mod platform;
pub mod security;
pub mod services;
pub mod settings;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use tauri::webview::{PageLoadEvent, PermissionResponse};
use tauri::{AppHandle, Manager, RunEvent};

use contract::settings::Settings;
use control_center::ControlCenterState;
use notch::ipc::NotchSlot;
use notch::runtime::NotchRuntime;
use notch::state::NotchEvent;
use platform::shortcut::{PluginRegistrar, ShortcutControl, ShortcutService};
use platform::tray;
use services::quit::{ExitDecision, QuitFlush};
use services::usage::{UsageEvent, UsageLog};

/// Shared state managed by Tauri; later tasks add their services here.
pub struct App {
    pub ipc: ipc::Registry,
}

/// A notch page load that finished before `setup` managed the [`NotchRuntime`]; `setup` replays it.
#[derive(Default)]
struct EarlyNotchLoad(AtomicBool);

impl EarlyNotchLoad {
    fn remember(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    fn take(&self) -> bool {
        self.0.swap(false, Ordering::SeqCst)
    }
}

/// Builds the app with no windows and keeps the process alive like a tray app.
pub fn run() {
    // The handlers exist before the window; they reach it through the slot `setup` fills.
    let notch_slot = Arc::new(NotchSlot::new());
    let usage_slot = Arc::new(OnceLock::new());
    let registry = build_registry(&notch_slot, &usage_slot);

    let app = tauri::Builder::default()
        // First, so a second instance hands over before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(notch) = app.try_state::<Arc<NotchRuntime>>() {
                notch.controller.dispatch(NotchEvent::Expand);
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        // The app needs no browser permission (camera, mic, notifications, clipboard...).
        .on_permission_request(|_webview, _kind| PermissionResponse::Deny)
        .manage(App { ipc: registry })
        .manage(ControlCenterState::default())
        .manage(EarlyNotchLoad::default())
        .setup(move |app| {
            // The log file first, so everything after it is recorded.
            let data_dir = settings::data_dir(app.handle());
            services::logger::init_logger(data_dir.join("logs"), cfg!(debug_assertions));

            // The settings come next: everything else reads them.
            let locale = sys_locale::get_locale().unwrap_or_else(|| "en".into());
            let path = data_dir.join("settings.json");
            let store = settings::SettingsStore::new(
                path,
                settings::default_settings(&locale),
                Arc::new(chrono::Utc::now),
            );
            tauri::async_runtime::block_on(store.load());
            {
                let handle = app.handle().clone();
                store.on_change(move |next: &Settings| {
                    ipc::emit_event(
                        &handle,
                        &[ipc::NOTCH, ipc::CONTROL_CENTER],
                        "settings:changed",
                        next,
                    );
                    tray::refresh(&handle);
                });
            }
            let saved = store.get();
            app.manage(store);

            // Daily counts kept only on this PC (`usage.json`) for the About page. Loading does
            // not hold up startup; `usage:summary` waits for it.
            let usage = UsageLog::new(
                data_dir.join("usage.json"),
                Arc::new(|| chrono::Local::now().fixed_offset()),
            );
            {
                let usage = usage.clone();
                tauri::async_runtime::spawn(async move { usage.load().await });
            }
            usage.record(UsageEvent::Launch);
            let usage_ticker = usage.start_ticker();
            if usage_slot.set(usage.clone()).is_err() {
                log::error!("usage: the log was installed twice");
            }

            // The capsule: created hidden, shown once its page has loaded. Managed right away so
            // `on_page_load` finds it; a load that finished even earlier is replayed below.
            let notch = NotchRuntime::install(app.handle(), &notch_slot)?;
            app.manage(Arc::clone(&notch));
            if app.state::<EarlyNotchLoad>().take() {
                notch.page_loaded();
            }
            notch.start_foreground_watch();
            {
                let handle = app.handle().clone();
                notch
                    .controller
                    .on_mode_change(move |_mode| tray::refresh(&handle));
                // An alert over a hidden capsule keeps the mode `alert`: Show/Hide follows this.
                let handle = app.handle().clone();
                notch
                    .controller
                    .on_hidden_change(move |_hidden| tray::refresh(&handle));
            }

            install_shortcut(app.handle(), &saved.shortcut);
            if let Err(error) =
                platform::autostart::sync_launch_at_login(app.handle(), saved.launch_at_login)
            {
                log::error!("Could not apply start with Windows: {error}");
            }
            tray::install(app.handle())?;
            app.manage(services::quit::install(app.handle(), usage, usage_ticker));
            log::info!(
                "Developer Notch started: version {} shortcut registered {}",
                app.package_info().version,
                app.state::<Arc<ShortcutService>>().current().is_some()
            );
            Ok(())
        })
        .on_page_load(|webview, payload| {
            let app = webview.app_handle();
            match (webview.label(), payload.event()) {
                // Electron's `ready-to-show` for the capsule.
                (ipc::NOTCH, PageLoadEvent::Finished) => {
                    match webview.try_state::<Arc<NotchRuntime>>() {
                        Some(notch) => notch.page_loaded(),
                        // Before `setup` managed the runtime: remembered, never dropped.
                        None => webview.state::<EarlyNotchLoad>().remember(),
                    }
                }
                (ipc::CONTROL_CENTER, PageLoadEvent::Started) => {
                    control_center::page_started(app);
                }
                (ipc::CONTROL_CENTER, PageLoadEvent::Finished) => {
                    control_center::page_loaded(app);
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![ipc::notch_ipc])
        .build(tauri::generate_context!())
        .expect("error while building Developer Notch");

    app.run(|app_handle, event| {
        // Closing the last window must not quit; only an explicit exit code (the tray's Quit)
        // does, after the ordered quit: the first request is prevented while the usage log is
        // flushed and everything is stopped, then the sequence asks to exit again.
        if let RunEvent::ExitRequested { api, code, .. } = event {
            let decision = match code {
                None => ExitDecision::Prevent,
                Some(code) => app_handle
                    .try_state::<Arc<QuitFlush>>()
                    .map_or(ExitDecision::Proceed, |quit| quit.on_exit_requested(code)),
            };
            if decision == ExitDecision::Prevent {
                api.prevent_exit();
            }
        }
    });
}

/// Every channel of `window.notch` with its handler, plus the `__e2e:*` test channels in the
/// `e2e` build only.
pub fn build_registry(
    notch_slot: &Arc<NotchSlot>,
    usage_slot: &Arc<OnceLock<UsageLog>>,
) -> ipc::Registry {
    let mut registry = ipc::Registry::new();
    notch::ipc::register(&mut registry, notch_slot);
    app_ipc::register(&mut registry);
    services::usage::register(&mut registry, Arc::clone(usage_slot));
    #[cfg(feature = "e2e")]
    e2e::register(&mut registry);
    registry
}

/// The global shortcut service with the saved shortcut registered. A failure (taken by another
/// app) is logged and the app keeps going without it, like Electron.
fn install_shortcut(app: &AppHandle, saved: &str) {
    let handle = app.clone();
    let registrar = PluginRegistrar::new(
        app.clone(),
        Arc::new(move || platform::shortcut::trigger(&handle)),
    );
    let service = Arc::new(ShortcutService::new(Box::new(registrar)));
    if let Err(reason) = service.apply(saved) {
        log::warn!("Saved shortcut could not be registered: {reason:?}");
    }
    app.manage(service);
}
