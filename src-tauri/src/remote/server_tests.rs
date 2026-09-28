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

async fn output_until(events: &mut Notifications, marker: &str) -> (String, u64) {
    let mut output = Vec::new();
    let mut end = 0;
    // A real shell starting on a loaded machine; the wait is on its output.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let event = tokio::time::timeout_at(deadline, events.recv()).await.expect("terminal answered").unwrap();
        if event["event"] == "pty.output" {
            let chunk = STANDARD.decode(event["params"]["data"].as_str().unwrap()).unwrap();
            assert_eq!(event["params"]["offset"].as_u64().unwrap(), end, "offsets are contiguous");
            end += chunk.len() as u64;
            output.extend(chunk);
            if String::from_utf8_lossy(&output).contains(marker) {
                return (String::from_utf8_lossy(&output).into_owned(), end);
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
    let commit = call(&f.rpc, &peer, "git.commit", json!({ "message": "first", "clientRequestId": "request-git-2" })).await.unwrap();
    let replay = call(&f.rpc, &peer, "git.commit", json!({ "message": "first", "clientRequestId": "request-git-2" })).await.unwrap();
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
