//! Settings › MCP (PRO-239, designs 10.09–10.18): the MCP servers Claude Code
//! and Codex on this Mac can call, kept by TerminalX and written into each
//! agent's own file.
//!
//! - A server is a URL or a local command (`npx …`, `uvx …`), installed for
//!   Claude Code, Codex or both, and either this person's ("Just me") or an
//!   organisation's ("Shared"). A shared server is a URL only: its record
//!   comes from the organisation (`organization.mcp-servers.v1`), every member
//!   has it, and each can turn it off for themselves on this Mac.
//! - Nothing secret is kept in this module's file or in the agents' files. A
//!   Bearer token, a header's value and an OAuth access token are Personal
//!   environment variables in the Keychain (`store::environment::MCP_PREFIX`),
//!   which TerminalX puts in the environment of every agent it starts; the
//!   agents' files name the variable (`Bearer ${TERMINALX_MCP_…}`,
//!   `bearer_token_env_var`). An OAuth refresh token and an own client's
//!   secret are Keychain items of their own and never reach an agent.
//! - What TerminalX wrote into each agent's file is remembered, so a server
//!   removed here is removed there, and a server the person added to an
//!   agent themselves is never touched.

pub(crate) mod commands;
mod oauth;
mod probe;

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::agent_configs::{self, Direction, FoundTarget, Homes, Managed};
use crate::keychain::SecretStore;

pub(crate) use oauth::callback_url;

const FILE: &str = "mcp-servers.json";
/// The Keychain service of refresh tokens and own clients' secrets.
const SERVICE: &str = "dev.terminalx.mcp";
const MAX_SERVERS: usize = 100;
const MAX_HEADERS: usize = 20;

// ------------------------------------------------------------------ model

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Auth {
    /// Sign in with the server in the browser, when it asks.
    Oauth,
    Bearer,
    Headers,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Agents {
    pub claude_code: bool,
    pub codex: bool,
}

/// What an OAuth sign-in left: where to refresh it and when it runs out.
/// The tokens themselves are in the Keychain.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Grant {
    token_endpoint: String,
    client_id: String,
    /// Unix seconds; none when the server did not say.
    #[serde(default)]
    expires_at: Option<i64>,
    /// The URL signed in to; a grant for another URL is not used.
    resource: String,
}

/// One server of this person's own list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Local {
    id: String,
    name: String,
    target: String,
    auth: Auth,
    #[serde(default)]
    header_names: Vec<String>,
    agents: Agents,
    /// A command's environment as an imported entry had it (never asked for
    /// by the form; written back exactly as it was found).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    env: BTreeMap<String, String>,
    /// "Advanced client identity": an OAuth client of the person's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    client_id: Option<String>,
}

/// An organisation's shared server, as the organisation lists it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Shared {
    pub id: String,
    pub name: String,
    pub target: String,
    pub auth_kind: Auth,
    #[serde(default)]
    pub header_names: Vec<String>,
    pub agents: Agents,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Written {
    #[serde(default)]
    claude: BTreeSet<String>,
    #[serde(default)]
    codex: BTreeSet<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    #[serde(default)]
    servers: Vec<Local>,
    /// Each organisation's shared servers as last listed, so this Mac keeps
    /// them while offline. An organisation no longer ready is dropped.
    #[serde(default)]
    shared: BTreeMap<String, Vec<Shared>>,
    /// Shared servers turned off for this person, by key.
    #[serde(default)]
    off: BTreeSet<String>,
    /// Keys whose token, header values or OAuth sign-in are in the Keychain.
    #[serde(default)]
    secrets: BTreeSet<String>,
    #[serde(default)]
    grants: BTreeMap<String, Grant>,
    #[serde(default)]
    written: Written,
}

/// Where a server is reached: a URL, or a command and its arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Target {
    Url(String),
    Command { command: String, args: Vec<String> },
}

/// A row of the Installed table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    /// `local/<id>`, or `<organisation id>/<server id>` for a shared server.
    pub key: String,
    pub name: String,
    pub target: String,
    pub auth: Auth,
    pub header_names: Vec<String>,
    pub agents: Agents,
    /// The organisation sharing it.
    pub shared_by: Option<String>,
    /// Shared and turned off for this person.
    pub off: bool,
    /// Shared, but one of this person's own servers has its name: not installed.
    pub shadowed: bool,
    /// Its token or header values are in the Keychain, or it is signed in.
    pub has_secret: bool,
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub servers: Vec<Row>,
    /// The redirect an own OAuth client must allow ("Advanced client identity").
    pub callback_url: String,
    /// Agent files that could not be brought up to date, as shown (`~/.claude.json`).
    pub problems: Vec<String>,
}

/// What the form saves. Secrets travel only here, from the form to the Keychain.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Input {
    /// The server edited; none for a new one.
    #[serde(default)]
    pub key: Option<String>,
    pub name: String,
    pub target: String,
    pub auth: Auth,
    #[serde(default)]
    pub header_names: Vec<String>,
    pub agents: Agents,
    /// The organisation to share it with; none for "Just me".
    #[serde(default)]
    pub organization: Option<String>,
    #[serde(default)]
    pub client_id: Option<String>,
    #[serde(default)]
    pub secret: SecretInput,
}

/// Left out (or empty) keeps what is stored.
#[derive(Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretInput {
    #[serde(default)]
    pub token: Option<String>,
    /// One value per `header_names` entry, in order.
    #[serde(default)]
    pub header_values: Option<Vec<String>>,
    #[serde(default)]
    pub client_secret: Option<String>,
}

impl std::fmt::Debug for SecretInput {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretInput(…)")
    }
}

// ------------------------------------------------------------------ names and targets

pub(crate) fn valid_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    name.len() <= 64
        && bytes.next().is_some_and(|b| b.is_ascii_alphanumeric())
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn valid_header_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 128 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&b))
}

fn loopback(url: &url::Url) -> bool {
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
}

/// Words as a POSIX shell splits them, without expanding anything: quotes and
/// backslashes only. `$VAR` stays as written.
pub(crate) fn split_words(text: &str) -> Result<Vec<String>> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut started = false;
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            c if c.is_whitespace() => {
                if started {
                    words.push(std::mem::take(&mut word));
                    started = false;
                }
            }
            '\'' => {
                started = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(c) => word.push(c),
                        None => bail!("A quote is not closed."),
                    }
                }
            }
            '"' => {
                started = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') => match chars.next() {
                            Some(c @ ('"' | '\\' | '$' | '`')) => word.push(c),
                            Some(c) => {
                                word.push('\\');
                                word.push(c);
                            }
                            None => bail!("A quote is not closed."),
                        },
                        Some(c) => word.push(c),
                        None => bail!("A quote is not closed."),
                    }
                }
            }
            '\\' => {
                started = true;
                if let Some(c) = chars.next() {
                    word.push(c);
                }
            }
            c => {
                started = true;
                word.push(c);
            }
        }
    }
    if started {
        words.push(word);
    }
    Ok(words)
}

/// A command and its arguments as one line [`split_words`] reads back.
pub(crate) fn join_words(words: &[String]) -> String {
    words
        .iter()
        .map(|word| {
            if !word.is_empty() && word.bytes().all(|b| b.is_ascii_alphanumeric() || b"@%+=:,./_-$".contains(&b)) {
                word.clone()
            } else {
                format!("'{}'", word.replace('\'', "'\\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

pub(crate) fn parse_target(target: &str) -> Result<Target> {
    let target = target.trim();
    ensure!(!target.is_empty(), "Enter a URL or a command.");
    ensure!(target.len() <= 2048 && !target.chars().any(char::is_control), "This URL or command is not valid.");
    let lower = target.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        let url = url::Url::parse(target).map_err(|_| anyhow::anyhow!("This URL is not valid."))?;
        ensure!(url.scheme() == "https" || loopback(&url), "Use an https:// URL.");
        ensure!(url.username().is_empty() && url.password().is_none(), "Put credentials under Authentication, not in the URL.");
        return Ok(Target::Url(target.to_string()));
    }
    let mut words = split_words(target)?;
    ensure!(!words.is_empty(), "Enter a URL or a command.");
    let command = words.remove(0);
    Ok(Target::Command { command, args: words })
}

/// A URL an organization may share: every member receives it as it is, so it
/// carries no query string or fragment (where a key would sit, `?api_key=…`).
pub(crate) fn shareable_url(target: &str) -> bool {
    matches!(parse_target(target), Ok(Target::Url(_))) && !target.contains(['?', '#'])
}

// ------------------------------------------------------------------ keys and variables

fn local_key(id: &str) -> String {
    format!("local/{id}")
}

fn shared_key(org: &str, id: &str) -> String {
    format!("{org}/{id}")
}

/// The variables of one server: `TERMINALX_MCP_<hash of its key>_…`, so a
/// rename keeps them and no name says what they are for.
fn var_base(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    let hex: String = digest[..6].iter().map(|b| format!("{b:02X}")).collect();
    format!("{}{hex}", crate::store::environment::MCP_PREFIX)
}

fn token_var(key: &str) -> String {
    format!("{}_TOKEN", var_base(key))
}

fn header_var(key: &str, index: usize) -> String {
    format!("{}_H{index}", var_base(key))
}

fn all_vars(key: &str) -> BTreeSet<String> {
    std::iter::once(token_var(key)).chain((0..MAX_HEADERS).map(|i| header_var(key, i))).collect()
}

fn refresh_account(key: &str) -> String {
    format!("{key}/refresh")
}

fn client_secret_account(key: &str) -> String {
    format!("{key}/client-secret")
}

// ------------------------------------------------------------------ dependencies

/// Settings › MCP's variables in the environment store (tests stand in a map).
pub(crate) trait Vars: Send + Sync {
    fn replace(&self, set: &[(String, String)], remove: &BTreeSet<String>) -> Result<()>;
    fn values(&self) -> Result<BTreeMap<String, String>>;
}

struct EnvironmentVars;

impl Vars for EnvironmentVars {
    fn replace(&self, set: &[(String, String)], remove: &BTreeSet<String>) -> Result<()> {
        crate::store::environment::mcp_replace(set, remove)
    }
    fn values(&self) -> Result<BTreeMap<String, String>> {
        crate::store::environment::mcp_values()
    }
}

/// Everything this module touches outside itself, so a test runs on its own
/// folder, its own agent homes, an in-memory Keychain and no network.
pub(crate) struct Deps {
    pub root: PathBuf,
    pub homes: Homes,
    pub secrets: Arc<dyn SecretStore>,
    pub vars: Arc<dyn Vars>,
}

impl Deps {
    fn current() -> Result<Self> {
        Ok(Deps {
            root: crate::store::root()?,
            homes: Homes::current()?,
            secrets: Arc::new(crate::keychain::Keychain),
            vars: Arc::new(EnvironmentVars),
        })
    }
}

/// One change at a time: each reads the file, changes it and writes it back.
/// Never taken on the main thread (every caller is a blocking task), so a
/// Keychain call made while holding it waits on nobody else.
fn lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(PoisonError::into_inner)
}

fn read_state(deps: &Deps) -> Result<State> {
    let path = deps.root.join(FILE);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).context("Settings › MCP's list could not be read."),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(State::default()),
        Err(error) => Err(error).context("Settings › MCP's list could not be read."),
    }
}

fn write_state(deps: &Deps, state: &State) -> Result<()> {
    std::fs::create_dir_all(&deps.root)?;
    crate::store::write_atomic(&deps.root.join(FILE), &serde_json::to_vec_pretty(state)?)
}

// ------------------------------------------------------------------ the installed list

/// A server as installed on this Mac, whoever's it is.
#[derive(Debug, Clone)]
struct Installed {
    key: String,
    name: String,
    target: String,
    auth: Auth,
    header_names: Vec<String>,
    agents: Agents,
    env: BTreeMap<String, String>,
    shared_by: Option<String>,
    off: bool,
    shadowed: bool,
}

fn installed(state: &State) -> Vec<Installed> {
    let own: BTreeSet<&str> = state.servers.iter().map(|s| s.name.as_str()).collect();
    let mut rows: Vec<Installed> = state
        .servers
        .iter()
        .map(|s| Installed {
            key: local_key(&s.id),
            name: s.name.clone(),
            target: s.target.clone(),
            auth: s.auth,
            header_names: s.header_names.clone(),
            agents: s.agents,
            env: s.env.clone(),
            shared_by: None,
            off: false,
            shadowed: false,
        })
        .collect();
    let mut seen = BTreeSet::new();
    for (org, servers) in &state.shared {
        for s in servers {
            let key = shared_key(org, &s.id);
            rows.push(Installed {
                off: state.off.contains(&key),
                // Two organisations sharing one name: the first listed is installed.
                shadowed: own.contains(s.name.as_str()) || !seen.insert(s.name.clone()),
                key,
                name: s.name.clone(),
                target: s.target.clone(),
                auth: s.auth_kind,
                header_names: s.header_names.clone(),
                agents: s.agents,
                env: BTreeMap::new(),
                shared_by: Some(org.clone()),
            });
        }
    }
    rows.sort_by(|a, b| a.name.cmp(&b.name).then(a.key.cmp(&b.key)));
    rows
}

fn find<'a>(rows: &'a [Installed], key: &str) -> Result<&'a Installed> {
    rows.iter().find(|row| row.key == key).context("This server is no longer installed.")
}

/// How each agent reaches a server, naming its variables.
fn managed(server: &Installed, signed_in: bool) -> Result<Managed> {
    Ok(match parse_target(&server.target)? {
        Target::Command { command, args } => Managed::Command { command, args, env: server.env.clone() },
        Target::Url(url) => Managed::Url {
            url,
            bearer: (server.auth == Auth::Bearer || server.auth == Auth::Oauth && signed_in).then(|| token_var(&server.key)),
            headers: if server.auth == Auth::Headers {
                server.header_names.iter().enumerate().map(|(i, name)| (name.clone(), header_var(&server.key, i))).collect()
            } else {
                BTreeMap::new()
            },
        },
    })
}

/// Bring both agents' files to the installed list. A file that cannot be
/// written is reported, and the list is still saved: the next sync retries.
fn sync(deps: &Deps, state: &mut State) -> Vec<String> {
    let mut claude = Vec::new();
    let mut codex = Vec::new();
    for server in installed(state).iter().filter(|s| !s.off && !s.shadowed) {
        let Ok(how) = managed(server, state.secrets.contains(&server.key)) else { continue };
        if server.agents.claude_code {
            claude.push((server.name.clone(), how.clone()));
        }
        if server.agents.codex {
            codex.push((server.name.clone(), how));
        }
    }
    let names = |servers: &[(String, Managed)]| servers.iter().map(|(n, _)| n.clone()).collect::<BTreeSet<_>>();
    let (want_claude, want_codex) = (names(&claude), names(&codex));
    let drop_claude = state.written.claude.difference(&want_claude).cloned().collect();
    let drop_codex = state.written.codex.difference(&want_codex).cloned().collect();
    match agent_configs::sync_managed(&deps.homes, &claude, &codex, &drop_claude, &drop_codex) {
        Ok(_) => {
            state.written = Written { claude: want_claude, codex: want_codex };
            Vec::new()
        }
        Err(error) => {
            log::warn!("mcp: the agents' files could not be brought up to date: {error:#}");
            vec!["Claude Code's or Codex's settings file could not be updated. Check that ~/.claude.json and ~/.codex/config.toml are valid, then reopen this page.".into()]
        }
    }
}

fn listing(state: &State, problems: Vec<String>) -> Listing {
    let clients: BTreeMap<String, Option<String>> = state.servers.iter().map(|s| (local_key(&s.id), s.client_id.clone())).collect();
    Listing {
        servers: installed(state)
            .into_iter()
            .map(|s| Row {
                has_secret: state.secrets.contains(&s.key),
                client_id: clients.get(&s.key).cloned().flatten(),
                key: s.key,
                name: s.name,
                target: s.target,
                auth: s.auth,
                header_names: s.header_names,
                agents: s.agents,
                shared_by: s.shared_by,
                off: s.off,
                shadowed: s.shadowed,
            })
            .collect(),
        callback_url: callback_url(),
        problems,
    }
}

/// The installed list, after bringing the agents' files up to date with it.
pub(crate) fn list_in(deps: &Deps) -> Result<Listing> {
    let _lock = lock();
    let mut state = read_state(deps)?;
    let before = state.clone();
    let problems = sync(deps, &mut state);
    if state != before {
        write_state(deps, &state)?;
    }
    Ok(listing(&state, problems))
}

/// Replace one organisation's shared servers with what it lists now (none
/// when it is no longer ready). Records that are not https URLs are dropped:
/// a shared server never makes this Mac run a command.
pub(crate) fn set_shared_in(deps: &Deps, org: &str, servers: Option<Vec<Shared>>) -> Result<Listing> {
    let _lock = lock();
    let mut state = read_state(deps)?;
    let servers: Vec<Shared> = servers
        .unwrap_or_default()
        .into_iter()
        .filter(|s| valid_name(&s.name) && shareable_url(&s.target) && (s.agents.claude_code || s.agents.codex))
        .filter(|s| s.auth_kind != Auth::Headers || (!s.header_names.is_empty() && s.header_names.len() <= MAX_HEADERS && s.header_names.iter().all(|h| valid_header_name(h))))
        .collect();
    let gone: Vec<String> = state
        .shared
        .get(org)
        .into_iter()
        .flatten()
        .filter(|old| !servers.iter().any(|s| s.id == old.id))
        .map(|old| shared_key(org, &old.id))
        .collect();
    if servers.is_empty() {
        state.shared.remove(org);
    } else {
        state.shared.insert(org.to_string(), servers);
    }
    for key in &gone {
        forget_secrets(deps, &mut state, key)?;
        state.off.remove(key);
    }
    let problems = sync(deps, &mut state);
    write_state(deps, &state)?;
    Ok(listing(&state, problems))
}

/// Organisations whose shared servers this Mac still holds.
pub(crate) fn shared_orgs_in(deps: &Deps) -> Result<Vec<String>> {
    Ok(read_state(deps)?.shared.keys().cloned().collect())
}

fn forget_secrets(deps: &Deps, state: &mut State, key: &str) -> Result<()> {
    deps.vars.replace(&[], &all_vars(key))?;
    deps.secrets.delete(SERVICE, &refresh_account(key))?;
    deps.secrets.delete(SERVICE, &client_secret_account(key))?;
    state.secrets.remove(key);
    state.grants.remove(key);
    Ok(())
}

/// What the form checks before anything is stored.
pub(crate) fn validate(input: &Input) -> Result<Target> {
    ensure!(valid_name(&input.name), "Use letters, digits, - and _ for the name (at most 64), starting with a letter or digit.");
    let target = parse_target(&input.target)?;
    ensure!(input.agents.claude_code || input.agents.codex, "Install it for Claude Code, Codex or both.");
    if matches!(target, Target::Command { .. }) {
        ensure!(input.auth == Auth::None, "A local command takes no authentication; give it its keys in Settings › Environment.");
        ensure!(input.organization.is_none(), "Only a URL server can be shared with an organization.");
    }
    if input.organization.is_some() && input.key.is_none() {
        ensure!(shareable_url(input.target.trim()), "A shared URL can't carry a query string or fragment; put keys under Authentication, so each person keeps their own.");
    }
    if input.auth == Auth::Headers {
        ensure!(!input.header_names.is_empty() && input.header_names.len() <= MAX_HEADERS, "Add one header per line, as Name: value.");
        ensure!(input.header_names.iter().all(|h| valid_header_name(h)), "A header name is not valid.");
        let lower: BTreeSet<String> = input.header_names.iter().map(|h| h.to_ascii_lowercase()).collect();
        ensure!(lower.len() == input.header_names.len(), "A header is listed twice.");
        if let Some(values) = &input.secret.header_values {
            ensure!(values.len() == input.header_names.len(), "Give each header a value.");
        }
    } else {
        ensure!(input.header_names.is_empty(), "Headers are only for Custom headers.");
    }
    if let Some(client) = &input.client_id {
        ensure!(input.auth == Auth::Oauth && !client.trim().is_empty() && client.len() <= 512 && !client.chars().any(char::is_control), "The client ID is not valid.");
    }
    for value in [&input.secret.token, &input.secret.client_secret].into_iter().flatten().chain(input.secret.header_values.iter().flatten()) {
        ensure!(value.len() <= 16 * 1024 && !value.chars().any(|c| c == '\0' || c == '\n' || c == '\r'), "A secret value is not valid.");
    }
    Ok(target)
}

/// Store the form's secrets for `key`. `previous` is how it was reached
/// before (auth, target, header names); a change of any of them drops what
/// was stored for the old one, an OAuth sign-in included.
fn store_secrets(deps: &Deps, state: &mut State, key: &str, input: &Input, target: &str, previous: Option<(Auth, String, Vec<String>)>) -> Result<()> {
    let same = previous.is_some_and(|(auth, old_target, headers)| auth == input.auth && old_target == target && headers == input.header_names);
    let mut set = Vec::new();
    let mut remove = BTreeSet::new();
    if !same {
        remove.extend(all_vars(key));
        deps.secrets.delete(SERVICE, &refresh_account(key))?;
        state.grants.remove(key);
        state.secrets.remove(key);
    }
    match input.auth {
        Auth::Bearer => {
            if let Some(token) = input.secret.token.as_deref().map(|t| t.trim().trim_start_matches("Bearer ").trim()).filter(|t| !t.is_empty()) {
                set.push((token_var(key), token.to_string()));
            }
        }
        Auth::Headers => match &input.secret.header_values {
            Some(values) => {
                for (i, value) in values.iter().enumerate() {
                    set.push((header_var(key, i), value.trim().to_string()));
                }
            }
            None => ensure!(same, "Enter each header as Name: value."),
        },
        Auth::Oauth | Auth::None => {}
    }
    let own_client = input.auth == Auth::Oauth && input.client_id.is_some();
    match input.secret.client_secret.as_deref().filter(|s| !s.is_empty()) {
        Some(secret) if own_client => deps.secrets.set(SERVICE, &client_secret_account(key), secret.as_bytes())?,
        _ if !own_client => deps.secrets.delete(SERVICE, &client_secret_account(key))?,
        _ => {}
    }
    remove.retain(|name| !set.iter().any(|(n, _)| n == name));
    deps.vars.replace(&set, &remove)?;
    let has = match input.auth {
        Auth::Bearer | Auth::Headers => !set.is_empty() || state.secrets.contains(key),
        Auth::Oauth => state.grants.contains_key(key),
        Auth::None => false,
    };
    if has {
        state.secrets.insert(key.to_string());
    } else {
        state.secrets.remove(key);
    }
    Ok(())
}

/// Add or change a server of this person's own, or this person's secrets
/// for a shared one. Sharing itself goes through the organisation first
/// (`commands`), which then calls this with the shared server's key.
pub(crate) fn save_in(deps: &Deps, input: Input) -> Result<Listing> {
    validate(&input)?;
    let _lock = lock();
    let mut state = read_state(deps)?;
    let rows = installed(&state);
    let key = match &input.key {
        Some(key) => {
            let row = find(&rows, key)?;
            if row.shared_by.is_some() {
                // A member changes only their own secrets for a shared server.
                ensure!(row.name == input.name && row.target == input.target && row.auth == input.auth && row.header_names == input.header_names, "Only its organization can change a shared server.");
            }
            key.clone()
        }
        None => {
            ensure!(state.servers.len() < MAX_SERVERS, "This Mac has {MAX_SERVERS} MCP servers already.");
            local_key(&uuid::Uuid::new_v4().simple().to_string()[..12])
        }
    };
    if key.starts_with("local/") {
        ensure!(!rows.iter().any(|row| row.name == input.name && row.key != key), "A server named {} is already installed.", input.name);
    }
    let target = parse_target(&input.target)?;
    let target_text = match &target {
        Target::Url(url) => url.clone(),
        Target::Command { command, args } => join_words(&std::iter::once(command.clone()).chain(args.iter().cloned()).collect::<Vec<_>>()),
    };
    if let Some(id) = key.strip_prefix("local/") {
        let record = Local {
            id: id.to_string(),
            name: input.name.clone(),
            target: target_text.clone(),
            auth: input.auth,
            header_names: input.header_names.clone(),
            agents: input.agents,
            env: state.servers.iter().find(|s| s.id == id).map(|s| s.env.clone()).unwrap_or_default(),
            client_id: input.client_id.as_ref().map(|c| c.trim().to_string()).filter(|_| input.auth == Auth::Oauth),
        };
        match state.servers.iter_mut().find(|s| s.id == id) {
            Some(existing) => *existing = record,
            None => state.servers.push(record),
        }
    }
    let previous = rows.iter().find(|row| row.key == key).map(|row| (row.auth, row.target.clone(), row.header_names.clone()));
    store_secrets(deps, &mut state, &key, &input, &target_text, previous)?;
    let problems = sync(deps, &mut state);
    write_state(deps, &state)?;
    Ok(listing(&state, problems))
}

/// Remove one of this person's own servers, its secrets and its entries in the agents' files.
pub(crate) fn remove_in(deps: &Deps, key: &str) -> Result<Listing> {
    let _lock = lock();
    let mut state = read_state(deps)?;
    let id = key.strip_prefix("local/").context("Only its organization can remove a shared server; turn it off for yourself instead.")?;
    ensure!(state.servers.iter().any(|s| s.id == id), "This server is no longer installed.");
    state.servers.retain(|s| s.id != id);
    forget_secrets(deps, &mut state, key)?;
    let problems = sync(deps, &mut state);
    write_state(deps, &state)?;
    Ok(listing(&state, problems))
}

/// Turn a shared server off (or back on) for this person on this Mac.
pub(crate) fn set_off_in(deps: &Deps, key: &str, off: bool) -> Result<Listing> {
    let _lock = lock();
    let mut state = read_state(deps)?;
    let rows = installed(&state);
    ensure!(find(&rows, key)?.shared_by.is_some(), "Only a shared server is turned off; remove your own instead.");
    if off {
        state.off.insert(key.to_string());
    } else {
        state.off.remove(key);
    }
    let problems = sync(deps, &mut state);
    write_state(deps, &state)?;
    Ok(listing(&state, problems))
}

/// Forget an OAuth sign-in.
pub(crate) fn sign_out_in(deps: &Deps, key: &str) -> Result<Listing> {
    let _lock = lock();
    let mut state = read_state(deps)?;
    find(&installed(&state), key)?;
    deps.vars.replace(&[], &BTreeSet::from([token_var(key)]))?;
    deps.secrets.delete(SERVICE, &refresh_account(key))?;
    state.grants.remove(key);
    state.secrets.remove(key);
    let problems = sync(deps, &mut state);
    write_state(deps, &state)?;
    Ok(listing(&state, problems))
}

// ------------------------------------------------------------------ import

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFile {
    /// As shown: `~/.claude.json`.
    pub path: String,
    /// Servers in it; none when the file is not there or could not be read.
    pub count: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSource {
    pub files: Vec<ImportFile>,
    /// Servers there that are not installed here yet, by name.
    pub new: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportScan {
    pub claude_code: ImportSource,
    pub codex: ImportSource,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    pub added: Vec<String>,
    /// Name and why, for each server left where it was.
    pub skipped: Vec<(String, String)>,
    pub listing: Listing,
}

/// A found server as this page holds it: the record, and its secrets.
struct Candidate {
    name: String,
    target: String,
    auth: Auth,
    header_names: Vec<String>,
    env: BTreeMap<String, String>,
    token: Option<String>,
    header_values: Vec<String>,
}

fn env_reference(value: &str) -> bool {
    value.contains("${")
}

fn candidate(found: &agent_configs::Found) -> Result<Candidate, String> {
    if !valid_name(&found.name) {
        return Err("its name has characters this page does not use".into());
    }
    match &found.target {
        FoundTarget::Command { command, args, env } => Ok(Candidate {
            name: found.name.clone(),
            target: join_words(&std::iter::once(command.clone()).chain(args.iter().cloned()).collect::<Vec<_>>()),
            auth: Auth::None,
            header_names: Vec::new(),
            env: env.clone(),
            token: None,
            header_values: Vec::new(),
        }),
        FoundTarget::Url { url, headers } => {
            if parse_target(url).map(|t| !matches!(t, Target::Url(_))).unwrap_or(true) {
                return Err("its URL is not https".into());
            }
            if headers.values().any(|v| env_reference(v)) {
                return Err("it reads a header from an environment variable; add it by hand".into());
            }
            let base = Candidate { name: found.name.clone(), target: url.clone(), auth: Auth::Oauth, header_names: Vec::new(), env: BTreeMap::new(), token: None, header_values: Vec::new() };
            let bearer = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("authorization")).and_then(|(_, v)| v.strip_prefix("Bearer ")).map(str::trim);
            Ok(match (headers.len(), bearer) {
                (0, _) => base,
                (1, Some(token)) => Candidate { auth: Auth::Bearer, token: Some(token.to_string()), ..base },
                _ if headers.len() <= MAX_HEADERS && headers.keys().all(|h| valid_header_name(h)) => Candidate {
                    auth: Auth::Headers,
                    header_names: headers.keys().cloned().collect(),
                    header_values: headers.values().cloned().collect(),
                    ..base
                },
                _ => return Err("its headers cannot be kept here".into()),
            })
        }
    }
}

fn found_by_agent(deps: &Deps) -> (Vec<ImportFile>, Vec<agent_configs::Found>, Vec<ImportFile>, Vec<agent_configs::Found>) {
    let (mut claude_files, mut claude, mut codex_files, mut codex) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (side, file, _error) in agent_configs::found_servers(&deps.homes) {
        let entry = ImportFile { path: file.shown, count: file.servers.as_ref().map(Vec::len) };
        let servers = file.servers.unwrap_or_default();
        match side {
            Direction::ToClaude => {
                claude_files.push(entry);
                for server in servers {
                    if !claude.iter().any(|f: &agent_configs::Found| f.name == server.name) {
                        claude.push(server);
                    }
                }
            }
            Direction::ToCodex => {
                codex_files.push(entry);
                codex.extend(servers);
            }
        }
    }
    (claude_files, claude, codex_files, codex)
}

/// What "Import from Claude Code" and "Import from Codex" would bring over.
pub(crate) fn import_scan_in(deps: &Deps) -> Result<ImportScan> {
    let state = read_state(deps)?;
    let rows = installed(&state);
    // What TerminalX wrote is already here.
    let ours = |name: &str| rows.iter().any(|r| r.name == name);
    let (claude_files, claude, codex_files, codex) = found_by_agent(deps);
    let new = |found: &[agent_configs::Found]| found.iter().filter(|f| !ours(&f.name)).map(|f| f.name.clone()).collect();
    Ok(ImportScan {
        claude_code: ImportSource { files: claude_files, new: new(&claude) },
        codex: ImportSource { files: codex_files, new: new(&codex) },
    })
}

/// Bring every server of one agent's files that is not installed here yet
/// into this person's list. A server installed here under that name already
/// gains the agent when it is reached the same way; otherwise it is skipped.
pub(crate) fn import_in(deps: &Deps, from_codex: bool) -> Result<Imported> {
    let _lock = lock();
    let mut state = read_state(deps)?;
    let (_, claude, _, codex) = found_by_agent(deps);
    let found = if from_codex { codex } else { claude };
    let mut added = Vec::new();
    let mut skipped = Vec::new();
    for server in &found {
        let candidate = match candidate(server) {
            Ok(candidate) => candidate,
            Err(why) => {
                skipped.push((server.name.clone(), why));
                continue;
            }
        };
        if let Some(existing) = state.servers.iter_mut().find(|s| s.name == candidate.name) {
            if existing.target == candidate.target {
                if from_codex { existing.agents.codex = true } else { existing.agents.claude_code = true }
            } else {
                skipped.push((candidate.name.clone(), "a server of that name is already installed".into()));
            }
            continue;
        }
        if installed(&state).iter().any(|row| row.name == candidate.name) {
            skipped.push((candidate.name.clone(), "a shared server has that name".into()));
            continue;
        }
        if state.servers.len() >= MAX_SERVERS {
            skipped.push((candidate.name.clone(), format!("this Mac has {MAX_SERVERS} servers already")));
            continue;
        }
        let id = uuid::Uuid::new_v4().simple().to_string()[..12].to_string();
        let key = local_key(&id);
        let mut set = Vec::new();
        if let Some(token) = &candidate.token {
            set.push((token_var(&key), token.clone()));
        }
        for (i, value) in candidate.header_values.iter().enumerate() {
            set.push((header_var(&key, i), value.clone()));
        }
        if !set.is_empty() {
            deps.vars.replace(&set, &BTreeSet::new())?;
            state.secrets.insert(key.clone());
        }
        state.servers.push(Local {
            id,
            name: candidate.name.clone(),
            target: candidate.target,
            auth: candidate.auth,
            header_names: candidate.header_names,
            agents: Agents { claude_code: !from_codex, codex: from_codex },
            env: candidate.env,
            client_id: None,
        });
        added.push(candidate.name);
    }
    let problems = sync(deps, &mut state);
    write_state(deps, &state)?;
    Ok(Imported { added, skipped, listing: listing(&state, problems) })
}

// ------------------------------------------------------------------ status

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "state")]
pub enum Status {
    Connected,
    NeedsSignIn,
    /// A local command that stopped before answering, with its exit code.
    Exited { code: Option<i32> },
    /// A URL that did not answer as an MCP server.
    Unreachable { detail: String },
    Off,
}

/// Check one server answers, refreshing an OAuth sign-in on the way when it
/// is about to run out.
pub(crate) fn check_in(deps: &Deps, key: &str, http: &dyn probe::Http) -> Result<Status> {
    let (server, grant) = {
        let _lock = lock();
        let state = read_state(deps)?;
        (find(&installed(&state), key)?.clone(), state.grants.get(key).cloned())
    };
    if server.off || server.shadowed {
        return Ok(Status::Off);
    }
    if let Some(grant) = grant.filter(|g| oauth::due(g, chrono::Utc::now().timestamp())) {
        let _ = refresh_in(deps, key, &grant, http);
    }
    let values = deps.vars.values()?;
    match parse_target(&server.target)? {
        Target::Command { command, args } => Ok(probe::command(&command, &args, &server.env)),
        Target::Url(url) => {
            let mut headers = Vec::new();
            if let Some(token) = values.get(&token_var(key)).filter(|_| matches!(server.auth, Auth::Bearer | Auth::Oauth)) {
                headers.push(("Authorization".to_string(), format!("Bearer {token}")));
            }
            if server.auth == Auth::Headers {
                for (i, name) in server.header_names.iter().enumerate() {
                    if let Some(value) = values.get(&header_var(key, i)) {
                        headers.push((name.clone(), value.clone()));
                    }
                }
            }
            Ok(probe::url(http, &url, &headers))
        }
    }
}

/// Swap a refresh token for a new access token. A refusal forgets the sign-in.
fn refresh_in(deps: &Deps, key: &str, grant: &Grant, http: &dyn probe::Http) -> Result<()> {
    let Some(refresh) = deps.secrets.get(SERVICE, &refresh_account(key))? else { return Ok(()) };
    let refresh = String::from_utf8(refresh).context("refresh token")?;
    let client_secret = deps.secrets.get(SERVICE, &client_secret_account(key))?.and_then(|s| String::from_utf8(s).ok());
    match oauth::refresh(http, grant, &refresh, client_secret.as_deref()) {
        Ok(tokens) => store_tokens(deps, key, grant.clone(), tokens),
        Err(oauth::Refused::Rejected) => {
            sign_out_in(deps, key)?;
            Ok(())
        }
        Err(oauth::Refused::Failed(error)) => Err(error),
    }
}

fn store_tokens(deps: &Deps, key: &str, mut grant: Grant, tokens: oauth::Tokens) -> Result<()> {
    let _lock = lock();
    let mut state = read_state(deps)?;
    find(&installed(&state), key)?;
    deps.vars.replace(&[(token_var(key), tokens.access_token.clone())], &BTreeSet::new())?;
    if let Some(refresh) = &tokens.refresh_token {
        deps.secrets.set(SERVICE, &refresh_account(key), refresh.as_bytes())?;
    }
    grant.expires_at = tokens.expires_in.map(|s| chrono::Utc::now().timestamp() + s);
    state.grants.insert(key.to_string(), grant);
    state.secrets.insert(key.to_string());
    sync(deps, &mut state);
    write_state(deps, &state)
}

/// Sign in to an OAuth server in the browser and keep what it returns.
pub(crate) fn sign_in_in(deps: &Deps, key: &str, http: &dyn probe::Http, open: &dyn Fn(&str) -> Result<()>) -> Result<Listing> {
    let (server, client) = {
        let _lock = lock();
        let state = read_state(deps)?;
        let rows = installed(&state);
        let server = find(&rows, key)?.clone();
        let client = state.servers.iter().find(|s| local_key(&s.id) == key).and_then(|s| s.client_id.clone());
        (server, client)
    };
    ensure!(server.auth == Auth::Oauth, "This server does not sign in with OAuth.");
    let Target::Url(url) = parse_target(&server.target)? else { bail!("Only a URL server signs in.") };
    let client_secret = match &client {
        Some(_) => deps.secrets.get(SERVICE, &client_secret_account(key))?.and_then(|s| String::from_utf8(s).ok()),
        None => None,
    };
    let (grant, tokens) = oauth::sign_in(http, &url, client.as_deref(), client_secret.as_deref(), open)?;
    store_tokens(
        deps,
        key,
        Grant { token_endpoint: grant.token_endpoint, client_id: grant.client_id, expires_at: None, resource: url },
        tokens,
    )?;
    list_in(deps)
}

/// Refresh every OAuth sign-in about to run out (the upkeep loop).
pub(crate) fn refresh_due_in(deps: &Deps, http: &dyn probe::Http) {
    let Ok(state) = read_state(deps) else { return };
    let now = chrono::Utc::now().timestamp();
    for (key, grant) in state.grants.iter().filter(|(_, g)| oauth::due(g, now)) {
        if let Err(error) = refresh_in(deps, key, grant, http) {
            log::info!("mcp: a sign-in could not be refreshed: {error:#}");
        }
    }
}

/// The production dependencies, built for each call (homes follow the environment).
pub(crate) fn deps() -> Result<Deps> {
    Deps::current()
}

#[cfg(test)]
mod tests;
