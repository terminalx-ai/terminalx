//! Account revocations for phones while the desktop route is detached.
//!
//! The window keeps a copy of its account session in the runtime's data
//! directory while an approved phone or computer operation needs it
//! (`account.rs`, "The runtime's copy"), and removes it once neither does.
//! With the window closed that never runs, so when a revocation here retires
//! the last phone, the runtime removes the copy itself: [`release_account_copy`].

use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use anyhow::{ensure, Result};
use tokio::sync::Notify;

use super::{phones::Phones, MachineHost};
use crate::local_runtime::mobile::model::{AccountMirror, DeviceEntry, DeviceProvenance};
use crate::machine_account::{self, Api, Session};
use crate::phone::registry::{load_account_mirror, DeviceRegistry};
use crate::remote::{account_link::AccountLink, host::valid_opaque_id};

const POLL_INTERVAL: Duration = Duration::from_secs(10);
const FRESHNESS: Duration = Duration::from_secs(25);

struct Verified {
    user_id: String,
    generation: u64,
    checked_at: Instant,
}

#[derive(PartialEq, Eq)]
struct RetiredBinding {
    user_id: String,
    generation: u64,
    devices: Vec<String>,
}

#[derive(Default)]
pub(super) struct Authority {
    verified: Mutex<Option<Verified>>,
    settled: Mutex<Option<RetiredBinding>>,
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

    #[cfg(test)]
    pub(super) fn retired_binding_is_settled(&self) -> bool {
        self.settled.lock().unwrap().is_some()
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
            let polling = authority.clone();
            let owner = machine.clone();
            let checked = tokio::task::spawn_blocking(move || {
                poll(&owner, &phones, &polling, &api, &link, &host_id)
            })
            .await;
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
            // Consume hints after the blocking round. A hint received while
            // it runs must invalidate even the cache that round just wrote.
            _ = authority.wake.notified() => { *authority.settled.lock().unwrap() = None; }
        }
    }
}

fn retired_binding(account: &AccountMirror, devices: &[DeviceEntry]) -> Option<RetiredBinding> {
    devices.iter().all(|device| device.revoked_at.is_some()).then(|| RetiredBinding {
        user_id: account.user_id.clone(),
        generation: account.binding_generation,
        devices: devices.iter().map(|device| device.id.clone()).collect(),
    })
}

fn poll(
    machine: &Weak<MachineHost>,
    phones: &Phones,
    authority: &Authority,
    api: &Api,
    link: &AccountLink,
    host_id: &str,
) -> Result<Option<Verified>> {
    let registry = DeviceRegistry;
    let Some(account) = load_account_mirror()? else {
        return Ok(None);
    };
    let devices = registry.automatic_binding_devices(&account)?;
    if devices.is_empty() {
        return Ok(None);
    }
    // On startup or after a failed acknowledgement, check retired records
    // too. Once settled, wait for a hint or a change to the devices.
    let retired = retired_binding(&account, &devices);
    if retired.is_some() && *authority.settled.lock().unwrap() == retired {
        return Ok(None);
    }
    let Some(host) = machine.upgrade() else {
        return Ok(None);
    };
    // Every phone of the binding is retired and nobody is signed in here
    // (the copy went with the last one): there is nothing left to check.
    if retired.is_some() && machine_account::load(&host.data_dir)?.is_none() {
        return Ok(None);
    }
    let session = link.fresh_session()?;
    let mirror = account.clone();
    let (verified, all_acknowledged) = apply(phones, api, &session, host_id, account)?;
    if all_acknowledged {
        // This round may have retired the last phone: settle on what is
        // left now, so a removed copy is not asked for again.
        let retired = retired_binding(&mirror, &registry.automatic_binding_devices(&mirror)?);
        if retired.is_some() && release_account_copy(&host, phones, &mirror.user_id, &session)? {
            log::info!("machine host: removed the runtime's account session after the last phone was revoked");
        }
        *authority.settled.lock().unwrap() = retired;
    }
    Ok(Some(verified))
}

/// Remove the runtime's copy of the account session once the last phone is
/// revoked while the window is detached, unless something here still needs
/// it: another approved phone, computer operation, a live phone pairing
/// code, or a window that took over. Only `user_id`'s session that was used
/// for this round, or a later rotation of it, goes; one that another account
/// or a new sign-in saved stays. Whether it removed it. Blocking.
///
/// It holds the session file's lock, so the window's own update of the copy
/// (`account.rs`, `sync_runtime_copy`) runs entirely before or after, and the
/// phones' state, so no pairing code is made meanwhile.
fn release_account_copy(host: &MachineHost, phones: &Phones, user_id: &str, used: &Session) -> Result<bool> {
    machine_account::locked(&host.data_dir, || {
        phones
            .without_pairing(|| {
                let detached = !crate::data_privacy::enabled()
                    && !host.window_available()
                    && host.phone_route().is_none();
                if !detached
                    || crate::store::settings::load().machines.allow_operating
                    || crate::phone::registry::has_paired_phone()?
                {
                    return Ok(false);
                }
                match machine_account::load(&host.data_dir)? {
                    Some(saved)
                        if saved.cloud.user_id == user_id
                            && (saved.refresh_token == used.refresh_token
                                || machine_account::rotated(&used.refresh_token, used.expires_at, &saved)) =>
                    {
                        machine_account::remove(&host.data_dir)
                    }
                    _ => Ok(false),
                }
            })
            .unwrap_or(Ok(false))
    })
}

fn apply(
    phones: &Phones,
    api: &Api,
    session: &Session,
    host_id: &str,
    account: AccountMirror,
) -> Result<(Verified, bool)> {
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
        let devices = registry.automatic_for_grant(
            &account.user_id,
            generation,
            &revocation.client_installation_id,
            &revocation.grant_request_id,
        )?;
        for device in devices {
            // A window may have taken over during the fetch. The durable
            // revocation fences admission and retires grants on every lease.
            phones.revoke(&device.id)?;
        }
        applied.push(revocation.revocation_id);
    }
    let mut all_acknowledged = true;
    for id in applied {
        if let Err(error) = api.acknowledge_phone_revocation(session, host_id, generation, &id) {
            log::warn!("machine host: could not acknowledge a revoked phone: {error:#}");
            all_acknowledged = false;
        }
    }
    Ok((Verified {
        user_id: account.user_id,
        generation,
        checked_at,
    }, all_acknowledged))
}
