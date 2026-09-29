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

// ---- sharing, presence, notes and leases (PRO-30, saas contract §20) ---------

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

const ALL: [&str; 6] = ["pty/1", "fs/1", "session/1", "keys/1", "collab/1", "git/1"];

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
        { "userId": "alice", "role": "driver", "canApprove": false },
        { "userId": "bob", "role": "viewer", "canApprove": true },
    ])));
    let (admin, mut admin_events, hello) = person(&f.rpc, "d-admin", Authority::Manage, "admin").await;
    assert_eq!(hello["you"], json!({ "userId": "admin", "role": "manager", "canApprove": true }));
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
}
