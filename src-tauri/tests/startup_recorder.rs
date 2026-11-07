//! Exercise production entry points, including the recorder's own child launches.
//! A libtest executable cannot stand in for current_exe() in these paths.
#![cfg(all(unix, feature = "desktop"))]

use std::fs;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

struct Recorder {
    temporary: Option<tempfile::TempDir>,
    directory: PathBuf,
    child: Child,
}

impl Recorder {
    fn start(command: Option<&str>) -> Self {
        let temporary = tempfile::tempdir().unwrap();
        let directory = temporary.path().join(uuid::Uuid::new_v4().to_string());
        fs::DirBuilder::new().mode(0o700).create(&directory).unwrap();
        let mut process = Command::new(env!("CARGO_BIN_EXE_raccoon"));
        process.env_clear().env("PATH", "/usr/bin:/bin")
            .env("TERMINALX_HOME", temporary.path().join("unused-home"))
            .stdin(Stdio::null()).stdout(Stdio::null())
            .stderr(fs::File::create(directory.join("recorder.stderr")).unwrap());
        if let Some(command) = command {
            process.arg("--startup-validation-recorder").arg(&directory).arg(&directory).arg(command);
        } else {
            process.arg("--startup-recorder").arg(&directory);
        }
        Self { child: process.spawn().unwrap(), temporary: Some(temporary), directory }
    }

    fn wait_for(&self, file: &str) -> Value {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(content) = fs::read(self.directory.join(file)) {
                return serde_json::from_slice(&content).unwrap();
            }
            assert!(Instant::now() < deadline, "recorder {} did not write {file}; evidence in {}", self.child.id(), self.directory.display());
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn finish(&mut self) -> ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() { return status; }
            assert!(Instant::now() < deadline, "recorder {} still pending; evidence in {}", self.child.id(), self.directory.display());
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        // Do not kill a pending recorder or erase evidence on a failed test.
        if std::thread::panicking() || !matches!(self.child.try_wait(), Ok(Some(_))) {
            if let Some(temporary) = self.temporary.take() {
                eprintln!("preserved recorder {} evidence: {}", self.child.id(), temporary.keep().display());
            }
        }
    }
}

#[test]
fn production_health_recorder_runs_shell_and_native_without_starting_an_app() {
    let mut recorder = Recorder::start(None);
    let result = recorder.wait_for("result.json");
    assert!(recorder.finish().success());
    assert_eq!(result["shell"]["exitCode"], 0);
    assert_eq!(result["native"]["exitCode"], 0);
    assert_eq!(result["native"]["stdout"], "terminalx-startup-ready\n");
    assert_eq!(result["native"]["stderr"], "");
    assert_eq!(recorder.wait_for("shell.json"), result["shell"]);
    assert!(!recorder.temporary.as_ref().unwrap().path().join("unused-home").exists());
    assert_eq!(fs::metadata(recorder.directory.join("result.json")).unwrap().permissions().mode() & 0o777, 0o600);
}

#[test]
fn leader_exit_is_durable_while_a_grandchild_keeps_output_pending() {
    let mut recorder = Recorder::start(Some(r#"
        (i=0; while [ ! -f release ] && [ "$i" -lt 1000 ]; do
            sleep 0.02; i=$((i + 1));
        done) &
        printf '{"fixture":true}'
        printf fixture-stderr >&2
        exit 23
    "#));
    let exit = recorder.wait_for("exit.json");
    assert_eq!(exit["exitCode"], 23);
    assert_eq!(exit["signal"], Value::Null);
    assert!(!recorder.directory.join("validation.json").exists());
    assert!(recorder.child.try_wait().unwrap().is_none());
    // An observation that ends here is still pending. The recorder, not that
    // observation, keeps responsibility for EOF and the exact final result.
    fs::write(recorder.directory.join("release"), []).unwrap();
    let result = recorder.wait_for("validation.json");
    assert!(recorder.finish().success());
    assert_eq!(result["result"]["exitCode"], 23);
    assert_eq!(result["result"]["stdout"], "{\"fixture\":true}");
    assert_eq!(result["result"]["stderr"], "fixture-stderr");
    assert_eq!(result["result"]["spawnFailed"], false);
}

#[test]
fn real_child_output_is_drained_and_bounded_without_changing_failure_status() {
    let mut recorder = Recorder::start(Some(r#"
        i=0; while [ "$i" -lt 10000 ]; do
            printf x; printf y >&2; i=$((i + 1));
        done
        exit 7
    "#));
    let result = recorder.wait_for("validation.json");
    assert!(recorder.finish().success());
    assert_eq!(result["result"]["exitCode"], 7);
    for stream in ["stdout", "stderr"] {
        assert_eq!(result["result"][stream].as_str().unwrap().len(), 8192);
        assert_eq!(result["result"][format!("{stream}Truncated")], true);
    }
}

#[test]
fn signaled_child_is_never_recorded_as_exit_zero() {
    let mut recorder = Recorder::start(Some("kill -TERM $$"));
    let result = recorder.wait_for("validation.json");
    assert!(recorder.finish().success());
    assert_eq!(result["result"]["exitCode"], Value::Null);
    assert_eq!(result["result"]["signal"], libc::SIGTERM);
    assert_eq!(recorder.wait_for("exit.json")["signal"], libc::SIGTERM);
}
