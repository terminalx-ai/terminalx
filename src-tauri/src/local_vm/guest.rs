//! Guest-only task execution. The installed identity is the authority; an RPC
//! cannot enroll a machine, choose a VM, or address a host checkout. Provider
//! credentials are installed by the user in this guest, never imported here.
//!
//! Delivery is deliberately at-most-once. A durable `sending` marker precedes
//! every prompt/permission effect. A crash between that marker and its receipt
//! becomes outcomeUnknown, retains the workflow lease, and never replays input.
//!
//! Installation writes the bound account's .terminalx-local/identity.json once (0600),
//! then a guest LaunchAgent runs terminalx-serve with the sibling runtime as
//! TERMINALX_HOME. The RPC helper reads bounded stdin and dials that runtime's
//! authenticated owner-only socket; inherited control credentials are removed.
//! Only explicitly hashed input files and the selected prompt/settings cross
//! this boundary. Provider/repository login happens separately inside the guest.
//! Provider MCP configuration exposes only local-vm-computer --stdio --task
//! <bound target>, whose proxy checks the durable workflow lease per request.
//! Task history and immutable artifact copies have no automatic expiration.
//! A retained kernel boot UUID permits explicit cancellation/recovery after
//! a proven guest reboot. Runtime restart alone never proves worker death.
//! Recovery persists only new human instructions and emits a keyed receipt
//! only after the provider confirms delivery and that receipt is checkpointed.
//! Individual artifacts above 12 MiB, symlinks, or output trees above 1024
//! files require explicit export; retention limits are reported in task.detail.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc::{self, Receiver, TryRecvError},
    Arc, Mutex,
};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

fn check_setup_identity(base: &Path) -> Result<()> {
    if cfg!(target_os = "linux") {
        if base != installation()? || !Guest::installed_for_root(&base.join("runtime"))? {
            bail!("Linux setup requires the installed dedicated guest identity");
        }
        Ok(())
    } else {
        super::desktop::check_identity()
    }
}

fn check_setup_action(linux: bool, action: setup::Action) -> Result<()> {
    if linux && !matches!(action, setup::Action::LoginStart | setup::Action::LoginCancel | setup::Action::AccountVerify) {
        bail!("Linux shell task setup supports only guest-owned Codex account actions");
    }
    Ok(())
}

#[path = "guest_readiness.rs"]
pub(super) mod readiness;
#[path = "guest_setup.rs"]
mod setup;
#[path = "guest_attachment.rs"]
mod attachment;

use super::journal::{
    atomic_private_write, digest, now, private_directory, validate_id, validate_relative, Artifact,
    Task, TaskEvent, TaskStatus, TaskTarget, PROTOCOL,
};
use crate::events::{AgentEvent, Payload, TurnStatus};
use crate::session::SessionManager;
use crate::sink::EventSink;

pub const MAX_RPC_BYTES: usize = 16 * 1024 * 1024;
const MAX_FILES_BYTES: usize = 11 * 1024 * 1024;
const MAX_ARTIFACT_BYTES: usize = 12 * 1024 * 1024;
const PAGE_BYTES: usize = 1024 * 1024;
#[cfg(target_os = "linux")]
const INSTALL: &str = super::transport::LINUX_INSTALL;
#[cfg(not(target_os = "linux"))]
const INSTALL: &str = "/Users/lume/.terminalx-local";
pub(super) fn installation() -> Result<PathBuf> {
    #[cfg(target_os = "macos")]
    { super::macos_account::installation() }
    #[cfg(not(target_os = "macos"))]
    { Ok(PathBuf::from(INSTALL)) }
}

pub(super) fn installed_identity() -> Result<(PathBuf, Identity)> {
    let base = installation()?;
    let identity = Identity::load(&base)?;
    #[cfg(target_os = "macos")]
    {
        super::macos_account::check_installation_binding(&base, identity.macos_account.as_ref())?;
        if identity.macos_account.is_none() { super::macos_account::check_legacy_user()?; }
    }
    Ok((base, identity))
}

fn installation_present_at(base: &Path) -> Result<bool> {
    match fs::symlink_metadata(base) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
        Ok(metadata) if !metadata.is_dir() => bail!("Guest installation cannot be a symlink or file"),
        Ok(_) => (),
    }
    fs::symlink_metadata(base.join("identity.json"))
        .context("Guest installation is incomplete or its identity disappeared; no host fallback")?;
    Ok(true)
}

const STATE: &str = "local-vm-guest/state.json";
const PRIOR_OUTCOME_UNKNOWN: &str = "The previous worker has stopped, but its earlier external actions remain outcome unknown. Recovery sends only the explicitly confirmed new instructions.";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub environment_id: String,
    pub generation: String,
    pub protocol: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<super::linux_profile::Account>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub macos_account: Option<super::macos_account::Account>,
}

impl Identity {
    fn load(base: &Path) -> Result<Self> {
        let path = base.join("identity.json");
        let mut file = OpenOptions::new().read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(&path)
            .context("Guest identity is not installed")?;
        let metadata = file.metadata()?;
        // SAFETY: geteuid has no arguments or memory preconditions.
        if !metadata.is_file()
            || metadata.permissions().mode() & 0o077 != 0
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            bail!("Guest identity must be an owner-only regular file owned by this user");
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file).take(4097).read_to_end(&mut bytes)?;
        if bytes.len() > 4096 { bail!("Guest identity exceeds its bound"); }
        let identity: Self = serde_json::from_slice(&bytes)?;
        if identity.account.is_some() && identity.macos_account.is_some() {
            bail!("Guest identity cannot bind two operating-system accounts");
        }
        if let Some(account)=&identity.account { account.check_current()?; }
        if let Some(account)=&identity.macos_account { account.check_current(base)?; }
        validate_id(&identity.environment_id)?;
        validate_id(&identity.generation)?;
        if identity.protocol != PROTOCOL {
            bail!("Incompatible local guest protocol");
        }
        Ok(identity)
    }

    fn check_account(&self, expected: Option<&super::macos_account::Account>, runtime: Option<&str>) -> Result<()> {
        if expected != self.macos_account.as_ref() {
            bail!("Guest personalized account differs from the retained transport binding");
        }
        if self.macos_account.is_some() {
            super::transport::validate_runtime_sha(runtime.context("Personalized runtime digest required")?)?;
        }
        Ok(())
    }

    fn check(&self, params: &Value) -> Result<()> {
        if params["environmentId"].as_str() != Some(&self.environment_id)
            || params["generation"].as_str() != Some(&self.generation)
        {
            bail!("Guest environment/generation mismatch; no operation was routed");
        }
        Ok(())
    }
}

fn check_runtime(expected: Option<&str>, actual: &str) -> Result<()> {
    if expected.is_some_and(|expected| expected != actual) || (cfg!(target_os = "linux") && expected.is_none()) {
        bail!("Guest runtime artifact changed or is unbound; no operation was routed");
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    #[serde(default, rename = "expectedRuntimeSha256")]
    pub expected_runtime_sha256: Option<String>,
    #[serde(default, rename = "expectedMacosAccount")]
    pub expected_macos_account: Option<super::macos_account::Account>,
    pub method: String,
    pub params: Value,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileInput {
    path: String,
    content_base64: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Operation {
    digest: String,
    /// Set before the effect, cleared only after a durable receipt.
    sending: bool,
    error: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    task: Task,
    files: Vec<FileInput>,
    baseline: Option<String>,
    source_seq: u64,
    source_events: u64,
    operations: BTreeMap<String, Operation>,
    artifacts_pending: bool,
    /// OS boot during the most recent execution attempt. Runtime restarts
    /// cannot prove process death; a different kernel boot UUID can.
    #[serde(default)]
    boot_identity: Option<String>,
    #[serde(default)]
    prior_external_outcome_unknown: bool,
}

struct RecoveryReceipt {
    target: TaskTarget,
    idempotency_key: String,
    operation_key: String,
    receiver: Receiver<std::result::Result<(), String>>,
    result: Option<std::result::Result<(), String>>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManualLease {
    target: TaskTarget,
    acquired_at: String,
    #[serde(default)]
    ready: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct State {
    identity: Identity,
    records: BTreeMap<String, Record>,
    #[serde(default)]
    canceled_targets: BTreeMap<String, TaskTarget>,
    #[serde(default)]
    manual_lease: Option<ManualLease>,
    /// Captured before accepting work, never advanced on daemon restart. A
    /// later kernel boot can prove that pre-initialization processes exited.
    #[serde(default)]
    provisioning_baseline: Option<ProvisioningBaseline>,
    #[serde(default)]
    setup_operations: BTreeMap<String, setup::Operation>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    attachments: BTreeMap<String, attachment::Lease>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProvisioningBaseline {
    timeline_id: String,
    boot_identity: String,
    #[serde(default)]
    no_execution: bool,
}

pub struct Guest {
    base: PathBuf,
    state: Mutex<State>,
    manager: SessionManager,
    sink: Arc<dyn EventSink>,
    stopped: AtomicBool,
    boot_identity: Option<String>,
    runtime_sha256: String,
    recovery_receipts: Mutex<Vec<RecoveryReceipt>>,
    setup_actor: setup::Actor,
    attachment_peers: Mutex<BTreeMap<String, setup::desktop_mcp::Peer>>,
    _lock: File,
}

impl Guest {
    pub fn installation_present() -> Result<bool> {
        installation_present_at(&installation()?)
    }

    /// Determine role before enabling generic local-owner lifecycle services.
    /// An invalid pinned installation is an error, never host/cloud fallback.
    pub fn installed_for_root(root: &Path) -> Result<bool> {
        if !Self::installation_present()? {
            return Ok(false);
        }
        let (base, _) = installed_identity()?;
        if !cfg!(any(all(target_os = "macos", target_arch = "aarch64"), all(target_os = "linux", any(target_arch = "aarch64", target_arch = "x86_64")))) {
            bail!("Unsupported local guest platform");
        }
        #[cfg(target_os = "linux")]
        {
            // Linux host runtimes cannot become guests via a home override.
            // Identity ownership and the pinned installation/root are checked
            // independently; a root-owned default account is never accepted.
            // SAFETY: geteuid has no arguments or memory preconditions.
            if unsafe { libc::geteuid() } == 0 || dirs::home_dir().as_deref() != Some(Path::new("/home/cua")) {
                bail!("Linux task runtime requires the dedicated non-root cua account");
            }
        }
        if fs::canonicalize(root)? != fs::canonicalize(base.join("runtime"))? {
            bail!("Guest runtime must use the installed private runtime directory");
        }
        Ok(true)
    }

    /// Absence of an installation leaves ordinary headless runtimes unchanged.
    /// An invalid installation is an error, never a fallback to local control.
    pub fn installed(
        manager: SessionManager,
        sink: Arc<dyn EventSink>,
    ) -> Result<Option<Arc<Self>>> {
        let base = installation()?;
        if !Self::installed_for_root(&crate::store::root()?)? {
            return Ok(None);
        }
        let guest = Arc::new(Self::open(base, manager, sink)?);
        let weak = Arc::downgrade(&guest);
        std::thread::Builder::new()
            .name("local-vm-guest".into())
            .spawn(move || loop {
                let Some(guest) = weak.upgrade() else { break };
                if guest.stopped.load(Ordering::Acquire) {
                    break;
                }
                if let Err(error) = guest.tick() {
                    log::error!("guest task checkpoint: {error:#}");
                }
                drop(guest);
                std::thread::sleep(Duration::from_millis(250));
            })?;
        Ok(Some(guest))
    }

    fn open(base: PathBuf, manager: SessionManager, sink: Arc<dyn EventSink>) -> Result<Self> {
        let identity = Identity::load(&base)?;
        let previously_initialized = base
            .join("runtime/local-vm-guest/owner.lock")
            .try_exists()?
            || base.join("runtime").join(STATE).try_exists()?;
        for name in [
            "runtime",
            "runtime/local-vm-guest",
            "workspaces",
            "artifacts",
        ] {
            private_directory(&base.join(name))?;
        }
        if !previously_initialized {
            private_directory(&crate::store::root()?.join("sessions"))?;
        }
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(base.join("runtime/local-vm-guest/owner.lock"))?;
        use std::os::fd::AsRawFd;
        // SAFETY: the file descriptor stays owned by Guest for its lifetime.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            bail!("Another guest runtime owns this installation");
        }
        let path = base.join("runtime").join(STATE);
        let mut state: State = if path.try_exists()? {
            serde_json::from_slice(&read_bounded(&path, 512 * 1024 * 1024)?)
                .context("Damaged guest task history; refusing to replace it")?
        } else {
            if previously_initialized {
                bail!("Initialized guest task history is missing; refusing to reset the timeline");
            }
            State {
                identity: identity.clone(),
                records: BTreeMap::new(),
                canceled_targets: BTreeMap::new(),
                manual_lease: None,
                provisioning_baseline: None,
                setup_operations: BTreeMap::new(),
                attachments: BTreeMap::new(),
            }
        };
        if state.identity != identity {
            bail!("Guest timeline changed; retained execution history cannot be rebound");
        }
        let boot_identity = boot_identity();
        if state.provisioning_baseline.is_none() {
            // A legacy/restarted owner cannot retrospectively manufacture a
            // no-execution receipt. New installations checkpoint this marker
            // before accepting task RPCs; all task records precede effects and
            // are retained forever, including canceled-before-start targets.
            let initial_data = if !previously_initialized {
                Some(retained_data(&base, &state)?)
            } else {
                None
            };
            let no_execution = !previously_initialized
                && state.records.is_empty()
                && state.canceled_targets.is_empty()
                && fs::read_dir(base.join("workspaces"))?.next().is_none()
                && fs::read_dir(base.join("artifacts"))?.next().is_none()
                && initial_data.as_ref().is_some_and(|data| {
                    data["sessionIndexHasData"] == false
                        && data["sessionEntries"].as_array().is_some_and(Vec::is_empty)
                })
                && manager.terminals().owned_groups().is_empty();
            state.provisioning_baseline = boot_identity.as_ref().map(|boot| ProvisioningBaseline {
                timeline_id: super::journal::new_id(),
                boot_identity: boot.clone(),
                no_execution,
            });
        }
        for record in state.records.values_mut() {
            if record.task.status.holds_desktop() {
                unknown(record, "Guest runtime restarted during execution; no prompt or permission was replayed");
            }
        }
        for (key, operation) in state.setup_operations.iter_mut() {
            operation.validate(key, &identity)?;
            operation.interrupted();
        }
        atomic_private_write(&path, &serde_json::to_vec(&state)?)?;
        Ok(Self {
            base,
            state: Mutex::new(state),
            manager,
            sink,
            stopped: AtomicBool::new(false),
            boot_identity,
            runtime_sha256: super::bootstrap::owner_runtime_sha256()?,
            recovery_receipts: Mutex::new(vec![]),
            setup_actor: setup::Actor::default(),
            attachment_peers: Mutex::new(BTreeMap::new()),
            _lock: lock,
        })
    }

    fn save(&self, state: &State) -> Result<()> {
        atomic_private_write(
            &self.base.join("runtime").join(STATE),
            &serde_json::to_vec(state)?,
        )
    }

    pub fn shutdown(&self) {
        self.stopped.store(true, Ordering::Release);
        self.setup_actor.shutdown();
        // Task collection may hold this mutex across bounded external I/O.
        // Shutdown must fence helpers without waiting on that workflow. Its
        // earlier durable intent already prevents replay after a lost receipt.
        if let Ok(mut state) = self.state.try_lock() {
            if self.checkpoint_setup(&mut state).is_err() {
                log::warn!(
                    "Guest setup shutdown receipt was not checkpointed; outcome remains unknown"
                );
            }
        }
    }

    pub fn dispatch(&self, request: Request) -> Result<Value> {
        check_runtime(request.expected_runtime_sha256.as_deref(), &self.runtime_sha256)?;
        if self.stopped.load(Ordering::Acquire) {
            bail!("Guest runtime is stopping; no task operation was routed");
        }
        // Re-read the installation identity so an in-place rollback/reinstall
        // invalidates even a process that is still running.
        let identity = Identity::load(&self.base)?;
        identity.check(&request.params)?;
        identity.check_account(request.expected_macos_account.as_ref(), request.expected_runtime_sha256.as_deref())?;
        if identity != self.state.lock().unwrap().identity {
            bail!("Guest identity changed; restart/reconcile required");
        }
        self.checkpoint_setup(&mut self.state.lock().unwrap())?;
        match request.method.as_str() {
            "describe" => self.describe(),
            "environment.setupReadiness" => self.setup_readiness(&request.params),
            "environment.setupAction" => self.setup_action(&request.params),
            "environment.setupAuth" => self.setup_auth(&request.params),
            "environment.setupActionStatus" => self.setup_action_status(&request.params),
            "environment.disposition" => self.disposition(),
            "environment.provisionEvidence" => self.provision_evidence(),
            "desktop.state" => Ok(desktop_state(&self.state.lock().unwrap())),
            "desktop.attachmentAcquire" => self.attachment_acquire(&request.params),
            "desktop.attachmentCapabilities" => self.attachment_capabilities(),
            "desktop.attachmentTools" => self.attachment_tools(&request.params),
            "desktop.attachmentClose" => self.attachment_close(&request.params),
            "desktop.attachmentRead" => self.attachment_read(&request.params),
            "desktop.attachmentCall" => self.attachment_call(&request.params),
            "desktop.attachmentRelease" => self.attachment_release(&request.params),
            "desktop.takeover" => self.takeover(&request.params),
            "desktop.release" => self.release_desktop(&request.params),
            "task.start" => self.start(&request.params),
            "task.poll" => {
                let target = target(&request.params)?;
                let after = request.params["after"]
                    .as_u64()
                    .context("A nonnegative sequence cursor is required")?;
                let state = self.state.lock().unwrap();
                let record = bound(&state, &target)?;
                serde_json::to_value(page(&record.task, after)?).map_err(Into::into)
            }
            "task.cancel" => self.cancel(&target(&request.params)?),
            "task.recover" => self.recover(&request.params),
            "task.followup" | "task.permission" => self.mutate(&request.method, &request.params),
            "task.artifact" => self.artifact(&request.params),
            _ => bail!("Unsupported bounded guest method"),
        }
    }

    fn checkpoint_setup(&self, state: &mut State) -> Result<()> {
        let mut next = state.clone();
        let mut changed = false;
        for update in self.setup_actor.receipts() {
            let Some(op) = next
                .setup_operations
                .get_mut(&update.receipt.idempotency_key)
            else {
                continue;
            };
            if op.receipt.action != update.receipt.action {
                bail!("Guest setup receipt action mismatch");
            }
            if op.receipt != update.receipt
                || op.helper_exit_confirmed != update.helper_exit_confirmed
            {
                // A terminal receipt is immutable, including outcomeUnknown.
                if !matches!(
                    op.receipt.status,
                    setup::Status::Working | setup::Status::NeedsAttention
                ) {
                    // External uncertainty is immutable, but later positive
                    // owned-group exit evidence may release helper admission.
                    if update.helper_exit_confirmed && !op.helper_exit_confirmed {
                        op.helper_exit_confirmed = true;
                        changed = true;
                    }
                    continue;
                }
                op.receipt = update.receipt;
                op.helper_exit_confirmed = update.helper_exit_confirmed;
                changed = true;
            }
        }
        if changed {
            self.save(&next)?;
            *state = next;
        }
        Ok(())
    }

    fn setup_action(&self, params: &Value) -> Result<Value> {
        self.setup_action_using(params, |actor, params, base, login_allowed| {
            actor.launch(params, base, login_allowed)
        })
    }

    fn setup_action_using(
        &self,
        params: &Value,
        launch: impl FnOnce(&setup::Actor, setup::Params, &Path, bool) -> Result<()>,
    ) -> Result<Value> {
        let params: setup::Params = serde_json::from_value(params.clone())?;
        check_setup_action(cfg!(target_os = "linux"), params.action)?;
        let mut state = self.state.lock().unwrap();
        params.validate(&state.identity)?;
        if let Some(op) = state.setup_operations.get(&params.idempotency_key) {
            if op.digest != params.digest()? {
                bail!("Guest setup key already names different immutable input");
            }
            return serde_json::to_value(&op.receipt).map_err(Into::into);
        }
        if self.stopped.load(Ordering::Acquire) || Identity::load(&self.base)? != state.identity {
            bail!("Guest setup owner stopped or identity changed");
        }
        let retained: State = serde_json::from_slice(&read_bounded(
            &self.base.join("runtime").join(STATE),
            512 * 1024 * 1024,
        )?)?;
        if serde_json::to_value(&retained)? != serde_json::to_value(&*state)? {
            bail!("Retained guest state changed; no setup effect started");
        }
        if attachment::held(&state) || state.manual_lease.is_some()
            || state.records.values().any(|r| !r.task.status.terminal())
            || !self.manager.terminals().owned_groups().is_empty()
        {
            bail!("Guest work or manual control must be resolved before setup");
        }
        let cancel = params.action == setup::Action::LoginCancel;
        let boot = boot_identity();
        if !cancel && (self.setup_actor.busy() || setup::holds_admission(&state, boot.as_deref())) {
            bail!("A setup helper still owns guest admission; inspect or explicitly cancel it");
        }
        if cancel
            && state.setup_operations.values().any(|op| {
                op.receipt.action == setup::Action::LoginCancel && op.holds(boot.as_deref())
            })
        {
            bail!("An explicit login cancellation is already unresolved");
        }
        let login_allowed = !state.setup_operations.values().any(|op| {
            op.receipt.action == setup::Action::LoginStart
                && op.receipt.status == setup::Status::OutcomeUnknown
        });
        let operation = setup::Operation::working(&params, boot)?;
        let mut next = state.clone();
        next.setup_operations
            .insert(params.idempotency_key.clone(), operation);
        if let Some(baseline) = next.provisioning_baseline.as_mut() {
            baseline.no_execution = false;
        }
        self.save(&next)?; // Intent before CLI spawn, LaunchServices, login or capture.
        *state = next;
        if launch(&self.setup_actor, params.clone(), &self.base, login_allowed).is_err() {
            let mut next = state.clone();
            let op = next
                .setup_operations
                .get_mut(&params.idempotency_key)
                .unwrap();
            op.receipt.status = setup::Status::Failed;
            op.receipt.detail = Some("setup_actor_not_started".into());
            op.helper_exit_confirmed = true;
            self.save(&next)?;
            *state = next;
        }
        self.checkpoint_setup(&mut state)?;
        serde_json::to_value(&state.setup_operations[&params.idempotency_key].receipt)
            .map_err(Into::into)
    }

    fn setup_auth(&self, params: &Value) -> Result<Value> {
        let params: setup::AuthParams = serde_json::from_value(params.clone())?;
        setup::key(&params.idempotency_key)?;
        let state = self.state.lock().unwrap();
        params.check(&state.identity)?;
        Ok(self.setup_actor.auth(&state, &params.idempotency_key))
    }

    fn setup_action_status(&self, params: &Value) -> Result<Value> {
        let params: setup::AuthParams = serde_json::from_value(params.clone())?;
        setup::key(&params.idempotency_key)?;
        let state = self.state.lock().unwrap();
        params.check(&state.identity)?;
        let operation = state
            .setup_operations
            .get(&params.idempotency_key)
            .context("No durable guest setup operation exists for this exact key")?;
        serde_json::to_value(&operation.receipt).map_err(Into::into)
    }

    fn setup_readiness(&self, params: &Value) -> Result<Value> {
        let params: readiness::ReadinessParams = serde_json::from_value(params.clone())?;
        params.validate()?;
        // Observation cannot release a manual reservation, claim a workflow,
        // refresh provider credentials, or start a desktop/provider process.
        let observed = readiness::observe(&self.base, params.harness)?;
        let identity = Identity::load(&self.base)?;
        let state = self.state.lock().unwrap();
        if self.stopped.load(Ordering::Acquire) || identity != state.identity {
            bail!("Guest identity changed or runtime stopped during readiness inspection");
        }
        let mut value = serde_json::to_value(readiness::Readiness::new(
            &identity,
            &state,
            observed,
            !self.manager.terminals().owned_groups().is_empty() || self.setup_actor.busy(),
        ))?;
        value["runtime"]["executableSha256"] = json!(self.runtime_sha256);
        value["runtime"]["bootIdentity"] = json!(boot_identity());
        Ok(value)
    }

    fn describe(&self) -> Result<Value> {
        // Independent, bounded read-only probes run together: two 15s model
        // probes plus a 25s driver probe must fit the host's 45s RPC budget.
        let (harnesses, desktop) = std::thread::scope(|scope| {
            let desktop = scope.spawn(desktop_ready);
            let probes: Vec<_> = crate::harness::offered().into_iter()
                .filter(|h| h.available && matches!(h.id.as_str(), "codex" | "claude") && (!cfg!(target_os = "linux") || h.id == "codex"))
                .map(|h| scope.spawn(move || {
                    let models = match discover_models(&h.id) {
                        Ok(models) => models,
                        Err(error) => { log::warn!("guest {} model discovery: {error:#}", h.id); Vec::new() }
                    };
                    json!({"id":h.id,"models":models,"permissionModes":["plan","manual","auto","acceptEdits","bypassPermissions"]})
                })).collect();
            (
                probes
                    .into_iter()
                    .filter_map(|p| p.join().ok())
                    .collect::<Vec<_>>(),
                desktop.join().unwrap_or(false),
            )
        });
        let available = (desktop || cfg!(target_os = "linux"))
            && harnesses
                .iter()
                .any(|h| h["models"].as_array().is_some_and(|m| !m.is_empty()));
        let mut capabilities = vec![
            "task.poll",
            "task.cancel",
            "task.artifact",
            "task.followup",
            "task.permission",
            "task.recover",
            "environment.disposition",
            "environment.setupReadiness",
            "environment.setupAction",
            "environment.setupAuth",
            "desktop.state",
            "desktop.takeover",
            "desktop.release",
        ];
        if cfg!(target_os = "linux") {
            capabilities.retain(|capability| !matches!(*capability,
                "desktop.takeover" | "desktop.release"));
        }
        if available {
            capabilities.push(if cfg!(target_os = "linux") { "task.submitShell" } else { "task.submit" });
        }
        let state = self.state.lock().unwrap();
        let identity = &state.identity;
        Ok(
            json!({"available":available,"reason":if !desktop && !cfg!(target_os = "linux") {Some("Guest desktop MCP binding is unavailable")} else if !available {Some("Install and authenticate a supported guest harness")} else {None},
            "protocol":PROTOCOL,"identity":identity,"runtimeSha256":self.runtime_sha256,"platform":std::env::consts::OS,"environmentId":identity.environment_id,
            "generation":identity.generation,"capabilities":capabilities,"harnesses":harnesses,
            "desktopAvailable":desktop,"taskMode":if cfg!(target_os = "linux") {"shellFiles"} else {"desktop"},"manualControl":state.manual_lease.is_some(),
            "credentials":"Guest-installed provider/repository credentials only; no host credentials are copied"}),
        )
    }

    fn start(&self, params: &Value) -> Result<Value> {
        let task: Task =
            serde_json::from_value(params["task"].clone()).context("Invalid guest task record")?;
        let files: Vec<FileInput> = serde_json::from_value(params["files"].clone())
            .context("Explicit files array is required")?;
        let mut state = self.state.lock().unwrap();
        validate_task(&state.identity, &self.base, &task, &files)?;
        if let Some(super::transport::Transport::MacosPersonalized { binding }) = &task.transport_binding {
            check_runtime(Some(&binding.runtime_sha256), &self.runtime_sha256)?;
        }
        if state.canceled_targets.contains_key(&task.target.task_id) {
            bail!("This task target was canceled before start; delayed starts are refused");
        }
        if state.records.values().any(|record| {
            record.task.target.workspace_id == task.target.workspace_id
                && record.task.target.task_id != task.target.task_id
        }) {
            bail!("Guest workspace is already bound to another task");
        }
        if let Some(prior) = state.records.values().find(|r| {
            r.task.idempotency_key == task.idempotency_key
                || r.task.target.task_id == task.target.task_id
        }) {
            if prior.task.target != task.target
                || prior.task.transport_binding != task.transport_binding
                || prior.task.idempotency_key != task.idempotency_key
                || prior.task.input_digest != task.input_digest
            {
                bail!("Idempotency key/target already names different input");
            }
            return Ok(serde_json::to_value(page(&prior.task, 0)?)?);
        }
        // Retrying an existing task above is always allowed, even when a
        // provider or desktop is presently unavailable.
        require_queue_control(&state)?;
        task_capability(&self.base, &task)?;
        let mut task = task;
        task.status = TaskStatus::Queued;
        task.worker_session_id = None;
        task.worker_tab_id = None;
        task.provider_conversation_id = None;
        task.events.clear();
        task.last_event_seq = 0;
        task.artifacts.clear();
        task.outcome = None;
        task.detail = None;
        task.updated_at = now();
        event(&mut task, json!({"type":"queued"}));
        state.records.insert(
            task.target.task_id.clone(),
            Record {
                task: task.clone(),
                files,
                baseline: None,
                source_seq: 0,
                source_events: 0,
                operations: BTreeMap::new(),
                artifacts_pending: false,
                boot_identity: self.boot_identity.clone(),
                prior_external_outcome_unknown: false,
            },
        );
        self.save(&state)?; // Before directories, files, sessions or prompts.
        Ok(serde_json::to_value(task)?)
    }

    /// Runs without a connected host. Queued tasks, transcript checkpoints,
    /// completion and artifact retention are owned by this runtime thread.
    fn tick(&self) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        if Identity::load(&self.base)? != state.identity {
            bail!("Installed guest identity changed");
        }
        self.checkpoint_recovery_receipts(&mut state)?;
        self.checkpoint_setup(&mut state)?;
        let previous = serde_json::to_vec(&*state)?;
        let ids: Vec<_> = state.records.keys().cloned().collect();
        for id in ids {
            let record = state.records.get_mut(&id).unwrap();
            if matches!(
                record.task.status,
                TaskStatus::Running | TaskStatus::Waiting | TaskStatus::Canceling
            ) {
                self.collect(record)?;
            }
            if record.artifacts_pending {
                match self.retain(record) {
                    Ok(()) => record.artifacts_pending = false,
                    Err(error) => {
                        let prior = if record.prior_external_outcome_unknown {
                            PRIOR_OUTCOME_UNKNOWN
                        } else {
                            ""
                        };
                        record.task.detail =
                            Some(format!("Result retention incomplete: {error:#}. {prior}"))
                    }
                }
            }
        }
        if serde_json::to_vec(&*state)? != previous {
            self.save(&state)?;
        }
        if setup::holds_admission(&state, self.boot_identity.as_deref())
            || self.setup_actor.busy()
            || state.manual_lease.is_some()
            || attachment::held(&state)
            || state
                .records
                .values()
                .any(|r| r.task.status.holds_desktop())
        {
            return Ok(());
        }
        let next = state
            .records
            .values()
            .filter(|r| r.task.status == TaskStatus::Queued)
            .min_by_key(|r| r.task.created_at.clone())
            .map(|r| r.task.target.task_id.clone());
        if let Some(id) = next {
            let record = state.records.get_mut(&id).unwrap();
            record.task.status = TaskStatus::Starting;
            record.boot_identity = self.boot_identity.clone();
            event(&mut record.task, json!({"type":"starting"}));
            self.save(&state)?; // Whole-workflow lease before any effect.
            let result = self.launch(state.records.get_mut(&id).unwrap());
            let record = state.records.get_mut(&id).unwrap();
            if let Err(error) = result {
                if record.operations.contains_key("start") {
                    unknown(
                        record,
                        &format!("Guest start was not acknowledged: {error:#}"),
                    );
                } else {
                    record.task.status = TaskStatus::Failed;
                    record.task.detail = Some(format!(
                        "Guest setup failed before prompt delivery: {error:#}"
                    ));
                    event(
                        &mut record.task,
                        json!({"type":"startFailedBeforeDelivery"}),
                    );
                }
            }
            self.save(&state)?;
        }
        Ok(())
    }

    fn launch(&self, record: &mut Record) -> Result<()> {
        task_capability(&self.base, &record.task)?;
        let models = discover_models(&record.task.input.harness)?;
        validate_model(&record.task, &models)?;
        if record.task.input.harness == "codex"
            && self
                .manager
                .codex_models()
                .substitute_for(&record.task.input.model)
                .is_some()
        {
            bail!(
                "Runtime cannot preserve the selected guest model; refusing automatic substitution"
            );
        }
        let cwd = PathBuf::from(&record.task.guest_cwd);
        // create_new directory: never merge selected inputs over an old or
        // provider-controlled worktree after a crash.
        fs::create_dir(&cwd).context("Create a fresh guest task workspace")?;
        fs::set_permissions(&cwd, fs::Permissions::from_mode(0o700))?;
        for file in &record.files {
            let path = cwd.join(&file.path);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            let bytes = STANDARD.decode(&file.content_base64)?;
            atomic_private_write(&path, &bytes)?;
        }
        git(&cwd, &["init", "--quiet"], None)?;
        git(&cwd, &["add", "--all", "--", "."], None)?;
        record.baseline = Some(
            String::from_utf8(git(&cwd, &["write-tree"], None)?)?
                .trim()
                .into(),
        );
        let entry = crate::session_ops::create_quick_chat_blocking(
            self.sink.as_ref(),
            crate::session_ops::NewQuickChat {
                title: Some(format!("Guest task {}", record.task.target.task_id)),
                cwd: Some(record.task.guest_cwd.clone()),
                tab: Some(crate::session_ops::NewTab {
                    harness: record.task.input.harness.clone(),
                    model: record.task.input.model.clone(),
                    effort: record.task.input.effort.clone(),
                    permission_mode: Some(record.task.input.permission_mode.clone()),
                }),
            },
        )
        .map_err(anyhow::Error::msg)?;
        let tab = entry
            .tabs
            .first()
            .context("Guest session has no agent tab")?;
        record.task.worker_session_id = Some(entry.id.clone());
        record.task.worker_tab_id = Some(tab.id.clone());
        record.operations.insert(
            "start".into(),
            Operation {
                digest: record.task.input_digest.clone(),
                sending: true,
                error: None,
            },
        );
        // Persist the worker identity AND ambiguous-delivery marker before
        // SessionManager starts a PTY or writes a single prompt keystroke.
        self.save_record(record)?;
        self.manager
            .send(&entry.id, &tab.id, record.task.input.prompt.clone(), vec![])?;
        record.operations.get_mut("start").unwrap().sending = false;
        record.task.status = TaskStatus::Running;
        record.files.clear(); // Selected bytes remain in the isolated workspace.
        event(
            &mut record.task,
            json!({"type":"running","sessionId":entry.id,"tabId":tab.id}),
        );
        Ok(())
    }

    // launch/mutate already hold the in-memory mutex; the on-disk copy is
    // atomic and supplies launch_config without re-entering that mutex.
    fn save_record(&self, record: &Record) -> Result<()> {
        let path = self.base.join("runtime").join(STATE);
        let mut state: State = serde_json::from_slice(&fs::read(&path)?)?;
        state
            .records
            .insert(record.task.target.task_id.clone(), record.clone());
        self.save(&state)
    }

    fn collect(&self, record: &mut Record) -> Result<()> {
        let (Some(session), Some(tab)) =
            (&record.task.worker_session_id, &record.task.worker_tab_id)
        else {
            return Ok(());
        };
        let (session, tab) = (session.clone(), tab.clone());
        // Reading the durable log does not instantiate/resume a worker.
        let events: Vec<AgentEvent> =
            crate::store::read_lines(&crate::store::log_path(&session, &tab)?)?;
        if events.len() < record.source_events as usize {
            unknown(record, "Provider transcript rolled back");
            return Ok(());
        }
        let retained: Vec<_> = record
            .task
            .events
            .iter()
            .filter(|e| e.payload.get("sessionId").is_some() && e.payload.get("seq").is_some())
            .collect();
        if retained.len() != record.source_events as usize
            || retained.iter().zip(&events).any(|(prior, source)| {
                serde_json::to_value(source).ok().as_ref() != Some(&prior.payload)
            })
        {
            unknown(
                record,
                "Retained provider transcript changed; possible timeline rollback",
            );
            return Ok(());
        }
        let mut completed = None;
        for source in events.iter().skip(record.source_events as usize) {
            if source.session_id != session
                || source.tab_id != tab
                || source.seq <= record.source_seq
            {
                unknown(record, "Provider transcript identity/sequence changed");
                return Ok(());
            }
            record.source_seq = source.seq;
            record.source_events += 1;
            event(&mut record.task, serde_json::to_value(source)?);
            if source.subagent.is_none() {
                if let Payload::TurnCompleted {
                    status,
                    final_text,
                    auth_failed,
                    ..
                } = &source.payload
                {
                    completed = Some((
                        match status {
                            TurnStatus::Ok => TaskStatus::Completed,
                            TurnStatus::Error => TaskStatus::Failed,
                            TurnStatus::Aborted => TaskStatus::Canceled,
                        },
                        final_text.clone(),
                        *auth_failed,
                    ));
                }
                if matches!(
                    &source.payload,
                    Payload::TurnStarted { .. } | Payload::UserMessage { .. }
                ) {
                    completed = None;
                }
            }
        }
        if let Ok(entry) = crate::store::index::get(&session) {
            record.task.provider_conversation_id =
                entry.tab(&tab).and_then(|t| t.provider_session_id.clone());
        }
        if let Some((status, final_text, auth_failed)) = completed {
            // No task releases the desktop while an autonomous CLI remains
            // alive. A later explicit follow-up resumes this conversation.
            if self.manager.is_running(&session, &tab) {
                self.stop_worker(&session, &tab)?;
            }
            record.task.status = if auth_failed {
                TaskStatus::Waiting
            } else {
                status
            };
            record.task.outcome = final_text;
            record.task.detail = match (auth_failed, record.prior_external_outcome_unknown) {
                (true, true) => Some(format!(
                    "Guest provider login is required. {PRIOR_OUTCOME_UNKNOWN}"
                )),
                (true, false) => {
                    Some("Guest provider login is required; explicit follow-up after login".into())
                }
                (false, true) => Some(PRIOR_OUTCOME_UNKNOWN.into()),
                (false, false) => None,
            };
            record.artifacts_pending = true;
            let status = record.task.status;
            event(
                &mut record.task,
                json!({"type":"taskSettled","status":status}),
            );
        } else if self.manager.status_of(&session, &tab) == crate::store::index::TabStatus::Waiting
        {
            record.task.status = TaskStatus::Waiting;
        } else if self.manager.is_running(&session, &tab) {
            record.task.status = TaskStatus::Running;
        } else if record.task.status != TaskStatus::Waiting {
            unknown(
                record,
                "Guest worker disconnected without a retained turn result",
            );
        }
        Ok(())
    }

    fn cancel(&self, target: &TaskTarget) -> Result<Value> {
        let mut state = self.state.lock().unwrap();
        self.cancel_locked(&mut state, target)
    }

    fn cancel_locked(&self, state: &mut State, target: &TaskTarget) -> Result<Value> {
        validate_target(&state.identity, target)?;
        if !state.records.contains_key(&target.task_id) {
            if state
                .canceled_targets
                .get(&target.task_id)
                .is_some_and(|prior| prior != target)
            {
                bail!("Canceled target has different immutable binding");
            }
            state
                .canceled_targets
                .insert(target.task_id.clone(), target.clone());
            self.save(state)?;
            return Ok(json!({"canceled":true,"absent":true,"target":target}));
        }
        let record = bound(state, target)?;
        if record.task.status.terminal() {
            return Ok(serde_json::to_value(page(&record.task, 0)?)?);
        }
        let record = state.records.get_mut(&target.task_id).unwrap();
        if record.task.status == TaskStatus::Queued {
            record.task.status = TaskStatus::Canceled;
            record.files.clear();
            event(&mut record.task, json!({"type":"canceledBeforeStart"}));
        } else {
            let tracked = worker(&record.task).ok();
            if !tracked
                .as_ref()
                .is_some_and(|(session, tab)| self.manager.is_running(session, tab))
            {
                if let Err(error) = cancel_after_boot_change(record, self.boot_identity.as_deref())
                {
                    unknown(record, &format!("Cannot confirm worker exit: {error:#}"));
                }
                self.save(state)?;
                return Ok(serde_json::to_value(page(
                    &state.records[&target.task_id].task,
                    0,
                )?)?);
            }
            let (session, tab) = tracked.context("Tracked guest worker is missing")?;
            record.task.status = TaskStatus::Canceling;
            self.save(state)?;
            let result = self.stop_worker(&session, &tab);
            let record = state.records.get_mut(&target.task_id).unwrap();
            match result {
                Ok(()) => {
                    self.collect(record)?;
                    record.task.status = TaskStatus::Canceled;
                    record.artifacts_pending = true;
                    event(&mut record.task, json!({"type":"canceled"}));
                }
                Err(error) => unknown(record, &format!("Worker exit unconfirmed: {error:#}")),
            }
        }
        self.save(state)?;
        Ok(serde_json::to_value(page(
            &state.records[&target.task_id].task,
            0,
        )?)?)
    }

    fn takeover(&self, params: &Value) -> Result<Value> {
        if params["confirm"] != true {
            bail!("Explicit confirm:true is required for manual desktop takeover");
        }
        let target = target(params)?;
        let after = params
            .get("after")
            .map(|value| {
                value
                    .as_u64()
                    .context("A nonnegative bounded sequence cursor is required")
            })
            .transpose()?
            .unwrap_or(0);
        let mut state = self.state.lock().unwrap();
        page(&bound(&state, &target)?.task, after)?;
        if attachment::held(&state) || setup::holds_admission(&state, self.boot_identity.as_deref()) || self.setup_actor.busy()
        {
            bail!("Guest setup helper owns admission; manual takeover is refused");
        }
        if let Some(lease) = &state.manual_lease {
            if lease.target != target {
                bail!("Manual desktop lease belongs to a different task target");
            }
            if lease.ready {
                let task = &state.records[&target.task_id].task;
                if !task.status.terminal() {
                    bail!("Manual desktop lease has no confirmed terminal task");
                }
                return takeover_response(&state, &target, after);
            }
        }
        if state
            .records
            .values()
            .any(|r| r.task.target != target && r.task.status.holds_desktop())
        {
            bail!("Another task holds the guest desktop; manual takeover is refused");
        }
        // Keep the same mutex through cancellation and lease acquisition so
        // queued work cannot enter the desktop between these two operations.
        let mut next = state.clone();
        if next.manual_lease.is_none() {
            next.manual_lease = Some(ManualLease {
                target: target.clone(),
                acquired_at: now(),
                ready: false,
            });
            self.save(&next)?; // Revoke worker MCP access before attempting stop.
            *state = next.clone();
        }
        self.cancel_locked(&mut next, &target)?;
        *state = next.clone(); // cancel_locked already persisted this checkpoint.
        let record = next.records.get_mut(&target.task_id).unwrap();
        if !record.task.status.terminal() {
            return takeover_response(&state, &target, after);
        }
        if let Ok((session, tab)) = worker(&record.task) {
            if self.manager.is_running(&session, &tab) {
                self.stop_worker(&session, &tab)?;
            }
        }
        event(
            &mut record.task,
            json!({"type":"desktopTakenOver","externalOutcomeUnknown":record.prior_external_outcome_unknown}),
        );
        next.manual_lease.as_mut().unwrap().ready = true;
        self.save(&next)?; // Task checkpoint and manual lease become visible together.
        *state = next;
        takeover_response(&state, &target, after)
    }

    fn release_desktop(&self, params: &Value) -> Result<Value> {
        if params["confirm"] != true {
            bail!("Explicit confirm:true is required to release the manual desktop lease");
        }
        let mut state = self.state.lock().unwrap();
        if setup::holds_admission(&state, self.boot_identity.as_deref()) || self.setup_actor.busy()
        {
            bail!("Guest setup helper still owns admission; manual release is refused");
        }
        let mut next = state.clone();
        if let Some(lease) = next.manual_lease.take() {
            if !lease.ready {
                bail!("Worker exit is unconfirmed; retry explicit takeover after a confirmed guest reboot before releasing the manual reservation");
            }
            bound(&next, &lease.target)?;
            let record = next.records.get_mut(&lease.target.task_id).unwrap();
            event(
                &mut record.task,
                json!({"type":"desktopReleased","externalOutcomeUnknown":record.prior_external_outcome_unknown}),
            );
            self.save(&next)?;
            *state = next;
        }
        Ok(desktop_state(&state))
    }

    fn recover(&self, params: &Value) -> Result<Value> {
        if params["confirm"] != true {
            bail!("Explicit confirm:true is required to resume with new human instructions");
        }
        let target = target(params)?;
        let key = params["idempotencyKey"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 200)
            .context("A bounded recovery idempotencyKey is required")?;
        let text = params["text"]
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.len() <= 256 * 1024)
            .context("Bounded new human recovery text is required")?
            .to_owned();
        let operation_key = format!("task.recover:{key}");
        let operation_digest = digest(&serde_json::to_vec(&("task.recover", params))?);
        let mut state = self.state.lock().unwrap();
        let record = bound(&state, &target)?;
        if let Some(prior) = record.operations.get(&operation_key) {
            if prior.digest != operation_digest {
                bail!("Recovery idempotency key already names different input");
            }
            if prior.sending
                && !self
                    .recovery_receipts
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|r| r.target == target && r.operation_key == operation_key)
            {
                bail!("outcomeUnknown: recovery delivery receipt is unavailable; this text was not replayed");
            }
            if let Some(error) = &prior.error {
                bail!("{error}");
            }
            return Ok(serde_json::to_value(page(&record.task, 0)?)?);
        }
        require_queue_control(&state)?;
        recovery_ready(record, self.boot_identity.as_deref())?;
        if text.trim() == record.task.input.prompt.trim() {
            bail!("Recovery requires new human instructions; the original task prompt cannot be replayed");
        }
        if state
            .records
            .values()
            .any(|r| r.task.target != target && r.task.status.holds_desktop())
        {
            bail!("Another task holds the whole guest desktop workflow");
        }
        let (session, tab) = worker(&record.task)?;
        if self.manager.is_running(&session, &tab) {
            bail!("This runtime still tracks a live worker; recovery is refused");
        }
        self.workspace(&record.task)?;
        self.resume_binding(record)?;
        if !desktop_ready() {
            bail!("Restore guest desktop permissions/readiness before explicit recovery");
        }
        let models = discover_models(&record.task.input.harness)?;
        validate_model(&record.task, &models)?;
        if record.task.input.harness == "codex"
            && self
                .manager
                .codex_models()
                .substitute_for(&record.task.input.model)
                .is_some()
        {
            bail!("Recovery cannot preserve the selected guest model; substitution is refused");
        }
        let provider = record
            .task
            .provider_conversation_id
            .clone()
            .context("Bound provider resume ID is missing")?;
        let mut next = state.clone();
        let record = next.records.get_mut(&target.task_id).unwrap();
        prepare_recovery(
            record,
            self.boot_identity.as_deref(),
            key,
            &operation_digest,
            &text,
        )?;
        self.save(&next)?; // Receipt marker, new text, lease and boot before any PTY effect.
        *state = next;
        let (sender, receiver) = mpsc::channel();
        self.recovery_receipts
            .lock()
            .unwrap()
            .push(RecoveryReceipt {
                target: target.clone(),
                idempotency_key: key.into(),
                operation_key: operation_key.clone(),
                receiver,
                result: None,
            });
        let manager = self.manager.clone();
        let spawned = std::thread::Builder::new().name("guest-recover-input".into()).spawn(move || {
            // A fresh manager reconstructs no old queued prompts. This call
            // sends only the explicitly supplied new text and waits for the
            // provider's echo/submit hook, rather than accepting PTY admission.
            let result = manager.send_confirmed(&session,&tab,text).and_then(|_| {
                let entry = crate::store::index::get(&session)?;
                if entry.tab(&tab).and_then(|t| t.provider_session_id.as_deref()) != Some(provider.as_str()) {
                    bail!("Provider conversation changed while recovering; delivery is uncertain");
                }
                Ok(())
            }).map_err(|error| format!("{error:#}"));
            let _ = sender.send(result);
        });
        if let Err(error) = spawned {
            let record = state.records.get_mut(&target.task_id).unwrap();
            unknown(record, &format!("Recovery writer could not start: {error}"));
            self.save(&state)?;
        }
        Ok(serde_json::to_value(page(
            &state.records[&target.task_id].task,
            0,
        )?)?)
    }

    fn resume_binding(&self, record: &Record) -> Result<()> {
        let (session, tab) = worker(&record.task)?;
        let provider = record
            .task
            .provider_conversation_id
            .as_deref()
            .context("Provider resume ID is missing")?;
        validate_id(provider)?;
        let entry = crate::store::index::get(&session)?;
        let tab = entry
            .tab(&tab)
            .context("Retained worker tab is missing; cannot resume")?;
        if entry.cwd != record.task.guest_cwd
            || tab.harness != record.task.input.harness
            || tab.provider_session_id.as_deref() != Some(provider)
        {
            bail!("Retained provider/session/workspace binding differs; recovery is refused");
        }
        resume_settings(&record.task, tab)?;
        let path = match tab.harness.as_str() {
            "codex" => crate::harness::codex::home::find_rollout(
                &crate::store::root()?.join("codex"),
                provider,
            )
            .context(
                "Retained Codex rollout is missing; recovery will not start a new conversation",
            )?,
            "claude" => crate::harness::claude::transcript::locate(&entry.cwd, provider)
                .context("Guest Claude transcript home is missing")?,
            _ => bail!("Unsupported provider recovery"),
        };
        let metadata = fs::symlink_metadata(&path)
            .context("Retained provider transcript is missing; restore it before recovery")?;
        if !metadata.is_file() || metadata.len() == 0 {
            bail!("A retained regular provider transcript is required for recovery");
        }
        Ok(())
    }

    fn checkpoint_recovery_receipts(&self, state: &mut State) -> Result<()> {
        let mut receipts = self.recovery_receipts.lock().unwrap();
        let mut next = state.clone();
        let mut finished = Vec::new();
        for (index, receipt) in receipts.iter_mut().enumerate() {
            if receipt.result.is_none() {
                receipt.result = match receipt.receiver.try_recv() {
                    Ok(result) => Some(result),
                    Err(TryRecvError::Empty) => None,
                    Err(TryRecvError::Disconnected) => Some(Err(
                        "Recovery writer disconnected before confirming delivery".into(),
                    )),
                };
            }
            let Some(result) = &receipt.result else {
                continue;
            };
            bound(&next, &receipt.target)?;
            let record = next.records.get_mut(&receipt.target.task_id).unwrap();
            let operation = record
                .operations
                .get_mut(&receipt.operation_key)
                .context("Recovery receipt has no retained operation")?;
            if operation.sending {
                if result.is_ok()
                    && matches!(
                        record.task.status,
                        TaskStatus::Starting | TaskStatus::Running | TaskStatus::Waiting
                    )
                {
                    operation.sending = false;
                    record.task.status = TaskStatus::Running;
                    record.task.detail = Some(PRIOR_OUTCOME_UNKNOWN.into());
                    event(
                        &mut record.task,
                        json!({"type":"taskRecovered","idempotencyKey":receipt.idempotency_key}),
                    );
                } else {
                    let error =
                        result.as_ref().err().map(String::as_str).unwrap_or(
                            "Recovery was stopped before durable delivery acknowledgement",
                        );
                    let error = format!("outcomeUnknown: recovery delivery is uncertain: {error}");
                    operation.sending = false;
                    operation.error = Some(error.clone());
                    if !record.task.status.terminal() {
                        unknown(record, &error);
                    }
                    event(
                        &mut record.task,
                        json!({"type":"taskRecoveryFailed","idempotencyKey":receipt.idempotency_key,"detail":error,"externalOutcomeUnknown":true}),
                    );
                }
            }
            finished.push(index);
        }
        if !finished.is_empty() {
            // Do not expose an in-memory acknowledgement if persistence fails.
            // Cached receipts stay available for the next checkpoint attempt.
            self.save(&next)?;
            *state = next;
            for index in finished.into_iter().rev() {
                receipts.remove(index);
            }
        }
        Ok(())
    }

    fn mutate(&self, method: &str, params: &Value) -> Result<Value> {
        let target = target(params)?;
        let key = params["idempotencyKey"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 200)
            .context("A bounded idempotencyKey is required")?;
        let operation_key = format!("{method}:{key}");
        let operation_digest = digest(&serde_json::to_vec(&(method, params))?);
        let mut state = self.state.lock().unwrap();
        let record = bound(&state, &target)?;
        if let Some(op) = record.operations.get(&operation_key) {
            if op.digest != operation_digest {
                bail!("Idempotency key already names different input");
            }
            if op.sending {
                bail!("outcomeUnknown: operation receipt is unavailable; input was not replayed");
            }
            if let Some(error) = &op.error {
                bail!("{error}");
            }
            return Ok(serde_json::to_value(page(&record.task, 0)?)?);
        }
        require_queue_control(&state)?;
        if matches!(
            record.task.status,
            TaskStatus::Queued
                | TaskStatus::Starting
                | TaskStatus::Canceling
                | TaskStatus::OutcomeUnknown
                | TaskStatus::Canceled
        ) {
            bail!("Task is not accepting input in this state");
        }
        if state
            .records
            .values()
            .any(|r| r.task.target.task_id != target.task_id && r.task.status.holds_desktop())
        {
            bail!("Another task owns the full guest desktop workflow");
        }
        let (session, tab) = worker(&record.task)?;
        let text = if method == "task.followup" {
            Some(
                params["text"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty() && s.len() <= 256 * 1024)
                    .context("A bounded follow-up text is required")?
                    .to_owned(),
            )
        } else {
            let request = params["requestId"]
                .as_str()
                .context("requestId is required")?;
            let option = params["optionId"]
                .as_str()
                .context("optionId is required")?;
            if !self.manager.pending_permissions().iter().any(|p| {
                p.session_id == session
                    && p.tab_id == tab
                    && p.request_id == request
                    && p.options.iter().any(|o| o == option)
            }) {
                bail!("Permission is not pending for this task/option");
            }
            None
        };
        let record = state.records.get_mut(&target.task_id).unwrap();
        record.operations.insert(
            operation_key.clone(),
            Operation {
                digest: operation_digest,
                sending: true,
                error: None,
            },
        );
        record.task.status = TaskStatus::Running;
        record.task.outcome = None;
        if text.is_some() {
            record.boot_identity = self.boot_identity.clone();
        }
        self.save(&state)?;
        let result = if let Some(text) = text {
            self.manager.send(&session, &tab, text, vec![]).map(|_| ())
        } else {
            self.manager.respond_permission(
                &session,
                &tab,
                params["requestId"].as_str().unwrap(),
                params["optionId"].as_str().unwrap(),
            )
        };
        let record = state.records.get_mut(&target.task_id).unwrap();
        match result {
            Ok(()) => record.operations.get_mut(&operation_key).unwrap().sending = false,
            Err(error) => {
                unknown(
                    record,
                    &format!("Operation delivery is uncertain: {error:#}"),
                );
            }
        }
        self.save(&state)?;
        Ok(serde_json::to_value(page(
            &state.records[&target.task_id].task,
            0,
        )?)?)
    }

    fn retain(&self, record: &mut Record) -> Result<()> {
        let (session, tab) = worker(&record.task)?;
        let log = fs::read(crate::store::log_path(&session, &tab)?)?;
        self.keep(record, "transcript.jsonl", "application/x-ndjson", &log)?;
        let output = record.task.outcome.clone().unwrap_or_default();
        self.keep(record, "outcome.txt", "text/plain", output.as_bytes())?;
        let cwd = self.workspace(&record.task)?;
        if let Some(baseline) = &record.baseline {
            let index = self
                .base
                .join("artifacts")
                .join(format!("{}.index", record.task.target.task_id));
            if index.try_exists()? {
                fs::remove_file(&index)?;
            }
            git(&cwd, &["read-tree", baseline], Some(&index))?;
            git(&cwd, &["add", "--all", "--", "."], Some(&index))?;
            let patch = git(
                &cwd,
                &[
                    "diff",
                    "--cached",
                    "--binary",
                    "--no-ext-diff",
                    "--no-textconv",
                    baseline,
                    "--",
                    ".",
                ],
                Some(&index),
            )?;
            fs::remove_file(index)?;
            self.keep(record, "changes.patch", "text/x-diff", &patch)?;
        }
        let pane = SessionManager::pane_id(&tab);
        if let Some(bytes) = self.manager.terminals().read_output(&pane) {
            self.keep(record, "terminal.ansi", "application/octet-stream", &bytes)?;
        }
        let mut files = Vec::new();
        collect_files(&cwd, &cwd, &mut files, 0)?;
        let mut manifest = Vec::new();
        for path in files {
            let bytes = read_bounded(&cwd.join(&path), MAX_ARTIFACT_BYTES)?;
            let artifact = self.keep(record, &path, "application/octet-stream", &bytes)?;
            manifest.push(json!({"path":path,"artifactId":artifact.id,"sha256":artifact.sha256,"bytes":artifact.bytes}));
        }
        self.keep(
            record,
            "files.json",
            "application/json",
            &serde_json::to_vec(&manifest)?,
        )?;
        Ok(())
    }

    fn keep(
        &self,
        record: &mut Record,
        name: &str,
        media_type: &str,
        bytes: &[u8],
    ) -> Result<Artifact> {
        if bytes.len() > MAX_ARTIFACT_BYTES {
            bail!("Artifact {name} exceeds the 12 MiB transfer limit; retained workspace requires explicit export");
        }
        let sha256 = digest(bytes);
        let hash = digest(format!("{name}:{sha256}").as_bytes());
        let id = uuid::Uuid::parse_str(&hash[..32])?.to_string();
        let dir = self
            .base
            .join("artifacts")
            .join(&record.task.target.task_id);
        private_directory(&dir)?;
        atomic_private_write(&dir.join(&id), bytes)?;
        let artifact = Artifact {
            id,
            name: name.into(),
            sha256,
            bytes: bytes.len() as u64,
            media_type: media_type.into(),
            expires_at: None,
        };
        if !record.task.artifacts.iter().any(|a| a.id == artifact.id) {
            record.task.artifacts.push(artifact.clone());
        }
        Ok(artifact)
    }

    fn artifact(&self, params: &Value) -> Result<Value> {
        let target = target(params)?;
        let state = self.state.lock().unwrap();
        let record = bound(&state, &target)?;
        let id = params["artifactId"]
            .as_str()
            .context("artifactId is required")?;
        let artifact = record
            .task
            .artifacts
            .iter()
            .find(|a| a.id == id)
            .context("Artifact not retained for this task")?;
        let bytes = read_bounded(
            &self
                .base
                .join("artifacts")
                .join(&target.task_id)
                .join(&artifact.id),
            MAX_ARTIFACT_BYTES,
        )?;
        if bytes.len() as u64 != artifact.bytes || digest(&bytes) != artifact.sha256 {
            bail!("Retained artifact integrity failure");
        }
        Ok(json!({"artifact":artifact,"contentBase64":STANDARD.encode(bytes)}))
    }

    fn workspace(&self, task: &Task) -> Result<PathBuf> {
        let path = self.base.join("workspaces").join(&task.target.workspace_id);
        if Path::new(&task.guest_cwd) != path
            || fs::symlink_metadata(&path)?.file_type().is_symlink()
            || fs::canonicalize(&path)?
                != fs::canonicalize(self.base.join("workspaces"))?.join(&task.target.workspace_id)
        {
            bail!("Guest workspace binding changed; refusing filesystem operation");
        }
        Ok(path)
    }

    fn stop_worker(&self, session: &str, tab: &str) -> Result<()> {
        let pane = SessionManager::pane_id(tab);
        let group = self.manager.terminals().group_handle(&pane);
        let pid = self.manager.terminals().pid(&pane);
        // SessionManager::stop kills and waits for the PTY, then checks the
        // recorded process until RESTART_WAIT. Keep an independent check of
        // the pre-stop PID: clearing the in-memory engine alone is not proof
        // that desktop actions have stopped.
        self.manager.stop(session, tab)?;
        if self.manager.is_running(session, tab)
            || group.as_ref().is_some_and(|g| g.pid().is_some())
            || pid.is_some_and(crate::harness::host::group_or_process_alive)
        {
            bail!("Worker process exit is not confirmed; desktop lease remains held");
        }
        Ok(())
    }

    fn disposition(&self) -> Result<Value> {
        let state = self.state.lock().unwrap();
        let tasks = state.records.values().map(|record| -> Result<Value> {
            let status = self.workspace(&record.task).and_then(|cwd| git(&cwd,&["status","--porcelain=v1","--untracked-files=all"],None));
            let event_digests = record.task.events.iter().map(|e| -> Result<Value> {
                Ok(json!({"seq":e.seq,"digest":digest(&serde_json::to_vec(e)?)}))
            }).collect::<Result<Vec<_>>>()?;
            Ok(json!({"target":record.task.target,"guestCwd":record.task.guest_cwd,"status":record.task.status,
                "workerSessionId":record.task.worker_session_id,"workerTabId":record.task.worker_tab_id,
                "providerConversationId":record.task.provider_conversation_id,"artifacts":record.task.artifacts,
                "gitPorcelain":status.as_ref().ok().map(|bytes|String::from_utf8_lossy(bytes).into_owned()),
                "detail":status.err().map(|error|format!("{error:#}")),"historyRetained":true,
                "bootIdentity":record.boot_identity,"lastEventSeq":record.task.last_event_seq,
                "inputDigest":record.task.input_digest,
                "eventDigests":event_digests,
                "canceledBeforeStart":record.task.status == TaskStatus::Canceled && record.operations.is_empty()
                    && record.task.worker_session_id.is_none() && record.task.worker_tab_id.is_none()
                    && record.task.provider_conversation_id.is_none()
                    && record.task.events.iter().any(|e|e.payload["type"] == "canceledBeforeStart"),
                "priorExternalOutcomeUnknown":record.prior_external_outcome_unknown}))
        }).collect::<Result<Vec<_>>>()?;
        let unused = self.provision_evidence_locked(&state)?;
        Ok(
            json!({"evidenceVersion":1,"complete":true,"environmentId":state.identity.environment_id,"generation":state.identity.generation,"tasks":tasks,
            "currentBootIdentity":unused["currentBootIdentity"],"manualControl":state.manual_lease.is_some(),
            "activeOwnedGroups":self.manager.terminals().owned_groups().len()
                + usize::from(attachment::held(&state) || self.setup_actor.busy() || setup::holds_admission(&state,self.boot_identity.as_deref())),"unusedRuntimeProof":unused,
            "setupOperations":state.setup_operations,"attachments":state.attachments,
            "retainedData":unused["retainedData"],
            "canceledTargets":state.canceled_targets,
            "historyRetained":true,"deletionAvailable":false}),
        )
    }

    /// Read-only: no driver, model discovery, provider, stop or VM effects.
    /// V1 deliberately supports only an unused installed timeline. Empty
    /// records alone are insufficient: the host must also verify a changed
    /// kernel boot since the durable baseline, killing pre-baseline orphans.
    fn provision_evidence(&self) -> Result<Value> {
        let state = self.state.lock().unwrap();
        self.provision_evidence_locked(&state)
    }

    fn provision_evidence_locked(&self, state: &State) -> Result<Value> {
        let current_boot = boot_identity().context("Kernel boot identity is unavailable")?;
        let retained: Value = serde_json::from_slice(&read_bounded(
            &self.base.join("runtime").join(STATE),
            512 * 1024 * 1024,
        )?)?;
        let expected = serde_json::to_value(state)?;
        if retained != expected {
            bail!("Guest history changed or disappeared; provisioning remains unknown");
        }
        let inventory = retained_data(&self.base, state)?;
        Ok(json!({
            "evidenceVersion":1,"environmentId":state.identity.environment_id,
            "generation":state.identity.generation,"currentBootIdentity":current_boot,
            "initializedTimeline":state.provisioning_baseline,"manualControl":state.manual_lease.is_some(),
            "activeOwnedGroups":self.manager.terminals().owned_groups().len()
                + usize::from(attachment::held(state) || self.setup_actor.busy() || setup::holds_admission(state,Some(&current_boot))),
            "setupOperations":state.setup_operations,"attachments":state.attachments,
            "tasks":state.records.values().map(|r|json!({"target":r.task.target,
                "lastEventSeq":r.task.last_event_seq,"status":r.task.status,
                "workerSessionId":r.task.worker_session_id,"workerTabId":r.task.worker_tab_id,
                "providerConversationId":r.task.provider_conversation_id,"bootIdentity":r.boot_identity})).collect::<Vec<_>>(),
            "canceledTargets":state.canceled_targets,"historyDigest":digest(&serde_json::to_vec(&expected)?),
            "retainedData":inventory,
            "noExecutionSinceInitialization":state.provisioning_baseline.as_ref().is_some_and(|b|b.no_execution)
                && state.records.is_empty() && state.canceled_targets.is_empty() && state.setup_operations.is_empty() && state.attachments.is_empty()
        }))
    }
}

/// Complete root inventory, including data not addressable by task records.
/// Errors are never projected as empty/clean data. No provider/driver probes.
fn retained_data(base: &Path, state: &State) -> Result<Value> {
    fn entries(path: &Path) -> Result<Vec<String>> {
        if !fs::symlink_metadata(path)?.file_type().is_dir() {
            bail!("Retained data root is not a regular directory");
        }
        let mut names = fs::read_dir(path)?
            .map(|entry| -> Result<String> {
                let entry = entry?;
                entry.file_type()?;
                entry.file_name().into_string().map_err(|_| {
                    anyhow::anyhow!(
                        "Retained data has a non-UTF-8 name; inspect/export it explicitly"
                    )
                })
            })
            .collect::<Result<Vec<_>>>()?;
        names.sort();
        Ok(names)
    }
    let sessions = crate::store::root()?.join("sessions");
    let session_entries: Vec<_> = entries(&sessions)?
        .into_iter()
        .filter(|name| !matches!(name.as_str(), "index.json" | "index.lock"))
        .collect();
    let index = match fs::read(sessions.join("index.json")) {
        Ok(bytes) => {
            serde_json::from_slice::<Value>(&bytes).context("Damaged retained session index")?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if state
                .records
                .values()
                .any(|r| r.task.worker_session_id.is_some())
            {
                bail!("Retained worker session index is missing; inspection is incomplete");
            }
            json!({})
        }
        Err(error) => return Err(error.into()),
    };
    let populated = index
        .as_object()
        .context("Invalid retained session index")?
        .iter()
        .any(|(key, value)| match key.as_str() {
            "sessions" | "closedTabs" => !value.as_array().is_some_and(Vec::is_empty),
            "workspaceTabs" => !value.as_object().is_some_and(serde_json::Map::is_empty),
            _ => true,
        });
    let workspaces = entries(&base.join("workspaces"))?;
    let artifacts = entries(&base.join("artifacts"))?;
    let records: Vec<_> = state.records.values().collect();
    let indexed_sessions: Vec<crate::store::index::SessionEntry> = index
        .get("sessions")
        .map(|value| serde_json::from_value(value.clone()))
        .transpose()
        .context("Retained session metadata could not be inspected")?
        .unwrap_or_default();
    let unaccounted_index =
        index
            .as_object()
            .unwrap()
            .iter()
            .any(|(key, value)| match key.as_str() {
                "sessions" => !indexed_sessions.iter().all(|session| {
                    let Some(record) = records
                        .iter()
                        .find(|r| r.task.worker_session_id.as_deref() == Some(session.id.as_str()))
                    else {
                        return false;
                    };
                    session.unknown.is_empty()
                        && session.cwd == record.task.guest_cwd
                        && session.tabs.iter().all(|tab| {
                            tab.unknown.is_empty()
                                && tab.follow.history.is_empty()
                                && Some(tab.id.as_str()) == record.task.worker_tab_id.as_deref()
                                && tab.provider_session_id == record.task.provider_conversation_id
                        })
                }),
                "closedTabs" => !value.as_array().is_some_and(Vec::is_empty),
                "workspaceTabs" => !value.as_object().is_some_and(serde_json::Map::is_empty),
                _ => true,
            });
    let unaccounted = unaccounted_index
        || workspaces
            .iter()
            .any(|name| !records.iter().any(|r| r.task.target.workspace_id == *name))
        || artifacts.iter().any(|name| {
            !records.iter().any(|r| {
                r.task.target.task_id == *name
                    || format!("{}.index", r.task.target.task_id) == *name
            })
        })
        || session_entries.iter().any(|name| {
            !records
                .iter()
                .any(|r| r.task.worker_session_id.as_ref() == Some(name))
        });
    Ok(json!({"complete":true,"workspaceEntries":workspaces,
        "artifactEntries":artifacts,"sessionIndexHasData":populated,"unaccountedData":unaccounted,
        "sessionIndexDigest":digest(&serde_json::to_vec(&index)?),
        "sessionEntries":session_entries}))
}

fn target(params: &Value) -> Result<TaskTarget> {
    serde_json::from_value(params["target"].clone()).context("An immutable TaskTarget is required")
}

fn desktop_state(state: &State) -> Value {
    json!({"environmentId":state.identity.environment_id,"generation":state.identity.generation,
        "manualControl":state.manual_lease.is_some(),"attachedDesktop":attachment::held(state),
        "ready":state.manual_lease.as_ref().is_none_or(|lease| lease.ready),
        "target":state.manual_lease.as_ref().map(|lease| &lease.target)})
}

fn takeover_response(state: &State, target: &TaskTarget, after: u64) -> Result<Value> {
    let task = page(&bound(state, target)?.task, after)?;
    let ready = state
        .manual_lease
        .as_ref()
        .is_some_and(|lease| lease.target == *target && lease.ready)
        && task.status.terminal();
    Ok(json!({"ready":ready,"manualControl":true,"task":task}))
}

fn require_queue_control(state: &State) -> Result<()> {
    if attachment::held(state) { bail!("An attached desktop workflow owns this guest; task execution remains reserved"); }
    if setup::holds_admission(state, boot_identity().as_deref()) {
        bail!("Guest setup helper exit is unconfirmed; task input remains reserved");
    }
    if state.manual_lease.is_some() {
        bail!("Manual desktop lease is held; explicitly release it before returning control to queued tasks");
    }
    Ok(())
}

fn resume_settings(task: &Task, tab: &crate::store::index::TabEntry) -> Result<()> {
    // Empty model and None effort are immutable inherited choices too.
    if tab.model != task.input.model
        || tab.effort != task.input.effort
        || tab.permission_mode != task.input.permission_mode
        || tab
            .requested_model
            .as_ref()
            .is_some_and(|v| v != &task.input.model)
        || tab
            .requested_effort
            .as_ref()
            .is_some_and(|v| Some(v) != task.input.effort.as_ref())
        || tab
            .requested_permission_mode
            .as_ref()
            .is_some_and(|v| v != &task.input.permission_mode)
    {
        bail!("Retained model/effort/permission settings differ from immutable task input; recovery is refused");
    }
    Ok(())
}

fn bound<'a>(state: &'a State, target: &TaskTarget) -> Result<&'a Record> {
    validate_target(&state.identity, target)?;
    let record = state.records.get(&target.task_id).context("outcomeUnknown: guest task record is absent; do not replay start; explicitly reconcile or cancel")?;
    if record.task.target != *target
        || state.identity.environment_id != target.environment_id
        || state.identity.generation != target.generation
    {
        bail!("Wrong task/workspace/environment/generation binding");
    }
    Ok(record)
}

fn validate_target(identity: &Identity, target: &TaskTarget) -> Result<()> {
    for id in [
        &target.environment_id,
        &target.workspace_id,
        &target.task_id,
        &target.generation,
    ] {
        validate_id(id)?;
    }
    if target.environment_id != identity.environment_id || target.generation != identity.generation
    {
        bail!("Wrong guest environment/generation binding");
    }
    Ok(())
}

fn worker(task: &Task) -> Result<(String, String)> {
    Ok((
        task.worker_session_id
            .clone()
            .context("No guest worker session")?,
        task.worker_tab_id.clone().context("No guest worker tab")?,
    ))
}

fn event(task: &mut Task, payload: Value) {
    task.last_event_seq += 1;
    task.updated_at = now();
    task.events.push(TaskEvent {
        seq: task.last_event_seq,
        timestamp: task.updated_at.clone(),
        payload,
    });
}

fn unknown(record: &mut Record, detail: &str) {
    record.prior_external_outcome_unknown = true;
    record.task.status = TaskStatus::OutcomeUnknown;
    record.task.detail = Some(detail.into());
    event(
        &mut record.task,
        json!({"type":"outcomeUnknown","detail":detail}),
    );
}

/// Reading this kernel value never restarts or controls a guest. No user-
/// supplied environment value, PID guess, or runtime launch ID can stand in
/// for evidence of a different OS boot.
fn boot_identity() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let mut bytes = [0u8; 128];
        let mut length = bytes.len();
        // SAFETY: the name is NUL-terminated; bytes/length name valid writable
        // buffers; null newp requests a read-only sysctl operation.
        let result = unsafe {
            libc::sysctlbyname(
                c"kern.bootsessionuuid".as_ptr(),
                bytes.as_mut_ptr().cast(),
                &mut length,
                std::ptr::null_mut(),
                0,
            )
        };
        if result != 0 || length > bytes.len() {
            return None;
        }
        let value = std::ffi::CStr::from_bytes_until_nul(&bytes[..length])
            .ok()?
            .to_str()
            .ok()?;
        uuid::Uuid::parse_str(value).ok().map(|id| id.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        // A new PID namespace/PID 1 proves the old container processes are
        // gone; restarting only terminalx-serve keeps the same identity.
        linux_boot_identity(
            &std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?,
            std::fs::metadata("/proc/self/ns/pid").ok()?.ino(),
            &std::fs::read_to_string("/proc/1/stat").ok()?,
        )
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    None
}

#[cfg(any(target_os = "linux", test))]
fn linux_boot_identity(kernel_boot: &str, namespace: u64, init_stat: &str) -> Option<String> {
    let boot = uuid::Uuid::parse_str(kernel_boot.trim()).ok()?;
    if namespace == 0 || !init_stat.starts_with("1 (") { return None; }
    // comm may contain spaces and parentheses. starttime is field 22; field 3
    // follows the final closing parenthesis. Never use a wall-clock timeout.
    let (_, fields) = init_stat.rsplit_once(") ")?;
    let start = fields.split_whitespace().nth(19)?.parse::<u64>().ok()?;
    if start == 0 { return None; }
    let hash = digest(format!("{boot}:{namespace}:{start}").as_bytes());
    uuid::Uuid::parse_str(&hash[..32]).ok().map(|id| id.to_string())
}

fn require_boot_change(previous: Option<&str>, current: Option<&str>) -> Result<()> {
    let previous = previous.context("Historical guest OS boot identity is absent; restart the guest through the supported host flow and explicitly reconcile retained history before retrying")?;
    let current = current.context("Current guest OS boot identity is unavailable; restore guest kernel identity access and restart the guest through the supported host flow")?;
    let previous = uuid::Uuid::parse_str(previous).context(
        "Historical guest OS boot identity is invalid; explicit reconciliation required",
    )?;
    let current =
        uuid::Uuid::parse_str(current).context("Current guest OS boot identity is invalid")?;
    if previous == current {
        bail!("Guest OS boot has not changed; an untracked worker may still be alive. Restart the guest through the supported host flow before explicit cancellation or recovery");
    }
    Ok(())
}

fn cancel_after_boot_change(record: &mut Record, current: Option<&str>) -> Result<()> {
    require_boot_change(record.boot_identity.as_deref(), current)?;
    record.task.status = TaskStatus::Canceled;
    record.prior_external_outcome_unknown = true;
    record.task.detail = Some(PRIOR_OUTCOME_UNKNOWN.into());
    record.artifacts_pending =
        record.task.worker_session_id.is_some() && record.task.worker_tab_id.is_some();
    let previous = record.boot_identity.clone();
    event(
        &mut record.task,
        json!({"type":"workerStoppedAfterGuestReboot","previousBootIdentity":previous,
        "currentBootIdentity":current,"externalOutcomeUnknown":true}),
    );
    Ok(())
}

fn recovery_ready(record: &Record, current: Option<&str>) -> Result<()> {
    if record.task.status != TaskStatus::OutcomeUnknown {
        bail!("Explicit recovery is only available for outcomeUnknown tasks");
    }
    require_boot_change(record.boot_identity.as_deref(), current)?;
    worker(&record.task)?;
    if record
        .task
        .provider_conversation_id
        .as_deref()
        .is_none_or(str::is_empty)
    {
        bail!("A bound provider resume ID is required; this task can be canceled after confirmed guest reboot but cannot be resumed");
    }
    Ok(())
}

fn prepare_recovery(
    record: &mut Record,
    current: Option<&str>,
    key: &str,
    operation_digest: &str,
    text: &str,
) -> Result<()> {
    recovery_ready(record, current)?;
    let previous = record.boot_identity.clone();
    record.operations.insert(
        format!("task.recover:{key}"),
        Operation {
            digest: operation_digest.into(),
            sending: true,
            error: None,
        },
    );
    record.boot_identity = current.map(String::from);
    record.task.status = TaskStatus::Starting;
    record.task.outcome = None;
    record.prior_external_outcome_unknown = true;
    record.task.detail = Some(PRIOR_OUTCOME_UNKNOWN.into());
    event(
        &mut record.task,
        json!({"type":"taskRecoveryRequested","idempotencyKey":key,"text":text,
        "previousBootIdentity":previous,"currentBootIdentity":current,"externalOutcomeUnknown":true}),
    );
    Ok(())
}

fn page(task: &Task, after: u64) -> Result<Task> {
    if after > task.last_event_seq {
        bail!("Sequence cursor is ahead of retained history; possible guest rollback");
    }
    let mut expected = 1;
    for ev in &task.events {
        if ev.seq != expected {
            bail!("Guest event history has a sequence gap; recovery required");
        }
        expected += 1;
    }
    if task.last_event_seq != expected - 1 {
        bail!("Guest event cursor differs from retained history");
    }
    let mut result = task.clone();
    result.events.clear();
    let mut bytes = 0;
    for ev in task.events.iter().filter(|ev| ev.seq > after) {
        let size = serde_json::to_vec(ev)?.len();
        if !result.events.is_empty() && (result.events.len() >= 256 || bytes + size > PAGE_BYTES) {
            break;
        }
        bytes += size;
        result.events.push(ev.clone());
    }
    result.last_event_seq = result.events.last().map_or(after, |e| e.seq);
    if result.last_event_seq < task.last_event_seq {
        result.status = if task.status == TaskStatus::OutcomeUnknown {
            TaskStatus::OutcomeUnknown
        } else {
            TaskStatus::Running
        };
        result.outcome = None;
        result.artifacts.clear();
        result.detail = Some(
            "More retained events are available; poll after lastEventSeq before settling this task"
                .into(),
        );
    }
    Ok(result)
}

fn validate_task(identity: &Identity, base: &Path, task: &Task, files: &[FileInput]) -> Result<()> {
    match (&identity.macos_account, &task.transport_binding) {
        (Some(account), Some(super::transport::Transport::MacosPersonalized { binding }))
            if &binding.account == account && binding.target.environment_id == identity.environment_id
                && binding.target.generation == identity.generation => {},
        (None, None) => {},
        _ => bail!("Task personalized account/transport differs from guest identity"),
    }
    for id in [
        &task.target.environment_id,
        &task.target.workspace_id,
        &task.target.task_id,
        &task.target.generation,
        &task.input.parent_session_id,
        &task.input.parent_tab_id,
    ] {
        validate_id(id)?;
    }
    if task.target.environment_id != identity.environment_id
        || task.target.generation != identity.generation
        || task.input.environment_id != identity.environment_id
    {
        bail!("Task is bound to another guest identity");
    }
    if let Some(computer) = &task.computer {
        computer.guest(&identity.environment_id, &identity.generation)?;
        if matches!(computer, crate::computer_targets::Target::LinuxGuest { .. }) != cfg!(target_os = "linux") {
            bail!("Task computer belongs to a different guest OS");
        }
    } else if cfg!(target_os = "linux") {
        bail!("Linux tasks require a retained exact container binding");
    }
    if task.input.parent_message_id.is_empty()
        || task.idempotency_key.is_empty()
        || task.idempotency_key.len() > 200
        || task.input.prompt.trim().is_empty()
        || task.input.prompt.len() > 256 * 1024
    {
        bail!("Task requires bounded prompt, idempotency key and parent message");
    }
    if !matches!(task.input.harness.as_str(), "codex" | "claude")
        || !matches!(
            task.input.permission_mode.as_str(),
            "plan" | "manual" | "auto" | "acceptEdits" | "bypassPermissions"
        )
    {
        bail!("Unsupported guest harness or permission mode");
    }
    if task.input_digest != digest(&serde_json::to_vec(&task.input)?) {
        bail!("Approved task input digest differs");
    }
    if Path::new(&task.guest_cwd) != base.join("workspaces").join(&task.target.workspace_id) {
        bail!("Guest task cwd is not the bound guest workspace");
    }
    if files.len() != task.input.files.len() || files.len() > 1024 {
        bail!("Selected file manifest differs");
    }
    let mut paths = BTreeSet::new();
    let mut total = 0;
    for file in files {
        validate_relative(&file.path)?;
        if file.path.split('/').any(|p| p == ".git") || !paths.insert(&file.path) {
            bail!("Duplicate path or imported Git control directory");
        }
        let approved = task
            .input
            .files
            .iter()
            .find(|f| f.path == file.path)
            .context("File was not explicitly approved")?;
        if file.content_base64.len() > MAX_RPC_BYTES {
            bail!("Selected file exceeds transfer limit");
        }
        let bytes = STANDARD.decode(&file.content_base64)?;
        total += bytes.len();
        if total > MAX_FILES_BYTES
            || approved.bytes != bytes.len() as u64
            || approved.sha256 != digest(&bytes)
        {
            bail!("Selected file digest/size differs or transfer limit exceeded");
        }
    }
    Ok(())
}

fn discover_models(harness: &str) -> Result<Vec<crate::models::Model>> {
    if cfg!(target_os = "linux") { require_shell_account(&installation()?, harness)?; }
    if !crate::harness::offered()
        .iter()
        .any(|h| h.id == harness && h.available)
    {
        bail!("Guest harness is not installed");
    }
    let reply = match harness {
        "codex" => {
            crate::harness::codex::appserver::ask(Default::default(), "model/list", json!({}))?
        }
        "claude" => crate::harness::claude::ask_initialize(
            &dirs::home_dir().context("Guest home missing")?,
            &["--safe-mode"],
        )?,
        _ => bail!("Unsupported guest harness"),
    };
    discovered_models(harness, &reply)
}

fn discovered_models(harness: &str, reply: &Value) -> Result<Vec<crate::models::Model>> {
    let mut models = match harness {
        "codex" => crate::harness::codex::models::parse(reply),
        "claude" => crate::harness::claude::models::parse(reply),
        _ => bail!("Unsupported guest harness"),
    };
    if models.is_empty() {
        bail!("Guest provider reported no available models; sign in inside the guest");
    }
    let default = match harness {
        // Codex's parser carries only the CLI's explicit isDefault flag.
        "codex" => {
            let defaults: Vec<_> = models.iter().filter(|model| model.is_default).collect();
            (defaults.len() == 1).then(|| defaults[0].clone())
        }
        "claude" => {
            // The shared Claude parser can infer a preferred row when the
            // CLI names no default. A guest must instead have raw evidence.
            let defaults: Vec<_> = reply
                .pointer("/response/response/models")
                .or_else(|| reply.pointer("/response/models"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|entry| entry["value"] == "default")
                .filter_map(|entry| entry["resolvedModel"].as_str().filter(|id| !id.is_empty()))
                .collect();
            if defaults.len() == 1 {
                models.iter().find(|model| model.id == defaults[0]).cloned()
            } else {
                None
            }
        }
        _ => None,
    };
    if let Some(default) = default {
        // Empty means inherit the provider's default. Keep its supported
        // efforts and explicit resolution, without changing approved input.
        models.push(crate::models::Model {
            id: String::new(),
            label: format!("Provider default ({})", default.label),
            alias: true,
            resolved: Some(default.id.clone()),
            ..default
        });
    }
    Ok(models)
}

fn validate_model(task: &Task, models: &[crate::models::Model]) -> Result<()> {
    let selected = models
        .iter()
        .find(|m| m.id == task.input.model)
        .context("Requested model is not available in this guest; refusing substitution")?;
    let model = if task.input.model.is_empty() {
        let resolved = selected
            .resolved
            .as_deref()
            .context("Guest provider did not identify its default model")?;
        models
            .iter()
            .find(|model| !model.id.is_empty() && model.id == resolved)
            .context("Guest provider default is not among its available models")?
    } else {
        selected
    };
    if task
        .input
        .effort
        .as_ref()
        .is_some_and(|e| !model.efforts.contains(e))
    {
        bail!("Requested effort is unavailable in the guest");
    }
    Ok(())
}

fn read_bounded(path: &Path, maximum: usize) -> Result<Vec<u8>> {
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() {
        bail!("Expected a regular retained file");
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum {
        bail!("File exceeds bounded transfer size");
    }
    Ok(bytes)
}

fn git(cwd: &Path, args: &[&str], index: Option<&Path>) -> Result<Vec<u8>> {
    let mut command = Command::new("git");
    command
        .current_dir(cwd)
        .args([
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "core.fsmonitor=false",
        ])
        .args(args)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE");
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    let output = command.output()?;
    if !output.status.success() {
        bail!(
            "Guest Git operation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    if output.stdout.len() > MAX_ARTIFACT_BYTES {
        bail!("Guest patch exceeds retained artifact transfer limit");
    }
    Ok(output.stdout)
}

fn collect_files(root: &Path, dir: &Path, files: &mut Vec<String>, depth: usize) -> Result<()> {
    if depth > 32 || files.len() > 1024 {
        bail!("Guest output tree exceeds retention bounds");
    }
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        if entry.file_name() == ".git" {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.is_dir() {
            collect_files(root, &entry.path(), files, depth + 1)?;
        } else if metadata.is_file() {
            files.push(
                entry
                    .path()
                    .strip_prefix(root)?
                    .to_str()
                    .context("Non-UTF-8 artifact path")?
                    .into(),
            );
        } else {
            bail!("Output symlink or special file requires explicit export; it was not followed");
        }
    }
    Ok(())
}

// Set by the adapter integration below; false until the guest-scoped desktop
// server and the SessionManager launch hook are both installed.
fn desktop_ready() -> bool {
    super::desktop::ready().is_ok()
}

/// Supplies only the bound computer server to a guest provider. The caller
/// appends these arguments after any general configuration, before spawning.
pub fn launch_config(
    session: &str,
    tab: &str,
    harness: &str,
) -> Result<crate::cloud_config::LaunchConfig> {
    let path = crate::store::root()?.join(STATE);
    if !path.try_exists()? {
        return Ok(crate::cloud_config::LaunchConfig {
            env: vec![],
            args: String::new(),
        });
    }
    let state: State = serde_json::from_slice(&fs::read(path)?)?;
    let (base, identity) = installed_identity()?;
    if identity != state.identity { bail!("Guest identity changed before provider launch"); }
    let record = state
        .records
        .values()
        .find(|r| {
            r.task.worker_session_id.as_deref() == Some(session)
                && r.task.worker_tab_id.as_deref() == Some(tab)
        })
        .context("Guest runtime refuses an unbound provider session")?;
    authorize_desktop(&state, &record.task.target)?;
    if harness != record.task.input.harness {
        bail!("Guest provider differs from immutable task input");
    }
    let entry = crate::store::index::get(session)?;
    let retained = entry.tab(tab).context("Guest worker tab is missing")?;
    if entry.cwd != record.task.guest_cwd || retained.harness != harness {
        bail!("Guest worker workspace/provider binding changed");
    }
    resume_settings(&record.task, retained)?;
    if let Some(provider) = &record.task.provider_conversation_id {
        if retained.provider_session_id.as_ref() != Some(provider) {
            bail!("Guest provider resume binding changed");
        }
    }
    task_capability(&base, &record.task)?;
    if !record.task.input.desktop {
        return shell_launch_config(&state.identity, harness);
    }
    task_launch_config(&state.identity, &record.task.target, harness)
}

fn require_shell_account(base: &Path, harness: &str) -> Result<()> {
    if harness != "codex" { bail!("Linux task execution currently requires guest-owned Codex authorization"); }
    let home = base.parent().context("Guest home missing")?;
    let provider = readiness::inspect_provider(home, readiness::Harness::Codex);
    if provider.check.state != "authenticated" {
        bail!("Sign in to Codex inside this Linux guest using its own file-backed account; host credentials are never imported ({})", provider.check.reason_code);
    }
    Ok(())
}

fn task_capability(base: &Path, task: &Task) -> Result<()> {
    if task.input.desktop {
        if !desktop_ready() { bail!("Guest desktop MCP binding is unavailable; task submission is disabled"); }
    } else {
        if !cfg!(target_os = "linux") { bail!("Linux shell/files task cannot run on another OS"); }
        if !matches!(task.computer, Some(crate::computer_targets::Target::LinuxGuest { .. })) {
            bail!("Shell/files task requires an exact Linux guest binding");
        }
        require_shell_account(base, &task.input.harness)?;
    }
    Ok(())
}

fn shell_launch_config(identity: &Identity, harness: &str) -> Result<crate::cloud_config::LaunchConfig> {
    if harness != "codex" { bail!("Unsupported Linux guest task provider"); }
    Ok(crate::cloud_config::LaunchConfig {
        env: vec![("TERMINALX_LOCAL_VM_ENVIRONMENT_ID".into(), identity.environment_id.clone()),
            ("TERMINALX_LOCAL_VM_GENERATION".into(), identity.generation.clone())],
        // A nonempty, explicit empty table prevents the shared launch hook
        // from probing/attaching a host container or inheriting its desktop.
        args: " -c 'mcp_servers={}'".into(),
    })
}

fn task_launch_config(
    identity: &Identity,
    target: &TaskTarget,
    harness: &str,
) -> Result<crate::cloud_config::LaunchConfig> {
    let target = STANDARD.encode(serde_json::to_vec(target)?);
    let env = vec![
        (
            "TERMINALX_LOCAL_VM_ENVIRONMENT_ID".into(),
            identity.environment_id.clone(),
        ),
        (
            "TERMINALX_LOCAL_VM_GENERATION".into(),
            identity.generation.clone(),
        ),
    ];
    let install = match &identity.macos_account {
        Some(account) => account.installation()?,
        None => PathBuf::from(INSTALL),
    };
    let server = json!({"command":install.join("bin/terminalx-serve"),"args":["local-vm-computer","--stdio","--task",target],
        "env":{"TERMINALX_LOCAL_VM_ENVIRONMENT_ID":identity.environment_id,"TERMINALX_LOCAL_VM_GENERATION":identity.generation,
        "TERMINALX_HOME":install.join("runtime")}});
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    let args = match harness {
        "claude" => format!(
            " --strict-mcp-config --mcp-config {}",
            quote(&json!({"mcpServers":{"guest_computer":server}}).to_string())
        ),
        "codex" => {
            let table: toml::Value = serde_json::from_value(json!({"guest_computer":server}))?;
            format!(" -c {}", quote(&format!("mcp_servers={table}")))
        }
        _ => bail!("Unsupported guest harness"),
    };
    Ok(crate::cloud_config::LaunchConfig { env, args })
}

/// Used by the guest desktop MCP before every observation/action. The lease
/// covers the whole workflow and remains held while waiting for a person.
pub fn desktop_authorized(target: &TaskTarget) -> Result<()> {
    let (base, identity) = installed_identity()?;
    let state: State = serde_json::from_slice(&fs::read(base.join("runtime").join(STATE))?)?;
    if identity != state.identity {
        bail!("Guest timeline changed");
    }
    authorize_desktop(&state, target)
}

fn authorize_desktop(state: &State, target: &TaskTarget) -> Result<()> {
    require_queue_control(state)?;
    let record = bound(state, target)?;
    if !matches!(
        record.task.status,
        TaskStatus::Starting | TaskStatus::Running | TaskStatus::Waiting
    ) {
        bail!("This task does not hold an active guest desktop workflow lease");
    }
    if state
        .records
        .values()
        .any(|r| r.task.target != *target && r.task.status.holds_desktop())
    {
        bail!("Conflicting guest desktop workflow lease");
    }
    Ok(())
}

/// One short-lived, authenticated local call. The transport owns no worker
/// lifetime and reads no host socket/token environment passed through Cua.
pub fn run_rpc_cli(args: &[String]) -> i32 {
    let result = (|| -> Result<crate::control::ControlResponse> {
        if args.len() != 1 {
            bail!("Usage: terminalx-serve local-vm-rpc -|<base64 JSON>");
        }
        let bytes = if args[0] == "-" {
            let mut bytes = Vec::new();
            std::io::stdin()
                .take(MAX_RPC_BYTES as u64 + 1)
                .read_to_end(&mut bytes)?;
            bytes
        } else {
            if args[0].len() > MAX_RPC_BYTES * 4 / 3 + 4 {
                bail!("RPC request exceeds 16 MiB");
            }
            STANDARD.decode(&args[0])?
        };
        if bytes.len() > MAX_RPC_BYTES {
            bail!("RPC request exceeds 16 MiB");
        }
        let request: Request = serde_json::from_slice(&bytes)?;
        check_runtime(request.expected_runtime_sha256.as_deref(), &super::bootstrap::owner_runtime_sha256()?)?;
        let (base, identity) = installed_identity()?;
        identity.check(&request.params)?;
        identity.check_account(request.expected_macos_account.as_ref(), request.expected_runtime_sha256.as_deref())?;
        std::env::set_var("TERMINALX_HOME", base.join("runtime"));
        for name in [
            crate::hooks::CONTROL_SOCKET_ENV,
            crate::hooks::CONTROL_TOKEN_ENV,
            crate::hooks::SOCKET_ENV,
            crate::hooks::TOKEN_ENV,
        ] {
            std::env::remove_var(name);
        }
        crate::control::call(
            "local_vm.guest",
            json!({"method":request.method,"params":request.params,"expectedRuntimeSha256":request.expected_runtime_sha256,"expectedMacosAccount":request.expected_macos_account}),
            Duration::from_secs(40),
        )
        .map_err(|error| anyhow::anyhow!("{}: {}", error.code, error.message))
    })();
    match result {
        Ok(response) => {
            println!(
                "{}",
                serde_json::to_string(&response).expect("serialize control response")
            );
            0
        }
        Err(error) => {
            println!(
                "{}",
                json!({"ok":false,"error":{"code":"guest_rpc_failed","message":format!("{error:#}")}})
            );
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::journal::{new_id, InputFile, Journal, TaskInput};
    use super::*;

    fn setup() -> (crate::store::TempHome, Guest, Task) {
        let home = crate::store::temp_home();
        let root = crate::store::root().unwrap();
        let base = root.join("installed-guest");
        private_directory(&base).unwrap();
        let host = Journal::open(&root.join("host-journal")).unwrap();
        let env = host.enroll("Test guest", "local:test-guest").unwrap();
        let identity = Identity {
            account: None,
            macos_account: None,
            environment_id: env.id.clone(),
            generation: env.generation.clone(),
            protocol: PROTOCOL,
        };
        atomic_private_write(
            &base.join("identity.json"),
            &serde_json::to_vec(&identity).unwrap(),
        )
        .unwrap();
        let mut task = host
            .submit(
                "explicit-click",
                TaskInput {
                    parent_session_id: new_id(),
                    parent_tab_id: new_id(),
                    parent_message_id: new_id(),
                    environment_id: env.id,
                    prompt: "A selected task".into(),
                    harness: "codex".into(),
                    model: "selected-provider-model".into(),
                    effort: None,
                    permission_mode: "bypassPermissions".into(),
                    files: vec![],
                    desktop: true,
                },
            )
            .unwrap();
        task.guest_cwd = base
            .join("workspaces")
            .join(&task.target.workspace_id)
            .to_str()
            .unwrap()
            .into();
        let sink = Arc::new(crate::sink::BroadcastSink::new(64));
        let manager = SessionManager::new(
            sink.clone(),
            Arc::new(crate::sink::NoObserver),
            Arc::new(crate::harness::host::Host::new()),
            Arc::new(crate::pty::Terminals::new()),
            Arc::new(Default::default()),
            Arc::new(Default::default()),
            crate::hooks::prepare_control().unwrap(),
        );
        let guest = Guest::open(base, manager, sink).unwrap();
        (home, guest, task)
    }

    #[test]
    fn macos_host_adapter_routes_real_guest_leases_and_recovers_lost_receipts_without_replay() {
        use super::super::attachment::{Adapter,Binding,recover_using};
        let (_home,guest,task)=setup();
        let root=crate::store::root().unwrap().join("host-journal");let journal=Journal::open_existing(&root).unwrap();
        journal.cancel(&task.target).unwrap();journal.transaction(|state|{state.enabled=true;Ok(())}).unwrap();
        let binding=Binding {environment_id:task.target.environment_id.clone(),generation:task.target.generation.clone(),lease_id:new_id(),session_id:task.input.parent_session_id.clone(),tab_id:task.input.parent_tab_id.clone(),conversation:Some("parent-fixture".into())};
        let target=crate::computer_targets::Target::MacosGuest {environment_id:binding.environment_id.clone(),generation:binding.generation.clone()};
        let catalog:Value=serde_json::from_str(include_str!("fixtures/cua-driver-0.28.0-list-windows.json")).unwrap();
        let effects=std::cell::Cell::new(0);let lose=std::cell::Cell::new(false);
        let mut rpc=|env:&super::super::journal::Environment,method:&str,params:Value|->Result<Value>{
            assert_eq!(env.id,binding.environment_id);assert_eq!(env.generation,binding.generation);
            match method {
                "desktop.attachmentCapabilities"=>Ok(json!({"attachmentProtocol":1,"platform":"macos","available":true,"runtimeSha256":"b".repeat(64),"environmentId":env.id,"generation":env.generation,"tools":[catalog["tool"]]})),
                "desktop.attachmentTools"=>Ok(json!({"binding":params,"tools":[catalog["tool"]]})),
                "desktop.attachmentCall"=>{let receipt=guest.attachment_call_using(&params,|_,_|{effects.set(effects.get()+1);Ok(json!({"content":[{"type":"text","text":"fixture window state"}]}))})?;if lose.get(){bail!("fixture transport lost receipt");}Ok(receipt)},
                _=>guest.dispatch(request(&guest,method,params)),
            }
        };
        let mut adapter=Adapter::begin(&root,&journal,binding.clone(),&mut rpc).unwrap();
        assert_eq!(adapter.tools(&mut rpc).unwrap()["tools"],json!([catalog["tool"]]));
        assert!(journal.submit("blocked-new-task",task.input.clone()).is_err());
        let call=json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_windows","arguments":{}}});
        let result=adapter.call(&call,&mut rpc).unwrap();assert_eq!(adapter.call(&call,&mut rpc).unwrap(),result);assert_eq!(effects.get(),1);
        let mut changed=call.clone();changed["params"]["arguments"]=json!({"pid":44});assert!(adapter.call(&changed,&mut rpc).is_err());
        let mut lost=call;lost["id"]=json!(2);lose.set(true);
        assert!(adapter.call(&lost,&mut rpc).is_err());assert!(adapter.call(&lost,&mut rpc).is_err());assert_eq!(effects.get(),2);
        drop(adapter);lose.set(false);
        let inspected=recover_using(&root,&journal,&target,None,&mut rpc).unwrap();assert_eq!(inspected["status"],"releaseAvailable");
        let mut wrong=binding.clone();wrong.tab_id=new_id();assert!(recover_using(&root,&journal,&target,Some(wrong),&mut rpc).is_err());
        let released=recover_using(&root,&journal,&target,Some(binding.clone()),&mut rpc).unwrap();assert_eq!(released["status"],"released");assert_eq!(effects.get(),2);
        let retained:Value=serde_json::from_slice(&fs::read(root.join("macos-attachments").join(format!("{}.json",binding.lease_id))).unwrap()).unwrap();
        assert_eq!(retained["calls"].as_object().unwrap().len(),2);assert_eq!(retained["guestLease"]["calls"].as_object().unwrap().len(),2);
        assert!(retained["calls"].as_object().unwrap().values().any(|call|call["status"]=="outcomeUnknown"));
        let mut next=binding.clone();next.lease_id=new_id();
        let frames=[json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
            json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_windows","arguments":{}}})];
        let input=frames.iter().map(Value::to_string).collect::<Vec<_>>().join("\n")+"\n";let mut output=Vec::new();
        super::super::attachment::serve_using(&root,&journal,next.clone(),&mut std::io::Cursor::new(input),&mut output,&mut rpc,&mut |actual|{assert_eq!(actual,&next);Ok(())}).unwrap();
        let replies:Vec<Value>=String::from_utf8(output).unwrap().lines().map(|line|serde_json::from_str(line).unwrap()).collect();
        assert_eq!(replies.len(),3);assert_eq!(replies[0]["result"]["protocolVersion"],"2025-06-18");
        assert_eq!(replies[1]["result"]["tools"],json!([catalog["tool"]]));assert!(replies[2]["result"]["content"].is_array());
        assert_eq!(effects.get(),3);
        journal.submit("after-release",task.input).unwrap();
    }

    #[test]
    fn discovery_uses_retained_ownership_and_unknown_helper_exit_cannot_advertise_capability() {
        use super::super::attachment::{Binding,probe_using,recover_using};
        let (_home,guest,task)=setup();
        let root=crate::store::root().unwrap().join("host-journal"); let journal=Journal::open_existing(&root).unwrap();
        journal.cancel(&task.target).unwrap();journal.transaction(|s|{s.enabled=true;Ok(())}).unwrap();
        let binding=Binding {environment_id:task.target.environment_id.clone(),generation:task.target.generation.clone(),lease_id:new_id(),session_id:task.input.parent_session_id.clone(),tab_id:task.input.parent_tab_id.clone(),conversation:None};
        let target=crate::computer_targets::Target::MacosGuest {environment_id:binding.environment_id.clone(),generation:binding.generation.clone()};
        let unknown=std::cell::Cell::new(false);
        let mut rpc=|env:&super::super::journal::Environment,method:&str,params:Value|->Result<Value>{
            match method {
                "desktop.attachmentCapabilities"=>Ok(json!({"attachmentProtocol":1,"platform":"macos","available":true,"runtimeSha256":"b".repeat(64),"environmentId":env.id,"generation":env.generation})),
                "desktop.attachmentTools"=>{
                    assert!(require_queue_control(&guest.state.lock().unwrap()).is_err());
                    if unknown.get() {
                        let mut state=serde_json::to_value(durable(&guest))?;
                        state["attachments"][params["leaseId"].as_str().unwrap()]["connectionStarted"]=json!(true);
                        let state:State=serde_json::from_value(state)?;guest.save(&state)?;*guest.state.lock().unwrap()=state;
                        bail!("fixture discovery helper exit unknown");
                    }
                    Ok(json!({"binding":params,"tools":[{"name":"list_windows","inputSchema":{"type":"object"}}]}))
                },
                _=>guest.dispatch(request(&guest,method,params)),
            }
        };
        assert_eq!(probe_using(&root,&journal,binding.clone(),&mut rpc).unwrap()["available"],true);
        assert!(!journal.has_desktop_reservations().unwrap());
        let retained:Value=serde_json::from_slice(&fs::read(root.join("macos-attachments").join(format!("{}.json",binding.lease_id))).unwrap()).unwrap();
        assert_eq!(retained["status"],"released");
        let mut next=binding;next.lease_id=new_id();unknown.set(true);
        assert!(probe_using(&root,&journal,next.clone(),&mut rpc).is_err());
        assert!(journal.has_desktop_reservations().unwrap());
        assert_eq!(recover_using(&root,&journal,&target,None,&mut rpc).unwrap()["status"],"fenced");
        assert!(recover_using(&root,&journal,&target,Some(next),&mut rpc).is_err());
        assert!(journal.submit("unknown-discovery-blocks-task",task.input).is_err());
    }

    #[test]
    fn release_tombstone_blocks_late_acquisition_and_missing_mcp_exit_stays_fenced() {
        let (_home,guest,_task)=setup();let identity=guest.state.lock().unwrap().identity.clone();
        let binding=json!({"environmentId":identity.environment_id,"generation":identity.generation,"leaseId":new_id(),"sessionId":new_id(),"tabId":new_id(),"conversation":null});
        assert_eq!(guest.attachment_read(&binding).unwrap()["missing"],true);
        let mut release=binding.clone();release["confirm"]=json!(true);
        let tombstone=guest.attachment_release(&release).unwrap();assert_eq!(tombstone["releaseProof"]["kind"],"neverAcquiredTombstone");
        assert_eq!(guest.attachment_acquire(&binding).unwrap(),tombstone);
        require_queue_control(&guest.state.lock().unwrap()).unwrap();
        let mut binding=binding;binding["leaseId"]=json!(new_id());guest.attachment_acquire(&binding).unwrap();
        let mut state=serde_json::to_value(durable(&guest)).unwrap();state["attachments"][binding["leaseId"].as_str().unwrap()]["connectionStarted"]=json!(true);
        let state:State=serde_json::from_value(state).unwrap();guest.save(&state).unwrap();*guest.state.lock().unwrap()=state;
        let mut release=binding.clone();release["confirm"]=json!(true);
        assert_eq!(guest.attachment_read(&binding).unwrap()["releaseAvailable"],false);
        assert!(guest.attachment_close(&binding).is_err());assert!(guest.attachment_release(&release).is_err());
        assert!(guest.attachment_tools(&binding).is_err());
    }

    #[test]
    fn attached_guest_calls_are_exclusive_durable_and_never_replayed_after_unknown_exit() {
        let (_home, guest, task) = setup();
        let identity=guest.state.lock().unwrap().identity.clone();
        let binding=json!({"environmentId":identity.environment_id,
            "generation":identity.generation,"leaseId":new_id(),"sessionId":new_id(),"tabId":new_id(),"conversation":"parent"});
        let lease=guest.attachment_acquire(&binding).unwrap();
        assert_eq!(guest.attachment_acquire(&binding).unwrap(),lease);
        assert!(require_queue_control(&guest.state.lock().unwrap()).is_err());
        assert!(guest.setup_action_using(&json!({"environmentId":identity.environment_id,"generation":identity.generation,
            "action":"provider.codexDeviceLogin.start","idempotencyKey":"blocked-login","confirm":true}),|_,_,_,_|panic!("setup during attachment")).is_err());
        seed(&guest, record(task.clone()));
        assert!(guest.takeover(&json!({"target":task.target,"confirm":true})).is_err());
        let mut terminal=record(task);terminal.task.status=TaskStatus::Canceled;seed(&guest,terminal);
        let mut other=binding.clone();other["leaseId"]=json!(new_id());
        assert!(guest.attachment_acquire(&other).is_err());
        let mut call=binding.clone();call["idempotencyKey"]=json!("input-one");call["tool"]=json!("type_text");call["arguments"]=json!({"text":"fixture only"});
        let receipt=guest.attachment_call_using(&call,|_,_|Ok(json!({"ok":true}))).unwrap();
        assert_eq!(receipt["status"],"complete");
        assert_eq!(guest.attachment_call_using(&call,|_,_|panic!("replayed input")).unwrap(),receipt);
        let mut changed=call.clone();changed["arguments"]=json!({"text":"different"});
        assert!(guest.attachment_call_using(&changed,|_,_|panic!("changed input")).is_err());
        call["idempotencyKey"]=json!("input-lost");
        let unknown=guest.attachment_call_using(&call,|_,_|bail!("lost driver exit")).unwrap();
        assert_eq!(unknown["status"],"outcomeUnknown");
        let mut release=binding.clone();release["confirm"]=json!(true);
        assert!(guest.attachment_release(&release).is_err());
        let base=guest.base.clone();let manager=guest.manager.clone();let sink=guest.sink.clone();drop(guest);
        let reopened=Guest::open(base,manager,sink).unwrap();
        assert!(require_queue_control(&reopened.state.lock().unwrap()).is_err());
        assert_eq!(reopened.attachment_call_using(&call,|_,_|panic!("replay after owner restart")).unwrap(),unknown);
        call["idempotencyKey"]=json!("later-input");
        assert!(reopened.attachment_call_using(&call,|_,_|panic!("input while fenced")).is_err());
        assert!(reopened.attachment_release(&release).is_err());
        assert_eq!(reopened.attachment_read(&binding).unwrap()["calls"].as_object().unwrap().len(),2);
        let mut stale=binding.clone();stale["generation"]=json!(new_id());
        assert!(reopened.attachment_read(&stale).is_err());
        // Disposable retained-state fixture simulates a prior kernel boot.
        // The public release request cannot supply or override this evidence.
        let mut earlier=serde_json::to_value(durable(&reopened)).unwrap();
        earlier["attachments"][binding["leaseId"].as_str().unwrap()]["bootIdentity"]=json!(new_id());
        let base=reopened.base.clone();let manager=reopened.manager.clone();let sink=reopened.sink.clone();drop(reopened);
        atomic_private_write(&base.join("runtime").join(STATE),&serde_json::to_vec(&earlier).unwrap()).unwrap();
        let later=Guest::open(base,manager,sink).unwrap();
        let released=later.attachment_release(&release).unwrap();
        assert_eq!(released["releaseProof"]["kind"],"laterKernelBoot");
        assert_eq!(released["releaseProof"]["priorActionOutcomeUnknown"],true);
        assert_eq!(released["calls"]["input-lost"]["status"],"outcomeUnknown");
    }

    #[test]
    fn idle_attached_guest_release_retains_history_and_rejects_delayed_input() {
        let (_home, guest, _task)=setup();
        let identity=guest.state.lock().unwrap().identity.clone();
        let binding=json!({"environmentId":identity.environment_id,"generation":identity.generation,
            "leaseId":new_id(),"sessionId":new_id(),"tabId":new_id(),"conversation":null});
        guest.attachment_acquire(&binding).unwrap();
        assert!(guest.attachment_release(&binding).is_err());
        let mut release=binding.clone();release["confirm"]=json!(true);
        let receipt=guest.attachment_release(&release).unwrap();
        assert_eq!(receipt["releaseProof"]["kind"],"allCallsReceipted");
        require_queue_control(&guest.state.lock().unwrap()).unwrap();
        assert_eq!(guest.attachment_acquire(&binding).unwrap(),receipt);
        let mut call=binding;call["idempotencyKey"]=json!("delayed");call["tool"]=json!("click");call["arguments"]=json!({});
        assert!(guest.attachment_call_using(&call,|_,_|panic!("released lease accepted input")).is_err());
        assert_eq!(durable(&guest).attachments.len(),1);
        for action in [setup::Action::DriverStart,setup::Action::DriverPermissions,setup::Action::DesktopVerify] {
            assert!(check_setup_action(true,action).is_err());
        }
        for action in [setup::Action::LoginStart,setup::Action::LoginCancel,setup::Action::AccountVerify] {
            check_setup_action(true,action).unwrap();
        }
    }

    #[test]
    fn idle_unready_setup_allows_owner_shutdown_only_with_fresh_guest_history() {
        let (_home, guest, task) = setup();
        let journal =
            Journal::open_existing(&crate::store::root().unwrap().join("host-journal")).unwrap();
        journal.cancel(&task.target).unwrap();
        guest.cancel(&task.target).unwrap();
        journal
            .transaction(|state| {
                let env = state
                    .environments
                    .get_mut(&task.target.environment_id)
                    .unwrap();
                let mut report =
                    super::super::setup::initial(env, "codex", "setup-without-readiness")?;
                report["status"] = json!("needsAttention");
                env.setup = Some(report);
                Ok(())
            })
            .unwrap();
        let before_host = serde_json::to_value(journal.read().unwrap()).unwrap();
        let before_guest = fs::read(guest.base.join("runtime").join(STATE)).unwrap();
        assert!(super::super::supervisor::state_busy(
            &journal.read().unwrap()
        ));
        let check = || {
            super::super::owner_shutdown::verify_using(&journal, |env| {
                assert_eq!(env.id, task.target.environment_id);
                guest.dispatch(request(&guest, "environment.disposition", json!({})))
            })
        };
        check().expect("An explicitly stopped owner may leave a proven idle, unready VM running");
        assert_eq!(
            serde_json::to_value(journal.read().unwrap()).unwrap(),
            before_host
        );
        assert_eq!(
            fs::read(guest.base.join("runtime").join(STATE)).unwrap(),
            before_guest
        );
        assert!(
            super::super::supervisor::state_busy(&journal.read().unwrap()),
            "Idle auto-exit must still retain setup awaiting attention"
        );
        for (field, value) in [
            ("activeOwnedGroups", json!(1)),
            ("manualControl", json!(true)),
            ("complete", json!(false)),
            ("generation", json!(new_id())),
            ("setupOperations", Value::Null),
        ] {
            assert!(
                super::super::owner_shutdown::verify_using(&journal, |_| {
                    let mut disposition = guest.disposition()?;
                    disposition[field] = value.clone();
                    Ok(disposition)
                })
                .is_err(),
                "{field}"
            );
        }
        assert!(
            super::super::owner_shutdown::verify_using(&journal, |_| bail!("offline guest"))
                .is_err()
        );
        assert!(super::super::owner_shutdown::verify_using(&journal, |_| {
            let work = guest.disposition()?;
            journal.transaction(|state| {
                state.enabled = !state.enabled;
                Ok(())
            })?;
            Ok(work)
        })
        .unwrap_err()
        .to_string()
        .contains("history changed"));
    }

    #[test]
    fn owner_shutdown_preserves_unknown_actions_and_requires_proven_helper_exit() {
        let (_home, guest, task) = setup();
        let journal =
            Journal::open_existing(&crate::store::root().unwrap().join("host-journal")).unwrap();
        journal.cancel(&task.target).unwrap();
        guest.cancel(&task.target).unwrap();
        let key = "interrupted-desktop-check";
        let params = request(
            &guest,
            "environment.setupAction",
            json!({
                "action":"desktop.verify", "idempotencyKey":key, "confirm":true
            }),
        )
        .params;
        // Exercise the durable guest receipt path without invoking a desktop or
        // provider. An unknown result alone never proves the helper has exited.
        let receipt = guest
            .setup_action_using(&params, |actor, params, _, _| {
                actor.test_receipt(
                    setup::Receipt {
                        action: params.action,
                        idempotency_key: params.idempotency_key,
                        status: setup::Status::OutcomeUnknown,
                        detail: Some("interrupted_test_helper".into()),
                        verification: None,
                        account_verification: None,
                    },
                    false,
                );
                Ok(())
            })
            .unwrap();
        journal
            .transaction(|state| {
                let env = state
                    .environments
                    .get_mut(&task.target.environment_id)
                    .unwrap();
                let mut report = super::super::setup::initial(env, "codex", "interrupted-setup")?;
                report["status"] = json!("outcomeUnknown");
                report["operations"] =
                    json!({key:{"digest":digest(&serde_json::to_vec(&params)?),"receipt":receipt}});
                report["action"] = receipt.clone();
                env.setup = Some(report);
                Ok(())
            })
            .unwrap();
        let check =
            || super::super::owner_shutdown::verify_using(&journal, |_| guest.disposition());
        assert!(
            check().is_err(),
            "An unknown, unexited helper still holds the owner"
        );
        {
            let mut state = guest.state.lock().unwrap();
            state
                .setup_operations
                .get_mut(key)
                .unwrap()
                .helper_exit_confirmed = true;
            guest.save(&state).unwrap();
        }
        let before_host = serde_json::to_value(journal.read().unwrap()).unwrap();
        let before_guest = fs::read(guest.base.join("runtime").join(STATE)).unwrap();
        check().unwrap();
        assert_eq!(
            serde_json::to_value(journal.read().unwrap()).unwrap(),
            before_host
        );
        assert_eq!(
            fs::read(guest.base.join("runtime").join(STATE)).unwrap(),
            before_guest
        );
        assert_eq!(
            journal.read().unwrap().environments[&task.target.environment_id]
                .setup
                .as_ref()
                .unwrap()["action"]["status"],
            "outcomeUnknown"
        );
        for (pointer, value) in [
            (
                format!("/setupOperations/{key}/helperExitConfirmed"),
                json!(false),
            ),
            (
                format!("/setupOperations/{key}/generation"),
                json!(new_id()),
            ),
            (
                format!("/setupOperations/{key}/receipt/action"),
                Value::Null,
            ),
            (
                format!("/setupOperations/{key}/receipt/status"),
                json!("working"),
            ),
            (format!("/setupOperations/{key}/digest"), json!("damaged")),
        ] {
            assert!(
                super::super::owner_shutdown::verify_using(&journal, |_| {
                    let mut work = guest.disposition()?;
                    *work.pointer_mut(&pointer).unwrap() = value.clone();
                    Ok(work)
                })
                .is_err(),
                "{pointer}"
            );
        }
        let original = journal.read().unwrap().environments[&task.target.environment_id]
            .setup
            .clone()
            .unwrap();
        for (pointer, value) in [
            ("/action/idempotencyKey".to_string(), json!("lost-key")),
            ("/steps".to_string(), json!([])),
            ("/generation".to_string(), json!(new_id())),
            (format!("/operations/{key}/receipt/action"), Value::Null),
        ] {
            journal
                .transaction(|state| {
                    let report = state
                        .environments
                        .get_mut(&task.target.environment_id)
                        .unwrap()
                        .setup
                        .as_mut()
                        .unwrap();
                    *report = original.clone();
                    *report.pointer_mut(&pointer).unwrap() = value;
                    Ok(())
                })
                .unwrap();
            assert!(check().is_err(), "{pointer}");
        }
        journal
            .transaction(|state| {
                let report = state
                    .environments
                    .get_mut(&task.target.environment_id)
                    .unwrap()
                    .setup
                    .as_mut()
                    .unwrap();
                *report = original.clone();
                report["history"] = json!([original]);
                Ok(())
            })
            .unwrap();
        check().unwrap();
        journal
            .transaction(|state| {
                let report = state
                    .environments
                    .get_mut(&task.target.environment_id)
                    .unwrap()
                    .setup
                    .as_mut()
                    .unwrap();
                report["history"][0]["operations"][key]["digest"] = json!("a".repeat(64));
                Ok(())
            })
            .unwrap();
        assert!(check()
            .unwrap_err()
            .to_string()
            .contains("identity changed"));
        journal
            .transaction(|state| {
                state
                    .environments
                    .get_mut(&task.target.environment_id)
                    .unwrap()
                    .setup = Some(original);
                Ok(())
            })
            .unwrap();
        // A proven different boot permits host shutdown but retains the exact
        // unknown receipt. This changes only a disposable test's old record.
        {
            let mut state = guest.state.lock().unwrap();
            let operation = state.setup_operations.get_mut(key).unwrap();
            operation.helper_exit_confirmed = false;
            operation.boot_identity = Some(new_id());
            guest.save(&state).unwrap();
        }
        check().unwrap();
        assert_eq!(
            guest.state.lock().unwrap().setup_operations[key]
                .receipt
                .status,
            setup::Status::OutcomeUnknown
        );
    }

    #[test]
    fn setup_action_intent_precedes_effect_and_exact_receipt_is_atomic_idempotent() {
        let (_home, guest, _task) = setup();
        let params = request(
            &guest,
            "environment.setupAction",
            json!({
            "action":"driver.start","idempotencyKey":"setup-exact-key","confirm":true}),
        )
        .params;
        let count = std::sync::atomic::AtomicUsize::new(0);
        let path = guest.base.join("runtime").join(STATE);
        let result = guest
            .setup_action_using(&params, |actor, params, _, _| {
                let retained: State = serde_json::from_slice(&fs::read(&path)?)?;
                assert_eq!(
                    retained.setup_operations[&params.idempotency_key]
                        .receipt
                        .status,
                    setup::Status::Working
                );
                count.fetch_add(1, Ordering::Relaxed);
                actor.test_receipt(
                    setup::Receipt {
                        action: params.action,
                        idempotency_key: params.idempotency_key,
                        status: setup::Status::Complete,
                        detail: Some("verified_disposable_effect".into()),
                        verification: None,
                        account_verification: None,
                    },
                    true,
                );
                Ok(())
            })
            .unwrap();
        assert_eq!(result["status"], "complete");
        let retained: State = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            retained.setup_operations["setup-exact-key"].receipt.status,
            setup::Status::Complete
        );
        assert_eq!(
            guest
                .setup_action_using(&params, |_, _, _, _| panic!("same key replayed effect"))
                .unwrap(),
            result
        );
        assert_eq!(count.load(Ordering::Relaxed), 1);
        let status = request(
            &guest,
            "environment.setupActionStatus",
            json!({"idempotencyKey":"setup-exact-key"}),
        );
        assert_eq!(guest.dispatch(status).unwrap(), result);
        assert!(guest
            .dispatch(request(
                &guest,
                "environment.setupActionStatus",
                json!({"idempotencyKey":"unknown"})
            ))
            .is_err());
        assert_eq!(count.load(Ordering::Relaxed), 1);
        let mut changed = params.clone();
        changed["action"] = json!("desktop.verify");
        assert!(guest
            .setup_action_using(&changed, |_, _, _, _| panic!("changed key effect"))
            .is_err());
        changed = params.clone();
        changed["generation"] = json!(new_id());
        assert!(guest
            .setup_action_using(&changed, |_, _, _, _| panic!("wrong identity effect"))
            .is_err());
    }

    #[test]
    fn setup_action_disk_failure_never_exposes_success_or_replays_effect() {
        let (_home, guest, _task) = setup();
        let params = request(
            &guest,
            "environment.setupAction",
            json!({
            "action":"desktop.verify","idempotencyKey":"setup-disk-key","confirm":true}),
        )
        .params;
        let path = guest.base.join("runtime").join(STATE);
        let saved = path.with_extension("retained");
        let error = guest.setup_action_using(&params, |actor, params, _, _| {
            // The durable working intent survives a completion disk failure.
            fs::rename(&path, &saved)?;
            fs::create_dir(&path)?;
            actor.test_receipt(
                setup::Receipt {
                    action: params.action,
                    idempotency_key: params.idempotency_key,
                    status: setup::Status::Complete,
                    detail: Some("verified_disposable_capture".into()),
                    verification: None,
                    account_verification: None,
                },
                true,
            );
            Ok(())
        });
        assert!(error.is_err());
        assert_eq!(
            guest.state.lock().unwrap().setup_operations["setup-disk-key"]
                .receipt
                .status,
            setup::Status::Working
        );
        let disk: State = serde_json::from_slice(&fs::read(&saved).unwrap()).unwrap();
        assert_eq!(
            disk.setup_operations["setup-disk-key"].receipt.status,
            setup::Status::Working
        );
        fs::remove_dir(&path).unwrap();
        fs::rename(&saved, &path).unwrap();
        let result = guest
            .dispatch(request(&guest, "environment.setupAction", params.clone()))
            .unwrap();
        assert_eq!(result["status"], "complete");
        assert_eq!(
            guest
                .setup_action_using(&params, |_, _, _, _| panic!("disk retry replayed effect"))
                .unwrap(),
            result
        );
        let disk: State = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(
            disk.setup_operations["setup-disk-key"].receipt.status,
            setup::Status::Complete
        );
    }

    #[test]
    fn setup_action_restart_retains_unknown_and_same_key_cannot_start_again() {
        let (_home, guest, _task) = setup();
        let params=request(&guest,"environment.setupAction",json!({
            "action":"provider.codexDeviceLogin.start","idempotencyKey":"lost-login","confirm":true})).params;
        let result = guest
            .setup_action_using(&params, |_, _, _, _| Ok(()))
            .unwrap();
        assert_eq!(result["status"], "working");
        let base = guest.base.clone();
        let manager = guest.manager.clone();
        let sink = guest.sink.clone();
        drop(guest);
        let guest = Guest::open(base, manager, sink).unwrap();
        let result = guest
            .setup_action_using(&params, |_, _, _, _| panic!("lost login replayed"))
            .unwrap();
        assert_eq!(result["status"], "outcomeUnknown");
        assert!(require_queue_control(&guest.state.lock().unwrap()).is_err());
        let auth = guest
            .dispatch(request(
                &guest,
                "environment.setupAuth",
                json!({"idempotencyKey":"lost-login"}),
            ))
            .unwrap();
        assert_eq!(auth["status"], "outcomeUnknown");
        assert!(auth.get("challenge").is_none());
        let durable = serde_json::to_string(&durable(&guest)).unwrap();
        assert!(!durable.contains("userCode"));
        assert!(!durable.contains("verificationUrl"));
        assert!(!durable.contains("loginId"));
    }

    #[test]
    fn setup_shutdown_fences_helpers_without_waiting_for_task_state_lock() {
        let (_home, guest, _task) = setup();
        let held = guest.state.lock().unwrap();
        let started = std::time::Instant::now();
        guest.shutdown();
        assert!(started.elapsed() < Duration::from_millis(250));
        assert!(guest.stopped.load(Ordering::Acquire));
        drop(held);
        assert!(guest
            .dispatch(request(
                &guest,
                "environment.setupAuth",
                json!({"idempotencyKey":"absent"})
            ))
            .is_err());
    }

    #[test]
    fn setup_effects_refuse_manual_or_unfinished_work_and_missing_journal() {
        let (_home, guest, task) = setup();
        let params = request(
            &guest,
            "environment.setupAction",
            json!({
            "action":"driver.start","idempotencyKey":"blocked-setup","confirm":true}),
        )
        .params;
        {
            let mut state = guest.state.lock().unwrap();
            state.manual_lease = Some(ManualLease {
                target: task.target.clone(),
                acquired_at: now(),
                ready: true,
            });
            guest.save(&state).unwrap();
        }
        assert!(guest
            .setup_action_using(&params, |_, _, _, _| panic!("manual lease bypassed"))
            .is_err());
        {
            let mut state = guest.state.lock().unwrap();
            state.manual_lease = None;
            let record = recoverable_record(task, "previous-boot");
            state
                .records
                .insert(record.task.target.task_id.clone(), record);
            guest.save(&state).unwrap();
        }
        assert!(guest
            .setup_action_using(&params, |_, _, _, _| panic!("unfinished task bypassed"))
            .is_err());
        {
            let mut state = guest.state.lock().unwrap();
            state.records.clear();
            guest.save(&state).unwrap();
        }
        fs::remove_file(guest.base.join("runtime").join(STATE)).unwrap();
        assert!(guest
            .setup_action_using(&params, |_, _, _, _| panic!("missing journal recreated"))
            .is_err());
        assert!(!guest.base.join("runtime").join(STATE).exists());
    }

    #[test]
    fn setup_readiness_requires_exact_identity_and_refuses_prompt_or_action_parameters() {
        let (_home, guest, _task) = setup();
        let path = guest.base.join("runtime").join(STATE);
        let before = fs::read(&path).unwrap();
        let mut wrong = request(
            &guest,
            "environment.setupReadiness",
            json!({"harness":"codex"}),
        );
        wrong.params["generation"] = json!(new_id());
        assert!(guest
            .dispatch(wrong)
            .unwrap_err()
            .to_string()
            .contains("mismatch"));
        for params in [
            json!({"harness":"codex","prompt":true}),
            json!({"harness":"codex","action":"driver.start"}),
            json!({"harness":"shell"}),
        ] {
            assert!(guest
                .dispatch(request(&guest, "environment.setupReadiness", params))
                .is_err());
        }
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn installed_guest_guard_precedes_all_generic_owner_window_mobile_and_sharing_routes() {
        let (_home, guest, task) = setup();
        let req = request(&guest, "desktop.state", json!({}));
        let endpoint = crate::hooks::prepare_control().unwrap();
        let service = crate::control::ControlService::headless(
            guest.sink.clone(),
            guest.manager.clone(),
            endpoint,
            "local".into(),
        )
        .with_local_lifetime(crate::local_runtime::Lifetime::new(Duration::from_secs(60)))
        .with_guest(Some(Arc::new(guest)));
        for command in [
            "status",
            "sessions.list",
            "runtime.attach",
            "runtime.stopAll",
            "runtime.window.register",
            "runtime.mobile.register",
            "runtime.sharing.register",
            "runtime.session.send",
            "local_vm.request",
            "computer.click",
        ] {
            let response = service.handle(crate::control::ControlRequest {
                id: new_id(),
                token: String::new(),
                command: command.into(),
                params: json!({}),
            });
            assert!(!response.ok, "{command}");
            assert_eq!(response.error.unwrap().code, "unsupported", "{command}");
        }
        let response = service.handle(crate::control::ControlRequest {
            id: new_id(),
            token: String::new(),
            command: "local_vm.guest".into(),
            params: json!({"method":req.method,"params":req.params}),
        });
        assert!(response.ok);
        assert_eq!(
            response.result.unwrap()["generation"],
            task.target.generation
        );
    }

    fn record(task: Task) -> Record {
        Record {
            task,
            files: vec![],
            baseline: None,
            source_seq: 0,
            source_events: 0,
            operations: BTreeMap::new(),
            artifacts_pending: false,
            boot_identity: None,
            prior_external_outcome_unknown: false,
        }
    }

    #[test]
    fn provisioning_evidence_uses_durable_pre_execution_marker_and_rejects_lost_history() {
        let (_home, guest, task) = setup();
        let proof = guest.provision_evidence().unwrap();
        assert_eq!(proof["noExecutionSinceInitialization"], true);
        assert_eq!(proof["initializedTimeline"]["noExecution"], true);
        assert!(proof["currentBootIdentity"]
            .as_str()
            .is_some_and(|b| validate_id(b).is_ok()));
        seed(&guest, record(task));
        assert_eq!(
            guest.provision_evidence().unwrap()["noExecutionSinceInitialization"],
            false
        );
        let path = guest.base.join("runtime").join(STATE);
        fs::remove_file(&path).unwrap();
        assert!(guest.provision_evidence().is_err());
        let base = guest.base.clone();
        let manager = guest.manager.clone();
        let sink = guest.sink.clone();
        drop(guest);
        assert!(Guest::open(base, manager, sink).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn legacy_initialization_and_restarts_never_mint_or_advance_no_execution_proof() {
        let (_home, guest, _task) = setup();
        let base = guest.base.clone();
        let manager = guest.manager.clone();
        let sink = guest.sink.clone();
        let path = base.join("runtime").join(STATE);
        let mut retained: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        retained
            .as_object_mut()
            .unwrap()
            .remove("provisioningBaseline");
        atomic_private_write(&path, &serde_json::to_vec(&retained).unwrap()).unwrap();
        drop(guest);
        let guest = Guest::open(base.clone(), manager.clone(), sink.clone()).unwrap();
        let proof = guest.provision_evidence().unwrap();
        assert_eq!(proof["noExecutionSinceInitialization"], false);
        assert_eq!(
            proof["initializedTimeline"]["bootIdentity"],
            proof["currentBootIdentity"]
        );
        drop(guest);
        let guest = Guest::open(base, manager, sink).unwrap();
        assert_eq!(guest.provision_evidence().unwrap(), proof);
        let mut state = guest.state.lock().unwrap();
        state.canceled_targets.insert(new_id(), _task.target);
        guest.save(&state).unwrap();
        drop(state);
        assert!(!guest.provision_evidence().unwrap()["canceledTargets"]
            .as_object()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn empty_guest_records_do_not_hide_retained_root_or_session_index_data() {
        let (_home, guest, _task) = setup();
        fs::create_dir(guest.base.join("workspaces/unlisted-work")).unwrap();
        fs::write(
            guest.base.join("artifacts/orphan-file"),
            b"Retain this data",
        )
        .unwrap();
        let sessions = crate::store::root().unwrap().join("sessions");
        fs::create_dir(sessions.join("unlisted-session")).unwrap();
        fs::write(
            sessions.join("index.json"),
            br#"{"sessions":[],"futureRetainedData":{"resume":"unlisted"}}"#,
        )
        .unwrap();
        let report = guest.disposition().unwrap();
        assert!(report["tasks"].as_array().unwrap().is_empty());
        assert_eq!(
            report["retainedData"]["workspaceEntries"],
            json!(["unlisted-work"])
        );
        assert_eq!(
            report["retainedData"]["artifactEntries"],
            json!(["orphan-file"])
        );
        assert_eq!(
            report["retainedData"]["sessionEntries"],
            json!(["unlisted-session"])
        );
        assert_eq!(report["retainedData"]["sessionIndexHasData"], true);
        fs::remove_file(sessions.join("index.json")).unwrap();
        fs::remove_dir_all(&sessions).unwrap();
        assert!(guest.provision_evidence().is_err());
        assert!(!sessions.exists());
    }

    #[test]
    fn retained_index_inspects_typed_follow_history_and_nested_unknown_metadata() {
        let (_home, guest, mut task) = setup();
        let session = new_id();
        let tab = new_id();
        let provider = new_id();
        task.worker_session_id = Some(session.clone());
        task.worker_tab_id = Some(tab.clone());
        task.provider_conversation_id = Some(provider.clone());
        seed(&guest, record(task.clone()));
        let path = crate::store::root().unwrap().join("sessions/index.json");
        let indexed = json!({"sessions":[{"id":session,"projectPath":task.guest_cwd,"cwd":task.guest_cwd,
            "title":"Tracked worker","created":now(),"modified":now(),"tabs":[{"id":tab,"harness":"codex",
                "created":now(),"providerSessionId":provider}]}]});
        atomic_private_write(&path, &serde_json::to_vec(&indexed).unwrap()).unwrap();
        let state = guest.state.lock().unwrap();
        assert_eq!(
            retained_data(&guest.base, &state).unwrap()["unaccountedData"],
            false
        );
        for (pointer, value) in [
            (
                "/sessions/0/tabs/0/history",
                json!([{"harness":"codex","providerSessionId":"older-retained-resume","ended":now()}]),
            ),
            ("/sessions/0/unknownRetainedData", json!({"resume":"older"})),
            (
                "/sessions/0/tabs/0/unknownRetainedData",
                json!({"resume":"older"}),
            ),
        ] {
            let mut changed = indexed.clone();
            let (parent, key) = pointer.rsplit_once('/').unwrap();
            changed
                .pointer_mut(parent)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert(key.into(), value);
            atomic_private_write(&path, &serde_json::to_vec(&changed).unwrap()).unwrap();
            assert_eq!(
                retained_data(&guest.base, &state).unwrap()["unaccountedData"],
                true,
                "{pointer}"
            );
        }
    }

    fn seed(guest: &Guest, record: Record) {
        let mut state = guest.state.lock().unwrap();
        state
            .records
            .insert(record.task.target.task_id.clone(), record);
        guest.save(&state).unwrap();
    }

    fn request(guest: &Guest, method: &str, mut params: Value) -> Request {
        let identity = guest.state.lock().unwrap().identity.clone();
        params["environmentId"] = json!(identity.environment_id);
        params["generation"] = json!(identity.generation);
        Request {
            expected_runtime_sha256: None,
            expected_macos_account: None,
            method: method.into(),
            params,
        }
    }

    const OLD_BOOT: &str = "11111111-1111-4111-8111-111111111111";
    const NEW_BOOT: &str = "22222222-2222-4222-8222-222222222222";
    const RECOVERY_KEY: &str = "recover exact key: / λ";

    fn durable(guest: &Guest) -> State {
        serde_json::from_slice(&fs::read(guest.base.join("runtime").join(STATE)).unwrap()).unwrap()
    }

    // Start at the durable pre-effect boundary, without a fake provider or
    // credentials. The real receipt checkpoint and retry RPCs run unchanged.
    fn pending_recovery(
        guest: &mut Guest,
        mut task: Task,
    ) -> (Request, mpsc::Sender<std::result::Result<(), String>>) {
        guest.boot_identity = Some(NEW_BOOT.into());
        task.status = TaskStatus::OutcomeUnknown;
        task.worker_session_id = Some(new_id());
        task.worker_tab_id = Some(new_id());
        task.provider_conversation_id = Some(new_id());
        let request = request(
            guest,
            "task.recover",
            json!({"target":task.target,"confirm":true,
            "text":"Inspect the earlier effects, then perform only this new instruction.","idempotencyKey":RECOVERY_KEY}),
        );
        let mut record = record(task.clone());
        record.boot_identity = Some(OLD_BOOT.into());
        prepare_recovery(
            &mut record,
            guest.boot_identity.as_deref(),
            RECOVERY_KEY,
            &digest(&serde_json::to_vec(&(request.method.as_str(), &request.params)).unwrap()),
            request.params["text"].as_str().unwrap(),
        )
        .unwrap();
        seed(guest, record);
        let (sender, receiver) = mpsc::channel();
        guest
            .recovery_receipts
            .lock()
            .unwrap()
            .push(RecoveryReceipt {
                target: task.target,
                idempotency_key: RECOVERY_KEY.into(),
                operation_key: format!("task.recover:{RECOVERY_KEY}"),
                receiver,
                result: None,
            });
        (request, sender)
    }

    fn checkpoint(guest: &Guest) -> Result<()> {
        guest.checkpoint_recovery_receipts(&mut guest.state.lock().unwrap())
    }

    fn recovered(task: &Task) -> usize {
        task.events
            .iter()
            .filter(|event| {
                event.payload == json!({"type":"taskRecovered","idempotencyKey":RECOVERY_KEY})
            })
            .count()
    }

    #[test]
    fn recovery_and_untracked_cancel_require_changed_kernel_boot_proof() {
        for (previous, current) in [
            (None, Some(NEW_BOOT)),
            (Some(OLD_BOOT), None),
            (Some("runtime-launch-id"), Some(NEW_BOOT)),
            (Some(OLD_BOOT), Some("pid:123")),
            (Some(OLD_BOOT), Some(OLD_BOOT)),
        ] {
            assert!(require_boot_change(previous, current).is_err());
        }
        require_boot_change(Some(OLD_BOOT), Some(NEW_BOOT)).unwrap();
        let (_home, mut guest, mut task) = setup();
        guest.boot_identity = Some(OLD_BOOT.into());
        task.status = TaskStatus::OutcomeUnknown;
        task.worker_session_id = Some(new_id());
        task.worker_tab_id = Some(new_id());
        task.provider_conversation_id = Some(new_id());
        let mut retained = record(task.clone());
        retained.boot_identity = Some(OLD_BOOT.into());
        seed(&guest, retained);
        let req = request(
            &guest,
            "task.recover",
            json!({"target":task.target,"confirm":true,
            "text":"New human instruction","idempotencyKey":"boot-proof"}),
        );
        assert!(guest
            .dispatch(req)
            .unwrap_err()
            .to_string()
            .contains("boot has not changed"));
        let canceled = guest.cancel(&task.target).unwrap();
        assert_eq!(canceled["status"], "outcomeUnknown");
        assert!(durable(&guest).records[&task.target.task_id]
            .task
            .status
            .holds_desktop());
        guest.boot_identity = Some(NEW_BOOT.into());
        let canceled = guest.cancel(&task.target).unwrap();
        assert_eq!(canceled["status"], "canceled");
        assert!(durable(&guest).records[&task.target.task_id].prior_external_outcome_unknown);
        assert!(crate::store::index::load().unwrap().is_empty());
    }

    #[test]
    fn recovery_admission_and_same_key_retry_never_acknowledge_or_replay() {
        let (_home, mut guest, task) = setup();
        let (req, _sender) = pending_recovery(&mut guest, task.clone());
        let before = fs::read(guest.base.join("runtime").join(STATE)).unwrap();
        for _ in 0..2 {
            let response: Task = serde_json::from_value(
                guest
                    .dispatch(Request {
                expected_runtime_sha256: None,
                expected_macos_account: None,
                        method: req.method.clone(),
                        params: req.params.clone(),
                    })
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(response.status, TaskStatus::Starting);
            assert_eq!(recovered(&response), 0);
        }
        checkpoint(&guest).unwrap(); // Admission with no confirmed delivery.
        let persisted = durable(&guest);
        let retained = &persisted.records[&task.target.task_id];
        assert_eq!(retained.task.input, task.input);
        assert_eq!(retained.task.target, task.target);
        assert_eq!(retained.task.input_digest, task.input_digest);
        assert!(retained.prior_external_outcome_unknown);
        assert_eq!(recovered(&retained.task), 0);
        assert_eq!(
            fs::read(guest.base.join("runtime").join(STATE)).unwrap(),
            before
        );
        let mut changed = req.params.clone();
        changed["text"] = json!("Different input");
        assert!(guest
            .dispatch(Request {
                expected_runtime_sha256: None,
                expected_macos_account: None,
                method: req.method.clone(),
                params: changed
            })
            .unwrap_err()
            .to_string()
            .contains("different input"));
        let mut wrong = req.params.clone();
        wrong["target"]["workspaceId"] = json!(new_id());
        assert!(guest
            .dispatch(Request {
                expected_runtime_sha256: None,
                expected_macos_account: None,
                method: req.method,
                params: wrong
            })
            .is_err());
        assert!(crate::store::index::load().unwrap().is_empty());
    }

    #[test]
    fn confirmed_recovery_persists_exact_key_event_and_receipt_together_without_replay() {
        let (_home, mut guest, task) = setup();
        let (req, sender) = pending_recovery(&mut guest, task.clone());
        sender.send(Ok(())).unwrap();
        checkpoint(&guest).unwrap();
        let persisted = durable(&guest);
        let retained = &persisted.records[&task.target.task_id];
        assert_eq!(recovered(&retained.task), 1);
        assert!(!retained.operations[&format!("task.recover:{RECOVERY_KEY}")].sending);
        assert!(retained.operations[&format!("task.recover:{RECOVERY_KEY}")]
            .error
            .is_none());
        assert_eq!(retained.task.input, task.input);
        assert!(retained.prior_external_outcome_unknown);
        guest
            .dispatch(Request {
                expected_runtime_sha256: None,
                expected_macos_account: None,
                method: req.method.clone(),
                params: req.params.clone(),
            })
            .unwrap();
        let (base, manager, sink) = (
            guest.base.clone(),
            guest.manager.clone(),
            guest.sink.clone(),
        );
        drop(guest);
        let reopened = Guest::open(base, manager, sink).unwrap();
        let response: Task = serde_json::from_value(reopened.dispatch(req).unwrap()).unwrap();
        assert_eq!(response.status, TaskStatus::OutcomeUnknown); // Restart is not a boot proof.
        assert_eq!(recovered(&response), 1); // Retained delivery remains canonical.
        assert!(crate::store::index::load().unwrap().is_empty());
    }

    #[test]
    fn failed_recovery_receipt_is_durable_unknown_and_same_key_never_resends() {
        let (_home, mut guest, task) = setup();
        let (req, sender) = pending_recovery(&mut guest, task.clone());
        sender.send(Err("provider echo timed out".into())).unwrap();
        checkpoint(&guest).unwrap();
        let persisted = durable(&guest);
        let retained = &persisted.records[&task.target.task_id];
        assert_eq!(retained.task.status, TaskStatus::OutcomeUnknown);
        assert_eq!(recovered(&retained.task), 0);
        let operation = &retained.operations[&format!("task.recover:{RECOVERY_KEY}")];
        assert!(!operation.sending);
        assert!(operation.error.as_ref().unwrap().contains("echo timed out"));
        assert!(guest
            .dispatch(req)
            .unwrap_err()
            .to_string()
            .contains("echo timed out"));
        assert!(crate::store::index::load().unwrap().is_empty());
    }

    #[test]
    fn missing_recovery_writer_or_restart_receipt_never_becomes_success() {
        let (_home, mut guest, task) = setup();
        let (req, sender) = pending_recovery(&mut guest, task.clone());
        drop(sender);
        checkpoint(&guest).unwrap();
        assert_eq!(
            durable(&guest).records[&task.target.task_id].task.status,
            TaskStatus::OutcomeUnknown
        );
        assert_eq!(
            recovered(&durable(&guest).records[&task.target.task_id].task),
            0
        );
        assert!(guest
            .dispatch(Request {
                expected_runtime_sha256: None,
                expected_macos_account: None,
                method: req.method.clone(),
                params: req.params.clone()
            })
            .is_err());
        // A daemon loss after the marker, before any receipt, stays ambiguous.
        let (req, _sender) = pending_recovery(&mut guest, task.clone());
        let (base, manager, sink) = (
            guest.base.clone(),
            guest.manager.clone(),
            guest.sink.clone(),
        );
        drop(guest);
        let reopened = Guest::open(base, manager, sink).unwrap();
        assert!(reopened
            .dispatch(req)
            .unwrap_err()
            .to_string()
            .contains("was not replayed"));
        assert_eq!(
            recovered(&durable(&reopened).records[&task.target.task_id].task),
            0
        );
        assert!(crate::store::index::load().unwrap().is_empty());
    }

    #[test]
    fn disk_failure_caches_confirmation_without_exposing_success_then_commits_once() {
        let (_home, mut guest, task) = setup();
        let (_req, sender) = pending_recovery(&mut guest, task.clone());
        sender.send(Ok(())).unwrap();
        let dir = guest.base.join("runtime/local-vm-guest");
        let retained_dir = guest.base.join("runtime/retained-checkpoint");
        let original = fs::read(dir.join("state.json")).unwrap();
        fs::rename(&dir, &retained_dir).unwrap();
        fs::write(&dir, b"disk write unavailable").unwrap();
        assert!(checkpoint(&guest).is_err());
        assert_eq!(
            recovered(&guest.state.lock().unwrap().records[&task.target.task_id].task),
            0
        );
        assert!(
            guest.state.lock().unwrap().records[&task.target.task_id].operations
                [&format!("task.recover:{RECOVERY_KEY}")]
                .sending
        );
        assert_eq!(guest.recovery_receipts.lock().unwrap().len(), 1);
        assert_eq!(fs::read(retained_dir.join("state.json")).unwrap(), original);
        fs::remove_file(&dir).unwrap();
        fs::rename(&retained_dir, &dir).unwrap();
        checkpoint(&guest).unwrap();
        checkpoint(&guest).unwrap();
        assert_eq!(
            recovered(&durable(&guest).records[&task.target.task_id].task),
            1
        );
        assert!(guest.recovery_receipts.lock().unwrap().is_empty());
    }

    #[test]
    fn late_confirmation_after_unknown_state_does_not_emit_recovered() {
        let (_home, mut guest, task) = setup();
        let (_req, sender) = pending_recovery(&mut guest, task.clone());
        {
            let mut state = guest.state.lock().unwrap();
            unknown(
                state.records.get_mut(&task.target.task_id).unwrap(),
                "Worker stop could not be confirmed",
            );
            guest.save(&state).unwrap();
        }
        sender.send(Ok(())).unwrap();
        checkpoint(&guest).unwrap();
        assert_eq!(
            recovered(&durable(&guest).records[&task.target.task_id].task),
            0
        );
        assert_eq!(
            durable(&guest).records[&task.target.task_id].task.status,
            TaskStatus::OutcomeUnknown
        );
    }

    #[test]
    fn recovery_rejects_changed_effective_or_pending_settings_including_inherited() {
        let (_home, _guest, mut task) = setup();
        for inherited in [false, true] {
            task.input.model = if inherited {
                String::new()
            } else {
                "selected-model".into()
            };
            task.input.effort = if inherited { None } else { Some("high".into()) };
            let tab: crate::store::index::TabEntry = serde_json::from_value(json!({"id":new_id(),
                "harness":task.input.harness,"model":task.input.model,"effort":task.input.effort,
                "permissionMode":task.input.permission_mode,"created":now()}))
            .unwrap();
            resume_settings(&task, &tab).unwrap();
            for field in [
                "model",
                "effort",
                "permissionMode",
                "requestedModel",
                "requestedEffort",
                "requestedPermissionMode",
            ] {
                let mut altered = serde_json::to_value(&tab).unwrap();
                altered[field] = json!("changed");
                let altered = serde_json::from_value(altered).unwrap();
                assert!(
                    resume_settings(&task, &altered).is_err(),
                    "accepted changed {field}"
                );
            }
        }
    }

    #[test]
    fn manual_lease_survives_restart_blocks_queue_and_requires_explicit_durable_release() {
        let (_home, guest, task) = setup();
        seed(&guest, record(task.clone()));
        assert!(guest.takeover(&json!({"target":task.target})).is_err());
        let dir = guest.base.join("runtime/local-vm-guest");
        let saved = guest.base.join("runtime/before-takeover");
        fs::rename(&dir, &saved).unwrap();
        fs::write(&dir, b"blocked").unwrap();
        assert!(guest
            .takeover(&json!({"target":task.target,"confirm":true}))
            .is_err());
        assert!(guest.state.lock().unwrap().manual_lease.is_none());
        assert_eq!(
            guest.state.lock().unwrap().records[&task.target.task_id]
                .task
                .status,
            TaskStatus::Queued
        );
        fs::remove_file(&dir).unwrap();
        fs::rename(&saved, &dir).unwrap();
        let response = guest
            .takeover(&json!({"target":task.target,"confirm":true}))
            .unwrap();
        assert_eq!(response["ready"], true);
        assert_eq!(response["manualControl"], true);
        assert_eq!(response["task"]["status"], "canceled");
        assert_eq!(response["task"]["target"], json!(task.target));
        let mut queued = task.clone();
        queued.target.task_id = new_id();
        queued.target.workspace_id = new_id();
        queued.guest_cwd = guest
            .base
            .join("workspaces")
            .join(&queued.target.workspace_id)
            .to_str()
            .unwrap()
            .into();
        seed(&guest, record(queued.clone()));
        let (base, manager, sink) = (
            guest.base.clone(),
            guest.manager.clone(),
            guest.sink.clone(),
        );
        drop(guest);
        let reopened = Guest::open(base, manager, sink).unwrap();
        reopened.tick().unwrap();
        assert_eq!(
            durable(&reopened).records[&queued.target.task_id]
                .task
                .status,
            TaskStatus::Queued
        );
        assert!(!Path::new(&queued.guest_cwd).exists());
        let state = reopened
            .dispatch(request(&reopened, "desktop.state", json!({})))
            .unwrap();
        assert_eq!(state["manualControl"], true);
        let mut candidate = durable(&reopened);
        candidate
            .records
            .get_mut(&queued.target.task_id)
            .unwrap()
            .task
            .status = TaskStatus::Running;
        assert!(authorize_desktop(&candidate, &queued.target)
            .unwrap_err()
            .to_string()
            .contains("Manual desktop lease"));
        for method in ["task.recover", "task.followup", "task.permission"] {
            let params = json!({"target":task.target,"confirm":true,"text":"New instruction","idempotencyKey":"manual-block"});
            assert!(reopened
                .dispatch(request(&reopened, method, params))
                .unwrap_err()
                .to_string()
                .contains("Manual desktop lease"));
        }
        assert!(reopened.release_desktop(&json!({})).is_err());
        // Failed persistence never exposes a released lease in memory.
        let dir = reopened.base.join("runtime/local-vm-guest");
        let saved = reopened.base.join("runtime/retained-lease");
        fs::rename(&dir, &saved).unwrap();
        fs::write(&dir, b"blocked").unwrap();
        assert!(reopened.release_desktop(&json!({"confirm":true})).is_err());
        assert!(reopened.state.lock().unwrap().manual_lease.is_some());
        fs::remove_file(&dir).unwrap();
        fs::rename(&saved, &dir).unwrap();
        assert_eq!(
            reopened.release_desktop(&json!({"confirm":true})).unwrap()["manualControl"],
            false
        );
        assert!(durable(&reopened).manual_lease.is_none());
        assert_eq!(
            durable(&reopened).records[&task.target.task_id].task.status,
            TaskStatus::Canceled
        );
        assert!(crate::store::index::load().unwrap().is_empty());
    }

    #[test]
    fn unknown_worker_takeover_retains_pending_lease_until_boot_proof_and_cursor_catchup() {
        let (_home, mut guest, mut task) = setup();
        guest.boot_identity = Some(OLD_BOOT.into());
        task.status = TaskStatus::OutcomeUnknown;
        let mut retained = record(task.clone());
        retained.boot_identity = Some(OLD_BOOT.into());
        for number in 0..600 {
            event(&mut retained.task, json!({"number":number}));
        }
        seed(&guest, retained);
        let response = guest
            .takeover(&json!({"target":task.target,"confirm":true}))
            .unwrap();
        assert_eq!(response["ready"], false);
        assert_eq!(response["manualControl"], true);
        assert!(!durable(&guest).manual_lease.unwrap().ready);
        assert!(guest.release_desktop(&json!({"confirm":true})).is_err());
        let mut wrong = task.target.clone();
        wrong.workspace_id = new_id();
        assert!(guest
            .takeover(&json!({"target":wrong,"confirm":true}))
            .is_err());
        guest.boot_identity = Some(NEW_BOOT.into());
        assert_eq!(
            guest
                .takeover(&json!({"target":task.target,"confirm":true}))
                .unwrap()["ready"],
            false
        );
        let persisted = durable(&guest);
        let retained = &persisted.records[&task.target.task_id];
        assert!(retained.prior_external_outcome_unknown);
        assert_eq!(retained.task.status, TaskStatus::Canceled);
        let after = retained.task.last_event_seq;
        let response = guest
            .takeover(&json!({"target":task.target,"confirm":true,"after":after}))
            .unwrap();
        assert_eq!(response["ready"], true);
        assert_eq!(response["task"]["status"], "canceled");
        for after in [json!(-1), json!("0"), json!(after + 1)] {
            assert!(guest
                .takeover(&json!({"target":task.target,"confirm":true,"after":after}))
                .is_err());
        }
        assert!(crate::store::index::load().unwrap().is_empty());
    }

    #[test]
    fn artifact_mismatch_refuses_before_guest_dispatch_and_keeps_retained_state() {
        let (_home, guest, _task) = setup();
        let before = std::fs::read(guest.base.join("runtime").join(STATE)).unwrap();
        let mut call = request(&guest, "desktop.state", json!({}));
        call.expected_runtime_sha256 = Some("wrong-artifact".into());
        assert!(guest.dispatch(call).unwrap_err().to_string().contains("artifact changed"));
        assert_eq!(before, std::fs::read(guest.base.join("runtime").join(STATE)).unwrap());
        let mut call = request(&guest, "desktop.state", json!({}));
        call.expected_runtime_sha256 = Some(guest.runtime_sha256.clone());
        assert!(guest.dispatch(call).is_ok());
    }

    #[test]
    fn linux_recovery_requires_a_new_kernel_or_container_lifetime_not_runtime_restart() {
        let boot = new_id();
        let stat = |start: u64| format!("1 (init (fixture)) S {} {start} 0 0", "0 ".repeat(18));
        let before = linux_boot_identity(&boot, 4026533000, &stat(120)).unwrap();
        assert_eq!(before, linux_boot_identity(&boot, 4026533000, &stat(120)).unwrap());
        assert!(require_boot_change(Some(&before), Some(&before)).is_err());
        let after = linux_boot_identity(&boot, 4026533001, &stat(180)).unwrap();
        require_boot_change(Some(&before), Some(&after)).unwrap();
        assert_ne!(before, linux_boot_identity(&new_id(), 4026533000, &stat(120)).unwrap());
        assert!(linux_boot_identity(&boot, 4026533000, "1 (init) S malformed").is_none());
        assert!(linux_boot_identity("unknown", 4026533000, &stat(120)).is_none());
        assert!(linux_boot_identity(&boot, 0, &stat(120)).is_none());
        assert!(linux_boot_identity(&boot, 4026533000, &stat(0)).is_none());
    }

    #[test]
    fn guest_boot_identity_is_kernel_backed_and_stable_during_this_process() {
        #[cfg(target_os = "macos")]
        {
            let first = boot_identity().expect("macOS exposes kern.bootsessionuuid");
            validate_id(&first).unwrap();
            assert_eq!(Some(first), boot_identity());
        }
        #[cfg(target_os = "linux")]
        assert_eq!(boot_identity().unwrap(), boot_identity().unwrap());
        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        assert!(boot_identity().is_none());
    }

    #[test]
    fn missing_or_same_boot_cannot_prove_worker_exit() {
        let previous = new_id();
        let current = new_id();
        assert!(require_boot_change(None, Some(&current)).is_err());
        assert!(require_boot_change(Some(&previous), None).is_err());
        assert!(require_boot_change(Some(&previous), Some(&previous))
            .unwrap_err()
            .to_string()
            .contains("Restart the guest"));
        require_boot_change(Some(&previous), Some(&current)).unwrap();
        let (_home, _guest, task) = setup();
        let mut saved = serde_json::to_value(record(task)).unwrap();
        saved.as_object_mut().unwrap().remove("bootIdentity");
        saved
            .as_object_mut()
            .unwrap()
            .remove("priorExternalOutcomeUnknown");
        let legacy: Record = serde_json::from_value(saved).unwrap();
        assert!(legacy.boot_identity.is_none());
        assert!(require_boot_change(legacy.boot_identity.as_deref(), Some(&current)).is_err());
    }

    #[test]
    fn reboot_proof_cancels_untracked_worker_without_erasing_external_uncertainty() {
        let (_home, mut guest, task) = setup();
        let previous = new_id();
        guest.boot_identity = Some(previous.clone());
        let mut rec = record(task.clone());
        rec.boot_identity = Some(previous);
        unknown(&mut rec, "Original delivery was not acknowledged");
        seed(&guest, rec);
        let still_unknown: Task = serde_json::from_value(
            guest
                .dispatch(request(
                    &guest,
                    "task.cancel",
                    json!({"target":task.target}),
                ))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(still_unknown.status, TaskStatus::OutcomeUnknown);
        assert!(still_unknown.status.holds_desktop());
        guest.boot_identity = Some(new_id()); // Decision input only; no OS or VM restart.
        let canceled: Task = serde_json::from_value(
            guest
                .dispatch(request(
                    &guest,
                    "task.cancel",
                    json!({"target":task.target}),
                ))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(canceled.status, TaskStatus::Canceled);
        assert!(!canceled.status.holds_desktop());
        assert_eq!(canceled.input, task.input);
        assert!(canceled
            .detail
            .as_deref()
            .unwrap()
            .contains("external actions remain outcome unknown"));
        assert!(canceled
            .events
            .iter()
            .any(|event| event.payload["type"] == "outcomeUnknown"));
        assert!(canceled.events.iter().any(|event| event.payload["type"]
            == "workerStoppedAfterGuestReboot"
            && event.payload["externalOutcomeUnknown"] == true));
        assert!(crate::store::index::load().unwrap().is_empty());
        let saved: State =
            serde_json::from_slice(&fs::read(guest.base.join("runtime").join(STATE)).unwrap())
                .unwrap();
        assert_eq!(
            saved.records[&task.target.task_id].task.status,
            TaskStatus::Canceled
        );
    }

    fn recoverable_record(mut task: Task, previous: &str) -> Record {
        task.worker_session_id = Some(new_id());
        task.worker_tab_id = Some(new_id());
        task.provider_conversation_id = Some(new_id());
        let mut rec = record(task);
        rec.boot_identity = Some(previous.into());
        unknown(&mut rec, "Previous runtime lost the provider outcome");
        rec
    }

    #[test]
    fn recovery_requires_confirmation_boot_proof_resume_id_and_exclusive_lease() {
        let (_home, mut guest, task) = setup();
        let previous = new_id();
        guest.boot_identity = Some(previous.clone());
        seed(&guest, recoverable_record(task.clone(), &previous));
        let params = json!({"target":task.target,"text":"Only inspect what happened, then ask me","idempotencyKey":"recover-1","confirm":true});
        let mut unconfirmed = params.clone();
        unconfirmed["confirm"] = json!(false);
        assert!(guest
            .dispatch(request(&guest, "task.recover", unconfirmed))
            .unwrap_err()
            .to_string()
            .contains("confirm:true"));
        assert!(guest
            .dispatch(request(&guest, "task.recover", params.clone()))
            .unwrap_err()
            .to_string()
            .contains("Restart the guest"));
        guest.boot_identity = Some(new_id());
        let mut original = params.clone();
        original["text"] = json!(format!("  {}\n", task.input.prompt));
        assert!(guest
            .dispatch(request(&guest, "task.recover", original))
            .unwrap_err()
            .to_string()
            .contains("cannot be replayed"));
        let mut no_resume = recoverable_record(task.clone(), &previous);
        no_resume.task.provider_conversation_id = None;
        seed(&guest, no_resume);
        assert!(guest
            .dispatch(request(&guest, "task.recover", params.clone()))
            .unwrap_err()
            .to_string()
            .contains("resume ID"));
        seed(&guest, recoverable_record(task.clone(), &previous));
        let mut other = task.clone();
        other.target.task_id = new_id();
        other.target.workspace_id = new_id();
        seed(&guest, recoverable_record(other, &previous));
        assert!(guest
            .dispatch(request(&guest, "task.recover", params))
            .unwrap_err()
            .to_string()
            .contains("Another task"));
        assert!(guest.state.lock().unwrap().records[&task.target.task_id]
            .operations
            .is_empty());
        assert!(crate::store::index::load().unwrap().is_empty());
    }

    #[test]
    fn recovery_receipt_is_keyed_durable_idempotent_and_never_replays_original_input() {
        let (_home, mut guest, task) = setup();
        let previous = new_id();
        guest.boot_identity = Some(new_id());
        let key = "recover-key";
        let new_text = "Inspect existing evidence before attempting anything else";
        let params =
            json!({"target":task.target,"text":new_text,"idempotencyKey":key,"confirm":true});
        let req = request(&guest, "task.recover", params.clone());
        let operation_digest = digest(&serde_json::to_vec(&("task.recover", &req.params)).unwrap());
        let mut rec = recoverable_record(task.clone(), &previous);
        let original_target = rec.task.target.clone();
        let original_provider = rec.task.provider_conversation_id.clone();
        prepare_recovery(
            &mut rec,
            guest.boot_identity.as_deref(),
            key,
            &operation_digest,
            new_text,
        )
        .unwrap();
        assert_eq!(rec.task.input, task.input);
        assert_eq!(rec.task.target, original_target);
        assert_eq!(rec.task.provider_conversation_id, original_provider);
        assert_eq!(rec.task.status, TaskStatus::Starting);
        assert!(rec.operations["task.recover:recover-key"].sending);
        assert!(!rec
            .task
            .events
            .iter()
            .any(|event| event.payload["type"] == "taskRecovered"));
        assert!(rec
            .task
            .events
            .iter()
            .any(|event| event.payload["type"] == "taskRecoveryRequested"
                && event.payload["text"] == new_text));
        seed(&guest, rec);
        // A crash before an in-process receipt leaves a durable ambiguous
        // operation. Repeating its key must not instantiate any worker.
        assert!(guest
            .dispatch(req)
            .unwrap_err()
            .to_string()
            .contains("outcomeUnknown"));
        let (sender, receiver) = mpsc::channel();
        guest
            .recovery_receipts
            .lock()
            .unwrap()
            .push(RecoveryReceipt {
                target: task.target.clone(),
                idempotency_key: key.into(),
                operation_key: "task.recover:recover-key".into(),
                receiver,
                result: None,
            });
        let pending = guest
            .dispatch(request(&guest, "task.recover", params.clone()))
            .unwrap();
        assert_eq!(pending["status"], "starting");
        // This is a receipt/checkpoint seam test, not a simulated provider.
        // Actual send_confirmed execution remains a real-guest release gate.
        sender.send(Ok(())).unwrap();
        let path = guest.base.join("runtime").join(STATE);
        let backup = path.with_extension("saved-json");
        fs::rename(&path, &backup).unwrap();
        fs::create_dir(&path).unwrap();
        {
            let mut state = guest.state.lock().unwrap();
            assert!(guest.checkpoint_recovery_receipts(&mut state).is_err());
            assert!(!state.records[&task.target.task_id]
                .task
                .events
                .iter()
                .any(|event| event.payload["type"] == "taskRecovered"));
        }
        fs::remove_dir(&path).unwrap();
        fs::rename(backup, &path).unwrap();
        {
            let mut state = guest.state.lock().unwrap();
            guest.checkpoint_recovery_receipts(&mut state).unwrap();
        }
        let persisted: State = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert!(
            !persisted.records[&task.target.task_id].operations["task.recover:recover-key"].sending
        );
        let replay: Task = serde_json::from_value(
            guest
                .dispatch(request(&guest, "task.recover", params.clone()))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            replay
                .events
                .iter()
                .filter(|event| event.payload["type"] == "taskRecovered"
                    && event.payload["idempotencyKey"] == key)
                .count(),
            1
        );
        let mut changed = params;
        changed["text"] = json!("Different instructions");
        assert!(guest
            .dispatch(request(&guest, "task.recover", changed))
            .unwrap_err()
            .to_string()
            .contains("different input"));
        assert!(crate::store::index::load().unwrap().is_empty());
    }

    #[test]
    fn failed_recovery_receipt_never_emits_success_or_replays_text() {
        let (_home, mut guest, task) = setup();
        guest.boot_identity = Some(new_id());
        let previous = new_id();
        let params = json!({"target":task.target,"text":"New human instruction only","idempotencyKey":"uncertain","confirm":true});
        let req = request(&guest, "task.recover", params.clone());
        let operation_digest = digest(&serde_json::to_vec(&("task.recover", &req.params)).unwrap());
        let mut rec = recoverable_record(task.clone(), &previous);
        prepare_recovery(
            &mut rec,
            guest.boot_identity.as_deref(),
            "uncertain",
            &operation_digest,
            "New human instruction only",
        )
        .unwrap();
        seed(&guest, rec);
        let (sender, receiver) = mpsc::channel();
        guest
            .recovery_receipts
            .lock()
            .unwrap()
            .push(RecoveryReceipt {
                target: task.target.clone(),
                idempotency_key: "uncertain".into(),
                operation_key: "task.recover:uncertain".into(),
                receiver,
                result: None,
            });
        sender
            .send(Err("Provider delivery was not confirmed".into()))
            .unwrap();
        {
            let mut state = guest.state.lock().unwrap();
            guest.checkpoint_recovery_receipts(&mut state).unwrap();
            let task = &state.records[&task.target.task_id].task;
            assert_eq!(task.status, TaskStatus::OutcomeUnknown);
            assert!(!task
                .events
                .iter()
                .any(|event| event.payload["type"] == "taskRecovered"));
        }
        assert!(guest
            .dispatch(req)
            .unwrap_err()
            .to_string()
            .contains("outcomeUnknown"));
        assert!(crate::store::index::load().unwrap().is_empty());
    }

    #[test]
    fn lost_start_receipt_and_restart_never_create_a_second_worker_or_replay() {
        let (_home, guest, mut task) = setup();
        task.status = TaskStatus::Starting;
        let mut persisted = record(task.clone());
        persisted.operations.insert(
            "start".into(),
            Operation {
                digest: task.input_digest.clone(),
                sending: true,
                error: None,
            },
        );
        seed(&guest, persisted);
        let (base, manager, sink) = (
            guest.base.clone(),
            guest.manager.clone(),
            guest.sink.clone(),
        );
        drop(guest);
        let reopened = Guest::open(base, manager, sink).unwrap();
        let response = reopened
            .dispatch(request(
                &reopened,
                "task.start",
                json!({"task":task,"files":[]}),
            ))
            .unwrap();
        let existing: Task = serde_json::from_value(response).unwrap();
        assert_eq!(existing.target, task.target);
        assert_eq!(existing.status, TaskStatus::OutcomeUnknown);
        assert!(existing.worker_session_id.is_none());
        assert!(!Path::new(&task.guest_cwd).exists());
        assert!(crate::store::index::load().unwrap().is_empty());
        assert!(reopened.state.lock().unwrap().records[&task.target.task_id]
            .task
            .status
            .holds_desktop());
    }

    #[test]
    fn cancel_before_a_delayed_start_leaves_a_durable_tombstone() {
        let (_home, guest, task) = setup();
        let canceled = guest
            .dispatch(request(
                &guest,
                "task.cancel",
                json!({"target":task.target}),
            ))
            .unwrap();
        assert_eq!(canceled["absent"], true);
        let (base, manager, sink) = (
            guest.base.clone(),
            guest.manager.clone(),
            guest.sink.clone(),
        );
        drop(guest);
        let reopened = Guest::open(base, manager, sink).unwrap();
        let error = reopened
            .dispatch(request(
                &reopened,
                "task.start",
                json!({"task":task,"files":[]}),
            ))
            .unwrap_err();
        assert!(error.to_string().contains("canceled before start"));
        assert!(!Path::new(&task.guest_cwd).exists());
        assert!(crate::store::index::load().unwrap().is_empty());
    }

    #[test]
    fn wrong_generation_and_missing_history_fail_before_any_effect() {
        let (_home, guest, task) = setup();
        let mut stale = request(&guest, "task.cancel", json!({"target":task.target}));
        stale.params["generation"] = json!(new_id());
        assert!(guest
            .dispatch(stale)
            .unwrap_err()
            .to_string()
            .contains("mismatch"));
        assert!(guest.state.lock().unwrap().canceled_targets.is_empty());
        let missing = guest
            .dispatch(request(
                &guest,
                "task.poll",
                json!({"target":task.target,"after":0}),
            ))
            .unwrap_err();
        assert!(missing.to_string().contains("outcomeUnknown"));
        assert!(!Path::new(&task.guest_cwd).exists());
    }

    #[test]
    fn paged_events_cannot_settle_a_task_until_all_history_is_delivered() {
        let (_home, _guest, mut task) = setup();
        for i in 0..600 {
            event(&mut task, json!({"number":i}));
        }
        task.status = TaskStatus::Completed;
        task.outcome = Some("Retained result".into());
        let first = page(&task, 0).unwrap();
        assert_eq!(
            (first.last_event_seq, first.status),
            (256, TaskStatus::Running)
        );
        assert!(first.outcome.is_none());
        let second = page(&task, first.last_event_seq).unwrap();
        let last = page(&task, second.last_event_seq).unwrap();
        assert_eq!(
            (last.last_event_seq, last.status),
            (600, TaskStatus::Completed)
        );
        assert_eq!(last.outcome, task.outcome);
        assert!(page(&task, 601).is_err());
        task.events.remove(12);
        assert!(page(&task, 0).unwrap_err().to_string().contains("gap"));
    }

    #[test]
    fn selected_files_require_exact_content_manifest_and_safe_paths() {
        let (_home, guest, mut task) = setup();
        let bytes = b"selected context only";
        task.input.files = vec![InputFile {
            path: "src/input.txt".into(),
            sha256: digest(bytes),
            bytes: bytes.len() as u64,
        }];
        task.input_digest = digest(&serde_json::to_vec(&task.input).unwrap());
        let files = vec![FileInput {
            path: "src/input.txt".into(),
            content_base64: STANDARD.encode(bytes),
        }];
        let identity = guest.state.lock().unwrap().identity.clone();
        validate_task(&identity, &guest.base, &task, &files).unwrap();
        let mut altered = files.clone();
        altered[0].content_base64 = STANDARD.encode(b"changed");
        assert!(validate_task(&identity, &guest.base, &task, &altered).is_err());
        let mut unsafe_files = files;
        unsafe_files[0].path = "../host-file".into();
        assert!(validate_task(&identity, &guest.base, &task, &unsafe_files).is_err());
    }

    #[test]
    fn uncertain_followup_receipt_cannot_send_again() {
        let (_home, guest, mut task) = setup();
        task.status = TaskStatus::Running;
        let req = request(
            &guest,
            "task.followup",
            json!({"target":task.target,"text":"one follow-up","idempotencyKey":"follow-1"}),
        );
        let operation_digest =
            digest(&serde_json::to_vec(&(req.method.as_str(), &req.params)).unwrap());
        let mut rec = record(task.clone());
        rec.operations.insert(
            "task.followup:follow-1".into(),
            Operation {
                digest: operation_digest,
                sending: true,
                error: None,
            },
        );
        seed(&guest, rec);
        assert!(guest
            .dispatch(req)
            .unwrap_err()
            .to_string()
            .contains("outcomeUnknown"));
        assert!(crate::store::index::load().unwrap().is_empty());
    }

    #[test]
    fn inherited_model_uses_the_discovered_default_efforts_without_rewriting_input() {
        let (_home, _guest, mut task) = setup();
        task.input.model.clear();
        for (harness, capture) in [
            (
                "codex",
                include_str!("../harness/codex/fixtures/model_list.json"),
            ),
            (
                "claude",
                include_str!("../harness/claude/fixtures/initialize_models.json"),
            ),
        ] {
            let reply: Value = serde_json::from_str(capture).unwrap();
            let models = discovered_models(harness, &reply).unwrap();
            let inherited = models.iter().find(|model| model.id.is_empty()).unwrap();
            let resolved = models
                .iter()
                .find(|model| Some(model.id.as_str()) == inherited.resolved.as_deref())
                .unwrap();
            assert_eq!(inherited.efforts, resolved.efforts);
            task.input.harness = harness.into();
            task.input.effort = None;
            let inherited_input = task.input.clone();
            validate_model(&task, &models).unwrap();
            assert_eq!(task.input, inherited_input);
            task.input.effort = resolved.efforts.first().cloned();
            task.input_digest = digest(&serde_json::to_vec(&task.input).unwrap());
            let approved = task.input.clone();
            validate_model(&task, &models).unwrap();
            assert_eq!(task.input, approved);
            assert!(task.input.model.is_empty());
            task.input.effort = Some("not-a-provider-effort".into());
            assert!(validate_model(&task, &models).is_err());
        }
    }

    #[test]
    fn inherited_model_is_unavailable_without_explicit_provider_default_evidence() {
        let (_home, _guest, mut task) = setup();
        task.input.model.clear();
        let mut codex: Value =
            serde_json::from_str(include_str!("../harness/codex/fixtures/model_list.json"))
                .unwrap();
        for model in codex["data"].as_array_mut().unwrap() {
            model["isDefault"] = json!(false);
        }
        let models = discovered_models("codex", &codex).unwrap();
        assert!(!models.iter().any(|model| model.id.is_empty()));
        assert!(validate_model(&task, &models).is_err());
        let mut claude: Value = serde_json::from_str(include_str!(
            "../harness/claude/fixtures/initialize_models.json"
        ))
        .unwrap();
        claude
            .pointer_mut("/response/response/models")
            .unwrap()
            .as_array_mut()
            .unwrap()
            .retain(|entry| entry["value"] != "default");
        // The shared parser still guesses a preferred model; the guest does
        // not treat that as evidence that a default capability is available.
        assert!(crate::harness::claude::models::parse(&claude)
            .iter()
            .any(|model| model.is_default));
        let models = discovered_models("claude", &claude).unwrap();
        assert!(!models.iter().any(|model| model.id.is_empty()));
        assert!(validate_model(&task, &models).is_err());
        codex["data"].as_array_mut().unwrap().clear();
        assert!(discovered_models("codex", &codex).is_err());
        claude
            .pointer_mut("/response/response/models")
            .unwrap()
            .as_array_mut()
            .unwrap()
            .clear();
        assert!(discovered_models("claude", &claude).is_err());
    }

    #[test]
    fn missing_installed_identity_is_not_an_ordinary_host_runtime() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().join(".terminalx-local");
        assert!(!installation_present_at(&base).unwrap());
        private_directory(&base).unwrap();
        assert!(installation_present_at(&base).is_err());
        atomic_private_write(&base.join("identity.json"), b"{}").unwrap();
        assert!(installation_present_at(&base).unwrap());
        std::fs::remove_file(base.join("identity.json")).unwrap();
        assert!(installation_present_at(&base).is_err());
        let link = root.path().join("substitute");
        std::os::unix::fs::symlink(&base, &link).unwrap();
        assert!(installation_present_at(&link).is_err());
    }

    #[test]
    fn personalized_rpc_binding_and_provider_paths_refuse_legacy_or_changed_accounts() {
        let (_home, guest, task) = setup();
        let mut identity = guest.state.lock().unwrap().identity.clone();
        let account = super::super::macos_account::Account {
            short_name: "personal".into(), uid: 501, gid: 20,
            home: "/Users/personal".into(), home_device: 1, home_inode: 42,
        };
        let digest = "a".repeat(64);
        identity.check_account(None, None).unwrap();
        assert!(identity.check_account(Some(&account), Some(&digest)).is_err());
        // An account-bound request must not execute against an old default-
        // account guest, even when environment/generation happen to match.
        let mut rpc = request(&guest, "describe", json!({}));
        rpc.expected_macos_account = Some(account.clone());
        assert!(guest.dispatch(rpc).is_err());
        identity.macos_account = Some(account.clone());
        identity.check_account(Some(&account), Some(&digest)).unwrap();
        assert!(identity.check_account(None, Some(&digest)).is_err());
        assert!(identity.check_account(Some(&account), None).is_err());
        for (field, value) in [("uid", json!(502)), ("gid", json!(21)),
            ("shortName", json!("another")), ("home", json!("/Users/another")),
            ("homeDevice", json!(2)), ("homeInode", json!(43))] {
            let mut changed = json!(account); changed[field] = value;
            let changed = serde_json::from_value(changed).unwrap();
            assert!(identity.check_account(Some(&changed), Some(&digest)).is_err(), "{field}");
        }
        let config = task_launch_config(&identity, &task.target, "codex").unwrap();
        let table: toml::Table = toml::from_str(config.args.strip_prefix(" -c '").unwrap().strip_suffix('\'').unwrap()).unwrap();
        let server = &table["mcp_servers"]["guest_computer"];
        assert_eq!(server["command"].as_str(), Some("/Users/personal/.terminalx-local/bin/terminalx-serve"));
        assert_eq!(server["env"]["TERMINALX_HOME"].as_str(), Some("/Users/personal/.terminalx-local/runtime"));
        assert!(!config.args.contains("/Users/lume"));
        // The legacy durable identity retains its original serialized schema.
        let mut legacy = json!(identity);
        legacy.as_object_mut().unwrap().remove("macosAccount");
        let legacy: Identity = serde_json::from_value(legacy).unwrap();
        assert!(legacy.macos_account.is_none());
        assert!(serde_json::to_value(legacy).unwrap().get("macosAccount").is_none());
    }

    #[test]
    fn provider_mcp_configs_only_name_the_bound_guest_proxy() {
        let (_home, guest, task) = setup();
        let identity = guest.state.lock().unwrap().identity.clone();
        let claude = task_launch_config(&identity, &task.target, "claude").unwrap();
        assert!(claude.args.contains("--strict-mcp-config"));
        assert!(claude
            .args
            .contains("local-vm-computer\",\"--stdio\",\"--task"));
        let codex = task_launch_config(&identity, &task.target, "codex").unwrap();
        let toml = codex
            .args
            .strip_prefix(" -c '")
            .unwrap()
            .strip_suffix('\'')
            .unwrap();
        let value: toml::Table = toml::from_str(toml).unwrap();
        assert_eq!(value["mcp_servers"].as_table().unwrap().len(), 1);
        assert_eq!(
            value["mcp_servers"]["guest_computer"]["args"][0].as_str(),
            Some("local-vm-computer")
        );
        assert!(!codex
            .env
            .iter()
            .any(|(name, _)| name.contains("TOKEN") || name.contains("KEY")));
    }

    #[test]
    fn real_shell_pty_outputs_files_and_patch_are_retained_without_commits() {
        let (_home, guest, mut task) = setup();
        let cwd = PathBuf::from(&task.guest_cwd);
        fs::create_dir(&cwd).unwrap();
        fs::write(cwd.join("selected.txt"), b"before\n").unwrap();
        git(&cwd, &["init", "--quiet"], None).unwrap();
        git(&cwd, &["add", "--all", "--", "."], None).unwrap();
        let baseline = String::from_utf8(git(&cwd, &["write-tree"], None).unwrap())
            .unwrap()
            .trim()
            .to_owned();
        let entry = crate::session_ops::create_quick_chat_blocking(
            guest.sink.as_ref(),
            crate::session_ops::NewQuickChat {
                title: Some("Real PTY output retention".into()),
                cwd: Some(task.guest_cwd.clone()),
                tab: Some(crate::session_ops::NewTab {
                    harness: "codex".into(),
                    model: String::new(),
                    effort: None,
                    permission_mode: Some("bypassPermissions".into()),
                }),
            },
        )
        .unwrap();
        let tab = &entry.tabs[0].id;
        task.worker_session_id = Some(entry.id.clone());
        task.worker_tab_id = Some(tab.clone());
        task.status = TaskStatus::Completed;
        task.outcome = Some("PTY command finished".into());
        let pane = SessionManager::pane_id(tab);
        guest.manager.terminals().spawn(guest.sink.clone(),&pane,crate::pty::PaneSpec {
            cwd:cwd.to_str().unwrap(),cols:80,rows:24,env:&[],
            command:Some("/bin/sh -c 'echo after > selected.txt; echo generated > result.txt; echo guest-$((6*7))-pty'"),
        }).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let output = guest
                .manager
                .terminals()
                .read_output(&pane)
                .unwrap_or_default();
            if output
                .windows(b"guest-42-pty".len())
                .any(|w| w == b"guest-42-pty")
                && !guest.manager.terminals().is_running(&pane)
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "Real shell PTY did not finish"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        // A real shell, not a provider stand-in. This test verifies the
        // runtime/PTY, Git and retention paths; provider execution is a guest
        // release gate and requires installed, authenticated guest harnesses.
        fs::write(crate::store::log_path(&entry.id, tab).unwrap(), b"").unwrap();
        let mut rec = record(task.clone());
        rec.baseline = Some(baseline);
        guest.retain(&mut rec).unwrap();
        assert!(rec.task.artifacts.iter().any(|a| a.name == "result.txt"));
        let patch = rec
            .task
            .artifacts
            .iter()
            .find(|a| a.name == "changes.patch")
            .unwrap()
            .clone();
        validate_id(&patch.id).unwrap();
        seed(&guest, rec);
        let result = guest
            .dispatch(request(
                &guest,
                "task.artifact",
                json!({"target":task.target,"artifactId":patch.id}),
            ))
            .unwrap();
        let bytes = STANDARD
            .decode(result["contentBase64"].as_str().unwrap())
            .unwrap();
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("+after") && text.contains("+generated"));
        assert!(!Command::new("git")
            .current_dir(&cwd)
            .args(["rev-parse", "--verify", "HEAD"])
            .output()
            .unwrap()
            .status
            .success());
        let disposition = guest
            .dispatch(request(&guest, "environment.disposition", json!({})))
            .unwrap();
        assert!(disposition["tasks"][0]["gitPorcelain"]
            .as_str()
            .unwrap()
            .contains("result.txt"));
    }
}
