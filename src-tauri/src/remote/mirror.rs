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
//! - `secret`: credential and key files by name ([`crate::mirror_rules`]),
//!   and anything inside the runtime's own state directory;
//! - `toolConfig`: tool configuration that runs commands by itself;
//! - `gitDirectory`: everything inside a folder Git would take for a
//!   repository's own directory, whatever it is called;
//! - `excluded`: the repository's own `.terminalx-mirror-ignore`;
//! - `symlink`: links are never followed or copied. That includes every
//!   file reached through a linked folder: Git lists what its index names,
//!   whatever the working tree has turned into since;
//! - `unsupported`: sockets, devices, nested repositories, and names a
//!   desktop could not hold (a backslash);
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
    tool_config: usize,
    git_directory: usize,
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
    /// Directories inside the workspace whose contents are never listed: the
    /// runtime's own state, if it was ever configured to live in the workspace.
    protected: Vec<PathBuf>,
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
        // The state directory holds the runtime credential and agent logins.
        // It is deployed outside the workspace; if it is not, it is still
        // never part of a mirror.
        let state = crate::store::state_home_env().map(PathBuf::from).and_then(|dir| std::fs::canonicalize(dir).ok());
        Self::with_protected(root, state.into_iter().collect())
    }

    pub fn with_protected(root: PathBuf, protected: Vec<PathBuf>) -> Self {
        Self { root, protected, cache: Mutex::new(None) }
    }

    /// Is any folder on the way to `path` a symbolic link? Checked once per folder.
    fn through_link(&self, path: &str, known: &mut std::collections::HashMap<PathBuf, bool>) -> bool {
        let mut dir = self.root.clone();
        let parts: Vec<&str> = path.split('/').collect();
        for part in &parts[..parts.len() - 1] {
            dir.push(part);
            let linked = *known.entry(dir.clone()).or_insert_with(|| std::fs::symlink_metadata(&dir).is_ok_and(|meta| meta.file_type().is_symlink()));
            if linked {
                return true;
            }
        }
        false
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
                "toolConfig": listing.skipped.tool_config,
                "gitDirectory": listing.skipped.git_directory,
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
        let mut skipped = Skipped::default();
        let mut described = Vec::new();
        // Every listed name first: whether a folder is a Git directory is a
        // question about all of its files together.
        let mut listed = Vec::new();
        for repository in &repositories {
            let dir = if repository == "." { self.root.clone() } else { self.root.join(repository) };
            let prefix = if repository == "." { String::new() } else { format!("{}/", repository.replace('\\', "/")) };
            let ignore = Arc::new(repository_ignore(&dir));
            for name in list_files(&dir)? {
                listed.push((format!("{prefix}{name}"), name, ignore.clone()));
            }
            described.push(json!({
                "repo": repository,
                "branch": crate::git::current_branch(&dir),
                "head": crate::git::head_commit(&dir),
            }));
        }
        let git_directories = crate::mirror_rules::git_directories(listed.iter().map(|(path, _, _)| path.as_str()));
        let mut links = std::collections::HashMap::new();
        let mut entries = Vec::new();
        let mut truncated = false;
        for (path, name, ignore) in &listed {
            if crate::mirror_rules::reserved(path) || !lexical(path) {
                skipped.unsupported += 1;
                continue;
            }
            // A linked folder is never looked through: its files are another
            // place's, under a name the rules below would not recognise.
            if self.through_link(path, &mut links) {
                skipped.symlink += 1;
                continue;
            }
            let full = self.root.join(path);
            let Ok(meta) = std::fs::symlink_metadata(&full) else { continue };
            if meta.file_type().is_symlink() {
                skipped.symlink += 1;
            } else if !meta.is_file() {
                skipped.unsupported += 1;
            } else if crate::mirror_rules::secret(path) || self.protected.iter().any(|dir| full.starts_with(dir)) {
                skipped.secret += 1;
            } else if crate::mirror_rules::inside(path, &git_directories) {
                skipped.git_directory += 1;
            } else if crate::mirror_rules::tool_config(path) {
                skipped.tool_config += 1;
            } else if ignore.as_ref().as_ref().is_some_and(|ignore| ignore.matched_path_or_any_parents(name, false).is_ignore()) {
                skipped.excluded += 1;
            } else if meta.len() > MAX_FILE_BYTES {
                skipped.too_large += 1;
            } else if entries.len() >= MAX_ENTRIES {
                truncated = true;
            } else {
                entries.push(Entry { path: path.clone(), size: meta.len(), version: super::files::version_of(&meta), executable: executable(&meta) });
            }
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

/// Only plain relative components (what `fs.read` will accept), and no
/// backslash: on a desktop that is a separator.
fn lexical(path: &str) -> bool {
    !path.is_empty() && path.len() <= 4096 && !path.contains('\\') && Path::new(path).components().all(|part| matches!(part, std::path::Component::Normal(_)))
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
