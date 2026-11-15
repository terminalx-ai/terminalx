//! Host-side exclusivity between attached tools and durable guest workflows.
//! File locks cover admission races; durable records cover a proxy/owner crash.
//! A dead host proxy is not evidence that a remote operation stopped.
use std::fs::{File, OpenOptions};
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use crate::computer_targets::{Capability, Target};
use super::journal::{atomic_private_write, private_directory, Journal};

/// When an operation's own timeout ends, in milliseconds since the epoch.
/// A marker past it is no longer work in progress: its call was given up
/// on, and only the container's Stop or Reset can settle what it left.
fn expires_at(within: std::time::Duration) -> u64 {
    let at = std::time::SystemTime::now() + within;
    at.duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64)
}

/// The container operations still inside their own timeout at `now`, as a
/// person names them: the work a runtime handover would cut short. A tab's
/// attached desktop and a guest's lease have no timeout and are carried
/// over, and a marker that cannot be read names no live operation.
pub(super) fn live(root: &Path, now: std::time::SystemTime) -> Result<Vec<String>> {
    let directory = root.join("computer-admission");
    if !directory.try_exists()? { return Ok(Vec::new()); }
    let now = now.duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64);
    let mut live = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let path = entry?.path();
        if !path.extension().is_some_and(|ext| ext == "json") { continue; }
        let Some(marker) = read_marker(&path).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok()) else { continue };
        if marker["expiresAt"].as_u64().is_some_and(|at| at > now) {
            live.push(if marker["kind"] == "lifecycle" { "A Local VM start, stop or reset".into() } else { "A Local VM desktop call or screenshot".into() });
        }
    }
    live.sort();
    Ok(live)
}

/// Slack past a desktop call's own timeout before its marker counts as a call
/// given up on: covers lock-to-exec and exit-to-receipt time under load.
const CALL_GRACE: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Debug)]
pub struct Guard { _file: File, pub(super) marker: PathBuf }

/// A reservation on a guest, whose receipt the host owner must settle: not
/// the container's own markers, which its Stop and Reset settle (review 3).
/// A marker that cannot be read counts, as its target is unknown.
pub(super) fn has_guest_reservations(root:&Path)->Result<bool> {
    let directory=root.join("computer-admission");
    if !directory.try_exists()? { return Ok(false); }
    for entry in std::fs::read_dir(directory)? {
        let path=entry?.path();
        if path.extension().is_some_and(|ext|ext=="json")
            && read_marker(&path).ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                .is_none_or(|marker| marker["target"]["kind"] != "linuxContainer")
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The one-shot call markers beside `marker`, `<name>.call.<operation>.json`.
fn call_markers(marker: &Path) -> Result<Vec<PathBuf>> {
    let (Some(directory), Some(stem)) = (marker.parent(), marker.file_stem().and_then(|s| s.to_str())) else { bail!("Admission marker path is invalid") };
    let prefix = format!("{stem}.call.");
    let mut markers = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        let path = entry?.path();
        if path.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(&prefix) && n.ends_with(".json")) {
            markers.push(path);
        }
    }
    markers.sort();
    Ok(markers)
}

/// Who holds a container's lock, as a person can act on it, not always
/// "attached desktop tools" (#978).
fn holder(marker: &Path, shared: bool) -> String {
    let retained = read_marker(marker).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
    let calls = call_markers(marker).map(|m| m.len()).unwrap_or(0);
    match retained {
        Some(m) if m["kind"] == "lifecycle" => "A Local VM start, stop or reset is in progress; try again when it ends".into(),
        Some(m) if matches!(m["kind"].as_str(), Some("linuxRuntimeInstall" | "linuxRuntimeActivation")) =>
            "A Linux runtime installation or activation holds this container; inspect its receipt".into(),
        Some(_) => "This container is in use by a tab's attached desktop tools; stop that attachment first".into(),
        None if !shared && calls > 0 => format!("{calls} desktop call{} running on this container; try again when {} ends", if calls == 1 { " is" } else { "s are" }, if calls == 1 { "it" } else { "they" }),
        None => "Another Local VM operation holds this container for a moment; try again".into(),
    }
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
        // Holding the exclusive lock, no call is running: a call marker left
        // here is a call given up on, as unconfirmed as the main marker.
        if guard.marker.try_exists()? || !call_markers(&guard.marker)?.is_empty() {
            bail!("An attached desktop operation has no confirmed exit receipt. Retain its history and reconcile it before changing routes");
        }
        Ok(guard)
    }

    pub(super) fn lock(root: &Path, target: &Target) -> Result<Self> {
        Self::lock_as(root, target, false)
    }

    /// Exclusive for an attached proxy, task admission, lifecycle or install;
    /// shared for one-shot desktop calls, which run beside each other (#978).
    fn lock_as(root: &Path, target: &Target, shared: bool) -> Result<Self> {
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
        let marker = directory.join(format!("{name}.json"));
        // file owns the descriptor throughout this guard's lifetime.
        let locked = if shared { crate::local_vm::journal::try_shared(&file)? } else { crate::local_vm::journal::try_exclusive(&file)? };
        if !locked {
            return Err(std::io::Error::from(std::io::ErrorKind::WouldBlock)).context(holder(&marker, shared));
        }
        Ok(Self { _file: file, marker })
    }

    /// One desktop call or screenshot (#978). Calls share the lock, so one
    /// running up to its timeout no longer turns the next away; each keeps
    /// its own exit marker. Exclusive work still refuses them, and they it.
    pub fn call(root: &Path, target: &Target, journal: &Journal, within: std::time::Duration) -> Result<Self> {
        if !matches!(target,Target::LinuxContainer {..}) { bail!("Container calls require an exact Linux desktop target"); }
        let mut guard = Self::lock_as(root, target, true)?;
        if guard.marker.try_exists()? {
            bail!("An attached desktop operation has no confirmed exit receipt. Retain its history and reconcile it before changing routes");
        }
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_millis() as u64);
        for marker in call_markers(&guard.marker)? {
            // A call past its own timeout was given up on: only Stop or Reset settles it.
            let expires = read_marker(&marker).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok()).and_then(|m| m["expiresAt"].as_u64());
            if expires.is_none_or(|at| at <= now) {
                bail!("An earlier desktop call has no confirmed exit receipt. Stop or reset the Local VM to settle it");
            }
        }
        reserved(target, journal)?;
        let operation = uuid::Uuid::new_v4().to_string();
        guard.marker = guard.marker.with_extension(format!("call.{operation}.json"));
        atomic_private_write(&guard.marker, &serde_json::to_vec(&serde_json::json!({
            // The command's own timeout starts after this marker is written,
            // and its exit is confirmed after it ends: the grace keeps a call
            // still inside its timeout from counting as given up (#978 review).
            "target":target,"operationId":operation,"startedAt":super::journal::now(),"status":"awaitingExitReceipt","expiresAt":expires_at(within + CALL_GRACE),
        }))?)?;
        Ok(guard)
    }

    /// `within` is the operation's own timeout; none for a tab's attached
    /// desktop, which lasts as long as its agent.
    pub fn attach(root: &Path, target: &Target, journal: &Journal, within: Option<std::time::Duration>) -> Result<Self> {
        if !matches!(target,Target::LinuxContainer {..}) { bail!("Container proxy requires an exact Linux desktop target"); }
        let guard = Self::acquire(root, target)?;
        reserved(target, journal)?;
        let mut marker = serde_json::json!({
            "target":target,"operationId":uuid::Uuid::new_v4().to_string(),"startedAt":super::journal::now(),"status":"awaitingExitReceipt"
        });
        if let Some(within) = within { marker["expiresAt"] = serde_json::json!(expires_at(within)); }
        atomic_private_write(&guard.marker, &serde_json::to_vec(&marker)?)?;
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

/// The Local VM's own Start, Stop and Reset (`container_vm.rs`). A fence left
/// by a desktop operation whose exit was never confirmed does not refuse
/// them: stopping or removing the container ends that operation for certain,
/// and a container already stopped proves it ended. The lock is still taken,
/// so a live attachment refuses as before, and so do guest-task reservations.
pub struct Lifecycle {
    guard: Guard,
    pub target: Target,
    /// The fence an earlier operation left, kept until this one proves it ended.
    prior: Option<Vec<u8>>,
    /// Desktop calls given up on (#978): each its own marker, settled alike.
    prior_calls: Vec<(PathBuf, Vec<u8>)>,
}

impl Lifecycle {
    /// `within` bounds the whole start, stop or reset.
    pub fn begin(root: &Path, target: &Target, journal: &Journal, within: std::time::Duration) -> Result<Self> {
        if !matches!(target, Target::LinuxContainer { .. }) { bail!("The Local VM's lifecycle requires its exact Linux desktop container"); }
        let guard = Guard::lock(root, target)?;
        reserved(target, journal)?;
        let prior = if guard.marker.try_exists()? { Some(read_marker(&guard.marker)?) } else { None };
        if let Some(bytes) = &prior {
            let retained: serde_json::Value = serde_json::from_slice(bytes)?;
            if matches!(retained["kind"].as_str(), Some("linuxRuntimeInstall" | "linuxRuntimeActivation")) {
                bail!("An interrupted Linux installation or activation requires its own bound operation receipt; the Local VM was not changed");
            }
        }
        // Holding the exclusive lock, no call is running: any call marker is
        // one given up on, which this stop or reset settles like the main one.
        let prior_calls = call_markers(&guard.marker)?.into_iter()
            .map(|path| read_marker(&path).map(|bytes| (path, bytes))).collect::<Result<Vec<_>>>()?;
        let prior_value = prior.as_deref().map(serde_json::from_slice::<serde_json::Value>).transpose()?;
        let calls_value = prior_calls.iter().map(|(_, bytes)| serde_json::from_slice::<serde_json::Value>(bytes)).collect::<std::result::Result<Vec<_>, _>>()?;
        atomic_private_write(&guard.marker, &serde_json::to_vec(&serde_json::json!({
            "target":target,"operationId":uuid::Uuid::new_v4().to_string(),"startedAt":super::journal::now(),
            "status":"awaitingExitReceipt","kind":"lifecycle","prior":prior_value,"priorCalls":calls_value,"expiresAt":expires_at(within),
        }))?)?;
        Ok(Self { guard, target: target.clone(), prior, prior_calls })
    }

    /// Whether an earlier operation's fence is waiting on this one.
    pub fn fenced(&self) -> bool { self.prior.is_some() || !self.prior_calls.is_empty() }

    /// The lifecycle step ended and `evidence` shows every process in the
    /// container ended with it: an earlier unknown operation is archived, as a
    /// reconciliation would, and the reservation is released.
    pub fn ended(self, evidence: serde_json::Value) -> Result<()> {
        let archive = self.guard.marker.parent().context("Admission directory missing")?.join("history");
        for bytes in self.prior.iter().chain(self.prior_calls.iter().map(|(_, bytes)| bytes)) {
            let retained: serde_json::Value = serde_json::from_slice(bytes)?;
            let receipt = serde_json::json!({"target":self.target,"status":"released","priorOutcome":"unknown",
                "retained":retained,"markerDigest":super::journal::digest(bytes),"evidence":evidence,"reconciledAt":super::journal::now()});
            private_directory(&archive)?;
            atomic_private_write(&archive.join(format!("{}.json", uuid::Uuid::new_v4())), &serde_json::to_vec(&receipt)?)?;
        }
        // Archived first, so a crash here leaves the call fenced, never lost.
        for (path, _) in &self.prior_calls {
            std::fs::remove_file(path).context("Release a settled desktop call marker")?;
        }
        self.guard.completed()
    }

    /// The step ended but proves nothing about an earlier operation, which
    /// stays fenced exactly as it was; given-up call markers are untouched.
    pub fn ended_keeping_prior(self) -> Result<()> {
        match &self.prior {
            Some(bytes) => atomic_private_write(&self.guard.marker, bytes),
            None => self.guard.completed(),
        }
    }
}

/// Refuses while a guest task, manual control or guided setup holds `target`.
fn reserved(target: &Target, journal: &Journal) -> Result<()> {
    let state = journal.read()?;
    for env in state.environments.values().filter(|e| e.transport.container().as_ref() == Some(target)) {
        if env.manual_control || super::setup::busy(env) || state.tasks.values().any(|task|
            task.target.environment_id == env.id && !task.status.terminal()) {
            bail!("This container is reserved by a guest task or manual control; attached tools cannot take its workflow lease");
        }
    }
    Ok(())
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

    /// #978: one call held the container exclusively for up to 120 s, and a
    /// second (a screenshot during `launch_app`) failed after 0.5 s saying
    /// "attached desktop tools".
    #[test]
    fn desktop_calls_run_beside_each_other_and_exclusive_work_waits_for_them() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(&dir.path().join("journal")).unwrap();
        let target = Target::LinuxContainer { runtime: Runtime::Docker, id: "a".repeat(64) };
        let minute = std::time::Duration::from_secs(60);
        let launching = Guard::call(dir.path(), &target, &journal, minute).unwrap();
        let screenshot = Guard::call(dir.path(), &target, &journal, minute).expect("a second call runs beside the first");
        assert_ne!(launching.marker, screenshot.marker);
        let live = live(dir.path(), std::time::SystemTime::now()).unwrap();
        assert_eq!(live, vec!["A Local VM desktop call or screenshot".to_string(); 2]);
        let refused = Guard::attach(dir.path(), &target, &journal, None).unwrap_err().to_string();
        assert!(refused.contains("2 desktop calls are running"), "{refused}");
        assert!(Lifecycle::begin(dir.path(), &target, &journal, minute).is_err());
        screenshot.completed().unwrap();
        launching.completed().unwrap();
        // An attached tab's desktop is exclusive, and a call names it plainly.
        let attached = Guard::attach(dir.path(), &target, &journal, None).unwrap();
        let refused = Guard::call(dir.path(), &target, &journal, minute).unwrap_err().to_string();
        assert!(refused.contains("a tab's attached desktop tools"), "{refused}");
        attached.completed().unwrap();
        // A call given up on stays fenced: past its timeout it refuses the next
        // call and any exclusive route, until a stop or reset settles it.
        let abandoned = Guard::call(dir.path(), &target, &journal, std::time::Duration::ZERO).unwrap();
        let marker = abandoned.marker.clone();
        drop(abandoned);
        // Within its grace a zero-timeout call still counts as running.
        Guard::call(dir.path(), &target, &journal, minute).unwrap().completed().unwrap();
        let mut retained: serde_json::Value = serde_json::from_slice(&std::fs::read(&marker).unwrap()).unwrap();
        retained["expiresAt"] = serde_json::json!(1);
        atomic_private_write(&marker, &serde_json::to_vec(&retained).unwrap()).unwrap();
        assert!(Guard::call(dir.path(), &target, &journal, minute).unwrap_err().to_string().contains("Stop or reset"));
        assert!(Guard::acquire(dir.path(), &target).is_err());
        let stop = Lifecycle::begin(dir.path(), &target, &journal, minute).unwrap();
        assert!(stop.fenced());
        stop.ended(serde_json::json!({"status":"stopped"})).unwrap();
        assert!(!marker.exists());
        assert_eq!(std::fs::read_dir(dir.path().join("computer-admission/history")).unwrap().count(), 1);
        Guard::acquire(dir.path(), &target).unwrap();
    }
    #[test]
    fn reconciliation_rechecks_exact_exit_and_archives_unknown_input_before_release() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(&dir.path().join("journal")).unwrap();
        let target = Target::LinuxContainer { runtime: Runtime::Docker, id: "a".repeat(64) };
        let owner = Guard::attach(dir.path(), &target, &journal, None).unwrap();
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
        drop(Guard::attach(dir.path(), &target, &journal, None).unwrap());
        assert!(reconcile_using(dir.path(), &target, digest, true, |_| unreachable!()).is_err());
    }
    /// Review 2: a desktop call that never confirmed its exit must not keep
    /// TerminalX's own Stop, Reset and Start from working.
    #[test]
    fn lifecycle_steps_end_an_earlier_unknown_operation_and_archive_it() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(&dir.path().join("journal")).unwrap();
        let target = Target::LinuxContainer { runtime: Runtime::Docker, id: "a".repeat(64) };
        // A call whose exit was never confirmed fences the container.
        drop(Guard::attach(dir.path(), &target, &journal, None).unwrap());
        assert!(Guard::acquire(dir.path(), &target).is_err());
        let fenced = read_marker(&dir.path().join(format!("computer-admission/docker-{}.json", "a".repeat(64)))).unwrap();
        // A start against a running container proves nothing: the fence stays as it was.
        let start = Lifecycle::begin(dir.path(), &target, &journal, std::time::Duration::from_secs(60)).unwrap();
        assert!(start.fenced());
        start.ended_keeping_prior().unwrap();
        assert_eq!(read_marker(&dir.path().join(format!("computer-admission/docker-{}.json", "a".repeat(64)))).unwrap(), fenced);
        // A stop that leaves the container exited ends it, and keeps its history.
        let stop = Lifecycle::begin(dir.path(), &target, &journal, std::time::Duration::from_secs(60)).unwrap();
        stop.ended(serde_json::json!({"status":"exited"})).unwrap();
        drop(Guard::acquire(dir.path(), &target).unwrap());
        let archives: Vec<_> = std::fs::read_dir(dir.path().join("computer-admission/history")).unwrap().collect();
        assert_eq!(archives.len(), 1);
        let archived: serde_json::Value = serde_json::from_slice(&std::fs::read(archives[0].as_ref().unwrap().path()).unwrap()).unwrap();
        assert_eq!(archived["priorOutcome"], "unknown");
        assert_eq!(archived["retained"]["status"], "awaitingExitReceipt");
        assert_eq!(archived["markerDigest"], super::super::journal::digest(&fenced));
        // Unfenced, a lifecycle step archives nothing.
        Lifecycle::begin(dir.path(), &target, &journal, std::time::Duration::from_secs(60)).unwrap().ended(serde_json::json!({})).unwrap();
        assert_eq!(std::fs::read_dir(dir.path().join("computer-admission/history")).unwrap().count(), 1);
        // A live attachment still refuses it.
        let live = Guard::attach(dir.path(), &target, &journal, None).unwrap();
        assert!(Lifecycle::begin(dir.path(), &target, &journal, std::time::Duration::from_secs(60)).is_err());
        live.completed().unwrap();
        // So does a guest task's reservation of the container.
        let guest = Target::LinuxGuest { runtime: Runtime::Docker, id: "a".repeat(64),
            environment_id: super::super::journal::new_id(), generation: super::super::journal::new_id() };
        let env = journal.enroll_container("Linux", &guest, &"e".repeat(64)).unwrap();
        journal.transaction(|state| { state.environments.get_mut(&env.id).unwrap().manual_control = true; Ok(()) }).unwrap();
        assert!(Lifecycle::begin(dir.path(), &target, &journal, std::time::Duration::from_secs(60)).is_err());
    }

    #[test]
    fn proxy_lifetime_and_unknown_exit_survive_reopen_without_timeout_release() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(&dir.path().join("journal")).unwrap();
        let target = Target::LinuxContainer { runtime: Runtime::Docker, id: "a".repeat(64) };
        let attachment = Guard::attach(dir.path(), &target, &journal, None).unwrap();
        assert!(Guard::acquire(dir.path(), &target).is_err());
        attachment.completed().unwrap();
        drop(Guard::acquire(dir.path(), &target).unwrap());
        drop(Guard::attach(dir.path(), &target, &journal, None).unwrap());
        assert!(Guard::acquire(dir.path(), &target).unwrap_err().to_string().contains("no confirmed exit"));
        let another = Target::LinuxContainer { runtime: Runtime::Podman, id: "a".repeat(64) };
        drop(Guard::acquire(dir.path(), &another).unwrap());
    }
}
