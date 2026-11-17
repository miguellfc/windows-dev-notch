pub mod app_ipc;
pub mod apps;
pub mod claude;
pub mod code_review;
pub mod contract;
pub mod control_center;
#[cfg(feature = "e2e")]
pub mod e2e;
pub mod gmail;
pub mod http;
pub mod i18n;
pub mod ipc;
pub mod notch;
pub mod notes;
pub mod platform;
pub mod redmine;
pub mod reminders;
pub mod security;
pub mod services;
pub mod settings;
pub mod system;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use tauri::webview::{PageLoadEvent, PermissionResponse};
use tauri::{AppHandle, Manager, RunEvent};

use apps::{AppsHandles, AppsSlot};
use claude::ipc::ClaudeSlot;
use code_review::integration::CodeReviewIntegration;
use code_review::ipc::CodeReviewSlot;
use contract::settings::Settings;
use control_center::ControlCenterState;
use gmail::integration::GmailIntegration;
use gmail::ipc::GmailSlot;
use notch::ipc::NotchSlot;
use notch::runtime::NotchRuntime;
use notch::state::NotchEvent;
use notes::ipc::{Notes, NotesSlot};
use platform::power::PowerEvents;
use platform::shortcut::{PluginRegistrar, ShortcutControl, ShortcutService};
use platform::tray;
use redmine::end_of_day::EndOfDay;
use redmine::integration::RedmineIntegration;
use redmine::ipc::RedmineSlot;
use reminders::ipc::RemindersSlot;
use reminders::Reminders;
use services::quit::{ExitDecision, QuitFlush};
use services::usage::{UsageEvent, UsageLog};
use system::ipc::{SystemControl, SystemIntegration, SystemSlot};

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
    // Per-session test switches, before anything reads the environment.
    #[cfg(feature = "e2e")]
    e2e::apply_cli_env();
    // The handlers exist before the window; they reach it through the slot `setup` fills.
    let slots = Slots::default();
    let registry = build_registry(&slots);
    let Slots {
        notch: notch_slot,
        usage: usage_slot,
        notes: notes_slot,
        apps: apps_slot,
        reminders: reminders_slot,
        system: system_slot,
        claude: claude_slot,
        code_review: code_review_slot,
        redmine: redmine_slot,
        gmail: gmail_slot,
    } = slots;

    let app = tauri::Builder::default()
        // First, so a second instance hands over before anything else starts.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(notch) = app.try_state::<Arc<NotchRuntime>>() {
                notch.controller.dispatch(NotchEvent::Expand);
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // The app needs no browser permission (camera, mic, notifications, clipboard...).
        .on_permission_request(|_webview, _kind| PermissionResponse::Deny)
        .manage(App { ipc: registry })
        .manage(ControlCenterState::default())
        .manage(EarlyNotchLoad::default())
        .setup(move |app| {
            // The log file first, so everything after it is recorded.
            let data_dir = settings::data_dir(app.handle());
            services::logger::init_logger(data_dir.join("logs"), cfg!(debug_assertions));
            // Toast attribution (`app.setAppUserModelId`), before anything can show one.
            platform::toast::set_app_user_model_id();

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

            // The wall clock the part-2 modules read (`__e2e:advance-clock` moves it in tests).
            let wall_clock = Arc::new(services::clock::WallClock::real());
            app.manage(Arc::clone(&wall_clock));

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

            // Notes (`notes.json`) on the real clock: the channels wait for the load, which does
            // not hold up startup. Its flusher is added once the quit tasks exist (below).
            let notes = Notes::new(
                data_dir.join("notes.json"),
                Arc::new(services::clock::WallClock::real()),
                notes::ipc::notch_emitter(app.handle()),
                notes::ipc::system_clipboard(),
            );
            if notes_slot.set(Arc::clone(&notes)).is_err() {
                log::error!("notes: installed twice");
            }

            // The capsule: created hidden, shown once its page has loaded. Managed right away so
            // `on_page_load` finds it; a load that finished even earlier is replayed below.
            let notch = NotchRuntime::install(app.handle(), &notch_slot)?;
            app.manage(Arc::clone(&notch));
            if app.state::<EarlyNotchLoad>().take() {
                notch.page_loaded();
            }
            notch.start_foreground_watch();
            // The system monitor follows the notch mode (sampling starts below, once everything
            // else is up); the channels reach it through the slot.
            let system = Arc::new(SystemIntegration::new());
            if system_slot
                .set(Arc::clone(&system) as Arc<dyn SystemControl>)
                .is_err()
            {
                log::error!("system: installed twice");
            }
            app.manage(Arc::clone(&system));
            {
                let system = Arc::clone(&system);
                notch
                    .controller
                    .add_mode_listener(move |mode| system.set_mode(mode));
            }
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

            // Claude Code: after the notch (it drives the alerts), before the reminders, as in
            // Electron. The bridge starts in the background; the channels reach it through the slot.
            let claude =
                claude::integration::install(app.handle(), &claude_slot, &notch, &usage, &data_dir);

            // With `NOTCH_OPEN_URL_LOG=1` (dev/E2E only) the URLs Gmail and code review would
            // open are recorded instead; both openers check for the recorder when built.
            if apps::open_url_log_switch() {
                app.manage(Arc::new(apps::OpenedUrls::default()));
            }

            // Gmail: after Claude and before code review, as in Electron, once the settings
            // store, the wall clock and `OpenedUrls` exist. The stored token loads in the
            // background (the channels wait for it); the rhythm starts at once, on the notch's
            // timers and the shared wall clock (both follow the E2E test clock).
            let gmail = install_gmail(app.handle(), &gmail_slot, &notch, &data_dir);

            // GitHub and GitLab code review: after Gmail, as in Electron. The stored tokens load
            // in the background (the channels wait for them); the rhythm starts at once, on the
            // notch's timers and the shared wall clock (both follow the E2E test clock).
            let code_review = code_review::integration::install(
                app.handle(),
                &code_review_slot,
                &notch,
                &data_dir,
            );
            if let Some(code_review) = &code_review {
                app.manage(Arc::clone(code_review));
            }

            let reminders = install_reminders(
                app.handle(),
                &reminders_slot,
                &notch,
                &usage,
                data_dir.join("reminders.json"),
                wall_clock,
            );
            // Timers stall while the PC sleeps: check as soon as it is back or unlocked.
            let power = PowerEvents::start(reminders.power_listener());
            app.manage(Arc::clone(&power));

            // Redmine: after code review, once the power events exist (the end of day listens to
            // them). The power events need the reminders' listener, so the reminders' load is
            // spawned above, before Redmine; Electron calls `reminders.start()` after
            // `redmineEndOfDay.start()`. The two are independent: no functional impact. The
            // stored key loads in the background (the channels wait for it); the rhythm runs on
            // the notch's timers and the shared wall clock (both follow the E2E test clock).
            let redmine = install_redmine(app.handle(), &redmine_slot, &notch, &data_dir, &power);

            install_apps(app.handle(), &apps_slot, &notch);
            {
                let notes = Arc::clone(&notes);
                tauri::async_runtime::spawn(async move { notes.start().await });
            }

            install_shortcut(app.handle(), &saved.shortcut);
            if let Err(error) =
                platform::autostart::sync_launch_at_login(app.handle(), saved.launch_at_login)
            {
                log::error!("Could not apply start with Windows: {error}");
            }
            tray::install(app.handle())?;
            app.manage(services::quit::install(app.handle(), usage, usage_ticker));
            app.state::<Arc<services::quit::QuitTasks>>()
                .add_flusher(move || {
                    let notes = Arc::clone(&notes);
                    Box::pin(async move { notes.flush().await })
                });
            // After the notch's cleanup (registered by `install`) and before the reminders', as in
            // Electron: every held permission and question is answered (Claude falls back to its
            // own prompt) and the bridge is stopped, waited for within the cleanup budget.
            if let Some(claude) = claude {
                app.state::<Arc<services::quit::QuitTasks>>()
                    .add_cleanup(move |thread| claude.dispose(thread));
            }
            // Then the reminders, as in Electron.
            app.state::<Arc<services::quit::QuitTasks>>()
                .add_cleanup(move |_thread| reminders.dispose());
            // Then the system monitor and its PDH query (Electron: reminders, then system).
            {
                let system = Arc::clone(&system);
                app.state::<Arc<services::quit::QuitTasks>>()
                    .add_cleanup(move |_thread| system.dispose());
            }
            // Then Gmail, as in Electron: its timers stop, a pending sign-in is cancelled (its
            // loopback closes) and later results and events are dropped; nothing to flush (the
            // refresh token is written when saved).
            if let Some(gmail) = gmail {
                app.state::<Arc<services::quit::QuitTasks>>()
                    .add_cleanup(move |_thread| gmail.dispose());
            }
            // Then code review, as in Electron (after reminders, system and Gmail): its timers
            // stop and later results and events are dropped; nothing to flush (tokens are
            // written when saved).
            if let Some(code_review) = code_review {
                app.state::<Arc<services::quit::QuitTasks>>()
                    .add_cleanup(move |_thread| code_review.dispose());
            }
            // Then Redmine, the power hooks and the end of day, in Electron's order
            // (`redmine.dispose(); powerMonitor.off(...); redmineEndOfDay.dispose()`). Without an
            // unsubscribe, a power event that still arrives finds both schedulers disposed.
            let (redmine, end_of_day) = redmine.unzip();
            if let Some(redmine) = redmine {
                app.state::<Arc<services::quit::QuitTasks>>()
                    .add_cleanup(move |_thread| redmine.dispose());
            }
            app.state::<Arc<services::quit::QuitTasks>>()
                .add_cleanup(move |_thread| power.stop());
            if let Some(end_of_day) = end_of_day {
                app.state::<Arc<services::quit::QuitTasks>>()
                    .add_cleanup(move |_thread| end_of_day.dispose());
            }
            // The channels are live (the registry predates `setup`): start sampling off the
            // startup path, for the mode the notch is in by then.
            start_system(app.handle(), system, &notch);
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
                    // Every (re)load: the page never waits for the next tick for its data.
                    if let Some(system) = webview.try_state::<Arc<SystemIntegration>>() {
                        system.resync();
                    }
                    // A (re)loaded notch starts with every view closed: no contributions polling
                    // is left behind for a view that no longer exists.
                    if let Some(code_review) = webview.try_state::<Arc<CodeReviewIntegration>>() {
                        code_review.set_view_open(false);
                    }
                    // Nor any summary polling for a Redmine view that no longer exists.
                    if let Some(redmine) = webview.try_state::<Arc<RedmineIntegration>>() {
                        redmine.set_view_open(false);
                    }
                    // Nor a Gmail list or open message (this also forgets the message's links).
                    if let Some(gmail) = webview.try_state::<Arc<GmailIntegration>>() {
                        gmail.set_view_open(false);
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

/// Where the handlers, built before `setup`, find the services `setup` creates.
#[derive(Default)]
pub struct Slots {
    pub notch: Arc<NotchSlot>,
    pub usage: Arc<OnceLock<UsageLog>>,
    pub notes: Arc<NotesSlot>,
    pub apps: Arc<AppsSlot>,
    pub reminders: Arc<RemindersSlot>,
    pub system: Arc<SystemSlot>,
    pub claude: Arc<ClaudeSlot>,
    pub code_review: Arc<CodeReviewSlot>,
    pub redmine: Arc<RedmineSlot>,
    pub gmail: Arc<GmailSlot>,
}

/// Every channel of `window.notch` with its handler, plus the `__e2e:*` test channels in the
/// `e2e` build only.
pub fn build_registry(slots: &Slots) -> ipc::Registry {
    let mut registry = ipc::Registry::new();
    notch::ipc::register(&mut registry, &slots.notch);
    app_ipc::register(&mut registry);
    services::usage::register(&mut registry, Arc::clone(&slots.usage));
    notes::ipc::register(&mut registry, &slots.notes);
    apps::register(&mut registry, &slots.apps);
    reminders::ipc::register(&mut registry, &slots.reminders);
    system::ipc::register(&mut registry, &slots.system);
    claude::ipc::register(&mut registry, &slots.claude);
    code_review::ipc::register(&mut registry, &slots.code_review);
    redmine::ipc::register(&mut registry, &slots.redmine);
    gmail::ipc::register(&mut registry, &slots.gmail);
    #[cfg(feature = "e2e")]
    e2e::register(&mut registry);
    registry
}

/// The app launcher behind `apps:open`. The user folder is read here, on the main thread. With
/// the test switch (`NOTCH_APP_LAUNCH_LOG=1`, dev builds only) launches are recorded in a managed
/// [`apps::LaunchLog`] instead of performed.
fn install_apps(app: &AppHandle, slot: &AppsSlot, notch: &Arc<NotchRuntime>) {
    let home = match app.path().home_dir() {
        Ok(home) => home.to_string_lossy().into_owned(),
        Err(_) => {
            log::error!("apps: no user folder");
            String::new()
        }
    };
    let deps = match apps::launch_log_switch() {
        Some(fail) => {
            let log = Arc::new(apps::LaunchLog {
                launches: std::sync::Mutex::new(Vec::new()),
                home,
            });
            app.manage(Arc::clone(&log));
            apps::log_deps(log, fail.as_deref())
        }
        None => apps::system_deps(home),
    };
    let controller = Arc::clone(&notch.controller);
    let handles = AppsHandles {
        launcher: apps::launcher::AppLauncher::new(deps),
        dismiss: Box::new(move || controller.dispatch(NotchEvent::Dismiss)),
    };
    if slot.set(handles).is_err() {
        log::error!("apps: installed twice");
    }
}

/// Redmine (`redmine.bin` holds the key) and its end-of-day alert. The integration fills `slot`
/// and is managed as `Arc<RedmineIntegration>` (the notch page-load hook); the scheduler is
/// managed as `Arc<EndOfDay>` (`__e2e:advance-clock`) and listens to `power`. Both start here:
/// the registry predates `setup`, so the channels already exist (Electron starts code review,
/// then Redmine, then the end of day, right after `registerIpc`). `None` (channels stay
/// UNAVAILABLE, no end of day) only when the HTTP client cannot be built.
fn install_redmine(
    app: &AppHandle,
    slot: &RedmineSlot,
    notch: &Arc<NotchRuntime>,
    data_dir: &std::path::Path,
    power: &PowerEvents,
) -> Option<(Arc<RedmineIntegration>, Arc<EndOfDay>)> {
    use redmine::alert::{install_end_of_day, AppAlertNotch, EndOfDayWiring, Readings};
    use redmine::end_of_day::AppEndOfDaySettings;
    use redmine::ipc::RedmineApi;

    let redmine = redmine::integration::install(app, notch, data_dir)?;
    app.manage(Arc::clone(&redmine));
    if slot
        .set(Arc::clone(&redmine) as Arc<dyn RedmineApi>)
        .is_err()
    {
        log::error!(target: redmine::integration::LOG_TARGET, "Redmine installed twice");
    }
    let readings = Arc::clone(&redmine) as Arc<dyn Readings>;
    let end_of_day = install_end_of_day(
        EndOfDayWiring {
            settings: Arc::new(AppEndOfDaySettings(app.clone())),
            clock: Arc::clone(&app.state::<Arc<services::clock::WallClock>>()),
            timers: notch.timers(),
            redmine: Arc::downgrade(&readings),
            notch: Arc::new(AppAlertNotch {
                app: app.clone(),
                controller: Arc::clone(&notch.controller),
            }),
        },
        chrono::Local,
        power,
    );
    app.manage(Arc::clone(&end_of_day));
    redmine.start();
    end_of_day.start();
    Some((redmine, end_of_day))
}

/// Gmail (`gmail-token.bin` holds the refresh token) and its client-file picker. The integration
/// is managed as `Arc<GmailIntegration>` (the notch page-load hook) and fills `slot` with the
/// picker, then starts: the registry predates `setup`, so the channels already exist (Electron
/// calls `gmail.start()` at creation). New mail goes to the notch as `gmail:new-mail`, then as
/// the capsule's mail alert. `None` (channels stay UNAVAILABLE) only when the HTTP client cannot
/// be built.
fn install_gmail(
    app: &AppHandle,
    slot: &GmailSlot,
    notch: &Arc<NotchRuntime>,
    data_dir: &std::path::Path,
) -> Option<Arc<GmailIntegration>> {
    use gmail::client_file::{app_file_picker, ClientFilePicker, DiskFiles};
    use gmail::ipc::{new_mail_listener, AppMailNotch, GmailApi, GmailHandles};

    let on_new_mail = new_mail_listener(Arc::new(AppMailNotch {
        app: app.clone(),
        controller: Arc::clone(&notch.controller),
    }));
    let gmail = gmail::integration::install(app, notch, data_dir, on_new_mail)?;
    app.manage(Arc::clone(&gmail));
    // The dialog's owner is the Control Center, read from the handle the main thread recorded.
    let owner = {
        let notch = Arc::clone(notch);
        Arc::new(move || notch.control_center_hwnd().unwrap_or(0))
    };
    let picker = ClientFilePicker::new(app_file_picker(owner), Arc::new(DiskFiles));
    let handles = GmailHandles {
        api: Arc::clone(&gmail) as Arc<dyn GmailApi>,
        client_file: Arc::new(picker),
    };
    if slot.set(handles).is_err() {
        log::error!(target: gmail::integration::LOG_TARGET, "Gmail installed twice");
    }
    gmail.start();
    Some(gmail)
}

/// The reminders (`reminders.json`) on the shared wall clock and timers (both follow the E2E
/// test clock): the alert flag, `reminders:*` events, toasts and usage counts. Starts loading in
/// the background (the channels wait for it) and is managed as `Arc<Reminders>`.
fn install_reminders(
    app: &AppHandle,
    slot: &RemindersSlot,
    notch: &Arc<NotchRuntime>,
    usage: &UsageLog,
    file: std::path::PathBuf,
    clock: Arc<services::clock::WallClock>,
) -> Arc<Reminders> {
    use contract::reminders::REMINDERS_STORE_NAME;
    use reminders::runtime::{RemindersRuntime, RuntimeOptions};
    use reminders::scheduler::{Safety, SAFETY_INTERVAL_MS};
    use reminders::toast::ReminderToast;

    let settings = {
        let app = app.clone();
        move || app.state::<settings::SettingsStore>().get()
    };
    let controller = Arc::clone(&notch.controller);
    let toast = {
        let settings = settings.clone();
        let controller = Arc::clone(&controller);
        ReminderToast::new(
            Box::new(|request| {
                platform::toast::show(request.title, request.body, request.sound, request.on_click)
            }),
            Box::new(move |key, params| i18n::t_with(settings().language, key, params)),
            Arc::new(move || {
                controller.dispatch(NotchEvent::OpenIntegration {
                    id: contract::notch::IntegrationId::Reminders,
                })
            }),
        )
    };
    let timers = notch.timers();
    let runtime = RemindersRuntime::new(
        RuntimeOptions {
            store: Arc::new(services::json_store::JsonStore::new(
                file,
                REMINDERS_STORE_NAME,
                Arc::clone(&clock),
            )),
            clock,
            new_id: Box::new(|| uuid::Uuid::new_v4().to_string()),
            snooze_minutes: {
                let settings = settings.clone();
                Box::new(move || settings().reminders.snooze_minutes)
            },
            safety: Some(Safety {
                timers: Arc::clone(&timers),
                period_ms: SAFETY_INTERVAL_MS,
            }),
            timers,
            toast: Arc::new(toast),
            set_due: Box::new(move |due| controller.dispatch(NotchEvent::Reminders { due })),
            emit_changed: {
                let app = app.clone();
                Box::new(move |snapshot| {
                    // Only the windows that exist (the Control Center is created on demand).
                    let targets: Vec<&str> = [ipc::NOTCH, ipc::CONTROL_CENTER]
                        .into_iter()
                        .filter(|label| app.get_webview_window(label).is_some())
                        .collect();
                    if !targets.is_empty() {
                        ipc::emit_event(&app, &targets, "reminders:changed", snapshot);
                    }
                })
            },
            emit_fired: {
                let app = app.clone();
                Box::new(move |count| {
                    // At startup the notch may not exist yet: then the chime is simply skipped.
                    if app.get_webview_window(ipc::NOTCH).is_some() {
                        let payload = contract::reminders::ReminderFired { count };
                        ipc::emit_event(&app, &[ipc::NOTCH], "reminders:fired", &payload);
                    }
                })
            },
            record_usage: {
                let usage = usage.clone();
                Some(Box::new(move |event| usage.record(event)))
            },
        },
        chrono::Local,
    );
    if slot
        .set(Arc::clone(&runtime) as Arc<dyn reminders::ipc::RemindersApi>)
        .is_err()
    {
        log::error!("reminders: installed twice");
    }
    app.manage(Arc::clone(&runtime));
    {
        let runtime = Arc::clone(&runtime);
        tauri::async_runtime::spawn(async move {
            if let Err(error) = runtime.start().await {
                log::error!("Reminders failed to start ({:?})", error.code());
            }
        });
    }
    runtime
}

/// Loads the Win32 system API and starts the monitor on a blocking worker (never the main
/// thread): samples run through `spawn_blocking`, on the notch's timers (the E2E test clock moves
/// them too) and a monotonic `Instant` clock. `system:metrics` / `system:processes` go to the
/// notch window only, skipped while it does not exist.
fn start_system(app: &AppHandle, system: Arc<SystemIntegration>, notch: &Arc<NotchRuntime>) {
    use system::ipc::StartOptions;
    use system::SystemApi;

    let controller = Arc::clone(&notch.controller);
    let timers = notch.timers();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let start = std::panic::AssertUnwindSafe(|| {
            let api = system::Win32SystemApi::new().map(|api| Arc::new(api) as Arc<dyn SystemApi>);
            let started = std::time::Instant::now();
            let options = StartOptions {
                api,
                timers,
                now: Arc::new(move || {
                    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
                }),
                executor: Arc::new(|job| {
                    tauri::async_runtime::spawn_blocking(job);
                }),
                alert_settings: {
                    let app = app.clone();
                    Box::new(move || app.state::<settings::SettingsStore>().get().system_alerts)
                },
                on_metrics: {
                    let app = app.clone();
                    Box::new(move |metrics| {
                        if app.get_webview_window(ipc::NOTCH).is_some() {
                            ipc::emit_event(&app, &[ipc::NOTCH], "system:metrics", metrics);
                        }
                    })
                },
                on_processes: {
                    let app = app.clone();
                    Box::new(move |rows| {
                        if app.get_webview_window(ipc::NOTCH).is_some() {
                            ipc::emit_event(&app, &[ipc::NOTCH], "system:processes", &rows);
                        }
                    })
                },
            };
            system.start(options, || controller.mode());
        });
        if std::panic::catch_unwind(start).is_err() {
            log::error!("System monitor failed to start");
        }
    });
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
