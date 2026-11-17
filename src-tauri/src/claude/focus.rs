//! Brings Claude Desktop's window to the front (port of 0.1.0's `bring-claude-to-front.ts`):
//! the sequence validated in the Electron M3 spike, behind [`Win32FocusApi`] so it is unit-tested
//! with a fake. Used by `claude:focus-app` and `claude:release-question`.
//!
//! [`focus_claude`] runs the real sequence on a dedicated thread: `AttachThreadInput` ties THAT
//! thread's input state to the foreground thread's, so its own `GetCurrentThreadId` is the one
//! attached. Only the result name is logged (never a title or a path).

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};

/// A window handle as a plain value (compared by value); `0` is "no window".
pub type Hwnd = isize;

/// `BringToFrontResult`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BringToFrontResult {
    Focused,
    NotRunning,
    Blocked,
}

impl BringToFrontResult {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Focused => "focused",
            Self::NotRunning => "not-running",
            Self::Blocked => "blocked",
        }
    }
}

/// The Win32 calls of the sequence (`Win32FocusApi`).
pub trait Win32FocusApi {
    /// Visible top-level window with a non-empty title owned by `claude.exe`, if any.
    fn find_claude_window(&self) -> Option<Hwnd>;
    fn get_foreground_window(&self) -> Hwnd;
    fn same_window(&self, a: Hwnd, b: Hwnd) -> bool;
    fn get_window_thread_id(&self, hwnd: Hwnd) -> u32;
    fn get_current_thread_id(&self) -> u32;
    fn attach_thread_input(&self, from: u32, to: u32, attach: bool) -> bool;
    fn is_iconic(&self, hwnd: Hwnd) -> bool;
    fn restore_window(&self, hwnd: Hwnd);
    fn bring_window_to_top(&self, hwnd: Hwnd);
    fn set_foreground_window(&self, hwnd: Hwnd);
}

/// Detaches on drop, so a step that panics still leaves the input queues apart (`finally`).
struct Attached<'a> {
    api: &'a dyn Win32FocusApi,
    me: u32,
    foreground_thread: u32,
}

impl Drop for Attached<'_> {
    fn drop(&mut self) {
        self.api
            .attach_thread_input(self.me, self.foreground_thread, false);
    }
}

/// `bringClaudeToFront`: attach to the foreground thread, restore if minimised, raise, focus,
/// detach; `Focused` only if Claude's window really is the foreground one afterwards.
pub fn bring_claude_to_front(api: &dyn Win32FocusApi) -> BringToFrontResult {
    let Some(target) = api.find_claude_window() else {
        return BringToFrontResult::NotRunning;
    };
    let foreground = api.get_foreground_window();
    let foreground_thread = if foreground == 0 {
        0
    } else {
        api.get_window_thread_id(foreground)
    };
    let me = api.get_current_thread_id();
    let attached = (foreground_thread != 0 && api.attach_thread_input(me, foreground_thread, true))
        .then_some(Attached {
            api,
            me,
            foreground_thread,
        });
    if api.is_iconic(target) {
        api.restore_window(target);
    }
    api.bring_window_to_top(target);
    api.set_foreground_window(target);
    drop(attached);
    if api.same_window(api.get_foreground_window(), target) {
        BringToFrontResult::Focused
    } else {
        BringToFrontResult::Blocked
    }
}

mod win32 {
    use std::panic::{catch_unwind, AssertUnwindSafe};

    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible,
    };

    use super::Hwnd;

    const IMAGE_NAME_CHARS: u32 = 1024;

    /// `path.win32.basename(image).toLowerCase()` of the process that owns `hwnd`; empty when it
    /// cannot be read.
    fn image_basename(hwnd: HWND) -> String {
        let mut pid = 0u32;
        // SAFETY: `pid` is a valid out pointer for the call.
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
        if pid == 0 {
            return String::new();
        }
        // SAFETY: plain call; a null handle is checked below.
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return String::new();
        }
        let mut buffer = [0u16; IMAGE_NAME_CHARS as usize];
        let mut size = IMAGE_NAME_CHARS;
        // SAFETY: `buffer` holds `size` UTF-16 units; `process` is open until CloseHandle.
        let ok =
            unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size) != 0 };
        // SAFETY: closes the handle opened above, once.
        unsafe { CloseHandle(process) };
        if !ok {
            return String::new();
        }
        let path = String::from_utf16_lossy(&buffer[..(size as usize).min(buffer.len())]);
        path.rsplit(['\\', '/'])
            .next()
            .unwrap_or_default()
            .to_lowercase()
    }

    fn is_claude_window(hwnd: HWND) -> bool {
        // SAFETY: plain queries on a window handle EnumWindows handed us.
        let titled = unsafe { IsWindowVisible(hwnd) != 0 && GetWindowTextLengthW(hwnd) > 0 };
        titled && image_basename(hwnd) == "claude.exe"
    }

    unsafe extern "system" fn visit(hwnd: HWND, found: LPARAM) -> BOOL {
        // Never unwind into Windows: a panic counts as "not this window".
        if catch_unwind(AssertUnwindSafe(|| is_claude_window(hwnd))).unwrap_or(false) {
            // SAFETY: `found` points to the `Option<Hwnd>` of `find_claude_window`, alive for the
            // whole enumeration.
            unsafe { *(found as *mut Option<Hwnd>) = Some(hwnd as Hwnd) };
            return 0;
        }
        1
    }

    /// The first matching window in Z order.
    pub fn find_claude_window() -> Option<Hwnd> {
        let mut found: Option<Hwnd> = None;
        // SAFETY: the callback only writes through the pointer to `found`, which outlives the call.
        unsafe { EnumWindows(Some(visit), &mut found as *mut Option<Hwnd> as LPARAM) };
        found
    }
}

fn hwnd(value: Hwnd) -> windows_sys::Win32::Foundation::HWND {
    value as windows_sys::Win32::Foundation::HWND
}

/// The real Win32 calls (`createWin32FocusApi`). Not unit-tested; keep thin.
pub struct RealFocusApi;

impl Win32FocusApi for RealFocusApi {
    fn find_claude_window(&self) -> Option<Hwnd> {
        win32::find_claude_window()
    }

    fn get_foreground_window(&self) -> Hwnd {
        // SAFETY: plain call.
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow() as Hwnd }
    }

    fn same_window(&self, a: Hwnd, b: Hwnd) -> bool {
        a != 0 && b != 0 && a == b
    }

    fn get_window_thread_id(&self, window: Hwnd) -> u32 {
        // SAFETY: a null process-id pointer is allowed.
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId(
                hwnd(window),
                std::ptr::null_mut(),
            )
        }
    }

    fn get_current_thread_id(&self) -> u32 {
        // SAFETY: plain call.
        unsafe { windows_sys::Win32::System::Threading::GetCurrentThreadId() }
    }

    fn attach_thread_input(&self, from: u32, to: u32, attach: bool) -> bool {
        // SAFETY: plain call on thread ids.
        unsafe {
            windows_sys::Win32::System::Threading::AttachThreadInput(from, to, i32::from(attach))
                != 0
        }
    }

    fn is_iconic(&self, window: Hwnd) -> bool {
        // SAFETY: plain call on a window handle.
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::IsIconic(hwnd(window)) != 0 }
    }

    fn restore_window(&self, window: Hwnd) {
        use windows_sys::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_RESTORE};
        // SAFETY: plain call on a window handle.
        unsafe { ShowWindow(hwnd(window), SW_RESTORE) };
    }

    fn bring_window_to_top(&self, window: Hwnd) {
        // SAFETY: plain call on a window handle.
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::BringWindowToTop(hwnd(window)) };
    }

    fn set_foreground_window(&self, window: Hwnd) {
        // SAFETY: plain call on a window handle.
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd(window)) };
    }
}

/// Set while a bring-to-front thread runs; calls meanwhile are ignored.
static FOCUS_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Clears the in-flight flag when the job ends, even if it panicked.
struct InFlight(&'static AtomicBool);

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Runs `job` on its own thread unless one started through `flag` is still running. False when
/// it was skipped (or no thread could be made).
fn spawn_once(flag: &'static AtomicBool, job: impl FnOnce() + Send + 'static) -> bool {
    if flag.swap(true, Ordering::SeqCst) {
        return false;
    }
    let guard = InFlight(flag);
    let spawned = std::thread::Builder::new()
        .name("claude-focus".into())
        .spawn(move || {
            let _guard = guard;
            job();
        });
    // On failure the closure (and the guard in it) was dropped: the flag is clear again.
    spawned.is_ok()
}

/// `focusClaude` of the integration: off with `disabled` (`NOTCH_DISABLE_CLAUDE_FOCUS=1`, dev and
/// E2E builds only); otherwise the real sequence on its own thread, so the caller never waits.
/// A call while the previous one still runs is ignored (one thread at a time).
pub fn focus_claude(disabled: bool) {
    if disabled {
        log::info!("Bring Claude to front disabled");
        return;
    }
    if FOCUS_IN_FLIGHT.load(Ordering::SeqCst) {
        log::info!("Bring Claude to front already running");
        return;
    }
    let started = spawn_once(&FOCUS_IN_FLIGHT, || {
        match catch_unwind(AssertUnwindSafe(|| bring_claude_to_front(&RealFocusApi))) {
            Ok(result) => log::info!("Bring Claude to front {}", result.as_str()),
            Err(_) => log::error!("Bring Claude to front failed"),
        }
    });
    if !started && !FOCUS_IN_FLIGHT.load(Ordering::SeqCst) {
        log::error!("Bring Claude to front failed: no thread");
    }
}

#[cfg(test)]
mod tests {
    use std::cell::{Cell, RefCell};
    use std::panic::{catch_unwind, AssertUnwindSafe};

    use super::*;

    const CLAUDE: Hwnd = 42;
    const OTHER: Hwnd = 7;

    /// `fakeApi()`: every step recorded; `set_foreground_window` really moves the foreground.
    struct Fake {
        calls: RefCell<Vec<&'static str>>,
        foreground: Cell<Hwnd>,
        find: Option<Hwnd>,
        iconic: bool,
        attach_ok: bool,
        set_foreground_works: bool,
        top_panics: bool,
    }

    impl Default for Fake {
        fn default() -> Self {
            Self {
                calls: RefCell::default(),
                foreground: Cell::new(OTHER),
                find: Some(CLAUDE),
                iconic: false,
                attach_ok: true,
                set_foreground_works: true,
                top_panics: false,
            }
        }
    }

    impl Win32FocusApi for Fake {
        fn find_claude_window(&self) -> Option<Hwnd> {
            self.find
        }
        fn get_foreground_window(&self) -> Hwnd {
            self.foreground.get()
        }
        fn same_window(&self, a: Hwnd, b: Hwnd) -> bool {
            a == b
        }
        fn get_window_thread_id(&self, _hwnd: Hwnd) -> u32 {
            7
        }
        fn get_current_thread_id(&self) -> u32 {
            1
        }
        fn attach_thread_input(&self, _from: u32, _to: u32, attach: bool) -> bool {
            if self.attach_ok {
                self.calls
                    .borrow_mut()
                    .push(if attach { "attach" } else { "detach" });
            }
            self.attach_ok
        }
        fn is_iconic(&self, _hwnd: Hwnd) -> bool {
            self.iconic
        }
        fn restore_window(&self, _hwnd: Hwnd) {
            self.calls.borrow_mut().push("restore");
        }
        fn bring_window_to_top(&self, _hwnd: Hwnd) {
            assert!(!self.top_panics, "boom");
            self.calls.borrow_mut().push("top");
        }
        fn set_foreground_window(&self, hwnd: Hwnd) {
            self.calls.borrow_mut().push("setfg");
            if self.set_foreground_works {
                self.foreground.set(hwnd);
            }
        }
    }

    #[test]
    fn returns_not_running_when_there_is_no_claude_exe_window() {
        let api = Fake {
            find: None,
            ..Fake::default()
        };
        assert_eq!(bring_claude_to_front(&api), BringToFrontResult::NotRunning);
        assert!(api.calls.borrow().is_empty());
    }

    #[test]
    fn attaches_raises_focuses_and_detaches_in_order() {
        let api = Fake::default();
        assert_eq!(bring_claude_to_front(&api), BringToFrontResult::Focused);
        assert_eq!(*api.calls.borrow(), ["attach", "top", "setfg", "detach"]);
    }

    #[test]
    fn restores_a_minimized_window_before_raising_it() {
        let api = Fake {
            iconic: true,
            ..Fake::default()
        };
        bring_claude_to_front(&api);
        assert_eq!(
            *api.calls.borrow(),
            ["attach", "restore", "top", "setfg", "detach"]
        );
    }

    #[test]
    fn returns_blocked_when_the_target_does_not_become_foreground() {
        let api = Fake {
            set_foreground_works: false,
            ..Fake::default()
        };
        assert_eq!(bring_claude_to_front(&api), BringToFrontResult::Blocked);
    }

    #[test]
    fn always_detaches_even_when_a_step_throws() {
        let api = Fake {
            top_panics: true,
            ..Fake::default()
        };
        let outcome = catch_unwind(AssertUnwindSafe(|| bring_claude_to_front(&api)));
        assert!(outcome.is_err());
        assert_eq!(*api.calls.borrow(), ["attach", "detach"]);
    }

    #[test]
    fn does_not_detach_when_the_attach_failed() {
        let api = Fake {
            attach_ok: false,
            ..Fake::default()
        };
        bring_claude_to_front(&api);
        assert!(!api.calls.borrow().contains(&"detach"));
    }

    #[test]
    fn ignores_a_call_while_the_previous_one_is_still_running() {
        static FLAG: AtomicBool = AtomicBool::new(false);
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let (ran, runs) = std::sync::mpsc::channel::<u8>();
        let first = ran.clone();
        assert!(spawn_once(&FLAG, move || {
            let _ = wait.recv();
            let _ = first.send(1);
        }));
        let second = ran.clone();
        assert!(!spawn_once(&FLAG, move || {
            let _ = second.send(2);
        }));
        release.send(()).unwrap();
        assert_eq!(runs.recv_timeout(std::time::Duration::from_secs(5)), Ok(1));
        // Once the first job ended (its guard dropped), a new call runs again.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while FLAG.load(Ordering::SeqCst) {
            assert!(std::time::Instant::now() < deadline, "flag never cleared");
            std::thread::yield_now();
        }
        let third = ran;
        assert!(spawn_once(&FLAG, move || {
            let _ = third.send(3);
        }));
        assert_eq!(runs.recv_timeout(std::time::Duration::from_secs(5)), Ok(3));
    }

    #[test]
    fn clears_the_in_flight_flag_when_the_job_panics() {
        static FLAG: AtomicBool = AtomicBool::new(false);
        assert!(spawn_once(&FLAG, || panic!("boom")));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while FLAG.load(Ordering::SeqCst) {
            assert!(std::time::Instant::now() < deadline, "flag never cleared");
            std::thread::yield_now();
        }
    }
}
