//! GitHub access in a cloud workspace (PRO-14): the `gh` shim and the Git
//! credential helper that terminalx-serve installs on every boot.
//!
//! The API (terminalx-saas `apps/api`) is the only holder of the GitHub App
//! key and the only minter of installation tokens. A process in the VM that
//! needs GitHub asks for a token scoped to the workspace's repositories
//! (`POST /v1/cloud-workspace-bootstrap/github-token`, authenticated with the
//! runtime credential `cloud_bootstrap` stored), and nothing else in the VM
//! ever holds one for long: no token is written into a remote URL, the Git
//! config, a log or the data directory. `gh auth login` inside the VM is never
//! the fix; the shim is reinstalled on every boot and wins over it.
//!
//! The helper is this binary: `terminalx-serve github-auth --dir <dir>
//! credential get|store|erase` for Git and `... token` for `gh`. Git and
//! `gh` run it as a short-lived process, so it cannot share the runtime's
//! memory; it reads the runtime credential from the stored identity
//! (`cloud-workspace/runtime.json`, 0600 in a 0700 directory), which is only
//! ever replaced whole, and the API origin from `<dir>/broker.json`, written
//! at boot. Two small scripts sit in `<dir>/bin`:
//!
//! - `terminalx-github-auth`, the credential helper Git runs;
//! - `gh`, which puts `GH_TOKEN` in its environment and `exec`s the real
//!   `gh`. It asks for the repository the current directory's `origin`
//!   points at, falling back to the workspace default. `<dir>/bin` goes first on the `PATH` of everything the runtime
//!   spawns ([`crate::binpath::set_priority_dir`]).
//!
//! Git is configured for `https://github.com` only (an empty helper first
//! resets inherited ones, such as `gh auth setup-git`):
//!
//! ```text
//! credential.https://github.com.helper = ""
//! credential.https://github.com.helper = <dir>/bin/terminalx-github-auth credential
//! credential.https://github.com.useHttpPath = true
//! credential.https://github.com.username = x-access-token
//! ```
//!
//! `useHttpPath` makes Git pass `path=owner/name.git`, which picks the
//! repository the token is minted for; `gh` passes none and gets the
//! workspace default.
//!
//! Tokens are cached per repository key in a 0700 tmpfs directory (the same
//! base `cloud_grants` uses); without tmpfs nothing is cached and every
//! request mints, so a token never reaches the disk. Git's `erase` (GitHub
//! rejected the token) drops the cached entry. A cached
//! token is reused until less than five minutes remain; a refresh takes a
//! per-key `flock` and checks the cache again once it holds it, so parallel
//! Git processes mint once. When the API cannot be reached (a transport error,
//! 429 or 5xx) a cached token that is still valid is used anyway. A definite
//! refusal (401, 403, 409, other 4xx) is reported to Git on stderr, with the
//! server's code, and the helper exits non-zero. The cache is emptied on every
//! boot.

use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

/// The subcommand of terminalx-serve that is the helper.
pub const SUBCOMMAND: &str = "github-auth";
const TOKEN_PATH: &str = "/v1/cloud-workspace-bootstrap/github-token";
const DIR_NAME: &str = "github-auth";
const CONFIG_FILE: &str = "broker.json";
const BIN_DIR: &str = "bin";
const TMPFS_CACHE_DIR: &str = "github";
const HELPER_SCRIPT: &str = "terminalx-github-auth";
const GH_SCRIPT: &str = "gh";
const GITHUB_HOST: &str = "github.com";
const CREDENTIAL_SECTION: &str = "credential.https://github.com";
const USERNAME: &str = "x-access-token";
/// Reuse a cached token until less than this much of it is left.
const REFRESH_MARGIN_MS: u64 = 5 * 60 * 1000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_REPOSITORY_LEN: usize = 201;

/// What the boot writes for the helper processes.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BrokerConfig {
    v: u8,
    origin: String,
    /// The bootstrap's state directory, holding the runtime credential.
    state_dir: PathBuf,
    /// `None` without tmpfs: tokens are then never written anywhere.
    cache_dir: Option<PathBuf>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CachedToken {
    v: u8,
    token: String,
    expires_at: u64,
}

impl Drop for CachedToken {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

/// `200` from the token endpoint. Unknown fields are tolerated.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Minted {
    pub v: u8,
    pub token: String,
    pub expires_at: u64,
}

impl Drop for Minted {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}

/// Why no token was minted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MintError {
    /// `None` when the API could not be reached at all.
    pub status: Option<u16>,
    /// The `error` code of the response body, if it had one.
    pub code: Option<String>,
    pub detail: String,
}

impl MintError {
    fn unreachable(detail: impl Into<String>) -> Self {
        Self { status: None, code: None, detail: detail.into() }
    }

    /// An outage, as opposed to the server refusing: a still-valid cached
    /// token may be used instead.
    pub fn is_outage(&self) -> bool {
        match self.status {
            None => true,
            Some(status) => status == 429 || status >= 500,
        }
    }

    /// What Git or `gh` prints, for `repository` (or the workspace default).
    pub fn explain(&self, repository: Option<&str>) -> String {
        let target = repository.unwrap_or("this cloud workspace");
        let subject = repository.unwrap_or("the workspace's repositories");
        let reason = match (self.status, self.code.as_deref()) {
            (_, Some("cloud_workspace_bootstrap_invalid")) | (Some(401), _) => {
                "the server no longer accepts this workspace's runtime credential; restart the workspace".to_string()
            }
            (_, Some("github_repository_not_authorized")) => format!("{subject} is not one of this workspace's repositories"),
            (_, Some("github_access_not_configured")) => format!(
                "no GitHub App installation or organization GitHub credential covers {subject}; an organization admin can connect one in TerminalX Settings"
            ),
            (_, Some("github_installation_revoked")) => {
                "the organization's GitHub App installation was uninstalled or disconnected; an organization admin must reconnect it in TerminalX Settings".to_string()
            }
            (_, Some("github_installation_suspended")) => {
                "the organization's GitHub App installation is suspended on GitHub; an organization owner can unsuspend it there".to_string()
            }
            (_, Some("github_repository_not_granted")) => {
                format!("the GitHub App installation no longer grants access to {subject}; an organization admin can grant it on GitHub")
            }
            (_, Some("github_app_not_configured")) => "GitHub App access is not configured on this TerminalX server".to_string(),
            (_, Some("github_app_unavailable")) => "GitHub did not answer the TerminalX server; try again shortly".to_string(),
            _ => self.detail.clone(),
        };
        match &self.code {
            Some(code) => format!("terminalx: no GitHub access for {target}: {reason} ({code})"),
            None => format!("terminalx: no GitHub access for {target}: {reason}"),
        }
    }
}

/// The one call the helper makes; a trait so tests can stand in for it.
pub trait TokenApi {
    fn mint(&self, repository: Option<&str>) -> Result<Minted, MintError>;
}

/// The token endpoint over HTTP, with the stored runtime credential.
pub struct HttpTokenApi {
    origin: String,
    state_dir: PathBuf,
    agent: ureq::Agent,
}

impl HttpTokenApi {
    pub fn new(origin: &str, state_dir: &Path) -> Self {
        let agent = ureq::AgentBuilder::new()
            .timeout(REQUEST_TIMEOUT)
            .redirects(0)
            .user_agent(&format!("terminalx-serve/{}", crate::cloud_bootstrap::VERSION))
            .build();
        Self { origin: origin.to_string(), state_dir: state_dir.to_path_buf(), agent }
    }
}

impl TokenApi for HttpTokenApi {
    fn mint(&self, repository: Option<&str>) -> Result<Minted, MintError> {
        #[derive(Deserialize)]
        struct ErrorBody {
            error: String,
        }
        let credential = match crate::cloud_bootstrap::stored_runtime_credential(&self.state_dir) {
            Ok(Some(credential)) => credential,
            Ok(None) => return Err(MintError::unreachable("GitHub access is not ready in this cloud workspace yet")),
            Err(error) => return Err(MintError::unreachable(format!("read the runtime credential: {error:#}"))),
        };
        let bearer = Zeroizing::new(format!("Bearer {}", credential.as_str()));
        let body = match repository {
            Some(repository) => serde_json::json!({ "v": 1, "repository": repository }),
            None => serde_json::json!({ "v": 1 }),
        };
        let request = self
            .agent
            .post(&format!("{}{TOKEN_PATH}", self.origin))
            .set("authorization", &bearer)
            .set("content-type", "application/json")
            .set(crate::cloud_bootstrap::VERSION_HEADER, crate::cloud_bootstrap::VERSION);
        match request.send_json(body) {
            Ok(response) => response
                .into_json::<Minted>()
                .map_err(|error| MintError { status: Some(200), code: None, detail: format!("unreadable token response: {error}") }),
            Err(ureq::Error::Status(status, response)) => {
                let code = response.into_json::<ErrorBody>().ok().map(|body| body.error).filter(|code| is_code(code));
                Err(MintError { status: Some(status), code, detail: format!("the TerminalX server answered HTTP {status}") })
            }
            // The URL carries no secret; the transport error is safe to show.
            Err(ureq::Error::Transport(error)) => Err(MintError::unreachable(format!("could not reach the TerminalX server: {error}"))),
        }
    }
}

/// An error code is echoed to the terminal, so only a plain identifier is.
fn is_code(code: &str) -> bool {
    !code.is_empty() && code.len() <= 64 && code.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
}

// ------------------------------------------------------------- the cache

/// The cache file for a repository key: a digest, so a name never becomes a
/// path.
fn cache_key(repository: Option<&str>) -> String {
    match repository {
        None => "default".to_string(),
        Some(repository) => {
            let digest = general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(repository.to_ascii_lowercase().as_bytes()));
            format!("repo-{}", &digest[..22])
        }
    }
}

fn read_cached(path: &Path) -> Option<CachedToken> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let bytes = Zeroizing::new(fs::read(path).ok()?);
    let cached: CachedToken = serde_json::from_slice(&bytes).ok()?;
    (cached.v == 1 && valid_token(&cached.token)).then_some(cached)
}

/// A token is written into Git's credential protocol and an environment
/// variable, so nothing that could break a line is accepted.
fn valid_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= 1024 && token.bytes().all(|byte| byte.is_ascii_graphic())
}

/// An exclusive `flock` on `path`, released on drop.
struct KeyLock {
    _file: fs::File,
}

impl KeyLock {
    fn acquire(path: &Path) -> Result<Self> {
        let mut options = fs::OpenOptions::new();
        options.create(true).truncate(false).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options.open(path).with_context(|| format!("open {}", path.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            loop {
                // SAFETY: flock on a descriptor this function owns.
                if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
                    break;
                }
                let error = std::io::Error::last_os_error();
                if error.kind() != std::io::ErrorKind::Interrupted {
                    return Err(anyhow::Error::new(error).context(format!("lock {}", path.display())));
                }
            }
        }
        Ok(Self { _file: file })
    }
}

fn usable(minted: Minted, now_ms: u64) -> Result<Minted, MintError> {
    if minted.v != 1 || !valid_token(&minted.token) || minted.expires_at <= now_ms {
        return Err(MintError { status: Some(200), code: None, detail: "the TerminalX server returned an unusable GitHub token".into() });
    }
    Ok(minted)
}

/// [`resolve_token`] through the cache when there is one; without one (no
/// tmpfs) every request mints, so no token is ever written to disk.
pub fn resolve(cache_dir: Option<&Path>, repository: Option<&str>, api: &dyn TokenApi, now_ms: &dyn Fn() -> u64) -> Result<Zeroizing<String>, MintError> {
    match cache_dir {
        Some(cache_dir) => resolve_token(cache_dir, repository, api, now_ms),
        None => api.mint(repository).and_then(|minted| usable(minted, now_ms())).map(|minted| Zeroizing::new(minted.token.clone())),
    }
}

/// Forget the cached token for `repository`, when Git reports that GitHub
/// rejected it (`erase`).
fn forget(cache_dir: &Path, repository: Option<&str>) {
    let key = cache_key(repository);
    let path = cache_dir.join(format!("{key}.json"));
    if let Ok(_lock) = KeyLock::acquire(&cache_dir.join(format!("{key}.lock"))) {
        let _ = fs::remove_file(path);
    }
}

/// A token for `repository` (or the workspace default): the cached one while
/// more than five minutes of it remain, else a fresh one, minted once however
/// many processes ask at the same time.
pub fn resolve_token(cache_dir: &Path, repository: Option<&str>, api: &dyn TokenApi, now_ms: &dyn Fn() -> u64) -> Result<Zeroizing<String>, MintError> {
    let key = cache_key(repository);
    let path = cache_dir.join(format!("{key}.json"));
    let fresh = |cached: &CachedToken| cached.expires_at > now_ms().saturating_add(REFRESH_MARGIN_MS);
    if let Some(cached) = read_cached(&path).filter(fresh) {
        return Ok(Zeroizing::new(cached.token.clone()));
    }
    crate::cloud_grants::prepare_private_dir(cache_dir).map_err(|error| MintError::unreachable(format!("{error:#}")))?;
    let _lock = KeyLock::acquire(&cache_dir.join(format!("{key}.lock"))).map_err(|error| MintError::unreachable(format!("{error:#}")))?;
    // Another process may have refreshed while this one waited.
    let cached = read_cached(&path);
    if let Some(cached) = cached.as_ref().filter(|cached| fresh(cached)) {
        return Ok(Zeroizing::new(cached.token.clone()));
    }
    match api.mint(repository).and_then(|minted| usable(minted, now_ms())) {
        Ok(minted) => {
            let entry = CachedToken { v: 1, token: minted.token.clone(), expires_at: minted.expires_at };
            let bytes = Zeroizing::new(serde_json::to_vec(&entry).unwrap_or_default());
            // A cache that cannot be written costs a mint next time, nothing
            // more.
            let _ = crate::cloud_grants::write_private(&path, &bytes);
            Ok(Zeroizing::new(minted.token.clone()))
        }
        Err(error) if error.is_outage() => match cached.filter(|cached| cached.expires_at > now_ms()) {
            Some(cached) => Ok(Zeroizing::new(cached.token.clone())),
            None => Err(error),
        },
        Err(error) => {
            // The server said no: do not hand out what it just refused.
            let _ = fs::remove_file(&path);
            Err(error)
        }
    }
}

// ----------------------------------------------------- the credential helper

/// `owner/name` from the path Git passes with `useHttpPath`
/// (`owner/name.git`, or `owner/name.git/info/lfs` for Git LFS).
pub fn repository_from_path(path: &str) -> Option<String> {
    let mut segments = path.trim_matches('/').split('/');
    let owner = segments.next()?;
    let name = segments.next()?;
    let name = name.strip_suffix(".git").unwrap_or(name);
    let allowed = |part: &str| {
        !part.is_empty() && part != "." && part != ".." && part.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    };
    let repository = format!("{owner}/{name}");
    (allowed(owner) && allowed(name) && repository.len() <= MAX_REPOSITORY_LEN).then_some(repository)
}

/// One Git credential request (`get`, `store` or `erase`). Returns the exit
/// code.
pub fn credential(operation: &str, input: &mut dyn BufRead, out: &mut dyn Write, err: &mut dyn Write, cache_dir: Option<&Path>, api: &dyn TokenApi, now_ms: &dyn Fn() -> u64) -> i32 {
    // Git never persists the token: storing is ours to ignore.
    if operation != "get" && operation != "erase" {
        return 0;
    }
    let (mut protocol, mut host, mut path) = (None, None, None);
    let mut line = String::new();
    loop {
        line.clear();
        match input.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(_) => return 1,
        }
        let entry = line.trim_end_matches(['\n', '\r']);
        if entry.is_empty() {
            break;
        }
        if let Some((key, value)) = entry.split_once('=') {
            match key {
                "protocol" => protocol = Some(value.to_string()),
                "host" => host = Some(value.to_string()),
                "path" => path = Some(value.to_string()),
                _ => {}
            }
        }
    }
    // Only github.com over HTTPS; anything else is some other helper's.
    if protocol.as_deref() != Some("https") || !host.as_deref().is_some_and(|host| host.eq_ignore_ascii_case(GITHUB_HOST)) {
        return 0;
    }
    let repository = path.as_deref().and_then(repository_from_path);
    if operation == "erase" {
        // GitHub rejected the token (revoked or uninstalled): the next `get`
        // asks the server again, which then says why.
        if let Some(cache_dir) = cache_dir {
            forget(cache_dir, repository.as_deref());
        }
        return 0;
    }
    match resolve(cache_dir, repository.as_deref(), api, now_ms) {
        Ok(token) => {
            let answer = Zeroizing::new(format!("username={USERNAME}\npassword={}\n", token.as_str()));
            if out.write_all(answer.as_bytes()).and_then(|()| out.flush()).is_err() {
                return 1;
            }
            0
        }
        Err(error) => {
            let _ = writeln!(err, "{}", error.explain(repository.as_deref()));
            1
        }
    }
}

/// `owner/name` of a github.com remote URL: `https://github.com/o/n.git`,
/// `ssh://git@github.com/o/n.git` or `git@github.com:o/n.git`.
pub fn repository_from_remote(remote: &str) -> Option<String> {
    let remote = remote.trim();
    if let Ok(url) = url::Url::parse(remote) {
        return (url.host_str().is_some_and(|host| host.eq_ignore_ascii_case(GITHUB_HOST)) && matches!(url.scheme(), "https" | "ssh" | "git"))
            .then(|| repository_from_path(url.path()))
            .flatten();
    }
    let (user_host, path) = remote.split_once(':')?;
    let host = user_host.rsplit_once('@').map_or(user_host, |(_, host)| host);
    host.eq_ignore_ascii_case(GITHUB_HOST).then(|| repository_from_path(path)).flatten()
}

/// The repository the current directory's `origin` points at, if it is on
/// github.com.
fn origin_repository() -> Option<String> {
    let output = std::process::Command::new("git").args(["remote", "get-url", "origin"]).stderr(std::process::Stdio::null()).output().ok()?;
    if !output.status.success() {
        return None;
    }
    repository_from_remote(&String::from_utf8_lossy(&output.stdout))
}

fn load_config(dir: &Path) -> Result<BrokerConfig> {
    let path = dir.join(CONFIG_FILE);
    let bytes = fs::read(&path).with_context(|| format!("GitHub access is not set up in this cloud workspace (read {})", path.display()))?;
    let config: BrokerConfig = serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    if config.v != 1 {
        bail!("unsupported {} version {}", path.display(), config.v);
    }
    Ok(config)
}

const USAGE: &str = "Usage: terminalx-serve github-auth --dir <dir> credential <get|store|erase>
       terminalx-serve github-auth --dir <dir> token [--repository <owner/name>]";

/// `terminalx-serve github-auth ...`. Returns the exit code.
pub fn run_cli(args: &[String]) -> i32 {
    let mut args = args.iter().map(String::as_str);
    let dir = match (args.next(), args.next()) {
        (Some("--dir"), Some(dir)) if !dir.is_empty() => PathBuf::from(dir),
        _ => {
            eprintln!("{USAGE}");
            return 64;
        }
    };
    let rest: Vec<&str> = args.collect();
    let config = match load_config(&dir) {
        Ok(config) => config,
        Err(error) => {
            eprintln!("terminalx: {error:#}");
            return 1;
        }
    };
    let api = HttpTokenApi::new(&config.origin, &config.state_dir);
    let now = crate::cloud_grants::now_ms;
    match rest.as_slice() {
        ["credential", operation] => {
            let stdin = std::io::stdin();
            let mut input = stdin.lock();
            let stdout = std::io::stdout();
            let mut out = stdout.lock();
            credential(operation, &mut input, &mut out, &mut std::io::stderr(), config.cache_dir.as_deref(), &api, &now)
        }
        ["token"] | ["token", "--repository", _] => {
            let repository = match rest.get(2) {
                Some(value) => match repository_from_path(value) {
                    Some(repository) => Some(repository),
                    None => {
                        eprintln!("terminalx: {value} is not an owner/name repository");
                        return 64;
                    }
                },
                // gh passes no repository: take the one this directory's
                // origin points at, so a workspace spanning installations
                // gets the right one.
                None => origin_repository(),
            };
            let mut resolved = resolve(config.cache_dir.as_deref(), repository.as_deref(), &api, &now);
            // A clone that is not one of the workspace's repositories: gh
            // still gets the workspace default.
            if rest.len() == 1 && repository.is_some() && resolved.as_ref().is_err_and(|error| error.code.as_deref() == Some("github_repository_not_authorized")) {
                resolved = resolve(config.cache_dir.as_deref(), None, &api, &now);
            }
            match resolved {
                Ok(token) => {
                    let mut out = std::io::stdout().lock();
                    if writeln!(out, "{}", token.as_str()).and_then(|()| out.flush()).is_err() {
                        return 1;
                    }
                    0
                }
                Err(error) => {
                    eprintln!("{}", error.explain(repository.as_deref()));
                    1
                }
            }
        }
        _ => {
            eprintln!("{USAGE}");
            64
        }
    }
}

// ------------------------------------------------------------- installation

/// Where [`install`] put things.
#[derive(Debug, Clone)]
pub struct Installed {
    pub dir: PathBuf,
    pub bin_dir: PathBuf,
    /// `None` without tmpfs: no token is cached.
    pub cache_dir: Option<PathBuf>,
    /// The real `gh` the shim runs, if there is one.
    pub gh: Option<PathBuf>,
    /// The value of `credential.https://github.com.helper`.
    pub helper: String,
}

/// Which `git` to configure, and (for tests) which global config file.
#[derive(Debug, Clone, Default)]
pub struct GitTarget {
    pub program: Option<PathBuf>,
    pub global_config: Option<PathBuf>,
}

/// POSIX single quotes around `value`.
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn write_script(path: &Path, body: &str) -> Result<()> {
    crate::cloud_grants::write_private(path, body.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).with_context(|| format!("make {} executable", path.display()))?;
    }
    Ok(())
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.is_file() && path.metadata().is_ok_and(|meta| meta.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

/// The real `gh`: the first one on the inherited `PATH` or in the usual
/// install directories that is not the shim itself.
pub fn find_real_gh(search: impl IntoIterator<Item = PathBuf>, shim_dir: &Path) -> Option<PathBuf> {
    let shim_dir = fs::canonicalize(shim_dir).unwrap_or_else(|_| shim_dir.to_path_buf());
    search.into_iter().filter(|dir| !dir.as_os_str().is_empty()).find_map(|dir| {
        let resolved = fs::canonicalize(&dir).unwrap_or(dir);
        if resolved == shim_dir {
            return None;
        }
        let candidate = resolved.join(GH_SCRIPT);
        is_executable(&candidate).then_some(candidate)
    })
}

fn default_gh_search() -> Vec<PathBuf> {
    let inherited = std::env::var_os("PATH").unwrap_or_default();
    std::env::split_paths(&inherited).chain(crate::binpath::known_dirs()).collect()
}

/// Point Git's `https://github.com` credentials at `helper`, replacing
/// whatever was there. Idempotent: run on every boot.
pub fn configure_git(target: &GitTarget, helper: &str) -> Result<()> {
    let key = |name: &str| format!("{CREDENTIAL_SECTION}.{name}");
    let steps: [Vec<String>; 4] = [
        vec!["--replace-all".into(), key("helper"), String::new()],
        vec!["--add".into(), key("helper"), helper.to_string()],
        vec!["--replace-all".into(), key("useHttpPath"), "true".into()],
        vec!["--replace-all".into(), key("username"), USERNAME.into()],
    ];
    for step in steps {
        let mut command = std::process::Command::new(target.program.as_deref().unwrap_or(Path::new("git")));
        command.arg("config").arg("--global").args(&step);
        if let Some(file) = &target.global_config {
            command.env("GIT_CONFIG_GLOBAL", file);
        }
        let output = command.output().context("run git config")?;
        if !output.status.success() {
            bail!("git config {}: {}", step[1], String::from_utf8_lossy(&output.stderr).trim());
        }
    }
    Ok(())
}

/// Install the helper, the `gh` shim and the Git configuration. `state_dir`
/// is the bootstrap's (it holds the runtime credential); the helper's own
/// files go in `<state_dir>/github-auth`, tokens in `cache_dir` (tmpfs; with
/// none, tokens are not cached at all, so none reaches the disk).
pub fn install(state_dir: &Path, origin: &str, cache_dir: Option<PathBuf>, exe: &Path, gh_search: Vec<PathBuf>, git: &GitTarget) -> Result<Installed> {
    let dir = state_dir.join(DIR_NAME);
    let bin_dir = dir.join(BIN_DIR);
    for private in [Some(&dir), Some(&bin_dir), cache_dir.as_ref()].into_iter().flatten() {
        crate::cloud_grants::prepare_private_dir(private)?;
    }
    // Tokens from before this boot were minted for an older runtime
    // generation and repository selection.
    if let Some(cache_dir) = &cache_dir {
        for entry in fs::read_dir(cache_dir).with_context(|| format!("read {}", cache_dir.display()))?.flatten() {
            if entry.path().extension().is_some_and(|extension| extension == "json") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let config = BrokerConfig { v: 1, origin: origin.to_string(), state_dir: state_dir.to_path_buf(), cache_dir: cache_dir.clone() };
    crate::cloud_grants::write_private(&dir.join(CONFIG_FILE), &serde_json::to_vec_pretty(&config)?)?;

    let exe = exe.to_str().ok_or_else(|| anyhow!("the runtime's path is not UTF-8"))?;
    let dir_str = dir.to_str().ok_or_else(|| anyhow!("{} is not UTF-8", dir.display()))?;
    let helper_path = bin_dir.join(HELPER_SCRIPT);
    write_script(
        &helper_path,
        &format!(
            "#!/bin/sh\n# Written by terminalx-serve on every boot. Git's credential helper for\n# https://github.com; it holds no token.\nexec {} {SUBCOMMAND} --dir {} \"$@\"\n",
            shell_quote(exe),
            shell_quote(dir_str)
        ),
    )?;
    let gh = find_real_gh(gh_search, &bin_dir);
    let bin_str = bin_dir.to_str().ok_or_else(|| anyhow!("{} is not UTF-8", bin_dir.display()))?;
    // The gh found at boot, else whichever is on PATH now (one installed
    // after boot), never this shim.
    let gh_body = format!(
        r#"#!/bin/sh
# Written by terminalx-serve on every boot: runs the real gh with a GitHub
# token for this cloud workspace. `gh auth login` is not needed.
shim={shim}
real={real}
if [ ! -x "$real" ]; then
    real=
    set -f
    IFS=:
    for dir in $PATH; do
        if [ -n "$dir" ] && [ -x "$dir/gh" ] && [ ! "$dir/gh" -ef "$shim" ]; then
            real="$dir/gh"
            break
        fi
    done
    unset IFS
    set +f
fi
if [ -z "$real" ]; then
    echo 'gh: the GitHub CLI is not installed in this cloud workspace' >&2
    exit 127
fi
GH_TOKEN=$({exe} {SUBCOMMAND} --dir {dir} token) || exit 1
export GH_TOKEN
exec "$real" "$@"
"#,
        shim = shell_quote(&format!("{bin_str}/{GH_SCRIPT}")),
        real = shell_quote(&gh.as_ref().map(|real| real.to_string_lossy().into_owned()).unwrap_or_default()),
        exe = shell_quote(exe),
        dir = shell_quote(dir_str),
    );
    write_script(&bin_dir.join(GH_SCRIPT), &gh_body)?;

    let helper_str = helper_path.to_str().ok_or_else(|| anyhow!("{} is not UTF-8", helper_path.display()))?;
    // Git runs an absolute helper through the shell, split on whitespace; a
    // path that needs quoting goes through the `!` form instead.
    let helper = if helper_str.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.')) {
        format!("{helper_str} credential")
    } else {
        format!("!{} credential", shell_quote(helper_str))
    };
    configure_git(git, &helper)?;
    Ok(Installed { dir, bin_dir, cache_dir, gh, helper })
}

/// Install at boot in a cloud workspace, and put the shim first on the
/// `PATH` of everything the runtime spawns. Failing leaves the runtime
/// serving without brokered GitHub access; it is logged, not fatal.
pub fn install_at_boot(state_dir: &Path, origin: &str, workspace_id: &str) {
    let cache_dir = crate::cloud_grants::tmpfs_root(workspace_id).map(|root| root.join(TMPFS_CACHE_DIR));
    let exe = match std::env::current_exe() {
        Ok(exe) => exe,
        Err(error) => {
            log::error!("GitHub access: cannot find the runtime binary: {error}");
            return;
        }
    };
    match install(state_dir, origin, cache_dir, &exe, default_gh_search(), &GitTarget::default()) {
        Ok(installed) => {
            if !crate::binpath::set_priority_dir(&installed.bin_dir) {
                log::warn!("GitHub access: the gh shim could not be put first on PATH");
            }
            match &installed.gh {
                Some(gh) => log::info!(
                    "GitHub access: Git helper `{}` and gh shim installed in {} (real gh at {}, token cache {:?})",
                    installed.helper,
                    installed.dir.display(),
                    gh.display(),
                    installed.cache_dir
                ),
                None => log::warn!(
                    "GitHub access: Git helper `{}` installed in {} (token cache {:?}); no gh CLI found yet",
                    installed.helper,
                    installed.dir.display(),
                    installed.cache_dir
                ),
            }
        }
        Err(error) => log::error!("GitHub access: install the credential helper: {error:#}"),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::io::{BufReader, Read};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    const NOW: u64 = 1_790_000_000_000;
    const MINUTE: u64 = 60_000;

    fn now() -> u64 {
        NOW
    }

    type Answer = Box<dyn FnMut(Option<&str>) -> Result<Minted, MintError> + Send>;

    /// Counts calls and answers with `answer`.
    struct FakeApi {
        calls: AtomicUsize,
        answer: Mutex<Answer>,
        delay: Duration,
        seen: Mutex<Vec<Option<String>>>,
    }

    impl FakeApi {
        fn new(answer: impl FnMut(Option<&str>) -> Result<Minted, MintError> + Send + 'static) -> Self {
            Self { calls: AtomicUsize::new(0), answer: Mutex::new(Box::new(answer)), delay: Duration::ZERO, seen: Mutex::new(Vec::new()) }
        }

        fn minting(token: &'static str, expires_at: u64) -> Self {
            Self::new(move |_| Ok(minted(token, expires_at)))
        }

        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
    }

    impl TokenApi for FakeApi {
        fn mint(&self, repository: Option<&str>) -> Result<Minted, MintError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.seen.lock().unwrap().push(repository.map(str::to_string));
            std::thread::sleep(self.delay);
            (self.answer.lock().unwrap())(repository)
        }
    }

    fn minted(token: &str, expires_at: u64) -> Minted {
        Minted { v: 1, token: token.into(), expires_at }
    }

    fn refused(status: u16, code: &str) -> MintError {
        MintError { status: Some(status), code: Some(code.into()), detail: format!("HTTP {status}") }
    }

    fn seed(cache: &Path, repository: Option<&str>, token: &str, expires_at: u64) {
        crate::cloud_grants::prepare_private_dir(cache).unwrap();
        let entry = CachedToken { v: 1, token: token.into(), expires_at };
        crate::cloud_grants::write_private(&cache.join(format!("{}.json", cache_key(repository))), &serde_json::to_vec(&entry).unwrap()).unwrap();
    }

    fn get(cache: &Path, api: &dyn TokenApi, request: &str) -> (i32, String, String) {
        let (mut out, mut err) = (Vec::new(), Vec::new());
        let code = credential("get", &mut request.as_bytes(), &mut out, &mut err, Some(cache), api, &now);
        (code, String::from_utf8(out).unwrap(), String::from_utf8(err).unwrap())
    }

    #[test]
    fn a_fresh_cached_token_is_reused_without_asking() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), Some("acme/api"), "ghs_cached", NOW + 30 * MINUTE);
        let api = FakeApi::minting("ghs_new", NOW + 60 * MINUTE);
        let token = resolve_token(dir.path(), Some("acme/api"), &api, &now).unwrap();
        assert_eq!(token.as_str(), "ghs_cached");
        // The key is case-insensitive, like GitHub's names.
        assert_eq!(resolve_token(dir.path(), Some("Acme/API"), &api, &now).unwrap().as_str(), "ghs_cached");
        assert_eq!(api.calls(), 0);
    }

    #[test]
    fn a_token_with_under_five_minutes_left_is_refreshed_and_cached() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), Some("acme/api"), "ghs_old", NOW + 4 * MINUTE);
        let api = FakeApi::minting("ghs_new", NOW + 60 * MINUTE);
        assert_eq!(resolve_token(dir.path(), Some("acme/api"), &api, &now).unwrap().as_str(), "ghs_new");
        assert_eq!(resolve_token(dir.path(), Some("acme/api"), &api, &now).unwrap().as_str(), "ghs_new");
        assert_eq!(api.calls(), 1);
        assert_eq!(api.seen.lock().unwrap()[0].as_deref(), Some("acme/api"));
        use std::os::unix::fs::PermissionsExt;
        let file = dir.path().join(format!("{}.json", cache_key(Some("acme/api"))));
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777, 0o700);
        // Each repository key has its own entry.
        resolve_token(dir.path(), None, &api, &now).unwrap();
        assert_eq!(api.calls(), 2);
        assert_eq!(api.seen.lock().unwrap()[1], None);
    }

    #[test]
    fn concurrent_refreshes_mint_once() {
        let dir = tempfile::tempdir().unwrap();
        let mut api = FakeApi::minting("ghs_once", NOW + 60 * MINUTE);
        api.delay = Duration::from_millis(150);
        let api = Arc::new(api);
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let (api, cache) = (api.clone(), dir.path().to_path_buf());
                std::thread::spawn(move || resolve_token(&cache, Some("acme/api"), api.as_ref(), &now).unwrap().to_string())
            })
            .collect();
        for thread in threads {
            assert_eq!(thread.join().unwrap(), "ghs_once");
        }
        assert_eq!(api.calls(), 1);
    }

    #[test]
    fn an_outage_keeps_a_still_valid_token_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), Some("acme/api"), "ghs_still_valid", NOW + 2 * MINUTE);
        for outage in [MintError::unreachable("connection refused"), refused(503, "github_app_unavailable"), MintError { status: Some(502), code: None, detail: "HTTP 502".into() }] {
            let answer = outage.clone();
            let api = FakeApi::new(move |_| Err(answer.clone()));
            assert_eq!(resolve_token(dir.path(), Some("acme/api"), &api, &now).unwrap().as_str(), "ghs_still_valid");
            assert_eq!(api.calls(), 1);
        }
        // An expired one is no help.
        seed(dir.path(), Some("acme/api"), "ghs_expired", NOW - 1);
        let api = FakeApi::new(|_| Err(MintError::unreachable("connection refused")));
        let error = resolve_token(dir.path(), Some("acme/api"), &api, &now).unwrap_err();
        assert!(error.is_outage());
    }

    #[test]
    fn a_refusal_is_not_papered_over_by_the_cache() {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), Some("acme/api"), "ghs_still_valid", NOW + 2 * MINUTE);
        let api = FakeApi::new(|_| Err(refused(409, "github_installation_revoked")));
        assert_eq!(resolve_token(dir.path(), Some("acme/api"), &api, &now).unwrap_err().code.as_deref(), Some("github_installation_revoked"));
        assert!(read_cached(&dir.path().join(format!("{}.json", cache_key(Some("acme/api"))))).is_none());
    }

    #[test]
    fn an_unusable_token_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        for (token, expires_at) in [("", NOW + MINUTE * 60), ("ghs_a\npassword=x", NOW + MINUTE * 60), ("ghs_old", NOW - 1)] {
            let api = FakeApi::minting(Box::leak(token.to_string().into_boxed_str()), expires_at);
            assert!(resolve_token(dir.path(), None, &api, &now).is_err());
        }
    }

    #[test]
    fn get_answers_github_https_with_the_repository_from_the_path() {
        let dir = tempfile::tempdir().unwrap();
        let api = FakeApi::minting("ghs_repo", NOW + 60 * MINUTE);
        let (code, out, err) = get(dir.path(), &api, "protocol=https\nhost=github.com\npath=acme/api.git\n\n");
        assert_eq!((code, err.as_str()), (0, ""));
        assert_eq!(out, "username=x-access-token\npassword=ghs_repo\n");
        // Git LFS asks with a longer path for the same repository.
        get(dir.path(), &api, "protocol=https\nhost=github.com\npath=acme/api.git/info/lfs\n");
        assert_eq!(*api.seen.lock().unwrap(), vec![Some("acme/api".to_string())]);
    }

    #[test]
    fn other_hosts_and_protocols_are_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let api = FakeApi::minting("ghs_x", NOW + 60 * MINUTE);
        for request in [
            "protocol=https\nhost=gitlab.com\npath=acme/api.git\n",
            "protocol=http\nhost=github.com\npath=acme/api.git\n",
            "protocol=https\nhost=github.com.evil.example\n",
            "protocol=https\nhost=api.github.com\n",
            "host=github.com\n",
        ] {
            assert_eq!(get(dir.path(), &api, request), (0, String::new(), String::new()), "{request}");
        }
        assert_eq!(api.calls(), 0);
    }

    #[test]
    fn store_does_nothing_and_erase_only_forgets_the_cached_token() {
        let dir = tempfile::tempdir().unwrap();
        let api = FakeApi::minting("ghs_x", NOW + 60 * MINUTE);
        let input = "protocol=https\nhost=github.com\npath=acme/api.git\nusername=x-access-token\npassword=ghs_x\n";
        let (mut out, mut err) = (Vec::new(), Vec::new());
        assert_eq!(credential("store", &mut input.as_bytes(), &mut out, &mut err, Some(dir.path()), &api, &now), 0);
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);

        // GitHub rejected a cached token: `erase` drops it, so the next
        // `get` asks the server instead of replaying it for an hour.
        seed(dir.path(), Some("acme/api"), "ghs_revoked", NOW + 50 * MINUTE);
        seed(dir.path(), Some("acme/web"), "ghs_other", NOW + 50 * MINUTE);
        assert_eq!(credential("erase", &mut input.as_bytes(), &mut out, &mut err, Some(dir.path()), &api, &now), 0);
        assert!(out.is_empty() && err.is_empty());
        assert_eq!(api.calls(), 0);
        let (_, answer, _) = get(dir.path(), &api, "protocol=https\nhost=github.com\npath=acme/api.git\n");
        assert!(answer.contains("password=ghs_x"), "{answer}");
        assert_eq!(resolve_token(dir.path(), Some("acme/web"), &api, &now).unwrap().as_str(), "ghs_other");
        assert_eq!(api.calls(), 1);
    }

    #[test]
    fn without_a_cache_directory_nothing_is_written_and_every_request_mints() {
        let api = FakeApi::minting("ghs_uncached", NOW + 60 * MINUTE);
        let (mut out, mut err) = (Vec::new(), Vec::new());
        for _ in 0..2 {
            out.clear();
            let code = credential("get", &mut "protocol=https\nhost=github.com\n".as_bytes(), &mut out, &mut err, None, &api, &now);
            assert_eq!((code, String::from_utf8_lossy(&out).contains("password=ghs_uncached")), (0, true));
        }
        assert_eq!(api.calls(), 2);
    }

    #[test]
    fn remote_urls() {
        assert_eq!(repository_from_remote("https://github.com/acme/api.git\n").as_deref(), Some("acme/api"));
        assert_eq!(repository_from_remote("https://GitHub.com/acme/api").as_deref(), Some("acme/api"));
        assert_eq!(repository_from_remote("git@github.com:acme/api.git").as_deref(), Some("acme/api"));
        assert_eq!(repository_from_remote("ssh://git@github.com/acme/api.git").as_deref(), Some("acme/api"));
        assert_eq!(repository_from_remote("https://gitlab.com/acme/api.git"), None);
        assert_eq!(repository_from_remote("http://github.com/acme/api.git"), None);
        assert_eq!(repository_from_remote("/srv/git/api.git"), None);
    }

    #[test]
    fn repository_paths() {
        assert_eq!(repository_from_path("acme/api.git").as_deref(), Some("acme/api"));
        assert_eq!(repository_from_path("/acme/api").as_deref(), Some("acme/api"));
        assert_eq!(repository_from_path("acme/my.repo.git/info/lfs").as_deref(), Some("acme/my.repo"));
        assert_eq!(repository_from_path("acme"), None);
        assert_eq!(repository_from_path("acme/.."), None);
        assert_eq!(repository_from_path("acme/a b.git"), None);
        assert_eq!(repository_from_path(""), None);
    }

    // ------------------------------------------------ over HTTP, for real

    struct Request {
        path: String,
        authorization: Option<String>,
        body: serde_json::Value,
    }

    /// A one-thread HTTP server answering every request with `respond`.
    fn serve(respond: impl Fn(&Request) -> (u16, String) + Send + 'static) -> (String, Arc<Mutex<Vec<Request>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                let path = line.split_whitespace().nth(1).unwrap_or_default().to_string();
                let (mut length, mut authorization) = (0usize, None);
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    let header = header.trim_end();
                    if header.is_empty() {
                        break;
                    }
                    if let Some((name, value)) = header.split_once(':') {
                        match name.to_ascii_lowercase().as_str() {
                            "content-length" => length = value.trim().parse().unwrap(),
                            "authorization" => authorization = Some(value.trim().to_string()),
                            _ => {}
                        }
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let request = Request { path, authorization, body: serde_json::from_slice(&body).unwrap_or_default() };
                let (status, reply) = respond(&request);
                log.lock().unwrap().push(request);
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{reply}",
                    reply.len()
                );
            }
        });
        (origin, seen)
    }

    const CREDENTIAL: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    fn state_with_credential() -> tempfile::TempDir {
        let state = tempfile::tempdir().unwrap();
        let identity = serde_json::json!({
            "v": 1, "workspaceId": "ws_1", "organizationId": "org_1", "relayHostId": "rh_1",
            "tokenSha256": "x", "runtimeCredential": CREDENTIAL,
        });
        fs::write(state.path().join("runtime.json"), identity.to_string()).unwrap();
        state
    }

    #[test]
    fn the_http_api_sends_the_runtime_credential_and_repository() {
        let state = state_with_credential();
        let (origin, seen) = serve(|_| (200, format!(r#"{{"v":1,"token":"ghs_http","expiresAt":{},"source":"github-app","repositories":["acme/api"],"permissions":{{"contents":"write"}}}}"#, NOW + 60 * MINUTE)));
        let api = HttpTokenApi::new(&origin, state.path());
        let minted = api.mint(Some("acme/api")).unwrap();
        assert_eq!(minted.token.as_str(), "ghs_http");
        api.mint(None).unwrap();
        let seen = seen.lock().unwrap();
        assert_eq!(seen[0].path, TOKEN_PATH);
        assert_eq!(seen[0].authorization.as_deref(), Some(format!("Bearer {CREDENTIAL}").as_str()));
        assert_eq!(seen[0].body, serde_json::json!({ "v": 1, "repository": "acme/api" }));
        assert_eq!(seen[1].body, serde_json::json!({ "v": 1 }));
    }

    #[test]
    fn refusals_reach_stderr_with_their_code_and_fail() {
        let state = state_with_credential();
        let cases = [
            (401, "cloud_workspace_bootstrap_invalid", "restart the workspace"),
            (403, "github_repository_not_authorized", "acme/api is not one of this workspace's repositories"),
            (409, "github_access_not_configured", "connect one in TerminalX Settings"),
            (409, "github_installation_revoked", "must reconnect it"),
            (409, "github_installation_suspended", "suspended on GitHub"),
            (409, "github_repository_not_granted", "grant it on GitHub"),
            (503, "github_app_not_configured", "not configured on this TerminalX server"),
        ];
        for (status, code, explanation) in cases {
            let (origin, _) = serve(move |_| (status, format!(r#"{{"error":"{code}"}}"#)));
            let api = HttpTokenApi::new(&origin, state.path());
            let cache = tempfile::tempdir().unwrap();
            let (exit, out, err) = get(cache.path(), &api, "protocol=https\nhost=github.com\npath=acme/api.git\n");
            assert_eq!(exit, 1, "{code}");
            assert_eq!(out, "", "{code}");
            assert!(err.contains(code) && err.contains(explanation), "{code}: {err}");
            assert!(!err.contains(CREDENTIAL));
        }
        // A code that is not an identifier is never echoed.
        let (origin, _) = serve(|_| (409, r#"{"error":"\u001b[31mred"}"#.into()));
        let (_, _, err) = get(tempfile::tempdir().unwrap().path(), &HttpTokenApi::new(&origin, state.path()), "protocol=https\nhost=github.com\n");
        assert!(!err.contains('\u{1b}') && err.contains("HTTP 409"), "{err}");
    }

    #[test]
    fn without_a_runtime_credential_it_says_so() {
        let state = tempfile::tempdir().unwrap();
        let api = HttpTokenApi::new("http://127.0.0.1:9", state.path());
        let (exit, _, err) = get(tempfile::tempdir().unwrap().path(), &api, "protocol=https\nhost=github.com\n");
        assert_eq!(exit, 1);
        assert!(err.contains("not ready"), "{err}");
    }

    // ------------------------------------------------------ installation

    fn git_get_all(config: &Path, key: &str) -> Vec<String> {
        let output = std::process::Command::new("git").args(["config", "--global", "--get-all", key]).env("GIT_CONFIG_GLOBAL", config).output().unwrap();
        String::from_utf8(output.stdout).unwrap().lines().map(str::to_string).collect()
    }

    #[test]
    fn install_is_idempotent_and_replaces_other_helpers() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join("gitconfig");
        // What `gh auth setup-git` or a user's hand would have left.
        fs::write(&config, "[credential \"https://github.com\"]\n\thelper = !/usr/bin/gh auth git-credential\n\thelper = store\n\tusername = someone\n").unwrap();
        let state = home.path().join("state");
        let git = GitTarget { program: None, global_config: Some(config.clone()) };
        let first = install(&state, "http://127.0.0.1:1", None, Path::new("/opt/terminalx/terminalx-serve"), vec![], &git).unwrap();
        let second = install(&state, "http://127.0.0.1:1", None, Path::new("/opt/terminalx/terminalx-serve"), vec![], &git).unwrap();
        assert_eq!(first.helper, second.helper);
        assert_eq!(first.helper, format!("{} credential", first.bin_dir.join(HELPER_SCRIPT).display()));
        assert_eq!(git_get_all(&config, "credential.https://github.com.helper"), vec![String::new(), first.helper.clone()]);
        assert_eq!(git_get_all(&config, "credential.https://github.com.usehttppath"), vec!["true"]);
        assert_eq!(git_get_all(&config, "credential.https://github.com.username"), vec!["x-access-token"]);
        let text = fs::read_to_string(&config).unwrap();
        assert!(!text.contains("ghs_") && !text.contains("store"));
        use std::os::unix::fs::PermissionsExt;
        assert!(first.cache_dir.is_none());
        for path in [&first.dir, &first.bin_dir] {
            assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o700, "{}", path.display());
        }
        let broker: BrokerConfig = serde_json::from_slice(&fs::read(first.dir.join(CONFIG_FILE)).unwrap()).unwrap();
        assert_eq!((broker.origin.as_str(), broker.state_dir.as_path()), ("http://127.0.0.1:1", state.as_path()));
    }

    #[test]
    fn a_path_that_needs_quoting_uses_the_shell_form() {
        let home = tempfile::tempdir().unwrap();
        let config = home.path().join("gitconfig");
        let state = home.path().join("state dir");
        let git = GitTarget { program: None, global_config: Some(config.clone()) };
        let installed = install(&state, "http://127.0.0.1:1", None, Path::new("/opt/terminalx-serve"), vec![], &git).unwrap();
        assert!(installed.helper.starts_with("!'") && installed.helper.ends_with("' credential"), "{}", installed.helper);
    }

    #[test]
    fn boot_empties_the_token_cache() {
        let home = tempfile::tempdir().unwrap();
        let cache = home.path().join("tmpfs");
        seed(&cache, None, "ghs_previous_boot", NOW + 60 * MINUTE);
        let git = GitTarget { program: None, global_config: Some(home.path().join("gitconfig")) };
        install(&home.path().join("state"), "http://127.0.0.1:1", Some(cache.clone()), Path::new("/x"), vec![], &git).unwrap();
        assert!(read_cached(&cache.join("default.json")).is_none());
    }

    /// The `gh` shim puts the helper's token in `GH_TOKEN` and runs the real
    /// `gh`; a stand-in for the runtime binary answers `token`.
    #[test]
    fn the_gh_shim_runs_the_real_gh_with_a_token() {
        let home = tempfile::tempdir().unwrap();
        let real = home.path().join("real-bin");
        fs::create_dir_all(&real).unwrap();
        write_script(&real.join("gh"), "#!/bin/sh\necho \"token=$GH_TOKEN args=$*\"\n").unwrap();
        let exe = home.path().join("fake-serve");
        write_script(&exe, "#!/bin/sh\n[ \"$1 $3 $4\" = \"github-auth $3 token\" ] || exit 9\necho ghs_from_helper\n").unwrap();
        let git = GitTarget { program: None, global_config: Some(home.path().join("gitconfig")) };
        let state = home.path().join("state");
        // The shim's own directory is skipped even when it comes first.
        let bin = state.join(DIR_NAME).join(BIN_DIR);
        let installed = install(&state, "http://127.0.0.1:1", None, &exe, vec![bin, real.clone()], &git).unwrap();
        assert_eq!(installed.gh.as_deref(), Some(fs::canonicalize(&real).unwrap().join("gh").as_path()));
        let output = std::process::Command::new(installed.bin_dir.join("gh")).args(["pr", "list"]).env("GH_TOKEN", "user_set").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "token=ghs_from_helper args=pr list");

        // A helper failure stops gh before it runs.
        write_script(&exe, "#!/bin/sh\necho 'terminalx: no GitHub access' >&2\nexit 1\n").unwrap();
        let output = std::process::Command::new(installed.bin_dir.join("gh")).arg("status").output().unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(output.stdout.is_empty());
    }

    #[test]
    fn without_a_real_gh_the_shim_says_so_until_one_is_installed() {
        let home = tempfile::tempdir().unwrap();
        let git = GitTarget { program: None, global_config: Some(home.path().join("gitconfig")) };
        let exe = home.path().join("fake-serve");
        write_script(&exe, "#!/bin/sh\necho ghs_late\n").unwrap();
        let installed = install(&home.path().join("state"), "http://127.0.0.1:1", None, &exe, vec![], &git).unwrap();
        assert!(installed.gh.is_none());
        let late = home.path().join("late-bin");
        fs::create_dir_all(&late).unwrap();
        let path = |extra: &Path| format!("{}:{}:/usr/bin:/bin", installed.bin_dir.display(), extra.display());
        let output = std::process::Command::new(installed.bin_dir.join("gh")).env("PATH", path(&home.path().join("nothing"))).output().unwrap();
        assert_eq!(output.status.code(), Some(127));
        // Installed after boot: found on PATH, past the shim itself.
        write_script(&late.join("gh"), "#!/bin/sh\necho \"late token=$GH_TOKEN\"\n").unwrap();
        let output = std::process::Command::new(installed.bin_dir.join("gh")).env("PATH", path(&late)).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "late token=ghs_late");
    }

    /// Git runs the installed helper for github.com with the repository path
    /// and uses its answer. The helper script execs the runtime binary; a
    /// stand-in records what Git sent (the real binary is exercised in
    /// `serve/tests/github_auth.rs`).
    #[test]
    fn git_credential_fill_goes_through_the_helper() {
        let home = tempfile::tempdir().unwrap();
        let exe = home.path().join("fake-serve");
        let log = home.path().join("request.txt");
        write_script(&exe, &format!("#!/bin/sh\ncat > {}\nprintf 'username=x-access-token\\npassword=ghs_git\\n'\n", shell_quote(&log.to_string_lossy()))).unwrap();
        let config = home.path().join("gitconfig");
        let git = GitTarget { program: None, global_config: Some(config.clone()) };
        install(&home.path().join("state"), "http://127.0.0.1:1", None, &exe, vec![], &git).unwrap();
        let mut child = std::process::Command::new("git")
            .args(["credential", "fill"])
            .env("GIT_CONFIG_GLOBAL", &config)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(b"url=https://github.com/acme/api.git\n\n").unwrap();
        let output = child.wait_with_output().unwrap();
        let answer = String::from_utf8(output.stdout).unwrap();
        assert!(answer.contains("username=x-access-token") && answer.contains("password=ghs_git"), "{answer}");
        let request = fs::read_to_string(&log).unwrap();
        assert!(request.contains("host=github.com") && request.contains("path=acme/api.git"), "{request}");
    }
}
