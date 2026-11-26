//! Account directory presence for a standalone runtime. Desktop-launched
//! runtimes leave binding ownership and account grants to the window.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{api_base_url, load, load_from, locked, save_to, session_path, Answered, Api, Session, SessionEnded};
use crate::relay_e2ee::HostKeypair;
use crate::remote::{account_link::AccountLink, host::RelayHost};

const BINDINGS: &str = "/v1/desktop/host-account-bindings";
pub(crate) const PHONE_PAIRING_CAPABILITY: &str = "headless-phone-pairing.v1";
const HEARTBEAT: Duration = Duration::from_secs(30);

#[derive(Deserialize, PartialEq, Serialize)]
pub(super) struct Binding {
    host_id: String,
    generation: u64,
    // Older versions can advance the local generation on an offline logout.
    previous_generation: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    unbind_generation: Option<u64>,
    /// Who signed out without the account service removing this binding
    /// (their session had ended). Cleared once a registration or an unbind
    /// is accepted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    left_bound_to: Option<String>,
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
            unbind_generation: None,
            left_bound_to: None,
        });
    // Record the generation before registering. Logout can remove the entry
    // even if the registration response was lost.
    binding.unbind_generation = None;
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
    binding.left_bound_to = None;
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

/// Why a signed-in standalone runtime does not publish itself in its
/// account's machine list this round (PRO-598). Each is logged when it
/// starts and when it ends, never skipped silently.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Unpublished {
    /// Data privacy mode turns the account's features off.
    DataPrivacy,
    /// Relay has not registered this machine: the account service lists a
    /// machine only once Relay vouches for it.
    NotOnRelay,
    /// Relay registered this machine for another account than the one
    /// signed in (a sign-in the relay host has not caught up with yet).
    RelayForAnotherAccount,
}

impl std::fmt::Display for Unpublished {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::DataPrivacy => "data privacy mode is on",
            Self::NotOnRelay => "Relay has not registered this machine yet",
            Self::RelayForAnotherAccount => "Relay has this machine registered for another account than the one signed in",
        })
    }
}

/// Whether the signed-in `session_user` can be published now.
pub(crate) fn unpublished(data_privacy: bool, on_relay: bool, relay_user: Option<&str>, session_user: &str) -> Option<Unpublished> {
    if data_privacy {
        Some(Unpublished::DataPrivacy)
    } else if !on_relay {
        Some(Unpublished::NotOnRelay)
    } else if relay_user != Some(session_user) {
        Some(Unpublished::RelayForAnotherAccount)
    } else {
        None
    }
}

/// One round's outcome for the log: signed out, published, or why not.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Round {
    SignedOut,
    Published,
    Skipped { who: String, reason: Unpublished },
}

/// The line a change of outcome is logged with, if it is worth one.
fn round_changed(last: Option<&Round>, now: &Round) -> Option<(log::Level, String)> {
    if last == Some(now) {
        return None;
    }
    match now {
        Round::Skipped { who, reason } => {
            Some((log::Level::Warn, format!("machine directory: this machine is not on {who}'s machine list: {reason}")))
        }
        Round::Published if matches!(last, Some(Round::Skipped { .. })) => {
            Some((log::Level::Info, "machine directory: this machine is on its account's machine list again".into()))
        }
        _ => None,
    }
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
    let mut last: Option<Round> = None;
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
                    let Some(session) = load(&data)? else { return Ok(Round::SignedOut) };
                    let skipped = unpublished(
                        crate::data_privacy::enabled(),
                        relay.registration().is_some(),
                        link.user_id().as_deref(),
                        &session.cloud.user_id,
                    );
                    if let Some(reason) = skipped {
                        return Ok(Round::Skipped { who: session.who(), reason });
                    }
                    refresh(&api, &session, &data, &key, &mut binding)?;
                    Ok(Round::Published)
                });
                let round = match result {
                    Ok(round) => Some(round),
                    Err(error) => {
                        log::warn!("machine directory: {error:#}");
                        None
                    }
                };
                (binding, round)
            });
            let Ok((current, round)) = round.await else { return };
            binding = current;
            if let Some(round) = round {
                if let Some((level, line)) = round_changed(last.as_ref(), &round) {
                    log::log!(level, "{line}");
                }
                last = Some(round);
            }
            tokio::select! {
                _ = tokio::time::sleep(HEARTBEAT) => {}
                changed = status.changed() => if changed.is_err() { return; },
            }
        } else if status.changed().await.is_err() {
            return;
        }
    }
}

fn pending_sign_out_path(data: &Path) -> PathBuf {
    session_path(data).with_file_name("logout-session.json")
}

pub(crate) fn ensure_no_pending_sign_out(data: &Path) -> Result<()> {
    if pending_sign_out_path(data).try_exists()? {
        bail!("The previous account is still being removed. Run `terminalx-serve logout` to finish signing out.");
    }
    Ok(())
}

/// The account whose sign-out left this machine's binding with the account
/// service, if that binding has not been replaced or removed since.
pub(crate) fn left_bound_to(data: &Path) -> Result<Option<String>> {
    Ok(crate::store::read_json::<Binding>(&path(data))?.and_then(|binding| binding.left_bound_to))
}

/// A finished local sign-out.
pub(crate) struct SignedOut {
    pub session: Session,
    /// The account service refused the session for good, so this machine's
    /// binding was not removed there.
    pub left_bound: bool,
}

/// Sign out locally by moving the session out of the runtime's reach. Keep
/// it in the private account directory until unbinding succeeds.
///
/// A failure leaves the session set aside so the next call retries as the
/// same account. When the account service has ended that session, no retry
/// can unbind: the error is [`SessionEnded`], and only a call with
/// `forget_ended` clears the session, recording that the binding stayed.
pub(crate) fn sign_out(api: &Api, data: &Path, forget_ended: bool) -> Result<Option<SignedOut>> {
    locked(data, || {
        let pending = pending_sign_out_path(data);
        let mut session = match load_from(&pending)? {
            Some(session) => session,
            None => {
                let Some(session) = load(data)? else { return Ok(None) };
                std::fs::rename(session_path(data), &pending).context("set aside the account session for logout")?;
                session
            }
        };
        let mut left_bound = false;
        if crate::store::read_json::<Binding>(&path(data))?.is_some() {
            match unbind_as(api, &mut session, &pending, data) {
                Err(error) if forget_ended && error.is::<SessionEnded>() => {
                    // Read again: the attempt may have recorded its generation.
                    if let Some(mut binding) = crate::store::read_json::<Binding>(&path(data))? {
                        binding.left_bound_to = Some(session.who());
                        crate::store::write_json(&path(data), &binding)?;
                    }
                    left_bound = true;
                }
                result => result?,
            }
        }
        std::fs::remove_file(&pending).context("clear the account session set aside for logout")?;
        Ok(Some(SignedOut { session, left_bound }))
    })
}

/// Unbind with `session`, renewing it first when it has expired and once
/// more when the account service no longer accepts its access token (a
/// revoked session still looks current here).
fn unbind_as(api: &Api, session: &mut Session, pending: &Path, data: &Path) -> Result<()> {
    let mut renewed = false;
    if session.expires_at <= chrono::Utc::now().timestamp_millis() + 60_000 {
        *session = api.refresh(session)?;
        save_to(pending, session)?;
        renewed = true;
    }
    loop {
        // Each attempt reads the generation the last one recorded.
        let Some(binding) = crate::store::read_json::<Binding>(&path(data))? else { return Ok(()) };
        match unbind(api, session, data, binding)? {
            Ok(()) => return Ok(()),
            Err(Answered { status: 401, .. }) if !renewed => {
                *session = api.refresh(session)?;
                save_to(pending, session)?;
                renewed = true;
            }
            answer => return accepted(answer.map(|()| Value::Null)),
        }
    }
}

fn unbind(api: &Api, session: &Session, data: &Path, mut binding: Binding) -> Result<std::result::Result<(), Answered>> {
    let path = path(data);
    let generation = match binding.unbind_generation {
        Some(generation) => generation,
        None => {
            let generation = binding.generation + 1;
            binding.generation = generation + 1;
            binding.unbind_generation = Some(generation);
            crate::store::write_json(&path, &binding)?;
            generation
        }
    };
    let answer = request(
        api,
        session,
        "DELETE",
        &format!("{BINDINGS}/{}", binding.host_id),
        json!({
            "bindingGeneration": generation,
            "reason": "host-sign-out",
        }),
    )?;
    if let Err(refused) = answer {
        if !(refused.status == 404 && refused.code == "host_binding_not_found") {
            return Ok(Err(refused));
        }
    }
    binding.previous_generation = None;
    binding.left_bound_to = None;
    // Keep the attempted unbind generation until the next registration.
    // If the process exits before clearing the session, DELETE can be retried
    // with the same generation.
    crate::store::write_json(&path, &binding)?;
    Ok(Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_reason_a_signed_in_machine_is_not_published_is_named() {
        assert_eq!(unpublished(true, true, Some("u1"), "u1"), Some(Unpublished::DataPrivacy));
        assert_eq!(unpublished(false, false, Some("u1"), "u1"), Some(Unpublished::NotOnRelay));
        assert_eq!(unpublished(false, true, Some("u0"), "u1"), Some(Unpublished::RelayForAnotherAccount));
        assert_eq!(unpublished(false, true, None, "u1"), Some(Unpublished::RelayForAnotherAccount), "a link with no user yet is not this one");
        assert_eq!(unpublished(false, true, Some("u1"), "u1"), None);
        // Data privacy first: with it on, nothing else matters.
        assert_eq!(unpublished(true, false, None, "u1"), Some(Unpublished::DataPrivacy));
    }

    #[test]
    fn a_skip_is_logged_when_it_starts_changes_and_ends_not_every_round() {
        let skipped = |reason| Round::Skipped { who: "Ada (ada@example.invalid)".into(), reason };
        let privacy = skipped(Unpublished::DataPrivacy);
        let (level, line) = round_changed(None, &privacy).unwrap();
        assert_eq!(level, log::Level::Warn);
        assert_eq!(line, "machine directory: this machine is not on Ada (ada@example.invalid)'s machine list: data privacy mode is on");
        assert_eq!(round_changed(Some(&privacy), &privacy), None, "the same reason again is not logged again");
        let relay = skipped(Unpublished::NotOnRelay);
        assert!(round_changed(Some(&privacy), &relay).unwrap().1.ends_with("Relay has not registered this machine yet"));
        assert_eq!(round_changed(Some(&relay), &Round::Published).map(|(level, _)| level), Some(log::Level::Info));
        assert_eq!(round_changed(None, &Round::Published), None, "publishing as expected needs no line");
        assert_eq!(round_changed(Some(&Round::Published), &Round::SignedOut), None);
    }
}
