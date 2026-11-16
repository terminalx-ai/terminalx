//! A machine's agents as its page shows them (PRO-350, docs/MACHINES.md
//! "As built (PRO-350): the machine page"): each installed agent's version
//! and whether its own login on the machine is in place, and the agents with
//! no CLI there.
//!
//! The login is read with the probe Settings → Agents uses on a Mac
//! ([`crate::harness::readiness`]): Claude Code's `auth status --json`,
//! Codex's `account/read`. Each starts a process, and `runtime.agents` is
//! asked whenever a new-session form opens, so an answer is kept for
//! [`FRESH`]; `refresh` asks again, and a setup step's exit forgets them all.
//! A probe that fails or cannot tell is `unknown`, never signed out.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::harness::readiness::State;
use crate::harness::HarnessInfo;

/// How long a login probe's answer is used before it is asked again.
pub(super) const FRESH: Duration = Duration::from_secs(60);

/// One agent's login, as read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct SignIn {
    /// `signedIn`, `signedOut` or `unknown`.
    pub state: &'static str,
    /// Its CLI's version, when the CLI said one.
    pub version: Option<String>,
    /// When it was read, ms since the epoch.
    pub checked_at: u64,
}

/// What a probe answers: the login's state and the CLI's version.
pub(super) type Probed = (State, Option<String>);

/// An agent and its CLI's path.
type Key = (String, Option<String>);

/// The answers kept, by agent and the CLI's path.
static CHECKED: Mutex<Option<HashMap<Key, (Instant, SignIn)>>> = Mutex::new(None);

/// The word `runtime.agents` uses for a probe's state. An installed CLI
/// found missing at the probe (removed since it was listed) cannot tell.
pub(super) fn state_name(state: State) -> &'static str {
    match state {
        State::Ready => "signedIn",
        State::SignedOut => "signedOut",
        State::Missing | State::Unknown => "unknown",
    }
}

/// The login of installed `agent`: kept when fresh, else probed now.
pub(super) fn sign_in(agent: &HarnessInfo, refresh: bool, probe: &dyn Fn(&HarnessInfo) -> Probed) -> SignIn {
    let key = (agent.id.clone(), agent.path.clone());
    if !refresh {
        let kept = CHECKED.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, sign_in)) = kept.as_ref().and_then(|kept| kept.get(&key)) {
            if at.elapsed() < FRESH {
                return sign_in.clone();
            }
        }
    }
    let (state, version) = probe(agent);
    let sign_in = SignIn { state: state_name(state), version, checked_at: crate::cloud_agents::now_ms() };
    CHECKED.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(key, (Instant::now(), sign_in.clone()));
    sign_in
}

/// The probe Settings → Agents uses: the CLI's version and the login new
/// sessions there use. With agent accounts (#980) that is the agent's
/// default account: a subscription account's own directory, else the CLI's
/// own login (a key account counts as signed in, as on this Mac). A project
/// may name another default; the page and the form speak for the machine's.
pub(super) fn probe(agent: &HarnessInfo) -> Probed {
    let readiness = match default_account_dir(&agent.id) {
        Some(dir) => crate::harness::readiness::check_account_binary(&agent.id, agent.path.clone(), &dir),
        None => crate::harness::readiness::check_binary(&agent.id, agent.path.clone()),
    };
    (readiness.state, readiness.version)
}

/// The directory of `harness`'s default account, when that is a subscription account.
fn default_account_dir(harness: &str) -> Option<std::path::PathBuf> {
    let store = crate::agent_keys::store().ok()?;
    let entry = store.entry(crate::agent_keys::agent_of(harness).ok()?).ok()?;
    let id = crate::agent_accounts::agent_default(&entry);
    crate::agent_accounts::directory(harness, &id).ok().flatten()
}

/// Forget every answer: an install or sign-in step just ended there.
pub(super) fn forget() {
    *CHECKED.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// The agents the runtime knows with no CLI there, and whether TerminalX can install each.
pub(super) fn missing(offered: &[HarnessInfo]) -> Value {
    json!(offered
        .iter()
        .filter(|agent| !agent.available)
        .map(|agent| json!({ "id": agent.id, "name": agent.name, "installable": agent.installable }))
        .collect::<Vec<_>>())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_login_that_cannot_be_told_is_unknown_never_signed_out() {
        assert_eq!(state_name(State::Ready), "signedIn");
        assert_eq!(state_name(State::SignedOut), "signedOut");
        assert_eq!(state_name(State::Unknown), "unknown");
        assert_eq!(state_name(State::Missing), "unknown");
    }
}
