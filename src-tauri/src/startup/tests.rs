use super::*;

pub(super) fn launch(pane: &str, phase: Phase) -> Launch {
    Launch { startup_proven: false, id: uuid::Uuid::new_v4().to_string(), pane: pane.into(), generation: "generation".into(), pid: Some(42),
        category: Category::Agent, evidence: Evidence::Readiness, phase, started_at: 0, last_progress_at: 0,
        exit_code: None, cpu_time: None, resident_bytes: None, pid_birth: None, recorder: None, pipeline_id: None, recorder_owner: None, recorder_exit: None }
}

#[test]
fn never_ready_children_make_one_incident_and_escalate_without_metadata_changes() {
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(119_999);
    assert!(state.active().is_none());
    state.tick(120_000);
    let id = state.active().unwrap().id.clone();
    state.launches.push(launch("tab:b", Phase::Spawning));
    for at in [125_000, 130_000, 419_999] { state.tick(at); }
    assert_eq!(state.incidents.len(), 1);
    assert_eq!(state.active().unwrap().launches.len(), 2);
    assert!(state.active().unwrap().escalated_at.is_none());
    // Simulates a monitor restart. Wall-clock incident age survives it.
    let mut restored: Snapshot = serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
    restored.tick(420_000);
    restored.tick(900_000);
    assert_eq!(restored.active().unwrap().id, id);
    assert_eq!(restored.active().unwrap().escalated_at, Some(420_000));
}

#[test]
fn quiet_running_compiles_and_human_prompts_are_not_failed() {
    let mut state = Snapshot { launches: vec![launch("compile", Phase::Running), launch("human", Phase::PermissionPrompt)], ..Snapshot::default() };
    state.tick(86_400_000);
    assert!(state.active().is_none());
    assert_eq!(state.launches[1].phase, Phase::PermissionPrompt);
}

#[test]
fn history_retention_does_not_forget_live_roots_or_pending_validation() {
    let mut pending = launch("validation", Phase::Running);
    pending.recorder = Some(uuid::Uuid::new_v4().to_string());
    pending.pipeline_id = Some("pipeline".into());
    let live = launch("tab:live", Phase::Running);
    let mut state = Snapshot { launches: vec![pending.clone(), live.clone()], ..Snapshot::default() };
    state.launches.extend((0..HISTORY).map(|_| launch("old", Phase::Exited)));
    state.tick(1_000_000);
    assert_eq!(state.launches.len(), HISTORY);
    assert!(state.launches.contains(&pending));
    assert!(state.launches.contains(&live));
}

#[test]
fn an_unknown_permission_snapshot_preserves_the_last_known_human_wait() {
    let directory = tempfile::tempdir().unwrap();
    let monitor = Monitor { directory: directory.path().into() };
    let state = Snapshot { launches: vec![launch("tab:a", Phase::PermissionPrompt)], ..Snapshot::default() };
    crate::store::write_json(&directory.path().join("incidents.json"), &state).unwrap();
    monitor.poll(&crate::pty::Terminals::new(), None).unwrap();
    let state: Snapshot = crate::store::read_json(&directory.path().join("incidents.json")).unwrap().unwrap();
    assert_eq!(state.launches[0].phase, Phase::PermissionPrompt);
    assert!(state.active().is_none());
}

#[test]
fn an_unreadable_validation_record_does_not_stop_incident_escalation() {
    let directory = tempfile::tempdir().unwrap();
    let monitor = Monitor { directory: directory.path().into() };
    let mut pending = launch("validation", Phase::Running);
    let recorder = uuid::Uuid::new_v4().to_string();
    let path = crate::store::ensure_dir(directory.path().join(&recorder)).unwrap();
    pending.recorder = Some(recorder);
    std::fs::write(path.join("validation.json"), b"{incomplete").unwrap();
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady), pending], ..Snapshot::default() };
    state.tick(120_000);
    crate::store::write_json(&directory.path().join("incidents.json"), &state).unwrap();
    monitor.poll(&crate::pty::Terminals::new(), Some(&[])).unwrap();
    let mut state: Snapshot = crate::store::read_json(&directory.path().join("incidents.json")).unwrap().unwrap();
    assert!(state.active().unwrap().escalated_at.is_some());
    assert!(validation::refresh(directory.path(), &mut state).is_err(), "bad records still fail admission closed");
}

#[test]
fn tickets_preserve_late_exact_exit_and_do_not_overwrite_a_new_generation() {
    let directory = tempfile::tempdir().unwrap();
    let monitor = Arc::new(Monitor { directory: directory.path().into() });
    let old = monitor.begin("tab:a", "first", None).unwrap();
    old.spawned(Some(42));
    update_at(directory.path(), |state| { state.tick(now() + 120_000); Ok(()) }).unwrap();
    let new = monitor.begin("tab:a", "second", Some(43)).unwrap();
    new.ready();
    old.exited(Some(23));
    let state: Snapshot = crate::store::read_json(&directory.path().join("incidents.json")).unwrap().unwrap();
    assert_eq!(state.launches[0].exit_code, Some(23));
    assert_eq!(state.launches[1].phase, Phase::Running);
    assert_eq!(state.launches[1].exit_code, None);
    assert!(state.active().is_some(), "an exit alone does not demonstrate recovery");
}

#[test]
fn export_allowlist_excludes_secrets_even_in_identifiers_and_child_output() {
    let secret = "token=secret /Users/alice/private source prompt transcript history alice@example.com";
    let mut state = Snapshot { launches: vec![launch(secret, Phase::AwaitingReady)], ..Snapshot::default() };
    state.launches[0].generation = secret.into();
    state.launches[0].pid_birth = Some(secret.into());
    state.launches[0].recorder = Some(secret.into());
    state.launches[0].pipeline_id = Some(secret.into());
    state.tick(120_000);
    let incident = state.incidents.last_mut().unwrap();
    incident.id = secret.into();
    incident.blocked_pipelines = vec![secret.into()];
    let captured = probe::Captured { exit_code: Some(23), signal: None, spawn_failed: false, stdout: secret.into(), stderr: secret.into(), stdout_truncated: false, stderr_truncated: false };
    incident.probe = Some(probe::Probe { id: secret.into(), started_at: 0, observation_timed_out: true, shell: None,
        owner: Some(RecorderIdentity { pid: 12345, birth: Some(secret.into()) }), owner_exit: Some(recorder_exit(0, 180_000)),
        result: Some(probe::ProbeResult { finished_at: 180_000, shell: captured.clone(), native: captured }) });
    // Forward-compatible unknown fields in a private record must never turn
    // the allowlist into raw serialization of newly added sensitive data.
    let mut raw = serde_json::to_value(&state).unwrap();
    for field in ["environment", "source", "transcripts", "history", "command", "account"] {
        raw[field] = serde_json::json!(secret);
        raw["launches"][0][field] = serde_json::json!(secret);
    }
    let state: Snapshot = serde_json::from_value(raw).unwrap();
    let report = export(&state).unwrap();
    for word in ["token", "secret", "/Users", "alice", "private", "source", "prompt", "transcript", "history", "environment"] {
        assert!(!report.contains(word), "leaked {word}: {report}");
    }
    assert!(report.contains("[redacted]"));
    assert!(report.contains("applicationFailure"));
    assert!(report.contains("23"));
}

#[test]
fn pending_probe_is_deduplicated_across_restarts_and_never_prevents_escalation() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(120_000);
    state.incidents[0].probe = Some(probe::Probe { id: uuid::Uuid::new_v4().to_string(), started_at: 120_000, observation_timed_out: false, result: None, shell: None, owner: None, owner_exit: None });
    crate::store::write_json(&directory.path().join("incidents.json"), &state).unwrap();
    assert!(probe::start(directory.path()).unwrap_err().to_string().contains("pending health recorder"));
    probe::refresh(directory.path(), &mut state, 600_000).unwrap();
    state.tick(600_000);
    assert!(state.active().unwrap().probe.as_ref().unwrap().observation_timed_out);
    assert!(state.active().unwrap().escalated_at.is_some());
    assert!(state.active().unwrap().recovered_at.is_none());
}

#[test]
fn late_health_result_is_retained_but_does_not_resume_a_still_stalled_child() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(120_000);
    let id = uuid::Uuid::new_v4().to_string();
    state.incidents[0].probe = Some(probe::Probe { id: id.clone(), started_at: 120_000, observation_timed_out: true, result: None, shell: None, owner: None, owner_exit: None });
    let path = crate::store::ensure_dir(directory.path().join(id)).unwrap();
    let shell = probe::Captured { exit_code: Some(0), signal: None, spawn_failed: false, stdout: String::new(), stderr: String::new(), stdout_truncated: false, stderr_truncated: false };
    let native = probe::Captured { stdout: "terminalx-startup-ready\n".into(), ..shell.clone() };
    crate::store::write_json(&path.join("result.json"), &probe::ProbeResult { finished_at: 500_000, shell, native }).unwrap();
    crate::store::write_json(&path.join("owner-exit.json"), &recorder_exit(0, 500_001)).unwrap();
    probe::refresh(directory.path(), &mut state, 510_000).unwrap();
    assert!(state.active().is_some());
    assert!(export(&state).unwrap().contains("lateSuccess"));
    state.launches[0].phase = Phase::Running;
    probe::refresh(directory.path(), &mut state, 520_000).unwrap();
    assert!(state.active().is_none());
}

pub(super) fn recorder_exit(code: i32, at: i64) -> RecorderExit {
    RecorderExit { finished_at: at, exit_code: Some(code), signal: None, failure: None, os_error: None }
}

#[test]
fn dead_probe_owner_is_retained_after_reopen_without_recovery_or_duplicate_children() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(120_000);
    let id = uuid::Uuid::new_v4().to_string();
    let path = crate::store::ensure_dir(directory.path().join(&id)).unwrap();
    state.incidents[0].probe = Some(probe::Probe { id, started_at: 120_000, observation_timed_out: false,
        result: None, shell: None, owner: None, owner_exit: None });
    crate::store::write_json(&directory.path().join("incidents.json"), &state).unwrap();
    let owner = RecorderIdentity { pid: 12345, birth: Some("12345:1:2".into()) };
    let exit = RecorderExit { exit_code: None, signal: Some(15), ..recorder_exit(0, 180_000) };
    crate::store::write_json(&path.join("owner.json"), &owner).unwrap();
    crate::store::write_json(&path.join("owner-exit.json"), &exit).unwrap();
    update_at(directory.path(), |state| probe::refresh(directory.path(), state, 200_000)).unwrap();
    let reopened: Snapshot = crate::store::read_json(&directory.path().join("incidents.json")).unwrap().unwrap();
    let probe = reopened.active().unwrap().probe.as_ref().unwrap();
    assert_eq!(probe.owner.as_ref(), Some(&owner));
    assert_eq!(probe.owner_exit.as_ref(), Some(&exit));
    assert_eq!(probe::export(probe)["status"], "recorderFailure");
    assert!(probe::start(directory.path()).unwrap_err().to_string().contains("no duplicate probe"));
    assert!(reopened.active().is_some());
}

#[test]
fn completed_probe_needs_the_durable_wait_after_reopening() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(120_000);
    state.launches[0].phase = Phase::Unobserved;
    state.observation_lost_at = Some(125_000);
    let id = uuid::Uuid::new_v4().to_string();
    let path = crate::store::ensure_dir(directory.path().join(&id)).unwrap();
    state.incidents[0].probe = Some(probe::Probe { id, started_at: 130_000, observation_timed_out: true,
        result: None, shell: None, owner: None, owner_exit: None });
    let shell = probe::Captured { exit_code: Some(0), signal: None, spawn_failed: false,
        stdout: String::new(), stderr: String::new(), stdout_truncated: false, stderr_truncated: false };
    let native = probe::Captured { stdout: "terminalx-startup-ready\n".into(), ..shell.clone() };
    crate::store::write_json(&path.join("result.json"), &probe::ProbeResult { finished_at: 150_000, shell, native }).unwrap();
    crate::store::write_json(&directory.path().join("incidents.json"), &state).unwrap();
    // Completed child files without the supervisor's actual wait are not a
    // pass or permission to retry, even if no process identity is available.
    update_at(directory.path(), |state| probe::refresh(directory.path(), state, 160_000)).unwrap();
    assert!(probe::start(directory.path()).unwrap_err().to_string().contains("pending health recorder"));
    let reopened: Snapshot = crate::store::read_json(&directory.path().join("incidents.json")).unwrap().unwrap();
    assert_eq!(probe::export(reopened.active().unwrap().probe.as_ref().unwrap())["status"], "recorderPending");
    // The independent supervisor can publish after the observer has reopened.
    // Only this exact completion plus fresh health and complete census recovers.
    crate::store::write_json(&path.join("owner-exit.json"), &recorder_exit(0, 170_000)).unwrap();
    update_at(directory.path(), |state| probe::refresh(directory.path(), state, 180_000)).unwrap();
    let reopened: Snapshot = crate::store::read_json(&directory.path().join("incidents.json")).unwrap().unwrap();
    assert!(reopened.active().is_none());
    assert_eq!(reopened.incidents[0].probe.as_ref().unwrap().owner_exit.as_ref().unwrap().exit_code, Some(0));
    assert_eq!(reopened.launches[0].exit_code, None, "health does not invent a lost child's outcome");
}

#[test]
fn delayed_callbacks_cannot_revive_an_exit_or_erase_its_exact_status() {
    let directory = tempfile::tempdir().unwrap();
    let monitor = Arc::new(Monitor { directory: directory.path().into() });
    let ticket = monitor.begin("tab:a", "generation", None).unwrap();
    ticket.exited(Some(23));
    ticket.spawned(Some(42));
    ticket.ready();
    ticket.exited(None);
    let state: Snapshot = crate::store::read_json(&directory.path().join("incidents.json")).unwrap().unwrap();
    assert_eq!(state.launches[0].phase, Phase::Exited);
    assert_eq!(state.launches[0].exit_code, Some(23));
    assert_eq!(state.launches[0].pid, None);
}

#[test]
fn spawn_is_progress_and_repeated_readiness_is_not_new_progress() {
    let directory = tempfile::tempdir().unwrap();
    let monitor = Arc::new(Monitor { directory: directory.path().into() });
    let ticket = monitor.begin("tab:a", "generation", None).unwrap();
    update_at(directory.path(), |state| { state.launches[0].last_progress_at = 1; Ok(()) }).unwrap();
    ticket.spawned(Some(42));
    let state: Snapshot = crate::store::read_json(&directory.path().join("incidents.json")).unwrap().unwrap();
    assert!(state.launches[0].last_progress_at > 1);
    ticket.ready();
    update_at(directory.path(), |state| { state.launches[0].last_progress_at = 2; Ok(()) }).unwrap();
    ticket.spawned(Some(42));
    ticket.ready();
    let state: Snapshot = crate::store::read_json(&directory.path().join("incidents.json")).unwrap().unwrap();
    assert_eq!(state.launches[0].phase, Phase::Running);
    assert_eq!(state.launches[0].last_progress_at, 2);
}

#[test]
fn permission_observation_is_not_progress_and_dismissal_keeps_startup_proven() {
    let directory = tempfile::tempdir().unwrap();
    let monitor = Monitor { directory: directory.path().into() };
    let state = Snapshot { launches: vec![launch("tab:a", Phase::PermissionPrompt)], ..Snapshot::default() };
    crate::store::write_json(&directory.path().join("incidents.json"), &state).unwrap();
    let terminals = crate::pty::Terminals::new();
    monitor.poll(&terminals, Some(&["tab:a".into()])).unwrap();
    let state: Snapshot = crate::store::read_json(&directory.path().join("incidents.json")).unwrap().unwrap();
    assert_eq!(state.launches[0].last_progress_at, 0);
    monitor.poll(&terminals, Some(&[])).unwrap();
    let state: Snapshot = crate::store::read_json(&directory.path().join("incidents.json")).unwrap().unwrap();
    assert_eq!(state.launches[0].phase, Phase::Running);
}

fn completed_health(state: &mut Snapshot, started_at: i64, finished_at: i64) {
    let shell = probe::Captured { exit_code: Some(0), signal: None, spawn_failed: false,
        stdout: String::new(), stderr: String::new(), stdout_truncated: false, stderr_truncated: false };
    state.incidents[0].probe = Some(probe::Probe { id: uuid::Uuid::new_v4().to_string(), started_at,
        observation_timed_out: false, shell: Some(shell.clone()), owner: None,
        owner_exit: Some(recorder_exit(0, finished_at + 1)),
        result: Some(probe::ProbeResult { finished_at, native: probe::Captured { stdout: "terminalx-startup-ready\n".into(), ..shell.clone() }, shell }) });
}

#[test]
fn new_overdue_launch_joins_before_health_can_recover_the_host_incident() {
    let directory = tempfile::tempdir().unwrap();
    let monitor = Monitor { directory: directory.path().into() };
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(120_000);
    let incident = state.active().unwrap().id.clone();
    state.launches[0].phase = Phase::Exited;
    state.launches.push(launch("tab:b", Phase::Spawning));
    completed_health(&mut state, 130_000, 140_000);
    crate::store::write_json(&directory.path().join("incidents.json"), &state).unwrap();
    monitor.poll(&crate::pty::Terminals::new(), Some(&[])).unwrap();
    let restored: Snapshot = crate::store::read_json(&directory.path().join("incidents.json")).unwrap().unwrap();
    assert_eq!(restored.active().unwrap().id, incident);
    assert_eq!(restored.incidents.len(), 1);
    assert_eq!(restored.active().unwrap().launches.len(), 2);
}

#[test]
fn any_pending_human_prompt_prevents_host_recovery() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(120_000);
    state.launches[0].phase = Phase::Exited;
    state.launches.push(launch("tab:human", Phase::PermissionPrompt));
    completed_health(&mut state, 130_000, 140_000);
    probe::refresh(directory.path(), &mut state, 140_002).unwrap();
    assert!(state.active().is_some());
    state.launches[1].phase = Phase::Running;
    state.launches[1].last_progress_at = 150_000;
    probe::refresh(directory.path(), &mut state, 150_001).unwrap();
    // The existing health predates this human interaction. A new probe is
    // required, even though the prompt was outside the affected launch set.
    assert!(state.active().is_some());
}

#[test]
fn durable_wait_finishing_after_observation_window_is_late_success() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(120_000);
    completed_health(&mut state, 130_000, 130_010);
    state.incidents[0].probe.as_mut().unwrap().owner_exit = Some(recorder_exit(0, 150_000));
    probe::refresh(directory.path(), &mut state, 150_001).unwrap();
    let restored: Snapshot = serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
    assert_eq!(probe::export(restored.active().unwrap().probe.as_ref().unwrap())["status"], "lateSuccess");
}

#[test]
fn shell_signal_is_exported_while_native_probe_is_still_pending() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(120_000);
    completed_health(&mut state, 130_000, 140_000);
    let health = state.incidents[0].probe.as_mut().unwrap();
    health.result = None;
    health.owner_exit = None;
    let shell = health.shell.as_mut().unwrap();
    shell.exit_code = None;
    shell.signal = Some(15);
    shell.stderr = "token=secret /Users/alice/account".into();
    probe::refresh(directory.path(), &mut state, 160_000).unwrap();
    let report = probe::export(state.active().unwrap().probe.as_ref().unwrap());
    assert_eq!(report["shellSignal"], 15);
    assert_eq!(report["status"], "unresolvedStall");
    assert!(!report.to_string().contains("secret"));
    assert!(!report.to_string().contains("alice"));
}

#[test]
fn health_must_be_strictly_newer_than_the_latest_affected_progress() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(120_000);
    state.launches[0].phase = Phase::Exited;
    state.launches[0].last_progress_at = 140_000;
    completed_health(&mut state, 130_000, 140_000);
    probe::refresh(directory.path(), &mut state, 140_002).unwrap();
    assert!(state.active().is_some(), "equal timestamps cannot establish event ordering");
    completed_health(&mut state, 150_000, 160_000);
    probe::refresh(directory.path(), &mut state, 160_002).unwrap();
    assert!(state.active().is_none());
}

#[test]
fn health_started_before_or_during_progress_cannot_recover_after_reopening() {
    for phase in [Phase::Running, Phase::Exited] {
        for progress_at in [130_000, 135_000, 140_000] {
            let directory = tempfile::tempdir().unwrap();
            let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
            state.tick(120_000);
            let incident_id = state.active().unwrap().id.clone();
            completed_health(&mut state, 130_000, 140_000);
            state.launches[0].phase = phase;
            state.launches[0].last_progress_at = progress_at;
            crate::store::write_json(&directory.path().join("incidents.json"), &state).unwrap();
            update_at(directory.path(), |state| probe::refresh(directory.path(), state, 150_000)).unwrap();
            let mut reopened: Snapshot = crate::store::read_json(&directory.path().join("incidents.json")).unwrap().unwrap();
            assert_eq!(reopened.active().map(|incident| &incident.id), Some(&incident_id),
                "probe started before or at {progress_at} cannot prove health after {phase:?}");
            // Only a new two-step probe whose entire run follows progress
            // can release the same incident. Exit 23 remains an app failure.
            reopened.launches[0].exit_code = (phase == Phase::Exited).then_some(23);
            completed_health(&mut reopened, 150_000, 160_000);
            probe::refresh(directory.path(), &mut reopened, 160_002).unwrap();
            assert!(reopened.active().is_none());
            assert_eq!(reopened.launches[0].exit_code, (phase == Phase::Exited).then_some(23));
        }
    }
}

#[test]
fn probe_refresh_cannot_recover_before_joining_another_overdue_launch() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(120_000);
    let incident = state.active().unwrap().id.clone();
    state.launches[0].phase = Phase::Exited;
    state.launches.push(launch("tab:b", Phase::Spawning));
    completed_health(&mut state, 130_000, 140_000);
    // The health-start path calls refresh directly, without Monitor::poll.
    probe::refresh(directory.path(), &mut state, 140_002).unwrap();
    assert_eq!(state.active().unwrap().id, incident);
    assert_eq!(state.incidents.len(), 1);
    assert_eq!(state.active().unwrap().launches.len(), 2);
}
