use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose, Engine};
use crypto_box::{
    aead::{generic_array::GenericArray, Aead, KeyInit},
    PublicKey, SalsaBox, SecretKey,
};
use crypto_secretbox::{Kdf, XSalsa20Poly1305};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use hpke::{
    aead::ChaCha20Poly1305, kdf::HkdfSha256, kem::X25519HkdfSha256, setup_sender, Deserializable,
    OpModeS, Serializable,
};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};

use super::model::{AccountPairingEnvelope, PairingOffer};

pub const HPKE_ALGORITHM: &str = "HPKE-Base-X25519-HKDF-SHA256-ChaCha20Poly1305";

#[derive(Clone)]
pub struct HostKeypair {
    secret: [u8; 32],
    public: [u8; 32],
}

impl HostKeypair {
    pub fn generate() -> Self {
        let secret = SecretKey::generate(&mut OsRng);
        Self {
            secret: secret.to_bytes(),
            public: *secret.public_key().as_bytes(),
        }
    }

    pub fn from_secret(secret: [u8; 32]) -> Self {
        let key = SecretKey::from(secret);
        Self {
            secret,
            public: *key.public_key().as_bytes(),
        }
    }

    pub fn secret(&self) -> &[u8; 32] {
        &self.secret
    }

    pub fn public(&self) -> &[u8; 32] {
        &self.public
    }

    pub fn public_key_b64(&self) -> String {
        general_purpose::STANDARD.encode(self.public)
    }

    pub fn host_id(&self) -> String {
        general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(self.public))[..16].into()
    }
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn token_hash(token: &str) -> String {
    general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

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

pub struct RelayProofContext<'a> {
    pub relay_origin: &'a str,
    pub user_id: &'a str,
    pub profile_id: &'a str,
    pub organization_id: &'a str,
    pub relay_host_id: &'a str,
    pub assignment_epoch: u64,
    pub previous_generation: Option<u64>,
    pub resume_requested: bool,
    pub now_ms: i64,
}

pub fn answer_relay_challenge(
    keypair: &HostKeypair,
    challenge_id: &str,
    relay_key_b64: &str,
    nonce_b64: &str,
    ciphertext_b64: &str,
    expires_at: i64,
    context: &RelayProofContext<'_>,
) -> Result<String> {
    let relay_key: [u8; 32] = decode_standard(relay_key_b64, 32)?.try_into().unwrap();
    let nonce = decode_standard(nonce_b64, 24)?;
    let ciphertext = decode_standard(ciphertext_b64, 1)?;
    let cipher = SalsaBox::new(
        &PublicKey::from(relay_key),
        &SecretKey::from(*keypair.secret()),
    );
    let plaintext = cipher
        .decrypt(GenericArray::from_slice(&nonce), ciphertext.as_ref())
        .map_err(|_| anyhow!("relay host challenge was not issued for this host key"))?;
    let prefix = b"terminalx-relay-host-challenge/v1\0";
    if !plaintext.starts_with(prefix) || plaintext.len() < prefix.len() + 4 + 32 {
        bail!("relay host challenge has an invalid envelope");
    }
    let length_offset = prefix.len();
    let transcript_length = u32::from_be_bytes(
        plaintext[length_offset..length_offset + 4]
            .try_into()
            .unwrap(),
    ) as usize;
    let transcript_start = length_offset + 4;
    let secret_start = transcript_start + transcript_length;
    if secret_start + 32 != plaintext.len() {
        bail!("relay host challenge has an invalid transcript length");
    }
    let transcript = &plaintext[transcript_start..secret_start];
    validate_relay_transcript(
        transcript,
        challenge_id,
        &relay_key,
        &nonce,
        expires_at,
        keypair,
        context,
    )?;
    let secret = &plaintext[secret_start..];
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(secret).unwrap();
    mac.update(b"terminalx-relay-host-proof/v1\0ack\0");
    mac.update(transcript);
    Ok(general_purpose::STANDARD.encode(mac.finalize().into_bytes()))
}

#[allow(clippy::too_many_arguments)]
fn validate_relay_transcript(
    transcript: &[u8],
    challenge_id: &str,
    relay_key: &[u8; 32],
    nonce: &[u8],
    challenge_expires_at: i64,
    keypair: &HostKeypair,
    context: &RelayProofContext<'_>,
) -> Result<()> {
    use std::collections::BTreeMap;
    let mut fields = BTreeMap::<String, Vec<u8>>::new();
    let mut offset = 0usize;
    while offset < transcript.len() {
        let name_length = read_u32(transcript, &mut offset)? as usize;
        let name = take(transcript, &mut offset, name_length)?;
        let value_length = read_u32(transcript, &mut offset)? as usize;
        let value = take(transcript, &mut offset, value_length)?.to_vec();
        let name = std::str::from_utf8(name).context("relay transcript field name")?;
        if fields.insert(name.into(), value).is_some() {
            bail!("relay transcript contains a duplicate field");
        }
    }
    if fields.len() != 16 {
        bail!("relay transcript has the wrong field count");
    }
    let issued_at = field_u64(&fields, "issuedAt")? as i64;
    let transcript_expires_at = field_u64(&fields, "expiresAt")? as i64;
    let skew = 30_000;
    if issued_at - skew > context.now_ms
        || context.now_ms - skew > challenge_expires_at
        || issued_at > challenge_expires_at
        || challenge_expires_at - issued_at > 10_000
        || transcript_expires_at != challenge_expires_at
    {
        bail!("relay transcript is outside its validity window");
    }
    require_field(&fields, "protocol", b"terminalx-relay-host-proof/v1")?;
    require_field(&fields, "version", &[1])?;
    require_field(&fields, "relayOrigin", context.relay_origin.as_bytes())?;
    require_field(&fields, "relayEphemeralPublicKey", relay_key)?;
    require_field(&fields, "challengeNonce", nonce)?;
    require_field(&fields, "challengeId", challenge_id.as_bytes())?;
    require_field(&fields, "userId", context.user_id.as_bytes())?;
    require_field(&fields, "profileId", context.profile_id.as_bytes())?;
    require_field(
        &fields,
        "organizationId",
        context.organization_id.as_bytes(),
    )?;
    require_field(&fields, "relayHostId", context.relay_host_id.as_bytes())?;
    require_field(&fields, "hostPublicKey", keypair.public())?;
    require_field(
        &fields,
        "assignmentEpoch",
        &context.assignment_epoch.to_be_bytes(),
    )?;
    require_field(
        &fields,
        "previousGeneration",
        &previous_generation_bytes(context.previous_generation),
    )?;
    require_field(
        &fields,
        "resumeRequested",
        &[u8::from(context.resume_requested)],
    )?;
    Ok(())
}

fn previous_generation_bytes(generation: Option<u64>) -> Vec<u8> {
    generation
        .map(|value| value.to_be_bytes().to_vec())
        .unwrap_or_default()
}

fn require_field(
    fields: &std::collections::BTreeMap<String, Vec<u8>>,
    name: &str,
    expected: &[u8],
) -> Result<()> {
    if fields.get(name).map(Vec::as_slice) != Some(expected) {
        bail!("relay transcript field {name} did not match");
    }
    Ok(())
}

fn field_u64(fields: &std::collections::BTreeMap<String, Vec<u8>>, name: &str) -> Result<u64> {
    let value = fields
        .get(name)
        .with_context(|| format!("relay transcript field {name} is missing"))?;
    Ok(u64::from_be_bytes(value.as_slice().try_into().map_err(
        |_| anyhow!("relay transcript field {name} has the wrong size"),
    )?))
}

fn read_u32(bytes: &[u8], offset: &mut usize) -> Result<u32> {
    let value = take(bytes, offset, 4)?;
    Ok(u32::from_be_bytes(value.try_into().unwrap()))
}

fn take<'a>(bytes: &'a [u8], offset: &mut usize, length: usize) -> Result<&'a [u8]> {
    let end = offset
        .checked_add(length)
        .filter(|end| *end <= bytes.len())
        .ok_or_else(|| anyhow!("relay transcript is truncated"))?;
    let value = &bytes[*offset..end];
    *offset = end;
    Ok(value)
}

fn decode_standard(value: &str, expected: usize) -> Result<Vec<u8>> {
    let bytes = general_purpose::STANDARD
        .decode(value)
        .context("decode canonical base64")?;
    if bytes.len() != expected && expected != 1 || general_purpose::STANDARD.encode(&bytes) != value
    {
        bail!("invalid canonical base64 value");
    }
    Ok(bytes)
}

fn decode_base64url(value: &str, expected: usize) -> Result<Vec<u8>> {
    let bytes = general_purpose::URL_SAFE_NO_PAD
        .decode(value)
        .context("decode canonical base64url")?;
    if bytes.len() != expected || general_purpose::URL_SAFE_NO_PAD.encode(&bytes) != value {
        bail!("invalid canonical base64url value");
    }
    Ok(bytes)
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct E2eeContext {
    pub protocol: String,
    pub initiator: String,
    pub responder: String,
    pub transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relay_host_id: Option<String>,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct E2eeCapabilities {
    pub framing: [u8; 1],
    #[serde(rename = "payloadKinds")]
    pub payload_kinds: [String; 2],
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct E2eeHello {
    #[serde(rename = "type")]
    pub kind: String,
    pub v: u8,
    pub client_public_key_b64: String,
    pub client_nonce_b64: String,
    pub capabilities: E2eeCapabilities,
    pub context: E2eeContext,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eeSelection {
    pub framing: u8,
    pub payload_kinds: [String; 2],
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct E2eeReady {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub v: u8,
    pub desktop_public_key_b64: String,
    pub client_nonce_b64: String,
    pub desktop_nonce_b64: String,
    pub selection: E2eeSelection,
    pub context: E2eeContext,
}

pub struct E2eeSession {
    inbound_key: [u8; 32],
    outbound_key: [u8; 32],
    session_id: [u8; 32],
    pub transcript_hash_b64: String,
    pub client_public_key_b64: String,
    inbound_counter: u64,
    outbound_counter: u64,
}

pub fn begin_e2ee_session(
    keypair: &HostKeypair,
    hello: E2eeHello,
    expected_transport: &str,
    relay_host_id: Option<&str>,
) -> Result<(E2eeReady, E2eeSession)> {
    validate_e2ee_hello(&hello, expected_transport, relay_host_id)?;
    let client_key: [u8; 32] = decode_standard(&hello.client_public_key_b64, 32)?
        .try_into()
        .unwrap();
    let client_nonce: [u8; 32] = decode_standard(&hello.client_nonce_b64, 32)?
        .try_into()
        .unwrap();
    let mut desktop_nonce = [0u8; 32];
    OsRng.fill_bytes(&mut desktop_nonce);
    let ready = E2eeReady {
        kind: "e2ee_ready",
        v: 2,
        desktop_public_key_b64: keypair.public_key_b64(),
        client_nonce_b64: hello.client_nonce_b64.clone(),
        desktop_nonce_b64: general_purpose::STANDARD.encode(desktop_nonce),
        selection: E2eeSelection {
            framing: 2,
            payload_kinds: ["text".into(), "binary".into()],
        },
        context: hello.context.clone(),
    };
    let transcript = encode_e2ee_transcript(
        &hello,
        &ready,
        &client_key,
        keypair.public(),
        &client_nonce,
        &desktop_nonce,
    );
    let transcript_hash: [u8; 32] = Sha256::digest(&transcript).into();
    let mut salt_input = b"terminalx-mobile-e2ee/v2/salt\0".to_vec();
    salt_input.extend_from_slice(&client_nonce);
    salt_input.extend_from_slice(&desktop_nonce);
    let salt = Sha256::digest(salt_input);
    let mut info = b"terminalx-mobile-e2ee/v2/session\0".to_vec();
    info.extend_from_slice(&transcript_hash);
    let shared_secret = nacl_box_before(keypair.secret(), &client_key);
    let mut expanded = [0u8; 96];
    Hkdf::<Sha256>::new(Some(&salt), &shared_secret)
        .expand(&info, &mut expanded)
        .map_err(|_| anyhow!("could not derive E2EE session keys"))?;
    Ok((
        ready,
        E2eeSession {
            inbound_key: expanded[..32].try_into().unwrap(),
            outbound_key: expanded[32..64].try_into().unwrap(),
            session_id: expanded[64..].try_into().unwrap(),
            transcript_hash_b64: general_purpose::STANDARD.encode(transcript_hash),
            client_public_key_b64: hello.client_public_key_b64,
            inbound_counter: 0,
            outbound_counter: 0,
        },
    ))
}

fn validate_e2ee_hello(
    hello: &E2eeHello,
    expected_transport: &str,
    relay_host_id: Option<&str>,
) -> Result<()> {
    if hello.kind != "e2ee_hello"
        || hello.v != 2
        || hello.capabilities.framing != [2]
        || hello.capabilities.payload_kinds != ["text", "binary"]
        || hello.context.protocol != "terminalx-mobile-e2ee"
        || hello.context.initiator != "mobile"
        || hello.context.responder != "desktop"
        || hello.context.transport != expected_transport
        || hello.context.relay_host_id.as_deref() != relay_host_id
    {
        bail!("unsupported E2EE handshake");
    }
    Ok(())
}

fn nacl_box_before(secret: &[u8; 32], public: &[u8; 32]) -> [u8; 32] {
    let raw = StaticSecret::from(*secret).diffie_hellman(&X25519PublicKey::from(*public));
    let derived = <salsa20::Salsa20 as Kdf>::kdf(
        GenericArray::from_slice(raw.as_bytes()),
        &GenericArray::default(),
    );
    derived.into()
}

fn encode_e2ee_transcript(
    hello: &E2eeHello,
    ready: &E2eeReady,
    client_key: &[u8],
    desktop_key: &[u8],
    client_nonce: &[u8],
    desktop_nonce: &[u8],
) -> Vec<u8> {
    let framing_list = encode_number_list(&[2]);
    let payload_kinds = encode_string_list(&["text", "binary"]);
    let relay_id = hello.context.relay_host_id.as_deref().unwrap_or("");
    let fields: Vec<(&str, Vec<u8>)> = vec![
        ("domain", b"terminalx-mobile-e2ee/v2/transcript".to_vec()),
        ("mobile-to-desktop.type", hello.kind.as_bytes().to_vec()),
        (
            "mobile-to-desktop.version",
            (hello.v as u32).to_be_bytes().to_vec(),
        ),
        ("mobile-to-desktop.client-public-key", client_key.to_vec()),
        ("mobile-to-desktop.client-nonce", client_nonce.to_vec()),
        (
            "mobile-to-desktop.capabilities.framing",
            framing_list.clone(),
        ),
        (
            "mobile-to-desktop.capabilities.payload-kinds",
            payload_kinds.clone(),
        ),
        (
            "mobile-to-desktop.context.protocol",
            hello.context.protocol.as_bytes().to_vec(),
        ),
        (
            "mobile-to-desktop.context.initiator",
            hello.context.initiator.as_bytes().to_vec(),
        ),
        (
            "mobile-to-desktop.context.responder",
            hello.context.responder.as_bytes().to_vec(),
        ),
        (
            "mobile-to-desktop.context.transport",
            hello.context.transport.as_bytes().to_vec(),
        ),
        (
            "mobile-to-desktop.context.relay-host-id",
            relay_id.as_bytes().to_vec(),
        ),
        ("desktop-to-mobile.type", ready.kind.as_bytes().to_vec()),
        (
            "desktop-to-mobile.version",
            (ready.v as u32).to_be_bytes().to_vec(),
        ),
        ("desktop-to-mobile.desktop-public-key", desktop_key.to_vec()),
        ("desktop-to-mobile.client-nonce-echo", client_nonce.to_vec()),
        ("desktop-to-mobile.desktop-nonce", desktop_nonce.to_vec()),
        (
            "desktop-to-mobile.selection.framing",
            (2u32).to_be_bytes().to_vec(),
        ),
        ("desktop-to-mobile.selection.payload-kinds", payload_kinds),
        (
            "desktop-to-mobile.context.protocol",
            ready.context.protocol.as_bytes().to_vec(),
        ),
        (
            "desktop-to-mobile.context.initiator",
            ready.context.initiator.as_bytes().to_vec(),
        ),
        (
            "desktop-to-mobile.context.responder",
            ready.context.responder.as_bytes().to_vec(),
        ),
        (
            "desktop-to-mobile.context.transport",
            ready.context.transport.as_bytes().to_vec(),
        ),
        (
            "desktop-to-mobile.context.relay-host-id",
            relay_id.as_bytes().to_vec(),
        ),
    ];
    let mut output = Vec::new();
    for (name, value) in fields {
        output.extend_from_slice(&(name.len() as u32).to_be_bytes());
        output.extend_from_slice(name.as_bytes());
        output.extend_from_slice(&(value.len() as u32).to_be_bytes());
        output.extend_from_slice(&value);
    }
    output
}

fn encode_number_list(values: &[u32]) -> Vec<u8> {
    let mut output = (values.len() as u32).to_be_bytes().to_vec();
    for value in values {
        output.extend_from_slice(&value.to_be_bytes());
    }
    output
}

fn encode_string_list(values: &[&str]) -> Vec<u8> {
    let mut output = (values.len() as u32).to_be_bytes().to_vec();
    for value in values {
        output.extend_from_slice(&(value.len() as u32).to_be_bytes());
        output.extend_from_slice(value.as_bytes());
    }
    output
}

#[derive(Clone, Copy)]
pub enum PayloadKind {
    Text,
    Binary,
}

impl E2eeSession {
    pub fn open(&mut self, frame: &[u8], kind: PayloadKind) -> Result<Vec<u8>> {
        let nonce = frame
            .get(..24)
            .ok_or_else(|| anyhow!("encrypted frame is truncated"))?;
        let expected = frame_nonce(&self.session_id, false, kind, self.inbound_counter);
        if nonce != expected {
            bail!("encrypted frame counter or direction did not match");
        }
        let cipher = XSalsa20Poly1305::new(GenericArray::from_slice(&self.inbound_key));
        let plaintext = cipher
            .decrypt(
                GenericArray::from_slice(nonce),
                frame.get(24..).unwrap_or_default(),
            )
            .map_err(|_| anyhow!("encrypted frame authentication failed"))?;
        let expected_header = frame_header(&self.session_id, false, kind, self.inbound_counter);
        if !plaintext.starts_with(&expected_header) {
            bail!("encrypted frame header did not match");
        }
        self.inbound_counter = self
            .inbound_counter
            .checked_add(1)
            .ok_or_else(|| anyhow!("encrypted frame counter exhausted"))?;
        Ok(plaintext[expected_header.len()..].to_vec())
    }

    pub fn seal(&mut self, payload: &[u8], kind: PayloadKind) -> Result<Vec<u8>> {
        let nonce = frame_nonce(&self.session_id, true, kind, self.outbound_counter);
        let mut plaintext = frame_header(&self.session_id, true, kind, self.outbound_counter);
        plaintext.extend_from_slice(payload);
        let cipher = XSalsa20Poly1305::new(GenericArray::from_slice(&self.outbound_key));
        let encrypted = cipher
            .encrypt(GenericArray::from_slice(&nonce), plaintext.as_ref())
            .map_err(|_| anyhow!("could not encrypt frame"))?;
        self.outbound_counter = self
            .outbound_counter
            .checked_add(1)
            .ok_or_else(|| anyhow!("encrypted frame counter exhausted"))?;
        let mut frame = nonce.to_vec();
        frame.extend_from_slice(&encrypted);
        Ok(frame)
    }
}

fn direction_byte(outbound: bool) -> u8 {
    u8::from(outbound)
}

fn kind_byte(kind: PayloadKind) -> u8 {
    match kind {
        PayloadKind::Text => 0,
        PayloadKind::Binary => 1,
    }
}

fn frame_nonce(session_id: &[u8; 32], outbound: bool, kind: PayloadKind, counter: u64) -> [u8; 24] {
    let mut nonce = [0u8; 24];
    nonce[..12].copy_from_slice(&session_id[..12]);
    nonce[12] = 2;
    nonce[13] = direction_byte(outbound);
    nonce[14] = kind_byte(kind);
    nonce[15] = 0;
    nonce[16..].copy_from_slice(&counter.to_be_bytes());
    nonce
}

fn frame_header(session_id: &[u8; 32], outbound: bool, kind: PayloadKind, counter: u64) -> Vec<u8> {
    let mut header = session_id.to_vec();
    header.push(direction_byte(outbound));
    header.push(kind_byte(kind));
    header.extend_from_slice(&counter.to_be_bytes());
    header
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_id_is_the_documented_sha256_prefix() {
        let key = HostKeypair::from_secret([7; 32]);
        let expected = general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(key.public()));
        assert_eq!(key.host_id(), &expected[..16]);
        assert_eq!(key.public_key_b64().len(), 44);
    }

    #[test]
    fn absent_relay_generation_is_zero_length() {
        assert!(previous_generation_bytes(None).is_empty());
        assert_eq!(
            previous_generation_bytes(Some(7)),
            7u64.to_be_bytes().as_slice()
        );
    }

    #[test]
    fn transcript_and_key_schedule_match_the_phone_fixture() {
        let context = E2eeContext {
            protocol: "terminalx-mobile-e2ee".into(),
            initiator: "mobile".into(),
            responder: "desktop".into(),
            transport: "relay".into(),
            relay_host_id: Some("AbCdEf0123_-xyZ9".into()),
        };
        let hello = E2eeHello {
            kind: "e2ee_hello".into(),
            v: 2,
            client_public_key_b64: general_purpose::STANDARD.encode([1; 32]),
            client_nonce_b64: general_purpose::STANDARD.encode([2; 32]),
            capabilities: E2eeCapabilities {
                framing: [2],
                payload_kinds: ["text".into(), "binary".into()],
            },
            context: context.clone(),
        };
        let ready = E2eeReady {
            kind: "e2ee_ready",
            v: 2,
            desktop_public_key_b64: general_purpose::STANDARD.encode([3; 32]),
            client_nonce_b64: general_purpose::STANDARD.encode([2; 32]),
            desktop_nonce_b64: general_purpose::STANDARD.encode([4; 32]),
            selection: E2eeSelection {
                framing: 2,
                payload_kinds: ["text".into(), "binary".into()],
            },
            context,
        };
        let transcript =
            encode_e2ee_transcript(&hello, &ready, &[1; 32], &[3; 32], &[2; 32], &[4; 32]);
        assert_eq!(transcript.len(), 1362);
        assert_eq!(
            format!("{:x}", Sha256::digest(&transcript)),
            "e5aefcbe977547916c2c4538eedd4c50c2b03156dd0ac57ce21d249f03819cc9"
        );
        let salt = Sha256::digest(
            [
                b"terminalx-mobile-e2ee/v2/salt\0".as_slice(),
                &[2; 32],
                &[4; 32],
            ]
            .concat(),
        );
        let info = [
            b"terminalx-mobile-e2ee/v2/session\0".as_slice(),
            Sha256::digest(&transcript).as_slice(),
        ]
        .concat();
        let mut output = [0u8; 96];
        Hkdf::<Sha256>::new(Some(&salt), &[5; 32])
            .expand(&info, &mut output)
            .unwrap();
        assert_eq!(
            hex(&output),
            concat!(
                "db1a8f4463da4e59efe16040978c36f4754b7c276552a345d73ba221f2e3c560",
                "d0270b96a99c58e19ae5c9d6b64f7f6e9ced4518db632637f356460baecaaab7",
                "30212a647cdc2b86a51e1800a5084bf09063371734a239f9b40bb7958a04e2a1"
            )
        );
    }

    #[test]
    fn e2ee_frame_nonce_is_fixed_and_replays_fail() {
        let mut sender = E2eeSession {
            inbound_key: [7; 32],
            outbound_key: [7; 32],
            session_id: [8; 32],
            transcript_hash_b64: String::new(),
            client_public_key_b64: String::new(),
            inbound_counter: 0,
            outbound_counter: 0,
        };
        let frame = sender.seal(b"e2ee-auth", PayloadKind::Text).unwrap();
        assert_eq!(
            hex(&frame[..24]),
            "080808080808080808080808020100000000000000000000"
        );
        let mut receiver = E2eeSession {
            inbound_key: [7; 32],
            outbound_key: [7; 32],
            session_id: [8; 32],
            transcript_hash_b64: String::new(),
            client_public_key_b64: String::new(),
            inbound_counter: 0,
            outbound_counter: 0,
        };
        // Flip the direction to model a mobile-originated fixture.
        let mut phone_frame = frame;
        phone_frame[13] = 0;
        assert!(receiver.open(&phone_frame, PayloadKind::Text).is_err());
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}
