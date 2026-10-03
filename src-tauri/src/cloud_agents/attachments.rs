//! Images a person attaches to a message for a cloud agent tab (PRO-22).
//!
//! A mailbox command holds at most 64 KiB and an RPC frame 1 MiB, so an
//! image does not travel inside the message. The desktop uploads it to the
//! runtime first, in parts, over the end-to-end encrypted connection
//! (`session.attach`), and the message names it by id. Here it waits, in the
//! runtime's private state directory and never in the workspace tree, until
//! that message is typed: then it is handed to the agent exactly as a local
//! tab's image is, and removed.
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

use crate::session::ImageInput;

/// One part of an upload, before base64: it fits a frame with room to spare.
pub const PART_BYTES: usize = 384 * 1024;
/// As a local tab's composer accepts.
pub const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
/// Images one message may carry.
pub const MAX_IMAGES: usize = 8;
/// Uploads kept at once, for everyone together.
const MAX_STORED: usize = 64;
const KEEP_FOR_MS: u64 = 24 * 60 * 60 * 1000;
const MEDIA_TYPES: [&str; 4] = ["image/png", "image/jpeg", "image/gif", "image/webp"];

#[derive(Debug, PartialEq, Eq)]
pub enum AttachError {
    /// The request itself is wrong; the sentence says how.
    Invalid(&'static str),
    TooLarge,
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
}

pub struct Attachments {
    dir: PathBuf,
    /// One upload or read at a time: parts are small and rare.
    lock: Mutex<()>,
}

/// 8-128 letters, digits, `-` or `_`: also safe as a file name.
pub fn valid_id(id: &str) -> bool {
    (8..=128).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Attachments {
    pub fn open(state_dir: &Path) -> Result<Self> {
        let dir = state_dir.join("attachments");
        crate::cloud_bootstrap::ensure_private_dir(&dir)?;
        Ok(Self { dir, lock: Mutex::new(()) })
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
    #[allow(clippy::too_many_arguments)]
    pub fn write_part(&self, owner: &str, id: &str, offset: u64, bytes: &[u8], media_type: &str, name: Option<&str>, last: bool, now: u64) -> Result<u64, AttachError> {
        if !valid_id(id) {
            return Err(AttachError::Invalid("attachmentId is 8-128 letters, digits, '-' or '_'"));
        }
        if !MEDIA_TYPES.contains(&media_type) {
            return Err(AttachError::Invalid("only PNG, JPEG, GIF and WebP images can be attached"));
        }
        if bytes.len() > PART_BYTES {
            return Err(AttachError::Invalid("the part is too large"));
        }
        if bytes.is_empty() {
            return Err(AttachError::Invalid("the part is empty"));
        }
        let failed = |error: anyhow::Error| AttachError::Failed(format!("{error:#}"));
        let _guard = self.lock.lock().unwrap();
        self.prune_locked(now);
        let existing = self.meta(id);
        let mut meta = match existing {
            // Someone else's id reads as one that cannot be used, nothing more.
            Some(meta) if meta.owner != owner || meta.media_type != media_type => return Err(AttachError::Invalid("this attachmentId is already in use")),
            Some(meta) => meta,
            None if offset != 0 => return Err(AttachError::Invalid("the upload starts at offset 0")),
            None if self.ids().len() >= MAX_STORED => return Err(AttachError::Full),
            None => Meta { owner: owner.to_string(), media_type: media_type.to_string(), name: name.map(|name| name.chars().take(200).collect()), complete: false, at: now },
        };
        let path = self.data(id);
        let size = fs::metadata(&path).map(|file| file.len()).unwrap_or(0);
        let end = offset + bytes.len() as u64;
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
        if end > MAX_IMAGE_BYTES {
            self.remove_locked(id);
            return Err(AttachError::TooLarge);
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
            let found = valid_id(id).then(|| self.meta(id)).flatten().filter(|meta| meta.complete && meta.owner == owner);
            let (Some(meta), Ok(bytes)) = (found, fs::read(self.data(id))) else { return Err(id.clone()) };
            images.push(ImageInput { media_type: meta.media_type, data: STANDARD.encode(bytes), name: meta.name });
        }
        Ok(images)
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
    Meta { owner: meta.owner.clone(), media_type: meta.media_type.clone(), name: meta.name.clone(), complete: meta.complete, at: meta.at }
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
    let Some(images) = plaintext.get("images") else { return Some(Vec::new()) };
    let list = images.as_array()?;
    if list.len() > MAX_IMAGES {
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
        assert_eq!(store.write_part("alice", ID, 0, b"abc", "image/png", Some("shot.png"), false, 1), Ok(3));
        assert_eq!(store.load("alice", &[ID.into()]).err(), Some(ID.to_string()), "not complete yet");
        // The same part again (its answer was lost) changes nothing.
        assert_eq!(store.write_part("alice", ID, 0, b"abc", "image/png", Some("shot.png"), false, 2), Ok(3));
        assert_eq!(store.write_part("alice", ID, 3, b"def", "image/png", Some("shot.png"), true, 3), Ok(6));
        assert_eq!(store.write_part("alice", ID, 3, b"def", "image/png", Some("shot.png"), true, 4), Ok(6));
        let images = store.load("alice", &[ID.into()]).unwrap();
        assert_eq!((images[0].media_type.as_str(), images[0].data.as_str(), images[0].name.as_deref()), ("image/png", "YWJjZGVm", Some("shot.png")));
        // Complete: nothing is appended to it.
        assert!(matches!(store.write_part("alice", ID, 6, b"x", "image/png", None, true, 5), Err(AttachError::Invalid(_))));
        store.remove(&[ID.into()]);
        assert_eq!(store.load("alice", &[ID.into()]).err(), Some(ID.to_string()));
    }

    #[cfg(unix)]
    #[test]
    fn uploads_are_private_files_outside_the_workspace_tree() {
        use std::os::unix::fs::PermissionsExt;
        let (dir, store) = store();
        store.write_part("alice", ID, 0, b"abc", "image/png", None, true, 1).unwrap();
        for entry in fs::read_dir(dir.path().join("attachments")).unwrap().flatten() {
            assert_eq!(entry.metadata().unwrap().permissions().mode() & 0o777, 0o600, "{:?}", entry.path());
        }
        assert_eq!(fs::metadata(dir.path().join("attachments")).unwrap().permissions().mode() & 0o777, 0o700);
    }

    #[test]
    fn an_upload_is_its_owners_only() {
        let (_dir, store) = store();
        store.write_part("alice", ID, 0, b"abc", "image/png", None, true, 1).unwrap();
        assert_eq!(store.load("bob", &[ID.into()]).err(), Some(ID.to_string()));
        assert!(matches!(store.write_part("bob", ID, 0, b"zzz", "image/png", None, true, 2), Err(AttachError::Invalid(_))));
        assert_eq!(store.load("alice", &[ID.into()]).unwrap()[0].data, "YWJj");
    }

    #[test]
    fn what_is_not_an_image_too_large_or_out_of_order_is_refused() {
        let (_dir, store) = store();
        assert!(matches!(store.write_part("alice", ID, 0, b"x", "text/html", None, true, 1), Err(AttachError::Invalid(_))));
        assert!(matches!(store.write_part("alice", "../etc/passwd", 0, b"x", "image/png", None, true, 1), Err(AttachError::Invalid(_))));
        assert!(matches!(store.write_part("alice", ID, 5, b"x", "image/png", None, false, 1), Err(AttachError::Invalid(_))));
        assert!(matches!(store.write_part("alice", ID, 0, &vec![0; PART_BYTES + 1], "image/png", None, false, 1), Err(AttachError::Invalid(_))));
        assert!(matches!(store.write_part("alice", ID, 0, b"", "image/png", None, true, 1), Err(AttachError::Invalid(_))));
        let part = vec![7u8; PART_BYTES];
        let mut offset = 0u64;
        let outcome = loop {
            match store.write_part("alice", ID, offset, &part, "image/png", None, false, 1) {
                Ok(size) => offset = size,
                Err(error) => break error,
            }
        };
        assert_eq!(outcome, AttachError::TooLarge);
        assert!(offset <= MAX_IMAGE_BYTES);
        // What was too large is gone, and its id starts over.
        assert_eq!(store.write_part("alice", ID, 0, b"abc", "image/png", None, true, 1), Ok(3));
    }

    #[test]
    fn uploads_never_sent_are_dropped_after_a_day_and_the_store_is_bounded() {
        let (_dir, store) = store();
        for index in 0..MAX_STORED {
            store.write_part("alice", &format!("attach-{index:04}"), 0, b"abc", "image/png", None, true, 1).unwrap();
        }
        assert_eq!(store.write_part("alice", "attach-overflow", 0, b"abc", "image/png", None, true, 2), Err(AttachError::Full));
        let waiting = "attach-0007".to_string();
        store.prune(1 + KEEP_FOR_MS + 1, std::slice::from_ref(&waiting));
        assert!(store.load("alice", std::slice::from_ref(&waiting)).is_ok(), "a queued message still waits for it");
        assert_eq!(store.ids().len(), 1);
        assert_eq!(store.write_part("alice", "attach-overflow", 0, b"abc", "image/png", None, true, 3), Ok(3));
    }

    #[test]
    fn only_an_uploads_owner_removes_it_by_name() {
        let (_dir, store) = store();
        store.write_part("alice", ID, 0, b"abc", "image/png", None, true, 1).unwrap();
        store.remove_owned("bob", &[ID.into()]);
        assert!(store.load("alice", &[ID.into()]).is_ok());
        store.remove_owned("alice", &[ID.into(), "../x".into()]);
        assert!(store.load("alice", &[ID.into()]).is_err());
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
