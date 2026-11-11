use super::*;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Instant;

const CHILD_TEST: &str = "github_process::group::tests::cleanup_ownership_child";

#[test]
fn successful_process_groups_keep_ownership_until_cleanup_and_acknowledgement() {
    for managed in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", CHILD_TEST, "--nocapture"])
            .env("TERMINALX_TEST_GROUP_OWNERSHIP", if managed { "managed" } else { "personal" })
            .env_remove("TERMINALX_TEST_MANAGED_PRIVACY")
            .env("TERMINALX_HOME", root.path().canonicalize().unwrap()).output().unwrap();
        assert!(output.status.success(), "managed={managed}\n{}\n{}",
            String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    }
}

struct Unrelated(std::process::Child);
impl Unrelated {
    fn new() -> Self {
        Self(Command::new("/bin/sleep").arg("60").process_group(0)
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap())
    }
    fn assert_running(&mut self) { assert!(self.0.try_wait().unwrap().is_none(), "unrelated process was stopped"); }
}
impl Drop for Unrelated {
    fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}

fn command(marker: &Path, descendant: bool) -> Command {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", if descendant { r#"
/bin/sleep 60 </dev/null >/dev/null 2>&1 &
printf '%s' "$!" > "$1.tmp"
/bin/mv "$1.tmp" "$1"
printf retained-output
printf retained-error >&2
exit 0
"# } else { "printf retained-output; printf retained-error >&2; exit 7" }, "owned-group"]).arg(marker);
    command
}

fn descendant(marker: &Path) -> i32 { std::fs::read_to_string(marker).unwrap().parse().unwrap() }

fn assert_gone(pid: i32) {
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "owned descendant survived group drain");
    assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
}

// This observes the actual production group signals/scans/wait. WNOWAIT is
// deliberately checked at each boundary: changing production back to try_wait
// makes this fail with ECHILD *before* any unsafe signal could be attempted.
fn assert_anchor(pid: u32, event: Event) {
    if event == Event::Reaped {
        assert_eq!(exited(pid).unwrap_err().raw_os_error(), Some(libc::ECHILD));
    } else {
        assert!(exited(pid).expect("group cleanup must still own a waitable child"));
    }
}

fn successful_exit(root: &Path, has_descendant: bool) {
    let marker = root.join(if has_descendant { "success-child" } else { "success-alone" });
    let events = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&events);
    let observed_marker = marker.clone();
    OBSERVER.with(|observer| observer.replace(Some(Box::new(move |pid, event| {
        assert_anchor(pid, event);
        let mut events = seen.lock().unwrap();
        assert!(!events.contains(&Event::Reaped), "a numeric group operation followed reaping");
        if events.is_empty() && has_descendant {
            assert_eq!(event, Event::Signal(libc::SIGKILL));
            let child = descendant(&observed_marker);
            assert_eq!(unsafe { libc::getpgid(child) }, pid as i32);
            assert_eq!(unsafe { libc::kill(child, 0) }, 0, "successful parent left a real live child");
        }
        if event == Event::Reap {
            assert!(!other_members(pid).unwrap(), "descendants must drain before leader reap");
            if has_descendant { assert_gone(descendant(&observed_marker)); }
        }
        events.push(event);
    }))));
    let output = super::super::output(command(&marker, has_descendant), Duration::from_secs(5), None).unwrap();
    OBSERVER.with(|observer| observer.take());
    assert_eq!(output.status.code(), Some(if has_descendant { 0 } else { 7 }), "group cleanup preserves the leader's original exit code");
    assert_eq!(output.stdout, b"retained-output");
    assert_eq!(output.stderr, b"retained-error");
    let events = events.lock().unwrap();
    assert!(events.contains(&Event::Signal(libc::SIGKILL)));
    assert!(events.contains(&Event::Scan));
    assert_eq!(&events[events.len()-2..], &[Event::Reap, Event::Reaped]);
}

#[test]
fn cleanup_ownership_child() {
    let Ok(kind) = std::env::var("TERMINALX_TEST_GROUP_OWNERSHIP") else { return };
    let root = crate::store::root().unwrap();
    let preference = root.join("data-privacy.json");
    crate::store::write_json(&preference, &serde_json::json!({"enabled":false})).unwrap();
    crate::data_privacy::initialize();
    let mut unrelated = Unrelated::new();
    successful_exit(&root, false);
    successful_exit(&root, true);
    unrelated.assert_running();

    // Pause a real successful leader at the first destructive group signal.
    // Activation must wait even though the leader exited and its descendant
    // closed every inherited stdio descriptor. Pipe EOF alone is insufficient.
    let marker = root.join("activation-child");
    let (ready, paused) = mpsc::channel();
    let (release, resume) = mpsc::channel();
    let observed_marker = marker.clone();
    let worker = std::thread::spawn(move || {
        let first = std::cell::Cell::new(true);
        OBSERVER.with(|observer| observer.replace(Some(Box::new(move |pid, event| {
            assert_anchor(pid, event);
            if event == Event::Signal(libc::SIGKILL) && first.replace(false) {
                let child = descendant(&observed_marker);
                assert_eq!(unsafe { libc::getpgid(child) }, pid as i32);
                ready.send((pid, child)).unwrap();
                resume.recv_timeout(Duration::from_secs(10)).unwrap();
                assert_anchor(pid, event);
            }
            if event == Event::Reap { assert_gone(descendant(&observed_marker)); }
        }))));
        super::super::output(command(&marker, true), Duration::from_secs(10), None)
    });
    let (leader, child) = paused.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(exited(leader).unwrap(), "the leader is exited but still reserved");
    if kind == "managed" { std::env::set_var("TERMINALX_TEST_MANAGED_PRIVACY", "1"); }
    else { crate::store::write_json(&preference, &serde_json::json!({"enabled":true})).unwrap(); }
    let (ack, acknowledged) = mpsc::channel();
    let activation = std::thread::spawn(move || ack.send(crate::data_privacy::refresh()).unwrap());
    let until = Instant::now() + Duration::from_secs(5);
    while !crate::data_privacy::enabled() { assert!(Instant::now() < until); std::thread::sleep(Duration::from_millis(5)); }
    assert!(acknowledged.recv_timeout(Duration::from_millis(100)).is_err(), "activation released while owned descendants were alive");
    assert_eq!(unsafe { libc::kill(child, 0) }, 0);
    release.send(()).unwrap();
    let status = acknowledged.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(status.enabled);
    assert_eq!(status.managed, kind == "managed");
    assert_gone(child);
    assert_eq!(worker.join().unwrap().unwrap_err().to_string(), crate::data_privacy::MESSAGE);
    activation.join().unwrap();
    unrelated.assert_running();
    std::env::remove_var("TERMINALX_TEST_MANAGED_PRIVACY");
    crate::store::write_json(&preference, &serde_json::json!({"enabled":false})).unwrap();
    assert!(!crate::data_privacy::refresh().enabled);
    successful_exit(&root, true);
    unrelated.assert_running();
}

#[test]
fn a_reaped_anchor_refuses_every_numeric_group_operation() {
    // No PID churn/reuse experiment: deliberately consume only our own child,
    // then verify the real signal boundary refuses the now-unowned identifier.
    let mut process = Command::new("/bin/sh");
    process.args(["-c", "exit 0"]).process_group(0);
    let mut child = Child::new(process.spawn().unwrap());
    assert!(child.0.wait().unwrap().success());
    OBSERVER.with(|observer| observer.replace(Some(Box::new(|_, event| {
        panic!("reaped anchor reached a group operation: {event:?}");
    }))));
    assert_eq!(child.finish(false).unwrap_err().raw_os_error(), Some(libc::ECHILD));
    OBSERVER.with(|observer| observer.take());
}
