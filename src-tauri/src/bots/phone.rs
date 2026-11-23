//! What a paired phone reads of the bots and does with them (PRO-479).
//!
//! A phone reaches this through its own connection only
//! (`local_runtime::mobile::execute`, method `bots`), admitted from its
//! device record: no process in a bot's session holds one. Its acts are the
//! owner's and go through the very operations the window's are made with
//! (`enforce::call`): an answer is `itemAnswer`, a pause `pause`. Nothing here
//! answers, pauses or resumes by a path of its own.

use std::collections::BTreeMap;

use anyhow::Result;
use serde_json::{json, Value};

use super::items::{self, ItemState};
use crate::session::SessionManager;
use crate::store::index::{self, SessionEntry};

/// The most of a bot's role a phone is sent; past it the phone says it was cut.
const ROLE_BYTES: usize = 32 * 1024;
/// How many of a bot's chats a phone lists, newest first.
const CHATS: usize = 30;

/// The operations a phone may make: reads, and the owner's acts (`acts`).
pub const OPERATIONS: [&str; 7] = ["list", "home", "items", "answer", "pause", "resume", "pauseAll"];

/// Whether `operation` changes something, so only a phone allowed to drive sessions may make it.
pub fn acts(operation: &str) -> bool {
    matches!(operation, "answer" | "pause" | "resume" | "pauseAll")
}

/// One phone operation. `params` are the phone's, already checked by the phone RPC for their names.
pub fn call(manager: &SessionManager, operation: &str, params: &Value) -> Result<Value> {
    super::require_enabled()?;
    let id = || params["id"].as_str().ok_or_else(|| super::refused("id must be a string"));
    match operation {
        "list" => list(manager),
        "home" => home(manager, id()?),
        "items" => items::listing(&super::get(id()?)?.id),
        "answer" => {
            let mut call = json!({"id": id()?, "number": params["number"]});
            match (params.get("answer").filter(|value| !value.is_null()), params["text"].as_str()) {
                (Some(index), _) => call["answer"] = index.clone(),
                (None, Some(text)) => call["text"] = json!(text),
                (None, None) => return Err(super::refused("Choose an answer, or write one.")),
            }
            if let Some(question) = params["question"].as_str() {
                call["question"] = json!(question);
            }
            // A paired phone allowed to drive is the person (its device grant, checked by the runtime before this):
            // so an answer that approves a run's plan (PRO-476) is theirs, said here rather than left to a default.
            // The question's id it was shown is what `runs::refuse_approval` asks for, and the phone always sends it.
            call[super::BY_PERSON] = json!(true);
            super::enforce::call(manager, "itemAnswer", &call)
        }
        "pause" => super::enforce::call(manager, "pause", &json!({"id": id()?, "from": super::pause::FROM_PHONE})),
        "resume" => super::enforce::call(manager, "resume", &json!({"id": id()?})),
        "pauseAll" => super::enforce::call(manager, "pauseAll", &json!({"from": super::pause::FROM_PHONE})),
        other => Err(super::refused(format!("Unknown bots operation {other}"))),
    }
}

/// The Bots tab: every bot, what needs the owner across them, and a line on what each is doing.
///
/// `working` is its most recently changed item in progress; with none, what its
/// sessions in a turn are on (PRO-515: a bot whose chat, duty or worker runs
/// is never sent as doing nothing). Sessions that cannot be read leave the item's line alone.
fn list(manager: &SessionManager) -> Result<Value> {
    let listing = super::listing()?;
    let needs_you = items::needs_you(manager)?;
    let duties = next_checks();
    let sessions = index::load().unwrap_or_else(|error| {
        log::warn!("read the sessions to say what each bot is doing: {error:#}");
        Vec::new()
    });
    let team: Vec<Value> = listing
        .bots
        .iter()
        .map(|bot| {
            let working = items::read(&bot.id)
                .ok()
                .and_then(|list| list.items.into_iter().filter(|item| item.state == ItemState::InProgress).max_by(|a, b| a.modified.cmp(&b.modified)))
                .map(|item| (item.title, item.modified))
                .or_else(|| super::pause::running_now(manager, bot, &sessions));
            json!({
                "botId": bot.id,
                "working": working.as_ref().map(|(what, _)| what.clone()),
                "workingSince": working.as_ref().map(|(_, since)| since.clone()),
                "nextCheck": duties.get(&bot.id),
            })
        })
        .collect();
    Ok(json!({"bots": listing, "needsYou": needs_you, "team": team}))
}

/// The soonest next run of each bot's duties that are on, by bot id.
fn next_checks() -> BTreeMap<String, String> {
    let mut next: BTreeMap<String, String> = BTreeMap::new();
    let Ok(automations) = crate::store::automations::list() else { return next };
    for automation in automations.iter().filter(|automation| automation.enabled && !automation.next_run_at.is_empty()) {
        let Some(owner) = super::duties::owner(automation) else { continue };
        let soonest = next.entry(owner.id).or_insert_with(|| automation.next_run_at.clone());
        if automation.next_run_at < *soonest {
            *soonest = automation.next_run_at.clone();
        }
    }
    next
}

/// A bot's home on the phone: its record, its list, its chats, its duties and its role.
fn home(manager: &SessionManager, id: &str) -> Result<Value> {
    let bot = super::get(id)?;
    let list = items::listing(&bot.id)?;
    let chats: Vec<Value> = chats_of(&bot.id).iter().take(CHATS).map(|entry| chat(manager, entry)).collect();
    let duties: Vec<Value> = super::duties::duties_of(&bot.id)?
        .iter()
        .map(|duty| {
            json!({
                "id": duty.id,
                "name": duty.name,
                "enabled": duty.enabled,
                "schedule": duty.schedule,
                "events": duty.event_trigger.is_some() || duty.issue_trigger.is_some(),
                "nextRunAt": duty.next_run_at,
                "lastRunAt": duty.last_run_at,
                "lastOutcome": duty.last_outcome,
            })
        })
        .collect();
    let role = match super::role_read(&bot.id) {
        Ok(text) => {
            let cut = text.len() > ROLE_BYTES;
            json!({"text": if cut { truncate(&text, ROLE_BYTES) } else { text }, "cut": cut})
        }
        Err(error) => json!({"unreadable": format!("{error:#}")}),
    };
    Ok(json!({"bot": bot, "items": list, "chats": chats, "duties": duties, "role": role}))
}

/// The bot's chats that are not archived, the home chat first and then the newest.
fn chats_of(id: &str) -> Vec<SessionEntry> {
    let mut chats: Vec<SessionEntry> = index::load()
        .unwrap_or_default()
        .into_iter()
        .filter(|entry| !entry.archived && super::chat::session_bot(entry).is_some_and(|reference| reference.id == id))
        .collect();
    chats.sort_by(|a, b| b.modified.cmp(&a.modified));
    // The newest home chat is the home chat (`chat::home_chat`).
    if let Some(at) = chats.iter().enumerate().filter(|(_, entry)| is_home(entry)).max_by(|a, b| a.1.created.cmp(&b.1.created)).map(|(at, _)| at) {
        let home = chats.remove(at);
        chats.insert(0, home);
    }
    chats
}

fn is_home(entry: &SessionEntry) -> bool {
    super::chat::session_bot(entry).is_some_and(|reference| reference.home)
}

fn chat(manager: &SessionManager, entry: &SessionEntry) -> Value {
    let tab = entry.active_tab.as_deref().and_then(|id| entry.tabs.iter().find(|tab| tab.id == id)).or(entry.tabs.first());
    json!({
        "sessionId": entry.id,
        "tabId": tab.map(|tab| tab.id.clone()),
        "title": entry.title,
        "modified": entry.modified,
        "home": is_home(entry),
        "duty": entry.automation.is_some(),
        "running": entry.tabs.iter().any(|tab| manager.is_running(&entry.id, &tab.id)),
    })
}

/// The bot's home chat as it is, never made or brought back here: a notice
/// opens the chat a question came from, and a read changes nothing.
pub fn home_chat_of(id: &str) -> Option<(String, String)> {
    let entry = chats_of(id).into_iter().next().filter(is_home)?;
    let tab = entry.active_tab.clone().or_else(|| entry.tabs.first().map(|tab| tab.id.clone()))?;
    Some((entry.id, tab))
}

fn truncate(text: &str, bytes: usize) -> String {
    let mut end = bytes.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_string()
}

#[cfg(test)]
#[path = "phone_tests.rs"]
mod tests;
