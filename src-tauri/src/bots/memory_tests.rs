use std::sync::Arc;

use super::*;
use crate::bots::changes::{read_log, undo, Edit};
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
    assert_eq!(shown.changes[0].change.id, learned.id);
    assert_eq!((shown.changes[0].undone_by.as_ref(), shown.changes[0].not_undoable.as_ref()), (None, None));

    let undone = undo(sink.as_ref(), &bot.id, &learned.id, OWNER, Source::of("app")).unwrap();
    assert_eq!((undone.kind.as_str(), undone.undoes.as_deref()), ("undo", Some(learned.id.as_str())));
    assert!(!file(&bot, "MEMORY.md").contains("Status updates"));
    let shown = view(sink.as_ref(), &bot).unwrap();
    assert_eq!(shown.changes[0].change.id, undone.id);
    assert_eq!(shown.changes[1].undone_by.as_deref(), Some(undone.id.as_str()));
    assert!(shown.changes[1].not_undoable.is_some() && shown.changes[0].not_undoable.is_some());
    // Neither the change again nor the undo is undone.
    assert!(undo(sink.as_ref(), &bot.id, &learned.id, OWNER, Source::of("app")).unwrap_err().to_string().contains("already undone"));
    assert!(undo(sink.as_ref(), &bot.id, &undone.id, OWNER, Source::of("app")).is_err());
    assert!(undo(sink.as_ref(), &bot.id, "no-such-change", OWNER, Source::of("app")).is_err());
}

#[test]
fn undo_holds_when_other_notes_came_after_and_refuses_when_the_line_is_gone() {
    let (_home, sink, bot) = hired();
    let first = add(sink.as_ref(), &bot, &Place::Bot, "First fact", OWNER, Source::of("app")).unwrap().remove(0);
    let second = add(sink.as_ref(), &bot, &Place::Bot, "Second fact", OWNER, Source::of("app")).unwrap().remove(0);
    undo(sink.as_ref(), &bot.id, &first.id, OWNER, Source::of("app")).unwrap();
    let memory = file(&bot, "MEMORY.md");
    assert!(!memory.contains("First fact") && memory.contains("Second fact"));

    // Forgotten by hand meanwhile: the add has nothing left to undo, and nothing is written.
    forget(sink.as_ref(), &bot, &Place::Bot, "second", OWNER, Source::of("app")).unwrap();
    let before = file(&bot, "MEMORY.md");
    let refused = undo(sink.as_ref(), &bot.id, &second.id, OWNER, Source::of("app")).unwrap_err();
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
    assert!(forget(sink.as_ref(), &bot, &Place::Bot, "ays", OWNER, Source::of("app")).unwrap_err().to_string().contains("2 notes match"));
    assert!(forget(sink.as_ref(), &bot, &Place::Bot, "nothing like it", OWNER, Source::of("app")).unwrap_err().to_string().contains("No note"));
    assert!(forget(sink.as_ref(), &bot, &Place::Bot, " ", OWNER, Source::of("app")).is_err());
    let forgot = forget(sink.as_ref(), &bot, &Place::Bot, "main stays GREEN", OWNER, Source::of("app")).unwrap().remove(0);
    assert_eq!((forgot.kind.as_str(), forgot.text.as_str()), ("forgot", "Main stays green"));
    assert!(!file(&bot, "MEMORY.md").contains("Main stays green"));
    undo(sink.as_ref(), &bot.id, &forgot.id, OWNER, Source::of("app")).unwrap();
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
    // The first look only remembers the files as they are.
    assert!(view(sink.as_ref(), &bot).unwrap().changes.is_empty());
    let memory = home_of(&bot).join("MEMORY.md");
    let original = std::fs::read_to_string(&memory).unwrap();
    std::fs::write(&memory, format!("{original}- 2026-11-01 Written by hand\n")).unwrap();
    std::fs::write(home_of(&bot).join("memory").join("phase-2.md"), "# Phase 2\n").unwrap();
    std::fs::write(home_of(&bot).join("ROLE.md"), "Changed my own role.\n").unwrap();

    let shown = view(sink.as_ref(), &bot).unwrap();
    assert_eq!(shown.changes.len(), 1);
    let outside = &shown.changes[0].change;
    assert_eq!((outside.kind.as_str(), outside.by.as_str(), outside.source.kind.as_str()), ("outside", changes::OUTSIDE, "outside"));
    let edits = outside.known_edits().unwrap();
    assert!(edits.contains(&Edit::AddLine { file: "MEMORY.md".into(), line: "- 2026-11-01 Written by hand".into(), index: Some(original.lines().count()) }));
    assert!(edits.iter().any(|edit| matches!(edit, Edit::ReplaceText { file, before: None, .. } if file == "memory/phase-2.md")));
    assert!(edits.iter().any(|edit| matches!(edit, Edit::ReplaceText { file, after: Some(after), .. } if file == "ROLE.md" && after == "Changed my own role.\n")));
    // Seen once: looking again records nothing more.
    assert_eq!(view(sink.as_ref(), &bot).unwrap().changes.len(), 1);
    // The role's own change is in its history, never silent.
    assert_eq!(view(sink.as_ref(), &bot).unwrap().role.versions[0].kind, "outside");

    undo(sink.as_ref(), &bot.id, &outside.id, OWNER, Source::of("app")).unwrap();
    assert_eq!(std::fs::read_to_string(&memory).unwrap(), original);
    assert!(!home_of(&bot).join("memory").join("phase-2.md").exists());
    assert_eq!(file(&bot, "ROLE.md"), super::super::role_text(&super::super::templates::find("cto").unwrap()));

    // A file removed outside the app is a change too.
    view(sink.as_ref(), &bot).unwrap();
    std::fs::remove_file(&memory).unwrap();
    let removed = view(sink.as_ref(), &bot).unwrap().changes[0].change.clone();
    assert_eq!(removed.kind, "outside");
    undo(sink.as_ref(), &bot.id, &removed.id, OWNER, Source::of("app")).unwrap();
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
    assert_eq!((shown.memory.read, shown.changes[0].change.kind.as_str()), (BUDGET, "outside"));

    let recorded = add(sink.as_ref(), &bot, &Place::Bot, "One more", &bot.id, chat()).unwrap();
    let kinds: Vec<&str> = recorded.iter().map(|change| change.kind.as_str()).collect();
    assert_eq!(kinds, ["learned", "archived"]);
    assert_eq!(recorded[1].source.kind, "budget");
    let now = file(&bot, "MEMORY.md");
    assert_eq!(now.lines().count(), BUDGET);
    assert!(!now.contains("The oldest") && now.contains("One more") && now.starts_with(&header));
    assert_eq!(file(&bot, "memory/archive.md"), "- 2025-01-01 The oldest\n");

    let shown = view(sink.as_ref(), &bot).unwrap();
    assert_eq!((shown.memory.read, shown.memory.places[0].archive_lines), (BUDGET, 1));
    assert!(shown.memory.topics.iter().any(|topic| topic.name == ARCHIVE_FILE && topic.place == BOT_PLACE));

    // Undoing the move puts the note back and empties the archive.
    undo(sink.as_ref(), &bot.id, &recorded[1].id, OWNER, Source::of("app")).unwrap();
    assert!(file(&bot, "MEMORY.md").contains("The oldest"));
    assert_eq!(file(&bot, "memory/archive.md"), "");
}

#[test]
fn the_budget_counts_the_bots_notes_with_its_places() {
    let (_home, sink, bot) = hired();
    let bot = with_works_in(sink.as_ref(), &bot, &["Acme", PERSONAL]);
    assert_eq!(working_place(&bot), Place::Org("Acme".into()));
    let acme = Place::parse(&bot, "Acme").unwrap();
    add(sink.as_ref(), &bot, &acme, "Kestrel ships on Tuesdays", OWNER, Source::of("app")).unwrap();
    // Each organisation has its own folder, out of reach of a look-alike name.
    let folder = acme.dir();
    assert!(folder.starts_with("orgs/acme-") && folder != Place::Org("acme".into()).dir());
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
    assert!(given.contains("Own note") && !given.contains("Personal note") && given.contains("Notes kept in Acme"), "{given}");

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
    assert!(shown.role.template_diff.as_ref().unwrap().iter().all(|line| line.kind == "same"));
    assert_eq!(shown.role.template_title.as_deref(), Some("CTO"));

    super::super::role_write(sink.as_ref(), &bot.id, "Version two.\n").unwrap();
    super::super::role_write(sink.as_ref(), &bot.id, "Version three.\n").unwrap();
    // The same text again records nothing.
    super::super::role_write(sink.as_ref(), &bot.id, "Version three.\n").unwrap();
    let shown = view(sink.as_ref(), &bot).unwrap();
    let texts: Vec<Option<&str>> = shown.role.versions.iter().map(|version| version.text.as_deref()).collect();
    assert_eq!(texts, [Some("Version three.\n"), Some("Version two.\n"), Some(template.as_str())]);
    assert_eq!(shown.role.versions[0].by, OWNER);
    assert!(shown.role.template_diff.as_ref().unwrap().iter().any(|line| line.kind == "added" && line.text == "Version three."));

    // Undo the newest change, then put back the version two changes ago, then the template's.
    let newest = shown.role.versions[0].change.clone().unwrap();
    undo(sink.as_ref(), &bot.id, &newest, OWNER, Source::of("app")).unwrap();
    assert_eq!(file(&bot, "ROLE.md"), "Version two.\n");
    let two = shown.role.versions[1].change.clone().unwrap();
    super::super::role_write(sink.as_ref(), &bot.id, "Version four.\n").unwrap();
    // Changed since: the old change is not undone over the new text.
    assert!(undo(sink.as_ref(), &bot.id, &two, OWNER, Source::of("app")).unwrap_err().to_string().contains("changed since"));
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
    assert_eq!(shown.changes[0].change.source.kind, "standup");
    assert!(shown.changes[0].not_undoable.as_deref().unwrap().contains("newer version"));
    assert!(undo(sink.as_ref(), &bot.id, "from-a-newer-build", OWNER, Source::of("app")).is_err());
    undo(sink.as_ref(), &bot.id, &learned.id, OWNER, Source::of("app")).unwrap();
    assert!(std::fs::read_to_string(&log).unwrap().starts_with(&text), "the log is only appended to");
}

#[test]
fn an_edit_never_leaves_the_home() {
    for rel in ["", "../x.md", "/etc/passwd", "a/../../b", "memory/ x.md", "memory\\x.md"] {
        assert!(changes::checked(rel).is_err(), "{rel:?}");
    }
    for rel in ["MEMORY.md", "orgs/acme-1a2b3c4d/memory/archive.md", "memory/phase-2.md"] {
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
    for operation in ["memoryView", "memoryAdd", "memoryForget", "memoryUndo", "roleRestore"] {
        assert_eq!(ask(operation, json!({"id": bot.id, "text": "x", "line": "x", "change": "x"})).unwrap_err().to_string(), super::super::OFF_MESSAGE, "{operation}");
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
    assert_eq!((shown.changes.len(), shown.changes[0].change.kind.as_str()), (1, "outside"));
    undo(sink.as_ref(), &bot.id, &shown.changes[0].change.id, OWNER, Source::of("app")).unwrap();
    assert_eq!(file(&bot, "ROLE.md"), super::super::role_text(&super::super::templates::find("cto").unwrap()));

    // A bot hired before the history existed has no start recorded: its files as hiring wrote them are the start.
    let older = super::super::create(sink.as_ref(), "watcher", "Argus").unwrap();
    std::fs::remove_file(crate::store::root().unwrap().join("bot-changes").join(&older.id).join(changes::KNOWN_FILE)).unwrap();
    std::fs::write(home_of(&older).join("MEMORY.md"), format!("{}- 2026-11-01 Written by hand\n", file(&older, "MEMORY.md"))).unwrap();
    let shown = view(sink.as_ref(), &older).unwrap();
    assert_eq!(shown.changes.len(), 1);
    assert!(shown.changes[0].change.known_edits().unwrap().iter().any(|edit| matches!(edit, Edit::AddLine { line, .. } if line.ends_with("Written by hand"))));
}

#[test]
fn the_editor_is_given_the_whole_role_never_the_part_a_conversation_reads() {
    let (_home, sink, bot) = hired();
    let long = format!("{}\n", "a line of the role that is long enough\n".repeat(2_000));
    assert!(long.len() as u64 > READ_LIMIT);
    super::super::role_write(sink.as_ref(), &bot.id, &long).unwrap();
    let shown = view(sink.as_ref(), &bot).unwrap();
    assert!(shown.role.read.over_limit && shown.role.editable);
    assert_eq!(shown.role.text, long);

    // Past what a role may be, the editor shows it but may not save it.
    std::fs::write(home_of(&bot).join("ROLE.md"), "x".repeat(super::super::MAX_ROLE_BYTES + 1)).unwrap();
    let shown = view(sink.as_ref(), &bot).unwrap();
    assert!(!shown.role.editable && shown.role.text.len() as u64 <= READ_LIMIT);
}
