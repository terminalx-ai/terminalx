use crate::paths::Canonical;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::super::api::{Actor, Ack, AckOutcome, CallError, Checkpoint, Leased, MailboxApi, PutOutcome};
use super::super::{checkpoints, crypto, AgentOps, AgentTabInfo, CloudAgents, DecisionError, Identity, Settings};
use super::*;
use crate::store::index::TabStatus;

/// An image as it reached the agent: media type, base64, name.
type SentImage = (String, String, Option<String>);

#[derive(Default)]
struct FakeOps {
    v2_witnesses: Mutex<HashMap<String, crate::remote::collab::v2::TabWitness>>,
    second_tab: Mutex<bool>,
    busy: Mutex<bool>,
    sent: Mutex<Vec<String>>,
    /// The images of each sent message: (media type, base64, name).
    images: Mutex<Vec<Vec<SentImage>>>,
    /// The files of each sent message (PRO-407), as stored for its session.
    files: Mutex<Vec<Vec<crate::events::FileRef>>>,
    /// Who each sent message is recorded as from (PRO-141).
    actors: Mutex<Vec<String>>,
    stops: Mutex<u32>,
    /// Escapes sent to a running turn (#427).
    interrupts: Mutex<u32>,
    pending: Mutex<Vec<String>>,
    decisions: Mutex<Vec<(String, String)>>,
    notes: Mutex<Vec<String>>,
    settings: Mutex<Vec<Settings>>,
    /// The tab's agent; empty means Claude Code.
    harness: Mutex<String>,
    /// Where the session's agent runs.
    cwd: Mutex<Option<std::path::PathBuf>>,
}

impl AgentOps for FakeOps {
    fn collaboration_v2_witness(&self, _: &str, tab_id: &str) -> Option<crate::remote::collab::v2::TabWitness> {
        self.v2_witnesses.lock().unwrap().get(tab_id).cloned()
    }
    fn tabs(&self) -> Vec<AgentTabInfo> {
        let mut tabs = vec![AgentTabInfo {
            session_id: "s1".into(),
            tab_id: "tab-1".into(),
            title: None,
            harness: Some(self.harness.lock().unwrap().clone()).filter(|harness| !harness.is_empty()).unwrap_or_else(|| "claude".into()),
            transport: Default::default(),
            model: String::new(),
            effort: None, requested_model: None, requested_effort: None, requested_permission_mode: None,
            permission_mode: "default".into(),
            status: if *self.busy.lock().unwrap() { TabStatus::InProgress } else { TabStatus::Idle },
            process: "running",
            pending_permissions: Vec::new(),
            follow_ups: Vec::new(),
            lease: None,
            sign_in: None,
            login: None,
            last_seq: 0,
            created: String::new(),
            modified: String::new(),
            last_message_at: None,
            has_messages: true,
            session_created: None,
            session_last_message_at: None,
            session_has_messages: true,
            history: None,
            reset: None,
        }];
        if *self.second_tab.lock().unwrap() {
            let mut second = tabs[0].clone();
            second.tab_id = "tab-2".into();
            tabs.push(second);
        }
        tabs
    }
    fn busy(&self, _: &str, _: &str) -> bool {
        *self.busy.lock().unwrap()
    }
    fn send(&self, _: &str, _: &str, text: &str) -> anyhow::Result<()> {
        self.sent.lock().unwrap().push(text.into());
        *self.busy.lock().unwrap() = true;
        Ok(())
    }
    fn send_with_images(&self, session_id: &str, tab_id: &str, text: &str, images: Vec<crate::session::ImageInput>) -> anyhow::Result<()> {
        self.images.lock().unwrap().push(images.into_iter().map(|image| (image.media_type, image.data, image.name)).collect());
        self.send(session_id, tab_id, text)
    }
    fn send_attached(&self, session_id: &str, tab_id: &str, text: &str, images: Vec<crate::session::ImageInput>, files: Vec<crate::events::FileRef>) -> anyhow::Result<()> {
        self.files.lock().unwrap().push(files);
        self.send_with_images(session_id, tab_id, text, images)
    }
    fn send_attached_by(&self, session_id: &str, tab_id: &str, text: &str, images: Vec<crate::session::ImageInput>, files: Vec<crate::events::FileRef>, actor_id: &str) -> anyhow::Result<()> {
        self.actors.lock().unwrap().push(actor_id.into());
        self.send_attached(session_id, tab_id, text, images, files)
    }
    fn stop(&self, _: &str, _: &str) -> anyhow::Result<()> {
        *self.stops.lock().unwrap() += 1;
        *self.busy.lock().unwrap() = false;
        Ok(())
    }
    /// The turn is told to stop; it settles later, as a real one does.
    fn interrupt(&self, _: &str, _: &str) -> anyhow::Result<bool> {
        *self.interrupts.lock().unwrap() += 1;
        Ok(*self.busy.lock().unwrap())
    }
    fn respond(&self, _: &str, _: &str, request_id: &str, option_id: &str) -> Result<(), DecisionError> {
        let mut pending = self.pending.lock().unwrap();
        let Some(at) = pending.iter().position(|id| id == request_id) else { return Err(DecisionError::NotPending) };
        pending.remove(at);
        self.decisions.lock().unwrap().push((request_id.into(), option_id.into()));
        Ok(())
    }
    fn answer(&self, _: &str, _: &str, _: &str, _: HashMap<String, String>) -> Result<(), DecisionError> {
        Err(DecisionError::NotPending)
    }
    fn configure(&self, _: &str, _: &str, settings: &Settings) -> anyhow::Result<()> {
        self.settings.lock().unwrap().push(settings.clone());
        Ok(())
    }
    fn note(&self, _: &str, _: &str, text: &str) {
        self.notes.lock().unwrap().push(text.into());
    }
    fn cwd(&self, _: &str) -> Option<std::path::PathBuf> {
        self.cwd.lock().unwrap().clone()
    }
    fn session(&self, session_id: &str) -> Option<super::super::SessionSummary> {
        (session_id == "s1").then(|| super::super::SessionSummary { title: "Fix the login".into(), branch: Some("terminalx/fix-login".into()) })
    }
    fn events(&self, _: &str, _: &str) -> anyhow::Result<Vec<Value>> {
        let mut events: Vec<Value> =
            (1..=3).map(|seq| json!({ "seq": seq, "payload": { "type": "assistant_text", "text": format!("line {seq}") } })).collect();
        let notes = self.notes.lock().unwrap();
        events.extend(notes.iter().enumerate().map(|(at, text)| json!({ "seq": 4 + at, "payload": { "type": "status", "text": text } })));
        Ok(events)
    }
}

/// The server half, as the contract describes it, in memory.
#[derive(Default)]
struct FakeApi {
    queue: Mutex<Vec<Lease>>,
    acks: Mutex<Vec<(String, String, Ack)>>,
    fail_acks: Mutex<u32>,
    stale_generation_once: Mutex<bool>,
    checkpoints: Mutex<Vec<(String, Checkpoint)>>,
    stale_puts: Mutex<u32>,
    failing_puts: Mutex<u32>,
}

impl MailboxApi for FakeApi {
    fn lease(&self, _: &str, _: u32) -> Result<Leased, CallError> {
        Ok(Leased { leases: std::mem::take(&mut *self.queue.lock().unwrap()), outcome_unknown: Vec::new() })
    }
    fn ack(&self, command_id: &str, token: &str, ack: &Ack) -> Result<AckOutcome, CallError> {
        self.acks.lock().unwrap().push((command_id.into(), token.into(), ack.clone()));
        let mut failing = self.fail_acks.lock().unwrap();
        if *failing > 0 {
            *failing -= 1;
            return Err(CallError::Transient(anyhow::anyhow!("network")));
        }
        if std::mem::take(&mut *self.stale_generation_once.lock().unwrap()) {
            return Ok(AckOutcome::StaleGeneration);
        }
        Ok(AckOutcome::Settled)
    }
    fn put_checkpoint(&self, tab_id: &str, checkpoint: &Checkpoint) -> Result<PutOutcome, CallError> {
        {
            let mut failing = self.failing_puts.lock().unwrap();
            if *failing > 0 {
                *failing -= 1;
                return Err(CallError::Transient(anyhow::anyhow!("network")));
            }
        }
        let mut stale = self.stale_puts.lock().unwrap();
        if *stale > 0 {
            *stale -= 1;
            return Ok(PutOutcome::Stale);
        }
        self.checkpoints.lock().unwrap().push((tab_id.into(), checkpoint.clone()));
        Ok(PutOutcome::Stored)
    }
    fn delete_checkpoint(&self, _: &str) -> Result<(), CallError> {
        Ok(())
    }
}

struct Harness {
    _dir: tempfile::TempDir,
    agents: Arc<CloudAgents>,
    ops: Arc<FakeOps>,
    api: Arc<FakeApi>,
}

fn identity() -> Identity {
    Identity { organization_id: "org_1".into(), workspace_id: "ws_1".into() }
}

fn harness() -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let ops = Arc::new(FakeOps::default());
    let api = Arc::new(FakeApi::default());
    let agents = CloudAgents::open(dir.path(), ops.clone(), None, Some((api.clone(), identity())), 7).unwrap();
    Harness { _dir: dir, agents, ops, api }
}

fn reopen(h: &Harness) -> Arc<CloudAgents> {
    CloudAgents::open(h._dir.path(), h.ops.clone(), None, Some((h.api.clone(), identity())), 7).unwrap()
}

/// A lease as a client would have made it: the command encrypted under
/// the runtime's current key.
fn lease(agents: &CloudAgents, id: &str, kind: &str, body: Value) -> Lease {
    lease_for(agents, id, "tab-1", kind, body)
}

fn lease_for(agents: &CloudAgents, id: &str, tab_id: &str, kind: &str, body: Value) -> Lease {
    let (key_id, key) = agents.keys.current().unwrap();
    let aad = crypto::command_aad("org_1", "ws_1", tab_id, id, kind, &key_id);
    let (iv, ciphertext) = crypto::seal(&key, body.to_string().as_bytes(), &aad).unwrap();
    Lease {
        command_id: format!("command_{id}"),
        client_command_id: id.into(),
        tab_id: tab_id.into(),
        kind: kind.into(),
        sequence: 1,
        key_id,
        iv,
        ciphertext,
        actor: Actor { collaboration_revision: None, write_source: None, user_id: "u1".into(), authority: "manage".into(), role: None, can_approve: None },
        created_at: now_ms(),
        redelivery: false,
        lease_token: format!("token-{id}"),
        runtime_generation: 7,
    }
}

fn open_receipt(agents: &CloudAgents, lease: &Lease, receipt: &Receipt) -> Value {
    let key = agents.keys.get(&lease.key_id).unwrap();
    let aad = crypto::receipt_aad("org_1", "ws_1", &lease.client_command_id, &receipt.outcome, &lease.key_id);
    let bytes = crypto::open(&key, receipt.result_iv.as_ref().unwrap(), receipt.result_ciphertext.as_ref().unwrap(), &aad).unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

fn v2_snapshot(revision: &str, role: &str, can_approve: bool, source: Value) -> crate::remote::collab::v2::Snapshot {
    serde_json::from_value(json!({"v": 2, "revision": revision, "members": [
        crate::remote::collab::v2::member_fixture(json!({"userId": "u1", "role": role, "canApprove": can_approve, "writeSource": source}))
    ]})).unwrap()
}

fn v2_collaboration(h: &Harness, snapshot: crate::remote::collab::v2::Snapshot) -> Arc<crate::remote::collab::Collaboration> {
    let collab = Arc::new(crate::remote::collab::Collaboration::new());
    h.agents.share_collaboration(collab.clone());
    collab.install_v2(snapshot).unwrap();
    collab
}

fn v2_safe_witness() -> crate::remote::collab::v2::TabWitness {
    crate::remote::collab::v2::TabWitness {
        owned: true, harness: "claude".into(), stored_mode: "manual".into(), pending_mode: None,
        actual: Some(crate::harness::settings::Stance::Mode { mode: "default".into() }),
    }
}

#[test]
fn phase2_collaboration_v2_encrypted_mailbox_manager_false_never_approves_or_configures_via_manage_stamp() {
    let h = harness();
    let collab = v2_collaboration(&h, v2_snapshot("9007199254740993", "manager", false, json!("explicit")));
    let access = collab.access_for(crate::remote::protocol::Authority::Manage, Some("u1"));
    assert_eq!(access.role, Role::Manager);
    assert!(!access.can_approve && !access.can_configure());
    h.ops.pending.lock().unwrap().push("r1".into());
    // The old mailbox stamp has Manage authority and no role. It cannot
    // promote the current independent approval right via its legacy fallback.
    let decision = lease(&h.agents, "v2-decision", "permission-decision", json!({"v": 1, "requestId": "r1", "optionId": "allow"}));
    assert_eq!(stamped_lease_fixture(&h.agents, &decision).outcome, "rejected");
    assert_eq!(*h.ops.pending.lock().unwrap(), vec!["r1"]);
    assert!(h.ops.decisions.lock().unwrap().is_empty());
    let send = lease(&h.agents, "v2-send", "send", json!({"v": 1, "text": "review", "mode": "bypassPermissions"}));
    let receipt = stamped_lease_fixture(&h.agents, &send);
    assert_eq!(receipt.outcome, "applied");
    assert_eq!(open_receipt(&h.agents, &send, &receipt)["settingsIgnored"], true);
    assert!(h.ops.settings.lock().unwrap().is_empty());
    assert_eq!(*h.ops.sent.lock().unwrap(), vec!["review"]);
    assert_eq!(stamped_lease_fixture(&h.agents, &lease(&h.agents, "v2-slash", "steer", json!({"v": 1, "text": "/model opus"}))).outcome, "rejected");
}

#[test]
fn phase2_collaboration_v2_everyone_drive_is_per_tab_and_explicit_approval_is_independent() {
    let h = harness();
    v2_collaboration(&h, v2_snapshot("1", "driver", true, json!("everyone")));
    *h.ops.second_tab.lock().unwrap() = true;
    let mut unsafe_tab = v2_safe_witness();
    unsafe_tab.actual = Some(crate::harness::settings::Stance::Mode { mode: "dontAsk".into() });
    h.ops.v2_witnesses.lock().unwrap().insert("tab-1".into(), v2_safe_witness());
    h.ops.v2_witnesses.lock().unwrap().insert("tab-2".into(), unsafe_tab);
    let unsafe_send = lease_for(&h.agents, "unsafe", "tab-2", "send", json!({"v": 1, "text": "unsafe"}));
    let receipt = stamped_lease_fixture(&h.agents, &unsafe_send);
    assert_eq!(receipt.outcome, "rejected");
    assert_eq!(receipt.category.as_deref(), Some("everyone-tab-read-only"));
    let safe_send = lease(&h.agents, "safe", "send", json!({"v": 1, "text": "safe", "mode": "bypassPermissions"}));
    let receipt = stamped_lease_fixture(&h.agents, &safe_send);
    assert_eq!(receipt.outcome, "applied", "another unsafe tab cannot prohibit safe-tab prose");
    assert_eq!(open_receipt(&h.agents, &safe_send, &receipt)["settingsIgnored"], true);
    assert!(h.ops.settings.lock().unwrap().is_empty());
    assert_eq!(*h.ops.sent.lock().unwrap(), vec!["safe"]);
    // Explicit viewer+approval combined by the server with Everyone drive:
    // writeSource describes drive alone, so even this unsafe tab may receive
    // an explicitly authorized permission decision.
    h.ops.pending.lock().unwrap().push("r1".into());
    let decision = lease_for(&h.agents, "approval", "tab-2", "permission-decision", json!({"v": 1, "requestId": "r1", "optionId": "allow"}));
    assert_eq!(stamped_lease_fixture(&h.agents, &decision).outcome, "applied");
    assert_eq!(h.ops.decisions.lock().unwrap().len(), 1);
    assert_eq!(stamped_lease_fixture(&h.agents, &lease(&h.agents, "raw-command", "steer", json!({"v": 1, "text": "/permissions"}))).outcome, "rejected");
}

#[test]
fn phase2_collaboration_v2_org_only_driver_cannot_approve_or_steer_after_bypass_switch() {
    let h = harness();
    v2_collaboration(&h, v2_snapshot("1", "driver", false, json!("everyone")));
    h.ops.pending.lock().unwrap().push("r1".into());
    h.ops.v2_witnesses.lock().unwrap().insert("tab-1".into(), v2_safe_witness());
    let decision = lease(&h.agents, "approval", "permission-decision",
        json!({"v": 1, "requestId": "r1", "optionId": "allow"}));
    assert_eq!(stamped_lease_fixture(&h.agents, &decision).outcome, "rejected");
    assert!(h.ops.decisions.lock().unwrap().is_empty());

    let send = lease(&h.agents, "initial", "send", json!({"v": 1, "text": "inspect"}));
    assert_eq!(stamped_lease_fixture(&h.agents, &send).outcome, "applied");
    *h.ops.busy.lock().unwrap() = true;
    h.ops.v2_witnesses.lock().unwrap().get_mut("tab-1").unwrap().pending_mode = Some("bypassPermissions".into());
    let steer = lease(&h.agents, "after-switch", "steer", json!({"v": 1, "text": "continue"}));
    let receipt = stamped_lease_fixture(&h.agents, &steer);
    assert_eq!(receipt.category.as_deref(), Some("everyone-tab-read-only"));
}

#[test]
fn phase2_collaboration_v2_encrypted_mailbox_requires_stored_pending_and_raw_actual_mode_witness() {
    use crate::harness::settings::Stance;
    let mut cases = vec![("safe Claude", v2_safe_witness(), true)];
    for (saved, actual) in [("plan", "plan"), ("manual", "default"), ("acceptEdits", "acceptEdits")] {
        let mut witness = v2_safe_witness();
        witness.stored_mode = saved.into();
        witness.actual = Some(Stance::Mode { mode: actual.into() });
        cases.push(("supported asking mode", witness, true));
    }
    for mode in ["", "auto", "bypassPermissions", "dontAsk", "future-mode", "never, workspace-write"] {
        let mut witness = v2_safe_witness();
        witness.stored_mode = mode.into();
        cases.push(("stored unsafe or unknown", witness, false));
        let mut witness = v2_safe_witness();
        witness.pending_mode = Some(mode.into());
        cases.push(("pending unsafe or unknown", witness, false));
        let mut witness = v2_safe_witness();
        witness.actual = Some(Stance::Mode { mode: mode.into() });
        cases.push(("actual unsafe or unknown", witness, false));
    }
    for (approval, sandbox, safe) in [
        ("never", "danger-full-access", false), ("never", "workspace-write", false),
        ("unknown", "workspace-write", false), ("on-request", "unknown", false),
        ("on-request", "danger-full-access", false),
        ("on-request", "read-only", true), ("on-request", "workspace-write", true),
    ] {
        let mut witness = v2_safe_witness();
        witness.harness = "codex".into();
        witness.actual = Some(Stance::Sandboxed { approval: approval.into(), sandbox: sandbox.into() });
        cases.push(("raw Codex stance", witness, safe));
    }
    let mut unknown = v2_safe_witness();
    unknown.actual = None;
    cases.push(("no actual report", unknown, false));
    let mut adopted = v2_safe_witness();
    adopted.owned = false;
    cases.push(("adopted or by-hand", adopted, false));
    for harness in ["shell", "opencode", "unsupported"] {
        let mut witness = v2_safe_witness();
        witness.harness = harness.into();
        cases.push(("unsupported engine", witness, false));
    }
    for (name, witness, safe) in cases {
        let h = harness();
        v2_collaboration(&h, v2_snapshot("1", "driver", false, json!("everyone")));
        h.ops.v2_witnesses.lock().unwrap().insert("tab-1".into(), witness);
        // FakeOps reports zero pending permissions in every case: that
        // observation must never make an unsafe mode safe.
        let receipt = stamped_lease_fixture(&h.agents, &lease(&h.agents, "matrix", "send", json!({"v": 1, "text": "prose"})));
        assert_eq!(receipt.outcome == "applied", safe, "{name}");
        assert_eq!(h.ops.sent.lock().unwrap().len(), usize::from(safe), "{name}");
    }
}

#[test]
fn phase2_collaboration_v2_followups_fence_same_role_source_revision_generation_and_restart() {
    for transition in ["source", "revision", "generation", "restart"] {
        let h = harness();
        let snapshot = v2_snapshot("10", "driver", false, json!("explicit"));
        let collab = v2_collaboration(&h, snapshot.clone());
        *h.ops.busy.lock().unwrap() = true;
        assert_eq!(stamped_lease_fixture(&h.agents, &lease(&h.agents, "queued", "send", json!({"v": 1, "text": "queued"}))).outcome, "applied");
        let on_disk = super::super::receipts::FollowUps::open(h._dir.path()).unwrap();
        assert!(on_disk.list("tab-1")[0].policy_stamp.is_some());
        *h.ops.busy.lock().unwrap() = false;
        let agents = match transition {
            "source" => {
                collab.install_v2(v2_snapshot("11", "driver", false, json!("everyone"))).unwrap();
                h.ops.v2_witnesses.lock().unwrap().insert("tab-1".into(), v2_safe_witness());
                h.agents.clone()
            }
            "revision" => {
                collab.install_v2(v2_snapshot("11", "driver", false, json!("explicit"))).unwrap();
                h.agents.clone()
            }
            "generation" => {
                h.agents.set_generation(8);
                collab.install_v2(snapshot.clone()).unwrap();
                h.agents.clone()
            }
            _ => {
                let agents = reopen(&h);
                let restarted = Arc::new(crate::remote::collab::Collaboration::new());
                agents.share_collaboration(restarted.clone());
                assert!(restarted.runtime_policy.stamp("u1").is_none(), "disk state is not authority");
                restarted.install_v2(snapshot).unwrap();
                agents
            }
        };
        agents.nudge_follow_ups("tab-1");
        assert_eq!(agents.dispatch_follow_ups(), 0, "{transition}");
        assert!(h.ops.sent.lock().unwrap().is_empty(), "{transition}");
        assert!(agents.follow_ups.list("tab-1").is_empty(), "{transition}");
    }
}

#[test]
fn phase2_collaboration_v2_stale_conflicting_and_failed_durable_policy_never_admit_encrypted_lease_input() {
    for next in [v2_snapshot("9", "manager", true, json!("explicit")), v2_snapshot("10", "manager", true, json!("explicit"))] {
        let h = harness();
        let collab = v2_collaboration(&h, v2_snapshot("10", "driver", false, json!("explicit")));
        assert!(collab.install_v2(next).is_err());
        assert_eq!(stamped_lease_fixture(&h.agents, &lease(&h.agents, "stale", "send", json!({"v": 1, "text": "do not send"}))).outcome, "rejected");
        assert!(h.ops.sent.lock().unwrap().is_empty());
        assert!(collab.install_v2(v2_snapshot("10", "driver", false, json!("explicit"))).is_err(), "a conflicting revision stays poisoned");
        collab.install_v2(v2_snapshot("11", "driver", false, json!("explicit"))).unwrap();
        assert_eq!(stamped_lease_fixture(&h.agents, &lease(&h.agents, "current", "send", json!({"v": 1, "text": "current"}))).outcome, "applied");
    }
    let h = harness();
    let collab = v2_collaboration(&h, v2_snapshot("10", "driver", false, json!("explicit")));
    let path = h._dir.path().join("collaboration-v2-policy.json");
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(collab.install_v2(v2_snapshot("11", "driver", false, json!("explicit"))).is_err());
    assert_eq!(stamped_lease_fixture(&h.agents, &lease(&h.agents, "failed-store", "send", json!({"v": 1, "text": "do not send"}))).outcome, "rejected");
    assert!(h.ops.sent.lock().unwrap().is_empty());
}

#[test]
fn phase2_collaboration_v2_policy_replacement_cannot_cross_native_command_mark_and_synchronous_apply() {
    use std::sync::mpsc;
    let h = harness();
    let collab = v2_collaboration(&h, v2_snapshot("1", "driver", false, json!("explicit")));
    let stamp = collab.runtime_policy.stamp("u1");
    let agents = h.agents.clone();
    let (entered_tx, entered_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let apply_thread = std::thread::spawn(move || {
        let body = json!({"text": "first"});
        let command = Command { kind: "send", tab_id: "tab-1", client_command_id: "atomic", actor_id: "u1", leases: true,
            access: crate::remote::collab::Access { role: Role::Driver, can_approve: false }, policy_stamp: stamp, plaintext: &body };
        decide(&agents, &command, || {
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(10)).unwrap();
            Ok(())
        })
    });
    entered_rx.recv_timeout(Duration::from_secs(10)).unwrap();
    let refresh = collab.clone();
    let (installed_tx, installed_rx) = mpsc::channel();
    let refresh_thread = std::thread::spawn(move || {
        refresh.install_v2(v2_snapshot("2", "viewer", false, Value::Null)).unwrap();
        installed_tx.send(()).unwrap();
    });
    assert!(installed_rx.recv_timeout(Duration::from_millis(30)).is_err(), "refresh waits for admitted synchronous apply");
    release_tx.send(()).unwrap();
    assert!(matches!(apply_thread.join().unwrap(), Decided::Applied(("applied", _, _))));
    refresh_thread.join().unwrap();
    assert_eq!(*h.ops.sent.lock().unwrap(), vec!["first"]);
    // A stamp captured before revocation cannot authorize a later invocation.
    assert_eq!(stamped_lease_fixture(&h.agents, &lease(&h.agents, "after", "steer", json!({"v": 1, "text": "after"}))).outcome, "rejected");
    assert_eq!(h.ops.sent.lock().unwrap().len(), 1);
}

#[test]
fn unknown_claude_models_are_rejected_before_settings_or_sends_even_when_busy() {
    crate::harness::claude::models::with_test_models(json!({ "response": { "models": [{ "value": "opus", "resolvedModel": "claude-opus-5" }] } }), || {
        for busy in [false, true] {
            let h = harness();
            *h.ops.busy.lock().unwrap() = busy;
            let command = lease(&h.agents, "bad-model", "send", json!({ "v": 1, "text": "hello", "model": "claude-opus-9", "effort": "low", "mode": "plan" }));
            let receipt = handle(&h.agents, &command);
            assert_eq!(receipt.outcome, "rejected");
            assert!(open_receipt(&h.agents, &command, &receipt)["message"].as_str().unwrap().contains("Claude model 'claude-opus-9' is not available"));
            assert!(h.ops.settings.lock().unwrap().is_empty());
            assert!(h.ops.sent.lock().unwrap().is_empty());
            assert!(h.agents.tab("tab-1").unwrap().follow_ups.is_empty());
        }
        for model in ["opus", "claude-opus-5"] {
            let h = harness();
            let command = lease(&h.agents, "good-model", "send", json!({ "v": 1, "text": "hello", "model": model }));
            assert_eq!(handle(&h.agents, &command).outcome, "applied");
            assert_eq!(h.ops.settings.lock().unwrap()[0].model.as_deref(), Some(model));
        }
    });
    // No CLI answer: custom ids are left to the agent, as before.
    let h = harness();
    let command = lease(&h.agents, "stand-in", "send", json!({ "v": 1, "text": "hello", "model": "claude-opus-9" }));
    assert_eq!(handle(&h.agents, &command).outcome, "applied");
}

#[test]
fn a_send_is_applied_once_and_a_redelivery_answers_from_its_receipt() {
    let h = harness();
    let first = lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "hello", "model": "opus" }));
    let receipt = handle(&h.agents, &first);
    assert_eq!(receipt.outcome, "applied");
    assert_eq!(*h.ops.sent.lock().unwrap(), vec!["hello"]);
    assert_eq!(h.ops.settings.lock().unwrap()[0].model.as_deref(), Some("opus"));
    assert_eq!(open_receipt(&h.agents, &first, &receipt)["queued"], false);
    // Redelivered (a lost ack), and again after a runtime restart.
    let again = Lease { lease_token: "token-2".into(), redelivery: true, ..first.clone() };
    assert_eq!(handle(&h.agents, &again), receipt);
    assert_eq!(handle(&reopen(&h), &again), receipt, "the receipt survives a restart byte for byte");
    assert_eq!(h.ops.sent.lock().unwrap().len(), 1, "never sent twice");
}

#[test]
fn a_send_while_busy_is_queued_durably_and_goes_out_when_the_turn_ends() {
    let h = harness();
    *h.ops.busy.lock().unwrap() = true;
    let receipt = handle(&h.agents, &lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "next" })));
    assert_eq!(receipt.outcome, "applied");
    assert!(h.ops.sent.lock().unwrap().is_empty());
    assert_eq!(h.agents.tab("tab-1").unwrap().follow_ups[0].text, "next");
    // A restart keeps it; a second send queues behind it even when idle.
    let agents = reopen(&h);
    *h.ops.busy.lock().unwrap() = false;
    handle(&agents, &lease(&agents, "c2", "send", json!({ "v": 1, "text": "after" })));
    assert!(h.ops.sent.lock().unwrap().is_empty(), "order is kept behind the queued follow-up");
    agents.nudge_follow_ups("tab-1");
    assert_eq!(agents.dispatch_follow_ups(), 1);
    assert_eq!(*h.ops.sent.lock().unwrap(), vec!["next"]);
    // Busy again: the second waits for the next turn to end.
    agents.nudge_follow_ups("tab-1");
    assert_eq!(agents.dispatch_follow_ups(), 0);
    *h.ops.busy.lock().unwrap() = false;
    agents.nudge_follow_ups("tab-1");
    assert_eq!(agents.dispatch_follow_ups(), 1);
    assert_eq!(*h.ops.sent.lock().unwrap(), vec!["next", "after"]);
}

#[test]
fn a_message_is_recorded_as_its_leased_senders_sent_now_or_queued() {
    let h = harness();
    handle(&h.agents, &lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "now" })));
    // Busy: queued, then typed once the turn ends, still as its sender's.
    let other = Lease { actor: Actor { user_id: "u2".into(), ..lease(&h.agents, "c2", "send", json!({})).actor }, ..lease(&h.agents, "c2", "send", json!({ "v": 1, "text": "later" })) };
    assert_eq!(handle(&h.agents, &other).outcome, "applied");
    assert_eq!(h.agents.tab("tab-1").unwrap().follow_ups[0].text, "later");
    *h.ops.busy.lock().unwrap() = false;
    h.agents.nudge_follow_ups("tab-1");
    assert_eq!(h.agents.dispatch_follow_ups(), 1);
    assert_eq!(*h.ops.sent.lock().unwrap(), vec!["now", "later"]);
    assert_eq!(*h.ops.actors.lock().unwrap(), vec!["u1", "u2"], "the lease's verified sender, never the message's words");
}

#[test]
fn steer_goes_into_the_running_turn_now() {
    let h = harness();
    *h.ops.busy.lock().unwrap() = true;
    assert_eq!(handle(&h.agents, &lease(&h.agents, "c1", "steer", json!({ "v": 1, "text": "use tabs" }))).outcome, "applied");
    assert_eq!(*h.ops.sent.lock().unwrap(), vec!["use tabs"]);
}

#[test]
fn a_command_interrupted_mid_apply_is_never_applied_again_except_stop() {
    let h = harness();
    let send = lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "hi" }));
    h.agents.receipts.applying("c1").unwrap();
    let receipt = handle(&reopen(&h), &send);
    assert_eq!((receipt.outcome.as_str(), receipt.category.as_deref()), ("outcome-unknown", Some("runtime-interrupted")));
    assert!(h.ops.sent.lock().unwrap().is_empty());
    let stop = lease(&h.agents, "c2", "stop", json!({ "v": 1 }));
    h.agents.receipts.applying("c2").unwrap();
    assert_eq!(handle(&h.agents, &stop).outcome, "applied");
    assert_eq!(*h.ops.stops.lock().unwrap(), 1);
}

#[test]
fn stop_drops_queued_follow_ups_and_lists_them_in_its_receipt() {
    let h = harness();
    *h.ops.busy.lock().unwrap() = true;
    handle(&h.agents, &lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "queued" })));
    let stop = lease(&h.agents, "c2", "stop", json!({ "v": 1 }));
    let receipt = handle(&h.agents, &stop);
    assert_eq!(open_receipt(&h.agents, &stop, &receipt)["droppedFollowUps"], json!(["c1"]));
    assert!(h.agents.tab("tab-1").unwrap().follow_ups.is_empty());
    assert_eq!(h.ops.notes.lock().unwrap().len(), 1);
}

// PRO-84: a transcript showed the restart notice three times.
#[test]
fn a_turn_interrupted_by_a_restart_is_noted_once_until_something_else_is_said() {
    let h = harness();
    let tabs = [("s1".to_string(), "tab-1".to_string())];
    h.agents.mark_interrupted_turns(&tabs);
    h.agents.mark_interrupted_turns(&tabs);
    assert_eq!(h.ops.notes.lock().unwrap().len(), 1);
    assert!(h.ops.notes.lock().unwrap()[0].contains("workspace runtime restarted"));
    // A later turn that is interrupted too gets its own notice.
    h.ops.note("s1", "tab-1", "something else");
    h.agents.mark_interrupted_turns(&tabs);
    assert_eq!(h.ops.notes.lock().unwrap().len(), 3);
}

#[test]
fn permission_decisions_apply_once_and_a_settled_request_is_rejected() {
    let h = harness();
    h.ops.pending.lock().unwrap().push("req-1".into());
    let decide = lease(&h.agents, "c1", "permission-decision", json!({ "v": 1, "requestId": "req-1", "optionId": "allow" }));
    assert_eq!(handle(&h.agents, &decide).outcome, "applied");
    assert_eq!(handle(&h.agents, &Lease { lease_token: "t2".into(), ..decide }).outcome, "applied");
    assert_eq!(h.ops.decisions.lock().unwrap().len(), 1);
    // A second command for the same request (another device) is definitely not applied.
    let late = handle(&h.agents, &lease(&h.agents, "c2", "permission-decision", json!({ "v": 1, "requestId": "req-1", "optionId": "deny" })));
    assert_eq!((late.outcome.as_str(), late.category.as_deref()), ("rejected", Some("request-not-pending")));
}

#[test]
fn unreadable_misrouted_unauthorized_or_unknown_commands_are_rejected_untouched() {
    let h = harness();
    let mut unknown_key = lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "x" }));
    unknown_key.key_id = "missing".into();
    assert_eq!(handle(&h.agents, &unknown_key).category.as_deref(), Some("key-unknown"));
    // Encrypted for another tab, delivered under this one.
    let mut moved = lease_for(&h.agents, "c2", "tab-2", "send", json!({ "v": 1, "text": "x" }));
    moved.tab_id = "tab-1".into();
    assert_eq!(handle(&h.agents, &moved).category.as_deref(), Some("decrypt-failed"));
    let participant = Lease { actor: Actor { collaboration_revision: None, write_source: None, user_id: "u2".into(), authority: "participate".into(), role: None, can_approve: None }, ..lease(&h.agents, "c3", "send", json!({ "v": 1, "text": "x" })) };
    assert_eq!(handle(&h.agents, &participant).category.as_deref(), Some("forbidden"));
    assert_eq!(handle(&h.agents, &lease_for(&h.agents, "c4", "tab-9", "send", json!({ "v": 1, "text": "x" }))).category.as_deref(), Some("tab-unknown"));
    assert_eq!(handle(&h.agents, &lease(&h.agents, "c5", "send", json!({ "v": 1, "text": " " }))).category.as_deref(), Some("payload-invalid"));
    assert_eq!(handle(&h.agents, &lease(&h.agents, "c6", "send", json!({ "v": 2, "text": "x" }))).category.as_deref(), Some("payload-invalid"));
    assert!(h.ops.sent.lock().unwrap().is_empty());
}

#[test]
fn a_rotated_key_still_opens_queued_commands_within_its_grace() {
    let h = harness();
    let queued = lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "before rotation" }));
    h.agents.keys.rotate(now_ms()).unwrap();
    assert_eq!(handle(&h.agents, &queued).outcome, "applied");
}

#[test]
fn a_lost_ack_is_retried_with_the_same_token_and_bytes_and_stale_generation_polls_again() {
    let h = harness();
    let first = lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "hi" }));
    h.api.queue.lock().unwrap().push(first.clone());
    *h.api.fail_acks.lock().unwrap() = 1;
    let mut unacked = Vec::new();
    assert!(poll_once(&h.agents, &mut unacked).unwrap());
    assert_eq!(unacked.len(), 1);
    assert!(!poll_once(&h.agents, &mut unacked).unwrap());
    assert!(unacked.is_empty());
    let acks = h.api.acks.lock().unwrap().clone();
    assert_eq!(acks.len(), 2);
    assert_eq!(acks[0], acks[1], "the retry sends the same token and the same sealed receipt");
    assert_eq!(h.ops.sent.lock().unwrap().len(), 1);

    *h.api.stale_generation_once.lock().unwrap() = true;
    h.api.queue.lock().unwrap().push(lease(&h.agents, "c2", "stop", json!({ "v": 1 })));
    poll_once(&h.agents, &mut unacked).unwrap();
    assert!(h.agents.poll.wait(std::time::Duration::ZERO), "a stale generation asks for another lease round");
}

#[test]
fn checkpoints_are_sealed_for_the_workspace_and_move_to_a_new_epoch_when_stale() {
    let h = harness();
    checkpoints::upload(&h.agents, "tab-1").unwrap();
    *h.api.stale_puts.lock().unwrap() = 1;
    checkpoints::upload(&h.agents, "tab-1").unwrap();
    let stored = h.api.checkpoints.lock().unwrap().clone();
    assert_eq!(stored.len(), 2);
    let (first, second) = (&stored[0].1, &stored[1].1);
    assert_eq!((first.epoch, first.version), (7, 1));
    assert_eq!((second.epoch, second.version), (8, 1), "a stale cursor starts a new epoch");
    let key = h.agents.keys.get(&second.key_id).unwrap();
    let ciphertext = crypto::unb64(&second.ciphertext).unwrap();
    assert_eq!(crypto::sha256_hex(&ciphertext), second.sha256);
    let aad = crypto::checkpoint_aad("org_1", "ws_1", "tab-1", second.epoch, second.version, 1, &second.key_id);
    let packed = crypto::open_raw(&key, &crypto::unb64(&second.iv).unwrap(), &ciphertext, &aad).unwrap();
    let projection: Value = serde_json::from_slice(&crypto::gunzip(&packed, 1 << 22).unwrap()).unwrap();
    assert_eq!(projection["events"].as_array().unwrap().len(), 3);
    assert_eq!(projection["sessionId"], "s1");
    // The session's title and branch travel inside the sealed content only.
    assert_eq!(projection["session"], json!({ "title": "Fix the login", "branch": "terminalx/fix-login" }));
    assert!(!String::from_utf8_lossy(&ciphertext).contains("Fix the login"));
    // Another tab's AAD does not open it.
    let other = crypto::checkpoint_aad("org_1", "ws_1", "tab-2", second.epoch, second.version, 1, &second.key_id);
    assert!(crypto::open_raw(&key, &crypto::unb64(&second.iv).unwrap(), &ciphertext, &other).is_err());
}

#[test]
fn a_projection_keeps_the_newest_whole_events_within_its_budget() {
    let h = harness();
    let full = checkpoints::projection(&h.agents, "tab-1", 1 << 20).unwrap();
    assert_eq!(full["truncated"], false);
    let one = full["events"][2].to_string().len() + 1;
    let cut = checkpoints::projection(&h.agents, "tab-1", one * 2).unwrap();
    assert_eq!(cut["truncated"], true);
    assert_eq!(cut["events"].as_array().unwrap().iter().map(|e| e["seq"].as_u64().unwrap()).collect::<Vec<_>>(), vec![2, 3]);
    let empty = checkpoints::projection(&h.agents, "tab-1", 0).unwrap();
    assert!(empty["events"].as_array().unwrap().is_empty());
    assert_eq!(empty["hasMessages"], true);
    assert_eq!(empty["sessionHasMessages"], true);
    assert!(empty["lastMessageAt"].is_null());
}

#[test]
fn a_removed_tab_never_uploads_again_and_its_delete_is_retried() {
    let h = harness();
    h.agents.checkpoints.remove("tab-1");
    h.agents.checkpoints.mark("tab-1", true);
    let now = std::time::Instant::now();
    checkpoints::flush(&h.agents, now);
    assert!(h.api.checkpoints.lock().unwrap().is_empty(), "late events of a removed tab upload nothing");
}

#[test]
fn a_final_checkpoint_quiesces_then_uploads_every_tab() {
    let h = harness();
    // A follow-up waiting for the turn to end, and a command in the mailbox.
    *h.ops.busy.lock().unwrap() = true;
    let mut unacked = Vec::new();
    h.api.queue.lock().unwrap().push(lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "queued" })));
    poll_once(&h.agents, &mut unacked).unwrap();
    assert_eq!(h.agents.follow_ups.list("tab-1").len(), 1);

    // One transient failure is retried within the deadline.
    *h.api.failing_puts.lock().unwrap() = 1;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    assert!(checkpoints::final_checkpoint(&h.agents, deadline));
    let stored = h.api.checkpoints.lock().unwrap().clone();
    assert_eq!(stored.iter().map(|(tab, _)| tab.as_str()).collect::<Vec<_>>(), ["tab-1"]);
    assert!(h.agents.quiesced());

    // Quiesced: nothing more is leased, and the turn ending types nothing.
    h.api.queue.lock().unwrap().push(lease(&h.agents, "c2", "send", json!({ "v": 1, "text": "later" })));
    assert!(!poll_once(&h.agents, &mut unacked).unwrap());
    assert_eq!(h.api.queue.lock().unwrap().len(), 1, "the command stays in the mailbox");
    *h.ops.busy.lock().unwrap() = false;
    h.agents.nudge_follow_ups("tab-1");
    assert_eq!(h.agents.dispatch_follow_ups(), 0);
    assert!(h.ops.sent.lock().unwrap().is_empty(), "the queued follow-up waits");

    // The archive did not stop the runtime after all: work resumes.
    h.agents.resume_work();
    assert!(poll_once(&h.agents, &mut unacked).unwrap());
    h.agents.nudge_follow_ups("tab-1");
    assert!(h.agents.dispatch_follow_ups() >= 1);
}

#[test]
fn a_final_checkpoint_that_cannot_upload_reports_failure_by_its_deadline() {
    let h = harness();
    *h.api.failing_puts.lock().unwrap() = u32::MAX;
    let started = std::time::Instant::now();
    assert!(!checkpoints::final_checkpoint(&h.agents, started + std::time::Duration::from_millis(1500)));
    assert!(started.elapsed() < std::time::Duration::from_secs(10), "bounded by the deadline");
}

#[test]
fn work_resumes_when_the_archive_never_stopped_this_runtime() {
    use crate::cloud_bootstrap::QuiesceRequest;
    let h = harness();
    let mut quiescer = crate::cloud_quiesce::Quiescer::default();
    let reports = std::cell::RefCell::new(Vec::new());
    let mut report = |id: &str, committed: bool| {
        reports.borrow_mut().push((id.to_string(), committed));
        Ok(())
    };
    let request = QuiesceRequest { operation_id: "op_1".into(), reason: "archive".into(), requested_at: 0, deadline: now_ms() + 60_000 };
    let start = std::time::Instant::now();
    quiescer.tick(Some(&request), Some(&h.agents), &mut report, start, now_ms());
    assert_eq!(*reports.borrow(), [("op_1".to_string(), true)]);
    assert_eq!(h.api.checkpoints.lock().unwrap().len(), 1, "every tab uploaded before the report");
    assert!(h.agents.quiesced());
    // The request is gone (answered) while compute stops: still paused.
    quiescer.tick(None, Some(&h.agents), &mut report, start + std::time::Duration::from_secs(60), now_ms());
    quiescer.tick(None, Some(&h.agents), &mut report, start + std::time::Duration::from_secs(5 * 60), now_ms());
    assert!(h.agents.quiesced());
    // Still running ten minutes later: the archive failed or was undone.
    quiescer.tick(None, Some(&h.agents), &mut report, start + std::time::Duration::from_secs(11 * 60), now_ms());
    assert!(!h.agents.quiesced());
}

#[test]
fn work_resumes_at_once_when_a_device_attaches_after_the_archive() {
    use crate::cloud_bootstrap::QuiesceRequest;
    let h = harness();
    let mut quiescer = crate::cloud_quiesce::Quiescer::default();
    let mut report = |_: &str, _: bool| Ok(());
    let request = QuiesceRequest { operation_id: "op_1".into(), reason: "archive".into(), requested_at: 0, deadline: now_ms() + 60_000 };
    let start = std::time::Instant::now();
    quiescer.tick(Some(&request), Some(&h.agents), &mut report, start, now_ms());
    quiescer.tick(None, Some(&h.agents), &mut report, start + std::time::Duration::from_secs(10), now_ms());
    assert!(h.agents.quiesced(), "no device yet: still paused");
    h.agents.client_attached();
    quiescer.tick(None, Some(&h.agents), &mut report, start + std::time::Duration::from_secs(20), now_ms());
    assert!(!h.agents.quiesced());
}

// ---- sharing (PRO-30, saas contract §21.4-21.5) ------------------------------

fn as_actor(lease: Lease, user: &str, role: &str, can_approve: bool) -> Lease {
    Lease {
        actor: Actor { collaboration_revision: None, write_source: None, user_id: user.into(), authority: "participate".into(), role: Some(role.into()), can_approve: Some(can_approve) },
        ..lease
    }
}

fn shared(h: &Harness, members: serde_json::Value) -> Arc<crate::remote::collab::Collaboration> {
    let collab = Arc::new(crate::remote::collab::Collaboration::new());
    let members: crate::remote::collab::Members = serde_json::from_value(json!({ "v": 1, "members": members })).unwrap();
    collab.set_members(members.into_map().unwrap());
    h.agents.share_collaboration(collab.clone());
    collab
}

#[test]
fn a_viewer_cannot_send_but_an_approving_viewer_decides_permissions() {
    let h = harness();
    shared(&h, json!([{ "userId": "bob", "role": "viewer", "canApprove": true }, { "userId": "cat", "role": "viewer" }]));
    let send = as_actor(lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "hi" })), "bob", "viewer", true);
    assert_eq!(handle(&h.agents, &send).category.as_deref(), Some("forbidden"));
    h.ops.pending.lock().unwrap().push("req-1".into());
    let decision = json!({ "v": 1, "requestId": "req-1", "optionId": "allow" });
    let refused = as_actor(lease(&h.agents, "c2", "permission-decision", decision.clone()), "cat", "viewer", false);
    assert_eq!(handle(&h.agents, &refused).category.as_deref(), Some("forbidden"));
    let approved = as_actor(lease(&h.agents, "c3", "permission-decision", decision), "bob", "viewer", true);
    assert_eq!(handle(&h.agents, &approved).outcome, "applied");
    assert_eq!(*h.ops.decisions.lock().unwrap(), vec![("req-1".to_string(), "allow".to_string())]);
    assert!(h.ops.sent.lock().unwrap().is_empty());
}

#[test]
fn the_runtime_list_narrows_a_role_stamped_at_lease_time() {
    let h = harness();
    // Leased while Alice drove; the refresh since says she only views.
    shared(&h, json!([{ "userId": "alice", "role": "viewer" }]));
    let send = as_actor(lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "hi" })), "alice", "driver", false);
    assert_eq!(handle(&h.agents, &send).category.as_deref(), Some("forbidden"));
    // Removed altogether: nothing, not even a decision.
    let gone = as_actor(lease(&h.agents, "c2", "stop", json!({ "v": 1 })), "dan", "driver", true);
    assert_eq!(handle(&h.agents, &gone).category.as_deref(), Some("forbidden"));
    assert!(h.ops.sent.lock().unwrap().is_empty());
    assert_eq!(*h.ops.stops.lock().unwrap(), 0);
}

#[test]
fn one_driver_at_a_time_and_the_other_is_told_who_drives() {
    let h = harness();
    let collab = shared(&h, json!([{ "userId": "alice", "role": "driver" }, { "userId": "bob", "role": "driver" }, { "userId": "boss", "role": "manager" }]));
    let alice = as_actor(lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "alice's task" })), "alice", "driver", false);
    assert_eq!(handle(&h.agents, &alice).outcome, "applied");
    assert_eq!(collab.lease("tab-1", now_ms(), true).unwrap().holder_id, "alice");
    let bob = as_actor(lease(&h.agents, "c2", "send", json!({ "v": 1, "text": "bob's task" })), "bob", "driver", false);
    let refused = handle(&h.agents, &bob);
    assert_eq!((refused.outcome.as_str(), refused.category.as_deref()), ("rejected", Some("lease-held")));
    assert_eq!(open_receipt(&h.agents, &bob, &refused)["holderId"], "alice");
    let bob_stop = as_actor(lease(&h.agents, "c3", "stop", json!({ "v": 1 })), "bob", "driver", false);
    assert_eq!(handle(&h.agents, &bob_stop).category.as_deref(), Some("lease-held"));
    // A manager may stop anyone's turn; sending still needs the lease.
    let boss_stop = Lease {
        actor: Actor { collaboration_revision: None, write_source: None, user_id: "boss".into(), authority: "manage".into(), role: Some("manager".into()), can_approve: Some(true) },
        ..lease(&h.agents, "c4", "stop", json!({ "v": 1 }))
    };
    assert_eq!(handle(&h.agents, &boss_stop).outcome, "applied");
    // Alice's own follow-up while her turn runs is queued with her name.
    *h.ops.busy.lock().unwrap() = true;
    let follow = as_actor(lease(&h.agents, "c5", "send", json!({ "v": 1, "text": "and then" })), "alice", "driver", false);
    assert_eq!(handle(&h.agents, &follow).outcome, "applied");
    assert_eq!(h.agents.tabs()[0].follow_ups[0].actor_id, "alice");
    assert_eq!(h.agents.tabs()[0].lease.as_ref().unwrap().holder_id, "alice");
    assert_eq!(*h.ops.sent.lock().unwrap(), vec!["alice's task"]);
}

#[test]
fn a_queued_follow_up_is_dropped_when_its_sender_loses_driver_access() {
    let h = harness();
    let collab = shared(&h, json!([{ "userId": "alice", "role": "driver" }]));
    *h.ops.busy.lock().unwrap() = true;
    let follow = as_actor(lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "later" })), "alice", "driver", false);
    assert_eq!(handle(&h.agents, &follow).outcome, "applied");
    assert_eq!(h.agents.follow_ups.list("tab-1").len(), 1);
    // Revoked mid-turn: the queued input is re-checked before it is typed.
    collab.set_members(Default::default());
    *h.ops.busy.lock().unwrap() = false;
    h.agents.nudge_follow_ups("tab-1");
    h.agents.dispatch_follow_ups();
    assert!(h.ops.sent.lock().unwrap().is_empty(), "never typed");
    assert!(h.agents.follow_ups.list("tab-1").is_empty());
    assert!(h.ops.notes.lock().unwrap().iter().any(|note| note.contains("no longer has driver access")));
    assert!(collab.lease("tab-1", now_ms(), true).is_none(), "the lease went with the role");
}

#[test]
fn an_idle_lease_that_expired_does_not_block_the_next_driver() {
    let h = harness();
    let collab = shared(&h, json!([{ "userId": "alice", "role": "driver" }, { "userId": "bob", "role": "driver" }]));
    // Alice drove long ago; her lease expired and nothing removed it.
    collab.claim("tab-1", "alice", 1, false, false).unwrap();
    let bob = as_actor(lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "bob's turn" })), "bob", "driver", false);
    assert_eq!(handle(&h.agents, &bob).outcome, "applied");
    // Bob's turn runs now, and he holds the lease; Alice's expired one did not come back.
    assert_eq!(collab.lease("tab-1", now_ms(), true).unwrap().holder_id, "bob");
    let steer = as_actor(lease(&h.agents, "c2", "steer", json!({ "v": 1, "text": "faster" })), "bob", "driver", false);
    assert_eq!(handle(&h.agents, &steer).outcome, "applied");
    let alice_stop = as_actor(lease(&h.agents, "c3", "stop", json!({ "v": 1 })), "alice", "driver", false);
    assert_eq!(handle(&h.agents, &alice_stop).category.as_deref(), Some("lease-held"));
}

/// Review M1: model, effort and permission mode reach the tab only from a
/// manager or an approver; a plain driver's send is applied without them, so
/// nobody without approval rights can switch a tab to bypassPermissions
/// through the mailbox while the workspace sleeps.
#[test]
fn a_drivers_queued_settings_are_not_applied_but_an_approvers_are() {
    let h = harness();
    let collab = shared(
        &h,
        json!([
            { "userId": "alice", "role": "driver", "canApprove": false },
            { "userId": "bob", "role": "driver", "canApprove": true },
        ]),
    );
    let body = json!({ "v": 1, "text": "go", "mode": "bypassPermissions", "model": "opus", "effort": "max" });
    let alice = as_actor(lease(&h.agents, "c1", "send", body.clone()), "alice", "driver", false);
    let receipt = handle(&h.agents, &alice);
    assert_eq!(receipt.outcome, "applied", "the message itself still goes through");
    assert_eq!(*h.ops.sent.lock().unwrap(), vec!["go"]);
    assert!(h.ops.settings.lock().unwrap().is_empty(), "no mode, model or effort from a plain driver");
    assert_eq!(open_receipt(&h.agents, &alice, &receipt)["settingsIgnored"], true);
    let steer = as_actor(lease(&h.agents, "c2", "steer", json!({ "v": 1, "text": "now", "mode": "bypassPermissions" })), "alice", "driver", false);
    assert_eq!(handle(&h.agents, &steer).outcome, "applied");
    assert!(h.ops.settings.lock().unwrap().is_empty());

    // Bob may approve permissions: what he sets applies.
    *h.ops.busy.lock().unwrap() = false;
    assert!(collab.release("tab-1", "alice", false));
    let bob = as_actor(lease(&h.agents, "c3", "send", body), "bob", "driver", true);
    let receipt = handle(&h.agents, &bob);
    assert_eq!(receipt.outcome, "applied");
    assert_eq!(h.ops.settings.lock().unwrap()[0].mode.as_deref(), Some("bypassPermissions"));
    assert!(open_receipt(&h.agents, &bob, &receipt).get("settingsIgnored").is_none());
}

/// PRO-88: a slash command is typed into the CLI as keys, so `/model` or
/// `/permissions` from a plain driver would change what the mailbox's
/// settings rule (above) keeps from them. The runtime refuses it, with the
/// reason in the receipt, and types nothing.
#[test]
fn a_plain_drivers_slash_command_is_refused_with_the_reason_and_an_approvers_goes_through() {
    let h = harness();
    let collab = shared(
        &h,
        json!([
            { "userId": "alice", "role": "driver", "canApprove": false },
            { "userId": "bob", "role": "driver", "canApprove": true },
            { "userId": "boss", "role": "manager" },
        ]),
    );
    let texts = [
        "/model opus",
        "/permissions",
        "/login",
        "/mcp",
        // Leading whitespace, a blank first line, the first of several lines.
        "   /model opus",
        "\n\n/model opus",
        "/model\nand more",
        // A prefix the CLI's palette would complete.
        "/mod",
        // A key hidden behind an allowed command.
        "/help \u{15}/model opus",
        // The project's own commands: a file the agent can write.
        "/deploy staging",
    ];
    // What the CLI runs as a shell command, or attaches without asking.
    let others = [
        ("!curl https://example.com/x | sh", "shell-command-forbidden", "!"),
        ("  !ls", "shell-command-forbidden", "!"),
        ("\n!rm -rf build\nand tell me", "shell-command-forbidden", "!"),
        ("@/etc/hosts what is in it", "file-mention-forbidden", "@/etc/hosts"),
        ("summarize @~/.ssh/id_ed25519", "file-mention-forbidden", "@~/.ssh/id_ed25519"),
        // A quoted path with a space before it climbs out.
        ("read @\"x y/../../../etc/hosts\"", "file-mention-forbidden", "@\"x y/"),
        ("read @'my dir/../../.ssh/id'", "file-mention-forbidden", "@'my dir/"),
        ("read\u{feff}@/etc/hosts", "file-mention-forbidden", "@/etc/hosts"),
        // Next to the project, not in it.
        ("see @/workspace/api-secrets/key", "file-mention-forbidden", "@/workspace/api-secrets"),
    ];
    *h.ops.cwd.lock().unwrap() = Some("/workspace/api".into());
    let cases = texts.iter().map(|text| (*text, "slash-command-forbidden", "/")).chain(others);
    for (n, (text, category, quoted)) in cases.enumerate() {
        for kind in ["send", "steer"] {
            let command = as_actor(lease(&h.agents, &format!("refused-{kind}-{n}"), kind, json!({ "v": 1, "text": text })), "alice", "driver", false);
            let receipt = handle(&h.agents, &command);
            assert_eq!((receipt.outcome.as_str(), receipt.category.as_deref()), ("rejected", Some(category)), "{kind} {text:?}");
            let body = open_receipt(&h.agents, &command, &receipt);
            assert!(body["command"].as_str().unwrap().starts_with(quoted), "{text:?}: {body}");
            assert!(body["message"].as_str().unwrap().contains("can approve permissions"), "{body}");
            // Refused again from its receipt on a redelivery, never applied.
            assert_eq!(handle(&h.agents, &command), receipt);
        }
    }
    assert!(h.ops.sent.lock().unwrap().is_empty(), "nothing was typed");
    assert!(h.agents.follow_ups.list("tab-1").is_empty(), "nothing was queued");
    assert!(collab.lease("tab-1", now_ms(), true).is_none(), "a refused command does not claim the tab");

    // The harmless ones, and what both CLIs read as prose: later lines that
    // start with `/` or `!`, and a file of the project by its absolute path.
    for (n, text) in ["/clear", "/compact", "/help", "see @/workspace/api/src/main.rs\n/model opus\n![shot](a.png)\n/tmp"].iter().enumerate() {
        *h.ops.busy.lock().unwrap() = false;
        let command = as_actor(lease(&h.agents, &format!("allowed-{n}"), "send", json!({ "v": 1, "text": text })), "alice", "driver", false);
        assert_eq!(handle(&h.agents, &command).outcome, "applied", "{text:?}");
    }
    assert_eq!(h.ops.sent.lock().unwrap().len(), 4);

    // Someone who may approve, and a manager, send any command.
    *h.ops.busy.lock().unwrap() = false;
    assert!(collab.release("tab-1", "alice", false));
    for (n, text) in ["/model opus", "!ls -la", "@/etc/hosts what is in it"].iter().enumerate() {
        // Each lands on an idle tab: a command is not steered into a running turn.
        *h.ops.busy.lock().unwrap() = false;
        let bob = as_actor(lease(&h.agents, &format!("bob-{n}"), "steer", json!({ "v": 1, "text": text })), "bob", "driver", true);
        assert_eq!(handle(&h.agents, &bob).outcome, "applied", "{text:?}");
    }
    *h.ops.busy.lock().unwrap() = false;
    assert!(collab.release("tab-1", "bob", false));
    let boss = Lease {
        actor: Actor { collaboration_revision: None, write_source: None, user_id: "boss".into(), authority: "manage".into(), role: Some("manager".into()), can_approve: Some(true) },
        ..lease(&h.agents, "boss-1", "send", json!({ "v": 1, "text": "/permissions" }))
    };
    assert_eq!(handle(&h.agents, &boss).outcome, "applied");
    assert_eq!(h.ops.sent.lock().unwrap()[4..], ["/model opus", "!ls -la", "@/etc/hosts what is in it", "/permissions"]);
}

/// The allowed commands are the tab's CLI's own: Codex has no `/help`, and
/// an agent nobody checked has none at all.
#[test]
fn the_allowed_commands_follow_the_tabs_agent() {
    let h = harness();
    shared(&h, json!([{ "userId": "alice", "role": "driver", "canApprove": false }]));
    let send = |id: &str, text: &str| handle(&h.agents, &as_actor(lease(&h.agents, id, "steer", json!({ "v": 1, "text": text })), "alice", "driver", false));
    *h.ops.harness.lock().unwrap() = "codex".into();
    assert_eq!(send("c1", "/help").category.as_deref(), Some("slash-command-forbidden"));
    assert_eq!(send("c2", "/new").outcome, "applied");
    assert_eq!(send("c3", " !ls").category.as_deref(), Some("shell-command-forbidden"));
    *h.ops.harness.lock().unwrap() = "opencode".into();
    assert_eq!(send("c4", "/clear").category.as_deref(), Some("slash-command-forbidden"));
    assert_eq!(send("c5", "fix the login").outcome, "applied");
    assert_eq!(*h.ops.sent.lock().unwrap(), vec!["/new", "fix the login"]);
}

/// The route the ticket names: a command left in the mailbox while the
/// workspace was stopped is leased when the runtime wakes, and is judged by
/// what its sender may do then.
#[test]
fn a_slash_command_queued_while_the_workspace_slept_is_refused_when_it_is_leased() {
    let h = harness();
    shared(&h, json!([{ "userId": "alice", "role": "driver", "canApprove": false }]));
    // Stamped as an approver when it was queued; the list since says not.
    let slept = as_actor(lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "/model opus", "mode": "bypassPermissions" })), "alice", "driver", true);
    let bang = Lease { sequence: 2, ..as_actor(lease(&h.agents, "c2", "send", json!({ "v": 1, "text": "!cat ~/.config/secrets" })), "alice", "driver", true) };
    h.api.queue.lock().unwrap().extend([slept, bang]);
    assert!(poll_once(&h.agents, &mut Vec::new()).unwrap());
    let acks = h.api.acks.lock().unwrap();
    assert_eq!(acks.len(), 2);
    assert_eq!((acks[0].2.outcome.as_str(), acks[0].2.category.as_deref()), ("rejected", Some("slash-command-forbidden")));
    assert_eq!((acks[1].2.outcome.as_str(), acks[1].2.category.as_deref()), ("rejected", Some("shell-command-forbidden")));
    assert!(h.ops.sent.lock().unwrap().is_empty());
    assert!(h.ops.settings.lock().unwrap().is_empty());
}

/// A follow-up waits for the running turn. If its sender stops being an
/// approver meanwhile, a queued slash command is dropped before it is typed;
/// their ordinary messages still go.
#[test]
fn a_queued_slash_command_is_dropped_when_its_sender_can_no_longer_approve() {
    let h = harness();
    let collab = shared(&h, json!([{ "userId": "bob", "role": "driver", "canApprove": true }]));
    *h.ops.busy.lock().unwrap() = true;
    for (id, text) in [("c1", "/model opus"), ("c2", "!ls ~"), ("c3", "and then run the tests")] {
        let follow = as_actor(lease(&h.agents, id, "send", json!({ "v": 1, "text": text })), "bob", "driver", true);
        assert_eq!(handle(&h.agents, &follow).outcome, "applied");
    }
    assert_eq!(h.agents.follow_ups.list("tab-1").len(), 3);
    let members: crate::remote::collab::Members =
        serde_json::from_value(json!({ "v": 1, "members": [{ "userId": "bob", "role": "driver", "canApprove": false }] })).unwrap();
    collab.set_members(members.into_map().unwrap());
    *h.ops.busy.lock().unwrap() = false;
    h.agents.nudge_follow_ups("tab-1");
    h.agents.dispatch_follow_ups();
    h.agents.dispatch_follow_ups();
    assert_eq!(*h.ops.sent.lock().unwrap(), vec!["and then run the tests"], "neither command was typed");
    assert_eq!(h.ops.notes.lock().unwrap().iter().filter(|note| note.contains("queued command") && note.contains("no longer approve")).count(), 2);
}

/// #273 follow-up: a steer is typed into the running turn, where the
/// session's own queue holds it until the turn ends, and nothing re-checks
/// that queue. A slash or `!` command is therefore never steered into a
/// running turn, whoever sends it; it would still run after its sender lost
/// the right to send it.
#[test]
fn a_command_is_never_steered_into_a_running_turn() {
    let h = harness();
    shared(
        &h,
        json!([
            { "userId": "alice", "role": "driver", "canApprove": false },
            { "userId": "bob", "role": "driver", "canApprove": true },
            { "userId": "boss", "role": "manager" },
        ]),
    );
    let steer = |id: &str, user: &str, approves: bool, text: &str| {
        let command = as_actor(lease(&h.agents, id, "steer", json!({ "v": 1, "text": text })), user, "driver", approves);
        let receipt = handle(&h.agents, &command);
        let body = open_receipt(&h.agents, &command, &receipt);
        (receipt.outcome, receipt.category, body)
    };
    *h.ops.busy.lock().unwrap() = true;
    for (n, text) in ["/model opus", "!ls", "  /compact", "\n!rm -rf build"].iter().enumerate() {
        let (outcome, category, body) = steer(&format!("busy-{n}"), "bob", true, text);
        assert_eq!((outcome.as_str(), category.as_deref()), ("rejected", Some("command-not-queued")), "{text:?}");
        assert!(body["message"].as_str().unwrap().starts_with("A turn is running"), "{body}");
    }
    // A command a plain driver may send is still a command.
    assert_eq!(steer("busy-plain", "alice", false, "/clear").1.as_deref(), Some("command-not-queued"));
    // What they may not send at all is refused for that, as before.
    assert_eq!(steer("busy-plain-2", "alice", false, "/model").1.as_deref(), Some("slash-command-forbidden"));
    assert!(h.ops.sent.lock().unwrap().is_empty(), "nothing reached the running turn");
    // Prose steers as it always did, a mention and a later `/` line included.
    assert_eq!(steer("busy-prose", "bob", true, "use tabs, and read @/etc/hosts\n/model is not a command here").0, "applied");
    // On an idle tab a command is typed at once: there is no queue to wait in.
    *h.ops.busy.lock().unwrap() = false;
    assert_eq!(steer("idle", "bob", true, "/model opus").0, "applied");
    assert_eq!(h.ops.sent.lock().unwrap().len(), 2);
    // A `send` of a command while busy waits in the follow-up queue, which is
    // re-checked before it is typed (see the test above).
    let queued = handle(&h.agents, &as_actor(lease(&h.agents, "send-1", "send", json!({ "v": 1, "text": "/model sonnet" })), "bob", "driver", true));
    assert_eq!(queued.outcome, "applied");
    assert_eq!(h.agents.follow_ups.list("tab-1").len(), 1);
}

/// PRO-22: the sender uploads an image first; the message names it.
fn upload(agents: &CloudAgents, owner: &str, id: &str, bytes: &[u8]) {
    agents.attach_part(owner, id, 0, bytes, "image/png", Some("shot.png"), false, true).unwrap();
}

#[test]
fn a_message_carries_the_images_its_sender_uploaded_and_they_are_gone_once_typed() {
    let h = harness();
    upload(&h.agents, "u1", "attach-0001", b"abc");
    upload(&h.agents, "u1", "attach-0002", b"def");
    let body = json!({ "v": 1, "text": "what is in these?", "images": [{ "id": "attach-0001", "name": "shot.png" }, { "id": "attach-0002" }] });
    let first = lease(&h.agents, "c1", "send", body);
    let receipt = handle(&h.agents, &first);
    assert_eq!(receipt.outcome, "applied");
    assert_eq!(*h.ops.sent.lock().unwrap(), vec!["what is in these?"]);
    let images = h.ops.images.lock().unwrap().clone();
    assert_eq!(images, vec![vec![("image/png".to_string(), "YWJj".to_string(), Some("shot.png".to_string())), ("image/png".to_string(), "ZGVm".to_string(), Some("shot.png".to_string()))]]);
    assert!(h.agents.attachments.load("u1", &["attach-0001".into()]).is_err(), "typed: the upload is removed");
    // A redelivery answers from the receipt: nothing is typed again, with or without its images.
    assert_eq!(handle(&h.agents, &Lease { lease_token: "token-2".into(), redelivery: true, ..first }), receipt);
    assert_eq!(h.ops.sent.lock().unwrap().len(), 1);
    // Images alone are a message, as in a local tab.
    *h.ops.busy.lock().unwrap() = false;
    upload(&h.agents, "u1", "attach-0003", b"ghi");
    assert_eq!(handle(&h.agents, &lease(&h.agents, "c2", "send", json!({ "v": 1, "images": [{ "id": "attach-0003" }] }))).outcome, "applied");
    assert_eq!(h.ops.sent.lock().unwrap().last().map(String::as_str), Some(""));
}

#[test]
fn a_message_naming_an_image_that_is_not_there_is_refused_untouched() {
    let h = harness();
    upload(&h.agents, "u-alice", "attach-0001", b"abc");
    h.agents.attach_part("u1", "attach-0002", 0, b"half", "image/png", None, false, false).unwrap();
    // Someone else's upload, one never completed, one never uploaded, a malformed list, and a steer.
    for (id, kind, body) in [
        ("c1", "send", json!({ "v": 1, "text": "look", "images": [{ "id": "attach-0001" }] })),
        ("c2", "send", json!({ "v": 1, "text": "look", "images": [{ "id": "attach-0002" }] })),
        ("c3", "send", json!({ "v": 1, "text": "look", "images": [{ "id": "attach-9999" }] })),
    ] {
        let lease = lease(&h.agents, id, kind, body);
        let receipt = handle(&h.agents, &lease);
        assert_eq!((receipt.outcome.as_str(), receipt.category.as_deref()), ("rejected", Some(ATTACHMENT_MISSING)), "{id}");
        assert!(open_receipt(&h.agents, &lease, &receipt)["message"].as_str().unwrap().starts_with("Not sent: an image"));
    }
    for (id, kind, body) in [
        ("c4", "send", json!({ "v": 1, "text": "look", "images": [{ "id": "../../etc/passwd" }] })),
        ("c5", "steer", json!({ "v": 1, "text": "look", "images": [{ "id": "attach-0001" }] })),
        ("c6", "send", json!({ "v": 1, "images": [] })),
    ] {
        let receipt = handle(&h.agents, &lease(&h.agents, id, kind, body));
        assert_eq!((receipt.outcome.as_str(), receipt.category.as_deref()), ("rejected", Some("payload-invalid")), "{id}");
    }
    assert!(h.ops.sent.lock().unwrap().is_empty());
    assert!(h.ops.settings.lock().unwrap().is_empty());
    assert!(h.agents.attachments.load("u-alice", &["attach-0001".into()]).is_ok(), "its owner can still send it");
}

#[test]
fn a_queued_message_keeps_its_images_until_it_is_typed_or_dropped() {
    let h = harness();
    *h.ops.busy.lock().unwrap() = true;
    upload(&h.agents, "u1", "attach-0001", b"abc");
    upload(&h.agents, "u1", "attach-0002", b"def");
    assert_eq!(handle(&h.agents, &lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "first", "images": [{ "id": "attach-0001" }] }))).outcome, "applied");
    assert_eq!(handle(&h.agents, &lease(&h.agents, "c2", "send", json!({ "v": 1, "text": "second", "images": [{ "id": "attach-0002" }] }))).outcome, "applied");
    assert!(h.ops.sent.lock().unwrap().is_empty());
    // Across a restart, the queue still names the upload and the upload is still there.
    let agents = reopen(&h);
    *h.ops.busy.lock().unwrap() = false;
    agents.nudge_follow_ups("tab-1");
    assert_eq!(agents.dispatch_follow_ups(), 1);
    assert_eq!(*h.ops.sent.lock().unwrap(), vec!["first"]);
    assert_eq!(h.ops.images.lock().unwrap()[0][0].1, "YWJj");
    assert!(agents.attachments.load("u1", &["attach-0001".into()]).is_err());
    // A stop drops the second, and its upload with it.
    assert_eq!(handle(&agents, &lease(&agents, "c3", "stop", json!({ "v": 1 }))).outcome, "applied");
    assert!(agents.attachments.load("u1", &["attach-0002".into()]).is_err());
    assert_eq!(h.ops.sent.lock().unwrap().len(), 1);
}

#[test]
fn a_queued_message_whose_images_are_gone_is_not_sent_without_them() {
    let h = harness();
    *h.ops.busy.lock().unwrap() = true;
    upload(&h.agents, "u1", "attach-0001", b"abc");
    handle(&h.agents, &lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "look at this", "images": [{ "id": "attach-0001" }] })));
    h.agents.attachments.remove(&["attach-0001".into()]);
    *h.ops.busy.lock().unwrap() = false;
    h.agents.nudge_follow_ups("tab-1");
    h.agents.dispatch_follow_ups();
    assert!(h.ops.sent.lock().unwrap().is_empty());
    assert!(h.ops.notes.lock().unwrap().iter().any(|note| note.contains("its images are no longer on the workspace")));
    assert!(h.agents.tab("tab-1").unwrap().follow_ups.is_empty());
}

/// PRO-407: a file other than an image, uploaded first like an image.
fn upload_file(agents: &CloudAgents, owner: &str, id: &str, name: &str, bytes: &[u8]) {
    agents.attach_part(owner, id, 0, bytes, "text/markdown", Some(name), true, true).unwrap();
}

#[test]
fn a_message_carries_its_files_stored_in_the_sessions_attachments_folder_here() {
    let _home = crate::store::temp_home();
    let h = harness();
    upload(&h.agents, "u1", "attach-0001", b"abc");
    upload_file(&h.agents, "u1", "attach-0002", "plan.md", b"# Plan");
    let body = json!({ "v": 1, "text": "read the plan", "images": [{ "id": "attach-0001" }], "files": [{ "id": "attach-0002", "name": "plan.md" }] });
    assert_eq!(handle(&h.agents, &lease(&h.agents, "c1", "send", body)).outcome, "applied");
    assert_eq!(*h.ops.sent.lock().unwrap(), vec!["read the plan"]);
    assert_eq!(h.ops.images.lock().unwrap()[0].len(), 1, "the image goes as an image");
    let files = h.ops.files.lock().unwrap()[0].clone();
    assert_eq!(files.len(), 1);
    let folder = crate::store::attachments_dir("s1").unwrap().canonical().unwrap();
    assert!(std::path::Path::new(&files[0].path).starts_with(&folder), "{:?}", files[0].path);
    assert_eq!(std::fs::read(&files[0].path).unwrap(), b"# Plan");
    assert!(h.agents.attachments.check_files("u1", &["attach-0002".into()]).is_err(), "typed: the upload is gone");
    // Files alone are a message.
    *h.ops.busy.lock().unwrap() = false;
    upload_file(&h.agents, "u1", "attach-0003", "notes.txt", b"notes");
    assert_eq!(handle(&h.agents, &lease(&h.agents, "c2", "send", json!({ "v": 1, "files": [{ "id": "attach-0003" }] }))).outcome, "applied");
    assert_eq!(h.ops.sent.lock().unwrap().last().map(String::as_str), Some(""));
    assert_eq!(h.ops.files.lock().unwrap()[1][0].name, "notes.txt");
}

#[test]
fn a_queued_message_takes_its_files_into_the_session_and_types_them_later() {
    let _home = crate::store::temp_home();
    let h = harness();
    *h.ops.busy.lock().unwrap() = true;
    upload_file(&h.agents, "u1", "attach-0001", "plan.md", b"# Plan");
    assert_eq!(handle(&h.agents, &lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "then this", "files": [{ "id": "attach-0001" }] }))).outcome, "applied");
    assert!(h.ops.sent.lock().unwrap().is_empty());
    // Stored when it was queued, so a restart or a day's pruning cannot lose it.
    let queued = h.agents.follow_ups.list("tab-1");
    assert_eq!(queued[0].files.len(), 1);
    assert!(std::path::Path::new(&queued[0].files[0].path).is_file());
    let agents = reopen(&h);
    *h.ops.busy.lock().unwrap() = false;
    agents.nudge_follow_ups("tab-1");
    assert_eq!(agents.dispatch_follow_ups(), 1);
    assert_eq!(*h.ops.sent.lock().unwrap(), vec!["then this"]);
    assert_eq!(h.ops.files.lock().unwrap()[0], queued[0].files);
}

#[test]
fn a_message_naming_a_file_that_is_not_there_or_too_many_is_refused_untouched() {
    let _home = crate::store::temp_home();
    let h = harness();
    upload_file(&h.agents, "u-alice", "attach-0001", "plan.md", b"# Plan");
    upload(&h.agents, "u1", "attach-0002", b"abc");
    for (id, body) in [
        ("c1", json!({ "v": 1, "text": "look", "files": [{ "id": "attach-0001" }] })),
        ("c2", json!({ "v": 1, "text": "look", "files": [{ "id": "attach-9999" }] })),
        // An image named as a file is not one.
        ("c3", json!({ "v": 1, "text": "look", "files": [{ "id": "attach-0002" }] })),
    ] {
        let lease = lease(&h.agents, id, "send", body);
        let receipt = handle(&h.agents, &lease);
        assert_eq!((receipt.outcome.as_str(), receipt.category.as_deref()), ("rejected", Some(ATTACHMENT_MISSING)), "{id}");
        assert!(open_receipt(&h.agents, &lease, &receipt)["message"].as_str().unwrap().starts_with("Not sent: a file"));
    }
    let eleven: Vec<Value> = (0..11).map(|index| json!({ "id": format!("attach-1{index:03}") })).collect();
    for (id, kind, body) in [("c4", "send", json!({ "v": 1, "text": "look", "files": eleven })), ("c5", "steer", json!({ "v": 1, "text": "look", "files": [{ "id": "attach-0001" }] }))] {
        let receipt = handle(&h.agents, &lease(&h.agents, id, kind, body));
        assert_eq!((receipt.outcome.as_str(), receipt.category.as_deref()), ("rejected", Some("payload-invalid")), "{id}");
    }
    assert!(h.ops.sent.lock().unwrap().is_empty());
    assert!(h.agents.attachments.check_files("u-alice", &["attach-0001".into()]).is_ok(), "its owner can still send it");
}

/// Review of #309: a refused message must not leave its uploads behind, or
/// retries fill the store until nobody can attach.
#[test]
fn a_refused_message_gives_up_its_senders_uploads_and_nobody_elses() {
    let h = harness();
    shared(&h, json!([{ "userId": "alice", "role": "driver", "canApprove": false }, { "userId": "bob", "role": "driver", "canApprove": false }]));
    upload(&h.agents, "alice", "attach-0001", b"abc");
    upload(&h.agents, "bob", "attach-0002", b"def");
    // A PRO-88 refusal of alice's message, which names her upload and bob's.
    let body = json!({ "v": 1, "text": "/model opus", "images": [{ "id": "attach-0001" }, { "id": "attach-0002" }] });
    let receipt = handle(&h.agents, &as_actor(lease(&h.agents, "c1", "send", body), "alice", "driver", false));
    assert_eq!((receipt.outcome.as_str(), receipt.category.as_deref()), ("rejected", Some("slash-command-forbidden")));
    assert!(h.agents.attachments.load("alice", &["attach-0001".into()]).is_err(), "her upload goes with her refused message");
    assert!(h.agents.attachments.load("bob", &["attach-0002".into()]).is_ok(), "his stays");
    // The same attachment sent again under the same id is a fresh upload and goes through.
    upload(&h.agents, "alice", "attach-0001", b"abc");
    let again = json!({ "v": 1, "text": "what is this?", "images": [{ "id": "attach-0001" }] });
    assert_eq!(handle(&h.agents, &as_actor(lease(&h.agents, "c2", "send", again), "alice", "driver", false)).outcome, "applied");
    assert_eq!(h.ops.images.lock().unwrap().len(), 1);
}


/// Simulated authoritative server Actor, decoded through its real typed wire
/// shape. The body remains encrypted and passes through handle/decrypt/judge.
fn stamped_lease_fixture(agents: &CloudAgents, lease: &Lease) -> Receipt {
    let mut lease = lease.clone();
    if let Some(stamp) = agents.collab().and_then(|collab| collab.runtime_policy.stamp(&lease.actor.user_id)) {
        let stamp = serde_json::to_value(stamp).unwrap();
        lease.actor = serde_json::from_value(json!({
            "userId":lease.actor.user_id,"authority":lease.actor.authority,
            "role":stamp["member"]["role"],"canApprove":stamp["member"]["canApprove"],
            "collaborationRevision":stamp["revision"],"writeSource":stamp["member"]["writeSource"]
        })).unwrap();
    }
    handle(agents, &lease)
}

#[test]
fn phase2_collaboration_v2_role_only_mailbox_actor_never_inherits_explicit_authority_from_bootstrap() {
    for source in ["explicit", "everyone", "implicit"] {
        let h = harness();
        v2_collaboration(&h, v2_snapshot("100", "driver", true, json!(source)));
        h.ops.v2_witnesses.lock().unwrap().insert("tab-1".into(), v2_safe_witness());
        let mut command = lease(&h.agents, "role-only", "send", json!({"v":1,"text":"must not arrive"}));
        command.actor.role = Some("driver".into());
        command.actor.can_approve = Some(true);
        let receipt = handle(&h.agents, &command);
        assert_eq!(receipt.outcome, "rejected");
        assert_eq!(receipt.category.as_deref(), Some("collaboration-provenance-unavailable"));
        assert!(h.ops.sent.lock().unwrap().is_empty());
        assert!(h.ops.settings.lock().unwrap().is_empty());
        assert!(h.agents.follow_ups.list("tab-1").is_empty());
    }
}


#[test]
fn phase2_collaboration_v2_encrypted_lease_requires_exact_authoritative_revision_role_approval_and_source() {
    for (revision, role, approve, source) in [
        ("11","driver",false,json!("everyone")), // stale explicit bootstrap, fresh Everyone actor
        ("9","driver",false,json!("explicit")),
        ("10","driver",false,json!("everyone")),
        ("10","manager",false,json!("explicit")),
        ("10","driver",true,json!("explicit")),
        ("9223372036854775808","driver",false,json!("explicit")),
    ] {
        let h = harness();
        v2_collaboration(&h,v2_snapshot("10","driver",false,json!("explicit")));
        let mut leased = lease(&h.agents,"mismatch","send",json!({"v":1,"text":"must never arrive"}));
        leased.actor = serde_json::from_value(json!({"userId":"u1","authority":"manage","role":role,"canApprove":approve,
            "collaborationRevision":revision,"writeSource":source})).unwrap();
        let receipt = handle(&h.agents,&leased);
        assert_eq!(receipt.category.as_deref(),Some("collaboration-provenance-unavailable"));
        assert!(h.ops.sent.lock().unwrap().is_empty());
    }
}

#[test]
fn phase2_collaboration_v2_required_nullable_actor_source_and_independent_viewer_approval() {
    let h = harness();
    v2_collaboration(&h,v2_snapshot("1","viewer",true,Value::Null));
    h.ops.pending.lock().unwrap().push("r1".into());
    let mut leased = lease(&h.agents,"nullable-source","permission-decision",json!({"v":1,"requestId":"r1","optionId":"allow"}));
    for actor in [
        json!({"userId":"u1","authority":"manage","role":"viewer","canApprove":true,"collaborationRevision":"1"}),
        json!({"userId":"u1","authority":"manage","role":"viewer","canApprove":true,"writeSource":null}),
    ] {
        leased.actor = serde_json::from_value(actor).unwrap();
        assert!(lease_provenance(h.agents.collab().unwrap(),&leased).is_err());
    }
    leased.actor = serde_json::from_value(json!({"userId":"u1","authority":"manage","role":"viewer","canApprove":true,
        "collaborationRevision":"1","writeSource":null})).unwrap();
    assert_eq!(handle(&h.agents,&leased).outcome,"applied");
    assert_eq!(h.ops.decisions.lock().unwrap().len(),1);
    assert!(serde_json::from_value::<Actor>(json!({"userId":"u1","authority":"manage","collaborationRevision":1,"writeSource":null})).is_err());
    assert!(serde_json::from_value::<Actor>(json!({"userId":"u1","authority":"manage","collaborationRevision":"1","writeSource":"future-source"})).is_err());
}

/// #1328: a held follow-up is edited, released or withdrawn by a
/// `follow-up` command naming its id; its text is typed as edited.
#[test]
fn a_held_follow_up_is_edited_released_and_withdrawn_through_the_mailbox() {
    let h = harness();
    *h.ops.busy.lock().unwrap() = true;
    for (id, text) in [("c1", "first"), ("c2", "second"), ("c3", "third")] {
        assert_eq!(handle(&h.agents, &lease(&h.agents, id, "send", json!({ "v": 1, "text": text }))).outcome, "applied");
    }
    let edit = lease(&h.agents, "f1", "follow-up", json!({ "v": 1, "op": "edit", "followUpId": "c2", "text": "second, edited" }));
    let receipt = handle(&h.agents, &edit);
    assert_eq!(receipt.outcome, "applied");
    assert_eq!(open_receipt(&h.agents, &edit, &receipt)["followUpId"], "c2");
    let withdraw = lease(&h.agents, "f2", "follow-up", json!({ "v": 1, "op": "withdraw", "followUpId": "c1" }));
    assert_eq!(handle(&h.agents, &withdraw).outcome, "applied");
    // Released: first in line, and the running turn is interrupted.
    let release = lease(&h.agents, "f3", "follow-up", json!({ "v": 1, "op": "release", "followUpId": "c3" }));
    let receipt = handle(&h.agents, &release);
    assert_eq!(open_receipt(&h.agents, &release, &receipt)["interrupted"], true);
    assert_eq!(*h.ops.interrupts.lock().unwrap(), 1);
    let held: Vec<String> = h.agents.tab("tab-1").unwrap().follow_ups.into_iter().map(|follow_up| follow_up.text).collect();
    assert_eq!(held, vec!["third", "second, edited"]);
    // The turn settles: they go in the new order, the withdrawn one never.
    for _ in 0..2 {
        *h.ops.busy.lock().unwrap() = false;
        h.agents.nudge_follow_ups("tab-1");
        assert_eq!(h.agents.dispatch_follow_ups(), 1);
    }
    assert_eq!(*h.ops.sent.lock().unwrap(), vec!["third", "second, edited"]);
    // Gone by now: refused, and a redelivery is answered from the receipt.
    let late = lease(&h.agents, "f4", "follow-up", json!({ "v": 1, "op": "edit", "followUpId": "c2", "text": "too late" }));
    let receipt = handle(&h.agents, &late);
    assert_eq!((receipt.outcome.as_str(), receipt.category.as_deref()), ("rejected", Some(FOLLOW_UP_GONE)));
    assert_eq!(handle(&h.agents, &edit).outcome, "applied", "answered from its receipt");
}

#[test]
fn a_follow_up_command_that_is_malformed_or_empty_changes_nothing() {
    let h = harness();
    *h.ops.busy.lock().unwrap() = true;
    handle(&h.agents, &lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "held" })));
    for (id, body) in [
        ("f1", json!({ "v": 1, "op": "move", "followUpId": "c1" })),
        ("f2", json!({ "v": 1, "op": "edit" })),
        ("f3", json!({ "v": 1, "op": "edit", "followUpId": "c1", "text": "   " })),
        ("f4", json!({ "v": 1, "op": "edit", "followUpId": "c1" })),
    ] {
        let receipt = handle(&h.agents, &lease(&h.agents, id, "follow-up", body));
        assert_eq!((receipt.outcome.as_str(), receipt.category.as_deref()), ("rejected", Some("payload-invalid")), "{id}");
    }
    assert_eq!(h.agents.tab("tab-1").unwrap().follow_ups[0].text, "held");
    // An idle tab's released follow-up goes now, with nothing to interrupt.
    *h.ops.busy.lock().unwrap() = false;
    let release = lease(&h.agents, "f5", "follow-up", json!({ "v": 1, "op": "release", "followUpId": "c1" }));
    let receipt = handle(&h.agents, &release);
    assert_eq!(open_receipt(&h.agents, &release, &receipt)["interrupted"], false);
    assert_eq!(*h.ops.interrupts.lock().unwrap(), 0);
    assert_eq!(h.agents.dispatch_follow_ups(), 1);
    assert_eq!(*h.ops.sent.lock().unwrap(), vec!["held"]);
}

/// A held follow-up is its sender's, or a manager's, to change; another
/// driver's change, or a slash command a plain driver may not type, is refused.
#[test]
fn only_the_sender_or_a_manager_changes_a_held_follow_up() {
    let h = harness();
    shared(&h, json!([{ "userId": "alice", "role": "driver" }, { "userId": "bob", "role": "driver" }, { "userId": "boss", "role": "manager" }]));
    *h.ops.busy.lock().unwrap() = true;
    let send = as_actor(lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "alice's" })), "alice", "driver", false);
    assert_eq!(handle(&h.agents, &send).outcome, "applied");
    let bob = as_actor(lease(&h.agents, "f1", "follow-up", json!({ "v": 1, "op": "withdraw", "followUpId": "c1" })), "bob", "driver", false);
    let refused = handle(&h.agents, &bob);
    assert_eq!(refused.category.as_deref(), Some("forbidden"), "it is alice's");
    assert_eq!(h.agents.follow_ups.list("tab-1").len(), 1);
    let slash = as_actor(lease(&h.agents, "f2", "follow-up", json!({ "v": 1, "op": "edit", "followUpId": "c1", "text": "/model opus" })), "alice", "driver", false);
    assert_ne!(handle(&h.agents, &slash).outcome, "applied", "a plain driver may not queue that command");
    assert_eq!(h.agents.follow_ups.list("tab-1")[0].text, "alice's");
    let alice = as_actor(lease(&h.agents, "f3", "follow-up", json!({ "v": 1, "op": "edit", "followUpId": "c1", "text": "alice's, edited" })), "alice", "driver", false);
    assert_eq!(handle(&h.agents, &alice).outcome, "applied");
    let manager = |id: &str, plaintext: Value| Lease {
        actor: Actor { collaboration_revision: None, write_source: None, user_id: "boss".into(), authority: "manage".into(), role: Some("manager".into()), can_approve: Some(true) },
        ..lease(&h.agents, id, "follow-up", plaintext)
    };
    // A manager does not put words in alice's message: it is still typed as hers, under her policy.
    let reword = manager("f4", json!({ "v": 1, "op": "edit", "followUpId": "c1", "text": "the manager's words" }));
    let refused = handle(&h.agents, &reword);
    assert_eq!(refused.category.as_deref(), Some("forbidden"));
    assert_eq!(open_receipt(&h.agents, &reword, &refused)["message"], FOLLOW_UP_EDIT_NOT_YOURS_MESSAGE);
    let held = &h.agents.follow_ups.list("tab-1")[0];
    assert_eq!((held.text.as_str(), held.actor_id.as_str()), ("alice's, edited", "alice"));
    // It may send hers now, or withdraw it.
    let release = manager("f5", json!({ "v": 1, "op": "release", "followUpId": "c1" }));
    assert_eq!(handle(&h.agents, &release).outcome, "applied");
    let withdraw = manager("f6", json!({ "v": 1, "op": "withdraw", "followUpId": "c1" }));
    assert_eq!(handle(&h.agents, &withdraw).outcome, "applied");
    assert!(h.agents.follow_ups.list("tab-1").is_empty());
}

#[test]
fn another_drivers_held_follow_up_is_refused_as_not_theirs() {
    let h = harness();
    *h.ops.busy.lock().unwrap() = true;
    let send = as_actor(lease(&h.agents, "c1", "send", json!({ "v": 1, "text": "alice's" })), "alice", "driver", false);
    assert_eq!(handle(&h.agents, &send).outcome, "applied");
    let bob = as_actor(lease(&h.agents, "f1", "follow-up", json!({ "v": 1, "op": "release", "followUpId": "c1" })), "bob", "driver", false);
    let refused = handle(&h.agents, &bob);
    assert_eq!(refused.category.as_deref(), Some("forbidden"));
    assert_eq!(open_receipt(&h.agents, &bob, &refused)["message"], FOLLOW_UP_NOT_YOURS_MESSAGE);
    assert_eq!(*h.ops.interrupts.lock().unwrap(), 0, "nothing was interrupted");
}
