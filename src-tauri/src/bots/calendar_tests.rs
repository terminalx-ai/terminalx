//! The week of duties (PRO-473): blocks and counted rows agree with the run
//! logs and the schedules, in the owner's time zone; and the `dutyWeek` read
//! through the runtime's own dispatch.

use std::sync::Arc;

use serde_json::{json, Value};

use super::*;
use crate::sink::{BroadcastSink, EventSink};

/// Monday 16 November 2026.
fn monday() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 11, 16).unwrap()
}

fn utc(text: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(text).unwrap().with_timezone(&Utc)
}

fn bot(id: &str, paused: bool) -> Bot {
    let mut value = json!({"id": id, "slug": id, "name": id, "roleTitle": "Watcher", "roleTemplateId": "watcher", "harness": "claude",
        "created": "2026-01-01T00:00:00Z", "modified": "2026-01-01T00:00:00Z"});
    if paused {
        value["paused"] = json!({"at": "2026-11-19T10:00:00Z", "by": "owner"});
    }
    serde_json::from_value(value).unwrap()
}

fn duty(id: &str, bot: &str, schedule: Value, extra: Value) -> Automation {
    let mut value = json!({"id": id, "name": id, "enabled": true, "projectPath": "/home", "harness": "claude", "prompt": "Look.", "workspace": "newWorktree",
        "schedule": schedule, "nextRunAt": "2026-11-20T09:00:00Z", "created": "2026-01-01T00:00:00Z", "modified": "2026-01-01T00:00:00Z",
        "bot": {"id": bot, "reportsTo": "terminalx"}});
    if let (Some(value), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
        value.extend(extra.clone());
    }
    serde_json::from_value(value).unwrap()
}

fn daily(hour: u32, timezone: &str) -> Value {
    json!({"kind": "preset", "preset": "daily", "hour": hour, "minute": 0, "timezone": timezone, "dtstart": "2026-01-01T00:00:00Z"})
}

fn cron(expression: &str) -> Value {
    json!({"kind": "cron", "cron": expression, "timezone": "UTC", "dtstart": "2026-01-01T00:00:00Z"})
}

fn run(duty: &str, n: u64, status: &str, scheduled: &str, extra: Value) -> AutomationRun {
    let mut value = json!({"runId": format!("{duty}-{n}"), "runNumber": n, "automationId": duty, "trigger": "scheduled", "status": status,
        "scheduledFor": scheduled, "startedAt": scheduled, "endedAt": scheduled});
    if let (Some(value), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
        value.extend(extra.clone());
    }
    serde_json::from_value(value).unwrap()
}

fn read(tz: Tz, now: &str, duties: &[(&Automation, &Bot, Vec<AutomationRun>)]) -> Week {
    let inputs: Vec<DutyWeek<'_>> = duties.iter().map(|(duty, bot, runs)| DutyWeek { duty, bot, runs }).collect();
    week(tz, monday(), utc(now), &inputs, BTreeMap::new())
}

fn states(week: &Week, duty: &str) -> Vec<(u32, u32, BlockState)> {
    week.blocks.iter().filter(|block| block.duty_id == duty).map(|block| (block.day, block.minute, block.state)).collect()
}

#[test]
fn each_block_says_what_its_run_did_and_the_rest_of_the_week_is_still_to_come() {
    let atlas = bot("atlas", false);
    let status = duty("status", "atlas", daily(9, "UTC"), json!({}));
    let runs = vec![
        // Newest first, as the log keeps them. Thursday's is going now.
        run("status", 4, "running", "2026-11-19T09:00:00Z", json!({"endedAt": null, "sessionId": "s4"})),
        run("status", 3, "completed", "2026-11-18T09:00:00Z", json!({"sessionId": "s3"})),
        run("status", 2, "skippedPrecheck", "2026-11-17T09:00:00Z", json!({"precheck": {"stdoutTail": "", "stderrTail": "", "truncated": false, "timedOut": false, "durationMs": 3}})),
        run("status", 1, "completed", "2026-11-16T09:00:00Z", json!({"sessionId": "s1", "duty": {"reportedTo": "owner", "notified": true}})),
        // Last week's: not this week's.
        run("status", 0, "completed", "2026-11-15T09:00:00Z", json!({"sessionId": "s0", "duty": {"reportedTo": "owner"}})),
    ];
    let week = read(Tz::UTC, "2026-11-19T09:05:00Z", &[(&status, &atlas, runs)]);
    assert_eq!(week.days.first().map(String::as_str), Some("2026-11-16"));
    assert_eq!((week.today, week.now_minute), (Some(3), Some(9 * 60 + 5)));
    assert_eq!(
        states(&week, "status"),
        vec![
            (0, 540, BlockState::Reported),
            (1, 540, BlockState::Quiet),
            (2, 540, BlockState::Done),
            (3, 540, BlockState::Running),
            (4, 540, BlockState::Next),
            (5, 540, BlockState::Next),
            (6, 540, BlockState::Next),
        ]
    );
    let monday = &week.blocks[0];
    assert_eq!((monday.run_id.as_deref(), monday.session_id.as_deref()), (Some("status-1"), Some("s1")));
    // What ran this week, as the log counts it: the running one too, as Today's counts do.
    assert_eq!(week.totals, Totals { checks: 4, nothing_new: 1, reports: 1 });
    assert!(week.next_today.is_empty(), "today's run has started");
}

#[test]
fn a_folded_row_puts_each_repeat_at_its_scheduled_time() {
    let argus = bot("argus", false);
    let drift = duty("drift", "argus", daily(9, "UTC"), json!({}));
    // Nothing new on Monday, then twice more (Tuesday and Wednesday) folded into the same row; then a failure
    // repeated once, with no time the schedule gives (Run now).
    let quiet = json!({"stdoutTail": "", "stderrTail": "", "truncated": false, "timedOut": false, "durationMs": 3});
    let runs = vec![
        run("drift", 2, "failed", "2026-11-19T15:00:00Z", json!({"trigger": "manual", "scheduledFor": null, "error": "exit 4", "repeatCount": 2, "lastRepeatAt": "2026-11-19T16:00:00Z", "precheck": quiet})),
        run("drift", 1, "skippedPrecheck", "2026-11-16T09:00:00Z", json!({"repeatCount": 3, "lastRepeatAt": "2026-11-18T09:00:02Z", "precheck": quiet})),
    ];
    let week = read(Tz::UTC, "2026-11-19T17:00:00Z", &[(&drift, &argus, runs)]);
    let ran: Vec<_> = week.blocks.iter().filter(|block| block.state != BlockState::Next).map(|block| (block.day, block.minute, block.state, block.count)).collect();
    assert_eq!(
        ran,
        vec![(0, 540, BlockState::Quiet, 1), (1, 540, BlockState::Quiet, 1), (2, 540, BlockState::Quiet, 1), (3, 900, BlockState::Failed, 1), (3, 960, BlockState::Failed, 1)]
    );
    assert_eq!(week.blocks.iter().find(|block| block.state == BlockState::Failed).and_then(|block| block.note.as_deref()), Some("exit 4"));
    // Every run of the log, once.
    assert_eq!(week.totals, Totals { checks: 5, nothing_new: 3, reports: 0 });
}

#[test]
fn a_fold_that_began_last_week_counts_only_this_weeks_repeats() {
    let argus = bot("argus", false);
    let drift = duty("drift", "argus", daily(9, "UTC"), json!({}));
    let quiet = json!({"stdoutTail": "", "stderrTail": "", "truncated": false, "timedOut": false, "durationMs": 3});
    // Friday 13th to Tuesday 17th: five runs, two of them this week.
    let runs = vec![run("drift", 1, "skippedPrecheck", "2026-11-13T09:00:00Z", json!({"repeatCount": 5, "lastRepeatAt": "2026-11-17T09:00:01Z", "precheck": quiet}))];
    let week = read(Tz::UTC, "2026-11-17T12:00:00Z", &[(&drift, &argus, runs.clone())]);
    assert_eq!(week.totals.checks, 2);
    assert_eq!(states(&week, "drift")[..2], [(0, 540, BlockState::Quiet), (1, 540, BlockState::Quiet)]);
    // Seen from the week before, the same row holds the three before Monday.
    let inputs = [DutyWeek { duty: &drift, bot: &argus, runs: &runs }];
    let before = week_at(monday() - Duration::days(7), "2026-11-17T12:00:00Z", &inputs);
    assert_eq!(before.totals.checks, 3, "Friday, Saturday and Sunday");
}

fn week_at(monday: NaiveDate, now: &str, inputs: &[DutyWeek<'_>]) -> Week {
    week(Tz::UTC, monday, utc(now), inputs, BTreeMap::new())
}

#[test]
fn duties_that_wake_often_or_on_events_are_counted_in_the_two_rows_not_drawn() {
    let sentry = bot("sentry", false);
    let stalled = duty("stalled", "sentry", cron("*/30 * * * *"), json!({}));
    let prs = duty("prs", "sentry", cron("0 9 * * *"), json!({"issueTrigger": {"provider": "github", "repo": "o/r", "query": "is:open"}}));
    let twice = duty("twice", "sentry", cron("0 10,14 * * *"), json!({}));
    let quiet = json!({"stdoutTail": "", "stderrTail": "", "truncated": false, "timedOut": false, "durationMs": 3});
    let stalled_runs = vec![
        run("stalled", 2, "completed", "2026-11-17T12:00:00Z", json!({"duty": {"reportedTo": "owner"}})),
        // Monday 00:00 to Tuesday 11:30, nothing new each time: 48 + 24 runs.
        run("stalled", 1, "skippedPrecheck", "2026-11-16T00:00:00Z", json!({"repeatCount": 72, "lastRepeatAt": "2026-11-17T11:30:01Z", "precheck": quiet})),
    ];
    let pr_runs = vec![
        run("prs", 2, "completed", "2026-11-17T08:00:00Z", json!({"trigger": "issue", "scheduledFor": null, "duty": {"reportedTo": "owner"}})),
        run("prs", 1, "completed", "2026-11-16T08:00:00Z", json!({"trigger": "issue", "scheduledFor": null, "duty": {"reportedTo": "nobody"}})),
    ];
    let week = read(Tz::UTC, "2026-11-17T12:10:00Z", &[(&stalled, &sentry, stalled_runs), (&prs, &sentry, pr_runs), (&twice, &sentry, vec![])]);
    assert_eq!(week.often_duties, vec!["stalled".to_string()]);
    assert_eq!(week.event_duties, vec!["prs".to_string()]);
    assert!(week.blocks.iter().all(|block| block.duty_id == "twice"), "only the duty that wakes twice a day is drawn");
    assert_eq!(states(&week, "twice").len(), 2 * 5 + 1, "Tuesday 14:00 onwards, as blocks still to come");
    assert_eq!(week.often[0], DayCount { ran: 48, reports: 0, failed: 0, planned: 0, scheduled: 48 });
    // Tuesday: 24 nothing new and one report so far, the rest of the day still to come (12:30 … 23:30).
    assert_eq!(week.often[1], DayCount { ran: 25, reports: 1, failed: 0, planned: 23, scheduled: 48 });
    assert_eq!(week.often[2].planned, 48);
    assert_eq!(week.events[0], DayCount { ran: 1, reports: 0, ..Default::default() });
    assert_eq!(week.events[1], DayCount { ran: 1, reports: 1, ..Default::default() });
    assert_eq!(week.totals, Totals { checks: 75, nothing_new: 73, reports: 2 });
    // Next today: one line per duty, soonest first.
    let next: Vec<_> = week.next_today.iter().map(|next| (next.duty_id.as_str(), next.minute)).collect();
    assert_eq!(next, vec![("stalled", 12 * 60 + 30), ("twice", 14 * 60)]);
}

#[test]
fn a_paused_bot_or_a_duty_switched_off_has_nothing_still_to_come() {
    let paused = bot("iris", true);
    let working = bot("atlas", false);
    let check = duty("check", "iris", daily(16, "UTC"), json!({}));
    let off = duty("off", "atlas", daily(16, "UTC"), json!({"enabled": false}));
    let runs = vec![run("check", 1, "cancelled", "2026-11-17T16:00:00Z", json!({"error": duties::PAUSED_SKIP, "endedAt": "2026-11-17T16:00:00Z"}))];
    let week = read(Tz::UTC, "2026-11-18T12:00:00Z", &[(&check, &paused, runs), (&off, &working, vec![])]);
    assert_eq!(states(&week, "check"), vec![(1, 960, BlockState::Skipped)]);
    assert!(states(&week, "off").is_empty());
    // A time skipped while paused looked at nothing.
    assert_eq!(week.totals.checks, 0);
}

#[test]
fn the_week_is_in_the_owners_time_zone() {
    let atlas = bot("atlas", false);
    // 09:00 in New York; Monday's run at 14:00 UTC.
    let status = duty("status", "atlas", daily(9, "America/New_York"), json!({}));
    let runs = vec![run("status", 1, "completed", "2026-11-16T14:00:00Z", json!({"duty": {"reportedTo": "owner"}}))];
    let new_york: Tz = "America/New_York".parse().unwrap();
    let week = read(new_york, "2026-11-16T15:00:00Z", &[(&status, &atlas, runs.clone())]);
    assert_eq!(week.timezone, "America/New_York");
    assert_eq!(states(&week, "status")[0], (0, 9 * 60, BlockState::Reported));
    assert_eq!((week.today, week.now_minute), (Some(0), Some(10 * 60)));
    // Seen from Tokyo, the same run is Monday 23:00, and the next ones the day after at 23:00.
    let tokyo: Tz = "Asia/Tokyo".parse().unwrap();
    let week = read(tokyo, "2026-11-16T15:00:00Z", &[(&status, &atlas, runs)]);
    assert_eq!(states(&week, "status")[..2], [(0, 23 * 60, BlockState::Reported), (1, 23 * 60, BlockState::Next)]);
    // 00:00 Tuesday in Tokyo is 15:00 Monday UTC.
    assert_eq!((week.today, week.now_minute), (Some(1), Some(0)));
}

// Through the runtime's own dispatch.

struct Rig {
    sink: Arc<BroadcastSink>,
    manager: crate::session::SessionManager,
    _home: crate::store::TempHome,
}

impl Drop for Rig {
    fn drop(&mut self) {
        self.manager.closing();
        self.manager.terminals().kill_all();
    }
}

fn rig() -> Rig {
    let home = crate::store::temp_home();
    switch(true);
    let sink = Arc::new(BroadcastSink::new(64));
    let manager = crate::session::SessionManager::new(
        sink.clone(),
        Arc::new(crate::sink::NoObserver),
        Arc::new(crate::harness::host::Host::new()),
        Arc::new(crate::pty::Terminals::new()),
        Arc::new(Default::default()),
        Arc::new(Default::default()),
        crate::hooks::prepare_control().unwrap(),
    );
    Rig { sink, manager, _home: home }
}

fn switch(on: bool) {
    let mut settings = crate::store::settings::load();
    settings.experimental.bots = on;
    crate::store::settings::save(&settings).unwrap();
}

impl Rig {
    fn bots(&self, operation: &str, params: Value) -> Result<Value> {
        let sink: Arc<dyn EventSink> = self.sink.clone();
        crate::local_runtime::calls::execute(&self.manager, &sink, "runtime.session.bots", json!({"operation": operation, "params": params}))
    }

    fn hire(&self, name: &str) -> Bot {
        serde_json::from_value(self.bots("create", json!({"roleTemplateId": "watcher", "name": name})).unwrap()).unwrap()
    }

    fn duty(&self, bot: &Bot, name: &str, schedule: Value) -> Automation {
        let input = json!({"name": name, "prompt": "Look.", "schedule": schedule, "reportsTo": "terminalx", "enabled": true});
        serde_json::from_value(self.bots("dutySave", json!({"id": bot.id, "input": input})).unwrap()).unwrap()
    }
}

#[test]
fn the_week_is_read_through_the_dispatch_for_every_bot_or_one_and_never_with_bots_off() {
    let rig = rig();
    let atlas = rig.hire("Atlas");
    let iris = rig.hire("Iris");
    let status = rig.duty(&atlas, "Daily status", daily(18, "UTC"));
    let check = rig.duty(&iris, "Design check", cron("0 16 * * 2,4"));
    // Last Monday's status reported; it is in the run log as the scheduler writes it.
    automation_store::insert_run(run(&status.id, 1, "completed", "2026-11-16T18:00:00Z", json!({"duty": {"reportedTo": "owner"}}))).unwrap();
    automation_store::insert_run(run(&check.id, 1, "skippedPrecheck", "2026-11-17T16:00:00Z", json!({"precheck": {"stdoutTail": "", "stderrTail": "", "truncated": false, "timedOut": false, "durationMs": 3}}))).unwrap();
    let week = rig.bots("dutyWeek", json!({"week": "2026-11-19", "timezone": "UTC"})).unwrap();
    assert_eq!(week["days"][0], "2026-11-16");
    let blocks = week["blocks"].as_array().unwrap();
    let ran: Vec<&Value> = blocks.iter().filter(|block| block["state"] == "reported").collect();
    assert_eq!(ran.len(), 1, "{week}");
    assert_eq!((ran[0]["dutyId"].as_str(), ran[0]["botId"].as_str(), ran[0]["day"].as_u64(), ran[0]["minute"].as_u64()), (Some(status.id.as_str()), Some(atlas.id.as_str()), Some(0), Some(18 * 60)));
    assert!(blocks.iter().any(|block| block["dutyId"] == check.id.as_str() && block["state"] == "quiet" && block["day"] == 1), "every bot's duties");

    // One bot's.
    let one = rig.bots("dutyWeek", json!({"id": iris.id, "week": "2026-11-19", "timezone": "UTC"})).unwrap();
    assert!(one["blocks"].as_array().unwrap().iter().all(|block| block["botId"] == iris.id.as_str()), "{one}");
    // The owner's time zone when none is given; one this app does not know is refused.
    assert!(rig.bots("dutyWeek", json!({})).unwrap()["timezone"].is_string());
    assert!(rig.bots("dutyWeek", json!({"timezone": "Mars/Olympus"})).is_err());
    assert!(rig.bots("dutyWeek", json!({"id": "no-such-bot"})).is_err());

    // Reading the week changes nothing, and needs no person.
    assert!(!crate::bots::enforce::needs_person("dutyWeek", &json!({})));
    assert!(!crate::serve_cli::consent::guards_request("runtime.session.bots", &json!({"operation": "dutyWeek", "params": {}})));

    switch(false);
    let refused = rig.bots("dutyWeek", json!({})).unwrap_err();
    assert!(refused.to_string().contains("Bots"), "{refused:#}");
    switch(true);
}
