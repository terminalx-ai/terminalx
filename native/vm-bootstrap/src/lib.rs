//! TerminalX macOS VM first-boot pieces from docs/LOCAL-VM-HELPER-DELIVERY.md:
//! the validation-only probe (validation plan P3/P8) and the offline seeder core.
//! Nothing here authenticates a helper, approves an account or marks Ready.
#![cfg(target_os = "macos")]

pub mod account;
pub mod disk;
pub mod enroll;
pub mod fsx;
pub mod probe;
pub mod seed;
pub mod wire;

/// Lowercase hex, the encoding every TerminalX receipt uses for digests.
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex(&Sha256::digest(bytes))
}

/// Kernel CSPRNG bytes. `getentropy` is limited to 256 bytes per call.
pub fn random<const N: usize>() -> std::io::Result<[u8; N]> {
    let mut bytes = [0u8; N];
    for chunk in bytes.chunks_mut(256) {
        // SAFETY: the pointer/length describe a live writable chunk of <=256 bytes.
        if unsafe { libc::getentropy(chunk.as_mut_ptr().cast(), chunk.len()) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(bytes)
}
