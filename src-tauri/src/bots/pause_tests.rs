use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::json;

use super::*;
use crate::bots::{chat, enforce, items};
use crate::sink::BroadcastSink;

fn bots_on() -> crate::store::TempHome {
    let home = crate::store::temp_home();
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = true;
    crate::store::settings::save(&settings).unwrap();
    home
}

fn manager() -> (SessionManager, Arc<crate::pty::Terminals>, Arc<BroadcastSink>) {
    let sink = Arc::new(BroadcastSink::new(256));
    let terminals = Arc::new(crate::pty::Terminals::new());
    let manager = SessionManager::new(
        sink.clone(),
        Arc::new(crate::sink::NoObserver),
        Arc::new(crate::harness::host::Host::new()),
        terminals.clone(),
        Arc::new(Default::default()),
        Arc::new(Default::default()),
        crate::hooks::prepare_control().unwrap(),
    );
    (manager, terminals, sink)
}

/// The session's first tab in a turn, as if its agent were running one: a live pane, an open turn, and the index saying so.
fn in_a_turn(manager: &SessionManager, terminals: &crate::pty::Terminals, sink: &Arc<BroadcastSink>, entry: &SessionEntry) -> String {
    let tab = &entry.tabs[0];
    index::update_tab(&entry.id, &tab.id, |tab| {
        tab.status = TabStatus::InProgress;
        Ok(())
    })
    .unwrap();
    manager.install_review_test_cli(&entry.id, &tab.id, "secret");
    let pane = format!("{}-{}", entry.id, tab.id);
    let spec = crate::pty::PaneSpec { cwd: &entry.cwd, cols: 80, rows: 24, command: Some("sleep 60"), env: &[] };
    terminals.spawn(sink.clone(), &pane, spec).unwrap();
    manager.open_turn_for_test(&entry.id, &tab.id);
    assert!(manager.is_running(&entry.id, &tab.id));
    pane
}

fn until(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "{what}");
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn mark_run_worker(entry: &SessionEntry) {
    let mut sessions = index::load().unwrap();
    sessions.iter_mut().find(|stored| stored.id == entry.id).unwrap().mark_run_worker();
    index::save(&sessions).unwrap();
}

#[test]
fn where_a_pause_came_from_is_read_from_the_call_and_anything_else_is_the_window() {
    assert_eq!(from_param(&json!({"from": "shortcut"})), FROM_SHORTCUT);
    assert_eq!(from_param(&json!({"from": "phone"})), FROM_PHONE);
    // The command line is never claimed through the runtime: its pause is `control.rs`'s.
    assert_eq!(from_param(&json!({"from": "cli"})), FROM_APP);
    assert_eq!(from_param(&json!({})), FROM_APP);
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_pause_says_where_it_came_from_and_what_it_stopped_and_a_second_keeps_the_first() {
    let _home = bots_on();
    let (manager, terminals, sink) = manager();
    let atlas = chat::hire(sink.as_ref(), "cto", "Atlas").unwrap();
    let iris = chat::hire(sink.as_ref(), "ux-designer", "Iris").unwrap();
    let home = chat::home_chat(sink.as_ref(), &atlas.id).unwrap();
    let pane = in_a_turn(&manager, &terminals, &sink, &home);

    let paused = enforce::call(&manager, "pause", &json!({"id": atlas.id, "from": "shortcut"})).unwrap();
    let pause = &paused["paused"];
    assert_eq!((pause["by"].as_str(), pause["from"].as_str()), (Some("owner"), Some("shortcut")));
    assert_eq!(pause["stopped"]["chats"], 1, "{pause}");
    assert!(pause["stopped"]["was"].as_str().unwrap().starts_with("was answering in “"), "{pause}");
    assert_eq!(pause["stopped"]["spent"]["day"], crate::stats::today(), "what it had spent when paused, to tell what it spends since");
    until("the chat in a turn is stopped", || !terminals.is_running(&pane));

    // Pause all, from the phone: Iris is paused now and says she was quiet; Atlas keeps his first pause as it was.
    let all = enforce::call(&manager, "pauseAll", &json!({"from": "phone"})).unwrap();
    let of = |id: &str| all["bots"].as_array().unwrap().iter().find(|bot| bot["id"] == id).unwrap()["paused"].clone();
    assert_eq!((of(&iris.id)["from"].as_str(), of(&iris.id)["stopped"]["was"].as_str()), (Some("phone"), Some("was quiet")));
    assert_eq!(of(&atlas.id), pause.clone(), "a second pause keeps the first one's record");
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_paused_bots_run_worker_finishes_the_step_it_is_on_and_takes_plan_mode_after_it() {
    let _home = bots_on();
    let (manager, terminals, sink) = manager();
    let atlas = chat::hire(sink.as_ref(), "cto", "Atlas").unwrap();
    let worker = chat::new_chat(sink.as_ref(), &atlas.id, None).unwrap();
    mark_run_worker(&worker);
    let worker = index::get(&worker.id).unwrap();
    let pane = in_a_turn(&manager, &terminals, &sink, &worker);

    let paused = enforce::call(&manager, "pause", &json!({"id": atlas.id})).unwrap();
    assert_eq!((paused["paused"]["stopped"]["workers"].as_u64(), paused["paused"]["stopped"]["was"].as_str()), (Some(1), Some("was running 1 worker")));
    std::thread::sleep(Duration::from_millis(300));
    assert!(terminals.is_running(&pane), "a worker's step is not cut short");
    let tab = index::get(&worker.id).unwrap().tabs[0].clone();
    assert_eq!(tab.requested_permission_mode.as_deref(), Some("plan"), "plan mode once its turn ends");
    assert!(tab.unknown.contains_key(chat::HELD_FROM_KEY), "the mode it had is given back on resume");

    // The paused page counts it as still in its step.
    let finishing = held(&manager).unwrap();
    let atlas_now = finishing["bots"].as_array().unwrap().iter().find(|bot| bot["id"] == atlas.id.as_str()).unwrap().clone();
    assert_eq!(atlas_now["inTurn"], 1, "{finishing}");

    // Its owner's message answered while paused is a chat in a turn, not a worker finishing its step.
    let home = chat::home_chat(sink.as_ref(), &atlas.id).unwrap();
    in_a_turn(&manager, &terminals, &sink, &home);
    let answering = held(&manager).unwrap();
    let atlas_now = answering["bots"].as_array().unwrap().iter().find(|bot| bot["id"] == atlas.id.as_str()).unwrap().clone();
    assert_eq!(atlas_now["inTurn"], 1, "the chat answering is not counted: {answering}");
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn the_owners_answer_to_a_paused_bot_is_kept_and_listed_as_held_and_nothing_is_dropped() {
    let _home = bots_on();
    let (manager, _terminals, sink) = manager();
    let sentry = chat::hire(sink.as_ref(), "security-auditor", "Sentry").unwrap();
    let item = items::add(sink.as_ref(), &sentry, &items::By::Bot { session: None }, items::NewItem {
        title: "Audit the relay keys".into(),
        summary: String::new(),
        done_means: Vec::new(),
        start: true,
        asked_by: None,
        added_by: None,
    })
    .unwrap();
    items::ask(sink.as_ref(), &sentry, item.number, "Rotate now or after the release?", &["Now".into(), "After".into()], Some(0)).unwrap();
    let asked = held(&manager).unwrap();
    assert!(asked["entries"].as_array().unwrap().is_empty(), "nothing is held while no bot is paused: {asked}");

    enforce::call(&manager, "pause", &json!({"id": sentry.id})).unwrap();
    let waiting = held(&manager).unwrap();
    assert_eq!(waiting["bots"][0]["needsYou"], 1, "the question still waits for the owner: {waiting}");

    // Answered while paused: kept on the item, not sent to its chat.
    let answered = items::runtime_call(&manager, "itemAnswer", &json!({"id": sentry.id, "number": item.number, "answer": 1})).unwrap().unwrap();
    assert_eq!(answered["delivery"]["kept"], true, "{answered}");
    assert!(answered["delivery"]["error"].as_str().unwrap().contains("Sentry is paused: it gets this when you resume it."));
    let list = items::read(&sentry.id).unwrap();
    assert_eq!(list.items[0].undelivered.len(), 1, "the answer waits on its item");

    let kept = held(&manager).unwrap();
    let entries = kept["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1, "{kept}");
    assert_eq!((entries[0]["kind"].as_str(), entries[0]["source"].as_str(), entries[0]["number"].as_u64(), entries[0]["messageKind"].as_str()), (Some("kept"), Some("answer"), Some(item.number), Some("answer")));
    assert_eq!(kept["bots"][0]["needsYou"], 0, "answered");
    assert!(kept["errors"].as_array().unwrap().is_empty(), "{kept}");
}

#[test]
#[cfg_attr(windows, ignore = "Bots are off on Windows")]
fn a_bot_whose_record_cannot_be_read_holds_its_runs_and_one_not_paused_holds_none() {
    let _home = bots_on();
    let (_manager, _terminals, sink) = manager();
    let atlas = chat::hire(sink.as_ref(), "cto", "Atlas").unwrap();
    let home = chat::home_chat(sink.as_ref(), &atlas.id).unwrap();
    assert_eq!(holds_run(&home.id), None);
    super::super::pause_from(sink.as_ref(), &atlas.id, crate::bots::OWNER, FROM_APP).unwrap();
    assert_eq!(holds_run(&home.id).as_deref(), Some("Atlas"));
    assert_eq!(holds_run("no-such-session"), None, "a lead that is gone works for no bot");
}
