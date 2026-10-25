//! Re-exec only this fixture test in disposable homes. Separate processes
//! exercise the OS lock and atomic rename, not just an in-process mutex.
use super::*;
use serde_json::json;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const FIXTURE: &str = "TERMINALX_INDEX_TRANSACTION_FIXTURE";
const CHILD_TEST: &str = "store::index::transaction_tests::transaction_child";

struct Worker(Child);
impl Drop for Worker {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}

fn worker(mode: &str) -> Worker {
    let root = crate::store::root().unwrap();
    Worker(Command::new(std::env::current_exe().unwrap())
        .args(["--exact", CHILD_TEST, "--nocapture"])
        .env_clear().env(FIXTURE, mode)
        .env("TERMINALX_HOME", &root).env("CLAUDE_CONFIG_DIR", root.join("private-claude"))
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit())
        .spawn().unwrap())
}

fn seed() {
    let session: SessionEntry = serde_json::from_value(json!({
        "id":"session", "projectPath":"/fixture", "cwd":"/fixture",
        "title":"original", "created":"before", "modified":"before",
        "futureSessionField":{"keep":true},
        "tabs":[{"id":"history","harness":"claude","created":"before","providerSessionId":"retained-provider", "futureTabField":7}]
    })).unwrap();
    save(&[session]).unwrap();
    close_tab("session", "history", true).unwrap();
    update_file(|file| { file.unknown.insert("futureIndexField".into(), json!({"keep":true})); Ok(()) }).unwrap();
}

#[test]
fn transaction_child() {
    let Ok(mode) = std::env::var(FIXTURE) else { return };
    if mode == "hold" {
        with_file_lock::<()>(|| {
            std::fs::write(crate::store::root()?.join("lock-held"), b"ready")?;
            loop { std::thread::sleep(Duration::from_secs(1)); }
        }).unwrap();
        return;
    }
    for _ in 0..25 {
        update_session("session", |session| {
            let before = session.unknown.get(&mode).and_then(serde_json::Value::as_u64).unwrap_or(0);
            // Widen the lost-update window while each process holds its own
            // already-read snapshot. With only a write lock this loses writes.
            std::thread::sleep(Duration::from_millis(2));
            session.unknown.insert(mode.clone(), json!(before + 1));
            Ok(())
        }).unwrap();
    }
}

#[test]
fn concurrent_process_updates_retain_every_write_and_closed_history() {
    let _home = crate::store::temp_home();
    seed();
    let mut workers: Vec<_> = (0..4).map(|i| worker(&format!("worker{i}"))).collect();
    for worker in &mut workers { assert!(worker.0.wait().unwrap().success()); }
    let file = load_file().unwrap();
    let session = &file.sessions[0];
    for i in 0..4 { assert_eq!(session.unknown[&format!("worker{i}")], 25); }
    assert_eq!(session.unknown["futureSessionField"], json!({"keep":true}));
    assert_eq!(file.unknown["futureIndexField"], json!({"keep":true}));
    assert_eq!(file.closed_tabs.len(), 1);
    assert_eq!(file.closed_tabs[0].tab.provider_session_id.as_deref(), Some("retained-provider"));
    let restored = reopen_tab("session", "history").unwrap();
    assert_eq!(serde_json::to_value(restored).unwrap()["futureTabField"], 7);
}

#[test]
fn failures_and_reentrancy_do_not_commit_or_keep_the_lock() {
    let _home = crate::store::temp_home();
    seed();
    let before = std::fs::read(file_path().unwrap()).unwrap();
    let result: Result<()> = update(|sessions| {
        sessions.clear();
        anyhow::bail!("fixture rejected mutation")
    });
    assert!(result.is_err());
    assert_eq!(std::fs::read(file_path().unwrap()).unwrap(), before);
    update(|_| {
        let nested = update(|_| Ok(()));
        assert!(nested.unwrap_err().to_string().contains("nested store transactions"));
        Ok(())
    }).unwrap();
    update_session("session", |session| { session.title = "after error".into(); Ok(()) }).unwrap();
    assert_eq!(get("session").unwrap().title, "after error");
    std::fs::write(file_path().unwrap(), b"{corrupt").unwrap();
    assert!(update(|_| Ok(())).is_err());
    assert_eq!(std::fs::read(file_path().unwrap()).unwrap(), b"{corrupt");
}

#[test]
fn a_crashed_owner_releases_the_stable_lock_and_timeout_does_not_mutate() {
    let _home = crate::store::temp_home();
    seed();
    let mut held = worker("hold");
    let deadline = Instant::now() + Duration::from_secs(10);
    while !crate::store::root().unwrap().join("lock-held").exists() {
        assert!(Instant::now() < deadline, "child did not acquire transaction lock");
        std::thread::sleep(Duration::from_millis(10));
    }
    let lock_path = file_path().unwrap().with_extension("lock");
    let before = std::fs::read(file_path().unwrap()).unwrap();
    let error = transaction::run(&lock_path, Duration::from_millis(30), || -> Result<()> {
        panic!("a timed-out transaction must never call its mutation");
    }).unwrap_err();
    assert!(error.to_string().contains("timed out"));
    assert_eq!(std::fs::read(file_path().unwrap()).unwrap(), before);
    held.0.kill().unwrap();
    held.0.wait().unwrap();
    update_session("session", |session| { session.title = "after crash".into(); Ok(()) }).unwrap();
    assert!(lock_path.exists(), "never unlink a lock other processes can be waiting on");
    assert_eq!(get("session").unwrap().title, "after crash");
}
