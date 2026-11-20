use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::sink::BroadcastSink;

fn bots_on() -> (crate::store::TempHome, Arc<BroadcastSink>) {
    let home = crate::store::temp_home();
    set_bots(true);
    (home, Arc::new(BroadcastSink::new(64)))
}

fn set_bots(on: bool) {
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = on;
    crate::store::settings::save(&settings).unwrap();
}

/// A chat of `bot_id` as PRO-468 marks one: a quick chat whose entry carries `{"bot": {"id": …}}`.
fn chat_of(bot_id: &str, mode: &str) -> SessionEntry {
    let tab = crate::session_ops::NewTab { harness: "claude".into(), transport: Default::default(), model: String::new(), effort: None, permission_mode: Some(mode.into()) };
    let entry = crate::session_ops::create_quick_chat_entry(crate::session_ops::NewQuickChat { tab: Some(tab), ..Default::default() }).unwrap();
    index::update_session(&entry.id, |entry| {
        entry.unknown.insert("bot".into(), json!({"id": bot_id, "home": true}));
        Ok(entry.clone())
    })
    .unwrap()
}

fn set_access(sink: &BroadcastSink, id: &str, access: &str) {
    super::super::update(sink, id, serde_json::from_value(json!({"access": access})).unwrap()).unwrap();
}

fn shell(command: &str, cwd: &str) -> Value {
    json!({"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": command}, "cwd": cwd})
}

fn edit(path: &str) -> Value {
    json!({"hook_event_name": "PreToolUse", "tool_name": "Edit", "tool_input": {"file_path": path, "old_string": "a", "new_string": "b"}, "cwd": "/tmp"})
}

fn tool(name: &str, input: Value) -> Value {
    json!({"hook_event_name": "PreToolUse", "tool_name": name, "tool_input": input, "cwd": "/tmp"})
}

fn is_ask(gate: &Gate) -> bool {
    matches!(gate, Gate::Ask(_))
}

fn is_refused(gate: &Gate) -> bool {
    matches!(gate, Gate::Refuse(_))
}

/// The ticket's "done when": a change of access changes what the bot's next
/// call may do, in a chat already open. One level at a time, and back.
#[test]
fn each_access_level_gates_the_next_call_of_the_bots_chat() {
    let (_home, sink) = bots_on();
    let bot = super::super::create(sink.as_ref(), "security-auditor", "Sentry").unwrap();
    let chat = chat_of(&bot.id, launch_mode(&bot.access));
    let root = std::fs::canonicalize(crate::store::root().unwrap()).unwrap();
    let cwd = root.to_string_lossy().into_owned();
    let file = root.join("notes.md").to_string_lossy().into_owned();
    let push = shell("git push origin main", &cwd);
    let comment = shell("gh pr comment 12 --body 'Looks fine'", &cwd);
    let tests = shell("cargo test", &cwd);
    let read = shell("ls", &cwd);

    // Full access, the default: everything is the agent's own permission mode's to decide.
    assert_eq!(bot.access, BotAccess::Full);
    for call in [&push, &comment, &tests, &read, &edit(&file)] {
        assert_eq!(session_gate(&chat.id, call), Gate::Leave, "{call}");
    }

    // Ask before outward actions: works freely here, asks the owner before anything leaves.
    set_access(sink.as_ref(), &bot.id, "askOutward");
    assert!(is_ask(&session_gate(&chat.id, &push)));
    assert!(is_ask(&session_gate(&chat.id, &comment)));
    assert_eq!(session_gate(&chat.id, &tests), Gate::Leave);
    assert_eq!(session_gate(&chat.id, &edit(&file)), Gate::Leave);
    assert_eq!(session_gate(&chat.id, &read), Gate::Leave);

    // Read and report: no change, here or elsewhere; a report is asked about; reading goes ahead.
    set_access(sink.as_ref(), &bot.id, "readReport");
    assert!(is_refused(&session_gate(&chat.id, &push)));
    assert!(is_refused(&session_gate(&chat.id, &tests)), "cargo test writes target/");
    assert!(is_refused(&session_gate(&chat.id, &edit(&file))));
    assert!(is_ask(&session_gate(&chat.id, &comment)));
    if cfg!(unix) {
        assert_eq!(session_gate(&chat.id, &read), Gate::Leave, "a command that only reads");
    }
    let Gate::Refuse(reason) = session_gate(&chat.id, &edit(&file)) else { unreachable!() };
    assert!(reason.contains("Read and report") && reason.contains("did not run"), "{reason}");

    // And back to full access.
    set_access(sink.as_ref(), &bot.id, "full");
    assert_eq!(session_gate(&chat.id, &push), Gate::Leave);
}

#[test]
fn a_level_this_build_does_not_know_is_gated_as_read_and_report() {
    let someday = BotAccess::Other("someday".into());
    assert!(is_refused(&gate(&someday, &edit("/tmp/x"))));
    assert!(is_refused(&gate(&someday, &shell("git push", "/tmp"))));
    assert_eq!(launch_mode(&someday), "plan");
}

#[test]
fn access_maps_to_the_permission_mode_its_chats_launch_in() {
    assert_eq!(launch_mode(&BotAccess::Full), "bypassPermissions");
    assert_eq!(launch_mode(&BotAccess::AskOutward), "manual");
    assert_eq!(launch_mode(&BotAccess::ReadReport), "plan");
}

#[test]
fn an_access_change_names_the_chat_tabs_to_switch() {
    let (_home, sink) = bots_on();
    let bot = super::super::create(sink.as_ref(), "cto", "Atlas").unwrap();
    let other = super::super::create(sink.as_ref(), "watcher", "Argus").unwrap();
    let full = chat_of(&bot.id, "bypassPermissions");
    let planned = chat_of(&bot.id, "plan");
    let archived = chat_of(&bot.id, "bypassPermissions");
    index::update_session(&archived.id, |entry| {
        entry.archived = true;
        Ok(())
    })
    .unwrap();
    let theirs = chat_of(&other.id, "bypassPermissions");
    let plain = crate::session_ops::create_quick_chat_entry(Default::default()).unwrap();

    let switch = tabs_to_switch(&bot.id, "plan");
    assert_eq!(switch, vec![(full.id.clone(), full.tabs[0].id.clone())]);
    assert!(!switch.iter().any(|(session, _)| [&planned.id, &archived.id, &theirs.id, &plain.id].contains(&session)));
}

#[test]
fn nothing_is_gated_outside_a_bot_chat_while_bots_are_off_or_for_a_bot_that_is_gone() {
    let (_home, sink) = bots_on();
    let bot = super::super::create(sink.as_ref(), "cto", "Atlas").unwrap();
    set_access(sink.as_ref(), &bot.id, "readReport");
    let chat = chat_of(&bot.id, "plan");
    let plain = crate::session_ops::create_quick_chat_entry(Default::default()).unwrap();
    let cwd = crate::store::root().unwrap().to_string_lossy().into_owned();
    let push = shell("git push", &cwd);
    assert!(is_refused(&session_gate(&chat.id, &push)));
    assert_eq!(session_gate(&plain.id, &push), Gate::Leave);
    assert_eq!(session_gate("no-such-session", &push), Gate::Leave);

    set_bots(false);
    assert_eq!(session_gate(&chat.id, &push), Gate::Leave, "inert with the switch off");
    set_bots(true);
    super::super::delete(sink.as_ref(), &bot.id).unwrap();
    assert_eq!(session_gate(&chat.id, &push), Gate::Leave, "the chat of a bot that is gone is an ordinary chat");
}

#[test]
fn bots_that_cannot_be_read_hold_their_chats_to_read_and_report() {
    let (_home, sink) = bots_on();
    let bot = super::super::create(sink.as_ref(), "cto", "Atlas").unwrap();
    let chat = chat_of(&bot.id, "bypassPermissions");
    std::fs::write(crate::store::root().unwrap().join("bots.json"), "{ not json").unwrap();
    assert!(is_refused(&session_gate(&chat.id, &edit("/tmp/x"))));
}

/// A bot never raises its own access, changes whom it reports to or resumes
/// itself: at every level, the definitions and settings are not its to change.
#[test]
fn no_level_lets_a_bot_change_its_own_record_or_the_settings() {
    let (_home, _sink) = bots_on();
    let root = crate::store::root().unwrap();
    let bots = root.join("bots.json").to_string_lossy().into_owned();
    let settings = root.join("settings.json").to_string_lossy().into_owned();
    let home = root.join("bots").join("some-id");
    for access in [BotAccess::Full, BotAccess::AskOutward, BotAccess::ReadReport] {
        assert!(is_refused(&gate(&access, &edit(&bots))), "{access:?}");
        assert!(is_refused(&gate(&access, &tool("Write", json!({"file_path": settings, "content": "{}"})))), "{access:?}");
        // Relative to its home folder, too.
        let relative = json!({"tool_name": "Edit", "tool_input": {"file_path": "../../bots.json"}, "cwd": home.to_string_lossy()});
        assert!(is_refused(&gate(&access, &relative)), "{access:?}");
        assert!(is_refused(&gate(&access, &shell(&format!("sed -i '' 's/readReport/full/' {bots}"), "/tmp"))), "{access:?}");
        assert!(is_refused(&gate(&access, &shell(&format!("echo '[]' > {bots}"), "/tmp"))), "{access:?}");
    }
    // Its own memory, in its home folder, is its to write; so is another project's settings.json.
    let memory = home.join("MEMORY.md").to_string_lossy().into_owned();
    assert_eq!(gate(&BotAccess::Full, &edit(&memory)), Gate::Leave);
    assert_eq!(gate(&BotAccess::Full, &edit("/work/app/.vscode/settings.json")), Gate::Leave);
    assert_eq!(gate(&BotAccess::Full, &tool("Read", json!({"file_path": bots}))), Gate::Leave);
}

#[test]
fn outward_calls_are_found_as_a_shell_would_run_them() {
    let ask = BotAccess::AskOutward;
    let asks = |command: &str| is_ask(&gate(&ask, &shell(command, "/tmp")));
    for command in [
        "git -C ../other push",
        "sh -c 'gh pr merge 12 --squash'",
        "env GH_TOKEN=x gh pr create --fill",
        "npm publish",
        "gh pr comment 3 -b hi",
        "gh issue create --title t",
        "gh pr review 3 --approve",
        "gh pr close 3",
        "gh release create v1",
        "gh api -X POST repos/o/r/issues",
        "gh api repos/o/r/issues -f title=x",
        "curl -XPOST https://example.com",
        "curl --data '{}' https://example.com",
        "curl -d a=b https://example.com",
        "wget --post-data=a https://example.com",
        "ssh host uptime",
        "rsync -a dist/ host:/srv/",
        "cd x && git push",
        "echo \"$(git push)\"",
    ] {
        assert!(asks(command), "{command}");
    }
    for command in ["git status", "git commit -m 'do not git push yet'", "gh pr view 3", "gh pr list", "gh api repos/o/r/pulls", "curl https://example.com", "curl -X GET https://example.com", "rsync -a a/ b/", "cargo build", "terminalx sessions list", "terminalx runs create --plan p"] {
        assert!(!asks(command), "{command}");
    }
    // Codex gives a command as its words.
    let codex = json!({"tool_name": "exec_command", "tool_input": {"command": ["bash", "-lc", "git push origin HEAD"]}, "cwd": "/tmp"});
    assert!(is_ask(&gate(&ask, &codex)));
    // A connected server's tool: one that reads by its name goes ahead; anything else may post.
    assert!(is_ask(&gate(&ask, &tool("mcp__slack__post_message", json!({"text": "hi"})))));
    assert!(is_ask(&gate(&ask, &tool("mcp__linear__create_comment", json!({})))));
    assert_eq!(gate(&ask, &tool("mcp__linear__list_issues", json!({}))), Gate::Leave);
    assert_eq!(gate(&ask, &tool("mcp__github__get_pull_request", json!({}))), Gate::Leave);
    assert_eq!(gate(&ask, &tool("WebFetch", json!({"url": "https://example.com"}))), Gate::Leave);

    // Read and report refuses a change elsewhere and asks before a report.
    let read = BotAccess::ReadReport;
    assert!(is_refused(&gate(&read, &tool("mcp__github__merge_pull_request", json!({})))));
    assert!(is_ask(&gate(&read, &tool("mcp__slack__post_message", json!({})))));
    assert_eq!(gate(&read, &tool("mcp__linear__get_issue", json!({}))), Gate::Leave);
    assert!(is_refused(&gate(&read, &tool("NotebookEdit", json!({"notebook_path": "/tmp/n.ipynb"})))));
    assert!(is_refused(&gate(&read, &shell("rm -rf build", "/tmp"))));
    assert_eq!(gate(&read, &tool("Grep", json!({"pattern": "x"}))), Gate::Leave);
}

#[test]
fn only_the_owners_allow_lets_a_claude_call_go_ahead() {
    let allow = crate::harness::claude::pty::permission_decision(true, None, vec![]);
    let deny = crate::harness::claude::pty::permission_decision(false, None, vec![]);
    assert_eq!(claude_answer(Some(&allow))["hookSpecificOutput"]["permissionDecision"], "allow");
    for answer in [claude_answer(Some(&deny)), claude_answer(None), claude_answer(Some(&json!({})))] {
        assert_eq!(answer["hookSpecificOutput"]["hookEventName"], "PreToolUse");
        assert_eq!(answer["hookSpecificOutput"]["permissionDecision"], "deny");
    }
}
