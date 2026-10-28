//! Unexecuted source-derived drafts. Real owned Sink + journal APIs, private
//! temporary files, no provider captures/processes. No delivery or UI proof.
use super::*;
use super::super::owned_transport::{OwnedTransport, Owner, Status};
use crate::harness::host::Sink;
use crate::store::batch_journal::{DeliveryState, EnqueueLoss};
use serde_json::json;
use std::{fs, sync::mpsc};

fn scope(name: &str) -> Scope {
    Scope { owner: Owner { session_id: "session".into(), tab_id: "tab".into(), subagent_id: None },
        conversation_id: Some(name.into()), thread_id: name.into() }
}
fn bound(scope: Scope, launch: u64, replaces: Option<(Scope, u64)>) -> Envelope {
    Envelope { scope, launch, observation: Observation::Bound { replaces } }
}
fn item(method: &str, thread: &str) -> String {
    json!({"method":method,"params":{"threadId":thread,"turnId":"turn","item":{"id":"item","type":"contextCompaction"}}}).to_string()
}

#[test]
fn actual_transport_replacement_projects_one_atomic_frame_and_replays_identically() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let (tx, rx) = mpsc::sync_channel(8);
    let bridge = TypedAdmission::new(Journal::create(&path).unwrap(), tx).unwrap();
    let transport = OwnedTransport::new(bridge.clone());
    let old = transport.bind(scope("old")).unwrap();
    old.stdout_line(item("item/started", "old"));
    let new = transport.bind(scope("new")).unwrap();
    assert_eq!(old.status(), Status::Superseded);
    assert_eq!(new.status(), Status::Open);
    old.stdout_line(item("item/completed", "old"));
    let view = bridge.snapshot().unwrap();
    assert_eq!(view.watermark, 4); // rejected old callback adds nothing
    let frame = view.frames.last().unwrap();
    assert_eq!(frame.evidence.len(), 2);
    assert_eq!(serde_json::to_value(&frame.evidence).unwrap(), json!([
        {"scope":{"sessionId":"session","tabId":"tab","subagentId":null,"conversationId":"old","threadId":"old","provider":"codex"},"generation":2,"type":"continuity_lost","reason":"restarted"},
        {"scope":{"sessionId":"session","tabId":"tab","subagentId":null,"conversationId":"new","threadId":"new","provider":"codex"},"generation":4,"type":"connection_opened"}
    ]));
    let pending = rx.try_recv().unwrap();
    assert_eq!(pending.state(), DeliveryState::Pending);
    assert!(pending.receipt().is_none()); // no release under transport/bridge gates
    let receipts = bridge.take_receipts().unwrap();
    assert_eq!(receipts.len(), 3);
    assert_eq!(receipts[2].receipt().changes, vec![bound(scope("new"), 2, Some((scope("old"), 1)))]);
    let mut state = bridge.0.lock().unwrap();
    let replay = Projection::replay(&state.journal.snapshot().unwrap()).unwrap();
    assert_eq!(replay.frames, view.frames);
    assert_eq!(replay.bindings[0].connection, 4);
}

#[test]
fn restart_changes_b_and_c_even_when_local_launch_restarts_at_one() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let (tx, _rx) = mpsc::sync_channel(8);
    let old_bridge = TypedAdmission::new(Journal::create(&path).unwrap(), tx).unwrap();
    let old_transport = OwnedTransport::new(old_bridge.clone());
    let old = old_transport.bind(scope("thread")).unwrap();
    old.stdout_line(item("item/completed", "thread"));
    let (tx2, _rx2) = mpsc::sync_channel(8);
    let new_bridge = TypedAdmission::new(Journal::begin(&path).unwrap(), tx2).unwrap();
    let new_transport = OwnedTransport::new(new_bridge.clone());
    let new = new_transport.bind(scope("thread")).unwrap();
    assert_eq!(new.status(), Status::Open);
    let view = new_bridge.snapshot().unwrap();
    assert_eq!((view.backend_generation, view.watermark), (4, 5));
    assert!(matches!(&view.frames[2].evidence[0].signal, Signal::ItemCompleted { .. }));
    assert_eq!(view.frames[3].evidence[0].signal, Signal::ContinuityLost { reason: Loss::Restarted });
    assert_eq!(view.frames[4].evidence[0].generation, 5);
    let bytes = fs::read(&path).unwrap();
    old.stdout_line(item("item/started", "thread"));
    assert_eq!(old.status(), Status::Blocked);
    assert!(old_bridge.snapshot().unwrap().degraded);
    assert_eq!(bytes, fs::read(&path).unwrap());
}

#[test]
fn stale_local_scope_or_launch_is_rejected_before_persistence() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let (tx, _rx) = mpsc::sync_channel(8);
    let mut bridge = TypedAdmission::new(Journal::create(&path).unwrap(), tx).unwrap();
    bridge.accept(bound(scope("old"), 1, None)).unwrap();
    bridge.accept(bound(scope("new"), 2, Some((scope("old"), 1)))).unwrap();
    let before = fs::read(&path).unwrap();
    assert!(bridge.accept(Envelope { scope: scope("old"), launch: 1,
        observation: Observation::ItemCompleted { turn_id: "turn".into(), item_id: "item".into() } }).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(bridge.snapshot().unwrap().watermark, 3);
    assert!(bridge.snapshot().unwrap().degraded);
}

#[test]
fn postcommit_replacement_loss_retains_receipt_both_scopes_and_replay() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let (tx, _rx) = mpsc::sync_channel(1);
    let mut bridge = TypedAdmission::new(Journal::create(&path).unwrap(), tx).unwrap();
    bridge.accept(bound(scope("old"), 1, None)).unwrap();
    assert!(bridge.accept(bound(scope("new"), 2, Some((scope("old"), 1)))).is_err());
    let view = bridge.snapshot().unwrap();
    assert_eq!(view.watermark, 3);
    assert!(view.degraded);
    assert_eq!(view.affected_scopes, vec![scope("old"), scope("new")]);
    assert_eq!(view.frames.last().unwrap().evidence.len(), 2);
    let receipts = bridge.take_receipts().unwrap();
    assert_eq!(receipts[1].publication(), Publication::Lost(EnqueueLoss::Full));
    assert_eq!(receipts[1].receipt().sequence, 3);
    assert!(!receipts[1].release_delivery());
    let bytes = fs::read(&path).unwrap();
    assert!(bridge.accept(bound(scope("new"), 2, Some((scope("old"), 1)))).is_err());
    assert_eq!(bytes, fs::read(&path).unwrap()); // no retry after persistence
    let mut restart = Journal::<Envelope>::begin(&path).unwrap();
    let replay = Projection::replay(&restart.snapshot().unwrap()).unwrap();
    assert_eq!(&replay.frames[..view.frames.len()], view.frames.as_slice());
}

#[test]
fn failed_replacement_keeps_watermark_and_marks_prior_and_proposed_scopes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let (tx, _rx) = mpsc::sync_channel(8);
    let mut bridge = TypedAdmission::new(Journal::create(&path).unwrap(), tx).unwrap();
    bridge.accept(bound(scope("old"), 1, None)).unwrap();
    let before = fs::read(&path).unwrap();
    // Same actual atomic staging obstruction as the accepted journal draft.
    fs::create_dir(path.with_extension(format!("tmp.{}", std::process::id()))).unwrap();
    assert!(bridge.accept(bound(scope("new"), 2, Some((scope("old"), 1)))).is_err());
    let view = bridge.snapshot().unwrap();
    assert_eq!(view.watermark, 2);
    assert!(view.degraded);
    assert_eq!(view.affected_scopes, vec![scope("old"), scope("new")]);
    assert_eq!(bridge.take_receipts().unwrap().len(), 1);
    assert_eq!(before, fs::read(&path).unwrap());
}

#[test]
fn exit_allows_buffered_completion_without_reopening_start_or_subagent_scope() {
    let dir = tempfile::tempdir().unwrap();
    let (tx, _rx) = mpsc::sync_channel(8);
    let bridge = TypedAdmission::new(Journal::create(&dir.path().join("lifecycle.jsonl")).unwrap(), tx).unwrap();
    let transport = OwnedTransport::new(bridge.clone());
    let main = transport.bind(scope("main")).unwrap();
    let mut sub_scope = scope("sub");
    sub_scope.owner.subagent_id = Some("worker".into());
    let sub = transport.bind(sub_scope).unwrap();
    main.exited(7, Some(0));
    main.stdout_line(item("item/started", "main"));
    main.stdout_line(item("item/completed", "main"));
    sub.stdout_line(item("item/started", "sub"));
    let view = bridge.snapshot().unwrap();
    assert_eq!(view.watermark, 6);
    assert_eq!(view.frames[3].evidence[0].signal, Signal::ContinuityLost { reason: Loss::Exited });
    assert!(matches!(&view.frames[4].evidence[0].signal, Signal::ItemCompleted { .. }));
    assert_eq!(view.frames[4].evidence[0].generation, 2);
    assert_eq!(view.frames[5].evidence[0].scope.subagent_id.as_deref(), Some("worker"));
    assert_eq!(view.frames[5].evidence[0].generation, 3);
}

#[test]
fn projection_refuses_unsafe_export_and_unmatched_atomic_replacement() {
    let mut p = Projection::default();
    p.apply(&Batch { version: 1, sequence: 1, backend_generation: 1, changes: vec![] }).unwrap();
    p.apply(&Batch { version: 1, sequence: 2, backend_generation: 1, changes: vec![bound(scope("old"), 1, None)] }).unwrap();
    let mut candidate = p.clone();
    assert!(candidate.apply(&Batch { version: 1, sequence: 3, backend_generation: 1,
        changes: vec![bound(scope("new"), 2, None)] }).is_err());
    assert_eq!(candidate.frames, p.frames);
    p.watermark = MAX_SAFE_INTEGER; // source-derived boundary fixture, no giant file
    assert!(p.apply(&Batch { version: 1, sequence: MAX_SAFE_INTEGER + 1,
        backend_generation: MAX_SAFE_INTEGER + 1, changes: vec![] }).is_err());
}
