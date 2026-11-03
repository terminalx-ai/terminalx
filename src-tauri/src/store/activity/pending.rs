//! Work and PRs kept aside for the activity writer (#767): by a runtime while
//! another process holds the lease, and by the app or a command, which never
//! write history themselves. Each record is a file of its own, written whole
//! or not at all; the writer counts it once (`Snapshot::imported`), then
//! removes it.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

use super::{canonical_pr, ActivityEvent, PR};

const DIR: &str = "stats-activity-pending";

pub(super) struct Kept {
    /// The file's stem, which identifies the record.
    pub(super) name: String,
    pub(super) path: PathBuf,
    pub(super) event: ActivityEvent,
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

/// Keep one record for the writer.
pub(super) fn keep(root: &Path, event: &ActivityEvent) -> Result<()> {
    let dir = root.join(DIR);
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&dir).with_context(|| format!("create {}", dir.display()))?;
    crate::store::write_atomic(&path(root, event), &serde_json::to_vec(event)?)
        .context("keep activity aside for the runtime")
}

/// Keep a PR for the writer unless history or the inbox has it already.
pub(super) fn keep_pr(root: &Path, url: &str, at: i64) -> Result<()> {
    let event = ActivityEvent::pr(canonical_pr(url)?, at);
    if path(root, &event).exists()
        || super::published(root).ok().flatten().is_some_and(|data| data.prs.contains(&event.key))
    {
        return Ok(());
    }
    keep(root, &event)
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
        let event = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<ActivityEvent>(&bytes).map_err(anyhow::Error::from),
            // Counted and removed by the writer since it was listed.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => Err(error.into()),
        };
        match event {
            Ok(event) => inbox.kept.push(Kept { name, path, event }),
            Err(error) => inbox.unreadable.push(format!("{}: {error:#}", path.display())),
        }
    }
    inbox.kept.sort_by(|a, b| (a.event.at, &a.name).cmp(&(b.event.at, &b.name)));
    Ok(inbox)
}
