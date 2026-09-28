//! `fs/1` on the runtime (PRO-24): the workspace's files, served to attached
//! clients over the relay (docs/CLOUD-FILES.md).
//!
//! Paths are workspace-relative and resolved here, never by the client:
//! lexically (no root, drive or `..`), then through symlinks, and a path
//! that resolves outside the workspace is `path_forbidden`. A symlink that
//! leaves the workspace is listed as a link that escapes and never followed.
//!
//! Every response fits the relay's 1 MiB frame, double base64 included:
//! - reads and writes move in parts of at most [`PART_BYTES`]; a file is
//!   read part by part under one `version`, and a large write is staged
//!   part by part outside the workspace, then committed at once;
//! - search results and listings are capped, and say so.
//!
//! Writes are optimistic: `expectedEtag` must match the file's content hash,
//! so an edit made meanwhile (by an agent, or another device) is a
//! `conflict` for the client to resolve, never silently overwritten.

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::protocol::{valid_client_request_id, RpcError};

/// Raw bytes per read or write part. Base64 in the JSON answer, sealed and
/// base64 again for the relay, keeps a part well under its 1 MiB frame.
pub const PART_BYTES: usize = 384 * 1024;
/// Largest file read or written remotely, in parts.
pub const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_LIST_ENTRIES: usize = 5000;
/// Files up to this size carry an `etag` in `fs.stat` and `fs.list`-free
/// reads; larger ones are hashed only when read from the start.
const STAT_ETAG_BYTES: u64 = 4 * 1024 * 1024;
const SNIFF_BYTES: usize = 8192;
const DEFAULT_SEARCH_RESULTS: usize = 200;
const MAX_SEARCH_RESULTS: usize = 1000;
/// Serialized hits per `fs.search` answer, before it reports `capped`.
const SEARCH_RESPONSE_BYTES: usize = 384 * 1024;
/// Matches kept per hit; a minified line can hold thousands.
const MAX_MATCHES_PER_HIT: usize = 32;
const MAX_UPLOADS_PER_DEVICE: usize = 4;
const UPLOAD_TTL: Duration = Duration::from_secs(10 * 60);
/// Concurrent `fs.watch` subscriptions per connection.
pub const MAX_WATCHES_PER_PEER: usize = 8;

/// A large write in progress: parts appended to a file outside the workspace.
struct Upload {
    file: PathBuf,
    received: u64,
    touched: Instant,
}

pub struct WorkspaceFiles {
    root: PathBuf,
    /// Staged uploads live here, outside the workspace, so a half-sent file
    /// is never seen by the tree, Git or an agent.
    staging: PathBuf,
    uploads: Mutex<HashMap<(String, String), Upload>>,
    /// Searches in flight by (connection, searchId), to cancel.
    searches: Mutex<HashMap<(u64, String), Arc<AtomicBool>>>,
}

impl Drop for WorkspaceFiles {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.staging);
    }
}

impl WorkspaceFiles {
    /// `root` is canonical.
    pub fn new(root: PathBuf) -> Self {
        let staging = std::env::temp_dir().join(format!("terminalx-uploads-{}", uuid::Uuid::new_v4().simple()));
        Self { root, staging, uploads: Mutex::new(HashMap::new()), searches: Mutex::new(HashMap::new()) }
    }

    // ---- paths -----------------------------------------------------------

    /// A workspace-relative path, lexically: no root, drive or `..`.
    pub fn lexical(&self, relative: &str) -> Result<PathBuf, RpcError> {
        if relative.len() > 4096 || relative.contains('\0') {
            return Err(RpcError::new("path_forbidden", "invalid path"));
        }
        let mut clean = PathBuf::new();
        for component in Path::new(relative).components() {
            match component {
                Component::Normal(part) => clean.push(part),
                Component::CurDir => {}
                _ => return Err(RpcError::new("path_forbidden", "paths are workspace-relative and may not leave it")),
            }
        }
        Ok(self.root.join(clean))
    }

    /// An existing path, resolved through symlinks, still inside the workspace.
    pub fn existing_path(&self, relative: &str) -> Result<PathBuf, RpcError> {
        let path = self.lexical(relative)?;
        let resolved = std::fs::canonicalize(&path).map_err(|_| RpcError::not_found("no such path"))?;
        if !resolved.starts_with(&self.root) {
            return Err(RpcError::new("path_forbidden", "the path resolves outside the workspace"));
        }
        Ok(resolved)
    }

    /// A directory entry itself, not what it may link to: its parent must
    /// resolve inside the workspace.
    fn entry_path(&self, relative: &str) -> Result<PathBuf, RpcError> {
        let path = self.lexical(relative)?;
        if path == self.root {
            return Err(RpcError::new("path_forbidden", "the workspace root cannot be replaced"));
        }
        let parent = path.parent().ok_or_else(|| RpcError::new("path_forbidden", "invalid path"))?;
        let parent = std::fs::canonicalize(parent).map_err(|_| RpcError::not_found("the parent directory does not exist"))?;
        if !parent.starts_with(&self.root) {
            return Err(RpcError::new("path_forbidden", "the path resolves outside the workspace"));
        }
        Ok(parent.join(path.file_name().expect("a normal component")))
    }

    /// A path to write through: a symlink there must point inside the workspace.
    fn new_path(&self, relative: &str) -> Result<PathBuf, RpcError> {
        let path = self.entry_path(relative)?;
        if std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return self.existing_path(relative);
        }
        Ok(path)
    }

    pub fn relative(&self, path: &Path) -> String {
        path.strip_prefix(&self.root).unwrap_or(path).to_string_lossy().into_owned()
    }

    /// Whether a changed path may be named to a client: none of its existing
    /// ancestors below the root is a symlink that leaves the workspace (a
    /// recursive watcher may have followed one).
    pub fn visible(&self, path: &Path) -> bool {
        let Ok(relative) = path.strip_prefix(&self.root) else { return false };
        let mut at = self.root.clone();
        for component in relative.components() {
            let Component::Normal(part) = component else { return false };
            at.push(part);
            match std::fs::symlink_metadata(&at) {
                Ok(meta) if meta.file_type().is_symlink() => match std::fs::canonicalize(&at) {
                    Ok(target) if target.starts_with(&self.root) => {}
                    // Dangling or outside: the link itself may be named, nothing under it.
                    _ => return at == path,
                },
                Ok(_) => {}
                // Deleted meanwhile; what is left of the path was checked.
                Err(_) => return true,
            }
        }
        true
    }

    // ---- reads -----------------------------------------------------------

    /// One level of a directory. A symlink is described by what it points
    /// at when that is inside the workspace, and as an escaping link otherwise.
    pub fn list(&self, params: &Value) -> Result<Value, RpcError> {
        let dir = self.existing_path(params.get("path").and_then(Value::as_str).unwrap_or(""))?;
        if !dir.is_dir() {
            return Err(RpcError::invalid("not a directory"));
        }
        let base = self.relative(&dir);
        let mut entries = Vec::new();
        let mut truncated = false;
        for entry in std::fs::read_dir(&dir).map_err(RpcError::internal)? {
            let Ok(entry) = entry else { continue };
            if entries.len() >= MAX_LIST_ENTRIES {
                truncated = true;
                break;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = if base.is_empty() { name.clone() } else { format!("{base}/{name}") };
            let Ok(own) = entry.metadata() else { continue };
            let mut described = if own.file_type().is_symlink() {
                let mut link = match std::fs::canonicalize(entry.path()).ok().filter(|target| target.starts_with(&self.root)) {
                    Some(target) => match std::fs::metadata(&target) {
                        Ok(meta) => stat_json(&name, &meta),
                        Err(_) => continue,
                    },
                    // Outside the workspace, or dangling: named, never followed.
                    None => json!({ "name": name, "kind": "symlink", "size": 0, "modifiedMs": null, "escapes": true }),
                };
                link["symlink"] = json!(true);
                link
            } else {
                stat_json(&name, &own)
            };
            described["path"] = json!(path);
            if described["kind"] == "file" {
                described["mediaType"] = json!(media_mime(&entry.path()));
            }
            entries.push(described);
        }
        entries.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        Ok(json!({ "path": base, "entries": entries, "truncated": truncated }))
    }

    pub fn stat(&self, params: &Value) -> Result<Value, RpcError> {
        let path = self.existing_path(required_str(params, "path")?)?;
        let meta = std::fs::metadata(&path).map_err(RpcError::internal)?;
        let mut stat = stat_json(&self.relative(&path), &meta);
        if meta.is_file() {
            stat["version"] = json!(version_of(&meta));
            stat["mediaType"] = json!(media_mime(&path));
            if meta.len() <= STAT_ETAG_BYTES {
                stat["etag"] = json!(hash_file(&path).map_err(RpcError::internal)?);
            }
        }
        Ok(stat)
    }

    /// One part of a file: `offset` and `length` (at most [`PART_BYTES`]).
    /// The first part carries the content `etag` and whether the file looks
    /// binary; every part carries `version`, and a later part asked with the
    /// first one's `version` is `conflict` if the file changed in between.
    /// A small UTF-8 file comes back whole as `text`, anything else as `dataB64`.
    pub fn read(&self, params: &Value) -> Result<Value, RpcError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Params {
            path: String,
            #[serde(default)]
            offset: u64,
            length: Option<usize>,
            version: Option<String>,
        }
        let p: Params = parse(params)?;
        let path = self.existing_path(&p.path)?;
        let meta = std::fs::metadata(&path).map_err(RpcError::internal)?;
        if !meta.is_file() {
            return Err(RpcError::invalid("not a file"));
        }
        let size = meta.len();
        if size > MAX_FILE_BYTES {
            return Err(RpcError::new("too_large", format!("files over {MAX_FILE_BYTES} bytes cannot be read remotely")));
        }
        if p.offset > size {
            return Err(RpcError::invalid("offset is past the end of the file"));
        }
        let version = version_of(&meta);
        if p.version.as_deref().is_some_and(|expected| expected != version) {
            return Err(RpcError::new("conflict", "the file changed while it was being read"));
        }
        let length = p.length.unwrap_or(PART_BYTES).clamp(1, PART_BYTES);
        let mut file = std::fs::File::open(&path).map_err(RpcError::internal)?;
        file.seek(SeekFrom::Start(p.offset)).map_err(RpcError::internal)?;
        let mut bytes = Vec::with_capacity(length.min(size as usize));
        file.take(length as u64).read_to_end(&mut bytes).map_err(RpcError::internal)?;
        let etag = if p.offset == 0 {
            Some(if bytes.len() as u64 == size { etag(&bytes) } else { hash_file(&path).map_err(RpcError::internal)? })
        } else {
            None
        };
        // Written to while this part was read: the part may mix versions.
        if std::fs::metadata(&path).map(|after| version_of(&after)).ok().as_deref() != Some(version.as_str()) {
            return Err(RpcError::new("conflict", "the file changed while it was being read"));
        }
        let eof = p.offset + bytes.len() as u64 >= size;
        let mut out = json!({
            "path": self.relative(&path),
            "size": size,
            "version": version,
            "offset": p.offset,
            "eof": eof,
            "mediaType": media_mime(&path),
        });
        if let Some(etag) = etag {
            out["etag"] = json!(etag);
            out["binary"] = json!(looks_binary(&bytes));
        }
        if p.offset == 0 && eof && !looks_binary(&bytes) {
            match String::from_utf8(bytes) {
                Ok(text) => out["text"] = json!(text),
                Err(error) => out["dataB64"] = json!(STANDARD.encode(error.as_bytes())),
            }
        } else {
            out["dataB64"] = json!(STANDARD.encode(&bytes));
        }
        Ok(out)
    }

    // ---- writes ----------------------------------------------------------

    /// Stage one part of a large write: `uploadId`, `offset` (the bytes
    /// received so far; 0 starts over) and `dataB64`. Committed by `fs.write`.
    pub fn write_part(&self, device: &str, params: &Value) -> Result<Value, RpcError> {
        let upload_id = required_str(params, "uploadId")?;
        if !valid_client_request_id(upload_id) {
            return Err(RpcError::invalid("uploadId is 8-128 letters, digits, '-' or '_'"));
        }
        let offset = params.get("offset").and_then(Value::as_u64).ok_or_else(|| RpcError::invalid("offset is required"))?;
        let data = STANDARD.decode(required_str(params, "dataB64")?).map_err(|_| RpcError::invalid("dataB64 is not base64"))?;
        if data.len() > PART_BYTES {
            return Err(RpcError::new("too_large", format!("a part is at most {PART_BYTES} bytes")));
        }
        let now = Instant::now();
        let mut uploads = self.uploads.lock().unwrap();
        uploads.retain(|_, upload| {
            let live = now.duration_since(upload.touched) < UPLOAD_TTL;
            if !live {
                let _ = std::fs::remove_file(&upload.file);
            }
            live
        });
        let key = (device.to_string(), upload_id.to_string());
        if offset == 0 {
            if let Some(previous) = uploads.remove(&key) {
                let _ = std::fs::remove_file(previous.file);
            }
            if uploads.keys().filter(|(owner, _)| owner == device).count() >= MAX_UPLOADS_PER_DEVICE {
                return Err(RpcError::new("backpressure", "too many uploads in progress; finish or restart one"));
            }
            create_private_dir(&self.staging).map_err(RpcError::internal)?;
            let file = self.staging.join(uuid::Uuid::new_v4().simple().to_string());
            uploads.insert(key.clone(), Upload { file, received: 0, touched: now });
        }
        let upload = uploads.get_mut(&key).ok_or_else(|| RpcError::not_found("no such upload; start again at offset 0"))?;
        if offset != upload.received {
            return Err(RpcError::invalid(format!("expected the part at offset {}", upload.received)));
        }
        if upload.received + data.len() as u64 > MAX_FILE_BYTES {
            let upload = uploads.remove(&key).unwrap();
            let _ = std::fs::remove_file(upload.file);
            return Err(RpcError::new("too_large", format!("files over {MAX_FILE_BYTES} bytes cannot be written remotely")));
        }
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(&upload.file).map_err(RpcError::internal)?;
        file.write_all(&data).map_err(RpcError::internal)?;
        upload.received += data.len() as u64;
        upload.touched = now;
        Ok(json!({ "uploadId": upload_id, "received": upload.received }))
    }

    /// Replace a file at once: from `text` or `dataB64` (one part), or from
    /// the staged `uploadId` of exactly `size` bytes. `expectedEtag`: a
    /// string must match the current content, null means the file must not
    /// exist yet, absent writes unconditionally. The file's permissions are kept.
    pub fn write(&self, device: &str, params: &Value) -> Result<Value, RpcError> {
        let path = self.new_path(required_str(params, "path")?)?;
        let inline = match (params.get("text").and_then(Value::as_str), params.get("dataB64").and_then(Value::as_str), params.get("uploadId")) {
            (Some(text), None, None) => Some(text.as_bytes().to_vec()),
            (None, Some(data), None) => Some(STANDARD.decode(data).map_err(|_| RpcError::invalid("dataB64 is not base64"))?),
            (None, None, Some(_)) => None,
            _ => return Err(RpcError::invalid("pass exactly one of text, dataB64 or uploadId")),
        };
        if inline.as_ref().is_some_and(|bytes| bytes.len() > PART_BYTES) {
            return Err(RpcError::new("too_large", format!("send files over {PART_BYTES} bytes in parts with fs.writePart")));
        }
        if let Some(expected) = params.get("expectedEtag") {
            let current = match std::fs::symlink_metadata(&path) {
                Ok(meta) if meta.is_dir() => return Err(RpcError::invalid("the path is a directory")),
                Ok(_) => Some(hash_file(&path).map_err(RpcError::internal)?),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(RpcError::internal(error)),
            };
            if expected.as_str().map(str::to_string) != current {
                return Err(RpcError::new("conflict", "the file changed since it was read"));
            }
        }
        if path.is_dir() {
            return Err(RpcError::invalid("the path is a directory"));
        }
        let temporary = path.with_file_name(format!(
            ".{}.terminalx-{}",
            path.file_name().unwrap().to_string_lossy(),
            uuid::Uuid::new_v4().simple()
        ));
        let (tag, size) = match inline {
            Some(bytes) => {
                std::fs::write(&temporary, &bytes).map_err(RpcError::internal)?;
                (etag(&bytes), bytes.len() as u64)
            }
            None => {
                let upload_id = required_str(params, "uploadId")?;
                let size = params.get("size").and_then(Value::as_u64).ok_or_else(|| RpcError::invalid("size is required with uploadId"))?;
                let key = (device.to_string(), upload_id.to_string());
                let upload = self.uploads.lock().unwrap().remove(&key).ok_or_else(|| RpcError::not_found("no such upload"))?;
                let staged = Staged(upload.file.clone());
                if upload.received != size {
                    return Err(RpcError::invalid(format!("the upload has {} bytes, not {size}", upload.received)));
                }
                std::fs::copy(&staged.0, &temporary).map_err(RpcError::internal)?;
                (hash_file(&temporary).map_err(RpcError::internal)?, size)
            }
        };
        if let Ok(meta) = std::fs::metadata(&path) {
            let _ = std::fs::set_permissions(&temporary, meta.permissions());
        }
        if let Err(error) = std::fs::rename(&temporary, &path) {
            let _ = std::fs::remove_file(&temporary);
            return Err(RpcError::internal(error));
        }
        let version = std::fs::metadata(&path).map(|meta| version_of(&meta)).ok();
        Ok(json!({ "path": self.relative(&path), "etag": tag, "size": size, "version": version }))
    }

    pub fn rename(&self, params: &Value) -> Result<Value, RpcError> {
        let from = self.entry_path(required_str(params, "from")?)?;
        let to = self.entry_path(required_str(params, "to")?)?;
        if std::fs::symlink_metadata(&from).is_err() {
            return Err(RpcError::not_found("no such path"));
        }
        if std::fs::symlink_metadata(&to).is_ok() {
            return Err(RpcError::new("conflict", "the destination exists"));
        }
        std::fs::rename(&from, &to).map_err(RpcError::internal)?;
        Ok(json!({ "from": self.relative(&from), "to": self.relative(&to) }))
    }

    pub fn delete(&self, params: &Value) -> Result<Value, RpcError> {
        let relative = required_str(params, "path")?;
        // Delete the link itself, never what it points at.
        let path = self.entry_path(relative)?;
        let meta = std::fs::symlink_metadata(&path).map_err(|_| RpcError::not_found("no such path"))?;
        if meta.is_dir() {
            if params.get("recursive").and_then(Value::as_bool) == Some(true) {
                std::fs::remove_dir_all(&path)
            } else {
                std::fs::remove_dir(&path)
            }
        } else {
            std::fs::remove_file(&path)
        }
        .map_err(RpcError::internal)?;
        Ok(json!({ "path": self.relative(&path) }))
    }

    pub fn mkdir(&self, params: &Value) -> Result<Value, RpcError> {
        let path = self.new_path(required_str(params, "path")?)?;
        match std::fs::create_dir(&path) {
            Ok(()) => Ok(json!({ "path": self.relative(&path), "created": true })),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists && path.is_dir() => {
                Ok(json!({ "path": self.relative(&path), "created": false }))
            }
            Err(error) => Err(RpcError::internal(error)),
        }
    }

    // ---- search ----------------------------------------------------------

    /// Grep the tree under `path` (the whole workspace by default): literal
    /// or `regex`, `caseSensitive` or not, ignored and binary files skipped,
    /// symlinks never followed. At most `maxResults` hits and a bounded
    /// answer (`capped`); `fs.cancel` with the same `searchId` stops it
    /// early (`cancelled`), as does a new search under the same id.
    pub fn search(&self, peer: u64, params: &Value) -> Result<Value, RpcError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Params {
            search_id: String,
            query: String,
            #[serde(default)]
            regex: bool,
            #[serde(default)]
            case_sensitive: bool,
            #[serde(default)]
            path: String,
            max_results: Option<usize>,
        }
        let p: Params = parse(params)?;
        if !valid_client_request_id(&p.search_id) {
            return Err(RpcError::invalid("searchId is 8-128 letters, digits, '-' or '_'"));
        }
        if p.query.len() > 1000 {
            return Err(RpcError::invalid("the query is too long"));
        }
        let base = self.existing_path(&p.path)?;
        if !base.is_dir() {
            return Err(RpcError::invalid("search a directory"));
        }
        let limit = p.max_results.unwrap_or(DEFAULT_SEARCH_RESULTS).clamp(1, MAX_SEARCH_RESULTS);
        let flag = Arc::new(AtomicBool::new(false));
        let key = (peer, p.search_id.clone());
        if let Some(previous) = self.searches.lock().unwrap().insert(key.clone(), flag.clone()) {
            previous.store(true, Ordering::Relaxed);
        }
        let result = crate::files::search_text_under(&self.root, &base, &p.query, p.regex, p.case_sensitive, limit, None, &flag);
        {
            let mut searches = self.searches.lock().unwrap();
            if searches.get(&key).is_some_and(|current| Arc::ptr_eq(current, &flag)) {
                searches.remove(&key);
            }
        }
        let (found, cancelled) = result.map_err(|error| RpcError::invalid(format!("{error:#}")))?;
        let mut capped = found.capped;
        let mut budget = SEARCH_RESPONSE_BYTES;
        let mut hits = Vec::with_capacity(found.hits.len());
        let mut files = std::collections::HashSet::new();
        for mut hit in found.hits {
            let shown = hit.text.chars().count() as u32;
            hit.matches.retain(|(start, _)| *start < shown);
            hit.matches.truncate(MAX_MATCHES_PER_HIT);
            for (_, end) in &mut hit.matches {
                *end = (*end).min(shown);
            }
            let value = serde_json::to_value(&hit).map_err(RpcError::internal)?;
            let size = value.to_string().len();
            if size > budget {
                capped = true;
                break;
            }
            budget -= size;
            files.insert(hit.path.clone());
            hits.push(value);
        }
        let files = if capped { files.len() } else { found.files };
        Ok(json!({ "searchId": p.search_id, "hits": hits, "files": files, "capped": capped, "cancelled": cancelled }))
    }

    /// Stop a search this connection started.
    pub fn cancel(&self, peer: u64, params: &Value) -> Result<Value, RpcError> {
        let search_id = required_str(params, "searchId")?;
        let flag = self.searches.lock().unwrap().get(&(peer, search_id.to_string())).cloned();
        if let Some(flag) = &flag {
            flag.store(true, Ordering::Relaxed);
        }
        Ok(json!({ "cancelled": flag.is_some() }))
    }

    /// A connection closed: stop its searches and drop its uploads.
    pub fn disconnect(&self, peer: u64) {
        for (_, flag) in self.searches.lock().unwrap().iter().filter(|((owner, _), _)| *owner == peer) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    // ---- watch -----------------------------------------------------------

    /// A recursive watcher on `path` that reports changed workspace-relative
    /// paths, `.git` and anything reached through an escaping link left out.
    pub fn watcher(
        self: &Arc<Self>,
        relative: &str,
        on_change: impl Fn(Vec<String>) + Send + 'static,
    ) -> Result<(Box<dyn Send>, String), RpcError> {
        use notify_debouncer_mini::{new_debouncer, notify::RecursiveMode, DebounceEventResult};
        let path = self.existing_path(relative)?;
        let files = Arc::downgrade(self);
        let mut debouncer = new_debouncer(Duration::from_millis(250), move |result: DebounceEventResult| {
            let (Ok(events), Some(files)) = (result, files.upgrade()) else { return };
            let mut paths: Vec<String> = events
                .iter()
                .filter(|event| files.visible(&event.path))
                .filter_map(|event| event.path.strip_prefix(&files.root).ok())
                .filter(|path| !path.starts_with(".git"))
                .map(|path| path.to_string_lossy().into_owned())
                .filter(|path| !path.is_empty() && !is_staging_name(path))
                .collect();
            paths.sort();
            paths.dedup();
            if !paths.is_empty() {
                on_change(paths);
            }
        })
        .map_err(RpcError::internal)?;
        debouncer.watcher().watch(&path, RecursiveMode::Recursive).map_err(RpcError::internal)?;
        Ok((Box::new(debouncer), self.relative(&path)))
    }
}

/// The temporary a write renames into place.
fn is_staging_name(path: &str) -> bool {
    path.rsplit('/').next().is_some_and(|name| name.starts_with('.') && name.contains(".terminalx-"))
}

/// Removes the staged file however the commit ends.
struct Staged(PathBuf);

impl Drop for Staged {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn create_private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

fn parse<T: serde::de::DeserializeOwned>(params: &Value) -> Result<T, RpcError> {
    serde_json::from_value(params.clone()).map_err(|error| RpcError::invalid(error.to_string()))
}

fn required_str<'a>(params: &'a Value, name: &str) -> Result<&'a str, RpcError> {
    params.get(name).and_then(Value::as_str).ok_or_else(|| RpcError::invalid(format!("{name} is required")))
}

pub fn etag(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest[..16].iter().map(|byte| format!("{byte:02x}")).collect()
}

/// [`etag`] of a file, streamed.
fn hash_file(path: &Path) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize()[..16].iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Cheap identity of a file's current state: size, modification time and
/// inode (a write through rename changes it). Not a content hash; it only
/// tells parts of one read apart from a file rewritten in between.
fn version_of(meta: &std::fs::Metadata) -> String {
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    #[cfg(unix)]
    let (inode, changed) = {
        use std::os::unix::fs::MetadataExt;
        (meta.ino(), meta.ctime_nsec() as u64 ^ (meta.ctime() as u64).rotate_left(32))
    };
    #[cfg(not(unix))]
    let (inode, changed) = (0u64, 0u64);
    format!("{:x}-{modified:x}-{inode:x}-{changed:x}", meta.len())
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(SNIFF_BYTES).any(|&byte| byte == 0)
}

fn media_mime(path: &Path) -> Option<&'static str> {
    crate::media_types::media_type(path).map(|media| media.mime.as_str())
}

pub fn stat_json(name: &str, meta: &std::fs::Metadata) -> Value {
    let kind = if meta.is_dir() {
        "directory"
    } else if meta.is_file() {
        "file"
    } else {
        "other"
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|elapsed| elapsed.as_millis() as u64);
    json!({ "name": name, "kind": kind, "size": meta.len(), "modifiedMs": modified })
}

#[cfg(test)]
#[path = "files_tests.rs"]
mod tests;
