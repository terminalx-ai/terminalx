//! Account revocations for phones while the desktop route is detached.

use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use anyhow::{ensure, Result};
use tokio::sync::Notify;

use super::{phones::Phones, MachineHost};
use crate::local_runtime::mobile::model::{AccountMirror, DeviceEntry, DeviceProvenance};
use crate::machine_account::{Api, Session};
use crate::phone::registry::{load_account_mirror, DeviceRegistry};
use crate::remote::{account_link::AccountLink, host::valid_opaque_id};

const POLL_INTERVAL: Duration = Duration::from_secs(10);
const FRESHNESS: Duration = Duration::from_secs(25);

struct Verified {
    user_id: String,
    generation: u64,
    checked_at: Instant,
}

#[derive(Default)]
pub(super) struct Authority {
    verified: Mutex<Option<Verified>>,
    wake: Notify,
}

impl Authority {
    pub(super) fn check(&self, device: &DeviceEntry) -> Result<()> {
        if device.provenance == DeviceProvenance::Automatic {
            ensure!(self.verified.lock().unwrap().as_ref().is_some_and(|verified| {
                device.bound_user_id.as_deref() == Some(verified.user_id.as_str())
                    && device.binding_generation == verified.generation
                    && verified.checked_at.elapsed() < FRESHNESS
            }), "The runtime cannot verify this phone's account pairing. Reconnect when the account service is reachable.");
        }
        Ok(())
    }

    pub(super) fn hint(&self) {
        self.wake.notify_one();
    }
}

pub(super) async fn watch(machine: Weak<MachineHost>, authority: Arc<Authority>, api: Arc<Api>) {
    loop {
        let Some(host) = machine.upgrade() else {
            return;
        };
        let key = if !crate::data_privacy::enabled()
            && !host.window_available()
            && host.phone_route().is_none()
        {
            host.keypair()
        } else {
            None
        };
        let delay = if let (Some(key), Some(phones)) = (key, host.phones.get().cloned()) {
            let api = api.clone();
            let link =
                AccountLink::new(host.data_dir.clone(), *key.secret(), host.account_window());
            let host_id = key.host_id();
            drop(host);
            let checked =
                tokio::task::spawn_blocking(move || poll(&phones, &api, &link, &host_id)).await;
            let verified = match checked {
                Ok(Ok(verified)) => verified,
                Ok(Err(error)) => {
                    log::warn!("machine host: could not check for revoked phones: {error:#}");
                    None
                }
                Err(_) => None,
            };
            let Some(host) = machine.upgrade() else {
                return;
            };
            let detached = !crate::data_privacy::enabled()
                && !host.window_available()
                && host.phone_route().is_none();
            *authority.verified.lock().unwrap() = verified.filter(|_| detached);
            POLL_INTERVAL
        } else {
            *authority.verified.lock().unwrap() = None;
            Duration::from_secs(1)
        };

        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = authority.wake.notified() => {}
        }
    }
}

fn poll(phones: &Phones, api: &Api, link: &AccountLink, host_id: &str) -> Result<Option<Verified>> {
    let registry = DeviceRegistry;
    let Some(account) = load_account_mirror()? else {
        return Ok(None);
    };
    if !registry.list()?.iter().any(|device| {
        device.provenance == DeviceProvenance::Automatic
            && device.bound_user_id.as_deref() == Some(account.user_id.as_str())
            && device.binding_generation == account.binding_generation
    }) {
        return Ok(None);
    }
    let session = link.fresh_session()?;
    apply(phones, api, &session, host_id, account).map(Some)
}

fn apply(
    phones: &Phones,
    api: &Api,
    session: &Session,
    host_id: &str,
    account: AccountMirror,
) -> Result<Verified> {
    ensure!(
        session.cloud.user_id == account.user_id,
        "phone binding and runtime session belong to different accounts"
    );
    let generation = account.binding_generation;
    let checked_at = Instant::now();
    let revocations = api.phone_revocations(session, host_id, generation)?;
    let mut applied = Vec::new();
    let registry = DeviceRegistry;
    for revocation in revocations {
        if revocation.user_id != account.user_id
            || revocation.host_id != host_id
            || revocation.binding_generation != generation
        {
            continue;
        }
        ensure!(
            valid_opaque_id(&revocation.revocation_id)
                && revocation
                    .revocation_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
            "invalid phone revocation ID"
        );
        let device = registry.automatic_for_grant(
            &account.user_id,
            &revocation.client_installation_id,
            &revocation.grant_request_id,
        )?;
        if let Some(device) = device.filter(|device| device.binding_generation == generation) {
            // Persist the revocation and terminate existing sockets and grants
            // before telling the account service it has been applied.
            phones.revoke(&device.id)?;
        }
        applied.push(revocation.revocation_id);
    }
    for id in applied {
        if let Err(error) = api.acknowledge_phone_revocation(session, host_id, generation, &id) {
            log::warn!("machine host: could not acknowledge a revoked phone: {error:#}");
        }
    }
    Ok(Verified {
        user_id: account.user_id,
        generation,
        checked_at,
    })
}
