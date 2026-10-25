//! Removing a workspace by itself once its pull request has merged.
//!
//! Off unless the reader turns it on, per project. Like the bulk clean-up
//! (`worktree_cleanup.rs`) this runs on the host that owns the worktrees: in
//! the desktop app for local projects, in the workspace runtime for a cloud
//! VM. Whoever drives it says only which projects it is on for and how long
//! the grace period is; everything a removal rests on is read here.
//!
//! [`sweep`] is one pass. It looks at the worktrees TerminalX made in those
//! projects (never the repository's main directory, a worktree made by hand,
//! a detached HEAD or the default branch) and asks GitHub for the pull
//! request of each one's branch, in one request per project. Only a pull
//! request that is `MERGED` counts: an open one, one closed without merging,
//! or a newer open one on the same branch leaves the worktree alone. A
//! worktree whose pull request merged is then:
//!
//! - **kept**, with the reason in a few words ("2 uncommitted files"), when
//!   any check fails. The checks are the bulk clean-up's inspection (nothing
//!   uncommitted, no commits only on this machine, no ignored local files
//!   other than known build output, no Git operation in progress, not a
//!   protected root, no turn running and no terminal open) followed by the
//!   clean-and-merged check every removal makes (`landed.rs`), which is what
//!   recognises a squash or rebase merge and refuses a branch that holds a
//!   commit the default branch does not. Nothing is ever forced.
//! - **scheduled**: every check passes. It goes once the grace period has
//!   run since the merge was first seen, and since anything last happened in
//!   its sessions if that is later. The grace period only runs while passes
//!   do: after a gap (the app was closed, the machine asleep, the setting
//!   off) it starts again, so nothing goes the moment the app comes back.
//! - **held**: the reader said to keep it.
//! - **removed**, through [`session_ops::remove_workspace`], the one path
//!   every removal takes. That stops the agents that sit idle in it, checks
//!   it again, and removes it without `--force`. Its local branch goes only
//!   while it is still at the commit that was checked. Its branch on the
//!   remote goes only while it still points at the commit that was merged
//!   (the pull request's head): the push that deletes it carries that
//!   commit as a lease, so a branch that moved is refused by the remote
//!   itself, kept, and reported. A remote that cannot be reached leaves the
//!   remote branch and is reported too; the local removal stands.
//!
//! Every removal is written down ([`Record`]: workspace, branch, commit, pull
//! request, what became of each branch), and [`restore`] undoes one while the
//! commit is still in the repository: the branch, the worktree at its old
//! path, the branch on the remote if this deleted it, and the sessions that
//! have not been used since. What is restored is held, so it is not removed
//! again.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::git;
use crate::github::BranchPr;
use crate::landed::{self, Fetch, Landed};
use crate::session_ops::{self, Confirmation, SessionsFate, WorkspaceRemoval};
use crate::sink::EventSink;
use crate::store::index::{self, SessionEntry};
use crate::worktree_cleanup::{self as cleanup, plural, Activity, Candidate, Host, Listed, Repository, Roots, Verdict};

/// The remote a workspace's branch is pushed to, as everywhere else here.
const REMOTE: &str = "origin";
/// How long the remote may take to say where a branch is, or to delete it.
const REMOTE_TIMEOUT: Duration = Duration::from_secs(30);
/// How many removals are remembered.
const REMEMBERED: usize = 200;
/// No grace period is longer than this, whatever a driver asks for.
const LONGEST_GRACE: i64 = 366 * 24 * 60 * 60;
/// With no pass for this long, nobody was watching: what was waiting to be
/// removed waits out its grace period again.
const WATCH_GAP: i64 = 15 * 60;

/// One pass at a time on a host: two windows asking at once must not both
/// remove, or both write the ledger.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PrRef {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// The commit that was merged: the pull request's head.
    pub head: String,
}

/// What became of a branch when its workspace was removed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "outcome", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum BranchFate {
    Deleted,
    /// It was not there any more (GitHub deletes a merged branch itself when
    /// the repository is set to).
    AlreadyGone,
    /// The remote branch points at another commit than the one that was
    /// merged, so it was kept.
    Moved { at: String },
    Kept { reason: String },
}

/// One removal, so it can be found, and undone, later.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub id: String,
    pub removed_at: String,
    pub project_path: String,
    pub path: String,
    pub name: String,
    pub branch: String,
    /// The commit the workspace was at.
    pub commit: String,
    pub pr: PrRef,
    pub local_branch: BranchFate,
    pub remote_branch: BranchFate,
    /// The sessions whose conversations were kept and filed under the project.
    pub sessions_kept: Vec<String>,
    pub sessions_deleted: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restored_at: Option<String>,
}

/// A removal with whether it can still be undone.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecordView {
    #[serde(flatten)]
    pub record: Record,
    /// Why it cannot be brought back; `None` when it can.
    pub blocked: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Scheduled,
    Kept,
    Held,
    Removed,
}

/// Where one workspace whose pull request merged stands after a pass.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub project_path: String,
    pub path: String,
    pub name: String,
    pub branch: String,
    pub pr: PrRef,
    pub phase: Phase,
    /// Why it stays, in a few words. Only when kept.
    pub reason: Option<String>,
    /// The same in full.
    pub detail: Option<String>,
    /// When it goes if nothing changes. Only when scheduled.
    pub due: Option<String>,
    /// The merge was first seen in this pass.
    pub fresh: bool,
    /// The sessions in it.
    pub sessions: Vec<String>,
    /// What was removed. Only when removed.
    pub record: Option<Record>,
}

/// A project whose pull requests could not be read: nothing in it was looked
/// at, so nothing in it goes until they can be.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Unreadable {
    pub project_path: String,
    pub reason: String,
}

/// What one pass found.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Swept {
    pub statuses: Vec<Status>,
    pub unreadable: Vec<Unreadable>,
}

/// What the driver decides: where it is on, and how patient it is.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    /// The projects it is on for, by their path on this host.
    pub projects: Vec<String>,
    /// Delete the conversations of the sessions in a removed workspace too.
    #[serde(default)]
    pub delete_sessions: bool,
    pub grace_seconds: u64,
}

/// The pull request of each branch of the repository at a path; a branch
/// with none is left out.
pub type PullRequests<'a> = &'a dyn Fn(&Path, &[String]) -> anyhow::Result<HashMap<String, BranchPr>>;

/// Everything one pass reads about its host.
pub struct Sweep<'a> {
    pub host: &'a Host<'a>,
    pub sink: &'a dyn EventSink,
    /// Ends what a session runs, and waits: what the removal dialog's path
    /// does before it removes.
    pub stop: &'a dyn Fn(&SessionEntry),
    pub pull_requests: PullRequests<'a>,
    pub now: DateTime<Utc>,
}

/// Owner-backed sweeps must propagate an unconfirmed process stop into the
/// existing per-workspace refusal report, without recording successful removal.
pub(crate) struct FallibleSweep<'a> {
    pub host: &'a Host<'a>,
    pub sink: &'a dyn EventSink,
    pub stop: &'a dyn Fn(&SessionEntry) -> Result<(), String>,
    pub pull_requests: PullRequests<'a>,
    pub now: DateTime<Utc>,
}

/// A workspace whose pull request was seen merged and that is still there.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Seen {
    project_path: String,
    pr: PrRef,
    first_seen: String,
    /// The reader said to keep this one.
    #[serde(default)]
    held: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Ledger {
    /// By the workspace's path on this host.
    seen: BTreeMap<String, Seen>,
    /// Oldest first.
    removed: Vec<Record>,
    /// When the last pass ran while anything was waiting.
    #[serde(skip_serializing_if = "Option::is_none")]
    swept_at: Option<String>,
}

impl Ledger {
    fn file() -> anyhow::Result<PathBuf> {
        Ok(crate::store::root()?.join("merged-cleanup.json"))
    }

    /// A ledger that cannot be read stops the pass: what it holds (a hold,
    /// when a merge was first seen) is not something to guess at.
    fn load() -> anyhow::Result<Self> {
        Ok(crate::store::read_json(&Self::file()?)?.unwrap_or_default())
    }

    fn save(&mut self) -> anyhow::Result<()> {
        let extra = self.removed.len().saturating_sub(REMEMBERED);
        self.removed.drain(..extra);
        crate::store::write_json(&Self::file()?, self)
    }
}

fn stamp(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn parse(at: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(at.trim()).ok().map(|at| at.with_timezone(&Utc))
}

/// Why a worktree the inspection did not pass stays, in a few words.
fn brief_of(candidate: &Candidate) -> String {
    candidate.brief.clone().unwrap_or_else(|| {
        match candidate.verdict {
            Verdict::Protected => "it is protected",
            Verdict::Unverifiable => "it could not be checked",
            _ => "it is not safe to remove",
        }
        .to_string()
    })
}

/// Why a workspace that is not clean and merged stays: `(brief, detail)`.
fn unlanded(landed: &Landed) -> (String, String) {
    let base = landed.base.as_deref().unwrap_or("the default branch");
    let brief = if !landed.checked {
        "it could not be checked".to_string()
    } else if landed.uncommitted > 0 {
        plural(landed.uncommitted as usize, "uncommitted file", "uncommitted files")
    } else if landed.stashes > 0 {
        plural(landed.stashes as usize, "stash entry on its branch", "stash entries on its branch")
    } else if landed.merged.is_none() && landed.unmerged_commits > 0 {
        format!("{} not in {base}", plural(landed.unmerged_commits as usize, "commit is", "commits are"))
    } else if landed.merged.is_none() {
        format!("its branch is not known to be merged into {base}")
    } else if landed.not_verified.is_some() || !landed.fresh {
        "the merge could not be verified".to_string()
    } else {
        "it is not clean and merged".to_string()
    };
    (brief, landed.losses.join(" "))
}

/// Whether the default branch has been fetched for a project in this pass.
enum Fetched {
    NotYet,
    Yes,
    /// It could not be: asking again for every worktree would only wait as
    /// long each time.
    Failed(String),
}

struct Pass<'a> {
    run: &'a FallibleSweep<'a>,
    scope: &'a Scope,
    ledger: Ledger,
    /// The workspaces looked at, by path: what the ledger goes on holding.
    visited: HashSet<String>,
    /// The workspaces whose grace period started again in this pass.
    restarted: HashSet<String>,
    out: Vec<Status>,
    unreadable: Vec<Unreadable>,
}

impl Pass<'_> {
    fn status(&mut self, repository: &Repository<'_>, path: &str, name: &str, branch: &str, phase: Phase) -> &mut Status {
        let seen = &self.ledger.seen[path];
        self.out.push(Status {
            project_path: repository.project.path.clone(),
            path: path.to_string(),
            name: name.to_string(),
            branch: branch.to_string(),
            pr: seen.pr.clone(),
            phase,
            reason: None,
            detail: None,
            due: None,
            fresh: false,
            sessions: Vec::new(),
            record: None,
        });
        self.out.last_mut().expect("just pushed")
    }

    fn project(&mut self, repository: &Repository<'_>) {
        let default = git::default_branch(&repository.root);
        let managed_root = cleanup::canonical(&git::worktree_root(&repository.root));
        let worktrees: Vec<(&Listed, PathBuf, String)> = repository
            .listed
            .iter()
            .filter(|entry| !entry.prunable)
            .filter_map(|entry| {
                let path = cleanup::canonical(Path::new(&entry.path));
                // Only a worktree TerminalX made, never the main directory,
                // and never one on the default branch or on no branch.
                let ours = std::fs::symlink_metadata(&path).is_ok() && !cleanup::same_dir(&path, &repository.primary) && path.parent() == Some(managed_root.as_path());
                let branch = entry.branch.clone().filter(|branch| default.as_deref() != Some(branch.as_str()))?;
                (ours && !self.visited.contains(path.to_string_lossy().as_ref())).then_some((entry, path, branch))
            })
            .collect();
        if worktrees.is_empty() {
            return;
        }
        let branches: Vec<String> = worktrees.iter().map(|(_, _, branch)| branch.clone()).collect();
        let prs = match (self.run.pull_requests)(&repository.root, &branches) {
            Ok(prs) => prs,
            Err(error) => {
                // Nothing is known, so nothing is forgotten and nothing goes.
                self.unreadable.push(Unreadable { project_path: repository.project.path.clone(), reason: format!("{error:#}") });
                for (_, path, branch) in &worktrees {
                    let key = path.to_string_lossy().into_owned();
                    if self.ledger.seen.contains_key(&key) && self.visited.insert(key.clone()) {
                        let held = self.ledger.seen[&key].held;
                        let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
                        let status = self.status(repository, &key, &name, branch, if held { Phase::Held } else { Phase::Kept });
                        if !held {
                            status.reason = Some("GitHub could not be asked".into());
                            status.detail = Some(format!("{error:#}"));
                        }
                    }
                }
                return;
            }
        };
        let mut fetched = Fetched::NotYet;
        for (entry, path, branch) in &worktrees {
            let Some(pr) = prs.get(branch).filter(|pr| pr.state == "MERGED" && pr.base != *branch) else { continue };
            self.workspace(repository, entry, path, branch, pr, &mut fetched);
        }
    }

    fn workspace(&mut self, repository: &Repository<'_>, entry: &Listed, path: &Path, branch: &str, pr: &BranchPr, fetched: &mut Fetched) {
        let key = path.to_string_lossy().into_owned();
        self.visited.insert(key.clone());
        let name = path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
        // Another pull request merging on the same branch starts over.
        let new = self.ledger.seen.get(&key).is_none_or(|seen| seen.pr.number != pr.number);
        let fresh = new || self.restarted.contains(&key);
        if new {
            let pr = PrRef { number: pr.number, title: pr.title.clone(), url: pr.url.clone(), head: pr.head.clone() };
            self.ledger.seen.insert(key.clone(), Seen { project_path: repository.project.path.clone(), pr, first_seen: stamp(self.run.now), held: false });
        }
        let seen = self.ledger.seen[&key].clone();
        if seen.held {
            self.status(repository, &key, &name, branch, Phase::Held);
            return;
        }
        let keep = |pass: &mut Self, sessions: Vec<String>, reason: String, detail: Option<String>| {
            let status = pass.status(repository, &key, &name, branch, Phase::Kept);
            (status.reason, status.detail, status.fresh, status.sessions) = (Some(reason), detail, fresh, sessions);
        };

        let sessions = match index::load() {
            Ok(sessions) => sessions,
            Err(error) => return keep(self, Vec::new(), "the session index could not be read".into(), Some(format!("{error:#}"))),
        };
        let roots = Roots::of(self.run.host, &sessions);
        let live = (self.run.host.live)(&sessions);
        let candidate = cleanup::inspect(self.run.host, &roots, repository, entry, &sessions, &live, Activity::Engaged);
        let ids: Vec<String> = candidate.sessions.iter().map(|session| session.id.clone()).collect();
        if candidate.verdict != Verdict::Eligible {
            return keep(self, ids, brief_of(&candidate), candidate.reason.clone());
        }
        if candidate.branch.as_deref() != Some(branch) {
            return keep(self, ids, "its branch changed while it was being checked".into(), None);
        }

        // Clean and merged, against the default branch as the remote has it
        // now: one fetch for all of a project's workspaces.
        let checked = match fetched {
            Fetched::Failed(why) => return keep(self, ids, "the merge could not be verified".into(), Some(why.clone())),
            Fetched::NotYet => landed::check(&repository.root, path, Fetch::Fresh),
            Fetched::Yes => landed::check(&repository.root, path, Fetch::JustFetched),
        };
        if matches!(fetched, Fetched::NotYet) {
            *fetched = if checked.fresh { Fetched::Yes } else { Fetched::Failed(checked.losses.join(" ")) };
        }
        if !checked.safe {
            let (brief, detail) = unlanded(&checked);
            return keep(self, ids, brief, Some(detail));
        }

        // Quiet for the whole grace period: a turn that ended a minute ago
        // is someone still at work in it.
        let first_seen = parse(&seen.first_seen).unwrap_or(self.run.now);
        let since = candidate.sessions.iter().filter_map(|session| parse(&session.modified)).fold(first_seen, Ord::max);
        let due = since + chrono::Duration::seconds(i64::try_from(self.scope.grace_seconds).unwrap_or(LONGEST_GRACE).min(LONGEST_GRACE));
        if self.run.now < due {
            let status = self.status(repository, &key, &name, branch, Phase::Scheduled);
            (status.due, status.fresh, status.sessions) = (Some(stamp(due)), fresh, ids);
            return;
        }

        match remove(self.run, self.scope, repository, entry, &candidate, &checked, &seen.pr) {
            Err((reason, detail)) => keep(self, ids, reason, detail),
            Ok(record) => {
                let status = self.status(repository, &key, &name, branch, Phase::Removed);
                (status.fresh, status.sessions, status.record) = (fresh, ids, Some(record.clone()));
                self.ledger.seen.remove(&key);
                self.ledger.removed.push(record);
                // Written at once: a pass that fails later must not lose
                // the record of what is already gone.
                if let Err(error) = self.ledger.save() {
                    log::error!("a workspace was removed but the record could not be saved: {error:#}");
                }
            }
        }
    }
}

/// Remove one workspace that passed every check, with its branches.
/// `Err` is why it stayed: `(brief, detail)`.
fn remove(run: &FallibleSweep<'_>, scope: &Scope, repository: &Repository<'_>, entry: &Listed, candidate: &Candidate, checked: &Landed, pr: &PrRef) -> Result<Record, (String, Option<String>)> {
    let (Some(branch), Some(head)) = (candidate.branch.as_deref(), checked.head.as_deref()) else {
        return Err(("it has no branch checked out".into(), None));
    };
    let expected: Vec<String> = candidate.sessions.iter().map(|session| session.id.clone()).collect();
    // The idle agents in it are stopped by now. Anything still alive there
    // is not ours to end, and anything that changed is not what was checked.
    let refused: RefCell<Option<(String, Option<String>)>> = RefCell::new(None);
    let guard = || -> Result<(), String> {
        let refuse = |brief: String, detail: Option<String>| {
            *refused.borrow_mut() = Some((brief.clone(), detail));
            Err(brief)
        };
        let sessions = match index::load() {
            Ok(sessions) => sessions,
            Err(error) => return refuse("the session index could not be read".into(), Some(format!("{error:#}"))),
        };
        let roots = Roots::of(run.host, &sessions);
        let live = (run.host.live)(&sessions);
        let now = cleanup::inspect(run.host, &roots, repository, entry, &sessions, &live, Activity::Anything);
        if now.verdict != Verdict::Eligible {
            return refuse(brief_of(&now), now.reason.clone());
        }
        if now.head.as_deref() != Some(head) || now.branch.as_deref() != Some(branch) {
            return refuse("it changed while it was being checked".into(), None);
        }
        Ok(())
    };
    let request = WorkspaceRemoval {
        project_path: &repository.project.path,
        path: &candidate.path,
        sessions: if scope.delete_sessions { SessionsFate::Delete } else { SessionsFate::Keep },
        delete_branch: true,
        // Only what is found clean and merged goes: nothing confirms more.
        confirmation: Confirmation::Single,
        expected_sessions: Some(&expected),
        direct: git::DirectDelete::Never,
        fetch: Fetch::JustFetched,
        guard: Some(&guard),
    };
    let removed = match session_ops::remove_workspace_fallible(run.sink, &request, run.stop) {
        Ok(removed) => removed,
        Err(error) => {
            return Err(match refused.take() {
                Some(why) => why,
                None if error.starts_with(session_ops::NEEDS_CONFIRMATION) => ("it is no longer clean and merged".into(), Some(error)),
                None if error.starts_with(session_ops::SESSIONS_CHANGED) => ("its sessions changed while it was being checked".into(), Some(error)),
                None => ("it could not be removed".into(), Some(error)),
            })
        }
    };

    let local_branch = match removed.removal.kept_branch {
        Some(_) => BranchFate::Kept { reason: "it was no longer at the commit that was checked".into() },
        None => BranchFate::Deleted,
    };
    let remote_branch = match local_branch {
        BranchFate::Deleted => delete_remote_branch(&repository.root, branch, &pr.head),
        _ => BranchFate::Kept { reason: "the local branch was kept".into() },
    };
    let ids: Vec<String> = removed.sessions.iter().map(|session| session.id.clone()).collect();
    let (sessions_kept, sessions_deleted) = if scope.delete_sessions { (Vec::new(), ids) } else { (ids, Vec::new()) };
    Ok(Record {
        id: uuid::Uuid::now_v7().to_string(),
        // Not before the sessions were filed under the project, which is
        // what "not used since" is measured from.
        removed_at: stamp(run.now.max(Utc::now())),
        project_path: repository.project.path.clone(),
        path: candidate.path.clone(),
        name: candidate.name.clone(),
        branch: branch.to_string(),
        commit: head.to_string(),
        pr: pr.clone(),
        local_branch,
        remote_branch,
        sessions_kept,
        sessions_deleted,
        restored_at: None,
    })
}

/// The commit `branch` is at on the remote; `None` when it has no such branch.
fn remote_tip(project: &Path, branch: &str) -> Result<Option<String>, git::RunError> {
    let reference = format!("refs/heads/{branch}");
    let out = git::run_bounded(project, &["ls-remote", REMOTE, &reference], REMOTE_TIMEOUT)?;
    Ok(out.lines().find_map(|line| line.split_once('\t').filter(|(_, name)| *name == reference).map(|(sha, _)| sha.to_string())))
}

/// Delete `branch` on the remote if, and only if, it is at `merged`. The
/// remote decides: the push names the commit it expects there, so a branch
/// that moved between the look and the push is refused, not deleted. With the
/// reader's own git credentials; a hook has no commits to vet in a deletion.
fn delete_remote_branch(project: &Path, branch: &str, merged: &str) -> BranchFate {
    let at = match remote_tip(project, branch) {
        Err(error) => return BranchFate::Kept { reason: format!("{REMOTE} could not be asked where it is: {error}") },
        Ok(None) => return BranchFate::AlreadyGone,
        Ok(Some(at)) => at,
    };
    if at != merged {
        return BranchFate::Moved { at };
    }
    let reference = format!("refs/heads/{branch}");
    let lease = format!("--force-with-lease={reference}:{merged}");
    match git::run_bounded(project, &["push", "--quiet", "--no-verify", &lease, REMOTE, &format!(":{reference}")], REMOTE_TIMEOUT) {
        Ok(_) => BranchFate::Deleted,
        // Refused, or the answer was lost: what the remote has now says which.
        Err(error) => match remote_tip(project, branch) {
            Ok(None) => BranchFate::AlreadyGone,
            Ok(Some(at)) if at != merged => BranchFate::Moved { at },
            _ => BranchFate::Kept { reason: format!("it could not be deleted: {error}") },
        },
    }
}

/// One pass over the projects in `scope`: see what merged, keep what is not
/// safe and say why, and remove what is safe and due. With no project in
/// scope it removes nothing and forgets what it had seen.
pub fn sweep(run: &Sweep<'_>, scope: &Scope) -> anyhow::Result<Swept> {
    sweep_fallible(&FallibleSweep { host: run.host, sink: run.sink,
        stop: &|entry| { (run.stop)(entry); Ok(()) }, pull_requests: run.pull_requests, now: run.now }, scope)
}

pub(crate) fn sweep_fallible(run: &FallibleSweep<'_>, scope: &Scope) -> anyhow::Result<Swept> {
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let wanted: Vec<PathBuf> = scope.projects.iter().map(|path| cleanup::canonical(Path::new(path))).collect();
    let on_for = |path: &str| {
        let path = cleanup::canonical(Path::new(path));
        wanted.iter().any(|wanted| cleanup::same_dir(wanted, &path))
    };
    let mut pass = Pass { run, scope, ledger: Ledger::load()?, visited: HashSet::new(), restarted: HashSet::new(), out: Vec::new(), unreadable: Vec::new() };
    let before = serde_json::to_value(&pass.ledger.seen)?;
    let watched = pass.ledger.swept_at.as_deref().and_then(parse).is_some_and(|at| (run.now - at).num_seconds() <= WATCH_GAP);
    if !watched {
        for (path, seen) in pass.ledger.seen.iter_mut().filter(|(_, seen)| !seen.held) {
            seen.first_seen = stamp(run.now);
            pass.restarted.insert(path.clone());
        }
    }
    for project in run.host.projects.iter().filter(|project| on_for(&project.path)) {
        if let Ok(repository) = Repository::open(project, run.host.fetch) {
            pass.project(&repository);
        }
    }
    // What was not looked at is forgotten: a workspace that is gone, one
    // whose pull request no longer speaks for it, and everything in a
    // project it is off for, so that turning it on again starts the grace
    // period again. Only the reader's own "keep" outlives that, for as long
    // as the workspace is there.
    let Pass { mut ledger, visited, out, unreadable, .. } = pass;
    ledger.seen.retain(|path, seen| visited.contains(path) || (seen.held && std::fs::symlink_metadata(path).is_ok()));
    // While anything waits, each pass is noted, so that a gap can be told.
    let waiting = ledger.seen.values().any(|seen| !seen.held);
    ledger.swept_at = waiting.then(|| stamp(run.now));
    if waiting || serde_json::to_value(&ledger.seen)? != before {
        ledger.save()?;
    }
    Ok(Swept { statuses: out, unreadable })
}

/// Keep the workspace at `path` (or stop keeping it): the reader's answer to
/// "it will be deleted". Letting go of it starts the grace period again.
pub fn hold(path: &str, held: bool, now: DateTime<Utc>) -> anyhow::Result<()> {
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut ledger = Ledger::load()?;
    // Only a workspace this host has seen merged: the path is a key here,
    // never something to act on.
    let seen = ledger.seen.get_mut(path).ok_or_else(|| anyhow::anyhow!("that workspace is not waiting to be removed"))?;
    seen.held = held;
    if !held {
        seen.first_seen = stamp(now);
    }
    ledger.save()
}

/// Where a recorded removal can be put back, or why it cannot.
fn restorable<'a>(host: &'a Host<'_>, record: &Record) -> Result<(&'a crate::store::projects::Project, PathBuf), String> {
    if record.restored_at.is_some() {
        return Err("It was brought back already.".into());
    }
    let asked = cleanup::canonical(Path::new(&record.project_path));
    let project = host.projects.iter().find(|project| cleanup::same_dir(&cleanup::canonical(Path::new(&project.path)), &asked)).ok_or("Its project is not open here.")?;
    let root = cleanup::canonical(Path::new(&project.path));
    if !git::is_repo(&root) {
        return Err("Its project is not a Git repository any more.".into());
    }
    // It was one of the project's own worktrees, and goes back nowhere else.
    let path = Path::new(&record.path);
    let managed_root = cleanup::canonical(&git::worktree_root(&root));
    let name = path.file_name().filter(|name| !name.is_empty() && *name != "..").ok_or("Its path is not a workspace's.")?;
    if !path.is_absolute() || path.parent().map(cleanup::canonical).as_deref() != Some(managed_root.as_path()) {
        return Err("Its path is not in the project's worktree folder.".into());
    }
    let path = managed_root.join(name);
    if host.confine.is_some_and(|inside| !path.starts_with(cleanup::canonical(inside))) {
        return Err("Its path is outside this workspace.".into());
    }
    if std::fs::symlink_metadata(&path).is_ok() {
        return Err("Something is at its path again.".into());
    }
    let commit = record.commit.as_str();
    if commit.len() < 40 || !commit.bytes().all(|byte| byte.is_ascii_hexdigit()) || git::run(&root, &["cat-file", "-e", &format!("{commit}^{{commit}}")]).is_err() {
        return Err("Its commit is no longer in the repository.".into());
    }
    if let Ok(tip) = git::run(&root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", record.branch)]) {
        if tip.trim() != commit {
            return Err(format!("The branch {} exists again, at another commit.", record.branch));
        }
    }
    Ok((project, path))
}

/// What was removed on this host, newest first, with whether each can still
/// be brought back.
pub fn records(host: &Host<'_>) -> anyhow::Result<Vec<RecordView>> {
    let ledger = Ledger::load()?;
    Ok(ledger.removed.into_iter().rev().map(|record| RecordView { blocked: restorable(host, &record).err(), record }).collect())
}

/// What an undo did.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Restored {
    pub record: Record,
    /// What could not be put back, in words; empty when everything was.
    pub notes: Vec<String>,
}

/// Undo one removal: the branch at the commit it was at, the worktree at its
/// old path, the branch on the remote if this deleted it, and the sessions
/// that have not been used since. The workspace is held afterwards.
pub fn restore(host: &Host<'_>, sink: &dyn EventSink, id: &str, now: DateTime<Utc>) -> anyhow::Result<Restored> {
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut ledger = Ledger::load()?;
    let record = ledger.removed.iter().find(|record| record.id == id).cloned().ok_or_else(|| anyhow::anyhow!("no such removal is recorded here"))?;
    let (project, path) = restorable(host, &record).map_err(|why| anyhow::anyhow!(why))?;
    let root = cleanup::canonical(Path::new(&project.path));
    let target = path.to_str().ok_or_else(|| anyhow::anyhow!("its path is not a name git can be given"))?;
    let exists = git::run(&root, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", record.branch)]).is_ok();
    if exists {
        git::run(&root, &["worktree", "add", "--", target, &record.branch])?;
    } else {
        git::run(&root, &["worktree", "add", "--no-track", "-b", &record.branch, "--", target, &record.commit])?;
    }

    let mut notes = Vec::new();
    if record.remote_branch == BranchFate::Deleted {
        // Put back only where there is nothing: the lease expects no branch.
        let reference = format!("refs/heads/{}", record.branch);
        let pushed = git::run_bounded(&root, &["push", "--quiet", "--no-verify", &format!("--force-with-lease={reference}:"), REMOTE, &format!("{}:{reference}", record.commit)], REMOTE_TIMEOUT);
        if let Err(error) = pushed {
            notes.push(format!("The branch could not be put back on {REMOTE}: {error}. Push it from the workspace when you want it there."));
        }
    }

    // A session goes back only as it was left: one used since has gone on
    // from the project, and its conversation is there now.
    let removed_at = parse(&record.removed_at);
    let mut used_since = Vec::new();
    let moved = index::update(|sessions| {
        let mut moved = Vec::new();
        for session in sessions.iter_mut().filter(|session| record.sessions_kept.contains(&session.id)) {
            let from_here = session.worktree_removed && session.removed_workspace.as_ref().is_some_and(|removed| removed.path == record.path);
            if !from_here {
                continue;
            }
            if parse(&session.modified).zip(removed_at).is_none_or(|(modified, removed_at)| modified > removed_at) {
                used_since.push(session.title.clone());
                continue;
            }
            session.cwd = record.path.clone();
            session.worktree_name = Some(record.name.clone());
            session.worktree_removed = false;
            session.removed_workspace = None;
            session.branch = Some(record.branch.clone());
            session.modified = index::now();
            moved.push(session.clone());
        }
        Ok(moved)
    })?;
    for title in used_since {
        notes.push(format!("The session \"{title}\" has been used since and stays under the project."));
    }
    if !record.sessions_deleted.is_empty() {
        notes.push(format!("{} deleted with it and cannot be brought back.", plural(record.sessions_deleted.len(), "conversation was", "conversations were")));
    }
    session_ops::notify_workspace_settled(sink, &project.path, &moved);

    // Brought back is kept: its pull request is still merged, and the next
    // pass must not take it again.
    let pr = record.pr.clone();
    ledger.seen.insert(path.to_string_lossy().into_owned(), Seen { project_path: project.path.clone(), pr, first_seen: stamp(now), held: true });
    let restored = ledger.removed.iter_mut().find(|record| record.id == id).map(|record| {
        record.restored_at = Some(stamp(now));
        record.clone()
    });
    ledger.save()?;
    Ok(Restored { record: restored.unwrap_or(record), notes })
}

#[cfg(all(test, unix))]
mod tests {
    include!("merged_cleanup_tests.rs");
    include!("local_runtime/merged_stop_regression.rs");
}
