//! Agent accounts (#980, `docs/AGENT-ACCOUNTS.md`): several Claude Code and
//! Codex logins, each chosen per session.
//!
//! An **account** is one way for one agent to sign in:
//!
//! - **This Mac's login** ([`LOCAL`]) always exists: the person's own
//!   `~/.claude` (or the app's `$CLAUDE_CONFIG_DIR`) and `~/.codex`. Nothing
//!   here moves, copies, writes into or deletes it; it cannot be removed.
//! - **The saved key** ([`SAVED_KEY`]) is the PRO-306 key of `agent_keys`,
//!   kind `apiKey`, present while one is saved.
//! - **Added accounts** ([`Stored`]): a subscription signed in with the
//!   agent's own login into a directory of its own,
//!   `$TERMINALX_HOME/agent-accounts/<agent>/<id>/` (0700), or another key,
//!   its own Keychain item.
//!
//! The index is `agent-logins.json`, `agent_keys`' file: per agent the added
//! accounts, the default account and the project defaults, beside the
//! PRO-306 fields, with every field this build does not know kept. It holds
//! ids, labels, kinds, emails and plans, never a token. A file from before
//! #980 reads as `local` alone, plus the saved key when its mode was
//! `api_key` (the default then).
//!
//! Labels and emails are display data: they never reach a log, a
//! diagnostic or an error a tab records.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::agent_keys::{Agent, Entry, Mode, Saved, Store};

pub mod auto_switch;
pub mod claude_dir;
#[cfg(feature = "desktop")]
pub mod commands;
#[cfg(feature = "desktop")]
pub mod login;
#[cfg(test)]
mod tests;

/// This Mac's own login, for every agent.
pub const LOCAL: &str = "local";
/// The PRO-306 saved key, while one is saved.
pub const SAVED_KEY: &str = "api-key";
/// Where added accounts' directories live, under `$TERMINALX_HOME`.
pub const DIRECTORY: &str = "agent-accounts";
const MAX_LABEL: usize = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// A claude.ai or ChatGPT sign-in.
    Subscription,
    /// An API key in the Keychain.
    ApiKey,
}

/// An added account as the index keeps it. Never a token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    pub id: String,
    pub kind: Kind,
    /// The person's own label; without one, "email · plan".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    /// The organization the agent reports for the sign-in, display only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization: Option<String>,
    /// That organization's id, to tell two sign-ins of one address apart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added_at: Option<String>,
    /// An `apiKey` account's Keychain item.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) key: Option<Saved>,
    /// What a newer build wrote here: kept as it is.
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

impl Stored {
    pub(crate) fn key(id: &str, label: Option<String>, saved: Saved) -> Self {
        Self { id: id.into(), kind: Kind::ApiKey, label, email: None, plan: None, organization: None, organization_id: None, added_at: Some(saved.saved_at.clone()), key: Some(saved), rest: Map::new() }
    }

    fn subscription(id: &str, identity: &Identity) -> Self {
        Self {
            id: id.into(),
            kind: Kind::Subscription,
            label: None,
            email: identity.email.clone(),
            plan: identity.plan.clone(),
            organization: identity.organization.clone(),
            organization_id: identity.organization_id.clone(),
            added_at: Some(chrono::Utc::now().to_rfc3339()),
            key: None,
            rest: Map::new(),
        }
    }
}

/// Whose sign-in a configuration directory holds, as the agent wrote it
/// (read by `agent_local_login::identity_in`): display strings only, each
/// checked, and the organization's id to tell two sign-ins of one address
/// apart. Never a token.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Identity {
    pub email: Option<String>,
    pub plan: Option<String>,
    /// The organization's (Claude Code) or workspace's (ChatGPT) name, display only.
    pub organization: Option<String>,
    /// Its id, for telling accounts apart; never shown.
    pub organization_id: Option<String>,
}

impl Identity {
    pub fn signed_in(&self) -> bool {
        self.email.is_some()
    }
}

/// The same agent account: one address, ignoring case, and the same
/// organization where both sign-ins report one.
pub fn same_account(a: &Identity, b: &Identity) -> bool {
    let email = |identity: &Identity| identity.email.as_deref().map(str::to_lowercase);
    email(a).is_some()
        && email(a) == email(b)
        && match (&a.organization_id, &b.organization_id) {
            (Some(x), Some(y)) => x == y,
            _ => true,
        }
}

impl Stored {
    fn identity(&self) -> Identity {
        Identity { email: self.email.clone(), plan: self.plan.clone(), organization: self.organization.clone(), organization_id: self.organization_id.clone() }
    }
}

/// A new account id: random, lowercase hex, safe in a path.
pub fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..16].to_string()
}

/// Whether `id` can name an account directory: what [`new_id`] makes, or
/// one of the two fixed ids. Nothing with a separator or a dot.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 40 && id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

/// `$TERMINALX_HOME/agent-accounts/<agent>/<id>`, for a valid id.
pub fn account_dir(root: &Path, agent: Agent, id: &str) -> PathBuf {
    debug_assert!(valid_id(id), "an account id that is not safe in a path");
    root.join(DIRECTORY).join(agent.id()).join(id)
}

/// Create `dir` and the folders above it under `$TERMINALX_HOME` owner-only.
pub(crate) fn create_private(dir: &Path) -> Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir).with_context(|| format!("create {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).with_context(|| format!("make {} private", dir.display()))?;
    }
    Ok(())
}

/// What Codex is told in an added account's own `CODEX_HOME` while it signs
/// in, signs out or reports the login: keep it in `auth.json` there.
pub const CODEX_CONFIG: &str = "# Written by TerminalX for one Codex account.\ncheck_for_update_on_startup = false\ncli_auth_credentials_store = \"file\"\n";

/// An added Codex account's directory, ready for `codex login` into it.
pub fn prepare_codex_dir(dir: &Path) -> Result<()> {
    create_private(dir)?;
    let config = dir.join("config.toml");
    if std::fs::read_to_string(&config).ok().as_deref() != Some(CODEX_CONFIG) {
        crate::store::write_atomic(&config, CODEX_CONFIG.as_bytes())?;
    }
    Ok(())
}

// ------------------------------------------------------------------ choosing

/// How an account signs a tab in.
#[derive(Debug, PartialEq, Eq)]
pub enum Login<'e> {
    /// This Mac's own login, under the PRO-306 mode.
    Local,
    /// A key in the Keychain: the saved key, or an added one.
    Key { id: String, saved: &'e Saved },
    /// An added subscription, in its own directory.
    Subscription { id: String },
}

/// Whether `entry` lists account `id`.
pub fn exists(entry: &Entry, id: &str) -> bool {
    id == LOCAL || (id == SAVED_KEY && entry.key.is_some()) || entry.accounts.iter().any(|account| account.id == id)
}

/// How account `id` signs in; an id `entry` does not list is `local`.
pub fn login_of<'e>(entry: &'e Entry, id: &str) -> Login<'e> {
    if id == SAVED_KEY {
        if let Some(saved) = &entry.key {
            return Login::Key { id: id.into(), saved };
        }
    }
    match entry.accounts.iter().find(|account| account.id == id) {
        Some(Stored { kind: Kind::ApiKey, key: Some(saved), .. }) => Login::Key { id: id.into(), saved },
        Some(Stored { kind: Kind::Subscription, .. }) => Login::Subscription { id: id.into() },
        _ => Login::Local,
    }
}

/// The account new tabs of the agent use: the one chosen in Settings, or,
/// as before accounts, the saved key while the mode is `api_key`, else
/// `local`.
pub fn agent_default(entry: &Entry) -> String {
    match &entry.default_account {
        Some(id) if exists(entry, id) => id.clone(),
        _ if entry.mode == Mode::ApiKey && entry.key.is_some() => SAVED_KEY.into(),
        _ => LOCAL.into(),
    }
}

/// The account a launch runs on: the one asked for, the project's default,
/// the agent's default, each only if listed.
pub fn choose(entry: &Entry, account: Option<&str>, project: Option<&str>) -> String {
    account
        .filter(|id| exists(entry, id))
        .map(str::to_string)
        .or_else(|| project.and_then(|project| entry.project_defaults.get(project)).filter(|id| exists(entry, id)).cloned())
        .unwrap_or_else(|| agent_default(entry))
}

// ------------------------------------------------------------- for Settings

/// One account as Settings and the pickers show it. Never a token.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub agent: &'static str,
    pub kind: Kind,
    pub label: String,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub organization: Option<String>,
    /// This Mac's login: cannot be removed or relabelled away.
    pub local: bool,
    /// The agent's default account.
    pub is_default: bool,
    /// Its directory was deleted outside the app: "Sign in again".
    pub missing: bool,
    pub added_at: Option<String>,
}

/// An agent's accounts, its default and its project defaults.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccounts {
    pub agent: &'static str,
    pub accounts: Vec<Account>,
    pub default_account: String,
    /// Project id → account id.
    pub project_defaults: BTreeMap<String, String>,
    /// Switching accounts automatically (#981).
    pub auto_switch: AutoSwitchView,
}

/// The automatic switching setting as Settings shows it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoSwitchView {
    /// Offered: the agent has two or more subscription accounts.
    pub offered: bool,
    pub setting: auto_switch::Setting,
    /// Every account in the setting's order, checked or not.
    pub accounts: Vec<auto_switch::Listed>,
}

/// The default label: "email · plan", or what kind of sign-in it is.
pub fn default_label(agent: Agent, kind: Kind, email: Option<&str>, plan: Option<&str>) -> String {
    match (kind, email, plan) {
        (Kind::ApiKey, _, _) => "API key".into(),
        (_, Some(email), Some(plan)) => format!("{email} · {plan}"),
        (_, Some(email), None) => email.into(),
        _ => match agent {
            Agent::Claude => "Claude account".into(),
            Agent::Codex => "ChatGPT account".into(),
        },
    }
}

fn view(root: &Path, agent: Agent, entry: &Entry) -> AgentAccounts {
    let default = agent_default(entry);
    let mut accounts = vec![Account {
        id: LOCAL.into(),
        agent: agent.id(),
        kind: Kind::Subscription,
        label: crate::platform_profile::localize("This Mac's login"),
        email: None,
        plan: None,
        organization: None,
        local: true,
        is_default: default == LOCAL,
        missing: false,
        added_at: None,
    }];
    if let Some(saved) = &entry.key {
        accounts.push(Account {
            id: SAVED_KEY.into(),
            agent: agent.id(),
            kind: Kind::ApiKey,
            label: entry.key_label.clone().unwrap_or_else(|| "API key".into()),
            email: None,
            plan: None,
            organization: None,
            local: false,
            is_default: default == SAVED_KEY,
            missing: false,
            added_at: Some(saved.saved_at.clone()),
        });
    }
    for stored in &entry.accounts {
        accounts.push(Account {
            id: stored.id.clone(),
            agent: agent.id(),
            kind: stored.kind,
            label: stored.label.clone().unwrap_or_else(|| default_label(agent, stored.kind, stored.email.as_deref(), stored.plan.as_deref())),
            email: stored.email.clone(),
            plan: stored.plan.clone(),
            organization: stored.organization.clone(),
            local: false,
            is_default: default == stored.id,
            missing: stored.kind == Kind::Subscription && !(valid_id(&stored.id) && account_dir(root, agent, &stored.id).is_dir()),
            added_at: stored.added_at.clone(),
        });
    }
    let project_defaults = entry.project_defaults.iter().filter(|(_, id)| exists(entry, id)).map(|(project, id)| (project.clone(), id.clone())).collect();
    let setting = entry.auto_switch.clone().unwrap_or_default();
    let auto_switch = AutoSwitchView { offered: auto_switch::offered(&accounts), accounts: auto_switch::ordered(&setting, &accounts), setting };
    AgentAccounts { agent: agent.id(), accounts, default_account: default, project_defaults, auto_switch }
}

/// Save `agent`'s automatic switching setting as Settings sent it (#981).
pub(crate) fn set_auto_switch_in(store: &Store<'_>, agent: Agent, setting: auto_switch::Setting) -> Result<AgentAccounts> {
    store.update(agent, |entry| {
        let mut setting = auto_switch::checked(setting, |id| exists(entry, id))?;
        // Kept from the file: what this build does not know, and the
        // projects' own choices, which are made in each project's settings.
        if let Some(before) = &entry.auto_switch {
            setting.never_projects = before.never_projects.clone();
            for (key, value) in &before.rest {
                setting.rest.entry(key.clone()).or_insert_with(|| value.clone());
            }
        }
        entry.auto_switch = Some(setting);
        Ok(())
    })?;
    list_in(store, agent)
}

/// "Never switch accounts in this project" (#981): on or off for `project`.
pub(crate) fn set_never_switch_in(store: &Store<'_>, agent: Agent, project: &str, never: bool) -> Result<AgentAccounts> {
    ensure!(!project.trim().is_empty() && project.len() <= 4096, "That is not a project.");
    store.update(agent, |entry| {
        let setting = entry.auto_switch.get_or_insert_with(Default::default);
        setting.never_projects.retain(|known| known != project);
        if never {
            setting.never_projects.push(project.to_string());
            setting.never_projects.sort();
        }
        Ok(())
    })?;
    list_in(store, agent)
}

pub(crate) fn list_in(store: &Store<'_>, agent: Agent) -> Result<AgentAccounts> {
    Ok(view(&store.root, agent, &store.entry(agent)?))
}

fn clean_label(label: &str) -> Result<Option<String>> {
    let label = label.trim();
    ensure!(label.chars().count() <= MAX_LABEL, "Keep the label to {MAX_LABEL} characters.");
    ensure!(!label.chars().any(char::is_control), "A label is one line of text.");
    Ok((!label.is_empty()).then(|| label.to_string()))
}

/// Give account `id` the label `label`; an empty one goes back to the default.
pub(crate) fn relabel_in(store: &Store<'_>, agent: Agent, id: &str, label: &str) -> Result<AgentAccounts> {
    ensure!(id != LOCAL, "{}", crate::platform_profile::localize("This Mac's login keeps its name."));
    let label = clean_label(label)?;
    store.update(agent, |entry| {
        if id == SAVED_KEY && entry.key.is_some() {
            entry.key_label = label;
            return Ok(());
        }
        let account = entry.accounts.iter_mut().find(|account| account.id == id).context("That account is no longer listed.")?;
        account.label = label;
        Ok(())
    })?;
    list_in(store, agent)
}

/// Make `id` the default of `agent`, or of `project` when one is named.
/// `None` with a project lets the project follow the agent again.
pub(crate) fn set_default_in(store: &Store<'_>, agent: Agent, id: Option<&str>, project: Option<&str>) -> Result<AgentAccounts> {
    store.update(agent, |entry| {
        if let Some(id) = id {
            ensure!(exists(entry, id), "That account is no longer listed.");
        }
        match (project, id) {
            (Some(project), Some(id)) => {
                ensure!(!project.trim().is_empty() && project.len() <= 200, "That is not a project.");
                entry.project_defaults.insert(project.to_string(), id.to_string());
            }
            (Some(project), None) => {
                entry.project_defaults.remove(project);
            }
            (None, Some(id)) => {
                entry.default_account = Some(id.to_string());
                // The PRO-306 settings say the same: their key in use or not.
                if id == SAVED_KEY {
                    entry.mode = Mode::ApiKey;
                } else if entry.mode == Mode::ApiKey {
                    entry.mode = Mode::Subscription;
                }
            }
            (None, None) => bail!("Choose an account."),
        }
        Ok(())
    })?;
    list_in(store, agent)
}

/// What a sign-in that finished became.
#[derive(Debug, PartialEq, Eq)]
pub enum Added {
    /// A new account, listed under this id.
    New(String),
    /// An account signed in again.
    Updated(String),
    /// The same agent account is already listed under this id.
    Duplicate(String),
}

/// Who `local`'s own login is, when the caller knows: an added sign-in into
/// the same account is not a second account.
pub(crate) fn add_signed_in(store: &Store<'_>, agent: Agent, id: &str, identity: &Identity, local: Option<&Identity>, again: bool) -> Result<Added> {
    ensure!(valid_id(id), "That is not an account.");
    ensure!(identity.signed_in(), "{} did not finish signing in.", agent.label());
    if local.is_some_and(|local| same_account(identity, local)) {
        return Ok(Added::Duplicate(LOCAL.into()));
    }
    store.update(agent, |entry| {
        if let Some(existing) = entry.accounts.iter().find(|account| account.id != id && account.kind == Kind::Subscription && same_account(identity, &account.identity())) {
            return Ok(Added::Duplicate(existing.id.clone()));
        }
        match entry.accounts.iter_mut().find(|account| account.id == id) {
            Some(account) => {
                ensure!(again && account.kind == Kind::Subscription, "That account is already listed.");
                account.email = identity.email.clone();
                account.plan = identity.plan.clone();
                account.organization = identity.organization.clone();
                account.organization_id = identity.organization_id.clone();
                Ok(Added::Updated(id.into()))
            }
            None => {
                ensure!(!again, "That account was removed meanwhile.");
                entry.accounts.push(Stored::subscription(id, identity));
                Ok(Added::New(id.into()))
            }
        }
    })
}

/// The account `id` as Settings shows it, if listed.
pub(crate) fn account_in(store: &Store<'_>, agent: Agent, id: &str) -> Result<Option<Account>> {
    Ok(list_in(store, agent)?.accounts.into_iter().find(|account| account.id == id))
}

/// How a sign-in the person started ended, for the add and sign-in-again
/// flows. Labels and addresses go to Settings only, never a log.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "status")]
pub enum Finished {
    /// The agent's own login is still open.
    Waiting,
    /// A new account is listed.
    Added { account: Account },
    /// The account signed in again.
    SignedInAgain { account: Account },
    /// That agent account is already listed: the new sign-in was signed out
    /// (and, when it was a new directory, deleted).
    Duplicate {
        account_id: String,
        label: String,
    },
    /// The code ran out before the person finished.
    Expired,
    Cancelled,
    /// The agent ended without a login; its own words are not repeated.
    Failed { message: String },
}

#[cfg(feature = "desktop")]
/// What a sign-in into account `id`'s directory became once the agent's own
/// login ended well: whose sign-in it is, read from the directory, and
/// listed (or updated) unless the same account already is. A duplicate is
/// signed out with the agent's own logout and, for a new account, its
/// directory and Keychain entry deleted, so nothing is added twice. `local`
/// is who This Mac's own login is.
pub(crate) fn complete(store: &Store<'_>, agent: Agent, id: &str, again: bool, local: &Identity, sign_out: &dyn SignOut) -> Result<Finished> {
    let dir = account_dir(&store.root, agent, id);
    let identity = crate::agent_local_login::identity_in(agent.id(), &dir);
    if !identity.signed_in() {
        if !again {
            discard(store, agent, id, sign_out);
        }
        return Ok(Finished::Failed { message: format!("{} did not finish signing in. Try again.", agent.label()) });
    }
    match add_signed_in(store, agent, id, &identity, Some(local), again)? {
        Added::New(id) => Ok(Finished::Added { account: account_in(store, agent, &id)?.context("That account is no longer listed.")? }),
        Added::Updated(id) => Ok(Finished::SignedInAgain { account: account_in(store, agent, &id)?.context("That account is no longer listed.")? }),
        Added::Duplicate(existing) => {
            let label = account_in(store, agent, &existing)?.map(|account| account.label).unwrap_or_default();
            if again {
                // The account stays listed, signed out of the other login.
                let _ = sign_out.logout(agent, &dir);
            } else {
                discard(store, agent, id, sign_out);
            }
            Ok(Finished::Duplicate { account_id: existing, label })
        }
    }
}

#[cfg(feature = "desktop")]
/// Undo a new account's directory that never became an account: the
/// agent's own logout, its Keychain entry, then the directory. Only for an
/// id the index does not list.
pub(crate) fn discard(store: &Store<'_>, agent: Agent, id: &str, sign_out: &dyn SignOut) {
    if !valid_id(id) || id == LOCAL || store.entry(agent).is_ok_and(|entry| exists(&entry, id)) {
        return;
    }
    let dir = account_dir(&store.root, agent, id);
    if !dir.is_dir() {
        return;
    }
    // Only a directory the agent signed in to has a login to revoke.
    let signed_in = match agent {
        Agent::Claude => crate::agent_local_login::identity_in("claude", &dir).signed_in() || dir.join(".credentials.json").exists(),
        Agent::Codex => dir.join("auth.json").exists(),
    };
    if signed_in && sign_out.logout(agent, &dir).is_err() {
        log::warn!("agent accounts: a {} sign-in that was not kept could not be signed out", agent.label());
    }
    if agent == Agent::Claude {
        if let Some(service) = claude_dir::keychain_service(&dir) {
            let _ = sign_out.forget_item(&service);
        }
    }
    let _ = remove_dir(&dir);
}

/// A new account's directory, made for the agent's own login: owner-only,
/// with Claude Code's shared links and MCP servers, or Codex's file store.
pub(crate) fn make_dir(store: &Store<'_>, agent: Agent, id: &str, person: Option<&claude_dir::Person>) -> Result<PathBuf> {
    ensure!(valid_id(id) && id != LOCAL && id != SAVED_KEY, "That is not an account.");
    let dir = account_dir(&store.root, agent, id);
    match agent {
        Agent::Claude => claude_dir::prepare(&dir, person.context("no Claude Code configuration to share")?)?,
        Agent::Codex => prepare_codex_dir(&dir)?,
    }
    Ok(dir)
}

// ------------------------------------------------------------------ removing

/// The agent's own sign-out, and Claude Code's Keychain item, for removal.
/// In tests a stand-in; on the Mac the installed CLI (`login.rs`).
pub(crate) trait SignOut {
    /// Run the agent's own logout with its directory set to `dir`.
    fn logout(&self, agent: Agent, dir: &Path) -> Result<()>;
    /// Delete Claude Code's Keychain item `service` for this user, if any.
    fn forget_item(&self, service: &str) -> Result<()>;
}

/// Remove account `id` of `agent`: for a subscription the agent's own
/// logout runs first in that account's directory, and only if it did the
/// index lets go, then its Keychain item and directory are deleted. Only
/// that account's files are touched; a link inside the directory is
/// removed as a link, never followed. A key account's item is deleted
/// after the index lets go of it.
pub(crate) fn remove_in(store: &Store<'_>, agent: Agent, id: &str, sign_out: &dyn SignOut) -> Result<AgentAccounts> {
    ensure!(id != LOCAL, "{}", crate::platform_profile::localize(&format!("This Mac's login cannot be removed here. Sign out with {}'s own logout instead.", agent.label())));
    let entry = store.entry(agent)?;
    ensure!(exists(&entry, id) && valid_id(id), "That account is no longer listed.");
    let forget = |entry: &mut Entry| {
        entry.accounts.retain(|account| account.id != id);
        entry.project_defaults.retain(|_, chosen| chosen != id);
        if entry.default_account.as_deref() == Some(id) {
            entry.default_account = None;
        }
    };
    match login_of(&entry, id) {
        Login::Local => unreachable!("listed and not local"),
        Login::Key { id, .. } if id == SAVED_KEY => store.remove_key(agent)?,
        Login::Key { saved, .. } => {
            let revision = saved.revision.clone();
            store.update(agent, |entry| {
                forget(entry);
                Ok(())
            })?;
            store.delete_key_item(agent, &revision)?;
        }
        Login::Subscription { id } => {
            let dir = account_dir(&store.root, agent, &id);
            if dir.is_dir() {
                sign_out.logout(agent, &dir).with_context(|| format!("{} could not sign this account out, so nothing was removed", agent.label()))?;
            }
            store.update(agent, |entry| {
                forget(entry);
                Ok(())
            })?;
            if agent == Agent::Claude {
                if let Some(service) = claude_dir::keychain_service(&dir) {
                    sign_out.forget_item(&service)?;
                }
            }
            remove_dir(&dir)?;
        }
    }
    list_in(store, agent)
}

/// Delete an account directory: only one under `agent-accounts/`, and
/// never through a link (`remove_dir_all` removes links themselves).
pub(crate) fn remove_dir(dir: &Path) -> Result<()> {
    let parent = dir.parent().and_then(Path::parent).and_then(Path::file_name);
    ensure!(parent.is_some_and(|name| name == DIRECTORY), "not an account directory");
    match std::fs::symlink_metadata(dir) {
        Ok(meta) if meta.file_type().is_symlink() => std::fs::remove_file(dir).context("remove the account's link"),
        Ok(_) => std::fs::remove_dir_all(dir).context("delete the account's directory"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).context("read the account's directory"),
    }
}

/// Directories under `agent-accounts/<agent>/` the index does not list and
/// no sign-in is using, left by an attempt the app did not see end (a
/// crash): an hour old or more. Their CLI died with that app.
pub(crate) fn sweep_unlisted(store: &Store<'_>, agent: Agent, in_use: &[String]) {
    let Ok(entry) = store.entry(agent) else { return };
    let Ok(dirs) = std::fs::read_dir(store.root.join(DIRECTORY).join(agent.id())) else { return };
    for dir in dirs.flatten() {
        let name = dir.file_name().to_string_lossy().into_owned();
        let old = dir.metadata().ok().and_then(|meta| meta.modified().ok()).and_then(|at| at.elapsed().ok()).is_some_and(|age| age.as_secs() >= 3600);
        if valid_id(&name) && old && !exists(&entry, &name) && !in_use.contains(&name) {
            let _ = remove_dir(&dir.path());
        }
    }
}

// --------------------------------------------------------------------- usage

/// One account's usage windows, for the usage popover and Stats (the usage
/// piece fills it). `unavailable` with no `error`: the account has none to
/// show (an `apiKey` account).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAccountUsage {
    pub account_id: String,
    pub label: String,
    pub windows: Vec<crate::status::usage::UsageWindow>,
    pub error: Option<String>,
    pub unavailable: bool,
}

// ------------------------------------------------------------ the app's own

pub fn list(harness: &str) -> Result<AgentAccounts> {
    list_in(&crate::agent_keys::store()?, crate::agent_keys::agent_of(harness)?)
}

pub fn relabel(harness: &str, id: &str, label: &str) -> Result<AgentAccounts> {
    relabel_in(&crate::agent_keys::store()?, crate::agent_keys::agent_of(harness)?, id, label)
}

pub fn set_default(harness: &str, id: Option<&str>, project: Option<&str>) -> Result<AgentAccounts> {
    set_default_in(&crate::agent_keys::store()?, crate::agent_keys::agent_of(harness)?, id, project)
}

pub fn set_auto_switch(harness: &str, setting: auto_switch::Setting) -> Result<AgentAccounts> {
    set_auto_switch_in(&crate::agent_keys::store()?, crate::agent_keys::agent_of(harness)?, setting)
}

pub fn set_never_switch(harness: &str, project: &str, never: bool) -> Result<AgentAccounts> {
    set_never_switch_in(&crate::agent_keys::store()?, crate::agent_keys::agent_of(harness)?, project, never)
}

/// Save another key for `harness` as an `apiKey` account of its own.
pub fn add_key(harness: &str, key: &str, label: Option<&str>) -> Result<AgentAccounts> {
    let store = crate::agent_keys::store()?;
    let agent = crate::agent_keys::agent_of(harness)?;
    let label = label.map(clean_label).transpose()?.flatten();
    store.add_key_account(agent, key.trim(), label)?;
    list_in(&store, agent)
}

/// Where `harness`'s account `id` keeps its login on this Mac: `None` for
/// `local` and key accounts, which use the person's own directory.
pub fn directory(harness: &str, id: &str) -> Result<Option<PathBuf>> {
    let store = crate::agent_keys::store()?;
    let agent = crate::agent_keys::agent_of(harness)?;
    let entry = store.entry(agent)?;
    Ok(match login_of(&entry, id) {
        Login::Subscription { id } => Some(account_dir(&store.root, agent, &id)),
        _ => None,
    })
}

#[cfg(feature = "desktop")]
fn cli() -> login::Cli {
    login::Cli { programs: login::Programs::installed() }
}

#[cfg(feature = "desktop")]
fn person_for(agent: Agent) -> Result<Option<claude_dir::Person>> {
    Ok(match agent {
        Agent::Claude => Some(claude_dir::Person::current()?),
        Agent::Codex => None,
    })
}

#[cfg(feature = "desktop")]
/// Begin adding an account of `harness` with the agent's own sign-in.
pub fn add_start(harness: &str) -> Result<login::Started> {
    let store = crate::agent_keys::store()?;
    let agent = crate::agent_keys::agent_of(harness)?;
    let cli = cli();
    login::start_in(&store, agent, None, &cli.programs, person_for(agent)?.as_ref(), &cli)
}

#[cfg(feature = "desktop")]
/// Sign listed account `id` of `harness` in again, in its own directory only.
pub fn sign_in_again(harness: &str, id: &str) -> Result<login::Started> {
    let store = crate::agent_keys::store()?;
    let agent = crate::agent_keys::agent_of(harness)?;
    let cli = cli();
    login::start_in(&store, agent, Some(id), &cli.programs, person_for(agent)?.as_ref(), &cli)
}

#[cfg(feature = "desktop")]
/// Where sign-in `attempt_id` is, and what it became once it ended.
pub fn add_finish(attempt_id: &str) -> Result<Finished> {
    let store = crate::agent_keys::store()?;
    login::finish_in(&store, attempt_id, |agent| crate::agent_local_login::local_identity(agent.id()), &cli())
}

#[cfg(feature = "desktop")]
pub fn add_cancel(attempt_id: &str) -> Result<()> {
    login::cancel_in(&crate::agent_keys::store()?, attempt_id, &cli())
}

#[cfg(feature = "desktop")]
/// Remove account `id` of `harness` (see [`remove_in`]).
pub fn remove(harness: &str, id: &str) -> Result<AgentAccounts> {
    remove_in(&crate::agent_keys::store()?, crate::agent_keys::agent_of(harness)?, id, &cli())
}

#[cfg(feature = "desktop")]
/// Account `id`'s login state, from the agent's own status in its directory.
/// This Mac's login and key accounts are what `check_agent_readiness` says.
pub fn readiness(harness: &str, id: &str) -> Result<crate::harness::readiness::Readiness> {
    match directory(harness, id)? {
        Some(dir) => Ok(crate::harness::readiness::check_account(harness, &dir)),
        None => Ok(crate::harness::readiness::check(harness)),
    }
}

#[cfg(feature = "desktop")]
/// Take back directories a crash left behind: unlisted, an hour old, and
/// not in an open sign-in.
pub fn sweep() {
    let Ok(store) = crate::agent_keys::store() else { return };
    let in_use = login::in_use();
    for agent in Agent::ALL {
        sweep_unlisted(&store, agent, &in_use);
    }
}

/// Lend account `id` of `harness` to an organization (`agent_local_login`):
/// This Mac's login as before, or an added account's own sign-in. The
/// organization login flow (`cloud_workspaces`) calls it once it asks which
/// account to lend.
#[cfg(feature = "desktop")]
#[allow(dead_code)]
pub fn lend(harness: &str, id: &str) -> std::result::Result<crate::agent_local_login::LocalLogin, crate::agent_local_login::LocalLoginError> {
    use crate::agent_local_login::{self as local, LocalLoginError};
    let dir = directory(harness, id).map_err(|_| LocalLoginError::NotFound)?;
    match (harness, dir) {
        ("claude", None) if id == LOCAL => local::claude(),
        ("codex", None) if id == LOCAL => local::codex(),
        ("claude", Some(dir)) => local::claude_in(&dir),
        ("codex", Some(dir)) => local::codex_in(&dir),
        _ => Err(LocalLoginError::NotFound),
    }
}
