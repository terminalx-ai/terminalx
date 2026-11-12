//! The short code a person compares on the Mac and on the phone before
//! approving a pairing (docs/PAIRING-APPROVAL.md, PRO-314).
//!
//! Both sides already hold both keys before the Mac answers `e2ee_auth`: the
//! host key is pinned in the pairing offer and the phone's long-lived key is
//! in its `e2ee_hello`. So the fingerprint needs no wire message.

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose, Engine};
use sha2::{Digest, Sha256};

const DOMAIN: &[u8] = b"terminalx-pairing-fingerprint.v1";

/// `upper-hex(d[0..2]) · upper-hex(d[2..4])` of
/// `SHA-256(DOMAIN || 0x00 || host_pk || phone_pk)`, e.g. "7F3A·91C2".
pub(crate) fn fingerprint(host_pk: &[u8; 32], phone_pk: &[u8; 32]) -> String {
    let mut digest = Sha256::new();
    digest.update(DOMAIN);
    digest.update([0u8]);
    digest.update(host_pk);
    digest.update(phone_pk);
    let digest = digest.finalize();
    format!(
        "{:02X}{:02X}\u{00B7}{:02X}{:02X}",
        digest[0], digest[1], digest[2], digest[3]
    )
}

/// [`fingerprint`] of a phone key as the Mac stores and receives it: standard
/// base64 of the raw 32 bytes.
pub(crate) fn fingerprint_b64(host_pk: &[u8; 32], phone_pk_b64: &str) -> Result<String> {
    let phone: [u8; 32] = general_purpose::STANDARD
        .decode(phone_pk_b64)?
        .try_into()
        .map_err(|_| anyhow!("phone public key is not 32 bytes"))?;
    Ok(fingerprint(host_pk, &phone))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The vector both implementations assert (docs/PAIRING-APPROVAL.md).
    #[test]
    fn fingerprint_test_vector() {
        assert_eq!(fingerprint(&[0x01; 32], &[0x02; 32]), "1177\u{00B7}11ED");
        assert_eq!(
            fingerprint_b64(&[0x01; 32], &general_purpose::STANDARD.encode([0x02; 32])).unwrap(),
            "1177\u{00B7}11ED"
        );
    }

    #[test]
    fn the_fingerprint_binds_both_keys_in_order() {
        let forward = fingerprint(&[0x01; 32], &[0x02; 32]);
        assert_ne!(fingerprint(&[0x02; 32], &[0x01; 32]), forward);
        assert_ne!(fingerprint(&[0x01; 32], &[0x03; 32]), forward);
        assert!(fingerprint_b64(&[0x01; 32], &general_purpose::STANDARD.encode([0x02; 31])).is_err());
        assert!(fingerprint_b64(&[0x01; 32], "not base64!").is_err());
    }
}
