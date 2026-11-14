//! Preservation receipts bind cleanup to a run, session, branch and exact tip.
use std::path::{Path, PathBuf};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use super::{Run, RunState, SessionRef, store};
use crate::{git, orchestration_archive::{self, Preservation}};

#[derive(Serialize, Deserialize)]
struct Receipt {
    run: String,
    session: String,
    path: String,
    branch: Option<String>,
    preservation: Preservation,
}

fn receipt_path(session: &str) -> Result<PathBuf> {
    ensure!(session.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'), "Invalid worker id");
    Ok(crate::store::root()?.join("orchestration-archives").join(format!("{session}.json")))
}

pub fn preserve(run: &Run, worker: &SessionRef) -> Result<()> {
    let session = crate::store::index::get(&worker.session_id)?;
    ensure!(!session.worktree_removed && !crate::worktree_control::same_folder(&session.cwd, &run.project_path), "Worker no longer has its own checkout");
    let checkout = Path::new(&session.cwd);
    ensure!(git::is_worktree_of(Path::new(&run.project_path), checkout), "Worker checkout is unavailable or belongs to another repository");
    let (piece, attempt) = run.pieces.iter().find_map(|piece| {
        piece.tries.iter().position(|attempt| attempt.worker.as_ref().is_some_and(|w| w.session_id == worker.session_id))
            .map(|i| (piece.id.as_str(), i + 1))
            .or_else(|| (piece.tries.is_empty() && piece.worker.as_ref().is_some_and(|w| w.session_id == worker.session_id)).then_some((piece.id.as_str(), 1)))
    }).context("Worker is not a try of this run")?;
    let preservation = orchestration_archive::preserve_try(Path::new(&run.project_path), checkout, &run.id, piece, attempt.try_into()?)?;
    let receipt = Receipt { run: run.id.clone(), session: worker.session_id.clone(), path: session.cwd.clone(), branch: git::current_branch(checkout), preservation };
    let path = receipt_path(&worker.session_id)?;
    crate::store::ensure_dir(path.parent().unwrap().to_path_buf())?;
    crate::store::write_json(&path, &receipt)?;
    record_failure(run, worker, None)
}

/// Uses the recorded integration branch and final commit, so the lead's checkout
/// and even its session can already be gone. A reused branch/older PR cannot qualify.
pub fn merged_pr(run: &Run) -> Result<Option<crate::github::BranchPr>> {
    if run.state != RunState::Done { return Ok(None); }
    let Some(merge) = run.merge.as_ref() else { return Ok(None) };
    let Some(head) = merge.final_head.as_deref() else { return Ok(None) };
    if merge.into.is_empty() { return Ok(None); }
    let project = Path::new(&run.project_path);
    let prs = crate::github::branch_prs(project, std::slice::from_ref(&merge.into))?;
    let Some(pr) = prs.get(&merge.into).filter(|pr| pr.state == "MERGED" && pr.base != merge.into) else { return Ok(None) };
    ensure!(pr.head == head || git::run(project, &["--no-replace-objects", "merge-base", "--is-ancestor", head, &pr.head]).is_ok(),
        "Cannot confirm the merge: the recorded run tip is not known to be in the merged PR head (rebased, force-pushed, or not fetched). Nothing removed; fetch the PR history and retry, or inspect and remove the workspace explicitly");
    Ok(Some(pr.clone()))
}

pub fn owner(project: &Path, checkout: &Path) -> Option<(Run, SessionRef)> {
    let session = crate::store::index::load().ok()?.into_iter().find(|s| crate::worktree_control::same_folder(&s.cwd, &checkout.to_string_lossy()))?;
    store::list().ok()?.into_iter().rev().find_map(|run| {
        if !crate::worktree_control::same_folder(&run.project_path, &project.to_string_lossy()) || run.state != RunState::Done { return None; }
        let worker = run.superseded_workers().into_iter().find(|w| w.session_id == session.id)?.clone();
        Some((run, worker))
    })
}

/// Read-only proof: never pushes from a dry-run or a worktree inspection.
pub fn preserved(project: &Path, checkout: &Path, head: &str) -> bool {
    let Some((run, worker)) = owner(project, checkout) else { return false };
    let Ok(path) = receipt_path(&worker.session_id) else { return false };
    let Ok(Some(receipt)) = crate::store::read_json::<Receipt>(&path) else { return false };
    receipt.run == run.id && receipt.session == worker.session_id && crate::worktree_control::same_folder(&receipt.path, &checkout.to_string_lossy())
        && receipt.branch == git::current_branch(checkout) && receipt.preservation.head == head
        && orchestration_archive::verify_preservation(checkout, &receipt.preservation).is_ok()
}

pub fn landed(project: &Path, checkout: &Path, head: &str) -> bool {
    let Some((run, _)) = owner(project, checkout) else { return false };
    merged_pr(&run).ok().flatten().is_some() && preserved(project, checkout, head)
}


#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveFailure {
    pub head: Option<String>,
    pub reason: String,
}

pub fn recovered(worker: &SessionRef) -> bool {
    crate::store::index::get(&worker.session_id).is_ok_and(|s| s.archive.unarchived_at.is_some())
}

/// No network on an unchanged failed try. Manual cleanup calls preserve directly.
pub fn retry_allowed(run: &Run, worker: &SessionRef, head: &Option<String>) -> bool {
    !run.pieces.iter().flat_map(|p| &p.tries).any(|attempt|
        attempt.worker.as_ref().is_some_and(|w| w.session_id == worker.session_id)
        && attempt.archive_failure.as_ref().is_some_and(|failure| &failure.head == head))
}

pub fn record_failure(run: &Run, worker: &SessionRef, failure: Option<ArchiveFailure>) -> Result<()> {
    store::update(&run.id, |run| {
        for attempt in run.pieces.iter_mut().flat_map(|p| &mut p.tries) {
            if attempt.worker.as_ref().is_some_and(|w| w.session_id == worker.session_id) {
                attempt.archive_failure = failure.clone();
            }
        }
        Ok(())
    })?;
    Ok(())
}

/// Validate an existing receipt without fetching all remote objects again.
pub fn verify_saved(run: &Run, worker: &SessionRef) -> Result<()> {
    let session = crate::store::index::get(&worker.session_id)?;
    let receipt = crate::store::read_json::<Receipt>(&receipt_path(&worker.session_id)?)?
        .context("No preservation receipt; retry cleanup")?;
    let checkout = Path::new(&session.cwd);
    ensure!(receipt.run == run.id && receipt.session == worker.session_id
        && crate::worktree_control::same_folder(&receipt.path, &session.cwd)
        && git::is_worktree_of(Path::new(&run.project_path), checkout)
        && receipt.branch == git::current_branch(checkout), "Worker checkout changed; retry cleanup");
    orchestration_archive::verify_preservation(checkout, &receipt.preservation)
}
