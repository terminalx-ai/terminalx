//! An agent's sign-in through the runtime's own call (PRO-152): the command
//! comes from the registry, the pane belongs to no session and is no shell
//! tab, one step runs at a time, and the next step goes on in the same pane.
//! The wrapper's exit codes and install → sign-in → ready with a stubbed
//! installer are `harness::setup::tests::e2e` in the desktop crate.

#![cfg(unix)]

mod common;

use base64::Engine as _;
use common::agent::{wait_until, AgentWorld, Serve};
use serde_json::json;
use std::os::unix::fs::PermissionsExt;

/// What the pane has printed, and whether its program still runs.
fn output(serve: &Serve, id: &str) -> (String, bool) {
    let value = serve.control("runtime.pty.output", json!({ "id": id }));
    let data = value["data"].as_str().map(|data| base64::engine::general_purpose::STANDARD.decode(data).unwrap()).unwrap_or_default();
    (String::from_utf8_lossy(&data).into_owned(), value["running"].as_bool().unwrap_or(false))
}

#[test]
fn a_sign_in_runs_in_a_setup_pane_of_no_session_made_from_the_registry() {
    let world = AgentWorld::new();
    // Where the official installer puts the CLI; the fake one on PATH is held back.
    std::fs::remove_file(world.bin.join("claude")).unwrap();
    let local = world.home.join(".local/bin");
    std::fs::create_dir_all(&local).unwrap();
    // A sign-in that waits until the test lets it finish.
    std::fs::write(
        local.join("claude"),
        "#!/bin/sh\ncase \"$1 $2\" in\n  \"auth login\") echo \"stand-in sign-in\"; while [ ! -f \"$HOME/.finish\" ]; do sleep 0.1; done ;;\n  *) exit 2 ;;\nesac\n",
    )
    .unwrap();
    std::fs::set_permissions(local.join("claude"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut command = world.command();
    command.env("PATH", format!("{}:/usr/bin:/bin", world.bin.display()));
    let serve = Serve::start(command, &world.data);

    let id = "setup:claude:t1";
    let step = |id: &str, harness: &str, step: &str| json!({ "id": id, "harness": harness, "step": step, "cols": 80, "rows": 24 });
    for (params, what) in [
        (step("setup:codex:t1", "claude", "login"), "another agent's pane"),
        (step("01a0814c-40e0-7d80-b0ec-faf04b85907c:1", "claude", "login"), "a session's shell"),
        (step(id, "claude", "sh -c 'echo hi'"), "a step that is not one"),
        (step("setup:cursor:t1", "cursor", "install"), "an agent the app does not install"),
    ] {
        assert_eq!(serve.try_control("runtime.pty.agentSetup", params)["ok"], false, "{what} was accepted");
    }

    serve.control("runtime.pty.agentSetup", step(id, "claude", "login"));
    wait_until("the sign-in to start", || output(&serve, id).0.contains("stand-in sign-in").then_some(()));
    let again = serve.try_control("runtime.pty.agentSetup", step(id, "claude", "login"));
    assert_eq!(again["ok"], false, "{again}");
    assert!(again.to_string().contains("Claude Code is already being set up"), "{again}");
    // No window lists it as a shell tab of some session.
    let shells = serve.control("runtime.pty.visibleShells", json!({}));
    assert!(!shells.to_string().contains(id), "{shells}");

    std::fs::write(world.home.join(".finish"), "").unwrap();
    let (first, _) = wait_until("the sign-in to finish", || {
        let (text, running) = output(&serve, id);
        (!running).then_some((text, running))
    });
    assert!(first.contains("==> Signing in to Claude Code"), "{first}");

    // The next step runs in the place of the last, which stays above it.
    serve.control("runtime.pty.agentSetup", step(id, "claude", "login"));
    let both = wait_until("the second sign-in to finish", || {
        let (text, running) = output(&serve, id);
        (!running && text.matches("==> Signing in to Claude Code").count() == 2).then_some(text)
    });
    assert_eq!(both.matches("stand-in sign-in").count(), 2, "{both}");
    serve.control("runtime.pty.kill", json!({ "id": id }));
}
