//! PRO-353: `terminalx-serve update` (and the installer run again) puts the
//! new runtime in place by the runtime's own handover (#765), never by
//! restarting the service: an agent in the middle of a turn keeps running,
//! in the same process, and finishes its turn.
#![cfg(unix)]

mod common;

use std::path::Path;

use common::agent::{count, texts, wait_until, AgentWorld, Serve};
use raccoon_lib::serve_cli::handover::{hand_over, Outcome};
use serde_json::{json, Value};

#[test]
fn an_update_hands_the_running_runtime_over_and_its_agent_finishes_its_turn() {
    if std::process::Command::new("python3").arg("--version").output().is_err() {
        eprintln!("skipped: python3 is not installed");
        return;
    }
    let world = AgentWorld::new();
    let binary = Path::new(env!("CARGO_BIN_EXE_terminalx-serve"));
    // No runtime yet: nothing to hand over; the service starts the new one.
    assert_eq!(hand_over(&world.data, binary, "9.9.9").unwrap(), Outcome::NotRunning);

    let serve = Serve::start(world.command(), &world.data);
    let before = serve.control("status", json!({}));
    let version = before["localRuntime"]["version"].as_str().unwrap().to_string();
    // The same version runs already: nothing to do.
    assert_eq!(hand_over(&world.data, binary, &version).unwrap(), Outcome::Current);

    let created = serve.control("sessions.create", json!({
        "project": world.project, "agent": "claude", "prompt": "slow:60:400", "useWorktree": false, "onMain": true, "mode": "manual",
    }));
    let tab = created["tabId"].as_str().unwrap().to_string();
    serve.wait_events(&tab, "the long turn to start", |events| texts(events, "assistant_text").iter().any(|text| text == "chunk 2 of 60"));
    let pane = format!("tab:{tab}");
    let agent_pid = serve.control("runtime.pty.output", json!({ "id": pane }))["pid"].clone();
    assert!(agent_pid.is_u64());

    // A version other than the running one's: `update` hands over to the
    // binary it installed (here this same build, which the runtime accepts).
    assert_eq!(count(&serve.events(&tab), "turn_completed"), 0, "the turn is under way at the handover");
    assert_eq!(hand_over(&world.data, binary, "9.9.9").unwrap(), Outcome::HandedOver);
    assert_eq!(count(&serve.events(&tab), "turn_completed"), 0, "the turn was still under way when the new runtime took over");
    let after: Value = wait_until("the runtime that took over", || {
        let status = serve.try_control("status", json!({}));
        (status["ok"] == true && status["result"]["localRuntime"]["epoch"] != before["localRuntime"]["epoch"]).then(|| status["result"].clone())
    });
    assert_eq!(after["pid"], before["pid"], "the same process: the service manager sees the same service");
    assert_eq!(serve.control("runtime.pty.output", json!({ "id": pane }))["pid"], agent_pid, "the agent was not restarted");
    let events = serve.wait_events(&tab, "the turn to end after the handover", |events| count(events, "turn_completed") >= 1);
    assert!(texts(&events, "assistant_text").iter().any(|text| text == "chunk 60 of 60"), "the turn finished: {:?}", texts(&events, "assistant_text"));
}
