//! The change log of a bot's role and memory (PRO-470). It is kept outside
//! the bot's home folder, in `bot-changes/<id>/`, where the bot's own work
//! never writes: every add, edit and removal is recorded there with when,
//! what and where it came from, and each one can be undone.
//!
//! Every change the app makes goes through [`commit`], which first looks for
//! edits made to the files outside the app (by the bot with an editor, or by
//! a person) and records those, one change per file at the file's
//! modification time, as "edited outside the app"; then it applies its own
//! edits all or nothing. `known.json` holds each file as the app last saw it,
//! by the hash of its text; a new bot starts from the files hiring wrote.
//!
//! An edit is a line added or removed (the memory files), or a whole text
//! replaced (the role and the topic files). A whole text is kept once, by its
//! hash, in `texts/`; the log names it by that hash. Undoing a change applies
//! its edits backwards and is itself a change; it refuses, writing nothing,
//! when a line is no longer there or a text was changed since.
//!
//! The log is read with a limit and rotated by size, keeping the newest
//! changes; texts no kept change or `known.json` names are then removed.

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read as _, Seek as _};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Digest;

use crate::sink::EventSink;
use crate::store::bots as bot_store;

pub const LOG_FILE: &str = "changes.jsonl";
pub const KNOWN_FILE: &str = "known.json";
pub const TEXTS_DIR: &str = "texts";
/// The event a recorded change is announced with: `{"id": <bot id>}`.
pub const EVENT: &str = "bot_memory_changed";
/// A file larger than this is not followed: it is shown, never diffed.
pub const MAX_TRACKED_BYTES: u64 = 1024 * 1024;
/// Past this size the log is rotated down to its newest half; at most twice this is ever read.
pub const MAX_LOG_BYTES: u64 = 1024 * 1024;
/// More lines than this on both sides of a memory file's edit are recorded as a whole text.
const MAX_DIFF_CELLS: usize = 4_000_000;
/// What a secret taken out of the history reads as.
pub const REDACTED: &str = "[removed: it held a secret]";

/// One change at a time, across every bot: a look for outside edits and the
/// app's own edits are one step.
static LOCK: Mutex<()> = Mutex::new(());

/// Who wrote a change: [`super::OWNER`], a bot's id, or [`OUTSIDE`].
pub const OUTSIDE: &str = "outside";

/// Where a change came from. `kind` is `chat`, `duty`, `app` (by hand in
/// the app), `cli` (the owner's terminal), `outside` (edited outside the
/// app), `budget` (moved to the archive to keep within the line budget) or
/// `undo`; a kind a newer build wrote is kept and shown as itself.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<String>,
    /// The chat's title when the change was made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duty: Option<String>,
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, Value>,
}

impl Source {
    pub fn of(kind: &str) -> Self {
        Self { kind: kind.into(), ..Default::default() }
    }
}

/// One edit to one file of the bot's home, by its path there (`MEMORY.md`,
/// `orgs/<id>/memory/archive.md`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Edit {
    AddLine {
        file: String,
        line: String,
        /// Where it went, counted from 0; at the end when left out.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
        /// The line just above it, so an undo puts a line back under its old
        /// neighbour wherever that moved; at the end of the file when it is gone.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prev: Option<String>,
    },
    RemoveLine {
        file: String,
        line: String,
        /// Where it was; the equal line nearest it is taken when it moved.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prev: Option<String>,
    },
    /// The whole text replaced: `before` and `after` are hashes of texts in
    /// `texts/`, `None` for no file.
    ReplaceText {
        file: String,
        before: Option<String>,
        after: Option<String>,
    },
}

impl Edit {
    pub fn file(&self) -> &str {
        match self {
            Self::AddLine { file, .. } | Self::RemoveLine { file, .. } | Self::ReplaceText { file, .. } => file,
        }
    }

    fn inverse(&self) -> Self {
        match self.clone() {
            Self::AddLine { file, line, index, prev } => Self::RemoveLine { file, line, index, prev },
            Self::RemoveLine { file, line, index, prev } => Self::AddLine { file, line, index, prev },
            Self::ReplaceText { file, before, after } => Self::ReplaceText { file, before: after, after: before },
        }
    }
}

/// One recorded change. `kind` says what it was: `learned` (a note added),
/// `forgot` (a note removed), `archived`, `role` (the standing instructions
/// replaced), `outside` or `undo`; one a newer build wrote is shown as itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub id: String,
    pub at: String,
    pub kind: String,
    /// What changed, in a line: the note itself for a note.
    pub text: String,
    /// Read one by one: an edit a newer build wrote is kept, and makes the change one this build cannot undo.
    pub edits: Vec<Value>,
    pub source: Source,
    pub by: String,
    /// The change this one undid.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undoes: Option<String>,
    /// Each file it touched as it left it, by hash (`None`: no file): a
    /// state already in the log is never recorded again as an outside edit.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub states: BTreeMap<String, Option<String>>,
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, Value>,
}

impl Change {
    /// Its edits, or `None` when one of them is a kind this build does not know.
    pub fn known_edits(&self) -> Option<Vec<Edit>> {
        self.edits.iter().map(|edit| serde_json::from_value(edit.clone()).ok()).collect()
    }
}

/// A change about to be recorded.
#[derive(Debug, Clone)]
pub struct NewChange {
    pub kind: String,
    pub text: String,
    pub edits: Vec<Edit>,
    pub source: Source,
    pub by: String,
    pub undoes: Option<String>,
    /// When it happened, when that is not now: an outside edit's file time.
    pub at: Option<String>,
}

impl NewChange {
    pub fn new(kind: &str, text: impl Into<String>, edits: Vec<Edit>, source: Source, by: &str) -> Self {
        Self { kind: kind.into(), text: text.into(), edits, source, by: by.into(), undoes: None, at: None }
    }
}

/// The log as read: the changes this build reads, oldest first, and how many lines it cannot.
#[derive(Debug, Clone, Default)]
pub struct Log {
    pub changes: Vec<Change>,
    pub unreadable: usize,
}

fn dir(id: &str) -> Result<PathBuf> {
    // The home's own check of the id: one that could name no home has no log either.
    bot_store::home_dir(id)?;
    Ok(crate::store::root()?.join("bot-changes").join(id))
}

pub fn read_log(id: &str) -> Result<Log> {
    let path = dir(id)?.join(LOG_FILE);
    let mut file = match std::fs::File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Log::default()),
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    // Read with a limit: a log grown past it by hand is read from its newest end, from a whole line.
    let len = file.metadata()?.len();
    let cut = len > 2 * MAX_LOG_BYTES;
    if cut {
        file.seek(std::io::SeekFrom::Start(len - 2 * MAX_LOG_BYTES))?;
    }
    let mut bytes = Vec::new();
    file.take(2 * MAX_LOG_BYTES).read_to_end(&mut bytes).with_context(|| format!("read {}", path.display()))?;
    let text = String::from_utf8_lossy(&bytes);
    let mut lines = text.split('\n');
    if cut {
        lines.next();
    }
    let mut log = Log::default();
    for line in lines.filter(|line| !line.trim().is_empty()) {
        match serde_json::from_str::<Change>(line) {
            Ok(change) => log.changes.push(change),
            Err(_) => log.unreadable += 1,
        }
    }
    Ok(log)
}

/// The hash a text is kept by.
pub fn hash_of(text: &str) -> String {
    sha2::Sha256::digest(text.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

fn is_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Keep a text in the bot's `texts/`, once, and answer its hash.
pub fn keep_text(id: &str, text: &str) -> Result<String> {
    let hash = hash_of(text);
    let folder = crate::store::ensure_dir(dir(id)?.join(TEXTS_DIR))?;
    let path = folder.join(format!("{hash}.txt"));
    if !path.is_file() {
        crate::store::write_atomic(&path, text.as_bytes())?;
    }
    Ok(hash)
}

/// A kept text, by its hash; `None` when it is no longer kept.
pub fn kept_text(id: &str, hash: &str) -> Result<Option<String>> {
    if !is_hash(hash) {
        return Ok(None);
    }
    read_file(&dir(id)?.join(TEXTS_DIR).join(format!("{hash}.txt")))
}

/// What the app last saw of each file, by hash.
type Known = BTreeMap<String, String>;

fn read_known(id: &str) -> Result<Option<Known>> {
    let path = dir(id)?.join(KNOWN_FILE);
    let known: Option<Known> = crate::store::read_json(&path).with_context(|| format!("{} cannot be read", path.display()))?;
    // A value that is not a hash is the text itself, as an earlier build kept it.
    known
        .map(|known| known.into_iter().map(|(rel, value)| Ok((rel, if is_hash(&value) { value } else { keep_text(id, &value)? }))).collect())
        .transpose()
}

/// A path inside the home, as an edit names it: plain names only, never out of the home.
pub fn checked(rel: &str) -> Result<()> {
    let path = Path::new(rel);
    let plain = !rel.is_empty()
        && rel.len() <= 255
        && path.components().all(|component| matches!(component, Component::Normal(_)))
        && rel.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/'));
    anyhow::ensure!(plain, "{rel} is not a file of the bot's home");
    Ok(())
}

/// Refuse a path of the home that passes through a link: a folder of the
/// home replaced by a link must not take a read or a write out of it.
pub fn no_links(home: &Path, rel: &str) -> Result<()> {
    checked(rel)?;
    let mut at = home.to_path_buf();
    let home_kind = std::fs::symlink_metadata(&at).with_context(|| format!("read {}", at.display()))?.file_type();
    anyhow::ensure!(home_kind.is_dir(), "the bot's home folder is not a folder");
    let parts: Vec<_> = Path::new(rel).components().collect();
    for part in &parts[..parts.len().saturating_sub(1)] {
        at.push(part);
        match std::fs::symlink_metadata(&at) {
            Ok(meta) => anyhow::ensure!(meta.file_type().is_dir(), "{} is not a folder; it is left as it is", at.display()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error).with_context(|| format!("read {}", at.display())),
        }
    }
    Ok(())
}

/// Open a file for reading without following a link in its last part:
/// a link there fails to open rather than being read through.
pub fn open_no_follow(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    options.open(path)
}

/// Whether an open error is the no-follow refusal of a link.
pub fn is_link_refusal(error: &std::io::Error) -> bool {
    #[cfg(unix)]
    {
        error.raw_os_error() == Some(libc::ELOOP)
    }
    #[cfg(not(unix))]
    {
        let _ = error;
        false
    }
}

/// What a file holds now: `None` when there is none. A file that is not a
/// regular one (a link, a folder) or is too large is refused, and left as it is.
pub fn read_file(path: &Path) -> Result<Option<String>> {
    let file = match open_no_follow(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) if is_link_refusal(&error) => anyhow::bail!("{} is not a regular file; it is left as it is", path.display()),
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    let meta = file.metadata().with_context(|| format!("read {}", path.display()))?;
    anyhow::ensure!(meta.file_type().is_file(), "{} is not a regular file; it is left as it is", path.display());
    anyhow::ensure!(meta.len() <= MAX_TRACKED_BYTES, "{} is larger than {} KB; it is left as it is", path.display(), MAX_TRACKED_BYTES / 1024);
    let mut bytes = Vec::new();
    file.take(MAX_TRACKED_BYTES + 1).read_to_end(&mut bytes).with_context(|| format!("read {}", path.display()))?;
    anyhow::ensure!(bytes.len() as u64 <= MAX_TRACKED_BYTES, "{} is larger than {} KB; it is left as it is", path.display(), MAX_TRACKED_BYTES / 1024);
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// The lines of a text, as the line edits count them.
pub fn lines_of(text: &str) -> Vec<String> {
    text.lines().map(str::to_owned).collect()
}

fn text_of(lines: &[String]) -> String {
    if lines.is_empty() { String::new() } else { format!("{}\n", lines.join("\n")) }
}

/// Whether a file's edits are by line: the memory files and their archives. The role and topic files are whole texts.
pub fn by_line(rel: &str) -> bool {
    let name = rel.rsplit('/').next().unwrap_or(rel);
    name == bot_store::MEMORY_FILE || name == super::memory::ARCHIVE_FILE
}

/// The files of a bot's home as one change sees them: read once, changed in
/// memory, written together when the change is recorded.
pub struct Files {
    id: String,
    home: PathBuf,
    texts: BTreeMap<String, Option<String>>,
    touched: BTreeSet<String>,
    recorded: Vec<NewChange>,
}

/// Where a line goes back: under its old neighbour nearest where it was, at
/// the top when it was first, and at the end when its neighbour is gone.
fn insert_at(lines: &[String], index: Option<usize>, prev: Option<&String>) -> usize {
    match (prev, index) {
        (Some(prev), _) => {
            let near = index.unwrap_or(lines.len());
            lines.iter().enumerate().filter(|(_, line)| *line == prev).min_by_key(|(at, _)| (at + 1).abs_diff(near)).map_or(lines.len(), |(at, _)| at + 1)
        }
        (None, Some(0)) => 0,
        (None, Some(at)) if at <= lines.len() => at,
        _ => lines.len(),
    }
}

impl Files {
    fn new(id: &str, home: PathBuf) -> Self {
        Self { id: id.into(), home, texts: BTreeMap::new(), touched: BTreeSet::new(), recorded: Vec::new() }
    }

    pub fn get(&mut self, rel: &str) -> Result<Option<String>> {
        checked(rel)?;
        if let Some(text) = self.texts.get(rel) {
            return Ok(text.clone());
        }
        no_links(&self.home, rel)?;
        let text = read_file(&self.home.join(rel))?;
        self.texts.insert(rel.into(), text.clone());
        Ok(text)
    }

    pub fn lines(&mut self, rel: &str) -> Result<Vec<String>> {
        Ok(self.get(rel)?.as_deref().map(lines_of).unwrap_or_default())
    }

    fn set(&mut self, rel: &str, text: Option<String>) {
        self.texts.insert(rel.into(), text);
        self.touched.insert(rel.into());
    }

    /// The edit that replaces a file's whole text with `text` (`None`: no file), its texts kept by hash.
    pub fn replacing(&mut self, rel: &str, text: Option<&str>) -> Result<Edit> {
        let before = self.get(rel)?.map(|before| keep_text(&self.id, &before)).transpose()?;
        let after = text.map(|after| keep_text(&self.id, after)).transpose()?;
        Ok(Edit::ReplaceText { file: rel.into(), before, after })
    }

    fn apply(&mut self, edit: &Edit) -> Result<()> {
        let rel = edit.file();
        match edit {
            Edit::AddLine { line, index, prev, .. } => {
                let mut lines = self.lines(rel)?;
                let at = insert_at(&lines, *index, prev.as_ref());
                lines.insert(at, line.clone());
                self.set(rel, Some(text_of(&lines)));
            }
            Edit::RemoveLine { line, index, .. } => {
                let mut lines = self.lines(rel)?;
                let near = index.unwrap_or(0);
                let at = lines
                    .iter()
                    .enumerate()
                    .filter(|(_, known)| *known == line)
                    .min_by_key(|(at, _)| at.abs_diff(near))
                    .map(|(at, _)| at)
                    .ok_or_else(|| super::refused(format!("“{}” is no longer in {rel}.", line.trim())))?;
                lines.remove(at);
                self.set(rel, Some(text_of(&lines)));
            }
            Edit::ReplaceText { before, after, .. } => {
                let now = self.get(rel)?;
                let same = match (now.as_deref(), before.as_deref()) {
                    (None, None) => true,
                    (Some(now), Some(hash)) => hash_of(now) == hash || kept_text(&self.id, hash)?.is_some_and(|before| before.trim_end() == now.trim_end()),
                    _ => false,
                };
                if !same {
                    return Err(super::refused(format!("{rel} was changed since; that change is not undone.")));
                }
                let text = match after {
                    Some(hash) => Some(kept_text(&self.id, hash)?.ok_or_else(|| super::refused(format!("The text of {rel} that change left is no longer kept.")))?),
                    None => None,
                };
                self.set(rel, text);
            }
        }
        Ok(())
    }

    /// Apply a change's edits and keep it to be recorded. A refused edit refuses the whole change: nothing is written.
    pub fn record(&mut self, change: NewChange) -> Result<()> {
        for edit in &change.edits {
            checked(edit.file())?;
            self.apply(edit)?;
        }
        if !change.edits.is_empty() {
            self.recorded.push(change);
        }
        Ok(())
    }

    fn write(&self) -> Result<()> {
        for rel in &self.touched {
            no_links(&self.home, rel)?;
            let path = self.home.join(rel);
            match &self.texts[rel] {
                Some(text) => {
                    if let Some(parent) = path.parent() {
                        crate::store::ensure_dir(parent.to_path_buf())?;
                    }
                    if let Ok(meta) = std::fs::symlink_metadata(&path) {
                        anyhow::ensure!(meta.file_type().is_file(), "{} is not a regular file; it is left as it is", path.display());
                    }
                    crate::store::write_atomic(&path, text.as_bytes())?;
                }
                None => match std::fs::remove_file(&path) {
                    Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error).with_context(|| format!("remove {}", path.display())),
                    _ => {}
                },
            }
        }
        Ok(())
    }
}

/// Every file of a home the log follows, by its path there: the role, each
/// place's memory file and the notes in its `memory/` folder.
fn followed(home: &Path) -> Vec<String> {
    let mut files = vec![bot_store::ROLE_FILE.to_string()];
    let mut places = vec![String::new(), format!("{}/", super::PERSONAL)];
    if let Ok(entries) = std::fs::read_dir(home.join(super::memory::ORGS_DIR)) {
        let mut orgs: Vec<String> = entries.flatten().filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir())).filter_map(|entry| entry.file_name().to_str().map(str::to_owned)).collect();
        orgs.sort();
        places.extend(orgs.into_iter().map(|org| format!("{}/{org}/", super::memory::ORGS_DIR)));
    }
    for place in places {
        files.push(format!("{place}{}", bot_store::MEMORY_FILE));
        if let Ok(entries) = std::fs::read_dir(home.join(&place).join(bot_store::MEMORY_DIR)) {
            let mut notes: Vec<String> = entries.flatten().filter_map(|entry| entry.file_name().to_str().map(str::to_owned)).filter(|name| name.ends_with(".md")).collect();
            notes.sort();
            files.extend(notes.into_iter().map(|name| format!("{place}{}/{name}", bot_store::MEMORY_DIR)));
        }
    }
    files.retain(|rel| checked(rel).is_ok());
    files
}

/// One line of a diff, as the role's history shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// `same`, `added` or `removed`.
    pub kind: &'static str,
    pub text: String,
}

/// The lines from `before` to `after`: the longest run they share kept, the rest removed or added.
/// `None` when the texts are too long to compare line by line.
pub fn diff(before: &[String], after: &[String]) -> Option<Vec<DiffLine>> {
    let prefix = before.iter().zip(after).take_while(|(a, b)| a == b).count();
    let suffix = before[prefix..].iter().rev().zip(after[prefix..].iter().rev()).take_while(|(a, b)| a == b).count();
    let (old, new) = (&before[prefix..before.len() - suffix], &after[prefix..after.len() - suffix]);
    if old.len().saturating_mul(new.len()) > MAX_DIFF_CELLS {
        return None;
    }
    // Longest common subsequence, from the end.
    let mut table = vec![vec![0u32; new.len() + 1]; old.len() + 1];
    for i in (0..old.len()).rev() {
        for j in (0..new.len()).rev() {
            table[i][j] = if old[i] == new[j] { table[i + 1][j + 1] + 1 } else { table[i + 1][j].max(table[i][j + 1]) };
        }
    }
    let same = |text: &String| DiffLine { kind: "same", text: text.clone() };
    let mut out: Vec<DiffLine> = before[..prefix].iter().map(same).collect();
    let (mut i, mut j) = (0, 0);
    while i < old.len() || j < new.len() {
        if i < old.len() && j < new.len() && old[i] == new[j] {
            out.push(same(&old[i]));
            i += 1;
            j += 1;
        } else if j < new.len() && (i == old.len() || table[i][j + 1] >= table[i + 1][j]) {
            out.push(DiffLine { kind: "added", text: new[j].clone() });
            j += 1;
        } else {
            out.push(DiffLine { kind: "removed", text: old[i].clone() });
            i += 1;
        }
    }
    out.extend(before[before.len() - suffix..].iter().map(same));
    Some(out)
}

/// The line edits that turn `before` into `after`, in an order that applies:
/// removals from the last up, then additions from the first down. Each
/// names the line above it, for an undo to find its place.
fn line_edits(rel: &str, before: &[String], after: &[String]) -> Option<Vec<Edit>> {
    let steps = diff(before, after)?;
    let (mut removed, mut added) = (Vec::new(), Vec::new());
    let (mut old, mut new): (usize, usize) = (0, 0);
    for step in steps {
        match step.kind {
            "same" => {
                old += 1;
                new += 1;
            }
            "removed" => {
                let prev = old.checked_sub(1).map(|at| before[at].clone());
                removed.push(Edit::RemoveLine { file: rel.into(), line: step.text, index: Some(old), prev });
                old += 1;
            }
            _ => {
                let prev = new.checked_sub(1).map(|at| after[at].clone());
                added.push(Edit::AddLine { file: rel.into(), line: step.text, index: Some(new), prev });
                new += 1;
            }
        }
    }
    removed.reverse();
    removed.extend(added);
    Some(removed)
}

/// The edits that turn what the app knew of a file into what it is now.
/// `known` is `Err(hash)` when the earlier text is no longer kept.
fn edits_between(id: &str, rel: &str, known: Option<Result<String, String>>, now: Option<&str>) -> Result<Vec<Edit>> {
    if let (true, Some(Ok(known)), Some(now)) = (by_line(rel), known.as_ref(), now) {
        if let Some(edits) = line_edits(rel, &lines_of(known), &lines_of(now)) {
            return Ok(edits);
        }
    }
    let before = match known {
        None => None,
        Some(Ok(text)) => Some(keep_text(id, &text)?),
        Some(Err(hash)) => Some(hash),
    };
    Ok(vec![Edit::ReplaceText { file: rel.into(), before, after: now.map(|now| keep_text(id, now)).transpose()? }])
}

/// A line that says what an outside edit of one file did.
fn outside_text(rel: &str, edits: &[Edit]) -> String {
    let added = edits.iter().filter(|edit| matches!(edit, Edit::AddLine { .. })).count();
    let removed = edits.iter().filter(|edit| matches!(edit, Edit::RemoveLine { .. })).count();
    let removes_file = edits.iter().any(|edit| matches!(edit, Edit::ReplaceText { after: None, .. }));
    match (added, removed) {
        _ if removes_file => format!("{rel} removed"),
        (0, 0) => format!("Changed {rel}"),
        (added, 0) => format!("{added} line{} added to {rel}", if added == 1 { "" } else { "s" }),
        (0, removed) => format!("{removed} line{} removed from {rel}", if removed == 1 { "" } else { "s" }),
        (added, removed) => format!("{added} added, {removed} removed in {rel}"),
    }
}

/// The files of a bot's home as hiring wrote them, by hash: its role
/// template's text and an empty memory. `None` for a bot whose template this build does not know.
fn as_hired(id: &str) -> Result<Option<Known>> {
    let Some(bot) = bot_store::get(id)? else { return Ok(None) };
    let Some(template) = super::templates::find(&bot.role_template_id) else { return Ok(None) };
    let role = keep_text(id, &super::role_text(&template))?;
    let memory = keep_text(id, &super::memory_text())?;
    Ok(Some(BTreeMap::from([(bot_store::ROLE_FILE.to_string(), role), (bot_store::MEMORY_FILE.to_string(), memory)])))
}

/// Start a new bot's history from its files as hiring wrote them.
pub fn seed(id: &str) -> Result<()> {
    let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    if read_known(id)?.is_some() {
        return Ok(());
    }
    let known = as_hired(id)?.context("the bot or its role template is unknown")?;
    let folder = crate::store::ensure_dir(dir(id)?)?;
    crate::store::write_json(&folder.join(KNOWN_FILE), &known)
}

fn file_time(path: &Path) -> Option<String> {
    let time = std::fs::symlink_metadata(path).ok()?.modified().ok()?;
    Some(chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// The state the newest change to `rel` in the log left it in.
fn logged_state<'a>(log: &'a Log, rel: &str) -> Option<&'a Option<String>> {
    log.changes.iter().rev().find_map(|change| change.states.get(rel))
}

/// Look for edits made outside the app since it last saw the files: each
/// file changed is recorded as one `outside` change, at its modification
/// time. A state the log already ends with is not recorded again. Answers
/// whether what the app knows changed.
fn notice_outside(id: &str, files: &mut Files, known: &mut Option<Known>) -> Result<bool> {
    let mut names: BTreeSet<String> = followed(&files.home).into_iter().collect();
    if let Some(known) = known.as_ref() {
        names.extend(known.keys().filter(|rel| checked(rel).is_ok()).cloned());
    }
    // Never looked at before: compare with the files as hiring wrote them, so
    // an edit made before the first look is recorded too, never taken as the start.
    let first = known.is_none();
    if first {
        *known = as_hired(id)?;
    }
    let mut now = Known::new();
    let mut texts = BTreeMap::new();
    for rel in &names {
        match files.get(rel) {
            Ok(Some(text)) => {
                now.insert(rel.clone(), hash_of(&text));
                texts.insert(rel.clone(), text);
            }
            Ok(None) => {}
            // A file this app will not read stays as it was known: it is neither followed nor taken as removed.
            Err(error) => {
                log::warn!("bot {id}: {error:#}");
                if let Some(hash) = known.as_ref().and_then(|known| known.get(rel)) {
                    now.insert(rel.clone(), hash.clone());
                }
            }
        }
    }
    let Some(before) = known.as_ref() else {
        log::warn!("bot {id}: its role template is unknown, so its files as they are now are where its history starts");
        for text in texts.values() {
            keep_text(id, text)?;
        }
        *known = Some(now);
        return Ok(true);
    };
    let mut log: Option<Log> = None;
    for rel in &names {
        let (was, is) = (before.get(rel), now.get(rel));
        if was == is {
            continue;
        }
        let was_text = was.map(|hash| kept_text(id, hash).map(|text| text.ok_or_else(|| hash.clone()))).transpose()?;
        let is_text = texts.get(rel).map(String::as_str);
        if let (Some(Ok(was)), Some(is)) = (&was_text, is_text) {
            if was.trim_end() == is.trim_end() {
                continue;
            }
        }
        let log = match &mut log {
            Some(log) => log,
            None => log.insert(read_log(id)?),
        };
        if logged_state(log, rel) == Some(&is.cloned()) {
            continue;
        }
        let edits = edits_between(id, rel, was_text, is_text)?;
        if edits.is_empty() {
            continue;
        }
        let mut change = NewChange::new("outside", outside_text(rel, &edits), edits, Source::of(OUTSIDE), OUTSIDE);
        change.at = file_time(&files.home.join(rel));
        // Already in the files: kept to be recorded, not applied again.
        files.recorded.push(change);
    }
    for text in texts.values() {
        if !before.values().any(|hash| *hash == hash_of(text)) {
            keep_text(id, text)?;
        }
    }
    let changed = first || before != &now;
    *known = Some(now);
    Ok(changed)
}

/// Rotate the log once it passes [`MAX_LOG_BYTES`]: its newest changes are
/// kept, up to half that, and the texts nothing names any more are removed.
fn rotate(id: &str, folder: &Path, known: &Known) -> Result<()> {
    let path = folder.join(LOG_FILE);
    if std::fs::metadata(&path).map_or(0, |meta| meta.len()) <= MAX_LOG_BYTES {
        return Ok(());
    }
    let text = String::from_utf8_lossy(&std::fs::read(&path)?).into_owned();
    let mut kept: Vec<&str> = Vec::new();
    let mut size = 0;
    for line in text.lines().rev().filter(|line| !line.trim().is_empty()) {
        if size + line.len() as u64 + 1 > MAX_LOG_BYTES / 2 && !kept.is_empty() {
            break;
        }
        size += line.len() as u64 + 1;
        kept.push(line);
    }
    kept.reverse();
    crate::store::write_atomic(&path, format!("{}\n", kept.join("\n")).as_bytes())?;
    prune_texts(id, folder, known)
}

/// Remove the kept texts that no change in the log and nothing in `known` names.
fn prune_texts(id: &str, folder: &Path, known: &Known) -> Result<()> {
    let log = read_log(id)?;
    let mut named: BTreeSet<String> = known.values().cloned().collect();
    for change in &log.changes {
        // An edit this build cannot read may name a text too: keep every hash-shaped string it has.
        for edit in &change.edits {
            for key in ["before", "after"] {
                if let Some(hash) = edit[key].as_str().filter(|hash| is_hash(hash)) {
                    named.insert(hash.into());
                }
            }
        }
        named.extend(change.states.values().flatten().cloned());
    }
    let Ok(entries) = std::fs::read_dir(folder.join(TEXTS_DIR)) else { return Ok(()) };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.strip_suffix(".txt").is_some_and(|hash| !named.contains(hash)) {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    Ok(())
}

/// Record a change to a bot's role or memory. `f` is given the files as
/// they are now and records its edits on them; outside edits found first
/// are recorded before them. Nothing is written when `f` fails. Answers the
/// changes recorded, outside ones included.
pub fn commit<T>(sink: &dyn EventSink, id: &str, f: impl FnOnce(&mut Files) -> Result<T>) -> Result<(T, Vec<Change>)> {
    let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let home = bot_store::home_dir(id)?;
    anyhow::ensure!(std::fs::symlink_metadata(&home).is_ok_and(|meta| meta.is_dir()), "the bot's home folder is missing");
    let mut files = Files::new(id, home);
    let mut known = read_known(id)?;
    let mut known_changed = notice_outside(id, &mut files, &mut known)?;
    let out = f(&mut files)?;
    files.write()?;
    let folder = crate::store::ensure_dir(dir(id)?)?;
    let mut states = BTreeMap::new();
    for rel in &files.touched {
        states.insert(rel.clone(), files.texts[rel].as_deref().map(|text| keep_text(id, text)).transpose()?);
    }
    // The log before what the app knows of the files: a change whose line
    // could not be appended is still unknown, and is found as an outside edit.
    let mut recorded = Vec::new();
    for change in std::mem::take(&mut files.recorded) {
        let mut touched: BTreeMap<String, Option<String>> = BTreeMap::new();
        for edit in &change.edits {
            let rel = edit.file();
            let state = match states.get(rel) {
                Some(state) => state.clone(),
                // An outside edit: the file as it is now, as `known` has it.
                None => known.as_ref().and_then(|known| known.get(rel).cloned()),
            };
            touched.insert(rel.into(), state);
        }
        let change = Change {
            id: uuid::Uuid::now_v7().to_string(),
            at: change.at.unwrap_or_else(crate::store::index::now),
            kind: change.kind,
            text: change.text,
            edits: change.edits.iter().map(serde_json::to_value).collect::<Result<_, _>>()?,
            source: change.source,
            by: change.by,
            undoes: change.undoes,
            states: touched,
            unknown: BTreeMap::new(),
        };
        crate::store::append_line(&folder.join(LOG_FILE), &serde_json::to_string(&change)?)?;
        recorded.push(change);
    }
    let mut known = known.unwrap_or_default();
    for (rel, state) in states {
        known_changed = true;
        match state {
            Some(hash) => known.insert(rel, hash),
            None => known.remove(&rel),
        };
    }
    // A look that found nothing writes nothing.
    if known_changed {
        crate::store::write_json(&folder.join(KNOWN_FILE), &known)?;
    }
    if !recorded.is_empty() {
        rotate(id, &folder, &known)?;
        sink.emit(EVENT, &serde_json::json!({"id": id}));
    }
    Ok((out, recorded))
}

/// Look for outside edits to one bot's files, as its chat launches an agent: what it is told is then on record.
pub fn look(sink: &dyn EventSink, id: &str) -> Result<usize> {
    Ok(commit(sink, id, |_| Ok(()))?.1.len())
}

/// Look for outside edits to every bot's files, as the Bots page opens. A bot whose files cannot be read is skipped.
pub fn look_all(sink: &dyn EventSink) -> Result<usize> {
    let mut found = 0;
    for bot in bot_store::list()? {
        match commit(sink, &bot.id, |_| Ok(())) {
            Ok(((), recorded)) => found += recorded.len(),
            Err(error) => log::warn!("bot {}: looking for outside edits: {error:#}", bot.id),
        }
    }
    Ok(found)
}

/// Why a change cannot be undone, or `None` when it can be tried.
pub fn not_undoable(change: &Change, log: &Log) -> Option<&'static str> {
    if change.undoes.is_some() {
        Some("An undo is not undone; make the change again.")
    } else if log.changes.iter().any(|other| other.undoes.as_deref() == Some(change.id.as_str())) {
        Some("This change was already undone.")
    } else if change.known_edits().is_none() {
        Some("A newer version of TerminalX made this change; it cannot be undone here.")
    } else if change.edits.iter().any(|edit| edit.to_string().contains(REDACTED)) {
        Some("It held a secret, which was taken out of the history.")
    } else {
        None
    }
}

/// Undo a change inside a [`commit`]: its edits backwards, recorded as an
/// `undo` by `by`. Answers the edits the undo made.
pub fn undo_in(files: &mut Files, change_id: &str, by: &str, source: Source) -> Result<Vec<Edit>> {
    let log = read_log(&files.id)?;
    let change = log.changes.iter().find(|change| change.id == change_id).ok_or_else(|| super::refused(format!("No change {change_id} in this bot's history.")))?;
    if let Some(why) = not_undoable(change, &log) {
        return Err(super::refused(why));
    }
    let edits: Vec<Edit> = change.known_edits().unwrap_or_default().iter().rev().map(Edit::inverse).collect();
    let mut undo = NewChange::new("undo", change.text.clone(), edits.clone(), source, by);
    undo.undoes = Some(change.id.clone());
    files.record(undo)?;
    Ok(edits)
}

/// Take a secret out of the history: every recorded string that holds it is
/// rewritten, and the kept texts that hold it, other than the files as they
/// are now, are removed. The changes it was in can no longer be undone.
pub fn redact(id: &str, secret: &str) -> Result<()> {
    if secret.trim().is_empty() {
        return Ok(());
    }
    let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let folder = dir(id)?;
    let path = folder.join(LOG_FILE);
    if let Ok(bytes) = std::fs::read(&path) {
        let text = String::from_utf8_lossy(&bytes);
        let escaped = serde_json::to_string(secret)?;
        if text.contains(secret) || text.contains(escaped.trim_matches('"')) {
            let mut lines = Vec::new();
            for line in text.lines().filter(|line| !line.trim().is_empty()) {
                match serde_json::from_str::<Value>(line) {
                    Ok(mut value) => {
                        scrub(&mut value, secret);
                        lines.push(serde_json::to_string(&value)?);
                    }
                    // A line this build cannot read is kept, but not with the secret in it.
                    Err(_) => lines.push(line.replace(secret, REDACTED)),
                }
            }
            crate::store::write_atomic(&path, format!("{}\n", lines.join("\n")).as_bytes())?;
        }
    }
    let known: BTreeSet<String> = read_known(id)?.unwrap_or_default().into_values().collect();
    if let Ok(entries) = std::fs::read_dir(folder.join(TEXTS_DIR)) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let current = name.strip_suffix(".txt").is_some_and(|hash| known.contains(hash));
            if !current && read_file(&entry.path()).ok().flatten().is_some_and(|text| text.contains(secret)) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
    Ok(())
}

fn scrub(value: &mut Value, secret: &str) {
    match value {
        Value::String(text) if text.contains(secret) => *text = text.replace(secret, REDACTED),
        Value::Array(items) => items.iter_mut().for_each(|item| scrub(item, secret)),
        Value::Object(fields) => fields.values_mut().for_each(|field| scrub(field, secret)),
        _ => {}
    }
}

/// Move a deleted bot's history beside its home in the trash (`<home>.changes`).
pub fn trash(id: &str, trashed_home: &Path) -> Result<()> {
    let _guard = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let folder = dir(id)?;
    if !folder.is_dir() {
        return Ok(());
    }
    let mut target = trashed_home.as_os_str().to_owned();
    target.push(".changes");
    std::fs::rename(&folder, &target).with_context(|| format!("move {} to the trash", folder.display()))
}
