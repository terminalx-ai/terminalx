//! The ways to a first local project that need more than a folder picker:
//! cloning a repository to this computer, and making a new empty one.
//!
//! Neither attaches anything. Each ends with a finished directory or with
//! nothing at all, and the caller adds the project only after that, so a
//! clone that failed or was canceled never leaves a project half-attached.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

use crate::cloud_agents::launch::{clone_failure_category, CLONE_BUDGET, LOW_SPEED_LIMIT, LOW_SPEED_TIME};
use crate::git::RunError;

/// Where a clone lands until it is complete, next to its final directory.
const STAGING_PREFIX: &str = ".terminalx-clone-";
/// The reader's repositories are read a page at a time, most recently pushed
/// first, up to this many pages. The rest are reached by pasting a URL.
const REPOSITORY_PAGES: usize = 3;
const REPOSITORY_PAGE_SIZE: usize = 100;
const GITHUB_HOST: &str = "github.com";

/// Why a project was not made, with a code the screen can act on.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
}

impl Failure {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    fn io(what: &str, error: std::io::Error) -> Self {
        Self::new(FAILED, format!("{what}: {error}"))
    }
}

pub const INVALID_SOURCE: &str = "invalid-source";
pub const INVALID_NAME: &str = "invalid-name";
pub const INVALID_DESTINATION: &str = "invalid-destination";
pub const DESTINATION_EXISTS: &str = "destination-exists";
pub const ACCESS_DENIED: &str = "access-denied";
pub const NETWORK: &str = "network";
pub const TIMED_OUT: &str = "timed-out";
pub const DISK_FULL: &str = "disk-full";
pub const CANCELED: &str = "canceled";
pub const FAILED: &str = "failed";

// ------------------------------------------------------------ repositories

#[derive(Debug, Clone, Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GithubRepository {
    pub name_with_owner: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub is_private: bool,
    #[serde(default)]
    pub pushed_at: Option<String>,
}

/// The reader's repositories, or why there is no list. Without a list the
/// URL field still clones with the reader's own Git credentials.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum GithubRepositories {
    #[serde(rename_all = "camelCase")]
    Ready { repositories: Vec<GithubRepository>, truncated: bool },
    /// `gh` is not installed.
    Missing,
    /// `gh` is installed and not signed in to github.com.
    SignedOut,
    Failed { message: String },
}

fn gh_output(args: &[&str]) -> anyhow::Result<std::process::Output> {
    Ok(crate::issues::gh()?.args(args).stdin(std::process::Stdio::null()).output()?)
}

/// A token is stored for github.com. Read from `gh`'s own store, no request made.
fn gh_signed_in() -> bool {
    gh_output(&["auth", "token", "--hostname", GITHUB_HOST]).is_ok_and(|out| out.status.success() && !out.stdout.trim_ascii().is_empty())
}

pub fn parse_repositories(lines: &str) -> Vec<GithubRepository> {
    lines.lines().filter_map(|line| serde_json::from_str::<GithubRepository>(line).ok()).filter(|repository| !repository.name_with_owner.is_empty()).collect()
}

pub fn github_repositories() -> GithubRepositories {
    if crate::binpath::resolve("gh").is_none() {
        return GithubRepositories::Missing;
    }
    if !gh_signed_in() {
        return GithubRepositories::SignedOut;
    }
    // Read together: one page after another keeps the reader waiting several seconds.
    let pages: Vec<Result<Vec<GithubRepository>, String>> = std::thread::scope(|scope| {
        let reads: Vec<_> = (1..=REPOSITORY_PAGES).map(|page| scope.spawn(move || repository_page(page))).collect();
        reads.into_iter().map(|read| read.join().unwrap_or_else(|_| Err("GitHub CLI could not list your repositories.".into()))).collect()
    });
    let mut repositories = Vec::new();
    let mut truncated = false;
    for (index, page) in pages.into_iter().enumerate() {
        match page {
            Ok(found) => {
                let full = found.len() >= REPOSITORY_PAGE_SIZE;
                repositories.extend(found);
                if !full {
                    break;
                }
                truncated = index + 1 == REPOSITORY_PAGES;
            }
            Err(message) if message.contains("gh auth login") || message.contains("HTTP 401") => return GithubRepositories::SignedOut,
            Err(message) if repositories.is_empty() => return GithubRepositories::Failed { message },
            // A later page failing still leaves the pages already read.
            Err(_) => {
                truncated = true;
                break;
            }
        }
    }
    GithubRepositories::Ready { repositories, truncated }
}

fn repository_page(page: usize) -> Result<Vec<GithubRepository>, String> {
    let endpoint = format!("user/repos?per_page={REPOSITORY_PAGE_SIZE}&page={page}&sort=pushed");
    let query = ".[] | {nameWithOwner: .full_name, description, isPrivate: .private, pushedAt: .pushed_at}";
    let out = gh_output(&["api", &endpoint, "--jq", query]).map_err(|error| error.to_string())?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if stderr.is_empty() { "GitHub CLI could not list your repositories.".into() } else { stderr });
    }
    Ok(parse_repositories(&String::from_utf8_lossy(&out.stdout)))
}

// ------------------------------------------------------------------ source

/// What to clone, from what the reader picked or pasted.
#[derive(Debug, Clone, PartialEq)]
pub struct Source {
    pub url: String,
    /// The directory the clone is named after.
    pub name: String,
    /// `owner/name` when the repository is on github.com.
    pub github: Option<String>,
}

fn valid_github_part(part: &str) -> bool {
    !part.is_empty() && part != "." && part != ".." && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn name_from_url(url: &str) -> Option<String> {
    // A URL names its repository in the path, after the host.
    let path = match url.split_once("://") {
        Some((_, rest)) => rest.split_once('/')?.1,
        None => url.split_once(':')?.1,
    };
    let last = path.trim_end_matches('/').rsplit('/').next()?;
    let name = last.strip_suffix(".git").unwrap_or(last);
    valid_directory_name(name).then(|| name.to_string())
}

/// `user@host:path`, the spelling `git clone` takes for SSH.
fn is_scp_like(input: &str) -> bool {
    let Some((host, path)) = input.split_once(':') else { return false };
    !path.is_empty() && !path.starts_with('/') && host.contains('@') && !host.contains('/') && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '@' | '.' | '-' | '_'))
}

/// A URL, or `owner/name` on GitHub. Only transports that fetch are taken:
/// `ext::` and the like run a command, and are not a repository address.
pub fn parse_source(input: &str) -> Result<Source, Failure> {
    let input = input.trim();
    let invalid = || Failure::new(INVALID_SOURCE, "Enter a repository URL, or owner/name for a repository on GitHub.");
    if input.is_empty() || input.starts_with('-') || input.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(invalid());
    }
    if let Some((owner, name)) = input.split_once('/') {
        let name = name.strip_suffix(".git").unwrap_or(name);
        if !input.contains(':') && valid_github_part(owner) && valid_github_part(name) {
            return Ok(Source { url: format!("https://{GITHUB_HOST}/{owner}/{name}.git"), name: name.to_string(), github: Some(format!("{owner}/{name}")) });
        }
    }
    let scheme = input.split_once("://").map(|(scheme, _)| scheme.to_ascii_lowercase());
    let allowed = match scheme.as_deref() {
        Some("https" | "http" | "ssh" | "git" | "file") => true,
        Some(_) => false,
        None => is_scp_like(input),
    };
    if !allowed {
        return Err(invalid());
    }
    let name = name_from_url(input).ok_or_else(invalid)?;
    Ok(Source { url: input.to_string(), name, github: crate::issues::github_repo_from_url(input) })
}

/// Two addresses of one repository: the same GitHub `owner/name`, or the
/// same URL apart from a trailing `.git` or slash.
fn same_repository(a: &str, b: &str) -> bool {
    let github = |url: &str| crate::issues::github_repo_from_url(url).map(|repo| repo.to_ascii_lowercase());
    match (github(a), github(b)) {
        (Some(a), Some(b)) => a == b,
        (None, None) => {
            let plain = |url: &str| url.trim().trim_end_matches('/').trim_end_matches(".git").to_string();
            plain(a) == plain(b)
        }
        _ => false,
    }
}

// ------------------------------------------------------------- destination

fn valid_directory_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 100 && name != "." && name != ".." && !name.starts_with('-') && !name.chars().any(|c| matches!(c, '/' | '\\' | ':' | '\0') || c.is_control())
}

/// `~` and `~/…` are the home directory; anything else has to be absolute.
fn resolve_parent(parent: &str) -> Result<PathBuf, Failure> {
    let parent = parent.trim();
    let path = match parent.strip_prefix('~') {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => dirs::home_dir().map(|home| home.join(rest.trim_start_matches('/'))),
        _ => Some(PathBuf::from(parent)),
    };
    match path {
        Some(path) if path.is_absolute() => Ok(path),
        _ => Err(Failure::new(INVALID_DESTINATION, "Choose the folder to put the project in.")),
    }
}

fn is_empty_dir(path: &Path) -> bool {
    std::fs::read_dir(path).is_ok_and(|mut entries| entries.next().is_none())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StartDefaults {
    /// Where projects are suggested to go: a folder the reader already keeps
    /// code in, else `~/Projects`.
    pub projects_dir: String,
    /// A name for a new project that is free in `projects_dir`.
    pub suggested_name: String,
}

const USUAL_PROJECT_DIRS: [&str; 6] = ["Projects", "projects", "Developer", "code", "Code", "src"];
const NEW_PROJECT_NAME: &str = "my-project";

fn default_projects_dir(home: &Path) -> PathBuf {
    USUAL_PROJECT_DIRS.iter().map(|name| home.join(name)).find(|dir| dir.is_dir()).unwrap_or_else(|| home.join(USUAL_PROJECT_DIRS[0]))
}

fn free_name(parent: &Path) -> String {
    (1..)
        .map(|n| if n == 1 { NEW_PROJECT_NAME.to_string() } else { format!("{NEW_PROJECT_NAME}-{n}") })
        .find(|name| !parent.join(name).exists())
        .expect("an unbounded range")
}

/// The suggestions the dialogs open with. `parent` is the folder the reader
/// used last, when they have one.
pub fn defaults(parent: Option<&str>) -> StartDefaults {
    let home = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
    let dir = parent.and_then(|parent| resolve_parent(parent).ok()).unwrap_or_else(|| default_projects_dir(&home));
    StartDefaults { suggested_name: free_name(&dir), projects_dir: dir.to_string_lossy().into_owned() }
}

// ------------------------------------------------------------------- clone

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloneProgress {
    pub id: String,
    /// What Git is doing (`Receiving objects`), as it names it.
    pub stage: String,
    pub percent: Option<u8>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CloneOutcome {
    pub path: String,
    /// The repository was already cloned there; nothing was fetched.
    pub existing: bool,
}

/// `Receiving objects:  45% (123/456), 1.2 MiB` as a stage and a percentage.
pub fn parse_progress(line: &str) -> Option<(String, Option<u8>)> {
    let line = line.strip_prefix("remote: ").unwrap_or(line);
    let (stage, rest) = line.split_once(':')?;
    let stage = stage.trim();
    if stage.is_empty() || matches!(stage, "fatal" | "error" | "warning" | "hint") || stage.len() > 40 {
        return None;
    }
    let percent = rest.split_once('%').and_then(|(before, _)| before.trim().parse::<u8>().ok()).filter(|percent| *percent <= 100);
    // Only Git's own counters: a server's message has no count.
    (percent.is_some() || rest.trim_start().starts_with(|c: char| c.is_ascii_digit())).then(|| (stage.to_string(), percent))
}

fn clones() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static CLONES: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    CLONES.get_or_init(Default::default)
}

/// Stop the clone started with `id`. Git is killed and what it fetched is removed.
pub fn cancel_clone(id: &str) {
    if let Some(flag) = clones().lock().unwrap().get(id) {
        flag.store(true, Ordering::SeqCst);
    }
}

/// What Git wrote, without the progress it kept when a step finished.
fn failure_detail(stderr: &str) -> String {
    let kept: Vec<&str> = stderr.lines().filter(|line| parse_progress(line).is_none() && !line.starts_with("Cloning into")).collect();
    if kept.is_empty() { stderr.trim().to_string() } else { kept.join("\n") }
}

fn clone_failure(source: &Source, stderr: &str) -> Failure {
    let detail = failure_detail(stderr);
    let unreachable = ["Could not resolve host", "Couldn't resolve host", "Failed to connect", "Connection refused", "Network is unreachable", "Could not connect", "unable to look up", "Temporary failure in name resolution"];
    let what = source.github.as_deref().unwrap_or(&source.url);
    if unreachable.iter().any(|needle| detail.contains(needle)) {
        return Failure::new(NETWORK, format!("Could not reach the server for {what}. Check your connection and try again.\n{detail}"));
    }
    if detail.contains("Permission denied (publickey)") || detail.contains("Host key verification failed") {
        return Failure::new(ACCESS_DENIED, format!("SSH could not sign in to clone {what}. Check your SSH key, or use the repository's HTTPS URL.\n{detail}"));
    }
    match clone_failure_category(&detail) {
        "workspace-disk-full" => Failure::new(DISK_FULL, "There is not enough disk space to clone this repository."),
        "repository-clone-timed-out" => Failure::new(TIMED_OUT, format!("The transfer stalled and was stopped. Check your connection and try again.\n{detail}")),
        "repository-access-denied" => Failure::new(
            ACCESS_DENIED,
            format!("Git could not access {what}. Check that it exists and that you have access to it; for a private repository, sign in with `gh auth login` or set up Git credentials.\n{detail}"),
        ),
        _ => Failure::new(FAILED, detail),
    }
}

/// The address and the extra Git configuration a clone of `source` uses.
/// A GitHub repository goes through `gh` when it is signed in, in the
/// protocol the reader set it to, so a repository picked from the list
/// clones without Git credentials having been set up separately.
fn transport(source: &Source) -> (String, Vec<String>) {
    let Some(repository) = source.github.as_deref() else { return (source.url.clone(), Vec::new()) };
    // Pasted as SSH: the reader said how.
    if !source.url.starts_with("https://") {
        return (source.url.clone(), Vec::new());
    }
    let Some(gh) = crate::binpath::resolve("gh").filter(|_| gh_signed_in()) else { return (source.url.clone(), Vec::new()) };
    let protocol = gh_output(&["config", "get", "git_protocol", "--host", GITHUB_HOST]).map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string()).unwrap_or_default();
    if protocol == "ssh" {
        return (format!("git@{GITHUB_HOST}:{repository}.git"), Vec::new());
    }
    // What `gh auth setup-git` writes, for this one command.
    let key = format!("credential.https://{GITHUB_HOST}.helper");
    let helper = format!("!'{}' auth git-credential", gh.to_string_lossy().replace('\'', "'\\''"));
    (source.url.clone(), vec![format!("{key}="), format!("{key}={helper}")])
}

/// Clone `source` into a directory named after it under `parent`.
///
/// The clone is made next to its place and moved in whole, so one that
/// failed or was canceled leaves nothing behind. A directory that is already
/// a clone of the same repository is returned as it is, for the caller to
/// offer opening; any other directory in the way is never touched.
pub fn clone_repository(id: &str, source: &str, parent: &str, on_progress: impl Fn(CloneProgress) + Send + 'static) -> Result<CloneOutcome, Failure> {
    clone_within(id, source, parent, CLONE_BUDGET, on_progress)
}

fn clone_within(id: &str, source: &str, parent: &str, within: Duration, on_progress: impl Fn(CloneProgress) + Send + 'static) -> Result<CloneOutcome, Failure> {
    let source = parse_source(source)?;
    let parent = resolve_parent(parent)?;
    let path = parent.join(&source.name);
    let shown = path.to_string_lossy().into_owned();
    if path.join(".git").exists() {
        let origin = crate::git::remote_url(&path).unwrap_or_default();
        if same_repository(&origin, &source.url) {
            return Ok(CloneOutcome { path: shown, existing: true });
        }
        return Err(Failure::new(DESTINATION_EXISTS, format!("{shown} already holds a different repository. Choose another folder.")));
    }
    if path.exists() && !is_empty_dir(&path) {
        return Err(Failure::new(DESTINATION_EXISTS, format!("{shown} already exists and is not empty. Choose another folder.")));
    }
    std::fs::create_dir_all(&parent).map_err(|error| Failure::new(INVALID_DESTINATION, format!("Could not create {}: {error}", parent.display())))?;
    let staging = parent.join(format!("{STAGING_PREFIX}{}", source.name));
    if staging.exists() {
        // A leftover is our own, from a clone the app did not outlive.
        std::fs::remove_dir_all(&staging).map_err(|error| Failure::io("Could not clear an unfinished clone", error))?;
    }

    let canceled = Arc::new(AtomicBool::new(false));
    clones().lock().unwrap().insert(id.to_string(), canceled.clone());
    let (url, config) = transport(&source);
    let staging_arg = staging.to_string_lossy().into_owned();
    let mut args = vec!["-c", LOW_SPEED_LIMIT, "-c", LOW_SPEED_TIME];
    for entry in &config {
        args.extend(["-c", entry.as_str()]);
    }
    args.extend(["clone", "--progress", "--", &url, &staging_arg]);
    let progress_id = id.to_string();
    let cloned = crate::git::run_within_reporting(&parent, &args, within, &|| canceled.load(Ordering::SeqCst), move |line| {
        if let Some((stage, percent)) = parse_progress(line) {
            on_progress(CloneProgress { id: progress_id.clone(), stage, percent });
        }
    });
    clones().lock().unwrap().remove(id);

    let finished = match cloned {
        Ok(()) => Ok(()),
        Err(RunError::Stopped) => Err(Failure::new(CANCELED, "The clone was canceled.")),
        Err(RunError::TimedOut) => Err(Failure::new(TIMED_OUT, format!("The clone was not finished after {} minutes and was stopped.", within.as_secs() / 60))),
        Err(RunError::Failed(stderr)) => Err(clone_failure(&source, &stderr)),
        Err(RunError::Spawn(error)) => Err(Failure::new(FAILED, format!("Git could not be started: {error}"))),
    }
    .and_then(|()| {
        if path.exists() {
            std::fs::remove_dir(&path).map_err(|error| Failure::io("Could not use the destination folder", error))?;
        }
        std::fs::rename(&staging, &path).map_err(|error| Failure::io("Could not move the clone into place", error))
    });
    if let Err(failure) = finished {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(failure);
    }
    Ok(CloneOutcome { path: shown, existing: false })
}

// ------------------------------------------------------------- quick start

/// Make `parent/name` a new Git repository with an empty first commit, so
/// worktrees can be cut from it like from any other project. Returns its
/// path. A folder that already holds something is never used.
pub fn create_project(parent: &str, name: &str) -> Result<String, Failure> {
    let name = name.trim();
    if !valid_directory_name(name) {
        return Err(Failure::new(INVALID_NAME, "Enter a folder name for the project, without slashes."));
    }
    let parent = resolve_parent(parent)?;
    let path = parent.join(name);
    let shown = path.to_string_lossy().into_owned();
    let existed = path.exists();
    if existed && !is_empty_dir(&path) {
        return Err(Failure::new(DESTINATION_EXISTS, format!("{shown} already exists. Choose another name.")));
    }
    std::fs::create_dir_all(&path).map_err(|error| Failure::new(INVALID_DESTINATION, format!("Could not create {shown}: {error}")))?;
    if let Err(error) = init_repository(&path) {
        // Only what this call made is removed.
        let _ = if existed { std::fs::remove_dir_all(path.join(".git")) } else { std::fs::remove_dir_all(&path) };
        return Err(Failure::new(FAILED, format!("Could not set up Git in {shown}: {error}")));
    }
    Ok(shown)
}

fn init_repository(path: &Path) -> anyhow::Result<()> {
    crate::git::run(path, &["init", "-q"])?;
    // The first commit only anchors the branch: no hooks, no signing prompt.
    let commit = ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "--no-verify", "-q", "-m", "Start the project"];
    if crate::git::run(path, &commit).is_ok() {
        return Ok(());
    }
    // No Git identity on this computer yet: the commit is the app's.
    let mut args = vec!["-c", "user.name=TerminalX", "-c", "user.email=terminalx@localhost.invalid"];
    args.extend(commit);
    crate::git::run(path, &args).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn remote_with_commit(dir: &Path) -> PathBuf {
        let remote = dir.join("origin").join("widgets");
        std::fs::create_dir_all(&remote).unwrap();
        crate::git::run(&remote, &["init", "-q"]).unwrap();
        std::fs::write(remote.join("README.md"), "widgets\n").unwrap();
        crate::git::run(&remote, &["add", "."]).unwrap();
        crate::git::run(&remote, &["-c", "user.name=T", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "first"]).unwrap();
        remote
    }

    fn file_url(path: &Path) -> String {
        format!("file://{}", path.to_string_lossy())
    }

    #[test]
    fn a_source_is_a_url_or_a_github_shorthand() {
        let short = parse_source(" terminalx-ai/terminalx ").unwrap();
        assert_eq!(short.url, "https://github.com/terminalx-ai/terminalx.git");
        assert_eq!(short.name, "terminalx");
        assert_eq!(short.github.as_deref(), Some("terminalx-ai/terminalx"));

        let https = parse_source("https://github.com/Owner/Repo.git").unwrap();
        assert_eq!((https.name.as_str(), https.github.as_deref()), ("Repo", Some("Owner/Repo")));
        let ssh = parse_source("git@gitlab.com:group/sub/tool.git").unwrap();
        assert_eq!((ssh.name.as_str(), ssh.github), ("tool", None));
        assert_eq!(parse_source("ssh://git@example.com/a/b/").unwrap().name, "b");
    }

    #[test]
    fn a_source_that_would_run_a_command_or_an_option_is_refused() {
        for bad in ["", "   ", "--upload-pack=touch x", "ext::sh -c id", "ext::sh", "fd::3", "repo", "owner/name/extra", "/etc/passwd", "https://github.com/", "a b/c"] {
            assert_eq!(parse_source(bad).unwrap_err().code, INVALID_SOURCE, "{bad:?}");
        }
    }

    #[test]
    fn progress_lines_give_a_stage_and_a_percentage() {
        assert_eq!(parse_progress("Receiving objects:  45% (123/456), 1.20 MiB | 500.00 KiB/s"), Some(("Receiving objects".into(), Some(45))));
        assert_eq!(parse_progress("remote: Counting objects: 100% (10/10), done."), Some(("Counting objects".into(), Some(100))));
        assert_eq!(parse_progress("remote: Enumerating objects: 4521, done."), Some(("Enumerating objects".into(), None)));
        assert_eq!(parse_progress("fatal: repository 'x' not found"), None);
        assert_eq!(parse_progress("Cloning into 'widgets'..."), None);
        assert_eq!(parse_progress("remote: Repository not found."), None);
    }

    #[test]
    fn repositories_are_read_one_per_line() {
        let found = parse_repositories("{\"nameWithOwner\":\"a/b\",\"description\":null,\"isPrivate\":true,\"pushedAt\":\"2026-01-01T00:00:00Z\"}\nnot json\n{\"nameWithOwner\":\"c/d\"}\n");
        assert_eq!(found.len(), 2);
        assert!(found[0].is_private);
        assert_eq!(found[1].name_with_owner, "c/d");
    }

    #[test]
    fn a_clone_lands_whole_and_reports_progress() {
        let dir = tempfile::tempdir().unwrap();
        let remote = remote_with_commit(dir.path());
        let parent = dir.path().join("projects");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let outcome = clone_repository("clone-1", &file_url(&remote), &parent.to_string_lossy(), move |progress| sink.lock().unwrap().push(progress)).unwrap();
        assert!(!outcome.existing);
        assert_eq!(Path::new(&outcome.path), parent.join("widgets"));
        assert!(parent.join("widgets/README.md").exists());
        assert!(!parent.join(".terminalx-clone-widgets").exists());
        assert!(seen.lock().unwrap().iter().all(|progress| progress.id == "clone-1"));
        assert!(clones().lock().unwrap().get("clone-1").is_none());
    }

    #[test]
    fn a_repository_already_cloned_there_is_offered_not_cloned_again() {
        let dir = tempfile::tempdir().unwrap();
        let remote = remote_with_commit(dir.path());
        let parent = dir.path().join("projects").to_string_lossy().into_owned();
        clone_repository("first", &file_url(&remote), &parent, |_| {}).unwrap();
        let again = clone_repository("second", &format!("{}/", file_url(&remote)), &parent, |_| {}).unwrap();
        assert!(again.existing);
    }

    #[test]
    fn a_destination_in_use_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let remote = remote_with_commit(dir.path());
        let parent = dir.path().join("projects");
        std::fs::create_dir_all(parent.join("widgets")).unwrap();
        std::fs::write(parent.join("widgets/notes.txt"), "mine").unwrap();
        let failure = clone_repository("busy", &file_url(&remote), &parent.to_string_lossy(), |_| {}).unwrap_err();
        assert_eq!(failure.code, DESTINATION_EXISTS);
        assert_eq!(std::fs::read_to_string(parent.join("widgets/notes.txt")).unwrap(), "mine");

        // Another repository's checkout under the same name is in the way too.
        let other = dir.path().join("elsewhere");
        std::fs::create_dir_all(other.join("widgets")).unwrap();
        crate::git::run(&other.join("widgets"), &["init", "-q"]).unwrap();
        crate::git::run(&other.join("widgets"), &["remote", "add", "origin", "https://example.com/other/widgets.git"]).unwrap();
        assert_eq!(clone_repository("other", &file_url(&remote), &other.to_string_lossy(), |_| {}).unwrap_err().code, DESTINATION_EXISTS);
    }

    #[test]
    fn a_failed_clone_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("projects");
        let missing = file_url(&dir.path().join("nowhere").join("gone"));
        let failure = clone_repository("missing", &missing, &parent.to_string_lossy(), |_| {}).unwrap_err();
        assert_ne!(failure.code, CANCELED);
        assert!(!failure.message.is_empty());
        assert!(!parent.join("gone").exists());
        assert!(!parent.join(".terminalx-clone-gone").exists());
    }

    #[test]
    fn a_canceled_clone_is_stopped_and_removed() {
        let dir = tempfile::tempdir().unwrap();
        let remote = remote_with_commit(dir.path());
        let parent = dir.path().join("projects");
        // Canceled from the first line Git reports, or by the watcher below.
        let watcher = std::thread::spawn(|| {
            for _ in 0..400 {
                cancel_clone("stop-me");
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        let result = clone_repository("stop-me", &file_url(&remote), &parent.to_string_lossy(), |_| {});
        watcher.join().unwrap();
        // A local clone can finish before the first check; either way nothing is half-made.
        match result {
            Err(failure) => {
                assert_eq!(failure.code, CANCELED);
                assert!(!parent.join("widgets").exists());
            }
            Ok(outcome) => assert!(Path::new(&outcome.path).join(".git").exists()),
        }
        assert!(!parent.join(".terminalx-clone-widgets").exists());
    }

    #[test]
    fn a_clone_past_its_deadline_is_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let remote = remote_with_commit(dir.path());
        let parent = dir.path().join("projects");
        let failure = clone_within("slow", &file_url(&remote), &parent.to_string_lossy(), Duration::ZERO, |_| {}).unwrap_err();
        assert_eq!(failure.code, TIMED_OUT);
        assert!(!parent.join("widgets").exists());
        assert!(!parent.join(".terminalx-clone-widgets").exists());
    }

    #[test]
    fn failures_say_what_went_wrong() {
        let source = parse_source("acme/secret").unwrap();
        assert_eq!(clone_failure(&source, "Cloning into 'x'...\nfatal: unable to access 'https://github.com/acme/secret.git/': Could not resolve host: github.com").code, NETWORK);
        let denied = clone_failure(&source, "remote: Repository not found.\nfatal: repository 'https://github.com/acme/secret.git/' not found");
        assert_eq!(denied.code, ACCESS_DENIED);
        assert!(denied.message.contains("acme/secret"));
        assert_eq!(clone_failure(&source, "fatal: could not read Username for 'https://github.com': terminal prompts disabled").code, ACCESS_DENIED);
        assert_eq!(clone_failure(&source, "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.").code, ACCESS_DENIED);
        assert_eq!(clone_failure(&source, "error: RPC failed; curl 28 Operation too slow. Less than 1000 bytes/sec transferred the last 60 seconds").code, TIMED_OUT);
        assert_eq!(clone_failure(&source, "fatal: write error: No space left on device").code, DISK_FULL);
        assert_eq!(clone_failure(&source, "fatal: something else").code, FAILED);
    }

    #[test]
    fn quick_start_makes_a_repository_worktrees_can_be_cut_from() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("projects");
        let path = create_project(&parent.to_string_lossy(), " first-idea ").unwrap();
        let path = Path::new(&path);
        assert_eq!(path, parent.join("first-idea"));
        assert!(crate::git::is_repo(path));
        assert!(crate::git::head_commit(path).is_some());
        let created = crate::git::create_worktree(path, "try", None).unwrap();
        assert!(Path::new(&created.path).exists());
    }

    #[test]
    fn quick_start_refuses_a_bad_name_or_a_folder_in_use() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().to_string_lossy().into_owned();
        for bad in ["", "  ", "a/b", "..", "-rf"] {
            assert_eq!(create_project(&parent, bad).unwrap_err().code, INVALID_NAME, "{bad:?}");
        }
        std::fs::create_dir_all(dir.path().join("taken")).unwrap();
        std::fs::write(dir.path().join("taken/file"), "x").unwrap();
        assert_eq!(create_project(&parent, "taken").unwrap_err().code, DESTINATION_EXISTS);
        assert!(!dir.path().join("taken/.git").exists());
        assert_eq!(create_project("relative/dir", "ok").unwrap_err().code, INVALID_DESTINATION);
    }

    #[test]
    fn the_suggested_name_is_one_that_is_free() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().to_string_lossy().into_owned();
        assert_eq!(defaults(Some(&parent)).suggested_name, "my-project");
        std::fs::create_dir_all(dir.path().join("my-project")).unwrap();
        let next = defaults(Some(&parent));
        assert_eq!(next.suggested_name, "my-project-2");
        assert_eq!(next.projects_dir, parent);
    }

    #[test]
    fn the_default_folder_is_one_the_reader_already_uses() {
        let home = tempfile::tempdir().unwrap();
        assert_eq!(default_projects_dir(home.path()), home.path().join("Projects"));
        std::fs::create_dir_all(home.path().join("code")).unwrap();
        assert_eq!(default_projects_dir(home.path()).file_name().unwrap().to_string_lossy().to_lowercase(), "code");
    }
}
