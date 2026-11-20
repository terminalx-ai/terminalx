//! The runtime registers with the relay as a Host, outbound only: the VM has
//! no inbound ports. Clients reach it through the relay's E2EE splice and
//! speak `terminalx-workspace-rpc/1` to [`WorkspaceRpc`].
//!
//! Where the relay session comes from is a [`RuntimeLink`]: the cloud
//! bootstrap (`/v1/cloud-workspace-bootstrap/redeem` + `/refresh`, PRO-42)
//! in a real workspace, or a JSON file for local development and the relay
//! integration test ([`FileLink`]).
//!
//! Per attachment the API hands over (device id, device token, scope), the
//! host creates a single-use relay invite and publishes a pairing code back
//! through the link. A client connecting with that invite must then prove
//! the device token inside the E2EE channel, and may install a resume
//! credential (`pairing.provisionRelay`, as the phone does) to reconnect.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig, Message};

use super::protocol::{self, Authority};
use super::server::{Peer, WorkspaceRpc, MAX_FRAME_BYTES};
use crate::relay_e2ee::{answer_relay_challenge, begin_e2ee_session, E2eeHello, E2eeSession, HostKeypair, PayloadKind, RelayProofContext};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const SILENCE_TIMEOUT: Duration = Duration::from_secs(90);
const REFRESH_INTERVAL: Duration = Duration::from_secs(15);
/// How often pending attachments, revocations and shares are read from the
/// link: a device waiting for its pairing code waits at most this long plus
/// the bootstrap's refresh interval, and access changes apply this promptly
/// (contract §21.5).
const SESSION_POLL_INTERVAL: Duration = Duration::from_secs(5);
// Worktree scans share a small process-wide budget across direct and relay peers.
static BRANCH_DIFF_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);
// Commit history has separate slots, so a slow diff cannot hold up Create PR.
static BRANCH_BASE_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

fn try_branch_read_slot(slots: &tokio::sync::Semaphore, pending: bool) -> Option<tokio::sync::SemaphorePermit<'_>> {
    if pending { return None; }
    slots.try_acquire().ok()
}
/// Answered from their own task (see `serve_connection`).
const SLOW_METHODS: &[&str] = &[
    "environment.report",
    "git.push",
    "git.pushHead",
    "git.pull",
    "git.fetch",
    "git.commit",
    "git.commitForPush",
    "git.checkout",
    "git.repositories",
    "git.status",
    "git.branchBase",
    "git.branchDiffSize",
    "git.workingChanges",
    "git.reviewRange",
    "git.changesBetween",
    "git.fileContents",
    "git.mediaContent",
    "git.log",
    "git.branches",
    "git.prs",
    "git.prConversation",
    "git.prReviewerSearch",
    "git.prConversationAction",
    "git.prAssociations",
    "git.prLanded",
    "git.prCreate",
    "git.prCreateForSession",
    "git.prReconcileCreation",
    "git.prLinkBranch",
    "git.prUnlink",
    "git.prReady",
    "git.prMerge",
    "lifecycle.dispositionFacts",
    "session.create",
    "session.send",
    "session.close",
    // A step of an issue's pipeline pushes and asks GitHub, or starts a review.
    "pipeline.act",
    "pipeline.resolveConflicts",
    "pipeline.noteMerge",
    // Starts the tab's CLI to ask it for its commands, which takes seconds on
    // a machine that just woke and 15 s when the CLI never answers. In order
    // it held up everything the connection asked next: the transcript, and
    // the agent's terminal, whose keys the desktop drops until it is attached (#449).
    "session.commands",
    // The composer's `#` list asks GitHub with the runtime's `gh` (#1329).
    "session.prs",
    "session.prContext",
    // CS-12: removing a worktree, and the first read of Codex's model list.
    "session.delete",
    // Fetches, asks GitHub for the branch's pull request, removes a worktree.
    "workspace.disposition",
    "workspace.remove",
    "runtime.agents",
    "fs.search",
    // Lists every file of every repository.
    "mirror.manifest",
    // Asks the relay for an invite (PRO-345).
    "machine.relayAccess",
];

/// One pending attachment, as `/v1/cloud-workspace-bootstrap/refresh` lists it.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub device_id: String,
    pub device_token: String,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub organization_id: Option<String>,
    /// `runtime` (manage) or `session` (participate).
    pub scope: String,
    pub expires_at: i64,
    /// The same for every attachment minted for this person's client
    /// installation; sent by an API that knows `attachment-installation-v1`.
    #[serde(default)]
    pub installation_key: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Revocation {
    pub id: String,
    pub device_id: String,
}

/// What the runtime needs from the API to register and admit clients.
#[derive(Clone)]
pub struct RelaySession {
    pub relay_token: String,
    pub director_url: String,
    pub attachments: Vec<Attachment>,
    pub revocations: Vec<Revocation>,
    /// Who the workspace is shared with and how (contract §21.3); absent
    /// from an API before PRO-30.
    pub collaboration: Option<Value>,
    /// Native request context, never read from the server response or a link file.
    pub(crate) collaboration_v2: bool,
}

/// The runtime's identity and API session. Calls may block; the host runs
/// them on the blocking pool.
pub trait RuntimeLink: Send + Sync + 'static {
    /// The relay host key the API bound this runtime to.
    fn host_secret(&self) -> [u8; 32];
    /// The current relay session with pending attachments and revocations.
    fn session(&self) -> Result<RelaySession>;
    /// Publish the pairing code for an attachment
    /// (`/v1/cloud-workspace-bootstrap/attachments/:id/complete`).
    fn complete_attachment(&self, attachment_id: &str, pairing_code: &str) -> Result<()>;
    /// Confirm a revocation was applied
    /// (`/v1/cloud-workspace-bootstrap/revocations/:id/complete`).
    fn complete_revocation(&self, attachment_id: &str) -> Result<()>;
    /// The relay retired `runtime_generation` for a newer one (4101). A link
    /// that keeps its token until it nears expiry asks the API again now, so
    /// it learns whether it was superseded (PRO-368).
    fn fenced(&self, _runtime_generation: u64) {}
}

/// A link read from a JSON file, for local development and tests. It is
/// re-read on every refresh, so a harness can add attachments or rotate the
/// relay token while the runtime runs. Pairing codes are written next to it
/// as `<file>.attachments/<attachment id>.pairing`, and completed
/// revocations as `<file>.attachments/<attachment id>.revoked`.
pub struct FileLink {
    path: PathBuf,
    secret: [u8; 32],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileLinkContents {
    v: u8,
    host_secret_b64: String,
    relay_token: String,
    director_url: String,
    #[serde(default)]
    attachments: Vec<Attachment>,
    #[serde(default)]
    revocations: Vec<Revocation>,
    #[serde(default)]
    collaboration: Option<Value>,
}

impl FileLink {
    pub fn open(path: &Path) -> Result<Self> {
        let contents = Self::read(path)?;
        let secret: [u8; 32] = general_purpose::STANDARD
            .decode(&contents.host_secret_b64)
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or_else(|| anyhow!("hostSecretB64 must be 32 bytes of base64"))?;
        Ok(Self { path: path.to_path_buf(), secret })
    }

    fn read(path: &Path) -> Result<FileLinkContents> {
        let contents: FileLinkContents =
            serde_json::from_slice(&std::fs::read(path).with_context(|| format!("read {}", path.display()))?)
                .with_context(|| format!("parse {}", path.display()))?;
        if contents.v != 1 {
            bail!("unsupported relay link version {}", contents.v);
        }
        Ok(contents)
    }

    pub fn pairing_dir(path: &Path) -> PathBuf {
        let mut name = path.file_name().unwrap_or_default().to_os_string();
        name.push(".attachments");
        path.with_file_name(name)
    }
}

impl RuntimeLink for FileLink {
    fn host_secret(&self) -> [u8; 32] {
        self.secret
    }

    fn session(&self) -> Result<RelaySession> {
        let contents = Self::read(&self.path)?;
        Ok(RelaySession {
            relay_token: contents.relay_token,
            director_url: contents.director_url,
            attachments: contents.attachments,
            revocations: contents.revocations,
            collaboration: contents.collaboration,
            collaboration_v2: false,
        })
    }

    fn complete_attachment(&self, attachment_id: &str, pairing_code: &str) -> Result<()> {
        self.write_beside(attachment_id, "pairing", pairing_code)
    }

    fn complete_revocation(&self, attachment_id: &str) -> Result<()> {
        self.write_beside(attachment_id, "revoked", "")
    }
}

impl FileLink {
    fn write_beside(&self, attachment_id: &str, extension: &str, contents: &str) -> Result<()> {
        if !attachment_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')) {
            bail!("invalid attachment id");
        }
        let dir = Self::pairing_dir(&self.path);
        std::fs::create_dir_all(&dir)?;
        let target = dir.join(format!("{attachment_id}.{extension}"));
        let temporary = dir.join(format!(".{attachment_id}.{extension}.new"));
        std::fs::write(&temporary, contents)?;
        std::fs::rename(temporary, target)?;
        Ok(())
    }
}

/// An answered attachment: its id and the device it was minted for.
fn completion_key(attachment_id: &str, device_id: &str) -> String {
    format!("{attachment_id}\u{0}{device_id}")
}

/// The relay host id the API derives from a host key (`deriveRelayHostId`).
pub fn relay_host_id_for_secret(secret: [u8; 32]) -> String {
    HostKeypair::from_secret(secret).host_id()
}

/// Claims of the API-signed runtime Relay Token the host proof binds to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenIdentity {
    pub user_id: String,
    pub profile_id: String,
    pub organization_id: String,
    pub runtime_generation: u64,
}

/// Read (not verify: the relay does) the identity claims of a Relay Token.
pub fn token_identity(token: &str) -> Result<TokenIdentity> {
    let payload = token.split('.').nth(1).ok_or_else(|| anyhow!("relay token is not a JWT"))?;
    let claims: Value = serde_json::from_slice(&general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('='))?)?;
    let text = |name: &str| claims.get(name).and_then(Value::as_str).map(str::to_string).ok_or_else(|| anyhow!("relay token lacks {name}"));
    Ok(TokenIdentity {
        user_id: text("sub")?,
        profile_id: text("cloudProfileId")?,
        organization_id: text("organizationId")?,
        runtime_generation: claims.get("runtimeGeneration").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// A device the API attached, admitted by its device token. Persisted (hash
/// only) so a client holding a resume credential can reconnect after the
/// runtime process restarts within the same generation.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Device {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    collaboration: Option<super::collab::v2::Stamp>,
    #[serde(with = "hash_b64")]
    token_hash: [u8; 32],
    authority: Authority,
    attachment_id: String,
    /// The attachment's person, for roles, presence and attribution.
    #[serde(default)]
    user_id: Option<String>,
    /// The person's installation, as the API keys it; absent on a device
    /// saved before the API sent one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    installation_key: Option<String>,
}

mod hash_b64 {
    use base64::{engine::general_purpose, Engine as _};
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(hash: &[u8; 32], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&general_purpose::STANDARD.encode(hash))
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<[u8; 32], D::Error> {
        let text = String::deserialize(deserializer)?;
        general_purpose::STANDARD
            .decode(text)
            .ok()
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or_else(|| serde::de::Error::custom("invalid token hash"))
    }
}

#[derive(Default)]
struct HostState {
    devices: HashMap<String, Device>,
    /// Attachments already answered with a pairing code in this process.
    /// Keyed by attachment id and device: the API re-mints an attachment
    /// (a refreshed pairing, a reopened session) under the same id with a new
    /// device, and that one must be answered too.
    completed: HashSet<String>,
    /// Revocations confirmed to the API in this process. The session read
    /// right after a confirmation may still list them.
    confirmed: HashSet<String>,
    /// A revocation removed a device but the list could not be written.
    devices_unsaved: bool,
    /// Open client connections per device, closed on revocation.
    connections: HashMap<String, Vec<mpsc::UnboundedSender<()>>>,
}

enum ControlCommand {
    CreateInvite { device_id: String, respond: oneshot::Sender<Result<(String, i64)>> },
    /// A control request the window makes through this registration
    /// (PRO-368): sent as it is, answered with the relay's reply to its `reqId`.
    Forward { frame: Value, req_id: String, respond: std::sync::mpsc::Sender<Result<Value>> },
    Revoke { device_id: String },
    InstallCredential { payload: Value, req_id: String, respond: oneshot::Sender<Result<Value>> },
    /// The runtime credential was revoked: stop serving.
    Shutdown,
    /// A newer runtime generation was issued: register again with it.
    Reregister,
}

#[derive(Clone)]
struct Live {
    commands: mpsc::UnboundedSender<ControlCommand>,
    cell_url: String,
    assignment_epoch: u64,
    relay_generation: u64,
}

/// The status `terminalx-serve` reports on stdout and to tests.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "state")]
pub enum HostStatus {
    Connecting,
    Registered { relay_host_id: String, runtime_generation: u64 },
    /// The relay retired this runtime for a newer generation (4101). It
    /// stays down until the link reports a newer generation.
    Fenced { runtime_generation: u64 },
    /// The API rejects the runtime credential; nothing is served until it
    /// accepts one again.
    Revoked,
    Retrying { attempt: u32 },
}

pub struct RelayHost {
    link: Arc<dyn RuntimeLink>,
    rpc: Arc<WorkspaceRpc>,
    keypair: HostKeypair,
    state: Mutex<HostState>,
    status: tokio::sync::watch::Sender<HostStatus>,
    devices_path: Option<PathBuf>,
    /// A machine's paired computers and phones (PRO-341).
    routes: Mutex<Option<Arc<dyn MachineRoutes>>>,
    /// The live registration and the director it came from, while registered.
    registered: Mutex<Option<(Live, String)>>,
    /// Set by [`RelayHost::stop`]: the host registers no more.
    stopped: std::sync::atomic::AtomicBool,
    stop: tokio::sync::Notify,
    /// Told when the relay hints that this host's account pairing changed.
    pairing_hint: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

/// The control requests the window may make through a machine's
/// registration (PRO-368): phone invites, credential installs and
/// revocations, as it makes them on its own registration (`pairing::relay`).
const FORWARDED_REQUESTS: &[&str] = &["invite-create", "device-revoke", "device-credential-install", "device-credential-install-status", "device-resume-confirm"];

/// How long a forwarded request waits for the relay's reply. The window's
/// caller gives up after 15 s (`RELAY_CONTROL_WAIT` in machine_host.rs); a
/// later reply has nobody to go to.
const FORWARDED_TTL: Duration = Duration::from_secs(20);

/// Requests the window made through this registration, by `reqId`.
type Forwarded = HashMap<String, (std::sync::mpsc::Sender<Result<Value>>, Instant)>;

/// Forget forwarded requests the relay has not answered in [`FORWARDED_TTL`].
fn forget_unanswered(forwarded: &mut Forwarded, now: Instant) {
    forwarded.retain(|_, (_, sent)| now.saturating_duration_since(*sent) < FORWARDED_TTL);
}

/// The relay's replies to them, each naming the request's `reqId`.
const FORWARDED_REPLIES: &[&str] = &["invite-created", "device-revoked", "device-credential-installed", "device-credential-install-status-result", "device-resume-confirmed", "control-error"];

#[cfg(test)]
pub(crate) struct PhoneTestControl(mpsc::UnboundedReceiver<ControlCommand>);

#[cfg(test)]
impl PhoneTestControl {
    pub(crate) fn take(&mut self) -> Option<(Value, std::sync::mpsc::Sender<Result<Value>>)> {
        match self.0.try_recv().ok()? {
            ControlCommand::Forward { frame, respond, .. } => Some((frame, respond)),
            _ => panic!("expected a forwarded phone control request"),
        }
    }
}

/// A live registration, as the window needs it to use it (PRO-368).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Registration {
    pub relay_host_id: String,
    pub director_url: String,
    pub cell_url: String,
    pub assignment_epoch: u64,
    /// The relay's generation for this registration (`host-hello-ack`).
    pub generation: u64,
    pub runtime_generation: u64,
}

/// A single-use relay invite for one device of this host, with where to use
/// it (`machine.relayAccess`, docs/MACHINES.md "As built (PRO-345)").
#[derive(Clone, Debug)]
pub struct RelayInvite {
    pub director_url: String,
    pub cell_url: String,
    pub assignment_epoch: u64,
    pub relay_host_id: String,
    pub invite_token: String,
    pub invite_expires_at: i64,
}

/// What a machine adds to its relay host (docs/MACHINES.md, "How PRO-341
/// builds it"): the computers it paired are admitted by their relay device id
/// and token. Other devices go to the phone host: the window while its
/// route is current, otherwise the runtime's authenticated phone service.
/// The machine refused a paired computer's device token or key on the relay.
/// The `pairing_refused` reason: `code-inactive` (a token it does not know,
/// a revoked or expired one) or `disconnected` (held off by the person, PRO-357).
#[derive(Debug)]
struct ComputerRefused(&'static str);

impl std::fmt::Display for ComputerRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "device token refused ({})", self.0)
    }
}

impl std::error::Error for ComputerRefused {}

/// Each method may read the registry file, so the relay host calls them off
/// its async tasks.
pub trait MachineRoutes: Send + Sync + 'static {
    /// Whether the relay device id is a paired computer's.
    fn is_computer(&self, relay_device_id: &str) -> bool;
    /// The paired computer with this relay device id, if `token` is its: its
    /// id and its tracked connection, which `cancel` closes on revocation.
    /// `client_key_b64` is the connection's E2EE client key: a computer is
    /// admitted only with the key it paired with (docs/MACHINES.md rule 2).
    /// `Ok(Err(reason))`: refused, with the `pairing_refused` reason.
    fn admit_computer(&self, relay_device_id: &str, token: &str, client_key_b64: &str, cancel: mpsc::UnboundedSender<()>) -> Result<Result<(String, u64), &'static str>>;
    /// The connection ended.
    fn release_computer(&self, computer_id: &str, tracked: u64);
    /// Route a phone to the window or runtime. `cancel` fences the complete
    /// runtime connection when the relay registration retires, including admission.
    fn forward_phone(&self, forwarded: crate::machine_wire::Forwarded, cancel: mpsc::UnboundedReceiver<()>) -> bool;
}

impl RelayHost {
    /// `devices_path` keeps attached devices across restarts; the runtime
    /// passes a file in its data directory.
    pub fn new(link: Arc<dyn RuntimeLink>, rpc: Arc<WorkspaceRpc>, devices_path: Option<PathBuf>) -> Arc<Self> {
        let keypair = HostKeypair::from_secret(link.host_secret());
        let (status, _) = tokio::sync::watch::channel(HostStatus::Connecting);
        let mut state = HostState::default();
        if let Some(path) = &devices_path {
            match std::fs::read(path) {
                Ok(bytes) => match serde_json::from_slice::<HashMap<String, Device>>(&bytes) {
                    Ok(devices) => state.devices = devices,
                    Err(error) => log::warn!("relay host: ignoring unreadable device list: {error}"),
                },
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => log::warn!("relay host: could not read the device list: {error}"),
            }
        }
        Arc::new(Self {
            link,
            rpc,
            keypair,
            state: Mutex::new(state),
            status,
            devices_path,
            routes: Mutex::new(None),
            registered: Mutex::new(None),
            stopped: std::sync::atomic::AtomicBool::new(false),
            stop: tokio::sync::Notify::new(),
            pairing_hint: Mutex::new(None),
        })
    }

    /// Whether the device list is on disk (or there is no disk to keep it on).
    fn save_devices(&self, devices: &HashMap<String, Device>) -> bool {
        let Some(path) = &self.devices_path else { return true };
        let write = || -> Result<()> {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let temporary = path.with_extension("new");
            std::fs::write(&temporary, serde_json::to_vec(devices)?)?;
            #[cfg(unix)]
            std::fs::set_permissions(&temporary, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
            std::fs::rename(&temporary, path)?;
            Ok(())
        };
        match write() {
            Ok(()) => true,
            Err(error) => {
                log::warn!("relay host: could not save the device list: {error:#}");
                false
            }
        }
    }

    pub fn relay_host_id(&self) -> String {
        self.keypair.host_id()
    }

    /// What this host serves. A machine's other routes (its direct listener)
    /// serve the same one, so every route sees one set of terminals,
    /// subscriptions and idempotency results.
    pub fn rpc(&self) -> Arc<WorkspaceRpc> {
        self.rpc.clone()
    }

    pub fn status(&self) -> tokio::sync::watch::Receiver<HostStatus> {
        self.status.subscribe()
    }

    /// A machine's computers and phones, beside the link's attachments.
    pub fn set_routes(&self, routes: Arc<dyn MachineRoutes>) {
        *self.routes.lock().unwrap() = Some(routes);
    }

    fn routes(&self) -> Option<Arc<dyn MachineRoutes>> {
        self.routes.lock().unwrap().clone()
    }

    #[cfg(test)]
    pub(crate) fn phone_test_registration(rpc: Arc<WorkspaceRpc>, cell_url: String, secret: [u8; 32]) -> (Arc<Self>, mpsc::UnboundedReceiver<Value>) {
        struct Link([u8; 32]);
        impl RuntimeLink for Link {
            fn host_secret(&self) -> [u8; 32] { self.0 }
            fn session(&self) -> Result<RelaySession> { bail!("test registration") }
            fn complete_attachment(&self, _: &str, _: &str) -> Result<()> { Ok(()) }
            fn complete_revocation(&self, _: &str) -> Result<()> { Ok(()) }
        }
        let host = Self::new(Arc::new(Link(secret)), rpc, None);
        let (commands, mut receive) = mpsc::unbounded_channel();
        let (sent, observed) = mpsc::unbounded_channel();
        *host.registered.lock().unwrap() = Some((Live { commands, cell_url, assignment_epoch: 2, relay_generation: 37 }, "http://127.0.0.1:1".into()));
        host.status.send_replace(HostStatus::Registered { relay_host_id: host.keypair.host_id(), runtime_generation: 11 });
        tokio::spawn(async move {
            while let Some(command) = receive.recv().await {
                match command {
                    ControlCommand::Forward { frame, req_id, respond } => {
                        sent.send(frame.clone()).unwrap();
                        if frame["type"] == "invite-create" {
                            let _ = respond.send(Ok(json!({
                                "type": "invite-created", "reqId": req_id,
                                "inviteToken": crate::relay_e2ee::random_token(),
                                "expiresAt": chrono::Utc::now().timestamp_millis() + 60_000,
                            })));
                            continue;
                        }
                        let kind = match frame["type"].as_str().unwrap() {
                            "device-credential-install" => "device-credential-installed",
                            "device-credential-install-status" => "device-credential-install-status-result",
                            "device-resume-confirm" => "device-resume-confirmed",
                            _ => "device-revoked",
                        };
                        let _ = respond.send(Ok(json!({"type":kind, "v":1, "reqId":req_id, "currentVersion":1})));
                    }
                    ControlCommand::Revoke { device_id } => { let _ = sent.send(json!({"type":"device-revoke", "relayDeviceId":device_id})); }
                    ControlCommand::Shutdown => break,
                    _ => {}
                }
            }
        });
        (host, observed)
    }

    #[cfg(test)]
    pub(crate) fn phone_test_hold_control(&self) -> PhoneTestControl {
        let (commands, receive) = mpsc::unbounded_channel();
        let mut registered = self.registered.lock().unwrap();
        let live = &mut registered.as_mut().unwrap().0;
        live.commands = commands;
        live.relay_generation += 1;
        PhoneTestControl(receive)
    }

    #[cfg(test)]
    pub(crate) fn phone_test_forward(&self, connection: crate::machine_wire::RelayConnection) {
        let live = self.registered.lock().unwrap().as_ref().unwrap().0.clone();
        let open = ConnectionOpen { conn_id:connection.conn_id, conn_ticket:connection.conn_ticket, kind:connection.kind, relay_device_id:connection.relay_device_id, attach_deadline_ms:connection.attach_deadline_ms };
        self.forward_phone(&self.routes().unwrap(), &live, &open);
    }

    #[cfg(test)]
    pub(crate) fn phone_test_retire(&self) {
        *self.registered.lock().unwrap() = None;
        self.close_all_connections();
    }

    /// Whether the relay registration is live now.
    pub fn is_registered(&self) -> bool {
        self.registered.lock().unwrap().is_some()
    }

    /// The live registration, while there is one.
    pub fn registration(&self) -> Option<Registration> {
        if self.is_stopped() { return None; }
        let (live, director_url) = self.registered.lock().unwrap().clone()?;
        let runtime_generation = match &*self.status.borrow() {
            HostStatus::Registered { runtime_generation, .. } => *runtime_generation,
            _ => return None,
        };
        Some(Registration {
            relay_host_id: self.keypair.host_id(),
            director_url,
            cell_url: live.cell_url,
            assignment_epoch: live.assignment_epoch,
            generation: live.relay_generation,
            runtime_generation,
        })
    }

    /// Call `hint` whenever the relay says this host's account pairing
    /// grants or revocations changed (`account-pairing-changed`).
    pub fn on_pairing_hint(&self, hint: Arc<dyn Fn() + Send + Sync>) {
        *self.pairing_hint.lock().unwrap() = Some(hint);
    }

    /// End the registration and every connection it carries, and register
    /// no more (the switch went off, the machine signed out, PRO-368). The
    /// control socket is closed with a close frame, so the relay lets the
    /// window register again at once.
    pub fn stop(&self) {
        self.stopped.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some((live, _)) = self.registered.lock().unwrap().as_ref() {
            let _ = live.commands.send(ControlCommand::Shutdown);
        }
        self.stop.notify_one();
        self.close_all_connections();
    }

    fn is_stopped(&self) -> bool {
        self.stopped.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Wait `delay`, or less when the host is stopped meanwhile.
    async fn pause(&self, delay: Duration) {
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = self.stop.notified() => self.stop.notify_one(),
        }
    }

    /// Send a control request the window makes (PRO-368) on this
    /// registration. The receiver yields the relay's reply to its `reqId`
    /// (or `control-error`); dropped unanswered when the registration ends.
    pub fn forward_control(&self, frame: Value) -> Result<std::sync::mpsc::Receiver<Result<Value>>> {
        let kind = frame["type"].as_str().unwrap_or_default();
        if !FORWARDED_REQUESTS.contains(&kind) {
            bail!("the relay request {kind:?} cannot be forwarded");
        }
        let req_id = frame["reqId"].as_str().filter(|id| valid_opaque_id(id)).ok_or_else(|| anyhow!("reqId is required"))?.to_string();
        let Some((live, _)) = self.registered.lock().unwrap().clone() else { bail!("relay control is offline") };
        let (respond, receive) = std::sync::mpsc::channel();
        live.commands.send(ControlCommand::Forward { frame, req_id, respond }).map_err(|_| anyhow!("relay control is offline"))?;
        Ok(receive)
    }

    /// A fresh single-use invite for `relay_device_id`, through the live
    /// registration's `invite-create`. `None` while not registered.
    pub async fn invite(&self, relay_device_id: &str) -> Result<Option<RelayInvite>> {
        let Some((live, director_url)) = self.registered.lock().unwrap().clone() else { return Ok(None) };
        if !valid_opaque_id(relay_device_id) {
            bail!("invalid relay device id");
        }
        let (respond, receive) = oneshot::channel();
        live.commands
            .send(ControlCommand::CreateInvite { device_id: relay_device_id.to_string(), respond })
            .map_err(|_| anyhow!("relay control is offline"))?;
        let (invite_token, invite_expires_at) = tokio::time::timeout(CONNECT_TIMEOUT, receive).await??.context("create invite")?;
        Ok(Some(RelayInvite {
            director_url,
            cell_url: live.cell_url.clone(),
            assignment_epoch: live.assignment_epoch,
            relay_host_id: self.keypair.host_id(),
            invite_token,
            invite_expires_at,
        }))
    }

    /// End a device's relay credentials (`device-revoke`) and close its
    /// relay connections. Phone cleanup uses `forward_control` instead to
    /// retain its revocation until the relay acknowledges it.
    pub fn revoke_device(&self, relay_device_id: &str) {
        if let Some((live, _)) = self.registered.lock().unwrap().as_ref() {
            let _ = live.commands.send(ControlCommand::Revoke { device_id: relay_device_id.to_string() });
        }
        self.close_device_connections(relay_device_id);
    }

    pub(crate) fn close_device_connections(&self, relay_device_id: &str) {
        for cancel in self.state.lock().unwrap().connections.remove(relay_device_id).unwrap_or_default() {
            let _ = cancel.send(());
        }
    }

    /// Register, serve and re-register forever. Only a 4101 fence stops it,
    /// until the link hands over a newer generation.
    pub async fn run(self: Arc<Self>) {
        let mut attempt = 0u32;
        let mut fenced: Option<u64> = None;
        loop {
            if self.is_stopped() {
                return;
            }
            let session = match self.fetch_session().await {
                Ok(session) => session,
                Err(error) if error.downcast_ref::<Revoked>().is_some() => {
                    self.revoked().await;
                    continue;
                }
                Err(error) => {
                    log::warn!("relay host: runtime session unavailable: {error:#}");
                    attempt += 1;
                    self.status.send_replace(HostStatus::Retrying { attempt });
                    self.pause(protocol::backoff(attempt, jitter())).await;
                    continue;
                }
            };
            let identity = match token_identity(&session.relay_token) {
                Ok(identity) => identity,
                Err(error) => {
                    log::error!("relay host: {error:#}");
                    self.pause(REFRESH_INTERVAL).await;
                    continue;
                }
            };
            if fenced.is_some_and(|generation| identity.runtime_generation <= generation) {
                self.pause(REFRESH_INTERVAL).await;
                continue;
            }
            if self.is_stopped() {
                return;
            }
            fenced = None;
            self.status.send_replace(HostStatus::Connecting);
            match self.clone().connect_once(session, identity.clone()).await {
                Ok(()) => attempt = 0,
                Err(error) if error.downcast_ref::<Revoked>().is_some() => {
                    self.revoked().await;
                    continue;
                }
                Err(error) if error.downcast_ref::<Fenced>().is_some() => {
                    log::warn!("relay host: generation {} was retired by a newer runtime", identity.runtime_generation);
                    fenced = Some(identity.runtime_generation);
                    self.link.fenced(identity.runtime_generation);
                    self.status.send_replace(HostStatus::Fenced { runtime_generation: identity.runtime_generation });
                    self.close_all_connections();
                    continue;
                }
                Err(error) => {
                    log::warn!("relay host: {error:#}");
                    attempt += 1;
                }
            }
            self.close_all_connections();
            if self.is_stopped() {
                return;
            }
            self.status.send_replace(HostStatus::Retrying { attempt });
            self.pause(protocol::backoff(attempt, jitter())).await;
        }
    }

    async fn revoked(&self) {
        log::warn!("relay host: the runtime credential was rejected; not serving");
        self.status.send_replace(HostStatus::Revoked);
        self.close_all_connections();
        self.pause(REFRESH_INTERVAL).await;
    }

    async fn fetch_session(&self) -> Result<RelaySession> {
        let link = self.link.clone();
        tokio::task::spawn_blocking(move || link.session()).await?
    }

    async fn connect_once(self: Arc<Self>, session: RelaySession, identity: TokenIdentity) -> Result<()> {
        let relay_host_id = self.keypair.host_id();
        let (cell_url, assignment_epoch) = assign(&session.director_url, &session.relay_token, &relay_host_id).await?;
        // Offsets, cursors and `rpc.hello` report the generation registered.
        self.rpc.set_generation(identity.runtime_generation);
        // Who has access is known before any client can connect, not only
        // after the first refresh (contract §21.5).
        self.install_session_policy(&session, identity.runtime_generation, None)?;
        let (mut socket, relay_generation) =
            self.open_control(&cell_url, assignment_epoch, &session.relay_token, &identity).await?;
        let (commands, mut command_rx) = mpsc::unbounded_channel();
        let live = Live { commands, cell_url: cell_url.clone(), assignment_epoch, relay_generation };
        self.status.send_replace(HostStatus::Registered {
            relay_host_id: relay_host_id.clone(),
            runtime_generation: identity.runtime_generation,
        });
        log::info!("relay host {relay_host_id} registered (runtime generation {})", identity.runtime_generation);
        // Attachments are answered off the control task: an invite round-trips
        // through this same socket.
        let refresher = tokio::spawn(self.clone().refresh_loop(live.clone(), session.director_url.clone(), identity.runtime_generation));
        *self.registered.lock().unwrap() = Some((live.clone(), session.director_url.clone()));
        // Stopped while it registered: `stop` found no registration to close.
        if self.is_stopped() {
            let _ = live.commands.send(ControlCommand::Shutdown);
        }
        let result = self.control_loop(&mut socket, &mut command_rx, &live).await;
        *self.registered.lock().unwrap() = None;
        refresher.abort();
        result
    }

    async fn open_control(
        &self,
        cell_url: &str,
        assignment_epoch: u64,
        relay_token: &str,
        identity: &TokenIdentity,
    ) -> Result<(Socket, u64)> {
        let mut request = websocket_url(cell_url, "/v1/host/control")?.into_client_request()?;
        request.headers_mut().insert("authorization", HeaderValue::from_str(&format!("Bearer {relay_token}"))?);
        let (mut socket, _) = tokio::time::timeout(
            CONNECT_TIMEOUT,
            crate::data_privacy::connect(request, Some(websocket_config()), false),
        )
        .await
        .context("relay control connect timed out")??;
        socket
            .send(Message::Text(
                json!({
                    "type": "host-hello",
                    "v": 1,
                    "relayHostId": self.keypair.host_id(),
                    "assignmentEpoch": assignment_epoch,
                    "hostPublicKeyB64": self.keypair.public_key_b64(),
                    "appVersion": concat!("terminalx-serve/", env!("CARGO_PKG_VERSION")),
                })
                .to_string()
                .into(),
            ))
            .await?;
        let challenge = next_json(&mut socket).await?;
        if challenge["type"] != "host-challenge" {
            bail!("relay did not challenge the host key");
        }
        let text = |name: &str| challenge[name].as_str().ok_or_else(|| anyhow!("host challenge lacks {name}"));
        let proof = answer_relay_challenge(
            &self.keypair,
            text("challengeId")?,
            text("relayEphemeralPublicKeyB64")?,
            text("nonceB64")?,
            text("ciphertextB64")?,
            challenge["expiresAt"].as_i64().ok_or_else(|| anyhow!("host challenge lacks expiresAt"))?,
            &RelayProofContext {
                relay_origin: cell_url,
                user_id: &identity.user_id,
                profile_id: &identity.profile_id,
                organization_id: &identity.organization_id,
                relay_host_id: &self.keypair.host_id(),
                assignment_epoch,
                previous_generation: None,
                resume_requested: false,
                now_ms: now_ms(),
            },
        )?;
        socket
            .send(Message::Text(
                json!({ "type": "host-challenge-ack", "challengeId": challenge["challengeId"], "proofB64": proof })
                    .to_string()
                    .into(),
            ))
            .await?;
        let ack = next_json(&mut socket).await?;
        let generation = ack["generation"].as_u64().unwrap_or(0);
        if ack["type"] != "host-hello-ack" || ack["v"] != 1 || generation == 0 {
            bail!("relay refused the host registration");
        }
        // Clients the relay queued while the runtime was away are served now.
        if let Some(pending) = ack["pendingConns"].as_array() {
            for pending in pending {
                log::debug!("relay host: pending connection {}", pending["connId"]);
            }
        }
        Ok((socket, generation))
    }

    async fn control_loop(
        self: &Arc<Self>,
        socket: &mut Socket,
        commands: &mut mpsc::UnboundedReceiver<ControlCommand>,
        live: &Live,
    ) -> Result<()> {
        let mut invites = HashMap::<String, oneshot::Sender<Result<(String, i64)>>>::new();
        let mut installs = HashMap::<String, oneshot::Sender<Result<Value>>>::new();
        let mut forwarded = Forwarded::new();
        loop {
            forget_unanswered(&mut forwarded, Instant::now());
            tokio::select! {
                command = commands.recv() => {
                    let Some(command) = command else { return Ok(()) };
                    match command {
                        ControlCommand::CreateInvite { device_id, respond } => {
                            let req_id = uuid::Uuid::new_v4().simple().to_string();
                            socket.send(Message::Text(json!({ "type": "invite-create", "reqId": req_id, "relayDeviceId": device_id }).to_string().into())).await?;
                            invites.insert(req_id, respond);
                        }
                        ControlCommand::Shutdown => {
                            let _ = socket.close(None).await;
                            return Err(Revoked.into());
                        }
                        ControlCommand::Reregister => {
                            let _ = socket.close(None).await;
                            return Ok(());
                        }
                        ControlCommand::Revoke { device_id } => {
                            let req_id = uuid::Uuid::new_v4().simple().to_string();
                            socket.send(Message::Text(json!({ "type": "device-revoke", "reqId": req_id, "relayDeviceId": device_id }).to_string().into())).await?;
                        }
                        ControlCommand::Forward { frame, req_id, respond } => {
                            if forwarded.contains_key(&req_id) || installs.contains_key(&req_id) || invites.contains_key(&req_id) {
                                let _ = respond.send(Err(anyhow!("duplicate relay request id")));
                                continue;
                            }
                            socket.send(Message::Text(frame.to_string().into())).await?;
                            forwarded.insert(req_id, (respond, Instant::now()));
                        }
                        ControlCommand::InstallCredential { payload, req_id, respond } => {
                            if installs.contains_key(&req_id) || forwarded.contains_key(&req_id) {
                                let _ = respond.send(Err(anyhow!("duplicate relay request id")));
                                continue;
                            }
                            socket.send(Message::Text(payload.to_string().into())).await?;
                            installs.insert(req_id, respond);
                        }
                    }
                }
                incoming = tokio::time::timeout(SILENCE_TIMEOUT, socket.next()) => {
                    let incoming = incoming.context("relay control went silent")?.ok_or_else(|| anyhow!("relay control closed"))??;
                    let text = match incoming {
                        Message::Text(text) => text,
                        Message::Close(frame) => {
                            let code = frame.as_ref().map(|frame| u16::from(frame.code)).unwrap_or(1006);
                            if code == 4101 {
                                return Err(Fenced.into());
                            }
                            bail!("relay control closed with {code}");
                        }
                        Message::Ping(bytes) => {
                            socket.send(Message::Pong(bytes)).await?;
                            continue;
                        }
                        _ => bail!("relay sent a non-text control message"),
                    };
                    let message: Value = serde_json::from_str(&text)?;
                    // A reply to a request the window made through this registration.
                    if FORWARDED_REPLIES.contains(&message["type"].as_str().unwrap_or_default()) {
                        if let Some((respond, _)) = message["reqId"].as_str().and_then(|req_id| forwarded.remove(req_id)) {
                            let _ = respond.send(Ok(message));
                            continue;
                        }
                    }
                    match message["type"].as_str().unwrap_or("") {
                        "ping" => socket.send(Message::Text(json!({ "type": "pong", "t": message["t"] }).to_string().into())).await?,
                        "invite-created" => {
                            let req_id = message["reqId"].as_str().unwrap_or_default();
                            if let Some(respond) = invites.remove(req_id) {
                                let token = message["inviteToken"].as_str().map(str::to_string);
                                let expires = message["expiresAt"].as_i64();
                                let _ = respond.send(match (token, expires) {
                                    (Some(token), Some(expires)) if valid_base64url_32(&token) => Ok((token, expires)),
                                    _ => Err(anyhow!("invalid relay invite")),
                                });
                            }
                        }
                        "device-revoked" => {}
                        "account-pairing-changed" => {
                            let hint = self.pairing_hint.lock().unwrap().clone();
                            if let Some(hint) = hint {
                                hint();
                            }
                        }
                        "device-credential-installed" => {
                            let req_id = message["reqId"].as_str().unwrap_or_default().to_string();
                            if let Some(respond) = installs.remove(&req_id) {
                                let mut result = message.clone();
                                result.as_object_mut().map(|object| object.remove("type"));
                                let _ = respond.send(Ok(result));
                            }
                        }
                        "conn-open" => {
                            let connection: ConnectionOpen = serde_json::from_value(message).context("invalid relay connection request")?;
                            let host = self.clone();
                            let live = live.clone();
                            tokio::spawn(async move {
                                // On a machine, a device that is neither attached
                                // through the link nor a paired computer is a
                                // phone. The registry is a file: read off this loop.
                                if let Some(routes) = host.routes() {
                                    let attached = host.state.lock().unwrap().devices.contains_key(&connection.relay_device_id);
                                    let device = connection.relay_device_id.clone();
                                    let lookup = routes.clone();
                                    let computer = attached || tokio::task::spawn_blocking(move || lookup.is_computer(&device)).await.unwrap_or(true);
                                    if !computer {
                                        host.forward_phone(&routes, &live, &connection);
                                        return;
                                    }
                                }
                                if let Err(error) = host.serve_connection(live, connection).await {
                                    log::debug!("relay host: client connection ended: {error:#}");
                                }
                            });
                        }
                        "drain" => bail!("relay cell is draining"),
                        "control-error" => {
                            let req_id = message["reqId"].as_str().unwrap_or_default();
                            let error = || anyhow!("relay refused the request: {}", message["code"]);
                            if let Some(respond) = invites.remove(req_id) {
                                let _ = respond.send(Err(error()));
                            } else if let Some(respond) = installs.remove(req_id) {
                                let _ = respond.send(Err(error()));
                            }
                        }
                        other => log::debug!("relay host: ignoring control message {other}"),
                    }
                }
            }
        }
    }

    /// Answer new attachments with pairing codes and apply revocations.
    async fn refresh_loop(self: Arc<Self>, live: Live, director_url: String, runtime_generation: u64) {
        loop {
            match self.fetch_session().await {
                Ok(session) => {
                    // A rotated token with a newer generation needs a fresh
                    // registration; the relay fences this one when it arrives.
                    if token_identity(&session.relay_token).is_ok_and(|identity| identity.runtime_generation > runtime_generation) {
                        log::info!("relay host: a newer runtime generation was issued; registering again");
                        let _ = live.commands.send(ControlCommand::Reregister);
                        return;
                    }
                    // Bind the entire response to the generation of this registered
                    // connection, not to any caller-supplied policy field.
                    if !token_identity(&session.relay_token).is_ok_and(|identity| identity.runtime_generation == runtime_generation) {
                        log::warn!("ignoring refresh from a different runtime generation");
                        tokio::time::sleep(SESSION_POLL_INTERVAL).await;
                        continue;
                    }
                    if let Err(error) = self.apply_refreshed_session(&live, &director_url, session, runtime_generation).await {
                        log::warn!("collaboration refresh refused: {error:#}");
                    }
                }
                Err(error) if error.downcast_ref::<Revoked>().is_some() => {
                    let _ = live.commands.send(ControlCommand::Shutdown);
                    return;
                }
                Err(error) => log::warn!("relay host: refresh failed: {error:#}"),
            }
            tokio::time::sleep(SESSION_POLL_INTERVAL).await;
        }
    }

    /// Policy, observed provenance revocations, then pending attachments from
    /// this response. Never pair a device from a refused or retired snapshot.
    async fn apply_refreshed_session(&self, live: &Live, director_url: &str, session: RelaySession, generation: u64) -> Result<()> {
        let policy = self.install_session_policy(&session, generation, Some(live));
        // Revocations have independent authority. A malformed or unsupported
        // policy must not keep its revoked devices connected or reconnectable.
        if self.apply_revocations(Some(live), &session.revocations) {
            self.complete_revocations(&session.revocations).await;
        }
        policy?;
        for attachment in session.attachments {
            if let Err(error) = self.answer_attachment(live, director_url, attachment).await {
                log::warn!("relay host: could not answer an attachment: {error:#}");
            }
        }
        Ok(())
    }

    fn install_session_policy(&self, session: &RelaySession, generation: u64, live: Option<&Live>) -> Result<()> {
        let previous: Vec<_> = self.state.lock().unwrap().devices.iter().map(|(device_id, device)| {
            let stamp = device.user_id.as_deref().and_then(|user| self.rpc.collab.runtime_policy.stamp(user));
            (device_id.clone(), device.attachment_id.clone(), stamp)
        }).collect();
        install_session_collaboration(&self.rpc, session, generation)?;
        let changed: Vec<_> = previous.into_iter().filter(|(_, _, stamp)| session.collaboration_v2 && stamp.as_ref().is_none_or(|stamp| !self.rpc.collab.runtime_policy.same_member(stamp)))
            .map(|(device_id, id, _)| Revocation { id, device_id }).collect();
        // Retire saved credentials too: reconnecting an old workspace/session
        // attachment must not evade its observed source change. On restart,
        // absent native provenance retires saved v2 attachments conservatively.
        if !self.apply_revocations(live, &changed) {
            bail!("could not persist collaboration attachment revocations");
        }
        Ok(())
    }

    /// Tell the API each applied revocation, so it stops listing it. A
    /// failure is retried on the next poll: the revocation is listed again
    /// and applying it twice changes nothing.
    async fn complete_revocations(&self, revocations: &[Revocation]) {
        for revocation in revocations {
            if self.state.lock().unwrap().confirmed.contains(&revocation.id) {
                continue;
            }
            let (link, id) = (self.link.clone(), revocation.id.clone());
            match tokio::task::spawn_blocking(move || link.complete_revocation(&id)).await {
                Ok(Ok(())) => {
                    self.state.lock().unwrap().confirmed.insert(revocation.id.clone());
                }
                Ok(Err(error)) => log::warn!("relay host: could not complete a revocation: {error:#}"),
                Err(error) => log::warn!("relay host: could not complete a revocation: {error}"),
            }
        }
    }

    /// Whether the revocations are durable: a revocation confirmed to the API
    /// is never listed again, so it must not be confirmed while the device
    /// list on disk still admits the device.
    fn apply_revocations(&self, live: Option<&Live>, revocations: &[Revocation]) -> bool {
        let mut state = self.state.lock().unwrap();
        let mut changed = false;
        for revocation in revocations {
            if state.devices.remove(&revocation.device_id).is_some() {
                changed = true;
                if let Some(live) = live {
                    let _ = live.commands.send(ControlCommand::Revoke { device_id: revocation.device_id.clone() });
                }
            }
            for cancel in state.connections.remove(&revocation.device_id).unwrap_or_default() {
                let _ = cancel.send(());
            }
            state.completed.insert(completion_key(&revocation.id, &revocation.device_id));
        }
        if changed || state.devices_unsaved {
            state.devices_unsaved = !self.save_devices(&state.devices);
        }
        !state.devices_unsaved
    }

    async fn answer_attachment(&self, live: &Live, director_url: &str, attachment: Attachment) -> Result<()> {
        let key = completion_key(&attachment.id, &attachment.device_id);
        if self.state.lock().unwrap().completed.contains(&key) || attachment.expires_at <= now_ms() {
            return Ok(());
        }
        let authority = Authority::from_scope(&attachment.scope).ok_or_else(|| anyhow!("unknown attachment scope"))?;
        if !valid_opaque_id(&attachment.device_id) || attachment.device_token.len() < 16 {
            bail!("invalid attachment device");
        }
        let collaboration = {
            let _admission = self.rpc.collab.enter_admission();
            let stamp = attachment.user_id.as_deref().and_then(|user| self.rpc.collab.runtime_policy.stamp(user));
            anyhow::ensure!(self.rpc.collab.runtime_policy.attachment_current(stamp.as_ref()), "attachment policy unavailable");
            stamp
        };
        let (respond, receive) = oneshot::channel();
        live.commands
            .send(ControlCommand::CreateInvite { device_id: attachment.device_id.clone(), respond })
            .map_err(|_| anyhow!("relay control is offline"))?;
        let (invite_token, invite_expires_at) = tokio::time::timeout(CONNECT_TIMEOUT, receive).await??.context("create invite")?;
        let offer = json!({
            "v": 2,
            "endpoint": format!("relay:{}", self.keypair.host_id()),
            "deviceToken": attachment.device_token,
            "publicKeyB64": self.keypair.public_key_b64(),
            "scope": attachment.scope,
            "identityMode": "authenticate",
            "relay": {
                "v": 1,
                "directorUrl": director_url,
                "cellUrl": live.cell_url,
                "assignmentEpoch": live.assignment_epoch,
                "relayHostId": self.keypair.host_id(),
                "inviteToken": invite_token,
                "inviteExpiresAt": invite_expires_at,
                "e2eeFraming": 2,
            },
        });
        let pairing_code = general_purpose::URL_SAFE_NO_PAD.encode(offer.to_string());
        // Admit the device before publishing the code, so the first connect
        // cannot race the registration.
        {
            let _admission = self.rpc.collab.enter_admission();
            anyhow::ensure!(self.rpc.collab.runtime_policy.attachment_current(collaboration.as_ref()), "attachment policy changed while creating invite");
            let mut state = self.state.lock().unwrap();
            state.devices.insert(
                attachment.device_id.clone(),
                Device {
                    collaboration,
                    token_hash: Sha256::digest(attachment.device_token.as_bytes()).into(),
                    authority,
                    attachment_id: attachment.id.clone(),
                    user_id: attachment.user_id.clone(),
                    // Anything but the API's 43 base64url characters is no key at all.
                    installation_key: attachment.installation_key.clone().filter(|key| valid_base64url_32(key)),
                },
            );
            self.save_devices(&state.devices);
        }
        let link = self.link.clone();
        let attachment_id = attachment.id.clone();
        tokio::task::spawn_blocking(move || link.complete_attachment(&attachment_id, &pairing_code)).await??;
        self.state.lock().unwrap().completed.insert(key);
        Ok(())
    }

    /// Route a phone's relay data leg to the current phone host.
    fn forward_phone(&self, routes: &Arc<dyn MachineRoutes>, live: &Live, connection: &ConnectionOpen) {
        let forwarded = crate::machine_wire::Forwarded::Relay {
            cell_url: live.cell_url.clone(),
            relay_host_id: self.keypair.host_id(),
            generation: live.relay_generation,
            connection: crate::machine_wire::RelayConnection {
                conn_id: connection.conn_id.clone(),
                conn_ticket: connection.conn_ticket.clone(),
                kind: connection.kind.clone(),
                relay_device_id: connection.relay_device_id.clone(),
                attach_deadline_ms: connection.attach_deadline_ms,
            },
        };
        // Keep forwarded phones in the same cancellation set as computers:
        // loss of the registration fences both idle and handshaking phones.
        let (sender, cancel) = mpsc::unbounded_channel();
        {
            let registered = self.registered.lock().unwrap();
            if !registered.as_ref().is_some_and(|(current, _)| current.relay_generation == live.relay_generation && current.cell_url == live.cell_url) || self.is_stopped() {
                return;
            }
            let mut state = self.state.lock().unwrap();
            let open = state.connections.entry(connection.relay_device_id.clone()).or_default();
            open.retain(|sender| !sender.is_closed());
            open.push(sender);
        }
        if !routes.forward_phone(forwarded, cancel) {
            log::debug!("relay host: no phone host takes this connection");
        }
    }

    fn close_all_connections(&self) {
        for (_, cancels) in self.state.lock().unwrap().connections.drain() {
            for cancel in cancels {
                let _ = cancel.send(());
            }
        }
    }

    async fn serve_connection(self: Arc<Self>, live: Live, connection: ConnectionOpen) -> Result<()> {
        let mut request = websocket_url(&live.cell_url, &format!("/v1/host/data/{}", connection.conn_id))?.into_client_request()?;
        request.headers_mut().remove("authorization");
        let deadline = Duration::from_millis(connection.attach_deadline_ms.clamp(1, 60_000));
        let (mut socket, _) = tokio::time::timeout(
            deadline,
            crate::data_privacy::connect(request, Some(websocket_config()), false),
        )
        .await
        .context("relay data connect timed out")??;
        socket
            .send(Message::Text(
                json!({ "type": "host-data-auth", "v": 1, "connTicket": connection.conn_ticket, "generation": live.relay_generation })
                    .to_string()
                    .into(),
            ))
            .await?;
        let hello = match tokio::time::timeout(CONNECT_TIMEOUT, socket.next()).await.context("client sent no E2EE hello")? {
            Some(Ok(Message::Text(text))) => text,
            _ => bail!("client closed before the E2EE hello"),
        };
        let hello: E2eeHello = serde_json::from_str(&hello).context("decode E2EE hello")?;
        let host_id = self.keypair.host_id();
        let (ready, mut session) = begin_e2ee_session(&self.keypair, hello, "relay", Some(&host_id))?;
        socket.send(Message::Text(serde_json::to_string(&ready)?.into())).await?;
        let auth = match tokio::time::timeout(CONNECT_TIMEOUT, socket.next()).await.context("client sent no E2EE auth")? {
            Some(Ok(Message::Text(text))) => text,
            _ => bail!("client closed before E2EE authentication"),
        };
        let auth: Value = serde_json::from_slice(&session.open(&general_purpose::STANDARD.decode(auth.as_bytes())?, PayloadKind::Text)?)?;
        if auth["type"] != "e2ee_auth" || auth["v"] != 2 || auth["transcriptHashB64"].as_str() != Some(&session.transcript_hash_b64) {
            bail!("E2EE authentication was not bound to the handshake");
        }
        let token = auth["deviceToken"].as_str().ok_or_else(|| anyhow!("E2EE authentication lacks a device token"))?;
        // Checked and registered under one lock, so a revocation either
        // refuses this connection or finds it and closes it.
        let (cancel_tx, mut cancel) = mpsc::unbounded_channel();
        let (device, computer) = match self.admit(&connection.relay_device_id, token, &session.client_public_key_b64, cancel_tx).await {
            Ok(admitted) => admitted,
            Err(error) if error.is::<ComputerRefused>() => {
                // As on the direct route: the reason, sealed, then `4401`, so
                // a revoked computer stops retrying instead of taking the
                // relay for unreachable (docs/MACHINES.md "As built (PRO-345)").
                let reason = error.downcast_ref::<ComputerRefused>().map(|refused| refused.0).unwrap_or(crate::machine_wire::REFUSED_CODE_INACTIVE);
                let refused = json!({ "type": "pairing_refused", "v": 1, "reason": reason });
                let _ = send_sealed(&mut socket, &mut session, &refused).await;
                let frame = tokio_tungstenite::tungstenite::protocol::CloseFrame { code: 4401.into(), reason: "credential refused".into() };
                let _ = socket.close(Some(frame)).await;
                return Err(error);
            }
            Err(error) => return Err(error),
        };
        // Whether it counts as use of the workspace is decided at `rpc.hello`:
        // only a client that can type does (`WorkspaceRpc::count_attachment`).
        let authenticated = json!({ "type": "e2ee_authenticated", "v": 2, "transcriptHashB64": session.transcript_hash_b64 });
        send_sealed(&mut socket, &mut session, &authenticated).await?;

        // A paired computer is the same peer on every route: its registry id,
        // as the direct route names it (`machine_host::direct`). Under its
        // relay device id it would lose its terminals' control and its write
        // numbering each time it moved between the direct route and the relay.
        let peer_id = computer.as_ref().map_or_else(|| connection.relay_device_id.clone(), |(computer_id, _)| computer_id.clone());
        let (peer, notifications) = Peer::for_installation(peer_id, device.authority, device.user_id.clone(), device.installation_key.clone());
        log::info!("relay host: attachment {} connected ({:?})", device.attachment_id, device.authority);
        let result = serve_rpc(&mut socket, &mut session, &self.rpc, &peer, notifications, &mut cancel, |request| {
            (request["method"] == "pairing.provisionRelay").then(|| {
                let request = request.clone();
                let (host, live, connection) = (self.clone(), live.clone(), connection.clone());
                Box::pin(async move { host.provision_resume(&live, &connection, &request).await }) as futures_util::future::BoxFuture<'static, Value>
            })
        })
        .await;
        drop(cancel);
        if let (Some((computer_id, tracked)), Some(routes)) = (&computer, self.routes()) {
            routes.release_computer(computer_id, *tracked);
        }
        if let Some(senders) = self.state.lock().unwrap().connections.get_mut(&connection.relay_device_id) {
            senders.retain(|sender| !sender.is_closed());
        }
        result
    }

    /// The device, and the paired computer's tracked connection when it is one.
    async fn admit(&self, relay_device_id: &str, token: &str, client_key_b64: &str, cancel: mpsc::UnboundedSender<()>) -> Result<(Device, Option<(String, u64)>)> {
        let hash: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        let attached = self.state.lock().unwrap().devices.contains_key(relay_device_id);
        if let (false, Some(routes)) = (attached, self.routes()) {
            // A paired computer: full operating rights (decision 5). Its
            // connection closes with every other one when the runtime loses
            // its credential, is fenced or loses the control connection, and
            // with its record when the machine revokes it.
            {
                let mut state = self.state.lock().unwrap();
                let senders = state.connections.entry(relay_device_id.to_string()).or_default();
                senders.retain(|sender| !sender.is_closed());
                senders.push(cancel.clone());
            }
            let (device_id, token, key) = (relay_device_id.to_string(), token.to_string(), client_key_b64.to_string());
            let (computer_id, tracked) = tokio::task::spawn_blocking(move || routes.admit_computer(&device_id, &token, &key, cancel))
                .await??
                .map_err(ComputerRefused)?;
            let device = Device { collaboration: None, token_hash: hash, authority: Authority::Manage, attachment_id: computer_id.clone(), user_id: None, installation_key: None };
            return Ok((device, Some((computer_id, tracked))));
        }
        let _admission = self.rpc.collab.enter_admission();
        let mut state = self.state.lock().unwrap();
        // The relay credential named the device; the token must be that
        // device's, so an invite cannot be used with another attachment's token.
        let device = state.devices.get(relay_device_id).ok_or_else(|| anyhow!("device is not attached"))?.clone();
        anyhow::ensure!(self.rpc.collab.runtime_policy.attachment_current(device.collaboration.as_ref()), "attachment collaboration provenance retired");
        if !bool::from(device.token_hash.ct_eq(&hash)) {
            bail!("device token refused");
        }
        let senders = state.connections.entry(relay_device_id.to_string()).or_default();
        senders.retain(|sender| !sender.is_closed());
        senders.push(cancel);
        Ok((device, None))
    }

    /// Install a resume credential for the device of an invite connection,
    /// authorized by that connection (relay basis), as the desktop pairing
    /// host does for the phone.
    async fn provision_resume(&self, live: &Live, connection: &ConnectionOpen, request: &Value) -> Value {
        let id = request["id"].as_str().unwrap_or("");
        let result = async {
            if connection.kind != "invite" {
                bail!("resume credentials are provisioned only on the invite connection");
            }
            let params = &request["params"];
            let req_id = params["reqId"].as_str().filter(|value| valid_opaque_id(value)).ok_or_else(|| anyhow!("reqId is required"))?;
            let hash = params["newResumeTokenHash"].as_str().filter(|value| valid_base64url_32(value)).ok_or_else(|| anyhow!("newResumeTokenHash is required"))?;
            let mut payload = json!({
                "type": "device-credential-install",
                "v": 1,
                "reqId": req_id,
                "relayDeviceId": connection.relay_device_id,
                "newResumeTokenHash": hash,
                "authorization": { "mode": "relay-basis", "basisConnId": connection.conn_id },
            });
            if let Some(expected) = params["expectedCurrentHash"].as_str().filter(|value| valid_base64url_32(value)) {
                payload["expectedCurrentHash"] = json!(expected);
            }
            let (respond, receive) = oneshot::channel();
            live.commands
                .send(ControlCommand::InstallCredential { payload, req_id: req_id.to_string(), respond })
                .map_err(|_| anyhow!("relay control is offline"))?;
            tokio::time::timeout(CONNECT_TIMEOUT, receive).await??
        }
        .await;
        match result {
            Ok(installed) => protocol::success(id, installed),
            Err(error) => protocol::failure(id, &protocol::RpcError::new("unavailable", format!("{error:#}"))),
        }
    }
}

/// The same generation-bound policy installation precedes initial registration
/// and every refresh's revocations and pending attachments. `RelaySession`
/// comes from the authenticated native link, never RPC parameters.
pub(crate) fn install_session_collaboration(rpc: &WorkspaceRpc, session: &RelaySession, generation: u64) -> Result<()> {
    anyhow::ensure!(token_identity(&session.relay_token)?.runtime_generation == generation, "refresh token generation mismatch");
    rpc.set_refresh_collaboration(session.collaboration.clone(), generation, session.collaboration_v2)
}

/// Start serving a workspace through the relay: learn the runtime
/// generation from the link's Relay Token, build the RPC surface over the
/// runtime's terminals and sessions, and register. Retries until the link
/// yields a session; returns the running host.
pub async fn serve_workspace(
    link: Arc<dyn RuntimeLink>,
    root: PathBuf,
    sink: Arc<dyn crate::sink::EventSink>,
    terminals: Arc<crate::pty::Terminals>,
    sessions: Option<crate::session::SessionManager>,
    devices_path: Option<PathBuf>,
    agents: Option<Arc<crate::cloud_agents::CloudAgents>>,
) -> Result<Arc<RelayHost>> {
    let mut attempt = 0u32;
    let generation = loop {
        let fetch = link.clone();
        match tokio::task::spawn_blocking(move || fetch.session()).await?.and_then(|session| token_identity(&session.relay_token)) {
            Ok(identity) => break identity.runtime_generation,
            Err(error) => {
                attempt += 1;
                log::warn!("relay host: waiting for a runtime session: {error:#}");
                tokio::time::sleep(protocol::backoff(attempt, jitter())).await;
            }
        }
    };
    let rpc = WorkspaceRpc::new(&root, generation, sink, terminals, sessions)?;
    if let Some(agents) = agents {
        agents.set_generation(generation);
        rpc.set_agents(agents);
    }
    let host = RelayHost::new(link, rpc, devices_path);
    tokio::spawn(host.clone().run());
    Ok(host)
}

/// Start serving every project of this machine through the relay
/// (`machine/1`, PRO-340), as [`serve_workspace`] serves one root. The
/// machine is named by the host key the link registers with, so its
/// `machineId` is the relay host id; `has_window` says whether a desktop app
/// runs here (`TERMINALX_LOCAL_DESKTOP`, set when the app starts the runtime).
pub async fn serve_machine(
    link: Arc<dyn RuntimeLink>,
    sink: Arc<dyn crate::sink::EventSink>,
    terminals: Arc<crate::pty::Terminals>,
    sessions: Option<crate::session::SessionManager>,
    devices_path: Option<PathBuf>,
    agents: Option<Arc<crate::cloud_agents::CloudAgents>>,
    routes: Option<Arc<dyn MachineRoutes>>,
) -> Result<Arc<RelayHost>> {
    let generation = runtime_generation(&link).await;
    let identity = super::machine::Identity {
        machine_id: HostKeypair::from_secret(link.host_secret()).host_id(),
        has_window: std::env::var("TERMINALX_LOCAL_DESKTOP").as_deref() == Ok("1"),
    };
    let rpc = WorkspaceRpc::machine(identity, generation, sink, terminals, sessions)?;
    if let Some(agents) = agents {
        agents.set_generation(generation);
        rpc.set_agents(agents);
    }
    let host = RelayHost::new(link, rpc, devices_path);
    // Before it registers, so no connection is answered without them.
    if let Some(routes) = routes {
        host.set_routes(routes);
    }
    tokio::spawn(host.clone().run());
    Ok(host)
}

/// The runtime generation in the link's Relay Token, waiting with backoff
/// until the link yields a session.
async fn runtime_generation(link: &Arc<dyn RuntimeLink>) -> u64 {
    let mut attempt = 0u32;
    loop {
        let fetch = link.clone();
        match tokio::task::spawn_blocking(move || fetch.session()).await.map_err(anyhow::Error::from).and_then(|session| session).and_then(|session| token_identity(&session.relay_token)) {
            Ok(identity) => return identity.runtime_generation,
            Err(error) => {
                attempt += 1;
                log::warn!("relay host: waiting for a runtime session: {error:#}");
                tokio::time::sleep(protocol::backoff(attempt, jitter())).await;
            }
        }
    }
}

/// A [`RuntimeLink`] returns this when the API rejects the runtime
/// credential: the host disconnects every client and stops serving.
#[derive(Debug)]
pub struct Revoked;

impl std::fmt::Display for Revoked {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the runtime credential was rejected")
    }
}

impl std::error::Error for Revoked {}

#[derive(Debug)]
struct Fenced;

impl std::fmt::Display for Fenced {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the relay retired this runtime generation")
    }
}

impl std::error::Error for Fenced {}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionOpen {
    conn_id: String,
    conn_ticket: String,
    kind: String,
    relay_device_id: String,
    attach_deadline_ms: u64,
}

type Socket = crate::data_privacy::Socket;

async fn assign(director_url: &str, relay_token: &str, relay_host_id: &str) -> Result<(String, u64)> {
    let url = format!("{}/v1/assign", director_url.trim_end_matches('/'));
    let token = relay_token.to_string();
    let host = relay_host_id.to_string();
    let response: Value = tokio::task::spawn_blocking(move || -> Result<Value> {
        let response = crate::data_privacy::http_agent().build().post(&url)
            .timeout(CONNECT_TIMEOUT)
            .set("authorization", &format!("Bearer {token}"))
            .send_json(json!({ "v": 1, "relayHostId": host }))
            .map_err(|error| anyhow!("relay assignment failed: {}", protocol::redact(&error.to_string())))?;
        Ok(response.into_json()?)
    })
    .await??;
    let cell_url = response["cellUrl"].as_str().ok_or_else(|| anyhow!("relay assignment lacks cellUrl"))?.to_string();
    let epoch = response["assignmentEpoch"].as_u64().ok_or_else(|| anyhow!("relay assignment lacks assignmentEpoch"))?;
    Ok((cell_url, epoch))
}

async fn next_json(socket: &mut Socket) -> Result<Value> {
    match tokio::time::timeout(CONNECT_TIMEOUT, socket.next()).await.context("relay control timed out")? {
        Some(Ok(Message::Text(text))) => Ok(serde_json::from_str(&text)?),
        Some(Ok(Message::Close(frame))) => {
            let code = frame.as_ref().map(|frame| u16::from(frame.code)).unwrap_or(1006);
            if code == 4101 {
                return Err(Fenced.into());
            }
            bail!("relay closed the control socket with {code}")
        }
        Some(Ok(_)) => bail!("relay sent a non-text control message"),
        Some(Err(error)) => Err(error.into()),
        None => bail!("relay closed the control socket"),
    }
}

pub(crate) async fn send_sealed<S>(socket: &mut S, session: &mut E2eeSession, value: &Value) -> Result<()>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let frame = session.seal(value.to_string().as_bytes(), PayloadKind::Text)?;
    socket.send(Message::Text(general_purpose::STANDARD.encode(frame).into())).await?;
    Ok(())
}

async fn before_rpc_close<T>(
    cancel: &mut mpsc::UnboundedReceiver<()>,
    peer: &Peer,
    operation: impl std::future::Future<Output = T>,
) -> Option<T> {
    tokio::select! {
        biased;
        _ = cancel.recv() => None,
        _ = peer.closed() => None,
        result = operation => Some(result),
    }
}

/// Serve workspace RPC to an authenticated peer on an E2EE socket until
/// either side closes, `cancel` fires (a revocation) or the peer loses access.
/// Every route of a host serves through here: the relay's data legs and a
/// machine's direct listener (`machine_host`). `extra` answers the few
/// requests a route serves itself, as the relay does `pairing.provisionRelay`.
///
/// Slow mutations (Git network calls, agent prompts) answer from their own
/// task, so the connection keeps reading, streaming and honouring a
/// revocation meanwhile. Everything else is answered in order, which keeps
/// terminal writes ordered.
pub(crate) async fn serve_rpc<S>(
    socket: &mut S,
    session: &mut E2eeSession,
    rpc: &Arc<WorkspaceRpc>,
    peer: &Arc<Peer>,
    mut notifications: super::server::Notifications,
    cancel: &mut mpsc::UnboundedReceiver<()>,
    extra: impl Fn(&Value) -> Option<futures_util::future::BoxFuture<'static, Value>>,
) -> Result<()>
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
        + futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error>
        + Unpin,
{
    let (answers_tx, mut answers) = mpsc::unbounded_channel::<(Value, Option<usize>)>();
    let mut branch_read_pending = [false; 2];
    let result = async {
        loop {
            tokio::select! {
                _ = cancel.recv() => {
                    let _ = socket.close().await;
                    return Ok(());
                }
                // The person lost access to the workspace (contract §21.5).
                _ = peer.closed() => {
                    let _ = socket.close().await;
                    return Ok(());
                }
                notification = notifications.recv() => {
                    let Some(notification) = notification else { return Ok(()) };
                    send_sealed(socket, session, &notification).await?;
                }
                answer = answers.recv() => {
                    if let Some((answer, branch_read)) = answer {
                        let Some(sent) = before_rpc_close(cancel, peer, send_sealed(socket, session, &answer)).await else {
                            // Drop the socket without flushing a partially queued reply.
                            return Ok(());
                        };
                        sent?;
                        if let Some(index) = branch_read { branch_read_pending[index] = false; }
                    }
                }
                incoming = socket.next() => {
                    crate::data_privacy::require_network()?;
                    let Some(incoming) = incoming else { return Ok(()) };
                    match incoming? {
                        Message::Text(text) => {
                            if text.len() > MAX_FRAME_BYTES * 2 {
                                bail!("client frame over the limit");
                            }
                            let plaintext = session.open(&general_purpose::STANDARD.decode(text.as_bytes())?, PayloadKind::Text)?;
                            let request: Value = serde_json::from_slice(&plaintext)?;
                            if let Some(answer) = extra(&request) {
                                let response = answer.await;
                                send_sealed(socket, session, &response).await?;
                                continue;
                            }
                            let response = match request["method"].as_str() {
                                // Connecting can take seconds, so from its own
                                // task; answered in order with the stream's data.
                                Some("ports.open") => {
                                    let rpc = rpc.clone();
                                    let peer = peer.clone();
                                    let ticket = crate::github_process::ticket();
                                    tokio::spawn(async move {
                                        let response = crate::github_process::with_ticket(ticket, || rpc.answer_port_open(&peer, &request));
                                        response.await;
                                    });
                                    continue;
                                }
                                Some(method) if SLOW_METHODS.contains(&method) => {
                                    let branch_read = match method {
                                        "git.branchDiffSize" => Some((0, &BRANCH_DIFF_SLOTS)),
                                        "git.branchBase" => Some((1, &BRANCH_BASE_SLOTS)),
                                        _ => None,
                                    };
                                    let slot = if let Some((index, slots)) = branch_read {
                                        let permit = try_branch_read_slot(slots, branch_read_pending[index]);
                                        let Some(permit) = permit else {
                                            let id = request["id"].as_str().unwrap_or("");
                                            let busy = protocol::RpcError::new("busy", "Branch comparison already in progress. Try again shortly.");
                                            let answer = protocol::failure(id, &busy);
                                            let Some(sent) = before_rpc_close(cancel, peer, send_sealed(socket, session, &answer)).await else {
                                                return Ok(());
                                            };
                                            sent?;
                                            continue;
                                        };
                                        branch_read_pending[index] = true;
                                        Some(permit)
                                    } else {
                                        None
                                    };
                                    let answer = rpc.handle_owned(peer.clone(), request);
                                    let answers = answers_tx.clone();
                                    tokio::spawn(async move {
                                        let _slot = slot;
                                        let _ = answers.send((answer.await, branch_read.map(|(index, _)| index)));
                                    });
                                    continue;
                                }
                                _ => rpc.handle(peer, &request).await,
                            };
                            send_sealed(socket, session, &response).await?;
                        }
                        Message::Binary(bytes) => {
                            // Binary streams are not part of workspace RPC v1; the
                            // frame is still authenticated so the counters stay aligned.
                            let _ = session.open(&bytes, PayloadKind::Binary)?;
                        }
                        Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await?,
                        Message::Close(_) => return Ok(()),
                        _ => {}
                    }
                }
            }
        }
    }
    .await;
    rpc.disconnect(peer);
    result
}

pub(crate) fn websocket_config() -> WebSocketConfig {
    WebSocketConfig::default().max_message_size(Some(4 * MAX_FRAME_BYTES)).max_frame_size(Some(4 * MAX_FRAME_BYTES))
}

/// `wss://` for HTTPS origins; plain `ws://` only for loopback development.
pub(crate) fn websocket_url(origin: &str, path: &str) -> Result<String> {
    let mut url = url::Url::parse(origin)?;
    match url.scheme() {
        "https" => url.set_scheme("wss").unwrap(),
        "http" if matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")) => url.set_scheme("ws").unwrap(),
        _ => bail!("relay origin must use HTTPS"),
    }
    url.set_path(path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.into())
}

pub(crate) fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
}

pub(crate) fn valid_base64url_32(value: &str) -> bool {
    value.len() == 43 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}


pub(crate) fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub(crate) fn jitter() -> f64 {
    use rand_core::RngCore;
    (rand_core::OsRng.next_u32() as f64) / (u32::MAX as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn jwt(claims: Value) -> String {
        format!(
            "{}.{}.sig",
            general_purpose::URL_SAFE_NO_PAD.encode(r#"{"alg":"EdDSA"}"#),
            general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string())
        )
    }

    #[test]
    fn asking_the_cli_for_its_commands_never_holds_up_the_connection() {
        // #449: `session.commands` waits on the tab's CLI. Answered in order, a
        // hidden chat tab's listing kept the terminal view's `pty.attach`
        // waiting after a wake, and what was typed meanwhile was dropped.
        assert!(SLOW_METHODS.contains(&"session.commands"));
        // Terminal calls stay in order: that is what keeps keystrokes ordered.
        assert!(!SLOW_METHODS.iter().any(|method| method.starts_with("pty.")));
    }

    #[tokio::test]
    async fn branch_diff_replies_yield_to_connection_revocation() {
        assert!(SLOW_METHODS.contains(&"git.branchDiffSize"));
        let (peer, _notifications) = Peer::new("device".into(), Authority::Manage);
        let (close, mut cancel) = mpsc::unbounded_channel();
        close.send(()).unwrap();
        assert_eq!(before_rpc_close(&mut cancel, &peer, std::future::ready("diff")).await, None);
    }

    #[test]
    fn branch_diff_admission_limits_each_connection_and_the_host() {
        let slots = tokio::sync::Semaphore::new(2);
        let first = try_branch_read_slot(&slots, false).unwrap();
        assert!(try_branch_read_slot(&slots, true).is_none());
        let second = try_branch_read_slot(&slots, false).unwrap();
        assert!(try_branch_read_slot(&slots, false).is_none());
        drop(first);
        assert!(try_branch_read_slot(&slots, false).is_some());
        drop(second);
    }

    #[test]
    fn an_attachment_may_name_its_installation_and_older_records_have_none() {
        let base = json!({ "id": "att-1", "deviceId": "dev-1", "deviceToken": "t".repeat(48), "userId": "u-1", "scope": "runtime", "expiresAt": 1 });
        let plain: Attachment = serde_json::from_value(base.clone()).unwrap();
        assert_eq!(plain.installation_key, None);
        let mut keyed = base;
        keyed["installationKey"] = json!("k".repeat(43));
        let keyed: Attachment = serde_json::from_value(keyed).unwrap();
        assert_eq!(keyed.installation_key.as_deref(), Some("k".repeat(43).as_str()));
        // A device saved by a runtime before this one is read back without a key, and saved without the field.
        let saved = json!({ "tokenHash": general_purpose::STANDARD.encode([7u8; 32]), "authority": "manage", "attachmentId": "att-1", "userId": "u-1" });
        let device: Device = serde_json::from_value(saved.clone()).unwrap();
        assert_eq!(device.installation_key, None);
        assert_eq!(serde_json::to_value(&device).unwrap(), saved);
    }

    #[test]
    fn token_identity_reads_the_cloud_runtime_claims() {
        let identity = token_identity(&jwt(json!({
            "sub": "cloud-runtime:ws-1", "cloudProfileId": "cloud-workspace:ws-1", "organizationId": "org-1", "runtimeGeneration": 7
        })))
        .unwrap();
        assert_eq!(identity.runtime_generation, 7);
        assert_eq!(identity.user_id, "cloud-runtime:ws-1");
        assert!(token_identity(&jwt(json!({ "sub": "x" }))).is_err());
        let legacy = token_identity(&jwt(json!({ "sub": "a", "cloudProfileId": "b", "organizationId": "c" }))).unwrap();
        assert_eq!(legacy.runtime_generation, 0);
    }

    /// PRO-341: a paired computer's relay connection closes with every
    /// other one when the runtime loses its credential, is fenced or loses
    /// the control connection (`close_all_connections`).
    #[tokio::test]
    async fn a_paired_computers_connection_closes_with_every_other() {
        struct Link;
        impl RuntimeLink for Link {
            fn host_secret(&self) -> [u8; 32] {
                [3; 32]
            }
            fn session(&self) -> Result<RelaySession> {
                bail!("not in this test")
            }
            fn complete_attachment(&self, _: &str, _: &str) -> Result<()> {
                Ok(())
            }
            fn complete_revocation(&self, _: &str) -> Result<()> {
                Ok(())
            }
        }
        struct Routes;
        impl MachineRoutes for Routes {
            fn is_computer(&self, relay_device_id: &str) -> bool {
                relay_device_id == "relay-desk"
            }
            fn admit_computer(&self, relay_device_id: &str, token: &str, client_key_b64: &str, _cancel: mpsc::UnboundedSender<()>) -> Result<Result<(String, u64), &'static str>> {
                Ok((relay_device_id == "relay-desk" && token == "desk-token" && client_key_b64 == "desk-key").then(|| ("desk".to_string(), 1)).ok_or("code-inactive"))
            }
            fn release_computer(&self, _: &str, _: u64) {}
            fn forward_phone(&self, _: crate::machine_wire::Forwarded, _: mpsc::UnboundedReceiver<()>) -> bool {
                false
            }
        }
        let root = tempfile::tempdir().unwrap();
        let rpc = WorkspaceRpc::new(root.path(), 1, Arc::new(crate::sink::BroadcastSink::new(8)), Arc::new(crate::pty::Terminals::new()), None).unwrap();
        let host = RelayHost::new(Arc::new(Link), rpc, None);
        host.set_routes(Arc::new(Routes));
        let (cancel, mut cancelled) = mpsc::unbounded_channel();
        let (device, computer) = host.admit("relay-desk", "desk-token", "desk-key", cancel).await.unwrap();
        assert_eq!(device.authority, Authority::Manage);
        assert_eq!(computer, Some(("desk".to_string(), 1)));
        let (refused, _) = mpsc::unbounded_channel();
        assert!(host.admit("relay-desk", "another-token", "desk-key", refused.clone()).await.is_err(), "another device's token");
        assert!(host.admit("relay-desk", "desk-token", "another-key", refused).await.is_err(), "its token from another key");
        host.close_all_connections();
        assert!(cancelled.try_recv().is_ok(), "the computer is closed out with the rest");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn phase2_collaboration_v2_refresh_attachment_route_fences_negotiation_generation_and_reconnect() {
        let client_key = general_purpose::STANDARD.encode([7u8; 32]);
        struct Link {
            session: Mutex<RelaySession>,
            completed: Mutex<Vec<String>>,
        }
        impl RuntimeLink for Link {
            fn host_secret(&self) -> [u8; 32] { [3; 32] }
            fn session(&self) -> Result<RelaySession> { Ok(self.session.lock().unwrap().clone()) }
            fn complete_attachment(&self, id: &str, _: &str) -> Result<()> {
                self.completed.lock().unwrap().push(id.into()); Ok(())
            }
            fn complete_revocation(&self, _: &str) -> Result<()> { Ok(()) }
        }
        let root = tempfile::tempdir().unwrap();
        let rpc = WorkspaceRpc::new(root.path(), 7, Arc::new(crate::sink::BroadcastSink::new(8)), Arc::new(crate::pty::Terminals::new()), None).unwrap();
        rpc.collab.runtime_policy.bind(root.path(), 7).unwrap();
        let response = |revision: &str, source: &str, capabilities: &str, generation: u64, suffix: &str| {
            let attachments = ["runtime", "session"].into_iter().map(|scope| json!({
                "id":format!("att-{scope}-{suffix}"), "deviceId":format!("dev-{scope}-{suffix}"),
                "deviceToken":"attachment-token-long-enough", "userId":"driver", "scope":scope, "expiresAt":now_ms()+60_000,
            })).collect();
            let session = crate::cloud_bootstrap::Session {
                workspace_id:"ws".into(), organization_id:"org".into(), relay_host_id:"host".into(),
                relay_token:jwt(json!({"sub":"host","cloudProfileId":"profile","organizationId":"org","runtimeGeneration":generation})),
                relay_token_expires_at:0, director_url:"http://127.0.0.1:1".into(),
                access_mode:crate::cloud_bootstrap::AccessMode::Private, attachments, revocations:vec![], quiesce:None, environment:None,
                collaboration:Some(json!({"v":2,"revision":revision,"members":[
                    {"userId":"driver","role":"driver","canApprove":true,"writeSource":source}
                ]})),
            };
            super::super::bootstrap_link::relay_session(&session, capabilities)
        };
        let link = Arc::new(Link { session:Mutex::new(response("1", "explicit", crate::cloud_bootstrap::CAPABILITIES, 7, "first")), completed:Mutex::new(vec![]) });
        let devices_path = root.path().join("devices.json");
        let host = RelayHost::new(link.clone(), rpc.clone(), Some(devices_path.clone()));
        let (commands, mut receive) = mpsc::unbounded_channel();
        let live = Live { commands, cell_url:"http://127.0.0.1:1".into(), assignment_epoch:1, relay_generation:1 };
        let invites = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = invites.clone();
        let relay = tokio::spawn(async move {
            while let Some(command) = receive.recv().await {
                if let ControlCommand::CreateInvite { respond, .. } = command {
                    count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let _ = respond.send(Ok(("invite".into(), now_ms()+60_000)));
                }
            }
        });
        // Actual link fetch and refresh application must reject unnegotiated
        // v2 before creating either kind of attachment, despite valid fields.
        assert!(host.apply_refreshed_session(&live, "http://127.0.0.1:1", host.fetch_session().await.unwrap(), 7).await.is_err());
        assert_eq!(invites.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(link.completed.lock().unwrap().is_empty());
        let mut unknown = response("1", "explicit", "collaboration-v2", 7, "unknown");
        unknown.collaboration.as_mut().unwrap()["v"] = json!(9);
        *link.session.lock().unwrap() = unknown;
        assert!(host.apply_refreshed_session(&live, "http://127.0.0.1:1", host.fetch_session().await.unwrap(), 7).await.is_err());
        assert_eq!(invites.load(std::sync::atomic::Ordering::SeqCst), 0);
        *link.session.lock().unwrap() = response("1", "explicit", "collaboration-v2", 7, "first");
        host.apply_refreshed_session(&live, "http://127.0.0.1:1", host.fetch_session().await.unwrap(), 7).await.unwrap();
        assert_eq!(link.completed.lock().unwrap().len(), 2);
        let mut cancellations = Vec::new();
        for scope in ["runtime", "session"] {
            let (cancel, cancelled) = mpsc::unbounded_channel();
            let (device, _) = host.admit(&format!("dev-{scope}-first"), "attachment-token-long-enough", &client_key, cancel).await.unwrap();
            assert_eq!(device.user_id.as_deref(), Some("driver"));
            cancellations.push(cancelled);
        }
        // Same role and approval, different DRIVE source. Old saved credentials
        // and observed connections of both scopes must be retired; new pending
        // attachments use the newly installed Everyone map.
        *link.session.lock().unwrap() = response("2", "everyone", "collaboration-v2", 7, "next");
        host.apply_refreshed_session(&live, "http://127.0.0.1:1", host.fetch_session().await.unwrap(), 7).await.unwrap();
        for mut cancelled in cancellations { assert!(cancelled.try_recv().is_ok()); }
        for scope in ["runtime", "session"] {
            let (cancel, _) = mpsc::unbounded_channel();
            assert!(host.admit(&format!("dev-{scope}-first"), "attachment-token-long-enough", &client_key, cancel).await.is_err());
        }
        let saved = std::fs::read_to_string(&devices_path).unwrap();
        assert!(!saved.contains("-first"));
        assert_eq!(link.completed.lock().unwrap().len(), 4);
        assert!(rpc.collab.runtime_policy.everyone("driver"));
        // A retired response cannot pair new devices or overwrite current access.
        *link.session.lock().unwrap() = response("3", "explicit", "collaboration-v2", 6, "stale");
        assert!(host.apply_refreshed_session(&live, "http://127.0.0.1:1", host.fetch_session().await.unwrap(), 7).await.is_err());
        assert_eq!(link.completed.lock().unwrap().len(), 4);
        assert!(rpc.collab.runtime_policy.everyone("driver"));
        // Pause a real invite request, retire its captured generation, then
        // complete it. Neither device insertion nor publishing may resurrect it.
        let (race_commands, mut race_receive) = mpsc::unbounded_channel();
        let race_live = Live { commands:race_commands, ..live.clone() };
        let pending_host = host.clone();
        let pending_session = response("3", "everyone", "collaboration-v2", 7, "raced");
        let pending = tokio::spawn(async move {
            pending_host.apply_refreshed_session(&race_live, "http://127.0.0.1:1", pending_session, 7).await
        });
        let command = tokio::time::timeout(Duration::from_secs(5), race_receive.recv()).await.unwrap().unwrap();
        let ControlCommand::CreateInvite { respond, .. } = command else { panic!("expected pending invite") };
        rpc.set_generation(8);
        respond.send(Ok(("late-invite".into(), now_ms()+60_000))).unwrap();
        pending.await.unwrap().unwrap();
        assert_eq!(link.completed.lock().unwrap().len(), 4);
        let (cancel, _) = mpsc::unbounded_channel();
        assert!(host.admit("dev-runtime-raced", "attachment-token-long-enough", &client_key, cancel).await.is_err());
        relay.abort();
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn phase2_collaboration_v2_rejected_refresh_still_retires_independent_revocations() {
        let client_key = general_purpose::STANDARD.encode([7u8; 32]);
        use std::sync::atomic::Ordering;

        struct Link {
            session: Mutex<RelaySession>,
            paired: Mutex<Vec<String>>,
            revoked: Mutex<Vec<String>>,
        }
        impl RuntimeLink for Link {
            fn host_secret(&self) -> [u8; 32] { [3; 32] }
            fn session(&self) -> Result<RelaySession> { Ok(self.session.lock().unwrap().clone()) }
            fn complete_attachment(&self, id: &str, _: &str) -> Result<()> {
                self.paired.lock().unwrap().push(id.into()); Ok(())
            }
            fn complete_revocation(&self, id: &str) -> Result<()> {
                self.revoked.lock().unwrap().push(id.into()); Ok(())
            }
        }
        let member = json!({"userId":"driver", "role":"driver", "canApprove":true, "writeSource":"explicit"});
        for (policy, negotiated) in [
            (json!({"v":2, "revision":"01", "members":[member.clone()]}), true),
            (json!({"v":9, "revision":"2", "members":[member.clone()]}), true),
            (json!({"v":2, "revision":"2", "members":[member.clone()]}), false),
            (json!({"v":1, "members":"malformed"}), false),
        ] {
            let root = tempfile::tempdir().unwrap();
            let rpc = WorkspaceRpc::new(root.path(), 7, Arc::new(crate::sink::BroadcastSink::new(8)), Arc::new(crate::pty::Terminals::new()), None).unwrap();
            rpc.collab.runtime_policy.bind(root.path(), 7).unwrap();
            let attachments = |suffix: &str| ["runtime", "session"].into_iter().map(|scope| {
                serde_json::from_value::<Attachment>(json!({
                    "id":format!("att-{scope}-{suffix}"), "deviceId":format!("dev-{scope}-{suffix}"),
                    "deviceToken":"attachment-token-long-enough", "userId":"driver", "scope":scope, "expiresAt":now_ms()+60_000,
                })).unwrap()
            }).collect();
            let initial = RelaySession {
                relay_token:jwt(json!({"sub":"host", "cloudProfileId":"profile", "organizationId":"org", "runtimeGeneration":7})),
                director_url:"http://127.0.0.1:1".into(), attachments:attachments("old"), revocations:vec![],
                collaboration:Some(json!({"v":2, "revision":"1", "members":[member.clone()]})), collaboration_v2:true,
            };
            let link = Arc::new(Link { session:Mutex::new(initial), paired:Mutex::new(vec![]), revoked:Mutex::new(vec![]) });
            let devices_path = root.path().join("devices.json");
            let host = RelayHost::new(link.clone(), rpc.clone(), Some(devices_path.clone()));
            let (commands, mut receive) = mpsc::unbounded_channel();
            let live = Live { commands, cell_url:"http://127.0.0.1:1".into(), assignment_epoch:1, relay_generation:1 };
            let invites = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let count = invites.clone();
            let relay = tokio::spawn(async move {
                while let Some(command) = receive.recv().await {
                    if let ControlCommand::CreateInvite { respond, .. } = command {
                        count.fetch_add(1, Ordering::SeqCst);
                        let _ = respond.send(Ok(("invite".into(), now_ms()+60_000)));
                    }
                }
            });
            host.apply_refreshed_session(&live, "http://127.0.0.1:1", host.fetch_session().await.unwrap(), 7).await.unwrap();
            let mut cancellations = Vec::new();
            for scope in ["runtime", "session"] {
                let (cancel, cancelled) = mpsc::unbounded_channel();
                host.admit(&format!("dev-{scope}-old"), "attachment-token-long-enough", &client_key, cancel).await.unwrap();
                cancellations.push(cancelled);
            }
            {
                let mut session = link.session.lock().unwrap();
                session.collaboration = Some(policy.clone());
                session.collaboration_v2 = negotiated;
                session.attachments = attachments("pending");
                session.revocations = ["runtime", "session"].into_iter().map(|scope| Revocation {
                    id:format!("att-{scope}-old"), device_id:format!("dev-{scope}-old"),
                }).collect();
            }
            assert!(host.apply_refreshed_session(&live, "http://127.0.0.1:1", host.fetch_session().await.unwrap(), 7).await.is_err(), "policy must be refused: {policy}");
            for mut cancelled in cancellations { assert!(cancelled.try_recv().is_ok(), "revoked connection survives rejected policy: {policy}"); }
            assert_eq!(link.revoked.lock().unwrap().len(), 2, "durable revocations must be acknowledged: {policy}");
            assert_eq!(link.paired.lock().unwrap().len(), 2, "rejected policy must not publish new attachments: {policy}");
            assert_eq!(invites.load(Ordering::SeqCst), 2);
            assert!(!std::fs::read_to_string(&devices_path).unwrap().contains("-old"));
            let restored = RelayHost::new(link.clone(), rpc.clone(), Some(devices_path));
            for scope in ["runtime", "session"] {
                for runtime in [&host, &restored] {
                    let (cancel, _) = mpsc::unbounded_channel();
                    assert!(runtime.admit(&format!("dev-{scope}-old"), "attachment-token-long-enough", &client_key, cancel).await.is_err(), "revoked token reconnects after rejected policy: {policy}");
                }
            }
            relay.abort();
        }
    }

    /// A link for tests that never asks the API.
    struct NoLink;
    impl RuntimeLink for NoLink {
        fn host_secret(&self) -> [u8; 32] {
            [3; 32]
        }
        fn session(&self) -> Result<RelaySession> {
            bail!("not in this test")
        }
        fn complete_attachment(&self, _: &str, _: &str) -> Result<()> {
            Ok(())
        }
        fn complete_revocation(&self, _: &str) -> Result<()> {
            Ok(())
        }
    }

    /// PRO-368: the window's relay requests go out on the runtime's control
    /// connection, and each reply goes back to the request with its `reqId`,
    /// `control-error` included; other requests' replies do not.
    #[tokio::test]
    async fn a_forwarded_request_gets_the_relays_reply_to_its_id() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/v1/host/control", listener.local_addr().unwrap());
        let (sent, mut relay_saw) = mpsc::unbounded_channel::<Value>();
        let relay = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let frame: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            sent.send(frame.clone()).unwrap();
            // Another request's reply first: it is not this one's answer.
            socket.send(Message::Text(json!({ "type": "control-error", "reqId": "req-other", "code": "invalid" }).to_string().into())).await.unwrap();
            socket.send(Message::Text(json!({ "type": "invite-created", "reqId": frame["reqId"], "inviteToken": "t", "expiresAt": 1, "maxAttempts": 3 }).to_string().into())).await.unwrap();
            let revoke: Value = serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
            sent.send(revoke.clone()).unwrap();
            socket.send(Message::Text(json!({ "type": "control-error", "reqId": revoke["reqId"], "code": "not_found" }).to_string().into())).await.unwrap();
            // Held open until the test ends.
            let _ = socket.next().await;
        });
        let (mut socket, _) = crate::data_privacy::connect(url.as_str(), None, true).await.unwrap();
        let root = tempfile::tempdir().unwrap();
        let rpc = WorkspaceRpc::new(root.path(), 1, Arc::new(crate::sink::BroadcastSink::new(8)), Arc::new(crate::pty::Terminals::new()), None).unwrap();
        let host = RelayHost::new(Arc::new(NoLink), rpc, None);
        assert!(host.forward_control(json!({ "type": "invite-create", "reqId": "req-1" })).is_err(), "offline before it registers");
        let (commands, mut command_rx) = mpsc::unbounded_channel();
        let live = Live { commands, cell_url: "ws://cell".into(), assignment_epoch: 1, relay_generation: 1 };
        *host.registered.lock().unwrap() = Some((live.clone(), "http://director".into()));
        // Only the window's control requests, each with its own id.
        assert!(host.forward_control(json!({ "type": "conn-accept", "reqId": "req-1" })).is_err());
        assert!(host.forward_control(json!({ "type": "invite-create" })).is_err());
        let invite = host.forward_control(json!({ "type": "invite-create", "reqId": "req-1", "relayDeviceId": "phone-1" })).unwrap();
        let duplicate = host.forward_control(json!({ "type": "invite-create", "reqId": "req-1", "relayDeviceId": "phone-2" })).unwrap();
        let control = host.clone();
        let running = tokio::spawn(async move { control.control_loop(&mut socket, &mut command_rx, &live).await });
        let wait = |receive: std::sync::mpsc::Receiver<Result<Value>>| tokio::task::spawn_blocking(move || receive.recv_timeout(Duration::from_secs(10)).unwrap());
        assert!(wait(duplicate).await.unwrap().is_err(), "a second request with a pending id is refused");
        let frame = relay_saw.recv().await.unwrap();
        assert_eq!(frame["relayDeviceId"], "phone-1");
        let reply = wait(invite).await.unwrap().unwrap();
        assert_eq!((reply["type"].as_str(), reply["reqId"].as_str()), (Some("invite-created"), Some("req-1")));
        let revoke = host.forward_control(json!({ "type": "device-revoke", "reqId": "req-2", "relayDeviceId": "phone-1" })).unwrap();
        assert_eq!(relay_saw.recv().await.unwrap()["type"], "device-revoke");
        let reply = wait(revoke).await.unwrap().unwrap();
        assert_eq!((reply["type"].as_str(), reply["code"].as_str()), (Some("control-error"), Some("not_found")));
        running.abort();
        relay.abort();
    }

    #[test]
    fn unanswered_forwarded_requests_are_forgotten() {
        let sent = Instant::now();
        let mut forwarded = Forwarded::new();
        let (respond, _receive) = std::sync::mpsc::channel();
        forwarded.insert("req-1".into(), (respond, sent));
        forget_unanswered(&mut forwarded, sent + Duration::from_secs(5));
        assert!(forwarded.contains_key("req-1"), "still waiting for the relay");
        forget_unanswered(&mut forwarded, sent + FORWARDED_TTL);
        assert!(forwarded.is_empty(), "nobody waits for it after the window gave up");
    }

    #[test]
    fn plaintext_relay_is_loopback_only() {
        assert_eq!(websocket_url("http://127.0.0.1:4000", "/v1/host/control").unwrap(), "ws://127.0.0.1:4000/v1/host/control");
        assert_eq!(websocket_url("https://relay.example", "/v1/connect/abc").unwrap(), "wss://relay.example/v1/connect/abc");
        assert!(websocket_url("http://relay.example", "/v1/host/control").is_err());
    }

    #[test]
    fn file_link_rereads_attachments_and_publishes_pairing_codes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("link.json");
        let write = |attachments: Value| {
            std::fs::write(
                &path,
                json!({ "v": 1, "hostSecretB64": general_purpose::STANDARD.encode([7u8; 32]), "relayToken": "t", "directorUrl": "http://127.0.0.1:1", "attachments": attachments }).to_string(),
            )
            .unwrap()
        };
        write(json!([]));
        let link = FileLink::open(&path).unwrap();
        assert_eq!(link.host_secret(), [7u8; 32]);
        assert!(link.session().unwrap().attachments.is_empty());
        write(json!([{ "id": "att-1", "deviceId": "dev-1", "deviceToken": "token-token-token-token", "scope": "runtime", "expiresAt": 1 }]));
        assert_eq!(link.session().unwrap().attachments[0].device_id, "dev-1");
        link.complete_attachment("att-1", "code").unwrap();
        assert_eq!(std::fs::read_to_string(FileLink::pairing_dir(&path).join("att-1.pairing")).unwrap(), "code");
        assert!(link.complete_attachment("../x", "code").is_err());
    }
}
