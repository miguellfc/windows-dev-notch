//! One secret token per file (0.1.0's `secure-token-store.ts`): the GitHub and GitLab
//! personal tokens now, the Gmail refresh token and the Redmine key later.
//!
//! On disk it is only ever `base64(DPAPI blob)` as text (no JSON, no version), written
//! atomically. Without OS encryption the token lives in memory for the session and nothing is
//! written. The token is never logged; failures are logged as their kind and OS code only.
//!
//! Format change from Electron: a file written by `safeStorage` (`v10` + AES-GCM under a key the
//! Chromium `Local State` wraps with DPAPI) is not a plain DPAPI blob, so it fails to decrypt here,
//! is discarded with a warning, and the user enters the token again (as for the Claude bridge).

use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use tokio::sync::Mutex;

use super::dpapi;
use super::fs_atomic::write_atomic;
use crate::contract::text::js_trim;
use crate::ipc::BoxFuture;

const BASE64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

type Available = dyn Fn() -> bool + Send + Sync;
type Crypt = dyn Fn(&[u8]) -> io::Result<Vec<u8>> + Send + Sync;

/// `TokenSafeStorage`: the OS encryption ([`TokenCrypto::dpapi`] in production).
#[derive(Clone)]
pub struct TokenCrypto {
    /// `isEncryptionAvailable()`, asked on each use.
    pub available: Arc<Available>,
    pub encrypt: Arc<Crypt>,
    pub decrypt: Arc<Crypt>,
}

impl TokenCrypto {
    /// DPAPI for the current Windows user.
    pub fn dpapi() -> Self {
        Self {
            available: Arc::new(dpapi::available),
            encrypt: Arc::new(dpapi::protect),
            decrypt: Arc::new(dpapi::unprotect),
        }
    }
}

/// `TokenStore`. Its operations run one at a time, in call order.
pub struct SecureTokenStore {
    file: PathBuf,
    /// `log` target whose scope is `main:<scope>`.
    target: String,
    crypto: TokenCrypto,
    /// The token once loaded or saved; the lock also serializes the operations.
    memory: Mutex<Option<String>>,
}

impl SecureTokenStore {
    /// A store for `file` encrypted with DPAPI, logging under `main:<scope>`.
    pub fn new(file: PathBuf, scope: &str) -> Self {
        Self::with_crypto(file, scope, TokenCrypto::dpapi())
    }

    pub fn with_crypto(file: PathBuf, scope: &str, crypto: TokenCrypto) -> Self {
        Self {
            file,
            target: format!("{}::{scope}", env!("CARGO_CRATE_NAME")),
            crypto,
            memory: Mutex::new(None),
        }
    }

    /// True when the token survives a restart (OS encryption is available).
    pub fn persistent(&self) -> bool {
        (self.crypto.available)()
    }

    /// The stored token, or `None` (missing, unreadable for now, undecryptable: then discarded).
    pub async fn load(&self) -> Option<String> {
        let mut memory = self.memory.lock().await;
        if memory.is_some() {
            return memory.clone();
        }
        if !self.persistent() {
            return None;
        }
        let bytes = match tokio::fs::read(&self.file).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return None,
            Err(error) => {
                // Transient I/O trouble (sharing violation, access denied): the file may be
                // fine, so keep it.
                log::warn!(target: &self.target, "Could not read the token file error={}", summary(&error));
                return None;
            }
        };
        // `readFile(file, 'utf8')` replaces invalid bytes instead of failing.
        let text = String::from_utf8_lossy(&bytes);
        match self.decrypt(js_trim(&text)) {
            Ok(token) => {
                *memory = Some(token.clone());
                Some(token)
            }
            Err(reason) => {
                log::warn!(target: &self.target, "Stored token could not be decrypted; discarding it error={reason}");
                self.discard_file().await;
                None
            }
        }
    }

    /// Keeps `token` (in memory at once); fails only when the encrypted file cannot be written.
    pub async fn save(&self, token: &str) -> io::Result<()> {
        let mut memory = self.memory.lock().await;
        *memory = Some(token.to_owned());
        if !self.persistent() {
            log::warn!(target: &self.target, "OS encryption unavailable; the session will not survive a restart");
            // A stale encrypted token must not load later.
            self.discard_file().await;
            return Ok(());
        }
        let blob = (self.crypto.encrypt)(token.as_bytes())?;
        write_atomic(&self.file, BASE64.encode(blob).as_bytes()).await?;
        log::debug!(target: &self.target, "Token saved");
        Ok(())
    }

    /// Forgets the token and deletes its file (a delete failure is only logged).
    pub async fn clear(&self) {
        let mut memory = self.memory.lock().await;
        *memory = None;
        self.discard_file().await;
    }

    /// The token in the stored text, or why it cannot be had (no token content in the reason).
    /// Deviation: Node's base64 decoder skips invalid characters; this one refuses them (a file
    /// written here is always valid), which discards the file all the same.
    fn decrypt(&self, text: &str) -> Result<String, String> {
        let blob = BASE64
            .decode(text)
            .map_err(|_| "InvalidBase64".to_owned())?;
        let plain = (self.crypto.decrypt)(&blob).map_err(|error| summary(&error))?;
        let token = String::from_utf8(plain).map_err(|_| "InvalidUtf8".to_owned())?;
        if token.is_empty() {
            return Err("EmptyToken".into());
        }
        Ok(token)
    }

    async fn discard_file(&self) {
        match tokio::fs::remove_file(&self.file).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                log::warn!(target: &self.target, "Could not delete the token file error={}", summary(&error));
            }
        }
    }
}

/// `errorSummary`: the kind and OS code of an I/O error, never its message.
fn summary(error: &io::Error) -> String {
    match error.raw_os_error() {
        Some(code) => format!("{:?} code={code:#x}", error.kind()),
        None => format!("{:?}", error.kind()),
    }
}

/// One integration's token file (`Pick<TokenStore, 'load' | 'save' | 'clear' | 'persistent'>`),
/// as the integrations see it (fakes in their tests, [`SecureTokenStore`] in the app).
/// Errors are a code or kind only, never a message.
pub trait TokenStore: Send + Sync {
    fn load(&self) -> BoxFuture<'_, Result<Option<String>, String>>;
    fn save<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<(), String>>;
    fn clear(&self) -> BoxFuture<'_, Result<(), String>>;
    /// True when a saved token survives a restart (asked on every `state()`).
    fn persistent(&self) -> bool;
}

impl TokenStore for SecureTokenStore {
    fn load(&self) -> BoxFuture<'_, Result<Option<String>, String>> {
        Box::pin(async move { Ok(SecureTokenStore::load(self).await) })
    }

    fn save<'a>(&'a self, token: &'a str) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            SecureTokenStore::save(self, token)
                .await
                .map_err(|error| format!("{:?}", error.kind()))
        })
    }

    fn clear(&self) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            SecureTokenStore::clear(self).await;
            Ok(())
        })
    }

    fn persistent(&self) -> bool {
        SecureTokenStore::persistent(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::logger::scope_for_target;
    use crate::services::test_dir::TestDir;
    use crate::services::test_log;

    /// `fakeSafeStorage` of the TS test: XOR 0x5a.
    fn xor_crypto(available: bool) -> TokenCrypto {
        let xor = |bytes: &[u8]| Ok(bytes.iter().map(|byte| byte ^ 0x5a).collect());
        TokenCrypto {
            available: Arc::new(move || available),
            encrypt: Arc::new(xor),
            decrypt: Arc::new(xor),
        }
    }

    fn lines_with(text: &str) -> Vec<String> {
        test_log::capture()
            .expect("the test logger")
            .lines()
            .into_iter()
            .filter(|line| line.contains(text))
            .collect()
    }

    fn target_of(line: &str) -> String {
        line.split(' ').nth(1).unwrap_or_default().to_owned()
    }

    #[tokio::test]
    async fn keeps_one_token_per_file_encrypted_and_logs_under_its_own_scope_without_the_token() {
        test_log::capture().expect("the test logger");
        let dir = TestDir::new("secure-token");
        let github = SecureTokenStore::with_crypto(
            dir.join("code-review-github.bin"),
            "code-review-token",
            xor_crypto(true),
        );
        let gitlab = SecureTokenStore::with_crypto(
            dir.join("code-review-gitlab.bin"),
            "code-review-token",
            xor_crypto(true),
        );
        github.save("ghp_SECRET1").await.unwrap();
        gitlab.save("glpat-SECRET2").await.unwrap();
        github.clear().await;

        let reloaded_github = SecureTokenStore::with_crypto(
            dir.join("code-review-github.bin"),
            "x",
            xor_crypto(true),
        );
        let reloaded_gitlab = SecureTokenStore::with_crypto(
            dir.join("code-review-gitlab.bin"),
            "x",
            xor_crypto(true),
        );
        assert_eq!(reloaded_github.load().await, None);
        assert_eq!(
            reloaded_gitlab.load().await.as_deref(),
            Some("glpat-SECRET2")
        );
        let stored = std::fs::read_to_string(dir.join("code-review-gitlab.bin")).unwrap();
        assert!(!stored.contains("SECRET2"));
        assert_eq!(
            BASE64.decode(&stored).unwrap(),
            b"glpat-SECRET2".map(|b| b ^ 0x5a)
        );
        assert_eq!(dir.names(), ["code-review-gitlab.bin"]);

        let saved = lines_with("Token saved");
        assert!(saved
            .iter()
            .any(|line| scope_for_target(&target_of(line)) == "main:code-review-token"));
        assert!(lines_with("SECRET").is_empty());
    }

    #[tokio::test]
    async fn round_trips_through_dpapi_and_writes_only_base64_of_the_blob() {
        let dir = TestDir::new("secure-token-dpapi");
        let store = SecureTokenStore::new(dir.join("code-review-github.bin"), "code-review-token");
        assert!(store.persistent());
        store.save("ghp_DPAPI_SECRET").await.unwrap();
        let text = std::fs::read_to_string(dir.join("code-review-github.bin")).unwrap();
        assert!(!text.contains("DPAPI_SECRET"));
        let blob = BASE64.decode(text.trim()).unwrap();
        assert_eq!(blob[..8], [0x01, 0x00, 0x00, 0x00, 0xD0, 0x8C, 0x9D, 0xDF]);
        let reloaded = SecureTokenStore::new(dir.join("code-review-github.bin"), "x");
        assert_eq!(reloaded.load().await.as_deref(), Some("ghp_DPAPI_SECRET"));
    }

    #[tokio::test]
    async fn legacy_electron_token_file_is_discarded_with_a_warning() {
        test_log::capture().expect("the test logger");
        let dir = TestDir::new("secure-token-legacy");
        let file = dir.join("code-review-gitlab.bin");
        // `safeStorage.encryptString` output: `v10`, a nonce and AES-GCM ciphertext.
        let mut legacy = b"v10".to_vec();
        legacy.extend((0u8..40).map(|n| n.wrapping_mul(37)));
        std::fs::write(&file, BASE64.encode(&legacy)).unwrap();
        let store = SecureTokenStore::new(file.clone(), "code-review-legacy-token");
        assert_eq!(store.load().await, None);
        assert!(!file.exists(), "the unreadable file is discarded");
        let warned = lines_with("Stored token could not be decrypted; discarding it");
        assert!(warned.iter().any(|line| line.starts_with("WARN ")
            && scope_for_target(&target_of(line)) == "main:code-review-legacy-token"
            && line.contains("error=")));
        // Later loads find nothing and log nothing more.
        assert_eq!(store.load().await, None);
    }

    #[tokio::test]
    async fn bad_base64_non_utf8_or_empty_tokens_are_discarded() {
        let dir = TestDir::new("secure-token-bad");
        let cases: [(&str, Vec<u8>); 3] = [
            ("not base64 !!", Vec::new()),
            ("", [0xff_u8, 0xfe].map(|b| b ^ 0x5a).to_vec()),
            ("", Vec::new()),
        ];
        for (index, (raw, encrypted)) in cases.into_iter().enumerate() {
            let file = dir.join(&format!("t{index}.bin"));
            let text = if raw.is_empty() {
                BASE64.encode(&encrypted)
            } else {
                raw.into()
            };
            std::fs::write(&file, text).unwrap();
            let store =
                SecureTokenStore::with_crypto(file.clone(), "code-review-token", xor_crypto(true));
            assert_eq!(store.load().await, None, "case {index}");
            assert!(!file.exists(), "case {index}");
        }
    }

    #[tokio::test]
    async fn surrounding_whitespace_is_tolerated_and_the_token_is_cached() {
        let dir = TestDir::new("secure-token-trim");
        let file = dir.join("t.bin");
        let encrypted: Vec<u8> = b"tok".iter().map(|b| b ^ 0x5a).collect();
        std::fs::write(&file, format!("  {}\r\n", BASE64.encode(encrypted))).unwrap();
        let store =
            SecureTokenStore::with_crypto(file.clone(), "code-review-token", xor_crypto(true));
        assert_eq!(store.load().await.as_deref(), Some("tok"));
        std::fs::remove_file(&file).unwrap();
        assert_eq!(store.load().await.as_deref(), Some("tok"));
    }

    #[tokio::test]
    async fn without_os_encryption_the_token_lives_in_memory_only() {
        test_log::capture().expect("the test logger");
        let dir = TestDir::new("secure-token-memory");
        let file = dir.join("t.bin");
        std::fs::write(&file, "c3RhbGU=").unwrap();
        let store = SecureTokenStore::with_crypto(
            file.clone(),
            "code-review-memory-token",
            xor_crypto(false),
        );
        assert!(!store.persistent());
        // Not available: the file is never read (nor deleted) by a load.
        assert_eq!(store.load().await, None);
        assert!(file.exists());
        store.save("MEMORY_SECRET").await.unwrap();
        assert!(
            !file.exists(),
            "a stale encrypted token must not load later"
        );
        assert_eq!(store.load().await.as_deref(), Some("MEMORY_SECRET"));
        let other = SecureTokenStore::with_crypto(file.clone(), "x", xor_crypto(false));
        assert_eq!(other.load().await, None);
        assert!(
            lines_with("OS encryption unavailable; the session will not survive a restart")
                .iter()
                .any(|line| scope_for_target(&target_of(line)) == "main:code-review-memory-token")
        );
        assert!(lines_with("MEMORY_SECRET").is_empty());
        store.clear().await;
        assert_eq!(store.load().await, None);
    }

    #[tokio::test]
    async fn a_read_failure_keeps_the_file() {
        test_log::capture().expect("the test logger");
        let dir = TestDir::new("secure-token-read");
        // A directory where the file should be: reading it fails, but it is not ours to delete.
        let file = dir.join("t.bin");
        std::fs::create_dir(&file).unwrap();
        let store =
            SecureTokenStore::with_crypto(file.clone(), "code-review-read-token", xor_crypto(true));
        assert_eq!(store.load().await, None);
        assert!(file.is_dir());
        assert!(lines_with("Could not read the token file")
            .iter()
            .any(|line| scope_for_target(&target_of(line)) == "main:code-review-read-token"));
    }

    #[tokio::test]
    async fn a_failed_write_is_an_error_and_clear_of_a_missing_file_is_quiet() {
        let dir = TestDir::new("secure-token-write");
        std::fs::write(dir.join("blocker"), "").unwrap();
        // The parent "directory" is a file: the atomic write fails.
        let store = SecureTokenStore::with_crypto(
            dir.join("blocker").join("t.bin"),
            "code-review-token",
            xor_crypto(true),
        );
        assert!(store.save("tok").await.is_err());
        let missing = SecureTokenStore::with_crypto(
            dir.join("none.bin"),
            "code-review-token",
            xor_crypto(true),
        );
        missing.clear().await;
        assert_eq!(missing.load().await, None);
    }

    #[tokio::test]
    async fn operations_run_in_call_order() {
        let dir = TestDir::new("secure-token-order");
        let file = dir.join("t.bin");
        let store =
            SecureTokenStore::with_crypto(file.clone(), "code-review-token", xor_crypto(true));
        let ((), saved) = tokio::join!(async { store.clear().await }, store.save("first"));
        saved.unwrap();
        assert!(file.exists());
        let (saved, ()) = tokio::join!(store.save("second"), store.clear());
        saved.unwrap();
        assert!(!file.exists());
        assert_eq!(store.load().await, None);
    }
}
