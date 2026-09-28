use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose, Engine};
use hpke::{
    aead::ChaCha20Poly1305, kdf::HkdfSha256, kem::X25519HkdfSha256, setup_sender, Deserializable,
    OpModeS, Serializable,
};

pub use crate::relay_e2ee::*;

use super::model::{AccountPairingEnvelope, PairingOffer};

pub const HPKE_ALGORITHM: &str = "HPKE-Base-X25519-HKDF-SHA256-ChaCha20Poly1305";

pub fn encode_pairing_offer(offer: &PairingOffer) -> Result<String> {
    let payload = serde_json::to_vec(offer)?;
    Ok(format!(
        "terminalx://pair?code={}",
        general_purpose::URL_SAFE_NO_PAD.encode(payload)
    ))
}

pub fn seal_account_offer(
    grant_public_key: &str,
    associated_data: &str,
    binding_generation: u64,
    offer: &PairingOffer,
) -> Result<AccountPairingEnvelope> {
    type Kem = X25519HkdfSha256;
    let public_bytes = decode_base64url(grant_public_key, 32)?;
    let public = <Kem as hpke::Kem>::PublicKey::from_bytes(&public_bytes)
        .map_err(|_| anyhow!("invalid account pairing public key"))?;
    let (encapped, mut context) =
        setup_sender::<ChaCha20Poly1305, HkdfSha256, Kem>(&OpModeS::Base, &public, b"")
            .map_err(|_| anyhow!("could not initialize account pairing envelope"))?;
    let aad = general_purpose::URL_SAFE_NO_PAD
        .decode(associated_data)
        .context("decode account pairing associated data")?;
    let plaintext = serde_json::to_vec(offer)?;
    let ciphertext = context
        .seal(&plaintext, &aad)
        .map_err(|_| anyhow!("could not seal account pairing envelope"))?;
    Ok(AccountPairingEnvelope {
        binding_generation,
        version: 1,
        algorithm: HPKE_ALGORITHM,
        encapsulated_key: general_purpose::URL_SAFE_NO_PAD.encode(encapped.to_bytes()),
        ciphertext: general_purpose::URL_SAFE_NO_PAD.encode(ciphertext),
    })
}
