//! Atomic automation definitions and append-only run histories.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::automations::{Automation, AutomationRun, AutomationRunStatus};

/// How many finished runs each automation's log keeps; older ones are dropped.
pub const RUN_RETENTION: usize = 100;
/// Hysteresis threshold before compacting `runs.jsonl` back down to
/// [`RUN_RETENTION`] terminal runs, avoiding a full rewrite+fsync on every run (P-63).
pub const RUN_COMPACT_THRESHOLD: usize = RUN_RETENTION * 2;
static RUN_WRITE_LOCK: Mutex<()> = Mutex::new(());
static DEFINITION_WRITE_LOCK: Mutex<()> = Mutex::new(());
static SEEN_WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeenIssue {
    pub last_updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeenState {
    #[serde(default)]
    pub initialized: bool,
    #[serde(default)]
    pub issues: BTreeMap<String, SeenIssue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_polled_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_poll_error: Option<String>,
    /// When its runs started over the last day, for its runs a day (PRO-490 review).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub started: Vec<String>,
    /// Until when it holds what it found, its runs a day met.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held_until: Option<String>,
}

pub fn list() -> Result<Vec<Automation>> {
    Ok(super::read_json::<AutomationFile>(&definitions_path()?)?
        .unwrap_or_default()
        .automations)
}

#[cfg(test)]
pub fn save(automations: &[Automation]) -> Result<()> {
    let _guard = DEFINITION_WRITE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    save_unlocked(automations)
}

fn save_unlocked(automations: &[Automation]) -> Result<()> {
    super::write_json(
        &definitions_path()?,
        &AutomationFile {
            automations: automations.to_vec(),
        },
    )
}

pub fn get(id: &str) -> Result<Automation> {
    list()?
        .into_iter()
        .find(|value| value.id == id)
        .ok_or_else(|| anyhow::anyhow!("automation {id} not found"))
}

pub fn insert(automation: Automation) -> Result<Automation> {
    let out = automation.clone();
    update_definitions(|values| {
        values.push(automation);
        Ok(())
    })?;
    Ok(out)
}

pub fn replace(automation: Automation) -> Result<Automation> {
    let out = automation.clone();
    update_definitions(|values| {
        let value = values
            .iter_mut()
            .find(|value| value.id == automation.id)
            .ok_or_else(|| anyhow::anyhow!("automation {} not found", automation.id))?;
        *value = automation;
        Ok(())
    })?;
    Ok(out)
}

pub fn update(id: &str, change: impl FnOnce(&mut Automation) -> Result<()>) -> Result<Automation> {
    let mut out = None;
    update_definitions(|values| {
        let value = values
            .iter_mut()
            .find(|value| value.id == id)
            .ok_or_else(|| anyhow::anyhow!("automation {id} not found"))?;
        change(value)?;
        out = Some(value.clone());
        Ok(())
    })?;
    out.ok_or_else(|| anyhow::anyhow!("automation {id} not found"))
}

pub fn remove(id: &str) -> Result<()> {
    update_definitions(|values| {
        let before = values.len();
        values.retain(|value| value.id != id);
        if values.len() == before {
            anyhow::bail!("automation {id} not found");
        }
        Ok(())
    })?;
    let dir = super::root()?.join("automations").join(id);
    if dir.is_dir() {
        std::fs::remove_dir_all(dir)?;
    }
    Ok(())
}

/// What a deleted automation leaves beside its kept run log (PRO-499).
const DELETED_FILE: &str = "deleted.json";
/// A run log's file in an automation's folder.
const RUNS_FILE: &str = "runs.jsonl";
/// What a run still open when its duty was deleted says: nothing closes it after (PRO-499 review).
pub const DELETED_MID_RUN: &str = "Its duty was deleted before this run finished.";

/// `runs` of an automation deleted at `deleted_at`, with any still open read
/// as stopped then: a kept log is never left with a run going on (one a
/// scheduler tick wrote just after the delete too).
pub fn closed_at_deletion(mut runs: Vec<AutomationRun>, deleted_at: &str) -> Vec<AutomationRun> {
    for run in runs.iter_mut().filter(|run| !run.status.is_terminal()) {
        close_at_deletion(run, deleted_at);
    }
    runs
}

fn close_at_deletion(run: &mut AutomationRun, deleted_at: &str) {
    run.status = AutomationRunStatus::Cancelled;
    run.deferred_completion = None;
    // Never ended before it began: one written after the delete ends when it began.
    let at = |text: &str| chrono::DateTime::parse_from_rfc3339(text).ok();
    let began = run.started_at.clone().or_else(|| run.scheduled_for.clone());
    run.ended_at = Some(match began {
        Some(began) if at(&began).zip(at(deleted_at)).is_some_and(|(began, deleted)| began > deleted) => began,
        _ => deleted_at.to_owned(),
    });
    run.error.get_or_insert_with(|| DELETED_MID_RUN.to_owned());
}

/// A deleted automation whose run log is kept: its definition as it was, and
/// when it went. Nothing schedules or runs it; the week of duties reads its
/// past runs and names it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Deleted {
    pub deleted_at: String,
    pub automation: Automation,
}

/// Remove an automation's definition but keep its run log, with the
/// definition beside it as [`Deleted`] (PRO-499). Everything else in its
/// folder (what it has seen) goes. One that never ran leaves nothing.
pub fn remove_keeping_runs(id: &str, deleted_at: &str) -> Result<()> {
    let mut removed = None;
    update_definitions(|values| {
        let at = values
            .iter()
            .position(|value| value.id == id)
            .ok_or_else(|| anyhow::anyhow!("automation {id} not found"))?;
        removed = Some(values.remove(at));
        Ok(())
    })?;
    let automation = removed.ok_or_else(|| anyhow::anyhow!("automation {id} not found"))?;
    // A run finishing now waits, so the log is not written while its folder is emptied.
    let _guard = RUN_WRITE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let dir = super::root()?.join("automations").join(id);
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        if entry.file_name() == RUNS_FILE {
            continue;
        }
        if entry.file_type()?.is_dir() {
            std::fs::remove_dir_all(entry.path())?;
        } else {
            std::fs::remove_file(entry.path())?;
        }
    }
    let runs = dir.join(RUNS_FILE);
    if std::fs::metadata(&runs).map_or(true, |meta| meta.len() == 0) {
        std::fs::remove_dir_all(dir)?;
        return Ok(());
    }
    // A run still going ends here: recovery and the run's own ending read only the duties there are, so nothing
    // would close it after, and the week would draw it running for ever.
    let mut existing = resolve_runs(&runs)?;
    let mut closed_any = false;
    for run in &mut existing {
        if !run.status.is_terminal() {
            close_at_deletion(run, deleted_at);
            super::append_line(&runs, &serde_json::to_string(run)?)?;
            closed_any = true;
        }
    }
    if closed_any {
        maybe_compact_unlocked(&runs, existing)?;
    }
    super::write_json(
        &dir.join(DELETED_FILE),
        &Deleted {
            deleted_at: deleted_at.to_owned(),
            automation,
        },
    )
}

/// The deleted automations whose run logs are kept. One whose record cannot be
/// read is left out (and said in the log), never taken for one still defined.
pub fn list_deleted() -> Result<Vec<Deleted>> {
    let dir = super::root()?.join("automations");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path().join(DELETED_FILE);
        match super::read_json::<Deleted>(&path) {
            Ok(Some(deleted)) => out.push(deleted),
            Ok(None) => {}
            Err(error) => log::warn!("{}: {error:#}", path.display()),
        }
    }
    out.sort_by(|a, b| a.automation.id.cmp(&b.automation.id));
    Ok(out)
}

/// The deleted automation `id`, when its run log is kept.
pub fn get_deleted(id: &str) -> Result<Option<Deleted>> {
    // An id that names no single folder names no deleted automation.
    if id.is_empty() || id.contains(['/', '\\']) || id == "." || id == ".." {
        return Ok(None);
    }
    super::read_json(&super::root()?.join("automations").join(id).join(DELETED_FILE))
}

pub fn load_seen(automation_id: &str) -> Result<Option<SeenState>> {
    super::read_json(&seen_path(automation_id)?)
}

pub fn save_seen(automation_id: &str, state: &SeenState) -> Result<()> {
    let _guard = SEEN_WRITE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    super::write_json(&seen_path(automation_id)?, state)
}

pub fn clear_seen(automation_id: &str) -> Result<()> {
    let _guard = SEEN_WRITE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let path = seen_path(automation_id)?;
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn update_definitions(f: impl FnOnce(&mut Vec<Automation>) -> Result<()>) -> Result<()> {
    let _guard = DEFINITION_WRITE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let mut values = list()?;
    f(&mut values)?;
    save_unlocked(&values)
}

#[cfg(test)]
pub fn append_run(run: &AutomationRun) -> Result<()> {
    let _guard = RUN_WRITE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let path = runs_path(&run.automation_id)?;
    let mut latest = resolve_runs(&path)?;
    super::append_line(&path, &serde_json::to_string(run)?)?;
    upsert_resolved(&mut latest, run.clone());
    maybe_compact_unlocked(&path, latest)
}

fn upsert_resolved(latest: &mut Vec<AutomationRun>, run: AutomationRun) {
    if let Some(existing) = latest.iter_mut().find(|value| value.run_id == run.run_id) {
        *existing = run;
    } else {
        latest.push(run);
    }
    latest.sort_by_key(|value| std::cmp::Reverse(value.run_number));
}

fn maybe_compact_unlocked(path: &std::path::Path, mut latest: Vec<AutomationRun>) -> Result<()> {
    let terminal_count = latest
        .iter()
        .filter(|value| value.status.is_terminal())
        .count();
    if terminal_count > RUN_COMPACT_THRESHOLD {
        let mut kept_terminal = 0;
        latest.retain(|value| {
            if !value.status.is_terminal() {
                return true;
            }
            kept_terminal += 1;
            kept_terminal <= RUN_RETENTION
        });
        latest.sort_by_key(|value| value.run_number);
        let mut compacted = latest
            .into_iter()
            .map(|value| serde_json::to_string(&value))
            .collect::<std::result::Result<Vec<_>, _>>()?
            .join("\n");
        compacted.push('\n');
        super::write_atomic(path, compacted.as_bytes())?;
    }
    Ok(())
}

pub fn list_runs(automation_id: &str) -> Result<Vec<AutomationRun>> {
    resolve_runs(&runs_path(automation_id)?)
}

pub fn insert_run(mut run: AutomationRun) -> Result<AutomationRun> {
    let _guard = RUN_WRITE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let path = runs_path(&run.automation_id)?;
    let mut latest = resolve_runs(&path)?;
    run.run_number = latest
        .iter()
        .map(|value| value.run_number)
        .max()
        .unwrap_or(0)
        + 1;
    super::append_line(&path, &serde_json::to_string(&run)?)?;
    upsert_resolved(&mut latest, run.clone());
    maybe_compact_unlocked(&path, latest)?;
    Ok(run)
}

pub fn replace_run(
    automation_id: &str,
    run_id: &str,
    update: impl FnOnce(&mut AutomationRun) -> Result<()>,
) -> Result<AutomationRun> {
    let _guard = RUN_WRITE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let path = runs_path(automation_id)?;
    let mut latest = resolve_runs(&path)?;
    let run = latest
        .iter_mut()
        .find(|run| run.run_id == run_id)
        .ok_or_else(|| anyhow::anyhow!("automation run {run_id} not found"))?;
    update(run)?;
    let updated = run.clone();
    super::append_line(&path, &serde_json::to_string(&updated)?)?;
    maybe_compact_unlocked(&path, latest)?;
    Ok(updated)
}

/// Take one run out of the history: a pending run whose first check's result
/// was folded into an earlier record (PRO-484).
pub fn remove_run(automation_id: &str, run_id: &str) -> Result<()> {
    let _guard = RUN_WRITE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let path = runs_path(automation_id)?;
    let mut runs = resolve_runs(&path)?;
    runs.retain(|run| run.run_id != run_id);
    runs.sort_by_key(|run| run.run_number);
    let mut lines = runs
        .into_iter()
        .map(|run| serde_json::to_string(&run))
        .collect::<std::result::Result<Vec<_>, _>>()?
        .join("\n");
    if !lines.is_empty() {
        lines.push('\n');
    }
    super::write_atomic(&path, lines.as_bytes())?;
    Ok(())
}

fn resolve_runs(path: &std::path::Path) -> Result<Vec<AutomationRun>> {
    let records: Vec<AutomationRun> = super::read_lines(path)?;
    let mut latest = BTreeMap::new();
    for run in records {
        latest.insert(run.run_id.clone(), run);
    }
    let mut runs: Vec<_> = latest.into_values().collect();
    runs.sort_by_key(|run| std::cmp::Reverse(run.run_number));
    Ok(runs)
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutomationFile {
    #[serde(default)]
    automations: Vec<Automation>,
}

fn definitions_path() -> Result<PathBuf> {
    Ok(super::root()?.join("automations.json"))
}

fn runs_path(automation_id: &str) -> Result<PathBuf> {
    Ok(
        super::ensure_dir(super::root()?.join("automations").join(automation_id))?
            .join("runs.jsonl"),
    )
}

fn seen_path(automation_id: &str) -> Result<PathBuf> {
    Ok(
        super::ensure_dir(super::root()?.join("automations").join(automation_id))?
            .join("seen.json"),
    )
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::automations::{
        AutomationRunStatus, AutomationSchedule, AutomationTrigger, AutomationWorkspace,
        ScheduleKind, SchedulePreset,
    };

    fn automation() -> Automation {
        Automation {
            id: "auto-1".into(),
            name: "Weekday review".into(),
            enabled: true,
            project_path: "/project".into(),
            harness: "codex".into(),
            model: "model-1".into(),
            effort: Some("high".into()),
            mode: "auto".into(),
            prompt: "Review the open changes.".into(),
            workspace: AutomationWorkspace::NewWorktree,
            session_id: None,
            reuse_session: false,
            archive_on_complete: false,
            keep_latest_run_visible: false,
            base_ref: Some("origin/main".into()),
            schedule: AutomationSchedule {
                kind: ScheduleKind::Preset,
                preset: Some(SchedulePreset::Weekdays),
                cron: None,
                hour: Some(9),
                minute: Some(0),
                weekdays: Vec::new(),
                timezone: "Asia/Dubai".into(),
                dtstart: "2026-09-02T09:00:00+04:00".into(),
                unknown: BTreeMap::new(),
            },
            precheck: None,
            missed_run_grace_minutes: 60,
            run_timeout_minutes: None,
            next_run_at: "2026-09-03T05:00:00Z".into(),
            last_run_at: None,
            last_outcome: None,
            issue_trigger: None,
            event_trigger: None,
            pipeline: None,
            created: "2026-09-02T12:00:00Z".into(),
            modified: "2026-09-02T12:00:00Z".into(),
            unknown: BTreeMap::new(),
        }
    }

    fn run(status: AutomationRunStatus) -> AutomationRun {
        AutomationRun {
            run_id: "run-1".into(),
            run_number: 1,
            automation_id: "auto-1".into(),
            trigger: AutomationTrigger::Manual,
            scheduled_for: None,
            started_at: None,
            ended_at: None,
            status,
            session_id: None,
            tab_id: None,
            worktree_name: None,
            issue: None,
            final_message: None,
            deferred_completion: None,
            changed_files: None,
            usage: None,
            precheck: None,
            error: None,
            reported: None,
            repeat_count: 1,
            last_repeat_at: None,
            unknown: BTreeMap::new(),
        }
    }

    #[test]
    fn definitions_and_latest_run_state_round_trip() {
        let _home = crate::store::temp_home();
        let definition = automation();
        save(std::slice::from_ref(&definition)).unwrap();
        assert_eq!(list().unwrap(), vec![definition]);

        let pending = run(AutomationRunStatus::Pending);
        append_run(&pending).unwrap();
        let mut completed = pending;
        completed.status = AutomationRunStatus::Completed;
        completed.final_message = Some("Everything is clean.".into());
        append_run(&completed).unwrap();
        assert_eq!(list_runs("auto-1").unwrap(), vec![completed]);
    }

    #[test]
    fn compaction_keeps_one_hundred_terminal_runs_and_every_open_run() {
        let _home = crate::store::temp_home();
        let mut open = run(AutomationRunStatus::Pending);
        open.run_id = "run-open".into();
        open.run_number = 0;
        append_run(&open).unwrap();

        // Hysteresis: runs past RUN_RETENTION (100) stay append-only until
        // RUN_COMPACT_THRESHOLD (200) is exceeded.
        for number in 1..=(RUN_RETENTION as u64 + 5) {
            let mut completed = run(AutomationRunStatus::Completed);
            completed.run_id = format!("run-{number}");
            completed.run_number = number;
            append_run(&completed).unwrap();
        }
        assert_eq!(list_runs("auto-1").unwrap().len(), RUN_RETENTION + 6);

        // Exceeding RUN_COMPACT_THRESHOLD triggers compaction down to RUN_RETENTION
        // terminal runs plus every open run.
        for number in (RUN_RETENTION as u64 + 6)..=(RUN_COMPACT_THRESHOLD as u64 + 1) {
            let mut completed = run(AutomationRunStatus::Completed);
            completed.run_id = format!("run-{number}");
            completed.run_number = number;
            append_run(&completed).unwrap();
        }

        let retained = list_runs("auto-1").unwrap();
        assert_eq!(retained.len(), RUN_RETENTION + 1);
        assert!(retained.iter().any(|value| value.run_id == "run-open"));
        assert!(!retained
            .iter()
            .any(|value| value.run_number == 1 || value.run_number == 2));
        assert_eq!(
            std::fs::read_to_string(runs_path("auto-1").unwrap())
                .unwrap()
                .lines()
                .count(),
            RUN_RETENTION + 1
        );
    }
}
