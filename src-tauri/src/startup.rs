//! Local child startup incidents. Silence after readiness is never a startup
//! failure. The owner watches on its own clock, independently of PR metadata.
//! No action here kills a process, answers a permission, or changes a gate.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
mod macos;
mod probe;
mod recorder;
mod validation;
pub use recorder::{retain_recorder, RecorderExit, RecorderFailure, RecorderIdentity};
pub use validation::{run_validation, ValidationHeld};
pub use validation::validation_pending;
#[cfg(feature = "desktop")]
pub mod commands;
pub use probe::probe_cli;

const HISTORY: usize = 256;
pub const CHANGED: &str = "startup_incident";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub suspect_after_seconds: u32,
    pub escalate_after_seconds: u32,
}

impl Default for Policy {
    fn default() -> Self { Self { suspect_after_seconds: 120, escalate_after_seconds: 300 } }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Phase { Spawning, AwaitingReady, Running, PermissionPrompt, Exited, Unobserved }

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Category { Agent, Shell, Validation, OwnedChild }

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Evidence { Readiness, SmallUnchangingImage }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Launch {
    pub id: String,
    pub pane: String,
    pub generation: String,
    pub pid: Option<u32>,
    pub category: Category,
    pub evidence: Evidence,
    pub phase: Phase,
    pub started_at: i64,
    pub last_progress_at: i64,
    pub exit_code: Option<u32>,
    pub cpu_time: Option<u64>,
    pub resident_bytes: Option<u64>,
    #[serde(default)]
    pub pid_birth: Option<String>,
    #[serde(default)]
    pub recorder: Option<String>,
    #[serde(default)]
    pub pipeline_id: Option<String>,
    #[serde(default)]
    pub recorder_owner: Option<RecorderIdentity>,
    #[serde(default)]
    pub recorder_exit: Option<RecorderExit>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Incident {
    pub id: String,
    pub detected_at: i64,
    pub escalated_at: Option<i64>,
    pub recovered_at: Option<i64>,
    pub launches: Vec<String>,
    /// Pipelines whose new local checks were held, including dependencies
    /// not themselves exhibiting the signature. No PR metadata is required.
    pub blocked_pipelines: Vec<String>,
    pub probe: Option<probe::Probe>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub policy: Policy,
    pub launches: Vec<Launch>,
    pub incidents: Vec<Incident>,
    #[serde(default)]
    pub census_incomplete: bool,
    /// Losing observation is not meaningful child progress. Health evidence
    /// from before this transition cannot establish recovery afterwards.
    #[serde(default)]
    pub observation_lost_at: Option<i64>,
}

pub fn now() -> i64 { chrono::Utc::now().timestamp_millis() }

impl Snapshot {
    pub fn active(&self) -> Option<&Incident> { self.incidents.iter().rev().find(|incident| incident.recovered_at.is_none()) }

    fn tick(&mut self, at: i64) {
        let overdue: Vec<_> = self.launches.iter().filter(|launch|
            matches!(launch.phase, Phase::Spawning | Phase::AwaitingReady)
                && at.saturating_sub(launch.last_progress_at) >= i64::from(self.policy.suspect_after_seconds) * 1000
        ).map(|launch| launch.id.clone()).collect();
        if !overdue.is_empty() {
            if self.active().is_none() {
                self.incidents.push(Incident { id: uuid::Uuid::new_v4().to_string(), detected_at: at,
                    escalated_at: None, recovered_at: None, launches: vec![], blocked_pipelines: vec![], probe: None });
            }
            let incident = self.incidents.last_mut().expect("active incident");
            for id in overdue { if !incident.launches.contains(&id) { incident.launches.push(id); } }
        }
        if let Some(incident) = self.incidents.iter_mut().rev().find(|incident| incident.recovered_at.is_none()) {
            if incident.escalated_at.is_none() && at.saturating_sub(incident.detected_at) >= i64::from(self.policy.escalate_after_seconds) * 1000 {
                incident.escalated_at = Some(at);
            }
        }
        // Retire completed history, never a live owner or pending recorder.
        // Those identities are still needed for census and checkout admission.
        while self.launches.len() > HISTORY {
            let removable = self.launches.iter().position(|launch|
                matches!(launch.phase, Phase::Exited | Phase::Unobserved)
                    && (launch.recorder.is_none() || launch.phase == Phase::Exited)
                    && !self.active().is_some_and(|incident| incident.launches.contains(&launch.id)));
            let Some(index) = removable else { break };
            self.launches.remove(index);
        }
        if self.incidents.len() > 16 { self.incidents.drain(..self.incidents.len() - 16); }
    }
}

fn directory() -> Result<PathBuf> { crate::store::ensure_dir(crate::store::root()?.join("startup")) }

pub fn snapshot() -> Result<Snapshot> { Ok(crate::store::read_json(&directory()?.join("incidents.json"))?.unwrap_or_default()) }

fn update_at<T>(directory: &Path, work: impl FnOnce(&mut Snapshot) -> Result<T>) -> Result<T> {
    crate::store::transaction::run(&directory.join("incidents.lock"), Duration::from_secs(2), || {
        let path = directory.join("incidents.json");
        let mut state: Snapshot = crate::store::read_json(&path)?.unwrap_or_default();
        let before = state.clone();
        let result = work(&mut state)?;
        if state != before { crate::store::write_json(&path, &state)?; }
        Ok(result)
    })
}

pub fn set_policy(policy: Policy) -> Result<()> {
    if !(15..=3600).contains(&policy.suspect_after_seconds) || !(15..=3600).contains(&policy.escalate_after_seconds) {
        bail!("Startup thresholds must be between 15 and 3600 seconds.");
    }
    update_at(&directory()?, |state| { state.policy = policy; Ok(()) })
}

/// A blocker has no success semantics. Only a completed, fresh two-part probe
/// and the absence of still-observed startup stalls can release this hold.
pub fn validation_blocker(pipeline: Option<&str>) -> Result<Option<String>> {
    update_at(&directory()?, |state| {
        let Some(incident) = state.incidents.iter_mut().rev().find(|incident| incident.recovered_at.is_none()) else { return Ok(None) };
        if let Some(id) = pipeline {
            if !incident.blocked_pipelines.iter().any(|known| known == id) { incident.blocked_pipelines.push(id.into()); }
        }
        Ok(Some(format!("Local startup incident {}{}: new heavy validation is held. Open Local startup diagnostics and demonstrate shell and native launch health before retrying; pending or interrupted checks are not a pass.", incident.id,
            if incident.escalated_at.is_some() { " needs attention" } else { " is unresolved" })))
    })
}

/// One owner, with a fixed directory so a late callback cannot write into a
/// replacement test home. The files are also locked across app/runtime overlap.
pub struct Monitor { directory: PathBuf }

#[derive(Clone)]
pub struct Ticket { monitor: Arc<Monitor>, id: String }

impl Ticket {
    pub fn spawned(&self, pid: Option<u32>) { self.change(|launch| {
        launch.pid = pid; launch.phase = Phase::AwaitingReady;
        #[cfg(target_os = "macos")]
        { launch.pid_birth = pid.and_then(macos::identity); }
    }); }
    pub fn ready(&self) { self.change(|launch| { launch.phase = Phase::Running; launch.last_progress_at = now(); }); }
    pub fn exited(&self, code: Option<u32>) { self.change(|launch| { launch.phase = Phase::Exited; launch.exit_code = code; launch.last_progress_at = now(); }); }
    fn change(&self, work: impl FnOnce(&mut Launch)) {
        if let Err(error) = update_at(&self.monitor.directory, |state| {
            if let Some(launch) = state.launches.iter_mut().find(|launch| launch.id == self.id) { work(launch); }
            Ok(())
        }) { log::warn!("record startup progress: {error:#}"); }
    }
}

impl Monitor {
    pub fn begin(self: &Arc<Self>, pane: &str, generation: &str, pid: Option<u32>) -> Result<Ticket> {
        let id = update_at(&self.directory, |state| {
            // A live handover carries the same generation, never a new attempt.
            if let Some(launch) = state.launches.iter().find(|launch| launch.pane == pane && launch.generation == generation) { return Ok(launch.id.clone()); }
            let id = uuid::Uuid::new_v4().to_string();
            state.launches.push(Launch { id: id.clone(), pane: pane.into(), generation: generation.into(), pid,
                category: if pane.starts_with("tab:") { Category::Agent } else { Category::Shell }, evidence: Evidence::Readiness,
                phase: if pid.is_some() { Phase::AwaitingReady } else { Phase::Spawning }, started_at: now(), last_progress_at: now(), exit_code: None, cpu_time: None, resident_bytes: None,
                pid_birth: process_identity(pid), recorder: None, pipeline_id: None, recorder_owner: None, recorder_exit: None });
            Ok(id)
        })?;
        Ok(Ticket { monitor: self.clone(), id })
    }

    fn poll(&self, terminals: &crate::pty::Terminals, permissions: Option<&[String]>) -> Result<bool> {
        #[cfg(target_os = "macos")]
        let children = macos::children(terminals, &crate::store::read_json::<Snapshot>(&self.directory.join("incidents.json"))?.unwrap_or_default());
        update_at(&self.directory, |state| {
            let before = state.clone();
            let at = now();
            if let Err(error) = validation::refresh(&self.directory, state) {
                // A broken recorder cannot freeze the host incident's clock.
                // Admission still fails closed when it reads that recorder.
                log::warn!("refresh validation recorder: {error:#}");
            }
            // A busy tab lock is an unknown snapshot, not a person dismissing
            // a prompt. Keep the last known human waits until a complete read.
            let previous_permissions: Vec<_> = state.launches.iter().filter(|launch| launch.phase == Phase::PermissionPrompt).map(|launch| launch.pane.clone()).collect();
            let permissions = permissions.unwrap_or(&previous_permissions);
            for launch in &mut state.launches {
                if launch.evidence == Evidence::Readiness && matches!(launch.phase, Phase::AwaitingReady | Phase::PermissionPrompt | Phase::Running) {
                    if permissions.contains(&launch.pane) { launch.phase = Phase::PermissionPrompt; launch.last_progress_at = at; }
                    else if launch.phase == Phase::PermissionPrompt { launch.phase = Phase::AwaitingReady; launch.last_progress_at = at; }
                    if launch.phase == Phase::AwaitingReady && launch.recorder.is_none() && terminals.pid(&launch.pane) == launch.pid && terminals.last_output(&launch.pane).is_some() { launch.phase = Phase::Running; launch.last_progress_at = at; }
                }
            }
            #[cfg(target_os = "macos")]
            macos::observe(state, children, permissions, at);
            if let Err(error) = probe::refresh(&self.directory, state, at) {
                // A recorder or filesystem error must not suspend incident age.
                log::warn!("refresh startup probe: {error:#}");
            }
            state.tick(at);
            Ok(state != &before)
        })
    }
}

fn process_identity(pid: Option<u32>) -> Option<String> {
    #[cfg(target_os = "macos")]
    { pid.and_then(macos::identity) }
    #[cfg(not(target_os = "macos"))]
    { let _ = pid; None }
}

/// Called by the local process owner, before it starts accepting panes. A
/// closed window does not stop this timer. No global timer is started in tests.
pub fn start(manager: crate::session::SessionManager, sink: Arc<dyn crate::sink::EventSink>, handed_over: bool) -> Result<()> {
    let monitor = Arc::new(Monitor { directory: directory()? });
    if !handed_over {
        update_at(&monitor.directory, |state| {
            state.observation_lost_at = Some(now());
            state.census_incomplete = true;
            for launch in state.launches.iter_mut().filter(|launch| launch.recorder.is_none() && launch.phase != Phase::Exited) {
                // No adopted waiter means no final status is known. Keep the
                // incident and require new health evidence, never a fake exit.
                launch.phase = Phase::Unobserved;
            }
            Ok(())
        })?;
    }
    manager.terminals().set_startup_monitor(monitor.clone());
    std::thread::Builder::new().name("startup-monitor".into()).spawn(move || loop {
        std::thread::sleep(Duration::from_secs(5));
        let permissions = manager.startup_prompt_panes();
        match monitor.poll(manager.terminals(), permissions.as_deref()) {
            Ok(true) => sink.emit(CHANGED, &()),
            Ok(false) => {},
            Err(error) => log::warn!("startup monitor: {error:#}"),
        }
    })?;
    Ok(())
}

pub fn start_probe() -> Result<Snapshot> { probe::start(&directory()?)?; snapshot() }

/// Export is an allowlist projection, never serialization of the local record.
/// In particular panes, PIDs, paths, commands, output, environment and account
/// names cannot cross this boundary, including if a local file was tampered with.
pub fn preview() -> Result<String> { export(&snapshot()?) }

fn identifier(value: &str) -> String { uuid::Uuid::parse_str(value).map(|id| id.to_string()).unwrap_or_else(|_| "[redacted]".into()) }

fn export(state: &Snapshot) -> Result<String> {
    use serde_json::json;
    let incidents: Vec<_> = state.incidents.iter().map(|incident| {
        let launches: Vec<_> = state.launches.iter().filter(|launch| incident.launches.contains(&launch.id)).map(|launch| json!({
            "category": launch.category, "evidence": launch.evidence, "phase": launch.phase,
            "startedAt": launch.started_at, "lastProgressAt": launch.last_progress_at, "exitCode": launch.exit_code,
            "recorderExit": launch.recorder_exit.as_ref().map(recorder::export),
        })).collect();
        let panes: std::collections::HashSet<_> = state.launches.iter().filter(|launch| incident.launches.contains(&launch.id)).map(|launch| &launch.pane).collect();
        json!({ "incidentId": identifier(&incident.id), "detectedAt": incident.detected_at, "escalatedAt": incident.escalated_at,
            "recoveredAt": incident.recovered_at, "affectedPaneCount": panes.len(), "blockedPipelineCount": incident.blocked_pipelines.len(),
            "launches": launches, "probe": incident.probe.as_ref().map(probe::export) })
    }).collect();
    serde_json::to_string_pretty(&json!({ "schema": 1, "kind": "localStartupDiagnostics", "appVersion": env!("CARGO_PKG_VERSION"),
        "architecture": std::env::consts::ARCH, "os": std::env::consts::OS, "osVersion": os_version(), "generatedAt": now(), "timezone": "UTC",
        "policy": state.policy, "censusIncomplete": state.census_incomplete, "observationLostAt": state.observation_lost_at,
        "incidents": incidents })).map_err(Into::into)
}

fn os_version() -> serde_json::Value {
    #[cfg(target_os = "macos")]
    { macos::version() }
    #[cfg(not(target_os = "macos"))]
    { serde_json::Value::Null }
}

#[cfg(test)]
mod tests;
