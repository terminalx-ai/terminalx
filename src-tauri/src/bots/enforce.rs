//! What a change to a bot does to its sessions that are running (PRO-468).
//! A launch is held to the bot's access as it starts (`chat::mode_limit`);
//! this holds the ones already running when the bot is paused, its access is
//! lowered, it is deleted, or Bots is switched off.

use crate::session::SessionManager;
use crate::sink::EventSink;
use crate::store::index::{self, SessionEntry, TabEntry};

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
    super::pause::in_turn(tab)
}

/// Pause bot `id`, or every bot (Pause all) when `None`, as `by` from `from`
/// (PRO-474): what each was doing is read first, the pause is recorded, its
/// sessions are held to it ([`reconcile`]), and what it stopped is written on
/// the pause. A bot already paused keeps its pause as it was. Answers with
/// the bot (or every bot) as it is now.
pub fn pause(manager: &SessionManager, id: Option<&str>, by: &str, from: &str) -> anyhow::Result<serde_json::Value> {
    let sink = manager.sink();
    let looked = super::pause::look(manager, id);
    match id {
        Some(id) => {
            super::pause_from(sink.as_ref(), id, by, from)?;
        }
        None => {
            super::pause_all_from(sink.as_ref(), by, from)?;
        }
    }
    reconcile(manager, id);
    // Its agents that are not in a turn start again at their next message, told they are paused: their answer says so.
    refresh(manager, id);
    super::pause::note(sink.as_ref(), looked);
    Ok(match id {
        Some(id) => serde_json::to_value(super::get(id)?)?,
        None => serde_json::to_value(super::listing()?)?,
    })
}

/// Whether `entry` acts for a bot that is paused now: its run's workers finish the step they are on.
fn paused_bot(entry: &SessionEntry) -> bool {
    acting_bot(entry).is_some_and(|id| matches!(crate::store::bots::get(&id), Ok(Some(bot)) if bot.paused.is_some()))
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
    // A paused bot's run worker in a turn finishes the step it is on (PRO-474): it is asked for the mode, which it
    // takes when the turn ends, and its run starts no worker after it. Anything else in a turn stops now.
    let finishing = in_turn(tab) && super::pause::finishes_its_step(entry) && manager.is_running(&entry.id, &tab.id) && paused_bot(entry);
    if in_turn(tab) && !finishing {
        if let Err(error) = manager.stop(&entry.id, &tab.id) {
            log::warn!("stop {}/{} to hold it to its bot: {error:#}", entry.id, tab.id);
        }
    }
    // What it had before any limit, kept once: a second narrowing does not forget it.
    let original = held_from(tab).unwrap_or_else(|| tab.permission_mode.clone());
    let mut asked = false;
    if manager.is_running(&entry.id, &tab.id) {
        match manager.set_permission_mode(&entry.id, &tab.id, limit.mode) {
            Ok(_) => asked = finishing,
            Err(error) => {
                // Never left running wider than the bot allows: stopped, and held when it starts again.
                log::warn!("hold {}/{} to {}: {error:#}; stopping it", entry.id, tab.id, limit.mode);
                if let Err(error) = manager.stop(&entry.id, &tab.id) {
                    log::warn!("stop {}/{}: {error:#}", entry.id, tab.id);
                }
            }
        }
    }
    write(manager, entry, tab, |stored| {
        if asked {
            // Its turn goes on in the mode it has; the limit's mode is what it takes when the turn ends.
            stored.requested_permission_mode = Some(limit.mode.to_owned());
        } else {
            stored.permission_mode = limit.clamp(&stored.permission_mode);
            if let Some(mode) = stored.requested_permission_mode.as_mut() {
                *mode = limit.clamp(mode);
            }
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
    // Other bots' work on what it handed them stops too (PRO-475).
    super::handoffs::before_delete(manager, id);
}

/// After bot `id` is deleted: its chats go to the archive, where they can
/// still be read. A session it started stays where it is, held to plan mode.
pub fn after_delete(sink: &dyn EventSink, id: &str) {
    // Its work list goes to the trash with its home (PRO-469).
    if let Err(error) = super::items::trash(id) {
        log::warn!("move the work items of deleted bot {id} to the trash: {error:#}");
    }
    // Its suggestions too (PRO-477).
    if let Err(error) = super::suggestions::trash(id) {
        log::warn!("move the suggestions of deleted bot {id} to the trash: {error:#}");
    }
    // Its hand-offs and messages leave with it (PRO-475).
    if let Err(error) = super::handoffs::forget_bot(sink, id) {
        log::warn!("move the hand-offs of deleted bot {id} to the trash: {error:#}");
    }
    // Its mentions and posts on GitHub and Linear (PRO-480).
    if let Err(error) = super::channels::forget_bot(id) {
        log::warn!("forget the channel mentions of deleted bot {id}: {error:#}");
    }
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
    // A bot's duties (PRO-471) change no running session.
    if let Some(answer) = super::duties::call(manager, operation, params) {
        return answer;
    }
    let sink = manager.sink();
    // A bot's work items and what needs the owner (PRO-469).
    if let Some(answer) = super::items::runtime_call(manager, operation, params) {
        return answer;
    }
    // Hand-offs, and the team brief (PRO-475).
    if let Some(answer) = super::handoffs::runtime_call(manager, operation, params) {
        return answer;
    }
    // Suggestions, and the look around's status (PRO-477).
    if let Some(answer) = super::suggestions::runtime_call(manager, operation, params) {
        return answer;
    }
    // What reached it from GitHub and Linear, and what it posted there (PRO-480).
    if let Some(answer) = super::channels::runtime_call(operation, params) {
        return answer;
    }
    if operation == "reconcile" {
        reconcile(manager, None);
        return Ok(serde_json::Value::Null);
    }
    // Pause and Pause all say what they stopped (PRO-474); the paused page reads what they hold.
    match operation {
        "pause" => return pause(manager, Some(params["id"].as_str().ok_or_else(|| super::refused("id must be a string"))?), super::OWNER, super::pause::from_param(params)),
        "pauseAll" => return pause(manager, None, super::OWNER, super::pause::from_param(params)),
        "pauseHeld" => return super::pause::held(manager),
        _ => {}
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
        super::handoffs::deliver_waiting_all(manager);
    }
    // What changed reaches the sessions of the bot that changed (every bot for the switches over all).
    match operation {
        "resume" | "update" | "delete" => reconcile(manager, params["id"].as_str()),
        "resumeAll" => reconcile(manager, None),
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
    // Work handed to it while it was paused starts now, and what waited for it is sent (PRO-475).
    match operation {
        "resume" => super::handoffs::resumed_later(manager, params["id"].as_str()),
        "resumeAll" => super::handoffs::resumed_later(manager, None),
        _ => {}
    }
    // The owner's answers kept on its items are sent, and its runs start the workers they held (PRO-474).
    match operation {
        "resume" => super::pause::resumed(manager, params["id"].as_str()),
        "resumeAll" => super::pause::resumed(manager, None),
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
/// a hire, a delete, an update that gives more (`bots::gives_more`: more
/// access, another reporting line, a new place to work, a new, wider or
/// changed entry in Who can ask, another agent or model, a rename, another
/// place to run, memory turned back on), and the owner's writes to its role
/// and memory (PRO-470: what a bot is told comes from a person). A pause,
/// taking any of those away, and every read need no one. `memoryView` and
/// `memoryLook` record edits found outside the app, so they are not reads
/// either, but they give nothing.
pub fn needs_person(operation: &str, params: &serde_json::Value) -> bool {
    match operation {
        "resume" | "resumeAll" | "dismissResume" | "create" | "delete" => true,
        "roleWrite" | "roleRestore" | "memoryUndo" | "memoryAdd" | "memoryForget" => true,
        // PRO-475: handing an item on makes a bot work; the team brief is what every bot is told.
        "itemHand" | "briefWrite" => true,
        // PRO-477: Start makes a bot work, as the owner's message.
        "suggestionStart" => true,
        // PRO-476: an answer that approves a run's plan starts its workers, or lets it merge.
        "itemAnswer" => super::runs::answer_starts_run(params),
        "dutySave" | "dutySwitch" | "dutyDelete" | "dutyDuplicate" | "dutyRun" | "dutyTryCheck" | "quietHours" => super::duties::needs_person(operation, params),
        "update" => {
            // A patch this build cannot read may give more than it can tell.
            let Ok(patch) = serde_json::from_value::<super::BotPatch>(params["patch"].clone()) else { return true };
            let current = params["id"].as_str().and_then(|id| crate::store::bots::get(id).ok().flatten());
            // Unknown now: anything it sets counts. Judged again under the store's lock (`bots::update_as`).
            current.is_none_or(|bot| super::gives_more(&bot, &patch))
        }
        _ => false,
    }
}

#[cfg(test)]
#[path = "enforce_tests.rs"]
mod tests;
