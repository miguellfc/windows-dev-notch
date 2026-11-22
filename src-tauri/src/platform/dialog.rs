//! What the native modal dialogs have in common (the Gmail client-file picker and the Claude
//! account-folder picker): the owner window, the COM apartment of the dialog thread and the
//! "one dialog at a time" flag. Each dialog runs on a dedicated thread per pick; see
//! [`crate::gmail::client_file`] for why.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use windows_sys::Win32::Foundation::HWND;

/// The owner window of a dialog: `owner` (a handle read earlier, 0 for none) while it is still a
/// window, else null. The Control Center may have closed since its handle was read.
pub fn live_owner(owner: isize) -> HWND {
    use windows_sys::Win32::UI::WindowsAndMessaging::IsWindow;

    let owner = owner as HWND;
    // SAFETY: `IsWindow` accepts any value.
    if !owner.is_null() && unsafe { IsWindow(owner) } == 0 {
        return std::ptr::null_mut();
    }
    owner
}

/// This thread as a COM single-threaded apartment, which the shell namespace and its extensions
/// in the dialogs expect; leaves it when dropped.
pub struct ComApartment {
    entered: bool,
}

impl ComApartment {
    pub fn enter() -> Self {
        use windows_sys::Win32::System::Com::{
            CoInitializeEx, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
        };

        // SAFETY: the reserved pointer is null and the flags are valid `COINIT` values.
        let result = unsafe {
            CoInitializeEx(
                std::ptr::null(),
                (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32,
            )
        };
        Self {
            entered: result >= 0,
        }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.entered {
            // SAFETY: balances the successful `CoInitializeEx` in `enter`, on the same thread.
            unsafe { windows_sys::Win32::System::Com::CoUninitialize() };
        }
    }
}

/// Claims the "dialog open" flag, or `None` when a dialog is already open.
pub fn claim(flag: &Arc<AtomicBool>) -> Option<OpenFlag> {
    (!flag.swap(true, Ordering::SeqCst)).then(|| OpenFlag(Arc::clone(flag)))
}

/// Clears the "dialog open" flag when the dialog thread ends, whatever happens on it.
pub struct OpenFlag(Arc<AtomicBool>);

impl Drop for OpenFlag {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
