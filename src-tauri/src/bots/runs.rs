//! A bot leads orchestration runs (PRO-476). A lead bot coordinates and its
//! workers build: large work becomes an orchestration run that its owner
//! approves from the bot's chat.
//!
//! Nothing here is a second engine. The run is made with the existing
//! `terminalx runs create` from a session that works for the bot (the lead is
//! always the caller's own session, `control::Caller::gate`), and it runs as
//! every run does (`orchestration`). Its workers are sessions its lead
//! started, so they act for the bot (`chat::inherit`, `botStarted`) and are
//! held to its access and its pause the way everything a bot starts is.
//!
//! What is the bot's: an item of its work list links the run, and
//! `terminalx bots items plan ITEM --run RUN` asks the owner, once, whether to
//! start it, with three fixed answers ([`super::items::RUN_ANSWERS`]) and the
//! one the bot recommends. Only the owner's choice in the window approves it
//! (the window's proof, `enforce::needs_person`): "Approve and start" and
//! "Start, but ask before merging" approve the plan and start the run as the
//! Run view's Approve does; the second also holds the bot's sessions from
//! `runs merge` until the owner says Merge on a question the bot asks with
//! `terminalx bots items ask-merge ITEM`. "Not now" starts nothing.
//!
//! The item shows its runs as they are now ([`views`]): each piece, who
//! builds it, its tries with their worker sessions, what each cost and what
//! each reported. An item that links a run that has not ended is not done.
//!
//! A bot checks back on an item at a time it sets, and when a run the item
//! links tells its lead something new (a worker reported): the app wakes the
//! chat that set it with a short note from TerminalX. Nothing runs and nothing
//! is spent while it waits; the clock is the automation scheduler's
//! (`automations::evaluate`), not a scheduler of its own.
//!
//! Both switches hold: with Bots off nothing here runs; with Orchestrator
//! runs off a bot cannot ask for a run's approval and an answer starts none.

use std::collections::BTreeSet;

use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

use super::items::{self, Answer, CheckBack, Item, ItemRun, Link, Purpose, Question, MERGE_ANSWERS, PURPOSE_MERGE_RUN, PURPOSE_START_RUN, RUN_ANSWERS, RUN_QUESTION};
use super::{chat, refused, Bot, OWNER};
use crate::orchestration::{store as runs_store, Run, RunState};
use crate::session::SessionManager;
use crate::sink::EventSink;
use crate::store::index::{self, SessionEntry};

/// Runs one item may ask about; past it the oldest that ended goes first.
pub const MAX_RUNS: usize = 10;
/// Who the app's entries on an item are by: TerminalX, neither the owner nor the bot.
pub const BY_TERMINALX: &str = "terminalx";
/// A check-back that could not reach the bot's chat is tried again this much later.
const RETRY_MINUTES: i64 = 5;

/// Settings → Experimental → Orchestrator runs.
pub fn orchestrator_on() -> bool {
    crate::store::settings::load().experimental.orchestrator_runs
}

const ORCHESTRATOR_OFF: &str = "Orchestrator runs is off in Settings → Experimental, so a run cannot be approved or started from a bot's work list.";

/// Whether `run`'s lead works for `bot`: the lead is one of its sessions, or one they started.
pub fn led_for(run: &Run, bot: &str) -> bool {
    index::get(&run.lead.session_id).ok().as_ref().and_then(chat::acting_bot).as_deref() == Some(bot)
}

/// Over for good: done or stopped. A failed run is not: its pieces may still be merged (`runs merge`), so it keeps
/// its merge hold and its place on the item, and the item stays open until it is stopped or finished.
fn settled(state: RunState) -> bool {
    matches!(state, RunState::Done | RunState::Stopped)
}

fn state_name(state: RunState) -> String {
    serde_json::to_value(state).ok().and_then(|value| value.as_str().map(str::to_owned)).unwrap_or_default()
}

/// The one run `selector` names (an id or its start).
fn named_run(selector: &str) -> Result<Run> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Err(refused("Name the run with --run RUN: the id `terminalx runs create` answered with."));
    }
    let mut matching = runs_store::matching(selector)?;
    match matching.len() {
        0 => Err(refused(format!("No run matches {selector}."))),
        1 => Ok(matching.remove(0)),
        _ => Err(refused(format!("More than one run matches {selector}: give more of its id."))),
    }
}

/// The run's goal as a link's title: its first line, at most 200 characters.
fn goal_title(run: &Run) -> String {
    let line: String = run.goal.lines().next().unwrap_or_default().chars().filter(|c| !c.is_control()).take(200).collect();
    line.trim().to_string()
}

/// The runs an item links or asked about, by id, in the order first linked.
fn run_ids(item: &Item) -> Vec<String> {
    let mut seen = BTreeSet::new();
    item.links
        .iter()
        .filter(|link| link.kind == "run")
        .map(|link| link.target.clone())
        .chain(item.runs.iter().map(|entry| entry.run.clone()))
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

// ---------------------------------------------------------------- what the bot does

/// `terminalx bots items plan ITEM --run RUN`: link the run to the item and ask the owner, once, whether to start it.
pub fn plan(sink: &dyn EventSink, bot: &Bot, number: u64, run: &str, note: Option<&str>, minutes: Option<u32>, recommended: Option<usize>) -> Result<Item> {
    if !orchestrator_on() {
        return Err(refused(format!("{ORCHESTRATOR_OFF} Ask your owner on the item (`terminalx bots items ask`) whether to switch it on, or do the work in sessions.")));
    }
    let run = named_run(run)?;
    if !led_for(&run, &bot.id) {
        return Err(refused(format!("Run {} is not led for {}: lead it from one of your own sessions (`terminalx runs create` there), then ask.", run.id, bot.name)));
    }
    if !matches!(run.state, RunState::AwaitingApproval | RunState::Planned) {
        return Err(refused(format!("Run {} is {}: only a plan that has not started is asked about. `terminalx runs show {} --json` says where it is.", run.id, state_name(run.state), run.id)));
    }
    let text = match note.map(str::trim).filter(|note| !note.is_empty()) {
        Some(note) => format!("{RUN_QUESTION}\n\n{note}"),
        None => RUN_QUESTION.to_string(),
    };
    let answers: Vec<String> = RUN_ANSWERS.iter().map(|answer| answer.to_string()).collect();
    // "Approve and start" unless the bot recommends otherwise.
    let recommended = Some(recommended.unwrap_or(0));
    let title = goal_title(&run);
    let id = run.id.clone();
    items::ask_as(sink, bot, number, &text, &answers, recommended, Purpose::StartRun(&id), |item| {
        items::add_link(bot, item, Link { kind: "run".into(), target: id.clone(), title, unknown: Default::default() }, &bot.id)?;
        item.runs.retain(|entry| entry.run != id);
        if item.runs.len() >= MAX_RUNS {
            // The oldest that ended makes room; one still going is never forgotten.
            match item.runs.iter().position(|entry| runs_store::get(&entry.run).map_or(true, |run| settled(run.state))) {
                Some(oldest) => {
                    item.runs.remove(oldest);
                }
                None => return Err(refused(format!("Item #{number} already asks about {MAX_RUNS} runs that have not ended: stop or finish some, or add a new item."))),
            }
        }
        item.runs.push(ItemRun { run: id.clone(), minutes, asked: index::now(), decision: String::new(), decided: None, hold_merge: false, merge_approved: None, unknown: Default::default() });
        Ok(())
    })
}

/// `terminalx bots items ask-merge ITEM [--run RUN]`: ask the owner whether the run they asked to hear about before
/// it merges may merge now.
pub fn ask_merge(sink: &dyn EventSink, bot: &Bot, number: u64, run: Option<&str>, note: Option<&str>) -> Result<Item> {
    let list = items::read(&bot.id)?;
    let item = list.items.iter().find(|item| item.number == number).ok_or_else(|| refused(format!("No item #{number}.")))?;
    let held: Vec<&ItemRun> = item.runs.iter().filter(|entry| entry.hold_merge && entry.merge_approved.is_none()).filter(|entry| run.is_none_or(|run| entry.run.starts_with(run.trim()))).collect();
    let id = match held.as_slice() {
        [] => return Err(refused(format!("Item #{number} holds no run for your owner's word before it merges: merge with `terminalx runs merge` as the run's lead."))),
        [one] => one.run.clone(),
        _ => return Err(refused(format!("Item #{number} holds more than one run before merging: name one with --run RUN."))),
    };
    let text = match note.map(str::trim).filter(|note| !note.is_empty()) {
        Some(note) => format!("Merge the run now?\n\n{note}"),
        None => "Merge the run now?".to_string(),
    };
    let answers: Vec<String> = MERGE_ANSWERS.iter().map(|answer| answer.to_string()).collect();
    let checked = id.clone();
    items::ask_as(sink, bot, number, &text, &answers, Some(0), Purpose::MergeRun(&id), move |item| {
        // Judged again under the lock: the owner may have answered meanwhile.
        if item.runs.iter().any(|entry| entry.run == checked && entry.hold_merge && entry.merge_approved.is_none()) {
            Ok(())
        } else {
            Err(refused(format!("Your owner already let run {checked} merge, or no longer holds it.")))
        }
    })
}

/// The owner's answer to a run's question, recorded on the item (called by `items::answer` under its lock).
pub(super) fn answered(item: &mut Item, question: &Question, answer: &Answer) {
    let now = index::now();
    let Some(entry) = item.runs.iter_mut().find(|entry| entry.run == question.run) else { return };
    let said = match question.purpose.as_str() {
        PURPOSE_START_RUN => {
            entry.decision = match answer {
                Answer::Choice(0) => "start",
                Answer::Choice(1) => "startAskMerge",
                Answer::Choice(_) => "notNow",
                Answer::Typed(_) => "answered",
            }
            .into();
            entry.decided = Some(now);
            entry.hold_merge = matches!(answer, Answer::Choice(1));
            match answer {
                Answer::Choice(0) => Some("You approved the plan, and TerminalX started the run".to_string()),
                Answer::Choice(1) => Some("You approved the plan, and TerminalX started the run; it asks you before it merges".to_string()),
                _ => None,
            }
        }
        PURPOSE_MERGE_RUN if matches!(answer, Answer::Choice(0)) => {
            entry.merge_approved = Some(now);
            Some("You let the run merge".to_string())
        }
        _ => None,
    };
    if let Some(said) = said {
        let run = question.run.clone();
        items::log(item, OWNER, "approved", said, format!("run {run}"));
    }
}

/// Why an item that links an unfinished run is not done, or `None`.
pub(super) fn open_run(item: &Item) -> Option<String> {
    run_ids(item).into_iter().find_map(|id| {
        let run = runs_store::get(&id).ok()?;
        (!settled(run.state)).then(|| format!("run {id} has not ended ({}).", state_name(run.state)))
    })
}

/// A run held from merging by an item of `bot`'s: the item's number.
/// The bots a run is for: the one its lead works for, and the caller's own, when it is placed in a bot's session.
fn bots_of(run: &Run, caller_bot: Option<&str>) -> Vec<String> {
    let lead = index::get(&run.lead.session_id).ok().as_ref().and_then(chat::acting_bot);
    let mut bots: Vec<String> = lead.into_iter().chain(caller_bot.map(str::to_owned)).collect();
    bots.dedup();
    bots
}

/// The item whose owner has not approved `run` yet, or said Not now: no one but the owner starts it, from the
/// control socket or anywhere else a bot can reach (PRO-476). `None` once they chose a start on the item, and once
/// the run has started by any route, the Run view's Approve and Start too (PRO-501): from then on the lead's
/// `runs start` launches pieces that became ready, or goes on after a stop, as any lead's does.
pub fn start_awaits_owner(run: &Run, caller_bot: Option<&str>) -> Option<u64> {
    if !matches!(run.state, RunState::AwaitingApproval | RunState::Planned) {
        return None;
    }
    bots_of(run, caller_bot).iter().find_map(|bot| {
        let list = items::read(bot).ok()?;
        list.items.iter().find(|item| item.runs.iter().any(|entry| entry.run == run.id && !chose_start(entry))).map(|item| item.number)
    })
}

fn chose_start(entry: &ItemRun) -> bool {
    matches!(entry.decision.as_str(), "start" | "startAskMerge")
}

/// The owner approved or started `run` from its Run view, not from the item that asked them (PRO-501): each item of
/// its bot's that is still open and holds no start for it is settled as their "Approve and start" there would settle it. The start is
/// recorded, and the item's question about the run is closed, so it does not go on asking for what is done. That
/// answer and not "Start, but ask before merging": the Run view's start holds no merge. The lead is told of the
/// start by the engine, as every approval tells it.
pub fn started_from_run_view(sink: &dyn EventSink, run: &str) {
    let Ok(run) = runs_store::get(run) else { return };
    for bot in bots_of(&run, None) {
        let Ok(list) = items::read(&bot) else { continue };
        if !list.items.iter().any(|item| !item.state.closed() && item.runs.iter().any(|entry| entry.run == run.id && !chose_start(entry))) {
            continue;
        }
        let settled = items::change_as_owner(sink, &bot, |items, _| {
            for item in items.iter_mut() {
                settle_started(item, &run.id);
            }
            Ok(())
        });
        if let Err(error) = settled {
            log::warn!("record the Run view's start of run {} on {bot}'s items: {error:#}", run.id);
        }
    }
}

/// [`started_from_run_view`] on one item: what [`answered`] and `items::answer_as` record for "Approve and start".
/// A done or dropped item is left as it closed (PRO-506): the start is not its to record.
pub(super) fn settle_started(item: &mut Item, run: &str) {
    if item.state.closed() {
        return;
    }
    let Some(entry) = item.runs.iter_mut().find(|entry| entry.run == run && !chose_start(entry)) else { return };
    entry.decision = "start".into();
    entry.decided = Some(index::now());
    entry.hold_merge = false;
    if item.question.as_ref().is_some_and(|question| question.purpose == PURPOSE_START_RUN && question.run == run) {
        item.question = None;
        if item.state == items::ItemState::NeedsYou {
            item.state = items::ItemState::InProgress;
        }
    }
    items::log(item, OWNER, "approved", "You started the run from its Run view".to_string(), format!("run {run}"));
}

/// [`merge_held`] for every bot `run` is for, whoever asks: a process a bot starts outside its sessions is not
/// placed in one, and is held all the same. The owner's own Merge is the window's and does not come this way.
pub fn merge_held_for(run: &Run, caller_bot: Option<&str>) -> Option<u64> {
    bots_of(run, caller_bot).iter().find_map(|bot| merge_held(bot, &run.id))
}

pub fn merge_held(bot: &str, run: &str) -> Option<u64> {
    let list = items::read(bot).ok()?;
    list.items.iter().find(|item| item.runs.iter().any(|entry| entry.run == run && entry.hold_merge && entry.merge_approved.is_none())).map(|item| item.number)
}

// ---------------------------------------------------------------- what the owner does

/// Before the owner's answer is recorded: a chosen "Approve and start" or "Start, but ask before merging" approves
/// the plan and starts the run, as the Run view's Approve does. Refused, with the answer not recorded, when it
/// cannot start. `None` for every other answer.
pub(super) fn before_answer(manager: &SessionManager, bot: &Bot, number: u64, chosen: &Answer, seen: Option<&str>, by_person: bool) -> Result<Option<Value>> {
    let list = items::read(&bot.id)?;
    let Some(item) = list.items.iter().find(|item| item.number == number) else { return Ok(None) };
    let Some(question) = item.question.as_ref().filter(|question| question.purpose == PURPOSE_START_RUN) else { return Ok(None) };
    // A question asked since is not answered by this one: `items::answer` refuses it.
    if seen.is_some_and(|seen| seen != question.id && seen != question.asked) {
        return Ok(None);
    }
    refuse_approval(question, chosen, by_person, seen)?;
    let ask_first = match chosen {
        Answer::Choice(0) => false,
        Answer::Choice(1) => true,
        _ => return Ok(None),
    };
    let run = question.run.clone();
    let sink = manager.sink().clone();
    // Held before the run starts, so nothing can merge it before the hold is there.
    if ask_first {
        set_hold(sink.as_ref(), bot, number, &run, true)?;
    }
    match start(manager, bot, &run) {
        Ok(started) => Ok(Some(started)),
        Err(error) => {
            if ask_first {
                if let Err(undo) = set_hold(sink.as_ref(), bot, number, &run, false) {
                    log::warn!("release the merge hold on run {run} that did not start: {undo:#}");
                }
            }
            Err(error)
        }
    }
}

fn set_hold(sink: &dyn EventSink, bot: &Bot, number: u64, run: &str, hold: bool) -> Result<()> {
    items::change_as_owner(sink, &bot.id, |items, _| {
        let item = items::find(items, number)?;
        if let Some(entry) = item.runs.iter_mut().find(|entry| entry.run == run) {
            entry.hold_merge = hold;
        }
        Ok(())
    })
}

/// The owner's approval of `run`: approved and started when it waits for approval, started when its project asks
/// for none. One that already started is left as it is.
fn start(manager: &SessionManager, bot: &Bot, run: &str) -> Result<Value> {
    if !orchestrator_on() {
        return Err(refused(format!("{ORCHESTRATOR_OFF} Switch it on, then answer again.")));
    }
    if bot.paused.is_some() {
        return Err(refused(format!("{} is paused, so its run would start no work. Resume it, then answer again.", bot.name)));
    }
    let run = runs_store::get(run).map_err(|_| refused(format!("Run {run} is gone: ask {} for a new plan.", bot.name)))?;
    if !led_for(&run, &bot.id) {
        return Err(refused(format!("Run {} is no longer led for {}.", run.id, bot.name)));
    }
    let method = match run.state {
        RunState::AwaitingApproval => "approve",
        RunState::Planned => "startPlanned",
        state if state.ended() => return Err(refused(format!("Run {} has ended ({}): it cannot start again. Ask {} for a new plan.", run.id, state_name(state), bot.name))),
        _ => return Ok(json!({"run": run.id, "alreadyStarted": true})),
    };
    #[cfg(test)]
    if !REAL_STARTS_FOR_TESTS.load(std::sync::atomic::Ordering::SeqCst) {
        STARTED_FOR_TESTS.lock().unwrap_or_else(|error| error.into_inner()).push((run.id.clone(), method.to_string()));
        return Ok(json!({"run": run.id, "started": true}));
    }
    // The answer itself is recorded by `items::answer_as`, after this: not settled as a Run view's start.
    let started = manager.orchestration(method, json!({"id": run.id, ANSWERING_ITEM: true})).map_err(|error| {
        // The engine's refusal is its JSON: its message is what the owner reads.
        let text = format!("{error:#}");
        let message = serde_json::from_str::<Value>(&text).ok().and_then(|value| value["message"].as_str().map(str::to_owned)).unwrap_or(text);
        refused(format!("Run {} could not start: {message}", run.id))
    })?;
    Ok(json!({"run": run.id, "started": true, "start": started}))
}

/// What `needs_person` asks of an answer: one that approves a run's plan is a person's act.
pub fn answer_starts_run(params: &Value) -> bool {
    // Read as `items::owner_call` reads them; anything it could read and this cannot counts as an approval.
    let Some(id) = params["id"].as_str() else { return true };
    let number = match &params["number"] {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.trim().trim_start_matches('#').parse().ok(),
        _ => None,
    };
    let Some(number) = number else { return true };
    let answer = match (&params["answer"], params["text"].as_str()) {
        (Value::Null, Some(_)) => return false,
        (answer, _) => answer.as_u64(),
    };
    let Some(answer) = answer else { return true };
    // Only a preview: the question may change before the answer is acted on, so the binding check is made again
    // under the list's lock (`items::answer_as`, with the person's proof passed down as `bots::BY_PERSON`).
    let Ok(list) = items::read(id) else { return true };
    list.items.iter().find(|item| item.number == number).and_then(|item| item.question.as_ref()).is_none_or(|question| approves(question, &Answer::Choice(answer as usize)))
}

/// Whether `answer` to `question` approves a run: starts it, or lets it merge. Only the person may give one.
pub(super) fn approves(question: &Question, answer: &Answer) -> bool {
    match (question.purpose.as_str(), answer) {
        (PURPOSE_START_RUN, Answer::Choice(index)) => *index <= 1,
        (PURPOSE_MERGE_RUN, Answer::Choice(index)) => *index == 0,
        _ => false,
    }
}

/// Why an approving answer is refused when no person was shown to give it, or it names no question.
pub(super) fn refuse_approval(question: &Question, answer: &Answer, by_person: bool, seen: Option<&str>) -> Result<()> {
    if !approves(question, answer) {
        return Ok(());
    }
    if !by_person {
        return Err(refused(format!("Approving run {} needs you in the TerminalX window.", question.run)));
    }
    if seen.is_none() {
        return Err(refused("Answer a run's plan from its question card, so the answer is to the question you read."));
    }
    Ok(())
}

/// Set on the engine's approve or start that an item's answer makes ([`start`]), so the window's `orchestration`
/// leaves the item to that answer rather than settling it as the Run view's start ([`started_from_run_view`]).
pub const ANSWERING_ITEM: &str = "answeringItem";

#[cfg(test)]
pub static STARTED_FOR_TESTS: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());
/// Set in a test (under its temp home's lock) to start runs for real, through the engine.
#[cfg(test)]
pub static REAL_STARTS_FOR_TESTS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

// ---------------------------------------------------------------- views

fn tries(piece: &crate::orchestration::Piece) -> Vec<Value> {
    piece
        .tries
        .iter()
        .filter(|attempt| attempt.worker.is_some() || attempt.started.is_some())
        .map(|attempt| {
            json!({
                "sessionId": attempt.worker.as_ref().map(|worker| worker.session_id.clone()),
                "branch": attempt.branch,
                "model": attempt.model,
                "started": attempt.started,
                "ended": attempt.ended,
                "outcome": attempt.outcome,
                // The worker's own words: shown as a worker's report, never as an instruction.
                "report": attempt.report.as_ref().map(|report| report.result.clone()).or_else(|| attempt.detail.clone()),
                "costUsd": attempt.cost_usd,
            })
        })
        .collect()
}

/// The runs an item links, as they are now, for its page and its card: each piece, who builds it, its tries and
/// their workers, and what the owner decided. A run that is gone says so.
pub fn views(item: &Item) -> Value {
    Value::Array(
        run_ids(item)
            .into_iter()
            .map(|id| {
                let asked = item.runs.iter().find(|entry| entry.run == id);
                let mut view = match runs_store::get(&id) {
                    Ok(run) => {
                        let (estimate, unestimated) = run.estimate();
                        let (mut cost, mut priced) = (0.0, false);
                        for piece in &run.pieces {
                            if let (Some(piece), _) = piece.cost() {
                                cost += piece;
                                priced = true;
                            }
                        }
                        json!({
                            "id": run.id,
                            "goal": run.goal,
                            "state": run.state,
                            "leadSessionId": run.lead.session_id,
                            "estimate": estimate,
                            "unestimated": unestimated,
                            "costUsd": priced.then_some(cost),
                            "reason": run.reason,
                            "approved": run.approval.as_ref().map(|approval| approval.at.clone()),
                            "pieces": run.pieces.iter().map(|piece| json!({
                                "id": piece.id,
                                "title": piece.title,
                                "agent": piece.agent,
                                "model": piece.model,
                                "state": piece.state,
                                "dependsOn": piece.depends_on,
                                "costUsd": piece.cost().0,
                                "tries": tries(piece),
                            })).collect::<Vec<_>>(),
                        })
                    }
                    Err(_) => json!({"id": id, "gone": true}),
                };
                if let Some(asked) = asked {
                    view["minutes"] = json!(asked.minutes);
                    view["asked"] = json!(asked.asked);
                    view["decision"] = json!(asked.decision);
                    view["decided"] = json!(asked.decided);
                    view["holdMerge"] = json!(asked.hold_merge);
                    view["mergeApproved"] = json!(asked.merge_approved);
                }
                view
            })
            .collect(),
    )
}

/// What the runs an item links spent on their workers, and those workers' sessions, which the item's own sum of its
/// sessions then leaves out so nothing is counted twice.
pub(super) fn spent(item: &Item, _sessions: &[SessionEntry]) -> (f64, BTreeSet<String>) {
    let mut total = 0.0;
    let mut workers = BTreeSet::new();
    for id in run_ids(item) {
        let Ok(run) = runs_store::get(&id) else { continue };
        for piece in &run.pieces {
            total += piece.cost().0.unwrap_or(0.0);
            workers.extend(piece.tries.iter().filter_map(|attempt| attempt.worker.as_ref().map(|worker| worker.session_id.clone())));
        }
    }
    (total, workers)
}

// ---------------------------------------------------------------- checking back

/// `--check-back TIME|report|off`, from session `session`.
pub(super) fn check_back(value: &str, session: Option<String>) -> Result<Option<CheckBack>> {
    match value.trim() {
        "" | "off" => Ok(None),
        "report" => Ok(Some(CheckBack { at: None, on_report: true, session, unknown: Default::default() })),
        at => {
            let at = DateTime::parse_from_rfc3339(at).map_err(|_| refused("--check-back takes a time like 2026-11-22T09:00:00Z, `report` (when a worker of a run it links reports), or off."))?.with_timezone(&Utc);
            Ok(Some(CheckBack { at: Some(at.to_rfc3339()), on_report: true, session, unknown: Default::default() }))
        }
    }
}

/// How a check-back reads in the item's activity.
pub(super) fn check_back_words(bot: &Bot, check_back: Option<&CheckBack>) -> String {
    match check_back {
        None => format!("{} no longer checks back at a set time", bot.name),
        Some(CheckBack { at: Some(at), .. }) => format!("{} checks back at {at}, or sooner when a worker reports. Nothing runs and nothing is spent while it waits", bot.name),
        Some(_) => format!("{} checks back when a worker reports. Nothing runs and nothing is spent while it waits", bot.name),
    }
}

/// Why a bot is woken to check back.
enum Why<'a> {
    /// The time it set came.
    Time(DateTime<Utc>),
    /// Run `run`, led from session `lead`, told its lead something new.
    Report { run: &'a str, lead: &'a str },
}

fn due(check_back: &CheckBack, now: DateTime<Utc>) -> bool {
    check_back.at.as_deref().and_then(|at| DateTime::parse_from_rfc3339(at).ok()).is_some_and(|at| at.with_timezone(&Utc) <= now)
}

/// The note a woken chat is given: TerminalX's own words, the item's number and the run's id, nothing a bot or a
/// worker wrote.
fn wake_text(number: u64, why: &Why<'_>) -> String {
    match why {
        Why::Time(_) => format!(
            "It is the time you set to check back on item #{number}. Look at it (`terminalx bots items show {number} --json`) and at each run it links (`terminalx runs show RUN --json`), then go on: set the next check-back, ask your owner, or close the item once every line of its done means is met."
        ),
        Why::Report { run, .. } => format!(
            "Run {run} told its lead something new: a worker reported, or the run moved on. You asked to check back on item #{number} then. `terminalx runs show {run} --json` says where it stands; set the next check-back when you have looked."
        ),
    }
}

/// Every check-back whose time has come, for bots that are not paused: called by the automation scheduler's tick.
/// A paused bot's wait until it is resumed.
pub fn check_backs_due(manager: &SessionManager, now: DateTime<Utc>) {
    if !super::enabled() {
        return;
    }
    let Ok(bots) = super::listing().map(|listing| listing.bots) else { return };
    for bot in bots.iter().filter(|bot| bot.paused.is_none()) {
        let Ok(list) = items::read(&bot.id) else { continue };
        let numbers: Vec<u64> = list.items.iter().filter(|item| !item.state.closed() && item.check_back.as_ref().is_some_and(|check_back| due(check_back, now))).map(|item| item.number).collect();
        for number in numbers {
            fire(manager, bot, number, &Why::Time(now));
        }
    }
}

/// `run` told its lead something (`ManagerHost::tell_lead`): check-backs waiting on a report of it are woken. Off
/// the engine's thread, which may hold its locks.
pub fn lead_told(manager: &SessionManager, run: &Run) {
    if !super::enabled_cached() {
        return;
    }
    let (manager, run, lead) = (manager.clone(), run.id.clone(), run.lead.session_id.clone());
    let spawned = std::thread::Builder::new().name("bot-check-back".into()).spawn(move || {
        let Some(bot) = index::get(&lead).ok().as_ref().and_then(chat::acting_bot).and_then(|id| super::get(&id).ok()) else { return };
        if bot.paused.is_some() {
            return;
        }
        let Ok(list) = items::read(&bot.id) else { return };
        let numbers: Vec<u64> = list.items.iter().filter(|item| !item.state.closed() && item.check_back.as_ref().is_some_and(|check_back| check_back.on_report) && run_ids(item).contains(&run)).map(|item| item.number).collect();
        for number in numbers {
            fire(&manager, &bot, number, &Why::Report { run: &run, lead: &lead });
        }
    });
    if let Err(error) = spawned {
        log::warn!("look for bots' check-backs on a run: {error:#}");
    }
}

/// Take the item's check-back under the list's lock (so it fires once), then wake the chat that set it. One that
/// cannot be woken is tried again a little later.
fn fire(manager: &SessionManager, bot: &Bot, number: u64, why: &Why<'_>) {
    let sink = manager.sink().clone();
    let taken = items::change(sink.as_ref(), &bot.id, |items, _| {
        let item = items::find(items, number)?;
        if item.state.closed() {
            return Ok(None);
        }
        let still = match (&item.check_back, why) {
            (Some(check_back), Why::Time(now)) => due(check_back, *now),
            // The lead that set it was told by the run itself: nothing to wake, and its time, if any, still stands.
            (Some(check_back), Why::Report { lead, .. }) => check_back.on_report && check_back.session.as_deref() != Some(*lead),
            (None, _) => false,
        };
        if !still {
            return Ok(None);
        }
        let check_back = item.check_back.take();
        let said = match why {
            Why::Time(_) => format!("TerminalX woke {} to check back, at the time it set", bot.name),
            Why::Report { run, .. } => format!("TerminalX woke {} to check back: run {run} reported", bot.name),
        };
        items::log(item, BY_TERMINALX, "checkBack", said, String::new());
        Ok(check_back)
    });
    let check_back = match taken {
        Ok(Some(check_back)) => check_back,
        Ok(None) => return,
        Err(error) => {
            log::warn!("take bot {}'s check-back on item #{number}: {error:#}", bot.id);
            return;
        }
    };
    if let Err(error) = wake(manager, bot, check_back.session.as_deref(), wake_text(number, why)) {
        log::warn!("wake bot {} to check back on item #{number}: {error:#}", bot.id);
        let again = (Utc::now() + chrono::Duration::minutes(RETRY_MINUTES)).to_rfc3339();
        let restored = items::change(sink.as_ref(), &bot.id, |items, _| {
            let item = items::find(items, number)?;
            if item.check_back.is_none() && !item.state.closed() {
                item.check_back = Some(CheckBack { at: Some(again.clone()), ..check_back.clone() });
                items::log(item, BY_TERMINALX, "checkBack", format!("TerminalX could not reach {}'s chat; it tries again at {again}", bot.name), format!("{error:#}"));
            }
            Ok(())
        });
        if let Err(error) = restored {
            log::warn!("keep bot {}'s check-back on item #{number}: {error:#}", bot.id);
        }
    }
}

#[cfg(test)]
pub static WOKEN_FOR_TESTS: std::sync::Mutex<Vec<(String, String)>> = std::sync::Mutex::new(Vec::new());
#[cfg(test)]
pub static FAIL_WAKES_FOR_TESTS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Put `text` in the chat that set the check-back while it still works for the bot, else in the bot's home chat,
/// as TerminalX's message: never as the owner's.
fn wake(manager: &SessionManager, bot: &Bot, session: Option<&str>, text: String) -> Result<String> {
    let set_from = session
        .and_then(|id| index::get(id).ok())
        .filter(|entry| !entry.archived && chat::acting_bot(entry).as_deref() == Some(bot.id.as_str()))
        .and_then(|entry| entry.tabs.iter().find(|tab| !tab.is_terminal()).map(|tab| (entry.id.clone(), tab.id.clone())));
    let (session, tab) = match set_from {
        Some(target) => target,
        None => {
            let home = chat::home_chat(manager.sink().as_ref(), &bot.id)?;
            let tab = home.tabs.iter().find(|tab| !tab.is_terminal()).map(|tab| tab.id.clone()).ok_or_else(|| anyhow::anyhow!("the home chat has no agent tab"))?;
            (home.id, tab)
        }
    };
    #[cfg(test)]
    {
        anyhow::ensure!(!FAIL_WAKES_FOR_TESTS.load(std::sync::atomic::Ordering::SeqCst), "the chat could not take the message");
        WOKEN_FOR_TESTS.lock().unwrap_or_else(|error| error.into_inner()).push((session.clone(), text));
        let _ = tab;
        Ok(session)
    }
    #[cfg(not(test))]
    {
        let author = crate::local_sharing::Person { user_id: BY_TERMINALX.into(), display_name: "TerminalX · check back".into(), email: String::new(), email_verified: false, organization_ids: Vec::new() };
        let card = crate::events::BotMessage { kind: "checkBack".into(), from: BY_TERMINALX.into(), to: bot.id.clone(), to_name: bot.name.clone(), ..Default::default() };
        manager.send_from_bot(&session, &tab, text, author, Some(card))?;
        Ok(session)
    }
}

#[cfg(test)]
#[path = "runs_tests.rs"]
mod tests;
