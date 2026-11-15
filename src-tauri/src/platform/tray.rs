//! The tray icon and its menu (`src/main/platform/{tray,tray-menu}.ts`).

use std::sync::Arc;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

use crate::contract::settings::{Language, SettingsPatch};
use crate::control_center::open_control_center;
use crate::i18n::t;
use crate::notch::display::primary_monitor;
use crate::notch::runtime::NotchRuntime;
use crate::notch::state::NotchEvent;
use crate::platform::autostart::launch_at_login_available;
use crate::settings::update::update_settings;
use crate::settings::SettingsStore;

/// What a tray menu item does when clicked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TrayAction {
    ToggleVisibility,
    OpenControlCenter,
    /// Turns start with Windows to the given value.
    SetLaunchAtLogin(bool),
    Quit,
}

impl TrayAction {
    /// The menu item id the action travels as.
    pub fn id(self) -> &'static str {
        match self {
            Self::ToggleVisibility => "toggle-visibility",
            Self::OpenControlCenter => "control-center",
            Self::SetLaunchAtLogin(true) => "launch-at-login-on",
            Self::SetLaunchAtLogin(false) => "launch-at-login-off",
            Self::Quit => "quit",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        [
            Self::ToggleVisibility,
            Self::OpenControlCenter,
            Self::SetLaunchAtLogin(true),
            Self::SetLaunchAtLogin(false),
            Self::Quit,
        ]
        .into_iter()
        .find(|action| action.id() == id)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TrayItem {
    Separator,
    Normal {
        label: String,
        action: TrayAction,
    },
    Checkbox {
        label: String,
        checked: bool,
        enabled: bool,
        action: TrayAction,
    },
}

/// Pure description of the tray menu; the Tauri glue turns it into a `Menu`.
pub fn build_tray_menu(
    language: Language,
    notch_visible: bool,
    launch_at_login: bool,
    launch_at_login_available: bool,
) -> Vec<TrayItem> {
    let normal = |key: &str, action| TrayItem::Normal {
        label: t(language, key),
        action,
    };
    vec![
        normal(
            if notch_visible {
                "tray.hide"
            } else {
                "tray.show"
            },
            TrayAction::ToggleVisibility,
        ),
        normal("tray.controlCenter", TrayAction::OpenControlCenter),
        TrayItem::Separator,
        TrayItem::Checkbox {
            label: t(language, "tray.launchAtLogin"),
            checked: launch_at_login,
            enabled: launch_at_login_available,
            action: TrayAction::SetLaunchAtLogin(!launch_at_login),
        },
        TrayItem::Separator,
        normal("tray.quit", TrayAction::Quit),
    ]
}

const TRAY_ID: &str = "main";
const TOOLTIP: &str = "Developer Notch";
const ICON: &[u8] = include_bytes!("../../../resources/tray.png");
const ICON_2X: &[u8] = include_bytes!("../../../resources/tray@2x.png");

/// The 16 px icon, or the 32 px one on a primary monitor scaled 150 % or more (Electron picks
/// `@2x` the same way).
fn icon() -> tauri::Result<Image<'static>> {
    let scale = primary_monitor().map_or(1.0, |monitor| monitor.scale);
    Image::from_bytes(if scale >= 1.5 { ICON_2X } else { ICON })
}

/// Creates the tray icon (main thread, from `setup`). Left click shows the capsule, like the
/// menu's "Show" (it un-hides even from an alert).
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon()?)
        .tooltip(TOOLTIP)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(
            |app, event| match TrayAction::from_id(event.id().as_ref()) {
                Some(action) => run(app, action),
                None => log::warn!("tray: unknown menu item"),
            },
        )
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                if let Some(notch) = tray.app_handle().try_state::<Arc<NotchRuntime>>() {
                    notch.controller.dispatch(NotchEvent::Show);
                }
            }
        })
        .build(app)?;
    Ok(())
}

/// Rebuilds the menu from the current state. Safe from any thread: the menu is built on the main
/// thread, so a worker never waits on it.
pub fn refresh(app: &AppHandle) {
    let handle = app.clone();
    let rebuild = move || {
        let Some(tray) = handle.tray_by_id(TRAY_ID) else {
            return;
        };
        match build_menu(&handle) {
            Ok(menu) => {
                if let Err(error) = tray.set_menu(Some(menu)) {
                    log::warn!("tray: could not set the menu: {error}");
                }
            }
            Err(error) => log::warn!("tray: could not build the menu: {error}"),
        }
    };
    if let Err(error) = app.run_on_main_thread(rebuild) {
        log::warn!("tray: could not schedule a refresh: {error}");
    }
}

/// Removes the tray icon (the quit sequence). The icon must be destroyed on the main thread: on any
/// other thread this only posts the removal there, without waiting.
pub fn remove(app: &AppHandle, on_main_thread: bool) {
    let handle = app.clone();
    let remove = move || drop(handle.remove_tray_by_id(TRAY_ID));
    if on_main_thread {
        remove();
    } else if let Err(error) = app.run_on_main_thread(remove) {
        log::warn!("tray: could not schedule the removal: {error}");
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let settings = app.state::<SettingsStore>().get();
    let notch_visible = app
        .try_state::<Arc<NotchRuntime>>()
        .is_none_or(|notch| !notch.controller.hidden());
    let items = build_tray_menu(
        settings.language,
        notch_visible,
        settings.launch_at_login,
        launch_at_login_available(),
    );
    let menu = Menu::new(app)?;
    for item in items {
        match item {
            TrayItem::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
            TrayItem::Normal { label, action } => {
                menu.append(&MenuItem::with_id(
                    app,
                    action.id(),
                    label,
                    true,
                    None::<&str>,
                )?)?;
            }
            TrayItem::Checkbox {
                label,
                checked,
                enabled,
                action,
            } => menu.append(&CheckMenuItem::with_id(
                app,
                action.id(),
                label,
                enabled,
                checked,
                None::<&str>,
            )?)?,
        }
    }
    Ok(menu)
}

fn run(app: &AppHandle, action: TrayAction) {
    match action {
        TrayAction::ToggleVisibility => {
            // "Show" must always show, even while a fullscreen app made the capsule yield (or an
            // alert shows over the hidden capsule).
            if let Some(notch) = app.try_state::<Arc<NotchRuntime>>() {
                let controller = &notch.controller;
                controller.dispatch(if controller.hidden() {
                    NotchEvent::Show
                } else {
                    NotchEvent::UserVisibility { hidden: true }
                });
            }
        }
        TrayAction::OpenControlCenter => open_control_center(app, None),
        TrayAction::SetLaunchAtLogin(enabled) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let patch = SettingsPatch {
                    launch_at_login: Some(enabled),
                    ..SettingsPatch::default()
                };
                if let Err(error) = update_settings(&app, patch).await {
                    log::error!("Could not change start with Windows: {error}");
                    // The checkbox toggled itself; show the real value again.
                    refresh(&app);
                }
            });
        }
        // The ordered quit (flushes) belongs to `RunEvent::ExitRequested` with a code.
        TrayAction::Quit => app.exit(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(items: &[TrayItem]) -> Vec<&str> {
        items
            .iter()
            .map(|item| match item {
                TrayItem::Separator => "---",
                TrayItem::Normal { label, .. } | TrayItem::Checkbox { label, .. } => label,
            })
            .collect()
    }

    fn launch_item(items: &[TrayItem]) -> &TrayItem {
        items
            .iter()
            .find(|item| matches!(item, TrayItem::Checkbox { .. }))
            .expect("start with Windows item")
    }

    #[test]
    fn tray_menu_matches_ts_labels() {
        assert_eq!(
            labels(&build_tray_menu(Language::Es, true, false, true)),
            [
                "Ocultar",
                "Control Center",
                "---",
                "Iniciar con Windows",
                "---",
                "Salir"
            ]
        );
        assert_eq!(
            labels(&build_tray_menu(Language::En, false, false, true)),
            [
                "Show",
                "Control Center",
                "---",
                "Start with Windows",
                "---",
                "Quit"
            ]
        );
    }

    #[test]
    fn tray_show_hide_label_follows_visibility() {
        assert_eq!(
            labels(&build_tray_menu(Language::Es, true, false, true))[0],
            "Ocultar"
        );
        assert_eq!(
            labels(&build_tray_menu(Language::Es, false, false, true))[0],
            "Mostrar"
        );
        assert_eq!(
            labels(&build_tray_menu(Language::En, true, false, true))[0],
            "Hide"
        );
    }

    #[test]
    fn tray_reflects_and_toggles_start_with_windows() {
        assert_eq!(
            launch_item(&build_tray_menu(Language::Es, true, true, true)),
            &TrayItem::Checkbox {
                label: "Iniciar con Windows".into(),
                checked: true,
                enabled: true,
                action: TrayAction::SetLaunchAtLogin(false),
            }
        );
        assert!(matches!(
            launch_item(&build_tray_menu(Language::Es, true, false, true)),
            TrayItem::Checkbox {
                checked: false,
                action: TrayAction::SetLaunchAtLogin(true),
                ..
            }
        ));
    }

    #[test]
    fn tray_disables_start_with_windows_when_not_available() {
        assert!(matches!(
            launch_item(&build_tray_menu(Language::Es, true, false, false)),
            TrayItem::Checkbox { enabled: false, .. }
        ));
    }

    #[test]
    fn tray_wires_every_action() {
        let actions: Vec<TrayAction> = build_tray_menu(Language::Es, true, false, true)
            .into_iter()
            .filter_map(|item| match item {
                TrayItem::Separator => None,
                TrayItem::Normal { action, .. } | TrayItem::Checkbox { action, .. } => Some(action),
            })
            .collect();
        assert_eq!(
            actions,
            [
                TrayAction::ToggleVisibility,
                TrayAction::OpenControlCenter,
                TrayAction::SetLaunchAtLogin(true),
                TrayAction::Quit,
            ]
        );
    }

    #[test]
    fn tray_action_ids_round_trip() {
        for action in [
            TrayAction::ToggleVisibility,
            TrayAction::OpenControlCenter,
            TrayAction::SetLaunchAtLogin(true),
            TrayAction::SetLaunchAtLogin(false),
            TrayAction::Quit,
        ] {
            assert_eq!(TrayAction::from_id(action.id()), Some(action));
        }
        assert_eq!(TrayAction::from_id("other"), None);
    }
}
