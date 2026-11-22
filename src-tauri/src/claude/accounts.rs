//! Claude Code accounts: each one is a Claude Code config folder (`~/.claude`, `~/.claude-work`,
//! or any folder the user adds). Every hook we install in an account's `settings.json` carries
//! [`ACCOUNT_HEADER`] with the account's id, so the bridge knows which account an event came from.
//!
//! An id is stable and carries no personal data: `claude` for `~/.claude`, the folder name
//! without its dot for `~/.claude-*`, else `dir-` and 8 hex digits of the SHA-256 of the folder's
//! lowercase path. Profiles (`oauthAccount.emailAddress` / `organizationName`) are only shown in
//! the Control Center, never logged.

use std::path::{Path, PathBuf, MAIN_SEPARATOR};
use std::sync::Arc;

use serde_json::Value;
use sha2::{Digest, Sha256};

use super::hook_installer::{HookInstaller, ORIGINAL_FILE};
use super::service::{Accounts, AccountsChange, BoxFuture, ClaudeAccountsSettings, Installer};
use crate::ipc::ExposedError;

/// The header every hook of ours sends with its account id.
pub const ACCOUNT_HEADER: &str = "x-notch-account";
/// `~/.claude`: also the account of a hook without [`ACCOUNT_HEADER`] (installed by 0.3.0).
pub const DEFAULT_ACCOUNT_ID: &str = "claude";
/// Longest account id (and [`ACCOUNT_HEADER`] value).
pub const ACCOUNT_ID_MAX: usize = 64;

const DEFAULT_DIR: &str = ".claude";
const HOME_PREFIX: &str = ".claude-";
const PROFILE_FILE: &str = ".claude.json";
const SETTINGS_FILE: &str = "settings.json";

/// One Claude Code config folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaudeAccount {
    pub id: String,
    pub dir: PathBuf,
    pub settings_file: PathBuf,
    pub email: Option<String>,
    pub organization: Option<String>,
}

/// `^[a-z0-9-]{1,64}$`: what an account id (and the header) may be.
pub fn is_account_id(value: &str) -> bool {
    (1..=ACCOUNT_ID_MAX).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// The path as compared and hashed: the platform separator only, none at the end, lowercase.
fn normalized(path: &Path) -> String {
    let text = path
        .to_string_lossy()
        .replace('/', &MAIN_SEPARATOR.to_string());
    let trimmed = text.trim_end_matches(['\\', '/']);
    trimmed.to_lowercase()
}

/// The id of the account in `dir` (see the module docs).
pub fn account_id_for(dir: &Path, home: &Path) -> String {
    let folder = normalized(dir);
    let home = normalized(home);
    let sep = MAIN_SEPARATOR.to_string();
    if let Some(name) = folder
        .strip_prefix(&home)
        .and_then(|rest| rest.strip_prefix(sep.as_str()))
    {
        if name == DEFAULT_DIR {
            return DEFAULT_ACCOUNT_ID.to_owned();
        }
        if let Some(id) = name.strip_prefix('.') {
            if name.starts_with(HOME_PREFIX) && is_account_id(id) {
                return id.to_owned();
            }
        }
    }
    let digest = Sha256::digest(folder.as_bytes());
    let hex: String = digest[..4]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("dir-{hex}")
}

/// `oauthAccount.emailAddress` and `organizationName` of a `.claude.json`; `None` when the
/// file cannot be read, is not JSON or has no `oauthAccount` object.
fn read_profile(file: &Path) -> Option<(Option<String>, Option<String>)> {
    let text = std::fs::read_to_string(file).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let account = value.get("oauthAccount")?.as_object()?;
    let text = |key: &str| account.get(key).and_then(Value::as_str).map(str::to_owned);
    Some((text("emailAddress"), text("organizationName")))
}

fn account(
    id: String,
    dir: PathBuf,
    profile: Option<(Option<String>, Option<String>)>,
) -> ClaudeAccount {
    let (email, organization) = profile.unwrap_or_default();
    ClaudeAccount {
        id,
        settings_file: dir.join(SETTINGS_FILE),
        dir,
        email,
        organization,
    }
}

/// `~/.claude` always (its profile is `~/.claude.json`), every `~/.claude-*` whose
/// `.claude.json` has an `oauthAccount`, and each of `extra_dirs` that is a folder (profile in
/// its own `.claude.json`, if any). The default first, then by id; one entry per id.
pub fn detect_accounts(home: &Path, extra_dirs: &[PathBuf]) -> Vec<ClaudeAccount> {
    let mut found = vec![account(
        DEFAULT_ACCOUNT_ID.to_owned(),
        home.join(DEFAULT_DIR),
        read_profile(&home.join(PROFILE_FILE)),
    )];
    if let Ok(entries) = std::fs::read_dir(home) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.to_lowercase().starts_with(HOME_PREFIX)
                || !entry.file_type().is_ok_and(|kind| kind.is_dir())
            {
                continue;
            }
            let dir = entry.path();
            if let Some(profile) = read_profile(&dir.join(PROFILE_FILE)) {
                found.push(account(account_id_for(&dir, home), dir, Some(profile)));
            }
        }
    }
    for dir in extra_dirs {
        if dir.is_dir() {
            let profile = read_profile(&dir.join(PROFILE_FILE));
            found.push(account(account_id_for(dir, home), dir.clone(), profile));
        }
    }
    sorted(found)
}

/// One entry per id (the first one found), the default first, then by id.
fn sorted(found: Vec<ClaudeAccount>) -> Vec<ClaudeAccount> {
    let mut accounts: Vec<ClaudeAccount> = Vec::new();
    for account in found {
        if !accounts.iter().any(|known| known.id == account.id) {
            accounts.push(account);
        }
    }
    accounts.sort_by(|a, b| {
        (a.id != DEFAULT_ACCOUNT_ID)
            .cmp(&(b.id != DEFAULT_ACCOUNT_ID))
            .then_with(|| a.id.cmp(&b.id))
    });
    accounts
}

/// Reads the `claudeAccounts` settings.
pub type ReadAccounts = Arc<dyn Fn() -> ClaudeAccountsSettings + Send + Sync>;
/// Saves a change of the `claudeAccounts` settings.
pub type SaveAccounts =
    Arc<dyn Fn(AccountsChange) -> BoxFuture<'static, Result<(), ExposedError>> + Send + Sync>;

/// The real accounts: the folders on disk plus the `claudeAccounts` settings. Each account's
/// installer writes its own `settings.json` and keeps its backups (and the pre-install original)
/// in `<backups>/<id>`.
pub struct AccountDirectory {
    pub home: PathBuf,
    /// Dev/E2E only (`NOTCH_CLAUDE_SETTINGS`): the default account's settings file elsewhere.
    pub default_settings_file: Option<PathBuf>,
    /// `<data dir>/claude-hooks-backups`.
    pub backups: PathBuf,
    pub read: ReadAccounts,
    pub save: SaveAccounts,
}

impl AccountDirectory {
    fn all(&self) -> Vec<ClaudeAccount> {
        let settings = (self.read)();
        let extra: Vec<PathBuf> = settings.extra_dirs.iter().map(PathBuf::from).collect();
        let mut found = detect_accounts(&self.home, &extra);
        // A linked home folder that lost its profile is still that account (so its hooks can be
        // removed).
        for id in &settings.linked {
            let dir = self.home.join(format!(".{id}"));
            if !found.iter().any(|account| &account.id == id)
                && dir.is_dir()
                && account_id_for(&dir, &self.home) == *id
            {
                found.push(account(id.clone(), dir, None));
            }
        }
        let mut accounts = sorted(found);
        if let (Some(file), Some(default)) = (&self.default_settings_file, accounts.first_mut()) {
            default.settings_file = file.clone();
        }
        accounts
    }
}

impl Accounts for AccountDirectory {
    fn list(&self) -> Vec<ClaudeAccount> {
        self.all()
    }

    fn installer(&self, id: &str) -> Option<Arc<dyn Installer>> {
        let account = self.all().into_iter().find(|account| account.id == id)?;
        Some(Arc::new(HookInstaller::new(
            account.settings_file,
            self.backups.join(&account.id),
            chrono::Utc::now,
        )))
    }

    fn settings(&self) -> ClaudeAccountsSettings {
        (self.read)()
    }

    fn update(&self, change: AccountsChange) -> BoxFuture<'_, Result<(), ExposedError>> {
        (self.save)(change)
    }

    fn home(&self) -> PathBuf {
        self.home.clone()
    }
}

/// Before accounts (0.3.0), the default account's backups lived in `backups` itself: its
/// pre-install original moves to `backups/claude`, so uninstalling still restores it byte for
/// byte and a reinstall never takes the file with our hooks for the original.
pub fn adopt_legacy_backups(backups: &Path) {
    let legacy = backups.join(ORIGINAL_FILE);
    let target_dir = backups.join(DEFAULT_ACCOUNT_ID);
    let target = target_dir.join(ORIGINAL_FILE);
    if !legacy.is_file() || target.exists() {
        return;
    }
    let moved =
        std::fs::create_dir_all(&target_dir).and_then(|()| std::fs::rename(&legacy, &target));
    match moved {
        Ok(()) => log::info!("Moved the Claude hooks original to the default account"),
        Err(error) => log::warn!(
            "Could not move the Claude hooks original to the default account ({:?})",
            error.kind()
        ),
    }
}

#[cfg(test)]
#[path = "accounts_tests.rs"]
mod tests;
