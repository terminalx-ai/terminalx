//! The observing runtime retains the recorder's own wait status separately
//! from results written by its children. Losing a recorder never certifies
//! that its descendants exited or that validation succeeded.
use std::path::{Path, PathBuf};
use std::process::{Child, ExitStatus};
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

fn save_exit(directory: &Path, outcome: &RecorderExit) {
    if let Err(error) = crate::store::write_json(&directory.join("owner-exit.json"), outcome) {
        log::error!("persist recorder owner exit {outcome:?}: {error:#}");
    }
}

pub(super) fn spawn_failed(directory: &Path, error: &std::io::Error) {
    save_exit(directory, &RecorderExit { finished_at: super::now(), exit_code: None, signal: None,
        failure: Some(RecorderFailure::Spawn), os_error: error.raw_os_error() });
}

/// Take responsibility for an already-owned recorder. Its private directory
/// was reserved before spawn; neither a detached observer nor a UI timeout
/// may throw away a wait result. An app restart can read these sidecars.
pub fn retain_recorder(mut child: Child, directory: PathBuf) {
    let owner = RecorderIdentity { pid: child.id(), birth: super::process_identity(Some(child.id())) };
    if let Err(error) = crate::store::write_json(&directory.join("owner.json"), &owner) {
        // The complete reservation still holds ownership if identity cannot
        // be saved. Keep the Child handle and preserve its eventual outcome.
        log::error!("persist recorder identity: {error:#}");
    }
    std::thread::spawn(move || { save_exit(&directory, &RecorderExit::waited(child.wait())); });
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
