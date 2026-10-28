//! Unexecuted source-derived drafts of the actual coordinator/owned Sink and
//! journal boundaries. No provider, UI, worker thread or substitute storage.
use super::*;
use super::super::super::owned_transport::Owner;
use serde_json::json;
use std::fs;

fn scope() -> Scope {
    Scope { owner: Owner { session_id: "s".into(), tab_id: "t".into(), subagent_id: None },
        conversation_id: Some("c".into()), thread_id: "thread".into() }
}
fn item(id: &str) -> String {
    json!({"method":"item/completed","params":{"threadId":"thread","turnId":"turn",
        "item":{"type":"contextCompaction","id":id}}}).to_string()
}
fn frames(update: Update) -> Vec<Frame> {
    match update { Update::Frames { frames, .. } => frames, Update::Resync => panic!("unexpected resync") }
}

#[test]
fn pending_observer_gets_release_wake_after_outer_gates_exit() {
    let dir = tempfile::tempdir().unwrap();
    let domain = Domain::default();
    let c = Coordinator::adopt(domain.clone(), Journal::create(&dir.path().join("journal")).unwrap()).unwrap();
    let installed = c.subscribe().unwrap();
    let token = domain.wake_token().unwrap();
    // Pause the actual production operation between perform and finish.
    let (sink, receipts) = c.perform(|d| d.transport.bind(scope())).unwrap();
    let sink = sink.unwrap();
    assert_eq!(sink.status(), Status::Open); // transport gate has exited
    assert!(domain.current.try_lock().is_ok());
    assert!(c.delivery.try_lock().is_ok());
    {
        let d = c.delivery.lock().unwrap();
        assert!(d.bridge.0.try_lock().is_ok());
    }
    assert!(frames(installed.subscription.poll(&installed.stream)).is_empty());
    {
        let d = c.delivery.lock().unwrap();
        assert_eq!(d.pending.front().unwrap().state(), DeliveryState::Pending);
        assert!(d.pending.front().unwrap().receipt().is_none());
    }
    c.finish(receipts);
    // Zero timeout: the changed predicate, not a sleep or timing assumption,
    // demonstrates a wake cannot be lost between Pending observation and wait.
    let after = domain.wait_after(&token, Duration::ZERO).unwrap();
    assert!(!Arc::ptr_eq(&token.0, &after.0));
    let batch = frames(installed.subscription.poll(&installed.stream));
    assert_eq!(batch.len(), 1);
    assert_eq!(batch[0].watermark, 2);
}

#[test]
fn snapshot_registration_excludes_pending_then_delivers_exact_later_prefix_in_order() {
    let dir = tempfile::tempdir().unwrap();
    let c = Coordinator::adopt(Domain::default(), Journal::create(&dir.path().join("journal")).unwrap()).unwrap();
    let (sink, first) = c.perform(|d| d.transport.bind(scope())).unwrap();
    let sink = sink.unwrap();
    let installed = c.subscribe().unwrap(); // sees Pending: snapshot W=1
    assert_eq!(installed.watermark, 1);
    assert_eq!(installed.frames.last().unwrap().watermark, 1);
    let ((), second) = c.perform(|_| sink.stdout_line(item("item"))).unwrap();
    c.finish(second); // release out of order; cannot pass Pending first
    assert!(frames(installed.subscription.poll(&installed.stream)).is_empty());
    c.finish(first);
    let updates = frames(installed.subscription.poll(&installed.stream));
    assert_eq!(updates.iter().map(|f| f.watermark).collect::<Vec<_>>(), vec![2, 3]);
    assert!(frames(installed.subscription.poll(&installed.stream)).is_empty());
    let reopened = c.subscribe().unwrap();
    assert_eq!(reopened.watermark, 3);
    assert_eq!(reopened.frames.len(), 3);
    assert!(frames(reopened.subscription.poll(&reopened.stream)).is_empty());
}

#[test]
fn adopted_backend_fences_old_sink_subscription_and_delayed_finish() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal");
    let domain = Domain::default();
    let old = Coordinator::adopt(domain.clone(), Journal::create(&path).unwrap()).unwrap();
    let installed = old.subscribe().unwrap();
    let (sink, receipts) = old.perform(|d| d.transport.bind(scope())).unwrap();
    let old_sink = CoordinatedSink { coordinator: old.clone(), inner: sink.unwrap() };
    let new = Coordinator::adopt(domain, Journal::begin(&path).unwrap()).unwrap();
    let new_view = new.subscribe().unwrap();
    let bytes = fs::read(&path).unwrap();
    old.finish(receipts); // old Ready cannot enter the adopted stream
    old_sink.stdout_line(item("stale"));
    assert_eq!(old_sink.status(), Status::Superseded);
    assert_eq!(bytes, fs::read(&path).unwrap());
    assert!(matches!(installed.subscription.poll(&installed.stream), Update::Resync));
    assert!(matches!(installed.subscription.poll(&new_view.stream), Update::Resync));
    assert!(matches!(new_view.subscription.poll(&installed.stream), Update::Resync));
    let snapshot = new_view.frames.last().unwrap();
    assert_eq!(snapshot.backend_generation, 3);
    assert_eq!(snapshot.evidence[0].signal, Signal::ContinuityLost { reason: Loss::Restarted });
    let fresh = new.bind(scope()).unwrap();
    fresh.stdout_line(item("fresh"));
    let updates = frames(new_view.subscription.poll(&new_view.stream));
    assert_eq!(updates.iter().map(|f| f.watermark).collect::<Vec<_>>(), vec![4, 5]);
}

#[test]
fn subscriber_overflow_requires_new_snapshot_without_provider_retry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal");
    let c = Coordinator::adopt(Domain::default(), Journal::create(&path).unwrap()).unwrap();
    let sink = c.bind(scope()).unwrap();
    let slow = c.subscribe().unwrap();
    for i in 0..=CAPACITY { sink.stdout_line(item(&i.to_string())); }
    assert!(matches!(slow.subscription.poll(&slow.stream), Update::Resync));
    assert_eq!(sink.status(), Status::Open); // subscriber-local loss, not provider retry
    let before = fs::read(&path).unwrap();
    let recovered = c.subscribe().unwrap();
    assert_eq!(recovered.watermark, 2 + CAPACITY as u64 + 1);
    assert_eq!(before, fs::read(&path).unwrap()); // subscribe performs no writes
    assert!(frames(recovered.subscription.poll(&recovered.stream)).is_empty());
}

#[test]
fn abandoned_receipt_and_missing_sequence_fail_closed_preserving_persistence() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("abandoned");
    let c = Coordinator::adopt(Domain::default(), Journal::create(&path).unwrap()).unwrap();
    let sub = c.subscribe().unwrap();
    let (_, receipts) = c.perform(|d| d.transport.bind(scope())).unwrap();
    let bytes = fs::read(&path).unwrap();
    drop(receipts); // accepted storage survives lost delivery capability
    assert!(matches!(sub.subscription.poll(&sub.stream), Update::Resync));
    assert!(c.bind(scope()).is_err());
    assert_eq!(bytes, fs::read(&path).unwrap());

    let path2 = dir.path().join("gap");
    let c = Coordinator::adopt(Domain::default(), Journal::create(&path2).unwrap()).unwrap();
    let sub = c.subscribe().unwrap();
    let (sink, first) = c.perform(|d| d.transport.bind(scope())).unwrap();
    let ((), second) = c.perform(|_| sink.unwrap().stdout_line(item("later"))).unwrap();
    {
        let mut d = c.delivery.lock().unwrap();
        // Deliberately remove the actual queued seq=2 ticket after perform
        // observed it Pending. A seq=3 receipt may never silently skip it.
        assert_eq!(d.pending.pop_front().unwrap().state(), DeliveryState::Pending);
    }
    c.finish(second);
    assert!(matches!(sub.subscription.poll(&sub.stream), Update::Resync));
    c.finish(first); // late release cannot heal a degraded stream
    assert!(matches!(sub.subscription.poll(&sub.stream), Update::Resync));
}

#[test]
fn queue_full_retains_postcommit_record_and_requests_resync() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal");
    let c = Coordinator::adopt(Domain::default(), Journal::create(&path).unwrap()).unwrap();
    let sub = c.subscribe().unwrap();
    let sink = c.bind(scope()).unwrap();
    // Replace only the concrete channel with capacity zero: actual commit_ordered
    // must persist but try_send cannot enqueue without a rendezvous receiver.
    let (tx, _rx) = mpsc::sync_channel(0);
    let _original_sender = {
        let d = c.delivery.lock().unwrap();
        let mut bridge = d.bridge.0.lock().unwrap();
        std::mem::replace(&mut bridge.queue, tx)
    }; // retain sender so the coordinator receiver remains connected
    sink.stdout_line(item("persisted"));
    assert_eq!(sink.status(), Status::Blocked);
    assert!(matches!(sub.subscription.poll(&sub.stream), Update::Resync));
    let bytes = fs::read(&path).unwrap();
    sink.stdout_line(item("must-not-retry"));
    assert_eq!(bytes, fs::read(&path).unwrap());
    let mut restarted = Journal::<Envelope>::begin(&path).unwrap();
    let replay = Projection::replay(&restarted.snapshot().unwrap()).unwrap();
    assert_eq!(replay.frames[2].watermark, 3);
    assert!(matches!(&replay.frames[2].evidence[0].signal, Signal::ItemCompleted { item_id, .. } if item_id == "persisted"));
}

#[test]
fn independent_backend_begin_invalidates_historical_prefix_on_next_read() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal");
    let c = Coordinator::adopt(Domain::default(), Journal::create(&path).unwrap()).unwrap();
    let sink = c.bind(scope()).unwrap();
    let installed = c.subscribe().unwrap();
    assert_eq!(installed.watermark, 2);
    // Does not adopt through Domain: tests the actual persisted generation
    // check, not just the process-local stream capability.
    let _other_owner = Journal::<Envelope>::begin(&path).unwrap();
    let bytes = fs::read(&path).unwrap();
    assert!(matches!(installed.subscription.poll(&installed.stream), Update::Resync));
    assert!(c.subscribe().is_err());
    sink.stdout_line(item("stale"));
    assert_eq!(sink.status(), Status::Blocked);
    assert_eq!(bytes, fs::read(&path).unwrap());
    // Already returned snapshots remain historical; nothing claims to revoke
    // their bytes or supply an out-of-process notification/lifetime lease.
    assert_eq!(installed.watermark, 2);
}
