//! 0.1.0's `gmail-token-store.test.ts` (10 cases) under Gmail's file name and log scope.
//! The generic behaviours are also covered by `services::secure_token_store` (map section 11);
//! these pin them for `gmail-token.bin` / `main:gmail-token`.

use std::io;
use std::sync::Arc;

use base64::Engine as _;

use super::*;
use crate::services::logger::scope_for_target;
use crate::services::test_dir::TestDir;
use crate::services::test_log;

const TOKEN: &str = "refresh-token-1//SECRET-VALUE";
const BASE64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// `fakeSafeStorage`: XOR 0x5a, and decryption refuses what does not start with `refresh-`.
fn fake_crypto(available: bool) -> TokenCrypto {
    let xor = |bytes: &[u8]| -> Vec<u8> { bytes.iter().map(|byte| byte ^ 0x5a).collect() };
    TokenCrypto {
        available: Arc::new(move || available),
        encrypt: Arc::new(move |bytes| Ok(xor(bytes))),
        decrypt: Arc::new(move |bytes| {
            let plain = xor(bytes);
            if plain.starts_with(b"refresh-") {
                Ok(plain)
            } else {
                Err(io::Error::other("bad ciphertext"))
            }
        }),
    }
}

fn make(dir: &TestDir, available: bool) -> SecureTokenStore {
    token_store_with_crypto(dir.path(), fake_crypto(available))
}

fn file(dir: &TestDir) -> std::path::PathBuf {
    dir.join("gmail-token.bin")
}

fn gmail_lines() -> Vec<String> {
    test_log::capture()
        .expect("the test logger")
        .lines()
        .into_iter()
        .filter(|line| {
            let target = line.split(' ').nth(1).unwrap_or_default();
            scope_for_target(target) == "main:gmail-token"
        })
        .collect()
}

fn no_line_has_the_token() {
    let lines = test_log::capture().expect("the test logger").lines();
    assert!(lines.iter().all(|line| !line.contains("SECRET-VALUE")));
}

#[test]
fn the_file_and_log_scope_are_gmails() {
    assert_eq!(TOKEN_FILE, "gmail-token.bin");
    assert_eq!(TOKEN_LOG_SCOPE, "gmail-token");
}

#[tokio::test]
async fn returns_null_when_nothing_was_saved() {
    let dir = TestDir::new("gmail-token-empty");
    assert_eq!(make(&dir, true).load().await, None);
}

#[tokio::test]
async fn saves_encrypted_never_plain_text_and_loads_it_back_from_a_new_store() {
    let dir = TestDir::new("gmail-token-save");
    let store = make(&dir, true);
    store.save(TOKEN).await.unwrap();
    assert!(store.persistent());
    let raw = std::fs::read(file(&dir)).unwrap();
    let text = String::from_utf8_lossy(&raw);
    assert!(!text.contains(TOKEN));
    assert!(!text.contains("SECRET-VALUE"));
    assert_eq!(make(&dir, true).load().await.as_deref(), Some(TOKEN));
}

#[tokio::test]
async fn writes_through_fs_atomic() {
    // Rust cannot spy on `write_atomic`; its result is pinned instead: only the final file,
    // holding exactly base64 of the encrypted token (no temporary file left behind).
    let dir = TestDir::new("gmail-token-atomic");
    make(&dir, true).save(TOKEN).await.unwrap();
    assert_eq!(dir.names(), ["gmail-token.bin"]);
    let stored = std::fs::read_to_string(file(&dir)).unwrap();
    assert_eq!(
        BASE64.decode(stored).unwrap(),
        TOKEN.bytes().map(|byte| byte ^ 0x5a).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn keeps_the_token_only_in_memory_without_encryption() {
    test_log::capture().expect("the test logger");
    let dir = TestDir::new("gmail-token-memory");
    let store = make(&dir, false);
    assert!(!store.persistent());
    store.save(TOKEN).await.unwrap();
    assert!(!file(&dir).exists());
    assert!(dir.names().is_empty(), "nothing written");
    assert_eq!(store.load().await.as_deref(), Some(TOKEN));
    no_line_has_the_token();
    assert_eq!(make(&dir, false).load().await, None);
    assert!(gmail_lines()
        .iter()
        .any(|line| line
            .contains("OS encryption unavailable; the session will not survive a restart")));
}

#[tokio::test]
async fn ignores_a_leftover_file_without_encryption() {
    let dir = TestDir::new("gmail-token-leftover");
    make(&dir, true).save(TOKEN).await.unwrap();
    assert_eq!(make(&dir, false).load().await, None);
}

#[tokio::test]
async fn returns_null_and_deletes_a_file_that_cannot_be_decrypted() {
    test_log::capture().expect("the test logger");
    let dir = TestDir::new("gmail-token-garbage");
    std::fs::write(file(&dir), "not-a-valid-ciphertext").unwrap();
    assert_eq!(make(&dir, true).load().await, None);
    assert!(!file(&dir).exists());
    // Valid base64 that the fake refuses to decrypt goes the same way.
    std::fs::write(file(&dir), BASE64.encode(b"garbage")).unwrap();
    assert_eq!(make(&dir, true).load().await, None);
    assert!(!file(&dir).exists());
    assert!(gmail_lines().iter().any(|line| line.starts_with("WARN ")
        && line.contains("Stored token could not be decrypted; discarding it")));
}

#[tokio::test]
async fn clear_removes_the_file_and_the_in_memory_token() {
    let dir = TestDir::new("gmail-token-clear");
    let store = make(&dir, true);
    store.save(TOKEN).await.unwrap();
    store.clear().await;
    assert!(!file(&dir).exists());
    assert_eq!(store.load().await, None);
    store.clear().await;
}

#[tokio::test]
async fn never_logs_the_token() {
    test_log::capture().expect("the test logger");
    let dir = TestDir::new("gmail-token-logs");
    let store = make(&dir, true);
    store.save(TOKEN).await.unwrap();
    store.load().await;
    std::fs::write(file(&dir), "garbage").unwrap();
    make(&dir, true).load().await;
    store.clear().await;
    no_line_has_the_token();
    assert!(gmail_lines()
        .iter()
        .any(|line| line.contains("Token saved")));
}

#[tokio::test]
async fn keeps_a_valid_file_when_reading_it_fails_with_a_transient_io_error() {
    // Rust cannot inject EBUSY into `tokio::fs::read`; a directory in the file's place fails
    // the read the same way (the shared store's `a_read_failure_keeps_the_file`).
    test_log::capture().expect("the test logger");
    let dir = TestDir::new("gmail-token-busy");
    std::fs::create_dir(file(&dir)).unwrap();
    assert_eq!(make(&dir, true).load().await, None);
    assert!(file(&dir).is_dir(), "kept");
    assert!(gmail_lines().iter().any(|line| line.starts_with("WARN ")
        && line.contains("Could not read the token file")
        && line.contains("error=")));
    std::fs::remove_dir(file(&dir)).unwrap();
    make(&dir, true).save(TOKEN).await.unwrap();
    assert_eq!(make(&dir, true).load().await.as_deref(), Some(TOKEN));
}

#[tokio::test]
async fn deletes_a_stale_encrypted_file_when_saving_without_encryption() {
    let dir = TestDir::new("gmail-token-stale");
    make(&dir, true).save(TOKEN).await.unwrap();
    assert!(file(&dir).exists());
    make(&dir, false).save("refresh-token-2").await.unwrap();
    assert!(!file(&dir).exists());
    assert_eq!(make(&dir, true).load().await, None);
}

#[tokio::test]
async fn the_production_store_uses_dpapi_on_gmail_token_bin() {
    let dir = TestDir::new("gmail-token-dpapi");
    let store = token_store(dir.path());
    assert!(store.persistent());
    store.save("refresh-DPAPI-SECRET-VALUE").await.unwrap();
    assert_eq!(dir.names(), ["gmail-token.bin"]);
    assert_eq!(
        token_store(dir.path()).load().await.as_deref(),
        Some("refresh-DPAPI-SECRET-VALUE")
    );
}
