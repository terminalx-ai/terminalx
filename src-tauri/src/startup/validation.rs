//! Local checks keep a detached, bounded recorder. An observation timeout or
//! host incident releases the coordinator, not the child, and never passes it.
use std::ffi::OsStr;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use super::{probe, Monitor, Phase, Snapshot};

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
    let ticket = monitor.begin(pane, &recorder, None)?;
    ticket.change(|launch| { launch.category = super::Category::Validation; launch.recorder = Some(recorder.clone()); launch.pipeline_id = Some(pipeline.into()); });
    // The configured command is passed as one argument, never interpolated
    // into a shell wrapper or written to the incident/export record.
    let mut process = Command::new(std::env::current_exe()?);
    process.arg("--startup-validation-recorder").arg(&path).arg(cwd).arg(command)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    { use std::os::unix::process::CommandExt; process.process_group(0); }
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => { ticket.exited(None); return Err(error.into()); }
    };
    ticket.spawned(Some(child.id()));
    // Reap the recorder, but the result is its durable file. An app restart
    // cannot convert a lost Child handle into a validation pass.
    std::thread::spawn(move || { let _ = child.wait(); });
    let started = Instant::now();
    loop {
        if let Some(recorded) = crate::store::read_json::<Recorded>(&path.join("validation.json"))? {
            ticket.exited(recorded.result.exit_code.and_then(|code| code.try_into().ok()));
            if recorded.result.exit_code == Some(0) && recorded.result.signal.is_none() && !recorded.result.spawn_failed { return Ok(()); }
            bail!("Local validation failed (exit {:?}, signal {:?}). Its bounded output and final result remain in the private startup recorder {}.", recorded.result.exit_code, recorded.result.signal, recorder);
        }
        if let Some(message) = super::validation_blocker(Some(pipeline))? { return Err(ValidationHeld(message).into()); }
        if started.elapsed() >= Duration::from_secs(1800) {
            return Err(ValidationHeld(format!("Local validation observation exceeded 30 minutes. Recorder {recorder} is still pending; the child was not killed and no result was accepted.")).into());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

pub fn validation_pending(pipeline: &str) -> Result<bool> {
    let directory = super::directory()?;
    super::update_at(&directory, |state| {
        refresh(&directory, state)?;
        Ok(state.launches.iter().any(|launch| launch.pipeline_id.as_deref() == Some(pipeline) && launch.recorder.is_some() && launch.phase != Phase::Exited))
    })
}

pub(super) fn refresh(directory: &Path, state: &mut Snapshot) -> Result<()> {
    for launch in state.launches.iter_mut().filter(|launch| launch.recorder.is_some() && launch.phase != Phase::Exited) {
        let id = uuid::Uuid::parse_str(launch.recorder.as_deref().unwrap())?;
        if let Some(exited) = crate::store::read_json::<LeaderExit>(&directory.join(id.to_string()).join("exit.json"))? {
            launch.exit_code = exited.exit_code.and_then(|code| code.try_into().ok());
        }
        if let Some(recorded) = crate::store::read_json::<Recorded>(&directory.join(id.to_string()).join("validation.json"))? {
            launch.phase = Phase::Exited;
            launch.exit_code = recorded.result.exit_code.and_then(|code| code.try_into().ok());
            launch.last_progress_at = recorded.finished_at;
        }
    }
    Ok(())
}
