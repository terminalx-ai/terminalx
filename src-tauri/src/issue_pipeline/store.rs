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
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::{Pipeline, State};

/// Finished pipelines kept for the record; ones still in flight are never dropped.
const RETENTION: usize = 200;
static WRITE_LOCK: Mutex<()> = Mutex::new(());
/// When each pipeline waiting on GitHub began to wait, as of the last read or write.
static WAITING: Mutex<Vec<DateTime<Utc>>> = Mutex::new(Vec::new());

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
    let pipelines = crate::store::read_json::<PipelineFile>(&file_path()?)?.unwrap_or_default().pipelines;
    note_waiting(&pipelines);
    Ok(pipelines)
}

fn note_waiting(pipelines: &[Pipeline]) {
    let since = pipelines.iter().filter(|pipeline| !pipeline.stopped && pipeline.state == State::Waiting).filter_map(waiting_since).collect();
    *WAITING.lock().unwrap_or_else(|error| error.into_inner()) = since;
}

/// When a pipeline began to wait on GitHub: for its checks, for a merge
/// GitHub took into a queue, or for a new head's checks to be listed. What
/// bounds the wait, whether or not GitHub can be read meanwhile.
pub fn waiting_since(pipeline: &Pipeline) -> Option<DateTime<Utc>> {
    let request = pipeline.merge_requested.as_ref().map(|request| request.at.as_str());
    [pipeline.waiting_since.as_deref(), request, pipeline.review_requested_at.as_deref(), Some(pipeline.modified.as_str())]
        .into_iter()
        .flatten()
        .find_map(|at| DateTime::parse_from_rfc3339(at).ok())
        .map(|at| at.with_timezone(&Utc))
}

/// When each pipeline waiting on GitHub (checks, mergeability, a merge
/// queue) began to wait.
pub fn waits() -> Vec<DateTime<Utc>> {
    WAITING.lock().unwrap_or_else(|error| error.into_inner()).clone()
}

fn write(pipelines: Vec<Pipeline>) -> Result<()> {
    crate::store::write_json(&file_path()?, &PipelineFile { pipelines })?;
    Ok(())
}

pub fn get(id: &str) -> Result<Pipeline> {
    list()?.into_iter().find(|pipeline| pipeline.id == id).ok_or_else(|| anyhow!("issue pipeline {id} not found"))
}

fn update<R>(change: impl FnOnce(&mut Vec<Pipeline>) -> Result<R>) -> Result<R> {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut pipelines = list()?;
    let out = change(&mut pipelines)?;
    note_waiting(&pipelines);
    write(pipelines)?;
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
    note_waiting(&pipelines);
    write(pipelines)?;
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

/// Whether a tab is the author or the reviewer of some pipeline. Asked on
/// every turn that ends anywhere, so it reads the store and nothing else.
pub fn takes_part(session_id: &str, tab_id: &str) -> bool {
    for_session(session_id).ok().flatten().is_some_and(|pipeline| pipeline.role_of(session_id, tab_id).is_some())
}
