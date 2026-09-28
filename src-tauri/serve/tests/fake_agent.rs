//! The fake Claude Code (`scripts/remote-runtime/fake-claude`) under the real
//! PTY-first harness of `terminalx-serve`, without a relay (PRO-22). The
//! relay end-to-end test drives agent tabs with the same fake, so this is
//! what shows the fake is faithful enough: prompts typed into the PTY,
//! the transcript it writes, and the hooks it runs all land as the
//! harness's own events.

#![cfg(unix)]

mod common;

use common::agent::{count, kinds, texts, AgentWorld, Serve};
use serde_json::json;

#[test]
fn the_fake_cli_runs_under_the_real_harness() {
    if std::process::Command::new("python3").arg("--version").output().is_err() {
        eprintln!("skipped: python3 is not installed");
        return;
    }
    let world = AgentWorld::new();
    let serve = Serve::start(world.command(), &world.data);

    // A prompt: typed into the PTY, echoed by the transcript, answered, and
    // the turn closed by the Stop hook.
    let created = serve.control(
        "sessions.create",
        json!({ "project": world.project, "agent": "claude", "prompt": "echo:hello from the fake", "useWorktree": false, "onMain": true, "mode": "manual" }),
    );
    let tab = created["tabId"].as_str().unwrap().to_string();
    let events = serve.wait_events(&tab, "the first turn", |events| count(events, "turn_completed") >= 1);
    assert_eq!(texts(&events, "user_message"), vec!["echo:hello from the fake"], "the prompt is recorded once: {:?}", kinds(&events));
    assert_eq!(texts(&events, "assistant_text"), vec!["hello from the fake"]);
    assert_eq!(serve.control("wait", json!({ "target": tab, "timeoutSeconds": 30 }))["reason"], "stop");

    // A permission: the PermissionRequest hook parks the CLI until the card is
    // answered, and the answer reaches the CLI.
    serve.control("send", json!({ "target": tab, "text": "ask:touch allowed.txt" }));
    assert_eq!(serve.control("wait", json!({ "target": tab, "timeoutSeconds": 30 }))["reason"], "permission");
    let pending = serve.control("permissions.list", json!({}))["permissions"].as_array().cloned().unwrap();
    assert_eq!(pending.len(), 1, "{pending:?}");
    assert_eq!(pending[0]["toolName"], "Bash");
    serve.control("permissions.allow", json!({ "request": pending[0]["requestId"] }));
    let events = serve.wait_events(&tab, "the allowed tool", |events| texts(events, "assistant_text").iter().any(|t| t == "allowed: touch allowed.txt"));
    assert_eq!(count(&events, "permission_requested"), 1);
    let results: Vec<_> = events.iter().filter(|e| e["payload"]["type"] == "tool_call_completed").collect();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["payload"]["result"]["text"], "ran: touch allowed.txt");
    serve.wait_events(&tab, "the second turn to close", |events| count(events, "turn_completed") >= 2);

    // A denial is carried back just as faithfully.
    serve.control("send", json!({ "target": tab, "text": "ask:rm -rf nothing" }));
    assert_eq!(serve.control("wait", json!({ "target": tab, "timeoutSeconds": 30 }))["reason"], "permission");
    let pending = serve.control("permissions.list", json!({}))["permissions"].as_array().cloned().unwrap();
    serve.control("permissions.deny", json!({ "request": pending[0]["requestId"] }));
    serve.wait_events(&tab, "the denied tool", |events| texts(events, "assistant_text").iter().any(|t| t == "denied: rm -rf nothing"));
    serve.wait_events(&tab, "the third turn to close", |events| count(events, "turn_completed") >= 3);

    // Steering: text sent mid-turn goes into the running CLI, which answers
    // it before the turn ends, and it is not recorded as a second prompt.
    serve.control("send", json!({ "target": tab, "text": "slow:6:500" }));
    serve.wait_events(&tab, "the slow turn to start", |events| texts(events, "assistant_text").iter().any(|t| t == "chunk 1 of 6"));
    let steer = serve.control("send", json!({ "target": tab, "text": "use the other file" }));
    assert_eq!(steer["outcome"]["queued"], true, "a mid-turn send is queued into the running turn");
    let events = serve.wait_events(&tab, "the steered turn", |events| count(events, "turn_completed") >= 4);
    let said = texts(&events, "assistant_text");
    assert!(said.iter().any(|t| t == "steered: use the other file"), "{said:?}");
    assert!(said.iter().any(|t| t == "chunk 6 of 6"), "{said:?}");
    let prompts = texts(&events, "user_message");
    assert_eq!(prompts.iter().filter(|t| *t == "use the other file").count(), 1, "the steer is shown once: {prompts:?}");

    // The transcript is the CLI's own file, under the isolated home.
    let transcripts = world.home.join(".claude").join("projects");
    assert!(std::fs::read_dir(&transcripts).unwrap().next().is_some(), "the fake wrote under {}", transcripts.display());
}
