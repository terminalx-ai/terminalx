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
