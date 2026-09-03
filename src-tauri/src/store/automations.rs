//! Atomic automation definitions and append-only run histories.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::automations::{Automation, AutomationRun};

const RUN_RETENTION: usize = 100;
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
    append_and_compact_unlocked(run)
}

fn append_and_compact_unlocked(run: &AutomationRun) -> Result<()> {
    let path = runs_path(&run.automation_id)?;
    super::append_line(&path, &serde_json::to_string(run)?)?;
    let mut latest = resolve_runs(&path)?;
    let terminal_count = latest
        .iter()
        .filter(|value| value.status.is_terminal())
        .count();
    if terminal_count > RUN_RETENTION {
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
        super::write_atomic(&path, compacted.as_bytes())?;
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
    run.run_number = list_runs(&run.automation_id)?
        .into_iter()
        .map(|value| value.run_number)
        .max()
        .unwrap_or(0)
        + 1;
    append_and_compact_unlocked(&run)?;
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
    let mut run = list_runs(automation_id)?
        .into_iter()
        .find(|run| run.run_id == run_id)
        .ok_or_else(|| anyhow::anyhow!("automation run {run_id} not found"))?;
    update(&mut run)?;
    append_and_compact_unlocked(&run)?;
    Ok(run)
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

        for number in 1..=102 {
            let mut completed = run(AutomationRunStatus::Completed);
            completed.run_id = format!("run-{number}");
            completed.run_number = number;
            append_run(&completed).unwrap();
        }

        let retained = list_runs("auto-1").unwrap();
        assert_eq!(retained.len(), 101);
        assert!(retained.iter().any(|value| value.run_id == "run-open"));
        assert!(!retained
            .iter()
            .any(|value| value.run_number == 1 || value.run_number == 2));
        assert_eq!(
            std::fs::read_to_string(runs_path("auto-1").unwrap())
                .unwrap()
                .lines()
                .count(),
            101
        );
    }
}
