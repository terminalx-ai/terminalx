//! Saved prompts and the times at which they should become ordinary sessions.

use std::collections::BTreeMap;
use std::path::Path;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{anyhow, bail, Context, Result};
use chrono::{
    DateTime, Datelike, Days, LocalResult, NaiveDate, NaiveTime, TimeZone, Timelike, Utc, Weekday,
};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::store::{automations as automation_store, index};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScheduleKind {
    Preset,
    Cron,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SchedulePreset {
    Hourly,
    Daily,
    Weekdays,
    Weekly,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationSchedule {
    pub kind: ScheduleKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<SchedulePreset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hour: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub minute: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub weekdays: Vec<String>,
    pub timezone: String,
    pub dtstart: String,
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutomationWorkspace {
    NewWorktree,
    Session,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationPrecheck {
    pub command: String,
    pub timeout_seconds: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub project_path: String,
    pub harness: String,
    #[serde(default)]
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    pub mode: String,
    pub prompt: String,
    pub workspace: AutomationWorkspace,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default)]
    pub reuse_session: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    pub schedule: AutomationSchedule,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precheck: Option<AutomationPrecheck>,
    #[serde(default = "default_grace")]
    pub missed_run_grace_minutes: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_timeout_minutes: Option<u32>,
    pub next_run_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_outcome: Option<AutomationRunStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issue_trigger: Option<serde_json::Value>,
    pub created: String,
    pub modified: String,
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationInput {
    pub name: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    pub project_path: String,
    pub harness: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default = "default_mode")]
    pub mode: String,
    pub prompt: String,
    pub workspace: AutomationWorkspace,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub reuse_session: bool,
    #[serde(default)]
    pub base_ref: Option<String>,
    pub schedule: AutomationSchedule,
    #[serde(default)]
    pub precheck: Option<AutomationPrecheck>,
    #[serde(default = "default_grace")]
    pub missed_run_grace_minutes: u32,
    #[serde(default)]
    pub run_timeout_minutes: Option<u32>,
}

fn yes() -> bool {
    true
}

fn default_mode() -> String {
    "auto".into()
}

fn default_grace() -> u32 {
    60
}

pub fn definition_from_input(
    input: AutomationInput,
    existing: Option<&Automation>,
    now: DateTime<Utc>,
) -> Result<Automation> {
    let name = input.name.trim();
    let prompt = input.prompt.trim();
    if name.is_empty() {
        bail!("Automation name is required.");
    }
    if prompt.is_empty() {
        bail!("Prompt is required.");
    }
    if !matches!(input.harness.as_str(), "claude" | "codex") {
        bail!("Choose an offered agent.");
    }
    if input.mode.trim().is_empty() {
        bail!("Permission mode is required.");
    }
    match input.workspace {
        AutomationWorkspace::NewWorktree if input.reuse_session => {
            bail!("Session reuse needs an existing session.")
        }
        AutomationWorkspace::Session if input.session_id.as_deref().is_none_or(str::is_empty) => {
            bail!("Choose a session for this automation.")
        }
        _ => {}
    }
    let next = next_run_after(&input.schedule, now)?;
    let stamp = now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    Ok(Automation {
        id: existing
            .map(|value| value.id.clone())
            .unwrap_or_else(|| uuid::Uuid::now_v7().to_string()),
        name: name.to_string(),
        enabled: input.enabled,
        project_path: input.project_path,
        harness: input.harness,
        model: input.model,
        effort: input.effort,
        mode: input.mode,
        prompt: prompt.to_string(),
        workspace: input.workspace,
        session_id: input.session_id,
        reuse_session: input.reuse_session,
        base_ref: input.base_ref,
        schedule: input.schedule,
        precheck: input.precheck,
        missed_run_grace_minutes: input.missed_run_grace_minutes,
        run_timeout_minutes: input.run_timeout_minutes,
        next_run_at: next.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        last_run_at: existing.and_then(|value| value.last_run_at.clone()),
        last_outcome: existing.and_then(|value| value.last_outcome),
        issue_trigger: existing.and_then(|value| value.issue_trigger.clone()),
        created: existing
            .map(|value| value.created.clone())
            .unwrap_or_else(|| stamp.clone()),
        modified: stamp,
        unknown: existing
            .map(|value| value.unknown.clone())
            .unwrap_or_default(),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutomationTrigger {
    Scheduled,
    Manual,
    Issue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutomationRunStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
    SkippedPrecheck,
    SkippedMissed,
    SkippedUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DueAction {
    Dispatch { scheduled_for: DateTime<Utc> },
    SkipMissed { scheduled_for: DateTime<Utc> },
}

pub fn due_action(automation: &Automation, now: DateTime<Utc>) -> Result<Option<DueAction>> {
    if !automation.enabled {
        return Ok(None);
    }
    let scheduled_for = DateTime::parse_from_rfc3339(&automation.next_run_at)
        .context("nextRunAt must be RFC3339")?
        .with_timezone(&Utc);
    if scheduled_for > now {
        return Ok(None);
    }
    let grace = chrono::TimeDelta::minutes(i64::from(automation.missed_run_grace_minutes));
    if now - scheduled_for > grace {
        Ok(Some(DueAction::SkipMissed { scheduled_for }))
    } else {
        Ok(Some(DueAction::Dispatch { scheduled_for }))
    }
}

impl AutomationRunStatus {
    pub fn is_terminal(self) -> bool {
        !matches!(self, Self::Pending | Self::Running)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationUsage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache_tokens: Option<u64>,
    #[serde(default)]
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationPrecheckResult {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub truncated: bool,
    pub timed_out: bool,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub run_id: String,
    pub run_number: u64,
    pub automation_id: String,
    pub trigger: AutomationTrigger,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_for: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    pub status: AutomationRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changed_files: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<AutomationUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precheck: Option<AutomationPrecheckResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default = "one")]
    pub repeat_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_repeat_at: Option<String>,
    #[serde(flatten, default)]
    pub unknown: BTreeMap<String, serde_json::Value>,
}

fn one() -> u32 {
    1
}

/// The first occurrence strictly after `after`, observed in the stored IANA
/// timezone and never before the schedule's own start.
pub fn next_run_after(
    schedule: &AutomationSchedule,
    after: DateTime<Utc>,
) -> Result<DateTime<Utc>> {
    let timezone: Tz = schedule
        .timezone
        .parse()
        .with_context(|| format!("unknown timezone {}", schedule.timezone))?;
    let dtstart = DateTime::parse_from_rfc3339(&schedule.dtstart)
        .context("dtstart must be RFC3339")?
        .with_timezone(&Utc);
    let after = after.max(dtstart - chrono::TimeDelta::nanoseconds(1));
    match (schedule.kind, schedule.preset) {
        (ScheduleKind::Preset, Some(preset)) => {
            next_preset(schedule, preset, timezone, dtstart, after)
        }
        (ScheduleKind::Preset, None) => bail!("schedule preset is required"),
        (ScheduleKind::Cron, _) => next_cron(schedule, timezone, after),
    }
}

fn next_cron(
    schedule: &AutomationSchedule,
    timezone: Tz,
    after: DateTime<Utc>,
) -> Result<DateTime<Utc>> {
    let expression = schedule
        .cron
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .context("cron expression is required")?;
    if expression.split_whitespace().count() != 5 {
        bail!("cron must have five fields");
    }
    // `cron` includes seconds; the product contract deliberately does not.
    let parsed =
        cron::Schedule::from_str(&format!("0 {expression}")).context("invalid cron expression")?;
    parsed
        .after(&after.with_timezone(&timezone))
        .next()
        .map(|value| value.with_timezone(&Utc))
        .context("cron expression has no future occurrence")
}

fn next_preset(
    schedule: &AutomationSchedule,
    preset: SchedulePreset,
    timezone: Tz,
    dtstart: DateTime<Utc>,
    after: DateTime<Utc>,
) -> Result<DateTime<Utc>> {
    if preset == SchedulePreset::Hourly {
        let minute = schedule.minute.unwrap_or(0);
        if minute > 59 {
            bail!("minute must be between 0 and 59");
        }
        let mut candidate = (after + chrono::TimeDelta::minutes(1))
            .with_second(0)
            .and_then(|value| value.with_nanosecond(0))
            .context("schedule time overflow")?;
        for _ in 0..=120 {
            if candidate.with_timezone(&timezone).minute() == minute {
                return Ok(candidate);
            }
            candidate += chrono::TimeDelta::minutes(1);
        }
        bail!("no hourly occurrence found")
    }

    let hour = schedule.hour.unwrap_or(9);
    let minute = schedule.minute.unwrap_or(0);
    let time = NaiveTime::from_hms_opt(hour, minute, 0)
        .ok_or_else(|| anyhow!("time must be between 00:00 and 23:59"))?;
    let weekdays = match preset {
        SchedulePreset::Daily => Vec::new(),
        SchedulePreset::Weekdays => vec![
            Weekday::Mon,
            Weekday::Tue,
            Weekday::Wed,
            Weekday::Thu,
            Weekday::Fri,
        ],
        SchedulePreset::Weekly => {
            let configured = parse_weekdays(&schedule.weekdays)?;
            if configured.is_empty() {
                vec![dtstart.with_timezone(&timezone).weekday()]
            } else {
                configured
            }
        }
        SchedulePreset::Hourly => unreachable!(),
    };
    let mut date = after.with_timezone(&timezone).date_naive();
    for _ in 0..=3660 {
        if weekdays.is_empty() || weekdays.contains(&date.weekday()) {
            if let Some(candidate) = local_after(timezone, date, time, after) {
                return Ok(candidate);
            }
        }
        date = date
            .checked_add_days(Days::new(1))
            .context("schedule date overflow")?;
    }
    bail!("no schedule occurrence in the next ten years")
}

fn parse_weekdays(values: &[String]) -> Result<Vec<Weekday>> {
    values
        .iter()
        .map(|value| match value.to_ascii_uppercase().as_str() {
            "MO" | "MON" => Ok(Weekday::Mon),
            "TU" | "TUE" => Ok(Weekday::Tue),
            "WE" | "WED" => Ok(Weekday::Wed),
            "TH" | "THU" => Ok(Weekday::Thu),
            "FR" | "FRI" => Ok(Weekday::Fri),
            "SA" | "SAT" => Ok(Weekday::Sat),
            "SU" | "SUN" => Ok(Weekday::Sun),
            other => bail!("unknown weekday {other}"),
        })
        .collect()
}

fn local_after(
    timezone: Tz,
    date: NaiveDate,
    time: NaiveTime,
    after: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let local = date.and_time(time);
    let candidates = match timezone.from_local_datetime(&local) {
        LocalResult::Single(value) => vec![value.with_timezone(&Utc)],
        LocalResult::Ambiguous(first, second) => {
            vec![first.with_timezone(&Utc), second.with_timezone(&Utc)]
        }
        LocalResult::None => Vec::new(),
    };
    candidates
        .into_iter()
        .filter(|candidate| *candidate > after)
        .min()
}

fn new_run(
    automation_id: &str,
    trigger: AutomationTrigger,
    scheduled_for: Option<DateTime<Utc>>,
    status: AutomationRunStatus,
) -> AutomationRun {
    let now = index::now();
    AutomationRun {
        run_id: uuid::Uuid::now_v7().to_string(),
        run_number: 0,
        automation_id: automation_id.to_string(),
        trigger,
        scheduled_for: scheduled_for
            .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        started_at: (!status.is_terminal()).then(|| now.clone()),
        ended_at: status.is_terminal().then(|| now.clone()),
        status,
        session_id: None,
        tab_id: None,
        worktree_name: None,
        final_message: None,
        changed_files: None,
        usage: None,
        precheck: None,
        error: None,
        repeat_count: 1,
        last_repeat_at: None,
        unknown: BTreeMap::new(),
    }
}

fn emit_run(app: &AppHandle, run: &AutomationRun) {
    let _ = app.emit("automation_run", run);
}

pub fn emit_definitions(app: &AppHandle) {
    if let Ok(values) = automation_store::list() {
        let _ = app.emit("automations_changed", values);
    }
}

fn update_summary(app: &AppHandle, automation_id: &str, status: AutomationRunStatus, at: &str) {
    let at = at.to_string();
    if automation_store::update(automation_id, |automation| {
        automation.last_run_at = Some(at);
        automation.last_outcome = Some(status);
        automation.modified = index::now();
        Ok(())
    })
    .is_ok()
    {
        emit_definitions(app);
    }
}

fn automation_worktree_name(automation: &Automation, at: DateTime<Utc>) -> String {
    let slug: String = automation
        .name
        .to_ascii_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .take(20)
        .collect();
    format!(
        "auto-{}-{}",
        if slug.is_empty() { "run" } else { &slug },
        at.format("%Y%m%dT%H")
    )
}

/// Turn a saved prompt into an ordinary session. The active frontend session
/// is never selected here; the emitted session simply joins the sidebar.
pub fn dispatch(
    app: &AppHandle,
    automation_id: &str,
    trigger: AutomationTrigger,
    scheduled_for: Option<DateTime<Utc>>,
) -> Result<AutomationRun> {
    let automation = automation_store::get(automation_id)?;
    let mut run = automation_store::insert_run(new_run(
        automation_id,
        trigger,
        scheduled_for,
        AutomationRunStatus::Pending,
    ))?;
    emit_run(app, &run);
    let started_at = run.started_at.clone().unwrap_or_else(index::now);
    update_summary(app, automation_id, run.status, &started_at);

    let result = (|| -> Result<()> {
        let available = crate::harness::offered()
            .into_iter()
            .any(|value| value.id == automation.harness && value.available);
        if !available {
            bail!("The selected agent is not available.");
        }
        let cwd = match automation.workspace {
            AutomationWorkspace::NewWorktree => None,
            AutomationWorkspace::Session => {
                let target = index::get(
                    automation
                        .session_id
                        .as_deref()
                        .context("automation has no target session")?,
                )?;
                Some(target.cwd)
            }
        };
        let title = format!("{} · Run {}", automation.name, run.run_number);
        let worktree_name = (automation.workspace == AutomationWorkspace::NewWorktree)
            .then(|| automation_worktree_name(&automation, scheduled_for.unwrap_or_else(Utc::now)));
        let entry = crate::commands::create_session_blocking(
            app,
            crate::commands::NewSession {
                project_path: automation.project_path.clone(),
                title: Some(title),
                use_worktree: automation.workspace == AutomationWorkspace::NewWorktree,
                base_ref: automation.base_ref.clone(),
                worktree_name,
                issue: None,
                automation: Some(index::AutomationRef {
                    id: automation.id.clone(),
                    name: automation.name.clone(),
                    run_id: run.run_id.clone(),
                    run_number: run.run_number,
                }),
                cwd,
                tab: crate::commands::NewTab {
                    harness: automation.harness.clone(),
                    model: automation.model.clone(),
                    effort: automation.effort.clone(),
                    permission_mode: Some(automation.mode.clone()),
                },
            },
        )
        .map_err(anyhow::Error::msg)?;
        let tab = entry
            .tabs
            .first()
            .context("automation session has no tab")?;
        run = automation_store::replace_run(&automation.id, &run.run_id, |value| {
            value.session_id = Some(entry.id.clone());
            value.tab_id = Some(tab.id.clone());
            value.worktree_name = entry.worktree_name.clone();
            Ok(())
        })?;
        emit_run(app, &run);
        let manager = app
            .state::<crate::AppState>()
            .manager()
            .context("session manager is not ready")?;
        manager.send(&entry.id, &tab.id, automation.prompt.clone(), Vec::new())?;
        Ok(())
    })();

    if let Err(error) = result {
        let message = format!("{error:#}");
        run = automation_store::replace_run(&automation.id, &run.run_id, |value| {
            value.status = if message.contains("not available") {
                AutomationRunStatus::SkippedUnavailable
            } else {
                AutomationRunStatus::Failed
            };
            value.ended_at = Some(index::now());
            value.error = Some(message);
            Ok(())
        })?;
        emit_run(app, &run);
        let ended_at = run.ended_at.clone().unwrap_or_else(index::now);
        update_summary(app, &automation.id, run.status, &ended_at);
    }
    Ok(run)
}

fn session_automation(
    session_id: &str,
    tab_id: &str,
) -> Option<(index::SessionEntry, index::AutomationRef)> {
    let entry = index::get(session_id).ok()?;
    if entry.tabs.first().map(|tab| tab.id.as_str()) != Some(tab_id) {
        return None;
    }
    Some((entry.clone(), entry.automation?))
}

pub fn mark_running_from_hook(app: &AppHandle, session_id: &str, tab_id: &str) {
    let Some((_, stamp)) = session_automation(session_id, tab_id) else {
        return;
    };
    let Ok(run) = automation_store::replace_run(&stamp.id, &stamp.run_id, |run| {
        if run.status == AutomationRunStatus::Pending {
            run.status = AutomationRunStatus::Running;
            run.started_at = Some(index::now());
        }
        Ok(())
    }) else {
        return;
    };
    emit_run(app, &run);
    if run.status == AutomationRunStatus::Running {
        let started_at = run.started_at.clone().unwrap_or_else(index::now);
        update_summary(app, &stamp.id, run.status, &started_at);
    }
}

fn changed_file_count(entry: &index::SessionEntry) -> Option<u32> {
    let cwd = Path::new(&entry.cwd);
    if let Some(base) = entry.base_ref.as_deref() {
        let head = crate::git::snapshot_tree(cwd).ok()?;
        return crate::git::changes_between(cwd, base, Some(&head))
            .ok()
            .map(|files| files.len() as u32);
    }
    crate::git::run(
        cwd,
        &["status", "--porcelain", "--untracked-files=normal", "--"],
    )
    .ok()
    .map(|output| output.lines().count() as u32)
}

pub fn complete_from_hook(
    app: &AppHandle,
    session_id: &str,
    tab_id: &str,
    final_message: Option<String>,
) {
    let Some((entry, stamp)) = session_automation(session_id, tab_id) else {
        return;
    };
    let changed_files = changed_file_count(&entry);
    let Ok(run) = automation_store::replace_run(&stamp.id, &stamp.run_id, |run| {
        if matches!(
            run.status,
            AutomationRunStatus::Pending | AutomationRunStatus::Running
        ) {
            run.status = AutomationRunStatus::Completed;
            run.ended_at = Some(index::now());
            run.final_message = final_message;
            run.changed_files = changed_files;
        }
        Ok(())
    }) else {
        return;
    };
    emit_run(app, &run);
    if run.status == AutomationRunStatus::Completed {
        let ended_at = run.ended_at.clone().unwrap_or_else(index::now);
        update_summary(app, &stamp.id, run.status, &ended_at);
    }
}

pub fn fail_from_hook(app: &AppHandle, session_id: &str, tab_id: &str, message: &str) {
    let Some((_, stamp)) = session_automation(session_id, tab_id) else {
        return;
    };
    let message = message.to_string();
    let Ok(run) = automation_store::replace_run(&stamp.id, &stamp.run_id, |run| {
        if matches!(
            run.status,
            AutomationRunStatus::Pending | AutomationRunStatus::Running
        ) {
            run.status = AutomationRunStatus::Failed;
            run.ended_at = Some(index::now());
            run.error = Some(message);
        }
        Ok(())
    }) else {
        return;
    };
    emit_run(app, &run);
    if run.status == AutomationRunStatus::Failed {
        let ended_at = run.ended_at.clone().unwrap_or_else(index::now);
        update_summary(app, &stamp.id, run.status, &ended_at);
    }
}

fn record_missed(
    app: &AppHandle,
    automation: &Automation,
    scheduled_for: DateTime<Utc>,
) -> Result<()> {
    const MESSAGE: &str =
        "The scheduled time was outside this automation's missed-run grace period.";
    if let Some(previous) = automation_store::list_runs(&automation.id)?
        .into_iter()
        .next()
    {
        if previous.status == AutomationRunStatus::SkippedMissed
            && previous.error.as_deref() == Some(MESSAGE)
        {
            let run = automation_store::replace_run(&automation.id, &previous.run_id, |run| {
                run.repeat_count += 1;
                run.last_repeat_at = Some(index::now());
                Ok(())
            })?;
            emit_run(app, &run);
            return Ok(());
        }
    }
    let mut run = new_run(
        &automation.id,
        AutomationTrigger::Scheduled,
        Some(scheduled_for),
        AutomationRunStatus::SkippedMissed,
    );
    run.error = Some(MESSAGE.into());
    let run = automation_store::insert_run(run)?;
    emit_run(app, &run);
    let ended_at = run.ended_at.clone().unwrap_or_else(index::now);
    update_summary(app, &automation.id, run.status, &ended_at);
    Ok(())
}

static EVALUATING: AtomicBool = AtomicBool::new(false);

struct EvaluationGuard;

impl Drop for EvaluationGuard {
    fn drop(&mut self) {
        EVALUATING.store(false, Ordering::Release);
    }
}

fn evaluate(app: &AppHandle) -> Result<()> {
    if EVALUATING.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let _guard = EvaluationGuard;
    let now = Utc::now();
    for automation in automation_store::list()? {
        let Some(action) = due_action(&automation, now)? else {
            continue;
        };
        let next = next_run_after(&automation.schedule, now)?
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        automation_store::update(&automation.id, |value| {
            value.next_run_at = next;
            value.modified = index::now();
            Ok(())
        })?;
        emit_definitions(app);
        match action {
            DueAction::Dispatch { scheduled_for } => {
                dispatch(
                    app,
                    &automation.id,
                    AutomationTrigger::Scheduled,
                    Some(scheduled_for),
                )?;
            }
            DueAction::SkipMissed { scheduled_for } => {
                record_missed(app, &automation, scheduled_for)?
            }
        }
    }
    Ok(())
}

fn recover_open_runs(app: &AppHandle) {
    let Ok(automations) = automation_store::list() else {
        return;
    };
    for automation in automations {
        let Ok(runs) = automation_store::list_runs(&automation.id) else {
            continue;
        };
        for open in runs.into_iter().filter(|run| !run.status.is_terminal()) {
            let Ok(run) = automation_store::replace_run(&automation.id, &open.run_id, |run| {
                run.status = AutomationRunStatus::Failed;
                run.ended_at = Some(index::now());
                run.error = Some("The app closed before this automation run finished.".into());
                Ok(())
            }) else {
                continue;
            };
            emit_run(app, &run);
            let ended_at = run.ended_at.clone().unwrap_or_else(index::now);
            update_summary(app, &automation.id, run.status, &ended_at);
        }
    }
}

pub fn start_scheduler(app: AppHandle) {
    std::thread::Builder::new()
        .name("automation-scheduler".into())
        .spawn(move || {
            recover_open_runs(&app);
            loop {
                if let Err(error) = evaluate(&app) {
                    log::warn!("automation scheduler: {error:#}");
                }
                std::thread::sleep(std::time::Duration::from_secs(30));
            }
        })
        .expect("start automation scheduler");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(value: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(value)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn automation() -> Automation {
        Automation {
            id: "auto-1".into(),
            name: "Review".into(),
            enabled: true,
            project_path: "/project".into(),
            harness: "codex".into(),
            model: String::new(),
            effort: None,
            mode: "auto".into(),
            prompt: "Review changes.".into(),
            workspace: AutomationWorkspace::NewWorktree,
            session_id: None,
            reuse_session: false,
            base_ref: None,
            schedule: AutomationSchedule {
                kind: ScheduleKind::Preset,
                preset: Some(SchedulePreset::Daily),
                cron: None,
                hour: Some(9),
                minute: Some(0),
                weekdays: Vec::new(),
                timezone: "UTC".into(),
                dtstart: "2026-09-01T09:00:00Z".into(),
                unknown: BTreeMap::new(),
            },
            precheck: None,
            missed_run_grace_minutes: 60,
            run_timeout_minutes: None,
            next_run_at: "2026-09-03T09:00:00Z".into(),
            last_run_at: None,
            last_outcome: None,
            issue_trigger: None,
            created: "2026-09-01T00:00:00Z".into(),
            modified: "2026-09-01T00:00:00Z".into(),
            unknown: BTreeMap::new(),
        }
    }

    #[test]
    fn daily_schedule_keeps_its_wall_time_across_dst() {
        let schedule = AutomationSchedule {
            kind: ScheduleKind::Preset,
            preset: Some(SchedulePreset::Daily),
            cron: None,
            hour: Some(9),
            minute: Some(0),
            weekdays: Vec::new(),
            timezone: "America/New_York".into(),
            dtstart: "2026-03-01T09:00:00-05:00".into(),
            unknown: BTreeMap::new(),
        };

        assert_eq!(
            next_run_after(&schedule, at("2026-03-07T15:00:00Z")).unwrap(),
            at("2026-03-08T13:00:00Z")
        );
    }

    #[test]
    fn five_field_cron_finds_the_next_five_minute_boundary() {
        let schedule = AutomationSchedule {
            kind: ScheduleKind::Cron,
            preset: None,
            cron: Some("*/5 * * * *".into()),
            hour: None,
            minute: None,
            weekdays: Vec::new(),
            timezone: "Asia/Dubai".into(),
            dtstart: "2026-09-01T00:00:00+04:00".into(),
            unknown: BTreeMap::new(),
        };

        assert_eq!(
            next_run_after(&schedule, at("2026-09-02T11:42:01Z")).unwrap(),
            at("2026-09-02T11:45:00Z")
        );
    }

    #[test]
    fn weekday_preset_skips_the_weekend() {
        let schedule = AutomationSchedule {
            kind: ScheduleKind::Preset,
            preset: Some(SchedulePreset::Weekdays),
            cron: None,
            hour: Some(9),
            minute: Some(0),
            weekdays: Vec::new(),
            timezone: "UTC".into(),
            dtstart: "2026-09-01T09:00:00Z".into(),
            unknown: BTreeMap::new(),
        };

        assert_eq!(
            next_run_after(&schedule, at("2026-09-04T10:00:00Z")).unwrap(),
            at("2026-09-07T09:00:00Z")
        );
    }

    #[test]
    fn due_schedule_runs_once_inside_grace_and_skips_once_outside_it() {
        let mut value = automation();
        value.next_run_at = "2026-09-02T10:00:00Z".into();
        value.missed_run_grace_minutes = 60;

        assert_eq!(
            due_action(&value, at("2026-09-02T10:45:00Z")).unwrap(),
            Some(DueAction::Dispatch {
                scheduled_for: at("2026-09-02T10:00:00Z")
            })
        );
        assert_eq!(
            due_action(&value, at("2026-09-02T11:01:00Z")).unwrap(),
            Some(DueAction::SkipMissed {
                scheduled_for: at("2026-09-02T10:00:00Z")
            })
        );
        value.enabled = false;
        assert_eq!(
            due_action(&value, at("2026-09-02T10:45:00Z")).unwrap(),
            None
        );
    }
}
