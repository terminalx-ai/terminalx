//! Local checks keep a detached, bounded recorder. An observation timeout or
//! host incident releases the coordinator, not the child, and never passes it.
use std::ffi::OsStr;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use super::{probe, Category, Evidence, Launch, Monitor, Phase, Snapshot, Ticket};

#[derive(Debug)]
pub struct ValidationHeld(pub String);
impl std::fmt::Display for ValidationHeld {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { output.write_str(&self.0) }
}
impl std::error::Error for ValidationHeld {}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Recorded { finished_at: i64, result: probe::Captured }

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LeaderExit { exit_code: Option<i32>, signal: Option<i32> }

pub(super) fn record(directory: &Path, cwd: &Path, command: &OsStr) -> Result<()> {
    let metadata = std::fs::symlink_metadata(directory)?;
    anyhow::ensure!(metadata.is_dir() && directory.file_name().and_then(|name| name.to_str()).is_some_and(|name| uuid::Uuid::parse_str(name).is_ok()), "invalid validation recorder directory");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions.
        anyhow::ensure!(metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o077 == 0, "validation recorder directory is not private");
    }
    let mut child = Command::new("/bin/sh");
    child.arg("-c").arg(command).current_dir(cwd);
    let result = probe::capture_with_exit(&mut child, |exit_code, signal| {
        if let Err(error) = crate::store::write_json(&directory.join("exit.json"), &LeaderExit { exit_code, signal }) {
            log::warn!("record validation leader exit: {error:#}");
        }
    });
    crate::store::write_json(&directory.join("validation.json"), &Recorded { finished_at: super::now(), result })
}

pub fn run_validation(pane: &str, pipeline: &str, cwd: &Path, command: &str) -> Result<()> {
    if validation_pending(pipeline)? { return Err(ValidationHeld("This pipeline still has a pending validation recorder. No duplicate check was started.".into()).into()); }
    if let Some(message) = super::validation_blocker(Some(pipeline))? { return Err(ValidationHeld(message).into()); }
    let directory = super::directory()?;
    let recorder = uuid::Uuid::new_v4().to_string();
    let path = crate::store::ensure_dir(directory.join(&recorder))?;
    let monitor = Arc::new(Monitor { directory: directory.clone() });
    // The configured command is passed as one argument, never interpolated
    // into a shell wrapper or written to the incident/export record.
    let mut process = Command::new(std::env::current_exe()?);
    process.arg("--startup-validation-recorder").arg(&path).arg(cwd).arg(command)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    { use std::os::unix::process::CommandExt; process.process_group(0); }
    let ticket = spawn_reserved(&monitor, pane, pipeline, &recorder, &path, &mut process)?;
    let started = Instant::now();
    loop {
        if let Some(recorded) = crate::store::read_json::<Recorded>(&path.join("validation.json"))? {
            ticket.exited(recorded.result.exit_code.and_then(|code| code.try_into().ok()));
            if recorded.result.exit_code == Some(0) && recorded.result.signal.is_none() && !recorded.result.spawn_failed { return Ok(()); }
            bail!("Local validation failed (exit {:?}, signal {:?}). Its bounded output and final result remain in the private startup recorder {}.", recorded.result.exit_code, recorded.result.signal, recorder);
        }
        if let Some(exit) = crate::store::read_json::<super::RecorderExit>(&path.join("owner-exit.json"))? {
            return Err(ValidationHeld(format!("Validation recorder owner outcome (exit {:?}, signal {:?}, failure {:?}) has no final child result. Descendant ownership remains unresolved; no duplicate check was started.", exit.exit_code, exit.signal, exit.failure)).into());
        }
        if let Some(message) = super::validation_blocker(Some(pipeline))? { return Err(ValidationHeld(message).into()); }
        if started.elapsed() >= Duration::from_secs(1800) {
            return Err(ValidationHeld(format!("Local validation observation exceeded 30 minutes. Recorder {recorder} is still pending; the child was not killed and no result was accepted.")).into());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn spawn_reserved(monitor: &Arc<Monitor>, pane: &str, pipeline: &str, recorder: &str, path: &Path, process: &mut Command) -> Result<Ticket> {
    // Ownership is one fallible transaction, never a best-effort progress
    // callback. No child can start without its durable pipeline reservation.
    let ticket = reserve(monitor, pane, pipeline, recorder)?;
    let child = match process.spawn() {
        Ok(child) => child,
        Err(error) => { super::recorder::spawn_failed(path, &error); ticket.exited(None); return Err(error.into()); }
    };
    ticket.spawned(Some(child.id()));
    // An owner exit is retained independently; it cannot certify that every
    // validation descendant exited or supply the missing final result.
    super::recorder::retain_recorder(child, path.to_path_buf());
    Ok(ticket)
}

fn reserve(monitor: &Arc<Monitor>, pane: &str, pipeline: &str, recorder: &str) -> Result<Ticket> {
    let id = super::update_at(&monitor.directory, |state| {
        refresh(&monitor.directory, state)?;
        if pending(state, pipeline) {
            return Err(ValidationHeld("This pipeline still has a pending validation recorder. No duplicate check was started.".into()).into());
        }
        if state.active().is_some() { return Err(ValidationHeld("A local startup incident still holds new validation.".into()).into()); }
        let id = uuid::Uuid::new_v4().to_string();
        let at = super::now();
        state.launches.push(Launch { id: id.clone(), pane: pane.into(), generation: recorder.into(), pid: None,
            category: Category::Validation, evidence: Evidence::Readiness, phase: Phase::Spawning,
            started_at: at, last_progress_at: at, exit_code: None, cpu_time: None, resident_bytes: None,
            pid_birth: None, recorder: Some(recorder.into()), pipeline_id: Some(pipeline.into()), recorder_owner: None, recorder_exit: None });
        Ok(id)
    })?;
    Ok(Ticket { monitor: monitor.clone(), id })
}

fn pending(state: &Snapshot, pipeline: &str) -> bool {
    state.launches.iter().any(|launch| launch.pipeline_id.as_deref() == Some(pipeline) && launch.recorder.is_some() && launch.phase != Phase::Exited)
}

pub fn validation_pending(pipeline: &str) -> Result<bool> {
    let directory = super::directory()?;
    super::update_at(&directory, |state| {
        refresh(&directory, state)?;
        Ok(pending(state, pipeline))
    })
}

pub(super) fn refresh(directory: &Path, state: &mut Snapshot) -> Result<()> {
    for launch in state.launches.iter_mut().filter(|launch| launch.recorder.is_some()) {
        let id = uuid::Uuid::parse_str(launch.recorder.as_deref().unwrap())?;
        let path = directory.join(id.to_string());
        super::recorder::refresh(&path, &mut launch.recorder_owner, &mut launch.recorder_exit)?;
        if let Some(owner) = &launch.recorder_owner {
            launch.pid = Some(owner.pid);
            launch.pid_birth.clone_from(&owner.birth);
        }
        if let Some(exited) = crate::store::read_json::<LeaderExit>(&directory.join(id.to_string()).join("exit.json"))? {
            launch.exit_code = exited.exit_code.and_then(|code| code.try_into().ok());
        }
        if let Some(recorded) = crate::store::read_json::<Recorded>(&directory.join(id.to_string()).join("validation.json"))? {
            launch.phase = Phase::Exited;
            launch.exit_code = recorded.result.exit_code.and_then(|code| code.try_into().ok());
            launch.last_progress_at = recorded.finished_at;
        } else if let Some(exit) = &launch.recorder_exit {
            // Only a failed spawn proves that no validation child exists.
            // A dead owner may have surviving descendants: keep admission held.
            launch.phase = if exit.never_spawned() { Phase::Exited } else { Phase::Unobserved };
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_ownership_commit_never_starts_a_recorder() {
        let directory = tempfile::tempdir().unwrap();
        let monitor = Arc::new(Monitor { directory: directory.path().into() });
        let id = uuid::Uuid::new_v4().to_string();
        // Reproduce the dangerous interval after a generic launch exists but
        // before validation ownership can be committed. Fail the actual atomic
        // write without replacing the successfully readable prior snapshot.
        monitor.begin("validation", &id, None).unwrap();
        let snapshot = directory.path().join("incidents.json");
        let before = std::fs::read(&snapshot).unwrap();
        let temporary = snapshot.with_extension(format!("tmp.{}", std::process::id()));
        std::fs::create_dir(&temporary).unwrap();
        let recorder = crate::store::ensure_dir(directory.path().join(&id)).unwrap();
        let marker = directory.path().join("child-started");
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf started > \"$1\"", "fixture"]).arg(&marker);
        let error = spawn_reserved(&monitor, "validation", "pipeline", &id, &recorder, &mut command).err().unwrap();
        assert!(format!("{error:#}").contains("create"));
        assert_eq!(std::fs::read(snapshot).unwrap(), before, "no partial ownership commit");
        assert!(!marker.exists());
        assert!(!recorder.join("owner.json").exists());
    }

    #[test]
    fn complete_reservation_survives_restart_and_dead_owner_without_releasing_checkout() {
        let directory = tempfile::tempdir().unwrap();
        let monitor = Arc::new(Monitor { directory: directory.path().into() });
        let id = uuid::Uuid::new_v4().to_string();
        let path = crate::store::ensure_dir(directory.path().join(&id)).unwrap();
        reserve(&monitor, "validation", "pipeline", &id).unwrap();
        let mut restored: Snapshot = crate::store::read_json(&directory.path().join("incidents.json")).unwrap().unwrap();
        assert_eq!(restored.launches.len(), 1);
        assert_eq!(restored.launches[0].recorder.as_deref(), Some(id.as_str()));
        assert_eq!(restored.launches[0].pipeline_id.as_deref(), Some("pipeline"));
        assert!(pending(&restored, "pipeline"));
        let reopened = Arc::new(Monitor { directory: directory.path().into() });
        assert!(reserve(&reopened, "other", "pipeline", &uuid::Uuid::new_v4().to_string()).is_err());
        crate::store::write_json(&path.join("owner-exit.json"), &super::super::tests::recorder_exit(1, 100)).unwrap();
        refresh(directory.path(), &mut restored).unwrap();
        assert_eq!(restored.launches[0].phase, Phase::Unobserved);
        assert_eq!(restored.launches[0].recorder_exit.as_ref().unwrap().exit_code, Some(1));
        assert!(pending(&restored, "pipeline"), "an owner exit cannot prove descendant completion");
    }
}
