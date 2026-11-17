use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose, Engine};
use hpke::{
    aead::ChaCha20Poly1305, kdf::HkdfSha256, kem::X25519HkdfSha256, setup_sender, Deserializable,
    OpModeS, Serializable,
};

pub use crate::relay_e2ee::*;

use super::model::{AccountPairingEnvelope, PairingOffer};

pub const HPKE_ALGORITHM: &str = "HPKE-Base-X25519-HKDF-SHA256-ChaCha20Poly1305";

pub use crate::phone::encode_pairing_offer;

pub fn seal_account_offer(
    grant_public_key: &str,
    associated_data: &str,
    binding_generation: u64,
    offer: &PairingOffer,
) -> Result<AccountPairingEnvelope> {
    seal_account_bytes(grant_public_key, associated_data, binding_generation, &serde_json::to_vec(offer)?)
}

/// Seal `plaintext` for an account pairing grant exactly as a phone's offer
/// is sealed: HPKE base mode to the grant's one-request key, with the grant's
/// associated data as AAD. A `runtime` grant's plaintext is the machine
/// code's JSON (PRO-349).
pub fn seal_account_bytes(
    grant_public_key: &str,
    associated_data: &str,
    binding_generation: u64,
    plaintext: &[u8],
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
    let ciphertext = context
        .seal(plaintext, &aad)
        .map_err(|_| anyhow!("could not seal account pairing envelope"))?;
    Ok(AccountPairingEnvelope {
        binding_generation,
        version: 1,
        algorithm: HPKE_ALGORITHM,
        encapsulated_key: general_purpose::URL_SAFE_NO_PAD.encode(encapped.to_bytes()),
        ciphertext: general_purpose::URL_SAFE_NO_PAD.encode(ciphertext),
    })
}
