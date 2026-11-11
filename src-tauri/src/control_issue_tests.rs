//! Exercise the same local owner path with and without the desktop feature.
use super::*;
use std::io::Read;
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};

const CHILD: &str = "TERMINALX_TEST_ISSUE_START";

#[test]
fn local_issue_starts_read_trackers_before_creating_and_preserve_both_switches() {
    run_child("issue_start_child");
}

fn run_child(name: &str) {
    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("child.log");
    let log = std::fs::File::create(&log_path).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", &format!("control::issue_tests::{name}"), "--nocapture"])
        .env(CHILD, "1").env("HOME", dir.path()).env("CLAUDE_CONFIG_DIR", dir.path().join("claude"))
        .stdout(log.try_clone().unwrap()).stderr(log).stdin(Stdio::null()).spawn().unwrap();
    let until = Instant::now() + Duration::from_secs(60);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        if Instant::now() >= until {
            child.kill().unwrap(); child.wait().unwrap();
            panic!("{name} exceeded deadline: {}", std::fs::read_to_string(log_path).unwrap());
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    assert!(status.success(), "{}", std::fs::read_to_string(log_path).unwrap());
}

#[test]
fn issue_start_child() {
    if std::env::var(CHILD).as_deref() != Ok("1") { return; }
    let _home = crate::store::temp_home();
    let root = crate::store::root().unwrap();
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    // Availability only: the prompt is queued, and no real agent is invoked.
    std::fs::write(bin.join("claude"), "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(bin.join("claude"), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(crate::binpath::set_priority_dir(&bin));
    let repo = super::tests::git_repo();
    let project = projects::add(repo.path().to_str().unwrap()).unwrap();
    let (service, _sink) = super::tests::headless_service();
    let service = service.with_local_lifetime(crate::local_runtime::Lifetime::new(Duration::from_secs(60)));
    let request = || json!({"project":project.path,"agent":"claude","issue":"ENG-42","provider":"linear","useWorktree":true});
    let error = service.execute("sessions.create", request(), "missing-key").unwrap_err();
    assert_eq!(error.code, "integration_unavailable");
    assert!(error.recovery.unwrap().contains("Settings"));
    assert!(index::load().unwrap().is_empty());

    let mut settings = crate::store::settings::load();
    settings.linear_api_key = Some("fixture-key".into());
    crate::store::settings::save(&settings).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut length = 0;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" { break; }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") { length = value.trim().parse().unwrap(); }
                }
            }
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let body: Value = serde_json::from_slice(&body).unwrap();
            let issue = if body["variables"]["id"] == "UNKNOWN-42" { Value::Null } else {
                json!({"id":"uuid-42","identifier":"ENG-42","title":"Fix login","description":"Keep the API stable.","url":"https://linear.app/acme/issue/ENG-42","state":{"name":"Todo","type":"unstarted"}})
            };
            let response = json!({"data":{"issue":issue}}).to_string();
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
        }
    });
    crate::issues::with_linear_api(url, || {
        let mut unknown = request(); unknown["issue"] = json!("UNKNOWN-42");
        let error = service.execute("sessions.create", unknown, "unknown").unwrap_err();
        assert_eq!(error.code, "issue_unavailable");
        assert!(error.recovery.unwrap().contains("Issues page"));
        assert!(index::load().unwrap().is_empty());
        assert!(crate::issue_pipeline::store::list().unwrap().is_empty());
        assert_eq!(crate::git::list_worktrees(repo.path()).unwrap().len(), 1);
        for (field, expected) in [(None, (true, true)), (Some("autoMerge"), (false, true)), (Some("resolveConflicts"), (true, false))] {
            let mut params = request();
            if let Some(field) = field { params[field] = json!(false); }
            let result = service.execute("sessions.create", params, "start").unwrap();
            assert_eq!(result["session"]["issue"]["identifier"], "ENG-42");
            assert_eq!((result["pipeline"]["autoMerge"].as_bool(), result["pipeline"]["resolveConflicts"].as_bool()), (Some(expected.0), Some(expected.1)), "{result}");
            assert_eq!(result["pipeline"]["issueBody"], "Keep the API stable.");
            let caller = json!({"session":result["sessionId"],"tab":result["tabId"]});
            for value in [false, true] {
                let changed = service.execute("pipelines.resolveConflicts", json!({"pipeline":result["pipeline"]["id"],"value":value,"caller":caller}), "switch").unwrap();
                assert_eq!(changed["pipeline"]["resolveConflicts"], value);
                assert_eq!(changed["pipeline"]["autoMerge"], expected.0);
            }
            let changed = service.execute("pipelines.autoMerge", json!({"pipeline":result["pipeline"]["id"],"value":!expected.0,"caller":caller}), "merge-switch").unwrap();
            let event = changed["pipeline"]["events"].as_array().unwrap().iter().rev().find(|event| event["kind"] == "autoMerge").unwrap();
            assert_eq!(event["actor"]["sessionId"], result["sessionId"]);
            assert!(event["message"].as_str().unwrap().contains("author session"));
        }
        for (merge, conflicts, person, expected) in [(Some(false), None, false, (false, true)), (None, Some(false), false, (true, false)), (None, None, true, (false, true))] {
            let options = projects::IssuePipelineSettings { auto_merge: merge, resolve_conflicts: conflicts, require_person: person, ..Default::default() };
            projects::update(&project.path, projects::ProjectPatch { issue_pipeline: Some(options), ..Default::default() }).unwrap();
            let result = service.execute("sessions.create", request(), "project-choice").unwrap();
            assert_eq!((result["pipeline"]["autoMerge"].as_bool(), result["pipeline"]["resolveConflicts"].as_bool()), (Some(expected.0), Some(expected.1)));
        }
    });
}

/// PRO-270: `sessions create` records who started the session it creates.
#[test]
fn a_session_created_from_inside_another_records_it_as_its_parent() {
    run_child("session_parent_child");
}

#[test]
fn session_parent_child() {
    if std::env::var(CHILD).as_deref() != Ok("1") { return; }
    let _home = crate::store::temp_home();
    let bin = crate::store::root().unwrap().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    // Availability only: the prompt is queued, and no real agent is invoked.
    std::fs::write(bin.join("claude"), "#!/bin/sh\nexit 0\n").unwrap();
    std::fs::set_permissions(bin.join("claude"), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(crate::binpath::set_priority_dir(&bin));
    let repo = super::tests::git_repo();
    let project = projects::add(repo.path().to_str().unwrap()).unwrap();
    let (service, _sink) = super::tests::headless_service();
    let service = service.with_local_lifetime(crate::local_runtime::Lifetime::new(Duration::from_secs(60)));
    let create = |extra: Value| {
        let mut params = json!({"project": project.path, "agent": "claude", "prompt": "go", "useWorktree": true, "noPipeline": true});
        params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        service.execute("sessions.create", params, "create")
    };
    let stored = |created: &Value| index::get(created["sessionId"].as_str().unwrap()).unwrap().parent;

    // Started by a person, from a shell: nobody is recorded, and the entry has no such field.
    let lead = create(json!({})).unwrap();
    assert_eq!((&lead["parent"], stored(&lead)), (&Value::Null, None));
    assert!(lead["session"].get("parent").is_none());
    let caller = json!({"session": lead["sessionId"], "tab": lead["tabId"]});
    let from_lead = json!({"sessionId": lead["sessionId"], "tabId": lead["tabId"]});

    // Started from inside the lead: the response and the index both say so.
    let worker = create(json!({"caller": caller})).unwrap();
    assert_eq!((&worker["parent"], &worker["session"]["parent"]), (&from_lead, &from_lead));
    assert_eq!(serde_json::to_value(stored(&worker)).unwrap(), from_lead);
    // A quick chat started there is the lead's too.
    let quick = service.execute("sessions.create", json!({"quick": true, "agent": "claude", "prompt": "go", "caller": caller}), "quick").unwrap();
    assert_eq!(quick["parent"], from_lead);
    // --parent names another session; --no-parent records nobody though the lead asked.
    let named = create(json!({"caller": caller, "parent": worker["sessionId"]})).unwrap();
    assert_eq!(named["parent"], json!({"sessionId": worker["sessionId"]}));
    let nobody = create(json!({"caller": caller, "noParent": true})).unwrap();
    assert_eq!((&nobody["parent"], stored(&nobody)), (&Value::Null, None));

    // An unknown parent is refused by its own code, with no session and no worktree left behind.
    let (sessions, worktrees) = (index::load().unwrap().len(), crate::git::list_worktrees(repo.path()).unwrap().len());
    let refused = create(json!({"caller": caller, "parent": "no-such-session"})).unwrap_err();
    assert_eq!(refused.code, "parent_not_found");
    assert_eq!(create(json!({"parent": lead["sessionId"], "noParent": true})).unwrap_err().code, "invalid_arguments");
    assert_eq!((index::load().unwrap().len(), crate::git::list_worktrees(repo.path()).unwrap().len()), (sessions, worktrees));

    // The lead's workers are exactly the two it started, each in a worktree of its own or none.
    let listed = service.execute("sessions.children", json!({"childrenOf": lead["sessionId"]}), "list").unwrap();
    let workers: std::collections::BTreeSet<&str> = listed["workers"].as_array().unwrap().iter().map(|row| row["sessionId"].as_str().unwrap()).collect();
    assert_eq!(workers, [worker["sessionId"].as_str().unwrap(), quick["sessionId"].as_str().unwrap()].into());
    let row = listed["workers"].as_array().unwrap().iter().find(|row| row["sessionId"] == worker["sessionId"]).unwrap();
    assert_eq!((&row["worktree"], &row["branch"], &row["path"], &row["agent"]), (&worker["worktreeName"], &worker["branch"], &worker["path"], &json!("claude")));
    assert_eq!(service.execute("sessions.children", json!({"childrenOf": worker["sessionId"]}), "list").unwrap()["workers"].as_array().unwrap().len(), 1);
}

#[test]
fn local_issue_creation_dispatches_without_a_desktop() {
    run_child("issue_creation_child");
}

#[test]
fn issue_creation_child() {
    if std::env::var(CHILD).as_deref() != Ok("1") { return; }
    let _home = crate::store::temp_home();
    let root = crate::store::root().unwrap();
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let github: Value = serde_json::from_str(include_str!("fixtures/github_issue_ops.json")).unwrap();
    let created = &github["steps"]["create"][0]["reply"];
    std::fs::write(bin.join("created.json"), created.to_string()).unwrap();
    std::fs::write(bin.join("gh"), r#"#!/bin/sh
fixture_dir=$(dirname "$0")
case "$3:$6" in
  GET:repos/acme/widgets) printf '%s' '{"full_name":"acme/widgets"}' ;;
  POST:repos/acme/widgets/issues)
    cat >> "$fixture_dir/posts.jsonl"
    printf '\n' >> "$fixture_dir/posts.jsonl"
    if [ -f "$fixture_dir/reject" ]; then
      printf '%s' 'HTTP 401: Bad credentials' >&2
      exit 1
    fi
    cat "$fixture_dir/created.json"
    ;;
  *) exit 99 ;;
esac
"#).unwrap();
    std::fs::set_permissions(bin.join("gh"), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(crate::binpath::set_priority_dir(&bin));
    let repo = super::tests::git_repo();
    let project = projects::add(repo.path().to_str().unwrap()).unwrap();
    let (service, _sink) = super::tests::headless_service();
    let lifetime = crate::local_runtime::Lifetime::new(Duration::from_secs(60));
    assert!(!lifetime.window.available());
    let service = service.with_local_lifetime(lifetime);
    let request = |provider: &str| json!({"project":project.path,"provider":provider,"title":"File this issue"});

    #[cfg(not(feature = "desktop"))]
    {
        let (cloud, _) = super::tests::headless_service();
        assert_eq!(cloud.execute("issues.create", request("github"), "cloud-unchanged").unwrap_err().code, "unsupported");
    }

    // Real dispatch must reach the existing configuration checks, even with
    // no desktop attached. This used to answer desktop_unavailable instead.
    for (provider, code) in [("github", "not_found"), ("linear", "not_signed_in")] {
        assert_eq!(service.execute("issues.create", request(provider), "missing-config").unwrap_err().code, code);
    }
    // Only creation moves out of window dispatch.
    for command in ["issues.comment", "issues.status", "issues.assign", "issues.label"] {
        assert_eq!(service.execute(command, json!({}), "still-window-owned").unwrap_err().code, "desktop_unavailable");
    }

    assert!(Command::new("git").args(["remote", "add", "origin", "https://github.com/acme/widgets.git"]).current_dir(repo.path()).status().unwrap().success());
    let result = service.execute("issues.create", request("github"), "github-create").unwrap();
    assert_eq!(result["issue"]["identifier"], "#530");
    assert_eq!(result["issue"]["url"], created["html_url"]);
    std::fs::write(bin.join("reject"), "").unwrap();
    assert_eq!(service.execute("issues.create", request("github"), "github-failure").unwrap_err().code, "not_signed_in");
    let posts = std::fs::read_to_string(bin.join("posts.jsonl")).unwrap();
    assert_eq!(posts.lines().count(), 2, "one submission per command, without retries");
    for post in posts.lines() {
        assert_eq!(serde_json::from_str::<Value>(post).unwrap()["title"], "File this issue");
    }

    let mut settings = crate::store::settings::load();
    settings.linear_api_key = Some("fixture-key".into());
    crate::store::settings::save(&settings).unwrap();
    let linear: Value = serde_json::from_str(include_str!("fixtures/linear_issue_writes.json")).unwrap();
    let creation = linear["issueCreate"].clone();
    let issue = creation["data"]["issueCreate"]["issue"].clone();
    let team = issue["team"].clone();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = std::thread::spawn(move || {
        let mut creates = 0;
        for mut stream in listener.incoming().take(4).map(Result::unwrap) {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut length = 0;
            let mut authorized = false;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" { break; }
                if let Some((name, value)) = line.split_once(':') {
                    if name.eq_ignore_ascii_case("content-length") { length = value.trim().parse().unwrap(); }
                    if name.eq_ignore_ascii_case("authorization") { authorized = value.trim() == "fixture-key"; }
                }
            }
            assert!(authorized, "the runtime uses the configured credentials");
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            let body: Value = serde_json::from_slice(&body).unwrap();
            let (status, response) = if body["query"].as_str().unwrap().contains("issueCreate(") {
                creates += 1;
                assert_eq!(body["variables"]["input"]["teamId"], team["id"]);
                assert_eq!(body["variables"]["input"]["title"], "File this issue");
                if creates == 1 { ("200 OK", creation.clone()) } else { ("401 Unauthorized", json!({"errors":[{"extensions":{"code":"AUTHENTICATION_ERROR"}}]})) }
            } else {
                assert!(body["query"].as_str().unwrap().contains("teams(first:"));
                ("200 OK", json!({"data":{"teams":{"nodes":[team]}}}))
            };
            let response = response.to_string();
            write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).unwrap();
        }
        assert_eq!(creates, 2);
    });
    crate::issues::with_linear_api(url, || {
        let result = service.execute("issues.create", request("linear"), "linear-create").unwrap();
        assert_eq!(result["issue"]["identifier"], issue["identifier"]);
        assert_eq!(result["issue"]["url"], issue["url"]);
        assert_eq!(service.execute("issues.create", request("linear"), "linear-failure").unwrap_err().code, "not_signed_in");
    });
    server.join().unwrap();
}

#[test]
fn a_run_goes_from_plan_to_approved_workers_in_their_own_worktrees() {
    run_child("orchestration_run_child");
}

/// A run through the control service, as `terminalx runs` and the window's
/// Approve drive it, against a real repository and a stand-in `claude`.
#[test]
fn orchestration_run_child() {
    if std::env::var(CHILD).as_deref() != Ok("1") { return; }
    let _home = crate::store::temp_home();
    let bin = crate::store::root().unwrap().join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    // It records how it was launched and then sits there, as an agent waiting for its first
    // prompt does: what a worker is started with is what is checked. One file a launch, moved
    // into place when it is whole: the lead and a worker may start at the same moment.
    let launches = crate::store::root().unwrap().join("launches");
    std::fs::create_dir_all(&launches).unwrap();
    std::fs::write(bin.join("claude"), format!("#!/bin/sh\ncase \"$*\" in *--settings*) printf '%s' \"$*\" > \"{0}/.$$\" && mv \"{0}/.$$\" \"{0}/launch.$$\"; stty -icanon; exec cat ;; esac\nexit 0\n", launches.display())).unwrap();
    std::fs::set_permissions(bin.join("claude"), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(crate::binpath::set_priority_dir(&bin));
    let repo = super::tests::git_repo();
    let project = projects::add(repo.path().to_str().unwrap()).unwrap();
    let (service, sink) = super::tests::headless_service();
    let service = service.with_local_lifetime(crate::local_runtime::Lifetime::new(Duration::from_secs(60)));
    let git = |dir: &str, args: &[&str]| crate::git::run(std::path::Path::new(dir), args).map(|out| out.trim().to_string());

    // The lead, on a branch of its own with a commit `main` does not have.
    let lead = service.execute("sessions.create", json!({"project": project.path, "agent": "claude", "prompt": "plan it", "useWorktree": true, "noPipeline": true}), "lead").unwrap();
    let (lead_id, lead_path, lead_branch) = (lead["sessionId"].as_str().unwrap(), lead["path"].as_str().unwrap(), lead["branch"].as_str().unwrap());
    git(lead_path, &["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "the lead's own commit"]).unwrap();
    let lead_head = git(lead_path, &["rev-parse", "HEAD"]).unwrap();
    assert_ne!(lead_head, git(repo.path().to_str().unwrap(), &["rev-parse", "main"]).unwrap());
    let caller = json!({"session": lead_id, "tab": lead["tabId"]});
    let plan = json!({"goal": "Move settings reads to the typed store", "pieces": [
        {"id": "store", "title": "Typed store module", "kind": "code", "doneChecks": [{"type": "command", "run": "cargo t store"}], "owns": ["src/store/"], "model": "sonnet", "effort": "high", "readFirst": ["docs/SETTINGS.md"]},
        {"id": "docs", "title": "Update the docs", "kind": "scoped-code", "doneChecks": [{"type": "command", "run": "every key is documented"}], "owns": ["docs/"], "dependsOn": ["store"], "model": "sonnet", "effort": "medium", "permissionMode": "acceptEdits"},
    ]});

    // Each rule refuses with its own code and the piece, and leaves nothing behind.
    let refused = |change: &dyn Fn(&mut Value)| {
        let mut broken = plan.clone();
        change(&mut broken);
        service.execute("runs.create", json!({"plan": broken, "caller": caller}), "refused").unwrap_err()
    };
    let error = refused(&|plan| plan["pieces"][1]["doneChecks"] = json!([]));
    assert_eq!((error.code.as_str(), error.details.as_ref().unwrap()["piece"].as_str()), ("no_done_check", Some("docs")));
    let error = refused(&|plan| plan["pieces"][1]["owns"] = json!(["src/store/settings.rs"]));
    assert_eq!((error.code.as_str(), error.details.as_ref().unwrap()["piece"].as_str(), error.details.as_ref().unwrap()["other"].as_str()), ("shared_file", Some("docs"), Some("store")));
    let error = refused(&|plan| plan["pieces"][0]["dependsOn"] = json!(["docs"]));
    assert_eq!((error.code.as_str(), error.details.as_ref().unwrap()["piece"].as_str()), ("dependency_cycle", Some("store")));
    assert_eq!(refused(&|plan| *plan = json!({"pieces": "none"})).code, "plan_invalid");
    // A key the plan format does not have is refused, not dropped: this mode would have run as bypass.
    let error = refused(&|plan| plan["pieces"][1]["mode"] = json!("manual"));
    assert_eq!((error.code.as_str(), error.details.clone().unwrap()), ("unknown_key", json!({"key": "mode", "meant": "permissionMode", "piece": "docs"})));
    // The piece limit is the setting: one piece allowed refuses this plan of two, and names the limit.
    let mut settings = crate::store::settings::load();
    settings.orchestrator.projects.entry(project.path.clone()).or_default().piece_limit = Some(1);
    crate::store::settings::save(&settings).unwrap();
    let error = service.execute("runs.create", json!({"plan": plan, "caller": caller}), "limit").unwrap_err();
    assert_eq!((error.code.as_str(), error.details.clone().unwrap()), ("too_many_pieces", json!({"limit": 1, "pieces": 2})));
    assert!(error.message.contains("the limit is 1"), "{}", error.message);
    settings.orchestrator.projects.clear();
    crate::store::settings::save(&settings).unwrap();
    // Outside any session there is no lead to run for.
    assert_eq!(service.execute("runs.create", json!({"plan": plan}), "nobody").unwrap_err().code, "lead_required");
    assert!(service.execute("runs.list", json!({"all": true}), "list").unwrap()["runs"].as_array().unwrap().is_empty());

    // A valid plan is a run that waits for a person.
    let mut heard = sink.subscribe_app();
    let created = service.execute("runs.create", json!({"plan": plan, "caller": caller}), "create").unwrap();
    let run_id = created["run"]["id"].as_str().unwrap().to_string();
    assert_eq!((&created["approvalRequired"], &created["run"]["state"], &created["run"]["lead"]), (&json!(true), &json!("awaitingApproval"), &json!({"sessionId": lead_id, "tabId": lead["tabId"]})));
    let told = std::iter::from_fn(|| heard.try_recv().ok()).any(|published| &*published.event == crate::orchestration::RUN_EVENT && serde_json::from_str::<Value>(&published.payload).is_ok_and(|run| run["id"] == run_id.as_str() && run["state"] == "awaitingApproval"));
    assert!(told, "the window is told of the run");
    let sessions_before = index::load().unwrap().len();
    let error = service.execute("runs.start", json!({"run": run_id}), "start").unwrap_err();
    assert_eq!(error.code, "awaiting_approval");
    // Inside the lead's session the run need not be named.
    assert_eq!(service.execute("runs.start", json!({"caller": caller}), "start").unwrap_err().code, "awaiting_approval");
    assert_eq!((index::load().unwrap().len(), crate::git::list_worktrees(repo.path()).unwrap().len()), (sessions_before, 2), "no worker before approval");

    // A person approves, in the window: the first piece's worker starts, and only that one.
    let approved = service.manager.orchestration("approve", json!({"id": run_id})).unwrap();
    assert_eq!((&approved["started"], &approved["run"]["state"]), (&json!(["store"]), &json!("running")));
    let shown = service.execute("runs.show", json!({"caller": caller}), "show").unwrap();
    assert_eq!((&shown["id"], &shown["pieces"][0]["state"], &shown["pieces"][1]["state"]), (&json!(run_id), &json!("running"), &json!("queued")));
    assert_eq!(shown["waiting"], json!([{"piece": "docs", "on": ["store"]}]));
    let piece = &shown["pieces"][0];
    let worker = index::get(piece["worker"]["sessionId"].as_str().unwrap()).unwrap();
    let tab = worker.tab(piece["worker"]["tabId"].as_str().unwrap()).unwrap();
    // Its own session, started by the lead, with the planned model and effort, in bypass.
    assert_eq!(serde_json::to_value(&worker.parent).unwrap(), json!({"sessionId": lead_id, "tabId": lead["tabId"]}));
    assert_eq!((tab.harness.as_str(), tab.model.as_str(), tab.effort.as_deref(), tab.permission_mode.as_str()), ("claude", "sonnet", Some("high"), "bypassPermissions"));
    assert_eq!(piece["startedMode"], "bypassPermissions");
    assert!(crate::worker_report::expected(&worker.id, &tab.id), "the worker is held to a report");
    // Its own worktree and branch, cut from the lead's branch, with no upstream.
    let branch = worker.branch.as_deref().unwrap();
    assert_eq!(piece["branch"], branch);
    assert!(worker.cwd != lead_path && branch != lead_branch && worker.worktree_name.is_some());
    assert_eq!(git(&worker.cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap(), branch);
    assert_eq!(git(&worker.cwd, &["rev-parse", "HEAD"]).unwrap(), lead_head, "branched from the lead's branch, not from main");
    assert!(git(&worker.cwd, &["rev-parse", "--abbrev-ref", &format!("{branch}@{{upstream}}")]).is_err(), "the branch has no upstream");
    assert_eq!(crate::git::list_worktrees(repo.path()).unwrap().len(), 3);
    // It is a run's worker, and the lead is not.
    assert!(crate::orchestration::guard::limited(&worker));
    assert!(!crate::orchestration::guard::limited(&index::get(lead_id).unwrap()));

    // The worker's agent was launched in bypass with the deny rules in its settings; the lead's
    // own launch carries none.
    let until = Instant::now() + Duration::from_secs(20);
    let (launch, leads) = loop {
        let started: Vec<String> = std::fs::read_dir(&launches).unwrap().filter_map(|entry| entry.ok()).filter(|entry| entry.file_name().to_string_lossy().starts_with("launch.")).filter_map(|entry| std::fs::read_to_string(entry.path()).ok()).collect();
        let (limited, free): (Vec<&String>, Vec<&String>) = started.iter().partition(|launch| launch.contains("Bash(git push:*)"));
        if let (Some(worker), Some(lead)) = (limited.first(), free.first()) {
            assert_eq!((limited.len(), free.len()), (1, 1), "one worker and one lead were launched");
            break (worker.to_string(), lead.to_string());
        }
        assert!(Instant::now() < until, "no launch of the worker with deny rules and of the lead without, in: {started:?}");
        std::thread::sleep(Duration::from_millis(50));
    };
    for said in ["--dangerously-skip-permissions", "Bash(git merge:*)", "Bash(gh pr merge:*)", "Bash(npm publish:*)", "--model sonnet"] {
        assert!(launch.contains(said), "{said} is missing from the worker's launch: {launch}");
    }
    assert!(!leads.contains("\"deny\"") && !leads.contains("--model sonnet"), "{leads}");

    // A worker gets no pipeline: one would push its branch and merge it for it.
    for (command, params) in [("pipelines.start", json!({"target": worker.id})), ("pipelines.start", json!({"target": tab.id, "autoMerge": true, "adoptPr": true}))] {
        let error = service.execute(command, params, "pipeline").unwrap_err();
        assert!(error.message.contains("worker of an orchestration run"), "{}", error.message);
    }
    assert!(crate::issue_pipeline::store::for_session(&worker.id).unwrap().is_none());
    // The lead may still have one, as any session.
    assert!(service.execute("pipelines.start", json!({"target": lead_id}), "pipeline").is_ok());
    // A session the worker starts has the worker's limits, and so has one that session starts.
    let from = |session: &str, tab: &str| service.execute("sessions.create", json!({"project": project.path, "agent": "claude", "prompt": "help", "useWorktree": true, "noPipeline": true, "caller": {"session": session, "tab": tab}}), "child").unwrap();
    let child = from(&worker.id, &tab.id);
    let grandchild = from(child["sessionId"].as_str().unwrap(), child["tabId"].as_str().unwrap());
    for started in [&child, &grandchild] {
        let entry = index::get(started["sessionId"].as_str().unwrap()).unwrap();
        assert!(entry.run_worker() && crate::orchestration::guard::limited(&entry));
        assert!(service.execute("pipelines.start", json!({"target": entry.id}), "pipeline").unwrap_err().message.contains("worker of an orchestration run"));
    }
    // Whoever it names as its parent, or none: what counts is who asked.
    for extra in [json!({"noParent": true}), json!({"parent": lead_id})] {
        let mut params = json!({"project": project.path, "agent": "claude", "prompt": "help", "useWorktree": true, "noPipeline": true, "caller": {"session": worker.id, "tab": tab.id}});
        params.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        let loose = service.execute("sessions.create", params, "loose").unwrap();
        assert!(index::get(loose["sessionId"].as_str().unwrap()).unwrap().run_worker(), "{extra}");
    }
    // A worker changes no pipeline, its own or the lead's; it may read them.
    let leads = crate::issue_pipeline::store::for_session(lead_id).unwrap().unwrap().id;
    let as_worker = json!({"session": worker.id, "tab": tab.id});
    for (command, params) in [
        ("pipelines.start", json!({"target": lead_id})),
        ("pipelines.act", json!({"pipeline": leads, "action": "stop"})),
        ("pipelines.act", json!({"pipeline": leads, "action": "merge"})),
        ("pipelines.autoMerge", json!({"pipeline": leads, "value": true})),
        ("pipelines.resolveConflicts", json!({"pipeline": leads, "value": true})),
    ] {
        let mut params = params;
        params["caller"] = as_worker.clone();
        let error = service.execute(command, params, "pipeline").unwrap_err();
        assert_eq!(error.code, "forbidden", "{command}: {}", error.message);
    }
    assert!(service.execute("pipelines.show", json!({"pipeline": leads, "caller": as_worker}), "show").unwrap().to_string().contains(leads.as_str()));
    assert!(!crate::issue_pipeline::store::get(&leads).unwrap().stopped);
    // One the lead starts by hand is an ordinary session.
    assert!(!index::get(from(lead_id, lead["tabId"].as_str().unwrap())["sessionId"].as_str().unwrap()).unwrap().run_worker());

    // Called again while `store` works, `runs start` starts nothing; `docs` still waits.
    let again = service.execute("runs.start", json!({"run": run_id}), "start").unwrap();
    assert_eq!((&again["started"], &again["waiting"]), (&json!([]), &json!([{"piece": "docs", "on": ["store"]}])));
    assert_eq!(service.execute("runs.list", json!({"lead": lead_id}), "list").unwrap()["runs"].as_array().unwrap().len(), 1);
    // A second run for the same lead waits its turn.
    assert_eq!(service.execute("runs.create", json!({"plan": plan, "caller": caller}), "second").unwrap_err().code, "run_exists");

    // Stopped: the run says so, nothing more starts, and the session and its worktree stay.
    let stopped = service.execute("runs.stop", json!({"run": &run_id[..13]}), "stop").unwrap();
    assert_eq!((&stopped["run"]["state"], &stopped["run"]["pieces"][0]["state"], &stopped["run"]["pieces"][1]["state"]), (&json!("stopped"), &json!("stopped"), &json!("stopped")));
    assert_eq!(service.execute("runs.start", json!({"run": run_id}), "start").unwrap_err().code, "run_ended");
    assert!(index::get(&worker.id).is_ok() && std::path::Path::new(&worker.cwd).is_dir());
    assert!(service.execute("runs.list", json!({}), "list").unwrap()["runs"].as_array().unwrap().is_empty(), "an ended run is listed only with --all");
    assert_eq!(service.execute("runs.list", json!({"all": true}), "list").unwrap()["runs"].as_array().unwrap().len(), 1);
    assert_eq!(service.execute("runs.show", json!({"run": "no-such-run"}), "show").unwrap_err().code, "not_found");
    // Once a worker, always one: stopping the run does not lift the limits from its session.
    assert!(crate::orchestration::guard::limited(&worker));
}
