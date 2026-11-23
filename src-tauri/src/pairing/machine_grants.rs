//! Pairing with a machine through the account (PRO-349, docs/MACHINES.md
//! "Pairing through the account"), on the machine's side. The window's host
//! binding is the machine in the account directory:
//!
//! - it advertises `machine-operating.v1` while "Let other computers operate
//!   this Mac" is on and data privacy mode is off, and says so at once when
//!   the switch changes ([`PairingManager::machine_operating_changed`]);
//! - it answers each `runtime`-scope grant with a fresh machine code from the
//!   runtime, sealed to the grant as a phone's offer is. The computer still
//!   waits for Allow with the fingerprint: a granted account is no approval
//!   (decision 5);
//! - a grant revoked by the operating computer removes the computer allowed
//!   through it, and a computer removed here revokes its grant.
//!
//! The runtime pairs; the window only carries the code and the revocations
//! between it and the account service.

use std::sync::Arc;

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use serde_json::json;

use crate::account::AccountContext;
use crate::machine_wire::{self as wire, MachineCode};

use super::cloud;
use super::crypto::seal_account_bytes;
use super::model::{
    host_capabilities, AccountPairingEnvelope, AccountPairingGrant, AccountPairingRevocation, HostBindingPayload,
    MACHINE_OPERATING_CAPABILITY,
};
use super::relay::RelayLive;
use super::{registry, valid_grant, PairingManager};

/// The scope of a grant for operating this machine.
pub(super) const RUNTIME_SCOPE: &str = "runtime";

impl PairingManager {
    /// Whether other computers may operate this Mac now: the switch is on and
    /// data privacy mode is off (which also turns the runtime's host off).
    pub(super) fn machine_operating(&self) -> bool {
        crate::store::settings::load().machines.allow_operating && !crate::data_privacy::enabled()
    }

    /// What the host binding advertises now.
    /// The runtime needs a current access token for its relay session
    /// (PRO-368): refresh the session if it is about to expire, and keep the
    /// runtime's copy current. Blocking.
    pub(crate) fn refresh_account_for_runtime(&self) {
        let _ = self.account.context();
        self.account.sync_runtime_copy();
    }

    pub(super) fn host_capabilities(&self) -> Vec<String> {
        host_capabilities(crate::store::settings::load().machines.allow_operating, crate::data_privacy::enabled())
    }

    /// "Let other computers operate this Mac" changed (Settings → Machines).
    /// The host binding advertises `machine-operating.v1` only while it is on,
    /// so the account directory hears of the change now, not at the next
    /// heartbeat (terminalx-server `machine-relay-access.md`, "Operating
    /// capability"): a heartbeat while Relay's control channel is answering,
    /// else a registration, which claims nothing about reachability. A Mac
    /// that is not bound says it when it next binds. Off the caller's thread.
    pub fn machine_operating_changed(self: &Arc<Self>) {
        let manager = self.clone();
        std::thread::spawn(move || {
            // The runtime registers with the relay from this copy while it is
            // on, and the copy goes when it is off (PRO-368).
            manager.account.sync_runtime_copy();
            if let Err(error) = manager.advertise_capabilities() {
                log::warn!("could not tell the account directory that operating changed: {error:#}");
            }
        });
    }

    fn advertise_capabilities(&self) -> Result<()> {
        let capabilities = self.host_capabilities();
        let (host, relay) = {
            let mut inner = self.inner.lock().unwrap();
            let Some(host) = inner.host.as_mut() else { return Ok(()) };
            host.capabilities = capabilities.clone();
            (host.clone(), inner.relay.clone())
        };
        let Some(context) = self.account_context().filter(|context| self.relay_permitted(context)) else { return Ok(()) };
        if registry::load_account_mirror()?.is_none_or(|mirror| mirror.user_id != context.user_id || mirror.binding_generation != host.binding_generation) {
            return Ok(());
        }
        let live = relay.as_ref().is_some_and(|relay| relay.relay_host_id == host.host_id && relay.control_verified());
        if live {
            cloud::heartbeat(&crate::account::api_base_url(), &context, &host.host_id, host.binding_generation, &capabilities)?;
            if let Some(host) = self.inner.lock().unwrap().host.as_mut() {
                host.last_seen_at = Some(Utc::now().to_rfc3339());
            }
        } else {
            let payload = HostBindingPayload {
                host_id: host.host_id.clone(),
                host_public_key_b64: host.public_key.clone(),
                binding_generation: host.binding_generation,
                display_name: host.display_name.clone(),
                platform: host.platform.clone(),
                environment_kind: host.environment_kind.clone(),
                capabilities: capabilities.clone(),
            };
            cloud::register_host(&context, &payload)?;
        }
        log::info!(
            "host binding now {} operating by other computers",
            if capabilities.iter().any(|capability| capability == MACHINE_OPERATING_CAPABILITY) { "offers" } else { "no longer offers" }
        );
        self.emit();
        Ok(())
    }

    /// Answer a `runtime` grant with a fresh code from the runtime, sealed to
    /// the grant; or reject it when this Mac cannot serve it. Making the code
    /// ends any earlier one, which is accepted (one code is live at a time).
    pub(super) async fn fulfill_runtime_grant(
        self: &Arc<Self>,
        epoch: u64,
        context: &AccountContext,
        relay: &RelayLive,
        generation: u64,
        grant: AccountPairingGrant,
    ) {
        if !valid_grant(&grant, context, &relay.relay_host_id, generation, RUNTIME_SCOPE) {
            return;
        }
        let manager = self.clone();
        let (context, host_id) = (context.clone(), relay.relay_host_id.clone());
        let outcome = tokio::task::spawn_blocking(move || {
            let answered = manager.runtime_offer(&grant, generation).and_then(|envelope| {
                if !manager.is_epoch(epoch) {
                    bail!("pairing was fenced by sign-out");
                }
                cloud::publish_envelope(&context, &host_id, &grant.grant_request_id, &envelope)
            });
            if let Err(error) = &answered {
                log::warn!("machine pairing grant failed: {error:#}");
                if let Err(error) = cloud::reject_grant(&context, &host_id, &grant.grant_request_id, generation) {
                    log::debug!("could not reject the machine pairing grant: {error:#}");
                }
            }
        })
        .await;
        if let Err(error) = outcome {
            log::warn!("machine pairing grant task failed: {error}");
        }
    }

    /// The runtime's code for `grant`, sealed. Blocking: runtime IPC. No one
    /// at this Mac asked, so a runtime that cannot verify the window is never
    /// restarted for it: Settings → Machines offers the restart (PRO-486).
    fn runtime_offer(&self, grant: &AccountPairingGrant, generation: u64) -> Result<AccountPairingEnvelope> {
        if !self.machine_operating() {
            bail!("{}", crate::platform_profile::localize("other computers may not operate this Mac now"));
        }
        let runtime = self.runtime.lock().unwrap().clone().context("the local runtime is unavailable")?;
        let created = runtime.machine_host_unattended(wire::CREATE_CODE, json!({ "grantRequestId": grant.grant_request_id }))?;
        let created: wire::CreatedCode = serde_json::from_value(created).context("decode the runtime's code")?;
        let keypair = self.host_key(false)?;
        machine_code_envelope(grant, generation, &created.code, keypair.public())
    }

    /// The operating computer removed this Mac, or signed out: the runtime
    /// removes the computer allowed through the grant, and the revocation is
    /// acknowledged. Unacknowledged while the runtime cannot be asked, so the
    /// next round tries again.
    pub(super) async fn apply_runtime_revocation(
        &self,
        base: &str,
        context: &AccountContext,
        relay: &RelayLive,
        generation: u64,
        revocation: AccountPairingRevocation,
    ) {
        let host_id = &relay.relay_host_id;
        if revocation.user_id != context.user_id || &revocation.host_id != host_id || revocation.binding_generation != generation {
            return;
        }
        let Some(runtime) = self.runtime.lock().unwrap().clone() else {
            log::debug!("machine grant revocation waits for the local runtime");
            return;
        };
        let (base, context, host_id) = (base.to_string(), context.clone(), host_id.clone());
        let applied = tokio::task::spawn_blocking(move || -> Result<()> {
            let answer = runtime.machine_host(wire::REVOKE_GRANT, json!({ "grantRequestId": revocation.grant_request_id }))?;
            if let Some(id) = answer["id"].as_str() {
                log::info!("computer {id} was removed: its account grant was revoked");
            }
            cloud::acknowledge_revocation(&base, &context, &host_id, &revocation.revocation_id, generation)
        })
        .await;
        match applied {
            Ok(Ok(())) => {}
            Ok(Err(error)) => log::warn!("machine grant revocation not applied yet: {error:#}"),
            Err(error) => log::warn!("machine grant revocation task failed: {error}"),
        }
    }

    /// A computer allowed through `grant_request_id` was removed on this Mac
    /// (Settings → Machines): end its grant, so the operating computer's
    /// account no longer lists it as paired. Best effort; a failure is
    /// logged. Blocking: an account request.
    pub fn host_removed_computer(&self, grant_request_id: &str) {
        let host = self.inner.lock().unwrap().host.clone();
        let context = self.account_context().filter(|context| self.relay_permitted(context));
        let (Some(host), Some(context)) = (host, context) else {
            log::warn!("a removed computer's account grant stays until this Mac is bound again");
            return;
        };
        if let Err(error) = cloud::revoke_host_grant(&crate::account::api_base_url(), &context, &host.host_id, grant_request_id, host.binding_generation) {
            log::warn!("could not revoke a removed computer's account grant: {error:#}");
        }
    }
}

/// The envelope for a `runtime` grant: its plaintext is exactly the machine
/// code's JSON (the bytes behind `txm2.`), sealed with the grant's key and
/// associated data. The code must carry this Mac's host key, the one the
/// account directory lists and the grant is bound to.
pub(super) fn machine_code_envelope(
    grant: &AccountPairingGrant,
    generation: u64,
    code: &str,
    host_public: &[u8; 32],
) -> Result<AccountPairingEnvelope> {
    let decoded = MachineCode::decode(code).context("the runtime's code")?;
    if general_purpose::STANDARD.decode(&decoded.public_key_b64).ok().as_deref() != Some(host_public.as_slice()) {
        bail!("{}", crate::platform_profile::localize("the runtime's code is for another host key than this Mac's"));
    }
    let body = code.trim().strip_prefix(wire::CODE_PREFIX).context("the runtime's code has no prefix")?;
    let plaintext = general_purpose::URL_SAFE_NO_PAD.decode(body)?;
    seal_account_bytes(&grant.client_ephemeral_public_key, &grant.associated_data, generation, &plaintext)
}

/// Which grants a round lists besides the phones': `runtime` ones only while
/// operating is advertised. Their revocations are listed always, so a
/// computer removed on its side while the switch is off is removed here too.
pub(super) fn runtime_grants_wanted(capabilities: &[String]) -> bool {
    capabilities.iter().any(|capability| capability == MACHINE_OPERATING_CAPABILITY)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hpke::{aead::ChaCha20Poly1305, kdf::HkdfSha256, kem::X25519HkdfSha256, Deserializable, Kem as _, OpModeR, Serializable};

    type Kem = X25519HkdfSha256;

    fn grant(public: &<Kem as hpke::Kem>::PublicKey, aad: &[u8]) -> AccountPairingGrant {
        AccountPairingGrant {
            user_id: "u".into(),
            host_id: "h".into(),
            client_installation_id: "i".into(),
            grant_request_id: "g".into(),
            binding_generation: 3,
            installation_generation: 1,
            client_ephemeral_public_key: general_purpose::URL_SAFE_NO_PAD.encode(public.to_bytes()),
            associated_data_version: 1,
            associated_data: general_purpose::URL_SAFE_NO_PAD.encode(aad),
            requested_scope: RUNTIME_SCOPE.into(),
            expires_at: "2099-01-01T00:00:00Z".into(),
            state: "pending".into(),
        }
    }

    fn code(host: &crate::relay_e2ee::HostKeypair) -> String {
        MachineCode::new(
            crate::relay_e2ee::random_token(),
            general_purpose::STANDARD.encode(host.public()),
            wire::MachineIdentity {
                machine_id: host.host_id(),
                name: "Studio".into(),
                os: wire::MachineOs { family: "macos".into(), version: Some("26.1".into()) },
                version: "0.2.40".into(),
            },
            vec!["ws://192.168.1.20:6768/machine/1".into()],
            4_000_000_000_000,
        )
        .encode()
        .unwrap()
    }

    #[test]
    fn a_runtime_grant_is_answered_with_an_envelope_that_opens_to_the_machine_code() {
        let (private, public) = Kem::gen_keypair();
        let aad = br#"{"v":1,"requestedScope":"runtime"}"#;
        let grant = grant(&public, aad);
        let host = crate::relay_e2ee::HostKeypair::from_secret([5; 32]);
        let code = code(&host);
        let envelope = machine_code_envelope(&grant, 3, &code, host.public()).unwrap();
        assert_eq!(envelope.binding_generation, 3);
        assert_eq!(envelope.algorithm, "HPKE-Base-X25519-HKDF-SHA256-ChaCha20Poly1305");

        // What the operating computer does with it.
        let encapped = <Kem as hpke::Kem>::EncappedKey::from_bytes(&general_purpose::URL_SAFE_NO_PAD.decode(&envelope.encapsulated_key).unwrap()).unwrap();
        let mut receiver = hpke::setup_receiver::<ChaCha20Poly1305, HkdfSha256, Kem>(&OpModeR::Base, &private, &encapped, b"").unwrap();
        let ciphertext = general_purpose::URL_SAFE_NO_PAD.decode(&envelope.ciphertext).unwrap();
        let plaintext = receiver.open(&ciphertext, aad).unwrap();
        let expected = general_purpose::URL_SAFE_NO_PAD.decode(code.strip_prefix(wire::CODE_PREFIX).unwrap()).unwrap();
        assert_eq!(plaintext, expected, "exactly the code's JSON");
        let opened: MachineCode = serde_json::from_slice(&plaintext).unwrap();
        assert_eq!(opened, MachineCode::decode(&code).unwrap());
        assert_eq!(opened.machine.machine_id, host.host_id());

        // Another associated data does not open it.
        let mut receiver = hpke::setup_receiver::<ChaCha20Poly1305, HkdfSha256, Kem>(&OpModeR::Base, &private, &encapped, b"").unwrap();
        assert!(receiver.open(&ciphertext, br#"{"v":1,"requestedScope":"mobile"}"#).is_err());
    }

    #[test]
    fn a_code_for_another_host_key_or_not_a_code_is_never_sealed() {
        let (_, public) = Kem::gen_keypair();
        let grant = grant(&public, b"aad");
        let host = crate::relay_e2ee::HostKeypair::from_secret([5; 32]);
        let other = crate::relay_e2ee::HostKeypair::from_secret([6; 32]);
        assert!(machine_code_envelope(&grant, 3, &code(&other), host.public()).is_err());
        assert!(machine_code_envelope(&grant, 3, "txm2.not-a-code", host.public()).is_err());
    }

    #[test]
    fn each_poll_takes_only_grants_of_its_own_scope() {
        let (_, public) = Kem::gen_keypair();
        let context = AccountContext {
            access_token: "t".into(),
            user_id: "u".into(),
            email: "fixture@example.invalid".into(),
            display_name: "Fixture".into(),
            profile_id: "p".into(),
            organization_id: "o".into(),
            relay_entitled: true,
            generation: 1,
        };
        let runtime = grant(&public, b"aad");
        let mobile = AccountPairingGrant { requested_scope: "mobile".into(), ..runtime.clone() };
        assert!(valid_grant(&mobile, &context, "h", 3, "mobile"), "a phone's grant is answered as before");
        assert!(!valid_grant(&runtime, &context, "h", 3, "mobile"), "never with a phone's offer");
        assert!(valid_grant(&runtime, &context, "h", 3, RUNTIME_SCOPE));
        assert!(!valid_grant(&mobile, &context, "h", 3, RUNTIME_SCOPE), "never with a machine code");
        assert!(!valid_grant(&runtime, &context, "h", 4, RUNTIME_SCOPE), "another binding generation");
        let expired = AccountPairingGrant { expires_at: "2000-01-01T00:00:00Z".into(), ..runtime };
        assert!(!valid_grant(&expired, &context, "h", 3, RUNTIME_SCOPE));
    }

    #[test]
    fn runtime_grants_are_listed_only_while_operating_is_advertised() {
        assert!(runtime_grants_wanted(&host_capabilities(true, false)));
        assert!(!runtime_grants_wanted(&host_capabilities(false, false)));
        assert!(!runtime_grants_wanted(&host_capabilities(true, true)));
    }
}
