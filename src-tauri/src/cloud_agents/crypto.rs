//! AES-256-GCM under a workspace content key, with the additional data the
//! contract binds each ciphertext to (terminalx-saas
//! `cloud-workspace-remote-runtime-contract.md` §13). Shared by the runtime,
//! which encrypts receipts and checkpoints and decrypts commands, and the
//! desktop, which does the reverse.

use std::io::{Read, Write};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand_core::{OsRng, RngCore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const KEY_LEN: usize = 32;
pub const IV_LEN: usize = 12;
/// Command and receipt ciphertext limit (§11.1).
pub const MAX_COMMAND_CIPHERTEXT: usize = 64 * 1024;
/// Decoded checkpoint ciphertext limit (§12).
pub const MAX_CHECKPOINT_CIPHERTEXT: usize = 1024 * 1024;
pub const CHECKPOINT_SCHEMA: u64 = 1;

pub fn b64(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn unb64(text: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text.trim_end_matches('=')).context("not base64url")
}

pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

/// A fresh random id (16 bytes base64url), for key ids and incarnations.
pub fn random_id() -> String {
    b64(&random_bytes::<16>())
}

pub fn command_aad(organization_id: &str, workspace_id: &str, tab_id: &str, client_command_id: &str, kind: &str, key_id: &str) -> Vec<u8> {
    json!(["terminalx-agent-command/1", organization_id, workspace_id, tab_id, client_command_id, kind, key_id]).to_string().into_bytes()
}

pub fn receipt_aad(organization_id: &str, workspace_id: &str, client_command_id: &str, outcome: &str, key_id: &str) -> Vec<u8> {
    json!(["terminalx-agent-command-result/1", organization_id, workspace_id, client_command_id, outcome, key_id]).to_string().into_bytes()
}

#[allow(clippy::too_many_arguments)]
pub fn checkpoint_aad(organization_id: &str, workspace_id: &str, tab_id: &str, epoch: u64, version: u64, schema_version: u64, key_id: &str) -> Vec<u8> {
    json!(["terminalx-transcript-checkpoint/1", organization_id, workspace_id, tab_id, epoch, version, schema_version, key_id])
        .to_string()
        .into_bytes()
}

/// `(iv, ciphertext)`, both base64url.
pub fn seal(key: &[u8; KEY_LEN], plaintext: &[u8], aad: &[u8]) -> Result<(String, String)> {
    let iv = random_bytes::<IV_LEN>();
    let ciphertext = seal_raw(key, &iv, plaintext, aad)?;
    Ok((b64(&iv), b64(&ciphertext)))
}

pub fn seal_raw(key: &[u8; KEY_LEN], iv: &[u8; IV_LEN], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    Aes256Gcm::new(key.into()).encrypt(Nonce::from_slice(iv), Payload { msg: plaintext, aad }).map_err(|_| anyhow!("encrypt failed"))
}

pub fn open(key: &[u8; KEY_LEN], iv: &str, ciphertext: &str, aad: &[u8]) -> Result<Vec<u8>> {
    let iv = unb64(iv)?;
    if iv.len() != IV_LEN {
        return Err(anyhow!("iv must be 12 bytes"));
    }
    open_raw(key, &iv, &unb64(ciphertext)?, aad)
}

pub fn open_raw(key: &[u8; KEY_LEN], iv: &[u8], ciphertext: &[u8], aad: &[u8]) -> Result<Vec<u8>> {
    Aes256Gcm::new(key.into())
        .decrypt(Nonce::from_slice(iv), Payload { msg: ciphertext, aad })
        .map_err(|_| anyhow!("decrypt failed: wrong key, or the ciphertext or its metadata was changed"))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn gzip(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(bytes)?;
    Ok(encoder.finish()?)
}

/// Inflate at most `limit` bytes, so a hostile checkpoint cannot exhaust memory.
pub fn gunzip(bytes: &[u8], limit: usize) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes).take(limit as u64 + 1).read_to_end(&mut out)?;
    if out.len() > limit {
        return Err(anyhow!("checkpoint inflates past {limit} bytes"));
    }
    Ok(out)
}

pub fn key_from_b64(text: &str) -> Result<[u8; KEY_LEN]> {
    unb64(text)?.try_into().map_err(|_| anyhow!("a workspace content key is 32 bytes"))
}

/// A decrypted JSON object with `"v": 1`.
pub fn parse_v1(bytes: &[u8]) -> Result<Value> {
    let value: Value = serde_json::from_slice(bytes).context("plaintext is not JSON")?;
    if value.get("v").and_then(Value::as_u64) != Some(1) {
        return Err(anyhow!("unsupported plaintext version"));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_and_open_round_trip_under_the_bound_metadata_only() {
        let key = random_bytes::<KEY_LEN>();
        let aad = command_aad("org", "ws", "tab-1", "cmd", "send", "k1");
        let (iv, ciphertext) = seal(&key, br#"{"v":1,"text":"hi"}"#, &aad).unwrap();
        assert_eq!(open(&key, &iv, &ciphertext, &aad).unwrap(), br#"{"v":1,"text":"hi"}"#);
        // Moved to another tab, kind or key id: refused.
        for other in [
            command_aad("org", "ws", "tab-2", "cmd", "send", "k1"),
            command_aad("org", "ws", "tab-1", "cmd", "steer", "k1"),
            command_aad("org", "ws", "tab-1", "cmd", "send", "k2"),
            command_aad("org", "ws2", "tab-1", "cmd", "send", "k1"),
        ] {
            assert!(open(&key, &iv, &ciphertext, &other).is_err());
        }
        assert!(open(&random_bytes::<KEY_LEN>(), &iv, &ciphertext, &aad).is_err());
    }

    #[test]
    fn aad_is_the_compact_json_array_the_contract_names() {
        assert_eq!(
            String::from_utf8(checkpoint_aad("o", "w", "t", 7, 42, 1, "k")).unwrap(),
            r#"["terminalx-transcript-checkpoint/1","o","w","t",7,42,1,"k"]"#
        );
        assert_eq!(String::from_utf8(receipt_aad("o", "w", "c", "applied", "k")).unwrap(), r#"["terminalx-agent-command-result/1","o","w","c","applied","k"]"#);
    }

    #[test]
    fn gunzip_refuses_to_inflate_past_its_limit() {
        let packed = gzip(&vec![b'a'; 10_000]).unwrap();
        assert_eq!(gunzip(&packed, 10_000).unwrap().len(), 10_000);
        assert!(gunzip(&packed, 9_999).is_err());
    }
}
