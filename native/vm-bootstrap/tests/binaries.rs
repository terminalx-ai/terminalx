//! The built executables on this host, unprivileged. Neither is ever run as
//! root here and no guest is involved.
#![cfg(target_os = "macos")]
use std::{
    path::Path,
    process::Command,
    time::{Duration, Instant},
};

const STATE: &str = "/private/var/db/com.terminalx.next.vm-validation";

/// Outside a seeded guest the probe's state directory is absent, so it must
/// refuse at once, write nothing and still exit 0 (no KeepAlive restart).
#[test]
fn probe_refuses_cleanly_outside_a_seeded_guest() {
    assert!(
        !Path::new(STATE).exists(),
        "this host must not have the probe's state directory"
    );
    let started = Instant::now();
    let output = Command::new(env!("CARGO_BIN_EXE_terminalx-vm-validation-probe"))
        .arg("ignored")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("Refused"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stdout.is_empty());
    assert!(!Path::new(STATE).exists());
}

fn seed_tool(args: &[&str]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_terminalx-vm-seed"))
        .args(args)
        .output()
        .unwrap()
}

#[test]
fn seed_tool_refuses_usage_non_root_and_non_mounts() {
    for args in [&[][..], &["seed"], &["inspect", "a", "b"], &["erase", "/"]] {
        assert_eq!(seed_tool(args).status.code(), Some(64), "{args:?}");
    }
    let temp = tempfile::tempdir().unwrap();
    let dir = temp.path().to_str().unwrap();
    // SAFETY: no preconditions.
    if unsafe { libc::geteuid() } != 0 {
        let output = seed_tool(&["seed", dir, "/usr/bin/true"]);
        assert_eq!(output.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&output.stderr).contains("must run as root"));
    }
    let output = seed_tool(&["inspect", dir]);
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("not a mount point"));
    assert_eq!(
        seed_tool(&["readback", dir, &format!("{dir}/absent.json")])
            .status
            .code(),
        Some(2)
    );
    assert_eq!(
        std::fs::read_dir(temp.path()).unwrap().count(),
        0,
        "nothing written"
    );
}
