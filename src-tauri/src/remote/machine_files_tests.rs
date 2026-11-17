//! `machine/8` (PRO-405): `fs.*` named by a session is served at that
//! session's worktree, and only when the worktree is its project's own.

use serde_json::json;

use super::super::machine_rig::*;
use super::super::protocol::Authority;

/// Worktrees in an absolute folder beside each other (Settings → worktree
/// folder): `api` has one there and one inside its folder, `web` has one
/// there. Each session reads its own worktree, by relative path, and
/// nothing else of the machine.
#[tokio::test(flavor = "multi_thread")]
async fn a_session_reads_its_own_worktree_wherever_it_is_and_nothing_else() {
    let m = machine_rpc();
    let root = m.path("code");
    let (api, api_id) = project(&root, "api");
    let (web, web_id) = project(&root, "web");
    let shared = m.path("worktrees");
    std::fs::create_dir_all(&shared).unwrap();
    let mut settings = crate::store::settings::load();
    settings.worktree_dir = shared.to_string_lossy().into_owned();
    crate::store::settings::save(&settings).unwrap();
    crate::git::run(&api, &["worktree", "add", "-q", "-b", "api-one", &shared.join("api-one").to_string_lossy()]).unwrap();
    crate::git::run(&web, &["worktree", "add", "-q", "-b", "web-one", &shared.join("web-one").to_string_lossy()]).unwrap();
    crate::git::run(&api, &["worktree", "add", "-q", "-b", "api-inside", &api.join("nested/inside").to_string_lossy()]).unwrap();
    std::fs::write(shared.join("api-one/notes.md"), "api worktree").unwrap();
    std::fs::write(shared.join("web-one/notes.md"), "web worktree").unwrap();
    std::fs::write(api.join("nested/inside/inside.md"), "inside").unwrap();
    let by_hand = m.path("elsewhere");
    std::fs::create_dir_all(&by_hand).unwrap();
    std::fs::write(by_hand.join("notes.md"), "not a worktree").unwrap();

    let outside = session(&api, &shared.join("api-one"), "s-outside", Some("api-one"), "api-one");
    let inside = session(&api, &api.join("nested/inside"), "s-inside", Some("api-inside"), "api-inside");
    let own = session(&api, &api, "s-root", None, "main");
    // A session of `api` whose folder is `web`'s worktree, or a folder no git made.
    let stolen = session(&api, &shared.join("web-one"), "s-stolen", Some("web-one"), "web-one");
    let stray = session(&api, &by_hand, "s-stray", Some("elsewhere"), "main");
    let (peer, _events, hello) = computer(&m.rpc).await;
    assert!(granted(&hello, "machine/8"), "{hello}");
    let read = |session: &str, path: &str| {
        let (rpc, peer) = (m.rpc.clone(), peer.clone());
        let params = json!({ "sessionId": session, "path": path });
        async move { call(&rpc, &peer, "fs.read", params).await }
    };

    // Rooted at the worktree: relative paths, wherever the worktree is.
    assert_eq!(read(&outside.id, "notes.md").await.unwrap()["text"], "api worktree");
    assert_eq!(read(&inside.id, "inside.md").await.unwrap()["text"], "inside");
    assert_eq!(read(&own.id, "README.md").await.unwrap()["text"], "api\n");
    let listed = call(&m.rpc, &peer, "fs.list", json!({ "sessionId": outside.id, "path": "" })).await.unwrap();
    let names: Vec<&str> = listed["entries"].as_array().unwrap().iter().filter_map(|entry| entry["name"].as_str()).collect();
    assert!(names.contains(&"notes.md"), "{listed}");
    assert!(listed["entries"].as_array().unwrap().iter().all(|entry| !entry["path"].as_str().unwrap().starts_with('/')), "paths are the worktree's own: {listed}");

    // Nothing outside it: not the neighbour worktree, not the project's folder, not the machine.
    let api_readme = api.join("README.md").to_string_lossy().into_owned();
    let web_notes = shared.join("web-one/notes.md").to_string_lossy().into_owned();
    for path in ["../web-one/notes.md", "../../code/api/README.md", api_readme.as_str(), web_notes.as_str(), "/etc/hosts"] {
        assert_eq!(code(read(&outside.id, path).await), "path_forbidden", "{path}");
    }
    assert_eq!(code(read(&inside.id, "../../README.md").await), "path_forbidden", "an inside worktree is its own root too");
    // A session whose folder is not its project's own worktree is refused whole.
    assert_eq!(code(read(&stolen.id, "notes.md").await), "path_forbidden");
    assert_eq!(code(read(&stray.id, "notes.md").await), "path_forbidden");
    assert_eq!(code(read("no-such-session", "notes.md").await), "not_found");
    // A project it names must be the session's own.
    assert_eq!(code(call(&m.rpc, &peer, "fs.read", json!({ "sessionId": outside.id, "projectId": web_id, "path": "notes.md" })).await), "invalid_params");
    assert_eq!(call(&m.rpc, &peer, "fs.read", json!({ "sessionId": outside.id, "projectId": api_id, "path": "notes.md" })).await.unwrap()["text"], "api worktree");

    // Search and watch are the worktree's, by relative path.
    let found = call(&m.rpc, &peer, "fs.search", json!({ "sessionId": outside.id, "searchId": "search-0001", "query": "worktree" })).await.unwrap();
    let hits: Vec<&str> = found["hits"].as_array().unwrap().iter().filter_map(|hit| hit["path"].as_str()).collect();
    assert_eq!(hits, vec!["notes.md"], "{found}");
    let watch = call(&m.rpc, &peer, "fs.watch", json!({ "sessionId": outside.id, "path": "" })).await.unwrap();
    assert!(watch["subscriptionId"].is_string(), "{watch}");

    // A write lands in the worktree once, and its resend is answered as the first.
    let write = json!({ "sessionId": outside.id, "path": "made.txt", "text": "one", "clientRequestId": "write-session-0001" });
    let first = call(&m.rpc, &peer, "fs.write", write.clone()).await.unwrap();
    std::fs::write(shared.join("api-one/made.txt"), "changed on the machine").unwrap();
    let again = call(&m.rpc, &peer, "fs.write", write).await.unwrap();
    assert_eq!(first, again, "answered from the first write");
    assert_eq!(std::fs::read_to_string(shared.join("api-one/made.txt")).unwrap(), "changed on the machine", "not written twice");
    assert_eq!(code(call(&m.rpc, &peer, "fs.write", json!({ "sessionId": outside.id, "path": "../web-one/x.txt", "text": "x", "clientRequestId": "write-session-0002" })).await), "path_forbidden");

    // A worktree removed is not served any more.
    crate::git::run(&api, &["worktree", "remove", "--force", &shared.join("api-one").to_string_lossy()]).unwrap();
    assert_eq!(code(read(&outside.id, "notes.md").await), "not_found");
}

/// The session scope is `machine/8`'s: a computer that did not ask for it is
/// refused it, and a participant may read but never write.
#[tokio::test(flavor = "multi_thread")]
async fn a_session_scope_needs_machine_8_and_writing_needs_manage() {
    let m = machine_rpc();
    let (api, _api_id) = project(&m.path("code"), "api");
    let own = session(&api, &api, "s-root", None, "main");
    let (older, _events, hello) = connect(&m.rpc, "older-computer", Authority::Manage, vec!["machine/1", "fs/1", "session/1"]).await;
    assert!(!granted(&hello, "machine/8"));
    assert_eq!(code(call(&m.rpc, &older, "fs.read", json!({ "sessionId": own.id, "path": "README.md" })).await), "capability_not_granted");
    let (viewer, _viewer_events, _) = connect(&m.rpc, "viewer", Authority::Participate, vec!["machine/1", "machine/8", "fs/1", "session/1"]).await;
    assert!(call(&m.rpc, &viewer, "fs.write", json!({ "sessionId": own.id, "path": "x.txt", "text": "x", "clientRequestId": "write-viewer-0001" })).await.is_err());
    assert!(!api.join("x.txt").exists());
    assert_eq!(code(call(&m.rpc, &older, "fs.read", json!({ "sessionId": 7, "path": "README.md" })).await), "invalid_params");
}
