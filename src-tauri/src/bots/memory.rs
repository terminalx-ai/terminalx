//! A bot's role and memory as the owner reads and changes them (PRO-470).
//!
//! Memory is kept in three kinds of place, each a folder of the bot's home
//! with its own `MEMORY.md` (one dated note per line), its `memory/` topic
//! files and `memory/archive.md`:
//!
//! - the bot itself (the home folder): notes that go with the bot;
//! - each organisation it works in (`orgs/<organisation id>/`): notes that stay there;
//! - `personal/`: notes for the work it does for its owner alone.
//!
//! A conversation is given the bot's own notes and those of the place it
//! works in (the first of its `works_in`), [`BUDGET`] lines in all, the
//! newest of each. Adding a note past the budget moves the oldest notes of
//! those two files to their archives (undated notes first, a file's own
//! words under its heading last), by whoever added
//! it; an archive past [`ARCHIVE_ROLL_BYTES`] is rolled to a dated file.
//! Every write is recorded in the change log ([`super::changes`]) and can be undone.
//!
//! What is read for a conversation is read with limits: a regular file
//! only, opened without following a link, at most [`READ_LIMIT`] bytes,
//! decoded lossily. It is the bot's own notes, never instructions or
//! approval. A role has one limit for reading and writing, [`ROLE_LIMIT`],
//! the most a launch reads of it (`chat::ROLE_READ_LIMIT`).

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read as _;
use std::path::Path;
use std::sync::LazyLock;

use anyhow::Result;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::Digest;

use super::changes::{self, Change, DiffLine, Edit, NewChange, Source};
use super::{refused, Bot, OWNER, PERSONAL};
use crate::sink::EventSink;
use crate::store::bots as bot_store;

/// How many lines of memory a conversation is given: the bot's own and its place's together.
pub const BUDGET: usize = 200;
/// How much of a memory file is read for a conversation.
pub const READ_LIMIT: u64 = 64 * 1024;
/// The most a role may be, and what a conversation reads of it.
pub const ROLE_LIMIT: u64 = super::chat::ROLE_READ_LIMIT;
/// The most of each memory file's lines a conversation is given, in bytes,
/// so the role, both files and the rules stay under
/// `chat::INSTRUCTIONS_LIMIT` (PRO-489), and Codex's escaping of them under
/// the 128 KB one argument may be on Linux.
pub const SHOWN_BYTES: usize = 16 * 1024;
/// An archive this large is rolled to `memory/archive-<date>.md` before more is added to it.
pub const ARCHIVE_ROLL_BYTES: u64 = 768 * 1024;
pub const ARCHIVE_FILE: &str = "archive.md";
pub const ORGS_DIR: &str = "orgs";
/// The place key for the notes that go with the bot.
pub const BOT_PLACE: &str = "bot";
const MAX_NOTE_CHARS: usize = 400;
/// How many changes the screen is given, newest first.
const SHOWN_CHANGES: usize = 200;

/// Where a note is kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Place {
    /// Goes with the bot.
    Bot,
    /// Stays in one organisation, by its id as the bot's `works_in` has it.
    Org(String),
    /// The owner's own work.
    Personal,
}

impl Place {
    /// `bot`, `personal`, or the organisation's id.
    pub fn key(&self) -> &str {
        match self {
            Self::Bot => BOT_PLACE,
            Self::Org(name) => name,
            Self::Personal => PERSONAL,
        }
    }

    /// The place a key names for `bot`: `bot`, `personal`, or an organisation it works in.
    pub fn parse(bot: &Bot, key: &str) -> Result<Self> {
        let key = key.trim();
        Ok(match key {
            BOT_PLACE => Self::Bot,
            PERSONAL => Self::Personal,
            name if bot.works_in.iter().any(|place| place == name) => Self::Org(name.into()),
            other => {
                let places: Vec<String> = places(bot).iter().map(|place| place.key().to_owned()).collect();
                return Err(refused(format!("{} keeps no notes in {other}. Its places are: {}.", bot.name, places.join(", "))));
            }
        })
    }

    /// Its folder in the home, with a trailing slash; empty for the bot's own.
    pub fn dir(&self) -> String {
        match self {
            Self::Bot => String::new(),
            Self::Personal => format!("{PERSONAL}/"),
            Self::Org(id) => format!("{ORGS_DIR}/{}/", org_folder(id)),
        }
    }

    pub fn memory_file(&self) -> String {
        format!("{}{}", self.dir(), bot_store::MEMORY_FILE)
    }

    pub fn topics_dir(&self) -> String {
        format!("{}{}", self.dir(), bot_store::MEMORY_DIR)
    }

    pub fn archive_file(&self) -> String {
        format!("{}/{ARCHIVE_FILE}", self.topics_dir())
    }
}

/// An organisation's folder, by its id: a renamed organisation keeps its
/// notes. An id that is not a plain name is kept by its hash.
fn org_folder(id: &str) -> String {
    let plain = !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_')) && !id.starts_with("x-");
    if plain {
        return id.into();
    }
    let hash = sha2::Sha256::digest(id.as_bytes());
    format!("x-{}", hash.iter().take(8).map(|byte| format!("{byte:02x}")).collect::<String>())
}

/// Every place `bot` keeps notes: itself, each organisation it works in, and personal.
pub fn places(bot: &Bot) -> Vec<Place> {
    let mut places = vec![Place::Bot];
    for place in &bot.works_in {
        if place != PERSONAL && !places.iter().any(|known| known.key() == place) && place != BOT_PLACE {
            places.push(Place::Org(place.clone()));
        }
    }
    places.push(Place::Personal);
    places
}

/// The place a conversation with `bot` works in: the first it works in.
pub fn working_place(bot: &Bot) -> Place {
    match bot.works_in.first().map(String::as_str) {
        None | Some(PERSONAL) | Some(BOT_PLACE) => Place::Personal,
        Some(org) => Place::Org(org.into()),
    }
}

/// A file as a conversation reads it.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Limited {
    /// What is read: at most [`READ_LIMIT`] bytes, whole lines only.
    pub text: String,
    /// The file's size.
    pub bytes: u64,
    /// Larger than [`READ_LIMIT`]: the rest is not read.
    pub over_limit: bool,
    /// Why nothing was read from a file that is there.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<String>,
}

/// Read a file the way a conversation is given it: a regular file only,
/// opened without following a link, at most [`READ_LIMIT`] bytes, decoded
/// lossily. A missing file reads as empty.
#[cfg(test)]
pub fn read_limited(path: &Path) -> Limited {
    read_limited_to(path, READ_LIMIT, false)
}

/// [`read_limited`] to at most `limit` bytes.
/// [`read_limited`] to at most `limit` bytes; `tail`: of a file past it, its
/// end, from the first whole line (a memory's newest notes are last).
pub fn read_limited_to(path: &Path, limit: u64, tail: bool) -> Limited {
    use std::io::Seek as _;
    let not_regular = || Limited { problem: Some("It is not a regular file, so it is not read.".into()), ..Default::default() };
    let mut file = match changes::open_no_follow(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Limited::default(),
        Err(error) if changes::is_link_refusal(&error) => return not_regular(),
        Err(error) => return Limited { problem: Some(format!("It cannot be read: {error}")), ..Default::default() },
    };
    let meta = match file.metadata() {
        Ok(meta) => meta,
        Err(error) => return Limited { problem: Some(format!("It cannot be read: {error}")), ..Default::default() },
    };
    if !meta.file_type().is_file() {
        return not_regular();
    }
    let over_limit = meta.len() > limit;
    let from_tail = tail && over_limit;
    let mut bytes = Vec::new();
    let read = if from_tail { file.seek(std::io::SeekFrom::Start(meta.len() - limit)).map(drop) } else { Ok(()) }.and_then(|()| file.take(limit).read_to_end(&mut bytes));
    if let Err(error) = read {
        return Limited { bytes: meta.len(), problem: Some(format!("It cannot be read: {error}")), ..Default::default() };
    }
    if from_tail {
        // A line cut in half at the start is not read.
        let start = bytes.iter().position(|byte| *byte == b'\n').map_or(bytes.len(), |at| at + 1);
        bytes.drain(..start);
    } else if over_limit {
        // A line cut in half is not read.
        let whole = bytes.iter().rposition(|byte| *byte == b'\n').map_or(0, |at| at + 1);
        bytes.truncate(whole);
    }
    Limited { text: String::from_utf8_lossy(&bytes).into_owned(), bytes: meta.len(), over_limit, problem: None }
}

/// [`read_limited`] for a file of the home, by its path there: one reached
/// through a link the home does not own reads as nothing, and says why.
pub fn read_in_home(home: &Path, rel: &str) -> Limited {
    let limit = if rel == bot_store::ROLE_FILE { ROLE_LIMIT } else { READ_LIMIT };
    let tail = rel.rsplit('/').next() == Some(bot_store::MEMORY_FILE);
    match changes::no_links(home, rel) {
        Ok(()) => read_limited_to(&home.join(rel), limit, tail),
        Err(error) => Limited { problem: Some(format!("{error:#}")), ..Default::default() },
    }
}

/// The date of a note line (`- 2026-11-20 …`), if it has one.
pub fn note_date(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("- ")?;
    let date = rest.get(..10)?;
    let shaped = date.char_indices().all(|(at, c)| if at == 4 || at == 7 { c == '-' } else { c.is_ascii_digit() });
    (shaped && rest[10..].starts_with(' ')).then_some(date)
}

/// A note line without its bullet and date.
pub fn note_text(line: &str) -> &str {
    match note_date(line) {
        Some(_) => line[13..].trim(),
        None => line.trim().trim_start_matches("- ").trim(),
    }
}

static SECRET: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(concat!(
        r"(sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}",
        r"|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{36}|hf_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}",
        r"|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|AIza[0-9A-Za-z_-]{30,}|lin_api_[A-Za-z0-9]{20,}",
        r"|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.",
        r"|(?i:\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\s*[=:]\s*[^\s,;]{6,}))"
    ))
    .expect("the secret pattern compiles")
});

/// Whether a text looks like it holds a key, a token or a password. Bots keep no secrets in memory.
pub fn looks_secret(text: &str) -> bool {
    SECRET.is_match(text)
}

/// The parts of a text that look like secrets.
pub fn secrets_in(text: &str) -> Vec<String> {
    SECRET.find_iter(text).map(|found| found.as_str().to_owned()).collect()
}

/// Characters that would make one line read as two, or reorder what is shown.
fn breaks_a_line(c: char) -> bool {
    matches!(c, '\u{2028}' | '\u{2029}' | '\u{061C}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}')
}

fn clean_note(text: &str) -> Result<String> {
    let note = text.trim();
    if note.is_empty() {
        return Err(refused("A note needs some text."));
    }
    if note.chars().any(char::is_control) {
        return Err(refused("A note is one line."));
    }
    if note.chars().any(breaks_a_line) {
        return Err(refused("A note is one line of plain text: no line or paragraph separators and no direction marks."));
    }
    if note.chars().count() > MAX_NOTE_CHARS {
        return Err(refused(format!("A note is at most {MAX_NOTE_CHARS} characters. Put longer notes in a topic file under memory/.")));
    }
    if looks_secret(note) {
        return Err(refused("That looks like a secret (a key or a token). Memory never keeps secrets."));
    }
    Ok(note.into())
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// How many lines of the bot's own notes and of its place's a conversation reads (the newest of each).
pub fn read_split(own: usize, place: usize) -> (usize, usize) {
    let own_read = own.min(BUDGET);
    (own_read, place.min(BUDGET - own_read))
}

/// The two memory files a note in `place` is counted with: the bot's own and the place's.
fn budget_pair(bot: &Bot, place: &Place) -> [Place; 2] {
    match place {
        Place::Bot => [Place::Bot, working_place(bot)],
        _ => [Place::Bot, place.clone()],
    }
}

/// A line the budget may move: anything but a heading or a blank line.
fn is_note(line: &str) -> bool {
    let line = line.trim();
    !line.is_empty() && !line.starts_with('#')
}

/// The order the budget moves lines in: undated notes first, then dated
/// ones oldest first, and other text (a file's own words under its heading) last.
fn move_order(line: &str) -> (u8, &str) {
    match note_date(line) {
        Some(date) => (1, date),
        None if line.trim_start().starts_with("- ") || line.trim_start().starts_with("* ") => (0, ""),
        None => (2, ""),
    }
}

/// Keep the bot's own notes and `place`'s within [`BUDGET`] lines together:
/// the oldest notes (undated first, then by date, then the higher in the
/// file) move to their file's archive, as one `archived` change by `by`.
/// The lines in `keep` are never moved. An archive that would pass
/// [`ARCHIVE_ROLL_BYTES`] is first rolled to a dated file.
fn archive_over_budget(files: &mut changes::Files, bot: &Bot, place: &Place, keep: &BTreeSet<(String, String)>, by: &str) -> Result<usize> {
    let pair = budget_pair(bot, place);
    let mut texts = Vec::new();
    for place in &pair {
        texts.push(files.lines(&place.memory_file())?);
    }
    let total: usize = texts.iter().map(Vec::len).sum();
    if total <= BUDGET {
        return Ok(0);
    }
    let mut notes: Vec<((u8, &str), usize, usize)> = Vec::new();
    for (which, lines) in texts.iter().enumerate() {
        for (at, line) in lines.iter().enumerate() {
            if is_note(line) && !keep.contains(&(pair[which].memory_file(), line.clone())) {
                notes.push((move_order(line), which, at));
            }
        }
    }
    notes.sort();
    notes.truncate(total - BUDGET);
    if notes.is_empty() {
        return Ok(0);
    }
    let moved = notes.len();
    let mut edits = Vec::new();
    let mut rolled = false;
    for (which, place) in pair.iter().enumerate() {
        let added: u64 = notes.iter().filter(|note| note.1 == which).map(|note| texts[which][note.2].len() as u64 + 1).sum();
        let archive = place.archive_file();
        let now = files.get(&archive)?.unwrap_or_default();
        if added == 0 || now.trim().is_empty() || now.len() as u64 + added <= ARCHIVE_ROLL_BYTES {
            continue;
        }
        let mut name = format!("{}/archive-{}.md", place.topics_dir(), today());
        let mut copy = 2;
        while files.get(&name)?.is_some() {
            name = format!("{}/archive-{}-{copy}.md", place.topics_dir(), today());
            copy += 1;
        }
        edits.push(files.replacing(&name, Some(&now))?);
        edits.push(files.replacing(&archive, None)?);
        rolled = true;
    }
    // Removed from the bottom up so each index still holds, then added to the archives oldest first.
    let mut removals = notes.clone();
    removals.sort_by(|a, b| (a.1, b.2).cmp(&(b.1, a.2)));
    edits.extend(removals.iter().map(|(_, which, at)| Edit::RemoveLine {
        file: pair[*which].memory_file(),
        line: texts[*which][*at].clone(),
        index: Some(*at),
        prev: at.checked_sub(1).map(|above| texts[*which][above].clone()),
    }));
    edits.extend(notes.iter().map(|(_, which, at)| Edit::AddLine { file: pair[*which].archive_file(), line: texts[*which][*at].clone(), index: None, prev: None }));
    let text = format!(
        "Moved {moved} older note{} to the archive to stay within {BUDGET} lines{}",
        if moved == 1 { "" } else { "s" },
        if rolled { ", and started a new archive file" } else { "" }
    );
    files.record(NewChange::new("archived", text, edits, Source::of("budget"), by))?;
    Ok(moved)
}

/// Add a note to `place`, dated today, and keep within the budget. Answers the changes recorded.
pub fn add(sink: &dyn EventSink, bot: &Bot, place: &Place, text: &str, by: &str, source: Source) -> Result<Vec<Change>> {
    let note = clean_note(text)?;
    let line = format!("- {} {note}", today());
    let file = place.memory_file();
    let ((), recorded) = changes::commit(sink, &bot.id, |files| {
        let lines = files.lines(&file)?;
        if lines.iter().any(|known| note_text(known).eq_ignore_ascii_case(&note)) {
            return Err(refused(format!("{} already has that note.", bot.name)));
        }
        let prev = lines.last().cloned();
        files.record(NewChange::new("learned", note.clone(), vec![Edit::AddLine { file: file.clone(), line: line.clone(), index: None, prev }], source, by))?;
        archive_over_budget(files, bot, place, &BTreeSet::from([(file.clone(), line.clone())]), by)?;
        Ok(())
    })?;
    Ok(recorded)
}

/// Remove the one note in `place` that `which` names: the whole line, the
/// note's text, or a part of it that only one note has. `index` says which
/// line is meant (counted from 0), so one of two equal notes can be
/// forgotten. A note that held a secret is also taken out of the history.
pub fn forget(sink: &dyn EventSink, bot: &Bot, place: &Place, which: &str, index: Option<usize>, by: &str, source: Source) -> Result<Vec<Change>> {
    let wanted = which.trim();
    if wanted.is_empty() {
        return Err(refused("Say which note to forget."));
    }
    let file = place.memory_file();
    let matches = |line: &str| line.trim() == wanted || note_text(line).eq_ignore_ascii_case(wanted);
    let (line, recorded) = changes::commit(sink, &bot.id, |files| {
        let lines = files.lines(&file)?;
        let at = match index.filter(|at| lines.get(*at).is_some_and(|line| matches(line))) {
            Some(at) => at,
            None => {
                let lower = wanted.to_lowercase();
                let exact: Vec<usize> = (0..lines.len()).filter(|at| matches(&lines[*at])).collect();
                let found: Vec<usize> = if exact.is_empty() { (0..lines.len()).filter(|at| is_note(&lines[*at]) && note_text(&lines[*at]).to_lowercase().contains(&lower)).collect() } else { exact };
                match found.as_slice() {
                    [at] => *at,
                    [] => return Err(refused(format!("No note in {} matches “{wanted}”.", place_label(place)))),
                    several if several.iter().all(|at| lines[*at] == lines[several[0]]) => {
                        return Err(refused(format!("{} notes read “{wanted}”; say which by its line number (--line N, as `terminalx bots memory list` shows them).", several.len())));
                    }
                    several => return Err(refused(format!("{} notes match “{wanted}”; say more of the one to forget.", several.len()))),
                }
            }
        };
        let line = lines[at].clone();
        let prev = at.checked_sub(1).map(|above| lines[above].clone());
        files.record(NewChange::new("forgot", note_text(&line), vec![Edit::RemoveLine { file: file.clone(), line: line.clone(), index: Some(at), prev }], source, by))?;
        Ok(line)
    })?;
    for secret in secrets_in(&line) {
        changes::redact(&bot.id, &secret)?;
    }
    Ok(recorded)
}

fn place_label(place: &Place) -> String {
    match place {
        Place::Bot => "the bot's own notes".into(),
        Place::Org(id) => format!("the notes of organisation {id}"),
        Place::Personal => "personal notes".into(),
    }
}

/// Replace the bot's standing instructions, recorded as a `kind` change. The
/// same text records nothing. `expected` is the hash of the text the editor
/// started from: a role changed since is not written over.
pub fn write_role(sink: &dyn EventSink, bot: &Bot, text: &str, by: &str, source: Source, kind: &str, expected: Option<&str>) -> Result<Vec<Change>> {
    if text.len() as u64 > ROLE_LIMIT {
        return Err(refused(format!("A role is at most {} KB, the most a conversation reads. Move the rest to a topic file under memory/.", ROLE_LIMIT / 1024)));
    }
    let ((), recorded) = changes::commit(sink, &bot.id, |files| {
        let before = files.get(bot_store::ROLE_FILE)?;
        if expected.is_some_and(|expected| changes::hash_of(before.as_deref().unwrap_or_default()) != expected) {
            return Err(refused("ROLE.md changed since you opened it. Load the new text, or save yours over it."));
        }
        if before.as_deref().map(str::trim_end) == Some(text.trim_end()) {
            return Ok(());
        }
        let edit = files.replacing(bot_store::ROLE_FILE, Some(text))?;
        files.record(NewChange::new(kind, "Standing instructions changed", vec![edit], source, by))
    })?;
    Ok(recorded)
}

/// The hash of the role's text a change left (`None`: no file), if it replaced the role.
fn role_after(change: &Change) -> Option<Option<String>> {
    change.known_edits()?.into_iter().rev().find_map(|edit| match edit {
        Edit::ReplaceText { file, after, .. } if file == bot_store::ROLE_FILE => Some(after),
        _ => None,
    })
}

/// A kept text of the role, by its hash: one a change left, or the role template's.
pub fn role_text(bot: &Bot, hash: &str) -> Result<Option<String>> {
    if let Some(template) = super::templates::find(&bot.role_template_id).map(|template| super::role_text(&template)) {
        if changes::hash_of(&template) == hash {
            return Ok(Some(template));
        }
    }
    changes::kept_text(&bot.id, hash)
}

/// Put back a version of the role: the one `change` left, or the role template's when `None`.
pub fn restore_role(sink: &dyn EventSink, bot: &Bot, change: Option<&str>) -> Result<Vec<Change>> {
    let text = match change {
        None => super::templates::find(&bot.role_template_id).map(|template| super::role_text(&template)).ok_or_else(|| refused(format!("{} was not built from a role this version knows.", bot.name)))?,
        Some(id) => {
            let log = changes::read_log(&bot.id)?;
            let change = log.changes.iter().find(|change| change.id == id).ok_or_else(|| refused(format!("No change {id} in {}'s history.", bot.name)))?;
            match role_after(change).ok_or_else(|| refused("That change did not replace the role."))? {
                None => String::new(),
                Some(hash) => changes::kept_text(&bot.id, &hash)?.ok_or_else(|| refused("That version of the role is no longer kept."))?,
            }
        }
    };
    write_role(sink, bot, &text, OWNER, Source::of("app"), "restored", None)
}

/// Undo a change, then keep within the budget: lines the undo put back stay, older ones move to the archive.
pub fn undo(sink: &dyn EventSink, bot: &Bot, change_id: &str, by: &str, source: Source) -> Result<Change> {
    let working = working_place(bot);
    let counted = [Place::Bot.memory_file(), working.memory_file()];
    let ((), recorded) = changes::commit(sink, &bot.id, |files| {
        let edits = changes::undo_in(files, change_id, by, source)?;
        let keep: BTreeSet<(String, String)> = edits
            .iter()
            .filter_map(|edit| match edit {
                Edit::AddLine { file, line, .. } if counted.contains(file) => Some((file.clone(), line.clone())),
                _ => None,
            })
            .collect();
        if !keep.is_empty() {
            archive_over_budget(files, bot, &working, &keep, by)?;
        }
        Ok(())
    })?;
    recorded.into_iter().find(|change| change.undoes.as_deref() == Some(change_id)).ok_or_else(|| anyhow::anyhow!("the undo was recorded"))
}

/// What a conversation with `bot` is given of its memory (the launch note,
/// `chat::launch_note`): the bot's own notes, then its place's, [`BUDGET`]
/// lines in all, the newest of each. Each file is read as a launch reads one
/// (`chat::read_capped_to`: a regular file, at most [`READ_LIMIT`] bytes,
/// lossy, no link followed in the home) and fenced, with any line that looks
/// like a heading made plain text, so nothing in a note passes for a section
/// of the instructions. `None` when the owner turned its memory off.
pub fn for_conversation(bot: &Bot) -> Option<String> {
    use super::chat::{fenced, read_capped_tail, Read};
    if bot.memory_off {
        return None;
    }
    let Some(home) = super::home(bot) else {
        return Some("(Your memory could not be read: your home folder is not known. Do not write to it; tell your owner.)\n".into());
    };
    let place = working_place(bot);
    let read = |place: &Place| {
        let rel = place.memory_file();
        match changes::no_links(&home, &rel) {
            Ok(()) => read_capped_tail(&home.join(&rel), READ_LIMIT),
            Err(error) => Read::Unreadable(format!("{error:#}")),
        }
    };
    let (own, theirs) = (read(&Place::Bot), read(&place));
    let count = |read: &Read| if let Read::Text(text, _) = read { text.lines().count() } else { 0 };
    let (own_read, place_read) = read_split(count(&own), count(&theirs));
    let section = |title: String, file: String, read: &Read, take: usize, empty: &str| {
        let body = match read {
            Read::Text(text, cut) if !text.trim().is_empty() => {
                let lines: Vec<&str> = text.lines().collect();
                // The newest `take` lines, fewer when they pass the bytes a file may take.
                let mut bytes = 0;
                let take = lines[lines.len() - take..].iter().rev().take_while(|line| {
                    bytes += line.len() + 1;
                    bytes <= SHOWN_BYTES
                }).count();
                let shown = lines[lines.len() - take..].iter().map(|line| plain_line(line)).collect::<Vec<_>>().join("\n");
                let mut body = if take == 0 { "(none read: the budget went to the notes above)".to_string() } else { fenced("memory", &shown) };
                let left = lines.len() - take;
                if left > 0 {
                    body.push_str(&format!("\n\n({left} older lines in {file} are not shown here.)"));
                }
                if *cut {
                    body.push_str(&format!("\n\n(Older lines in {file} are not shown here: it is past the {} KB limit, and only its end is read.)", READ_LIMIT / 1024));
                }
                body
            }
            Read::Text(..) | Read::Missing => empty.to_string(),
            Read::Unreadable(why) => format!("({file} could not be read: {why}. Do not write over it; tell your owner.)"),
        };
        format!("## {title}\n\n{body}\n")
    };
    let own_file = Place::Bot.memory_file();
    let place_file = place.memory_file();
    let place_title = match &place {
        Place::Org(id) => format!("Notes kept in organisation {} ({place_file})", plain_line(id)),
        _ => format!("Personal notes ({place_file})"),
    };
    Some(format!(
        "{}\n{}",
        section(format!("Notes that go with you ({own_file})"), own_file.clone(), &own, own_read, "(empty: nothing written yet)"),
        section(place_title, place_file.clone(), &theirs, place_read, "(nothing kept here yet)")
    ))
}

/// A line of a note as the launch note shows it: one that would read as a
/// Markdown heading is escaped, so it is never taken for a section.
fn plain_line(line: &str) -> String {
    if line.trim_start().starts_with('#') { format!("\\{}", line.trim_start()) } else { line.to_owned() }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleVersion {
    /// The change that left it; `None` for the role template's text the bot was built from.
    pub change: Option<String>,
    pub at: String,
    pub by: String,
    pub kind: String,
    pub source: Source,
    /// The hash of its text, fetched with `memoryText` when shown; `None` for no file.
    pub hash: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleView {
    pub path: String,
    /// What a conversation reads: at most [`ROLE_LIMIT`] bytes.
    pub text: String,
    /// The most a role may be ([`ROLE_LIMIT`]).
    pub limit: u64,
    /// The hash of the file as read, for the editor's save to name what it started from.
    pub hash: String,
    /// Whether the editor may save it: read whole, so a save never cuts it short.
    pub editable: bool,
    #[serde(flatten)]
    pub read: Limited,
    pub template_title: Option<String>,
    /// Newest first; the template's last.
    pub versions: Vec<RoleVersion>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceView {
    /// `bot`, `personal`, or the organisation's id.
    pub key: String,
    pub path: String,
    pub lines: Vec<String>,
    /// Given to a conversation in the place the bot works in.
    pub read: bool,
    /// How many of its lines a conversation reads (the last ones), and how many it does not.
    pub read_lines: usize,
    pub not_read: usize,
    pub archive_lines: usize,
    #[serde(flatten)]
    pub file: Limited,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicView {
    pub place: String,
    pub name: String,
    pub path: String,
    pub lines: usize,
    pub modified: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryView {
    pub off: bool,
    pub budget: usize,
    pub read_limit: u64,
    /// The place a conversation works in.
    pub working_place: String,
    /// Lines a conversation starts with.
    pub read: usize,
    pub places: Vec<PlaceView>,
    pub topics: Vec<TopicView>,
}

/// A change as the screen lists it: its edits and texts are left out.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeShown {
    pub id: String,
    pub at: String,
    pub kind: String,
    pub text: String,
    pub source: Source,
    pub by: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub undoes: Option<String>,
    /// The undo that undid it.
    pub undone_by: Option<String>,
    /// Why it cannot be undone; `None` when Undo is offered.
    pub not_undoable: Option<String>,
}

impl ChangeShown {
    fn of(change: &Change, undone_by: Option<String>, not_undoable: Option<&str>) -> Self {
        let text: String = change.text.chars().take(MAX_NOTE_CHARS).collect();
        Self { id: change.id.clone(), at: change.at.clone(), kind: change.kind.clone(), text, source: change.source.clone(), by: change.by.clone(), undoes: change.undoes.clone(), undone_by, not_undoable: not_undoable.map(str::to_owned) }
    }
}

/// Changes just recorded, as the command line answers them.
pub fn shown(recorded: &[Change]) -> Vec<ChangeShown> {
    recorded.iter().map(|change| ChangeShown::of(change, None, None)).collect()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub role: RoleView,
    pub memory: MemoryView,
    /// Newest first.
    pub changes: Vec<ChangeShown>,
    /// Changes in the log, of which `changes` shows the newest.
    pub total_changes: usize,
    /// Lines of the log this build cannot read. They are kept.
    pub unreadable_changes: usize,
    /// The files that look like they hold a secret (a key, a token, a password), by path.
    pub secrets: Vec<String>,
}

fn modified(path: &Path) -> Option<String> {
    let time = std::fs::symlink_metadata(path).ok()?.modified().ok()?;
    Some(chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

/// Everything the Role and memory screen shows. Edits made outside the app since it last looked are recorded first.
pub fn view(sink: &dyn EventSink, bot: &Bot) -> Result<View> {
    changes::commit(sink, &bot.id, |_| Ok(()))?;
    let home = bot_store::home_dir(&bot.id)?;
    let shown = |rel: &str| home.join(rel).to_string_lossy().into_owned();
    let log = changes::read_log(&bot.id)?;
    let mut secrets = Vec::new();

    let role = read_in_home(&home, bot_store::ROLE_FILE);
    if looks_secret(&role.text) {
        secrets.push(shown(bot_store::ROLE_FILE));
    }
    let template = super::templates::find(&bot.role_template_id);
    let mut versions: Vec<RoleVersion> = log.changes.iter().rev().filter_map(|change| {
        Some(RoleVersion { change: Some(change.id.clone()), at: change.at.clone(), by: change.by.clone(), kind: change.kind.clone(), source: change.source.clone(), hash: role_after(change)? })
    }).collect();
    if let Some(template) = &template {
        versions.push(RoleVersion { change: None, at: bot.created.clone(), by: OWNER.into(), kind: "template".into(), source: Source::of("template"), hash: Some(changes::hash_of(&super::role_text(template))) });
    }
    // One limit everywhere: a role over it is shown as read, and not saved from here.
    let editable = role.problem.is_none() && !role.over_limit;
    let role = RoleView { path: shown(bot_store::ROLE_FILE), hash: changes::hash_of(&role.text), text: role.text.clone(), limit: ROLE_LIMIT, editable, read: role, template_title: template.map(|template| template.title.to_string()), versions };

    let working = working_place(bot);
    let read_files: Vec<String> = [Place::Bot.memory_file(), working.memory_file()].into();
    let mut counts = BTreeMap::new();
    for rel in &read_files {
        counts.insert(rel.clone(), changes::lines_of(&read_in_home(&home, rel).text).len());
    }
    let (own_read, place_read) = read_split(counts[&Place::Bot.memory_file()], counts[&working.memory_file()]);
    let mut place_views = Vec::new();
    let mut topics = Vec::new();
    for place in places(bot) {
        let file = read_in_home(&home, &place.memory_file());
        if looks_secret(&file.text) {
            secrets.push(shown(&place.memory_file()));
        }
        let lines = changes::lines_of(&file.text);
        let read_lines = if place == Place::Bot { own_read } else if place == working { place_read } else { 0 };
        let read = place == Place::Bot || place == working;
        let archive_lines = read_in_home(&home, &place.archive_file()).text.lines().count();
        place_views.push(PlaceView { key: place.key().into(), path: shown(&place.memory_file()), not_read: if read { lines.len() - read_lines } else { 0 }, read_lines, read, archive_lines, lines, file });
        // A topics folder reached through a link is not listed.
        let listed = changes::no_links(&home, &format!("{}/{ARCHIVE_FILE}", place.topics_dir())).is_ok() && std::fs::symlink_metadata(home.join(place.topics_dir())).is_ok_and(|meta| meta.is_dir());
        if let Some(entries) = listed.then(|| std::fs::read_dir(home.join(place.topics_dir())).ok()).flatten() {
            let mut names: Vec<String> = entries.flatten().filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file())).filter_map(|entry| entry.file_name().to_str().map(str::to_owned)).filter(|name| name.ends_with(".md") && changes::checked(name).is_ok()).collect();
            names.sort_by_key(|name| (name.starts_with("archive"), name.clone()));
            for name in names {
                let rel = format!("{}/{name}", place.topics_dir());
                let path = home.join(&rel);
                let text = read_in_home(&home, &rel).text;
                if looks_secret(&text) {
                    secrets.push(path.to_string_lossy().into_owned());
                }
                topics.push(TopicView { place: place.key().into(), lines: text.lines().count(), modified: modified(&path), path: path.to_string_lossy().into_owned(), name });
            }
        }
    }
    let memory = MemoryView { off: bot.memory_off, budget: BUDGET, read_limit: READ_LIMIT, working_place: working.key().into(), read: own_read + place_read, places: place_views, topics };

    let undone_by: BTreeMap<&str, &str> = log.changes.iter().filter_map(|change| Some((change.undoes.as_deref()?, change.id.as_str()))).collect();
    let total_changes = log.changes.len();
    let changes = log.changes.iter().rev().take(SHOWN_CHANGES).map(|change| ChangeShown::of(change, undone_by.get(change.id.as_str()).map(|id| (*id).to_owned()), changes::not_undoable(change, &log))).collect();
    Ok(View { role, memory, changes, total_changes, unreadable_changes: log.unreadable, secrets })
}

/// From the role template's text to the role now: `None` with no template, or too long to compare.
pub fn template_diff(bot: &Bot) -> Result<Option<Vec<DiffLine>>> {
    let Some(template) = super::templates::find(&bot.role_template_id) else { return Ok(None) };
    let home = bot_store::home_dir(&bot.id)?;
    let role = read_in_home(&home, bot_store::ROLE_FILE);
    Ok(changes::diff(&changes::lines_of(&super::role_text(&template)), &changes::lines_of(&role.text)))
}

/// One note a tidy names: its line number as `terminalx bots memory list`
/// shows it (from 1), and its text, so a file changed since it was read is
/// never tidied by line numbers that now point elsewhere.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TidyLine {
    /// `bot` (the default), `personal`, or an organisation the bot works in.
    #[serde(default)]
    pub place: Option<String>,
    pub line: usize,
    pub note: String,
}

/// Notes that say the same thing, made one.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TidyMerge {
    pub lines: Vec<TidyLine>,
    /// The one note they become.
    pub into: String,
}

/// A whole tidy of a bot's memory (PRO-477): notes merged and notes removed
/// (a duplicate, or one a newer note contradicts), recorded as one change.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TidyPlan {
    #[serde(default)]
    pub merge: Vec<TidyMerge>,
    #[serde(default)]
    pub remove: Vec<TidyLine>,
}

/// The most notes one tidy names.
pub const TIDY_MAX_LINES: usize = 200;
/// What a tidy's change is recorded as.
pub const TIDY_KIND: &str = "tidied";

/// What a tidy did, in a line.
fn tidy_text(merges: usize, merged: usize, removed: usize) -> String {
    let plural = |count: usize, one: &str, many: &str| if count == 1 { format!("1 {one}") } else { format!("{count} {many}") };
    let mut parts = Vec::new();
    if merges > 0 {
        parts.push(format!("merged {} into {}", plural(merged, "note", "notes"), plural(merges, "note", "notes")));
    }
    if removed > 0 {
        parts.push(format!("removed {}", plural(removed, "note", "notes")));
    }
    format!("Tidied memory: {}", parts.join(", "))
}

/// Tidy `bot`'s memory as `plan` says: each merge's notes become its one
/// note, in the place of the first of them, dated as the newest of them, and
/// each removed note goes. Every line is named by its number and its text;
/// one that no longer reads so refuses the whole tidy, and nothing is
/// written. The whole tidy is one change in the history, which one Undo
/// puts back. `places` are the places the caller may tidy. With `once_in`, a
/// session that already tidied (a Tidy memory run tidies once) is refused,
/// judged under the history's lock, so two tidies sent at once record one.
pub fn tidy(sink: &dyn EventSink, bot: &Bot, plan: &TidyPlan, places: &[Place], by: &str, source: Source, once_in: Option<&str>) -> Result<Vec<Change>> {
    let named = plan.merge.iter().map(|merge| merge.lines.len()).sum::<usize>() + plan.remove.len();
    if named == 0 {
        return Err(refused("Nothing to tidy: name notes to merge or remove. When nothing needs tidying, change nothing."));
    }
    if named > TIDY_MAX_LINES {
        return Err(refused(format!("One tidy names at most {TIDY_MAX_LINES} notes.")));
    }
    if plan.merge.iter().any(|merge| merge.lines.len() < 2) {
        return Err(refused("A merge makes two or more notes one: name each of them."));
    }
    let merged: Vec<String> = plan.merge.iter().map(|merge| clean_note(&merge.into)).collect::<Result<_>>()?;
    let place_of = |line: &TidyLine| -> Result<Place> {
        let place = Place::parse(bot, line.place.as_deref().unwrap_or(BOT_PLACE))?;
        if !places.contains(&place) {
            return Err(refused(format!("This tidy may not change {}.", place_label(&place))));
        }
        Ok(place)
    };
    let ((), recorded) = changes::commit(sink, &bot.id, |files| {
        if let Some(session) = once_in {
            if changes::read_log(&bot.id)?.changes.iter().any(|change| change.kind == TIDY_KIND && change.source.session.as_deref() == Some(session)) {
                return Err(refused("This run already tidied your memory: one tidy is one change. Reply with what you merged and removed."));
            }
        }
        // Each named note, checked against the file as it is now, and named once.
        let mut texts: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut taken: BTreeSet<(String, usize)> = BTreeSet::new();
        let mut take = |files: &mut changes::Files, texts: &mut BTreeMap<String, Vec<String>>, line: &TidyLine| -> Result<(String, usize)> {
            let file = place_of(line)?.memory_file();
            if !texts.contains_key(&file) {
                texts.insert(file.clone(), files.lines(&file)?);
            }
            let lines = &texts[&file];
            let at = line.line.checked_sub(1).ok_or_else(|| refused("Lines are counted from 1, as `terminalx bots memory list` shows them."))?;
            let found = lines.get(at).filter(|found| is_note(found) && note_text(found).eq_ignore_ascii_case(line.note.trim()));
            if found.is_none() {
                return Err(refused(format!("Line {} of {file} does not read “{}”: memory changed since it was read. List it again and tidy what it says now.", line.line, line.note.trim())));
            }
            if !taken.insert((file.clone(), at)) {
                return Err(refused(format!("Line {} of {file} is named twice: a note is merged or removed once.", line.line)));
            }
            Ok((file, at))
        };
        // file -> (line index -> what takes its place: nothing, or a merged note)
        let mut plan_of: BTreeMap<String, BTreeMap<usize, Option<String>>> = BTreeMap::new();
        for (merge, into) in plan.merge.iter().zip(&merged) {
            let mut lines = Vec::new();
            for line in &merge.lines {
                lines.push(take(files, &mut texts, line)?);
            }
            let newest = lines.iter().filter_map(|(file, at)| note_date(&texts[file][*at])).max().map(str::to_owned).unwrap_or_else(today);
            let (first_file, first) = lines.iter().min().cloned().expect("a merge names two or more notes");
            for (file, at) in &lines {
                let replacement = (*file == first_file && *at == first).then(|| format!("- {newest} {into}"));
                plan_of.entry(file.clone()).or_default().insert(*at, replacement);
            }
        }
        for line in &plan.remove {
            let (file, at) = take(files, &mut texts, line)?;
            plan_of.entry(file).or_default().insert(at, None);
        }
        let mut edits = Vec::new();
        for (file, changed) in &plan_of {
            let before = &texts[file];
            // Removed from the bottom up, so each index still holds.
            for (&at, _) in changed.iter().rev() {
                edits.push(Edit::RemoveLine { file: file.clone(), line: before[at].clone(), index: Some(at), prev: at.checked_sub(1).map(|above| before[above].clone()) });
            }
            // Then each merged note in the place of its first note, top down in the file as it will be.
            let mut after: Vec<String> = Vec::new();
            for (at, line) in before.iter().enumerate() {
                match changed.get(&at) {
                    None => after.push(line.clone()),
                    Some(None) => {}
                    Some(Some(note)) => {
                        edits.push(Edit::AddLine { file: file.clone(), line: note.clone(), index: Some(after.len()), prev: after.last().cloned() });
                        after.push(note.clone());
                    }
                }
            }
        }
        let text = tidy_text(plan.merge.len(), plan.merge.iter().map(|merge| merge.lines.len()).sum(), plan.remove.len());
        files.record(NewChange::new(TIDY_KIND, text, edits, source, by))
    })?;
    Ok(recorded)
}

/// The places a conversation with `bot` keeps notes in: its own and its working place's.
pub fn conversation_places(bot: &Bot) -> Vec<Place> {
    let working = working_place(bot);
    if working == Place::Bot { vec![Place::Bot] } else { vec![Place::Bot, working] }
}

/// The memory operations of the runtime's `bots` call, made in the app by
/// the owner, or `None` for an operation that is not one of them.
pub fn call(sink: &dyn EventSink, operation: &str, params: &Value) -> Option<Result<Value>> {
    if !matches!(operation, "memoryView" | "memoryLook" | "memoryAdd" | "memoryForget" | "memoryUndo" | "memoryText" | "roleRestore" | "roleDiff") {
        return None;
    }
    Some((|| {
        let string = |key: &str| params[key].as_str().ok_or_else(|| refused(format!("{key} must be a string")));
        // Inert with the switch off, the look over every bot included.
        super::require_enabled()?;
        if operation == "memoryLook" && params["id"].is_null() {
            return Ok(json!({"found": changes::look_all(sink)?}));
        }
        let bot = super::get(string("id")?)?;
        let app = || Source::of("app");
        let place = || Place::parse(&bot, params["place"].as_str().unwrap_or(BOT_PLACE));
        Ok(match operation {
            "memoryView" => serde_json::to_value(view(sink, &bot)?)?,
            "memoryLook" => json!({"found": changes::commit(sink, &bot.id, |_| Ok(()))?.1.len()}),
            "memoryAdd" => json!(shown(&add(sink, &bot, &place()?, string("text")?, OWNER, app())?)),
            "memoryForget" => {
                let index = params["index"].as_u64().map(|index| index as usize);
                json!(shown(&forget(sink, &bot, &place()?, string("line")?, index, OWNER, app())?))
            }
            "memoryUndo" => json!(shown(&[undo(sink, &bot, string("change")?, OWNER, app())?])[0]),
            "memoryText" => json!(role_text(&bot, string("hash")?)?),
            "roleDiff" => json!(template_diff(&bot)?),
            _ => json!(shown(&restore_role(sink, &bot, params["change"].as_str())?)),
        })
    })())
}

#[cfg(test)]
#[path = "memory_tests.rs"]
mod tests;
