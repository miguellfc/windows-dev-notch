//! The Google client file picker (port of `src/main/gmail/client-file.ts` and its wiring in
//! `src/main/index.ts`): the user picks the JSON Google gives for a "Desktop app" OAuth client;
//! `gmail:pick-client-file` answers its id and secret, or `null` when the dialog is cancelled.
//!
//! The file is checked against [`CLIENT_FILE_MAX_BYTES`] **before** it is read, read once
//! (lossy UTF-8, as Node's `readFile(path, 'utf8')`), parsed with
//! [`contract::gmail::parse_client_file`](crate::contract::gmail::parse_client_file) (an
//! `installed` client only) and never copied. Any failure is INVALID_INPUT "Not a Google desktop
//! client file", which never quotes the file; nothing about it (path, content, secret) is logged.
//!
//! The dialog sits behind [`FilePicker`], so tests never show one. The real one,
//! [`Win32FilePicker`], is `GetOpenFileNameW` owned by the Control Center window.
//!
//! **Thread:** the dialog is modal and runs its own message loop until the user closes it,
//! which may take minutes. It runs on a **dedicated thread per pick** (as Chromium runs
//! Electron's `showOpenDialog`), initialized as a COM single-threaded apartment, which the shell
//! namespace and its extensions in the Explorer-style dialog expect. Not the main thread: the
//! IPC handler cannot block it, and a nested modal loop there would re-enter the event loop. Not
//! a tokio worker: it would be blocked for the whole dialog. Not the blocking pool: a pooled
//! thread may already be in another COM apartment, and would be held for the whole dialog. The
//! owner HWND is read from [`NotchRuntime`](crate::notch::runtime::NotchRuntime)'s record,
//! written on the main thread when the Control Center is created, so no blocking window getter
//! runs off the main thread. A modal dialog disables its owner, even across threads, and
//! enables it again when it closes.
//!
//! Dev/E2E switch (ignored unless `ipc::dev_overrides_enabled()`):
//! `NOTCH_GMAIL_CLIENT_FILE=<path>` answers that path without any dialog (the size cap, the read
//! and the parse still run); `NOTCH_GMAIL_CLIENT_FILE=` (empty) answers "cancelled". Electron
//! had no such switch (its e2e typed the client in or wrote the settings); it exists so the
//! Tauri e2e can exercise the picker without a native dialog.

use std::ffi::OsStr;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub use crate::contract::gmail::parse_client_file;
use crate::contract::gmail::GmailClientFile;
use crate::ipc::{BoxFuture, ExposedError, IpcErrorCode};

/// Google's client JSON is under 1 KB; anything above this is not one.
pub const CLIENT_FILE_MAX_BYTES: u64 = 64 * 1024;
/// The only refusal, whatever went wrong: it never quotes the file.
pub const INVALID_CLIENT_FILE: &str = "Not a Google desktop client file";
/// The dev/E2E switch (see the module docs).
pub const CLIENT_FILE_ENV: &str = "NOTCH_GMAIL_CLIENT_FILE";

/// A filter of the open dialog (`{ name, extensions }`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FileFilter {
    pub name: &'static str,
    pub extensions: &'static [&'static str],
}

/// `filters: [{ name: 'JSON', extensions: ['json'] }]`.
pub const JSON_FILTER: FileFilter = FileFilter {
    name: "JSON",
    extensions: &["json"],
};

/// `showOpenDialog({ properties: ['openFile'], filters })`: one existing file, or `None` when
/// cancelled (`canceled` or no path). Never blocks the caller's thread.
pub trait FilePicker: Send + Sync {
    fn pick_file(&self, filter: FileFilter) -> BoxFuture<'_, Option<PathBuf>>;
}

/// `stat` and `readFile`. Both are blocking; the picker calls them on the blocking pool.
pub trait ClientFileSource: Send + Sync {
    /// The file's size in bytes.
    fn size(&self, path: &Path) -> io::Result<u64>;
    /// The whole file; an error once it holds more than [`CLIENT_FILE_MAX_BYTES`].
    fn read(&self, path: &Path) -> io::Result<Vec<u8>>;
}

/// The real files. `read` never takes more than the cap plus one byte, so a file that grew
/// after its size was checked is refused rather than read whole.
pub struct DiskFiles;

impl ClientFileSource for DiskFiles {
    fn size(&self, path: &Path) -> io::Result<u64> {
        Ok(std::fs::metadata(path)?.len())
    }

    fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        let mut bytes = Vec::new();
        std::fs::File::open(path)?
            .take(CLIENT_FILE_MAX_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > CLIENT_FILE_MAX_BYTES {
            return Err(io::Error::from(io::ErrorKind::FileTooLarge));
        }
        Ok(bytes)
    }
}

/// What `gmail:pick-client-file` calls (`pickClientFile`).
pub trait PickClientFile: Send + Sync {
    /// The credentials, `None` on cancel, INVALID_INPUT [`INVALID_CLIENT_FILE`] otherwise.
    fn pick_client_file(&self) -> BoxFuture<'_, Result<Option<GmailClientFile>, ExposedError>>;
}

/// `createClientFilePicker`.
pub struct ClientFilePicker {
    picker: Arc<dyn FilePicker>,
    files: Arc<dyn ClientFileSource>,
}

impl ClientFilePicker {
    pub fn new(picker: Arc<dyn FilePicker>, files: Arc<dyn ClientFileSource>) -> Self {
        Self { picker, files }
    }
}

fn invalid() -> ExposedError {
    ExposedError::new(IpcErrorCode::InvalidInput, INVALID_CLIENT_FILE)
}

/// The size check, the read and the parse, in that order (blocking).
fn read_client_file(
    files: &dyn ClientFileSource,
    path: &Path,
) -> Result<GmailClientFile, ExposedError> {
    if files.size(path).map_err(|_| invalid())? > CLIENT_FILE_MAX_BYTES {
        return Err(invalid());
    }
    let bytes = files.read(path).map_err(|_| invalid())?;
    let json: serde_json::Value =
        serde_json::from_str(&String::from_utf8_lossy(&bytes)).map_err(|_| invalid())?;
    parse_client_file(&json).ok_or_else(invalid)
}

impl PickClientFile for ClientFilePicker {
    fn pick_client_file(&self) -> BoxFuture<'_, Result<Option<GmailClientFile>, ExposedError>> {
        Box::pin(async move {
            let Some(path) = self.picker.pick_file(JSON_FILTER).await else {
                return Ok(None);
            };
            let files = Arc::clone(&self.files);
            tokio::task::spawn_blocking(move || read_client_file(files.as_ref(), &path))
                .await
                .map_err(|_| invalid())?
                .map(Some)
        })
    }
}

/// What the dev/E2E switch answers in place of the dialog.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PickerOverride {
    Path(PathBuf),
    Cancel,
}

/// [`CLIENT_FILE_ENV`] as read: only with dev overrides; empty means "cancelled".
pub fn picker_override_from(enabled: bool, raw: Option<&OsStr>) -> Option<PickerOverride> {
    let raw = raw.filter(|_| enabled)?;
    Some(if raw.is_empty() {
        PickerOverride::Cancel
    } else {
        PickerOverride::Path(PathBuf::from(raw))
    })
}

/// The dialog of the dev/E2E switch: answers its value, shows nothing.
pub struct FixedPicker(pub PickerOverride);

impl FilePicker for FixedPicker {
    fn pick_file(&self, _filter: FileFilter) -> BoxFuture<'_, Option<PathBuf>> {
        let answer = match &self.0 {
            PickerOverride::Path(path) => Some(path.clone()),
            PickerOverride::Cancel => None,
        };
        Box::pin(async move { answer })
    }
}

/// The app's dialog: the switch's [`FixedPicker`] when set (dev builds only), else
/// [`Win32FilePicker`] owned by the window `owner` names (0: none).
pub fn app_file_picker(owner: Arc<dyn Fn() -> isize + Send + Sync>) -> Arc<dyn FilePicker> {
    let switch = std::env::var_os(CLIENT_FILE_ENV);
    match picker_override_from(crate::ipc::dev_overrides_enabled(), switch.as_deref()) {
        Some(answer) => {
            log::info!(
                target: super::integration::LOG_TARGET,
                "Gmail client file dialog replaced by {CLIENT_FILE_ENV}"
            );
            Arc::new(FixedPicker(answer))
        }
        None => Arc::new(Win32FilePicker::new(owner)),
    }
}

/// `GetOpenFileNameW` on a dedicated STA thread per pick (see the module docs). One dialog at a
/// time: a pick while one is open answers "cancelled" at once.
pub struct Win32FilePicker {
    owner: Arc<dyn Fn() -> isize + Send + Sync>,
    open: Arc<std::sync::atomic::AtomicBool>,
}

impl Win32FilePicker {
    /// `owner` gives the owner window's HWND, 0 for none; it must not block.
    pub fn new(owner: Arc<dyn Fn() -> isize + Send + Sync>) -> Self {
        Self {
            owner,
            open: Arc::default(),
        }
    }
}

/// Clears the "dialog open" flag when the dialog thread ends, whatever happens on it.
struct OpenFlag(Arc<std::sync::atomic::AtomicBool>);

impl Drop for OpenFlag {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

impl FilePicker for Win32FilePicker {
    fn pick_file(&self, filter: FileFilter) -> BoxFuture<'_, Option<PathBuf>> {
        use std::sync::atomic::Ordering;
        Box::pin(async move {
            if self.open.swap(true, Ordering::SeqCst) {
                log::info!(target: super::integration::LOG_TARGET, "Gmail client file dialog already open");
                return None;
            }
            let flag = OpenFlag(Arc::clone(&self.open));
            let owner = (self.owner)();
            let (answer, chosen) = tokio::sync::oneshot::channel();
            let spawned = std::thread::Builder::new()
                .name("gmail-client-file-dialog".into())
                .spawn(move || {
                    let _flag = flag;
                    let _ = answer.send(open_file_dialog(owner, filter));
                });
            if spawned.is_err() {
                log::warn!(target: super::integration::LOG_TARGET, "Gmail client file dialog unavailable error=spawn");
                return None;
            }
            chosen.await.ok().flatten()
        })
    }
}

/// `"JSON (*.json)\0*.json\0\0"` as UTF-16.
fn filter_spec(filter: FileFilter) -> Vec<u16> {
    let patterns = filter
        .extensions
        .iter()
        .map(|extension| format!("*.{extension}"))
        .collect::<Vec<_>>()
        .join(";");
    format!("{} ({patterns})\0{patterns}\0\0", filter.name)
        .encode_utf16()
        .collect()
}

/// The modal dialog itself (blocking, on the calling thread). `None` on cancel or failure; a
/// failure logs only the common-dialog error code.
///
/// `GetOpenFileNameW` may change the process's current folder to the one the user browsed to
/// (`OFN_NOCHANGEDIR` only works for the save dialog), so the folder is saved before the
/// dialog and restored after it, whatever the outcome.
fn open_file_dialog(owner: isize, filter: FileFilter) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows_sys::Win32::UI::Controls::Dialogs::{
        CommDlgExtendedError, GetOpenFileNameW, OFN_EXPLORER, OFN_FILEMUSTEXIST, OFN_HIDEREADONLY,
        OFN_PATHMUSTEXIST, OPENFILENAMEW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::IsWindow;

    // Long paths included (the API's own limit for `nMaxFile`).
    const PATH_CAPACITY: usize = 32_768;
    let spec = filter_spec(filter);
    let mut file = vec![0u16; PATH_CAPACITY];
    let mut owner = owner as windows_sys::Win32::Foundation::HWND;
    // The Control Center may have closed since its handle was read: then no owner.
    // SAFETY: `IsWindow` accepts any value.
    if !owner.is_null() && unsafe { IsWindow(owner) } == 0 {
        owner = std::ptr::null_mut();
    }
    // SAFETY: the reserved pointer is null and the flags are valid `COINIT` values.
    let com = unsafe {
        CoInitializeEx(
            std::ptr::null(),
            (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
        )
    };
    // SAFETY: all zeros is valid for every field (null pointers, zero sizes, no hook).
    let mut request: OPENFILENAMEW = unsafe { std::mem::zeroed() };
    request.lStructSize = std::mem::size_of::<OPENFILENAMEW>() as u32;
    request.hwndOwner = owner;
    request.lpstrFilter = spec.as_ptr();
    request.nFilterIndex = 1;
    request.lpstrFile = file.as_mut_ptr();
    request.nMaxFile = PATH_CAPACITY as u32;
    // No hook or template: the modern Explorer dialog.
    request.Flags = OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_HIDEREADONLY;
    let saved_dir = std::env::current_dir().ok();
    // SAFETY: the struct is sized; `spec` and `file` outlive the call and `nMaxFile` is
    // `file`'s length.
    let picked = unsafe { GetOpenFileNameW(&mut request) } != 0;
    // SAFETY: no arguments; reads this thread's last common-dialog error.
    let error = if picked {
        0
    } else {
        unsafe { CommDlgExtendedError() }
    };
    if let Some(dir) = saved_dir {
        if std::env::set_current_dir(dir).is_err() {
            log::warn!(target: super::integration::LOG_TARGET, "Gmail client file dialog failed error=restore-current-dir");
        }
    }
    if com >= 0 {
        // SAFETY: balances the successful `CoInitializeEx` above, on the same thread.
        unsafe { CoUninitialize() };
    }
    if !picked {
        // 0: the user cancelled.
        if error != 0 {
            log::warn!(target: super::integration::LOG_TARGET, "Gmail client file dialog failed code={error:#x}");
        }
        return None;
    }
    let len = file
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(file.len());
    (len > 0).then(|| PathBuf::from(std::ffi::OsString::from_wide(&file[..len])))
}

#[cfg(test)]
#[path = "client_file_tests.rs"]
mod tests;
