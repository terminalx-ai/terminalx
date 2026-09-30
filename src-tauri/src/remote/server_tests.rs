use std::time::Duration;

use serde_json::{json, Value};

use super::*;
use crate::sink::BroadcastSink;

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    rpc: Arc<WorkspaceRpc>,
    terminals: Arc<Terminals>,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.terminals.kill_all();
    }
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap().join("workspace");
    std::fs::create_dir(&root).unwrap();
    let terminals = Arc::new(Terminals::new());
    let rpc = WorkspaceRpc::new(&root, 7, Arc::new(BroadcastSink::new(64)), terminals.clone(), None).unwrap();
    Fixture { _dir: dir, root, rpc, terminals }
}

async fn call(rpc: &Arc<WorkspaceRpc>, peer: &Arc<Peer>, method: &str, params: Value) -> Result<Value, (String, String)> {
    let response = rpc.handle(peer, &json!({ "id": "1", "method": method, "params": params })).await;
    if response["ok"] == true {
        Ok(response["result"].clone())
    } else {
        Err((response["error"]["code"].as_str().unwrap().to_string(), response["error"]["message"].as_str().unwrap().to_string()))
    }
}

async fn manager_peer(rpc: &Arc<WorkspaceRpc>) -> (Arc<Peer>, Notifications) {
    let (peer, events) = Peer::new("device-manage".into(), Authority::Manage);
    call(rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["pty/1", "fs/1", "git/1", "session/1"] }))
        .await
        .unwrap();
    (peer, events)
}

fn code(result: Result<Value, (String, String)>) -> String {
    result.expect_err("expected a refusal").0
}

#[tokio::test(flavor = "multi_thread")]
async fn hello_reports_generation_and_gates_every_method() {
    let f = fixture();
    let (peer, _events) = Peer::new("device".into(), Authority::Manage);
    assert_eq!(code(call(&f.rpc, &peer, "fs.list", json!({})).await), "hello_required");
    let hello = call(&f.rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["fs/1", "zz/1"] })).await.unwrap();
    assert_eq!(hello["runtime"]["runtimeGeneration"], 7);
    assert_eq!(hello["capabilities"], json!(["fs/1"]));
    assert_eq!(hello["authority"], "manage");
    assert_eq!(code(call(&f.rpc, &peer, "pty.create", json!({ "clientRequestId": "request-0001" })).await), "capability_not_granted");
    assert_eq!(code(call(&f.rpc, &peer, "desktop.invoke", json!({ "command": "open" })).await), "method_not_found");
    assert!(call(&f.rpc, &peer, "fs.list", json!({})).await.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn participants_cannot_mutate_and_mutations_need_a_request_id() {
    let f = fixture();
    let (participant, _events) = Peer::new("device-participate".into(), Authority::Participate);
    call(&f.rpc, &participant, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["fs/1", "pty/1"] })).await.unwrap();
    assert_eq!(
        code(call(&f.rpc, &participant, "fs.write", json!({ "path": "a.txt", "text": "x", "clientRequestId": "request-0001" })).await),
        "forbidden"
    );
    assert_eq!(code(call(&f.rpc, &participant, "pty.create", json!({ "clientRequestId": "request-0001" })).await), "forbidden");
    let (manager, _events) = manager_peer(&f.rpc).await;
    assert_eq!(code(call(&f.rpc, &manager, "fs.write", json!({ "path": "a.txt", "text": "x" })).await), "invalid_params");
}

#[tokio::test(flavor = "multi_thread")]
async fn paths_cannot_leave_the_workspace() {
    let f = fixture();
    let (peer, _events) = manager_peer(&f.rpc).await;
    std::fs::write(f.root.parent().unwrap().join("secret.txt"), "outside").unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(f.root.parent().unwrap(), f.root.join("escape")).unwrap();
    for path in ["../secret.txt", "/etc/hosts", "a/../../secret.txt"] {
        assert_eq!(code(call(&f.rpc, &peer, "fs.read", json!({ "path": path })).await), "path_forbidden", "{path}");
    }
    #[cfg(unix)]
    {
        assert_eq!(code(call(&f.rpc, &peer, "fs.read", json!({ "path": "escape/secret.txt" })).await), "path_forbidden");
        assert_eq!(
            code(call(&f.rpc, &peer, "fs.write", json!({ "path": "escape/new.txt", "text": "x", "clientRequestId": "request-0002" })).await),
            "path_forbidden"
        );
        // Deleting the link removes the link, not the directory it names.
        call(&f.rpc, &peer, "fs.delete", json!({ "path": "escape", "clientRequestId": "request-0003" })).await.unwrap();
        assert!(f.root.parent().unwrap().join("secret.txt").exists());
    }
    crate::git::run(&f.root, &["init", "-q"]).unwrap();
    assert_eq!(
        code(call(&f.rpc, &peer, "git.stage", json!({ "paths": ["../secret.txt"], "clientRequestId": "request-0004" })).await),
        "path_forbidden"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn writes_are_optimistic_and_a_resend_does_not_write_twice() {
    let f = fixture();
    let (peer, _events) = manager_peer(&f.rpc).await;
    let first = call(&f.rpc, &peer, "fs.write", json!({ "path": "notes.md", "text": "one", "expectedEtag": null, "clientRequestId": "request-0001" }))
        .await
        .unwrap();
    // The same request id with different content is the original's replay.
    let replay = call(&f.rpc, &peer, "fs.write", json!({ "path": "notes.md", "text": "two", "clientRequestId": "request-0001" })).await.unwrap();
    assert_eq!(first, replay);
    assert_eq!(std::fs::read_to_string(f.root.join("notes.md")).unwrap(), "one");
    assert_eq!(
        code(call(&f.rpc, &peer, "fs.write", json!({ "path": "notes.md", "text": "x", "expectedEtag": null, "clientRequestId": "request-0002" })).await),
        "conflict"
    );
    assert_eq!(
        code(call(&f.rpc, &peer, "fs.write", json!({ "path": "notes.md", "text": "x", "expectedEtag": "stale", "clientRequestId": "request-0003" })).await),
        "conflict"
    );
    let read = call(&f.rpc, &peer, "fs.read", json!({ "path": "notes.md" })).await.unwrap();
    assert_eq!(read["text"], "one");
    call(&f.rpc, &peer, "fs.write", json!({ "path": "notes.md", "text": "three", "expectedEtag": read["etag"], "clientRequestId": "request-0004" }))
        .await
        .unwrap();
    call(&f.rpc, &peer, "fs.mkdir", json!({ "path": "docs", "clientRequestId": "request-0005" })).await.unwrap();
    call(&f.rpc, &peer, "fs.rename", json!({ "from": "notes.md", "to": "docs/notes.md", "clientRequestId": "request-0006" })).await.unwrap();
    let listing = call(&f.rpc, &peer, "fs.list", json!({ "path": "docs" })).await.unwrap();
    assert_eq!(listing["entries"][0]["name"], "notes.md");
    // Another attachment reusing the id is a different request.
    let (other, _events) = Peer::new("device-other".into(), Authority::Manage);
    call(&f.rpc, &other, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["fs/1"] })).await.unwrap();
    assert_eq!(
        code(call(&f.rpc, &other, "fs.write", json!({ "path": "notes.md", "text": "x", "expectedEtag": "stale", "clientRequestId": "request-0001" })).await),
        "conflict"
    );
}

/// Output from the next event on until `marker`, returning the offset after
/// it. Earlier bytes may have come with the attach answer or been skipped
/// while waiting for another event, so contiguity is checked from the first
/// event seen here, never assumed from offset 0.
async fn output_until(events: &mut Notifications, marker: &str) -> (String, u64) {
    let mut output = Vec::new();
    let mut end: Option<u64> = None;
    // A real shell starting on a loaded machine; the wait is on its output.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let event = match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(event) => event.unwrap(),
            Err(_) => panic!("no {marker} in the terminal's output: {:?}", String::from_utf8_lossy(&output)),
        };
        if event["event"] == "pty.output" {
            let chunk = STANDARD.decode(event["params"]["data"].as_str().unwrap()).unwrap();
            let offset = event["params"]["offset"].as_u64().unwrap();
            if let Some(end) = end {
                assert_eq!(offset, end, "offsets are contiguous");
            }
            end = Some(offset + chunk.len() as u64);
            output.extend(chunk);
            if String::from_utf8_lossy(&output).contains(marker) {
                return (String::from_utf8_lossy(&output).into_owned(), end.unwrap());
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn terminals_stream_with_offsets_replay_and_drop_resent_writes() {
    let f = fixture();
    let (peer, mut events) = manager_peer(&f.rpc).await;
    let created = call(&f.rpc, &peer, "pty.create", json!({ "cols": 100, "rows": 30, "clientRequestId": "request-pty-1" })).await.unwrap();
    let again = call(&f.rpc, &peer, "pty.create", json!({ "cols": 100, "rows": 30, "clientRequestId": "request-pty-1" })).await.unwrap();
    assert_eq!(created, again, "a resent create returns the same terminal");
    let pty_id = created["ptyId"].as_str().unwrap().to_string();
    let attached = call(&f.rpc, &peer, "pty.attach", json!({ "ptyId": pty_id })).await.unwrap();
    assert_eq!(attached["runtimeGeneration"], 7);
    let command = "echo remote-$((6*7))-ok\n";
    assert_eq!(call(&f.rpc, &peer, "pty.write", json!({ "ptyId": pty_id, "data": command, "seq": 1 })).await.unwrap()["applied"], true);
    // A resend of seq 1 after a reconnect is dropped, not typed twice.
    assert_eq!(call(&f.rpc, &peer, "pty.write", json!({ "ptyId": pty_id, "data": command, "seq": 1 })).await.unwrap()["applied"], false);
    let (output, _) = output_until(&mut events, "remote-42-ok").await;
    assert_eq!(output.matches("remote-42-ok").count(), 1, "the command ran once: {output}");

    // A second connection replays from an offset in this generation only.
    let (second, _second_events) = manager_peer(&f.rpc).await;
    let replay = call(&f.rpc, &second, "pty.attach", json!({ "ptyId": pty_id, "sinceOffset": 0, "runtimeGeneration": 7 })).await.unwrap();
    assert!(String::from_utf8_lossy(&STANDARD.decode(replay["data"].as_str().unwrap()).unwrap()).contains("remote-42-ok"));
    assert_eq!(
        code(call(&f.rpc, &second, "pty.attach", json!({ "ptyId": pty_id, "sinceOffset": 0, "runtimeGeneration": 6 })).await),
        "cursor_expired"
    );
    // A forged handle names nothing.
    assert_eq!(code(call(&f.rpc, &second, "pty.write", json!({ "ptyId": "remote-pty-forged", "data": "x", "seq": 1 })).await), "not_found");
    assert_eq!(code(call(&f.rpc, &second, "pty.kill", json!({ "ptyId": "serve-self-test" })).await), "not_found");
    // Unsubscribing someone else's subscription is refused.
    assert_eq!(
        code(call(&f.rpc, &second, "pty.detach", json!({ "subscriptionId": attached["subscriptionId"] })).await),
        "not_found"
    );
    call(&f.rpc, &peer, "pty.kill", json!({ "ptyId": pty_id })).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn git_reads_status_and_commits_once() {
    let f = fixture();
    let (peer, _events) = manager_peer(&f.rpc).await;
    for args in [&["init", "-q", "-b", "main"][..], &["config", "user.email", "t@example.com"], &["config", "user.name", "T"]] {
        crate::git::run(&f.root, args).unwrap();
    }
    std::fs::write(f.root.join("a.txt"), "a").unwrap();
    let status = call(&f.rpc, &peer, "git.status", json!({})).await.unwrap();
    assert_eq!(status["files"][0]["path"], "a.txt");
    assert_eq!(status["files"][0]["worktree"], "?");
    call(&f.rpc, &peer, "git.stage", json!({ "paths": ["a.txt"], "clientRequestId": "request-git-1" })).await.unwrap();
    let author = json!({ "name": "Ada", "email": "ada@example.com" });
    let commit = call(&f.rpc, &peer, "git.commit", json!({ "message": "first", "author": author, "clientRequestId": "request-git-2" })).await.unwrap();
    let replay = call(&f.rpc, &peer, "git.commit", json!({ "message": "first", "author": author, "clientRequestId": "request-git-2" })).await.unwrap();
    assert_eq!(commit, replay);
    let log = call(&f.rpc, &peer, "git.log", json!({ "limit": 5 })).await.unwrap();
    assert_eq!(log["commits"].as_array().unwrap().len(), 1);
    assert_eq!(
        code(call(&f.rpc, &peer, "git.checkout", json!({ "branch": "--orphan", "clientRequestId": "request-git-3" })).await),
        "invalid_params"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn hello_and_cursors_follow_a_newer_registered_generation() {
    let f = fixture();
    f.rpc.set_generation(8);
    let (peer, _events) = Peer::new("device".into(), Authority::Manage);
    let hello = call(&f.rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["pty/1"] })).await.unwrap();
    assert_eq!(hello["runtime"]["runtimeGeneration"], 8);
    let created = call(&f.rpc, &peer, "pty.create", json!({ "clientRequestId": "request-gen-1" })).await.unwrap();
    assert_eq!(
        code(call(&f.rpc, &peer, "pty.attach", json!({ "ptyId": created["ptyId"], "sinceOffset": 0, "runtimeGeneration": 7 })).await),
        "cursor_expired"
    );
}

async fn peer_for(rpc: &Arc<WorkspaceRpc>, device: &str, authority: Authority) -> (Arc<Peer>, Notifications) {
    let (peer, events) = Peer::new(device.into(), authority);
    call(rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["pty/1"] })).await.unwrap();
    (peer, events)
}

/// The next notification named `event`, skipping others.
async fn next_event(events: &mut Notifications, event: &str) -> Value {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let next = tokio::time::timeout_at(deadline, events.recv()).await.unwrap_or_else(|_| panic!("no {event}")).unwrap();
        if next["event"] == event {
            return next["params"].clone();
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn terminals_are_listed_with_their_identity_and_survive_a_new_connection() {
    let f = fixture();
    let (peer, mut events) = manager_peer(&f.rpc).await;
    let hello = call(&f.rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["pty/1"] })).await.unwrap();
    let epoch = hello["runtime"]["epoch"].as_str().unwrap().to_string();
    let first = call(&f.rpc, &peer, "pty.create", json!({ "cols": 90, "rows": 20, "clientRequestId": "request-list-1" })).await.unwrap();
    let second = call(&f.rpc, &peer, "pty.create", json!({ "clientRequestId": "request-list-2" })).await.unwrap();
    assert_eq!(first["epoch"], epoch.as_str());
    assert_eq!((first["number"].as_u64(), second["number"].as_u64()), (Some(1), Some(2)));
    assert_eq!(first["control"], "you");
    assert!(first["pid"].as_u64().is_some());
    let pty_id = first["ptyId"].as_str().unwrap().to_string();
    call(&f.rpc, &peer, "pty.attach", json!({ "ptyId": pty_id })).await.unwrap();
    call(&f.rpc, &peer, "pty.write", json!({ "ptyId": pty_id, "data": "echo shell-$$-pid\n", "seq": 1, "writerId": "w1", "epoch": epoch }))
        .await
        .unwrap();
    // The shell itself prints its pid: the listed process is the one running.
    let (_, end) = output_until(&mut events, &format!("shell-{}-pid", first["pid"])).await;

    // The connection goes away (view switch, reconnect, app restart); the
    // same device comes back, finds the terminal and resumes where it was.
    f.rpc.disconnect(&peer);
    let (again, _events) = manager_peer(&f.rpc).await;
    let listed = call(&f.rpc, &again, "pty.list", json!({})).await.unwrap();
    assert_eq!(listed["epoch"], epoch.as_str());
    let terminals = listed["terminals"].as_array().unwrap();
    assert_eq!(terminals.len(), 2);
    assert_eq!(terminals[0]["ptyId"], pty_id.as_str());
    assert_eq!(terminals[0]["pid"], first["pid"]);
    assert_eq!((terminals[0]["cols"].as_u64(), terminals[0]["rows"].as_u64()), (Some(90), Some(20)));
    let resumed = call(&f.rpc, &again, "pty.attach", json!({ "ptyId": pty_id, "sinceOffset": end, "runtimeGeneration": 7, "epoch": epoch })).await.unwrap();
    assert_eq!(resumed["offset"].as_u64(), Some(end));
    assert_eq!(resumed["control"], "you");
    // The writer's seq continues; nothing it sent is typed twice.
    assert_eq!(
        call(&f.rpc, &again, "pty.write", json!({ "ptyId": pty_id, "data": "echo shell-$$-pid\n", "seq": 1, "writerId": "w1" })).await.unwrap()["applied"],
        false
    );
    // An offset or a handle from another runtime process is refused.
    assert_eq!(
        code(call(&f.rpc, &again, "pty.attach", json!({ "ptyId": pty_id, "sinceOffset": 0, "runtimeGeneration": 7, "epoch": "epoch-old" })).await),
        "cursor_expired"
    );
    assert_eq!(
        code(call(&f.rpc, &again, "pty.write", json!({ "ptyId": pty_id, "data": "x", "seq": 2, "writerId": "w1", "epoch": "epoch-old" })).await),
        "not_found"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn input_is_applied_once_in_order_and_backpressure_keeps_it() {
    let f = fixture();
    let (peer, _events) = manager_peer(&f.rpc).await;
    let pty_id = call(&f.rpc, &peer, "pty.create", json!({ "clientRequestId": "request-order-1" })).await.unwrap()["ptyId"].as_str().unwrap().to_string();
    let write = |seq: u64, writer: &str| json!({ "ptyId": pty_id, "data": "true\n", "seq": seq, "writerId": writer });
    assert_eq!(code(call(&f.rpc, &peer, "pty.write", write(2, "w1")).await), "conflict", "a gap is refused, not skipped");
    assert_eq!(call(&f.rpc, &peer, "pty.write", write(1, "w1")).await.unwrap()["applied"], true);
    assert_eq!(call(&f.rpc, &peer, "pty.write", write(1, "w1")).await.unwrap()["applied"], false);
    // A new client instance of the same device numbers from 1 again.
    assert_eq!(call(&f.rpc, &peer, "pty.write", write(1, "w2")).await.unwrap()["applied"], true);
    assert_eq!(code(call(&f.rpc, &peer, "pty.write", write(0, "w2")).await), "invalid_params");
    let big = "x".repeat(MAX_WRITE_BYTES + 1);
    assert_eq!(code(call(&f.rpc, &peer, "pty.write", json!({ "ptyId": pty_id, "data": big, "seq": 2, "writerId": "w1" })).await), "too_large");

    // The program is not reading: the write is refused, its seq is not
    // spent, and the same write goes through once there is room.
    let pending = f.rpc.ptys.lock().unwrap()[&pty_id].input_pending.clone();
    pending.fetch_add(MAX_PENDING_INPUT, Ordering::SeqCst);
    assert_eq!(code(call(&f.rpc, &peer, "pty.write", write(2, "w1")).await), "backpressure");
    pending.fetch_sub(MAX_PENDING_INPUT, Ordering::SeqCst);
    assert_eq!(call(&f.rpc, &peer, "pty.write", write(2, "w1")).await.unwrap()["applied"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn one_controller_owns_input_and_size_and_viewers_follow() {
    let f = fixture();
    let (desk, mut desk_events) = peer_for(&f.rpc, "device-desk", Authority::Manage).await;
    let (laptop, mut laptop_events) = peer_for(&f.rpc, "device-laptop", Authority::Manage).await;
    let (phone, _phone_events) = peer_for(&f.rpc, "device-phone", Authority::Participate).await;
    let created = call(&f.rpc, &desk, "pty.create", json!({ "cols": 120, "rows": 40, "clientRequestId": "request-own-1" })).await.unwrap();
    let pty_id = created["ptyId"].as_str().unwrap().to_string();
    call(&f.rpc, &desk, "pty.attach", json!({ "ptyId": pty_id })).await.unwrap();
    let watching = call(&f.rpc, &laptop, "pty.attach", json!({ "ptyId": pty_id })).await.unwrap();
    assert_eq!(watching["control"], "other");
    assert_eq!(call(&f.rpc, &phone, "pty.list", json!({})).await.unwrap()["terminals"][0]["control"], "other");

    // A second window's size never reshapes the controller's program.
    assert_eq!(code(call(&f.rpc, &laptop, "pty.resize", json!({ "ptyId": pty_id, "cols": 60, "rows": 10 })).await), "not_controller");
    assert_eq!(
        code(call(&f.rpc, &laptop, "pty.write", json!({ "ptyId": pty_id, "data": "ls\n", "seq": 1, "writerId": "l" })).await),
        "not_controller"
    );
    // Participants (the paired phone's scope) never gain input, size or control.
    for (method, params) in [
        ("pty.resize", json!({ "ptyId": pty_id, "cols": 60, "rows": 10 })),
        ("pty.control", json!({ "ptyId": pty_id })),
        ("pty.write", json!({ "ptyId": pty_id, "data": "x", "seq": 1 })),
    ] {
        assert_eq!(code(call(&f.rpc, &phone, method, params).await), "forbidden", "{method}");
    }

    // Taking control is explicit, applies the new controller's size and is
    // announced to every viewer.
    let taken = call(&f.rpc, &laptop, "pty.control", json!({ "ptyId": pty_id, "cols": 100, "rows": 30 })).await.unwrap();
    assert_eq!((taken["control"].as_str(), taken["cols"].as_u64(), taken["rows"].as_u64()), (Some("you"), Some(100), Some(30)));
    // The loser hears it lost control before the new size, so it follows the size as a viewer.
    assert_eq!(next_event(&mut desk_events, "pty.control").await["control"], "other");
    assert_eq!(next_event(&mut desk_events, "pty.resized").await["cols"], 100);
    assert_eq!(next_event(&mut laptop_events, "pty.control").await["control"], "you");
    assert_eq!(code(call(&f.rpc, &desk, "pty.resize", json!({ "ptyId": pty_id, "cols": 80, "rows": 24 })).await), "not_controller");
    call(&f.rpc, &laptop, "pty.write", json!({ "ptyId": pty_id, "data": "stty size\n", "seq": 1, "writerId": "l" })).await.unwrap();
    output_until(&mut laptop_events, "30 100").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_and_close_are_reported_and_nothing_targets_a_closed_terminal() {
    let f = fixture();
    let (peer, mut events) = manager_peer(&f.rpc).await;
    let pty_id = call(&f.rpc, &peer, "pty.create", json!({ "clientRequestId": "request-exit-1" })).await.unwrap()["ptyId"].as_str().unwrap().to_string();
    call(&f.rpc, &peer, "pty.attach", json!({ "ptyId": pty_id })).await.unwrap();
    call(&f.rpc, &peer, "pty.write", json!({ "ptyId": pty_id, "data": "exit 3\n", "seq": 1, "writerId": "w" })).await.unwrap();
    let exit = next_event(&mut events, "pty.exit").await;
    assert_eq!(exit["ptyId"], pty_id.as_str());
    assert_eq!(code(call(&f.rpc, &peer, "pty.write", json!({ "ptyId": pty_id, "data": "x", "seq": 2, "writerId": "w" })).await), "unavailable");
    // Still listed, with its output, until it is closed.
    let listed = call(&f.rpc, &peer, "pty.list", json!({})).await.unwrap();
    assert_eq!(listed["terminals"][0]["exited"], true);
    let (watcher, mut watcher_events) = peer_for(&f.rpc, "device-watcher", Authority::Participate).await;
    let watching = call(&f.rpc, &watcher, "pty.attach", json!({ "ptyId": pty_id })).await.unwrap();
    call(&f.rpc, &peer, "pty.kill", json!({ "ptyId": pty_id })).await.unwrap();
    assert_eq!(call(&f.rpc, &peer, "pty.list", json!({})).await.unwrap()["terminals"], json!([]));
    // Whoever still watched it is told, and its subscription is gone.
    assert_eq!(next_event(&mut watcher_events, "pty.closed").await["subscriptionId"], watching["subscriptionId"]);
    assert!(!f.rpc.subscriptions.lock().unwrap().contains_key(watching["subscriptionId"].as_str().unwrap()));
    assert_eq!(code(call(&f.rpc, &peer, "pty.attach", json!({ "ptyId": pty_id })).await), "not_found");

    // Closing a running terminal ends its process and then its entry.
    let running = call(&f.rpc, &peer, "pty.create", json!({ "clientRequestId": "request-exit-2" })).await.unwrap();
    let running_id = running["ptyId"].as_str().unwrap().to_string();
    call(&f.rpc, &peer, "pty.attach", json!({ "ptyId": running_id })).await.unwrap();
    call(&f.rpc, &peer, "pty.kill", json!({ "ptyId": running_id })).await.unwrap();
    assert_eq!(next_event(&mut events, "pty.exit").await["ptyId"], running_id.as_str());
    assert_eq!(code(call(&f.rpc, &peer, "pty.write", json!({ "ptyId": running_id, "data": "x", "seq": 1 })).await), "not_found");
    assert!(!f.terminals.is_live(&running_id));
}

/// Terminal output the test makes itself, delivered exactly as a PTY
/// read would be, so no shell's timing is involved.
fn inject(f: &Fixture, pty_id: &str, bytes: &[u8]) {
    f.rpc.on_pty_data(PtyData { id: pty_id.to_string(), data: STANDARD.encode(bytes) });
}

/// The next event, however long a loaded machine takes to produce it.
async fn next(events: &mut Notifications) -> Value {
    tokio::time::timeout(Duration::from_secs(60), events.recv()).await.expect("an event").unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_connection_that_cannot_keep_up_is_told_to_resume_from_its_offset() {
    let f = fixture();
    let (peer, mut events) = manager_peer(&f.rpc).await;
    let pty_id = call(&f.rpc, &peer, "pty.create", json!({ "clientRequestId": "request-lag-1" })).await.unwrap()["ptyId"].as_str().unwrap().to_string();
    let attached = call(&f.rpc, &peer, "pty.attach", json!({ "ptyId": pty_id })).await.unwrap();
    let subscription = attached["subscriptionId"].as_str().unwrap().to_string();
    let mut end = attached["end"].as_u64().unwrap();
    // The connection's transport is this far behind: the next output ends
    // its stream instead of queueing more.
    peer.queued.fetch_add(MAX_QUEUED_OUTPUT + 1, Ordering::SeqCst);
    inject(&f, &pty_id, b"while-lagging-marker");
    // What it did get is contiguous, and ends with where to resume.
    let lagged_at = loop {
        let event = next(&mut events).await;
        match event["event"].as_str() {
            Some("pty.output") => {
                assert_eq!(event["params"]["offset"].as_u64(), Some(end));
                end += STANDARD.decode(event["params"]["data"].as_str().unwrap()).unwrap().len() as u64;
            }
            Some("pty.lagged") => {
                assert_eq!(event["params"]["subscriptionId"], subscription.as_str());
                break event["params"]["offset"].as_u64().unwrap();
            }
            _ => {}
        }
    };
    assert_eq!(lagged_at, end, "lagged names the first byte not sent");
    assert!(!f.rpc.ptys.lock().unwrap()[&pty_id].subscribers.contains_key(&subscription), "the stream ended");
    assert!(!f.rpc.subscriptions.lock().unwrap().contains_key(&subscription));
    // Once the link has caught up, the client resumes from that byte.
    peer.queued.fetch_sub(MAX_QUEUED_OUTPUT + 1, Ordering::SeqCst);
    let resumed = call(&f.rpc, &peer, "pty.attach", json!({ "ptyId": pty_id, "sinceOffset": lagged_at, "runtimeGeneration": 7 })).await.unwrap();
    assert_eq!((resumed["offset"].as_u64(), resumed["truncated"].as_bool()), (Some(lagged_at), Some(false)));
    let replayed = String::from_utf8_lossy(&STANDARD.decode(resumed["data"].as_str().unwrap()).unwrap()).into_owned();
    assert!(replayed.contains("while-lagging-marker"), "{replayed}");
}

#[tokio::test(flavor = "multi_thread")]
async fn attach_replays_the_ring_in_frames_and_reports_what_it_lost() {
    let f = fixture();
    let (peer, _events) = manager_peer(&f.rpc).await;
    let pty_id = call(&f.rpc, &peer, "pty.create", json!({ "clientRequestId": "request-ring-1" })).await.unwrap()["ptyId"].as_str().unwrap().to_string();
    // More than the ring holds, ending with a marker.
    let flood = vec![b'a'; PTY_RING_BYTES + 512 * 1024];
    for chunk in flood.chunks(32 * 1024) {
        inject(&f, &pty_id, chunk);
    }
    inject(&f, &pty_id, b"ring-end-marker");
    let (reader, mut events) = manager_peer(&f.rpc).await;
    let replay = call(&f.rpc, &reader, "pty.attach", json!({ "ptyId": pty_id, "sinceOffset": 0, "runtimeGeneration": 7 })).await.unwrap();
    assert_eq!(replay["truncated"], true, "bytes older than the ring are reported, not faked");
    let first = STANDARD.decode(replay["data"].as_str().unwrap()).unwrap();
    assert_eq!(first.len(), REPLAY_CHUNK, "a replay never outgrows one frame");
    // The rest of the ring follows as ordinary output, in order, before anything live.
    let mut end = replay["end"].as_u64().unwrap();
    let mut rest = Vec::new();
    while !String::from_utf8_lossy(&rest).contains("ring-end-marker") {
        let event = next(&mut events).await;
        if event["event"] == "pty.output" {
            assert_eq!(event["params"]["offset"].as_u64(), Some(end));
            let chunk = STANDARD.decode(event["params"]["data"].as_str().unwrap()).unwrap();
            assert!(chunk.len() <= REPLAY_CHUNK);
            end += chunk.len() as u64;
            rest.extend(chunk);
        }
    }
    assert!(first.len() + rest.len() >= PTY_RING_BYTES - 64 * 1024, "the whole ring was replayed");
}

struct NoAgents;

impl crate::cloud_agents::AgentOps for NoAgents {
    fn tabs(&self) -> Vec<crate::cloud_agents::AgentTabInfo> {
        Vec::new()
    }
    fn busy(&self, _: &str, _: &str) -> bool {
        false
    }
    fn send(&self, _: &str, _: &str, _: &str) -> anyhow::Result<()> {
        Ok(())
    }
    fn stop(&self, _: &str, _: &str) -> anyhow::Result<()> {
        Ok(())
    }
    fn respond(&self, _: &str, _: &str, _: &str, _: &str) -> Result<(), crate::cloud_agents::DecisionError> {
        Err(crate::cloud_agents::DecisionError::NotPending)
    }
    fn answer(&self, _: &str, _: &str, _: &str, _: HashMap<String, String>) -> Result<(), crate::cloud_agents::DecisionError> {
        Err(crate::cloud_agents::DecisionError::NotPending)
    }
    fn configure(&self, _: &str, _: &str, _: &crate::cloud_agents::Settings) -> anyhow::Result<()> {
        Ok(())
    }
    fn note(&self, _: &str, _: &str, _: &str) {}
    fn events(&self, _: &str, _: &str) -> anyhow::Result<Vec<Value>> {
        Ok(Vec::new())
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_workspace_key_is_handed_out_over_keys_1_and_only_managers_rotate_it() {
    let f = fixture();
    let agents = crate::cloud_agents::CloudAgents::open(&f._dir.path().join("agents"), Arc::new(NoAgents), None, None, 7).unwrap();
    f.rpc.set_agents(agents.clone());
    let (manager, _events) = Peer::new("device-manage".into(), Authority::Manage);
    call(&f.rpc, &manager, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["session/1"] })).await.unwrap();
    assert_eq!(code(call(&f.rpc, &manager, "keys.get", json!({})).await), "capability_not_granted");
    let (participant, _events) = Peer::new("device-phone".into(), Authority::Participate);
    let hello = call(&f.rpc, &participant, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["session/1", "keys/1"] })).await.unwrap();
    assert_eq!(hello["capabilities"], json!(["session/1", "keys/1"]));
    assert_eq!(agents.attached(), 2, "each connection that said hello counts as attached");
    // The key opens every tab's checkpoint; participants see no tabs.
    assert_eq!(code(call(&f.rpc, &participant, "keys.get", json!({})).await), "forbidden");
    let (keyholder, _events) = Peer::new("device-desk".into(), Authority::Manage);
    call(&f.rpc, &keyholder, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["keys/1"] })).await.unwrap();
    let handout = call(&f.rpc, &keyholder, "keys.get", json!({})).await.unwrap();
    let (current, key) = agents.keys.current().unwrap();
    assert_eq!(handout["currentKeyId"], current);
    assert_eq!(handout["keys"][0]["key"], crate::cloud_agents::crypto::b64(&key));
    assert_eq!(code(call(&f.rpc, &participant, "keys.rotate", json!({ "clientRequestId": "request-0001" })).await), "forbidden");
    // Nothing is shared with a participant, so it sees no agent tabs.
    assert_eq!(call(&f.rpc, &participant, "session.tabs", json!({})).await.unwrap()["tabs"], json!([]));
    assert_eq!(
        code(call(&f.rpc, &participant, "session.configure", json!({ "sessionId": "s", "tabId": "t", "clientRequestId": "request-0002" })).await),
        "forbidden"
    );
    f.rpc.disconnect(&participant);
    f.rpc.disconnect(&participant);
    assert_eq!(agents.attached(), 2, "a connection is counted once");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_manager_rotates_the_key_and_nudges_the_mailbox() {
    let f = fixture();
    let agents = crate::cloud_agents::CloudAgents::open(&f._dir.path().join("agents"), Arc::new(NoAgents), None, None, 7).unwrap();
    f.rpc.set_agents(agents.clone());
    let (manager, _events) = Peer::new("device-manage".into(), Authority::Manage);
    call(&f.rpc, &manager, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["session/1", "keys/1"] })).await.unwrap();
    let before = agents.keys.current().unwrap().0;
    let rotated = call(&f.rpc, &manager, "keys.rotate", json!({ "clientRequestId": "request-0001" })).await.unwrap();
    assert_ne!(rotated["currentKeyId"], before);
    let again = call(&f.rpc, &manager, "keys.rotate", json!({ "clientRequestId": "request-0001" })).await.unwrap();
    assert_eq!(again, rotated, "a resent rotation is not a second rotation");
    agents.poll.wait(Duration::ZERO);
    call(&f.rpc, &manager, "session.nudge", json!({})).await.unwrap();
    assert!(agents.poll.wait(Duration::ZERO));
    assert_eq!(code(call(&f.rpc, &manager, "session.configure", json!({ "sessionId": "s", "tabId": "t", "clientRequestId": "request-0003" })).await), "not_found");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_rotation_tells_key_holders_to_fetch_the_new_key() {
    let dir = tempfile::tempdir().unwrap();
    let root = std::fs::canonicalize(dir.path()).unwrap();
    let sink = Arc::new(BroadcastSink::new(64));
    let terminals = Arc::new(Terminals::new());
    let rpc = WorkspaceRpc::new(&root, 7, sink.clone(), terminals, None).unwrap();
    let agents = crate::cloud_agents::CloudAgents::open(&root.join("agents"), Arc::new(NoAgents), Some(sink), None, 7).unwrap();
    rpc.set_agents(agents.clone());
    let (holder, mut holder_events) = Peer::new("device-desk".into(), Authority::Manage);
    call(&rpc, &holder, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["keys/1"] })).await.unwrap();
    let (other, mut other_events) = Peer::new("device-other".into(), Authority::Manage);
    call(&rpc, &other, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["fs/1"] })).await.unwrap();
    agents.rotate_key().unwrap();
    let event = tokio::time::timeout(Duration::from_secs(5), holder_events.recv()).await.unwrap().unwrap();
    assert_eq!(event["event"], "keys.changed");
    assert!(tokio::time::timeout(Duration::from_millis(50), other_events.recv()).await.is_err(), "only key holders are told");
}

#[test]
fn session_cursors_expire_with_the_runtime_process() {
    let f = fixture();
    let cursor = f.rpc.cursor(30);
    assert_eq!(f.rpc.parse_cursor(&cursor).unwrap(), 30);
    // A restarted runtime (same generation, new process) refuses it.
    let restarted = fixture();
    assert_eq!(restarted.rpc.parse_cursor(&cursor).unwrap_err().code, "cursor_expired");
    assert_eq!(f.rpc.parse_cursor("7:30").unwrap_err().code, "cursor_expired", "the pre-PRO-22 form");
}

#[tokio::test(flavor = "multi_thread")]
async fn participants_read_git_and_disposition_facts_but_never_publish() {
    let f = fixture();
    crate::git::run(&f.root, &["init", "-q", "-b", "main"]).unwrap();
    std::fs::write(f.root.join("a.txt"), "a").unwrap();
    let (participant, _events) = Peer::new("device-participate".into(), Authority::Participate);
    call(&f.rpc, &participant, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["git/1"] })).await.unwrap();
    assert_eq!(code(call(&f.rpc, &participant, "lifecycle.dispositionFacts", json!({})).await), "capability_not_granted");
    call(&f.rpc, &participant, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["git/1", "lifecycle/1"] })).await.unwrap();
    assert_eq!(call(&f.rpc, &participant, "git.status", json!({})).await.unwrap()["files"][0]["path"], "a.txt");
    assert_eq!(call(&f.rpc, &participant, "git.repositories", json!({})).await.unwrap()["repositories"][0]["repo"], ".");
    let author = json!({ "name": "Ada", "email": "ada@example.com" });
    for (method, params) in [
        ("git.stage", json!({ "paths": ["a.txt"] })),
        ("git.commit", json!({ "message": "m", "author": author })),
        ("git.fetch", json!({})),
        ("git.push", json!({})),
        ("git.prCreate", json!({ "title": "t" })),
        ("git.prMerge", json!({ "number": 1 })),
    ] {
        let mut params = params;
        params["clientRequestId"] = json!("request-participant-1");
        assert_eq!(code(call(&f.rpc, &participant, method, params).await), "forbidden", "{method}");
    }
    let facts = call(&f.rpc, &participant, "lifecycle.dispositionFacts", json!({})).await.unwrap();
    assert_eq!(facts["v"], 1);
    assert_eq!(facts["repositories"][0]["path"], ".");
    assert_eq!(facts["repositories"][0]["dirtyFiles"], 1);
    assert_eq!(facts["repositories"][0]["untrackedFiles"], 1);
    assert_eq!(facts["runningProcesses"], 0);
    assert_eq!(facts["activeTasks"], json!([]));
}

// ---- CS-12: agents/1, session/2, pty/2 ---------------------------------------

/// A session in the index, made by the same `session_ops` the runtime uses.
fn seed_session(project: &Path, title: &str, cwd: Option<&Path>) -> SessionEntry {
    crate::session_ops::create_session_entry(crate::session_ops::NewSession {
        project_path: project.to_string_lossy().into_owned(),
        title: Some(title.into()),
        use_worktree: false,
        base_ref: None,
        worktree_name: None,
        on_main: true,
        issue: None,
        automation: None,
        cwd: cwd.map(|cwd| cwd.to_string_lossy().into_owned()),
        tab: Some(crate::session_ops::NewTab { harness: "claude".into(), model: "opus".into(), effort: None, permission_mode: None }),
    })
    .unwrap()
}

/// Claude and Codex installed at VM paths, OpenCode not.
fn installed_agents() -> Vec<crate::harness::HarnessInfo> {
    crate::harness::catalog()
        .into_iter()
        .map(|mut agent| {
            if agent.id == "claude" || agent.id == "codex" {
                agent.available = true;
                agent.path = Some(format!("/home/vm/.local/bin/{}", agent.binary));
            } else {
                agent.available = false;
            }
            agent
        })
        .collect()
}

async fn hello_with(rpc: &Arc<WorkspaceRpc>, device: &str, authority: Authority, want: &[&str]) -> (Arc<Peer>, Notifications) {
    let (peer, events) = Peer::new(device.into(), authority);
    call(rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": want })).await.unwrap();
    (peer, events)
}

/// No notification named `event` arrives within a short wait.
async fn no_event(events: &mut Notifications, event: &str) {
    let deadline = tokio::time::Instant::now() + Duration::from_millis(600);
    while let Ok(Some(next)) = tokio::time::timeout_at(deadline, events.recv()).await {
        assert_ne!(next["event"], event, "unexpected {event}: {next}");
    }
}

const SESSION_1: &[&str] = &["pty/1", "fs/1", "git/1", "session/1", "keys/1", "lifecycle/1"];

#[tokio::test(flavor = "multi_thread")]
async fn a_session_1_desktop_is_served_as_before_and_never_sees_the_additions() {
    let _home = crate::store::temp_home();
    let f = fixture();
    let session = seed_session(&f.root, "Fix login", None);
    let (old, mut events) = hello_with(&f.rpc, "device-old", Authority::Manage, SESSION_1).await;
    let listed = call(&f.rpc, &old, "session.list", json!({})).await.unwrap();
    assert_eq!(listed["sessions"][0]["id"], session.id.as_str());
    for (method, params) in [
        ("session.update", json!({ "sessionId": session.id, "title": "x", "clientRequestId": "request-old-1" })),
        ("session.addTab", json!({ "sessionId": session.id, "agent": "claude", "clientRequestId": "request-old-2" })),
        ("session.delete", json!({ "sessionId": session.id, "clientRequestId": "request-old-3" })),
        ("runtime.agents", json!({})),
    ] {
        assert_eq!(code(call(&f.rpc, &old, method, params).await), "capability_not_granted", "{method}");
    }
    // pty/1 has no sessionId; a terminal made without one is listed without one.
    assert_eq!(
        code(call(&f.rpc, &old, "pty.create", json!({ "sessionId": session.id, "clientRequestId": "request-old-4" })).await),
        "invalid_params"
    );
    let pty = call(&f.rpc, &old, "pty.create", json!({ "clientRequestId": "request-old-5" })).await.unwrap();
    assert!(pty.get("sessionId").is_none());
    // Another client's session/2 change does not reach it as session.sessions.
    let (new, _new_events) = hello_with(&f.rpc, "device-new", Authority::Manage, &protocol::CAPABILITIES).await;
    call(&f.rpc, &new, "session.update", json!({ "sessionId": session.id, "pinned": true, "clientRequestId": "request-new-1" })).await.unwrap();
    no_event(&mut events, "session.sessions").await;
    assert_eq!(call(&f.rpc, &old, "session.list", json!({})).await.unwrap()["sessions"][0]["pinned"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn participants_are_refused_every_session_2_write_and_see_only_shared_sessions() {
    let _home = crate::store::temp_home();
    let f = fixture();
    f.rpc.set_offered_for_tests(installed_agents());
    let session = seed_session(&f.root, "Fix login", None);
    let (participant, _events) = hello_with(&f.rpc, "device-phone", Authority::Participate, &protocol::CAPABILITIES).await;
    for (method, params) in [
        ("session.update", json!({ "sessionId": session.id, "title": "x", "clientRequestId": "request-part-1" })),
        ("session.addTab", json!({ "sessionId": session.id, "agent": "claude", "clientRequestId": "request-part-2" })),
        ("session.delete", json!({ "sessionId": session.id, "clientRequestId": "request-part-3" })),
        ("pty.create", json!({ "sessionId": session.id, "clientRequestId": "request-part-4" })),
    ] {
        assert_eq!(code(call(&f.rpc, &participant, method, params).await), "forbidden", "{method}");
    }
    assert_eq!(index::get(&session.id).unwrap().title, "Fix login", "nothing changed");
    // Nothing is shared with a participant yet: it lists no sessions.
    assert_eq!(call(&f.rpc, &participant, "session.list", json!({})).await.unwrap()["sessions"], json!([]));
    // Reading what can run is not a write.
    assert!(call(&f.rpc, &participant, "runtime.agents", json!({})).await.is_ok());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_manager_updates_adds_tabs_and_deletes_sessions_and_is_told_the_list() {
    let _home = crate::store::temp_home();
    let f = fixture();
    f.rpc.set_offered_for_tests(installed_agents());
    let session = seed_session(&f.root, "Fix login", None);
    let other_dir = f._dir.path().join("elsewhere");
    std::fs::create_dir(&other_dir).unwrap();
    let elsewhere = seed_session(&other_dir, "Another project", None);
    let (manager, mut events) = hello_with(&f.rpc, "device-desk", Authority::Manage, &protocol::CAPABILITIES).await;

    // update: title, pin and archive, one at a time or together.
    let updated = call(
        &f.rpc,
        &manager,
        "session.update",
        json!({ "sessionId": session.id, "title": "  Fix the login  ", "pinned": true, "clientRequestId": "request-upd-1" }),
    )
    .await
    .unwrap();
    assert_eq!((updated["session"]["title"].as_str(), updated["session"]["pinned"].as_bool()), (Some("Fix the login"), Some(true)));
    let pushed = next_event(&mut events, "session.sessions").await;
    assert_eq!(pushed["sessions"].as_array().unwrap().len(), 1, "only this workspace's sessions");
    assert_eq!(pushed["sessions"][0]["title"], "Fix the login");
    call(&f.rpc, &manager, "session.update", json!({ "sessionId": session.id, "archived": true, "clientRequestId": "request-upd-2" }))
        .await
        .unwrap();
    let stored = index::get(&session.id).unwrap();
    assert!(stored.archived && stored.pinned && stored.title == "Fix the login");
    for (params, expected) in [
        (json!({ "sessionId": session.id, "clientRequestId": "request-upd-3" }), "invalid_params"),
        (json!({ "sessionId": session.id, "title": "   ", "clientRequestId": "request-upd-4" }), "invalid_params"),
        (json!({ "sessionId": session.id, "title": "x".repeat(201), "clientRequestId": "request-upd-5" }), "invalid_params"),
        (json!({ "sessionId": session.id, "title": "x" }), "invalid_params"),
        (json!({ "sessionId": elsewhere.id, "title": "x", "clientRequestId": "request-upd-6" }), "not_found"),
    ] {
        assert_eq!(code(call(&f.rpc, &manager, "session.update", params.clone()).await), expected, "{params}");
    }

    // addTab: an installed agent and a known mode, through session_ops.
    let added = call(
        &f.rpc,
        &manager,
        "session.addTab",
        json!({ "sessionId": session.id, "agent": "codex", "model": "gpt-5.5", "mode": "plan", "clientRequestId": "request-tab-1" }),
    )
    .await
    .unwrap();
    let tab_id = added["tabId"].as_str().unwrap().to_string();
    let stored = index::get(&session.id).unwrap();
    assert_eq!(stored.tabs.len(), 2);
    assert_eq!(stored.active_tab.as_deref(), Some(tab_id.as_str()));
    let tab = stored.tab(&tab_id).unwrap();
    assert_eq!((tab.harness.as_str(), tab.model.as_str(), tab.permission_mode.as_str()), ("codex", "gpt-5.5", "plan"));
    // A resend is answered from the cache, not added twice.
    let again = call(
        &f.rpc,
        &manager,
        "session.addTab",
        json!({ "sessionId": session.id, "agent": "codex", "model": "gpt-5.5", "mode": "plan", "clientRequestId": "request-tab-1" }),
    )
    .await
    .unwrap();
    assert_eq!(again["tabId"], tab_id.as_str());
    assert_eq!(index::get(&session.id).unwrap().tabs.len(), 2);
    for (params, expected) in [
        (json!({ "sessionId": session.id, "agent": "opencode", "clientRequestId": "request-tab-2" }), "unavailable"),
        (json!({ "sessionId": session.id, "agent": "vim", "clientRequestId": "request-tab-3" }), "invalid_params"),
        (json!({ "sessionId": session.id, "agent": "claude", "mode": "yolo", "clientRequestId": "request-tab-4" }), "invalid_params"),
        (json!({ "sessionId": elsewhere.id, "agent": "claude", "clientRequestId": "request-tab-5" }), "not_found"),
    ] {
        assert_eq!(code(call(&f.rpc, &manager, "session.addTab", params.clone()).await), expected, "{params}");
    }

    // delete: gone from the index and the list, and only this workspace's.
    assert_eq!(
        code(call(&f.rpc, &manager, "session.delete", json!({ "sessionId": elsewhere.id, "clientRequestId": "request-del-1" })).await),
        "not_found"
    );
    let deleted = call(&f.rpc, &manager, "session.delete", json!({ "sessionId": session.id, "clientRequestId": "request-del-2" })).await.unwrap();
    assert_eq!(deleted["deleted"], json!([session.id]));
    assert!(index::get(&session.id).is_err());
    assert!(index::get(&elsewhere.id).is_ok());
    loop {
        if next_event(&mut events, "session.sessions").await["sessions"] == json!([]) {
            break;
        }
    }
    assert_eq!(call(&f.rpc, &manager, "session.list", json!({})).await.unwrap()["sessions"], json!([]));
    assert_eq!(
        code(call(&f.rpc, &manager, "session.delete", json!({ "sessionId": session.id, "clientRequestId": "request-del-3" })).await),
        "not_found"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_terminal_opened_for_a_session_carries_its_id_and_closes_with_it() {
    let _home = crate::store::temp_home();
    let f = fixture();
    let checkout = f.root.join("checkout");
    std::fs::create_dir(&checkout).unwrap();
    let session = seed_session(&f.root, "Fix login", Some(&checkout));
    let outside = seed_session(&f.root, "Elsewhere", Some(f._dir.path()));
    let (manager, _events) = hello_with(&f.rpc, "device-desk", Authority::Manage, &protocol::CAPABILITIES).await;

    let pty = call(&f.rpc, &manager, "pty.create", json!({ "sessionId": session.id, "clientRequestId": "request-pty-1" })).await.unwrap();
    assert_eq!(pty["sessionId"], session.id.as_str());
    assert_eq!(pty["cwd"], "checkout", "it opens in the session's checkout");
    // A checkout outside the workspace is never used as a terminal's cwd.
    let rooted = call(&f.rpc, &manager, "pty.create", json!({ "sessionId": outside.id, "clientRequestId": "request-pty-2" })).await.unwrap();
    assert_eq!(rooted["cwd"], "");
    let plain = call(&f.rpc, &manager, "pty.create", json!({ "clientRequestId": "request-pty-3" })).await.unwrap();
    assert!(plain.get("sessionId").is_none());
    assert_eq!(
        code(call(&f.rpc, &manager, "pty.create", json!({ "sessionId": "no-such-session", "clientRequestId": "request-pty-4" })).await),
        "not_found"
    );

    let listed = call(&f.rpc, &manager, "pty.list", json!({})).await.unwrap();
    let ids: Vec<Option<&str>> = listed["terminals"].as_array().unwrap().iter().map(|t| t["sessionId"].as_str()).collect();
    assert_eq!(ids, vec![Some(session.id.as_str()), Some(outside.id.as_str()), None]);

    call(&f.rpc, &manager, "session.delete", json!({ "sessionId": session.id, "clientRequestId": "request-del-1" })).await.unwrap();
    let listed = call(&f.rpc, &manager, "pty.list", json!({})).await.unwrap();
    let ids: Vec<Option<&str>> = listed["terminals"].as_array().unwrap().iter().map(|t| t["sessionId"].as_str()).collect();
    assert_eq!(ids, vec![Some(outside.id.as_str()), None], "the deleted session's terminal is closed");
}

#[tokio::test(flavor = "multi_thread")]
async fn runtime_agents_lists_installed_agents_with_models_efforts_and_modes() {
    let f = fixture();
    f.rpc.set_offered_for_tests(installed_agents());
    let (peer, _events) = hello_with(&f.rpc, "device-desk", Authority::Manage, &["agents/1"]).await;
    let listed = call(&f.rpc, &peer, "runtime.agents", json!({})).await.unwrap();
    let agents = listed["agents"].as_array().unwrap();
    let ids: Vec<&str> = agents.iter().map(|agent| agent["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["claude", "codex"], "only installed agents");
    let claude = &agents[0];
    assert_eq!(claude["name"], "Claude Code");
    assert_eq!(claude["defaultMode"], index::DEFAULT_PERMISSION_MODE);
    assert_eq!(claude["modes"], json!(PERMISSION_MODES));
    assert_eq!(claude["caps"]["effort"], true);
    let opus = claude["models"].as_array().unwrap().iter().find(|model| model["id"] == "opus").unwrap();
    assert_eq!(opus["isDefault"], true);
    assert!(opus["efforts"].as_array().unwrap().iter().any(|effort| effort == "high"));
    assert!(!agents[1]["models"].as_array().unwrap().is_empty(), "codex models come from its list");
    // A path on the VM never leaves it.
    assert!(!listed.to_string().contains("/home/vm"));
}
