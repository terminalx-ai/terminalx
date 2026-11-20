//! A bot's role and memory as the owner reads and changes them (PRO-470).
//!
//! Memory is kept in three kinds of place, each a folder of the bot's home
//! with its own `MEMORY.md` (one dated note per line), its `memory/` topic
//! files and `memory/archive.md`:
//!
//! - the bot itself (the home folder): notes that go with the bot;
//! - each organisation it works in (`orgs/<name>-<hash>/`): notes that stay there;
//! - `personal/`: notes for the work it does for its owner alone.
//!
//! A conversation is given the bot's own notes and those of the place it
//! works in (the first of its `works_in`), [`BUDGET`] lines in all, the
//! bot's own first. Adding a note past the budget moves the oldest notes of
//! those two files to their archives. Every write is recorded in the change
//! log ([`super::changes`]) and can be undone.
//!
//! What is read for a conversation is read with limits: a regular file
//! only, at most [`READ_LIMIT`] bytes, decoded lossily. It is the bot's own
//! notes, never instructions or approval.

use std::collections::BTreeMap;
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
/// How much of a role or memory file is read for a conversation.
pub const READ_LIMIT: u64 = 64 * 1024;
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
    /// Stays in one organisation, by its name as the bot's `works_in` has it.
    Org(String),
    /// The owner's own work.
    Personal,
}

impl Place {
    /// `bot`, `personal`, or the organisation's name.
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
            Self::Org(name) => format!("{ORGS_DIR}/{}/", org_folder(name)),
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

/// An organisation's folder: its name made safe, and a short hash of the
/// exact name so two names that look alike never share one.
fn org_folder(name: &str) -> String {
    let hash = sha2::Sha256::digest(name.as_bytes());
    let short: String = hash.iter().take(4).map(|byte| format!("{byte:02x}")).collect();
    format!("{}-{short}", super::slugify(name))
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

/// Read a file the way a conversation is given it: a regular file only, at
/// most [`READ_LIMIT`] bytes, decoded lossily. A missing file reads as empty.
pub fn read_limited(path: &Path) -> Limited {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Limited::default(),
        Err(error) => return Limited { problem: Some(format!("It cannot be read: {error}")), ..Default::default() },
    };
    if !meta.file_type().is_file() {
        return Limited { problem: Some("It is not a regular file, so it is not read.".into()), ..Default::default() };
    }
    let mut bytes = Vec::new();
    let read = std::fs::File::open(path).and_then(|file| file.take(READ_LIMIT).read_to_end(&mut bytes));
    if let Err(error) = read {
        return Limited { bytes: meta.len(), problem: Some(format!("It cannot be read: {error}")), ..Default::default() };
    }
    let over_limit = meta.len() > READ_LIMIT;
    if over_limit {
        // A line cut in half is not read.
        let whole = bytes.iter().rposition(|byte| *byte == b'\n').map_or(0, |at| at + 1);
        bytes.truncate(whole);
    }
    Limited { text: String::from_utf8_lossy(&bytes).into_owned(), bytes: meta.len(), over_limit, problem: None }
}

/// [`read_limited`] for a file of the home, by its path there: one reached
/// through a link the home does not own reads as nothing, and says why.
pub fn read_in_home(home: &Path, rel: &str) -> Limited {
    match changes::no_links(home, rel) {
        Ok(()) => read_limited(&home.join(rel)),
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
        r"(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}",
        r"|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|AIza[0-9A-Za-z_-]{30,}|lin_api_[A-Za-z0-9]{20,}",
        r"|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.)"
    ))
    .expect("the secret pattern compiles")
});

/// Whether a note looks like it holds a key or a token. Bots keep no secrets in memory.
pub fn looks_secret(text: &str) -> bool {
    SECRET.is_match(text)
}

fn clean_note(text: &str) -> Result<String> {
    let note = text.trim();
    if note.is_empty() {
        return Err(refused("A note needs some text."));
    }
    if note.chars().any(char::is_control) {
        return Err(refused("A note is one line."));
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

/// How many lines of the bot's own notes and of its place's a conversation reads.
pub fn read_split(own: usize, place: usize) -> (usize, usize) {
    let own_read = own.min(BUDGET);
    (own_read, place.min(BUDGET - own_read))
}

/// The two memory files a note in `place` is read with.
fn read_with(bot: &Bot, place: &Place) -> Option<Place> {
    match place {
        Place::Bot => Some(working_place(bot)),
        _ => Some(place.clone()),
    }
}

/// Keep the bot's own notes and `place`'s within [`BUDGET`] lines together:
/// the oldest notes (by date, then the higher in the file) move to their
/// file's archive, as one `archived` change. `keep` is never moved.
fn archive_over_budget(files: &mut changes::Files, bot: &Bot, place: &Place, keep: Option<(&str, &str)>) -> Result<usize> {
    let Some(other) = read_with(bot, place) else { return Ok(0) };
    let pair = [Place::Bot, other];
    let mut texts = Vec::new();
    for place in &pair {
        texts.push(files.lines(&place.memory_file())?);
    }
    let total: usize = texts.iter().map(Vec::len).sum();
    if total <= BUDGET {
        return Ok(0);
    }
    let mut notes: Vec<(&str, usize, usize)> = Vec::new();
    for (which, lines) in texts.iter().enumerate() {
        for (at, line) in lines.iter().enumerate() {
            let kept = keep.is_some_and(|(file, kept)| file == pair[which].memory_file() && kept == line);
            if let (Some(date), false) = (note_date(line), kept) {
                notes.push((date, which, at));
            }
        }
    }
    notes.sort();
    notes.truncate(total - BUDGET);
    if notes.is_empty() {
        return Ok(0);
    }
    let moved = notes.len();
    // Removed from the bottom up so each index still holds, then added to the archives oldest first.
    let mut removals = notes.clone();
    removals.sort_by(|a, b| (a.1, b.2).cmp(&(b.1, a.2)));
    let mut edits: Vec<Edit> = removals.iter().map(|(_, which, at)| Edit::RemoveLine { file: pair[*which].memory_file(), line: texts[*which][*at].clone(), index: Some(*at) }).collect();
    edits.extend(notes.iter().map(|(_, which, at)| Edit::AddLine { file: pair[*which].archive_file(), line: texts[*which][*at].clone(), index: None }));
    let text = format!("Moved {moved} older note{} to the archive to stay within {BUDGET} lines", if moved == 1 { "" } else { "s" });
    files.record(NewChange { kind: "archived".into(), text, edits, source: Source::of("budget"), by: OWNER.into(), undoes: None })?;
    Ok(moved)
}

/// Add a note to `place`, dated today, and keep within the budget. Answers the changes recorded.
pub fn add(sink: &dyn EventSink, bot: &Bot, place: &Place, text: &str, by: &str, source: Source) -> Result<Vec<Change>> {
    let note = clean_note(text)?;
    let line = format!("- {} {note}", today());
    let file = place.memory_file();
    let ((), recorded) = changes::commit(sink, &bot.id, |files| {
        if files.lines(&file)?.iter().any(|known| note_text(known).eq_ignore_ascii_case(&note)) {
            return Err(refused(format!("{} already has that note.", bot.name)));
        }
        files.record(NewChange { kind: "learned".into(), text: note.clone(), edits: vec![Edit::AddLine { file: file.clone(), line: line.clone(), index: None }], source, by: by.into(), undoes: None })?;
        archive_over_budget(files, bot, place, Some((&file, &line)))?;
        Ok(())
    })?;
    Ok(recorded)
}

/// Remove the one note in `place` that `which` names: the whole line, the
/// note's text, or a part of it that only one note has.
pub fn forget(sink: &dyn EventSink, bot: &Bot, place: &Place, which: &str, by: &str, source: Source) -> Result<Vec<Change>> {
    let wanted = which.trim();
    if wanted.is_empty() {
        return Err(refused("Say which note to forget."));
    }
    let file = place.memory_file();
    let ((), recorded) = changes::commit(sink, &bot.id, |files| {
        let lines = files.lines(&file)?;
        let lower = wanted.to_lowercase();
        let exact: Vec<usize> = (0..lines.len()).filter(|at| lines[*at].trim() == wanted || note_text(&lines[*at]).eq_ignore_ascii_case(wanted)).collect();
        let found = if exact.is_empty() { (0..lines.len()).filter(|at| note_date(&lines[*at]).is_some() && note_text(&lines[*at]).to_lowercase().contains(&lower)).collect() } else { exact };
        let at = match found.as_slice() {
            [at] => *at,
            [] => return Err(refused(format!("No note in {} matches “{wanted}”.", place_label(place)))),
            several => return Err(refused(format!("{} notes match “{wanted}”; say more of the one to forget.", several.len()))),
        };
        let line = lines[at].clone();
        files.record(NewChange { kind: "forgot".into(), text: note_text(&line).into(), edits: vec![Edit::RemoveLine { file: file.clone(), line, index: Some(at) }], source, by: by.into(), undoes: None })
    })?;
    Ok(recorded)
}

fn place_label(place: &Place) -> String {
    match place {
        Place::Bot => "the bot's own notes".into(),
        Place::Org(name) => name.clone(),
        Place::Personal => "personal notes".into(),
    }
}

/// Replace the bot's standing instructions, recorded as a `role` change. The same text records nothing.
pub fn write_role(sink: &dyn EventSink, bot: &Bot, text: &str, by: &str, source: Source, kind: &str) -> Result<Vec<Change>> {
    let ((), recorded) = changes::commit(sink, &bot.id, |files| {
        let before = files.get(bot_store::ROLE_FILE)?;
        if before.as_deref().map(str::trim_end) == Some(text.trim_end()) {
            return Ok(());
        }
        let edit = Edit::ReplaceText { file: bot_store::ROLE_FILE.into(), before, after: Some(text.into()) };
        files.record(NewChange { kind: kind.into(), text: "Standing instructions changed".into(), edits: vec![edit], source, by: by.into(), undoes: None })
    })?;
    Ok(recorded)
}

/// The role's text a change left, if it replaced the role.
fn role_after(change: &Change) -> Option<Option<String>> {
    change.known_edits()?.into_iter().rev().find_map(|edit| match edit {
        Edit::ReplaceText { file, after, .. } if file == bot_store::ROLE_FILE => Some(after),
        _ => None,
    })
}

/// Put back a version of the role: the one `change` left, or the role template's when `None`.
pub fn restore_role(sink: &dyn EventSink, bot: &Bot, change: Option<&str>) -> Result<Vec<Change>> {
    let text = match change {
        None => super::templates::find(&bot.role_template_id).map(|template| super::role_text(&template)).ok_or_else(|| refused(format!("{} was not built from a role this version knows.", bot.name)))?,
        Some(id) => {
            let log = changes::read_log(&bot.id)?;
            let change = log.changes.iter().find(|change| change.id == id).ok_or_else(|| refused(format!("No change {id} in {}'s history.", bot.name)))?;
            role_after(change).ok_or_else(|| refused("That change did not replace the role."))?.unwrap_or_default()
        }
    };
    write_role(sink, bot, &text, OWNER, Source::of("app"), "restored")
}

/// What a conversation with `bot` is given of its memory: the bot's own
/// notes, then its place's, [`BUDGET`] lines in all. `None` when the
/// owner turned its memory off.
// The bot chat's launch note (PRO-468, bots/chat.rs) gives this to the agent once it is on main.
#[cfg_attr(not(test), allow(dead_code))]
pub fn for_conversation(bot: &Bot) -> Option<String> {
    if bot.memory_off {
        return None;
    }
    let home = super::home(bot)?;
    let place = working_place(bot);
    let own = read_in_home(&home, &Place::Bot.memory_file());
    let theirs = read_in_home(&home, &place.memory_file());
    let (own_lines, place_lines) = (changes::lines_of(&own.text), changes::lines_of(&theirs.text));
    let (own_read, place_read) = read_split(own_lines.len(), place_lines.len());
    let section = |title: String, file: &Limited, lines: &[String], read: usize| {
        let mut text = format!("## {title}\n\n{}\n", if read == 0 { "(empty)".to_string() } else { lines[..read].join("\n") });
        let left = lines.len() - read;
        if left > 0 || file.over_limit {
            text.push_str(&format!("\n({} not read: past the {BUDGET}-line budget or the {} KB limit.)\n", if left > 0 { format!("{left} more lines are") } else { "The rest of the file is".into() }, READ_LIMIT / 1024));
        }
        text
    };
    let own_title = format!("Notes that go with you ({})", bot_store::MEMORY_FILE);
    let place_title = match &place {
        Place::Org(name) => format!("Notes kept in {name} ({})", place.memory_file()),
        _ => format!("Personal notes ({})", place.memory_file()),
    };
    Some(format!("{}\n{}", section(own_title, &own, &own_lines, own_read), section(place_title, &theirs, &place_lines, place_read)))
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
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoleView {
    pub path: String,
    /// The whole file, for the editor; only its first [`READ_LIMIT`] bytes reach a conversation.
    pub text: String,
    /// Whether the editor may save it: not past the size a role may be, and read whole.
    pub editable: bool,
    #[serde(flatten)]
    pub read: Limited,
    pub template_title: Option<String>,
    /// From the template's text to the role now; `None` with no template, or too long to compare.
    pub template_diff: Option<Vec<DiffLine>>,
    /// Newest first; the template's last.
    pub versions: Vec<RoleVersion>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaceView {
    /// `bot`, `personal`, or the organisation's name.
    pub key: String,
    pub path: String,
    pub lines: Vec<String>,
    /// Given to a conversation in the place the bot works in.
    pub read: bool,
    /// How many of its lines a conversation reads, and how many it does not.
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeShown {
    #[serde(flatten)]
    pub change: Change,
    /// The undo that undid it.
    pub undone_by: Option<String>,
    /// Why it cannot be undone; `None` when Undo is offered.
    pub not_undoable: Option<String>,
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

    let role = read_in_home(&home, bot_store::ROLE_FILE);
    let template = super::templates::find(&bot.role_template_id);
    let mut versions: Vec<RoleVersion> = log.changes.iter().rev().filter_map(|change| {
        Some(RoleVersion { change: Some(change.id.clone()), at: change.at.clone(), by: change.by.clone(), kind: change.kind.clone(), source: change.source.clone(), text: role_after(change)? })
    }).collect();
    if let Some(template) = &template {
        versions.push(RoleVersion { change: None, at: bot.created.clone(), by: OWNER.into(), kind: "template".into(), source: Source::of("template"), text: Some(super::role_text(template)) });
    }
    let template_diff = template.as_ref().and_then(|template| changes::diff(&changes::lines_of(&super::role_text(template)), &changes::lines_of(&role.text)));
    // The editor is given the whole file, never the part a conversation reads: saving that would cut the rest off.
    let whole = (role.problem.is_none() && role.bytes <= super::MAX_ROLE_BYTES as u64)
        .then(|| changes::no_links(&home, bot_store::ROLE_FILE).and_then(|()| changes::read_file(&home.join(bot_store::ROLE_FILE))).ok())
        .flatten();
    let (text, editable) = match whole {
        Some(text) => (text.unwrap_or_default(), true),
        None => (role.text.clone(), false),
    };
    let role = RoleView { path: shown(bot_store::ROLE_FILE), text, editable, read: role, template_title: template.map(|template| template.title.to_string()), template_diff, versions };

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
        let lines = changes::lines_of(&file.text);
        let read_lines = if place == Place::Bot { own_read } else if place == working { place_read } else { 0 };
        let read = place == Place::Bot || place == working;
        let archive_lines = read_in_home(&home, &place.archive_file()).text.lines().count();
        place_views.push(PlaceView { key: place.key().into(), path: shown(&place.memory_file()), not_read: if read { lines.len() - read_lines } else { 0 }, read_lines, read, archive_lines, lines, file });
        // A topics folder reached through a link is not listed.
        let listed = changes::no_links(&home, &format!("{}/{ARCHIVE_FILE}", place.topics_dir())).is_ok() && std::fs::symlink_metadata(home.join(place.topics_dir())).is_ok_and(|meta| meta.is_dir());
        if let Some(entries) = listed.then(|| std::fs::read_dir(home.join(place.topics_dir())).ok()).flatten() {
            let mut names: Vec<String> = entries.flatten().filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file())).filter_map(|entry| entry.file_name().to_str().map(str::to_owned)).filter(|name| name.ends_with(".md") && changes::checked(name).is_ok()).collect();
            names.sort_by_key(|name| (name == ARCHIVE_FILE, name.clone()));
            for name in names {
                let rel = format!("{}/{name}", place.topics_dir());
                let path = home.join(&rel);
                topics.push(TopicView { place: place.key().into(), lines: read_in_home(&home, &rel).text.lines().count(), modified: modified(&path), path: path.to_string_lossy().into_owned(), name });
            }
        }
    }
    let memory = MemoryView { off: bot.memory_off, budget: BUDGET, read_limit: READ_LIMIT, working_place: working.key().into(), read: own_read + place_read, places: place_views, topics };

    let total_changes = log.changes.len();
    let changes = log.changes.iter().rev().take(SHOWN_CHANGES).map(|change| ChangeShown {
        change: change.clone(),
        undone_by: log.changes.iter().find(|other| other.undoes.as_deref() == Some(change.id.as_str())).map(|other| other.id.clone()),
        not_undoable: changes::not_undoable(change, &log).map(str::to_owned),
    }).collect();
    Ok(View { role, memory, changes, total_changes, unreadable_changes: log.unreadable })
}

/// The memory operations of the runtime's `bots` call, made in the app by
/// the owner, or `None` for an operation that is not one of them.
pub fn call(sink: &dyn EventSink, operation: &str, params: &Value) -> Option<Result<Value>> {
    if !matches!(operation, "memoryView" | "memoryAdd" | "memoryForget" | "memoryUndo" | "roleRestore") {
        return None;
    }
    Some((|| {
        let string = |key: &str| params[key].as_str().ok_or_else(|| refused(format!("{key} must be a string")));
        let bot = super::get(string("id")?)?;
        let app = || Source::of("app");
        let place = || Place::parse(&bot, params["place"].as_str().unwrap_or(BOT_PLACE));
        Ok(match operation {
            "memoryView" => serde_json::to_value(view(sink, &bot)?)?,
            "memoryAdd" => json!(add(sink, &bot, &place()?, string("text")?, OWNER, app())?),
            "memoryForget" => json!(forget(sink, &bot, &place()?, string("line")?, OWNER, app())?),
            "memoryUndo" => json!(changes::undo(sink, &bot.id, string("change")?, OWNER, app())?),
            _ => json!(restore_role(sink, &bot, params["change"].as_str())?),
        })
    })())
}

#[cfg(test)]
#[path = "memory_tests.rs"]
mod tests;
