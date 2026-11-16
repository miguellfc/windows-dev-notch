//! `claude-bridge.json` (port of `src/main/claude/bridge-config.ts`): the bridge's port and token.
//!
//! Format: `{ "version": 1, "port": <0..=65535>, "token": "<base64 of the DPAPI blob>" }`,
//! pretty JSON (2 spaces) plus `\n`. A missing, corrupt or undecryptable file is silently replaced
//! by a new config (new random port and token), as in Electron.

use std::fmt::Write as _;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine as _;
use serde_json::{json, Value};

use super::dpapi;

const BASE64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// New bridges listen on a random port of the dynamic range instead of a fixed one, so another
/// local account cannot predict it and squat it before us (Claude's settings.json, which holds the
/// port, lives in the user profile and is not readable by other accounts).
pub const DYNAMIC_PORT_MIN: u16 = 49_152;
pub const DYNAMIC_PORT_MAX: u16 = 65_535;

/// The bridge's port and plain token (never logged, never sent to a renderer).
#[derive(Clone, PartialEq, Eq)]
pub struct BridgeConfig {
    pub port: u16,
    pub token: String,
}

/// Masks the token, so a `{:?}` in a log or a failed assertion never prints it.
impl std::fmt::Debug for BridgeConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BridgeConfig")
            .field("port", &self.port)
            .field("token", &"••••••")
            .finish()
    }
}

type Encrypt = dyn Fn(&str) -> io::Result<Vec<u8>> + Send + Sync;
type Decrypt = dyn Fn(&[u8]) -> io::Result<String> + Send + Sync;
type RandomToken = dyn Fn() -> io::Result<String> + Send + Sync;
type RandomPort = dyn Fn() -> io::Result<u16> + Send + Sync;

/// `BridgeConfigDeps`: the file and the injected crypto/RNG ([`BridgeConfigDeps::new`] in
/// production: DPAPI and the OS RNG).
#[derive(Clone)]
pub struct BridgeConfigDeps {
    pub file: PathBuf,
    pub encrypt: Arc<Encrypt>,
    pub decrypt: Arc<Decrypt>,
    /// Hex of 32 random bytes.
    pub random_token: Arc<RandomToken>,
    /// A port in `DYNAMIC_PORT_MIN..=DYNAMIC_PORT_MAX`.
    pub random_port: Arc<RandomPort>,
}

impl BridgeConfigDeps {
    /// DPAPI for the token and the OS RNG for new ports and tokens.
    pub fn new(file: PathBuf) -> Self {
        Self {
            file,
            encrypt: Arc::new(|plain| dpapi::protect(plain.as_bytes())),
            decrypt: Arc::new(|blob| {
                String::from_utf8(dpapi::unprotect(blob)?)
                    .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
            }),
            random_token: Arc::new(random_token),
            random_port: Arc::new(random_dynamic_port),
        }
    }
}

fn os_random(dest: &mut [u8]) -> io::Result<()> {
    getrandom::fill(dest).map_err(|error| io::Error::other(error.to_string()))
}

/// `randomDynamicPort`: uniform in `DYNAMIC_PORT_MIN..=DYNAMIC_PORT_MAX`.
pub fn random_dynamic_port() -> io::Result<u16> {
    // The range holds 16 384 ports, a power of two: the remainder is exactly uniform.
    const SPAN: u32 = (DYNAMIC_PORT_MAX - DYNAMIC_PORT_MIN) as u32 + 1;
    let mut bytes = [0u8; 4];
    os_random(&mut bytes)?;
    let offset = u32::from_le_bytes(bytes) % SPAN;
    Ok(DYNAMIC_PORT_MIN + offset as u16)
}

/// Hex (lowercase) of 32 random bytes.
pub fn random_token() -> io::Result<String> {
    let mut bytes = [0u8; 32];
    os_random(&mut bytes)?;
    Ok(bytes
        .iter()
        .fold(String::with_capacity(64), |mut hex, byte| {
            let _ = write!(hex, "{byte:02x}");
            hex
        }))
}

/// `isPort`: an integral JSON number in `0..=65535` (`50000.0` counts, as in JS).
fn as_port(value: &Value) -> Option<u16> {
    let number = value.as_f64()?;
    (number.fract() == 0.0 && (0.0..=65_535.0).contains(&number)).then_some(number as u16)
}

/// The stored config, or `None` when the file is missing, corrupt or not decryptable (another
/// Windows user or machine): the caller starts over.
async fn read_stored(deps: &BridgeConfigDeps) -> Option<BridgeConfig> {
    let bytes = tokio::fs::read(&deps.file).await.ok()?;
    // `readFile(file, 'utf8')` replaces invalid bytes instead of failing.
    let raw: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()?;
    let raw = raw.as_object()?;
    if raw.get("version").and_then(Value::as_f64) != Some(1.0) {
        return None;
    }
    let port = raw.get("port").and_then(as_port)?;
    let token = raw
        .get("token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())?;
    // Deviation: Node's base64 decoder skips invalid characters; ours refuses them (a file we
    // wrote is always valid base64), which also starts over.
    let blob = BASE64.decode(token).ok()?;
    let plain = (deps.decrypt)(&blob).ok()?;
    (!plain.is_empty()).then_some(BridgeConfig { port, token: plain })
}

/// Writes `<file>.tmp` (a fixed name, as in Electron) and renames it over the file; the temp
/// file is removed when either step fails.
async fn write(deps: &BridgeConfigDeps, config: &BridgeConfig) -> io::Result<()> {
    let mut temp = deps.file.as_os_str().to_owned();
    temp.push(".tmp");
    let temp = PathBuf::from(temp);
    let token = BASE64.encode((deps.encrypt)(&config.token)?);
    let body = json!({ "version": 1, "port": config.port, "token": token });
    let mut text = serde_json::to_string_pretty(&body).map_err(io::Error::other)?;
    text.push('\n');
    if let Some(dir) = deps.file.parent().filter(|dir| !dir.as_os_str().is_empty()) {
        tokio::fs::create_dir_all(dir).await?;
    }
    let result = async {
        tokio::fs::write(&temp, text).await?;
        tokio::fs::rename(&temp, &deps.file).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temp).await;
    }
    result
}

/// `loadBridgeConfig`: reads the file; creates it (new port and token) when missing, corrupt or
/// not decryptable.
pub async fn load_with(deps: &BridgeConfigDeps) -> io::Result<BridgeConfig> {
    if let Some(existing) = read_stored(deps).await {
        return Ok(existing);
    }
    let created = BridgeConfig {
        port: (deps.random_port)()?,
        token: (deps.random_token)()?,
    };
    write(deps, &created).await?;
    Ok(created)
}

/// `rotateToken`: a new token, keeping the stored port.
pub async fn rotate_token_with(deps: &BridgeConfigDeps) -> io::Result<BridgeConfig> {
    let existing = read_stored(deps).await;
    let port = match existing {
        Some(existing) => existing.port,
        None => (deps.random_port)()?,
    };
    let next = BridgeConfig {
        port,
        token: (deps.random_token)()?,
    };
    write(deps, &next).await?;
    Ok(next)
}

/// `rotatePort`: another random port (e.g. ours was taken), keeping the token.
pub async fn rotate_port_with(deps: &BridgeConfigDeps) -> io::Result<BridgeConfig> {
    let existing = read_stored(deps).await;
    let mut port = (deps.random_port)()?;
    // A handful of draws is plenty: the range has 16 384 ports.
    for _ in 0..8 {
        if Some(port) != existing.as_ref().map(|existing| existing.port) {
            break;
        }
        port = (deps.random_port)()?;
    }
    let token = match existing {
        Some(existing) => existing.token,
        None => (deps.random_token)()?,
    };
    let next = BridgeConfig { port, token };
    write(deps, &next).await?;
    Ok(next)
}

/// [`load_with`] with DPAPI and the OS RNG.
pub async fn load(file: &Path) -> io::Result<BridgeConfig> {
    load_with(&BridgeConfigDeps::new(file.to_path_buf())).await
}

/// [`rotate_token_with`] with DPAPI and the OS RNG.
pub async fn rotate_token(file: &Path) -> io::Result<BridgeConfig> {
    rotate_token_with(&BridgeConfigDeps::new(file.to_path_buf())).await
}

/// [`rotate_port_with`] with DPAPI and the OS RNG.
pub async fn rotate_port(file: &Path) -> io::Result<BridgeConfig> {
    rotate_port_with(&BridgeConfigDeps::new(file.to_path_buf())).await
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use serde_json::{json, Value};

    use super::*;
    use crate::services::test_dir::TestDir;

    // Fake "safeStorage": reversible, but the output never contains the plain text.
    fn xor(bytes: &[u8]) -> Vec<u8> {
        bytes.iter().map(|byte| byte ^ 0x5a).collect()
    }

    fn fake_decrypt(blob: &[u8]) -> String {
        String::from_utf8(xor(blob)).unwrap()
    }

    struct Fx {
        dir: TestDir,
        counter: Arc<AtomicUsize>,
        // Injected RNG: each call takes the next port from the list (60 000 when empty).
        ports: Arc<Mutex<VecDeque<u16>>>,
    }

    impl Fx {
        fn new() -> Self {
            Self {
                dir: TestDir::new("bridge-config"),
                counter: Arc::new(AtomicUsize::new(0)),
                ports: Arc::new(Mutex::new([51_234, 62_001, 62_001, 55_555].into())),
            }
        }

        fn file(&self) -> PathBuf {
            self.dir.join("claude-bridge.json")
        }

        fn counter(&self) -> usize {
            self.counter.load(Ordering::SeqCst)
        }

        fn set_ports(&self, ports: &[u16]) {
            *self.ports.lock().unwrap() = ports.iter().copied().collect();
        }

        fn deps(&self) -> BridgeConfigDeps {
            let counter = self.counter.clone();
            let ports = self.ports.clone();
            BridgeConfigDeps {
                file: self.file(),
                encrypt: Arc::new(|plain| Ok(xor(plain.as_bytes()))),
                decrypt: Arc::new(|blob| Ok(fake_decrypt(blob))),
                random_token: Arc::new(move || {
                    Ok(format!(
                        "token-{}",
                        counter.fetch_add(1, Ordering::SeqCst) + 1
                    ))
                }),
                random_port: Arc::new(move || {
                    Ok(ports.lock().unwrap().pop_front().unwrap_or(60_000))
                }),
            }
        }

        fn stored(&self) -> Value {
            serde_json::from_str(&std::fs::read_to_string(self.file()).unwrap()).unwrap()
        }
    }

    fn config(port: u16, token: &str) -> BridgeConfig {
        BridgeConfig {
            port,
            token: token.into(),
        }
    }

    #[tokio::test]
    async fn creates_the_file_with_a_random_dynamic_port_and_an_encrypted_token() {
        let fx = Fx::new();
        let created = load_with(&fx.deps()).await.unwrap();
        assert_eq!(created, config(51_234, "token-1"));
        let text = std::fs::read_to_string(fx.file()).unwrap();
        assert!(!text.contains("token-1"));
        let stored = fx.stored();
        assert_eq!(stored["version"], json!(1));
        assert_eq!(stored["port"], json!(51_234));
        let blob = BASE64.decode(stored["token"].as_str().unwrap()).unwrap();
        assert_eq!(fake_decrypt(&blob), "token-1");
        // Pretty JSON with a trailing newline, keys in the TS order; no temp file left behind.
        let expected = format!(
            "{{\n  \"version\": 1,\n  \"port\": 51234,\n  \"token\": \"{}\"\n}}\n",
            stored["token"].as_str().unwrap()
        );
        assert_eq!(text, expected);
        assert_eq!(fx.dir.names(), ["claude-bridge.json"]);
    }

    #[tokio::test]
    async fn returns_the_same_token_and_port_across_loads() {
        let fx = Fx::new();
        let first = load_with(&fx.deps()).await.unwrap();
        let second = load_with(&fx.deps()).await.unwrap();
        assert_eq!(second, first);
        assert_eq!(fx.counter(), 1);
    }

    #[tokio::test]
    async fn keeps_a_custom_port_stored_in_the_file() {
        let fx = Fx::new();
        load_with(&fx.deps()).await.unwrap();
        let mut stored = fx.stored();
        stored["port"] = json!(48123);
        std::fs::write(fx.file(), serde_json::to_string(&stored).unwrap()).unwrap();
        assert_eq!(load_with(&fx.deps()).await.unwrap().port, 48123);
    }

    #[tokio::test]
    async fn regenerates_the_token_when_the_file_is_corrupt() {
        let fx = Fx::new();
        std::fs::write(fx.file(), "{not json").unwrap();
        let loaded = load_with(&fx.deps()).await.unwrap();
        assert_eq!(loaded.token, "token-1");
        let stored = fx.stored();
        assert_eq!(stored["version"], json!(1));
        assert_eq!(stored["port"], json!(51_234));
    }

    #[tokio::test]
    async fn regenerates_the_token_when_it_cannot_be_decrypted() {
        let fx = Fx::new();
        load_with(&fx.deps()).await.unwrap();
        let failing = BridgeConfigDeps {
            decrypt: Arc::new(|_| Err(io::Error::other("cannot decrypt"))),
            ..fx.deps()
        };
        let loaded = load_with(&failing).await.unwrap();
        assert_eq!(loaded.token, "token-2");
        assert_eq!(
            load_with(&fx.deps()).await.unwrap(),
            config(62_001, "token-2")
        );
    }

    #[tokio::test]
    async fn rotate_token_changes_and_persists_the_token_keeping_the_port() {
        let fx = Fx::new();
        let before = load_with(&fx.deps()).await.unwrap();
        let rotated = rotate_token_with(&fx.deps()).await.unwrap();
        assert_ne!(rotated.token, before.token);
        assert_eq!(rotated.port, before.port);
        assert_eq!(load_with(&fx.deps()).await.unwrap(), rotated);
    }

    #[tokio::test]
    async fn rotate_port_picks_a_different_random_port_keeps_the_token_and_persists_it() {
        let fx = Fx::new();
        let before = load_with(&fx.deps()).await.unwrap();
        // The RNG first returns the current port again: it must be skipped.
        fx.set_ports(&[before.port, 62_001]);
        let rotated = rotate_port_with(&fx.deps()).await.unwrap();
        assert_eq!(rotated, config(62_001, &before.token));
        assert_eq!(load_with(&fx.deps()).await.unwrap(), rotated);
    }

    #[test]
    fn random_dynamic_port_stays_inside_49152_65535() {
        assert_eq!(DYNAMIC_PORT_MIN, 49_152);
        assert_eq!(DYNAMIC_PORT_MAX, 65_535);
        for _ in 0..2_000 {
            let port = random_dynamic_port().unwrap();
            assert!((DYNAMIC_PORT_MIN..=DYNAMIC_PORT_MAX).contains(&port));
        }
    }

    // Beyond the TS cases.

    #[test]
    fn random_token_is_64_lowercase_hex_characters_and_differs_each_time() {
        let first = random_token().unwrap();
        assert_eq!(first.len(), 64);
        assert!(first
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
        assert_ne!(random_token().unwrap(), first);
    }

    #[tokio::test]
    async fn starts_over_on_a_wrong_version_port_or_token() {
        for stored in [
            json!({ "version": 2, "port": 50_000, "token": "AAAA" }),
            json!({ "version": 1, "port": 65_536, "token": "AAAA" }),
            json!({ "version": 1, "port": 50_000.5, "token": "AAAA" }),
            json!({ "version": 1, "port": -1, "token": "AAAA" }),
            json!({ "version": 1, "port": "50000", "token": "AAAA" }),
            json!({ "version": 1, "port": 50_000, "token": "" }),
            json!({ "version": 1, "port": 50_000, "token": 7 }),
            json!({ "version": 1, "port": 50_000, "token": "not base64!" }),
            json!([1, 50_000]),
            json!(null),
        ] {
            let fx = Fx::new();
            std::fs::write(fx.file(), stored.to_string()).unwrap();
            assert_eq!(
                load_with(&fx.deps()).await.unwrap(),
                config(51_234, "token-1"),
                "{stored}"
            );
        }
    }

    #[tokio::test]
    async fn starts_over_when_the_token_decrypts_to_an_empty_string() {
        let fx = Fx::new();
        let deps = BridgeConfigDeps {
            decrypt: Arc::new(|_| Ok(String::new())),
            ..fx.deps()
        };
        let stored = json!({ "version": 1, "port": 50_000, "token": "AAAA" });
        std::fs::write(fx.file(), stored.to_string()).unwrap();
        assert_eq!(load_with(&deps).await.unwrap(), config(51_234, "token-1"));
    }

    #[tokio::test]
    async fn accepts_integral_doubles_and_extra_keys() {
        let fx = Fx::new();
        let token = BASE64.encode(xor(b"kept"));
        std::fs::write(
            fx.file(),
            json!({ "version": 1.0, "port": 50_000.0, "token": token, "extra": true }).to_string(),
        )
        .unwrap();
        assert_eq!(load_with(&fx.deps()).await.unwrap(), config(50_000, "kept"));
    }

    #[tokio::test]
    async fn rotations_start_from_new_values_when_the_file_is_unreadable() {
        let fx = Fx::new();
        let rotated = rotate_token_with(&fx.deps()).await.unwrap();
        assert_eq!(rotated, config(51_234, "token-1"));
        std::fs::write(fx.file(), "{oops").unwrap();
        let moved = rotate_port_with(&fx.deps()).await.unwrap();
        assert_eq!(moved, config(62_001, "token-2"));
    }

    #[tokio::test]
    async fn creates_the_directory_and_leaves_no_temp_file_when_the_write_fails() {
        let fx = Fx::new();
        let nested = BridgeConfigDeps {
            file: fx.dir.join("a").join("b").join("claude-bridge.json"),
            ..fx.deps()
        };
        load_with(&nested).await.unwrap();
        assert!(nested.file.exists());

        // The target is a directory: the rename fails and the temp file is removed.
        let blocked = BridgeConfigDeps {
            file: fx.dir.join("blocked"),
            ..fx.deps()
        };
        std::fs::create_dir_all(blocked.file.join("inside")).unwrap();
        assert!(load_with(&blocked).await.is_err());
        assert!(!fx.dir.join("blocked.tmp").exists());
    }

    #[test]
    fn debug_masks_the_token() {
        let shown = format!("{:?}", config(50_000, "plain-token-value"));
        assert!(!shown.contains("plain-token-value"), "{shown}");
        assert!(
            shown.contains("50000") && shown.contains("••••••"),
            "{shown}"
        );
    }

    #[tokio::test]
    async fn production_deps_round_trip_through_dpapi() {
        let fx = Fx::new();
        let file = fx.file();
        let created = load(&file).await.unwrap();
        assert!((DYNAMIC_PORT_MIN..=DYNAMIC_PORT_MAX).contains(&created.port));
        assert_eq!(created.token.len(), 64);
        assert!(!std::fs::read_to_string(&file)
            .unwrap()
            .contains(&created.token));
        assert_eq!(load(&file).await.unwrap(), created);
        let rotated = rotate_token(&file).await.unwrap();
        assert_eq!(rotated.port, created.port);
        assert_ne!(rotated.token, created.token);
        let moved = rotate_port(&file).await.unwrap();
        assert_eq!(moved.token, rotated.token);
        assert_eq!(load(&file).await.unwrap(), moved);
    }
}
