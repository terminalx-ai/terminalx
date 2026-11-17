//! A machine session's cost, Continue in a new tab and Fix check errors
//! (`machine/10`, PRO-408), and its worktree's removal (`workspace/1`,
//! PRO-406), over the machine's protocol.

use std::path::{Path, PathBuf};

use serde_json::json;

use super::super::machine_rig::*;
use super::super::protocol::Authority;
use crate::store::index;

fn git(dir: &Path, args: &[&str]) {
    crate::git::run(dir, args).unwrap();
}

/// `project` with its README committed on `main`, so a worktree can be cut from it.
fn committed(m: &Machine, name: &str) -> (PathBuf, String) {
    let (path, id) = project(&m.path("code"), name);
    git(&path, &["add", "README.md"]);
    git(&path, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "readme"]);
    (path, id)
}

/// `session.usage` reports the totals the machine keeps for its tabs,
/// `session.prepareContinuation` a tab's context with the machine's own paths,
/// and `session.checkFailures` refuses what it cannot read before running `gh`.
#[tokio::test(flavor = "multi_thread")]
async fn a_machine_session_reports_its_usage_and_continuation_on_the_machine() {
    let m = machine_rpc();
    let (path, id) = project(&m.path("code"), "api");
    let (peer, _events, hello) = computer(&m.rpc).await;
    assert!(granted(&hello, "machine/10"), "{hello}");
    let made = call(&m.rpc, &peer, "session.create", json!({ "agent": "claude", "model": "opus", "title": "Usage", "projectId": id, "clientRequestId": "create-usage" }))
        .await
        .unwrap();
    let session_id = made["sessionId"].as_str().unwrap().to_string();
    let tab_id = made["session"]["tabs"][0]["id"].as_str().unwrap().to_string();
    let row = crate::session_usage::ModelUsage { model: "claude-opus-4-5".into(), input_tokens: 1200, output_tokens: 300, cache_read_tokens: 5000, cache_write_tokens: 0, cost_usd: Some(0.42) };
    index::update_session(&session_id, |session| {
        session.tab_mut(&tab_id).unwrap().usage = Some(crate::session_usage::TabUsage { models: vec![row.clone()], updated: index::now() });
        Ok(())
    })
    .unwrap();

    let usage = call(&m.rpc, &peer, "session.usage", json!({ "sessionId": session_id })).await.unwrap();
    assert_eq!(usage["usage"]["sessionId"], json!(session_id), "{usage}");
    assert_eq!(usage["usage"]["models"][0]["model"], "claude-opus-4-5", "{usage}");
    assert_eq!(usage["usage"]["total"]["costUsd"], json!(0.42), "{usage}");
    assert_eq!(usage["usage"]["tabs"][0]["tabId"], json!(tab_id), "{usage}");
    assert!(usage["loginMethods"].as_object().unwrap().contains_key("claude"), "each agent with usage is named: {usage}");
    assert!(usage["windows"].is_array(), "{usage}");
    // The listed session carries the totals too, for the header's chip.
    let listed = call(&m.rpc, &peer, "session.get", json!({ "sessionId": session_id })).await.unwrap();
    assert_eq!(listed["session"]["tabs"][0]["usage"]["models"][0]["costUsd"], json!(0.42), "{listed}");
    assert!(listed["session"]["tabs"][0].get("accountLabel").is_none(), "one account: no label: {listed}");

    // What the tab said, as the machine's own app log keeps it: the context a new tab starts from.
    let event = |text: &str, role: &str| json!({ "id": "e", "seq": 1, "ts": "now", "sessionId": session_id, "tabId": tab_id, "harness": "claude",
        "payload": { "type": role, "text": text, "images": [], "queued": false, "block": { "messageId": "m", "index": 0 } } }).to_string();
    let log = crate::store::log_path(&session_id, &tab_id).unwrap();
    std::fs::create_dir_all(log.parent().unwrap()).unwrap();
    std::fs::write(&log, format!("{}\n{}\n", event("Add the usage chip", "user_message"), event("The chip reads usage on the machine", "assistant_text"))).unwrap();
    let context = call(&m.rpc, &peer, "session.prepareContinuation", json!({ "sessionId": session_id, "tabId": tab_id })).await.unwrap();
    assert_eq!(context["lastPrompt"], "Add the usage chip", "{context}");
    assert_eq!(context["lastUpdate"], "The chip reads usage on the machine", "{context}");
    assert_eq!(context["tabId"], json!(tab_id), "{context}");
    assert_eq!(context["provider"], "claude", "{context}");
    assert_eq!(context["cwd"], json!(path), "the machine's own folder: {context}");
    assert_eq!(code(call(&m.rpc, &peer, "session.prepareContinuation", json!({ "sessionId": session_id, "tabId": "tab-nope" })).await), "not_found");
    assert_eq!(code(call(&m.rpc, &peer, "session.usage", json!({ "sessionId": "session-nope" })).await), "not_found");

    // Never a URL `gh` would read as something else, nor a tab the session lacks.
    assert_eq!(code(call(&m.rpc, &peer, "session.checkFailures", json!({ "sessionId": session_id, "tabId": tab_id, "prUrl": "file:///etc/passwd", "clientRequestId": "checks-0001" })).await), "invalid_params");
    assert_eq!(code(call(&m.rpc, &peer, "session.checkFailures", json!({ "sessionId": session_id, "tabId": "tab-nope", "prUrl": "https://github.com/acme/api/pull/1", "clientRequestId": "checks-0002" })).await), "not_found");
    // A resend is answered as the first was, never read again.
    assert_eq!(code(call(&m.rpc, &peer, "session.checkFailures", json!({ "sessionId": session_id, "tabId": tab_id, "prUrl": "https://github.com/acme/api/pull/1", "clientRequestId": "checks-0001" })).await), "invalid_params");
    assert_eq!(code(call(&m.rpc, &peer, "session.checkFailures", json!({ "sessionId": session_id, "tabId": tab_id, "prUrl": "https://github.com/acme/api/pull/1" })).await), "invalid_params", "it carries its request id");

    // A participant reads no logs; a computer that did not ask for machine/10 reads nothing of it.
    let (viewer, _viewer_events, _) = connect(&m.rpc, "viewer", Authority::Participate, vec!["machine/1", "machine/10"]).await;
    assert!(call(&m.rpc, &viewer, "session.checkFailures", json!({ "sessionId": session_id, "tabId": tab_id, "prUrl": "https://github.com/acme/api/pull/1", "clientRequestId": "checks-0003" })).await.is_err());
    let (older, _older_events, _) = connect(&m.rpc, "older-computer", Authority::Manage, vec!["machine/1", "session/1"]).await;
    assert_eq!(code(call(&m.rpc, &older, "session.usage", json!({ "sessionId": session_id })).await), "capability_not_granted");
}

/// PRO-406: a machine session's worktree is removed on the machine through
/// the one checked removal every local entry point uses
/// (`session_ops::remove_workspace_fallible`): uncommitted work or commits no
/// other branch has keep it unless the person confirmed exactly what was
/// shown, and the project's own folder is never removed.
#[tokio::test(flavor = "multi_thread")]
async fn a_machine_sessions_worktree_is_removed_on_the_machine_only_when_safe_or_confirmed() {
    let m = machine_rpc();
    let (path, id) = committed(&m, "api");
    let (peer, _events, hello) = computer(&m.rpc).await;
    assert!(granted(&hello, "workspace/1"), "{hello}");
    let create = |title: &str, request: &str| {
        let (rpc, peer) = (m.rpc.clone(), peer.clone());
        let params = json!({ "agent": "claude", "model": "opus", "title": title, "projectId": id, "useWorktree": true, "clientRequestId": request });
        async move { call(&rpc, &peer, "session.create", params).await.unwrap() }
    };
    let dirty = create("Dirty", "create-dirty-0001").await;
    let ahead = create("Ahead", "create-ahead-0001").await;
    let dirty_id = dirty["sessionId"].as_str().unwrap().to_string();
    let ahead_id = ahead["sessionId"].as_str().unwrap().to_string();
    let dirty_cwd = PathBuf::from(dirty["session"]["cwd"].as_str().unwrap());
    let ahead_cwd = PathBuf::from(ahead["session"]["cwd"].as_str().unwrap());
    std::fs::write(dirty_cwd.join("wip.txt"), "uncommitted").unwrap();
    std::fs::write(ahead_cwd.join("done.txt"), "committed, never pushed").unwrap();
    git(&ahead_cwd, &["add", "done.txt"]);
    git(&ahead_cwd, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "work"]);

    for (session_id, cwd, request, what) in [(&dirty_id, &dirty_cwd, "remove-dirty-0001", "uncommitted"), (&ahead_id, &ahead_cwd, "remove-ahead-0001", "unpushed")] {
        let shown = call(&m.rpc, &peer, "workspace.disposition", json!({ "sessionId": session_id, "fetch": true })).await.unwrap();
        assert_eq!(shown["disposition"]["landed"]["safe"], false, "{what}: {shown}");
        assert!(shown["disposition"][what].as_u64().unwrap() > 0, "{what}: {shown}");
        let refused = call(&m.rpc, &peer, "workspace.remove", json!({ "sessionId": session_id, "expectedSessions": [session_id], "clientRequestId": request })).await;
        let (_, message) = refused.expect_err("one confirmation is not enough");
        assert!(message.starts_with(crate::session_ops::NEEDS_CONFIRMATION), "{what}: {message}");
        assert!(cwd.exists() && index::get(session_id).is_ok(), "{what}: nothing was removed");
        // The second confirmation counts for what the dialog showed, on the machine.
        let digest = shown["disposition"]["landed"]["digest"].clone();
        let removed = call(&m.rpc, &peer, "workspace.remove", json!({ "sessionId": session_id, "expectedSessions": [session_id], "confirmedDigest": digest, "clientRequestId": format!("{request}-confirmed") })).await.unwrap();
        assert_eq!(removed["deleted"], json!([session_id]), "{what}: {removed}");
        assert!(!cwd.exists() && index::get(session_id).is_err(), "{what}: removed with its session");
    }
    assert!(path.join("README.md").exists(), "the project's folder stays");

    // A session in the project's own folder has no worktree to remove, and a participant removes nothing.
    let main = call(&m.rpc, &peer, "session.create", json!({ "agent": "claude", "projectId": id, "clientRequestId": "create-main-0001" })).await.unwrap();
    let main_id = main["sessionId"].as_str().unwrap().to_string();
    assert_eq!(code(call(&m.rpc, &peer, "workspace.remove", json!({ "sessionId": main_id, "expectedSessions": [main_id], "clientRequestId": "remove-main-0001" })).await), "invalid_params");
    let kept = create("Kept", "create-kept-0001").await;
    let kept_id = kept["sessionId"].as_str().unwrap().to_string();
    let (viewer, _viewer_events, _) = connect(&m.rpc, "viewer", Authority::Participate, vec!["machine/1", "workspace/1", "session/1"]).await;
    assert!(call(&m.rpc, &viewer, "workspace.remove", json!({ "sessionId": kept_id, "expectedSessions": [kept_id], "clientRequestId": "remove-viewer-0001" })).await.is_err());
    assert!(PathBuf::from(kept["session"]["cwd"].as_str().unwrap()).exists());
}
