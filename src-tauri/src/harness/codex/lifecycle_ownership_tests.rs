//! Source-only ownership drafts: real OS file locks/journal/coordinator,
//! source-derived lifecycle messages, no child process or provider execution.
use super::*;
use super::super::super::owned_transport::Owner;
use std::fs;

fn scope() -> Scope {
    Scope { owner: Owner { session_id: "s".into(), tab_id: "t".into(), subagent_id: None },
        conversation_id: None, thread_id: "thread".into() }
}

#[test]
fn retained_sink_and_subscription_keep_owner_after_coordinator_handle_drops() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.jsonl");
    let domain = Domain::default();
    let coordinator = Coordinator::open_owned(domain.clone(), &path, OwnerOpen::Create).unwrap();
    let sink = coordinator.bind(scope()).unwrap();
    let installed = coordinator.subscribe().unwrap();
    let bytes = fs::read(&path).unwrap();
    drop(coordinator);
    assert!(Journal::<Envelope>::begin(&path).is_err()); // raw bypass also refused
    assert!(Coordinator::open_owned(domain.clone(), &path, OwnerOpen::Restart).is_err());
    drop(sink);
    assert!(Journal::<Envelope>::begin_owned(&path).is_err());
    assert_eq!(bytes, fs::read(&path).unwrap());
    drop(installed.subscription);
    // Historical stream/snapshot values carry no owner lease.
    let restarted = Coordinator::open_owned(domain, &path, OwnerOpen::Restart).unwrap();
    let snapshot = restarted.subscribe().unwrap();
    assert_eq!(snapshot.watermark, 3);
    assert_eq!(snapshot.frames.last().unwrap().evidence[0].signal,
        Signal::ContinuityLost { reason: Loss::Restarted });
    assert!(!snapshot.stream.matches(&installed.stream));
}

#[test]
fn separate_domains_and_independent_descriptors_cannot_duplicate_owner() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.jsonl");
    let c = Coordinator::open_owned(Domain::default(), &path, OwnerOpen::Create).unwrap();
    let bytes = fs::read(&path).unwrap();
    let descriptor = fs::OpenOptions::new().read(true).write(true)
        .open(path.with_extension("owner.lock")).unwrap();
    assert!(matches!(descriptor.try_lock(), Err(fs::TryLockError::WouldBlock)));
    assert!(Coordinator::open_owned(Domain::default(), &path, OwnerOpen::Restart).is_err());
    assert!(Journal::<Envelope>::create(&path).is_err());
    assert_eq!(bytes, fs::read(&path).unwrap());
    drop(c);
    descriptor.try_lock().unwrap(); // last reference releases actual OS lease
}

#[test]
fn initialization_failure_releases_lease_without_repair_or_generation_write() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.jsonl");
    fs::write(&path, b"incomplete").unwrap();
    assert!(Coordinator::open_owned(Domain::default(), &path, OwnerOpen::Restart).is_err());
    assert_eq!(fs::read(&path).unwrap(), b"incomplete");
    let descriptor = fs::OpenOptions::new().read(true).write(true)
        .open(path.with_extension("owner.lock")).unwrap();
    descriptor.try_lock().unwrap();
    // Missing restart is not implicit create; no journal manufactured.
    let missing = dir.path().join("missing.jsonl");
    assert!(Journal::<Envelope>::begin_owned(&missing).is_err());
    assert!(!missing.exists());
}

#[test]
fn domain_refuses_rebinding_to_another_owned_journal_namespace() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("first.jsonl");
    let second = dir.path().join("second.jsonl");
    let domain = Domain::default();
    let c = Coordinator::open_owned(domain.clone(), &first, OwnerOpen::Create).unwrap();
    let original = c.subscribe().unwrap();
    drop(c);
    drop(original.subscription);
    // Raise B in the other namespace so rejection discriminates namespace,
    // not merely the already-existing nonmonotonic generation check.
    drop(Journal::<Envelope>::create(&second).unwrap());
    let other = Journal::<Envelope>::begin_owned(&second).unwrap();
    assert!(Coordinator::adopt(domain.clone(), other).is_err());
    let resumed = Coordinator::open_owned(domain, &first, OwnerOpen::Restart).unwrap();
    assert_eq!(resumed.subscribe().unwrap().stream.backend, 2);
}

#[cfg(unix)]
#[test]
fn canonical_parent_alias_contends_and_unsafe_sidecar_is_refused() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("private");
    fs::create_dir(&real).unwrap();
    let alias = dir.path().join("alias");
    symlink(&real, &alias).unwrap();
    let path = real.join("journal.jsonl");
    let owner = Journal::<Envelope>::create_owned(&path).unwrap();
    assert_eq!(owner.owned_namespace().unwrap(), fs::canonicalize(&real).unwrap().join("journal.jsonl"));
    assert!(Journal::<Envelope>::begin_owned(&alias.join("journal.jsonl")).is_err());
    drop(owner);
    let lock = path.with_extension("owner.lock");
    fs::set_permissions(&lock, fs::Permissions::from_mode(0o666)).unwrap();
    let bytes = fs::read(&path).unwrap();
    assert!(Journal::<Envelope>::begin_owned(&path).is_err());
    fs::remove_file(&lock).unwrap(); // test fixture only, never production cleanup
    let target = real.join("untouched");
    fs::write(&target, b"private data").unwrap();
    symlink(&target, &lock).unwrap();
    assert!(Journal::<Envelope>::begin_owned(&path).is_err());
    assert_eq!(fs::read(&path).unwrap(), bytes);
    assert_eq!(fs::read(&target).unwrap(), b"private data");
}
