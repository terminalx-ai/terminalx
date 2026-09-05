use super::*;
use serde_json::json;
use std::fs;
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

const T: i64 = 1_700_000_000_000;

#[test]
fn another_runtime_cannot_overwrite_the_profile() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = Collector::open(dir.path().into(), T).unwrap();
    c.record_pr("https://github.com/o/r/pull/1", T).unwrap();
    assert!(Collector::open(dir.path().into(), T).is_err());
    assert_eq!(
        read_snapshot(&dir.path().join(FILE))
            .unwrap()
            .unwrap()
            .prs
            .len(),
        1
    );
    drop(c);
    assert_eq!(
        Collector::open(dir.path().into(), T)
            .unwrap()
            .summary()
            .prs_created,
        1
    );
}

fn tick(
    c: &mut Collector,
    key: &str,
    state: TabStatus,
    source: Source,
    clock: Instant,
    ms: u64,
) -> bool {
    c.transition(
        key,
        state,
        source,
        T + ms as i64,
        clock + Duration::from_millis(ms),
    )
    .unwrap()
}

#[test]
fn repeated_cycles_waits_duplicates_and_replayed_completion() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = Collector::open(dir.path().into(), T).unwrap();
    let clock = Instant::now();
    assert!(tick(
        &mut c,
        "claude",
        TabStatus::InProgress,
        Source::Live,
        clock,
        0
    ));
    for i in 1..25 {
        assert!(!tick(
            &mut c,
            "claude",
            TabStatus::InProgress,
            Source::Live,
            clock,
            i
        ));
    }
    tick(
        &mut c,
        "claude",
        TabStatus::InProgress,
        Source::Replay,
        clock,
        50,
    );
    tick(
        &mut c,
        "claude",
        TabStatus::Waiting,
        Source::Live,
        clock,
        100,
    );
    tick(
        &mut c,
        "claude",
        TabStatus::InProgress,
        Source::Live,
        clock,
        1000,
    );
    tick(
        &mut c,
        "claude",
        TabStatus::Completed,
        Source::Replay,
        clock,
        1200,
    );
    tick(
        &mut c,
        "claude",
        TabStatus::Completed,
        Source::Live,
        clock,
        5000,
    );
    tick(
        &mut c,
        "claude",
        TabStatus::InProgress,
        Source::Live,
        clock,
        6000,
    );
    tick(&mut c, "claude", TabStatus::Idle, Source::Live, clock, 6100);
    assert_eq!(c.summary().agents_spawned, 3);
    assert_eq!(c.summary().agent_time_ms, 400);
}

#[test]
fn cold_replay_never_opens_or_rearms_timing() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = Collector::open(dir.path().into(), T).unwrap();
    let clock = Instant::now();
    tick(
        &mut c,
        "codex",
        TabStatus::InProgress,
        Source::Replay,
        clock,
        0,
    );
    tick(
        &mut c,
        "codex",
        TabStatus::InProgress,
        Source::Live,
        clock,
        100,
    );
    tick(
        &mut c,
        "codex",
        TabStatus::Completed,
        Source::Replay,
        clock,
        500,
    );
    assert_eq!(c.summary().agents_spawned, 0);
    assert_eq!(c.summary().agent_time_ms, 0);
    tick(
        &mut c,
        "codex",
        TabStatus::InProgress,
        Source::Live,
        clock,
        1000,
    );
    c.shutdown(T + 1300, clock + Duration::from_millis(1300))
        .unwrap();
    c.shutdown(T + 5000, clock + Duration::from_millis(5000))
        .unwrap();
    assert!(!tick(
        &mut c,
        "late-hook",
        TabStatus::InProgress,
        Source::Live,
        clock,
        6000
    ));
    assert_eq!(c.summary().agents_spawned, 1);
    assert_eq!(c.summary().agent_time_ms, 300);
}

#[test]
fn wall_clock_changes_do_not_change_work_duration() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = Collector::open(dir.path().into(), T).unwrap();
    let clock = Instant::now();
    c.transition("s/t", TabStatus::InProgress, Source::Live, T, clock)
        .unwrap();
    c.transition(
        "s/t",
        TabStatus::Idle,
        Source::Live,
        T - 10_000,
        clock + Duration::from_millis(100),
    )
    .unwrap();
    assert_eq!(c.summary().agent_time_ms, 100);
}

#[test]
fn pruning_deletion_restart_and_pr_rediscovery_preserve_totals() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = Collector::open(dir.path().into(), T).unwrap();
    let clock = Instant::now();
    tick(&mut c, "s/t", TabStatus::InProgress, Source::Live, clock, 0);
    tick(&mut c, "s/t", TabStatus::Idle, Source::Live, clock, 250);
    c.record_pr(
        "https://GitHub.com/Owner/Repo/pull/17?tab=files#review",
        T + 300,
    )
    .unwrap();
    let original = c.summary();
    // Detailed history retention is separate from all aggregate fields/IDs.
    for i in 0..MAX_EVENTS + 10 {
        c.data.remember(ActivityEvent {
            id: i.to_string(),
            at: T + 1000,
            kind: "diagnostic".into(),
            key: "s/t".into(),
            duration_ms: 0,
        });
    }
    assert_eq!(c.data.events.len(), MAX_EVENTS);
    c.save().unwrap();
    fs::create_dir_all(dir.path().join("sessions/s")).unwrap();
    fs::remove_dir_all(dir.path().join("sessions")).unwrap();
    drop(c);
    let mut c = Collector::open(dir.path().into(), T + 10_000).unwrap();
    c.record_pr("http://github.com/owner/repo/pull/017/", T + 20_000)
        .unwrap();
    assert_eq!(c.summary().agents_spawned, original.agents_spawned);
    assert_eq!(c.summary().agent_time_ms, 250);
    assert_eq!(c.summary().prs_created, 1);
    assert_eq!(c.summary().tracking_since, original.tracking_since);
}

#[test]
fn abrupt_restart_retains_start_without_counting_downtime() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = Collector::open(dir.path().into(), T).unwrap();
    tick(
        &mut c,
        "s/t",
        TabStatus::InProgress,
        Source::Live,
        Instant::now(),
        0,
    );
    drop(c); // no shutdown/stop boundary
    let mut c = Collector::open(dir.path().into(), T + 86_400_000).unwrap();
    tick(
        &mut c,
        "s/t",
        TabStatus::Completed,
        Source::Replay,
        Instant::now(),
        86_400_000,
    );
    assert_eq!(c.summary().agents_spawned, 1);
    assert_eq!(c.summary().agent_time_ms, 0);
}

#[test]
fn unreadable_snapshots_are_preserved_and_valid_backup_is_used() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = Collector::open(dir.path().into(), T).unwrap();
    c.record_pr("https://github.com/o/r/pull/1", T).unwrap();
    drop(c);
    fs::write(dir.path().join(FILE), "{broken").unwrap();
    let c = Collector::open(dir.path().into(), T).unwrap();
    assert_eq!(c.summary().prs_created, 1);
    assert!(c.summary().accounting_error.is_some());
    drop(c);
    fs::write(dir.path().join(FILE), "{broken").unwrap();
    fs::write(dir.path().join(BACKUP), "").unwrap();
    assert!(Collector::open(dir.path().into(), T).is_err());
    assert_eq!(
        fs::read_to_string(dir.path().join(FILE)).unwrap(),
        "{broken"
    );
    assert_eq!(fs::read_to_string(dir.path().join(BACKUP)).unwrap(), "");
}

#[test]
fn missing_primary_and_older_backup_never_replace_newer_totals() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = Collector::open(dir.path().into(), T).unwrap();
    c.record_pr("https://github.com/o/r/pull/1", T).unwrap();
    let older = fs::read(dir.path().join(BACKUP)).unwrap();
    c.record_pr("https://github.com/o/r/pull/2", T + 1).unwrap();
    fs::write(dir.path().join(BACKUP), older).unwrap();
    drop(c);
    let c = Collector::open(dir.path().into(), T).unwrap();
    assert_eq!(c.summary().prs_created, 2);
    drop(c);
    fs::remove_file(dir.path().join(FILE)).unwrap();
    let c = Collector::open(dir.path().into(), T).unwrap();
    assert_eq!(c.summary().prs_created, 2);
    assert!(c.summary().accounting_error.is_some());
}

#[test]
fn failed_write_keeps_memory_and_retries_on_rediscovery() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = Collector::open(dir.path().into(), T).unwrap();
    c.record_pr("https://github.com/o/r/pull/1", T).unwrap();
    fs::remove_file(dir.path().join(FILE)).unwrap();
    fs::create_dir(dir.path().join(FILE)).unwrap();
    assert!(c.record_pr("https://github.com/o/r/pull/2", T).is_err());
    assert_eq!(c.summary().prs_created, 2);
    assert!(c.summary().accounting_error.is_some());
    assert_eq!(
        read_snapshot(&dir.path().join(BACKUP))
            .unwrap()
            .unwrap()
            .prs
            .len(),
        1
    );
    fs::remove_dir(dir.path().join(FILE)).unwrap();
    c.record_pr("https://github.com/o/r/pull/2", T).unwrap();
    drop(c);
    assert_eq!(
        Collector::open(dir.path().into(), T)
            .unwrap()
            .summary()
            .prs_created,
        2
    );
}

fn log(path: &Path, rows: &[(i64, serde_json::Value)]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let text = rows.iter().enumerate().map(|(i, (at, payload))| {
        json!({"id":format!("event-{i}"),"sessionId":"s","tabId":"t","harness":"claude","seq":i+1,
            "ts":chrono::DateTime::from_timestamp_millis(*at).unwrap().to_rfc3339(),"payload":payload}).to_string()
    }).collect::<Vec<_>>().join("\n");
    fs::write(path, text + "\n").unwrap();
}

#[test]
fn recovery_uses_work_evidence_waits_and_stable_ids_even_without_index() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("sessions/s/t.jsonl");
    log(
        &file,
        &[
            (
                T,
                json!({"type":"turn_started","providerSessionId":"identity-only"}),
            ),
            (T + 100, json!({"type":"user_message","text":"work"})),
            (T + 110, json!({"type":"assistant_text","text":"working"})),
            (
                T + 200,
                json!({"type":"questions_asked","requestId":"q","toolUseId":"q","questions":[]}),
            ),
            (
                T + 1000,
                json!({"type":"permission_decided","requestId":"q","allowed":true,"label":"Answered"}),
            ),
            (T + 1050, json!({"type":"assistant_text","text":"resumed"})),
            (
                T + 1200,
                json!({"type":"turn_completed","status":"ok","durationMs":1100}),
            ),
            (
                T + 2000,
                json!({"type":"user_message","text":"failed to send"}),
            ),
            (T + 2010, json!({"type":"turn_completed","status":"error"})),
        ],
    );
    // Copied logs with the same event identities cannot recover twice.
    fs::copy(&file, dir.path().join("sessions/s/copy.jsonl")).unwrap();
    let mut c = Collector::open(dir.path().into(), T + 3000).unwrap();
    assert_eq!(c.summary().agents_spawned, 2);
    assert_eq!(c.summary().agent_time_ms, 300);
    assert_eq!(c.data.first_activity_at, Some(T + 100));
    c.data.recovery_version = 0;
    c.recover();
    assert_eq!(c.summary().agents_spawned, 2);
    assert_eq!(c.summary().agent_time_ms, 300);
}

#[test]
fn recovery_retry_preserves_live_activity_and_reports_corrupt_old_prs() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("stats-prs.json"), "bad").unwrap();
    let mut c = Collector::open(dir.path().into(), T).unwrap();
    assert!(c
        .summary()
        .accounting_error
        .as_deref()
        .unwrap()
        .contains("stats-prs.json"));
    assert_eq!(c.data.recovery_version, 0);
    tick(
        &mut c,
        "s/t",
        TabStatus::InProgress,
        Source::Live,
        Instant::now(),
        100,
    );
    log(
        &dir.path().join("sessions/s/t.jsonl"),
        &[
            (T + 100, json!({"type":"user_message","text":"live work"})),
            (T + 200, json!({"type":"turn_completed","status":"ok"})),
        ],
    );
    fs::write(
        dir.path().join("stats-prs.json"),
        r#"{"urls":["https://github.com/o/r/pull/1"]}"#,
    )
    .unwrap();
    c.record_pr("https://github.com/o/r/pull/1", T + 300)
        .unwrap();
    c.recover();
    assert_eq!(c.data.recovery_version, 1);
    assert_eq!(c.summary().agents_spawned, 1);
    assert_eq!(c.summary().prs_created, 1);
    drop(c);
    let c = Collector::open(dir.path().into(), T + 500).unwrap();
    assert_eq!(c.summary().agents_spawned, 1);
    assert_eq!(c.summary().prs_created, 1);
}

#[test]
fn concurrent_live_events_and_pr_discovery_share_atomic_aggregate_updates() {
    let _home = crate::store::temp_home();
    let barrier = Arc::new(Barrier::new(12));
    let workers = (0..12)
        .map(|i| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let key = format!("s/{i}");
                transition(&key, TabStatus::InProgress, Source::Live).unwrap();
                transition(&key, TabStatus::InProgress, Source::Live).unwrap();
                record_pr("https://github.com/o/r/pull/9").unwrap();
                transition(&key, TabStatus::Completed, Source::Live).unwrap();
            })
        })
        .collect::<Vec<_>>();
    for worker in workers {
        worker.join().unwrap();
    }
    shutdown().unwrap();
    let data = read_snapshot(&crate::store::root().unwrap().join(FILE))
        .unwrap()
        .unwrap();
    assert_eq!(data.agents_spawned, 12);
    assert_eq!(data.prs.len(), 1);
}

#[test]
fn in_flight_save_cannot_overtake_shutdown() {
    let dir = tempfile::tempdir().unwrap();
    let c = Arc::new(Mutex::new(Collector::open(dir.path().into(), T).unwrap()));
    let clock = Instant::now();
    // Hold the actual atomic-write facility at its entry, while the activity
    // owner is already processing a start. Quit must join that owner.
    let write_gate = crate::store::WRITE_LOCK.lock().unwrap();
    let (entered, wait) = std::sync::mpsc::channel();
    let start = {
        let c = c.clone();
        std::thread::spawn(move || {
            let mut c = c.lock().unwrap();
            entered.send(()).unwrap();
            tick(&mut c, "s/t", TabStatus::InProgress, Source::Live, clock, 0);
        })
    };
    wait.recv_timeout(Duration::from_secs(2)).unwrap();
    let quit = {
        let c = c.clone();
        std::thread::spawn(move || {
            c.lock()
                .unwrap()
                .shutdown(T + 1000, clock + Duration::from_millis(1000))
                .unwrap()
        })
    };
    drop(write_gate);
    start.join().unwrap();
    quit.join().unwrap();
    let data = read_snapshot(&dir.path().join(FILE)).unwrap().unwrap();
    assert_eq!(data.agents_spawned, 1);
    assert_eq!(data.agent_time_ms, 1000);
    assert_eq!(
        read_snapshot(&dir.path().join(BACKUP))
            .unwrap()
            .unwrap()
            .generation,
        data.generation
    );
}
