//! Durable owner-side boundary. An intent reaches stable storage before any
//! operation byte; a worker observation reaches stable storage before it is
//! exposed. This is not an execution adapter and does not enable startup.
use super::{Binding, Observation, Operation, Owner, Request, TaskTarget};
use anyhow::{ensure, Context, Result};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

pub(super) struct RetainedOwner<S> {
    owner: Owner<S>,
    root: PathBuf,
    epoch: PathBuf,
    _lock: File,
}

fn directory(path: &Path, create: bool) -> Result<()> {
    if create {
        match fs::DirBuilder::new().mode(0o700).create(path) {
            Ok(()) => (),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error.into()),
        }
    }
    let info = fs::symlink_metadata(path)?;
    // SAFETY: geteuid takes no pointers.
    ensure!(
        info.is_dir() && info.uid() == unsafe { libc::geteuid() } && info.mode() & 0o7777 == 0o700,
        "owner IPC history must be private and owned"
    );
    Ok(())
}

fn write_new(path: &Path, value: &impl serde::Serialize) -> Result<()> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    serde_json::to_writer(&mut file, value)?;
    file.flush()?;
    file.sync_all()?;
    File::open(path.parent().context("missing history directory")?)?.sync_all()?;
    Ok(())
}

impl<S: super::DeadlineIo> RetainedOwner<S> {
    pub fn connect(io: S, binding: Binding, root: &Path) -> Result<Self> {
        binding.validate()?;
        #[cfg(not(test))]
        {
            let (base, identity) = super::super::guest::installed_identity()?;
            ensure!(
                root == base.join("runtime/worker-ipc")
                    && binding.environment == identity.environment_id
                    && binding.generation == identity.generation,
                "wrong owner IPC history binding"
            );
        }
        directory(
            root.parent().context("missing owner runtime directory")?,
            false,
        )?;
        directory(root, true)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(root.join("owner.lock"))?;
        let info = lock.metadata()?;
        ensure!(
            info.is_file()
                && info.uid() == unsafe { libc::geteuid() }
                && info.mode() & 0o7777 == 0o600
                && info.nlink() == 1,
            "unsafe IPC ownership lock"
        );
        ensure!(
            super::super::journal::try_exclusive(&lock)?,
            "another owner holds worker IPC"
        );
        // Check with symlink_metadata: even a dangling link is retained evidence,
        // never an absent pending operation. Reconciliation is a separate action.
        match fs::symlink_metadata(root.join("pending.json")) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(error) => return Err(error.into()),
            Ok(_) => anyhow::bail!(
                "outcomeUnknown: prior worker intent remains unresolved; no reconnect or replay"
            ),
        }
        let epoch = root.join(&binding.epoch);
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&epoch)
            .context("worker incarnation was already used; it cannot reconnect")?;
        write_new(&epoch.join("binding.json"), &binding)?;
        File::open(root)?.sync_all()?;
        let owner = Owner::connect(io, binding)?;
        Ok(Self {
            owner,
            root: root.into(),
            epoch,
            _lock: lock,
        })
    }

    pub fn request(
        &mut self,
        target: Option<TaskTarget>,
        operation: Operation,
    ) -> Result<Observation> {
        self.request_with(target, operation, write_new)
    }

    fn request_with(
        &mut self,
        target: Option<TaskTarget>,
        operation: Operation,
        persist_receipt: impl FnOnce(&Path, &serde_json::Value) -> Result<()>,
    ) -> Result<Observation> {
        let pending = self.root.join("pending.json");
        let sequence = self.owner.next;
        let mut retained: Option<Request> = None;
        let result = (|| {
            let observation = self.owner.request(target, operation, |request| {
                write_new(&pending, request)?;
                retained = Some(request.clone());
                Ok(())
            })?;
            let receipt = serde_json::json!({"request":retained, "observation":&observation});
            persist_receipt(&self.epoch.join(format!("{sequence}.json")), &receipt)?;
            // The receipt is durable first. Failure to remove/sync the intent
            // still refuses success and requires explicit reconciliation.
            fs::remove_file(&pending)?;
            File::open(&self.root)?.sync_all()?;
            Ok(observation)
        })();
        if result.is_err() {
            self.owner.wire.poisoned = true;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::super::{Worker, VERSION};
    use super::*;
    use std::io::Read;
    use std::os::unix::net::UnixStream;
    use std::time::Duration;

    fn binding() -> Binding {
        Binding {
            environment: uuid::Uuid::new_v4().to_string(),
            generation: uuid::Uuid::new_v4().to_string(),
            epoch: uuid::Uuid::new_v4().to_string(),
        }
    }
    fn pair() -> (UnixStream, UnixStream) {
        let pair = UnixStream::pair().unwrap();
        for socket in [&pair.0, &pair.1] {
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
        }
        pair
    }
    fn root(temp: &tempfile::TempDir) -> PathBuf {
        // macOS canonicalizes /var to /private/var; this is an owner fixture,
        // not a production root or a path supplied by a worker.
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(temp.path(), fs::Permissions::from_mode(0o700)).unwrap();
        temp.path().join("worker-ipc")
    }
    #[test]
    fn worker_observes_durable_intent_before_effect_and_owner_retains_receipt() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let pending = root.join("pending.json");
        let (a, b) = pair();
        let worker = std::thread::spawn(move || {
            let mut worker = Worker::accept(b).unwrap();
            worker
                .dispatch(|request| {
                    let saved: Request = serde_json::from_slice(&fs::read(&pending)?).unwrap();
                    assert_eq!(saved.version, VERSION);
                    assert_eq!(saved.sequence, request.sequence);
                    assert_eq!(saved.binding, request.binding);
                    Ok(Observation::Stopped {
                        extinction_confirmed: true,
                    })
                })
                .unwrap();
        });
        let binding = binding();
        let mut owner = RetainedOwner::connect(a, binding.clone(), &root).unwrap();
        owner.request(None, Operation::Shutdown).unwrap();
        assert!(!root.join("pending.json").exists());
        let receipt: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join(binding.epoch).join("1.json")).unwrap())
                .unwrap();
        assert_eq!(receipt["observation"]["extinction_confirmed"], true);
        worker.join().unwrap();
    }

    #[test]
    fn lost_receipt_fences_memory_and_restart_without_replaying_effect() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let (a, b) = pair();
        let worker = std::thread::spawn(move || {
            let mut worker = Worker::accept(b).unwrap();
            worker
                .dispatch(|_| {
                    Ok(Observation::Stopped {
                        extinction_confirmed: true,
                    })
                })
                .unwrap();
        });
        let mut owner = RetainedOwner::connect(a, binding(), &root).unwrap();
        assert!(owner
            .request_with(None, Operation::Shutdown, |_, _| anyhow::bail!(
                "disk failure"
            ))
            .is_err());
        assert!(root.join("pending.json").exists());
        assert!(owner.request(None, Operation::Shutdown).is_err());
        worker.join().unwrap();
        drop(owner);
        let (a, mut b) = pair();
        assert!(RetainedOwner::connect(a, binding(), &root).is_err());
        assert_eq!(b.read(&mut [0; 1]).unwrap(), 0); // no new handshake or replay
    }

    #[test]
    fn an_incarnation_cannot_reconnect_even_before_any_operation() {
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let binding = binding();
        let (a, b) = pair();
        let worker = std::thread::spawn(move || {
            Worker::accept(b).unwrap();
        });
        let owner = RetainedOwner::connect(a, binding.clone(), &root).unwrap();
        worker.join().unwrap();
        drop(owner);
        let (a, mut b) = pair();
        assert!(RetainedOwner::connect(a, binding, &root).is_err());
        assert_eq!(b.read(&mut [0; 1]).unwrap(), 0);
    }

    #[test]
    fn existing_unsafe_history_is_never_adopted_or_repaired() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let root = root(&temp);
        let other = tempfile::tempdir().unwrap();
        symlink(other.path(), &root).unwrap();
        let (a, _) = pair();
        assert!(RetainedOwner::connect(a, binding(), &root).is_err());
        fs::remove_file(&root).unwrap();
        fs::create_dir(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o777)).unwrap();
        let (a, _) = pair();
        assert!(RetainedOwner::connect(a, binding(), &root).is_err());
        assert_eq!(fs::metadata(&root).unwrap().mode() & 0o777, 0o777);
    }
}
