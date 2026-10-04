//! Git, by shelling out. The only other thing this module shells out to is
//! nothing: `gh` lives in `github.rs`.
//!
//! Every diff invocation ends in `--`, or a working-tree file named like a sha
//! makes git die with "ambiguous argument".

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};

pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

fn git() -> Command {
    let mut c = Command::new(crate::binpath::resolve("git").unwrap_or_else(|| PathBuf::from("git")));
    c.env("PATH", crate::binpath::login_path());
    c.env("GIT_TERMINAL_PROMPT", "0");
    c.env("LC_ALL", "C");
    c
}

pub fn run(cwd: &Path, args: &[&str]) -> Result<String> {
    let out = git().current_dir(cwd).args(args).output().with_context(|| format!("git {}", args.join(" ")))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        bail!("git {}: {}", args.join(" "), if err.is_empty() { format!("exit {}", out.status) } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Why `run_within` did not succeed.
#[derive(Debug)]
pub enum RunError {
    /// Still running at the deadline; killed.
    TimedOut,
    /// `stop` said to give up; killed.
    Stopped,
    /// Git exited with an error: what it wrote to stderr.
    Failed(String),
    /// Git could not be started.
    Spawn(std::io::Error),
}

/// `run` for a transfer that may never end: it has a deadline, and `stop` is
/// asked while it runs. Either way the whole process group is killed, so no
/// transport or credential helper is left behind.
pub fn run_within(cwd: &Path, args: &[&str], timeout: std::time::Duration, stop: &dyn Fn() -> bool) -> std::result::Result<(), RunError> {
    use std::io::Read;
    let mut command = git();
    command.current_dir(cwd).args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let mut child = command.spawn().map_err(RunError::Spawn)?;
    // Read as it comes, so a full pipe never blocks git.
    let stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text);
        }
        text
    });
    let deadline = std::time::Instant::now() + timeout;
    let outcome = loop {
        let ended = match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if std::time::Instant::now() >= deadline => RunError::TimedOut,
            Ok(None) if stop() => RunError::Stopped,
            Ok(None) => {
                std::thread::sleep(std::time::Duration::from_millis(50));
                continue;
            }
            Err(error) => RunError::Spawn(error),
        };
        #[cfg(unix)]
        // SAFETY: signals the process group this function just created.
        unsafe {
            libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
        }
        let _ = child.kill();
        let _ = child.wait();
        break Err(ended);
    };
    let err = reader.join().unwrap_or_default();
    match outcome? {
        status if status.success() => Ok(()),
        status => Err(RunError::Failed(if err.trim().is_empty() { format!("exit {status}") } else { err.trim().to_string() })),
    }
}

fn run_ok(cwd: &Path, args: &[&str]) -> bool {
    git().current_dir(cwd).args(args).output().map(|o| o.status.success()).unwrap_or(false)
}

pub fn is_repo(cwd: &Path) -> bool {
    run_ok(cwd, &["rev-parse", "--is-inside-work-tree"])
}

pub fn current_branch(cwd: &Path) -> Option<String> {
    run(cwd, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn default_branch(cwd: &Path) -> Option<String> {
    if let Ok(s) = run(cwd, &["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]) {
        let s = s.trim();
        return Some(s.strip_prefix("origin/").unwrap_or(s).to_string());
    }
    for cand in ["main", "master"] {
        if run_ok(cwd, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{cand}")]) {
            return Some(cand.to_string());
        }
    }
    current_branch(cwd)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub current: bool,
    pub remote: bool,
}

pub fn list_branches(cwd: &Path) -> Result<Vec<BranchInfo>> {
    let cur = current_branch(cwd);
    let out = run(cwd, &["for-each-ref", "--format=%(refname:short)%09%(refname)", "refs/heads", "refs/remotes"])?;
    let mut v = Vec::new();
    for line in out.lines() {
        let (short, full) = line.split_once('\t').unwrap_or((line, ""));
        if short.ends_with("/HEAD") {
            continue;
        }
        v.push(BranchInfo {
            name: short.to_string(),
            current: cur.as_deref() == Some(short),
            remote: full.starts_with("refs/remotes/"),
        });
    }
    Ok(v)
}

/// Tree id of the working tree right now, via a temp index so the real index,
/// working tree and stash are untouched. Copying the index rather than starting
/// empty keeps this fast: the copy carries git's stat cache.
pub fn snapshot_tree(cwd: &Path) -> Result<String> {
    let index = run(cwd, &["rev-parse", "--git-path", "index"])?.trim().to_string();
    let index_path = if Path::new(&index).is_absolute() { PathBuf::from(&index) } else { cwd.join(&index) };
    let tmp = std::env::temp_dir().join(format!("raccoon-index-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
    if index_path.exists() {
        std::fs::copy(&index_path, &tmp)?;
    }
    let result = (|| {
        let mut c = git();
        c.current_dir(cwd).env("GIT_INDEX_FILE", &tmp).args(["add", "-A", "--", "."]);
        let o = c.output()?;
        if !o.status.success() {
            bail!("snapshot add: {}", String::from_utf8_lossy(&o.stderr));
        }
        let mut c = git();
        c.current_dir(cwd).env("GIT_INDEX_FILE", &tmp).args(["write-tree"]);
        let o = c.output()?;
        if !o.status.success() {
            bail!("write-tree: {}", String::from_utf8_lossy(&o.stderr));
        }
        Ok(String::from_utf8_lossy(&o.stdout).trim().to_string())
    })();
    let _ = std::fs::remove_file(&tmp);
    result
}

pub fn head_tree(cwd: &Path) -> Result<String> {
    match run(cwd, &["rev-parse", "HEAD^{tree}"]) {
        Ok(s) => Ok(s.trim().to_string()),
        Err(_) if is_repo(cwd) => Ok(EMPTY_TREE.into()),
        Err(e) => Err(e),
    }
}

pub fn head_commit(cwd: &Path) -> Option<String> {
    run(cwd, &["rev-parse", "HEAD"]).ok().map(|s| s.trim().to_string())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChangeStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: ChangeStatus,
    pub additions: u32,
    pub deletions: u32,
}

fn is_tree_id(s: &str) -> bool {
    (7..=64).contains(&s.len()) && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// Changed files between two trees (or a tree and the working tree when
/// `head` is `None`), with per-file line counts.
pub fn changes_between(cwd: &Path, base: &str, head: Option<&str>) -> Result<Vec<ChangedFile>> {
    if !is_tree_id(base) {
        bail!("bad base tree id");
    }
    if let Some(h) = head {
        if !is_tree_id(h) {
            bail!("bad head tree id");
        }
    }
    let mut args = vec!["diff", "--numstat", "-M", "--name-status", "-z", base];
    if let Some(h) = head {
        args.push(h);
    }
    args.push("--");
    // --numstat and --name-status can't be combined in one call; run both.
    let status_out = run(cwd, &args.iter().filter(|a| **a != "--numstat").cloned().collect::<Vec<_>>())?;
    let num_out = run(cwd, &args.iter().filter(|a| **a != "--name-status").cloned().collect::<Vec<_>>())?;

    let mut counts = std::collections::HashMap::new();
    for rec in num_out.split('\0').filter(|s| !s.is_empty()) {
        // "adds\tdels\tpath" — renames put the two paths as following NUL fields.
        let mut it = rec.splitn(3, '\t');
        let a = it.next().unwrap_or("0");
        let d = it.next().unwrap_or("0");
        let p = it.next().unwrap_or("");
        counts.insert(p.to_string(), (a.parse().unwrap_or(0), d.parse().unwrap_or(0)));
    }
    let mut out = Vec::new();
    let fields: Vec<&str> = status_out.split('\0').collect();
    let mut i = 0;
    while i < fields.len() {
        let st = fields[i];
        if st.is_empty() {
            i += 1;
            continue;
        }
        let code = st.chars().next().unwrap_or('M');
        match code {
            'R' | 'C' => {
                let old = fields.get(i + 1).copied().unwrap_or("").to_string();
                let new = fields.get(i + 2).copied().unwrap_or("").to_string();
                let (a, d) = counts.get(&new).copied().unwrap_or((0, 0));
                out.push(ChangedFile { path: new, old_path: Some(old), status: ChangeStatus::Renamed, additions: a, deletions: d });
                i += 3;
            }
            _ => {
                let p = fields.get(i + 1).copied().unwrap_or("").to_string();
                let (a, d) = counts.get(&p).copied().unwrap_or((0, 0));
                let status = match code {
                    'A' => ChangeStatus::Added,
                    'D' => ChangeStatus::Deleted,
                    _ => ChangeStatus::Modified,
                };
                out.push(ChangedFile { path: p, old_path: None, status, additions: a, deletions: d });
                i += 2;
            }
        }
    }
    Ok(out)
}

/// Contents of `path` at `tree`, or `None` if it doesn't exist there.
pub fn blob_at(cwd: &Path, tree: &str, path: &str) -> Result<Option<String>> {
    if !is_tree_id(tree) {
        bail!("bad tree id");
    }
    let spec = format!("{tree}:{path}");
    let out = git().current_dir(cwd).args(["cat-file", "-p", &spec]).output()?;
    if !out.status.success() {
        return Ok(None);
    }
    if out.stdout.len() > 4 * 1024 * 1024 {
        return Ok(Some(String::from("<file too large to show>")));
    }
    Ok(Some(String::from_utf8_lossy(&out.stdout).into_owned()))
}

pub fn working_file(cwd: &Path, path: &str) -> Option<String> {
    let p = cwd.join(path);
    let meta = std::fs::metadata(&p).ok()?;
    if meta.len() > 4 * 1024 * 1024 {
        return Some("<file too large to show>".into());
    }
    std::fs::read(&p).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkStatus {
    pub is_repo: bool,
    pub dirty: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub default_branch: Option<String>,
    /// Commits on this branch that `origin/<default>` doesn't have.
    pub ahead_of_base: Option<u32>,
    pub head: Option<String>,
}

pub fn upstream_counts(cwd: &Path) -> (u32, u32) {
    if run(cwd, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).is_err() {
        return (0, 0);
    }
    run(cwd, &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])
        .ok()
        .and_then(|s| {
            let mut it = s.split_whitespace();
            Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
        })
        .unwrap_or((0, 0))
}

/// One command answering everything the header and handoff row need, so no
/// button is drawn from one snapshot beside another from a different one.
/// Infallible: a non-repo answers defaults.
pub fn work_status(cwd: &Path) -> WorkStatus {
    if !is_repo(cwd) {
        return WorkStatus::default();
    }
    let branch = current_branch(cwd);
    let dirty = run(cwd, &["status", "--porcelain", "--untracked-files=normal", "--"]).map(|s| !s.trim().is_empty()).unwrap_or(false);
    let upstream = run(cwd, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]).ok().map(|s| s.trim().to_string());
    let (ahead, behind) = upstream_counts(cwd);
    let default = default_branch(cwd);
    let ahead_of_base = default.as_ref().and_then(|d| {
        let base = if run_ok(cwd, &["show-ref", "--verify", "--quiet", &format!("refs/remotes/origin/{d}")]) {
            format!("origin/{d}")
        } else {
            d.clone()
        };
        run(cwd, &["rev-list", "--count", &format!("{base}..HEAD")]).ok().and_then(|s| s.trim().parse().ok())
    });
    WorkStatus { is_repo: true, dirty, branch, upstream, ahead, behind, default_branch: default, ahead_of_base, head: head_commit(cwd) }
}

// ---------------------------------------------------------------- worktrees

pub fn worktree_root(project: &Path) -> PathBuf {
    project.join(crate::store::settings::load().worktree_dir)
}

pub fn worktree_path(project: &Path, name: &str) -> PathBuf {
    worktree_root(project).join(name)
}

pub fn worktree_branch(name: &str) -> String {
    format!("{}{}", crate::store::settings::load().branch_prefix, name)
}

/// Every `raccoon/*` branch, local and remote-tracking, so a name whose PR
/// already landed is never redrawn.
pub fn worktree_branch_names(project: &Path) -> Vec<String> {
    let prefix = crate::store::settings::load().branch_prefix;
    run(project, &["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"])
        .map(|s| {
            s.lines()
                .filter_map(|l| {
                    let l = l.trim();
                    let l = l.split_once('/').filter(|(r, _)| *r == "origin").map(|(_, rest)| rest).unwrap_or(l);
                    l.strip_prefix(&prefix).map(|n| n.to_string())
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Names taken on disk, in branches, or in the index.
pub fn taken_worktree_names(project: &Path, index_names: &[String]) -> Vec<String> {
    let mut v: Vec<String> = index_names.to_vec();
    v.extend(worktree_branch_names(project));
    if let Ok(rd) = std::fs::read_dir(worktree_root(project)) {
        v.extend(rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()));
    }
    v
}

/// Base ref for a new worktree: `origin/<default>` when it exists, else the
/// local default branch, else HEAD.
pub fn resolve_base(project: &Path, requested: Option<&str>) -> Result<String> {
    if let Some(r) = requested.filter(|r| !r.is_empty()) {
        if !run_ok(project, &["rev-parse", "--verify", "--quiet", &format!("{r}^{{commit}}")]) {
            bail!("unknown base ref {r}");
        }
        return Ok(r.to_string());
    }
    if let Some(d) = default_branch(project) {
        let remote = format!("origin/{d}");
        if run_ok(project, &["rev-parse", "--verify", "--quiet", &format!("{remote}^{{commit}}")]) {
            return Ok(remote);
        }
        if run_ok(project, &["rev-parse", "--verify", "--quiet", &format!("{d}^{{commit}}")]) {
            return Ok(d);
        }
    }
    Ok("HEAD".into())
}

/// Creation-time provenance; this does not describe later branch updates.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeBase {
    pub commit: String,
    pub fetched: bool,
    pub warning: Option<String>,
}

const WORKTREE_FETCH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Refresh only the default remote-tracking ref, independent of configured
/// fetch refspecs. Never update a local branch or the project's checkout.
fn fetch_worktree_base(project: &Path, requested: Option<&str>, timeout: std::time::Duration) -> (bool, Option<String>) {
    if requested.is_some_and(|r| !r.is_empty()) || !run_ok(project, &["remote", "get-url", "origin"]) {
        return (false, None);
    }
    let result = match default_branch(project) {
        Some(branch) => run_within(
            project,
            &[
                "-c", "credential.interactive=false", "fetch", "--no-tags", "--no-recurse-submodules",
                "--no-write-fetch-head", "--refmap=", "origin", &format!("+refs/heads/{branch}:refs/remotes/origin/{branch}"),
            ],
            timeout,
            &|| false,
        ),
        None => Err(RunError::Failed("default branch is unknown".into())),
    };
    match result {
        Ok(()) => (true, None),
        Err(error) => {
            let reason = match error {
                RunError::TimedOut => "fetch timed out".to_string(),
                RunError::Stopped => "fetch stopped".to_string(),
                RunError::Failed(message) => message,
                RunError::Spawn(error) => error.to_string(),
            };
            (false, Some(format!("Could not fetch origin's default branch ({reason}). This worktree was created from a local ref and may be out of date.")))
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedWorktree {
    pub name: String,
    pub path: String,
    pub branch: String,
    pub base: String,
    /// Tree id of the base commit, the first turn's changes baseline.
    pub base_tree: String,
    pub worktree_base: Option<WorktreeBase>,
}

/// A path as an argument for `git`, which takes strings. A checkout under a
/// name this platform allows but UTF-8 does not is the reader's to hear about,
/// not something to take the app down over.
fn arg(path: &Path) -> Result<&str> {
    path.to_str().with_context(|| format!("{} is not a name git can be given", path.display()))
}

pub fn create_worktree(project: &Path, name: &str, base: Option<&str>) -> Result<CreatedWorktree> {
    create_worktree_with_timeout(project, name, base, WORKTREE_FETCH_TIMEOUT)
}

fn create_worktree_with_timeout(project: &Path, name: &str, base: Option<&str>, timeout: std::time::Duration) -> Result<CreatedWorktree> {
    if !crate::names::is_worktree_name(name) && name.contains(|c: char| !c.is_ascii_alphanumeric() && c != '-' && c != '_') {
        bail!("bad worktree name");
    }
    let (fetched, warning) = fetch_worktree_base(project, base, timeout);
    let base = resolve_base(project, base)?;
    let path = worktree_path(project, name);
    std::fs::create_dir_all(worktree_root(project))?;
    let branch = worktree_branch(name);
    run(project, &["worktree", "add", "--no-track", "-B", &branch, arg(&path)?, &base])?;
    ensure_worktree_dir_ignored(project);
    let base_tree = run(&path, &["rev-parse", "HEAD^{tree}"])?.trim().to_string();
    let commit = run(&path, &["rev-parse", "HEAD"])?.trim().to_string();
    Ok(CreatedWorktree {
        name: name.to_string(), path: path.to_string_lossy().into_owned(), branch, base, base_tree,
        worktree_base: Some(WorktreeBase { commit, fetched, warning }),
    })
}

/// Move a TerminalX-managed worktree and rename its matching branch. The
/// checkout may be dirty; `git worktree move` preserves its contents.
pub fn rename_worktree(project: &Path, path: &Path, name: &str) -> Result<CreatedWorktree> {
    if name.is_empty() || name.contains('/') || name == "." || name == ".." {
        bail!("bad worktree name");
    }
    let project = std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    let path = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if path == project {
        bail!("the project's own checkout cannot be renamed here");
    }
    let managed_root = std::fs::canonicalize(worktree_root(&project)).unwrap_or_else(|_| worktree_root(&project));
    if path.parent() != Some(managed_root.as_path()) {
        bail!("only TerminalX-managed workspaces can be renamed");
    }
    let old_name = path.file_name().and_then(|part| part.to_str()).ok_or_else(|| anyhow::anyhow!("workspace has no usable name"))?;
    let old_branch = worktree_branch(old_name);
    let branch = current_branch(&path).ok_or_else(|| anyhow::anyhow!("workspace has no branch"))?;
    if branch != old_branch {
        bail!("workspace branch does not match its TerminalX name");
    }
    if old_name == name {
        let base_tree = run(&path, &["rev-parse", "HEAD^{tree}"])?.trim().to_string();
        return Ok(CreatedWorktree { name: name.to_string(), path: path.to_string_lossy().into_owned(), branch, base: "HEAD".into(), base_tree, worktree_base: None });
    }
    let destination = worktree_path(&project, name);
    if destination.exists() {
        bail!("workspace {name} already exists");
    }
    let new_branch = worktree_branch(name);
    run(&project, &["worktree", "move", arg(&path)?, arg(&destination)?])?;
    if let Err(rename_error) = run(&destination, &["branch", "-m", &new_branch]) {
        let rollback = run(&project, &["worktree", "move", arg(&destination)?, arg(&path)?]);
        if let Err(rollback_error) = rollback {
            bail!("rename branch failed: {rename_error:#}; moving the workspace back also failed: {rollback_error:#}");
        }
        return Err(rename_error);
    }
    let base_tree = run(&destination, &["rev-parse", "HEAD^{tree}"])?.trim().to_string();
    Ok(CreatedWorktree {
        name: name.to_string(),
        path: destination.to_string_lossy().into_owned(),
        branch: new_branch,
        base: "HEAD".into(),
        base_tree,
        worktree_base: None,
    })
}

/// Keep the worktree directory out of the project's own status without
/// touching `.gitignore`: `.git/info/exclude` is local to this clone.
fn ensure_worktree_dir_ignored(project: &Path) {
    let dir = crate::store::settings::load().worktree_dir;
    let top = dir.split('/').next().unwrap_or(".raccoon").to_string();
    if let Ok(git_dir) = run(project, &["rev-parse", "--git-common-dir"]) {
        let git_dir = git_dir.trim();
        let git_dir = if Path::new(git_dir).is_absolute() { PathBuf::from(git_dir) } else { project.join(git_dir) };
        let info = git_dir.join("info");
        let exclude = info.join("exclude");
        let existing = std::fs::read_to_string(&exclude).unwrap_or_default();
        let line = format!("/{top}/");
        if !existing.lines().any(|l| l.trim() == line) {
            let _ = std::fs::create_dir_all(&info);
            let mut s = existing;
            if !s.is_empty() && !s.ends_with('\n') {
                s.push('\n');
            }
            s.push_str(&line);
            s.push('\n');
            let _ = std::fs::write(&exclude, s);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDisposition {
    pub exists: bool,
    /// Whether the counts below could be read. A directory that is no longer
    /// a working tree of its own (its `.git` file is gone or broken) cannot
    /// be checked: git would answer for the project around it and report
    /// nothing. The counts are then 0 and mean "unknown", not "clean".
    #[serde(default)]
    pub checked: bool,
    pub uncommitted: u32,
    /// Commits no other ref holds. Over-warning is the safe direction.
    pub unpushed: u32,
    pub branch: Option<String>,
}

/// Whether `path` is the top of a working tree of its own. Without this a
/// git command run there silently answers for the enclosing repository.
pub fn is_own_worktree(path: &Path) -> bool {
    let Ok(top) = run(path, &["rev-parse", "--show-toplevel"]) else { return false };
    match (std::fs::canonicalize(top.trim()), std::fs::canonicalize(path)) {
        (Ok(top), Ok(path)) => top == path,
        _ => false,
    }
}

/// A repository's shared git directory, resolved.
fn common_dir(cwd: &Path) -> Option<PathBuf> {
    let out = run(cwd, &["rev-parse", "--git-common-dir"]).ok()?;
    let dir = out.trim();
    let dir = if Path::new(dir).is_absolute() { PathBuf::from(dir) } else { cwd.join(dir) };
    std::fs::canonicalize(dir).ok()
}

/// Whether `path` is the top of a working tree of `project`'s repository.
/// A clone, or another repository's worktree, sitting at that path is a
/// working tree too, but its counts say nothing about this project and git
/// will refuse to remove it as one of ours.
pub fn is_worktree_of(project: &Path, path: &Path) -> bool {
    is_own_worktree(path) && common_dir(path).is_some_and(|theirs| Some(theirs) == common_dir(project))
}

fn branch_exists(project: &Path, branch: &str) -> bool {
    run_ok(project, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")])
}

pub fn worktree_disposition(project: &Path, name: &str) -> WorktreeDisposition {
    let path = worktree_path(project, name);
    if std::fs::symlink_metadata(&path).is_err() {
        return WorktreeDisposition::default();
    }
    let branch = worktree_branch(name);
    let unchecked = WorktreeDisposition { exists: true, checked: false, uncommitted: 0, unpushed: 0, branch: Some(branch.clone()) };
    if !is_worktree_of(project, &path) {
        return unchecked;
    }
    let uncommitted = run(&path, &["status", "--porcelain", "--"]).map(|s| s.lines().count() as u32);
    // What deleting loses: commits only HEAD holds, and commits only the
    // worktree's branch holds. They differ when HEAD was moved off the
    // branch (`git checkout --detach`), and the branch is deleted either way.
    let exclude = format!("--exclude={branch}");
    let mut args = vec!["rev-list", "--count", "HEAD"];
    if branch_exists(project, &branch) {
        args.push(&branch);
    }
    args.extend(["--not", exclude.as_str(), "--branches", "--remotes", "--tags"]);
    let unpushed = run(&path, &args).ok().and_then(|s| s.trim().parse::<u32>().ok());
    match (uncommitted, unpushed) {
        (Ok(uncommitted), Some(unpushed)) => WorktreeDisposition { exists: true, checked: true, uncommitted, unpushed, branch: Some(branch) },
        _ => unchecked,
    }
}

/// Bytes a file or directory tree takes on disk. Symlinks are counted as
/// links and never followed.
pub fn size_on_disk(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return 0 };
    #[cfg(unix)]
    let own = {
        use std::os::unix::fs::MetadataExt;
        meta.blocks() * 512
    };
    #[cfg(not(unix))]
    let own = meta.len();
    if !meta.is_dir() {
        return own;
    }
    let children: u64 = std::fs::read_dir(path).into_iter().flatten().flatten().map(|entry| size_on_disk(&entry.path())).sum();
    own + children
}

pub fn format_size(bytes: u64) -> String {
    match bytes {
        b if b >= 1_000_000_000 => format!("{:.1} GB", b as f64 / 1e9),
        b if b >= 1_000_000 => format!("{} MB", b / 1_000_000),
        b if b >= 1_000 => format!("{} KB", b / 1_000),
        b => format!("{b} B"),
    }
}

/// Whether the caller showed the person what a removal would lose and got a
/// confirmation. Only then may a directory git cannot remove be deleted
/// directly, and a branch that holds commits nothing else has be deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DirectDelete {
    Allowed,
    Never,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoval {
    /// The worktree's branch, when it was kept because it holds commits no
    /// other branch, remote or tag has.
    pub kept_branch: Option<String>,
    /// A branch made to keep a detached HEAD's commits reachable, when the
    /// directory was deleted directly and nothing else held them.
    pub rescued_branch: Option<String>,
}

/// Where the managed worktree `name` lives. The guard keys on shape: a direct
/// child of the worktree root or nothing, so an empty name can never resolve
/// to the project itself and a name with a separator can never climb out.
pub fn managed_worktree_path(project: &Path, name: &str) -> Result<PathBuf> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
        bail!("refusing to remove: bad worktree name");
    }
    let root = worktree_root(project);
    let path = root.join(name);
    if path.parent() != Some(root.as_path()) || path.file_name().and_then(|part| part.to_str()) != Some(name) {
        bail!("refusing to remove: not under the worktree directory");
    }
    Ok(path)
}

/// Delete a managed worktree's directory without git's help, for one git
/// could not remove (its `.git` file is gone, or git never knew it). The
/// directory goes for good; nothing is moved to the Trash.
///
/// The guard is checked on what is really on disk: `path` must be a real
/// directory, not a symlink; once both are resolved it must still be a
/// direct child of the project's worktree root; and it must be this
/// project's (see [`belongs_to_project`]), because the worktree folder is a
/// setting and two projects, or a clone someone put there, can share it.
pub fn remove_managed_worktree_dir(project: &Path, path: &Path) -> Result<()> {
    let meta = std::fs::symlink_metadata(path).with_context(|| format!("{} cannot be read", path.display()))?;
    if meta.file_type().is_symlink() {
        bail!("refusing to remove: {} is a symbolic link", path.display());
    }
    if !meta.is_dir() {
        bail!("refusing to remove: {} is not a directory", path.display());
    }
    let root = std::fs::canonicalize(worktree_root(project)).context("the worktree directory cannot be resolved")?;
    let resolved = std::fs::canonicalize(path).with_context(|| format!("{} cannot be resolved", path.display()))?;
    if resolved.parent() != Some(root.as_path()) {
        bail!("refusing to remove: {} is not directly under the worktree directory", path.display());
    }
    let project_dir = std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    if resolved == project_dir || project_dir.starts_with(&resolved) {
        bail!("refusing to remove: {} holds the project itself", path.display());
    }
    belongs_to_project(project, &resolved)?;
    std::fs::remove_dir_all(&resolved).with_context(|| format!("delete {}", resolved.display()))
}

/// Whether a directory in the worktree folder is this project's to delete
/// directly: its `.git` is absent (what is left of a removal that failed
/// part-way), or is a file pointing into this project's `.git/worktrees/`.
/// A `.git` directory is a repository of its own; a link pointing anywhere
/// else is another project's worktree. Both are refused.
fn belongs_to_project(project: &Path, dir: &Path) -> Result<()> {
    let dot_git = dir.join(".git");
    let meta = match std::fs::symlink_metadata(&dot_git) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => bail!("refusing to remove: {} cannot be read: {e}", dot_git.display()),
        Ok(meta) => meta,
    };
    if !meta.is_file() {
        bail!("refusing to remove: {} is a repository of its own, not a worktree of this project", dir.display());
    }
    let text = std::fs::read_to_string(&dot_git).with_context(|| format!("read {}", dot_git.display()))?;
    let Some(link) = text.lines().next().and_then(|line| line.strip_prefix("gitdir:")).map(str::trim).filter(|link| !link.is_empty()) else {
        bail!("refusing to remove: {} does not say which repository it belongs to", dot_git.display());
    };
    let link = if Path::new(link).is_absolute() { PathBuf::from(link) } else { dir.join(link) };
    let common = run(project, &["rev-parse", "--git-common-dir"]).context("the project's git directory cannot be found")?;
    let common = common.trim();
    let common = if Path::new(common).is_absolute() { PathBuf::from(common) } else { project.join(common) };
    let ours = common.join("worktrees");
    // The record may already be gone (git drops it before it fails on the
    // directory), so fall back to comparing the paths as written.
    let resolve = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let owner = link.parent().map(resolve);
    let matches = owner.as_deref().is_some_and(|owner| owner == resolve(&ours) || owner == std::fs::canonicalize(&common).unwrap_or(common.clone()).join("worktrees"));
    if !matches {
        bail!("refusing to remove: {} is a worktree of another repository", dir.display());
    }
    Ok(())
}

/// Commits on `branch` that no other branch, remote or tag holds. `None`
/// when git cannot say.
pub fn unique_commits(project: &Path, branch: &str) -> Option<u32> {
    run(project, &["rev-list", "--count", branch, "--not", &format!("--exclude={branch}"), "--branches", "--remotes", "--tags"])
        .ok()
        .and_then(|s| s.trim().parse().ok())
}

/// The commit a worktree's HEAD is detached at, read from the repository's
/// record of the worktree (`.git/worktrees/<id>/HEAD`), which is still there
/// when the directory itself is broken. `None` when HEAD is on a branch or
/// there is no record.
pub fn detached_head(project: &Path, path: &Path) -> Option<String> {
    let admin = std::fs::read_to_string(path.join(".git"))
        .ok()
        .and_then(|text| text.lines().next().and_then(|line| line.strip_prefix("gitdir:")).map(|link| link.trim().to_string()))
        .map(|link| if Path::new(&link).is_absolute() { PathBuf::from(link) } else { path.join(link) })
        .or_else(|| Some(common_dir(project)?.join("worktrees").join(path.file_name()?)))?;
    // Only a record in this project's own git directory is read.
    if std::fs::canonicalize(admin.parent()?).ok()? != common_dir(project)?.join("worktrees") {
        return None;
    }
    let head = std::fs::read_to_string(admin.join("HEAD")).ok()?;
    let head = head.trim();
    (head.len() >= 40 && head.chars().all(|c| c.is_ascii_hexdigit())).then(|| head.to_string())
}

/// Keep a detached commit reachable when no branch, remote or tag holds it:
/// a branch `raccoon/rescued/<name>-<short sha>` is made for it. Returns the
/// branch made.
pub fn rescue_detached(project: &Path, name: &str, commit: &str) -> Option<String> {
    let unheld: u32 = run(project, &["rev-list", "--count", commit, "--not", "--branches", "--remotes", "--tags"]).ok()?.trim().parse().ok()?;
    if unheld == 0 {
        return None;
    }
    let branch = format!("{}rescued/{name}-{}", crate::store::settings::load().branch_prefix, &commit[..8]);
    run(project, &["branch", "--", &branch, commit]).ok().map(|_| branch)
}

/// What a removal that failed left behind, in words for the person.
fn leftover_state(path: &Path) -> String {
    if std::fs::symlink_metadata(path).is_err() {
        return "The directory is gone.".into();
    }
    let size = format_size(size_on_disk(path));
    if is_own_worktree(path) {
        format!("It is still a checkout ({size} on disk), though some of its files may already have been removed.")
    } else {
        format!("It was partly removed: {size} remain on disk and it is no longer a usable checkout.")
    }
}

/// Remove a worktree and its branch.
///
/// When `git worktree remove --force` fails and `direct` allows it, the
/// directory is deleted directly, behind the guard above, and the stale
/// record pruned. An error names the directory, both reasons and what state
/// the directory was left in, and leaves the branch alone so the removal can
/// be tried again.
///
/// Commits are not lost quietly. The branch is deleted when nothing else
/// would go with it. A branch that holds commits of its own is deleted only
/// when git removed the worktree itself for a caller that showed those
/// commits and got a confirmation ([`DirectDelete::Allowed`]; the
/// disposition counts them). After a direct delete the directory could not
/// be checked, so such a branch is kept and named in the result, and a
/// detached HEAD nothing else holds is given a branch of its own.
pub fn remove_worktree(project: &Path, name: &str, direct: DirectDelete) -> Result<WorktreeRemoval> {
    let path = managed_worktree_path(project, name)?;
    let mut removal = WorktreeRemoval::default();
    let mut removed_by_git = false;
    // `symlink_metadata` so a dangling link still counts as something there.
    if let Ok(meta) = std::fs::symlink_metadata(&path) {
        if meta.file_type().is_symlink() {
            bail!("refusing to remove: {} is a symbolic link", path.display());
        }
        // Read before git touches anything: it drops its record of the
        // worktree before it fails on the directory.
        let detached = detached_head(project, &path);
        let target = arg(&path)?;
        let _ = run(project, &["worktree", "unlock", target]);
        match run(project, &["worktree", "remove", "--force", target]) {
            Ok(_) => removed_by_git = true,
            Err(git_error) if direct == DirectDelete::Never => {
                bail!("Could not remove the worktree at {}: {git_error:#}. {}", path.display(), leftover_state(&path));
            }
            Err(git_error) => {
                if let Some(commit) = &detached {
                    removal.rescued_branch = rescue_detached(project, name, commit);
                }
                if let Err(direct_error) = remove_managed_worktree_dir(project, &path) {
                    bail!("Could not remove the worktree at {}: {direct_error:#} ({git_error:#}). {}", path.display(), leftover_state(&path));
                }
            }
        }
    }
    let _ = run(project, &["worktree", "prune"]);
    let branch = worktree_branch(name);
    if !branch_exists(project, &branch) {
        return Ok(removal);
    }
    let confirmed = removed_by_git && direct == DirectDelete::Allowed;
    if !confirmed && unique_commits(project, &branch) != Some(0) {
        removal.kept_branch = Some(branch);
        return Ok(removal);
    }
    let _ = run(project, &["branch", "-D", &branch]);
    Ok(removal)
}

pub fn list_worktrees(project: &Path) -> Result<Vec<(String, Option<String>)>> {
    let out = run(project, &["worktree", "list", "--porcelain"])?;
    let mut v = Vec::new();
    let mut cur: Option<String> = None;
    for line in out.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            if let Some(c) = cur.take() {
                v.push((c, None));
            }
            cur = Some(p.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            if let Some(c) = cur.take() {
                v.push((c, Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string())));
            }
        }
    }
    if let Some(c) = cur {
        v.push((c, None));
    }
    Ok(v)
}

// ---------------------------------------------------------------- history & commits

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub sha: String,
    pub short_sha: String,
    pub subject: String,
    pub body: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub parent: Option<String>,
    pub tree: String,
}

pub fn log_commits(cwd: &Path, range: Option<&str>, limit: u32) -> Result<Vec<CommitInfo>> {
    let fmt = "--format=%H%x1f%h%x1f%s%x1f%b%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%T%x1e";
    let limit = format!("-n{limit}");
    let mut args = vec!["log", fmt, &limit];
    if let Some(r) = range {
        args.push(r);
    }
    args.push("--");
    let out = run(cwd, &args)?;
    Ok(out
        .split('\x1e')
        .filter(|r| !r.trim().is_empty())
        .filter_map(|rec| {
            let f: Vec<&str> = rec.trim_start_matches('\n').split('\x1f').collect();
            if f.len() < 9 {
                return None;
            }
            Some(CommitInfo {
                sha: f[0].into(),
                short_sha: f[1].into(),
                subject: f[2].into(),
                body: f[3].trim().into(),
                author: f[4].into(),
                email: f[5].into(),
                date: f[6].into(),
                parent: f[7].split_whitespace().next().map(String::from),
                tree: f[8].into(),
            })
        })
        .collect())
}

pub fn commit_all(cwd: &Path, message: &str, paths: Option<&[String]>) -> Result<String> {
    match paths {
        Some(ps) if !ps.is_empty() => {
            let mut args = vec!["add", "-A", "--"];
            args.extend(ps.iter().map(|s| s.as_str()));
            run(cwd, &args)?;
            let mut args = vec!["commit", "-m", message, "--"];
            args.extend(ps.iter().map(|s| s.as_str()));
            run(cwd, &args)?;
        }
        _ => {
            run(cwd, &["add", "-A", "--", "."])?;
            run(cwd, &["commit", "-m", message])?;
        }
    }
    Ok(head_commit(cwd).unwrap_or_default())
}

pub fn push(cwd: &Path) -> Result<String> {
    let branch = current_branch(cwd).ok_or_else(|| anyhow!("detached HEAD"))?;
    let has_upstream = run_ok(cwd, &["rev-parse", "--abbrev-ref", "@{upstream}"]);
    if has_upstream {
        run(cwd, &["push"])
    } else {
        run(cwd, &["push", "-u", "origin", &branch])
    }
}

pub fn pull(cwd: &Path) -> Result<String> {
    run(cwd, &["pull", "--ff-only"])
}

pub fn discard_file(cwd: &Path, path: &str) -> Result<()> {
    // Tracked: restore from HEAD. Untracked: delete.
    if run_ok(cwd, &["ls-files", "--error-unmatch", "--", path]) {
        run(cwd, &["checkout", "HEAD", "--", path])?;
    } else {
        let p = cwd.join(path);
        if p.is_dir() {
            std::fs::remove_dir_all(p)?;
        } else if p.exists() {
            std::fs::remove_file(p)?;
        }
    }
    Ok(())
}

pub fn checkout_branch(cwd: &Path, name: &str, create: bool) -> Result<()> {
    if name.starts_with('-') {
        bail!("bad branch name");
    }
    if create {
        run(cwd, &["checkout", "-b", name])?;
    } else {
        run(cwd, &["checkout", name])?;
    }
    Ok(())
}

/// This person's Git identity (`user.name`, `user.email` from their global
/// config), which authors the commits they make in a cloud workspace.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Identity {
    pub name: String,
    pub email: String,
}

pub fn global_identity() -> Option<Identity> {
    let home = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
    let get = |key: &str| run(&home, &["config", "--global", "--get", key]).ok().map(|value| value.trim().to_string()).filter(|value| !value.is_empty());
    Some(Identity { name: get("user.name")?, email: get("user.email")? })
}

pub fn remote_url(cwd: &Path) -> Option<String> {
    run(cwd, &["remote", "get-url", "origin"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        run(p, &["init", "-q", "-b", "main"]).unwrap();
        run(p, &["config", "user.email", "t@example.com"]).unwrap();
        run(p, &["config", "user.name", "T"]).unwrap();
        std::fs::write(p.join("a.txt"), "hello\n").unwrap();
        run(p, &["add", "."]).unwrap();
        run(p, &["commit", "-q", "-m", "init"]).unwrap();
        dir
    }

    #[test]
    fn snapshot_and_changes() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let base = snapshot_tree(p).unwrap();
        assert_eq!(base, head_tree(p).unwrap());
        std::fs::write(p.join("a.txt"), "hello\nworld\n").unwrap();
        std::fs::write(p.join("b.txt"), "new\n").unwrap();
        let head = snapshot_tree(p).unwrap();
        assert_ne!(base, head);
        // The real index is untouched.
        assert!(run(p, &["diff", "--cached", "--name-only", "--"]).unwrap().trim().is_empty());
        let mut ch = changes_between(p, &base, Some(&head)).unwrap();
        ch.sort_by(|a, b| a.path.cmp(&b.path));
        assert_eq!(ch.len(), 2);
        assert_eq!(ch[0].path, "a.txt");
        assert_eq!(ch[0].status, ChangeStatus::Modified);
        assert_eq!(ch[0].additions, 1);
        assert_eq!(ch[1].status, ChangeStatus::Added);
        assert_eq!(blob_at(p, &head, "b.txt").unwrap().unwrap(), "new\n");
        assert!(blob_at(p, &base, "b.txt").unwrap().is_none());
        let ws = work_status(p);
        assert!(ws.is_repo && ws.dirty);
        assert_eq!(ws.branch.as_deref(), Some("main"));
    }

    fn stale_clone() -> (tempfile::TempDir, tempfile::TempDir) {
        let remote = repo();
        let local = tempfile::tempdir().unwrap();
        run(local.path(), &["clone", "-q", arg(remote.path()).unwrap(), "."]).unwrap();
        std::fs::write(remote.path().join("a.txt"), "latest remote content\n").unwrap();
        run(remote.path(), &["commit", "-qam", "advance remote"]).unwrap();
        (remote, local)
    }

    #[test]
    fn worktree_fetches_latest_default_without_touching_checkout() {
        let _home = crate::store::temp_home();
        let (remote, local) = stale_clone();
        let p = local.path();
        let old = head_commit(p).unwrap();
        // Even an unusual fetch mapping must not update local branches.
        run(p, &["config", "remote.origin.fetch", "+refs/heads/*:refs/heads/*"]).unwrap();
        std::fs::write(p.join("a.txt"), "local edits\n").unwrap();
        run(p, &["add", "a.txt"]).unwrap();
        let index = run(p, &["diff", "--cached"]).unwrap();
        let wt = create_worktree(p, "fresh-base", None).unwrap();
        assert_eq!(head_commit(Path::new(&wt.path)), head_commit(remote.path()));
        assert_eq!(wt.base_tree, head_tree(remote.path()).unwrap());
        let provenance = wt.worktree_base.unwrap();
        assert!(provenance.fetched);
        assert!(provenance.warning.is_none());
        assert_eq!(Some(provenance.commit), head_commit(remote.path()));
        assert_eq!(head_commit(p).unwrap(), old);
        assert_eq!(run(p, &["diff", "--cached"]).unwrap(), index);
        assert_eq!(std::fs::read_to_string(p.join("a.txt")).unwrap(), "local edits\n");
    }

    #[test]
    fn worktree_fetches_custom_default_with_missing_tracking_ref() {
        let _home = crate::store::temp_home();
        let (remote, local) = stale_clone();
        run(remote.path(), &["branch", "-m", "main", "trunk"]).unwrap();
        run(local.path(), &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]).unwrap();
        let wt = create_worktree(local.path(), "custom-default", None).unwrap();
        assert_eq!(wt.base, "origin/trunk");
        assert_eq!(head_commit(Path::new(&wt.path)), head_commit(remote.path()));
        assert!(wt.worktree_base.unwrap().fetched);
    }

    #[test]
    fn worktree_failed_fetch_uses_local_ref_and_warns() {
        let _home = crate::store::temp_home();
        let (remote, local) = stale_clone();
        let old = head_commit(local.path());
        drop(remote);
        let wt = create_worktree(local.path(), "offline-base", None).unwrap();
        assert_eq!(head_commit(Path::new(&wt.path)), old);
        assert_eq!(wt.base, "origin/main");
        let provenance = wt.worktree_base.unwrap();
        assert!(!provenance.fetched);
        assert!(provenance.warning.unwrap().contains("may be out of date"));
    }

    #[test]
    fn worktree_without_remote_uses_local_default_without_warning() {
        let _home = crate::store::temp_home();
        let local = repo();
        let wt = create_worktree(local.path(), "local-base", None).unwrap();
        assert_eq!(head_commit(Path::new(&wt.path)), head_commit(local.path()));
        assert_eq!(wt.base, "main");
        let provenance = wt.worktree_base.unwrap();
        assert!(!provenance.fetched);
        assert!(provenance.warning.is_none());
    }

    #[test]
    fn worktree_explicit_base_skips_fetch() {
        let _home = crate::store::temp_home();
        let (_remote, local) = stale_clone();
        let old = head_commit(local.path());
        let wt = create_worktree(local.path(), "explicit-base", Some("origin/main")).unwrap();
        assert_eq!(head_commit(Path::new(&wt.path)), old);
        assert_eq!(run(local.path(), &["rev-parse", "origin/main"]).unwrap().trim(), old.unwrap());
        let provenance = wt.worktree_base.unwrap();
        assert!(!provenance.fetched);
        assert!(provenance.warning.is_none());
    }

    #[cfg(unix)]
    #[test]
    fn worktree_fetch_timeout_still_creates_and_warns() {
        let _home = crate::store::temp_home();
        let (_remote, local) = stale_clone();
        // A real Git transport that stalls, including a child process.
        run(local.path(), &["config", "remote.origin.url", "ext::sh -c sleep% 30"]).unwrap();
        run(local.path(), &["config", "protocol.ext.allow", "always"]).unwrap();
        let start = std::time::Instant::now();
        let wt = create_worktree_with_timeout(local.path(), "timeout-base", None, std::time::Duration::from_millis(100)).unwrap();
        assert!(start.elapsed() < std::time::Duration::from_secs(5));
        assert_eq!(head_commit(Path::new(&wt.path)), head_commit(local.path()));
        let provenance = wt.worktree_base.unwrap();
        assert!(!provenance.fetched);
        assert!(provenance.warning.unwrap().contains("fetch timed out"));
    }

    #[test]
    fn worktree_lifecycle() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = create_worktree(p, "quiet-amber-fox", None).unwrap();
        assert!(Path::new(&wt.path).join("a.txt").exists());
        assert_eq!(wt.branch, "raccoon/quiet-amber-fox");
        assert!(worktree_branch_names(p).contains(&"quiet-amber-fox".to_string()));
        assert!(taken_worktree_names(p, &[]).contains(&"quiet-amber-fox".to_string()));
        // The project's own status doesn't list the worktree directory.
        assert!(!work_status(p).dirty);
        std::fs::write(Path::new(&wt.path).join("c.txt"), "x").unwrap();
        let d = worktree_disposition(p, "quiet-amber-fox");
        assert!(d.exists && d.uncommitted == 1 && d.unpushed == 0);
        assert!(remove_worktree(p, "", DirectDelete::Allowed).is_err());
        assert!(remove_worktree(p, "../x", DirectDelete::Allowed).is_err());
        remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).unwrap();
        assert!(!Path::new(&wt.path).exists());
        assert!(!worktree_branch_names(p).contains(&"quiet-amber-fox".to_string()));
    }

    #[test]
    fn a_bad_worktree_name_is_refused_before_anything_is_touched() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = create_worktree(p, "quiet-amber-fox", None).unwrap();
        std::fs::create_dir_all(p.join(".raccoon/outside")).unwrap();
        for name in ["", ".", "..", "../outside", "../../a.txt", "a/b", "/tmp", "a\\b", "quiet-amber-fox/..", "x\0y"] {
            assert!(managed_worktree_path(p, name).is_err(), "{name:?} names a worktree");
            assert!(remove_worktree(p, name, DirectDelete::Allowed).is_err(), "{name:?} was removed");
        }
        assert!(p.join("a.txt").exists());
        assert!(p.join(".git").exists());
        assert!(p.join(".raccoon/outside").exists());
        assert!(Path::new(&wt.path).join("a.txt").exists());
    }

    #[test]
    fn a_worktree_git_cannot_remove_is_deleted_directly() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = create_worktree(p, "quiet-amber-fox", None).unwrap();
        // Without its `.git` file git no longer accepts the directory as a worktree.
        std::fs::remove_file(Path::new(&wt.path).join(".git")).unwrap();
        assert!(run(p, &["worktree", "remove", "--force", &wt.path]).is_err());
        remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).unwrap();
        assert!(!Path::new(&wt.path).exists());
        assert!(!run(p, &["worktree", "list", "--porcelain"]).unwrap().contains("quiet-amber-fox"), "the record is pruned");
        assert!(!worktree_branch_names(p).contains(&"quiet-amber-fox".to_string()));

        // A directory git never knew about goes the same way.
        let stray = worktree_path(p, "stray");
        std::fs::create_dir_all(stray.join("node_modules")).unwrap();
        remove_worktree(p, "stray", DirectDelete::Allowed).unwrap();
        assert!(!stray.exists());
        assert!(p.join("a.txt").exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_in_the_worktree_directory_is_never_followed() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("keep.txt"), "keep").unwrap();
        std::fs::create_dir_all(worktree_root(p)).unwrap();
        let link = worktree_path(p, "link");
        std::os::unix::fs::symlink(outside.path(), &link).unwrap();

        assert!(remove_worktree(p, "link", DirectDelete::Allowed).is_err());
        assert!(remove_managed_worktree_dir(p, &link).is_err());
        assert!(outside.path().join("keep.txt").exists());
        assert!(link.symlink_metadata().is_ok(), "the link itself is left alone");

        // A link to the project must not take the project with it either.
        let to_project = worktree_path(p, "project");
        std::os::unix::fs::symlink(p, &to_project).unwrap();
        assert!(remove_worktree(p, "project", DirectDelete::Allowed).is_err());
        assert!(p.join("a.txt").exists());
    }

    #[test]
    fn the_direct_delete_only_takes_a_child_of_the_worktree_directory() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = create_worktree(p, "quiet-amber-fox", None).unwrap();
        let nested = Path::new(&wt.path).join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let sibling = p.join(".raccoon/outside");
        std::fs::create_dir_all(&sibling).unwrap();
        let elsewhere = tempfile::tempdir().unwrap();

        for path in [p.to_path_buf(), worktree_root(p), nested, sibling, elsewhere.path().to_path_buf(), worktree_root(p).join("../worktrees"), worktree_path(p, "missing")] {
            assert!(remove_managed_worktree_dir(p, &path).is_err(), "{} was deleted", path.display());
        }
        assert!(p.join("a.txt").exists());
        assert!(Path::new(&wt.path).join("nested").exists());
        assert!(elsewhere.path().exists());
    }

    #[cfg(unix)]
    #[test]
    fn a_removal_that_fails_says_where_and_why_and_keeps_the_branch() {
        use std::os::unix::fs::PermissionsExt;
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = create_worktree(p, "quiet-amber-fox", None).unwrap();
        std::fs::set_permissions(&wt.path, std::fs::Permissions::from_mode(0o555)).unwrap();
        let error = remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).map_err(|e| format!("{e:#}"));
        std::fs::set_permissions(&wt.path, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = error.unwrap_err();
        assert!(error.contains(&wt.path), "{error}");
        assert!(Path::new(&wt.path).join("a.txt").exists());
        assert!(worktree_branch_names(p).contains(&"quiet-amber-fox".to_string()));
        remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).unwrap();
        assert!(!Path::new(&wt.path).exists());
    }

    /// A worktree holding one commit nothing else has and one dirty file.
    fn worktree_with_unsaved_work(p: &Path, name: &str) -> (PathBuf, String) {
        let wt = PathBuf::from(create_worktree(p, name, None).unwrap().path);
        std::fs::write(wt.join("work.txt"), "work\n").unwrap();
        run(&wt, &["add", "."]).unwrap();
        run(&wt, &["commit", "-q", "-m", "unpushed"]).unwrap();
        let commit = run(&wt, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        std::fs::write(wt.join("dirty.txt"), "dirty\n").unwrap();
        (wt, commit)
    }

    #[test]
    fn a_broken_worktree_reads_as_unchecked_and_its_unpushed_commits_survive() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let (wt, commit) = worktree_with_unsaved_work(p, "quiet-amber-fox");
        let intact = worktree_disposition(p, "quiet-amber-fox");
        assert!(intact.checked && intact.uncommitted == 1 && intact.unpushed == 1);

        // Without its `.git` file git answers for the enclosing project, where
        // the worktree folder is ignored: that must not read as "clean".
        std::fs::remove_file(wt.join(".git")).unwrap();
        assert!(!is_own_worktree(&wt));
        let broken = worktree_disposition(p, "quiet-amber-fox");
        assert!(broken.exists && !broken.checked, "{broken:?}");

        // A caller that showed nothing may not delete it directly at all.
        assert!(remove_worktree(p, "quiet-amber-fox", DirectDelete::Never).is_err());
        assert!(wt.join("dirty.txt").exists());

        // After an explicit confirmation the directory goes, but the branch
        // holding the only copy of the commit is kept and named.
        let removal = remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).unwrap();
        assert_eq!(removal.kept_branch.as_deref(), Some("raccoon/quiet-amber-fox"));
        assert!(!wt.exists());
        assert_eq!(run(p, &["rev-parse", "raccoon/quiet-amber-fox"]).unwrap().trim(), commit);
    }

    #[test]
    fn a_clone_or_another_repositorys_worktree_at_a_managed_path_cannot_be_checked() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        std::fs::create_dir_all(worktree_root(p)).unwrap();
        // A clone with a commit only it has.
        let clone = worktree_path(p, "a-clone");
        std::fs::create_dir_all(&clone).unwrap();
        run(&clone, &["init", "-q", "-b", "main"]).unwrap();
        run(&clone, &["config", "user.email", "t@example.com"]).unwrap();
        run(&clone, &["config", "user.name", "T"]).unwrap();
        std::fs::write(clone.join("only-here.txt"), "x").unwrap();
        run(&clone, &["add", "."]).unwrap();
        run(&clone, &["commit", "-q", "-m", "local only"]).unwrap();
        assert!(is_own_worktree(&clone) && !is_worktree_of(p, &clone));
        let d = worktree_disposition(p, "a-clone");
        assert!(d.exists && !d.checked, "{d:?}");

        // Another repository's worktree.
        let other = repo();
        let foreign = worktree_path(p, "foreign");
        run(other.path(), &["worktree", "add", "-q", "-b", "theirs", foreign.to_str().unwrap()]).unwrap();
        assert!(!is_worktree_of(p, &foreign));
        assert!(!worktree_disposition(p, "foreign").checked);

        // Our own still is.
        create_worktree(p, "quiet-amber-fox", None).unwrap();
        assert!(worktree_disposition(p, "quiet-amber-fox").checked);
    }

    #[test]
    fn commits_on_the_branch_count_even_when_head_was_moved_off_it() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = PathBuf::from(create_worktree(p, "quiet-amber-fox", None).unwrap().path);
        std::fs::write(wt.join("work.txt"), "work\n").unwrap();
        run(&wt, &["add", "."]).unwrap();
        run(&wt, &["commit", "-q", "-m", "on the branch"]).unwrap();
        let commit = run(&wt, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        run(&wt, &["checkout", "-q", "--detach", "main"]).unwrap();

        let d = worktree_disposition(p, "quiet-amber-fox");
        assert!(d.checked && d.unpushed == 1, "the branch's commit is what deleting loses: {d:?}");

        // A caller that showed nothing keeps the branch.
        let removal = remove_worktree(p, "quiet-amber-fox", DirectDelete::Never).unwrap();
        assert!(!wt.exists());
        assert_eq!(removal.kept_branch.as_deref(), Some("raccoon/quiet-amber-fox"));
        assert_eq!(run(p, &["rev-parse", "raccoon/quiet-amber-fox"]).unwrap().trim(), commit);

        // One that showed the count and was confirmed deletes it, as asked.
        let again = worktree_path(p, "quiet-amber-fox");
        run(p, &["worktree", "add", "-q", again.to_str().unwrap(), "raccoon/quiet-amber-fox"]).unwrap();
        assert_eq!(worktree_disposition(p, "quiet-amber-fox").unpushed, 1);
        let removal = remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).unwrap();
        assert!(!again.exists());
        assert_eq!(removal, WorktreeRemoval::default());
    }

    #[test]
    fn a_detached_head_nothing_else_holds_is_rescued_before_a_direct_delete() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = PathBuf::from(create_worktree(p, "quiet-amber-fox", None).unwrap().path);
        run(&wt, &["checkout", "-q", "--detach"]).unwrap();
        std::fs::write(wt.join("work.txt"), "work\n").unwrap();
        run(&wt, &["add", "."]).unwrap();
        run(&wt, &["commit", "-q", "-m", "detached"]).unwrap();
        let commit = run(&wt, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        assert_eq!(detached_head(p, &wt).as_deref(), Some(commit.as_str()));

        // The directory breaks; the repository's record still knows HEAD.
        std::fs::remove_file(wt.join(".git")).unwrap();
        assert_eq!(detached_head(p, &wt).as_deref(), Some(commit.as_str()));
        let removal = remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).unwrap();
        assert!(!wt.exists());
        let rescued = removal.rescued_branch.expect("the commit is given a branch");
        assert_eq!(rescued, format!("raccoon/rescued/quiet-amber-fox-{}", &commit[..8]));
        assert_eq!(run(p, &["rev-parse", &rescued]).unwrap().trim(), commit);

        // A detached HEAD on a commit something else holds needs no rescue.
        let wt = PathBuf::from(create_worktree(p, "calm-teal-bee", None).unwrap().path);
        run(&wt, &["checkout", "-q", "--detach"]).unwrap();
        std::fs::remove_file(wt.join(".git")).unwrap();
        assert_eq!(remove_worktree(p, "calm-teal-bee", DirectDelete::Allowed).unwrap().rescued_branch, None);
    }

    #[test]
    fn a_branch_with_nothing_of_its_own_goes_after_a_direct_delete() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = create_worktree(p, "quiet-amber-fox", None).unwrap();
        std::fs::remove_file(Path::new(&wt.path).join(".git")).unwrap();
        assert_eq!(remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).unwrap(), WorktreeRemoval::default());
        assert!(!worktree_branch_names(p).contains(&"quiet-amber-fox".to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn a_removal_that_stops_part_way_says_what_is_left() {
        use std::os::unix::fs::PermissionsExt;
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let (wt, commit) = worktree_with_unsaved_work(p, "quiet-amber-fox");
        let locked = wt.join("zz-locked");
        std::fs::create_dir_all(&locked).unwrap();
        std::fs::write(locked.join("held.bin"), vec![1u8; 64 * 1024]).unwrap();
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555)).unwrap();

        let error = remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).map_err(|e| format!("{e:#}"));
        let usable = is_own_worktree(&wt);
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755)).unwrap();
        let error = error.unwrap_err();

        assert!(error.contains(wt.to_str().unwrap()), "{error}");
        assert!(locked.join("held.bin").exists());
        if usable {
            assert!(error.contains("still a checkout"), "{error}");
        } else {
            assert!(error.contains("partly removed") && error.contains("no longer a usable checkout"), "{error}");
        }
        assert!(error.contains("KB") || error.contains("MB"), "the size that remains is given: {error}");
        // Whatever state the directory is in, the unpushed commit is not lost.
        assert_eq!(run(p, &["rev-parse", "raccoon/quiet-amber-fox"]).unwrap().trim(), commit);

        // Retrying finishes the job and still keeps the branch.
        let removal = remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).unwrap();
        assert!(!wt.exists());
        assert_eq!(removal.kept_branch.as_deref(), Some("raccoon/quiet-amber-fox"));
    }

    #[test]
    fn another_projects_directory_in_a_shared_worktree_folder_is_refused() {
        let _home = crate::store::temp_home();
        // A worktree folder outside any project, as an absolute setting allows.
        let shared = tempfile::tempdir().unwrap();
        let shared_root = std::fs::canonicalize(shared.path()).unwrap();
        let settings = crate::store::settings::Settings { worktree_dir: shared_root.to_string_lossy().into_owned(), ..Default::default() };
        crate::store::settings::save(&settings).unwrap();
        let ours = repo();
        let theirs = repo();
        assert_eq!(worktree_root(ours.path()), shared_root);

        // The other project's worktree, under the name of a session we are deleting.
        let foreign = PathBuf::from(create_worktree(theirs.path(), "fix-login", None).unwrap().path);
        std::fs::write(foreign.join("theirs.txt"), "theirs").unwrap();
        let error = format!("{:#}", remove_worktree(ours.path(), "fix-login", DirectDelete::Allowed).unwrap_err());
        assert!(error.contains("another repository"), "{error}");
        assert!(foreign.join("theirs.txt").exists());
        assert!(remove_managed_worktree_dir(ours.path(), &foreign).is_err());

        // A clone someone put in the worktree folder is a repository of its own.
        let clone = shared_root.join("a-clone");
        std::fs::create_dir_all(&clone).unwrap();
        run(&clone, &["init", "-q", "-b", "main"]).unwrap();
        std::fs::write(clone.join("precious.txt"), "x").unwrap();
        let error = format!("{:#}", remove_worktree(ours.path(), "a-clone", DirectDelete::Allowed).unwrap_err());
        assert!(error.contains("repository of its own"), "{error}");
        assert!(clone.join("precious.txt").exists());

        // Our own worktree there, broken, is still ours to delete.
        let own = PathBuf::from(create_worktree(ours.path(), "quiet-amber-fox", None).unwrap().path);
        let record = std::fs::read_to_string(own.join(".git")).unwrap();
        assert!(record.starts_with("gitdir:"));
        std::fs::write(own.join(".git"), format!("{}\n", record.trim().replace("quiet-amber-fox", "pruned-record"))).unwrap();
        remove_worktree(ours.path(), "quiet-amber-fox", DirectDelete::Allowed).unwrap();
        assert!(!own.exists());
        assert!(foreign.join("theirs.txt").exists());
    }

    #[test]
    fn a_dot_git_that_names_no_repository_is_refused() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = PathBuf::from(create_worktree(p, "quiet-amber-fox", None).unwrap().path);
        for content in ["", "garbage\n", "gitdir:\n", "gitdir: /somewhere/else/.git/worktrees/quiet-amber-fox\n", "gitdir: ../../..\n"] {
            std::fs::write(wt.join(".git"), content).unwrap();
            assert!(remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).is_err(), "{content:?}");
            assert!(wt.join("a.txt").exists(), "{content:?}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_link_inside_a_worktree_is_removed_as_a_link() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = PathBuf::from(create_worktree(p, "quiet-amber-fox", None).unwrap().path);
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("keep.txt"), "keep").unwrap();
        std::os::unix::fs::symlink(outside.path(), wt.join("linked-dir")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("keep.txt"), wt.join("linked-file")).unwrap();
        std::os::unix::fs::symlink(p, wt.join("linked-project")).unwrap();
        // Through git, and through the direct delete.
        for broken in [false, true] {
            if broken {
                let again = PathBuf::from(create_worktree(p, "quiet-amber-fox", None).unwrap().path);
                std::os::unix::fs::symlink(outside.path(), again.join("linked-dir")).unwrap();
                std::os::unix::fs::symlink(p, again.join("linked-project")).unwrap();
                std::fs::remove_file(again.join(".git")).unwrap();
            }
            remove_worktree(p, "quiet-amber-fox", DirectDelete::Allowed).unwrap();
            assert!(!wt.exists());
            assert!(outside.path().join("keep.txt").exists());
            assert!(p.join("a.txt").exists());
        }
    }

    #[test]
    fn a_name_in_another_case_never_reaches_outside_the_worktree_folder() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        let wt = PathBuf::from(create_worktree(p, "quiet-amber-fox", None).unwrap().path);
        std::fs::create_dir_all(p.join(".RACCOON-other")).unwrap();
        // On a case-insensitive disk this is the same directory; on a
        // case-sensitive one it is nothing. Either way only that entry of the
        // worktree folder can be affected.
        let _ = remove_worktree(p, "QUIET-AMBER-FOX", DirectDelete::Allowed);
        assert!(!wt.exists() || wt.join("a.txt").exists());
        assert!(p.join("a.txt").exists());
        assert!(p.join(".git").is_dir());
        assert!(p.join(".RACCOON-other").exists());
    }

    #[test]
    fn log_and_commit() {
        let _home = crate::store::temp_home();
        let dir = repo();
        let p = dir.path();
        std::fs::write(p.join("a.txt"), "changed\n").unwrap();
        let sha = commit_all(p, "second\n\nbody here", None).unwrap();
        let log = log_commits(p, None, 10).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].sha, sha);
        assert_eq!(log[0].subject, "second");
        assert_eq!(log[0].body, "body here");
        assert!(log[1].parent.is_none());
    }
}
