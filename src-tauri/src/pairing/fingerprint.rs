//! The code a person compares on the Mac and on the phone before approving a
//! pairing (docs/PAIRING-APPROVAL.md, PRO-314).
//!
//! Both sides already hold every input before the Mac answers `e2ee_auth`: the
//! host key and the one-time device token are in the pairing offer, and the
//! phone's long-lived key is in its `e2ee_hello`. So the fingerprint needs no
//! wire message.
//!
//! The two keys are long-lived and the phone's is sent in the clear, so they
//! alone would let someone grind a key of their own with the same short code
//! ahead of time. The device token is fresh for every code and secret until
//! the code is shown, which confines any search to the code's few minutes, and
//! 64 bits puts a search in those minutes far out of reach.

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose, Engine};
use sha2::{Digest, Sha256};

const DOMAIN: &[u8] = b"terminalx-pairing-fingerprint.v2";

/// Four groups of four upper-hex digits, `·`-separated, from the first eight
/// bytes of `SHA-256(DOMAIN || 0x00 || host_pk || phone_pk || token_digest)`,
/// where `token_digest` is `SHA-256(device token)`. E.g. "CEF4·2468·FE26·9E4B".
pub(crate) fn fingerprint(host_pk: &[u8; 32], phone_pk: &[u8; 32], token_digest: &[u8; 32]) -> String {
    let mut digest = Sha256::new();
    digest.update(DOMAIN);
    digest.update([0u8]);
    digest.update(host_pk);
    digest.update(phone_pk);
    digest.update(token_digest);
    let digest = digest.finalize();
    digest[..8]
        .chunks(2)
        .map(|pair| format!("{:02X}{:02X}", pair[0], pair[1]))
        .collect::<Vec<_>>()
        .join("\u{00B7}")
}

/// [`fingerprint`] from the values a device entry keeps: the phone key as
/// standard base64, and the token as `DeviceEntry::token` stores it
/// (base64url, unpadded, of `SHA-256(token)`).
pub(crate) fn fingerprint_b64(host_pk: &[u8; 32], phone_pk_b64: &str, token_hash: &str) -> Result<String> {
    let phone: [u8; 32] = general_purpose::STANDARD
        .decode(phone_pk_b64)?
        .try_into()
        .map_err(|_| anyhow!("phone public key is not 32 bytes"))?;
    let token: [u8; 32] = general_purpose::URL_SAFE_NO_PAD
        .decode(token_hash)?
        .try_into()
        .map_err(|_| anyhow!("device token digest is not 32 bytes"))?;
    Ok(fingerprint(host_pk, &phone, &token))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay_e2ee::token_hash;

    /// The vectors both implementations assert (docs/PAIRING-APPROVAL.md).
    #[test]
    fn fingerprint_test_vector() {
        assert_eq!(fingerprint(&[0x01; 32], &[0x02; 32], &[0x03; 32]), "CEF4\u{00B7}2468\u{00B7}FE26\u{00B7}9E4B");
        assert_eq!(
            fingerprint_b64(&[0x01; 32], &general_purpose::STANDARD.encode([0x02; 32]), &token_hash("token-abc")).unwrap(),
            "6B3C\u{00B7}CA5D\u{00B7}54D0\u{00B7}FCB6"
        );
    }

    #[test]
    fn the_fingerprint_binds_both_keys_in_order_and_the_code() {
        let forward = fingerprint(&[0x01; 32], &[0x02; 32], &[0x03; 32]);
        assert_ne!(fingerprint(&[0x02; 32], &[0x01; 32], &[0x03; 32]), forward);
        assert_ne!(fingerprint(&[0x01; 32], &[0x04; 32], &[0x03; 32]), forward);
        // The same phone and Mac show a different code for each pairing code.
        assert_ne!(fingerprint(&[0x01; 32], &[0x02; 32], &[0x05; 32]), forward);
        let token = token_hash("token-abc");
        assert!(fingerprint_b64(&[0x01; 32], &general_purpose::STANDARD.encode([0x02; 31]), &token).is_err());
        assert!(fingerprint_b64(&[0x01; 32], "not base64!", &token).is_err());
        assert!(fingerprint_b64(&[0x01; 32], &general_purpose::STANDARD.encode([0x02; 32]), "short").is_err());
    }
}
