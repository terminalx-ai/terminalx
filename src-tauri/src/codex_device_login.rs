//! "Log in with ChatGPT" for Codex (PRO-79): Codex's own device-code login,
//! run on this Mac in a throwaway home, so an owner or admin can connect a
//! ChatGPT subscription to their organization's cloud workspaces.
//!
//! The flow is the CLI's, unchanged (`codex login --device-auth`, codex-cli
//! 0.153.4, `codex-rs/login/src/device_code_auth.rs`):
//!
//! 1. The CLI asks OpenAI for a one-time code and prints, on stdout,
//!    "1. Open this link in your browser and sign in to your account", the
//!    page (`https://auth.openai.com/codex/device`) on the next line, then
//!    "2. Enter this one-time code (expires in 15 minutes)" and the code on
//!    the next line, each value wrapped in ANSI colours.
//! 2. The person opens the page, signs in and enters the code; the CLI
//!    polls until then (at most 15 minutes: "device auth timed out after 15
//!    minutes"), exchanges what it gets for tokens and writes them to
//!    `$CODEX_HOME/auth.json` (`-c cli_auth_credentials_store="file"` keeps
//!    them out of the Keychain), prints "Successfully logged in" on stderr
//!    and exits 0. Any failure is "Error logging in with device code: …" and
//!    exit 1.
//!
//! Rules this module keeps:
//!
//! - **The person's own Codex login is never touched.** `HOME` and
//!   `CODEX_HOME` point into a new private (0700) directory, and the CLI
//!   gets no other environment than `PATH`, proxy and certificate settings,
//!   so neither `~/.codex` nor an `OPENAI_API_KEY` reaches it. The directory
//!   is wiped (the auth file overwritten first, never through a link) as
//!   soon as the CLI ends, and at once when the attempt is canceled, dropped
//!   or the app quits ([`DeviceLogin::shutdown`]).
//! - **The CLI never outlives the app.** It runs under a small `sh`
//!   watchdog in its own process group: the watchdog holds the read end of
//!   a pipe whose write end only this process has, and kills the whole
//!   group when that pipe closes, which the kernel does however the app
//!   ends (quit, crash, force quit). A home left by an app that died is
//!   removed at the next start ([`sweep_stale`]): each home names the
//!   process that made it.
//! - **The code stays on this Mac.** It goes from the CLI's output to the
//!   one dialog that shows it, and nowhere else: not to the account
//!   service, not to a log. The CLI's output and errors are never logged.
//! - What the CLI wrote is held in memory (`Zeroizing`) only until it is
//!   uploaded, and is never handed to the webview.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use zeroize::Zeroizing;

/// How long the CLI has to print its code.
const CODE_TIMEOUT: Duration = Duration::from_secs(30);
/// The code's own life, as the CLI says, and a little more for its last poll.
pub const CODE_LIFETIME: Duration = Duration::from_secs(15 * 60);
const GRACE: Duration = Duration::from_secs(30);
/// Throwaway homes start with this, so one left by a crash can be found.
const HOME_PREFIX: &str = "terminalx-codex-login-";
const MAX_AUTH_BYTES: u64 = 64 * 1024;
/// OpenAI's device page, as codex-cli documents it; used only when the CLI printed no page.
const DOCUMENTED_PAGE: &str = "https://auth.openai.com/codex/device";
/// What the CLI is given besides its throwaway home: where programs are, and how to reach the network.
const PASSED_ENV: &[&str] = &["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "LANG", "USER", "LOGNAME"];
/// Runs the CLI (`"$@"`) and kills its whole process group once stdin, the
/// app's end of the lifeline, closes: when the app lets go of it, or dies.
/// The CLI's own stdin is /dev/null; its exit status is the watchdog's.
const WATCHDOG: &str = r#"exec 3<&0
"$@" </dev/null 3<&- &
cli=$!
( cat <&3; kill -KILL 0 ) </dev/null >/dev/null 2>&1 &
watch=$!
wait "$cli"
status=$?
kill "$watch" 2>/dev/null
exit "$status""#;
/// Names the app process that made a home, so a later start can tell a home whose app is gone.
const OWNER_FILE: &str = "owner";
const CONFIG: &str = "check_for_update_on_startup = false\ncli_auth_credentials_store = \"file\"\n";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceLoginError {
    /// No `codex` on this Mac.
    CliMissing,
    /// The `codex` found could be replaced by another user: not run.
    CliUntrusted,
    /// The CLI could not begin a login (offline, the service refused, an unexpected answer).
    Unavailable,
}

impl DeviceLoginError {
    pub fn code(self) -> &'static str {
        match self {
            Self::CliMissing => "cloud_agent_codex_cli_missing",
            Self::CliUntrusted => "cloud_agent_codex_cli_untrusted",
            Self::Unavailable => "cloud_agent_codex_login_unavailable",
        }
    }
}

/// Where an attempt is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    /// The code is shown; the person has not finished at OpenAI yet.
    Waiting,
    /// The CLI finished and its login is held, ready to upload.
    SignedIn,
    /// The code ran out before the person finished.
    Expired,
    Cancelled,
    /// The CLI ended without a login it could use.
    Failed,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Waiting => "waiting",
            Self::SignedIn => "signed-in",
            Self::Expired => "expired",
            Self::Cancelled => "cancelled",
            Self::Failed => "failed",
        }
    }
}

/// What the person enters at OpenAI, and where.
pub struct DeviceCode {
    pub verification_url: String,
    pub user_code: Zeroizing<String>,
}

/// The login the CLI wrote, reduced to what Codex reads, and whose it is.
pub struct SignIn {
    pub secret: Zeroizing<String>,
    pub account: Option<String>,
}

struct Inner {
    phase: Phase,
    sign_in: Option<SignIn>,
    cancel: bool,
    /// The CLI's watchdog, until it has been reaped.
    child: Option<Child>,
    /// The app's end of the watchdog's lifeline.
    lifeline: Option<ChildStdin>,
    /// The throwaway home, until it is wiped.
    home: Option<tempfile::TempDir>,
}

impl Inner {
    fn new(phase: Phase, sign_in: Option<SignIn>) -> Self {
        Self { phase, sign_in, cancel: false, child: None, lifeline: None, home: None }
    }
}

/// One running login. Dropping it cancels it and wipes its home.
pub struct DeviceLogin {
    inner: Arc<Mutex<Inner>>,
}

impl DeviceLogin {
    pub fn phase(&self) -> Phase {
        self.inner.lock().map(|inner| inner.phase).unwrap_or(Phase::Failed)
    }

    /// A copy of the login to upload, while one is held.
    pub fn sign_in(&self) -> Option<SignIn> {
        let inner = self.inner.lock().ok()?;
        inner.sign_in.as_ref().map(|held| SignIn { secret: held.secret.clone(), account: held.account.clone() })
    }

    /// Stop the CLI if it still runs, now: its whole process group is
    /// killed and reaped, and its home wiped, before this returns. A login
    /// it already wrote is dropped. For a cancel, a new start, and the app
    /// quitting.
    pub fn shutdown(&self) {
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(poisoned) => poisoned.into_inner(),
        };
        inner.cancel = true;
        inner.sign_in = None;
        if matches!(inner.phase, Phase::Waiting | Phase::SignedIn) {
            inner.phase = Phase::Cancelled;
        }
        if let Some(mut child) = inner.child.take() {
            kill_group(&mut child);
        }
        inner.lifeline = None;
        if let Some(home) = inner.home.take() {
            wipe(home);
        }
    }
}

#[cfg(test)]
impl DeviceLogin {
    /// A login whose CLI has already finished, as the waiter leaves it.
    pub(crate) fn finished_for_test(phase: Phase, sign_in: Option<SignIn>) -> Self {
        Self { inner: Arc::new(Mutex::new(Inner::new(phase, sign_in))) }
    }

    /// Let go of the lifeline without killing anything, as the app dying would.
    pub(crate) fn drop_lifeline_for_test(&self) {
        self.inner.lock().unwrap().lifeline = None;
    }
}

impl Drop for DeviceLogin {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Whether `value` is a page that may be opened for the code: OpenAI's own
/// over `https`, with no credentials in the address. A debug build also
/// accepts a loopback address, for a local stand-in issuer.
pub fn verification_page(value: &str) -> bool {
    let Ok(url) = url::Url::parse(value) else { return false };
    if value.len() > 2048 || !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let host = url.host_str().unwrap_or("");
    if cfg!(debug_assertions) && url.scheme() == "http" && matches!(host, "127.0.0.1" | "localhost") {
        return true;
    }
    url.scheme() == "https" && ["openai.com", "chatgpt.com"].iter().any(|domain| host == *domain || host.strip_suffix(domain).is_some_and(|rest| rest.ends_with('.')))
}

/// A one-time code as the CLI prints them ("ABCD-12345"): letters, digits and dashes.
fn plausible_code(value: &str) -> bool {
    (4..=32).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') && value.bytes().any(|byte| byte.is_ascii_alphanumeric())
}

/// A line of the CLI's output without its colours.
fn plain(line: &str) -> Zeroizing<String> {
    let mut out = Zeroizing::new(String::with_capacity(line.len()));
    let mut chars = line.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // CSI: ESC [ parameters final-byte.
            if chars.next() == Some('[') {
                for next in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&next) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// Reads the page and the code out of the CLI's prompt, a line at a time.
#[derive(Default)]
struct PromptReader {
    want: Option<&'static str>,
    url: Option<String>,
    code: Option<Zeroizing<String>>,
}

impl PromptReader {
    /// Feed one line; the page and the code once both have been read.
    fn feed(&mut self, raw: &str) -> Option<DeviceCode> {
        let line = plain(raw);
        let text = line.trim();
        match self.want {
            _ if text.contains("Open this link") => self.want = Some("url"),
            _ if text.contains("one-time code") => self.want = Some("code"),
            Some(_) if text.is_empty() => {}
            Some("url") => {
                self.want = None;
                if verification_page(text) {
                    self.url = Some(text.to_owned());
                }
            }
            Some(_) => {
                self.want = None;
                if plausible_code(text) {
                    self.code = Some(Zeroizing::new(text.to_owned()));
                }
            }
            None => {}
        }
        if self.code.is_some() {
            // The CLI prints its page before the code. Only if it printed none is the documented page used.
            let verification_url = self.url.take().unwrap_or_else(|| DOCUMENTED_PAGE.to_owned());
            return Some(DeviceCode { verification_url, user_code: self.code.take()? });
        }
        None
    }
}

fn record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

fn token<'a>(tokens: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    tokens.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty())
}

/// The login the CLI wrote, as the account service stores a Codex
/// subscription login: the four tokens and when they were last renewed.
/// The refresh token is kept: the throwaway home is wiped, so the service is
/// the only holder and the one that renews it.
pub fn sign_in_from_raw(raw: &str) -> Option<SignIn> {
    if raw.len() as u64 > MAX_AUTH_BYTES {
        return None;
    }
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let parsed = record(&parsed)?;
    let tokens = parsed.get("tokens").and_then(record)?;
    let id_token = token(tokens, "id_token")?;
    let mut kept = Map::new();
    kept.insert("id_token".into(), Value::String(id_token.into()));
    kept.insert("access_token".into(), Value::String(token(tokens, "access_token")?.into()));
    kept.insert("refresh_token".into(), Value::String(token(tokens, "refresh_token")?.into()));
    if let Some(account_id) = token(tokens, "account_id") {
        kept.insert("account_id".into(), Value::String(account_id.into()));
    }
    let mut secret = json!({ "auth_mode": "chatgpt", "tokens": kept });
    if let Some(last_refresh) = parsed.get("last_refresh").and_then(Value::as_str) {
        secret["last_refresh"] = Value::String(last_refresh.into());
    }
    Some(SignIn { secret: Zeroizing::new(secret.to_string()), account: crate::agent_local_login::codex_account(id_token) })
}

/// Open a file that is a regular file at `path` itself, never through a
/// link: not a symbolic one (`O_NOFOLLOW`), and not a hard link that shares
/// its contents with a file elsewhere, which zeroing would reach.
fn open_regular(path: &Path, write: bool) -> Option<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(!write).write(write);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(&mut options, libc::O_NOFOLLOW | libc::O_NONBLOCK);
    let file = options.open(path).ok()?;
    file.metadata().ok().filter(|meta| meta.is_file() && single_link(meta)).map(|_| file)
}

#[cfg(unix)]
fn single_link(meta: &std::fs::Metadata) -> bool {
    std::os::unix::fs::MetadataExt::nlink(meta) == 1
}

#[cfg(not(unix))]
fn single_link(_meta: &std::fs::Metadata) -> bool {
    true
}

/// `<home>/.codex/auth.json`, when `.codex` is a real directory inside the home (not a link out of it).
fn auth_path(home: &Path) -> Option<PathBuf> {
    let codex_home = home.join(".codex");
    std::fs::symlink_metadata(&codex_home).ok().filter(|meta| meta.is_dir()).map(|_| codex_home.join("auth.json"))
}

/// The auth file the CLI wrote, read without following links.
fn read_auth(home: &Path) -> Option<Zeroizing<String>> {
    let file = open_regular(&auth_path(home)?, false)?;
    let mut raw = Zeroizing::new(String::new());
    file.take(MAX_AUTH_BYTES + 1).read_to_string(&mut raw).ok()?;
    Some(raw)
}

/// Overwrite the auth file (never through a link), then remove the whole
/// home; `remove_dir_all` does not follow links either.
fn wipe_dir(home: &Path) {
    if let Some(mut file) = auth_path(home).and_then(|auth| open_regular(&auth, true)) {
        if let Ok(meta) = file.metadata() {
            let _ = file.write_all(&vec![0u8; meta.len().min(MAX_AUTH_BYTES * 4) as usize]);
            let _ = file.sync_all();
        }
    }
    let _ = std::fs::remove_dir_all(home);
}

fn wipe(home: tempfile::TempDir) {
    wipe_dir(&home.keep());
}

#[cfg(unix)]
fn process_alive(pid: i32) -> bool {
    pid > 0 && (unsafe { libc::kill(pid, 0) } == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM))
}

#[cfg(not(unix))]
fn process_alive(_pid: i32) -> bool {
    true
}

/// Homes left by an app that ended without cleaning up (a crash, a force
/// quit): only this module's own, and only those whose app is gone or that
/// are older than a code lives. Their CLI already died with that app (the
/// watchdog). Run at every start, and before each sign-in.
pub fn sweep_stale(parent: &Path) {
    let Ok(entries) = std::fs::read_dir(parent) else { return };
    for entry in entries.flatten() {
        if !entry.file_name().to_string_lossy().starts_with(HOME_PREFIX) || !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let path = entry.path();
        let old = entry.metadata().ok().and_then(|meta| meta.modified().ok()).and_then(|at| at.elapsed().ok()).is_some_and(|age| age > CODE_LIFETIME + GRACE);
        let owner = open_regular(&path.join(OWNER_FILE), false).and_then(|mut file| {
            let mut text = String::new();
            file.read_to_string(&mut text).ok()?;
            text.trim().parse::<i32>().ok()
        });
        if old || owner.is_some_and(|pid| !process_alive(pid)) {
            wipe_dir(&path);
        }
    }
}

/// How long a killed group may take to be gone: SIGKILL is not refused, so
/// this is only the time to be scheduled and reaped.
const GROUP_EXIT_WAIT: Duration = Duration::from_secs(5);

/// Kill the watchdog's whole group and return once none of it is left.
/// Reaping the watchdog is not enough: the CLI is its child, not ours, and
/// a SIGKILL is delivered when its target next runs. Until it has, the CLI
/// can still be writing into the home about to be wiped.
#[cfg(unix)]
fn kill_group(child: &mut Child) {
    // The npm `codex` is a node script that starts the real binary: the whole group goes.
    let group = i32::try_from(child.id()).ok();
    if let Some(group) = group {
        unsafe {
            libc::killpg(group, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    let Some(group) = group else { return };
    // The group lasts while any member does, dead or not yet reaped by launchd.
    let deadline = Instant::now() + GROUP_EXIT_WAIT;
    let left = || unsafe { libc::killpg(group, 0) } == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
    while group > 0 && left() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(2));
    }
}

#[cfg(not(unix))]
fn kill_group(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Start `program login --device-auth` in a new throwaway home under
/// `parent`, and wait for its code. `extra_args` go after Codex's own
/// (a debug build passes a stand-in issuer this way).
pub fn start(program: &Path, extra_args: &[String], path_env: &str, parent: &Path) -> Result<(DeviceLogin, DeviceCode), DeviceLoginError> {
    let unavailable = |_| DeviceLoginError::Unavailable;
    sweep_stale(parent);
    let mut builder = tempfile::Builder::new();
    builder.prefix(HOME_PREFIX);
    #[cfg(unix)]
    builder.permissions(std::os::unix::fs::PermissionsExt::from_mode(0o700));
    let home = builder.tempdir_in(parent).map_err(unavailable)?;
    std::fs::write(home.path().join(OWNER_FILE), std::process::id().to_string()).map_err(unavailable)?;
    let codex_home = home.path().join(".codex");
    let mut dir = std::fs::DirBuilder::new();
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut dir, 0o700);
    dir.create(&codex_home).map_err(unavailable)?;
    std::fs::write(codex_home.join("config.toml"), CONFIG).map_err(unavailable)?;

    // Spawning `program` directly would report a missing one; through the watchdog it would not.
    if !program.is_file() {
        return Err(DeviceLoginError::CliMissing);
    }
    let mut command = Command::new("/bin/sh");
    command
        .args(["-c", WATCHDOG, "codex-login"])
        .arg(program)
        .args(["login", "--device-auth", "-c", "cli_auth_credentials_store=\"file\""])
        .args(extra_args)
        .env_clear()
        .env("PATH", path_env)
        .env("HOME", home.path())
        .env("CODEX_HOME", &codex_home)
        .env("TMPDIR", home.path())
        .current_dir(home.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for name in PASSED_ENV {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let mut child = command.spawn().map_err(|error| if error.kind() == std::io::ErrorKind::NotFound { DeviceLoginError::CliMissing } else { DeviceLoginError::Unavailable })?;

    let lifeline = child.stdin.take();
    let stdout = child.stdout.take().ok_or(DeviceLoginError::Unavailable)?;
    let stderr = child.stderr.take().ok_or(DeviceLoginError::Unavailable)?;
    let (code_tx, code_rx) = mpsc::sync_channel::<DeviceCode>(1);
    let out_reader = std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut prompt = PromptReader::default();
        let mut sent = false;
        loop {
            let mut line = Zeroizing::new(String::new());
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) if !sent => {
                    if let Some(code) = prompt.feed(&line) {
                        let _ = code_tx.send(code);
                        sent = true;
                    }
                }
                Ok(_) => {}
            }
        }
    });
    // Read only to tell an expired code from other failures; never shown or logged.
    let err_reader = std::thread::spawn(move || {
        let mut text = Zeroizing::new(Vec::new());
        let _ = stderr.take(16 * 1024).read_to_end(&mut text);
        String::from_utf8_lossy(&text).contains("timed out")
    });

    let inner = Arc::new(Mutex::new(Inner { child: Some(child), lifeline, home: Some(home), ..Inner::new(Phase::Waiting, None) }));
    let watched = inner.clone();
    let started = Instant::now();
    std::thread::spawn(move || {
        // The child is reaped here or by `shutdown`, always under the lock, so a pid is never killed after it was reaped.
        let status = loop {
            {
                let Ok(mut inner) = watched.lock() else { return };
                let late = started.elapsed() > CODE_LIFETIME + GRACE;
                let Some(child) = inner.child.as_mut() else { break None };
                if late {
                    kill_group(child);
                    inner.child = None;
                    inner.lifeline = None;
                    if inner.phase == Phase::Waiting {
                        inner.phase = Phase::Expired;
                    }
                    break None;
                }
                match child.try_wait() {
                    Ok(Some(status)) => {
                        inner.child = None;
                        inner.lifeline = None;
                        break Some(status);
                    }
                    Ok(None) => {}
                    Err(_) => break None,
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        };
        let _ = out_reader.join();
        let timed_out = err_reader.join().unwrap_or(false);
        let Ok(mut inner) = watched.lock() else { return };
        inner.lifeline = None;
        // Shut down meanwhile: the home is already gone, and so is anything it held.
        let Some(home) = inner.home.take() else { return };
        let written = status.filter(|status| status.success()).map(|_| read_auth(home.path()).and_then(|raw| sign_in_from_raw(&raw)));
        wipe(home);
        if inner.phase == Phase::Waiting && !inner.cancel {
            (inner.phase, inner.sign_in) = match (status, written) {
                (_, Some(Some(sign_in))) => (Phase::SignedIn, Some(sign_in)),
                (Some(_), _) if timed_out => (Phase::Expired, None),
                _ => (Phase::Failed, None),
            };
        }
    });

    let login = DeviceLogin { inner };
    match code_rx.recv_timeout(CODE_TIMEOUT) {
        Ok(code) => Ok((login, code)),
        // The CLI ended, or said nothing usable in time: dropping the login stops it and wipes its home.
        Err(_) => Err(DeviceLoginError::Unavailable),
    }
}

/// Whether `program` may be run for a sign-in: it, what it links to, and
/// the directories holding either belong to this user or to root and
/// cannot be written by anyone else. The same `codex` a Codex tab runs is
/// used (`binpath`), so it is the one the person installed; this refuses
/// only one that another account on this Mac could have swapped.
#[cfg(unix)]
pub fn trusted_program(program: &Path) -> bool {
    let Ok(real) = std::fs::canonicalize(program) else { return false };
    let checked = [Some(real.as_path()), real.parent(), program.parent()].into_iter().all(|path| path.is_some_and(owned_safely));
    checked
}

#[cfg(not(unix))]
pub fn trusted_program(_program: &Path) -> bool {
    true
}

/// `path_env` without the directories another account could write into.
/// The npm `codex` is a `#!/usr/bin/env node` script, so whatever `node`
/// comes first in PATH runs the sign-in; a group- or world-writable
/// directory ahead of the real one could hold a planted `node`. Relative
/// and empty entries (the working directory) are dropped too.
#[cfg(unix)]
pub fn trusted_path(path_env: &str) -> String {
    let kept: Vec<&str> = std::env::split_paths(path_env)
        .zip(path_env.split(':'))
        .filter(|(dir, _)| dir.is_absolute() && owned_safely(dir) && std::fs::canonicalize(dir).is_ok_and(|real| owned_safely(&real)))
        .map(|(_, entry)| entry)
        .collect();
    kept.join(":")
}

#[cfg(not(unix))]
pub fn trusted_path(path_env: &str) -> String {
    path_env.to_string()
}

/// Whether `program` can run on `path_env` with nothing another account
/// could swap: a `#!/usr/bin/env <interpreter>` script needs that
/// interpreter in `path_env`, and the first one found must pass
/// `trusted_program` too. Refusing here says why, instead of the CLI
/// dying with "env: node: No such file" (e.g. node only in a
/// group-writable Homebrew folder).
pub fn runs_trusted(program: &Path, path_env: &str) -> bool {
    let mut head = [0u8; 128];
    let read = std::fs::File::open(program).and_then(|mut file| file.read(&mut head)).unwrap_or(0);
    let first_line = String::from_utf8_lossy(&head[..read]).lines().next().unwrap_or("").to_string();
    let Some(interpreter) = first_line.strip_prefix("#!").and_then(|line| {
        let mut words = line.split_whitespace();
        (words.next()? == "/usr/bin/env").then(|| words.find(|word| !word.starts_with('-'))).flatten()
    }) else {
        return true;
    };
    std::env::split_paths(path_env).map(|dir| dir.join(interpreter)).find(|candidate| candidate.is_file()).is_some_and(|found| trusted_program(&found))
}

/// Belongs to this user or to root, and no one else can write to it.
#[cfg(unix)]
fn owned_safely(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    let me = unsafe { libc::getuid() };
    std::fs::metadata(path).is_ok_and(|meta| (meta.uid() == me || meta.uid() == 0) && meta.mode() & 0o022 == 0)
}

/// Where throwaway homes go: this user's own temporary directory.
pub fn homes_parent() -> PathBuf {
    std::env::temp_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROMPT: &str = "\nWelcome to Codex [v\u{1b}[90m0.153.4\u{1b}[0m]\n\u{1b}[90mOpenAI's command-line coding agent\u{1b}[0m\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \u{1b}[94mhttps://auth.openai.com/codex/device\u{1b}[0m\n\n2. Enter this one-time code \u{1b}[90m(expires in 15 minutes)\u{1b}[0m\n   \u{1b}[94mWXYZ-12345\u{1b}[0m\n\n\u{1b}[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\u{1b}[0m\n\n";

    fn read(prompt: &str) -> Option<DeviceCode> {
        let mut reader = PromptReader::default();
        prompt.split_inclusive('\n').find_map(|line| reader.feed(line))
    }

    #[test]
    fn the_page_and_code_are_read_from_the_clis_own_prompt() {
        let code = read(PROMPT).unwrap();
        assert_eq!(code.verification_url, "https://auth.openai.com/codex/device");
        assert_eq!(code.user_code.as_str(), "WXYZ-12345");
    }

    #[test]
    fn the_page_is_the_one_the_cli_printed_and_the_documented_one_only_when_it_printed_none() {
        let printed = read(&PROMPT.replace("https://auth.openai.com/codex/device", "https://auth.openai.com/codex/device?region=eu")).unwrap();
        assert_eq!(printed.verification_url, "https://auth.openai.com/codex/device?region=eu");
        let none = read(&PROMPT.replace("   \u{1b}[94mhttps://auth.openai.com/codex/device\u{1b}[0m\n", "")).unwrap();
        assert_eq!(none.verification_url, DOCUMENTED_PAGE);
        assert_eq!(none.user_code.as_str(), "WXYZ-12345");
    }

    #[test]
    fn a_prompt_pointing_elsewhere_or_with_no_code_gives_nothing() {
        // A page that is not OpenAI's is not opened; the documented one is used instead of it.
        assert_eq!(read(&PROMPT.replace("https://auth.openai.com/codex/device", "https://auth.openai.com.evil.test/codex/device")).unwrap().verification_url, DOCUMENTED_PAGE);
        assert_eq!(read(&PROMPT.replace("https://auth.openai.com/codex/device", "https://user:pw@auth.openai.com/codex/device")).unwrap().verification_url, DOCUMENTED_PAGE);
        assert!(read(&PROMPT.replace("WXYZ-12345", "run rm -rf now")).is_none());
        assert!(read("Error logging in with device code: device code login is not enabled for this Codex server.\n").is_none());
        assert!(verification_page("https://chatgpt.com/codex/device"));
        assert!(!verification_page("http://auth.openai.com/codex/device"));
        assert!(!verification_page("https://openai.com.example/"));
    }

    fn jwt(claims: Value) -> String {
        crate::agent_local_login::tests::jwt(claims)
    }

    #[test]
    fn the_written_login_is_kept_whole_and_named_by_its_account() {
        let id = jwt(json!({ "email": "ada@example.com" }));
        let raw = json!({
            "auth_mode": "chatgpt",
            "OPENAI_API_KEY": null,
            "tokens": { "id_token": id, "access_token": "at", "refresh_token": "rt", "account_id": "acct_1" },
            "last_refresh": "2026-10-15T10:00:00Z",
            "agent_identity": null,
        })
        .to_string();
        let sign_in = sign_in_from_raw(&raw).unwrap();
        let stored: Value = serde_json::from_str(&sign_in.secret).unwrap();
        assert_eq!(
            stored,
            json!({ "auth_mode": "chatgpt", "tokens": { "id_token": id, "access_token": "at", "refresh_token": "rt", "account_id": "acct_1" }, "last_refresh": "2026-10-15T10:00:00Z" })
        );
        assert_eq!(sign_in.account.as_deref(), Some("ada@example.com"));
        for raw in ["{}", r#"{"OPENAI_API_KEY":"sk-1"}"#, r#"{"tokens":{"id_token":"x","access_token":"at"}}"#, "nope"] {
            assert!(sign_in_from_raw(raw).is_none(), "{raw}");
        }
    }

    /// A stand-in for `codex` that prints the real prompt and, unless told
    /// otherwise, writes a login where the real one does. It also records
    /// what it was given, to check the throwaway home.
    fn fake_cli(dir: &Path, behaviour: &str) -> PathBuf {
        let script = dir.join("codex");
        let prompt = PROMPT.replace('\u{1b}', "\\033").replace('\n', "\\n").replace('\'', "'\\''");
        let id = jwt(json!({ "email": "ada@example.com" }));
        let body = format!(
            r#"#!/bin/sh
printf '%s|%s|%s|%s|%s|%s|%s\n' "$*" "$HOME" "$CODEX_HOME" "${{TERMINALX_P79_FROM_THE_APP:-none}}" "$(cat "$CODEX_HOME/config.toml" | tr '\n' ';')" "$(stat -f %Lp "$HOME")" "$$" > '{record}'
printf '{prompt}'
case '{behaviour}' in
  expire) echo 'Error logging in with device code: device auth timed out after 15 minutes' >&2; exit 1 ;;
  fail) echo 'Error logging in with device code: device auth failed with status 500' >&2; exit 1 ;;
  wait) sleep 30; exit 1 ;;
esac
sleep 1
printf '%s' '{{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{{"id_token":"{id}","access_token":"at-1","refresh_token":"rt-1","account_id":"acct_1"}},"last_refresh":"2026-10-15T10:00:00Z"}}' > "$CODEX_HOME/auth.json"
echo 'Successfully logged in' >&2
"#,
            record = dir.join("record").display(),
        );
        std::fs::write(&script, body).unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        script
    }

    fn settle(login: &DeviceLogin) -> Phase {
        let deadline = Instant::now() + Duration::from_secs(10);
        while login.phase() == Phase::Waiting && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        login.phase()
    }

    fn homes(parent: &Path) -> usize {
        std::fs::read_dir(parent).unwrap().flatten().filter(|entry| entry.file_name().to_string_lossy().starts_with(HOME_PREFIX)).count()
    }

    #[test]
    fn a_finished_login_is_held_and_its_throwaway_home_wiped() {
        let bin = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let cli = fake_cli(bin.path(), "succeed");
        // Something only the app's own environment has: the CLI must not see it.
        std::env::set_var("TERMINALX_P79_FROM_THE_APP", "leaked");
        let (login, code) = start(&cli, &[], "/usr/bin:/bin", parent.path()).unwrap();
        assert_eq!(code.user_code.as_str(), "WXYZ-12345");
        assert_eq!(login.phase(), Phase::Waiting);
        assert_eq!(settle(&login), Phase::SignedIn);
        let sign_in = login.sign_in().unwrap();
        assert!(sign_in.secret.contains("rt-1") && sign_in.secret.contains("at-1"));
        assert_eq!(sign_in.account.as_deref(), Some("ada@example.com"));
        assert_eq!(homes(parent.path()), 0, "the throwaway home is gone once the CLI ends");
        let record = std::fs::read_to_string(bin.path().join("record")).unwrap();
        let fields: Vec<&str> = record.trim_end().split('|').collect();
        assert_eq!(fields[0], "login --device-auth -c cli_auth_credentials_store=\"file\"");
        let home = Path::new(fields[1]);
        assert!(home.starts_with(parent.path()) && home.file_name().unwrap().to_string_lossy().starts_with(HOME_PREFIX));
        assert_eq!(Path::new(fields[2]), home.join(".codex"));
        assert_eq!(fields[3], "none", "the app's own environment does not reach the CLI");
        assert!(fields[4].contains("cli_auth_credentials_store = \"file\""));
        assert_eq!(fields[5], "700", "the throwaway home is private to this user");
        // Canceling after the fact drops what was held.
        login.shutdown();
        assert!(login.sign_in().is_none());
        assert_eq!(login.phase(), Phase::Cancelled);
    }

    #[test]
    fn an_expired_code_a_failure_and_a_cancel_each_say_so_and_leave_nothing() {
        let bin = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        for (behaviour, phase) in [("expire", Phase::Expired), ("fail", Phase::Failed)] {
            let (login, _) = start(&fake_cli(bin.path(), behaviour), &[], "/usr/bin:/bin", parent.path()).unwrap();
            assert_eq!(settle(&login), phase, "{behaviour}");
            assert!(login.sign_in().is_none());
        }
        let (login, _) = start(&fake_cli(bin.path(), "wait"), &[], "/usr/bin:/bin", parent.path()).unwrap();
        login.shutdown();
        assert_eq!(login.phase(), Phase::Cancelled);
        let deadline = Instant::now() + Duration::from_secs(10);
        while homes(parent.path()) > 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(homes(parent.path()), 0);
    }

    #[test]
    fn a_cli_that_never_prints_a_code_or_is_missing_is_refused() {
        let parent = tempfile::tempdir().unwrap();
        assert_eq!(start(Path::new("/nonexistent/codex"), &[], "/usr/bin:/bin", parent.path()).err(), Some(DeviceLoginError::CliMissing));
        let bin = tempfile::tempdir().unwrap();
        let script = bin.path().join("codex");
        std::fs::write(&script, "#!/bin/sh\necho 'Error logging in with device code: device code login is not enabled for this Codex server.' >&2\nexit 1\n").unwrap();
        #[cfg(unix)]
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        assert_eq!(start(&script, &[], "/usr/bin:/bin", parent.path()).err(), Some(DeviceLoginError::Unavailable));
    }

    #[test]
    fn stale_homes_from_an_earlier_run_are_swept_and_nothing_else() {
        let parent = tempfile::tempdir().unwrap();
        let stale = parent.path().join(format!("{HOME_PREFIX}old"));
        let other = parent.path().join("someone-else");
        std::fs::create_dir(&stale).unwrap();
        std::fs::create_dir(&other).unwrap();
        let old = std::time::SystemTime::now() - CODE_LIFETIME - GRACE - Duration::from_secs(60);
        for dir in [&stale, &other] {
            std::fs::File::open(dir).unwrap().set_modified(old).unwrap();
        }
        let fresh = parent.path().join(format!("{HOME_PREFIX}new"));
        std::fs::create_dir(&fresh).unwrap();
        sweep_stale(parent.path());
        assert!(!stale.exists() && other.exists() && fresh.exists());
    }

    /// The real `codex` on this Mac, against a stand-in OpenAI issuer on
    /// loopback (`--experimental_issuer`, a hidden flag of the CLI): the
    /// prompt is read, the code is approved after two polls, and the login
    /// the CLI writes is picked up. Touches no account and no `~/.codex`.
    /// Run with `cargo test -- --ignored the_real_codex_cli`.
    #[test]
    #[ignore]
    fn the_real_codex_cli_signs_in_against_a_stand_in_issuer() {
        use std::net::TcpListener;
        let program = crate::binpath::resolve("codex").expect("codex on PATH");
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let issuer = format!("http://{}", listener.local_addr().unwrap());
        let id_token = jwt(json!({ "email": "ada@example.com", "https://api.openai.com/auth": { "chatgpt_plan_type": "plus", "chatgpt_account_id": "acct_test" }, "exp": 4_000_000_000u64 }));
        let access_token = jwt(json!({ "exp": 4_000_000_000u64 }));
        let seen = Arc::new(Mutex::new(Vec::<String>::new()));
        let log = seen.clone();
        let (id_reply, access_reply) = (id_token.clone(), access_token.clone());
        std::thread::spawn(move || {
            let mut polls = 0;
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                reader.read_line(&mut request).unwrap();
                let mut length = 0;
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header.trim().is_empty() {
                        break;
                    }
                    if let Some(value) = header.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let path = request.split_whitespace().nth(1).unwrap_or("").to_string();
                log.lock().unwrap().push(format!("{path} {}", String::from_utf8_lossy(&body)));
                let (status, reply) = match path.as_str() {
                    "/api/accounts/deviceauth/usercode" => (200, json!({ "device_auth_id": "dev-1", "user_code": "TEST-12345", "interval": "1" }).to_string()),
                    "/api/accounts/deviceauth/token" if polls < 2 => {
                        polls += 1;
                        (403, "{}".to_string())
                    }
                    "/api/accounts/deviceauth/token" => (200, json!({ "authorization_code": "code-1", "code_challenge": "ch", "code_verifier": "ver" }).to_string()),
                    "/oauth/token" => (200, json!({ "id_token": id_reply, "access_token": access_reply, "refresh_token": "rt-test" }).to_string()),
                    _ => (404, "{}".to_string()),
                };
                let _ = write!(stream, "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}", reply.len());
            }
        });
        let parent = tempfile::tempdir().unwrap();
        // The PATH and checks the app uses: only directories no other account can write, and a node that passes too.
        let path = trusted_path(&crate::binpath::login_path());
        assert!(trusted_program(&program) && runs_trusted(&program, &path), "this Mac's codex or its node would be refused");
        let (login, code) = start(&program, &["--experimental_issuer".into(), issuer.clone()], &path, parent.path()).unwrap();
        assert_eq!(code.verification_url, format!("{issuer}/codex/device"));
        assert_eq!(code.user_code.as_str(), "TEST-12345");
        let deadline = Instant::now() + Duration::from_secs(30);
        while login.phase() == Phase::Waiting && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert_eq!(login.phase(), Phase::SignedIn, "requests: {:?}", seen.lock().unwrap());
        let sign_in = login.sign_in().unwrap();
        let stored: Value = serde_json::from_str(&sign_in.secret).unwrap();
        assert_eq!(stored["auth_mode"], "chatgpt");
        assert_eq!(stored["tokens"]["refresh_token"], "rt-test");
        assert_eq!(stored["tokens"]["access_token"], json!(access_token));
        assert_eq!(stored["tokens"]["id_token"], json!(id_token));
        assert_eq!(stored["tokens"]["account_id"], "acct_test");
        assert!(stored["last_refresh"].is_string());
        assert_eq!(sign_in.account.as_deref(), Some("ada@example.com"));
        assert_eq!(homes(parent.path()), 0);
        let requests = seen.lock().unwrap().join("\n");
        // The code goes only to the issuer, never anywhere else.
        assert!(requests.contains("/api/accounts/deviceauth/token {\"device_auth_id\":\"dev-1\",\"user_code\":\"TEST-12345\"}"), "{requests}");
    }

    fn record_of(bin: &Path) -> Vec<String> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(text) = std::fs::read_to_string(bin.join("record")) {
                if text.ends_with('\n') {
                    return text.trim_end().split('|').map(str::to_owned).collect();
                }
            }
            assert!(Instant::now() < deadline, "the fake CLI never ran");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn gone(pid: i32) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while process_alive(pid) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        !process_alive(pid)
    }

    // Security review of #483: quitting left the CLI running and its auth.json behind.
    #[test]
    fn shutting_down_kills_the_cli_and_wipes_its_home_before_it_returns() {
        let bin = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let (login, _) = start(&fake_cli(bin.path(), "wait"), &[], "/usr/bin:/bin", parent.path()).unwrap();
        let pid: i32 = record_of(bin.path())[6].parse().unwrap();
        assert!(process_alive(pid));
        login.shutdown();
        // No waiting: by the time it returns, the CLI's group is dead and reaped and the home is gone.
        assert!(!process_alive(pid), "the CLI outlived shutdown");
        assert_eq!(homes(parent.path()), 0);
        assert_eq!(login.phase(), Phase::Cancelled);
    }

    #[test]
    fn the_cli_dies_with_the_app_however_the_app_ends() {
        let bin = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let (login, _) = start(&fake_cli(bin.path(), "wait"), &[], "/usr/bin:/bin", parent.path()).unwrap();
        let pid: i32 = record_of(bin.path())[6].parse().unwrap();
        // What a crash or a force quit does: the app's end of the lifeline closes, and nothing else happens.
        login.drop_lifeline_for_test();
        assert!(gone(pid), "the CLI outlived its lifeline");
        drop(login);
    }

    #[test]
    fn links_are_never_followed_when_reading_or_wiping() {
        let home = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("precious.json");
        std::fs::write(&target, "keep me").unwrap();
        // `.codex` itself a link out of the home.
        std::os::unix::fs::symlink(outside.path(), home.path().join(".codex")).unwrap();
        std::fs::write(outside.path().join("auth.json"), "{}").unwrap();
        assert!(read_auth(home.path()).is_none());
        wipe_dir(home.path());
        assert_eq!(std::fs::read_to_string(outside.path().join("auth.json")).unwrap(), "{}");
        // `auth.json` a link to a file elsewhere.
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".codex")).unwrap();
        std::os::unix::fs::symlink(&target, home.path().join(".codex/auth.json")).unwrap();
        assert!(read_auth(home.path()).is_none());
        let kept = home.path().to_path_buf();
        wipe_dir(&kept);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep me");
        assert!(!kept.exists());
        // `auth.json` a hard link to a file elsewhere: neither read nor zeroed.
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".codex")).unwrap();
        std::fs::hard_link(&target, home.path().join(".codex/auth.json")).unwrap();
        assert!(read_auth(home.path()).is_none());
        let kept = home.path().to_path_buf();
        wipe_dir(&kept);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "keep me");
        assert!(!kept.exists());
        // The CLI's own file, linked nowhere else, is read.
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join(".codex")).unwrap();
        std::fs::write(home.path().join(".codex/auth.json"), "{}").unwrap();
        assert_eq!(read_auth(home.path()).as_deref().map(String::as_str), Some("{}"));
    }

    #[test]
    fn the_path_the_cli_gets_leaves_out_directories_another_account_could_write() {
        let mode = |dir: &Path, mode: u32| std::fs::set_permissions(dir, std::os::unix::fs::PermissionsExt::from_mode(mode)).unwrap();
        let [safe, group, world, linked_to_unsafe] = std::array::from_fn(|_| tempfile::tempdir().unwrap());
        mode(safe.path(), 0o755);
        mode(group.path(), 0o775);
        mode(world.path(), 0o777);
        mode(linked_to_unsafe.path(), 0o755);
        let link = linked_to_unsafe.path().join("bin");
        std::os::unix::fs::symlink(world.path(), &link).unwrap();
        let missing = safe.path().join("missing");
        let path = [world.path(), group.path(), &link, Path::new("relative/bin"), Path::new(""), &missing, safe.path()]
            .map(|dir| dir.to_str().unwrap().to_string())
            .join(":");
        assert_eq!(trusted_path(&path), safe.path().to_str().unwrap());
        // A planted `node` in the writable directory ahead of the real one is never what `env node` finds.
        std::fs::write(world.path().join("node"), "#!/bin/sh\n").unwrap();
        assert!(!trusted_path(&path).split(':').any(|dir| Path::new(dir).join("node").exists()));
    }

    #[test]
    fn a_node_script_codex_runs_only_with_a_node_no_one_else_can_swap() {
        let mode = |path: &Path, mode: u32| std::fs::set_permissions(path, std::os::unix::fs::PermissionsExt::from_mode(mode)).unwrap();
        let [bin, other] = std::array::from_fn(|_| tempfile::tempdir().unwrap());
        mode(bin.path(), 0o755);
        mode(other.path(), 0o755);
        let codex = bin.path().join("codex");
        std::fs::write(&codex, "#!/usr/bin/env node\nrequire('./codex.js')\n").unwrap();
        mode(&codex, 0o755);
        let path = |dirs: &[&Path]| dirs.iter().map(|dir| dir.to_str().unwrap()).collect::<Vec<_>>().join(":");
        // No node at all on the PATH it gets (e.g. node only in a group-writable folder that was dropped).
        assert!(!runs_trusted(&codex, &path(&[bin.path()])));
        // A node of its own, safe.
        let node = other.path().join("node");
        std::fs::write(&node, "#!/bin/sh\n").unwrap();
        mode(&node, 0o755);
        assert!(runs_trusted(&codex, &path(&[bin.path(), other.path()])));
        // The first node found is writable by others: refused, even with a good one later.
        let writable = tempfile::tempdir().unwrap();
        mode(writable.path(), 0o755);
        std::fs::write(writable.path().join("node"), "#!/bin/sh\n").unwrap();
        mode(&writable.path().join("node"), 0o777);
        assert!(!runs_trusted(&codex, &path(&[writable.path(), other.path()])));
        // A native binary (no `#!/usr/bin/env`) needs nothing from PATH.
        std::fs::write(&codex, b"\xcf\xfa\xed\xfe").unwrap();
        assert!(runs_trusted(&codex, &path(&[bin.path()])));
    }

    #[test]
    fn a_home_whose_app_is_gone_is_swept_at_once_and_a_live_ones_is_kept() {
        let parent = tempfile::tempdir().unwrap();
        let mut ended = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let dead = ended.id();
        ended.wait().unwrap();
        let orphan = parent.path().join(format!("{HOME_PREFIX}orphan"));
        let live = parent.path().join(format!("{HOME_PREFIX}live"));
        for (dir, owner) in [(&orphan, dead), (&live, std::process::id())] {
            std::fs::create_dir_all(dir.join(".codex")).unwrap();
            std::fs::write(dir.join(".codex/auth.json"), r#"{"tokens":{"refresh_token":"rt"}}"#).unwrap();
            std::fs::write(dir.join(OWNER_FILE), owner.to_string()).unwrap();
        }
        sweep_stale(parent.path());
        assert!(!orphan.exists() && live.exists());
    }

    #[test]
    fn a_codex_another_account_could_swap_is_not_run() {
        let dir = tempfile::tempdir().unwrap();
        let cli = fake_cli(dir.path(), "succeed");
        std::fs::set_permissions(dir.path(), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        assert!(trusted_program(&cli));
        // Writable by the group or by anyone: the file, or the directory it is in.
        std::fs::set_permissions(&cli, std::os::unix::fs::PermissionsExt::from_mode(0o777)).unwrap();
        assert!(!trusted_program(&cli));
        std::fs::set_permissions(&cli, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        std::fs::set_permissions(dir.path(), std::os::unix::fs::PermissionsExt::from_mode(0o775)).unwrap();
        assert!(!trusted_program(&cli));
        // A link from a safe place to one that is not.
        std::fs::set_permissions(dir.path(), std::os::unix::fs::PermissionsExt::from_mode(0o757)).unwrap();
        let safe = tempfile::tempdir().unwrap();
        std::fs::set_permissions(safe.path(), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink(&cli, safe.path().join("codex")).unwrap();
        assert!(!trusted_program(&safe.path().join("codex")));
        std::fs::set_permissions(dir.path(), std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
        assert!(trusted_program(&safe.path().join("codex")));
        assert!(!trusted_program(Path::new("/nonexistent/codex")));
        // The codex on this Mac, if there is one, passes.
        if let Some(real) = crate::binpath::resolve("codex") {
            assert!(trusted_program(&real), "{}", real.display());
        }
    }
}
