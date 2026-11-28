//! Local child startup incidents. Silence after readiness is never a startup
//! failure. The owner watches on its own clock, independently of PR metadata.
//! No action here kills a process, answers a permission, or changes a gate.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, SystemTime};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
mod macos;
mod probe;
mod recorder;
mod validation;
pub use recorder::{RecorderExit, RecorderFailure, RecorderIdentity};
pub use validation::{run_validation, ValidationHeld};
pub use validation::validation_pending;
#[cfg(feature = "desktop")]
pub mod commands;
pub use probe::probe_cli;

/// The most launch records kept (PRO-575). Above it the oldest settled ones are dropped first:
/// exited or unobserved, and running or waiting ones whose process is gone. The active incident's
/// own launches, live roots, unsettled starts and pending validation recorders are always kept, so
/// only those can take the file past it.
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
    /// Startup proof survives temporary permission waits and loss of observation.
    #[serde(default)]
    pub startup_proven: bool,
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
    /// The permission waits holding recovery now (see [`Snapshot::holds_recovery`]), rewritten
    /// on every refresh, so it never outgrows the waits that are live. They do not make their
    /// pipelines affected.
    #[serde(default)]
    pub recovery_waits: Vec<String>,
    /// Pipelines whose new local checks were held, including dependencies
    /// not themselves exhibiting the signature. No PR metadata is required.
    pub blocked_pipelines: Vec<String>,
    pub probe: Option<probe::Probe>,
    /// The person hid this incident's banner (PRO-575). Held validation stays held. Cleared
    /// when the incident gets worse than it was then: see [`Incident::worse_than`].
    #[serde(default)]
    pub dismissed: Option<Dismissal>,
}

/// What the incident looked like when its banner was hidden.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Dismissal {
    pub at: i64,
    pub escalated: bool,
    pub affected_panes: usize,
}

impl Incident {
    /// Distinct panes among this incident's launches, as the banner counts them.
    fn affected_panes(&self, launches: &[Launch]) -> usize {
        launches.iter().filter(|launch| self.launches.contains(&launch.id)).map(|launch| launch.pane.as_str()).collect::<HashSet<_>>().len()
    }

    /// "Worse" than when the banner was hidden: the incident has escalated since, or more panes
    /// are affected than then. Anything else (time passing, probes, waits) keeps it hidden.
    fn worse_than(&self, dismissal: &Dismissal, launches: &[Launch]) -> bool {
        self.escalated_at.is_some() && !dismissal.escalated || self.affected_panes(launches) > dismissal.affected_panes
    }
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
                    escalated_at: None, recovered_at: None, launches: vec![], recovery_waits: vec![], blocked_pipelines: vec![], probe: None, dismissed: None });
            }
            let incident = self.incidents.last_mut().expect("active incident");
            for id in overdue { if !incident.launches.contains(&id) { incident.launches.push(id); } }
        }
        if let Some(incident) = self.incidents.iter_mut().rev().find(|incident| incident.recovered_at.is_none()) {
            if incident.escalated_at.is_none() && at.saturating_sub(incident.detected_at) >= i64::from(self.policy.escalate_after_seconds) * 1000 {
                incident.escalated_at = Some(at);
            }
        }
        if let Some(incident) = self.incidents.iter_mut().rev().find(|incident| incident.recovered_at.is_none()) {
            if incident.dismissed.as_ref().is_some_and(|dismissal| incident.worse_than(dismissal, &self.launches)) { incident.dismissed = None; }
        }
        self.prune();
    }

    /// Retire settled history beyond [`HISTORY`], oldest first, never a live owner, an unsettled
    /// start or a pending recorder: those are still needed for census and checkout admission.
    /// One pass with sets, so a file of thousands of records shrinks on its first refresh.
    fn prune(&mut self) {
        let excess = self.launches.len().saturating_sub(HISTORY);
        if excess > 0 {
            // Not the waits list read from disk: an old file lists thousands. The waits that hold
            // recovery are live by definition, and are found again after pruning.
            let kept: HashSet<&str> = self.active().map(|incident| incident.launches.iter().map(String::as_str).collect()).unwrap_or_default();
            let retired: HashSet<String> = self.launches.iter().filter(|launch| !kept.contains(launch.id.as_str()) && settled_record(launch))
                .take(excess).map(|launch| launch.id.clone()).collect();
            self.launches.retain(|launch| !retired.contains(&launch.id));
        }
        if self.incidents.len() > 16 { self.incidents.drain(..self.incidents.len() - 16); }
        let known: HashSet<&str> = self.launches.iter().map(|launch| launch.id.as_str()).collect();
        for incident in &mut self.incidents { incident.recovery_waits.retain(|id| known.contains(id.as_str())); }
    }

    /// Whether this permission wait holds the incident's recovery (PRO-575). A wait in one of the
    /// incident's own panes does: the prompt may hide its stalled child. So does a wait that began
    /// after detection (a launch's progress time is when its wait began, as observing the same
    /// card again is not progress) by a launch whose startup is not yet proven, since that may be
    /// a new stall behind the card. A proven launch waiting elsewhere is a person's decision, not a
    /// startup failure, and does not hold it.
    fn holds_recovery(incident: &Incident, panes: &HashSet<&str>, launch: &Launch) -> bool {
        launch.phase == Phase::PermissionPrompt
            && (panes.contains(launch.pane.as_str()) || !launch.startup_proven && launch.last_progress_at > incident.detected_at)
    }

    /// Ids of the permission waits holding this incident's recovery now.
    fn recovery_waits(&self, incident: &Incident) -> Vec<String> {
        let panes: HashSet<&str> = self.launches.iter().filter(|launch| incident.launches.contains(&launch.id)).map(|launch| launch.pane.as_str()).collect();
        self.launches.iter().filter(|launch| Self::holds_recovery(incident, &panes, launch)).map(|launch| launch.id.clone()).collect()
    }

    /// Every launch of the incident has run or closed: running, exited, or unobserved with its
    /// exact process gone. Losing observation afterwards cannot hide one of them still stalling.
    fn incident_settled(&self, incident: &Incident) -> bool {
        self.launches.iter().filter(|launch| incident.launches.contains(&launch.id)).all(|launch| match launch.phase {
            Phase::Running | Phase::Exited => true,
            Phase::Unobserved => process_gone(launch),
            Phase::Spawning | Phase::AwaitingReady | Phase::PermissionPrompt => false,
        })
    }
}

/// History that may be retired: an exit, a lost child (never a pending recorder's), or a running
/// or waiting record whose exact process birth no longer exists.
fn settled_record(launch: &Launch) -> bool {
    match launch.phase {
        Phase::Exited => true,
        Phase::Unobserved => launch.recorder.is_none(),
        Phase::Running | Phase::PermissionPrompt => launch.recorder.is_none() && process_gone(launch),
        Phase::Spawning | Phase::AwaitingReady => false,
    }
}

/// The launch's exact process birth is no longer alive. Unknown identity is never "gone".
fn process_gone(launch: &Launch) -> bool {
    let birth = match launch.evidence {
        Evidence::Readiness => launch.pid_birth.as_deref(),
        Evidence::SmallUnchangingImage => Some(launch.generation.as_str()),
    };
    match (launch.pid, birth) {
        (Some(pid), Some(birth)) => process_identity(Some(pid)).as_deref() != Some(birth),
        _ => false,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    mtime: Option<SystemTime>,
    len: u64,
    #[cfg(unix)]
    ino: u64,
}

impl FileStamp {
    fn of(path: &Path) -> Option<Self> {
        let meta = std::fs::metadata(path).ok()?;
        #[cfg(unix)]
        use std::os::unix::fs::MetadataExt;
        Some(Self {
            mtime: meta.modified().ok(),
            len: meta.len(),
            #[cfg(unix)]
            ino: meta.ino(),
        })
    }
}

struct CachedSnapshot {
    stamp: Option<FileStamp>,
    snapshot: Snapshot,
}

static SNAPSHOT_CACHE: LazyLock<Mutex<HashMap<PathBuf, CachedSnapshot>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[cfg(test)]
thread_local! {
    static SNAPSHOT_DISK_READS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

fn cache_store(directory: &Path, stamp: Option<FileStamp>, snapshot: Snapshot) {
    let mut cache = SNAPSHOT_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if cache.len() >= 64 && !cache.contains_key(directory) {
        cache.clear();
    }
    cache.insert(directory.to_path_buf(), CachedSnapshot { stamp, snapshot });
}

fn read_cached(directory: &Path) -> Result<Snapshot> {
    let path = directory.join("incidents.json");
    let stamp = FileStamp::of(&path);
    {
        let cache = SNAPSHOT_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = cache.get(directory) {
            if entry.stamp == stamp {
                return Ok(entry.snapshot.clone());
            }
        }
    }
    #[cfg(test)]
    SNAPSHOT_DISK_READS.with(|count| count.set(count.get() + 1));
    let snapshot: Snapshot = crate::store::read_json(&path)?.unwrap_or_default();
    cache_store(directory, stamp, snapshot.clone());
    Ok(snapshot)
}

fn directory() -> Result<PathBuf> { crate::store::ensure_dir(crate::store::root()?.join("startup")) }

pub fn snapshot() -> Result<Snapshot> { read_cached(&directory()?) }

fn update_at<T>(directory: &Path, work: impl FnOnce(&mut Snapshot) -> Result<T>) -> Result<T> {
    crate::store::transaction::run(&directory.join("incidents.lock"), Duration::from_secs(2), || {
        let path = directory.join("incidents.json");
        let mut state = read_cached(directory)?;
        let before = state.clone();
        let result = work(&mut state)?;
        if state != before {
            crate::store::write_json(&path, &state)?;
            cache_store(directory, FileStamp::of(&path), state);
        }
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
        if matches!(launch.phase, Phase::Exited | Phase::Unobserved) { return; }
        if launch.pid == pid && launch.phase != Phase::Spawning { return; }
        launch.last_progress_at = now();
        launch.pid = pid;
        if launch.phase == Phase::Spawning { launch.phase = Phase::AwaitingReady; }
        #[cfg(target_os = "macos")]
        { launch.pid_birth = pid.and_then(macos::identity); }
    }); }
    pub fn ready(&self) { self.change(|launch| {
        if matches!(launch.phase, Phase::Spawning | Phase::AwaitingReady | Phase::Unobserved) {
            launch.startup_proven = true;
            launch.phase = Phase::Running; launch.last_progress_at = now();
        }
    }); }
    pub fn exited(&self, code: Option<u32>) { self.change(|launch| {
        if launch.phase != Phase::Exited || launch.exit_code.is_none() && code.is_some() {
            launch.phase = Phase::Exited; launch.exit_code = code; launch.last_progress_at = now();
        }
    }); }
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
                startup_proven: false, phase: if pid.is_some() { Phase::AwaitingReady } else { Phase::Spawning }, started_at: now(), last_progress_at: now(), exit_code: None, cpu_time: None, resident_bytes: None,
                pid_birth: process_identity(pid), recorder: None, pipeline_id: None, recorder_owner: None, recorder_exit: None });
            Ok(id)
        })?;
        Ok(Ticket { monitor: self.clone(), id })
    }

    /// Whether a cached snapshot needs active polling right now. When all live
    /// panes are already `startup_proven && phase == Phase::Running`, no incident
    /// is open, no validation recorder is active, and no permission wait is up,
    /// polling would be a pure no-op.
    fn needs_poll(state: &Snapshot, terminals: &crate::pty::Terminals, permissions: Option<&[String]>) -> bool {
        if state.active().is_some() || state.census_incomplete || state.launches.len() > HISTORY {
            return true;
        }
        if permissions.is_some_and(|panes| !panes.is_empty()) {
            return true;
        }
        if state.launches.iter().any(|launch| {
            (launch.recorder.is_some() && launch.phase != Phase::Exited)
                || matches!(launch.phase, Phase::Spawning | Phase::AwaitingReady | Phase::PermissionPrompt)
                || (launch.phase == Phase::Running && !launch.startup_proven)
        }) {
            return true;
        }
        terminals.panes().into_iter().filter(|pane| pane.running).any(|pane| {
            !state.launches.iter().any(|launch| {
                launch.evidence == Evidence::Readiness
                    && launch.pane == pane.id
                    && launch.pid == pane.pid
                    && launch.startup_proven
                    && launch.phase == Phase::Running
            })
        })
    }

    fn poll(&self, terminals: &crate::pty::Terminals, permissions: Option<&[String]>) -> Result<bool> {
        let cached = read_cached(&self.directory)?;
        if !Self::needs_poll(&cached, terminals, permissions) {
            return Ok(false);
        }
        #[cfg(target_os = "macos")]
        let children = macos::children(terminals, &cached, permissions);
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
                if launch.startup_proven && launch.phase == Phase::Running && !permissions.contains(&launch.pane) {
                    continue;
                }
                if launch.evidence == Evidence::Readiness && matches!(launch.phase, Phase::AwaitingReady | Phase::PermissionPrompt | Phase::Running) {
                    // A known application permission card proves startup, but
                    // repeated observation of the same wait is not progress.
                    if permissions.contains(&launch.pane) {
                        if launch.phase != Phase::PermissionPrompt { launch.last_progress_at = at; }
                        launch.startup_proven = true;
                        launch.phase = Phase::PermissionPrompt;
                    }
                    else if launch.phase == Phase::PermissionPrompt { launch.startup_proven = true; launch.phase = Phase::Running; launch.last_progress_at = at; }
                    if launch.phase == Phase::AwaitingReady && launch.recorder.is_none() && launch.pid.is_some() && terminals.pid(&launch.pane) == launch.pid && terminals.last_output(&launch.pane).is_some() { launch.startup_proven = true; launch.phase = Phase::Running; launch.last_progress_at = at; }
                }
            }
            #[cfg(target_os = "macos")]
            macos::observe(state, children, permissions, at);
            // Join all newly overdue launches before considering recovery, so
            // health cannot split one ongoing host incident into two.
            state.tick(at);
            if let Err(error) = probe::refresh(&self.directory, state, at) {
                // A recorder or filesystem error must not suspend incident age.
                log::warn!("refresh startup probe: {error:#}");
            }
            let incident_changed = state.incidents != before.incidents
                || state.census_incomplete != before.census_incomplete
                || state.observation_lost_at != before.observation_lost_at;
            Ok(incident_changed)
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

/// Hide the banner for this open incident (PRO-575). Held validation stays held, and the
/// dismissal lives in the incident record, so it survives a restart for this incident only.
pub fn dismiss(incident: &str) -> Result<Snapshot> {
    update_at(&directory()?, |state| dismiss_in(state, incident, now()))?;
    snapshot()
}

fn dismiss_in(state: &mut Snapshot, id: &str, at: i64) -> Result<()> {
    let index = state.incidents.iter().position(|incident| incident.id == id && incident.recovered_at.is_none())
        .context("That startup incident is no longer open.")?;
    let incident = &state.incidents[index];
    let dismissal = Dismissal { at, escalated: incident.escalated_at.is_some(), affected_panes: incident.affected_panes(&state.launches) };
    state.incidents[index].dismissed = Some(dismissal);
    Ok(())
}

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

/// The OS as a person reads it, "macOS 26.1 (25B78)", for a report (PRO-287).
pub fn os_label() -> Option<String> {
    let version = os_version();
    let number = version["version"].as_str()?;
    Some(match version["build"].as_str() {
        Some(build) => format!("macOS {number} ({build})"),
        None => format!("macOS {number}"),
    })
}

fn os_version() -> serde_json::Value {
    #[cfg(target_os = "macos")]
    { macos::version() }
    #[cfg(not(target_os = "macos"))]
    { serde_json::Value::Null }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod perf_tests {
    use super::*;

    #[test]
    fn healthy_proven_launches_skip_poll_disk_writes_and_emit() {
        let directory = tempfile::tempdir().unwrap();
        let monitor = Monitor { directory: directory.path().into() };
        let mut proven = tests::launch("tab:healthy", Phase::Running);
        proven.startup_proven = true;
        let state = Snapshot { launches: vec![proven], ..Snapshot::default() };
        let path = directory.path().join("incidents.json");
        crate::store::write_json(&path, &state).unwrap();
        let stamp_before = FileStamp::of(&path);
        let terminals = crate::pty::Terminals::new();

        // First poll populates the in-memory cache and detects nothing to poll.
        SNAPSHOT_DISK_READS.with(|c| c.set(0));
        assert!(!monitor.poll(&terminals, Some(&[])).unwrap());
        assert_eq!(SNAPSHOT_DISK_READS.with(|c| c.get()), 1);

        // Subsequent polls hit the in-memory cache: 0 disk reads, 0 writes, 0 emits.
        assert!(!monitor.poll(&terminals, Some(&[])).unwrap());
        assert!(!monitor.poll(&terminals, Some(&[])).unwrap());
        assert_eq!(SNAPSHOT_DISK_READS.with(|c| c.get()), 1);
        assert_eq!(FileStamp::of(&path), stamp_before, "incidents.json must not be rewritten");
    }
}
