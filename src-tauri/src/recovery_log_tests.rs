use super::*;

fn ctx(turn_open: bool) -> State {
    State { turn_open, displayed: if turn_open { "in_progress" } else { "idle" }, engine: "codex_stdio", process: "running", connection: Some("ready"), ..State::default() }
}

fn note(tracker: &mut Tracker, turn_open: bool, f: impl FnOnce(&mut Tracker, &Ctx)) {
    let ctx = Ctx { session: "session-1", tab: "tab-1", state: ctx(turn_open) };
    f(tracker, &ctx);
}

fn tracker() -> Tracker {
    let mut tracker = Tracker::default();
    tracker.set_agent(Agent::new("codex", "codex_stdio", Some("gpt-6-astra"), Some("xhigh")));
    tracker
}

fn kinds(lines: &[Value]) -> Vec<&str> { lines.iter().map(|line| line["kind"].as_str().unwrap()).collect() }

#[test]
fn a_warning_raised_again_in_its_turn_is_the_same_incident() {
    let _home = crate::store::temp_home();
    let mut t = tracker();
    note(&mut t, false, |t, c| t.turn_started(c, 10, "prompt"));
    t.progress("tool_completed");
    note(&mut t, true, |t, c| t.raised(c, RecoveryKind::Timeout, Source::Watcher, 20));
    // The watcher's second look while it is still up.
    note(&mut t, true, |t, c| t.raised(c, RecoveryKind::Timeout, Source::Watcher, 21));
    note(&mut t, true, |t, c| t.cleared(c, "progress", 22));
    note(&mut t, true, |t, c| t.raised(c, RecoveryKind::Timeout, Source::Watcher, 23));
    // A different warning replaces it: a new incident that says which.
    note(&mut t, true, |t, c| t.raised(c, RecoveryKind::Disconnected, Source::Connection, 24));
    note(&mut t, true, |t, c| t.turn_ended(c, 25, TurnStatus::Aborted));
    // The next turn's timeout is a new incident with the same fingerprint.
    note(&mut t, false, |t, c| t.turn_started(c, 30, "prompt"));
    note(&mut t, true, |t, c| t.cleared(c, "resumed", 31));
    note(&mut t, true, |t, c| t.raised(c, RecoveryKind::Timeout, Source::Watcher, 32));

    let lines = read_all().unwrap();
    assert_eq!(kinds(&lines), ["turn_started", "recovery_raised", "recovery_raised", "recovery_cleared", "recovery_raised", "recovery_changed", "turn_ended", "turn_started", "recovery_cleared", "recovery_raised"]);
    let first = lines[1]["incident"].clone();
    for at in [2, 3, 4] { assert_eq!(lines[at]["incident"], first, "line {at}"); }
    assert_eq!((lines[2]["occurrence"].as_u64(), lines[2]["still_raised"].as_bool()), (Some(2), Some(true)));
    assert_eq!(lines[4]["occurrence"], 3);
    assert!(lines[4]["recurred_after_ms"].is_u64());
    assert_eq!(lines[5]["replaces"], first);
    assert_eq!(lines[5]["from"], "timeout");
    assert_ne!(lines[9]["incident"], first);
    assert_eq!(lines[9]["fingerprint"], lines[1]["fingerprint"]);
    assert_eq!(lines[6]["incidents"], json!([{ "incident": lines[5]["incident"], "state": "open" }]));
    // Every line is versioned, ordered, and dated by both clocks.
    let seqs: Vec<u64> = lines.iter().map(|line| line["seq"].as_u64().unwrap()).collect();
    assert!(seqs.windows(2).all(|pair| pair[1] == pair[0] + 1));
    for line in &lines {
        assert_eq!(line["v"], VERSION);
        assert!(line["ts"].as_str().unwrap().ends_with('Z') && line["mono_ms"].is_u64() && line["boot"].is_string() && line["runtime"].is_string());
        assert_eq!((line["session"].as_str(), line["tab"].as_str()), (Some("session-1"), Some("tab-1")));
    }
    assert_eq!(lines[1]["turn"], 10);
    assert_eq!(lines[1]["last_progress"]["kind"], "tool_completed");
    assert_eq!(lines[1]["agent"]["model"], "gpt-6-astra");
}

#[test]
fn the_file_is_bounded_with_one_older_file_kept() {
    let _home = crate::store::temp_home();
    let mut t = tracker();
    let mut written = 0u64;
    while !dir().unwrap().join(OLDER).exists() {
        note(&mut t, true, |t, c| t.send(c, Origin::Composer, Admission::Busy, Some(Refusal::Busy), None, Some((true, 0))));
        written += 1;
        assert!(written < 100_000, "never rotated");
    }
    // A second rotation replaces the older file rather than keeping a third.
    let size = || std::fs::metadata(dir().unwrap().join(FILE)).map(|meta| meta.len()).unwrap_or(0);
    let mut last = size();
    loop {
        note(&mut t, true, |t, c| t.send(c, Origin::Composer, Admission::Busy, Some(Refusal::Busy), None, Some((true, 0))));
        let now = size();
        if now < last { break; }
        last = now;
    }
    let names: Vec<_> = std::fs::read_dir(dir().unwrap()).unwrap().map(|entry| entry.unwrap().file_name().into_string().unwrap()).collect();
    assert_eq!(names.len(), 2, "{names:?}");
    for file in [FILE, OLDER] { assert!(std::fs::metadata(dir().unwrap().join(file)).unwrap().len() <= MAX_BYTES); }
    let seqs: Vec<u64> = read_all().unwrap().iter().map(|line| line["seq"].as_u64().unwrap()).collect();
    assert!(seqs.windows(2).all(|pair| pair[1] == pair[0] + 1), "the older file reads first, in order");
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(dir().unwrap().join(FILE)).unwrap().permissions().mode() & 0o777, 0o600);
    }
}

#[test]
fn a_line_that_cannot_be_written_is_counted_and_never_fails_the_work() {
    let _home = crate::store::temp_home();
    let diagnostics = crate::store::root().unwrap().join("diagnostics");
    std::fs::write(&diagnostics, "not a folder").unwrap();
    let mut t = tracker();
    for seq in 0..3 { note(&mut t, true, |t, c| t.raised(c, RecoveryKind::Timeout, Source::Watcher, seq)); }
    std::fs::remove_file(&diagnostics).unwrap();
    note(&mut t, true, |t, c| t.cleared(c, "progress", 9));
    let lines = read_all().unwrap();
    assert_eq!(kinds(&lines), ["recovery_cleared"]);
    assert_eq!(lines[0]["lost_before"], 3);
    assert_eq!(summarize(&lines)["lines_lost"], 3);
}

#[test]
fn nothing_is_recorded_while_the_reader_has_it_off() {
    let _home = crate::store::temp_home();
    let mut settings = crate::store::settings::load();
    assert!(settings.diagnostics.recovery_incidents, "on unless turned off");
    settings.diagnostics.recovery_incidents = false;
    crate::store::settings::save(&settings).unwrap();
    let mut t = tracker();
    note(&mut t, true, |t, c| t.raised(c, RecoveryKind::Timeout, Source::Watcher, 1));
    assert!(read_all().unwrap().is_empty());
    assert!(!dir().unwrap().join(FILE).exists());
    // Followed at the next line once the file says so.
    std::thread::sleep(Duration::from_millis(20));
    settings.diagnostics.recovery_incidents = true;
    crate::store::settings::save(&settings).unwrap();
    note(&mut t, true, |t, c| t.cleared(c, "progress", 2));
    assert_eq!(kinds(&read_all().unwrap()), ["recovery_cleared"]);
    clear().unwrap();
    assert!(read_all().unwrap().is_empty());
    clear().unwrap();
}

fn report(extra: Value) -> std::result::Result<UiReport, serde_json::Error> {
    let mut base = json!({ "kind": "action", "surface": "banner", "phase": "start", "clientId": "0b1c-22", "activeTab": true, "foreground": true });
    if let (Value::Object(base), Value::Object(extra)) = (&mut base, extra) { base.extend(extra); }
    serde_json::from_value(base)
}

#[test]
fn a_window_report_is_labels_and_numbers_only() {
    assert!(report(json!({ "action": "retry", "actor": "human", "input": "keyboard", "reason": "timeout", "sinceExposureMs": 4200, "tabStatus": "waiting", "result": "accepted" })).is_ok());
    for refused in [json!({ "message": "the prompt" }), json!({ "clientId": "has spaces" }), json!({ "clientId": "" }), json!({ "action": "rm -rf" }),
        json!({ "actor": "someone@example.com" }), json!({ "hideReason": "/Users/me" }), json!({ "durationMs": "long" })] {
        assert!(report(refused.clone()).is_err(), "{refused}");
    }
    let bounded = report(json!({ "durationMs": u64::MAX, "sinceExposureMs": u64::MAX, "appBuild": "spoofed" })).unwrap().bounded("0.2.25 (abc)");
    assert_eq!((bounded.duration_ms, bounded.since_exposure_ms), (Some(86_400_000), Some(86_400_000)));
    assert_eq!(bounded.app_build.as_deref(), Some("0.2.25abc"), "the app's own build, never the window's");
}

#[test]
fn a_window_report_is_told_with_the_incident_it_was_about() {
    let _home = crate::store::temp_home();
    let mut t = tracker();
    note(&mut t, true, |t, c| t.raised(c, RecoveryKind::Failed, Source::AgentError, 5));
    let shown = report(json!({ "kind": "exposure", "phase": "shown", "reason": "failed", "placement": "composer" })).unwrap();
    note(&mut t, true, |t, c| t.ui(c, &shown));
    note(&mut t, true, |t, c| t.cleared(c, "resumed", 6));
    // Hidden after it cleared: still that incident.
    let hidden = report(json!({ "kind": "exposure", "phase": "hidden", "reason": "failed", "durationMs": 1500, "hideReason": "cleared" })).unwrap();
    note(&mut t, true, |t, c| t.ui(c, &hidden));
    // About a warning the runtime has no incident for: said as such.
    let other = report(json!({ "kind": "exposure", "phase": "shown", "reason": "capacity" })).unwrap();
    note(&mut t, true, |t, c| t.ui(c, &other));
    // An error row from before the warning is history; one from it is the warning's.
    let old_row = report(json!({ "kind": "exposure", "surface": "error_row", "phase": "shown", "reason": "failed", "eventSeq": 3 })).unwrap();
    note(&mut t, true, |t, c| t.ui(c, &old_row));
    let its_row = report(json!({ "kind": "exposure", "surface": "error_row", "phase": "shown", "reason": "failed", "eventSeq": 6 })).unwrap();
    note(&mut t, true, |t, c| t.ui(c, &its_row));
    let lines = read_all().unwrap();
    assert_eq!(kinds(&lines), ["recovery_raised", "ui_exposure", "recovery_cleared", "ui_exposure", "ui_exposure", "ui_exposure", "ui_exposure"]);
    assert_eq!(lines[1]["incident"], lines[0]["incident"]);
    assert_eq!(lines[3]["incident"], lines[0]["incident"]);
    assert_eq!(lines[4]["incident"], Value::Null);
    assert_eq!(lines[3]["durationMs"], 1500);
    assert_eq!((lines[5]["incident"].clone(), lines[6]["incident"].clone()), (Value::Null, lines[0]["incident"].clone()));
}

#[test]
fn an_export_names_sessions_and_tabs_by_hashes_salted_for_it_alone() {
    let lines = vec![json!({ "v": 1, "kind": "send_attempt", "session": "session-1", "tab": "tab-1" }), json!({ "v": 1, "kind": "send_attempt", "session": "session-1", "tab": "tab-2" })];
    let one = pseudonymized(lines.clone(), "salt-a");
    let two = pseudonymized(lines, "salt-b");
    let text = serde_json::to_string(&one).unwrap();
    assert!(!text.contains("session-1") && !text.contains("tab-1"));
    assert_eq!(one[0]["session"], one[1]["session"], "one id is one name within an export");
    assert_ne!(one[0]["tab"], one[1]["tab"]);
    assert_ne!(one[0]["session"], two[0]["session"], "exports cannot be joined");

    let _home = crate::store::temp_home();
    let mut t = tracker();
    note(&mut t, true, |t, c| t.raised(c, RecoveryKind::Timeout, Source::Watcher, 1));
    let to = crate::store::root().unwrap().join("export.json");
    export(&to).unwrap();
    let written: Value = serde_json::from_str(&std::fs::read_to_string(&to).unwrap()).unwrap();
    assert_eq!(written["format"], "terminalx-recovery-incidents");
    assert_eq!(written["summary"]["incidents"], 1);
    assert!(!std::fs::read_to_string(&to).unwrap().contains("session-1"));
}

/// The ordering #815 captured (2026-11-06, native Codex, 0.2.24), replayed
/// as this build records it: a turn at work, three sends refused while it
/// ran, the watcher's timeout raised and cleared by progress 21 times, then
/// a stop. Nothing recorded says anything was shown or pressed, so the
/// summary says nothing was; the warnings are flagged for review.
#[test]
fn the_captured_incident_is_summed_up_without_inventing_what_was_not_seen() {
    let _home = crate::store::temp_home();
    let mut t = tracker();
    note(&mut t, false, |t, c| t.send(c, Origin::Composer, Admission::Admitted, None, Some(801), Some((false, 0))));
    note(&mut t, false, |t, c| t.turn_started(c, 801, "prompt"));
    for _ in 0..3 {
        t.progress("tool_completed");
        note(&mut t, true, |t, c| t.send(c, Origin::Composer, Admission::Busy, Some(Refusal::Busy), None, Some((true, 0))));
    }
    for at in 0..21 {
        t.progress("tool_completed");
        note(&mut t, true, |t, c| t.raised(c, RecoveryKind::Timeout, Source::Watcher, 1100 + at * 2));
        t.progress("text");
        note(&mut t, true, |t, c| t.cleared(c, "progress", 1101 + at * 2));
    }
    note(&mut t, true, |t, c| t.turn_ended(c, 1447, TurnStatus::Aborted));
    let summary = summarize(&read_all().unwrap());
    assert_eq!(summary["incidents"], 1);
    assert_eq!(summary["busy_refusals_while_turn_open"], 3);
    assert_eq!(summary["sends"], json!({ "composer:admitted": 1, "composer:busy": 3 }));
    let group = &summary["groups"][0];
    assert_eq!((group["reason"].as_str(), group["transport"].as_str()), (Some("timeout"), Some("codex_stdio")));
    assert_eq!((group["occurrences"].as_u64(), group["repeats"].as_u64(), group["recurred_after_clearing"].as_u64()), (Some(21), Some(20), Some(20)));
    assert_eq!(group["during_active_work"], 1);
    assert_eq!(group["visible"], json!({ "incidents_shown": 0, "of": 1, "total_ms": 0, "median_ms": null }));
    assert_eq!(group["actions"], json!({}));
    assert_eq!(group["with_any_action"], 0);
    assert_eq!(group["cleared"]["count"], 21);
    assert_eq!(group["outcomes"], json!({ "cleared_without_action:progress": 1 }));
    assert_eq!(summary["suspected_false_positives"].as_array().unwrap().len(), 1);
    assert_eq!(summary["suspected_false_positives"][0]["why"], "raised while the agent had shown progress within the last minute");
    assert_eq!(group["evidence"][0], summary["suspected_false_positives"][0]["incident"]);
}

#[test]
fn an_incident_nothing_more_is_known_of_is_unresolved() {
    let _home = crate::store::temp_home();
    let mut t = tracker();
    note(&mut t, true, |t, c| t.raised(c, RecoveryKind::Disconnected, Source::Connection, 1));
    let pressed = report(json!({ "action": "retry", "actor": "human", "input": "pointer", "reason": "disconnected", "result": "rejected", "rejectReason": "in_progress" })).unwrap();
    note(&mut t, true, |t, c| t.ui(c, &pressed));
    let summary = summarize(&read_all().unwrap());
    let group = &summary["groups"][0];
    assert_eq!(group["outcomes"], json!({ "unresolved": 1 }), "a rejected click is not a recovery");
    assert_eq!(group["actions"], json!({ "retry": { "rejected": 1 } }));
    assert_eq!(summary["suspected_false_positives"], json!([]));
}

#[test]
fn a_runtime_handover_keeps_the_incident() {
    let _home = crate::store::temp_home();
    let mut old = tracker();
    note(&mut old, false, |t, c| t.turn_started(c, 7, "prompt"));
    note(&mut old, true, |t, c| t.raised(c, RecoveryKind::Timeout, Source::Watcher, 8));
    let handed: Handed = serde_json::from_value(serde_json::to_value(old.handed()).unwrap()).unwrap();
    let mut new = tracker();
    note(&mut new, true, |t, c| t.adopt(c, Some(handed)));
    note(&mut new, true, |t, c| t.raised(c, RecoveryKind::Timeout, Source::Watcher, 9));
    note(&mut new, true, |t, c| t.cleared(c, "progress", 10));
    let lines = read_all().unwrap();
    assert_eq!(kinds(&lines), ["turn_started", "recovery_raised", "handed_over", "recovery_raised", "recovery_cleared"]);
    let id = &lines[1]["incident"];
    assert_eq!(&lines[2]["incident"], id);
    assert_eq!((&lines[3]["incident"], lines[3]["occurrence"].as_u64()), (id, Some(2)));
    assert_eq!(&lines[4]["incident"], id);
    assert_eq!(lines[3]["turn"], 7);
    // An older runtime hands nothing over: nothing is made up for it.
    let mut fresh = tracker();
    note(&mut fresh, true, |t, c| t.adopt(c, None));
    assert_eq!(read_all().unwrap().len(), lines.len());
}
