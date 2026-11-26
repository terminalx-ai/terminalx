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

/// A launch whose recorded process birth no longer exists: on macOS no process has this PID,
/// elsewhere no identity is readable at all. Either way the exact process is gone.
fn closed(mut launch: Launch) -> Launch {
    launch.pid = Some(999_999);
    launch.pid_birth = Some("999999:0:0".into());
    launch
}

fn waiting(pane: &str, proven: bool, since: i64) -> Launch {
    let mut wait = launch(pane, Phase::PermissionPrompt);
    wait.startup_proven = proven;
    wait.last_progress_at = since;
    wait
}

// PRO-575: on the owner's Mac two agents had waited at a card since before the incident, and
// no probe could ever clear it while they did.
#[test]
fn an_unrelated_pane_waiting_since_before_the_incident_does_not_block_recovery() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = Snapshot { launches: vec![waiting("tab:human", true, 60_000), launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(180_000);
    assert_eq!(state.active().unwrap().launches, [state.launches[1].id.clone()]);
    state.launches[1].phase = Phase::Exited;
    completed_health(&mut state, 190_000, 200_000);
    probe::refresh(directory.path(), &mut state, 200_002).unwrap();
    assert!(state.active().is_none(), "a person's pending answer elsewhere is not a startup stall");
    assert!(state.incidents[0].recovery_waits.is_empty());
    assert_eq!(state.launches[0].phase, Phase::PermissionPrompt, "recovery does not answer or touch the wait");
}

#[test]
fn a_wait_in_the_incidents_own_pane_still_blocks_recovery() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(120_000);
    state.launches[0].phase = Phase::Exited;
    // The pane's agent waits on a card it raised before the incident: the card may hide the stall.
    state.launches.push(waiting("tab:a", true, 60_000));
    completed_health(&mut state, 130_000, 140_000);
    probe::refresh(directory.path(), &mut state, 140_002).unwrap();
    assert!(state.active().is_some());
    assert_eq!(state.active().unwrap().recovery_waits, [state.launches[1].id.clone()]);
    let mut state: Snapshot = serde_json::from_value(serde_json::to_value(state).unwrap()).unwrap();
    state.launches[1].phase = Phase::Running;
    probe::refresh(directory.path(), &mut state, 150_000).unwrap();
    assert!(state.active().is_none(), "once answered, the passing probe after the incident's own progress stands");
}

#[test]
fn an_unproven_start_waiting_after_detection_blocks_recovery_in_any_pane() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(120_000);
    state.launches[0].phase = Phase::Exited;
    state.launches.push(waiting("tab:b", false, 125_000));
    state.launches.push(waiting("tab:c", true, 125_000));
    completed_health(&mut state, 130_000, 140_000);
    probe::refresh(directory.path(), &mut state, 140_002).unwrap();
    assert_eq!(state.active().unwrap().recovery_waits, [state.launches[1].id.clone()],
        "a new start behind a card may be a new stall; a proven one waiting is a person's decision");
}

// PRO-575: each new card in any tab moved the freshness boundary, so a probe went stale within a minute.
#[test]
fn an_unrelated_panes_progress_does_not_invalidate_a_probe() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady), launch("tab:busy", Phase::Running)], ..Snapshot::default() };
    state.tick(120_000);
    state.launches[0].phase = Phase::Exited;
    state.launches[0].last_progress_at = 125_000;
    completed_health(&mut state, 130_000, 140_000);
    // The busy agent raises and answers a card after the probe ran.
    state.launches[1].startup_proven = true;
    state.launches[1].phase = Phase::PermissionPrompt;
    state.launches[1].last_progress_at = 150_000;
    probe::refresh(directory.path(), &mut state, 150_001).unwrap();
    state.launches[1].phase = Phase::Running;
    state.launches[1].last_progress_at = 160_000;
    probe::refresh(directory.path(), &mut state, 160_001).unwrap();
    assert!(state.active().is_none());
}

#[test]
fn observation_lost_after_a_passing_probe_recovers_once_the_incidents_panes_have_closed() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady), closed(launch("tab:b", Phase::AwaitingReady))], ..Snapshot::default() };
    state.tick(120_000);
    assert_eq!(state.active().unwrap().launches.len(), 2);
    completed_health(&mut state, 130_000, 140_000);
    probe::refresh(directory.path(), &mut state, 140_002).unwrap();
    assert!(state.active().is_some(), "the incident's launches are still starting");
    // One exits; the other's pane closes unseen, and an unrelated short-lived child goes unseen too.
    state.launches[0].phase = Phase::Exited;
    state.launches[0].last_progress_at = 125_000;
    state.launches[1].phase = Phase::Unobserved;
    state.observation_lost_at = Some(150_000);
    crate::store::write_json(&directory.path().join("incidents.json"), &state).unwrap();
    update_at(directory.path(), |state| probe::refresh(directory.path(), state, 160_000)).unwrap();
    let reopened: Snapshot = crate::store::read_json(&directory.path().join("incidents.json")).unwrap().unwrap();
    assert_eq!(reopened.incidents[0].recovered_at, Some(160_000), "no second probe is needed once its launches have closed");
    assert_eq!(reopened.launches[1].exit_code, None, "recovery does not invent the lost child's outcome");
}

#[test]
fn observation_lost_after_the_probe_still_needs_new_health_while_a_launch_may_be_alive() {
    let directory = tempfile::tempdir().unwrap();
    // The birth is unknown, so nothing proves the lost launch has closed.
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(120_000);
    completed_health(&mut state, 130_000, 140_000);
    state.launches[0].phase = Phase::Unobserved;
    state.observation_lost_at = Some(150_000);
    probe::refresh(directory.path(), &mut state, 160_000).unwrap();
    assert!(state.active().is_some());
    completed_health(&mut state, 170_000, 180_000);
    probe::refresh(directory.path(), &mut state, 180_002).unwrap();
    assert!(state.active().is_none());
}

// The owner's Mac on 2026-11-26: 3,228 launches, 2,782 of them unobserved and 2,805 waits kept on the
// open incident, read and rewritten on every refresh.
#[test]
fn a_state_with_thousands_of_records_loads_and_is_pruned_to_the_bound_on_first_refresh() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(120_000);
    let affected = state.launches[0].id.clone();
    let mut pending = launch("validation", Phase::Running);
    pending.recorder = Some(uuid::Uuid::new_v4().to_string());
    let live = launch("tab:live", Phase::Running);
    let unsettled = launch("tab:starting", Phase::Spawning);
    state.launches.extend([pending.clone(), live.clone(), unsettled.clone()]);
    for index in 0..3_200 {
        let lost = launch("tab:old", if index % 8 == 0 { Phase::PermissionPrompt } else { Phase::Unobserved });
        let lost = if lost.phase == Phase::PermissionPrompt { closed(lost) } else { lost };
        state.incidents[0].recovery_waits.push(lost.id.clone());
        state.launches.push(lost);
    }
    crate::store::write_json(&directory.path().join("incidents.json"), &state).unwrap();
    assert!(std::fs::metadata(directory.path().join("incidents.json")).unwrap().len() > 1_000_000);
    update_at(directory.path(), |state| probe::refresh(directory.path(), state, 130_000)).unwrap();
    let pruned: Snapshot = crate::store::read_json(&directory.path().join("incidents.json")).unwrap().unwrap();
    assert_eq!(pruned.launches.len(), HISTORY);
    for kept in [&affected, &pending.id, &live.id, &unsettled.id] {
        assert!(pruned.launches.iter().any(|launch| &launch.id == kept), "kept {kept}");
    }
    assert!(pruned.incidents[0].recovery_waits.is_empty(), "waits in closed panes elsewhere hold nothing");
    assert!(std::fs::metadata(directory.path().join("incidents.json")).unwrap().len() < 200_000);
    // A refresh at the bound changes nothing, so it does not rewrite the file.
    let mut again = pruned.clone();
    probe::refresh(directory.path(), &mut again, 135_000).unwrap();
    assert_eq!(again, pruned);
}

#[test]
fn pruning_never_drops_live_or_unsettled_records_even_over_the_bound() {
    let mut state = Snapshot { launches: (0..HISTORY + 10).map(|_| launch("tab:live", Phase::Running)).collect(), ..Snapshot::default() };
    state.launches.extend((0..5).map(|_| launch("tab:waiting", Phase::AwaitingReady)));
    state.launches.extend((0..20).map(|_| launch("old", Phase::Exited)));
    state.tick(1_000);
    assert_eq!(state.launches.len(), HISTORY + 15, "only the settled records go");
    assert!(state.launches.iter().all(|launch| launch.phase != Phase::Exited));
}

#[test]
fn a_dismissed_banner_stays_hidden_for_the_same_incident_across_restart() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(120_000);
    let id = state.active().unwrap().id.clone();
    crate::store::write_json(&directory.path().join("incidents.json"), &state).unwrap();
    assert!(update_at(directory.path(), |state| dismiss_in(state, "another", 125_000)).is_err());
    update_at(directory.path(), |state| dismiss_in(state, &id, 125_000)).unwrap();
    // Restart: the record is read back and refreshed as the monitor does.
    let mut state: Snapshot = crate::store::read_json(&directory.path().join("incidents.json")).unwrap().unwrap();
    for at in [130_000, 200_000] { probe::refresh(directory.path(), &mut state, at).unwrap(); }
    let incident = state.active().unwrap();
    assert_eq!(incident.id, id);
    assert_eq!(incident.dismissed, Some(Dismissal { at: 125_000, escalated: false, affected_panes: 1 }));
    assert!(validation_blocker_in(&mut state).is_some(), "dismissing does not lift held validation");
    // It is no worse while it keeps the same panes and has not escalated.
    state.launches.push(launch("tab:a", Phase::AwaitingReady));
    state.tick(330_000);
    assert_eq!(state.active().unwrap().launches.len(), 2);
    assert!(state.active().unwrap().dismissed.is_some(), "another launch in the same pane is not worse");
}

#[test]
fn the_banner_returns_when_the_incident_escalates_or_reaches_more_panes() {
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(120_000);
    let id = state.active().unwrap().id.clone();
    dismiss_in(&mut state, &id, 125_000).unwrap();
    state.tick(420_000);
    assert!(state.active().unwrap().escalated_at.is_some());
    assert_eq!(state.active().unwrap().dismissed, None, "escalation is worse");
    dismiss_in(&mut state, &id, 425_000).unwrap();
    assert!(state.active().unwrap().dismissed.as_ref().unwrap().escalated);
    state.tick(430_000);
    assert!(state.active().unwrap().dismissed.is_some());
    state.launches.push(launch("tab:b", Phase::Spawning));
    state.tick(560_000);
    assert_eq!(state.active().unwrap().dismissed, None, "a second affected pane is worse");
}

#[test]
fn a_new_incident_shows_its_banner_after_an_earlier_one_was_dismissed() {
    let directory = tempfile::tempdir().unwrap();
    let mut state = Snapshot { launches: vec![launch("tab:a", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(120_000);
    let first = state.active().unwrap().id.clone();
    dismiss_in(&mut state, &first, 125_000).unwrap();
    state.launches[0].phase = Phase::Exited;
    completed_health(&mut state, 130_000, 140_000);
    probe::refresh(directory.path(), &mut state, 140_002).unwrap();
    assert!(state.active().is_none());
    assert!(dismiss_in(&mut state, &first, 150_000).is_err(), "a recovered incident is not open to dismiss");
    state.launches.push(launch("tab:a", Phase::AwaitingReady));
    state.launches[1].started_at = 200_000;
    state.launches[1].last_progress_at = 200_000;
    state.tick(320_000);
    let second = state.active().unwrap();
    assert_ne!(second.id, first);
    assert_eq!(second.dismissed, None);
}

/// The real admission check, against this state in a scratch home.
fn validation_blocker_in(state: &mut Snapshot) -> Option<String> {
    let _home = crate::store::temp_home();
    crate::store::write_json(&directory().unwrap().join("incidents.json"), &*state).unwrap();
    validation_blocker(None).unwrap()
}

#[test]
fn unrelated_pipeline_permission_card_does_not_join_or_block_on_a_startup_incident() {
    use crate::issue_pipeline::{engine::Host, host::LocalHost, Pipeline, SessionRef};
    let _home = crate::store::temp_home();
    let directory = crate::store::ensure_dir(crate::store::root().unwrap().join("startup")).unwrap();
    let mut state = Snapshot { launches: vec![launch("tab:stalled", Phase::AwaitingReady)], ..Snapshot::default() };
    state.tick(120_000);
    let affected = state.launches[0].id.clone();
    state.launches.push(launch("tab:human", Phase::PermissionPrompt));
    let sink = Arc::new(crate::sink::BroadcastSink::new(16));
    let manager = crate::session::SessionManager::new(
        sink.clone(), Arc::new(crate::sink::NoObserver), Arc::new(crate::harness::host::Host::new()),
        Arc::new(crate::pty::Terminals::new()), Arc::new(Default::default()), Arc::new(Default::default()),
        crate::hooks::prepare_control().unwrap(),
    );
    let host = LocalHost::new(sink, manager);
    let mut pipeline: Pipeline = serde_json::from_str(include_str!("../fixtures/issue_pipeline.json")).unwrap();
    pipeline.author = SessionRef { session_id: "unrelated".into(), tab_id: "human".into() };
    pipeline.reviewer = None;
    pipeline.resolver = None;
    let mut stalled = pipeline.clone();
    stalled.id = "stalled-pipeline".into();
    stalled.author = SessionRef { session_id: "affected".into(), tab_id: "stalled".into() };
    for dismissed in [false, true] {
        if dismissed {
            state.launches[1].phase = Phase::Running;
            state.launches[1].last_progress_at = 150_000;
        }
        // Repeated monitor refreshes must not attach the ordinary card, and
        // persistence must preserve the same distinction after dismissal.
        for at in [160_000, 170_000] { probe::refresh(&directory, &mut state, at).unwrap(); }
        crate::store::write_json(&directory.join("incidents.json"), &state).unwrap();
        assert!(host.startup_blocker(&pipeline, false).unwrap().is_none());
        assert!(host.startup_blocker(&stalled, false).unwrap().is_some());
        state = snapshot().unwrap();
        let incident = state.active().unwrap();
        assert_eq!(incident.launches, std::slice::from_ref(&affected));
        assert!(incident.recovery_waits.is_empty(), "a wait elsewhere since before the incident holds nothing");
        assert_eq!(incident.blocked_pipelines, [stalled.id.clone()]);
    }
    assert!(host.startup_blocker(&pipeline, true).unwrap().is_some(), "new heavy validation is still held");
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
