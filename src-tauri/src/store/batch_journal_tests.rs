//! Unexecuted source-derived controls for the actual storage primitive.
//! These use private temp files and the real transaction/write_atomic APIs,
//! not provider captures, a substitute journal or a live Admission bridge.

use super::*;
use serde_json::{json, Value};

fn replacement() -> Vec<Value> {
    vec![json!({"scope":"old-conversation","state":"unknown"}), json!({"scope":"new-conversation","state":"bound"})]
}

#[test]
fn replacement_is_one_committed_batch_with_a_replay_watermark() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let mut journal = Journal::<Value>::create(&path).unwrap();
    let before = fs::read(&path).unwrap();
    let receipt = journal.commit(replacement()).unwrap();
    assert_eq!(receipt.sequence, 2);
    assert_eq!(receipt.backend_generation, journal.backend_generation());
    let snapshot = journal.snapshot().unwrap();
    assert_eq!(snapshot.watermark, receipt.sequence);
    assert_eq!(snapshot.batches.len(), 2);
    assert_eq!(snapshot.batches[1], receipt);
    assert_eq!(snapshot.batches[1].changes, replacement());
    assert!(fs::read(&path).unwrap().starts_with(&before));
    assert_eq!(fs::read_to_string(&path).unwrap().lines().count(), 2);
}

#[test]
fn restart_persists_a_new_generation_and_fences_the_previous_writer() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let mut old = Journal::<Value>::create(&path).unwrap();
    let accepted = old.commit(replacement()).unwrap();
    let mut restarted = Journal::<Value>::begin(&path).unwrap();
    assert!(restarted.backend_generation() > accepted.sequence);
    let before_stale = fs::read(&path).unwrap();
    assert!(old.commit(vec![json!("stale callback")]).is_err());
    assert!(old.is_degraded());
    assert_eq!(fs::read(&path).unwrap(), before_stale);
    let snapshot = restarted.snapshot().unwrap();
    assert_eq!(snapshot.batches[1], accepted);
    assert_ne!(snapshot.batches[1].backend_generation, snapshot.backend_generation);
    // Bridge must project this old generation's unfinished operations unknown.
    assert!(snapshot.batches.last().unwrap().changes.is_empty());
    let next = restarted.commit(vec![json!("new binding")]).unwrap();
    assert_eq!(next.backend_generation, restarted.backend_generation());
}

#[test]
fn failed_real_atomic_write_returns_no_receipt_and_latches_degraded() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let mut journal = Journal::<Value>::create(&path).unwrap();
    journal.commit(replacement()).unwrap();
    let before = fs::read(&path).unwrap();
    // Block the existing write_atomic staging path, not a mocked write result.
    let obstacle = path.with_extension(format!("tmp.{}", std::process::id()));
    fs::create_dir(&obstacle).unwrap();
    assert!(journal.commit(replacement()).is_err());
    assert!(journal.is_degraded());
    assert_eq!(fs::read(&path).unwrap(), before);
    fs::remove_dir(&obstacle).unwrap();
    assert!(journal.commit(replacement()).is_err()); // No implicit retry.
    assert!(journal.snapshot().is_err()); // No healthy stale snapshot.
    let mut recovered = Journal::<Value>::begin(&path).unwrap();
    assert!(recovered.backend_generation() > journal.backend_generation());
    assert_eq!(recovered.snapshot().unwrap().batches[1].changes, replacement());
}

#[test]
fn failed_backend_barrier_does_not_advance_the_persisted_generation() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let mut current = Journal::<Value>::create(&path).unwrap();
    let before = fs::read(&path).unwrap();
    let obstacle = path.with_extension(format!("tmp.{}", std::process::id()));
    fs::create_dir(&obstacle).unwrap();
    assert!(Journal::<Value>::begin(&path).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert_eq!(current.snapshot().unwrap().backend_generation, current.backend_generation());
}

#[test]
fn serialization_failure_keeps_prior_bytes_and_blocks_further_admission() {
    #[derive(Deserialize)]
    struct RefusesSerialization;
    impl Serialize for RefusesSerialization {
        fn serialize<S: serde::Serializer>(&self, _: S) -> std::result::Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom("deliberate fixture serialization failure"))
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let mut journal = Journal::<RefusesSerialization>::create(&path).unwrap();
    let before = fs::read(&path).unwrap();
    assert!(journal.commit(vec![RefusesSerialization]).is_err());
    assert!(journal.is_degraded());
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn restart_never_skips_or_repairs_corrupt_incomplete_or_unknown_records() {
    for suffix in [b"partial".as_slice(), b"\n", b"not json\n", b"{\"version\":2,\"sequence\":2,\"backendGeneration\":1,\"changes\":[1]}\n"] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lifecycle.jsonl");
        Journal::<Value>::create(&path).unwrap();
        let mut corrupt = fs::read(&path).unwrap();
        corrupt.extend_from_slice(suffix);
        fs::write(&path, &corrupt).unwrap();
        assert!(Journal::<Value>::begin(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), corrupt);
    }
}

#[test]
fn sequence_gaps_and_wrong_generation_batches_cannot_be_replayed() {
    for invalid in [
        json!({"version":1,"sequence":3,"backendGeneration":1,"changes":[1]}),
        json!({"version":1,"sequence":2,"backendGeneration":2,"changes":[1]}),
        json!({"version":1,"sequence":2,"backendGeneration":1,"changes":[]}),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lifecycle.jsonl");
        let mut journal = Journal::<Value>::create(&path).unwrap();
        let mut corrupt = fs::read(&path).unwrap();
        corrupt.extend_from_slice(format!("{invalid}\n").as_bytes());
        fs::write(&path, &corrupt).unwrap();
        assert!(journal.snapshot().is_err());
        assert!(journal.is_degraded());
        assert!(Journal::<Value>::begin(&path).is_err());
        assert_eq!(fs::read(&path).unwrap(), corrupt);
    }
}

#[test]
fn missing_or_empty_journal_on_restart_is_not_a_new_generation_one() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let mut journal = Journal::<Value>::create(&path).unwrap();
    fs::remove_file(&path).unwrap();
    assert!(journal.commit(replacement()).is_err());
    assert!(Journal::<Value>::begin(&path).is_err());
    assert!(!path.exists());
    fs::write(&path, b"").unwrap();
    assert!(Journal::<Value>::begin(&path).is_err());
    assert!(Journal::<Value>::create(&path).is_err());
    assert!(fs::read(&path).unwrap().is_empty());
}

#[test]
fn create_cannot_overwrite_an_existing_journal_and_empty_commit_is_not_a_barrier() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let mut journal = Journal::<Value>::create(&path).unwrap();
    let before = fs::read(&path).unwrap();
    assert!(Journal::<Value>::create(&path).is_err());
    assert!(journal.commit(Vec::new()).is_err());
    assert!(journal.is_degraded());
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn capacity_failure_preserves_history_and_does_not_return_acceptance() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let mut journal = Journal::<Value>::create(&path).unwrap();
    let before = fs::read(&path).unwrap();
    assert!(journal.commit(vec![json!("x".repeat(MAX_BYTES))]).is_err());
    assert!(journal.is_degraded());
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn successful_serialization_with_missing_required_replay_field_is_rejected_before_write() {
    #[derive(Serialize, Deserialize)]
    struct Change {
        #[serde(skip_serializing)]
        required: String,
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let mut journal = Journal::<Change>::create(&path).unwrap();
    let before = fs::read(&path).unwrap();
    let change = Change { required: "must survive replay".into() };
    assert!(!change.required.is_empty());
    assert_eq!(serde_json::to_vec(&change).unwrap(), b"{}");
    let result = journal.commit(vec![change]);
    assert!(result.is_err()); // Old code returns a receipt and corrupts replay.
    assert!(journal.is_degraded());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(journal.snapshot().is_err());
    let mut restarted = Journal::<Change>::begin(&path).unwrap();
    let snapshot = restarted.snapshot().unwrap();
    assert_eq!(snapshot.batches.len(), 2); // Only the two backend barriers.
    assert!(snapshot.batches.iter().all(|batch| batch.changes.is_empty()));
}

#[test]
fn ordinary_typed_payload_returns_a_receipt_and_replays_after_restart() {
    #[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
    struct Change { required: String }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let mut journal = Journal::<Change>::create(&path).unwrap();
    let before = fs::read(&path).unwrap();
    let receipt = journal.commit(vec![Change { required: "retained".into() }]).unwrap();
    assert!(!journal.is_degraded());
    assert_eq!(journal.snapshot().unwrap().batches[1], receipt);
    assert!(fs::read(&path).unwrap().starts_with(&before));
    let mut restarted = Journal::<Change>::begin(&path).unwrap();
    let snapshot = restarted.snapshot().unwrap();
    assert_eq!(snapshot.batches[1], receipt);
    assert_eq!(snapshot.batches[1].changes[0].required, "retained");
}

#[test]
fn ordered_enqueue_retains_transaction_ownership_against_another_handle() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let mut journal = Journal::<Value>::create(&path).unwrap();
    let (queue, receiver) = mpsc::sync_channel(1);
    let (checked, observed) = mpsc::channel();
    let mut competitor = None;
    let other_path = path.clone();
    let accepted = journal.commit_ordered_with(replacement(), |pending| {
        competitor = Some(std::thread::spawn(move || {
            // A separate descriptor observes the real stable lock, not a
            // bridge-local mutex. Then the second Journal handle attempts begin.
            let lock = fs::OpenOptions::new().read(true).write(true).open(other_path.with_extension("lock")).unwrap();
            assert!(matches!(lock.try_lock(), Err(std::fs::TryLockError::WouldBlock)));
            checked.send(()).unwrap();
            Journal::<Value>::begin(&other_path).unwrap().backend_generation()
        }));
        observed.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(queue.try_send(pending).is_ok());
        Ok(())
    }).unwrap();
    assert_eq!(accepted.publication(), Publication::Queued);
    let later_generation = competitor.unwrap().join().unwrap();
    assert!(later_generation > accepted.receipt().sequence);
    let pending = receiver.try_recv().unwrap();
    assert_eq!(pending.state(), DeliveryState::Pending);
    assert!(pending.receipt().is_none());
    // No outer transport/bridge locks in this fixture. A real coordinator must
    // drop those first; this ticket alone does not assert current-owner status.
    assert!(accepted.release_delivery());
    assert_eq!(pending.receipt().unwrap(), accepted.receipt());
    assert!(!accepted.release_delivery());
}

#[test]
fn queue_full_preserves_the_accepted_receipt_and_degrades_without_retry() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let mut journal = Journal::<Value>::create(&path).unwrap();
    let (queue, receiver) = mpsc::sync_channel(1);
    let first = journal.commit_ordered(vec![json!("first")], &queue).unwrap();
    let lost = journal.commit_ordered(replacement(), &queue).unwrap();
    assert_eq!(lost.publication(), Publication::Lost(EnqueueLoss::Full));
    assert_eq!(lost.receipt().sequence, first.receipt().sequence + 1);
    assert!(journal.is_degraded());
    assert!(!lost.release_delivery());
    let before = fs::read(&path).unwrap();
    assert!(journal.commit_ordered(replacement(), &queue).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    drop(first); // A queued but unreleased acceptance must never become ready.
    let pending = receiver.try_recv().unwrap();
    assert_eq!(pending.state(), DeliveryState::Abandoned);
    assert!(pending.receipt().is_none());
    let mut restarted = Journal::<Value>::begin(&path).unwrap();
    assert_eq!(&restarted.snapshot().unwrap().batches[2], lost.receipt());
}

#[test]
fn disconnected_queue_is_persisted_but_not_published() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let mut journal = Journal::<Value>::create(&path).unwrap();
    let (queue, receiver) = mpsc::sync_channel(1);
    drop(receiver);
    let accepted = journal.commit_ordered(replacement(), &queue).unwrap();
    assert_eq!(accepted.publication(), Publication::Lost(EnqueueLoss::Disconnected));
    assert!(journal.is_degraded());
    assert!(!accepted.release_delivery());
    assert!(journal.snapshot().is_err());
    let mut restarted = Journal::<Value>::begin(&path).unwrap();
    assert_eq!(&restarted.snapshot().unwrap().batches[1], accepted.receipt());
}

#[test]
fn enqueue_panic_retains_receipt_and_abandons_even_an_already_queued_ticket() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let mut journal = Journal::<Value>::create(&path).unwrap();
    let (queue, receiver) = mpsc::sync_channel(1);
    // Private fault-injection seam, not an exposed user callback API. Exercise
    // the ambiguous "sent, then panic" case without losing persisted evidence.
    let accepted = journal.commit_ordered_with(replacement(), |pending| {
        assert!(queue.try_send(pending).is_ok());
        panic!("source fixture enqueue panic");
    }).unwrap();
    assert_eq!(accepted.publication(), Publication::Panicked);
    assert!(journal.is_degraded());
    assert!(!accepted.release_delivery());
    let pending = receiver.try_recv().unwrap();
    assert_eq!(pending.state(), DeliveryState::Abandoned);
    assert!(pending.receipt().is_none());
    assert!(journal.commit(replacement()).is_err());
    let mut restarted = Journal::<Value>::begin(&path).unwrap();
    assert_eq!(&restarted.snapshot().unwrap().batches[1], accepted.receipt());
}

#[test]
fn ordered_precommit_write_failure_neither_returns_receipt_nor_enqueues() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("lifecycle.jsonl");
    let mut journal = Journal::<Value>::create(&path).unwrap();
    let before = fs::read(&path).unwrap();
    let obstacle = path.with_extension(format!("tmp.{}", std::process::id()));
    fs::create_dir(&obstacle).unwrap();
    let (queue, receiver) = mpsc::sync_channel(1);
    assert!(journal.commit_ordered(replacement(), &queue).is_err());
    assert!(journal.is_degraded());
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(matches!(receiver.try_recv(), Err(mpsc::TryRecvError::Empty)));
}
