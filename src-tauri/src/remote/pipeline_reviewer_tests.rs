//! Reviewer identity crosses RPC independently of the bounded pipeline history.
use super::*;
use crate::remote::protocol::{Authority, PROTOCOL};
use crate::sink::BroadcastSink;

async fn request(rpc: &Arc<WorkspaceRpc>, peer: &Arc<Peer>, method: &str, params: Value) -> Value {
    let response = rpc.handle(peer, &json!({ "id": "1", "method": method, "params": params })).await;
    assert_eq!(response["ok"], true, "{response}");
    response["result"].clone()
}

fn session(id: &str, root: &Path) -> index::SessionEntry {
    serde_json::from_value(json!({ "id": id, "projectPath": root, "cwd": root, "title": id, "created": index::now(), "modified": index::now() })).unwrap()
}

#[tokio::test]
async fn reviewer_rpc_survives_real_list_limits_replacement_and_history_eviction() {
    let _home = crate::store::temp_home();
    let dir = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(dir.path()).unwrap();
    let rpc = WorkspaceRpc::new(&root, 1, Arc::new(BroadcastSink::new(64)), Arc::new(Terminals::new()), None).unwrap();
    let (peer, _events) = Peer::new("desktop".into(), Authority::Manage);
    request(&rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["pipeline/1", "pipeline/2"] })).await;
    let mut pipeline: crate::issue_pipeline::Pipeline = serde_json::from_str(include_str!("../fixtures/issue_pipeline.json")).unwrap();
    pipeline.project_path = root.to_string_lossy().into_owned();
    let mut sessions = vec![session("author", &root), session("replacement", &root), session("foreign", &root.join("other"))];
    for n in 0..61 {
        pipeline.id = format!("p{n:03}");
        pipeline.created = format!("{n:03}");
        pipeline.reviewer.as_mut().unwrap().session_id = format!("r{n:03}");
        sessions.push(session(&format!("r{n:03}"), &root));
        crate::issue_pipeline::store::insert(&pipeline).unwrap();
    }
    index::save(&sessions).unwrap();
    let listed = request(&rpc, &peer, "pipeline.list", json!({})).await;
    assert_eq!(listed["pipelines"].as_array().unwrap().len(), 50);
    assert_eq!(listed["truncated"], true);
    // As a whole JSON string: the project path is in the listing too, and a
    // temporary directory's name may contain the letters (a macOS runner's
    // ends in "r0000gn").
    assert!(!listed.to_string().contains("\"r000\""));
    let identities = request(&rpc, &peer, "pipeline.reviewers", json!({})).await;
    assert_eq!(identities["sessionIds"].as_array().unwrap().len(), 61);
    assert!(identities["sessionIds"].as_array().unwrap().contains(&json!("r000")));
    // A large newest record exhausts the real 512 KiB limit before any record fits.
    pipeline.note = Some("x".repeat(600 * 1024));
    crate::issue_pipeline::store::commit(&mut pipeline).unwrap();
    let listed = request(&rpc, &peer, "pipeline.list", json!({})).await;
    assert_eq!(listed["pipelines"], json!([]));
    assert_eq!(listed["truncated"], true);
    assert_eq!(request(&rpc, &peer, "pipeline.reviewers", json!({})).await, identities);
    // Replacement and eviction happen while this desktop is disconnected.
    pipeline.reviewer.as_mut().unwrap().session_id = "replacement".into();
    crate::issue_pipeline::store::commit(&mut pipeline).unwrap();
    crate::issue_pipeline::store::set_switches(&pipeline.id, |p| p.stopped = true).unwrap();
    pipeline.note = None;
    pipeline.stopped = true;
    pipeline.reviewer.as_mut().unwrap().session_id = "foreign".into();
    for n in 0..200 {
        pipeline.id = format!("later{n}");
        crate::issue_pipeline::store::insert(&pipeline).unwrap();
    }
    assert!(crate::issue_pipeline::store::get("p060").is_err());
    let (fresh, _events) = Peer::new("new-desktop".into(), Authority::Manage);
    request(&rpc, &fresh, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["pipeline/2"] })).await;
    let identities = request(&rpc, &fresh, "pipeline.reviewers", json!({})).await;
    let ids = identities["sessionIds"].as_array().unwrap();
    assert!(ids.contains(&json!("r060")) && ids.contains(&json!("replacement")));
    assert!(!ids.contains(&json!("author")) && !ids.contains(&json!("foreign")));
}

#[tokio::test]
async fn reviewer_rpc_is_paginated_and_requires_its_capability() {
    let _home = crate::store::temp_home();
    let dir = tempfile::tempdir().unwrap();
    let root = crate::paths::canonicalize(dir.path()).unwrap();
    let rpc = WorkspaceRpc::new(&root, 1, Arc::new(BroadcastSink::new(64)), Arc::new(Terminals::new()), None).unwrap();
    let ids: Vec<_> = (0..501).map(|n| format!("r{n:03}")).collect();
    index::save(&ids.iter().map(|id| session(id, &root)).collect::<Vec<_>>()).unwrap();
    crate::store::write_json(&crate::store::root().unwrap().join("issue-pipelines.json"), &json!({ "pipelines": [], "reviewers": ids })).unwrap();
    let (peer, _events) = Peer::new("desktop".into(), Authority::Manage);
    request(&rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["pipeline/2"] })).await;
    let first = request(&rpc, &peer, "pipeline.reviewers", json!({})).await;
    assert_eq!(first["sessionIds"].as_array().unwrap().len(), 500);
    let last = request(&rpc, &peer, "pipeline.reviewers", json!({ "after": first["next"] })).await;
    assert_eq!(last["sessionIds"], json!(["r500"]));
    assert!(last["next"].is_null());
    let (old, _events) = Peer::new("old".into(), Authority::Manage);
    request(&rpc, &old, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["pipeline/1"] })).await;
    let refused = rpc.handle(&old, &json!({ "id": "2", "method": "pipeline.reviewers", "params": {} })).await;
    assert_eq!(refused["error"]["code"], "capability_not_granted");
}
