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
use super::{attachments, crypto, now_ms, slash, CloudAgents, DecisionError, Settings};
use crate::remote::collab::Role;

const LEASE_LIMIT: u32 = 16;
const ATTACHED_POLL: Duration = Duration::from_secs(3);
const IDLE_POLL: Duration = Duration::from_secs(20);
const MAX_TEXT: usize = 48 * 1024;
/// Receipt category of a message that names an image the runtime does not hold.
pub const ATTACHMENT_MISSING: &str = "attachment-missing";
/// Said when a file a message names did not reach the runtime in full (PRO-407).
pub const FILE_MISSING_MESSAGE: &str = "Not sent: a file of this message did not arrive in full. Attach it and send again.";
/// What a `follow-up` command does to a held follow-up (#1328): change its
/// text, take it out of the queue, or send it next and interrupt the turn.
pub const FOLLOW_UP_OPS: [&str; 3] = ["edit", "withdraw", "release"];
/// Receipt category of a `follow-up` command whose follow-up is no longer held.
pub const FOLLOW_UP_GONE: &str = "follow-up-gone";
pub const FOLLOW_UP_GONE_MESSAGE: &str = "That message is no longer held: it went to the agent, or was withdrawn.";
pub const FOLLOW_UP_NOT_YOURS_MESSAGE: &str = "Only whoever sent a held message, or a workspace manager, can change it.";

/// The text a command would type into the agent: a send's or steer's, or
/// the new text of a held follow-up (#1328), which is typed as it is when
/// its turn comes. Checked by the same rules either way.
fn typed_text<'a>(command: &Command<'a>) -> Option<&'a str> {
    let text = || command.plaintext.get("text").and_then(Value::as_str).unwrap_or("");
    match command.kind {
        "send" | "steer" => Some(text()),
        "follow-up" if command.plaintext.get("op").and_then(Value::as_str) == Some("edit") => Some(text()),
        _ => None,
    }
}

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
    if agents.collab().is_some_and(|collab| collab.runtime_policy.is_v2()) && lease.runtime_generation != agents.generation() {
        return finish(agents, lease, "rejected", Some("collaboration-generation-changed"), json!({}));
    }
    // Capture the server's exact v2 revision/source before decrypt/judge;
    // never manufacture explicit authority from a local role-only lookup.
    let policy_stamp = match agents.collab().filter(|collab| collab.runtime_policy.is_v2()) {
        Some(collab) => match lease_provenance(collab, lease) {
            Ok(stamp) => Some(stamp),
            Err(_) => return finish(agents, lease, "rejected", Some("collaboration-provenance-unavailable"), json!({})),
        },
        None => None,
    };
    let plaintext = match decrypt(agents, lease) {
        Ok(plaintext) => plaintext,
        Err(category) => return finish(agents, lease, "rejected", Some(category), json!({})),
    };
    // The actor's role now: stamped by the API at lease time and narrowed
    // by the runtime's latest member list (contract §21.4-21.5).
    let command = Command {
        kind: &lease.kind,
        tab_id: &lease.tab_id,
        client_command_id: id,
        actor_id: &lease.actor.user_id,
        leases: true,
        access: agents.actor_access(&lease.actor),
        policy_stamp,
        plaintext: &plaintext,
    };
    match decide(agents, &command, || agents.receipts.applying(id)) {
        Decided::Refused((outcome, category, extra)) | Decided::Applied((outcome, category, extra)) => finish(agents, lease, outcome, category, extra),
        // Without the durable mark the outcome could not be proven later,
        // so the agent was not touched: definitely not applied.
        Decided::MarkFailed => Receipt { outcome: "rejected".into(), category: Some("receipt-store-failed".into()), result_iv: None, result_ciphertext: None },
    }
}

/// One agent command, as the mailbox leases it or a live call of
/// `agent-commands/1` names it (docs/MACHINES.md, decision 3). Both mean the
/// same: one decision and one application per id, made here.
pub struct Command<'a> {
    /// `send`, `steer`, `stop`, `permission-decision` or `follow-up`.
    pub kind: &'a str,
    pub tab_id: &'a str,
    pub client_command_id: &'a str,
    /// Who sent it: their tab lease, their queued follow-up, their uploads.
    pub actor_id: &'a str,
    /// Whether the tab's driver lease (PRO-30) applies: a mailbox actor is
    /// a person, while a live connection with none (a paired computer on a
    /// machine, which serves no leases) neither holds nor waits for one.
    pub leases: bool,
    /// What they may do now.
    pub access: crate::remote::collab::Access,
    pub(crate) policy_stamp: Option<crate::remote::collab::v2::Stamp>,
    /// The command's body: `text`, `images` and settings for a send or
    /// steer, `requestId` with `optionId` or `answers` for a decision,
    /// `op` and `followUpId` (and `text` for an edit) for a follow-up.
    pub plaintext: &'a Value,
}

/// `(outcome, category, extra)`: `applied` or `rejected`, why, and what the
/// receipt says besides.
pub type Applied = (&'static str, Option<&'static str>, Value);

pub enum Decided {
    /// Refused before anything was marked: nothing reached the agent.
    Refused(Applied),
    /// The durable mark could not be written: nothing reached the agent.
    MarkFailed,
    /// Marked, then applied (or rejected while applying).
    Applied(Applied),
}

/// Decide a command that has no receipt yet and apply it. `mark` writes the
/// durable `applying` record and runs only once every check has passed,
/// right before the agent is touched.
pub fn decide(agents: &CloudAgents, command: &Command, mark: impl FnOnce() -> anyhow::Result<()>) -> Decided {
    // Same lock as policy/member replacement. Keep it through the durable
    // applying mark and synchronous ops, including settings and queue push.
    let _admission = agents.collab().map(|collab| collab.enter_admission());
    let decided = judge(agents, command, mark);
    // A message that was refused is never typed: the images its sender
    // uploaded for it are done with (PRO-22). Only their own: naming someone
    // else's upload in a refused message does not remove it.
    let rejected = match &decided {
        Decided::Refused((outcome, ..)) | Decided::Applied((outcome, ..)) => *outcome == "rejected",
        Decided::MarkFailed => true,
    };
    if rejected && command.kind == "send" {
        // Every id it names, even in a list that made it invalid.
        agents.attachments.remove_owned(command.actor_id, &attachments::named_any(command.plaintext));
    }
    decided
}

fn judge(agents: &CloudAgents, command: &Command, mark: impl FnOnce() -> anyhow::Result<()>) -> Decided {
    let refused = |category: &'static str, extra: Value| Decided::Refused(("rejected", Some(category), extra));
    let Some(tab) = agents.tab(command.tab_id) else {
        return refused("tab-unknown", json!({}));
    };
    let access = match agents.collab() {
        Some(collab) if collab.known() => command.access.meet(collab.access_of(Some(command.actor_id))),
        _ => command.access,
    };
    if let Some(collab) = agents.collab() {
        let action = if command.kind == "permission-decision" { crate::remote::collab::v2::Action::Approve } else { crate::remote::collab::v2::Action::Drive };
        let witness = agents.ops.collaboration_v2_witness(&tab.session_id, command.tab_id);
        if collab.runtime_policy.admit(command.actor_id, command.policy_stamp.as_ref(), action, witness.as_ref()).is_err() {
            return refused("collaboration-policy-changed", json!({}));
        }
        if collab.runtime_policy.everyone(command.actor_id) && typed_text(command).is_some_and(slash::is_command) {
            // Everyone-provenance input cannot use commands to change stance,
            // even when explicit approval independently remains authorized.
            if collab.runtime_policy.admit(command.actor_id, command.policy_stamp.as_ref(), crate::remote::collab::v2::Action::Configure, None).is_err() {
                return refused("approval-required", json!({}));
            }
        }
    }
    let allowed = match command.kind {
        "permission-decision" => access.can_approve,
        _ => access.can_drive(),
    };
    if !allowed {
        return refused("forbidden", json!({}));
    }
    // A held follow-up (#1328) is its sender's to change, or a manager's.
    // One that is no longer held has nothing to change.
    if command.kind == "follow-up" {
        let op = command.plaintext.get("op").and_then(Value::as_str);
        let id = command.plaintext.get("followUpId").and_then(Value::as_str).filter(|id| !id.is_empty());
        let (Some(op), Some(id)) = (op, id) else { return refused("payload-invalid", json!({})) };
        if !FOLLOW_UP_OPS.contains(&op) {
            return refused("payload-invalid", json!({}));
        }
        let Some(held) = agents.follow_ups.get(command.tab_id, id) else {
            return refused(FOLLOW_UP_GONE, json!({ "followUpId": id, "message": FOLLOW_UP_GONE_MESSAGE }));
        };
        if !held.actor_id.is_empty() && held.actor_id != command.actor_id && access.role != Role::Manager {
            return refused("forbidden", json!({ "followUpId": id, "message": FOLLOW_UP_NOT_YOURS_MESSAGE }));
        }
    }
    // Competing input is serialized by the tab's driver lease: nobody else
    // sends, steers or stops (managers may stop) while it is held, and an
    // applied send or steer claims it (below). Whether a turn ran is read
    // before this command starts one: only a lease live then counts.
    let busy_before = agents.ops.busy(&tab.session_id, command.tab_id);
    if let (Some(collab), true, "send" | "steer" | "stop" | "follow-up") = (agents.collab(), command.leases, command.kind) {
        let busy = busy_before;
        // A manager may stop, and change held follow-ups (#1328), whoever drives.
        let held = collab
            .held_by_other(command.tab_id, command.actor_id, now_ms(), busy)
            .filter(|_| !(matches!(command.kind, "stop" | "follow-up") && access.role == Role::Manager));
        if let Some(held) = held {
            return refused("lease-held", json!({ "holderId": held.holder_id }));
        }
    }
    // The CLI runs a slash command, a `!` shell command or an `@/path`
    // mention by itself, and each can change or get around the same
    // settings: from a plain driver only the harmless ones go through
    // (PRO-88). Refused before the applying mark: nothing reached the agent.
    if let Some(text) = typed_text(command) {
        if let Some(refusal) = agents.slash_refusal(access, &tab.session_id, &tab.harness, text) {
            return refused(refusal.category(), json!({ "command": refusal.command, "message": refusal.message() }));
        }
    }
    // A steer goes into the running turn, where the session's own queue
    // holds it until the turn ends; nothing re-checks that queue, so a slash
    // or `!` command would still run after its sender lost the right to send
    // it. It is not queued at all, whoever sends it (a `send` waits in the
    // follow-up queue, which is re-checked).
    if command.kind == "steer" && busy_before && slash::is_command(command.plaintext.get("text").and_then(Value::as_str).unwrap_or("")) {
        return refused(slash::NOT_QUEUED_CATEGORY, json!({ "message": slash::NOT_QUEUED_MESSAGE }));
    }
    if let Some(permit) = crate::remote::collab::v2::current() {
        let witness = agents.ops.collaboration_v2_witness(&tab.session_id, command.tab_id);
        if permit.check(witness.as_ref()).is_err() {
            return refused("collaboration-policy-changed", json!({}));
        }
    }
    if let Err(error) = mark() {
        log::error!("record applying {}: {error:#}", command.client_command_id);
        return Decided::MarkFailed;
    }
    // Model, effort and permission mode change what the agent may do on its
    // own: only a manager or someone who may approve permissions sets them
    // (the live `session.configure` needs manage). A driver's send still
    // goes through, without them.
    let may_configure = access.can_configure() && agents.collab().is_none_or(|collab|
        collab.runtime_policy.admit(command.actor_id, command.policy_stamp.as_ref(), crate::remote::collab::v2::Action::Configure, None).is_ok());
    let permit = crate::remote::collab::v2::current().or_else(|| agents.collab().map(|collab| crate::remote::collab::v2::Permit::new(
        collab.clone(), command.actor_id, command.policy_stamp.clone(), action_for(command.kind))));
    let (outcome, category, extra) = match permit {
        Some(permit) => permit.with(|| apply(agents, command, &tab.session_id, may_configure)),
        None => apply(agents, command, &tab.session_id, may_configure),
    };
    // Only input that reached the agent (or its queue) claims the tab.
    if let (Some(collab), true, "applied", "send" | "steer") = (agents.collab(), command.leases, outcome, command.kind) {
        let _ = collab.claim(command.tab_id, command.actor_id, now_ms(), busy_before, false);
    }
    Decided::Applied((outcome, category, extra))
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

fn apply(agents: &CloudAgents, command: &Command, session_id: &str, may_configure: bool) -> Applied {
    let tab_id = command.tab_id;
    let plaintext = command.plaintext;
    let ops = &agents.ops;
    // A message is text, images, or both (as a local tab's composer sends).
    let text = |with_images: bool| -> Option<String> {
        let text = plaintext.get("text").and_then(Value::as_str).or(with_images.then_some(""))?;
        ((with_images || !text.trim().is_empty()) && text.len() <= MAX_TEXT).then(|| text.to_string())
    };
    let failed = |error: anyhow::Error| -> Applied {
        log::warn!("apply {} {}: {error:#}", command.kind, command.client_command_id);
        ("rejected", Some("apply-failed"), json!({ "message": crate::remote::protocol::redact(&format!("{error:#}")) }))
    };
    let result = match command.kind {
        "send" | "steer" => {
            // Images and files ride with a prompt, never with a steer into a running turn.
            let (image_ids, file_ids) = match (attachments::named(plaintext), attachments::named_files(plaintext)) {
                (Some(images), Some(files)) if (images.is_empty() && files.is_empty()) || command.kind == "send" => (images, files),
                _ => return ("rejected", Some("payload-invalid"), json!({})),
            };
            let Some(text) = text(!image_ids.is_empty() || !file_ids.is_empty()) else { return ("rejected", Some("payload-invalid"), json!({})) };
            // Uploaded by the sender, in full, before the message: checked
            // before anything about the tab changes.
            let images = match agents.attachments.load(command.actor_id, &image_ids) {
                Ok(images) => images,
                Err(_) => {
                    return (
                        "rejected",
                        Some(ATTACHMENT_MISSING),
                        json!({ "message": "Not sent: an image of this message did not reach the workspace. Attach it and send again." }),
                    )
                }
            };
            if agents.attachments.check_files(command.actor_id, &file_ids).is_err() {
                return ("rejected", Some(ATTACHMENT_MISSING), json!({ "message": FILE_MISSING_MESSAGE }));
            }
            let settings = match Settings::from_json(plaintext) {
                Ok(settings) => settings,
                Err(_) => return ("rejected", Some("payload-invalid"), json!({})),
            };
            let settings_ignored = !settings.is_empty() && !may_configure;
            if settings_ignored {
                log::warn!("{} {}: settings ignored, the actor may not configure the tab", command.kind, command.client_command_id);
            } else if !settings.is_empty() {
                if let Some(model) = &settings.model {
                    let Some(tab) = agents.tab(tab_id) else { return failed(anyhow::anyhow!("no such tab")) };
                    if let Err(error) = crate::harness::claude::models::validate(&tab.harness, model) {
                        return failed(error);
                    }
                }
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
            let queue = command.kind == "send" && (ops.busy(session_id, tab_id) || !agents.follow_ups.list(tab_id).is_empty());
            // Into the session's attachments folder here, queued or not: the
            // agent is handed their paths on this computer (PRO-407).
            let files = match agents.attachments.take_files(command.actor_id, session_id, &file_ids) {
                Ok(files) => files,
                Err(attachments::FilesError::Missing(_)) => return ("rejected", Some(ATTACHMENT_MISSING), json!({ "message": FILE_MISSING_MESSAGE })),
                Err(attachments::FilesError::Failed(error)) => return failed(error),
            };
            if queue {
                let follow_up = FollowUp {
                    policy_stamp: command.policy_stamp.clone(),
                    client_command_id: command.client_command_id.to_string(),
                    session_id: session_id.to_string(),
                    text,
                    actor_id: command.actor_id.to_string(),
                    images: image_ids,
                    files,
                };
                if let Err(error) = agents.follow_ups.push(tab_id, follow_up) {
                    return failed(error);
                }
                // The turn may have ended between the check and the push.
                agents.nudge_follow_ups(tab_id);
                ("applied", None, mark(json!({ "queued": true })))
            } else {
                let sent = ops.send_attached(session_id, tab_id, &text, images, files);
                // Typed or not, this message is settled: its uploads are done with.
                agents.attachments.remove(&image_ids);
                match sent {
                    Ok(()) => ("applied", None, mark(json!({ "queued": false }))),
                    Err(error) => failed(error),
                }
            }
        }
        "stop" => {
            let dropped = agents.follow_ups.clear(tab_id).unwrap_or_default();
            for follow_up in &dropped {
                ops.note(session_id, tab_id, &format!("Stopped before sending a queued message: {}", preview(&follow_up.text)));
                agents.attachments.remove(&follow_up.images);
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
        "follow-up" => {
            // Checked by `judge`: a known op, and a follow-up that was held then.
            let op = plaintext.get("op").and_then(Value::as_str).unwrap_or("");
            let id = plaintext.get("followUpId").and_then(Value::as_str).unwrap_or("");
            let gone = || ("rejected", Some(FOLLOW_UP_GONE), json!({ "followUpId": id, "message": FOLLOW_UP_GONE_MESSAGE }));
            let Some(held) = agents.follow_ups.get(tab_id, id) else { return gone() };
            match op {
                "edit" => {
                    // As a message: words, unless it carries images or files.
                    let Some(text) = text(!held.images.is_empty() || !held.files.is_empty()) else { return ("rejected", Some("payload-invalid"), json!({})) };
                    match agents.follow_ups.edit(tab_id, id, &text) {
                        Ok(true) => ("applied", None, json!({ "followUpId": id })),
                        Ok(false) => gone(),
                        Err(error) => failed(error),
                    }
                }
                "withdraw" => match agents.follow_ups.remove(tab_id, id) {
                    Ok(Some(withdrawn)) => {
                        // Never typed: its uploads are done with.
                        agents.attachments.remove(&withdrawn.images);
                        ("applied", None, json!({ "followUpId": id }))
                    }
                    Ok(None) => gone(),
                    Err(error) => failed(error),
                },
                "release" => match agents.follow_ups.to_front(tab_id, id) {
                    // First in line, then the running turn is interrupted
                    // (Escape, #427): the queue sends it once the turn has
                    // settled, as it sends any follow-up. An idle tab sends it now.
                    Ok(true) => {
                        let interrupted = if ops.busy(session_id, tab_id) {
                            match ops.interrupt(session_id, tab_id) {
                                Ok(interrupted) => interrupted,
                                Err(error) => return failed(error),
                            }
                        } else {
                            false
                        };
                        agents.nudge_follow_ups(tab_id);
                        ("applied", None, json!({ "followUpId": id, "interrupted": interrupted }))
                    }
                    Ok(false) => gone(),
                    Err(error) => failed(error),
                },
                _ => ("rejected", Some("payload-invalid"), json!({})),
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

fn action_for(kind: &str) -> crate::remote::collab::v2::Action {
    if kind == "permission-decision" { crate::remote::collab::v2::Action::Approve } else { crate::remote::collab::v2::Action::Drive }
}

fn lease_provenance(collab: &crate::remote::collab::Collaboration, lease: &Lease) -> anyhow::Result<crate::remote::collab::v2::Stamp> {
    use anyhow::Context;
    use crate::remote::collab::v2::Member;
    let actor = &lease.actor;
    let revision = actor.collaboration_revision.as_deref().context("missing lease revision")?;
    let role = actor.role.as_ref().context("missing lease role")?;
    let role = serde_json::from_value(serde_json::Value::String(role.clone()))?;
    let member = Member {
        user_id: actor.user_id.clone(), role,
        can_approve: actor.can_approve.context("missing independent lease approval")?,
        write_source: actor.write_source.context("missing lease drive source")?,
    };
    collab.runtime_policy.lease_stamp(revision, lease.runtime_generation, member)
}
