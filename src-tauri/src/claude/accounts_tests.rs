//! Account ids and detection of the Claude Code config folders.

use std::path::Path;

use super::*;
use crate::services::test_dir::TestDir;

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn profile(email: &str, organization: &str) -> String {
    serde_json::json!({
        "numStartups": 3,
        "oauthAccount": { "emailAddress": email, "organizationName": organization, "accountUuid": "x" },
    })
    .to_string()
}

#[test]
fn the_default_folder_is_claude_and_a_home_claude_folder_is_its_name() {
    let home = Path::new(r"C:\Users\me");
    assert_eq!(account_id_for(&home.join(".claude"), home), "claude");
    assert_eq!(
        account_id_for(&home.join(".claude-work"), home),
        "claude-work"
    );
    // Case and a trailing separator do not change the id.
    assert_eq!(
        account_id_for(Path::new(r"c:\users\ME\.Claude-Work\"), home),
        "claude-work"
    );
    assert_eq!(
        account_id_for(Path::new(r"C:\Users\me\.CLAUDE"), home),
        "claude"
    );
}

#[test]
fn any_other_folder_is_a_short_hash_of_its_lowercase_path() {
    let home = Path::new(r"C:\Users\me");
    // SHA-256 of `d:\profiles\claude`, first 8 hex digits.
    assert_eq!(
        account_id_for(Path::new(r"D:\Profiles\Claude"), home),
        "dir-fbdb2f0b"
    );
    assert_eq!(
        account_id_for(Path::new(r"d:\profiles\claude\"), home),
        "dir-fbdb2f0b"
    );
    // A home folder whose name would not be a valid id is hashed too.
    let odd = account_id_for(&home.join(".claude-my_work"), home);
    assert!(odd.starts_with("dir-") && odd.len() == 12, "{odd}");
    assert!(is_account_id(&odd));
}

#[test]
fn account_ids_are_short_lowercase_letters_digits_and_dashes() {
    for valid in ["claude", "claude-work", "dir-0123abcd", "a"] {
        assert!(is_account_id(valid), "{valid}");
    }
    let long = "a".repeat(65);
    for invalid in [
        "",
        "Claude",
        "claude_work",
        "claude work",
        "é",
        long.as_str(),
    ] {
        assert!(!is_account_id(invalid), "{invalid:?}");
    }
    assert!(is_account_id(&"a".repeat(64)));
}

#[test]
fn detects_the_default_folder_and_the_home_folders_with_a_profile() {
    let home = TestDir::new("claude-accounts");
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    write(
        &home.join(".claude.json"),
        &profile("me@example.test", "Personal"),
    );
    write(
        &home.join(".claude-work").join(".claude.json"),
        &profile("work@example.test", "Acme"),
    );
    std::fs::create_dir_all(home.join(".claude-old")).unwrap();
    // A profile without `oauthAccount` is not an account either.
    write(&home.join(".claude-empty").join(".claude.json"), "{}");

    let accounts = detect_accounts(home.path(), &[]);
    assert_eq!(
        accounts,
        vec![
            ClaudeAccount {
                id: "claude".into(),
                dir: home.join(".claude"),
                settings_file: home.join(".claude").join("settings.json"),
                email: Some("me@example.test".into()),
                organization: Some("Personal".into()),
            },
            ClaudeAccount {
                id: "claude-work".into(),
                dir: home.join(".claude-work"),
                settings_file: home.join(".claude-work").join("settings.json"),
                email: Some("work@example.test".into()),
                organization: Some("Acme".into()),
            },
        ]
    );
}

#[test]
fn the_default_folder_is_always_there_and_extra_folders_must_exist() {
    let home = TestDir::new("claude-accounts-extra");
    let extra = home.join("profiles").join("Second");
    write(
        &extra.join(".claude.json"),
        &profile("second@example.test", "Org"),
    );
    let missing = home.join("nope");

    let accounts = detect_accounts(home.path(), &[extra.clone(), missing, extra.clone()]);
    let ids: Vec<&str> = accounts.iter().map(|account| account.id.as_str()).collect();
    let extra_id = account_id_for(&extra, home.path());
    assert_eq!(ids, ["claude", extra_id.as_str()]);
    // No `~/.claude.json`: the default account has no profile.
    assert_eq!(accounts[0].email, None);
    assert_eq!(accounts[0].organization, None);
    assert_eq!(accounts[1].dir, extra);
    assert_eq!(accounts[1].settings_file, extra.join("settings.json"));
    assert_eq!(accounts[1].email.as_deref(), Some("second@example.test"));
}

#[test]
fn accounts_are_sorted_with_the_default_first_then_by_id() {
    let home = TestDir::new("claude-accounts-order");
    for name in [".claude-zeta", ".claude-alpha"] {
        write(
            &home.join(name).join(".claude.json"),
            &profile("x@example.test", "O"),
        );
    }
    let ids: Vec<String> = detect_accounts(home.path(), &[])
        .into_iter()
        .map(|account| account.id)
        .collect();
    assert_eq!(ids, ["claude", "claude-alpha", "claude-zeta"]);
}

#[test]
fn a_profile_with_wrong_types_keeps_only_the_strings() {
    let home = TestDir::new("claude-accounts-types");
    write(
        &home.join(".claude.json"),
        r#"{"oauthAccount":{"emailAddress":7,"organizationName":"Solo"}}"#,
    );
    let accounts = detect_accounts(home.path(), &[]);
    assert_eq!(accounts[0].email, None);
    assert_eq!(accounts[0].organization.as_deref(), Some("Solo"));
}

fn directory(home: &TestDir, settings: ClaudeAccountsSettings) -> AccountDirectory {
    AccountDirectory {
        home: home.path().to_path_buf(),
        default_settings_file: None,
        backups: home.join("backups"),
        read: Arc::new(move || settings.clone()),
        save: Arc::new(|_| Box::pin(async { Ok(()) })),
    }
}

#[test]
fn a_linked_home_folder_that_lost_its_profile_is_still_listed() {
    let home = TestDir::new("claude-accounts-linked");
    std::fs::create_dir_all(home.join(".claude-work")).unwrap();
    let accounts = directory(
        &home,
        ClaudeAccountsSettings {
            linked: vec!["claude-work".into(), "claude-gone".into()],
            extra_dirs: Vec::new(),
            initialized: true,
        },
    );
    let ids: Vec<String> = accounts
        .list()
        .into_iter()
        .map(|account| account.id)
        .collect();
    assert_eq!(ids, ["claude", "claude-work"]);
    assert!(accounts.installer("claude-work").is_some());
    assert!(accounts.installer("claude-gone").is_none());
}

#[test]
fn the_dev_settings_override_applies_to_the_default_account_only() {
    let home = TestDir::new("claude-accounts-override");
    write(
        &home.join(".claude-work").join(".claude.json"),
        &profile("w@example.test", "O"),
    );
    let mut accounts = directory(&home, ClaudeAccountsSettings::default());
    accounts.default_settings_file = Some(home.join("e2e-settings.json"));
    let list = accounts.list();
    assert_eq!(list[0].settings_file, home.join("e2e-settings.json"));
    assert_eq!(
        list[1].settings_file,
        home.join(".claude-work").join("settings.json")
    );
}

#[test]
fn the_0_3_0_original_moves_to_the_default_account_once() {
    let home = TestDir::new("claude-accounts-legacy");
    let backups = home.join("backups");
    write(&backups.join(ORIGINAL_FILE), "{\"before\":true}\n");
    adopt_legacy_backups(&backups);
    assert!(!backups.join(ORIGINAL_FILE).exists());
    let moved = backups.join(DEFAULT_ACCOUNT_ID).join(ORIGINAL_FILE);
    assert_eq!(
        std::fs::read_to_string(&moved).unwrap(),
        "{\"before\":true}\n"
    );
    // An original already in place is never replaced.
    write(&backups.join(ORIGINAL_FILE), "{\"later\":true}\n");
    adopt_legacy_backups(&backups);
    assert_eq!(
        std::fs::read_to_string(&moved).unwrap(),
        "{\"before\":true}\n"
    );
    // Nothing to move: nothing happens.
    adopt_legacy_backups(&home.join("nowhere"));
    assert!(!home.join("nowhere").exists());
}
