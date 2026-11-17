//! The Claude and Terminal tiles: `apps:open` (the inline handler of 0.1.0's `index.ts`) and the
//! system dependencies of the [`launcher`].

pub mod launcher;

use std::os::windows::ffi::OsStrExt;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Instant;

use serde::Serialize;
use serde_json::Value;

use self::launcher::{AppLauncher, LaunchResult, LauncherDeps, SpawnRequest};
use crate::contract::apps::{OpenAppInput, OpenAppResult};
use crate::ipc::{BoxFuture, Channel, Ctx, ExposedError, IpcErrorCode, Registry};

/// What `apps:open` acts on, filled in `setup`.
pub struct AppsHandles {
    pub launcher: AppLauncher,
    /// Closes the panel (`notch.dispatch({type: 'dismiss'})`).
    pub dismiss: Box<dyn Fn() + Send + Sync>,
}

pub type AppsSlot = OnceLock<AppsHandles>;

struct OpenChannel(Arc<AppsSlot>);

impl Channel for OpenChannel {
    fn handle<'a>(
        &'a self,
        _ctx: &'a Ctx,
        input: Value,
    ) -> BoxFuture<'a, Result<Value, ExposedError>> {
        Box::pin(async move {
            let OpenAppInput { app } = OpenAppInput::from_input(input)?;
            let handles = self
                .0
                .get()
                .ok_or_else(|| ExposedError::new(IpcErrorCode::Unavailable, "Not available yet"))?;
            let result = handles.launcher.open(app).await;
            log::info!("App launch {} {}", app.as_str(), result.as_str());
            // The app takes the screen: close the panel (a no-op when it is already closed).
            if !matches!(result, LaunchResult::Failed | LaunchResult::Ignored) {
                (handles.dismiss)();
            }
            serde_json::to_value(OpenAppResult {
                ok: result != LaunchResult::Failed,
            })
            .map_err(ExposedError::internal)
        })
    }
}

/// Registers `apps:open` (notch only, see `GUARDS`).
pub fn register(registry: &mut Registry, slot: &Arc<AppsSlot>) {
    registry.register("apps:open", OpenChannel(Arc::clone(slot)));
}

/// One launch recorded instead of performed (`globalThis.__notchAppLaunches` in Electron).
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum LaunchRecord {
    External { file: String },
    Spawn { file: String, args: Vec<String> },
}

/// The launches of a `NOTCH_APP_LAUNCH_LOG=1` session (managed state; `__e2e:app-launches`
/// reads it with the user folder).
pub struct LaunchLog {
    pub launches: Mutex<Vec<LaunchRecord>>,
    pub home: String,
}

impl LaunchLog {
    pub fn records(&self) -> Vec<LaunchRecord> {
        self.launches
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn push(&self, record: LaunchRecord) {
        self.launches
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(record);
    }
}

/// The URLs main asked the browser to open in a `NOTCH_OPEN_URL_LOG=1` session, recorded instead
/// of opened (managed state; `__e2e:opened-urls` reads it). The Tauri twin of the Electron specs
/// replacing `shell.openExternal` with a recorder (`__notchOpened`).
#[derive(Default)]
pub struct OpenedUrls(Mutex<Vec<String>>);

impl OpenedUrls {
    pub fn record(&self, url: String) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(url);
    }

    /// Every recorded URL, in the order they were asked for.
    pub fn urls(&self) -> Vec<String> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

/// `NOTCH_OPEN_URL_LOG=1`, read only when dev overrides are allowed: record the URLs to open in
/// the browser instead of opening them. False in a normal session.
pub fn open_url_log_switch() -> bool {
    crate::ipc::dev_overrides_enabled() && std::env::var("NOTCH_OPEN_URL_LOG").as_deref() == Ok("1")
}

/// The test switches, read only when dev overrides are allowed: `NOTCH_APP_LAUNCH_LOG=1`
/// records launches instead of performing them, and `NOTCH_APP_LAUNCH_FAIL=claude|terminal`
/// makes that app fail. `None` in a normal session.
pub fn launch_log_switch() -> Option<Option<String>> {
    if !crate::ipc::dev_overrides_enabled()
        || std::env::var("NOTCH_APP_LAUNCH_LOG").as_deref() != Ok("1")
    {
        return None;
    }
    Some(std::env::var("NOTCH_APP_LAUNCH_FAIL").ok())
}

fn monotonic_ms() -> Arc<dyn Fn() -> u64 + Send + Sync> {
    let start = Instant::now();
    Arc::new(move || u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX))
}

/// The launcher's dependencies on the real system. `home` is the user folder, read on the main
/// thread in `setup`.
pub fn system_deps(home: String) -> LauncherDeps {
    LauncherDeps {
        open_external: Arc::new(|url: String| {
            Box::pin(async move {
                tauri::async_runtime::spawn_blocking(move || shell_open(&url))
                    .await
                    .unwrap_or(false)
            })
        }),
        try_spawn: Arc::new(|request: SpawnRequest| {
            Box::pin(async move {
                tauri::async_runtime::spawn_blocking(move || spawn_process(&request))
                    .await
                    .unwrap_or(false)
            })
        }),
        exists: Arc::new(|path: &str| std::fs::symlink_metadata(path).is_ok()),
        home_dir: home,
        env: std::env::vars_os().collect(),
        now: monotonic_ms(),
    }
}

/// Recording dependencies for `NOTCH_APP_LAUNCH_LOG=1`: nothing is launched, every path exists,
/// and `fail` (`claude` or `terminal`) makes that app's launches fail.
pub fn log_deps(log: Arc<LaunchLog>, fail: Option<&str>) -> LauncherDeps {
    let fail_claude = fail == Some("claude");
    let fail_terminal = fail == Some("terminal");
    let external_log = Arc::clone(&log);
    let spawn_log = Arc::clone(&log);
    LauncherDeps {
        open_external: Arc::new(move |url: String| {
            if !fail_claude {
                external_log.push(LaunchRecord::External { file: url });
            }
            Box::pin(async move { !fail_claude })
        }),
        try_spawn: Arc::new(move |request: SpawnRequest| {
            if !fail_terminal {
                spawn_log.push(LaunchRecord::Spawn {
                    file: request.file,
                    args: request.args,
                });
            }
            Box::pin(async move { !fail_terminal })
        }),
        exists: Arc::new(|_: &str| true),
        home_dir: log.home.clone(),
        env: std::env::vars_os().collect(),
        now: monotonic_ms(),
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// `shell.openExternal`: `ShellExecuteW(open)` on this (blocking-pool) thread, with COM
/// initialized as the Shell asks. A result of 32 or less is a failure (no handler, etc.).
pub(crate) fn shell_open(url: &str) -> bool {
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let verb = wide("open");
    let file = wide(url);
    // SAFETY: both strings are NUL-terminated and outlive the call; the other pointers are null
    // as the API allows. COM is uninitialized only when this call initialized it.
    unsafe {
        let com = CoInitializeEx(
            std::ptr::null(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
        );
        let result = ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        );
        if com >= 0 {
            CoUninitialize();
        }
        result as isize > 32
    }
}

/// One argument as `CommandLineToArgvW` / the MSVC runtime read it back: quoted when empty or
/// when it holds a space, tab or quote; backslashes doubled only before a quote (or the closing
/// one).
fn quote_arg(arg: &str, out: &mut String) {
    if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
        out.push_str(arg);
        return;
    }
    out.push('"');
    let mut backslashes = 0usize;
    for character in arg.chars() {
        match character {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            other => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                out.push(other);
                backslashes = 0;
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
}

/// The command line: the program (always quoted) then each argument.
fn command_line(file: &str, args: &[String]) -> String {
    let mut line = String::new();
    quote_arg(file, &mut line);
    if !line.starts_with('"') {
        line = format!("\"{line}\"");
    }
    for arg in args {
        line.push(' ');
        quote_arg(arg, &mut line);
    }
    line
}

/// A `CREATE_UNICODE_ENVIRONMENT` block: `KEY=VALUE\0...\0`, sorted case-insensitively by key
/// as `CreateProcessW` expects, first value of a repeated key kept.
fn environment_block(env: &launcher::Env) -> Vec<u16> {
    let mut pairs: Vec<(String, Vec<u16>)> = Vec::new();
    for (key, value) in env {
        let upper = key.to_string_lossy().to_uppercase();
        if pairs.iter().any(|(seen, _)| *seen == upper) {
            continue;
        }
        let mut entry: Vec<u16> = key.encode_wide().collect();
        entry.push(u16::from(b'='));
        entry.extend(value.encode_wide());
        entry.push(0);
        pairs.push((upper, entry));
    }
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    let mut block: Vec<u16> = pairs.into_iter().flat_map(|(_, entry)| entry).collect();
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    block
}

/// Node's `spawn(file, args, {cwd, env, detached: true, windowsHide: false})`, with
/// `CreateProcessW` called directly: exactly `env`, `cwd`, `request.creation_flags`, and no
/// inherited or redirected handles, so a console shell started with `CREATE_NEW_CONSOLE` reads
/// and writes its own new console (and stays open) instead of a NUL stdin it would quit on.
/// True once the process started; its handles are closed right away (never waited on).
fn spawn_process(request: &SpawnRequest) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTF_USESHOWWINDOW,
        STARTUPINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWDEFAULT;

    if [&request.file, &request.cwd]
        .into_iter()
        .chain(&request.args)
        .any(|text| text.contains('\0'))
    {
        return false;
    }
    let application = wide(&request.file);
    let mut line = wide(&command_line(&request.file, &request.args));
    let cwd = wide(&request.cwd);
    let environment = environment_block(&request.env);
    // SAFETY: plain-data Win32 structs, valid when zeroed; `cb` is set as the API requires.
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of::<STARTUPINFOW>() as u32;
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_SHOWDEFAULT as u16;
    // SAFETY: as above.
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: every string is NUL-terminated and outlives the call (the command line is a
    // mutable buffer, as the API may write to it); the environment block ends with two NULs and
    // matches CREATE_UNICODE_ENVIRONMENT; no handle is inherited. On success both returned
    // handles are closed exactly once.
    unsafe {
        let started = CreateProcessW(
            application.as_ptr(),
            line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            request.creation_flags | CREATE_UNICODE_ENVIRONMENT,
            environment.as_ptr().cast(),
            cwd.as_ptr(),
            &startup,
            &mut process,
        );
        if started == 0 {
            return false;
        }
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    }
    true
}

/// `openExternal(url)`; the error is a code only.
pub type OpenExternal = Arc<dyn Fn(String) -> BoxFuture<'static, Result<(), String>> + Send + Sync>;

/// `^http:\/\/127\.0\.0\.1:(\d{1,5})$` with the port in 1..=65535 (`\d` is ASCII in a JS regex
/// without `u`).
pub fn is_loopback_origin(value: &str) -> bool {
    let Some(port) = value.strip_prefix("http://127.0.0.1:") else {
        return false;
    };
    (1..=5).contains(&port.len())
        && port.bytes().all(|byte| byte.is_ascii_digit())
        && port
            .parse::<u32>()
            .is_ok_and(|port| (1..=65_535).contains(&port))
}

/// The `https` origin of `url`, or `None` (not a URL, or not https).
pub fn origin_of(url: &str) -> Option<String> {
    let parsed = url::Url::parse(url).ok()?;
    (parsed.scheme() == "https").then(|| parsed.origin().ascii_serialization())
}

/// `shell.openExternal`, or the test recorder under `NOTCH_OPEN_URL_LOG=1` (dev/E2E only):
/// E2E never opens a real browser.
pub fn opener(app: &tauri::AppHandle) -> OpenExternal {
    use tauri::Manager;
    if let Some(log) = app.try_state::<Arc<OpenedUrls>>() {
        let log = Arc::clone(&log);
        return Arc::new(move |url: String| {
            log.record(url);
            Box::pin(async { Ok(()) })
        });
    }
    Arc::new(|url: String| {
        Box::pin(async move {
            let opened = tauri::async_runtime::spawn_blocking(move || shell_open(&url))
                .await
                .unwrap_or(false);
            if opened {
                Ok(())
            } else {
                Err("ShellExecute".to_owned())
            }
        })
    })
}

#[cfg(test)]
mod tests {
    use std::ffi::OsString;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    use serde_json::json;
    use tauri::async_runtime::block_on;

    use super::*;
    use crate::ipc::{Sender, NOTCH};
    use crate::services::test_dir::TestDir;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    fn call(registry: &Registry, input: Value) -> Value {
        let ctx = Ctx::for_test(Sender {
            label: NOTCH.into(),
            url: "http://tauri.localhost/notch/index.html".parse().unwrap(),
        });
        block_on(registry.dispatch(&ctx, "apps:open", Some(input)))
    }

    fn registry_with(fail: Option<&str>) -> (Registry, Arc<LaunchLog>, Arc<AtomicUsize>) {
        let log = Arc::new(LaunchLog {
            launches: Mutex::new(Vec::new()),
            home: "C:\\Users\\Ana".into(),
        });
        let dismissed = Arc::new(AtomicUsize::new(0));
        let slot = Arc::new(AppsSlot::new());
        let mut registry = Registry::with_dev_origin(false);
        register(&mut registry, &slot);
        assert_eq!(
            call(&registry, json!({ "app": "claude" }))["error"]["code"],
            "UNAVAILABLE"
        );
        let counter = Arc::clone(&dismissed);
        let handles = AppsHandles {
            launcher: AppLauncher::new(log_deps(Arc::clone(&log), fail)),
            dismiss: Box::new(move || {
                counter.fetch_add(1, Ordering::SeqCst);
            }),
        };
        assert!(slot.set(handles).is_ok());
        (registry, log, dismissed)
    }

    #[test]
    fn open_launches_and_closes_the_panel_and_ignores_a_double_click() {
        let (registry, log, dismissed) = registry_with(None);
        assert_eq!(
            call(&registry, json!({ "app": "claude" })),
            json!({ "ok": true, "data": { "ok": true } })
        );
        assert_eq!(dismissed.load(Ordering::SeqCst), 1);
        assert_eq!(
            log.records(),
            [LaunchRecord::External {
                file: "claude://claude.ai/new".into()
            }]
        );
        // Ignored: still ok, but the panel stays.
        assert_eq!(
            call(&registry, json!({ "app": "claude" })),
            json!({ "ok": true, "data": { "ok": true } })
        );
        assert_eq!(dismissed.load(Ordering::SeqCst), 1);
        assert_eq!(log.records().len(), 1);

        assert_eq!(
            call(&registry, json!({ "app": "terminal" }))["data"]["ok"],
            true
        );
        assert_eq!(dismissed.load(Ordering::SeqCst), 2);
        let records = log.records();
        let LaunchRecord::Spawn { file, args } = &records[1] else {
            panic!("{records:?}");
        };
        assert!(file.to_lowercase().ends_with("\\wt.exe"), "{file}");
        assert_eq!(args[..4], ["-w", "new", "-d", "C:\\Users\\Ana"]);
        assert_eq!(args.len(), 6);
        assert_eq!(
            serde_json::to_value(&records[1]).unwrap()["kind"],
            json!("spawn")
        );
    }

    #[test]
    fn a_failed_launch_answers_ok_false_and_keeps_the_panel() {
        let (registry, log, dismissed) = registry_with(Some("claude"));
        assert_eq!(
            call(&registry, json!({ "app": "claude" })),
            json!({ "ok": true, "data": { "ok": false } })
        );
        assert_eq!(dismissed.load(Ordering::SeqCst), 0);
        assert!(log.records().is_empty());

        let (registry, _log, dismissed) = registry_with(Some("terminal"));
        assert_eq!(
            call(&registry, json!({ "app": "terminal" }))["data"]["ok"],
            false
        );
        assert_eq!(dismissed.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn open_rejects_unknown_apps() {
        let (registry, _log, _dismissed) = registry_with(None);
        for input in [
            json!({ "app": "notepad" }),
            json!({}),
            json!({ "app": "claude", "x": 1 }),
            Value::Null,
        ] {
            assert_eq!(call(&registry, input)["error"]["code"], "INVALID_INPUT");
        }
    }

    #[test]
    fn launch_env_drops_notch_and_electron_vars() {
        let dir = TestDir::new("apps-spawn");
        let mut env: launcher::Env = std::env::vars_os().collect();
        env.push((OsString::from("NOTCH_SECRET_TEST"), OsString::from("1")));
        env.push((OsString::from("ELECTRON_RUN_AS_NODE"), OsString::from("1")));
        env.push((OsString::from("KEPT_TEST_VAR"), OsString::from("kept")));
        let system_root = std::env::var("SystemRoot").unwrap();
        let request = SpawnRequest {
            file: format!("{system_root}\\System32\\cmd.exe"),
            args: vec!["/d".into(), "/c".into(), "set > env.txt".into()],
            cwd: dir.path().to_string_lossy().into_owned(),
            env: launcher::clean_env(&env),
            // A test must never flash a console.
            creation_flags: CREATE_NO_WINDOW,
        };
        assert!(spawn_process(&request));
        let out = dir.join("env.txt");
        let mut text = String::new();
        for _ in 0..250 {
            text = std::fs::read_to_string(&out).unwrap_or_default();
            if text.contains("KEPT_TEST_VAR") {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(text.contains("KEPT_TEST_VAR=kept"), "the child ran in cwd");
        assert!(!text.contains("NOTCH_"));
        assert!(!text.contains("ELECTRON_"));
        // Let cmd.exe release the file before the folder is removed.
        std::thread::sleep(Duration::from_millis(100));
    }

    #[test]
    fn spawn_reports_a_missing_program() {
        let request = SpawnRequest {
            file: "C:\\definitely\\missing\\wt.exe".into(),
            args: Vec::new(),
            cwd: std::env::temp_dir().to_string_lossy().into_owned(),
            env: Vec::new(),
            creation_flags: CREATE_NO_WINDOW,
        };
        assert!(!spawn_process(&request));
    }

    #[test]
    fn command_line_quotes_like_the_msvc_runtime_reads_it() {
        let args = |list: &[&str]| list.iter().map(|arg| (*arg).to_owned()).collect::<Vec<_>>();
        assert_eq!(
            command_line(
                "C:\\Tools\\wt.exe",
                &args(&["-w", "new", "-d", "C:\\Users\\Ana María", "-NoLogo"])
            ),
            "\"C:\\Tools\\wt.exe\" -w new -d \"C:\\Users\\Ana María\" -NoLogo"
        );
        assert_eq!(
            command_line(
                "C:\\a b\\x.exe",
                &args(&["", "C:\\dir with space\\", "say \"hi\""])
            ),
            "\"C:\\a b\\x.exe\" \"\" \"C:\\dir with space\\\\\" \"say \\\"hi\\\"\""
        );
    }

    #[test]
    fn environment_block_is_sorted_and_double_terminated() {
        let env: launcher::Env = vec![
            (OsString::from("b"), OsString::from("2")),
            (OsString::from("A"), OsString::from("1")),
            (OsString::from("B"), OsString::from("dup")),
        ];
        let block = String::from_utf16(&environment_block(&env)).unwrap();
        assert_eq!(block, "A=1\0b=2\0\0");
        assert_eq!(environment_block(&Vec::new()), [0, 0]);
    }

    #[test]
    fn launch_records_serialize_like_electron() {
        assert_eq!(
            serde_json::to_value(LaunchRecord::External {
                file: "claude://claude.ai/new".into()
            })
            .unwrap(),
            json!({ "kind": "external", "file": "claude://claude.ai/new" })
        );
        assert_eq!(
            serde_json::to_value(LaunchRecord::Spawn {
                file: "C:\\wt.exe".into(),
                args: vec!["-NoLogo".into()]
            })
            .unwrap(),
            json!({ "kind": "spawn", "file": "C:\\wt.exe", "args": ["-NoLogo"] })
        );
    }
}
