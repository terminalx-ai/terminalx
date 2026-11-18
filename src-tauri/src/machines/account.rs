//! Pairing with a machine through the account (docs/MACHINES.md "Pairing
//! through the account"; terminalx-server `machine-relay-access.md`): the
//! operating computer's side. PRO-349 builds it.
//!
//! It mirrors the phone (`mobile/src/pairing/account.ts`) with scope
//! `runtime`:
//!
//! 1. This installation registers a P-256 key with the account
//!    (`PUT /v1/account/client-installations/:id`), advertising
//!    `account-bound-host-pairing.v1` and `machine-operating.v1`. The key, its
//!    installation id and user stay in the Keychain ([`super::secrets`]).
//! 2. [`AccountPairing::list`] reads `GET /v1/account/hosts` and maps it to
//!    `MachineAccountDirectory` (src/types/machines.ts).
//! 3. [`AccountPairing::request`] asks for a one-time `runtime` grant, signed
//!    with the installation key, and waits for the machine to seal its offer
//!    to a one-request X25519 key. The opened offer is exactly the JSON of a
//!    `txm2.` machine code, so it goes back to the dialog as one: the dialog
//!    inspects it, shows the fingerprint and pairs it as a pasted code (the
//!    machine still waits for Allow).
//! 4. [`AccountPairing::finish`] consumes the grant once paired, and revokes
//!    it otherwise.
//!
//! No request carries a project name, a path, a session title or any other
//! workspace data: only this Mac's name and platform, keys, ids and nonces.
//! Nothing here logs a key, a token or an offer.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use hpke::{aead::ChaCha20Poly1305, kdf::HkdfSha256, kem::X25519HkdfSha256, Deserializable, Kem as _, OpModeR, Serializable};
use rand_core::{OsRng, RngCore};
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::account::{AccountContext, AccountManager};
use crate::machine_wire::{MachineCode, CODE_PREFIX};

use super::Machines;

pub const PAIRING_CAPABILITY: &str = "account-bound-host-pairing.v1";
pub const OPERATING_CAPABILITY: &str = "machine-operating.v1";
/// Sorted, as the registration transcript lists them.
const CAPABILITIES: [&str; 2] = [PAIRING_CAPABILITY, OPERATING_CAPABILITY];
const REGISTRATION_DOMAIN: &str = "terminalx-client-installation-registration/v1";
const GRANT_DOMAIN: &str = "terminalx-pairing-grant-request/v1";
/// The grant's scope, and the signed transcript's last line.
pub const REQUESTED_SCOPE: &str = "runtime";
pub const HPKE_ALGORITHM: &str = "HPKE-Base-X25519-HKDF-SHA256-ChaCha20Poly1305";
/// As long as the server keeps a grant.
pub const GRANT_WAIT: Duration = Duration::from_secs(5 * 60);
pub const GRANT_POLL: Duration = Duration::from_secs(2);
const INSTALLATION_VERSION: u8 = 1;

// ---------------------------------------------------------------- shapes (src/types/machines.ts)

/// `MachineAccountDirectory`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum MachineAccountDirectory {
    SignedOut { signed_in: bool },
    SignedIn { signed_in: bool, installation: InstallationState, machines: Vec<AccountMachine> },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallationState {
    Ready,
    ApprovalRequired,
    ReauthenticationRequired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Availability {
    Online,
    Offline,
    NotAvailable,
}

/// `AccountMachine`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountMachine {
    pub host_id: String,
    pub machine_id: String,
    pub name: String,
    pub platform: Option<String>,
    pub environment_kind: Option<String>,
    pub availability: Availability,
    pub last_seen_at: Option<i64>,
    pub this_mac: bool,
    pub paired: bool,
}

/// `MachineAccountOffer`. The code holds a device token: never logged.
#[derive(Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineAccountOffer {
    pub code: String,
    pub grant_request_id: String,
}

/// Never print the code.
impl std::fmt::Debug for MachineAccountOffer {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.debug_struct("MachineAccountOffer").field("grantRequestId", &self.grant_request_id).finish_non_exhaustive()
    }
}

// ---------------------------------------------------------------- the account API's shapes

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountHost {
    host_id: String,
    host_public_key_b64: String,
    binding_generation: u64,
    display_name: String,
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    environment_kind: Option<String>,
    #[serde(default)]
    capabilities: Vec<String>,
    reachability: String,
    #[serde(default)]
    last_seen_at: Option<String>,
}

#[derive(Deserialize)]
struct HostList {
    hosts: Vec<AccountHost>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Grant {
    grant_request_id: String,
    client_installation_id: String,
    binding_generation: u64,
    state: String,
    associated_data: String,
    #[serde(default)]
    envelope: Option<Envelope>,
}

#[derive(Deserialize)]
struct GrantResponse {
    grant: Grant,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Envelope {
    pub version: u8,
    pub algorithm: String,
    pub encapsulated_key: String,
    pub ciphertext: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registration {
    installation: RegisteredInstallation,
    reauthentication_required: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisteredInstallation {
    trust_state: String,
}

// ---------------------------------------------------------------- the installation

/// This installation's identity on the account, kept whole in the Keychain.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Installation {
    version: u8,
    user_id: String,
    client_installation_id: String,
    /// PKCS#8 of the P-256 key, base64url.
    private_key_pkcs8: String,
}

impl Installation {
    fn create(user_id: &str) -> Result<Self> {
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new()).map_err(|_| anyhow!("could not make the installation key"))?;
        Ok(Self {
            version: INSTALLATION_VERSION,
            user_id: user_id.into(),
            client_installation_id: uuid::Uuid::new_v4().to_string(),
            private_key_pkcs8: URL_SAFE_NO_PAD.encode(pkcs8.as_ref()),
        })
    }

    fn key(&self) -> Result<EcdsaKeyPair> {
        let pkcs8 = Zeroizing::new(URL_SAFE_NO_PAD.decode(&self.private_key_pkcs8).context("the saved installation key is invalid")?);
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &pkcs8, &SystemRandom::new()).map_err(|_| anyhow!("the saved installation key is invalid"))
    }

    /// IEEE-P1363 ECDSA-P256-SHA256 over `domain` and `fields`, one per line, base64url.
    fn sign(&self, domain: &str, fields: &[&str]) -> Result<String> {
        let transcript = std::iter::once(domain).chain(fields.iter().copied()).collect::<Vec<_>>().join("\n");
        let signature = self.key()?.sign(&SystemRandom::new(), transcript.as_bytes()).map_err(|_| anyhow!("could not sign with the installation key"))?;
        Ok(URL_SAFE_NO_PAD.encode(signature.as_ref()))
    }

    /// The public key as a JWK of `kty`, `crv`, `x`, `y`, and its RFC 7638 thumbprint.
    fn public_jwk(&self) -> Result<(Value, String)> {
        let key = self.key()?;
        let point = key.public_key().as_ref();
        if point.len() != 65 || point[0] != 4 {
            return Err(anyhow!("the installation key is not an uncompressed P-256 point"));
        }
        let (x, y) = (URL_SAFE_NO_PAD.encode(&point[1..33]), URL_SAFE_NO_PAD.encode(&point[33..65]));
        let canonical = format!(r#"{{"crv":"P-256","kty":"EC","x":"{x}","y":"{y}"}}"#);
        let thumbprint = URL_SAFE_NO_PAD.encode(Sha256::digest(canonical.as_bytes()));
        Ok((json!({ "kty": "EC", "crv": "P-256", "x": x, "y": y }), thumbprint))
    }
}

// ---------------------------------------------------------------- refusals

/// A refusal the UI reads by its prefix (`MachineAccountOffer` in src/types/machines.ts).
fn refuse(prefix: &str, message: impl std::fmt::Display) -> String {
    format!("{prefix}: {message}")
}

fn not_signed_in() -> String {
    refuse("not_signed_in", "Sign in to TerminalX to pair through your account.")
}

enum CallError {
    /// The service answered with this status and, when it said, its error code.
    Status { status: u16, code: Option<String> },
    Other(anyhow::Error),
}

impl CallError {
    fn is_transport(&self) -> bool {
        matches!(self, Self::Other(_))
    }

    /// As the UI reads it: an expired session is `not_signed_in:`.
    fn refusal(&self) -> String {
        match self {
            Self::Status { status: 401, .. } => not_signed_in(),
            Self::Status { status, code: Some(code) } => format!("The account service refused the request ({code}, HTTP {status})."),
            Self::Status { status, code: None } => format!("The account service refused the request (HTTP {status})."),
            Self::Other(error) => format!("The account service could not be reached ({error:#})."),
        }
    }
}

impl From<anyhow::Error> for CallError {
    fn from(error: anyhow::Error) -> Self {
        Self::Other(error)
    }
}

// ---------------------------------------------------------------- cancelling

#[derive(Default)]
struct Cancel {
    cancelled: Mutex<bool>,
    wake: Condvar,
}

impl Cancel {
    fn cancel(&self) {
        *self.cancelled.lock().unwrap() = true;
        self.wake.notify_all();
    }

    fn is_cancelled(&self) -> bool {
        *self.cancelled.lock().unwrap()
    }

    /// Sleep `duration` unless cancelled first; true when cancelled.
    fn sleep(&self, duration: Duration) -> bool {
        let guard = self.cancelled.lock().unwrap();
        let (guard, _) = self.wake.wait_timeout_while(guard, duration, |cancelled| !*cancelled).unwrap();
        *guard
    }
}

/// What finishing a grant needs, remembered from its request.
#[derive(Clone)]
struct GrantMemo {
    user_id: String,
    client_installation_id: String,
    binding_generation: u64,
}

type ContextSource = Box<dyn Fn() -> Option<AccountContext> + Send + Sync>;
type ThisMacSource = Box<dyn Fn() -> Vec<String> + Send + Sync>;

pub struct AccountPairing {
    machines: Arc<Machines>,
    context: ContextSource,
    /// This Mac's machine ids: the runtime's host key, and the window's phone pairing key.
    this_mac: ThisMacSource,
    /// `None`: `crate::account::api_base_url()`.
    base_url: Option<String>,
    wait: Duration,
    poll: Duration,
    request: Mutex<Option<Arc<Cancel>>>,
    grants: Mutex<HashMap<String, GrantMemo>>,
    /// Held while the installation is read, made or replaced, so two calls make one.
    installation_gate: Mutex<()>,
}

impl AccountPairing {
    pub fn new(machines: Arc<Machines>, account: Arc<AccountManager>, pairing: Arc<crate::pairing::PairingManager>) -> Self {
        let runtime = machines.clone();
        Self::with(
            machines,
            Box::new(move || account.context()),
            Box::new(move || {
                let runtime_id = runtime.last_status.lock().unwrap().as_ref().and_then(|status| status.machine_id.clone());
                runtime_id.into_iter().chain(pairing.host_id()).collect()
            }),
            None,
            GRANT_WAIT,
            GRANT_POLL,
        )
    }

    fn with(machines: Arc<Machines>, context: ContextSource, this_mac: ThisMacSource, base_url: Option<String>, wait: Duration, poll: Duration) -> Self {
        Self {
            machines,
            context,
            this_mac,
            base_url,
            wait,
            poll,
            request: Mutex::new(None),
            grants: Mutex::new(HashMap::new()),
            installation_gate: Mutex::new(()),
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(machines: Arc<Machines>, context: Option<AccountContext>, this_mac: Vec<String>, base_url: String, wait: Duration, poll: Duration) -> Self {
        Self::with(machines, Box::new(move || context.clone()), Box::new(move || this_mac.clone()), Some(base_url), wait, poll)
    }

    /// `machines_account_list`. Blocking.
    pub fn list(&self) -> Result<MachineAccountDirectory, String> {
        let Some(context) = (self.context)() else { return Ok(MachineAccountDirectory::SignedOut { signed_in: false }) };
        let (_, state) = self.register(&context)?;
        if state != InstallationState::Ready {
            return Ok(MachineAccountDirectory::SignedIn { signed_in: true, installation: state, machines: Vec::new() });
        }
        let hosts = self.hosts(&context)?;
        let this_mac: HashSet<String> = (self.this_mac)().into_iter().collect();
        let paired: HashSet<String> = self.machines.store().and_then(|store| store.list()).map_err(|error| format!("{error:#}"))?.into_iter().map(|machine| machine.machine_id).collect();
        let machines = hosts
            .iter()
            .filter_map(|host| match account_machine(host, &this_mac, &paired) {
                Ok(machine) => Some(machine),
                Err(error) => {
                    log::warn!("machines: the account lists host {} with an unusable key: {error:#}", host.host_id);
                    None
                }
            })
            .collect();
        Ok(MachineAccountDirectory::SignedIn { signed_in: true, installation: state, machines })
    }

    /// `machines_account_request`: a one-time `runtime` grant for `host_id`,
    /// waited for, its offer as a `txm2.` code. Blocking; a newer request or
    /// [`Self::cancel`] ends it as `cancelled:`.
    pub fn request(&self, host_id: &str) -> Result<MachineAccountOffer, String> {
        let cancel = Arc::new(Cancel::default());
        if let Some(previous) = self.request.lock().unwrap().replace(cancel.clone()) {
            previous.cancel();
        }
        let result = self.request_with(host_id, &cancel);
        let mut current = self.request.lock().unwrap();
        if current.as_ref().is_some_and(|current| Arc::ptr_eq(current, &cancel)) {
            *current = None;
        }
        result
    }

    /// `machines_account_cancel`.
    pub fn cancel(&self) {
        if let Some(cancel) = self.request.lock().unwrap().take() {
            cancel.cancel();
        }
    }

    /// `machines_account_finish`: consume the grant once paired, revoke it when not. Blocking.
    pub fn finish(&self, grant_request_id: &str, paired: bool) -> Result<(), String> {
        let memo = self.grants.lock().unwrap().remove(grant_request_id).ok_or_else(|| format!("No account pairing {grant_request_id} is waiting to finish."))?;
        let Some(context) = (self.context)().filter(|context| context.user_id == memo.user_id) else { return Err(not_signed_in()) };
        let outcome = if paired { self.consume(&context, grant_request_id, &memo) } else { self.revoke(&context, grant_request_id, &memo) };
        if let Err(error) = outcome {
            // Kept, so finishing again can retry it.
            self.grants.lock().unwrap().insert(grant_request_id.to_string(), memo);
            return Err(error.refusal());
        }
        Ok(())
    }

    fn request_with(&self, host_id: &str, cancel: &Cancel) -> Result<MachineAccountOffer, String> {
        let Some(context) = (self.context)() else { return Err(not_signed_in()) };
        let (installation, state) = self.register(&context)?;
        if state != InstallationState::Ready {
            return Err(refuse("not_signed_in", "Sign in to TerminalX again to let this Mac pair through your account."));
        }
        let host = self.hosts(&context)?.into_iter().find(|host| host.host_id == host_id).ok_or_else(|| refuse("machine_not_available", "This machine is no longer on your account."))?;
        let host_key = host_key(&host).map_err(|error| refuse("key_mismatch", format!("{error:#}")))?;
        if !advertises_operating(&host) {
            return Err(refuse("machine_not_available", "\"Let other computers operate this Mac\" is off on this machine."));
        }
        if host.reachability != "live" {
            return Err(refuse("machine_offline", "This machine is offline."));
        }
        if cancel.is_cancelled() {
            return Err(refuse("cancelled", "Cancelled."));
        }

        let (recipient, recipient_public) = X25519HkdfSha256::gen_keypair();
        let ephemeral = URL_SAFE_NO_PAD.encode(recipient_public.to_bytes());
        let grant_request_id = uuid::Uuid::new_v4().to_string();
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let nonce = URL_SAFE_NO_PAD.encode(nonce);
        let generation = host.binding_generation.to_string();
        let fields = [
            installation.user_id.as_str(),
            host.host_id.as_str(),
            installation.client_installation_id.as_str(),
            grant_request_id.as_str(),
            generation.as_str(),
            ephemeral.as_str(),
            nonce.as_str(),
            REQUESTED_SCOPE,
        ];
        let proof_signature = installation.sign(GRANT_DOMAIN, &fields).map_err(|error| format!("{error:#}"))?;
        let body = json!({
            "userId": installation.user_id,
            "hostId": host.host_id,
            "clientInstallationId": installation.client_installation_id,
            "grantRequestId": grant_request_id,
            "bindingGeneration": host.binding_generation,
            "clientEphemeralPublicKey": ephemeral,
            "nonce": nonce,
            "requestedScope": REQUESTED_SCOPE,
            "proofSignature": proof_signature,
        });
        let mut grant = match self.call::<GrantResponse>(&context, "POST", "/v1/account/pairing-grant-requests", Some(body)) {
            Ok(response) => response.grant,
            Err(CallError::Status { status: 409, code: Some(code) }) if code == "host_binding_operating_unavailable" => {
                return Err(refuse("machine_not_available", "\"Let other computers operate this Mac\" is off on this machine."));
            }
            Err(error) => return Err(error.refusal()),
        };
        let memo = GrantMemo { user_id: installation.user_id.clone(), client_installation_id: grant.client_installation_id.clone(), binding_generation: grant.binding_generation };
        let give_up = |refusal: String| {
            if let Err(error) = self.revoke(&context, &grant_request_id, &memo) {
                log::warn!("machines: could not revoke account grant {grant_request_id}: {}", error.refusal());
            }
            Err(refusal)
        };

        let deadline = Instant::now() + self.wait;
        let poll_path = format!("/v1/account/pairing-grant-requests/{grant_request_id}?clientInstallationId={}", installation.client_installation_id);
        loop {
            match grant.state.as_str() {
                "pending" => {}
                "granted" => break,
                "expired" => return Err(refuse("grant_expired", "The machine did not answer in time.")),
                "rejected" | "revoked" => return Err(refuse("grant_refused", "The machine refused to pair.")),
                other => return give_up(refuse("grant_refused", format!("The grant is {other}."))),
            }
            if Instant::now() >= deadline {
                return give_up(refuse("grant_expired", "The machine did not answer in time."));
            }
            if cancel.sleep(self.poll) {
                return give_up(refuse("cancelled", "Cancelled."));
            }
            match self.call::<GrantResponse>(&context, "GET", &poll_path, None) {
                Ok(response) => grant = response.grant,
                // A dropped connection is retried until the deadline.
                Err(error) if error.is_transport() => log::debug!("machines: polling account grant {grant_request_id}: {}", error.refusal()),
                Err(error) => return give_up(error.refusal()),
            }
        }

        let Some(envelope) = grant.envelope.as_ref() else { return give_up(refuse("grant_refused", "The machine granted no offer.")) };
        let plaintext = match open_envelope(&recipient, envelope, &grant.associated_data) {
            Ok(plaintext) => plaintext,
            Err(error) => return give_up(refuse("grant_refused", format!("The machine's offer could not be opened ({error:#})."))),
        };
        let code = match offer_code(&plaintext, &host_key) {
            Ok(code) => code,
            Err(refusal) => return give_up(refusal),
        };
        if cancel.is_cancelled() {
            return give_up(refuse("cancelled", "Cancelled."));
        }
        self.grants.lock().unwrap().insert(grant.grant_request_id.clone(), memo);
        Ok(MachineAccountOffer { code, grant_request_id: grant.grant_request_id })
    }

    /// Register this installation (made the first time, or again for another
    /// user or once the account refuses it), and its trust state.
    fn register(&self, context: &AccountContext) -> Result<(Installation, InstallationState), String> {
        let _gate = self.installation_gate.lock().unwrap();
        let installation = match self.saved_installation().map_err(|error| format!("{error:#}"))? {
            Some(saved) if saved.user_id == context.user_id => saved,
            _ => self.new_installation(&context.user_id).map_err(|error| format!("{error:#}"))?,
        };
        match self.register_once(context, &installation) {
            Ok(state) => Ok((installation, state)),
            Err(CallError::Status { status: 409, code: Some(code) })
                if matches!(code.as_str(), "client_installation_revoked" | "client_installation_owner_conflict" | "client_installation_key_mismatch") =>
            {
                // This identity cannot be used again: make a new one.
                let installation = self.new_installation(&context.user_id).map_err(|error| format!("{error:#}"))?;
                let state = self.register_once(context, &installation).map_err(|error| error.refusal())?;
                Ok((installation, state))
            }
            Err(error) => Err(error.refusal()),
        }
    }

    fn register_once(&self, context: &AccountContext, installation: &Installation) -> Result<InstallationState, CallError> {
        let (jwk, thumbprint) = installation.public_jwk()?;
        let device_label = super::this_computer_label();
        let platform = std::env::consts::OS;
        let capabilities = CAPABILITIES.join(",");
        let mut nonce = [0u8; 24];
        OsRng.fill_bytes(&mut nonce);
        let proof_nonce = URL_SAFE_NO_PAD.encode(nonce);
        let fields = [
            installation.user_id.as_str(),
            installation.client_installation_id.as_str(),
            thumbprint.as_str(),
            device_label.as_str(),
            platform,
            capabilities.as_str(),
            proof_nonce.as_str(),
        ];
        let proof_signature = installation.sign(REGISTRATION_DOMAIN, &fields)?;
        let body = json!({
            "userId": installation.user_id,
            "publicKeyJwk": jwk,
            "deviceLabel": device_label,
            "platform": platform,
            "capabilities": CAPABILITIES,
            "proofNonce": proof_nonce,
            "proofSignature": proof_signature,
        });
        let path = format!("/v1/account/client-installations/{}", installation.client_installation_id);
        let registration: Registration = self.call(context, "PUT", &path, Some(body))?;
        Ok(match (registration.reauthentication_required, registration.installation.trust_state.as_str()) {
            (true, _) => InstallationState::ReauthenticationRequired,
            (false, "trusted") => InstallationState::Ready,
            _ => InstallationState::ApprovalRequired,
        })
    }

    fn saved_installation(&self) -> Result<Option<Installation>> {
        let Some(bytes) = self.machines.secrets.load_installation()? else { return Ok(None) };
        match serde_json::from_slice::<Installation>(&bytes) {
            Ok(installation) if installation.version == INSTALLATION_VERSION && installation.key().is_ok() => Ok(Some(installation)),
            _ => {
                log::warn!("machines: the saved account installation is unreadable; making a new one");
                Ok(None)
            }
        }
    }

    fn new_installation(&self, user_id: &str) -> Result<Installation> {
        let installation = Installation::create(user_id)?;
        let bytes = Zeroizing::new(serde_json::to_vec(&installation)?);
        self.machines.secrets.save_installation(&bytes)?;
        Ok(installation)
    }

    fn hosts(&self, context: &AccountContext) -> Result<Vec<AccountHost>, String> {
        self.call::<HostList>(context, "GET", "/v1/account/hosts", None).map(|list| list.hosts).map_err(|error| error.refusal())
    }

    fn consume(&self, context: &AccountContext, grant_request_id: &str, memo: &GrantMemo) -> Result<(), CallError> {
        let body = json!({ "userId": memo.user_id, "clientInstallationId": memo.client_installation_id, "bindingGeneration": memo.binding_generation });
        self.call::<Value>(context, "POST", &format!("/v1/account/pairing-grant-requests/{grant_request_id}/consume"), Some(body)).map(drop)
    }

    fn revoke(&self, context: &AccountContext, grant_request_id: &str, memo: &GrantMemo) -> Result<(), CallError> {
        let body = json!({ "userId": memo.user_id, "clientInstallationId": memo.client_installation_id, "reason": "user-request" });
        self.call::<Value>(context, "POST", &format!("/v1/account/pairing-grant-requests/{grant_request_id}/revoke"), Some(body)).map(drop)
    }

    fn call<T: DeserializeOwned>(&self, context: &AccountContext, method: &str, path: &str, body: Option<Value>) -> Result<T, CallError> {
        if context.access_token.is_empty() {
            return Err(CallError::Status { status: 401, code: None });
        }
        let base = self.base_url.clone().unwrap_or_else(crate::account::api_base_url);
        let request = crate::account::cloud_agent().request(method, &format!("{base}{path}")).set("authorization", &format!("Bearer {}", context.access_token));
        let response = match body {
            Some(body) => request.set("content-type", "application/json").send_json(body),
            None => request.call(),
        };
        match response {
            Ok(response) => response.into_json::<T>().context("the account service answered an unexpected shape").map_err(CallError::Other),
            Err(ureq::Error::Status(status, response)) => {
                let code = response.into_json::<Value>().ok().and_then(|body| body.get("error").and_then(Value::as_str).map(str::to_string));
                Err(CallError::Status { status, code })
            }
            Err(ureq::Error::Transport(error)) => Err(CallError::Other(anyhow!(error).context("account request failed"))),
        }
    }
}

/// The host's key, checked against its id.
fn host_key(host: &AccountHost) -> Result<[u8; 32]> {
    let key: [u8; 32] = STANDARD.decode(&host.host_public_key_b64).ok().and_then(|key| key.try_into().ok()).context("the machine's key on the account is invalid")?;
    if crate::relay_e2ee::host_id_of(&key) != host.host_id {
        return Err(anyhow!("the machine's key on the account does not match its id"));
    }
    Ok(key)
}

/// A `runtime` grant needs both: the server refuses one otherwise.
fn advertises_operating(host: &AccountHost) -> bool {
    CAPABILITIES.iter().all(|capability| host.capabilities.iter().any(|advertised| advertised == capability))
}

fn account_machine(host: &AccountHost, this_mac: &HashSet<String>, paired: &HashSet<String>) -> Result<AccountMachine> {
    let machine_id = crate::relay_e2ee::host_id_of(&host_key(host)?);
    let availability = match (advertises_operating(host), host.reachability.as_str()) {
        (false, _) => Availability::NotAvailable,
        (true, "live") => Availability::Online,
        (true, _) => Availability::Offline,
    };
    Ok(AccountMachine {
        host_id: host.host_id.clone(),
        name: host.display_name.clone(),
        platform: host.platform.clone(),
        environment_kind: host.environment_kind.clone(),
        availability,
        last_seen_at: host.last_seen_at.as_deref().and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok()).map(|at| at.timestamp_millis()),
        this_mac: this_mac.contains(&machine_id),
        paired: paired.contains(&machine_id),
        machine_id,
    })
}

/// Open a grant's envelope with the request's X25519 key: the counterpart of
/// `pairing::crypto::seal_account_offer`.
pub(crate) fn open_envelope(recipient: &<X25519HkdfSha256 as hpke::Kem>::PrivateKey, envelope: &Envelope, associated_data: &str) -> Result<Zeroizing<Vec<u8>>> {
    type Kem = X25519HkdfSha256;
    if envelope.version != 1 || envelope.algorithm != HPKE_ALGORITHM {
        return Err(anyhow!("unsupported envelope"));
    }
    let encapsulated = URL_SAFE_NO_PAD.decode(&envelope.encapsulated_key).context("decode the encapsulated key")?;
    let encapsulated = <Kem as hpke::Kem>::EncappedKey::from_bytes(&encapsulated).map_err(|_| anyhow!("invalid encapsulated key"))?;
    let ciphertext = URL_SAFE_NO_PAD.decode(&envelope.ciphertext).context("decode the ciphertext")?;
    let aad = URL_SAFE_NO_PAD.decode(associated_data).context("decode the associated data")?;
    let mut context = hpke::setup_receiver::<ChaCha20Poly1305, HkdfSha256, Kem>(&OpModeR::Base, recipient, &encapsulated, b"").map_err(|_| anyhow!("could not open the envelope"))?;
    context.open(&ciphertext, &aad).map(Zeroizing::new).map_err(|_| anyhow!("the envelope does not open with this request's key"))
}

/// The opened offer as a `txm2.` code: its bytes unchanged, once its key is
/// the account's key for that host and its machine id is that key's.
pub(crate) fn offer_code(plaintext: &[u8], host_key: &[u8; 32]) -> Result<String, String> {
    let offer: MachineCode = serde_json::from_slice(plaintext).map_err(|_| refuse("grant_refused", "The machine's offer is not a machine pairing code."))?;
    let offered_key = STANDARD.decode(&offer.public_key_b64).ok();
    if offered_key.as_deref() != Some(host_key.as_slice()) {
        return Err(refuse("key_mismatch", "The machine's offer names another key than your account lists for it."));
    }
    if offer.machine.machine_id != crate::relay_e2ee::host_id_of(host_key) {
        return Err(refuse("key_mismatch", "The machine's offer names another machine than its key."));
    }
    let code = format!("{CODE_PREFIX}{}", URL_SAFE_NO_PAD.encode(plaintext));
    MachineCode::decode(&code).map_err(|error| refuse("grant_refused", format!("The machine's offer is not a usable pairing code ({error:#}).")))?;
    Ok(code)
}

// ---------------------------------------------------------------- Tauri commands

type CmdResult<T> = Result<T, String>;

#[tauri::command]
pub async fn machines_account_list(pairing: tauri::State<'_, Arc<AccountPairing>>) -> CmdResult<MachineAccountDirectory> {
    let pairing = pairing.inner().clone();
    tauri::async_runtime::spawn_blocking(move || pairing.list()).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn machines_account_request(host_id: String, pairing: tauri::State<'_, Arc<AccountPairing>>) -> CmdResult<MachineAccountOffer> {
    let pairing = pairing.inner().clone();
    tauri::async_runtime::spawn_blocking(move || pairing.request(&host_id)).await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn machines_account_cancel(pairing: tauri::State<'_, Arc<AccountPairing>>) {
    pairing.cancel();
}

#[tauri::command]
pub async fn machines_account_finish(grant_request_id: String, paired: bool, pairing: tauri::State<'_, Arc<AccountPairing>>) -> CmdResult<()> {
    let pairing = pairing.inner().clone();
    tauri::async_runtime::spawn_blocking(move || pairing.finish(&grant_request_id, paired)).await.map_err(|error| error.to_string())?
}

#[cfg(test)]
#[path = "account_tests.rs"]
mod tests;
