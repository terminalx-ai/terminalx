use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Pinned disclosed bootstrap dependencies. TerminalX never enrolls the host
/// as a Space or copies host credentials into the guest.
pub const CUA_VERSION: &str = "0.7.0";
pub const LUME_VERSION: &str = "0.6.1";
pub const PROTOCOL: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskTarget {
    pub environment_id: String,
    pub workspace_id: String,
    pub task_id: String,
    /// Changes after a snapshot restore/re-enrollment. An old task is never
    /// sent to the new timeline merely because its VM name still exists.
    pub generation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InputFile {
    /// Project-relative, explicit selection, with symlinks resolved at export.
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskInput {
    pub parent_session_id: String,
    pub parent_tab_id: String,
    pub parent_message_id: String,
    pub environment_id: String,
    pub prompt: String,
    pub harness: String,
    pub model: String,
    pub effort: Option<String>,
    pub permission_mode: String,
    pub files: Vec<InputFile>,
    /// Every initial task is queued against the VM's whole-workflow lease.
    /// Future shell-only concurrency can relax this without weakening GUI
    /// isolation for tasks that acquire the desktop.
    pub desktop: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TaskStatus {
    Queued,
    Starting,
    Running,
    Waiting,
    Canceling,
    Completed,
    Failed,
    Canceled,
    OutcomeUnknown,
}

impl TaskStatus {
    pub fn terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Canceled)
    }

    pub fn holds_desktop(self) -> bool {
        matches!(
            self,
            Self::Starting | Self::Running | Self::Waiting | Self::Canceling | Self::OutcomeUnknown
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub seq: u64,
    pub timestamp: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub name: String,
    pub sha256: String,
    pub bytes: u64,
    pub media_type: String,
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    /// Exact transport as selected at submission, retained after replacement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub computer: Option<crate::computer_targets::Target>,
    pub target: TaskTarget,
    pub input: TaskInput,
    pub idempotency_key: String,
    pub input_digest: String,
    pub guest_cwd: String,
    pub worker_session_id: Option<String>,
    pub worker_tab_id: Option<String>,
    pub provider_conversation_id: Option<String>,
    pub status: TaskStatus,
    pub created_at: String,
    pub updated_at: String,
    pub last_event_seq: u64,
    pub events: Vec<TaskEvent>,
    pub artifacts: Vec<Artifact>,
    pub outcome: Option<String>,
    pub detail: Option<String>,
    /// Persisted before a guest start RPC. A task can be queued on the guest
    /// before its worker has a session ID, so status alone cannot cancel it.
    #[serde(default)]
    pub dispatch_started: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Environment {
    #[serde(default, skip_serializing_if = "super::transport::Transport::is_macos")]
    pub transport: super::transport::Transport,
    pub id: String,
    pub name: String,
    /// Exact Cua reference, not a user-supplied tool selector.
    pub sandbox: String,
    pub generation: String,
    pub created_at: String,
    pub deleted_at: Option<String>,
    pub keep_awake: bool,
    #[serde(default)]
    pub owned: bool,
    #[serde(default)]
    pub provision: Option<Value>,
    #[serde(default)]
    pub manual_control: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct State {
    #[serde(default)]
    pub enabled: bool,
    pub environments: BTreeMap<String, Environment>,
    pub tasks: BTreeMap<String, Task>,
}

/// Cross-process serialized, crash-safe state. The lock is held across the
/// read/modify/rename transaction, never over provider or guest I/O.
pub struct Journal {
    dir: PathBuf,
    require_existing: bool,
}

impl Journal {
    pub fn open(dir: &Path) -> Result<Self> {
        private_directory(dir)?;
        Ok(Self {
            dir: dir.to_owned(),
            require_existing: false,
        })
    }

    pub fn open_existing(dir: &Path) -> Result<Self> {
        private_directory(dir)?;
        Ok(Self {
            dir: dir.to_owned(),
            require_existing: true,
        })
    }

    pub fn read(&self) -> Result<State> {
        self.transaction(|state| Ok(state.clone()))
    }

    pub fn transaction<T>(&self, f: impl FnOnce(&mut State) -> Result<T>) -> Result<T> {
        let _lock = Lock::acquire(&self.dir.join("journal.lock"))?;
        let path = self.dir.join("journal.json");
        let original = match fs::read(&path) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let mut state = match original.as_deref() {
            Some(bytes) => serde_json::from_slice(bytes)
                .context("read local VM journal; refusing to replace damaged history")?,
            None if self.require_existing => bail!(
                "Local VM history disappeared; refusing to recreate the journal or replay work"
            ),
            None => State::default(),
        };
        let result = f(&mut state)?;
        let bytes = serde_json::to_vec(&state)?;
        if original.as_deref() != Some(bytes.as_slice()) {
            atomic_private_write(&path, &bytes)?;
        }
        Ok(result)
    }

    pub fn enroll(&self, name: &str, sandbox: &str) -> Result<Environment> {
        validate_sandbox(sandbox)?;
        if name.trim().is_empty() || name.len() > 120 {
            bail!("Provide an environment name of 1–120 bytes");
        }
        self.transaction(|state| {
            if state
                .environments
                .values()
                .any(|env| env.sandbox == sandbox && env.deleted_at.is_none())
            {
                bail!("This VM is already enrolled");
            }
            let env = Environment {
                transport: Default::default(),
                id: new_id(),
                name: name.trim().into(),
                sandbox: sandbox.into(),
                generation: new_id(),
                created_at: now(),
                deleted_at: None,
                keep_awake: false,
                owned: false,
                provision: None,
                manual_control: false,
                setup: None,
            };
            state.environments.insert(env.id.clone(), env.clone());
            Ok(env)
        })
    }

    /// Called only after the host verifies the installed guest identity via
    /// the exact container transport. Enrollment never installs an account.
    pub(super) fn enroll_container(&self, name: &str, target: &crate::computer_targets::Target, runtime_sha256: &str) -> Result<Environment> {
        use crate::computer_targets::{Capability, Target};
        target.require(Capability::GuestTask)?;
        let Target::LinuxGuest { runtime, id, environment_id, generation } = target else { anyhow::bail!("An exact Linux guest target is required"); };
        validate_id(environment_id)?;
        validate_id(generation)?;
        if name.trim().is_empty() || name.len() > 120 { bail!("Provide an environment name of 1–120 bytes"); }
        super::transport::validate_runtime_sha(runtime_sha256)?;
        let transport = super::transport::Transport::LinuxContainer { runtime: *runtime, id: id.clone(), runtime_sha256: runtime_sha256.into() };
        self.transaction(|state| {
            if let Some(existing) = state.environments.get(environment_id) {
                if existing.deleted_at.is_none() && existing.transport.target(&existing.id, &existing.generation) == *target && existing.transport == transport { return Ok(existing.clone()); }
                bail!("Guest identity already has retained history; it cannot be rebound");
            }
            if state.environments.values().any(|env| env.transport.container() == transport.container()) {
                bail!("Container already has a retained guest timeline; reconcile it before reenrollment");
            }
            let env = Environment {
                transport, id: environment_id.clone(), name: name.trim().into(),
                sandbox: format!("container:{}:{id}", runtime.name()), generation: generation.clone(),
                created_at: now(), deleted_at: None, keep_awake: false, owned: false,
                provision: None, manual_control: false, setup: None,
            };
            state.environments.insert(env.id.clone(), env.clone());
            Ok(env)
        })
    }

    /// Persist before starting any external operation. The same key after an
    /// acknowledgement is lost returns precisely the same immutable target.
    #[cfg(test)]
    pub fn submit(&self, key: &str, input: TaskInput) -> Result<Task> {
        // Internal callers have just acquired this journal identity. Public
        // submissions must supply the identity observed by their picker.
        let state = self.read()?;
        let env = state.environments.get(&input.environment_id).context("Environment unavailable")?;
        let target = env.transport.target(&env.id, &env.generation);
        self.submit_selected(key, input, Some(&target))
    }

    pub fn submit_selected(&self, key: &str, input: TaskInput, selected: Option<&crate::computer_targets::Target>) -> Result<Task> {
        if key.is_empty()
            || key.len() > 200
            || input.prompt.trim().is_empty()
            || input.prompt.len() > 256 * 1024
        {
            bail!("A bounded idempotency key and nonempty task prompt are required");
        }
        validate_id(&input.parent_session_id)?;
        validate_id(&input.parent_tab_id)?;
        if input.parent_message_id.is_empty() {
            bail!("The task must refer to a parent message");
        }
        if !matches!(input.harness.as_str(), "codex" | "claude") {
            bail!("Unsupported guest harness");
        }
        if !matches!(
            input.permission_mode.as_str(),
            "plan" | "manual" | "auto" | "acceptEdits" | "bypassPermissions"
        ) {
            bail!("Unsupported permission mode");
        }
        if input.files.len() > 64 {
            bail!("Select at most 64 context files");
        }
        let mut paths = std::collections::BTreeSet::new();
        let mut bytes = 0_u64;
        for file in &input.files {
            validate_relative(&file.path)?;
            bytes = bytes
                .checked_add(file.bytes)
                .context("Context size overflow")?;
            if !paths.insert(&file.path)
                || file.sha256.len() != 64
                || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit())
                || bytes > 10 * 1024 * 1024
            {
                bail!("Invalid, duplicate or oversized context manifest");
            }
        }
        let digest = digest(&serde_json::to_vec(&input)?);
        // Receipt recovery does not acquire a new workflow or contact a guest.
        // It remains possible even after that computer is replaced or held.
        if let Some(existing) = self.read()?.tasks.values().find(|task| task.idempotency_key == key) {
            if existing.input_digest != digest { bail!("Idempotency key already names a different task input"); }
            check_submission_computer(existing, selected)?;
            return Ok(existing.clone());
        }
        let _admission = match selected {
            Some(target @ crate::computer_targets::Target::LinuxGuest { .. }) => Some(super::admission::Guard::acquire(&self.dir, target)?),
            _ => None,
        };
        self.transaction(|state| {
            if let Some(existing) = state
                .tasks
                .values()
                .find(|task| task.idempotency_key == key)
            {
                if existing.input_digest != digest {
                    bail!("Idempotency key already names a different task input");
                }
                check_submission_computer(existing, selected)?;
                return Ok(existing.clone());
            }
            let env = state
                .environments
                .get(&input.environment_id)
                .filter(|env| env.deleted_at.is_none())
                .context("Local environment unavailable; no host fallback")?;
            selected.context("An exact environment selection is required for a new task; check retained history before retrying an older submission")?.guest(&env.id, &env.generation)?;
            match env.transport {
                super::transport::Transport::MacosLume if !input.desktop => bail!("macOS tasks require the desktop workflow route"),
                super::transport::Transport::LinuxContainer { .. } if input.desktop => bail!("Linux task desktop support is not prepared; use the separate attached desktop route"),
                _ => {},
            }
            let computer = env.transport.target(&env.id, &env.generation);
            if selected != Some(&computer) { bail!("Selected task transport changed; no fallback"); }
            if super::setup::busy(env) {
                bail!("Finish this environment's guided setup and desktop verification before submitting a task");
            }
            let target = TaskTarget {
                environment_id: env.id.clone(),
                workspace_id: new_id(),
                task_id: new_id(),
                generation: env.generation.clone(),
            };
            let task = Task {
                // Keep the original macOS wire record compatible with the
                // already-installed protocol-1 guest. Linux is always explicit.
                computer: env.transport.container().map(|_| computer),
                guest_cwd: format!(
                    "{}/workspaces/{}",
                    env.transport.installation(), target.workspace_id
                ),
                target,
                input,
                idempotency_key: key.into(),
                input_digest: digest,
                worker_session_id: None,
                worker_tab_id: None,
                provider_conversation_id: None,
                status: TaskStatus::Queued,
                created_at: now(),
                updated_at: now(),
                last_event_seq: 0,
                events: vec![],
                artifacts: vec![],
                outcome: None,
                detail: None,
                dispatch_started: false,
            };
            state
                .tasks
                .insert(task.target.task_id.clone(), task.clone());
            Ok(task)
        })
    }

    /// The lease covers the complete task, including permission waits and
    /// unknown outcomes. It cannot be stolen on timeout or connection loss.
    pub fn claim(&self, target: &TaskTarget) -> Result<Task> {
        self.transaction(|state| {
            bound(state, target)?;
            let task = state.tasks.get(&target.task_id).context("Task not found")?;
            if task.status != TaskStatus::Queued {
                return Ok(task.clone());
            }
            if state.environments[&target.environment_id].manual_control {
                bail!("Guest desktop is held for manual control; return control before starting queued tasks");
            }
            if state.tasks.values().any(|other| {
                other.target.task_id != target.task_id
                    && other.target.environment_id == target.environment_id
                    && other.status.holds_desktop()
            }) {
                bail!("Guest desktop is held by another task");
            }
            let task = state.tasks.get_mut(&target.task_id).unwrap();
            task.status = TaskStatus::Starting;
            task.updated_at = now();
            Ok(task.clone())
        })
    }

    pub fn append(&self, target: &TaskTarget, event: TaskEvent) -> Result<Task> {
        self.transaction(|state| {
            let task = bound(state, target)?;
            if event.seq <= task.last_event_seq {
                if task.events.iter().any(|prior| prior == &event) {
                    return Ok(task.clone());
                }
                bail!("Guest event differs from retained history; possible snapshot rollback");
            }
            if event.seq != task.last_event_seq + 1 {
                bail!("Guest event gap: fetch retained events before continuing");
            }
            task.last_event_seq = event.seq;
            task.events.push(event);
            task.updated_at = now();
            Ok(task.clone())
        })
    }

    pub fn cancel(&self, target: &TaskTarget) -> Result<Task> {
        self.transaction(|state| {
            let task = bound(state, target)?;
            if task.status.terminal() {
                return Ok(task.clone());
            }
            task.status = if task.status == TaskStatus::Queued {
                TaskStatus::Canceled
            } else {
                TaskStatus::Canceling
            };
            task.updated_at = now();
            Ok(task.clone())
        })
    }
}

fn check_submission_computer(task: &Task, selected: Option<&crate::computer_targets::Target>) -> Result<()> {
    if let Some(selected) = selected {
        selected.guest(&task.target.environment_id, &task.target.generation)?;
        let retained = task.computer.clone().unwrap_or_else(|| super::transport::Transport::MacosLume.target(&task.target.environment_id, &task.target.generation));
        if selected != &retained { bail!("Submission retry names a different computer; retained task was not replayed"); }
    }
    Ok(())
}

pub fn bound<'a>(state: &'a mut State, target: &TaskTarget) -> Result<&'a mut Task> {
    let task = state
        .tasks
        .get_mut(&target.task_id)
        .context("Task not found")?;
    if task.target != *target {
        bail!("Wrong task/environment binding; refusing to route operation");
    }
    let env = state
        .environments
        .get(&target.environment_id)
        .context("Environment not found")?;
    if env.deleted_at.is_some() || env.generation != target.generation {
        bail!("Environment deleted or timeline changed; retained task history is read-only");
    }
    let retained = task.computer.clone().unwrap_or_else(|| super::transport::Transport::MacosLume.target(&target.environment_id, &target.generation));
    if retained != env.transport.target(&env.id, &env.generation) {
        bail!("Task transport changed; retained history is read-only and no operation was routed");
    }
    Ok(task)
}

pub fn validate_sandbox(sandbox: &str) -> Result<()> {
    let name = sandbox
        .strip_prefix("local:")
        .context("Only an explicit local guest VM can be enrolled")?;
    if name.is_empty()
        || name.len() > 80
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        bail!("Invalid local VM name");
    }
    Ok(())
}

pub fn validate_relative(path: &str) -> Result<()> {
    if path.is_empty()
        || path.contains('\\')
        || path.chars().any(char::is_control)
        || path
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == "..")
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        bail!("Task file paths must be relative, with no parent traversal");
    }
    Ok(())
}

pub fn validate_id(id: &str) -> Result<()> {
    uuid::Uuid::parse_str(id).context("Expected a stable UUID")?;
    Ok(())
}

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub fn private_directory(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::create_dir_all(path)?;
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        bail!("State directory cannot be a symlink");
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

pub fn atomic_private_write(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let temporary = path.with_extension(format!("{}.tmp", new_id()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(&temporary, path)?;
    File::open(path.parent().context("State path requires a directory")?)?.sync_all()?;
    Ok(())
}

pub(super) struct Lock(File);
impl Lock {
    pub(super) fn acquire(path: &Path) -> Result<Self> {
        use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)?;
        // SAFETY: file owns the descriptor for the entire lock lifetime.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(Self(file))
    }
}
impl Drop for Lock {
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        // SAFETY: descriptor remains valid until the File is dropped.
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn setup() -> (PathBuf, Journal, TaskInput) {
        let dir = std::env::temp_dir().join(format!("terminalx-local-{}", new_id()));
        let journal = Journal::open(&dir).unwrap();
        let env = journal
            .enroll("Test guest", "local:terminalx-test")
            .unwrap();
        let input = TaskInput {
            parent_session_id: new_id(),
            parent_tab_id: new_id(),
            parent_message_id: new_id(),
            environment_id: env.id,
            prompt: "Verify the guest app".into(),
            harness: "codex".into(),
            model: "".into(),
            effort: None,
            permission_mode: "manual".into(),
            files: vec![],
            desktop: true,
        };
        (dir, journal, input)
    }
    #[test]
    fn lost_ack_reopens_the_same_task_and_rejects_key_reuse() {
        let (dir, journal, input) = setup();
        let first = journal.submit("click-1", input.clone()).unwrap();
        let reopened = Journal::open(&dir).unwrap();
        assert_eq!(first, reopened.submit("click-1", input.clone()).unwrap());
        let mut different = input;
        different.prompt.push('!');
        assert!(reopened.submit("click-1", different).is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn selected_task_identity_survives_lost_ack_and_refuses_replacement_or_linux() {
        use crate::computer_targets::{Runtime, Target};
        let (dir, journal, input) = setup();
        let env = journal.read().unwrap().environments[&input.environment_id].clone();
        let selected = Target::MacosGuest { environment_id: env.id.clone(), generation: env.generation.clone() };
        assert!(journal.submit_selected("missing", input.clone(), None).is_err());
        let linux = Target::LinuxContainer { runtime: Runtime::Docker, id: "a".repeat(64) };
        assert!(journal.submit_selected("linux", input.clone(), Some(&linux)).is_err());
        assert!(journal.read().unwrap().tasks.is_empty());
        let first = journal.submit_selected("selected", input.clone(), Some(&selected)).unwrap();
        journal.transaction(|state| {
            let env = state.environments.get_mut(&input.environment_id).unwrap();
            env.generation = "replacement".into();
            Ok(())
        }).unwrap();
        let reopened = Journal::open_existing(&dir).unwrap();
        assert_eq!(reopened.submit_selected("selected", input.clone(), Some(&selected)).unwrap(), first);
        // Legacy pending submissions may recover an existing receipt, never create a task.
        assert_eq!(reopened.submit_selected("selected", input.clone(), None).unwrap(), first);
        assert!(reopened.submit_selected("new", input.clone(), Some(&selected)).is_err());
        let replacement = Target::MacosGuest { environment_id: env.id, generation: "replacement".into() };
        assert!(reopened.submit_selected("selected", input, Some(&replacement)).is_err());
        assert_eq!(reopened.read().unwrap().tasks.len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn desktop_lease_survives_restart_waiting_and_unknown_outcome() {
        let (dir, journal, input) = setup();
        let first = journal.submit("first", input.clone()).unwrap();
        let second = journal.submit("second", input).unwrap();
        journal.claim(&first.target).unwrap();
        for status in [
            TaskStatus::Waiting,
            TaskStatus::OutcomeUnknown,
            TaskStatus::Canceling,
        ] {
            journal
                .transaction(|state| {
                    bound(state, &first.target)?.status = status;
                    Ok(())
                })
                .unwrap();
            assert!(Journal::open(&dir).unwrap().claim(&second.target).is_err());
        }
        journal
            .transaction(|state| {
                bound(state, &first.target)?.status = TaskStatus::Canceled;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            journal.claim(&second.target).unwrap().status,
            TaskStatus::Starting
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn manual_desktop_hold_survives_restart_and_keeps_new_work_queued_until_release() {
        let (dir, journal, input) = setup();
        let task = journal
            .submit("queued-under-manual-control", input)
            .unwrap();
        journal
            .transaction(|state| {
                state
                    .environments
                    .get_mut(&task.target.environment_id)
                    .unwrap()
                    .manual_control = true;
                Ok(())
            })
            .unwrap();
        let reopened = Journal::open(&dir).unwrap();
        assert!(reopened.claim(&task.target).is_err());
        assert_eq!(
            reopened.read().unwrap().tasks[&task.target.task_id].status,
            TaskStatus::Queued
        );
        reopened
            .transaction(|state| {
                state
                    .environments
                    .get_mut(&task.target.environment_id)
                    .unwrap()
                    .manual_control = false;
                Ok(())
            })
            .unwrap();
        assert_eq!(
            reopened.claim(&task.target).unwrap().status,
            TaskStatus::Starting
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_cross_environment_routes_event_gaps_and_rollback() {
        let (dir, journal, input) = setup();
        let task = journal.submit("first", input).unwrap();
        let mut wrong = task.target.clone();
        wrong.environment_id = new_id();
        assert!(journal.claim(&wrong).is_err());
        let event = TaskEvent {
            seq: 1,
            timestamp: now(),
            payload: serde_json::json!({"progress":"working"}),
        };
        journal.append(&task.target, event.clone()).unwrap();
        journal.append(&task.target, event.clone()).unwrap();
        let mut gap = event.clone();
        gap.seq = 3;
        assert!(journal.append(&task.target, gap).is_err());
        let mut rollback = event;
        rollback.payload = Value::Null;
        assert!(journal.append(&task.target, rollback).is_err());
        assert_eq!(
            journal.read().unwrap().tasks[&task.target.task_id].last_event_seq,
            1
        );
        journal
            .transaction(|state| {
                state
                    .environments
                    .get_mut(&task.target.environment_id)
                    .unwrap()
                    .generation = new_id();
                Ok(())
            })
            .unwrap();
        assert!(journal.cancel(&task.target).is_err());
        assert_eq!(journal.read().unwrap().tasks.len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn concurrent_submit_and_claim_preserve_one_identity_and_desktop_owner() {
        let (dir, journal, input) = setup();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let threads: Vec<_> = (0..2)
            .map(|_| {
                let dir = dir.clone();
                let input = input.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    Journal::open(&dir)
                        .unwrap()
                        .submit("same-click", input)
                        .unwrap()
                })
            })
            .collect();
        barrier.wait();
        let first = threads
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(first[0].target, first[1].target);
        assert_eq!(journal.read().unwrap().tasks.len(), 1);
        let second = journal.submit("another-click", input).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let threads: Vec<_> = [first[0].target.clone(), second.target]
            .into_iter()
            .map(|target| {
                let dir = dir.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    Journal::open(&dir).unwrap().claim(&target).is_ok()
                })
            })
            .collect();
        barrier.wait();
        let results = threads
            .into_iter()
            .map(|t| t.join().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|ok| **ok).count(), 1);
        let state = journal.read().unwrap();
        assert_eq!(
            state
                .tasks
                .values()
                .filter(|t| t.status.holds_desktop())
                .count(),
            1
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn rejects_host_spaces_and_unsafe_paths() {
        for value in [
            "host",
            "direct:127.0.0.1",
            "local:",
            "local:../../host",
            "local:a;touch b",
        ] {
            assert!(validate_sandbox(value).is_err());
        }
        for value in [
            "/etc/passwd",
            "../secret",
            "a/../b",
            "a//b",
            "a/./b",
            "a\\b",
        ] {
            assert!(validate_relative(value).is_err());
        }
        assert!(validate_relative("src/main.rs").is_ok());
    }
}
