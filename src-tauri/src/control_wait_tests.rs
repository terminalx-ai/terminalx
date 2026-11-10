//! `wait` on several tabs at once (PRO-271), through the command the CLI
//! sends, on tabs put where an agent would put them.
use super::tests::headless_service;
use super::*;

/// One project with `count` sessions of one tab each, and the service that
/// answers for them. The home goes last, after the service that uses it.
struct Fixture {
    service: Arc<ControlService>,
    sessions: Vec<(String, String)>,
    _dir: tempfile::TempDir,
    _home: crate::store::TempHome,
}

impl Fixture {
    fn new(count: usize) -> Self {
        let home = crate::store::temp_home();
        let dir = tempfile::tempdir().unwrap();
        let project = projects::add(dir.path().to_str().unwrap()).unwrap();
        let sessions = (0..count)
            .map(|_| {
                let session = crate::session_ops::create_session_entry(serde_json::from_value(json!({
                    "projectPath": project.path, "useWorktree": false, "tab": {"harness": "codex"},
                })).unwrap()).unwrap();
                (session.id.clone(), session.tabs[0].id.clone())
            })
            .collect();
        let (service, _sink) = headless_service();
        let fixture = Self { service: Arc::new(service), sessions, _dir: dir, _home: home };
        // Every agent is in the middle of a turn until a test says otherwise.
        for i in 0..count {
            fixture.set(i, TabStatus::InProgress, false);
        }
        fixture
    }

    fn set(&self, i: usize, status: TabStatus, asks: bool) {
        let (session, tab) = &self.sessions[i];
        self.service.manager.set_wait_state_for_tests(session, tab, status, asks);
    }

    /// The same, a little after the wait has begun.
    fn set_later(&self, after: Duration, i: usize, status: TabStatus, asks: bool) -> std::thread::JoinHandle<()> {
        let (service, (session, tab)) = (self.service.clone(), self.sessions[i].clone());
        std::thread::spawn(move || {
            std::thread::sleep(after);
            service.manager.set_wait_state_for_tests(&session, &tab, status, asks);
        })
    }

    fn wait(&self, mode: Option<&str>, seconds: u64) -> Value {
        let targets: Vec<&String> = self.sessions.iter().map(|(session, _)| session).collect();
        self.service.execute("wait", json!({"targets": targets, "mode": mode, "timeoutSeconds": seconds}), "w").unwrap()
    }

    /// What the answer should list for target `i`.
    fn listed(&self, i: usize, state: &str, status: &str, changed: bool, reason: Option<&str>) -> Value {
        let (session, tab) = &self.sessions[i];
        let mut entry = json!({"target": session, "sessionId": session, "tabId": tab, "state": state, "status": status, "changed": changed});
        if let Some(reason) = reason {
            entry["reason"] = json!(reason);
        }
        entry
    }
}

const SOON: Duration = Duration::from_millis(200);

#[test]
fn any_returns_when_the_first_of_three_stops_and_names_it() {
    let fixture = Fixture::new(3);
    let began = Instant::now();
    let ends = fixture.set_later(SOON, 1, TabStatus::Completed, false);
    // `any` is what several targets get when no mode is named.
    let waited = fixture.wait(None, 30);
    ends.join().unwrap();
    assert!(began.elapsed() >= SOON && began.elapsed() < Duration::from_secs(10), "{:?}", began.elapsed());
    assert_eq!(waited, json!({"mode": "any", "timedOut": false, "targets": [
        fixture.listed(0, "running", "in_progress", false, None),
        fixture.listed(1, "stopped", "completed", true, Some("stop")),
        fixture.listed(2, "running", "in_progress", false, None),
    ]}));
}

#[test]
fn all_returns_only_when_every_target_has_stopped() {
    let fixture = Fixture::new(3);
    let began = Instant::now();
    let later = Duration::from_millis(600);
    let ends = [
        fixture.set_later(SOON, 0, TabStatus::Completed, false),
        fixture.set_later(SOON, 2, TabStatus::Idle, false),
        fixture.set_later(later, 1, TabStatus::Completed, false),
    ];
    let waited = fixture.wait(Some("all"), 30);
    ends.into_iter().for_each(|end| end.join().unwrap());
    // Two of the three having stopped was not enough.
    assert!(began.elapsed() >= later, "{:?}", began.elapsed());
    assert_eq!(waited, json!({"mode": "all", "timedOut": false, "targets": [
        fixture.listed(0, "stopped", "completed", true, Some("stop")),
        fixture.listed(1, "stopped", "completed", true, Some("stop")),
        fixture.listed(2, "stopped", "idle", true, Some("stopped")),
    ]}));
}

#[test]
fn a_timeout_marks_what_is_still_running() {
    let fixture = Fixture::new(3);
    let ends = fixture.set_later(SOON, 0, TabStatus::Completed, false);
    let waited = fixture.wait(Some("all"), 1);
    ends.join().unwrap();
    assert_eq!(waited, json!({"mode": "all", "timedOut": true, "targets": [
        fixture.listed(0, "stopped", "completed", true, Some("stop")),
        fixture.listed(1, "timedOut", "in_progress", false, None),
        fixture.listed(2, "timedOut", "in_progress", false, None),
    ]}));
    // `any` with nothing settled runs to its timeout the same way.
    fixture.set(0, TabStatus::InProgress, false);
    let waited = fixture.wait(Some("any"), 1);
    assert_eq!(waited["timedOut"], true);
    assert!(waited["targets"].as_array().unwrap().iter().all(|target| target["state"] == "timedOut" && target["changed"] == false), "{waited}");
}

#[test]
fn a_target_already_stopped_is_reported_at_once() {
    let fixture = Fixture::new(3);
    fixture.set(2, TabStatus::Completed, false);
    let began = Instant::now();
    let waited = fixture.wait(Some("any"), 30);
    assert!(began.elapsed() < Duration::from_secs(10), "{:?}", began.elapsed());
    // It stopped before the call, so it is not marked as changed during it.
    assert_eq!(waited, json!({"mode": "any", "timedOut": false, "targets": [
        fixture.listed(0, "running", "in_progress", false, None),
        fixture.listed(1, "running", "in_progress", false, None),
        fixture.listed(2, "stopped", "completed", false, Some("stop")),
    ]}));
    // `all` does not wait on it again: the other two are what it waits for.
    let ends = [fixture.set_later(SOON, 0, TabStatus::Completed, false), fixture.set_later(SOON, 1, TabStatus::Completed, false)];
    let waited = fixture.wait(Some("all"), 30);
    ends.into_iter().for_each(|end| end.join().unwrap());
    assert_eq!(waited["targets"], json!([
        fixture.listed(0, "stopped", "completed", true, Some("stop")),
        fixture.listed(1, "stopped", "completed", true, Some("stop")),
        fixture.listed(2, "stopped", "completed", false, Some("stop")),
    ]));
}

#[test]
fn a_permission_card_or_an_error_is_named_not_reported_as_running() {
    let fixture = Fixture::new(3);
    let asks = fixture.set_later(SOON, 0, TabStatus::Waiting, true);
    let waited = fixture.wait(Some("any"), 30);
    asks.join().unwrap();
    assert_eq!(waited["targets"][0], fixture.listed(0, "needsPermission", "waiting", true, Some("permission")));
    assert_eq!(waited["targets"][1]["state"], "running");

    // A prompt in the agent's own terminal waits on someone too; an error it stopped on is a failure.
    fixture.set(1, TabStatus::Waiting, false);
    let (session, tab) = &fixture.sessions[2];
    let log = crate::store::log_path(session, tab).unwrap();
    for (seq, payload) in [(1, json!({"type": "user_message", "text": "fix the login"})), (2, json!({"type": "recovery", "kind": "failed"}))] {
        let event = json!({"id": format!("e{seq}"), "sessionId": session, "tabId": tab, "harness": "codex", "seq": seq, "ts": index::now(), "payload": payload});
        crate::store::append_line(&log, &event.to_string()).unwrap();
    }
    fixture.set(2, TabStatus::Idle, false);
    fixture.service.manager.load_events(session, tab).unwrap();
    let waited = fixture.wait(Some("all"), 30);
    let mut failed = fixture.listed(2, "failed", "waiting", false, Some("recovery"));
    failed["recovery"] = json!("failed");
    assert_eq!(waited, json!({"mode": "all", "timedOut": false, "targets": [
        fixture.listed(0, "needsPermission", "waiting", false, Some("permission")),
        fixture.listed(1, "needsPermission", "waiting", false, Some("terminal")),
        failed,
    ]}));
}

#[test]
fn one_target_keeps_its_answer_and_a_list_is_checked_before_any_waiting() {
    let fixture = Fixture::new(2);
    fixture.set(0, TabStatus::Completed, false);
    let (session, tab) = &fixture.sessions[0];
    let single = fixture.service.execute("wait", json!({"target": session, "timeoutSeconds": 1}), "w").unwrap();
    assert_eq!(single, json!({"sessionId": session, "tabId": tab, "reason": "stop", "status": "completed"}));
    let timed_out = fixture.service.execute("wait", json!({"target": fixture.sessions[1].0, "timeoutSeconds": 0}), "w").unwrap();
    assert_eq!(timed_out["reason"], "timeout");
    // A tab is a target like a session, and is listed as it was named.
    let by_tab = fixture.service.execute("wait", json!({"targets": [tab], "mode": "all", "timeoutSeconds": 1}), "w").unwrap();
    assert_eq!(by_tab["targets"][0]["target"], json!(tab));
    assert_eq!(by_tab["targets"][0]["sessionId"], json!(session));

    let refused = |params: Value| fixture.service.execute("wait", params, "w").unwrap_err();
    assert_eq!(refused(json!({"targets": [session, "no-such-session"], "timeoutSeconds": 30})).code, "not_found");
    assert_eq!(refused(json!({"targets": [], "timeoutSeconds": 30})).code, "invalid_arguments");
    assert_eq!(refused(json!({"targets": [session, 7]})).code, "invalid_arguments");
    assert_eq!(refused(json!({"targets": [session], "mode": "most"})).code, "invalid_arguments");
}
