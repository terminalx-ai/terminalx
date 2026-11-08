//! A detached supervisor owns the recorder's wait independently of the desktop
//! or runtime observer. Losing either process never certifies child completion.
use std::ffi::OsString;
use std::path::Path;
use std::process::{Child, Command, ExitStatus, Stdio};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecorderIdentity {
    pub pid: u32,
    pub birth: Option<String>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum RecorderFailure { Spawn, Wait }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RecorderExit {
    pub finished_at: i64,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub failure: Option<RecorderFailure>,
    pub os_error: Option<i32>,
}

impl RecorderExit {
    pub(super) fn failed(&self) -> bool {
        self.exit_code != Some(0) || self.signal.is_some() || self.failure.is_some()
    }
    pub(super) fn never_spawned(&self) -> bool { self.failure == Some(RecorderFailure::Spawn) }

    fn waited(result: std::io::Result<ExitStatus>) -> Self {
        match result {
            Ok(status) => {
                #[cfg(unix)]
                let signal = { use std::os::unix::process::ExitStatusExt; status.signal() };
                #[cfg(not(unix))]
                let signal = None;
                Self { finished_at: super::now(), exit_code: status.code(), signal, failure: None, os_error: None }
            }
            Err(error) => Self { finished_at: super::now(), exit_code: None, signal: None,
                failure: Some(RecorderFailure::Wait), os_error: error.raw_os_error() },
        }
    }
}

fn save_exit(directory: &Path, outcome: &RecorderExit) -> Result<()> {
    crate::store::write_json(&directory.join("owner-exit.json"), outcome)
}

pub(super) fn spawn_failed(directory: &Path, error: &std::io::Error) {
    if let Err(error) = save_exit(directory, &RecorderExit { finished_at: super::now(), exit_code: None, signal: None,
        failure: Some(RecorderFailure::Spawn), os_error: error.raw_os_error() }) {
        log::error!("persist recorder spawn failure: {error:#}");
    }
}

pub(super) fn private_directory(directory: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(directory)?;
    ensure!(metadata.is_dir() && directory.file_name().and_then(|name| name.to_str()).is_some_and(|name| uuid::Uuid::parse_str(name).is_ok()), "invalid startup recorder directory");
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions.
        ensure!(metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o077 == 0, "startup recorder directory is not private");
    }
    Ok(())
}

/// Runs in the detached production CLI process, before application startup.
/// Only this process writes the worker's wait outcome. Desktop quit or runtime
/// exec cannot destroy its Child handle, and reopening just reads the files.
pub(super) fn supervise(directory: &Path, mode: &str, args: &[OsString]) -> Result<()> {
    private_directory(directory)?;
    let pid = std::process::id();
    crate::store::write_json(&directory.join("supervisor.json"), &RecorderIdentity {
        pid, birth: super::process_identity(Some(pid)),
    })?;
    let mut command = Command::new(std::env::current_exe()?);
    command.arg(mode).args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    let mut child = command.spawn().inspect_err(|error| spawn_failed(directory, error))?;
    let owner = RecorderIdentity { pid: child.id(), birth: super::process_identity(Some(child.id())) };
    if let Err(error) = crate::store::write_json(&directory.join("owner.json"), &owner) {
        // The prior reservation still holds. An identity write failure must
        // not discard the already-spawned worker's wait handle.
        log::error!("persist recorder identity: {error:#}");
    }
    let outcome = RecorderExit::waited(child.wait());
    save_exit(directory, &outcome)?;
    ensure!(!outcome.failed(), "recorder owner failed: {outcome:?}");
    Ok(())
}

/// Best-effort zombie reaping only. This observer thread is deliberately not
/// an outcome writer: its loss cannot prevent the supervisor saving the wait.
pub(super) fn reap_supervisor(mut child: Child) {
    std::thread::spawn(move || { let _ = child.wait(); });
}

pub(super) fn refresh(directory: &Path, owner: &mut Option<RecorderIdentity>, exit: &mut Option<RecorderExit>) -> anyhow::Result<()> {
    if owner.is_none() { *owner = crate::store::read_json(&directory.join("owner.json"))?; }
    if exit.is_none() { *exit = crate::store::read_json(&directory.join("owner-exit.json"))?; }
    Ok(())
}

pub(super) fn export(exit: &RecorderExit) -> serde_json::Value {
    serde_json::json!({ "finishedAt": exit.finished_at, "exitCode": exit.exit_code,
        "signal": exit.signal, "failure": exit.failure, "osError": exit.os_error })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn owner_signals_and_wait_errors_have_distinct_exact_outcomes() {
        use std::os::unix::process::ExitStatusExt;
        let signaled = RecorderExit::waited(Ok(ExitStatus::from_raw(libc::SIGTERM)));
        assert_eq!(signaled.exit_code, None);
        assert_eq!(signaled.signal, Some(libc::SIGTERM));
        assert_eq!(signaled.failure, None);
        let failed = RecorderExit::waited(Err(std::io::Error::from_raw_os_error(libc::ECHILD)));
        assert_eq!(failed.failure, Some(RecorderFailure::Wait));
        assert_eq!(failed.os_error, Some(libc::ECHILD));
        assert_eq!(failed.exit_code, None);
        assert!(!failed.never_spawned(), "a wait error cannot clear child ownership");
    }
}
