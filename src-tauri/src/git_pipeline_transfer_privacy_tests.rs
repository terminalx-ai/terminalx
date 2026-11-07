//! Authenticated desktop -> owner -> engine -> actual SSH push. Successful
//! push is followed by privacy activation before PR lookup; no provider or
//! reviewer launch substitutes for, or follows, the transfer under test.
use super::*;
use serde_json::{json, Value};
use crate::local_runtime::{client::Client, sessions::Sessions};
use crate::github_process::tests::transport::{acknowledge, control, service};

pub(super) fn run(root: &Path, managed: bool) {
    let _environment = Environment::new(root);
    policy(false, managed);
    let f = Fixture::new(root, "pipeline-bridge");
    f.workspace("git.pull").unwrap();
    git(&f.cwd, &["checkout", "-qb", "privacy-pipeline"]);
    let expected = f.commit_for_push();
    let author: crate::store::index::SessionEntry = serde_json::from_value(json!({
        "id":"privacy-pipeline-author", "projectPath":f.cwd, "cwd":f.cwd, "title":"Privacy pipeline",
        "created":"2026-10-12T00:00:00Z", "modified":"2026-10-12T00:00:00Z",
        "tabs":[{"id":"t1", "harness":"claude", "model":"opus", "created":"2026-10-12T00:00:00Z"}]
    })).unwrap();
    let mut sessions = crate::store::index::load().unwrap();
    sessions.push(author.clone()); crate::store::index::save(&sessions).unwrap();
    let pipeline: crate::issue_pipeline::Pipeline = serde_json::from_value(json!({
        "id":"privacy-pipeline", "projectPath":f.cwd, "branch":"privacy-pipeline",
        "author":{"sessionId":author.id,"tabId":"t1"}, "stage":"pullRequest", "state":"needsYou",
        "maxRounds":3, "created":"2026-10-12T00:00:00Z", "modified":"2026-10-12T00:00:00Z"
    })).unwrap();
    crate::issue_pipeline::store::insert(&pipeline).unwrap();
    let endpoint = crate::hooks::prepare_control().unwrap();
    let owner = service(root, &endpoint);
    let (_, mut bridge) = crate::hooks::serve(endpoint.clone(), |_| crate::hooks::HookReply::default(), move |request| owner.handle(request)).unwrap();
    let mut client = Client::connect(root).unwrap();
    let act = |client: &Arc<Client>| -> Value {
        Sessions::new(client.clone()).pipeline("act", json!({"id":"privacy-pipeline", "action":"advance"})).unwrap()
    };
    let refused = |result: Value| {
        assert_eq!(result["state"], "needsYou", "local pipeline result survives denial");
        assert!(result["reason"].to_string().contains(data_privacy::MESSAGE), "{result}");
    };
    let before = f.transfers();
    acknowledge(&endpoint, true, managed); client.refresh_data_privacy().unwrap();
    refused(act(&client));
    acknowledge(&endpoint, false, managed); client.refresh_data_privacy().unwrap();
    let (arrived_tx, arrived_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    *crate::local_runtime::client::BEFORE_WORKSPACE_SEND.lock().unwrap() = Some(Box::new(move || {
        arrived_tx.send(()).unwrap(); release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    }));
    std::thread::scope(|scope| {
        let worker = scope.spawn(crate::github_process::queued(|| act(&client)));
        arrived_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        acknowledge(&endpoint, true, managed); acknowledge(&endpoint, false, managed);
        client.refresh_data_privacy().unwrap(); release_tx.send(()).unwrap();
        refused(worker.join().unwrap());
    });
    assert_eq!(f.transfers(), before, "stale desktop pipeline pushed before its PR lookup");

    // Explicit denial stays authoritative even beside a valid current stamp.
    let authority = data_privacy::Ticket::default().forwarded(client.epoch());
    let response = control(&endpoint, &endpoint.token, "runtime.session.pipeline", json!({
        "operation":"act", "params":{"id":"privacy-pipeline","action":"advance"},
        "networkAllowed":false, "networkAuthority":authority
    }));
    assert!(response.ok); refused(response.result.unwrap()); assert_eq!(f.transfers(), before);

    let admin = crate::hooks::prepare_control().unwrap();
    let owner = service(root, &admin);
    let (_, _admin_bridge) = crate::hooks::serve(admin.clone(), |_| crate::hooks::HookReply::default(), move |request| owner.handle(request)).unwrap();
    bridge.freeze(Duration::from_secs(5)).unwrap();
    let (written_tx, written_rx) = std::sync::mpsc::channel();
    *crate::local_runtime::client::AFTER_WORKSPACE_WRITE.lock().unwrap() = Some(Box::new(move || { written_tx.send(()).unwrap(); }));
    std::thread::scope(|scope| {
        let worker = scope.spawn(crate::github_process::queued(|| act(&client)));
        written_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let frozen = bridge.take(|_| false).unwrap();
        assert!(frozen.held.is_empty() && frozen.parked.is_empty(), "must be unread listener backlog");
        acknowledge(&admin, true, managed); acknowledge(&admin, false, managed);
        let replacement = crate::hooks::ControlEndpoint::adopted(endpoint.socket.clone(), endpoint.token.clone());
        let owner = service(root, &replacement);
        let adopted = crate::hooks::Adopted { own:frozen.own, published:frozen.published, held:Vec::new() };
        let (_, next) = crate::hooks::serve_adopted(replacement, adopted, |_| crate::hooks::HookReply::default(), move |request| owner.handle(request)).unwrap();
        next.thaw(); refused(worker.join().unwrap()); bridge = next;
    });
    assert_eq!(f.transfers(), before);
    client = Client::connect(root).unwrap();
    std::fs::write(&f.hold, "").unwrap();
    std::thread::scope(|scope| {
        let worker = scope.spawn(crate::github_process::queued(|| act(&client)));
        let until = Instant::now() + Duration::from_secs(10);
        let pids: Vec<i32> = loop {
            if let Ok(text) = std::fs::read_to_string(&f.held) {
                let pids: Vec<_> = text.split_whitespace().map(|p| p.parse().unwrap()).collect();
                if pids.len() == 2 { break pids; }
            }
            assert!(Instant::now() < until && !worker.is_finished()); std::thread::sleep(Duration::from_millis(5));
        };
        acknowledge(&endpoint, true, managed);
        for pid in pids { assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "pipeline transfer remains after acknowledgement"); }
        refused(worker.join().unwrap());
    });
    assert!(!raw(&f.origin, &["rev-parse", "--verify", "refs/heads/privacy-pipeline"]).status.success());
    std::fs::remove_file(&f.hold).unwrap();
    acknowledge(&endpoint, false, managed); client.refresh_data_privacy().unwrap();
    let endpoint_copy = endpoint.clone();
    *crate::github_process::AFTER_OUTPUT.lock().unwrap() = Some(Box::new(move || acknowledge(&endpoint_copy, true, managed)));
    refused(act(&client));
    assert_eq!(git(&f.origin, &["rev-parse", "refs/heads/privacy-pipeline"]), expected, "fresh restored request must physically push");
    assert!(f.transfers() > before);
    let pipeline = crate::issue_pipeline::store::get("privacy-pipeline").unwrap();
    assert!(serde_json::to_value(pipeline.reason).unwrap().to_string().contains("Opening the pull request"), "the restored push completed before the next admission was refused");
    acknowledge(&endpoint, false, managed); client.refresh_data_privacy().unwrap();
    drop(bridge);
}
