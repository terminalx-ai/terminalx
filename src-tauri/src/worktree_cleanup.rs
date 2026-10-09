//! Bulk clean-up of worktrees across the projects open on one host.
//!
//! This runs on the host that owns the worktrees: in the desktop app for
//! local projects, in the workspace runtime for a cloud VM. A path is only
//! ever resolved, inspected and removed where it lives.
//!
//! [`scan`] only reads (apart from fetching a project's default branch when a
//! worktree's commits are not on any remote, to see whether they were merged).
//! It lists every worktree git knows for each open project with one verdict:
//!
//! - **protected**: the repository's primary worktree, the root of any open
//!   project (also one nested inside the worktree, or reached through a
//!   symlink or another spelling of the path), a worktree that has another
//!   worktree checked out inside it, or a locked worktree. Never removable,
//!   whatever a request says.
//! - **active**: an agent is running or waiting for an answer, a terminal is
//!   open, or some process has its working directory there. Nothing is ever
//!   stopped to make a worktree removable.
//! - **inProgress** / **dirty**: a merge, rebase, cherry-pick, revert or
//!   bisect is under way, or there are modified, staged, conflicted or
//!   untracked files.
//! - **unpushed**: commits that no remote has and that are not in the default
//!   branch as the remote has it now.
//! - **unverifiable**: the answer could not be established (not a working
//!   tree of the project, files hidden from `git status`, submodules, another
//!   checkout inside an ignored folder, git failing). Unknown is never read
//!   as clean.
//! - **ignoredData**: clean, but it holds ignored files that are not known
//!   build or dependency output (`.env`, a local database). Removable only
//!   when the request says so for that worktree.
//! - **eligible**: none of the above.
//!
//! [`remove`] inspects each named worktree again, immediately before it is
//! removed, and removes it only if the verdict and everything it rests on
//! (commit, branch, changed files, ignored files, sessions) is what the
//! person was shown: the scan's `token`. Git is not forced, so it refuses by
//! itself if a file appeared in between. The branch always stays. Sessions
//! keep their conversations and are filed under the project as belonging to
//! a removed workspace, unless the request asks for them to be deleted.

use std::cell::OnceCell;
use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::git;
use crate::landed::{self, Fetch};
use crate::session_ops;
use crate::sink::EventSink;
use crate::store::index::{self, SessionEntry, TabStatus};
use crate::store::projects::Project;

/// How many file names a verdict spells out before it says "and N more".
const NAMED: usize = 5;

/// Ignored directories and files that a build or an install makes again.
const DISPOSABLE_NAMES: &[&str] = &[
    "node_modules", "target", "dist", "build", "out", ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache", ".vite", ".svelte-kit", ".angular", ".expo",
    "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".venv", "venv", ".gradle", "Pods", "DerivedData", "coverage", ".nyc_output",
    ".eslintcache", ".stylelintcache", ".DS_Store", "Thumbs.db",
];
const DISPOSABLE_SUFFIXES: &[&str] = &[".pyc", ".pyo", ".o", ".obj", ".class", ".tsbuildinfo"];

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Verdict {
    Eligible,
    IgnoredData,
    Protected,
    Active,
    InProgress,
    Dirty,
    Unpushed,
    Unverifiable,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionImpact {
    pub id: String,
    pub title: String,
    pub modified: String,
    /// What it is doing now, when it is doing anything.
    pub live: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub project_path: String,
    /// Resolved on this host; what a removal names.
    pub path: String,
    pub name: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    /// Lives in the project's own worktree folder.
    pub managed: bool,
    pub verdict: Verdict,
    /// Why it is not eligible. `None` when it is.
    pub reason: Option<String>,
    /// The newest of its last commit and its sessions' last change.
    pub last_activity: Option<String>,
    pub sessions: Vec<SessionImpact>,
    /// Ignored entries that a build makes again, and would go with it.
    pub disposable: Vec<String>,
    /// Ignored entries that may be local data.
    pub ignored_data: Vec<String>,
    /// Stands for everything this verdict rests on.
    pub token: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectScan {
    pub path: String,
    pub name: String,
    /// Why nothing is listed, when nothing can be.
    pub note: Option<String>,
    pub candidates: Vec<Candidate>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveItem {
    pub project_path: String,
    pub path: String,
    pub token: String,
    /// Delete the conversations of the sessions in it too. Otherwise they
    /// are kept and filed under the project.
    #[serde(default)]
    pub delete_sessions: bool,
    /// The person chose to remove it although it holds ignored local files.
    #[serde(default)]
    pub accept_ignored: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Removed,
    /// It was gone before this call: an earlier one removed it.
    AlreadyRemoved,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ItemResult {
    pub project_path: String,
    pub path: String,
    pub outcome: Outcome,
    pub reason: Option<String>,
    pub freed_bytes: u64,
    /// The branch it was on, which stays.
    pub kept_branch: Option<String>,
    pub sessions_kept: Vec<String>,
    pub sessions_deleted: Vec<String>,
}

/// What is running on this host right now.
#[derive(Debug, Clone, Default)]
pub struct Live {
    /// Open terminals whose process is alive: `(pane id, directory)`.
    pub panes: Vec<(String, PathBuf)>,
    /// Agent tabs with a live process: `(session id, tab id)`.
    pub tabs: HashSet<(String, String)>,
    /// The working directory of every process that could be read.
    pub process_dirs: Vec<PathBuf>,
}

impl Live {
    /// Read the terminals, the agents `running` knows, and the machine's
    /// processes.
    pub fn observe(terminals: &crate::pty::Terminals, sessions: &[SessionEntry], running: &dyn Fn(&str, &str) -> bool) -> Self {
        let panes = terminals.panes().into_iter().filter(|pane| pane.running).map(|pane| (pane.id, canonical(Path::new(&pane.cwd)))).collect();
        let tabs = sessions
            .iter()
            .flat_map(|session| session.tabs.iter().map(move |tab| (session.id.clone(), tab.id.clone())))
            .filter(|(session, tab)| running(session, tab))
            .collect();
        Self { panes, tabs, process_dirs: process_dirs() }
    }

    fn session(&self, session: &SessionEntry) -> Option<String> {
        if session.tabs.iter().any(|tab| tab.status == TabStatus::Waiting) {
            return Some("waiting for an answer".into());
        }
        if session.tabs.iter().any(|tab| tab.status == TabStatus::InProgress || self.tabs.contains(&(session.id.clone(), tab.id.clone()))) {
            return Some("an agent is running".into());
        }
        let prefix = format!("{}:", session.id);
        let own = |pane: &str| pane.starts_with(&prefix) || session.tabs.iter().any(|tab| pane.strip_prefix("tab:") == Some(tab.id.as_str()));
        self.panes.iter().any(|(pane, _)| own(pane)).then(|| "a terminal is open".into())
    }
}

/// Everything a scan or a removal reads about this host.
pub struct Host<'a> {
    /// The projects open here. Their roots are never removable.
    pub projects: &'a [Project],
    /// Further directories that are never removable (a cloud workspace's root).
    pub protected: &'a [PathBuf],
    /// When set, only worktrees inside this directory are this host's to remove.
    pub confine: Option<&'a Path>,
    pub live: &'a dyn Fn(&[SessionEntry]) -> Live,
    pub fetch: Fetch,
}

fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Whether two paths are one directory, however each is spelled.
fn same_dir(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(a), Ok(b)) = (std::fs::metadata(a), std::fs::metadata(b)) {
            return a.dev() == b.dev() && a.ino() == b.ino();
        }
    }
    false
}

/// The working directory of each process on this machine that can be read.
#[cfg(target_os = "linux")]
fn process_dirs() -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
    entries
        .flatten()
        .filter(|entry| entry.file_name().to_str().is_some_and(|name| name.bytes().all(|b| b.is_ascii_digit())))
        .filter_map(|entry| std::fs::read_link(entry.path().join("cwd")).ok())
        .collect()
}

#[cfg(target_os = "macos")]
fn process_dirs() -> Vec<PathBuf> {
    use std::os::unix::ffi::OsStrExt;
    let width = std::mem::size_of::<libc::pid_t>();
    // SAFETY: with a null buffer the call only reports how many there are.
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Vec::new();
    }
    let mut pids: Vec<libc::pid_t> = vec![0; count as usize + 64];
    // SAFETY: the buffer is `pids.len() * width` bytes, as the call is told.
    let filled = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), (pids.len() * width) as libc::c_int) };
    if filled <= 0 {
        return Vec::new();
    }
    pids.truncate(filled as usize);
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as libc::c_int;
    let mut out = Vec::new();
    for pid in pids {
        // SAFETY: `info` is a plain C struct of exactly `size` bytes; the
        // kernel fills it or reports another length, and it is read only
        // when the length matches. The path is NUL-terminated within it.
        let dir = unsafe {
            let mut info: libc::proc_vnodepathinfo = std::mem::zeroed();
            if libc::proc_pidinfo(pid, libc::PROC_PIDVNODEPATHINFO, 0, (&mut info as *mut libc::proc_vnodepathinfo).cast(), size) != size {
                continue;
            }
            let bytes = std::slice::from_raw_parts(info.pvi_cdir.vip_path.as_ptr().cast::<u8>(), std::mem::size_of_val(&info.pvi_cdir.vip_path));
            let end = bytes.iter().position(|b| *b == 0).unwrap_or(bytes.len());
            PathBuf::from(std::ffi::OsStr::from_bytes(&bytes[..end]))
        };
        if !dir.as_os_str().is_empty() {
            out.push(dir);
        }
    }
    out
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn process_dirs() -> Vec<PathBuf> {
    Vec::new()
}

/// One entry of `git worktree list --porcelain`.
#[derive(Debug, Default, Clone)]
struct Listed {
    path: String,
    branch: Option<String>,
    bare: bool,
    locked: bool,
    prunable: bool,
}

fn list_worktrees(project: &Path) -> anyhow::Result<Vec<Listed>> {
    let out = git::run(project, &["worktree", "list", "--porcelain"])?;
    let mut entries: Vec<Listed> = Vec::new();
    for line in out.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            entries.push(Listed { path: path.to_string(), ..Default::default() });
            continue;
        }
        let Some(entry) = entries.last_mut() else { continue };
        if let Some(branch) = line.strip_prefix("branch ") {
            entry.branch = Some(branch.strip_prefix("refs/heads/").unwrap_or(branch).to_string());
        } else if line == "bare" {
            entry.bare = true;
        } else if line == "locked" || line.starts_with("locked ") {
            entry.locked = true;
        } else if line == "prunable" || line.starts_with("prunable ") {
            entry.prunable = true;
        }
    }
    Ok(entries)
}

/// One open project, as a scan or a removal sees it.
struct Repository<'a> {
    project: &'a Project,
    root: PathBuf,
    /// Git's primary worktree of the repository this project belongs to.
    primary: PathBuf,
    listed: Vec<Listed>,
    fetch: Fetch,
    /// What unpushed commits are compared with, read (and fetched) only
    /// when some worktree has any.
    base: OnceCell<(Option<String>, bool)>,
}

impl<'a> Repository<'a> {
    fn open(project: &'a Project, fetch: Fetch) -> Result<Self, String> {
        let root = std::fs::canonicalize(&project.path).map_err(|_| "Its folder is not on disk.".to_string())?;
        if !root.is_dir() || !git::is_repo(&root) {
            return Err("Not a Git repository, so it has no worktrees.".into());
        }
        let listed = list_worktrees(&root).map_err(|error| format!("Git could not list its worktrees: {error:#}"))?;
        let primary = listed.first().map(|entry| canonical(Path::new(&entry.path))).ok_or("Git lists no worktree for it.")?;
        Ok(Self { project, root, primary, listed, fetch, base: OnceCell::new() })
    }

    /// `(base, verified against the remote as it is now)`.
    fn base(&self) -> &(Option<String>, bool) {
        self.base.get_or_init(|| {
            let (base, not_verified, fresh) = landed::base_for(&self.root, self.fetch);
            (base, fresh && not_verified.is_none())
        })
    }
}

struct Roots {
    /// `(root, what it is)` for every directory that must survive.
    protected: Vec<(PathBuf, String)>,
}

impl Roots {
    fn of(host: &Host<'_>, sessions: &[SessionEntry]) -> Self {
        let mut protected: Vec<(PathBuf, String)> = host
            .projects
            .iter()
            .map(|project| (canonical(Path::new(&project.path)), format!("the open project {}", project.name)))
            .collect();
        protected.extend(host.protected.iter().map(|root| (canonical(root), "this workspace's root".to_string())));
        // A session's project is a root too, even one the list above has lost.
        let known: HashSet<PathBuf> = protected.iter().map(|(root, _)| root.clone()).collect();
        let more: BTreeSet<PathBuf> = sessions.iter().map(|session| canonical(Path::new(&session.project_path))).filter(|root| !known.contains(root)).collect();
        protected.extend(more.into_iter().map(|root| (root, "a project its sessions belong to".to_string())));
        Self { protected }
    }

    /// Why `path` must never be removed, if it must not.
    fn protection(&self, repository: &Repository<'_>, path: &Path) -> Option<String> {
        if same_dir(path, &repository.primary) {
            return Some("This is the repository's main directory. It is never removed.".into());
        }
        for (root, what) in &self.protected {
            if same_dir(path, root) {
                return Some(format!("This directory is {what}. It is never removed."));
            }
            if root.starts_with(path) {
                return Some(format!("It contains {what} ({}). It is never removed.", root.display()));
            }
        }
        None
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn named(names: &[String]) -> String {
    let shown: Vec<&str> = names.iter().take(NAMED).map(String::as_str).collect();
    let more = names.len().saturating_sub(NAMED);
    if more > 0 { format!("{} and {more} more", shown.join(", ")) } else { shown.join(", ") }
}

fn disposable(entry: &str) -> bool {
    let name = entry.trim_end_matches('/').rsplit('/').next().unwrap_or(entry);
    DISPOSABLE_NAMES.contains(&name) || DISPOSABLE_SUFFIXES.iter().any(|suffix| name.ends_with(suffix))
}

/// How far into an ignored folder a nested checkout is looked for.
const NESTED_CHECKOUT_DEPTH: usize = 4;

/// Whether `dir`, or a folder up to `depth` levels below it, is a Git
/// checkout (has a `.git`). Links are not followed.
fn holds_git_dir(dir: &Path, depth: usize) -> bool {
    if std::fs::symlink_metadata(dir.join(".git")).is_ok() {
        return true;
    }
    if depth == 0 {
        return false;
    }
    std::fs::read_dir(dir).into_iter().flatten().flatten().any(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()) && holds_git_dir(&entry.path(), depth - 1))
}

/// The git operation that is under way in the checkout, if one is.
fn operation_in_progress(path: &Path) -> Result<Option<&'static str>, ()> {
    let dir = git::run(path, &["rev-parse", "--absolute-git-dir"]).map_err(|_| ())?;
    let dir = Path::new(dir.trim());
    let marks = [
        ("MERGE_HEAD", "merge"),
        ("rebase-merge", "rebase"),
        ("rebase-apply", "rebase"),
        ("CHERRY_PICK_HEAD", "cherry-pick"),
        ("REVERT_HEAD", "revert"),
        ("BISECT_LOG", "bisect"),
        ("sequencer", "cherry-pick or revert"),
    ];
    Ok(marks.into_iter().find(|(mark, _)| std::fs::symlink_metadata(dir.join(mark)).is_ok()).map(|(_, what)| what))
}

fn describe_changes(listing: &str) -> String {
    let (mut conflicts, mut untracked, mut staged, mut modified) = (0, 0, 0, 0);
    for line in listing.lines() {
        let mut flags = line.chars();
        let (x, y) = (flags.next().unwrap_or(' '), flags.next().unwrap_or(' '));
        if x == '?' {
            untracked += 1;
        } else if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
            conflicts += 1;
        } else {
            if x != ' ' {
                staged += 1;
            }
            if y != ' ' {
                modified += 1;
            }
        }
    }
    let mut parts = Vec::new();
    if conflicts > 0 {
        parts.push(plural(conflicts, "unresolved conflict", "unresolved conflicts"));
    }
    if staged > 0 {
        parts.push(plural(staged, "staged change", "staged changes"));
    }
    if modified > 0 {
        parts.push(plural(modified, "modified file", "modified files"));
    }
    if untracked > 0 {
        parts.push(plural(untracked, "untracked file", "untracked files"));
    }
    format!("It has {}.", parts.join(", "))
}

fn last_activity(path: &Path, sessions: &[SessionEntry]) -> Option<String> {
    let parse = |text: &str| chrono::DateTime::parse_from_rfc3339(text.trim()).ok().map(|at| at.with_timezone(&chrono::Utc));
    let commit = git::run(path, &["log", "-1", "--format=%cI", "HEAD"]).ok().and_then(|out| parse(&out));
    let newest = sessions.iter().filter_map(|session| parse(&session.modified)).chain(commit).max()?;
    Some(newest.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

/// Read one listed worktree and decide what it is.
fn inspect(host: &Host<'_>, roots: &Roots, repository: &Repository<'_>, entry: &Listed, all_sessions: &[SessionEntry], live: &Live) -> Candidate {
    let path = canonical(Path::new(&entry.path));
    let sessions = session_ops::sessions_within(all_sessions.to_vec(), &path);
    let managed_root = canonical(&git::worktree_root(&repository.root));
    let mut candidate = Candidate {
        project_path: repository.project.path.clone(),
        path: path.to_string_lossy().into_owned(),
        name: path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| entry.path.clone()),
        branch: entry.branch.clone(),
        head: None,
        managed: path.parent() == Some(managed_root.as_path()),
        verdict: Verdict::Unverifiable,
        reason: None,
        last_activity: None,
        sessions: sessions.iter().map(|session| SessionImpact { id: session.id.clone(), title: session.title.clone(), modified: session.modified.clone(), live: live.session(session) }).collect(),
        disposable: Vec::new(),
        ignored_data: Vec::new(),
        token: String::new(),
    };
    let mut listing = String::new();
    let (verdict, reason) = (|| -> (Verdict, Option<String>) {
        let unverifiable = |why: &str| (Verdict::Unverifiable, Some(why.to_string()));
        // Protection comes before anything is read: no state of a protected
        // directory makes it removable.
        if let Some(why) = roots.protection(repository, &path) {
            return (Verdict::Protected, Some(why));
        }
        if entry.bare {
            return (Verdict::Protected, Some("This is the repository itself. It is never removed.".into()));
        }
        if entry.locked {
            return (Verdict::Protected, Some("It is locked with `git worktree lock`. Unlock it first if it is meant to go.".into()));
        }
        // Removing a directory removes everything below it: another worktree
        // checked out inside this one would go too, whatever state it is in.
        let nested = repository.listed.iter().map(|other| canonical(Path::new(&other.path))).find(|other| *other != path && other.starts_with(&path));
        if let Some(nested) = nested {
            return (Verdict::Protected, Some(format!("It contains another worktree ({}). It is never removed while that is there.", nested.display())));
        }
        if host.confine.is_some_and(|inside| !path.starts_with(canonical(inside))) {
            return unverifiable("It is outside this workspace, so it is not removed from here.");
        }
        if !git::is_worktree_of(&repository.root, &path) {
            return unverifiable("It is not a working Git checkout of this project, so it cannot be checked for unsaved work.");
        }
        candidate.head = git::head_commit(&path);
        candidate.branch = git::current_branch(&path).or(candidate.branch.take());
        candidate.last_activity = last_activity(&path, &sessions);

        if let Some(session) = candidate.sessions.iter().find(|session| session.live.is_some()) {
            return (Verdict::Active, Some(format!("The session \"{}\" is live: {}. Nothing is stopped to clean up.", session.title, session.live.as_deref().unwrap_or_default())));
        }
        let terminals = live.panes.iter().filter(|(_, dir)| dir.starts_with(&path)).count();
        if terminals > 0 {
            return (Verdict::Active, Some(format!("{} open in it.", plural(terminals, "terminal is", "terminals are"))));
        }
        let processes = live.process_dirs.iter().filter(|dir| dir.starts_with(&path)).count();
        if processes > 0 {
            return (Verdict::Active, Some(format!("{} running in it.", plural(processes, "process is", "processes are"))));
        }

        match operation_in_progress(&path) {
            Ok(None) => {}
            Ok(Some(what)) => return (Verdict::InProgress, Some(format!("A {what} is in progress."))),
            Err(()) => return unverifiable("Git could not read the checkout's state."),
        }
        match git::run(&path, &["status", "--porcelain", "--untracked-files=all", "--"]) {
            Ok(out) => listing = out,
            Err(_) => return unverifiable("Git could not read the working tree's status."),
        }
        if !listing.trim().is_empty() {
            return (Verdict::Dirty, Some(describe_changes(&listing)));
        }
        if candidate.head.is_none() {
            return unverifiable("It has no commit checked out.");
        }
        match landed::hidden_from_status(&path) {
            Some(0) => {}
            Some(hidden) => return unverifiable(&format!("{} hidden from git status (skip-worktree or assume-unchanged), so changes cannot be seen.", plural(hidden as usize, "file is", "files are"))),
            None => return unverifiable("Git could not list the files in the working tree."),
        }
        match landed::submodules_in(&path) {
            Some(0) => {}
            Some(_) => return unverifiable("It has submodules, and work inside a submodule cannot be checked from here."),
            None => return unverifiable("Git could not read the index."),
        }

        // Commits no remote has. The branch stays when the worktree goes,
        // but a branch that exists only on this machine is not a backup.
        let local_only = git::run(&path, &["rev-list", "--count", "HEAD", "--not", "--remotes"]).ok().and_then(|out| out.trim().parse::<usize>().ok());
        match local_only {
            None => return unverifiable("Git could not tell whether its commits are on a remote."),
            Some(0) => {}
            Some(count) => {
                let (base, verified) = repository.base();
                let merged = match base {
                    Some(base) if *verified => matches!(landed::merged_rev(&path, base, "HEAD"), Some((Some(_), _))),
                    _ => false,
                };
                if !merged {
                    let against = match base {
                        Some(base) if *verified => format!("and not merged into {base}"),
                        _ => "and whether they were merged could not be verified".to_string(),
                    };
                    return (Verdict::Unpushed, Some(format!("{} only on this machine: not on any remote, {against}.", plural(count, "commit is", "commits are"))));
                }
            }
        }

        let Ok(ignored) = git::run(&path, &["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]) else {
            return unverifiable("Git could not list the ignored files.");
        };
        for name in ignored.split('\0').filter(|name| !name.is_empty()) {
            if disposable(name) { candidate.disposable.push(name.to_string()) } else { candidate.ignored_data.push(name.to_string()) }
        }
        // An ignored folder can hold a whole checkout (a clone, or a worktree
        // of some other repository) whose state nothing here has read.
        let holds_checkout = candidate.disposable.iter().chain(&candidate.ignored_data).find(|name| name.ends_with('/') && holds_git_dir(&path.join(name), NESTED_CHECKOUT_DEPTH));
        if let Some(name) = holds_checkout {
            return unverifiable(&format!("The ignored folder {name} holds another Git checkout, and work in it cannot be checked from here."));
        }
        if !candidate.ignored_data.is_empty() {
            return (
                Verdict::IgnoredData,
                Some(format!("{} may be local data: {}.", plural(candidate.ignored_data.len(), "ignored file or folder", "ignored files or folders"), named(&candidate.ignored_data))),
            );
        }
        (Verdict::Eligible, None)
    })();
    candidate.verdict = verdict;
    candidate.reason = reason;
    candidate.token = token(&candidate, &listing);
    candidate
}

fn token(candidate: &Candidate, listing: &str) -> String {
    let mut hasher = Sha256::new();
    let mut field = |value: &str| {
        hasher.update((value.len() as u64).to_le_bytes());
        hasher.update(value.as_bytes());
    };
    field(&candidate.path);
    field(&format!("{:?}", candidate.verdict));
    field(candidate.head.as_deref().unwrap_or("-"));
    field(candidate.branch.as_deref().unwrap_or("-"));
    field(listing);
    field(&candidate.ignored_data.join("\0"));
    let sessions: BTreeSet<&str> = candidate.sessions.iter().map(|session| session.id.as_str()).collect();
    field(&sessions.into_iter().collect::<Vec<_>>().join("\0"));
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Every worktree of the open projects on this host, with its verdict.
/// `scope` narrows the listing to those projects; protection always covers
/// all of them.
pub fn scan(host: &Host<'_>, scope: Option<&[String]>) -> anyhow::Result<Vec<ProjectScan>> {
    let sessions = index::load()?;
    let live = (host.live)(&sessions);
    let roots = Roots::of(host, &sessions);
    let wanted: Option<HashSet<PathBuf>> = scope.map(|paths| paths.iter().map(|path| canonical(Path::new(path))).collect());
    let mut opened: Vec<(&Project, Result<Repository<'_>, String>)> = host
        .projects
        .iter()
        .filter(|project| wanted.as_ref().is_none_or(|wanted| wanted.contains(&canonical(Path::new(&project.path)))))
        .map(|project| (project, Repository::open(project, host.fetch)))
        .collect();
    // A worktree is listed once, under the project that is its repository's
    // main directory when that one is open too.
    opened.sort_by_key(|(_, repository)| !repository.as_ref().is_ok_and(|repository| repository.root == repository.primary));
    let mut seen: HashSet<PathBuf> = HashSet::new();
    let mut out = Vec::new();
    for (project, repository) in &opened {
        let mut found = ProjectScan { path: project.path.clone(), name: project.name.clone(), note: None, candidates: Vec::new() };
        match repository {
            Err(note) => found.note = Some(note.clone()),
            Ok(repository) => {
                for entry in repository.listed.iter().filter(|entry| !entry.prunable) {
                    let path = canonical(Path::new(&entry.path));
                    if std::fs::symlink_metadata(&path).is_err() || !seen.insert(path) {
                        continue;
                    }
                    found.candidates.push(inspect(host, &roots, repository, entry, &sessions, &live));
                }
                if found.candidates.is_empty() {
                    found.note = Some("Its worktrees are listed under the project that holds its repository.".into());
                }
            }
        }
        out.push(found);
    }
    // In the order the projects are open in, not the order they were read in.
    out.sort_by_key(|found| host.projects.iter().position(|project| project.path == found.path));
    Ok(out)
}

fn result(item: &RemoveItem, outcome: Outcome, reason: impl Into<Option<String>>) -> ItemResult {
    ItemResult {
        project_path: item.project_path.clone(),
        path: item.path.clone(),
        outcome,
        reason: reason.into(),
        freed_bytes: 0,
        kept_branch: None,
        sessions_kept: Vec::new(),
        sessions_deleted: Vec::new(),
    }
}

/// A worktree that is not on disk. Nothing can be read of it, so nothing is
/// removed and git's records are left as they are. The one thing done here
/// finishes a removal that was cut short: when git no longer lists the
/// worktree but sessions that ran in it still point there, they are filed
/// under the project (never deleted).
fn reconcile(host: &Host<'_>, sink: &dyn EventSink, repository: &Repository<'_>, item: &RemoveItem, target: &Path) -> ItemResult {
    let Some(parent) = target.parent().filter(|parent| parent.is_dir()) else {
        return result(item, Outcome::Skipped, "Its folder cannot be reached, so nothing about it could be checked.".to_string());
    };
    let spelled = canonical(parent).join(target.file_name().unwrap_or_default());
    let sessions = match index::load() {
        Ok(sessions) => sessions,
        Err(error) => return result(item, Outcome::Failed, format!("The session index could not be read: {error:#}")),
    };
    // A root that is missing is still a root.
    let roots = Roots::of(host, &sessions);
    if roots.protected.iter().any(|(root, _)| root.starts_with(target) || root.starts_with(&spelled)) || host.confine.is_some_and(|inside| !spelled.starts_with(canonical(inside))) {
        return result(item, Outcome::Skipped, "That path is protected or outside this host's projects. Nothing was changed.".to_string());
    }
    let recorded = match list_worktrees(&repository.root) {
        Ok(listed) => listed.iter().any(|entry| Path::new(&entry.path) == target || Path::new(&entry.path) == spelled),
        Err(_) => return result(item, Outcome::Skipped, "Git could not list the project's worktrees, so nothing was changed.".to_string()),
    };
    if recorded {
        // Not removed by a clean-up: git would have dropped its record.
        return result(item, Outcome::Skipped, "Its folder is missing, but Git still lists it as a worktree. Nothing was changed.".to_string());
    }
    let left: Vec<SessionEntry> = sessions
        .into_iter()
        .filter(|session| {
            let cwd = Path::new(&session.cwd);
            session.worktree_name.is_some() && !session.worktree_removed && (cwd.starts_with(target) || cwd.starts_with(&spelled)) && canonical(Path::new(&session.project_path)) == repository.root
        })
        .collect();
    if left.is_empty() {
        return result(item, Outcome::Skipped, "Nothing is at that path. If an earlier clean-up removed it, there is nothing left to do.".to_string());
    }
    match session_ops::mark_workspace_sessions_removed(&repository.root, &left) {
        Ok(moved) => {
            let mut done = result(item, Outcome::AlreadyRemoved, "It was already removed; its conversations are now filed under the project.".to_string());
            done.sessions_kept = moved.iter().map(|session| session.id.clone()).collect();
            session_ops::notify_workspace_settled(sink, &repository.project.path, &moved);
            done
        }
        Err(error) => result(item, Outcome::Failed, format!("It is removed, but its sessions could not be updated: {error}")),
    }
}

fn remove_one(host: &Host<'_>, sink: &dyn EventSink, repositories: &[Repository<'_>], item: &RemoveItem) -> ItemResult {
    // The project is one that is open here, by where it really is.
    let asked = canonical(Path::new(&item.project_path));
    let Some(repository) = repositories.iter().find(|repository| same_dir(&repository.root, &asked)) else {
        return result(item, Outcome::Skipped, "That project is not open on this host.".to_string());
    };
    let target = Path::new(&item.path);
    if !target.is_absolute() {
        return result(item, Outcome::Skipped, "Not a path on this host.".to_string());
    }
    if std::fs::symlink_metadata(target).is_err() {
        return reconcile(host, sink, repository, item, target);
    }
    let target = canonical(target);
    // Only what git lists for this project's repository is a worktree of it.
    let Ok(listed) = list_worktrees(&repository.root) else {
        return result(item, Outcome::Skipped, "Git could not list the project's worktrees, so nothing was removed.".to_string());
    };
    let Some(entry) = listed.iter().find(|entry| !entry.prunable && same_dir(&canonical(Path::new(&entry.path)), &target)) else {
        return result(item, Outcome::Skipped, "That path is not a worktree of this project.".to_string());
    };
    // Measured first: walking a large tree takes a while, and nothing may
    // come between the inspection below and the removal.
    let freed = git::size_on_disk(&target);
    // Everything is read again now, as late as it can be.
    let sessions = match index::load() {
        Ok(sessions) => sessions,
        Err(error) => return result(item, Outcome::Skipped, format!("The session index could not be read, so nothing was removed: {error:#}")),
    };
    let roots = Roots::of(host, &sessions);
    let live = (host.live)(&sessions);
    let now = inspect(host, &roots, repository, entry, &sessions, &live);
    let allowed = match now.verdict {
        Verdict::Eligible => true,
        Verdict::IgnoredData => item.accept_ignored,
        _ => false,
    };
    if now.verdict == Verdict::Protected || (!allowed && now.token == item.token) {
        return result(item, Outcome::Skipped, now.reason.clone().unwrap_or_else(|| "It is not eligible for clean-up.".into()));
    }
    if now.token != item.token {
        let why = now.reason.as_deref().map(|reason| format!(" {reason}")).unwrap_or_default();
        return result(item, Outcome::Skipped, format!("It changed since it was reviewed, so it was left alone.{why}"));
    }
    let Some(head) = now.head.as_deref() else {
        return result(item, Outcome::Skipped, "It has no commit checked out.".to_string());
    };
    let affected = session_ops::sessions_within(sessions, &target);
    // Never forced, never deleted directly: git removes it or says why not.
    let options = crate::workspaces::DeleteOptions { delete_branch: false, direct: git::DirectDelete::Never, verified_head: Some(head) };
    if let Err(error) = crate::workspaces::delete(&repository.root, &target, options) {
        return result(item, Outcome::Failed, format!("{error:#}"));
    }
    let mut done = result(item, Outcome::Removed, None);
    done.freed_bytes = freed;
    done.kept_branch = now.branch.clone();
    if item.delete_sessions {
        if let Err(error) = session_ops::remove_session_entries(&affected) {
            done.outcome = Outcome::Failed;
            done.reason = Some(format!("It is removed, but its sessions could not be deleted: {error}. Run the clean-up again."));
            return done;
        }
        session_ops::notify_workspace_deleted(sink, &repository.project.path, &affected);
        done.sessions_deleted = affected.iter().map(|session| session.id.clone()).collect();
    } else {
        match session_ops::mark_workspace_sessions_removed(&repository.root, &affected) {
            Ok(moved) => {
                session_ops::notify_workspace_settled(sink, &repository.project.path, &moved);
                done.sessions_kept = moved.iter().map(|session| session.id.clone()).collect();
            }
            Err(error) => {
                done.outcome = Outcome::Failed;
                done.reason = Some(format!("It is removed, but its sessions could not be updated: {error}. Run the clean-up again."));
            }
        }
    }
    done
}

/// Remove the worktrees the person confirmed, each checked again first. One
/// that fails or is skipped never stops the others.
pub fn remove(host: &Host<'_>, sink: &dyn EventSink, items: &[RemoveItem]) -> Vec<ItemResult> {
    let repositories: Vec<Repository<'_>> = host.projects.iter().filter_map(|project| Repository::open(project, host.fetch).ok()).collect();
    let mut seen = HashSet::new();
    items.iter().filter(|item| seen.insert(item.path.clone())).map(|item| remove_one(host, sink, &repositories, item)).collect()
}

/// Size estimates that are under way, so each can be stopped by its id.
#[derive(Default)]
pub struct SizeJobs {
    running: Mutex<Vec<(String, Arc<AtomicBool>)>>,
}

impl SizeJobs {
    pub fn global() -> &'static SizeJobs {
        static JOBS: std::sync::OnceLock<SizeJobs> = std::sync::OnceLock::new();
        JOBS.get_or_init(Default::default)
    }

    fn start(&self, id: &str) -> Arc<AtomicBool> {
        let stop = Arc::new(AtomicBool::new(false));
        self.running.lock().unwrap().push((id.to_string(), stop.clone()));
        stop
    }

    fn finish(&self, stop: &Arc<AtomicBool>) {
        self.running.lock().unwrap().retain(|(_, running)| !Arc::ptr_eq(running, stop));
    }

    /// Stop the estimates whose id starts with `prefix`.
    pub fn cancel(&self, prefix: &str) {
        for (id, stop) in self.running.lock().unwrap().iter() {
            if id.starts_with(prefix) {
                stop.store(true, Ordering::SeqCst);
            }
        }
    }
}

fn walk_size(path: &Path, stop: &AtomicBool) -> Option<u64> {
    if stop.load(Ordering::Relaxed) {
        return None;
    }
    let Ok(meta) = std::fs::symlink_metadata(path) else { return Some(0) };
    #[cfg(unix)]
    let own = {
        use std::os::unix::fs::MetadataExt;
        meta.blocks() * 512
    };
    #[cfg(not(unix))]
    let own = meta.len();
    if !meta.is_dir() {
        return Some(own);
    }
    let mut total = own;
    for entry in std::fs::read_dir(path).into_iter().flatten().flatten() {
        total += walk_size(&entry.path(), stop)?;
    }
    Some(total)
}

/// What removing the worktree at `path` would free, or `None` when the
/// estimate was stopped. Only a worktree of an open project is measured.
pub fn estimate_size(host: &Host<'_>, jobs: &SizeJobs, job: &str, project_path: &str, path: &str) -> anyhow::Result<Option<u64>> {
    let asked = canonical(Path::new(project_path));
    let project = host.projects.iter().find(|project| same_dir(&canonical(Path::new(&project.path)), &asked)).ok_or_else(|| anyhow::anyhow!("that project is not open on this host"))?;
    let target = std::fs::canonicalize(path)?;
    let known = list_worktrees(Path::new(&project.path))?.iter().any(|entry| same_dir(&canonical(Path::new(&entry.path)), &target));
    anyhow::ensure!(known, "{path} is not a worktree of this project");
    let stop = jobs.start(job);
    let size = walk_size(&target, &stop);
    jobs.finish(&stop);
    Ok(size)
}

#[cfg(all(test, unix))]
#[path = "worktree_cleanup_tests.rs"]
mod tests;
