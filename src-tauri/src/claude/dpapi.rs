//! Windows DPAPI for the bridge token (`CryptProtectData`/`CryptUnprotectData`, current user,
//! no UI). Electron's `safeStorage` wraps the same per-user secret in an AES-GCM layer; its blobs
//! are not readable here, which the bridge config treats like any undecryptable file (start over).

use std::io;
use std::ptr;

use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

/// Encrypts `plain` for the current Windows user.
pub fn protect(plain: &[u8]) -> io::Result<Vec<u8>> {
    let input = blob_of(plain)?;
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    // SAFETY: `input` points into `plain`, which outlives the call; DPAPI only reads it. The
    // output buffer is allocated by DPAPI and released by `take_output`.
    let ok = unsafe {
        CryptProtectData(
            &input,
            ptr::null(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(take_output(output))
}

/// Decrypts a blob made by [`protect`] for the current Windows user.
pub fn unprotect(blob: &[u8]) -> io::Result<Vec<u8>> {
    let input = blob_of(blob)?;
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: ptr::null_mut(),
    };
    // SAFETY: as in `protect`; no description is requested back.
    let ok = unsafe {
        CryptUnprotectData(
            &input,
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(take_output(output))
}

/// `safeStorage.isEncryptionAvailable()`: a protect/unprotect round trip works.
pub fn available() -> bool {
    const PROBE: &[u8] = b"developer-notch";
    protect(PROBE)
        .and_then(|blob| unprotect(&blob))
        .is_ok_and(|plain| plain == PROBE)
}

fn blob_of(bytes: &[u8]) -> io::Result<CRYPT_INTEGER_BLOB> {
    Ok(CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "too large for DPAPI"))?,
        // DPAPI never writes through the input blob.
        pbData: bytes.as_ptr().cast_mut(),
    })
}

/// Copies DPAPI's output and frees it with `LocalFree`.
fn take_output(output: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    if output.pbData.is_null() {
        return Vec::new();
    }
    // SAFETY: on success DPAPI returns `cbData` readable bytes at `pbData`, allocated with
    // `LocalAlloc`; they are copied before the single `LocalFree`.
    unsafe {
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData.cast());
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_never_contains_the_plain_text() {
        let plain = b"0123456789abcdef-plain-token";
        let blob = protect(plain).unwrap();
        assert!(!blob.windows(plain.len()).any(|window| window == plain));
        assert_eq!(unprotect(&blob).unwrap(), plain);
    }

    #[test]
    fn round_trips_empty_input() {
        let blob = protect(b"").unwrap();
        assert_eq!(unprotect(&blob).unwrap(), b"");
    }

    #[test]
    fn rejects_a_blob_it_did_not_make() {
        assert!(unprotect(b"v10 not a dpapi blob").is_err());
        let mut blob = protect(b"token").unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0xff;
        assert!(unprotect(&blob).is_err());
    }

    #[test]
    fn is_available_for_the_current_user() {
        assert!(available());
    }
}
