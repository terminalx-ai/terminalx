//! What a change to a bot does to its sessions that are running (PRO-468).
//! A launch is held to the bot's access as it starts (`chat::mode_limit`);
//! this holds the ones already running when the bot is paused, its access is
//! lowered, it is deleted, or Bots is switched off.

use crate::session::SessionManager;
use crate::sink::EventSink;
use crate::store::index::{self, SessionEntry, TabEntry, TabStatus};

use super::chat::{self, acting_bot, session_bot};

fn sessions(matching: impl Fn(&SessionEntry) -> bool) -> Vec<SessionEntry> {
    match index::load() {
        Ok(sessions) => sessions.into_iter().filter(|entry| matching(entry)).collect(),
        Err(error) => {
            log::warn!("read the sessions to hold bots' sessions to their bots: {error:#}");
            Vec::new()
        }
    }
}

/// Every session acting for `bot` (every bot when `None`), in a mode no
/// wider than its bot allows now. A tab narrowed here remembers the mode it
/// had ([`chat::HELD_FROM_KEY`]); when the limit widens again (a resume, more
/// access) it gets back as much of that as the limit allows, and an idle
/// agent is stopped so its next start is told the bot's rules as they are
/// now. A tab in the middle of a turn that is over the limit is stopped
/// first, and so is one the limit cannot be applied to: nothing is left
/// running wider than its bot allows. With Bots off, the bots' chats are
/// stopped instead (a session a bot started is left to its owner).
pub fn reconcile(manager: &SessionManager, bot: Option<&str>) {
    let on = super::enabled();
    let of_bot = |entry: &SessionEntry| acting_bot(entry).is_some_and(|id| bot.is_none_or(|bot| bot == id));
    for entry in sessions(of_bot) {
        if !on {
            if session_bot(&entry).is_some() {
                stop(manager, &entry);
            }
            continue;
        }
        for tab in &entry.tabs {
            if tab.is_terminal() {
                continue;
            }
            match chat::tab_limit(&entry, tab) {
                Some(limit) => hold(manager, &entry, tab, &limit),
                // The bot is gone: an ordinary session again, as it was.
                None => give_back(manager, &entry, tab, None),
            }
        }
    }
}

/// After a resume or a change to a bot: its idle running agents stop, so
/// each next start is told the bot's rules as they are now (no longer
/// paused, its new access). One in a turn finishes it first.
pub fn refresh(manager: &SessionManager, bot: Option<&str>) {
    for entry in sessions(|entry| acting_bot(entry).is_some_and(|id| bot.is_none_or(|bot| bot == id))) {
        for tab in entry.tabs.iter().filter(|tab| !tab.is_terminal() && tab.status == TabStatus::Idle) {
            if manager.is_running(&entry.id, &tab.id) {
                if let Err(error) = manager.stop(&entry.id, &tab.id) {
                    log::warn!("stop {}/{} to start it again with its bot's rules: {error:#}", entry.id, tab.id);
                }
            }
        }
    }
}

fn held_from(tab: &TabEntry) -> Option<String> {
    tab.unknown.get(chat::HELD_FROM_KEY).and_then(|mode| mode.as_str()).map(str::to_owned)
}

/// Bring one tab within `limit`, or give it back what an earlier limit took.
fn hold(manager: &SessionManager, entry: &SessionEntry, tab: &TabEntry, limit: &chat::ModeLimit) {
    let within = limit.allows(&tab.permission_mode) && tab.requested_permission_mode.as_deref().is_none_or(|mode| limit.allows(mode));
    if within {
        give_back(manager, entry, tab, Some(limit));
        return;
    }
    if matches!(tab.status, TabStatus::InProgress | TabStatus::Waiting) {
        if let Err(error) = manager.stop(&entry.id, &tab.id) {
            log::warn!("stop {}/{} to hold it to its bot: {error:#}", entry.id, tab.id);
        }
    }
    // What it had before any limit, kept once: a second narrowing does not forget it.
    let original = held_from(tab).unwrap_or_else(|| tab.permission_mode.clone());
    if manager.is_running(&entry.id, &tab.id) {
        if let Err(error) = manager.set_permission_mode(&entry.id, &tab.id, limit.mode) {
            // Never left running wider than the bot allows: stopped, and held when it starts again.
            log::warn!("hold {}/{} to {}: {error:#}; stopping it", entry.id, tab.id, limit.mode);
            if let Err(error) = manager.stop(&entry.id, &tab.id) {
                log::warn!("stop {}/{}: {error:#}", entry.id, tab.id);
            }
        }
    }
    write(entry, tab, |stored| {
        stored.permission_mode = limit.clamp(&stored.permission_mode);
        if let Some(mode) = stored.requested_permission_mode.as_mut() {
            *mode = limit.clamp(mode);
        }
        stored.unknown.insert(chat::HELD_FROM_KEY.into(), serde_json::Value::String(original.clone()));
    });
}

/// A tab an earlier limit narrowed gets back as much of its own mode as
/// `limit` allows now (all of it with no limit). Its idle agent is stopped,
/// so the next start is told the rules as they are now.
fn give_back(manager: &SessionManager, entry: &SessionEntry, tab: &TabEntry, limit: Option<&chat::ModeLimit>) {
    let Some(original) = held_from(tab) else { return };
    let mode = limit.map_or(original.clone(), |limit| limit.clamp(&original));
    let whole = mode == original;
    if mode != tab.permission_mode || whole {
        if manager.is_running(&entry.id, &tab.id) && tab.status == TabStatus::Idle {
            if let Err(error) = manager.stop(&entry.id, &tab.id) {
                log::warn!("stop {}/{} to start it again with its bot's rules: {error:#}", entry.id, tab.id);
            }
        }
        write(entry, tab, |stored| {
            stored.permission_mode = mode.clone();
            if whole {
                stored.unknown.remove(chat::HELD_FROM_KEY);
            }
        });
    }
}

fn write(entry: &SessionEntry, tab: &TabEntry, change: impl FnOnce(&mut TabEntry)) {
    if let Err(error) = index::update_tab(&entry.id, &tab.id, |stored| {
        change(stored);
        Ok(())
    }) {
        log::warn!("record {}/{}'s mode under its bot: {error:#}", entry.id, tab.id);
    }
}

fn stop(manager: &SessionManager, entry: &SessionEntry) {
    if entry.tabs.iter().any(|tab| manager.is_running(&entry.id, &tab.id)) {
        if let Err(error) = manager.stop_session_confirmed(entry) {
            log::warn!("stop bot chat {}: {error:#}", entry.id);
        }
    }
}

/// The chats of bot `id`.
fn chats(id: &str) -> Vec<SessionEntry> {
    sessions(|entry| session_bot(entry).is_some_and(|bot| bot.id == id))
}

/// Before bot `id` is deleted: its chats stop, so no agent is left working in
/// a home folder that goes to the trash.
pub fn before_delete(manager: &SessionManager, id: &str) {
    for entry in chats(id) {
        stop(manager, &entry);
    }
}

/// After bot `id` is deleted: its chats go to the archive, where they can
/// still be read. A session it started stays where it is, held to plan mode.
pub fn after_delete(sink: &dyn EventSink, id: &str) {
    let ids: Vec<String> = chats(id).into_iter().filter(|entry| !entry.archived).map(|entry| entry.id).collect();
    if ids.is_empty() {
        return;
    }
    if let Err(error) = crate::session_archive::set_archived(sink, &ids, true, crate::session_archive::By::Person) {
        log::warn!("archive the chats of deleted bot {id}: {error:#}");
    }
}

/// A bots operation of the runtime, with what it does to running sessions:
/// `reconcile` alone holds them again (Settings switching Bots off).
pub fn call(manager: &SessionManager, operation: &str, params: &serde_json::Value) -> anyhow::Result<serde_json::Value> {
    let sink = manager.sink();
    if operation == "reconcile" {
        reconcile(manager, None);
        return Ok(serde_json::Value::Null);
    }
    let deleting = (operation == "delete").then(|| params["id"].as_str().map(str::to_owned)).flatten();
    if let Some(id) = &deleting {
        if super::enabled() {
            before_delete(manager, id);
        }
    }
    let answer = super::call(sink.as_ref(), operation, params)?;
    if let Some(id) = &deleting {
        after_delete(sink.as_ref(), id);
    }
    // What changed reaches the sessions of the bot that changed (every bot for the switches over all).
    match operation {
        "pause" | "resume" | "update" | "delete" => reconcile(manager, params["id"].as_str()),
        "pauseAll" | "resumeAll" => reconcile(manager, None),
        _ => {}
    }
    match operation {
        "resume" | "update" => refresh(manager, params["id"].as_str()),
        "resumeAll" => refresh(manager, None),
        _ => {}
    }
    Ok(answer)
}

/// Whether a bots operation of the runtime gives a bot more than it has, so
/// only a person may send it (PRO-468): a resume, saying no to one asked for,
/// a hire, a delete, and a change that raises a bot's access or changes who
/// it reports to. A pause, less access and every read need no one.
pub fn needs_person(operation: &str, params: &serde_json::Value) -> bool {
    match operation {
        "resume" | "resumeAll" | "dismissResume" | "create" | "delete" => true,
        "update" => {
            let patch = &params["patch"];
            if patch.get("reportsTo").is_some_and(|value| !value.is_null()) {
                return true;
            }
            let Some(access) = patch.get("access").filter(|value| !value.is_null()) else { return false };
            // A level this build does not know may be wider than it can tell.
            let Ok(access) = serde_json::from_value::<super::BotAccess>(access.clone()) else { return true };
            if matches!(access, super::BotAccess::Other(_)) {
                return true;
            }
            let current = params["id"].as_str().and_then(|id| crate::store::bots::get(id).ok().flatten()).map(|bot| bot.access);
            // Unknown now: any level counts as a raise.
            current.is_none_or(|current| rank(&access) > rank(&current))
        }
        _ => false,
    }
}

fn rank(access: &super::BotAccess) -> u8 {
    match access.effective() {
        super::BotAccess::Full => 2,
        super::BotAccess::AskOutward => 1,
        super::BotAccess::ReadReport | super::BotAccess::Other(_) => 0,
    }
}

#[cfg(test)]
#[path = "enforce_tests.rs"]
mod tests;
