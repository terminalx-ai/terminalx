//! A bot's suggestions (PRO-477): work it proposes without being asked,
//! shown on its Home tab with Start and Dismiss.
//!
//! A bot suggests with `terminalx bots suggest --title … --why …`, from its
//! own sessions; its look around (`super::builtins`) is where it is told to,
//! and the only thing that run may do besides reading. A suggestion changes
//! nothing until the owner presses Start, which makes it an item on the bot's
//! list and sends it to the bot's home chat as the owner's message, so the
//! bot begins (`items::give`). Dismiss only closes it.
//!
//! Kept in `bot-suggestions/<id>.json` at the store root, beside the home
//! folder rather than in it, with what the bot's built-in duties remember
//! between runs: what each look around was refused, and the free checks'
//! fingerprints. That is no wall: a Full access bot can write the file with
//! its own file tools, as it can its work list (PRO-489). What the file says
//! is only ever shown as the bot's words.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::Result;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::items::one_line;
use super::{refused, Bot};
use crate::sink::EventSink;
use crate::store::index;

/// Where the suggestions are kept, under the store root.
pub const DIR: &str = "bot-suggestions";
/// The event the window reads a bot's suggestions again on.
pub const CHANGED_EVENT: &str = "bot_suggestions_changed";
const TITLE_CHARS: usize = 200;
const WHY_CHARS: usize = 400;
/// The most suggestions waiting on the owner at once.
pub const MAX_OPEN: usize = 20;
/// The most suggestions one look around makes.
pub const PER_LOOK: usize = 5;
/// How many closed suggestions are kept (started or dismissed), the newest.
const KEEP_CLOSED: usize = 50;
/// How many looks remember what they were refused, the newest.
const KEEP_LOOKS: usize = 20;
/// The most refusals one look remembers.
const KEEP_REFUSED: usize = 10;

pub const OPEN: &str = "open";
pub const STARTED: &str = "started";
pub const DISMISSED: &str = "dismissed";

/// Where a suggestion came from: a look around's run, or another of the bot's sessions.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct From {
    /// `lookAround` or `chat`.
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// The look around's run, by its automation run id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_number: Option<u64>,
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub number: u64,
    pub title: String,
    pub why: String,
    /// [`OPEN`], [`STARTED`] or [`DISMISSED`]; another a newer build wrote is kept and counts as closed.
    pub state: String,
    pub created: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed: Option<String>,
    pub from: From,
    /// The item Start made.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item: Option<u64>,
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, Value>,
}

impl Suggestion {
    pub fn open(&self) -> bool {
        self.state == OPEN
    }
}

/// What one look around was refused: the actions TerminalX stopped before they ran.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookNote {
    pub at: String,
    /// How many actions were refused, and the first few of them in words.
    pub refused: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub what: Vec<String>,
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct File {
    #[serde(default = "first")]
    pub next: u64,
    /// Kept as written: one this build cannot read stays, and is shown by none.
    #[serde(default)]
    pub suggestions: Vec<Value>,
    /// By the look around's run id.
    #[serde(default)]
    pub looks: BTreeMap<String, LookNote>,
    /// What the free checks compare with (`builtins`): what the last finished look around saw, and the memory
    /// as the last tidy left it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub looked: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tidied: Option<String>,
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, Value>,
}

fn first() -> u64 {
    1
}

impl File {
    /// The suggestions this build reads.
    pub fn readable(&self) -> Vec<Suggestion> {
        self.suggestions.iter().filter_map(|value| serde_json::from_value(value.clone()).ok()).collect()
    }

    pub fn open(&self) -> Vec<Suggestion> {
        self.readable().into_iter().filter(Suggestion::open).collect()
    }

    fn unreadable(&self) -> usize {
        self.suggestions.len() - self.readable().len()
    }
}

static LOCK: Mutex<()> = Mutex::new(());

fn path(bot_id: &str) -> Result<PathBuf> {
    // An id from a record is never trusted to stay inside the folder.
    anyhow::ensure!(!bot_id.is_empty() && bot_id.len() <= 64 && bot_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'), "a bot's id names no file");
    Ok(crate::store::root()?.join(DIR).join(format!("{bot_id}.json")))
}

/// The bot's file as it is now; empty when there is none.
pub fn read(bot_id: &str) -> Result<File> {
    Ok(crate::store::read_json::<File>(&path(bot_id)?)?.unwrap_or(File { next: 1, ..Default::default() }))
}

/// Change the bot's file under its lock, and say so to the window when the suggestions changed.
pub fn change<T>(sink: Option<&dyn EventSink>, bot_id: &str, f: impl FnOnce(&mut File) -> Result<T>) -> Result<T> {
    let _lock = LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let mut file = read(bot_id)?;
    let before = file.suggestions.clone();
    let out = f(&mut file)?;
    trim(&mut file);
    let path = path(bot_id)?;
    crate::store::ensure_dir(path.parent().expect("a file in a folder").to_path_buf())?;
    crate::store::write_json(&path, &file)?;
    if let Some(sink) = sink.filter(|_| before != file.suggestions) {
        sink.emit(CHANGED_EVENT, &json!({"botId": bot_id}));
    }
    Ok(out)
}

/// Closed suggestions past the newest [`KEEP_CLOSED`] go, and so do the oldest looks' notes.
fn trim(file: &mut File) {
    let closed: Vec<usize> = file
        .suggestions
        .iter()
        .enumerate()
        .filter(|(_, value)| serde_json::from_value::<Suggestion>((*value).clone()).is_ok_and(|suggestion| !suggestion.open()))
        .map(|(at, _)| at)
        .collect();
    if closed.len() > KEEP_CLOSED {
        let drop: Vec<usize> = closed[..closed.len() - KEEP_CLOSED].to_vec();
        let mut at = 0;
        file.suggestions.retain(|_| {
            let keep = !drop.contains(&at);
            at += 1;
            keep
        });
    }
    while file.looks.len() > KEEP_LOOKS {
        let oldest = file.looks.iter().min_by(|a, b| a.1.at.cmp(&b.1.at)).map(|(id, _)| id.clone()).expect("not empty");
        file.looks.remove(&oldest);
    }
}

/// A bot's new suggestion, from one of its sessions.
pub fn suggest(sink: &dyn EventSink, bot: &Bot, title: &str, why: &str, from: From) -> Result<Suggestion> {
    let title = one_line("A suggestion's title", title, TITLE_CHARS)?;
    let why = one_line("Why it is worth doing", why, WHY_CHARS)?;
    if super::memory::looks_secret(&title) || super::memory::looks_secret(&why) {
        return Err(refused("That looks like it holds a secret (a key or a token). Say what to do without it."));
    }
    change(Some(sink), &bot.id, |file| {
        let suggestions = file.readable();
        let open: Vec<&Suggestion> = suggestions.iter().filter(|suggestion| suggestion.open()).collect();
        if open.iter().any(|suggestion| suggestion.title.eq_ignore_ascii_case(&title)) {
            return Err(refused("You already suggested that, and it is still waiting for your owner."));
        }
        if open.len() >= MAX_OPEN {
            return Err(refused(format!("{MAX_OPEN} of your suggestions are waiting for your owner already: make no more until they start or dismiss some.")));
        }
        if let Some(run) = &from.run {
            let made = suggestions.iter().filter(|suggestion| suggestion.from.run.as_ref() == Some(run)).count();
            if made >= PER_LOOK {
                return Err(refused(format!("A look around makes at most {PER_LOOK} suggestions: keep the most useful.")));
            }
        }
        let suggestion = Suggestion { number: file.next, title, why, state: OPEN.into(), created: index::now(), closed: None, from, item: None, unknown: BTreeMap::new() };
        file.next += 1;
        file.suggestions.push(serde_json::to_value(&suggestion)?);
        Ok(suggestion)
    })
}

/// Close open suggestion `number` as `state`, with the item Start made.
fn close(sink: &dyn EventSink, bot: &Bot, number: u64, state: &str, item: Option<u64>) -> Result<Suggestion> {
    change(Some(sink), &bot.id, |file| {
        let at = file
            .suggestions
            .iter()
            .position(|value| value["number"].as_u64() == Some(number))
            .ok_or_else(|| refused(format!("{} has no suggestion {number}.", bot.name)))?;
        let mut suggestion: Suggestion = serde_json::from_value(file.suggestions[at].clone()).map_err(|_| refused("That suggestion was saved by a newer TerminalX and is kept as it is."))?;
        if !suggestion.open() {
            return Err(refused(format!("That suggestion was already {}.", if suggestion.state == STARTED { "started" } else { "dismissed" })));
        }
        suggestion.state = state.into();
        suggestion.closed = Some(index::now());
        suggestion.item = item;
        file.suggestions[at] = serde_json::to_value(&suggestion)?;
        Ok(suggestion)
    })
}

/// The open suggestion `number`, as it is now.
fn open_one(bot: &Bot, number: u64) -> Result<Suggestion> {
    read(&bot.id)?
        .readable()
        .into_iter()
        .find(|suggestion| suggestion.number == number)
        .filter(Suggestion::open)
        .ok_or_else(|| refused(format!("{} has no open suggestion {number}.", bot.name)))
}

/// Start: the suggestion becomes an item the owner gave, already in progress, and is sent to the bot's home chat as
/// the owner's message, so the bot begins. The owner's press is what makes it their words.
pub fn start(manager: &crate::session::SessionManager, bot: &Bot, number: u64) -> Result<Value> {
    let suggestion = open_one(bot, number)?;
    let sink = manager.sink();
    let summary = format!("{}\n\nYou suggested this{}; your owner pressed Start.", suggestion.why, match suggestion.from.run_number {
        Some(run) => format!(" in your look around (run {run})"),
        None => String::new(),
    });
    let (item, answer) = super::items::give(manager, bot, &suggestion.title, &summary, true)?;
    let closed = close(sink.as_ref(), bot, number, STARTED, Some(item))?;
    Ok(json!({"suggestion": closed, "item": answer["item"], "delivery": answer["delivery"]}))
}

pub fn dismiss(sink: &dyn EventSink, bot: &Bot, number: u64) -> Result<Suggestion> {
    close(sink, bot, number, DISMISSED, None)
}

/// A deleted bot's suggestions go to the trash with it.
pub fn trash(bot_id: &str) -> Result<()> {
    let from = path(bot_id)?;
    if !from.is_file() {
        return Ok(());
    }
    let trash = crate::store::ensure_dir(crate::store::root()?.join("trash").join(DIR))?;
    let mut target = trash.join(format!("{bot_id}.json"));
    let mut copy = 2;
    while target.exists() {
        target = trash.join(format!("{bot_id}-{copy}.json"));
        copy += 1;
    }
    std::fs::rename(&from, &target)?;
    Ok(())
}

/// Remember that a look around was refused `what` (an action, in words).
pub fn note_refused(bot_id: &str, run_id: &str, what: &str) {
    let what: String = what.chars().take(160).collect();
    let noted = change(None, bot_id, |file| {
        let note = file.looks.entry(run_id.into()).or_insert_with(|| LookNote { at: index::now(), ..Default::default() });
        note.refused += 1;
        if note.what.len() < KEEP_REFUSED && !note.what.contains(&what) {
            note.what.push(what);
        }
        Ok(())
    });
    if let Err(error) = noted {
        log::warn!("bot {bot_id}: note what its look around was refused: {error:#}");
    }
}

/// The window's view of a bot's suggestions: the open ones, newest first.
pub fn listing(bot: &Bot) -> Result<Value> {
    let file = read(&bot.id)?;
    let mut open = file.open();
    open.reverse();
    Ok(json!({"suggestions": open, "unreadable": file.unreadable()}))
}

/// The suggestion operations of the runtime's `bots` call, as the window sends
/// them, or `None` for another. Start needs a person (`enforce::needs_person`);
/// reading and Dismiss give the bot nothing.
pub fn runtime_call(manager: &crate::session::SessionManager, operation: &str, params: &Value) -> Option<Result<Value>> {
    if !matches!(operation, "suggestions" | "suggestionStart" | "suggestionDismiss") {
        return None;
    }
    Some((|| {
        super::require_enabled()?;
        let bot = super::get(params["id"].as_str().ok_or_else(|| refused("id must be a string"))?)?;
        let number = || params["number"].as_u64().filter(|number| *number > 0).ok_or_else(|| refused("number must be a suggestion's number"));
        Ok(match operation {
            "suggestions" => {
                // A bot hired before its built-ins existed gets them when its Home tab is first read, switched off for
                // the owner to turn on. Only the window reads this; a bot's own process may not (`control::runtime_read`).
                if let Err(error) = super::builtins::ensure(manager.sink().as_ref(), &bot, false) {
                    log::warn!("bot {}: add its built-in duties: {error:#}", bot.id);
                }
                let mut shown = listing(&bot)?;
                shown["status"] = super::builtins::status(&bot)?;
                shown
            }
            "suggestionStart" => start(manager, &bot, number()?)?,
            _ => serde_json::to_value(dismiss(manager.sink().as_ref(), &bot, number()?)?)?,
        })
    })())
}

#[cfg(test)]
#[path = "suggestions_tests.rs"]
mod tests;
