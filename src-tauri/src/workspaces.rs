//! Workspaces: every checkout a project has, whoever made it. The project
//! root, the worktrees Raccoon created, and worktrees the reader made by
//! hand all show up the same way, with their branch, local state and size.
//! Removal always fetches the remote default branch and verifies that the
//! checkout is clean and merged. Sessions belong to a workspace by path.

use std::path::{Path, PathBuf};

use anyhow::Result;
use serde::Serialize;

use crate::git;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub path: String,
    /// Folder name for worktrees; the project's own name for the root.
    pub name: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub is_main: bool,
    /// Created by Raccoon (lives under the project's worktree folder).
    pub managed: bool,
    pub uncommitted: u32,
    pub additions: u32,
    pub deletions: u32,
    /// Commits on this branch that no remote has.
    pub unpushed: u32,
    /// Commits ahead of this checkout's configured upstream.
    pub ahead: u32,
    /// Commits behind this checkout's configured upstream.
    pub behind: u32,
    pub size_bytes: u64,
    /// Local snapshot only; deletion always fetches and checks again.
    pub state: String,
}

fn shortstat(cwd: &Path) -> (u32, u32) {
    let out = git::run(cwd, &["diff", "--shortstat", "HEAD", "--"]).unwrap_or_default();
    let mut add = 0;
    let mut del = 0;
    for part in out.split(',') {
        let part = part.trim();
        let n: u32 = part.split_whitespace().next().and_then(|n| n.parse().ok()).unwrap_or(0);
        if part.contains("insertion") {
            add = n;
        } else if part.contains("deletion") {
            del = n;
        }
    }
    (add, del)
}

fn uncommitted(cwd: &Path) -> u32 {
    git::run(cwd, &["status", "--porcelain", "--untracked-files=normal", "--"]).map(|s| s.lines().count() as u32).unwrap_or(0)
}

fn unpushed(cwd: &Path, branch: Option<&str>) -> u32 {
    let Some(branch) = branch else { return 0 };
    git::run(cwd, &["rev-list", "--count", "HEAD", "--not", &format!("--exclude={branch}"), "--branches", "--remotes", "--tags"])
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0)
}

/// The project root plus every worktree, root first, Raccoon's own after,
/// then the rest in git's order.
pub fn list(project: &Path) -> Result<Vec<Workspace>> {
    let root = PathBuf::from(crate::store::projects::canonical_directory(&project.to_string_lossy())?);
    if !git::is_repo(&root) {
        return Ok(vec![Workspace {
            name: crate::store::projects::project_name(&root.to_string_lossy()),
            path: root.to_string_lossy().into_owned(),
            branch: None, head: None, is_main: true, managed: false,
            uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0, size_bytes: git::size_on_disk(&root), state: "clean".into(),
        }]);
    }
    let managed_root = git::worktree_root(project);
    let managed_root = std::fs::canonicalize(&managed_root).unwrap_or(managed_root);
    let mut out = Vec::new();
    let entries = git::list_worktrees(project)?;
    for (path, branch) in entries {
        let p = PathBuf::from(&path);
        let p = std::fs::canonicalize(&p).unwrap_or(p);
        if !p.exists() {
            continue;
        }
        let is_main = p == root;
        let managed = p.parent().map(|parent| parent == managed_root).unwrap_or(false);
        let branch = branch.or_else(|| git::current_branch(&p));
        let (additions, deletions) = shortstat(&p);
        let (ahead, behind) = git::upstream_counts(&p);
        let dirty = uncommitted(&p);
        let base = git::default_branch(project).map(|b| format!("refs/remotes/origin/{b}"));
        let merged = base.as_deref().and_then(|base| merged_into(&p, base).ok());
        out.push(Workspace {
            name: if is_main {
                crate::store::projects::project_name(&root.to_string_lossy())
            } else {
                p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone())
            },
            path: p.to_string_lossy().into_owned(),
            head: git::head_commit(&p),
            unpushed: unpushed(&p, branch.as_deref()),
            ahead,
            behind,
            branch,
            is_main,
            managed,
            uncommitted: dirty,
            size_bytes: git::size_on_disk(&p),
            state: if dirty > 0 { "uncommitted" } else { match merged { Some(true) => "merged", Some(false) => "unmerged", None => "clean (merge not verified)" } }.into(),
            additions,
            deletions,
        });
    }
    out.sort_by_key(|w| (!w.is_main, !w.managed));
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePr {
    pub number: u64,
    pub title: String,
    pub url: String,
    /// OPEN | MERGED | CLOSED
    pub state: String,
    pub is_draft: bool,
}

/// What deleting a workspace would lose, and where its branch stands.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDisposition {
    pub exists: bool,
    /// Whether the counts could be read. False for a directory that is no
    /// longer a working tree of its own: they are then 0 and mean "unknown".
    pub checked: bool,
    pub is_main: bool,
    pub branch: Option<String>,
    pub uncommitted: u32,
    pub unpushed: u32,
    /// Commits ahead of the default branch, so an unmerged branch shows work.
    pub ahead_of_base: Option<u32>,
    pub pr: Option<WorkspacePr>,
    /// `gh` was usable and a remote exists, so `pr: None` means "no PR".
    pub pr_checked: bool,
    /// Sessions that ran in this checkout; deleting it removes them and
    /// their transcripts. Filled in by the command layer, which owns the index.
    pub sessions: usize,
    /// Their titles, so the confirmation can name what goes.
    pub session_titles: Vec<String>,
    pub default_branch: Option<String>,
    pub merged: Option<bool>,
    pub pushed: Option<bool>,
    /// Git stashes are shared and do not reliably record their worktree.
    pub stashes: u32,
    pub verification_error: Option<String>,
    pub safe: bool,
}

/// A squash merge may have a different commit graph but the same combined
/// change. A virtual merge that adds nothing to the base proves containment
/// even after unrelated changes have subsequently landed on the default branch.
pub(crate) fn merged_into(path: &Path, base: &str) -> Result<bool> {
    let ahead = git::run(path, &["rev-list", "--count", &format!("{base}..HEAD")])?;
    if ahead.trim() == "0" { return Ok(true); }
    if git::run(path, &["diff", "--quiet", base, "HEAD", "--"]).is_ok() { return Ok(true); }
    // Rebase merges preserve patch identities, even when commit IDs change.
    let cherry = git::run(path, &["cherry", base, "HEAD"])?;
    let merges = git::run(path, &["rev-list", "--merges", &format!("{base}..HEAD")])?;
    if merges.trim().is_empty() && !cherry.trim().is_empty() && cherry.lines().all(|line| line.starts_with('-')) { return Ok(true); }
    // Custom merge drivers can discard changes (e.g. merge=ours). Their
    // output is not evidence that the branch previously landed.
    if git::run(path, &["config", "--get-regexp", r"^merge\..*\.driver$"]).is_ok() { return Ok(false); }
    let base_tree = git::run(path, &["rev-parse", &format!("{base}^{{tree}}")])?;
    Ok(git::run(path, &["merge-tree", "--write-tree", base, "HEAD"])
        .map(|out| out.lines().next() == Some(base_tree.trim())).unwrap_or(false))
}

fn fetch_default(project: &Path) -> Result<String> {
    use std::time::Duration;
    // Fetch explicit refs rather than trusting a possibly narrow fetch refspec.
    git::run(project, &["remote", "get-url", "origin"])?;
    git::run_within(project, &["fetch", "--prune", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"], Duration::from_secs(15), &|| false)
        .map_err(|e| anyhow::anyhow!("Could not fetch origin: {e:?}"))?;
    git::run_within(project, &["remote", "set-head", "origin", "--auto"], Duration::from_secs(5), &|| false)
        .map_err(|e| anyhow::anyhow!("Could not discover origin's default branch: {e:?}"))?;
    let head = git::run(project, &["symbolic-ref", "refs/remotes/origin/HEAD"])?;
    head.trim().strip_prefix("refs/remotes/origin/").map(str::to_owned)
        .ok_or_else(|| anyhow::anyhow!("origin has no default branch"))
}

pub fn disposition(project: &Path, path: &Path) -> WorkspaceDisposition {
    let root = std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    let p = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut d = WorkspaceDisposition {
        exists: path.exists(), is_main: p == root, branch: None,
        default_branch: git::default_branch(project), ..Default::default()
    };
    let check = (|| -> Result<()> {
        anyhow::ensure!(git::is_worktree_of(project, &p), "This directory is not a working checkout of this project; its contents could not be checked.");
        d.branch = git::current_branch(&p);
        // -z avoids quoted/newline paths; porcelain v1 renames have a second path.
        let status = git::run(&p, &["status", "--porcelain=v1", "-z", "--untracked-files=all", "--"])?;
        let mut records = status.split('\0').filter(|r| !r.is_empty());
        while let Some(record) = records.next() {
            d.uncommitted += 1;
            if record.as_bytes().get(..2).is_some_and(|xy| xy.contains(&b'R') || xy.contains(&b'C')) { records.next(); }
        }
        // Stashes are repository-wide. Do not claim a checkout is safe by
        // guessing from a branch name (branches can be renamed or reused).
        d.stashes = git::run(&p, &["stash", "list", "--format=%H"])?.lines().count() as u32;
        d.checked = true;
        let default = fetch_default(project)?;
        d.default_branch = Some(default.clone());
        let base = format!("refs/remotes/origin/{default}");
        d.ahead_of_base = Some(git::run(&p, &["rev-list", "--count", &format!("{base}..HEAD")])?.trim().parse()?);
        d.unpushed = git::run(&p, &["rev-list", "--count", "HEAD", "--not", "--remotes"])?.trim().parse()?;
        d.pushed = Some(d.unpushed == 0);
        d.merged = Some(merged_into(&p, &base)?);
        Ok(())
    })();
    if let Err(error) = check { d.verification_error = Some(format!("{error:#}")); }
    if d.verification_error.is_none() {
        if let Some(branch) = d.branch.as_deref() {
            if crate::github::available() {
                // A merged PR is evidence only for this exact tip, into this
                // default branch, with its merge commit in the fetched base.
                if let Ok(prs) = crate::github::workspace_prs(&p, branch) {
                    d.pr_checked = true;
                    let base = format!("refs/remotes/origin/{}", d.default_branch.as_deref().unwrap_or_default());
                    let head = git::head_commit(&p).unwrap_or_default();
                    if prs.iter().any(|pr| pr.state == "MERGED" && pr.head_oid == head
                        && Some(&pr.base) == d.default_branch.as_ref()
                        && pr.merge_oid.as_deref().is_some_and(|oid| git::run(&p, &["merge-base", "--is-ancestor", oid, &base]).is_ok())) {
                        d.merged = Some(true);
                    }
                    d.pr = prs.into_iter().next().map(|pr| WorkspacePr { number: pr.number, title: pr.title, url: pr.url, state: pr.state, is_draft: pr.is_draft });
                }
            }
        }
    }
    d.safe = d.checked && d.verification_error.is_none() && d.merged == Some(true) && d.uncommitted == 0 && d.stashes == 0;
    d
}

impl WorkspaceDisposition {
    /// Shared warning for CLI/RPC callers as well as backend rejections.
    pub fn warning(&self) -> String {
        let base = self.default_branch.as_deref().unwrap_or("the default branch");
        let mut detail = format!("Branch {}: {} uncommitted or untracked files; {} commits not in {base}; pushed: {}. {} repository stash entries (kept; Git cannot reliably attribute them to a workspace).",
            self.branch.as_deref().unwrap_or("detached/unknown"),
            if self.checked { self.uncommitted.to_string() } else { "unknown".into() },
            if self.merged == Some(true) { "0 (merge verified)".into() } else { self.ahead_of_base.map(|n| n.to_string()).unwrap_or_else(|| "unknown".into()) },
            self.pushed.map(|p| if p { "yes" } else { "no" }).unwrap_or("not verified"),
            if self.checked { self.stashes.to_string() } else { "unknown".into() });
        if self.safe { detail.push_str(" Merged and clean."); }
        if let Some(error) = &self.verification_error { detail.push_str(&format!(" Not verified: {error}")); }
        if let Some(pr) = &self.pr { detail.push_str(&format!(" PR #{} is {}: {}", pr.number, pr.state, pr.url)); }
        else if !self.pr_checked { detail.push_str(" Pull request status could not be checked."); }
        if !self.session_titles.is_empty() { detail.push_str(&format!(" Sessions: {}.", self.session_titles.join(", "))); }
        detail.push_str(" Deleting discards unsaved files; deleting the branch also removes its local reference to unmerged commits.");
        detail
    }
}

/// Every workspace removal, including settle, session deletion and remote
/// callers, must cross this gate. A caller's normal confirmation is never
/// interpreted as acknowledgement of unverified or unmerged work.
pub fn check_delete(project: &Path, path: &Path, confirmed_unsafe: bool) -> Result<WorkspaceDisposition> {
    let d = disposition(project, path);
    anyhow::ensure!(!d.is_main, "the project's own checkout cannot be deleted from here");
    anyhow::ensure!(d.safe || confirmed_unsafe, "Second confirmation required. {}", d.warning());
    Ok(d)
}

/// Remove a worktree that is not the project root, and its branch if asked.
///
/// When git cannot remove it and `direct` allows, a worktree Raccoon made is
/// deleted directly behind [`git::remove_managed_worktree_dir`]'s guard; one
/// made by hand elsewhere stays git's to remove. The branch follows the same
/// rule as [`git::remove_worktree`]: one that holds commits nothing else has
/// is deleted only when git removed the worktree for a caller that showed
/// them, and is otherwise kept and named in the result.
pub fn delete(project: &Path, path: &Path, delete_branch: bool, direct: git::DirectDelete, confirmed_unsafe: bool) -> Result<git::WorktreeRemoval> {
    check_delete(project, path, confirmed_unsafe)?;
    let root = std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    let p = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if p == root {
        anyhow::bail!("the project's own checkout cannot be deleted from here");
    }
    if delete_branch {
        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
            if git::managed_worktree_path(project, name).ok().is_some_and(|managed| managed == path)
                && (git::current_branch(path).as_deref() == Some(git::worktree_branch(name).as_str()) || !git::is_worktree_of(project, path)) {
                return git::remove_worktree(project, name, direct);
            }
        }
    }
    let mut removal = git::WorktreeRemoval::default();
    // Asked of a directory that is not a working tree of this project, git
    // would name some other repository's branch.
    let branch = git::is_worktree_of(project, &p).then(|| git::current_branch(&p)).flatten();
    let detached = git::detached_head(project, &p);
    let _ = git::run(project, &["worktree", "unlock", p.to_str().unwrap_or_default()]);
    let mut removed_by_git = true;
    if let Err(git_error) = git::run(project, &["worktree", "remove", "--force", p.to_str().unwrap_or_default()]) {
        removed_by_git = false;
        if direct == git::DirectDelete::Never {
            anyhow::bail!("Could not remove the worktree at {}: {git_error:#}", p.display());
        }
        if let (Some(commit), Some(name)) = (&detached, p.file_name().and_then(|name| name.to_str())) {
            removal.rescued_branch = git::rescue_detached(project, name, commit);
        }
        if let Err(direct_error) = git::remove_managed_worktree_dir(project, &p) {
            anyhow::bail!("Could not remove the worktree at {}: {direct_error:#} ({git_error:#})", p.display());
        }
    }
    let _ = git::run(project, &["worktree", "prune"]);
    if delete_branch {
        if let Some(b) = branch {
            let confirmed = removed_by_git && direct == git::DirectDelete::Allowed;
            if confirmed || git::unique_commits(project, &b) == Some(0) {
                if git::run(project, &["branch", "-D", &b]).is_err() { removal.kept_branch = Some(b); }
            } else {
                removal.kept_branch = Some(b);
            }
        }
    }
    Ok(removal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn sh(cwd: &Path, args: &[&str]) {
        assert!(Command::new("git").args(args).current_dir(cwd).output().unwrap().status.success(), "git {args:?}");
    }

    #[test]
    fn lists_root_and_worktrees_with_counts() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        sh(p, &["init", "-q", "-b", "main"]);
        sh(p, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
        std::fs::write(p.join("a.txt"), "one\n").unwrap();
        sh(p, &["add", "a.txt"]);
        sh(p, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "a"]);
        let wt = p.join("wt-feature");
        sh(p, &["worktree", "add", "-q", "-b", "feature", wt.to_str().unwrap()]);
        std::fs::write(wt.join("a.txt"), "one\ntwo\n").unwrap();
        let ws = list(p).unwrap();
        assert_eq!(ws.len(), 2);
        assert!(ws[0].is_main);
        let f = &ws[1];
        assert_eq!(f.branch.as_deref(), Some("feature"));
        assert_eq!(f.additions, 1);
        assert_eq!(f.uncommitted, 1);
        assert_eq!(f.ahead, 0);
        assert_eq!(f.behind, 0);
        assert!(!f.managed);
        let d = disposition(p, &wt);
        assert_eq!(d.uncommitted, 1);
        assert!(!d.is_main);
        assert!(!d.safe);
        assert!(d.verification_error.is_some(), "no remote is not verified");
        assert!(delete(p, &wt, true, git::DirectDelete::Allowed, false).is_err());
        delete(p, &wt, true, git::DirectDelete::Allowed, true).unwrap();
        assert_eq!(list(p).unwrap().len(), 1);
        assert!(delete(p, p, false, git::DirectDelete::Allowed, true).is_err());
    }

    #[test]
    fn a_branch_with_commits_of_its_own_is_kept_unless_the_person_was_shown_them() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        sh(p, &["init", "-q", "-b", "main"]);
        sh(p, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
        let wt = p.join("wt-feature");
        for confirmed in [false, true] {
            sh(p, &["worktree", "add", "-q", "-B", "feature", wt.to_str().unwrap()]);
            sh(&wt, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "only here"]);
            let direct = if confirmed { git::DirectDelete::Allowed } else { git::DirectDelete::Never };
            let removal = delete(p, &wt, true, direct, true).unwrap();
            assert!(!wt.exists());
            if confirmed {
                assert_eq!(removal.kept_branch, None);
                assert!(git::run(p, &["rev-parse", "--verify", "--quiet", "refs/heads/feature"]).is_err());
            } else {
                assert_eq!(removal.kept_branch.as_deref(), Some("feature"));
                assert!(git::run(p, &["rev-parse", "--verify", "--quiet", "refs/heads/feature"]).is_ok());
            }
        }
    }

    #[test]
    fn a_worktree_git_cannot_remove_is_deleted_directly_only_when_managed() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        sh(p, &["init", "-q", "-b", "main"]);
        sh(p, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
        let managed = git::create_worktree(p, "quiet-amber-fox", None).unwrap();
        let by_hand = p.join("wt-feature");
        sh(p, &["worktree", "add", "-q", "-b", "feature", by_hand.to_str().unwrap()]);
        // Without its `.git` file git no longer accepts a directory as a worktree.
        std::fs::remove_file(Path::new(&managed.path).join(".git")).unwrap();
        std::fs::remove_file(by_hand.join(".git")).unwrap();

        // Its state cannot be read any more, and must not read as clean.
        let d = disposition(p, Path::new(&managed.path));
        assert!(d.exists && !d.checked && d.branch.is_none(), "{d:?}");
        // A caller that showed nothing may not delete it directly.
        assert!(delete(p, Path::new(&managed.path), true, git::DirectDelete::Never, true).is_err());
        assert!(Path::new(&managed.path).exists());

        delete(p, Path::new(&managed.path), true, git::DirectDelete::Allowed, true).unwrap();
        assert!(!Path::new(&managed.path).exists());
        assert!(git::run(p, &["rev-parse", "--verify", "main"]).is_ok(), "the project's own branch is never the one deleted");

        let error = format!("{:#}", delete(p, &by_hand, false, git::DirectDelete::Allowed, true).unwrap_err());
        assert!(error.contains("wt-feature"), "{error}");
        assert!(by_hand.exists(), "a directory outside the worktree folder is never deleted directly");
    }
    fn commit(path: &Path, file: &str, text: &str) {
        std::fs::write(path.join(file), text).unwrap();
        sh(path, &["add", file]);
        sh(path, &["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", text]);
    }

    /// An actual local remote lets these tests exercise the fetch, not a mock
    /// of it, while remaining deterministic and independent of the network.
    fn remote_repo() -> (tempfile::TempDir, PathBuf, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let remote = dir.path().join("remote.git");
        sh(dir.path(), &["init", "--bare", "-q", "-b", "main", remote.to_str().unwrap()]);
        let project = dir.path().join("project");
        sh(dir.path(), &["clone", "-q", remote.to_str().unwrap(), project.to_str().unwrap()]);
        commit(&project, "file", "initial\n");
        sh(&project, &["push", "-q", "origin", "main"]);
        let wt = dir.path().join("external-feature");
        sh(&project, &["worktree", "add", "-qb", "feature", wt.to_str().unwrap()]);
        (dir, project, remote, wt)
    }

    #[test]
    fn verifies_merge_squash_and_rebase_against_a_fresh_default_branch() {
        let _home = crate::store::temp_home();
        for kind in ["merge", "squash", "rebase"] {
            let (_dir, project, _remote, wt) = remote_repo();
            commit(&wt, "file", "feature\n");
            commit(&wt, "second", "another change\n");
            // Make the default diverge, so rebase cannot simply fast-forward.
            commit(&project, "unrelated", "other work\n");
            if kind == "rebase" {
                let commits = git::run(&wt, &["rev-list", "--reverse", "main..HEAD"]).unwrap();
                for id in commits.lines() {
                    sh(&project, &["-c", "user.name=T", "-c", "user.email=t@t", "cherry-pick", id]);
                }
            } else {
                sh(&project, &["-c", "user.name=T", "-c", "user.email=t@t", "merge", if kind == "squash" { "--squash" } else { "--no-ff" }, "feature", "-m", "landed"]);
                if kind == "squash" { sh(&project, &["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-qm", "squashed"]); }
            }
            commit(&project, "later", "subsequent work\n");
            sh(&project, &["push", "-q", "origin", "main"]);
            // Deliberately stale tracking ref: disposition must fetch it again.
            let old = git::run(&project, &["rev-list", "--max-parents=0", "HEAD"]).unwrap();
            sh(&project, &["update-ref", "refs/remotes/origin/main", old.trim()]);
            let d = disposition(&project, &wt);
            assert_eq!(d.merged, Some(true), "{kind}: {d:?}");
            assert!(d.safe, "{kind}: {d:?}");
            // Reusing the same branch after landing must not inherit safety.
            commit(&wt, "not-landed", "new work\n");
            let d = disposition(&project, &wt);
            assert_eq!(d.merged, Some(false), "{kind}: {d:?}");
            assert!(!d.safe);
        }
    }

    #[test]
    fn pushed_is_not_merged_and_unsafe_removal_requires_a_second_confirmation() {
        let _home = crate::store::temp_home();
        let (_dir, project, _remote, wt) = remote_repo();
        commit(&wt, "file", "unmerged\n");
        sh(&wt, &["push", "-q", "origin", "feature"]);
        let d = disposition(&project, &wt);
        assert_eq!(d.pushed, Some(true));
        assert_eq!(d.merged, Some(false));
        assert_eq!(d.ahead_of_base, Some(1));
        assert!(delete(&project, &wt, true, git::DirectDelete::Allowed, false).is_err());
        assert!(wt.exists());
        delete(&project, &wt, true, git::DirectDelete::Allowed, true).unwrap();
        assert!(!wt.exists());
    }

    #[test]
    fn unreachable_remote_never_uses_stale_refs_as_proof() {
        let _home = crate::store::temp_home();
        let (_dir, project, remote, wt) = remote_repo();
        assert!(disposition(&project, &wt).safe);
        std::fs::remove_dir_all(remote).unwrap();
        let d = disposition(&project, &wt);
        assert!(!d.safe);
        assert_eq!(d.merged, None);
        assert!(d.verification_error.is_some());
        assert!(delete(&project, &wt, true, git::DirectDelete::Allowed, false).is_err());
        assert!(wt.exists());
    }

    #[test]
    fn checks_untracked_files_ignored_files_stashes_and_external_worktrees() {
        let _home = crate::store::temp_home();
        let (_dir, project, _remote, wt) = remote_repo();
        std::fs::write(wt.join(".gitignore"), "ignored\n").unwrap();
        std::fs::write(wt.join("ignored"), "ignored content").unwrap();
        std::fs::create_dir(wt.join("untracked")).unwrap();
        std::fs::write(wt.join("untracked/a"), "a").unwrap();
        std::fs::write(wt.join("untracked/b"), "b").unwrap();
        let d = disposition(&project, &wt);
        assert_eq!(d.uncommitted, 3);
        assert!(!d.safe);
        std::fs::remove_dir_all(wt.join("untracked")).unwrap();
        std::fs::remove_file(wt.join("ignored")).unwrap();
        std::fs::remove_file(wt.join(".gitignore")).unwrap();
        std::fs::write(wt.join("file"), "stash me").unwrap();
        sh(&wt, &["-c", "user.name=T", "-c", "user.email=t@t", "stash", "push", "-m", "save"]);
        let d = disposition(&project, &wt);
        assert_eq!(d.uncommitted, 0);
        assert_eq!(d.stashes, 1);
        assert!(!d.safe);
        let ws = list(&project).unwrap();
        let canonical = std::fs::canonicalize(&wt).unwrap();
        let external = ws.iter().find(|w| Path::new(&w.path) == canonical).unwrap();
        assert!(!external.managed);
        assert!(external.size_bytes > 0);
        sh(&wt, &["stash", "clear"]);
        delete(&project, &wt, true, git::DirectDelete::Allowed, false).unwrap();
        assert!(!wt.exists());
    }

    #[test]
    fn custom_merge_drivers_cannot_make_unmerged_work_look_landed() {
        let _home = crate::store::temp_home();
        let (_dir, project, _remote, wt) = remote_repo();
        commit(&project, ".gitattributes", "file merge=discard\n");
        sh(&wt, &["reset", "--hard", "main"]);
        commit(&wt, "file", "unmerged branch change\n");
        commit(&project, "file", "different default change\n");
        sh(&project, &["config", "merge.discard.driver", "true"]);
        sh(&project, &["push", "-q", "origin", "main"]);
        assert_eq!(disposition(&project, &wt).merged, Some(false));
    }

    #[test]
    fn rebased_patches_do_not_hide_new_work_in_a_merge_commit() {
        let _home = crate::store::temp_home();
        let (_dir, project, _remote, wt) = remote_repo();
        commit(&wt, "file", "feature\n");
        let feature = git::head_commit(&wt).unwrap();
        sh(&project, &["checkout", "-qb", "other"]);
        commit(&project, "other-file", "other\n");
        let other = git::head_commit(&project).unwrap();
        sh(&project, &["checkout", "main"]);
        commit(&project, "main-only", "main\n");
        for id in [&feature, &other] { sh(&project, &["-c", "user.name=T", "-c", "user.email=t@t", "cherry-pick", id]); }
        sh(&wt, &["-c", "user.name=T", "-c", "user.email=t@t", "merge", "--no-ff", "--no-commit", "other"]);
        commit(&wt, "merge-only", "work introduced by the merge\n");
        sh(&project, &["push", "-q", "origin", "main"]);
        let cherry = git::run(&wt, &["cherry", "origin/main", "HEAD"]).unwrap();
        assert!(cherry.lines().all(|line| line.starts_with('-')));
        assert_eq!(disposition(&project, &wt).merged, Some(false));
    }

}
