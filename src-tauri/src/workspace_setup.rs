//! Local, explicitly configured setup hooks. Only the project store is trusted.
//! A bounded worker queue runs at most two scripts per runtime. Session creation
//! records an attempt, then proceeds independently of its launch or result.

use std::{collections::HashMap, path::Path, sync::{Arc, OnceLock, atomic::{AtomicBool, Ordering}, mpsc}, time::Duration};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use crate::{archive_script::{self, Runner, ScriptRun}, session::SessionManager, store};
use crate::store::index::SessionEntry;

const EVENT: &str = "workspace_setup_changed";
const TIMEOUT: Duration = Duration::from_secs(30 * 60);
const MAX_CONCURRENT: usize = 2;
static RUN_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Setup {
    pub session_id: String,
    pub pane_id: String,
    pub command: String,
    pub status: Status,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    #[serde(default, skip_serializing)]
    log: String,
    #[serde(default)]
    pub has_pane: bool,
    // Old PRO-240 snapshots could contain an untrusted repository-file command.
    // Never resume one of those, even if its status was pending.
    #[serde(default)]
    local_script: bool,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Status { Pending, Running, Stopping, Stopped, Succeeded, Failed }
impl Status {
    fn active(self) -> bool { matches!(self, Self::Pending | Self::Running | Self::Stopping) }
}

struct Job { manager: SessionManager, session: String, pane: String, cancel: Arc<AtomicBool>, timeout: Duration }
#[derive(Clone)]
struct Control { pane: String, cancel: Arc<AtomicBool> }
fn controls() -> &'static parking_lot::Mutex<HashMap<String, Control>> {
    static CONTROLS: OnceLock<parking_lot::Mutex<HashMap<String, Control>>> = OnceLock::new();
    CONTROLS.get_or_init(Default::default)
}
fn workers() -> &'static mpsc::Sender<Job> {
    static QUEUE: OnceLock<mpsc::Sender<Job>> = OnceLock::new();
    QUEUE.get_or_init(|| {
        let (send, receive) = mpsc::channel::<Job>();
        let receive = Arc::new(parking_lot::Mutex::new(receive));
        for _ in 0..MAX_CONCURRENT {
            let receive = receive.clone();
            std::thread::spawn(move || loop {
                let job = { receive.lock().recv() };
                let Ok(job) = job else { break };
                execute(job);
            });
        }
        send
    })
}

fn path(session: &str) -> Result<std::path::PathBuf> {
    Ok(store::sessions_dir()?.join(session).join("workspace-setup.json"))
}
fn read(session: &str) -> Result<Option<Setup>> { store::read_json(&path(session)?) }

#[cfg(test)]
thread_local! {
    /// Lets a test stand in for a status file that cannot be written once the
    /// session's index entry exists (its folder is named by the new id).
    pub(crate) static SAVE_FAILS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn save(setup: &Setup) -> Result<()> {
    #[cfg(test)]
    if SAVE_FAILS.with(|fails| fails.get()) { anyhow::bail!("setup status could not be written"); }
    let mut value = serde_json::to_value(setup)?;
    value["log"] = json!(setup.log);
    store::session_dir(&setup.session_id)?;
    store::write_json(&path(&setup.session_id)?, &value)
}
fn publish(manager: &SessionManager, setup: &Setup) -> Result<()> {
    save(setup)?;
    manager.sink().emit(EVENT, setup);
    Ok(())
}
fn script(entry: &SessionEntry) -> Result<Option<String>> {
    let command = store::projects::scripts(Path::new(&entry.project_path))?.setup;
    Ok((!command.trim().is_empty()).then_some(command))
}
fn attempt(entry: &SessionEntry, command: String) -> Setup {
    Setup { session_id: entry.id.clone(), pane_id: format!("{}:workspace-setup-{}", entry.id, uuid::Uuid::now_v7()),
        command, status: Status::Pending, exit_code: None, error: None, log: String::new(), has_pane: false, local_script: true }
}

/// Called only after a new worktree (including its configured file copies) and
/// index entry exist. The caller logs persistence failure without failing creation.
pub fn prepare(entry: &SessionEntry) -> Result<()> {
    if entry.worktree_name.is_none() { return Ok(()) }
    if let Some(command) = script(entry)? { save(&attempt(entry, command))?; }
    Ok(())
}

pub fn start(manager: &SessionManager, session: &str, rerun: bool) -> Result<Option<Setup>> {
    schedule(manager, session, rerun, TIMEOUT)
}
fn schedule(manager: &SessionManager, session: &str, rerun: bool, timeout: Duration) -> Result<Option<Setup>> {
    let _admission = crate::issue_pipeline::admission::lock();
    manager.accepting_work()?;
    crate::issue_pipeline::admission::open(session, None)?;
    let entry = store::index::get(session)?;
    let _run = RUN_LOCK.lock();
    let previous = read(session)?;
    if controls().lock().contains_key(session) { bail!("Setup is already queued or running"); }
    if !rerun && !previous.as_ref().is_some_and(|setup| setup.local_script && setup.status == Status::Pending) {
        return Ok(previous);
    }
    if entry.worktree_removed || entry.worktree_name.is_none() || entry.cwd == entry.project_path {
        bail!("The setup workspace is no longer available");
    }
    // Read local settings again. Neither an old snapshot nor a git pull can
    // choose code to run, including after an owner restart or on explicit Rerun.
    let command = script(&entry)?.context("Save a setup script in this repository's Scripts settings first")?;
    if let Some(previous) = &previous {
        if manager.terminals().is_running(&previous.pane_id) { bail!("Stop the previous setup before rerunning it"); }
        if !previous.pane_id.is_empty() { manager.terminals().kill(&previous.pane_id); }
    }
    let mut setup = attempt(&entry, command);
    publish(manager, &setup)?;
    let cancel = Arc::new(AtomicBool::new(false));
    controls().lock().insert(session.into(), Control { pane: setup.pane_id.clone(), cancel: cancel.clone() });
    if workers().send(Job { manager: manager.clone(), session: session.into(), pane: setup.pane_id.clone(), cancel, timeout }).is_err() {
        controls().lock().remove(session);
        setup.status = Status::Failed;
        setup.error = Some("The setup worker is unavailable".into());
        publish(manager, &setup)?;
        bail!("The setup worker is unavailable");
    }
    Ok(Some(setup))
}

fn execute(job: Job) {
    let result = (|| -> Result<Option<archive_script::ScriptResult>> {
        let runner = Runner { terminals: job.manager.terminals(), sink: job.manager.sink(), unattended: false };
        let run = {
            // Serialize stop/removal with launch, then release admission for
            // the entire script duration so agents can work alongside setup.
            let _admission = crate::issue_pipeline::admission::lock();
            let _run = RUN_LOCK.lock();
            job.manager.accepting_work()?;
            crate::issue_pipeline::admission::open(&job.session, None)?;
            let entry = store::index::get(&job.session)?;
            let Some(mut setup) = read(&job.session)? else { return Ok(None) };
            if setup.pane_id != job.pane || setup.status != Status::Pending || job.cancel.load(Ordering::Acquire) { return Ok(None) }
            if entry.worktree_removed || entry.worktree_name.is_none() { bail!("The setup workspace is no longer available"); }
            // A queued run is invalidated when the person changes/clears its script.
            if script(&entry)?.as_deref() != Some(setup.command.as_str()) { bail!("The saved setup script changed while queued. Rerun to use the current script."); }
            let env = archive_script::environment(Path::new(&entry.project_path), Path::new(&entry.cwd), Some(&entry));
            // Record the claim before executing; failure/restart never repeats it.
            setup.status = Status::Running;
            publish(&job.manager, &setup)?;
            let run = ScriptRun::spawn(runner, &job.pane, Path::new(&entry.cwd), &setup.command, &env, &|| {})?;
            setup.has_pane = true;
            publish(&job.manager, &setup)?;
            run
        };
        run.wait(job.timeout, &job.cancel).map(Some)
    })();
    let _run = RUN_LOCK.lock();
    {
        let mut active = controls().lock();
        if active.get(&job.session).is_some_and(|control| control.pane == job.pane) { active.remove(&job.session); }
    }
    if store::index::get(&job.session).is_err() { return }
    let settled = (|| -> Result<()> {
        let Some(mut setup) = read(&job.session)? else { return Ok(()) };
        if setup.pane_id != job.pane || !setup.status.active() { return Ok(()) }
        setup.has_pane = job.manager.terminals().shell(&job.pane).is_some();
        setup.log = archive_script::output_tail(job.manager.terminals(), &job.pane);
        match result {
            Ok(Some(result)) => {
                setup.exit_code = result.code;
                setup.log = result.log;
                setup.status = if result.stopped { Status::Stopped } else if result.code == Some(0) { Status::Succeeded } else { Status::Failed };
                if result.timed_out { setup.error = Some("Setup timed out after 30 minutes. Rerun to try again.".into()); }
            }
            Ok(None) => { setup.status = Status::Stopped; }
            Err(error) => { setup.status = Status::Failed; setup.error = Some(format!("{error:#}")); }
        }
        publish(&job.manager, &setup)
    })();
    if let Err(error) = settled { log::warn!("Save workspace setup result: {error:#}"); }
}

pub fn stop(manager: &SessionManager, session: &str, pane: &str) -> Result<Option<Setup>> {
    let _run = RUN_LOCK.lock();
    store::index::get(session)?;
    let Some(mut setup) = read(session)? else { return Ok(None) };
    if setup.pane_id != pane { bail!("Setup has been rerun. Stop the current attempt instead."); }
    if !setup.status.active() { return Ok(Some(setup)) }
    let control = controls().lock().get(session).cloned().context("Setup was interrupted. Reopen the workspace to see its result.")?;
    if control.pane != pane { bail!("Setup has been rerun. Stop the current attempt instead."); }
    control.cancel.store(true, Ordering::Release);
    setup.status = if setup.status == Status::Pending { Status::Stopped } else { Status::Stopping };
    if setup.status == Status::Stopped { controls().lock().remove(session); }
    publish(manager, &setup)?;
    Ok(Some(setup))
}

pub fn list(manager: &SessionManager) -> Result<Vec<Setup>> {
    let _run = RUN_LOCK.lock();
    let mut setups = Vec::new();
    for entry in store::index::load()? {
        if let Some(mut setup) = read(&entry.id)? {
            setup.has_pane = manager.terminals().shell(&setup.pane_id).is_some();
            setups.push(setup);
        }
    }
    Ok(setups)
}

pub fn log(manager: &SessionManager, session: &str, pane: &str) -> Result<String> {
    let _run = RUN_LOCK.lock();
    store::index::get(session)?;
    let setup = read(session)?.context("This workspace has no setup run")?;
    if setup.pane_id != pane { bail!("Setup has been rerun. Open the current log and try again."); }
    let output = if manager.terminals().shell(pane).is_some() { archive_script::output_tail(manager.terminals(), pane) } else { setup.log };
    Ok(format!("$ {}\n{}{}", setup.command, output, setup.error.map(|error| format!("\n{error}")).unwrap_or_default()))
}

pub fn follow_creations(manager: &SessionManager) {
    let owner = manager.clone();
    manager.sink().listen("session_created", Box::new(move |payload| {
        let Ok(entry) = serde_json::from_str::<SessionEntry>(payload) else { return };
        if entry.worktree_name.is_none() { return }
        let owner = owner.clone();
        // The event may be emitted under a caller's admission lock. This short
        // dispatch only queues work; the two workers own all script execution.
        std::thread::spawn(move || start_pending(&owner, &entry.id));
    }));
}

/// Called after terminals are restored/adopted, before serving new requests.
/// An interrupted run is stopped, never relaunched from its saved command.
pub fn recover(manager: &SessionManager) {
    let result = (|| -> Result<()> {
        for entry in store::index::load()? {
            let Some(mut setup) = read(&entry.id)? else { continue };
            if setup.status == Status::Pending && setup.local_script { start_pending(manager, &entry.id); continue }
            if setup.status.active() {
                manager.terminals().stop_keep_output(&setup.pane_id, Duration::from_secs(5));
                setup.log = archive_script::output_tail(manager.terminals(), &setup.pane_id);
                setup.status = Status::Failed;
                setup.error = Some("Setup was interrupted. Rerun to use the current local Scripts setting.".into());
                setup.has_pane = manager.terminals().shell(&setup.pane_id).is_some();
                publish(manager, &setup)?;
            }
        }
        Ok(())
    })();
    if let Err(error) = result { log::warn!("Recover workspace setup: {error:#}"); }
}

fn start_pending(manager: &SessionManager, session: &str) {
    if let Err(error) = start(manager, session, false) {
        log::warn!("Start workspace setup: {error:#}");
        let _run = RUN_LOCK.lock();
        if store::index::get(session).is_err() { return }
        if let Ok(Some(mut setup)) = read(session) {
            if setup.status == Status::Pending && !controls().lock().contains_key(session) {
                setup.status = Status::Failed;
                setup.error = Some(format!("{error:#}"));
                if let Err(error) = publish(manager, &setup) { log::warn!("Save setup launch failure: {error:#}"); }
            }
        }
    }
}

#[cfg(all(test, unix))]
#[path = "workspace_setup_tests.rs"]
mod tests;
