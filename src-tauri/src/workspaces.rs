//! Workspaces: every checkout a project has, whoever made it. The project
//! root, the worktrees Raccoon created, and worktrees the reader made by
//! hand all show up the same way, each with what it has going on: uncommitted
//! lines, commits nothing else knows about, and the pull request its branch
//! is on. Sessions attach to a workspace by their working directory.

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
    /// Clean, uncommitted, unmerged or merged, as known locally (no fetch).
    pub state: crate::landed::State,
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
            uncommitted: 0, additions: 0, deletions: 0, unpushed: 0, ahead: 0, behind: 0,
            state: crate::landed::State::Unknown,
        }]);
    }
    let managed_root = git::worktree_root(project);
    let managed_root = std::fs::canonicalize(&managed_root).unwrap_or(managed_root);
    let mut out = Vec::new();
    let entries = git::list_worktrees(project)?;
    // Read once for the project, not once per worktree.
    let context = crate::landed::list_context(&root);
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
        let changed = uncommitted(&p);
        // The project's own checkout is never removed, so only whether it
        // has uncommitted work is worth a word.
        let head = git::head_commit(&p);
        let state = if is_main {
            if changed > 0 { crate::landed::State::Uncommitted } else { crate::landed::State::Clean }
        } else {
            crate::landed::state_in_list(&context, &p, branch.as_deref(), head.as_deref(), changed)
        };
        out.push(Workspace {
            name: if is_main {
                crate::store::projects::project_name(&root.to_string_lossy())
            } else {
                p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone())
            },
            path: p.to_string_lossy().into_owned(),
            head,
            unpushed: unpushed(&p, branch.as_deref()),
            ahead,
            behind,
            branch,
            is_main,
            managed,
            state,
            uncommitted: changed,
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
    /// Their ids, in the same order: what the removal is told to expect.
    pub session_ids: Vec<String>,
    /// Whether the work here is clean and merged into the default branch.
    /// Filled in by the command layer: it fetches, so it is not part of the
    /// quick read every listing does.
    pub landed: Option<crate::landed::Landed>,
}

pub fn disposition(project: &Path, path: &Path) -> WorkspaceDisposition {
    if !path.exists() {
        return WorkspaceDisposition::default();
    }
    let root = std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    let p = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if !git::is_worktree_of(project, &p) {
        // Git would answer for another repository here: the enclosing
        // project (and report nothing), or a clone that sits at this path.
        return WorkspaceDisposition { exists: true, checked: false, is_main: p == root, ..Default::default() };
    }
    let branch = git::current_branch(&p);
    let status = git::work_status(&p);
    let mut d = WorkspaceDisposition {
        exists: true,
        checked: true,
        is_main: p == root,
        uncommitted: uncommitted(&p),
        unpushed: unpushed(&p, branch.as_deref()),
        ahead_of_base: status.ahead_of_base,
        branch: branch.clone(),
        pr: None,
        pr_checked: false,
        sessions: 0,
        session_titles: Vec::new(),
        session_ids: Vec::new(),
        landed: None,
    };
    if let Some(b) = branch.as_deref() {
        if git::remote_url(&p).is_some() && crate::github::available() {
            if let Ok(prs) = crate::github::prs_for_branch(&p, b) {
                d.pr_checked = true;
                d.pr = prs.into_iter().next().map(|pr| WorkspacePr { number: pr.number, title: pr.title, url: pr.url, state: pr.state, is_draft: pr.is_draft });
            }
        }
    }
    d
}

/// What a workspace takes on disk, for the list. Only a checkout of this
/// project is measured: its root or one of its worktrees. Symlinks are
/// counted as links and never followed.
pub fn size(project: &Path, path: &Path) -> Result<u64> {
    let target = std::fs::canonicalize(path)?;
    let known = git::list_worktrees(project)?.into_iter().any(|(worktree, _)| std::fs::canonicalize(worktree).is_ok_and(|p| p == target));
    if !known {
        anyhow::bail!("{} is not a workspace of this project", path.display());
    }
    Ok(git::size_on_disk(&target))
}

/// How a worktree is removed.
#[derive(Debug, Clone, Copy)]
pub struct DeleteOptions<'a> {
    /// Delete the branch the worktree is on, when that loses nothing.
    pub delete_branch: bool,
    /// Whether a directory git cannot remove may be deleted directly.
    pub direct: git::DirectDelete,
    /// The clean-and-merged check found the worktree safe a moment ago, with
    /// HEAD at this commit: nothing uncommitted, and everything up to it in
    /// the default branch. Only then is the worktree removed without
    /// `--force` (so git itself refuses if a file appeared since) and its
    /// branch deleted although its commits are in the default branch only
    /// as a squash; and the branch is deleted only while it is still at
    /// this commit, so one made in between is never dropped.
    pub verified_head: Option<&'a str>,
}

/// Remove a worktree that is not the project root, and its branch if asked.
///
/// When git cannot remove it and `direct` allows, a worktree Raccoon made is
/// deleted directly behind [`git::remove_managed_worktree_dir`]'s guard; one
/// made by hand elsewhere stays git's to remove.
///
/// A branch that holds commits no other branch, remote or tag has is never
/// deleted here, whatever was confirmed, unless the check verified its work
/// as merged. It is kept and named in the result, so the commits can still
/// be reached.
pub fn delete(project: &Path, path: &Path, options: DeleteOptions<'_>) -> Result<git::WorktreeRemoval> {
    let root = std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    let p = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if p == root {
        anyhow::bail!("the project's own checkout cannot be deleted from here");
    }
    let mut removal = git::WorktreeRemoval::default();
    // Asked of a directory that is not a working tree of this project, git
    // would name some other repository's branch.
    let branch = git::is_worktree_of(project, &p).then(|| git::current_branch(&p)).flatten();
    let detached = git::detached_head(project, &p);
    let target = p.to_str().unwrap_or_default();
    let _ = git::run(project, &["worktree", "unlock", target]);
    let verified = options.verified_head.is_some();
    // Where each branch stands now, so it is deleted there or not at all.
    let tip = |branch: &str| git::run(project, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).ok().map(|sha| sha.trim().to_string());
    let branch_tip = branch.as_deref().and_then(tip);
    let removed = if verified {
        // No `--force`: if anything was written since the check, git says so
        // and nothing is removed.
        git::run(project, &["worktree", "remove", target])
    } else {
        git::run(project, &["worktree", "remove", "--force", target])
    };
    if let Err(git_error) = removed {
        if verified {
            anyhow::bail!("Could not remove the worktree at {}: {git_error:#}. It was found clean and merged a moment ago; if something changed in it, check it again. {}", p.display(), git::leftover_state(&p));
        }
        if options.direct == git::DirectDelete::Never {
            anyhow::bail!("Could not remove the worktree at {}: {git_error:#}. {}", p.display(), git::leftover_state(&p));
        }
        if let (Some(commit), Some(name)) = (&detached, p.file_name().and_then(|name| name.to_str())) {
            removal.rescued_branch = git::rescue_detached(project, name, commit);
        }
        if let Err(direct_error) = git::remove_managed_worktree_dir(project, &p) {
            anyhow::bail!("Could not remove the worktree at {}: {direct_error:#} ({git_error:#}). {}", p.display(), git::leftover_state(&p));
        }
    }
    let _ = git::run(project, &["worktree", "prune"]);
    if let Some(b) = branch {
        // The commit the branch may be deleted at: the one the check
        // verified, or the one found to hold nothing of its own.
        let at = match options.verified_head {
            Some(head) => Some(head.to_string()),
            None => branch_tip.filter(|_| git::unique_commits(project, &b) == Some(0)),
        };
        match at {
            Some(at) if options.delete_branch => {
                // `update-ref -d <ref> <old>` deletes only if the branch is
                // still at that commit.
                if git::run(project, &["update-ref", "-d", &format!("refs/heads/{b}"), &at]).is_err() {
                    removal.kept_branch = Some(b);
                }
            }
            Some(_) => {}
            None => removal.kept_branch = Some(b),
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
        assert_eq!(f.state, crate::landed::State::Uncommitted);
        // The worktree was made inside the project here, so the project's
        // own checkout sees it as an untracked folder.
        assert_eq!(ws[0].state, crate::landed::State::Uncommitted);
        let d = disposition(p, &wt);
        assert_eq!(d.uncommitted, 1);
        assert!(!d.is_main);
        delete(p, &wt, DeleteOptions { delete_branch: true, direct: git::DirectDelete::Allowed, verified_head: None }).unwrap();
        assert_eq!(list(p).unwrap().len(), 1);
        assert!(delete(p, p, DeleteOptions { delete_branch: false, direct: git::DirectDelete::Allowed, verified_head: None }).is_err());
    }

    #[test]
    fn size_is_measured_only_for_this_projects_workspaces() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("project");
        std::fs::create_dir_all(&p).unwrap();
        sh(&p, &["init", "-q", "-b", "main"]);
        sh(&p, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
        let wt = dir.path().join("wt-feature");
        sh(&p, &["worktree", "add", "-q", "-b", "feature", wt.to_str().unwrap()]);
        std::fs::write(wt.join("big.bin"), vec![1u8; 300 * 1024]).unwrap();
        // A link out of the workspace is counted as a link, not followed.
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("huge.bin"), vec![1u8; 4 * 1024 * 1024]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, wt.join("link")).unwrap();

        let bytes = size(&p, &wt).unwrap();
        assert!((300 * 1024..2 * 1024 * 1024).contains(&bytes), "{bytes}");
        assert!(size(&p, &outside).is_err(), "not one of this project's workspaces");
        assert!(size(&p, dir.path()).is_err());
    }

    #[test]
    fn a_branch_with_commits_of_its_own_is_kept_whatever_was_confirmed() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        sh(p, &["init", "-q", "-b", "main"]);
        sh(p, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]);
        let wt = p.join("wt-feature");
        let has_branch = || git::run(p, &["rev-parse", "--verify", "--quiet", "refs/heads/feature"]).is_ok();
        // Confirmed or not, directly deletable or not: the only copy of a commit stays reachable.
        for direct in [git::DirectDelete::Never, git::DirectDelete::Allowed] {
            sh(p, &["worktree", "add", "-q", "-B", "feature", wt.to_str().unwrap()]);
            sh(&wt, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "only here"]);
            let removal = delete(p, &wt, DeleteOptions { delete_branch: true, direct, verified_head: None }).unwrap();
            assert!(!wt.exists());
            assert_eq!(removal.kept_branch.as_deref(), Some("feature"));
            assert!(has_branch());
        }
        // When the check verified the work as merged, the branch goes.
        sh(p, &["worktree", "add", "-q", "-B", "feature", wt.to_str().unwrap()]);
        let head = git::run(&wt, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        let removal = delete(p, &wt, DeleteOptions { delete_branch: true, direct: git::DirectDelete::Never, verified_head: Some(&head) }).unwrap();
        assert_eq!(removal.kept_branch, None);
        assert!(!has_branch());

        // Verified at one commit, but the branch has moved on since: the
        // commit made in between is not dropped.
        sh(p, &["worktree", "add", "-q", "-B", "feature", wt.to_str().unwrap(), "main"]);
        let checked = git::run(&wt, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        sh(&wt, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "made in between"]);
        let later = git::run(&wt, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        let removal = delete(p, &wt, DeleteOptions { delete_branch: true, direct: git::DirectDelete::Never, verified_head: Some(&checked) }).unwrap();
        assert_eq!(removal.kept_branch.as_deref(), Some("feature"));
        assert_eq!(git::run(p, &["rev-parse", "feature"]).unwrap().trim(), later);
        sh(p, &["branch", "-q", "-D", "feature"]);
        // A branch with nothing of its own goes when asked, and stays when not.
        sh(p, &["worktree", "add", "-q", "-B", "feature", wt.to_str().unwrap(), "main"]);
        let removal = delete(p, &wt, DeleteOptions { delete_branch: false, direct: git::DirectDelete::Never, verified_head: None }).unwrap();
        assert_eq!(removal.kept_branch, None);
        assert!(has_branch());
    }

    #[test]
    fn a_verified_removal_does_not_force_and_stops_at_a_file_written_since() {
        let _home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("project");
        std::fs::create_dir_all(&p).unwrap();
        sh(&p, &["init", "-q", "-b", "main"]);
        std::fs::write(p.join(".gitignore"), "target/\n").unwrap();
        sh(&p, &["add", "."]);
        sh(&p, &["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
        let wt = dir.path().join("wt-feature");
        sh(&p, &["worktree", "add", "-q", "-b", "feature", wt.to_str().unwrap()]);
        let head = git::run(&wt, &["rev-parse", "HEAD"]).unwrap().trim().to_string();
        let verified = DeleteOptions { delete_branch: true, direct: git::DirectDelete::Never, verified_head: Some(&head) };

        // Written after the check said "clean": git refuses, nothing goes.
        std::fs::write(wt.join("written-since.txt"), "new work").unwrap();
        let error = format!("{:#}", delete(&p, &wt, verified).unwrap_err());
        assert!(error.contains("wt-feature"), "{error}");
        assert!(wt.join("written-since.txt").exists());
        assert!(git::run(&p, &["rev-parse", "--verify", "--quiet", "refs/heads/feature"]).is_ok());

        // Ignored build output is not unsaved work and does not stop it.
        std::fs::remove_file(wt.join("written-since.txt")).unwrap();
        std::fs::create_dir_all(wt.join("target")).unwrap();
        std::fs::write(wt.join("target/out.bin"), "x").unwrap();
        delete(&p, &wt, verified).unwrap();
        assert!(!wt.exists());
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
        assert!(delete(p, Path::new(&managed.path), DeleteOptions { delete_branch: true, direct: git::DirectDelete::Never, verified_head: None }).is_err());
        assert!(Path::new(&managed.path).exists());

        delete(p, Path::new(&managed.path), DeleteOptions { delete_branch: true, direct: git::DirectDelete::Allowed, verified_head: None }).unwrap();
        assert!(!Path::new(&managed.path).exists());
        assert!(git::run(p, &["rev-parse", "--verify", "main"]).is_ok(), "the project's own branch is never the one deleted");

        let error = format!("{:#}", delete(p, &by_hand, DeleteOptions { delete_branch: false, direct: git::DirectDelete::Allowed, verified_head: None }).unwrap_err());
        assert!(error.contains("wt-feature"), "{error}");
        assert!(by_hand.exists(), "a directory outside the worktree folder is never deleted directly");
    }
}
