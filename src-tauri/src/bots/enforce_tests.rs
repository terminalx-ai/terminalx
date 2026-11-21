use std::sync::Arc;
use std::time::{Duration, Instant};

use super::*;
use crate::bots::{self, chat, BotAccess, BotPatch};
use crate::sink::BroadcastSink;

fn bots_on() -> crate::store::TempHome {
    let home = crate::store::temp_home();
    set_bots(true);
    home
}

fn set_bots(on: bool) {
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = on;
    crate::store::settings::save(&settings).unwrap();
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

/// The chat's first tab, as if its agent were running: a live pane under the
/// tab's CLI, which is what `is_running` asks about.
fn running(manager: &SessionManager, terminals: &crate::pty::Terminals, sink: &Arc<BroadcastSink>, entry: &SessionEntry) -> String {
    let tab = &entry.tabs[0];
    manager.install_review_test_cli(&entry.id, &tab.id, "secret");
    let pane = format!("{}-{}", entry.id, tab.id);
    let spec = crate::pty::PaneSpec { cwd: &entry.cwd, cols: 80, rows: 24, command: Some("sleep 60"), env: &[] };
    terminals.spawn(sink.clone(), &pane, spec).unwrap();
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

#[test]
fn lowering_access_or_pausing_reaches_a_chat_made_earlier() {
    let _home = bots_on();
    let (manager, _terminals, sink) = manager();
    let bot = chat::hire(sink.as_ref(), "cto", "Atlas").unwrap();
    let home = chat::home_chat(sink.as_ref(), &bot.id).unwrap();
    assert_eq!(home.tabs[0].permission_mode, "bypassPermissions", "made while it had full access");

    // Access lowered after the chat was made: its next launch, a new tab and a mode change are held to it.
    call(&manager, "update", &serde_json::json!({"id": bot.id, "patch": {"access": "readReport"}})).unwrap();
    let home = index::get(&home.id).unwrap();
    assert_eq!(home.tabs[0].permission_mode, "plan", "a tab not running is brought within it now");
    let refused = manager.set_permission_mode(&home.id, &home.tabs[0].id, "bypassPermissions").unwrap_err();
    assert!(refused.to_string().contains("Atlas has read-and-report access, so it runs in Plan at most"), "{refused:#}");
    let tab = crate::session_ops::add_tab_entry(&home.id, &crate::session_ops::NewTab { harness: "claude".into(), transport: Default::default(), model: String::new(), effort: None, permission_mode: Some("bypassPermissions".into()) }).unwrap();
    assert_eq!(tab.permission_mode, "plan", "a new tab of the chat starts within it");

    // Full again, then paused: plan mode whatever its access.
    bots::update(sink.as_ref(), &bot.id, BotPatch { access: Some(BotAccess::Full), ..Default::default() }).unwrap();
    index::update_tab(&home.id, &home.tabs[0].id, |tab| {
        tab.permission_mode = "bypassPermissions".into();
        tab.requested_permission_mode = Some("acceptEdits".into());
        Ok(())
    })
    .unwrap();
    call(&manager, "pause", &serde_json::json!({"id": bot.id})).unwrap();
    let tab = index::get(&home.id).unwrap().tabs[0].clone();
    assert_eq!((tab.permission_mode.as_str(), tab.requested_permission_mode.as_deref()), ("plan", Some("plan")));
    assert!(chat::refuses_mode(&index::get(&home.id).unwrap(), None, "manual").unwrap().contains("Atlas is paused"));
    // Resumed: the tab gets back the mode it had before the pause (N4).
    call(&manager, "resume", &serde_json::json!({"id": bot.id})).unwrap();
    let tab = index::get(&home.id).unwrap().tabs[0].clone();
    assert_eq!(tab.permission_mode, "bypassPermissions", "the mode it had before the pause");
    assert!(!tab.unknown.contains_key(chat::HELD_FROM_KEY), "nothing left held");
    assert_eq!(chat::refuses_mode(&index::get(&home.id).unwrap(), None, "bypassPermissions"), None);
}

#[test]
fn a_running_chat_is_held_to_a_pause_and_stopped_by_a_delete_or_the_switch() {
    let _home = bots_on();
    let (manager, terminals, sink) = manager();
    let bot = chat::hire(sink.as_ref(), "cto", "Atlas").unwrap();
    let home = chat::home_chat(sink.as_ref(), &bot.id).unwrap();
    let other = chat::new_chat(sink.as_ref(), &bot.id).unwrap();

    // Switched off: its running chats stop.
    let pane = running(&manager, &terminals, &sink, &home);
    set_bots(false);
    reconcile(&manager, None);
    until("Bots switched off stops the bot's running chat", || !terminals.is_running(&pane));
    set_bots(true);

    // Deleted: its chats stop before the home folder goes, then go to the archive.
    let pane = running(&manager, &terminals, &sink, &other);
    call(&manager, "delete", &serde_json::json!({"id": bot.id})).unwrap();
    assert!(!terminals.is_running(&pane), "stopped before the home folder went to the trash");
    for id in [&home.id, &other.id] {
        let entry = index::get(id).unwrap();
        assert!(entry.archived && !entry.archive.auto_archived, "{id} is archived as a person's choice, and kept");
    }
    // A chat of a deleted bot is an ordinary session, in the archive (L3).
    assert_eq!(chat::mode_limit(&index::get(&home.id).unwrap()), None);
}

/// N4: a pause, then less access, then a resume and more access: each tab
/// gets back as much of its own mode as the bot allows now, never more.
/// L4: another bot's sessions are left alone.
#[test]
fn a_resume_or_more_access_gives_back_the_mode_a_tab_had() {
    let _home = bots_on();
    let (manager, _terminals, sink) = manager();
    let bot = chat::hire(sink.as_ref(), "cto", "Atlas").unwrap();
    let other = chat::hire(sink.as_ref(), "watcher", "Argus").unwrap();
    let home = chat::home_chat(sink.as_ref(), &bot.id).unwrap();
    let theirs = chat::home_chat(sink.as_ref(), &other.id).unwrap();
    let mode = |id: &str| index::get(id).unwrap().tabs[0].permission_mode.clone();
    assert_eq!(mode(&home.id), "bypassPermissions");

    call(&manager, "pause", &serde_json::json!({"id": bot.id})).unwrap();
    assert_eq!(mode(&home.id), "plan");
    // Argus's chat is not Atlas's: left as it was, even if it is wider than Atlas allows now.
    index::update_tab(&theirs.id, &theirs.tabs[0].id, |tab| { tab.permission_mode = "somethingWide".into(); Ok(()) }).unwrap();
    call(&manager, "update", &serde_json::json!({"id": bot.id, "patch": {"access": "askOutward"}})).unwrap();
    assert_eq!(mode(&theirs.id), "somethingWide", "only the bot that changed is reconciled");

    call(&manager, "resume", &serde_json::json!({"id": bot.id})).unwrap();
    assert_eq!(mode(&home.id), "manual", "back as far as ask-before-acting allows");
    assert_eq!(index::get(&home.id).unwrap().tabs[0].unknown[chat::HELD_FROM_KEY], "bypassPermissions", "still remembered");
    call(&manager, "update", &serde_json::json!({"id": bot.id, "patch": {"access": "full"}})).unwrap();
    assert_eq!(mode(&home.id), "bypassPermissions", "full access gives back the rest");
}

/// N2: a running tab the limit cannot be applied to is stopped, and its
/// stored mode is held. A native Codex tab under ask-before-acting is plan.
#[test]
fn a_running_tab_the_limit_cannot_reach_is_stopped_and_held() {
    let _home = bots_on();
    let (manager, terminals, sink) = manager();
    let bot = chat::hire(sink.as_ref(), "cto", "Atlas").unwrap();
    let home = chat::home_chat(sink.as_ref(), &bot.id).unwrap();
    index::update_tab(&home.id, &home.tabs[0].id, |tab| {
        tab.harness = "codex".into();
        tab.transport = index::AgentTransport::ExperimentalCodexStdio;
        Ok(())
    })
    .unwrap();
    let home = index::get(&home.id).unwrap();
    let pane = running(&manager, &terminals, &sink, &home);
    // Mid-turn as its runtime knows it, though the index says idle: native Codex refuses a mode change now.
    manager.open_turn_for_test(&home.id, &home.tabs[0].id);
    assert!(manager.set_permission_mode(&home.id, &home.tabs[0].id, "plan").is_err(), "the limit cannot be applied while it runs");
    call(&manager, "update", &serde_json::json!({"id": bot.id, "patch": {"access": "askOutward"}})).unwrap();
    until("the tab the limit could not reach is stopped", || !manager.is_running(&home.id, &home.tabs[0].id) || !terminals.is_running(&pane));
    assert_eq!(index::get(&home.id).unwrap().tabs[0].permission_mode, "plan", "native Codex under ask-before-acting is plan");
}

fn set_status(entry: &SessionEntry, status: TabStatus) {
    index::update_tab(&entry.id, &entry.tabs[0].id, |tab| {
        tab.status = status;
        Ok(())
    })
    .unwrap();
}

/// M1 (review 3): a resume gives the mode back to a tab whatever its idle
/// status (one that finished unread included) and starts its agent again;
/// one in a turn is asked for the mode after its turn. L-b (review 4): once
/// all of it is asked for it is forgotten, so a rename after the turn stops nothing.
#[test]
fn a_resume_reaches_a_finished_tab_and_one_in_a_turn() {
    let _home = bots_on();
    let (manager, terminals, sink) = manager();
    let bot = chat::hire(sink.as_ref(), "cto", "Atlas").unwrap();
    let finished = chat::home_chat(sink.as_ref(), &bot.id).unwrap();
    let busy = chat::new_chat(sink.as_ref(), &bot.id).unwrap();
    call(&manager, "pause", &serde_json::json!({"id": bot.id})).unwrap();

    set_status(&finished, TabStatus::Completed);
    let finished = index::get(&finished.id).unwrap();
    let pane = running(&manager, &terminals, &sink, &finished);
    set_status(&busy, TabStatus::InProgress);
    let busy = index::get(&busy.id).unwrap();
    running(&manager, &terminals, &sink, &busy);
    manager.open_turn_for_test(&busy.id, &busy.tabs[0].id);

    call(&manager, "resume", &serde_json::json!({"id": bot.id})).unwrap();
    until("the finished tab's agent starts again with its mode back", || !terminals.is_running(&pane));
    let tab = index::get(&finished.id).unwrap().tabs[0].clone();
    assert_eq!(tab.permission_mode, "bypassPermissions");
    assert!(!tab.unknown.contains_key(chat::HELD_FROM_KEY));

    let tab = index::get(&busy.id).unwrap().tabs[0].clone();
    assert!(manager.is_running(&busy.id, &tab.id), "a turn is not cut short");
    assert_eq!(tab.requested_permission_mode.as_deref(), Some("bypassPermissions"), "asked for after the turn");
    assert!(!tab.unknown.contains_key(chat::HELD_FROM_KEY), "all of it is asked for: nothing left to give back");

    // The turn ends; a rename reconciles and stops nothing.
    set_status(&busy, TabStatus::Completed);
    call(&manager, "update", &serde_json::json!({"id": bot.id, "patch": {"name": "Atlas II"}})).unwrap();
    assert!(manager.is_running(&busy.id, &tab.id), "a rename after the turn stops no agent");
}

/// L1 and L3: a mode set by hand is the tab's own, so no later reconcile
/// lifts it; and only a change to what a bot is told restarts its agents.
#[test]
fn a_mode_set_by_hand_stays_and_a_rename_restarts_nothing() {
    let _home = bots_on();
    let (manager, terminals, sink) = manager();
    let bot = chat::hire(sink.as_ref(), "cto", "Atlas").unwrap();
    let home = chat::home_chat(sink.as_ref(), &bot.id).unwrap();
    let mut events = sink.subscribe();
    call(&manager, "update", &serde_json::json!({"id": bot.id, "patch": {"access": "askOutward"}})).unwrap();
    assert!(std::iter::from_fn(|| events.try_recv().ok()).any(|published| &*published.event == "session_updated"), "the picker is told");
    let home = index::get(&home.id).unwrap();
    assert_eq!(home.tabs[0].unknown[chat::HELD_FROM_KEY], "bypassPermissions");

    // The owner picks Plan by hand while it is held: that is the tab's mode from now on.
    let pane = running(&manager, &terminals, &sink, &home);
    manager.open_turn_for_test(&home.id, &home.tabs[0].id);
    manager.set_permission_mode(&home.id, &home.tabs[0].id, "plan").unwrap();
    assert!(!index::get(&home.id).unwrap().tabs[0].unknown.contains_key(chat::HELD_FROM_KEY));

    // A rename reconciles, gives nothing back and stops nothing.
    call(&manager, "update", &serde_json::json!({"id": bot.id, "patch": {"name": "Atlas II"}})).unwrap();
    assert!(terminals.is_running(&pane), "a rename restarts no agent");
    call(&manager, "update", &serde_json::json!({"id": bot.id, "patch": {"access": "full"}})).unwrap();
    let tab = index::get(&home.id).unwrap().tabs[0].clone();
    assert_ne!(tab.permission_mode, "bypassPermissions", "what the owner chose is not lifted");
    assert!(!tab.unknown.contains_key(chat::HELD_FROM_KEY));
}

/// H1: deleting a bot stops every session that works for it, a session it
/// started included, and gives none of them a wider mode back.
#[test]
fn a_delete_stops_the_bots_sessions_and_gives_back_nothing() {
    let _home = bots_on();
    let (manager, terminals, sink) = manager();
    let bot = chat::hire(sink.as_ref(), "cto", "Atlas").unwrap();
    let home = chat::home_chat(sink.as_ref(), &bot.id).unwrap();
    let mut started = home.clone();
    started.id = "started-by-atlas".into();
    started.unknown.clear();
    started.unknown.insert(chat::STARTED_KEY.into(), serde_json::json!({"id": bot.id}));
    started.tabs[0].permission_mode = "bypassPermissions".into();
    index::update(|entries| {
        entries.push(started.clone());
        Ok(())
    })
    .unwrap();
    call(&manager, "pause", &serde_json::json!({"id": bot.id})).unwrap();
    let started = index::get(&started.id).unwrap();
    assert_eq!(started.tabs[0].permission_mode, "plan");
    let pane = running(&manager, &terminals, &sink, &started);

    call(&manager, "delete", &serde_json::json!({"id": bot.id})).unwrap();
    assert!(!terminals.is_running(&pane), "its agent is stopped before it becomes an ordinary session");
    for id in [&home.id, &started.id] {
        let tab = index::get(id).unwrap().tabs[0].clone();
        assert_eq!(tab.permission_mode, "plan", "{id} keeps the mode it was held to");
        assert!(!tab.unknown.contains_key(chat::HELD_FROM_KEY), "{id}");
    }
}

/// PRO-470: a role put back, or a change to it undone, reaches the bot's
/// agents as a role write does; a note, or undoing one, restarts nothing.
#[test]
fn a_role_put_back_or_undone_starts_the_bots_agents_again() {
    let _home = bots_on();
    let (manager, terminals, sink) = manager();
    let bot = chat::hire(sink.as_ref(), "cto", "Atlas").unwrap();
    let home = chat::home_chat(sink.as_ref(), &bot.id).unwrap();
    set_status(&home, TabStatus::Completed);
    let home = index::get(&home.id).unwrap();
    let restart = || running(&manager, &terminals, &sink, &home);

    let pane = restart();
    let added = call(&manager, "memoryAdd", &serde_json::json!({"id": bot.id, "place": "bot", "text": "Status updates go in a table."})).unwrap();
    call(&manager, "memoryUndo", &serde_json::json!({"id": bot.id, "change": added[0]["id"]})).unwrap();
    assert!(terminals.is_running(&pane), "a note restarts no agent");

    call(&manager, "roleWrite", &serde_json::json!({"id": bot.id, "text": "Plan the work.\n"})).unwrap();
    until("a role write starts it again", || !terminals.is_running(&pane));
    let role_change = crate::bots::changes::read_log(&bot.id).unwrap().changes.into_iter().rev().find(|change| change.kind == "role").unwrap().id;

    let pane = restart();
    call(&manager, "memoryUndo", &serde_json::json!({"id": bot.id, "change": role_change})).unwrap();
    until("a role change undone starts it again", || !terminals.is_running(&pane));

    let pane = restart();
    call(&manager, "roleRestore", &serde_json::json!({"id": bot.id, "change": role_change})).unwrap();
    until("a role put back starts it again", || !terminals.is_running(&pane));
    assert!(std::fs::read_to_string(crate::store::bots::home_dir(&bot.id).unwrap().join("ROLE.md")).unwrap().contains("Plan the work."));
}
