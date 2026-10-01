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
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose, Engine as _};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, protocol::WebSocketConfig, Message};

use super::collab::Members;
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
/// Answered from their own task (see `serve_connection`).
const SLOW_METHODS: &[&str] = &[
    "git.push",
    "git.pull",
    "git.fetch",
    "git.commit",
    "git.checkout",
    "git.repositories",
    "git.status",
    "git.workingChanges",
    "git.changesBetween",
    "git.fileContents",
    "git.log",
    "git.branches",
    "git.prs",
    "git.prCreate",
    "git.prReady",
    "git.prMerge",
    "lifecycle.dispositionFacts",
    "session.create",
    "session.send",
    "session.close",
    // CS-12: removing a worktree, and the first read of Codex's model list.
    "session.delete",
    "runtime.agents",
    "fs.search",
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
    pub collaboration: Option<Members>,
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
    collaboration: Option<Members>,
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
    #[serde(with = "hash_b64")]
    token_hash: [u8; 32],
    authority: Authority,
    attachment_id: String,
    /// The attachment's person, for roles, presence and attribution.
    #[serde(default)]
    user_id: Option<String>,
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
        Arc::new(Self { link, rpc, keypair, state: Mutex::new(state), status, devices_path })
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

    pub fn status(&self) -> tokio::sync::watch::Receiver<HostStatus> {
        self.status.subscribe()
    }

    /// Register, serve and re-register forever. Only a 4101 fence stops it,
    /// until the link hands over a newer generation.
    pub async fn run(self: Arc<Self>) {
        let mut attempt = 0u32;
        let mut fenced: Option<u64> = None;
        loop {
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
                    tokio::time::sleep(protocol::backoff(attempt, jitter())).await;
                    continue;
                }
            };
            let identity = match token_identity(&session.relay_token) {
                Ok(identity) => identity,
                Err(error) => {
                    log::error!("relay host: {error:#}");
                    tokio::time::sleep(REFRESH_INTERVAL).await;
                    continue;
                }
            };
            if fenced.is_some_and(|generation| identity.runtime_generation <= generation) {
                tokio::time::sleep(REFRESH_INTERVAL).await;
                continue;
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
            self.status.send_replace(HostStatus::Retrying { attempt });
            tokio::time::sleep(protocol::backoff(attempt, jitter())).await;
        }
    }

    async fn revoked(&self) {
        log::warn!("relay host: the runtime credential was rejected; not serving");
        self.status.send_replace(HostStatus::Revoked);
        self.close_all_connections();
        tokio::time::sleep(REFRESH_INTERVAL).await;
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
        self.rpc.set_collaboration(session.collaboration.clone());
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
        let result = self.control_loop(&mut socket, &mut command_rx, &live).await;
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
            tokio_tungstenite::connect_async_with_config(request, Some(websocket_config()), false),
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
        loop {
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
                        ControlCommand::InstallCredential { payload, req_id, respond } => {
                            if installs.contains_key(&req_id) {
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
                    self.rpc.set_collaboration(session.collaboration.clone());
                    if self.apply_revocations(&live, &session.revocations) {
                        self.complete_revocations(&session.revocations).await;
                    }
                    for attachment in session.attachments {
                        if let Err(error) = self.answer_attachment(&live, &director_url, attachment).await {
                            log::warn!("relay host: could not answer an attachment: {error:#}");
                        }
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
    fn apply_revocations(&self, live: &Live, revocations: &[Revocation]) -> bool {
        let mut state = self.state.lock().unwrap();
        let mut changed = false;
        for revocation in revocations {
            if state.devices.remove(&revocation.device_id).is_some() {
                changed = true;
                let _ = live.commands.send(ControlCommand::Revoke { device_id: revocation.device_id.clone() });
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
            let mut state = self.state.lock().unwrap();
            state.devices.insert(
                attachment.device_id.clone(),
                Device {
                    token_hash: Sha256::digest(attachment.device_token.as_bytes()).into(),
                    authority,
                    attachment_id: attachment.id.clone(),
                    user_id: attachment.user_id.clone(),
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
            tokio_tungstenite::connect_async_with_config(request, Some(websocket_config()), false),
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
        let device = self.admit(&connection.relay_device_id, token, cancel_tx)?;
        // Counts as use of the workspace for as long as it stays open.
        let _attached = crate::cloud_activity::attached();
        let authenticated = json!({ "type": "e2ee_authenticated", "v": 2, "transcriptHashB64": session.transcript_hash_b64 });
        send_sealed(&mut socket, &mut session, &authenticated).await?;

        let (peer, mut notifications) = Peer::for_user(connection.relay_device_id.clone(), device.authority, device.user_id.clone());
        // Slow mutations (Git network calls, agent prompts) answer from their
        // own task, so this connection keeps reading, streaming and honouring
        // a revocation meanwhile. Everything else is answered in order, which
        // keeps terminal writes ordered.
        let (answers_tx, mut answers) = mpsc::unbounded_channel::<Value>();
        log::info!("relay host: attachment {} connected ({:?})", device.attachment_id, device.authority);
        let result = async {
            loop {
                tokio::select! {
                    _ = cancel.recv() => {
                        let _ = socket.close(None).await;
                        return Ok(());
                    }
                    // The person lost access to the workspace (contract §21.5).
                    _ = peer.closed() => {
                        let _ = socket.close(None).await;
                        return Ok(());
                    }
                    notification = notifications.recv() => {
                        let Some(notification) = notification else { return Ok(()) };
                        send_sealed(&mut socket, &mut session, &notification).await?;
                    }
                    answer = answers.recv() => {
                        if let Some(answer) = answer {
                            send_sealed(&mut socket, &mut session, &answer).await?;
                        }
                    }
                    incoming = socket.next() => {
                        let Some(incoming) = incoming else { return Ok(()) };
                        match incoming? {
                            Message::Text(text) => {
                                if text.len() > MAX_FRAME_BYTES * 2 {
                                    bail!("client frame over the limit");
                                }
                                let plaintext = session.open(&general_purpose::STANDARD.decode(text.as_bytes())?, PayloadKind::Text)?;
                                let request: Value = serde_json::from_slice(&plaintext)?;
                                let response = match request["method"].as_str() {
                                    Some("pairing.provisionRelay") => self.provision_resume(&live, &connection, &request).await,
                                    Some(method) if SLOW_METHODS.contains(&method) => {
                                        let rpc = self.rpc.clone();
                                        let peer = peer.clone();
                                        let answers = answers_tx.clone();
                                        tokio::spawn(async move {
                                            let _ = answers.send(rpc.handle(&peer, &request).await);
                                        });
                                        continue;
                                    }
                                    _ => self.rpc.handle(&peer, &request).await,
                                };
                                send_sealed(&mut socket, &mut session, &response).await?;
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
        self.rpc.disconnect(&peer);
        drop(cancel);
        if let Some(senders) = self.state.lock().unwrap().connections.get_mut(&connection.relay_device_id) {
            senders.retain(|sender| !sender.is_closed());
        }
        result
    }

    fn admit(&self, relay_device_id: &str, token: &str, cancel: mpsc::UnboundedSender<()>) -> Result<Device> {
        let hash: [u8; 32] = Sha256::digest(token.as_bytes()).into();
        let mut state = self.state.lock().unwrap();
        // The relay credential named the device; the token must be that
        // device's, so an invite cannot be used with another attachment's token.
        let device = state.devices.get(relay_device_id).ok_or_else(|| anyhow!("device is not attached"))?.clone();
        if !bool::from(device.token_hash.ct_eq(&hash)) {
            bail!("device token refused");
        }
        let senders = state.connections.entry(relay_device_id.to_string()).or_default();
        senders.retain(|sender| !sender.is_closed());
        senders.push(cancel);
        Ok(device)
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionOpen {
    conn_id: String,
    conn_ticket: String,
    kind: String,
    relay_device_id: String,
    attach_deadline_ms: u64,
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn assign(director_url: &str, relay_token: &str, relay_host_id: &str) -> Result<(String, u64)> {
    let url = format!("{}/v1/assign", director_url.trim_end_matches('/'));
    let token = relay_token.to_string();
    let host = relay_host_id.to_string();
    let response: Value = tokio::task::spawn_blocking(move || -> Result<Value> {
        let response = ureq::post(&url)
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

async fn send_sealed(socket: &mut Socket, session: &mut E2eeSession, value: &Value) -> Result<()> {
    let frame = session.seal(value.to_string().as_bytes(), PayloadKind::Text)?;
    socket.send(Message::Text(general_purpose::STANDARD.encode(frame).into())).await?;
    Ok(())
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
