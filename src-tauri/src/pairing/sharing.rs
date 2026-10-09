//! Session links enter the existing pairing listener and E2EE handshake, but
//! never enter the host-wide mobile runtime or its broadcast subscriptions.
use std::collections::{HashSet, VecDeque};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose, Engine};
use chrono::Utc;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use subtle::ConstantTimeEq;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;
use tokio_tungstenite::{tungstenite::Message, WebSocketStream};
use uuid::Uuid;

use crate::events::AgentEvent;
use crate::local_sharing::{
    self, Guest, Link, LinkSettings, QueuedInput, Role, Share, IDENTITY_MS,
};
use crate::session::SessionManager;
use crate::store::{
    self,
    index::{self, TabStatus},
};

use super::{
    crypto::{random_token, token_hash, E2eeSession, PayloadKind},
    model::PairingOffer,
    PairingManager,
};

pub(super) fn now() -> i64 {
    Utc::now().timestamp_millis()
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ShareOffer {
    pub v: u8,
    pub session_id: String,
    pub link_id: String,
    pub expires_at: i64,
    pub pairing: PairingOffer,
}

pub(crate) fn decode_link(link: &str) -> Result<ShareOffer> {
    if link.len() > 16_384 {
        bail!("Invalid share link.");
    }
    let url = url::Url::parse(link)?;
    if !matches!(
        url.scheme(),
        "terminalx" | "terminalx-dev" | "terminalx-next" | "https"
    ) || (url.scheme() == "https"
        && (!matches!(url.host_str(), Some("console.terminalx.ai" | "terminalx.ai")) || url.path() != "/join"))
        || (url.scheme() != "https" && url.host_str() != Some("join"))
        || url.query().is_some()
    {
        bail!("Invalid share link.");
    }
    let code = url
        .fragment()
        .ok_or_else(|| anyhow!("The share secret is missing."))?;
    let bytes = general_purpose::URL_SAFE_NO_PAD.decode(code)?;
    let offer: ShareOffer = serde_json::from_slice(&bytes)?;
    if offer.v != 1
        || offer.expires_at <= now()
        || offer.pairing.v != 2
        || offer.pairing.scope != "session"
        || offer.pairing.identity_mode != "authenticate"
        || offer.link_id != offer.pairing.paired_device_id
        || offer.pairing.device_token.len() != 43
        || offer.session_id.is_empty()
    {
        bail!("This share link is invalid or expired.");
    }
    // Invitation endpoints may be LAN addresses. They carry no credentials.
    for endpoint in std::iter::once(&offer.pairing.endpoint).chain(&offer.pairing.direct_endpoints)
    {
        let endpoint = url::Url::parse(endpoint)?;
        if !matches!(endpoint.scheme(), "ws" | "wss")
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.query().is_some()
            || endpoint.fragment().is_some()
        {
            bail!("Invalid direct endpoint.");
        }
    }
    if let Some(relay) = &offer.pairing.relay {
        if relay.v != 1
            || relay.e2ee_framing != 2
            || relay.director_url != super::cloud::RELAY_DIRECTOR_URL
            || !super::cloud::allowed_https_origin(&relay.cell_url)
        {
            bail!("Invalid relay endpoint.");
        }
    }
    Ok(offer)
}

fn manager(pairing: &PairingManager) -> Result<&SessionManager> {
    pairing.sessions.get().context("Sessions are not ready.")
}

fn shareable(session: &str) -> Result<()> {
    let entry = index::get(session)?;
    if entry
        .tabs
        .iter()
        .any(|t| t.permission_mode == "bypassPermissions")
    {
        bail!("Change every tab out of Bypass before sharing this session.");
    }
    Ok(())
}

impl PairingManager {
    pub(crate) async fn create_share(
        self: &Arc<Self>,
        session_id: String,
        mut settings: LinkSettings,
        direct_only: bool,
    ) -> Result<Value> {
        settings.validate(now())?;
        shareable(&session_id)?;
        let context = self
            .account
            .context()
            .context("Sign in to share a session.")?;
        if self.is_stopped()
            || context.generation == self.sharing_blocked_generation.load(Ordering::SeqCst)
        {
            bail!("Sign in again to share this session.");
        }
        let relay = if direct_only {
            None
        } else {
            if !context.relay_entitled {
                bail!("Relay is unavailable on this account. Choose local network only.");
            }
            Some(
                self.current_relay()
                    .context("Relay is offline. Choose local network only, or retry.")?,
            )
        };
        self.ensure_direct_listener().context(
            "Local network access is unavailable. Allow TerminalX in the firewall and retry.",
        )?;
        let keypair = self.host_key(true)?;
        let id = Uuid::new_v4().simple().to_string();
        let token = random_token();
        let credential_expires_at = now() + 24 * 60 * 60 * 1000;
        let relay_offer = match relay.as_ref() {
            Some(relay) => Some(
                relay
                    .create_share_invite(id.clone(), credential_expires_at)
                    .await?,
            ),
            None => None,
        };
        let endpoints = super::advertised_endpoints();
        let offer = ShareOffer {
            v: 1,
            session_id: session_id.clone(),
            link_id: id.clone(),
            expires_at: credential_expires_at,
            pairing: PairingOffer {
                v: 2,
                endpoint: endpoints[0].clone(),
                direct_endpoints: endpoints,
                device_token: token.clone(),
                public_key_b64: keypair.public_key_b64(),
                paired_device_id: id.clone(),
                scope: "session".into(),
                identity_mode: "authenticate".into(),
                relay: relay_offer,
            },
        };
        let link = Link {
            id: id.clone(),
            settings,
            url: format!(
                "https://console.terminalx.ai/join#{}",
                general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&offer)?)
            ),
            direct_only,
            credential_expires_at,
            join_attempts: VecDeque::new(),
            revoked: false,
            token_hash: token_hash(&token),
            blocked: HashSet::new(),
            approved: HashSet::new(),
            used_by: None,
        };
        let result = (|| {
            let mut sharing = manager(self)?.sharing.lock().unwrap();
            shareable(&session_id)?;
            if self.is_stopped()
                || context.generation == self.sharing_blocked_generation.load(Ordering::SeqCst)
                || self.account.current_generation() != context.generation
                || self.account.current_scope().is_none_or(|current| {
                    current.user_id != context.user_id || current.profile_id != context.profile_id
                })
            {
                bail!("Your account changed while creating the link. Try again.");
            }
            let share = sharing
                .sessions
                .entry(session_id.clone())
                .or_insert_with(|| {
                    Share::new(
                        context.user_id.clone(),
                        context.organization_id.clone(),
                        session_id.clone(),
                    )
                });
            if share.links.len() >= 32 {
                bail!("Stop sharing to clear old links before creating more.");
            }
            share.host = local_sharing::Person {
                user_id: context.user_id.clone(),
                display_name: context.display_name.clone(),
                email: context.email.clone(),
                email_verified: false,
                organization_ids: vec![context.organization_id.clone()],
            };
            share.links.insert(id.clone(), link);
            share.record(
                &context.user_id,
                "link-created",
                json!({ "linkId": id }),
                now(),
            );
            Ok(share.snapshot(now(), true))
        })();
        if result.is_err() {
            if let Some(relay) = relay {
                relay.revoke(id);
            }
        }
        self.emit_share(&session_id);
        result
    }

    pub(crate) fn share_status(&self, session_id: &str) -> Result<Value> {
        if let Some(share) = manager(self)?
            .sharing
            .lock()
            .unwrap()
            .sessions
            .get(session_id)
        {
            return Ok(share.snapshot(now(), true));
        }
        let activity = store::session_dir(session_id)
            .ok()
            .map(|dir| dir.join("share-activity.jsonl"))
            .and_then(|path| store::read_lines::<Value>(&path).ok())
            .unwrap_or_default();
        Ok(
            json!({ "active": false, "links": [], "people": [], "leases": [], "notes": [],
            "activity": activity.into_iter().rev().take(1000).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>(), "queue": [] }),
        )
    }

    pub(crate) fn change_share(
        &self,
        session_id: &str,
        action: &str,
        params: Value,
    ) -> Result<Value> {
        let mut sharing = manager(self)?.sharing.lock().unwrap();
        if action == "stop" {
            if let Some(mut share) = sharing.sessions.remove(session_id) {
                let connections: Vec<_> = share.guests.keys().cloned().collect();
                for id in connections {
                    share.disconnect(&id, now());
                }
                share.record(&share.host_id.clone(), "sharing-stopped", json!({}), now());
                if let Some(relay) = self.current_relay() {
                    for id in share.links.keys() {
                        relay.revoke(id.clone());
                    }
                }
            }
        } else {
            let share = sharing
                .sessions
                .get_mut(session_id)
                .context("This session is not shared.")?;
            let link = params["linkId"].as_str().unwrap_or_default();
            let user = params["userId"].as_str().unwrap_or_default();
            match action {
                "edit" => share.edit(
                    link,
                    serde_json::from_value(params["settings"].clone())?,
                    now(),
                )?,
                "revoke" => {
                    share.revoke(
                        link,
                        params["removeGuests"].as_bool().unwrap_or(true),
                        now(),
                    )?;
                    if params["removeGuests"].as_bool().unwrap_or(true) {
                        if let Some(relay) = self.current_relay() {
                            relay.revoke(link.into());
                        }
                    }
                }
                "remove" => share.remove(link, user, now())?,
                "approve" => share.approve(
                    link,
                    user,
                    params["allow"].as_bool().unwrap_or(false),
                    now(),
                )?,
                "note" => {
                    let text = message(&params)?;
                    let note = local_sharing::Note {
                        id: Uuid::now_v7().to_string(),
                        author: share.host.clone(),
                        text,
                        created_at: now(),
                    };
                    share.record(
                        &share.host_id.clone(),
                        "note",
                        json!({ "noteId": note.id }),
                        now(),
                    );
                    share.notes.push_back(note);
                    while share.notes.len() > 500 {
                        share.notes.pop_front();
                    }
                }
                "takeover" => {
                    share.host_takeover(params["tabId"].as_str().context("Tab required.")?, now())
                }
                _ => bail!("Unknown share action."),
            }
        }
        drop(sharing);
        self.emit_share(session_id);
        self.share_status(session_id)
    }

    pub(super) fn emit_share(&self, session_id: &str) {
        if let (Some(sink), Ok(state)) = (self.sink.get(), self.share_status(session_id)) {
            sink.emit(
                "session_share_changed",
                &json!({ "sessionId": session_id, "state": state }),
            );
        }
    }

    pub(super) fn share_for_token(
        &self,
        token: &str,
        expected: Option<&str>,
    ) -> Option<(String, String)> {
        let sessions = self.sessions.get()?;
        let mut sharing = sessions.sharing.lock().unwrap();
        let hash = token_hash(token);
        for (session, share) in &mut sharing.sessions {
            for link in share.links.values_mut() {
                if !link.revoked
                    && link.settings.expires_at > now()
                    && (!link.settings.single_use || link.used_by.is_none())
                    && expected.is_none_or(|id| id == link.id)
                    && bool::from(link.token_hash.as_bytes().ct_eq(hash.as_bytes()))
                {
                    while link
                        .join_attempts
                        .front()
                        .is_some_and(|at| *at < now() - 60_000)
                    {
                        link.join_attempts.pop_front();
                    }
                    if link.join_attempts.len() >= 60 {
                        return None;
                    }
                    link.join_attempts.push_back(now());
                    return Some((session.clone(), link.id.clone()));
                }
            }
        }
        None
    }

    pub(super) async fn share_socket<S>(
        &self,
        mut socket: WebSocketStream<S>,
        mut crypto: E2eeSession,
        session_id: String,
        link_id: String,
    ) -> Result<()>
    where
        S: AsyncRead + AsyncWrite + Unpin,
    {
        let id = Uuid::new_v4().to_string();
        let active = Arc::new(AtomicBool::new(false));
        let (cancel, mut cancelled) = mpsc::unbounded_channel();
        let (outgoing, mut output) = mpsc::channel::<Value>(128);
        let sink = self.sink.get().context("App is unavailable.")?;
        let event_session = session_id.clone();
        let event_active = active.clone();
        let listener = sink.listen(
            "agent_event",
            Box::new(move |payload| {
                if !event_active.load(Ordering::SeqCst) {
                    return;
                }
                let Ok(event) = serde_json::from_str::<AgentEvent>(payload) else {
                    return;
                };
                if event.session_id == event_session {
                    // A slow observer is closed instead of losing transcript events.
                    if outgoing
                        .try_send(
                            json!({ "method": "session.event", "params": { "event": event } }),
                        )
                        .is_err()
                    {
                        event_active.store(false, Ordering::SeqCst);
                    }
                }
            }),
        );
        let mut access_token = None::<String>;
        let mut verified_at = now();
        let mut auth_attempts = 0;
        let mut requests = VecDeque::new();
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
        let result = async {
            loop {
                tokio::select! {
                    _ = cancelled.recv() => break,
                    _ = tick.tick() => {
                        if let Some(token) = &access_token {
                            if now() - verified_at >= IDENTITY_MS / 2 {
                                let token = token.clone();
                                let person = verify_identity(token, &mut cancelled).await?;
                                let mut sharing = manager(self)?.sharing.lock().unwrap();
                                sharing.sessions.get_mut(&session_id).context("Access ended.")?.refresh_identity(&id, person, now())?;
                                verified_at = now();
                            }
                            self.drain_share_queue(&session_id)?;
                            let status = self.guest_status(&session_id, &id)?;
                            super::send_encrypted_text(&mut socket, &mut crypto, &json!({ "method": "share.changed", "params": status }).to_string()).await?;
                        } else if now() - verified_at > 15_000 { bail!("Sign in to join this session."); }
                    }
                    Some(frame) = output.recv() => {
                        if active.load(Ordering::SeqCst) {
                            super::send_encrypted_text(&mut socket, &mut crypto, &frame.to_string()).await?;
                        }
                    }
                    frame = socket.next() => {
                        let Some(frame) = frame else { break };
                        match frame? {
                            Message::Text(text) => {
                                let bytes = super::decode_canonical_base64(&text)?;
                                let plain = crypto.open(&bytes, PayloadKind::Text)?;
                                let request: Value = serde_json::from_slice(&plain)?;
                                while requests.front().is_some_and(|at| *at < now() - 1000) { requests.pop_front(); }
                                if requests.len() >= 30 { bail!("Too many requests. Join again after a moment."); }
                                requests.push_back(now());
                                let method = request["method"].as_str().unwrap_or_default();
                                let result = if method == "session.authenticate" {
                                    if access_token.is_none() {
                                        auth_attempts += 1;
                                        if auth_attempts > 3 { bail!("Too many authentication attempts."); }
                                    } else if now() - verified_at < 5000 { bail!("Too many authentication attempts."); }
                                    validate_params(method, &request["params"], &session_id)?;
                                    let token = request["params"]["accessToken"].as_str().filter(|t| !t.is_empty() && t.len() < 16_384).context("Sign in to join.")?.to_string();
                                    let verify = token.clone();
                                    match verify_identity(verify, &mut cancelled).await {
                                        Ok(person) => {
                                            let mut sharing = manager(self)?.sharing.lock().unwrap();
                                            let share = sharing.sessions.get_mut(&session_id).context("Sharing ended.")?;
                                            let admission = if access_token.is_some() {
                                                share.refresh_identity(&id, person, now()).map(|_| share.guests[&id].admitted)
                                            } else { share.join(Guest { connection_id: id.clone(), link_id: link_id.clone(), person, role: Role::Viewer,
                                                can_approve: false, admitted: false, verified_until: now() + IDENTITY_MS, active: active.clone(), cancel: cancel.clone(),
                                                viewing: None, typing: false, last_write: 0, write_revision: 0 }, now()) };
                                            match admission {
                                                Ok(admitted) => { access_token = Some(token); verified_at = now(); Ok(json!({ "admitted": admitted })) }
                                                Err(error) => Err(error),
                                            }
                                        }
                                        Err(_) => Err(anyhow!("Your sign-in is no longer valid. Sign in again.")),
                                    }
                                } else {
                                    self.share_rpc(&session_id, &id, method, request.get("params").cloned().unwrap_or_else(|| json!({})))
                                };
                                let invalid_refresh = method == "session.authenticate" && result.is_err();
                                let response = match result {
                                    Ok(value) => json!({ "id": request["id"], "ok": true, "result": value }),
                                    Err(error) => json!({ "id": request["id"], "ok": false, "error": { "code": "forbidden", "message": error.to_string() } }),
                                };
                                super::send_encrypted_text(&mut socket, &mut crypto, &response.to_string()).await?;
                                self.emit_share(&session_id);
                                if invalid_refresh { bail!("Your sign-in is no longer valid."); }
                            }
                            Message::Close(_) => break,
                            Message::Ping(bytes) => socket.send(Message::Pong(bytes)).await?,
                            Message::Pong(_) => (),
                            _ => bail!("Unsupported session frame."),
                        }
                    }
                }
            }
            Ok(())
        }.await;
        active.store(false, Ordering::SeqCst);
        sink.unlisten(listener);
        if let Some(share) = manager(self)?
            .sharing
            .lock()
            .unwrap()
            .sessions
            .get_mut(&session_id)
        {
            share.disconnect(&id, now());
        }
        self.emit_share(&session_id);
        let _ = socket.close(None).await;
        result
    }

    fn guest_status(&self, session: &str, connection: &str) -> Result<Value> {
        let sharing = manager(self)?.sharing.lock().unwrap();
        let share = sharing.sessions.get(session).context("Sharing ended.")?;
        let guest = share.guests.get(connection).context("Access ended.")?;
        if !guest.admitted {
            return Ok(json!({ "admitted": false }));
        }
        if !guest.active.load(Ordering::SeqCst) {
            bail!("The connection could not keep up. Join again.");
        }
        Ok(
            json!({ "admitted": true, "you": { "person": guest.person, "role": guest.role, "canApprove": guest.can_approve }, "state": share.snapshot(now(), false) }),
        )
    }

    fn share_rpc(
        &self,
        session: &str,
        connection: &str,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        validate_params(method, &params, session)?;
        if method == "session.status" {
            return self.guest_status(session, connection);
        }
        let sessions = manager(self)?;
        let mut sharing = sessions.sharing.lock().unwrap();
        let share = sharing
            .sessions
            .get_mut(session)
            .context("Sharing ended.")?;
        let tab_id = params["tabId"].as_str();
        let write = matches!(
            method,
            "session.send" | "session.queue" | "session.steer" | "session.stop"
        );
        let approve = method == "permission.respond";
        // Resolve the public tab at the write boundary, under the same lock as
        // lifecycle/mode changes. There is no PTY-id input route.
        let shells = sessions.terminals().session_pane_ids(session, &[]);
        share.shell_tabs.retain(|_, pane| shells.contains(pane));
        let shell = tab_id.and_then(|id| share.shell_tabs.get(id)).cloned();
        let tab = match tab_id {
            Some(id) => match index::get(session)?.tab(id).cloned() {
                Some(tab) => Some(tab),
                None if shell.is_some()
                    && matches!(method, "terminal.read" | "presence.heartbeat") =>
                {
                    None
                }
                None => bail!("Tab not found in this session."),
            },
            None => None,
        };
        if write
            && tab
                .as_ref()
                .is_none_or(|t| t.permission_mode == "bypassPermissions")
        {
            bail!("This tab cannot be driven while sharing.");
        }
        let person = share.admit(connection, tab_id, write, approve, now())?;
        let tab_id = tab_id.unwrap_or_default();
        match method {
            "session.tabs.list" => {
                let entry = index::get(session)?;
                let mut tabs = entry.tabs.iter().map(|t| json!({
                    "id": t.id, "kind": "agent", "title": t.title, "harness": t.harness, "model": t.model,
                    "effort": t.effort, "permissionMode": t.permission_mode, "status": t.status
                })).collect::<Vec<_>>();
                for pane in shells {
                    if !share.shell_tabs.values().any(|known| known == &pane) {
                        share.shell_tabs.insert(Uuid::new_v4().to_string(), pane);
                    }
                }
                for (number, (id, _)) in share.shell_tabs.iter().enumerate() {
                    tabs.push(json!({ "id": id, "kind": "terminal", "title": format!("Terminal {}", number + 1), "harness": "shell", "status": "idle" }));
                }
                Ok(json!({ "id": entry.id, "title": entry.title, "tabs": tabs }))
            }
            "session.tail" => {
                let path = store::log_path(session, tab_id)?;
                let mut events: Vec<AgentEvent> = store::read_lines(&path)?;
                let after = params["after"].as_u64().unwrap_or(0);
                events.retain(|event| event.seq > after);
                let mut bytes = 0;
                let mut count = 0;
                for event in &events {
                    bytes += serde_json::to_vec(event)?.len();
                    if count >= 500 || (count > 0 && bytes > 2 * 1024 * 1024) {
                        break;
                    }
                    count += 1;
                }
                let has_more = events.len() > count;
                events.truncate(count);
                Ok(json!({ "events": events, "hasMore": has_more }))
            }
            "terminal.read" => {
                let pane_id = match shell {
                    Some(pane) => pane,
                    None => {
                        sessions
                            .pane_of(session, tab_id)
                            .context("The agent terminal is not running.")?
                            .pane_id
                    }
                };
                let size = sessions.terminals().size(&pane_id)?;
                let bytes = sessions
                    .terminals()
                    .read_output(&pane_id)
                    .unwrap_or_default();
                Ok(
                    json!({ "text": String::from_utf8_lossy(&bytes), "cols": size.0, "rows": size.1 }),
                )
            }
            "presence.heartbeat" => {
                let guest = share.guests.get_mut(connection).unwrap();
                guest.viewing = params["tabId"].as_str().map(String::from);
                guest.typing = params["typing"].as_bool().unwrap_or(false);
                Ok(json!({ "ok": true }))
            }
            "chat.list" => Ok(json!({ "notes": share.notes })),
            "chat.post" => {
                let text = message(&params)?;
                let guest = share.guests.get_mut(connection).unwrap();
                if now() - guest.last_write < 500 {
                    bail!("Please wait before posting again.");
                }
                guest.last_write = now();
                let note = local_sharing::Note {
                    id: Uuid::now_v7().to_string(),
                    author: person.clone(),
                    text,
                    created_at: now(),
                };
                share.notes.push_back(note.clone());
                while share.notes.len() > 500 {
                    share.notes.pop_front();
                }
                share.record(&person.user_id, "note", json!({ "noteId": note.id }), now());
                Ok(json!(note))
            }
            "session.send" | "session.queue" | "session.steer" => {
                let text = message(&params)?;
                let tab = tab.unwrap();
                crate::cloud_agents::slash::check(&text, &tab.harness, None)
                    .map_err(|e| anyhow!(e.message()))?;
                let busy = matches!(
                    sessions.status_of(session, tab_id),
                    TabStatus::InProgress | TabStatus::Waiting
                );
                if busy && method == "session.steer" {
                    // Interrupt before resuming with the steering prompt. Never
                    // hand a guest's deferred input to an opaque agent queue.
                    share.cancel_tab_inputs(tab_id);
                    sessions.stop(session, tab_id)?;
                }
                if busy && method != "session.steer" {
                    if share.queue.len() >= 64 {
                        bail!("The follow-up queue is full.");
                    }
                    if crate::cloud_agents::slash::is_command(&text) {
                        bail!("Send slash commands after the turn finishes.");
                    }
                    share.queue.push_back(QueuedInput {
                        connection_id: connection.into(),
                        tab_id: tab_id.into(),
                        text,
                    });
                    share.record(&person.user_id, "queued", json!({ "tabId": tab_id }), now());
                    Ok(json!({ "queued": true, "events": [] }))
                } else {
                    let outcome = sessions.send_shared(
                        session,
                        tab_id,
                        text,
                        person.clone(),
                        share.write_permit(connection, tab_id)?,
                    )?;
                    share.record(&person.user_id, "prompt", json!({ "tabId": tab_id }), now());
                    Ok(json!(outcome))
                }
            }
            "session.stop" => {
                share.cancel_tab_inputs(tab_id);
                sessions.stop(session, tab_id)?;
                share.record(&person.user_id, "stop", json!({ "tabId": tab_id }), now());
                Ok(json!({ "stopped": true }))
            }
            "permission.respond" => {
                sessions.respond_permission(
                    session,
                    tab_id,
                    params["requestId"].as_str().context("Request required.")?,
                    params["optionId"].as_str().context("Option required.")?,
                )?;
                share.record(
                    &person.user_id,
                    "permission",
                    json!({ "tabId": tab_id }),
                    now(),
                );
                Ok(json!({ "answered": true }))
            }
            "steerLease.release" => {
                if share
                    .leases
                    .get(tab_id)
                    .is_some_and(|l| l.holder.user_id == person.user_id)
                {
                    share.cancel_tab_inputs(tab_id);
                    share.leases.remove(tab_id);
                }
                Ok(json!({ "released": true }))
            }
            _ => bail!("Method is outside this session's scope."),
        }
    }

    fn drain_share_queue(&self, session: &str) -> Result<()> {
        let sessions = manager(self)?;
        let mut sharing = sessions.sharing.lock().unwrap();
        let Some(share) = sharing.sessions.get_mut(session) else {
            return Ok(());
        };
        let ready = share.queue.iter().position(|input| {
            !matches!(
                sessions.status_of(session, &input.tab_id),
                TabStatus::InProgress | TabStatus::Waiting
            )
        });
        if let Some(at) = ready {
            let input = share.queue.remove(at).unwrap();
            let result = (|| {
                let tab = index::get(session)?
                    .tab(&input.tab_id)
                    .cloned()
                    .context("Tab closed.")?;
                if tab.permission_mode == "bypassPermissions" {
                    bail!("Tab is in Bypass.");
                }
                let person = share.admit(
                    &input.connection_id,
                    Some(&input.tab_id),
                    true,
                    false,
                    now(),
                )?;
                crate::cloud_agents::slash::check(&input.text, &tab.harness, None)
                    .map_err(|e| anyhow!(e.message()))?;
                sessions.send_shared(
                    session,
                    &input.tab_id,
                    input.text,
                    person.clone(),
                    share.write_permit(&input.connection_id, &input.tab_id)?,
                )?;
                share.record(
                    &person.user_id,
                    "prompt",
                    json!({ "tabId": input.tab_id }),
                    now(),
                );
                Ok::<_, anyhow::Error>(())
            })();
            if let Err(error) = result {
                share.record(
                    "host",
                    "queue-dropped",
                    json!({ "tabId": input.tab_id, "reason": error.to_string() }),
                    now(),
                );
            }
        }
        Ok(())
    }
}

async fn verify_identity(
    token: String,
    cancelled: &mut mpsc::UnboundedReceiver<()>,
) -> Result<local_sharing::Person> {
    tokio::select! {
        _ = cancelled.recv() => bail!("Access ended."),
        result = tokio::task::spawn_blocking(move || super::cloud::verify_guest(&token)) => result?,
    }
}

fn message(params: &Value) -> Result<String> {
    let text = params["text"].as_str().unwrap_or_default().trim();
    if text.is_empty()
        || text.len() > 16 * 1024
        || text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\t' | '\r'))
    {
        bail!("Enter a message of 1 to 16384 bytes without terminal control characters.");
    }
    Ok(text.into())
}

fn validate_params(method: &str, params: &Value, session: &str) -> Result<()> {
    if !local_sharing::scoped_method(method) {
        bail!("Method is outside this session's scope.");
    }
    let keys: &[&str] = match method {
        "session.authenticate" => &["sessionId", "accessToken"],
        "session.tail" => &["sessionId", "tabId", "after"],
        "presence.heartbeat" => &["sessionId", "tabId", "typing"],
        "session.send" | "session.queue" | "session.steer" => &["sessionId", "tabId", "text"],
        "chat.post" => &["sessionId", "text"],
        "permission.respond" => &["sessionId", "tabId", "requestId", "optionId"],
        "session.stop" | "terminal.read" | "steerLease.release" => &["sessionId", "tabId"],
        _ => &["sessionId"],
    };
    if params["sessionId"].as_str() != Some(session)
        || !params
            .as_object()
            .is_some_and(|p| p.keys().all(|k| keys.contains(&k.as_str())))
    {
        bail!("The request is outside this session's scope.");
    }
    if keys.contains(&"tabId")
        && method != "presence.heartbeat"
        && params["tabId"].as_str().is_none_or(str::is_empty)
    {
        bail!("Public tab id required.");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scoped_router_resolves_only_public_tabs_and_enforces_roles_on_real_session_state() {
        let _home = store::temp_home();
        let entries: Vec<index::SessionEntry> = ["shared", "private"].iter().map(|id| serde_json::from_value(json!({
            "id": id, "projectPath": "/tmp", "cwd": "/tmp", "title": id,
            "created": index::now(), "modified": index::now(),
            "tabs": [{ "id": format!("{id}-tab"), "harness": "claude", "permissionMode": "default", "created": index::now() }]
        })).unwrap()).collect();
        index::save(&entries).unwrap();
        let terminals = Arc::new(crate::pty::Terminals::new());
        let sink: Arc<dyn crate::sink::EventSink> = Arc::new(crate::sink::BroadcastSink::new(256));
        #[cfg(unix)]
        for id in ["shared:shell", "private:shell"] {
            terminals
                .spawn(
                    sink.clone(),
                    id,
                    crate::pty::PaneSpec {
                        cwd: "/tmp",
                        cols: 92,
                        rows: 17,
                        command: Some("/bin/cat"),
                        env: &[],
                    },
                )
                .unwrap();
        }
        let sessions = SessionManager::new(
            sink,
            Arc::new(crate::sink::NoObserver),
            Arc::new(crate::harness::host::Host::new()),
            terminals.clone(),
            Arc::new(Default::default()),
            Arc::new(Default::default()),
            crate::hooks::prepare_control().unwrap(),
        );
        let mut share = local_sharing::tests::fixture();
        let now = now();
        share.links.get_mut("link").unwrap().settings.expires_at = now + 60_000;
        share.links.get_mut("link").unwrap().settings.role = Role::Viewer;
        let mut guest = local_sharing::tests::guest("connection", "alice");
        guest.verified_until = now + 60_000;
        share.join(guest, now).unwrap();
        sessions
            .sharing
            .lock()
            .unwrap()
            .sessions
            .insert("shared".into(), share);
        let pairing = PairingManager::new(Arc::new(crate::account::AccountManager::default()));
        pairing.attach_sessions(sessions);
        let list = pairing
            .share_rpc(
                "shared",
                "connection",
                "session.tabs.list",
                json!({ "sessionId": "shared" }),
            )
            .unwrap();
        assert_eq!(list["tabs"][0]["id"], "shared-tab");
        assert!(list.get("cwd").is_none());
        #[cfg(unix)]
        {
            let shell = list["tabs"]
                .as_array()
                .unwrap()
                .iter()
                .find(|tab| tab["kind"] == "terminal")
                .unwrap();
            let id = shell["id"].as_str().unwrap();
            assert_ne!(id, "shared:shell");
            assert!(!list.to_string().contains("private:shell"));
            let output = pairing
                .share_rpc(
                    "shared",
                    "connection",
                    "terminal.read",
                    json!({ "sessionId": "shared", "tabId": id }),
                )
                .unwrap();
            assert_eq!(output["cols"], 92);
            assert_eq!(output["rows"], 17);
            for raw in ["shared:shell", "private:shell"] {
                assert!(pairing
                    .share_rpc(
                        "shared",
                        "connection",
                        "terminal.read",
                        json!({ "sessionId": "shared", "tabId": raw })
                    )
                    .is_err());
            }
            assert!(pairing
                .share_rpc(
                    "shared",
                    "connection",
                    "session.send",
                    json!({ "sessionId": "shared", "tabId": id, "text": "touch /tmp/forbidden" })
                )
                .is_err());
            terminals.kill("shared:shell");
            terminals.kill("private:shell");
        }
        assert!(pairing
            .share_rpc(
                "shared",
                "connection",
                "session.tabs.list",
                json!({ "sessionId": "private" })
            )
            .is_err());
        assert!(pairing
            .share_rpc(
                "shared",
                "connection",
                "session.tail",
                json!({ "sessionId": "shared", "tabId": "private-tab" })
            )
            .is_err());
        for method in [
            "session.send",
            "session.queue",
            "session.steer",
            "session.stop",
            "permission.respond",
        ] {
            assert!(pairing
                .share_rpc(
                    "shared",
                    "connection",
                    method,
                    json!({ "sessionId": "shared", "tabId": "shared-tab", "text": "hello" })
                )
                .is_err());
        }
        let note = pairing
            .share_rpc(
                "shared",
                "connection",
                "chat.post",
                json!({ "sessionId": "shared", "text": "A note" }),
            )
            .unwrap();
        assert_eq!(note["author"]["userId"], "alice");
        assert!(pairing
            .share_rpc(
                "shared",
                "connection",
                "chat.post",
                json!({ "sessionId": "shared", "text": "Forged", "author": "host" })
            )
            .is_err());
        pairing.change_share("shared", "stop", json!({})).unwrap();
        assert!(pairing
            .share_rpc(
                "shared",
                "connection",
                "session.tabs.list",
                json!({ "sessionId": "shared" })
            )
            .is_err());
    }
    #[test]
    fn a_bypass_tab_anywhere_in_the_session_refuses_sharing() {
        let _home = store::temp_home();
        let entry: index::SessionEntry = serde_json::from_value(json!({
            "id": "session", "projectPath": "/tmp", "cwd": "/tmp", "title": "Test",
            "created": index::now(), "modified": index::now(),
            "tabs": [
                { "id": "safe", "harness": "claude", "permissionMode": "default", "created": index::now() },
                { "id": "unsafe", "harness": "codex", "permissionMode": "bypassPermissions", "created": index::now() }
            ]
        })).unwrap();
        index::save(&[entry]).unwrap();
        assert!(shareable("session").is_err());
        index::update_tab("session", "unsafe", |tab| {
            tab.permission_mode = "default".into();
            Ok(())
        })
        .unwrap();
        assert!(shareable("session").is_ok());
    }
    #[test]
    fn router_rejects_other_sessions_unknown_methods_and_internal_identifiers() {
        for method in [
            "files.read",
            "sessions.summaries",
            "terminal.send",
            "terminal.resize",
            "session.setMode",
            "session.authenticate.extra",
        ] {
            assert!(validate_params(method, &json!({ "sessionId": "one" }), "one").is_err());
        }
        for params in [
            json!({"sessionId":"two", "tabId":"tab"}),
            json!({"sessionId":"one", "tabId":"tab", "ptyId":"hidden"}),
            json!({"sessionId":"one", "tabId":"tab", "path":"/tmp"}),
        ] {
            assert!(validate_params("terminal.read", &params, "one").is_err());
        }
        assert!(validate_params(
            "terminal.read",
            &json!({"sessionId":"one", "tabId":"tab"}),
            "one"
        )
        .is_ok());
    }
}
