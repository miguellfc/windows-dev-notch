use tauri::Url;

/// Window labels; the only webviews allowed to call `notch_ipc`.
pub const NOTCH: &str = "notch";
pub const CONTROL_CENTER: &str = "control-center";

/// Production origin of the bundled pages on Windows (WebView2 custom protocol).
const APP_HOST: &str = "tauri.localhost";
/// Vite dev server (`build.devUrl`); trusted only when dev overrides are enabled.
pub const DEV_ORIGIN: &str = "http://localhost:5174";

/// Which window may call a channel, on top of the trusted-sender check.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Guard {
    Any,
    NotchOnly,
    ControlCenterOnly,
}

impl Guard {
    pub fn allows(self, label: &str) -> bool {
        match self {
            Guard::Any => label == NOTCH || label == CONTROL_CENTER,
            Guard::NotchOnly => label == NOTCH,
            Guard::ControlCenterOnly => label == CONTROL_CENTER,
        }
    }
}

/// Copied from the `*ChannelGuards` helpers in 0.1.0's `*-ipc.ts`.
/// Channels missing here have no Electron guard and accept either window.
pub const GUARDS: &[(&str, Guard)] = &[
    // notch (0.1.0's `index.ts`)
    ("notch:capsule-rect", Guard::NotchOnly),
    // apps
    ("apps:open", Guard::NotchOnly),
    // claude
    ("claude:get-state", Guard::Any),
    ("claude:decide", Guard::NotchOnly),
    ("claude:focus-app", Guard::NotchOnly),
    ("claude:get-questions", Guard::NotchOnly),
    ("claude:answer", Guard::NotchOnly),
    ("claude:release-question", Guard::NotchOnly),
    ("claude:dismiss-session", Guard::NotchOnly),
    ("claude:hooks-preview", Guard::ControlCenterOnly),
    ("claude:hooks-install", Guard::ControlCenterOnly),
    ("claude:hooks-uninstall", Guard::ControlCenterOnly),
    ("claude:test-connection", Guard::ControlCenterOnly),
    ("claude:rotate-token", Guard::ControlCenterOnly),
    ("claude:rotate-port", Guard::ControlCenterOnly),
    // reminders
    ("reminders:list", Guard::Any),
    ("reminders:create", Guard::Any),
    ("reminders:update", Guard::ControlCenterOnly),
    ("reminders:snooze", Guard::Any),
    ("reminders:complete", Guard::Any),
    ("reminders:delete", Guard::Any),
    // usage
    ("usage:summary", Guard::ControlCenterOnly),
    // system
    ("system:view", Guard::NotchOnly),
    ("system:kill-process", Guard::NotchOnly),
    // notes
    ("notes:list", Guard::NotchOnly),
    ("notes:create", Guard::NotchOnly),
    ("notes:update", Guard::NotchOnly),
    ("notes:pin", Guard::NotchOnly),
    ("notes:delete", Guard::NotchOnly),
    ("notes:restore", Guard::NotchOnly),
    ("notes:copy", Guard::NotchOnly),
    // gmail
    ("gmail:get-state", Guard::Any),
    ("gmail:recent", Guard::NotchOnly),
    ("gmail:view", Guard::NotchOnly),
    ("gmail:refresh", Guard::NotchOnly),
    ("gmail:open", Guard::NotchOnly),
    ("gmail:message", Guard::NotchOnly),
    ("gmail:mark-read", Guard::NotchOnly),
    ("gmail:delete", Guard::NotchOnly),
    ("gmail:open-link", Guard::NotchOnly),
    ("gmail:close-message", Guard::NotchOnly),
    ("gmail:sign-in", Guard::ControlCenterOnly),
    ("gmail:cancel-sign-in", Guard::ControlCenterOnly),
    ("gmail:sign-out", Guard::ControlCenterOnly),
    ("gmail:pick-client-file", Guard::ControlCenterOnly),
    // code review
    ("code-review:get-state", Guard::Any),
    ("code-review:list", Guard::NotchOnly),
    ("code-review:refresh", Guard::NotchOnly),
    ("code-review:open", Guard::NotchOnly),
    ("code-review:set-token", Guard::ControlCenterOnly),
    ("code-review:clear", Guard::ControlCenterOnly),
    ("code-review:view", Guard::NotchOnly),
    ("code-review:contributions", Guard::NotchOnly),
    // redmine
    ("redmine:get-state", Guard::Any),
    ("redmine:issues", Guard::NotchOnly),
    ("redmine:issue", Guard::NotchOnly),
    ("redmine:activities", Guard::NotchOnly),
    ("redmine:update-issue", Guard::NotchOnly),
    ("redmine:log-time", Guard::NotchOnly),
    ("redmine:summary", Guard::NotchOnly),
    ("redmine:view", Guard::NotchOnly),
    ("redmine:refresh", Guard::NotchOnly),
    ("redmine:open", Guard::NotchOnly),
    ("redmine:set-key", Guard::ControlCenterOnly),
    ("redmine:clear", Guard::ControlCenterOnly),
];

pub fn guard_for(channel: &str) -> Guard {
    GUARDS
        .iter()
        .find(|(name, _)| *name == channel)
        .map_or(Guard::Any, |(_, guard)| *guard)
}

/// The calling webview: its window label and current top-level URL.
#[derive(Clone, Debug)]
pub struct Sender {
    pub label: String,
    pub url: Url,
}

/// Accepts only our own pages: `http://tauri.localhost/…`, or the dev server origin when allowed.
pub fn is_trusted_url(url: &Url, allow_dev_origin: bool) -> bool {
    let own_page = url.scheme() == "http"
        && url.host_str() == Some(APP_HOST)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none();
    own_page
        || (allow_dev_origin
            && Url::parse(DEV_ORIGIN).is_ok_and(|dev| dev.origin() == url.origin()))
}

pub fn is_trusted_sender(sender: &Sender, allow_dev_origin: bool) -> bool {
    Guard::Any.allows(&sender.label) && is_trusted_url(&sender.url, allow_dev_origin)
}

/// Dev-only overrides (R5): debug builds and the `e2e` feature.
pub fn dev_overrides_enabled() -> bool {
    cfg!(debug_assertions) || cfg!(feature = "e2e")
}

/// A dev/E2E switch from the environment: `None` in a release build without asking for it, so
/// the release binary neither reads nor contains the switch's name.
pub fn dev_env_var_os(name: &str) -> Option<std::ffi::OsString> {
    if dev_overrides_enabled() {
        std::env::var_os(name)
    } else {
        None
    }
}

/// [`dev_env_var_os`] as UTF-8 text (`None` when it is not).
pub fn dev_env_var(name: &str) -> Option<String> {
    dev_env_var_os(name).and_then(|value| value.into_string().ok())
}
