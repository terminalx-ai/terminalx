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
//! A merged pull request is not used as proof on its own: commits can be
//! added to a branch after its pull request merged, and those would be lost.
//!
//! When the check cannot be made (no remote, the fetch fails, the directory
//! is not a working tree of this project) the answer is "not verified", never
//! "merged": the caller asks for the second confirmation.

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
    /// Use what is already known locally: the quick state shown for every
    /// workspace in a list, which must not wait on the network.
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
        }
        out
    }
}

fn count(cwd: &Path, args: &[&str]) -> Option<u32> {
    git::run(cwd, args).ok()?.trim().parse().ok()
}

/// Stash entries whose message says they were made on `branch`. Git writes
/// `WIP on <branch>: …` or `On <branch>: …` for every stash.
fn stashes_on(cwd: &Path, branch: &str) -> u32 {
    let Ok(out) = git::run(cwd, &["stash", "list", "--format=%gs"]) else { return 0 };
    let (wip, on) = (format!("WIP on {branch}:"), format!("On {branch}:"));
    out.lines().filter(|line| line.starts_with(&wip) || line.starts_with(&on)).count() as u32
}

/// How the work at HEAD got into `base`, if it did, and how many commits
/// did not.
fn merged_into(cwd: &Path, base: &str) -> Option<(Option<MergedBy>, u32)> {
    if count(cwd, &["rev-list", "--count", &format!("{base}..HEAD")])? == 0 {
        return Some((Some(MergedBy::Ancestor), 0));
    }
    // `git cherry` marks each commit `-` when the base has a patch-equivalent one.
    let cherry = git::run(cwd, &["cherry", base, "HEAD"]).ok()?;
    let unmerged = cherry.lines().filter(|line| line.starts_with('+')).count() as u32;
    if unmerged == 0 {
        return Some((Some(MergedBy::Rebase), 0));
    }
    let merge_base = git::run(cwd, &["merge-base", base, "HEAD"]).ok()?.trim().to_string();
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
        return Some((Some(MergedBy::Squash), 0));
    }
    Some((None, unmerged))
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

    let status = count_lines(path, &["status", "--porcelain", "--untracked-files=normal", "--"]);
    landed.uncommitted = status.unwrap_or(0);
    landed.stashes = branch.as_deref().map(|branch| stashes_on(path, branch)).unwrap_or(0);
    landed.clean = status == Some(0) && landed.stashes == 0;
    landed.pushed = git::run(path, &["branch", "-r", "--contains", "HEAD"]).is_ok_and(|out| !out.trim().is_empty());

    let default = git::default_branch(project);
    let has_remote = git::remote_url(project).is_some();
    let base = match (&default, has_remote) {
        (Some(default), true) => {
            if fetch == Fetch::Fresh {
                if let Err(error) = git::run_within(project, &["fetch", "--quiet", "origin", default], FETCH_TIMEOUT) {
                    landed.not_verified = Some(format!("origin/{default} could not be fetched ({}), so this is compared with the last known copy.", first_line(&format!("{error:#}"))));
                }
            }
            let remote = format!("origin/{default}");
            if git::run(project, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{remote}")]).is_ok() {
                Some(remote)
            } else {
                landed.not_verified = Some(format!("{remote} is not known here, so there is nothing to compare the branch with."));
                None
            }
        }
        (Some(default), false) => {
            landed.not_verified = Some(format!("This project has no remote, so the branch is compared with the local {default} only."));
            Some(default.clone())
        }
        (None, _) => {
            landed.not_verified = Some("The project's default branch could not be found.".to_string());
            None
        }
    };
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
    }
    landed.base = base;
    landed.safe = landed.clean && landed.merged.is_some() && landed.not_verified.is_none();
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
