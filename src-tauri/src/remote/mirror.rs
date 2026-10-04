//! `mirror/1` on the runtime (PRO-25, docs/CLOUD-MIRROR.md): the list of
//! files a desktop may copy into its local mirror of this workspace.
//!
//! The runtime only lists. The desktop reads each file with `fs.read` and
//! writes it into a directory of its own; nothing here knows where that is,
//! and no method takes a path outside the workspace.
//!
//! The file set is Git's: for every repository in the workspace,
//! `git ls-files --cached --others --exclude-standard`, so tracked files and
//! untracked files Git does not ignore. A workspace with no repository has
//! nothing to mirror. Left out, and counted in `skipped` by reason:
//!
//! - `secret`: credential and key files by name ([`crate::mirror_rules`]);
//! - `excluded`: the repository's own `.terminalx-mirror-ignore`;
//! - `symlink`, `unsupported`: links are never followed or copied, and
//!   sockets, devices and nested repositories are not files;
//! - `too_large`: over the largest file `fs.read` serves.
//!
//! The answer is paged to fit a relay frame. A page after the first names
//! the `manifestId` of the first; a listing that is no longer the one cached
//! is `cursor_expired`, and the client starts over.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::files::MAX_FILE_BYTES;
use super::git::WorkspaceGit;
use super::protocol::RpcError;

/// Files in one manifest; a workspace with more is `truncated`, and a
/// truncated manifest is never published by the desktop.
pub const MAX_ENTRIES: usize = 50_000;
/// Serialized entries per answer; a frame must cross the relay.
const PAGE_BYTES: usize = 320 * 1024;
/// How long the pages of one listing can be asked for.
const CACHE_TTL: Duration = Duration::from_secs(120);
const LIST_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq)]
struct Entry {
    path: String,
    size: u64,
    /// `fs.stat`'s `version`: changes whenever the file is rewritten.
    version: String,
    executable: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct Skipped {
    secret: usize,
    excluded: usize,
    symlink: usize,
    unsupported: usize,
    too_large: usize,
}

struct Listing {
    id: String,
    made: Instant,
    entries: Vec<Entry>,
    repositories: Vec<Value>,
    skipped: Skipped,
    truncated: bool,
}

pub struct WorkspaceMirror {
    root: PathBuf,
    cache: Mutex<Option<Arc<Listing>>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Params {
    #[serde(default)]
    manifest_id: Option<String>,
    #[serde(default)]
    cursor: Option<usize>,
}

impl WorkspaceMirror {
    /// `root` is canonical.
    pub fn new(root: PathBuf) -> Self {
        Self { root, cache: Mutex::new(None) }
    }

    /// `mirror.manifest`: `{ manifestId?, cursor? }` →
    /// `{ manifestId, repositories, entries, next, total, totalBytes, skipped, truncated }`.
    pub fn manifest(&self, git: &WorkspaceGit, params: &Value) -> Result<Value, RpcError> {
        let params: Params = serde_json::from_value(params.clone()).map_err(|error| RpcError::invalid(error.to_string()))?;
        let listing = match params.manifest_id {
            None if params.cursor.unwrap_or(0) == 0 => {
                let listing = Arc::new(self.list(git)?);
                *self.cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(listing.clone());
                listing
            }
            None => return Err(RpcError::invalid("a cursor needs the manifestId it belongs to")),
            Some(id) => {
                let cached = self.cache.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
                cached
                    .filter(|listing| listing.id == id && listing.made.elapsed() < CACHE_TTL)
                    .ok_or_else(|| RpcError::new("cursor_expired", "the manifest is no longer held; ask for it again"))?
            }
        };
        let start = params.cursor.unwrap_or(0);
        if start > listing.entries.len() {
            return Err(RpcError::invalid("the cursor is past the end"));
        }
        let mut page = Vec::new();
        let mut bytes = 0usize;
        let mut next = start;
        for entry in &listing.entries[start..] {
            let value = json!({ "path": entry.path, "size": entry.size, "version": entry.version, "executable": entry.executable });
            let cost = value.to_string().len() + 1;
            if !page.is_empty() && bytes + cost > PAGE_BYTES {
                break;
            }
            bytes += cost;
            page.push(value);
            next += 1;
        }
        Ok(json!({
            "manifestId": listing.id,
            "repositories": listing.repositories,
            "entries": page,
            "next": (next < listing.entries.len()).then_some(next),
            "total": listing.entries.len(),
            "totalBytes": listing.entries.iter().map(|entry| entry.size).sum::<u64>(),
            "skipped": {
                "secret": listing.skipped.secret,
                "excluded": listing.skipped.excluded,
                "symlink": listing.skipped.symlink,
                "unsupported": listing.skipped.unsupported,
                "tooLarge": listing.skipped.too_large,
            },
            "truncated": listing.truncated,
        }))
    }

    fn list(&self, git: &WorkspaceGit) -> Result<Listing, RpcError> {
        let (repositories, _) = git.repositories();
        let mut entries = Vec::new();
        let mut skipped = Skipped::default();
        let mut truncated = false;
        let mut described = Vec::new();
        for repository in &repositories {
            let dir = if repository == "." { self.root.clone() } else { self.root.join(repository) };
            let prefix = if repository == "." { String::new() } else { format!("{}/", repository.replace('\\', "/")) };
            let listed = list_files(&dir)?;
            let ignore = repository_ignore(&dir);
            for name in listed {
                let path = format!("{prefix}{name}");
                if crate::mirror_rules::reserved(&path) || !lexical(&path) {
                    skipped.unsupported += 1;
                    continue;
                }
                // Never followed: a link is looked at, not through.
                let Ok(meta) = std::fs::symlink_metadata(self.root.join(&path)) else { continue };
                if meta.file_type().is_symlink() {
                    skipped.symlink += 1;
                } else if !meta.is_file() {
                    skipped.unsupported += 1;
                } else if crate::mirror_rules::secret(&path) {
                    skipped.secret += 1;
                } else if ignore.as_ref().is_some_and(|ignore| ignore.matched_path_or_any_parents(&name, false).is_ignore()) {
                    skipped.excluded += 1;
                } else if meta.len() > MAX_FILE_BYTES {
                    skipped.too_large += 1;
                } else if entries.len() >= MAX_ENTRIES {
                    truncated = true;
                } else {
                    entries.push(Entry { path, size: meta.len(), version: super::files::version_of(&meta), executable: executable(&meta) });
                }
            }
            described.push(json!({
                "repo": repository,
                "branch": crate::git::current_branch(&dir),
                "head": crate::git::head_commit(&dir),
            }));
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        entries.dedup_by(|a, b| a.path == b.path);
        let mut hasher = Sha256::new();
        for entry in &entries {
            hasher.update(entry.path.as_bytes());
            hasher.update([0]);
            hasher.update(entry.version.as_bytes());
            hasher.update([u8::from(entry.executable), b'\n']);
        }
        let id = hasher.finalize()[..16].iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(Listing { id, made: Instant::now(), entries, repositories: described, skipped, truncated })
    }
}

/// Only plain relative components: what `fs.read` will accept.
fn lexical(path: &str) -> bool {
    !path.is_empty() && path.len() <= 4096 && Path::new(path).components().all(|part| matches!(part, std::path::Component::Normal(_)))
}

#[cfg(unix)]
fn executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable(_meta: &std::fs::Metadata) -> bool {
    false
}

/// Tracked files and untracked files Git does not ignore, repository-relative.
fn list_files(dir: &Path) -> Result<Vec<String>, RpcError> {
    let mut command = super::git::git_command(dir);
    command.args(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    let ran = super::git::run_bounded(command, LIST_TIMEOUT).map_err(RpcError::internal)?;
    if !ran.ok {
        return Err(RpcError::new("git_failed", "the workspace's files could not be listed"));
    }
    Ok(ran.stdout.split('\0').filter(|name| !name.is_empty()).map(str::to_string).collect())
}

/// The repository's own exclusions, if it has any that parse.
fn repository_ignore(dir: &Path) -> Option<ignore::gitignore::Gitignore> {
    let file = dir.join(crate::mirror_rules::IGNORE_FILE);
    // A link could point the rules at another file; only a real file counts.
    if !std::fs::symlink_metadata(&file).is_ok_and(|meta| meta.is_file()) {
        return None;
    }
    let mut builder = ignore::gitignore::GitignoreBuilder::new(dir);
    builder.add(&file);
    builder.build().ok()
}

#[cfg(test)]
#[path = "mirror_tests.rs"]
mod tests;
