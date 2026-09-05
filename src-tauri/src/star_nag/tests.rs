use super::*;

fn core(dir: &tempfile::TempDir) -> Core {
    let mut core = Core::load(dir.path().join("reminder.json"), "1", HashSet::from(["restored/tab".into()]), 0).unwrap();
    core.ready = true;
    core
}
fn launches(core: &mut Core, count: u64, now: i64) {
    for _ in 0..count {
        core.launched(format!("new/{}", core.saved.launches), now).unwrap();
    }
}
fn event(payload: Payload) -> AgentEvent {
    AgentEvent { id: "event".into(), session_id: "s".into(), tab_id: "t".into(), harness: "codex".into(), seq: 1, ts: String::new(), subagent: None, payload }
}
fn prompt(text: &str, queued: bool) -> AgentEvent {
    event(Payload::UserMessage { text: text.into(), images: vec![], baseline: None, queued, cwd: None })
}
fn done(status: TurnStatus) -> AgentEvent {
    event(Payload::TurnCompleted { status, final_text: None, usage: None, duration_ms: None, head: None, auth_failed: false })
}
fn show(core: &mut Core, status: StarStatus, now: i64) {
    let ticket = core.begin_check(now).expect("eligible");
    core.checked(ticket, status, now).unwrap();
}

#[test]
fn usage_is_monotonic_and_evaluated_only_on_new_launches() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = core(&dir);
    c.launched("restored/tab".into(), 0).unwrap();
    assert_eq!(c.saved.launches, 0);
    launches(&mut c, 34, 0);
    assert_eq!(c.begin_check(0), None);
    c.launched("new/33".into(), 0).unwrap();
    assert_eq!(c.saved.launches, 34);
    launches(&mut c, 1, 0);
    show(&mut c, StarStatus::NotStarred, 0);
    assert!(c.view.visible);
    assert_eq!(c.view.mode, Some(Mode::Direct));
    assert_eq!(c.begin_action(), Some((0, Mode::Direct)));
    assert_eq!(c.begin_action(), None);
}

#[test]
fn dismissal_requires_three_days_and_another_seventy_launches_across_restart() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = core(&dir);
    launches(&mut c, 35, 0);
    show(&mut c, StarStatus::Unknown, 0);
    c.defer(100).unwrap();
    assert_eq!(c.saved.next_threshold, 70);
    let mut c = Core::load(c.path, "1", c.seen, 100).unwrap();
    c.ready = true;
    assert_eq!(c.saved.baseline, 35);
    launches(&mut c, 69, COOLDOWN_MS + 100);
    assert_eq!(c.begin_check(COOLDOWN_MS + 100), None);
    launches(&mut c, 1, COOLDOWN_MS + 100);
    show(&mut c, StarStatus::Unknown, COOLDOWN_MS + 100);
    assert_eq!(c.view.mode, Some(Mode::Browser));
}

#[test]
fn elapsed_cooldown_alone_does_not_check_github() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = core(&dir);
    c.defer(0).unwrap();
    launches(&mut c, 70, COOLDOWN_MS - 1);
    assert_eq!(c.begin_check(COOLDOWN_MS), None);
    launches(&mut c, 1, COOLDOWN_MS);
    assert!(c.begin_check(COOLDOWN_MS).is_some());
}

#[test]
fn update_resets_baseline_but_preserves_dismissal_and_supporter() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = core(&dir);
    launches(&mut c, 35, 0);
    c.defer(0).unwrap();
    let mut c = Core::load(c.path, "2", c.seen, 1).unwrap();
    c.ready = true;
    assert_eq!(c.saved.baseline, 35);
    assert_eq!(c.saved.next_threshold, 35);
    assert_eq!(c.saved.cooldown_until, COOLDOWN_MS);
    launches(&mut c, 35, 1);
    assert_eq!(c.begin_check(1), None);
    c.complete().unwrap();
    let c = Core::load(c.path, "3", c.seen, COOLDOWN_MS).unwrap();
    assert!(c.saved.completed);
}

#[test]
fn successful_completion_requires_live_meaningful_prompt_and_quiet_idle_window() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = core(&dir);
    c.observe(&done(TurnStatus::Ok), 0).unwrap(); // resume/idle boundary
    assert!(!c.pending_completion);
    for (text, queued, status) in [("", false, TurnStatus::Ok), ("work", true, TurnStatus::Ok), ("work", false, TurnStatus::Error), ("work", false, TurnStatus::Aborted)] {
        c.observe(&prompt(text, queued), 0).unwrap();
        c.observe(&done(status), 0).unwrap();
        assert!(!c.pending_completion);
    }
    c.observe(&prompt("fix the test", false), 0).unwrap();
    c.observe(&done(TurnStatus::Ok), 100).unwrap();
    c.active.insert("other/tab".into()); // working and waiting use the same gate
    assert_eq!(c.begin_check(5000), None);
    c.active.clear();
    c.quiet_since = 5000;
    assert_eq!(c.begin_check(6199), None);
    show(&mut c, StarStatus::NotStarred, 6200);
    assert_eq!(c.saved.completion_version.as_deref(), Some("1"));
    c.defer(6200).unwrap();
    c.observe(&prompt("more work", false), COOLDOWN_MS + 6200).unwrap();
    c.observe(&done(TurnStatus::Ok), COOLDOWN_MS + 6200).unwrap();
    assert!(!c.pending_completion);
}

#[test]
fn async_completion_result_waits_for_typing_and_new_activity_without_another_lookup() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = core(&dir);
    c.observe(&prompt("work", false), 0).unwrap();
    c.observe(&done(TurnStatus::Ok), 0).unwrap();
    let ticket = c.begin_check(1200).unwrap();
    c.active.insert("other/tab".into());
    c.quiet_since = 1300;
    c.checked(ticket, StarStatus::NotStarred, 1400).unwrap();
    assert!(!c.view.visible);
    assert_eq!(c.begin_check(5000), None);
    c.active.clear();
    c.show_prepared(2499).unwrap();
    assert!(!c.view.visible);
    c.show_prepared(2500).unwrap();
    assert!(c.view.visible);
}

#[test]
fn simultaneous_triggers_share_a_check_and_dismissal_invalidates_its_result() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = core(&dir);
    launches(&mut c, 35, 0);
    c.observe(&prompt("work", false), 0).unwrap();
    c.observe(&done(TurnStatus::Ok), 0).unwrap();
    let ticket = c.begin_check(1200).unwrap();
    assert_eq!(c.begin_check(1200), None);
    c.defer(1300).unwrap();
    c.checked(ticket, StarStatus::NotStarred, 1400).unwrap();
    assert!(!c.view.visible);
    assert!(c.prepared.is_none());
    assert!(!c.checking);
}

#[test]
fn existing_star_and_successful_direct_action_survive_restarts_and_updates() {
    for existing in [true, false] {
        let dir = tempfile::tempdir().unwrap();
        let mut c = core(&dir);
        launches(&mut c, 35, 0);
        show(&mut c, if existing { StarStatus::Starred } else { StarStatus::NotStarred }, 0);
        if !existing {
            let (ticket, mode) = c.begin_action().unwrap();
            c.acted(ticket, mode, true, 1).unwrap();
        }
        assert!(c.saved.completed);
        assert!(!c.view.visible);
        let mut c = Core::load(c.path, "2", c.seen, 999999999).unwrap();
        c.ready = true;
        launches(&mut c, 1000, 999999999);
        assert_eq!(c.begin_check(999999999), None);
    }
}

#[test]
fn direct_failure_offers_explicit_browser_retry_and_browser_success_only_defers() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = core(&dir);
    launches(&mut c, 35, 0);
    show(&mut c, StarStatus::NotStarred, 0);
    let (ticket, mode) = c.begin_action().unwrap();
    c.acted(ticket, mode, false, 1).unwrap();
    assert!(c.view.visible);
    assert_eq!(c.view.mode, Some(Mode::Browser));
    assert!(!c.action);
    let (ticket, mode) = c.begin_action().unwrap();
    c.acted(ticket, mode, false, 2).unwrap();
    assert!(c.view.visible);
    let (ticket, mode) = c.begin_action().unwrap();
    c.acted(ticket, mode, true, 3).unwrap();
    assert!(!c.view.visible);
    assert!(!c.saved.completed);
    assert_eq!(c.saved.cooldown_until, COOLDOWN_MS + 3);
    assert_eq!(c.saved.next_threshold, 70);
}

#[test]
fn completion_during_cooldown_is_consumed_for_the_version() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = core(&dir);
    c.defer(0).unwrap();
    c.observe(&prompt("work", false), 1).unwrap();
    c.observe(&done(TurnStatus::Ok), 2).unwrap();
    assert_eq!(c.saved.completion_version.as_deref(), Some("1"));
    let c = Core::load(c.path, "1", c.seen, COOLDOWN_MS).unwrap();
    assert_eq!(c.saved.completion_version.as_deref(), Some("1"));
}

#[test]
fn late_action_failure_cannot_reshow_dismissed_card() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = core(&dir);
    launches(&mut c, 35, 0);
    show(&mut c, StarStatus::NotStarred, 0);
    let (ticket, mode) = c.begin_action().unwrap();
    c.defer(1).unwrap();
    assert_eq!(c.begin_action(), None);
    c.acted(ticket, mode, false, 2).unwrap();
    assert!(!c.view.visible);
    assert!(c.view.error.is_none());
}

#[test]
fn corrupt_persistence_is_not_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("broken.json");
    std::fs::write(&path, "broken").unwrap();
    assert!(Core::load(path.clone(), "1", HashSet::new(), 0).is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "broken");
}
