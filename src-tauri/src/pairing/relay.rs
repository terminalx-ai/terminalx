use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, http::HeaderValue, Message,
};

use crate::account::AccountContext;

use super::cloud::{self, RelayAssignment};
use super::crypto::{answer_relay_challenge, HostKeypair, RelayProofContext};
use super::model::RelayPairingOffer;
use super::{pairing_websocket_config, PairingManager};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const SILENCE_TIMEOUT: Duration = Duration::from_secs(90);
const BACKOFF_MS: [u64; 8] = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000];

#[derive(Clone)]
pub struct RelayLive {
    tx: mpsc::UnboundedSender<ControlCommand>,
    pub cell_url: String,
    pub assignment_epoch: u64,
    pub relay_host_id: String,
    pub generation: u64,
}

impl RelayLive {
    pub async fn create_invite(&self, device_id: String) -> Result<RelayPairingOffer> {
        let (send, receive) = oneshot::channel();
        self.tx
            .send(ControlCommand::CreateInvite {
                device_id,
                respond: send,
            })
            .map_err(|_| anyhow!("relay control is offline"))?;
        let invite = tokio::time::timeout(CONNECT_TIMEOUT, receive)
            .await
            .map_err(|_| anyhow!("relay invite timed out"))?
            .map_err(|_| anyhow!("relay control closed before creating the invite"))??;
        Ok(RelayPairingOffer {
            v: 1,
            director_url: cloud::RELAY_DIRECTOR_URL.into(),
            cell_url: self.cell_url.clone(),
            assignment_epoch: self.assignment_epoch,
            relay_host_id: self.relay_host_id.clone(),
            invite_token: invite.invite_token,
            invite_expires_at: invite.expires_at,
            e2ee_framing: 2,
        })
    }

    pub fn revoke(&self, device_id: String) {
        let _ = self.tx.send(ControlCommand::Revoke { device_id });
    }

    pub async fn install_credential(
        &self,
        req_id: String,
        relay_device_id: String,
        new_resume_token_hash: String,
        expected_current_hash: Option<String>,
        authorization: DeviceCredentialInstallAuthorization,
    ) -> Result<CredentialInstalled> {
        let (send, receive) = oneshot::channel();
        self.tx
            .send(ControlCommand::InstallCredential {
                req_id,
                relay_device_id,
                new_resume_token_hash,
                expected_current_hash,
                authorization,
                respond: send,
            })
            .map_err(|_| anyhow!("relay control is offline"))?;
        wait_for_control(receive, "relay credential install").await
    }

    pub async fn credential_install_status(
        &self,
        req_id: String,
        relay_device_id: String,
    ) -> Result<CredentialInstallStatus> {
        let (send, receive) = oneshot::channel();
        self.tx
            .send(ControlCommand::CredentialInstallStatus {
                req_id,
                relay_device_id,
                respond: send,
            })
            .map_err(|_| anyhow!("relay control is offline"))?;
        wait_for_control(receive, "relay credential install status").await
    }

    pub async fn confirm_resume(
        &self,
        req_id: String,
        basis_conn_id: String,
    ) -> Result<ResumeConfirmed> {
        let (send, receive) = oneshot::channel();
        self.tx
            .send(ControlCommand::ConfirmResume {
                req_id,
                basis_conn_id,
                respond: send,
            })
            .map_err(|_| anyhow!("relay control is offline"))?;
        wait_for_control(receive, "relay resume confirmation").await
    }

    pub fn shutdown(&self) {
        let _ = self.tx.send(ControlCommand::Shutdown);
    }
}

enum ControlCommand {
    CreateInvite {
        device_id: String,
        respond: oneshot::Sender<Result<InviteCreated>>,
    },
    Revoke {
        device_id: String,
    },
    InstallCredential {
        req_id: String,
        relay_device_id: String,
        new_resume_token_hash: String,
        expected_current_hash: Option<String>,
        authorization: DeviceCredentialInstallAuthorization,
        respond: oneshot::Sender<Result<CredentialInstalled>>,
    },
    CredentialInstallStatus {
        req_id: String,
        relay_device_id: String,
        respond: oneshot::Sender<Result<CredentialInstallStatus>>,
    },
    ConfirmResume {
        req_id: String,
        basis_conn_id: String,
        respond: oneshot::Sender<Result<ResumeConfirmed>>,
    },
    Shutdown,
}

async fn wait_for_control<T>(receive: oneshot::Receiver<Result<T>>, operation: &str) -> Result<T> {
    tokio::time::timeout(CONNECT_TIMEOUT, receive)
        .await
        .map_err(|_| anyhow!("{operation} timed out"))?
        .map_err(|_| anyhow!("relay control closed during {operation}"))?
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "mode",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum DeviceCredentialInstallAuthorization {
    RelayBasis { basis_conn_id: String },
    AuthenticatedDirect { direct_auth_id: String },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CredentialInstalled {
    #[serde(default, rename = "type", skip_serializing)]
    kind: Option<String>,
    pub v: u8,
    pub req_id: String,
    pub authorization_mode: String,
    pub current_version: u64,
    pub resume_expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grace_expires_at: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CredentialInstallStatus {
    #[serde(rename = "type", skip_serializing)]
    kind: String,
    pub v: u8,
    pub req_id: String,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<CredentialInstalled>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResumeConfirmed {
    #[serde(rename = "type", skip_serializing)]
    kind: String,
    pub v: u8,
    pub req_id: String,
    pub current_version: u64,
    pub accepted_as: String,
    pub renewed: bool,
    pub resume_expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grace_expires_at: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ControlError {
    #[serde(rename = "type")]
    kind: String,
    req_id: Option<String>,
    code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostChallenge {
    #[serde(rename = "type")]
    kind: String,
    challenge_id: String,
    relay_ephemeral_public_key_b64: String,
    nonce_b64: String,
    ciphertext_b64: String,
    expires_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostHelloAck {
    #[serde(rename = "type")]
    kind: String,
    v: u8,
    generation: u64,
    control_resume_secret: String,
    lease_expires_at: i64,
    active_conn_ids: Vec<String>,
    pending_conns: Vec<PendingConnection>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PendingConnection {
    conn_id: String,
    conn_ticket: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ConnectionOpen {
    #[serde(rename = "type")]
    kind_name: String,
    pub conn_id: String,
    pub conn_ticket: String,
    pub kind: String,
    pub relay_device_id: String,
    attach_deadline_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InviteCreated {
    #[serde(rename = "type")]
    kind: String,
    req_id: String,
    invite_token: String,
    expires_at: i64,
    max_attempts: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeviceRevoked {
    #[serde(rename = "type")]
    kind: String,
    req_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ping {
    #[serde(rename = "type")]
    kind: String,
    t: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostHello<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    v: u8,
    relay_host_id: &'a str,
    assignment_epoch: u64,
    host_public_key_b64: String,
    app_version: &'static str,
}

pub async fn supervise(manager: Arc<PairingManager>) {
    let mut attempts = 0u32;
    loop {
        if manager.is_stopped() {
            return;
        }
        let Some(context) = manager.account_context() else {
            attempts = 0;
            manager.set_relay_off();
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        };
        if !manager.relay_permitted(&context) {
            attempts = 0;
            manager.set_relay_off();
            tokio::time::sleep(Duration::from_secs(2)).await;
            continue;
        }
        if !context.relay_entitled {
            manager.set_relay_unavailable("Relay is unavailable for this account.", attempts);
            tokio::time::sleep(Duration::from_secs(30)).await;
            continue;
        }
        attempts = attempts.saturating_add(1);
        manager.set_relay_connecting(attempts);
        match connect_once(manager.clone(), context, attempts > 1).await {
            Ok(()) => {
                attempts = 0;
            }
            Err(error) => {
                log::warn!("relay connection ended: {error:#}");
                manager.clear_relay();
                manager.set_relay_unavailable(reconnect_message(attempts), attempts);
            }
        }
        if manager.is_stopped() {
            return;
        }
        tokio::time::sleep(backoff(attempts)).await;
    }
}

fn backoff(attempt: u32) -> Duration {
    if attempt >= 12 {
        return Duration::from_secs(90);
    }
    let index = attempt.saturating_sub(1) as usize;
    Duration::from_millis(BACKOFF_MS[index.min(BACKOFF_MS.len() - 1)])
}

fn reconnect_message(attempt: u32) -> &'static str {
    if attempt >= 12 {
        "Unreachable — re-pair?"
    } else if attempt >= 3 {
        "Can’t connect"
    } else {
        "Relay offline"
    }
}

async fn connect_once(
    manager: Arc<PairingManager>,
    context: AccountContext,
    reconnect: bool,
) -> Result<()> {
    let keypair = manager.host_key(true)?;
    let relay_host_id = keypair.host_id();
    let public_key_b64 = keypair.public_key_b64();
    let context_for_http = context.clone();
    let authorization = tokio::task::spawn_blocking(move || {
        cloud::relay_authorization(&context_for_http, &relay_host_id, &public_key_b64)
    })
    .await??;
    if authorization.expires_at <= now_ms() {
        bail!("relay authorization expired before use");
    }
    let relay_host_id = keypair.host_id();
    let relay_jwt = authorization.relay_token.clone();
    let assignment = tokio::task::spawn_blocking({
        let relay_host_id = relay_host_id.clone();
        move || cloud::relay_assignment(&authorization, &relay_host_id, reconnect)
    })
    .await??;
    let (socket, ack) = open_control(&context, &keypair, &assignment, &relay_jwt).await?;
    let (tx, rx) = mpsc::unbounded_channel();
    let live = RelayLive {
        tx,
        cell_url: assignment.cell_url.clone(),
        assignment_epoch: assignment.assignment_epoch,
        relay_host_id: keypair.host_id(),
        generation: ack.generation,
    };
    manager.set_relay_connected(live.clone());
    manager.relay_ready(context.clone(), live.clone()).await;
    control_loop(manager, socket, rx, live, context, keypair).await
}

type ControlSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn open_control(
    context: &AccountContext,
    keypair: &HostKeypair,
    assignment: &RelayAssignment,
    relay_jwt: &str,
) -> Result<(ControlSocket, HostHelloAck)> {
    let url = websocket_url(&assignment.cell_url, "/v1/host/control")?;
    let mut request = url.into_client_request()?;
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&format!("Bearer {relay_jwt}"))?,
    );
    let (mut socket, _) = tokio::time::timeout(
        CONNECT_TIMEOUT,
        tokio_tungstenite::connect_async_with_config(
            request,
            Some(pairing_websocket_config()),
            false,
        ),
    )
    .await
    .map_err(|_| anyhow!("relay control connection timed out"))??;
    socket
        .send(Message::Text(
            serde_json::to_string(&HostHello {
                kind: "host-hello",
                v: 1,
                relay_host_id: &keypair.host_id(),
                assignment_epoch: assignment.assignment_epoch,
                host_public_key_b64: keypair.public_key_b64(),
                app_version: env!("CARGO_PKG_VERSION"),
            })?
            .into(),
        ))
        .await?;
    let challenge_value = next_control_json(&mut socket).await?;
    let challenge: HostChallenge = serde_json::from_value(challenge_value)
        .context("relay returned an invalid host challenge")?;
    if challenge.kind != "host-challenge"
        || !valid_opaque_id(&challenge.challenge_id)
        || challenge.ciphertext_b64.is_empty()
        || challenge.ciphertext_b64.len() > 16 * 1024
        || challenge.expires_at < 0
    {
        bail!("relay did not challenge the host key");
    }
    let proof = answer_relay_challenge(
        keypair,
        &challenge.challenge_id,
        &challenge.relay_ephemeral_public_key_b64,
        &challenge.nonce_b64,
        &challenge.ciphertext_b64,
        challenge.expires_at,
        &RelayProofContext {
            relay_origin: &assignment.cell_url,
            user_id: &context.user_id,
            profile_id: &context.profile_id,
            organization_id: &context.organization_id,
            relay_host_id: &keypair.host_id(),
            assignment_epoch: assignment.assignment_epoch,
            previous_generation: None,
            resume_requested: false,
            now_ms: now_ms(),
        },
    )?;
    socket
        .send(Message::Text(
            serde_json::to_string(&serde_json::json!({
                "type": "host-challenge-ack",
                "challengeId": challenge.challenge_id,
                "proofB64": proof,
            }))?
            .into(),
        ))
        .await?;
    let ack: HostHelloAck = serde_json::from_value(next_control_json(&mut socket).await?)
        .context("relay returned an invalid host acknowledgement")?;
    if ack.kind != "host-hello-ack"
        || ack.v != 1
        || ack.generation == 0
        || !valid_base64url_32(&ack.control_resume_secret)
        || ack.lease_expires_at <= now_ms()
        || ack.active_conn_ids.len() > 8
        || ack.pending_conns.len() > 8
    {
        bail!("relay returned an invalid host acknowledgement");
    }
    for pending in &ack.pending_conns {
        if !valid_opaque_id(&pending.conn_id) || !valid_base64url_32(&pending.conn_ticket) {
            bail!("relay returned an invalid pending connection");
        }
    }
    Ok((socket, ack))
}

async fn next_control_json(socket: &mut ControlSocket) -> Result<serde_json::Value> {
    let message = tokio::time::timeout(CONNECT_TIMEOUT, socket.next())
        .await
        .map_err(|_| anyhow!("relay proof timed out"))?
        .ok_or_else(|| anyhow!("relay closed during host proof"))??;
    match message {
        Message::Text(text) => serde_json::from_str(&text).context("decode relay control message"),
        _ => bail!("relay sent a non-text control message"),
    }
}

async fn control_loop(
    manager: Arc<PairingManager>,
    mut socket: ControlSocket,
    mut commands: mpsc::UnboundedReceiver<ControlCommand>,
    live: RelayLive,
    context: AccountContext,
    keypair: HostKeypair,
) -> Result<()> {
    let mut pending_invites = HashMap::<String, oneshot::Sender<Result<InviteCreated>>>::new();
    let mut pending_revokes = HashMap::<String, String>::new();
    let mut pending_installs =
        HashMap::<String, oneshot::Sender<Result<CredentialInstalled>>>::new();
    let mut pending_install_status =
        HashMap::<String, oneshot::Sender<Result<CredentialInstallStatus>>>::new();
    let mut pending_resume_confirm =
        HashMap::<String, oneshot::Sender<Result<ResumeConfirmed>>>::new();
    loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(ControlCommand::CreateInvite { device_id, respond }) => {
                    let req_id = uuid::Uuid::new_v4().simple().to_string();
                    socket.send(Message::Text(serde_json::to_string(&serde_json::json!({
                        "type": "invite-create", "reqId": req_id, "relayDeviceId": device_id,
                    }))?.into())).await?;
                    pending_invites.insert(req_id, respond);
                }
                Some(ControlCommand::Revoke { device_id }) => {
                    let req_id = uuid::Uuid::new_v4().simple().to_string();
                    socket.send(Message::Text(serde_json::to_string(&serde_json::json!({
                        "type": "device-revoke", "reqId": req_id, "relayDeviceId": device_id,
                    }))?.into())).await?;
                    pending_revokes.insert(req_id, device_id);
                }
                Some(ControlCommand::InstallCredential { req_id, relay_device_id, new_resume_token_hash, expected_current_hash, authorization, respond }) => {
                    if request_is_pending(&req_id, &pending_invites, &pending_revokes, &pending_installs, &pending_install_status, &pending_resume_confirm) {
                        let _ = respond.send(Err(anyhow!("duplicate relay request id")));
                        continue;
                    }
                    let mut payload = serde_json::json!({
                        "type": "device-credential-install",
                        "v": 1,
                        "reqId": req_id,
                        "relayDeviceId": relay_device_id,
                        "newResumeTokenHash": new_resume_token_hash,
                        "authorization": authorization,
                    });
                    if let Some(expected) = expected_current_hash {
                        payload["expectedCurrentHash"] = serde_json::Value::String(expected);
                    }
                    socket.send(Message::Text(serde_json::to_string(&payload)?.into())).await?;
                    pending_installs.insert(req_id, respond);
                }
                Some(ControlCommand::CredentialInstallStatus { req_id, relay_device_id, respond }) => {
                    if request_is_pending(&req_id, &pending_invites, &pending_revokes, &pending_installs, &pending_install_status, &pending_resume_confirm) {
                        let _ = respond.send(Err(anyhow!("duplicate relay request id")));
                        continue;
                    }
                    socket.send(Message::Text(serde_json::to_string(&serde_json::json!({
                        "type": "device-credential-install-status", "v": 1, "reqId": req_id, "relayDeviceId": relay_device_id,
                    }))?.into())).await?;
                    pending_install_status.insert(req_id, respond);
                }
                Some(ControlCommand::ConfirmResume { req_id, basis_conn_id, respond }) => {
                    if request_is_pending(&req_id, &pending_invites, &pending_revokes, &pending_installs, &pending_install_status, &pending_resume_confirm) {
                        let _ = respond.send(Err(anyhow!("duplicate relay request id")));
                        continue;
                    }
                    socket.send(Message::Text(serde_json::to_string(&serde_json::json!({
                        "type": "device-resume-confirm", "v": 1, "reqId": req_id, "basisConnId": basis_conn_id,
                    }))?.into())).await?;
                    pending_resume_confirm.insert(req_id, respond);
                }
                Some(ControlCommand::Shutdown) | None => {
                    socket.close(None).await?;
                    return Ok(());
                }
            },
            incoming = tokio::time::timeout(SILENCE_TIMEOUT, socket.next()) => {
                let incoming = incoming.map_err(|_| anyhow!("relay control became silent"))?
                    .ok_or_else(|| anyhow!("relay control closed"))??;
                let Message::Text(text) = incoming else {
                    if matches!(incoming, Message::Close(_)) { return Ok(()); }
                    bail!("relay sent a non-text control message");
                };
                let value: serde_json::Value = serde_json::from_str(&text)?;
                match value.get("type").and_then(serde_json::Value::as_str) {
                    Some("ping") => {
                        let ping: Ping = serde_json::from_value(value)?;
                        if ping.kind != "ping" || ping.t < 0 { bail!("invalid relay ping"); }
                        socket.send(Message::Text(serde_json::to_string(&serde_json::json!({"type":"pong", "t": ping.t}))?.into())).await?;
                    }
                    Some("invite-created") => {
                        let invite: InviteCreated = serde_json::from_value(value)?;
                        if invite.kind != "invite-created" || !valid_opaque_id(&invite.req_id) || !valid_base64url_32(&invite.invite_token) || invite.expires_at <= now_ms() || invite.max_attempts == 0 || invite.max_attempts > 16 {
                            bail!("invalid relay invite response");
                        }
                        if let Some(respond) = pending_invites.remove(&invite.req_id) { let _ = respond.send(Ok(invite)); }
                    }
                    Some("device-revoked") => {
                        let revoked: DeviceRevoked = serde_json::from_value(value)?;
                        if revoked.kind != "device-revoked" { bail!("invalid relay revocation response"); }
                        pending_revokes.remove(&revoked.req_id);
                    }
                    Some("device-credential-installed") => {
                        let installed: CredentialInstalled = serde_json::from_value(value)?;
                        validate_installed(&installed, true)?;
                        let Some(respond) = pending_installs.remove(&installed.req_id) else {
                            bail!("relay returned an unsolicited credential install result");
                        };
                        let _ = respond.send(Ok(installed));
                    }
                    Some("device-credential-install-status-result") => {
                        let status: CredentialInstallStatus = serde_json::from_value(value)?;
                        validate_install_status(&status)?;
                        let Some(respond) = pending_install_status.remove(&status.req_id) else {
                            bail!("relay returned an unsolicited credential status result");
                        };
                        let _ = respond.send(Ok(status));
                    }
                    Some("device-resume-confirmed") => {
                        let confirmed: ResumeConfirmed = serde_json::from_value(value)?;
                        validate_resume_confirmed(&confirmed)?;
                        let Some(respond) = pending_resume_confirm.remove(&confirmed.req_id) else {
                            bail!("relay returned an unsolicited resume confirmation");
                        };
                        let _ = respond.send(Ok(confirmed));
                    }
                    Some("conn-open") => {
                        let connection: ConnectionOpen = serde_json::from_value(value)?;
                        if connection.kind_name != "conn-open" || !valid_opaque_id(&connection.conn_id) || !valid_base64url_32(&connection.conn_ticket) || !matches!(connection.kind.as_str(), "invite" | "resume") || !valid_opaque_id(&connection.relay_device_id) || connection.attach_deadline_ms == 0 || connection.attach_deadline_ms > 60_000 {
                            bail!("invalid relay connection request");
                        }
                        let manager = manager.clone();
                        let cell = live.cell_url.clone();
                        let host_id = live.relay_host_id.clone();
                        let generation = live.generation;
                        let keypair = keypair.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(error) = manager.handle_relay_connection(cell, host_id, generation, keypair, connection).await {
                                log::debug!("relay data connection ended: {error:#}");
                            }
                        });
                    }
                    Some("drain") => bail!("relay cell requested reassignment"),
                    Some("control-error") => {
                        let error: ControlError = serde_json::from_value(value)?;
                        if error.kind != "control-error" || error.code.is_empty() || error.code.len() > 128 {
                            bail!("relay returned an invalid control error");
                        }
                        let Some(req_id) = error.req_id else {
                            bail!("relay rejected a control request without an id");
                        };
                        let message = || anyhow!("relay rejected the request: {}", error.code);
                        if let Some(respond) = pending_invites.remove(&req_id) {
                            let _ = respond.send(Err(message()));
                        } else if let Some(respond) = pending_installs.remove(&req_id) {
                            let _ = respond.send(Err(message()));
                        } else if let Some(respond) = pending_install_status.remove(&req_id) {
                            let _ = respond.send(Err(message()));
                        } else if let Some(respond) = pending_resume_confirm.remove(&req_id) {
                            let _ = respond.send(Err(message()));
                        } else if pending_revokes.remove(&req_id).is_none() {
                            bail!("relay rejected an unknown control request");
                        }
                    }
                    _ => bail!("relay sent an unknown control message"),
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(2)) => {
                if manager.account_context().as_ref().map(|next| &next.user_id) != Some(&context.user_id) {
                    return Ok(());
                }
            }
        }
    }
}

fn request_is_pending<A, B, C, D, E>(
    req_id: &str,
    invites: &HashMap<String, A>,
    revokes: &HashMap<String, B>,
    installs: &HashMap<String, C>,
    statuses: &HashMap<String, D>,
    confirms: &HashMap<String, E>,
) -> bool {
    invites.contains_key(req_id)
        || revokes.contains_key(req_id)
        || installs.contains_key(req_id)
        || statuses.contains_key(req_id)
        || confirms.contains_key(req_id)
}

fn valid_request_id(value: &str) -> bool {
    valid_opaque_id(value)
}

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 128
}

fn valid_base64url_32(value: &str) -> bool {
    value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn validate_installed(value: &CredentialInstalled, require_wire_type: bool) -> Result<()> {
    if (require_wire_type && value.kind.as_deref() != Some("device-credential-installed"))
        || (!require_wire_type && value.kind.is_some())
        || value.v != 1
        || !valid_request_id(&value.req_id)
        || !matches!(
            value.authorization_mode.as_str(),
            "relay-basis" | "authenticated-direct"
        )
        || value.current_version == 0
        || value.resume_expires_at < 0
        || value.grace_expires_at.is_some_and(|expiry| expiry < 0)
    {
        bail!("relay returned an invalid credential install result");
    }
    Ok(())
}

fn validate_install_status(value: &CredentialInstallStatus) -> Result<()> {
    if value.kind != "device-credential-install-status-result"
        || value.v != 1
        || !valid_request_id(&value.req_id)
    {
        bail!("relay returned an invalid credential status result");
    }
    match (value.state.as_str(), value.result.as_ref()) {
        ("not-found", None) => Ok(()),
        ("committed", Some(result)) if result.req_id == value.req_id => {
            validate_installed(result, false)
        }
        _ => bail!("relay returned an invalid credential status state"),
    }
}

fn validate_resume_confirmed(value: &ResumeConfirmed) -> Result<()> {
    if value.kind != "device-resume-confirmed"
        || value.v != 1
        || !valid_request_id(&value.req_id)
        || value.current_version == 0
        || !matches!(value.accepted_as.as_str(), "current" | "grace")
        || value.resume_expires_at < 0
        || value.grace_expires_at.is_some_and(|expiry| expiry < 0)
    {
        bail!("relay returned an invalid resume confirmation");
    }
    Ok(())
}

pub(super) async fn open_data_socket(
    cell_url: &str,
    generation: u64,
    connection: &ConnectionOpen,
) -> Result<ControlSocket> {
    let url = websocket_url(cell_url, &format!("/v1/host/data/{}", connection.conn_id))?;
    let request = url.into_client_request()?;
    let attach_timeout = Duration::from_millis(connection.attach_deadline_ms);
    let (mut socket, _) = tokio::time::timeout(
        attach_timeout,
        tokio_tungstenite::connect_async_with_config(
            request,
            Some(pairing_websocket_config()),
            false,
        ),
    )
    .await
    .map_err(|_| anyhow!("relay data connection timed out"))??;
    tokio::time::timeout(
        attach_timeout,
        socket.send(Message::Text(
            serde_json::to_string(&serde_json::json!({
                "type": "host-data-auth",
                "v": 1,
                "connTicket": connection.conn_ticket,
                "generation": generation,
            }))?
            .into(),
        )),
    )
    .await
    .map_err(|_| anyhow!("relay data authentication timed out"))??;
    Ok(socket)
}

fn websocket_url(origin: &str, path: &str) -> Result<String> {
    let mut url = url::Url::parse(origin)?;
    match url.scheme() {
        "https" => url.set_scheme("wss").unwrap(),
        "http" if matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "::1")) => {
            url.set_scheme("ws").unwrap()
        }
        _ => bail!("relay origin must use HTTPS"),
    }
    url.set_path(path);
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.into())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnect_ladder_escalates_and_never_stops() {
        assert_eq!(backoff(1), Duration::from_millis(500));
        assert_eq!(backoff(8), Duration::from_secs(60));
        assert_eq!(backoff(11), Duration::from_secs(60));
        assert_eq!(backoff(12), Duration::from_secs(90));
        assert_eq!(backoff(99), Duration::from_secs(90));
        assert_eq!(reconnect_message(3), "Can’t connect");
        assert_eq!(reconnect_message(12), "Unreachable — re-pair?");
    }

    #[test]
    fn relay_websocket_urls_never_carry_credentials() {
        assert_eq!(
            websocket_url("https://relay.example", "/v1/host/control").unwrap(),
            "wss://relay.example/v1/host/control"
        );
        assert!(websocket_url("http://relay.example", "/v1/host/control").is_err());
    }

    #[test]
    fn credential_install_authorization_matches_the_deployed_wire_shape() {
        assert_eq!(
            serde_json::to_value(DeviceCredentialInstallAuthorization::RelayBasis {
                basis_conn_id: "connection-1".into(),
            })
            .unwrap(),
            serde_json::json!({ "mode": "relay-basis", "basisConnId": "connection-1" })
        );
        assert_eq!(
            serde_json::to_value(DeviceCredentialInstallAuthorization::AuthenticatedDirect {
                direct_auth_id: "direct-1".into(),
            })
            .unwrap(),
            serde_json::json!({ "mode": "authenticated-direct", "directAuthId": "direct-1" })
        );
    }

    #[test]
    fn committed_install_status_uses_the_result_shape_without_a_type_field() {
        let status: CredentialInstallStatus = serde_json::from_value(serde_json::json!({
            "type": "device-credential-install-status-result",
            "v": 1,
            "reqId": "install-1",
            "state": "committed",
            "result": {
                "v": 1,
                "reqId": "install-1",
                "authorizationMode": "relay-basis",
                "currentVersion": 1,
                "resumeExpiresAt": 1
            }
        }))
        .unwrap();
        validate_install_status(&status).unwrap();
        assert!(serde_json::to_value(status).unwrap()["result"]
            .get("type")
            .is_none());
    }
}
