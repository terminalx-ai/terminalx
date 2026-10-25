//! Disposable local owner only: no installed app, guest, provider turn or auth.
#![cfg(unix)]
mod common;
use common::agent::{AgentWorld, Serve};
use raccoon_lib::local_runtime::{client::Client, sessions::Sessions};
use raccoon_lib::local_vm::journal::Journal;
use serde_json::{json, Value};
use std::time::{Duration, Instant};

#[test]
fn vm_unknown_work_survives_detach_and_refuses_stop_without_revoking_the_owner() {
    let world = AgentWorld::new();
    let journal = Journal::open(&world.data.join("local-vm")).unwrap();
    let env = journal
        .enroll("fixture guest", "local:never-started")
        .unwrap();
    journal
        .transaction(|state| {
            state.environments.get_mut(&env.id).unwrap().provision =
                Some(json!({"status":"outcomeUnknown"}));
            Ok(())
        })
        .unwrap();
    let mut command = world.command();
    command.args(["--idle-grace-seconds", "1"]);
    let mut serve = Serve::start(command, &world.data);
    let client = Client::connect(&world.data).unwrap();
    let attachment: Value = client
        .call("runtime.attach", json!({"protocol":1}))
        .unwrap();
    let sessions = Sessions::new(client.clone());
    let state = sessions.local_vm("state", json!({})).unwrap();
    assert_eq!(
        state["environments"][&env.id]["provision"]["status"],
        "outcomeUnknown"
    );
    let _: Value = client.call("runtime.detach", attachment.clone()).unwrap();
    std::thread::sleep(Duration::from_secs(2));
    assert!(serve.child.try_wait().unwrap().is_none());
    assert!(client.stop_all().is_err());
    let status: Value = client.call("status", json!({})).unwrap();
    assert_eq!(status["localRuntime"]["stopping"], false);
    let next: Value = client
        .call("runtime.attach", json!({"protocol":1}))
        .unwrap();
    assert_eq!(attachment["epoch"], next["epoch"]);
    // Fixture-only reconciliation; never issues a guest or Cua operation.
    journal
        .transaction(|state| {
            state.environments.get_mut(&env.id).unwrap().provision =
                Some(json!({"status":"failed"}));
            Ok(())
        })
        .unwrap();
    client.stop_all().unwrap();
    let until = Instant::now() + Duration::from_secs(10);
    while serve.child.try_wait().unwrap().is_none() {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(25));
    }
}

#[test]
fn a_legacy_vm_controller_lock_refuses_migration_without_replacing_its_journal() {
    use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
    let world = AgentWorld::new();
    let root = world.data.join("local-vm");
    let journal = Journal::open(&root).unwrap();
    journal.read().unwrap();
    let before = std::fs::read(root.join("journal.json")).unwrap();
    let lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .open(root.join("supervisor.lock"))
        .unwrap();
    // SAFETY: the fixture owns the descriptor until the child has refused startup.
    assert_eq!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
    let output = world
        .command()
        .stderr(std::process::Stdio::piped())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("supervisor already owns"));
    assert_eq!(std::fs::read(root.join("journal.json")).unwrap(), before);
}
