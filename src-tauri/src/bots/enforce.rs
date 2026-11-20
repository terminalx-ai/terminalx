//! What a change to a bot does to its sessions that are running (PRO-468).
//! A launch is held to the bot's access as it starts (`chat::mode_limit`);
//! this holds the ones already running when the bot is paused, its access is
//! lowered, it is deleted, or Bots is switched off.

use crate::session::SessionManager;
use crate::sink::EventSink;
use crate::store::index::{self, SessionEntry, TabStatus};

use super::chat::{acting_bot, mode_limit, session_bot};

fn sessions(matching: impl Fn(&SessionEntry) -> bool) -> Vec<SessionEntry> {
    match index::load() {
        Ok(sessions) => sessions.into_iter().filter(|entry| matching(entry)).collect(),
        Err(error) => {
            log::warn!("read the sessions to hold bots' sessions to their bots: {error:#}");
            Vec::new()
        }
    }
}

/// Every session acting for a bot, in a mode no wider than its bot allows
/// now. A tab in the middle of a turn is stopped first: what it is doing it
/// is doing with more than the bot has. With Bots off, the bots' chats are
/// stopped instead (a session a bot started is left to its owner).
pub fn reconcile(manager: &SessionManager) {
    let on = super::enabled();
    for entry in sessions(|entry| acting_bot(entry).is_some()) {
        if !on {
            if session_bot(&entry).is_some() {
                stop(manager, &entry);
            }
            continue;
        }
        let Some(limit) = mode_limit(&entry) else { continue };
        for tab in &entry.tabs {
            let within = limit.allows(&tab.permission_mode) && tab.requested_permission_mode.as_deref().is_none_or(|mode| limit.allows(mode));
            if within || tab.is_terminal() {
                continue;
            }
            if matches!(tab.status, TabStatus::InProgress | TabStatus::Waiting) {
                if let Err(error) = manager.stop(&entry.id, &tab.id) {
                    log::warn!("stop {}/{} to hold it to its bot: {error:#}", entry.id, tab.id);
                }
            }
            if manager.is_running(&entry.id, &tab.id) {
                if let Err(error) = manager.set_permission_mode(&entry.id, &tab.id, limit.mode) {
                    log::warn!("hold {}/{} to {}: {error:#}", entry.id, tab.id, limit.mode);
                }
            } else if let Err(error) = index::update_tab(&entry.id, &tab.id, |tab| {
                tab.permission_mode = limit.clamp(&tab.permission_mode);
                if let Some(mode) = tab.requested_permission_mode.as_mut() {
                    *mode = limit.clamp(mode);
                }
                Ok(())
            }) {
                log::warn!("hold {}/{} to {}: {error:#}", entry.id, tab.id, limit.mode);
            }
        }
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
        reconcile(manager);
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
    if matches!(operation, "pause" | "pauseAll" | "update" | "delete") {
        reconcile(manager);
    }
    Ok(answer)
}

#[cfg(test)]
#[path = "enforce_tests.rs"]
mod tests;
