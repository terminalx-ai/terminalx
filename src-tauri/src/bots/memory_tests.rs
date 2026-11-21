use std::sync::Arc;

use super::*;
use crate::bots::changes::{read_log, Edit};
use crate::sink::BroadcastSink;

/// A temporary store with the switch on, one bot hired, and a sink whose events are read back.
fn hired() -> (crate::store::TempHome, Arc<BroadcastSink>, Bot) {
    let home = crate::store::temp_home();
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = true;
    crate::store::settings::save(&settings).unwrap();
    let sink = Arc::new(BroadcastSink::new(256));
    let bot = super::super::create(sink.as_ref(), "cto", "Atlas").unwrap();
    (home, sink, bot)
}

fn home_of(bot: &Bot) -> std::path::PathBuf {
    super::super::home(bot).unwrap()
}

fn file(bot: &Bot, rel: &str) -> String {
    std::fs::read_to_string(home_of(bot).join(rel)).unwrap_or_default()
}

fn chat() -> Source {
    Source { kind: "chat".into(), session: Some("s-1".into()), tab: Some("t-1".into()), title: Some("Home chat".into()), ..Default::default() }
}

fn with_works_in(sink: &BroadcastSink, bot: &Bot, places: &[&str]) -> Bot {
    super::super::update(sink, &bot.id, super::super::BotPatch { works_in: Some(places.iter().map(|place| place.to_string()).collect()), ..Default::default() }).unwrap()
}

#[test]
fn a_learned_note_is_logged_with_its_source_and_undo_removes_it() {
    let (_home, sink, bot) = hired();
    let mut events = sink.subscribe();
    let recorded = add(sink.as_ref(), &bot, &Place::Bot, "  Status updates go in a table.  ", &bot.id, chat()).unwrap();
    assert_eq!(recorded.len(), 1);
    let learned = &recorded[0];
    assert_eq!((learned.kind.as_str(), learned.text.as_str(), learned.by.as_str()), ("learned", "Status updates go in a table.", bot.id.as_str()));
    assert_eq!(learned.source, chat());
    let line = format!("- {} Status updates go in a table.", today());
    assert!(file(&bot, "MEMORY.md").lines().any(|known| known == line));
    assert_eq!(std::iter::from_fn(|| events.try_recv().ok()).filter(|event| &*event.event == changes::EVENT).count(), 1);

    // The log is outside the home folder.
    let log_path = crate::store::root().unwrap().join("bot-changes").join(&bot.id).join(changes::LOG_FILE);
    assert!(log_path.is_file() && !log_path.starts_with(home_of(&bot)));

    let shown = view(sink.as_ref(), &bot).unwrap();
    assert_eq!(shown.changes[0].id, learned.id);
    assert_eq!((shown.changes[0].undone_by.as_ref(), shown.changes[0].not_undoable.as_ref()), (None, None));

    let undone = undo(sink.as_ref(), &bot, &learned.id, OWNER, Source::of("app")).unwrap();
    assert_eq!((undone.kind.as_str(), undone.undoes.as_deref()), ("undo", Some(learned.id.as_str())));
    assert!(!file(&bot, "MEMORY.md").contains("Status updates"));
    let shown = view(sink.as_ref(), &bot).unwrap();
    assert_eq!(shown.changes[0].id, undone.id);
    assert_eq!(shown.changes[1].undone_by.as_deref(), Some(undone.id.as_str()));
    assert!(shown.changes[1].not_undoable.is_some() && shown.changes[0].not_undoable.is_some());
    // Neither the change again nor the undo is undone.
    assert!(undo(sink.as_ref(), &bot, &learned.id, OWNER, Source::of("app")).unwrap_err().to_string().contains("already undone"));
    assert!(undo(sink.as_ref(), &bot, &undone.id, OWNER, Source::of("app")).is_err());
    assert!(undo(sink.as_ref(), &bot, "no-such-change", OWNER, Source::of("app")).is_err());
}

#[test]
fn undo_holds_when_other_notes_came_after_and_refuses_when_the_line_is_gone() {
    let (_home, sink, bot) = hired();
    let first = add(sink.as_ref(), &bot, &Place::Bot, "First fact", OWNER, Source::of("app")).unwrap().remove(0);
    let second = add(sink.as_ref(), &bot, &Place::Bot, "Second fact", OWNER, Source::of("app")).unwrap().remove(0);
    undo(sink.as_ref(), &bot, &first.id, OWNER, Source::of("app")).unwrap();
    let memory = file(&bot, "MEMORY.md");
    assert!(!memory.contains("First fact") && memory.contains("Second fact"));

    // Forgotten by hand meanwhile: the add has nothing left to undo, and nothing is written.
    forget(sink.as_ref(), &bot, &Place::Bot, "second", None, OWNER, Source::of("app")).unwrap();
    let before = file(&bot, "MEMORY.md");
    let refused = undo(sink.as_ref(), &bot, &second.id, OWNER, Source::of("app")).unwrap_err();
    assert!(refused.to_string().contains("no longer in MEMORY.md"), "{refused}");
    assert_eq!(file(&bot, "MEMORY.md"), before);
}

#[test]
fn forgetting_names_one_note_and_its_undo_puts_it_back_where_it_was() {
    let (_home, sink, bot) = hired();
    for note in ["Deploys are on Fridays", "Main stays green", "Merges wait for checks"] {
        add(sink.as_ref(), &bot, &Place::Bot, note, OWNER, Source::of("app")).unwrap();
    }
    let lines_before = file(&bot, "MEMORY.md");
    assert!(forget(sink.as_ref(), &bot, &Place::Bot, "ays", None, OWNER, Source::of("app")).unwrap_err().to_string().contains("2 notes match"));
    assert!(forget(sink.as_ref(), &bot, &Place::Bot, "nothing like it", None, OWNER, Source::of("app")).unwrap_err().to_string().contains("No note"));
    assert!(forget(sink.as_ref(), &bot, &Place::Bot, " ", None, OWNER, Source::of("app")).is_err());
    let forgot = forget(sink.as_ref(), &bot, &Place::Bot, "main stays GREEN", None, OWNER, Source::of("app")).unwrap().remove(0);
    assert_eq!((forgot.kind.as_str(), forgot.text.as_str()), ("forgot", "Main stays green"));
    assert!(!file(&bot, "MEMORY.md").contains("Main stays green"));
    undo(sink.as_ref(), &bot, &forgot.id, OWNER, Source::of("app")).unwrap();
    assert_eq!(file(&bot, "MEMORY.md"), lines_before);
}

#[test]
fn a_note_is_one_line_never_a_secret_and_never_twice() {
    let (_home, sink, bot) = hired();
    for refused in ["", "   ", "two\nlines", &"x".repeat(401), "The key is sk-ant-api03-abcdefghijklmnop", "token ghp_abcdefghijklmnopqrstuvwxyz0123", "-----BEGIN OPENSSH PRIVATE KEY-----", "AKIAABCDEFGHIJKLMNOP"] {
        assert!(add(sink.as_ref(), &bot, &Place::Bot, refused, OWNER, Source::of("app")).is_err(), "{refused:?}");
    }
    add(sink.as_ref(), &bot, &Place::Bot, "Uses the sk- prefix for keys", OWNER, Source::of("app")).unwrap();
    assert!(add(sink.as_ref(), &bot, &Place::Bot, "uses the SK- prefix for keys", OWNER, Source::of("app")).unwrap_err().to_string().contains("already has"));
    assert_eq!(read_log(&bot.id).unwrap().changes.len(), 1);
}

#[test]
fn edits_made_outside_the_app_are_found_logged_and_undone() {
    let (_home, sink, bot) = hired();
    // Nothing changed since hiring: the first look finds nothing.
    assert!(view(sink.as_ref(), &bot).unwrap().changes.is_empty());
    let memory = home_of(&bot).join("MEMORY.md");
    let original = std::fs::read_to_string(&memory).unwrap();
    std::fs::write(&memory, format!("{original}- 2026-11-01 Written by hand\n")).unwrap();
    std::fs::write(home_of(&bot).join("memory").join("phase-2.md"), "# Phase 2\n").unwrap();
    std::fs::write(home_of(&bot).join("ROLE.md"), "Changed my own role.\n").unwrap();

    let shown = view(sink.as_ref(), &bot).unwrap();
    // One change per file, each at the time the file was changed.
    assert_eq!(shown.changes.len(), 3);
    assert!(shown.changes.iter().all(|change| (change.kind.as_str(), change.by.as_str(), change.source.kind.as_str()) == ("outside", changes::OUTSIDE, "outside")));
    let log = read_log(&bot.id).unwrap();
    let of = |rel: &str| log.changes.iter().find(|change| change.states.contains_key(rel)).unwrap().clone();
    let (memory_change, topic_change, role_change) = (of("MEMORY.md"), of("memory/phase-2.md"), of("ROLE.md"));
    let mtime = chrono::DateTime::<chrono::Utc>::from(std::fs::metadata(&memory).unwrap().modified().unwrap()).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    assert_eq!(memory_change.at, mtime);
    let last = original.lines().last().map(str::to_owned);
    assert_eq!(memory_change.known_edits().unwrap(), [Edit::AddLine { file: "MEMORY.md".into(), line: "- 2026-11-01 Written by hand".into(), index: Some(original.lines().count()), prev: last }]);
    assert!(matches!(&topic_change.known_edits().unwrap()[0], Edit::ReplaceText { file, before: None, .. } if file == "memory/phase-2.md"));
    let Edit::ReplaceText { after: Some(after), .. } = &role_change.known_edits().unwrap()[0] else { panic!("the role is replaced as a whole text") };
    // The text is kept once, by its hash, and the log names it.
    assert_eq!(changes::kept_text(&bot.id, after).unwrap().as_deref(), Some("Changed my own role.\n"));
    assert!(!std::fs::read_to_string(crate::store::root().unwrap().join("bot-changes").join(&bot.id).join(changes::LOG_FILE)).unwrap().contains("Changed my own role"));
    // Seen once: looking again records nothing more.
    assert_eq!(view(sink.as_ref(), &bot).unwrap().changes.len(), 3);
    // The role's own change is in its history, never silent.
    assert_eq!(view(sink.as_ref(), &bot).unwrap().role.versions[0].kind, "outside");

    // Each is undone on its own.
    for change in [&memory_change, &topic_change, &role_change] {
        undo(sink.as_ref(), &bot, &change.id, OWNER, Source::of("app")).unwrap();
    }
    assert_eq!(std::fs::read_to_string(&memory).unwrap(), original);
    assert!(!home_of(&bot).join("memory").join("phase-2.md").exists());
    assert_eq!(file(&bot, "ROLE.md"), super::super::role_text(&super::super::templates::find("cto").unwrap()));

    // A file removed outside the app is a change too.
    view(sink.as_ref(), &bot).unwrap();
    std::fs::remove_file(&memory).unwrap();
    let removed = view(sink.as_ref(), &bot).unwrap().changes[0].clone();
    assert_eq!((removed.kind.as_str(), removed.text.as_str()), ("outside", "MEMORY.md removed"));
    undo(sink.as_ref(), &bot, &removed.id, OWNER, Source::of("app")).unwrap();
    assert_eq!(std::fs::read_to_string(&memory).unwrap(), original);
}

#[test]
fn the_budget_moves_the_oldest_notes_to_the_archive() {
    let (_home, sink, bot) = hired();
    view(sink.as_ref(), &bot).unwrap();
    let memory = home_of(&bot).join("MEMORY.md");
    let header = std::fs::read_to_string(&memory).unwrap();
    let header_lines = header.lines().count();
    // Notes out of date order: the oldest is in the middle.
    let mut notes: Vec<String> = (0..BUDGET - header_lines).map(|n| format!("- 2026-10-{:02} Note {n}", 10 + n % 20)).collect();
    notes[50] = "- 2025-01-01 The oldest".into();
    std::fs::write(&memory, format!("{header}{}\n", notes.join("\n"))).unwrap();
    let shown = view(sink.as_ref(), &bot).unwrap();
    assert_eq!((shown.memory.read, shown.changes[0].kind.as_str()), (BUDGET, "outside"));

    let recorded = add(sink.as_ref(), &bot, &Place::Bot, "One more", &bot.id, chat()).unwrap();
    let kinds: Vec<&str> = recorded.iter().map(|change| change.kind.as_str()).collect();
    assert_eq!(kinds, ["learned", "archived"]);
    // The move is the bot's doing: its add caused it.
    assert_eq!((recorded[1].source.kind.as_str(), recorded[1].by.as_str()), ("budget", bot.id.as_str()));
    let now = file(&bot, "MEMORY.md");
    assert_eq!(now.lines().count(), BUDGET);
    assert!(!now.contains("The oldest") && now.contains("One more") && now.starts_with(&header));
    assert_eq!(file(&bot, "memory/archive.md"), "- 2025-01-01 The oldest\n");

    let shown = view(sink.as_ref(), &bot).unwrap();
    assert_eq!((shown.memory.read, shown.memory.places[0].archive_lines), (BUDGET, 1));
    assert!(shown.memory.topics.iter().any(|topic| topic.name == ARCHIVE_FILE && topic.place == BOT_PLACE));

    // Undoing the move puts the note back, and the budget still holds: the next oldest moves instead.
    undo(sink.as_ref(), &bot, &recorded[1].id, OWNER, Source::of("app")).unwrap();
    let now = file(&bot, "MEMORY.md");
    assert!(now.contains("The oldest") && now.lines().count() == BUDGET, "{now}");
    let archive = file(&bot, "memory/archive.md");
    assert!(archive.lines().count() == 1 && archive.starts_with("- 2026-10-10 "), "{archive}");
}

#[test]
fn the_budget_counts_the_bots_notes_with_its_places() {
    let (_home, sink, bot) = hired();
    let bot = with_works_in(sink.as_ref(), &bot, &["Acme", PERSONAL]);
    assert_eq!(working_place(&bot), Place::Org("Acme".into()));
    let acme = Place::parse(&bot, "Acme").unwrap();
    add(sink.as_ref(), &bot, &acme, "Kestrel ships on Tuesdays", OWNER, Source::of("app")).unwrap();
    // Each organisation has its own folder, by its id: a rename keeps its notes. An id that is not a plain name is kept by its hash.
    assert_eq!(acme.dir(), "orgs/Acme/");
    assert!(Place::Org("a/../b".into()).dir().starts_with("orgs/x-") && Place::Org("x-1".into()).dir() != "orgs/x-1/");
    assert!(file(&bot, &acme.memory_file()).contains("Kestrel ships on Tuesdays"));

    // The place's notes fill the budget that the bot's own share.
    let acme_path = home_of(&bot).join(acme.memory_file());
    let own = file(&bot, "MEMORY.md").lines().count();
    let filler: Vec<String> = (0..BUDGET - own - 1).map(|n| format!("- 2026-09-{:02} Acme {n}", 1 + n % 28)).collect();
    std::fs::write(&acme_path, format!("{}- 2026-11-20 Kestrel ships on Tuesdays\n", filler.iter().map(|line| format!("{line}\n")).collect::<String>())).unwrap();
    add(sink.as_ref(), &bot, &Place::Bot, "A lesson about the job", OWNER, Source::of("app")).unwrap();
    let own_now = file(&bot, "MEMORY.md").lines().count();
    let acme_now = std::fs::read_to_string(&acme_path).unwrap().lines().count();
    assert_eq!(own_now + acme_now, BUDGET);
    assert_eq!(file(&bot, &acme.archive_file()).lines().count(), 1, "the oldest is Acme's, so Acme's archive has it");

    let shown = view(sink.as_ref(), &bot).unwrap();
    let keys: Vec<&str> = shown.memory.places.iter().map(|place| place.key.as_str()).collect();
    assert_eq!(keys, [BOT_PLACE, "Acme", PERSONAL]);
    assert_eq!(shown.memory.working_place, "Acme");
    let personal = &shown.memory.places[2];
    assert!(!personal.read && personal.read_lines == 0);
    // Personal notes have their own budget pair: the bot's and personal.
    add(sink.as_ref(), &bot, &Place::Personal, "Likes short answers", OWNER, Source::of("app")).unwrap();
    assert!(file(&bot, "personal/MEMORY.md").contains("Likes short answers"));

    assert!(Place::parse(&bot, "Elsewhere").unwrap_err().to_string().contains("bot, Acme, personal"));
}

#[test]
fn a_bot_with_no_organisation_keeps_its_own_and_personal_notes() {
    let (_home, sink, bot) = hired();
    assert_eq!(working_place(&bot), Place::Personal);
    let keys: Vec<String> = view(sink.as_ref(), &bot).unwrap().memory.places.into_iter().map(|place| place.key).collect();
    assert_eq!(keys, [BOT_PLACE, PERSONAL]);
}

#[test]
fn a_conversation_reads_the_bots_notes_and_its_places_within_limits() {
    let (_home, sink, bot) = hired();
    add(sink.as_ref(), &bot, &Place::Bot, "Own note", OWNER, Source::of("app")).unwrap();
    add(sink.as_ref(), &bot, &Place::Personal, "Personal note", OWNER, Source::of("app")).unwrap();
    let given = for_conversation(&bot).unwrap();
    assert!(given.contains("Own note") && given.contains("Personal note"), "{given}");
    let bot = with_works_in(sink.as_ref(), &bot, &["Acme"]);
    let given = for_conversation(&bot).unwrap();
    assert!(given.contains("Own note") && !given.contains("Personal note") && given.contains("Notes kept in organisation Acme"), "{given}");

    // Turned off, a conversation is given none.
    let off = super::super::update(sink.as_ref(), &bot.id, super::super::BotPatch { memory_off: Some(true), ..Default::default() }).unwrap();
    assert!(off.memory_off && for_conversation(&off).is_none());
    assert!(view(sink.as_ref(), &off).unwrap().memory.off);

    assert_eq!(read_split(150, 100), (150, 50));
    assert_eq!(read_split(250, 10), (BUDGET, 0));
}

#[test]
fn files_are_read_with_limits() {
    let dir = tempfile::tempdir().unwrap();
    let big = dir.path().join("big.md");
    let line = format!("{}\n", "a".repeat(99));
    std::fs::write(&big, line.repeat(1000)).unwrap();
    let read = read_limited(&big);
    assert!(read.over_limit && read.text.len() as u64 <= READ_LIMIT && read.text.ends_with('\n'));
    assert_eq!(read.bytes, 100_000);

    std::fs::write(dir.path().join("bad.md"), b"ok \xff\xfe bytes\n").unwrap();
    assert!(read_limited(&dir.path().join("bad.md")).text.contains("ok \u{fffd}"));
    assert_eq!(read_limited(&dir.path().join("missing.md")), Limited::default());
    std::fs::create_dir(dir.path().join("folder.md")).unwrap();
    assert!(read_limited(&dir.path().join("folder.md")).problem.is_some());
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&big, dir.path().join("link.md")).unwrap();
        let linked = read_limited(&dir.path().join("link.md"));
        assert!(linked.problem.is_some() && linked.text.is_empty());
    }
}

#[test]
fn the_role_keeps_its_versions_and_each_can_be_put_back() {
    let (_home, sink, bot) = hired();
    let template = super::super::role_text(&super::super::templates::find("cto").unwrap());
    let shown = view(sink.as_ref(), &bot).unwrap();
    assert_eq!(shown.role.versions.len(), 1);
    assert_eq!((shown.role.versions[0].kind.as_str(), shown.role.versions[0].change.as_ref()), ("template", None));
    assert!(template_diff(&bot).unwrap().unwrap().iter().all(|line| line.kind == "same"));
    assert_eq!(shown.role.template_title.as_deref(), Some("CTO"));

    super::super::role_write(sink.as_ref(), &bot.id, "Version two.\n", None).unwrap();
    super::super::role_write(sink.as_ref(), &bot.id, "Version three.\n", None).unwrap();
    // The same text again records nothing.
    super::super::role_write(sink.as_ref(), &bot.id, "Version three.\n", None).unwrap();
    let shown = view(sink.as_ref(), &bot).unwrap();
    // The view names each version by hash; its text is fetched when shown.
    let texts: Vec<String> = shown.role.versions.iter().map(|version| role_text(&bot, version.hash.as_deref().unwrap()).unwrap().unwrap()).collect();
    assert_eq!(texts, ["Version three.\n", "Version two.\n", template.as_str()]);
    assert_eq!(shown.role.versions[0].by, OWNER);
    assert!(template_diff(&bot).unwrap().unwrap().iter().any(|line| line.kind == "added" && line.text == "Version three."));

    // Undo the newest change, then put back the version two changes ago, then the template's.
    let newest = shown.role.versions[0].change.clone().unwrap();
    undo(sink.as_ref(), &bot, &newest, OWNER, Source::of("app")).unwrap();
    assert_eq!(file(&bot, "ROLE.md"), "Version two.\n");
    let two = shown.role.versions[1].change.clone().unwrap();
    super::super::role_write(sink.as_ref(), &bot.id, "Version four.\n", None).unwrap();
    // Changed since: the old change is not undone over the new text.
    assert!(undo(sink.as_ref(), &bot, &two, OWNER, Source::of("app")).unwrap_err().to_string().contains("changed since"));
    assert_eq!(file(&bot, "ROLE.md"), "Version four.\n");
    let restored = restore_role(sink.as_ref(), &bot, Some(&two)).unwrap();
    assert_eq!(restored[0].kind, "restored");
    assert_eq!(file(&bot, "ROLE.md"), "Version two.\n");
    restore_role(sink.as_ref(), &bot, None).unwrap();
    assert_eq!(file(&bot, "ROLE.md"), template);
    assert!(restore_role(sink.as_ref(), &bot, Some("nope")).is_err());
}

#[test]
fn a_log_line_this_build_cannot_read_is_kept_and_counted() {
    let (_home, sink, bot) = hired();
    let learned = add(sink.as_ref(), &bot, &Place::Bot, "Kept", OWNER, Source::of("app")).unwrap().remove(0);
    let log = crate::store::root().unwrap().join("bot-changes").join(&bot.id).join(changes::LOG_FILE);
    let mut newer: serde_json::Value = serde_json::from_str(std::fs::read_to_string(&log).unwrap().lines().next().unwrap()).unwrap();
    newer["id"] = json!("from-a-newer-build");
    newer["edits"] = json!([{"op": "moveLine", "file": "MEMORY.md"}]);
    newer["source"]["kind"] = json!("standup");
    let mut text = std::fs::read_to_string(&log).unwrap();
    text.push_str("not json\n");
    text.push_str(&format!("{newer}\n"));
    std::fs::write(&log, &text).unwrap();
    let shown = view(sink.as_ref(), &bot).unwrap();
    assert_eq!((shown.unreadable_changes, shown.total_changes), (1, 2));
    assert_eq!(shown.changes[0].source.kind, "standup");
    assert!(shown.changes[0].not_undoable.as_deref().unwrap().contains("newer version"));
    assert!(undo(sink.as_ref(), &bot, "from-a-newer-build", OWNER, Source::of("app")).is_err());
    undo(sink.as_ref(), &bot, &learned.id, OWNER, Source::of("app")).unwrap();
    assert!(std::fs::read_to_string(&log).unwrap().starts_with(&text), "the log is only appended to");
}

#[test]
fn an_edit_never_leaves_the_home() {
    for rel in ["", "../x.md", "/etc/passwd", "a/../../b", "memory/ x.md", "memory\\x.md"] {
        assert!(changes::checked(rel).is_err(), "{rel:?}");
    }
    for rel in ["MEMORY.md", "orgs/org_1a2b/memory/archive.md", "memory/phase-2.md"] {
        assert!(changes::checked(rel).is_ok(), "{rel:?}");
    }
}

#[test]
fn the_app_calls_answer_for_the_owner_and_refuse_while_off() {
    let (_home, sink, bot) = hired();
    let ask = |operation: &str, params: Value| super::super::call(sink.as_ref(), operation, &params);
    let added = ask("memoryAdd", json!({"id": bot.id, "text": "From the app"})).unwrap();
    assert_eq!((added[0]["by"].as_str(), added[0]["source"]["kind"].as_str()), (Some(OWNER), Some("app")));
    let shown = ask("memoryView", json!({"id": bot.id})).unwrap();
    assert_eq!(shown["memory"]["places"][0]["key"], BOT_PLACE);
    assert!(shown["role"]["path"].as_str().unwrap().ends_with("ROLE.md"));
    let id = added[0]["id"].as_str().unwrap();
    assert_eq!(ask("memoryUndo", json!({"id": bot.id, "change": id})).unwrap()["undoes"], id);
    assert!(ask("memoryForget", json!({"id": bot.id, "line": "From the app", "place": "nowhere"})).is_err());
    ask("roleRestore", json!({"id": bot.id, "change": null})).unwrap();

    let mut settings = crate::store::settings::load();
    settings.experimental.bots = false;
    crate::store::settings::save(&settings).unwrap();
    for operation in ["memoryView", "memoryLook", "memoryAdd", "memoryForget", "memoryUndo", "memoryText", "roleRestore", "roleDiff"] {
        assert_eq!(ask(operation, json!({"id": bot.id, "text": "x", "line": "x", "change": "x", "hash": "x"})).unwrap_err().to_string(), super::super::OFF_MESSAGE, "{operation}");
    }
}

/// A bot with full access can replace a file or folder of its home with a
/// link; the app neither writes through it nor reads it for a conversation.
#[cfg(unix)]
#[test]
fn a_link_in_the_home_takes_no_read_or_write_out_of_it() {
    let (_home, sink, bot) = hired();
    let bot = with_works_in(sink.as_ref(), &bot, &["Acme"]);
    let acme = Place::parse(&bot, "Acme").unwrap();
    view(sink.as_ref(), &bot).unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("MEMORY.md"), "- 2026-11-20 Not the bot's\n").unwrap();
    // A link planted where the write stages its temp file is not written through.
    let staged = home_of(&bot).join("MEMORY.md").with_extension(format!("tmp.{}", std::process::id()));
    std::os::unix::fs::symlink(outside.path().join("MEMORY.md"), &staged).unwrap();
    add(sink.as_ref(), &bot, &Place::Bot, "Written in the home", OWNER, Source::of("app")).unwrap();
    assert_eq!(std::fs::read_to_string(outside.path().join("MEMORY.md")).unwrap(), "- 2026-11-20 Not the bot's\n");
    assert!(file(&bot, "MEMORY.md").contains("Written in the home") && !staged.exists());

    std::fs::create_dir_all(home_of(&bot).join("orgs")).unwrap();
    std::os::unix::fs::symlink(outside.path(), home_of(&bot).join(acme.dir().trim_end_matches('/'))).unwrap();
    assert!(add(sink.as_ref(), &bot, &acme, "Through the link", OWNER, Source::of("app")).is_err());
    assert_eq!(std::fs::read_to_string(outside.path().join("MEMORY.md")).unwrap(), "- 2026-11-20 Not the bot's\n");
    let given = for_conversation(&bot).unwrap();
    assert!(!given.contains("Not the bot's"), "{given}");
    assert!(view(sink.as_ref(), &bot).unwrap().memory.places[1].file.problem.is_some());

    // The bot's own memory file replaced by a link: refused, and the target untouched.
    let memory = home_of(&bot).join("MEMORY.md");
    std::fs::remove_file(&memory).unwrap();
    std::os::unix::fs::symlink(outside.path().join("MEMORY.md"), &memory).unwrap();
    assert!(add(sink.as_ref(), &bot, &Place::Bot, "Also not", OWNER, Source::of("app")).is_err());
    assert_eq!(std::fs::read_to_string(outside.path().join("MEMORY.md")).unwrap(), "- 2026-11-20 Not the bot's\n");
}

#[test]
fn an_edit_made_before_the_first_look_is_recorded_not_taken_as_the_start() {
    let (_home, sink, bot) = hired();
    // Hiring started the history from the files it wrote.
    assert!(crate::store::root().unwrap().join("bot-changes").join(&bot.id).join(changes::KNOWN_FILE).is_file());
    std::fs::write(home_of(&bot).join("ROLE.md"), "Rewritten by the bot before anyone looked.\n").unwrap();
    let shown = view(sink.as_ref(), &bot).unwrap();
    assert_eq!((shown.changes.len(), shown.changes[0].kind.as_str()), (1, "outside"));
    undo(sink.as_ref(), &bot, &shown.changes[0].id, OWNER, Source::of("app")).unwrap();
    assert_eq!(file(&bot, "ROLE.md"), super::super::role_text(&super::super::templates::find("cto").unwrap()));

    // A bot hired before the history existed has no start recorded: its files as hiring wrote them are the start.
    let older = super::super::create(sink.as_ref(), "watcher", "Argus").unwrap();
    std::fs::remove_file(crate::store::root().unwrap().join("bot-changes").join(&older.id).join(changes::KNOWN_FILE)).unwrap();
    std::fs::write(home_of(&older).join("MEMORY.md"), format!("{}- 2026-11-01 Written by hand\n", file(&older, "MEMORY.md"))).unwrap();
    let shown = view(sink.as_ref(), &older).unwrap();
    assert_eq!(shown.changes.len(), 1);
    let log = read_log(&older.id).unwrap();
    assert!(log.changes[0].known_edits().unwrap().iter().any(|edit| matches!(edit, Edit::AddLine { line, .. } if line.ends_with("Written by hand"))));
}

#[test]
fn a_role_has_one_limit_and_the_editor_saves_only_over_what_it_started_from() {
    let (_home, sink, bot) = hired();
    // Writing past the limit a conversation reads is refused, with a message.
    let long = "a line of the role that is long enough\n".repeat(2_000);
    assert!(long.len() as u64 > ROLE_LIMIT);
    assert!(super::super::role_write(sink.as_ref(), &bot.id, &long, None).unwrap_err().to_string().contains(&format!("at most {} KB", ROLE_LIMIT / 1024)));
    // The same limit as the launch reads (PRO-468), so what is saved is what the bot is told.
    assert_eq!(ROLE_LIMIT, super::super::chat::ROLE_READ_LIMIT);
    assert!(super::super::role_write(sink.as_ref(), &bot.id, &"x".repeat(ROLE_LIMIT as usize), None).is_ok());
    // A file past even what the editor shows is shown in part, read-only.
    std::fs::write(home_of(&bot).join("ROLE.md"), &long).unwrap();
    let shown = view(sink.as_ref(), &bot).unwrap();
    assert!(shown.role.read.over_limit && !shown.role.editable && shown.role.text.len() as u64 <= ROLE_SHOWN_LIMIT && shown.role.limit == ROLE_LIMIT);
    assert_eq!(shown.role.cut, long.len() as u64 - ROLE_LIMIT);
    // PRO-489 review (low): a role saved under the older 32 KB limit is shown whole and editable, with what a
    // conversation cuts of it said; it is saved once shortened to the limit, and its stored text is never cut by a read.
    let older = "a line of a role saved before the limit came down\n".repeat(400);
    assert!(older.len() as u64 > ROLE_LIMIT && older.len() as u64 <= ROLE_SHOWN_LIMIT);
    std::fs::write(home_of(&bot).join("ROLE.md"), &older).unwrap();
    let shown = view(sink.as_ref(), &bot).unwrap().role;
    assert!(shown.editable && !shown.read.over_limit, "shown whole");
    assert_eq!(shown.text, older);
    assert_eq!(shown.cut, older.len() as u64 - ROLE_LIMIT);
    assert!(super::super::role_write(sink.as_ref(), &bot.id, &older, Some(&shown.hash)).unwrap_err().to_string().contains("at most"));
    let shortened = &older[..ROLE_LIMIT as usize];
    assert!(super::super::role_write(sink.as_ref(), &bot.id, shortened, Some(&shown.hash)).is_ok());
    assert_eq!(view(sink.as_ref(), &bot).unwrap().role.cut, 0);

    // The editor names the text it started from: a role changed since is not written over.
    std::fs::write(home_of(&bot).join("ROLE.md"), "Mine.\n").unwrap();
    let opened = view(sink.as_ref(), &bot).unwrap().role;
    assert!(opened.editable && opened.hash == changes::hash_of("Mine.\n"));
    std::fs::write(home_of(&bot).join("ROLE.md"), "Changed by the bot meanwhile.\n").unwrap();
    let refused = super::super::role_write(sink.as_ref(), &bot.id, "Mine, edited.\n", Some(&opened.hash)).unwrap_err();
    assert!(refused.to_string().contains("changed since you opened it"), "{refused}");
    assert_eq!(file(&bot, "ROLE.md"), "Changed by the bot meanwhile.\n");
    let now = view(sink.as_ref(), &bot).unwrap().role.hash;
    super::super::role_write(sink.as_ref(), &bot.id, "Mine, edited.\n", Some(&now)).unwrap();
    assert_eq!(file(&bot, "ROLE.md"), "Mine, edited.\n");
}

#[test]
fn the_view_leaves_texts_out_and_fetches_them_by_hash() {
    let (_home, sink, bot) = hired();
    super::super::role_write(sink.as_ref(), &bot.id, "A role with words in it.\n", None).unwrap();
    add(sink.as_ref(), &bot, &Place::Bot, "A note", OWNER, Source::of("app")).unwrap();
    let shown = super::super::call(sink.as_ref(), "memoryView", &json!({"id": bot.id})).unwrap();
    assert!(shown["changes"].as_array().unwrap().iter().all(|change| change.get("edits").is_none()));
    let versions = shown["role"]["versions"].as_array().unwrap();
    assert!(versions.iter().all(|version| version.get("text").is_none() && version["hash"].is_string()));
    assert!(shown["role"].get("templateDiff").is_none());
    let text = super::super::call(sink.as_ref(), "memoryText", &json!({"id": bot.id, "hash": versions[0]["hash"]})).unwrap();
    assert_eq!(text, "A role with words in it.\n");
    // A hash is only ever a name in texts/.
    assert_eq!(super::super::call(sink.as_ref(), "memoryText", &json!({"id": bot.id, "hash": "../../known"})).unwrap(), Value::Null);
    let diff = super::super::call(sink.as_ref(), "roleDiff", &json!({"id": bot.id})).unwrap();
    assert!(diff.as_array().unwrap().iter().any(|line| line["kind"] == "added"));
}

#[test]
fn the_log_is_rotated_by_size_keeping_the_newest_and_its_texts() {
    let (_home, sink, bot) = hired();
    let first = add(sink.as_ref(), &bot, &Place::Bot, "The first note", OWNER, Source::of("app")).unwrap().remove(0);
    super::super::role_write(sink.as_ref(), &bot.id, "An old role.\n", None).unwrap();
    super::super::role_write(sink.as_ref(), &bot.id, "A newer role.\n", None).unwrap();
    let old_role = changes::hash_of("An old role.\n");
    let folder = crate::store::root().unwrap().join("bot-changes").join(&bot.id);
    // Older history, padded past the size the log rotates at.
    let mut padded = std::fs::read_to_string(folder.join(changes::LOG_FILE)).unwrap();
    let mut filler: serde_json::Value = serde_json::from_str(padded.lines().next().unwrap()).unwrap();
    filler["text"] = json!("x".repeat(1000));
    while (padded.len() as u64) < changes::MAX_LOG_BYTES {
        filler["id"] = json!(uuid::Uuid::now_v7().to_string());
        padded.push_str(&format!("{filler}\n"));
    }
    std::fs::write(folder.join(changes::LOG_FILE), &padded).unwrap();
    super::super::role_write(sink.as_ref(), &bot.id, "The role now.\n", None).unwrap();
    let size = std::fs::metadata(folder.join(changes::LOG_FILE)).unwrap().len();
    assert!(size <= changes::MAX_LOG_BYTES / 2, "{size}");
    let log = read_log(&bot.id).unwrap();
    assert_eq!(log.changes.last().unwrap().kind, "role");
    assert!(!log.changes.iter().any(|change| change.id == first.id), "the oldest went");
    // The texts the kept changes and the files name stay (the newest change still undoes to the newer role); the old role's is gone with its changes.
    assert!(changes::kept_text(&bot.id, &changes::hash_of("The role now.\n")).unwrap().is_some());
    assert!(changes::kept_text(&bot.id, &changes::hash_of("A newer role.\n")).unwrap().is_some());
    assert!(changes::kept_text(&bot.id, &old_role).unwrap().is_none());
}

#[test]
fn a_state_already_logged_is_never_logged_again_and_a_quiet_look_writes_nothing() {
    let (_home, sink, bot) = hired();
    let known = crate::store::root().unwrap().join("bot-changes").join(&bot.id).join(changes::KNOWN_FILE);
    let before = std::fs::read(&known).unwrap();
    // The note's line reached the log, but what the app knows of the files did not.
    add(sink.as_ref(), &bot, &Place::Bot, "Logged once", OWNER, Source::of("app")).unwrap();
    std::fs::write(&known, &before).unwrap();
    let shown = view(sink.as_ref(), &bot).unwrap();
    assert_eq!(shown.changes.len(), 1, "the note's own change, no outside copy of it");
    // Looking again, with nothing changed, does not rewrite what the app knows.
    let stamp = std::fs::metadata(&known).unwrap().modified().unwrap();
    std::thread::sleep(std::time::Duration::from_millis(20));
    view(sink.as_ref(), &bot).unwrap();
    super::super::call(sink.as_ref(), "memoryLook", &json!({"id": bot.id})).unwrap();
    assert_eq!(std::fs::metadata(&known).unwrap().modified().unwrap(), stamp);
}

#[test]
fn opening_the_bots_page_looks_at_every_bot() {
    let (_home, sink, bot) = hired();
    let other = super::super::create(sink.as_ref(), "watcher", "Argus").unwrap();
    std::fs::write(home_of(&bot).join("ROLE.md"), "Edited by Atlas.\n").unwrap();
    std::fs::write(home_of(&other).join("ROLE.md"), "Edited by Argus.\n").unwrap();
    let found = super::super::call(sink.as_ref(), "memoryLook", &json!({})).unwrap();
    assert_eq!(found["found"], 2);
    assert_eq!(read_log(&bot.id).unwrap().changes[0].kind, "outside");
    assert_eq!(read_log(&other.id).unwrap().changes[0].kind, "outside");
}

#[test]
fn forgetting_names_one_of_two_equal_notes_by_its_line() {
    let (_home, sink, bot) = hired();
    let memory = home_of(&bot).join("MEMORY.md");
    let header = std::fs::read_to_string(&memory).unwrap();
    std::fs::write(&memory, format!("{header}- 2026-11-01 Twice\n- 2026-11-02 Between\n- 2026-11-01 Twice\n")).unwrap();
    assert!(forget(sink.as_ref(), &bot, &Place::Bot, "Twice", None, OWNER, Source::of("app")).unwrap_err().to_string().contains("by its line number"));
    let second = header.lines().count() + 2;
    forget(sink.as_ref(), &bot, &Place::Bot, "Twice", Some(second), OWNER, Source::of("app")).unwrap();
    assert_eq!(file(&bot, "MEMORY.md"), format!("{header}- 2026-11-01 Twice\n- 2026-11-02 Between\n"));
}

#[test]
fn an_undo_puts_a_line_back_under_its_old_neighbour_or_at_the_end() {
    let (_home, sink, bot) = hired();
    for note in ["Alpha", "Bravo", "Charlie"] {
        add(sink.as_ref(), &bot, &Place::Bot, note, OWNER, Source::of("app")).unwrap();
    }
    let forgot = forget(sink.as_ref(), &bot, &Place::Bot, "Bravo", None, OWNER, Source::of("app")).unwrap().remove(0);
    // Lines added above since: the old line number is wrong now, its neighbour is not.
    let memory = home_of(&bot).join("MEMORY.md");
    std::fs::write(&memory, format!("- 2026-11-01 New one\n- 2026-11-01 New two\n{}", std::fs::read_to_string(&memory).unwrap())).unwrap();
    undo(sink.as_ref(), &bot, &forgot.id, OWNER, Source::of("app")).unwrap();
    let notes: Vec<String> = file(&bot, "MEMORY.md").lines().filter_map(|line| note_date(line).map(|_| note_text(line).to_owned())).collect();
    assert_eq!(notes, ["New one", "New two", "Alpha", "Bravo", "Charlie"]);

    // Its neighbour gone: the line goes back at the end.
    let forgot = forget(sink.as_ref(), &bot, &Place::Bot, "Charlie", None, OWNER, Source::of("app")).unwrap().remove(0);
    forget(sink.as_ref(), &bot, &Place::Bot, "Bravo", None, OWNER, Source::of("app")).unwrap();
    add(sink.as_ref(), &bot, &Place::Bot, "Delta", OWNER, Source::of("app")).unwrap();
    undo(sink.as_ref(), &bot, &forgot.id, OWNER, Source::of("app")).unwrap();
    assert!(file(&bot, "MEMORY.md").trim_end().ends_with("Charlie"));
}

#[test]
fn secrets_are_refused_flagged_and_taken_out_of_the_history_when_forgotten() {
    let (_home, sink, bot) = hired();
    for refused in ["sk_live_abcdefghijklmnop1234", "glpat-abcdefghijklmnopqrstu", "npm_abcdefghijklmnopqrstuvwxyz0123456789", "hf_abcdefghijklmnopqrstuvwxyzABCDEF", "the password=hunter2hunter2"] {
        assert!(add(sink.as_ref(), &bot, &Place::Bot, refused, OWNER, Source::of("app")).unwrap_err().to_string().contains("secret"), "{refused:?}");
    }
    for refused in ["one\u{2028}two", "para\u{2029}graph", "abc\u{202E}fed", "mark\u{200F}ed"] {
        assert!(add(sink.as_ref(), &bot, &Place::Bot, refused, OWNER, Source::of("app")).unwrap_err().to_string().contains("one line"), "{refused:?}");
    }
    // Written into the files outside the app, a secret is flagged where it is.
    let secret = "ghp_abcdefghijklmnopqrstuvwxyz0123";
    let memory = home_of(&bot).join("MEMORY.md");
    std::fs::write(&memory, format!("{}- 2026-11-01 The token is {secret}\n", std::fs::read_to_string(&memory).unwrap())).unwrap();
    std::fs::write(home_of(&bot).join("memory").join("deploy.md"), format!("api_key: {secret}\n")).unwrap();
    let shown = view(sink.as_ref(), &bot).unwrap();
    assert_eq!(shown.secrets.len(), 2, "{:?}", shown.secrets);
    let folder = crate::store::root().unwrap().join("bot-changes").join(&bot.id);
    assert!(std::fs::read_to_string(folder.join(changes::LOG_FILE)).unwrap().contains(secret));

    // Forgetting it takes it out of the history: the log, and the kept texts that are not the files now.
    forget(sink.as_ref(), &bot, &Place::Bot, "The token is", None, OWNER, Source::of("app")).unwrap();
    let log = std::fs::read_to_string(folder.join(changes::LOG_FILE)).unwrap();
    assert!(!log.contains(secret) && log.contains(changes::REDACTED));
    for entry in std::fs::read_dir(folder.join(changes::TEXTS_DIR)).unwrap() {
        let text = std::fs::read_to_string(entry.unwrap().path()).unwrap();
        assert!(!text.contains(secret) || text.starts_with("api_key"), "only the topic file as it is now keeps it: {text}");
    }
    let shown = view(sink.as_ref(), &bot).unwrap();
    assert!(shown.changes.iter().filter(|change| change.kind != "forgot").all(|change| !change.text.contains(secret)));
    let outside = shown.changes.iter().find(|change| change.text.contains("MEMORY.md")).unwrap();
    assert!(outside.not_undoable.as_deref().unwrap().contains("secret"));
}

#[test]
fn a_conversation_reads_the_newest_lines_and_undated_notes_are_archived_first() {
    let (_home, sink, bot) = hired();
    let memory = home_of(&bot).join("MEMORY.md");
    let header = std::fs::read_to_string(&memory).unwrap();
    let notes: Vec<String> = (0..BUDGET + 5).map(|n| format!("- 2026-10-{:02} Note {n}", 1 + n % 28)).collect();
    std::fs::write(&memory, format!("{header}{}\n", notes.join("\n"))).unwrap();
    let given = for_conversation(&bot).unwrap();
    assert!(given.contains(&format!("Note {}", BUDGET + 4)) && !given.contains("Notes kept across conversations"), "the newest are read");

    // Undated notes, then the file's own words, are what the budget moves when nothing is dated.
    let undated: Vec<String> = (0..BUDGET).map(|n| format!("- Undated {n}")).collect();
    std::fs::write(&memory, format!("{header}{}\n", undated.join("\n"))).unwrap();
    add(sink.as_ref(), &bot, &Place::Bot, "Dated now", OWNER, Source::of("app")).unwrap();
    let now = file(&bot, "MEMORY.md");
    assert_eq!(now.lines().count(), BUDGET);
    assert!(now.contains("Dated now") && now.starts_with("# Memory") && now.contains("Notes kept across conversations"));
    assert!(file(&bot, "memory/archive.md").starts_with("- Undated 0\n"));
}

#[test]
fn a_full_archive_is_rolled_to_a_dated_file() {
    let (_home, sink, bot) = hired();
    let archive = home_of(&bot).join("memory").join(ARCHIVE_FILE);
    let full = format!("- 2020-01-01 {}\n", "o".repeat(200)).repeat((ARCHIVE_ROLL_BYTES / 200) as usize);
    std::fs::write(&archive, &full).unwrap();
    let memory = home_of(&bot).join("MEMORY.md");
    let header = std::fs::read_to_string(&memory).unwrap();
    let notes: Vec<String> = (0..BUDGET - header.lines().count()).map(|n| format!("- 2026-10-01 Note {n}")).collect();
    std::fs::write(&memory, format!("{header}{}\n", notes.join("\n"))).unwrap();
    let recorded = add(sink.as_ref(), &bot, &Place::Bot, "One more", OWNER, Source::of("app")).unwrap();
    assert!(recorded.iter().find(|change| change.kind == "archived").unwrap().text.contains("started a new archive file"));
    let rolled = home_of(&bot).join("memory").join(format!("archive-{}.md", today()));
    assert_eq!(std::fs::read_to_string(&rolled).unwrap(), full);
    assert_eq!(std::fs::read_to_string(&archive).unwrap(), "- 2026-10-01 Note 0\n");
}

#[test]
fn a_deleted_bot_takes_its_history_to_the_trash() {
    let (_home, sink, bot) = hired();
    add(sink.as_ref(), &bot, &Place::Bot, "Kept with it", OWNER, Source::of("app")).unwrap();
    super::super::delete(sink.as_ref(), &bot.id).unwrap();
    let root = crate::store::root().unwrap();
    assert!(!root.join("bot-changes").join(&bot.id).exists());
    let trashed = root.join("trash").join("bots").join(format!("{}.changes", bot.id));
    assert!(std::fs::read_to_string(trashed.join(changes::LOG_FILE)).unwrap().contains("Kept with it"));
}

/// The log, padded with older history to `size` bytes.
fn pad_log(bot: &Bot, size: u64) {
    let folder = crate::store::root().unwrap().join("bot-changes").join(&bot.id);
    let mut padded = std::fs::read_to_string(folder.join(changes::LOG_FILE)).unwrap();
    let first = padded.lines().find(|line| line.contains("\"learned\"")).expect("a note to copy").to_owned();
    let mut filler: serde_json::Value = serde_json::from_str(&first).unwrap();
    filler["text"] = json!("x".repeat(1000));
    filler["undoes"] = serde_json::Value::Null;
    let mut lines: Vec<String> = Vec::new();
    while (padded.len() + lines.iter().map(|line| line.len() + 1).sum::<usize>()) < size as usize {
        filler["id"] = json!(uuid::Uuid::now_v7().to_string());
        lines.push(filler.to_string());
    }
    // Older than everything already logged.
    padded = format!("{}\n{padded}", lines.join("\n"));
    std::fs::write(folder.join(changes::LOG_FILE), padded).unwrap();
}

/// N1 (PRO-470 second review): a bot edits its role and appends about 520 KB
/// to its archive. The archive's change is kept as whole texts by hash, so
/// the log stays small, nothing rotates, and the role change is listed with
/// Undo, all through the app's own operations.
#[test]
fn one_large_outside_edit_keeps_the_role_change_and_the_rest_of_the_history() {
    let (_home, sink, bot) = hired();
    let note = super::super::call(sink.as_ref(), "memoryAdd", &json!({"id": bot.id, "place": "bot", "text": "Written before"})).unwrap();
    let note = note[0]["id"].as_str().unwrap().to_owned();
    pad_log(&bot, changes::MAX_LOG_BYTES * 3 / 4);
    let folder = crate::store::root().unwrap().join("bot-changes").join(&bot.id);

    std::fs::write(home_of(&bot).join("ROLE.md"), "Atlas rewrote its own role.\n").unwrap();
    let archive: String = (0..5200).map(|n| format!("- 2026-01-01 An archived note, number {n}, long enough to make the archive large: {}\n", "y".repeat(40))).collect();
    assert!(archive.len() > 500 * 1024);
    std::fs::create_dir_all(home_of(&bot).join("memory")).unwrap();
    std::fs::write(home_of(&bot).join("memory/archive.md"), &archive).unwrap();
    assert_eq!(super::super::call(sink.as_ref(), "memoryLook", &json!({"id": bot.id})).unwrap()["found"], 2);

    let log = read_log(&bot.id).unwrap();
    let archived = log.changes.iter().find(|change| change.states.contains_key("memory/archive.md")).unwrap();
    assert!(matches!(archived.known_edits().unwrap().as_slice(), [Edit::ReplaceText { .. }]), "whole texts by hash, not 5200 line edits");
    assert!(serde_json::to_string(archived).unwrap().len() < 4096);
    assert!(log.changes.iter().any(|change| change.id == note), "nothing rotated out");
    assert!(std::fs::metadata(folder.join(changes::LOG_FILE)).unwrap().len() < changes::MAX_LOG_BYTES);

    let shown = super::super::call(sink.as_ref(), "memoryView", &json!({"id": bot.id})).unwrap();
    assert_eq!(shown["role"]["versions"][0]["kind"], "outside", "not 'unchanged since it was hired'");
    let role_change = shown["changes"].as_array().unwrap().iter().find(|change| change["text"].as_str().unwrap().contains("ROLE.md")).unwrap().clone();
    assert!(role_change["notUndoable"].is_null());
    // Undo of both puts the files back.
    super::super::call(sink.as_ref(), "memoryUndo", &json!({"id": bot.id, "change": role_change["id"]})).unwrap();
    assert_ne!(file(&bot, "ROLE.md"), "Atlas rewrote its own role.\n");
    super::super::call(sink.as_ref(), "memoryUndo", &json!({"id": bot.id, "change": archived.id})).unwrap();
    assert!(file(&bot, "memory/archive.md").is_empty());
}

/// A rotation keeps what the commit just wrote and the newest role change,
/// with the text it replaced, however old it is.
#[test]
fn a_rotation_keeps_the_newest_role_change_and_its_text() {
    let (_home, sink, bot) = hired();
    super::super::call(sink.as_ref(), "memoryAdd", &json!({"id": bot.id, "place": "bot", "text": "The first note"})).unwrap();
    let template = changes::hash_of(&file(&bot, "ROLE.md"));
    super::super::role_write(sink.as_ref(), &bot.id, "The role, edited once.\n", None).unwrap();
    let role_change = read_log(&bot.id).unwrap().changes.last().unwrap().id.clone();
    // Push the role change to the oldest end, past what a rotation would keep.
    let folder = crate::store::root().unwrap().join("bot-changes").join(&bot.id);
    let log = std::fs::read_to_string(folder.join(changes::LOG_FILE)).unwrap();
    let mut filler: serde_json::Value = serde_json::from_str(log.lines().find(|line| line.contains("\"learned\"")).unwrap()).unwrap();
    filler["text"] = json!("x".repeat(1000));
    let mut padded = log.clone();
    while (padded.len() as u64) < changes::MAX_LOG_BYTES {
        filler["id"] = json!(uuid::Uuid::now_v7().to_string());
        padded.push_str(&format!("{filler}\n"));
    }
    std::fs::write(folder.join(changes::LOG_FILE), &padded).unwrap();

    let fresh = super::super::call(sink.as_ref(), "memoryAdd", &json!({"id": bot.id, "place": "bot", "text": "After the rotation"})).unwrap()[0]["id"].as_str().unwrap().to_owned();
    let log = read_log(&bot.id).unwrap();
    assert!(std::fs::metadata(folder.join(changes::LOG_FILE)).unwrap().len() <= changes::MAX_LOG_BYTES / 2 + 4096);
    assert!(log.changes.iter().any(|change| change.id == fresh));
    assert!(log.changes.iter().any(|change| change.id == role_change), "the newest role change stays");
    assert!(!log.changes.iter().any(|change| change.text == "The first note"), "older notes went");
    assert!(changes::kept_text(&bot.id, &template).unwrap().is_some(), "with the text it replaced");
    let shown = super::super::call(sink.as_ref(), "memoryView", &json!({"id": bot.id})).unwrap();
    assert_eq!(shown["role"]["versions"][0]["kind"], "role");
    super::super::call(sink.as_ref(), "memoryUndo", &json!({"id": bot.id, "change": role_change})).unwrap();
    assert_eq!(changes::hash_of(&file(&bot, "ROLE.md")), template);
}

/// A memory past the read limit is read from its end: the newest notes are
/// the ones a conversation and the page are given.
#[test]
fn a_memory_past_the_read_limit_is_read_from_its_end() {
    let (_home, sink, bot) = hired();
    let lines: Vec<String> = (0..3000).map(|n| format!("- 2026-11-01 Note number {n:04}, written long enough to pass the limit")).collect();
    std::fs::write(home_of(&bot).join("MEMORY.md"), format!("{}\n", lines.join("\n"))).unwrap();
    assert!(file(&bot, "MEMORY.md").len() as u64 > READ_LIMIT);
    let given = for_conversation(&bot).unwrap();
    assert!(given.contains("Note number 2999") && !given.contains("Note number 0000"), "the newest");
    assert!(given.contains("Older lines in MEMORY.md are not shown here"), "{given}");
    let shown = view(sink.as_ref(), &bot).unwrap();
    let own = &shown.memory.places[0];
    assert!(own.file.over_limit && own.lines.last().unwrap().contains("Note number 2999") && !own.lines[0].contains("Note number 0000"));
    assert!(own.lines.iter().all(|line| line.starts_with("- 2026-11-01 Note number")), "no line cut in half");
}

/// Inert with Bots off: the look over every bot as the Bots page opens, too.
#[test]
fn the_look_over_every_bot_needs_the_switch() {
    let (_home, sink, bot) = hired();
    std::fs::write(home_of(&bot).join("MEMORY.md"), "- 2026-11-01 Edited while off\n").unwrap();
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = false;
    crate::store::settings::save(&settings).unwrap();
    let before = read_log(&bot.id).unwrap().changes.len();
    assert!(super::super::call(sink.as_ref(), "memoryLook", &json!({})).is_err());
    assert_eq!(read_log(&bot.id).unwrap().changes.len(), before, "nothing recorded");
}

/// A note moved to the archive is written there before it leaves the memory.
#[test]
fn an_archive_move_writes_the_archive_first() {
    let (_home, sink, bot) = hired();
    let notes: Vec<String> = (0..BUDGET).map(|n| format!("- 2026-10-{:02} Note {n}", 1 + n % 28)).collect();
    std::fs::write(home_of(&bot).join("MEMORY.md"), format!("{}\n", notes.join("\n"))).unwrap();
    // The memory file made read-only: the archive is written first, and the failed memory write leaves the note in both, not in neither.
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(home_of(&bot).join("memory")).unwrap();
    let memory = home_of(&bot).join("MEMORY.md");
    std::fs::set_permissions(home_of(&bot), std::fs::Permissions::from_mode(0o500)).unwrap();
    let failed = super::super::call(sink.as_ref(), "memoryAdd", &json!({"id": bot.id, "place": "bot", "text": "One too many"}));
    std::fs::set_permissions(home_of(&bot), std::fs::Permissions::from_mode(0o700)).unwrap();
    assert!(failed.is_err());
    assert!(file(&bot, "memory/archive.md").contains("Note 0"), "the archive was written first");
    assert!(std::fs::read_to_string(&memory).unwrap().contains("Note 0"), "and the note is still in the memory");
}
