//! Lease → apply → receipt → ack (contract §11.3-11.4).
//!
//! The server guarantees one live lease per command and ordered lanes per
//! tab; this side makes application exactly-once with the durable receipt
//! store: `applying` is fsynced before the agent is touched, the receipt
//! after, and a redelivered command is answered from its receipt.

use std::collections::HashMap;
use std::time::Duration;

use serde_json::{json, Value};

use super::api::{Ack, AckOutcome, CallError, Lease};
use super::receipts::{FollowUp, Known, Receipt};
use super::{crypto, now_ms, slash, CloudAgents, DecisionError, Settings};
use crate::remote::collab::Role;

const LEASE_LIMIT: u32 = 16;
const ATTACHED_POLL: Duration = Duration::from_secs(3);
const IDLE_POLL: Duration = Duration::from_secs(20);
const MAX_TEXT: usize = 48 * 1024;

pub fn run(agents: &CloudAgents) {
    let mut failures = 0u32;
    // Acks that failed in transit, retried with the same token and bytes.
    let mut unacked: Vec<(Lease, Receipt)> = Vec::new();
    loop {
        let busy = match poll_once(agents, &mut unacked) {
            Ok(leased) => {
                failures = 0;
                leased
            }
            Err(error) => {
                failures = failures.saturating_add(1);
                log::warn!("agent mailbox: {error}");
                false
            }
        };
        if busy {
            continue;
        }
        let wait = if failures > 0 {
            crate::remote::protocol::backoff(failures, 0.5).max(Duration::from_secs(1))
        } else if agents.attached() > 0 {
            ATTACHED_POLL
        } else {
            IDLE_POLL
        };
        agents.poll.wait(wait);
    }
}

/// One lease round. `Ok(true)` when anything was leased, so the caller
/// leases again at once.
pub fn poll_once(agents: &CloudAgents, unacked: &mut Vec<(Lease, Receipt)>) -> Result<bool, CallError> {
    let Some(api) = agents.api.as_ref() else { return Ok(false) };
    let retry: Vec<(Lease, Receipt)> = std::mem::take(unacked);
    for (lease, receipt) in retry {
        if let Err(CallError::Transient(error)) = settle(agents, &lease, &receipt) {
            log::warn!("ack {}: {error:#}", lease.client_command_id);
            unacked.push((lease, receipt));
        }
    }
    // Quiesced for an archive: what is queued stays in the mailbox.
    if agents.quiesced() {
        return Ok(false);
    }
    let leased = api.lease(agents.receipts.incarnation(), LEASE_LIMIT)?;
    for id in &leased.outcome_unknown {
        log::warn!("agent command {id} settled as outcome-unknown by the server (its receipts were in another store)");
    }
    let any = !leased.leases.is_empty();
    let mut leases = leased.leases;
    leases.sort_by_key(|lease| lease.sequence);
    for lease in leases {
        let receipt = handle(agents, &lease);
        match settle(agents, &lease, &receipt) {
            Ok(()) => {}
            Err(CallError::Transient(error)) => {
                log::warn!("ack {}: {error:#}", lease.client_command_id);
                unacked.push((lease, receipt));
            }
            Err(CallError::Rejected) => return Err(CallError::Rejected),
            // Only launch calls answer this; an ack never does.
            Err(CallError::Settled(_)) => {}
        }
    }
    Ok(any)
}

fn settle(agents: &CloudAgents, lease: &Lease, receipt: &Receipt) -> Result<(), CallError> {
    let api = agents.api.as_ref().expect("the mailbox runs with an API");
    let ack = Ack {
        outcome: receipt.outcome.clone(),
        category: receipt.category.clone(),
        result_iv: receipt.result_iv.clone(),
        result_ciphertext: receipt.result_ciphertext.clone(),
    };
    match api.ack(&lease.command_id, &lease.lease_token, &ack)? {
        AckOutcome::Settled => {
            let _ = agents.receipts.acked(&lease.client_command_id);
        }
        // Redelivered to someone else, settled differently, or unknown:
        // nothing more to do with this lease.
        AckOutcome::StaleLease | AckOutcome::NotFound => {}
        // Leased under an older generation: the redelivery to this one is
        // answered from the stored receipt.
        AckOutcome::StaleGeneration => agents.poll.raise(),
    }
    Ok(())
}

/// The receipt for a lease: stored, or made by applying it now.
pub fn handle(agents: &CloudAgents, lease: &Lease) -> Receipt {
    let id = lease.client_command_id.as_str();
    match agents.receipts.known(id) {
        Known::Receipt(receipt) => return receipt,
        // Died mid-apply. A stop is safe to repeat; anything else might
        // already have reached the agent and is never applied twice.
        Known::Interrupted if lease.kind != "stop" => {
            return finish(agents, lease, "outcome-unknown", Some("runtime-interrupted"), json!({}));
        }
        Known::Interrupted | Known::New => {}
    }
    let plaintext = match decrypt(agents, lease) {
        Ok(plaintext) => plaintext,
        Err(category) => return finish(agents, lease, "rejected", Some(category), json!({})),
    };
    let Some(tab) = agents.tab(&lease.tab_id) else {
        return finish(agents, lease, "rejected", Some("tab-unknown"), json!({}));
    };
    // The actor's role now: stamped by the API at lease time and narrowed
    // by the runtime's latest member list (contract §21.4-21.5).
    let access = agents.actor_access(&lease.actor);
    let allowed = match lease.kind.as_str() {
        "permission-decision" => access.can_approve,
        _ => access.can_drive(),
    };
    if !allowed {
        return finish(agents, lease, "rejected", Some("forbidden"), json!({}));
    }
    // Competing input is serialized by the tab's driver lease: nobody else
    // sends, steers or stops (managers may stop) while it is held, and an
    // applied send or steer claims it (below). Whether a turn ran is read
    // before this command starts one: only a lease live then counts.
    let busy_before = agents.ops.busy(&tab.session_id, &lease.tab_id);
    if let (Some(collab), "send" | "steer" | "stop") = (agents.collab(), lease.kind.as_str()) {
        let busy = busy_before;
        let held = collab
            .held_by_other(&lease.tab_id, &lease.actor.user_id, now_ms(), busy)
            .filter(|_| !(lease.kind == "stop" && access.role == Role::Manager));
        if let Some(held) = held {
            return finish(agents, lease, "rejected", Some("lease-held"), json!({ "holderId": held.holder_id }));
        }
    }
    // The CLI runs a slash command, a `!` shell command or an `@/path`
    // mention by itself, and each can change or get around the same
    // settings: from a plain driver only the harmless ones go through
    // (PRO-88). Refused before the applying mark: nothing reached the agent.
    if matches!(lease.kind.as_str(), "send" | "steer") {
        let text = plaintext.get("text").and_then(Value::as_str).unwrap_or("");
        if let Some(refusal) = agents.slash_refusal(access, &tab.session_id, &tab.harness, text) {
            return finish(agents, lease, "rejected", Some(refusal.category()), json!({ "command": refusal.command, "message": refusal.message() }));
        }
    }
    // A steer goes into the running turn, where the session's own queue
    // holds it until the turn ends; nothing re-checks that queue, so a slash
    // or `!` command would still run after its sender lost the right to send
    // it. It is not queued at all, whoever sends it (a `send` waits in the
    // follow-up queue, which is re-checked).
    if lease.kind == "steer" && busy_before && slash::is_command(plaintext.get("text").and_then(Value::as_str).unwrap_or("")) {
        return finish(agents, lease, "rejected", Some(slash::NOT_QUEUED_CATEGORY), json!({ "message": slash::NOT_QUEUED_MESSAGE }));
    }
    if let Err(error) = agents.receipts.applying(id) {
        // Without the durable mark the outcome could not be proven later,
        // so the agent is not touched: definitely not applied.
        log::error!("record applying {id}: {error:#}");
        return Receipt { outcome: "rejected".into(), category: Some("receipt-store-failed".into()), result_iv: None, result_ciphertext: None };
    }
    // Model, effort and permission mode change what the agent may do on its
    // own: only a manager or someone who may approve permissions sets them
    // (the live `session.configure` needs manage). A driver's send still
    // goes through, without them.
    let may_configure = access.can_configure();
    let (outcome, category, extra) = apply(agents, lease, &tab.session_id, &plaintext, may_configure);
    // Only input that reached the agent (or its queue) claims the tab.
    if let (Some(collab), "applied", "send" | "steer") = (agents.collab(), outcome, lease.kind.as_str()) {
        let _ = collab.claim(&lease.tab_id, &lease.actor.user_id, now_ms(), busy_before, false);
    }
    finish(agents, lease, outcome, category, extra)
}

fn decrypt(agents: &CloudAgents, lease: &Lease) -> Result<Value, &'static str> {
    let identity = agents.identity.as_ref().ok_or("key-unknown")?;
    let key = agents.keys.for_command(&lease.key_id, lease.created_at).ok_or("key-unknown")?;
    if lease.ciphertext.is_empty() {
        return Err("payload-invalid");
    }
    let aad = crypto::command_aad(
        &identity.organization_id,
        &identity.workspace_id,
        &lease.tab_id,
        &lease.client_command_id,
        &lease.kind,
        &lease.key_id,
    );
    let bytes = crypto::open(&key, &lease.iv, &lease.ciphertext, &aad).map_err(|_| "decrypt-failed")?;
    crypto::parse_v1(&bytes).map_err(|_| "payload-invalid")
}

type Applied = (&'static str, Option<&'static str>, Value);

fn apply(agents: &CloudAgents, lease: &Lease, session_id: &str, plaintext: &Value, may_configure: bool) -> Applied {
    let tab_id = lease.tab_id.as_str();
    let ops = &agents.ops;
    let text = || -> Option<String> {
        plaintext.get("text").and_then(Value::as_str).filter(|text| !text.trim().is_empty() && text.len() <= MAX_TEXT).map(str::to_string)
    };
    let failed = |error: anyhow::Error| -> Applied {
        log::warn!("apply {} {}: {error:#}", lease.kind, lease.client_command_id);
        ("rejected", Some("apply-failed"), json!({ "message": crate::remote::protocol::redact(&format!("{error:#}")) }))
    };
    let result = match lease.kind.as_str() {
        "send" | "steer" => {
            let Some(text) = text() else { return ("rejected", Some("payload-invalid"), json!({})) };
            let settings = match Settings::from_json(plaintext) {
                Ok(settings) => settings,
                Err(_) => return ("rejected", Some("payload-invalid"), json!({})),
            };
            let settings_ignored = !settings.is_empty() && !may_configure;
            if settings_ignored {
                log::warn!("{} {}: settings ignored, the actor may not configure the tab", lease.kind, lease.client_command_id);
            } else if !settings.is_empty() {
                if let Err(error) = ops.configure(session_id, tab_id, &settings) {
                    return failed(error);
                }
            }
            let mark = |mut extra: Value| {
                if settings_ignored {
                    extra["settingsIgnored"] = json!(true);
                }
                extra
            };
            let queue = lease.kind == "send" && (ops.busy(session_id, tab_id) || !agents.follow_ups.list(tab_id).is_empty());
            if queue {
                let follow_up = FollowUp {
                    client_command_id: lease.client_command_id.clone(),
                    session_id: session_id.to_string(),
                    text,
                    actor_id: lease.actor.user_id.clone(),
                };
                if let Err(error) = agents.follow_ups.push(tab_id, follow_up) {
                    return failed(error);
                }
                // The turn may have ended between the check and the push.
                agents.nudge_follow_ups(tab_id);
                ("applied", None, mark(json!({ "queued": true })))
            } else {
                match ops.send(session_id, tab_id, &text) {
                    Ok(()) => ("applied", None, mark(json!({ "queued": false }))),
                    Err(error) => failed(error),
                }
            }
        }
        "stop" => {
            let dropped = agents.follow_ups.clear(tab_id).unwrap_or_default();
            for follow_up in &dropped {
                ops.note(session_id, tab_id, &format!("Stopped before sending a queued message: {}", preview(&follow_up.text)));
            }
            match ops.stop(session_id, tab_id) {
                Ok(()) => (
                    "applied",
                    None,
                    json!({ "droppedFollowUps": dropped.iter().map(|f| f.client_command_id.clone()).collect::<Vec<_>>() }),
                ),
                Err(error) => failed(error),
            }
        }
        "permission-decision" => {
            let Some(request_id) = plaintext.get("requestId").and_then(Value::as_str) else {
                return ("rejected", Some("payload-invalid"), json!({}));
            };
            let outcome = if let Some(answers) = plaintext.get("answers") {
                match serde_json::from_value::<HashMap<String, String>>(answers.clone()) {
                    Ok(answers) => ops.answer(session_id, tab_id, request_id, answers),
                    Err(_) => return ("rejected", Some("payload-invalid"), json!({})),
                }
            } else {
                match plaintext.get("optionId").and_then(Value::as_str) {
                    Some(option) => ops.respond(session_id, tab_id, request_id, option),
                    None => return ("rejected", Some("payload-invalid"), json!({})),
                }
            };
            match outcome {
                Ok(()) => ("applied", None, json!({ "requestId": request_id })),
                Err(DecisionError::NotPending) => ("rejected", Some("request-not-pending"), json!({ "requestId": request_id })),
                Err(DecisionError::Failed(error)) => failed(error),
            }
        }
        _ => ("rejected", Some("payload-invalid"), json!({})),
    };
    agents.changed(Some(tab_id), true);
    result
}

fn preview(text: &str) -> String {
    let line = text.lines().next().unwrap_or("");
    if line.chars().count() > 80 {
        format!("{}…", line.chars().take(80).collect::<String>())
    } else {
        line.to_string()
    }
}

/// Seal the receipt for the client, record it durably, and return it.
fn finish(agents: &CloudAgents, lease: &Lease, outcome: &str, category: Option<&str>, extra: Value) -> Receipt {
    let mut body = json!({ "v": 1, "outcome": outcome, "at": now_ms() });
    if let Some(category) = category {
        body["category"] = json!(category);
    }
    if let Value::Object(fields) = extra {
        for (name, value) in fields {
            body[name] = value;
        }
    }
    // Under the command's own key, which its author holds. A command whose
    // key is unknown gets a receipt without a body.
    let sealed = match (&agents.identity, agents.keys.get(&lease.key_id)) {
        (Some(identity), Some(key)) => {
            let aad = crypto::receipt_aad(&identity.organization_id, &identity.workspace_id, &lease.client_command_id, outcome, &lease.key_id);
            crypto::seal(&key, body.to_string().as_bytes(), &aad).ok()
        }
        _ => None,
    };
    let receipt = Receipt {
        outcome: outcome.to_string(),
        category: category.map(str::to_string),
        result_iv: sealed.as_ref().map(|(iv, _)| iv.clone()),
        result_ciphertext: sealed.map(|(_, ciphertext)| ciphertext),
    };
    if let Err(error) = agents.receipts.record(&lease.client_command_id, &receipt) {
        // The agent was (or was not) touched; without a durable receipt a
        // redelivery must not apply it again, and the applying mark says so.
        log::error!("record receipt {}: {error:#}", lease.client_command_id);
    }
    receipt
}

#[cfg(test)]
#[path = "mailbox_tests.rs"]
mod tests;
