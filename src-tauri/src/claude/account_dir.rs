//! The folder browser of «Otra carpeta…» in Control Center → Claude (`claude:pick-account-dir`):
//! the user picks the Claude Code config folder instead of pasting its path. The answer only
//! fills the page's text field; nothing is added until the user presses «Añadir».
//!
//! The dialog sits behind [`FolderPicker`], so tests never show one. The real one,
//! [`Win32FolderPicker`], is `SHBrowseForFolderW` (`BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE`)
//! owned by the Control Center window, started in the user's folder, on a dedicated COM STA
//! thread per pick exactly like the Gmail client-file picker (see
//! [`crate::gmail::client_file`] for why: the dialog is modal and may stay open for minutes).
//! `IFileOpenDialog` with `FOS_PICKFOLDERS` looks better but is a COM interface whose vtable
//! `windows-sys` does not give; the classic dialog is reachable with the features already
//! enabled and answers a plain path.
//!
//! Only error codes are logged, never the chosen path.
//!
//! Dev/E2E switch (ignored unless `ipc::dev_overrides_enabled()`): `NOTCH_CLAUDE_ACCOUNT_DIR=<path>`
//! answers that path without any dialog; `NOTCH_CLAUDE_ACCOUNT_DIR=` (empty) answers "cancelled".

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::gmail::client_file::{picker_override_from, PickerOverride};
use crate::ipc::BoxFuture;

/// The dev/E2E switch (see the module docs).
pub const ACCOUNT_DIR_ENV: &str = "NOTCH_CLAUDE_ACCOUNT_DIR";
const LOG_TARGET: &str = "claude";

/// A folder browser: one existing folder, or `None` when cancelled. Never blocks the caller's
/// thread.
pub trait FolderPicker: Send + Sync {
    fn pick_folder(&self) -> BoxFuture<'_, Option<PathBuf>>;
}

/// The dialog of the dev/E2E switch: answers its value, shows nothing.
pub struct FixedFolder(pub PickerOverride);

impl FolderPicker for FixedFolder {
    fn pick_folder(&self) -> BoxFuture<'_, Option<PathBuf>> {
        let answer = match &self.0 {
            PickerOverride::Path(path) => Some(path.clone()),
            PickerOverride::Cancel => None,
        };
        Box::pin(async move { answer })
    }
}

/// What the real dialog needs from the app.
pub struct FolderDialog {
    /// The owner window's HWND, 0 for none; must not block.
    pub owner: Arc<dyn Fn() -> isize + Send + Sync>,
    /// The dialog's title in the current language.
    pub title: Arc<dyn Fn() -> String + Send + Sync>,
    /// The folder the dialog starts in.
    pub start: Option<PathBuf>,
}

/// The app's dialog: the switch's [`FixedFolder`] when set (dev builds only), else
/// [`Win32FolderPicker`].
pub fn app_folder_picker(dialog: FolderDialog) -> Arc<dyn FolderPicker> {
    let switch = crate::ipc::dev_env_var_os(ACCOUNT_DIR_ENV);
    match picker_override_from(crate::ipc::dev_overrides_enabled(), switch.as_deref()) {
        Some(answer) => {
            log::info!(target: LOG_TARGET, "Claude account folder dialog replaced by {ACCOUNT_DIR_ENV}");
            Arc::new(FixedFolder(answer))
        }
        None => Arc::new(Win32FolderPicker {
            dialog: Arc::new(dialog),
            open: Arc::default(),
        }),
    }
}

/// `SHBrowseForFolderW` on a dedicated STA thread per pick. One dialog at a time: a pick while
/// one is open answers "cancelled" at once.
pub struct Win32FolderPicker {
    dialog: Arc<FolderDialog>,
    open: Arc<AtomicBool>,
}

impl FolderPicker for Win32FolderPicker {
    fn pick_folder(&self) -> BoxFuture<'_, Option<PathBuf>> {
        Box::pin(async move {
            let Some(flag) = crate::platform::dialog::claim(&self.open) else {
                log::info!(target: LOG_TARGET, "Claude account folder dialog already open");
                return None;
            };
            let owner = (self.dialog.owner)();
            let title = (self.dialog.title)();
            let start = self.dialog.start.clone();
            let (answer, chosen) = tokio::sync::oneshot::channel();
            let spawned = std::thread::Builder::new()
                .name("claude-account-dir-dialog".into())
                .spawn(move || {
                    let _flag = flag;
                    let _ = answer.send(browse_for_folder(owner, &title, start.as_deref()));
                });
            if spawned.is_err() {
                log::warn!(target: LOG_TARGET, "Claude account folder dialog unavailable error=spawn");
                return None;
            }
            chosen.await.ok().flatten()
        })
    }
}

/// `text` as a NUL-terminated UTF-16 string.
fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    text.encode_wide().chain(std::iter::once(0)).collect()
}

/// The path in a NUL-terminated UTF-16 buffer; `None` when it is empty.
fn path_from_wide(buffer: &[u16]) -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    let len = buffer
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(buffer.len());
    (len > 0).then(|| PathBuf::from(std::ffi::OsString::from_wide(&buffer[..len])))
}

/// Selects the start folder once the dialog exists (`lp_data` is its NUL-terminated path).
unsafe extern "system" fn on_initialized(
    hwnd: windows_sys::Win32::Foundation::HWND,
    message: u32,
    _lparam: windows_sys::Win32::Foundation::LPARAM,
    lp_data: windows_sys::Win32::Foundation::LPARAM,
) -> i32 {
    use windows_sys::Win32::UI::Shell::{BFFM_INITIALIZED, BFFM_SETSELECTIONW};
    use windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW;

    if message == BFFM_INITIALIZED && lp_data != 0 {
        // SAFETY: `lp_data` points at the caller's NUL-terminated buffer, which outlives the
        // dialog; `wParam` TRUE says `lParam` is a path.
        unsafe { SendMessageW(hwnd, BFFM_SETSELECTIONW, 1, lp_data) };
    }
    0
}

/// The modal dialog itself (blocking, on the calling thread). `None` on cancel, on a choice that
/// is not a file-system folder, or on failure.
///
/// Like the file dialog, it may leave the process's current folder elsewhere, so the folder is
/// saved before and restored after.
fn browse_for_folder(owner: isize, title: &str, start: Option<&Path>) -> Option<PathBuf> {
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{
        SHBrowseForFolderW, SHGetPathFromIDListEx, BIF_NEWDIALOGSTYLE, BIF_RETURNONLYFSDIRS,
        BROWSEINFOW, GPFIDL_DEFAULT,
    };

    // Long paths included (the API's own limit for a path).
    const PATH_CAPACITY: usize = 32_768;
    let owner = crate::platform::dialog::live_owner(owner);
    let title = wide(std::ffi::OsStr::new(title));
    let start = start.map(|start| wide(start.as_os_str()));
    let mut display = vec![0u16; 260];
    let com = crate::platform::dialog::ComApartment::enter();
    // SAFETY: all zeros is valid for every field (null pointers, no callback).
    let mut request: BROWSEINFOW = unsafe { std::mem::zeroed() };
    request.hwndOwner = owner;
    request.pszDisplayName = display.as_mut_ptr();
    request.lpszTitle = title.as_ptr();
    request.ulFlags = BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE;
    if let Some(start) = &start {
        request.lpfn = Some(on_initialized);
        request.lParam = start.as_ptr() as isize;
    }
    let saved_dir = std::env::current_dir().ok();
    // SAFETY: the struct is filled; `display`, `title` and `start` outlive the call.
    let item = unsafe { SHBrowseForFolderW(&request) };
    if let Some(dir) = saved_dir {
        if std::env::set_current_dir(dir).is_err() {
            log::warn!(target: LOG_TARGET, "Claude account folder dialog failed error=restore-current-dir");
        }
    }
    if item.is_null() {
        drop(com);
        return None;
    }
    let mut path = vec![0u16; PATH_CAPACITY];
    // SAFETY: `item` is the identifier list the dialog returned and `path` holds
    // `PATH_CAPACITY` units.
    let found = unsafe {
        SHGetPathFromIDListEx(
            item,
            path.as_mut_ptr(),
            PATH_CAPACITY as u32,
            GPFIDL_DEFAULT,
        )
    } != 0;
    // SAFETY: the dialog allocated `item` with the shell allocator and hands it over.
    unsafe { CoTaskMemFree(item as *const _) };
    drop(com);
    if !found {
        // A virtual folder (This PC, Network...): not a path.
        log::info!(target: LOG_TARGET, "Claude account folder dialog answered a virtual folder");
        return None;
    }
    path_from_wide(&path)
}

#[cfg(test)]
#[path = "account_dir_tests.rs"]
mod tests;
