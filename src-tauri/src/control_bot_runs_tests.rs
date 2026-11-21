//! PRO-476 through the real dispatch: from one message a lead bot plans a run,
//! asks its owner to approve it with a recommended answer, the run starts on
//! the owner's answer in the window and on nothing else, a "Start, but ask
//! before merging" holds the bot's `runs merge` until the owner says Merge,
//! and the item closes only when its done means are met and its run ended.
//! The engine's start is kept by the test (`runs::STARTED_FOR_TESTS`), and so
//! are the chats a check-back wakes (`runs::WOKEN_FOR_TESTS`).

use serde_json::{json, Value};

use super::tests::headless_service;
use super::*;
use crate::bots::runs;

/// Puts the test switches back when dropped, on failure too.
struct Switches;

impl Drop for Switches {
    fn drop(&mut self) {
        runs::STARTED_FOR_TESTS.lock().unwrap_or_else(|error| error.into_inner()).clear();
        runs::WOKEN_FOR_TESTS.lock().unwrap_or_else(|error| error.into_inner()).clear();
        runs::FAIL_WAKES_FOR_TESTS.store(false, std::sync::atomic::Ordering::SeqCst);
        crate::bots::items::SENT_FOR_TESTS.with(|sent| sent.borrow_mut().clear());
    }
}

fn switches(bots: bool, orchestrator: bool) {
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = bots;
    settings.experimental.orchestrator_runs = orchestrator;
    crate::store::settings::save(&settings).unwrap();
}

fn home_chat(id: &str) -> SessionEntry {
    index::load().unwrap().into_iter().find(|entry| crate::bots::chat::session_bot(entry).is_some_and(|bot| bot.id == id && bot.home)).expect("a hire makes the home chat")
}

struct Lead {
    service: ControlService,
    atlas: String,
    chat: SessionEntry,
}

impl Lead {
    fn new() -> Self {
        switches(true, true);
        let (service, _sink) = headless_service();
        let atlas = service.execute("bots.create", json!({"role": "cto", "name": "Atlas"}), "r").unwrap()["bot"]["id"].as_str().unwrap().to_owned();
        let chat = home_chat(&atlas);
        service.manager.install_review_test_cli(&chat.id, &chat.tabs[0].id, "atlas-secret");
        Self { service, atlas, chat }
    }

    /// From Atlas's home chat, proved by its tab's launch secret.
    fn bot(&self, command: &str, mut params: Value) -> Result<Value, ControlError> {
        params["caller"] = json!({"session": self.chat.id, "tab": self.chat.tabs[0].id});
        params["hookToken"] = json!("atlas-secret");
        self.service.execute(command, params, "r")
    }

    /// The runtime's `bots` call as the window's own route hands it on, below the person's proof.
    fn window(&self, operation: &str, params: Value) -> anyhow::Result<Value> {
        let sink: std::sync::Arc<dyn crate::sink::EventSink> = self.service.sink.clone();
        crate::local_runtime::calls::execute(&self.service.manager, &sink, "runtime.session.bots", json!({"operation": operation, "params": params}))
    }

    fn item(&self, number: u64) -> crate::bots::items::Item {
        crate::bots::items::read(&self.atlas).unwrap().items.into_iter().find(|item| item.number == number).unwrap()
    }

    /// A run led from `lead` in `state`, as `terminalx runs create` stores one: three pieces, each with an estimate.
    fn run(&self, id: &str, lead: &str, state: &str) -> crate::orchestration::Run {
        let piece = |id: &str, title: &str, agent: &str, low: f64, high: f64| json!({
            "id": id, "title": title, "brief": {"goal": title}, "doneChecks": [{"type": "command", "run": "true"}],
            "state": "queued", "agent": agent, "estimate": {"low": low, "high": high},
        });
        let run: crate::orchestration::Run = serde_json::from_value(json!({
            "id": id, "lead": {"sessionId": lead}, "projectPath": "/fixture", "goal": "Move macOS CI to our own runner",
            "state": state, "workerMode": "bypassPermissions", "created": "2026-11-21T09:00:00Z", "modified": "2026-11-21T09:00:00Z",
            "pieces": [
                piece("register", "Register the Mac mini as a self-hosted runner", "codex", 1.0, 2.0),
                piece("route", "Route in-repo branches to it, one job at a time", "claude", 1.5, 2.5),
                piece("forks", "Keep GitHub's runner for forks; document the split", "claude", 1.0, 1.5),
            ],
        }))
        .unwrap();
        crate::orchestration::store::insert(&run).unwrap();
        run
    }

    fn set_run_state(&self, id: &str, state: crate::orchestration::RunState) {
        crate::orchestration::store::update(id, |run| {
            run.state = state;
            Ok(())
        })
        .unwrap();
    }
}

fn started() -> Vec<(String, String)> {
    runs::STARTED_FOR_TESTS.lock().unwrap_or_else(|error| error.into_inner()).drain(..).collect()
}

fn woken() -> Vec<(String, String)> {
    runs::WOKEN_FOR_TESTS.lock().unwrap_or_else(|error| error.into_inner()).drain(..).collect()
}

/// Done when: from one message, a lead bot plans a run, asks for approval with a recommended answer, starts it on
/// approval, and closes the item only when its done means lines are met.
#[test]
fn a_lead_bot_plans_a_run_asks_once_and_starts_it_only_on_its_owners_approval() {
    let _home = crate::store::temp_home();
    let _switches = Switches;
    let lead = Lead::new();
    let added = lead.bot("bots.items.add", json!({"title": "Move macOS CI to our own runner", "done": ["The three pieces are merged | checked by code"], "start": true})).unwrap();
    let number = added["item"]["number"].as_u64().unwrap();
    let run = lead.run("0199a1b2-run-macos", &lead.chat.id, "awaitingApproval");

    // Asked once, with the app's three answers and "Approve and start" recommended; the run is linked.
    let asked = lead.bot("bots.items.plan", json!({"item": number, "run": "0199a1b2", "minutes": 40, "question": "Sentry's check comes back first."})).unwrap();
    assert_eq!(asked["item"]["state"], "needsYou");
    let question = &asked["item"]["question"];
    assert_eq!(question["purpose"], "startRun");
    assert_eq!(question["run"], run.id);
    assert_eq!(question["answers"], json!(["Approve and start", "Start, but ask before merging", "Not now"]));
    assert_eq!(question["recommended"], 0);
    assert!(question["text"].as_str().unwrap().starts_with("Approve the plan and start the run?"));
    assert!(asked["item"]["links"].as_array().unwrap().iter().any(|link| link["kind"] == "run" && link["target"] == run.id));
    // The plan card's view: each piece, who builds it, the estimate and the bot's minutes.
    let view = &asked["item"]["runViews"][0];
    assert_eq!((view["state"].as_str(), view["minutes"].as_u64(), view["pieces"].as_array().map(Vec::len)), (Some("awaitingApproval"), Some(40), Some(3)));
    assert_eq!((view["estimate"]["low"].as_f64(), view["estimate"]["high"].as_f64()), (Some(3.5), Some(6.0)));
    assert_eq!(view["pieces"][0]["agent"], "codex");
    assert!(started().is_empty(), "asking starts nothing");

    // Nothing a bot sends starts it: no command of the CLI approves a run, and the answer is the window's.
    assert!(lead.bot("bots.items.answer", json!({"item": number, "answer": 0})).is_err());
    assert!(crate::bots::enforce::needs_person("itemAnswer", &json!({"id": lead.atlas, "number": number, "answer": 0})), "approving a run is a person's act");
    assert!(crate::bots::enforce::needs_person("itemAnswer", &json!({"id": lead.atlas, "number": number, "answer": 1})));
    assert!(!crate::bots::enforce::needs_person("itemAnswer", &json!({"id": lead.atlas, "number": number, "answer": 2})), "Not now starts nothing");

    // The owner's Approve and start approves the plan and starts the run, then records the answer.
    let answered = lead.window("itemAnswer", json!({"id": lead.atlas, "number": number, "answer": 0, "question": question["id"]})).unwrap();
    assert_eq!(answered["run"]["started"], true);
    assert_eq!(started(), vec![(run.id.clone(), "approve".to_string())]);
    let item = lead.item(number);
    assert_eq!((item.state.as_str(), item.question.is_none(), item.runs[0].decision.as_str(), item.runs[0].hold_merge), ("inProgress", true, "start", false));
    assert!(item.activity.iter().any(|entry| entry.kind == "approved" && entry.by == crate::bots::OWNER));

    // Closed only when its done means are met, and its run has ended.
    lead.set_run_state(&run.id, crate::orchestration::RunState::Running);
    lead.bot("bots.items.check", json!({"item": number, "line": 1, "met": true})).unwrap();
    let refused = lead.bot("bots.items.done", json!({"item": number})).unwrap_err();
    assert!(refused.message.contains("has not ended (running)"), "{}", refused.message);
    lead.set_run_state(&run.id, crate::orchestration::RunState::Failed);
    let failed = lead.bot("bots.items.done", json!({"item": number})).unwrap_err();
    assert!(failed.message.contains("has not ended (failed)"), "a failed run may still merge: {}", failed.message);
    lead.set_run_state(&run.id, crate::orchestration::RunState::Done);
    assert_eq!(lead.bot("bots.items.done", json!({"item": number})).unwrap()["item"]["state"], "done");
}

/// "Start, but ask before merging" starts the run and holds the bot's merge until the owner says Merge; "Not now"
/// starts nothing.
#[test]
fn start_but_ask_before_merging_holds_the_bots_merge_until_its_owner_says_merge() {
    let _home = crate::store::temp_home();
    let _switches = Switches;
    let lead = Lead::new();
    lead.bot("bots.items.add", json!({"title": "Runner move", "start": true})).unwrap();
    let run = lead.run("run-held", &lead.chat.id, "planned");
    lead.bot("bots.items.plan", json!({"item": 1, "run": run.id})).unwrap();
    let seen = |lead: &Lead| lead.item(1).question.unwrap().id;
    // Asked about, the run starts only on the owner's answer: not from the bot's session, nor from a process of the
    // bot's that is not placed in one.
    let early = lead.bot("runs.start", json!({"run": run.id})).unwrap_err();
    assert_eq!(early.code, "awaits_owner", "{}", early.message);
    assert_eq!(lead.service.execute("runs.start", json!({"run": run.id}), "r").unwrap_err().code, "awaits_owner");
    // The window witnesses a chosen answer, so its proof reaches the runtime; typed words need none.
    assert!(crate::serve_cli::consent::guards_request("runtime.session.bots", &json!({"operation": "itemAnswer", "params": {"id": lead.atlas, "number": 1, "answer": 1}})));
    assert!(!crate::serve_cli::consent::guards_request("runtime.session.bots", &json!({"operation": "itemAnswer", "params": {"id": lead.atlas, "number": 1, "text": "Later"}})));
    // An approving answer names the question the owner read; one that names none is refused and starts nothing.
    let unnamed = lead.window("itemAnswer", json!({"id": lead.atlas, "number": 1, "answer": 1})).unwrap_err();
    assert!(format!("{unnamed:#}").contains("from its question card"), "{unnamed:#}");
    assert!(started().is_empty());
    lead.window("itemAnswer", json!({"id": lead.atlas, "number": 1, "answer": 1, "question": seen(&lead)})).unwrap();
    // A run of a project that asks for no approval starts as the Run view's Start does.
    assert_eq!(started(), vec![(run.id.clone(), "startPlanned".to_string())]);
    let item = lead.item(1);
    assert_eq!((item.runs[0].decision.as_str(), item.runs[0].hold_merge), ("startAskMerge", true));
    lead.set_run_state(&run.id, crate::orchestration::RunState::Merging);

    let held = lead.bot("runs.merge", json!({"run": run.id})).unwrap_err();
    assert_eq!(held.code, "merge_held", "{}", held.message);
    // Held for a caller no session places too.
    assert_eq!(lead.service.execute("runs.merge", json!({"run": run.id}), "r").unwrap_err().code, "merge_held");
    // A failed run may still merge: it keeps its hold and keeps the item open.
    lead.set_run_state(&run.id, crate::orchestration::RunState::Failed);
    assert_eq!(runs::merge_held(&lead.atlas, &run.id), Some(1));
    lead.set_run_state(&run.id, crate::orchestration::RunState::Merging);
    assert!(held.recovery.as_deref().unwrap_or_default().contains("terminalx bots items ask-merge 1"));

    // The bot asks; only the owner's Merge lets it go.
    let asked = lead.bot("bots.items.ask-merge", json!({"item": 1})).unwrap();
    assert_eq!((asked["item"]["question"]["purpose"].as_str(), asked["item"]["question"]["answers"].clone()), (Some("mergeRun"), json!(["Merge", "Not yet"])));
    assert!(crate::bots::enforce::needs_person("itemAnswer", &json!({"id": lead.atlas, "number": 1, "answer": 0})));
    lead.window("itemAnswer", json!({"id": lead.atlas, "number": 1, "answer": 1})).unwrap();
    assert_eq!(runs::merge_held(&lead.atlas, &run.id), Some(1), "Not yet keeps it held");
    lead.bot("bots.items.ask-merge", json!({"item": 1})).unwrap();
    // Not given by a person (the control socket says so when the window's proof is missing): refused under the lock.
    let unproved = lead.window("itemAnswer", json!({"id": lead.atlas, "number": 1, "answer": 0, "question": seen(&lead), crate::bots::BY_PERSON: false})).unwrap_err();
    assert!(format!("{unproved:#}").contains("needs you in the TerminalX window"), "{unproved:#}");
    assert_eq!(runs::merge_held(&lead.atlas, &run.id), Some(1));
    lead.window("itemAnswer", json!({"id": lead.atlas, "number": 1, "answer": 0, "question": seen(&lead)})).unwrap();
    assert_eq!(runs::merge_held(&lead.atlas, &run.id), None);
    assert!(lead.item(1).runs[0].merge_approved.is_some());
    let again = lead.bot("bots.items.ask-merge", json!({"item": 1})).unwrap_err();
    assert!(again.message.contains("holds no run"), "{}", again.message);

    // Not now: nothing starts, and the bot is told the owner's choice like any answer.
    lead.bot("bots.items.add", json!({"title": "Another plan"})).unwrap();
    let other = lead.run("run-not-now", &lead.chat.id, "awaitingApproval");
    lead.set_run_state(&run.id, crate::orchestration::RunState::Done);
    lead.bot("bots.items.plan", json!({"item": 2, "run": other.id, "recommend": 3})).unwrap();
    assert_eq!(lead.item(2).question.unwrap().recommended, Some(2));
    lead.window("itemAnswer", json!({"id": lead.atlas, "number": 2, "answer": 2})).unwrap();
    assert!(started().is_empty());
    assert_eq!(lead.item(2).runs[0].decision, "notNow");
    assert!(crate::bots::items::SENT_FOR_TESTS.with(|sent| sent.borrow().iter().any(|(_, _, text)| text.contains("I chose answer 3 of your question on item #2"))));
}

/// The switches and the bot's own rules hold: Orchestrator runs off, a run its bot does not lead, a run that started,
/// a paused bot.
#[test]
fn a_bot_asks_only_about_its_own_unstarted_run_with_both_switches_on() {
    let _home = crate::store::temp_home();
    let _switches = Switches;
    let lead = Lead::new();
    lead.bot("bots.items.add", json!({"title": "Runner move"})).unwrap();
    let run = lead.run("run-own", &lead.chat.id, "awaitingApproval");

    switches(true, false);
    let off = lead.bot("bots.items.plan", json!({"item": 1, "run": run.id})).unwrap_err();
    assert!(off.message.contains("Orchestrator runs is off"), "{}", off.message);
    switches(true, true);

    let owners: SessionEntry = serde_json::from_value(json!({"id": "owners-own", "projectPath": "/fixture", "cwd": "/fixture", "title": "Owner's", "created": "now", "modified": "now", "tabs": []})).unwrap();
    index::update(|entries| {
        entries.push(owners.clone());
        Ok(())
    })
    .unwrap();
    let theirs = lead.run("run-owners", "owners-own", "awaitingApproval");
    let refused = lead.bot("bots.items.plan", json!({"item": 1, "run": theirs.id})).unwrap_err();
    assert!(refused.message.contains("is not led for Atlas"), "{}", refused.message);
    let going = lead.run("run-going", &lead.chat.id, "running");
    let refused = lead.bot("bots.items.plan", json!({"item": 1, "run": going.id})).unwrap_err();
    assert!(refused.message.contains("only a plan that has not started"), "{}", refused.message);
    assert!(lead.bot("bots.items.plan", json!({"item": 1, "run": "no-such-run"})).unwrap_err().message.contains("No run matches"));

    // Asked; then the owner turns Orchestrator runs off, or pauses the bot: the answer starts nothing and is not
    // recorded, so the question stays for when it can.
    let asked = lead.bot("bots.items.plan", json!({"item": 1, "run": run.id})).unwrap();
    let question = asked["item"]["question"]["id"].clone();
    switches(true, false);
    let off = lead.window("itemAnswer", json!({"id": lead.atlas, "number": 1, "answer": 0, "question": question})).unwrap_err();
    assert!(format!("{off:#}").contains("Orchestrator runs is off"), "{off:#}");
    switches(true, true);
    crate::bots::pause(lead.service.sink.as_ref(), &lead.atlas, crate::bots::OWNER).unwrap();
    let paused = lead.window("itemAnswer", json!({"id": lead.atlas, "number": 1, "answer": 1, "question": question})).unwrap_err();
    assert!(format!("{paused:#}").contains("Atlas is paused"), "{paused:#}");
    assert!(started().is_empty());
    let item = lead.item(1);
    assert!(item.question.is_some() && !item.runs[0].hold_merge, "a refused start leaves no hold behind");
    // A paused bot asks nothing.
    assert_eq!(lead.bot("bots.items.plan", json!({"item": 1, "run": run.id})).unwrap_err().code, "bot_paused");
}

/// A bot checks back at the time it set, or when a run its item links reports, and spends nothing meanwhile: the
/// app wakes the chat, once, with TerminalX's note; a paused bot waits; a chat that cannot be reached is tried again.
#[test]
fn a_bot_is_woken_to_check_back_at_its_time_or_when_its_run_reports() {
    let _home = crate::store::temp_home();
    let _switches = Switches;
    let lead = Lead::new();
    lead.bot("bots.items.add", json!({"title": "Runner move", "start": true})).unwrap();
    let run = lead.run("run-report", &lead.chat.id, "running");
    lead.bot("bots.items.set", json!({"item": 1, "link": [format!("run:{}", run.id)], "checkBack": "2026-11-21T10:00:00Z"})).unwrap();
    let item = lead.item(1);
    assert_eq!(item.check_back.as_ref().and_then(|check_back| check_back.at.clone()).as_deref(), Some("2026-11-21T10:00:00+00:00"));
    assert!(item.activity.last().unwrap().text.contains("checks back at"));

    let before: chrono::DateTime<chrono::Utc> = "2026-11-21T09:59:00Z".parse().unwrap();
    let after: chrono::DateTime<chrono::Utc> = "2026-11-21T10:00:30Z".parse().unwrap();
    runs::check_backs_due(&lead.service.manager, before);
    assert!(woken().is_empty(), "nothing before its time");
    // Paused, it waits.
    crate::bots::pause(lead.service.sink.as_ref(), &lead.atlas, crate::bots::OWNER).unwrap();
    runs::check_backs_due(&lead.service.manager, after);
    assert!(woken().is_empty());
    crate::bots::resume(lead.service.sink.as_ref(), &lead.atlas).unwrap();
    runs::check_backs_due(&lead.service.manager, after);
    let wakes = woken();
    assert_eq!(wakes.len(), 1, "{wakes:?}");
    assert_eq!(wakes[0].0, lead.chat.id, "the chat that set it");
    assert!(wakes[0].1.contains("check back on item #1"), "{}", wakes[0].1);
    assert!(lead.item(1).check_back.is_none());
    runs::check_backs_due(&lead.service.manager, after);
    assert!(woken().is_empty(), "once");

    // A chat that cannot take it is tried again later, and the item says so.
    lead.bot("bots.items.set", json!({"item": 1, "checkBack": "2026-11-21T10:00:00Z"})).unwrap();
    runs::FAIL_WAKES_FOR_TESTS.store(true, std::sync::atomic::Ordering::SeqCst);
    runs::check_backs_due(&lead.service.manager, after);
    runs::FAIL_WAKES_FOR_TESTS.store(false, std::sync::atomic::Ordering::SeqCst);
    let item = lead.item(1);
    assert!(item.check_back.as_ref().is_some_and(|check_back| check_back.at.is_some()), "kept for the next try");
    assert!(item.activity.iter().any(|entry| entry.by == runs::BY_TERMINALX && entry.text.contains("tries again")));

    // On a report: the lead was told by the run itself, so a check-back set from the lead's own chat wakes nothing more;
    // one with no chat of its own wakes the home chat.
    // Its time still stands: a report the lead was told of takes nothing away.
    lead.bot("bots.items.set", json!({"item": 1, "checkBack": "2026-11-21T12:00:00Z"})).unwrap();
    runs::lead_told(&lead.service.manager, &crate::orchestration::store::get(&run.id).unwrap());
    std::thread::sleep(std::time::Duration::from_millis(500));
    assert!(woken().is_empty(), "the lead's own chat is not told twice");
    assert_eq!(lead.item(1).check_back.and_then(|check_back| check_back.at).as_deref(), Some("2026-11-21T12:00:00+00:00"), "kept for its time");
    runs::check_backs_due(&lead.service.manager, "2026-11-21T12:00:30Z".parse().unwrap());
    assert_eq!(woken().len(), 1, "woken at its time");
    crate::bots::items::set(lead.service.sink.as_ref(), &crate::bots::get(&lead.atlas).unwrap(), 1, crate::bots::items::ItemPatch { check_back: Some("report".into()), ..Default::default() }).unwrap();
    runs::lead_told(&lead.service.manager, &crate::orchestration::store::get(&run.id).unwrap());
    let wakes = (0..100).find_map(|_| {
        std::thread::sleep(std::time::Duration::from_millis(50));
        let wakes = woken();
        (!wakes.is_empty()).then_some(wakes)
    });
    let wakes = wakes.expect("the home chat is woken");
    assert!(wakes[0].1.contains(&format!("Run {} told its lead something new", run.id)), "{}", wakes[0].1);
}

/// The item links its run and the run's workers, and its spend counts what they cost once.
#[test]
fn an_items_run_shows_each_hand_off_to_a_worker_with_its_cost_and_report() {
    let _home = crate::store::temp_home();
    let _switches = Switches;
    let lead = Lead::new();
    lead.bot("bots.items.add", json!({"title": "Runner move", "start": true})).unwrap();
    let run = lead.run("run-workers", &lead.chat.id, "running");
    crate::orchestration::store::update(&run.id, |run| {
        let piece = &mut run.pieces[0];
        piece.state = crate::orchestration::PieceState::Done;
        piece.tries = vec![serde_json::from_value(json!({
            "step": "first", "model": "gpt", "worker": {"sessionId": "worker-1", "tabId": "t"}, "branch": "register-runner",
            "outcome": "done", "costUsd": 1.9, "started": "2026-11-21T09:10:00Z", "ended": "2026-11-21T09:28:00Z",
            "report": {"result": "done: the runner is registered and picks up a test job"},
        }))
        .unwrap()];
        Ok(())
    })
    .unwrap();
    lead.bot("bots.items.set", json!({"item": 1, "link": [format!("run:{}", run.id)]})).unwrap();
    let shown = lead.window("item", json!({"id": lead.atlas, "number": 1})).unwrap();
    let tries = &shown["runViews"][0]["pieces"][0]["tries"];
    assert_eq!((tries[0]["sessionId"].as_str(), tries[0]["branch"].as_str(), tries[0]["costUsd"].as_f64()), (Some("worker-1"), Some("register-runner"), Some(1.9)));
    assert_eq!(tries[0]["report"], "done: the runner is registered and picks up a test job");
    assert_eq!(shown["spentUsd"].as_f64(), Some(1.9));
}

/// A run's workers are sessions its lead started: they act for the lead's bot, so its access and its pause hold them,
/// and as workers they create and steer no run.
#[test]
fn the_workers_of_a_bots_run_act_for_the_bot() {
    let _home = crate::store::temp_home();
    let _switches = Switches;
    let lead = Lead::new();
    let mut worker: SessionEntry = serde_json::from_value(json!({
        "id": "worker-of-atlas", "projectPath": "/fixture", "cwd": "/fixture", "title": "Register the runner", "created": "now", "modified": "now",
        "parent": {"sessionId": lead.chat.id}, "tabs": [{"id": "wt", "harness": "claude", "created": "now", "permissionMode": "bypassPermissions"}],
    }))
    .unwrap();
    crate::bots::chat::inherit(&mut worker);
    assert_eq!(crate::bots::chat::acting_bot(&worker).as_deref(), Some(lead.atlas.as_str()));
    crate::bots::pause(lead.service.sink.as_ref(), &lead.atlas, crate::bots::OWNER).unwrap();
    assert_eq!(crate::bots::chat::mode_limit(&worker).map(|limit| limit.clamp("bypassPermissions")).as_deref(), Some("plan"), "a paused bot's worker plans only");
}
