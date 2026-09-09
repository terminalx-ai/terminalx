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
            uncommitted: uncommitted(&p),
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
}

pub fn disposition(project: &Path, path: &Path) -> WorkspaceDisposition {
    if !path.exists() {
        return WorkspaceDisposition::default();
    }
    let root = std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    let p = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let branch = git::current_branch(&p);
    let status = git::work_status(&p);
    let mut d = WorkspaceDisposition {
        exists: true,
        is_main: p == root,
        uncommitted: uncommitted(&p),
        unpushed: unpushed(&p, branch.as_deref()),
        ahead_of_base: status.ahead_of_base,
        branch: branch.clone(),
        pr: None,
        pr_checked: false,
        sessions: 0,
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

/// Remove a worktree that is not the project root, and its branch if asked.
pub fn delete(project: &Path, path: &Path, delete_branch: bool) -> Result<()> {
    let root = std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    let p = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    if p == root {
        anyhow::bail!("the project's own checkout cannot be deleted from here");
    }
    let branch = git::current_branch(&p);
    let _ = git::run(project, &["worktree", "unlock", p.to_str().unwrap_or_default()]);
    git::run(project, &["worktree", "remove", "--force", p.to_str().unwrap_or_default()])?;
    let _ = git::run(project, &["worktree", "prune"]);
    if delete_branch {
        if let Some(b) = branch {
            let _ = git::run(project, &["branch", "-D", &b]);
        }
    }
    Ok(())
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
        delete(p, &wt, true).unwrap();
        assert_eq!(list(p).unwrap().len(), 1);
        assert!(delete(p, p, false).is_err());
    }
}
