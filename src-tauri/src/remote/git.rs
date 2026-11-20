//! `git/1` and the repository half of `lifecycle/1`: the Git repositories of
//! one cloud workspace, as the runtime serves them (PRO-27).
//!
//! - **Repositories.** A workspace is one repository (its root) or several
//!   clones below it (`targetDirectory` of the setup, at most two levels
//!   deep). Every call names its repository with `repo` (workspace-relative,
//!   as `git.repositories` lists it). Leaving it out works only when there is
//!   exactly one; with several the call is refused as `ambiguous_repository`,
//!   never answered for whichever came first.
//! - **Authorship and credentials are separate.** `git.commit` takes the
//!   author (`{ name, email }`) from the client, which is the signed-in
//!   person's Git identity on their desktop; the runtime has none of its own.
//!   Pushing and pull requests authenticate with the workspace's GitHub App
//!   token through the credential helper and `gh` shim (PRO-14,
//!   `cloud_github`), which never appears here.
//! - **Uncertain outcomes are reconciled before anything is repeated.** A push
//!   first asks the remote for the branch head and does nothing when it is
//!   already there; a push that fails in an ambiguous way asks again before
//!   reporting. A pull request is created only when the remote has the
//!   branch at the local head and no open one exists for it, and a failed
//!   create looks for the one it may have made. What still cannot be known is
//!   `outcome_unknown`, and repeating the call is safe.
//! - Pull requests go through `gh` in the repository, so the shim mints a
//!   token for that repository. `TERMINALX_SERVE_GH` replaces the `gh` run
//!   (tests use `scripts/remote-runtime/fake-gh`).

use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::github::conversation::Target;

use super::files::WorkspaceFiles;
use super::protocol::RpcError;

/// At most this many repositories are listed (the disposition contract's bound).
pub const MAX_REPOSITORIES: usize = 20;
const MAX_DEPTH: usize = 2;
const MAX_DIFF_BYTES: usize = 768 * 1024;
/// One side of a file comparison; both fit a relay frame with room to spare.
const MAX_CONTENT_BYTES: usize = 384 * 1024;
const MAX_CHANGED_FILES: usize = 2000;
const MAX_BODY_BYTES: usize = 4096;
const HEADER_DIFF_TIMEOUT: Duration = Duration::from_secs(5);
const LOCAL_TIMEOUT: Duration = Duration::from_secs(60);
const NETWORK_TIMEOUT: Duration = Duration::from_secs(120);
const PR_LOCATOR_TIMEOUT: Duration = Duration::from_secs(8);
const LEGACY_PR_REPO_PREFIX: &str = "pr-association://";
/// Per repository in `lifecycle.dispositionFacts`.
pub const FACTS_TIMEOUT: Duration = Duration::from_secs(2);
const TOO_LARGE: &str = "<file too large to show>";
/// Directories never searched for repositories.
const SKIPPED_DIRS: &[&str] = &["node_modules", "target", "vendor", "dist", "build"];

pub struct WorkspaceGit {
    root: PathBuf,
    files: Arc<WorkspaceFiles>,
    gh: Option<PathBuf>,
    /// A machine's project (`machine/1`): its repositories are its checkout
    /// and its own worktrees, not clones found below a workspace root.
    project: bool,
    #[cfg(test)]
    github_origin_fixture: Option<String>,
}

/// At most this many of a machine project's checkout and worktrees are listed.
pub const MAX_PROJECT_REPOSITORIES: usize = 100;

/// One repository a call was routed to.
struct Repo {
    /// Workspace-relative, `.` for the root.
    name: String,
    dir: PathBuf,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
struct CheckoutIdentity {
    path: PathBuf,
    git_dir: PathBuf,
    directory: DirectoryIdentity,
    admin: DirectoryIdentity,
}

/// A successful create's URL, held until GitHub confirms its branch and commit.
/// Unverified entries never participate in session PR discovery.
#[derive(Clone, Deserialize, Serialize)]
struct PendingPrCreation {
    session: String,
    checkout: CheckoutIdentity,
    branch: String,
    base: String,
    head: String,
    url: String,
}

fn pending_pr_creations<T>(change: impl FnOnce(&mut Vec<PendingPrCreation>) -> (T, bool)) -> Result<T, RpcError> {
    let path = crate::store::root().map_err(RpcError::internal)?.join("pending-machine-pr-creations.json");
    crate::store::transaction::run(&path.with_extension("lock"), Duration::from_secs(30), || {
        let mut pending = crate::store::read_json(&path)?.unwrap_or_default();
        let (result, changed) = change(&mut pending);
        if changed { crate::store::write_json(&path, &pending)?; }
        Ok(result)
    }).map_err(RpcError::internal)
}

pub(crate) fn pending_pr_creation_in(path: &Path) -> Result<Option<String>, RpcError> {
    pending_pr_creations(|entries| (entries.iter().find(|entry| entry.checkout.path == path).map(|entry| entry.url.clone()), false))
}

fn github_repository_from_origin(remote: &str) -> Option<String> {
    let parsed = url::Url::parse(&if remote.contains("://") { remote.to_owned() } else { format!("ssh://{}", remote.replacen(':', "/", 1)) }).ok()?;
    if !matches!(parsed.scheme(), "http" | "https" | "ssh" | "git") || parsed.query().is_some() || parsed.fragment().is_some() { return None; }
    let (owner, name) = parsed.path().trim_matches('/').split_once('/')?;
    let name = name.strip_suffix(".git").unwrap_or(name);
    let valid = |part: &str| !part.is_empty() && !matches!(part, "." | "..")
        && part.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
    if !valid(owner) || !valid(name) { return None; }
    let host = crate::github::hostname_from_remote(remote)?;
    Some(format!("{host}/{owner}/{name}").to_ascii_lowercase())
}

#[cfg(unix)]
type DirectoryIdentity = (u64, u64);
#[cfg(not(unix))]
type DirectoryIdentity = std::time::SystemTime;

fn directory_identity(path: &Path) -> std::io::Result<DirectoryIdentity> {
    let meta = std::fs::metadata(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok((meta.dev(), meta.ino()))
    }
    #[cfg(not(unix))]
    meta.created()
}

/// What one Git or `gh` process did.
pub(super) struct Ran<T = String> {
    pub(super) ok: bool,
    pub(super) stdout: T,
    stderr: String,
    timed_out: bool,
}

impl Ran {
    fn text(&self) -> String {
        // `git push --porcelain` reports a rejected ref on stdout.
        let text = [self.stderr.trim(), self.stdout.trim()].into_iter().filter(|part| !part.is_empty()).collect::<Vec<_>>().join("\n");
        if self.timed_out {
            format!("timed out{}{text}", if text.is_empty() { "" } else { ": " })
        } else {
            text
        }
    }
}

/// How a failed Git or GitHub call failed, for the client to act on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Failure {
    /// The GitHub token was refused or could not be minted.
    Auth,
    /// The remote has work the local branch does not (or a merge conflicts).
    Conflict,
    /// The remote could not be reached: whether it happened is unknown.
    Network,
    Other,
}

fn classify(text: &str, timed_out: bool) -> Failure {
    let lower = text.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|needle| lower.contains(needle));
    if has(&[
        "authentication failed",
        "could not read username",
        "could not read password",
        "invalid username or password",
        "bad credentials",
        "http 401",
        "error: 401",
        "returned error: 403",
        // GitHub answers 404 for a repository the token may not see.
        "returned error: 404",
        "repository not found",
        "permission to",
        "no longer accepts this workspace's runtime credential",
        "github app installation",
        "not one of this workspace's repositories",
        "gh auth login",
    ]) {
        return Failure::Auth;
    }
    if has(&[
        "non-fast-forward",
        "fetch first",
        "[rejected]",
        "remote contains work that you do",
        "not possible to fast-forward",
        "diverging branches",
        "conflict (",
        "merge conflict",
        "fix conflicts",
        "not mergeable",
        // `gh pr merge --match-head-commit` when the head moved.
        "head branch was modified",
        "would be overwritten",
    ]) {
        return Failure::Conflict;
    }
    if timed_out
        || has(&[
            "could not resolve host",
            "connection timed out",
            "operation timed out",
            "connection refused",
            "connection reset",
            "network is unreachable",
            "the remote end hung up",
            "early eof",
            "unable to access",
            "error connecting to",
            "tls handshake",
            "i/o timeout",
            "broken pipe",
        ])
    {
        return Failure::Network;
    }
    Failure::Other
}

fn failure_error(what: &str, text: &str, failure: Failure) -> RpcError {
    match failure {
        Failure::Auth => RpcError::new("auth_failed", format!("{what}: GitHub refused this workspace's credentials: {text}")),
        Failure::Conflict => RpcError::new("conflict", format!("{what}: {text}")),
        Failure::Network => RpcError::new("outcome_unknown", format!("{what}: the remote could not be reached, so whether it happened is unknown; trying again checks first: {text}")),
        Failure::Other => RpcError::new("git_failed", format!("{what}: {text}")),
    }
}

pub(super) fn run_bounded(command: Command, timeout: Duration) -> std::io::Result<Ran> {
    run_bounded_with_stdout(command, timeout, |bytes| String::from_utf8_lossy(&bytes).into_owned())
}

fn run_bounded_with_stdout<T: Default>(mut command: Command, timeout: Duration, decode: impl FnOnce(Vec<u8>) -> T) -> std::io::Result<Ran<T>> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Its own group, so a timeout also ends `git-remote-https` and `ssh`.
        command.process_group(0);
    }
    let mut child = command.spawn()?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut buffer = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut buffer);
            }
            let _ = sender.send(buffer);
        });
        receiver
    };
    let stdout = drain(child.stdout.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let stderr = drain(child.stderr.take().map(|pipe| Box::new(pipe) as Box<dyn Read + Send>));
    let deadline = Instant::now() + timeout;
    // A grandchild (an SSH master, a helper's daemon) can keep the pipes open
    // after the child exits: its output is waited for only until the deadline.
    let collect = |receiver: std::sync::mpsc::Receiver<Vec<u8>>| {
        receiver.recv_timeout(deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(50))).unwrap_or_default()
    };
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break Some(status);
        }
        if Instant::now() >= deadline {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    match status {
        Some(status) => Ok(Ran {
            ok: status.success(),
            stdout: decode(collect(stdout)),
            stderr: String::from_utf8_lossy(&collect(stderr)).into_owned(),
            timed_out: false,
        }),
        // A grandchild may still hold the pipes; the readers finish on their own.
        None => Ok(Ran { ok: false, stdout: T::default(), stderr: String::new(), timed_out: true }),
    }
}

fn read_commit_config(mut command: Command) -> Result<Vec<u8>, RpcError> {
    command.env_remove("GIT_CONFIG").args(["config", "--includes", "--null", "--show-scope", "--list"]);
    let result = run_bounded_with_stdout(command, LOCAL_TIMEOUT, std::convert::identity).map_err(RpcError::internal)?;
    if !result.ok {
        let detail = if result.timed_out { "timed out" } else { result.stderr.trim() };
        return Err(failure_error("read checkout config", detail, Failure::Other));
    }
    Ok(result.stdout)
}

type ConfigEntry<'a> = (&'a [u8], &'a [u8]);

fn config_entries(listing: &[u8]) -> Result<Vec<ConfigEntry<'_>>, RpcError> {
    let mut fields = listing.split_inclusive(|&byte| byte == 0);
    let mut entries = Vec::new();
    while let Some(scope) = fields.next() {
        let entry = fields.next().and_then(|field| field.strip_suffix(b"\0"))
            .ok_or_else(|| RpcError::internal("Invalid Git config listing"))?;
        let key = entry.split(|&byte| byte == b'\n').next().unwrap_or_default();
        // Apple Git reads its bundled defaults separately from GIT_CONFIG_SYSTEM.
        if scope == b"unknown\0" {
            continue;
        }
        // Git followed these directives in their original locations already.
        if key != b"include.path" && !(key.starts_with(b"includeif.") && key.ends_with(b".path")) {
            entries.push((scope, entry));
        }
    }
    Ok(entries)
}

fn append_config_entry(config: &mut Vec<u8>, entry: &[u8]) -> Result<(), RpcError> {
    let invalid = || RpcError::internal("Invalid Git config entry");
    let mut parts = entry.splitn(2, |&byte| byte == b'\n');
    let key = parts.next().ok_or_else(invalid)?;
    let value = parts.next();
    let first_dot = key.iter().position(|&byte| byte == b'.').ok_or_else(invalid)?;
    let last_dot = key.iter().rposition(|&byte| byte == b'.').ok_or_else(invalid)?;
    config.push(b'[');
    config.extend_from_slice(&key[..first_dot]);
    if first_dot != last_dot {
        config.extend_from_slice(b" \"");
        for &byte in &key[first_dot + 1..last_dot] {
            if matches!(byte, b'"' | b'\\') {
                config.push(b'\\');
            }
            config.push(byte);
        }
        config.push(b'"');
    }
    config.extend_from_slice(b"]\n\t");
    config.extend_from_slice(&key[last_dot + 1..]);
    if let Some(value) = value {
        config.extend_from_slice(b" = \"");
        for &byte in value {
            match byte {
                b'\n' => config.extend_from_slice(b"\\n"),
                b'\t' => config.extend_from_slice(b"\\t"),
                8 => config.extend_from_slice(b"\\b"),
                b'"' | b'\\' => config.extend_from_slice(&[b'\\', byte]),
                _ => config.push(byte),
            }
        }
        config.push(b'"');
    }
    config.push(b'\n');
    Ok(())
}

/// Resolve includes in the real checkout and replay each Git scope in order.
/// Git's protected-config reader has no repository context, so entries that
/// require one must still be conditional in the private config.
fn snapshot_commit_config(checkout_git: impl Fn() -> Command, scratch: &Path, object_format: &str, include_worktree: bool) -> Result<(), RpcError> {
    let live = read_commit_config(checkout_git())?;
    // An explicit, absent GIT_DIR makes git config read only non-repo scopes.
    let mut outside = checkout_git();
    outside.env("GIT_DIR", scratch.join("no-repository")).env_remove("GIT_COMMON_DIR");
    let outside = read_commit_config(outside)?;
    let entries = config_entries(&live)?;
    let mut protected = config_entries(&outside)?.into_iter()
        .filter(|(scope, _)| matches!(*scope, b"system\0" | b"global\0" | b"command\0")).peekable();

    for (scope, file, is_protected) in [
        (b"system\0".as_slice(), "config.system", true),
        (b"global\0", "config.global", true),
        (b"local\0", "repo/config.local", false),
        (b"worktree\0", "repo/config.worktree-values", false),
        (b"command\0", "config.command", true),
    ] {
        let mut config = Vec::new();
        let mut conditional = Vec::new();
        let mut include_number = 0;
        let mut flush_conditional = |config: &mut Vec<u8>, conditional: &mut Vec<u8>| -> Result<(), RpcError> {
            if !conditional.is_empty() {
                let path = format!("{file}.{}", include_number);
                include_number += 1;
                std::fs::write(scratch.join(&path), std::mem::take(conditional)).map_err(RpcError::internal)?;
                config.extend_from_slice(format!("[includeIf \"gitdir:./repo\"]\n\tpath = {path}\n").as_bytes());
            }
            Ok(())
        };
        for &(_, entry) in entries.iter().filter(|&&(entry_scope, _)| entry_scope == scope) {
            if is_protected && protected.next_if_eq(&(scope, entry)).is_none() {
                append_config_entry(&mut conditional, entry)?;
            } else {
                flush_conditional(&mut config, &mut conditional)?;
                append_config_entry(&mut config, entry)?;
            }
        }
        flush_conditional(&mut config, &mut conditional)?;
        std::fs::write(scratch.join(file), config).map_err(RpcError::internal)?;
    }
    if protected.next().is_some() {
        return Err(RpcError::internal("Git configuration changed while preparing the commit"));
    }

    // Keep the private repository format independent of the live ref backend.
    // Git reads these top-level files without includes when discovering the format.
    let worktree_config = if include_worktree {
        "\tworktreeConfig = true\n"
    } else {
        ""
    };
    let config = format!(
        "[core]\n\trepositoryFormatVersion = 1\n[extensions]\n\tobjectFormat = {object_format}\n{worktree_config}[include]\n\tpath = config.local\n"
    );
    std::fs::write(scratch.join("repo/config"), config).map_err(RpcError::internal)?;
    std::fs::write(scratch.join("repo/config.worktree"), "[include]\n\tpath = config.worktree-values\n").map_err(RpcError::internal)?;
    Ok(())
}

fn bounded_branch_output(mut command: Command, args: &[&str], deadline: Instant) -> Result<Ran, RpcError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(RpcError::new("timeout", "Reading the branch comparison took too long."));
    }
    command.args(args);
    let output = run_bounded(command, remaining).map_err(RpcError::internal)?;
    if output.timed_out || Instant::now() >= deadline {
        return Err(RpcError::new("timeout", "Reading the branch comparison took too long."));
    }
    Ok(output)
}

fn bounded_branch_git(command: Command, args: &[&str], deadline: Instant) -> Result<String, RpcError> {
    let output = bounded_branch_output(command, args, deadline)?;
    if !output.ok {
        return Err(failure_error("git branch comparison", &output.text(), Failure::Other));
    }
    Ok(output.stdout)
}

fn comparison_refs(cwd: &Path, base: &str, deadline: Instant) -> Result<Option<(String, String)>, RpcError> {
    let resolve = |reference: &str| {
        let args = ["rev-parse", "--verify", "--quiet", "--end-of-options", reference];
        let output = bounded_branch_output(git_command(cwd), &args, deadline)?;
        if output.ok {
            Ok(Some(output.stdout.trim().to_string()))
        } else if output.stderr.is_empty() {
            Ok(None)
        } else {
            Err(failure_error("git branch comparison", &output.text(), Failure::Other))
        }
    };
    let Some(head) = resolve("HEAD^{commit}")? else { return Ok(None) };
    let remote = format!("refs/remotes/origin/{base}^{{commit}}");
    let local = format!("refs/heads/{base}^{{commit}}");
    let target = match resolve(&remote)? {
        Some(target) => target,
        None => resolve(&local)?.ok_or_else(|| RpcError::new("base_not_found", format!("The branch {base} could not be found.")))?,
    };
    Ok(Some((head, target)))
}

/// Compare the worktree to the merge base using an intent-to-add index so
/// untracked contents are never written as objects.
fn branch_diff_size(cwd: &Path, base: &str, deadline: Instant) -> Result<Value, RpcError> {
    let run = |command, args: &[&str]| bounded_branch_git(command, args, deadline);
    let read = |args: &[&str]| run(git_command(cwd), args);
    let (head, base_commit) = match comparison_refs(cwd, base, deadline)? {
        Some((head, target)) => {
            let merge_base = read(&["merge-base", &head, &target])?;
            (Some(head), merge_base)
        }
        None => (None, read(&["hash-object", "-t", "tree", "--stdin"])?),
    };

    let mut scratch = tempfile::Builder::new();
    scratch.prefix("terminalx-git-diff-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        scratch.permissions(std::fs::Permissions::from_mode(0o700));
    }
    let scratch = scratch.tempdir().map_err(RpcError::internal)?;
    let index = scratch.path().join("index");
    let current_index = read(&["rev-parse", "--path-format=absolute", "--git-path", "index"])?;
    let current_index = Path::new(current_index.strip_suffix('\n').unwrap_or(&current_index));
    if current_index.exists() {
        std::fs::copy(current_index, &index).map_err(RpcError::internal)?;
    }
    let objects = scratch.path().join("objects");
    std::fs::create_dir_all(objects.join("info")).map_err(RpcError::internal)?;
    let alternate = read(&["rev-parse", "--path-format=absolute", "--git-path", "objects"])?;
    let alternate = alternate.strip_suffix('\n').unwrap_or(&alternate);
    if alternate.contains(['\r', '\n']) {
        return Err(RpcError::invalid("Git object directory contains a line break"));
    }
    std::fs::write(objects.join("info/alternates"), format!("{alternate}\n")).map_err(RpcError::internal)?;
    // A clean filter can write outside Git's object directory (for example,
    // Git LFS). Do not run filters, index hooks or fsmonitor during polling.
    let config = read(&["config", "--null", "--name-only", "--list"])?;
    let filters: std::collections::BTreeSet<_> = config.split('\0')
        .filter_map(|key| key.strip_prefix("filter.")?.rsplit_once('.').map(|(name, _)| name))
        .collect();
    let hooks = format!("core.hooksPath={}", scratch.path().join("hooks").display());
    let command = || {
        let mut command = git_command(cwd);
        command.env("GIT_INDEX_FILE", &index).env("GIT_OBJECT_DIRECTORY", &objects)
            .args(["-c", &hooks, "-c", "core.splitIndex=false", "-c", "core.fsmonitor=false"]);
        for filter in &filters {
            for setting in ["clean=", "process=", "required=false"] {
                command.args(["-c", &format!("filter.{filter}.{setting}")]);
            }
        }
        command
    };
    run(command(), &["add", "--intent-to-add", "-A", "--", "."])?;
    let output = run(command(), &["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-M", base_commit.trim(), "--"])?;
    let (mut additions, mut deletions) = (0, 0);
    for line in output.lines() {
        let mut fields = line.splitn(3, '\t');
        match (fields.next(), fields.next()) {
            (Some("-"), Some("-")) => {}
            (Some(added), Some(deleted)) => {
                additions += added.parse::<u64>().map_err(RpcError::internal)?;
                deletions += deleted.parse::<u64>().map_err(RpcError::internal)?;
            }
            _ => return Err(RpcError::internal("Malformed Git diff statistics")),
        }
    }
    Ok(json!({ "additions": additions, "deletions": deletions, "head": head }))
}

/// Only app-owned network operations use this boundary. Local Git inspection,
/// edits and the agent process runner keep their existing execution paths.
enum Network { Git, Github }

fn run_network(command: Command, timeout: Duration, kind: Network) -> Result<Ran, RpcError> {
    let ticket = crate::github_process::ticket();
    let (what, output) = match kind {
        Network::Git => ("git", crate::github_process::git_output_admitted(command, timeout, ticket.clone())),
        Network::Github => ("gh", crate::github_process::output_admitted(command, timeout, None, ticket.clone())),
    };
    let out = match output {
        Ok(out) => out,
        Err(_) if !ticket.valid() => return Err(RpcError::forbidden(crate::data_privacy::MESSAGE)),
        // Keep uncertain outcomes eligible for the caller's existing read-back
        // reconciliation, under the same ticket. Revocation never gets here.
        Err(error) if error.is::<crate::github_process::TimedOut>() =>
            return Ok(Ran { ok: false, stdout: String::new(), stderr: String::new(), timed_out: true }),
        Err(error) => return Err(failure_error(what, &error.to_string(), classify(&error.to_string(), false))),
    };
    Ok(Ran { ok: out.status.success(), stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(), timed_out: false })
}

pub(super) fn git_command(dir: &Path) -> Command {
    let mut command = Command::new(crate::binpath::resolve("git").unwrap_or_else(|| PathBuf::from("git")));
    command
        .current_dir(dir)
        .env("PATH", crate::binpath::login_path())
        .env("GIT_TERMINAL_PROMPT", "0")
        // A read-only diff/status call must not demand-fetch promised objects.
        // Explicit network verbs still go through run_network.
        .env("GIT_NO_LAZY_FETCH", "1")
        // Paths are file names, never pathspec magic such as `:(top)` or `:!x`.
        .env("GIT_LITERAL_PATHSPECS", "1")
        .env("LC_ALL", "C");
    command
}

/// `origin` without credentials that someone may have written into it.
fn display_remote(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut parsed) if parsed.password().is_some() || !parsed.username().is_empty() => {
            let _ = parsed.set_username("");
            let _ = parsed.set_password(None);
            parsed.to_string()
        }
        _ => url.to_string(),
    }
}

/// A branch name as `git check-ref-format --branch` accepts it (so `fix#1`,
/// `user+topic` and non-ASCII names pass), and never an option.
pub fn valid_ref_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.starts_with('-')
        && !name.starts_with('/')
        && !name.starts_with('.')
        && !name.ends_with('/')
        && !name.ends_with('.')
        && !name.ends_with(".lock")
        && !name.contains("..")
        && !name.contains("//")
        && !name.contains("/.")
        && !name.contains("@{")
        && name != "@"
        && !name.chars().any(|c| c.is_control() || c.is_whitespace() || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\'))
}

fn valid_object_id(value: &str) -> bool {
    (7..=64).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn required_str<'a>(params: &'a Value, name: &str) -> Result<&'a str, RpcError> {
    params.get(name).and_then(Value::as_str).ok_or_else(|| RpcError::invalid(format!("{name} is required")))
}

fn optional_ref<'a>(params: &'a Value, name: &str) -> Result<Option<&'a str>, RpcError> {
    match params.get(name) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if valid_ref_name(value) => Ok(Some(value)),
        Some(_) => Err(RpcError::invalid(format!("{name} is not a valid branch name"))),
    }
}

/// The desktop user's Git identity, for authorship only.
#[derive(Deserialize)]
struct Author {
    name: String,
    email: String,
}

impl Author {
    fn check(&self) -> Result<(), RpcError> {
        let clean = |value: &str| !value.chars().any(|c| c.is_control() || c == '<' || c == '>');
        let name = self.name.trim();
        let email = self.email.trim();
        if name.is_empty() || name.len() > 200 || !clean(name) {
            return Err(RpcError::invalid("author.name must be a name"));
        }
        if email.len() < 3 || email.len() > 254 || !email.contains('@') || email.contains(char::is_whitespace) || !clean(email) {
            return Err(RpcError::invalid("author.email must be an email address"));
        }
        Ok(())
    }
}

fn truncate_text(text: &mut String, max: usize) -> bool {
    if text.len() <= max {
        return false;
    }
    let mut cut = max;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
    true
}

impl WorkspaceGit {
    /// `files` resolves working-tree paths with the same containment rules as `fs/1`.
    pub fn new(root: PathBuf, files: Arc<WorkspaceFiles>) -> Self {
        Self { root, files, gh: std::env::var_os("TERMINALX_SERVE_GH").map(PathBuf::from), project: false,
            #[cfg(test)] github_origin_fixture: None }
    }

    /// The Git of one of a machine's projects (`machine/1`). `repo` names its
    /// checkout (`.`) or one of its worktrees: relative to the project's
    /// folder, or absolute for one outside it (docs/MACHINES.md, Project scoping).
    pub fn for_project(root: PathBuf, files: Arc<WorkspaceFiles>) -> Self {
        Self { project: true, ..Self::new(root, files) }
    }

    #[cfg(test)]
    pub fn set_gh(&mut self, gh: PathBuf) {
        self.gh = Some(gh);
    }

    #[cfg(test)]
    pub fn handle(&self, method: &str, params: &Value) -> Option<Result<Value, RpcError>> {
        self.handle_negotiated(method, params, true)
    }

    /// Answer a `git.*` method; `None` for any other.
    pub(super) fn handle_negotiated(&self, method: &str, params: &Value, url_targets: bool) -> Option<Result<Value, RpcError>> {
        let _request = crate::github_process::scope();
        if !url_targets && params.get("url").is_some() && params.get("number").is_none() && matches!(method, "git.prs" | "git.prReady" | "git.prMerge") {
            return Some(Err(RpcError::new("capability_not_granted", "Pull request URL targeting was not negotiated.")));
        }
        let bound;
        let params = if let Some(locator) = params["repo"].as_str().and_then(|repo| repo.strip_prefix(LEGACY_PR_REPO_PREFIX)) {
            bound = match self.bind_legacy_pr_repo(method, params, locator) {
                Ok(value) => value,
                Err(error) => return Some(Err(error)),
            };
            &bound
        } else {
            params
        };
        let result = match method {
            "git.repositories" => Ok(self.list(params)),
            "git.status" => self.status(params),
            "git.branchBase" => self.branch_base(params),
            "git.branchDiffSize" => self.branch_diff_size(params),
            "git.diff" => self.diff(params),
            "git.workingChanges" => self.working_changes(params),
            "git.reviewRange" => self.review_range(params),
            "git.changesBetween" => self.changes_between(params),
            "git.fileContents" => self.file_contents(params),
            "git.mediaContent" => self.media_content(params),
            "git.log" => self.log(params),
            "git.branches" => self.branches(params),
            "git.checkout" => self.checkout(params),
            "git.stage" => self.paths(params, &["add", "-A", "--"]),
            "git.unstage" => self.unstage(params),
            "git.commit" => self.commit(params, false),
            "git.commitForPush" => self.commit(params, true),
            "git.fetch" => self.fetch(params),
            "git.push" => self.push(params),
            "git.pushHead" if params.get("head").is_some() && params.get("branch").and_then(Value::as_str).is_some_and(valid_ref_name) => self.push(params),
            "git.pushHead" => Err(RpcError::invalid("branch and head are required")),
            "git.pull" => self.pull(params),
            "git.prs" => self.prs(params),
            "git.prConversation" | "git.prConversationAction" | "git.prReviewerSearch" => self.pr_conversation(method, params),
            "git.prAssociations" => self.pr_associations(params, url_targets),
            "git.prLinkBranch" => self.pr_link_branch(params),
            "git.prUnlink" => self.pr_unlink(params),
            "git.prLanded" => self.pr_landed(params),
            "git.prCreate" | "git.prCreateForSession" => self.pr_create(params, method == "git.prCreateForSession"),
            "git.prReconcileCreation" => self.pr_reconcile_creation(params),
            "git.prReady" => self.pr_ready(params),
            "git.prMerge" => self.pr_merge(params),
            _ => return None,
        };
        Some(result)
    }

    fn bind_legacy_pr_repo(&self, method: &str, params: &Value, locator: &str) -> Result<Value, RpcError> {
        if !self.project || !matches!(method, "git.prs" | "git.prReady" | "git.prMerge" | "git.prConversation" | "git.prConversationAction" | "git.prReviewerSearch") {
            return Err(RpcError::invalid("This repository locator is only for machine pull requests."));
        }
        let (checkout, url): (String, String) = serde_json::from_str(locator).map_err(|_| RpcError::invalid("Invalid pull request repository locator."))?;
        let target = Target::new(&url).map_err(|error| RpcError::invalid(error.to_string()))?;
        if checkout.is_empty() {
            return Err(RpcError::invalid("Invalid legacy pull request repository locator."));
        }
        target.require_exact_cli_host().map_err(|error| RpcError::invalid(error.to_string()))?;
        if params.get("url").is_some()
            && params["url"].as_str().and_then(|url| crate::pr_associations::identity(url).ok()).as_deref() != Some(&target.url)
        {
            return Err(RpcError::invalid("The pull request does not match its repository locator."));
        }
        let mut bound = params.clone();
        bound["repo"] = json!(checkout);
        bound["url"] = json!(target.url);
        Ok(bound)
    }

    // ---- repositories ----------------------------------------------------

    /// Workspace-relative repository directories, including nested checkouts
    /// beside an older blank root. Symlinks, hidden and build directories are skipped.
    pub fn repositories(&self) -> (Vec<String>, bool) {
        if self.project {
            return self.listed_project_repositories(None);
        }
        // The root itself, or a directory inside a checkout (a package of a
        // monorepo as the target directory, development runtimes).
        let mut found = if self.root.join(".git").exists() || crate::git::is_repo(&self.root) { vec![".".into()] } else { Vec::new() };
        let mut truncated = false;
        let mut frontier = vec![(self.root.clone(), 0usize)];
        while let Some((dir, depth)) = frontier.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            let mut children: Vec<_> = entries.filter_map(Result::ok).collect();
            children.sort_by_key(|entry| entry.file_name());
            for entry in children {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') || SKIPPED_DIRS.contains(&name.as_str()) {
                    continue;
                }
                let Ok(kind) = entry.file_type() else { continue };
                if !kind.is_dir() {
                    continue;
                }
                let path = entry.path();
                if path.join(".git").exists() {
                    if found.len() >= MAX_REPOSITORIES {
                        truncated = true;
                        continue;
                    }
                    found.push(path.strip_prefix(&self.root).unwrap_or(&path).to_string_lossy().into_owned());
                } else if depth + 1 < MAX_DEPTH {
                    frontier.push((path, depth + 1));
                }
            }
        }
        found.sort();
        (found, truncated)
    }

    /// A machine project: its checkout, then each of its worktrees. The ones
    /// outside its folder are also the only absolute paths `fs/1` takes for it.
    fn project_repositories(&self) -> Vec<String> {
        let worktrees = super::machine::worktrees(&self.root);
        let mut found = vec![".".to_string()];
        found.extend(worktrees.iter().map(|worktree| self.files.relative(&worktree.path)));
        self.files.set_worktrees(worktrees);
        if !self.project_has_git() {
            return Vec::new();
        }
        found
    }

    pub(super) fn project_has_git(&self) -> bool {
        super::machine::owns_git_checkout(&self.root)
    }

    fn limit_project_repositories(mut found: Vec<String>, preferred: Option<&str>) -> (Vec<String>, bool) {
        let truncated = found.len() > MAX_PROJECT_REPOSITORIES;
        if let Some(index) = preferred.and_then(|preferred| found.iter().position(|name| name == preferred)) {
            if truncated && index >= MAX_PROJECT_REPOSITORIES {
                found.swap(index, MAX_PROJECT_REPOSITORIES - 1);
            }
        }
        found.truncate(MAX_PROJECT_REPOSITORIES);
        (found, truncated)
    }

    /// Git configuration can redirect a registered worktree's working
    /// directory. Verify the effective checkout before using it for Git.
    fn verified_machine_repo(&self, name: &str) -> bool {
        !self.project || crate::git::is_own_worktree(&self.dir(name))
    }

    fn listed_project_repositories(&self, preferred: Option<&str>) -> (Vec<String>, bool) {
        let (mut names, truncated) = Self::limit_project_repositories(self.project_repositories(), preferred);
        names.retain(|name| self.verified_machine_repo(name));
        (names, truncated)
    }

    fn list(&self, params: &Value) -> Value {
        let (names, truncated) = if self.project {
            self.listed_project_repositories(params["preferredRepo"].as_str())
        } else {
            self.repositories()
        };
        let repositories: Vec<Value> = names
            .iter()
            .map(|name| {
                let dir = self.dir(name);
                json!({
                    "repo": name,
                    "branch": crate::git::current_branch(&dir),
                    "head": crate::git::head_commit(&dir),
                    "remote": crate::git::remote_url(&dir).map(|url| display_remote(&url)),
                    "defaultBranch": crate::git::default_branch(&dir),
                })
            })
            .collect();
        json!({ "repositories": repositories, "truncated": truncated })
    }

    fn dir(&self, name: &str) -> PathBuf {
        if name == "." {
            self.root.clone()
        } else {
            // Absolute only for a machine project's worktree outside its
            // folder, which `repositories` listed so.
            self.root.join(name)
        }
    }

    /// The repository a call names, or the only one there is.
    fn repo(&self, params: &Value) -> Result<Repo, RpcError> {
        // A named machine checkout is resolved against the full registration
        // set. The listing limit only bounds the response to discovery.
        let names = if self.project && params["repo"].is_string() {
            self.project_repositories()
        } else {
            self.repositories().0
        };
        match params.get("repo") {
            None | Some(Value::Null) => match names.len() {
                0 => Err(RpcError::not_found("this workspace has no Git repository")),
                1 => Ok(Repo { dir: self.dir(&names[0]), name: names[0].clone() }),
                count => Err(RpcError::new(
                    "ambiguous_repository",
                    format!("this workspace has {count} repositories ({}); name one with repo", names.join(", ")),
                )),
            },
            Some(Value::String(name)) => {
                let name = if name.is_empty() { "." } else { name.trim_end_matches('/') };
                names
                    .iter()
                    .find(|known| known.as_str() == name && self.verified_machine_repo(known))
                    .map(|known| Repo { dir: self.dir(known), name: known.clone() })
                    .ok_or_else(|| RpcError::not_found(format!("{name} is not a repository in this workspace")))
            }
            Some(_) => Err(RpcError::invalid("repo must be a string")),
        }
    }

    fn git(&self, repo: &Repo, args: &[&str]) -> Result<String, RpcError> {
        self.git_timed(repo, args, LOCAL_TIMEOUT, &[])
    }

    fn git_timed(&self, repo: &Repo, args: &[&str], timeout: Duration, env: &[(&str, &str)]) -> Result<String, RpcError> {
        let ran = self.run_git(&repo.dir, args, timeout, env)?;
        if ran.ok {
            return Ok(ran.stdout);
        }
        let text = ran.text();
        Err(failure_error(&format!("git {}", args.first().copied().unwrap_or("")), &text, classify(&text, ran.timed_out)))
    }

    fn run_git(&self, dir: &Path, args: &[&str], timeout: Duration, env: &[(&str, &str)]) -> Result<Ran, RpcError> {
        let mut command = git_command(dir);
        command.args(args);
        for (key, value) in env {
            command.env(key, value);
        }
        if matches!(args.first().copied(), Some("fetch" | "pull" | "push" | "ls-remote")) {
            run_network(command, timeout, Network::Git)
        } else {
            run_bounded(command, timeout).map_err(RpcError::internal)
        }
    }

    /// A repository-relative path: lexically inside it. Git refuses paths
    /// outside the repository itself, and pathspec magic is off.
    fn repo_path(relative: &str) -> Result<String, RpcError> {
        if relative.is_empty() || relative.len() > 4096 || relative.contains('\0') {
            return Err(RpcError::new("path_forbidden", "invalid path"));
        }
        let mut clean = PathBuf::new();
        for component in Path::new(relative).components() {
            match component {
                Component::Normal(part) => clean.push(part),
                Component::CurDir => {}
                _ => return Err(RpcError::new("path_forbidden", "paths are repository-relative and may not leave it")),
            }
        }
        let clean = clean.to_string_lossy().into_owned();
        Ok(if clean.is_empty() { ".".into() } else { clean })
    }

    fn path_list(params: &Value) -> Result<Vec<String>, RpcError> {
        params
            .get("paths")
            .and_then(Value::as_array)
            .filter(|paths| !paths.is_empty() && paths.len() <= 1000)
            .ok_or_else(|| RpcError::invalid("paths must list 1 to 1000 paths"))?
            .iter()
            .map(|path| path.as_str().ok_or_else(|| RpcError::invalid("paths must be strings")).and_then(Self::repo_path))
            .collect()
    }

    // ---- reads -----------------------------------------------------------

    fn status(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = match self.repo(params) {
            Ok(repo) => repo,
            // Older clients ask a workspace that is no repository at all.
            Err(error) if error.code == "not_found" && params.get("repo").is_none() => return Ok(json!({ "repository": false })),
            Err(error) => return Err(error),
        };
        let porcelain = self.git(&repo, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])?;
        let mut files = Vec::new();
        let mut conflicted = Vec::new();
        let mut parts = porcelain.split('\0').filter(|part| !part.is_empty());
        while let Some(entry) = parts.next() {
            if entry.len() < 4 {
                continue;
            }
            let (index, worktree, path) = (&entry[0..1], &entry[1..2], &entry[3..]);
            let mut file = json!({ "path": path, "index": index, "worktree": worktree });
            if index == "R" || index == "C" {
                file["from"] = json!(parts.next());
            }
            if matches!(&entry[0..2], "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU") {
                conflicted.push(path.to_string());
            }
            files.push(file);
        }
        let status = crate::git::work_status(&repo.dir);
        Ok(json!({
            "repository": true,
            "repo": repo.name,
            "branch": status.branch,
            "head": status.head,
            "upstream": status.upstream,
            "ahead": status.ahead,
            "behind": status.behind,
            "defaultBranch": status.default_branch,
            "aheadOfBase": status.ahead_of_base,
            "dirty": status.dirty,
            "operation": self.operation(&repo),
            "conflicted": conflicted,
            "files": files,
        }))
    }

    /// A merge, rebase or cherry-pick left in progress.
    fn operation(&self, repo: &Repo) -> Option<&'static str> {
        let git_dir = self.git(repo, &["rev-parse", "--absolute-git-dir"]).ok()?;
        let git_dir = PathBuf::from(git_dir.trim());
        if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
            Some("rebase")
        } else if git_dir.join("MERGE_HEAD").exists() {
            Some("merge")
        } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
            Some("cherry-pick")
        } else {
            None
        }
    }

    fn diff(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let mut args = vec!["diff", "--no-color", "--no-ext-diff", "--no-textconv"];
        if params.get("staged").and_then(Value::as_bool) == Some(true) {
            args.push("--cached");
        }
        args.push("--");
        let path = match params.get("path").and_then(Value::as_str) {
            Some(path) => Some(Self::repo_path(path)?),
            None => None,
        };
        if let Some(path) = &path {
            args.push(path);
        }
        let mut diff = self.git(&repo, &args)?;
        let truncated = truncate_text(&mut diff, MAX_DIFF_BYTES);
        Ok(json!({ "repo": repo.name, "diff": diff, "truncated": truncated }))
    }

    /// The desktop's `working_changes`: HEAD's tree, and what differs from it
    /// in the working tree (untracked files included).
    fn working_changes(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let head = crate::git::head_tree(&repo.dir).map_err(git_error)?;
        let snapshot = crate::git::snapshot_tree(&repo.dir).map_err(git_error)?;
        let mut files = if head == snapshot { Vec::new() } else { crate::git::changes_between_options(&repo.dir, &head, Some(&snapshot), params.get("hideWhitespace").and_then(Value::as_bool).unwrap_or(false)).map_err(git_error)? };
        let truncated = files.len() > MAX_CHANGED_FILES;
        files.truncate(MAX_CHANGED_FILES);
        Ok(json!({ "repo": repo.name, "head": head, "files": files, "truncated": truncated }))
    }

    fn branch_base(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let base = optional_ref(params, "base")?.ok_or_else(|| RpcError::invalid("base is required"))?;
        let deadline = Instant::now() + HEADER_DIFF_TIMEOUT;
        let Some((head, target)) = comparison_refs(&repo.dir, base, deadline)? else {
            return Ok(json!({ "head": null, "aheadOfBase": 0 }));
        };
        let range = format!("{target}..{head}");
        let count = bounded_branch_git(git_command(&repo.dir), &["rev-list", "--count", &range], deadline)?;
        let ahead = count.trim().parse::<u64>().map_err(RpcError::internal)?;
        Ok(json!({ "head": head, "aheadOfBase": ahead }))
    }

    fn branch_diff_size(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let base = optional_ref(params, "base")?.ok_or_else(|| RpcError::invalid("base is required"))?;
        branch_diff_size(&repo.dir, base, Instant::now() + HEADER_DIFF_TIMEOUT)
    }

    fn review_range(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let target = params.get("target").and_then(Value::as_str);
        let uncommitted = params.get("uncommitted").and_then(Value::as_bool).unwrap_or(false);
        let range = crate::git::review_range(&repo.dir, target, uncommitted).map_err(git_error)?;
        Ok(json!(range))
    }

    fn changes_between(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let base = required_str(params, "base")?;
        let head = params.get("head").and_then(Value::as_str);
        if !valid_object_id(base) || head.is_some_and(|head| !valid_object_id(head)) {
            return Err(RpcError::invalid("base and head are tree ids"));
        }
        let mut files = crate::git::changes_between_options(&repo.dir, base, head, params.get("hideWhitespace").and_then(Value::as_bool).unwrap_or(false)).map_err(git_error)?;
        let truncated = files.len() > MAX_CHANGED_FILES;
        files.truncate(MAX_CHANGED_FILES);
        Ok(json!({ "repo": repo.name, "files": files, "truncated": truncated }))
    }

    fn media_content(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let path = Self::repo_path(required_str(params, "path")?)?;
        let tree = params.get("tree").and_then(Value::as_str);
        // The same workspace containment check as text and fs/1, before any live read.
        if tree.is_none() {
            let relative = if repo.name == "." { path.clone() } else { format!("{}/{path}", repo.name) };
            match self.files.existing_path(&relative) {
                Ok(_) => {},
                Err(error) if error.code == "not_found" => return Ok(Value::Null),
                Err(error) => return Err(error),
            }
        }
        // Base64 plus the envelope fits the relay's 1 MiB frame.
        let content = crate::git_media::read(&repo.dir, &path, tree, 512 * 1024).map_err(git_error)?;
        Ok(json!(content))
    }

    /// One file at tree `base` and at tree `head` (or in the working tree).
    fn file_contents(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let path = Self::repo_path(required_str(params, "path")?)?;
        let base = required_str(params, "base")?;
        let head = params.get("head").and_then(Value::as_str);
        if !valid_object_id(base) || head.is_some_and(|head| !valid_object_id(head)) {
            return Err(RpcError::invalid("base and head are tree ids"));
        }
        let (before, before_size) = crate::git::blob_text_at(&repo.dir, base, &path, MAX_CONTENT_BYTES).map_err(git_error)?;
        let (after, after_size) = match head {
            Some(head) => crate::git::blob_text_at(&repo.dir, head, &path, MAX_CONTENT_BYTES).map_err(git_error)?,
            None => self.working_file(&repo, &path)?,
        };
        Ok(json!({ "before": before, "after": after, "beforeSize": before_size, "afterSize": after_size }))
    }

    /// A working-tree file, never through a link that leaves the workspace.
    fn working_file(&self, repo: &Repo, path: &str) -> Result<(Option<String>, Option<u64>), RpcError> {
        let relative = if repo.name == "." { path.to_string() } else { format!("{}/{path}", repo.name) };
        let resolved = match self.files.existing_path(&relative) {
            Ok(resolved) => resolved,
            Err(error) if error.code == "not_found" => return Ok((None, None)),
            Err(error) => return Err(error),
        };
        let Ok(meta) = std::fs::metadata(&resolved) else { return Ok((None, None)) };
        if !meta.is_file() {
            return Ok((None, None));
        }
        if meta.len() > MAX_CONTENT_BYTES as u64 {
            return Ok((Some(TOO_LARGE.into()), Some(meta.len())));
        }
        Ok(match std::fs::read(&resolved) {
            Ok(bytes) => (Some(String::from_utf8_lossy(&bytes).into_owned()), Some(bytes.len() as u64)),
            Err(_) => (None, None),
        })
    }

    fn log(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let limit = params.get("limit").and_then(Value::as_u64).unwrap_or(50).clamp(1, 500) as u32;
        let from = params.get("from").and_then(Value::as_str);
        // ScopePicker excludes the selected base's history. Accept only this
        // bounded range form in addition to the existing commit-id cursor.
        if from.is_some_and(|from| !valid_object_id(from) && !from.strip_suffix("..HEAD").is_some_and(valid_ref_name)) {
            return Err(RpcError::invalid("from is a commit id or a base branch followed by ..HEAD"));
        }
        if crate::git::head_commit(&repo.dir).is_none() && from.is_none() {
            return Ok(json!({ "repo": repo.name, "commits": [] }));
        }
        let mut commits = crate::git::log_commits(&repo.dir, from, limit).map_err(git_error)?;
        for commit in &mut commits {
            truncate_text(&mut commit.body, MAX_BODY_BYTES);
        }
        Ok(json!({ "repo": repo.name, "commits": commits }))
    }

    fn branches(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let branches = crate::git::list_branches(&repo.dir).map_err(git_error)?;
        Ok(json!({
            "repo": repo.name,
            "branches": branches,
            "current": crate::git::current_branch(&repo.dir),
            "defaultBranch": crate::git::default_branch(&repo.dir),
        }))
    }

    // ---- local writes ----------------------------------------------------

    fn checkout(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let branch = required_str(params, "branch")?;
        if !valid_ref_name(branch) {
            return Err(RpcError::invalid("invalid branch name"));
        }
        let create = params.get("create").and_then(Value::as_bool).unwrap_or(false);
        let from = optional_ref(params, "from")?;
        match (create, from) {
            (true, Some(from)) => self.git(&repo, &["checkout", "-b", branch, from, "--"])?,
            (true, None) => self.git(&repo, &["checkout", "-b", branch, "--"])?,
            (false, _) => self.git(&repo, &["checkout", branch, "--"])?,
        };
        Ok(json!({ "repo": repo.name, "branch": branch }))
    }

    fn paths(&self, params: &Value, prefix: &[&str]) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let paths = Self::path_list(params)?;
        let mut args: Vec<&str> = prefix.to_vec();
        args.extend(paths.iter().map(String::as_str));
        self.git(&repo, &args)?;
        Ok(json!({ "repo": repo.name, "paths": paths }))
    }

    fn unstage(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let paths = Self::path_list(params)?;
        // Before the first commit there is no HEAD to restore from.
        let mut args = if crate::git::head_commit(&repo.dir).is_some() { vec!["restore", "--staged", "--"] } else { vec!["rm", "--cached", "-r", "-q", "--"] };
        args.extend(paths.iter().map(String::as_str));
        self.git(&repo, &args)?;
        Ok(json!({ "repo": repo.name, "paths": paths }))
    }

    fn commit(&self, params: &Value, guarded: bool) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let expected = match (optional_ref(params, "expectedBranch")?, params.get("expectedHead")) {
            (None, None) if !guarded => None,
            (Some(branch), Some(Value::String(head))) if valid_object_id(head) => Some((branch, head.as_str())),
            _ => return Err(RpcError::invalid("expectedBranch and expectedHead are required together")),
        };
        let message = required_str(params, "message")?;
        if message.trim().is_empty() || message.len() > 64 * 1024 {
            return Err(RpcError::invalid("a commit message is required"));
        }
        let author: Author = params
            .get("author")
            .cloned()
            .ok_or_else(|| RpcError::invalid("author ({ name, email }) is required: commits carry the person's identity, not the workspace's"))
            .and_then(|author| serde_json::from_value(author).map_err(|error| RpcError::invalid(format!("author: {error}"))))?;
        author.check()?;
        let (name, email) = (author.name.trim(), author.email.trim());
        let staged_only = params.get("staged").and_then(Value::as_bool) == Some(true);
        let paths = match params.get("paths") {
            Some(Value::Null) | None => None,
            Some(_) => Some(Self::path_list(params)?),
        };
        if let Some((branch, head)) = expected {
            if staged_only || paths.is_some() {
                return Err(RpcError::invalid("A guarded branch commit includes all changes."));
            }
            return self.commit_to_branch(&repo, branch, head, message, name, email);
        }
        match &paths {
            Some(paths) => {
                let mut args = vec!["add", "-A", "--"];
                args.extend(paths.iter().map(String::as_str));
                self.git(&repo, &args)?;
            }
            None if !staged_only => {
                self.git(&repo, &["add", "-A", "--", "."])?;
            }
            None => {}
        }
        let staged = self.git(&repo, &["diff", "--cached", "--name-only", "-z", "--"])?;
        if staged.is_empty() {
            return Err(RpcError::invalid("nothing to commit"));
        }
        let env = [
            ("GIT_AUTHOR_NAME", name),
            ("GIT_AUTHOR_EMAIL", email),
            ("GIT_COMMITTER_NAME", name),
            ("GIT_COMMITTER_EMAIL", email),
        ];
        let user_name = format!("user.name={name}");
        let user_email = format!("user.email={email}");
        let mut args = vec!["-c", &user_name, "-c", &user_email, "commit", "--quiet", "-m", message];
        if let Some(paths) = &paths {
            args.push("--");
            args.extend(paths.iter().map(String::as_str));
        }
        self.git_timed(&repo, &args, LOCAL_TIMEOUT, &env)?;
        let commit = crate::git::head_commit(&repo.dir);
        let branch = crate::git::current_branch(&repo.dir);
        Ok(json!({
            "repo": repo.name,
            "commit": commit,
            "branch": branch,
            "author": { "name": name, "email": email },
        }))
    }

    /// Prepare with Git's ordinary commit machinery and hooks against a private
    /// copy of the branch refs. Only the confirmed real ref can receive the commit,
    /// via a compare-and-swap against the head the caller confirmed.
    fn commit_to_branch(&self, repo: &Repo, branch: &str, head: &str, message: &str, name: &str, email: &str) -> Result<Value, RpcError> {
        let reference = format!("refs/heads/{branch}");
        let check_checkout = || {
            let current = self.git(repo, &["symbolic-ref", "--quiet", "HEAD"]).ok();
            if current.as_deref().map(str::trim) != Some(reference.as_str()) || self.local_head(repo, branch)? != head {
                return Err(RpcError::new("conflict", "The checkout changed before the commit. Refresh and try again."));
            }
            if crate::git::operation_in_progress(&repo.dir).map_err(git_error)?.is_some() {
                return Err(RpcError::new("conflict", "Finish the Git operation before committing and pushing."));
            }
            Ok(())
        };
        let path = |args: &[&str]| self.git(repo, args).map(|out| PathBuf::from(out.strip_suffix('\n').unwrap_or(&out)));
        let git_dir = path(&["rev-parse", "--absolute-git-dir"])?;
        let index = path(&["rev-parse", "--path-format=absolute", "--git-path", "index"])?;
        let objects = path(&["rev-parse", "--path-format=absolute", "--git-path", "objects"])?;
        let mut lock_path = index.as_os_str().to_owned();
        lock_path.push(".lock");
        std::fs::OpenOptions::new().write(true).create_new(true).open(&lock_path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                RpcError::new("busy", "Another Git operation is using the worktree index. Try again shortly.")
            } else {
                RpcError::internal(error)
            }
        })?;
        let lock = tempfile::TempPath::try_from_path(lock_path).map_err(RpcError::internal)?;
        check_checkout()?;

        let mut scratch = tempfile::Builder::new();
        scratch.prefix("terminalx-branch-commit-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            scratch.permissions(std::fs::Permissions::from_mode(0o700));
        }
        let scratch = scratch.tempdir().map_err(RpcError::internal)?;
        let private = scratch.path().join("repo");
        std::fs::create_dir(&private).map_err(RpcError::internal)?;
        let staged = private.join("index");
        if index.exists() {
            std::fs::copy(&index, &staged).map_err(RpcError::internal)?;
            // Expand the split index while Git can still find its shared part.
            let mut command = git_command(&repo.dir);
            command.env("GIT_INDEX_FILE", &staged).args(["update-index", "--no-split-index"]);
            let result = run_bounded(command, LOCAL_TIMEOUT).map_err(RpcError::internal)?;
            if !result.ok {
                return Err(failure_error("prepare commit index", &result.text(), Failure::Other));
            }
        }
        let object_format = self.git(repo, &["rev-parse", "--show-object-format"])?;
        let object_format = match object_format.trim() {
            "sha1" => "sha1",
            "sha256" => "sha256",
            _ => return Err(RpcError::internal("Unsupported Git object format")),
        };
        let refs = self.git(repo, &["for-each-ref", "--sort=refname", "--format=%(objectname) %(refname)"])?;
        std::fs::write(private.join("packed-refs"), refs).map_err(RpcError::internal)?;
        let private_ref = private.join(&reference);
        std::fs::create_dir_all(private_ref.parent().expect("a branch ref has a parent")).map_err(RpcError::internal)?;
        std::fs::write(private_ref, format!("{head}\n")).map_err(RpcError::internal)?;
        std::fs::write(private.join("HEAD"), format!("ref: {reference}\n")).map_err(RpcError::internal)?;
        let include_worktree = self.git(repo, &["config", "--local", "--no-includes", "--bool", "--get", "extensions.worktreeConfig"])
            .is_ok_and(|value| value.trim() == "true");
        snapshot_commit_config(|| git_command(&repo.dir), scratch.path(), object_format, include_worktree)?;

        let add_config = |file: &Path, key: &str, value: &Path| {
            let mut command = git_command(&repo.dir);
            command.args(["config", "--file"]).arg(file).args(["--add", key]).arg(value);
            let result = run_bounded(command, LOCAL_TIMEOUT).map_err(RpcError::internal)?;
            if !result.ok {
                return Err(failure_error("prepare branch commit config", &result.text(), Failure::Other));
            }
            Ok(())
        };
        let sparse_config = git_dir.join("info/sparse-checkout");
        if sparse_config.is_file() {
            std::fs::create_dir_all(private.join("info")).map_err(RpcError::internal)?;
            std::fs::copy(sparse_config, private.join("info/sparse-checkout")).map_err(RpcError::internal)?;
        }

        let mut command_config = std::ffi::OsString::from("include.path=");
        command_config.push(scratch.path().join("config.command"));

        let run = |args: &[&str]| {
            let mut command = git_command(&repo.dir);
            command.env("GIT_DIR", &private).env_remove("GIT_COMMON_DIR")
                .env("GIT_OBJECT_DIRECTORY", &objects).env("GIT_WORK_TREE", &repo.dir).env("GIT_INDEX_FILE", &staged)
                .env("GIT_CONFIG_SYSTEM", scratch.path().join("config.system"))
                .env("GIT_CONFIG_GLOBAL", scratch.path().join("config.global"))
                .env_remove("GIT_CONFIG_COUNT").env_remove("GIT_CONFIG_PARAMETERS")
                .env("GIT_AUTHOR_NAME", name).env("GIT_AUTHOR_EMAIL", email)
                .env("GIT_COMMITTER_NAME", name).env("GIT_COMMITTER_EMAIL", email)
                .arg("-c").arg(&command_config)
                .args(["-c", "core.bare=false", "-c", "core.splitIndex=false",
                "-c", &format!("user.name={name}"), "-c", &format!("user.email={email}")]).args(args);
            let result = run_bounded(command, LOCAL_TIMEOUT).map_err(RpcError::internal)?;
            if !result.ok {
                return Err(failure_error("prepare branch commit", &result.text(), Failure::Other));
            }
            Ok(result.stdout)
        };
        // Keep configured hooks in their original scope. If the private Git
        // directory changes hook resolution (including the default hooks
        // directory), pin the real path in the private repository's config.
        let hooks_args = ["rev-parse", "--path-format=absolute", "--git-path", "hooks"];
        let hooks = path(&hooks_args)?;
        let private_hooks = run(&hooks_args)?;
        if Path::new(private_hooks.strip_suffix('\n').unwrap_or(&private_hooks)) != hooks {
            let hooks_config = scratch.path().join("hooks.config");
            add_config(&hooks_config, "core.hooksPath", &hooks)?;
            let scoped_config = private.join(if include_worktree { "config.worktree" } else { "config" });
            // A second include loads after the original config. Writing
            // core.hooksPath directly could place it before the snapshot include.
            add_config(&scoped_config, "include.path", &hooks_config)?;
        }
        run(&["add", "-A", "--", "."])?;
        if run(&["diff", "--cached", "--name-only", "-z", "--"])?.is_empty() {
            return Err(RpcError::invalid("nothing to commit"));
        }
        run(&["commit", "--quiet", "-m", message])?;
        let output = run(&["rev-parse", "--verify", &reference])?;
        let commit = output.trim();
        if commit == head || run(&["rev-parse", &format!("{commit}^1")])?.trim() != head {
            return Err(RpcError::new("conflict", "The prepared commit no longer matches the confirmed branch and head."));
        }
        check_checkout()?;
        std::fs::copy(&staged, &lock).map_err(RpcError::internal)?;
        self.git(repo, &["update-ref", "--no-deref", "-m", "commit: TerminalX", &reference, commit, head])?;
        lock.persist(&index).map_err(|error| RpcError::internal(format!("Committed on {branch}, but could not update the worktree index: {error}")))?;
        Ok(json!({ "repo": repo.name, "commit": commit, "branch": branch, "author": { "name": name, "email": email } }))
    }

    // ---- the remote ------------------------------------------------------

    fn fetch(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        self.git_timed(&repo, &["fetch", "--prune", "origin"], NETWORK_TIMEOUT, &[])?;
        let (ahead, behind) = crate::git::upstream_counts(&repo.dir);
        Ok(json!({ "repo": repo.name, "ahead": ahead, "behind": behind }))
    }

    fn pull(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let output = self.git_timed(&repo, &["pull", "--ff-only", "--no-rebase"], NETWORK_TIMEOUT, &[])?;
        Ok(json!({ "repo": repo.name, "output": output, "head": crate::git::head_commit(&repo.dir) }))
    }

    /// The commit `origin` has for `branch`: `Some(None)` when it has no
    /// such branch, `Err` when it could not be asked.
    fn remote_head(&self, repo: &Repo, branch: &str, timeout: Duration) -> Result<Option<String>, RpcError> {
        self.remote_head_at(repo, "origin", branch, timeout)
    }

    fn remote_head_at(&self, repo: &Repo, remote: &str, branch: &str, timeout: Duration) -> Result<Option<String>, RpcError> {
        let reference = format!("refs/heads/{branch}");
        let out = self.git_timed(repo, &["ls-remote", "--", remote, &reference], timeout, &[])?;
        Ok(out
            .lines()
            .find_map(|line| line.split_once('\t').filter(|(_, name)| *name == reference).map(|(sha, _)| sha.to_string())))
    }

    fn local_head(&self, repo: &Repo, branch: &str) -> Result<String, RpcError> {
        self.git(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}^{{commit}}")])
            .map(|sha| sha.trim().to_string())
            .map_err(|_| RpcError::not_found(format!("there is no local branch {branch}")))
    }

    /// Point `branch` at `origin/<branch>` once the remote has it.
    fn track(&self, repo: &Repo, branch: &str, verify: impl Fn() -> Result<(), RpcError>) -> Result<(), RpcError> {
        let refspec = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
        verify()?;
        let _ = self.git_timed(repo, &["fetch", "--no-tags", "origin", &refspec], NETWORK_TIMEOUT, &[]);
        verify()?;
        let _ = self.git(repo, &["branch", &format!("--set-upstream-to=origin/{branch}"), branch]);
        Ok(())
    }

    fn push(&self, params: &Value) -> Result<Value, RpcError> {
        self.push_with(params, |repo, branch, head| {
            let source = if params.get("head").is_some() { head.to_owned() } else { format!("refs/heads/{branch}") };
            self.push_ref(repo, branch, &source)
        })
    }

    fn push_ref(&self, repo: &Repo, branch: &str, source: &str) -> Result<Ran, RpcError> {
        let refspec = format!("{source}:refs/heads/{branch}");
        self.run_git(&repo.dir, &["push", "--porcelain", "origin", &refspec], NETWORK_TIMEOUT, &[])
    }

    fn push_with(&self, params: &Value, push: impl FnOnce(&Repo, &str, &str) -> Result<Ran, RpcError>) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let branch = match optional_ref(params, "branch")? {
            Some(branch) => branch.to_string(),
            None => crate::git::current_branch(&repo.dir).ok_or_else(|| RpcError::invalid("HEAD is detached; name a branch to push"))?,
        };
        let local = self.local_head(&repo, &branch)?;
        if let Some(head) = params.get("head") {
            let head = head.as_str().filter(|head| valid_object_id(head)).ok_or_else(|| RpcError::invalid("head is a commit id"))?;
            if head != local {
                return Err(RpcError::new("conflict", "The branch moved before the push. Refresh and try again."));
            }
        }
        self.push_branch(&repo, &branch, &local, push, || Ok(()))
    }

    fn push_branch(
        &self, repo: &Repo, branch: &str, local: &str,
        push: impl FnOnce(&Repo, &str, &str) -> Result<Ran, RpcError>,
        verify: impl Fn() -> Result<(), RpcError>,
    ) -> Result<Value, RpcError> {
        let answer = |pushed: bool, reconciled: bool| {
            json!({ "repo": repo.name, "branch": branch, "head": local, "pushed": pushed, "reconciled": reconciled })
        };
        let track = || self.track(repo, branch, &verify);
        // A resend, or a retry after an answer that never arrived: ask first.
        if self.remote_head(repo, branch, NETWORK_TIMEOUT)?.as_deref() == Some(local) {
            track()?;
            return Ok(answer(false, true));
        }
        verify()?;
        let ran = push(repo, branch, local)?;
        if ran.ok {
            track()?;
            return Ok(answer(true, false));
        }
        let text = ran.text();
        let failure = classify(&text, ran.timed_out);
        if matches!(failure, Failure::Network | Failure::Other) {
            // It may have landed before the connection went.
            if let Ok(Some(remote)) = self.remote_head(repo, branch, NETWORK_TIMEOUT) {
                if remote == local {
                    track()?;
                    return Ok(answer(true, true));
                }
            }
        }
        Err(match failure {
            Failure::Conflict => RpcError::new(
                "conflict",
                format!("push {branch}: the remote branch has commits this one does not; pull (or fetch and merge) first: {text}"),
            ),
            other => failure_error(&format!("push {branch}"), &text, other),
        })
    }

    // ---- pull requests ---------------------------------------------------

    fn gh(&self, repo: &Repo, args: &[&str], timeout: Duration) -> Result<String, RpcError> {
        let ran = self.gh_output(repo, args, timeout)?;
        if ran.ok { return Ok(ran.stdout); }
        let text = ran.text();
        Err(failure_error(&format!("gh {}", args.iter().take(2).copied().collect::<Vec<_>>().join(" ")), &text, classify(&text, ran.timed_out)))
    }

    fn gh_output(&self, repo: &Repo, args: &[&str], timeout: Duration) -> Result<Ran, RpcError> {
        let bin = self
            .gh
            .clone()
            .or_else(|| crate::binpath::resolve("gh"))
            .ok_or_else(|| RpcError::new("unavailable", "the GitHub CLI is not installed in this workspace"))?;
        let mut command = Command::new(bin);
        command
            .current_dir(&repo.dir)
            .args(args)
            .env("PATH", crate::binpath::login_path())
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .env("NO_COLOR", "1");
        run_network(command, timeout, Network::Github)
    }

    fn panel_pr(&self, repo: &Repo, pr: &mut crate::github::PullRequest) {
        crate::github::enrich_panel_pr(pr, |args| {
            let ran = self.gh_output(repo, args, NETWORK_TIMEOUT).map_err(|error| anyhow::anyhow!("{}", error.message))?;
            if ran.timed_out { anyhow::bail!("GitHub did not answer within {} seconds.", NETWORK_TIMEOUT.as_secs()); }
            Ok(crate::github::GhOutput { success: ran.ok, stdout: ran.stdout, stderr: ran.stderr })
        });
    }

    fn list_prs(&self, repo: &Repo, branch: &str, state: &str, timeout: Duration, github_repo: Option<&str>) -> Result<Vec<crate::github::PullRequest>, RpcError> {
        let fields = format!("{},isCrossRepository", crate::github::FIELDS);
        let mut args = vec!["pr", "list", "--head", branch, "--state", state, "--json", &fields, "--limit", "100"];
        if let Some(github_repo) = github_repo { args.extend(["--repo", github_repo]); }
        let out = self.gh(repo, &args, timeout)?;
        let value: Value = serde_json::from_str(&out).map_err(|error| RpcError::new("git_failed", format!("gh pr list: {error}")))?;
        let mut prs: Vec<_> = value.as_array().map(|prs| own_prs(prs).map(crate::github::parse_pr).collect()).unwrap_or_default();
        prs.sort_by(|a, b| (b.state == "OPEN").cmp(&(a.state == "OPEN")).then(b.number.cmp(&a.number)));
        Ok(prs)
    }

    fn branch_param(&self, repo: &Repo, params: &Value) -> Result<String, RpcError> {
        match optional_ref(params, "branch")? {
            Some(branch) => Ok(branch.to_string()),
            None => crate::git::current_branch(&repo.dir).ok_or_else(|| RpcError::invalid("HEAD is detached; name a branch")),
        }
    }

    fn project_session(&self, session: &str) -> Result<crate::store::index::SessionEntry, RpcError> {
        let entry = crate::store::index::get(session).map_err(|_| RpcError::not_found("session not found"))?;
        // The runtime may host more than one workspace. Never expose another
        // workspace's journal or pipeline evidence through this connection.
        // Match WorkspaceRpc::workspace_sessions exactly: a checkout location
        // does not grant visibility into its owning project.
        if !super::session_target::owns_project(&self.root, &entry.project_path) {
            return Err(RpcError::not_found("session is not in this workspace"));
        }
        Ok(entry)
    }

    fn pr_creation_checkout(&self, session: &str, repo: &Repo) -> Result<CheckoutIdentity, RpcError> {
        let refused = || RpcError::new("conflict", "Select this session's checkout before creating a pull request.");
        let entry = self.project_session(session)?;
        let path = repo.dir.canonicalize().map_err(|_| refused())?;
        let authorized = super::machine::session_checkout(&self.root, &self.files, &entry, || self.project_has_git())
            .and_then(|(_, name)| name);
        if authorized.as_deref() != Some(repo.name.as_str()) || !crate::git::is_own_worktree(&path) {
            return Err(refused());
        }
        let git_dir = self.git(repo, &["rev-parse", "--absolute-git-dir"]).map_err(|_| refused())?;
        let git_dir = Path::new(git_dir.trim()).canonicalize().map_err(|_| refused())?;
        let directory = directory_identity(&path).map_err(|_| refused())?;
        let admin = directory_identity(&git_dir).map_err(|_| refused())?;
        Ok(CheckoutIdentity { path, git_dir, directory, admin })
    }

    fn pr_associations(&self, params: &Value, url_targets: bool) -> Result<Value, RpcError> {
        let session = self.project_session(required_str(params, "sessionId")?)?;
        let associations = crate::pr_associations::for_session(&session.id, vec![])
            .map_err(|error| RpcError::new("internal_error", error.to_string()))?;
        let mut response = self.locate_pr_associations(&session, associations, url_targets);
        if self.project {
            response["branchPrLinks"] = json!(true);
            let pending = pending_pr_creations(|entries| (entries.iter().filter(|entry| entry.session == session.id)
                .map(|entry| entry.url.clone()).collect::<Vec<_>>(), false))?;
            if !pending.is_empty() {
                response["pendingCreation"] = json!(true);
                // What `git.prReconcileCreation` takes, once the PR has merged or closed.
                response["pendingCreationUrls"] = json!(pending);
            }
        }
        Ok(response)
    }

    fn checkout_contains(root: &Path, cwd: &Path) -> bool {
        cwd == root || (cwd.starts_with(root)
            && crate::git::run(cwd, &["rev-parse", "--show-toplevel"]).ok()
                .and_then(|top| Path::new(top.trim()).canonicalize().ok()).as_deref() == Some(root))
    }

    /// A prior branch may have contained the directory the link saved.
    /// Walk back only through missing paths and verify the surviving directory.
    fn existing_link_directory(cwd: &Path) -> Option<(PathBuf, bool)> {
        for ancestor in cwd.ancestors() {
            match ancestor.canonicalize() {
                Ok(path) if path.is_dir() => return Some((path, ancestor != cwd)),
                Ok(_) => {}
                Err(error) if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => {}
                Err(_) => return None,
            }
        }
        None
    }

    fn pr_link_branch(&self, params: &Value) -> Result<Value, RpcError> {
        if !self.project {
            return Err(RpcError::forbidden("Branch PR linking is only available on paired machines."));
        }
        let session = self.project_session(required_str(params, "sessionId")?)?;
        let repo = self.repo(params)?;
        let repo_root = repo.dir.canonicalize().map_err(RpcError::internal)?;
        let matches_checkout = match Path::new(&session.cwd).canonicalize() {
            Ok(cwd) => Self::checkout_contains(&repo_root, &cwd),
            Err(error) if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::NotADirectory) => {
                session.checkout_root().and_then(|root| Path::new(root).canonicalize().ok()).as_ref() == Some(&repo_root)
            }
            Err(_) => false,
        };
        if session.worktree_removed || !matches_checkout {
            return Err(RpcError::invalid("Select the session's checkout to link its pull request."));
        }
        let requested = crate::pr_associations::identity(required_str(params, "url")?)
            .map_err(|_| RpcError::invalid("Expected a pull request URL."))?;
        let branch = required_str(params, "branch")?;
        let checkout_matches = || crate::git::current_branch(&repo.dir).as_deref() == Some(branch);
        if !checkout_matches() {
            return Err(RpcError::invalid("The session's checkout is no longer on the pull request branch."));
        }
        let found = self.list_prs(&repo, branch, "open", NETWORK_TIMEOUT, None)?.into_iter().find(|pr| {
            pr.state == "OPEN" && pr.head == branch
                && crate::pr_associations::identity(&pr.url).is_ok_and(|url| url == requested)
        });
        if found.is_none() || !checkout_matches() {
            return Err(RpcError::not_found("GitHub did not verify an open pull request on the session's branch."));
        }
        crate::pr_associations::link_local(&session.id, &repo_root, &requested, branch).map_err(RpcError::internal)?;
        Ok(json!({ "sessionAssociated": true }))
    }

    fn pr_unlink(&self, params: &Value) -> Result<Value, RpcError> {
        if !self.project {
            return Err(RpcError::forbidden("PR unlinking is only available on paired machines."));
        }
        let session = self.project_session(required_str(params, "sessionId")?)?;
        crate::pr_associations::unlink(&session.id, required_str(params, "url")?).map_err(RpcError::internal)?;
        Ok(json!({}))
    }

    fn linked_pr_checkout<'a>(session: &crate::store::index::SessionEntry, cwd: &str, checkouts: &[(&'a String, PathBuf)]) -> Option<&'a String> {
        let (path, missing) = Self::existing_link_directory(Path::new(cwd))?;
        let (name, root) = checkouts.iter().filter(|(_, root)| path.starts_with(root))
            .max_by_key(|(_, root)| root.components().count())?;
        // A vanished worktree must never resolve to the enclosing project's checkout.
        if missing && (session.worktree_removed || match session.checkout_root() {
            Some(saved) => Path::new(saved).canonicalize().ok().as_ref() != Some(root),
            None => name.as_str() == "." && (session.worktree_name.is_some() || cwd != session.cwd),
        }) {
            return None;
        }
        Self::checkout_contains(root, &path).then_some(*name)
    }

    fn locate_pr_associations(&self, session: &crate::store::index::SessionEntry, associations: Vec<crate::pr_associations::Association>, url_targets: bool) -> Value {
        use crate::pr_associations::Scope;

        if associations.is_empty() {
            return json!({ "associations": [] });
        }
        let names = if self.project { self.project_repositories() } else { self.repositories().0 };
        let can_locate = |association: &crate::pr_associations::Association| {
            url_targets || association.url.starts_with("https://github.com/") || (self.project && association.linked)
        };
        let linked_checkouts = if self.project && associations.iter().any(|association| association.linked) {
            names.iter().filter_map(|name| Some((name, self.dir(name).canonicalize().ok()?))).collect()
        } else {
            Vec::new()
        };
        let selected: Vec<_> = associations.iter().map(|association| match &association.scope {
            Scope::Local { cwd } if self.project && association.linked => {
                Self::linked_pr_checkout(session, cwd, &linked_checkouts)
            }
            Scope::Local { cwd } if can_locate(association) => names.iter().find(|name| self.dir(name) == Path::new(cwd)),
            _ => None,
        }).collect();

        // Give recorded checkouts their own budget before scanning fallbacks.
        // Several histories can point at the same checkout, so resolve it once.
        let mut recorded = std::collections::HashSet::new();
        let recorded: Vec<_> = selected.iter().flatten().copied().filter(|name| recorded.insert(*name)).collect();
        const BATCH_SIZE: usize = 8;
        let batch_count = u32::try_from(recorded.len().div_ceil(BATCH_SIZE)).unwrap_or(u32::MAX).max(1);
        let batch_timeout = (2 * PR_LOCATOR_TIMEOUT) / batch_count;
        let mut identities = std::collections::HashMap::new();
        for batch in recorded.chunks(BATCH_SIZE) {
            // Reserve time for every batch, including when an earlier host stalls.
            let deadline = Instant::now() + batch_timeout;
            std::thread::scope(|scope| {
                let jobs: Vec<_> = batch.iter().map(|&name| {
                    (name, scope.spawn(crate::github_process::queued(move || self.pr_locator_identity(name, deadline))))
                }).collect();
                // An unanswered recorded probe can still be retried under the fallback budget.
                for (name, task) in jobs {
                    if let Ok(Some(identity)) = task.join() {
                        identities.insert(name.clone(), Some(identity));
                    }
                }
            });
        }
        let deadline = Instant::now() + PR_LOCATOR_TIMEOUT;
        let mut matches = |name: &str, repository: &str| {
            identities.entry(name.to_owned()).or_insert_with(|| self.pr_locator_identity(name, deadline)).as_deref() == Some(repository)
        };
        json!({ "associations": associations.into_iter().zip(selected).map(|(association, selected)| {
            let repo = association.url.rsplit_once("/pull/").and_then(|(repository, _)| {
                if !can_locate(&association) { return None; }
                let selected = selected.filter(|name| matches(name, repository));
                if self.project && association.linked { return selected; }
                selected.or_else(|| {
                    // Journal and pipeline records may only know the project root.
                    // Keep the association even if no available checkout matches.
                    let limit = if self.project { MAX_PROJECT_REPOSITORIES } else { names.len() };
                    names.iter().take(limit).find(|name| matches(name, repository))
                })
            }).map(|name| {
                // Older desktop clients pass this value back as an opaque repo
                // string. Bind their numeric actions to this specific PR.
                if self.project && !url_targets {
                    format!("{LEGACY_PR_REPO_PREFIX}{}", json!([name, association.url]))
                } else {
                    name.clone()
                }
            });
            json!({ "url": association.url, "number": association.number, "head": association.head, "repo": repo, "linked": association.linked })
        }).collect::<Vec<_>>() })
    }

    fn pr_locator_identity(&self, name: &str, deadline: Instant) -> Option<String> {
        if Instant::now() >= deadline || !self.verified_machine_repo(name) {
            return None;
        }
        let repo = Repo { name: name.to_owned(), dir: self.dir(name) };
        self.default_pr_repository(&repo, deadline.saturating_duration_since(Instant::now())).ok()
    }

    fn pr_conversation(&self, method: &str, params: &Value) -> Result<Value, RpcError> {
        use crate::github::conversation::{self, Action};
        // Cloud gh uses an organisation App installation token, never the
        // caller's personal identity. It must not satisfy required reviews.
        let action = if method == "git.prConversationAction" {
            let action = serde_json::from_value(params["action"].clone()).map_err(|_| RpcError::invalid("Invalid PR action"))?;
            if matches!(action, Action::Approve { .. }) {
                return Err(RpcError::forbidden("Approve from GitHub with your personal account. Cloud workspaces cannot approve as the organisation App."));
            }
            Some(action)
        } else { None };
        let repo = self.repo(params)?;
        let target = Target::new(required_str(params, "url")?).map_err(|error| RpcError::invalid(error.to_string()))?;
        if action.is_some() {
            target.require_exact_cli_host().map_err(|error| RpcError::invalid(error.to_string()))?;
        }
        self.require_pr_repository(&repo, &target.repository_url())?;
        let run = |args: &[&str]| self.gh(&repo, args, NETWORK_TIMEOUT).map_err(|error| anyhow::anyhow!("{}", error.message));
        match method {
            "git.prConversation" => conversation::read_with(&target, run).map(|value| json!(value)),
            "git.prReviewerSearch" => conversation::search_with(&target, required_str(params, "query")?, run).map(|value| json!(value)),
            _ => {
                conversation::update_with(&target, action.ok_or_else(|| RpcError::invalid("Invalid PR action"))?, run).map(|value| json!(value))
            }
        }.map_err(RpcError::internal)
    }

    fn pr_landed(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        // Use the runtime's bounded, authenticated Git transport, then the
        // same squash/rebase-aware verifier as local workspace cleanup.
        self.git_timed(&repo, &["fetch", "--prune", "origin"], NETWORK_TIMEOUT, &[])?;
        Ok(json!(crate::landed::check(&repo.dir, &repo.dir, crate::landed::Fetch::JustFetched)))
    }

    fn prs(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        if params.get("number").is_some() || params.get("url").is_some() {
            let mut pr = self.pr_view(&repo, &self.pr_selector(&repo, params)?)?;
            self.panel_pr(&repo, &mut pr);
            return Ok(json!({ "repo": repo.name, "branch": pr.head, "prs": [pr] }));
        }
        let branch = self.branch_param(&repo, params)?;
        let mut prs = self.list_prs(&repo, &branch, "all", NETWORK_TIMEOUT, None)?;
        for pr in &mut prs { self.panel_pr(&repo, pr); }
        Ok(json!({ "repo": repo.name, "branch": branch, "prs": prs }))
    }

    fn pr_create(&self, params: &Value, for_session: bool) -> Result<Value, RpcError> {
        if for_session && !self.project {
            return Err(RpcError::invalid("This pull request operation requires a machine session"));
        }
        let repo = self.repo(params)?;
        let session = if for_session || (self.project && params.get("sessionId").is_some()) {
            Some(required_str(params, "sessionId")?)
        } else {
            None
        };
        let pinned_head = if for_session && params.get("pushHead").is_some() {
            let head = required_str(params, "pushHead")?;
            if !valid_object_id(head) { return Err(RpcError::invalid("pushHead is a commit id")); }
            Some(head)
        } else { None };
        let branch = if pinned_head.is_some() {
            optional_ref(params, "branch")?.ok_or_else(|| RpcError::invalid("branch is required"))?.to_owned()
        } else {
            self.branch_param(&repo, params)?
        };
        let checkout = session.map(|session| self.pr_creation_checkout(session, &repo)).transpose()?;
        let _lease = checkout.as_ref().map(|checkout| crate::archive_script::RemovalLease::acquire(&checkout.path))
            .transpose().map_err(|error| RpcError::new("conflict", error.to_string()))?;
        let origin = if self.project {
            Some(self.git(&repo, &["remote", "get-url", "origin"])?.trim().to_owned())
        } else { None };
        let github_repo = origin.as_deref().map(|origin| self.pr_creation_repository(origin)).transpose()?;
        let github_repo = github_repo.as_deref();
        let known_url = |url: &str| github_repo.is_none_or(|name| url.starts_with(&format!("https://{name}/pull/")));
        let verify_identity = || {
            if let Some((session, expected)) = session.zip(checkout.as_ref()) {
                if self.pr_creation_checkout(session, &repo)? != *expected {
                    return Err(RpcError::new("conflict", "The session's checkout was replaced. Refresh and try again."));
                }
            }
            Ok(())
        };
        let verify_checkout = || {
            verify_identity()?;
            if session.is_some() && crate::git::current_branch(&repo.dir).as_deref() != Some(&branch) {
                return Err(RpcError::new("conflict", "The selected branch is no longer checked out in this session. Refresh and try again."));
            }
            Ok(())
        };
        let verify_publish = || {
            verify_checkout()?;
            if let Some(head) = pinned_head {
                if crate::git::head_commit(&repo.dir).as_deref() != Some(head) {
                    return Err(RpcError::new("conflict", "The branch no longer matches the commit shown in the pull request form. Refresh and try again."));
                }
            }
            Ok(())
        };
        let title = required_str(params, "title")?.trim();
        if title.is_empty() || title.len() > 1024 {
            return Err(RpcError::invalid("a title is required"));
        }
        let body = params.get("body").and_then(Value::as_str).unwrap_or("");
        if body.len() > 64 * 1024 {
            return Err(RpcError::invalid("the description is too long"));
        }
        let base = match optional_ref(params, "base")? {
            Some(base) => base.to_string(),
            None => crate::git::default_branch(&repo.dir).ok_or_else(|| RpcError::invalid("name a base branch"))?,
        };
        if base == branch {
            return Err(RpcError::invalid("the base branch is the branch itself"));
        }
        let draft = params.get("draft").and_then(Value::as_bool).unwrap_or(false);
        // Existing git/1 clients rely on Create attaching an open PR. The
        // newer desktop leaves that choice to the explicit link action.
        let legacy_link = match params.get("associateExisting") {
            None => true,
            Some(Value::Bool(value)) => *value,
            Some(_) => return Err(RpcError::invalid("associateExisting must be a boolean")),
        };
        let open = |prs: Vec<crate::github::PullRequest>| prs.into_iter().find(|pr| pr.state == "OPEN");
        let answer = |pr: crate::github::PullRequest, existing: bool, reconciled: bool| {
            let mut value = json!({ "repo": repo.name, "pr": pr, "created": !existing, "existing": existing });
            if let Some(session) = session {
                let identity = crate::pr_associations::identity(&pr.url).map_err(RpcError::internal)?;
                if !known_url(&identity) {
                    return Err(RpcError::new("conflict", "GitHub returned a pull request outside the origin repository."));
                }
                let associated = if existing && !for_session && legacy_link && pr.head == branch && verify_identity().is_ok() {
                    crate::pr_associations::reconcile_existing(session, &repo.dir, &identity, &pr.head)
                        .map_err(RpcError::internal)?
                } else {
                    crate::pr_associations::for_session(session, vec![]).map_err(RpcError::internal)?
                        .iter().any(|row| row.url == identity)
                };
                value["sessionAssociated"] = json!(associated);
            }
            if reconciled {
                value["reconciled"] = json!(true);
            }
            Ok(value)
        };
        // Legacy callers can look up a removable link for another branch of
        // the same checkout. The guarded method requires the live branch.
        if for_session { verify_publish()?; } else { verify_identity()?; }
        let read_created = |url: &str| {
            let unresolved = || RpcError::new("outcome_unknown", format!("GitHub reported {url}, but the pull request could not be verified yet. Try again."));
            if !known_url(url) { return Err(RpcError::new("conflict", "The pull request belongs to a different repository than origin.")); }
            let target = Target::new(url).map_err(|_| unresolved())?;
            target.require_exact_cli_host().map_err(|_| unresolved())?;
            let pr = self.pr_view_reference(&repo, &target.url).map_err(|_| unresolved())?;
            Self::verify_pr_url(&pr, url).map_err(|_| unresolved())?;
            if self.project && pr.head_sha.is_empty() { return Err(unresolved()); }
            Ok(pr)
        };
        let pending = if let Some((session, checkout)) = session.zip(checkout.as_ref()) {
            pending_pr_creations(|entries| (entries.iter().rev().find(|entry|
                entry.session == session && entry.checkout == *checkout && entry.branch == branch && entry.base == base
            ).cloned(), false))?
        } else { None };
        let recovered = if let Some(evidence) = pending {
            let pr = read_created(&evidence.url)?;
            Self::finish_pr_creation(&evidence, &pr, verify_checkout)?;
            Some(pr)
        } else { None };
        let existing = if recovered.is_none() {
            open(self.list_prs(&repo, &branch, "open", NETWORK_TIMEOUT, github_repo)?)
        } else { None };
        if let Some(head) = pinned_head {
            let push = |repo: &Repo, branch: &str, head: &str| {
                // Resolved right before transmission, so a push URL or rewrite
                // that leaves the verified origin receives nothing at all.
                self.verify_push_destination(repo, origin.as_deref())?;
                self.push_ref(repo, branch, head)
            };
            self.push_branch(&repo, &branch, head, push, verify_publish)?;
            // Confirm the source GitHub reads through origin before relying
            // on the successful push.
            self.verify_pr_remote_head(&repo, origin.as_deref(), &branch, head)?;
        }
        if let Some(pr) = recovered {
            return answer(pr, false, true);
        }
        // A branch match can locate a PR, but only a successful create URL or
        // existing session evidence establishes ownership.
        if let Some(existing) = existing {
            return answer(existing, true, false);
        }
        verify_publish()?;
        let local = if let Some(head) = pinned_head {
            head.to_owned()
        } else {
            let local = self.local_head(&repo, &branch)?;
            self.verify_pr_remote_head(&repo, origin.as_deref(), &branch, &local)?;
            local
        };
        let mut args = vec!["pr", "create", "--title", title, "--body", body, "--base", &base, "--head", &branch];
        if draft {
            args.push("--draft");
        }
        if let Some(github_repo) = github_repo { args.extend(["--repo", github_repo]); }
        verify_publish()?;
        let reported = match self.gh(&repo, &args, NETWORK_TIMEOUT) {
            Ok(url) => url,
            Err(error) => return match self.list_prs(&repo, &branch, "open", NETWORK_TIMEOUT, github_repo).map(open) {
                Ok(Some(pr)) => answer(pr, true, true),
                _ => Err(error),
            },
        };
        let url = crate::pr_associations::identity(reported.trim())
            .map_err(|_| RpcError::new("outcome_unknown", "GitHub did not return a valid URL for the new pull request."))?;
        if !known_url(&url) { return Err(RpcError::new("conflict", "GitHub returned a pull request outside the origin repository.")); }
        let evidence = session.zip(checkout.as_ref()).filter(|_| verify_checkout().is_ok()).map(|(session, checkout)| PendingPrCreation {
            session: session.into(), checkout: checkout.clone(), branch: branch.clone(), base, head: local, url: url.clone(),
        });
        if let Some(evidence) = &evidence {
            pending_pr_creations(|entries| {
                entries.retain(|entry| entry.session != evidence.session || entry.url != evidence.url);
                entries.push(evidence.clone());
                ((), true)
            })?;
        }
        let pr = read_created(&url)?;
        if let Some(evidence) = &evidence {
            Self::finish_pr_creation(evidence, &pr, verify_checkout)?;
        }
        answer(pr, false, false)
    }

    fn pr_creation_repository(&self, origin: &str) -> Result<String, RpcError> {
        #[cfg(test)]
        if let Some(fixture) = self.github_origin_fixture.as_ref().filter(|_| Path::new(origin).is_absolute()) {
            return Ok(fixture.clone());
        }
        github_repository_from_origin(origin).ok_or_else(|| RpcError::invalid("Choose a GitHub origin repository before creating a pull request."))
    }

    /// Every URL `git push origin` would write to, after `pushurl`,
    /// `pushInsteadOf` and `insteadOf`, must be the one verified fetch origin.
    fn verify_push_destination(&self, repo: &Repo, origin: Option<&str>) -> Result<(), RpcError> {
        let origin = origin.ok_or_else(|| RpcError::invalid("Choose a GitHub origin repository before creating a pull request."))?;
        let urls = self.git(repo, &["remote", "get-url", "--push", "--all", "origin"])?;
        let urls: Vec<_> = urls.lines().filter(|url| !url.is_empty()).collect();
        if urls != [origin] {
            return Err(RpcError::new(
                "conflict",
                "Git would push this branch somewhere other than the verified origin. Check the repository's push URL and URL rewrites.",
            ));
        }
        Ok(())
    }

    fn verify_pr_remote_head(&self, repo: &Repo, origin: Option<&str>, branch: &str, head: &str) -> Result<(), RpcError> {
        if let Some(origin) = origin {
            let effective = self.git(repo, &["ls-remote", "--get-url", "--", origin])?;
            if effective.trim() != origin {
                return Err(RpcError::new("conflict", "Git rewrote the verified origin URL. Check the repository's remote configuration."));
            }
        }
        if self.remote_head_at(repo, origin.unwrap_or("origin"), branch, NETWORK_TIMEOUT)?.as_deref() != Some(head) {
            return Err(RpcError::new("unpushed", format!("push {branch} first: the remote does not have its latest commit")));
        }
        Ok(())
    }

    fn finish_pr_creation(evidence: &PendingPrCreation, pr: &crate::github::PullRequest, verify_checkout: impl Fn() -> Result<(), RpcError>) -> Result<(), RpcError> {
        let PendingPrCreation { session, checkout, url, branch, base, head } = evidence;
        let matches = pr.head == *branch && pr.base == *base && pr.head_sha == *head;
        if matches {
            if verify_checkout().is_err() { return Ok(()); }
            crate::pr_associations::record_local(session, &checkout.path, url, branch)
                .map_err(|error| RpcError::internal(format!("Pull request #{} is open, but could not be saved to the session: {error}", pr.number)))?;
        }
        if matches || matches!(pr.state.as_str(), "CLOSED" | "MERGED") {
            pending_pr_creations(|entries| {
                let count = entries.len();
                entries.retain(|entry| &entry.session != session || &entry.url != url);
                ((), entries.len() != count)
            })?;
        }
        if !matches {
            return Err(RpcError::new("conflict", format!("GitHub opened {url} with a different head, base, or commit.")));
        }
        Ok(())
    }

    /// `git.prReconcileCreation`: settle a create whose readback never
    /// completed, by its URL alone. The original session, its Create form and
    /// the topic branch may all be gone by now (the PR merged and GitHub
    /// deleted the branch), so nothing here depends on them. The record must
    /// belong to one of this project's checkouts (its Git directory is under
    /// the project's), the URL must be a pull request of the project's origin
    /// repository, and GitHub must report it merged or closed. An open PR,
    /// or one GitHub cannot answer for, keeps the record and with it the
    /// cleanup guard.
    fn pr_reconcile_creation(&self, params: &Value) -> Result<Value, RpcError> {
        if !self.project || !self.project_has_git() {
            return Err(RpcError::invalid("Pending pull request creations are only recorded on a paired machine's project."));
        }
        let url = crate::pr_associations::identity(required_str(params, "url")?)
            .map_err(|_| RpcError::invalid("Give the pull request's URL."))?;
        let repo = Repo { name: ".".into(), dir: self.root.clone() };
        let common = self.git(&repo, &["rev-parse", "--path-format=absolute", "--git-common-dir"])?;
        let common = Path::new(common.trim()).canonicalize().map_err(RpcError::internal)?;
        let owned = |entry: &PendingPrCreation| entry.url == url && entry.checkout.git_dir.starts_with(&common);
        let evidence = pending_pr_creations(|entries| (entries.iter().filter(|entry| owned(entry)).cloned().collect::<Vec<_>>(), false))?;
        if evidence.is_empty() {
            // Nothing of this project waits on it: already reconciled, or never ours.
            return Ok(json!({ "url": url, "cleared": 0 }));
        }
        let origin = self.git(&repo, &["remote", "get-url", "origin"])?;
        let github_repo = self.pr_creation_repository(origin.trim())?;
        if !url.starts_with(&format!("https://{github_repo}/pull/")) {
            return Err(RpcError::new("conflict", "The pull request belongs to a different repository than this project's origin."));
        }
        let unresolved = || RpcError::new("outcome_unknown", format!("GitHub could not confirm {url} yet, so this workspace stays protected. Try again."));
        let target = Target::new(&url).map_err(|_| unresolved())?;
        target.require_exact_cli_host().map_err(|_| unresolved())?;
        let pr = self.pr_view_reference(&repo, &target.url).map_err(|_| unresolved())?;
        Self::verify_pr_url(&pr, &url).map_err(|_| unresolved())?;
        if !matches!(pr.state.as_str(), "MERGED" | "CLOSED") {
            return Err(RpcError::new("conflict", format!("Pull request #{} is still open. Merge or close it before removing its workspace.", pr.number))
                .with_data(json!({ "url": url, "state": pr.state })));
        }
        // Where the session and its exact checkout survive and GitHub shows
        // the very head, base and commit that were created, keep the PR on
        // the session, as a completed retry would have.
        for entry in &evidence {
            let matches = pr.head == entry.branch && pr.base == entry.base && pr.head_sha == entry.head;
            if matches && self.project_session(&entry.session).is_ok() && Self::same_checkout(&entry.checkout) {
                crate::pr_associations::record_local(&entry.session, &entry.checkout.path, &url, &entry.branch)
                    .map_err(|error| RpcError::internal(format!("Pull request #{} could not be saved to its session: {error}", pr.number)))?;
            }
        }
        let cleared = pending_pr_creations(|entries| {
            let count = entries.len();
            entries.retain(|entry| !owned(entry));
            (count - entries.len(), entries.len() != count)
        })?;
        Ok(json!({ "url": url, "state": pr.state, "cleared": cleared }))
    }

    /// Whether the recorded checkout is still the very directory it was.
    fn same_checkout(checkout: &CheckoutIdentity) -> bool {
        let Ok(path) = checkout.path.canonicalize() else { return false };
        let git_dir = crate::git::run(&path, &["rev-parse", "--absolute-git-dir"]).ok()
            .and_then(|dir| Path::new(dir.trim()).canonicalize().ok());
        path == checkout.path && git_dir.as_deref() == Some(checkout.git_dir.as_path())
            && directory_identity(&path).ok() == Some(checkout.directory)
            && directory_identity(&checkout.git_dir).ok() == Some(checkout.admin)
    }

    fn pr_number(params: &Value) -> Result<String, RpcError> {
        params
            .get("number")
            .and_then(Value::as_u64)
            .filter(|number| *number > 0)
            .map(|number| number.to_string())
            .ok_or_else(|| RpcError::invalid("number is required"))
    }

    fn verify_pr_url(pr: &crate::github::PullRequest, url: &str) -> Result<(), RpcError> {
        if !crate::pr_associations::identity(&pr.url).is_ok_and(|found| found == url) {
            return Err(RpcError::not_found("GitHub returned a different pull request for this checkout."));
        }
        Ok(())
    }

    fn default_pr_repository(&self, repo: &Repo, timeout: Duration) -> Result<String, RpcError> {
        let info = self.gh(repo, &["repo", "view", "--json", "url"], timeout)?;
        let info: Value = serde_json::from_str(&info).map_err(RpcError::internal)?;
        let url = info["url"].as_str().ok_or_else(|| RpcError::invalid("GitHub did not return a repository URL."))?;
        let target = crate::github::conversation::Target::new(&format!("{}/pull/1", url.trim_end_matches('/')))
            .map_err(|error| RpcError::invalid(error.to_string()))?;
        Ok(target.repository_url())
    }

    fn require_pr_repository(&self, repo: &Repo, expected: &str) -> Result<(), RpcError> {
        if self.default_pr_repository(repo, NETWORK_TIMEOUT)? != expected {
            return Err(RpcError::invalid("The pull request belongs to another repository."));
        }
        Ok(())
    }

    fn pr_selector(&self, repo: &Repo, params: &Value) -> Result<String, RpcError> {
        if params.get("url").is_none() {
            return Self::pr_number(params);
        }
        let target = crate::github::conversation::Target::new(required_str(params, "url")?).map_err(|error| RpcError::invalid(error.to_string()))?;
        target.require_exact_cli_host().map_err(|error| RpcError::invalid(error.to_string()))?;
        if params.get("number").is_some() && Self::pr_number(params)? != target.number {
            return Err(RpcError::invalid("Pull request number does not match its URL."));
        }
        self.require_pr_repository(repo, &target.repository_url())?;
        Ok(target.url)
    }

    fn pr_view(&self, repo: &Repo, selector: &str) -> Result<crate::github::PullRequest, RpcError> {
        let number = selector.rsplit('/').next().unwrap_or(selector);
        let pr = self.pr_view_reference(repo, number)?;
        if selector.starts_with("https://") {
            Self::verify_pr_url(&pr, selector)?;
        }
        Ok(pr)
    }

    fn pr_view_reference(&self, repo: &Repo, reference: &str) -> Result<crate::github::PullRequest, RpcError> {
        let out = self.gh(repo, &["pr", "view", reference, "--json", crate::github::FIELDS], NETWORK_TIMEOUT)?;
        let value: Value = serde_json::from_str(&out).map_err(|error| RpcError::new("git_failed", format!("gh pr view: {error}")))?;
        Ok(crate::github::parse_pr(&value))
    }

    fn verified_pr(&self, repo: &Repo, url: &str) -> Result<(Target, String, crate::github::PullRequest), RpcError> {
        let target = Target::new(url).map_err(RpcError::internal)?;
        let fields = format!("id,{}", crate::github::FIELDS);
        let out = self.gh(repo, &["pr", "view", &target.number, "--json", &fields], NETWORK_TIMEOUT)?;
        let value: Value = serde_json::from_str(&out).map_err(RpcError::internal)?;
        let pr = crate::github::parse_pr(&value);
        Self::verify_pr_url(&pr, url)?;
        let id = target.verified_pr_id(&value).map_err(|error| RpcError::invalid(error.to_string()))?.to_owned();
        Ok((target, id, pr))
    }

    fn pr_graphql(&self, repo: &Repo, target: &Target, query: &str, fields: &[String]) -> Result<Value, RpcError> {
        target.graphql(query, fields, |args| self.gh(repo, args, NETWORK_TIMEOUT))
    }

    fn pr_by_id(&self, repo: &Repo, target: &Target, id: &str, fields: &str) -> Result<Value, RpcError> {
        let query = format!("query($id: ID!) {{ node(id: $id) {{ ... on PullRequest {{ id {fields} }} }} }}");
        let reply = self.pr_graphql(repo, target, &query, &[format!("id={id}")])?;
        let pr = &reply["data"]["node"];
        if pr["id"].as_str() != Some(id) {
            return Err(RpcError::invalid("GitHub returned a different pull request."));
        }
        Ok(pr.clone())
    }

    fn ready_verified_pr(&self, repo: &Repo, url: &str) -> Result<Value, RpcError> {
        let (target, id, mut pr) = self.verified_pr(repo, url)?;
        if pr.is_draft {
            const READY: &str = "mutation($id: ID!) { change: markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id isDraft } } }";
            let result = self.pr_graphql(repo, &target, READY, &[format!("id={id}")]);
            let ready = match &result {
                Ok(reply) => {
                    let current = &reply["data"]["change"]["pullRequest"];
                    current["id"].as_str() == Some(&id) && current["isDraft"] == false
                }
                Err(_) => self.pr_by_id(repo, &target, &id, "isDraft").is_ok_and(|current| current["isDraft"] == false),
            };
            if !ready {
                return Err(result.err().unwrap_or_else(|| RpcError::new("outcome_unknown", "GitHub did not confirm this pull request is ready.")));
            }
            pr.is_draft = false;
        }
        Ok(json!({ "repo": repo.name, "pr": pr }))
    }

    fn merge_verified_pr(&self, repo: &Repo, url: &str, method: &str, head: Option<&str>) -> Result<Value, RpcError> {
        let (target, id, mut pr) = self.verified_pr(repo, url)?;
        if head.is_some_and(|head| head != pr.head_sha) {
            return Err(RpcError::new("conflict", "The pull request head changed. Refresh and try again."));
        }
        if pr.state == "MERGED" && method != "queue" {
            return Ok(json!({ "repo": repo.name, "pr": pr }));
        }
        let queue = self.pr_by_id(repo, &target, &id, "state mergeStateStatus isMergeQueueEnabled mergeQueueEntry { position state } autoMergeRequest { enabledAt }")?;
        let queue_required = queue["isMergeQueueEnabled"].as_bool()
            .ok_or_else(|| RpcError::new("outcome_unknown", "GitHub did not confirm whether this branch needs a merge queue."))?;
        let mut fields = vec![format!("id={id}")];
        if let Some(head) = head {
            fields.push(format!("head={head}"));
        }
        if method == "queue" || queue_required {
            crate::github::ensure_queue_enabled(&queue).map_err(|error| RpcError::new("conflict", error.to_string()))?;
            const ENQUEUE: &str = "mutation($id: ID!, $head: GitObjectID) { change: enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $head}) { mergeQueueEntry { position state } } }";
            const AUTO: &str = "mutation($id: ID!, $head: GitObjectID) { change: enablePullRequestAutoMerge(input: {pullRequestId: $id, expectedHeadOid: $head}) { pullRequest { id autoMergeRequest { enabledAt } } } }";
            pr.merge_queue_enabled = Some(true);
            pr.merge_queue_entry = serde_json::from_value(queue["mergeQueueEntry"].clone()).map_err(RpcError::internal)?;
            pr.auto_merge_enabled = queue["autoMergeRequest"].is_object();
            if pr.merge_queue_entry.is_none() && !pr.auto_merge_enabled {
                if matches!(queue["mergeStateStatus"].as_str(), Some("CLEAN" | "HAS_HOOKS" | "UNSTABLE")) {
                    let reply = self.pr_graphql(repo, &target, ENQUEUE, &fields)?;
                    pr.merge_queue_entry = Some(serde_json::from_value(reply["data"]["change"]["mergeQueueEntry"].clone()).map_err(RpcError::internal)?);
                } else {
                    let reply = self.pr_graphql(repo, &target, AUTO, &fields)?;
                    let current = &reply["data"]["change"]["pullRequest"];
                    if current["id"].as_str() != Some(&id) || !current["autoMergeRequest"].is_object() {
                        return Err(RpcError::new("outcome_unknown", "GitHub did not confirm auto-merge for this pull request."));
                    }
                    pr.auto_merge_enabled = true;
                }
            }
        } else {
            fields.push(format!("method={}", method.to_ascii_uppercase()));
            const MERGE: &str = "mutation($id: ID!, $head: GitObjectID, $method: PullRequestMergeMethod!) { change: mergePullRequest(input: {pullRequestId: $id, expectedHeadOid: $head, mergeMethod: $method}) { pullRequest { id state } } }";
            let result = self.pr_graphql(repo, &target, MERGE, &fields);
            let merged = match &result {
                Ok(reply) => {
                    let current = &reply["data"]["change"]["pullRequest"];
                    current["id"].as_str() == Some(&id) && current["state"] == "MERGED"
                }
                Err(_) => self.pr_by_id(repo, &target, &id, "state").is_ok_and(|current| current["state"] == "MERGED"),
            };
            if !merged {
                return Err(result.err().unwrap_or_else(|| RpcError::new("outcome_unknown", "GitHub did not confirm this pull request was merged.")));
            }
            pr.state = "MERGED".into();
        }
        Ok(json!({ "repo": repo.name, "pr": pr }))
    }

    fn pr_ready(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let selector = self.pr_selector(&repo, params)?;
        if selector.starts_with("https://") {
            return self.ready_verified_pr(&repo, &selector);
        }
        let result = self.gh(&repo, &["pr", "ready", &selector], NETWORK_TIMEOUT);
        let pr = self.pr_view(&repo, &selector);
        match (result, pr) {
            (_, Ok(pr)) if !pr.is_draft => Ok(json!({ "repo": repo.name, "pr": pr })),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Ok(_), Ok(_)) => Err(RpcError::new("outcome_unknown", "GitHub still reports a draft")),
        }
    }

    fn pr_merge(&self, params: &Value) -> Result<Value, RpcError> {
        let repo = self.repo(params)?;
        let selector = self.pr_selector(&repo, params)?;
        let method = params.get("method").and_then(Value::as_str).unwrap_or("merge");
        // A merge pinned to the head the person saw: GitHub refuses it once the head has moved.
        let head = match params.get("head") {
            None | Some(Value::Null) => None,
            Some(Value::String(head)) if valid_object_id(head) => Some(head.as_str()),
            _ => return Err(RpcError::invalid("head is a commit id")),
        };
        let flag = match method {
            "merge" => "--merge",
            "squash" => "--squash",
            "rebase" => "--rebase",
            "queue" => "--auto",
            _ => return Err(RpcError::invalid("method is merge, squash, rebase or queue")),
        };
        if selector.starts_with("https://") {
            return self.merge_verified_pr(&repo, &selector, method, head);
        }
        if method == "queue" {
            let pr = self.pr_view(&repo, &selector)?;
            let (host, query) = crate::github::queue_query(&pr.url).map_err(RpcError::internal)?;
            let out = self.gh(&repo, &["api", "graphql", "--hostname", &host, "-f", &query], NETWORK_TIMEOUT)?;
            let queue = crate::github::parse_queue_response(&out).map_err(RpcError::internal)?;
            crate::github::ensure_queue_enabled(&queue).map_err(|error| RpcError::new("conflict", error.to_string()))?;
        }
        let mut args = vec!["pr", "merge", selector.as_str(), flag];
        if let Some(head) = head {
            args.extend(["--match-head-commit", head]);
        }
        let result = self.gh(&repo, &args, NETWORK_TIMEOUT);
        // `gh pr merge` can fail with the merge already through; ask again.
        match (result, self.pr_view(&repo, &selector)) {
            (_, Ok(pr)) if pr.state == "MERGED" => Ok(json!({ "repo": repo.name, "pr": pr })),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error),
            (Ok(_), Ok(pr)) => Ok(json!({ "repo": repo.name, "pr": pr })),
        }
    }

    // ---- lifecycle.dispositionFacts --------------------------------------

    /// Unpublished work per repository, for the dialog before archive or
    /// delete. Read-only and bounded; a forge that cannot be asked in time is
    /// `openPullRequests: null`, never an error.
    pub fn disposition_repositories(&self) -> Vec<Value> {
        let _request = crate::github_process::scope();
        let (names, _) = self.repositories();
        // Side by side, so the whole answer takes about one repository's budget.
        std::thread::scope(|scope| {
            let running: Vec<_> = names.iter().map(|name| scope.spawn(crate::github_process::queued(move || self.repository_facts(name)))).collect();
            running.into_iter().zip(&names).map(|(handle, name)| handle.join().unwrap_or_else(|_| json!({ "path": name }))).collect()
        })
    }

    fn repository_facts(&self, name: &str) -> Value {
        let repo = Repo { name: name.to_string(), dir: self.dir(name) };
        let deadline = Instant::now() + FACTS_TIMEOUT;
        let left = || deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1));
        let git = |args: &[&str]| self.run_git(&repo.dir, args, left(), &[]).ok().filter(|ran| ran.ok).map(|ran| ran.stdout);
        let branch = git(&["symbolic-ref", "--short", "-q", "HEAD"]).map(|out| out.trim().to_string()).filter(|out| !out.is_empty());
        let porcelain = git(&["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
        let (dirty, untracked) = match &porcelain {
            Some(out) => {
                let mut dirty = 0u32;
                let mut untracked = 0u32;
                let mut parts = out.split('\0').filter(|part| !part.is_empty());
                while let Some(entry) = parts.next() {
                    dirty += 1;
                    if entry.starts_with("??") {
                        untracked += 1;
                    }
                    if entry.starts_with('R') || entry.starts_with('C') {
                        parts.next();
                    }
                }
                (Some(dirty), Some(untracked))
            }
            None => (None, None),
        };
        let has_upstream = git(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).is_some();
        let count = |out: Option<String>| out.and_then(|out| out.trim().parse::<u32>().ok());
        let unpushed = if has_upstream { count(git(&["rev-list", "--count", "@{upstream}..HEAD"])) } else { None };
        // Commits no remote-tracking ref has, whatever the upstream: what a delete would lose.
        let local_only = if git(&["rev-parse", "--verify", "--quiet", "HEAD"]).is_some() {
            count(git(&["rev-list", "--count", "HEAD", "--not", "--remotes"]))
        } else {
            Some(0)
        };
        let open_prs = branch.as_ref().and_then(|branch| {
            let out = self.gh(&repo, &["pr", "list", "--head", branch, "--state", "open", "--json", "number,url,state,isCrossRepository", "--limit", "20"], left()).ok()?;
            let value: Value = serde_json::from_str(&out).ok()?;
            Some(
                own_prs(value.as_array()?)
                    .map(|pr| json!({ "number": pr["number"], "url": pr["url"], "state": pr["state"].as_str().unwrap_or("OPEN").to_ascii_lowercase() }))
                    .collect::<Vec<_>>(),
            )
        });
        json!({
            "path": name,
            "branch": branch,
            "dirtyFiles": dirty,
            "untrackedFiles": untracked,
            "unpushedCommits": unpushed,
            "hasUpstream": has_upstream,
            "localOnlyCommits": local_only,
            "openPullRequests": open_prs,
        })
    }
}

/// `gh pr list --head` matches the branch name only: a fork's pull request
/// from a branch of the same name is someone else's.
fn own_prs(prs: &[Value]) -> impl Iterator<Item = &Value> {
    prs.iter().filter(|pr| pr["isCrossRepository"].as_bool() != Some(true))
}

fn git_error(error: anyhow::Error) -> RpcError {
    let text = format!("{error:#}");
    failure_error("git", &text, classify(&text, false))
}

#[cfg(test)]
#[path = "git_tests.rs"]
mod tests;
