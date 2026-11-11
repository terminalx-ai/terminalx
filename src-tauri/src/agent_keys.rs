//! Agent API keys (PRO-306): a key a person gives Claude Code or Codex in
//! Settings → Agents instead of (or beside) the agent's subscription login,
//! kept in the macOS Keychain and handed to the agent when a tab starts.
//!
//! What lives where, as `store::environment` keeps its overrides:
//!
//! - **The key** is one Keychain item per saved revision (service
//!   [`SERVICE`], account `<agent>/<revision>`), written and read by the
//!   desktop only, through `keychain.rs`. A new key is a new item; the index
//!   switches to it only once it is stored, and the old item is deleted after.
//! - **The index**, `$TERMINALX_HOME/agent-logins.json`, says per agent which
//!   login new tabs use, the revision of the saved key, where an imported key
//!   came from (a file *name*) and whether the login shell's key was already
//!   offered. Never the key, a hash of it, or any of its characters.
//! - **The runtime** (`terminalx-serve`, which launches the agents and has
//!   no Keychain) asks the registered desktop for the current revision over
//!   its private, lease-bound socket (`agentKey.snapshot`, which no public
//!   control command can proxy) and holds it in memory only. A launch reads
//!   that memory and never the Keychain.
//!
//! How the agent gets it. Both CLIs are given the key under [`KEY_ENV`], a
//! name no profile sets, so a `.zshrc` that exports its own `ANTHROPIC_API_KEY`
//! cannot shadow the saved one (the PTY's environment is set before the login
//! shell's profile runs):
//!
//! - **Claude Code** reads it through an `apiKeyHelper` in the launch's
//!   `--settings` (`/usr/bin/printenv TERMINALX_AGENT_API_KEY`). A plain
//!   `ANTHROPIC_API_KEY` makes the interactive CLI stop on "Detected a custom
//!   API key in your environment · Do you want to use this API key?" before
//!   its composer (probed against Claude Code 2.1.322); a helper does not, and
//!   nothing is written to `~/.claude.json`. The variables that would outrank
//!   a helper are unset after the profile, and the endpoint is pinned in the
//!   same `--settings` so a checkout's `.claude/settings.json` cannot send the
//!   key elsewhere.
//! - **Codex** gets a `model_providers` entry of its own whose `env_key` is
//!   [`KEY_ENV`] (its app server takes no API key from `OPENAI_API_KEY` or
//!   `CODEX_API_KEY` alone, probed against Codex 0.166.0; overriding the
//!   built-in `openai` provider is refused), pointed at OpenAI or at the
//!   person's own OpenAI-compatible endpoint ("Custom provider").
//!
//! A tab keeps the login it started with until it is restarted: what each
//! running agent launched with is recorded ([`record_launch`]) so Settings can
//! say how many keep an older one and restart exactly those.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::agent_route_check::{CredentialHeader, ModelList};
use crate::keychain::SecretStore;

const SERVICE: &str = "dev.terminalx.agent-keys";
const INDEX: &str = "agent-logins.json";
const LOCK: &str = "agent-logins.lock";
/// The variable a launched agent reads its saved key from.
pub const KEY_ENV: &str = "TERMINALX_AGENT_API_KEY";
/// The Codex model provider a saved key defines; not one of Codex's reserved ids.
const CODEX_PROVIDER: &str = "terminalx-api-key";
const MAX_KEY_BYTES: usize = 4096;
/// A launch right after a key was saved waits this long for the runtime to
/// have it, rather than start on the wrong login.
const LAUNCH_WAIT: Duration = Duration::from_secs(3);
/// How long the login shell may take to start and print one variable.
const SHELL_TIMEOUT: Duration = Duration::from_secs(8);
/// The largest startup file searched for where a variable is set.
const MAX_STARTUP_FILE: u64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Agent {
    Claude,
    Codex,
}

impl Agent {
    pub const ALL: [Agent; 2] = [Agent::Claude, Agent::Codex];

    pub fn of(harness: &str) -> Option<Self> {
        match harness {
            "claude" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
        }
    }

    /// The variable the provider's own tools read this kind of key from:
    /// what the key is, and what the login shell is searched for.
    pub fn variable(self) -> &'static str {
        match self {
            Self::Claude => "ANTHROPIC_API_KEY",
            Self::Codex => "OPENAI_API_KEY",
        }
    }

    fn model_list(self) -> ModelList {
        match self {
            Self::Claude => ModelList::Anthropic,
            Self::Codex => ModelList::OpenAi,
        }
    }

    /// As the CLI sends it: Claude Code sends a helper's output both ways.
    fn header(self) -> CredentialHeader {
        match self {
            Self::Claude => CredentialHeader::Both,
            Self::Codex => CredentialHeader::Bearer,
        }
    }

    fn default_base_url(self) -> &'static str {
        match self {
            Self::Claude => "https://api.anthropic.com",
            Self::Codex => "https://api.openai.com/v1",
        }
    }

    /// Variables that would outrank the saved key, removed after the profile.
    fn shadowing(self) -> &'static [&'static str] {
        match self {
            // Claude Code takes ANTHROPIC_AUTH_TOKEN, then ANTHROPIC_API_KEY,
            // then a helper; a cloud provider switch beats them all.
            Self::Claude => &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"],
            // Codex's own provider entry reads only KEY_ENV.
            Self::Codex => &[],
        }
    }

    /// What a subscription login must not be talked out of: the variables a
    /// profile may export that would make the CLI use a key instead.
    fn subscription_shadowing(self) -> &'static [&'static str] {
        match self {
            Self::Claude => &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
            // Codex's built-in provider never takes a key from the environment.
            Self::Codex => &[],
        }
    }
}

/// Which login new tabs of an agent use.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    /// Nothing chosen here: the agent signs in as it would in a terminal.
    #[default]
    Default,
    /// The agent's own subscription login, chosen here: a key a profile
    /// exports is kept from it.
    Subscription,
    /// The key saved here.
    ApiKey,
}

impl Mode {
    fn name(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Subscription => "subscription",
            Self::ApiKey => "api_key",
        }
    }
}

/// Where an imported key was found: the startup file's name, `~`-relative,
/// or none when the login shell had it from elsewhere.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSource {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    revision: String,
    saved_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    from_shell: Option<ShellSource>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ShellOffer {
    Imported,
    Dismissed,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    #[serde(default)]
    mode: Mode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key: Option<Saved>,
    /// Codex's "Custom provider": where the key is sent instead of OpenAI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    base_url: Option<String>,
    /// The login shell's key is offered once: imported, or declined.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    shell_offer: Option<ShellOffer>,
}

impl Entry {
    /// What a tab launched now runs with, as far as telling two apart goes.
    fn stamp(&self) -> String {
        match self.mode {
            Mode::ApiKey => format!(
                "api_key:{}:{}",
                self.key.as_ref().map(|key| key.revision.as_str()).unwrap_or_default(),
                self.base_url.as_deref().unwrap_or_default()
            ),
            mode => mode.name().to_string(),
        }
    }
}

type Index = BTreeMap<String, Entry>;

fn account(agent: Agent, revision: &str) -> String {
    format!("{}/{revision}", agent.id())
}

/// A key as an agent can be given one: printable ASCII, no spaces, a sane
/// length. Errors say what is wrong with it, never what it is.
fn validate_key(key: &str) -> Result<()> {
    ensure!(!key.is_empty(), "Paste a key first.");
    ensure!(key.len() <= MAX_KEY_BYTES, "That is too long to be an API key.");
    ensure!(key.bytes().all(|byte| byte.is_ascii_graphic()), "Paste the key alone: it cannot contain spaces, line breaks or other characters keys never have.");
    Ok(())
}

/// The key as Settings shows it: its kind (a known prefix) and, for a key
/// long enough that four characters give nothing away, its last four.
pub fn masked(key: &str) -> String {
    const PREFIXES: &[&str] = &["sk-ant-api03-", "sk-ant-admin01-", "sk-ant-", "sk-proj-", "sk-svcacct-", "sk-admin-", "sk-"];
    let prefix = PREFIXES.iter().find(|prefix| key.starts_with(**prefix) && key.len() >= prefix.len() + 16).copied().unwrap_or("");
    let tail = if key.len() >= 24 && key.is_ascii() { &key[key.len() - 4..] } else { "" };
    format!("{prefix}{}{tail}", "•".repeat(24))
}

struct Store<'a> {
    root: PathBuf,
    secrets: &'a dyn SecretStore,
}

impl<'a> Store<'a> {
    fn index(&self) -> Result<Index> {
        // Never the parser's error: a hand-edited file might hold a key.
        crate::store::read_json(&self.root.join(INDEX))
            .map(Option::unwrap_or_default)
            .map_err(|_| anyhow::anyhow!("Could not read the agent login settings."))
    }

    fn entry(&self, agent: Agent) -> Result<Entry> {
        Ok(self.index()?.remove(agent.id()).unwrap_or_default())
    }

    /// Change one agent's entry under the file lock. `change` may refuse.
    fn update<T>(&self, agent: Agent, change: impl FnOnce(&mut Entry) -> Result<T>) -> Result<T> {
        crate::store::transaction::run(&self.root.join(LOCK), Duration::from_secs(10), || {
            let mut index = self.index()?;
            let mut entry = index.remove(agent.id()).unwrap_or_default();
            let out = change(&mut entry)?;
            index.insert(agent.id().to_string(), entry);
            crate::store::write_json(&self.root.join(INDEX), &index).map_err(|_| anyhow::anyhow!("Could not save the agent login settings. Nothing changed."))?;
            Ok(out)
        })
    }

    /// Store a new key and make it the agent's login. The Keychain write
    /// comes first and outside the lock (it may wait on the person); the
    /// index then switches, and the key it replaces is deleted.
    fn save_key(&self, agent: Agent, key: &str, from_shell: Option<ShellSource>) -> Result<()> {
        validate_key(key)?;
        let revision = uuid::Uuid::new_v4().to_string();
        self.secrets.set(SERVICE, &account(agent, &revision), key.as_bytes())
            .map_err(|_| anyhow::anyhow!("Could not save the key to the Keychain. Nothing changed."))?;
        let imported = from_shell.is_some();
        let committed = self.update(agent, |entry| {
            let old = entry.key.replace(Saved { revision: revision.clone(), saved_at: chrono::Utc::now().to_rfc3339(), from_shell });
            entry.mode = Mode::ApiKey;
            if imported {
                entry.shell_offer = Some(ShellOffer::Imported);
            }
            Ok(old)
        });
        match committed {
            Ok(old) => {
                if let Some(old) = old {
                    let _ = self.secrets.delete(SERVICE, &account(agent, &old.revision));
                }
                Ok(())
            }
            Err(error) => {
                let _ = self.secrets.delete(SERVICE, &account(agent, &revision));
                Err(error)
            }
        }
    }

    /// Forget the key: new tabs go back to the subscription login, and the
    /// Keychain item is deleted. The index lets go of it first, so a failed
    /// delete leaves an item nothing uses rather than a login that is gone.
    fn remove_key(&self, agent: Agent) -> Result<()> {
        let old = self.update(agent, |entry| {
            entry.mode = Mode::Subscription;
            Ok(entry.key.take())
        })?;
        if let Some(old) = old {
            self.secrets.delete(SERVICE, &account(agent, &old.revision))
                .map_err(|_| anyhow::anyhow!("TerminalX no longer uses the key, but could not delete it from the Keychain. Delete the item {SERVICE} in Keychain Access."))?;
        }
        Ok(())
    }

    fn set_mode(&self, agent: Agent, mode: Mode) -> Result<()> {
        self.update(agent, |entry| {
            ensure!(mode != Mode::ApiKey || entry.key.is_some(), "Save a key first.");
            entry.mode = mode;
            Ok(())
        })
    }

    fn set_base_url(&self, agent: Agent, base_url: Option<&str>) -> Result<()> {
        ensure!(agent == Agent::Codex, "Only Codex takes a custom provider.");
        let base_url = base_url.map(str::trim).filter(|url| !url.is_empty());
        if let Some(url) = base_url {
            ensure!(crate::agent_route_check::valid_base_url(url), "Use an https:// address (or http:// to this Mac), with no user name, query or fragment.");
        }
        self.update(agent, |entry| {
            entry.base_url = base_url.map(|url| url.trim_end_matches('/').to_string());
            Ok(())
        })
    }

    fn dismiss_offer(&self, agent: Agent) -> Result<()> {
        self.update(agent, |entry| {
            entry.shell_offer.get_or_insert(ShellOffer::Dismissed);
            Ok(())
        })
    }

    /// The saved key and its revision, read from the Keychain.
    fn read(&self, agent: Agent) -> Result<Option<(String, Zeroizing<String>)>> {
        let Some(saved) = self.entry(agent)?.key else { return Ok(None) };
        let key = self.item(agent, &saved.revision)?;
        Ok(Some((saved.revision, key)))
    }

    fn item(&self, agent: Agent, revision: &str) -> Result<Zeroizing<String>> {
        let bytes = Zeroizing::new(
            self.secrets.get(SERVICE, &account(agent, revision))
                .map_err(|_| anyhow::anyhow!("Could not read {}'s API key from the Keychain.", agent.label()))?
                .with_context(|| format!("{}'s API key is missing from the Keychain. Save it again in Settings → Agents.", agent.label()))?,
        );
        let key = Zeroizing::new(String::from_utf8(bytes.to_vec()).map_err(|_| anyhow::anyhow!("The Keychain item for {}'s API key is not a key.", agent.label()))?);
        validate_key(&key).map_err(|_| anyhow::anyhow!("The Keychain item for {}'s API key is not a key.", agent.label()))?;
        Ok(key)
    }

    /// The key of `revision`, for the runtime, only while it is the current one.
    fn snapshot(&self, agent: Agent, revision: &str) -> Result<Zeroizing<String>> {
        let current = self.entry(agent)?.key.map(|saved| saved.revision);
        ensure!(current.as_deref() == Some(revision), "The key changed.");
        let key = self.item(agent, revision)?;
        ensure!(self.entry(agent)?.key.map(|saved| saved.revision).as_deref() == Some(revision), "The key changed.");
        Ok(key)
    }
}

fn store() -> Result<Store<'static>> {
    Ok(Store { root: crate::store::root()?, secrets: &crate::keychain::Keychain })
}

fn agent_of(harness: &str) -> Result<Agent> {
    Agent::of(harness).with_context(|| format!("{harness} does not take an API key in Settings."))
}

// ------------------------------------------------------------ verification

/// The last check of a saved key against its provider, for Settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Verified {
    pub ok: bool,
    /// Why it is not verified, in words: never a response body or header.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub checked_at: String,
    #[serde(skip)]
    revision: String,
    #[serde(skip)]
    base_url: String,
}

fn verified() -> &'static Mutex<HashMap<Agent, Verified>> {
    static VERIFIED: OnceLock<Mutex<HashMap<Agent, Verified>>> = OnceLock::new();
    VERIFIED.get_or_init(Default::default)
}

fn host_of(base_url: &str) -> String {
    url::Url::parse(base_url).ok().and_then(|url| url.host_str().map(str::to_string)).unwrap_or_else(|| "the endpoint".into())
}

/// A check's outcome in words for the status line.
fn reason(checked: &crate::agent_route_check::Checked, base_url: &str) -> Option<String> {
    if checked.passed() {
        return None;
    }
    let status = checked.http_status.map(|status| format!(" (HTTP {status})")).unwrap_or_default();
    let host = host_of(base_url);
    Some(match checked.code.unwrap_or("") {
        "unauthorized" => format!("{host} refused this key{status}. Check it was copied whole, or make a new one"),
        "forbidden" => format!("{host} accepted this key but refused it access{status}"),
        "models-unlisted" => format!("{host} answered without a model list, so the key could not be checked{status}"),
        "rate-limited" => format!("{host} is rate limiting this key{status}; check again in a minute"),
        "redirect" => format!("{host} answered with a redirect, which is never followed with a key{status}"),
        "timeout" => format!("{host} did not answer in time"),
        "tls" => format!("could not make a secure connection to {host}"),
        "unreachable" => format!("could not reach {host}"),
        _ => format!("{host} did not answer like a model API{status}"),
    })
}

fn base_url_of(agent: Agent, entry: &Entry) -> String {
    entry.base_url.clone().filter(|_| agent == Agent::Codex).unwrap_or_else(|| agent.default_base_url().to_string())
}

fn verify_with(store: &Store<'_>, agent: Agent, probe: impl Fn(&crate::agent_route_check::Probe<'_>) -> crate::agent_route_check::Checked) -> Result<Verified> {
    let entry = store.entry(agent)?;
    let Some((revision, key)) = store.read(agent)? else { bail!("Save a key first.") };
    let base_url = base_url_of(agent, &entry);
    let checked = probe(&crate::agent_route_check::Probe { list: agent.model_list(), base_url: &base_url, credential: &key, header: agent.header(), model: None });
    let result = Verified { ok: checked.passed(), reason: reason(&checked, &base_url), checked_at: chrono::Utc::now().to_rfc3339(), revision, base_url };
    verified().lock().unwrap().insert(agent, result.clone());
    Ok(result)
}

// ------------------------------------------------------------ the login shell

/// A key the login shell exports, and the startup file that sets it.
pub struct ShellKey {
    pub key: Zeroizing<String>,
    pub file: Option<PathBuf>,
}

fn known_shell(shell: &Path) -> bool {
    matches!(shell.file_name().and_then(|name| name.to_str()), Some("zsh" | "bash" | "fish" | "sh" | "dash" | "ksh"))
}

/// What the person's login shell has for `name`, as an interactive login
/// shell (their own terminal) sees it: `~/.zshrc` is read only by an
/// interactive zsh. Bounded in time, with no input; nothing it prints but
/// the variable is kept.
fn login_shell_value(shell: &Path, name: &str) -> Option<Zeroizing<String>> {
    const MARK: &str = "__TERMINALX_AGENT_KEY__";
    if !known_shell(shell) || !name.bytes().all(|byte| byte.is_ascii_uppercase() || byte == b'_') {
        return None;
    }
    let mut command = std::process::Command::new(shell);
    command.args(["-l", "-i", "-c", &format!("printf '%s' {MARK}; printenv {name}; printf '%s' {MARK}")])
        .stdin(std::process::Stdio::null())
        .env("TERM", "dumb")
        .env_remove(KEY_ENV);
    let output = crate::git::capture_within(command, SHELL_TIMEOUT).ok()?;
    let stdout = Zeroizing::new(output.stdout);
    let text = std::str::from_utf8(&stdout).ok()?;
    let start = text.find(MARK)? + MARK.len();
    let end = start + text[start..].find(MARK)?;
    let value = Zeroizing::new(text[start..end].trim().to_string());
    validate_key(&value).ok()?;
    Some(value)
}

/// The startup files a login shell may read, in the order it reads them.
fn startup_files(shell: &Path, home: &Path, zdotdir: Option<&Path>) -> Vec<PathBuf> {
    let z = zdotdir.unwrap_or(home);
    match shell.file_name().and_then(|name| name.to_str()) {
        Some("zsh") => vec![z.join(".zshenv"), z.join(".zprofile"), z.join(".zshrc"), z.join(".zlogin"), home.join(".profile")],
        Some("bash") => vec![home.join(".bash_profile"), home.join(".bash_login"), home.join(".profile"), home.join(".bashrc")],
        Some("fish") => vec![home.join(".config/fish/config.fish")],
        _ => vec![home.join(".profile")],
    }
}

/// Whether a line of a startup file sets `name`: `export NAME=`, `NAME=`,
/// fish's `set -gx NAME`, csh's `setenv NAME`.
fn sets(line: &str, name: &str) -> bool {
    let line = line.trim_start();
    if line.starts_with('#') {
        return false;
    }
    let assigned = |rest: &str| rest.strip_prefix(name).is_some_and(|after| after.starts_with('='));
    let named = |rest: &str| rest.strip_prefix(name).is_some_and(|after| after.starts_with(char::is_whitespace));
    if assigned(line) || line.strip_prefix("export").is_some_and(|rest| rest.starts_with(char::is_whitespace) && assigned(rest.trim_start())) {
        return true;
    }
    if let Some(rest) = line.strip_prefix("setenv").filter(|rest| rest.starts_with(char::is_whitespace)) {
        return named(rest.trim_start());
    }
    if let Some(rest) = line.strip_prefix("set").filter(|rest| rest.starts_with(char::is_whitespace)) {
        let mut words = rest.split_whitespace();
        let mut exported = false;
        for word in words.by_ref() {
            if !word.starts_with('-') {
                return exported && word == name;
            }
            exported |= word == "--export" || (!word.starts_with("--") && word.contains('x'));
        }
    }
    false
}

/// The first startup file that sets `name`, if one plainly does.
fn file_setting(files: &[PathBuf], name: &str) -> Option<PathBuf> {
    use std::io::Read;
    files.iter().find(|path| {
        let Ok(file) = std::fs::File::open(path) else { return false };
        let mut raw = Zeroizing::new(Vec::new());
        if file.take(MAX_STARTUP_FILE).read_to_end(&mut raw).is_err() {
            return false;
        }
        String::from_utf8_lossy(&raw).lines().any(|line| sets(line, name))
    }).cloned()
}

/// `~/…` for a path in `home`, for display.
fn display_path(path: &Path, home: &Path) -> String {
    match path.strip_prefix(home) {
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.display().to_string(),
    }
}

fn user_shell() -> PathBuf {
    std::env::var_os("SHELL").filter(|shell| !shell.is_empty()).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/bin/zsh"))
}

fn shell_key_in(shell: &Path, home: &Path, zdotdir: Option<&Path>, agent: Agent) -> Option<ShellKey> {
    let key = login_shell_value(shell, agent.variable())?;
    let file = file_setting(&startup_files(shell, home, zdotdir), agent.variable());
    Some(ShellKey { key, file })
}

fn shell_key(agent: Agent) -> Option<ShellKey> {
    let home = dirs::home_dir()?;
    let zdotdir = std::env::var_os("ZDOTDIR").filter(|dir| !dir.is_empty()).map(PathBuf::from);
    shell_key_in(&user_shell(), &home, zdotdir.as_deref(), agent)
}

// ------------------------------------------------------------ for Settings

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedStatus {
    pub masked: String,
    pub saved_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from_shell: Option<ShellSource>,
}

/// What Settings shows for an agent. Never the key.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub harness: &'static str,
    pub variable: &'static str,
    pub mode: Mode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub saved: Option<SavedStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// The last check of this key at this address, if it has been checked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified: Option<Verified>,
    /// The saved key could not be read back from the Keychain.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
    /// The agent's own settings file, `~`-relative: Codex's `config.toml`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,
}

fn config_file(agent: Agent) -> Option<String> {
    let home = dirs::home_dir()?;
    match agent {
        Agent::Codex => crate::harness::codex::home::user_root().map(|root| display_path(&root.join("config.toml"), &home)),
        Agent::Claude => None,
    }
}

fn status_of(store: &Store<'_>, agent: Agent) -> Result<Status> {
    let entry = store.entry(agent)?;
    let mut problem = None;
    let saved = match &entry.key {
        Some(saved) => match store.item(agent, &saved.revision) {
            Ok(key) => Some(SavedStatus { masked: masked(&key), saved_at: saved.saved_at.clone(), from_shell: saved.from_shell.clone() }),
            Err(error) => {
                problem = Some(error.to_string());
                Some(SavedStatus { masked: "•".repeat(24), saved_at: saved.saved_at.clone(), from_shell: saved.from_shell.clone() })
            }
        },
        None => None,
    };
    let base_url = base_url_of(agent, &entry);
    let verified = entry.key.as_ref().and_then(|saved| {
        verified().lock().unwrap().get(&agent).filter(|checked| checked.revision == saved.revision && checked.base_url == base_url).cloned()
    });
    Ok(Status { harness: agent.id(), variable: agent.variable(), mode: entry.mode, saved, base_url: entry.base_url.clone().filter(|_| agent == Agent::Codex), verified, problem, config: config_file(agent) })
}

pub fn status(harness: &str) -> Result<Status> {
    status_of(&store()?, agent_of(harness)?)
}

pub fn save_key(harness: &str, key: Zeroizing<String>) -> Result<Status> {
    let store = store()?;
    let agent = agent_of(harness)?;
    store.save_key(agent, key.trim(), None)?;
    status_of(&store, agent)
}

pub fn remove_key(harness: &str) -> Result<Status> {
    let store = store()?;
    let agent = agent_of(harness)?;
    store.remove_key(agent)?;
    status_of(&store, agent)
}

pub fn set_mode(harness: &str, mode: Mode) -> Result<Status> {
    let store = store()?;
    let agent = agent_of(harness)?;
    store.set_mode(agent, mode)?;
    status_of(&store, agent)
}

pub fn set_base_url(harness: &str, base_url: Option<String>) -> Result<Status> {
    let store = store()?;
    let agent = agent_of(harness)?;
    store.set_base_url(agent, base_url.as_deref())?;
    status_of(&store, agent)
}

pub fn verify(harness: &str) -> Result<Verified> {
    verify_with(&store()?, agent_of(harness)?, crate::agent_route_check::probe)
}

/// The login shell's key, while it may still be offered: no key saved here
/// and the offer neither taken nor declined.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellOfferStatus {
    pub variable: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
}

fn offerable(entry: &Entry) -> bool {
    entry.key.is_none() && entry.shell_offer.is_none()
}

pub fn shell_offer(harness: &str) -> Result<Option<ShellOfferStatus>> {
    let agent = agent_of(harness)?;
    if !offerable(&store()?.entry(agent)?) {
        return Ok(None);
    }
    let home = dirs::home_dir().context("no home directory")?;
    Ok(shell_key(agent).map(|found| ShellOfferStatus { variable: agent.variable(), file: found.file.map(|file| display_path(&file, &home)) }))
}

fn import_from(store: &Store<'_>, agent: Agent, found: Option<ShellKey>, home: &Path) -> Result<()> {
    ensure!(offerable(&store.entry(agent)?), "{}'s login shell key was already offered.", agent.label());
    let found = found.with_context(|| format!("Your login shell no longer has {}.", agent.variable()))?;
    store.save_key(agent, &found.key, Some(ShellSource { file: found.file.map(|file| display_path(&file, home)) }))
}

/// Copy the login shell's key into the Keychain, once.
pub fn import_shell(harness: &str) -> Result<Status> {
    let store = store()?;
    let agent = agent_of(harness)?;
    let home = dirs::home_dir().context("no home directory")?;
    import_from(&store, agent, shell_key(agent), &home)?;
    status_of(&store, agent)
}

pub fn dismiss_shell(harness: &str) -> Result<()> {
    store()?.dismiss_offer(agent_of(harness)?)
}

// ------------------------------------------------------------ the runtime

/// The registered desktop's answer to the runtime's `agentKey.snapshot`.
/// Only ever sent on that private socket.
#[cfg(feature = "desktop")]
pub(crate) fn desktop_snapshot(harness: &str, revision: &str) -> Result<serde_json::Value> {
    use std::sync::atomic::{AtomicBool, Ordering};
    // A Keychain prompt may outlive the runtime's request: do not pile up
    // more blocked reads behind it.
    static READING: AtomicBool = AtomicBool::new(false);
    ensure!(!READING.swap(true, Ordering::AcqRel), "A key is already being read.");
    struct Reading;
    impl Drop for Reading {
        fn drop(&mut self) {
            READING.store(false, Ordering::Release);
        }
    }
    let _reading = Reading;
    let key = store()?.snapshot(agent_of(harness)?, revision)?;
    Ok(serde_json::json!({ "revision": revision, "key": key.as_str() }))
}

/// The keys a runtime holds in memory, by agent, with their revision.
#[derive(Default)]
struct Keys {
    held: Mutex<HashMap<Agent, (String, Zeroizing<String>)>>,
    filled: Condvar,
}

/// This runtime's keys.
fn keys() -> &'static Keys {
    static KEYS: OnceLock<Keys> = OnceLock::new();
    KEYS.get_or_init(Default::default)
}

impl Keys {
    /// Bring the keys in line with the index: drop what is no longer current
    /// or no longer used, fetch what is missing. Only a key new tabs use is
    /// held: one kept for later while the subscription is chosen stays in
    /// the Keychain alone. No lock is held while fetching.
    fn refresh(&self, index: &Index, fetch: impl Fn(Agent, &str) -> Result<Zeroizing<String>>) {
        let wanted: Vec<(Agent, String)> = Agent::ALL.into_iter()
            .filter_map(|agent| index.get(agent.id()).filter(|entry| entry.mode == Mode::ApiKey).and_then(|entry| entry.key.as_ref()).map(|saved| (agent, saved.revision.clone())))
            .collect();
        let missing: Vec<(Agent, String)> = {
            let mut held = self.held.lock().unwrap();
            held.retain(|agent, (revision, _)| wanted.iter().any(|(want, current)| want == agent && current == revision));
            wanted.into_iter().filter(|(agent, _)| !held.contains_key(agent)).collect()
        };
        for (agent, revision) in missing {
            if let Ok(key) = fetch(agent, &revision) {
                if validate_key(&key).is_ok() {
                    self.held.lock().unwrap().insert(agent, (revision, key));
                    self.filled.notify_all();
                }
            }
        }
    }

    /// `agent`'s key of `revision`, waiting up to `wait` for it to arrive.
    fn get(&self, agent: Agent, revision: &str, wait: Duration) -> Option<Zeroizing<String>> {
        let deadline = Instant::now() + wait;
        let mut held = self.held.lock().unwrap();
        loop {
            if let Some((current, key)) = held.get(&agent) {
                if current == revision {
                    return Some(key.clone());
                }
            }
            let left = deadline.checked_duration_since(Instant::now())?;
            held = self.filled.wait_timeout(held, left).unwrap().0;
        }
    }
}

/// Keep the runtime's keys current while a desktop is attached. A failed
/// read is tried again with a growing delay, as environment snapshots are.
#[cfg(unix)]
pub(crate) fn start(lifetime: &std::sync::Arc<crate::local_runtime::Lifetime>) -> Result<()> {
    let lifetime = std::sync::Arc::downgrade(lifetime);
    std::thread::Builder::new().name("agent-keys".into()).spawn(move || {
        let mut failures: HashMap<String, (Instant, Duration)> = HashMap::new();
        while let Some(lifetime) = lifetime.upgrade() {
            if lifetime.is_stopping() {
                break;
            }
            if lifetime.window.available() {
                if let Ok(index) = store().and_then(|store| store.index()) {
                    failures.retain(|revision, _| index.values().any(|entry| entry.key.as_ref().is_some_and(|key| &key.revision == revision)));
                    let failed = Mutex::new(Vec::new());
                    keys().refresh(&index, |agent, revision| {
                        if failures.get(revision).is_some_and(|(after, _)| Instant::now() < *after) {
                            bail!("waiting to try again");
                        }
                        let fetched = lifetime.window.agent_key_snapshot(agent.id(), revision);
                        if fetched.is_err() {
                            failed.lock().unwrap().push(revision.to_string());
                        }
                        fetched
                    });
                    for revision in failed.into_inner().unwrap() {
                        let delay = failures.get(&revision).map_or(Duration::from_secs(5), |(_, delay)| (*delay * 2).min(Duration::from_secs(300)));
                        failures.insert(revision, (Instant::now() + delay, delay));
                    }
                }
            }
            drop(lifetime);
            std::thread::sleep(Duration::from_millis(250));
        }
    })?;
    Ok(())
}

fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// Codex's `-c` overrides for a saved key: a provider entry of its own that
/// reads [`KEY_ENV`], at OpenAI or the custom provider's address. They are
/// user-level settings, which a checkout's `.codex/config.toml` cannot set.
fn codex_args(base_url: &str) -> String {
    let mut table = toml::Table::new();
    table.insert("name".into(), toml::Value::String("OpenAI API key (TerminalX)".into()));
    table.insert("base_url".into(), toml::Value::String(base_url.into()));
    table.insert("env_key".into(), toml::Value::String(KEY_ENV.into()));
    table.insert("wire_api".into(), toml::Value::String("responses".into()));
    let inline = toml::Value::Table(table).to_string();
    format!(
        " -c {} -c {}",
        shell_quote(&format!("model_providers.{CODEX_PROVIDER}={}", inline.trim())),
        shell_quote(&format!("model_provider=\"{CODEX_PROVIDER}\""))
    )
}

/// What a new tab of `agent` takes from `entry`, given its key when it uses one.
fn grant_for(agent: Agent, entry: &Entry, key: Option<Zeroizing<String>>) -> crate::cloud_grants::LaunchGrant {
    use crate::cloud_grants::{LaunchGrant, RouteLaunch};
    let unset = |names: &[&str]| names.iter().map(|name| (name.to_string(), None)).collect::<Vec<_>>();
    match (entry.mode, key) {
        (Mode::ApiKey, Some(key)) => {
            let mut env = vec![(KEY_ENV.to_string(), Some(key.to_string()))];
            env.extend(unset(agent.shadowing()));
            let route = match agent {
                Agent::Claude => RouteLaunch {
                    api_key_helper: Some(format!("/usr/bin/printenv {KEY_ENV}")),
                    claude_settings_env: crate::cloud_grants::claude_endpoint_pin(agent.default_base_url()),
                    ..Default::default()
                },
                Agent::Codex => RouteLaunch { codex_args: codex_args(&base_url_of(agent, entry)), ..Default::default() },
            };
            LaunchGrant::local(env, Some(route))
        }
        (Mode::Subscription, _) => LaunchGrant::local(unset(agent.subscription_shadowing()), None),
        _ => LaunchGrant::default(),
    }
}

fn launch_from(store: &Store<'_>, keys: &Keys, agent: Agent, wait: Duration) -> Result<crate::cloud_grants::LaunchGrant> {
    let entry = match store.entry(agent) {
        Ok(entry) => entry,
        Err(error) => {
            log::warn!("{} starts with its own login: {error}", agent.label());
            Entry::default()
        }
    };
    if entry.mode != Mode::ApiKey {
        return Ok(grant_for(agent, &entry, None));
    }
    let revision = entry.key.as_ref().map(|saved| saved.revision.clone()).unwrap_or_default();
    let key = keys.get(agent, &revision, wait).with_context(|| format!(
        "{} is set to use an API key, but TerminalX could not read it from the Keychain. Open TerminalX on this Mac (and unlock the Keychain if it asks), then start the tab again, or choose the subscription login in Settings → Agents.",
        agent.label()
    ))?;
    Ok(grant_for(agent, &entry, Some(key)))
}

/// Everything a new CLI session of `harness` in `cwd` takes for its login:
/// a cloud workspace's grant there, this Mac's agent login settings here.
/// A tab set to use a key that this runtime does not have is refused rather
/// than started on another login.
pub fn launch_grant(harness: &str, cwd: &Path) -> Result<crate::cloud_grants::LaunchGrant> {
    if crate::cloud_grants::installed().is_some() {
        return Ok(crate::cloud_grants::launch_grant(harness, cwd));
    }
    let Some(agent) = Agent::of(harness) else { return Ok(Default::default()) };
    launch_from(&store()?, keys(), agent, LAUNCH_WAIT)
}

/// What a running agent was launched with.
struct Launched {
    agent: Agent,
    session_id: String,
    tab_id: String,
    stamp: String,
}

fn launches() -> &'static Mutex<HashMap<String, Launched>> {
    static LAUNCHES: OnceLock<Mutex<HashMap<String, Launched>>> = OnceLock::new();
    LAUNCHES.get_or_init(Default::default)
}

fn current_stamp(agent: Agent) -> String {
    store().and_then(|store| store.entry(agent)).unwrap_or_default().stamp()
}

/// The agent of tab `session_id`/`tab_id` started under `launch`, now.
pub fn record_launch(launch: &str, harness: &str, session_id: &str, tab_id: &str) {
    let Some(agent) = Agent::of(harness) else { return };
    launches().lock().unwrap().insert(launch.to_string(), Launched { agent, session_id: session_id.into(), tab_id: tab_id.into(), stamp: current_stamp(agent) });
}

/// The agent under `launch` has ended.
pub fn forget_launch(launch: &str) {
    launches().lock().unwrap().remove(launch);
}

#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunningTab {
    pub session_id: String,
    pub tab_id: String,
    /// It started with the login new tabs get now.
    pub current: bool,
}

/// The tabs whose `harness` agent is running, and whether each started with
/// the login new tabs get now.
pub fn running(harness: &str) -> Vec<RunningTab> {
    let Some(agent) = Agent::of(harness) else { return Vec::new() };
    let now = current_stamp(agent);
    let mut tabs: Vec<RunningTab> = launches().lock().unwrap().values()
        .filter(|launched| launched.agent == agent)
        .map(|launched| RunningTab { session_id: launched.session_id.clone(), tab_id: launched.tab_id.clone(), current: launched.stamp == now })
        .collect();
    tabs.sort_by(|a, b| (&a.session_id, &a.tab_id).cmp(&(&b.session_id, &b.tab_id)));
    tabs.dedup_by(|a, b| a.session_id == b.session_id && a.tab_id == b.tab_id);
    tabs
}

/// Save `key` for `harness` as the desktop does, into `secrets`, and give
/// this process's runtime memory the current keys, as its desktop would.
#[cfg(test)]
pub(crate) fn save_for_test(harness: &str, key: &str, secrets: &crate::keychain::testing::MemorySecrets) {
    let store = Store { root: crate::store::root().unwrap(), secrets };
    store.save_key(Agent::of(harness).unwrap(), key, None).unwrap();
    keys().refresh(&store.index().unwrap(), |agent, revision| store.snapshot(agent, revision));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keychain::testing::{Call, MemorySecrets};

    const KEY: &str = "sk-ant-api03-Zq9vLwPq3bXbmTkF0aB7cD2eF4gH6iJ8kL0mN2oP4qR6sT8uV0wX2yZ4-4f2a";
    const OTHER: &str = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-9Qx1";

    fn store<'a>(root: &Path, secrets: &'a MemorySecrets) -> Store<'a> {
        Store { root: root.to_path_buf(), secrets }
    }

    /// Every byte TerminalX wrote under its home, as text.
    fn everything_written(root: &Path) -> String {
        let mut text = String::new();
        for entry in walk(root) {
            text.push_str(&String::from_utf8_lossy(&std::fs::read(entry).unwrap_or_default()));
        }
        text
    }

    fn walk(root: &Path) -> Vec<PathBuf> {
        let mut found = Vec::new();
        for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() { found.extend(walk(&path)) } else { found.push(path) }
        }
        found
    }

    #[test]
    fn a_saved_key_is_one_keychain_item_and_the_index_holds_no_part_of_it() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = store(dir.path(), &secrets);
        store.save_key(Agent::Claude, KEY, None).unwrap();

        let entry = store.entry(Agent::Claude).unwrap();
        assert_eq!(entry.mode, Mode::ApiKey);
        let revision = entry.key.unwrap().revision;
        assert_eq!(secrets.stored(SERVICE, &format!("claude/{revision}")).as_deref(), Some(KEY.as_bytes()));
        assert_eq!(secrets.calls(), vec![Call::Set(KEY.as_bytes().to_vec())]);

        let written = everything_written(dir.path());
        assert!(written.contains(&revision) && written.contains("api_key"), "{written}");
        // Not the key, nor its tail, nor its body.
        for part in [KEY, &KEY[KEY.len() - 4..], &KEY[13..30]] {
            assert!(!written.contains(part), "the index holds {part:?}: {written}");
        }
        assert_eq!(store.read(Agent::Claude).unwrap().unwrap().1.as_str(), KEY);
    }

    #[test]
    fn a_new_key_replaces_the_old_item_and_remove_deletes_it_and_returns_to_the_subscription() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = store(dir.path(), &secrets);
        store.save_key(Agent::Codex, OTHER, None).unwrap();
        let first = store.entry(Agent::Codex).unwrap().key.unwrap().revision;
        store.save_key(Agent::Codex, "sk-proj-second-key-0000000000000000000000", None).unwrap();
        let second = store.entry(Agent::Codex).unwrap().key.unwrap().revision;
        assert_ne!(first, second);
        assert_eq!(secrets.stored(SERVICE, &format!("codex/{first}")), None, "the old key is deleted");

        store.remove_key(Agent::Codex).unwrap();
        let entry = store.entry(Agent::Codex).unwrap();
        assert_eq!((entry.mode, entry.key), (Mode::Subscription, None));
        assert_eq!(secrets.stored(SERVICE, &format!("codex/{second}")), None, "the key is deleted from the Keychain");
        // The other agent was never touched.
        assert_eq!(store.entry(Agent::Claude).unwrap(), Entry::default());
    }

    #[test]
    fn a_keychain_that_refuses_the_write_changes_nothing_and_the_error_holds_no_key() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        secrets.fail_writes(true);
        let store = store(dir.path(), &secrets);
        let error = store.save_key(Agent::Claude, KEY, None).unwrap_err().to_string();
        assert_eq!(error, "Could not save the key to the Keychain. Nothing changed.");
        assert_eq!(store.entry(Agent::Claude).unwrap(), Entry::default());
        assert!(!dir.path().join(INDEX).exists());
    }

    #[test]
    fn errors_about_a_key_say_what_is_wrong_never_what_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = store(dir.path(), &secrets);
        for bad in [String::new(), format!("{KEY} {KEY}"), format!("{KEY}\n"), "x".repeat(MAX_KEY_BYTES + 1), format!("{KEY}é")] {
            let error = store.save_key(Agent::Claude, &bad, None).unwrap_err().to_string();
            assert!(!error.contains(KEY) && !error.contains("xxxx"), "{error}");
        }
        assert!(secrets.calls().is_empty());
        // A missing or broken item is reported without its content.
        let revision = "r1";
        secrets.set(SERVICE, &account(Agent::Claude, revision), b"not a key\nat all").unwrap();
        std::fs::write(dir.path().join(INDEX), serde_json::to_vec(&json_index(Agent::Claude, revision)).unwrap()).unwrap();
        let error = store.read(Agent::Claude).unwrap_err().to_string();
        assert_eq!(error, "The Keychain item for Claude Code's API key is not a key.");
        // An index someone broke by pasting a key into it is not echoed back.
        std::fs::write(dir.path().join(INDEX), format!("{{\"claude\": {KEY}")).unwrap();
        let error = store.index().unwrap_err().to_string();
        assert!(!error.contains(KEY), "{error}");
    }

    fn json_index(agent: Agent, revision: &str) -> Index {
        let mut index = Index::new();
        index.insert(agent.id().into(), Entry { mode: Mode::ApiKey, key: Some(Saved { revision: revision.into(), saved_at: "2026-11-11T00:00:00Z".into(), from_shell: None }), ..Default::default() });
        index
    }

    #[test]
    fn a_saved_key_is_shown_by_its_kind_and_last_four_only() {
        assert_eq!(masked(KEY), format!("sk-ant-api03-{}4f2a", "•".repeat(24)));
        assert_eq!(masked(OTHER), format!("sk-proj-{}9Qx1", "•".repeat(24)));
        // Too short for four characters to give nothing away: nothing at all.
        assert_eq!(masked("sk-short-key-1"), "•".repeat(24));
        assert_eq!(masked("abcdefghijklmnopqrstuvwxyz"), format!("{}wxyz", "•".repeat(24)));
    }

    #[test]
    fn the_runtime_snapshot_answers_only_for_the_current_revision() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = store(dir.path(), &secrets);
        store.save_key(Agent::Claude, KEY, None).unwrap();
        let revision = store.entry(Agent::Claude).unwrap().key.unwrap().revision;
        assert_eq!(store.snapshot(Agent::Claude, &revision).unwrap().as_str(), KEY);
        assert!(store.snapshot(Agent::Claude, "an-older-revision").is_err());
        assert!(store.snapshot(Agent::Codex, &revision).is_err(), "another agent's revision is not this one's");
        store.remove_key(Agent::Claude).unwrap();
        assert!(store.snapshot(Agent::Claude, &revision).is_err());
    }

    fn entry_with_key(mode: Mode, base_url: Option<&str>) -> Entry {
        Entry { mode, key: Some(Saved { revision: "r1".into(), saved_at: String::new(), from_shell: None }), base_url: base_url.map(str::to_string), shell_offer: None }
    }

    fn env_of(grant: &crate::cloud_grants::LaunchGrant) -> (Vec<(String, String)>, Vec<String>) {
        let set = grant.env.iter().filter_map(|(name, value)| value.clone().map(|value| (name.clone(), value))).collect();
        let unset = grant.env.iter().filter(|(_, value)| value.is_none()).map(|(name, _)| name.clone()).collect();
        (set, unset)
    }

    #[test]
    fn claude_gets_the_key_through_its_helper_and_nothing_can_outrank_or_redirect_it() {
        let grant = grant_for(Agent::Claude, &entry_with_key(Mode::ApiKey, None), Some(Zeroizing::new(KEY.into())));
        let (set, unset) = env_of(&grant);
        assert_eq!(set, vec![(KEY_ENV.to_string(), KEY.to_string())]);
        for name in ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK"] {
            assert!(unset.contains(&name.to_string()), "{name} is not unset: {unset:?}");
        }
        let route = grant.route.unwrap();
        assert_eq!(route.api_key_helper.as_deref(), Some("/usr/bin/printenv TERMINALX_AGENT_API_KEY"));
        assert!(route.claude_settings_env.contains(&("ANTHROPIC_BASE_URL".into(), "https://api.anthropic.com".into())));
        // What travels on the command line names the variable, never the key.
        let settings = serde_json::json!({ "apiKeyHelper": route.api_key_helper, "env": route.claude_settings_env });
        assert!(!settings.to_string().contains(KEY));
        assert!(route.codex_args.is_empty() && route.model.is_none());
    }

    #[test]
    fn codex_gets_a_provider_that_reads_the_key_at_openai_or_the_custom_address() {
        let grant = grant_for(Agent::Codex, &entry_with_key(Mode::ApiKey, None), Some(Zeroizing::new(OTHER.into())));
        assert_eq!(env_of(&grant), (vec![(KEY_ENV.to_string(), OTHER.to_string())], Vec::new()));
        let args = grant.route.unwrap().codex_args;
        assert!(args.contains(r#"base_url = "https://api.openai.com/v1""#), "{args}");
        assert!(args.contains(r#"env_key = "TERMINALX_AGENT_API_KEY""#), "{args}");
        assert!(args.ends_with(r#" -c 'model_provider="terminalx-api-key"'"#), "{args}");
        assert!(!args.contains(OTHER));

        let custom = grant_for(Agent::Codex, &entry_with_key(Mode::ApiKey, Some("https://llm.example.com/v1")), Some(Zeroizing::new(OTHER.into())));
        assert!(custom.route.unwrap().codex_args.contains(r#"base_url = "https://llm.example.com/v1""#));
    }

    #[test]
    fn a_subscription_login_keeps_a_profile_key_away_and_no_choice_changes_nothing() {
        let (set, unset) = env_of(&grant_for(Agent::Claude, &Entry { mode: Mode::Subscription, ..Default::default() }, None));
        assert!(set.is_empty());
        assert_eq!(unset, ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
        // A key that is saved but not chosen is not handed out.
        let grant = grant_for(Agent::Claude, &entry_with_key(Mode::Subscription, None), Some(Zeroizing::new(KEY.into())));
        assert!(env_of(&grant).0.is_empty() && grant.route.is_none());
        for agent in Agent::ALL {
            let grant = grant_for(agent, &Entry::default(), None);
            assert!(grant.env.is_empty() && grant.route.is_none());
        }
        assert!(grant_for(Agent::Codex, &Entry { mode: Mode::Subscription, ..Default::default() }, None).env.is_empty());
    }

    #[test]
    fn a_launch_without_the_key_in_memory_is_refused_without_naming_it_and_with_it_gets_it() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = store(dir.path(), &secrets);
        store.save_key(Agent::Codex, OTHER, None).unwrap();
        let revision = store.entry(Agent::Codex).unwrap().key.unwrap().revision;

        let keys = Keys::default();
        let error = launch_from(&store, &keys, Agent::Codex, Duration::from_millis(10)).err().unwrap().to_string();
        assert!(error.starts_with("Codex is set to use an API key, but TerminalX could not read it from the Keychain."), "{error}");
        assert!(!error.contains(OTHER));

        // The runtime's memory, filled from the desktop's answer.
        keys.refresh(&store.index().unwrap(), |agent, wanted| store.snapshot(agent, wanted));
        let grant = launch_from(&store, &keys, Agent::Codex, Duration::from_millis(10)).unwrap();
        assert_eq!(env_of(&grant).0, vec![(KEY_ENV.to_string(), OTHER.to_string())]);

        // A launch waiting on the key gets it as soon as it arrives.
        store.save_key(Agent::Codex, "sk-proj-a-newer-key-000000000000000000000000", None).unwrap();
        let newer = store.entry(Agent::Codex).unwrap().key.unwrap().revision;
        assert_ne!(newer, revision);
        std::thread::scope(|scope| {
            let waiting = scope.spawn(|| launch_from(&store, &keys, Agent::Codex, Duration::from_secs(5)));
            std::thread::sleep(Duration::from_millis(50));
            keys.refresh(&store.index().unwrap(), |agent, wanted| store.snapshot(agent, wanted));
            let grant = waiting.join().unwrap().unwrap();
            assert_eq!(env_of(&grant).0[0].1, "sk-proj-a-newer-key-000000000000000000000000");
        });
        // Removing the key drops it from memory at the next refresh.
        store.remove_key(Agent::Codex).unwrap();
        keys.refresh(&store.index().unwrap(), |_, _| bail!("no key"));
        assert!(keys.get(Agent::Codex, &newer, Duration::ZERO).is_none());
    }

    #[test]
    fn a_key_kept_while_the_subscription_is_chosen_is_not_held_in_memory() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = store(dir.path(), &secrets);
        let keys = Keys::default();
        store.save_key(Agent::Claude, KEY, None).unwrap();
        let revision = store.entry(Agent::Claude).unwrap().key.unwrap().revision;
        keys.refresh(&store.index().unwrap(), |agent, wanted| store.snapshot(agent, wanted));
        assert_eq!(keys.get(Agent::Claude, &revision, Duration::ZERO).as_deref().map(String::as_str), Some(KEY));

        store.set_mode(Agent::Claude, Mode::Subscription).unwrap();
        keys.refresh(&store.index().unwrap(), |agent, wanted| store.snapshot(agent, wanted));
        assert!(keys.get(Agent::Claude, &revision, Duration::ZERO).is_none(), "the runtime let go of it");
        assert_eq!(store.read(Agent::Claude).unwrap().unwrap().1.as_str(), KEY, "the Keychain keeps it");
        let grant = launch_from(&store, &keys, Agent::Claude, Duration::ZERO).unwrap();
        assert!(env_of(&grant).0.is_empty() && grant.route.is_none());

        // Chosen again: fetched again, and new tabs get it.
        store.set_mode(Agent::Claude, Mode::ApiKey).unwrap();
        keys.refresh(&store.index().unwrap(), |agent, wanted| store.snapshot(agent, wanted));
        assert_eq!(env_of(&launch_from(&store, &keys, Agent::Claude, Duration::ZERO).unwrap()).0, vec![(KEY_ENV.to_string(), KEY.to_string())]);
    }

    #[test]
    fn launches_say_which_running_tabs_keep_an_older_login() {
        let _home = crate::store::temp_home();
        let launches_before = running("claude").len();
        record_launch("s1/t1", "claude", "s1", "t1");
        record_launch("pane-2", "claude", "s2", "t2");
        record_launch("s3/t3", "codex", "s3", "t3");
        record_launch("s4/t4", "cursor", "s4", "t4");
        assert_eq!(running("claude").iter().filter(|tab| !tab.current).count(), 0);

        let secrets = MemorySecrets::default();
        let store = Store { root: crate::store::root().unwrap(), secrets: &secrets };
        store.save_key(Agent::Claude, KEY, None).unwrap();
        let tabs = running("claude");
        assert_eq!(tabs.len(), launches_before + 2);
        assert!(tabs.iter().all(|tab| !tab.current), "both started before the key: {tabs:?}");
        assert!(running("codex").iter().all(|tab| tab.current), "another agent's tabs are unaffected");

        // Restarted: launched again under the new login.
        record_launch("s1/t1", "claude", "s1", "t1");
        let stale: Vec<_> = running("claude").into_iter().filter(|tab| !tab.current).map(|tab| tab.tab_id).collect();
        assert_eq!(stale, ["t2"]);
        forget_launch("pane-2");
        assert!(running("claude").iter().all(|tab| tab.current));
        for launch in ["s1/t1", "s3/t3", "s4/t4"] {
            forget_launch(launch);
        }
    }

    #[cfg(unix)]
    fn fake_shell(dir: &Path, name: &str, profile: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let shell = bin.join(name);
        // Called as `<shell> -l -i -c <script>`: run the profile, then the script.
        std::fs::write(&shell, format!("#!/bin/sh\n[ \"$1 $2 $3\" = \"-l -i -c\" ] || exit 9\necho 'a profile that talks'\n{profile}\nexec /bin/sh -c \"$4\"\n")).unwrap();
        std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
        shell
    }

    #[cfg(unix)]
    #[test]
    fn the_login_shell_key_is_read_from_an_interactive_login_shell_with_the_file_that_sets_it() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::write(home.join(".zprofile"), "export PATH=/opt/bin:$PATH\n# export OPENAI_API_KEY=commented-out\n").unwrap();
        std::fs::write(home.join(".zshrc"), format!("alias ll='ls -l'\nexport OPENAI_API_KEY=\"{OTHER}\"\n")).unwrap();
        let shell = fake_shell(dir.path(), "zsh", &format!("OPENAI_API_KEY='{OTHER}'; export OPENAI_API_KEY"));

        let found = shell_key_in(&shell, &home, None, Agent::Codex).unwrap();
        assert_eq!(found.key.as_str(), OTHER);
        assert_eq!(display_path(&found.file.unwrap(), &home), "~/.zshrc");
        // The shell does not have the other agent's key.
        assert!(shell_key_in(&shell, &home, None, Agent::Claude).is_none());

        // Exported from somewhere no startup file names (a secrets manager): found, with no file.
        let elsewhere = fake_shell(&dir.path().join("2"), "zsh", &format!("ANTHROPIC_API_KEY='{KEY}'; export ANTHROPIC_API_KEY"));
        let found = shell_key_in(&elsewhere, &home, None, Agent::Claude).unwrap();
        assert_eq!((found.key.as_str(), found.file), (KEY, None));

        // A shell this does not know how to start interactively is not run.
        let unknown = fake_shell(&dir.path().join("3"), "nu", &format!("OPENAI_API_KEY='{OTHER}'; export OPENAI_API_KEY"));
        assert!(shell_key_in(&unknown, &home, None, Agent::Codex).is_none());
        // A value that is not a key is not one.
        let junk = fake_shell(&dir.path().join("4"), "bash", "OPENAI_API_KEY='two words'; export OPENAI_API_KEY");
        assert!(shell_key_in(&junk, &home, None, Agent::Codex).is_none());
    }

    #[test]
    fn startup_file_lines_that_set_a_variable_are_told_from_those_that_do_not() {
        for line in ["export OPENAI_API_KEY=sk", "OPENAI_API_KEY=sk", "  export   OPENAI_API_KEY=\"sk\"", "set -gx OPENAI_API_KEY sk", "set --export OPENAI_API_KEY sk", "setenv OPENAI_API_KEY sk"] {
            assert!(sets(line, "OPENAI_API_KEY"), "{line}");
        }
        for line in ["# export OPENAI_API_KEY=sk", "export OPENAI_API_KEY_OLD=sk", "echo $OPENAI_API_KEY", "set -g OPENAI_API_KEY sk", "MY_OPENAI_API_KEY=sk", "exported OPENAI_API_KEY=sk"] {
            assert!(!sets(line, "OPENAI_API_KEY"), "{line}");
        }
        let home = Path::new("/Users/ada");
        assert_eq!(startup_files(Path::new("/bin/zsh"), home, Some(Path::new("/Users/ada/.config/zsh")))[2], Path::new("/Users/ada/.config/zsh/.zshrc"));
        assert_eq!(startup_files(Path::new("/opt/homebrew/bin/fish"), home, None), vec![home.join(".config/fish/config.fish")]);
    }

    #[cfg(unix)]
    #[test]
    fn an_imported_key_names_its_file_and_is_offered_once() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = store(dir.path(), &secrets);
        let home = Path::new("/Users/ada");
        let found = || Some(ShellKey { key: Zeroizing::new(OTHER.into()), file: Some(home.join(".zshrc")) });
        assert!(offerable(&store.entry(Agent::Codex).unwrap()));
        import_from(&store, Agent::Codex, found(), home).unwrap();
        let entry = store.entry(Agent::Codex).unwrap();
        assert_eq!(entry.key.as_ref().unwrap().from_shell, Some(ShellSource { file: Some("~/.zshrc".into()) }));
        assert_eq!(entry.mode, Mode::ApiKey);
        assert!(!offerable(&entry));
        // Removed afterwards: the shell's key is not offered again.
        store.remove_key(Agent::Codex).unwrap();
        assert!(!offerable(&store.entry(Agent::Codex).unwrap()));
        assert!(import_from(&store, Agent::Codex, found(), home).is_err());
        // Declined: never offered either.
        store.dismiss_offer(Agent::Claude).unwrap();
        assert!(!offerable(&store.entry(Agent::Claude).unwrap()));
        assert!(!everything_written(dir.path()).contains(OTHER));
    }

    #[test]
    fn a_custom_provider_takes_only_an_address_a_key_may_safely_go_to() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = store(dir.path(), &secrets);
        store.set_base_url(Agent::Codex, Some("https://llm.example.com/v1/")).unwrap();
        assert_eq!(store.entry(Agent::Codex).unwrap().base_url.as_deref(), Some("https://llm.example.com/v1"));
        store.set_base_url(Agent::Codex, Some("http://localhost:11434/v1")).unwrap();
        for bad in ["http://llm.example.com/v1", "https://user:pw@llm.example.com", "https://llm.example.com/v1?key=1", "not a url"] {
            assert!(store.set_base_url(Agent::Codex, Some(bad)).is_err(), "{bad}");
        }
        assert!(store.set_base_url(Agent::Claude, Some("https://llm.example.com")).is_err());
        store.set_base_url(Agent::Codex, None).unwrap();
        assert_eq!(store.entry(Agent::Codex).unwrap().base_url, None);
        assert!(store.set_mode(Agent::Codex, Mode::ApiKey).is_err(), "no key to use yet");
    }

    #[test]
    fn a_key_the_provider_refuses_is_not_verified_and_says_why_without_the_key() {
        use crate::agent_route_check::Checked;
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = store(dir.path(), &secrets);
        store.save_key(Agent::Claude, KEY, None).unwrap();
        let sent = Mutex::new(Vec::new());
        let refused = verify_with(&store, Agent::Claude, |probe| {
            sent.lock().unwrap().push((probe.base_url.to_string(), probe.credential.to_string(), probe.list, probe.header));
            Checked { outcome: "failed", code: Some("unauthorized"), http_status: Some(401), models: Vec::new() }
        }).unwrap();
        assert_eq!(sent.into_inner().unwrap(), vec![("https://api.anthropic.com".to_string(), KEY.to_string(), ModelList::Anthropic, CredentialHeader::Both)]);
        assert!(!refused.ok);
        assert_eq!(refused.reason.as_deref(), Some("api.anthropic.com refused this key (HTTP 401). Check it was copied whole, or make a new one"));
        let shown = serde_json::to_string(&status_of(&store, Agent::Claude).unwrap()).unwrap();
        assert!(shown.contains("refused this key") && !shown.contains(KEY) && !shown.contains(&KEY[13..40]), "{shown}");

        let ok = verify_with(&store, Agent::Claude, |_| Checked { outcome: "ok", code: None, http_status: Some(200), models: vec!["claude-x".into()] }).unwrap();
        assert!(ok.ok && ok.reason.is_none());
        // A new key has not been checked yet.
        store.save_key(Agent::Claude, "sk-ant-api03-another-key-000000000000000000000000", None).unwrap();
        assert!(status_of(&store, Agent::Claude).unwrap().verified.is_none());
        for (code, words) in [("unreachable", "could not reach api.anthropic.com"), ("timeout", "did not answer in time"), ("models-unlisted", "without a model list"), ("bad-response", "did not answer like a model API")] {
            let checked = Checked { outcome: if code == "models-unlisted" { "unverified" } else { "failed" }, code: Some(code), http_status: None, models: Vec::new() };
            assert!(reason(&checked, "https://api.anthropic.com").unwrap().contains(words), "{code}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn verification_reaches_the_provider_with_the_key_and_reports_only_its_status() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://localhost:{}/v1", listener.local_addr().unwrap().port());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = vec![0; 8192];
            let read = socket.read(&mut request).unwrap();
            // The refusal repeats the key, as providers' error bodies do.
            let body = format!(r#"{{"error":{{"message":"Incorrect API key provided: {OTHER}"}}}}"#);
            write!(socket, "HTTP/1.1 401 Unauthorized\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).unwrap();
            String::from_utf8_lossy(&request[..read]).into_owned()
        });
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = store(dir.path(), &secrets);
        store.save_key(Agent::Codex, OTHER, None).unwrap();
        store.set_base_url(Agent::Codex, Some(&address)).unwrap();
        crate::test_log::capture();
        let checked = verify_with(&store, Agent::Codex, crate::agent_route_check::probe).unwrap();
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /v1/models "), "{request}");
        assert!(request.to_ascii_lowercase().contains(&format!("authorization: bearer {}", OTHER.to_ascii_lowercase())));
        assert!(!checked.ok);
        let reason = checked.reason.unwrap();
        assert_eq!(reason, "localhost refused this key (HTTP 401). Check it was copied whole, or make a new one");
        assert!(crate::test_log::logged(OTHER).is_empty() && crate::test_log::logged(&OTHER[8..30]).is_empty(), "the key was logged");
    }

    #[test]
    fn status_never_carries_the_key() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = MemorySecrets::default();
        let store = store(dir.path(), &secrets);
        store.save_key(Agent::Claude, KEY, Some(ShellSource { file: Some("~/.zshrc".into()) })).unwrap();
        let status = status_of(&store, Agent::Claude).unwrap();
        let shown = serde_json::to_value(&status).unwrap();
        assert_eq!(shown["mode"], "api_key");
        assert_eq!(shown["variable"], "ANTHROPIC_API_KEY");
        assert_eq!(shown["saved"]["masked"], format!("sk-ant-api03-{}4f2a", "•".repeat(24)));
        assert_eq!(shown["saved"]["fromShell"]["file"], "~/.zshrc");
        assert!(!shown.to_string().contains(&KEY[13..]));
        // A Keychain that lost the item says so, still without a key.
        let revision = store.entry(Agent::Claude).unwrap().key.unwrap().revision;
        secrets.delete(SERVICE, &account(Agent::Claude, &revision)).unwrap();
        let status = status_of(&store, Agent::Claude).unwrap();
        assert_eq!(status.problem.as_deref(), Some("Claude Code's API key is missing from the Keychain. Save it again in Settings → Agents."));
    }

    #[test]
    fn nothing_writes_the_key_to_a_log_a_recovery_record_or_the_home() {
        let _home = crate::store::temp_home();
        let root = crate::store::root().unwrap();
        crate::test_log::capture();
        let secrets = MemorySecrets::default();
        let store = Store { root: root.clone(), secrets: &secrets };
        store.save_key(Agent::Claude, KEY, Some(ShellSource { file: Some("~/.zshrc".into()) })).unwrap();
        store.save_key(Agent::Codex, OTHER, None).unwrap();
        let keys = Keys::default();
        keys.refresh(&store.index().unwrap(), |agent, revision| store.snapshot(agent, revision));
        // A launch, a refused one, a status, a removal: everything a key passes through.
        let _ = launch_from(&store, &keys, Agent::Claude, Duration::from_millis(10)).unwrap();
        let _ = launch_from(&store, &keys, Agent::Codex, Duration::from_millis(10)).unwrap();
        store.save_key(Agent::Codex, "sk-proj-not-in-memory-yet-000000000000000000000", None).unwrap();
        let refused = launch_from(&store, &keys, Agent::Codex, Duration::from_millis(10)).err().unwrap();
        // As a refused launch's error reaches a tab's recovery diagnostics.
        crate::recovery::append_diagnostic(&root.join("diagnostics.jsonl"), &format!("{refused:#}"));
        let _ = status_of(&store, Agent::Claude).unwrap();
        store.remove_key(Agent::Claude).unwrap();

        for secret in [KEY, &KEY[13..40], OTHER, &OTHER[8..30], "sk-proj-not-in-memory-yet"] {
            assert!(crate::test_log::logged(secret).is_empty(), "logged {secret}");
            assert!(!everything_written(&root).contains(secret), "{secret} was written under the home");
        }
    }
}
