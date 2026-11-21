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
    let inputs: Vec<DutyWeek<'_>> = duties.iter().map(|(duty, bot, runs)| DutyWeek { duty, bot, runs, unreadable: None, deleted_at: None }).collect();
    week(tz, monday(), utc(now), &inputs, BTreeMap::new()).unwrap()
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
    assert_eq!(week.totals, Totals { checks: 4, nothing_new: 1, reports: 1, at_least: false });
    assert!(week.next_today.is_empty(), "today's run has started");
}

/// PRO-497: a run that began and was stopped is said as stopped, never as a time that passed without a run; one
/// skipped because the one before was still going did not run.
#[test]
fn a_stopped_run_is_stopped_and_a_skipped_one_did_not_run() {
    let atlas = bot("atlas", false);
    let status = duty("status", "atlas", daily(9, "UTC"), json!({}));
    let runs = vec![
        run("status", 2, "cancelled", "2026-11-17T09:00:00Z", json!({"error": "Already running", "endedAt": "2026-11-17T09:00:00Z"})),
        run("status", 1, "cancelled", "2026-11-16T09:00:00Z", json!({"sessionId": "s1", "error": "Stopped by you", "endedAt": "2026-11-16T09:20:00Z"})),
    ];
    let week = read(Tz::UTC, "2026-11-17T12:00:00Z", &[(&status, &atlas, runs)]);
    let ran: Vec<_> = week.blocks.iter().filter(|block| block.state != BlockState::Next).map(|block| (block.day, block.state, block.note.as_deref())).collect();
    assert_eq!(ran, vec![(0, BlockState::Stopped, Some("Stopped by you")), (1, BlockState::Skipped, Some("Already running"))]);
    assert_eq!(week.totals.checks, 1, "the stopped run looked at something; the skipped one did not");
    assert_eq!(serde_json::to_value(BlockState::Stopped).unwrap(), json!("stopped"));
}

/// PRO-497: a block says how long its run went on, to its end or, while it runs, to now; a folded repeat and a run of
/// seconds say nothing.
#[test]
fn a_block_says_how_long_its_run_went_on() {
    let atlas = bot("atlas", false);
    let status = duty("status", "atlas", daily(9, "UTC"), json!({}));
    let runs = vec![
        run("status", 3, "running", "2026-11-18T09:00:00Z", json!({"endedAt": null, "sessionId": "s3"})),
        run("status", 2, "completed", "2026-11-17T09:00:00Z", json!({"endedAt": "2026-11-17T09:00:40Z"})),
        run("status", 1, "completed", "2026-11-16T09:00:00Z", json!({"endedAt": "2026-11-16T11:30:00Z", "repeatCount": 1})),
    ];
    let week = read(Tz::UTC, "2026-11-18T09:45:00Z", &[(&status, &atlas, runs)]);
    let minutes: Vec<_> = week.blocks.iter().filter(|block| block.state != BlockState::Next).map(|block| (block.day, block.minutes)).collect();
    assert_eq!(minutes, vec![(0, Some(150)), (1, None), (2, Some(45))]);
    // A folded row's repeats keep no length.
    let quiet = json!({"stdoutTail": "", "stderrTail": "", "truncated": false, "timedOut": false, "durationMs": 3});
    let folded = vec![run("status", 1, "skippedPrecheck", "2026-11-16T09:00:00Z", json!({"repeatCount": 2, "lastRepeatAt": "2026-11-17T09:00:00Z", "endedAt": "2026-11-17T09:10:00Z", "precheck": quiet}))];
    let week = read(Tz::UTC, "2026-11-18T09:45:00Z", &[(&status, &atlas, folded)]);
    let minutes: Vec<_> = week.blocks.iter().filter(|block| block.state != BlockState::Next).map(|block| (block.day, block.minutes)).collect();
    assert_eq!(minutes, vec![(0, None), (1, None)], "a fold's span is not one run's length");
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
    assert_eq!(week.totals, Totals { checks: 5, nothing_new: 3, reports: 0, at_least: false });
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
    let inputs = [DutyWeek { duty: &drift, bot: &argus, runs: &runs, unreadable: None, deleted_at: None }];
    let before = week_at(monday() - Duration::days(7), "2026-11-17T12:00:00Z", &inputs);
    assert_eq!(before.totals.checks, 3, "Friday, Saturday and Sunday");
}

fn week_at(monday: NaiveDate, now: &str, inputs: &[DutyWeek<'_>]) -> Week {
    week(Tz::UTC, monday, utc(now), inputs, BTreeMap::new()).unwrap()
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
    assert_eq!(week.often[0], DayCount { ran: 48, reports: 0, failed: 0, planned: 0, scheduled: 48, ..Default::default() });
    // Tuesday: 24 nothing new and one report so far, the rest of the day still to come (12:30 … 23:30).
    assert_eq!(week.often[1], DayCount { ran: 25, reports: 1, failed: 0, planned: 23, scheduled: 48, ..Default::default() });
    assert_eq!(week.often[2].planned, 48);
    assert_eq!(week.events[0], DayCount { ran: 1, reports: 0, ..Default::default() });
    assert_eq!(week.events[1], DayCount { ran: 1, reports: 1, ..Default::default() });
    assert_eq!(week.totals, Totals { checks: 75, nothing_new: 73, reports: 2, at_least: false });
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

const QUIET: &str = r#"{"stdoutTail": "", "stderrTail": "", "truncated": false, "timedOut": false, "durationMs": 3}"#;

/// M1 (review 1): a duty that wakes every half hour keeps about two days in its log of 100 runs. The days before
/// the oldest kept run say "not kept", never that nothing ran, and the totals are floors.
#[test]
fn days_the_log_no_longer_covers_are_not_kept_never_empty() {
    let argus = bot("argus", false);
    let stalled = duty("stalled", "argus", cron("*/30 * * * *"), json!({}));
    let quiet: Value = serde_json::from_str(QUIET).unwrap();
    // The newest 100 runs (numbers 101 … 200: the first 100 were dropped), Friday 11:30 back to Wednesday 10:00, as
    // a log cut at 100 keeps them (newest first).
    let newest = utc("2026-11-20T11:30:00Z");
    let kept = |first_number: u64| -> Vec<AutomationRun> {
        (0..automation_store::RUN_RETENTION as i64)
            .map(|n| {
                let at = (newest - Duration::minutes(30 * n)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
                // Alternating results, so no two are folded into one row.
                let status = if n % 2 == 0 { "skippedPrecheck" } else { "completed" };
                run("stalled", first_number + 99 - n as u64, status, &at, json!({"precheck": quiet, "duty": {"reportedTo": "nobody"}}))
            })
            .collect()
    };
    let week = read(Tz::UTC, "2026-11-20T12:00:00Z", &[(&stalled, &argus, kept(101))]);
    let cells: Vec<(u32, u32)> = week.often.iter().map(|day| (day.ran, day.not_kept)).collect();
    // Monday and Tuesday not kept; Wednesday kept from 10:00 (28 runs, at least); Thursday and Friday whole.
    assert_eq!(cells, vec![(0, 1), (0, 1), (28, 1), (48, 0), (24, 0), (0, 0), (0, 0)]);
    assert_eq!(week.totals.checks, 100);
    assert!(week.totals.at_least);
    assert_eq!(week.logs.len(), 1);
    assert_eq!(week.logs[0].kept_from.as_deref(), Some("2026-11-18T10:00:00Z"));
    assert!(week.logs[0].unreadable.is_none());

    // A log with fewer runs than it keeps lost nothing: the empty days are days on which nothing ran.
    let short = read(Tz::UTC, "2026-11-20T12:00:00Z", &[(&stalled, &argus, vec![])]);
    assert!(short.often.iter().all(|day| day.not_kept == 0) && !short.totals.at_least && short.logs.is_empty());
    // Nor did a log holding exactly its first 100 runs (numbers 1 … 100).
    let whole = read(Tz::UTC, "2026-11-20T12:00:00Z", &[(&stalled, &argus, kept(1))]);
    assert!(whole.often.iter().all(|day| day.not_kept == 0) && !whole.totals.at_least && whole.logs.is_empty());
    // A run #1 left pending is kept through compaction; the cut log is still cut.
    let mut stuck = kept(101);
    stuck.push(run("stalled", 1, "pending", "2026-11-01T09:00:00Z", json!({})));
    let cut = read(Tz::UTC, "2026-11-20T12:00:00Z", &[(&stalled, &argus, stuck)]);
    assert_eq!(cut.logs.first().and_then(|log| log.kept_from.as_deref()), Some("2026-11-18T10:00:00Z"));
}

#[test]
fn an_unreadable_log_is_said_on_its_duty_and_its_days_are_not_kept() {
    let atlas = bot("atlas", false);
    let status = duty("status", "atlas", daily(18, "UTC"), json!({}));
    let inputs = [DutyWeek { duty: &status, bot: &atlas, runs: &[], unreadable: Some("runs.jsonl: line 3 is not JSON"), deleted_at: None }];
    let week = week(Tz::UTC, monday(), utc("2026-11-18T09:30:00Z"), &inputs, BTreeMap::new()).unwrap();
    let days: Vec<Vec<(String, u32)>> = week.not_kept.iter().map(|day| day.iter().map(|gap| (gap.duty_id.clone(), gap.until_minute)).collect()).collect();
    // Monday and Tuesday whole, Wednesday up to now; nothing after now.
    let gap = |minute| vec![("status".to_string(), minute)];
    assert_eq!(days, vec![gap(1440), gap(1440), gap(9 * 60 + 30), vec![], vec![], vec![], vec![]]);
    assert_eq!(week.logs[0].unreadable.as_deref(), Some("runs.jsonl: line 3 is not JSON"));
    assert!(week.totals.at_least);
    // What is still to come comes from its schedule, which is readable.
    assert_eq!(states(&week, "status").first(), Some(&(2, 1080, BlockState::Next)));
}

/// L3 and N1: the scheduler fires a repeated local time once, so an every-minute duty has exactly 10,080 times even in
/// the week the clocks go back, and is not capped; a schedule with more times than are looked at says so.
#[test]
fn a_schedule_past_the_cap_says_its_count_is_a_floor() {
    let argus = bot("argus", false);
    let every = duty("every", "argus", json!({"kind": "cron", "cron": "* * * * *", "timezone": "Europe/London", "dtstart": "2026-01-01T00:00:00Z"}), json!({}));
    let london: Tz = "Europe/London".parse().unwrap();
    let inputs = [DutyWeek { duty: &every, bot: &argus, runs: &[], unreadable: None, deleted_at: None }];
    let back = week(london, NaiveDate::from_ymd_opt(2026, 10, 19).unwrap(), utc("2026-10-01T00:00:00Z"), &inputs, BTreeMap::new()).unwrap();
    assert_eq!(back.often.iter().map(|day| day.planned).sum::<u32>(), MAX_OCCURRENCES as u32);
    assert!(back.often.iter().all(|day| !day.capped) && back.logs.is_empty(), "{:?}", back.logs);

    // The cap itself, on the helper: more times than asked for say so, exactly as many do not.
    let schedule: automations::AutomationSchedule = serde_json::from_value(cron("*/30 * * * *")).unwrap();
    let (from, until) = (utc("2026-11-16T00:00:00Z"), utc("2026-11-16T05:00:00Z"));
    let (ten, capped) = automations::occurrences_between(&schedule, from, until, 9).unwrap();
    assert_eq!((ten.len(), capped), (9, true));
    let (all, capped) = automations::occurrences_between(&schedule, from, until, 10).unwrap();
    assert_eq!((all.len(), capped), (10, false));
}

/// L3: the shared helper gives the same times as asking `next_run_after` again and again.
#[test]
fn occurrences_between_agrees_with_next_run_after() {
    let new_york = |expression: &str| json!({"kind": "cron", "cron": expression, "timezone": "America/New_York", "dtstart": "2026-01-01T00:00:00Z"});
    let ordinary = [cron("0 10,14 * * 1-5"), cron("*/45 * * * *"), daily(9, "America/New_York"), json!({"kind": "preset", "preset": "hourly", "minute": 15, "timezone": "Asia/Kolkata", "dtstart": "2026-01-01T00:00:00Z"})]
        .map(|schedule| (schedule, "2026-11-16T00:00:00Z", "2026-11-23T00:00:00Z"));
    // N1: the weeks New York's clocks go back (1 November) and forward (8 March), from local midnight to midnight.
    let changes = ["30 1 * * *", "*/30 * * * *", "30 2 * * *"]
        .into_iter()
        .flat_map(|expression| [(new_york(expression), "2026-10-26T04:00:00Z", "2026-11-02T05:00:00Z"), (new_york(expression), "2026-03-02T05:00:00Z", "2026-03-09T04:00:00Z")]);
    for (schedule, from, until) in ordinary.into_iter().chain(changes) {
        let schedule: automations::AutomationSchedule = serde_json::from_value(schedule).unwrap();
        let (from, until) = (utc(from), utc(until));
        let (shared, capped) = automations::occurrences_between(&schedule, from, until, MAX_OCCURRENCES).unwrap();
        let mut one_by_one = Vec::new();
        let mut at = from;
        while let Ok(next) = automations::next_run_after(&schedule, at) {
            if next > until {
                break;
            }
            one_by_one.push(next);
            at = next;
        }
        assert_eq!((shared, capped), (one_by_one, false), "{schedule:?}");
    }
}

/// L2: the scheduler's cron numbers the days 1 = Sunday … 7 = Saturday; the window's drag uses the same numbers
/// (`CRON_WEEKDAYS` in `src/lib/automationSchedule.ts`).
#[test]
fn the_schedulers_cron_numbers_sunday_one_to_saturday_seven() {
    use chrono::Weekday::*;
    for (number, weekday) in [(1, Sun), (2, Mon), (3, Tue), (4, Wed), (5, Thu), (6, Fri), (7, Sat)] {
        let schedule: automations::AutomationSchedule = serde_json::from_value(cron(&format!("0 9 * * {number}"))).unwrap();
        let next = automations::next_run_after(&schedule, utc("2026-11-16T00:00:00Z")).unwrap();
        assert_eq!(next.weekday(), weekday, "{number}");
    }
    let zero: automations::AutomationSchedule = serde_json::from_value(cron("0 9 * * 0")).unwrap();
    assert!(automations::next_run_after(&zero, utc("2026-11-16T00:00:00Z")).is_err(), "0 is not a day here");
}

/// L4: a week far off is refused, never a panic, from the dispatch too.
#[test]
fn a_week_outside_the_range_is_refused() {
    for day in ["1999-12-27", "2200-01-05", "9999-12-31"] {
        let monday = NaiveDate::parse_from_str(day, "%Y-%m-%d").unwrap();
        assert!(week(Tz::UTC, monday, utc("2026-11-20T00:00:00Z"), &[], BTreeMap::new()).is_err(), "{day}");
    }
    assert!(week(Tz::UTC, NaiveDate::from_ymd_opt(2199, 12, 30).unwrap(), utc("2026-11-20T00:00:00Z"), &[], BTreeMap::new()).is_ok());
    assert_eq!(start_of(NaiveDate::MIN, Weekday::Mon), None);
    // A week starting on Saturday 1 January 2000 is the first; the one before it is not.
    assert!(week(Tz::UTC, NaiveDate::from_ymd_opt(2000, 1, 1).unwrap(), utc("2026-11-20T00:00:00Z"), &[], BTreeMap::new()).is_ok());
    assert!(week(Tz::UTC, NaiveDate::from_ymd_opt(1999, 12, 31).unwrap(), utc("2026-11-20T00:00:00Z"), &[], BTreeMap::new()).is_err());
}

/// L5: when midnight does not exist (Chile moves its clocks from 24:00 to 01:00), the day starts at the first
/// valid instant after the gap.
#[test]
fn a_day_whose_midnight_does_not_exist_starts_after_the_gap() {
    let santiago: Tz = "America/Santiago".parse().unwrap();
    let day = NaiveDate::from_ymd_opt(2026, 9, 6).unwrap();
    assert!(santiago.from_local_datetime(&day.and_hms_opt(0, 0, 0).unwrap()).earliest().is_none(), "the gap this test is about");
    assert_eq!(local_midnight(santiago, day), utc("2026-09-06T04:00:00Z"));
    assert_eq!(local_midnight(Tz::UTC, day), utc("2026-09-06T00:00:00Z"));
}

/// L6: a run's reason is capped on a block.
#[test]
fn a_blocks_note_is_capped() {
    let atlas = bot("atlas", false);
    let status = duty("status", "atlas", daily(18, "UTC"), json!({}));
    let long = "x".repeat(5000);
    let runs = vec![run("status", 1, "failed", "2026-11-16T18:00:00Z", json!({"error": long}))];
    let week = read(Tz::UTC, "2026-11-17T09:00:00Z", &[(&status, &atlas, runs)]);
    let note = week.blocks[0].note.as_deref().unwrap();
    assert_eq!(note.chars().count(), NOTE_CHARS);
    assert!(note.ends_with('…'));
}

/// PRO-499: the week starts on the day the window asks for, and a block's day counts from it; a duty's stored
/// weekday means the same day whatever the week starts on.
#[test]
fn the_week_starts_on_the_day_asked_for_and_a_stored_weekday_keeps_its_meaning() {
    let thursday = NaiveDate::from_ymd_opt(2026, 11, 19).unwrap();
    assert_eq!(start_of(thursday, Weekday::Mon), Some(monday()));
    assert_eq!(start_of(thursday, Weekday::Sun), NaiveDate::from_ymd_opt(2026, 11, 15));
    assert_eq!(start_of(thursday, Weekday::Sat), NaiveDate::from_ymd_opt(2026, 11, 14));
    assert_eq!(start_of(thursday, Weekday::Thu), Some(thursday));
    assert_eq!(first_weekday(&Value::Null).unwrap(), Weekday::Mon, "an older window says nothing: Monday");
    assert_eq!(first_weekday(&json!(6)).unwrap(), Weekday::Sun);
    assert_eq!(first_weekday(&json!(5)).unwrap(), Weekday::Sat);
    for wrong in [json!(7), json!(-1), json!("SU"), json!(1.5)] {
        assert!(first_weekday(&wrong).is_err(), "{wrong}");
    }

    let atlas = bot("atlas", false);
    // Weekly on Mondays at 09:00, as the editor stores it.
    let weekly = duty("weekly", "atlas", json!({"kind": "preset", "preset": "weekly", "weekdays": ["MO"], "hour": 9, "minute": 0, "timezone": "UTC", "dtstart": "2026-01-01T00:00:00Z"}), json!({}));
    let runs = vec![run("weekly", 1, "completed", "2026-11-16T09:00:00Z", json!({}))];
    let inputs = [DutyWeek { duty: &weekly, bot: &atlas, runs: &runs, unreadable: None, deleted_at: None }];
    let sunday = NaiveDate::from_ymd_opt(2026, 11, 15).unwrap();
    let week = week(Tz::UTC, sunday, utc("2026-11-19T12:00:00Z"), &inputs, BTreeMap::new()).unwrap();
    assert_eq!(week.days, ["2026-11-15", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21"]);
    assert_eq!((week.today, week.now_minute), (Some(4), Some(12 * 60)));
    assert_eq!(states(&week, "weekly"), vec![(1, 540, BlockState::Done)], "Monday is the second day of a week that starts on Sunday");
}

/// PRO-499: a deleted duty's kept runs are drawn where they ran, marked deleted and named; nothing of it is to come,
/// and it is not counted among the duties that wake often.
#[test]
fn a_deleted_duty_keeps_its_past_runs_and_nothing_is_to_come() {
    let atlas = bot("atlas", false);
    let mut status = duty("status", "atlas", daily(9, "UTC"), json!({}));
    status.name = "Daily status".into();
    let runs = vec![
        run("status", 2, "completed", "2026-11-17T09:00:00Z", json!({"duty": {"reportedTo": "owner"}})),
        run("status", 1, "skippedPrecheck", "2026-11-16T09:00:00Z", json!({"precheck": {"stdoutTail": "", "stderrTail": "", "truncated": false, "timedOut": false, "durationMs": 3}})),
    ];
    let every = duty("every", "atlas", cron("*/30 * * * *"), json!({}));
    let often = vec![run("every", 1, "completed", "2026-11-16T10:00:00Z", json!({}))];
    let gone = Some("2026-11-17T12:00:00Z");
    let inputs = [
        DutyWeek { duty: &status, bot: &atlas, runs: &runs, unreadable: None, deleted_at: gone },
        DutyWeek { duty: &every, bot: &atlas, runs: &often, unreadable: None, deleted_at: gone },
    ];
    let week = week_at(monday(), "2026-11-19T08:00:00Z", &inputs);
    let drawn: Vec<_> = week.blocks.iter().map(|block| (block.duty_id.as_str(), block.day, block.state, block.deleted)).collect();
    assert_eq!(drawn, vec![("status", 0, BlockState::Quiet, true), ("status", 1, BlockState::Reported, true)], "no block still to come");
    assert!(week.next_today.is_empty());
    assert_eq!(week.totals.checks, 3, "what ran is counted");
    assert!(week.often_duties.is_empty(), "a deleted duty wakes on nothing");
    assert_eq!((week.often[0].ran, week.often[3].scheduled), (1, 0));
    assert_eq!(week.deleted.iter().map(|gone| (gone.duty_id.as_str(), gone.name.as_str(), gone.deleted_at.as_str())).collect::<Vec<_>>(), vec![("every", "every", "2026-11-17T12:00:00Z"), ("status", "Daily status", "2026-11-17T12:00:00Z")]);
    assert_eq!(serde_json::to_value(&week.blocks[0]).unwrap()["deleted"], true);
    // A week it ran nothing in does not name it.
    let later = week_at(NaiveDate::from_ymd_opt(2026, 11, 23).unwrap(), "2026-11-24T08:00:00Z", &inputs);
    assert!(later.blocks.is_empty() && later.deleted.is_empty());
}

/// PRO-499: a run that goes on past midnight goes on, as a second block, on the next day; one that began in the
/// week before is drawn from this week's first midnight and counted in the week it began.
#[test]
fn a_run_past_midnight_goes_on_the_next_day() {
    let atlas = bot("atlas", false);
    let late = duty("late", "atlas", daily(22, "UTC"), json!({}));
    let runs = vec![
        run("late", 3, "completed", "2026-11-17T22:00:00Z", json!({"endedAt": "2026-11-17T23:30:00Z"})),
        run("late", 2, "completed", "2026-11-16T22:00:00Z", json!({"endedAt": "2026-11-17T01:30:00Z"})),
        run("late", 1, "completed", "2026-11-15T23:00:00Z", json!({"endedAt": "2026-11-16T01:00:00Z"})),
    ];
    let week = read(Tz::UTC, "2026-11-18T08:00:00Z", &[(&late, &atlas, runs)]);
    let ran: Vec<_> = week.blocks.iter().filter(|block| block.state != BlockState::Next).map(|block| (block.day, block.minute, block.minutes, block.continued, block.run_id.as_deref())).collect();
    assert_eq!(
        ran,
        vec![
            (0, 0, Some(60), true, Some("late-1")),
            (0, 22 * 60, Some(210), false, Some("late-2")),
            (1, 0, Some(90), true, Some("late-2")),
            (1, 22 * 60, Some(90), false, Some("late-3")),
        ]
    );
    assert_eq!(week.totals.checks, 2, "the run that began last Sunday is last week's");
    let continued = serde_json::to_value(&week.blocks[0]).unwrap();
    assert_eq!((continued["continued"].clone(), continued["at"].clone()), (json!(true), json!("2026-11-16T00:00:00Z")));
    assert!(serde_json::to_value(&week.blocks[1]).unwrap().get("continued").is_none(), "said only when true");

    // One still running, across two midnights, to now.
    let long = vec![run("late", 1, "running", "2026-11-16T22:00:00Z", json!({"endedAt": null}))];
    let week = read(Tz::UTC, "2026-11-18T03:00:00Z", &[(&late, &atlas, long)]);
    let ran: Vec<_> = week.blocks.iter().filter(|block| block.state == BlockState::Running).map(|block| (block.day, block.minute, block.minutes, block.continued)).collect();
    assert_eq!(ran, vec![(0, 22 * 60, Some(29 * 60), false), (1, 0, Some(27 * 60), true), (2, 0, Some(3 * 60), true)]);
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
    // A far-off week is refused, not a panic.
    for far in ["9999-12-31", "1900-01-01"] {
        let refused = rig.bots("dutyWeek", json!({"week": far})).unwrap_err();
        assert!(refused.to_string().contains("Weeks from"), "{far}: {refused:#}");
    }

    // Reading the week changes nothing, and needs no person.
    assert!(!crate::bots::enforce::needs_person("dutyWeek", &json!({})));
    assert!(!crate::serve_cli::consent::guards_request("runtime.session.bots", &json!({"operation": "dutyWeek", "params": {}})));

    {
        let _off = BotsOff::now();
        let refused = rig.bots("dutyWeek", json!({})).unwrap_err();
        assert!(refused.to_string().contains("Bots"), "{refused:#}");
    }
    assert!(rig.bots("dutyWeek", json!({})).is_ok());
}

/// PRO-499: deleting a duty keeps its run log and its name; the week draws its past runs and its log still opens.
/// Its bot's deletion takes the kept log with it. The week starts on the day the window asks for.
#[test]
fn a_deleted_duty_is_read_through_the_dispatch_and_goes_with_its_bot() {
    let rig = rig();
    let atlas = rig.hire("Atlas");
    let iris = rig.hire("Iris");
    let status = rig.duty(&atlas, "Daily status", daily(18, "UTC"));
    automation_store::insert_run(run(&status.id, 1, "completed", "2026-11-16T18:00:00Z", json!({"duty": {"reportedTo": "owner"}}))).unwrap();
    // One that never ran leaves nothing behind.
    let never = rig.duty(&atlas, "Never ran", daily(7, "UTC"));
    rig.bots("dutyDelete", json!({"id": atlas.id, "dutyId": status.id})).unwrap();
    rig.bots("dutyDelete", json!({"id": atlas.id, "dutyId": never.id})).unwrap();
    assert!(automation_store::get(&status.id).is_err(), "no longer a duty");
    let folder = crate::store::root().unwrap().join("automations").join(&status.id);
    assert!(folder.join("runs.jsonl").is_file() && folder.join("deleted.json").is_file());
    assert!(!crate::store::root().unwrap().join("automations").join(&never.id).exists());

    let week = rig.bots("dutyWeek", json!({"week": "2026-11-19", "timezone": "UTC"})).unwrap();
    let blocks: Vec<&Value> = week["blocks"].as_array().unwrap().iter().filter(|block| block["dutyId"] == status.id.as_str()).collect();
    assert_eq!(blocks.len(), 1, "its past run, and nothing to come: {week}");
    assert_eq!((blocks[0]["state"].as_str(), blocks[0]["deleted"].as_bool()), (Some("reported"), Some(true)));
    assert_eq!(week["deleted"][0]["name"], "Daily status");
    assert_eq!(week["deleted"][0]["botId"], atlas.id.as_str());

    let log = rig.bots("dutyKeptLog", json!({"id": atlas.id, "dutyId": status.id})).unwrap();
    assert_eq!((log["name"].as_str(), log["runs"].as_array().map(Vec::len)), (Some("Daily status"), Some(1)));
    assert!(log["deletedAt"].is_string());
    assert!(rig.bots("dutyKeptLog", json!({"id": iris.id, "dutyId": status.id})).is_err(), "another bot's");
    assert!(rig.bots("dutyKeptLog", json!({"id": atlas.id, "dutyId": "../automations.json"})).is_err());
    assert!(!crate::bots::enforce::needs_person("dutyKeptLog", &json!({})));
    assert!(!crate::serve_cli::consent::guards_request("runtime.session.bots", &json!({"operation": "dutyKeptLog", "params": {}})));

    // A week from Sunday: the run on Monday is its second day.
    let sunday = rig.bots("dutyWeek", json!({"week": "2026-11-19", "timezone": "UTC", "firstDay": 6})).unwrap();
    assert_eq!(sunday["days"][0], "2026-11-15");
    assert!(sunday["blocks"].as_array().unwrap().iter().any(|block| block["dutyId"] == status.id.as_str() && block["day"] == 1), "{sunday}");
    assert!(rig.bots("dutyWeek", json!({"firstDay": 7})).unwrap_err().to_string().contains("firstDay"));

    rig.bots("delete", json!({"id": atlas.id})).unwrap();
    assert!(!folder.exists(), "the kept log goes with its bot");
    let trashed = crate::store::root().unwrap().join("trash").join("bots").join(&atlas.id);
    assert!(trashed.join("duty-runs").join(&status.id).join("runs.jsonl").is_file(), "into its home, in the trash");
}

/// The Bots switch is off while this lives, and on again after, whatever the test does.
struct BotsOff;

impl BotsOff {
    fn now() -> Self {
        switch(false);
        Self
    }
}

impl Drop for BotsOff {
    fn drop(&mut self) {
        switch(true);
    }
}
