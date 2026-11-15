//! Test-only channels (`__e2e:*`) for `tests/e2e-tauri`, the Tauri twin of what the Electron
//! specs read with `app.evaluate`. The module exists only with the `e2e` cargo feature, which a
//! release build never enables (R5): those channels are not in `channels.json`, and a build without
//! the feature cannot register them (`Registry::register_test_channel` is gated the same way).
//!
//! Tests call them from either window, bypassing `window.notch`:
//! `window.__TAURI_INTERNALS__.invoke('notch_ipc', { channel: '__e2e:pid', input })`. The usual
//! trusted-sender check still applies.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::contract::notch::PointerInput;
use crate::contract::{parse_input, Validate};
use crate::ipc::{
    no_input, BoxFuture, Channel, Ctx, ExposedError, IpcErrorCode, Registry, CONTROL_CENTER, NOTCH,
};
use crate::notch::display::work_area_dip;
use crate::notch::runtime::NotchRuntime;
use crate::notch::state::NotchEvent;

/// `NOTCH_TEST_CLOCK=1`: the controller's timers follow a clock `__e2e:advance-clock` moves.
pub fn test_clock_enabled() -> bool {
    std::env::var("NOTCH_TEST_CLOCK").as_deref() == Ok("1")
}

type Handler = fn(&AppHandle, Value) -> Result<Value, ExposedError>;

struct TestChannel(Handler);

impl Channel for TestChannel {
    fn handle<'a>(
        &'a self,
        ctx: &'a Ctx,
        input: Value,
    ) -> BoxFuture<'a, Result<Value, ExposedError>> {
        let result = match ctx.app() {
            Some(app) => (self.0)(app, input),
            None => Err(unavailable()),
        };
        Box::pin(async move { result })
    }
}

fn unavailable() -> ExposedError {
    ExposedError::new(IpcErrorCode::Unavailable, "Not available")
}

fn internal(error: impl std::fmt::Display) -> ExposedError {
    ExposedError::internal(error)
}

fn runtime(app: &AppHandle) -> Result<Arc<NotchRuntime>, ExposedError> {
    app.try_state::<Arc<NotchRuntime>>()
        .map(|state| Arc::clone(&state))
        .ok_or_else(unavailable)
}

fn json(value: impl Serialize) -> Result<Value, ExposedError> {
    serde_json::to_value(value).map_err(internal)
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct WindowInput {
    /// A window label; the capsule when not sent.
    window: Option<String>,
}

impl Validate for WindowInput {}

/// A window as Electron's `getBounds()`, `isVisible()`, `isAlwaysOnTop()` and `isFocused()`
/// report it, in the DIP of the capsule's monitor (the controller's units, so it compares with
/// `__e2e:work-area`). `null` while that window does not exist.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
    always_on_top: bool,
    focused: bool,
    title: String,
}

fn window_bounds(app: &AppHandle, input: Value) -> Result<Value, ExposedError> {
    let WindowInput { window } = if input.is_null() {
        WindowInput::default()
    } else {
        parse_input(input)?
    };
    let label = window.as_deref().unwrap_or(NOTCH);
    if label != NOTCH && label != CONTROL_CENTER {
        return Err(ExposedError::new(
            IpcErrorCode::InvalidInput,
            "Invalid input",
        ));
    }
    let Some(window) = app.get_webview_window(label) else {
        return Ok(Value::Null);
    };
    let scale = runtime(app)?.display.current().scale;
    let position = window.outer_position().map_err(internal)?;
    let size = window.outer_size().map_err(internal)?;
    let hwnd = window.hwnd().map_err(internal)?.0 as isize;
    json(WindowBounds {
        x: f64::from(position.x) / scale,
        y: f64::from(position.y) / scale,
        width: f64::from(size.width) / scale,
        height: f64::from(size.height) / scale,
        visible: window.is_visible().map_err(internal)?,
        always_on_top: is_topmost(hwnd),
        focused: window.is_focused().map_err(internal)?,
        title: window.title().map_err(internal)?,
    })
}

fn is_topmost(hwnd: isize) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TOPMOST,
    };
    // SAFETY: a plain style query; a stale handle only returns 0.
    let style = unsafe { GetWindowLongPtrW(hwnd as _, GWL_EXSTYLE) };
    style as u32 & WS_EX_TOPMOST != 0
}

/// Whether the foreground window belongs to this process: the capsule must never take the focus
/// outside its panels.
fn foreground_is_ours(_app: &AppHandle, input: Value) -> Result<Value, ExposedError> {
    no_input(&input)?;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId,
    };
    let mut pid = 0u32;
    // SAFETY: plain Win32 queries; a null foreground window leaves `pid` at 0.
    unsafe {
        let foreground = GetForegroundWindow();
        if !foreground.is_null() {
            GetWindowThreadProcessId(foreground, &mut pid);
        }
    }
    Ok(Value::from(pid != 0 && pid == std::process::id()))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct AdvanceClockInput {
    ms: u64,
}

impl Validate for AdvanceClockInput {}

fn advance_clock(app: &AppHandle, input: Value) -> Result<Value, ExposedError> {
    let AdvanceClockInput { ms } = parse_input(input)?;
    let notch = runtime(app)?;
    let clock = notch.test_clock().ok_or_else(unavailable)?;
    clock.advance(ms);
    Ok(Value::Null)
}

fn pointer(app: &AppHandle, input: Value) -> Result<Value, ExposedError> {
    let PointerInput { inside } = parse_input(input)?;
    runtime(app)?
        .controller
        .dispatch(NotchEvent::Pointer { inside });
    Ok(Value::Null)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MailAlertInput {
    on: bool,
}

impl Validate for MailAlertInput {}

/// A new-mail alert on or off: the only alert part 1 can raise (its integrations are not ported).
fn mail_alert(app: &AppHandle, input: Value) -> Result<Value, ExposedError> {
    let MailAlertInput { on } = parse_input(input)?;
    runtime(app)?.controller.dispatch(NotchEvent::Mail { on });
    Ok(Value::Null)
}

/// The global shortcut, without pressing real keys.
fn shortcut(app: &AppHandle, input: Value) -> Result<Value, ExposedError> {
    no_input(&input)?;
    crate::platform::shortcut::trigger(app);
    Ok(Value::Null)
}

fn work_area(app: &AppHandle, input: Value) -> Result<Value, ExposedError> {
    no_input(&input)?;
    let area = work_area_dip(&runtime(app)?.display.current());
    json(serde_json::json!({
        "x": area.x,
        "y": area.y,
        "width": area.width,
        "height": area.height,
    }))
}

fn pid(_app: &AppHandle, input: Value) -> Result<Value, ExposedError> {
    no_input(&input)?;
    Ok(Value::from(std::process::id()))
}

/// The tray's Quit (the ordered quit that saves the usage log), a moment after answering.
fn quit(app: &AppHandle, input: Value) -> Result<Value, ExposedError> {
    no_input(&input)?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        app.exit(0);
    });
    Ok(Value::Null)
}

/// Every `__e2e:*` channel and its handler.
pub const CHANNELS: &[(&str, Handler)] = &[
    ("__e2e:window-bounds", window_bounds),
    ("__e2e:foreground-is-ours", foreground_is_ours),
    ("__e2e:advance-clock", advance_clock),
    ("__e2e:pointer", pointer),
    ("__e2e:mail-alert", mail_alert),
    ("__e2e:shortcut", shortcut),
    ("__e2e:work-area", work_area),
    ("__e2e:pid", pid),
    ("__e2e:quit", quit),
];

pub fn register(registry: &mut Registry) {
    for &(name, handler) in CHANNELS {
        registry.register_test_channel(name, TestChannel(handler));
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tauri::async_runtime::block_on;

    use super::*;
    use crate::ipc::{guard_for, Guard, Sender, TEST_CHANNEL_PREFIX};

    fn call(registry: &Registry, label: &str, page: &str, channel: &str, input: Value) -> Value {
        let ctx = Ctx::for_test(Sender {
            label: label.into(),
            url: format!("http://tauri.localhost/{page}/index.html")
                .parse()
                .unwrap(),
        });
        block_on(registry.dispatch(&ctx, channel, Some(input)))
    }

    #[test]
    fn test_channels_are_registered_for_both_windows() {
        let mut registry = Registry::with_dev_origin(false);
        register(&mut registry);
        let names = registry.channel_names();
        for &(name, _) in CHANNELS {
            assert!(name.starts_with(TEST_CHANNEL_PREFIX), "{name}");
            assert!(names.contains(&name), "{name}");
            assert_eq!(guard_for(name), Guard::Any, "{name}");
            // Past the guards for both windows; without an app handle the handler answers UNAVAILABLE.
            for (label, page) in [(NOTCH, "notch"), (CONTROL_CENTER, "control-center")] {
                let response = call(&registry, label, page, name, Value::Null);
                assert_ne!(response["error"]["code"], json!("FORBIDDEN"), "{name}");
            }
        }
        // An untrusted page is still refused.
        let ctx = Ctx::for_test(Sender {
            label: NOTCH.into(),
            url: "https://evil.test/notch/index.html".parse().unwrap(),
        });
        let response = block_on(registry.dispatch(&ctx, "__e2e:pid", None));
        assert_eq!(response["error"]["code"], json!("FORBIDDEN"));
    }

    #[test]
    #[should_panic(expected = "not a test channel")]
    fn only_e2e_names_can_be_registered_as_test_channels() {
        let mut registry = Registry::with_dev_origin(false);
        registry.register_test_channel("notch:extra", TestChannel(pid));
    }
}
