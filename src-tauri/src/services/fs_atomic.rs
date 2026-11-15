//! Atomic file writes (`src/main/services/fs-atomic.ts`).

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Unique sibling of `path`, so concurrent writers never share a temp file.
fn temp_path(path: &Path) -> PathBuf {
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut name = path.as_os_str().to_owned();
    name.push(format!(".{}.{n}.tmp", std::process::id()));
    PathBuf::from(name)
}

/// Writes to a temp file in the same directory, then renames it over the target. The temp
/// file is removed when the write or the rename fails.
pub async fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(dir) = path.parent().filter(|dir| !dir.as_os_str().is_empty()) {
        tokio::fs::create_dir_all(dir).await?;
    }
    let temp = temp_path(path);
    let result = async {
        tokio::fs::write(&temp, bytes).await?;
        tokio::fs::rename(&temp, path).await
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temp).await;
    }
    result
}
