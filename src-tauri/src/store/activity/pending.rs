//! Work and PRs kept aside for the activity writer (#767): by a runtime while
//! another process holds the lease, and by the app or a command, which never
//! write history themselves. Each record is a file of its own, written whole
//! or not at all; the writer counts it once (`Snapshot::imported`), then
//! removes it.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{canonical_pr, ActivityEvent, PR};

const DIR: &str = "stats-activity-pending";

pub(super) struct Kept {
    /// The file's stem, which identifies the record.
    pub(super) name: String,
    pub(super) path: PathBuf,
    pub(super) event: ActivityEvent,
    /// For work, when the runtime that kept it claimed history.
    pub(super) since: Option<i64>,
}

/// A record as it is written: the event, and for work kept by a runtime,
/// when that runtime claimed history. Everything it kept happened after
/// then, so a new history recovers the session logs only up to there.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    #[serde(flatten)]
    event: ActivityEvent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    since: Option<i64>,
}

pub(super) struct Inbox {
    pub(super) kept: Vec<Kept>,
    /// Records left in place because they could not be read.
    pub(super) unreadable: Vec<String>,
}

/// A PR is named by its identity, so finding it again replaces the record
/// instead of adding one; work is named by its own unique id.
fn name(event: &ActivityEvent) -> String {
    if event.kind == PR {
        let digest = Sha256::digest(event.key.as_bytes());
        format!("pr-{}", digest[..16].iter().map(|byte| format!("{byte:02x}")).collect::<String>())
    } else {
        event.id.clone()
    }
}

fn path(root: &Path, event: &ActivityEvent) -> PathBuf {
    root.join(DIR).join(format!("{}.json", name(event)))
}

/// Keep one record for the writer. While the folder cannot be written, every
/// record fails with the same message, which names the folder and the cause,
/// not the record's own file: one failure is logged once (`Owner::settle`).
pub(super) fn keep(root: &Path, event: &ActivityEvent, since: Option<i64>) -> Result<()> {
    let dir = root.join(DIR);
    let failed = |error: anyhow::Error| anyhow!("keep activity aside in {}: {}", dir.display(), error.root_cause());
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&dir).map_err(|error| failed(error.into()))?;
    let bytes = serde_json::to_vec(&Record { event: event.clone(), since })?;
    crate::store::write_atomic(&path(root, event), &bytes).map_err(failed)
}

/// Keep a PR for the writer unless history or the inbox has it already.
pub(super) fn keep_pr(root: &Path, url: &str, at: i64) -> Result<()> {
    let event = ActivityEvent::pr(canonical_pr(url)?, at);
    if path(root, &event).exists()
        || super::published(root).ok().flatten().is_some_and(|data| data.prs.contains(&event.key))
    {
        return Ok(());
    }
    keep(root, &event, None)
}

/// Everything kept aside, oldest first. A file still being written has a
/// temporary name (`write_atomic`) and is not listed until it is complete.
pub(super) fn list(root: &Path) -> Result<Inbox> {
    let dir = root.join(DIR);
    let mut inbox = Inbox { kept: Vec::new(), unreadable: Vec::new() };
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(inbox),
        Err(error) => return Err(error).with_context(|| format!("read {}", dir.display())),
    };
    for entry in entries {
        let path = entry.with_context(|| format!("read {}", dir.display()))?.path();
        if path.extension().is_none_or(|extension| extension != "json") {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|stem| stem.to_str()).map(String::from) else {
            continue;
        };
        let record = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Record>(&bytes).map_err(anyhow::Error::from),
            // Counted and removed by the writer since it was listed.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => Err(error.into()),
        };
        match record {
            Ok(Record { event, since }) => inbox.kept.push(Kept { name, path, event, since }),
            Err(error) => inbox.unreadable.push(format!("{}: {error:#}", path.display())),
        }
    }
    inbox.kept.sort_by(|a, b| (a.event.at, &a.name).cmp(&(b.event.at, &b.name)));
    Ok(inbox)
}
