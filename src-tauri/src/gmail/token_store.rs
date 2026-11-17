//! The Gmail refresh token store (0.1.0's `token-store.ts`): the shared DPAPI
//! [`SecureTokenStore`] on `<data>/gmail-token.bin`, logging under `main:gmail-token`. Only the
//! refresh token is stored; the access token lives in memory.

use std::path::Path;

use crate::services::secure_token_store::{SecureTokenStore, TokenCrypto};

pub const TOKEN_FILE: &str = "gmail-token.bin";
pub const TOKEN_LOG_SCOPE: &str = "gmail-token";

/// The production store in `data_dir` (DPAPI for the current Windows user).
pub fn token_store(data_dir: &Path) -> SecureTokenStore {
    SecureTokenStore::new(data_dir.join(TOKEN_FILE), TOKEN_LOG_SCOPE)
}

/// [`token_store`] with another encryption (tests).
pub fn token_store_with_crypto(data_dir: &Path, crypto: TokenCrypto) -> SecureTokenStore {
    SecureTokenStore::with_crypto(data_dir.join(TOKEN_FILE), TOKEN_LOG_SCOPE, crypto)
}

#[cfg(test)]
#[path = "token_store_tests.rs"]
mod tests;
