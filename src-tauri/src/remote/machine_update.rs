//! `machine/3` (PRO-354, docs/MACHINES.md "Versions and updates"): what
//! version a machine runs, what it could update to, and updating it from the
//! desktop that operates it.
//!
//! - `machine.updateStatus` and `machine.update` answer [`Status`]
//!   (`MachineUpdateStatus` in src/types/machines.ts); every change goes out
//!   as `machine.updateChanged` to `machine/3` connections (`server.rs`).
//! - A headless runtime the installer put in `~/.terminalx/versions`
//!   (`installer`) updates itself in a detached helper,
//!   `terminalx-serve update --apply <version> --status <file>`
//!   (`serve_cli::update`): the runtime execs in place during the handover,
//!   so its own threads cannot see the update through.
//! - A runtime the desktop app started (`app`) asks its window to run the
//!   app's updater: [`REQUESTED_EVENT`] on its event stream, answered by the
//!   window's reports ([`report`], the control call
//!   `runtime.machineUpdate.report`).
//! - Anything else (`unmanaged`) is updated the way it was installed.
//!
//! Both the helper and the window's reports write one record,
//! `<data>/run/machine-update.json` (owner only), which every runtime of the
//! data directory reads: the one that asked, and the one that took over.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// PID of the currently running authorized `terminalx-serve update` helper
/// spawned by this runtime (0 when idle), so `control::refuse_runtime_lifecycle`
/// permits only this exact helper to execute handover while still refusing all
/// other runtime descendants.
static ACTIVE_HELPER_PID: AtomicI32 = AtomicI32::new(0);

#[cfg(unix)]
pub(crate) fn is_active_helper(pid: i32) -> bool {
    pid > 0 && ACTIVE_HELPER_PID.load(Ordering::Acquire) == pid
}

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::machine::MachineAccess;
use super::protocol::RpcError;
use crate::sink::EventSink;

/// The record's name in the data directory's `run/`.
pub const STATUS_FILE: &str = "machine-update.json";

/// Emitted on the runtime's event stream when another computer asks the
/// window on this machine to update the app: `{ version }`.
pub const REQUESTED_EVENT: &str = "machine_update_requested";

/// The notification to `machine/3` connections: `{ status }`.
pub const CHANGED: &str = "machine.updateChanged";

/// A release check is reused this long unless `refresh` asks for one now.
pub const CHECK_EVERY: Duration = Duration::from_secs(10 * 60);

/// A helper phase written before the helper started says nothing of a
/// helper; after this long without one, the helper never ran.
const HELPER_START_GRACE_MS: i64 = 60_000;

/// An app update that has not reported anything for this long is not going
/// on: the window was closed, or the app did not come back.
const APP_PATIENCE_MS: i64 = 30 * 60_000;

/// How a machine updates (`MachineUpdateMethod`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Method {
    Installer,
    App,
    Unmanaged,
}

/// Work a handover cannot carry (`MachineUpdateBlocker`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Blocker {
    pub id: String,
    pub kind: String,
    pub title: String,
}

impl Blocker {
    /// One entry of `runtime.handover.plan`'s `unadoptable`. Its `id` names
    /// it in `machine.update`'s `stop`; the helper names the same work the
    /// same way when it hands over.
    pub fn of(work: &Value) -> Self {
        let text = |name: &str| work[name].as_str().filter(|value| !value.is_empty());
        let kind = text("kind").unwrap_or("work").to_string();
        let id = match (text("sessionId"), text("tabId"), text("pane")) {
            (Some(session), Some(tab), _) => format!("tab:{session}/{tab}"),
            (_, _, Some(pane)) => format!("pane:{pane}"),
            _ => format!("{kind}:{}", text("title").unwrap_or_default()),
        };
        let title = text("title").map(str::to_string).unwrap_or_else(|| match (text("harness"), text("tabId")) {
            (Some(harness), Some(tab)) => format!("{harness} in tab {tab}"),
            _ => kind.clone(),
        });
        Self { id, kind, title }
    }
}

/// Another paired computer connected now (`MachineUpdateOtherComputer`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct OtherComputer {
    pub id: String,
    pub label: String,
}

/// `MachineUpdateProgress`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "phase", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Progress {
    #[default]
    Idle,
    Downloading { version: String, since: i64 },
    Verifying { version: String, since: i64 },
    Trial { version: String, since: i64 },
    HandingOver { version: String, since: i64 },
    CleaningUp { version: String, since: i64 },
    AppUpdating { version: Option<String>, since: i64, step: Option<String> },
    Updated { from: String, to: String, at: i64 },
    Failed { version: String, at: i64, message: String, running: String, rolled_back: bool },
}

impl Progress {
    /// An update runs now: `machine.update` is `update_busy`.
    pub fn under_way(&self) -> bool {
        self.helper_phase().is_some() || matches!(self, Self::AppUpdating { .. })
    }

    /// The version and start of a phase the helper runs.
    fn helper_phase(&self) -> Option<(&str, i64)> {
        match self {
            Self::Downloading { version, since } | Self::Verifying { version, since } | Self::Trial { version, since } | Self::HandingOver { version, since } | Self::CleaningUp { version, since } => {
                Some((version.as_str(), *since))
            }
            _ => None,
        }
    }
}

/// What `<data>/run/machine-update.json` holds.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    #[serde(default)]
    pub progress: Progress,
    /// The version that ran when the update began.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// The helper running the phase in `progress`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub helper_pid: Option<u32>,
    /// What the app's own updater offers, as the window last said (`app`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_available: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_checked_at: Option<i64>,
}

/// `MachineUpdateStatus`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub method: Method,
    pub current: String,
    pub available: Option<Available>,
    pub checked_at: Option<i64>,
    pub blockers: Vec<Blocker>,
    pub other_computers: Vec<OtherComputer>,
    pub kept: Vec<String>,
    pub progress: Progress,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Available {
    pub version: String,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// The version this process runs.
pub fn own_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// `<data>/run/machine-update.json`.
pub fn status_path(data: &Path) -> PathBuf {
    data.join("run").join(STATUS_FILE)
}

/// The record at `path`; none (idle) when there is none or it cannot be read.
pub fn read_record(path: &Path) -> Record {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            log::warn!("machine update: {} is not readable ({error}); it is read as idle", path.display());
            Record::default()
        }),
        Err(_) => Record::default(),
    }
}

/// Replace the record at `path` in one rename, readable by this user only.
pub fn write_record(path: &Path, record: &Record) -> Result<()> {
    let parent = path.parent().context("the update record has no folder")?;
    std::fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))?;
    let mut staged = tempfile::Builder::new().prefix(".machine-update.").tempfile_in(parent).context("stage the update record")?;
    #[cfg(unix)]
    staged.as_file().set_permissions(std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    std::io::Write::write_all(&mut staged, &serde_json::to_vec_pretty(record)?)?;
    staged.as_file().sync_all()?;
    staged.persist(path).map_err(|error| error.error).with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

/// Whether process `pid` (a helper) exists.
pub fn helper_alive(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let Ok(pid) = libc::pid_t::try_from(pid) else { return false };
        // SAFETY: signal zero only checks that the process exists.
        let signalled = unsafe { libc::kill(pid, 0) } == 0;
        signalled || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        true
    }
}

/// `record` as it stands for a runtime that runs `running` at `now`: a
/// helper that is gone or never started, and an app update that came back
/// or went quiet, are settled. Whether anything changed.
pub fn settle(record: &mut Record, running: &str, now: i64, helper_alive: impl Fn(u32) -> bool) -> bool {
    let settled = match &record.progress {
        Progress::Downloading { .. } | Progress::Verifying { .. } | Progress::Trial { .. } | Progress::HandingOver { .. } | Progress::CleaningUp { .. } => {
            let (version, since) = record.progress.helper_phase().expect("a helper phase");
            let gone = match record.helper_pid {
                Some(pid) => !helper_alive(pid),
                None => now - since > HELPER_START_GRACE_MS,
            };
            if !gone {
                return false;
            }
            if version == running {
                Progress::Updated { from: record.from.clone().unwrap_or_else(|| running.to_string()), to: running.to_string(), at: now }
            } else {
                Progress::Failed {
                    version: version.to_string(),
                    at: now,
                    message: format!("The update to {version} stopped before it finished; TerminalX {running} is running."),
                    running: running.to_string(),
                    rolled_back: false,
                }
            }
        }
        Progress::AppUpdating { version, since, .. } => {
            let from = record.from.as_deref();
            // The app came back on another version than it ran: it updated,
            // to whatever its updater installed.
            let came_back = match from {
                Some(from) => from != running,
                None => version.as_deref() == Some(running),
            };
            if came_back {
                Progress::Updated { from: from.unwrap_or_default().to_string(), to: running.to_string(), at: now }
            } else if now - since > APP_PATIENCE_MS {
                Progress::Failed {
                    version: version.clone().unwrap_or_else(|| running.to_string()),
                    at: now,
                    message: "The TerminalX app on this machine did not finish its update.".into(),
                    running: running.to_string(),
                    rolled_back: false,
                }
            } else {
                return false;
            }
        }
        _ => return false,
    };
    record.progress = settled;
    record.helper_pid = None;
    true
}

/// `runtime.machineUpdate.report`: the window's report of the app's own
/// updater run (`MachineAppUpdateReport`, plus `available`, the version the
/// app's updater offers once it has checked). Written to the record every
/// runtime of the data directory reads.
pub fn report(data: &Path, params: &Value) -> Result<Value> {
    let path = status_path(data);
    let mut record = read_record(&path);
    let phase = params["phase"].as_str().context("phase is required")?;
    let text = |name: &str| params[name].as_str().filter(|value| !value.is_empty()).map(str::to_string);
    let now = now_ms();
    let requested = match &record.progress {
        Progress::AppUpdating { version, since, .. } => Some((version.clone(), *since)),
        _ => None,
    };
    if let Some(available) = params.get("available") {
        record.app_available = available.as_str().filter(|value| !value.is_empty()).map(str::to_string);
        record.app_checked_at = Some(now);
    }
    match phase {
        "checking" | "downloading" | "installing" | "restarting" => {
            let (version, since) = requested.unwrap_or((record.app_available.clone(), now));
            // The version the app's updater found is the one it installs,
            // whatever the desktop that asked had in mind.
            let version = text("available").or(version);
            if record.from.is_none() || !matches!(record.progress, Progress::AppUpdating { .. }) {
                record.from = Some(own_version().to_string());
            }
            record.progress = Progress::AppUpdating { version, since, step: Some(text("step").unwrap_or_else(|| phase.to_string())) };
        }
        "upToDate" => {
            record.app_available = None;
            record.app_checked_at = Some(now);
            record.progress = Progress::Idle;
        }
        "failed" => {
            let version = requested.and_then(|(version, _)| version).or_else(|| record.app_available.clone()).unwrap_or_else(|| own_version().to_string());
            record.progress = Progress::Failed {
                version,
                at: now,
                message: text("message").unwrap_or_else(|| "The TerminalX app could not update.".into()),
                running: own_version().to_string(),
                rolled_back: false,
            };
        }
        other => anyhow::bail!("unknown app update phase {other:?}"),
    }
    record.helper_pid = None;
    write_record(&path, &record)?;
    Ok(json!({ "progress": record.progress }))
}

/// Where this runtime lives and how it finds what it reports.
pub struct Environment {
    /// The runtime's data directory (`TERMINALX_HOME`).
    pub data_dir: PathBuf,
    /// `~/.terminalx`, the installer's root, when there is a home.
    pub install_root: Option<PathBuf>,
    /// A desktop app started this runtime (`TERMINALX_LOCAL_DESKTOP`).
    pub has_window: bool,
    /// The binary that runs the helper: this runtime's own.
    pub helper: Option<PathBuf>,
    /// What a handover could not carry now.
    pub blockers: fn() -> Vec<Blocker>,
    /// The newest signed release newer than the installed one (network).
    pub check: fn(&semver::Version) -> Result<Option<semver::Version>>,
}

impl Environment {
    /// This process's runtime.
    pub fn of_this_runtime(has_window: bool) -> Result<Self> {
        Ok(Self {
            data_dir: crate::store::root().context("the runtime's data directory")?,
            install_root: crate::serve_cli::install_root().ok(),
            has_window,
            helper: std::env::current_exe().ok(),
            blockers: handover_blockers,
            check: crate::serve_cli::update::newer_release,
        })
    }

    fn status_path(&self) -> PathBuf {
        status_path(&self.data_dir)
    }

    /// The version the installer's `current` names, when this is an install.
    fn installed(&self) -> Option<semver::Version> {
        self.install_root.as_deref().and_then(|root| crate::serve_cli::update::installed_version(root).ok())
    }
}

/// What `runtime.handover.plan` would name now.
fn handover_blockers() -> Vec<Blocker> {
    #[cfg(unix)]
    {
        crate::local_runtime::handover::unadoptable().iter().map(Blocker::of).collect()
    }
    #[cfg(not(unix))]
    {
        Vec::new()
    }
}

#[derive(Default)]
struct Check {
    available: Option<semver::Version>,
    checked_at: Option<i64>,
    checking: bool,
}

/// A machine's `machine/3`: its status, and starting an update.
pub struct MachineUpdates {
    env: Environment,
    sink: Arc<dyn EventSink>,
    check: Arc<Mutex<Check>>,
    /// One `machine.update` at a time decides and starts.
    starting: Mutex<()>,
    /// Raised when something this module changed may change the status.
    pub changed: Arc<tokio::sync::Notify>,
}

impl MachineUpdates {
    pub fn new(env: Environment, sink: Arc<dyn EventSink>) -> Self {
        Self { env, sink, check: Arc::default(), starting: Mutex::new(()), changed: Arc::new(tokio::sync::Notify::new()) }
    }

    pub fn method(&self) -> Method {
        if self.env.has_window {
            Method::App
        } else if self.env.installed().is_some() {
            Method::Installer
        } else {
            Method::Unmanaged
        }
    }

    /// The record, settled for this runtime (and written back when it was).
    fn record(&self) -> Record {
        let path = self.env.status_path();
        let mut record = read_record(&path);
        if settle(&mut record, own_version(), now_ms(), helper_alive) {
            if let Err(error) = write_record(&path, &record) {
                log::warn!("machine update: keep the settled update record: {error:#}");
            }
        }
        record
    }

    /// Versions on disk, newest first.
    fn kept(&self, method: Method) -> Vec<String> {
        match (method, self.env.install_root.as_deref()) {
            (Method::Installer, Some(root)) => crate::serve_cli::update::versions_on_disk(root).iter().map(ToString::to_string).collect(),
            _ => vec![own_version().to_string()],
        }
    }

    /// The status as `caller` (a connection's device id) sees it: the other
    /// computers are everyone connected but the caller.
    pub fn status(&self, caller: Option<&str>, access: Option<&dyn MachineAccess>) -> Status {
        self.status_of(self.record(), caller, access)
    }

    fn status_of(&self, record: Record, caller: Option<&str>, access: Option<&dyn MachineAccess>) -> Status {
        let method = self.method();
        let (available, checked_at) = match method {
            Method::Installer => {
                let check = self.check.lock().unwrap();
                (check.available.as_ref().map(|version| Available { version: version.to_string() }), check.checked_at)
            }
            Method::App => (record.app_available.clone().map(|version| Available { version }), record.app_checked_at),
            Method::Unmanaged => (None, None),
        };
        Status {
            method,
            current: own_version().to_string(),
            available,
            checked_at,
            blockers: (self.env.blockers)(),
            other_computers: access.map(|access| access.other_computers(caller)).unwrap_or_default(),
            kept: self.kept(method),
            progress: record.progress,
        }
    }

    /// Check for a newer signed release now (blocking: the network).
    fn check_now(&self) -> Result<(), RpcError> {
        let Some(installed) = self.env.installed() else { return Ok(()) };
        self.check.lock().unwrap().checking = true;
        let found = (self.env.check)(&installed);
        let mut check = self.check.lock().unwrap();
        check.checking = false;
        match found {
            Ok(available) => {
                check.available = available;
                check.checked_at = Some(now_ms());
                Ok(())
            }
            Err(error) => Err(RpcError::new("unavailable", format!("could not check for a newer TerminalX runtime: {error:#}"))),
        }
    }

    /// A check in the background when the last one is older than
    /// [`CHECK_EVERY`]; the status goes out again when it ends.
    fn check_if_stale(self: &Arc<Self>) {
        if self.method() != Method::Installer {
            return;
        }
        {
            let mut check = self.check.lock().unwrap();
            let fresh = check.checked_at.is_some_and(|at| now_ms() - at < CHECK_EVERY.as_millis() as i64);
            if fresh || check.checking {
                return;
            }
            check.checking = true;
        }
        let updates = self.clone();
        let spawned = std::thread::Builder::new().name("machine-update-check".into()).spawn(move || {
            if let Err(error) = updates.check_now() {
                log::info!("machine update: {}", error.message);
                updates.check.lock().unwrap().checked_at = Some(now_ms());
            }
            updates.changed.notify_one();
        });
        if spawned.is_err() {
            self.check.lock().unwrap().checking = false;
        }
    }

    /// `machine.updateStatus` `{ refresh? }`. Blocking.
    pub fn update_status(self: &Arc<Self>, params: &Value, caller: &str, access: Option<&dyn MachineAccess>) -> Result<Value, RpcError> {
        if params["refresh"].as_bool() == Some(true) && self.method() == Method::Installer {
            self.check_now()?;
            self.changed.notify_one();
        } else {
            self.check_if_stale();
        }
        Ok(json!(self.status(Some(caller), access)))
    }

    /// `machine.update` `{ version, stop?, confirmedOthers? }`. Blocking.
    /// `confirmedOthers` names the other computers the person was shown;
    /// one connected since, and not named, refuses again with `update_confirm`.
    pub fn update(&self, params: &Value, caller: &str, access: Option<&dyn MachineAccess>) -> Result<Value, RpcError> {
        let version = params["version"].as_str().map(str::trim).filter(|version| !version.is_empty()).ok_or_else(|| RpcError::invalid("version is required"))?.to_string();
        let stop: Vec<String> = match params.get("stop") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(ids)) => ids.iter().map(|id| id.as_str().map(str::to_string).ok_or_else(|| RpcError::invalid("stop lists blocker ids"))).collect::<Result<_, _>>()?,
            Some(_) => return Err(RpcError::invalid("stop lists blocker ids")),
        };
        let confirmed_others: Vec<String> = match params.get("confirmedOthers") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(ids)) => ids.iter().map(|id| id.as_str().map(str::to_string).ok_or_else(|| RpcError::invalid("confirmedOthers lists computer ids"))).collect::<Result<_, _>>()?,
            Some(_) => return Err(RpcError::invalid("confirmedOthers lists computer ids")),
        };
        let _starting = self.starting.lock().unwrap();
        let record = self.record();
        let status = self.status_of(record.clone(), Some(caller), access);
        let refused = |code: &'static str, message: String, status: &Status| RpcError::new(code, message).with_data(json!(status));
        if status.progress.under_way() {
            return Err(refused("update_busy", "An update of this machine is under way.".into(), &status));
        }
        match status.method {
            Method::Unmanaged => {
                return Err(refused(
                    "update_unavailable",
                    format!("TerminalX {} on this machine was not installed by the TerminalX installer or started by the TerminalX app; update it the way it was installed.", own_version()),
                    &status,
                ))
            }
            Method::App if !access.is_some_and(|access| access.window_available()) => {
                return Err(refused("update_unavailable", "The TerminalX app on this machine is not running, so it cannot update itself now.".into(), &status));
            }
            Method::App => {}
            Method::Installer => {
                let wanted = semver::Version::parse(&version).map_err(|_| RpcError::invalid(format!("{version} is not a version")))?;
                if self.check.lock().unwrap().checked_at.is_none() {
                    self.check_now()?;
                }
                let offered = self.check.lock().unwrap().available.clone();
                if offered.as_ref() != Some(&wanted) {
                    let said = offered.map_or_else(|| "none is newer than the installed one".to_string(), |offered| format!("the newest is {offered}"));
                    return Err(refused("update_unavailable", format!("TerminalX {wanted} is not a signed runtime release this machine can update to ({said})."), &self.status_of(record.clone(), Some(caller), access)));
                }
            }
        }
        let unagreed: Vec<&str> = status.blockers.iter().filter(|blocker| !stop.contains(&blocker.id)).map(|blocker| blocker.title.as_str()).collect();
        if !unagreed.is_empty() {
            return Err(refused("update_confirm", format!("Updating stops work the update cannot carry over: {}.", unagreed.join("; ")), &status));
        }
        let unnamed: Vec<&str> = status.other_computers.iter().filter(|computer| !confirmed_others.contains(&computer.id)).map(|computer| computer.label.as_str()).collect();
        if !unnamed.is_empty() {
            let named = unnamed;
            return Err(refused("update_confirm", format!("Other computers are connected to this machine: {}.", named.join(", ")), &status));
        }
        let agreed: Vec<String> = status.blockers.iter().filter(|blocker| stop.contains(&blocker.id)).map(|blocker| blocker.id.clone()).collect();
        let path = self.env.status_path();
        let now = now_ms();
        let started = Record { from: Some(own_version().to_string()), helper_pid: None, ..record };
        match status.method {
            Method::Installer => {
                write_record(&path, &Record { progress: Progress::Downloading { version: version.clone(), since: now }, ..started.clone() }).map_err(RpcError::internal)?;
                if let Err(error) = self.start_helper(&version, &agreed) {
                    let failed = Progress::Failed { version: version.clone(), at: now_ms(), message: format!("The update could not start: {error:#}"), running: own_version().to_string(), rolled_back: false };
                    let _ = write_record(&path, &Record { progress: failed, ..started });
                    self.changed.notify_one();
                    return Err(RpcError::internal(error));
                }
            }
            Method::App => {
                write_record(&path, &Record { progress: Progress::AppUpdating { version: Some(version.clone()), since: now, step: None }, ..started }).map_err(RpcError::internal)?;
                self.sink.emit(REQUESTED_EVENT, &json!({ "version": version }));
            }
            Method::Unmanaged => unreachable!("refused above"),
        }
        self.changed.notify_one();
        Ok(json!(self.status(Some(caller), access)))
    }

    /// `terminalx-serve update --apply <version> --status <file>`, in a
    /// session of its own so neither the handover's exec nor the service
    /// manager stopping this process ends it.
    fn start_helper(&self, version: &str, stop: &[String]) -> Result<()> {
        let helper = self.env.helper.as_deref().context("this runtime cannot tell where its own binary is")?;
        let log = std::fs::OpenOptions::new().create(true).append(true).open(self.env.data_dir.join("run").join("machine-update.log")).context("open the update log")?;
        let mut command = std::process::Command::new(helper);
        command
            .arg("update")
            .arg("--apply")
            .arg(version)
            .arg("--status")
            .arg(self.env.status_path())
            .arg("--data-dir")
            .arg(&self.env.data_dir)
            .stdin(std::process::Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log);
        for id in stop {
            command.arg("--stop").arg(id);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // SAFETY: setsid is async-signal-safe and touches nothing else.
            unsafe {
                command.pre_exec(|| {
                    if libc::setsid() < 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
        }
        let mut child = command.spawn().with_context(|| format!("start {}", helper.display()))?;
        let helper_pid = child.id() as i32;
        ACTIVE_HELPER_PID.store(helper_pid, Ordering::Release);
        log::info!("machine update: updating to {version} in helper pid {}", child.id());
        // Reaped here until a handover; the runtime that takes over reaps it then.
        std::thread::Builder::new().name("machine-update-helper".into()).spawn(move || {
            let _ = child.wait();
            let _ = ACTIVE_HELPER_PID.compare_exchange(helper_pid, 0, Ordering::Release, Ordering::Relaxed);
        })?;
        Ok(())
    }

    /// What `machine.updateChanged` compares: the status as nobody in
    /// particular sees it.
    pub fn fingerprint(&self, access: Option<&dyn MachineAccess>) -> String {
        serde_json::to_string(&self.status(None, access)).unwrap_or_default()
    }

    #[cfg(test)]
    pub(crate) fn offer_for_tests(&self, available: Option<&str>) {
        let mut check = self.check.lock().unwrap();
        check.available = available.map(|version| semver::Version::parse(version).unwrap());
        check.checked_at = Some(now_ms());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_serialises_as_the_desktop_reads_it() {
        assert_eq!(json!(Progress::Idle), json!({ "phase": "idle" }));
        assert_eq!(json!(Progress::HandingOver { version: "0.2.35".into(), since: 5 }), json!({ "phase": "handingOver", "version": "0.2.35", "since": 5 }));
        assert_eq!(json!(Progress::AppUpdating { version: None, since: 1, step: Some("installing".into()) }), json!({ "phase": "appUpdating", "version": null, "since": 1, "step": "installing" }));
        assert_eq!(
            json!(Progress::Failed { version: "0.2.35".into(), at: 9, message: "m".into(), running: "0.2.33".into(), rolled_back: true }),
            json!({ "phase": "failed", "version": "0.2.35", "at": 9, "message": "m", "running": "0.2.33", "rolledBack": true })
        );
        assert_eq!(json!(Progress::Updated { from: "a".into(), to: "b".into(), at: 3 }), json!({ "phase": "updated", "from": "a", "to": "b", "at": 3 }));
        assert_eq!(json!(Method::Unmanaged), json!("unmanaged"));
    }

    #[test]
    fn blockers_are_named_as_the_helper_names_them() {
        let agent = Blocker::of(&json!({ "kind": "turn", "sessionId": "s1", "tabId": "t1", "harness": "claude" }));
        assert_eq!(agent, Blocker { id: "tab:s1/t1".into(), kind: "turn".into(), title: "claude in tab t1".into() });
        let terminal = Blocker::of(&json!({ "kind": "terminal", "pane": "s1:1", "title": "make" }));
        assert_eq!((terminal.id.as_str(), terminal.title.as_str()), ("pane:s1:1", "make"));
        let vm = Blocker::of(&json!({ "kind": "localVm", "title": "Provisioning ubuntu" }));
        assert_eq!(vm.id, "localVm:Provisioning ubuntu");
    }

    #[test]
    fn a_helper_that_is_gone_settles_as_failed_unless_its_version_runs() {
        let running = own_version();
        let mut record = Record { progress: Progress::Trial { version: "99.0.0".into(), since: 0 }, from: Some(running.into()), helper_pid: Some(7), ..Record::default() };
        assert!(!settle(&mut record, running, 10, |_| true), "a live helper is left alone");
        assert!(settle(&mut record, running, 10, |_| false));
        assert!(matches!(&record.progress, Progress::Failed { version, running: now, rolled_back: false, .. } if version == "99.0.0" && now == running), "{record:?}");
        let mut handed = Record { progress: Progress::CleaningUp { version: running.into(), since: 0 }, from: Some("0.0.1".into()), helper_pid: Some(7), ..Record::default() };
        assert!(settle(&mut handed, running, 10, |_| false));
        assert_eq!(handed.progress, Progress::Updated { from: "0.0.1".into(), to: running.into(), at: 10 });
        // Written by the runtime before the helper started: given a minute.
        let mut waiting = Record { progress: Progress::Downloading { version: "99.0.0".into(), since: 0 }, ..Record::default() };
        assert!(!settle(&mut waiting, running, HELPER_START_GRACE_MS, |_| false));
        assert!(settle(&mut waiting, running, HELPER_START_GRACE_MS + 1, |_| false));
    }

    #[test]
    fn an_app_update_ends_when_the_new_version_runs_or_goes_quiet() {
        let mut record = Record { progress: Progress::AppUpdating { version: Some("0.3.0".into()), since: 0, step: None }, from: Some("0.2.0".into()), ..Record::default() };
        assert!(!settle(&mut record.clone(), "0.2.0", 1, |_| true));
        assert!(settle(&mut record, "0.3.0", 5, |_| true));
        assert_eq!(record.progress, Progress::Updated { from: "0.2.0".into(), to: "0.3.0".into(), at: 5 });
        // The app's updater installed another version than the one asked for: still updated.
        let mut other = Record { progress: Progress::AppUpdating { version: Some("0.3.0".into()), since: 0, step: None }, from: Some("0.2.0".into()), ..Record::default() };
        assert!(settle(&mut other, "0.3.1", 5, |_| true));
        assert_eq!(other.progress, Progress::Updated { from: "0.2.0".into(), to: "0.3.1".into(), at: 5 });
        let mut quiet = Record { progress: Progress::AppUpdating { version: Some("0.3.0".into()), since: 0, step: None }, from: Some("0.2.0".into()), ..Record::default() };
        assert!(settle(&mut quiet, "0.2.0", APP_PATIENCE_MS + 1, |_| true));
        assert!(matches!(quiet.progress, Progress::Failed { rolled_back: false, .. }));
    }

    #[test]
    fn the_windows_reports_become_the_record() {
        let dir = tempfile::tempdir().unwrap();
        let path = status_path(dir.path());
        write_record(&path, &Record { progress: Progress::AppUpdating { version: Some("0.3.0".into()), since: 4, step: None }, from: Some("0.2.0".into()), ..Record::default() }).unwrap();
        report(dir.path(), &json!({ "phase": "downloading", "step": "12 MB of 80 MB" })).unwrap();
        assert_eq!(read_record(&path).progress, Progress::AppUpdating { version: Some("0.3.0".into()), since: 4, step: Some("12 MB of 80 MB".into()) });
        // The window names what its updater found: that is the version it installs.
        report(dir.path(), &json!({ "phase": "installing", "step": "0.3.1", "available": "0.3.1" })).unwrap();
        assert_eq!(read_record(&path).progress, Progress::AppUpdating { version: Some("0.3.1".into()), since: 4, step: Some("0.3.1".into()) });
        report(dir.path(), &json!({ "phase": "failed", "message": "no disk space" })).unwrap();
        assert!(matches!(read_record(&path).progress, Progress::Failed { ref version, ref message, .. } if version == "0.3.1" && message == "no disk space"));
        report(dir.path(), &json!({ "phase": "upToDate", "available": null })).unwrap();
        let record = read_record(&path);
        assert_eq!((record.progress, record.app_available), (Progress::Idle, None));
        assert!(record.app_checked_at.is_some());
        assert!(report(dir.path(), &json!({ "phase": "flying" })).is_err());
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&std::fs::metadata(&path).unwrap().permissions()) & 0o777, 0o600, "owner only");
    }
}
