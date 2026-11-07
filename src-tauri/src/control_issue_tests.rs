//! Exercise the same local owner path with and without the desktop feature.
use super::*;
use std::io::Read;
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::process::{Command, Stdio};

const CHILD: &str = "TERMINALX_TEST_ISSUE_START";

#[test]
fn local_issue_starts_read_trackers_before_creating_and_preserve_both_switches() {
    let dir = tempfile::tempdir().unwrap();
    let log_path = dir.path().join("child.log");
    let log = std::fs::File::create(&log_path).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "control::issue_tests::issue_start_child", "--nocapture"])
        .env(CHILD, "1").env("HOME", dir.path()).env("CLAUDE_CONFIG_DIR", dir.path().join("claude"))
        .stdout(log.try_clone().unwrap()).stderr(log).stdin(Stdio::null()).spawn().unwrap();
    let until = Instant::now() + Duration::from_secs(60);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() { break status; }
        if Instant::now() >= until {
            child.kill().unwrap(); child.wait().unwrap();
            panic!("issue start exceeded deadline: {}", std::fs::read_to_string(log_path).unwrap());
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
