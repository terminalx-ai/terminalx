//! The pipelines on disk: one JSON file, rewritten whole.
//!
//! Two kinds of writer share it. A stage step works on a copy for as long as
//! its network calls take and commits the result; the switches a reader flips
//! (merge automatically, stop) are written at once, without waiting for a
//! step. So a commit never writes the switches: it takes whatever is stored,
//! and a step about to merge reads them again first.

use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use super::{Pipeline, State};

/// Finished pipelines kept for the record; ones still in flight are never dropped.
const RETENTION: usize = 200;
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PipelineFile {
    #[serde(default)]
    pipelines: Vec<Pipeline>,
}

fn file_path() -> Result<PathBuf> {
    Ok(crate::store::root()?.join("issue-pipelines.json"))
}

pub fn list() -> Result<Vec<Pipeline>> {
    Ok(crate::store::read_json::<PipelineFile>(&file_path()?)?.unwrap_or_default().pipelines)
}

pub fn get(id: &str) -> Result<Pipeline> {
    list()?.into_iter().find(|pipeline| pipeline.id == id).ok_or_else(|| anyhow!("issue pipeline {id} not found"))
}

fn update<R>(change: impl FnOnce(&mut Vec<Pipeline>) -> Result<R>) -> Result<R> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut pipelines = list()?;
    let out = change(&mut pipelines)?;
    crate::store::write_json(&file_path()?, &PipelineFile { pipelines })?;
    Ok(out)
}

fn finished(pipeline: &Pipeline) -> bool {
    pipeline.stopped || pipeline.state == State::Merged
}

pub fn insert(pipeline: &Pipeline) -> Result<()> {
    update(|pipelines| {
        pipelines.push(pipeline.clone());
        let mut over = pipelines.iter().filter(|pipeline| finished(pipeline)).count().saturating_sub(RETENTION);
        pipelines.retain(|pipeline| {
            let drop = over > 0 && finished(pipeline);
            over -= usize::from(drop);
            !drop
        });
        Ok(())
    })
}

/// Commit a step's working copy. The switches are the stored ones: `working`
/// is brought up to date with them and left as written. `false` when the
/// step changed nothing, and then nothing is written either.
pub fn commit(working: &mut Pipeline) -> Result<bool> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut pipelines = list()?;
    let stored = pipelines.iter_mut().find(|pipeline| pipeline.id == working.id).ok_or_else(|| anyhow!("issue pipeline {} not found", working.id))?;
    working.auto_merge = stored.auto_merge;
    working.stopped = stored.stopped;
    working.modified = stored.modified.clone();
    if *stored == *working {
        return Ok(false);
    }
    working.modified = crate::store::index::now();
    *stored = working.clone();
    crate::store::write_json(&file_path()?, &PipelineFile { pipelines })?;
    Ok(true)
}

/// Flip a switch now, whatever step is running.
pub fn set_switches(id: &str, change: impl FnOnce(&mut Pipeline)) -> Result<Pipeline> {
    update(|pipelines| {
        let stored = pipelines.iter_mut().find(|pipeline| pipeline.id == id).ok_or_else(|| anyhow!("issue pipeline {id} not found"))?;
        let (stage, state) = (stored.stage, stored.state);
        change(stored);
        // Only the switches: a step in flight owns everything else.
        debug_assert!(stored.stage == stage && stored.state == state);
        stored.modified = crate::store::index::now();
        Ok(stored.clone())
    })
}

/// The pipeline a session takes part in, as its author or its reviewer.
/// The newest one, for a session whose earlier pipeline was replaced.
pub fn for_session(session_id: &str) -> Result<Option<Pipeline>> {
    Ok(list()?.into_iter().rev().find(|pipeline| pipeline.author.session_id == session_id || pipeline.reviewer.as_ref().is_some_and(|reviewer| reviewer.session_id == session_id)))
}
