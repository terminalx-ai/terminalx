//! Host-side exclusivity between attached tools and durable guest workflows.
//! File locks cover admission races; durable records cover a proxy/owner crash.
//! A dead host proxy is not evidence that a remote operation stopped.
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::fd::AsRawFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use crate::computer_targets::{Capability, Target};
use super::journal::{atomic_private_write, private_directory, Journal};

#[derive(Debug)]
pub struct Guard { _file: File, pub(super) marker: PathBuf }

pub(super) fn has_reservations(root:&Path)->Result<bool> {
    let directory=root.join("computer-admission");
    if !directory.try_exists()? { return Ok(false); }
    for entry in std::fs::read_dir(directory)? {
        if entry?.path().extension().is_some_and(|ext|ext=="json") { return Ok(true); }
    }
    Ok(false)
}

pub(super) fn read_marker(path: &Path) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path)?
        .take(64 * 1024 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > 64 * 1024 { bail!("Attachment receipt exceeds its bound"); }
    Ok(bytes)
}

impl Guard {
    /// Short journal transactions may race the same keyed submission. Allow
    /// those admissions to serialize, without waiting indefinitely on a proxy.
    pub(super) fn for_task(root:&Path,target:&Target)->Result<Self> {
        let deadline=std::time::Instant::now()+std::time::Duration::from_secs(2);
        loop {
            match Self::acquire(root,target) {
                Ok(guard)=>return Ok(guard),
                Err(error) if error.downcast_ref::<std::io::Error>().is_some_and(|e|e.kind()==std::io::ErrorKind::WouldBlock)
                    && std::time::Instant::now()<deadline => std::thread::sleep(std::time::Duration::from_millis(10)),
                Err(error)=>return Err(error),
            }
        }
    }
    pub fn acquire(root: &Path, target: &Target) -> Result<Self> {
        let guard = Self::lock(root, target)?;
        if guard.marker.try_exists()? {
            bail!("An attached desktop operation has no confirmed exit receipt. Retain its history and reconcile it before changing routes");
        }
        Ok(guard)
    }

    pub(super) fn lock(root: &Path, target: &Target) -> Result<Self> {
        let name = match target {
            Target::LinuxContainer { runtime, id } | Target::LinuxGuest { runtime, id, .. } => {
                Target::LinuxContainer { runtime: *runtime, id: id.clone() }.require(Capability::AttachedDesktop)?;
                format!("{}-{id}",runtime.name())
            },
            Target::MacosGuest { environment_id,generation } => {
                super::journal::validate_id(environment_id)?;super::journal::validate_id(generation)?;
                format!("macos-{environment_id}-{generation}")
            },
        };
        let directory = root.join("computer-admission");
        private_directory(&directory)?;
        let file = OpenOptions::new().create(true).truncate(false).write(true)
            .mode(0o600).custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(directory.join(format!("{name}.lock")))?;
        // SAFETY: file owns the descriptor throughout this guard's lifetime.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(std::io::Error::last_os_error()).context("This environment is in use by attached desktop tools; stop that attachment before running a task");
        }
        let marker = directory.join(format!("{name}.json"));
        Ok(Self { _file: file, marker })
    }

    pub fn attach(root: &Path, target: &Target, journal: &Journal) -> Result<Self> {
        if !matches!(target,Target::LinuxContainer {..}) { bail!("Container proxy requires an exact Linux desktop target"); }
        let guard = Self::acquire(root, target)?;
        let state = journal.read()?;
        for env in state.environments.values().filter(|e| e.transport.container().as_ref() == Some(target)) {
            if env.manual_control || super::setup::busy(env) || state.tasks.values().any(|task|
                task.target.environment_id == env.id && !task.status.terminal()) {
                bail!("This container is reserved by a guest task or manual control; attached tools cannot take its workflow lease");
            }
        }
        atomic_private_write(&guard.marker, &serde_json::to_vec(&serde_json::json!({
            "target":target,"operationId":uuid::Uuid::new_v4().to_string(),"startedAt":super::journal::now(),"status":"awaitingExitReceipt"
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

/// No process is stopped here. Only a fresh exact-container exit observation
/// may release a lost proxy reservation; the earlier action outcome stays unknown.
pub fn inspect(root: &Path, target: &Target) -> Result<serde_json::Value> {
    inspect_using(root, target, crate::container_vm::exit_evidence)
}

fn inspect_using(root: &Path, target: &Target, observe: impl FnOnce(&Target) -> Result<serde_json::Value>) -> Result<serde_json::Value> {
    let guard = Guard::lock(root, target)?;
    if !guard.marker.try_exists()? { return Ok(serde_json::json!({"target":target,"status":"unreserved"})); }
    let bytes = read_marker(&guard.marker)?;
    let retained: serde_json::Value = serde_json::from_slice(&bytes)?;
    if matches!(retained["kind"].as_str(),Some("linuxRuntimeInstall"|"linuxRuntimeActivation")) { bail!("An interrupted Linux installation or activation requires its own bound operation receipt; desktop recovery cannot release it"); }
    if retained["target"] != serde_json::to_value(target)? { bail!("Attached-operation identity changed"); }
    let mut result = serde_json::json!({"target":target,"status":"fenced","markerDigest":super::journal::digest(&bytes),
        "detail":"The prior desktop operation has no exit receipt. A timeout or missing host process cannot release it."});
    if let Ok(evidence) = observe(target) {
        result["status"] = serde_json::json!("releaseAvailable");
        result["evidence"] = evidence;
        result["detail"] = serde_json::json!("The exact container has exited. Reconciliation retains the unknown action history and releases only its reservation.");
    }
    Ok(result)
}

pub fn reconcile(root: &Path, target: &Target, marker_digest: &str, confirm: bool) -> Result<serde_json::Value> {
    reconcile_using(root, target, marker_digest, confirm, crate::container_vm::exit_evidence)
}

fn reconcile_using(root: &Path, target: &Target, marker_digest: &str, confirm: bool,
    observe: impl FnOnce(&Target) -> Result<serde_json::Value>) -> Result<serde_json::Value> {
    if !confirm { bail!("Confirm the inspected attachment reconciliation"); }
    let guard = Guard::lock(root, target)?;
    let bytes = read_marker(&guard.marker)?;
    if super::journal::digest(&bytes) != marker_digest { bail!("Attachment receipt changed; inspect again"); }
    let retained: serde_json::Value = serde_json::from_slice(&bytes)?;
    if matches!(retained["kind"].as_str(),Some("linuxRuntimeInstall"|"linuxRuntimeActivation")) { bail!("An interrupted Linux installation or activation requires its own bound operation receipt; desktop recovery cannot release it"); }
    if retained["target"] != serde_json::to_value(target)? { bail!("Attached-operation identity changed"); }
    let evidence = observe(target)?; // Never trust evidence supplied by the UI.
    let receipt = serde_json::json!({"target":target,"status":"released","priorOutcome":"unknown",
        "retained":retained,"markerDigest":marker_digest,"evidence":evidence,"reconciledAt":super::journal::now()});
    let archive = guard.marker.parent().context("Admission directory missing")?.join("history");
    private_directory(&archive)?;
    atomic_private_write(&archive.join(format!("{}.json", uuid::Uuid::new_v4())), &serde_json::to_vec(&receipt)?)?;
    guard.completed()?;
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::computer_targets::Runtime;
    #[test]
    fn reconciliation_rechecks_exact_exit_and_archives_unknown_input_before_release() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(&dir.path().join("journal")).unwrap();
        let target = Target::LinuxContainer { runtime: Runtime::Docker, id: "a".repeat(64) };
        let owner = Guard::attach(dir.path(), &target, &journal).unwrap();
        assert!(inspect_using(dir.path(), &target, |_| unreachable!()).is_err());
        drop(owner);
        let fenced = inspect_using(dir.path(), &target, |_| bail!("still running")).unwrap();
        assert_eq!(fenced["status"], "fenced");
        let proof = |target: &Target| crate::container_vm::parse_exit_evidence(target, &serde_json::json!({
            "Id":"a".repeat(64),"Config":{"Labels":{"ai.terminalx.computer":"1"}},"HostConfig":{"PidMode":"private"},
            "State":{"Status":"exited","Running":false,"Pid":0,"Paused":false,"Restarting":false,"Dead":false,
                "StartedAt":"2026-10-28T00:00:00Z","FinishedAt":"2026-10-28T00:01:00Z"}}));
        let preview = inspect_using(dir.path(), &target, proof).unwrap();
        assert_eq!(preview["status"], "releaseAvailable");
        let digest = preview["markerDigest"].as_str().unwrap();
        assert!(reconcile_using(dir.path(), &target, digest, false, |_| unreachable!()).is_err());
        assert!(reconcile_using(dir.path(), &target, "changed", true, |_| unreachable!()).is_err());
        assert!(reconcile_using(dir.path(), &target, digest, true, |_| bail!("container running again")).is_err());
        assert!(Guard::acquire(dir.path(), &target).is_err());
        let receipt = reconcile_using(dir.path(), &target, digest, true, proof).unwrap();
        assert_eq!(receipt["priorOutcome"], "unknown");
        assert_eq!(receipt["retained"]["status"], "awaitingExitReceipt");
        drop(Guard::acquire(dir.path(), &target).unwrap());
        let archives: Vec<_> = std::fs::read_dir(dir.path().join("computer-admission/history")).unwrap().collect();
        assert_eq!(archives.len(),1);
        let archived: serde_json::Value = serde_json::from_slice(&std::fs::read(archives[0].as_ref().unwrap().path()).unwrap()).unwrap();
        assert_eq!(archived,receipt);
        // A new operation cannot be reconciled using the previous digest.
        drop(Guard::attach(dir.path(), &target, &journal).unwrap());
        assert!(reconcile_using(dir.path(), &target, digest, true, |_| unreachable!()).is_err());
    }
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
