//! The Control Center window (`src/main/windows/control-center-window.ts` and `showControlCenter`
//! in `src/main/index.ts`).
//!
//! Unlike Electron (hidden title bar with an overlay), it keeps the native title bar with the
//! dark theme over Mica; the renderer hides its title-bar spacer under Tauri.
//!
//! The page to show travels in the URL hash: a new window loads with it; an open one gets it as a
//! same-document hash change once its page has loaded (never a reload). The renderer reads the
//! hash at start and on `hashchange`, then clears it, so asking twice for one page still works.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use tauri::window::{Effect, EffectsBuilder};
use tauri::{
    AppHandle, Manager, Theme, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::contract::app::ControlCenterPage;
use crate::ipc::{BRIDGE_SCRIPT, CONTROL_CENTER};
use crate::notch::runtime::NotchRuntime;
use crate::notch::state::NotchEvent;
use crate::security::harden;

const PAGE: &str = "control-center/index.html";
const TITLE: &str = "Control Center · Developer Notch";

/// Load state of the open window, shared by `open` and the page-load hook.
#[derive(Default)]
pub struct ControlCenterState {
    /// The page has finished loading (Electron's `!isLoading()`).
    loaded: AtomicBool,
    /// Asked for while the page was still loading; applied when it finishes.
    pending: Mutex<Option<ControlCenterPage>>,
    /// The window has been shown once (Electron's `ready-to-show`).
    shown: AtomicBool,
}

impl ControlCenterState {
    fn reset(&self) {
        self.loaded.store(false, Ordering::SeqCst);
        self.shown.store(false, Ordering::SeqCst);
        *self.pending.lock().unwrap_or_else(PoisonError::into_inner) = None;
    }
}

/// `location.hash = '<page>'`. `page` is a validated enum, never renderer input.
fn hash_script(page: ControlCenterPage) -> String {
    format!("location.hash = '{}'", page.as_str())
}

/// The app-relative URL of the page, with `page` as its hash.
pub fn page_url(page: Option<ControlCenterPage>) -> String {
    match page {
        Some(page) => format!("{PAGE}#{}", page.as_str()),
        None => PAGE.to_owned(),
    }
}

/// Opens the Control Center, or restores and focuses it (moving it to `page` when given). The
/// capsule is dismissed first, like Electron's `showControlCenter`. Safe from any thread and never
/// waits: the work is posted to the main thread, where the window handle can be read without
/// blocking.
pub fn open_control_center(app: &AppHandle, page: Option<ControlCenterPage>) {
    if let Some(notch) = app.try_state::<Arc<NotchRuntime>>() {
        notch.controller.dispatch(NotchEvent::Dismiss);
    }
    // Always a fresh turn of the event loop, even from the main thread: `run_on_main_thread`
    // runs inline there, and building a webview inside a WebView2 callback (a page-load
    // handler, say) never returns.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let app = handle.clone();
        if let Err(error) = app.run_on_main_thread(move || open_on_main_thread(&handle, page)) {
            log::error!("Could not open the Control Center: {error}");
        }
    });
}

fn open_on_main_thread(app: &AppHandle, page: Option<ControlCenterPage>) {
    if let Some(window) = app.get_webview_window(CONTROL_CENTER) {
        if let Some(page) = page {
            show_page(app, &window, page);
        }
        if window.is_minimized().unwrap_or(false) {
            log_err("unminimize", window.unminimize());
        }
        log_err("show", window.show());
        log_err("set_focus", window.set_focus());
        return;
    }
    if let Err(error) = create(app, page) {
        log::error!("Could not create the Control Center window: {error}");
    }
}

fn show_page(app: &AppHandle, window: &WebviewWindow, page: ControlCenterPage) {
    let state = app.state::<ControlCenterState>();
    if state.loaded.load(Ordering::SeqCst) {
        if let Err(error) = window.eval(hash_script(page)) {
            log::warn!("Control Center could not switch page: {error}");
        }
    } else {
        *state.pending.lock().unwrap_or_else(PoisonError::into_inner) = Some(page);
    }
}

fn create(app: &AppHandle, page: Option<ControlCenterPage>) -> tauri::Result<()> {
    app.state::<ControlCenterState>().reset();
    let builder =
        WebviewWindowBuilder::new(app, CONTROL_CENTER, WebviewUrl::App(page_url(page).into()))
            .title(TITLE)
            .inner_size(760.0, 520.0)
            .min_inner_size(640.0, 440.0)
            .center()
            .theme(Some(Theme::Dark))
            .transparent(true)
            .effects(EffectsBuilder::new().effect(Effect::Mica).build())
            .visible(false)
            .initialization_script(BRIDGE_SCRIPT);
    let window = harden(builder, PAGE).build()?;

    // Read here, on the main thread: the foreground watcher must never ask for it.
    let hwnd = window.hwnd()?.0 as isize;
    if let Some(notch) = app.try_state::<Arc<NotchRuntime>>() {
        notch.set_control_center_hwnd(Some(hwnd));
    }
    let handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            if let Some(notch) = handle.try_state::<Arc<NotchRuntime>>() {
                notch.set_control_center_hwnd(None);
            }
            handle.state::<ControlCenterState>().reset();
        }
    });
    Ok(())
}

/// The page started loading again (a reload): a page asked for now waits for it.
pub fn page_started(app: &AppHandle) {
    app.state::<ControlCenterState>()
        .loaded
        .store(false, Ordering::SeqCst);
}

/// The page finished loading: show the window the first time (Electron's `ready-to-show`) and
/// apply a page asked for meanwhile.
pub fn page_loaded(app: &AppHandle) {
    let Some(window) = app.get_webview_window(CONTROL_CENTER) else {
        return;
    };
    let state = app.state::<ControlCenterState>();
    state.loaded.store(true, Ordering::SeqCst);
    if !state.shown.swap(true, Ordering::SeqCst) {
        log_err("show", window.show());
        log_err("set_focus", window.set_focus());
    }
    let pending = state
        .pending
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .take();
    if let Some(page) = pending {
        if let Err(error) = window.eval(hash_script(page)) {
            log::warn!("Control Center could not switch page: {error}");
        }
    }
}

fn log_err(what: &str, result: tauri::Result<()>) {
    if let Err(error) = result {
        log::warn!("Control Center window: {what} failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_page_travels_in_the_hash() {
        assert_eq!(page_url(None), "control-center/index.html");
        assert_eq!(
            page_url(Some(ControlCenterPage::CodeReview)),
            "control-center/index.html#code-review"
        );
        assert_eq!(
            hash_script(ControlCenterPage::Gmail),
            "location.hash = 'gmail'"
        );
        for page in ControlCenterPage::ALL {
            // Only the enum's fixed names ever reach the script.
            assert!(page
                .as_str()
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b == b'-'));
        }
    }
}
