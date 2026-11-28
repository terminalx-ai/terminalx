//! The relay host proof and the paired-device E2EE channel (v2), shared by
//! the desktop's pairing host, the headless runtime's relay host and the
//! desktop's cloud workspace client (PRO-13). The pairing offer and account
//! envelope stay in `pairing::crypto`.

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose, Engine};
use crypto_box::{
    aead::{generic_array::GenericArray, Aead, KeyInit},
    PublicKey, SalsaBox, SecretKey,
};
use crypto_secretbox::{Kdf, XSalsa20Poly1305};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey as X25519PublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone)]
pub struct HostKeypair {
    secret: [u8; 32],
    public: [u8; 32],
}

impl Drop for HostKeypair {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
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
        host_id_of(&self.public)
    }
}

/// The relay host id (and `machineId`) of a host public key.
pub fn host_id_of(public: &[u8; 32]) -> String {
    general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(public))[..16].into()
}

pub fn random_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub fn token_hash(token: &str) -> String {
    general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
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
    // Reject low-order X25519 public keys before performing Box decryption.
    if !StaticSecret::from(*keypair.secret())
        .diffie_hellman(&X25519PublicKey::from(relay_key))
        .was_contributory()
    {
        bail!("relay host challenge used a low-order X25519 public key");
    }
    let nonce = decode_standard(nonce_b64, 24)?;
    let ciphertext = decode_standard(ciphertext_b64, 1)?;
    let cipher = SalsaBox::new(
        &PublicKey::from(relay_key),
        &SecretKey::from(*keypair.secret()),
    );
    let plaintext = Zeroizing::new(
        cipher
            .decrypt(GenericArray::from_slice(&nonce), ciphertext.as_ref())
            .map_err(|_| anyhow!("relay host challenge was not issued for this host key"))?,
    );
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
    let issued_at = field_u64(&fields, "issuedAt")?;
    let transcript_expires_at = field_u64(&fields, "expiresAt")?;
    let challenge_expires_at = u64::try_from(challenge_expires_at)
        .map_err(|_| anyhow!("relay transcript expiry is negative"))?;
    let now_ms = u64::try_from(context.now_ms)
        .map_err(|_| anyhow!("relay clock timestamp is negative"))?;
    const SKEW_MS: u64 = 30_000;
    const MAX_WINDOW_MS: u64 = 10_000;
    let valid_window = transcript_expires_at == challenge_expires_at
        && issued_at <= challenge_expires_at
        && challenge_expires_at.saturating_sub(issued_at) <= MAX_WINDOW_MS
        && issued_at <= now_ms.saturating_add(SKEW_MS)
        && now_ms <= challenge_expires_at.saturating_add(SKEW_MS);
    if !valid_window {
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

pub(crate) fn decode_standard(value: &str, expected: usize) -> Result<Vec<u8>> {
    let bytes = general_purpose::STANDARD
        .decode(value)
        .context("decode canonical base64")?;
    if bytes.len() != expected && expected != 1 || general_purpose::STANDARD.encode(&bytes) != value
    {
        bail!("invalid canonical base64 value");
    }
    Ok(bytes)
}

pub(crate) fn decode_base64url(value: &str, expected: usize) -> Result<Vec<u8>> {
    let bytes = general_purpose::URL_SAFE_NO_PAD
        .decode(value)
        .context("decode canonical base64url")?;
    if bytes.len() != expected || general_purpose::URL_SAFE_NO_PAD.encode(&bytes) != value {
        bail!("invalid canonical base64url value");
    }
    Ok(bytes)
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_ephemeral_public_key_b64: Option<String>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub desktop_ephemeral_public_key_b64: Option<String>,
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
    /// The phone or desktop client that sent the hello, rather than the host
    /// that answered it. It picks the frame direction of each key.
    initiator: bool,
}

impl Drop for E2eeSession {
    fn drop(&mut self) {
        self.inbound_key.zeroize();
        self.outbound_key.zeroize();
        self.session_id.zeroize();
    }
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
    let client_ephemeral_key: Option<[u8; 32]> = hello
        .client_ephemeral_public_key_b64
        .as_deref()
        .map(|b64| -> Result<[u8; 32]> { Ok(decode_standard(b64, 32)?.try_into().unwrap()) })
        .transpose()?;
    let client_nonce: [u8; 32] = decode_standard(&hello.client_nonce_b64, 32)?
        .try_into()
        .unwrap();
    let mut desktop_nonce = [0u8; 32];
    OsRng.fill_bytes(&mut desktop_nonce);

    // Hybrid ss + ee forward secrecy whenever the initiator provides an
    // ephemeral X25519 key; legacy v2 clients without one remain interoperable
    // while still enforcing contributory X25519 point checks.
    let (desktop_ephemeral_secret, desktop_ephemeral_public) = if client_ephemeral_key.is_some() {
        let secret = Zeroizing::new(StaticSecret::random_from_rng(OsRng).to_bytes());
        let public = *X25519PublicKey::from(&StaticSecret::from(*secret)).as_bytes();
        (Some(secret), Some(public))
    } else {
        (None, None)
    };

    let ready = E2eeReady {
        kind: "e2ee_ready",
        v: 2,
        desktop_public_key_b64: keypair.public_key_b64(),
        desktop_ephemeral_public_key_b64: desktop_ephemeral_public.map(|k| general_purpose::STANDARD.encode(k)),
        client_nonce_b64: hello.client_nonce_b64.clone(),
        desktop_nonce_b64: general_purpose::STANDARD.encode(desktop_nonce),
        selection: E2eeSelection {
            framing: 2,
            payload_kinds: ["text".into(), "binary".into()],
        },
        context: hello.context.clone(),
    };
    let transcript = encode_e2ee_transcript_with_ephemeral(
        &hello,
        &ready,
        &client_key,
        keypair.public(),
        client_ephemeral_key.as_ref().map(|k| k.as_slice()),
        desktop_ephemeral_public.as_ref().map(|k| k.as_slice()),
        &client_nonce,
        &desktop_nonce,
    );
    let ss = Zeroizing::new(nacl_box_before(keypair.secret(), &client_key)?);
    let ikm = match (desktop_ephemeral_secret.as_ref(), client_ephemeral_key.as_ref()) {
        (Some(eph_secret), Some(peer_eph)) => {
            let ee = Zeroizing::new(nacl_box_before(eph_secret, peer_eph)?);
            let mut combined = Zeroizing::new(Vec::with_capacity(64));
            combined.extend_from_slice(ss.as_slice());
            combined.extend_from_slice(ee.as_slice());
            combined
        }
        _ => Zeroizing::new(ss.as_slice().to_vec()),
    };
    let keys = derive_session_keys(&ikm, &transcript, &client_nonce, &desktop_nonce)?;
    Ok((
        ready,
        E2eeSession {
            inbound_key: keys.mobile_to_desktop,
            outbound_key: keys.desktop_to_mobile,
            session_id: keys.session_id,
            transcript_hash_b64: keys.transcript_hash_b64.clone(),
            client_public_key_b64: hello.client_public_key_b64,
            inbound_counter: 0,
            outbound_counter: 0,
            initiator: false,
        },
    ))
}

struct SessionKeys {
    mobile_to_desktop: [u8; 32],
    desktop_to_mobile: [u8; 32],
    session_id: [u8; 32],
    transcript_hash_b64: String,
}

impl Drop for SessionKeys {
    fn drop(&mut self) {
        self.mobile_to_desktop.zeroize();
        self.desktop_to_mobile.zeroize();
        self.session_id.zeroize();
    }
}

fn derive_session_keys(
    shared_secret: &[u8],
    transcript: &[u8],
    client_nonce: &[u8; 32],
    desktop_nonce: &[u8; 32],
) -> Result<SessionKeys> {
    let transcript_hash: [u8; 32] = Sha256::digest(transcript).into();
    let mut salt_input = b"terminalx-mobile-e2ee/v2/salt\0".to_vec();
    salt_input.extend_from_slice(client_nonce);
    salt_input.extend_from_slice(desktop_nonce);
    let salt = Sha256::digest(salt_input);
    let mut info = b"terminalx-mobile-e2ee/v2/session\0".to_vec();
    info.extend_from_slice(&transcript_hash);
    let mut expanded = Zeroizing::new([0u8; 96]);
    Hkdf::<Sha256>::new(Some(&salt), shared_secret)
        .expand(&info, expanded.as_mut())
        .map_err(|_| anyhow!("could not derive E2EE session keys"))?;
    Ok(SessionKeys {
        mobile_to_desktop: expanded[..32].try_into().unwrap(),
        desktop_to_mobile: expanded[32..64].try_into().unwrap(),
        session_id: expanded[64..].try_into().unwrap(),
        transcript_hash_b64: general_purpose::STANDARD.encode(transcript_hash),
    })
}

/// The initiator's half of the v2 handshake, as the phone runs it: the
/// desktop's cloud workspace client sends this hello to a runtime whose key
/// it pinned from the pairing offer.
pub struct E2eeClientHandshake {
    secret: [u8; 32],
    ephemeral_secret: [u8; 32],
    ephemeral_public: [u8; 32],
    desktop_key: [u8; 32],
    client_nonce: [u8; 32],
    hello: E2eeHello,
}

impl Drop for E2eeClientHandshake {
    fn drop(&mut self) {
        self.secret.zeroize();
        self.ephemeral_secret.zeroize();
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct E2eeReadyWire {
    #[serde(rename = "type")]
    kind: String,
    v: u8,
    desktop_public_key_b64: String,
    #[serde(default)]
    desktop_ephemeral_public_key_b64: Option<String>,
    client_nonce_b64: String,
    desktop_nonce_b64: String,
    selection: E2eeSelectionWire,
    context: E2eeContext,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct E2eeSelectionWire {
    framing: u8,
    payload_kinds: [String; 2],
}

impl E2eeClientHandshake {
    pub fn new(desktop_public_key_b64: &str, transport: &str, relay_host_id: Option<&str>) -> Result<Self> {
        Self::with_secret(StaticSecret::random_from_rng(OsRng).to_bytes(), desktop_public_key_b64, transport, relay_host_id)
    }

    /// [`Self::new`] for a client whose long-lived key is `secret`: a phone
    /// racing its direct and Relay candidates sends the same static key on both,
    /// paired with a fresh ephemeral X25519 key for forward secrecy.
    pub fn with_secret(secret: [u8; 32], desktop_public_key_b64: &str, transport: &str, relay_host_id: Option<&str>) -> Result<Self> {
        let desktop_key: [u8; 32] = decode_standard(desktop_public_key_b64, 32)?.try_into().unwrap();
        let secret = StaticSecret::from(secret);
        let public = X25519PublicKey::from(&secret);
        let ephemeral = StaticSecret::random_from_rng(OsRng);
        let ephemeral_public = *X25519PublicKey::from(&ephemeral).as_bytes();
        let mut client_nonce = [0u8; 32];
        OsRng.fill_bytes(&mut client_nonce);
        let hello = E2eeHello {
            kind: "e2ee_hello".into(),
            v: 2,
            client_public_key_b64: general_purpose::STANDARD.encode(public.as_bytes()),
            client_ephemeral_public_key_b64: Some(general_purpose::STANDARD.encode(ephemeral_public)),
            client_nonce_b64: general_purpose::STANDARD.encode(client_nonce),
            capabilities: E2eeCapabilities { framing: [2], payload_kinds: ["text".into(), "binary".into()] },
            context: E2eeContext {
                protocol: "terminalx-mobile-e2ee".into(),
                initiator: "mobile".into(),
                responder: "desktop".into(),
                transport: transport.into(),
                relay_host_id: relay_host_id.map(str::to_string),
            },
        };
        Ok(Self {
            secret: secret.to_bytes(),
            ephemeral_secret: ephemeral.to_bytes(),
            ephemeral_public,
            desktop_key,
            client_nonce,
            hello,
        })
    }

    pub fn hello(&self) -> &E2eeHello {
        &self.hello
    }

    /// Accept the host's ready only for the pinned key, this hello's nonce
    /// and context, and the one framing both sides support.
    pub fn accept_ready(self, ready: &str) -> Result<E2eeSession> {
        let wire: E2eeReadyWire = serde_json::from_str(ready).map_err(|_| anyhow!("invalid E2EE ready"))?;
        let desktop_nonce: [u8; 32] = decode_standard(&wire.desktop_nonce_b64, 32)?.try_into().unwrap();
        let desktop_key = decode_standard(&wire.desktop_public_key_b64, 32)?;
        let desktop_ephemeral_key: Option<[u8; 32]> = wire
            .desktop_ephemeral_public_key_b64
            .as_deref()
            .map(|b64| -> Result<[u8; 32]> { Ok(decode_standard(b64, 32)?.try_into().unwrap()) })
            .transpose()?;
        if wire.kind != "e2ee_ready"
            || wire.v != 2
            || !bool::from(subtle::ConstantTimeEq::ct_eq(desktop_key.as_slice(), self.desktop_key.as_slice()))
            || wire.client_nonce_b64 != self.hello.client_nonce_b64
            || wire.selection.framing != 2
            || wire.selection.payload_kinds != ["text", "binary"]
            || wire.context != self.hello.context
        {
            bail!("E2EE ready did not match the pinned runtime or this handshake");
        }
        let ready = E2eeReady {
            kind: "e2ee_ready",
            v: 2,
            desktop_public_key_b64: wire.desktop_public_key_b64,
            desktop_ephemeral_public_key_b64: wire.desktop_ephemeral_public_key_b64,
            client_nonce_b64: wire.client_nonce_b64,
            desktop_nonce_b64: wire.desktop_nonce_b64,
            selection: E2eeSelection { framing: 2, payload_kinds: ["text".into(), "binary".into()] },
            context: wire.context,
        };
        let client_public = X25519PublicKey::from(&StaticSecret::from(self.secret));
        let (client_eph_for_transcript, desktop_eph_for_transcript) = match desktop_ephemeral_key.as_ref() {
            Some(desktop_eph) => (Some(self.ephemeral_public.as_slice()), Some(desktop_eph.as_slice())),
            None => (None, None),
        };
        let transcript = encode_e2ee_transcript_with_ephemeral(
            &self.hello,
            &ready,
            client_public.as_bytes(),
            &self.desktop_key,
            client_eph_for_transcript,
            desktop_eph_for_transcript,
            &self.client_nonce,
            &desktop_nonce,
        );
        let ss = Zeroizing::new(nacl_box_before(&self.secret, &self.desktop_key)?);
        let ikm = match desktop_ephemeral_key.as_ref() {
            Some(peer_eph) => {
                let ee = Zeroizing::new(nacl_box_before(&self.ephemeral_secret, peer_eph)?);
                let mut combined = Zeroizing::new(Vec::with_capacity(64));
                combined.extend_from_slice(ss.as_slice());
                combined.extend_from_slice(ee.as_slice());
                combined
            }
            None => Zeroizing::new(ss.as_slice().to_vec()),
        };
        let keys = derive_session_keys(&ikm, &transcript, &self.client_nonce, &desktop_nonce)?;
        Ok(E2eeSession {
            inbound_key: keys.desktop_to_mobile,
            outbound_key: keys.mobile_to_desktop,
            session_id: keys.session_id,
            transcript_hash_b64: keys.transcript_hash_b64.clone(),
            client_public_key_b64: self.hello.client_public_key_b64.clone(),
            inbound_counter: 0,
            outbound_counter: 0,
            initiator: true,
        })
    }
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

fn nacl_box_before(secret: &[u8; 32], public: &[u8; 32]) -> Result<[u8; 32]> {
    let raw = StaticSecret::from(*secret).diffie_hellman(&X25519PublicKey::from(*public));
    if !raw.was_contributory() {
        bail!("peer X25519 public key is a low-order point");
    }
    let derived = <salsa20::Salsa20 as Kdf>::kdf(
        GenericArray::from_slice(raw.as_bytes()),
        &GenericArray::default(),
    );
    Ok(derived.into())
}

#[cfg(test)]
fn encode_e2ee_transcript(
    hello: &E2eeHello,
    ready: &E2eeReady,
    client_key: &[u8],
    desktop_key: &[u8],
    client_nonce: &[u8],
    desktop_nonce: &[u8],
) -> Vec<u8> {
    encode_e2ee_transcript_with_ephemeral(hello, ready, client_key, desktop_key, None, None, client_nonce, desktop_nonce)
}

#[allow(clippy::too_many_arguments)]
fn encode_e2ee_transcript_with_ephemeral(
    hello: &E2eeHello,
    ready: &E2eeReady,
    client_key: &[u8],
    desktop_key: &[u8],
    client_ephemeral_key: Option<&[u8]>,
    desktop_ephemeral_key: Option<&[u8]>,
    client_nonce: &[u8],
    desktop_nonce: &[u8],
) -> Vec<u8> {
    let framing_list = encode_number_list(&[2]);
    let payload_kinds = encode_string_list(&["text", "binary"]);
    let relay_id = hello.context.relay_host_id.as_deref().unwrap_or("");
    let mut fields: Vec<(&str, Vec<u8>)> = vec![
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
    if let (Some(c_eph), Some(d_eph)) = (client_ephemeral_key, desktop_ephemeral_key) {
        fields.push(("mobile-to-desktop.client-ephemeral-public-key", c_eph.to_vec()));
        fields.push(("desktop-to-mobile.desktop-ephemeral-public-key", d_eph.to_vec()));
    }
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
        let expected = frame_nonce(&self.session_id, self.initiator, kind, self.inbound_counter);
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
        let expected_header = frame_header(&self.session_id, self.initiator, kind, self.inbound_counter);
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
        let nonce = frame_nonce(&self.session_id, !self.initiator, kind, self.outbound_counter);
        let mut plaintext = frame_header(&self.session_id, !self.initiator, kind, self.outbound_counter);
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
            client_ephemeral_public_key_b64: None,
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
            desktop_ephemeral_public_key_b64: None,
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
            initiator: false,
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
            initiator: false,
        };
        // Flip the direction to model a mobile-originated fixture.
        let mut phone_frame = frame;
        phone_frame[13] = 0;
        assert!(receiver.open(&phone_frame, PayloadKind::Text).is_err());
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn rejects_low_order_x25519_public_keys() {
        let host = HostKeypair::generate();
        let all_zero = [0u8; 32];
        assert!(nacl_box_before(host.secret(), &all_zero).is_err());
        let mut order_two = [0u8; 32];
        order_two[0] = 1;
        assert!(nacl_box_before(host.secret(), &order_two).is_err());

        let hello = E2eeHello {
            kind: "e2ee_hello".into(),
            v: 2,
            client_public_key_b64: general_purpose::STANDARD.encode(all_zero),
            client_ephemeral_public_key_b64: None,
            client_nonce_b64: general_purpose::STANDARD.encode([9u8; 32]),
            capabilities: E2eeCapabilities {
                framing: [2],
                payload_kinds: ["text".into(), "binary".into()],
            },
            context: E2eeContext {
                protocol: "terminalx-mobile-e2ee".into(),
                initiator: "mobile".into(),
                responder: "desktop".into(),
                transport: "direct".into(),
                relay_host_id: None,
            },
        };
        assert!(begin_e2ee_session(&host, hello, "direct", None).is_err());
    }

    #[test]
    fn hybrid_ephemeral_handshake_provides_forward_secrecy_with_same_static_keys() {
        let host = HostKeypair::generate();
        let static_client = [42u8; 32];
        let h1 = E2eeClientHandshake::with_secret(static_client, &host.public_key_b64(), "direct", None).unwrap();
        let h2 = E2eeClientHandshake::with_secret(static_client, &host.public_key_b64(), "direct", None).unwrap();
        assert!(h1.hello().client_ephemeral_public_key_b64.is_some());
        assert_ne!(h1.hello().client_ephemeral_public_key_b64, h2.hello().client_ephemeral_public_key_b64);

        let (r1, mut srv1) = begin_e2ee_session(&host, h1.hello().clone(), "direct", None).unwrap();
        let (r2, mut srv2) = begin_e2ee_session(&host, h2.hello().clone(), "direct", None).unwrap();
        assert!(r1.desktop_ephemeral_public_key_b64.is_some());
        assert_ne!(r1.desktop_ephemeral_public_key_b64, r2.desktop_ephemeral_public_key_b64);

        let mut cli1 = h1.accept_ready(&serde_json::to_string(&r1).unwrap()).unwrap();
        let cli2 = h2.accept_ready(&serde_json::to_string(&r2).unwrap()).unwrap();
        assert_ne!(cli1.inbound_key, cli2.inbound_key);
        assert_ne!(cli1.outbound_key, cli2.outbound_key);

        let frame = cli1.seal(b"hello-forward-secret", PayloadKind::Text).unwrap();
        assert_eq!(srv1.open(&frame, PayloadKind::Text).unwrap(), b"hello-forward-secret");
        assert!(srv2.open(&frame, PayloadKind::Text).is_err());
    }

    #[test]
    fn relay_transcript_rejects_overflowing_and_negative_timestamps() {
        let host = HostKeypair::generate();
        let encode_fields = |issued_at: u64, expires_at: u64| -> Vec<u8> {
            let mut out = Vec::new();
            let fields: [(&str, Vec<u8>); 16] = [
                ("protocol", b"terminalx-relay-host-proof/v1".to_vec()),
                ("version", vec![1]),
                ("relayOrigin", b"https://relay.terminalx.ai".to_vec()),
                ("relayEphemeralPublicKey", vec![1u8; 32]),
                ("challengeNonce", vec![2u8; 24]),
                ("challengeId", b"chg_1".to_vec()),
                ("userId", b"u1".to_vec()),
                ("profileId", b"p1".to_vec()),
                ("organizationId", b"o1".to_vec()),
                ("relayHostId", host.host_id().into_bytes()),
                ("hostPublicKey", host.public().to_vec()),
                ("assignmentEpoch", 1u64.to_be_bytes().to_vec()),
                ("previousGeneration", vec![]),
                ("resumeRequested", vec![0]),
                ("issuedAt", issued_at.to_be_bytes().to_vec()),
                ("expiresAt", expires_at.to_be_bytes().to_vec()),
            ];
            for (k, v) in fields {
                out.extend_from_slice(&(k.len() as u32).to_be_bytes());
                out.extend_from_slice(k.as_bytes());
                out.extend_from_slice(&(v.len() as u32).to_be_bytes());
                out.extend_from_slice(&v);
            }
            out
        };
        let host_id = host.host_id();
        let ctx = RelayProofContext {
            relay_origin: "https://relay.terminalx.ai",
            user_id: "u1",
            profile_id: "p1",
            organization_id: "o1",
            relay_host_id: &host_id,
            assignment_epoch: 1,
            previous_generation: None,
            resume_requested: false,
            now_ms: 1_700_000_000_000,
        };
        // u64::MAX must never wrap to negative i64 and pass skew checks.
        let overflow = encode_fields(u64::MAX, 1_700_000_005_000);
        assert!(validate_relay_transcript(&overflow, "chg_1", &[1u8; 32], &[2u8; 24], 1_700_000_005_000, &host, &ctx).is_err());
        // Negative challenge expiry must be rejected cleanly.
        let valid_ts = encode_fields(1_700_000_000_000, 1_700_000_005_000);
        assert!(validate_relay_transcript(&valid_ts, "chg_1", &[1u8; 32], &[2u8; 24], -1, &host, &ctx).is_err());
        // Valid window passes.
        assert!(validate_relay_transcript(&valid_ts, "chg_1", &[1u8; 32], &[2u8; 24], 1_700_000_005_000, &host, &ctx).is_ok());
    }
}
