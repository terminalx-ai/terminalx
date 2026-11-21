//! A week of duties (PRO-473, design 23.13): what ran, what it found, and what
//! is still to come, for every bot or one, in the owner's time zone.
//!
//! Nothing here is stored or scheduled. The week is read from what already
//! exists: each duty's run log (`automations/<id>/runs.jsonl`) for what ran,
//! and its schedule, through the scheduler's own `next_run_after`, for what is
//! still to come. A row that folds repeats ("Nothing new" again) stands for
//! that many runs: its repeats are put at the schedule's times between its
//! first run and its last, so the week counts every run the log counts.
//!
//! A duty that wakes more than [`OFTEN_PER_DAY`] times on some day, and one
//! that wakes on events, is counted per day in the two rows on top rather
//! than drawn one block per run.
//!
//! A log keeps its newest [`automation_store::RUN_RETENTION`] finished runs,
//! so a duty that wakes every half hour keeps two or three days. The week
//! says how far back each log still reaches ([`DutyLog`]), and the days
//! before that are "not kept" ([`NotKept`], [`DayCount::not_kept`]), never
//! days on which nothing ran; totals that include them are "at least".
//!
//! PRO-499: the week starts on the day the window asks for (`firstDay`, from
//! the owner's region), Monday when it does not say; a block's `day` counts
//! from that day, and what a stored weekday means never changes. A deleted
//! duty's kept log ([`automation_store::Deleted`]) is read too: its past runs
//! are drawn, marked deleted, under its name. A run that goes on past
//! midnight is drawn on each day it covers, the later ones `continued`.

use std::collections::{BTreeMap, BTreeSet};

use anyhow::Result;
use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Timelike, Utc, Weekday};
use chrono_tz::Tz;
use serde::Serialize;
use serde_json::Value;

use super::{duties, refused, Bot};
use crate::automations::{self, Automation, AutomationRun, AutomationRunStatus, AutomationTrigger};
use crate::store::automations as automation_store;
use crate::store::bots as bot_store;

/// A duty due more often than this on any day of the week is counted, not drawn.
pub const OFTEN_PER_DAY: usize = 6;
/// The most times of one schedule looked at for one question: every minute of a week fits.
const MAX_OCCURRENCES: usize = 10_080;
/// The most of a run's reason a block carries.
const NOTE_CHARS: usize = 200;
/// The weeks that may be asked for, by their first day: a fixed range, so no date sum can overflow.
const FIRST_DAY: (i32, u32, u32) = (2000, 1, 1);
const LAST_DAY: (i32, u32, u32) = (2199, 12, 31);
/// How many of today's next runs the right column lists.
const NEXT_TODAY: usize = 8;

/// What a block on the grid says happened, or will.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BlockState {
    /// Ran, and its work is in its session; nothing was reported.
    Done,
    /// Ran and reported something, to the owner or its lead.
    Reported,
    /// Ran and found nothing new: its first check printed nothing, or it replied "Nothing new."
    Quiet,
    /// Still to come on its schedule.
    Next,
    /// Its check or its agent is going now.
    Running,
    /// Its check failed, or it timed out.
    Failed,
    /// It began, and was stopped before it finished.
    Stopped,
    /// Its time passed without a run: the app was closed, its bot was paused, or its previous run had not finished.
    Skipped,
}

/// One run, or a time still to come, of a duty drawn on the grid.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub duty_id: String,
    pub bot_id: String,
    /// The day of the week it is on, 0 for the week's first day … 6 (Monday first unless the week was asked to
    /// start on another day).
    pub day: u32,
    /// Minutes after midnight, in the owner's time zone.
    pub minute: u32,
    pub at: String,
    pub state: BlockState,
    /// The runs it stands for: more than one only for repeats the log keeps no time of.
    pub count: u32,
    /// How long its run went on, to its end or to now while it runs, when the log says: a block for one run only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minutes: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Why it failed or was skipped, as its run says.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Its duty was deleted: its run is kept in its log, and nothing more is to come.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub deleted: bool,
    /// The run began on a day before this one and goes on over its midnight: `minute` is when this day begins,
    /// and `minutes` how long the run goes on from there.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub continued: bool,
}

/// A deleted duty drawn this week, by its name: the duties the window knows no longer have it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedDuty {
    pub duty_id: String,
    pub bot_id: String,
    pub name: String,
    pub deleted_at: String,
}

/// One day of a counted row.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayCount {
    /// Runs that looked at something (a check or the agent).
    pub ran: u32,
    pub reports: u32,
    pub failed: u32,
    /// Runs still to come this day.
    pub planned: u32,
    /// Runs the schedules of the duties counted here have on this day, whether or not they are on.
    pub scheduled: u32,
    /// How many of the duties counted here have a log that no longer reaches back over this day (or could not be
    /// read): what ran is then at least `ran`, and none may mean only that nothing is kept.
    pub not_kept: u32,
    /// Some schedule counted here had more times this week than were looked at: `planned` is a floor.
    pub capped: bool,
}

/// The week's totals so far, as Today's counts are on a duty's tab.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    pub checks: u32,
    pub nothing_new: u32,
    pub reports: u32,
    /// Some log no longer reaches back over the part of the week that has passed, or could not be read: these are floors.
    pub at_least: bool,
}

/// A drawn duty whose log does not reach back over (part of) a day: from midnight to `until_minute` nothing is kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotKept {
    pub duty_id: String,
    pub until_minute: u32,
}

/// What the week knows of a duty's log, for a duty whose log does not tell the whole week.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DutyLog {
    pub duty_id: String,
    pub bot_id: String,
    /// The oldest instant its log still covers: older runs were dropped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kept_from: Option<String>,
    /// Why its log could not be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unreadable: Option<String>,
    /// Its schedule had more times this week than were looked at.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub capped: bool,
}

/// A run still to come today, for the right column.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextRun {
    pub duty_id: String,
    pub bot_id: String,
    pub minute: u32,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Week {
    pub timezone: String,
    /// The seven days, from the week's first day, `YYYY-MM-DD`.
    pub days: Vec<String>,
    /// Which of them is today, when this week is the current one.
    pub today: Option<u32>,
    /// Now, in minutes after midnight, when today is shown.
    pub now_minute: Option<u32>,
    pub blocks: Vec<Block>,
    /// Duties that wake many times a day, counted per day.
    pub often: Vec<DayCount>,
    pub often_duties: Vec<String>,
    /// Duties that wake on events, counted per day.
    pub events: Vec<DayCount>,
    pub event_duties: Vec<String>,
    pub next_today: Vec<NextRun>,
    pub totals: Totals,
    /// Quiet hours by bot id, for the bots that have them.
    pub quiet_hours: BTreeMap<String, duties::QuietHours>,
    /// Per day, the drawn duties whose log does not reach back over it.
    pub not_kept: Vec<Vec<NotKept>>,
    /// The duties whose log does not tell the whole week: cut, unreadable or capped.
    pub logs: Vec<DutyLog>,
    /// The deleted duties whose kept runs are drawn this week.
    pub deleted: Vec<DeletedDuty>,
}

/// One duty as the week reads it.
pub struct DutyWeek<'a> {
    pub duty: &'a Automation,
    pub bot: &'a Bot,
    /// Newest first, as the log keeps them.
    pub runs: &'a [AutomationRun],
    /// Why its log could not be read (and `runs` is empty).
    pub unreadable: Option<&'a str>,
    /// When the duty was deleted, for one whose log is kept: its past runs only are read.
    pub deleted_at: Option<&'a str>,
}

fn parse(at: Option<&str>) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(at?).ok().map(|at| at.with_timezone(&Utc))
}

/// A duty's schedule's times in `(after, until]`, at most `cap` of them, oldest first, and whether more were left.
/// A schedule this build cannot read has none.
fn occurrences(duty: &Automation, after: DateTime<Utc>, until: DateTime<Utc>, cap: usize) -> (Vec<DateTime<Utc>>, bool) {
    automations::occurrences_between(&duty.schedule, after, until, cap).unwrap_or_default()
}

/// When a run (its first, for a folded row) happened.
fn first_time(run: &AutomationRun) -> Option<DateTime<Utc>> {
    match run.trigger {
        AutomationTrigger::Scheduled => parse(run.scheduled_for.as_deref()),
        _ => None,
    }
    .or_else(|| parse(run.started_at.as_deref()))
    .or_else(|| parse(run.ended_at.as_deref()))
}

/// The oldest instant a log still covers, once it has dropped runs: those before its oldest kept one. Runs are
/// numbered from 1, one past the highest kept, so a full log whose lowest number is above 1 has dropped some.
/// `None` while nothing was dropped.
fn kept_from(runs: &[AutomationRun]) -> Option<DateTime<Utc>> {
    let finished: Vec<&AutomationRun> = runs.iter().filter(|run| run.status.is_terminal()).collect();
    // Over finished runs only: a run #1 stuck pending is kept past compaction and says nothing of what was dropped.
    let dropped = finished.len() >= automation_store::RUN_RETENTION && finished.iter().map(|run| run.run_number).min().is_some_and(|lowest| lowest > 1);
    dropped.then(|| finished.iter().filter_map(|run| first_time(run)).min()).flatten()
}

/// `text` cut to [`NOTE_CHARS`].
fn capped_note(text: &str) -> String {
    if text.chars().count() > NOTE_CHARS {
        format!("{}…", text.chars().take(NOTE_CHARS - 1).collect::<String>())
    } else {
        text.to_owned()
    }
}

/// The first instant of `day` in `tz`: midnight, or when midnight does not exist there (a clock moved forward over
/// it) the first valid instant after the gap.
pub(crate) fn local_midnight(tz: Tz, day: NaiveDate) -> DateTime<Utc> {
    let midnight = day.and_hms_opt(0, 0, 0).expect("midnight");
    for minutes in 0..=24 * 60 {
        if let Some(at) = tz.from_local_datetime(&(midnight + Duration::minutes(minutes))).earliest() {
            return at.with_timezone(&Utc);
        }
    }
    Utc.from_utc_datetime(&midnight)
}

fn wakes_on_events(duty: &Automation) -> bool {
    duty.issue_trigger.is_some() || duty.event_trigger.is_some()
}

fn event_trigger(trigger: AutomationTrigger) -> bool {
    !matches!(trigger, AutomationTrigger::Scheduled | AutomationTrigger::Manual)
}

/// What a run's block shows.
fn state_of(run: &AutomationRun) -> BlockState {
    match run.status {
        // A run that began (its check or its agent) and was then stopped: not a time that passed without one.
        AutomationRunStatus::Cancelled if woke(run) => BlockState::Stopped,
        AutomationRunStatus::Pending | AutomationRunStatus::Running => BlockState::Running,
        AutomationRunStatus::SkippedPrecheck => BlockState::Quiet,
        AutomationRunStatus::Failed | AutomationRunStatus::TimedOut => BlockState::Failed,
        AutomationRunStatus::Cancelled | AutomationRunStatus::SkippedMissed | AutomationRunStatus::SkippedUnavailable => BlockState::Skipped,
        AutomationRunStatus::Completed => {
            let report = run.unknown.get(duties::RUN_KEY);
            match report.and_then(|report| report.get("reportedTo")).and_then(Value::as_str) {
                None => BlockState::Done,
                Some("nobody") => BlockState::Quiet,
                Some(_) => BlockState::Reported,
            }
        }
    }
}

/// Whether a run looked at something: not a time that passed while the app was closed or the bot paused.
fn woke(run: &AutomationRun) -> bool {
    run.status != AutomationRunStatus::SkippedMissed && !(run.status == AutomationRunStatus::Cancelled && run.precheck.is_none() && run.session_id.is_none())
}

/// How many whole minutes a run went on, from when it was due (or began) to its end, or to `now` while it runs; `None`
/// when the log does not say, or for a run of a few seconds.
fn run_minutes(run: &AutomationRun, now: DateTime<Utc>) -> Option<u32> {
    let from = first_time(run)?;
    let to = match run.status {
        AutomationRunStatus::Pending | AutomationRunStatus::Running => now,
        _ => parse(run.ended_at.as_deref())?,
    };
    let minutes = to.signed_duration_since(from).num_minutes();
    (minutes > 0).then(|| minutes.min(7 * 24 * 60) as u32)
}

/// When a run happened, and when each of its folded repeats did in the week
/// `[start, end)`, as `(time, runs)`.
fn times_of(duty: &Automation, run: &AutomationRun, start: DateTime<Utc>, end: DateTime<Utc>) -> Vec<(DateTime<Utc>, u32)> {
    let Some(first) = first_time(run) else { return Vec::new() };
    let mut times = vec![(first, 1)];
    let repeats = run.repeat_count.saturating_sub(1);
    if repeats == 0 {
        return times;
    }
    let Some(last) = parse(run.last_repeat_at.as_deref()).filter(|last| *last >= first) else {
        times[0].1 += repeats;
        return times;
    };
    // The repeats of a scheduled run are the newest `repeats` of its schedule's times up to the last. Only the
    // week's are looked for: those after it are counted (at most `repeats`), those before it are what is left.
    let mut accounted = 0;
    if run.trigger == AutomationTrigger::Scheduled && !wakes_on_events(duty) {
        let after = if last >= end { occurrences(duty, end - Duration::nanoseconds(1), last, repeats as usize).0.len() as u32 } else { 0 };
        let (within, _) = occurrences(duty, first.max(start - Duration::nanoseconds(1)), last.min(end - Duration::nanoseconds(1)), MAX_OCCURRENCES);
        let keep = within.len().min((repeats - after) as usize);
        times.extend(within[within.len() - keep..].iter().map(|at| (*at, 1)));
        accounted = after + keep as u32;
    }
    // Repeats with no time the schedule gives (Run now, an event, a changed schedule) are put at the last one,
    // unless the run began before the week: then the rest are taken to be before it.
    let rest = repeats - accounted;
    if rest > 0 && (first >= start || run.trigger != AutomationTrigger::Scheduled) {
        times.push((last, rest));
    }
    times
}

/// The week starting on `first`, in `tz`, read from `duties` at `now`. A
/// first day outside the weeks that may be asked for is refused.
pub fn week(tz: Tz, first: NaiveDate, now: DateTime<Utc>, duties_in: &[DutyWeek<'_>], quiet_hours: BTreeMap<String, duties::QuietHours>) -> Result<Week> {
    let bounds = |(year, month, day): (i32, u32, u32)| NaiveDate::from_ymd_opt(year, month, day).expect("a fixed day");
    if first < bounds(FIRST_DAY) || first > bounds(LAST_DAY) {
        return Err(refused(format!("Weeks from {} to {} can be shown.", bounds(FIRST_DAY), bounds(LAST_DAY))));
    }
    let date = |offset: u64| first.checked_add_days(chrono::Days::new(offset)).ok_or_else(|| refused("That week cannot be shown."));
    let day_dates = (0..=7).map(date).collect::<Result<Vec<NaiveDate>>>()?;
    // Each day's first instant, and the next Monday's: the week is [starts[0], starts[7]).
    let starts: Vec<DateTime<Utc>> = day_dates.iter().map(|day| local_midnight(tz, *day)).collect();
    let (start, end) = (starts[0], starts[7]);
    let place = |at: DateTime<Utc>| -> Option<(u32, u32)> {
        if at < start || at >= end {
            return None;
        }
        let local = at.with_timezone(&tz);
        let day = (local.date_naive() - first).num_days();
        (0..7).contains(&day).then(|| (day as u32, local.hour() * 60 + local.minute()))
    };
    let days: Vec<String> = day_dates[..7].iter().map(|day| day.format("%Y-%m-%d").to_string()).collect();
    let (today, now_minute) = match place(now) {
        Some((day, minute)) => (Some(day), Some(minute)),
        None => (None, None),
    };

    let mut blocks = Vec::new();
    let mut often = vec![DayCount::default(); 7];
    let mut events = vec![DayCount::default(); 7];
    let mut often_duties = Vec::new();
    let mut event_duties = Vec::new();
    let mut next_today = Vec::new();
    let mut totals = Totals::default();
    let mut not_kept: Vec<Vec<NotKept>> = vec![Vec::new(); 7];
    let mut logs = Vec::new();
    let mut deleted = Vec::new();

    for entry in duties_in {
        let duty = entry.duty;
        let gone = entry.deleted_at.is_some();
        let on_events = wakes_on_events(duty);
        let (scheduled, capped) = if on_events { (Vec::new(), false) } else { occurrences(duty, start - Duration::nanoseconds(1), end - Duration::nanoseconds(1), MAX_OCCURRENCES) };
        let mut per_day = [0usize; 7];
        for at in &scheduled {
            if let Some((day, _)) = place(*at) {
                per_day[day as usize] += 1;
            }
        }
        let counted = !on_events && per_day.iter().any(|count| *count > OFTEN_PER_DAY);
        // A deleted duty's runs are counted where they ran, but it wakes on nothing and nothing of it is to come.
        if on_events && !gone {
            event_duties.push(duty.id.clone());
        } else if counted && !gone {
            often_duties.push(duty.id.clone());
            for (day, count) in per_day.iter().enumerate() {
                often[day].scheduled += *count as u32;
                often[day].capped |= capped;
            }
        }

        // How far back its log reaches: an unreadable one reaches nowhere. The days (or the part of today) before
        // that, up to now, are not kept.
        // A deleted duty's log is what is left of it: what it no longer reaches is not said again.
        let kept = if gone { None } else { kept_from(entry.runs) };
        let gap_until = if gone { None } else if entry.unreadable.is_some() { Some(end) } else { kept };
        if let Some(gap) = gap_until.map(|gap| gap.min(now)).filter(|gap| *gap > start) {
            totals.at_least = true;
            for day in 0..7usize {
                let (from, to) = (starts[day], starts[day + 1]);
                if from >= gap {
                    break;
                }
                if on_events {
                    events[day].not_kept += 1;
                } else if counted {
                    often[day].not_kept += 1;
                } else {
                    let until_minute = if gap < to { place(gap).map_or(24 * 60, |(_, minute)| minute) } else { 24 * 60 };
                    not_kept[day].push(NotKept { duty_id: duty.id.clone(), until_minute });
                }
            }
        }
        if !gone && (gap_until.is_some_and(|gap| gap > start) || capped) {
            logs.push(DutyLog {
                duty_id: duty.id.clone(),
                bot_id: entry.bot.id.clone(),
                kept_from: kept.map(|at| at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
                unreadable: entry.unreadable.map(capped_note),
                capped,
            });
        }

        let mut ran_at = BTreeSet::new();
        let mut drawn = false;
        for run in entry.runs {
            // A folded row's end is its last repeat's: only a row of one run has a length.
            let length = if run.repeat_count <= 1 { run_minutes(run, now) } else { None };
            let in_row = on_events || event_trigger(run.trigger) || counted;
            for (index, (at, count)) in times_of(duty, run, start, end).into_iter().enumerate() {
                ran_at.insert(at);
                let state = state_of(run);
                let block = |day: u32, minute: u32, at: DateTime<Utc>, minutes: Option<u32>, continued: bool| Block {
                    duty_id: duty.id.clone(),
                    bot_id: entry.bot.id.clone(),
                    day,
                    minute,
                    at: at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    state,
                    count: if continued { 1 } else { count },
                    minutes,
                    run_id: Some(run.run_id.clone()),
                    session_id: run.session_id.clone(),
                    note: matches!(state, BlockState::Failed | BlockState::Skipped | BlockState::Stopped).then(|| run.error.as_deref().map(capped_note)).flatten(),
                    deleted: gone,
                    continued,
                };
                // A run that goes on past midnight goes on, on each later day of this week it covers (PRO-499).
                if index == 0 && !in_row {
                    if let Some(minutes) = length {
                        let until = at + Duration::minutes(i64::from(minutes));
                        for (day, &begins) in starts[..7].iter().enumerate() {
                            if begins <= at || begins >= until {
                                continue;
                            }
                            let Some((_, minute)) = place(begins) else { continue };
                            let left = until.signed_duration_since(begins).num_minutes();
                            if left > 0 {
                                drawn = true;
                                blocks.push(block(day as u32, minute, begins, Some(left as u32), true));
                            }
                        }
                    }
                }
                let Some((day, minute)) = place(at) else { continue };
                drawn = true;
                if woke(run) {
                    totals.checks += count;
                    if state == BlockState::Quiet {
                        totals.nothing_new += count;
                    }
                    if state == BlockState::Reported {
                        totals.reports += count;
                    }
                }
                let row = if on_events || event_trigger(run.trigger) {
                    Some(&mut events)
                } else if counted {
                    Some(&mut often)
                } else {
                    None
                };
                match row {
                    Some(row) => {
                        let cell = &mut row[day as usize];
                        if woke(run) {
                            cell.ran += count;
                        }
                        if state == BlockState::Reported {
                            cell.reports += count;
                        }
                        if state == BlockState::Failed {
                            cell.failed += count;
                        }
                    }
                    None => blocks.push(block(day, minute, at, if index == 0 { length } else { None }, false)),
                }
            }
        }
        if let (Some(deleted_at), true) = (entry.deleted_at, drawn) {
            deleted.push(DeletedDuty { duty_id: duty.id.clone(), bot_id: entry.bot.id.clone(), name: duty.name.clone(), deleted_at: deleted_at.to_owned() });
        }

        // Still to come: only for a duty that is on, of a bot that is not paused, and never for a deleted one.
        if gone || on_events || !duty.enabled || entry.bot.paused.is_some() {
            continue;
        }
        let mut first_today = true;
        for at in scheduled.iter().filter(|at| **at > now && !ran_at.contains(*at)) {
            let Some((day, minute)) = place(*at) else { continue };
            if Some(day) == today && first_today {
                first_today = false;
                next_today.push(NextRun { duty_id: duty.id.clone(), bot_id: entry.bot.id.clone(), minute, at: at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true) });
            }
            if counted {
                often[day as usize].planned += 1;
            } else {
                blocks.push(Block {
                    duty_id: duty.id.clone(),
                    bot_id: entry.bot.id.clone(),
                    day,
                    minute,
                    at: at.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                    state: BlockState::Next,
                    count: 1,
                    minutes: None,
                    run_id: None,
                    session_id: None,
                    note: None,
                    deleted: false,
                    continued: false,
                });
            }
        }
    }
    blocks.sort_by(|a, b| (a.day, a.minute, &a.duty_id).cmp(&(b.day, b.minute, &b.duty_id)));
    deleted.sort_by(|a, b| a.duty_id.cmp(&b.duty_id));
    next_today.sort_by(|a, b| (a.minute, &a.duty_id).cmp(&(b.minute, &b.duty_id)));
    next_today.truncate(NEXT_TODAY);
    Ok(Week { timezone: tz.name().to_owned(), days, today, now_minute, blocks, often, often_duties, events, event_duties, next_today, totals, quiet_hours, not_kept, logs, deleted })
}

/// The first day, a `first` weekday, of the week holding `date`.
fn start_of(date: NaiveDate, first: Weekday) -> Option<NaiveDate> {
    let back = (date.weekday().num_days_from_monday() + 7 - first.num_days_from_monday()) % 7;
    date.checked_sub_days(chrono::Days::new(u64::from(back)))
}

/// The weekday a week starts on, as the window says it (`firstDay`: 0 for Monday … 6 for Sunday); Monday when it
/// does not say, as an older window does not.
fn first_weekday(value: &Value) -> Result<Weekday> {
    const DAYS: [Weekday; 7] = [Weekday::Mon, Weekday::Tue, Weekday::Wed, Weekday::Thu, Weekday::Fri, Weekday::Sat, Weekday::Sun];
    if value.is_null() {
        return Ok(Weekday::Mon);
    }
    value.as_u64().and_then(|day| DAYS.get(day as usize).copied()).ok_or_else(|| refused("firstDay is a day of the week, 0 for Monday to 6 for Sunday."))
}

/// The `dutyWeek` operation of the runtime's `bots` call: a read, of one bot
/// (`id`) or of every bot. `week` is any day of the week (`YYYY-MM-DD`, this
/// week when absent); `timezone` an IANA name, the owner's when absent;
/// `firstDay` the weekday it starts on (0 for Monday … 6 for Sunday).
///
/// `dutyKeptLog` (PRO-499) reads what is kept of bot `id`'s deleted duty
/// `dutyId`: its name, when it was deleted, and its run log.
pub fn call(operation: &str, params: &Value) -> Option<Result<Value>> {
    match operation {
        "dutyWeek" => Some(answer(params)),
        "dutyKeptLog" => Some(kept_log(params)),
        _ => None,
    }
}

fn kept_log(params: &Value) -> Result<Value> {
    super::require_enabled()?;
    let string = |key: &str| params[key].as_str().ok_or_else(|| refused(format!("{key} must be a string")));
    let bot = super::get(string("id")?)?;
    let duty_id = string("dutyId")?;
    let kept = automation_store::get_deleted(duty_id)?
        .filter(|kept| duties::owner(&kept.automation).is_some_and(|owner| owner.id == bot.id))
        .ok_or_else(|| refused(format!("{} has no deleted duty {duty_id} whose runs are kept.", bot.name)))?;
    let runs = automation_store::list_runs(duty_id)?;
    Ok(serde_json::json!({"dutyId": duty_id, "botId": bot.id, "name": kept.automation.name, "deletedAt": kept.deleted_at, "runs": runs}))
}

fn answer(params: &Value) -> Result<Value> {
    super::require_enabled()?;
    let tz: Tz = match params["timezone"].as_str() {
        Some(name) => name.parse().map_err(|_| refused(format!("{name} is not a time zone this app knows.")))?,
        None => duties::local_timezone().parse().unwrap_or(Tz::UTC),
    };
    let now = Utc::now();
    let day = match params["week"].as_str() {
        Some(text) => NaiveDate::parse_from_str(text, "%Y-%m-%d").map_err(|_| refused("week is a day, YYYY-MM-DD."))?,
        None => now.with_timezone(&tz).date_naive(),
    };
    let bots: Vec<Bot> = match params["id"].as_str() {
        Some(id) => vec![super::get(id)?],
        None if params["id"].is_null() => bot_store::list()?,
        None => return Err(refused("id must be a string")),
    };
    let automations = automation_store::list()?;
    let first = start_of(day, first_weekday(&params["firstDay"])?).ok_or_else(|| refused("That week cannot be shown."))?;
    // A deleted duty's log is read for a week that may hold its runs: one deleted before the week (and the
    // longest a run is drawn for) ran nothing in it.
    let since = first.checked_sub_days(chrono::Days::new(8)).map(|day| local_midnight(tz, day));
    let deleted: Vec<automation_store::Deleted> = automation_store::list_deleted()
        .unwrap_or_default()
        .into_iter()
        .filter(|kept| parse(Some(&kept.deleted_at)).is_none_or(|at| since.is_none_or(|since| at >= since)))
        .collect();
    let mut read = Vec::new();
    for bot in &bots {
        let live = automations.iter().filter(|duty| duties::owner(duty).is_some_and(|owner| owner.id == bot.id)).map(|duty| (duty, None));
        let gone = deleted.iter().filter(|kept| duties::owner(&kept.automation).is_some_and(|owner| owner.id == bot.id)).map(|kept| (&kept.automation, Some(kept.deleted_at.as_str())));
        for (duty, deleted_at) in live.chain(gone) {
            // A log that cannot be read is said on the duty's row, never shown as a week in which nothing ran.
            let (runs, unreadable) = match automation_store::list_runs(&duty.id) {
                Ok(runs) => (runs, None),
                Err(error) => (Vec::new(), Some(format!("{error:#}"))),
            };
            read.push((duty, bot, runs, unreadable, deleted_at));
        }
    }
    let inputs: Vec<DutyWeek<'_>> = read.iter().map(|(duty, bot, runs, unreadable, deleted_at)| DutyWeek { duty, bot, runs, unreadable: unreadable.as_deref(), deleted_at: *deleted_at }).collect();
    let quiet = bots.iter().filter_map(|bot| duties::settings(&bot.id).quiet_hours.map(|quiet| (bot.id.clone(), quiet))).collect();
    Ok(serde_json::to_value(week(tz, first, now, &inputs, quiet)?)?)
}

#[cfg(test)]
#[path = "calendar_tests.rs"]
mod tests;
