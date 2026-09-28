use std::sync::Arc;

use base64::engine::general_purpose::STANDARD;
use serde_json::{json, Value};

use super::*;
use crate::pty::Terminals;
use crate::remote::protocol::{Authority, PROTOCOL};
use crate::remote::server::{Notifications, Peer, WorkspaceRpc};
use crate::sink::BroadcastSink;

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    rpc: Arc<WorkspaceRpc>,
}

impl Fixture {
    fn rpc_files(&self) -> Arc<WorkspaceFiles> {
        self.rpc.files_for_tests()
    }
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap().join("workspace");
    std::fs::create_dir(&root).unwrap();
    let rpc = WorkspaceRpc::new(&root, 1, Arc::new(BroadcastSink::new(64)), Arc::new(Terminals::new()), None).unwrap();
    Fixture { _dir: dir, root, rpc }
}

async fn call(rpc: &Arc<WorkspaceRpc>, peer: &Arc<Peer>, method: &str, params: Value) -> Result<Value, String> {
    let response = rpc.handle(peer, &json!({ "id": "1", "method": method, "params": params })).await;
    if response["ok"] == true {
        Ok(response["result"].clone())
    } else {
        Err(response["error"]["code"].as_str().unwrap().to_string())
    }
}

async fn peer(rpc: &Arc<WorkspaceRpc>, device: &str, authority: Authority) -> (Arc<Peer>, Notifications) {
    let (peer, events) = Peer::new(device.into(), authority);
    call(rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["fs/1"] })).await.unwrap();
    (peer, events)
}

/// Read a whole file part by part, as the desktop client does.
async fn read_all(rpc: &Arc<WorkspaceRpc>, peer: &Arc<Peer>, path: &str) -> Result<(Vec<u8>, Value), String> {
    let first = call(rpc, peer, "fs.read", json!({ "path": path })).await?;
    let mut bytes = match first.get("text") {
        Some(text) => text.as_str().unwrap().as_bytes().to_vec(),
        None => STANDARD.decode(first["dataB64"].as_str().unwrap()).unwrap(),
    };
    let mut eof = first["eof"].as_bool().unwrap();
    while !eof {
        let part = call(rpc, peer, "fs.read", json!({ "path": path, "offset": bytes.len(), "version": first["version"] })).await?;
        assert!(part.get("etag").is_none(), "only the first part is hashed");
        bytes.extend(STANDARD.decode(part["dataB64"].as_str().unwrap()).unwrap());
        eof = part["eof"].as_bool().unwrap();
    }
    Ok((bytes, first))
}

fn pattern(size: usize) -> Vec<u8> {
    (0..size).map(|index| (index % 251) as u8).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn large_files_are_read_in_bounded_parts_under_one_version() {
    let f = fixture();
    let (manager, _events) = peer(&f.rpc, "device-a", Authority::Manage).await;
    let content = pattern(PART_BYTES * 2 + 1234);
    std::fs::write(f.root.join("blob.bin"), &content).unwrap();

    let (bytes, first) = read_all(&f.rpc, &manager, "blob.bin").await.unwrap();
    assert_eq!(bytes, content);
    assert_eq!(first["etag"], etag(&content));
    assert_eq!(first["binary"], true);
    assert_eq!(first["size"], content.len());
    // Every part fits the relay frame once base64'd twice.
    let part = call(&f.rpc, &manager, "fs.read", json!({ "path": "blob.bin", "offset": 0 })).await.unwrap();
    assert!(STANDARD.encode(part.to_string()).len() < 1024 * 1024);

    // Rewritten between parts: the next part refuses to mix versions.
    std::fs::write(f.root.join("blob.bin"), pattern(PART_BYTES * 2 + 99)).unwrap();
    let stale = call(&f.rpc, &manager, "fs.read", json!({ "path": "blob.bin", "offset": PART_BYTES, "version": first["version"] })).await;
    assert_eq!(stale.unwrap_err(), "conflict");

    // Over the ceiling: refused, not truncated.
    let huge = std::fs::File::create(f.root.join("huge.bin")).unwrap();
    huge.set_len(MAX_FILE_BYTES + 1).unwrap();
    assert_eq!(call(&f.rpc, &manager, "fs.read", json!({ "path": "huge.bin" })).await.unwrap_err(), "too_large");
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_say_what_a_file_is() {
    let f = fixture();
    let (participant, _events) = peer(&f.rpc, "device-p", Authority::Participate).await;
    std::fs::write(f.root.join("notes.md"), "# hello\n").unwrap();
    std::fs::write(f.root.join("logo.png"), [0x89, b'P', b'N', b'G', 0, 0, 0, 13]).unwrap();
    std::fs::write(f.root.join("latin1.txt"), [b'c', b'a', b'f', 0xe9]).unwrap();

    let text = call(&f.rpc, &participant, "fs.read", json!({ "path": "notes.md" })).await.unwrap();
    assert_eq!(text["text"], "# hello\n");
    assert_eq!(text["binary"], false);
    assert_eq!(text["mediaType"], Value::Null);

    let image = call(&f.rpc, &participant, "fs.read", json!({ "path": "logo.png" })).await.unwrap();
    assert_eq!(image["binary"], true);
    assert_eq!(image["mediaType"], "image/png");
    assert!(image.get("text").is_none());

    // Not UTF-8 but not binary either: bytes, for the client to decode or refuse.
    let latin1 = call(&f.rpc, &participant, "fs.read", json!({ "path": "latin1.txt" })).await.unwrap();
    assert_eq!(STANDARD.decode(latin1["dataB64"].as_str().unwrap()).unwrap(), [b'c', b'a', b'f', 0xe9]);

    let listing = call(&f.rpc, &participant, "fs.list", json!({})).await.unwrap();
    let logo = listing["entries"].as_array().unwrap().iter().find(|entry| entry["name"] == "logo.png").unwrap();
    assert_eq!(logo["mediaType"], "image/png");
    assert_eq!(logo["path"], "logo.png");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_edit_between_read_and_save_is_a_conflict_not_a_lost_write() {
    let f = fixture();
    let (editor, _events) = peer(&f.rpc, "device-a", Authority::Manage).await;
    std::fs::write(f.root.join("main.rs"), "fn main() {}\n").unwrap();
    let opened = call(&f.rpc, &editor, "fs.read", json!({ "path": "main.rs" })).await.unwrap();

    // The agent in the workspace edits the same file meanwhile.
    std::fs::write(f.root.join("main.rs"), "fn main() { agent(); }\n").unwrap();

    let save = json!({ "path": "main.rs", "text": "fn main() { mine(); }\n", "expectedEtag": opened["etag"], "clientRequestId": "save-00000001" });
    assert_eq!(call(&f.rpc, &editor, "fs.write", save).await.unwrap_err(), "conflict");
    assert_eq!(std::fs::read_to_string(f.root.join("main.rs")).unwrap(), "fn main() { agent(); }\n");

    // Resolved explicitly: overwrite against the version now on disk.
    let current = call(&f.rpc, &editor, "fs.stat", json!({ "path": "main.rs" })).await.unwrap();
    let save = json!({ "path": "main.rs", "text": "fn main() { mine(); }\n", "expectedEtag": current["etag"], "clientRequestId": "save-00000002" });
    let saved = call(&f.rpc, &editor, "fs.write", save).await.unwrap();
    assert_eq!(saved["etag"], etag(b"fn main() { mine(); }\n"));
    assert!(saved["version"].is_string());
}

#[tokio::test(flavor = "multi_thread")]
async fn large_writes_are_staged_outside_the_workspace_then_committed_at_once() {
    let f = fixture();
    let (manager, _events) = peer(&f.rpc, "device-a", Authority::Manage).await;
    let (participant, _events) = peer(&f.rpc, "device-p", Authority::Participate).await;
    let content = pattern(PART_BYTES + 4000);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(f.root.join("run.sh"), "old").unwrap();
        std::fs::set_permissions(f.root.join("run.sh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    #[cfg(not(unix))]
    std::fs::write(f.root.join("run.sh"), "old").unwrap();

    let part = |offset: usize, id: &str| {
        json!({
            "uploadId": "upload-0001",
            "offset": offset,
            "dataB64": STANDARD.encode(&content[offset..(offset + PART_BYTES).min(content.len())]),
            "clientRequestId": id,
        })
    };
    assert_eq!(call(&f.rpc, &participant, "fs.writePart", part(0, "part-00000000")).await.unwrap_err(), "forbidden");
    // Inline content is one part at most.
    let inline = json!({ "path": "run.sh", "dataB64": STANDARD.encode(&content), "clientRequestId": "write-0000000" });
    assert_eq!(call(&f.rpc, &manager, "fs.write", inline).await.unwrap_err(), "too_large");

    let first = call(&f.rpc, &manager, "fs.writePart", part(0, "part-00000001")).await.unwrap();
    assert_eq!(first["received"], PART_BYTES);
    // A resend is answered from the idempotency cache, a gap is refused.
    assert_eq!(call(&f.rpc, &manager, "fs.writePart", part(0, "part-00000001")).await.unwrap(), first);
    assert_eq!(call(&f.rpc, &manager, "fs.writePart", part(10, "part-00000009")).await.unwrap_err(), "invalid_params");
    call(&f.rpc, &manager, "fs.writePart", part(PART_BYTES, "part-00000002")).await.unwrap();
    // Nothing half-written is visible in the workspace.
    assert_eq!(std::fs::read(f.root.join("run.sh")).unwrap(), b"old");
    assert_eq!(std::fs::read_dir(&f.root).unwrap().count(), 1);

    // Another device cannot commit this device's upload.
    let (other, _events) = peer(&f.rpc, "device-b", Authority::Manage).await;
    let commit = json!({ "path": "run.sh", "uploadId": "upload-0001", "size": content.len(), "expectedEtag": etag(b"old"), "clientRequestId": "commit-000001" });
    assert_eq!(call(&f.rpc, &other, "fs.write", commit.clone()).await.unwrap_err(), "not_found");

    let committed = call(&f.rpc, &manager, "fs.write", commit).await.unwrap();
    assert_eq!(committed["etag"], etag(&content));
    assert_eq!(std::fs::read(f.root.join("run.sh")).unwrap(), content);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(f.root.join("run.sh")).unwrap().permissions().mode() & 0o777, 0o755, "the mode is kept");
    }
    assert_eq!(std::fs::read_dir(&f.root).unwrap().count(), 1, "no temporary left behind");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn symlinks_that_leave_the_workspace_are_listed_but_never_followed() {
    let f = fixture();
    let (manager, _events) = peer(&f.rpc, "device-a", Authority::Manage).await;
    let outside = f.root.parent().unwrap().join("outside");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "needle outside").unwrap();
    std::fs::write(f.root.join("inside.txt"), "needle inside").unwrap();
    std::os::unix::fs::symlink(&outside, f.root.join("escape")).unwrap();
    std::os::unix::fs::symlink(outside.join("secret.txt"), f.root.join("secret-link.txt")).unwrap();
    std::os::unix::fs::symlink(f.root.join("inside.txt"), f.root.join("alias.txt")).unwrap();

    let listing = call(&f.rpc, &manager, "fs.list", json!({})).await.unwrap();
    let entry = |name: &str| listing["entries"].as_array().unwrap().iter().find(|entry| entry["name"] == name).unwrap().clone();
    assert_eq!(entry("escape")["escapes"], true);
    assert_eq!(entry("escape")["kind"], "symlink");
    assert_eq!(entry("secret-link.txt")["escapes"], true);
    assert_eq!(entry("alias.txt")["kind"], "file");
    assert_eq!(entry("alias.txt")["symlink"], true);
    assert!(entry("alias.txt").get("escapes").is_none());

    for path in ["escape", "escape/secret.txt", "secret-link.txt"] {
        assert_eq!(call(&f.rpc, &manager, "fs.read", json!({ "path": path })).await.unwrap_err(), "path_forbidden", "{path}");
        assert_eq!(call(&f.rpc, &manager, "fs.stat", json!({ "path": path })).await.unwrap_err(), "path_forbidden", "{path}");
    }
    assert_eq!(call(&f.rpc, &manager, "fs.list", json!({ "path": "escape" })).await.unwrap_err(), "path_forbidden");
    assert_eq!(call(&f.rpc, &manager, "fs.watch", json!({ "path": "escape" })).await.unwrap_err(), "path_forbidden");
    let search = json!({ "searchId": "search-0001", "query": "needle" });
    let found = call(&f.rpc, &manager, "fs.search", search).await.unwrap();
    let paths: Vec<&str> = found["hits"].as_array().unwrap().iter().map(|hit| hit["path"].as_str().unwrap()).collect();
    assert_eq!(paths, ["inside.txt"]);
    assert_eq!(
        call(&f.rpc, &manager, "fs.search", json!({ "searchId": "search-0002", "query": "needle", "path": "escape" })).await.unwrap_err(),
        "path_forbidden"
    );

    // Change notifications never name what is behind the escaping link.
    let files = WorkspaceFiles::new(f.root.clone());
    assert!(files.visible(&f.root.join("inside.txt")));
    assert!(files.visible(&f.root.join("escape")), "the link itself may be named");
    assert!(!files.visible(&f.root.join("escape/secret.txt")));
    assert!(!files.visible(&outside.join("secret.txt")));
    assert!(files.visible(&f.root.join("deleted/meanwhile.txt")));
}

#[tokio::test(flavor = "multi_thread")]
async fn search_results_are_bounded_and_say_so() {
    let f = fixture();
    let (participant, _events) = peer(&f.rpc, "device-p", Authority::Participate).await;
    std::fs::create_dir(f.root.join("src")).unwrap();
    for index in 0..40 {
        let body: String = (0..50).map(|line| format!("let needle_{line} = {index};\n")).collect();
        std::fs::write(f.root.join(format!("src/file{index}.rs")), body).unwrap();
    }
    // One minified line with thousands of matches.
    std::fs::write(f.root.join("bundle.js"), "needle;".repeat(20_000)).unwrap();

    let found = call(&f.rpc, &participant, "fs.search", json!({ "searchId": "search-0001", "query": "needle", "maxResults": 100 })).await.unwrap();
    assert_eq!(found["hits"].as_array().unwrap().len(), 100);
    assert_eq!(found["capped"], true);
    assert_eq!(found["cancelled"], false);
    for hit in found["hits"].as_array().unwrap() {
        assert!(hit["matches"].as_array().unwrap().len() <= MAX_MATCHES_PER_HIT);
    }

    let all = call(&f.rpc, &participant, "fs.search", json!({ "searchId": "search-0002", "query": "NEEDLE_4\\d", "regex": true, "maxResults": 5000, "path": "src" }))
        .await
        .unwrap();
    // maxResults is clamped, and the answer stays within the frame budget.
    assert!(all["hits"].as_array().unwrap().len() <= MAX_SEARCH_RESULTS);
    assert!(all.to_string().len() <= SEARCH_RESPONSE_BYTES + 1024);
    assert!(all["hits"].as_array().unwrap().iter().all(|hit| hit["path"].as_str().unwrap().starts_with("src/")));

    let case = call(&f.rpc, &participant, "fs.search", json!({ "searchId": "search-0003", "query": "NEEDLE", "caseSensitive": true })).await.unwrap();
    assert_eq!(case["hits"].as_array().unwrap().len(), 0);
    assert_eq!(
        call(&f.rpc, &participant, "fs.search", json!({ "searchId": "search-0004", "query": "(", "regex": true })).await.unwrap_err(),
        "invalid_params"
    );
}

#[test]
fn searches_stop_when_cancelled_replaced_or_disconnected() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    std::fs::write(root.join("a.txt"), "needle").unwrap();

    // A search whose flag is already set reads nothing and says it stopped.
    let set = AtomicBool::new(true);
    let (found, cancelled) = crate::files::search_text_under(&root, &root, "needle", false, false, 10, None, &set).unwrap();
    assert!(cancelled);
    assert!(found.hits.is_empty());

    let files = WorkspaceFiles::new(root.clone());
    let running = Arc::new(AtomicBool::new(false));
    files.searches.lock().unwrap().insert((7, "search-0001".into()), running.clone());
    // Another connection cannot cancel it.
    assert_eq!(files.cancel(8, &json!({ "searchId": "search-0001" })).unwrap()["cancelled"], false);
    assert!(!running.load(Ordering::Relaxed));
    assert_eq!(files.cancel(7, &json!({ "searchId": "search-0001" })).unwrap()["cancelled"], true);
    assert!(running.load(Ordering::Relaxed));

    let other = Arc::new(AtomicBool::new(false));
    files.searches.lock().unwrap().insert((7, "search-0002".into()), other.clone());
    files.disconnect(7);
    assert!(other.load(Ordering::Relaxed));

    // A new search under a running id stops the old one.
    let old = Arc::new(AtomicBool::new(false));
    files.searches.lock().unwrap().insert((9, "search-0003".into()), old.clone());
    let found = files.search(9, &json!({ "searchId": "search-0003", "query": "needle" })).unwrap();
    assert!(old.load(Ordering::Relaxed));
    assert_eq!(found["hits"].as_array().unwrap().len(), 1);
    assert!(files.searches.lock().unwrap().get(&(9, "search-0003".into())).is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn watches_are_capped_per_connection() {
    let f = fixture();
    let (participant, _events) = peer(&f.rpc, "device-p", Authority::Participate).await;
    for _ in 0..MAX_WATCHES_PER_PEER {
        call(&f.rpc, &participant, "fs.watch", json!({})).await.unwrap();
    }
    assert_eq!(call(&f.rpc, &participant, "fs.watch", json!({})).await.unwrap_err(), "backpressure");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_change_in_the_workspace_is_notified_without_staging_temporaries() {
    let f = fixture();
    let (manager, mut events) = peer(&f.rpc, "device-a", Authority::Manage).await;
    let watch = call(&f.rpc, &manager, "fs.watch", json!({})).await.unwrap();
    // A save through fs.write renames a temporary into place; only the file is named.
    call(&f.rpc, &manager, "fs.write", json!({ "path": "notes.md", "text": "x", "clientRequestId": "write-0000001" })).await.unwrap();
    let mut seen = Vec::new();
    while !seen.iter().any(|path: &String| path == "notes.md") {
        let event = tokio::time::timeout(std::time::Duration::from_secs(30), events.recv()).await.expect("a change notification").unwrap();
        assert_eq!(event["event"], "fs.changed");
        assert_eq!(event["params"]["subscriptionId"], watch["subscriptionId"]);
        seen.extend(event["params"]["paths"].as_array().unwrap().iter().map(|path| path.as_str().unwrap().to_string()));
    }
    assert!(seen.iter().all(|path| !is_staging_name(path)), "{seen:?}");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_link_to_an_ancestor_lists_under_the_path_asked_for() {
    let f = fixture();
    let (peer, _events) = peer(&f.rpc, "device-p", Authority::Participate).await;
    std::fs::create_dir(f.root.join("a")).unwrap();
    std::fs::write(f.root.join("a/x.txt"), "x").unwrap();
    std::os::unix::fs::symlink("..", f.root.join("a/up")).unwrap();
    let listing = call(&f.rpc, &peer, "fs.list", json!({ "path": "a/up/a" })).await.unwrap();
    assert_eq!(listing["path"], "a/up/a");
    let paths: Vec<&str> = listing["entries"].as_array().unwrap().iter().map(|entry| entry["path"].as_str().unwrap()).collect();
    assert_eq!(paths, ["a/up/a/up", "a/up/a/x.txt"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_long_listing_is_the_first_names_within_a_frame() {
    let f = fixture();
    let (peer, _events) = peer(&f.rpc, "device-p", Authority::Participate).await;
    for index in (0..MAX_LIST_ENTRIES + 20).rev() {
        std::fs::write(f.root.join(format!("file-{index:05}-{}.txt", "n".repeat(40))), "").unwrap();
    }
    let listing = call(&f.rpc, &peer, "fs.list", json!({})).await.unwrap();
    assert_eq!(listing["truncated"], true);
    let entries = listing["entries"].as_array().unwrap();
    assert!(entries[0]["name"].as_str().unwrap().starts_with("file-00000-"));
    assert!(entries.windows(2).all(|pair| pair[0]["name"].as_str() < pair[1]["name"].as_str()));
    assert!(listing.to_string().len() <= LIST_RESPONSE_BYTES + 1024);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_commit_frees_its_upload() {
    let f = fixture();
    let (manager, _events) = peer(&f.rpc, "device-a", Authority::Manage).await;
    std::fs::write(f.root.join("big.bin"), "agent").unwrap();
    for attempt in 0..MAX_UPLOADS_PER_DEVICE + 2 {
        let upload = format!("upload-{attempt:04}");
        let part = json!({ "uploadId": upload, "offset": 0, "dataB64": STANDARD.encode(b"mine"), "clientRequestId": format!("part-{attempt:06}") });
        call(&f.rpc, &manager, "fs.writePart", part).await.unwrap();
        let commit = json!({ "path": "big.bin", "uploadId": upload, "size": 4, "expectedEtag": "stale", "clientRequestId": format!("commit-{attempt:04}") });
        assert_eq!(call(&f.rpc, &manager, "fs.write", commit).await.unwrap_err(), "conflict");
    }
    let files = f.rpc_files();
    assert!(files.uploads.lock().unwrap().is_empty());
    assert_eq!(std::fs::read_dir(&files.staging).map(|dir| dir.count()).unwrap_or(0), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn stat_hashes_a_large_file_only_when_asked() {
    let f = fixture();
    let (peer, _events) = peer(&f.rpc, "device-p", Authority::Participate).await;
    let content = pattern(STAT_ETAG_BYTES as usize + 10);
    std::fs::write(f.root.join("large.bin"), &content).unwrap();
    assert!(call(&f.rpc, &peer, "fs.stat", json!({ "path": "large.bin" })).await.unwrap().get("etag").is_none());
    let asked = call(&f.rpc, &peer, "fs.stat", json!({ "path": "large.bin", "etag": true })).await.unwrap();
    assert_eq!(asked["etag"], etag(&content));
}
