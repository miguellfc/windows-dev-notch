//! Resume and unlock notifications, Electron's `powerMonitor` `resume` / `unlock-screen`: a
//! message-only window on its own thread, registered with `WTSRegisterSessionNotification` (for
//! `WTS_SESSION_UNLOCK`) and `RegisterSuspendResumeNotification` (message-only windows get no
//! broadcasts, so `WM_POWERBROADCAST` / `PBT_APMRESUMEAUTOMATIC` must be asked for explicitly).
//! Several modules can listen (the reminders now, Redmine's end-of-day check later).

use std::cell::RefCell;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Power::{
    RegisterSuspendResumeNotification, UnregisterSuspendResumeNotification,
};
use windows_sys::Win32::System::RemoteDesktop::{
    WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW, PostMessageW,
    PostQuitMessage, RegisterClassExW, TranslateMessage, DEVICE_NOTIFY_WINDOW_HANDLE, HWND_MESSAGE,
    MSG, PBT_APMRESUMEAUTOMATIC, WM_CLOSE, WM_DESTROY, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE,
    WNDCLASSEXW, WTS_SESSION_UNLOCK,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PowerEvent {
    /// The PC woke from sleep or hibernation (`PBT_APMRESUMEAUTOMATIC`).
    Resume,
    /// The user unlocked this session (`WTS_SESSION_UNLOCK`).
    Unlock,
}

/// Runs on the power thread: it must return quickly (start async work, never block).
pub type PowerListener = Arc<dyn Fn(PowerEvent) + Send + Sync>;

/// The event a window message carries, if it is one we follow.
pub fn classify(msg: u32, wparam: usize) -> Option<PowerEvent> {
    match (msg, wparam as u32) {
        (WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC) => Some(PowerEvent::Resume),
        (WM_WTSSESSION_CHANGE, WTS_SESSION_UNLOCK) => Some(PowerEvent::Unlock),
        _ => None,
    }
}

struct Shared {
    listeners: Mutex<Vec<PowerListener>>,
    /// The window once created, 0 before and after.
    hwnd: AtomicIsize,
    stopped: AtomicBool,
}

impl Shared {
    fn dispatch(&self, event: PowerEvent) {
        let listeners = self
            .listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        for listener in listeners {
            // Never unwind into the window procedure (that would abort the process).
            if catch_unwind(AssertUnwindSafe(|| listener(event))).is_err() {
                log::error!("A power event listener failed ({event:?})");
            }
        }
    }
}

thread_local! {
    /// The [`Shared`] of the power thread running this window procedure.
    static CURRENT: RefCell<Option<Arc<Shared>>> = const { RefCell::new(None) };
}

/// The power/session event source; stop it with [`stop`](Self::stop) at quit.
pub struct PowerEvents {
    shared: Arc<Shared>,
}

impl PowerEvents {
    /// Starts the power thread with `on_event` as its first listener. Never blocks: the
    /// window is created on that thread.
    pub fn start(on_event: PowerListener) -> Arc<Self> {
        let shared = Arc::new(Shared {
            listeners: Mutex::new(vec![on_event]),
            hwnd: AtomicIsize::new(0),
            stopped: AtomicBool::new(false),
        });
        let thread_shared = Arc::clone(&shared);
        let spawned = std::thread::Builder::new()
            .name("power-events".into())
            .spawn(move || run(thread_shared));
        if spawned.is_err() {
            log::error!("Power events: could not start the thread");
        }
        Arc::new(Self { shared })
    }

    /// Adds a listener (e.g. Redmine's end-of-day check).
    pub fn subscribe(&self, listener: PowerListener) {
        self.shared
            .listeners
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(listener);
    }

    /// Closes the window (which unregisters both notifications) and ends the thread. Only posts
    /// a message, so it is safe on the main thread; idempotent.
    pub fn stop(&self) {
        self.shared.stopped.store(true, Ordering::SeqCst);
        let hwnd = self.shared.hwnd.load(Ordering::SeqCst);
        if hwnd != 0 {
            // SAFETY: posting to a window that is already gone just fails.
            unsafe { PostMessageW(hwnd as HWND, WM_CLOSE, 0, 0) };
        }
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if let Some(event) = classify(msg, wparam) {
        let shared = CURRENT.with(|current| current.borrow().clone());
        if let Some(shared) = shared {
            shared.dispatch(event);
        }
    }
    match msg {
        // TRUE: the broadcast is acknowledged.
        WM_POWERBROADCAST => 1,
        WM_CLOSE => {
            // SAFETY: our own window, on its own thread.
            unsafe { DestroyWindow(hwnd) };
            0
        }
        WM_DESTROY => {
            CURRENT.with(|current| {
                if let Some(shared) = current.borrow().as_ref() {
                    shared.hwnd.store(0, Ordering::SeqCst);
                }
            });
            // SAFETY: undoes the registration made in `run`; harmless if it had failed.
            unsafe {
                WTSUnRegisterSessionNotification(hwnd);
                PostQuitMessage(0);
            }
            0
        }
        // SAFETY: default handling with the arguments we were given.
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// The power thread: window, registrations, message loop until [`PowerEvents::stop`].
fn run(shared: Arc<Shared>) {
    CURRENT.with(|current| *current.borrow_mut() = Some(Arc::clone(&shared)));
    let class_name = wide("DeveloperNotchPowerEvents");
    // SAFETY: plain Win32 calls with valid, NUL-terminated strings that outlive them; every
    // handle is checked before use and released on this thread.
    unsafe {
        let instance = GetModuleHandleW(std::ptr::null());
        let class = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(window_proc),
            hInstance: instance,
            lpszClassName: class_name.as_ptr(),
            ..std::mem::zeroed()
        };
        // A second registration (another instance in tests) fails harmlessly: the class exists.
        RegisterClassExW(&class);
        let hwnd = CreateWindowExW(
            0,
            class_name.as_ptr(),
            std::ptr::null(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            log::error!("Power events: could not create the window");
            return;
        }
        if WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) == 0 {
            log::warn!("Power events: unlock notifications unavailable");
        }
        let power = RegisterSuspendResumeNotification(hwnd, DEVICE_NOTIFY_WINDOW_HANDLE);
        if power == 0 {
            log::warn!("Power events: resume notifications unavailable");
        }
        shared.hwnd.store(hwnd as isize, Ordering::SeqCst);
        // `stop` may have run before the window existed: close it now.
        if shared.stopped.load(Ordering::SeqCst) {
            PostMessageW(hwnd, WM_CLOSE, 0, 0);
        }
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
        if power != 0 {
            UnregisterSuspendResumeNotification(power);
        }
    }
    CURRENT.with(|current| *current.borrow_mut() = None);
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    use super::*;

    #[test]
    fn classifies_resume_and_unlock_only() {
        // WM_POWERBROADCAST + PBT_APMRESUMEAUTOMATIC.
        assert_eq!(classify(0x218, 0x12), Some(PowerEvent::Resume));
        // WM_WTSSESSION_CHANGE + WTS_SESSION_UNLOCK.
        assert_eq!(classify(0x2B1, 0x8), Some(PowerEvent::Unlock));
        // Suspend, resume-suspend, power status, lock, logon... are ignored.
        for (msg, wparam) in [
            (0x218, 0x4),
            (0x218, 0x7),
            (0x218, 0xA),
            (0x2B1, 0x7),
            (0x2B1, 0x5),
            (0x10, 0x12),
            (0x10, 0x8),
        ] {
            assert_eq!(classify(msg, wparam), None, "{msg:#x} {wparam:#x}");
        }
    }

    fn wait_for(what: &str, done: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn every_listener_hears_a_resume_and_stop_closes_the_window() {
        let (sender, receiver) = mpsc::channel();
        let first = sender.clone();
        let events = PowerEvents::start(Arc::new(move |event| first.send(("a", event)).unwrap()));
        events.subscribe(Arc::new(|_| panic!("a failing listener")));
        events.subscribe(Arc::new(move |event| sender.send(("b", event)).unwrap()));
        wait_for("the window", || {
            events.shared.hwnd.load(Ordering::SeqCst) != 0
        });
        let hwnd = events.shared.hwnd.load(Ordering::SeqCst) as HWND;
        // SAFETY: posting to our own live window.
        unsafe {
            PostMessageW(hwnd, WM_POWERBROADCAST, PBT_APMRESUMEAUTOMATIC as usize, 0);
            PostMessageW(hwnd, WM_WTSSESSION_CHANGE, WTS_SESSION_UNLOCK as usize, 0);
        }
        let mut heard: Vec<_> = (0..4)
            .map(|_| receiver.recv_timeout(Duration::from_secs(5)).unwrap())
            .collect();
        heard.sort_by_key(|(who, event)| (*who, *event == PowerEvent::Unlock));
        assert_eq!(
            heard,
            [
                ("a", PowerEvent::Resume),
                ("a", PowerEvent::Unlock),
                ("b", PowerEvent::Resume),
                ("b", PowerEvent::Unlock),
            ]
        );
        events.stop();
        wait_for("the window to close", || {
            events.shared.hwnd.load(Ordering::SeqCst) == 0
        });
        events.stop();
    }

    #[test]
    fn stop_before_the_window_exists_still_closes_it() {
        let events = PowerEvents::start(Arc::new(|_| {}));
        events.stop();
        // Either it never got stored or the window closed itself right away.
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(events.shared.hwnd.load(Ordering::SeqCst), 0);
    }
}
