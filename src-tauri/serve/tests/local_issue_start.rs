//! The shipped feature set must read an issue and create its real pipeline.
#![cfg(unix)]
mod common;

use common::agent::{AgentWorld, Serve};
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;

#[test]
fn shipped_runtime_starts_a_github_issue_with_both_switches_on() {
    let world = AgentWorld::new();
    assert!(Command::new("git").args(["remote", "add", "origin", "https://github.com/acme/widgets.git"]).current_dir(&world.project).status().unwrap().success());
    let local_bin = world.home.join(".local/bin");
    std::fs::create_dir_all(&local_bin).unwrap();
    let gh = local_bin.join("gh");
    std::fs::write(&gh, r##"#!/bin/sh
if [ "$1 $2 $3" = "issue view 42" ]; then
  echo '{"number":42,"title":"Fix login","state":"OPEN","body":"Keep the API stable.","url":"https://github.com/acme/widgets/issues/42"}'
else
  echo 'Fixture only reads issue 42' >&2
  exit 1
fi
"##).unwrap();
    std::fs::set_permissions(&gh, std::fs::Permissions::from_mode(0o755)).unwrap();
    let mut command = world.command();
    command.args(["--runtime-kind", "local"]);
    let serve = Serve::start(command, &world.data);
    let created = serve.control("sessions.create", json!({"project":world.project,"agent":"claude","issue":"42","provider":"github","useWorktree":true}));
    assert_eq!(created["session"]["issue"]["identifier"], "#42");
    assert_eq!(created["pipeline"]["autoMerge"], true, "{created}");
    assert_eq!(created["pipeline"]["resolveConflicts"], true);
    assert_eq!(created["pipeline"]["issueBody"], "Keep the API stable.");
    assert_eq!(created["pipeline"]["author"]["sessionId"], created["sessionId"]);
    let caller = json!({"session":created["sessionId"],"tab":created["tabId"]});
    for value in [false, true] {
        let changed = serve.control("pipelines.resolveConflicts", json!({"pipeline":created["pipeline"]["id"],"value":value,"caller":caller}));
        assert_eq!(changed["pipeline"]["resolveConflicts"], value);
        let event = changed["pipeline"]["events"].as_array().unwrap().last().unwrap();
        assert_eq!(event["kind"], "resolveConflicts");
        assert_eq!(event["actor"]["sessionId"], created["sessionId"]);
    }
    let changed = serve.control("pipelines.autoMerge", json!({"pipeline":created["pipeline"]["id"],"value":false,"caller":caller}));
    assert_eq!(changed["pipeline"]["events"].as_array().unwrap().last().unwrap()["sessionId"], created["sessionId"]);
}
