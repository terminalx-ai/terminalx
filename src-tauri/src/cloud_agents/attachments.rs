//! Images and files a person attaches to a message for a cloud or machine
//! agent tab (PRO-22, PRO-407).
//!
//! A mailbox command holds at most 64 KiB and an RPC frame 1 MiB, so an
//! image does not travel inside the message. The desktop uploads it to the
//! runtime first, in parts, over the end-to-end encrypted connection
//! (`session.attach`), and the message names it by id. Here it waits, in the
//! runtime's private state directory and never in the workspace tree, until
//! that message is typed: then it is handed to the agent exactly as a local
//! tab's image is, and removed.
//!
//! A file other than an image (`file: true`, PRO-407) waits here the same
//! way. When its message is typed it is moved into the session's attachments
//! folder on this runtime's computer (`crate::attachments::store`), and the
//! agent is handed its path there, as a local tab's file is (PRO-290): the
//! person's computer sends its bytes and its name, never a path of its own.
//!
//! An upload belongs to the person who made it: nobody else's message can
//! name it, and nothing reads it back over the connection. What is never
//! sent is removed after a day.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};

use crate::attachments::{FileInput, MAX_ATTACHMENT_BYTES, MAX_FILES_PER_MESSAGE};
use crate::events::FileRef;
use crate::session::ImageInput;

/// One part of an upload, before base64: it fits a frame with room to spare.
pub const PART_BYTES: usize = 384 * 1024;
/// As a local tab's composer accepts.
pub const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
/// Images one message may carry.
pub const MAX_IMAGES: usize = 8;
/// Files one message may carry, as a local tab's composer allows; with its
/// images it carries at most [`MAX_FILES_PER_MESSAGE`] in all.
pub const MAX_FILES: usize = MAX_FILES_PER_MESSAGE;
/// The media type of a file whose sender did not know it.
const UNKNOWN_MEDIA_TYPE: &str = "application/octet-stream";
/// Uploads kept at once, for everyone together.
const MAX_STORED: usize = 64;
/// Bytes kept at once, for everyone together: one full message of files
/// (10 of 25 MB) fits, and a driver cannot fill the computer's disk with
/// uploads nobody sends (PRO-407).
const MAX_STORED_BYTES: u64 = 256 * 1024 * 1024;
const KEEP_FOR_MS: u64 = 24 * 60 * 60 * 1000;
const MEDIA_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

#[derive(Debug, PartialEq, Eq)]
pub enum AttachError {
    /// The request itself is wrong; the sentence says how.
    Invalid(&'static str),
    TooLarge,
    /// A file whose name cannot be attached (one TerminalX uses for its own
    /// files, or no name at all); the sentence says which and what to do.
    Refused(String),
    /// Too many uploads wait to be sent.
    Full,
    Failed(String),
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Meta {
    owner: String,
    media_type: String,
    #[serde(default)]
    name: Option<String>,
    complete: bool,
    at: u64,
    /// A file other than an image (PRO-407): stored in the session's
    /// attachments folder when sent, never handed over as an image.
    #[serde(default)]
    file: bool,
}

/// Why a message's files could not be taken into its session.
#[derive(Debug)]
pub enum FilesError {
    /// This upload id is not a complete file of the sender's.
    Missing(String),
    /// Storing them in the session's attachments folder failed.
    Failed(anyhow::Error),
}

/// A file's media type as its sender gave it: `type/subtype`, printable
/// ASCII, at most 127 characters. Empty means not known.
fn file_media_type(media_type: &str) -> Option<&str> {
    if media_type.is_empty() {
        return Some(UNKNOWN_MEDIA_TYPE);
    }
    let printable = media_type.bytes().all(|b| b.is_ascii_graphic());
    let shaped = media_type.split_once('/').is_some_and(|(kind, sub)| !kind.is_empty() && !sub.is_empty());
    (media_type.len() <= 127 && printable && shaped).then_some(media_type)
}

pub struct Attachments {
    dir: PathBuf,
    /// One upload or read at a time: parts are small and rare.
    lock: Mutex<()>,
    /// [`MAX_STORED_BYTES`]; smaller in tests.
    max_bytes: u64,
}

/// 8-128 letters, digits, `-` or `_`: also safe as a file name.
pub fn valid_id(id: &str) -> bool {
    (8..=128).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Attachments {
    pub fn open(state_dir: &Path) -> Result<Self> {
        let dir = state_dir.join("attachments");
        crate::cloud_bootstrap::ensure_private_dir(&dir)?;
        Ok(Self { dir, lock: Mutex::new(()), max_bytes: MAX_STORED_BYTES })
    }

    fn data(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.bin"))
    }

    fn meta_path(&self, id: &str) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    fn meta(&self, id: &str) -> Option<Meta> {
        serde_json::from_slice(&fs::read(self.meta_path(id)).ok()?).ok()
    }

    fn write_meta(&self, id: &str, meta: &Meta) -> Result<()> {
        let mut file = private_file(&self.meta_path(id), true)?;
        file.write_all(&serde_json::to_vec(meta)?)?;
        Ok(())
    }

    fn ids(&self) -> Vec<String> {
        let Ok(entries) = fs::read_dir(&self.dir) else { return Vec::new() };
        entries
            .flatten()
            .filter_map(|entry| entry.file_name().to_str().and_then(|name| name.strip_suffix(".json")).map(str::to_string))
            .collect()
    }

    /// One part of `owner`'s upload `id`, at `offset`. Parts arrive in
    /// order; a part sent again (its answer was lost) is accepted and
    /// changes nothing. `last` completes the upload. Returns its size so far.
    ///
    /// `file` uploads a file other than an image (PRO-407): any media type,
    /// up to [`MAX_ATTACHMENT_BYTES`], and a name it can be stored under.
    #[allow(clippy::too_many_arguments)]
    pub fn write_part(&self, owner: &str, id: &str, offset: u64, bytes: &[u8], media_type: &str, name: Option<&str>, file: bool, last: bool, now: u64) -> Result<u64, AttachError> {
        if !valid_id(id) {
            return Err(AttachError::Invalid("attachmentId is 8-128 letters, digits, '-' or '_'"));
        }
        let (media_type, limit) = if file {
            (file_media_type(media_type).ok_or(AttachError::Invalid("mediaType is not a media type"))?, MAX_ATTACHMENT_BYTES)
        } else {
            if !MEDIA_TYPES.contains(&media_type) {
                return Err(AttachError::Invalid("only PNG, JPEG, GIF and WebP images can be attached"));
            }
            (media_type, MAX_IMAGE_BYTES)
        };
        if bytes.len() > PART_BYTES {
            return Err(AttachError::Invalid("the part is too large"));
        }
        // An empty file is one empty last part; any other part has bytes.
        if bytes.is_empty() && !(file && last && offset == 0) {
            return Err(AttachError::Invalid("the part is empty"));
        }
        let failed = |error: anyhow::Error| AttachError::Failed(format!("{error:#}"));
        let _guard = self.lock.lock().unwrap();
        self.prune_locked(now);
        let existing = self.meta(id);
        let mut meta = match existing {
            // Someone else's id reads as one that cannot be used, nothing more.
            Some(meta) if meta.owner != owner || meta.media_type != media_type || meta.file != file => return Err(AttachError::Invalid("this attachmentId is already in use")),
            Some(meta) => meta,
            None if offset != 0 => return Err(AttachError::Invalid("the upload starts at offset 0")),
            None if self.ids().len() >= MAX_STORED => return Err(AttachError::Full),
            // The name is read from the first part only; later parts may leave it out.
            None => {
                let name = if file {
                    Some(crate::attachments::admissible_name(name.unwrap_or("")).map_err(|error| AttachError::Refused(format!("{error:#}")))?)
                } else {
                    name.map(|name| name.chars().take(200).collect())
                };
                Meta { owner: owner.to_string(), media_type: media_type.to_string(), name, complete: false, at: now, file }
            }
        };
        let path = self.data(id);
        let size = fs::metadata(&path).map(|file| file.len()).unwrap_or(0);
        let end = offset + bytes.len() as u64;
        if bytes.is_empty() {
            // An empty file, whole in its one part (sent again, it changes nothing).
            if size != 0 {
                return Err(AttachError::Invalid("parts are sent in order, once"));
            }
            meta.complete = true;
            // The record first, as below, so no file is left without one.
            (|| -> Result<()> {
                self.write_meta(id, &meta)?;
                private_file(&path, false).map(drop)
            })()
            .map_err(failed)?;
            return Ok(0);
        }
        if end <= size && (!last || end == size) {
            // Already written: the same part again.
            if last && !meta.complete {
                meta.complete = true;
                self.write_meta(id, &meta).map_err(failed)?;
            }
            return Ok(size);
        }
        if meta.complete || offset != size {
            return Err(AttachError::Invalid("parts are sent in order, once"));
        }
        if end > limit {
            self.remove_locked(id);
            return Err(AttachError::TooLarge);
        }
        if self.stored_bytes_locked().saturating_sub(size) + end > self.max_bytes {
            // What waits already takes the room: this one gives its place up, not the others.
            self.remove_locked(id);
            return Err(AttachError::Full);
        }
        // The record first, so a part without one is never left behind.
        meta.complete = last;
        let written = (|| -> Result<()> {
            if size == 0 {
                self.write_meta(id, &Meta { complete: false, ..clone(&meta) })?;
            }
            let mut file = private_file(&path, false)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            if last {
                self.write_meta(id, &meta)?;
            }
            Ok(())
        })();
        written.map_err(failed)?;
        Ok(end)
    }

    /// The complete uploads `ids` of `owner`, as the session manager takes
    /// images. `Err` names the first one that is not there (never uploaded
    /// in full, someone else's, already sent or expired).
    pub fn load(&self, owner: &str, ids: &[String]) -> Result<Vec<ImageInput>, String> {
        let _guard = self.lock.lock().unwrap();
        let mut images = Vec::with_capacity(ids.len());
        for id in ids {
            let found = self.complete(owner, id).filter(|meta| !meta.file);
            let (Some(meta), Ok(bytes)) = (found, fs::read(self.data(id))) else { return Err(id.clone()) };
            images.push(ImageInput { media_type: meta.media_type, data: STANDARD.encode(bytes), name: meta.name });
        }
        Ok(images)
    }

    /// `owner`'s complete upload `id`, if there is one.
    fn complete(&self, owner: &str, id: &str) -> Option<Meta> {
        valid_id(id).then(|| self.meta(id)).flatten().filter(|meta| meta.complete && meta.owner == owner)
    }

    /// Whether every one of `ids` is a complete file upload of `owner`'s.
    /// `Err` names the first that is not, as [`Self::load`] does.
    pub fn check_files(&self, owner: &str, ids: &[String]) -> Result<(), String> {
        let _guard = self.lock.lock().unwrap();
        match ids.iter().find(|id| self.complete(owner, id).is_none_or(|meta| !meta.file) || !self.data(id).is_file()) {
            Some(id) => Err(id.clone()),
            None => Ok(()),
        }
    }

    /// Move `owner`'s complete file uploads `ids` into one new folder of
    /// session `session_id`'s attachments folder on this computer, and
    /// return what the message hands the agent: their paths here. The
    /// uploads are gone once stored; nothing is stored if one is missing.
    pub fn take_files(&self, owner: &str, session_id: &str, ids: &[String]) -> Result<Vec<FileRef>, FilesError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let _guard = self.lock.lock().unwrap();
        let mut inputs = Vec::with_capacity(ids.len());
        for id in ids {
            let found = self.complete(owner, id).filter(|meta| meta.file && self.data(id).is_file());
            let Some(meta) = found else { return Err(FilesError::Missing(id.clone())) };
            inputs.push(FileInput {
                name: meta.name.unwrap_or_default(),
                path: Some(self.data(id).to_string_lossy().into_owned()),
                data: None,
                media_type: Some(meta.media_type).filter(|media_type| media_type != UNKNOWN_MEDIA_TYPE),
            });
        }
        let stored = crate::attachments::store(session_id, &inputs).map_err(FilesError::Failed)?;
        for id in ids {
            self.remove_locked(id);
        }
        Ok(stored)
    }

    /// The message that named them was typed (or will never be).
    pub fn remove(&self, ids: &[String]) {
        let _guard = self.lock.lock().unwrap();
        for id in ids.iter().filter(|id| valid_id(id)) {
            self.remove_locked(id);
        }
    }

    /// As `remove`, for the uploads among `ids` that are `owner`'s.
    pub fn remove_owned(&self, owner: &str, ids: &[String]) {
        let _guard = self.lock.lock().unwrap();
        for id in ids.iter().filter(|id| valid_id(id)) {
            if self.meta(id).is_some_and(|meta| meta.owner == owner) {
                self.remove_locked(id);
            }
        }
    }

    /// The bytes every waiting upload holds.
    fn stored_bytes_locked(&self) -> u64 {
        self.ids().iter().filter_map(|id| fs::metadata(self.data(id)).ok()).map(|file| file.len()).sum()
    }

    fn remove_locked(&self, id: &str) {
        let _ = fs::remove_file(self.data(id));
        let _ = fs::remove_file(self.meta_path(id));
    }

    /// Drop what was uploaded more than a day ago and never sent.
    /// `keep` names uploads a queued message still waits for.
    pub fn prune(&self, now: u64, keep: &[String]) {
        let _guard = self.lock.lock().unwrap();
        for id in self.ids() {
            let old = self.meta(&id).is_none_or(|meta| now.saturating_sub(meta.at) > KEEP_FOR_MS);
            if old && !keep.contains(&id) {
                self.remove_locked(&id);
            }
        }
    }

    /// Within an upload: only what nothing can still be waiting for, an
    /// upload that was never completed.
    fn prune_locked(&self, now: u64) {
        for id in self.ids() {
            if self.meta(&id).is_none_or(|meta| !meta.complete && now.saturating_sub(meta.at) > KEEP_FOR_MS) {
                self.remove_locked(&id);
            }
        }
    }
}

fn clone(meta: &Meta) -> Meta {
    Meta { owner: meta.owner.clone(), media_type: meta.media_type.clone(), name: meta.name.clone(), complete: meta.complete, at: meta.at, file: meta.file }
}

/// Readable by the runtime's user only. `replace` truncates; otherwise appends.
fn private_file(path: &Path, replace: bool) -> Result<fs::File> {
    let mut options = OpenOptions::new();
    options.create(true);
    if replace {
        options.write(true).truncate(true);
    } else {
        options.append(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).with_context(|| format!("open {}", path.display()))
}

/// The attachment ids a message's plaintext names (`images: [{ id }]`).
/// `None` when the field is not that, or names more than a message may carry.
pub fn named(plaintext: &serde_json::Value) -> Option<Vec<String>> {
    named_in(plaintext, "images", MAX_IMAGES)
}

/// The file uploads a message's plaintext names (`files: [{ id }]`,
/// PRO-407). `None` as for [`named`], or when its images and files together
/// are more than [`MAX_FILES_PER_MESSAGE`], or one id is named as both.
pub fn named_files(plaintext: &serde_json::Value) -> Option<Vec<String>> {
    let files = named_in(plaintext, "files", MAX_FILES)?;
    let images = named(plaintext)?;
    (images.len() + files.len() <= MAX_FILES_PER_MESSAGE && !files.iter().any(|id| images.contains(id))).then_some(files)
}

/// Both lists a message's plaintext names, or `None` as [`named_files`] says.
pub fn named_all(plaintext: &serde_json::Value) -> Option<Vec<String>> {
    let files = named_files(plaintext)?;
    let mut ids = named(plaintext)?;
    ids.extend(files);
    Some(ids)
}

/// Every well-formed upload id a message names in `images` or `files`, even
/// when the lists are not valid as a whole: what a refused message gives up.
pub fn named_any(plaintext: &serde_json::Value) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for field in ["images", "files"] {
        let entries = plaintext.get(field).and_then(serde_json::Value::as_array).map(Vec::as_slice).unwrap_or_default();
        for id in entries.iter().take(MAX_STORED).filter_map(|entry| entry.get("id").and_then(serde_json::Value::as_str)) {
            if valid_id(id) && !ids.iter().any(|known| known == id) {
                ids.push(id.to_string());
            }
        }
    }
    ids
}

fn named_in(plaintext: &serde_json::Value, field: &str, max: usize) -> Option<Vec<String>> {
    let Some(entries) = plaintext.get(field) else { return Some(Vec::new()) };
    let list = entries.as_array()?;
    if list.len() > max {
        return None;
    }
    let mut ids = Vec::with_capacity(list.len());
    for image in list {
        let id = image.get("id").and_then(serde_json::Value::as_str).filter(|id| valid_id(id))?;
        if ids.iter().any(|known| known == id) {
            return None;
        }
        ids.push(id.to_string());
    }
    Some(ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "attach-0001";

    fn store() -> (tempfile::TempDir, Attachments) {
        let dir = tempfile::tempdir().unwrap();
        let attachments = Attachments::open(dir.path()).unwrap();
        (dir, attachments)
    }

    #[test]
    fn an_image_is_uploaded_in_parts_and_read_once_complete() {
        let (_dir, store) = store();
        assert_eq!(store.write_part("alice", ID, 0, b"abc", "image/png", Some("shot.png"), false, false, 1), Ok(3));
        assert_eq!(store.load("alice", &[ID.into()]).err(), Some(ID.to_string()), "not complete yet");
        // The same part again (its answer was lost) changes nothing.
        assert_eq!(store.write_part("alice", ID, 0, b"abc", "image/png", Some("shot.png"), false, false, 2), Ok(3));
        assert_eq!(store.write_part("alice", ID, 3, b"def", "image/png", Some("shot.png"), false, true, 3), Ok(6));
        assert_eq!(store.write_part("alice", ID, 3, b"def", "image/png", Some("shot.png"), false, true, 4), Ok(6));
        let images = store.load("alice", &[ID.into()]).unwrap();
        assert_eq!((images[0].media_type.as_str(), images[0].data.as_str(), images[0].name.as_deref()), ("image/png", "YWJjZGVm", Some("shot.png")));
        // Complete: nothing is appended to it.
        assert!(matches!(store.write_part("alice", ID, 6, b"x", "image/png", None, false, true, 5), Err(AttachError::Invalid(_))));
        store.remove(&[ID.into()]);
        assert_eq!(store.load("alice", &[ID.into()]).err(), Some(ID.to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn uploads_are_private_files_outside_the_workspace_tree() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, store) = store();
        store.write_part("alice", ID, 0, b"abc", "image/png", None, false, true, 1).unwrap();
        for entry in fs::read_dir(dir.path().join("attachments")).unwrap().flatten() {
            assert_eq!(entry.metadata().unwrap().permissions().mode() & 0o777, 0o600, "{:?}", entry.path());
        }
        assert_eq!(fs::metadata(dir.path().join("attachments")).unwrap().permissions().mode() & 0o777, 0o700);
    }

    #[test]
    fn an_upload_is_its_owners_only() {
        let (_dir, store) = store();
        store.write_part("alice", ID, 0, b"abc", "image/png", None, false, true, 1).unwrap();
        assert_eq!(store.load("bob", &[ID.into()]).err(), Some(ID.to_string()));
        assert!(matches!(store.write_part("bob", ID, 0, b"zzz", "image/png", None, false, true, 2), Err(AttachError::Invalid(_))));
        assert_eq!(store.load("alice", &[ID.into()]).unwrap()[0].data, "YWJj");
    }

    #[test]
    fn what_is_not_an_image_too_large_or_out_of_order_is_refused() {
        let (_dir, store) = store();
        assert!(matches!(store.write_part("alice", ID, 0, b"x", "text/html", None, false, true, 1), Err(AttachError::Invalid(_))));
        assert!(matches!(store.write_part("alice", "../etc/passwd", 0, b"x", "image/png", None, false, true, 1), Err(AttachError::Invalid(_))));
        assert!(matches!(store.write_part("alice", ID, 5, b"x", "image/png", None, false, false, 1), Err(AttachError::Invalid(_))));
        assert!(matches!(store.write_part("alice", ID, 0, &vec![0; PART_BYTES + 1], "image/png", None, false, false, 1), Err(AttachError::Invalid(_))));
        assert!(matches!(store.write_part("alice", ID, 0, b"", "image/png", None, false, true, 1), Err(AttachError::Invalid(_))));
        let part = vec![7u8; PART_BYTES];
        let mut offset = 0u64;
        let outcome = loop {
            match store.write_part("alice", ID, offset, &part, "image/png", None, false, false, 1) {
                Ok(size) => offset = size,
                Err(error) => break error,
            }
        };
        assert_eq!(outcome, AttachError::TooLarge);
        assert!(offset <= MAX_IMAGE_BYTES);
        // What was too large is gone, and its id starts over.
        assert_eq!(store.write_part("alice", ID, 0, b"abc", "image/png", None, false, true, 1), Ok(3));
    }

    #[test]
    fn uploads_never_sent_are_dropped_after_a_day_and_the_store_is_bounded() {
        let (_dir, store) = store();
        for index in 0..MAX_STORED {
            store.write_part("alice", &format!("attach-{index:04}"), 0, b"abc", "image/png", None, false, true, 1).unwrap();
        }
        assert_eq!(store.write_part("alice", "attach-overflow", 0, b"abc", "image/png", None, false, true, 2), Err(AttachError::Full));
        let waiting = "attach-0007".to_string();
        store.prune(1 + KEEP_FOR_MS + 1, std::slice::from_ref(&waiting));
        assert!(store.load("alice", std::slice::from_ref(&waiting)).is_ok(), "a queued message still waits for it");
        assert_eq!(store.ids().len(), 1);
        assert_eq!(store.write_part("alice", "attach-overflow", 0, b"abc", "image/png", None, false, true, 3), Ok(3));
    }

    #[test]
    fn only_an_uploads_owner_removes_it_by_name() {
        let (_dir, store) = store();
        store.write_part("alice", ID, 0, b"abc", "image/png", None, false, true, 1).unwrap();
        store.remove_owned("bob", &[ID.into()]);
        assert!(store.load("alice", &[ID.into()]).is_ok());
        store.remove_owned("alice", &[ID.into(), "../x".into()]);
        assert!(store.load("alice", &[ID.into()]).is_err());
    }

    #[test]
    fn a_file_is_uploaded_in_parts_and_taken_into_its_sessions_attachments_folder() {
        let _home = crate::store::temp_home();
        let (_dir, store) = store();
        // A name is its last segment only: a path of the sender's computer never names a stored file.
        assert_eq!(store.write_part("alice", ID, 0, b"# Plan\n", "text/markdown", Some("/Users/alice/secret/plan.md"), true, false, 1), Ok(7));
        assert_eq!(store.check_files("alice", &[ID.into()]), Err(ID.to_string()), "not complete yet");
        assert_eq!(store.write_part("alice", ID, 7, b"- ship\n", "text/markdown", None, true, true, 2), Ok(14));
        // A file is never handed over as an image, and is no one else's.
        assert_eq!(store.load("alice", &[ID.into()]).err(), Some(ID.to_string()));
        assert_eq!(store.check_files("bob", &[ID.into()]), Err(ID.to_string()));
        assert!(matches!(store.take_files("bob", "session-1", &[ID.into()]), Err(FilesError::Missing(_))));
        assert_eq!(store.check_files("alice", &[ID.into()]), Ok(()));

        let files = store.take_files("alice", "session-1", &[ID.into()]).unwrap();
        assert_eq!((files[0].name.as_str(), files[0].media_type.as_deref(), files[0].size), ("plan.md", Some("text/markdown"), Some(14)));
        let folder = crate::store::attachments_dir("session-1").unwrap().canonicalize().unwrap();
        let path = Path::new(&files[0].path);
        assert!(path.starts_with(&folder), "{path:?} is in {folder:?}");
        assert!(!files[0].path.contains("/Users/alice"), "{:?}", files[0].path);
        assert_eq!(fs::read(path).unwrap(), b"# Plan\n- ship\n");
        // Taken once: the upload is gone, so a message naming it again is refused.
        assert_eq!(store.check_files("alice", &[ID.into()]), Err(ID.to_string()));
        assert!(store.ids().is_empty());
    }

    #[test]
    fn a_file_with_a_reserved_name_an_odd_type_or_too_many_bytes_is_refused() {
        let _home = crate::store::temp_home();
        let (_dir, store) = store();
        assert!(matches!(store.write_part("alice", ID, 0, b"{}", "application/json", Some("terminalx.json"), true, true, 1), Err(AttachError::Refused(_))));
        assert!(matches!(store.write_part("alice", ID, 0, b"x", "text/plain", None, true, true, 1), Err(AttachError::Refused(_))), "a file needs a name");
        assert!(matches!(store.write_part("alice", ID, 0, b"x", "not a type", Some("a.txt"), true, true, 1), Err(AttachError::Invalid(_))));
        // An image and a file never share an id.
        store.write_part("alice", ID, 0, b"abc", "image/png", None, false, true, 1).unwrap();
        assert!(matches!(store.write_part("alice", ID, 0, b"abc", "image/png", Some("a.png"), true, true, 1), Err(AttachError::Invalid(_))));
        // Any type, an unknown one too, and an empty file.
        assert_eq!(store.write_part("alice", "attach-0002", 0, b"", "", Some("empty.log"), true, true, 1), Ok(0));
        assert_eq!(store.write_part("alice", "attach-0002", 0, b"", "", Some("empty.log"), true, true, 2), Ok(0), "sent again");
        let empty = store.take_files("alice", "session-1", &["attach-0002".into()]).unwrap();
        assert_eq!((empty[0].size, fs::read(&empty[0].path).unwrap().len()), (Some(0), 0));
        // 25 MB, as a local tab's composer allows; not one byte more.
        let part = vec![7u8; PART_BYTES];
        let mut offset = 0u64;
        let outcome = loop {
            match store.write_part("alice", "attach-0003", offset, &part, "application/zip", Some("big.zip"), true, false, 1) {
                Ok(size) => offset = size,
                Err(error) => break error,
            }
        };
        assert_eq!(outcome, AttachError::TooLarge);
        assert!(offset > MAX_IMAGE_BYTES && offset <= MAX_ATTACHMENT_BYTES, "{offset}");
        assert_eq!(store.check_files("alice", &["attach-0003".into()]), Err("attach-0003".to_string()), "what was too large is gone");
    }

    #[test]
    fn a_message_names_at_most_ten_images_and_files_together() {
        let ids = |prefix: &str, n: usize| (0..n).map(|index| serde_json::json!({ "id": format!("{prefix}-{index:04}") })).collect::<Vec<_>>();
        assert_eq!(named_files(&serde_json::json!({ "text": "hi" })), Some(Vec::new()));
        assert_eq!(named_files(&serde_json::json!({ "files": [{ "id": ID, "name": "a.md" }] })), Some(vec![ID.to_string()]));
        assert_eq!(named_files(&serde_json::json!({ "files": ids("file", 10) })).map(|ids| ids.len()), Some(10));
        assert_eq!(named_files(&serde_json::json!({ "files": ids("file", 11) })), None);
        assert_eq!(named_files(&serde_json::json!({ "images": ids("image", 8), "files": ids("file", 2) })).map(|ids| ids.len()), Some(2));
        assert_eq!(named_files(&serde_json::json!({ "images": ids("image", 8), "files": ids("file", 3) })), None);
        assert_eq!(named_files(&serde_json::json!({ "images": [{ "id": ID }], "files": [{ "id": ID }] })), None, "one upload is an image or a file");
        assert_eq!(named_files(&serde_json::json!({ "files": [{ "id": "../x" }] })), None);
        assert_eq!(named_all(&serde_json::json!({ "images": [{ "id": ID }], "files": [{ "id": "attach-0002" }] })), Some(vec![ID.to_string(), "attach-0002".to_string()]));
    }

    #[test]
    fn waiting_uploads_hold_at_most_their_byte_budget_together() {
        // The budget holds one full message of files at the largest size.
        assert!(MAX_STORED_BYTES >= MAX_FILES as u64 * MAX_ATTACHMENT_BYTES);
        let (_dir, mut store) = store();
        store.max_bytes = 10;
        assert_eq!(store.write_part("alice", "attach-0001", 0, b"abcd", "text/plain", Some("a.txt"), true, true, 1), Ok(4));
        assert_eq!(store.write_part("alice", "attach-0002", 0, b"abc", "text/plain", Some("b.txt"), true, false, 1), Ok(3));
        // A part past the budget: this upload gives its place up, the others stay.
        assert_eq!(store.write_part("alice", "attach-0002", 3, b"defg", "text/plain", None, true, true, 1), Err(AttachError::Full));
        assert_eq!(store.ids(), vec!["attach-0001".to_string()]);
        assert_eq!(store.write_part("alice", "attach-0003", 0, b"x".repeat(7).as_slice(), "text/plain", Some("c.txt"), true, true, 1), Err(AttachError::Full));
        assert_eq!(store.write_part("alice", "attach-0003", 0, b"x".repeat(6).as_slice(), "text/plain", Some("c.txt"), true, true, 1), Ok(6));
        assert_eq!(store.stored_bytes_locked(), 10);
    }

    #[test]
    fn a_refused_message_names_its_well_formed_uploads_even_in_a_malformed_list() {
        let body = serde_json::json!({ "images": [{ "id": ID }, { "id": "../x" }, "junk"], "files": [{ "id": "attach-0002" }, { "id": ID }] });
        assert_eq!(named(&body), None);
        assert_eq!(named_any(&body), vec![ID.to_string(), "attach-0002".to_string()]);
        assert_eq!(named_any(&serde_json::json!({ "images": "all", "files": [{ "id": "attach-0002" }] })), vec!["attach-0002".to_string()]);
    }

    #[test]
    fn a_message_names_at_most_eight_distinct_uploads() {
        let named_in = |value: serde_json::Value| named(&value);
        assert_eq!(named_in(serde_json::json!({ "text": "hi" })), Some(Vec::new()));
        assert_eq!(named_in(serde_json::json!({ "images": [{ "id": ID, "name": "a.png" }] })), Some(vec![ID.to_string()]));
        assert_eq!(named_in(serde_json::json!({ "images": [{ "id": ID }, { "id": ID }] })), None);
        assert_eq!(named_in(serde_json::json!({ "images": [{ "id": "../x" }] })), None);
        assert_eq!(named_in(serde_json::json!({ "images": "all" })), None);
        let many: Vec<_> = (0..=MAX_IMAGES).map(|index| serde_json::json!({ "id": format!("attach-{index:04}") })).collect();
        assert_eq!(named_in(serde_json::json!({ "images": many })), None);
    }
}
