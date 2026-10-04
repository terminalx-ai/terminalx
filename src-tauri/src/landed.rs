//! Whether a workspace's work has landed: the one question asked before a
//! workspace is deleted, wherever the delete was started.
//!
//! A workspace is safe to delete with a single confirmation when it is
//!
//! - **clean**: nothing uncommitted or untracked (ignored files do not
//!   count) and no stash entry made on its branch, and
//! - **merged**: everything on its branch is in the project's default
//!   branch, as the remote has it right now.
//!
//! "Merged" cannot be read off the commit graph alone, because the project
//! merges by squash: the branch's commits never become ancestors of the
//! default branch. So three things count, tried in order:
//!
//! 1. the branch tip is an ancestor of the default branch (a merge commit, a
//!    fast-forward, or a branch with nothing on it);
//! 2. every commit on the branch has a patch-equivalent commit on the
//!    default branch (a rebase merge);
//! 3. the branch's whole change, as one patch, has a patch-equivalent commit
//!    on the default branch (a squash merge), or the branch has no net
//!    change at all.
//!
//! "Patch-equivalent" means the same change byte for byte. `git cherry`
//! finds the candidates but compares patches with whitespace ignored, and a
//! change of indentation alone can change what a Python or YAML file means.
//! So every match is confirmed with `git patch-id --verbatim` before it
//! counts.
//!
//! Even an exact patch match is not enough: a patch id does not record where
//! in the file a hunk applies. With two identical blocks in one file, a
//! change to the first upstream and the same change to the second on the
//! branch have the same id. So after a match the branch is test-merged into
//! the base (`git merge-tree`, nothing is written to any checkout): if that
//! merge is clean and would change the base, the branch holds something the
//! base does not, and it is not merged.
//!
//! A merged pull request is not used as proof on its own: commits can be
//! added to a branch after its pull request merged, and those would be lost.
//!
//! When the check cannot be made (no remote, the fetch fails, the default
//! branch cannot be told, the directory is not a working tree of this
//! project) the answer is "not verified", never "merged": the caller asks
//! for the second confirmation. The same holds when nothing was fetched:
//! only a check made against the remote as it is now can say "safe".
//!
//! What the check does not see:
//!
//! - **The branch, when HEAD is not on it.** The check is about HEAD and the
//!   working tree. A removal must therefore delete only the branch HEAD is
//!   on (as `workspaces::delete` does, reading it from the checkout), never
//!   a branch chosen by the worktree's name: with a detached HEAD that
//!   branch can hold commits this check never looked at.
//! - **Files hidden from `git status`.** A file marked `skip-worktree` or
//!   `assume-unchanged` can be modified without showing. When any file has
//!   either flag the result is "not verified".
//! - **Submodules.** Git can be told to leave them out of every comparison
//!   (`submodule.<name>.ignore = all`, `diff.ignoreSubmodules`), and commits
//!   made inside one may exist nowhere else. So a checkout whose index holds
//!   any submodule is "not verified", and the question "does the branch
//!   change anything" is answered by comparing trees, which no setting can
//!   blind.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;

use crate::git;

/// How long a fetch of the default branch may take before the check gives up
/// and reports "not verified".
const FETCH_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MergedBy {
    /// The branch tip is in the default branch's history.
    Ancestor,
    /// Each commit was applied to the default branch (rebase merge).
    Rebase,
    /// The branch's whole change was applied as one commit (squash merge).
    Squash,
    /// The branch changes nothing relative to where it started.
    NoChanges,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fetch {
    /// Fetch the remote default branch first, so the answer is about now.
    Fresh,
    /// The caller fetched the remote default branch a moment ago (one fetch
    /// for many workspaces of the same project).
    #[cfg_attr(not(test), allow(dead_code))]
    JustFetched,
    /// Use what is already known locally: the quick state shown for every
    /// workspace in a list, which must not wait on the network. Such a check
    /// never says "safe".
    Skip,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Landed {
    /// The directory is a working tree of this project, so it could be read.
    pub checked: bool,
    pub branch: Option<String>,
    /// The commit HEAD is at.
    pub head: Option<String>,
    /// What the branch was compared with, e.g. `origin/main`.
    pub base: Option<String>,
    pub uncommitted: u32,
    /// Stash entries made on this branch. The stash is shared by every
    /// worktree, and deleting the branch orphans what was stashed on it.
    pub stashes: u32,
    pub clean: bool,
    pub merged: Option<MergedBy>,
    /// Commits on the branch with no equivalent in the default branch.
    pub unmerged_commits: u32,
    /// The branch tip is on some remote (pushed, though perhaps not merged).
    pub pushed: bool,
    /// The default branch was fetched for this check, so "merged" is about
    /// the remote as it is now.
    pub fresh: bool,
    /// Why "merged" could not be established for certain; `None` when it was.
    pub not_verified: Option<String>,
    /// Clean, merged and verified: one confirmation is enough.
    pub safe: bool,
    /// What deleting would lose, in plain words; empty when it is safe.
    pub losses: Vec<String>,
    /// Stands for exactly what this check found. A second confirmation is
    /// given for one digest: if anything the person was shown has changed
    /// by the time of the removal, the digest differs and they are asked
    /// again.
    pub digest: String,
    /// Which files are uncommitted, not only how many: two different sets of
    /// the same size must not share a digest.
    #[serde(skip)]
    changes: u64,
}

/// A workspace's state in one word, for a list.
#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum State {
    /// Nothing uncommitted and nothing of its own to merge.
    Clean,
    /// Uncommitted or untracked files, or a stash made on its branch.
    Uncommitted,
    /// Committed work that is not in the default branch.
    Unmerged,
    /// Its commits are in the default branch (by squash or rebase).
    Merged,
    /// It could not be read.
    #[default]
    Unknown,
}

impl Landed {
    fn describe_digest(&self) -> String {
        format!(
            "checked={} head={} branch={} uncommitted={}:{:016x} stashes={} merged={:?} unmerged={} fresh={} unverified={}",
            self.checked,
            self.head.as_deref().unwrap_or("-"),
            self.branch.as_deref().unwrap_or("-"),
            self.uncommitted,
            self.changes,
            self.stashes,
            self.merged,
            self.unmerged_commits,
            self.fresh,
            self.not_verified.as_deref().unwrap_or("-"),
        )
    }

    /// The one-word state. Uncommitted work comes first: it is what is lost
    /// soonest. This is the local view (no fetch), so "unmerged" can lag a
    /// merge that happened on the remote; the removal dialog fetches.
    /// The list itself uses [`state_in_list`], which must agree with this.
    #[cfg(test)]
    pub fn state(&self) -> State {
        if !self.checked {
            State::Unknown
        } else if !self.clean {
            State::Uncommitted
        } else {
            match self.merged {
                None => State::Unmerged,
                Some(MergedBy::Squash | MergedBy::Rebase) => State::Merged,
                Some(MergedBy::Ancestor | MergedBy::NoChanges) => State::Clean,
            }
        }
    }

    fn describe_losses(&self) -> Vec<String> {
        let plural = |n: u32, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
        let mut out = Vec::new();
        if !self.checked {
            out.push("This folder is not on disk, or is not a working git checkout of this project, so it cannot be checked for uncommitted or unmerged work.".to_string());
            return out;
        }
        if self.uncommitted > 0 {
            out.push(format!("{} would be lost.", plural(self.uncommitted, "uncommitted file", "uncommitted files")));
        }
        if self.stashes > 0 {
            out.push(format!("{} made on this branch would be left without it.", plural(self.stashes, "stash entry", "stash entries")));
        }
        let base = self.base.as_deref().unwrap_or("the default branch");
        if self.merged.is_none() && self.unmerged_commits > 0 {
            let where_else = if self.pushed { "The branch is pushed, but not merged." } else { "The branch is not pushed anywhere." };
            out.push(format!("{} not in {base}. {where_else}", plural(self.unmerged_commits, "commit is", "commits are")));
        }
        if let Some(reason) = &self.not_verified {
            out.push(format!("Not verified: {reason}"));
        } else if !self.fresh {
            out.push("Not verified: the default branch was not fetched for this check.".to_string());
        }
        out
    }
}

fn count(cwd: &Path, args: &[&str]) -> Option<u32> {
    git::run(cwd, args).ok()?.trim().parse().ok()
}

/// Stash entries whose message says they were made on `branch`. Git writes
/// `WIP on <branch>: …` or `On <branch>: …` for every stash, and
/// `(no branch)` in place of the name for one made on a detached HEAD. Those
/// cannot be told apart by checkout, so a workspace with a detached HEAD
/// counts every one of them: over-warning is the safe side. `None` when the
/// stash list cannot be read, which is not the same as "no stashes".
fn stashes_on(cwd: &Path, branch: Option<&str>) -> Option<u32> {
    Some(stashes_in(&stash_list(cwd)?, branch))
}

fn stashes_in(stash_subjects: &str, branch: Option<&str>) -> u32 {
    let branch = branch.unwrap_or("(no branch)");
    let (wip, on) = (format!("WIP on {branch}:"), format!("On {branch}:"));
    stash_subjects.lines().filter(|line| line.starts_with(&wip) || line.starts_with(&on)).count() as u32
}

#[cfg(test)]
thread_local! {
    /// Lets a test stand in for a `git stash list` that fails, which a
    /// healthy repository will not do on request.
    static STASH_LIST_FAILS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn stash_list(cwd: &Path) -> Option<String> {
    #[cfg(test)]
    if STASH_LIST_FAILS.with(|fails| fails.get()) {
        return None;
    }
    git::run(cwd, &["stash", "list", "--format=%gs"]).ok()
}

/// Files in the checkout that `git status` has been told not to look at:
/// `skip-worktree` (`S`) and `assume-unchanged` (a lower-case letter) in
/// `git ls-files -v`. A change to one is invisible and would be deleted with
/// the worktree. `None` when the list cannot be read.
fn hidden_from_status(cwd: &Path) -> Option<u32> {
    let out = git::run(cwd, &["ls-files", "-v"]).ok()?;
    Some(out.lines().filter(|line| line.starts_with('S') || line.chars().next().is_some_and(|flag| flag.is_ascii_lowercase())).count() as u32)
}

/// After a patch match: would merging HEAD into `base` leave `base` as it
/// is? `Some(false)` when the merge is clean and changes the base, so the
/// branch holds something the base does not.
///
/// A merge that conflicts cannot say by itself. The patch match is then left
/// standing only when every hunk of the branch's change has a single place
/// it could apply. With more than one (two identical blocks), the match may
/// be for a change the base made somewhere else, and the answer is `None`:
/// not verified. `None` too when git cannot do the test merge at all.
fn base_already_holds_head(cwd: &Path, base: &str, merge_base: &str) -> Option<bool> {
    let base_tree = git::run(cwd, &["rev-parse", &format!("{base}^{{tree}}")]).ok()?.trim().to_string();
    match git::run(cwd, &["merge-tree", "--write-tree", base, "HEAD"]) {
        Ok(out) => Some(out.lines().next().map(str::trim) == Some(base_tree.as_str())),
        // Exit 1 with nothing on stderr is "there are conflicts".
        Err(error) if format!("{error:#}").contains(": exit ") => (!applies_in_more_than_one_place(cwd, merge_base)?).then_some(true),
        Err(_) => None,
    }
}

/// Whether any hunk of the change `merge_base..HEAD` could apply at more
/// than one place in the file it changes: its lines before the change (the
/// context and what it removes) occur more than once in the old file. A
/// patch id is the same wherever such a hunk lands. `None` when the diff
/// cannot be read.
fn applies_in_more_than_one_place(cwd: &Path, merge_base: &str) -> Option<bool> {
    let diff = git::run(cwd, &["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none", merge_base, "HEAD", "--"]).ok()?;
    let mut old_file: Option<Vec<String>> = None;
    let mut hunk: Vec<String> = Vec::new();
    let mut in_hunk = false;
    let mut ambiguous = false;
    let mut close = |hunk: &mut Vec<String>, old_file: &Option<Vec<String>>| {
        if let Some(old) = old_file {
            if !hunk.is_empty() && old.windows(hunk.len()).filter(|window| *window == hunk.as_slice()).count() > 1 {
                ambiguous = true;
            }
        }
        hunk.clear();
    };
    for line in diff.lines() {
        if let Some(path) = line.strip_prefix("--- ") {
            close(&mut hunk, &old_file);
            in_hunk = false;
            // `--- a/<path>`, or `/dev/null` for a file the branch adds.
            old_file = match path.strip_prefix("a/") {
                Some(path) => Some(git::run(cwd, &["show", &format!("{merge_base}:{path}")]).ok()?.lines().map(String::from).collect()),
                None => None,
            };
        } else if line.starts_with("@@") {
            close(&mut hunk, &old_file);
            in_hunk = true;
        } else if line.starts_with("diff --git") {
            close(&mut hunk, &old_file);
            in_hunk = false;
            old_file = None;
        } else if in_hunk {
            if let Some(text) = line.strip_prefix(' ').or_else(|| line.strip_prefix('-')) {
                hunk.push(text.to_string());
            }
        }
    }
    close(&mut hunk, &old_file);
    Some(ambiguous)
}

/// Submodules recorded in the checkout's index (`160000` entries in
/// `git ls-files -s`). `None` when the index cannot be read.
fn submodules_in(cwd: &Path) -> Option<u32> {
    let out = git::run(cwd, &["ls-files", "-s"]).ok()?;
    Some(out.lines().filter(|line| line.starts_with("160000 ")).count() as u32)
}

/// The exact patch ids (whitespace included) of the non-merge commits in
/// `range`, or of the one commit `range` names with `-1`.
fn verbatim_patch_ids(cwd: &Path, log_args: &[&str]) -> Option<std::collections::HashSet<String>> {
    let mut first = vec!["log", "-p", "--no-merges", "--no-color", "--no-ext-diff", "--no-textconv"];
    first.extend_from_slice(log_args);
    let out = git::pipe(cwd, &first, &["patch-id", "--verbatim"]).ok()?;
    Some(out.lines().filter_map(|line| line.split_whitespace().next().map(String::from)).collect())
}

/// How the work at HEAD got into `base`, if it did, and how many commits
/// did not.
fn merged_into(cwd: &Path, base: &str) -> Option<(Option<MergedBy>, u32)> {
    if count(cwd, &["rev-list", "--count", &format!("{base}..HEAD")])? == 0 {
        return Some((Some(MergedBy::Ancestor), 0));
    }
    // `git cherry` marks each commit `-` when the base has a patch-equivalent
    // one. It skips merge commits entirely, and a merge commit can carry
    // changes of its own (a conflict resolution, or edits made while
    // merging). So with any merge commit on the branch, "every commit has an
    // equivalent" proves nothing, and only the whole-change comparison
    // below can say the work is in the base.
    let cherry = git::run(cwd, &["cherry", base, "HEAD"]).ok()?;
    let merges = count(cwd, &["rev-list", "--count", "--merges", &format!("{base}..HEAD")])?;
    let unmerged = cherry.lines().filter(|line| line.starts_with('+')).count() as u32;
    let merge_base = git::run(cwd, &["merge-base", base, "HEAD"]).ok()?.trim().to_string();
    // What the base gained since the branch left it, as exact patches. Only
    // worked out when `git cherry` found a candidate to confirm.
    let upstream = std::cell::OnceCell::new();
    let upstream = || upstream.get_or_init(|| if merge_base.is_empty() { None } else { verbatim_patch_ids(cwd, &[&format!("{merge_base}..{base}")]) }).clone();
    if unmerged == 0 && merges == 0 {
        // Every commit has a look-alike upstream; each must be the same
        // change exactly, not the same but for whitespace.
        let ours = verbatim_patch_ids(cwd, &[&format!("{base}..HEAD")])?;
        let theirs = upstream()?;
        if ours.iter().all(|id| theirs.contains(id)) && base_already_holds_head(cwd, base, &merge_base)? {
            return Some((Some(MergedBy::Rebase), 0));
        }
    }
    // Nothing was told apart commit by commit: count them all as unmerged
    // unless the whole-change comparison below says otherwise.
    let ahead = count(cwd, &["rev-list", "--count", "--no-merges", &format!("{base}..HEAD")])?;
    let unmerged = if unmerged == 0 && merges == 0 { ahead } else { unmerged };
    // What is reported when the whole-change comparison also fails: the
    // commits with no equivalent, or the merge commits that hid the change.
    let unmerged = unmerged.max(merges);
    if merge_base.is_empty() {
        return Some((None, unmerged));
    }
    // Trees, not `git diff --quiet`: a diff honours `submodule.<name>.ignore`
    // and `diff.ignoreSubmodules`, and would call a branch that moves a
    // submodule to another commit "no changes".
    let tree = |rev: &str| git::run(cwd, &["rev-parse", "--verify", "--quiet", &format!("{rev}^{{tree}}")]).ok().map(|tree| tree.trim().to_string());
    if tree(&merge_base)? == tree("HEAD")? {
        return Some((Some(MergedBy::NoChanges), 0));
    }
    // The whole branch as one commit on top of where it started; nothing
    // refers to it, so it is an unreachable object git collects later. The
    // dates are fixed so the same branch always gives the same object: the
    // check runs for every workspace in a list and must not add an object
    // each time.
    let epoch = "1970-01-01T00:00:00Z";
    let squashed = git::run_env(
        cwd,
        &["-c", "user.name=TerminalX", "-c", "user.email=noreply@terminalx.invalid", "commit-tree", "HEAD^{tree}", "-p", &merge_base, "-m", "squash check"],
        &[("GIT_AUTHOR_DATE", epoch), ("GIT_COMMITTER_DATE", epoch)],
    )
    .ok()?;
    let as_one = git::run(cwd, &["cherry", base, squashed.trim()]).ok()?;
    if as_one.lines().next().is_some_and(|line| line.starts_with('-')) {
        // The same change exactly: a commit added after the squash that only
        // re-indents a line still matches when whitespace is ignored.
        let whole = verbatim_patch_ids(cwd, &["-1", squashed.trim()])?;
        let theirs = upstream()?;
        if !whole.is_empty() && whole.iter().all(|id| theirs.contains(id)) && base_already_holds_head(cwd, base, &merge_base)? {
            return Some((Some(MergedBy::Squash), 0));
        }
    }
    Some((None, unmerged))
}

/// The project's default branch, when it can be told for certain: what the
/// remote says its HEAD is, or a local `main` or `master`. Unlike
/// [`git::default_branch`] this never falls back to whatever is checked out:
/// on a project whose default is `develop` and whose `origin/HEAD` is not
/// set, that would compare a branch with the wrong one and call it verified.
fn known_default_branch(project: &Path) -> Option<String> {
    if let Ok(head) = git::run(project, &["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"]) {
        let head = head.trim();
        if !head.is_empty() {
            return Some(head.strip_prefix("origin/").unwrap_or(head).to_string());
        }
    }
    ["main", "master"].into_iter().find(|name| git::run(project, &["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")]).is_ok()).map(String::from)
}

/// What every workspace of one project shares when their states are worked
/// out for a list: read once, not once per workspace.
pub struct ListContext {
    base: Option<String>,
    base_commit: Option<String>,
    /// The subjects of the project's stash entries (the stash is shared by
    /// all its worktrees); `None` when they cannot be read.
    stash_subjects: Option<String>,
}

pub fn list_context(project: &Path) -> ListContext {
    let (base, _, _) = base_for(project, Fetch::Skip);
    let base_commit = base.as_deref().and_then(|base| git::run(project, &["rev-parse", "--verify", "--quiet", &format!("{base}^{{commit}}")]).ok()).map(|sha| sha.trim().to_string());
    ListContext { base, base_commit, stash_subjects: stash_list(project) }
}

/// How a commit stands against a base commit never changes, so it is worked
/// out once per pair. A list is redrawn on every change to any workspace,
/// and this is the costly part of each row.
fn merged_cache() -> &'static MergedCache {
    static CACHE: std::sync::OnceLock<MergedCache> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// `(HEAD, base commit)` to how HEAD's work got into the base, if it did.
type MergedCache = std::sync::Mutex<std::collections::HashMap<(String, String), Option<MergedBy>>>;

/// A workspace's one-word state for a list: the same answer as
/// [`check`]`(.., Fetch::Skip).state()`, from what the list already read
/// (`head`, `uncommitted`) plus one cached comparison. It skips what a word
/// does not need: whether the branch is pushed, and the files hidden from
/// `git status`. Nothing is removed on the strength of it.
pub fn state_in_list(context: &ListContext, path: &Path, branch: Option<&str>, head: Option<&str>, uncommitted: u32) -> State {
    // Without its own `.git` the directory is not a checkout any more, and
    // git would answer for whatever repository encloses it.
    if std::fs::symlink_metadata(path.join(".git")).is_err() {
        return State::Unknown;
    }
    let Some(stash_subjects) = &context.stash_subjects else { return State::Unknown };
    if uncommitted > 0 || stashes_in(stash_subjects, branch) > 0 {
        return State::Uncommitted;
    }
    let (Some(base), Some(base_commit), Some(head)) = (&context.base, &context.base_commit, head) else { return State::Unmerged };
    let key = (head.to_string(), base_commit.clone());
    let cached = merged_cache().lock().unwrap().get(&key).copied();
    let merged = match cached {
        Some(merged) => merged,
        None => {
            let Some((merged, _)) = merged_into(path, base) else { return State::Unknown };
            let mut cache = merged_cache().lock().unwrap();
            if cache.len() > 4096 {
                cache.clear();
            }
            cache.insert(key, merged);
            merged
        }
    };
    match merged {
        None => State::Unmerged,
        Some(MergedBy::Squash | MergedBy::Rebase) => State::Merged,
        Some(MergedBy::Ancestor | MergedBy::NoChanges) => State::Clean,
    }
}

/// What a project's branches are compared with: `(base, not_verified,
/// fresh)`. `not_verified` says why the comparison is not certain, when it
/// is not; `fresh` is whether the remote default branch was fetched for it.
pub(crate) fn base_for(project: &Path, fetch: Fetch) -> (Option<String>, Option<String>, bool) {
    let Some(default) = known_default_branch(project) else {
        return (None, Some("The project's default branch could not be determined (origin/HEAD is not set and there is no main or master), so there is nothing certain to compare the branch with.".to_string()), false);
    };
    if git::remote_url(project).is_none() {
        return (Some(default.clone()), Some(format!("This project has no remote, so the branch is compared with the local {default} only.")), false);
    }
    let mut not_verified = None;
    let mut fresh = fetch == Fetch::JustFetched;
    if fetch == Fetch::Fresh {
        match git::run_within(project, &["fetch", "--quiet", "origin", &default], FETCH_TIMEOUT, &|| false) {
            Ok(()) => fresh = true,
            Err(error) => not_verified = Some(format!("origin/{default} could not be fetched ({}), so this is compared with the last known copy.", fetch_failure(&error))),
        }
    }
    let remote = format!("origin/{default}");
    if git::run(project, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{remote}")]).is_ok() {
        (Some(remote), not_verified, fresh)
    } else {
        (None, Some(format!("{remote} is not known here, so there is nothing to compare the branch with.")), false)
    }
}

/// Check whether the workspace at `path` is clean and merged.
pub fn check(project: &Path, path: &Path, fetch: Fetch) -> Landed {
    if !git::is_worktree_of(project, path) {
        let mut unchecked = Landed::default();
        unchecked.losses = unchecked.describe_losses();
        // Whether there is anything there at all is part of what was shown.
        unchecked.digest = format!("{} on-disk={}", unchecked.describe_digest(), std::fs::symlink_metadata(path).is_ok());
        return unchecked;
    }
    let branch = git::current_branch(path);
    let mut landed = Landed { checked: true, branch: branch.clone(), head: git::head_commit(path), ..Default::default() };

    // The fetch can take many seconds. The working tree is read after it,
    // so what is reported is the tree as it is when the answer is given.
    let (base, not_verified, fresh) = base_for(project, fetch);
    landed.not_verified = not_verified;
    landed.fresh = fresh;

    let listing = git::run(path, &["status", "--porcelain", "--untracked-files=normal", "--"]).ok();
    let status = listing.as_ref().map(|out| out.lines().count() as u32);
    let stashes = stashes_on(path, branch.as_deref());
    landed.uncommitted = status.unwrap_or(0);
    landed.changes = {
        use std::hash::{Hash, Hasher};
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        listing.as_deref().unwrap_or_default().hash(&mut hasher);
        hasher.finish()
    };
    landed.stashes = stashes.unwrap_or(0);
    landed.clean = status == Some(0) && stashes == Some(0);
    // Only the warning before a removal says whether the branch is pushed;
    // a check that does not go to the network is not that.
    landed.pushed = fetch != Fetch::Skip && git::run(path, &["branch", "-r", "--contains", "HEAD"]).is_ok_and(|out| !out.trim().is_empty());
    if let Some(base) = &base {
        match merged_into(path, base) {
            Some((merged, unmerged)) => {
                landed.merged = merged;
                landed.unmerged_commits = unmerged;
            }
            None => landed.not_verified = Some(format!("Whether the branch's work is in {base} could not be established.")),
        }
    }
    if status.is_none() {
        landed.not_verified = Some("Git could not read the working tree's status.".to_string());
    } else if stashes.is_none() {
        landed.not_verified = Some("Git could not read the stash list, so stashed work cannot be ruled out.".to_string());
    } else {
        match hidden_from_status(path) {
            Some(0) => {}
            Some(hidden) => {
                landed.not_verified = Some(format!(
                    "{hidden} file{} hidden from git status (skip-worktree or assume-unchanged), so changes to {} cannot be seen.",
                    if hidden == 1 { " is" } else { "s are" },
                    if hidden == 1 { "it" } else { "them" }
                ))
            }
            None => landed.not_verified = Some("Git could not list the files in the working tree.".to_string()),
        }
    }
    if landed.not_verified.is_none() {
        match submodules_in(path) {
            Some(0) => {}
            Some(count) => {
                landed.not_verified = Some(format!(
                    "It has {count} submodule{}, and work inside a submodule, or a change of which commit it points at, cannot be checked from here.",
                    if count == 1 { "" } else { "s" }
                ))
            }
            None => landed.not_verified = Some("Git could not read the index.".to_string()),
        }
    }
    landed.base = base;
    landed.safe = landed.clean && landed.merged.is_some() && landed.not_verified.is_none() && landed.fresh;
    landed.losses = landed.describe_losses();
    landed.digest = landed.describe_digest();
    landed
}

/// Why a fetch did not succeed, in a few words.
fn fetch_failure(error: &git::RunError) -> String {
    match error {
        git::RunError::TimedOut => format!("no answer within {} s", FETCH_TIMEOUT.as_secs()),
        git::RunError::Stopped => "it was stopped".to_string(),
        git::RunError::Failed(text) => first_line(text.trim()).to_string(),
        git::RunError::Spawn(error) => format!("git could not be started: {error}"),
    }
}

fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A project cloned from a bare remote, with a managed worktree to check.
    struct Fixture {
        _home: crate::store::TempHome,
        _dir: tempfile::TempDir,
        remote: PathBuf,
        project: PathBuf,
    }

    fn sh(cwd: &Path, args: &[&str]) -> String {
        git::run(cwd, args).unwrap_or_else(|e| panic!("git {args:?}: {e:#}"))
    }

    fn commit(cwd: &Path, file: &str, content: &str) {
        std::fs::write(cwd.join(file), content).unwrap();
        sh(cwd, &["add", "."]);
        sh(cwd, &["commit", "-q", "-m", file]);
    }

    impl Fixture {
        fn new() -> Self {
            let home = crate::store::temp_home();
            let dir = tempfile::tempdir().unwrap();
            let base = std::fs::canonicalize(dir.path()).unwrap();
            let remote = base.join("remote.git");
            std::fs::create_dir_all(&remote).unwrap();
            sh(&remote, &["init", "-q", "--bare", "-b", "main"]);
            let project = base.join("project");
            std::fs::create_dir_all(&project).unwrap();
            sh(&project, &["init", "-q", "-b", "main"]);
            sh(&project, &["config", "user.email", "t@example.com"]);
            sh(&project, &["config", "user.name", "T"]);
            std::fs::write(project.join(".gitignore"), "target/\n").unwrap();
            commit(&project, "a.txt", "one\n");
            sh(&project, &["remote", "add", "origin", remote.to_str().unwrap()]);
            sh(&project, &["push", "-q", "-u", "origin", "main"]);
            sh(&project, &["remote", "set-head", "origin", "main"]);
            Self { _home: home, _dir: dir, remote, project }
        }

        /// A worktree with two commits of its own.
        fn worktree(&self, name: &str) -> PathBuf {
            let wt = PathBuf::from(git::create_worktree(&self.project, name, Some("main")).unwrap().path);
            commit(&wt, &format!("{name}-1.txt"), "first\n");
            commit(&wt, &format!("{name}-2.txt"), "second\n");
            wt
        }

        fn branch(name: &str) -> String {
            format!("raccoon/{name}")
        }

        /// Someone else pushes to the remote's main, the way GitHub does when
        /// a pull request merges: this project has not fetched it yet.
        fn elsewhere(&self, work: impl FnOnce(&Path)) {
            let other = self._dir.path().join(format!("other-{}", uuid::Uuid::new_v4().simple()));
            sh(self._dir.path(), &["clone", "-q", self.remote.to_str().unwrap(), other.to_str().unwrap()]);
            sh(&other, &["config", "user.email", "o@example.com"]);
            sh(&other, &["config", "user.name", "O"]);
            work(&other);
            sh(&other, &["push", "-q", "origin", "main"]);
        }
    }

    #[test]
    fn a_new_worktree_with_nothing_on_it_is_safe() {
        let f = Fixture::new();
        let wt = PathBuf::from(git::create_worktree(&f.project, "quiet-amber-fox", Some("main")).unwrap().path);
        let landed = check(&f.project, &wt, Fetch::Fresh);
        assert_eq!(landed.merged, Some(MergedBy::Ancestor));
        assert!(landed.safe && landed.clean && landed.checked, "{landed:?}");
        assert_eq!(landed.base.as_deref(), Some("origin/main"));
        assert!(landed.losses.is_empty(), "{:?}", landed.losses);
    }

    #[test]
    fn unmerged_commits_are_counted_and_said_whether_pushed() {
        let f = Fixture::new();
        let wt = f.worktree("quiet-amber-fox");
        let landed = check(&f.project, &wt, Fetch::Fresh);
        assert_eq!(landed.merged, None);
        assert_eq!(landed.unmerged_commits, 2);
        assert!(!landed.pushed && !landed.safe && landed.clean);
        assert!(landed.losses.iter().any(|line| line.contains("2 commits are not in origin/main") && line.contains("not pushed anywhere")), "{:?}", landed.losses);

        // Pushed but not merged is still not merged: that is the gap the old check had.
        sh(&wt, &["push", "-q", "origin", &Fixture::branch("quiet-amber-fox")]);
        let landed = check(&f.project, &wt, Fetch::Fresh);
        assert!(landed.pushed && landed.merged.is_none() && !landed.safe);
        assert!(landed.losses.iter().any(|line| line.contains("pushed, but not merged")));
    }

    #[test]
    fn a_merge_commit_on_the_remote_is_recognised_after_the_fetch() {
        let f = Fixture::new();
        let wt = f.worktree("quiet-amber-fox");
        let branch = Fixture::branch("quiet-amber-fox");
        sh(&wt, &["push", "-q", "origin", &branch]);
        f.elsewhere(|other| {
            commit(other, "unrelated.txt", "main moved\n");
            sh(other, &["merge", "-q", "--no-ff", "-m", "merge", &format!("origin/{branch}")]);
        });
        // Without the fetch the project still has the old origin/main.
        assert_eq!(check(&f.project, &wt, Fetch::Skip).merged, None);
        let landed = check(&f.project, &wt, Fetch::Fresh);
        assert_eq!(landed.merged, Some(MergedBy::Ancestor));
        assert!(landed.safe, "{landed:?}");
    }

    #[test]
    fn a_squash_merge_is_recognised() {
        let f = Fixture::new();
        let wt = f.worktree("quiet-amber-fox");
        let branch = Fixture::branch("quiet-amber-fox");
        sh(&wt, &["push", "-q", "origin", &branch]);
        f.elsewhere(|other| {
            commit(other, "unrelated.txt", "main moved before\n");
            sh(other, &["merge", "-q", "--squash", &format!("origin/{branch}")]);
            sh(other, &["commit", "-q", "-m", "squashed (#1)"]);
            commit(other, "later.txt", "main moved after\n");
        });
        let landed = check(&f.project, &wt, Fetch::Fresh);
        assert_eq!(landed.merged, Some(MergedBy::Squash), "{landed:?}");
        assert_eq!(landed.unmerged_commits, 0);
        assert!(landed.safe);

        // A commit added after the squash is not covered by it.
        commit(&wt, "after-the-merge.txt", "new work\n");
        let landed = check(&f.project, &wt, Fetch::Fresh);
        assert_eq!(landed.merged, None, "{landed:?}");
        assert!(!landed.safe);
    }

    #[test]
    fn changes_that_live_only_in_a_merge_commit_are_not_called_merged() {
        let f = Fixture::new();
        let wt = PathBuf::from(git::create_worktree(&f.project, "quiet-amber-fox", Some("main")).unwrap().path);
        let branch = Fixture::branch("quiet-amber-fox");
        // Branch commit A.
        commit(&wt, "a-feature.txt", "A\n");
        sh(&wt, &["push", "-q", "origin", &branch]);
        // Main moves; the branch merges it, and the merge commit itself
        // carries a file nothing else has.
        f.elsewhere(|other| commit(other, "main-moved.txt", "main\n"));
        sh(&f.project, &["fetch", "-q", "origin", "main"]);
        sh(&wt, &["merge", "-q", "--no-ff", "--no-commit", "origin/main"]);
        std::fs::write(wt.join("only-in-the-merge.txt"), "unique\n").unwrap();
        sh(&wt, &["add", "."]);
        sh(&wt, &["commit", "-q", "-m", "merge main, with extra changes"]);
        // Upstream, A is rebase-merged: every non-merge commit now has an equivalent.
        let a = sh(&wt, &["rev-parse", "HEAD^1"]).trim().to_string();
        f.elsewhere(|other| {
            sh(other, &["fetch", "-q", "origin", &branch]);
            sh(other, &["cherry-pick", &a]);
        });

        let landed = check(&f.project, &wt, Fetch::Fresh);
        // `git cherry` alone would say everything is upstream...
        assert!(sh(&wt, &["cherry", "origin/main", "HEAD"]).lines().all(|line| line.starts_with('-')));
        // ...while the file made in the merge is nowhere else.
        assert!(sh(&wt, &["diff", "--name-only", "origin/main", "HEAD"]).contains("only-in-the-merge.txt"));
        assert_eq!(landed.merged, None, "{landed:?}");
        assert!(!landed.safe);
        assert!(landed.unmerged_commits >= 1);
        assert!(landed.losses.iter().any(|line| line.contains("not in origin/main")), "{:?}", landed.losses);
    }

    #[test]
    fn a_branch_that_merged_main_cleanly_and_was_then_squashed_is_still_recognised() {
        let f = Fixture::new();
        let wt = f.worktree("quiet-amber-fox");
        let branch = Fixture::branch("quiet-amber-fox");
        f.elsewhere(|other| commit(other, "main-moved.txt", "main\n"));
        sh(&f.project, &["fetch", "-q", "origin", "main"]);
        sh(&wt, &["merge", "-q", "--no-ff", "-m", "merge main", "origin/main"]);
        sh(&wt, &["push", "-q", "origin", &branch]);
        f.elsewhere(|other| {
            sh(other, &["merge", "-q", "--squash", &format!("origin/{branch}")]);
            sh(other, &["commit", "-q", "-m", "squashed"]);
        });
        let landed = check(&f.project, &wt, Fetch::Fresh);
        assert_eq!(landed.merged, Some(MergedBy::Squash), "{landed:?}");
        assert!(landed.safe);
    }

    #[test]
    fn a_default_branch_that_cannot_be_told_is_not_verified() {
        let f = Fixture::new();
        // The project's default is `develop`; origin/HEAD is not set and
        // there is no local main or master.
        sh(&f.project, &["remote", "set-head", "origin", "--delete"]);
        sh(&f.project, &["checkout", "-q", "-b", "develop"]);
        sh(&f.project, &["push", "-q", "-u", "origin", "develop"]);
        sh(&f.project, &["branch", "-q", "-D", "main"]);
        let wt = PathBuf::from(git::create_worktree(&f.project, "quiet-amber-fox", Some("develop")).unwrap().path);
        let landed = check(&f.project, &wt, Fetch::Fresh);
        assert!(landed.not_verified.as_deref().is_some_and(|reason| reason.contains("default branch could not be determined")), "{landed:?}");
        assert_eq!(landed.base, None);
        assert!(!landed.safe);

        // Once the remote's HEAD is known, the same workspace verifies.
        sh(&f.project, &["remote", "set-head", "origin", "develop"]);
        let landed = check(&f.project, &wt, Fetch::Fresh);
        assert_eq!(landed.base.as_deref(), Some("origin/develop"));
        assert!(landed.safe, "{landed:?}");
    }

    #[test]
    fn a_check_without_a_fetch_never_says_safe() {
        let f = Fixture::new();
        let wt = PathBuf::from(git::create_worktree(&f.project, "quiet-amber-fox", Some("main")).unwrap().path);
        let local = check(&f.project, &wt, Fetch::Skip);
        assert!(local.clean && local.merged.is_some() && !local.fresh);
        assert!(!local.safe);
        assert!(local.losses.iter().any(|line| line.contains("was not fetched")), "{:?}", local.losses);
        assert!(check(&f.project, &wt, Fetch::Fresh).safe);
        assert!(check(&f.project, &wt, Fetch::JustFetched).safe);
    }

    #[test]
    fn a_stash_made_on_a_detached_head_counts_for_a_detached_workspace() {
        let f = Fixture::new();
        let wt = PathBuf::from(git::create_worktree(&f.project, "quiet-amber-fox", Some("main")).unwrap().path);
        sh(&wt, &["checkout", "-q", "--detach"]);
        std::fs::write(wt.join("a.txt"), "changed\n").unwrap();
        sh(&wt, &["stash", "push", "-q"]);
        let landed = check(&f.project, &wt, Fetch::Fresh);
        assert_eq!(landed.stashes, 1);
        assert!(!landed.clean && !landed.safe);
        // A workspace on a branch does not take the blame for it.
        let other = PathBuf::from(git::create_worktree(&f.project, "calm-teal-bee", Some("main")).unwrap().path);
        assert_eq!(check(&f.project, &other, Fetch::Fresh).stashes, 0);
    }

    /// Squash-merge the branch on the remote, as GitHub does.
    fn squash_upstream(f: &Fixture, branch: &str) {
        f.elsewhere(|other| {
            sh(other, &["merge", "-q", "--squash", &format!("origin/{branch}")]);
            sh(other, &["commit", "-q", "-m", "squashed (#1)"]);
        });
    }

    #[test]
    fn a_later_commit_that_only_reindents_a_line_is_not_covered_by_the_squash() {
        let f = Fixture::new();
        let wt = PathBuf::from(git::create_worktree(&f.project, "quiet-amber-fox", Some("main")).unwrap().path);
        let branch = Fixture::branch("quiet-amber-fox");
        commit(&wt, "job.py", "def run():\n    if ready:\n        start()\n    cleanup()\n");
        sh(&wt, &["push", "-q", "origin", &branch]);
        squash_upstream(&f, &branch);
        // (A one-commit branch squashed is the same patch as that commit.)
        assert!(check(&f.project, &wt, Fetch::Fresh).safe);

        // Unpushed: `cleanup()` moves inside the `if`. Only indentation
        // changed, and the program now does something else.
        commit(&wt, "job.py", "def run():\n    if ready:\n        start()\n        cleanup()\n");
        assert!(!sh(&wt, &["diff", "origin/main", "HEAD"]).is_empty());
        let landed = check(&f.project, &wt, Fetch::Fresh);
        assert_eq!(landed.merged, None, "{landed:?}");
        assert!(!landed.safe && landed.unmerged_commits >= 1);
    }

    #[test]
    fn a_later_commit_that_only_changes_whitespace_inside_a_line_is_not_covered() {
        let f = Fixture::new();
        let wt = PathBuf::from(git::create_worktree(&f.project, "quiet-amber-fox", Some("main")).unwrap().path);
        let branch = Fixture::branch("quiet-amber-fox");
        commit(&wt, "config.yaml", "name: a b\nargs: [x, y]\n");
        sh(&wt, &["push", "-q", "origin", &branch]);
        squash_upstream(&f, &branch);
        // (A one-commit branch squashed is the same patch as that commit.)
        assert!(check(&f.project, &wt, Fetch::Fresh).safe);

        commit(&wt, "config.yaml", "name: a  b\nargs: [x,y]\n");
        assert!(!sh(&wt, &["diff", "origin/main", "HEAD"]).is_empty());
        let landed = check(&f.project, &wt, Fetch::Fresh);
        assert_eq!(landed.merged, None, "{landed:?}");
        assert!(!landed.safe);
    }

    #[test]
    fn a_rebase_merged_commit_later_amended_with_an_indentation_change_is_not_merged() {
        let f = Fixture::new();
        let wt = PathBuf::from(git::create_worktree(&f.project, "quiet-amber-fox", Some("main")).unwrap().path);
        let branch = Fixture::branch("quiet-amber-fox");
        commit(&wt, "job.py", "def run():\n    if ready:\n        start()\n    cleanup()\n");
        sh(&wt, &["push", "-q", "origin", &branch]);
        f.elsewhere(|other| {
            commit(other, "unrelated.txt", "main moved\n");
            sh(other, &["cherry-pick", &format!("origin/{branch}")]);
        });
        assert_eq!(check(&f.project, &wt, Fetch::Fresh).merged, Some(MergedBy::Rebase));

        // The commit is amended locally: same change but for indentation.
        std::fs::write(wt.join("job.py"), "def run():\n    if ready:\n        start()\n        cleanup()\n").unwrap();
        sh(&wt, &["commit", "-q", "-a", "--amend", "--no-edit"]);
        // `git cherry` still calls it equivalent...
        assert!(sh(&wt, &["cherry", "origin/main", "HEAD"]).lines().all(|line| line.starts_with('-')));
        // ...and it is not.
        let landed = check(&f.project, &wt, Fetch::Fresh);
        assert_eq!(landed.merged, None, "{landed:?}");
        assert!(!landed.safe);
        assert_eq!(landed.unmerged_commits, 1);
    }

    #[test]
    fn the_same_change_made_in_a_second_identical_block_is_not_merged() {
        let f = Fixture::new();
        // A file with two identical blocks, each with the same three lines
        // of context either side.
        let block = "start\nalpha\nbeta\ngamma\nvalue = 1\ndelta\nepsilon\nzeta\nend\n";
        let file = |first: &str, second: &str| format!("{}{}", block.replace("value = 1", first), block.replace("value = 1", second));
        f.elsewhere(|other| commit(other, "twin.txt", &file("value = 1", "value = 1")));
        sh(&f.project, &["pull", "-q", "origin", "main"]);
        let wt = PathBuf::from(git::create_worktree(&f.project, "quiet-amber-fox", Some("main")).unwrap().path);

        // Upstream changes block 1.
        f.elsewhere(|other| commit(other, "twin.txt", &file("value = 2", "value = 1")));
        // The branch's unpushed commit makes the same change in block 2.
        commit(&wt, "twin.txt", &file("value = 1", "value = 2"));

        let landed = check(&f.project, &wt, Fetch::Fresh);
        // `git cherry` calls it equivalent, and the exact patch ids match...
        assert!(sh(&wt, &["cherry", "origin/main", "HEAD"]).lines().all(|line| line.starts_with('-')));
        let ours = verbatim_patch_ids(&wt, &["origin/main..HEAD"]).unwrap();
        let theirs = verbatim_patch_ids(&wt, &["HEAD..origin/main"]).unwrap();
        assert!(!ours.is_empty() && ours.iter().all(|id| theirs.contains(id)), "the trap this test is about");
        // ...while the branch changes a line the base does not.
        assert!(!sh(&wt, &["diff", "origin/main", "HEAD"]).is_empty());
        assert_eq!(landed.merged, None, "{landed:?}");
        assert!(!landed.safe);
        assert_eq!(landed.unmerged_commits, 1);
    }

    #[test]
    fn a_conflicting_test_merge_does_not_let_a_position_blind_match_through() {
        let f = Fixture::new();
        let block = "start\nalpha\nbeta\ngamma\nvalue = 1\ndelta\nepsilon\nzeta\nend\n";
        let file = |first: &str, second: &str| format!("{}{}", block.replace("value = 1", first), block.replace("value = 1", second));
        f.elsewhere(|other| commit(other, "twin.txt", &file("value = 1", "value = 1")));
        sh(&f.project, &["pull", "-q", "origin", "main"]);
        let wt = PathBuf::from(git::create_worktree(&f.project, "quiet-amber-fox", Some("main")).unwrap().path);

        // Upstream changes block 1, and later edits block 2 as well.
        f.elsewhere(|other| {
            commit(other, "twin.txt", &file("value = 2", "value = 1"));
            commit(other, "twin.txt", &file("value = 2", "value = 3"));
        });
        // The branch's unpushed commit makes the first change, in block 2.
        commit(&wt, "twin.txt", &file("value = 1", "value = 2"));

        let landed = check(&f.project, &wt, Fetch::Fresh);
        // The patch ids match and the test merge conflicts...
        let ours = verbatim_patch_ids(&wt, &["origin/main..HEAD"]).unwrap();
        let theirs = verbatim_patch_ids(&wt, &["HEAD..origin/main"]).unwrap();
        assert!(!ours.is_empty() && ours.iter().all(|id| theirs.contains(id)));
        assert!(git::run(&wt, &["merge-tree", "--write-tree", "origin/main", "HEAD"]).is_err());
        // ...and with two places the hunk could apply, that proves nothing.
        assert_eq!(landed.merged, None, "{landed:?}");
        assert!(landed.not_verified.is_some() && !landed.safe, "{landed:?}");
    }

    #[test]
    fn a_squash_whose_lines_main_changed_again_is_still_recognised_when_the_change_has_one_place() {
        let f = Fixture::new();
        let wt = PathBuf::from(git::create_worktree(&f.project, "quiet-amber-fox", Some("main")).unwrap().path);
        let branch = Fixture::branch("quiet-amber-fox");
        commit(&wt, "a.txt", "one\ntwo from the branch\n");
        sh(&wt, &["push", "-q", "origin", &branch]);
        f.elsewhere(|other| {
            sh(other, &["merge", "-q", "--squash", &format!("origin/{branch}")]);
            sh(other, &["commit", "-q", "-m", "squashed"]);
            // Main then changes the same line again: merging the old branch
            // into it now conflicts.
            commit(other, "a.txt", "one\ntwo, edited on main\n");
        });
        let landed = check(&f.project, &wt, Fetch::Fresh);
        assert!(git::run(&wt, &["merge-tree", "--write-tree", "origin/main", "HEAD"]).is_err(), "the test merge conflicts");
        assert!(landed.merged.is_some() && landed.safe, "{landed:?}");
    }

    /// Commit what is in the index with plumbing. `git commit` asks a diff
    /// whether there is anything to commit, and a diff told to ignore a
    /// submodule may answer no when the submodule is all that changed.
    fn commit_index(cwd: &Path, message: &str) {
        let tree = sh(cwd, &["write-tree"]).trim().to_string();
        let commit = sh(cwd, &["commit-tree", &tree, "-p", "HEAD", "-m", message]).trim().to_string();
        sh(cwd, &["update-ref", "HEAD", &commit]);
    }

    #[test]
    fn a_submodule_bump_hidden_by_ignore_all_is_not_no_changes() {
        let f = Fixture::new();
        // A repository to use as a submodule, with two commits.
        let lib = f._dir.path().join("lib");
        std::fs::create_dir_all(&lib).unwrap();
        sh(&lib, &["init", "-q", "-b", "main"]);
        sh(&lib, &["config", "user.email", "l@example.com"]);
        sh(&lib, &["config", "user.name", "L"]);
        commit(&lib, "lib.txt", "v1\n");
        let v1 = sh(&lib, &["rev-parse", "HEAD"]).trim().to_string();
        commit(&lib, "lib.txt", "v2\n");

        // The project records it at v1, told to ignore it in every diff. The
        // commit a submodule is recorded at is written to the index directly:
        // with `ignore = all`, newer git does not let `git add` stage it.
        let lib_v2 = sh(&lib, &["rev-parse", "HEAD"]).trim().to_string();
        sh(&f.project, &["-c", "protocol.file.allow=always", "submodule", "add", "-q", lib.to_str().unwrap(), "lib"]);
        sh(&f.project, &["config", "-f", ".gitmodules", "submodule.lib.ignore", "all"]);
        sh(&f.project, &["add", ".gitmodules"]);
        sh(&f.project, &["update-index", "--cacheinfo", &format!("160000,{v1},lib")]);
        commit_index(&f.project, "add lib at v1");
        sh(&f.project, &["push", "-q", "origin", "main"]);
        assert_eq!(sh(&f.project, &["rev-parse", "HEAD:lib"]).trim(), v1);

        // In the workspace, an unpushed commit moves the submodule to v2.
        let wt = PathBuf::from(git::create_worktree(&f.project, "quiet-amber-fox", Some("main")).unwrap().path);
        sh(&wt, &["-c", "protocol.file.allow=always", "submodule", "update", "-q", "--init"]);
        sh(&wt, &["update-index", "--cacheinfo", &format!("160000,{lib_v2},lib")]);
        commit_index(&wt, "bump lib to v2");
        assert_eq!(sh(&wt, &["rev-parse", "HEAD:lib"]).trim(), lib_v2);

        // Git's own diff sees nothing, because it was told not to look...
        assert!(git::run(&wt, &["diff", "--quiet", "origin/main", "HEAD", "--"]).is_ok());
        assert!(sh(&wt, &["status", "--porcelain"]).trim().is_empty());
        // ...while the branch does record a different commit for the submodule.
        assert_ne!(sh(&wt, &["rev-parse", "origin/main:lib"]), sh(&wt, &["rev-parse", "HEAD:lib"]));

        let landed = check(&f.project, &wt, Fetch::Fresh);
        assert_ne!(landed.merged, Some(MergedBy::NoChanges), "{landed:?}");
        assert!(!landed.safe, "{landed:?}");
        assert!(landed.not_verified.as_deref().is_some_and(|reason| reason.contains("submodule")), "{landed:?}");

        // A clean, merged workspace that merely has a submodule is not
        // verified either: what is inside it cannot be checked from here.
        let plain = PathBuf::from(git::create_worktree(&f.project, "calm-teal-bee", Some("main")).unwrap().path);
        let landed = check(&f.project, &plain, Fetch::Fresh);
        assert_eq!(landed.merged, Some(MergedBy::Ancestor));
        assert!(landed.not_verified.as_deref().is_some_and(|reason| reason.contains("submodule")) && !landed.safe, "{landed:?}");
    }

    #[test]
    fn a_modified_file_hidden_from_status_makes_the_check_unverified() {
        let f = Fixture::new();
        for flag in ["--skip-worktree", "--assume-unchanged"] {
            let name = if flag == "--skip-worktree" { "quiet-amber-fox" } else { "calm-teal-bee" };
            let wt = PathBuf::from(git::create_worktree(&f.project, name, Some("main")).unwrap().path);
            assert!(check(&f.project, &wt, Fetch::Fresh).safe);
            sh(&wt, &["update-index", flag, "a.txt"]);
            std::fs::write(wt.join("a.txt"), "changed, and invisible\n").unwrap();
            // Git reports a clean tree...
            assert!(sh(&wt, &["status", "--porcelain"]).trim().is_empty(), "{flag}");
            // ...and the check does not take its word for it.
            let landed = check(&f.project, &wt, Fetch::Fresh);
            assert!(landed.not_verified.as_deref().is_some_and(|reason| reason.contains("hidden from git status")), "{flag}: {landed:?}");
            assert!(!landed.safe, "{flag}");
        }
    }

    #[test]
    fn a_stash_list_that_cannot_be_read_is_not_verified() {
        let f = Fixture::new();
        let wt = PathBuf::from(git::create_worktree(&f.project, "quiet-amber-fox", Some("main")).unwrap().path);
        assert!(check(&f.project, &wt, Fetch::Fresh).safe);
        STASH_LIST_FAILS.with(|fails| fails.set(true));
        let landed = check(&f.project, &wt, Fetch::Fresh);
        STASH_LIST_FAILS.with(|fails| fails.set(false));
        assert!(landed.not_verified.as_deref().is_some_and(|reason| reason.contains("stash list")), "{landed:?}");
        assert!(!landed.clean && !landed.safe, "unknown is not 'no stashes'");
    }

    #[test]
    fn the_digest_changes_with_anything_the_person_was_shown() {
        let f = Fixture::new();
        let wt = f.worktree("quiet-amber-fox");
        let first = check(&f.project, &wt, Fetch::Fresh);
        assert_eq!(first.digest, check(&f.project, &wt, Fetch::Fresh).digest, "the same state gives the same digest");
        std::fs::write(wt.join("late.txt"), "x").unwrap();
        let dirty = check(&f.project, &wt, Fetch::Fresh);
        assert_ne!(dirty.digest, first.digest);
        // One uncommitted file swapped for another: the same count, a
        // different thing to lose.
        std::fs::rename(wt.join("late.txt"), wt.join("other.txt")).unwrap();
        let swapped = check(&f.project, &wt, Fetch::Fresh);
        assert_eq!(swapped.uncommitted, dirty.uncommitted);
        assert_ne!(swapped.digest, dirty.digest);
        sh(&wt, &["add", "."]);
        sh(&wt, &["commit", "-q", "-m", "late"]);
        let ahead = check(&f.project, &wt, Fetch::Fresh);
        assert_ne!(ahead.digest, dirty.digest);
        assert_ne!(ahead.digest, first.digest);
        // A folder that is gone is not the same as one that cannot be read.
        std::fs::remove_file(wt.join(".git")).unwrap();
        let broken = check(&f.project, &wt, Fetch::Skip).digest;
        assert_ne!(broken, check(&f.project, &f.project.join("nowhere"), Fetch::Skip).digest);
    }

    #[test]
    fn a_rebase_merge_is_recognised() {
        let f = Fixture::new();
        let wt = f.worktree("quiet-amber-fox");
        let branch = Fixture::branch("quiet-amber-fox");
        sh(&wt, &["push", "-q", "origin", &branch]);
        f.elsewhere(|other| {
            commit(other, "unrelated.txt", "main moved\n");
            // Replay the branch's commits on top of main, as a rebase merge does.
            let commits = sh(other, &["rev-list", "--reverse", &format!("origin/main..origin/{branch}")]);
            for sha in commits.lines() {
                sh(other, &["cherry-pick", sha]);
            }
        });
        let landed = check(&f.project, &wt, Fetch::Fresh);
        assert_eq!(landed.merged, Some(MergedBy::Rebase), "{landed:?}");
        assert!(landed.safe);
    }

    #[test]
    fn an_unreachable_remote_is_not_verified_rather_than_merged() {
        let f = Fixture::new();
        let wt = PathBuf::from(git::create_worktree(&f.project, "quiet-amber-fox", Some("main")).unwrap().path);
        sh(&f.project, &["remote", "set-url", "origin", f.remote.with_extension("gone").to_str().unwrap()]);
        let landed = check(&f.project, &wt, Fetch::Fresh);
        assert!(landed.not_verified.as_deref().is_some_and(|reason| reason.contains("could not be fetched")), "{landed:?}");
        assert!(!landed.safe, "nothing ahead of the last known origin/main, but that copy may be stale");
        assert!(landed.losses.iter().any(|line| line.starts_with("Not verified:")));
    }

    #[test]
    fn a_project_with_no_remote_is_not_verified() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = std::fs::canonicalize(dir.path()).unwrap();
        sh(&project, &["init", "-q", "-b", "main"]);
        sh(&project, &["config", "user.email", "t@example.com"]);
        sh(&project, &["config", "user.name", "T"]);
        commit(&project, "a.txt", "one\n");
        let wt = PathBuf::from(git::create_worktree(&project, "quiet-amber-fox", None).unwrap().path);
        let landed = check(&project, &wt, Fetch::Fresh);
        assert!(landed.not_verified.as_deref().is_some_and(|reason| reason.contains("no remote")), "{landed:?}");
        assert_eq!(landed.merged, Some(MergedBy::Ancestor), "compared with the local main for what it is worth");
        assert!(!landed.safe);
    }

    #[test]
    fn uncommitted_untracked_and_stashed_work_is_not_clean_but_ignored_files_are() {
        let f = Fixture::new();
        let wt = PathBuf::from(git::create_worktree(&f.project, "quiet-amber-fox", Some("main")).unwrap().path);
        // Ignored build output does not count.
        std::fs::create_dir_all(wt.join("target")).unwrap();
        std::fs::write(wt.join("target/out.bin"), "x").unwrap();
        assert!(check(&f.project, &wt, Fetch::Skip).clean);

        std::fs::write(wt.join("untracked.txt"), "new").unwrap();
        std::fs::write(wt.join("a.txt"), "changed\n").unwrap();
        let landed = check(&f.project, &wt, Fetch::Skip);
        assert_eq!(landed.uncommitted, 2);
        assert!(!landed.clean && !landed.safe);
        assert!(landed.losses.iter().any(|line| line.contains("2 uncommitted files")));

        // Stashing empties the tree, but the work is still only in the stash.
        sh(&wt, &["stash", "push", "-q", "--include-untracked"]);
        let landed = check(&f.project, &wt, Fetch::Skip);
        assert_eq!((landed.uncommitted, landed.stashes), (0, 1));
        assert!(!landed.clean && !landed.safe);
        assert!(landed.losses.iter().any(|line| line.contains("1 stash entry")));

        // A stash made on another branch is not this workspace's.
        let other = PathBuf::from(git::create_worktree(&f.project, "calm-teal-bee", Some("main")).unwrap().path);
        assert!(check(&f.project, &other, Fetch::Skip).clean);
    }

    #[test]
    fn the_one_word_state_follows_the_check() {
        let f = Fixture::new();
        let wt = PathBuf::from(git::create_worktree(&f.project, "quiet-amber-fox", Some("main")).unwrap().path);
        let state = |wt: &Path| check(&f.project, wt, Fetch::Skip).state();
        assert_eq!(state(&wt), State::Clean);
        std::fs::write(wt.join("new.txt"), "x").unwrap();
        assert_eq!(state(&wt), State::Uncommitted);
        sh(&wt, &["add", "."]);
        sh(&wt, &["commit", "-q", "-m", "work"]);
        assert_eq!(state(&wt), State::Unmerged);

        // Squash-merged on the remote: still "unmerged" locally until something fetches.
        let branch = Fixture::branch("quiet-amber-fox");
        sh(&wt, &["push", "-q", "origin", &branch]);
        f.elsewhere(|other| {
            sh(other, &["merge", "-q", "--squash", &format!("origin/{branch}")]);
            sh(other, &["commit", "-q", "-m", "squashed"]);
        });
        assert_eq!(state(&wt), State::Unmerged);
        sh(&f.project, &["fetch", "-q", "origin", "main"]);
        assert_eq!(state(&wt), State::Merged);

        std::fs::remove_file(wt.join(".git")).unwrap();
        assert_eq!(state(&wt), State::Unknown);
    }

    #[test]
    fn the_state_in_a_list_agrees_with_the_full_check_at_every_step() {
        let f = Fixture::new();
        let wt = PathBuf::from(git::create_worktree(&f.project, "quiet-amber-fox", Some("main")).unwrap().path);
        let listed = |wt: &Path| {
            let context = list_context(&f.project);
            let uncommitted = sh(wt, &["status", "--porcelain", "--untracked-files=normal", "--"]).lines().count() as u32;
            state_in_list(&context, wt, git::current_branch(wt).as_deref(), git::head_commit(wt).as_deref(), uncommitted)
        };
        let agree = |wt: &Path, expected: State| {
            assert_eq!(listed(wt), expected);
            assert_eq!(check(&f.project, wt, Fetch::Skip).state(), expected);
            // Asked again, the cached answer is the same one.
            assert_eq!(listed(wt), expected);
        };
        agree(&wt, State::Clean);
        std::fs::write(wt.join("new.txt"), "x").unwrap();
        agree(&wt, State::Uncommitted);
        sh(&wt, &["stash", "push", "-q", "--include-untracked"]);
        agree(&wt, State::Uncommitted);
        sh(&wt, &["stash", "pop", "-q"]);
        sh(&wt, &["add", "."]);
        sh(&wt, &["commit", "-q", "-m", "work"]);
        agree(&wt, State::Unmerged);

        // The base moves: the answer for the same HEAD is worked out again.
        let branch = Fixture::branch("quiet-amber-fox");
        sh(&wt, &["push", "-q", "origin", &branch]);
        f.elsewhere(|other| {
            sh(other, &["merge", "-q", "--squash", &format!("origin/{branch}")]);
            sh(other, &["commit", "-q", "-m", "squashed"]);
        });
        agree(&wt, State::Unmerged);
        sh(&f.project, &["fetch", "-q", "origin", "main"]);
        agree(&wt, State::Merged);

        std::fs::remove_file(wt.join(".git")).unwrap();
        agree(&wt, State::Unknown);
    }

    /// Not a pass/fail test: prints what the state of 20 worktrees costs,
    /// the full check against the list's shortcut. Run with
    /// `cargo test measure_the_list -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn measure_the_list_state_cost() {
        let f = Fixture::new();
        let worktrees: Vec<PathBuf> = (0..20).map(|i| f.worktree(&format!("wt-{i}"))).collect();
        let time = |label: &str, work: &dyn Fn()| {
            let start = std::time::Instant::now();
            work();
            println!("{label}: {:?}", start.elapsed());
        };
        let listed = || {
            let context = list_context(&f.project);
            for wt in &worktrees {
                let head = git::head_commit(wt);
                state_in_list(&context, wt, git::current_branch(wt).as_deref(), head.as_deref(), 0);
            }
        };
        time("full check per worktree, 20 worktrees", &|| worktrees.iter().for_each(|wt| drop(check(&f.project, wt, Fetch::Skip))));
        time("list shortcut, first time", &listed);
        time("list shortcut, cached", &listed);
    }

    #[test]
    fn checking_again_adds_no_objects() {
        let f = Fixture::new();
        let wt = f.worktree("quiet-amber-fox");
        let objects = || sh(&f.project, &["count-objects"]);
        check(&f.project, &wt, Fetch::Skip);
        let after_first = objects();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        check(&f.project, &wt, Fetch::Skip);
        assert_eq!(objects(), after_first, "the squash check reuses one object however often it runs");
    }

    #[test]
    fn a_directory_that_is_not_this_projects_worktree_is_not_checked() {
        let f = Fixture::new();
        let wt = PathBuf::from(git::create_worktree(&f.project, "quiet-amber-fox", Some("main")).unwrap().path);
        std::fs::remove_file(wt.join(".git")).unwrap();
        let landed = check(&f.project, &wt, Fetch::Skip);
        assert!(!landed.checked && !landed.safe);
        assert_eq!(landed.losses.len(), 1);
    }

    #[test]
    fn a_worktree_made_outside_the_app_gets_the_same_check() {
        let f = Fixture::new();
        let by_hand = f.project.parent().unwrap().join("by-hand");
        sh(&f.project, &["worktree", "add", "-q", "-b", "feature/by-hand", by_hand.to_str().unwrap(), "main"]);
        assert!(check(&f.project, &by_hand, Fetch::Fresh).safe);
        commit(&by_hand, "work.txt", "x\n");
        let landed = check(&f.project, &by_hand, Fetch::Fresh);
        assert_eq!(landed.branch.as_deref(), Some("feature/by-hand"));
        assert_eq!(landed.unmerged_commits, 1);
        assert!(!landed.safe);
    }
}
