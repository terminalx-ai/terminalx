//! `machine/7` (PRO-403): a machine session's Setup and Run come from the
//! machine and run there.

use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};

use super::super::machine_rig::*;
use super::super::protocol::{self, Authority};
use super::super::server::{Peer, WorkspaceRpc};

/// What a terminal printed, from its first byte.
async fn output_of(rpc: &Arc<WorkspaceRpc>, peer: &Arc<Peer>, pty_id: &str) -> String {
    let attached = call(rpc, peer, "pty.attach", json!({ "ptyId": pty_id })).await.unwrap();
    String::from_utf8_lossy(&STANDARD.decode(attached["data"].as_str().unwrap()).unwrap()).into_owned()
}

/// Saves the actions, preview and setup script the tests run on `project`.
fn save_scripts(project: &std::path::Path) {
    let action = |id: &str, command: &str, run_after_setup: bool, concurrent: bool| crate::store::projects::RepositoryActionEntry {
        id: id.into(), name: format!("{id} action"), command: command.into(), run_after_setup, concurrent, ..Default::default()
    };
    crate::store::projects::update(&project.to_string_lossy(), crate::store::projects::ProjectPatch {
        scripts: Some(crate::store::projects::RepositoryScripts { setup: "printf 'set up in %s\\n' \"$PWD\"".into(), archive: String::new(), archive_timeout_minutes: None }),
        actions: Some(vec![
            action("hello", "printf 'hello %s on %s\\n' \"$TERMINALX_ACTION_ID\" \"$TERMINALX_PORT\"; exit 3", false, false),
            action("serve", "printf serving; exec sleep 60", false, false),
            action("after", "printf after-setup", true, false),
            action("many", "printf many; exec sleep 60", false, true),
        ]),
        preview_urls: Some(vec![crate::store::projects::PreviewUrlEntry { id: "web".into(), name: "Web".into(), url: "http://localhost:$PORT".into() }]),
        ..Default::default()
    })
    .unwrap();
}

/// A session in its own worktree of `project`, inside the project's folder.
fn worktree_session(project: &std::path::Path, id: &str) -> crate::store::index::SessionEntry {
    let cwd = project.join(".worktrees").join(id);
    std::fs::create_dir_all(&cwd).unwrap();
    session(project, &cwd, id, Some(id), "main")
}

/// The project's actions and setup script are read from the machine's
/// store; each run is the machine runtime's own pane in the session's folder
/// there, with the machine's ports, listed with its session and attached as a
/// terminal. A non-concurrent action is not started twice; Restart replaces it.
#[tokio::test(flavor = "multi_thread")]
async fn a_machine_sessions_setup_and_actions_run_on_the_machine() {
    let m = machine_rpc();
    let (path, _project_id) = project(&m.path("code"), "api");
    save_scripts(&path);
    let session = worktree_session(&path, "machine-run");
    let (peer, _events, hello) = computer(&m.rpc).await;
    assert!(granted(&hello, "machine/7"), "{hello}");

    let saved = call(&m.rpc, &peer, "machine.sessionActions", json!({ "sessionId": session.id })).await.unwrap();
    let names: Vec<&str> = saved["actions"].as_array().unwrap().iter().map(|action| action["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["hello action", "serve action", "after action", "many action"], "{saved}");
    assert_eq!(saved["previewUrls"][0]["url"], "http://localhost:$PORT");
    assert_eq!(saved["setupScript"], "printf 'set up in %s\\n' \"$PWD\"");
    assert_eq!(saved["setupApplies"], true);
    assert_eq!(saved["available"], true);
    assert_eq!(saved["setup"], Value::Null, "nothing has run yet");
    let ports = saved["ports"].as_array().expect("the machine's port block").clone();
    let port = ports[0].as_u64().unwrap();

    // Setup runs on the machine, in the session's folder; its pane is listed as the session's setup, and its end starts "Run after setup".
    let rerun = call(&m.rpc, &peer, "machine.setupRerun", json!({ "sessionId": session.id })).await.unwrap();
    let pane = rerun["setup"]["paneId"].as_str().unwrap().to_string();
    let setup = listed_until(&m.rpc, &peer, "setup terminal", |terminal| terminal["run"]["kind"] == "setup").await;
    assert_eq!(setup["ptyId"], pane.as_str());
    assert_eq!(setup["sessionId"], session.id.as_str());
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let now = call(&m.rpc, &peer, "machine.sessionActions", json!({ "sessionId": session.id })).await.unwrap();
        if now["setup"]["status"] == "succeeded" {
            break;
        }
        assert!(std::time::Instant::now() < deadline, "setup did not finish: {now}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(output_of(&m.rpc, &peer, &pane).await.contains(&format!("set up in {}", std::fs::canonicalize(&session.cwd).unwrap().display())));
    assert_eq!(code(call(&m.rpc, &peer, "pty.kill", json!({ "ptyId": pane })).await), "forbidden", "setup is stopped as setup");
    let after = listed_until(&m.rpc, &peer, "Run after setup", |terminal| terminal["run"]["actionId"] == "after").await;
    assert_eq!(after["run"]["name"], "after action");

    // An action the paired computer starts: in the session's folder, with the machine's port, its exit code heard.
    let ran = call(&m.rpc, &peer, "machine.runAction", json!({ "sessionId": session.id, "actionId": "hello" })).await.unwrap();
    assert_eq!(ran["started"], true, "{ran}");
    let hello_pty = ran["run"]["ptyId"].as_str().unwrap().to_string();
    assert_eq!(ran["terminal"]["run"], json!({ "kind": "action", "actionId": "hello", "name": "hello action" }));
    assert_eq!(ran["terminal"]["control"], "you", "the person who ran it types into it");
    let exited = listed_until(&m.rpc, &peer, "hello's exit", |terminal| terminal["ptyId"] == hello_pty.as_str() && terminal["exited"] == true).await;
    assert_eq!(exited["exitCode"], 3);
    assert!(output_of(&m.rpc, &peer, &hello_pty).await.contains(&format!("hello hello on {port}")));

    // Non-concurrent: a second start shows the running one; Restart replaces it.
    let serving = call(&m.rpc, &peer, "machine.runAction", json!({ "sessionId": session.id, "actionId": "serve" })).await.unwrap();
    let first = serving["run"]["ptyId"].as_str().unwrap().to_string();
    let again = call(&m.rpc, &peer, "machine.runAction", json!({ "sessionId": session.id, "actionId": "serve" })).await.unwrap();
    assert_eq!((again["started"].clone(), again["run"]["ptyId"].clone()), (json!(false), json!(first)));
    let restarted = call(&m.rpc, &peer, "machine.runAction", json!({ "sessionId": session.id, "actionId": "serve", "restart": true })).await.unwrap();
    assert_eq!(restarted["started"], true);
    assert_ne!(restarted["run"]["ptyId"], json!(first));
    let restarted_pty = restarted["run"]["ptyId"].as_str().unwrap().to_string();
    assert!(m.terminals.is_running(&restarted_pty), "it runs in the machine's runtime");

    // Closing a run's tab ends it on the machine, and it is not listed again.
    call(&m.rpc, &peer, "pty.kill", json!({ "ptyId": restarted_pty })).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let listed = call(&m.rpc, &peer, "pty.list", json!({})).await.unwrap();
    assert!(!listed["terminals"].as_array().unwrap().iter().any(|terminal| terminal["ptyId"] == restarted_pty.as_str()), "{listed}");
    assert!(!m.terminals.is_running(&restarted_pty));

    // Not an action the machine has saved, nor a session it has.
    assert_eq!(code(call(&m.rpc, &peer, "machine.runAction", json!({ "sessionId": session.id, "actionId": "nope" })).await), "conflict");
    assert_eq!(code(call(&m.rpc, &peer, "machine.runAction", json!({ "sessionId": "no-such-session", "actionId": "hello" })).await), "not_found");
}

/// What a desktop built from main sends (PR #1198): no request id, and a
/// concurrent action started again is a second run beside the first, never a
/// replay of the first answer. Such a start is never resent after a drop.
#[tokio::test(flavor = "multi_thread")]
async fn each_start_of_a_concurrent_action_is_its_own_run() {
    let m = machine_rpc();
    let (path, _project_id) = project(&m.path("code"), "api");
    save_scripts(&path);
    let session = worktree_session(&path, "machine-twice");
    let (peer, _events, _) = computer(&m.rpc).await;
    let params = json!({ "sessionId": session.id, "actionId": "many" });
    let first = call(&m.rpc, &peer, "machine.runAction", params.clone()).await.unwrap();
    let second = call(&m.rpc, &peer, "machine.runAction", params).await.unwrap();
    assert_eq!((first["started"].clone(), second["started"].clone()), (json!(true), json!(true)));
    assert_ne!(first["run"]["ptyId"], second["run"]["ptyId"], "{first} {second}");
    let all = call(&m.rpc, &peer, "pty.list", json!({})).await.unwrap();
    let runs = all["terminals"].as_array().unwrap().iter().filter(|terminal| terminal["run"]["actionId"] == "many").count();
    assert_eq!(runs, 2, "{all}");
}

/// Reading what a session can run is anyone's who may see it; running,
/// rerunning or stopping is the manager's. A one-root runtime has none of it.
#[tokio::test(flavor = "multi_thread")]
async fn starting_a_script_is_the_managers_and_a_machines_only() {
    let m = machine_rpc();
    let (path, _project_id) = project(&m.path("code"), "api");
    save_scripts(&path);
    let session = worktree_session(&path, "machine-viewer");
    let (viewer, _events, _) = connect(&m.rpc, "viewer", Authority::Participate, vec!["machine/1", "machine/7", "pty/1", "pty/2", "session/1"]).await;
    for method in ["machine.runAction", "machine.setupRerun", "machine.setupStop"] {
        let refused = call(&m.rpc, &viewer, method, json!({ "sessionId": session.id, "actionId": "hello", "paneId": "x" })).await;
        assert_eq!(code(refused), "forbidden", "{method} is the manager's");
    }
    assert!(!m.terminals.shells().iter().any(|shell| shell.session_id == session.id), "nothing ran");
    let (older, _older_events, _) = connect(&m.rpc, "older-computer", Authority::Manage, vec!["machine/1", "pty/1", "session/1"]).await;
    assert_eq!(code(call(&m.rpc, &older, "machine.sessionActions", json!({ "sessionId": session.id })).await), "capability_not_granted");
    assert!(!protocol::served(false).contains(&"machine/7"));
}
