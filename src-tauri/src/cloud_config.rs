//! Cloud workspace configuration (PRO-19): the environment, prompts, MCP
//! servers and bound secrets an organization configured for this workspace,
//! injected into the agent sessions the runtime starts.
//!
//! The API resolves the layers (organization < repository < workspace) and
//! answers `POST /v1/cloud-workspace-bootstrap/workspace-config` with the
//! result for this runtime only (contract section 16). The call is
//! authenticated like the agent grants (`cloud_grants`): the runtime
//! credential, the current runtime generation and the grant key enrolled for
//! it. A `cloud_agent_grant_key_required` answer re-enrolls once, exactly as
//! the grant loop does.
//!
//! What lives where:
//!
//! - **Plain configuration** (variables, prompts, MCP definitions) is held in
//!   memory; it is non-secret by construction on the server.
//! - **Secret values** arrive sealed to the grant key (same construction as a
//!   grant, header provider `workspace-config`) and are held in memory only,
//!   wiped when replaced, dropped when their lifetime ends. They are never
//!   logged, never put on a command line and never written to the data
//!   directory. The only file that can hold one is a Claude MCP config,
//!   written 0600 into the workspace's private tmpfs directory from
//!   `cloud_grants` and removed when the session ends; without tmpfs an MCP
//!   server that needs a secret is skipped for Claude.
//!
//! Injection, per new agent session of this workspace:
//!
//! - variables and bound secrets go into the agent process environment.
//!   Names the runtime owns (agent credentials from grants, `PATH`,
//!   `TERMINALX_*`, compute-provider names) are skipped even if a server sent
//!   them, so a grant always wins.
//! - Claude Code: prompts through `--append-system-prompt`, MCP servers
//!   through `--mcp-config <file>`.
//! - Codex: prompts through `-c developer_instructions=…`, MCP servers
//!   through `-c mcp_servers.<name>=…` overrides that name secrets only by
//!   environment variable (`env_vars`, `env_http_headers`). Nothing is
//!   written to the machine user's home or to the managed `CODEX_HOME`.
//! - other harnesses (Cursor over ACP) get the environment only.
//!
//! A session keeps the revision it started with. When the server's revision
//! changes, new sessions get the new one and older sessions are counted in
//! [`status_json`] as needing a restart; none is killed.
//!
//! As the contract says (16.6), anything injected into a runtime can be read
//! by processes in it. This module limits where values go; it cannot hide
//! them from the agent that is meant to use them.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::cloud_grants::{GrantApi, GrantCallError, GrantStore, HttpGrantApi, SealedGrant};

const CONFIG_PATH: &str = "/v1/cloud-workspace-bootstrap/workspace-config";
const SEALED_PROVIDER: &str = "workspace-config";
const MCP_DIR: &str = "mcp";
const SKEW_ALLOWANCE: Duration = Duration::from_secs(30);
const EXPIRY_MARGIN: Duration = Duration::from_secs(60);
const MIN_REFRESH: Duration = Duration::from_secs(5);
const MAX_REFRESH: Duration = Duration::from_secs(15 * 60);
const BACKOFF_START: Duration = Duration::from_secs(1);
const BACKOFF_CAP: Duration = Duration::from_secs(5 * 60);
const REJECTED_PAUSE: Duration = Duration::from_secs(30);
const MAX_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_ENTRIES: usize = 256;

const RESERVED_NAMES: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PWD",
    "TMPDIR",
    "TERM",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PYTHONPATH",
    "PERL5OPT",
    "RUBYOPT",
    "JAVA_TOOL_OPTIONS",
    "EDITOR",
    "VISUAL",
    "PAGER",
    "PROMPT_COMMAND",
    "ZDOTDIR",
    "IFS",
    "BASH_ENV",
    "ENV",
    "PYTHONSTARTUP",
    "SSH_ASKPASS",
    "SSH_AUTH_SOCK",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CODEX_HOME",
    "CURSOR_API_KEY",
    "HCLOUD_TOKEN",
];
const RESERVED_PREFIXES: &[&str] = &["TERMINALX_", "RACCOON_", "GIT_", "LD_", "DYLD_", "MACHINE0_", "HETZNER_", "HCLOUD_", "BOX_", "BOAT_"];

/// True for a name configuration may set on an agent process.
pub fn is_injectable_name(name: &str) -> bool {
    let mut chars = name.chars();
    let valid = name.len() <= 128
        && chars.next().is_some_and(|first| first.is_ascii_uppercase() || first == '_')
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    valid && !RESERVED_NAMES.contains(&name) && !RESERVED_PREFIXES.iter().any(|prefix| name.starts_with(prefix))
}

// ------------------------------------------------------------------ the wire

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub transport: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_env: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret_headers: Option<BTreeMap<String, String>>,
}

impl McpServer {
    fn secret_names(&self) -> impl Iterator<Item = &String> {
        self.secret_env.iter().flat_map(BTreeMap::values).chain(self.secret_headers.iter().flat_map(BTreeMap::values))
    }

    fn valid_name(&self) -> bool {
        !self.name.is_empty() && self.name.len() <= 64 && self.name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Prompt {
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretEnv {
    pub env_name: String,
    pub secret_name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fetched {
    pub v: u8,
    pub workspace_id: String,
    pub runtime_generation: u64,
    pub key_thumbprint: String,
    pub revision: String,
    pub issued_at: u64,
    pub refresh_after: u64,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub prompts: Vec<Prompt>,
    #[serde(default)]
    pub mcp_servers: Vec<Value>,
    #[serde(default)]
    pub secret_env: Vec<SecretEnv>,
    #[serde(default)]
    pub withheld: Vec<Value>,
    #[serde(default)]
    pub secrets: Option<SealedGrant>,
}

#[derive(Deserialize)]
struct SecretsPlaintext {
    v: u8,
    revision: String,
    values: BTreeMap<String, String>,
}

impl Drop for SecretsPlaintext {
    fn drop(&mut self) {
        use zeroize::Zeroize as _;
        for value in self.values.values_mut() {
            value.zeroize();
        }
    }
}

/// The server call; a trait so tests can stand in for the server.
pub trait ConfigApi {
    fn fetch_config(&self, key_thumbprint: &str) -> Result<Value, GrantCallError>;
}

impl ConfigApi for HttpGrantApi {
    fn fetch_config(&self, key_thumbprint: &str) -> Result<Value, GrantCallError> {
        self.post(CONFIG_PATH, json!({ "v": 1, "keyThumbprint": key_thumbprint }))
    }
}

// ------------------------------------------------------------------ the store

/// Opened secret values. Their `Debug` never shows a value.
struct Secrets {
    values: HashMap<String, Zeroizing<String>>,
    usable_until: Instant,
}

impl std::fmt::Debug for Secrets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Secrets({} redacted)", self.values.len())
    }
}

#[derive(Debug, Clone, Default)]
struct Resolved {
    revision: String,
    env: BTreeMap<String, String>,
    prompts: Vec<String>,
    mcp_servers: Vec<McpServer>,
    secret_env: Vec<(String, String)>,
    withheld: usize,
}

#[derive(Debug, Default)]
struct State {
    config: Option<Resolved>,
    secrets: Option<Secrets>,
    /// Running sessions and the revision each started with.
    launches: HashMap<String, String>,
    /// MCP config files written for running sessions.
    files: HashMap<String, PathBuf>,
    last_sync: Option<u64>,
    last_error: Option<String>,
}

/// What a new agent session gets: variables to set and arguments to append
/// (already shell-quoted, each with a leading space).
#[derive(Default, PartialEq, Eq)]
pub struct LaunchConfig {
    pub env: Vec<(String, String)>,
    pub args: String,
}

impl std::fmt::Debug for LaunchConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let names: Vec<&str> = self.env.iter().map(|(name, _)| name.as_str()).collect();
        f.debug_struct("LaunchConfig").field("env", &names).field("args", &self.args).finish()
    }
}

pub struct ConfigStore {
    grants: Arc<GrantStore>,
    state: Mutex<State>,
}

fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

fn launch_file_name(launch: &str) -> String {
    let digest = Sha256::digest(launch.as_bytes());
    format!("{}.json", digest.iter().take(12).map(|byte| format!("{byte:02x}")).collect::<String>())
}

/// The variable a Codex MCP header secret travels in: numbered per launch,
/// so two servers (or two spellings of one header) can never share one.
fn header_var(index: usize) -> String {
    format!("MCP_HEADER_SECRET_{index}")
}

impl ConfigStore {
    pub fn new(grants: Arc<GrantStore>) -> Self {
        Self { grants, state: Mutex::new(State::default()) }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Stop injecting anything: the runtime was fenced or its key refused.
    pub fn drop_all(&self, reason: &str) {
        let mut state = self.state();
        if state.config.is_some() {
            log::warn!("{reason}: workspace configuration is no longer injected into new sessions");
        }
        state.config = None;
        state.secrets = None;
    }

    /// Fetch and apply; returns how long to wait before the next fetch.
    pub fn sync(&self, grant_api: &dyn GrantApi, api: &dyn ConfigApi, received: Instant, wall: u64) -> Result<Duration, GrantCallError> {
        let outcome = self.sync_inner(grant_api, api, received);
        match &outcome {
            Err(GrantCallError::Rejected) => self.drop_all("the configuration API rejected the runtime credential"),
            Err(GrantCallError::KeyConflict) => self.drop_all("the server holds another grant key for this runtime generation"),
            _ => {}
        }
        let mut state = self.state();
        match &outcome {
            Ok(_) => {
                state.last_sync = Some(wall);
                state.last_error = None;
            }
            Err(error) => state.last_error = Some(error.to_string()),
        }
        outcome
    }

    fn sync_inner(&self, grant_api: &dyn GrantApi, api: &dyn ConfigApi, received: Instant) -> Result<Duration, GrantCallError> {
        let (mut thumbprint, mut generation) = self.grants.enrollment(grant_api, false)?;
        let value = match api.fetch_config(&thumbprint) {
            Err(GrantCallError::KeyRequired) => {
                log::info!("the server asked for the grant key again before sending workspace configuration; re-enrolling");
                (thumbprint, generation) = self.grants.enrollment(grant_api, true)?;
                api.fetch_config(&thumbprint)?
            }
            other => other?,
        };
        let fetched: Fetched = serde_json::from_value(value).map_err(|_| GrantCallError::Transient(anyhow!("unreadable workspace configuration")))?;
        self.apply(fetched, &thumbprint, generation, received).map_err(GrantCallError::Transient)
    }

    fn open_secrets(&self, sealed: &SealedGrant, fetched: &Fetched, thumbprint: &str, generation: u64, received: Instant) -> Result<Secrets> {
        let header = &sealed.header;
        if header.provider != SEALED_PROVIDER {
            bail!("the sealed configuration is for provider {:?}", header.provider);
        }
        if header.workspace_id != self.grants.workspace_id() || header.runtime_generation != generation || header.key_thumbprint != thumbprint {
            bail!("the sealed configuration is not for this runtime");
        }
        if header.credential_id != format!("revision.{}", fetched.revision) {
            bail!("the sealed configuration is for another revision");
        }
        if header.issued_at > header.expires_at {
            bail!("the sealed configuration was issued after it expires");
        }
        let lifetime = Duration::from_millis(header.expires_at - header.issued_at).min(MAX_LIFETIME);
        if lifetime <= SKEW_ALLOWANCE {
            bail!("the sealed configuration expires on arrival");
        }
        let bytes = self.grants.open_sealed(sealed)?;
        let plaintext: SecretsPlaintext = serde_json::from_slice(&bytes).map_err(|_| anyhow!("the sealed configuration is unreadable"))?;
        if plaintext.v != 1 || plaintext.revision != fetched.revision {
            bail!("the sealed configuration does not match revision {}", fetched.revision);
        }
        let values = plaintext.values.iter().map(|(name, value)| (name.clone(), Zeroizing::new(value.clone()))).collect();
        Ok(Secrets { values, usable_until: received + (lifetime - SKEW_ALLOWANCE) })
    }

    fn apply(&self, fetched: Fetched, thumbprint: &str, generation: u64, received: Instant) -> Result<Duration> {
        if fetched.v != 1 {
            bail!("unsupported workspace configuration version {}", fetched.v);
        }
        if fetched.workspace_id != self.grants.workspace_id() {
            bail!("the server answered for another workspace");
        }
        if fetched.key_thumbprint != thumbprint || fetched.runtime_generation != generation {
            bail!("the server answered for another key or runtime generation");
        }
        if fetched.env.len() > MAX_ENTRIES || fetched.mcp_servers.len() > MAX_ENTRIES || fetched.secret_env.len() > MAX_ENTRIES {
            bail!("the workspace configuration lists too many entries");
        }
        let secrets = match &fetched.secrets {
            Some(sealed) => Some(self.open_secrets(sealed, &fetched, thumbprint, generation, received)?),
            None => None,
        };
        let has = |name: &str| secrets.as_ref().is_some_and(|secrets| secrets.values.contains_key(name));
        let env: BTreeMap<String, String> = fetched
            .env
            .iter()
            .filter(|(name, _)| {
                let ok = is_injectable_name(name);
                if !ok {
                    log::warn!("skipping workspace variable {name}: the runtime owns that name");
                }
                ok
            })
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect();
        let secret_env: Vec<(String, String)> = fetched
            .secret_env
            .iter()
            .filter(|binding| is_injectable_name(&binding.env_name) && has(&binding.secret_name))
            .map(|binding| (binding.env_name.clone(), binding.secret_name.clone()))
            .collect();
        let mut mcp_servers = Vec::new();
        for (index, raw) in fetched.mcp_servers.iter().enumerate() {
            match serde_json::from_value::<McpServer>(raw.clone()) {
                Ok(server) if server.valid_name() && server.secret_names().all(|name| has(name)) => mcp_servers.push(server),
                Ok(server) => log::warn!("skipping MCP server {:?}: invalid name or a secret it needs was not delivered", server.name),
                Err(_) => log::warn!("skipping malformed MCP server #{index}"),
            }
        }
        let resolved = Resolved {
            revision: fetched.revision.clone(),
            env,
            prompts: fetched.prompts.iter().map(|prompt| prompt.text.clone()).filter(|text| !text.trim().is_empty()).collect(),
            mcp_servers,
            secret_env,
            withheld: fetched.withheld.len(),
        };
        let mut state = self.state();
        if state.config.as_ref().map(|config| config.revision.as_str()) != Some(resolved.revision.as_str()) {
            let stale = state.launches.values().filter(|revision| **revision != resolved.revision).count();
            log::info!(
                "workspace configuration revision {} applied: {} variable(s), {} secret(s), {} MCP server(s), {} prompt(s), {} withheld; {stale} running session(s) need a restart to pick it up",
                resolved.revision,
                resolved.env.len(),
                resolved.secret_env.len(),
                resolved.mcp_servers.len(),
                resolved.prompts.len(),
                resolved.withheld
            );
        }
        let mut wait = Duration::from_millis(fetched.refresh_after.saturating_sub(fetched.issued_at));
        if let Some(secrets) = &secrets {
            wait = wait.min(secrets.usable_until.saturating_duration_since(received).saturating_sub(EXPIRY_MARGIN));
        }
        state.config = Some(resolved);
        state.secrets = secrets;
        Ok(wait.clamp(MIN_REFRESH, MAX_REFRESH))
    }

    fn secret(&self, state: &State, name: &str, now: Instant) -> Option<Zeroizing<String>> {
        state.secrets.as_ref().filter(|secrets| now < secrets.usable_until).and_then(|secrets| secrets.values.get(name).cloned())
    }

    /// Claude's `--mcp-config` document; `None` for a server whose secret is
    /// unavailable.
    fn claude_mcp_json(&self, state: &State, servers: &[McpServer], now: Instant, allow_secrets: bool) -> Map<String, Value> {
        let mut out = Map::new();
        for server in servers {
            if !allow_secrets && server.secret_names().next().is_some() {
                log::warn!("no tmpfs directory: MCP server {:?} needs a secret and is skipped for Claude", server.name);
                continue;
            }
            let resolve = |map: &Option<BTreeMap<String, String>>| -> Option<Map<String, Value>> {
                let mut resolved = Map::new();
                for (key, secret) in map.iter().flatten() {
                    resolved.insert(key.clone(), Value::String(self.secret(state, secret, now)?.to_string()));
                }
                Some(resolved)
            };
            let entry = match server.transport.as_str() {
                "stdio" => {
                    let Some(mut env) = resolve(&server.secret_env) else { continue };
                    for (key, value) in server.env.iter().flatten() {
                        env.insert(key.clone(), Value::String(value.clone()));
                    }
                    let mut entry = json!({ "type": "stdio", "command": server.command, "args": server.args.clone().unwrap_or_default(), "env": env });
                    if let Some(cwd) = &server.cwd {
                        entry["cwd"] = json!(cwd);
                    }
                    entry
                }
                "http" => {
                    let Some(mut headers) = resolve(&server.secret_headers) else { continue };
                    for (key, value) in server.headers.iter().flatten() {
                        headers.insert(key.clone(), Value::String(value.clone()));
                    }
                    json!({ "type": "http", "url": server.url, "headers": headers })
                }
                _ => continue,
            };
            out.insert(server.name.clone(), entry);
        }
        out
    }

    /// Codex `-c` overrides. Secret values are passed as variables and named
    /// in the override, never written into it.
    fn codex_mcp_args(&self, state: &State, servers: &[McpServer], env: &mut Vec<(String, String)>, now: Instant) -> String {
        let mut args = String::new();
        // Every variable already set for this session: a server whose secret
        // would need a name that is taken (or that the runtime owns) is
        // skipped rather than handed someone else's value.
        let mut taken: HashMap<String, String> = env.iter().cloned().collect();
        let mut headers_used = 0;
        for server in servers {
            let mut table = toml::Table::new();
            let mut secret_vars = Vec::new();
            let mut resolved = true;
            match server.transport.as_str() {
                "stdio" => {
                    table.insert("command".into(), toml::Value::String(server.command.clone().unwrap_or_default()));
                    table.insert("args".into(), toml::Value::Array(server.args.iter().flatten().cloned().map(toml::Value::String).collect()));
                    if let Some(cwd) = &server.cwd {
                        table.insert("cwd".into(), toml::Value::String(cwd.clone()));
                    }
                    let plain: toml::Table = server.env.iter().flatten().map(|(key, value)| (key.clone(), toml::Value::String(value.clone()))).collect();
                    if !plain.is_empty() {
                        table.insert("env".into(), toml::Value::Table(plain));
                    }
                    let mut names = Vec::new();
                    for (var, secret) in server.secret_env.iter().flatten() {
                        if !is_injectable_name(var) || taken.contains_key(var) || secret_vars.iter().any(|(name, _)| name == var) {
                            resolved = false;
                            continue;
                        }
                        match self.secret(state, secret, now) {
                            Some(value) => {
                                secret_vars.push((var.clone(), value.to_string()));
                                names.push(toml::Value::String(var.clone()));
                            }
                            None => resolved = false,
                        }
                    }
                    if !names.is_empty() {
                        table.insert("env_vars".into(), toml::Value::Array(names));
                    }
                }
                "http" => {
                    table.insert("url".into(), toml::Value::String(server.url.clone().unwrap_or_default()));
                    let plain: toml::Table = server.headers.iter().flatten().map(|(key, value)| (key.clone(), toml::Value::String(value.clone()))).collect();
                    if !plain.is_empty() {
                        table.insert("http_headers".into(), toml::Value::Table(plain));
                    }
                    let mut from_env = toml::Table::new();
                    for (header, secret) in server.secret_headers.iter().flatten() {
                        match self.secret(state, secret, now) {
                            Some(value) => {
                                let var = loop {
                                    headers_used += 1;
                                    let candidate = header_var(headers_used);
                                    if !taken.contains_key(&candidate) {
                                        break candidate;
                                    }
                                };
                                secret_vars.push((var.clone(), value.to_string()));
                                from_env.insert(header.clone(), toml::Value::String(var));
                            }
                            None => resolved = false,
                        }
                    }
                    if !from_env.is_empty() {
                        table.insert("env_http_headers".into(), toml::Value::Table(from_env));
                    }
                }
                _ => resolved = false,
            }
            if !resolved {
                log::warn!("skipping MCP server {:?} for Codex: a secret it needs is unavailable or its variable name is taken", server.name);
                continue;
            }
            taken.extend(secret_vars.iter().cloned());
            env.extend(secret_vars);
            let inline = toml::Value::Table(table).to_string();
            args.push_str(&format!(" -c {}", quote(&format!("mcp_servers.{}={}", server.name, inline.trim()))));
        }
        args
    }

    /// The configuration for a new agent session of `harness`, recorded under
    /// `launch` for restart tracking. Empty before the first fetch.
    pub fn launch_config(&self, harness: &str, launch: &str, now: Instant) -> LaunchConfig {
        let mut state = self.state();
        let Some(config) = state.config.clone() else {
            state.launches.remove(launch);
            return LaunchConfig::default();
        };
        let mut env: Vec<(String, String)> = config.env.iter().map(|(name, value)| (name.clone(), value.clone())).collect();
        for (name, secret) in &config.secret_env {
            if let Some(value) = self.secret(&state, secret, now) {
                env.push((name.clone(), value.to_string()));
            }
        }
        let prompt = config.prompts.join("\n\n");
        let mut args = String::new();
        match harness {
            "claude" => {
                if !prompt.is_empty() {
                    args.push_str(&format!(" --append-system-prompt {}", quote(&prompt)));
                }
                if !config.mcp_servers.is_empty() {
                    match self.grants.private_root() {
                        Some(root) => {
                            let document = json!({ "mcpServers": self.claude_mcp_json(&state, &config.mcp_servers, now, true) }).to_string();
                            let dir = root.join(MCP_DIR);
                            let path = dir.join(launch_file_name(launch));
                            let written = crate::cloud_grants::prepare_private_dir(&dir).and_then(|()| crate::cloud_grants::write_private(&path, document.as_bytes()));
                            match written {
                                Ok(()) => {
                                    args.push_str(&format!(" --mcp-config {}", quote(&path.to_string_lossy())));
                                    state.files.insert(launch.to_string(), path);
                                }
                                Err(error) => log::warn!("write the MCP config for a new session: {error:#}"),
                            }
                        }
                        // Without tmpfs only servers with no secret may travel,
                        // and then on the command line.
                        None => {
                            let servers = self.claude_mcp_json(&state, &config.mcp_servers, now, false);
                            if !servers.is_empty() {
                                args.push_str(&format!(" --mcp-config {}", quote(&json!({ "mcpServers": servers }).to_string())));
                            }
                        }
                    }
                }
            }
            "codex" => {
                if !prompt.is_empty() {
                    let value = toml::Value::String(prompt).to_string();
                    args.push_str(&format!(" -c {}", quote(&format!("developer_instructions={value}"))));
                }
                args.push_str(&self.codex_mcp_args(&state, &config.mcp_servers, &mut env, now));
            }
            _ => {}
        }
        // Whatever path a name took, the runtime's own never leave here.
        env.retain(|(name, _)| is_injectable_name(name) || name.starts_with("MCP_HEADER_SECRET_"));
        state.launches.insert(launch.to_string(), config.revision.clone());
        LaunchConfig { env, args }
    }

    pub fn forget_launch(&self, launch: &str) {
        let mut state = self.state();
        state.launches.remove(launch);
        if let Some(path) = state.files.remove(launch) {
            crate::cloud_grants::remove_if_present(&path);
        }
    }

    /// What the runtime knows about its configuration. Names only, no values.
    pub fn status(&self, now: Instant) -> Value {
        let state = self.state();
        let current = state.config.as_ref().map(|config| config.revision.clone());
        let stale = state.launches.values().filter(|revision| current.as_ref().is_some_and(|current| current != *revision)).count();
        json!({
            "revision": current,
            "variables": state.config.as_ref().map(|config| config.env.keys().cloned().collect::<Vec<_>>()),
            "secretVariables": state.config.as_ref().map(|config| config.secret_env.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>()),
            "mcpServers": state.config.as_ref().map(|config| config.mcp_servers.iter().map(|server| server.name.clone()).collect::<Vec<_>>()),
            "prompts": state.config.as_ref().map_or(0, |config| config.prompts.len()),
            "withheld": state.config.as_ref().map_or(0, |config| config.withheld),
            "secretsUsable": state.secrets.as_ref().is_some_and(|secrets| now < secrets.usable_until),
            "lastSync": state.last_sync,
            "lastError": state.last_error,
            "restartRequired": stale > 0,
            "restartRequiredSessions": stale,
        })
    }
}

// ------------------------------------------------------------ the loop

fn step(store: &ConfigStore, grant_api: &dyn GrantApi, api: &dyn ConfigApi, rejected: bool, backoff: &mut Duration) -> Duration {
    if rejected {
        store.drop_all("the runtime credential is rejected");
        return REJECTED_PAUSE;
    }
    match store.sync(grant_api, api, Instant::now(), crate::cloud_grants::now_ms()) {
        Ok(wait) => {
            *backoff = BACKOFF_START;
            wait
        }
        Err(error) => {
            log::warn!("fetch workspace configuration: {error}; retrying in {}s", backoff.as_secs());
            let wait = *backoff;
            *backoff = (*backoff * 2).min(BACKOFF_CAP);
            wait
        }
    }
}

/// Keep the configuration fresh at the server's `refreshAfter`, before sealed
/// secrets expire, with backoff on errors.
pub fn spawn_sync_loop(store: Arc<ConfigStore>, api: Arc<HttpGrantApi>, rejected: impl Fn() -> bool + Send + 'static) {
    let spawned = std::thread::Builder::new().name("cloud-workspace-config".into()).spawn(move || {
        let mut backoff = BACKOFF_START;
        loop {
            let wait = step(&store, api.as_ref(), api.as_ref(), rejected(), &mut backoff);
            std::thread::sleep(wait);
        }
    });
    if let Err(error) = spawned {
        log::error!("start the workspace configuration loop: {error}");
    }
}

// ------------------------------------------------------------ the hooks

static STORE: OnceLock<Arc<ConfigStore>> = OnceLock::new();

pub fn install(store: Arc<ConfigStore>) {
    if STORE.set(store).is_err() {
        log::warn!("the workspace configuration store is already installed");
    }
}

/// Configuration for a new agent session; empty outside a cloud workspace.
pub fn launch_config(harness: &str, launch: &str) -> LaunchConfig {
    STORE.get().map(|store| store.launch_config(harness, launch, Instant::now())).unwrap_or_default()
}

/// The names of the variables the workspace configuration gives a new agent
/// session, bound secrets included; empty outside a cloud workspace.
pub fn configured_env_names() -> Vec<String> {
    let Some(store) = STORE.get() else { return Vec::new() };
    let state = store.state();
    let Some(config) = state.config.as_ref() else { return Vec::new() };
    config.env.keys().cloned().chain(config.secret_env.iter().map(|(name, _)| name.clone())).collect()
}

pub fn forget_launch(launch: &str) {
    if let Some(store) = STORE.get() {
        store.forget_launch(launch);
    }
}

pub fn status_json() -> Option<Value> {
    STORE.get().map(|store| store.status(Instant::now()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud_grants::{test_support, GrantHeader};

    const SECRET: &str = "npm_secret_value_4f1c9e";
    const OTHER_SECRET: &str = "sk_search_value_77ab01";

    type Respond = Box<dyn FnMut(&str) -> Result<Value, GrantCallError> + Send>;

    struct FakeServer {
        grants: Arc<GrantStore>,
        response: Mutex<Respond>,
    }

    impl GrantApi for FakeServer {
        fn enroll(&self, grant_public_key_b64: &str) -> Result<crate::cloud_grants::Enrolled, GrantCallError> {
            Ok(test_support::enrolled(grant_public_key_b64, 7))
        }
        fn fetch(&self, _: &str) -> Result<crate::cloud_grants::Fetched, GrantCallError> {
            unreachable!()
        }
    }

    impl ConfigApi for FakeServer {
        fn fetch_config(&self, key_thumbprint: &str) -> Result<Value, GrantCallError> {
            let _ = &self.grants;
            (self.response.lock().unwrap())(key_thumbprint)
        }
    }

    fn sealed(grants: &GrantStore, thumbprint: &str, revision: &str, values: Value, generation: u64) -> Value {
        let header = GrantHeader {
            workspace_id: grants.workspace_id().to_string(),
            provider: SEALED_PROVIDER.into(),
            credential_id: format!("revision.{revision}"),
            key_thumbprint: thumbprint.into(),
            epoch: 1,
            runtime_generation: generation,
            grant_id: "config_1".into(),
            issued_at: 1_000_000,
            expires_at: 1_000_000 + 15 * 60 * 1000,
        };
        let plaintext = json!({ "v": 1, "revision": revision, "values": values }).to_string();
        serde_json::to_value(test_support::seal_to(grants, header, plaintext.as_bytes())).unwrap()
    }

    fn response(grants: &GrantStore, thumbprint: &str, revision: &str, env: Value, secrets: Option<Value>) -> Value {
        json!({
            "v": 1,
            "workspaceId": grants.workspace_id(),
            "runtimeGeneration": 7,
            "keyThumbprint": thumbprint,
            "revision": revision,
            "issuedAt": 1_000_000,
            "refreshAfter": 1_000_000 + 5 * 60 * 1000,
            "env": env,
            "prompts": [{ "scope": "organization", "scopeKey": "", "text": "Org rules." }, { "scope": "workspace", "scopeKey": "ws", "text": "Use pnpm." }],
            "mcpServers": [
                { "name": "docs", "transport": "stdio", "command": "npx", "args": ["-y", "@acme/docs"], "env": { "LOG": "1" }, "secretEnv": { "DOCS_KEY": "NPM_TOKEN" } },
                { "name": "search", "transport": "http", "url": "https://mcp.example.com/mcp", "secretHeaders": { "Authorization": "SEARCH_TOKEN" } }
            ],
            "secretEnv": [{ "envName": "NPM_TOKEN", "secretName": "NPM_TOKEN" }],
            "withheld": [],
            "secrets": secrets.map(|values| sealed(grants, thumbprint, revision, values, 7)),
        })
    }

    fn store(workspace: &str, root: Option<PathBuf>) -> (Arc<ConfigStore>, Arc<GrantStore>) {
        let grants = Arc::new(test_support::grant_store(workspace, root));
        (Arc::new(ConfigStore::new(grants.clone())), grants)
    }

    fn fake(grants: &Arc<GrantStore>, respond: impl FnMut(&str) -> Result<Value, GrantCallError> + Send + 'static) -> FakeServer {
        FakeServer { grants: grants.clone(), response: Mutex::new(Box::new(respond)) }
    }

    fn synced(workspace: &str, env: Value, secrets: Option<Value>, root: Option<PathBuf>) -> Arc<ConfigStore> {
        let (store, grants) = store(workspace, root);
        let inner = grants.clone();
        let api = fake(&grants, move |thumbprint| Ok(response(&inner, thumbprint, "rev-1", env.clone(), secrets.clone())));
        store.sync(&api, &api, Instant::now(), 0).unwrap();
        store
    }

    #[test]
    fn two_workspaces_with_conflicting_settings_inject_their_own() {
        let one = synced("ws-one", json!({ "NODE_ENV": "test" }), Some(json!({ "NPM_TOKEN": SECRET, "SEARCH_TOKEN": OTHER_SECRET })), None);
        let two = synced("ws-two", json!({ "NODE_ENV": "staging" }), None, None);
        let now = Instant::now();
        let a = one.launch_config("cursor", "pane-a", now);
        let b = two.launch_config("cursor", "pane-b", now);
        assert!(a.env.contains(&("NODE_ENV".into(), "test".into())));
        assert!(a.env.contains(&("NPM_TOKEN".into(), SECRET.into())));
        assert_eq!(b.env, vec![("NODE_ENV".to_string(), "staging".to_string())]);
    }

    #[test]
    fn reserved_names_are_never_injected() {
        let store = synced(
            "ws-reserved",
            json!({ "ANTHROPIC_API_KEY": "x", "PATH": "/tmp", "TERMINALX_HOME": "/x", "HCLOUD_TOKEN": "x", "GIT_CONFIG_GLOBAL": "/x", "LD_AUDIT": "x", "PYTHONPATH": "/x", "IFS": " ", "OK_VAR": "1" }),
            None,
            None,
        );
        let config = store.launch_config("claude", "pane", Instant::now());
        let names: Vec<&str> = config.env.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, vec!["OK_VAR"]);
        assert!(!is_injectable_name("CLAUDE_CODE_OAUTH_TOKEN"));
        assert!(is_injectable_name("NPM_TOKEN"));
    }

    #[test]
    fn claude_gets_prompts_and_an_mcp_file_on_tmpfs_and_secrets_stay_off_the_command_line() {
        let dir = tempfile::tempdir().unwrap();
        let store = synced("ws-claude", json!({}), Some(json!({ "NPM_TOKEN": SECRET, "SEARCH_TOKEN": OTHER_SECRET })), Some(dir.path().to_path_buf()));
        let config = store.launch_config("claude", "pane-1", Instant::now());
        assert!(config.args.contains("--append-system-prompt 'Org rules.\n\nUse pnpm.'"));
        assert!(!config.args.contains(SECRET) && !config.args.contains(OTHER_SECRET));
        let path = store.state().files.get("pane-1").cloned().unwrap();
        assert!(config.args.contains(&format!("--mcp-config '{}'", path.display())));
        let document: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(document["mcpServers"]["docs"]["env"]["DOCS_KEY"], SECRET);
        assert_eq!(document["mcpServers"]["docs"]["env"]["LOG"], "1");
        assert_eq!(document["mcpServers"]["search"]["headers"]["Authorization"], OTHER_SECRET);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        store.forget_launch("pane-1");
        assert!(!path.exists());
    }

    #[test]
    fn claude_without_tmpfs_skips_only_the_mcp_servers_that_need_secrets() {
        let (store, grants) = store("ws-notmpfs", None);
        let inner = grants.clone();
        let api = fake(&grants, move |thumbprint| {
            let mut body = response(&inner, thumbprint, "rev-1", json!({}), Some(json!({ "NPM_TOKEN": SECRET, "SEARCH_TOKEN": OTHER_SECRET })));
            body["mcpServers"].as_array_mut().unwrap().push(json!({ "name": "plain", "transport": "stdio", "command": "mcp-plain" }));
            Ok(body)
        });
        store.sync(&api, &api, Instant::now(), 0).unwrap();
        let config = store.launch_config("claude", "pane", Instant::now());
        assert!(config.args.contains("--mcp-config"));
        assert!(config.args.contains("mcp-plain"));
        assert!(!config.args.contains("\"docs\"") && !config.args.contains("\"search\""));
        assert!(!config.args.contains(SECRET) && !config.args.contains(OTHER_SECRET));
    }

    #[test]
    fn codex_mcp_secrets_never_collide_or_replace_runtime_names() {
        let (store, grants) = store("ws-collide", None);
        let inner = grants.clone();
        let api = fake(&grants, move |thumbprint| {
            let mut body = response(&inner, thumbprint, "rev-1", json!({}), Some(json!({ "NPM_TOKEN": SECRET, "SEARCH_TOKEN": OTHER_SECRET })));
            body["mcpServers"] = json!([
                { "name": "a", "transport": "stdio", "command": "a", "secretEnv": { "API_KEY_A": "NPM_TOKEN" } },
                { "name": "b", "transport": "stdio", "command": "b", "secretEnv": { "API_KEY_A": "SEARCH_TOKEN" } },
                { "name": "home", "transport": "stdio", "command": "c", "secretEnv": { "CODEX_HOME": "NPM_TOKEN" } },
                { "name": "my-search", "transport": "http", "url": "https://a.example", "secretHeaders": { "X-Key": "NPM_TOKEN" } },
                { "name": "my_search", "transport": "http", "url": "https://b.example", "secretHeaders": { "X_Key": "SEARCH_TOKEN" } }
            ]);
            Ok(body)
        });
        store.sync(&api, &api, Instant::now(), 0).unwrap();
        let config = store.launch_config("codex", "pane", Instant::now());
        assert!(config.args.contains("mcp_servers.a=") && !config.args.contains("mcp_servers.b="));
        assert!(!config.args.contains("mcp_servers.home="));
        assert!(!config.env.iter().any(|(name, _)| name == "CODEX_HOME"));
        assert_eq!(config.env.iter().filter(|(name, _)| name == "API_KEY_A").count(), 1);
        assert!(config.env.contains(&("MCP_HEADER_SECRET_1".into(), SECRET.into())));
        assert!(config.env.contains(&("MCP_HEADER_SECRET_2".into(), OTHER_SECRET.into())));
    }

    #[test]
    fn codex_names_secrets_by_variable_only() {
        let store = synced("ws-codex", json!({}), Some(json!({ "NPM_TOKEN": SECRET, "SEARCH_TOKEN": OTHER_SECRET })), None);
        let config = store.launch_config("codex", "pane", Instant::now());
        assert!(config.args.contains("developer_instructions="));
        assert!(config.args.contains("mcp_servers.docs="));
        assert!(config.args.contains("env_vars = [\"DOCS_KEY\"]"));
        assert!(config.args.contains("env_http_headers = { Authorization = \"MCP_HEADER_SECRET_1\" }"));
        assert!(!config.args.contains(SECRET) && !config.args.contains(OTHER_SECRET));
        assert!(config.env.contains(&("DOCS_KEY".into(), SECRET.into())));
        assert!(config.env.contains(&("MCP_HEADER_SECRET_1".into(), OTHER_SECRET.into())));
    }

    #[test]
    fn servers_whose_secrets_were_not_delivered_are_skipped() {
        let store = synced("ws-missing", json!({}), Some(json!({ "NPM_TOKEN": SECRET })), None);
        let config = store.launch_config("codex", "pane", Instant::now());
        assert!(config.args.contains("mcp_servers.docs="));
        assert!(!config.args.contains("mcp_servers.search="));
    }

    #[test]
    fn secrets_never_reach_logs_status_or_debug_output() {
        let store = synced("ws-logs", json!({ "A": "1" }), Some(json!({ "NPM_TOKEN": SECRET, "SEARCH_TOKEN": OTHER_SECRET })), None);
        let config = store.launch_config("codex", "pane", Instant::now());
        let state = format!("{:?}", store.state());
        let haystack = format!("{config:?}\n{state}\n{}", store.status(Instant::now()));
        assert!(haystack.contains("NPM_TOKEN"));
        assert!(!haystack.contains(SECRET) && !haystack.contains(OTHER_SECRET), "{haystack}");
    }

    #[test]
    fn refuses_secrets_sealed_for_another_revision_generation_or_workspace() {
        let (store, grants) = store("ws-refuse", None);
        let inner = grants.clone();
        let api = fake(&grants, move |thumbprint| {
            let mut body = response(&inner, thumbprint, "rev-1", json!({}), None);
            body["secrets"] = sealed(&inner, thumbprint, "rev-0", json!({ "NPM_TOKEN": SECRET }), 7);
            Ok(body)
        });
        assert!(store.sync(&api, &api, Instant::now(), 0).is_err());
        let inner = grants.clone();
        let api = fake(&grants, move |thumbprint| {
            let mut body = response(&inner, thumbprint, "rev-1", json!({}), None);
            body["secrets"] = sealed(&inner, thumbprint, "rev-1", json!({ "NPM_TOKEN": SECRET }), 6);
            Ok(body)
        });
        assert!(store.sync(&api, &api, Instant::now(), 0).is_err());
        let inner = grants.clone();
        let api = fake(&grants, move |thumbprint| {
            let mut body = response(&inner, thumbprint, "rev-1", json!({}), None);
            body["workspaceId"] = json!("other");
            Ok(body)
        });
        assert!(store.sync(&api, &api, Instant::now(), 0).is_err());
        assert_eq!(store.launch_config("claude", "pane", Instant::now()), LaunchConfig::default());
    }

    #[test]
    fn re_enrolls_once_when_the_key_is_required() {
        let (store, grants) = store("ws-reenroll", None);
        let inner = grants.clone();
        let mut calls = 0;
        let api = fake(&grants, move |thumbprint| {
            calls += 1;
            if calls == 1 {
                Err(GrantCallError::KeyRequired)
            } else {
                Ok(response(&inner, thumbprint, "rev-1", json!({ "A": "1" }), None))
            }
        });
        store.sync(&api, &api, Instant::now(), 0).unwrap();
        assert_eq!(store.status(Instant::now())["revision"], "rev-1");
    }

    #[test]
    fn a_rejected_credential_stops_injection() {
        let store = synced("ws-rejected", json!({ "A": "1" }), None, None);
        let grants = store.grants.clone();
        let api = fake(&grants, |_| Err(GrantCallError::Rejected));
        assert!(store.sync(&api, &api, Instant::now(), 0).is_err());
        assert_eq!(store.launch_config("claude", "pane", Instant::now()), LaunchConfig::default());
    }

    #[test]
    fn sessions_on_an_older_revision_are_reported_as_needing_a_restart() {
        let (store, grants) = store("ws-restart", None);
        let inner = grants.clone();
        let mut revision = 0;
        let api = fake(&grants, move |thumbprint| {
            revision += 1;
            Ok(response(&inner, thumbprint, &format!("rev-{revision}"), json!({ "A": revision.to_string() }), None))
        });
        store.sync(&api, &api, Instant::now(), 0).unwrap();
        store.launch_config("claude", "old", Instant::now());
        store.sync(&api, &api, Instant::now(), 0).unwrap();
        store.launch_config("claude", "new", Instant::now());
        let status = store.status(Instant::now());
        assert_eq!(status["restartRequiredSessions"], 1);
        store.forget_launch("old");
        assert_eq!(store.status(Instant::now())["restartRequired"], false);
    }

    #[test]
    fn expired_secrets_stop_being_injected() {
        let store = synced("ws-expiry", json!({}), Some(json!({ "NPM_TOKEN": SECRET })), None);
        let later = Instant::now() + Duration::from_secs(20 * 60);
        let config = store.launch_config("cursor", "pane", later);
        assert!(!config.env.iter().any(|(name, _)| name == "NPM_TOKEN"));
    }
}
