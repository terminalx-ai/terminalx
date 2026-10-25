#[test]
fn an_owner_stop_failure_keeps_the_workspace_and_never_records_a_removal() {
    let fixture = Fixture::new();
    let path = fixture.worktree("stop-refused");
    fixture.merge("stop-refused", 467);
    let first = fixture.session(&path, TabStatus::Idle);
    let second = fixture.session(&path, TabStatus::Idle);
    let original = index::load().unwrap();
    let calls = std::cell::Cell::new(0);
    let stop = |_: &SessionEntry| {
        calls.set(calls.get() + 1);
        if calls.get() == 2 { Err("fixture owner could not confirm process exit".to_string()) }
        else { Ok(()) }
    };
    let pull_requests = |_: &Path, _: &[String]| Ok(fixture.prs.lock().unwrap().as_ref().unwrap().clone());
    let scope = Scope { grace_seconds: 0, delete_sessions: true, ..fixture.on() };
    let result = fixture.with_host(|host| sweep_fallible(&FallibleSweep {
        host, sink: &*fixture.events, stop: &stop, pull_requests: &pull_requests, now: fixture.at(1),
    }, &scope).unwrap());
    assert_eq!(calls.get(), 2);
    let status = of(&result.statuses, &path);
    assert_eq!(status.phase, Phase::Kept);
    assert!(status.detail.as_deref().unwrap().contains("could not confirm process exit"));
    assert!(status.record.is_none());
    assert!(path.join("stop-refused.txt").is_file());
    assert_eq!(serde_json::to_value(index::load().unwrap()).unwrap(), serde_json::to_value(original).unwrap());
    assert!(index::get(&first.id).is_ok() && index::get(&second.id).is_ok());
    assert!(fixture.local_branch("stop-refused").is_some());
    assert!(fixture.remote_branch("stop-refused").is_some());
    assert!(fixture.with_host(|host| records(host).unwrap()).is_empty());
    // Once an explicit retry can stop both sessions, the same retained
    // workspace remains removable; failed admission did not corrupt its ledger.
    let result = fixture.with_host(|host| sweep_fallible(&FallibleSweep {
        host, sink: &*fixture.events, stop: &|_| Ok(()), pull_requests: &pull_requests, now: fixture.at(2),
    }, &scope).unwrap());
    assert_eq!(of(&result.statuses, &path).phase, Phase::Removed);
    assert!(!path.exists());
}
