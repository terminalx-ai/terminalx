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
//! - **Commits inside a submodule** that the submodule has not pushed. A
//!   submodule with uncommitted changes, or checked out at a commit other
//!   than the recorded one, shows as an uncommitted file; one whose recorded
//!   commit exists only locally does not.

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
    /// Use what is already known locally: for a view that refreshes often
    /// and must not touch the network. Such a check never says "safe".
    #[cfg_attr(not(test), allow(dead_code))]
    Skip,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Landed {
    /// The directory is a working tree of this project, so it could be read.
    pub checked: bool,
    pub branch: Option<String>,
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
}

impl Landed {
    fn describe_losses(&self) -> Vec<String> {
        let plural = |n: u32, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
        let mut out = Vec::new();
        if !self.checked {
            out.push("This folder is not a working git checkout of this project, so it cannot be checked for uncommitted or unmerged work.".to_string());
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
    let out = git::run(cwd, &["stash", "list", "--format=%gs"]).ok()?;
    let branch = branch.unwrap_or("(no branch)");
    let (wip, on) = (format!("WIP on {branch}:"), format!("On {branch}:"));
    Some(out.lines().filter(|line| line.starts_with(&wip) || line.starts_with(&on)).count() as u32)
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
        if ours.iter().all(|id| theirs.contains(id)) {
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
    if git::run(cwd, &["diff", "--quiet", &merge_base, "HEAD", "--"]).is_ok() {
        return Some((Some(MergedBy::NoChanges), 0));
    }
    // The whole branch as one commit on top of where it started; nothing
    // refers to it, so it is an unreachable object git collects later.
    let squashed = git::run(
        cwd,
        &["-c", "user.name=TerminalX", "-c", "user.email=noreply@terminalx.invalid", "commit-tree", "HEAD^{tree}", "-p", &merge_base, "-m", "squash check"],
    )
    .ok()?;
    let as_one = git::run(cwd, &["cherry", base, squashed.trim()]).ok()?;
    if as_one.lines().next().is_some_and(|line| line.starts_with('-')) {
        // The same change exactly: a commit added after the squash that only
        // re-indents a line still matches when whitespace is ignored.
        let whole = verbatim_patch_ids(cwd, &["-1", squashed.trim()])?;
        let theirs = upstream()?;
        if !whole.is_empty() && whole.iter().all(|id| theirs.contains(id)) {
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
        match git::run_within(project, &["fetch", "--quiet", "origin", &default], FETCH_TIMEOUT) {
            Ok(_) => fresh = true,
            Err(error) => not_verified = Some(format!("origin/{default} could not be fetched ({}), so this is compared with the last known copy.", first_line(&format!("{error:#}")))),
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
        return unchecked;
    }
    let branch = git::current_branch(path);
    let mut landed = Landed { checked: true, branch: branch.clone(), ..Default::default() };

    // The fetch can take many seconds. The working tree is read after it,
    // so what is reported is the tree as it is when the answer is given.
    let (base, not_verified, fresh) = base_for(project, fetch);
    landed.not_verified = not_verified;
    landed.fresh = fresh;

    let status = count_lines(path, &["status", "--porcelain", "--untracked-files=normal", "--"]);
    let stashes = stashes_on(path, branch.as_deref());
    landed.uncommitted = status.unwrap_or(0);
    landed.stashes = stashes.unwrap_or(0);
    landed.clean = status == Some(0) && stashes == Some(0);
    landed.pushed = git::run(path, &["branch", "-r", "--contains", "HEAD"]).is_ok_and(|out| !out.trim().is_empty());
    if let Some(base) = &base {
        match merged_into(path, base) {
            Some((merged, unmerged)) => {
                landed.merged = merged;
                landed.unmerged_commits = unmerged;
            }
            None => landed.not_verified = Some(format!("Git could not compare the branch with {base}.")),
        }
    }
    if status.is_none() {
        landed.not_verified = Some("Git could not read the working tree's status.".to_string());
    } else if stashes.is_none() {
        landed.not_verified = Some("Git could not read the stash list, so stashed work cannot be ruled out.".to_string());
    }
    landed.base = base;
    landed.safe = landed.clean && landed.merged.is_some() && landed.not_verified.is_none() && landed.fresh;
    landed.losses = landed.describe_losses();
    landed
}

fn count_lines(cwd: &Path, args: &[&str]) -> Option<u32> {
    git::run(cwd, args).ok().map(|out| out.lines().count() as u32)
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
