//! Ordered quit (0.1.0's `quit-flush.ts` and the `will-quit` block of
//! 0.1.0's `index.ts`): the first exit request is prevented, the registered flushers run (in
//! parallel, at most [`QUIT_FLUSH_MS`]), the registered cleanups run in order, and the app exits
//! again with the same code.

use std::future::Future;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Manager};

use crate::notch::runtime::NotchRuntime;
use crate::platform::shortcut::{ShortcutControl, ShortcutService};
use crate::platform::tray;
use crate::services::usage::UsageLog;

/// `USAGE_QUIT_FLUSH_MS`: upper bound on the quit flush, so quitting never hangs on the disk.
pub const QUIT_FLUSH_MS: u64 = 2_000;
/// Upper bound on the worker cleanup: past it the app exits anyway, so quitting never hangs.
pub const QUIT_CLEANUP_MS: u64 = 2_000;

pub type FlushFuture = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Where the cleanup runs: the main thread must never wait on a lock a worker may hold while that
/// worker waits on the main thread.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CleanupThread {
    /// The event loop's thread (a second exit request while the flush is pending).
    Main,
    /// A blocking-pool thread after the flush; the main thread keeps running meanwhile.
    Worker,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitDecision {
    /// Call `api.prevent_exit()`: the flush is running and will ask to exit again.
    Prevent,
    /// Let the exit go ahead.
    Proceed,
}

pub struct QuitHooks {
    /// Run once when the first exit request starts the flush (e.g. stop periodic writers).
    pub on_flush_start: Box<dyn Fn() + Send + Sync>,
    /// Saves pending state; may settle immediately when there is nothing to write.
    pub flush: Box<dyn Fn() -> FlushFuture + Send + Sync>,
    /// Final cleanup, run once.
    pub cleanup: Box<dyn Fn(CleanupThread) + Send + Sync>,
    /// Asks the app to exit again with the given code (`app.exit`).
    pub quit: Box<dyn Fn(i32) + Send + Sync>,
}

/// Port of `createQuitFlush`, adapted to Tauri: the first exit request is prevented and a task
/// flushes (bounded by the timeout), runs the cleanup on a blocking-pool thread and calls
/// `quit(code)`; that second request goes through. A request that arrives while the flush is
/// still pending runs the cleanup on the main thread and exits without waiting for the flush.
/// The cleanup runs at most once.
pub struct QuitFlush {
    hooks: QuitHooks,
    timeout: Duration,
    cleanup_timeout: Duration,
    started: AtomicBool,
    cleaned: AtomicBool,
}

impl QuitFlush {
    pub fn new(hooks: QuitHooks, timeout: Duration) -> Arc<Self> {
        Self::with_cleanup_timeout(hooks, timeout, Duration::from_millis(QUIT_CLEANUP_MS))
    }

    pub fn with_cleanup_timeout(
        hooks: QuitHooks,
        timeout: Duration,
        cleanup_timeout: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            hooks,
            timeout,
            cleanup_timeout,
            started: AtomicBool::new(false),
            cleaned: AtomicBool::new(false),
        })
    }

    fn cleanup_once(&self, thread: CleanupThread) {
        if !self.cleaned.swap(true, Ordering::SeqCst) {
            (self.hooks.cleanup)(thread);
        }
    }

    /// Handles `RunEvent::ExitRequested` with a code (on the main thread; never blocks on the
    /// flush or the disk).
    pub fn on_exit_requested(self: &Arc<Self>, code: i32) -> ExitDecision {
        if self.started.swap(true, Ordering::SeqCst) {
            self.cleanup_once(CleanupThread::Main);
            return ExitDecision::Proceed;
        }
        (self.hooks.on_flush_start)();
        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            // The flush runs as its own task: a panic (in the closure or the future) or a
            // timeout must still quit.
            let flusher = Arc::clone(&this);
            let flush = tauri::async_runtime::spawn(async move { (flusher.hooks.flush)().await });
            match tokio::time::timeout(this.timeout, flush).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => log::error!("The quit flush failed"),
                Err(_) => log::warn!("The quit flush timed out"),
            }
            let cleaner = Arc::clone(&this);
            let cleanup = tauri::async_runtime::spawn_blocking(move || {
                cleaner.cleanup_once(CleanupThread::Worker);
            });
            match tokio::time::timeout(this.cleanup_timeout, cleanup).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => log::error!("The quit cleanup panicked"),
                // The cleanup thread is left behind; the process is about to end anyway.
                Err(_) => log::warn!("The quit cleanup timed out; exiting anyway"),
            }
            (this.hooks.quit)(code);
        });
        ExitDecision::Prevent
    }
}

/// Saves one module's pending state at quit (e.g. wait for in-flight writes).
pub type Flusher = Box<dyn Fn() -> FlushFuture + Send + Sync>;
/// Stops one module at quit; told which thread it runs on (see [`CleanupThread`]).
pub type Cleanup = Box<dyn Fn(CleanupThread) + Send + Sync>;

/// What each module registers for the quit (`Promise.all([usage.flush(), notes.flush()])` and
/// the `will-quit` cleanup list of 0.1.0's `index.ts`). Managed as `Arc<QuitTasks>` by
/// [`install`]: the usage flush and the notch cleanup come first; modules add theirs after.
#[derive(Default)]
pub struct QuitTasks {
    flushers: Mutex<Vec<Arc<Flusher>>>,
    cleanups: Mutex<Vec<Arc<Cleanup>>>,
}

impl QuitTasks {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Runs in parallel with the other flushers; all of them share the [`QUIT_FLUSH_MS`] cap.
    pub fn add_flusher(&self, f: impl Fn() -> FlushFuture + Send + Sync + 'static) {
        lock(&self.flushers).push(Arc::new(Box::new(f)));
    }

    /// Runs once, after the cleanups registered before it. On [`CleanupThread::Main`] it must
    /// never wait on a lock a worker may hold nor on a main-thread round trip.
    pub fn add_cleanup(&self, f: impl Fn(CleanupThread) + Send + Sync + 'static) {
        lock(&self.cleanups).push(Arc::new(Box::new(f)));
    }

    /// Every flusher, each as its own task (a panic or a hang in one never stops the others);
    /// settles when all have. The caller bounds the wait.
    fn flush_all(&self) -> FlushFuture {
        let flushers = lock(&self.flushers).clone();
        let tasks: Vec<_> = flushers
            .into_iter()
            .map(|flusher| tauri::async_runtime::spawn(async move { (flusher)().await }))
            .collect();
        Box::pin(async move {
            for task in tasks {
                if task.await.is_err() {
                    log::error!("A quit flusher failed");
                }
            }
        })
    }

    /// Every cleanup in registration order; a panicking one is logged and the rest still run.
    fn cleanup_all(&self, thread: CleanupThread) {
        let cleanups = lock(&self.cleanups).clone();
        for cleanup in cleanups {
            if catch_unwind(AssertUnwindSafe(|| cleanup(thread))).is_err() {
                log::error!("A quit cleanup panicked");
            }
        }
        log::info!("Developer Notch stopped");
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The [`QuitHooks`] that flush and clean up through `tasks`.
pub fn tasks_hooks(
    tasks: Arc<QuitTasks>,
    on_flush_start: Box<dyn Fn() + Send + Sync>,
    quit: Box<dyn Fn(i32) + Send + Sync>,
) -> QuitHooks {
    let flush_tasks = Arc::clone(&tasks);
    QuitHooks {
        on_flush_start,
        flush: Box::new(move || flush_tasks.flush_all()),
        cleanup: Box::new(move |thread| tasks.cleanup_all(thread)),
        quit,
    }
}

/// Wires the ordered quit of the app (the `will-quit` block of 0.1.0's `index.ts`): stop the
/// usage ticker, run every registered flusher (the usage log first), then every registered
/// cleanup (the notch one first) and the exit. Manages the [`QuitTasks`] so modules installed
/// later can add theirs (`app.state::<Arc<QuitTasks>>()`).
///
/// Threads: the flush runs on the async runtime and the cleanup on a blocking-pool thread while
/// the main thread keeps pumping events, so the shortcut's `dispose` (which waits on its `turn`
/// lock and then on a main-thread round trip) and the tray removal posted to the main thread can
/// both complete. Only a second exit request during the flush cleans up on the main thread, and
/// that path never waits on a lock a worker may hold (`try_dispose`) and removes the tray inline.
pub fn install(app: &AppHandle, usage: UsageLog, ticker: JoinHandle<()>) -> Arc<QuitFlush> {
    let ticker = Mutex::new(Some(ticker));
    let tasks = QuitTasks::new();
    tasks.add_flusher(move || {
        let usage = usage.clone();
        Box::pin(async move { usage.flush().await })
    });
    let cleanup_app = app.clone();
    tasks.add_cleanup(move |thread| cleanup(&cleanup_app, thread));
    app.manage(Arc::clone(&tasks));
    let quit_app = app.clone();
    QuitFlush::new(
        tasks_hooks(
            tasks,
            Box::new(move || {
                let ticker = lock(&ticker).take();
                if let Some(ticker) = ticker {
                    ticker.abort();
                }
            }),
            Box::new(move |code| quit_app.exit(code)),
        ),
        Duration::from_millis(QUIT_FLUSH_MS),
    )
}

/// The first cleanup: foreground watcher, pollers, controller, shortcut and tray, in the Electron
/// order.
fn cleanup(app: &AppHandle, thread: CleanupThread) {
    if let Some(notch) = app.try_state::<Arc<NotchRuntime>>() {
        notch.stop_foreground_watch();
        notch.stop_pollers();
        notch.controller.dispose();
    }
    if let Some(shortcut) = app.try_state::<Arc<ShortcutService>>() {
        match thread {
            CleanupThread::Worker => shortcut.dispose(),
            CleanupThread::Main => {
                if !shortcut.try_dispose() {
                    log::warn!("Shortcut change in flight at exit; left to the OS");
                }
            }
        }
    }
    tray::remove(app, thread == CleanupThread::Main);
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::{OnceLock, Weak};
    use std::time::Instant;

    use super::*;

    /// Mimics Tauri: `exit(code)` raises `ExitRequested`; the app exits unless it is prevented.
    #[derive(Default)]
    struct FakeApp {
        quit: OnceLock<Arc<QuitFlush>>,
        exited: AtomicBool,
        exit_code: Mutex<Option<i32>>,
    }

    impl FakeApp {
        fn exit(&self, code: i32) {
            if self.exited.load(Ordering::SeqCst) {
                return;
            }
            let quit = self.quit.get().expect("wired");
            if quit.on_exit_requested(code) == ExitDecision::Proceed {
                *self.exit_code.lock().unwrap() = Some(code);
                self.exited.store(true, Ordering::SeqCst);
            }
        }

        fn exited(&self) -> bool {
            self.exited.load(Ordering::SeqCst)
        }
    }

    #[derive(Default)]
    struct Calls {
        cleanups: Mutex<Vec<CleanupThread>>,
        order: Mutex<Vec<&'static str>>,
        starts: AtomicUsize,
        quits: AtomicUsize,
    }

    impl Calls {
        fn cleanups(&self) -> usize {
            self.cleanups.lock().unwrap().len()
        }
    }

    fn wire(
        flush: impl Fn() -> FlushFuture + Send + Sync + 'static,
        timeout_ms: u64,
    ) -> (Arc<FakeApp>, Arc<Calls>) {
        wire_with(flush, timeout_ms, || {}, QUIT_CLEANUP_MS)
    }

    /// `extra_cleanup` runs inside the cleanup hook, after it was recorded.
    fn wire_with(
        flush: impl Fn() -> FlushFuture + Send + Sync + 'static,
        timeout_ms: u64,
        extra_cleanup: impl Fn() + Send + Sync + 'static,
        cleanup_timeout_ms: u64,
    ) -> (Arc<FakeApp>, Arc<Calls>) {
        let app = Arc::new(FakeApp::default());
        let calls = Arc::new(Calls::default());
        let weak: Weak<FakeApp> = Arc::downgrade(&app);
        let (start_calls, cleanup_calls) = (Arc::clone(&calls), Arc::clone(&calls));
        let (flush_calls, quit_calls) = (Arc::clone(&calls), Arc::clone(&calls));
        let hooks = QuitHooks {
            on_flush_start: Box::new(move || {
                start_calls.starts.fetch_add(1, Ordering::SeqCst);
                start_calls.order.lock().unwrap().push("start");
            }),
            flush: Box::new(move || {
                flush_calls.order.lock().unwrap().push("flush");
                flush()
            }),
            cleanup: Box::new(move |thread| {
                cleanup_calls.cleanups.lock().unwrap().push(thread);
                cleanup_calls.order.lock().unwrap().push("cleanup");
                extra_cleanup();
            }),
            quit: Box::new(move |code| {
                quit_calls.quits.fetch_add(1, Ordering::SeqCst);
                if let Some(app) = weak.upgrade() {
                    app.exit(code);
                }
            }),
        };
        let quit = QuitFlush::with_cleanup_timeout(
            hooks,
            Duration::from_millis(timeout_ms),
            Duration::from_millis(cleanup_timeout_ms),
        );
        assert!(app.quit.set(quit).is_ok());
        (app, calls)
    }

    fn settle(ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }

    fn wait_until(what: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !what() {
            assert!(Instant::now() < deadline, "timed out");
            settle(2);
        }
    }

    fn after(ms: u64) -> FlushFuture {
        Box::pin(tokio::time::sleep(Duration::from_millis(ms)))
    }

    #[test]
    fn quits_after_a_flush_that_settles_immediately() {
        let (app, calls) = wire(|| Box::pin(async {}), 2_000);
        app.exit(0);
        wait_until(|| app.exited());
        assert_eq!(*calls.cleanups.lock().unwrap(), [CleanupThread::Worker]);
        assert_eq!(*app.exit_code.lock().unwrap(), Some(0));
    }

    #[test]
    fn quits_after_a_flush_that_takes_a_while() {
        let (app, calls) = wire(|| after(50), 2_000);
        app.exit(0);
        assert!(!app.exited());
        assert_eq!(calls.cleanups(), 0);
        wait_until(|| app.exited());
        assert_eq!(calls.cleanups(), 1);
    }

    #[test]
    fn quits_after_the_timeout_when_the_flush_never_settles() {
        let (app, calls) = wire(|| Box::pin(std::future::pending()), 10);
        let started = Instant::now();
        app.exit(0);
        wait_until(|| app.exited());
        assert!(started.elapsed() >= Duration::from_millis(10));
        assert_eq!(calls.cleanups(), 1);
    }

    #[test]
    fn still_quits_when_the_flush_panics_synchronously() {
        let (app, calls) = wire(|| panic!("disk on fire"), 2_000);
        app.exit(0);
        wait_until(|| app.exited());
        assert_eq!(calls.cleanups(), 1);
    }

    #[test]
    fn still_quits_when_the_flush_future_panics() {
        let (app, calls) = wire(|| Box::pin(async { panic!("EACCES") }), 2_000);
        app.exit(0);
        wait_until(|| app.exited());
        assert_eq!(calls.cleanups(), 1);
    }

    #[test]
    fn exits_with_a_single_cleanup_when_exit_is_requested_again_while_the_flush_is_pending() {
        // The flush waits until the test releases it.
        let (release, gate) = tokio::sync::oneshot::channel::<()>();
        let gate = Mutex::new(Some(gate));
        let (app, calls) = wire(
            move || {
                let gate = gate.lock().unwrap().take();
                Box::pin(async move {
                    if let Some(gate) = gate {
                        let _ = gate.await;
                    }
                })
            },
            2_000,
        );
        app.exit(0);
        wait_until(|| calls.order.lock().unwrap().contains(&"flush"));
        assert_eq!(calls.cleanups(), 0);
        assert!(!app.exited());
        app.exit(0);
        // The second request runs the cleanup on the main thread and exits at once.
        assert!(app.exited());
        assert_eq!(*calls.cleanups.lock().unwrap(), [CleanupThread::Main]);
        // Once the flush ends, the task asks to exit again without a second cleanup.
        release.send(()).unwrap();
        wait_until(|| calls.quits.load(Ordering::SeqCst) == 1);
        assert_eq!(calls.cleanups(), 1);
    }

    #[test]
    fn exits_anyway_when_the_worker_cleanup_hangs() {
        let (unblock, blocked) = std::sync::mpsc::channel::<()>();
        let blocked = Mutex::new(blocked);
        let (app, calls) = wire_with(
            || Box::pin(async {}),
            2_000,
            move || {
                let _ = blocked.lock().unwrap().recv();
            },
            20,
        );
        app.exit(0);
        wait_until(|| app.exited());
        assert_eq!(*calls.cleanups.lock().unwrap(), [CleanupThread::Worker]);
        // Let the stuck cleanup thread finish.
        unblock.send(()).unwrap();
    }

    #[test]
    fn runs_on_flush_start_once_before_the_flush_then_cleans_up() {
        let (app, calls) = wire(|| Box::pin(async {}), 2_000);
        app.exit(0);
        wait_until(|| app.exited());
        // A later request (the app is already exiting) changes nothing.
        let quit = app.quit.get().unwrap();
        assert_eq!(quit.on_exit_requested(0), ExitDecision::Proceed);
        assert_eq!(calls.starts.load(Ordering::SeqCst), 1);
        assert_eq!(*calls.order.lock().unwrap(), ["start", "flush", "cleanup"]);
    }

    /// A [`QuitFlush`] over registered tasks, like `install` builds, on a [`FakeApp`].
    fn wire_tasks(tasks: &Arc<QuitTasks>, timeout_ms: u64) -> Arc<FakeApp> {
        let app = Arc::new(FakeApp::default());
        let weak: Weak<FakeApp> = Arc::downgrade(&app);
        let hooks = tasks_hooks(
            Arc::clone(tasks),
            Box::new(|| {}),
            Box::new(move |code| {
                if let Some(app) = weak.upgrade() {
                    app.exit(code);
                }
            }),
        );
        let quit = QuitFlush::new(hooks, Duration::from_millis(timeout_ms));
        assert!(app.quit.set(quit).is_ok());
        app
    }

    #[test]
    fn quit_flushes_all_registered_flushers_within_cap() {
        let tasks = QuitTasks::new();
        let done = Arc::new(Mutex::new(Vec::new()));
        for (name, ms) in [("usage", 150u64), ("notes", 150)] {
            let done = Arc::clone(&done);
            tasks.add_flusher(move || {
                let done = Arc::clone(&done);
                Box::pin(async move {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    done.lock().unwrap().push(name);
                })
            });
        }
        // One that never settles and one that panics: neither holds up the others or the exit.
        tasks.add_flusher(|| Box::pin(std::future::pending()));
        tasks.add_flusher(|| Box::pin(async { panic!("disk on fire") }));
        // In parallel: two 150 ms flushes fit in a 250 ms cap only if they overlap.
        let app = wire_tasks(&tasks, 250);
        let started = Instant::now();
        app.exit(0);
        wait_until(|| app.exited());
        let elapsed = started.elapsed();
        let mut done = done.lock().unwrap().clone();
        done.sort_unstable();
        assert_eq!(done, ["notes", "usage"]);
        // The cap bounds the wait on the pending one.
        assert!(elapsed >= Duration::from_millis(250), "{elapsed:?}");
        assert!(elapsed < Duration::from_millis(2_000), "{elapsed:?}");
    }

    #[test]
    fn cleanups_run_in_registration_order() {
        let tasks = QuitTasks::new();
        let order = Arc::new(Mutex::new(Vec::new()));
        for name in ["notch", "reminders", "system"] {
            let order = Arc::clone(&order);
            tasks.add_cleanup(move |thread| order.lock().unwrap().push((name, thread)));
        }
        // A panicking cleanup is logged; the later ones still run.
        tasks.add_cleanup(|_| panic!("boom"));
        {
            let order = Arc::clone(&order);
            tasks.add_cleanup(move |thread| order.lock().unwrap().push(("last", thread)));
        }
        let app = wire_tasks(&tasks, 2_000);
        app.exit(0);
        wait_until(|| app.exited());
        // A later request changes nothing: the cleanups ran once.
        assert_eq!(
            app.quit.get().unwrap().on_exit_requested(0),
            ExitDecision::Proceed
        );
        let worker = CleanupThread::Worker;
        assert_eq!(
            *order.lock().unwrap(),
            [
                ("notch", worker),
                ("reminders", worker),
                ("system", worker),
                ("last", worker)
            ]
        );
    }

    #[test]
    fn keeps_the_exit_code() {
        let (app, _calls) = wire(|| Box::pin(async {}), 2_000);
        app.exit(3);
        wait_until(|| app.exited());
        assert_eq!(*app.exit_code.lock().unwrap(), Some(3));
    }
}
