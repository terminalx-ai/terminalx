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
    assert!(chat::refuses_mode(&index::get(&home.id).unwrap(), "manual").unwrap().contains("Atlas is paused"));
    bots::resume(sink.as_ref(), &bot.id).unwrap();
    assert_eq!(chat::refuses_mode(&index::get(&home.id).unwrap(), "bypassPermissions"), None);
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
    reconcile(&manager);
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
    // What a chat of a deleted bot may still do: plan, nothing more.
    assert_eq!(chat::mode_limit(&index::get(&home.id).unwrap()).unwrap().mode, "plan");
}
