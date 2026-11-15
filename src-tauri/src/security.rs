//! Locks down every webview (`src/main/windows/secure-window.ts`): a page can only stay on its
//! own document, never open windows, and gets no browser permissions (the permission handler is
//! set app-wide in `lib.rs`). Devtools exist only in debug builds.

use tauri::webview::NewWindowResponse;
use tauri::{Manager, Runtime, Url, WebviewWindowBuilder};

use crate::ipc::{dev_overrides_enabled, is_trusted_url};
use crate::services::logger::url_for_log;

/// The app's own origin (or the dev server when allowed) and exactly `page` (`notch/index.html`).
/// Hash and query changes stay allowed: the Control Center switches pages through the hash.
pub fn is_allowed_navigation(url: &Url, page: &str, allow_dev_origin: bool) -> bool {
    is_trusted_url(url, allow_dev_origin) && url.path().strip_prefix('/') == Some(page)
}

/// Applies the navigation, popup and devtools rules to a window that shows `page`.
pub fn harden<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
    page: &'static str,
) -> WebviewWindowBuilder<'a, R, M> {
    let allow_dev_origin = dev_overrides_enabled();
    builder
        .on_navigation(move |url| {
            let allowed = is_allowed_navigation(url, page, allow_dev_origin);
            if !allowed {
                log::warn!("Blocked navigation to {}", url_for_log(url.as_str()));
            }
            allowed
        })
        .on_new_window(|url, _features| {
            log::warn!("Blocked window.open to {}", url_for_log(url.as_str()));
            NewWindowResponse::Deny
        })
        .devtools(cfg!(debug_assertions))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(url: &str, dev: bool) -> bool {
        is_allowed_navigation(&Url::parse(url).unwrap(), "control-center/index.html", dev)
    }

    #[test]
    fn only_the_own_page_is_allowed() {
        assert!(allowed(
            "http://tauri.localhost/control-center/index.html",
            false
        ));
        assert!(allowed(
            "http://tauri.localhost/control-center/index.html#gmail",
            false
        ));
        // Another page of the app, another origin, or the dev server in a release build.
        assert!(!allowed("http://tauri.localhost/notch/index.html", false));
        assert!(!allowed(
            "https://evil.test/control-center/index.html",
            false
        ));
        assert!(!allowed(
            "http://localhost:5174/control-center/index.html",
            false
        ));
        assert!(!allowed("file:///C:/control-center/index.html", false));
        assert!(!allowed("about:blank", false));
    }

    #[test]
    fn the_dev_server_is_allowed_only_with_dev_overrides() {
        assert!(allowed(
            "http://localhost:5174/control-center/index.html",
            true
        ));
        assert!(!allowed(
            "http://localhost:5175/control-center/index.html",
            true
        ));
    }
}
