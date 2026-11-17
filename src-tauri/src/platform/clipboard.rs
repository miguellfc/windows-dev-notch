//! The Windows clipboard, for `notes:copy` (Electron's `clipboard.writeText`) and the E2E check
//! that reads it back. Plain Win32: `OpenClipboard` / `EmptyClipboard` / `SetClipboardData
//! (CF_UNICODETEXT)` / `CloseClipboard`. The clipboard is locked per thread, so open and close
//! always happen on the calling thread; callers run this off the main thread (it may wait up to
//! `OPEN_ATTEMPTS * OPEN_RETRY_MS` while another app holds the clipboard).

use std::time::Duration;

use windows_sys::Win32::Foundation::{GlobalFree, HANDLE};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::System::Ole::CF_UNICODETEXT;

/// How many times opening is tried while another app holds the clipboard.
pub const OPEN_ATTEMPTS: u32 = 5;
/// The wait between two attempts.
pub const OPEN_RETRY_MS: u64 = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClipboardError {
    /// Another app kept the clipboard open through every attempt.
    Busy,
    /// Windows refused the data (out of memory, `SetClipboardData` failed...).
    Failed,
}

impl std::fmt::Display for ClipboardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Busy => f.write_str("clipboard busy"),
            Self::Failed => f.write_str("clipboard write failed"),
        }
    }
}

impl std::error::Error for ClipboardError {}

/// The clipboard opened by this thread; closed when dropped.
struct OpenClipboardGuard(());

impl Drop for OpenClipboardGuard {
    fn drop(&mut self) {
        // SAFETY: this thread opened the clipboard (the guard exists only after a successful
        // `OpenClipboard`), so closing it here is balanced.
        unsafe {
            CloseClipboard();
        }
    }
}

/// Opens the clipboard for this thread, retrying while another app holds it.
fn open() -> Result<OpenClipboardGuard, ClipboardError> {
    for attempt in 0..OPEN_ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(Duration::from_millis(OPEN_RETRY_MS));
        }
        // SAFETY: a null owner ties the open clipboard to this thread; no pointer is passed.
        if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
            return Ok(OpenClipboardGuard(()));
        }
    }
    Err(ClipboardError::Busy)
}

/// Replaces the clipboard content with `text` (as `CF_UNICODETEXT`).
pub fn write_text(text: &str) -> Result<(), ClipboardError> {
    let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = wide.len() * std::mem::size_of::<u16>();
    let _open = open()?;
    // SAFETY: the clipboard is open on this thread (`_open`). The global block is allocated with
    // room for `wide` (NUL included), locked only while copying into it, and either handed to
    // the clipboard (which then owns it) or freed on every failure path.
    unsafe {
        // Opened with a null owner, `EmptyClipboard` leaves the clipboard with no owner window;
        // `SetClipboardData` still accepts CF_UNICODETEXT (data rendered now, nothing delayed),
        // which is all this needs, as with any ownerless writer.
        if EmptyClipboard() == 0 {
            return Err(ClipboardError::Failed);
        }
        let memory = GlobalAlloc(GMEM_MOVEABLE, bytes);
        if memory.is_null() {
            return Err(ClipboardError::Failed);
        }
        let target = GlobalLock(memory).cast::<u16>();
        if target.is_null() {
            GlobalFree(memory);
            return Err(ClipboardError::Failed);
        }
        std::ptr::copy_nonoverlapping(wide.as_ptr(), target, wide.len());
        GlobalUnlock(memory);
        if SetClipboardData(u32::from(CF_UNICODETEXT), memory as HANDLE).is_null() {
            GlobalFree(memory);
            return Err(ClipboardError::Failed);
        }
    }
    Ok(())
}

/// The clipboard text, `None` when it holds no text. E2E and tests only.
#[cfg(any(test, feature = "e2e"))]
pub fn read_text() -> Result<Option<String>, ClipboardError> {
    use windows_sys::Win32::System::DataExchange::GetClipboardData;

    let _open = open()?;
    // SAFETY: the clipboard is open on this thread; the handle it returns stays owned by the
    // clipboard and is only read while locked, within its size and up to its NUL terminator.
    unsafe {
        let handle = GetClipboardData(u32::from(CF_UNICODETEXT));
        if handle.is_null() {
            return Ok(None);
        }
        let source = GlobalLock(handle).cast::<u16>();
        if source.is_null() {
            return Err(ClipboardError::Failed);
        }
        // Bounded by the block size in case another app stored text without a terminator.
        let capacity = windows_sys::Win32::System::Memory::GlobalSize(handle) / 2;
        let mut length = 0usize;
        while length < capacity && *source.add(length) != 0 {
            length += 1;
        }
        let text = String::from_utf16_lossy(std::slice::from_raw_parts(source, length));
        GlobalUnlock(handle);
        Ok(Some(text))
    }
}

/// The clipboard held open by a hidden window of the calling thread, as another app would hold
/// it (an ownerless open by another thread of this process does not block [`write_text`]).
/// Nothing is written; closed and the window destroyed when dropped.
#[cfg(test)]
pub(crate) struct HeldClipboard(windows_sys::Win32::Foundation::HWND);

#[cfg(test)]
impl HeldClipboard {
    /// `None` when another app keeps the clipboard open for the whole second.
    pub(crate) fn take() -> Option<Self> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, DestroyWindow, HWND_MESSAGE,
        };
        let class: Vec<u16> = "STATIC".encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: a message-only window of the system STATIC class, with a NUL-terminated class
        // name that outlives the call; it is destroyed on every path below or in `drop`.
        unsafe {
            let window = CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            );
            if window.is_null() {
                return None;
            }
            for _ in 0..50 {
                if OpenClipboard(window) != 0 {
                    return Some(Self(window));
                }
                std::thread::sleep(Duration::from_millis(OPEN_RETRY_MS));
            }
            DestroyWindow(window);
            None
        }
    }
}

#[cfg(test)]
impl Drop for HeldClipboard {
    fn drop(&mut self) {
        // SAFETY: this thread opened the clipboard with this window, which it created.
        unsafe {
            CloseClipboard();
            windows_sys::Win32::UI::WindowsAndMessaging::DestroyWindow(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opening_reports_busy_while_another_window_holds_the_clipboard() {
        let held = HeldClipboard::take().expect("could not open the clipboard for the test");
        let started = std::time::Instant::now();
        // Only `open` (the first step of `write_text`): the test can never change the user's
        // clipboard, even if the hold did not block it.
        let result = std::thread::spawn(|| open().map(drop)).join().unwrap();
        let waited = started.elapsed();
        drop(held);
        assert_eq!(result, Err(ClipboardError::Busy));
        // Five attempts, 20 ms apart.
        assert!(
            waited >= Duration::from_millis(4 * OPEN_RETRY_MS),
            "{waited:?}"
        );
    }
}
