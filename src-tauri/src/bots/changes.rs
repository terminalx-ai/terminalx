//! The change log of a bot's role and memory (PRO-470). It is kept outside
//! the bot's home folder, in `bot-changes/<id>/`, where the bot's own work
//! never writes: every add, edit and removal is recorded there with when,
//! what and where it came from, and each one can be undone.
//!
//! Every change the app makes goes through [`commit`], which first looks for
//! edits made to the files outside the app (by the bot with an editor, or by
//! a person) and records those as "edited outside the app", then applies its
//! own edits all or nothing. `known.json` holds each file as the app last
//! saw it; the first look at a bot's files only records that.
//!
//! An edit is a line added or removed (the memory files), or a whole text
//! replaced (the role and the topic files). Undoing a change applies its
//! edits backwards and is itself a change; it refuses, writing nothing, when
//! a line is no longer where the change left it or a text was changed since.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sink::EventSink;
use crate::store::bots as bot_store;

pub const LOG_FILE: &str = "changes.jsonl";
pub const KNOWN_FILE: &str = "known.json";
/// The event a recorded change is announced with: `{"id": <bot id>}`.
pub const EVENT: &str = "bot_memory_changed";
/// A file larger than this is not followed: it is shown, never diffed.
pub const MAX_TRACKED_BYTES: u64 = 1024 * 1024;
/// More lines than this on both sides of a memory file's edit are recorded as a whole text.
const MAX_DIFF_CELLS: usize = 4_000_000;

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
/// `orgs/acme-…/memory/archive.md`). A text that is `None` is no file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Edit {
    AddLine {
        file: String,
        line: String,
        /// Where it went, counted from 0; at the end when left out or past it.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
    },
    RemoveLine {
        file: String,
        line: String,
        /// Where it was; the first equal line is taken when it is no longer there.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        index: Option<usize>,
    },
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
            Self::AddLine { file, line, index } => Self::RemoveLine { file, line, index },
            Self::RemoveLine { file, line, index } => Self::AddLine { file, line, index },
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
    let text = match std::fs::read(&path) {
        Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Log::default()),
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    let mut log = Log::default();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        match serde_json::from_str::<Change>(line) {
            Ok(change) => log.changes.push(change),
            Err(_) => log.unreadable += 1,
        }
    }
    Ok(log)
}

fn read_known(id: &str) -> Result<Option<BTreeMap<String, String>>> {
    let path = dir(id)?.join(KNOWN_FILE);
    crate::store::read_json(&path).with_context(|| format!("{} cannot be read", path.display()))
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

/// What a file holds now: `None` when there is none. A file that is not a
/// regular one (a link, a folder) or is too large is refused, and left as it is.
pub fn read_file(path: &Path) -> Result<Option<String>> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    anyhow::ensure!(meta.file_type().is_file(), "{} is not a regular file; it is left as it is", path.display());
    anyhow::ensure!(meta.len() <= MAX_TRACKED_BYTES, "{} is larger than {} KB; it is left as it is", path.display(), MAX_TRACKED_BYTES / 1024);
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
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
    home: PathBuf,
    texts: BTreeMap<String, Option<String>>,
    touched: BTreeSet<String>,
    recorded: Vec<NewChange>,
}

impl Files {
    fn new(home: PathBuf) -> Self {
        Self { home, texts: BTreeMap::new(), touched: BTreeSet::new(), recorded: Vec::new() }
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

    fn apply(&mut self, edit: &Edit) -> Result<()> {
        let rel = edit.file();
        match edit {
            Edit::AddLine { line, index, .. } => {
                let mut lines = self.lines(rel)?;
                let at = index.filter(|at| *at <= lines.len()).unwrap_or(lines.len());
                lines.insert(at, line.clone());
                self.set(rel, Some(text_of(&lines)));
            }
            Edit::RemoveLine { line, index, .. } => {
                let mut lines = self.lines(rel)?;
                let at = index
                    .filter(|at| lines.get(*at) == Some(line))
                    .or_else(|| lines.iter().position(|known| known == line))
                    .ok_or_else(|| super::refused(format!("“{}” is no longer in {rel}.", line.trim())))?;
                lines.remove(at);
                self.set(rel, Some(text_of(&lines)));
            }
            Edit::ReplaceText { before, after, .. } => {
                let now = self.get(rel)?;
                if now.as_deref().map(str::trim_end) != before.as_deref().map(str::trim_end) {
                    return Err(super::refused(format!("{rel} was changed since; that change is not undone.")));
                }
                self.set(rel, after.clone());
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
/// removals from the last up, then additions from the first down.
fn line_edits(rel: &str, before: &[String], after: &[String]) -> Option<Vec<Edit>> {
    let steps = diff(before, after)?;
    let (mut removed, mut added) = (Vec::new(), Vec::new());
    let (mut old, mut new) = (0, 0);
    for step in steps {
        match step.kind {
            "same" => {
                old += 1;
                new += 1;
            }
            "removed" => {
                removed.push(Edit::RemoveLine { file: rel.into(), line: step.text, index: Some(old) });
                old += 1;
            }
            _ => {
                added.push(Edit::AddLine { file: rel.into(), line: step.text, index: Some(new) });
                new += 1;
            }
        }
    }
    removed.reverse();
    removed.extend(added);
    Some(removed)
}

/// The edits that turn what the app knew of a file into what it is now.
fn edits_between(rel: &str, known: Option<&str>, now: Option<&str>) -> Vec<Edit> {
    if by_line(rel) && known.is_some() && now.is_some() {
        if let Some(edits) = line_edits(rel, &lines_of(known.unwrap_or_default()), &lines_of(now.unwrap_or_default())) {
            return edits;
        }
    }
    vec![Edit::ReplaceText { file: rel.into(), before: known.map(str::to_owned), after: now.map(str::to_owned) }]
}

/// A line that says what an outside edit did.
fn outside_text(edits: &[Edit]) -> String {
    let files: BTreeSet<&str> = edits.iter().map(Edit::file).collect();
    let added = edits.iter().filter(|edit| matches!(edit, Edit::AddLine { .. })).count();
    let removed = edits.iter().filter(|edit| matches!(edit, Edit::RemoveLine { .. })).count();
    let names = files.into_iter().collect::<Vec<_>>().join(", ");
    match (added, removed) {
        (0, 0) => format!("Changed {names}"),
        (added, 0) => format!("{added} line{} added to {names}", if added == 1 { "" } else { "s" }),
        (0, removed) => format!("{removed} line{} removed from {names}", if removed == 1 { "" } else { "s" }),
        (added, removed) => format!("{added} added, {removed} removed in {names}"),
    }
}

/// Look for edits made outside the app since it last saw the files: they
/// are recorded as one `outside` change. The first look only remembers.
fn notice_outside(id: &str, files: &mut Files, known: &mut Option<BTreeMap<String, String>>) -> Result<()> {
    let mut names: BTreeSet<String> = followed(&files.home).into_iter().collect();
    if let Some(known) = known.as_ref() {
        names.extend(known.keys().filter(|rel| checked(rel).is_ok()).cloned());
    }
    let mut now = BTreeMap::new();
    for rel in &names {
        match files.get(rel) {
            Ok(Some(text)) => {
                now.insert(rel.clone(), text);
            }
            Ok(None) => {}
            // A file this app will not read stays as it was known: it is neither followed nor taken as removed.
            Err(error) => {
                log::warn!("bot {id}: {error:#}");
                if let Some(text) = known.as_ref().and_then(|known| known.get(rel)) {
                    now.insert(rel.clone(), text.clone());
                }
            }
        }
    }
    let Some(before) = known.as_ref() else {
        *known = Some(now);
        return Ok(());
    };
    let mut edits = Vec::new();
    for rel in &names {
        let (was, is) = (before.get(rel).map(String::as_str), now.get(rel).map(String::as_str));
        if was.map(str::trim_end) != is.map(str::trim_end) {
            edits.extend(edits_between(rel, was, is));
        }
    }
    if !edits.is_empty() {
        // Already in the files: kept to be recorded, not applied again.
        files.recorded.push(NewChange { kind: "outside".into(), text: outside_text(&edits), edits, source: Source::of(OUTSIDE), by: OUTSIDE.into(), undoes: None });
    }
    *known = Some(now);
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
    let mut files = Files::new(home);
    let mut known = read_known(id)?;
    notice_outside(id, &mut files, &mut known)?;
    let out = f(&mut files)?;
    files.write()?;
    let mut known = known.unwrap_or_default();
    for rel in &files.touched {
        match &files.texts[rel] {
            Some(text) => known.insert(rel.clone(), text.clone()),
            None => known.remove(rel),
        };
    }
    let folder = crate::store::ensure_dir(dir(id)?)?;
    crate::store::write_json(&folder.join(KNOWN_FILE), &known)?;
    let mut recorded = Vec::new();
    for change in std::mem::take(&mut files.recorded) {
        let change = Change {
            id: uuid::Uuid::now_v7().to_string(),
            at: crate::store::index::now(),
            kind: change.kind,
            text: change.text,
            edits: change.edits.iter().map(serde_json::to_value).collect::<Result<_, _>>()?,
            source: change.source,
            by: change.by,
            undoes: change.undoes,
            unknown: BTreeMap::new(),
        };
        crate::store::append_line(&folder.join(LOG_FILE), &format!("{}\n", serde_json::to_string(&change)?))?;
        recorded.push(change);
    }
    if !recorded.is_empty() {
        sink.emit(EVENT, &serde_json::json!({"id": id}));
    }
    Ok((out, recorded))
}

/// Why a change cannot be undone, or `None` when it can be tried.
pub fn not_undoable(change: &Change, log: &Log) -> Option<&'static str> {
    if change.undoes.is_some() {
        Some("An undo is not undone; make the change again.")
    } else if log.changes.iter().any(|other| other.undoes.as_deref() == Some(change.id.as_str())) {
        Some("This change was already undone.")
    } else if change.known_edits().is_none() {
        Some("A newer version of TerminalX made this change; it cannot be undone here.")
    } else {
        None
    }
}

/// Undo a change: its edits backwards, recorded as an `undo` by `by`.
pub fn undo(sink: &dyn EventSink, id: &str, change_id: &str, by: &str, source: Source) -> Result<Change> {
    let ((), recorded) = commit(sink, id, |files| {
        let log = read_log(id)?;
        let change = log.changes.iter().find(|change| change.id == change_id).ok_or_else(|| super::refused(format!("No change {change_id} in this bot's history.")))?;
        if let Some(why) = not_undoable(change, &log) {
            return Err(super::refused(why));
        }
        let edits: Vec<Edit> = change.known_edits().unwrap_or_default().iter().rev().map(Edit::inverse).collect();
        files.record(NewChange { kind: "undo".into(), text: change.text.clone(), edits, source, by: by.into(), undoes: Some(change.id.clone()) })
    })?;
    recorded.into_iter().rev().find(|change| change.undoes.as_deref() == Some(change_id)).context("the undo was recorded")
}
