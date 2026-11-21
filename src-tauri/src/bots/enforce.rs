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
/// had ([`chat::HELD_FROM_KEY`]) until someone sets its mode by hand; when the
/// limit widens again (a resume, more access) it gets back as much of that as
/// the limit allows. A tab in the middle of a turn that is over the limit is
/// stopped first, and so is one the limit cannot be applied to: nothing is
/// left running wider than its bot allows. With Bots off, the bots' chats are
/// stopped instead (a session a bot started is left to its owner). A session
/// whose bot is gone keeps the mode it was held to.
pub fn reconcile(manager: &SessionManager, bot: Option<&str>) {
    let on = super::enabled();
    for entry in sessions(|entry| acting_bot(entry).is_some_and(|id| bot.is_none_or(|bot| bot == id))) {
        if !on {
            if session_bot(&entry).is_some() {
                stop(manager, &entry);
            }
            continue;
        }
        for tab in entry.tabs.iter().filter(|tab| !tab.is_terminal()) {
            match chat::tab_limit(&entry, tab) {
                Some(limit) => hold(manager, &entry, tab, &limit),
                // Its bot is gone: nothing more is given back.
                None if held_from(tab).is_some() => write(manager, &entry, tab, |stored| {
                    stored.unknown.remove(chat::HELD_FROM_KEY);
                }),
                None => {}
            }
        }
    }
}

/// In a turn, as far as the index says: everything else counts as idle.
fn in_turn(tab: &TabEntry) -> bool {
    matches!(tab.status, TabStatus::InProgress | TabStatus::Waiting)
}

/// After a resume, or a change to a bot's access or rules: its running agents
/// that are not in a turn stop, so each next start is told the bot's rules as
/// they are now. One in a turn keeps going.
pub fn refresh(manager: &SessionManager, bot: Option<&str>) {
    for entry in sessions(|entry| acting_bot(entry).is_some_and(|id| bot.is_none_or(|bot| bot == id))) {
        for tab in entry.tabs.iter().filter(|tab| !tab.is_terminal() && !in_turn(tab)) {
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
        give_back(manager, entry, tab, limit);
        return;
    }
    if in_turn(tab) {
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
    write(manager, entry, tab, |stored| {
        stored.permission_mode = limit.clamp(&stored.permission_mode);
        if let Some(mode) = stored.requested_permission_mode.as_mut() {
            *mode = limit.clamp(mode);
        }
        stored.unknown.insert(chat::HELD_FROM_KEY.into(), serde_json::Value::String(original.clone()));
    });
}

/// A tab an earlier limit narrowed gets back as much of its own mode as
/// `limit` allows now. An agent not in a turn is stopped, so its next start
/// has the mode and the bot's rules as they are now; one in a turn is asked
/// for the mode, which it takes when the turn ends. The mode it had is
/// remembered only while it has less of it: once all of it is given or asked
/// for, it is forgotten, so a later reconcile (a rename) neither stops the
/// agent again nor lifts a mode the owner narrowed since.
fn give_back(manager: &SessionManager, entry: &SessionEntry, tab: &TabEntry, limit: &chat::ModeLimit) {
    let Some(original) = held_from(tab) else { return };
    let mode = limit.clamp(&original).to_owned();
    let all = mode == original;
    // Already has it, or has asked for it: nothing to give, nothing to stop.
    let has = match tab.requested_permission_mode.as_deref() {
        Some(pending) => pending == mode,
        None => tab.permission_mode == mode,
    };
    if has {
        if all {
            write(manager, entry, tab, |stored| {
                stored.unknown.remove(chat::HELD_FROM_KEY);
            });
        }
        return;
    }
    let busy = in_turn(tab) && manager.is_running(&entry.id, &tab.id);
    if busy {
        if let Err(error) = manager.set_permission_mode(&entry.id, &tab.id, &mode) {
            log::warn!("give {}/{} back {mode} after its turn: {error:#}", entry.id, tab.id);
        }
    } else if manager.is_running(&entry.id, &tab.id) {
        if let Err(error) = manager.stop(&entry.id, &tab.id) {
            log::warn!("stop {}/{} to start it again with its bot's rules: {error:#}", entry.id, tab.id);
        }
    }
    write(manager, entry, tab, |stored| {
        if busy {
            stored.requested_permission_mode = Some(mode.clone());
        } else {
            stored.permission_mode = mode.clone();
        }
        if all {
            stored.unknown.remove(chat::HELD_FROM_KEY);
        } else {
            stored.unknown.insert(chat::HELD_FROM_KEY.into(), serde_json::Value::String(original.clone()));
        }
    });
}

/// Change one tab's stored entry, and say so to the window, whose pickers read it.
fn write(manager: &SessionManager, entry: &SessionEntry, tab: &TabEntry, change: impl FnOnce(&mut TabEntry)) {
    if let Err(error) = index::update_tab(&entry.id, &tab.id, |stored| {
        change(stored);
        Ok(())
    }) {
        log::warn!("record {}/{}'s mode under its bot: {error:#}", entry.id, tab.id);
        return;
    }
    if let Ok(updated) = index::get(&entry.id) {
        manager.sink().emit("session_updated", &updated);
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

/// Before bot `id` is deleted: every session that works for it stops, its
/// chats and the sessions it started, so no agent is left working in a home
/// folder that goes to the trash, nor runs on as an ordinary session with the
/// rules and mode it had as the bot's. Each keeps the mode it was held to.
pub fn before_delete(manager: &SessionManager, id: &str) {
    for entry in sessions(|entry| acting_bot(entry).as_deref() == Some(id)) {
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
    let access_before = (operation == "update").then(|| after_access(params)).flatten().and(params["id"].as_str().and_then(|id| crate::store::bots::get(id).ok().flatten()).map(|bot| bot.access));
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
    // Its agents start again only when what they are told changed: its access, a resume, its role
    // (written, put back, or a change to it undone, PRO-470).
    match operation {
        "resume" | "roleWrite" | "roleRestore" => refresh(manager, params["id"].as_str()),
        "memoryUndo" if params["id"].as_str().zip(answer["id"].as_str()).is_some_and(|(bot, change)| undid_role(bot, change)) => refresh(manager, params["id"].as_str()),
        "update" if access_before != after_access(params) => refresh(manager, params["id"].as_str()),
        "resumeAll" => refresh(manager, None),
        _ => {}
    }
    Ok(answer)
}

/// Whether undo `change` of `bot` changed its role.
fn undid_role(bot: &str, change: &str) -> bool {
    match super::changes::read_log(bot) {
        Ok(log) => log.changes.iter().any(|recorded| recorded.id == change && recorded.states.contains_key(crate::store::bots::ROLE_FILE)),
        Err(error) => {
            log::warn!("read bot {bot}'s history after an undo: {error:#}");
            // Unknown: start its agents again, as a role change would.
            true
        }
    }
}

/// The access an update sets, when it sets one.
fn after_access(params: &serde_json::Value) -> Option<super::BotAccess> {
    params["patch"].get("access").filter(|access| !access.is_null()).and_then(|access| serde_json::from_value(access.clone()).ok())
}

/// Whether a bots operation of the runtime gives a bot more than it has, so
/// only a person may send it (PRO-468): a resume, saying no to one asked for,
/// a hire, a delete, a change that raises a bot's access, changes who it
/// reports to or turns its memory back on, and the owner's writes to its
/// role and memory (PRO-470: what a bot is told comes from a person). A
/// pause, less access and every read need no one. `memoryView` and
/// `memoryLook` record edits found outside the app, so they are not reads
/// either, but they give nothing.
pub fn needs_person(operation: &str, params: &serde_json::Value) -> bool {
    match operation {
        "resume" | "resumeAll" | "dismissResume" | "create" | "delete" => true,
        "roleWrite" | "roleRestore" | "memoryUndo" | "memoryAdd" | "memoryForget" => true,
        "update" => {
            let patch = &params["patch"];
            if patch.get("memoryOff").and_then(serde_json::Value::as_bool) == Some(false) {
                return true;
            }
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
            // Unknown now: any level counts as a raise. Judged again under the store's lock (`bots::update_as`).
            current.is_none_or(|current| super::access_rank(&access) > super::access_rank(&current))
        }
        _ => false,
    }
}

#[cfg(test)]
#[path = "enforce_tests.rs"]
mod tests;
