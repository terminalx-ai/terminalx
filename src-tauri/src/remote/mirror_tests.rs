use std::process::Command;
use std::sync::Arc;

use serde_json::{json, Value};

use super::*;
use crate::pty::Terminals;
use crate::remote::protocol::{Authority, PROTOCOL};
use crate::remote::server::{Peer, WorkspaceRpc};
use crate::sink::BroadcastSink;

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    rpc: Arc<WorkspaceRpc>,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap().join("workspace");
    std::fs::create_dir(&root).unwrap();
    let rpc = WorkspaceRpc::new(&root, 1, Arc::new(BroadcastSink::new(64)), Arc::new(Terminals::new()), None).unwrap();
    Fixture { _dir: dir, root, rpc }
}

fn git(cwd: &Path, args: &[&str]) {
    let out = Command::new("git")
        .args(["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "init.defaultBranch=main"])
        .args(args)
        .current_dir(cwd)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

fn write(root: &Path, path: &str, content: &str) {
    let file = root.join(path);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(file, content).unwrap();
}

/// A repository at `dir` with one commit holding everything written so far.
fn repository(dir: &Path) {
    std::fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q"]);
    write(dir, "README.md", "hello\n");
    git(dir, &["add", "-A"]);
    git(dir, &["commit", "-qm", "init"]);
}

async fn call(rpc: &Arc<WorkspaceRpc>, peer: &Arc<Peer>, method: &str, params: Value) -> Result<Value, String> {
    let response = rpc.handle(peer, &json!({ "id": "1", "method": method, "params": params })).await;
    if response["ok"] == true {
        Ok(response["result"].clone())
    } else {
        Err(response["error"]["code"].as_str().unwrap().to_string())
    }
}

async fn peer(rpc: &Arc<WorkspaceRpc>, authority: Authority, want: &[&str]) -> Arc<Peer> {
    let (peer, _events) = Peer::new("device-a".into(), authority);
    call(rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": want })).await.unwrap();
    peer
}

fn paths(manifest: &Value) -> Vec<String> {
    manifest["entries"].as_array().unwrap().iter().map(|entry| entry["path"].as_str().unwrap().to_string()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn the_file_set_is_what_git_tracks_or_does_not_ignore() {
    let f = fixture();
    repository(&f.root);
    write(&f.root, ".gitignore", "node_modules/\n*.log\n");
    write(&f.root, "src/main.rs", "fn main() {}\n");
    write(&f.root, "notes/untracked.md", "new\n");
    write(&f.root, "node_modules/pkg/index.js", "ignored\n");
    write(&f.root, "debug.log", "ignored\n");
    git(&f.root, &["add", ".gitignore", "src/main.rs"]);
    // A tracked file deleted in the working tree is not there to copy.
    write(&f.root, "gone.txt", "x\n");
    git(&f.root, &["add", "gone.txt"]);
    std::fs::remove_file(f.root.join("gone.txt")).unwrap();

    let viewer = peer(&f.rpc, Authority::Participate, &["mirror/1"]).await;
    let manifest = call(&f.rpc, &viewer, "mirror.manifest", json!({})).await.unwrap();
    assert_eq!(paths(&manifest), [".gitignore", "README.md", "notes/untracked.md", "src/main.rs"]);
    assert_eq!(manifest["total"], 4);
    assert_eq!(manifest["next"], Value::Null);
    assert_eq!(manifest["truncated"], false);
    assert_eq!(manifest["repositories"][0]["repo"], ".");
    assert_eq!(manifest["repositories"][0]["branch"], "main");
    assert_eq!(manifest["repositories"][0]["head"].as_str().unwrap().len(), 40);
    let entry = &manifest["entries"][1];
    assert_eq!(entry["size"], 6);
    assert_eq!(entry["executable"], false);
    // The same `version` `fs.stat` reports, so the desktop can tell a rewrite.
    let stat = call(&f.rpc, &peer(&f.rpc, Authority::Participate, &["fs/1"]).await, "fs.stat", json!({ "path": "README.md" })).await.unwrap();
    assert_eq!(entry["version"], stat["version"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn secrets_links_and_special_entries_are_left_out_and_counted() {
    let f = fixture();
    repository(&f.root);
    // Untracked and not ignored: Git would list every one of these.
    write(&f.root, ".env", "TOKEN=1\n");
    write(&f.root, ".env.example", "TOKEN=\n");
    write(&f.root, "deploy/prod.pem", "key\n");
    write(&f.root, ".aws/credentials", "key\n");
    write(&f.root, "src/app.ts", "x\n");
    // Tracked secrets too: being committed does not make them mirrored.
    write(&f.root, ".npmrc", "//registry/:_authToken=1\n");
    git(&f.root, &["add", ".npmrc"]);
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("/etc/passwd", f.root.join("outside-link")).unwrap();
        std::os::unix::fs::symlink("src/app.ts", f.root.join("inside-link")).unwrap();
    }
    // A nested repository is one entry to Git, and not a file.
    repository(&f.root.join("vendor-copy"));

    let viewer = peer(&f.rpc, Authority::Participate, &["mirror/1"]).await;
    let manifest = call(&f.rpc, &viewer, "mirror.manifest", json!({})).await.unwrap();
    assert_eq!(paths(&manifest), [".env.example", "README.md", "src/app.ts"]);
    assert_eq!(manifest["skipped"]["secret"], 4);
    #[cfg(unix)]
    assert_eq!(manifest["skipped"]["symlink"], 2);
    assert_eq!(manifest["skipped"]["unsupported"], 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_repository_adds_its_own_exclusions() {
    let f = fixture();
    repository(&f.root);
    write(&f.root, ".terminalx-mirror-ignore", "fixtures/\n*.snap\n!keep.snap\n");
    write(&f.root, "fixtures/big.json", "{}\n");
    write(&f.root, "src/a.snap", "x\n");
    write(&f.root, "src/keep.snap", "x\n");
    write(&f.root, "src/a.ts", "x\n");
    let viewer = peer(&f.rpc, Authority::Participate, &["mirror/1"]).await;
    let manifest = call(&f.rpc, &viewer, "mirror.manifest", json!({})).await.unwrap();
    assert_eq!(paths(&manifest), [".terminalx-mirror-ignore", "README.md", "src/a.ts", "src/keep.snap"]);
    assert_eq!(manifest["skipped"]["excluded"], 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn every_repository_of_the_workspace_is_listed_under_its_directory() {
    let f = fixture();
    repository(&f.root.join("app"));
    repository(&f.root.join("lib"));
    write(&f.root, "lib/src/lib.rs", "x\n");
    // Outside any repository: not part of the file set.
    write(&f.root, "scratch.txt", "x\n");
    let viewer = peer(&f.rpc, Authority::Participate, &["mirror/1"]).await;
    let manifest = call(&f.rpc, &viewer, "mirror.manifest", json!({})).await.unwrap();
    assert_eq!(paths(&manifest), ["app/README.md", "lib/README.md", "lib/src/lib.rs"]);
    assert_eq!(manifest["repositories"].as_array().unwrap().len(), 2);

    // A workspace with no repository has nothing to mirror.
    let empty = fixture();
    write(&empty.root, "loose.txt", "x\n");
    let viewer = peer(&empty.rpc, Authority::Participate, &["mirror/1"]).await;
    let manifest = call(&empty.rpc, &viewer, "mirror.manifest", json!({})).await.unwrap();
    assert_eq!(manifest["total"], 0);
    assert_eq!(manifest["repositories"], json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_large_listing_is_paged_under_one_id_and_a_changed_one_starts_over() {
    let f = fixture();
    repository(&f.root);
    let long = "d".repeat(180);
    for index in 0..2500 {
        write(&f.root, &format!("{long}/file-{index:05}.txt"), "x");
    }
    let viewer = peer(&f.rpc, Authority::Participate, &["mirror/1"]).await;
    let first = call(&f.rpc, &viewer, "mirror.manifest", json!({})).await.unwrap();
    assert_eq!(first["total"], 2501);
    assert!(first.to_string().len() < 384 * 1024, "a page fits a relay frame");
    let id = first["manifestId"].as_str().unwrap().to_string();
    let mut all = paths(&first);
    let mut next = first["next"].clone();
    assert!(next.is_u64(), "more than one page");
    while let Some(cursor) = next.as_u64() {
        let page = call(&f.rpc, &viewer, "mirror.manifest", json!({ "manifestId": id, "cursor": cursor })).await.unwrap();
        assert_eq!(page["manifestId"], id.as_str());
        all.extend(paths(&page));
        next = page["next"].clone();
    }
    assert_eq!(all.len(), 2501);
    let mut sorted = all.clone();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted, all, "sorted, each path once");

    // Unchanged files: the same id, so the desktop knows nothing moved.
    let again = call(&f.rpc, &viewer, "mirror.manifest", json!({})).await.unwrap();
    assert_eq!(again["manifestId"], id.as_str());
    // A file changes: a new listing, and a page of the old one is refused.
    std::thread::sleep(std::time::Duration::from_millis(20));
    write(&f.root, "README.md", "changed\n");
    let changed = call(&f.rpc, &viewer, "mirror.manifest", json!({})).await.unwrap();
    assert_ne!(changed["manifestId"], id.as_str());
    assert_eq!(call(&f.rpc, &viewer, "mirror.manifest", json!({ "manifestId": id, "cursor": 1 })).await.unwrap_err(), "cursor_expired");
    assert_eq!(call(&f.rpc, &viewer, "mirror.manifest", json!({ "cursor": 5 })).await.unwrap_err(), "invalid_params");
}

#[tokio::test(flavor = "multi_thread")]
async fn it_takes_no_path_and_needs_the_capability() {
    let f = fixture();
    repository(&f.root);
    let viewer = peer(&f.rpc, Authority::Participate, &["mirror/1"]).await;
    // No parameter names a place: there is nowhere to send a local path.
    for params in [json!({ "path": "/Users/someone/mirror" }), json!({ "root": "." }), json!({ "target": "x" })] {
        assert_eq!(call(&f.rpc, &viewer, "mirror.manifest", params).await.unwrap_err(), "invalid_params");
    }
    let without = peer(&f.rpc, Authority::Participate, &["fs/1"]).await;
    assert_eq!(call(&f.rpc, &without, "mirror.manifest", json!({})).await.unwrap_err(), "capability_not_granted");
}
