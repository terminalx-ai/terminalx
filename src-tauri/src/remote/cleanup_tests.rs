use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use serde_json::{json, Value};

use crate::pty::Terminals;
use crate::remote::protocol::{Authority, PROTOCOL};
use crate::remote::server::{Peer, WorkspaceRpc};
use crate::sink::BroadcastSink;

struct Fixture {
    _home: crate::store::TempHome,
    _dir: tempfile::TempDir,
    base: PathBuf,
    root: PathBuf,
    rpc: Arc<WorkspaceRpc>,
}

fn git(cwd: &Path, args: &[&str]) {
    let out = Command::new("git").args(["-c", "user.email=t@example.com", "-c", "user.name=t"]).args(args).current_dir(cwd).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// A workspace whose root is a clone of a remote, as a launch leaves it.
fn fixture() -> Fixture {
    let home = crate::store::temp_home();
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let seed = base.join("seed");
    std::fs::create_dir(&seed).unwrap();
    git(&seed, &["init", "-q", "-b", "main"]);
    std::fs::write(seed.join("README.md"), "hello\n").unwrap();
    git(&seed, &["add", "-A"]);
    git(&seed, &["commit", "-qm", "init"]);
    git(&base, &["clone", "-q", "--bare", "seed", "remote.git"]);
    git(&base, &["clone", "-q", "remote.git", "workspace"]);
    let root = base.join("workspace");
    let rpc = WorkspaceRpc::new(&root, 1, Arc::new(BroadcastSink::new(64)), Arc::new(Terminals::new()), None).unwrap();
    Fixture { _home: home, _dir: dir, base, root, rpc }
}

impl Fixture {
    /// A worktree with a commit that is on the remote.
    fn worktree(&self, name: &str) -> PathBuf {
        let path = PathBuf::from(crate::git::create_worktree(&self.root, name, Some("main")).unwrap().path);
        std::fs::write(path.join(format!("{name}.txt")), name).unwrap();
        git(&path, &["add", "-A"]);
        git(&path, &["commit", "-qm", name]);
        git(&path, &["push", "-q", "origin", "HEAD"]);
        path
    }
}

async fn call(rpc: &Arc<WorkspaceRpc>, peer: &Arc<Peer>, method: &str, params: Value) -> Result<Value, String> {
    let response = rpc.handle(peer, &json!({ "id": "1", "method": method, "params": params })).await;
    if response["ok"] == true { Ok(response["result"].clone()) } else { Err(response["error"]["code"].as_str().unwrap().to_string()) }
}

async fn peer(rpc: &Arc<WorkspaceRpc>, authority: Authority, want: &[&str]) -> Arc<Peer> {
    let (peer, _events) = Peer::new("device-a".into(), authority);
    call(rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": want })).await.unwrap();
    peer
}

fn candidate(scan: &Value, path: &Path) -> Value {
    scan["projects"].as_array().unwrap().iter().flat_map(|project| project["candidates"].as_array().unwrap()).find(|candidate| candidate["path"] == path.to_str().unwrap()).cloned().unwrap_or_else(|| panic!("{} is not listed", path.display()))
}

fn item(candidate: &Value) -> Value {
    json!({ "projectPath": candidate["projectPath"], "path": candidate["path"], "token": candidate["token"] })
}

#[tokio::test(flavor = "multi_thread")]
async fn only_a_manager_that_was_granted_the_clean_up_may_use_it() {
    let f = fixture();
    let viewer = peer(&f.rpc, Authority::Participate, &["cleanup/1"]).await;
    let ungranted = peer(&f.rpc, Authority::Manage, &["fs/1"]).await;
    for method in ["cleanup.scan", "cleanup.size", "cleanup.cancel", "cleanup.remove"] {
        assert_eq!(call(&f.rpc, &viewer, method, json!({ "clientRequestId": "request-0001", "items": [] })).await.unwrap_err(), "forbidden", "{method}");
        assert_eq!(call(&f.rpc, &ungranted, method, json!({})).await.unwrap_err(), "capability_not_granted", "{method}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_runtime_removes_its_own_safe_worktrees_and_never_its_root() {
    let f = fixture();
    let manager = peer(&f.rpc, Authority::Manage, &["cleanup/1"]).await;
    let safe = f.worktree("safe-one");
    let dirty = f.worktree("dirty-one");
    std::fs::write(dirty.join("wip.txt"), "wip").unwrap();

    let scan = call(&f.rpc, &manager, "cleanup.scan", json!({})).await.unwrap();
    assert_eq!(candidate(&scan, &f.root)["verdict"], "protected");
    assert_eq!(candidate(&scan, &safe)["verdict"], "eligible");
    assert_eq!(candidate(&scan, &dirty)["verdict"], "dirty");
    assert!(safe.exists(), "a scan removes nothing");

    let size = call(&f.rpc, &manager, "cleanup.size", json!({ "job": "1", "projectPath": f.root, "path": safe })).await.unwrap();
    assert!(size["bytes"].as_u64().unwrap() > 0);
    // Only worktrees are measured: not the machine's other directories.
    assert_eq!(call(&f.rpc, &manager, "cleanup.size", json!({ "job": "2", "projectPath": f.root, "path": f.base })).await.unwrap_err(), "invalid_params");

    // The root, a path outside the workspace and a path of another machine
    // are refused by the runtime itself, whatever token comes with them.
    let token = candidate(&scan, &safe)["token"].clone();
    let forged = json!([
        { "projectPath": f.root, "path": f.root, "token": candidate(&scan, &f.root)["token"], "deleteSessions": true, "acceptIgnored": true },
        { "projectPath": f.root, "path": f.base.join("seed"), "token": token },
        { "projectPath": "/Users/someone/project", "path": "/Users/someone/project/.raccoon/worktrees/x", "token": token },
        item(&candidate(&scan, &dirty)),
        item(&candidate(&scan, &safe)),
    ]);
    assert_eq!(call(&f.rpc, &manager, "cleanup.remove", json!({ "items": forged })).await.unwrap_err(), "invalid_params", "a removal carries a clientRequestId");
    let done = call(&f.rpc, &manager, "cleanup.remove", json!({ "clientRequestId": "request-0001", "items": forged })).await.unwrap();
    let outcomes: Vec<&str> = done["results"].as_array().unwrap().iter().map(|result| result["outcome"].as_str().unwrap()).collect();
    assert_eq!(outcomes, ["skipped", "skipped", "skipped", "skipped", "removed"]);
    assert!(!safe.exists() && dirty.exists() && f.root.join("README.md").exists() && f.base.join("seed/README.md").exists());

    // Sent again after a dropped connection: the first answer, not a second removal.
    let resent = call(&f.rpc, &manager, "cleanup.remove", json!({ "clientRequestId": "request-0001", "items": forged })).await.unwrap();
    assert_eq!(resent, done);
    // Asked afresh: there is nothing there any more, and nothing is done or claimed.
    let retry = call(&f.rpc, &manager, "cleanup.remove", json!({ "clientRequestId": "request-0002", "items": [forged[4]] })).await.unwrap();
    assert_eq!(retry["results"][0]["outcome"], "skipped");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_terminal_open_in_a_worktree_keeps_it() {
    let f = fixture();
    let manager = peer(&f.rpc, Authority::Manage, &["cleanup/1", "pty/1"]).await;
    let busy = f.worktree("busy-one");
    let relative = busy.strip_prefix(&f.root).unwrap().to_str().unwrap();
    let pty = call(&f.rpc, &manager, "pty.create", json!({ "clientRequestId": "request-0001", "cols": 80, "rows": 24, "cwd": relative })).await.unwrap();

    let scan = call(&f.rpc, &manager, "cleanup.scan", json!({})).await.unwrap();
    let found = candidate(&scan, &busy);
    assert_eq!(found["verdict"], "active", "{found}");
    let done = call(&f.rpc, &manager, "cleanup.remove", json!({ "clientRequestId": "request-0002", "items": [item(&found)] })).await.unwrap();
    assert_eq!(done["results"][0]["outcome"], "skipped");
    assert!(busy.exists());
    let _ = call(&f.rpc, &manager, "pty.kill", json!({ "ptyId": pty["ptyId"] })).await;
}

// ---- workspace/1: one session's worktree --------------------------------------

/// A session in the index, in a worktree of its own or in the main directory.
fn session(f: &Fixture, title: &str, worktree: Option<&str>) -> crate::store::index::SessionEntry {
    crate::session_ops::create_session_entry(crate::session_ops::NewSession {
        project_path: f.root.to_string_lossy().into_owned(),
        title: Some(title.into()),
        use_worktree: worktree.is_some(),
        base_ref: worktree.map(|_| "main".into()),
        worktree_name: worktree.map(String::from),
        on_main: worktree.is_none(),
        issue: None,
        automation: None,
        cwd: None,
        tab: Some(crate::session_ops::NewTab { harness: "claude".into(), model: "opus".into(), effort: None, permission_mode: None }),
    })
    .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn only_a_manager_that_was_granted_it_reads_or_removes_a_sessions_worktree() {
    let f = fixture();
    let viewer = peer(&f.rpc, Authority::Participate, &["workspace/1"]).await;
    let ungranted = peer(&f.rpc, Authority::Manage, &["cleanup/1"]).await;
    let held = session(&f, "held", Some("held-one"));
    for method in ["workspace.disposition", "workspace.remove"] {
        let params = json!({ "clientRequestId": "request-0001", "sessionId": held.id, "expectedSessions": [held.id] });
        assert_eq!(call(&f.rpc, &viewer, method, params.clone()).await.unwrap_err(), "forbidden", "{method}");
        assert_eq!(call(&f.rpc, &ungranted, method, params).await.unwrap_err(), "capability_not_granted", "{method}");
    }
    assert!(Path::new(&held.cwd).exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sessions_worktree_is_read_and_removed_by_its_session_and_the_main_directory_never() {
    let f = fixture();
    let manager = peer(&f.rpc, Authority::Manage, &["workspace/1"]).await;
    let main = session(&f, "in main", None);
    let done = session(&f, "done", Some("done-one"));
    let wip = session(&f, "wip", Some("wip-one"));
    std::fs::write(Path::new(&wip.cwd).join("wip.txt"), "wip").unwrap();

    // The main directory answers as such, and is never removed.
    let read = call(&f.rpc, &manager, "workspace.disposition", json!({ "sessionId": main.id })).await.unwrap();
    assert_eq!(read["disposition"]["isMain"], true);
    let refused = call(&f.rpc, &manager, "workspace.remove", json!({ "clientRequestId": "request-0001", "sessionId": main.id, "expectedSessions": [main.id] })).await;
    assert_eq!(refused.unwrap_err(), "invalid_params");
    assert!(f.root.join("README.md").exists());
    assert_eq!(call(&f.rpc, &manager, "workspace.disposition", json!({ "sessionId": "no-such-session" })).await.unwrap_err(), "not_found");

    // The quick read stays off the network and gives no verdict; the dialog's asks for one.
    let quick = call(&f.rpc, &manager, "workspace.disposition", json!({ "sessionId": done.id })).await.unwrap();
    assert_eq!((&quick["disposition"]["exists"], &quick["disposition"]["isMain"], &quick["disposition"]["uncommitted"]), (&json!(true), &json!(false), &json!(0)));
    assert_eq!(quick["disposition"]["sessionIds"], json!([done.id]));
    assert!(quick["disposition"]["landed"].is_null());
    let checked = call(&f.rpc, &manager, "workspace.disposition", json!({ "sessionId": done.id, "fetch": true })).await.unwrap();
    assert_eq!(checked["disposition"]["landed"]["safe"], true, "{checked}");

    // Not clean: one confirmation is not enough, and nothing is removed.
    let dirty = call(&f.rpc, &manager, "workspace.disposition", json!({ "sessionId": wip.id, "fetch": true })).await.unwrap();
    assert_eq!(dirty["disposition"]["landed"]["safe"], false);
    assert!(call(&f.rpc, &manager, "workspace.remove", json!({ "clientRequestId": "request-0002", "sessionId": wip.id, "expectedSessions": [wip.id] })).await.is_err());
    assert!(Path::new(&wip.cwd).exists() && crate::store::index::get(&wip.id).is_ok());
    // Nor is one whose sessions are not the ones that were shown.
    assert!(call(&f.rpc, &manager, "workspace.remove", json!({ "clientRequestId": "request-0003", "sessionId": done.id, "expectedSessions": [] })).await.is_err());
    assert!(Path::new(&done.cwd).exists());

    let removed = call(&f.rpc, &manager, "workspace.remove", json!({ "clientRequestId": "request-0004", "sessionId": done.id, "deleteBranch": true, "expectedSessions": [done.id] })).await.unwrap();
    assert_eq!(removed["deleted"], json!([done.id]));
    assert!(!Path::new(&done.cwd).exists() && crate::store::index::get(&done.id).is_err());
    // The second confirmation is for what was shown: the dirty worktree goes with its digest.
    let digest = dirty["disposition"]["landed"]["digest"].clone();
    let forced = call(&f.rpc, &manager, "workspace.remove", json!({ "clientRequestId": "request-0005", "sessionId": wip.id, "confirmedDigest": digest, "expectedSessions": [wip.id] })).await.unwrap();
    assert_eq!(forced["deleted"], json!([wip.id]));
    assert!(!Path::new(&wip.cwd).exists() && f.root.join("README.md").exists());
}
