//! Host-side exclusivity between attached tools and durable guest workflows.
//! File locks cover admission races; durable records cover a proxy/owner crash.
//! A dead host proxy is not evidence that a remote operation stopped.
use std::fs::{File, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use crate::computer_targets::{Capability, Target};
use super::journal::{atomic_private_write, private_directory, Journal};

#[derive(Debug)]
pub struct Guard { _file: File, marker: PathBuf }

impl Guard {
    pub fn acquire(root: &Path, target: &Target) -> Result<Self> {
        let (runtime, id) = match target {
            Target::LinuxContainer { runtime, id } | Target::LinuxGuest { runtime, id, .. } => (runtime, id),
            _ => bail!("Container admission requires an exact container target"),
        };
        Target::LinuxContainer { runtime: *runtime, id: id.clone() }.require(Capability::AttachedDesktop)?;
        let directory = root.join("computer-admission");
        private_directory(&directory)?;
        let name = format!("{}-{id}", runtime.name());
        let file = OpenOptions::new().create(true).truncate(false).write(true)
            .mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(directory.join(format!("{name}.lock")))?;
        // SAFETY: file owns the descriptor throughout this guard's lifetime.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            bail!("This container is in use by attached desktop tools; stop that attachment before running a task");
        }
        let marker = directory.join(format!("{name}.json"));
        if marker.try_exists()? {
            bail!("An attached container operation has no confirmed exit receipt. Retain its history and reconcile it before changing routes");
        }
        Ok(Self { _file: file, marker })
    }

    pub fn attach(root: &Path, target: &Target, journal: &Journal) -> Result<Self> {
        let guard = Self::acquire(root, target)?;
        let state = journal.read()?;
        for env in state.environments.values().filter(|e| e.transport.container().as_ref() == Some(target)) {
            if env.manual_control || super::setup::busy(env) || state.tasks.values().any(|task|
                task.target.environment_id == env.id && !task.status.terminal()) {
                bail!("This container is reserved by a guest task or manual control; attached tools cannot take its workflow lease");
            }
        }
        atomic_private_write(&guard.marker, &serde_json::to_vec(&serde_json::json!({
            "target":target,"startedAt":super::journal::now(),"status":"awaitingExitReceipt"
        }))?)?;
        Ok(guard)
    }

    /// Only after the synchronous remote command reports a successful exit.
    /// Drop intentionally retains an unknown marker on failure/crash.
    pub fn completed(self) -> Result<()> {
        std::fs::remove_file(&self.marker).context("Retain attached-operation exit receipt")?;
        File::open(self.marker.parent().context("Admission directory missing")?)?.sync_all()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer_targets::Runtime;
    #[test]
    fn proxy_lifetime_and_unknown_exit_survive_reopen_without_timeout_release() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(&dir.path().join("journal")).unwrap();
        let target = Target::LinuxContainer { runtime: Runtime::Docker, id: "a".repeat(64) };
        let attachment = Guard::attach(dir.path(), &target, &journal).unwrap();
        assert!(Guard::acquire(dir.path(), &target).is_err());
        attachment.completed().unwrap();
        drop(Guard::acquire(dir.path(), &target).unwrap());
        drop(Guard::attach(dir.path(), &target, &journal).unwrap());
        assert!(Guard::acquire(dir.path(), &target).unwrap_err().to_string().contains("no confirmed exit"));
        let another = Target::LinuxContainer { runtime: Runtime::Podman, id: "a".repeat(64) };
        drop(Guard::acquire(dir.path(), &another).unwrap());
    }
}
