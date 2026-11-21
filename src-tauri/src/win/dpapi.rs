//! DPAPI: data only this Windows account, on this machine, can decrypt. The
//! Windows stand-in for the macOS Keychain's generic passwords.
//! Used by the Windows secret store in `keychain.rs`.
use std::io;

use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

fn blob(bytes: &[u8]) -> io::Result<CRYPT_INTEGER_BLOB> {
    Ok(CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(bytes.len()).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "secret too large"))?,
        pbData: bytes.as_ptr() as *mut u8,
    })
}

/// Take ownership of an output blob DPAPI allocated with LocalAlloc.
fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    if out.pbData.is_null() {
        return Vec::new();
    }
    // SAFETY: DPAPI returned `cbData` bytes at `pbData`.
    let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
    // SAFETY: allocated by DPAPI with LocalAlloc; freed once.
    unsafe { LocalFree(out.pbData.cast()) };
    bytes
}

/// Encrypt `secret` for this user. `entropy` binds the result to its purpose:
/// it must be given again to decrypt.
pub(crate) fn protect(secret: &[u8], entropy: &[u8]) -> io::Result<Vec<u8>> {
    let input = blob(secret)?;
    let entropy = blob(entropy)?;
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: input blobs borrow live slices; DPAPI never writes through them.
    if unsafe {
        CryptProtectData(&input, std::ptr::null(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(take(out))
}

pub(crate) fn unprotect(sealed: &[u8], entropy: &[u8]) -> io::Result<Vec<u8>> {
    let input = blob(sealed)?;
    let entropy = blob(entropy)?;
    let mut out = CRYPT_INTEGER_BLOB::default();
    // SAFETY: as in protect.
    if unsafe {
        CryptUnprotectData(&input, std::ptr::null_mut(), &entropy, std::ptr::null(), std::ptr::null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(take(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_secret_round_trips_only_with_its_entropy() {
        let sealed = protect(b"refresh-token", b"service/account").unwrap();
        assert!(!sealed.windows(13).any(|window| window == b"refresh-token"));
        assert_eq!(unprotect(&sealed, b"service/account").unwrap(), b"refresh-token");
        assert!(unprotect(&sealed, b"other/account").is_err());
        let large = vec![7u8; 64 * 1024];
        assert_eq!(unprotect(&protect(&large, b"e").unwrap(), b"e").unwrap(), large);
    }
}
