//! Restore retained conversations only after their checkout is back on disk.
//! The preview is checked again by the process owner before anything is created.
use crate::{
    git,
    issue_pipeline::admission,
    sink::EventSink,
    store::index::{self, RemovedWorkspace, SessionEntry},
};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

pub(crate) fn removal_record(project: &Path, path: &Path) -> RemovedWorkspace {
    RemovedWorkspace {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        branch: git::current_branch(path),
        commit: git::head_commit(path),
        repository: Some(project.to_string_lossy().into_owned()),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub project_path: String,
    pub path: String,
    pub branch: Option<String>,
    pub commit: String,
    pub needs_branch: Option<String>,
    pub suggested_branch: String,
    pub legacy: bool,
    pub session_ids: Vec<String>,
}

fn branch_tip(project: &Path, branch: &str) -> Option<String> {
    git::run(project, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).ok().map(|tip| tip.trim().to_owned())
}

fn branch_available(project: &Path, branch: &str) -> Result<bool> {
    // Git also refuses a ref whose name is a parent/child of an existing ref.
    let refs = git::run(project, &["for-each-ref", "--format=%(refname:strip=2)", "refs/heads/"])?;
    Ok(!refs.lines().any(|name| name == branch || name.starts_with(&format!("{branch}/")) || branch.starts_with(&format!("{name}/"))))
}

fn valid_branch(project: &Path, branch: &str) -> Result<()> {
    if branch.starts_with('-') || branch == "HEAD" {
        bail!("Choose a valid new branch name.");
    }
    git::run(project, &["check-ref-format", &format!("refs/heads/{branch}")]).context("Choose a valid new branch name.")?;
    Ok(())
}

fn source(session: &SessionEntry) -> Result<&RemovedWorkspace> {
    if !session.worktree_removed {
        bail!("This session no longer has a removed workspace.");
    }
    session.removed_workspace.as_ref().context("This older session has no saved workspace path to restore.")
}

fn members(sessions: Vec<SessionEntry>, removed: &RemovedWorkspace, project: &str) -> Vec<SessionEntry> {
    sessions
        .into_iter()
        .filter(|session| {
            session.worktree_removed
                && session.removed_workspace.as_ref() == Some(removed)
                && removed.repository.as_deref().unwrap_or(&session.project_path) == project
        })
        .collect()
}

pub(crate) fn preview(session_id: &str) -> Result<Preview> {
    let session = index::get(session_id)?;
    let removed = source(&session)?;
    let project_path = removed.repository.as_deref().unwrap_or(&session.project_path);
    let project = std::fs::canonicalize(project_path).context("The original repository cannot be reached.")?;
    let top = git::run(&project, &["rev-parse", "--show-toplevel"]).context("The original project is no longer a Git checkout.")?;
    if std::fs::canonicalize(top.trim())? != project {
        bail!("The original project is no longer the repository root.");
    }
    let path = Path::new(&removed.path);
    if !path.is_absolute() || path.components().any(|part| matches!(part, Component::ParentDir) || part.as_os_str() == ".git") {
        bail!("The recorded workspace path is not a safe checkout path.");
    }
    let parent = std::fs::canonicalize(path.parent().context("The workspace has no parent folder.")?)
        .context("The workspace's parent folder is missing or unavailable. Recreate or mount it before restoring.")?;
    let target = parent.join(path.file_name().context("The workspace path has no folder name.")?);
    if target.components().any(|part| part.as_os_str() == ".git") {
        bail!("The workspace path is inside Git metadata.");
    }
    if project.starts_with(&target) {
        bail!("The workspace path would replace the project's checkout.");
    }
    match std::fs::symlink_metadata(&target) {
        Ok(_) => bail!("The workspace path is taken: {}. Move what is there before restoring.", target.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("The workspace path could not be checked."),
    }
    let worktrees = git::list_worktrees(&project)?;
    if worktrees.iter().any(|(path, _)| Path::new(path) == target) {
        bail!("Git still registers a worktree at this path. Repair or prune that missing worktree before restoring.");
    }
    let tip = removed.branch.as_deref().and_then(|branch| branch_tip(&project, branch));
    let commit = removed
        .commit
        .as_ref()
        .or(tip.as_ref())
        .context("No removal commit was recorded and the branch is gone. Its original commit cannot be recovered automatically.")?
        .clone();
    if !matches!(commit.len(), 40 | 64)
        || !commit.bytes().all(|byte| byte.is_ascii_hexdigit())
        || git::run(&project, &["cat-file", "-e", &format!("{commit}^{{commit}}")]).is_err()
    {
        bail!("The recorded commit is missing from the repository. Fetch or recover that commit before restoring.");
    }
    let needs_branch = match (&removed.branch, tip) {
        (None, _) => Some("The workspace had a detached HEAD. Restore its commit on a new branch.".into()),
        (Some(branch), None) => Some(format!("The branch {branch} was deleted. Restore the recorded commit on a new branch.")),
        (Some(branch), Some(tip)) if tip != commit => Some(format!("The branch {branch} moved since removal. Restore the recorded commit on a new branch.")),
        (Some(branch), _) if worktrees.iter().any(|(_, current)| current.as_ref() == Some(branch)) => {
            Some(format!("The branch {branch} is checked out elsewhere. Restore on a new branch."))
        }
        _ => None,
    };
    let base = removed.branch.as_deref().unwrap_or("restored-workspace");
    let base = if valid_branch(&project, base).is_ok() { base } else { "restored-workspace" };
    let mut suggested_branch = format!("{base}-restored");
    for number in 2.. {
        if branch_available(&project, &suggested_branch)? {
            break;
        }
        suggested_branch = format!("{base}-restored-{number}");
    }
    let mut session_ids: Vec<_> = members(index::load()?, removed, project_path).into_iter().map(|entry| entry.id).collect();
    session_ids.sort();
    Ok(Preview {
        project_path: project.to_string_lossy().into_owned(),
        path: target.to_string_lossy().into_owned(),
        branch: removed.branch.clone(),
        commit,
        needs_branch,
        suggested_branch,
        legacy: removed.commit.is_none(),
        session_ids,
    })
}

/// Only resources this attempt reserved are rolled back. A compare-and-delete
/// protects a newly created branch from an external Git process moving it.
struct Checkout {
    project: PathBuf,
    path: PathBuf,
    created_branch: Option<String>,
    commit: String,
}

impl Checkout {
    fn rollback(&self) -> Result<()> {
        if git::list_worktrees(&self.project)?.iter().any(|(path, _)| Path::new(path) == self.path) {
            git::run(&self.project, &["worktree", "remove", "--force", "--", &self.path.to_string_lossy()])?;
        } else if self.path.exists() {
            // Git can leave the empty directory reserved before `worktree add`.
            std::fs::remove_dir(&self.path)?;
        }
        if let Some(branch) = &self.created_branch {
            if git::list_worktrees(&self.project)?.iter().any(|(_, current)| current.as_ref() == Some(branch)) {
                bail!("The new branch is now checked out elsewhere and was kept.");
            }
            git::run(&self.project, &["update-ref", "-d", &format!("refs/heads/{branch}"), &self.commit])?;
        }
        Ok(())
    }
}

pub(crate) fn restore(
    sink: &dyn EventSink,
    session_id: &str,
    expected: &Preview,
    new_branch: Option<&str>,
    stop: &dyn Fn(&SessionEntry) -> Result<()>,
) -> Result<Vec<SessionEntry>> {
    restore_with(sink, session_id, expected, new_branch, stop, &restore_sessions)
}

fn restore_sessions(expected: &Preview, removed: &RemovedWorkspace, branch: &str) -> Result<Vec<SessionEntry>> {
    index::update(|sessions| {
        let mut moved = Vec::new();
        for id in &expected.session_ids {
            let session = sessions.iter_mut().find(|entry| &entry.id == id).context("A conversation disappeared during restoration.")?;
            if !session.worktree_removed || session.removed_workspace.as_ref() != Some(removed) {
                bail!("A conversation moved during restoration. Nothing was restored.");
            }
            session.cwd = expected.path.clone();
            session.worktree_name = Some(removed.name.clone());
            session.branch = Some(branch.into());
            session.worktree_removed = false;
            session.removed_workspace = None;
            session.base_ref = None;
            session.modified = index::now();
            crate::session_archive::mark(session, false, crate::session_archive::By::Person, &index::now());
            for tab in &mut session.tabs {
                tab.status = index::TabStatus::Idle;
                tab.lose_pane();
            }
            moved.push(session.clone());
        }
        Ok(moved)
    })
}

type CommitSessions<'a> = &'a dyn Fn(&Preview, &RemovedWorkspace, &str) -> Result<Vec<SessionEntry>>;

fn restore_with(
    sink: &dyn EventSink,
    session_id: &str,
    expected: &Preview,
    new_branch: Option<&str>,
    stop: &dyn Fn(&SessionEntry) -> Result<()>,
    commit_sessions: CommitSessions<'_>,
) -> Result<Vec<SessionEntry>> {
    // This also serializes restores with the automatic merged-cleanup sweep.
    crate::merged_cleanup::with_workspace_restore(&expected.path, &expected.project_path, &expected.commit, || {
        let _moving = admission::fence(
            admission::Kind::Refuse(admission::SESSION_MOVED),
            expected.session_ids.iter().cloned().map(admission::Scope::Session).chain([admission::Scope::checkout(Path::new(&expected.path))]),
        );
        if preview(session_id)? != *expected {
            bail!("The workspace changed since it was checked. Review it again before restoring.");
        }
        let session = index::get(session_id)?;
        let removed = source(&session)?.clone();
        let project = Path::new(&expected.project_path);
        let branch = match new_branch {
            Some(branch) => {
                valid_branch(project, branch)?;
                if !branch_available(project, branch)? {
                    bail!("The new branch name is already taken. Choose another name.");
                }
                branch
            }
            None if expected.needs_branch.is_some() => bail!("Choose a new branch to restore the recorded commit."),
            None => expected.branch.as_deref().context("Choose a new branch.")?,
        };
        for id in &expected.session_ids {
            stop(&index::get(id)?)?;
        }
        if preview(session_id)? != *expected {
            bail!("The workspace changed while its tabs were stopped. Review it again before restoring.");
        }
        let mut checkout = Checkout { project: project.to_owned(), path: expected.path.clone().into(), created_branch: None, commit: expected.commit.clone() };
        std::fs::create_dir(&checkout.path).context("The workspace path could not be reserved. Nothing was restored.")?;
        let result = (|| {
            if new_branch.is_some() {
                // Empty old value means the ref must not exist. Do not delete a
                // branch that another process won the race to create.
                git::run(project, &["update-ref", &format!("refs/heads/{branch}"), &expected.commit, ""])?;
                checkout.created_branch = Some(branch.into());
            }
            // Restoring files must not execute a repository's checkout hook.
            git::run(project, &["-c", "core.hooksPath=/dev/null", "worktree", "add", "--", &expected.path, branch])?;
            if git::head_commit(&checkout.path).as_deref() != Some(&expected.commit) || git::current_branch(&checkout.path).as_deref() != Some(branch) {
                bail!("The branch moved during restoration. Nothing was restored; review it again.");
            }
            commit_sessions(expected, &removed, branch)
        })();
        match result {
            Ok(moved) => {
                crate::session_ops::notify_workspace_settled(sink, &expected.project_path, &moved);
                Ok(moved)
            }
            Err(error) => {
                checkout.rollback().with_context(|| format!("Restore failed ({error:#}); its checkout could not be fully rolled back"))?;
                Err(error)
            }
        }
    })
}

#[cfg(test)]
mod tests;
