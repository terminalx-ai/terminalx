//! `machine/8` (PRO-408): what a local session's header and side panel read
//! from this computer's own session files and accounts, read on the machine
//! for a machine session (docs/MACHINES.md "Session feature parity"):
//!
//! - `session.usage`: the session's tokens and estimated cost by model, read
//!   again from its agents' transcripts as the header's popover does, with
//!   how each agent there signs in and the machine's usage windows.
//! - `session.prepareContinuation`: the context Continue in a new tab hands
//!   a new agent tab on the machine. Its transcript path is the machine's,
//!   which is where that tab's agent reads it.
//! - `session.checkFailures`: a pull request's failed check logs, read with
//!   the machine's `gh` into the session's attachments folder there, for Fix
//!   check errors to name in the prompt it sends to the tab's agent.
//!
//! Each tab's account label rides on `session.list` and `session.sessions`
//! ([`account_labels`]): the account the tab runs on, as the machine lists
//! its agent's accounts.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use super::protocol::RpcError;
use crate::agent_accounts::{AgentAccounts, Kind, LOCAL};
use crate::store::index::{SessionEntry, TabEntry};

/// The accounts of each agent a session's tabs run, read once per agent.
#[derive(Default)]
pub(super) struct Accounts {
    by_agent: HashMap<String, Option<AgentAccounts>>,
}

impl Accounts {
    fn of(&mut self, harness: &str) -> Option<&AgentAccounts> {
        self.by_agent
            .entry(harness.to_string())
            .or_insert_with(|| crate::agent_accounts::list(harness).ok())
            .as_ref()
    }
}

/// The id of the account `tab` runs on, or last ran on: This Mac's login
/// when it names none, as on the desktop (`tabAccount(tab) ?? LOCAL`).
fn running_account(tab: &TabEntry) -> &str {
    crate::session_ops::tab_running_account(tab).unwrap_or(LOCAL)
}

/// The label a tab on the machine's own login gets on another computer.
pub(super) const MACHINE_LOGIN: &str = "The machine's own login";

/// The label of the account `tab` runs on, only when its agent has more than
/// one account there: with one, nothing is shown (#980).
pub(super) fn account_label(accounts: &mut Accounts, tab: &TabEntry) -> Option<String> {
    let listed = accounts.of(&tab.harness)?;
    if listed.accounts.len() < 2 {
        return None;
    }
    let id = running_account(tab);
    // The machine's own login is labelled for its own window ("This Mac's
    // login"); read on another computer that would name that computer.
    listed.accounts.iter().find(|account| account.id == id).map(|account| if account.local { MACHINE_LOGIN.to_string() } else { account.label.clone() })
}

/// Put each tab's `accountLabel` on a session as it is sent: absent with one
/// account, or for a tab that is a terminal.
pub(super) fn account_labels(value: &mut Value, session: &SessionEntry, accounts: &mut Accounts) {
    let Some(tabs) = value.get_mut("tabs").and_then(Value::as_array_mut) else { return };
    for (wire, tab) in tabs.iter_mut().zip(&session.tabs) {
        if tab.is_terminal() {
            continue;
        }
        if let (Some(label), Some(fields)) = (account_label(accounts, tab), wire.as_object_mut()) {
            fields.insert("accountLabel".into(), Value::String(label));
        }
    }
}

/// How `harness` signs in on account `id` here, in the words Settings →
/// Agents uses ("Claude account", "ChatGPT account", "API key"); `None` when
/// that cannot be told. This machine's own login is asked of the agent's CLI.
fn login_method(accounts: &mut Accounts, harness: &str, id: &str, own_login: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    let listed = accounts.of(harness).and_then(|listed| listed.accounts.iter().find(|account| account.id == id));
    match listed {
        Some(account) if !account.local && account.kind == Kind::ApiKey => Some("API key".into()),
        Some(account) if !account.local => Some(if harness == "codex" { "ChatGPT account" } else { "Claude account" }.into()),
        // An account the machine no longer lists starts on its own login.
        _ => own_login(harness),
    }
}

/// The login method of the machine's own login of `harness`, from its CLI.
fn own_login(harness: &str) -> Option<String> {
    let path = crate::harness::offered().into_iter().find(|agent| agent.id == harness).and_then(|agent| agent.path);
    crate::harness::readiness::check_binary(harness, path).login_method
}

/// `session.usage`: the usage report `terminalx sessions usage` prints, each
/// agent's login method (`null` when not known) and the machine's usage
/// windows of those agents.
pub(super) fn usage_answer(session: &SessionEntry, windows: Vec<crate::status::usage::UsageWindow>) -> Value {
    usage_answer_with(session, windows, &mut Accounts::default(), &own_login)
}

fn usage_answer_with(session: &SessionEntry, windows: Vec<crate::status::usage::UsageWindow>, accounts: &mut Accounts, own_login: &dyn Fn(&str) -> Option<String>) -> Value {
    let mut methods = Map::new();
    for tab in session.tabs.iter().filter(|tab| tab.usage.as_ref().is_some_and(|usage| !usage.models.is_empty())) {
        // Every tab of an agent is counted: one on a key and one on a subscription is "unknown" on the desktop.
        let method = login_method(accounts, &tab.harness, running_account(tab), own_login);
        let key = tab.harness.clone();
        match methods.get(&key) {
            None => {
                methods.insert(key, json!(method));
            }
            Some(held) if held.as_str() != method.as_deref() => {
                methods.insert(key, Value::Null);
            }
            Some(_) => {}
        }
    }
    let windows: Vec<_> = windows.into_iter().filter(|window| methods.contains_key(&window.agent)).collect();
    json!({
        "usage": crate::session_usage::session_json(session),
        "loginMethods": methods,
        "windows": windows,
    })
}

/// `session.checkFailures`: the failed check logs of `pr_url` in a file of
/// the session's attachments folder, for the agent of `tab_id` to read.
pub(super) fn check_failures(session_id: &str, tab_id: &str, pr_url: &str) -> Result<Value, RpcError> {
    if !pr_url.starts_with("https://") {
        return Err(RpcError::invalid("prUrl must be a pull request's https URL"));
    }
    let attachment = crate::github::checks::prepare_fix(session_id, tab_id, pr_url)?;
    Ok(json!(attachment))
}

#[cfg(test)]
#[path = "machine_session_tests.rs"]
mod tests;
