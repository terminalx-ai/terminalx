//! Account directory presence for a standalone runtime. Desktop-launched
//! runtimes leave binding ownership and account grants to the window.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{api_base_url, load, locked, remove, Answered, Api, Session};
use crate::relay_e2ee::HostKeypair;
use crate::remote::{account_link::AccountLink, host::RelayHost};

const BINDINGS: &str = "/v1/desktop/host-account-bindings";
pub(crate) const PHONE_PAIRING_CAPABILITY: &str = "headless-phone-pairing.v1";
const HEARTBEAT: Duration = Duration::from_secs(30);

#[derive(Deserialize, PartialEq, Serialize)]
pub(super) struct Binding {
    host_id: String,
    generation: u64,
    // If logout could not reach the API, try this generation if the binding
    // is still active when the same account signs in again.
    previous_generation: Option<u64>,
}

fn path(data: &Path) -> PathBuf {
    data.join("account").join("host-binding.json")
}

fn request(
    api: &Api,
    session: &Session,
    method: &str,
    path: &str,
    body: Value,
) -> Result<std::result::Result<Value, Answered>> {
    api.request(
        method,
        path,
        body,
        Some(&session.access_token),
        Duration::from_secs(10),
    )
}

fn register(api: &Api, session: &Session, data: &Path, key: &HostKeypair) -> Result<Binding> {
    let path = path(data);
    let host_id = key.host_id();
    let mut binding = crate::store::read_json::<Binding>(&path)?
        .filter(|binding| binding.host_id == host_id)
        .unwrap_or(Binding {
            host_id,
            generation: 1,
            previous_generation: None,
        });
    // Record the generation before registering. Logout can remove the entry
    // even if the registration response was lost.
    crate::store::write_json(&path, &binding)?;
    let name =
        crate::machine_name::recent_computer_name().unwrap_or_else(|| "TerminalX server".into());
    let send = |generation| {
        request(
            api,
            session,
            "POST",
            BINDINGS,
            json!({
                "hostId": binding.host_id,
                "hostPublicKeyB64": key.public_key_b64(),
                "bindingGeneration": generation,
                "displayName": name,
                "platform": if cfg!(target_os = "macos") { "darwin" } else { std::env::consts::OS },
                "environmentKind": "native",
                "capabilities": [PHONE_PAIRING_CAPABILITY],
            }),
        )
    };
    let mut generation = binding.generation;
    let mut answer = send(generation)?;
    if let (Err(Answered { code, .. }), Some(previous)) = (&answer, binding.previous_generation) {
        if code == "host_binding_generation_conflict" {
            generation = previous;
            answer = send(generation)?;
        }
    }
    accepted(answer)?;
    binding.generation = generation;
    binding.previous_generation = None;
    crate::store::write_json(&path, &binding)?;
    Ok(binding)
}

fn accepted(answer: std::result::Result<Value, Answered>) -> Result<()> {
    if let Err(Answered { status, code }) = answer {
        bail!("account directory returned HTTP {status} {code}");
    }
    Ok(())
}

pub(super) fn refresh(
    api: &Api,
    session: &Session,
    data: &Path,
    key: &HostKeypair,
    binding: &mut Option<Binding>,
) -> Result<()> {
    let saved = crate::store::read_json::<Binding>(&path(data))?;
    if let Some(bound) = binding
        .as_ref()
        .filter(|bound| saved.as_ref() == Some(bound))
    {
        let answer = request(
            api,
            session,
            "POST",
            &format!("{BINDINGS}/{}/heartbeat", bound.host_id),
            json!({
                "bindingGeneration": bound.generation,
                "reachability": "live",
            }),
        )?;
        if !matches!(&answer, Err(Answered { status: 404, .. })) {
            return accepted(answer);
        }
        *binding = None;
    }
    *binding = Some(register(api, session, data, key)?);
    Ok(())
}

pub(crate) async fn publish(
    data: PathBuf,
    secret: [u8; 32],
    link: Arc<AccountLink>,
    relay: Arc<RelayHost>,
) {
    let api = Arc::new(Api::new(&api_base_url()));
    let key = HostKeypair::from_secret(secret);
    let mut status = relay.status();
    let mut binding = None;
    loop {
        drop(status.borrow_and_update());
        if relay.registration().is_some() {
            let (data, api, key, link, relay) = (
                data.clone(),
                api.clone(),
                key.clone(),
                link.clone(),
                relay.clone(),
            );
            let round = tokio::task::spawn_blocking(move || {
                let result = locked(&data, || {
                    if let Some(session) = load(&data)?.filter(|session| {
                        !crate::data_privacy::enabled()
                            && relay.registration().is_some()
                            && link.user_id().as_deref() == Some(session.cloud.user_id.as_str())
                    }) {
                        refresh(&api, &session, &data, &key, &mut binding)?;
                    }
                    Ok(())
                });
                if let Err(error) = result {
                    log::warn!("machine directory: {error:#}");
                }
                binding
            });
            let Ok(current) = round.await else { return };
            binding = current;
            tokio::select! {
                _ = tokio::time::sleep(HEARTBEAT) => {}
                changed = status.changed() => if changed.is_err() { return; },
            }
        } else if status.changed().await.is_err() {
            return;
        }
    }
}

/// Remove the session before removing its listing, under the lock shared
/// with the publisher. Logout still takes effect locally if the API fails.
pub(crate) fn sign_out(api: &Api, data: &Path) -> Result<Option<(Session, Result<()>)>> {
    locked(data, || {
        let Some(session) = load(data)? else {
            return Ok(None);
        };
        remove(data)?;
        let unbound = unbind(api, &session, data);
        Ok(Some((session, unbound)))
    })
}

fn unbind(api: &Api, session: &Session, data: &Path) -> Result<()> {
    let path = path(data);
    let Some(binding) = crate::store::read_json::<Binding>(&path)? else {
        return Ok(());
    };
    let mut next = Binding {
        host_id: binding.host_id.clone(),
        generation: binding.generation + 2,
        previous_generation: binding.previous_generation.or(Some(binding.generation)),
    };
    crate::store::write_json(&path, &next)?;
    let answer = request(
        api,
        session,
        "DELETE",
        &format!("{BINDINGS}/{}", binding.host_id),
        json!({
            "bindingGeneration": next.generation - 1,
            "reason": "host-sign-out",
        }),
    )?;
    if matches!(&answer, Err(Answered { status: 404, .. })) {
        return crate::store::write_json(&path, &binding);
    }
    accepted(answer)?;
    next.previous_generation = None;
    crate::store::write_json(&path, &next)
}
