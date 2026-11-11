//! PRO-270 in the shipped runtime, with agents that are really running: a
//! session started from inside another records it as its parent, the lead
//! lists exactly the sessions it started, and stopping them stops their
//! agents and nothing else.

#![cfg(unix)]

mod common;

use std::collections::BTreeSet;

use common::agent::{count, wait_until, AgentWorld, Serve};
use serde_json::{json, Value};

#[test]
fn a_lead_lists_and_stops_the_workers_it_started_and_nothing_else() {
    if std::process::Command::new("python3").arg("--version").output().is_err() {
        eprintln!("skipped: python3 is not installed");
        return;
    }
    let world = AgentWorld::new();
    let serve = Serve::start(world.command(), &world.data);
    let create = |prompt: &str, worktree: bool, extra: Value| {
        let mut params = json!({ "project": world.project, "agent": "claude", "prompt": prompt, "useWorktree": worktree, "onMain": !worktree, "mode": "manual" });
        params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let created = serve.control("sessions.create", params);
        serve.wait_events(created["tabId"].as_str().unwrap(), "the session's first turn", |events| count(events, "turn_completed") >= 1);
        created
    };
    let tab = |created: &Value| created["tabId"].as_str().unwrap().to_string();
    let running = || -> BTreeSet<String> {
        serve.control("status", json!({}))["runningTabs"].as_array().unwrap().iter().map(|tab| tab["tabId"].as_str().unwrap().to_string()).collect()
    };

    // A person starts the lead; the lead starts two workers, one in a
    // worktree and one on the project's checkout. Somebody else's session
    // runs beside them.
    let lead = create("echo:lead", false, json!({}));
    assert_eq!(lead["parent"], Value::Null);
    let caller = json!({ "session": lead["sessionId"], "tab": lead["tabId"] });
    let from_lead = json!({ "sessionId": lead["sessionId"], "tabId": lead["tabId"] });
    let in_worktree = create("echo:worker one", true, json!({ "caller": caller }));
    let on_main = create("echo:worker two", false, json!({ "caller": caller }));
    let bystander = create("echo:bystander", true, json!({}));
    for worker in [&in_worktree, &on_main] {
        assert_eq!((&worker["parent"], &worker["session"]["parent"]), (&from_lead, &from_lead));
        assert_eq!(serve.control("sessions.show", json!({ "session": worker["sessionId"] }))["parent"], from_lead);
    }
    assert_eq!(serve.try_control("sessions.create", json!({ "project": world.project, "agent": "claude", "prompt": "echo:no", "useWorktree": true, "parent": "no-such-session" }))["error"]["code"], "parent_not_found");
    assert_eq!(running(), [&lead, &in_worktree, &on_main, &bystander].map(tab).into());

    // The lead's workers, each with what it runs and where.
    let listed = serve.control("sessions.children", json!({ "childrenOf": lead["sessionId"] }));
    let workers = listed["workers"].as_array().unwrap();
    assert_eq!(workers.iter().map(|row| row["sessionId"].clone()).collect::<Vec<_>>().len(), 2);
    for created in [&in_worktree, &on_main] {
        let row = workers.iter().find(|row| row["sessionId"] == created["sessionId"]).unwrap_or_else(|| panic!("{listed}"));
        assert_eq!((&row["tabId"], &row["agent"], &row["running"]), (&created["tabId"], &json!("claude"), &json!(true)));
        assert_eq!((&row["worktree"], &row["branch"], &row["path"]), (&created["worktreeName"], &created["branch"], &created["path"]));
        assert!(row["status"].is_string() && row["model"].is_string(), "{row}");
    }
    assert!(serve.control("sessions.children", json!({ "childrenOf": bystander["sessionId"] }))["workers"].as_array().unwrap().is_empty());

    // Stopping them ends the two workers' agents; the lead and the bystander run on.
    let stopped = serve.control("sessions.stop", json!({ "childrenOf": lead["sessionId"] }));
    assert_eq!(stopped["failed"], json!([]), "{stopped}");
    assert_eq!(stopped["workers"], 2);
    assert_eq!(stopped["stopped"].as_array().unwrap().iter().map(|row| row["tabId"].as_str().unwrap().to_string()).collect::<BTreeSet<_>>(), [&in_worktree, &on_main].map(tab).into());
    wait_until("only the workers to have stopped", || (running() == [&lead, &bystander].map(tab).into()).then_some(()));
    let after = serve.control("sessions.children", json!({ "childrenOf": lead["sessionId"] }));
    assert!(after["workers"].as_array().unwrap().iter().all(|row| row["running"] == false), "{after}");
    // Nothing is left to stop, and nothing was deleted or archived.
    assert_eq!(serve.control("sessions.stop", json!({ "childrenOf": lead["sessionId"] }))["stopped"], json!([]));
    assert_eq!(serve.control("sessions.list", json!({}))["sessions"].as_array().unwrap().len(), 4);

    // A stopped worker keeps its conversation: its next prompt starts it again.
    let worker = tab(&in_worktree);
    serve.control("send", json!({ "target": worker, "text": "echo:again" }));
    serve.wait_events(&worker, "the stopped worker's next turn", |events| count(events, "turn_completed") >= 2);
    assert!(running().contains(&worker));
}
