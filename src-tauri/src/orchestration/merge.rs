//! Bringing the accepted pieces of a run together in the lead's branch (PRO-279).
//!
//! Each worker ends with its result on a branch of its own. `runs merge`
//! merges every accepted piece into the lead's branch, one at a time, each
//! after the pieces it depends on ([`Run::merge_order`]). It is git work and
//! TerminalX does it itself; no model takes part:
//!
//! 1. **Probe.** `git merge-tree` computes the merge in the object store. A
//!    conflict is known before the lead's branch, index or files are touched:
//!    the piece is marked `conflict` with the files, and the pass stops there.
//! 2. **Merge.** `git merge --no-ff` of the commit the piece was accepted as
//!    ([`Piece::accepted_commit`]), not of wherever its branch is now. One
//!    merge commit a piece: `before..after` is that piece's range.
//! 3. **Check.** The run's integration check is run on the result, by the
//!    gate runner the pieces' own checks use ([`verify::run_command`]). When
//!    it fails, that merge alone is undone (the branch goes back to `before`),
//!    the piece is marked `integrationFailed` with what the check printed, and
//!    the pass goes on with the pieces that do not depend on it.
//!
//! When every piece is in, each piece's command done-checks are run once more
//! on the merged result, and only then is the run `done`.
//!
//! The pass holds the lead's checkout ([`Checkouts::reserve`]) from its first
//! look to its last command. It never pushes, never checks out or moves any
//! branch but the lead's, and never deletes a worker's branch or worktree:
//! that is [`cleanup`], which a person or the lead asks for by name and which
//! refuses a worktree with work that is not committed or not merged.
//!
//! The lead's branch must be a branch of its own. A lead working in the
//! project's own checkout may be on the default branch, or on one that others
//! build on: the base of an open pull request, or one whose upstream someone
//! else pushes to. Those are refused before git is asked to change anything
//! ([`SharedBranch`]).
//!
//! A pass is pure git work and costs no model tokens, so it runs in a run
//! paused on its budget (`needsYou`) as in a live one. The one model call of
//! the merge stage, the lead resolving a conflict, is what the budget holds
//! back (`engine::resolve_in_lead`).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use serde_json::json;

use super::engine::{By, EngineError};
use super::verify::{self, CommandRun};
use super::{plan, store, Check, ConflictFile, FinalCheck, MergeState, PendingMerge, Piece, PieceMerge, PieceState, Run, RunMerge, RunState, SessionRef};

/// The most of one conflicting place that is kept, in lines and in characters.
const EXCERPT_LINES: usize = 40;
const EXCERPT_CHARS: usize = 2000;
/// The most conflicting files whose contents are read; the rest are named.
const EXCERPT_FILES: usize = 12;
/// The most a worker is sent about a merge that failed.
pub const BRIEF_LIMIT: usize = 6000;
/// The most the lead is sent to resolve a conflict: both sides of each
/// conflicting place and the goals of the pieces involved, and no transcript.
pub const RESOLVE_LIMIT: usize = 12_000;

/// A worker's worktree, as [`cleanup`] needs to see it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    pub path: PathBuf,
    /// An agent is running in a session there.
    pub busy: bool,
}

/// What merging needs of the app: the lead's checkout, a hold on it, and the
/// workers' worktrees. The app's sessions give it ([`super::host::ManagerHost`]);
/// the tests give it temporary repositories.
pub trait Checkouts: Send + Sync {
    /// The lead's checkout: where the pieces are merged.
    fn lead_checkout(&self, run: &Run) -> anyhow::Result<PathBuf>;
    /// The permission mode of the lead's conversation, when it can be read.
    fn lead_mode(&self, run: &Run) -> Option<String>;
    /// Keep every other writer out of the lead's checkout until what this
    /// returns is dropped: no pipeline's checks or resolver, no new turn of
    /// another conversation there. `by_lead` says the lead's own turn asked,
    /// so that turn is not one to wait for. `Err` says who holds it now.
    fn reserve(&self, run: &Run, cwd: &Path, by_lead: bool) -> Result<Box<dyn std::any::Any + Send>, String>;
    /// The project's own check command: the integration check of a plan that names none.
    fn project_check(&self, project_path: &str) -> Option<String>;
    /// The open pull requests whose base is `branch` in the checkout's repository: none for a
    /// repository with no remote, `None` when the forge cannot be asked.
    fn open_prs_into(&self, cwd: &Path, branch: &str) -> Option<Vec<u64>>;
    /// A worker's worktree. `None` when its session is gone, or runs in no worktree of its own.
    fn worktree(&self, worker: &SessionRef) -> Option<Worktree>;
    /// Remove a worker's worktree and the session in it. Its branch stays.
    /// `still_safe` is asked again once the session is stopped, immediately before the folder goes.
    fn remove(&self, run: &Run, worker: &SessionRef, worktree: &Worktree, still_safe: &dyn Fn() -> Result<(), String>) -> anyhow::Result<()>;
    /// The stored run changed.
    fn changed(&self, run: &Run);
}

/// What keeps a pass from beginning.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Holder {
    /// A pass is merging the run.
    Merge,
    /// A piece of the run is being sent back to its worker (`engine::send_back`): a pass
    /// beginning meanwhile could merge the commit that is being sent back.
    SendBack,
    /// The run's worktrees are being cleaned up ([`cleanup`]).
    Cleanup,
}

/// Who holds which run. One pass at a time across runs: two would both move
/// the same branch where runs share a lead. Nothing else of a run goes on
/// while a pass or another hold is on it.
static HOLDS: Mutex<Vec<(String, Holder)>> = Mutex::new(Vec::new());

/// A run held from merging, or held by a pass merging it, until this is dropped.
pub struct Hold {
    id: String,
    holder: Holder,
}

impl Hold {
    fn take(id: &str, holder: Holder) -> Result<Self, EngineError> {
        let mut holds = HOLDS.lock().unwrap_or_else(|error| error.into_inner());
        if let Some((other, by)) = holds.iter().find(|(other, by)| other == id || (holder == Holder::Merge && *by == Holder::Merge)) {
            let message = match (*by, other == id) {
                (Holder::Merge, true) => format!("Run {id} is being merged already: its checks are running."),
                (Holder::Merge, false) => format!("Run {other} is being merged. One run is merged at a time."),
                (Holder::SendBack, _) => format!("A piece of run {other} is being sent back to its worker."),
                (Holder::Cleanup, _) => format!("The worktrees of run {other} are being cleaned up."),
            };
            let recovery = match by {
                Holder::Merge => "Read how far it is with `terminalx runs show --json`, and call `terminalx runs merge` again once `mergeUnderWay` is false.",
                Holder::SendBack | Holder::Cleanup => "It ends by itself in a moment: try again then.",
            };
            let mut error = EngineError::new("merge_in_progress", message, Some(recovery));
            let holder = match by {
                Holder::Merge => "merge",
                Holder::SendBack => "sendBack",
                Holder::Cleanup => "cleanup",
            };
            error.details = json!({"run": other, "holder": holder});
            return Err(error);
        }
        holds.push((id.to_string(), holder));
        Ok(Self { id: id.to_string(), holder })
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        let mut holds = HOLDS.lock().unwrap_or_else(|error| error.into_inner());
        if let Some(at) = holds.iter().position(|(id, holder)| *id == self.id && *holder == self.holder) {
            holds.remove(at);
        }
    }
}

/// Hold the run from merging while a piece of it is sent back: refused while a pass merges it.
pub fn hold_for_send_back(id: &str) -> Result<Hold, EngineError> {
    Hold::take(id, Holder::SendBack)
}

/// Whether a pass is merging this run now.
pub fn under_way(id: &str) -> bool {
    HOLDS.lock().unwrap_or_else(|error| error.into_inner()).iter().any(|(other, holder)| other == id && *holder == Holder::Merge)
}

/// What a pass is asked.
#[derive(Debug, Clone)]
pub struct Options {
    /// Pieces to leave out of this pass, so the ones after them can go on.
    pub skip: Vec<String>,
    /// Run the integration check again for a piece it failed for, though
    /// neither its commit nor the lead's branch has changed since.
    pub recheck: bool,
    /// Who asked: the CLI, or a person in the Run view.
    pub by: By,
    /// The command ran in the lead's own conversation: that turn is the one
    /// that asked, and is not waited for. Any other caller waits for the
    /// lead's turn to end, as for every conversation in the checkout.
    pub from_lead: bool,
    /// How long one command may run.
    pub timeout: Duration,
    /// Told once the pass holds the checkout and is about to merge: a caller
    /// that shows progress (the Run view) stops waiting here and follows the
    /// run's own events from then on.
    pub begun: Option<std::sync::mpsc::Sender<Result<(), EngineError>>>,
}

impl Options {
    pub fn new(by: By) -> Self {
        Self { skip: Vec::new(), recheck: false, by, from_lead: false, timeout: verify::COMMAND_TIMEOUT, begun: None }
    }
}

/// A piece that is in the lead's branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedCommit {
    pub piece: String,
    /// The commit the piece was accepted as.
    pub commit: String,
    /// The merge commit; absent for a piece with nothing to merge, and for one the lead merged itself.
    pub merge_commit: Option<String>,
    /// `before..after`: the commits this piece brought in.
    pub range: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub nothing_to_merge: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub by_hand: bool,
}

/// A piece that is not in the lead's branch, and what it waits for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Held {
    pub piece: String,
    /// The pieces it depends on that are not merged.
    pub on: Vec<String>,
    pub why: String,
}

/// What a pass did, and where the merge stands.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Merged {
    pub run: Run,
    /// The lead's branch.
    pub into: String,
    /// The commit it is at now.
    pub head: String,
    pub integration_check: Option<String>,
    /// Every piece that is in the lead's branch, in the order merged.
    pub merged: Vec<MergedCommit>,
    pub conflicts: Vec<String>,
    pub integration_failed: Vec<String>,
    pub skipped: Vec<String>,
    /// Pieces git could not merge for a reason that is not a conflict.
    pub failed: Vec<String>,
    pub waiting: Vec<Held>,
    /// The piece this pass stopped at.
    pub stopped_at: Option<String>,
    /// Every piece is merged and the checks passed on the merged result.
    pub done: bool,
    /// Always false: a merge pushes nothing. Said so a caller need not infer it.
    pub pushed: bool,
    /// What to do now, in a sentence or two.
    pub next: String,
}

fn stored(id: &str) -> Result<Run, EngineError> {
    store::get(id).map_err(|_| EngineError::not_found(id))
}

fn git(cwd: &Path, args: &[&str]) -> anyhow::Result<String> {
    crate::git::run(cwd, args).map(|out| out.trim().to_string())
}

fn head(cwd: &Path) -> anyhow::Result<String> {
    git(cwd, &["rev-parse", "--verify", "HEAD^{commit}"])
}

fn is_ancestor(cwd: &Path, commit: &str, of: &str) -> bool {
    matches!(crate::git::raw(cwd, &["merge-base", "--is-ancestor", commit, of]), Some((0, _)))
}

fn short(commit: &str) -> &str {
    &commit[..commit.len().min(7)]
}

fn count(items: usize, one: &str, many: &str) -> String {
    format!("{items} {}", if items == 1 { one } else { many })
}

fn clipped(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let kept: String = text.chars().take(limit).collect();
    format!("{kept}\n[… cut to fit]")
}

/// The command run after each merge, and whether it is the project's own.
fn integration_check(host: &dyn Checkouts, run: &Run) -> Option<(String, bool)> {
    let plans = run.integration_check.as_deref().map(str::trim).filter(|run| !run.is_empty()).map(|run| (run.to_string(), false));
    plans.or_else(|| host.project_check(&run.project_path).map(|run| run.trim().to_string()).filter(|run| !run.is_empty()).map(|run| (run, true)))
}

/// The commit a done piece is merged as: the one its gates ran on, or the tip
/// of its branch for a piece accepted before commits were recorded.
fn result_commit(cwd: &Path, piece: &Piece) -> Option<String> {
    let named = piece.accepted_commit().map(str::to_owned).or_else(|| git(cwd, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}^{{commit}}", piece.branch.as_deref()?)]).ok());
    named.filter(|commit| matches!(crate::git::raw(cwd, &["cat-file", "-e", &format!("{commit}^{{commit}}")]), Some((0, _))))
}

/// Tracked files with changes that are not committed, as `git status` names them.
fn tracked_changes(cwd: &Path) -> anyhow::Result<Vec<String>> {
    Ok(crate::git::run(cwd, &["status", "--porcelain", "--untracked-files=no", "--"])?.lines().filter(|line| !line.trim().is_empty()).map(str::to_owned).collect())
}

/// Why the branch the lead's checkout is on is not one a run merges into:
/// a branch others build on. Said in `details.shared` of `lead_on_shared_branch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SharedBranch {
    /// The repository's default branch: a remote's `HEAD`, or where no remote names one,
    /// `init.defaultBranch`, `main` or `master`.
    Base,
    /// It tracks a remote's default branch.
    TracksBase { upstream: String },
    /// Its upstream has commits someone else made: others push to it.
    PushedByOthers { upstream: String, commits: usize, by: String },
    /// Open pull requests are to be merged into it.
    PullRequestBase { pull_requests: Vec<u64> },
}

impl SharedBranch {
    fn said(&self, branch: &str) -> String {
        let what = match self {
            Self::Base => "the project's base branch".to_string(),
            Self::TracksBase { upstream } => format!("which tracks `{upstream}`, the project's base branch"),
            Self::PushedByOthers { upstream, commits, by } => format!("whose upstream `{upstream}` has {} by someone else ({by})", count(*commits, "commit", "commits")),
            Self::PullRequestBase { pull_requests } => format!("the base of open pull {} {}", if pull_requests.len() == 1 { "request" } else { "requests" }, pull_requests.iter().map(|number| format!("#{number}")).collect::<Vec<_>>().join(", ")),
        };
        format!("The lead is on `{branch}`, {what}; runs merge only into a branch of its own. Nothing was merged.")
    }
}

/// The default branch of each remote (its `HEAD`) or, where no remote names one, the
/// branches git and most projects start with that exist here.
fn base_branches(cwd: &Path) -> Vec<String> {
    let mut bases: Vec<String> = Vec::new();
    for target in git(cwd, &["for-each-ref", "--format=%(symref)", "refs/remotes"]).unwrap_or_default().lines() {
        if let Some((_, name)) = target.trim().strip_prefix("refs/remotes/").and_then(|rest| rest.split_once('/')) {
            if !name.is_empty() && !bases.iter().any(|known| known == name) {
                bases.push(name.to_string());
            }
        }
    }
    if bases.is_empty() {
        let configured = git(cwd, &["config", "--get", "init.defaultBranch"]).ok().filter(|name| !name.is_empty());
        for name in configured.into_iter().chain(["main".to_string(), "master".to_string()]) {
            let exists = git(cwd, &["for-each-ref", "--count=1", "--format=%(refname)", &format!("refs/heads/{name}"), &format!("refs/remotes/*/{name}")]).is_ok_and(|found| !found.is_empty());
            if exists && !bases.contains(&name) {
                bases.push(name);
            }
        }
    }
    bases
}

/// Whether `branch` is one others build on, so a run must not merge into it. Only reads:
/// the refs and config of the checkout, and the forge for open pull requests.
fn shared_branch(host: &dyn Checkouts, cwd: &Path, branch: &str) -> Option<SharedBranch> {
    let bases = base_branches(cwd);
    if bases.iter().any(|base| base == branch) {
        return Some(SharedBranch::Base);
    }
    // `origin/feature`, `refs/heads/feature` on the remote, and `refs/remotes/origin/feature`; for a local upstream the last two are `refs/heads/…`.
    let tracked = git(cwd, &["for-each-ref", "--format=%(upstream:short)%00%(upstream:remoteref)%00%(upstream)", &format!("refs/heads/{branch}")]).unwrap_or_default();
    let mut parts = tracked.split('\0').map(str::trim);
    let (short_name, remote_ref, local_ref) = (parts.next().unwrap_or_default(), parts.next().unwrap_or_default(), parts.next().unwrap_or_default());
    if !local_ref.is_empty() {
        let name = remote_ref.strip_prefix("refs/heads/").or_else(|| local_ref.strip_prefix("refs/heads/")).unwrap_or_default();
        if bases.iter().any(|base| base == name) {
            return Some(SharedBranch::TracksBase { upstream: short_name.to_string() });
        }
        // What the upstream has beyond the base branches: commits someone else made there were pushed by them.
        let me = git(cwd, &["config", "--get", "user.email"]).ok().filter(|email| !email.is_empty());
        let not: Vec<String> = git(cwd, &["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"])
            .unwrap_or_default()
            .lines()
            .filter(|reference| bases.iter().any(|base| reference.strip_prefix("refs/heads/") == Some(base.as_str()) || reference.strip_prefix("refs/remotes/").and_then(|rest| rest.split_once('/')).is_some_and(|(_, name)| name == base)))
            .map(str::to_owned)
            .collect();
        if let (Some(me), false, true) = (me, not.is_empty(), local_ref.starts_with("refs/remotes/")) {
            let mut args = vec!["log", "--max-count=500", "--format=%ae%x00%ce", local_ref, "--not"];
            args.extend(not.iter().map(String::as_str));
            let others: Vec<String> = git(cwd, &args)
                .unwrap_or_default()
                .lines()
                .filter_map(|line| line.split('\0').find(|email| !email.trim().is_empty() && !email.trim().eq_ignore_ascii_case(&me)).map(|email| email.trim().to_string()))
                .collect();
            if let Some(by) = others.first() {
                return Some(SharedBranch::PushedByOthers { upstream: short_name.to_string(), commits: others.len(), by: by.clone() });
            }
        }
    }
    host.open_prs_into(cwd, branch).filter(|prs| !prs.is_empty()).map(|pull_requests| SharedBranch::PullRequestBase { pull_requests })
}

/// The lead's checkout as a merge needs it: on a branch of its own, nothing
/// part way, nothing uncommitted in tracked files (an undone merge would take
/// it along). Everything here only reads; nothing has asked git to change
/// anything yet.
fn preflight(host: &dyn Checkouts, cwd: &Path, run: &Run) -> Result<String, EngineError> {
    let Some(branch) = crate::git::current_branch(cwd) else {
        return Err(EngineError::new("lead_detached", "The lead's checkout is on no branch, so there is no branch to merge the pieces into.", Some("Check out the lead's branch in the lead's checkout, then run `terminalx runs merge` again.")));
    };
    if let Some(shared) = shared_branch(host, cwd, &branch) {
        let mut error = EngineError::new("lead_on_shared_branch", shared.said(&branch), Some("Create a branch of the lead's own in the lead's checkout (`git switch -c <name>`), then run `terminalx runs merge` again."));
        error.details = json!({"branch": branch, "shared": shared});
        return Err(error);
    }
    if let Some(into) = run.merge.as_ref().map(|merge| merge.into.as_str()).filter(|into| !into.is_empty() && *into != branch) {
        let mut error = EngineError::new("lead_branch_changed", format!("This run's pieces are being merged into `{into}`, and the lead's checkout is now on `{branch}`."), Some("Check out the branch the merge began on, then run `terminalx runs merge` again."));
        error.details = json!({"into": into, "branch": branch});
        return Err(error);
    }
    match crate::git::operation_in_progress(cwd) {
        Ok(None) => {}
        Ok(Some(operation)) => return Err(EngineError::new("lead_checkout_unfinished", format!("A {operation} was left part way in the lead's checkout. Nothing was merged."), Some("Finish or abort it, then run `terminalx runs merge` again."))),
        Err(error) => return Err(EngineError::internal(error.context("read the state of the lead's checkout"))),
    }
    let dirty = tracked_changes(cwd).map_err(EngineError::internal)?;
    if !dirty.is_empty() {
        let shown: Vec<&str> = dirty.iter().take(20).map(String::as_str).collect();
        let mut error = EngineError::new("lead_checkout_dirty", format!("The lead's checkout has changes that are not committed:\n{}\nNothing was merged: a merge that fails its check is undone, and that would take them with it.", shown.join("\n")), Some("Commit them or put them aside, then run `terminalx runs merge` again."));
        error.details = json!({"files": dirty});
        return Err(error);
    }
    Ok(branch)
}

/// A merge an earlier pass made and never finished checking (the app
/// stopped): taken back, so this pass makes and checks it again. Only the
/// exact merge that was recorded is undone; a branch that is anywhere else
/// is left alone.
fn recover(host: &dyn Checkouts, id: &str, cwd: &Path, run: &Run) -> Result<(), EngineError> {
    let Some(pending) = run.merge.as_ref().and_then(|merge| merge.pending.clone()) else { return Ok(()) };
    let now = head(cwd).map_err(EngineError::internal)?;
    if pending.after.as_deref() == Some(now.as_str()) && git(cwd, &["rev-parse", "--verify", "--quiet", "HEAD^1"]).ok().as_deref() == Some(pending.before.as_str()) {
        undo(cwd, &pending.before).map_err(|error| EngineError::new("lead_checkout_dirty", format!("An earlier merge was cut short before its check ended, and it cannot be taken back while files it changed have uncommitted changes: {error:#}. Nothing was merged."), Some("Commit them or put them aside, then run `terminalx runs merge` again.")))?;
    }
    let (after, ()) = store::update(id, |run| {
        if let Some(merge) = run.merge.as_mut() {
            merge.pending = None;
        }
        Ok(())
    })
    .map_err(EngineError::internal)?;
    host.changed(&after);
    Ok(())
}

/// Take back the merge at the tip of the lead's branch. Never at the cost of
/// work that is not committed: `git reset --keep` moves the branch and the
/// files the merge changed, keeps uncommitted changes in every other file,
/// and refuses, changing nothing, when one of the merge's files has changes
/// of its own (an edit made while the check ran, or the check's own).
fn undo(cwd: &Path, before: &str) -> anyhow::Result<()> {
    git(cwd, &["reset", "--keep", before]).map(|_| ())
}

/// What the probe found.
enum Probe {
    Clean,
    Conflict(Vec<ConflictFile>),
    Unreadable(String),
}

/// The first conflicting place of a merged file, as git marks it, and how many there are.
fn conflict_places(text: &str) -> (u32, Option<(u32, String)>) {
    let lines: Vec<&str> = text.lines().collect();
    let starts: Vec<usize> = lines.iter().enumerate().filter(|(_, line)| line.starts_with("<<<<<<< ")).map(|(at, _)| at).collect();
    let first = starts.first().map(|&from| {
        let to = lines[from..].iter().position(|line| line.starts_with(">>>>>>> ")).map_or(lines.len() - 1, |offset| from + offset);
        let place: Vec<&str> = lines[from..=to].to_vec();
        let shown = if place.len() > EXCERPT_LINES { [&place[..EXCERPT_LINES - 1], &["[… cut to fit]", place[place.len() - 1]]].concat() } else { place };
        (from as u32 + 1, clipped(&shown.join("\n"), EXCERPT_CHARS))
    });
    (starts.len() as u32, first)
}

/// Compute the merge of `commit` into the lead's branch without touching the
/// branch, the index or a file, and say where it conflicts.
fn probe(cwd: &Path, run: &Run, piece: &Piece, into: &str, before: &str, commit: &str) -> Probe {
    // Named by branch where that names the same commit: git writes the names into the conflict marks.
    let tip = |branch: &str| git(cwd, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}^{{commit}}")]).ok();
    let ours = if tip(into).as_deref() == Some(before) { into } else { before };
    let theirs = piece.branch.as_deref().filter(|branch| tip(branch).as_deref() == Some(commit)).unwrap_or(commit);
    let (code, out) = match crate::git::raw(cwd, &["merge-tree", "--write-tree", "--name-only", "-z", "--no-messages", ours, theirs]) {
        Some(found) => found,
        None => return Probe::Unreadable("`git merge-tree` could not be run in the lead's checkout.".into()),
    };
    let mut parts = out.split('\0');
    let tree = parts.next().unwrap_or_default().trim().to_string();
    match code {
        0 => Probe::Clean,
        1 => {
            let paths: Vec<String> = parts.filter(|path| !path.is_empty()).map(str::to_owned).collect();
            // The pieces already merged, and what each brought into the branch.
            let merged: Vec<(&str, Vec<String>)> = run
                .pieces
                .iter()
                .filter_map(|other| {
                    let merge = other.merge.as_ref().filter(|merge| merge.state == MergeState::Merged && other.id != piece.id)?;
                    let listed = git(cwd, &["diff", "--name-only", "-z", &merge.before, merge.after.as_deref()?, "--"]).ok()?;
                    Some((other.id.as_str(), listed.split('\0').filter(|path| !path.is_empty()).map(str::to_owned).collect()))
                })
                .collect();
            let files = paths
                .iter()
                .enumerate()
                .map(|(at, path)| {
                    let text = if at < EXCERPT_FILES { crate::git::blob_at(cwd, &tree, path).ok().flatten() } else { None };
                    let (hunks, first) = text.as_deref().map(conflict_places).unwrap_or_default();
                    ConflictFile {
                        path: path.clone(),
                        hunks,
                        line: first.as_ref().map(|(line, _)| *line),
                        excerpt: first.map(|(_, excerpt)| excerpt),
                        with: merged.iter().filter(|(_, changed)| changed.contains(path)).map(|(id, _)| id.to_string()).collect(),
                        owner: run.pieces.iter().find(|other| other.id != piece.id && plan::owns(&other.owns, path)).map(|other| other.id.clone()),
                    }
                })
                .collect();
            Probe::Conflict(files)
        }
        _ => Probe::Unreadable(format!("`git merge-tree` could not compare `{into}` with the piece's commit {}.", short(commit))),
    }
}

/// Merge `commit` into the lead's branch as one merge commit. On any failure
/// the branch is put back where it was, and the error says what git said.
fn make(cwd: &Path, run: &Run, piece: &Piece, commit: &str, before: &str) -> Result<String, String> {
    let message = format!("Merge piece {}: {}\n\nOrchestration run {}. Accepted as {commit}.", piece.id, piece.title, run.id);
    let merged = crate::git::run(cwd, &["merge", "--no-ff", "--no-edit", "-m", &message, commit]);
    let now = head(cwd).unwrap_or_default();
    match merged {
        Ok(_) if now != before && git(cwd, &["rev-parse", "--verify", "--quiet", "HEAD^1"]).ok().as_deref() == Some(before) => Ok(now),
        Ok(_) => Err(format!("`git merge` reported success, but the branch is at {} and not at a merge of {} and {}.", short(&now), short(before), short(commit))),
        Err(error) => {
            // Whatever it left part way is taken back; the branch itself has not moved.
            if matches!(crate::git::operation_in_progress(cwd), Ok(Some(_))) {
                let _ = crate::git::run(cwd, &["merge", "--abort"]);
            }
            let left = if head(cwd).ok().as_deref() == Some(before) { "The lead's branch is where it was." } else { "The lead's branch is not where it was: look at it before anything else." };
            Err(format!("`git merge` could not merge it, though it conflicts nowhere: {error:#}. {left}"))
        }
    }
}

fn record(host: &dyn Checkouts, id: &str, piece_id: &str, merge: PieceMerge, also: impl FnOnce(&mut RunMerge)) -> Result<Run, EngineError> {
    let (run, ()) = store::update(id, |run| {
        if let Some(piece) = run.pieces.iter_mut().find(|piece| piece.id == piece_id) {
            piece.merge = Some(merge);
        }
        also(run.merge.get_or_insert_with(RunMerge::default));
        Ok(())
    })
    .map_err(EngineError::internal)?;
    host.changed(&run);
    Ok(run)
}

fn outcome(state: MergeState, commit: &str, before: &str) -> PieceMerge {
    PieceMerge { state, commit: commit.to_string(), before: before.to_string(), after: None, by_hand: false, files: Vec::new(), check: None, note: None, at: crate::store::index::now() }
}

/// Merge every accepted piece of a run into the lead's branch, in dependency
/// order, checking after each. Called again, it goes on from where the
/// branch is: what is merged stays merged, and what conflicted or failed is
/// tried again.
pub fn merge(host: &dyn Checkouts, id: &str, options: &Options) -> Result<Merged, EngineError> {
    let _pass = Hold::take(id, Holder::Merge)?;
    let run = stored(id)?;
    match run.state {
        RunState::Planned | RunState::AwaitingApproval => {
            return Err(EngineError::new("run_not_started", format!("Run {id} has not started: there is no result to merge."), Some("Start it with `terminalx runs start`; a piece is merged once its result is accepted.")));
        }
        RunState::Stopped => return Err(EngineError::new("run_ended", format!("Run {id} was stopped. Nothing more is merged in it."), Some("Merge the branches you want by hand, or create a new run for what is left."))),
        _ => {}
    }
    // What the lead commits for a piece it took over is that piece's result (`engine::finish`): no other
    // piece's merge lands in its branch meanwhile, to be counted as its work.
    if let Some(taken) = run.pieces.iter().find(|piece| piece.state == PieceState::Lead) {
        let mut error = EngineError::new("piece_with_lead", format!("Piece {} is with the lead: nothing is merged into its branch until it is finished or skipped, so its work is not mixed with other pieces'.", taken.id), Some("Finish it with `terminalx runs finish`, or have it skipped, then merge."));
        error.details = json!({"piece": taken.id});
        return Err(error);
    }
    if let Some(unknown) = options.skip.iter().find(|skip| run.piece(skip).is_none()) {
        let mut error = EngineError::new("piece_not_found", format!("Run {id} has no piece {unknown}."), Some("Use a piece id from `terminalx runs show --json`."));
        error.details = json!({"pieces": run.pieces.iter().map(|piece| piece.id.clone()).collect::<Vec<_>>()});
        return Err(error);
    }
    let cwd = host.lead_checkout(&run).map_err(|error| EngineError::new("lead_not_found", format!("The lead's checkout cannot be found: {error:#}"), None))?;
    // A run that is done is not merged again: said as it stands.
    if run.state == RunState::Done {
        return Ok(summary(run, &cwd, None, None));
    }
    let check = integration_check(host, &run);
    let commands = check.is_some() || run.pieces.iter().any(|piece| piece.done_checks.iter().any(|check| matches!(check, Check::Command { .. })));
    // The same rule as for a worker's result (`verify::may_run_commands`): TerminalX runs a plan's
    // commands unasked when a person approved the plan, or where the caller runs commands unasked itself.
    if options.by == By::Cli && commands && !verify::may_run_commands(run.approval.is_some(), host.lead_mode(&run).as_deref().unwrap_or_default()) {
        return Err(EngineError::new(
            "checks_not_approved",
            "Merging runs the plan's commands in the lead's checkout, and nobody approved this plan: TerminalX does not run them unasked for a lead that is itself asked before it runs a command.",
            Some("Ask the person to press Merge in the session's Run view. Nothing was merged."),
        ));
    }
    let _reserved = host.reserve(&run, &cwd, options.from_lead).map_err(|why| EngineError::new("checkout_busy", format!("The lead's checkout is in use: {why} Nothing was merged."), Some("Run `terminalx runs merge` again once it is free.")))?;
    let into = preflight(host, &cwd, &run)?;
    recover(host, id, &cwd, &run)?;
    let (begun, ()) = store::update(id, |run| {
        let merge = run.merge.get_or_insert_with(RunMerge::default);
        merge.into = into.clone();
        merge.stopped_at = None;
        Ok(())
    })
    .map_err(EngineError::internal)?;
    host.changed(&begun);
    if let Some(told) = &options.begun {
        let _ = told.send(Ok(()));
    }

    let order: Vec<String> = run.merge_order().into_iter().map(|piece| piece.id.clone()).collect();
    let mut stopped_at: Option<String> = None;
    for piece_id in &order {
        let run = stored(id)?;
        // Stopped meanwhile: what is merged stays, and nothing more is. A run paused on its
        // budget goes on: merging asks no model, and the person merging is the one it waits for.
        if !run.state.followed() {
            break;
        }
        let Some(piece) = run.piece(piece_id).filter(|piece| piece.state == PieceState::Done) else { continue };
        let before = head(&cwd).map_err(EngineError::internal)?;
        let Some(commit) = result_commit(&cwd, piece) else {
            let mut failed = outcome(MergeState::Failed, piece.accepted_commit().unwrap_or_default(), &before);
            failed.note = Some("The commit its result was accepted as is not in this repository, and its branch is gone: there is nothing to merge it from.".into());
            record(host, id, piece_id, failed, |_| {})?;
            stopped_at = Some(piece_id.clone());
            break;
        };
        let known = piece.current_merge().filter(|merge| merge.commit == commit);
        // In the branch already: merged by an earlier pass, by the lead itself, or with nothing to bring.
        if is_ancestor(&cwd, &commit, &before) {
            match known {
                Some(merge) if merge.is_in() => continue,
                Some(merge) if merge.state == MergeState::IntegrationFailed && merge.before == before && !options.recheck => continue,
                _ => {}
            }
            let changed = piece.tries.last().and_then(|attempt| attempt.verification.as_ref()).and_then(|check| check.facts.as_ref()).is_none_or(|facts| !facts.files.is_empty());
            if !changed {
                record(host, id, piece_id, outcome(MergeState::NothingToMerge, &commit, &before), |_| {})?;
                continue;
            }
            // The lead merged it itself. It is checked as any merge is, but it is not TerminalX's to undo.
            let checked = run.merge.as_ref().and_then(|merge| merge.checked_head.as_deref()) == Some(before.as_str());
            let ran = check.as_ref().filter(|_| !checked).map(|(command, project)| verify::run_command(&cwd, command, *project, options.timeout));
            let passed = ran.as_ref().is_none_or(|ran| ran.passed);
            let mut merged = outcome(if passed { MergeState::Merged } else { MergeState::IntegrationFailed }, &commit, &before);
            (merged.by_hand, merged.check) = (true, ran);
            if !passed {
                merged.note = Some("The lead merged this piece itself, so nothing was undone: the failing result is in the lead's branch.".into());
            }
            record(host, id, piece_id, merged, |merge| {
                if passed && check.is_some() {
                    merge.checked_head = Some(before.clone());
                }
            })?;
            continue;
        }
        if options.skip.contains(piece_id) {
            let mut skipped = outcome(MergeState::Skipped, &commit, &before);
            skipped.note = Some("Left out of this merge on request.".into());
            record(host, id, piece_id, skipped, |_| {})?;
            continue;
        }
        // After everything it depends on: a piece built on another is not merged without it.
        if piece.depends_on.iter().any(|on| !run.piece(on).is_some_and(Piece::merge_settled)) {
            continue;
        }
        // The same commit failed the same check on the same branch: nothing has changed that could change the answer.
        if known.is_some_and(|merge| merge.state == MergeState::IntegrationFailed && merge.before == before) && !options.recheck {
            continue;
        }
        // What a check left in tracked files would be lost with an undone merge.
        let dirty = tracked_changes(&cwd).map_err(EngineError::internal)?;
        if !dirty.is_empty() {
            let mut failed = outcome(MergeState::Failed, &commit, &before);
            failed.note = Some(format!("The lead's checkout has changes that are not committed, left by the check that ran before this merge or made meanwhile: {}. Commit or discard them, then merge again.", dirty.iter().take(8).cloned().collect::<Vec<_>>().join(", ")));
            record(host, id, piece_id, failed, |_| {})?;
            stopped_at = Some(piece_id.clone());
            break;
        }
        match probe(&cwd, &run, piece, &into, &before, &commit) {
            Probe::Clean => {}
            Probe::Conflict(files) => {
                let mut conflict = outcome(MergeState::Conflict, &commit, &before);
                conflict.files = files;
                record(host, id, piece_id, conflict, |_| {})?;
                stopped_at = Some(piece_id.clone());
                break;
            }
            Probe::Unreadable(why) => {
                let mut failed = outcome(MergeState::Failed, &commit, &before);
                failed.note = Some(why);
                record(host, id, piece_id, failed, |_| {})?;
                stopped_at = Some(piece_id.clone());
                break;
            }
        }
        // Stored before the branch moves: a merge whose check never ends is found again by this.
        let pending = PendingMerge { piece: piece_id.clone(), before: before.clone(), after: None };
        store::update(id, |run| {
            run.merge.get_or_insert_with(RunMerge::default).pending = Some(pending.clone());
            Ok(())
        })
        .map_err(EngineError::internal)?;
        let after = match make(&cwd, &run, piece, &commit, &before) {
            Ok(after) => after,
            Err(why) => {
                let mut failed = outcome(MergeState::Failed, &commit, &before);
                failed.note = Some(why);
                record(host, id, piece_id, failed, |merge| merge.pending = None)?;
                stopped_at = Some(piece_id.clone());
                break;
            }
        };
        let (shown, ()) = store::update(id, |run| {
            if let Some(pending) = run.merge.as_mut().and_then(|merge| merge.pending.as_mut()) {
                pending.after = Some(after.clone());
            }
            Ok(())
        })
        .map_err(EngineError::internal)?;
        host.changed(&shown);
        let ran = check.as_ref().map(|(command, project)| verify::run_command(&cwd, command, *project, options.timeout));
        let now = head(&cwd).unwrap_or_default();
        if now != after {
            // A check that commits or moves the branch: what is there now is not the merge that was made.
            let mut failed = outcome(MergeState::Failed, &commit, &before);
            failed.check = ran;
            failed.note = Some(format!("The lead's branch moved while the integration check ran: the merge was {} and the branch is now at {}. It was left as it is; a check must not commit.", short(&after), if now.is_empty() { "no commit" } else { short(&now) }));
            record(host, id, piece_id, failed, |merge| merge.pending = None)?;
            stopped_at = Some(piece_id.clone());
            break;
        }
        if ran.as_ref().is_some_and(|ran| !ran.passed) {
            // That merge alone is taken back: the branch is where it was before this piece.
            if let Err(error) = undo(&cwd, &before) {
                let mut failed = outcome(MergeState::Failed, &commit, &before);
                failed.check = ran;
                failed.note = Some(format!("The integration check failed, and the merge was not undone: files it changed have uncommitted changes now, which undoing it would discard ({error:#}). The lead's branch is at {}, with the merge in it. Commit or discard those changes, then merge again.", short(&after)));
                record(host, id, piece_id, failed, |merge| merge.pending = None)?;
                stopped_at = Some(piece_id.clone());
                break;
            }
            let mut failed = outcome(MergeState::IntegrationFailed, &commit, &before);
            failed.check = ran;
            record(host, id, piece_id, failed, |merge| merge.pending = None)?;
            continue;
        }
        let mut merged = outcome(MergeState::Merged, &commit, &before);
        (merged.after, merged.check) = (Some(after.clone()), ran);
        record(host, id, piece_id, merged, |merge| {
            merge.pending = None;
            if check.is_some() {
                merge.checked_head = Some(after.clone());
            }
        })?;
    }
    let (after, ()) = store::update(id, |run| {
        let merge = run.merge.get_or_insert_with(RunMerge::default);
        merge.stopped_at = stopped_at.clone();
        merge.at = Some(crate::store::index::now());
        Ok(())
    })
    .map_err(EngineError::internal)?;
    host.changed(&after);
    let after = if stopped_at.is_none() && after.state.followed() && after.pieces.iter().all(Piece::merge_settled) { finish(host, id, &cwd, check.as_ref(), options)? } else { after };
    Ok(summary(after, &cwd, check.map(|(command, _)| command), stopped_at))
}

/// Every piece is in: the checks on the whole. The integration check, when
/// the branch is not at a commit it passed on, then each piece's command
/// done-checks once more, each command once. The run is done when they pass.
/// One that fails undoes nothing: no single merge is known to be at fault.
fn finish(host: &dyn Checkouts, id: &str, cwd: &Path, check: Option<&(String, bool)>, options: &Options) -> Result<Run, EngineError> {
    let run = stored(id)?;
    let at = head(cwd).map_err(EngineError::internal)?;
    let checked = run.merge.as_ref().and_then(|merge| merge.checked_head.as_deref()) == Some(at.as_str());
    let whole = check.filter(|_| !checked).map(|(command, project)| verify::run_command(cwd, command, *project, options.timeout));
    let mut ran: Vec<FinalCheck> = Vec::new();
    if whole.as_ref().is_none_or(|whole| whole.passed) {
        // The integration check has just passed on this commit: a done-check that is the same command is not run twice.
        let mut seen: Vec<&str> = check.iter().map(|(command, _)| command.as_str()).collect();
        // A piece a person skipped is not in the branch: its checks say nothing of it.
        'pieces: for piece in run.merge_order().into_iter().filter(|piece| piece.state != PieceState::Skipped) {
            for command in piece.done_checks.iter().filter_map(|check| match check { Check::Command { run } => Some(run.as_str()), _ => None }) {
                if seen.contains(&command.trim()) {
                    continue;
                }
                seen.push(command.trim());
                let result = verify::run_command(cwd, command, false, options.timeout);
                let failed = !result.passed;
                ran.push(FinalCheck { piece: piece.id.clone(), command: result });
                if failed {
                    break 'pieces;
                }
            }
        }
    }
    let moved = head(cwd).ok().as_deref() != Some(at.as_str());
    let (after, ()) = store::update(id, |run| {
        let every = run.state.followed() && run.pieces.iter().all(Piece::merge_settled);
        let merge = run.merge.get_or_insert_with(RunMerge::default);
        merge.check = whole.clone().filter(|whole| !whole.passed);
        if whole.as_ref().is_some_and(|whole| whole.passed) && !moved {
            merge.checked_head = Some(at.clone());
        }
        merge.final_checks = ran.clone();
        merge.final_head = Some(at.clone());
        let failed = merge.final_checks.iter().find(|check| !check.command.passed);
        let reason = if let Some(whole) = merge.check.as_ref() {
            Some(format!("Every piece is in `{}`, but the integration check `{}` {} on the merged result at {}. Nothing was undone: no one merge is known to be at fault.", merge.into, whole.run, how(whole), short(&at)))
        } else if let Some(failed) = failed {
            Some(format!("Every piece is merged into `{}`, but the done-check `{}` of piece {} {} on the merged result at {}. Nothing was undone: no one merge is known to be at fault.", merge.into, failed.command.run, failed.piece, how(&failed.command), short(&at)))
        } else if moved {
            Some(format!("The lead's branch moved while the checks ran on {}: they say nothing of where it is now.", short(&at)))
        } else {
            None
        };
        if !every {
            return Ok(());
        }
        match reason {
            None => (run.state, run.reason, run.pause) = (RunState::Done, None, None),
            Some(reason) => run.reason = Some(reason),
        }
        Ok(())
    })
    .map_err(EngineError::internal)?;
    host.changed(&after);
    Ok(after)
}

/// How a command that did not pass ended.
fn how(ran: &CommandRun) -> String {
    match ran.exit_code {
        Some(code) => format!("exited {code}"),
        None if ran.millis == 0 => "was not run".to_string(),
        None => "did not finish".to_string(),
    }
}

/// Where the merge of a run stands, as `runs merge` answers.
fn summary(run: Run, cwd: &Path, check: Option<String>, stopped_at: Option<String>) -> Merged {
    let into = run.merge.as_ref().map(|merge| merge.into.clone()).filter(|into| !into.is_empty()).or_else(|| crate::git::current_branch(cwd)).unwrap_or_default();
    let at = head(cwd).unwrap_or_default();
    let with = |state: MergeState| -> Vec<String> { run.merge_order().into_iter().filter(|piece| piece.current_merge().is_some_and(|merge| merge.state == state)).map(|piece| piece.id.clone()).collect() };
    let merged: Vec<MergedCommit> = run
        .merge_order()
        .into_iter()
        .filter(|piece| piece.merged())
        .filter_map(|piece| {
            let merge = piece.current_merge()?;
            Some(MergedCommit {
                piece: piece.id.clone(),
                commit: merge.commit.clone(),
                merge_commit: merge.after.clone(),
                range: merge.after.as_ref().map(|after| format!("{}..{after}", merge.before)),
                nothing_to_merge: merge.state == MergeState::NothingToMerge,
                by_hand: merge.by_hand,
            })
        })
        .collect();
    let (conflicts, integration_failed, skipped, failed) = (with(MergeState::Conflict), with(MergeState::IntegrationFailed), with(MergeState::Skipped), with(MergeState::Failed));
    let waiting: Vec<Held> = run
        .merge_order()
        .into_iter()
        .filter(|piece| piece.current_merge().is_none() && piece.state != PieceState::Skipped)
        .map(|piece| {
            let on: Vec<String> = piece.depends_on.iter().filter(|on| !run.piece(on).is_some_and(Piece::merge_settled)).cloned().collect();
            let why = if piece.state != PieceState::Done {
                format!("Its result is not accepted yet: it is {}.", serde_json::to_value(piece.state).ok().and_then(|state| state.as_str().map(str::to_owned)).unwrap_or_default())
            } else if !on.is_empty() {
                format!("It depends on {}, which {} not merged.", on.join(", "), if on.len() == 1 { "is" } else { "are" })
            } else {
                match &stopped_at {
                    Some(stopped) => format!("The merge stopped at {stopped} before it was reached."),
                    None => "It has not been tried yet.".to_string(),
                }
            };
            Held { piece: piece.id.clone(), on, why }
        })
        .collect();
    let done = run.state == RunState::Done;
    let id = &run.id;
    let next = if done {
        format!("Every piece is merged into `{into}` and the checks passed on the merged result. Nothing was pushed and no other branch was touched: open the pull request from `{into}` the usual way. `terminalx runs cleanup {id} --yes` removes the workers' worktrees.")
    } else if let Some(piece) = stopped_at.as_deref().filter(|piece| conflicts.iter().any(|conflict| conflict == piece)) {
        let files = run.piece(piece).and_then(|piece| piece.merge.as_ref()).map_or(0, |merge| merge.files.len());
        let commit = run.piece(piece).and_then(|piece| piece.merge.as_ref()).map(|merge| merge.commit.clone()).unwrap_or_default();
        format!(
            "The merge stopped at piece {piece}: it conflicts in {}. `{into}` is at {}, as it was before that merge was tried. Choose one: `terminalx runs send-back {piece}` gives the conflict to its worker, which rebases onto `{into}` and reports again; or resolve it yourself (`git merge {}` in your checkout, resolve, commit); or leave it out with `terminalx runs merge --skip {piece}`. Then run `terminalx runs merge` again.",
            count(files, "file", "files"),
            short(&at),
            short(&commit)
        )
    } else if let Some(piece) = stopped_at.as_deref() {
        format!("The merge stopped at piece {piece}: {} Run `terminalx runs merge` again once that is dealt with.", run.piece(piece).and_then(|piece| piece.merge.as_ref()).and_then(|merge| merge.note.clone()).unwrap_or_default())
    } else if let Some(piece) = integration_failed.first() {
        format!("The integration check failed after piece {piece} was merged, so that merge was undone; `{into}` is at {}. `terminalx runs send-back {piece}` gives what the check printed to its worker. Pieces that depend on it wait for it.", short(&at))
    } else if let Some(reason) = run.reason.as_deref().filter(|_| run.pieces.iter().all(Piece::merge_settled)) {
        format!("{reason} Fix it on `{into}`, commit, and run `terminalx runs merge` again: the checks are run on the new commit.")
    } else if !skipped.is_empty() {
        format!("Left out on request: {}. Run `terminalx runs merge` without --skip to try {} again.", skipped.join(", "), if skipped.len() == 1 { "it" } else { "them" })
    } else if waiting.iter().any(|held| run.piece(&held.piece).is_some_and(|piece| piece.state != PieceState::Done)) {
        "The accepted pieces are merged. The rest are merged once their results are accepted: run `terminalx runs merge` again then.".to_string()
    } else {
        "Run `terminalx runs merge` again to go on.".to_string()
    };
    Merged { into, head: at, integration_check: check.or_else(|| run.integration_check.clone()), merged, conflicts, integration_failed, skipped, failed, waiting, stopped_at, done, pushed: false, next, run }
}

/// One line a conflicting file: where, how much, and who else changed it.
fn file_line(run: &Run, file: &ConflictFile) -> String {
    let places = match file.hunks {
        0 => "not in its lines: one side deleted, renamed or replaced it".to_string(),
        hunks => count(hunks as usize, "place", "places"),
    };
    let title = |id: &String| run.piece(id).map_or(id.clone(), |piece| format!("{id} ({})", piece.title));
    let with = if file.with.is_empty() { String::new() } else { format!("; also changed by {}, already merged", file.with.iter().map(title).collect::<Vec<_>>().join(" and ")) };
    let owner = file.owner.as_ref().map(|owner| format!("; the plan gives this file to {}", title(owner))).unwrap_or_default();
    format!("- {} ({places}{with}{owner})", file.path)
}

/// What a piece's worker is told when its accepted result could not be
/// merged: the conflict, or what the integration check printed. `None` for a
/// piece whose merge did not fail.
pub fn brief(run: &Run, piece: &Piece) -> Option<String> {
    let merge = piece.current_merge()?;
    let into = run.merge.as_ref().map(|merge| merge.into.as_str()).filter(|into| !into.is_empty()).unwrap_or("the lead's branch");
    let rebase = format!("Bring your branch up to date with it: run `git rebase {into}` in your worktree");
    let said = match merge.state {
        MergeState::Conflict => {
            let files: Vec<String> = merge.files.iter().map(|file| file_line(run, file)).collect();
            let places: Vec<String> = merge.files.iter().filter_map(|file| Some(format!("{}, from line {}:\n{}", file.path, file.line?, file.excerpt.as_deref()?))).collect();
            format!(
                "Your result for piece {} was accepted, but it no longer merges into `{into}`: other pieces were merged there first, and yours conflicts with them. Nothing of yours was merged, and `{into}` is as it was.\n\nConflicting files:\n{}\n\n{}\n\n{rebase}, resolve the conflicts so that both pieces' changes hold, run your done-checks, commit, and report again. Keep to the files you own; if the conflict cannot be resolved within them, report `partial` and say which file needs the lead.",
                piece.id,
                files.join("\n"),
                places.join("\n\n")
            )
        }
        MergeState::IntegrationFailed => {
            let check = merge.check.as_ref()?;
            // Merged by the lead itself: nothing was undone, and the failing result is in its branch.
            let what = if merge.by_hand { format!("was accepted and the lead merged it into `{into}` itself, but the run's integration check then failed on the merged result. That merge was not undone: your commits are in `{into}`, and the fix goes on top of them.") } else { format!("was accepted and merged into `{into}` without conflicts, but the run's integration check then failed on the merged result, so the merge was undone.") };
            format!(
                "Your result for piece {} {what}\n\n`{}` {}. The last lines it printed:\n{}\n\n{rebase}, make that command pass there together with your own done-checks, commit, and report again.",
                piece.id,
                check.run,
                how(check),
                check.output.as_deref().unwrap_or_default()
            )
        }
        MergeState::Failed => format!("Your result for piece {} was accepted, but git could not merge it into `{into}`: {}\n\n{rebase}, commit, and report again.", piece.id, merge.note.as_deref().unwrap_or_default()),
        _ => return None,
    };
    Some(clipped(&said, BRIEF_LIMIT))
}

/// What the lead is sent to resolve a conflict itself: the goals of the
/// pieces involved and both sides of each conflicting place, cut to
/// [`RESOLVE_LIMIT`]. No transcript and nothing of any worker's reasoning.
pub fn resolve_prompt(run: &Run, piece: &Piece) -> Option<String> {
    let merge = piece.current_merge().filter(|merge| merge.state == MergeState::Conflict)?;
    let into = run.merge.as_ref().map(|merge| merge.into.as_str()).filter(|into| !into.is_empty()).unwrap_or("your branch");
    let mut involved: Vec<&Piece> = vec![piece];
    for id in merge.files.iter().flat_map(|file| file.with.iter().chain(file.owner.iter())) {
        if let Some(other) = run.piece(id).filter(|other| !involved.iter().any(|known| known.id == other.id)) {
            involved.push(other);
        }
    }
    let goals: Vec<String> = involved.iter().map(|piece| format!("- {} ({}): {}", piece.id, piece.title, clipped(piece.brief.goal.trim(), 600))).collect();
    let files: Vec<String> = merge.files.iter().map(|file| file_line(run, file)).collect();
    let places: Vec<String> = merge.files.iter().filter_map(|file| Some(format!("{}, from line {}:\n{}", file.path, file.line?, file.excerpt.as_deref()?))).collect();
    let said = format!(
        "The person asks you to resolve a merge conflict of run {} yourself. Piece {} was accepted, and merging it into `{into}` conflicts. `{into}` has not been touched.\n\nWhat each piece involved is for:\n{}\n\nConflicting files:\n{}\n\nBoth sides of the first conflicting place of each file (`{into}` first, the piece second):\n{}\n\nIn your checkout run `git merge {}`, resolve each conflict so that every piece's goal above still holds, and commit the merge. Then run `terminalx runs merge {} --json`: it finds the piece in your branch, runs the integration check on it, and goes on with the pieces after it. Do not push.",
        run.id,
        piece.id,
        goals.join("\n"),
        files.join("\n"),
        places.join("\n\n"),
        merge.commit,
        run.id
    );
    Some(clipped(&said, RESOLVE_LIMIT))
}

/// A worker's worktree and what `runs cleanup` makes of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fate {
    pub piece: String,
    /// Which try of the piece it belongs to, from 1.
    #[serde(rename = "try")]
    pub attempt: usize,
    pub session: String,
    pub worktree: String,
    pub branch: Option<String>,
    /// Why it stays; absent for one that goes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cleanup {
    pub run: Run,
    /// The worktrees removed, each with its session. Their branches stay.
    pub removed: Vec<Fate>,
    /// The worktrees left as they are, each with why.
    pub refused: Vec<Fate>,
}

/// Why a worker's worktree is not removed, or `None` when it may go: nothing
/// in it is uncommitted, and every commit of it is in the lead's branch.
fn keeps(worktree: &Worktree, lead_head: &str, into: &str) -> Option<String> {
    if worktree.busy {
        return Some("An agent is running in it.".into());
    }
    match crate::git::operation_in_progress(&worktree.path) {
        Ok(None) => {}
        Ok(Some(operation)) => return Some(format!("A {operation} was left part way in it.")),
        Err(error) => return Some(format!("Its state could not be read: {error:#}")),
    }
    let status = match crate::git::run(&worktree.path, &["status", "--porcelain", "--untracked-files=normal", "--"]) {
        Ok(status) => status,
        Err(error) => return Some(format!("Its state could not be read: {error:#}")),
    };
    let dirty: Vec<&str> = status.lines().filter(|line| !line.trim().is_empty()).collect();
    if !dirty.is_empty() {
        let named: Vec<&str> = dirty.iter().take(5).map(|line| line.get(3..).unwrap_or(line)).collect();
        return Some(format!("It has uncommitted work in {}: {}{}.", count(dirty.len(), "file", "files"), named.join(", "), if dirty.len() > named.len() { ", …" } else { "" }));
    }
    let at = match head(&worktree.path) {
        Ok(at) => at,
        Err(error) => return Some(format!("Its commit could not be read: {error:#}")),
    };
    if !is_ancestor(&worktree.path, &at, lead_head) {
        let ahead = git(&worktree.path, &["rev-list", "--count", &format!("{lead_head}..{at}")]).ok().and_then(|ahead| ahead.parse::<usize>().ok()).unwrap_or(0);
        return Some(format!("It has {} that {} not in `{into}`.", count(ahead.max(1), "commit", "commits"), if ahead > 1 { "are" } else { "is" }));
    }
    None
}

/// Remove the worktrees of a run's workers, each with its session. One with
/// uncommitted work, or with commits that are not in the lead's branch, is
/// refused and named with the reason; so is one whose piece is still being
/// worked on. Branches are kept. Without `yes` nothing is removed: the
/// refusal lists what would go and what would stay.
pub fn cleanup(host: &dyn Checkouts, id: &str, yes: bool) -> Result<Cleanup, EngineError> {
    // Held to the end: no pass may begin, make a merge this counts as in the lead's branch, and
    // then undo it once the worktree is gone.
    let _no_merge = Hold::take(id, Holder::Cleanup).map_err(|error| EngineError::new("merge_in_progress", format!("{} Worktrees are cleaned up once that has ended.", error.message), None))?;
    let run = stored(id)?;
    let cwd = host.lead_checkout(&run).map_err(|error| EngineError::new("lead_not_found", format!("The lead's checkout cannot be found, so nothing says what is merged: {error:#}"), None))?;
    let lead_head = head(&cwd).map_err(EngineError::internal)?;
    let into = crate::git::current_branch(&cwd).unwrap_or_else(|| short(&lead_head).to_string());
    let (mut going, mut refused): (Vec<(Fate, SessionRef, Worktree)>, Vec<Fate>) = (Vec::new(), Vec::new());
    let mut seen: Vec<&str> = Vec::new();
    for piece in &run.pieces {
        for (index, attempt) in piece.tries.iter().enumerate() {
            let Some(worker) = attempt.worker.as_ref().filter(|worker| !seen.contains(&worker.session_id.as_str())) else { continue };
            seen.push(&worker.session_id);
            // Gone already, or never in a worktree of its own: nothing to remove.
            let Some(worktree) = host.worktree(worker) else { continue };
            let current = index + 1 == piece.tries.len();
            let at_work = attempt.outcome.is_none() || (current && matches!(piece.state, PieceState::Running | PieceState::Verifying));
            let reason = if at_work { Some("Its piece is still being worked on or checked.".to_string()) } else { keeps(&worktree, &lead_head, &into) };
            let fate = Fate { piece: piece.id.clone(), attempt: index + 1, session: worker.session_id.clone(), worktree: worktree.path.to_string_lossy().into_owned(), branch: attempt.branch.clone(), reason };
            match fate.reason {
                Some(_) => refused.push(fate),
                None => going.push((fate, worker.clone(), worktree)),
            }
        }
    }
    if !yes {
        let list = |fates: &[&Fate]| fates.iter().map(|fate| format!("- {} (piece {}{})", fate.worktree, fate.piece, fate.reason.as_ref().map(|reason| format!(": {reason}")).unwrap_or_default())).collect::<Vec<_>>().join("\n");
        let would: Vec<&Fate> = going.iter().map(|(fate, _, _)| fate).collect();
        let stay: Vec<&Fate> = refused.iter().collect();
        let mut said = format!("Cleaning up a run's worktrees requires --yes. Nothing was removed.\nWould remove {}, each with its session; branches are kept:\n{}", count(would.len(), "worktree", "worktrees"), if would.is_empty() { "- none".to_string() } else { list(&would) });
        if !stay.is_empty() {
            said.push_str(&format!("\nWould leave {}:\n{}", count(stay.len(), "worktree", "worktrees"), list(&stay)));
        }
        let mut error = EngineError::new("confirmation_required", said, Some("Check what is listed, then repeat with --yes."));
        error.details = json!({"wouldRemove": would, "wouldRefuse": stay});
        return Err(error);
    }
    let mut removed = Vec::new();
    for (mut fate, worker, worktree) in going {
        // Looked at again behind the stop: what an agent wrote in its last moment is not removed unseen.
        let still_safe = || match keeps(&Worktree { busy: false, ..worktree.clone() }, &lead_head, &into) {
            Some(reason) => Err(reason),
            None => Ok(()),
        };
        match host.remove(&run, &worker, &worktree, &still_safe) {
            Ok(()) => removed.push(fate),
            Err(error) => {
                fate.reason = Some(format!("It could not be removed: {error:#}"));
                refused.push(fate);
            }
        }
    }
    Ok(Cleanup { run: stored(id)?, removed, refused })
}
