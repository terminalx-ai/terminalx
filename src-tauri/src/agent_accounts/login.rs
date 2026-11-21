//! Signing an agent account in and out (#980) with the agent's own CLI.
//!
//! - **Claude Code**: `claude auth login --claudeai` with `CLAUDE_CONFIG_DIR`
//!   the account's directory. The CLI opens the browser itself and takes the
//!   OAuth callback itself; TerminalX never sees a password or a code, and
//!   reads nothing the CLI prints but the sign-in page's address (so Settings
//!   can open it again if the browser did not). The Console sign-in
//!   (`--console`) is never offered: it keeps its key outside the directory.
//! - **Codex**: the device-code login of `codex_device_login`, with
//!   `CODEX_HOME` the account's directory and the file store, so Codex writes
//!   `auth.json` there and it stays there.
//!
//! Each CLI runs under `codex_device_login`'s watchdog in a process group of
//! its own, and is killed with it when the app ends however it ends. One
//! sign-in per agent at a time: a new one replaces the open one (Claude
//! Code's waits on a local callback port).
//!
//! Signing out ([`Cli`]) is the agent's own logout with the account's
//! directory set, then (Claude Code) its Keychain entry for that directory.
//! The person's own directory and Keychain item are never named here.
//!
//! The CLI's output is never logged, and nothing a CLI prints reaches a log.

use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{bail, ensure, Context, Result};
use serde::Serialize;

use super::{claude_dir, complete, discard, make_dir, Finished, Identity, SignOut};
use crate::agent_keys::{Agent, Store};

/// How long a browser sign-in may stay open, as long as a device code lives.
const LOGIN_LIFETIME: Duration = Duration::from_secs(15 * 60 + 30);
/// How long a logout may take.
const LOGOUT_TIMEOUT: Duration = Duration::from_secs(30);
/// Variables that would make Claude Code sign in, or out, somewhere other
/// than the account's directory.
const CLAUDE_UNSET: &[&str] = &["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDECODE"];

/// The CLIs a sign-in runs, as this Mac has them; tests give stand-ins.
#[derive(Clone, Debug, Default)]
pub struct Programs {
    pub claude: Option<PathBuf>,
    pub codex: Option<PathBuf>,
    /// What a debug build adds to Codex's login (a stand-in issuer).
    pub codex_args: Vec<String>,
    pub path_env: String,
}

impl Programs {
    /// The installed CLIs, the same ones a tab runs.
    pub fn installed() -> Self {
        let dev = |name: &str| if cfg!(debug_assertions) { std::env::var(name).ok().filter(|value| !value.is_empty()) } else { None };
        Self {
            claude: crate::binpath::resolve("claude"),
            codex: dev("TERMINALX_DEV_CODEX_BIN").map(PathBuf::from).or_else(|| crate::binpath::resolve("codex")),
            codex_args: dev("TERMINALX_DEV_CODEX_ISSUER").map(|issuer| vec!["--experimental_issuer".to_string(), issuer]).unwrap_or_default(),
            path_env: crate::binpath::login_path(),
        }
    }

    fn program(&self, agent: Agent) -> Result<&Path> {
        let program = match agent {
            Agent::Claude => self.claude.as_deref(),
            Agent::Codex => self.codex.as_deref(),
        };
        program.filter(|program| program.is_file()).with_context(|| format!("{} is not installed on this Mac. Install it in Settings → Agents first.", agent.label()))
    }
}

/// How the person finishes a sign-in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Flow {
    /// The CLI opened the browser; the page finishes it.
    Browser,
    /// A code to enter at the page.
    DeviceCode,
}

/// A sign-in that has begun. The device code is what the person types at
/// OpenAI's page; it is shown in the dialog and nowhere else.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub attempt_id: String,
    pub agent: &'static str,
    pub account_id: String,
    /// Signing an account that is already listed in again.
    pub again: bool,
    pub flow: Flow,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verification_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_code: Option<String>,
    pub expires_in_seconds: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Waiting,
    SignedIn,
    Expired,
    Cancelled,
    Failed,
}

/// `claude auth login` running for one account.
struct ClaudeLogin {
    inner: Arc<Mutex<ClaudeInner>>,
}

struct ClaudeInner {
    phase: Phase,
    child: Option<Child>,
    lifeline: Option<ChildStdin>,
    /// The sign-in page the CLI printed, once it has.
    page: Option<String>,
}

impl ClaudeLogin {
    fn phase(&self) -> Phase {
        self.inner.lock().map(|inner| inner.phase).unwrap_or(Phase::Failed)
    }

    fn page(&self) -> Option<String> {
        self.inner.lock().ok().and_then(|inner| inner.page.clone())
    }

    fn shutdown(&self) {
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(poisoned) => poisoned.into_inner(),
        };
        if inner.phase == Phase::Waiting {
            inner.phase = Phase::Cancelled;
        }
        if let Some(mut child) = inner.child.take() {
            kill_group(&mut child);
        }
        inner.lifeline = None;
    }
}

impl Drop for ClaudeLogin {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(unix)]
fn kill_group(child: &mut Child) {
    if let Ok(group) = i32::try_from(child.id()) {
        unsafe {
            libc::killpg(group, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(unix))]
fn kill_group(child: &mut Child) {
    #[cfg(windows)]
    crate::win::process::kill_tree(child.id());
    let _ = child.kill();
    let _ = child.wait();
}

/// Whether `value` is a Claude sign-in page that may be opened: Anthropic's
/// own over `https`, with no credentials in the address.
pub fn claude_page(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else { return false };
    if value.len() > 4096 || !url.username().is_empty() || url.password().is_some() || url.scheme() != "https" {
        return false;
    }
    let host = url.host_str().unwrap_or("");
    ["claude.ai", "claude.com", "anthropic.com"].iter().any(|domain| host == *domain || host.strip_suffix(domain).is_some_and(|rest| rest.ends_with('.')))
}

/// The first sign-in page in a line of the CLI's output, if it has one.
fn page_in(line: &str) -> Option<String> {
    line.split(|c: char| c.is_whitespace() || c == '\u{1b}').map(|word| word.trim_matches(|c: char| c == '"' || c == '\'' || c == '<' || c == '>')).find(|word| word.starts_with("https://") && claude_page(word)).map(str::to_string)
}

fn claude_command(program: &Path, dir: &Path, path_env: &str, args: &[&str]) -> Command {
    let mut command = Command::new(program);
    command.args(args).env("CLAUDE_CONFIG_DIR", dir).env("PATH", path_env).env("NO_COLOR", "1");
    for name in CLAUDE_UNSET {
        command.env_remove(name);
    }
    command
}

fn start_claude(program: &Path, dir: &Path, path_env: &str) -> Result<ClaudeLogin> {
    use std::io::{BufRead, BufReader};
    #[cfg(unix)]
    let (mut child, lifeline) = {
        let template = claude_command(program, dir, path_env, &[]);
        let mut command = Command::new("/bin/sh");
        command.args(["-c", crate::codex_device_login::WATCHDOG, "claude-login"]).arg(program).args(["auth", "login", "--claudeai"]);
        for (name, value) in template.get_envs() {
            match value {
                Some(value) => command.env(name, value),
                None => command.env_remove(name),
            };
        }
        command.current_dir(dir).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        let mut child = command.spawn().context("Claude Code's sign-in could not start")?;
        let lifeline = child.stdin.take();
        (child, lifeline)
    };
    // No watchdog shell: the CLI runs in a job that ends with this process.
    #[cfg(windows)]
    let (mut child, lifeline) = {
        use std::os::windows::process::CommandExt;
        let mut command = claude_command(program, dir, path_env, &["auth", "login", "--claudeai"]);
        command.current_dir(dir).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
            .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
        let mut child = command.spawn().context("Claude Code's sign-in could not start")?;
        if let Err(error) = crate::win::process::tie_to_this_process(&child) {
            let _ = child.kill();
            return Err(anyhow::Error::new(error).context("Claude Code's sign-in could not start"));
        }
        (child, None::<std::process::ChildStdin>)
    };
    let stdout = child.stdout.take().context("Claude Code's sign-in could not start")?;
    let inner = Arc::new(Mutex::new(ClaudeInner { phase: Phase::Waiting, child: Some(child), lifeline, page: None }));
    let reading = inner.clone();
    std::thread::spawn(move || {
        // Read only for the page's address; nothing else is kept or logged.
        let mut reader = BufReader::new(stdout);
        loop {
            let mut line = zeroize::Zeroizing::new(String::new());
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    if let Some(page) = page_in(&line) {
                        if let Ok(mut inner) = reading.lock() {
                            inner.page.get_or_insert(page);
                        }
                    }
                }
            }
        }
    });
    let watched = inner.clone();
    let started = Instant::now();
    std::thread::spawn(move || loop {
        {
            let Ok(mut inner) = watched.lock() else { return };
            let Some(child) = inner.child.as_mut() else { return };
            if started.elapsed() > LOGIN_LIFETIME {
                kill_group(child);
                inner.child = None;
                inner.lifeline = None;
                if inner.phase == Phase::Waiting {
                    inner.phase = Phase::Expired;
                }
                return;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    inner.child = None;
                    inner.lifeline = None;
                    if inner.phase == Phase::Waiting {
                        inner.phase = if status.success() { Phase::SignedIn } else { Phase::Failed };
                    }
                    return;
                }
                Ok(None) => {}
                Err(_) => {
                    inner.phase = Phase::Failed;
                    return;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    });
    Ok(ClaudeLogin { inner })
}

enum Running {
    Claude(ClaudeLogin),
    Codex(crate::codex_device_login::DeviceLogin),
}

impl Running {
    fn phase(&self) -> Phase {
        use crate::codex_device_login::Phase as Device;
        match self {
            Self::Claude(login) => login.phase(),
            Self::Codex(login) => match login.phase() {
                Device::Waiting => Phase::Waiting,
                Device::SignedIn => Phase::SignedIn,
                Device::Expired => Phase::Expired,
                Device::Cancelled => Phase::Cancelled,
                Device::Failed => Phase::Failed,
            },
        }
    }

    fn shutdown(&self) {
        match self {
            Self::Claude(login) => login.shutdown(),
            Self::Codex(login) => login.shutdown(),
        }
    }
}

struct Attempt {
    id: String,
    /// The `$TERMINALX_HOME` it signs in under.
    root: PathBuf,
    agent: Agent,
    account_id: String,
    again: bool,
    /// The device code's page (Codex), or the page the CLI printed (Claude).
    page: Option<String>,
    running: Running,
}

/// The open sign-ins, at most one per agent.
static ATTEMPTS: Mutex<Vec<Attempt>> = Mutex::new(Vec::new());

fn attempts() -> std::sync::MutexGuard<'static, Vec<Attempt>> {
    ATTEMPTS.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Start the agent's own sign-in: into a new account's directory (`again`
/// `None`), or into listed account `again`'s. A sign-in of the same agent
/// that is still open is canceled first.
pub(crate) fn start_in(store: &Store<'_>, agent: Agent, again: Option<&str>, programs: &Programs, person: Option<&claude_dir::Person>, sign_out: &dyn SignOut) -> Result<Started> {
    let program = programs.program(agent)?.to_path_buf();
    if agent == Agent::Codex {
        ensure!(crate::codex_device_login::trusted_program(&program), "The codex on this Mac could be replaced by another account, so TerminalX does not run it.");
    }
    // One at a time per agent: a new start abandons the open one.
    let open: Vec<Attempt> = {
        let mut all = attempts();
        let (theirs, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut *all).into_iter().partition(|attempt| attempt.agent == agent && attempt.root == store.root);
        *all = rest;
        theirs
    };
    for attempt in open {
        abandon(store, attempt, sign_out);
    }

    let (account_id, dir) = match again {
        Some(id) => {
            let entry = store.entry(agent)?;
            ensure!(matches!(super::login_of(&entry, id), super::Login::Subscription { .. }), "Only an added subscription account signs in again here.");
            // Made again if it was deleted outside the app.
            (id.to_string(), make_dir(store, agent, id, person)?)
        }
        None => {
            let id = super::new_id();
            (id.clone(), make_dir(store, agent, &id, person)?)
        }
    };
    let undo = |error: anyhow::Error| {
        if again.is_none() {
            discard(store, agent, &account_id, sign_out);
        }
        error
    };
    let attempt_id = format!("account-login-{}", uuid::Uuid::new_v4());
    let (running, flow, page, user_code, expires) = match agent {
        Agent::Claude => {
            let login = start_claude(&program, &dir, &programs.path_env).map_err(undo)?;
            // The page is printed as the browser opens; wait a moment for it.
            let deadline = Instant::now() + Duration::from_secs(3);
            while login.page().is_none() && login.phase() == Phase::Waiting && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
            let page = login.page();
            (Running::Claude(login), Flow::Browser, page, None, LOGIN_LIFETIME.as_secs())
        }
        Agent::Codex => {
            let path = crate::codex_device_login::trusted_path(&programs.path_env);
            if !crate::codex_device_login::runs_trusted(&program, &path) {
                return Err(undo(anyhow::anyhow!("The codex on this Mac could be replaced by another account, so TerminalX does not run it.")));
            }
            let (login, code) = crate::codex_device_login::start_into(&program, &programs.codex_args, &path, &crate::codex_device_login::homes_parent(), &dir)
                .map_err(|error| undo(anyhow::anyhow!(match error {
                    crate::codex_device_login::DeviceLoginError::CliMissing => "Codex is not installed on this Mac. Install it in Settings → Agents first.",
                    crate::codex_device_login::DeviceLoginError::CliUntrusted => "The codex on this Mac could be replaced by another account, so TerminalX does not run it.",
                    crate::codex_device_login::DeviceLoginError::Unavailable => "Codex could not begin a sign-in. Check the connection and try again.",
                })))?;
            let page = code.verification_url.clone();
            (Running::Codex(login), Flow::DeviceCode, Some(page), Some(code.user_code.to_string()), crate::codex_device_login::CODE_LIFETIME.as_secs())
        }
    };
    let started = Started {
        attempt_id: attempt_id.clone(),
        agent: agent.id(),
        account_id: account_id.clone(),
        again: again.is_some(),
        flow,
        verification_url: page.clone(),
        user_code,
        expires_in_seconds: expires,
    };
    attempts().push(Attempt { id: attempt_id, root: store.root.clone(), agent, account_id, again: again.is_some(), page, running });
    Ok(started)
}

/// Stop an open sign-in and, for a new account, take back its directory.
fn abandon(store: &Store<'_>, attempt: Attempt, sign_out: &dyn SignOut) {
    attempt.running.shutdown();
    if !attempt.again {
        discard(store, attempt.agent, &attempt.account_id, sign_out);
    }
}

/// Where sign-in `attempt_id` is; once the agent's login has ended, what it
/// became (see [`complete`]). `local` is who This Mac's own login is.
pub(crate) fn finish_in(store: &Store<'_>, attempt_id: &str, local: impl FnOnce(Agent) -> Identity, sign_out: &dyn SignOut) -> Result<Finished> {
    let attempt = {
        let mut all = attempts();
        let at = all.iter().position(|attempt| attempt.id == attempt_id && attempt.root == store.root).context("That sign-in is no longer open.")?;
        if all[at].running.phase() == Phase::Waiting {
            return Ok(Finished::Waiting);
        }
        all.remove(at)
    };
    let phase = attempt.running.phase();
    let finished = match phase {
        Phase::SignedIn => complete(store, attempt.agent, &attempt.account_id, attempt.again, &local(attempt.agent), sign_out),
        Phase::Expired => Ok(Finished::Expired),
        Phase::Cancelled => Ok(Finished::Cancelled),
        Phase::Failed | Phase::Waiting => Ok(Finished::Failed { message: format!("{} did not finish signing in. Try again.", attempt.agent.label()) }),
    };
    if phase != Phase::SignedIn && !attempt.again {
        discard(store, attempt.agent, &attempt.account_id, sign_out);
    }
    finished
}

/// Cancel sign-in `attempt_id`: its CLI is stopped, and a new account's
/// directory taken back.
pub(crate) fn cancel_in(store: &Store<'_>, attempt_id: &str, sign_out: &dyn SignOut) -> Result<()> {
    let attempt = {
        let mut all = attempts();
        let Some(at) = all.iter().position(|attempt| attempt.id == attempt_id && attempt.root == store.root) else { return Ok(()) };
        all.remove(at)
    };
    abandon(store, attempt, sign_out);
    Ok(())
}

/// The page of open sign-in `attempt_id`, checked again here.
pub(crate) fn page_of(attempt_id: &str) -> Result<String> {
    let page = attempts().iter().find(|attempt| attempt.id == attempt_id).and_then(|attempt| match &attempt.running {
        Running::Claude(login) => login.page().or_else(|| attempt.page.clone()),
        Running::Codex(_) => attempt.page.clone(),
    });
    let page = page.context("This sign-in has no page to open; the browser opened it already.")?;
    ensure!(claude_page(&page) || crate::codex_device_login::verification_page(&page), "That is not a sign-in page.");
    Ok(page)
}

/// Accounts whose sign-in is open now, so a sweep leaves their directories.
pub(crate) fn in_use() -> Vec<String> {
    attempts().iter().map(|attempt| attempt.account_id.clone()).collect()
}

/// The app is quitting: every open sign-in's CLI is killed before this
/// returns. Their directories are swept at the next start.
pub fn shutdown_all() {
    let open = std::mem::take(&mut *attempts());
    for attempt in open {
        attempt.running.shutdown();
    }
}

// ------------------------------------------------------------- signing out

/// The agents' own logout, on this Mac.
pub struct Cli {
    pub programs: Programs,
}

impl SignOut for Cli {
    fn logout(&self, agent: Agent, dir: &Path) -> Result<()> {
        let program = self.programs.program(agent)?;
        let mut command = match agent {
            Agent::Claude => claude_command(program, dir, &self.programs.path_env, &["auth", "logout"]),
            Agent::Codex => {
                let mut command = Command::new(program);
                command.args(["logout", "-c", "cli_auth_credentials_store=\"file\""]).env_clear().env("PATH", crate::codex_device_login::trusted_path(&self.programs.path_env)).env("CODEX_HOME", dir);
                if let Some(home) = dirs::home_dir() {
                    command.env("HOME", home);
                }
                command
            }
        };
        command.current_dir(dir).stdin(Stdio::null());
        let ended = crate::git::capture_within(command, LOGOUT_TIMEOUT).map(|output| output.status.success()).unwrap_or(false);
        // Signed out already counts: what matters is that no login is left.
        let left = match agent {
            Agent::Claude => crate::agent_local_login::identity_in("claude", dir).signed_in(),
            Agent::Codex => crate::codex_device_login::signed_in_at(dir),
        };
        if ended || !left {
            return Ok(());
        }
        bail!("{} did not sign out", agent.label())
    }

    fn forget_item(&self, service: &str) -> Result<()> {
        forget_claude_item(service)
    }
}

/// Delete Claude Code's Keychain item `service` for this user. Only an
/// account directory's own item: never the person's `Claude Code-credentials`.
#[cfg(target_os = "macos")]
fn forget_claude_item(service: &str) -> Result<()> {
    let suffix = service.strip_prefix("Claude Code-credentials-").unwrap_or("");
    ensure!(suffix.len() == 8 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit()), "not an account's Keychain item");
    let account = std::env::var("USER").context("no user name")?;
    let mut command = Command::new("/usr/bin/security");
    command.args(["delete-generic-password", "-s", service, "-a", &account]).stdin(Stdio::null());
    let output = crate::git::capture_within(command, Duration::from_secs(20)).context("the Keychain did not answer")?;
    // 44: there is no such item, which is what was wanted.
    ensure!(output.status.success() || output.status.code() == Some(44), "the account's Keychain item could not be deleted");
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn forget_claude_item(_service: &str) -> Result<()> {
    Ok(())
}
