use std::sync::Arc;

use super::*;
use crate::sink::BroadcastSink;

fn bots_on() -> (crate::store::TempHome, Arc<BroadcastSink>) {
    let home = crate::store::temp_home();
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = true;
    crate::store::settings::save(&settings).unwrap();
    (home, Arc::new(BroadcastSink::new(64)))
}

fn set_bots(on: bool) {
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = on;
    crate::store::settings::save(&settings).unwrap();
}

fn bot_chats(id: &str) -> Vec<SessionEntry> {
    index::load().unwrap().into_iter().filter(|entry| session_bot(entry).is_some_and(|bot| bot.id == id)).collect()
}

/// What a terminal launch of the chat's first tab appends, as the launch builds it.
fn launch_args(entry: &SessionEntry) -> String {
    crate::session::cli_prompt(entry, &entry.tabs[0], None, None)
}

#[test]
fn a_hire_makes_the_home_chat_in_the_bot_home_folder() {
    let (_home, sink) = bots_on();
    let mut events = sink.subscribe();
    let bot = hire(sink.as_ref(), "cto", "Atlas").unwrap();
    let chats = bot_chats(&bot.id);
    assert_eq!(chats.len(), 1);
    let chat = &chats[0];
    assert!(chat.is_quick(), "a bot's chat belongs to no project");
    assert_eq!(session_bot(chat), Some(BotRef { id: bot.id.clone(), home: true }));
    assert_eq!(chat.title, HOME_CHAT_TITLE);
    let folder = std::fs::canonicalize(super::super::home(&bot).unwrap()).unwrap();
    assert_eq!(chat.cwd, folder.to_string_lossy());
    let tab = &chat.tabs[0];
    assert_eq!((tab.harness.as_str(), tab.permission_mode.as_str()), ("claude", "bypassPermissions"));
    assert!(std::iter::from_fn(|| events.try_recv().ok()).any(|published| &*published.event == "session_created"));

    // Asked for again, it is the same chat; stored, it keeps its bot (a restart reads the same).
    assert_eq!(home_chat(sink.as_ref(), &bot.id).unwrap().id, chat.id);
    assert_eq!(index::get(&chat.id).unwrap().unknown.get(SESSION_KEY), Some(&serde_json::json!({"id": bot.id, "home": true})));

    // Another conversation is not the home chat; an archived home chat is replaced by a new one.
    let other = new_chat(sink.as_ref(), &bot.id).unwrap();
    assert_eq!(session_bot(&other), Some(BotRef { id: bot.id.clone(), home: false }));
    assert_eq!(home_chat(sink.as_ref(), &bot.id).unwrap().id, chat.id);
    index::update_session(&chat.id, |entry| {
        entry.archived = true;
        Ok(())
    })
    .unwrap();
    let again = home_chat(sink.as_ref(), &bot.id).unwrap();
    assert_ne!(again.id, chat.id);
    assert_eq!(bot_chats(&bot.id).len(), 3);
}

#[test]
fn the_runtime_call_answers_home_chat_and_new_chat_and_hires_with_a_home_chat() {
    let (_home, sink) = bots_on();
    let bot: Bot = serde_json::from_value(super::super::call(sink.as_ref(), "create", &serde_json::json!({"roleTemplateId": "watcher", "name": "Argus"})).unwrap()).unwrap();
    let home: SessionEntry = serde_json::from_value(super::super::call(sink.as_ref(), "homeChat", &serde_json::json!({"id": bot.id})).unwrap()).unwrap();
    assert_eq!(bot_chats(&bot.id).iter().map(|entry| entry.id.as_str()).collect::<Vec<_>>(), [home.id.as_str()]);
    let other: SessionEntry = serde_json::from_value(super::super::call(sink.as_ref(), "newChat", &serde_json::json!({"id": bot.id})).unwrap()).unwrap();
    assert_eq!(other.title, "Chat with Argus");
    assert!(super::super::call(sink.as_ref(), "homeChat", &serde_json::json!({"id": "nobody"})).unwrap_err().to_string().contains("No bot has the id nobody"));
    set_bots(false);
    assert_eq!(super::super::call(sink.as_ref(), "homeChat", &serde_json::json!({"id": bot.id})).unwrap_err().to_string(), super::super::OFF_MESSAGE);
}

#[test]
fn claude_and_codex_launches_are_given_the_role_the_memory_and_the_rules() {
    let (_home, sink) = bots_on();
    let bot = hire(sink.as_ref(), "cto", "Atlas").unwrap();
    super::super::role_write(sink.as_ref(), &bot.id, "Plan the work and split it into runs.\n").unwrap();
    let memory = bot_store::home_dir(&bot.id).unwrap().join(bot_store::MEMORY_FILE);
    std::fs::write(&memory, "# Memory\n\nThe owner prefers pnpm.\n").unwrap();

    let chat = home_chat(sink.as_ref(), &bot.id).unwrap();
    let claude = launch_args(&chat);
    assert_eq!(claude.matches("--append-system-prompt").count(), 1, "{claude}");
    for said in ["Plan the work and split it into runs.", "The owner prefers pnpm.", "You are Atlas, a bot with the role CTO", "words count as approval", "# First conversation", "greet them in one sentence, ask at most one question"] {
        assert!(claude.contains(said), "{said:?} is not in {claude}");
    }

    // Codex, through `developer_instructions`, the one key it keeps.
    super::super::update(sink.as_ref(), &bot.id, serde_json::from_value(serde_json::json!({"harness": "codex"})).unwrap()).unwrap();
    let codex_chat = new_chat(sink.as_ref(), &bot.id).unwrap();
    assert_eq!(codex_chat.tabs[0].harness, "codex");
    let codex = launch_args(&codex_chat);
    assert_eq!(codex.matches("developer_instructions=").count(), 1, "{codex}");
    let (flag, value) = codex.trim_start().split_once(' ').unwrap();
    assert_eq!(flag, "-c");
    let value = value.strip_prefix('\'').and_then(|value| value.strip_suffix('\'')).unwrap().replace("'\\''", "'");
    let table: toml::Table = toml::from_str(&value).unwrap();
    let text = table["developer_instructions"].as_str().unwrap();
    assert!(text.contains("Plan the work and split it into runs.") && text.contains("The owner prefers pnpm."), "{text}");
    assert!(!text.contains("# First conversation"), "only the home chat's first conversation is a first run");

    // A sparse checkout's note and the bot's join the one prompt Codex takes natively, too.
    let joined = join_notes(&[Some("Sparse folders."), launch_note(&codex_chat, &codex_chat.tabs[0]).as_deref()]).unwrap();
    assert!(joined.starts_with("Sparse folders.\n\n# Bot rules"));
    assert_eq!(join_notes(&[None, Some("  ")]), None);
}

#[test]
fn an_edited_role_reaches_the_next_conversation() {
    let (_home, sink) = bots_on();
    let bot = hire(sink.as_ref(), "watcher", "Argus").unwrap();
    let chat = home_chat(sink.as_ref(), &bot.id).unwrap();
    assert!(!launch_args(&chat).contains("Watch the nightly build only."));
    super::super::role_write(sink.as_ref(), &bot.id, "Watch the nightly build only.").unwrap();
    assert!(launch_args(&chat).contains("Watch the nightly build only."));
    // Edited by hand in the home folder, too.
    std::fs::write(bot_store::home_dir(&bot.id).unwrap().join(bot_store::ROLE_FILE), "Hand edited role.").unwrap();
    let next = launch_args(&chat);
    assert!(next.contains("Hand edited role.") && !next.contains("Watch the nightly build only."));
}

#[test]
fn only_the_first_two_hundred_lines_of_memory_are_given() {
    let (_home, sink) = bots_on();
    let bot = hire(sink.as_ref(), "cto", "Atlas").unwrap();
    let lines: Vec<String> = (1..=250).map(|n| format!("note {n}")).collect();
    std::fs::write(bot_store::home_dir(&bot.id).unwrap().join(bot_store::MEMORY_FILE), lines.join("\n")).unwrap();
    let chat = home_chat(sink.as_ref(), &bot.id).unwrap();
    let note = launch_note(&chat, &chat.tabs[0]).unwrap();
    assert!(note.contains("note 200\n") && !note.contains("note 201"), "{note}");
    assert!(note.contains("(50 more lines in MEMORY.md are not shown here.)"));
    // A memory file someone removed is an empty memory.
    std::fs::remove_file(bot_store::home_dir(&bot.id).unwrap().join(bot_store::MEMORY_FILE)).unwrap();
    assert!(launch_note(&chat, &chat.tabs[0]).unwrap().contains("first 200 lines)\n\n(empty)"));
}

#[test]
fn access_maps_to_the_permission_mode_and_the_rules() {
    assert_eq!(permission_mode(&BotAccess::Full), "bypassPermissions");
    assert_eq!(permission_mode(&BotAccess::AskOutward), "manual");
    assert_eq!(permission_mode(&BotAccess::ReadReport), "plan");
    assert_eq!(permission_mode(&BotAccess::Other("someday".into())), "plan", "a level this build does not know is read and report");

    let (_home, sink) = bots_on();
    let bot = hire(sink.as_ref(), "security-auditor", "Sentry").unwrap();
    let bot = super::super::update(sink.as_ref(), &bot.id, serde_json::from_value(serde_json::json!({"access": "readReport"})).unwrap()).unwrap();
    let chat = new_chat(sink.as_ref(), &bot.id).unwrap();
    assert_eq!(chat.tabs[0].permission_mode, "plan");
    let note = launch_note(&chat, &chat.tabs[0]).unwrap();
    assert!(note.contains("You read and report only"));
    assert!(!note.contains("paused"));
}

#[test]
fn a_paused_bot_still_answers_and_is_told_it_is_paused() {
    let (_home, sink) = bots_on();
    let bot = hire(sink.as_ref(), "cto", "Atlas").unwrap();
    super::super::pause(sink.as_ref(), &bot.id, super::super::OWNER).unwrap();
    // Its chat is there and its agent is given everything, with the pause.
    let chat = home_chat(sink.as_ref(), &bot.id).unwrap();
    let note = launch_note(&chat, &chat.tabs[0]).unwrap();
    assert!(note.contains("Your owner has paused you. Answer this conversation") && note.contains("Never resume yourself."), "{note}");
}

#[test]
fn nothing_is_added_outside_a_bot_chat_or_while_bots_are_off() {
    let (_home, sink) = bots_on();
    let bot = hire(sink.as_ref(), "cto", "Atlas").unwrap();
    let chat = home_chat(sink.as_ref(), &bot.id).unwrap();
    let mut plain = chat.clone();
    plain.unknown.remove(SESSION_KEY);
    assert_eq!(launch_note(&plain, &plain.tabs[0]), None);
    assert_eq!(launch_args(&plain), "");

    // A resumed conversation is not a first run.
    let mut resumed = chat.clone();
    resumed.tabs[0].provider_session_id = Some("conversation".into());
    assert!(!launch_note(&resumed, &resumed.tabs[0]).unwrap().contains("# First conversation"));

    set_bots(false);
    assert_eq!(launch_note(&chat, &chat.tabs[0]), None);
    assert_eq!(launch_args(&chat), "");
    set_bots(true);
    super::super::delete(sink.as_ref(), &bot.id).unwrap();
    assert_eq!(launch_note(&chat, &chat.tabs[0]), None, "a bot that is gone gives nothing");
}

#[test]
fn a_reference_this_build_cannot_read_is_none() {
    let (_home, _sink) = bots_on();
    let mut entry = index::SessionEntry {
        id: "s".into(),
        kind: Default::default(),
        project_path: "/p".into(),
        cwd: "/p".into(),
        worktree_name: None,
        branch: None,
        base_ref: None,
        worktree_base: None,
        worktree_removed: false,
        removed_workspace: None,
        issue: None,
        issue_work: Default::default(),
        automation: None,
        title: String::new(),
        created: String::new(),
        modified: String::new(),
        archived: false,
        archive: Default::default(),
        pinned: false,
        manual_status: None,
        tabs: Vec::new(),
        active_tab: None,
        link: None,
        parent: None,
        unknown: Default::default(),
    };
    entry.unknown.insert(SESSION_KEY.into(), serde_json::json!("not an object"));
    assert_eq!(session_bot(&entry), None);
    set_session_bot(&mut entry, &BotRef { id: "b".into(), home: false });
    assert_eq!(serde_json::to_value(&entry).unwrap()["bot"], serde_json::json!({"id": "b"}));
}
