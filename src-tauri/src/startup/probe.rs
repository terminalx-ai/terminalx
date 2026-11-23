//! A single detached recorder survives the observing app. The timeout only
//! ends observation: it neither abandons wait() nor turns silence into success.
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use super::{recorder, Phase, RecorderExit, RecorderIdentity, Snapshot};

const OBSERVE_MS: i64 = 15_000;
const OUTPUT_LIMIT: u64 = 8192;
const READY: &str = "terminalx-startup-ready\n";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub id: String,
    pub started_at: i64,
    pub observation_timed_out: bool,
    pub result: Option<ProbeResult>,
    #[serde(default)]
    pub shell: Option<Captured>,
    #[serde(default)]
    pub owner: Option<RecorderIdentity>,
    #[serde(default)]
    pub owner_exit: Option<RecorderExit>,
}

impl Probe {
    fn can_retry(&self) -> bool {
        self.owner_exit.as_ref().is_some_and(|exit| exit.never_spawned()
            || self.result.is_some() && exit.failure != Some(super::RecorderFailure::Wait))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub finished_at: i64,
    pub shell: Captured,
    pub native: Captured,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Captured {
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub spawn_failed: bool,
    pub stdout: String,
    pub stderr: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

fn drain(mut input: impl Read) -> (String, bool) {
    let mut kept = Vec::new();
    let mut buffer = [0; 4096];
    let mut truncated = false;
    loop {
        match input.read(&mut buffer) {
            Ok(0) => break,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => { truncated = true; break; }
            Ok(count) => {
                let keep = count.min((OUTPUT_LIMIT as usize).saturating_sub(kept.len()));
                kept.extend_from_slice(&buffer[..keep]);
                truncated |= keep < count;
            }
        }
    }
    (String::from_utf8_lossy(&kept).into_owned(), truncated)
}

pub(super) fn capture(mut command: Command) -> Captured {
    capture_with_exit(&mut command, |_, _| {})
}

pub(super) fn capture_with_exit(command: &mut Command, exited: impl FnOnce(Option<i32>, Option<i32>)) -> Captured {
    let empty = || Captured { exit_code: None, signal: None, spawn_failed: true, stdout: String::new(), stderr: String::new(), stdout_truncated: false, stderr_truncated: false };
    let Ok(mut child) = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() else { return empty() };
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let stdout = std::thread::spawn(move || drain(stdout));
    let stderr = std::thread::spawn(move || drain(stderr));
    // This recorder, not the UI's observation timeout, owns the final result.
    let status = child.wait().ok();
    #[cfg(unix)]
    let signal = { use std::os::unix::process::ExitStatusExt; status.as_ref().and_then(|status| status.signal()) };
    #[cfg(not(unix))]
    let signal = None;
    // A grandchild can hold a pipe after the leader exits. Persist its exact
    // status before waiting for EOF, while still draining bounded output.
    exited(status.and_then(|status| status.code()), signal);
    let (stdout, stdout_truncated) = stdout.join().unwrap_or_default();
    let (stderr, stderr_truncated) = stderr.join().unwrap_or_default();
    Captured { exit_code: status.and_then(|status| status.code()), signal, spawn_failed: status.is_none(), stdout, stderr, stdout_truncated, stderr_truncated }
}

fn record(directory: &Path) -> Result<()> {
    // The recorder only takes the directory minted by the app; no arbitrary
    // commands or environment are accepted by this mode.
    recorder::private_directory(directory)?;
    let mut shell = Command::new("/bin/sh");
    shell.args(["-c", "exec /usr/bin/true"]);
    let shell = capture(shell);
    // Write each completed step before starting the next. A native launch
    // may stall after the shell was proven healthy.
    crate::store::write_json(&directory.join("shell.json"), &shell)?;
    let mut native = Command::new(std::env::current_exe()?);
    native.arg("--startup-probe");
    let native = capture(native);
    crate::store::write_json(&directory.join("result.json"), &ProbeResult { finished_at: super::now(), shell, native })
}

/// Before hooks, logging, configuration, Tauri or the runtime are initialized.
pub fn probe_cli() -> bool {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() == 4 && args[0] == "--startup-validation-recorder" {
        if recorder::supervise(Path::new(&args[1]), "--startup-validation-worker", &args[1..]).is_err() { std::process::exit(1); }
        return true;
    }
    if args.len() == 4 && args[0] == "--startup-validation-worker" {
        if super::validation::record(Path::new(&args[1]), Path::new(&args[2]), &args[3]).is_err() { std::process::exit(1); }
        return true;
    }
    if args.len() == 1 && args[0] == "--startup-probe" {
        print!("{READY}");
        return true;
    }
    if args.len() == 2 && args[0] == "--startup-recorder" {
        if recorder::supervise(Path::new(&args[1]), "--startup-health-worker", &args[1..]).is_err() { std::process::exit(1); }
        return true;
    }
    if args.len() == 2 && args[0] == "--startup-health-worker" {
        if record(Path::new(&args[1])).is_err() { std::process::exit(1); }
        return true;
    }
    false
}

pub(super) fn start(directory: &Path) -> Result<()> {
    let executable = std::env::current_exe()?;
    let path = super::update_at(directory, |state| {
        refresh(directory, state, super::now())?;
        let incident = state.incidents.iter_mut().rev().find(|incident| incident.recovered_at.is_none()).context("No unresolved startup incident.")?;
        if incident.probe.as_ref().is_some_and(|probe| !probe.can_retry()) {
            if incident.probe.as_ref().is_some_and(|probe| probe.owner_exit.is_some()) {
                bail!("The previous recorder failed without proving its child work complete. Its exact owner status is retained; no duplicate probe was started.");
            }
            bail!("The incident already has a pending health recorder. Its observation timeout is not an exit; no second probe was started.");
        }
        let probe = Probe { id: uuid::Uuid::new_v4().to_string(), started_at: super::now(), observation_timed_out: false, result: None, shell: None, owner: None, owner_exit: None };
        let path = crate::store::ensure_dir(directory.join(&probe.id))?;
        // Reserve durably BEFORE starting anything. A crash in this interval
        // remains explicitly unresolved rather than launching a duplicate.
        incident.probe = Some(probe);
        Ok(path)
    })?;
    // No incident lock is held across spawn: that call itself may stall, and
    // must not prevent the monitor from persisting escalation meanwhile.
    let mut recorder = Command::new(executable);
    recorder.arg("--startup-recorder").arg(&path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).env_clear();
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        recorder.process_group(0);
    }
    let child = recorder.spawn().inspect_err(|error| recorder::spawn_failed(&path, error))
        .context("Could not start health recorder; its spawn failure is retained")?;
    recorder::reap_supervisor(child);
    Ok(())
}

pub(super) fn refresh(directory: &Path, state: &mut Snapshot, at: i64) -> Result<()> {
    // Probe requests also refresh outside the monitor tick. Join newly overdue
    // launches before any caller can recover the existing host incident.
    state.tick(at);
    let Some(incident) = state.incidents.iter_mut().rev().find(|incident| incident.recovered_at.is_none()) else { return Ok(()) };
    // Human waits anywhere on this host block recovery. Retain their progress
    // boundary after dismissal so an older probe cannot clear that wait.
    // These launches do not belong to the stalled startup: pipeline admission
    // must not mistake an unrelated permission card for an affected session.
    for launch in state.launches.iter().filter(|launch| launch.phase == Phase::PermissionPrompt) {
        if !incident.recovery_waits.contains(&launch.id) { incident.recovery_waits.push(launch.id.clone()); }
    }
    let Some(probe) = &mut incident.probe else { return Ok(()) };
    // Treat ids from disk as data, not a path capability.
    let id = uuid::Uuid::parse_str(&probe.id)?;
    recorder::refresh(&directory.join(id.to_string()), &mut probe.owner, &mut probe.owner_exit)?;
    if probe.shell.is_none() { probe.shell = crate::store::read_json(&directory.join(id.to_string()).join("shell.json"))?; }
    if probe.result.is_none() {
        probe.result = crate::store::read_json(&directory.join(id.to_string()).join("result.json"))?;
    }
    // Completion includes the supervisor's durable wait, not merely child
    // output. A late owner outcome must remain late after reopening too.
    let completed_at = probe.result.as_ref().zip(probe.owner_exit.as_ref())
        .map_or(at, |(result, exit)| result.finished_at.max(exit.finished_at));
    probe.observation_timed_out |= completed_at.saturating_sub(probe.started_at) >= OBSERVE_MS;
    let still_stalled = state.launches.iter().any(|launch| launch.phase == Phase::PermissionPrompt
        || incident.launches.contains(&launch.id) && matches!(launch.phase, Phase::Spawning | Phase::AwaitingReady));
    let last_progress = state.launches.iter().filter(|launch| incident.launches.contains(&launch.id) || incident.recovery_waits.contains(&launch.id))
        .map(|launch| launch.last_progress_at).max().unwrap_or(incident.detected_at);
    // Both health steps must follow progress. A later completion alone can
    // contain a shell result from before readiness, exit or a human wait.
    let fresh_observation = !state.census_incomplete && probe.started_at > last_progress
        && state.observation_lost_at.is_none_or(|lost| probe.started_at > lost);
    let recorder_succeeded = probe.owner_exit.as_ref().is_some_and(|exit| !exit.failed());
    if fresh_observation && !still_stalled && recorder_succeeded && probe.result.as_ref().is_some_and(|result| healthy(result) && result.finished_at > last_progress) {
        incident.recovered_at = Some(at);
    }
    Ok(())
}

fn healthy(result: &ProbeResult) -> bool {
    result.shell.exit_code == Some(0) && result.native.exit_code == Some(0)
        && !result.shell.spawn_failed && !result.native.spawn_failed
        && result.shell.signal.is_none() && result.native.signal.is_none()
        && result.native.stdout == READY && !result.native.stdout_truncated
}

pub(super) fn export(probe: &Probe) -> serde_json::Value {
    let status = match &probe.result {
        _ if probe.owner_exit.as_ref().is_some_and(|exit| exit.failed() || probe.result.is_none()) => "recorderFailure",
        Some(_) if probe.owner_exit.is_none() => "recorderPending",
        Some(result) if healthy(result) && probe.observation_timed_out => "lateSuccess",
        Some(result) if healthy(result) => "success",
        Some(_) => "applicationFailure",
        None if probe.observation_timed_out => "unresolvedStall",
        None => "observing",
    };
    // Unknown stdout/stderr is omitted in full. Regex redaction cannot prove
    // arbitrary child output free of credentials or prompts.
    serde_json::json!({ "startedAt": probe.started_at, "observationTimedOut": probe.observation_timed_out, "status": status,
        "ownerExit": probe.owner_exit.as_ref().map(recorder::export),
        "shellExitCode": probe.shell.as_ref().and_then(|shell| shell.exit_code),
        "shellSignal": probe.shell.as_ref().and_then(|shell| shell.signal),
        "result": probe.result.as_ref().map(|result| serde_json::json!({ "finishedAt": result.finished_at,
            "shellExitCode": result.shell.exit_code, "shellSignal": result.shell.signal,
            "nativeExitCode": result.native.exit_code, "nativeSignal": result.native.signal,
            "stdout": if result.native.stdout == READY { "terminalx-startup-ready" } else { "[omitted]" },
            "stderr": "[omitted]", "stdoutTruncated": result.native.stdout_truncated, "stderrTruncated": result.native.stderr_truncated })) })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn late_failure_retains_exact_exit_and_both_streams() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 0.05; printf '{\"fixture\":true}'; printf fixture-stderr >&2; exit 23"]);
        let recorded = std::thread::spawn(move || capture(command));
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert!(!recorded.is_finished(), "a short observation cannot be a pass");
        let recorded = recorded.join().unwrap();
        assert_eq!(recorded.exit_code, Some(23));
        assert_eq!(recorded.stdout, "{\"fixture\":true}");
        assert_eq!(recorded.stderr, "fixture-stderr");
    }

    #[test]
    fn output_is_bounded_but_fully_drained() {
        let (kept, truncated) = drain(&vec![b'x'; 100_000][..]);
        assert_eq!(kept.len(), OUTPUT_LIMIT as usize);
        assert!(truncated);
    }

    #[test]
    fn interrupted_output_is_retried_and_unread_output_is_marked_incomplete() {
        struct Interrupted(bool);
        impl Read for Interrupted {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                if !self.0 {
                    self.0 = true;
                    return Err(std::io::ErrorKind::Interrupted.into());
                }
                READY.as_bytes().read(bytes)
            }
        }
        // A finite interrupted stream must preserve its eventual exact bytes.
        let (output, truncated) = drain(Interrupted(false).take(READY.len() as u64));
        assert_eq!(output, READY);
        assert!(!truncated);
        struct Failed;
        impl Read for Failed {
            fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::Other.into())
            }
        }
        let (output, truncated) = drain(READY.as_bytes().chain(Failed));
        assert_eq!(output, READY);
        assert!(truncated, "a read failure cannot prove the complete readiness stream");
    }
}
