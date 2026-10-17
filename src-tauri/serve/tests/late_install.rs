//! An agent CLI installed after the runtime started (#496), as a cloud
//! workspace's background install does: the runtime refuses it while it is
//! missing and runs it once it is there, without a restart.

#![cfg(unix)]

mod common;

use common::agent::{count, wait_until, AgentWorld, Serve};
use serde_json::json;

#[test]
fn an_agent_installed_after_start_runs_without_a_restart() {
    if std::process::Command::new("python3").arg("--version").output().is_err() {
        eprintln!("skipped: python3 is not installed");
        return;
    }
    let world = AgentWorld::new();
    // The fake `claude` is held back; nothing else on PATH provides one.
    let held = world.bin.join("claude");
    let fake = std::fs::read_link(&held).unwrap();
    std::fs::remove_file(&held).unwrap();
    let mut command = world.command();
    command.env("PATH", format!("{}:/usr/bin:/bin", world.bin.display()));
    let serve = Serve::start(command, &world.data);
    let create = json!({ "project": world.project, "agent": "claude", "prompt": "echo:installed late", "useWorktree": false, "onMain": true, "mode": "manual" });

    let refused = serve.try_control("sessions.create", create.clone());
    assert_eq!(refused["ok"], false, "{refused}");
    assert_eq!(refused["error"]["code"], "agent_unavailable", "{refused}");

    std::os::unix::fs::symlink(fake, &held).unwrap();
    let created = wait_until("the late install to be noticed", || {
        let response = serve.try_control("sessions.create", create.clone());
        (response["ok"] == true).then(|| response["result"].clone())
    });
    let tab = created["tabId"].as_str().unwrap().to_string();
    serve.wait_events(&tab, "the first turn", |events| count(events, "turn_completed") >= 1);
}
