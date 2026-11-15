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

use crate::apps::LaunchLog;
use crate::contract::notch::PointerInput;
use crate::contract::{parse_input, Validate};
use crate::ipc::{
    no_input, BoxFuture, Channel, Ctx, ExposedError, IpcErrorCode, Registry, CONTROL_CENTER, NOTCH,
};
use crate::notch::display::work_area_dip;
use crate::notch::runtime::NotchRuntime;
use crate::notch::state::NotchEvent;
use crate::reminders::Reminders;
use crate::services::clock::WallClock;

/// `NOTCH_TEST_CLOCK=1`: the controller's timers follow a clock `__e2e:advance-clock` moves.
pub fn test_clock_enabled() -> bool {
    std::env::var("NOTCH_TEST_CLOCK").as_deref() == Ok("1")
}

type HandlerFn = fn(&AppHandle, Value) -> Result<Value, ExposedError>;
type AsyncHandlerFn = fn(AppHandle, Value) -> BoxFuture<'static, Result<Value, ExposedError>>;

/// How a test channel runs: inline on the IPC task, on a blocking-pool thread for the ones
/// that wait on Win32 (the clipboard may retry for up to 100 ms), or as a future for the ones
/// that wait on async work (the reminders check after the clock moves).
#[derive(Clone, Copy)]
pub enum Handler {
    Inline(HandlerFn),
    Blocking(HandlerFn),
    Async(AsyncHandlerFn),
}

struct TestChannel(Handler);

impl Channel for TestChannel {
    fn handle<'a>(
        &'a self,
        ctx: &'a Ctx,
        input: Value,
    ) -> BoxFuture<'a, Result<Value, ExposedError>> {
        let Some(app) = ctx.app() else {
            return Box::pin(async { Err(unavailable()) });
        };
        match self.0 {
            Handler::Inline(handler) => {
                let result = handler(app, input);
                Box::pin(async move { result })
            }
            Handler::Blocking(handler) => {
                let app = app.clone();
                Box::pin(async move {
                    tauri::async_runtime::spawn_blocking(move || handler(&app, input))
                        .await
                        .map_err(internal)?
                })
            }
            Handler::Async(handler) => handler(app.clone(), input),
        }
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

/// Moves the test clock (`__notchTestClock.advance`): the wall clock, the timers due by then,
/// and answers once the reminders check it forces has finished (Electron returns that promise).
fn advance_clock(app: AppHandle, input: Value) -> BoxFuture<'static, Result<Value, ExposedError>> {
    Box::pin(async move {
        let AdvanceClockInput { ms } = parse_input(input)?;
        let notch = runtime(&app)?;
        let clock = notch.test_clock().ok_or_else(unavailable)?;
        // The wall clock first (`clockOffsetMs += ms` in Electron), so whatever the due timers
        // run already sees the new time.
        if let Some(wall) = app.try_state::<Arc<WallClock>>() {
            wall.advance(i64::try_from(ms).unwrap_or(i64::MAX));
        }
        clock.advance(ms);
        let reminders = app
            .try_state::<Arc<Reminders>>()
            .map(|state| Arc::clone(&state));
        if let Some(reminders) = reminders {
            reminders.check().await;
        }
        Ok(Value::Null)
    })
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

/// What the launcher recorded under `NOTCH_APP_LAUNCH_LOG=1` (`__notchAppLaunches` in Electron)
/// and the user folder the terminal must open in. UNAVAILABLE without the switch.
fn app_launches(app: &AppHandle, input: Value) -> Result<Value, ExposedError> {
    no_input(&input)?;
    let log = app
        .try_state::<Arc<LaunchLog>>()
        .map(|state| Arc::clone(&state))
        .ok_or_else(unavailable)?;
    json(serde_json::json!({ "launches": log.records(), "home": log.home }))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClipboardInput {
    text: String,
}

impl Validate for ClipboardInput {}

/// The system clipboard: no input reads its text (`null` when it holds none); `{text}` writes
/// it (to put back what the user had before the copy test).
fn clipboard(_app: &AppHandle, input: Value) -> Result<Value, ExposedError> {
    if input.is_null() {
        return json(crate::platform::clipboard::read_text().map_err(internal)?);
    }
    let ClipboardInput { text } = parse_input(input)?;
    crate::platform::clipboard::write_text(&text).map_err(internal)?;
    Ok(Value::Null)
}

/// Accumulated CPU time (user + kernel, ms) of this app's process tree (`cpuMs`, and `perProcess`
/// by pid, this process first): this process and every
/// descendant (the WebView2 browser, renderer, GPU and utility processes), the Tauri twin of
/// summing Electron's `app.getAppMetrics()`. A process that ended between the snapshot and the
/// read is skipped, so callers compare readings taken a few seconds apart.
fn process_cpu(_app: &AppHandle, input: Value) -> Result<Value, ExposedError> {
    no_input(&input)?;
    let tree = process_tree(std::process::id());
    let per_process: Vec<Value> = tree
        .iter()
        .filter_map(|&pid| {
            cpu_time_ms(pid).map(|ms| serde_json::json!({ "pid": pid, "cpuMs": ms }))
        })
        .collect();
    let cpu_ms: f64 = per_process
        .iter()
        .filter_map(|entry| entry["cpuMs"].as_f64())
        .sum();
    json(serde_json::json!({
        "cpuMs": cpu_ms,
        "processes": tree.len(),
        "perProcess": per_process,
    }))
}

/// `root` and all its descendants, from one toolhelp snapshot.
fn process_tree(root: u32) -> Vec<u32> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut parents: Vec<(u32, u32)> = Vec::new();
    // SAFETY: plain values in; the handle is checked and closed below.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot.is_null() || snapshot == INVALID_HANDLE_VALUE {
        return vec![root];
    }
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // SAFETY: valid snapshot handle and a local entry with its size field set.
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) } != 0;
    while ok {
        parents.push((entry.th32ProcessID, entry.th32ParentProcessID));
        // SAFETY: as above.
        ok = unsafe { Process32NextW(snapshot, &mut entry) } != 0;
    }
    // SAFETY: the snapshot handle is valid and closed exactly once.
    unsafe {
        CloseHandle(snapshot);
    }
    let mut tree = vec![root];
    let mut index = 0;
    while index < tree.len() {
        let parent = tree[index];
        for &(pid, parent_pid) in &parents {
            // pid 0 (System Idle) lists itself as its own parent.
            if parent_pid == parent && pid != parent && !tree.contains(&pid) {
                tree.push(pid);
            }
        }
        index += 1;
    }
    tree
}

/// `GetProcessTimes` kernel + user time of `pid`, in ms; `None` when it cannot be read.
fn cpu_time_ms(pid: u32) -> Option<f64> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: plain values in; a null handle is checked before use.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return None;
    }
    let mut times = [FILETIME::default(); 4];
    let [creation, exit, kernel, user] = &mut times;
    // SAFETY: a valid process handle and four local FILETIMEs.
    let ok = unsafe { GetProcessTimes(process, creation, exit, kernel, user) } != 0;
    // SAFETY: the handle is valid and closed exactly once.
    unsafe {
        CloseHandle(process);
    }
    let ticks =
        |time: &FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
    ok.then(|| (ticks(&times[2]) + ticks(&times[3])) as f64 / 10_000.0)
}

/// Applies `--e2e-env-NAME=VALUE` command-line arguments as environment variables, before
/// anything reads them: tauri-driver gives every session the same environment, so a spec that
/// needs its own switch (`NOTCH_APP_LAUNCH_FAIL=claude`) passes it through `tauri:options.args`.
/// msedgedriver hands those arguments over as Chromium switches, which keeps one value per switch
/// name and may lowercase the name: hence one switch per variable, and the name upper-cased here.
/// Only `NOTCH_*` names are accepted. Called first thing in `run`, while the process has a
/// single thread.
pub fn apply_cli_env() {
    for arg in std::env::args().skip(1) {
        let Some(pair) = arg.strip_prefix("--e2e-env-") else {
            continue;
        };
        if let Some((name, value)) = pair.split_once('=') {
            let name = name.to_ascii_uppercase();
            if name.starts_with("NOTCH_") {
                std::env::set_var(name, value);
            }
        }
    }
}

/// Every `__e2e:*` channel and its handler.
pub const CHANNELS: &[(&str, Handler)] = &[
    ("__e2e:window-bounds", Handler::Inline(window_bounds)),
    (
        "__e2e:foreground-is-ours",
        Handler::Inline(foreground_is_ours),
    ),
    ("__e2e:advance-clock", Handler::Async(advance_clock)),
    ("__e2e:pointer", Handler::Inline(pointer)),
    ("__e2e:mail-alert", Handler::Inline(mail_alert)),
    ("__e2e:shortcut", Handler::Inline(shortcut)),
    ("__e2e:work-area", Handler::Inline(work_area)),
    ("__e2e:pid", Handler::Inline(pid)),
    ("__e2e:quit", Handler::Inline(quit)),
    ("__e2e:app-launches", Handler::Inline(app_launches)),
    ("__e2e:clipboard", Handler::Blocking(clipboard)),
    ("__e2e:process-cpu", Handler::Blocking(process_cpu)),
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
        registry.register_test_channel("notch:extra", TestChannel(Handler::Inline(pid)));
    }
}
