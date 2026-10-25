//! Internal desktop-to-owner sharing operations. This namespace is never a
//! guest/mobile capability. Verified identity is supplied by the authenticated
//! desktop adapter, while grants, roles, revocation and writes live here.

use super::{Guest, Link, LinkSettings, Person, Role, Share, Sharing, IDENTITY_MS};
use crate::local_runtime::{Attachment, Lifetime};
use crate::session::SessionManager;
use crate::store::index;
use anyhow::{bail, Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use subtle::ConstantTimeEq;
use std::collections::{HashSet, VecDeque};
use std::sync::{atomic::AtomicBool, Arc};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Actor {
    pub epoch: String,
    pub lease: String,
    pub generation: u64,
    pub user_id: String,
    pub profile_id: String,
    pub organization_id: String,
}

pub(crate) struct Registration {
    actor: Actor,
    attachment: Arc<Attachment>,
    revoked: bool,
}

pub(crate) struct Binding {
    actor: Actor,
    pub attachment: Arc<Attachment>,
}

/// Called with the sharing mutex held, including the final write boundary.
/// An in-process adapter cannot accidentally act on an owner's remote share.
pub(crate) fn authorize(share: &Share, actor: Option<&Actor>) -> Result<()> {
    match (&share.owner, actor) {
        (None, None) => Ok(()),
        (Some(binding), Some(actor)) if binding.actor == *actor && binding.attachment.valid() => {
            Ok(())
        }
        _ => anyhow::bail!("This sharing grant belongs to another account or attachment."),
    }
}

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn stop(share: &mut Share) {
    let connections: Vec<_> = share.guests.keys().cloned().collect();
    for connection in connections {
        share.disconnect(&connection, now());
    }
    share.queue.clear();
}

pub(crate) fn reap(manager: &SessionManager) {
    prune(&mut manager.sharing.lock().unwrap());
}

fn prune(sharing: &mut Sharing) {
    sharing.owners.retain(|_, owner| owner.attachment.valid());
    sharing.sessions.retain(|_, share| {
        if share
            .owner
            .as_ref()
            .is_some_and(|owner| !owner.attachment.valid())
        {
            stop(share);
            false
        } else {
            true
        }
    });
}

fn registered(sharing: &Sharing, actor: &Actor) -> Result<Arc<Attachment>> {
    sharing
        .owners
        .get(&actor.lease)
        .filter(|owner| owner.actor == *actor && owner.attachment.valid() && !owner.revoked)
        .map(|owner| owner.attachment.clone())
        .context("The account or sharing attachment changed. Register again.")
}

fn text<'a>(params: &'a Value, field: &str) -> Result<&'a str> {
    params[field]
        .as_str()
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .with_context(|| format!("{field} is required"))
}

/// Account transitions invalidate every grant from that attachment before a
/// replacement identity is installed. A late old-generation request is refused.
fn register(sharing: &mut Sharing, actor: Actor, attachment: Arc<Attachment>) -> Result<Value> {
    if let Some(previous) = sharing.owners.get(&actor.lease) {
        if previous.actor == actor {
            if previous.revoked {
                bail!("This account generation was revoked.");
            }
            return Ok(json!({"registered":true}));
        }
        if actor.generation <= previous.actor.generation {
            bail!("The account generation is stale or inconsistent.");
        }
    }
    sharing.sessions.retain(|_, share| {
        if share
            .owner
            .as_ref()
            .is_some_and(|owner| owner.actor.lease == actor.lease)
        {
            stop(share);
            false
        } else {
            true
        }
    });
    sharing.owners.insert(
        actor.lease.clone(),
        Registration {
            actor,
            attachment,
            revoked: false,
        },
    );
    Ok(json!({"registered":true}))
}

pub(crate) fn execute(
    manager: &SessionManager,
    lifetime: &Lifetime,
    method: &str,
    params: Value,
) -> Result<Value> {
    let actor: Actor = serde_json::from_value(params["actor"].clone())?;
    if [&actor.user_id, &actor.profile_id]
        .iter()
        .any(|value| value.is_empty() || value.len() > 512)
        || actor.organization_id.len() > 512
    {
        bail!("A complete account scope is required for sharing.");
    }
    // Pin to this owner and a live stream lease before looking at any grant.
    // The returned object is rechecked under the sharing lock and at the writer.
    let attachment = lifetime.attachment(&actor.epoch, &actor.lease)?;
    let mut sharing = manager.sharing.lock().unwrap();
    prune(&mut sharing);
    if !attachment.valid() {
        bail!("The sharing attachment disconnected.");
    }
    if method == "register" {
        return register(&mut sharing, actor, attachment);
    }
    if method == "clear" {
        // Sign-out may overtake the registration request on another socket.
        // Record a tombstone even before registration, but never let an old
        // sign-out invalidate a newer account on this attachment.
        if let Some(previous) = sharing.owners.get(&actor.lease) {
            if previous.actor != actor && actor.generation <= previous.actor.generation {
                bail!("The account generation is stale or inconsistent.");
            }
        }
        sharing.sessions.retain(|_, share| {
            if share
                .owner
                .as_ref()
                .is_some_and(|owner| owner.actor.lease == actor.lease)
            {
                stop(share);
                false
            } else {
                true
            }
        });
        sharing.owners.insert(
            actor.lease.clone(),
            Registration {
                actor,
                attachment,
                revoked: true,
            },
        );
        return Ok(json!({"cleared":true}));
    }
    let attachment = registered(&sharing, &actor)?;
    if method == "lookup" {
        let hash = text(&params, "tokenHash")?;
        let expected = params["expectedLink"].as_str();
        let time = now();
        for (session, share) in &mut sharing.sessions {
            if authorize(share, Some(&actor)).is_err() { continue; }
            for link in share.links.values_mut() {
                if !link.revoked && link.settings.expires_at > time && link.credential_expires_at > time
                    && (!link.settings.single_use || link.used_by.is_none())
                    && expected.is_none_or(|expected| expected == link.id)
                    && bool::from(link.token_hash.as_bytes().ct_eq(hash.as_bytes())) {
                    while link.join_attempts.front().is_some_and(|at| *at < time - 60_000) { link.join_attempts.pop_front(); }
                    if link.join_attempts.len() >= 60 { bail!("Too many invitation attempts."); }
                    link.join_attempts.push_back(time);
                    return Ok(json!({"sessionId":session,"linkId":link.id}));
                }
            }
        }
        bail!("The invitation is unavailable.");
    }
    let session = text(&params, "sessionId")?;
    if matches!(method, "status" | "stop") && !sharing.sessions.contains_key(session) {
        index::get(session)?;
        let path = crate::store::session_dir(session)?.join("share-activity.jsonl");
        let activity = if path.exists() { crate::store::read_lines::<Value>(&path)? } else { Vec::new() };
        return Ok(json!({"active":false,"links":[],"people":[],"leases":[],"notes":[],"queue":[],
            "activity":activity.into_iter().rev().take(1000).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>(),"revokeLinks":[]}));
    }
    if method == "create" {
        let entry = index::get(session)?;
        if entry.tabs.iter().any(|tab| {
            !crate::harness::settings::allowed_while_shared(&tab.permission_mode)
                || tab
                    .requested_permission_mode
                    .as_deref()
                    .is_some_and(|mode| !crate::harness::settings::allowed_while_shared(mode))
        }) {
            bail!("Change every tab out of Bypass before sharing this session.");
        }
        let mut settings: LinkSettings = serde_json::from_value(params["settings"].clone())?;
        settings.validate(now())?;
        let host: Person = serde_json::from_value(params["host"].clone())?;
        if host.user_id != actor.user_id
            || (!actor.organization_id.is_empty()
                && !host.organization_ids.contains(&actor.organization_id))
        {
            bail!("The host identity does not match the registered account.");
        }
        if let Some(share) = sharing.sessions.get(session) {
            authorize(share, Some(&actor))?;
        }
        let share = sharing.sessions.entry(session.into()).or_insert_with(|| {
            let mut share = Share::new(
                actor.user_id.clone(),
                actor.organization_id.clone(),
                session.into(),
            );
            share.owner = Some(Binding {
                actor: actor.clone(),
                attachment,
            });
            share
        });
        let id = text(&params, "linkId")?.to_string();
        if share.links.len() >= 32 || share.links.contains_key(&id) {
            bail!("The link already exists or the limit was reached.");
        }
        let url = params["url"]
            .as_str()
            .filter(|url| url.len() <= 16384)
            .context("Link URL required.")?;
        let token_hash = text(&params, "tokenHash")?.to_string();
        let credential_expires_at = params["credentialExpiresAt"]
            .as_i64()
            .context("Credential expiry required.")?;
        if credential_expires_at <= now() {
            bail!("The invitation credential expired.");
        }
        share.host = host;
        share.links.insert(
            id.clone(),
            Link {
                id: id.clone(),
                settings,
                url: url.into(),
                direct_only: params["directOnly"].as_bool().unwrap_or(false),
                credential_expires_at,
                join_attempts: VecDeque::new(),
                revoked: false,
                token_hash,
                blocked: HashSet::new(),
                approved: HashSet::new(),
                used_by: None,
            },
        );
        share.record(&actor.user_id, "link-created", json!({"linkId":id}), now());
        return Ok(share.snapshot(now(), true));
    }
    let share = sharing
        .sessions
        .get_mut(session)
        .context("Sharing ended.")?;
    authorize(share, Some(&actor))?;
    match method {
        "status" => Ok(share.snapshot(now(), true)),
        "stop" => {
            stop(share);
            share.record(&actor.user_id, "sharing-stopped", json!({}), now());
            let links: Vec<_> = share.links.keys().cloned().collect();
            sharing.sessions.remove(session);
            Ok(json!({"stopped":true,"revokeLinks":links}))
        }
        "edit" => {
            share.edit(
                text(&params, "linkId")?,
                serde_json::from_value(params["settings"].clone())?,
                now(),
            )?;
            Ok(share.snapshot(now(), true))
        }
        "revoke" => {
            share.revoke(
                text(&params, "linkId")?,
                params["removeGuests"].as_bool().unwrap_or(true),
                now(),
            )?;
            Ok(share.snapshot(now(), true))
        }
        "remove" => {
            share.remove(text(&params, "linkId")?, text(&params, "userId")?, now())?;
            Ok(share.snapshot(now(), true))
        }
        "approve" => {
            share.approve(
                text(&params, "linkId")?,
                text(&params, "userId")?,
                params["allow"].as_bool().unwrap_or(false),
                now(),
            )?;
            Ok(share.snapshot(now(), true))
        }
        "takeover" => {
            share.host_takeover(text(&params, "tabId")?, now());
            Ok(share.snapshot(now(), true))
        }
        "note" => {
            let text = super::runtime::message(&params)?;
            let note = super::Note { id: uuid::Uuid::now_v7().to_string(), author: share.host.clone(), text, created_at: now() };
            share.record(&actor.user_id, "note", json!({"noteId":note.id}), now());
            share.notes.push_back(note);
            while share.notes.len() > 500 { share.notes.pop_front(); }
            Ok(share.snapshot(now(), true))
        }
        "join" => {
            let connection = text(&params, "connectionId")?.to_string();
            if share.guests.contains_key(&connection) {
                bail!("This connection already joined.");
            }
            let (cancel, _cancelled) = tokio::sync::mpsc::unbounded_channel();
            let guest = Guest {
                connection_id: connection,
                link_id: text(&params, "linkId")?.into(),
                person: serde_json::from_value(params["person"].clone())?,
                role: Role::Viewer,
                can_approve: false,
                admitted: false,
                verified_until: now() + IDENTITY_MS,
                active: Arc::new(AtomicBool::new(false)),
                cancel,
                viewing: None,
                typing: false,
                last_write: 0,
                write_revision: 0,
            };
            Ok(json!({"admitted":share.join(guest, now())?}))
        }
        "refresh" => {
            share.refresh_identity(
                text(&params, "connectionId")?,
                serde_json::from_value(params["person"].clone())?,
                now(),
            )?;
            Ok(json!({"refreshed":true,"admitted":share.guests[text(&params, "connectionId")?].admitted}))
        }
        "disconnect" => {
            share.disconnect(text(&params, "connectionId")?, now());
            Ok(json!({"disconnected":true}))
        }
        "guest" => {
            let connection = text(&params, "connectionId")?.to_string();
            let guest_method = text(&params, "method")?.to_string();
            // The router checks this exact actor again under its own lock;
            // account changes/revocations between these locks cannot authorize
            // a request against replacement sharing state.
            drop(sharing);
            super::runtime::request(
                manager,
                Some(&actor),
                session,
                &connection,
                &guest_method,
                params["params"].clone(),
            )
        }
        "drain" => {
            drop(sharing);
            super::runtime::drain_queue(manager, Some(&actor), session)?;
            Ok(json!({"drained":true}))
        }
        _ => bail!("Unknown internal sharing operation."),
    }
}
