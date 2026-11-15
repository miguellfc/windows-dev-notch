//! Opens Claude Desktop and Windows Terminal from the notch tiles (`src/main/apps/app-launcher.ts`).
//!
//! Claude: the `claude://` link, else the web app. Terminal: Windows Terminal running PowerShell
//! 7 (or 5) in the user folder, else PowerShell alone. Only absolute executables are launched
//! (never a bare name a relative PATH entry or the cwd could satisfy), with the app's own
//! `NOTCH_*` / `ELECTRON_*` variables removed. A second click on the same tile within a second
//! is ignored.

use std::collections::HashMap;
use std::ffi::OsString;
use std::sync::{Arc, Mutex, PoisonError};

use crate::contract::apps::AppId;
use crate::ipc::BoxFuture;

pub const CLAUDE_URL: &str = "claude://claude.ai/new";
pub const CLAUDE_WEB_URL: &str = "https://claude.ai/new";
/// A second open of the same app within this window is a double click: ignored.
pub const DOUBLE_CLICK_MS: u64 = 1000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LaunchResult {
    Desktop,
    Browser,
    Wt,
    Pwsh,
    Powershell,
    Failed,
    Ignored,
}

impl LaunchResult {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Browser => "browser",
            Self::Wt => "wt",
            Self::Pwsh => "pwsh",
            Self::Powershell => "powershell",
            Self::Failed => "failed",
            Self::Ignored => "ignored",
        }
    }
}

/// Environment variables in their original order (`process.env`).
pub type Env = Vec<(OsString, OsString)>;

/// `CREATE_NEW_CONSOLE`: a console shell (the pwsh / powershell fallbacks) opens in a new visible
/// console whose own input keeps it open. Windows ignores the flag for a GUI program such as
/// `wt.exe`. Not `CREATE_NEW_PROCESS_GROUP`: it disables Ctrl+C in that console and adds nothing
/// once the shell has a console of its own. (Not `DETACHED_PROCESS` either: a detached console
/// program gets no console at all.)
pub const TERMINAL_CREATION_FLAGS: u32 = 0x0000_0010;

/// One process to start in `cwd` with exactly `env` and the given `CreateProcessW` flags.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpawnRequest {
    pub file: String,
    pub args: Vec<String>,
    pub cwd: String,
    pub env: Env,
    pub creation_flags: u32,
}

/// What the launcher needs from the system (`AppLauncherDeps`).
pub struct LauncherDeps {
    /// Opens a URL with its registered handler; true when it opened.
    pub open_external: Arc<dyn Fn(String) -> BoxFuture<'static, bool> + Send + Sync>,
    /// Starts a process; true once it started, false when it could not.
    pub try_spawn: Arc<dyn Fn(SpawnRequest) -> BoxFuture<'static, bool> + Send + Sync>,
    /// Whether something exists at the absolute path (`lstat`: WindowsApps aliases are reparse
    /// points that a plain existence check reports missing).
    pub exists: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    pub home_dir: String,
    pub env: Env,
    /// Milliseconds on any monotonic scale.
    pub now: Arc<dyn Fn() -> u64 + Send + Sync>,
}

pub struct AppLauncher {
    deps: Arc<LauncherDeps>,
    last_attempt: Mutex<HashMap<AppId, u64>>,
}

/// `cleanEnv`: a copy without the keys starting with `NOTCH_` or `ELECTRON_`.
pub fn clean_env(env: &Env) -> Env {
    env.iter()
        .filter(|(key, _)| {
            let key = key.to_string_lossy();
            !key.starts_with("NOTCH_") && !key.starts_with("ELECTRON_")
        })
        .cloned()
        .collect()
}

/// `^[a-z]:\\` (case-insensitive): an absolute drive path.
fn is_drive_path(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\'
}

/// The value of `name`, whose key is looked up case-insensitively (the first match wins).
fn env_value(env: &Env, name: &str) -> Option<String> {
    env.iter()
        .find(|(key, _)| key.to_string_lossy().eq_ignore_ascii_case(name))
        .map(|(_, value)| value.to_string_lossy().into_owned())
}

/// `path.win32.join` for a drive-absolute first part: joined with `\`, slashes turned into
/// backslashes, empty and `.` segments dropped and `..` resolved (never above the drive root).
pub fn win32_join(parts: &[&str]) -> String {
    let joined = parts.join("\\").replace('/', "\\");
    let (root, rest) = joined.split_at(joined.len().min(2));
    let mut segments: Vec<&str> = Vec::new();
    for segment in rest.split('\\') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            segment => segments.push(segment),
        }
    }
    format!("{root}\\{}", segments.join("\\"))
}

/// `resolveExecutable`: the first existing `<PATH entry>\<exe>` (absolute entries only, in
/// order), then `%LOCALAPPDATA%\Microsoft\WindowsApps\<exe>`. Only absolute drive locations
/// count, so a relative PATH entry (or the child's cwd) can never win the lookup.
pub fn resolve_executable(exe: &str, env: &Env, exists: &dyn Fn(&str) -> bool) -> Option<String> {
    let path = env_value(env, "PATH").unwrap_or_default();
    let mut candidates: Vec<String> = path
        .split(';')
        .map(str::trim)
        .filter(|dir| is_drive_path(dir))
        .map(|dir| win32_join(&[dir, exe]))
        .collect();
    if let Some(local) = env_value(env, "LOCALAPPDATA").filter(|dir| is_drive_path(dir)) {
        candidates.push(win32_join(&[&local, "Microsoft", "WindowsApps", exe]));
    }
    candidates.into_iter().find(|candidate| exists(candidate))
}

/// `<SystemRoot>\System32\WindowsPowerShell1.0\powershell.exe`, when `SystemRoot` is absolute.
fn windows_powershell(env: &Env) -> Option<String> {
    let root = env_value(env, "SystemRoot").filter(|root| is_drive_path(root))?;
    Some(win32_join(&[
        &root,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    ]))
}

async fn open_claude(deps: &LauncherDeps) -> LaunchResult {
    if (deps.open_external)(CLAUDE_URL.to_owned()).await {
        LaunchResult::Desktop
    } else if (deps.open_external)(CLAUDE_WEB_URL.to_owned()).await {
        LaunchResult::Browser
    } else {
        LaunchResult::Failed
    }
}

async fn open_terminal(deps: &LauncherDeps) -> LaunchResult {
    let env = clean_env(&deps.env);
    let exists = |path: &str| (deps.exists)(path);
    let wt = resolve_executable("wt.exe", &deps.env, &exists);
    let pwsh = resolve_executable("pwsh.exe", &deps.env, &exists);
    let ps5 = windows_powershell(&deps.env);
    let shell = pwsh.clone().or_else(|| ps5.clone());
    let home = deps.home_dir.clone();
    let mut attempts: Vec<(String, Vec<String>, LaunchResult)> = Vec::new();
    if let (Some(wt), Some(shell)) = (wt, shell) {
        let args = ["-w", "new", "-d", &home, &shell, "-NoLogo"];
        attempts.push((wt, args.map(str::to_owned).to_vec(), LaunchResult::Wt));
    }
    if let Some(pwsh) = pwsh {
        attempts.push((pwsh, vec!["-NoLogo".into()], LaunchResult::Pwsh));
    }
    if let Some(ps5) = ps5 {
        attempts.push((ps5, vec!["-NoLogo".into()], LaunchResult::Powershell));
    }
    for (file, args, result) in attempts {
        let request = SpawnRequest {
            file,
            args,
            cwd: home.clone(),
            env: env.clone(),
            creation_flags: TERMINAL_CREATION_FLAGS,
        };
        if (deps.try_spawn)(request).await {
            return result;
        }
    }
    LaunchResult::Failed
}

impl AppLauncher {
    pub fn new(deps: LauncherDeps) -> Self {
        Self {
            deps: Arc::new(deps),
            last_attempt: Mutex::new(HashMap::new()),
        }
    }

    /// Opens `app`. The double-click check and the attempt time are recorded right away (before
    /// the returned future runs), so a click while the first launch is still pending is ignored.
    /// A failed attempt counts as recent too.
    pub fn open(&self, app: AppId) -> BoxFuture<'static, LaunchResult> {
        let now = (self.deps.now)();
        {
            let mut last_attempt = self
                .last_attempt
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if let Some(&last) = last_attempt.get(&app) {
                if now.saturating_sub(last) < DOUBLE_CLICK_MS {
                    return Box::pin(async { LaunchResult::Ignored });
                }
            }
            last_attempt.insert(app, now);
        }
        let deps = Arc::clone(&self.deps);
        Box::pin(async move {
            match app {
                AppId::Claude => open_claude(&deps).await,
                AppId::Terminal => open_terminal(&deps).await,
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{HashSet, VecDeque};
    use std::sync::atomic::{AtomicU64, Ordering};

    use tauri::async_runtime::block_on;
    use tokio::sync::oneshot;

    use super::*;

    const HOME: &str = "C:\\Users\\Ana María";
    const WT: &str = "C:\\Tools\\wt.exe";
    const PWSH: &str = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    const PS5: &str = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

    fn env(pairs: &[(&str, &str)]) -> Env {
        pairs
            .iter()
            .map(|(key, value)| (OsString::from(key), OsString::from(value)))
            .collect()
    }

    fn full_env() -> Env {
        env(&[
            ("PATH", "C:\\Tools;C:\\Program Files\\PowerShell\\7"),
            ("SystemRoot", "C:\\Windows"),
            ("LOCALAPPDATA", "C:\\Users\\Ana María\\AppData\\Local"),
        ])
    }

    #[derive(Default)]
    struct Calls {
        external: Mutex<Vec<String>>,
        /// Answers for the next `open_external` calls (true when not set).
        external_results: Mutex<VecDeque<bool>>,
        /// A gate the next `open_external` waits on.
        external_gate: Mutex<Option<oneshot::Receiver<()>>>,
        spawns: Mutex<Vec<SpawnRequest>>,
        spawn_results: Mutex<VecDeque<bool>>,
        exists: Mutex<Vec<String>>,
        times: Mutex<VecDeque<u64>>,
        last_time: AtomicU64,
    }

    struct Setup {
        env: Option<Env>,
        spawn_results: Vec<bool>,
        times: Vec<u64>,
        present: Vec<String>,
    }

    impl Default for Setup {
        fn default() -> Self {
            Self {
                env: None,
                spawn_results: Vec::new(),
                times: Vec::new(),
                present: vec![WT.into(), PWSH.into()],
            }
        }
    }

    fn setup(options: Setup) -> (AppLauncher, Arc<Calls>) {
        let calls = Arc::new(Calls::default());
        calls
            .spawn_results
            .lock()
            .unwrap()
            .extend(options.spawn_results);
        calls.times.lock().unwrap().extend(options.times);
        let present: HashSet<String> = options
            .present
            .iter()
            .map(|path| path.to_lowercase())
            .collect();
        let deps = LauncherDeps {
            open_external: {
                let calls = Arc::clone(&calls);
                Arc::new(move |url: String| {
                    calls.external.lock().unwrap().push(url);
                    let result = calls
                        .external_results
                        .lock()
                        .unwrap()
                        .pop_front()
                        .unwrap_or(true);
                    let gate = calls.external_gate.lock().unwrap().take();
                    Box::pin(async move {
                        if let Some(gate) = gate {
                            let _ = gate.await;
                        }
                        result
                    })
                })
            },
            try_spawn: {
                let calls = Arc::clone(&calls);
                Arc::new(move |request: SpawnRequest| {
                    calls.spawns.lock().unwrap().push(request);
                    let result = calls
                        .spawn_results
                        .lock()
                        .unwrap()
                        .pop_front()
                        .unwrap_or(true);
                    Box::pin(async move { result })
                })
            },
            exists: {
                let calls = Arc::clone(&calls);
                Arc::new(move |path: &str| {
                    calls.exists.lock().unwrap().push(path.to_owned());
                    present.contains(&path.to_lowercase())
                })
            },
            home_dir: HOME.into(),
            env: options.env.unwrap_or_else(full_env),
            now: {
                let calls = Arc::clone(&calls);
                Arc::new(move || {
                    if let Some(next) = calls.times.lock().unwrap().pop_front() {
                        calls.last_time.store(next, Ordering::SeqCst);
                    }
                    calls.last_time.load(Ordering::SeqCst)
                })
            },
        };
        (AppLauncher::new(deps), calls)
    }

    fn open(launcher: &AppLauncher, app: AppId) -> LaunchResult {
        block_on(launcher.open(app))
    }

    fn request(file: &str, args: &[&str]) -> SpawnRequest {
        SpawnRequest {
            file: file.into(),
            args: args.iter().map(|arg| (*arg).to_owned()).collect(),
            cwd: HOME.into(),
            env: clean_env(&full_env()),
            creation_flags: TERMINAL_CREATION_FLAGS,
        }
    }

    impl Calls {
        fn external(&self) -> Vec<String> {
            self.external.lock().unwrap().clone()
        }

        fn spawns(&self) -> Vec<SpawnRequest> {
            self.spawns.lock().unwrap().clone()
        }
    }

    #[test]
    fn claude_opens_the_claude_link() {
        let (launcher, calls) = setup(Setup::default());
        assert_eq!(open(&launcher, AppId::Claude), LaunchResult::Desktop);
        assert_eq!(calls.external(), ["claude://claude.ai/new"]);
    }

    #[test]
    fn claude_falls_back_to_the_browser_when_the_link_fails() {
        let (a, calls) = setup(Setup::default());
        calls.external_results.lock().unwrap().push_back(false);
        assert_eq!(open(&a, AppId::Claude), LaunchResult::Browser);
        assert_eq!(
            calls.external(),
            ["claude://claude.ai/new", "https://claude.ai/new"]
        );

        let (b, calls) = setup(Setup::default());
        calls
            .external_results
            .lock()
            .unwrap()
            .extend([false, false]);
        assert_eq!(open(&b, AppId::Claude), LaunchResult::Failed);
        assert_eq!(calls.external().len(), 2);
    }

    #[test]
    fn terminal_launches_absolute_wt_with_absolute_pwsh_in_the_user_folder() {
        let (launcher, calls) = setup(Setup::default());
        assert_eq!(open(&launcher, AppId::Terminal), LaunchResult::Wt);
        assert_eq!(
            calls.spawns(),
            [request(WT, &["-w", "new", "-d", HOME, PWSH, "-NoLogo"])]
        );
    }

    #[test]
    fn a_path_with_spaces_stays_one_argument() {
        let (launcher, calls) = setup(Setup::default());
        open(&launcher, AppId::Terminal);
        let args = calls.spawns()[0].args.clone();
        let at = args.iter().position(|arg| arg == "-d").unwrap();
        assert_eq!(args[at + 1], HOME);
        assert_eq!(args.len(), 6);
    }

    #[test]
    fn uses_the_windows_apps_alias_when_not_in_path() {
        let alias = "C:\\Users\\Ana María\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
        let (launcher, calls) = setup(Setup {
            present: vec![alias.into(), PWSH.into()],
            ..Setup::default()
        });
        assert_eq!(open(&launcher, AppId::Terminal), LaunchResult::Wt);
        assert_eq!(calls.spawns()[0].file, alias);
    }

    #[test]
    fn a_relative_path_entry_never_wins() {
        let (launcher, calls) = setup(Setup {
            env: Some(env(&[
                ("PATH", ".;bin;..\\x;C:\\Tools"),
                ("SystemRoot", "C:\\Windows"),
            ])),
            present: vec![".\\wt.exe".into(), "bin\\wt.exe".into(), WT.into()],
            ..Setup::default()
        });
        assert_eq!(open(&launcher, AppId::Terminal), LaunchResult::Wt);
        assert_eq!(calls.spawns()[0].file, WT);
        for path in calls.exists.lock().unwrap().iter() {
            assert!(is_drive_path(path), "{path}");
        }
    }

    #[test]
    fn without_wt_launches_pwsh_without_pwsh_wt_uses_absolute_powershell() {
        let (a, calls) = setup(Setup {
            present: vec![PWSH.into()],
            ..Setup::default()
        });
        assert_eq!(open(&a, AppId::Terminal), LaunchResult::Pwsh);
        assert_eq!(calls.spawns(), [request(PWSH, &["-NoLogo"])]);

        let (b, calls) = setup(Setup {
            present: vec![WT.into()],
            ..Setup::default()
        });
        assert_eq!(open(&b, AppId::Terminal), LaunchResult::Wt);
        assert_eq!(
            calls.spawns(),
            [request(WT, &["-w", "new", "-d", HOME, PS5, "-NoLogo"])]
        );
    }

    #[test]
    fn terminal_falls_back_to_pwsh_then_powershell_when_starting_fails() {
        let (a, calls) = setup(Setup {
            spawn_results: vec![false, true],
            ..Setup::default()
        });
        assert_eq!(open(&a, AppId::Terminal), LaunchResult::Pwsh);
        assert_eq!(calls.spawns().last().unwrap(), &request(PWSH, &["-NoLogo"]));

        let (b, calls) = setup(Setup {
            spawn_results: vec![false, false, true],
            ..Setup::default()
        });
        assert_eq!(open(&b, AppId::Terminal), LaunchResult::Powershell);
        assert_eq!(calls.spawns().last().unwrap(), &request(PS5, &["-NoLogo"]));

        let (c, calls) = setup(Setup {
            spawn_results: vec![false, false, false],
            ..Setup::default()
        });
        assert_eq!(open(&c, AppId::Terminal), LaunchResult::Failed);
        assert_eq!(calls.spawns().len(), 3);
    }

    #[test]
    fn nothing_resolvable_fails_without_launching_bare_names() {
        let (launcher, calls) = setup(Setup {
            env: Some(env(&[("PATH", ".;bin")])),
            present: Vec::new(),
            ..Setup::default()
        });
        assert_eq!(open(&launcher, AppId::Terminal), LaunchResult::Failed);
        assert!(calls.spawns().is_empty());
    }

    #[test]
    fn a_relative_system_root_does_not_count_for_powershell() {
        let (launcher, calls) = setup(Setup {
            env: Some(env(&[("PATH", "C:\\Tools"), ("SystemRoot", "win")])),
            present: Vec::new(),
            ..Setup::default()
        });
        assert_eq!(open(&launcher, AppId::Terminal), LaunchResult::Failed);
        assert!(calls.spawns().is_empty());
    }

    #[test]
    fn the_environment_carries_no_notch_or_electron_variables() {
        let mut dirty = full_env();
        dirty.extend(env(&[
            ("NOTCH_USER_DATA_DIR", "a"),
            ("ELECTRON_RUN_AS_NODE", "1"),
        ]));
        let (launcher, calls) = setup(Setup {
            env: Some(dirty),
            ..Setup::default()
        });
        open(&launcher, AppId::Terminal);
        assert_eq!(calls.spawns()[0].env, clean_env(&full_env()));
        assert_eq!(
            clean_env(&env(&[("NOTCH_A", "1"), ("ELECTRON_B", "1"), ("Z", "2")])),
            env(&[("Z", "2")])
        );
    }

    #[test]
    fn ignores_a_second_click_on_the_same_app_within_1000_ms() {
        let (launcher, calls) = setup(Setup {
            times: vec![0, 999, 1000, 1001],
            ..Setup::default()
        });
        assert_eq!(open(&launcher, AppId::Claude), LaunchResult::Desktop);
        assert_eq!(open(&launcher, AppId::Claude), LaunchResult::Ignored);
        assert_eq!(calls.external().len(), 1);
        assert_eq!(open(&launcher, AppId::Claude), LaunchResult::Desktop);
        assert_eq!(calls.external().len(), 2);
        assert_eq!(open(&launcher, AppId::Terminal), LaunchResult::Wt);
        assert_eq!(calls.spawns().len(), 1);
    }

    #[test]
    fn a_failed_attempt_counts_as_a_recent_launch() {
        let (launcher, calls) = setup(Setup {
            times: vec![0, 10, 20, 30],
            ..Setup::default()
        });
        calls
            .external_results
            .lock()
            .unwrap()
            .extend([false, false]);
        assert_eq!(open(&launcher, AppId::Claude), LaunchResult::Failed);
        assert_eq!(open(&launcher, AppId::Claude), LaunchResult::Ignored);
    }

    #[test]
    fn ignores_a_click_while_the_first_launch_is_still_pending() {
        let (launcher, calls) = setup(Setup {
            times: vec![0, 10],
            ..Setup::default()
        });
        let (release, gate) = oneshot::channel();
        *calls.external_gate.lock().unwrap() = Some(gate);
        let first = launcher.open(AppId::Claude);
        assert_eq!(open(&launcher, AppId::Claude), LaunchResult::Ignored);
        release.send(()).unwrap();
        assert_eq!(block_on(first), LaunchResult::Desktop);
        assert_eq!(calls.external().len(), 1);
    }

    #[test]
    fn terminal_flags_open_a_new_console_that_keeps_ctrl_c() {
        use windows_sys::Win32::System::Threading::{
            CREATE_NEW_CONSOLE, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, DETACHED_PROCESS,
        };
        assert_eq!(TERMINAL_CREATION_FLAGS, CREATE_NEW_CONSOLE);
        // A new process group would disable Ctrl+C in the fallback shell's console.
        assert_eq!(TERMINAL_CREATION_FLAGS & CREATE_NEW_PROCESS_GROUP, 0);
        assert_eq!(
            TERMINAL_CREATION_FLAGS & (DETACHED_PROCESS | CREATE_NO_WINDOW),
            0
        );
    }

    #[test]
    fn win32_join_normalizes_like_node() {
        assert_eq!(win32_join(&["C:\\Tools", "wt.exe"]), "C:\\Tools\\wt.exe");
        assert_eq!(win32_join(&["C:\\Tools\\", "wt.exe"]), "C:\\Tools\\wt.exe");
        assert_eq!(
            win32_join(&["c:/Tools/./x/..", "wt.exe"]),
            "c:\\Tools\\wt.exe"
        );
        assert_eq!(
            win32_join(&[
                "C:\\Windows",
                "System32",
                "WindowsPowerShell",
                "v1.0",
                "powershell.exe"
            ]),
            PS5
        );
        assert_eq!(win32_join(&["C:\\..", "wt.exe"]), "C:\\wt.exe");
    }
}
