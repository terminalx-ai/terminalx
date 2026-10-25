//! Session-scoped admission and dispatch at the process that owns the tabs.
//! Both the desktop adapter and the local owner use this exact router. Keep
//! the sharing lock through admission and dispatch; delayed PTY writes still
//! revalidate their permit, revision and tab epoch in SessionManager.

use crate::events::AgentEvent;
use crate::harness::settings::allowed_while_shared;
use crate::local_sharing::{self, QueuedInput};
use crate::session::SessionManager;
use crate::store::{
    self,
    index::{self, TabStatus},
};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use uuid::Uuid;

fn now() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub(crate) fn guest_status(
    sessions: &SessionManager,
    owner: Option<&super::owner::Actor>,
    session: &str,
    connection: &str,
) -> Result<Value> {
    let sharing = sessions.sharing.lock().unwrap();
    let share = sharing.sessions.get(session).context("Sharing ended.")?;
    super::owner::authorize(share, owner)?;
    let guest = share.guests.get(connection).context("Access ended.")?;
    if !guest.admitted {
        return Ok(json!({ "admitted": false }));
    }
    if guest.verified_until <= now() {
        bail!("Sign in again to view this session.");
    }
    if !guest.active.load(Ordering::SeqCst) {
        bail!("The connection could not keep up. Join again.");
    }
    Ok(
        json!({ "admitted": true, "you": { "person": guest.person, "role": guest.role, "canApprove": guest.can_approve }, "state": share.snapshot(now(), false) }),
    )
}

pub(crate) fn request(
    sessions: &SessionManager,
    owner: Option<&super::owner::Actor>,
    session: &str,
    connection: &str,
    method: &str,
    params: Value,
) -> Result<Value> {
    validate_params(method, &params, session)?;
    if method == "session.status" {
        return guest_status(sessions, owner, session, connection);
    }
    // Never wait for checkout admission while holding sharing or a view lease.
    let admission = crate::issue_pipeline::admission::lock();
    let mut sharing = sessions.sharing.lock().unwrap();
    let share = sharing
        .sessions
        .get_mut(session)
        .context("Sharing ended.")?;
    super::owner::authorize(share, owner)?;
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
            None if shell.is_some() && matches!(method, "terminal.read" | "presence.heartbeat") => {
                None
            }
            None => bail!("Tab not found in this session."),
        },
        None => None,
    };
    if write
        && tab
            .as_ref()
            .is_none_or(|t| !allowed_while_shared(&t.permission_mode))
    {
        bail!("This tab cannot be driven while sharing.");
    }
    let person = share.admit(connection, tab_id, write, approve, now())?;
    let attachment = share.owner.as_ref().map(|owner| owner.attachment.clone());
    let _attachment = attachment
        .as_ref()
        .map(|attachment| attachment.enter())
        .transpose()?;
    #[cfg(test)]
    after_attachment();
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
            Ok(json!({ "text": String::from_utf8_lossy(&bytes), "cols": size.0, "rows": size.1 }))
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
            if busy {
                let steer = method == "session.steer";
                if share.queue.len() >= 64 {
                    bail!("The follow-up queue is full.");
                }
                if !steer && crate::cloud_agents::slash::is_command(&text) {
                    bail!("Send slash commands after the turn finishes.");
                }
                let input = QueuedInput {
                    connection_id: connection.into(),
                    tab_id: tab_id.into(),
                    text,
                };
                if steer {
                    // Escape, then this prompt as the next one (#427): the
                    // turn is interrupted, the agent's process stays, and
                    // the prompt goes to the front of the share's own
                    // queue, checked again when the interrupted turn has
                    // ended. Never typed into the running agent, whose
                    // queue nobody here could take it back from.
                    sessions.interrupt(session, tab_id)?;
                    share.queue.push_front(input);
                    share.record(&person.user_id, "steer", json!({ "tabId": tab_id }), now());
                } else {
                    share.queue.push_back(input);
                    share.record(&person.user_id, "queued", json!({ "tabId": tab_id }), now());
                }
                Ok(json!({ "queued": true, "events": [] }))
            } else {
                let outcome = sessions.send_shared_admitted(
                    &admission,
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
        // Stop is Escape first (#427), as in the host's own composer: the
        // turn is interrupted, the agent's process stays, and what guests
        // queued behind the turn goes out when it has ended. `force` is
        // the stop that ends the process and drops that queue, for an
        // agent that did not answer the interrupt.
        "session.stop" if params["force"] != true => {
            let interrupted = sessions.interrupt(session, tab_id)?;
            if interrupted {
                share.record(
                    &person.user_id,
                    "interrupt",
                    json!({ "tabId": tab_id }),
                    now(),
                );
            }
            Ok(json!({ "stopped": false, "interrupted": interrupted }))
        }
        "session.stop" => {
            share.cancel_tab_inputs(tab_id);
            sessions.stop(session, tab_id)?;
            share.record(&person.user_id, "stop", json!({ "tabId": tab_id }), now());
            Ok(json!({ "stopped": true, "interrupted": false }))
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

pub(crate) fn drain_queue(
    sessions: &SessionManager,
    owner: Option<&super::owner::Actor>,
    session: &str,
) -> Result<()> {
    // Never wait for checkout admission while holding sharing or a view lease.
    let admission = crate::issue_pipeline::admission::lock();
    let mut sharing = sessions.sharing.lock().unwrap();
    let Some(share) = sharing.sessions.get_mut(session) else {
        return Ok(());
    };
    super::owner::authorize(share, owner)?;
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
            if !allowed_while_shared(&tab.permission_mode) {
                bail!("Tab is in Bypass.");
            }
            // Everything a write is checked for, except how long ago the
            // guest last wrote: this input was accepted then, and what
            // they did since (a steer, a stop, another follow-up) is no
            // reason to drop it.
            let permit = share.write_permit(&input.connection_id, &input.tab_id)?;
            let person = share.admit_at_writer(&permit, &input.tab_id, now())?;
            crate::cloud_agents::slash::check(&input.text, &tab.harness, None)
                .map_err(|e| anyhow!(e.message()))?;
            let attachment = share.owner.as_ref().map(|owner| owner.attachment.clone());
            let _attachment = attachment
                .as_ref()
                .map(|attachment| attachment.enter())
                .transpose()?;
            sessions.send_shared_admitted(&admission, session, &input.tab_id, input.text, person.clone(), permit)?;
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

pub(crate) fn message(params: &Value) -> Result<String> {
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

pub(crate) fn validate_params(method: &str, params: &Value, session: &str) -> Result<()> {
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
        "session.stop" => &["sessionId", "tabId", "force"],
        "terminal.read" | "steerLease.release" => &["sessionId", "tabId"],
        _ => &["sessionId"],
    };
    if params.get("force").is_some_and(|force| !force.is_boolean()) {
        bail!("The request is outside this session's scope.");
    }
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
thread_local! {
    static AFTER_ATTACHMENT: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = const { std::cell::RefCell::new(None) };
}
#[cfg(test)]
pub(crate) fn observe_attachment(callback: Box<dyn FnOnce()>) {
    AFTER_ATTACHMENT.with(|slot| *slot.borrow_mut() = Some(callback));
}
#[cfg(test)]
fn after_attachment() {
    let callback = AFTER_ATTACHMENT.with(|slot| slot.borrow_mut().take());
    if let Some(callback) = callback { callback(); }
}
