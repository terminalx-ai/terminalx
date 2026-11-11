//! The runs on disk: one JSON file, rewritten whole, as the issue pipelines are.
//!
//! Every change goes through [`update`], which reads the stored run under the
//! write lock and hands it to the change, so two writers (a worker's turn
//! ending while the lead calls `runs start`) never work on the same stale copy.

use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use super::Run;

/// Ended runs kept for the record; one still in flight is never dropped.
const RETENTION: usize = 100;
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunFile {
    #[serde(default)]
    runs: Vec<Run>,
}

fn file_path() -> Result<PathBuf> {
    Ok(crate::store::root()?.join("orchestration-runs.json"))
}

/// Every run, oldest first.
pub fn list() -> Result<Vec<Run>> {
    Ok(crate::store::read_json::<RunFile>(&file_path()?)?.unwrap_or_default().runs)
}

pub fn get(id: &str) -> Result<Run> {
    list()?.into_iter().find(|run| run.id == id).ok_or_else(|| anyhow!("run {id} not found"))
}

/// The runs whose id is `selector` or begins with it.
pub fn matching(selector: &str) -> Result<Vec<Run>> {
    let runs = list()?;
    if let Some(exact) = runs.iter().find(|run| run.id == selector) {
        return Ok(vec![exact.clone()]);
    }
    Ok(runs.into_iter().filter(|run| run.id.starts_with(selector)).collect())
}

/// The run a session leads that has not ended: a lead has one at a time.
pub fn open_for_lead(session_id: &str) -> Result<Option<Run>> {
    Ok(list()?.into_iter().rev().find(|run| run.lead.session_id == session_id && !run.state.ended()))
}

/// The newest run a session leads, ended or not: what its Run view shows.
pub fn for_lead(session_id: &str) -> Result<Option<Run>> {
    Ok(list()?.into_iter().rev().find(|run| run.lead.session_id == session_id))
}

/// The run a session works for as a piece's worker, and that piece's id.
pub fn for_worker(session_id: &str) -> Result<Option<(Run, String)>> {
    Ok(list()?.into_iter().rev().find_map(|run| {
        let piece = run.pieces.iter().find(|piece| piece.worker.as_ref().is_some_and(|worker| worker.session_id == session_id))?.id.clone();
        Some((run, piece))
    }))
}

/// Whether a tab is a verifier of some piece's result (`verify`): a
/// conversation in the worker's worktree that reads and never edits.
pub fn is_verifier(session_id: &str, tab_id: &str) -> Result<bool> {
    Ok(list()?.iter().flat_map(|run| &run.pieces).flat_map(|piece| &piece.tries).filter_map(|attempt| attempt.verification.as_ref()?.review.as_ref()).flat_map(|review| &review.verifiers).filter_map(|verifier| verifier.session.as_ref()).any(|verifier| verifier.session_id == session_id && verifier.tab_id.as_deref() == Some(tab_id)))
}

pub fn insert(run: &Run) -> Result<()> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut runs = list()?;
    runs.push(run.clone());
    let mut over = runs.iter().filter(|run| run.state.ended()).count().saturating_sub(RETENTION);
    runs.retain(|run| {
        let drop = over > 0 && run.state.ended();
        over -= usize::from(drop);
        !drop
    });
    crate::store::write_json(&file_path()?, &RunFile { runs })
}

/// Change the stored run. `change` is given the run as it is stored now;
/// what it returns comes back with the run as written. Nothing is written,
/// and `modified` stays, when the change leaves the run as it was.
pub fn update<R>(id: &str, change: impl FnOnce(&mut Run) -> Result<R>) -> Result<(Run, R)> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut runs = list()?;
    let stored = runs.iter_mut().find(|run| run.id == id).ok_or_else(|| anyhow!("run {id} not found"))?;
    let before = stored.clone();
    let out = change(stored)?;
    if *stored == before {
        return Ok((before, out));
    }
    stored.modified = crate::store::index::now();
    let run = stored.clone();
    crate::store::write_json(&file_path()?, &RunFile { runs })?;
    Ok((run, out))
}
