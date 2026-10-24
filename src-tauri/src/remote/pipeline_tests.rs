//! `pipeline/1`: a session started from an issue in a cloud workspace, its
//! pipeline carried by the runtime, read and steered by a desktop.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::pty::Terminals;
use crate::remote::protocol::{Authority, PROTOCOL};
use crate::remote::server::{Notifications, Peer, WorkspaceRpc};
use crate::session::SessionManager;
use crate::sink::BroadcastSink;

struct Fixture {
    // Fields drop in declaration order, after Drop kills the processes.
    _claude: crate::harness::claude::pty::TestProgram,
    _home: crate::store::TempHome,
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

fn git(cwd: &Path, args: &[&str]) {
    let out = Command::new("git").args(["-c", "user.email=t@example.com", "-c", "user.name=t"]).args(args).current_dir(cwd).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

/// An agent that answers nothing and never ends: a turn that is still running.
fn quiet_agent(dir: &Path) -> String {
    let path = dir.join("agent");
    std::fs::write(&path, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.ran\"\nexec sleep 600\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path.to_string_lossy().into_owned()
}

/// A cloud workspace's runtime: its project registered, agent tabs served,
/// and Claude installed (as a stand-in that never answers). The stand-in is
/// what its sessions launch, too: never a Claude Code installed here, nor
/// "not installed" where none is.
fn fixture() -> Fixture {
    let home = crate::store::temp_home();
    let dir = tempfile::tempdir().unwrap();
    let base = std::fs::canonicalize(dir.path()).unwrap();
    let root = base.join("workspace");
    std::fs::create_dir(&root).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    std::fs::write(root.join("README.md"), "hello\n").unwrap();
    git(&root, &["add", "-A"]);
    git(&root, &["commit", "-qm", "init"]);
    crate::store::projects::add(&root.to_string_lossy()).unwrap();
    let sink = Arc::new(BroadcastSink::new(256));
    let terminals = Arc::new(Terminals::new());
    let manager = SessionManager::new(
        sink.clone(),
        Arc::new(crate::sink::NoObserver),
        Arc::new(crate::harness::host::Host::new()),
        terminals.clone(),
        Arc::new(Default::default()),
        Arc::new(Default::default()),
        crate::hooks::prepare_control().unwrap(),
    );
    let rpc = WorkspaceRpc::new(&root, 7, sink, terminals.clone(), Some(manager.clone())).unwrap();
    let agent = quiet_agent(&base);
    let claude = crate::harness::claude::pty::claude_program_for_tests(PathBuf::from(&agent));
    rpc.set_offered_for_tests(
        crate::harness::catalog()
            .into_iter()
            .map(|mut harness| {
                harness.available = harness.id == "claude";
                harness.path = (harness.id == "claude").then(|| agent.clone());
                harness
            })
            .collect(),
    );
    let ops = crate::cloud_agents::ManagerOps { manager, root: root.to_string_lossy().into_owned() };
    let agents = crate::cloud_agents::CloudAgents::open(&base.join("agents"), Arc::new(ops), None, None, 7).unwrap();
    rpc.set_agents(agents);
    Fixture { _claude: claude, _home: home, _dir: dir, root, rpc, terminals }
}

impl Fixture {
    async fn assert_claude_launched(&self, created: &Value) {
        let session = crate::store::index::get(created["sessionId"].as_str().unwrap()).unwrap();
        let provider_id = session.tabs[0].provider_session_id.as_deref().expect("Claude conversation id");
        let marker = self._dir.path().join("agent.ran");
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(args) = std::fs::read_to_string(&marker) {
                let args: Vec<_> = args.lines().collect();
                if args.windows(2).any(|pair| pair == ["--session-id", provider_id]) {
                    std::fs::remove_file(&marker).unwrap();
                    break;
                }
            }
            assert!(tokio::time::Instant::now() < deadline, "stand-in Claude did not record --session-id {provider_id}");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let home = PathBuf::from(crate::store::state_home_env().unwrap());
        let config: Value = serde_json::from_slice(&std::fs::read(home.join("test-user-home/.claude.json")).unwrap()).unwrap();
        assert_eq!(config["projects"][&session.cwd]["hasTrustDialogAccepted"], true);
    }
}

async fn call(rpc: &Arc<WorkspaceRpc>, peer: &Arc<Peer>, method: &str, params: Value) -> Result<Value, (String, String)> {
    let response = rpc.handle(peer, &json!({ "id": "1", "method": method, "params": params })).await;
    if response["ok"] == true {
        Ok(response["result"].clone())
    } else {
        Err((response["error"]["code"].as_str().unwrap().to_string(), response["error"]["message"].as_str().unwrap().to_string()))
    }
}

async fn peer(rpc: &Arc<WorkspaceRpc>, device: &str, authority: Authority, want: &[&str]) -> (Arc<Peer>, Notifications) {
    let user = if authority == Authority::Manage { "admin" } else { "viewer" };
    let (peer, events) = Peer::for_user(device.into(), authority, Some(user.into()));
    call(rpc, &peer, "rpc.hello", json!({ "protocol": PROTOCOL, "want": want })).await.unwrap();
    (peer, events)
}

/// The pipelines announced to a connection within a short wait.
async fn announced(events: &mut Notifications) -> Vec<Value> {
    let mut heard = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_millis(800);
    while let Ok(Some(next)) = tokio::time::timeout_at(deadline, events.recv()).await {
        if next["event"] == "pipeline.changed" {
            heard.push(next["params"]["pipeline"].clone());
        }
    }
    heard
}

fn issue() -> Value {
    json!({ "provider": "github", "id": "433", "identifier": "#433", "title": "Carry issue sessions on", "url": "https://github.com/acme/widgets/issues/433" })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_non_issue_cloud_branch_uses_conflict_automation_but_never_workspace_auto_merge() {
    let f = fixture();
    let (manager, _) = peer(&f.rpc, "desktop", Authority::Manage, &["session/1", "pipeline/1"]).await;
    let (viewer, _) = peer(&f.rpc, "phone", Authority::Participate, &["pipeline/1"]).await;
    let created = call(&f.rpc, &manager, "session.create", json!({
        "clientRequestId": "plain-automation", "agent": "claude", "useWorktree": true,
        "title": "Improve the parser", "pipeline": true,
        "pipelineOptions": { "autoMerge": true, "resolveConflicts": true },
        "pipelineSettings": { "autoMerge": true }
    })).await.unwrap();
    let pipeline = &created["pipeline"];
    assert!(pipeline.get("issue").is_none());
    assert_eq!(pipeline["autoMerge"], false);
    assert_eq!(pipeline["resolveConflicts"], true);
    let id = pipeline["id"].as_str().unwrap();
    let params = json!({"clientRequestId": "resolve-switch", "pipeline": id, "value": false});
    assert!(call(&f.rpc, &viewer, "pipeline.resolveConflicts", params.clone()).await.is_err());
    let changed = call(&f.rpc, &manager, "pipeline.resolveConflicts", params).await.unwrap();
    assert_eq!(changed["pipeline"]["resolveConflicts"], false);
    assert_eq!(changed["pipeline"]["autoMerge"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_started_from_an_issue_is_carried_on_by_the_runtime_and_read_and_steered_from_a_desktop() {
    let f = fixture();
    let members = json!({ "v": 1, "members": [{ "userId": "admin", "role": "manager" }, { "userId": "viewer", "role": "viewer" }] });
    f.rpc.set_collaboration(Some(serde_json::from_value(members).unwrap()));
    let (manager, mut manager_events) = peer(&f.rpc, "desktop", Authority::Manage, &["session/1", "pipeline/1"]).await;
    let (viewer, mut viewer_events) = peer(&f.rpc, "phone", Authority::Participate, &["session/1", "pipeline/1"]).await;
    let (_older, mut older_events) = peer(&f.rpc, "older", Authority::Manage, &["session/1"]).await;

    let settings = json!({ "maxRounds": 2, "ignoredChecks": ["flaky"] });
    let created = call(
        &f.rpc,
        &manager,
        "session.create",
        json!({
            "clientRequestId": "request-0001", "agent": "claude", "useWorktree": true, "title": "#433 Carry issue sessions on",
            "prompt": "Work on GitHub issue #433", "issue": issue(), "issueBody": "Sessions stop at code.",
            "worktreeName": "433-carry-issue-sessions-on", "pipelineSettings": settings,
        }),
    )
    .await
    .unwrap();
    f.assert_claude_launched(&created).await;
    // The session carries the issue, in a worktree named after it.
    assert_eq!(created["session"]["issue"]["identifier"], "#433");
    assert_eq!(created["session"]["worktreeName"], "433-carry-issue-sessions-on");
    let session = crate::store::index::get(created["sessionId"].as_str().unwrap()).unwrap();
    assert_ne!(Path::new(&session.cwd), f.root);
    // Its pipeline started here, in the runtime, before the prompt went.
    let pipeline = &created["pipeline"];
    assert_eq!((pipeline["cloud"].as_bool(), pipeline["autoMerge"].as_bool(), pipeline["stage"].as_str()), (Some(true), Some(false), Some("work")));
    // The issue's text is kept here for the reviewer and never sent to a desktop.
    assert!(pipeline.get("issueBody").is_none());
    let kept = crate::issue_pipeline::store::get(pipeline["id"].as_str().unwrap()).unwrap();
    assert_eq!(kept.issue_body.as_deref(), Some("Sessions stop at code."));
    assert_eq!(pipeline["author"]["sessionId"], created["sessionId"]);
    assert_eq!(pipeline["maxRounds"], 2, "the desktop's settings for the project are the ones stored here");
    assert!(created["pipelineNote"].is_null());
    let stored = crate::store::projects::issue_pipeline_settings(&f.root.to_string_lossy()).unwrap();
    assert_eq!((stored.max_rounds, stored.ignored_checks.as_slice()), (2, ["flaky".to_string()].as_slice()));
    let id = pipeline["id"].as_str().unwrap().to_string();

    // Whoever may see the sessions hears of it and may read it; a desktop that did not ask for pipeline/1 does not.
    let heard = announced(&mut manager_events).await;
    assert!(heard.iter().any(|heard| heard["id"] == id.as_str()));
    assert!(heard.iter().all(|heard| heard.get("issueBody").is_none()));
    assert!(announced(&mut viewer_events).await.iter().any(|heard| heard["id"] == id.as_str()));
    assert!(announced(&mut older_events).await.is_empty());
    let listed = call(&f.rpc, &viewer, "pipeline.list", json!({})).await.unwrap();
    assert_eq!(listed["pipelines"].as_array().unwrap().len(), 1);
    assert_eq!(listed["truncated"], false);
    assert!(listed["pipelines"][0].get("issueBody").is_none());

    // Steering is the manager's, and a runtime never merges.
    assert_eq!(call(&f.rpc, &viewer, "pipeline.act", json!({ "clientRequestId": "request-0002", "pipeline": id, "action": "stop" })).await.unwrap_err().0, "forbidden");
    let merge = call(&f.rpc, &manager, "pipeline.act", json!({ "clientRequestId": "request-0003", "pipeline": id, "action": "merge" })).await.unwrap_err();
    assert_eq!(merge.0, "conflict");
    assert!(merge.1.contains("cloud workspace"), "{}", merge.1);
    let stopped = call(&f.rpc, &manager, "pipeline.act", json!({ "clientRequestId": "request-0004", "pipeline": id, "action": "stop" })).await.unwrap();
    assert_eq!((stopped["pipeline"]["state"].as_str(), stopped["pipeline"]["stopped"].as_bool()), (Some("stopped"), Some(true)));
    assert!(announced(&mut viewer_events).await.iter().any(|heard| heard["state"] == "stopped"));
    // A merge is noted only for a commit, and only for this workspace's own pipelines.
    let bad = call(&f.rpc, &manager, "pipeline.noteMerge", json!({ "clientRequestId": "request-0005", "pipeline": id, "commit": "main; rm -rf /" })).await.unwrap_err();
    assert_eq!(bad.0, "invalid_params");
    let missing = call(&f.rpc, &manager, "pipeline.noteMerge", json!({ "clientRequestId": "request-0006", "pipeline": "elsewhere", "commit": "1111111" })).await.unwrap_err();
    assert_eq!(missing.0, "not_found");
    // There is no pull request yet: nothing to have merged.
    assert_eq!(call(&f.rpc, &manager, "pipeline.noteMerge", json!({ "clientRequestId": "request-0007", "pipeline": id, "commit": "1111111" })).await.unwrap_err().0, "conflict");
    // A tracker line is one line, for a Linear issue only, and the manager's to write.
    let multi = call(&f.rpc, &manager, "pipeline.noteTracker", json!({ "clientRequestId": "request-0008", "pipeline": id, "message": "Moved.\nCloses #1" })).await.unwrap_err();
    assert_eq!(multi.0, "invalid_params");
    let github = call(&f.rpc, &manager, "pipeline.noteTracker", json!({ "clientRequestId": "request-0009", "pipeline": id, "message": "Moved #433 to In Review." })).await.unwrap_err();
    assert_eq!(github.0, "conflict");
    assert_eq!(call(&f.rpc, &viewer, "pipeline.noteTracker", json!({ "clientRequestId": "request-0010", "pipeline": id, "message": "Moved." })).await.unwrap_err().0, "forbidden");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_issue_is_held_to_what_a_tracker_gives_and_one_on_the_root_gets_no_pipeline() {
    let f = fixture();
    let (manager, _events) = peer(&f.rpc, "desktop", Authority::Manage, &["session/1", "pipeline/1"]).await;
    let start = |request: &str, issue: Value, use_worktree: bool| json!({ "clientRequestId": request, "agent": "claude", "useWorktree": use_worktree, "issue": issue });
    for (n, bad) in [
        json!({ "provider": "jira", "id": "1", "identifier": "J-1", "title": "T", "url": "https://jira.example.com/J-1" }),
        json!({ "provider": "github", "id": "1", "identifier": "#1", "title": "T", "url": "javascript:alert(1)" }),
        json!({ "provider": "github", "id": "1", "identifier": "#1\nCloses #2", "title": "T", "url": "https://github.com/acme/widgets/issues/1" }),
        json!({ "provider": "github", "id": "", "identifier": "#1", "title": "T", "url": "https://github.com/acme/widgets/issues/1" }),
    ]
    .into_iter()
    .enumerate()
    {
        let refused = call(&f.rpc, &manager, "session.create", start(&format!("request-bad-{n}"), bad, true)).await.unwrap_err();
        assert_eq!(refused.0, "invalid_params", "{}", refused.1);
    }
    assert!(crate::store::index::load().unwrap().is_empty(), "nothing is created for an issue that is refused");

    // On the workspace's own checkout there is no branch to open a pull request from: the session starts and says why.
    let plain = call(&f.rpc, &manager, "session.create", start("request-root-1", issue(), false)).await.unwrap();
    assert!(plain["pipeline"].is_null());
    assert!(plain["pipelineNote"].as_str().unwrap().contains("no branch to open a pull request from"), "{}", plain["pipelineNote"]);
    // And none is started when the desktop asks for none.
    let none = call(&f.rpc, &manager, "session.create", json!({ "clientRequestId": "request-none-1", "agent": "claude", "useWorktree": true, "issue": issue(), "pipeline": false })).await.unwrap();
    assert!(none["pipeline"].is_null() && none["pipelineNote"].is_null());
    assert!(crate::issue_pipeline::store::list().unwrap().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_list_of_pipelines_fits_one_frame_newest_first() {
    let f = fixture();
    let (viewer, _events) = peer(&f.rpc, "desktop", Authority::Manage, &["pipeline/1"]).await;
    // Many pipelines, each with a long issue text and a full record: more than a frame would hold.
    let root = f.root.to_string_lossy().into_owned();
    for n in 0..60 {
        let mut pipeline: crate::issue_pipeline::Pipeline = serde_json::from_value(json!({
            "id": format!("p{n:03}"), "projectPath": root, "issue": issue(), "branch": "raccoon/433",
            "author": { "sessionId": "s", "tabId": "t" }, "stage": "merge", "state": "merged", "maxRounds": 3,
            "issueBody": "x".repeat(16 * 1024), "created": format!("2026-10-18T00:{:02}:{:02}Z", n / 60, n % 60), "modified": "2026-10-18T00:00:00Z",
        }))
        .unwrap();
        for event in 0..200 {
            pipeline.record("2026-10-18T00:00:00Z", "note", format!("A line of the record that says what happened, number {event}."));
        }
        crate::issue_pipeline::store::insert(&pipeline).unwrap();
    }
    let listed = call(&f.rpc, &viewer, "pipeline.list", json!({})).await.unwrap();
    let pipelines = listed["pipelines"].as_array().unwrap();
    assert!(!pipelines.is_empty() && pipelines.len() <= 50, "{}", pipelines.len());
    assert_eq!(listed["truncated"], true);
    assert!(listed.to_string().len() < crate::remote::server::MAX_FRAME_BYTES, "{} bytes", listed.to_string().len());
    // The newest are the ones sent.
    assert_eq!(pipelines[0]["id"], "p059");
    assert!(pipelines.iter().all(|pipeline| pipeline.get("issueBody").is_none()));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_first_prompt_returns_an_openable_session_and_stops_only_its_pipeline() {
    let f = fixture();
    let (peer, _events) = peer(&f.rpc, "desktop", Authority::Manage, &["session/1", "pipeline/1"]).await;
    let existing = call(&f.rpc, &peer, "session.create", json!({
        "clientRequestId": "existing-start", "agent": "claude", "useWorktree": true, "issue": issue(),
    })).await.unwrap();
    f.assert_claude_launched(&existing).await;
    assert!(existing["startError"].is_null());
    // Admit a stand-in harness with no engine: the real manager.send path
    // fails synchronously, without depending on a shell exit or installed CLI.
    let mut failing = crate::harness::catalog().into_iter().find(|harness| harness.id == "claude").unwrap();
    failing.id = "test-failing-agent".into();
    failing.available = true;
    f.rpc.set_offered_for_tests(vec![failing]);
    let user_file = f.root.join("uncommitted.txt");
    std::fs::write(&user_file, "keep my work").unwrap();
    for (n, params) in [
        json!({ "useWorktree": true, "issue": issue() }), // implicit pipeline brief
        json!({ "useWorktree": true, "issue": issue(), "prompt": "Work on this" }),
        json!({ "issue": issue(), "prompt": "Work on this" }), // pipeline start refused on main
        json!({ "issue": issue(), "pipeline": false, "prompt": "Work on this" }),
        json!({ "prompt": "Work on this" }),
    ].into_iter().enumerate() {
        let mut params = params;
        params["agent"] = json!("test-failing-agent");
        params["clientRequestId"] = json!(format!("failed-start-{n}"));
        let created = call(&f.rpc, &peer, "session.create", params.clone()).await.unwrap();
        let message = created["startError"].as_str().unwrap();
        assert!(message.contains("first prompt could not be sent"), "{message}");
        assert!(created["outcome"].is_null());
        let session_id = created["sessionId"].as_str().unwrap();
        let tab_id = created["tabId"].as_str().unwrap();
        let session = crate::store::index::get(session_id).unwrap();
        assert!(Path::new(&session.cwd).is_dir());
        assert_eq!(created["tab"]["sessionId"], session_id);
        let events = f.rpc.manager().unwrap().load_events(session_id, tab_id).unwrap();
        assert!(events.iter().any(|event| matches!(&event.payload, crate::events::Payload::Status { text: recorded } if recorded == message)));
        if n < 2 {
            let pipeline = crate::issue_pipeline::store::for_session(session_id).unwrap().unwrap();
            assert!(pipeline.stopped);
            assert_eq!(pipeline.state, crate::issue_pipeline::State::Stopped);
            assert_eq!(created["pipeline"]["state"], "stopped");
            assert!(serde_json::to_string(&pipeline).unwrap().contains("first prompt could not be sent"));
        } else {
            assert!(created["pipeline"].is_null());
            if n == 2 {
                assert!(created["pipelineNote"].as_str().unwrap().contains("no branch"));
            }
        }
        // The mutation receipt keeps retries from creating another session.
        assert_eq!(call(&f.rpc, &peer, "session.create", params).await.unwrap(), created);
    }
    let existing_pipeline = crate::issue_pipeline::store::get(existing["pipeline"]["id"].as_str().unwrap()).unwrap();
    assert!(!existing_pipeline.stopped);
    assert_eq!(existing_pipeline.state, crate::issue_pipeline::State::Working);
    assert_eq!(std::fs::read_to_string(user_file).unwrap(), "keep my work");
    // Without a prompt or a pipeline there is nothing to launch, even now.
    let empty = call(&f.rpc, &peer, "session.create", json!({
        "clientRequestId": "empty-start", "agent": "test-failing-agent", "prompt": "  ", "pipeline": false,
    })).await.unwrap();
    assert!(empty["startError"].is_null() && empty["outcome"].is_null());
    assert_eq!(crate::store::index::load().unwrap().len(), 7);
}

#[tokio::test(flavor = "multi_thread")]
async fn failed_start_cleanup_reports_storage_failure_without_losing_the_session() {
    let f = fixture();
    let (peer, _events) = peer(&f.rpc, "desktop", Authority::Manage, &["session/1", "pipeline/1"]).await;
    let created = call(&f.rpc, &peer, "session.create", json!({
        "clientRequestId": "cleanup-start", "agent": "claude", "useWorktree": true, "issue": issue(),
    })).await.unwrap();
    f.assert_claude_launched(&created).await;
    let session_id = created["sessionId"].as_str().unwrap();
    let tab_id = created["tabId"].as_str().unwrap();
    let mut pipeline = created["pipeline"].clone();
    // An unreadable pipeline store must not mask the launch error or skip
    // stopping the partially launched process and recording its failure.
    let path = crate::store::root().unwrap().join("issue-pipelines.json");
    let saved = std::fs::read(&path).unwrap();
    std::fs::write(&path, "broken JSON").unwrap();
    let manager = f.rpc.manager().unwrap();
    let message = f.rpc.session_start_failed(manager, session_id, tab_id, &mut pipeline, anyhow::anyhow!("injected delivery failure"));
    std::fs::write(path, saved).unwrap();
    assert!(message.contains("injected delivery failure"));
    assert!(message.contains("Pipeline cleanup failed"));
    assert!(crate::store::index::get(session_id).is_ok());
    assert!(f.terminals.panes().is_empty());
    assert!(manager.load_events(session_id, tab_id).unwrap().iter().any(|event| matches!(&event.payload,
        crate::events::Payload::Status { text: recorded } if recorded == &message)));
}
