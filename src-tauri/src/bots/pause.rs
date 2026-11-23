//! What a pause stopped, and what it holds until the bot is resumed (PRO-474).
//!
//! A pause is recorded on the bot (`bots::pause_from`, with who paused it and
//! from where) and kept where each part already decides what a paused bot may
//! do. Nothing here adds such a rule:
//!
//! - its sessions are held to plan mode by `enforce::reconcile`, which stops a
//!   chat in a turn and lets a run's worker finish the step it is on;
//! - its due scheduled duties are skipped, not run late (`duties::may_wake`),
//!   and those that wake on events are not read, so what arrives waits;
//! - work handed or sent to it waits (`handoffs`), and so do the owner's
//!   answers, comments and work given on its items (`items::deliver`);
//! - no worker starts for a run it leads (`orchestration::engine`, through
//!   its host's `held_by_pause`).
//!
//! This module looks at what was running when the pause landed ([`look`]),
//! writes that on the pause once ([`note`]), reads back what the parts above
//! hold for the paused page, 23.12 ([`held`]), and, on a resume, lets go of
//! what only a resume releases ([`resumed`]).

use std::collections::BTreeMap;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::chat::acting_bot;
use super::items::ItemState;
use super::Bot;
use crate::session::SessionManager;
use crate::sink::EventSink;
use crate::store::index::{self, SessionEntry, TabEntry, TabStatus};

/// Paused in the window: a bot's Pause, its row's menu, or Pause all.
pub const FROM_APP: &str = "app";
/// Paused with the Pause all shortcut, from anywhere in the window.
pub const FROM_SHORTCUT: &str = "shortcut";
/// Paused from the phone.
pub const FROM_PHONE: &str = "phone";
/// Paused with `terminalx bots pause` or `pause-all`, by a person or a bot.
pub const FROM_CLI: &str = "cli";

/// Where a runtime call says it paused from. The runtime's callers are the
/// window and the phone; anything else is the window's.
pub fn from_param(params: &Value) -> &'static str {
    match params["from"].as_str() {
        Some(FROM_SHORTCUT) => FROM_SHORTCUT,
        Some(FROM_PHONE) => FROM_PHONE,
        _ => FROM_APP,
    }
}

fn is_zero(value: &u32) -> bool {
    *value == 0
}

/// What a pause stopped, as it was when the bot was paused.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stopped {
    /// What it was doing, as the page says it after "Paused · ": "was working on “…”", "was quiet".
    #[serde(default)]
    pub was: String,
    /// Its chats, and sessions it started, that were in a turn: stopped there.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub chats: u32,
    /// Its runs' workers that were in a turn: each finishes the step it is on, then stops.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub workers: u32,
    /// Its duty runs that were going: stopped, and ended with their run.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub duties: u32,
    /// What it had spent today when it was paused, so the page can say what it spent since.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spent: Option<Spent>,
    /// What a newer build records here survives a save by this one.
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Spent {
    /// The day it counts, as `stats::today` names it.
    pub day: String,
    pub usd: f64,
}

/// In a turn, as far as the index says: what a pause stops, or lets finish.
pub(super) fn in_turn(tab: &TabEntry) -> bool {
    matches!(tab.status, TabStatus::InProgress | TabStatus::Waiting)
}

/// A tab of `entry` that is a run's worker: its turn is a step, which it finishes before it stops.
pub(super) fn finishes_its_step(entry: &SessionEntry) -> bool {
    entry.run_worker()
}

fn is_duty_run(entry: &SessionEntry) -> bool {
    entry.unknown.contains_key(super::duties::SESSION_KEY)
}

fn quoted(text: &str) -> String {
    let line: String = text.chars().map(|ch| if ch.is_control() { ' ' } else { ch }).collect();
    let line = line.trim();
    let cut: String = line.chars().take(80).collect();
    if cut.chars().count() < line.chars().count() {
        format!("“{}…”", cut.trim_end())
    } else {
        format!("“{cut}”")
    }
}

/// The turns bot `bot` is in, by what runs them, with the first duty run and the first chat in one.
struct Turns<'a> {
    chats: u32,
    workers: u32,
    duties: u32,
    duty: Option<&'a SessionEntry>,
    chat: Option<&'a SessionEntry>,
    /// The first worker's session, for when its turn began as far as the index says.
    worker: Option<&'a SessionEntry>,
}

impl Turns<'_> {
    fn busy(&self) -> bool {
        self.chats + self.workers + self.duties > 0
    }
}

/// The sessions acting for `bot` that are in a turn now: its chats, its duty runs, and its runs' workers.
fn turns<'a>(manager: &SessionManager, bot: &Bot, sessions: &'a [SessionEntry]) -> Turns<'a> {
    let mut turns = Turns { chats: 0, workers: 0, duties: 0, duty: None, chat: None, worker: None };
    for entry in sessions.iter().filter(|entry| !entry.archived && acting_bot(entry).as_deref() == Some(bot.id.as_str())) {
        for _tab in entry.tabs.iter().filter(|tab| !tab.is_terminal() && in_turn(tab) && manager.is_running(&entry.id, &tab.id)) {
            if finishes_its_step(entry) {
                turns.workers += 1;
                turns.worker.get_or_insert(entry);
            } else if is_duty_run(entry) {
                turns.duties += 1;
                turns.duty.get_or_insert(entry);
            } else {
                turns.chats += 1;
                turns.chat.get_or_insert(entry);
            }
        }
    }
    turns
}

/// What bot `bot` is doing now, in the sessions `sessions` and on its list `items`.
fn now_doing(manager: &SessionManager, bot: &Bot, sessions: &[SessionEntry], items: Option<&super::items::List>) -> Stopped {
    let turns = turns(manager, bot, sessions);
    let mut stopped = Stopped { chats: turns.chats, workers: turns.workers, duties: turns.duties, ..Stopped::default() };
    let open = |state: ItemState| items.into_iter().flat_map(|list| list.items.iter()).filter(move |item| item.state == state).max_by(|a, b| a.modified.cmp(&b.modified));
    stopped.was = match (turns.busy(), open(ItemState::InProgress), turns.duty, turns.chat) {
        (true, Some(item), _, _) => format!("was working on {}", quoted(&item.title)),
        (true, None, Some(duty), _) => format!("was running its duty {}", quoted(&duty.title)),
        (true, None, None, _) if stopped.workers > 0 => format!("was running {}", count(stopped.workers, "worker", "workers")),
        (true, None, None, Some(chat)) => format!("was answering in {}", quoted(&chat.title)),
        _ if open(ItemState::NeedsYou).is_some_and(|item| item.question.is_some()) => "was waiting for your answer".into(),
        _ => "was quiet".into(),
    };
    stopped
}

/// What the sessions of bot `bot` that are in a turn are on, and since when
/// (the session's last change, as the index has it): its duty, its workers,
/// or the chat it answers in, in the order a pause names them. `None` when
/// nothing of the bot's is in a turn (PRO-515).
pub(super) fn running_now(manager: &SessionManager, bot: &Bot, sessions: &[SessionEntry]) -> Option<(String, String)> {
    let turns = turns(manager, bot, sessions);
    if let Some(duty) = turns.duty {
        return Some((format!("Running its duty {}", quoted(&duty.title)), duty.modified.clone()));
    }
    if let Some(worker) = turns.worker {
        return Some((format!("Running {}", count(turns.workers, "worker", "workers")), worker.modified.clone()));
    }
    turns.chat.map(|chat| (format!("Answering in {}", quoted(&chat.title)), chat.modified.clone()))
}

fn count(n: u32, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// What each bot about to be paused is doing now: `bot`, or every bot when
/// `None`, leaving out those already paused (their pause, and what it
/// stopped, stand). Read before the pause is enforced, which stops it.
pub fn look(manager: &SessionManager, bot: Option<&str>) -> BTreeMap<String, Stopped> {
    let bots = match crate::store::bots::list() {
        Ok(bots) => bots,
        Err(error) => {
            log::warn!("read the bots to say what a pause stops: {error:#}");
            return BTreeMap::new();
        }
    };
    let sessions = index::load().unwrap_or_else(|error| {
        log::warn!("read the sessions to say what a pause stops: {error:#}");
        Vec::new()
    });
    bots.iter()
        .filter(|candidate| candidate.paused.is_none() && bot.is_none_or(|id| id == candidate.id))
        .map(|candidate| {
            let items = super::items::read(&candidate.id).ok();
            (candidate.id.clone(), now_doing(manager, candidate, &sessions, items.as_ref()))
        })
        .collect()
}

/// Write what the pause stopped (`looked`, read before it was enforced) on
/// each bot's pause that says nothing yet, with what it had spent today.
pub fn note(sink: &dyn EventSink, looked: BTreeMap<String, Stopped>) {
    if looked.is_empty() {
        return;
    }
    let day = crate::stats::today();
    let mut looked: BTreeMap<String, Stopped> = looked
        .into_iter()
        .map(|(id, mut stopped)| {
            stopped.spent = super::spent_today(&id).ok().map(|usd| Spent { day: day.clone(), usd });
            (id, stopped)
        })
        .collect();
    let written = super::change_listed(sink, |bots| {
        for bot in bots.iter_mut() {
            let Some(stopped) = looked.remove(&bot.id) else { continue };
            if let Some(pause) = bot.paused.as_mut().filter(|pause| pause.stopped.is_none()) {
                pause.stopped = Some(stopped);
            }
        }
        Ok(())
    });
    if let Err(error) = written {
        log::warn!("record what a pause stopped: {error:#}");
    }
}

/// When `at` (an RFC 3339 time) is, if it can be read.
fn instant(at: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(at).ok().map(|at| at.with_timezone(&Utc))
}

/// Whether `at` is at or after `since`; an unreadable time counts as after, so nothing held is left out.
fn since(at: &str, since: Option<DateTime<Utc>>) -> bool {
    match (instant(at), since) {
        (Some(at), Some(since)) => at >= since,
        _ => true,
    }
}

/// What the paused page shows (23.12): for each paused bot what it was doing
/// and what of its work is in a turn still, and every entry of "Held while
/// paused": a scheduled duty run skipped, a duty whose events wait, work and
/// messages handed or sent to it, and the owner's answers waiting on its
/// items. Each part is read where it is kept; one that cannot be read is
/// said to be (`errors`), never shown as nothing held. Only the paused bots'
/// questions are counted (`needsYou`); the others' are the Needs you queue's.
pub fn held(manager: &SessionManager) -> Result<Value> {
    super::require_enabled()?;
    let bots = super::listing()?.bots;
    let paused: Vec<&Bot> = bots.iter().filter(|bot| bot.paused.is_some()).collect();
    let mut errors: Vec<String> = Vec::new();
    let sessions = index::load().unwrap_or_else(|error| {
        errors.push(format!("The sessions could not be read: {error:#}"));
        Vec::new()
    });
    let pause_of = |id: &str| paused.iter().find(|bot| bot.id == id).and_then(|bot| bot.paused.as_ref());
    let since_pause = |id: &str| pause_of(id).and_then(|pause| instant(&pause.at));

    let mut entries: Vec<Value> = Vec::new();

    // Duties: a scheduled run that fell due while paused was skipped; one that wakes on events waits.
    match crate::store::automations::list() {
        Ok(automations) => {
            for automation in automations.iter().filter(|automation| super::duties::is_duty(automation)) {
                let Some(owner) = super::duties::owner(automation) else { continue };
                let Some(pause) = pause_of(&owner.id) else { continue };
                let wakes_on_events = automation.event_trigger.is_some() || automation.issue_trigger.is_some();
                if wakes_on_events {
                    if automation.enabled {
                        entries.push(json!({"kind": "kept", "source": "events", "botId": owner.id, "dutyId": automation.id, "name": automation.name, "at": pause.at}));
                    }
                    continue;
                }
                let runs = match crate::store::automations::list_runs(&automation.id) {
                    Ok(runs) => runs,
                    Err(error) => {
                        errors.push(format!("The runs of duty {} could not be read: {error:#}", automation.name));
                        continue;
                    }
                };
                let paused_at = since_pause(&owner.id);
                for run in runs.iter().filter(|run| run.session_id.is_none() && run.error.as_deref() == Some(super::duties::PAUSED_SKIP)) {
                    let first = run.scheduled_for.clone().or_else(|| run.ended_at.clone()).unwrap_or_default();
                    let last = run.last_repeat_at.clone().unwrap_or_else(|| first.clone());
                    if !since(&last, paused_at) {
                        continue;
                    }
                    // A row folded across an earlier pause counts this pause's newest skip alone.
                    let count = if since(&first, paused_at) { run.repeat_count.max(1) } else { 1 };
                    entries.push(json!({"kind": "skipped", "source": "duty", "botId": owner.id, "dutyId": automation.id, "name": automation.name, "at": last, "count": count}));
                }
            }
        }
        Err(error) => errors.push(format!("The duties could not be read: {error:#}")),
    }

    // Hand-offs and messages waiting for a paused bot (PRO-475): they start, and are sent, on resume.
    match super::handoffs::read() {
        Ok(store) => {
            for handoff in store.handoffs.iter().filter(|handoff| handoff.state == super::handoffs::HandoffState::Waiting && pause_of(&handoff.to).is_some()) {
                entries.push(json!({"kind": "kept", "source": "handoff", "botId": handoff.to, "fromId": handoff.from, "by": handoff.by, "number": handoff.number, "title": handoff.title, "at": handoff.created}));
            }
            for message in store.messages.iter().filter(|message| message.pending && message.kind != "handoff" && pause_of(&message.to).is_some()) {
                entries.push(json!({"kind": "kept", "source": "message", "botId": message.to, "fromId": message.from, "messageKind": message.kind, "handoff": message.handoff, "at": message.at}));
            }
        }
        Err(error) => errors.push(format!("The hand-offs could not be read: {error:#}")),
    }

    // The owner's answers, comments and work on a paused bot's items: kept, and sent on resume.
    let mut asking: BTreeMap<String, usize> = BTreeMap::new();
    for bot in &paused {
        match super::items::read(&bot.id) {
            Ok(list) => {
                for item in &list.items {
                    if item.state == ItemState::NeedsYou && item.question.is_some() {
                        *asking.entry(bot.id.clone()).or_default() += 1;
                    }
                    for message in &item.undelivered {
                        entries.push(json!({"kind": "kept", "source": "answer", "botId": bot.id, "number": item.number, "messageKind": message.kind, "at": message.at}));
                    }
                }
            }
            Err(error) => errors.push(format!("{}'s work items could not be read: {error:#}", bot.name)),
        }
    }

    entries.sort_by(|a, b| a["at"].as_str().unwrap_or_default().cmp(b["at"].as_str().unwrap_or_default()));

    // Each bot's run workers in a turn still (a paused bot's, finishing their step), and its questions open.
    // Spend is read apart (`spentToday`, per bot): it reads every transcript, and this is read whenever a pause
    // changes what it holds.
    let per_bot: Vec<Value> = bots
        .iter()
        .map(|bot| {
            let finishing: usize = sessions
                .iter()
                // Only a run's workers finish a step: a chat in a turn while paused is the bot answering its owner.
                .filter(|entry| !entry.archived && finishes_its_step(entry) && acting_bot(entry).as_deref() == Some(bot.id.as_str()))
                .flat_map(|entry| entry.tabs.iter().filter(|tab| !tab.is_terminal() && in_turn(tab) && manager.is_running(&entry.id, &tab.id)))
                .count();
            json!({"id": bot.id, "inTurn": finishing, "needsYou": asking.get(&bot.id).copied().unwrap_or(0)})
        })
        .collect();

    Ok(json!({"bots": per_bot, "entries": entries, "errors": errors}))
}

/// After bot `bot` (every bot when `None`) is resumed: what only a resume
/// releases goes. The owner's messages kept on its items are sent, and the
/// runs it leads start the workers they held. Its hand-offs are started by
/// `handoffs::resumed`, its duties wake at their next time and its events
/// are read at the next poll.
pub fn resumed(manager: &SessionManager, bot: Option<&str>) {
    let bots = match crate::store::bots::list() {
        Ok(bots) => bots,
        Err(error) => return log::warn!("read the bots after a resume: {error:#}"),
    };
    let resumed: Vec<String> = bots.into_iter().filter(|candidate| candidate.paused.is_none() && bot.is_none_or(|id| id == candidate.id)).map(|candidate| candidate.id).collect();
    for id in &resumed {
        super::items::deliver_waiting(manager, id);
    }
    if !resumed.is_empty() {
        let host = crate::orchestration::host::ManagerHost::new(manager.sink().clone(), manager.clone());
        crate::orchestration::engine::bot_resumed(&host, &|run| {
            index::get(&run.lead.session_id).ok().and_then(|lead| acting_bot(&lead)).is_some_and(|id| resumed.contains(&id))
        });
    }
}

/// Whether the run's lead works for a paused bot, and the bot's name: no
/// worker starts for it until the bot is resumed. Nothing with Bots off.
pub fn holds_run(lead_session: &str) -> Option<String> {
    if !super::enabled() {
        return None;
    }
    let lead = index::get(lead_session).ok()?;
    let id = acting_bot(&lead)?;
    match crate::store::bots::get(&id) {
        Ok(Some(bot)) => bot.paused.is_some().then_some(bot.name),
        Ok(None) => None,
        // Not known: held, as a bot that cannot be read is held everywhere.
        Err(_) => Some("Its bot".into()),
    }
}

#[cfg(test)]
#[path = "pause_tests.rs"]
mod tests;
